import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// The falsifier suite for scripts/comment-load-ratchet.mjs (docs/comment-standard.md).
//
// The CLI is driven as a SUBPROCESS so every case below is a real exit code, which is what CI
// consumes; the pure functions are reached through a runtime import so the tokenizer is tested
// without a second copy of it. Every fixture is a throwaway git repo under `mkdtemp` — this gate
// reads `git ls-files` and a merge-base diff, so a plain directory cannot exercise it, and writing
// into the tracked tree would be observed by every other worker in the same concurrent run.
//
// TRAP (#1971): `actions/checkout` sets NEITHER a repo nor a global git identity, so a fixture that
// commits fails on every CI runner and passes on every dev machine. `gitEnv` below pins the
// identity and blanks the ambient config, which reproduces the runner exactly.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "comment-load-ratchet.mjs");
const BASELINE = join(REPO_ROOT, "scripts", "comment-load-baseline.json");

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a static import would be a TS7016. A dynamic
// specifier is not statically resolved, so this loads the REAL module with no shadow copy.
const { countCommentLines, evaluateCommentLoadRatchet, findOversizedAddedBlocks, listMeasuredFiles, MAX_ADDED_BLOCK_LINES } =
  (await import(pathToFileURL(SCRIPT).href)) as {
    countCommentLines: (text: string, path: string) => { comments: number; code: number };
    evaluateCommentLoadRatchet: (
      current: Record<string, number>,
      baseline: Record<string, number>,
    ) => {
      ok: boolean;
      violations: Array<{ path: string; comments: number; baseline: number; overage: number }>;
      shrunk: Array<{ path: string; from: number; to: number }>;
      added: Array<{ path: string; comments: number }>;
      removed: string[];
      nextBaseline: Record<string, number>;
    };
    findOversizedAddedBlocks: (
      diff: string,
      isMeasured: (f: string) => boolean,
    ) => Array<{ file: string; startLine: number; lines: number }>;
    listMeasuredFiles: (root: string) => string[];
    MAX_ADDED_BLOCK_LINES: number;
  };

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
}

/** A throwaway repo with `src/a.ts` committed on `main`, plus the caller's baseline JSON. */
function fixtureRepo(baseline: Record<string, number>, aBody: string): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}comment-load-`));
  git(root, ["init", "-b", "main", "-q"]);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), aBody);
  writeFileSync(join(root, "scripts", "comment-load-baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "base"]);
  return root;
}

function run(root: string, args: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, "--base", "main", ...args], {
    cwd: root,
    encoding: "utf8",
    env: gitEnv,
  });
}

/** Commit `body` as `src/a.ts` on a branch cut from `main`, so the run has a real merge base. */
function commitOnBranch(root: string, body: string): void {
  git(root, ["checkout", "-qb", "work"]);
  writeFileSync(join(root, "src", "a.ts"), body);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "work"]);
}

const CLEAN = "const a = 1;\n";

// ── the tokenizer ────────────────────────────────────────────────────────────────────────────

test("the tokenizer counts every comment shape, ignores blank lines, and never counts a shebang", () => {
  const ts = ["// line", "/* open", " * body", " */", "", "const x = 1; // trailing", "code();"].join("\n");
  assert.deepEqual(countCommentLines(ts, "src/a.ts"), { comments: 4, code: 2 });

  const sh = ["#!/usr/bin/env bash", "# a comment", "", "echo hi", "  # indented comment"].join("\n");
  assert.deepEqual(countCommentLines(sh, "bin/rmd"), { comments: 2, code: 2 });

  // A `#` in a C-family file is code (a private field, a preprocessor line), never a comment.
  assert.deepEqual(countCommentLines("#hash\ncode();", "src/a.ts"), { comments: 0, code: 2 });
  // A shebang is exempt only at line 1; a later `#!` line is an ordinary comment.
  assert.deepEqual(countCommentLines("echo hi\n#!not-a-shebang", "deploy/x.sh"), { comments: 1, code: 1 });
  // YAML, TOML and a Dockerfile are hash-comment files by extension/basename alone.
  assert.deepEqual(countCommentLines("# c\njobs:", "ci.yml").comments, 1);
  assert.deepEqual(countCommentLines("# c\nFROM node", "deploy/Dockerfile").comments, 1);
});

// ── the baseline half ────────────────────────────────────────────────────────────────────────

test("evaluate: growth violates, a shrink ratchets down, a new file is recorded, a gone file is dropped", () => {
  const verdict = evaluateCommentLoadRatchet(
    { "src/grew.ts": 12, "src/shrank.ts": 3, "src/new.ts": 5, "src/same.ts": 7 },
    { "src/grew.ts": 10, "src/shrank.ts": 9, "src/same.ts": 7, "src/gone.ts": 4 },
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.violations, [{ path: "src/grew.ts", comments: 12, baseline: 10, overage: 2 }]);
  assert.deepEqual(verdict.shrunk, [{ path: "src/shrank.ts", from: 9, to: 3 }]);
  assert.deepEqual(verdict.added, [{ path: "src/new.ts", comments: 5 }]);
  assert.deepEqual(verdict.removed, ["src/gone.ts"]);
  // A grown file's ceiling is NEVER advanced by the run that found the growth.
  assert.equal(verdict.nextBaseline["src/grew.ts"], 10);
  assert.equal(verdict.nextBaseline["src/shrank.ts"], 3);
});

