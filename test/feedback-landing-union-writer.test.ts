import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LANDING_BRANCH, landFeedback } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

// ── W1-T3560 — THE UNION WRITER + LEASE, NOT A WHOLE-REF REPLACE ───────────────────────────
//
// Before this task, `landPending`'s tree was `origin/main` plus THIS state root's own unlanded
// disk files — never `origin/<branch>`'s own content — and `finishLanding` pushed it with a bare
// `git push --force`, no expected old value. Two independent state roots with DISJOINT pending
// batches therefore alternated: whichever root landed second silently dropped the first root's
// records from the branch, and a PR already armed for auto-merge stayed armed over the
// now-incomplete head. This file drives the fix — {@link landPending} now carries the branch's
// own pending content forward exactly as `landContent` always did, and `finishLanding` pushes
// with `--force-with-lease` (re-deriving the union once on a lost lease, then refusing) — against
// a REAL local bare "origin" (no network anywhere), with only the `gh` half faked. Deliberately
// kept separate from test/feedback-landing.test.ts (that file's own tests are pinned by title and
// own the original W1-T243/W1-T191 reconciliation mechanism, not this task's two-root shape).

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

/** A bare "origin" remote, seeded with one commit on `main` — no network involved anywhere. */
function makeBareOrigin(): string {
  const bare = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-union-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });

  const seed = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-union-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** A real clone of `bareOrigin` — one independent state root's own checkout. */
function cloneRoot(bareOrigin: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-union-root-"));
  execFileSync("git", ["clone", "--quiet", bareOrigin, dir], { encoding: "utf8", env: GIT_ENV });
  return dir;
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

// ── acceptance: two disjoint roots, either order, both records present ─────────────────────

test("two independent state roots landing disjoint pending batches — root A first — end with BOTH records present, neither depending on the other running again", () => {
  const bareOrigin = makeBareOrigin();
  const rootA = cloneRoot(bareOrigin);
  const rootB = cloneRoot(bareOrigin);
  writeFeedbackEntry(rootA, "fb-a", "root A's own record");
  writeFeedbackEntry(rootB, "fb-b", "root B's own record");

  const { gh: ghA } = fakeGh("https://github.com/o/r/pull/301");
  const { gh: ghB } = fakeGh("https://github.com/o/r/pull/302");

  const a = withLiveWritesAllowed(() => landFeedback(rootA, { gh: ghA }));
  assert.equal(a.landed, true, "root A's own record lands");

  // Root A never runs again from here — the record it captured must survive purely because
  // root B's later, disjoint landing carries it forward.
  const b = withLiveWritesAllowed(() => landFeedback(rootB, { gh: ghB }));
  assert.equal(b.landed, true, "root B's own record lands");
  assert.deepEqual(b.files, ["plan/feedback/fb-b.yaml"], "B's own reported files are only its own — the carry-forward is not double-reported");

  const tree = landingTree(bareOrigin);
  assert.match(tree, /plan\/feedback\/fb-a\.yaml/, "root A's record must still be on the branch after root B's disjoint landing");
  assert.match(tree, /plan\/feedback\/fb-b\.yaml/, "root B's own record must be on the branch too");
});

test("...and in the OTHER order — root B first — the same two disjoint records both survive", () => {
  const bareOrigin = makeBareOrigin();
  const rootA = cloneRoot(bareOrigin);
  const rootB = cloneRoot(bareOrigin);
  writeFeedbackEntry(rootA, "fb-a2", "root A's own record");
  writeFeedbackEntry(rootB, "fb-b2", "root B's own record");

  const { gh: ghA } = fakeGh("https://github.com/o/r/pull/303");
  const { gh: ghB } = fakeGh("https://github.com/o/r/pull/304");

  const b = withLiveWritesAllowed(() => landFeedback(rootB, { gh: ghB }));
  assert.equal(b.landed, true);

  const a = withLiveWritesAllowed(() => landFeedback(rootA, { gh: ghA }));
  assert.equal(a.landed, true);
  assert.deepEqual(a.files, ["plan/feedback/fb-a2.yaml"]);

  const tree = landingTree(bareOrigin);
  assert.match(tree, /plan\/feedback\/fb-a2\.yaml/);
  assert.match(tree, /plan\/feedback\/fb-b2\.yaml/, "the order is reversed, but neither root's record is dropped");
});

// ── acceptance: a lost lease is recomputed once, never force-replaced blind ─────────────────

test("a lost lease REFUSES the stale push, RE-DERIVES the union against the moved tip, and the retry succeeds — never force-replacing a tip it never read", () => {
  const bareOrigin = makeBareOrigin();
  const rootA = cloneRoot(bareOrigin);
  const rootB = cloneRoot(bareOrigin);
  writeFeedbackEntry(rootA, "fb-race-a", "root A's own record");
  writeFeedbackEntry(rootB, "fb-race-b", "root B's own record");

  const { gh: ghA } = fakeGh("https://github.com/o/r/pull/305");
  const { gh: ghB } = fakeGh("https://github.com/o/r/pull/306");

  let racedOnce = false;
  // Root B's OWN git handle: every call passes straight through to a real `git -C rootB`, except
  // that the FIRST `push` call (B's stale attempt, computed before A ever touched the branch)
  // triggers root A's OWN, completely separate landing call first — for real, against the same
  // bare origin — so by the time B's push actually reaches git, the branch tip has genuinely
  // moved out from under the lease B read.
  const racingGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "push" && !racedOnce) {
      racedOnce = true;
      const aResult = withLiveWritesAllowed(() => landFeedback(rootA, { gh: ghA }));
      assert.equal(aResult.landed, true, "sanity: root A's own interleaved landing must itself succeed");
    }
    return execFileSync("git", ["-C", rootB, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ?? process.env,
    });
  };

  const bResult = withLiveWritesAllowed(() => landFeedback(rootB, { gh: ghB, git: racingGit }));
  assert.equal(racedOnce, true, "sanity: the race actually happened mid-push, not before or after");
  assert.equal(bResult.landed, true, "B's re-derived retry must still succeed against the moved tip");
  assert.equal(bResult.error, undefined, "a successfully recomputed retry is not reported as an error");

  const tree = landingTree(bareOrigin);
  assert.match(tree, /fb-race-a\.yaml/, "root A's record survives — B's retry carried it forward instead of force-replacing it");
  assert.match(tree, /fb-race-b\.yaml/, "root B's own record is present too");
});

