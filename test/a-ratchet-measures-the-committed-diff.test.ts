import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

// W1-T3085: the comment-load ratchet measures the COMMITTED diff (`<base>...HEAD`), so an edit still
// in the working tree is not what it judged. The refusal must say so for a refused path that is dirty,
// and must print nothing extra otherwise. Fixtures are throwaway repos under mkdtemp (never the tracked
// tree); the identity is pinned because a CI runner has none (#1971).

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "comment-load-ratchet.mjs");
const { main, uncommittedAmong, MAX_ADDED_BLOCK_LINES } = (await import(pathToFileURL(SCRIPT).href)) as {
  main: (argv: string[]) => number;
  uncommittedAmong: (root: string, paths: string[]) => string[];
  MAX_ADDED_BLOCK_LINES: number;
};

const BIG_BLOCK = `${Array.from({ length: MAX_ADDED_BLOCK_LINES + 5 }, (_, i) => `// line ${i}`).join("\n")}\nconst a = 1;\n`;
// The author's fix: the same prose split by a code line, so no single block is oversized.
const SPLIT = BIG_BLOCK.replace("// line 15\n", "// line 15\nconst b = 2;\n");

/** `main` has `src/a.ts` and an unrelated `src/other.ts`; branch `work` COMMITS BIG_BLOCK. */
function fixtureWithOversizedCommit(): GitRepo {
  const repo = gitRepo({ seedCommit: false, kind: "comment-load-uncommitted" });
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  mkdirSync(join(repo.dir, "scripts"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "a.ts"), "const a = 0;\n");
  writeFileSync(join(repo.dir, "src", "other.ts"), "const o = 0;\n");
  writeFileSync(join(repo.dir, "scripts", "comment-load-baseline.json"), "{}\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "base");
  repo.git("checkout", "-qb", "work");
  writeFileSync(join(repo.dir, "src", "a.ts"), BIG_BLOCK);
  repo.git("commit", "-qam", "work");
  return repo;
}

function runInProcess(repo: GitRepo): { code: number; err: string } {
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = () => undefined;
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    return { code: main(["--root", repo.dir, "--base", "main"]), err: err.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

test("an uncommitted edit to a refused path is named, with the range that was measured", () => {
  const repo = fixtureWithOversizedCommit();
  try {
    writeFileSync(join(repo.dir, "src", "a.ts"), SPLIT);
    const base = repo.git("merge-base", "main", "HEAD");
    const { code, err } = runInProcess(repo);
    assert.equal(code, 1, "the verdict is still the refusal: the fix is not committed, so it was not measured");
    assert.match(err, /BLOCKED -- 1 added comment block/);
    assert.match(err, /NOTE: uncommitted edit\(s\) in src\/a\.ts were NOT measured/);
    assert.ok(err.includes(`${base}...HEAD`), "the note names the actual base sha and range");
  } finally {
    repo.cleanup();
  }
});

test("a clean tree prints no note, and an unrelated dirty file is never swept in", () => {
  const repo = fixtureWithOversizedCommit();
  try {
    const clean = runInProcess(repo);
    assert.equal(clean.code, 1);
    assert.match(clean.err, /BLOCKED -- 1 added comment block/);
    assert.doesNotMatch(clean.err, /NOTE|uncommitted/);

    writeFileSync(join(repo.dir, "src", "other.ts"), "const o = 1;\n");
    const unrelated = runInProcess(repo);
    assert.equal(unrelated.err, clean.err, "a dirty path the refusal did not name changes nothing");
  } finally {
    repo.cleanup();
  }
});

test("a committed fix passes and prints nothing", () => {
  const repo = fixtureWithOversizedCommit();
  try {
    writeFileSync(join(repo.dir, "src", "a.ts"), SPLIT);
    repo.git("commit", "-qam", "split");
    const { code, err } = runInProcess(repo);
    assert.equal(code, 0);
    assert.equal(err, "");
  } finally {
    repo.cleanup();
  }
});

test("uncommittedAmong: an empty path list answers [] on a dirty tree, and a git failure answers []", () => {
  const repo = fixtureWithOversizedCommit();
  try {
    writeFileSync(join(repo.dir, "src", "other.ts"), "const o = 1;\n");
    // `git status --porcelain --` with no pathspec lists the WHOLE tree; the guard must not.
    assert.deepEqual(uncommittedAmong(repo.dir, []), []);
    assert.deepEqual(uncommittedAmong(repo.dir, ["src/a.ts"]), []);
    assert.deepEqual(uncommittedAmong(repo.dir, ["src/a.ts", "src/other.ts"]), ["src/other.ts"]);
  } finally {
    repo.cleanup();
  }
  // A spawn that cannot even start (no such cwd) is the same collapse: no note, never a throw.
  assert.deepEqual(uncommittedAmong(join(tmpdir(), "rmd-no-such-dir-W1-T3085"), ["src/a.ts"]), []);
});
