import path from "node:path";
import type { FilenameMetadataDraft } from "./real-mv-metadata.js";

export type KtvSampleParseStrategy = "filename" | "path" | "hybrid" | "fallback";

export interface KtvSampleMetadata {
  title: string;
  artistName: string;
  category: string | null;
  parseStrategy: KtvSampleParseStrategy;
  parseConfidence: number;
  parseNotes: string[];
}

export interface KtvSampleSourceFile {
  sourcePath: string;
  relativePath: string;
  sizeBytes: number | null;
  mtimeMs: number | null;
}

export interface KtvSampleRow extends KtvSampleSourceFile, KtvSampleMetadata {
  fileName: string;
  extension: string;
}

export interface KtvSampleReportInput {
  sourceRoot: string;
  sshHost?: string | null | undefined;
  databaseRunId?: string | null | undefined;
  totalFiles: number;
  sampleSize: number;
  rows: readonly KtvSampleRow[];
}

export function inferKtvSampleMetadata(relativePath: string): KtvSampleMetadata {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const segments = normalizedPath.split("/").filter(Boolean);
  const fileName = segments.at(-1) ?? normalizedPath;
  const fileStem = stripExtension(fileName);
  const folderSegments = segments.slice(0, -1);
  const filenameMetadata = parseKtvFilename(normalizedPath);
  const folderMetadata = inferFolderMetadata(folderSegments, fileStem);

  const titleSource = filenameMetadata.artistName && filenameMetadata.title ? "filename" : folderMetadata.title ? "path" : "fallback";
  const artistSource = filenameMetadata.artistName && filenameMetadata.title ? "filename" : folderMetadata.artistName ? "path" : "fallback";
  const categorySource = filenameMetadata.genre?.[0]
    ? "filename"
    : folderMetadata.category
      ? "path"
      : "fallback";

  const title = filenameMetadata.artistName && filenameMetadata.title
    ? filenameMetadata.title
    : folderMetadata.title ?? fileStem;
  const artistName = filenameMetadata.artistName && filenameMetadata.title
    ? filenameMetadata.artistName
    : folderMetadata.artistName ?? "Unknown Artist";
  const category = filenameMetadata.genre?.[0] ?? folderMetadata.category ?? null;

  return {
    title,
    artistName,
    category,
    parseStrategy: chooseParseStrategy(titleSource, artistSource, categorySource),
    parseConfidence: chooseParseConfidence(titleSource, artistSource, categorySource),
    parseNotes: buildParseNotes(titleSource, artistSource, categorySource)
  };
}

export function buildKtvSampleRow(sourceFile: KtvSampleSourceFile): KtvSampleRow {
  const normalizedRelativePath = sourceFile.relativePath.replaceAll("\\", "/");
  const metadata = inferKtvSampleMetadata(normalizedRelativePath);
  const fileName = normalizedRelativePath.split("/").filter(Boolean).at(-1) ?? normalizedRelativePath;

  return {
    ...sourceFile,
    relativePath: normalizedRelativePath,
    fileName,
    extension: path.extname(fileName).toLocaleLowerCase(),
    ...metadata
  };
}

export function buildKtvSampleReportMarkdown(input: KtvSampleReportInput): string {
  const lowConfidenceRows = input.rows.filter((row) => row.parseConfidence < 0.75);
  const strategyCounts = countBy(input.rows, (row) => row.parseStrategy);
  const lines = [
    "# KTV Sample Index Report",
    "",
    `- Source root: ${input.sourceRoot}`,
    `- SSH host: ${input.sshHost ?? "local"}`,
    ...(input.databaseRunId ? [`- Database run id: ${input.databaseRunId}`] : []),
    `- Total files discovered: ${formatCount(input.totalFiles)}`,
    `- Sample size requested: ${formatCount(input.sampleSize)}`,
    `- Rows generated: ${formatCount(input.rows.length)}`,
    `- Low confidence rows: ${formatCount(lowConfidenceRows.length)}`,
    "",
    "## Strategy Counts",
    "",
    ...(["filename", "hybrid", "path", "fallback"] as const).map(
      (strategy) => `- ${strategy}: ${formatCount(strategyCounts.get(strategy) ?? 0)}`
    ),
    "",
    "## Sample Rows",
    "",
    "| # | Title | Artist | Category | Strategy | Confidence | Relative path |",
    "|---:|---|---|---|---|---:|---|",
    ...input.rows.map((row, index) => (
      `| ${index + 1} | ${escapeMarkdownTable(row.title)} | ${escapeMarkdownTable(row.artistName)} | ${escapeMarkdownTable(row.category ?? "")} | ${row.parseStrategy} | ${row.parseConfidence.toFixed(2)} | ${escapeMarkdownTable(row.relativePath)} |`
    ))
  ];

  return `${lines.join("\n")}\n`;
}