// ── acceptance: the ref is refused, never force-replaced, when it moves under the retry too ──

test("the ref moving TWICE under contention is REFUSED outright — surfaced via `error`, and the branch's actual (racing) content is left untouched", () => {
  const bareOrigin = makeBareOrigin();
  const rootA = cloneRoot(bareOrigin);
  const rootB = cloneRoot(bareOrigin);
  writeFeedbackEntry(rootA, "fb-double-a", "root A's own record — must survive B's refusal untouched");
  writeFeedbackEntry(rootB, "fb-double-b", "root B's own record — never lands this call");

  const { gh: ghA } = fakeGh("https://github.com/o/r/pull/307");
  const { gh: ghB } = fakeGh("https://github.com/o/r/pull/308");

  // Root A lands FIRST, for real, before root B even starts — so B's initial build already
  // carries A's record forward. Every `push` attempt B makes is then rejected outright (a THIRD
  // writer permanently squeezing in on every attempt), so B must refuse rather than ever landing
  // a tree built against a tip it can no longer prove is current.
  const aResult = withLiveWritesAllowed(() => landFeedback(rootA, { gh: ghA }));
  assert.equal(aResult.landed, true);
  const headBeforeB = execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", `refs/heads/${LANDING_BRANCH}`], {
    encoding: "utf8",
  }).trim();

  const alwaysStaleLeaseGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
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
  assert.match(bResult.error ?? "", /refused to force-replace/i, "the reason is surfaced via `error`, never swallowed");

  const headAfterB = execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", `refs/heads/${LANDING_BRANCH}`], {
    encoding: "utf8",
  }).trim();
  assert.equal(headAfterB, headBeforeB, "a refused call must never move the branch — root A's content is untouched");
});

// ── acceptance: auto-merge is never armed on an unreadable (so possibly incomplete) union ──

