import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { appendTaskTrailerToCommit } from "../src/run-task.js";
import { commitMessageContractLines } from "../src/lib/compaction.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitPushRunBranch } from "../src/lib/git-push.js";

// W1-T1012: THE MERGE-CREDIT TRAILER IS WRITTEN TO THE PR BODY AND NEVER TO THE COMMIT, SO THE
// SQUASH DISCARDS IT. `gh pr merge --squash` runs with no `--subject`/`--body` at every call
// site (run-task.ts, worker.ts, feedback-landing.ts), so GitHub composes the squashed commit
// from the branch's own commits and throws the PR body away — measured at 39efeddb: 373 of 538
// trailered merges (69%) carry the trailer in the body and not in the commit. The fix is at the
// write: `appendTaskTrailerToCommit` (run-task.ts) amends the worktree's actual last commit —
// the SAME commit `lastCommitSubject` already reads at the `ghPrCreateFillCommand` call sites —
// so the trailer is part of the record the squash keeps, by construction.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function makeRepoWithCommit(message: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-trailer-commit-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { encoding: "utf8", env });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", message);
  return dir;
}

function headSha(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function headMessage(dir: string): string {
  return execFileSync("git", ["-C", dir, "log", "-1", "--format=%B"], { encoding: "utf8" });
}

// ── the no-op guard: nothing of this run's own must never be amended ────────────────────

test("W1-T1012: a branch with no commits of its own is never amended", () => {
  // THE REGRESSION THIS PINS. `--amend` rewrites the tip sha, so amending a commit the branch
  // merely INHERITED from origin/main leaves it 1 commit ahead of a base it is identical to.
  // Both call sites gate on exactly that count -- `retroCommand`'s W1-T64 no-op guard and
  // `runTask`'s implement no-op guard -- so the amend fabricated the very commit the guard
  // exists to find absent. MEASURED before the fix: test/retro-marker-atomic.test.ts's "the
  // Architect commits NOTHING" case failed with `a no-op retro (nothing committed) must NEVER
  // advance the marker`.
  const dir = makeRepoWithCommit("chore: a commit that came from the base, not from this run");
  execFileSync("git", ["-C", dir, "update-ref", "refs/remotes/origin/main", "HEAD"], { encoding: "utf8" });
  const before = headSha(dir);
  const changed = appendTaskTrailerToCommit(dir, "W1-T1012");
  assert.equal(changed, false, "a branch level with origin/main has nothing of its own to trailer");
  assert.equal(headSha(dir), before, "the tip must not move -- moving it is what fabricates the commit");
  assert.doesNotMatch(headMessage(dir), /Remudero-Task:/, "no trailer may be written onto an inherited commit");
});

test("W1-T1012: an UNREADABLE base fails OPEN and still trailers", () => {
  // `commitsAhead` returns 0 both for "no commits ahead" and for "the base ref could not be
  // read", so reusing it would let an ABSENT origin/main silently suppress the trailer. The
  // guard verifies the base first and falls through when there is none -- the fixtures in this
  // very file are `git init` repos with no origin/main, which is why this direction is pinned.
  const dir = makeRepoWithCommit("feat(x): real work on a repo with no origin/main at all");
  const before = headSha(dir);
  assert.equal(appendTaskTrailerToCommit(dir, "W1-T1012"), true, "no readable base must not suppress the trailer");
  assert.notEqual(headSha(dir), before);
  assert.match(headMessage(dir), /^Remudero-Task:\s*W1-T1012\s*$/m);
});

// ── acceptance 1: an implementation run's final commit carries the trailer before the PR opens ──

test("W1-T1012: an implementation run commits the task trailer before the pr opens", () => {
  // THE MECHANISM: a worker's final commit, with no trailer of its own, gets one appended.
  const dir = makeRepoWithCommit("feat(serve): add fuzzy search to the board");
  const before = headSha(dir);
  const changed = appendTaskTrailerToCommit(dir, "W1-T1012");
  assert.equal(changed, true, "a commit with no trailer must be amended");
  assert.notEqual(headSha(dir), before, "the amend must actually move the tip — this IS the write");
  assert.match(
    headMessage(dir),
    /^Remudero-Task:\s*W1-T1012\s*$/m,
    "the amended commit must carry the anchored trailer",
  );
  // The subject the PR title/`ghPrCreateFillCommand` reads is untouched by the trailer append.
  assert.match(headMessage(dir), /^feat\(serve\): add fuzzy search to the board/);

  // THE ORDERING: the amend must be wired in BEFORE `ghPrCreateFillCommand` is ever built at
  // both non-filing call sites — read straight from the source rather than re-asserted, so a
  // future reorder that moves the amend AFTER PR creation fails this test too.
  const src = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
  const trailerCallSites = [...src.matchAll(/appendTaskTrailerToCommit\(worktreePath,\s*(\w+)\)/g)];
  assert.equal(trailerCallSites.length, 2, "exactly the implement and retro call sites append the commit trailer");
  for (const call of trailerCallSites) {
    const afterCall = src.slice(call.index ?? 0, (call.index ?? 0) + 2000);
    const nextPrCreate = afterCall.indexOf("ghPrCreateFillCommand(worktreePath");
    assert.ok(nextPrCreate > 0, "a `ghPrCreateFillCommand` build must follow the trailer append, not precede it");
  }
});

test("W1-T1012: appendTaskTrailerToCommit force-pushes through the SAME guarded leaf every other push uses", () => {
  // The amend rewrites the tip sha; the branch is (by the time either call site reaches this
  // point) already on origin, so re-landing the amended commit needs a force push. This must
  // route through gitPushRunBranch's single choke point (src/lib/git-push.ts) — never a second,
  // unguarded `execFileSync("git", [..., "push", ...])` — so it inherits the SAME live-write
  // guard every other push in this codebase does.
  const seen: string[][] = [];
  const rec = (_f: string, args: string[]) => {
    seen.push(args);
  };
  withLiveWritesAllowed(() => gitPushRunBranch("/tmp/wt", { force: true, exec: rec }));
  assert.deepEqual(seen[0], ["-C", "/tmp/wt", "push", "--force", "origin", "HEAD"]);
});

// ── acceptance 2: a plan filing run's commit is left with no task trailer ──

test("W1-T1012: a plan filing run commits no task trailer", () => {
  // The plan-filing lanes (triage, plan) open their PR via the SAME `ghPrCreateFillCommand`
  // builder but pass `commitMessage.split("\n")[0]` straight through rather than
  // `lastCommitSubject(worktreePath)` — the structural marker that keeps them out of
  // `appendTaskTrailerToCommit`'s path. Read straight from source: neither filing call site's
  // preceding region ever calls the trailer-append.
  const src = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
  const filingCallSites = [...src.matchAll(/ghPrCreateFillCommand\(worktreePath,\s*owner,\s*repo,\s*branch,\s*commitMessage\.split\("\\n"\)\[0\]\)/g)];
  assert.equal(filingCallSites.length, 2, "expected exactly the triage and plan filing PR-create call sites");
  for (const site of filingCallSites) {
    const before = src.slice(Math.max(0, (site.index ?? 0) - 600), site.index ?? 0);
    assert.doesNotMatch(
      before,
      /appendTaskTrailerToCommit/,
      "a plan-filing PR-create call site must never append the commit trailer",
    );
  }
});

// ── acceptance 3: a commit that already carries the trailer is not given a second one ──

test("W1-T1012: a commit that already carries the trailer is left alone", () => {
  const dir = makeRepoWithCommit("fix(review): repair the acceptance parser\n\nRemudero-Task: W1-T1012\n");
  const before = headSha(dir);
  const beforeMessage = headMessage(dir);
  const changed = appendTaskTrailerToCommit(dir, "W1-T1012");
  assert.equal(changed, false, "an already-trailered commit must not be amended");
  assert.equal(headSha(dir), before, "the tip sha must not move — no amend happened");
  assert.equal(headMessage(dir), beforeMessage, "the message must be byte-identical — no second trailer appended");
  assert.equal(
    [...headMessage(dir).matchAll(/^Remudero-Task:\s*W1-T1012\s*$/gm)].length,
    1,
    "exactly one trailer line — never doubled",
  );
});

test("W1-T1012: a commit trailered for a DIFFERENT task still gets THIS task's trailer appended", () => {
  // The idempotency check is anchored to the SPECIFIC task id being credited, not to "any
  // trailer" — a stray/wrong id must never suppress the correct one.
  const dir = makeRepoWithCommit("chore(plan): unrelated\n\nRemudero-Task: W1-T999\n");
  const changed = appendTaskTrailerToCommit(dir, "W1-T1012");
  assert.equal(changed, true);
  assert.match(headMessage(dir), /^Remudero-Task:\s*W1-T1012\s*$/m);
});

// ── acceptance 4: the worker contract names the commit and not only the PR body as the trailer's home ──

test("W1-T1012: the worker contract names the commit as the trailer home", () => {
  const text = commitMessageContractLines().join("\n");
  assert.match(text, /Remudero-Task/, "the commit-message contract must name the trailer");
  assert.match(
    text,
    /trailer belongs on THIS COMMIT/i,
    "must say the COMMIT — not only the PR body — is the trailer's home",
  );
  assert.match(
    text,
    /discards the PR body/i,
    "must say WHY: the squash keeps the commit and discards the body",
  );
});

// ── acceptance 5 (doc-shaped, grep-proved directly by the plan record itself) ──

test("grep: the squash keeps the commit and discards the body in plan/tasks.d/W1-T1012-trailer-never-reaches-the-commit.yaml", () => {
  const yaml = readFileSync(
    join(REPO_ROOT, "plan/tasks.d/W1-T1012-trailer-never-reaches-the-commit.yaml"),
    "utf8",
  );
  assert.match(yaml, /the squash keeps the commit and discards the body/);
});

// ── the best-effort contract: a git failure returns false rather than throwing ──────────

test("W1-T1012: a repo with NO commit to amend returns false rather than throwing", () => {
  // THE CATCH ARM IN ITS OWN RIGHT. The function's stated contract is best-effort — it
  // "returns `false` on any git failure (no commit to read/amend) rather than throwing, the
  // same best-effort contract `lastCommitSubject` already keeps at this exact call site — a
  // trailer nuance must never crash an otherwise-successful run." That arm is only reachable
  // when `git log -1` (or the `--amend` behind it) actually fails, which every other fixture
  // here is built to avoid, so without this case the arm is dead code at the gate and the
  // contract is asserted only in prose. A freshly-initialised repo with no commit at all is
  // the deterministic shape: `git log -1` exits non-zero with "does not have any commits yet".
  const dir = mkdtempSync(join(tmpdir(), "rmd-trailer-empty-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { encoding: "utf8" });

  // PRECONDITION, so a false below is the catch arm and not a vacuous pass: the fixture really
  // does make `git log -1` fail, and it is NOT short-circuited by the no-op guard above — that
  // guard only returns early when `origin/main` RESOLVES, and this repo has no such ref.
  assert.throws(
    () => execFileSync("git", ["-C", dir, "log", "-1", "--format=%B"], { stdio: "pipe" }),
    "fixture precondition: git log must fail in a repo with no commits",
  );
  assert.throws(
    () => execFileSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", "origin/main"], { stdio: "pipe" }),
    "fixture precondition: origin/main must be absent, so the no-op guard falls through",
  );

  assert.equal(
    appendTaskTrailerToCommit(dir, "W1-T1012"),
    false,
    "an unamendable repo must return false, never throw",
  );
});
