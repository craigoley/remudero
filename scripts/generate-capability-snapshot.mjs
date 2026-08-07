#!/usr/bin/env tsx
// scripts/generate-capability-snapshot.mjs
//
// CAPABILITY SNAPSHOT generator + drift gate (W1-T383), the generate-cli-reference.mjs (W1-T48)
// mold applied to MASTER-PLAN.md.
//
// WHY: MASTER-PLAN's hand-written "lanes sentence" changed truth FOUR TIMES in one day
// (2026-08-05: lanes wired dark #1363 -> dispatchLanes 2 #1365 -> 3 #1383 -> back to 2 #1394) and
// was STILL false the next morning -- a present-tense capability claim maintained as prose in a
// plan that merges 50-70 PRs/day cannot stay true. This script closes that class of drift for a
// first tranche of four claims by rendering them from the SAME sources production already reads,
// into a marker-fenced block this generator owns exclusively -- never a parallel literal a human
// can forget to update.
//
// GENERATABLE vs HAND-WRITTEN: only a present-tense capability claim derivable from ONE
// authoritative source belongs in the block (the four claims below). Intent, rationale, history
// and proposals stay hand-written prose around the block -- a generator has no authority over WHY.
//
// UNDETERMINED IS AN ANSWER (LAW-1/P48): a claim whose resolver cannot determine the answer
// renders `UNDETERMINED(<reason>)` on its own line, never a silently dropped line. Both the
// generate and --check paths assert the rendered line count equals the registered claim count,
// so a resolver that renders zero or multiple lines (a hand-editing mistake here, not a normal
// run) fails loud instead of silently under- or over-representing what is registered.
//
// The generated block is content-only (no timestamp) so it is byte-stable across runs when its
// sources (plan/policy.yaml, src/run-task.ts, .github/workflows/ci-gate.yml, state/'s daily-cost-
// ceiling override) haven't changed -- same discipline as scripts/generate-cli-reference.mjs.
//
// Because rewriting the block can change MASTER-PLAN.md's line count, THIS SAME INVOCATION also
// regenerates plan/plan-index.json (via generate-plan-index.mjs's own parsePlanIndex/
// serializePlanIndex -- one parser, never a second hand-copied one) so the index never goes stale
// relative to a block regeneration.
//
// Usage:
//   npm run capability-snapshot          # regenerate MASTER-PLAN.md's block + plan/plan-index.json
//   npm run capability-snapshot:check    # exit 1 if either committed file is stale
//
// Run directly with `tsx` (not plain `node`): two claims import from .ts modules (src/run-task.ts,
// src/lib/policy.ts), and only tsx's loader can import those from this script.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { RECON_MAX_TURNS } from "../src/run-task.ts";
import { loadPolicy, policyPath, resolveDailyCostCeiling } from "../src/lib/policy.ts";
import { parsePlanIndex, serializePlanIndex } from "./generate-plan-index.mjs";

const DEFAULT_ROOT = ".";
const DEFAULT_MASTER_PLAN = "MASTER-PLAN.md";
const DEFAULT_PLAN_INDEX = join("plan", "plan-index.json");

const BEGIN_MARKER = "<!-- CAPABILITY SNAPSHOT:BEGIN -->";
const END_MARKER = "<!-- CAPABILITY SNAPSHOT:END -->";

/**
 * The registered claim tranche (design note i). Each `resolve(root)` returns `{ value, source }`
 * on success or throws with a human-readable reason -- the ONLY two outcomes a resolver may
 * produce; there is no third "return nothing" path, which is what makes silent omission
 * unrepresentable in {@link renderClaimLine}.
 */
