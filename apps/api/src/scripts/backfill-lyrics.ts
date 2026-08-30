// 回填在线补歌的同步歌词:对 _online 目录里 lyric_file 为空的歌曲,按文件名
// "歌手-歌名-语种-分类" 解析出歌手/歌名,查 LRCLIB,把 synced LRC 写到 mkv 旁
// 并 UPDATE ktv_songs.lyric_file。尽力而为:单首失败不影响其他。
// --with-karaoke:对 karaoke_lyrics_file 为空的歌,用最优可用音源跑
// Qwen3-ForcedAligner 生成逐字时间轴(需要 ALIGNER_BIN)。音源优先级:
// 1) mkv 旁的 <stem>.vocals.m4a sidecar(index 阶段留的人声,质量与速度兼得);
// 2) KTV_BACKFILL_USE_DEMUCS=1 且 DEMUCS_BIN 可用时重新 demucs 分离(质量最好
//    但每首要多花分钟级);
// 3) 库内 mkv 直接对齐(ffmpeg 转 16k mono,混音对齐质量最低,且可能被质量
//    门禁拒绝后走 lrc 兜底)。
// 用法: DATABASE_URL=... tsx src/scripts/backfill-lyrics.ts [--dry-run] [--with-karaoke] [--only-karaoke]
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { artistTrackFromStem, fetchBestLrclibWithVariants } from "../modules/online-supplement/lrclib-client.js";
import { alignerLanguageForSpecName } from "../modules/online-supplement/handlers/align-handler.js";
import { VOCALS_SIDECAR_SUFFIX } from "../modules/online-supplement/handlers/index-handler.js";

const execFileAsync = promisify(execFile);
const LRCLIB_BASE_URL = process.env.LYRICS_LRCLIB_BASE_URL?.trim() || "https://lrclib.net";
const DEMUCS_BIN = process.env.DEMUCS_BIN?.trim() || "demucs";
const DEMUCS_ARGS = process.env.DEMUCS_ARGS?.trim();
const DEMUCS_MODEL = process.env.DEMUCS_MODEL?.trim() || "htdemucs";
const DEMUCS_DEVICE = process.env.DEMUCS_DEVICE?.trim() || "cpu";
const ALIGNER_BIN = process.env.ALIGNER_BIN?.trim() || "";
const ALIGNER_SCRIPT = process.env.ALIGNER_SCRIPT?.trim() || "python/align_lyrics.py";
const ALIGNER_MODEL = process.env.ALIGNER_MODEL?.trim() || "Qwen/Qwen3-ForcedAligner-0.6B";
const ALIGNER_DEVICE = process.env.ALIGNER_DEVICE?.trim() || "cuda:0";
const ALIGNER_DTYPE = process.env.ALIGNER_DTYPE?.trim() || "bfloat16";

interface BackfillRow {
  id: string;
  file_path: string;
  title: string;
  lyric_file: string | null;
  karaoke_lyrics_file: string | null;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const withKaraoke = process.argv.includes("--with-karaoke");
  const onlyKaraoke = process.argv.includes("--only-karaoke");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query<BackfillRow>(
      // 锚定 _online 是路径段(后跟分隔符),避免误伤路径中恰好含 "_online"
      // 子串的 NAS 歌曲(如 "老歌_online备份\x.mkv" 或 "x_online_final.mkv")
      `SELECT id, file_path, title, lyric_file, karaoke_lyrics_file FROM ktv_songs
       WHERE (file_path LIKE '%\\_online\\\\%' ESCAPE '\\'
              OR file_path LIKE '%\\_online/%' ESCAPE '\\')
         AND missing_at IS NULL`
    );
    console.log(`[backfill-lyrics] ${rows.length} online song(s)`);

    if (!onlyKaraoke) {
      await backfillLrc(pool, rows, dryRun);
    }
    if (withKaraoke || onlyKaraoke) {
      await backfillKaraoke(pool, rows, dryRun);
    }
  } finally {
    await pool.end();
  }
}