export function pickRandomSample<T>(items: readonly T[], sampleSize: number, rng: () => number = Math.random): T[] {
  if (sampleSize <= 0 || items.length === 0) {
    return [];
  }

  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex] as T, shuffled[index] as T];
  }

  return shuffled.slice(0, Math.min(sampleSize, shuffled.length));
}

interface FolderMetadata {
  title?: string | undefined;
  artistName?: string | undefined;
  category?: string | undefined;
}

function inferFolderMetadata(folderSegments: string[], fallbackTitle: string): FolderMetadata {
  if (folderSegments.length >= 3) {
    return {
      category: folderSegments[0],
      artistName: folderSegments.at(-2),
      title: folderSegments.at(-1) ?? fallbackTitle
    };
  }

  if (folderSegments.length >= 2) {
    return {
      artistName: folderSegments[0],
      title: folderSegments.at(-1) ?? fallbackTitle
    };
  }

  if (folderSegments.length === 1) {
    return {
      artistName: folderSegments[0],
      title: fallbackTitle
    };
  }

  return {
    title: fallbackTitle
  };
}

function parseKtvFilename(relativePath: string): FilenameMetadataDraft {
  const fileName = path.basename(relativePath);
  const stem = stripExtension(fileName).trim();
  const segments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  const rootFolder = segments[0] ?? "";
  const rule = ruleForRootFolder(rootFolder);
  const draft = rule ? rule(stem) : null;

  if (draft?.title && draft.artistName && !draft.genre?.[0]) {
    const parentCategory = inferKtvParentCategory(rootFolder, segments.at(-2));
    if (parentCategory) {
      return {
        ...draft,
        genre: [parentCategory]
      };
    }
  }

  return draft ?? { title: stem };
}

type KtvFilenameRule = (stem: string) => FilenameMetadataDraft | null;
type KtvRootFolderProfile = "strict_dash_tail" | "strict_dash_tail_keep_trailing_parens" | "strict_dash_tail_strip_variety_markers" | "strict_dash_tail_or_loose_tail" | "strict_dash_tail_or_parenthesized_language_or_loose_tail";

const KTV_ROOT_FOLDER_PROFILES: Record<string, KtvRootFolderProfile> = {
  "2024": "strict_dash_tail_or_loose_tail",
  "2025": "strict_dash_tail_or_parenthesized_language_or_loose_tail",
  "1080P全高清MPG2026年更新（更新中）": "strict_dash_tail",
  "合唱歌曲": "strict_dash_tail",
  "国语-知名歌星专辑 11000首850G": "strict_dash_tail",
  "本店2026年更新MPG720超清（更新中）": "strict_dash_tail",
  "流行歌曲": "strict_dash_tail",
  "流行歌曲(2.5万首880G)": "strict_dash_tail",
  "流行精选": "strict_dash_tail",
  "经典老歌(1.2万首450G)": "strict_dash_tail",
  "综合专辑 9300首1.4T": "strict_dash_tail_strip_variety_markers",
  "综艺精选": "strict_dash_tail",
  "网络热歌(有新歌加入)": "strict_dash_tail",
  "酷狗排行TOP": "strict_dash_tail"
};

