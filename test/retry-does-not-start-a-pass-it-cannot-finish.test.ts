// test/retry-does-not-start-a-pass-it-cannot-finish.test.ts — W1-T2433: the wrapper must not
// START a second pass it cannot FINISH inside the job's own timeout. Companion to
// test/test-with-retry.test.ts, which owns the pre-existing retry/parse/kill-switch behavior
// (W1-T255); this file owns only the new budget-aware decision of whether to start pass 2 at all.
//
// Same convention as test/test-with-retry.test.ts (and acceptance-author-gate.test.ts /
// coverage-ratchet.test.ts before it): `scripts/**` sits OUTSIDE tsconfig's `include`, so a
// static `import … from "../scripts/test-with-retry.mjs"` is a TS7016. This file exercises the
// two new pure decision functions (`parseBudgetSeconds`, `shouldAttemptRetry`) via a dynamic
// `import()` of the real module -- no shadow copy to drift from it -- and exercises the wrapper's
// end-to-end behavior via its CLI surface, driving the real subprocess against the same
// test/fixtures/test-with-retry/fake-suite.mjs used by test-with-retry.test.ts (now extended with
// a --sleep-ms flag so a "pass 1" can be given a controlled, known duration).
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "test-with-retry.mjs");
const FIXTURE = join(__dirname, "fixtures", "test-with-retry", "fake-suite.mjs");

const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  parseBudgetSeconds: (raw: string | undefined) => number | undefined;
  shouldAttemptRetry: (args: { budgetSeconds: number | undefined; firstPassElapsedMs: number }) => boolean;
};
const { parseBudgetSeconds, shouldAttemptRetry } = mod;

function newStateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "test-with-retry-budget-"));
  return join(dir, "invocations");
}

function invocationCount(stateFile: string): number {
  if (!existsSync(stateFile)) return 0;
  return Number(readFileSync(stateFile, "utf8").trim() || "0");
}

function runWrapper(
  mode: string,
  opts: { testName?: string; sleepMs?: number; env?: Record<string, string> } = {},
) {
  const stateFile = newStateFile();
  const testName = opts.testName ?? "sample flaky test";
  const args = [SCRIPT, process.execPath, FIXTURE, "--mode", mode, "--state-file", stateFile, "--test-name", testName];
  if (opts.sleepMs !== undefined) args.push("--sleep-ms", String(opts.sleepMs));
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
  });
  return { ...result, invocations: invocationCount(stateFile) };
}

// ── the decision math, tested directly and exactly (fast, no subprocess, no wall-clock) ────────

test("shouldAttemptRetry: with no budget given, always retries -- byte-for-byte the pre-W1-T2433 behavior", () => {
  assert.equal(shouldAttemptRetry({ budgetSeconds: undefined, firstPassElapsedMs: 999_999 }), true);
});

test("shouldAttemptRetry: declines when the remaining budget is LESS than what pass 1 consumed", () => {
  // budget 100s, pass 1 took 60s -> remaining 40s < 60s consumed -> decline.
  assert.equal(shouldAttemptRetry({ budgetSeconds: 100, firstPassElapsedMs: 60_000 }), false);
});

test("shouldAttemptRetry: retries when the remaining budget EQUALS what pass 1 consumed (exact fit)", () => {
  // budget 100s, pass 1 took 50s -> remaining 50s == 50s consumed -> still attempts it.
  assert.equal(shouldAttemptRetry({ budgetSeconds: 100, firstPassElapsedMs: 50_000 }), true);
});

test("shouldAttemptRetry: retries with room to spare when pass 1 was fast relative to the budget", () => {
  assert.equal(shouldAttemptRetry({ budgetSeconds: 2340, firstPassElapsedMs: 1115_000 }), true);
});

test("parseBudgetSeconds: undefined/blank/non-numeric/non-positive all mean 'no budget given'", () => {
  assert.equal(parseBudgetSeconds(undefined), undefined);
  assert.equal(parseBudgetSeconds(""), undefined);
  assert.equal(parseBudgetSeconds("not-a-number"), undefined);
  assert.equal(parseBudgetSeconds("0"), undefined);
  assert.equal(parseBudgetSeconds("-5"), undefined);
});

test("parseBudgetSeconds: a positive numeric string parses to that many seconds", () => {
  assert.equal(parseBudgetSeconds("2340"), 2340);
  assert.equal(parseBudgetSeconds("0.5"), 0.5);
});