async function backfillLrc(pool: Pool, rows: readonly BackfillRow[], dryRun: boolean): Promise<void> {
  const pending = rows.filter((row) => !row.lyric_file);
  console.log(`[backfill-lyrics] ${pending.length} song(s) without lrc`);
  let filled = 0;
  for (const row of pending) {
    const stem = path.basename(row.file_path, path.extname(row.file_path));
    const names = artistTrackFromStem(stem);
    if (!names) {
      console.log(`[backfill-lyrics] skip (unparsable stem): ${row.file_path}`);
      continue;
    }

    // 先原文(繁体)再简体变体,全部变体都因网络错误失败才算查询失败(与流水线一致)
    const matched = await fetchBestLrclibWithVariants({
      artistName: names.artistName,
      trackName: names.trackName,
      baseUrl: LRCLIB_BASE_URL
    }).catch((error: unknown) => {
      console.log(
        `[backfill-lyrics] lrclib error for ${names.artistName} - ${names.trackName}: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    });
    const synced = matched?.record.syncedLyrics?.trim();
    if (!synced) {
      console.log(`[backfill-lyrics] not found: ${names.artistName} - ${names.trackName}`);
      continue;
    }

    const lyricPath = path.join(path.dirname(row.file_path), `${stem}.lrc`);
    if (dryRun) {
      console.log(`[backfill-lyrics] (dry-run) would write ${lyricPath}`);
      continue;
    }

    await writeFile(lyricPath, `${synced}\n`, "utf8");
    await pool.query(
      `UPDATE ktv_songs SET lyric_file = $1, updated_at = now() WHERE id = $2`,
      [lyricPath, row.id]
    );
    filled += 1;
    console.log(
      `[backfill-lyrics] filled: ${names.artistName} - ${names.trackName} (matched "${matched?.record.artistName}" - "${matched?.record.trackName}")`
    );
  }
  console.log(`[backfill-lyrics] lrc done: ${filled}/${pending.length} filled`);
}

async function backfillKaraoke(pool: Pool, rows: readonly BackfillRow[], dryRun: boolean): Promise<void> {
  const pending = rows.filter((row) => !row.karaoke_lyrics_file && row.lyric_file);
  if (!ALIGNER_BIN) {
    console.log(`[backfill-lyrics] karaoke skipped: ALIGNER_BIN not configured`);
    return;
  }
  console.log(
    `[backfill-lyrics] karaoke audio source priority: <stem>${VOCALS_SIDECAR_SUFFIX} sidecar -> ${
      USE_DEMUCS ? "demucs vocals (slow, best quality)" : "library mkv (direct)"
    }`
  );
  console.log(`[backfill-lyrics] ${pending.length} song(s) without karaoke timing`);
  let filled = 0;
  for (const row of pending) {
    const stem = path.basename(row.file_path, path.extname(row.file_path));
    const karaokePath = path.join(path.dirname(row.file_path), `${stem}.karaoke.json`);
    if (dryRun) {
      console.log(`[backfill-lyrics] (dry-run) would align ${stem}`);
      continue;
    }

    try {
      await alignLibraryMkv(row, karaokePath, stem);
      await pool.query(
        `UPDATE ktv_songs SET karaoke_lyrics_file = $1, updated_at = now() WHERE id = $2`,
        [karaokePath, row.id]
      );
      filled += 1;
      console.log(`[backfill-lyrics] karaoke filled: ${stem}`);
    } catch (error) {
      // align_lyrics.py 质量门禁不达标时 exit 4 且不写输出:与普通失败一样跳过
      // 该歌(lrc 兜底),但消息注明 quality-gate 便于排查
      const detail = error instanceof Error ? error.message : String(error);
      const qualityGate = isKaraokeQualityGateFailure(error);
      console.log(
        `[backfill-lyrics] karaoke ${qualityGate ? "quality-gate rejected" : "failed"} for ${stem}: ${detail.slice(0, 400)}`
      );
    }
  }
  console.log(`[backfill-lyrics] karaoke done: ${filled}/${pending.length} filled`);
}

// 库内产物没有 vocals stem(index 后已清理,但会留 <stem>.vocals.m4a sidecar)。
// 音源优先级:sidecar 人声(index 阶段压缩留存)→ KTV_BACKFILL_USE_DEMUCS=1 且
// DEMUCS_BIN 可用时重新分离(最慢最好)→ 库内 mkv 直读(混音,最差)。
const USE_DEMUCS = process.env.KTV_BACKFILL_USE_DEMUCS === "1";

async function alignLibraryMkv(row: BackfillRow, karaokePath: string, stem: string): Promise<void> {
  const vocalsSidecar = path.join(path.dirname(row.file_path), `${stem}${VOCALS_SIDECAR_SUFFIX}`);
  if ((await stat(vocalsSidecar).catch(() => null)) != null) {
    console.log(`[backfill-lyrics] using vocals sidecar for ${stem}: ${vocalsSidecar}`);
    await runAligner(vocalsSidecar, row.lyric_file as string, karaokePath, stem);
    await ensureKaraokeOutput(karaokePath);
    return;
  }

  if (!USE_DEMUCS) {
    await runAligner(row.file_path, row.lyric_file as string, karaokePath, stem);
    await ensureKaraokeOutput(karaokePath);
    return;
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), "ktv-backfill-"));
  try {
    const vocals = await separateVocals(workDir, row.file_path, stem);
    await runAligner(vocals, row.lyric_file as string, karaokePath, stem);
    await ensureKaraokeOutput(karaokePath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isKaraokeQualityGateFailure(error: unknown): boolean {
  // execFile 失败时 error.code = 子进程退出码;align_lyrics.py 质量门禁 = exit 4
  // (stderr 里也会带 "alignment quality-gate failed: ..." 报告,双保险识别)
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /quality[-_ ]?gate/u.test(message);
}

async function runAligner(
  audio: string,
  lyricsFile: string,
  karaokePath: string,
  stem: string
): Promise<void> {
  await execFileAsync(
    ALIGNER_BIN,
    [
      path.resolve(process.cwd(), ALIGNER_SCRIPT),
      "--audio",
      audio,
      "--lyrics",
      lyricsFile,
      "--out",
      karaokePath,
      "--language",
      alignerLanguageForSpecName(stem),
      "--model",
      ALIGNER_MODEL,
      "--device",
      ALIGNER_DEVICE,
      "--dtype",
      ALIGNER_DTYPE
    ],
    { timeout: 20 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 }
  );
}

async function ensureKaraokeOutput(karaokePath: string): Promise<void> {
  if (!(await stat(karaokePath).catch(() => null))) {
    throw new Error("aligner produced no output");
  }
}

async function separateVocals(workDir: string, sourceMkv: string, stem: string): Promise<string> {
  const demucsPrefix = DEMUCS_ARGS ? DEMUCS_ARGS.split(/\s+/u).filter(Boolean) : [];
  await execFileAsync(
    DEMUCS_BIN,
    [
      ...demucsPrefix,
      "--two-stems",
      "vocals",
      "-n",
      DEMUCS_MODEL,
      "-d",
      DEMUCS_DEVICE,
      "-o",
      workDir,
      sourceMkv
    ],
    { timeout: 20 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 }
  );
  const vocals = path.join(workDir, DEMUCS_MODEL, stem, "vocals.wav");
  if (!(await stat(vocals).catch(() => null))) {
    throw new Error(`demucs produced no vocals at ${vocals}`);
  }
  return vocals;
}

// LRCLIB 变体查询(原文→简体)统一走 lrclib-client 的 fetchBestLrclibWithVariants,
// 与流水线 lyrics 阶段、regenerate-lyrics 路由共享同一份命中逻辑。

const entrypointUrl = pathToFileURL(process.argv[1] ?? "").href;
if (import.meta.url === entrypointUrl) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
