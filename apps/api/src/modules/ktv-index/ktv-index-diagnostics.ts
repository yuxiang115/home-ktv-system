import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { KtvIndexDiagnosticsResponse, KtvIndexNasSampleResult } from "@home-ktv/domain";

export interface BuildNasSampleInput {
  assets: readonly { indexedAssetId: string; filePath: string }[];
  sourceRoot?: string | null;
  timeoutMs?: number;
  accessFile?: (filePath: string) => Promise<void>;
}

const timeoutMarker = Symbol("ktv-nas-sample-timeout");

export async function buildNasSample(input: BuildNasSampleInput): Promise<KtvIndexDiagnosticsResponse["nasSample"]> {
  const timeoutMs = Math.min(1000, Math.max(50, input.timeoutMs ?? 250));
  const accessFile = input.accessFile ?? ((filePath: string) => access(filePath, constants.R_OK));
  const results: KtvIndexNasSampleResult[] = [];

  for (const asset of input.assets) {
    const unmappedMessage = unmappedReason(asset.filePath, input.sourceRoot);
    if (unmappedMessage) {
      results.push({
        indexedAssetId: asset.indexedAssetId,
        filePath: asset.filePath,
        readable: false,
        status: "unmapped",
        message: unmappedMessage
      });
      continue;
    }

    try {
      await withTimeout(accessFile(asset.filePath), timeoutMs);
      results.push({
        indexedAssetId: asset.indexedAssetId,
        filePath: asset.filePath,
        readable: true,
        status: "readable",
        message: null
      });
    } catch (error) {
      const status = sampleStatusForError(error);
      results.push({
        indexedAssetId: asset.indexedAssetId,
        filePath: asset.filePath,
        readable: false,
        status,
        message: status === "timeout" ? `timed out after ${timeoutMs}ms` : errorMessage(error)
      });
    }
  }

  return {
    requested: input.assets.length,
    checked: results.length,
    readable: countStatus(results, "readable"),
    missing: countStatus(results, "missing"),
    unreadable: countStatus(results, "unreadable"),
    timeout: countStatus(results, "timeout"),
    unmapped: countStatus(results, "unmapped"),
    results
  };
}

function unmappedReason(filePath: string, sourceRoot: string | null | undefined): string | null {
  if (!filePath.trim()) {
    return "path is blank";
  }
  if (!path.isAbsolute(filePath)) {
    return "path is not absolute";
  }
  if (sourceRoot?.trim()) {
    const relative = path.relative(sourceRoot, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return "path outside source root";
    }
  }
  return null;
}

function withTimeout<TValue>(promise: Promise<TValue>, timeoutMs: number): Promise<TValue> {
  return new Promise<TValue>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutMarker), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function sampleStatusForError(error: unknown): KtvIndexNasSampleResult["status"] {
  if (error === timeoutMarker) {
    return "timeout";
  }
  if (isErrno(error, "ENOENT")) {
    return "missing";
  }
  return "unreadable";
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function countStatus(results: readonly KtvIndexNasSampleResult[], status: KtvIndexNasSampleResult["status"]): number {
  return results.filter((result) => result.status === status).length;
}
