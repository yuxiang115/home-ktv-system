import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "../server.js";

describe("local media catalog routes", () => {
  it("serves real local media files through discovery when no database is configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "home-ktv-local-routes-"));
    const mediaRoot = path.join(root, "media");
    const libraryRoot = path.join(root, "songs-sample");
    await mkdir(mediaRoot, { recursive: true });
    await mkdir(libraryRoot, { recursive: true });
    await writeFile(path.join(libraryRoot, "关喆-想你的夜(MTV)-国语-流行.mkv"), "sample");

    const server = await createServer({
      corsAllowedOrigins: [],
      databaseUrl: "",
      host: "0.0.0.0",
      mediaPathMappings: [{ from: libraryRoot, to: libraryRoot }],
      mediaRoot,
      port: 4000,
      publicBaseUrl: "http://127.0.0.1:4000",
      roomSlug: "living-room"
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/rooms/living-room/songs/discovery?seed=real-library&limit=10"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().recommended).toEqual([
        expect.objectContaining({
          title: "想你的夜",
          artistName: "关喆",
          genre: ["流行"],
          versions: [
            expect.objectContaining({
              canQueue: true,
              sourceLabel: "本地"
            })
          ]
        })
      ]);
    } finally {
      await server.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