test("CLI: a file that grew past its ceiling is REFUSED, named, and exits 1", () => {
  const root = fixtureRepo({ "src/a.ts": 1, "scripts/comment-load-baseline.json": 0 }, `// one\n${CLEAN}`);
  try {
    commitOnBranch(root, `// one\n// two\n${CLEAN}`);
    const res = run(root);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /src\/a\.ts: 2 comment lines > ceiling 1 \(\+1\)/);
    assert.match(res.stderr, /docs\/comment-standard\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: a file that shrank has its ceiling REWRITTEN DOWN in the baseline, and the run passes", () => {
  const root = fixtureRepo({ "src/a.ts": 5, "scripts/comment-load-baseline.json": 0 }, `// one\n${CLEAN}`);
  try {
    const res = run(root);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const written = JSON.parse(readFileSync(join(root, "scripts", "comment-load-baseline.json"), "utf8"));
    assert.equal(written["src/a.ts"], 1, "the gain must be held, not left at the old ceiling of 5");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: a baseline that is not a JSON object of non-negative integers exits 2, never OK", () => {
  const root = fixtureRepo({ "src/a.ts": 1 }, CLEAN);
  try {
    writeFileSync(join(root, "scripts", "comment-load-baseline.json"), '{"src/a.ts": "10"}\n');
    const res = run(root);
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stderr, /must carry a non-negative integer comment count/);
    assert.doesNotMatch(res.stdout, /OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the added-block half ─────────────────────────────────────────────────────────────────────

/** A unified diff adding `n` comment lines to `src/a.ts`, in the executor's own shape. */
function addedCommentDiff(n: number): string {
  const body = Array.from({ length: n }, (_, i) => `+// added line ${i}`).join("\n");
  return `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +2,${n} @@\n${body}\n`;
}

test(`an added comment block of exactly ${MAX_ADDED_BLOCK_LINES} lines passes and one line more is refused`, () => {
  const measured = (f: string) => f === "src/a.ts";
  assert.deepEqual(findOversizedAddedBlocks(addedCommentDiff(MAX_ADDED_BLOCK_LINES), measured), []);
  const over = findOversizedAddedBlocks(addedCommentDiff(MAX_ADDED_BLOCK_LINES + 1), measured);
  assert.equal(over.length, 1);
  assert.equal(over[0].lines, MAX_ADDED_BLOCK_LINES + 1);
  assert.equal(over[0].file, "src/a.ts");
});

test("an added run is broken by a code line, and a file outside the measured set is never scanned", () => {
  const half = Math.ceil((MAX_ADDED_BLOCK_LINES + 1) / 2);
  const split = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,0 +2,99 @@",
    ...Array.from({ length: half }, (_, i) => `+// first ${i}`),
    "+code();",
    ...Array.from({ length: half }, (_, i) => `+// second ${i}`),
  ].join("\n");
  assert.deepEqual(findOversizedAddedBlocks(split, () => true), [], "two short runs are not one long block");
  assert.deepEqual(
    findOversizedAddedBlocks(addedCommentDiff(MAX_ADDED_BLOCK_LINES + 1), () => false),
    [],
    "a path the baseline does not measure is out of scope for the block scan too",
  );
});

test(`CLI: a real commit adding ${MAX_ADDED_BLOCK_LINES + 1} comment lines is REFUSED with its file and start line`, () => {
  const root = fixtureRepo({ "src/a.ts": 999, "scripts/comment-load-baseline.json": 0 }, CLEAN);
  try {
    const block = Array.from({ length: MAX_ADDED_BLOCK_LINES + 1 }, (_, i) => `// added ${i}`).join("\n");
    commitOnBranch(root, `${block}\n${CLEAN}`);
    const res = run(root);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, new RegExp(`src/a\\.ts:1: ${MAX_ADDED_BLOCK_LINES + 1} lines`));
    // The ceiling of 999 is deliberately slack, so this refusal can only be the block half.
    assert.doesNotMatch(res.stderr, /comment lines > ceiling/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the shipped tree ─────────────────────────────────────────────────────────────────────────

test("CENSUS: the shipped baseline covers every measured file, and no other", () => {
  const measured = listMeasuredFiles(REPO_ROOT);
  const recorded = Object.keys(JSON.parse(readFileSync(BASELINE, "utf8"))).filter((k) => k !== "_comment");
  assert.deepEqual(recorded.sort(), measured, "every measured file carries a recorded ceiling, and nothing else does");
  // POSITIVE CONTROL on the path set itself: the assertion above compares the baseline against the
  // SAME function that built it, so a root silently dropped from MEASURED_ROOTS would agree with a
  // baseline missing it. One representative tracked file per root, named here, is what refuses that.
  for (const representative of [
    "src/run-task.ts",
    "scripts/check.mjs",
    "deploy/Dockerfile",
    ".github/workflows/ci.yml",
    "bin/rmd",
    "hooks/pre-commit",
  ]) {
    assert.ok(recorded.includes(representative), `${representative} must carry a recorded ceiling`);
  }
  assert.ok(measured.length > 100, `sanity: the measured set must be a real corpus; saw ${measured.length}`);
});

test("the shipped tree passes its own ratchet, over a corpus that is not empty", () => {
  const printed = spawnSync(process.execPath, [SCRIPT, "--print"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(printed.status, 0, printed.stderr);
  const total = Number(/comment-load: (\d+) comment lines/.exec(printed.stdout)?.[1]);
  assert.ok(total > 1000, `sanity: the measurement must see a real corpus; saw ${total}`);
});
