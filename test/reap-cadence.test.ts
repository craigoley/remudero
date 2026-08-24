/**
 * W1-T448 — DECIDING `rmd reap-branches`'S CADENCE.
 *
 * W1-T447 shipped the dry-run classifier as a VERB and deliberately deferred the question of
 * WHEN it runs. This task answers that question: per-pass wiring into `rmd sweep` was costed
 * (design clause (i), candidate (a)) and rejected — one reap issues ~8 `gh api` `state=all`
 * pages and costs several seconds of wall time, while the daemon polls the sweep roughly every
 * `DEFAULT_POLL_INTERVAL_MS` (60s, src/lib/daemon.ts), so per-pass wiring would add on the order
 * of 480 REST requests/hour for an answer that only moves when a branch is created or merged.
 * The decision is candidate (c): `rmd reap-branches` stays a manual verb, never wired into
 * `rmd sweep`. That is explicitly a permitted outcome (design: "a task whose honest outcome is
 * `the existing verb is correct` is a real outcome").
 *
 * Three tests below, one per acceptance claim:
 *   1. the cadence decision is documented with the measured number that decided it (not merely
 *      asserted), and a falsifier proves the check can actually go RED.
 *   2. because the decision is "never wired in", a failing reap structurally CANNOT abort a
 *      sweep pass — proven by showing `sweepCommand` never calls `reapBranchesCommand`, and that
 *      the two are dispatched as separate, mutually exclusive CLI verbs (separate processes),
 *      with a falsifier proving the structural check would catch it if that ever changed.
 *   3. the reaper still deletes nothing, exercised across several back-to-back invocations to
 *      stand in for "whatever the cadence" an operator or cron chooses to run it at.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { DECLARED_BRANCH_GUARDS, reapBranchesCommand } from "../src/run-task.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const runTaskSrc = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");

// ── CLAIM 1: the chosen cadence is stated with the measured number that decided it ────────────

/**
 * Checks that a prose blob states the W1-T448 cadence decision (manual verb, not a sweep rung)
 * AND backs it with the actual measured numbers — a request cost, a poll-cadence constant name,
 * and a rate-limit reading — rather than a bare assertion like "this is fine, trust us".
 */
export function checkCadenceDecisionIsMeasured(text: string): { ok: boolean; missing: string[] } {
  const requirements: Array<[string, RegExp]> = [
    ["states the decision (manual verb, not a sweep rung)", /manual verb,\s+not a sweep\s+rung/i],
    ["names the per-reap request cost", /gh api.{0,20}requests/is],
    ["cites the poll-cadence constant by name", /DEFAULT_POLL_INTERVAL_MS/],
    ["cites a live rate-limit reading (n/5,000 shape)", /\d,\d{3}\/5,000/],
    ["carries a measurement timestamp", /2026-08-12T\d{2}:\d{2}Z/],
    ["warns the numbers must be re-measured, not quoted forward", /re-measure/i],
  ];
  const missing = requirements.filter(([, re]) => !re.test(text)).map(([label]) => label);
  return { ok: missing.length === 0, missing };
}

test("reap-cadence: docs/operator-guide.md states the W1-T448 decision with the measured numbers that decided it", () => {
  const guide = readFileSync(join(REPO_ROOT, "docs", "operator-guide.md"), "utf8");
  const result = checkCadenceDecisionIsMeasured(guide);
  assert.ok(result.ok, `operator-guide.md is missing: ${result.missing.join(", ")}`);
});

test("reap-cadence falsifier: prose that only ASSERTS the decision (no numbers) turns the check RED", () => {
  const assertedOnly = "`rmd reap-branches` runs on no cadence — it is a manual verb, not a sweep rung. Trust us.";
  const result = checkCadenceDecisionIsMeasured(assertedOnly);
  assert.equal(result.ok, false);
  assert.ok(result.missing.length > 0, "an unmeasured assertion must name what evidence is absent");
});

test("reap-cadence: the cited poll-cadence constant actually exists and matches the number quoted in the docs", () => {
  const daemonSrc = readFileSync(join(REPO_ROOT, "src", "lib", "daemon.ts"), "utf8");
  assert.match(
    daemonSrc,
    /export const DEFAULT_POLL_INTERVAL_MS = 60_000;/,
    "the constant the docs cite must exist with the value the docs quote (60s) — a stale citation is worse than none",
  );
});

