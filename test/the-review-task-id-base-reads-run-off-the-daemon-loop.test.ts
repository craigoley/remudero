import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// Namespace import: this file must LOAD on a base without the awaited symbols, so each proof
// fails there on its own assertion rather than on a missing export.
import * as reviewLib from "../src/lib/review.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

// After #9644 made the anchor read awaited, runReview's task-id evidence still read origin/main's declarations (ls-tree + cat-file --batch) and
// the reservation baseline (git show) through execFileSync, and judgeReview re-read the declarations
// a second time, synchronously. These pin the awaited replacement: the loop keeps running, a bound
// kills a hung git and the evidence names it, and the awaited reads answer a real repository exactly
// as the sync ones.

const BASE_ID = "W1-T9201";
const EXEMPT_ID = "W1-T9202";
const NEW_ID = "W1-T9203";
const BRANCH = "plan/base-read-fixture";
const BASE_FILE = `plan/tasks.d/${BASE_ID}-base.yaml`;
const ADDED_FILE = `plan/tasks.d/${NEW_ID}-added.yaml`;
const diffAdding = (...ids: string[]): string =>
  `diff --git a/${ADDED_FILE} b/${ADDED_FILE}\n+++ b/${ADDED_FILE}\n@@\n` + ids.map((id) => `+- id: ${id}\n+  title: t\n`).join("");

/** A checkout whose origin/main declares BASE_ID in a shard and exempts EXEMPT_ID in the reservation baseline. */
function planAtMain(): GitRepo {
  const repo = gitRepo({ kind: "review-base-read" });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(repo.dir, BASE_FILE), `- id: ${BASE_ID}\n  title: déjà — base\n`);
  writeFileSync(
    join(repo.dir, "plan", "task-id-reservation-baseline.json"),
    JSON.stringify([{ id: EXEMPT_ID, reason: "filed before reservations" }, { id: "W1-T9299", reason: "" }]),
  );
  repo.git("add", "plan");
  repo.git("commit", "-q", "-m", "plan at main");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}