// ── end-to-end via the real CLI, generous margins so timing never makes these flaky ─────────────

test("test-with-retry: declines pass 2 when the budget cannot fit it, exits with pass 1's own code, and still names the failing test", () => {
  // pass 1 is forced to take >=400ms; a 500ms budget leaves ~0-100ms remaining after it, nowhere
  // near the >=400ms another pass would need -- this holds regardless of process-startup jitter.
  const r = runWrapper("deterministic-fail", {
    testName: "unfinishable second pass test",
    sleepMs: 400,
    env: { TEST_RETRY_BUDGET_SECONDS: "0.5" },
  });
  const output = r.stdout + r.stderr;
  assert.equal(r.invocations, 1, `a declined retry must never spawn pass 2: ${output}`);
  assert.equal(r.status, 1, `a declined retry must exit with pass 1's own (non-cancellation) code: ${output}`);
  assert.match(
    r.stdout ?? "",
    /FLAKE-RETRY: first attempt failed — .*unfinishable second pass test/,
    "pass 1's failing test must still be named -- a declined retry must not discard evidence the way a CI cancellation does",
  );
  assert.match(
    r.stdout ?? "",
    /FLAKE-RETRY: declined retry —/,
    "the decline itself must leave its own greppable record, distinguishing it from a cancellation that names nothing",
  );
});

test("test-with-retry: a retry that DOES fit the budget still runs exactly as it does today (recovers a flake, exits 0)", () => {
  // a generous budget (60s) against a near-instant fixture leaves enormous headroom either way.
  const r = runWrapper("flake-once", {
    testName: "budgeted flake recovery test",
    env: { TEST_RETRY_BUDGET_SECONDS: "60" },
  });
  const output = r.stdout + r.stderr;
  assert.equal(r.status, 0, output);
  assert.equal(r.invocations, 2, `a recovered flake with room in the budget must still be spawned twice: ${output}`);
  assert.doesNotMatch(output, /declined retry/, "a retry with room to spare must not be declined");
});

test("test-with-retry: a healthy (green) first pass is spawned exactly once even when a tiny budget is set -- the budget check never runs on the happy path", () => {
  const r = runWrapper("always-pass", { env: { TEST_RETRY_BUDGET_SECONDS: "0.001" } });
  const output = r.stdout + r.stderr;
  assert.equal(r.status, 0, output);
  assert.equal(r.invocations, 1, `a green first pass must never trigger any retry logic, budget or not: ${output}`);
  assert.doesNotMatch(output, /FLAKE-RETRY/);
});

test("test-with-retry: a deterministic failure still fails BOTH passes when both fit the budget -- the retry cannot mask a real break", () => {
  const r = runWrapper("deterministic-fail", {
    testName: "still-broken with budget test",
    env: { TEST_RETRY_BUDGET_SECONDS: "60" },
  });
  const output = r.stdout + r.stderr;
  assert.notEqual(r.status, 0, output);
  assert.equal(r.invocations, 2, `both passes must run when the budget has room: ${output}`);
  assert.match(output, /FLAKE-RETRY: retry ALSO failed/, "a non-recovering break must still leave its own record");
});

test("test-with-retry: TEST_RETRY=0 keeps its meaning even when a budget is also supplied -- the kill switch still stops after pass 1, not the budget math", () => {
  const r = runWrapper("flake-once", {
    testName: "kill switch with budget test",
    env: { TEST_RETRY: "0", TEST_RETRY_BUDGET_SECONDS: "60" },
  });
  const output = r.stdout + r.stderr;
  assert.notEqual(r.status, 0, output);
  assert.equal(r.invocations, 1, `TEST_RETRY=0 must stop after the first attempt regardless of budget: ${output}`);
  assert.doesNotMatch(output, /declined retry/, "TEST_RETRY=0 is a distinct mechanism from a budget decline");
});

// ── the wrapper reads no job-bound signal beyond the one budget it is handed ────────────────────

test("test-with-retry: the script reads no job-bound signal of its own (no GITHUB_* timeout/deadline var, no hardcoded wait-cap) -- only the budget it is handed", async () => {
  const source = await readFile(SCRIPT, "utf8");
  const envReads = [...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    new Set(envReads),
    new Set(["TEST_RETRY", "TEST_RETRY_BUDGET_SECONDS", "GITHUB_STEP_SUMMARY"]),
    "the wrapper's only env inputs must be the existing kill switch, the new budget, and the existing evidence-output path",
  );
});
