import { describe, expect, it, vi } from "vitest";
import { parseKtvStyleTagsCliOptions, runKtvStyleTagsCli } from "../scripts/ktv-style-tags.js";

describe("ktv-style-tags CLI options", () => {
  it("parses safe sample defaults and explicit apply mode", () => {
    const options = parseKtvStyleTagsCliOptions(
      ["--source", "netease", "--base-url", "http://127.0.0.1:3301", "--limit", "300", "--apply"],
      { DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv" }
    );

    expect(options).toMatchObject({
      databaseUrl: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv",
      source: "netease",
      taggingSource: "netease-playlist-v1",
      baseUrl: "http://127.0.0.1:3301",
      limit: 300,
      progressEvery: 10,
      apply: true,
      onlyMissing: true
    });
  });

  it("parses progress cadence for long-running samples", () => {
    const options = parseKtvStyleTagsCliOptions(["--limit", "300", "--progress-every", "25"], {
      DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv"
    });

    expect(options.progressEvery).toBe(25);
  });

  it("parses LLM fallback options", () => {
    const options = parseKtvStyleTagsCliOptions(
      [
        "--source",
        "llm",
        "--llm-base-url",
        "192.168.5.103:8317",
        "--llm-api-key",
        "test-key",
        "--llm-model",
        "local-model",
        "--max-existing-tags",
        "1",
        "--limit",
        "50",
        "--apply"
      ],
      { DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv" }
    );

    expect(options).toMatchObject({
      source: "llm",
      taggingSource: "llm-style-v1",
      llmBaseUrl: "192.168.5.103:8317",
      llmApiKey: "test-key",
      llmModel: "local-model",
      maxExistingTags: 1,
      limit: 50,
      apply: true
    });
  });

  it("defaults LLM fallback to low-coverage songs", () => {
    const options = parseKtvStyleTagsCliOptions(["--source", "llm"], {
      DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv",
      LLM_API_BASE_URL: "http://llm.local:8317",
      LLM_API_KEY: "test-key",
      LLM_MODEL: "local-model"
    });

    expect(options.maxExistingTags).toBe(1);
    expect(options.llmBaseUrl).toBe("http://llm.local:8317");
    expect(options.llmApiKey).toBe("test-key");
    expect(options.llmModel).toBe("local-model");
  });

  it("defaults to dry-run unless --apply is present", () => {
    const options = parseKtvStyleTagsCliOptions(["--limit", "50"], {
      DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv"
    });

    expect(options.apply).toBe(false);
    expect(options.onlyMissing).toBe(true);
    expect(options.limit).toBe(50);
  });

  it("ignores the pnpm argument separator when it is forwarded by a wrapper script", () => {
    const options = parseKtvStyleTagsCliOptions(["--", "--limit", "50", "--dry-run"], {
      DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv"
    });

    expect(options.limit).toBe(50);
    expect(options.apply).toBe(false);
  });

  it("does not call Pool.connect before using query-based clients", async () => {
    const connect = vi.fn(() => {
      throw new Error("connect should not be called");
    });
    const end = vi.fn(async () => {});
    const db = {
      connect,
      end,
      query: vi.fn(async () => ({ rows: [] }))
    };

    await expect(
      runKtvStyleTagsCli(["--limit", "1", "--dry-run"], {
        createDbClient: () => db,
        env: { DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv" },
        stdout: () => {}
      })
    ).resolves.toBe(0);
    expect(connect).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
  });
});
