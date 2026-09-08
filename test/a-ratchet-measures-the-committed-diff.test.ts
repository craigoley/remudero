import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "comment-load-ratchet.mjs");

/**
 * test/a-ratchet-measures-the-committed-diff.test.ts — W1-T3085.
 *
 * The ratchet reads `<base>...HEAD`, so an edit in the working tree is not measured. The failure is
 * quiet and expensive: an author reads the refusal, fixes the file, re-runs, and gets the IDENTICAL
 * verdict. MEASURED 2026-09-07 — twice in one session, each resolved only by `git commit --amend`.
 *
 * `scripts/**` sits outside tsconfig's `include`, so the module is reached through a runtime import
 * rather than a static one — the same reason its siblings do.
 */
const { uncommittedAmong, reportUncommitted } = (await import(pathToFileURL(SCRIPT).href)) as {
  uncommittedAmong: (root: string, paths: string[]) => string[];
  reportUncommitted: (dirty: string[], base: string) => void;
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

/** A real repo, never a mock of git's own output. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}committed-diff-`));
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "config", "user.email", "t@t.invalid");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

function captureStderr(fn: () => void): string[] {
  const out: string[] = [];
  const real = console.error;
  console.error = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    console.error = real;
  }
  return out;
}

test("an uncommitted edit to a refused path is NAMED, since it is not what the ratchet measured", () => {
  const dir = fixture();
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  assert.deepEqual(uncommittedAmong(dir, ["a.ts"]), ["a.ts"]);
});

test("a COMMITTED edit is not named — the note must never mislead an author whose fix landed", () => {
  const dir = fixture();
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "second");
  assert.deepEqual(uncommittedAmong(dir, ["a.ts"]), [], "a clean path must produce no note at all");
});

test("only the paths ASKED about are named — an unrelated dirty file is not swept in", () => {
  const dir = fixture();
  writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
  assert.deepEqual(uncommittedAmong(dir, ["a.ts"]), [], "b.ts is dirty but was not among the refused paths");
});

test("an empty path list asks git nothing — a bare `git status` would report the whole tree", () => {
  // Without the early return, `git status --porcelain --` with no pathspec lists every dirty file,
  // so a refusal naming nothing would still print a note about unrelated work.
  const dir = fixture();
  writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
  assert.deepEqual(uncommittedAmong(dir, []), []);
});

test("the note states WHAT was measured, so the remedy is derivable rather than guessed", () => {
  const lines = captureStderr(() => reportUncommitted(["a.ts"], "abc1234"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /COMMITTED diff/);
  assert.match(lines[0], /abc1234\.\.\.HEAD/, "the actual base is named, not a generic phrase");
  assert.match(lines[0], /commit \(or amend\) and re-run/);
});

test("a clean tree prints NOTHING — silence, not a reassuring line", () => {
  assert.deepEqual(captureStderr(() => reportUncommitted([], "abc1234")), []);
});
