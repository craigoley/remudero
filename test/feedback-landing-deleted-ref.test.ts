import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LANDING_BRANCH, landFeedback } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo } from "./helpers/git-repo.js";

// ── W1-T3888 — A MERGED-AND-DELETED LANDING BRANCH IS LEASED AS A LIVE TIP ─────────────────
//
// LIVE INCIDENT (this task's own rationale): `refs/heads/feedback-landing` was ABSENT on the
// remote — GitHub had deleted it once its PR merged — while the LOCAL `refs/remotes/origin/
// feedback-landing` tracking ref still held the last sha it ever saw. `readBranchPending` fixed
// `branchTipSha` from that stale local ref (a bare `git fetch origin --quiet` never prunes a
// remote-tracking ref whose remote counterpart is gone — git-fetch(1)'s PRUNING section), so
// `finishLanding` built a `--force-with-lease` expecting a sha the remote could never match. Both
// the first push and the one rebuild retry were refused as stale, and the refusal text ("its tip
// moved again after re-deriving the union once") named a third-writer race that never happened.
//
// These tests drive the fix — `readBranchPending` now consults a named `refreshLandingRef` seam
// before `branchTipSha` is ever fixed — against a REAL local bare "origin" (no network anywhere),
// deleting the remote branch for real via `git update-ref -d` (GitHub's own deletion-on-merge, in
// miniature), with only the `gh` half faked. Deliberately its own file, separate from
// test/feedback-landing-union-writer.test.ts (W1-T3560's own two-root union/lease shape, which
// this task must leave unchanged) and test/feedback-landing.test.ts (the original W1-T243/W1-T191
// bridge mechanism).

/** A bare "origin" remote, seeded with one commit on `main` — no network involved anywhere. */
function makeBareOrigin(): string {
  const bare = gitRepo({ bare: true, kind: "feedback-landing-deleted-ref-origin" });
  const seed = gitRepo({ kind: "feedback-landing-deleted-ref-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed");
  seed.addRemote("origin", bare.dir);
  seed.git("push", "--quiet", "origin", "main");
  seed.cleanup();
  return bare.dir;
}

/** A real clone of `bareOrigin` — one independent state root's own checkout. */
function cloneRoot(bareOrigin: string): string {
  return gitRepo({ cloneFrom: bareOrigin, kind: "feedback-landing-deleted-ref-root" }).dir;
}

/** A fake `gh` — no real GitHub call anywhere; tracks every invocation for assertions. */
function fakeGh(prUrl: string) {
  const calls: string[][] = [];
  let createCount = 0;
  let mergeCount = 0;
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return createCount > 0 ? JSON.stringify([{ url: prUrl }]) : JSON.stringify([]);
    }
    if (args[0] === "pr" && args[1] === "create") {
      createCount++;
      return `Creating pull request for ${LANDING_BRANCH} into main in o/r\n${prUrl}\n`;
    }
    if (args[0] === "pr" && args[1] === "merge") {
      mergeCount++;
      return "";
    }
    throw new Error(`unexpected gh call in test fixture: ${JSON.stringify(args)}`);
  };
  return { gh, calls, createCount: () => createCount, mergeCount: () => mergeCount };
}

function writeFeedbackEntry(root: string, id: string, raw: string): void {
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", `${id}.yaml`), `id: ${id}\nraw: ${raw}\n`);
}

function landingTree(bareOrigin: string): string {
  return execFileSync("git", ["--git-dir", bareOrigin, "ls-tree", "-r", "--name-only", LANDING_BRANCH], {
    encoding: "utf8",
  });
}

