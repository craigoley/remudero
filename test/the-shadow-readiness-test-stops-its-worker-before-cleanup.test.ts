/**
 * W1-T5461 — the shadow-readiness test stops its read-model worker before removing its scratch dir.
 *
 * #8823's coverage-shard (1/8) failed that test's after-hook with ENOTEMPTY (`rmSync` while the
 * restarted worker still wrote) and then sat to the shard's 2340 s bound: node:test skips the hooks
 * behind a throwing one, so the worker's stop never ran and the live thread kept the process open.
 *
 * This runs the REAL file in a child `node --test` and reads its cleanup diagnostics in order, so a
 * stop dropped from (or moved behind) the removal is observed, not assumed. The spawn's own timeout
 * turns a regressed hang into a named failure instead of a second hung shard.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUBJECT = "test/shadow-readiness-accrues-without-console-traffic.test.ts";
const HYGIENE_HREF = pathToFileURL(join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts")).href;
const NOTE = /^\s*# shadow-readiness cleanup: (.+)$/gm;
/** Two workers in the subject (the driven one and the restarted one), each stopping in under a second. */
const CHILD_TIMEOUT_MS = 120_000;

test("the shadow-readiness test stops its read-model worker before removing its scratch directory", () => {
  const child = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", "tsx", "--import", HYGIENE_HREF, SUBJECT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
  assert.equal(child.signal, null, `the subject did not exit on its own within ${CHILD_TIMEOUT_MS} ms — a live worker held it open:\n${output}`);
  assert.match(output, /^# fail 0$/m, `the subject must pass:\n${output}`);
  assert.match(output, /^# pass [1-9]/m, `the subject must actually run:\n${output}`);
  assert.equal(child.status, 0, output);

  const lifecycle = [...output.matchAll(NOTE)].map((m) => m[1]);
  assert.deepEqual(lifecycle, ["worker stopped", "worker stopped", "scratch removed"], `cleanup must stop both workers, then remove the scratch dir:\n${output}`);
});
