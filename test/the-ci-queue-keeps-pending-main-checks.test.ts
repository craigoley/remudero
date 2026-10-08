import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")) as {
  concurrency: { group: string; "cancel-in-progress": string; queue?: string };
  env: { RMD_AFFECTED_SUITE_LIVE: string };
};

test("the CI queue preserves pending main checks without disabling superseded PR cancellation", () => {
  assert.deepEqual(workflow.concurrency, {
    group: "ci-${{ github.event.pull_request.number || github.ref }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    queue: "${{ github.event_name == 'pull_request' && 'single' || 'max' }}",
  });
  assert.equal(workflow.env.RMD_AFFECTED_SUITE_LIVE, "0", "queue repair does not promote unproved narrowing");
});
