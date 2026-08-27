// test/no-shallowing-of-the-canonical-checkout.test.ts — W1-T2333: nothing forbids a depth-
// limiting git call against the canonical checkout, and this ratchet is the gate that reads it.
//
// THE FINDING (full trail in plan/tasks.d/W1-T2333-*.yaml rationale). Three suites
// (test/lint-plan-merge-evidence.test.ts, test/measurement-cadence.test.ts,
// test/verdict-calibration.test.ts) each build a REAL `git clone --depth 1` to exercise a
// shallow-clone refusal. All three read clean today, and for the same reason each time: the
// clone SOURCE is a fixture repo the test itself `git init`s, never the checkout under test. But
// one of the three (lint-plan-merge-evidence.test.ts) is safe by an ACCIDENT of where it seeds
// that fixture (inside REPO_ROOT rather than the OS tmpdir its two siblings use) — nothing states
// the required property, and nothing gates it. Repo-wide, `--depth` (and its shallow-clone
// siblings) appears nowhere else in shipped sources except one hosted-runner workflow step that
// cannot reach a host checkout. Both properties below are currently true BY CONVENTION ONLY; this
// file is what turns them into something that fails loudly when a future edit breaks either one.
//
// TWO PROPERTIES, ONE FILE, NO PRODUCTION CHANGE (design (i)):
//   (a) No depth-limiting git flag may appear on a git invocation under src/, scripts/, deploy/
//       or .github/workflows/ — the flag SET is a data table (FORBIDDEN_FLAGS), not a branch, and
//       the one legitimate exception (the heartbeat workflow's hosted-runner fetch) passes by a
//       named, reasoned exemption rather than a hole in the pattern (design (ii)).
//   (b) A test/ fixture that builds a shallow clone must ALSO build (via `git init`) the
//       repository it clones from — the property rationale (2) shows is unwritten today.
//
// This is a SOURCE SCAN, not a parser: same trade-off test/catch-erasure-ratchet.test.ts and
// test/bound-kind-declared.test.ts already make on this codebase. It is deliberately blind to
// anything not shaped like this repo's own git-invocation idioms (the `git([...])` wrapper used
// in src/lib/self-sync.ts / src/lib/install-root.ts and all three existing fixtures;
// `execFileSync`/`spawn(Sync)?("git", [...])`; or a bare shell/YAML `git <subcommand> ...` line).
//
// THE FALSIFIER (design (v)) — investigated, not shipped as a test, and repeated in this PR's
// body: `git rev-parse --is-shallow-repository` on this worktree's own checkout reports `false`,
// and its common git dir carries no `.git/shallow` file at all. There is no shallow horizon on
// THIS host to date — the falsifier resolves to "never shallow here," consistent with rationale
// (1)'s read that nothing in this repository shallows the canonical checkout today. Had it been
// shallow, dating the cause would need `.git/shallow`'s mtime or a provisioning record — neither
// of which is code, and W1-T2332 (not yet shipped) is the intended future recorder, not this task.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ─────────────────────────────────── the flag table (design (i)(a)) ───────────────────────────

// DATA, not a branch: a git flag that newly limits history depth is a new row here, never a new
// `if`. `--unshallow` is deliberately ABSENT — it deepens a clone back toward full history (the
// repair direction, per the task's own rationale (5)/design (i)(a)), never limits it.
const FORBIDDEN_FLAGS = ["--depth", "--shallow-since", "--shallow-exclude", "--filter"] as const;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FORBIDDEN_FLAG_RE = new RegExp(`(${FORBIDDEN_FLAGS.map(escapeRe).join("|")})\\b`, "g");

// ─────────────────────────── git-invocation extraction (both idioms) ──────────────────────────

const GIT_CALL_START_RE =
  /(?:\bgit\s*\(\s*\[|execFileSync\(\s*["'`]git["'`]\s*,\s*\[|spawn(?:Sync)?\(\s*["'`]git["'`]\s*,\s*\[)/g;

/** Every bracket-matched argument-array literal belonging to a git invocation in `source`:
 *  this repo's own `git([...])` wrapper idiom (src/lib/self-sync.ts, src/lib/install-root.ts,
 *  and all three existing shallow-clone fixtures) plus a direct `execFileSync("git", [...])` /
 *  `spawn(Sync)?("git", [...])` call. Brace/paren-matched rather than parsed, the same trade-off
 *  test/catch-erasure-ratchet.test.ts makes over this same tree. */
function extractGitCallArgLists(source: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  GIT_CALL_START_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GIT_CALL_START_RE.exec(source))) {
    const bracketStart = source.indexOf("[", m.index);
    if (bracketStart === -1) continue;
    let depth = 1;
    let i = bracketStart + 1;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "[") depth++;
      else if (source[i] === "]") depth--;
    }
    out.push({ text: source.slice(bracketStart, i), start: bracketStart });
  }
  return out;
}

