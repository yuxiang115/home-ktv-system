export interface KtvSongVarietyMetadataRow {
  id: string;
  title: string;
  primaryArtistName: string;
  artistNames: readonly string[];
  relativePath: string;
}

export interface KtvSongVarietyMetadataCleanResult {
  id: string;
  title: string;
  primaryArtistName: string;
  artistNames: string[];
  changed: boolean;
}

export const VARIETY_SHOW_NAMES = [
  "中国梦之声",
  "天赐的声音",
  "歌手当打之年",
  "中国新说唱",
  "中歌会",
  "创造101",
  "无限歌谣季",
  "异口同声",
  "我是歌手",
  "这就是歌唱对唱季",
  "歌声的翅膀",
  "厉害了我的歌",
  "超级歌单",
  "声入人心",
  "中国最强音",
  "嗨！唱起来",
  "中国好声音",
  "中国好声音2",
  "最美和声",
  "我是唱作人",
  "蒙面歌王",
  "最优的我们",
  "金曲捞",
  "中国新歌声",
  "蒙面唱将猜猜猜",
  "不凡的改变",
  "梦想的声音",
  "明日之子",
  "中国好歌曲",
  "经典咏流传",
  "抖音神曲",
  "中国之星",
  "酷狗首唱会",
  "跨年演唱会",
  "盖世英雄",
  "中国新声代",
  "跨界歌王",
  "天籁之战",
  "歌手",
  "围炉音乐会",
  "我想和你唱"
] as const;

const varietyShowNameSet = new Set(VARIETY_SHOW_NAMES.map(normalizeVarietyShowName));

export function isVarietyShowName(value: string): boolean {
  return varietyShowNameSet.has(normalizeVarietyShowName(value));
}

export function stripVarietyShowTitleMarker(value: string): string {
  const markerPattern = /\s*(?:[\(（][^()（）]*[\)）]|\[[^\[\]]*\]|【[^【】]*】)\s*$/u;
  let stripped = value.trim();
  while (markerPattern.test(stripped)) {
    stripped = stripped.replace(markerPattern, "").trim();
  }
  return stripped;
}

export function cleanArtistNames(value: readonly string[], fallbackPrimaryArtistName = "Unknown Artist"): string[] {
  const cleaned = uniqueNonEmpty(value.filter((artistName) => !isVarietyShowName(artistName)));
  if (cleaned.length > 0) {
    return cleaned;
  }
  return isVarietyShowName(fallbackPrimaryArtistName) ? ["Unknown Artist"] : [fallbackPrimaryArtistName.trim() || "Unknown Artist"];
}

export function cleanKtvSongVarietyMetadata(row: KtvSongVarietyMetadataRow): KtvSongVarietyMetadataCleanResult {
  const title = isComprehensiveVarietyPath(row.relativePath) ? stripVarietyShowTitleMarker(row.title) : row.title.trim();
  const artistNames = cleanArtistNames(row.artistNames, row.primaryArtistName);
  const fallbackArtistName = row.primaryArtistName.trim() || artistNames[0] || "Unknown Artist";
  const primaryArtistName = isVarietyShowName(row.primaryArtistName)
    ? artistNames[0] ?? "Unknown Artist"
    : fallbackArtistName;

  return {
    id: row.id,
    title,
    primaryArtistName,
    artistNames,
    changed: title !== row.title
      || primaryArtistName !== row.primaryArtistName
      || !sameStringArray(artistNames, row.artistNames)
  };
}

export function isComprehensiveVarietyPath(relativePath: string): boolean {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  return normalizedPath.startsWith("综合专辑 9300首1.4T/综艺专区1（2900首）/")
    || normalizedPath.startsWith("综合专辑 9300首1.4T/综艺专区2（1000首）/");
}

export function normalizeVarietyShowName(value: string): string {
  return value
    .trim()
    .replace(/\s+/gu, "")
    .replace(/[\(（][^()（）]*[\)）]/gu, "");
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
