/**
 * A PLAN-SAFETY BATCH READ FINISHES WHILE THE DAEMON LOOP IS HELD.
 *
 * 2026-11-05: #16943 and #16945 (green plan PRs) refused as "the merged tree was unreadable: git cat-file --batch
 * exited null, killed by SIGTERM (its bound)". The same read by id takes 0.3 s on the host (4,915 shards, ~29 MB of
 * stdout), but core's loop was held for 60-90 s at a time. planSafetyGitAsync handed git a stdout PIPE, and git
 * blocks once ~64 KB sits unread, so a held loop stalled git itself until its bound killed it. git's stdin and
 * stdout are now files, so git completes on its own time and the call settles on the first free turn.
 *
 * The proof holds the loop in slices, as a busy daemon does, and asserts the read SETTLED between slices: through a
 * pipe, tens of MB cannot drain in that many turns.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { planSafetyGitAsync, type PlanSafetyGitResult } from "#src/lib/plan-pr-merge-safety.js";
import { gitRepo } from "#test/helpers/git-repo.js";

/** One blob, asked for COPIES times: ~48 MB of stdout, under the reader's 64 MiB cap. */
const BLOB_BYTES = 40_000;
const COPIES = 1_200;
/** The loop is held HOLDS times for HOLD_MS each, with one free turn between holds. */
const HOLD_MS = 300;
const HOLDS = 10;
/** The reader's own bound runs at most twice its 60 s budget (W1-T11368); a test past that is hung, not slow. */
const READER_WORST_MS = 2 * 60_000;

function holdLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test("a batch read of tens of MB settles between loop holds, not after them", { timeout: READER_WORST_MS + HOLDS * HOLD_MS }, async (t) => {
  const repo = gitRepo({ kind: "plan-safety-held-loop" });
  t.after(() => repo.cleanup());
  const line = `${"x".repeat(99)}\n`;
  writeFileSync(join(repo.dir, "blob.txt"), line.repeat(BLOB_BYTES / line.length));
  const id = repo.git("hash-object", "-w", "blob.txt");
  const request = `${id}\n`.repeat(COPIES);

  const read = planSafetyGitAsync(repo.dir)(["cat-file", "--batch"], request) as Promise<PlanSafetyGitResult>;
  let holdsDone = 0;
  let settledAfterHolds: number | undefined;
  void read.then(() => void (settledAfterHolds = holdsDone));
  await new Promise<void>((done) => {
    const hold = (): void => {
      holdLoop(HOLD_MS);
      holdsDone += 1;
      if (holdsDone < HOLDS && settledAfterHolds === undefined) setImmediate(hold);
      else done();
    };
    setImmediate(hold);
  });
  const result = await read;

  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.signal, null);
  const header = `${id} blob ${BLOB_BYTES}\n`;
  assert.equal(result.stdout.length, COPIES * (header.length + BLOB_BYTES + 1));
  assert.ok(result.stdout.startsWith(header), result.stdout.slice(0, 80));
  assert.ok(
    settledAfterHolds !== undefined && settledAfterHolds < HOLDS,
    `the read settled only after all ${HOLDS} holds (${String(settledAfterHolds)}): git waited on the loop to drain its stdout`,
  );
});

test("a call with no stdin still reads git's stdout, status and stderr", { timeout: READER_WORST_MS }, async (t) => {
  const repo = gitRepo({ kind: "plan-safety-held-loop" });
  t.after(() => repo.cleanup());
  const git = planSafetyGitAsync(repo.dir);
  const head = (await git(["rev-parse", "HEAD"])) as PlanSafetyGitResult;
  assert.equal(head.status, 0);
  assert.match(head.stdout, /^[0-9a-f]{40}\n$/);
  const missing = (await git(["cat-file", "-p", "0".repeat(40)])) as PlanSafetyGitResult;
  assert.equal(missing.status, 128);
  assert.equal(missing.signal, null);
  assert.match(String(missing.stderr), /fatal: /);
});
