#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ciControlPlaneParity, derivePrCheckCandidates, findPrCheckRegistryGaps, loadCiGateLists, loadWorkflowDocuments } from "../src/lib/ci-control-plane.ts";
import { CI_PARITY_TABLE, parseCiJobNames } from "../src/lib/ci-parity.ts";
import { isMainModule } from "./lib/argv.mjs";
import { gitOrThrow } from "./lib/git.mjs";

const CONTROL_PLANE_INPUTS = [".github/workflows/", "src/lib/ci-parity.ts", "src/lib/ci-control-plane.ts"];
const CAPABILITY_SNAPSHOT_INPUTS = [
  "MASTER-PLAN.md",
  "plan/plan-index.json",
  "plan/policy.yaml",
  "src/run-task.ts",
  "src/lib/policy.ts",
  ".github/workflows/ci-gate.yml",
  "scripts/generate-capability-snapshot.mjs",
];

function changedFiles(base) {
  return gitOrThrow(["diff", "--name-only", `${base}...HEAD`]).split("\n").filter(Boolean);
}

export function affectedControlPlane(files) {
  return files.some((file) => CONTROL_PLANE_INPUTS.some((input) => input.endsWith("/") ? file.startsWith(input) : file === input));
}

export function affectedCapabilitySnapshot(files) {
  return files.some((file) => CAPABILITY_SNAPSHOT_INPUTS.includes(file));
}

export function staticControlPlaneVerdict(repoRoot) {
  const lists = loadCiGateLists(repoRoot);
  const candidates = loadWorkflowDocuments(repoRoot).flatMap(({ relPath, doc }) => derivePrCheckCandidates(relPath, doc));
  const registryGaps = findPrCheckRegistryGaps(candidates, lists.required, lists.advisory, lists.ignore);
  const ciYaml = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const parity = ciControlPlaneParity(parseCiJobNames(ciYaml), CI_PARITY_TABLE);
  return { ok: registryGaps.length === 0 && parity.ok, registryGaps, parityProblems: parity.problems };
}

export function runCiControlPlanePrecheck({ base = "origin/main", repoRoot = process.cwd(), readChangedFiles = changedFiles, runCapabilitySnapshot = undefined, log = console.log, error = console.error } = {}) {
  let files;
  try {
    files = readChangedFiles(base);
  } catch (cause) {
    error(`ci-control-plane-precheck: could not read the diff against ${base} (${cause instanceof Error ? cause.message : String(cause)}) — REFUSING to report clean`);
    return 2;
  }
  const controlPlane = affectedControlPlane(files);
  const capability = affectedCapabilitySnapshot(files);
  if (!controlPlane && !capability) {
    log("ci-control-plane-precheck: SKIP -- this diff does not change a control-plane or capability-snapshot input");
    return 0;
  }
  if (controlPlane) {
    let verdict;
    try {
      verdict = staticControlPlaneVerdict(repoRoot);
    } catch (cause) {
      error(`ci-control-plane-precheck: REFUSED -- static control-plane inputs are unreadable or invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 1;
    }
    if (!verdict.ok) {
      for (const gap of verdict.registryGaps) error(`ci-control-plane-precheck: REFUSED -- pull_request check '${gap}' is absent from .github/workflows/ci-gate.yml REQUIRED, ADVISORY, and IGNORE`);
      for (const problem of verdict.parityProblems) error(`ci-control-plane-precheck: REFUSED -- ${problem}; reconcile .github/workflows/ci.yml with src/lib/ci-parity.ts`);
      return 1;
    }
  }
  if (capability) {
    const result = runCapabilitySnapshot ?? (() => spawnSync(process.execPath, ["--import", "tsx", "scripts/generate-capability-snapshot.mjs", "--check"], { cwd: repoRoot, encoding: "utf8" }))();
    if (result.status !== 0) {
      error(`ci-control-plane-precheck: REFUSED -- capability snapshot is stale; run 'npm run capability-snapshot' and commit its outputs.\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}`);
      return 1;
    }
  }
  log(`ci-control-plane-precheck: OK -- checked ${controlPlane ? "workflow registry and CI parity" : ""}${controlPlane && capability ? " plus " : ""}${capability ? "capability snapshot freshness" : ""}`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(runCiControlPlanePrecheck());
