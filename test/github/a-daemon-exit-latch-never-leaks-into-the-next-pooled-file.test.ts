/**
 * W1-T13363 — A DAEMON EXIT LATCH NEVER LEAKS INTO THE NEXT POOLED TEST FILE.
 *
 * 2026-11-17, ci-shard first attempts on both runner images: W1-T6595, W1-T9212 and W1-T12059 failed with
 * `direct-merge-preflight-refused` and passed on the flake retry. Rebuilding shard 8/8's 308-file pool for main
 * cf7db0e and bisecting it locally named test/a-freshness-restart-lets-a-running-review-finish.test.ts: its daemon
 * stops for freshness, which closes direct-merge admissions ("freshness_latch") for the rest of the shared process.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { registerProcessExitLatch, reopenProcessExitLatches } from "#src/lib/process-exit-latches.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const LATCHING_FILE = "test/a-freshness-restart-lets-a-running-review-finish.test.ts";
const MERGING_FILE = "test/a-green-reviewed-plan-pr-the-sweep-holds-merges.test.ts";

test("W1-T13363 criterion 1: every registered exit latch is reopened, in registration order, and a name registers once", () => {
  const calls: string[] = [];
  registerProcessExitLatch("w1-t13363-a", () => calls.push("a-old"));
  registerProcessExitLatch("w1-t13363-b", () => calls.push("b"));
  registerProcessExitLatch("w1-t13363-a", () => calls.push("a"));
  const names = reopenProcessExitLatches();
  const ours = names.filter((n) => n.startsWith("w1-t13363-"));
  assert.deepEqual(ours, ["w1-t13363-a", "w1-t13363-b"]);
  assert.deepEqual(calls, ["a", "b"], "the later registration of a name replaced the earlier one");
});

test("W1-T13363 criterion 2: the direct-merge and light-pass refill latches are registered by their modules", async () => {
  await import("#src/lib/arm-auto-merge.js");
  await import("#src/lib/sweep.js");
  const names = reopenProcessExitLatches();
  assert.ok(names.includes("direct-merge-admissions"), names.join(", "));
  assert.ok(names.includes("light-pass-refills"), names.join(", "));
});

test("W1-T13363 criterion 3: a pooled run of the latching file, then the merging file, merges", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: "" };
  delete env.NODE_TEST_CONTEXT; // a nested runner would otherwise report to this one and exit 0 on failure
  const run = spawnSync(process.execPath, [
    "--test", "--experimental-test-isolation=none", "--test-reporter=tap",
    "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", LATCHING_FILE, MERGING_FILE,
  ], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 240_000, maxBuffer: 1 << 26 });
  const out = `${run.stdout}\n${run.stderr}`;
  assert.match(out, /^# tests [1-9]/m, `positive control: the pooled run reported a summary\n${out.slice(-2000)}`);
  assert.match(out, /^ok \d+ - W1-T6595: the sweep merges a green reviewed plan PR the review would merge/m,
    "positive control: the merging file's test ran in the same pooled process");
  assert.match(out, /^# fail 0$/m, out.split("\n").filter((l) => /^\s*not ok/.test(l)).join("\n"));
});
