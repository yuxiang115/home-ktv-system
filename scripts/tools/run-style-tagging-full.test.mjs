import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTagStylesArgs,
  llmLowCoverageSql,
  neteaseMissingSql,
  parseArgs
} from "./run-style-tagging-full.mjs";

test("parseArgs defaults to safe full-library batch sizes", () => {
  const options = parseArgs([]);

  assert.equal(options.neteaseBatch, 500);
  assert.equal(options.llmBatch, 30);
  assert.equal(options.neteaseBaseUrl, "http://ktv-netease-api:3000");
});

test("parseArgs allows overriding batch sizes", () => {
  const options = parseArgs(["--netease-batch", "1000", "--llm-batch", "30", "--sleep-ms", "1000"]);

  assert.equal(options.neteaseBatch, 1000);
  assert.equal(options.llmBatch, 30);
  assert.equal(options.sleepMs, 1000);
});

test("buildTagStylesArgs runs Netease first and LLM in 30-song fallback batches", () => {
  const options = parseArgs(["--llm-batch", "30"]);

  assert.deepEqual(buildTagStylesArgs("netease", options), [
    "deploy/docker/ktv.sh",
    "tag-styles",
    "--",
    "--source",
    "netease",
    "--base-url",
    "http://ktv-netease-api:3000",
    "--limit",
    "500",
    "--apply",
    "--progress-every",
    "50"
  ]);
  assert.deepEqual(buildTagStylesArgs("llm", options), [
    "deploy/docker/ktv.sh",
    "tag-styles",
    "--",
    "--source",
    "llm",
    "--limit",
    "30",
    "--apply",
    "--progress-every",
    "5"
  ]);
});

test("count SQL separates Netease missing and LLM low coverage", () => {
  assert.match(neteaseMissingSql(), /status\.source = 'netease-playlist-v1'/);
  assert.match(neteaseMissingSql(), /status\.song_id IS NULL/);
  assert.match(llmLowCoverageSql(), /base_status\.source = 'netease-playlist-v1'/);
  assert.match(llmLowCoverageSql(), /llm_status\.status IS DISTINCT FROM 'tagged'/);
  assert.match(llmLowCoverageSql(), /HAVING count\(DISTINCT st\.tag_id\) <= 1/);
});
