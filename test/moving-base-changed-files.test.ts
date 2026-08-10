import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeChangedFiles } from "../src/run-task.js";

/**
 * "DON'T MERGE WHILE A DRAIN RUNS" WAS NEVER A RULE — IT WAS A MOVING BASE.
 *
 * #1535 fixed `scopeGuardOutOfScopeFiles` (two-dot → three-dot). This file covers the THIRD form of
 * the same defect: `worktreeChangedFiles` ran `git diff --name-only origin/main`, a BARE ref, which
 * compares the current TIP to the working tree. The moment `origin/main` moves, every file the
 * incoming commits touched reads as though this worktree had changed it.
 *
 * IT IS NOT ABOUT HUMAN TIMING. A git worktree shares refs with its parent clone, so any fetch
 * anywhere moves `origin/main` for every worktree at once — and `refreshOriginMain`
 * (`src/lib/ci-parity.ts`) runs `git fetch origin main` INSIDE the worker's own
 * `preflight --ci-parity`. The fleet moves the ref on itself.
 *
 * THE CONSEQUENCE IS AN `action: "error"`, not a cosmetic line. `decideTriage` (`src/lib/triage.ts`)
 * errors on any changed file outside `plan/`, and `decidePlanArchitect` (`src/lib/plan-architect.ts`)
 * errors a CLEAR verdict the moment `changedFiles` is non-empty — so a correct "I changed nothing"
 * became a failed run as soon as anything landed.
 */

/** A throwaway origin + clone + worktree. The origin ADVANCES mid-test — without that, a fixture
 *  proves nothing about this class, because a base that never moves can never be stale. */