function ruleForRootFolder(rootFolder: string): ((stem: string) => FilenameMetadataDraft | null) | null {
  const profile = KTV_ROOT_FOLDER_PROFILES[rootFolder];
  switch (profile) {
    case "strict_dash_tail":
      return parseStrictDashTailKtvFilename;
    case "strict_dash_tail_keep_trailing_parens":
      return parseStrictDashTailKeepTrailingParensKtvFilename;
    case "strict_dash_tail_strip_variety_markers":
      return parseStrictDashTailStripVarietyMarkersKtvFilename;
    case "strict_dash_tail_or_loose_tail":
      return parseStrictDashTailOrLooseTailKtvFilename;
    case "strict_dash_tail_or_parenthesized_language_or_loose_tail":
      return parseStrictDashTailOrParenthesizedLanguageOrLooseTailKtvFilename;
    default:
      return null;
  }
}

function parseStrictDashTailKtvFilename(stem: string): FilenameMetadataDraft | null {
  return parseStrictDashTailKtvFilenameWithOptions(stem, {
    trailingTitleMarkerMode: "parentheses"
  });
}

function parseStrictDashTailKeepTrailingParensKtvFilename(stem: string): FilenameMetadataDraft | null {
  return parseStrictDashTailKtvFilenameWithOptions(stem, {
    trailingTitleMarkerMode: "none"
  });
}

function parseStrictDashTailStripVarietyMarkersKtvFilename(stem: string): FilenameMetadataDraft | null {
  return parseStrictDashTailKtvFilenameWithOptions(stem, {
    trailingTitleMarkerMode: "all"
  });
}

function parseStrictDashTailOrLooseTailKtvFilename(stem: string): FilenameMetadataDraft | null {
  return parseStrictDashTailKtvFilename(stem)
    ?? parseLooseDashTailKtvFilename(stem);
}

function parseStrictDashTailOrParenthesizedLanguageOrLooseTailKtvFilename(stem: string): FilenameMetadataDraft | null {
  return parseStrictDashTailKtvFilename(stem)
    ?? parseParenthesizedLanguageKtvFilename(stem)
    ?? parseLooseDashTailKtvFilename(stem);
}

function parseStrictDashTailKtvFilenameWithOptions(
  stem: string,
  options: {
    trailingTitleMarkerMode: "parentheses" | "all" | "none";
  }
): FilenameMetadataDraft | null {
  const normalizedStem = normalizeDashSeparators(stem);
  const parts = normalizedStem.split("-").map((part) => part.trim()).filter(Boolean);
  const languageIndex = findRightmostLanguageMarkerIndex(parts);

  if (languageIndex >= 2 && languageIndex < parts.length - 1) {
    const artistName = parts[0];
    const title = parts.slice(1, languageIndex).join("-").trim();
    const category = parts.at(-1)?.trim();
    if (artistName && title && category) {
      return {
        artistName,
        title: stripTrailingTitleMarker(title, options.trailingTitleMarkerMode),
        genre: [normalizeCategory(category)]
      };
    }
  }

  if (languageIndex >= 3 && languageIndex === parts.length - 1) {
    const artistName = parts[0];
    const title = parts.slice(1, languageIndex - 1).join("-").trim();
    const category = parts.at(languageIndex - 1)?.trim();
    if (artistName && title && category) {
      return {
        artistName,
        title: stripTrailingTitleMarker(title, options.trailingTitleMarkerMode),
        genre: [normalizeCategory(category)]
      };
    }
  }

  if (parts.length >= 3) {
    const artistName = parts[0];
    const title = parts.slice(1, -1).join("-").trim();
    const category = parts.at(-1)?.trim();
    if (artistName && title && category) {
      return {
        artistName,
        title: stripTrailingTitleMarker(title, options.trailingTitleMarkerMode),
        genre: [normalizeCategory(category)]
      };
    }
  }

  return null;
}

