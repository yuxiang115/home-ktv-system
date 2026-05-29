import { describe, expect, it } from "vitest";
import { createServer } from "../server.js";

describe("retired formal catalog runtime routes", () => {
  it("does not expose legacy formal catalog, import, available-songs, or asset media routes", async () => {
    const server = await createServer({
      corsAllowedOrigins: [],
      databaseUrl: "",
      host: "127.0.0.1",
      mediaRoot: "",
      port: 0,
      publicBaseUrl: "",
      roomSlug: "living-room",
      scanIntervalMinutes: 360
    });

    try {
      const availableSongs = await server.inject({
        method: "GET",
        url: "/rooms/living-room/available-songs"
      });
      expect(availableSongs.statusCode).toBe(404);

      const adminCatalog = await server.inject({
        method: "GET",
        url: "/admin/catalog/songs"
      });
      expect(adminCatalog.statusCode).toBe(404);

      const adminImports = await server.inject({
        method: "GET",
        url: "/admin/imports/candidates"
      });
      expect(adminImports.statusCode).toBe(404);

      const legacyMedia = await server.inject({
        method: "GET",
        url: "/media/legacy-asset-id"
      });
      expect(legacyMedia.statusCode).toBe(404);
      expect(legacyMedia.json()).not.toMatchObject({ error: "ASSET_NOT_FOUND" });
    } finally {
      await server.close();
    }
  });
});
