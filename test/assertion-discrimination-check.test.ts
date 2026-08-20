import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T1051: ASSERTION-DISCRIMINATION gate ──────────────────────────────────────────────────
//
// A test can assert that a literal string appears in the RAW text of a repo file while the
// literal is satisfied only by a COMMENT -- the mechanism the test claims to pin can go dead and
// the assertion still passes, because the string is still written down somewhere in the file.
// That is exactly how a CI wait that should have blocked ~5 minutes on an apt lock instead
// returned in ~1 second and shipped green (the test pinned the literal `flock`, present only
// because the step's own comment named the tool it called). Mutation testing cannot see this
// class: it mutates SOURCE, this defect lives in a TEST asserting against a non-source file, and
// `test/**` is never a mutation target in this repo.
//
// (scripts/assertion-discrimination-check.mjs is a plain .mjs file outside tsconfig's `include`,
// so it is exercised here only via its CLI surface, never imported -- same convention as
// test/claims-check.test.ts.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "assertion-discrimination-check.mjs");
const FIXTURES = join(__dirname, "fixtures", "assertion-discrimination-check");

function runCli(testDir: string, baseline: string) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "--root", FIXTURES, "--test-dir", testDir, "--suffix", ".fixture.ts", "--baseline", baseline],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
}

// ── acceptance 1: a literal that only a comment satisfies is reported ───────────────────────

test("discrimination: a literal that only a comment satisfies is reported", () => {
  const result = runCli("cases-comment-only", "baselines/empty.json");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /satisfiable by a COMMENT ALONE/);
  assert.match(output, /cases-comment-only\/site\.fixture\.ts/);
  assert.match(output, /targets\/comment-only\.yml/);
  assert.match(output, /TOTALLY-UNIQUE-LITERAL-A/);
});

// ── acceptance 2: a literal present in executable text is not flagged ───────────────────────

test("discrimination: a literal present in executable text is not flagged", () => {
  const result = runCli("cases-executable", "baselines/empty.json");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /satisfiable by a COMMENT ALONE/);
  assert.match(output, /OK -- 1 resolved assertion\(s\), 0 unbaselined/);
});

// ── acceptance 3: a hash inside a quoted string is not stripped ─────────────────────────────

test("discrimination: a hash inside a quoted string is not stripped", () => {
  // If the stripper naively treated the `#` inside the target's quoted string as a comment
  // start, TOTALLY-UNIQUE-LITERAL-C (written right after that `#`, still inside the quotes)
  // would vanish from the stripped copy and this fixture would wrongly report FAIL.
  const result = runCli("cases-quoted-hash", "baselines/empty.json");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /satisfiable by a COMMENT ALONE/);
  assert.match(output, /OK -- 1 resolved assertion\(s\), 0 unbaselined/);
});

// ── acceptance 4: a baseline entry with no recorded reason is rejected ──────────────────────

test("discrimination: a baseline entry with no recorded reason is rejected", () => {
  const withReason = runCli("cases-comment-only", "baselines/exempts-comment-only-with-reason.json");
  const withReasonOutput = withReason.stdout + withReason.stderr;
  assert.equal(withReason.status, 0, withReasonOutput);
  assert.match(withReasonOutput, /BASELINED {2}cases-comment-only\/site\.fixture\.ts/);

  const missingReason = runCli("cases-comment-only", "baselines/exempts-comment-only-missing-reason.json");
  const missingReasonOutput = missingReason.stdout + missingReason.stderr;
  assert.notEqual(missingReason.status, 0, missingReasonOutput);
  assert.match(missingReasonOutput, /missing required non-empty string field "reason"/);
  // The rejection happens at LOAD time, before any site is even scanned -- the exemption never
  // silently takes effect.
  assert.doesNotMatch(missingReasonOutput, /BASELINED/);
});

// ── acceptance 5: an empty resolved set fails instead of passing ────────────────────────────

test("discrimination: an empty resolved set fails instead of passing", () => {
  const result = runCli("cases-empty", "baselines/empty.json");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /ZERO assertion sites resolved/);
  assert.match(output, /treated as a FAILURE, not a pass/);
});