function bareBranchSha(bareOrigin: string, branch: string): string | undefined {
  try {
    return execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", `refs/heads/${branch}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Delete the branch on the bare "origin" for real — GitHub's own deletion-on-merge, in
 *  miniature — SHA-guarded to the exact tip this test just pushed, so this only ever removes
 *  the one ref this test is about. */
function deleteRemoteBranch(bareOrigin: string, branch: string, expectedSha: string): void {
  execFileSync("git", ["--git-dir", bareOrigin, "update-ref", "-d", `refs/heads/${branch}`, expectedSha], {
    encoding: "utf8",
  });
}

// ── acceptance 1: a deleted ref lands fresh under the empty-expected-value lease ────────────

test("unit test: a deleted landing ref creates a fresh branch with an empty expected lease — no other ref, worktree or source file is touched", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  writeFeedbackEntry(root, "fb-first", "first record — lands, then GitHub deletes the branch on merge");

  const { gh: gh1 } = fakeGh("https://github.com/o/r/pull/401");
  const first = withLiveWritesAllowed(() => landFeedback(root, { gh: gh1 }));
  assert.equal(first.landed, true, "sanity: the first landing succeeds normally");

  const mainBefore = execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", "refs/heads/main"], {
    encoding: "utf8",
  }).trim();

  // The exact live-incident shape: the LOCAL tracking ref still holds a sha once the branch is
  // gone on the remote — not a contrived absence.
  const staleTip = execFileSync("git", ["-C", root, "rev-parse", `origin/${LANDING_BRANCH}`], {
    encoding: "utf8",
  }).trim();
  assert.notEqual(staleTip, "", "sanity: the local tracking ref is non-empty before deletion");
  deleteRemoteBranch(bareOrigin, LANDING_BRANCH, staleTip);
  assert.equal(bareBranchSha(bareOrigin, LANDING_BRANCH), undefined, "sanity: the remote branch is genuinely gone");

  // A record captured before anyone noticed — root's local tracking ref is still exactly the
  // now-deleted sha, unrefreshed, when this second call starts.
  writeFeedbackEntry(root, "fb-second", "second record — blocked until the deleted ref is observed");
  const pushArgs: string[][] = [];
  const spyGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "push") pushArgs.push(args);
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ?? process.env,
    });
  };

  const { gh: gh2 } = fakeGh("https://github.com/o/r/pull/402");
  const second = withLiveWritesAllowed(() => landFeedback(root, { git: spyGit, gh: gh2 }));
  assert.equal(second.landed, true, "the deleted ref must not block the next landing");
  assert.equal(second.error, undefined, "no refusal — an absent branch is not a lost lease");
  assert.equal(pushArgs.length, 1, "exactly one push — no retry is needed once the absence is observed correctly");
  assert.equal(
    pushArgs[0][1],
    `--force-with-lease=refs/heads/${LANDING_BRANCH}:`,
    "the lease must assert emptiness — the same shape a never-pushed branch already used",
  );

  const tree = landingTree(bareOrigin);
  assert.match(tree, /fb-first\.yaml/, "the record lost when the branch was deleted is re-created");
  assert.match(tree, /fb-second\.yaml/, "the fresh branch carries the new record too");

  const mainAfter = execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", "refs/heads/main"], {
    encoding: "utf8",
  }).trim();
  assert.equal(mainAfter, mainBefore, "no unrelated ref (main) was ever touched by this repair");
});

// ── acceptance 4: identical content after deletion must not fool the already-landed short-circuit

test("unit test: an absent landing ref reports absence not a concurrent move — identical content still recreates the branch", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  writeFeedbackEntry(root, "fb-echo", "unchanged record — its bytes never move");

  const { gh: gh1 } = fakeGh("https://github.com/o/r/pull/403");
  const first = withLiveWritesAllowed(() => landFeedback(root, { gh: gh1 }));
  assert.equal(first.landed, true);

  const staleTip = execFileSync("git", ["-C", root, "rev-parse", `origin/${LANDING_BRANCH}`], {
    encoding: "utf8",
  }).trim();
  deleteRemoteBranch(bareOrigin, LANDING_BRANCH, staleTip);
  assert.equal(bareBranchSha(bareOrigin, LANDING_BRANCH), undefined, "sanity: the remote branch is genuinely gone");

  // Nothing on disk changed since the first call — the union this call recomputes is byte-for-byte
  // what was already pushed, so a stale local tracking ref left untouched would make
  // `remoteBranchTree` report the SAME tree as `build.treeSha` by sheer coincidence, taking the
  // already-landed short-circuit and reporting `landed: true` without ever recreating the branch.
  const pushArgs: string[][] = [];
  const spyGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "push") pushArgs.push(args);
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ?? process.env,
    });
  };
  const { gh: gh2, createCount } = fakeGh("https://github.com/o/r/pull/404");
  const second = withLiveWritesAllowed(() => landFeedback(root, { git: spyGit, gh: gh2 }));

  assert.equal(second.landed, true, "the record must still be reported landed");
  assert.equal(pushArgs.length, 1, "a real push must happen — the short-circuit must not fire against a deleted branch");
  assert.notEqual(bareBranchSha(bareOrigin, LANDING_BRANCH), undefined, "the branch must actually exist on the remote again");
  assert.equal(createCount(), 1, "a fresh PR is opened since the branch (and any PR against it) is genuinely gone");
});