export const CLAIMS = [
  {
    label: "Daemon dispatch lanes",
    resolve(root) {
      const policy = loadPolicy(policyPath(root));
      return {
        value: String(policy.values.sweep.dispatchLanes),
        source: "`sweep.dispatchLanes` via `loadPolicy(policyPath(root))` (src/lib/policy.ts, plan/policy.yaml)",
      };
    },
  },
  {
    label: "Daily cost ceiling",
    resolve(root) {
      const policy = loadPolicy(policyPath(root));
      const effective = resolveDailyCostCeiling(root, policy);
      const provenance =
        effective.provenance === "overridden"
          ? `overridden from committed default $${effective.committedDefaultUsd}`
          : "committed default, no state/ override";
      return {
        value: `$${effective.usd} (${provenance})`,
        source: "`resolveDailyCostCeiling(root, policy)` (src/lib/policy.ts)",
      };
    },
  },
  {
    label: "Recon turn cap",
    resolve() {
      return {
        value: String(RECON_MAX_TURNS),
        source: "`RECON_MAX_TURNS` (src/run-task.ts)",
      };
    },
  },
  {
    label: "ci-gate REQUIRED checks",
    resolve(root) {
      const ciGatePath = join(root, ".github", "workflows", "ci-gate.yml");
      let doc;
      try {
        doc = parseYaml(readFileSync(ciGatePath, "utf8"));
      } catch (err) {
        throw new Error(`could not read/parse ${ciGatePath}: ${String(err)}`);
      }
      const raw = doc?.jobs?.["ci-gate"]?.env?.REQUIRED;
      if (typeof raw !== "string") {
        throw new Error(`${ciGatePath} has no jobs.ci-gate.env.REQUIRED string`);
      }
      let list;
      try {
        list = JSON.parse(raw);
      } catch (err) {
        throw new Error(`${ciGatePath}'s jobs.ci-gate.env.REQUIRED did not parse as JSON: ${String(err)}`);
      }
      if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")) {
        throw new Error(`${ciGatePath}'s jobs.ci-gate.env.REQUIRED did not parse to a string array`);
      }
      return {
        value: `${list.length} — ${list.join(", ")}`,
        source: "`REQUIRED` (.github/workflows/ci-gate.yml, job `ci-gate`)",
      };
    },
  },
];

/** Render one claim's line, or `UNDETERMINED(<reason>)` when its resolver throws (LAW-1/P48). */
export function renderClaimLine(claim, root) {
  try {
    const { value, source } = claim.resolve(root);
    return `- **${claim.label}**: ${value} — source: ${source}`;
  } catch (err) {
    return `- **${claim.label}**: UNDETERMINED(${(err instanceof Error ? err.message : String(err))})`;
  }
}

/** The full rendered block content (between, not including, the BEGIN/END markers). */
export function renderSnapshotBlock(root) {
  return CLAIMS.map((claim) => renderClaimLine(claim, root)).join("\n");
}

/**
 * Every rendered line is registered, and every registered claim renders exactly one line --
 * `UNDETERMINED(...)` counts (design note iv). A mismatch means a claim was silently dropped or a
 * resolver produced more/less than one line, and this throws rather than letting the mismatch
 * pass unnoticed inside a byte-compare.
 */
export function assertClaimCountParity(block) {
  const lines = block.split("\n").filter((line) => line.length > 0);
  if (lines.length !== CLAIMS.length) {
    throw new Error(
      `rendered ${lines.length} capability line(s) but ${CLAIMS.length} claim(s) are registered -- ` +
        `a claim was silently dropped (a resolver must return a value or throw, never omit its line).`,
    );
  }
}

/** Replace the text strictly between the BEGIN/END markers, leaving everything else -- including
 *  the markers themselves and the hand-written prose around them -- untouched. `sourceLabel` is
 *  used only to name the file in an error message; this function is otherwise a pure function of
 *  its two text arguments. */