const SHELL_GIT_RE = /\bgit\s+\S/;

/** Every bare `git <subcommand> ...` shell/YAML line in `source` (deploy/*.sh,
 *  .github/workflows `run:` blocks). Line-based, not brace-matched — none of this repo's real
 *  shell git invocations wrap across lines (verified by direct reading of every named site in
 *  the task's own rationale (3)). */
function extractGitShellLines(source: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  const lines = source.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (SHELL_GIT_RE.test(line)) out.push({ text: line, start: offset });
    offset += line.length + 1;
  }
  return out;
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

interface FlagHit {
  file: string;
  line: number;
  flag: string;
  snippet: string;
}

/** Every FORBIDDEN_FLAGS token that sits inside an actual git invocation in `source` (either
 *  idiom above) — never a bare textual mention, so this file's own data table and prose are not
 *  self-flagging. */
function findForbiddenFlagHits(source: string, file: string): FlagHit[] {
  const hits: FlagHit[] = [];
  const invocations = [...extractGitCallArgLists(source), ...extractGitShellLines(source)];
  for (const inv of invocations) {
    FORBIDDEN_FLAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FORBIDDEN_FLAG_RE.exec(inv.text))) {
      const absoluteIndex = inv.start + m.index;
      hits.push({
        file,
        line: lineNumberAt(source, absoluteIndex),
        flag: m[1],
        snippet: inv.text.trim().slice(0, 200),
      });
    }
  }
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = `${h.line} ${h.flag}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatHit(h: FlagHit): string {
  return `${h.file}:${h.line}: forbidden flag ${h.flag} on a git invocation (${h.snippet})`;
}

// ──────────────────────────── property (b): self-created clone source ─────────────────────────

/** True if `source` also constructs, via a git `init` call, the repository it elsewhere shallow-
 *  clones from — the property rationale (2) names as currently unwritten and ungated. A presence
 *  check over the file's own text (this is a source-scan ratchet, design (i)), not a full data-
 *  flow proof — but a real assertion, not a convention nobody reads. */
function hasSelfCreatedGitSource(source: string): boolean {
  return /(?:\bgit\s*\(\s*\[\s*["'`]init["'`]|execFileSync\(\s*["'`]git["'`]\s*,\s*\[\s*["'`]init["'`]|spawn(?:Sync)?\(\s*["'`]git["'`]\s*,\s*\[\s*["'`]init["'`])/.test(
    source,
  );
}

// ────────────────────────────────────── exemptions (design (ii)) ──────────────────────────────

interface Exemption {
  file: string;
  line: number;
  flag: string;
  reason: string;
}

// The heartbeat watcher runs on a hosted GitHub Actions runner, fetching exactly one named
// branch ref by name (rationale (3)): there is no host checkout in reach for a hosted runner to
// shallow, so this is the one legitimate depth-limiting call in scope (a) — named, lined and
// reasoned rather than a silent hole in the pattern.
const EXEMPTIONS: Exemption[] = [
  {
    file: ".github/workflows/fleet-heartbeat-watch.yml",
    line: 287,
    flag: "--depth",
    reason:
      "hosted GitHub Actions runner, fetching one named branch ref by name, for a heartbeat " +
      "freshness check — no host checkout is reachable from a hosted runner to shallow",
  },
];

/** An exemption that carries no reason is itself a failure of the ratchet (design (ii)): this is
 *  called from the live scan below, so a badly-formed table entry fails the gate outright rather
 *  than silently permitting whatever it names. */
function validateExemptions(list: Exemption[]): void {
  for (const e of list) {
    if (!e.reason || !e.reason.trim()) {
      throw new Error(
        `no-shallowing-of-the-canonical-checkout: exemption for ${e.file}:${e.line} (${e.flag}) ` +
          `carries no reason string — an exemption without one is itself a failure of this ratchet`,
      );
    }
  }
}

function isExempt(h: FlagHit, exemptions: Exemption[]): boolean {
  return exemptions.some((e) => e.file === h.file && e.line === h.line && e.flag === h.flag);
}

// ──────────────────────────────────── tracked-tree scanning ───────────────────────────────────

/** `git ls-files` under `dirs`, NUL-separated so no filename can be misread. Every path it names
 *  is then read WITHOUT a surrounding try/catch — a path git considers tracked but the
 *  filesystem cannot deliver is exactly the "read that failed reported as a read that said no"
 *  failure mode this task's design (iv) refuses to allow; it must throw, not vanish. */
