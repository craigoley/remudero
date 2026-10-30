#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import { listRuleSuites } from "../src/lib/ci-parity.ts";
import { isMainModule } from "./lib/argv.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

export function ruleSuites(repoRoot = root) {
  return listRuleSuites(repoRoot);
}

// The spec reporter, named: W1-T7848's failed-suite reader parses its `✖ failing tests:` block.
const suiteArgs = (suite) => ["--test", "--test-reporter=spec", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", suite];

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

/** Execute one file per child process, one at a time. Node's multi-file test runner may schedule files
 *  concurrently inside one runner; each suite here keeps a process of its own. */
export function runRuleSuites(repoRoot = root, run = spawnSync) {
  const suites = ruleSuites(repoRoot);
  const failed = new Set();
  for (const suite of suites) {
    console.log(`rule-checks: ${suite}`);
    if (reportSuite(suite, run(process.execPath, suiteArgs(suite), { cwd: repoRoot, stdio: "inherit" }))) failed.add(suite);
  }
  return finish(suites, failed);
}

/** Run one suite with its output captured, so concurrent suites never interleave their lines. */
export function spawnSuiteCaptured(suite, repoRoot) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(process.execPath, suiteArgs(suite), { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
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
export async function runRuleSuitesConcurrently(repoRoot = root, { concurrency = 1, run = spawnSuiteCaptured, write = (text) => process.stdout.write(text) } = {}) {
  const suites = ruleSuites(repoRoot);
  const failed = new Set();
  let next = 0;
  const worker = async () => {
    while (next < suites.length) {
      const suite = suites[next++];
      const result = await run(suite, repoRoot);
      console.log(`rule-checks: ${suite}`);
      if (result.output) write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
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

/** The CLI: `--list` (the default) prints the population, `--run` executes it {@link ruleSuiteConcurrency}
 *  suites at a time, or one at a time through an injected `run`. */
export function main(argv, run, concurrency = ruleSuiteConcurrency(), runConcurrently = runRuleSuitesConcurrently) {
  if (argv.includes("--run")) {
    if (run !== undefined || concurrency === 1) return runRuleSuites(root, run ?? spawnSync);
    return runConcurrently(root, { concurrency });
  }
  if (argv.length > 0 && !argv.includes("--list")) {
    console.error("usage: node --import tsx scripts/list-rule-suites.mjs [--list|--run]");
    return 2;
  }
  for (const suite of ruleSuites()) console.log(suite);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