// ── acceptance 2: a branch that still exists and moved once is unchanged from today ────────

test("unit test: one live landing move rederives exactly once — the retry lands unchanged by the deleted-ref fix", () => {
  const bareOrigin = makeBareOrigin();
  const rootA = cloneRoot(bareOrigin);
  const rootB = cloneRoot(bareOrigin);
  writeFeedbackEntry(rootA, "fb-move-a", "root A's own record");
  writeFeedbackEntry(rootB, "fb-move-b", "root B's own record");

  const { gh: ghA } = fakeGh("https://github.com/o/r/pull/405");
  const { gh: ghB } = fakeGh("https://github.com/o/r/pull/406");

  let racedOnce = false;
  let pushCount = 0;
  let refreshReads = 0;
  const racingGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "ls-remote") refreshReads++;
    if (args[0] === "push") {
      pushCount++;
      if (!racedOnce) {
        racedOnce = true;
        const aResult = withLiveWritesAllowed(() => landFeedback(rootA, { gh: ghA }));
        assert.equal(aResult.landed, true, "sanity: root A's own interleaved landing must itself succeed");
      }
    }
    return execFileSync("git", ["-C", rootB, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ?? process.env,
    });
  };

  const bResult = withLiveWritesAllowed(() => landFeedback(rootB, { gh: ghB, git: racingGit }));
  assert.equal(racedOnce, true, "sanity: the race actually happened mid-push");
  assert.equal(bResult.landed, true, "B's re-derived retry must still succeed against the moved tip");
  assert.equal(bResult.error, undefined, "a successfully recomputed retry is not reported as an error");
  assert.equal(pushCount, 2, "exactly one rebuild-and-retry — the first attempt plus one retry, never more");
  assert.ok(refreshReads > 0, "the live branch is refreshed from the authoritative remote before deriving its lease");

  const tree = landingTree(bareOrigin);
  assert.match(tree, /fb-move-a\.yaml/);
  assert.match(tree, /fb-move-b\.yaml/);
});

// ── acceptance 3: a branch that moves twice under contention is still refused ───────────────

test("unit test: two live landing moves refuse without force replacement — the branch's actual content is left untouched", () => {
  const bareOrigin = makeBareOrigin();
  const rootA = cloneRoot(bareOrigin);
  const rootB = cloneRoot(bareOrigin);
  writeFeedbackEntry(rootA, "fb-double-a", "root A's own record — must survive B's refusal untouched");
  writeFeedbackEntry(rootB, "fb-double-b", "root B's own record — never lands this call");

  const { gh: ghA } = fakeGh("https://github.com/o/r/pull/407");
  const { gh: ghB } = fakeGh("https://github.com/o/r/pull/408");

  const aResult = withLiveWritesAllowed(() => landFeedback(rootA, { gh: ghA }));
  assert.equal(aResult.landed, true);
  const headBeforeB = execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", `refs/heads/${LANDING_BRANCH}`], {
    encoding: "utf8",
  }).trim();

  let refreshReads = 0;
  const alwaysStaleLeaseGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "ls-remote") refreshReads++;
    if (args[0] === "push") {
      throw new Error(`! [rejected] refs/heads/${LANDING_BRANCH} -> ${LANDING_BRANCH} (stale info)`);
    }
    return execFileSync("git", ["-C", rootB, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ?? process.env,
    });
  };

  const bResult = withLiveWritesAllowed(() => landFeedback(rootB, { gh: ghB, git: alwaysStaleLeaseGit }));
  assert.equal(bResult.landed, false, "a lease lost even under the retry must be refused, not force-replaced");
  // Design (iv): a GENUINE second live move must keep saying what it says today — never confused
  // with the W1-T3888 deleted-ref case, which this task makes land silently instead of refusing.
  assert.match(bResult.error ?? "", /refused to force-replace/i, "the reason names a genuine tip move, unchanged from before this task");
  assert.match(bResult.error ?? "", /tip moved again/i);

  const headAfterB = execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", `refs/heads/${LANDING_BRANCH}`], {
    encoding: "utf8",
  }).trim();
  assert.equal(headAfterB, headBeforeB, "a refused call must never move the branch");
  assert.ok(refreshReads > 0, "the live branch is refreshed before the CAS refusal is evaluated");
});

