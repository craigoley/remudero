#!/usr/bin/env node
// scripts/gate-monotonic-check.mjs (W1-T3519)
//
// Nothing compared the REQUIRED GATE SET against `origin/main` before this script. The census in
// test/every-pr-check-is-required-or-advisory.test.ts refuses a job in NEITHER list, and its own
// falsifier covers exactly that -- a name DELETED from REQUIRED and not added to ADVISORY. It does
// not cover a name MOVED between them, because a moved name still satisfies "in exactly one list".
//
// MEASURED 2026-09-13: moving "head-identity-gate" from REQUIRED to ADVISORY in ci-gate.yml --
// one line between two JSON arrays, which silently stops a required merge gate from blocking --
// passed that suite 9/9. A PR can therefore weaken the gate set that governs its own merge, which
// is the second half of the problem W1-T204 names (the `scripts/*-baseline.json` half is already
// closed by baseline-monotonic-check.mjs, whose shape this script copies deliberately).
//
// THE REMEDY IS SELF-SERVICE, NOT AN OPERATOR. A demotion is legitimate often enough that refusing
// it outright would stall the queue; what it must not be is SILENT. So a regression passes on a
// fresh `GATE_RATIONALE` naming the PR/task that reviewed it -- the same escape hatch, with the
// same staleness rule, that baseline-monotonic-check.mjs already uses for a score floor.
//
// EXIT CODES: 0 clean, 1 refused (a demotion with no fresh reviewed rationale), 2 could not
// measure (unreadable or unparseable ci-gate.yml at either ref, invalid arguments). A run that
// cannot measure must never report OK.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { isMainModule } from "./lib/argv.mjs";
import { git } from "./lib/git.mjs";

export const DEFAULT_BASE_REF = "origin/main";
export const CI_GATE_REL = ".github/workflows/ci-gate.yml";

const PR_REFERENCE_RE = /(#\d+|W1-T\d+)/;

/** A reviewed demotion names itself: non-empty, and carrying a `#<n>` or `W1-T<n>` reference.
 *  Identical contract to `bumpRationaleNamesAPr` (baseline-monotonic-check.mjs). */
export function gateRationaleNamesAPr(rationale) {
  return typeof rationale === "string" && rationale.trim().length > 0 && PR_REFERENCE_RE.test(rationale);
}

/** The `ci-gate` job's REQUIRED set plus its GATE_RATIONALE, from one ci-gate.yml's text.
 *  Throws on anything it cannot read -- the caller turns that into exit 2, never into a pass. */
export function readGateLists(yamlText) {
  const doc = parseYaml(yamlText);
  const env = doc?.jobs?.["ci-gate"]?.env;
  if (!env || typeof env.REQUIRED !== "string") {
    throw new Error("ci-gate.yml declares no jobs['ci-gate'].env.REQUIRED");
  }
  const required = JSON.parse(env.REQUIRED);
  if (!Array.isArray(required) || !required.every((x) => typeof x === "string")) {
    throw new Error("ci-gate.yml's env.REQUIRED is not a JSON array of strings");
  }
  return { required: new Set(required), rationale: typeof env.GATE_RATIONALE === "string" ? env.GATE_RATIONALE : undefined };
}

/**
 * Pure verdict. Every context REQUIRED at the base and not REQUIRED at head is a DEMOTION --
 * whichever list it landed in, or none at all, since the consequence is identical: it stops
 * blocking the merge. ADDING a gate is never a regression and needs no rationale.
 *
 * A demotion passes only when `head.rationale` names a PR/task AND differs from `base.rationale`,
 * so a rationale left over from an earlier reviewed demotion cannot cover a fresh one.
 */
export function evaluateGateMonotonic(base, head) {
  const demoted = [...base.required].filter((name) => !head.required.has(name)).sort();
  if (demoted.length === 0) {
    return { ok: true, demoted, status: "clean", detail: "no context left REQUIRED" };
  }
  if (!gateRationaleNamesAPr(head.rationale)) {
    return {
      ok: false,
      demoted,
      status: "unreviewed",
      detail:
        `${demoted.length} context(s) left REQUIRED with no reviewed GATE_RATIONALE: ${demoted.join(", ")}. ` +
        "Add `GATE_RATIONALE` to ci-gate.yml's `ci-gate` job env naming the PR or task that reviewed " +
        "this (e.g. \"#1234: <job> is superseded by <x>\"). Demoting a gate is an ordinary reviewed " +
        "outcome, not a defeat -- what it must not be is silent.",
    };
  }
  if (head.rationale === base.rationale) {
    return {
      ok: false,
      demoted,
      status: "stale-rationale",
      detail:
        `${demoted.length} context(s) left REQUIRED (${demoted.join(", ")}) under a GATE_RATIONALE ` +
        "identical to origin/main's. A rationale carried over from an earlier reviewed demotion does " +
        "not review this one -- write a fresh one naming THIS change.",
    };
  }
  return { ok: true, demoted, status: "reviewed", detail: `${demoted.length} reviewed demotion(s): ${demoted.join(", ")}` };
}

export function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { "base-ref": { type: "string" }, "repo-root": { type: "string" } } }));
  } catch (err) {
    console.error(`gate-monotonic: MEASUREMENT FAILED -- invalid arguments: ${String(err?.message ?? err)}`);
    return 2;
  }
  const baseRef = values["base-ref"] ?? DEFAULT_BASE_REF;
  const repoRoot = resolve(values["repo-root"] ?? process.cwd());

  let base, head;
  try {
    const shown = git(["show", `${baseRef}:${CI_GATE_REL}`], { cwd: repoRoot });
    if (shown.error || shown.status !== 0) throw new Error(`cannot read ${CI_GATE_REL} at ${baseRef}`);
    base = readGateLists(shown.stdout);
  } catch (err) {
    console.error(`gate-monotonic: MEASUREMENT FAILED -- base ${baseRef}: ${String(err?.message ?? err)}`);
    return 2;
  }
  try {
    head = readGateLists(readFileSync(join(repoRoot, CI_GATE_REL), "utf8"));
  } catch (err) {
    console.error(`gate-monotonic: MEASUREMENT FAILED -- head: ${String(err?.message ?? err)}`);
    return 2;
  }

  const verdict = evaluateGateMonotonic(base, head);
  if (!verdict.ok) {
    console.error(`gate-monotonic: REFUSED -- ${verdict.detail}`);
    return 1;
  }
  console.log(
    `gate-monotonic: OK -- ${base.required.size} context(s) REQUIRED at ${baseRef}, ${head.required.size} at head; ${verdict.detail}.`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