function parseParenthesizedLanguageKtvFilename(stem: string): FilenameMetadataDraft | null {
  const normalizedStem = normalizeDashSeparators(stem);
  const parts = normalizedStem.split("-").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const artistName = parts[0];
  const titleWithLanguage = parts.length >= 3 ? parts.slice(1, -1).join("-").trim() : parts.slice(1).join("-").trim();
  const category = parts.length >= 3 ? parts.at(-1)?.trim() : null;
  const match = titleWithLanguage.match(/^(.*?)[\(（]([^()（）]+)[\)）]$/u);
  const languageMarker = match?.[2];
  if (!artistName || !match?.[1] || !isKtvLanguageMarker(languageMarker)) {
    return null;
  }

  return {
    artistName,
    title: match[1].trim(),
    genre: [normalizeCategory(category || "新年喜庆歌曲")]
  };
}

function parseLooseDashTailKtvFilename(stem: string): FilenameMetadataDraft | null {
  const normalizedStem = normalizeDashSeparators(stem);
  const parts = normalizedStem.split("-").map((part) => part.trim()).filter(Boolean);

  if (parts.length >= 4 && isKtvLanguageMarker(parts[parts.length - 2])) {
    const artistName = parts[0];
    const title = parts.slice(1, -2).join("-").trim();
    const category = parts.at(-1)?.trim();
    return buildFilenameMetadata(artistName, title, category);
  }

  if (parts.length === 3 && isKtvLanguageMarker(parts[2])) {
    const artistName = parts[0];
    const title = parts[1];
    return buildFilenameMetadata(artistName, title, null);
  }

  if (parts.length === 3 && isKtvLanguageMarker(parts[1])) {
    const title = parts[0];
    const category = parts[2];
    return buildFilenameMetadata(null, title, category);
  }

  if (parts.length === 3) {
    const titlePart = parts[1];
    const categoryPart = parts[2];
    if (!titlePart || !categoryPart) {
      return null;
    }

    const titleWithInlineLanguage = extractTitleWithInlineLanguage(titlePart, categoryPart);
    if (titleWithInlineLanguage) {
      return buildFilenameMetadata(parts[0], titleWithInlineLanguage.title, titleWithInlineLanguage.category);
    }
  }

  if (parts.length === 2) {
    const titlePart = parts[1];
    if (!titlePart) {
      return null;
    }

    const tailParts = splitLooseTailParts(titlePart);
    if (tailParts.length >= 3 && isKtvLanguageMarker(tailParts[tailParts.length - 2])) {
      const title = tailParts.slice(0, -2).join("_").trim();
      const category = tailParts.at(-1);
      return buildFilenameMetadata(parts[0], title, category);
    }

    const titleWithInlineLanguage = extractTitleWithInlineLanguage(titlePart);
    if (titleWithInlineLanguage) {
      return buildFilenameMetadata(parts[0], titleWithInlineLanguage.title, titleWithInlineLanguage.category);
    }

    return buildFilenameMetadata(parts[0], titlePart, null);
  }

  return null;
}

function buildFilenameMetadata(
  artistName: string | null | undefined,
  title: string | null | undefined,
  category: string | null | undefined
): FilenameMetadataDraft | null {
  const cleanTitle = stripTrailingTitleMarker(title ?? "", "parentheses");
  if (!cleanTitle) {
    return null;
  }

  return {
    artistName: artistName?.trim() || "Unknown Artist",
    title: cleanTitle,
    ...(category?.trim() ? { genre: [normalizeCategory(category)] } : {})
  };
}

function isKtvLanguageMarker(value: string | undefined): boolean {
  return Boolean(value) && KTV_LANGUAGE_MARKERS.has(normalizeTailMarker(value ?? "") as KtvLanguageMarker);
}

function findRightmostLanguageMarkerIndex(parts: readonly string[]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (isKtvLanguageMarker(parts[index])) {
      return index;
    }
  }
  return -1;
}

type KtvLanguageMarker = typeof KTV_LANGUAGE_MARKERS extends Set<infer TValue> ? TValue : never;

const KTV_LANGUAGE_MARKERS = new Set([
  "国语",
  "国语歌曲",
  "囯语",
  "普通话",
  "粤语",
  "闽南",
  "闽南语",
  "闽语",
  "台语",
  "泰语",
  "蒙语",
  "彝语",
  "客家语",
  "英语",
  "日语",
  "韩语",
  "法语",
  "舞曲",
  "外语",
  "其他",
  "其它"
] as const);

