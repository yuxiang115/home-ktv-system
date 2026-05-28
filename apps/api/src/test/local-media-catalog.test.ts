import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalMediaCatalog } from "../runtime/local-media-catalog.js";

describe("local media catalog", () => {
  it("indexes loose real KTV media files as queueable songs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "home-ktv-local-catalog-"));
    const libraryRoot = path.join(root, "songs-sample");
    const mediaRoot = path.join(root, "media");
    await mkdir(libraryRoot, { recursive: true });
    await mkdir(mediaRoot, { recursive: true });
    const mediaPath = path.join(libraryRoot, "蔡依林-BECAUSE OF YOU(演唱会)-国语-流行.mpg");
    await writeFile(mediaPath, "sample");

    try {
      const catalog = await createLocalMediaCatalog({
        mediaRoot,
        mediaPathMappings: [{ from: libraryRoot, to: libraryRoot }],
        now: new Date("2026-05-28T00:00:00.000Z")
      });

      const records = await catalog.songs.searchFormalSongs({ query: "蔡依林", limit: 10 });

      expect(records).toHaveLength(1);
      expect(records[0]?.song.title).toBe("BECAUSE OF YOU");
      expect(records[0]?.song.artistName).toBe("蔡依林");
      expect(records[0]?.song.genre).toEqual(["流行"]);
      expect(records[0]?.versions[0]).toMatchObject({
        canQueue: true,
        queueState: "queueable",
        sourceLabel: "本地"
      });

      const assetId = records[0]?.versions[0]?.assetId ?? "";
      const asset = await catalog.assets.findById(assetId);
      expect(asset).toMatchObject({
        assetKind: "dual-track-video",
        compatibilityStatus: "playable",
        filePath: mediaPath,
        status: "ready"
      });
      expect(asset?.trackRoles?.instrumental).toMatchObject({ index: 0 });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
