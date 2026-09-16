import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  commitWorkerEdits,
  pathIsUnderDeclaredSurface,
  workerChangedPaths,
} from "../src/run-task.js";

// W1-T3696 A1. The worker edits; the HARNESS commits. This is the one verb missing beside the
// existing CAS-guarded push, and it is what lets an implement lane be bounded without Bash --
// removing forge authority from every worker rather than granting it to a cheap one.

function fakeGit(status: string) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "status") return status;
    if (args[0] === "rev-parse") return "cafebabe000000000000000000000000000000ff\n";
    return "";
  };
  return { run, calls };
}

const Z = (...entries: string[]) => entries.map((e) => `${e}\0`).join("");

test("W1-T3696: the harness stages ONLY the task's declared files and commits them", () => {
  const { run, calls } = fakeGit(Z("M  src/lib/a.ts", "A  test/a.test.ts"));
  const result = commitWorkerEdits("/w", ["src/lib/a.ts", "test/a.test.ts"], "feat: a", { runGit: run });

  assert.equal(result.committed, true);
  assert.equal(result.sha, "cafebabe000000000000000000000000000000ff");
  assert.deepEqual(result.undeclared, []);
  const add = calls.find((c) => c[0] === "add")!;
  assert.deepEqual(add, ["add", "-A", "--", "src/lib/a.ts", "test/a.test.ts"], "explicit paths, never a bare add -A");
  assert.deepEqual(calls.find((c) => c[0] === "commit"), ["commit", "-m", "feat: a"]);
});

test("W1-T3696: a change OUTSIDE the declared surface is reported and left uncommitted", () => {
  const { run, calls } = fakeGit(Z("M  src/lib/a.ts", "M  src/lib/secrets.ts"));
  const result = commitWorkerEdits("/w", ["src/lib/a.ts"], "feat: a", { runGit: run });

  assert.equal(result.committed, true);
  assert.deepEqual(result.undeclared, ["src/lib/secrets.ts"], "the caller must be able to escalate it");
  const add = calls.find((c) => c[0] === "add")!;
  assert.ok(!add.includes("src/lib/secrets.ts"), "an undeclared path must never be staged");
});

test("W1-T3696: when EVERY change is undeclared, nothing is committed and the reason says so", () => {
  const { run, calls } = fakeGit(Z("M  somewhere/else.ts"));
  const result = commitWorkerEdits("/w", ["src/lib/a.ts"], "feat: a", { runGit: run });

  assert.equal(result.committed, false);
  assert.match(String(result.reason), /outside its declared files/);
  assert.deepEqual(result.undeclared, ["somewhere/else.ts"]);
  assert.equal(calls.find((c) => c[0] === "commit"), undefined, "no commit is attempted");
});

test("W1-T3696: an empty message REFUSES — a commit with no message is not a fallback", () => {
  const { run, calls } = fakeGit(Z("M  src/lib/a.ts"));
  for (const message of ["", "   ", "\n"]) {
    const result = commitWorkerEdits("/w", ["src/lib/a.ts"], message, { runGit: run });
    assert.equal(result.committed, false);
    assert.match(String(result.reason), /empty message/);
  }
  assert.equal(calls.length, 0, "an empty message must not even read status");
});

test("W1-T3696: a worker that changed nothing produces no empty commit", () => {
  const { run } = fakeGit("");
  const result = commitWorkerEdits("/w", ["src/lib/a.ts"], "feat: a", { runGit: run });
  assert.equal(result.committed, false);
  assert.match(String(result.reason), /changed nothing/);
});

test("W1-T3696: a task declaring no files has no surface to stage, and says so rather than staging everything", () => {
  const { run, calls } = fakeGit(Z("M  src/lib/a.ts"));
  const result = commitWorkerEdits("/w", [], "feat: a", { runGit: run });
  assert.equal(result.committed, false);
  assert.match(String(result.reason), /declares no files/);
  assert.equal(calls.length, 0);
});

test("W1-T3696: a declared DIRECTORY covers its children, and does not cover a sibling with the same prefix", () => {
  // `src/lib` must not admit `src/libel.ts` -- the bug a bare startsWith would ship.
  assert.equal(pathIsUnderDeclaredSurface("src/lib/a.ts", ["src/lib"]), true);
  assert.equal(pathIsUnderDeclaredSurface("src/lib/a.ts", ["src/lib/"]), true);
  assert.equal(pathIsUnderDeclaredSurface("src/libel.ts", ["src/lib"]), false);
  assert.equal(pathIsUnderDeclaredSurface("src/lib/a.ts", ["src/lib/a.ts"]), true);
});

test("W1-T3696: NUL-delimited status keeps a path with a space intact", () => {
  // porcelain's default output QUOTES such a path; -z does not, which is why -z is used.
  assert.deepEqual(workerChangedPaths(Z("M  docs/a file.md", "?? test/b.ts")), ["docs/a file.md", "test/b.ts"]);
});

test("W1-T3696: the message reaches git as ONE argv element, so it cannot become a command", () => {
  const { run, calls } = fakeGit(Z("M  src/lib/a.ts"));
  const hostile = 'feat: a"; rm -rf /; echo "';
  commitWorkerEdits("/w", ["src/lib/a.ts"], hostile, { runGit: run });
  const commit = calls.find((c) => c[0] === "commit")!;
  assert.deepEqual(commit, ["commit", "-m", hostile], "passed whole, never split or interpolated");
});

test("W1-T3696: with NO runGit override, the default seam really shells out to git on a real repo", () => {
  // Every test above injects a fake `runGit`, so the default `deps.runGit ?? execFileSync(...)`
  // arrow is never actually invoked. This one omits `deps` entirely, driving the real seam
  // end-to-end against a throwaway repo -- the only way to cover the real git invocation itself.
  const repoDir = mkdtempSync(join(tmpdir(), "rmd-harness-commit-real-"));
  try {
    execFileSync("git", ["-C", repoDir, "init", "--quiet", "--initial-branch", "main"]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "probe@example.invalid"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "probe"]);
    writeFileSync(join(repoDir, "seed.txt"), "seed\n");
    execFileSync("git", ["-C", repoDir, "add", "-A"]);
    execFileSync("git", ["-C", repoDir, "commit", "--no-verify", "--quiet", "-m", "chore: seed"]);

    writeFileSync(join(repoDir, "a.ts"), "export const a = 1;\n");
    const result = commitWorkerEdits(repoDir, ["a.ts"], "feat: a real worker edit");

    assert.equal(result.committed, true);
    assert.deepEqual(result.undeclared, []);
    const headSha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(result.sha, headSha, "the reported sha is the REAL new HEAD, read back independently");
    const log = execFileSync("git", ["-C", repoDir, "log", "-1", "--pretty=%s"], { encoding: "utf8" }).trim();
    assert.equal(log, "feat: a real worker edit");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
