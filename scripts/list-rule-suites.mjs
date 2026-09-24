#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { listRuleSuites } from "../src/lib/ci-parity.ts";
import { isMainModule } from "./lib/argv.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

export function ruleSuites(repoRoot = root) {
  return listRuleSuites(repoRoot);
}

/** Execute one file at a time. Node's multi-file test runner may schedule files concurrently. */
export function runRuleSuites(repoRoot = root, run = spawnSync) {
  const suites = ruleSuites(repoRoot);
  let failed = false;
  for (const suite of suites) {
    console.log(`rule-checks: ${suite}`);
    const result = run(process.execPath, [
      "--test",
      "--import",
      "tsx",
      "--import",
      "./test/setup/tmp-hygiene.ts",
      suite,
    ], { cwd: repoRoot, stdio: "inherit" });
    if (result.error) {
      console.error(`rule-checks: ${suite}: ${result.error.message}`);
      failed = true;
    } else if (result.status !== 0) {
      console.error(`rule-checks: ${suite}: failed (${result.status ?? result.signal ?? "unknown status"})`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

/** The CLI: `--list` (the default) prints the population, `--run` executes it via `run`. */
export function main(argv, run = spawnSync) {
  if (argv.includes("--run")) return runRuleSuites(root, run);
  if (argv.length > 0 && !argv.includes("--list")) {
    console.error("usage: node --import tsx scripts/list-rule-suites.mjs [--list|--run]");
    return 2;
  }
  for (const suite of ruleSuites()) console.log(suite);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
