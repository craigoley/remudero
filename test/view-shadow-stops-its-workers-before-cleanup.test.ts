/**
 * test/view-shadow.test.ts stops every read-model worker it started before it removes a scratch dir.
 *
 * #8895's coverage-shard (3/8) failed that file's after-hook with ENOTEMPTY (`rmSync` on
 * `.../read-model` while a live read-model thread still wrote) and then sat to the shard's bound,
 * twice: node:test runs `t.after` hooks first-registered-first and skips the rest once one throws,
 * and `scratch()` registered its removal BEFORE the test's worker stop, so the stop never ran and
 * the live thread kept the process open. The same shape in
 * test/shadow-readiness-accrues-without-console-traffic.test.ts hung #8823's and #8908's shard 1/8.
 *
 * This runs the REAL file in a child `node --test` and reads each test's cleanup diagnostics in
 * order, so a stop dropped from (or moved behind) the removal is observed, not assumed. The spawn's
 * own timeout turns a regressed hang into a named failure instead of a hung shard.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUBJECT = "test/view-shadow.test.ts";
const HYGIENE_HREF = pathToFileURL(join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts")).href;
const NOTE = /^\s*# view-shadow cleanup: (.+)$/gm;
/** The subject runs in about 13 s; its three worker waits are each bounded at 60 s, each stop at READ_MODEL_STOP_WAIT_MS (2 s). */
const CHILD_TIMEOUT_MS = 300_000;

/** The tests that start a read-model worker or ticker, and what each must close before its scratch goes. */
const WORKER_TESTS: Record<string, string[]> = {
  "the worker compares a shadow sample off the main thread and the status view shows readiness": ["ticker released", "scratch removed"],
  "the worker branch hands a shadow message to its comparator": ["worker branch stopped", "scratch removed"],
  "serve posts a shadow sample to a real worker thread which writes the diff row": ["worker handle stopped", "scratch removed"],
};

/** Each subtest's title and the cleanup notes the TAP reporter printed after its result. */
function cleanupBySubtest(output: string): Map<string, string[]> {
  const notes = new Map<string, string[]>();
  for (const chunk of output.split(/^# Subtest: /m).slice(1)) {
    const title = chunk.slice(0, chunk.indexOf("\n"));
    notes.set(title, [...chunk.matchAll(NOTE)].map((m) => m[1]!));
  }
  return notes;
}

test("view-shadow's tests stop every read-model worker before removing their scratch directories", () => {
  const child = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", "tsx", "--import", HYGIENE_HREF, SUBJECT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
  // node --test traps the timeout's SIGTERM and exits by code, so the timeout reads only as ETIMEDOUT.
  assert.equal(child.error?.message, undefined, `the subject did not exit on its own within ${CHILD_TIMEOUT_MS} ms — a live worker held it open:\n${output}`);
  assert.match(output, /^# fail 0$/m, `the subject must pass:\n${output}`);
  assert.match(output, /^# pass [1-9]/m, `the subject must actually run:\n${output}`);
  assert.equal(child.status, 0, output);

  const notes = cleanupBySubtest(output);
  for (const [title, order] of Object.entries(WORKER_TESTS)) {
    assert.deepEqual(notes.get(title), order, `"${title}" must close its worker, then remove its scratch:\n${output}`);
  }
  const removing = [...notes].filter(([, seen]) => seen.length > 0);
  assert.ok(removing.length > Object.keys(WORKER_TESTS).length, "the scratch-only tests report their removal too");
  for (const [title, seen] of removing) {
    assert.equal(seen.indexOf("scratch removed"), seen.length - 1, `"${title}" removed its scratch only after everything else closed: ${seen.join(", ")}`);
  }
});
