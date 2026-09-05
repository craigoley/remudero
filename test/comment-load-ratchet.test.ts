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
const { countCommentLines, evaluateCommentLoadRatchet, findOversizedAddedBlocks, listMeasuredFiles, main, readBaseline, splitBaseInheritedViolations, MAX_ADDED_BLOCK_LINES } =
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
    readBaseline: (text: string, path: string) => Record<string, number>;
    splitBaseInheritedViolations: (
      violations: Array<{ path: string; comments: number; baseline: number; overage: number }>,
      baseComments: Record<string, number>,
    ) => {
      caused: Array<{ path: string; comments: number }>;
      inherited: Array<{ path: string; comments: number; atBase: number }>;
    };
    main: (argv: string[]) => number;
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

// ── the CLI body, driven IN PROCESS ──────────────────────────────────────────────────────────
//
// The subprocess cases above prove the real exit codes CI consumes, but a spawned run reports no
// coverage, so every arm of `main` below would otherwise be untested code shipped behind a green
// gate (#978's shape: when every test drives the seam from outside, the seam's own branches are
// unreachable). These call `main` directly and capture what it writes.

/** Run `main(argv)` with console output captured, restoring both writers whatever happens. */
function runInProcess(argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    return { code: main(argv), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

test("readBaseline REFUSES malformed JSON and a non-object shape, rather than reading as an empty ceiling set", () => {
  assert.throws(() => readBaseline("{not json", "b.json"), /is not valid JSON/);
  assert.throws(() => readBaseline("[]", "b.json"), /must be a JSON object keyed by path/);
  assert.throws(() => readBaseline('{"a": -1}', "b.json"), /non-negative integer/);
});

test("listMeasuredFiles REFUSES a directory that is not a git repository — it never reads as an empty tree", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}comment-load-nogit-`));
  try {
    assert.throws(() => listMeasuredFiles(dir), /list measured files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: an unparseable flag exits 2 and says so — never a silent 0", () => {
  const { code, err } = runInProcess(["--no-such-flag"]);
  assert.equal(code, 2);
  assert.match(err, /MEASUREMENT FAILED -- invalid arguments/);
});

test("main: a root that is not a git repository exits 2, and an unreadable baseline exits 2", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}comment-load-main-`));
  try {
    const notARepo = runInProcess(["--root", dir]);
    assert.equal(notARepo.code, 2);
    assert.match(notARepo.err, /MEASUREMENT FAILED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const root = fixtureRepo({ "src/a.ts": 1 }, CLEAN);
  try {
    writeFileSync(join(root, "scripts", "comment-load-baseline.json"), "{oops");
    const bad = runInProcess(["--root", root, "--base", "main"]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /is not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main: an unresolvable base ref exits 2 — an unreadable base is never read as an empty diff", () => {
  const root = fixtureRepo({ "src/a.ts": 1, "scripts/comment-load-baseline.json": 0 }, CLEAN);
  try {
    const { code, err } = runInProcess(["--root", root, "--base", "no/such/ref"]);
    assert.equal(code, 2);
    assert.match(err, /resolve merge base against no\/such\/ref/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main --print: reports the largest files and exits 0 without consulting the baseline", () => {
  const root = fixtureRepo({}, `// one\n// two\n${CLEAN}`);
  try {
    // A baseline that would REFUSE if it were read. --print exiting 0 over it is the proof that
    // the report returns before readBaseline, not merely that a valid baseline happened to pass.
    writeFileSync(join(root, "scripts", "comment-load-baseline.json"), "{oops");
    const { code, out } = runInProcess(["--root", root, "--print"]);
    assert.equal(code, 0, "the report must not consult the baseline at all");
    // 2 comments from src/a.ts; 2 code lines — its one statement plus the malformed baseline
    // line, which is a tracked scripts/ file and so measured like any other.
    assert.match(out, /comment-load: 2 comment lines against 2 code lines \(50\.0%\)/);
    assert.match(out, /src\/a\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main --json: emits a schema-versioned report and carries the same verdict as the human output", () => {
  const root = fixtureRepo({ "src/a.ts": 1, "scripts/comment-load-baseline.json": 0 }, `// one\n${CLEAN}`);
  try {
    commitOnBranch(root, `// one\n// two\n${CLEAN}`);
    const { code, out } = runInProcess(["--root", root, "--base", "main", "--json"]);
    assert.equal(code, 1, "a grown file must fail in --json mode too");
    const report = JSON.parse(out) as {
      schema_version: number;
      files: number;
      totals: { comments: number; code: number };
      violations: { path: string; overage: number }[];
      oversized_added_blocks: unknown[];
    };
    assert.equal(report.schema_version, 1);
    assert.ok(report.files >= 2);
    assert.equal(report.totals.comments, 2);
    assert.deepEqual(report.violations.map((v) => [v.path, v.overage]), [["src/a.ts", 1]]);
    assert.deepEqual(report.oversized_added_blocks, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main --check: refuses to leave a required baseline change unwritten, and names each one", () => {
  const root = fixtureRepo({ "src/a.ts": 5, "src/gone.ts": 3, "scripts/comment-load-baseline.json": 0 }, `// one\n${CLEAN}`);
  try {
    const before = readFileSync(join(root, "scripts", "comment-load-baseline.json"), "utf8");
    const { code, err } = runInProcess(["--root", root, "--base", "main", "--check"]);
    assert.equal(code, 1);
    assert.match(err, /CHECK FAILED/);
    assert.match(err, /lower {2}"src\/a\.ts": 5 -> 1/);
    assert.match(err, /remove "src\/gone\.ts"/);
    assert.equal(
      readFileSync(join(root, "scripts", "comment-load-baseline.json"), "utf8"),
      before,
      "--check must leave the baseline byte-identical",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── growth this diff caused, versus growth it inherited from the merge base ───────────────────

test("splitBaseInheritedViolations: a file already that long at the merge base is INHERITED, not charged", () => {
  const violations = [
    { path: "src/main-grew.ts", comments: 361, baseline: 328, overage: 33 },
    { path: "src/we-grew.ts", comments: 50, baseline: 40, overage: 10 },
    { path: "src/we-grew-further.ts", comments: 60, baseline: 40, overage: 20 },
  ];
  const { caused, inherited } = splitBaseInheritedViolations(violations, {
    "src/main-grew.ts": 361, // main landed this while the PR was open
    "src/we-grew-further.ts": 55, // the base grew it to 55; this diff pushed it to 60
    // src/we-grew.ts is absent at the base entirely
  });
  assert.deepEqual(inherited.map((v) => [v.path, v.atBase]), [["src/main-grew.ts", 361]]);
  assert.deepEqual(caused.map((v) => v.path), ["src/we-grew.ts", "src/we-grew-further.ts"]);
});

test("splitBaseInheritedViolations: with no base counts at all, every violation stays CHARGED — it fails closed", () => {
  const violations = [{ path: "src/a.ts", comments: 9, baseline: 1, overage: 8 }];
  const { caused, inherited } = splitBaseInheritedViolations(violations, {});
  assert.equal(inherited.length, 0);
  assert.deepEqual(caused, violations);
});

test("CLI: growth main landed while the PR was open passes and is recorded; growth the PR added still fails", () => {
  const root = fixtureRepo({ "src/a.ts": 1, "scripts/comment-load-baseline.json": 0 }, `// one\n${CLEAN}`);
  try {
    // `main` itself grows src/a.ts to three comment lines AFTER the ledger recorded one.
    writeFileSync(join(root, "src", "a.ts"), `// one\n// two\n// three\n${CLEAN}`);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "main grows a comment"]);
    // The branch is cut from that same main, so the growth is at its merge base.
    git(root, ["checkout", "-qb", "work"]);
    const inheritedOnly = runInProcess(["--root", root, "--base", "main"]);
    assert.equal(inheritedOnly.code, 0, inheritedOnly.err);
    assert.match(inheritedOnly.out, /src\/a\.ts carries 3 comment lines over a recorded 1, but already carried 3 at the merge base/);
    assert.equal(
      JSON.parse(readFileSync(join(root, "scripts", "comment-load-baseline.json"), "utf8"))["src/a.ts"],
      3,
      "the ledger must be updated to the inherited truth, not left short",
    );

    // Now the BRANCH adds a fourth comment line of its own: charged, and refused.
    writeFileSync(join(root, "src", "a.ts"), `// one\n// two\n// three\n// four\n${CLEAN}`);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "the branch grows it further"]);
    const caused = runInProcess(["--root", root, "--base", "main"]);
    assert.equal(caused.code, 1);
    assert.match(caused.err, /src\/a\.ts: 4 comment lines > ceiling 3 \(\+1\)/);
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
