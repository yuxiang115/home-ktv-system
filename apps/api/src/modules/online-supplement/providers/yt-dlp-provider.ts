import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, rename, stat } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
import type {
  DownloadAssetResult,
  OnlineDownloadInput,
  OnlineProvider,
  OnlineSearchCandidate,
  OnlineSearchInput
} from "../online-provider.js";

export type YtDlpProviderLog = (message: string, meta?: Record<string, unknown>) => void;

export interface YtDlpProviderOptions {
  bin?: string;
  /** 启动器参数(YT_DLP_ARGS,如 "-m yt_dlp" 配合 python.exe);不是 yt-dlp 自身参数 */
  binArgs?: string;
  /** YouTube player client,默认 android(web/android vr 客户端对版权 MV 常返回 403);置空字符串禁用 */
  playerClient?: string;
  cookie?: string;
  cookiesFromBrowser?: string;
  timeoutMs?: number;
  run?: (bin: string, args: readonly string[], timeoutMs: number) => Promise<string>;
  log?: YtDlpProviderLog;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PLAYER_CLIENT = "android";

export class YtDlpProvider implements OnlineProvider {
  readonly providerId = "youtube-yt-dlp";
  private readonly bin: string;
  private readonly binPrefix: readonly string[];
  private readonly playerClientArgs: readonly string[];
  /** 下载失败时依次轮换的 extractor-args 组合;最后一组为空(= yt-dlp 默认客户端) */
  private readonly downloadClientArgsList: readonly (readonly string[])[];
  private readonly cookie: string | undefined;
  private readonly cookiesFromBrowser: string | undefined;
  private readonly timeoutMs: number;
  private readonly run: (bin: string, args: readonly string[], timeoutMs: number) => Promise<string>;
  private readonly log: YtDlpProviderLog;

  constructor(options: YtDlpProviderOptions = {}) {
    this.bin = options.bin ?? "yt-dlp";
    this.binPrefix = options.binArgs?.trim()
      ? options.binArgs.split(/\s+/u).filter(Boolean)
      : [];
    const playerClient = options.playerClient?.trim() ?? DEFAULT_PLAYER_CLIENT;
    this.playerClientArgs = playerClient
      ? ["--extractor-args", `youtube:player_client=${playerClient}`]
      : [];
    this.downloadClientArgsList = buildDownloadClientArgsList(playerClient);
    this.cookie = options.cookie?.trim() || undefined;
    this.cookiesFromBrowser = options.cookiesFromBrowser?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.run = options.run ?? runExec;
    this.log = options.log ?? (() => undefined);
  }

