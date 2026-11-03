/**
 * W1-T9300 — a failed proof's own output tail is recorded on the proof ({@link recordFailureTail})
 * and carried on the criterion verdict as `failureTail`, on the sync and async review paths; a
 * passing proof carries none.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  execWhitelistedProof,
  judgeReview,
  judgeReviewAsync,
  parseWhitelistedProof,
  proofFailureTail,
  recordFailureTail,
  type ProofSpawner,
} from "#src/lib/review.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROOF = "unit test: test/proof-failure-tail-recorded-on-verdict.test.ts";
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export const a = 1;\n";
const TAP = "TAP version 13\nnot ok 1 - writes the file\n  ---\n  error: 'EACCES'\n  ...\n1..1\n# fail 1\n";

const failing: ProofSpawner = () => {
  throw Object.assign(new Error("Command failed"), { status: 1, signal: null, stdout: TAP, stderr: "stderr note" });
};

test("recordFailureTail writes the bare tail and the excerpt, bounded to the last 40 lines", () => {
  const w = parseWhitelistedProof(PROOF);
  assert.ok(w);
  const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  recordFailureTail(w!, ["a"], 3, many, "tail err");
  const lines = (w!.failureTail ?? "").split("\n");
  assert.equal(lines.length, 41);
  assert.equal(lines[0], "(61 earlier lines omitted)");
  assert.equal(lines.at(-1), "tail err");
  assert.ok(!lines.includes("line 0"));
  assert.match(w!.failureOutput ?? "", /\nexit 3\n/);
  assert.equal(proofFailureTail("", ""), "");
});

test("recordFailureTail leaves failureTail unset when the failed run printed nothing", () => {
  const w = parseWhitelistedProof(PROOF);
  recordFailureTail(w!, [], 1, "", "");
  assert.equal(w!.failureTail, undefined);
  assert.match(w!.failureOutput ?? "", /\(no output\)/);
});

test("the executor records failureTail on a failed run", () => {
  const w = parseWhitelistedProof(PROOF);
  assert.equal(execWhitelistedProof(w!, REPO_ROOT, 60_000, failing, { preflightBrowsers: () => {} }), "fail");
  assert.match(w!.failureTail ?? "", /not ok 1 - writes the file/);
  assert.match(w!.failureTail ?? "", /stderr note/);
});

test("the verdict carries failureTail for a failed criterion on both paths, and not for a pass", async () => {
  const criteria = [{ claim: "the file is written", proof: PROOF }];
  const run = (spawner: ProofSpawner) => (w: Parameters<typeof execWhitelistedProof>[0], cwd: string) =>
    execWhitelistedProof(w, cwd, 60_000, spawner, { preflightBrowsers: () => {} });
  const base = { diff: DIFF, report: "the file is written", headCheckoutDir: REPO_ROOT };
  const failEv = { ...base, execProof: run(failing) };
  for (const verdict of [judgeReview(criteria, failEv), await judgeReviewAsync(criteria, failEv)]) {
    assert.equal(verdict.criteria[0]?.proof_exec, "executed_fail");
    assert.match(verdict.criteria[0]?.failureTail ?? "", /not ok 1 - writes the file/);
  }
  const passEv = { ...base, execProof: () => "pass" as const };
  for (const verdict of [judgeReview(criteria, passEv), await judgeReviewAsync(criteria, passEv)]) {
    assert.equal(verdict.criteria[0]?.proof_exec, "executed_pass");
    assert.equal(verdict.criteria[0]?.failureTail, undefined);
  }
});
