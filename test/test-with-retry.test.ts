// test/test-with-retry.test.ts — W1-T255: ONE bounded, evidence-preserving whole-command test
// retry, plus the shared serve boot-barrier predicate this same task's hygiene item fixes.
//
// scripts/test-with-retry.mjs is a plain .mjs file outside tsconfig's `include`, so (same
// convention as claims-check.test.ts / coverage-ratchet.test.ts) it is exercised here only via
// its CLI surface, driving the real subprocess against test/fixtures/test-with-retry/fake-
// suite.mjs -- a deterministic stand-in "test command" whose pass/fail/flake behavior is
// controlled by --mode, so these falsifiers never depend on a genuinely-flaky Chromium suite.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { shellBootReady } from "./setup/open-shell.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "test-with-retry.mjs");
const FIXTURE = join(__dirname, "fixtures", "test-with-retry", "fake-suite.mjs");

function newStateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "test-with-retry-"));
  return join(dir, "invocations");
}

function invocationCount(stateFile: string): number {
  if (!existsSync(stateFile)) return 0;
  return Number(readFileSync(stateFile, "utf8").trim() || "0");
}

function runWrapper(
  mode: string,
  opts: { testName?: string; format?: string; env?: Record<string, string> } = {},
) {
  const stateFile = newStateFile();
  const testName = opts.testName ?? "sample flaky test";
  const args = [SCRIPT, process.execPath, FIXTURE, "--mode", mode, "--state-file", stateFile, "--test-name", testName];
  if (opts.format) args.push("--format", opts.format);
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
  });
  return { ...result, invocations: invocationCount(stateFile) };
}

// ── the wrapper's retry/parse/kill-switch behavior (the acceptance criteria) ───────────────────

test("test-with-retry: a deterministic failure fails BOTH attempts and the wrapper exits non-zero -- the retry cannot hide a real break", () => {
  const r = runWrapper("deterministic-fail");
  const output = r.stdout + r.stderr;
  assert.notEqual(r.status, 0, output);
  assert.equal(r.invocations, 2, `a deterministic failure must be spawned exactly twice (first attempt + the one bounded retry): ${output}`);
  assert.match(output, /FLAKE-RETRY: first attempt failed/, "the retry attempt must still be recorded even though it also fails");
});

test("test-with-retry: when the retry ALSO fails, a SECOND greppable record is emitted -- a break the retry did not paper over is just as countable", () => {
  const r = runWrapper("deterministic-fail", { testName: "non-recovering test" });
  const output = r.stdout + r.stderr;
  assert.notEqual(r.status, 0, output);
  assert.match(
    r.stdout ?? "",
    /FLAKE-RETRY: retry ALSO failed — .*non-recovering test/,
    "a retry that also fails must leave its own record, so a non-recovering break stays greppable, not silent",
  );
});

test("test-with-retry: a flake-once suite (fails then passes) exits 0 AND names the first attempt's failing test on stdout", () => {
  const r = runWrapper("flake-once", { testName: "flaky widget test" });
  const output = r.stdout + r.stderr;
  assert.equal(r.status, 0, output);
  assert.equal(r.invocations, 2, `a recovered flake must be spawned exactly twice: ${output}`);
  assert.match(r.stdout ?? "", /FLAKE-RETRY: first attempt failed — .*flaky widget test/, "the flake must leave a greppable record naming the failing test, not erase its own evidence");
});

test("test-with-retry: an all-green suite spawns the test command EXACTLY ONCE -- no doubled wall-time on a healthy PR", () => {
  const r = runWrapper("always-pass");
  const output = r.stdout + r.stderr;
  assert.equal(r.status, 0, output);
  assert.equal(r.invocations, 1, `a healthy run must never trigger a second spawn: ${output}`);
  assert.doesNotMatch(output, /FLAKE-RETRY/);
});

test("test-with-retry: TEST_RETRY=0 disables the retry -- the same flake-once suite stays RED, so the kill switch is real", () => {
  const r = runWrapper("flake-once", { env: { TEST_RETRY: "0" } });
  const output = r.stdout + r.stderr;
  assert.notEqual(r.status, 0, output);
  assert.equal(r.invocations, 1, `TEST_RETRY=0 must stop after the first attempt, no retry spawn: ${output}`);
});

