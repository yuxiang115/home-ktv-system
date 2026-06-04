import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerMediaRoutes } from "../routes/media.js";

describe("song cover media route", () => {
  it("streams locally cached NAS cover images by song id", async () => {
    const coverRoot = await mkdtemp(join(tmpdir(), "home-ktv-covers-"));
    await mkdir(join(coverRoot, "nas"), { recursive: true });
    await writeFile(join(coverRoot, "nas", "song-1.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const server = Fastify();
    await registerMediaRoutes(server, { coverRoot });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/media/covers/nas/song-1.jpg"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect(response.rawPayload).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it("serves the cached cover content type from image bytes", async () => {
    const coverRoot = await mkdtemp(join(tmpdir(), "home-ktv-covers-"));
    await mkdir(join(coverRoot, "nas"), { recursive: true });
    await writeFile(
      join(coverRoot, "nas", "song-2.jpg"),
      Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])
    );
    const server = Fastify();
    await registerMediaRoutes(server, { coverRoot });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/media/covers/nas/song-2.jpg"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/webp");
  });

  it("allows browsers to reuse immutable cached cover images", async () => {
    const coverRoot = await mkdtemp(join(tmpdir(), "home-ktv-covers-"));
    await mkdir(join(coverRoot, "nas"), { recursive: true });
    await writeFile(join(coverRoot, "nas", "song-3.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const server = Fastify();
    await registerMediaRoutes(server, { coverRoot });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/media/covers/nas/song-3.jpg"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=2592000, immutable");
  });

  it("streams locally generated NAS cover thumbnails by song id", async () => {
    const coverRoot = await mkdtemp(join(tmpdir(), "home-ktv-covers-"));
    await mkdir(join(coverRoot, "nas", "thumbs"), { recursive: true });
    await writeFile(join(coverRoot, "nas", "thumbs", "song-4.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const server = Fastify();
    await registerMediaRoutes(server, { coverRoot });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/media/covers/nas/thumbs/song-4.jpg"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect(response.headers["cache-control"]).toBe("public, max-age=2592000, immutable");
    expect(response.rawPayload).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it("rejects unsafe cover ids before reading from disk", async () => {
    const coverRoot = await mkdtemp(join(tmpdir(), "home-ktv-covers-"));
    const server = Fastify();
    await registerMediaRoutes(server, { coverRoot });
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: "/media/covers/nas/..%2Fsecret.jpg"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "INVALID_COVER_ID" });
  });
});
