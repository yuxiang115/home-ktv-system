import path from "node:path";

export interface MediaPathMapping {
  from: string;
  to: string;
}

export function parseMediaPathMappings(value: string | undefined): MediaPathMapping[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separatorIndex = item.indexOf("=");
      if (separatorIndex <= 0 || separatorIndex === item.length - 1) {
        return null;
      }

      const from = item.slice(0, separatorIndex).trim();
      const to = item.slice(separatorIndex + 1).trim();
      return from && to ? { from, to } : null;
    })
    .filter((mapping): mapping is MediaPathMapping => mapping !== null);
}

export function mapMediaPath(filePath: string, mappings: readonly MediaPathMapping[] = []): string {
  const candidate = filePath.trim();
  if (!candidate || !path.isAbsolute(candidate)) {
    return filePath;
  }

  for (const mapping of mappings) {
    const fromRoot = normalizedAbsolutePath(mapping.from);
    const toRoot = normalizedAbsolutePath(mapping.to);
    if (!fromRoot || !toRoot) {
      continue;
    }

    if (isPathWithinRoot(candidate, fromRoot)) {
      return joinUnderRoot(mapping.to.trim(), path.relative(fromRoot, candidate));
    }
  }

  return filePath;
}

// path.resolve() would re-anchor POSIX-style targets (e.g. "/nas/...") onto the
// current Windows drive; keep the configured root's own separator style instead.
function joinUnderRoot(root: string, relative: string): string {
  const trimmedRoot = root.replace(/[\\/]+$/u, "");
  if (!trimmedRoot) {
    return relative;
  }
  if (!relative) {
    return trimmedRoot;
  }
  const separator = trimmedRoot.includes("/") && !trimmedRoot.includes("\\") ? "/" : path.sep;
  const relativeParts = relative.split(/[\\/]/u).filter(Boolean);
  return [trimmedRoot, ...relativeParts].join(separator);
}

export function mediaPathMappingTargets(mappings: readonly MediaPathMapping[] = []): string[] {
  return mappings
    .map((mapping) => normalizedAbsolutePath(mapping.to))
    .filter((target): target is string => target !== null);
}

export function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizedAbsolutePath(value: string): string | null {
  const trimmed = value.trim();
  return trimmed && path.isAbsolute(trimmed) ? path.resolve(trimmed) : null;
}
