import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  isPathWithinRoot,
  mapMediaPath,
  mediaPathMappingTargets,
  type MediaPathMapping
} from "./media-path-mapping.js";

export type MediaPathResolution =
  | { ok: true; filePath: string; sizeBytes: number }
  | { ok: false; reason: "media-root-not-configured" | "path-outside-media-root" | "file-not-found" | "not-a-file" };

export interface MediaPathResolverOptions {
  mediaRoot: string;
  pathMappings?: readonly MediaPathMapping[];
}

export class MediaPathResolver {
  private readonly mediaRoot: string;
  private readonly allowedRoots: string[];
  private readonly pathMappings: readonly MediaPathMapping[];

  constructor(options: MediaPathResolverOptions) {
    this.mediaRoot = options.mediaRoot.trim() ? resolve(options.mediaRoot) : "";
    this.pathMappings = options.pathMappings ?? [];
    this.allowedRoots = [
      ...(this.mediaRoot ? [this.mediaRoot] : []),
      ...mediaPathMappingTargets(this.pathMappings)
    ];
  }

  async resolveAssetFile(filePath: string): Promise<MediaPathResolution> {
    if (this.allowedRoots.length === 0) {
      return { ok: false, reason: "media-root-not-configured" };
    }

    const mappedFilePath = mapMediaPath(filePath, this.pathMappings);
    if (!this.mediaRoot && !isAbsolute(mappedFilePath)) {
      return { ok: false, reason: "media-root-not-configured" };
    }

    const candidatePath = isAbsolute(mappedFilePath) ? resolve(mappedFilePath) : resolve(this.mediaRoot, mappedFilePath);
    if (!this.allowedRoots.some((root) => isPathWithinRoot(candidatePath, root))) {
      return { ok: false, reason: "path-outside-media-root" };
    }

    try {
      const fileStat = await stat(candidatePath);
      if (!fileStat.isFile()) {
        return { ok: false, reason: "not-a-file" };
      }

      return {
        ok: true,
        filePath: candidatePath,
        sizeBytes: fileStat.size
      };
    } catch {
      return { ok: false, reason: "file-not-found" };
    }
  }
}