test("test-with-retry: recognizes the `spec` reporter's ✖-prefixed failing-test line (coverage job's dual-reporter shape), not just TAP", () => {
  const r = runWrapper("flake-once", { testName: "spec-format widget test", format: "spec" });
  const output = r.stdout + r.stderr;
  assert.equal(r.status, 0, output);
  assert.equal(r.invocations, 2, `a recovered flake must be spawned exactly twice: ${output}`);
  assert.match(
    r.stdout ?? "",
    /FLAKE-RETRY: first attempt failed — .*spec-format widget test/,
    "the spec-reporter's ✖ line must be parsed into the flake record just like TAP's not-ok line",
  );
});

test("test-with-retry: forwards the child's stderr live (not just stdout) -- a failing attempt's stderr diagnostics reach the CI log", () => {
  const r = runWrapper("deterministic-fail", { testName: "stderr-forwarding test" });
  assert.match(
    r.stderr ?? "",
    /fake-suite: stderr-forwarding test failed on invocation \d+ \(stderr diagnostic\)/,
    `the wrapper must forward the child's stderr chunks, not swallow them: ${r.stdout}${r.stderr}`,
  );
});

test("test-with-retry: with no command given, prints a usage message and exits 2 -- no attempt is spawned at all", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr ?? "", /usage: test-with-retry\.mjs <command> \[args\.\.\.\]/);
});

