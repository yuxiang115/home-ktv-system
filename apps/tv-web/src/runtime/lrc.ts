export interface LrcLine {
  timeMs: number;
  text: string;
}

// LRC 行时间戳,如 [00:12.00] / [00:12:30](冒号毫秒)/ 一行多戳 [00:12.00][01:30.00]
const TIMESTAMP_PATTERN = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/gu;

export function parseLrc(content: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    TIMESTAMP_PATTERN.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = TIMESTAMP_PATTERN.exec(rawLine)) !== null) {
      const minutes = Number.parseInt(match[1] ?? "0", 10);
      const seconds = Number.parseInt(match[2] ?? "0", 10);
      const fractionRaw = match[3] ?? "0";
      // [12.5] => 500ms;[12.50] => 500ms;[12.500] => 500ms —— 按位数解释小数
      const fraction = Number.parseInt(fractionRaw, 10) * Math.pow(10, 3 - fractionRaw.length);
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
        continue;
      }
      stamps.push(minutes * 60_000 + seconds * 1_000 + fraction);
    }

    if (stamps.length === 0) {
      continue;
    }

    const text = rawLine.replace(TIMESTAMP_PATTERN, "").trim();
    if (!text) {
      continue;
    }
    for (const timeMs of stamps) {
      lines.push({ timeMs, text });
    }
  }

  return lines.sort((left, right) => left.timeMs - right.timeMs);
}

// 当前行:最后一个 timeMs <= positionMs 的下标;演唱前返回 -1。
export function activeLyricIndex(lines: readonly LrcLine[], positionMs: number): number {
  let result = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index]?.timeMs ?? Number.POSITIVE_INFINITY) <= positionMs) {
      result = index;
    } else {
      break;
    }
  }
  return result;
}

export interface LyricSpan {
  startMs: number;
  endMs: number;
}

// 末行没有下一行可借,给一个默认跨度让扫光能在歌尾自然完成
const DEFAULT_TAIL_SPAN_MS = 10_000;

// 行的时间跨度:startMs = 本行时间戳,endMs = 下一行时间戳。LRC 只有行级时间戳,
// 逐字扫光用行内线性插值(唱到比例 = 进度比例),这是 KTV 渲染 LRC 的通行近似。
export function lyricLineSpan(lines: readonly LrcLine[], index: number): LyricSpan | null {
  const line = lines[index];
  if (!line) {
    return null;
  }
  const next = lines[index + 1];
  const endMs = next ? next.timeMs : line.timeMs + DEFAULT_TAIL_SPAN_MS;
  return { startMs: line.timeMs, endMs };
}

// 行内演唱进度 0..1;startMs 前为 0,endMs 后为 1(间奏时整行已亮完,等下一句)。
// 零宽跨度(相邻行时间戳相同)视为已唱完。
export function lyricLineProgress(span: LyricSpan, positionMs: number): number {
  if (span.endMs <= span.startMs) {
    return positionMs >= span.startMs ? 1 : 0;
  }
  const clamped = Math.min(Math.max(positionMs - span.startMs, 0), span.endMs - span.startMs);
  return clamped / (span.endMs - span.startMs);
}