// ── CLAIM 2: a reap that fails does not abort the sweep pass it runs inside ───────────────────

/**
 * A reap can only abort a sweep pass if the sweep ever calls it INSIDE the pass. Extracts
 * `sweepCommand`'s own function body (up to the next top-level export) and reports whether it
 * references `reapBranchesCommand` at all.
 */
export function checkReapNeverRunsInsideSweep(src: string): { ok: boolean; reason?: string } {
  const start = src.indexOf("export async function sweepCommand(");
  if (start < 0) return { ok: false, reason: "sweepCommand not found in source" };
  const end = src.indexOf("export function buildEscalationCloser(", start);
  if (end < 0) return { ok: false, reason: "could not bound sweepCommand's body (next export not found)" };
  const body = src.slice(start, end);
  if (body.includes("reapBranchesCommand")) {
    return { ok: false, reason: "sweepCommand calls reapBranchesCommand — a reap failure could now abort a sweep pass" };
  }
  return { ok: true };
}

test("reap-cadence: sweepCommand never calls reapBranchesCommand — a reap cannot run, let alone fail, inside a sweep pass", () => {
  const result = checkReapNeverRunsInsideSweep(runTaskSrc);
  assert.ok(result.ok, result.reason);
});

test("reap-cadence falsifier: a sweepCommand body that DOES call reapBranchesCommand turns the check RED", () => {
  const wired =
    "export async function sweepCommand(rest) {\n  reapBranchesCommand([]);\n}\n" +
    "export function buildEscalationCloser(x) {}\n";
  const result = checkReapNeverRunsInsideSweep(wired);
  assert.equal(result.ok, false);
});

test("reap-cadence: `reap-branches` and `sweep` are dispatched as separate, mutually exclusive CLI verbs (independent processes)", () => {
  // Each verb gets its own `if (cmd === "...")` block ending in its own `process.exit`, so
  // invoking one can never run the other's body in the same process — the structural guarantee
  // behind "a reap failure cannot abort a sweep pass": they never share a call stack.
  assert.match(
    runTaskSrc,
    /if \(cmd === "reap-branches"\) \{\s*process\.exit\(reapBranchesCommand\(rest\)\);\s*\}/,
    "reap-branches must be its own dispatch branch with its own process.exit",
  );
  assert.match(
    runTaskSrc,
    /if \(cmd === "sweep"\) \{\s*process\.exit\(await sweepCommand\(rest\)\);\s*\}/,
    "sweep must be its own dispatch branch with its own process.exit",
  );
});

// ── CLAIM 3: the reaper still deletes nothing, whatever the cadence it is run at ──────────────

test("reap-cadence: no destructive call appears across several back-to-back invocations, standing in for any operator/cron cadence", () => {
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (args[0] === "ls-remote") return "abc123\trefs/heads/main\ndef456\trefs/heads/stale-one\n";
    if (args[0] === "merge-base") return ""; // ancestor: succeeds
    if (args[0] === "rev-parse") return "def4567890\n";
    // The reverse-drift citation scan (W1-T2226) uses `-o`; answer it as "every declared name is
    // cited outside the declaration block" so this test's synthetic "nothing is named in source"
    // world stays about the cadence/destructive-call claim, not reverse drift.
    if (args[0] === "grep" && args.includes("-o")) {
      return DECLARED_BRANCH_GUARDS.map((n) => `src/run-task.ts:1:${n}`).join("\n");
    }
    if (args[0] === "grep") throw new Error("exit 1: no match");
    if (cmd === "gh") return "[]";
    return "";
  };

  // Run it back to back, as an operator might on a tight manual loop, a cron firing every
  // minute, or a cron firing once a day — the cadence never changes what the verb DOES.
  const realLog = console.log;
  console.log = () => {};
  const codes: number[] = [];
  try {
    for (let i = 0; i < 5; i++) {
      codes.push(reapBranchesCommand([], { exec }));
    }
  } finally {
    console.log = realLog;
  }

  assert.deepEqual(codes, [0, 0, 0, 0, 0]);
  const destructive = calls.filter(
    (c) => c.includes("--delete") || c.includes("push") || c.includes("-D") || c.includes("--force"),
  );
  assert.deepEqual(
    destructive,
    [],
    "five back-to-back reaps issued zero destructive calls — the dry run stays dry at any cadence",
  );
});