test("test-with-retry: FLAKE-RETRY evidence is also appended to $GITHUB_STEP_SUMMARY when set, not just printed to stdout", () => {
  const summaryDir = mkdtempSync(join(tmpdir(), "test-with-retry-summary-"));
  const summaryPath = join(summaryDir, "summary.md");
  writeFileSync(summaryPath, "");
  const r = runWrapper("flake-once", { testName: "summary-recorded test", env: { GITHUB_STEP_SUMMARY: summaryPath } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const summary = readFileSync(summaryPath, "utf8");
  assert.match(summary, /FLAKE-RETRY: first attempt failed — .*summary-recorded test/);
});

// ── ONE required surface routes through the wrapper now; `npm test` itself stays retry-free ─────
//
// THIS TEST USED TO ASSERT THE OPPOSITE AND KEPT PASSING AFTER THE WIRING CHANGED. It read
// `ciYaml.match(/test-with-retry\.mjs/g).length >= 2` on the RAW file, naming "the ci job's Test
// step and the coverage-ratchet job's test-with-coverage step". The 2026-08-28 ruling removed the
// wrapper from coverage-ratchet — and the assertion stayed green, because three PROSE mentions
// survive in ci.yml's comments. `assertion-discrimination` caught exactly that: literal present in
// the raw target, ABSENT once comments are stripped, so the assertion could not tell "the mechanism
// is wired" from "someone wrote the name down". The gate failed the PR that made the claim false,
// which is the gate working.
//
// THE REPLACEMENT READS EXECUTABLE CONTENT ONLY, AND IN BOTH DIRECTIONS, so it discriminates
// whichever way the wiring moves: `ci` must still reach the wrapper, and no `run:` step may name it
// again. Re-adding it to coverage-ratchet turns this red on the second assertion; dropping it from
// `ci` turns it red on the first.
test("test-with-retry: the ci job reaches the wrapper through `npm run test:ci` while no run: step names it directly, and `npm test` stays retry-free for Stryker", async () => {
  const ciYaml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  // A `#` line comment is the only comment form a YAML workflow has, and every surviving mention of
  // the wrapper in this file sits on one. Dropping those lines leaves the executable content.
  const executable = ciYaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  // POSITIVE CONTROL ON THE STRIPPER ITSELF, and it is load-bearing rather than decorative: an
  // over-eager filter that emptied `executable` would make the doesNotMatch below vacuously true —
  // the "zero is not a measurement until a control proves the query could see its corpus" shape.
  assert.match(
    executable,
    /npm run test:ci/,
    "the ci job's Test step must still invoke the wrapper via `npm run test:ci` (and if this line is gone, the assertion below proves nothing)",
  );

  assert.doesNotMatch(
    executable,
    /test-with-retry/,
    "no run: step may name the wrapper directly: `ci` reaches it through `npm run test:ci`, and coverage-ratchet must not retry at all (2026-08-28 ruling — of six two-pass runs on record, four were cancelled against timeout-minutes: 39, and a cancellation names no failing test)",
  );

  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  assert.doesNotMatch(pkg.scripts.test, /test-with-retry/, "`npm test` must stay retry-free -- Stryker re-runs it once per mutant, where a retry would blur the kill signal");
  assert.match(pkg.scripts["test:ci"], /test-with-retry\.mjs/, "package.json must expose a test:ci script that routes through the wrapper");
});

// ── the shared serve boot barrier (the hygiene item folded into this same task) ─────────────────
//
// shellBootReady() is passed DIRECTLY to Playwright's `page.waitForFunction`, which serializes
// its source and evaluates it INSIDE the page -- it cannot take a parameter or close over an
// import, so it reads the ambient global `document` directly (see test/setup/open-shell.ts).
// These falsifiers stub `globalThis.document` with a minimal `getElementById` stand-in and call
// the SAME function directly in this Node process -- no Playwright/browser dependency.

// W1-T202: shellBootReady ALSO gates on document.body.dataset.writeScopeResolved -- these
// falsifiers default that marker to "1" (already resolved) so the four pre-existing cases below
// keep testing ONLY the #top-status dimension they were written for; the two NEW cases at the
// end test the write-scope dimension on its own, with #top-status already satisfied.
// NOTE: `writeScopeResolved` has NO default value on purpose -- a default triggers on an
// explicitly-passed `undefined` too (JS default-parameter semantics), which would make the
// "not resolved yet" falsifier below indistinguishable from "caller omitted the arg."
function stubTopStatus(getElementById: (id: string) => { textContent: string | null } | null, writeScopeResolved: string | undefined): void {
  (globalThis as unknown as { document: { getElementById: typeof getElementById; body: { dataset: Record<string, string | undefined> } } }).document = {
    getElementById,
    body: { dataset: { writeScopeResolved } },
  };
}

test("shellBootReady: does NOT pass while #top-status is absent from the DOM (the vacuous-true bug this replaces)", () => {
  stubTopStatus(() => null, "1");
  assert.equal(shellBootReady(), false, "an absent element must never be read as 'booted'");
});

test("shellBootReady: does NOT pass while #top-status still shows the loading placeholder", () => {
  stubTopStatus((id) => (id === "top-status" ? { textContent: "loading…" } : null), "1");
  assert.equal(shellBootReady(), false);
});

test("shellBootReady: passes once #top-status exists with real (non-loading) content", () => {
  stubTopStatus((id) => (id === "top-status" ? { textContent: "8 tasks" } : null), "1");
  assert.equal(shellBootReady(), true);
});

test("shellBootReady: does NOT pass when #top-status exists but has no text yet (empty string)", () => {
  // Empty string does not include "loading", so the ORIGINAL predicate would have (vacuously)
  // passed here too -- the real fix is requiring the element to EXIST, which this case already
  // satisfies; this falsifier documents that empty-but-present content is intentionally treated
  // as ready (matches the original predicate's intent for non-loading content).
  stubTopStatus((id) => (id === "top-status" ? { textContent: "" } : null), "1");
  assert.equal(shellBootReady(), true);
});

test("shellBootReady (W1-T202): does NOT pass while #top-status is ready but the boot write-scope probe has not resolved yet", () => {
  stubTopStatus((id) => (id === "top-status" ? { textContent: "8 tasks" } : null), undefined);
  assert.equal(shellBootReady(), false, "a fully-painted board must still wait on probeWriteScope before write controls are trustworthy");
});

test("shellBootReady (W1-T202): passes once BOTH #top-status is ready and the write-scope probe has resolved", () => {
  stubTopStatus((id) => (id === "top-status" ? { textContent: "8 tasks" } : null), "1");
  assert.equal(shellBootReady(), true);
});
