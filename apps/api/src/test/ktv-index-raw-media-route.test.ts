import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { MediaPathResolver } from "../modules/assets/media-path-resolver.js";
import {
  registerMediaRoutes,
  type KtvIndexRawAssetRepository,
  type KtvIndexRawAssetRow
} from "../routes/media.js";
import { describe, expect, it } from "vitest";

describe("KTV index raw media route", () => {
  it("streams an indexed NAS asset with range support", async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), "home-ktv-raw-media-"));
    const mediaPath = join(mediaRoot, "sample.mkv");
    await writeFile(mediaPath, Buffer.from("0123456789"));
    const server = Fastify();

    await registerMediaRoutes(server, {
      ktvIndexRawAssets: new FakeRawAssetRepository({
        id: "ktv-asset-1",
        filePath: mediaPath
      }),
      mediaPathResolver: new MediaPathResolver({ mediaRoot })
    });

    const response = await server.inject({
      method: "GET",
      url: "/media/ktv-index/ktv-asset-1/raw",
      headers: {
        range: "bytes=2-5"
      }
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers["content-type"]).toContain("video/x-matroska");
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    expect(response.body).toBe("2345");
  });
});

class FakeRawAssetRepository implements KtvIndexRawAssetRepository {
  constructor(private readonly row: KtvIndexRawAssetRow | null) {}

  async findRawAssetById(): Promise<KtvIndexRawAssetRow | null> {
    return this.row;
  }
}