function trackedFiles(root: string, dirs: string[]): string[] {
  const listing = execFileSync("git", ["-C", root, "ls-files", "-z", "--", ...dirs], {
    encoding: "utf8",
  });
  return listing.split("\0").filter(Boolean);
}

function scanForForbiddenFlagHits(root: string, dirs: string[]): FlagHit[] {
  const hits: FlagHit[] = [];
  for (const file of trackedFiles(root, dirs)) {
    const source = readFileSync(join(root, file), "utf8");
    hits.push(...findForbiddenFlagHits(source, file));
  }
  return hits;
}

const SCOPE_A_DIRS = ["src", "scripts", "deploy", ".github/workflows"];

// ════════════════════════════════════════ acceptance (1) ══════════════════════════════════════
// "a source scan refuses any depth-limiting flag on a git invocation in the shipped sources, and
// the refused flag set is a data table rather than a branch"

test("FORBIDDEN_FLAGS is a plain data array (a table, not a branch) naming exactly the four repair-excluded flags, and --unshallow is not one of them", () => {
  assert.deepEqual(Array.isArray(FORBIDDEN_FLAGS), true);
  assert.deepEqual(
    [...FORBIDDEN_FLAGS].sort(),
    ["--depth", "--filter", "--shallow-exclude", "--shallow-since"].sort(),
  );
  assert.ok(!(FORBIDDEN_FLAGS as readonly string[]).includes("--unshallow"), "--unshallow deepens history — it is the repair, not the offence");
});

test("no-shallowing-of-the-canonical-checkout: src/, scripts/, deploy/ and .github/workflows/ carry no unexempted depth-limiting git invocation", () => {
  validateExemptions(EXEMPTIONS);
  const hits = scanForForbiddenFlagHits(REPO_ROOT, SCOPE_A_DIRS);

  // Positive control (design (iv) / rationale (3)): the scan must prove it actually READ real
  // content before its zero can be trusted. The heartbeat workflow's known, exempted call is the
  // control target — if the scanner stops finding it (broken regex, unreadable path, moved
  // scope), this fails LOUD rather than the unexempted check below reporting a false-clean zero.
  const controlHit = hits.find(
    (h) => h.file === ".github/workflows/fleet-heartbeat-watch.yml" && h.flag === "--depth",
  );
  assert.ok(
    controlHit,
    `positive control failed: expected to find the known --depth call in ` +
      `.github/workflows/fleet-heartbeat-watch.yml among ${hits.length} hit(s) — the scan found ` +
      `nothing there, so its zero-unexempted result below cannot be trusted`,
  );

  const unexempted = hits.filter((h) => !isExempt(h, EXEMPTIONS));
  assert.deepEqual(
    unexempted,
    [],
    `unexempted depth-limiting git invocation(s) found:\n${unexempted.map(formatHit).join("\n")}`,
  );
});

// ════════════════════════════════════════ acceptance (2) ══════════════════════════════════════
// "a fixture that builds a shallow clone must clone from a repository the fixture itself
// created, and this is asserted rather than left to convention"

test("no-shallowing-of-the-canonical-checkout: every test/ fixture that shallow-clones also `git init`s the repo it clones from", () => {
  const files = trackedFiles(REPO_ROOT, ["test"]).filter((f) => f.endsWith(".ts"));
  const filesWithHits: string[] = [];
  const violations: FlagHit[] = [];
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    const hits = findForbiddenFlagHits(source, file);
    if (hits.length === 0) continue;
    filesWithHits.push(file);
    if (!hasSelfCreatedGitSource(source)) violations.push(...hits);
  }

  // Positive control: the three fixtures rationale (1)/(2) names must actually be found by this
  // scan (not a vacuous empty result over a broken pattern or an unreadable test/ tree).
  for (const known of [
    "test/lint-plan-merge-evidence.test.ts",
    "test/measurement-cadence.test.ts",
    "test/verdict-calibration.test.ts",
  ]) {
    assert.ok(
      filesWithHits.includes(known),
      `positive control failed: expected ${known} among the files with a depth-limiting git ` +
        `invocation (found: ${filesWithHits.join(", ") || "(none)"}) — this scan's zero-` +
        `violation result below cannot be trusted if it never saw the known fixtures`,
    );
  }

  assert.deepEqual(
    violations,
    [],
    `test/ fixture(s) shallow-clone without also creating their own source repo via \`git init\`:\n` +
      violations.map(formatHit).join("\n"),
  );
});

// ════════════════════════════════════════ acceptance (3) ══════════════════════════════════════
// "the scan fails on a seeded offending source and its message names the file, the line and the
// flag"