// ── acceptance 5: unreadable pending content still refuses, never a fresh empty create ──────

test("unit test: unreadable landing content refuses without fresh create — content cannot be collapsed", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  writeFeedbackEntry(root, "fb-unreadable", "a record that lands once, then its content becomes unreadable");

  const { gh: gh1, createCount: createCount1, mergeCount: mergeCount1 } = fakeGh("https://github.com/o/r/pull/409");
  const first = withLiveWritesAllowed(() => landFeedback(root, { gh: gh1 }));
  assert.equal(first.landed, true);
  assert.equal(createCount1(), 1);
  assert.equal(mergeCount1(), 0, "sanity: the first PR remains awaiting the shared review lane");

  // The branch genuinely EXISTS on the remote (unlike every other test in this file) — `ls-remote`
  // truthfully reports presence, and the follow-up `ls-tree` read of its pending content fails
  // unexpectedly. This must refuse the whole call, never collapse into "absent" and recreate an
  // empty branch that would silently drop the record already landed there.
  writeFeedbackEntry(root, "fb-unreadable-2", "a second record — must not ride a false empty-create either");
  let refreshReads = 0;
  const unreadableLsTreeGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "ls-remote") refreshReads++;
    if (args[0] === "ls-tree") {
      throw new Error("simulated: transient read failure, NOT 'branch does not exist'");
    }
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ?? process.env,
    });
  };
  const { gh: gh2, createCount: createCount2, mergeCount: mergeCount2 } = fakeGh("https://github.com/o/r/pull/410");
  const second = withLiveWritesAllowed(() => landFeedback(root, { git: unreadableLsTreeGit, gh: gh2 }));

  assert.equal(second.landed, false, "an unreadable pending-union read must refuse, not push a possibly-incomplete tree");
  assert.match(second.error ?? "", /cannot read/i, "the reason is surfaced via `error`, never swallowed into an empty union");
  assert.doesNotMatch(second.error ?? "", /tip moved/i, "an unreadable-content refusal is never mislabelled as a concurrent tip move");
  assert.equal(createCount2(), 0, "no PR was ever created off an unproven union");
  assert.equal(mergeCount2(), 0, "auto-merge was never armed off an unproven union");
  assert.ok(refreshReads > 0, "the existing branch is refreshed before its pending content is read");

  const tree = landingTree(bareOrigin);
  assert.match(tree, /fb-unreadable\.yaml/, "the branch's real, already-landed content is untouched by the refusal");
});

test("refreshing the landing ref refuses when the authoritative remote read fails", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  writeFeedbackEntry(root, "fb-refresh-error", "the remote read itself is unavailable");
  const { gh } = fakeGh("https://github.com/o/r/pull/411");
  const failingGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "ls-remote") throw new Error("simulated: remote ref read unavailable");
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ?? process.env,
    });
  };
  const result = withLiveWritesAllowed(() => landFeedback(root, { git: failingGit, gh }));
  assert.equal(result.landed, false);
  assert.match(result.error ?? "", /cannot refresh .*remote ref/i);
});

test("a confirmed remote landing ref that cannot be read refuses instead of assuming empty", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  writeFeedbackEntry(root, "fb-tip-error", "lands once before the tip read fails");
  const first = withLiveWritesAllowed(() => landFeedback(root, { gh: fakeGh("https://github.com/o/r/pull/412").gh }));
  assert.equal(first.landed, true);
  writeFeedbackEntry(root, "fb-tip-error-2", "must not be dropped on a tip read failure");
  const { gh } = fakeGh("https://github.com/o/r/pull/413");
  const failingGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "rev-parse" && args[1] === `origin/${LANDING_BRANCH}`) {
      throw new Error("simulated: confirmed landing tip unreadable");
    }
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ?? process.env,
    });
  };
  const result = withLiveWritesAllowed(() => landFeedback(root, { git: failingGit, gh }));
  assert.equal(result.landed, false);
  assert.match(result.error ?? "", /cannot read .*tip after confirming it exists/i);
});
