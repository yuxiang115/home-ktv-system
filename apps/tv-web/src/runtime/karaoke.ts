// 逐字 karaoke 时间轴(align 阶段 / Qwen3-ForcedAligner 产出的 JSON)。
// 格式:{"lines":[{"start":62.31,"end":66.82,"text":"...","words":[{"text":"我","start":62.31,"end":62.58}]}]}
export interface KaraokeWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface KaraokeLine {
  startMs: number;
  endMs: number;
  text: string;
  words: readonly KaraokeWord[];
}

export function parseKaraokeLyrics(json: string): KaraokeLine[] | null {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }

  const rawLines = (payload as { lines?: unknown })?.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    return null;
  }

  const lines: KaraokeLine[] = [];
  for (const rawLine of rawLines) {
    if (!rawLine || typeof rawLine !== "object") {
      continue;
    }
    const record = rawLine as { start?: unknown; end?: unknown; text?: unknown; words?: unknown };
    const startMs = secondsToMs(record.start);
    const endMs = secondsToMs(record.end);
    const text = typeof record.text === "string" ? record.text : "";
    if (startMs === null || endMs === null) {
      continue;
    }

    const words: KaraokeWord[] = [];
    if (Array.isArray(record.words)) {
      for (const rawWord of record.words) {
        if (!rawWord || typeof rawWord !== "object") {
          continue;
        }
        const word = rawWord as { text?: unknown; start?: unknown; end?: unknown };
        const wordStartMs = secondsToMs(word.start);
        const wordEndMs = secondsToMs(word.end);
        if (typeof word.text !== "string" || wordStartMs === null || wordEndMs === null) {
          continue;
        }
        words.push({ text: word.text, startMs: wordStartMs, endMs: wordEndMs });
      }
    }

    lines.push({ startMs, endMs, text, words });
  }

  if (lines.length === 0) {
    return null;
  }
  return lines.sort((left, right) => left.startMs - right.startMs);
}

// 当前行:最后一个 startMs <= positionMs 的下标(与 LRC 的 activeLyricIndex 语义一致)。
export function activeKaraokeLineIndex(lines: readonly KaraokeLine[], positionMs: number): number {
  let result = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index]?.startMs ?? Number.POSITIVE_INFINITY) <= positionMs) {
      result = index;
    } else {
      break;
    }
  }
  return result;
}

function secondsToMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value * 1000);
}