test("findForbiddenFlagHits: a seeded production-shaped offender is caught, and the failure names the file, the line and the flag", () => {
  const FIXTURE_OFFENDING_SRC = [
    'export function cloneRepo(url: string, dest: string): void {',
    '  execFileSync("git", ["clone", "--depth", "1", url, dest]);',
    "}",
    "",
  ].join("\n");
  const hits = findForbiddenFlagHits(FIXTURE_OFFENDING_SRC, "src/lib/fixture-offender.ts");
  assert.equal(hits.length, 1, `expected exactly one hit, got ${JSON.stringify(hits)}`);
  assert.deepEqual(hits[0]?.file, "src/lib/fixture-offender.ts");
  assert.deepEqual(hits[0]?.line, 2);
  assert.deepEqual(hits[0]?.flag, "--depth");

  const message = formatHit(hits[0]!);
  assert.match(message, /src\/lib\/fixture-offender\.ts/, "message must name the file");
  assert.match(message, /:2:/, "message must name the line");
  assert.match(message, /--depth/, "message must name the flag");
});

test("findForbiddenFlagHits + hasSelfCreatedGitSource: a seeded test/ fixture that shallow-clones an existing checkout (no git init anywhere in the file) is caught by name, line and flag", () => {
  const FIXTURE_MISSING_INIT_SRC = [
    'test("clones something", () => {',
    '  execFileSync("git", ["clone", "--depth", "1", "file:///some/real/checkout", "/tmp/dest"]);',
    "});",
    "",
  ].join("\n");
  const hits = findForbiddenFlagHits(FIXTURE_MISSING_INIT_SRC, "test/fixture-missing-init.test.ts");
  assert.equal(hits.length, 1, `expected exactly one hit, got ${JSON.stringify(hits)}`);
  assert.deepEqual(hits[0]?.line, 2);
  assert.deepEqual(hits[0]?.flag, "--depth");
  assert.equal(
    hasSelfCreatedGitSource(FIXTURE_MISSING_INIT_SRC),
    false,
    "fixture deliberately never calls git init — it must not read as self-created",
  );

  const message = formatHit(hits[0]!);
  assert.match(message, /test\/fixture-missing-init\.test\.ts/);
  assert.match(message, /:2:/);
  assert.match(message, /--depth/);
});

// ════════════════════════════════════════ acceptance (4) ══════════════════════════════════════
// "an exemption carries a stated reason, and an exemption without one fails the scan"

test("validateExemptions: the real EXEMPTIONS table is well-formed (every entry carries a non-empty reason)", () => {
  assert.doesNotThrow(() => validateExemptions(EXEMPTIONS));
  assert.ok(EXEMPTIONS.length > 0, "the table is expected to carry at least the heartbeat exemption");
});

test("validateExemptions: an exemption with no reason (missing, empty, or whitespace-only) fails the scan, naming the file, line and flag", () => {
  for (const badReason of [undefined, "", "   "] as const) {
    const bad: Exemption[] = [
      { file: ".github/workflows/fixture.yml", line: 7, flag: "--depth", reason: badReason as unknown as string },
    ];
    assert.throws(
      () => validateExemptions(bad),
      (err: unknown) => {
        const msg = String((err as Error).message);
        return (
          msg.includes(".github/workflows/fixture.yml") &&
          msg.includes(":7") &&
          msg.includes("--depth") &&
          /reason/i.test(msg)
        );
      },
      `validateExemptions must throw and name file/line/flag for reason=${JSON.stringify(badReason)}`,
    );
  }
});

// ════════════════════════════════════════ acceptance (5) ══════════════════════════════════════
// "a clean result is reported only when the scan proves it read the known call sites, and an
// unreadable input fails instead of reporting clean"

test("scanForForbiddenFlagHits: the live scope-(a) scan finds at least the one known call site — a zero result with no control would be indistinguishable from a broken scan", () => {
  const hits = scanForForbiddenFlagHits(REPO_ROOT, SCOPE_A_DIRS);
  assert.ok(
    hits.length >= 1,
    "expected at least the heartbeat workflow's known --depth call — a scan finding literally " +
      "nothing at all in scope (a) cannot be trusted to have read anything",
  );
});

test("scanForForbiddenFlagHits: a path `git ls-files` lists but the filesystem cannot deliver (tracked, then deleted on disk) makes the scan throw — it never reports that file clean by silently skipping it", () => {
  const repo = mkdtempSync(join(tmpdir(), "no-shallow-unreadable-src-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "ghost.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo, env });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"],
      { cwd: repo, env },
    );
    rmSync(join(repo, "src", "ghost.ts")); // still tracked/listed by git; gone from disk
    assert.throws(() => scanForForbiddenFlagHits(repo, ["src"]), /ENOENT|no such file/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
