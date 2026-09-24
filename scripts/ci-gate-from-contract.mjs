#!/usr/bin/env node
// scripts/ci-gate-from-contract.mjs — W1-T4400: run ci-gate.yml's OWN aggregation step from ci.yml.
//
// ci-gate used to be a pull_request job in ci-gate.yml that started with ci.yml and polled the
// check-runs API until every required check finished — holding a runner for the whole CI run (up to
// its 2400 s wait cap; ~77k job-min/month) to do a few seconds of work. It now also runs as the LAST
// job of ci.yml, `needs:`-ordered after every other ci.yml job, so it starts only when they have
// finished and consumes nothing while it waits. MEASURED over the 14 PRs merged before 2026-09-24:
// ci.yml's own checks end 7-26 min in, and every required check from another workflow had ended by
// minute 4 — so the step's own wait loop finds nothing left to wait for in practice.
//
// ONE COPY OF THE GATE. ci-gate.yml stays the contract: its REQUIRED / IGNORE / ADVISORY lists (read by
// src/lib/ci-gate-required.ts and a dozen suites) and its aggregation script (driven verbatim by the
// ci-gate-* suites). This runner reads both from that file at job time rather than restating them, so
// the two ci-gate entry points can never disagree. Env values that are Actions expressions are left to
// the calling job, which supplies GH_TOKEN, REPO and SHA itself.
//
// Usage: node scripts/ci-gate-from-contract.mjs [--contract <path>]   (exits with the step's own code)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isMainModule } from "./lib/argv.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

export const CONTRACT_PATH = ".github/workflows/ci-gate.yml";

/** The aggregation step and its literal env, read from ci-gate.yml's `ci-gate` job. Throws when the
 *  contract has no such step: a gate that cannot find its own logic must never report success. */
export function contractRun(text) {
  const doc = parseYaml(text);
  const job = doc?.jobs?.["ci-gate"];
  const step = (job?.steps ?? []).find((s) => typeof s.run === "string" && s.run.includes("runs_json"));
  if (!step) throw new Error(`ci-gate-from-contract: ${CONTRACT_PATH} has no ci-gate step defining runs_json()`);
  const env = Object.fromEntries(
    Object.entries(job.env ?? {}).filter(([, value]) => !String(value).includes("${{")).map(([key, value]) => [key, String(value)]),
  );
  return { env, script: step.run };
}

export function main(argv, { root = REPO_ROOT, run = spawnSync } = {}) {
  const at = argv.indexOf("--contract");
  const path = at >= 0 ? argv[at + 1] : join(root, CONTRACT_PATH);
  const { env, script } = contractRun(readFileSync(path, "utf8"));
  // The caller's own values win: it holds the live token, repository and head sha.
  const result = run("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script], {
    stdio: "inherit",
    env: { ...env, ...process.env },
  });
  return result.status ?? 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