/** A shell script standing in for `git`: `body` runs, then (when `exec`) the real git with the args. */
function fakeGit(body: string, exec = false): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-review-base-fake-bin-"));
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(dir, "git");
  writeFileSync(bin, `#!/bin/sh\n${body}\n${exec ? `exec ${realGit} "$@"\n` : ""}`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

/** Every anchor absent, with no remote: the ownership half's anchor read is not what these measure. */
const noAnchors = (ids: string[]) => new Map(ids.map((id) => [id, { status: "absent" as const }]));

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

test("the review's awaited base declaration and baseline reads keep a timer firing while their git is pending", async () => {
  const repo = planAtMain();
  // The PRODUCTION entry, with a git on PATH that takes 400 ms per call. Both added ids are exempt
  // (one declared at origin/main, one in the baseline), so no anchor read runs: only the base reads.
  const slow = fakeGit("sleep 0.4", true);
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${slow.dir}:${savedPath}`;
    const { value, ticks } = await ticksWhile(() => reviewLib.reviewReservationOwnershipEvidenceAsync(diffAdding(BASE_ID, EXEMPT_ID), BRANCH, repo.dir));
    process.env.PATH = savedPath;
    assert.deepEqual(value, [], "a base-declared id and a baseline-exempt id are not filed by this PR");
    assert.ok(ticks >= 10, `the loop must keep servicing timers during the base reads' git calls (ticked ${ticks})`);
  } finally {
    process.env.PATH = savedPath;
    rmSync(slow.dir, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("a review base read killed at its bound reads every filed id unknown and names the timeout", async () => {
  const repo = planAtMain();
  const pidDir = mkdtempSync(join(tmpdir(), "rmd-review-base-pid-"));
  const pidFile = join(pidDir, "pid");
  const hung = fakeGit(`echo $$ > ${pidFile}\nexec sleep 30`);
  // Answers the listing and the batch through real git, and hangs only on the baseline's `show`.
  const hungShow = fakeGit(`if [ "$3" = "show" ]; then exec sleep 30; fi`, true);
  try {
    const run = reviewLib.gitBlobRunnerAsync(repo.dir, { timeoutMs: 150, graceMs: 50, gitBin: hung.bin });
    const diff = diffAdding(NEW_ID, BASE_ID);
    const evidence = await reviewLib.reviewTaskIdEvidenceAsync(diff, BRANCH, repo.dir, noAnchors, run);
    assert.deepEqual(evidence.ownership, [
      { id: NEW_ID, file: ADDED_FILE, kind: "unknown", reason: "base-unreadable: git ls-tree timed out after 150ms and was killed" },
      { id: BASE_ID, file: ADDED_FILE, kind: "unknown", reason: "base-unreadable: git ls-tree timed out after 150ms and was killed" },
    ], "an unanswered base read is unknown for every filed id, never an empty base that files them all");
    assert.deepEqual(evidence.baseDeclarations, [], "the judge sees an empty base, as on any unreadable ref");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "the hung git was killed, not abandoned");

    const showRun = reviewLib.gitBlobRunnerAsync(repo.dir, { timeoutMs: 1_500, graceMs: 50, gitBin: hungShow.bin });
    const baselineHung = await reviewLib.reviewTaskIdEvidenceAsync(diff, BRANCH, repo.dir, noAnchors, showRun);
    assert.deepEqual(baselineHung.ownership?.map((f) => (f.kind === "unknown" ? f.reason : f.kind)), [
      "baseline-unreadable: git show timed out after 1500ms and was killed",
      "baseline-unreadable: git show timed out after 1500ms and was killed",
    ]);
    assert.deepEqual(baselineHung.baseDeclarations, [{ id: BASE_ID, file: BASE_FILE }], "the declarations read before the hang are kept");
    await assert.rejects(reviewLib.taskIdDeclarationsAtRefAsync(repo.dir, "origin/main", run), (e: Error) => e.name === "ReviewGitTimeout");
  } finally {
    rmSync(hung.dir, { recursive: true, force: true });
    rmSync(hungShow.dir, { recursive: true, force: true });
    rmSync(pidDir, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("the awaited and sync review base reads answer a real repository identically", async () => {
  const repo = planAtMain();
  try {
    const sync = reviewLib.taskIdDeclarationsAtRef(repo.dir, "origin/main");
    assert.deepEqual(sync, [{ id: BASE_ID, file: BASE_FILE }]);
    assert.deepEqual(await reviewLib.taskIdDeclarationsAtRefAsync(repo.dir, "origin/main"), sync);
    assert.deepEqual(await reviewLib.taskIdDeclarationsAtRefAsync(repo.dir, "no-such-ref"), reviewLib.taskIdDeclarationsAtRef(repo.dir, "no-such-ref"));

    for (const [diff, head] of [
      [diffAdding(NEW_ID, BASE_ID, EXEMPT_ID), BRANCH],
      [diffAdding(NEW_ID), undefined],
      ["", BRANCH],
    ] as const) {
      const awaited = await reviewLib.reviewTaskIdEvidenceAsync(diff, head, repo.dir, noAnchors);
      assert.deepEqual(awaited.ownership, reviewLib.reviewReservationOwnershipEvidence(diff, head, repo.dir, noAnchors), `ownership for ${head}`);
      assert.deepEqual(await reviewLib.reviewReservationOwnershipEvidenceAsync(diff, head, repo.dir, noAnchors), awaited.ownership);
      assert.deepEqual(awaited.baseDeclarations, diff === "" ? undefined : sync, "the base the judge would have read itself");
    }
    const filed = await reviewLib.reviewTaskIdEvidenceAsync(diffAdding(NEW_ID, BASE_ID, EXEMPT_ID), BRANCH, repo.dir, noAnchors);
    assert.deepEqual(filed.ownership, [{ id: NEW_ID, file: ADDED_FILE, kind: "unreserved" }], "only the id neither the base nor the baseline exempts");

    // An unparseable baseline exempts nothing in either read.
    writeFileSync(join(repo.dir, "plan", "task-id-reservation-baseline.json"), "{ not json");
    repo.git("commit", "-q", "-am", "torn baseline");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    const torn = diffAdding(NEW_ID, EXEMPT_ID);
    const tornRead = await reviewLib.reviewTaskIdEvidenceAsync(torn, BRANCH, repo.dir, noAnchors);
    assert.deepEqual(tornRead.ownership?.map((f) => f.id), [NEW_ID, EXEMPT_ID], "a torn baseline exempts nothing");
    assert.deepEqual(tornRead.ownership, reviewLib.reviewReservationOwnershipEvidence(torn, BRANCH, repo.dir, noAnchors));

    // No origin/main at all: both read an empty base and an empty baseline, and agree.
    repo.git("update-ref", "-d", "refs/remotes/origin/main");
    const bare = diffAdding(NEW_ID, BASE_ID, EXEMPT_ID);
    const unread = await reviewLib.reviewTaskIdEvidenceAsync(bare, BRANCH, repo.dir, noAnchors);
    assert.deepEqual(unread.ownership, reviewLib.reviewReservationOwnershipEvidence(bare, BRANCH, repo.dir, noAnchors));
    assert.deepEqual(unread.baseDeclarations, []);
  } finally {
    repo.cleanup();
  }
});

test("the judge's id-collision check takes the awaited base declarations instead of re-reading git", () => {
  // A checkout git cannot read: only the handed-in base can produce this collision.
  const diff = diffAdding(BASE_ID);
  const verdict = reviewLib.judgeReview([], {
    diff,
    report: "",
    headRefName: BRANCH,
    headCheckoutDir: join(tmpdir(), "rmd-review-base-no-such-checkout"),
    reservationOwnership: [],
    baseTaskIdDeclarations: [{ id: BASE_ID, file: BASE_FILE }],
  } as Parameters<typeof reviewLib.judgeReview>[1]);
  assert.deepEqual(verdict.taskIdCollisions, [{ id: BASE_ID, addedFile: ADDED_FILE, baseFile: BASE_FILE }]);
});
