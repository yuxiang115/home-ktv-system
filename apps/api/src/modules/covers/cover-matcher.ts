export interface CoverCandidate {
  provider: string;
  providerSongId: string;
  title: string;
  artistNames: readonly string[];
  albumName: string;
  picId: string;
  payload?: Record<string, unknown>;
}

export interface CoverMatch extends CoverCandidate {
  confidence: number;
}

export function selectBestCoverCandidate(
  song: { title: string; artistName: string },
  candidates: readonly CoverCandidate[]
): CoverMatch | null {
  const scored = candidates
    .map((candidate) => ({
      candidate,
      confidence: scoreCoverCandidate(song, candidate)
    }))
    .filter((entry) => entry.confidence >= 75)
    .sort((left, right) => right.confidence - left.confidence || left.candidate.title.localeCompare(right.candidate.title));

  const best = scored[0];
  return best ? { ...best.candidate, confidence: best.confidence } : null;
}

function scoreCoverCandidate(song: { title: string; artistName: string }, candidate: CoverCandidate): number {
  const titleScore = scoreTitle(song.title, candidate.title);
  if (titleScore === 0) {
    return 0;
  }

  const artistScore = scoreArtist(song.artistName, candidate.artistNames);
  if (artistScore === 0) {
    return 0;
  }

  const variantPenalty = looksLikeVariant(candidate) && !looksLikeVariant(song) ? 18 : 0;
  const missingImagePenalty = candidate.picId.trim().length === 0 ? 50 : 0;
  return Math.max(0, Math.min(100, titleScore + artistScore - variantPenalty - missingImagePenalty));
}

function scoreTitle(targetTitle: string, candidateTitle: string): number {
  const target = normalizeTitle(targetTitle);
  const candidate = normalizeTitle(candidateTitle);
  if (!target || !candidate) {
    return 0;
  }
  if (target === candidate) {
    return 60;
  }
  if (candidate.startsWith(target) || target.startsWith(candidate)) {
    return 46;
  }
  if (candidate.includes(target) || target.includes(candidate)) {
    return 38;
  }
  return 0;
}

function scoreArtist(targetArtistName: string, candidateArtistNames: readonly string[]): number {
  const targetArtists = splitArtistNames(targetArtistName);
  const candidates = candidateArtistNames.flatMap(splitArtistNames);
  if (targetArtists.length === 0 || candidates.length === 0) {
    return 0;
  }

  for (const target of targetArtists) {
    if (candidates.includes(target)) {
      return 40;
    }
  }

  for (const target of targetArtists) {
    if (candidates.some((candidate) => candidate.includes(target) || target.includes(candidate))) {
      return 28;
    }
  }

  return 0;
}

function splitArtistNames(value: string): string[] {
  return value
    .split(/[/／,，、&＆+＋|｜;；\s]+/u)
    .map(normalizeArtist)
    .filter(Boolean);
}

function normalizeTitle(value: string): string {
  return normalizeBase(value)
    .replace(/[（(【[].*?[）)】\]]/gu, "")
    .replace(/(完整版|正式版|原版|原唱版|高清版|ktv版)$/giu, "");
}

function normalizeArtist(value: string): string {
  return normalizeBase(value).replace(/(原唱|歌手)$/gu, "");
}

function normalizeBase(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/周杰伦[.\-]+/gu, "周杰伦")
    .replace(/[·.．\-_/\\:：'"“”‘’!?！？\s]/gu, "")
    .trim();
}

function looksLikeVariant(value: { title: string; albumName?: string }): boolean {
  return /(dj|live|remix|伴奏|纯音乐|翻唱|现场|演唱会|串烧|片段|抖音)/iu.test(`${value.title} ${value.albumName ?? ""}`);
}
