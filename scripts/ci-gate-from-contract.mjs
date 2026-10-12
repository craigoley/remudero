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
// W1-T5515: `--event merge_group` gates a merge queue's group commit on the contract's
// MERGE_GROUP_REQUIRED (the REQUIRED names a group commit produces) instead of the full pull_request
// list, which names checks that never register there and would time out. The mode comes ONLY from
// the flag, never from an ambient GITHUB_EVENT_NAME: suites run this with `...process.env`, and CI
// itself runs them on a group commit. Any other event, or none, is the unchanged full-list gate.
//
// Usage: node scripts/ci-gate-from-contract.mjs [--contract <path>] [--event <name>]
//        (exits with the step's own code, or 1 when the merge-group list is refused)
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

export const MERGE_GROUP_EVENT = "merge_group";

/** A JSON array of strings, or a named throw: a list the gate cannot read must never pass. */
function nameList(key, raw) {
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error(`${key} is not valid JSON`);
  }
  if (!Array.isArray(list) || list.some((name) => typeof name !== "string")) {
    throw new Error(`${key} is not a JSON array of strings`);
  }
  return list;
}

/** The contract's merge-group list, validated against its REQUIRED list. Throws, naming the defect,
 *  when it is absent, unreadable, EMPTY (the wait loop would compare nothing and pass) or names a
 *  check outside REQUIRED. Reads the CONTRACT's literal env only, never the caller's environment. */
export function mergeGroupRequired(env) {
  if (env.MERGE_GROUP_REQUIRED === undefined) throw new Error(`${CONTRACT_PATH} declares no MERGE_GROUP_REQUIRED`);
  const list = nameList("MERGE_GROUP_REQUIRED", env.MERGE_GROUP_REQUIRED);
  if (list.length === 0) throw new Error("MERGE_GROUP_REQUIRED is EMPTY, which would gate on nothing");
  const required = nameList("REQUIRED", env.REQUIRED ?? "");
  const outside = list.filter((name) => !required.includes(name));
  if (outside.length > 0) throw new Error(`MERGE_GROUP_REQUIRED names check(s) outside REQUIRED: ${outside.join(", ")}`);
  return JSON.stringify(list);
}

export function main(argv, { root = REPO_ROOT, run = spawnSync } = {}) {
  const at = argv.indexOf("--contract");
  const path = at >= 0 ? argv[at + 1] : join(root, CONTRACT_PATH);
  const eventAt = argv.indexOf("--event");
  const event = eventAt >= 0 ? argv[eventAt + 1] : undefined;
  const { env, script } = contractRun(readFileSync(path, "utf8"));
  // The caller's own values win: it holds the live token, repository and head sha.
  const childEnv = { ...env, ...process.env };
  if (event === MERGE_GROUP_EVENT) {
    try {
      // Applied AFTER the merge above, so no ambient REQUIRED can widen or empty the group's list.
      childEnv.REQUIRED = mergeGroupRequired(env);
    } catch (error) {
      process.stderr.write(`::error::ci-gate-from-contract: refusing the merge_group gate: ${error.message}\n`);
      return 1;
    }
  }
  const result = run("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script], {
    stdio: "inherit",
    env: childEnv,
  });
  return result.status ?? 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
