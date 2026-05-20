import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { schemaSql } from "../db/schema.js";

const sourceIdentityMigrationUrl = new URL(
  "../db/migrations/0010_ktv_catalog_sync_source_identity.sql",
  import.meta.url
);

describe("KTV catalog sync source identity schema", () => {
  it("adds a partial unique source_records identity for KTV indexed assets", async () => {
    const migrationSql = await readFile(sourceIdentityMigrationUrl, "utf8");

    for (const sql of [migrationSql, schemaSql]) {
      expect(sql).toContain("source_records_ktv_index_asset_uq");
      expect(sql).toContain("provider = 'ktv-index'");
      expect(sql).toContain("WHERE provider = 'ktv-index' AND provider_item_id IS NOT NULL");
    }
  });
});