test("auto-merge is NOT armed when this call cannot determine whether the head is the complete pending union — surfaced via `error`, no `pr create`/`pr merge` call", () => {
  const bareOrigin = makeBareOrigin();
  const rootA = cloneRoot(bareOrigin);
  const rootB = cloneRoot(bareOrigin);
  writeFeedbackEntry(rootA, "fb-unreadable-a", "root A's own record — already landed and armed");
  writeFeedbackEntry(rootB, "fb-unreadable-b", "root B's own record — cannot even prove the union is complete");

  const { gh: ghA, createCount: createCountA, mergeCount: mergeCountA } = fakeGh("https://github.com/o/r/pull/309");
  const { gh: ghB, createCount: createCountB, mergeCount: mergeCountB } = fakeGh("https://github.com/o/r/pull/310");

  const aResult = withLiveWritesAllowed(() => landFeedback(rootA, { gh: ghA }));
  assert.equal(aResult.landed, true);
  assert.equal(createCountA(), 1);
  assert.equal(mergeCountA(), 1, "sanity: root A's own PR was armed, exactly as before this task");

  // The branch now genuinely exists (root A pushed it), so `rev-parse origin/<branch>` succeeds —
  // but the FOLLOW-UP `ls-tree` read of its pending content fails unexpectedly. This must NOT
  // collapse into "assume nothing pending" (that WOULD silently drop root A's record); it must
  // refuse the whole call instead, so auto-merge is never armed over an unproven union.
  const unreadableLsTreeGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "ls-tree") {
      throw new Error("simulated: transient read failure, NOT 'branch does not exist'");
    }
    return execFileSync("git", ["-C", rootB, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ?? process.env,
    });
  };

  const bResult = withLiveWritesAllowed(() => landFeedback(rootB, { gh: ghB, git: unreadableLsTreeGit }));
  assert.equal(bResult.landed, false, "an unreadable pending-union read must refuse the landing, not push a possibly-incomplete tree");
  assert.match(bResult.error ?? "", /cannot read/i, "the reason is surfaced via `error`, never swallowed into an empty union");
  assert.equal(createCountB(), 0, "no PR was ever created off an unproven union");
  assert.equal(mergeCountB(), 0, "auto-merge was never armed off an unproven union");
});

// ── acceptance: an already-open PR is still a one-call no-op, never re-armed ────────────────

test("a second root's disjoint batch reuses the SAME already-open PR — still a one-call no-op, never a second `pr create`/`pr merge`", () => {
  const bareOrigin = makeBareOrigin();
  const rootA = cloneRoot(bareOrigin);
  const rootB = cloneRoot(bareOrigin);
  writeFeedbackEntry(rootA, "fb-reuse-a", "root A's own record");
  writeFeedbackEntry(rootB, "fb-reuse-b", "root B's own record");

  // ONE shared fake `gh` — both roots' calls are cumulative on the SAME PR, the real-world shape:
  // one shared landing branch, one shared PR, whichever owner's call happens to create it first.
  const { gh, createCount, mergeCount } = fakeGh("https://github.com/o/r/pull/311");

  const a = withLiveWritesAllowed(() => landFeedback(rootA, { gh }));
  assert.equal(a.landed, true);
  assert.equal(createCount(), 1);
  assert.equal(mergeCount(), 1);

  // The PR from A's call is still open (nothing merged it). B's disjoint batch pushes new
  // content — the branch DOES move — but the PR itself is reused, never re-created or re-armed.
  const b = withLiveWritesAllowed(() => landFeedback(rootB, { gh }));
  assert.equal(b.landed, true);
  assert.equal(createCount(), 1, "still only ONE `pr create` across both roots' calls");
  assert.equal(mergeCount(), 1, "still only ONE `pr merge` — never re-armed on a later, unrelated root's push");

  const tree = landingTree(bareOrigin);
  assert.match(tree, /fb-reuse-a\.yaml/);
  assert.match(tree, /fb-reuse-b\.yaml/);
});

// ── acceptance: unchanged content still pushes nothing — the #1113 short-circuit survives ──

test("unchanged content still pushes nothing — the tree-compare short-circuit that stopped the #1113 racing CI cancellations survives the union rewrite", () => {
  const bareOrigin = makeBareOrigin();
  const rootA = cloneRoot(bareOrigin);
  const rootB = cloneRoot(bareOrigin);
  writeFeedbackEntry(rootA, "fb-quiet-a", "root A's own record");
  writeFeedbackEntry(rootB, "fb-quiet-b", "root B's own record");

  const { gh: ghA } = fakeGh("https://github.com/o/r/pull/312");
  const { gh: ghB, createCount: createCountB } = fakeGh("https://github.com/o/r/pull/313");

  withLiveWritesAllowed(() => landFeedback(rootA, { gh: ghA }));
  const first = withLiveWritesAllowed(() => landFeedback(rootB, { gh: ghB }));
  assert.equal(first.landed, true);
  assert.equal(createCountB(), 1);
  const headAfterFirst = execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", `refs/heads/${LANDING_BRANCH}`], {
    encoding: "utf8",
  }).trim();

  // Root B polls again with nothing new on its own disk and nothing new from root A either —
  // the union it (re)computes is byte-identical to what's already on the branch.
  const second = withLiveWritesAllowed(() => landFeedback(rootB, { gh: ghB }));
  assert.equal(second.landed, true, "the content IS on the branch — still reported as landed");
  const headAfterSecond = execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", `refs/heads/${LANDING_BRANCH}`], {
    encoding: "utf8",
  }).trim();
  assert.equal(headAfterSecond, headAfterFirst, "a quiet pass must never move the branch head — that churn is what made #1113 unmergeable");
  assert.equal(createCountB(), 1, "and no second PR was opened for a no-op pass");
});
