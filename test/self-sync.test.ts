import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkCliFreshness, SELF_SYNC_GUARD_ENV, type GitRunner } from "../src/lib/self-sync.js";

// ── W1-T79: CLI self-freshness at entry (the #138 incident shape — the runner correct on
// main, but the OPERATOR'S invocation was a stale checkout that predated the merge). Real,
// throwaway git repos (no mocking of git itself), same style as test/run-task.test.ts's
// gitFixture() for the sibling W1-T60 plan-freshness tests — only say/warn/reexec are
// injected spies, so every assertion below exercises ACTUAL git plumbing (fetch, rev-parse,
// status --porcelain, merge-base --is-ancestor, merge --ff-only).

function planYaml(title: string): string {
  return `- id: T1\n  title: "${title}"\n  repo: remudero\n  type: implement\n`;
}

/** A tiny real "origin" repo + a real clone of it. Mirrors test/run-task.test.ts's gitFixture(). */
function gitFixture(): { originDir: string; localDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-self-sync-"));
  const originDir = join(root, "origin");
  const localDir = join(root, "local");
  mkdirSync(join(originDir, "plan"), { recursive: true });
  const git = (dir: string, args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(originDir, ["init", "--quiet", "-b", "main"]);
  git(originDir, ["config", "user.email", "test@example.com"]);
  git(originDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml("origin-title"), "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "init"]);
  execFileSync("git", ["clone", "--quiet", originDir, localDir], { encoding: "utf8" });
  git(localDir, ["config", "user.email", "test@example.com"]);
  git(localDir, ["config", "user.name", "Test"]);
  return { originDir, localDir };
}

function publishNewCommit(originDir: string, title: string): void {
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml(title), "utf8");
  execFileSync("git", ["add", "."], { cwd: originDir });
  execFileSync("git", ["commit", "--quiet", "-m", title], { cwd: originDir });
}

function headSha(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** Recording spies for say/warn/reexec, plus a real repoDir-scoped git runner (default deps'
 *  own shape) so a test can still assert "git was never called" by wrapping it. */
function spies(localDir: string) {
  const sayCalls: string[] = [];
  const warnCalls: string[] = [];
  let reexecCalls = 0;
  const realGit: GitRunner = (args) => execFileSync("git", ["-C", localDir, ...args], { encoding: "utf8" });
  return {
    sayCalls,
    warnCalls,
    get reexecCalls() {
      return reexecCalls;
    },
    deps: {
      git: realGit,
      say: (msg: string) => sayCalls.push(msg),
      warn: (msg: string) => warnCalls.push(msg),
      reexec: () => {
        reexecCalls += 1;
      },
    },
  };
}

// ── AC1: clean + behind + ff-possible -> ff-pull invoked, re-exec invoked exactly once ──────

test("checkCliFreshness: clean checkout behind origin/main (ff-possible) merges --ff-only, prints the sync line naming both shas, and re-execs exactly once (the #138 incident shape)", () => {
  const { originDir, localDir } = gitFixture();
  const oldSha = headSha(localDir);
  publishNewCommit(originDir, "PUBLISHED");

  const { sayCalls, warnCalls, deps } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "synced");
  const newSha = headSha(localDir);
  assert.notEqual(newSha, oldSha, "local HEAD must have actually advanced (a real ff-merge happened)");
  assert.equal(
    readFileSync(join(localDir, "plan", "tasks.yaml"), "utf8"),
    planYaml("PUBLISHED"),
    "the ff-merge must have actually landed the new content in the working tree",
  );
  assert.equal(sayCalls.length, 1, "exactly one sync line printed");
  assert.match(sayCalls[0], /^### rmd self-sync: /);
  assert.ok(sayCalls[0].includes(oldSha.slice(0, 7)), "sync line names the OLD sha");
  assert.ok(sayCalls[0].includes(newSha.slice(0, 7)), "sync line names the NEW sha");
  assert.equal(warnCalls.length, 0, "no refusal on the happy path");
  if (result.status === "synced") {
    assert.equal(result.oldSha, oldSha);
    assert.equal(result.newSha, newSha);
  }
});

// The re-exec callback itself must be called exactly once — a real caller wires it to spawn
// a fresh process with the loop-guard env set; this proves the CALLING contract, the guard
// env's actual effect is proven separately below (AC4).
test("checkCliFreshness: reexec() is invoked exactly once on a successful sync, never more", () => {
  const { originDir, localDir } = gitFixture();
  publishNewCommit(originDir, "PUBLISHED");
  const { deps } = spies(localDir);
  let calls = 0;
  checkCliFreshness(localDir, {}, { ...deps, reexec: () => (calls += 1) });
  assert.equal(calls, 1);
});

// ── AC2: dirty or diverged -> never mutated, refusal carries the exact remedy ───────────────

test("checkCliFreshness: a DIRTY checkout behind origin/main is never mutated -- refuses with `git pull --ff-only` guidance, non-zero-signaling status, no reexec", () => {
  const { originDir, localDir } = gitFixture();
  const oldSha = headSha(localDir);
  publishNewCommit(originDir, "PUBLISHED");
  // Uncommitted local edit -- dirty working tree.
  writeFileSync(join(localDir, "plan", "tasks.yaml"), planYaml("DIRTY-LOCAL"), "utf8");

  const { sayCalls, warnCalls, deps } = spies(localDir);
  const result = checkCliFreshness(localDir, {}, deps);

  assert.equal(result.status, "refused");
  if (result.status === "refused") {
    assert.equal(result.reason, "dirty");
    assert.match(result.message, /git pull --ff-only/);
  }
  assert.equal(headSha(localDir), oldSha, "HEAD must not move -- no merge attempted on a dirty tree");
  assert.equal(
    readFileSync(join(localDir, "plan", "tasks.yaml"), "utf8"),
    planYaml("DIRTY-LOCAL"),
    "the dirty local edit survives untouched",
  );
  assert.equal(sayCalls.length, 0, "no sync line -- nothing was synced");
  assert.equal(warnCalls.length, 1);
  assert.match(warnCalls[0], /git pull --ff-only/, "stderr guidance carries the exact remedy command");
});

test("checkCliFreshness: a DIVERGED (non-ff) checkout is never mutated -- refuses, no merge attempted, reexec never called", () => {
  const { originDir, localDir } = gitFixture();
  publishNewCommit(originDir, "PUBLISHED-ON-ORIGIN");
  // Local makes its OWN unpublished commit -- clean working tree, but now HEAD is no longer
  // an ancestor of origin/main (both sides have unique commits): a real, non-ff divergence.
  writeFileSync(join(localDir, "plan", "tasks.yaml"), planYaml("LOCAL-ONLY-COMMIT"), "utf8");
  execFileSync("git", ["-C", localDir, "add", "."]);
  execFileSync("git", ["-C", localDir, "commit", "--quiet", "-m", "local work"]);
  const oldSha = headSha(localDir);

  const { sayCalls, warnCalls, deps } = spies(localDir);
  let reexecCalls = 0;
  const result = checkCliFreshness(localDir, {}, { ...deps, reexec: () => (reexecCalls += 1) });

  assert.equal(result.status, "refused");
  if (result.status === "refused") {
    assert.equal(result.reason, "diverged");
    assert.match(result.message, /git pull --ff-only/);
  }
  assert.equal(headSha(localDir), oldSha, "HEAD must not move -- no merge/rebase attempted on divergence");
  assert.equal(sayCalls.length, 0);
  assert.equal(warnCalls.length, 1);
  assert.equal(reexecCalls, 0, "reexec must never be called on a refusal");
});

// ── AC3: up-to-date adds nothing ────────────────────────────────────────────────────────────

test("checkCliFreshness: an up-to-date checkout (fresh clone, HEAD == origin/main) is a total no-op -- no merge, no say, no warn, no reexec", () => {
  const { localDir } = gitFixture(); // a fresh clone's HEAD already equals origin/main
  const before = headSha(localDir);

  const { sayCalls, warnCalls, deps } = spies(localDir);
  let reexecCalls = 0;
  const result = checkCliFreshness(localDir, {}, { ...deps, reexec: () => (reexecCalls += 1) });

  assert.equal(result.status, "up-to-date");
  assert.equal(headSha(localDir), before);
  assert.equal(sayCalls.length, 0);
  assert.equal(warnCalls.length, 0);
  assert.equal(reexecCalls, 0);
});

// ── AC4: the re-exec cannot loop -- the guard env short-circuits the ENTIRE check ───────────

test("checkCliFreshness: the loop-guard env short-circuits the entire check -- zero git calls, not even a fetch", () => {
  const { originDir, localDir } = gitFixture();
  publishNewCommit(originDir, "PUBLISHED"); // would be ff-possible if the check ran at all

  let gitCalls = 0;
  const throwingGit: GitRunner = () => {
    gitCalls += 1;
    throw new Error("git must never be invoked when the loop-guard env is set");
  };
  let sayCalls = 0;
  let warnCalls = 0;
  let reexecCalls = 0;
  const result = checkCliFreshness(
    localDir,
    { [SELF_SYNC_GUARD_ENV]: "1" },
    {
      git: throwingGit,
      say: () => (sayCalls += 1),
      warn: () => (warnCalls += 1),
      reexec: () => (reexecCalls += 1),
    },
  );

  assert.equal(result.status, "guarded");
  assert.equal(gitCalls, 0, "not even a fetch happens when the guard is set");
  assert.equal(sayCalls, 0);
  assert.equal(warnCalls, 0);
  assert.equal(reexecCalls, 0);
});

// ── Degraded path: a fetch failure is a best-effort UX check, not the fail-closed PLAN gate
// (syncPlanOrRefuse) -- it must never block a command over a network hiccup.

test("checkCliFreshness: a fetch failure degrades to 'do not block the command' rather than refusing every invocation", () => {
  const { localDir } = gitFixture();
  execFileSync("git", ["-C", localDir, "remote", "set-url", "origin", "/no/such/path"]);

  const { sayCalls, warnCalls, deps } = spies(localDir);
  let reexecCalls = 0;
  const result = checkCliFreshness(localDir, {}, { ...deps, reexec: () => (reexecCalls += 1) });

  assert.equal(result.status, "degraded");
  assert.equal(sayCalls.length, 0);
  assert.equal(warnCalls.length, 0);
  assert.equal(reexecCalls, 0);
});
