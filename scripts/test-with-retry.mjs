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

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/**
 * W1-T2715 — A TEST THAT WRITES INTO THE TRACKED TREE IS OBSERVED BY EVERY OTHER WORKER, and the
 * check for it belongs HERE, around the whole suite, rather than inside each test-file process.
 *
 * MEASURED, THREE INSTANCES IN ONE SESSION (2026-09-02), each found by accident rather than by a
 * gate: the shipped-tree check ran the REAL source-size ratchet against the REAL baseline and that
 * script RECORDS a newly-seen source file, so it wrote twice and left the tree dirty (worse than
 * debris — a test that writes a gate's own baseline MOVES the gate); a probe shard under
 * test/fixtures/ removed only in a `finally` survived a killed run and made the NEXT run fail that
 * suite's own "the probe shard must not already exist" assertion, READING AS A REGRESSION; and a
 * fixture task file was left modified in a third worktree.
 *
 * WHY NOT PER-PROCESS, WHICH IS WHAT THE SHARD FIRST DESCRIBED. That design was built and MEASURED
 * UNSOUND. `node --test` runs test files in parallel, so a per-process before/after snapshot sees
 * OTHER workers' in-flight fixtures and blames whoever happens to exit while they exist. Over the
 * full 13,961-test suite it fired three times and every one was a MISATTRIBUTION — the blamed
 * processes were not the creators, and run alone all four files involved were clean. The shard's
 * own falsifier names exactly that outcome: "Re-design rather than build if the check proves
 * unable to attribute a path to the process that made it under parallel execution."
 *
 * ONE PROCESS, ONE BEFORE, ONE AFTER. This wrapper spawns the suite exactly once (twice on the
 * retry path), so there is no concurrent writer to confuse it and no attribution to get wrong. It
 * also SEES CHILD-PROCESS WRITES — instance 1 was a spawned ratchet, which no in-process `fs`
 * wrapper could ever observe. Cost is two `git status` calls per SUITE (~104ms measured) against
 * ~2,148 for the per-process design (~112s).
 *
 * WHAT IS GIVEN UP, STATED: this names the PATH but not the test file that wrote it. Criterion 1
 * asks for the path, and finding the writer from it is one `git grep` — measured at under a minute
 * for all three instances above. A check that is right beats one that is precise and wrong.
 *
 * SNAPSHOT-AND-COMPARE, NEVER A BARE `git status`: a checkout may legitimately be dirty when a run
 * starts (an operator's own edits), and only paths absent BEFORE and present AFTER are the suite's.
 */

/** `git status --porcelain` as a sorted line set, or `null` when git could not be read at all —
 *  not a repo, no git binary, a permission error. `null`, never `[]`: "could not look" and "looked
 *  and found nothing" must not collapse into the same value. */
export function readTrackedTreeState(cwd = process.cwd(), runGit = defaultStatusReader) {
  try {
    return runGit(cwd).split("\n").filter(Boolean).sort();
  } catch {
    return null;
  }
}

function defaultStatusReader(cwd) {
  // UNTRACKED ENTRIES INCLUDED (no `-uno`): instance 2 was an untracked probe shard and it still
  // broke the next run. Measured cost of the two forms here: 52ms with untracked, 9ms without —
  // and the cheap one is blind to the instance that cost the most diagnosis.
  return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** Porcelain lines present after the suite and absent before it. `null` on either side ⇒ `[]`:
 *  an unreadable snapshot attributes nothing and must never render as "everything is new". A line
 *  that DISAPPEARED is not dirt either — a fixture cleaning up after itself is the healthy case. */
export function newTrackedTreeDirt(before, after) {
  if (before === null || after === null) return [];
  const seen = new Set(before);
  return after.filter((line) => !seen.has(line));
}

/** The message a dirty run prints, naming every path — a gate that reported only a count would
 *  cost the diagnosis the debris already costs. `null` when there is nothing to report. */
export function trackedTreeDirtReport(dirt) {
  if (dirt.length === 0) return null;
  return (
    `TRACKED-TREE DIRT: the suite left ${dirt.length} change(s) in the tracked tree, which every ` +
    `other worker in a concurrent run observes and the NEXT run reads as a regression:\n` +
    dirt.map((d) => `  ${d}`).join("\n") +
    `\nWrite fixtures under mkdtemp, never into the tracked tree. ` +
    `Find the writer with: git grep -n '<the path above>' -- test/ scripts/`
  );
}

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

  // W1-T2715: the BEFORE half, taken once around the whole suite — see this module's own doc for
  // why this is not per-test-process. Read before anything is spawned, so an operator's own
  // pre-existing edits are never attributed to the run.
  const treeBefore = readTrackedTreeState();

  const startedAt = Date.now();
  const first = await runOnce(cmd, args);
  if (first.code === 0) {
    return reportTrackedTreeDirt(treeBefore, 0);
  }

  if (process.env.TEST_RETRY === "0") {
    return reportTrackedTreeDirt(treeBefore, first.code);
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
    return reportTrackedTreeDirt(treeBefore, first.code);
  }

  const second = await runOnce(cmd, args);
  // Evidence-preserving on non-recovery too: a retry that ALSO fails (a deterministic break, or a
  // double flake) must leave its own greppable record rather than only the first attempt's — so a
  // break the retry did NOT paper over is just as countable as one it did.
  if (second.code !== 0) {
    recordFlakeEvidence("retry ALSO failed", parseFailingTestNames(second.output));
  }
  return reportTrackedTreeDirt(treeBefore, second.code);
}

/**
 * W1-T2715: the AFTER half. Called on EVERY return path, so a run that failed its tests still says
 * whether it also dirtied the tree — the two are independent facts and a red suite must not hide a
 * leak. Never LOWERS an exit code: a failing suite keeps its own code, and only a green-but-dirty
 * run is turned red by this. Reads git; writes nothing.
 */
function reportTrackedTreeDirt(treeBefore, code) {
  const report = trackedTreeDirtReport(newTrackedTreeDirt(treeBefore, readTrackedTreeState()));
  if (report === null) return code;
  process.stderr.write(`${report}\n`);
  recordFlakeEvidence("tracked-tree dirt", []);
  return code === 0 ? 1 : code;
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