export function spliceSnapshot(masterPlanText, freshBlock, sourceLabel = "the source file") {
  const beginCount = masterPlanText.split(BEGIN_MARKER).length - 1;
  const endCount = masterPlanText.split(END_MARKER).length - 1;
  if (beginCount === 0 || endCount === 0) {
    throw new Error(
      `${sourceLabel} is missing the ${JSON.stringify(BEGIN_MARKER)} / ${JSON.stringify(END_MARKER)} markers.`,
    );
  }
  if (beginCount > 1 || endCount > 1) {
    throw new Error(`${sourceLabel} must carry exactly one BEGIN/END marker pair, found ${beginCount}/${endCount}.`);
  }
  const beginIdx = masterPlanText.indexOf(BEGIN_MARKER);
  const endIdx = masterPlanText.indexOf(END_MARKER);
  if (endIdx < beginIdx) {
    throw new Error(`${sourceLabel}'s CAPABILITY SNAPSHOT END marker precedes its BEGIN marker.`);
  }
  const before = masterPlanText.slice(0, beginIdx + BEGIN_MARKER.length);
  const after = masterPlanText.slice(endIdx);
  return `${before}\n${freshBlock}\n${after}`;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", default: DEFAULT_ROOT },
      "master-plan": { type: "string", default: DEFAULT_MASTER_PLAN },
      "plan-index": { type: "string", default: DEFAULT_PLAN_INDEX },
      check: { type: "boolean", default: false },
    },
  });

  const root = values.root;
  const masterPlanPath = values["master-plan"];
  const planIndexPath = values["plan-index"];

  let freshBlock;
  try {
    freshBlock = renderSnapshotBlock(root);
    assertClaimCountParity(freshBlock);
  } catch (err) {
    console.error(`generate-capability-snapshot: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  let committedMasterPlan;
  try {
    committedMasterPlan = readFileSync(masterPlanPath, "utf8");
  } catch {
    console.error(`generate-capability-snapshot: ${masterPlanPath} does not exist.`);
    process.exitCode = 1;
    return;
  }

  let freshMasterPlan;
  try {
    freshMasterPlan = spliceSnapshot(committedMasterPlan, freshBlock, masterPlanPath);
  } catch (err) {
    console.error(`generate-capability-snapshot: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const freshPlanIndex = serializePlanIndex(parsePlanIndex(freshMasterPlan), masterPlanPath);

  if (values.check) {
    let ok = true;

    if (freshMasterPlan !== committedMasterPlan) {
      console.error(
        `generate-capability-snapshot: ${masterPlanPath}'s CAPABILITY SNAPSHOT block is STALE -- it does not ` +
          `match a fresh regeneration.\nRun 'npm run capability-snapshot' and commit the result.`,
      );
      ok = false;
    }

    let committedPlanIndex;
    try {
      committedPlanIndex = readFileSync(planIndexPath, "utf8");
    } catch {
      console.error(
        `generate-capability-snapshot: ${planIndexPath} does not exist -- run 'npm run capability-snapshot' to generate it.`,
      );
      ok = false;
    }
    if (committedPlanIndex !== undefined && committedPlanIndex !== freshPlanIndex) {
      console.error(
        `generate-capability-snapshot: ${planIndexPath} is STALE relative to a fresh ${masterPlanPath} regeneration.\n` +
          `Run 'npm run capability-snapshot' and commit the result.`,
      );
      ok = false;
    }

    if (!ok) {
      process.exitCode = 1;
      return;
    }
    console.log(
      `generate-capability-snapshot: OK -- ${masterPlanPath} and ${planIndexPath} match a fresh regeneration (${CLAIMS.length} claim(s)).`,
    );
    process.exitCode = 0;
    return;
  }

  writeFileSync(masterPlanPath, freshMasterPlan);
  writeFileSync(planIndexPath, freshPlanIndex);
  console.log(
    `generate-capability-snapshot: wrote ${masterPlanPath} and ${planIndexPath} (${CLAIMS.length} claim(s)).`,
  );
  process.exitCode = 0;
}

// Only run when executed directly (`tsx scripts/generate-capability-snapshot.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
