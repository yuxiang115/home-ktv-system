import { VARIETY_SHOW_NAMES } from "./variety-show-metadata.js";

export interface SongTitleCleanupInput {
  title: string;
}

export interface SongTitleCleanupResult {
  title: string;
  changed: boolean;
  reasons: string[];
}

const DISPLAY_MARKER_PATTERN = /\s*(?:[\[【][^\]【】]*(?:720|1080|高清|HD|P|现场)[^\]【】]*[\]】]|[\(（][^()（）]*(?:720|1080|高清|HD|P|演唱会|综艺|现场|Live|MTV|蒙面歌王|我是歌手|音乐缘计划)[^()（）]*[\)）])\s*$/iu;
const VERSION_MARKER_PATTERN = /\s*[\(（][^()（）]*(?:粤语版|国语版|DJ[^()（）]*版|现场版|烟嗓版|ai修复版|DJ)[^()（）]*[\)）]\s*$/iu;
const CHINESE_SUBTITLE_PATTERN = /\s*[\(（][\p{Script=Han}\s，、。！？!?]+[\)）]\s*$/u;
const TRAILING_BRACKET_DETAIL_PATTERN = /^(.{2,}?)\s*[\(（\[【〖].*$/u;
const TRAILING_DISPLAY_WORD_PATTERN = /(?:\s*[-－—–]\s*(?:演唱会|现场|Live|MTV)|\s+(?:Live|MTV))\s*$/iu;
const TRAILING_CATEGORY_PATTERN = /(流行|怀旧|合唱|戏曲|歌曲|dj)$/iu;
const EXACT_TITLE_FIXES = new Map<string, string>([
  ["如果这就是爱情", "这就是爱情"]
]);

export function cleanSongTitle(input: SongTitleCleanupInput): SongTitleCleanupResult {
  const original = input.title.trim();
  let title = original;
  const reasons = new Set<string>();

  while (true) {
    const previous = title;
    const exactTitle = EXACT_TITLE_FIXES.get(title);
    if (exactTitle) {
      title = exactTitle;
      reasons.add("exact-title");
      continue;
    }

    title = title.replace(DISPLAY_MARKER_PATTERN, "").trim();
    if (title !== previous) {
      reasons.add("display-marker");
      continue;
    }

    title = title.replace(VERSION_MARKER_PATTERN, "").trim();
    if (title !== previous) {
      reasons.add("version-marker");
      continue;
    }

    title = title.replace(CHINESE_SUBTITLE_PATTERN, "").trim();
    if (title !== previous) {
      reasons.add("subtitle-marker");
      continue;
    }

    const bracketStripped = stripTrailingBracketDetail(title);
    if (bracketStripped !== title) {
      title = bracketStripped;
      reasons.add("bracket-detail");
      continue;
    }

    const varietyShowStripped = stripTrailingVarietyShowTitle(title);
    if (varietyShowStripped !== title) {
      title = varietyShowStripped;
      reasons.add("variety-show-suffix");
      continue;
    }

    title = title.replace(TRAILING_DISPLAY_WORD_PATTERN, "").trim();
    if (title !== previous) {
      reasons.add("display-word");
      continue;
    }

    const categoryStripped = stripTrailingCategory(title);
    if (categoryStripped !== title) {
      title = categoryStripped;
      reasons.add("category-suffix");
      continue;
    }

    break;
  }

  return {
    title: title || original,
    changed: title !== original && Boolean(title),
    reasons: Array.from(reasons)
  };
}

function stripTrailingBracketDetail(value: string): string {
  const match = value.match(TRAILING_BRACKET_DETAIL_PATTERN);
  const prefix = match?.[1]?.trim();
  if (!prefix || prefix.length < 2) {
    return value;
  }

  return prefix;
}

function stripTrailingVarietyShowTitle(value: string): string {
  for (const showName of VARIETY_SHOW_NAMES) {
    const suffixPattern = new RegExp(
      `${escapeRegExp(showName)}(?:\\d+|第.+季|[一二三四五六七八九十]+强|\\d+强)?$`,
      "u"
    );
    const stripped = value.replace(suffixPattern, "").trim();
    if (stripped !== value && stripped.length >= 2) {
      return stripped;
    }
  }
  return value;
}

function stripTrailingCategory(value: string): string {
  const match = value.match(TRAILING_CATEGORY_PATTERN);
  if (!match?.[0]) {
    return value;
  }

  const prefix = value.slice(0, -match[0].length).trim();
  if (prefix.length < 2) {
    return value;
  }
  if (/[-－—–\s]$/u.test(prefix)) {
    return prefix.replace(/[-－—–\s]+$/u, "").trim();
  }
  if (/[)）\]】]$/u.test(prefix)) {
    return prefix;
  }

  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
