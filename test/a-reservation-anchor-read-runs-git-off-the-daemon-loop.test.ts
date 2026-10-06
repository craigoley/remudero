import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// Namespace imports: this file must LOAD on a base without the awaited symbols, so each proof
// fails there on its own assertion rather than on a missing export.
import * as reviewLib from "../src/lib/review.js";
import * as reservationLib from "../src/lib/task-id-reservation.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const { readReservationAnchors, formatReservationAnchorMessage } = reservationLib;
const { reviewReservationOwnershipEvidence } = reviewLib;
const readReservationAnchorsAsync: typeof reservationLib.readReservationAnchorsAsync = (...a) => reservationLib.readReservationAnchorsAsync(...a);
const gitReservationRunnerAsync: typeof reservationLib.gitReservationRunnerAsync = (...a) => reservationLib.gitReservationRunnerAsync(...a);
const taskIdOwnershipFindingsAsync: typeof reviewLib.taskIdOwnershipFindingsAsync = (...a) => reviewLib.taskIdOwnershipFindingsAsync(...a);
const reviewReservationOwnershipEvidenceAsync: typeof reviewLib.reviewReservationOwnershipEvidenceAsync = (...a) =>
  reviewLib.reviewReservationOwnershipEvidenceAsync(...a);

// MEASURED 2026-10-06: runReview's reservation-anchor read ran `spawnSync` git (ls-remote, fetch,
// log) inside the daemon process: ~885 s of sync spawn and ~1,628 s of attributed loop lag per 17 h,
// one spawn 322 s. These pin the awaited replacement: the loop keeps running, a bound kills a hung
// git and the outcome names it, and the awaited read answers a real origin exactly as the sync one.

const HELD = "W1-T9101";
const FREE = "W1-T9102";
const BRANCH = "plan/anchor-read-fixture";
const FILE = `plan/tasks.d/${HELD}-fixture.yaml`;
const DIFF = `diff --git a/${FILE} b/${FILE}\n+++ b/${FILE}\n@@\n+- id: ${HELD}\n+  title: one\n+- id: ${FREE}\n+  title: two\n`;

/** A shell script standing in for `git`: `body` runs, then (when `exec`) the real git with the args. */
function fakeGit(body: string, exec = false): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-anchor-fake-bin-"));
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(dir, "git");
  writeFileSync(bin, `#!/bin/sh\n${body}\n${exec ? `exec ${realGit} "$@"\n` : ""}`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

/** A bare origin holding `refs/rmd-id/<HELD>` (an anchor naming BRANCH) and a working clone of it. */
function heldOrigin(): { work: GitRepo; cleanup(): void } {
  const origin = gitRepo({ bare: true, kind: "anchor-origin" });
  const work = gitRepo({ kind: "anchor-work" });
  work.git("config", "user.name", "remudero-test-work");
  work.git("config", "user.email", "work@remudero.invalid");
  work.addRemote("origin", origin.dir);
  work.git("push", "--quiet", "origin", "main");
  work.git("fetch", "--quiet", "origin");
  const tree = work.git("hash-object", "-t", "tree", "/dev/null");
  const message = formatReservationAnchorMessage({ branch: BRANCH, pid: 1, host: "fixture", startedAt: "2026-10-06T00:00:00Z", source: "automatic" });
  const anchor = work.git("commit-tree", tree, "-m", message);
  work.git("push", "--quiet", "origin", `${anchor}:refs/rmd-id/${HELD}`);
  return { work, cleanup: () => (origin.cleanup(), work.cleanup()) };
}

function syncRunner(dir: string) {
  return (args: string[]) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
  };
}

/** Counts interval ticks while `pending` settles — a loop held by a sync spawn counts almost none. */
async function ticksWhile<T>(pending: () => Promise<T>): Promise<{ value: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 20);
  try {
    const value = await pending();
    return { value, ticks };
  } finally {
    clearInterval(timer);
  }
}

test("the awaited reservation anchor read keeps a timer firing while its git is pending", async () => {
  const f = heldOrigin();
  // The PRODUCTION entry runReview awaits, with a git on PATH that takes 400 ms per call.
  const slow = fakeGit("sleep 0.4", true);
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${slow.dir}:${savedPath}`;
    const { value, ticks } = await ticksWhile(() => reviewReservationOwnershipEvidenceAsync(DIFF, BRANCH, f.work.dir));
    process.env.PATH = savedPath;
    assert.deepEqual(value, [{ id: FREE, file: FILE, kind: "unreserved" }], "the held id passes, the free one is unreserved");
    assert.ok(ticks >= 10, `the loop must keep servicing timers during the anchor read's git calls (ticked ${ticks})`);
  } finally {
    process.env.PATH = savedPath;
    rmSync(slow.dir, { recursive: true, force: true });
    f.cleanup();
  }
});

