#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { listRuleSuites } from "../src/lib/ci-parity.ts";
import { isMainModule } from "./lib/argv.mjs";
import { boundedNodeTestArgs } from "./test-tier-manifest.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

export function ruleSuites(repoRoot = root) {
  return listRuleSuites(repoRoot);
}

// The spec reporter, named: W1-T7848's failed-suite reader parses its `✖ failing tests:` block.
const suiteArgs = (suite, repoRoot) => boundedNodeTestArgs(["--test", "--test-reporter=spec", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", suite], repoRoot);

/** Record one suite's outcome; `true` when it failed. */
function reportSuite(suite, result) {
  if (result.error) {
    console.error(`rule-checks: ${suite}: ${result.error.message}`);
    return true;
  }
  if (result.status !== 0) {
    console.error(`rule-checks: ${suite}: failed (${result.status ?? result.signal ?? "unknown status"})`);
    return true;
  }
  return false;
}

/** A failing run's last line names every failed suite, in population order (W1-T7848): the sweep's
 *  base-reproduction probe reads it. */
function finish(suites, failedSet) {
  const failed = suites.filter((suite) => failedSet.has(suite));
  if (failed.length === 0) return 0;
  console.error(`rule-checks: failed suites: ${failed.join(" ")}`);
  return 1;
}

/** W1-T12401 — time one suite child from spawn to exit. `invoke` starts it and returns its result, or a
 *  promise of one; the helper never touches the child's arguments or environment. */
export function timedSuiteRun(invoke, now = () => performance.now()) {
  const started = now();
  const settle = (result) => ({ result, ms: Math.round(now() - started) });
  const outcome = invoke();
  return typeof outcome?.then === "function" ? outcome.then(settle) : settle(outcome);
}

/** The one timing line per suite: stdout, so the stderr verdict lines and the closing line keep their place. */
const reportTime = (suite, ms) => console.log(`rule-checks: ${suite}: ${ms} ms`);

/** Execute one file per child process, one at a time. Node's multi-file test runner may schedule files
 *  concurrently inside one runner; each suite here keeps a process of its own. */
export function runRuleSuites(repoRoot = root, run = spawnSync, now) {
  const suites = ruleSuites(repoRoot);
  const failed = new Set();
  for (const suite of suites) {
    console.log(`rule-checks: ${suite}`);
    const { result, ms } = timedSuiteRun(() => run(process.execPath, suiteArgs(suite, repoRoot), { cwd: repoRoot, stdio: "inherit" }), now);
    reportTime(suite, ms);
    if (reportSuite(suite, result)) failed.add(suite);
  }
  return finish(suites, failed);
}

/** Run one suite with its output captured, so concurrent suites never interleave their lines. */
export function spawnSuiteCaptured(suite, repoRoot) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(process.execPath, suiteArgs(suite, repoRoot), { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const output = () => Buffer.concat(chunks).toString();
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    // A child that never starts emits `error` and may never emit `close`; the first settles the suite.
    child.once("error", (error) => resolve({ status: null, error, output: output() }));
    child.once("close", (status, signal) => resolve({ status, signal, output: output() }));
  });
}

/** 134 suites one at a time took ~11 of light-gates' 15 minutes, and 3 of 55 runs hit that ceiling (2026-10-29).
 *  Still one file per child process, `concurrency` at a time; each suite prints its header and output as one
 *  block when it ends, and the closing line is the same as {@link runRuleSuites}'. */
export async function runRuleSuitesConcurrently(repoRoot = root, { concurrency = 1, run = spawnSuiteCaptured, write = (text) => process.stdout.write(text), now } = {}) {
  const suites = ruleSuites(repoRoot);
  const failed = new Set();
  let next = 0;
  const worker = async () => {
    while (next < suites.length) {
      const suite = suites[next++];
      const { result, ms } = await timedSuiteRun(() => run(suite, repoRoot), now);
      console.log(`rule-checks: ${suite}`);
      if (result.output) write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
      reportTime(suite, ms);
      if (reportSuite(suite, result)) failed.add(suite);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, suites.length)) }, worker));
  return finish(suites, failed);
}

/** How many suites `--run` executes at once: `RMD_RULE_SUITE_CONCURRENCY` when it is a positive integer,
 *  else the machine's available parallelism. */
export function ruleSuiteConcurrency(env = process.env, cores = availableParallelism()) {
  const raw = env.RMD_RULE_SUITE_CONCURRENCY;
  if (raw !== undefined && /^[1-9]\d*$/.test(raw)) return Number(raw);
  return Math.max(1, cores);
}

/** The middle of an ascending list; the mean of the two middles when its length is even. */
function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** W1-T12401 — `--measure-starts <n> [suite]`: start one suite child `n` times, one after another, in the
 *  caller's environment (no `env` of its own, so a NODE_COMPILE_CACHE is measured only when the caller sets
 *  one), and print each start, then the median and the min and max. Exits 1 when any start fails. */
export function measureSuiteStarts(n, suite, { repoRoot = root, run = spawnSync, now } = {}) {
  const times = [];
  let failed = false;
  for (let start = 1; start <= n; start += 1) {
    const { result, ms } = timedSuiteRun(() => run(process.execPath, suiteArgs(suite, repoRoot), { cwd: repoRoot, stdio: "ignore" }), now);
    console.log(`rule-checks: measure-starts: ${suite}: start ${start}/${n}: ${ms} ms`);
    if (reportSuite(suite, result)) failed = true;
    times.push(ms);
  }
  const sorted = [...times].sort((a, b) => a - b);
  console.log(`rule-checks: measure-starts: ${suite}: n=${n} median ${median(sorted)} ms, min ${sorted[0]} ms, max ${sorted.at(-1)} ms`);
  return failed ? 1 : 0;
}

const USAGE = "usage: node --import tsx scripts/list-rule-suites.mjs [--list|--run] | --measure-starts <n> [suite]";

/** The CLI: `--list` (the default) prints the population, `--run` executes it {@link ruleSuiteConcurrency}
 *  suites at a time, or one at a time through an injected `run`, and `--measure-starts <n> [suite]` times
 *  `n` starts of one suite (the population's first when none is named). */
export function main(argv, run, concurrency = ruleSuiteConcurrency(), runConcurrently = runRuleSuitesConcurrently) {
  if (argv[0] === "--measure-starts") {
    const [, count, suite = ruleSuites()[0], ...extra] = argv;
    if (!/^[1-9]\d*$/.test(count ?? "") || extra.length > 0) {
      console.error(USAGE);
      return 2;
    }
    return measureSuiteStarts(Number(count), suite, { run: run ?? spawnSync });
  }
  if (argv.includes("--run")) {
    if (run !== undefined || concurrency === 1) return runRuleSuites(root, run ?? spawnSync);
    return runConcurrently(root, { concurrency });
  }
  if (argv.length > 0 && !argv.includes("--list")) {
    console.error(USAGE);
    return 2;
  }
  for (const suite of ruleSuites()) console.log(suite);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
