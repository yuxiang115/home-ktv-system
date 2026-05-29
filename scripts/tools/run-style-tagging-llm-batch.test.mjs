import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBatchTagStylesArgs,
  llmLowCoverageSql,
  parseArgs
} from "./run-style-tagging-llm-batch.mjs";

test("parseArgs defaults to 30-song LLM batch requests", () => {
  const options = parseArgs([]);

  assert.equal(options.llmBatch, 30);
  assert.equal(options.llmMaxExistingTags, 0);
  assert.equal(options.progressEvery, 5);
});

test("parseArgs allows low-coverage fallback after zero-tag pass", () => {
  const options = parseArgs(["--llm-max-existing-tags", "1", "--llm-batch", "20"]);

  assert.equal(options.llmBatch, 20);
  assert.equal(options.llmMaxExistingTags, 1);
});

test("buildBatchTagStylesArgs enables one LLM request per selected batch", () => {
  const options = parseArgs(["--llm-max-existing-tags", "0"]);

  assert.deepEqual(buildBatchTagStylesArgs(options), [
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
    "--batch",
    "--progress-every",
    "5"
  ]);
});

test("llmLowCoverageSql follows the configured tag threshold", () => {
  assert.match(llmLowCoverageSql(parseArgs(["--llm-max-existing-tags", "0"])), /HAVING count\(DISTINCT st\.tag_id\) <= 0/);
  assert.match(llmLowCoverageSql(parseArgs(["--llm-max-existing-tags", "1"])), /HAVING count\(DISTINCT st\.tag_id\) <= 1/);
});