test("a reservation anchor read killed at its bound reads unknown and the finding names the timeout", async () => {
  const pidDir = mkdtempSync(join(tmpdir(), "rmd-anchor-pid-"));
  const pidFile = join(pidDir, "pid");
  const hung = fakeGit(`echo $$ > ${pidFile}\necho 'connecting to origin' >&2\nexec sleep 30`);
  const mute = fakeGit("exec sleep 30");
  try {
    const run = gitReservationRunnerAsync("/nonexistent-dir", { timeoutMs: 150, graceMs: 50, gitBin: hung.bin });
    const added = [{ id: HELD, file: FILE }, { id: FREE, file: FILE }];
    const findings = await taskIdOwnershipFindingsAsync(DIFF, added, [], BRANCH, pidDir, (ids) => readReservationAnchorsAsync(ids, run));
    assert.deepEqual(
      findings.map((x) => x.kind),
      ["unknown", "unknown"],
      "a listing that never answered must read unknown, never absent (unreserved) or present",
    );
    for (const x of findings) {
      assert.match(x.kind === "unknown" ? x.reason : "", /ls-remote failed: git ls-remote timed out after 150ms and was killed\. git said: connecting to origin/);
    }
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "the hung git was killed, not abandoned");
    const silent = await gitReservationRunnerAsync("/nonexistent-dir", { timeoutMs: 100, graceMs: 50, gitBin: mute.bin })(["ls-remote", "origin"]);
    assert.deepEqual(silent, { status: 1, stdout: "", stderr: "git ls-remote timed out after 100ms and was killed." });
  } finally {
    rmSync(hung.dir, { recursive: true, force: true });
    rmSync(mute.dir, { recursive: true, force: true });
    rmSync(pidDir, { recursive: true, force: true });
  }
});

test("the awaited and sync reservation anchor reads answer a real origin identically", async () => {
  const f = heldOrigin();
  try {
    const ids = [HELD, FREE];
    const sync = readReservationAnchors(ids, syncRunner(f.work.dir));
    const awaited = await readReservationAnchorsAsync(ids, gitReservationRunnerAsync(f.work.dir));
    assert.deepEqual(awaited, sync);
    assert.equal(awaited.get(HELD)?.status, "present");
    const held = awaited.get(HELD);
    assert.equal(reservationLib.reservationHolderBranch(held?.status === "present" ? held.message : ""), BRANCH);
    assert.deepEqual(awaited.get(FREE), { status: "absent" });
    assert.deepEqual(await readReservationAnchorsAsync([], gitReservationRunnerAsync(f.work.dir)), new Map());

    assert.deepEqual(await reviewReservationOwnershipEvidenceAsync(DIFF, BRANCH, f.work.dir), reviewReservationOwnershipEvidence(DIFF, BRANCH, f.work.dir));
    assert.deepEqual(await reviewReservationOwnershipEvidenceAsync(DIFF, "another-branch", f.work.dir), reviewReservationOwnershipEvidence(DIFF, "another-branch", f.work.dir));
    assert.deepEqual(await reviewReservationOwnershipEvidenceAsync(DIFF, undefined, f.work.dir), reviewReservationOwnershipEvidence(DIFF, undefined, f.work.dir));
    assert.equal(await reviewReservationOwnershipEvidenceAsync("", BRANCH, f.work.dir), undefined);

    // An unreadable origin: both make every id unknown with git's own words, never absent.
    f.work.git("remote", "set-url", "origin", join(f.work.dir, "no-such-origin"));
    const syncUnread = readReservationAnchors(ids, syncRunner(f.work.dir));
    const awaitedUnread = await readReservationAnchorsAsync(ids, gitReservationRunnerAsync(f.work.dir));
    assert.deepEqual(awaitedUnread, syncUnread);
    assert.deepEqual([...awaitedUnread.values()].map((r) => r.status), ["unknown", "unknown"]);
  } finally {
    f.cleanup();
  }
});
