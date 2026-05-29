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
  const options = parseArgs([
    "--netease-batch",
    "1000",
    "--llm-batch",
    "30",
    "--llm-max-existing-tags",
    "0",
    "--sleep-ms",
    "1000"
  ]);

  assert.equal(options.neteaseBatch, 1000);
  assert.equal(options.llmBatch, 30);
  assert.equal(options.llmMaxExistingTags, 0);
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
    "--max-existing-tags",
    "1",
    "--progress-every",
    "5"
  ]);
});

test("buildTagStylesArgs can limit LLM fallback to zero-tag songs", () => {
  const options = parseArgs(["--llm-max-existing-tags", "0"]);

  assert.deepEqual(buildTagStylesArgs("llm", options), [
    "deploy/docker/ktv.sh",
    "tag-styles",
    "--",
    "--source",
    "llm",
    "--limit",
    "30",
    "--apply",
    "--max-existing-tags",
    "0",
    "--progress-every",
    "5"
  ]);
  assert.match(llmLowCoverageSql(options), /HAVING count\(DISTINCT st\.tag_id\) <= 0/);
});

test("count SQL separates Netease missing and LLM low coverage", () => {
  assert.match(neteaseMissingSql(), /status\.source = 'netease-playlist-v1'/);
  assert.match(neteaseMissingSql(), /status\.song_id IS NULL/);
  assert.match(llmLowCoverageSql(parseArgs([])), /base_status\.source = 'netease-playlist-v1'/);
  assert.match(llmLowCoverageSql(parseArgs([])), /llm_status\.status IS DISTINCT FROM 'tagged'/);
  assert.match(llmLowCoverageSql(parseArgs([])), /HAVING count\(DISTINCT st\.tag_id\) <= 1/);
});
