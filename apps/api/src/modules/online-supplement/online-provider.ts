export interface OnlineSearchCandidate {
  provider: string;
  providerCandidateId: string;
  sourceUrl: string;
  title: string;
  artistName: string;
  durationMs: number | null;
  providerPayload: Record<string, unknown>;
}

export interface DownloadAssetResult {
  filePath: string;
  sizeBytes: number | null;
  mtimeMs: number | null;
}

export interface OnlineDownloadInput {
  candidate: OnlineSearchCandidate;
  destPath: string;
}

export interface OnlineSearchInput {
  query: string;
  limit: number;
}

export interface OnlineProvider {
  readonly providerId: string;
  search(input: OnlineSearchInput): Promise<OnlineSearchCandidate[]>;
  download(input: OnlineDownloadInput): Promise<DownloadAssetResult>;
}
