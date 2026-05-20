import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "../db/query-executor.js";
import { createPgRuntimeRepositories } from "../runtime/pg-runtime-repositories.js";

describe("indexed queue command runtime repositories", () => {
  it("creates the PostgreSQL runtime repository bundle over any query executor", () => {
    const repositories = createPgRuntimeRepositories(new FakeQueryExecutor());

    expect(repositories.ktvIndex).toBeDefined();
    expect(repositories.queueEntries).toBeDefined();
    expect(repositories.controlCommands).toBeDefined();
    expect(repositories.playbackSessions).toBeDefined();
  });
});

class FakeQueryExecutor implements QueryExecutor {
  async query<TRow>(): Promise<{ rows: TRow[] }> {
    return { rows: [] };
  }
}
