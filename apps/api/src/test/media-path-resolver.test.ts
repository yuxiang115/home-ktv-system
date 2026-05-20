import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MediaPathResolver } from "../modules/assets/media-path-resolver.js";

describe("MediaPathResolver", () => {
  it("allows mapped NAS source paths to resolve outside MEDIA_ROOT when the mapped target is configured", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "home-ktv-media-map-"));
    const localNasRoot = path.join(tempRoot, "KTV歌曲");
    const mediaRoot = path.join(tempRoot, "library");
    await mkdir(localNasRoot, { recursive: true });
    await mkdir(mediaRoot, { recursive: true });
    await writeFile(path.join(localNasRoot, "周杰伦-稻香.mkv"), "demo-media");

    const resolver = new MediaPathResolver({
      mediaRoot,
      pathMappings: [{ from: "/mnt/nas/KTV歌曲", to: localNasRoot }]
    });

    await expect(resolver.resolveAssetFile("/mnt/nas/KTV歌曲/周杰伦-稻香.mkv")).resolves.toMatchObject({
      ok: true,
      filePath: path.join(localNasRoot, "周杰伦-稻香.mkv"),
      sizeBytes: "demo-media".length
    });
  });
});
