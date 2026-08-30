import { readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { runStageCommand } from "../process-runner.js";
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
    const destName = path.basename(input.destPath);
    const outTemplate = path.join(dir, `${stem}.%(ext)s`);

    // 防旧产物"复活":先删掉上一轮遗留的 destPath,否则本轮下载失败时会把旧文件
    // 当成本次成功返回;mtime 校验的起点也取此刻(允许 5s 文件系统时钟误差)。
    const startedAtMs = Date.now();
    await unlink(input.destPath).catch(() => undefined);

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
        // 环境级错误(python 起不来 / 找不到二进制):换 client、换重试都无意义,
        // 立刻失败并给人话提示,避免 9 连发同款垃圾日志。
        if (isEnvironmentSpawnFailure(message)) {
          throw new Error(
            `下载器启动失败(本机环境问题,与 YouTube 无关,重启 worker/服务可恢复): ${trimFailureMessage(message)}`
          );
        }
        failures.push(message);
      }
    }
    if (failures.length > 0) {
      // 各 client 报错经常一字不差,去重后只留尾部分量,避免 failure_reason 巨长难读
      const unique = [...new Set(failures.map((message) => trimFailureMessage(message)))];
      throw new Error(
        `yt-dlp download failed (tried ${this.downloadClientArgsList.length} client(s)): ${unique.join(" || ")}`.slice(0, 500)
      );
    }

    // yt-dlp 按 %(ext)s 输出(实际可能是 .mp4 / .webm),只认媒体扩展名白名单里的完整产物
    // (排除 .part / .ytdl / .tmp 半截文件与 .f137.mp4 之类的分段流残留),按扩展名优先级
    // + 最大体积挑一个改名为 destPath,这样下游 index handler 仍能用约定路径 <stem>.mkv 读到。
    const produced = (await readdir(dir)).filter((name) => name.startsWith(`${stem}.`));
    const ranked = produced
      .map((name) => ({ name, rank: downloadArtifactRank(name) }))
      .filter((entry): entry is { name: string; rank: number } => entry.rank !== null);

    let pickedName: string | null = null;
    if (ranked.length > 0) {
      const bestRank = ranked.reduce((min, entry) => Math.min(min, entry.rank), Number.POSITIVE_INFINITY);
      let pickedSize = -1;
      for (const entry of ranked) {
        if (entry.rank !== bestRank) {
          continue;
        }
        const size = (await stat(path.join(dir, entry.name)).catch(() => null))?.size ?? -1;
        if (size > pickedSize) {
          pickedSize = size;
          pickedName = entry.name;
        }
      }
      this.log("yt-dlp produced files", {
        files: produced,
        picked: pickedName,
        sizeBytes: pickedSize
      });
    } else {
      this.log("yt-dlp produced no media files", { dest: input.destPath, files: produced });
    }

    // 清理本次下载残留的半截/分段文件(best-effort),避免目录越积越乱、也防止下轮误判
    for (const name of produced) {
      if (name === pickedName || name === destName) {
        continue;
      }
      await unlink(path.join(dir, name)).catch((error: unknown) => {
        this.log("yt-dlp residue cleanup failed", {
          file: name,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }

    if (pickedName !== null && pickedName !== destName) {
      const pickedPath = path.join(dir, pickedName);
      try {
        await rename(pickedPath, input.destPath);
      } catch (error) {
        // 不静默吞:记日志后交给最终的 mtime 校验判定成败,避免把旧 dest 当本次成功
        this.log("yt-dlp rename produced file failed", {
          from: pickedPath,
          to: input.destPath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // 最终校验:destPath 必须存在且 mtime 是本次下载开始之后更新的(留 5s 时钟误差),
    // 否则视为下载失败抛错,由 download handler 按失败重试/标记失败处理。
    const stats = await stat(input.destPath).catch(() => null);
    if (!stats || stats.mtimeMs < startedAtMs - 5000) {
      throw new Error(
        `yt-dlp download produced no fresh file at ${input.destPath} (missing=${!stats}, staleMtime=${stats ? Math.round(stats.mtimeMs) : "n/a"}, startedAt=${startedAtMs})`
      );
    }
    return {
      filePath: input.destPath,
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs
    };
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

// 0xC0000142(3221225794)= DLL/会话初始化失败,ENOENT/EINVAL = 二进制无法执行。
// 这类错误换 YouTube client 无济于事,是宿主环境(常见:僵尸进程耗尽会话资源)问题。
export function isEnvironmentSpawnFailure(message: string): boolean {
  return /exit=322122579[04]|0xC000014[02]|spawn .* ENOENT|EINVAL/iu.test(message);
}

// execFile 的报错头是整条命令行,对用户没用;保留 stderr/退出码等有信息量的尾部。
export function trimFailureMessage(message: string): string {
  const keyDetail = message.match(/(exit=\d+.*|killed\(timeout=\d+ms\)).*$/su);
  const detail = keyDetail?.[1] ?? message;
  return detail.trim().slice(0, 300);
}

// 产物扩展名白名单及优先级:数值越小越优先。mkv 是下游混流约定格式优先拿,
// mp4/webm 是 yt-dlp 常见直出格式,m4a 仅在只有纯音频时兜底。
const MEDIA_EXTENSION_RANK: Readonly<Record<string, number>> = {
  mkv: 0,
  mp4: 1,
  webm: 2,
  m4a: 3
};

// 判断 yt-dlp 产物文件名是否是"完整的可交付媒体文件":
// - 排除 .part / .ytdl / .tmp 等下载中断残留(yt-dlp 断点续传的半截文件);
// - 排除 .f137.mp4 / .f139.m4a 这类分离流分段残留(格式 ID 后缀);
// - 扩展名必须在媒体白名单内。
// 返回扩展名优先级(越小越优先),不是可交付产物时返回 null。
function downloadArtifactRank(name: string): number | null {
  const lower = name.toLowerCase();
  if (lower.includes(".part") || lower.includes(".ytdl") || lower.includes(".tmp")) {
    return null;
  }
  if (/\.f\d+\.[a-z0-9]+$/u.test(lower)) {
    return null;
  }
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  const rank = MEDIA_EXTENSION_RANK[ext];
  return rank === undefined ? null : rank;
}

// 从同目录的产物文件名列表里挑出应交付的媒体文件:
// 按扩展名优先级(mkv>mp4>webm>m4a)取最优,同优先级时保持输入顺序先到先得
// (I/O 层的同优先级体积 tie-break 由 provider.download 补充)。
// 全都不是可交付媒体时返回 null。
export function pickDownloadArtifact(names: readonly string[]): string | null {
  let best: { name: string; rank: number } | null = null;
  for (const name of names) {
    const rank = downloadArtifactRank(name);
    if (rank === null) {
      continue;
    }
    if (best === null || rank < best.rank) {
      best = { name, rank };
    }
  }
  return best?.name ?? null;
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

// 默认执行入口:走共享进程 runner(process-runner 的 runStageCommand,spawn 直启,
// 不经 shell)。Requires bin to be a real executable, not a .bat shim. On Windows
// configure YT_DLP_BIN=<python.exe> + YT_DLP_ARGS="-m yt_dlp" (mirrors the reference
// project) so spawn targets a real binary and argument tokens — including yt-dlp's
// %(ext)s template — reach yt-dlp verbatim. 子进程登记 activeChildPids、超时/输出超限
// (20MB, 对应 execFile 时代的 maxBuffer)整棵进程树击杀、windowsHide 隐藏控制台。
// 失败报错语义与 execFile 时代一致("Command failed: <cmd>" + exit=... /
// killed(timeout=...) + stdout/stderr 尾部), trimFailureMessage 与
// isEnvironmentSpawnFailure 按这些模式识别, 不经本函数二次包装。
function runExec(bin: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return runStageCommand(bin, args, timeoutMs).then((result) => result.stdout);
}
