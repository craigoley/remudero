#!/usr/bin/env node
// scripts/test-with-retry.mjs — ONE bounded, evidence-preserving whole-command test retry
// (W1-T255).
//
// WHY: the merge gate runs the SAME ~90-file suite in TWO required check runs per PR (the `ci`
// job's `npm test`, and the `coverage-ratchet` job's same test/**/*.test.ts glob under
// --experimental-test-coverage) -- BOTH required, and `node --test` has no native retry facility.
// One nondeterministic (flaky) test therefore gets two independent chances to red an otherwise-
// unrelated PR's required checks, and today's only remedy -- a manual re-run -- OVERWRITES the
// job's own conclusion, so the flake's evidence disappears with it and the flake rate is
// unmeasurable (the gap W1-T220 deliberately left unfiled).
//
// THIS WRAPPER spawns the WHOLE command it is given, inheriting stdio (the CI log sees exactly
// what a direct invocation would show, live, in order) while also capturing that same output for
// parsing. A ZERO exit does nothing further -- the command is spawned EXACTLY ONCE on green, so a
// healthy PR pays no extra wall-time. A NON-ZERO exit:
//   1. parses the failing test names out of the first attempt's combined stdout+stderr,
//   2. prints ONE greppable, machine-countable line to stdout --
//      `FLAKE-RETRY: first attempt failed — <names>` -- and appends the same line to
//      $GITHUB_STEP_SUMMARY when that env var is set (CI), so the flake leaves a record instead
//      of erasing it,
//   3. re-runs the IDENTICAL WHOLE command exactly once. The final exit code is the SECOND run's.
//
// WHOLE-COMMAND, never per-test: the coverage job's lcov artifact must stay one coherent,
// single-run document, so coverage-ratchet.mjs / diff-coverage.mjs keep consuming exactly what
// they consume today (the SECOND run's lcov.info, written to the same path the first run wrote).
//
// A deterministic failure fails BOTH attempts -- red is unchanged, the retry cannot mask a real
// break. TEST_RETRY=0 disables the retry entirely (the first attempt's exit code is final) -- a
// kill switch for when the retry mechanism itself is suspected of hiding something real.
//
// W1-T2433: DO NOT START A PASS YOU CANNOT FINISH. The wrapper already knows how long pass 1
// took, because it waited for it. When $TEST_RETRY_BUDGET_SECONDS is set, pass 2 is spawned only
// when the remaining budget (budget minus pass 1's elapsed time) is at least what pass 1 itself
// consumed -- otherwise a second pass would be truncated by the job's own timeout, which returns
// a cancellation that names nothing rather than pass 1's real, already-diagnosed red. A declined
// retry still records pass 1's failing-test evidence and exits with pass 1's own code. This reads
// NO job bound (no timeout-minutes, no WAIT_CAP_SECONDS) -- only the budget the caller supplies
// via that one env var; when it is unset, behavior is byte-for-byte unchanged from before this
// task (the retry always fires on a non-zero first attempt, same as today).

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/**
 * Extracts failing test names from a Node test-runner run's combined output. Handles both
 * reporter shapes this repo's CI actually emits: TAP (`node --test`'s default when stdout is not
 * a TTY -- true for every CI invocation) and `spec` (explicitly requested by the coverage job's
 * dual-reporter step). Best-effort: a run whose output matches neither shape still retries, just
 * with an unnamed "(no test name parsed from output)" placeholder rather than failing to retry.
 */
export function parseFailingTestNames(output) {
  const names = new Set();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const tap = line.match(/^not ok \d+ - (.+)$/);
    if (tap) {
      names.add(tap[1].trim());
      continue;
    }
    const spec = line.match(/^\s*✖\s+(.+?)\s+\(\d+(?:\.\d+)?ms\)$/);
    if (spec) {
      names.add(spec[1].trim());
    }
  }
  return [...names];
}

function runOnce(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"] });
    let combined = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      combined += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      combined += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), output: combined });
    });
  });
}

/**
 * Parses $TEST_RETRY_BUDGET_SECONDS into a positive finite number of seconds, or `undefined` when
 * unset/blank/non-numeric/non-positive -- `undefined` means "no budget given," which preserves
 * this wrapper's pre-W1-T2433 behavior exactly (retry unconditionally on a non-zero first pass).
 * This is the ONLY job-bound-shaped input the wrapper reads; it never inspects `timeout-minutes`,
 * `WAIT_CAP_SECONDS`, or any other GitHub Actions-supplied timing signal.
 */
export function parseBudgetSeconds(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return undefined;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * DO NOT START A PASS YOU CANNOT FINISH. Given how long pass 1 took and the total budget the
 * caller was handed, decides whether pass 2 -- an identical whole-command re-run -- can plausibly
 * finish inside it. With no budget supplied, always retries (unchanged pre-W1-T2433 behavior).
 * With a budget, retries only when what's left (budget minus pass 1's elapsed time) is at least
 * what pass 1 itself consumed -- the same two-pass-at-the-median arithmetic the task is sized
 * against, expressed generically so it never hardcodes this repo's specific job bound.
 */
export function shouldAttemptRetry({ budgetSeconds, firstPassElapsedMs }) {
  if (budgetSeconds === undefined) {
    return true;
  }
  const firstPassSeconds = firstPassElapsedMs / 1000;
  const remainingSeconds = budgetSeconds - firstPassSeconds;
  return remainingSeconds >= firstPassSeconds;
}

function recordFlakeEvidence(headline, names) {
  const label = names.length > 0 ? names.join(", ") : "(no test name parsed from output)";
  const line = `FLAKE-RETRY: ${headline} — ${label}`;
  console.log(line);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, line + "\n");
  }
}

export async function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd) {
    console.error("usage: test-with-retry.mjs <command> [args...]");
    return 2;
  }

  const startedAt = Date.now();
  const first = await runOnce(cmd, args);
  if (first.code === 0) {
    return 0;
  }

  if (process.env.TEST_RETRY === "0") {
    return first.code;
  }

  const firstPassElapsedMs = Date.now() - startedAt;
  const firstNames = parseFailingTestNames(first.output);
  recordFlakeEvidence("first attempt failed", firstNames);

  const budgetSeconds = parseBudgetSeconds(process.env.TEST_RETRY_BUDGET_SECONDS);
  if (!shouldAttemptRetry({ budgetSeconds, firstPassElapsedMs })) {
    const firstPassSeconds = (firstPassElapsedMs / 1000).toFixed(1);
    const remainingSeconds = (budgetSeconds - firstPassElapsedMs / 1000).toFixed(1);
    recordFlakeEvidence(
      `declined retry — pass 1 took ${firstPassSeconds}s, leaving ${remainingSeconds}s of a ` +
        `${budgetSeconds}s budget, not enough for another pass`,
      firstNames,
    );
    return first.code;
  }

  const second = await runOnce(cmd, args);
  // Evidence-preserving on non-recovery too: a retry that ALSO fails (a deterministic break, or a
  // double flake) must leave its own greppable record rather than only the first attempt's — so a
  // break the retry did NOT paper over is just as countable as one it did.
  if (second.code !== 0) {
    recordFlakeEvidence("retry ALSO failed", parseFailingTestNames(second.output));
  }
  return second.code;
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