  async search(input: OnlineSearchInput): Promise<OnlineSearchCandidate[]> {
    const limit = Math.min(20, Math.max(1, input.limit));
    const query = input.query.trim();
    if (!query) {
      return [];
    }

    const args = [
      `ytsearch${limit}:${query}`,
      "--flat-playlist",
      "-J",
      "--no-warnings",
      "--skip-download",
      ...this.playerClientArgs
    ];

    let stdout: string;
    try {
      stdout = await this.run(this.bin, [...this.binPrefix, ...args], this.timeoutMs);
    } catch (error) {
      throw new Error(
        `yt-dlp search failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let data: YtDlpPlaylistJson;
    try {
      data = JSON.parse(stdout) as YtDlpPlaylistJson;
    } catch {
      return [];
    }

    const entries = data.entries ?? [];
    return entries
      .map(parseEntry)
      .filter((candidate): candidate is OnlineSearchCandidate => candidate !== null);
  }

  async download(input: OnlineDownloadInput): Promise<DownloadAssetResult> {
    // 关键:用 muxed 单文件流 (best[acodec!=none]),不用 bestvideo+bestaudio 分离流。
    // YouTube 对分离的 adaptive 流下载会返回 403;muxed progressive 流不会。
    const dir = path.dirname(input.destPath);
    const ext = path.extname(input.destPath);
    const stem = path.basename(input.destPath, ext);
    const outTemplate = path.join(dir, `${stem}.%(ext)s`);

    // YouTube 的 SABR-only / 403 按 session 概率触发,同一个 client 重试大概率还是撞墙;
    // 失败时轮换客户端(android → tv_embedded → 默认)再试,任一成功即可。
    const failures: string[] = [];
    for (const clientArgs of this.downloadClientArgsList) {
      const clientLabel = clientArgs[1]?.replace("youtube:player_client=", "") ?? "default";
      const args = [
        "-o",
        outTemplate,
        "-f",
        "best[acodec!=none]/best",
        "--no-warnings",
        "--no-playlist",
        ...clientArgs,
        ...(this.cookiesFromBrowser
          ? ["--cookies-from-browser", this.cookiesFromBrowser]
          : this.cookie
            ? ["--add-header", `Cookie:${this.cookie}`]
            : []),
        input.candidate.sourceUrl
      ];

      this.log("yt-dlp download attempt", {
        client: clientLabel,
        url: input.candidate.sourceUrl,
        dest: input.destPath
      });
      try {
        await this.run(this.bin, [...this.binPrefix, ...args], DEFAULT_DOWNLOAD_TIMEOUT_MS);
        this.log("yt-dlp download attempt ok", { client: clientLabel });
        failures.length = 0;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log("yt-dlp download attempt failed", { client: clientLabel, error: message });
        failures.push(message);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `yt-dlp download failed (tried ${this.downloadClientArgsList.length} client(s)): ${failures.join(" || ")}`.slice(0, 1200)
      );
    }

    // yt-dlp 按 %(ext)s 输出(实际可能是 .mp4 / .webm),找到实际文件改名为 destPath,
    // 这样下游 index handler 仍能用约定路径 <stem>.mkv 读到。
    const produced = (await readdir(dir))
      .filter((name) => name.startsWith(`${stem}.`) && name !== `${stem}${ext}`)
      .map((name) => path.join(dir, name));
    if (produced.length > 0) {
      let picked = produced[0]!;
      let pickedSize = -1;
      for (const candidate of produced) {
        const size = (await stat(candidate).catch(() => null))?.size ?? -1;
        if (size > pickedSize) {
          pickedSize = size;
          picked = candidate;
        }
      }
      this.log("yt-dlp produced files", {
        files: produced.map((file) => path.basename(file)),
        picked: path.basename(picked),
        sizeBytes: pickedSize
      });
      if (picked !== input.destPath) {
        await rename(picked, input.destPath).catch(() => undefined);
      }
    } else {
      this.log("yt-dlp produced no files", { dest: input.destPath });
    }

    try {
      const stats = await stat(input.destPath);
      return {
        filePath: input.destPath,
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs
      };
    } catch {
      return { filePath: input.destPath, sizeBytes: null, mtimeMs: null };
    }
  }
}

interface YtDlpPlaylistJson {
  entries?: YtDlpEntry[];
}

interface YtDlpEntry {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  webpage_url?: unknown;
  uploader?: unknown;
  channel?: unknown;
  duration?: unknown;
  thumbnail?: unknown;
  thumbnails?: unknown;
}

function parseEntry(entry: YtDlpEntry): OnlineSearchCandidate | null {
  const id = typeof entry.id === "string" ? entry.id : null;
  const title = typeof entry.title === "string" ? entry.title : null;
  const sourceUrl =
    pickString(entry.webpage_url) ??
    pickString(entry.url) ??
    (id ? `https://www.youtube.com/watch?v=${id}` : null);
  if (!id || !title || !sourceUrl) {
    return null;
  }

  const durationSeconds = typeof entry.duration === "number" ? entry.duration : null;
  const thumbnail = pickString(entry.thumbnail) ?? firstThumbnailUrl(entry.thumbnails);

  return {
    provider: "youtube-yt-dlp",
    providerCandidateId: id,
    sourceUrl,
    title,
    artistName: pickString(entry.uploader) ?? pickString(entry.channel) ?? "",
    durationMs: durationSeconds !== null ? Math.round(durationSeconds * 1000) : null,
    providerPayload: thumbnail ? { thumbnail } : {}
  };
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// 下载客户端轮换序列:首选客户端 → tv_embedded(实测可下版权 MV)→ 空(默认行为)。
// 空串表示不加 extractor-args,让 yt-dlp 用自己的默认客户端组合兜底。
function buildDownloadClientArgsList(primary: string): (readonly string[])[] {
  const clients = [primary, "tv_embedded", ""].filter(
    (client, index, all) => all.indexOf(client) === index
  );
  return clients.map((client) =>
    client ? (["--extractor-args", `youtube:player_client=${client}`] as const) : ([] as const)
  );
}

function firstThumbnailUrl(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const entry of value) {
    const url = pickString((entry as { url?: unknown })?.url);
    if (url) {
      return url;
    }
  }
  return null;
}

// Runs yt-dlp via execFile (shell:false). Requires bin to be a real executable, not a
// .bat shim. On Windows configure YT_DLP_BIN=<python.exe> + YT_DLP_ARGS="-m yt_dlp"
// (mirrors the reference project) so execFile targets a real binary and argument
// tokens — including yt-dlp's %(ext)s template — reach yt-dlp verbatim.
// 失败时附带退出码与 stdout/stderr 尾部:yt-dlp 的真实报错(403 / SABR / DRM / 网络)
// 可能在任一流里,只报 "Command failed" 没法排查。
function runExec(bin: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return execFileAsync(bin, args as string[], {
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
    encoding: "utf8"
  }).then(
    (result) => result.stdout,
    (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean }) => {
      const details = [
        typeof error.code === "number" ? `exit=${error.code}` : null,
        error.killed ? `killed(timeout=${timeoutMs}ms)` : null,
        tailLines(error.stderr, 4),
        tailLines(error.stdout, 4)
      ]
        .filter(Boolean)
        .join(" | ");
      throw new Error(`${error.message}${details ? `: ${details}` : ""}`);
    }
  );
}

function tailLines(value: string | undefined, maxLines: number): string | null {
  const joined = (value ?? "").trim().split(/\r?\n/u).filter(Boolean).slice(-maxLines).join(" / ");
  return joined ? joined.slice(0, 400) : null;
}