function normalizeDashSeparators(value: string): string {
  return value.replace(/[－—–]/gu, "-").replace(/\s+-\s+/gu, "-");
}

function splitLooseTailParts(value: string): string[] {
  return value.split("_").map((part) => part.trim()).filter(Boolean);
}

function inferKtvParentCategory(rootFolder: string, parentFolder: string | undefined): string | null {
  if ((rootFolder !== "2024" && rootFolder !== "2025") || !parentFolder) {
    return null;
  }

  return /^20\d{2}/u.test(parentFolder) ? null : normalizeCategory(parentFolder);
}

function extractTitleWithInlineLanguage(value: string, category: string = "流行"): { title: string; category: string } | null {
  const match = value.match(/^(.*?)[\(（][^()（）]+[\)）]?(国语歌曲|国语|囯语|普通话|粤语|闽南语|闽南|闽语|台语|泰语|蒙语|彝语|客家语|英语|日语|韩语|外语|其它|其他)$/u);
  if (!match?.[1] || !isKtvLanguageMarker(match[2])) {
    return null;
  }

  return {
    title: stripTrailingTitleMarker(match[1], "parentheses"),
    category
  };
}

function normalizeTailMarker(value: string): string {
  return value.trim().replace(/\s+/gu, "");
}

function normalizeCategory(value: string): string {
  return value.trim().replace(/\s+/gu, "");
}

function chooseParseStrategy(
  titleSource: "filename" | "path" | "fallback",
  artistSource: "filename" | "path" | "fallback",
  categorySource: "filename" | "path" | "fallback"
): KtvSampleParseStrategy {
  if (titleSource === "filename" && artistSource === "filename" && categorySource === "filename") {
    return "filename";
  }

  if (titleSource === "path" && artistSource === "path" && categorySource !== "filename") {
    return "path";
  }

  if (titleSource === "fallback" && artistSource === "fallback" && categorySource === "fallback") {
    return "fallback";
  }

  return "hybrid";
}

function chooseParseConfidence(
  titleSource: "filename" | "path" | "fallback",
  artistSource: "filename" | "path" | "fallback",
  categorySource: "filename" | "path" | "fallback"
): number {
  if (titleSource === "filename" && artistSource === "filename" && categorySource === "filename") {
    return 0.98;
  }

  if (titleSource === "filename" && artistSource === "filename") {
    return 0.85;
  }

  if (titleSource === "path" && artistSource === "path") {
    return 0.72;
  }

  if (titleSource === "path" || artistSource === "path") {
    return 0.6;
  }

  return 0.3;
}

function buildParseNotes(
  titleSource: "filename" | "path" | "fallback",
  artistSource: "filename" | "path" | "fallback",
  categorySource: "filename" | "path" | "fallback"
): string[] {
  const notes = new Set<string>();
  notes.add(`title:${titleSource}`);
  notes.add(`artist:${artistSource}`);
  notes.add(`category:${categorySource}`);
  return Array.from(notes);
}

function stripExtension(fileName: string): string {
  return fileName.slice(0, fileName.length - path.extname(fileName).length);
}

function stripTrailingTitleMarker(value: string, mode: "parentheses" | "all" | "none"): string {
  if (mode === "none") {
    return value.trim();
  }

  const markerPattern = mode === "all"
    ? /\s*(?:[\(（][^()（）]*[\)）]|\[[^\[\]]*\]|【[^【】]*】)\s*$/u
    : /\s*[\(（][^()（）]*[\)）]\s*$/u;
  let stripped = value.trim();
  while (markerPattern.test(stripped)) {
    stripped = stripped.replace(markerPattern, "").trim();
  }
  return stripped;
}

function countBy<T, TKey>(items: readonly T[], keyFn: (item: T) => TKey): Map<TKey, number> {
  const counts = new Map<TKey, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function escapeMarkdownTable(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");
}
