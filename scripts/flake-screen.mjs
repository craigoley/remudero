#!/usr/bin/env node
// scripts/flake-screen.mjs — a test file a pull request ADDS runs again and again, under load,
// before the pull request can merge.
//
// WHY: main went red three times on 2026-10-10 (about 1,170 PR-minutes held), and each red test
// was ADDED by a pull request whose own CI ran it ONCE, and passed. Selection was not the gap.
//   - a-starved-plan-pr-preflight-leg-times-out-and-is-asked-again (#10660) passed on its PR and
//     on four main runs, then failed both attempts at f76df1f45 (CI run 38059460748).
//   - a-missing-memory-ledger-never-reads-as-empty (#10344) raced a clock tick; first red dbca9031a.
// Replayed at their parents through {@link screen}, both went red within two minutes on a Mac.
//
// HOW MANY RUNS: no constant. The screen spends the time the pull request already waits for its
// slowest required lane: the coverage makespan the committed ledgers predict, from the packer the
// coverage shards use. A fast file repeats hundreds of times, a slow one a few, each at least once.
// HOW MUCH LOAD: twice availableParallelism() copies at once. MEASURED on a 10-core Mac at #10660's
// tree: 8 copies passed 197 runs in a row; 16 and 20 copies failed it in 9-20 s, 4 trials of 4.
//
// SCOPE: only files the pull request ADDS. A modified file can carry an inherited flake the screen
// cannot tell from a new one. A push, a merge group and every shard but 1 screen nothing.

import { spawn as spawnChild, spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgv } from "./lib/argv.mjs";
import {
  COVERAGE_SHARD_WORKERS,
  DEFAULT_CI_SHARD_COUNT,
  instrumentedManifest,
  listTestFiles,
  loadManifest,
  packFilesByMakespan,
  predictMakespanMs,
} from "./test-tier-manifest.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Test files (`test/**\/*.test.ts`) that `base...HEAD` adds and that exist in the tree. */
export function addedTestFiles(base, { cwd = ROOT, spawn = spawnSync } = {}) {
  const r = spawn("git", ["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", "test"], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git diff against ${base} failed: ${String(r.stderr ?? "").trim()}`);
  return r.stdout.split("\n").filter((f) => f.endsWith(".test.ts") && existsSync(join(cwd, f))).sort();
}

/** The predicted wall time of the slowest coverage shard: the time a pull request already waits. */
export function screenBudgetMs(root = ROOT) {
  const manifest = instrumentedManifest(
    loadManifest(join(root, "scripts/test-tier-manifest.json")),
    loadManifest(join(root, "scripts/test-tier-coverage-manifest.json")),
  );
  const shards = packFilesByMakespan(listTestFiles(root), manifest, DEFAULT_CI_SHARD_COUNT, COVERAGE_SHARD_WORKERS);
  return Math.max(0, ...shards.map((files) => predictMakespanMs(files, manifest, COVERAGE_SHARD_WORKERS)));
}

/** One `node --test` run of `file`, with the same preloads the suite runs under. */
export function runTestFile(file, root = ROOT) {
  return new Promise((done) => {
    const args = ["--test", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "--test-reporter=tap", file];
    // A run under a parent `node --test` inherits NODE_TEST_CONTEXT and reports to it, exiting 0 on a failure.
    const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
    const child = spawnChild(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => done({ ok: code === 0, output }));
  });
}

/**
 * Runs `files` round-robin on `concurrency` slots until `budgetMs` has passed and every file has
 * run once, or until a run fails. Returns each file's pass count and the first failure.
 */
export async function screen({ files, budgetMs, concurrency, runFile, now = Date.now }) {
  const passes = new Map(files.map((f) => [f, 0]));
  const started = now();
  let next = 0;
  let failure;
  const slot = async () => {
    while (failure === undefined && (next < files.length || now() - started < budgetMs)) {
      const file = files[next++ % files.length];
      const result = await runFile(file);
      if (result.ok) passes.set(file, passes.get(file) + 1);
      else failure ??= { file, passesBefore: passes.get(file), output: result.output };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, slot));
  return { passes, failure };
}

export async function main(argv, deps = {}) {
  const { values } = parseArgv(argv, { shard: { type: "string" }, list: { type: "boolean" } }, { allowPositionals: false });
  const env = deps.env ?? process.env;
  const root = deps.root ?? ROOT;
  const log = deps.log ?? console.log;
  if (!env.GITHUB_BASE_REF) {
    if (!values.list) log("flake-screen: no pull-request base (a push, a merge group, or a dispatch) — nothing was added to screen.");
    return 0;
  }
  const files = addedTestFiles(`origin/${env.GITHUB_BASE_REF}`, { cwd: root, spawn: deps.spawn });
  if (values.list) {
    for (const f of files) log(f);
    return 0;
  }
  if (values.shard !== "1" || files.length === 0) {
    log(`flake-screen: shard ${values.shard ?? "?"} — ${files.length} added test file(s); shard 1 screens them.`);
    return 0;
  }
  const budgetMs = deps.budgetMs ?? screenBudgetMs(root);
  const concurrency = deps.concurrency ?? 2 * availableParallelism();
  log(`flake-screen: ${files.length} added test file(s), ${concurrency} at a time, for ${Math.round(budgetMs / 1000)}s (the predicted coverage makespan).`);
  const { passes, failure } = await screen({
    files,
    budgetMs,
    concurrency,
    runFile: deps.runFile ?? ((f) => runTestFile(f, root)),
    now: deps.now,
  });
  for (const [file, n] of passes) log(`flake-screen: ${file} passed ${n} run(s).`);
  if (failure === undefined) return 0;
  log(failure.output);
  const line = `FLAKE-SCREEN: ${failure.file} failed after ${failure.passesBefore} passing run(s) — a test this pull request adds is nondeterministic.`;
  log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
  return 1;
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