// ── acceptance 6: an unconditional CI job runs the check on every pull request ───────────────

test("discrimination: an unconditional ci job runs the check on every pull request", async () => {
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ciYml, /^\s*assertion-discrimination:\s*$/m, "ci.yml must declare an assertion-discrimination job");
  assert.match(
    ciYml,
    /npm run --silent assertion-discrimination/,
    "ci.yml's assertion-discrimination job must actually invoke the checker",
  );
  // Same "runs unconditionally on every PR" shape as claims/lint-plan/depcruise/jscpd-gate: no
  // path filter, gated only on the PR event (never a job `if:` on changed paths) -- a
  // path-filtered REQUIRED check that can go silently absent is the deadlock class ci-gate.yml
  // exists to avoid, and a dead-guard test can be introduced by a change anywhere in the tree.
  const jobBlock = ciYml.slice(ciYml.search(/^\s*assertion-discrimination:\s*$/m));
  const nextJobIdx = jobBlock.slice(1).search(/^\s{2}[a-z][a-z0-9-]*:\s*$/m);
  const scopedBlock = nextJobIdx === -1 ? jobBlock : jobBlock.slice(0, nextJobIdx + 1);
  assert.doesNotMatch(scopedBlock, /paths:/, "the assertion-discrimination job must not be path-filtered");
});

// ── real repo: the check currently passes against origin/main's own test suite ──────────────

test("discrimination: the real check runs clean against this repo's own test suite and baseline", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /assertion-discrimination: OK --/);
});

// ── the refusal arms, driven through the module's own exports ────────────────────────────────
//
// The CLI cases above cannot reach these three: `stripComments`'s unknown-syntax throw is
// guarded upstream by `evaluateSite`'s own `if (!syntax)`, the unreadable-target catch needs a
// path that resolves but cannot be read, and `loadBaseline`'s shape refusal fires before any
// scan. Each is reached here by importing the gate the same way the task-id existence gate's
// suite reaches its own script -- `pathToFileURL` + a dynamic import -- and each carries a
// POSITIVE CONTROL in the same test, so a stub that always threw would fail the control half.

const mod = await import(pathToFileURL(SCRIPT).href);

test("discrimination: stripComments refuses a syntax it does not implement", () => {
  // CONTROL: a syntax it DOES implement strips, so the refusal below is the arm and not the norm.
  assert.equal(mod.stripComments("a # b\nc", "hash"), "a \nc");
  assert.throws(
    () => mod.stripComments("a # b", "yaml-ish"),
    /unknown syntax "yaml-ish"/,
    "an unimplemented syntax must refuse loudly rather than return undefined",
  );
});

test("discrimination: an unreadable target is unresolved rather than a pass", () => {
  // CONTROL: a real, readable target with a known extension resolves to a real verdict.
  const ok = mod.evaluateSite({
    targetPath: join(FIXTURES, "targets", "executable.yml"),
    literal: "echo",
  });
  assert.equal(ok.status, "pass", `a readable target must resolve: ${JSON.stringify(ok)}`);
  // A DIRECTORY resolves as a path and cannot be read as a file -- the catch arm, not a miss.
  // The SAME literal is used either side, so the only difference is readability of the target.
  const bad = mod.evaluateSite({ targetPath: join(FIXTURES, "targets"), literal: "echo" });
  assert.equal(bad.status, "unresolved");
  assert.match(bad.detail, /target file unreadable:/);
});

test("discrimination: a baseline that is not an exemptions document is refused", async () => {
  // CONTROL: the shipped baseline loads, so the refusal below is the arm and not a broken loader.
  assert.ok(Array.isArray(mod.loadBaseline(join(REPO_ROOT, "scripts", "assertion-discrimination-baseline.json"))));
  const notADoc = join(FIXTURES, "baselines", "not-an-exemptions-document.json");
  assert.throws(
    () => mod.loadBaseline(notADoc),
    /must be \{ "exemptions": \[\.\.\.\] \}/,
    "a JSON document with no exemptions array must be refused, never treated as empty",
  );
});