function fixture(): { work: string; wt: string; advanceOrigin: (file: string) => void; fetch: () => void } {
  const root = mkdtempSync(join(tmpdir(), "moving-base-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const wt = join(root, "wt");
  const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  git(work, ["config", "user.email", "t@example.com"]);
  git(work, ["config", "user.name", "t"]);
  writeFileSync(join(work, "shared.ts"), "base\n");
  writeFileSync(join(work, "mine.ts"), "base\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-qm", "base"]);
  git(work, ["push", "-q", "origin", "HEAD:main"]);
  git(work, ["fetch", "-q", "origin"]);
  // The worktree is cut from the FRESHLY-FETCHED origin/main, exactly as `worktreeAdd` does.
  git(work, ["worktree", "add", "-q", wt, "origin/main", "--detach"]);

  return {
    work,
    wt,
    // SOMEONE ELSE'S MERGE, THROUGH A SEPARATE CLONE — and that separation is load-bearing, not
    // tidiness. `git push` updates the pusher's OWN `refs/remotes/origin/main` as a side effect, so
    // landing the commit from `work` would move `work`'s ref without any fetch and the fixture
    // would stop modelling the real sequence (a merge on GitHub, then a fetch here). MEASURED: the
    // first draft did exactly that and its own precondition assertion caught it.
    advanceOrigin: (file: string) => {
      const other = join(root, `other-${file.replace(/\W/g, "")}`);
      execFileSync("git", ["clone", "-q", origin, other]);
      git(other, ["config", "user.email", "o@example.com"]);
      git(other, ["config", "user.name", "o"]);
      // The clone's default HEAD is an UNBORN branch (the bare repo was `git init`ed with whatever
      // init.defaultBranch is), so committing straight away builds a root commit unrelated to
      // `main` and the push is rejected non-fast-forward. Land ON main explicitly.
      git(other, ["checkout", "-q", "-B", "main", "origin/main"]);
      writeFileSync(join(other, file), "landed by someone else's PR\n");
      git(other, ["add", "-A"]);
      git(other, ["commit", "-qm", `land ${file}`]);
      git(other, ["push", "-q", "origin", "HEAD:main"]);
    },
    // A fetch in the PARENT clone — a worktree shares refs, so this moves origin/main for the
    // worktree too. This is what `refreshOriginMain` does from inside the worker's own preflight.
    fetch: () => void git(work, ["fetch", "-q", "origin"]),
  };
}

test("FIXTURE PRECONDITION: the base really moves — origin/main differs in the worktree before and after the fetch", () => {
  const f = fixture();
  const at = () => execFileSync("git", ["-C", f.wt, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
  const before = at();
  f.advanceOrigin("shared.ts");
  assert.equal(at(), before, "pushing alone must NOT move the local ref — only a fetch does");
  f.fetch();
  assert.notEqual(at(), before, "REACHED THE CONDITION: origin/main moved inside the worktree, via the PARENT's fetch");
});

test("a worker's own edit is reported when the base has NOT moved — the check still detects real work", () => {
  const f = fixture();
  writeFileSync(join(f.wt, "mine.ts"), "worker edit\n");
  assert.deepEqual(worktreeChangedFiles(f.wt), ["mine.ts"], "the honest case must keep working");
});

test("a file landed by SOMEONE ELSE's merge is NOT reported as changed by this worktree", () => {
  const f = fixture();
  writeFileSync(join(f.wt, "mine.ts"), "worker edit\n");
  f.advanceOrigin("shared.ts");
  f.fetch();

  // THE LOAD-BEARING ASSERTION. With the bare `origin/main` this returns ["mine.ts","shared.ts"] —
  // and `decideTriage` then errors with "triage worker touched non-plan file(s): shared.ts",
  // naming a file the run never opened.
  assert.deepEqual(
    worktreeChangedFiles(f.wt),
    ["mine.ts"],
    "only the worktree's OWN change may appear; shared.ts came from a merge, not from this worker",
  );
});

test("a worktree that changed NOTHING reports nothing, even after a merge lands — the CLEAR verdict case", () => {
  const f = fixture();
  f.advanceOrigin("shared.ts");
  f.fetch();

  // `decidePlanArchitect` errors a CLEAR verdict when `changedFiles` is non-empty. Under the bare
  // ref this list was ["shared.ts"], so a correct "I changed nothing" became a failed run the
  // moment ANY PR landed — the sharpest form of the defect.
  assert.deepEqual(worktreeChangedFiles(f.wt), [], "a run that changed nothing must still say nothing");
});

test("a worker's COMMITTED work is still reported — the base is the merge base, not HEAD", () => {
  const f = fixture();
  const git = (args: string[]) => execFileSync("git", ["-C", f.wt, ...args], { encoding: "utf8" });
  git(["config", "user.email", "w@example.com"]);
  git(["config", "user.name", "w"]);
  writeFileSync(join(f.wt, "mine.ts"), "worker edit\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "the worker's own commit"]);
  f.advanceOrigin("shared.ts");
  f.fetch();

  // THIS TEST DISCRIMINATES ALL THREE CANDIDATE BASES, which is why it exists — the other cases
  // cannot, because a worktree that never commits has merge-base(origin/main, HEAD) === HEAD:
  //   bare `origin/main` -> ["mine.ts", "shared.ts"]  (the shipped defect: a phantom)
  //   `HEAD`             -> []                        (silently loses the worker's own work)
  //   the merge base     -> ["mine.ts"]               (correct)
  // MEASURED: with only the non-committing cases, a mutant swapping the merge base for HEAD left
  // every assertion in this file GREEN.
  assert.deepEqual(worktreeChangedFiles(f.wt), ["mine.ts"], "committed work must survive, and only it");
});

test("untracked files are still counted, so the merge-base swap did not narrow what is detected", () => {
  const f = fixture();
  writeFileSync(join(f.wt, "brand-new.ts"), "untracked\n");
  f.advanceOrigin("shared.ts");
  f.fetch();
  assert.deepEqual(
    worktreeChangedFiles(f.wt),
    ["brand-new.ts"],
    "the ls-files half is unchanged — this fix touches the diff base only",
  );
});
