#!/usr/bin/env node
// scripts/baseline-monotonic-check.mjs (W1-T2906)
//
// Nothing compared a `scripts/*-baseline.json` SCORE against `origin/main` before this script: a
// PR that edited the JSON to a lower floor (or a higher ceiling) passed its own ratchet by
// construction, because every ratchet reads its baseline from the PR's own tree. This checks each
// row in SCORE_TABLE against `git show <base>:<path>` and refuses a regression unless the working
// tree also carries a fresh `bumpRationale` naming the PR/task that reviewed it.
//
// SCOPE, drawn from the LEDGER/FLOOR line src/lib/review.ts's ENTANGLEMENT_EXEMPT_INSTRUMENTS
// comment already states: a SCORE FLOOR (or ceiling) grades a falsifier, so lowering (or raising)
// it lets a weakened suite pass. A per-file LEDGER (source-size, comment-load, clock-signature,
// knowledge-budget) grades nothing -- raising one row records debt on that row alone and cannot
// make a failing falsifier pass -- so those stay out of SCORE_TABLE; test/catch-erasure-ratchet.
// test.ts covers the census half (allowances that must track the code downward).
//
// EXIT CODES: 0 clean, 1 refused (a regression with no reviewed bumpRationale), 2 could not
// measure (bad JSON, an unreadable file, invalid arguments). A run that cannot measure must never
// report OK.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const DEFAULT_BASE_REF = "origin/main";

/** One row per SCALAR score field this check holds monotonic. `direction: "increase"` is a FLOOR
 *  (a drop is the regression); `direction: "decrease"` is a CEILING (a rise is the regression). */
export const SCORE_TABLE = [
  { path: "scripts/coverage-baseline.json", field: "linesPct", direction: "increase" },
  { path: "scripts/mutation-baseline.json", field: "scorePct", direction: "increase" },
  { path: "scripts/cycle-baseline.json", field: "maxCycles", direction: "decrease" },
  { path: "scripts/claude-md-budget-baseline.json", field: "capBytes", direction: "decrease" },
  { path: "scripts/learnings-budget-baseline.json", field: "capChars", direction: "decrease" },
];

const PR_REFERENCE_RE = /(#\d+|W1-T\d+)/;

/** `true` when `newValue` moved the WRONG way for `direction` -- the ratchet's own regression. */
export function isRegression(oldValue, newValue, direction) {
  return direction === "increase" ? newValue < oldValue : newValue > oldValue;
}

/** A reviewed bump names itself: non-empty, and carrying a `#<n>` or `W1-T<n>` reference. */
export function bumpRationaleNamesAPr(rationale) {
  return typeof rationale === "string" && rationale.trim().length > 0 && PR_REFERENCE_RE.test(rationale);
}

/**
 * Pure verdict for one {@link SCORE_TABLE} row. `oldJson` is `undefined` when the file did not
 * exist at the base ref -- a brand-new baseline has nothing to regress against and always passes.
 * A regression passes only when `newJson.bumpRationale` names a PR/task AND differs from
 * `oldJson.bumpRationale` -- a stale rationale, carried over from an earlier reviewed move, must
 * not cover a fresh one.
 */
export function evaluateRow(entry, oldJson, newJson) {
  const { path, field, direction } = entry;
  if (oldJson === undefined) {
    return { ...entry, status: "new", ok: true, detail: `${path}: new baseline file, nothing at origin/main to compare against` };
  }
  const oldValue = oldJson[field];
  const newValue = newJson[field];
  if (typeof oldValue !== "number" || !Number.isFinite(oldValue)) {
    return { ...entry, status: "error", ok: false, detail: `${path}: origin/main's "${field}" is not a finite number (${JSON.stringify(oldValue)})` };
  }
  if (typeof newValue !== "number" || !Number.isFinite(newValue)) {
    return { ...entry, status: "error", ok: false, detail: `${path}: "${field}" is not a finite number (${JSON.stringify(newValue)})` };
  }
  if (!isRegression(oldValue, newValue, direction)) {
    return { ...entry, status: "ok", ok: true, oldValue, newValue, detail: `${path}: ${field} ${oldValue} -> ${newValue}, not a regression` };
  }
  if (bumpRationaleNamesAPr(newJson.bumpRationale) && newJson.bumpRationale !== oldJson.bumpRationale) {
    return {
      ...entry,
      status: "reviewed-bump",
      ok: true,
      oldValue,
      newValue,
      detail: `${path}: ${field} moved ${oldValue} -> ${newValue} against origin/main, but a fresh bumpRationale names the review`,
    };
  }
  const kind = direction === "increase" ? "floor" : "ceiling";
  return {
    ...entry,
    status: "regressed",
    ok: false,
    oldValue,
    newValue,
    detail:
      `${path}: ${field} moved ${oldValue} -> ${newValue} against origin/main -- the WRONG direction for this ${kind}. ` +
      `Restore it, or if the move is deliberate and reviewed, add a fresh "bumpRationale" string to ${path} naming the PR ` +
      `(a "#<n>" or "W1-T<n>" reference), the convention scripts/claude-md-budget-baseline.json already follows.`,
  };
}

function readJsonAtRef(root, ref, path) {
  const res = spawnSync("git", ["show", `${ref}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) return undefined; // absent at ref -- a brand-new baseline file, nothing to regress against
  try {
    return JSON.parse(res.stdout);
  } catch (e) {
    throw new Error(`baseline-monotonic-check: ${ref}:${path} is not valid JSON: ${String(e)}`);
  }
}

function readJsonFromWorkingTree(root, path) {
  let text;
  try {
    text = readFileSync(join(root, path), "utf8");
  } catch (e) {
    throw new Error(`baseline-monotonic-check: cannot read ${path}: ${String(e.message ?? e)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`baseline-monotonic-check: ${path} is not valid JSON: ${String(e)}`);
  }
}

const OK_STATUSES = new Set(["ok", "new", "reviewed-bump"]);

/** The CLI body, exported so its branches are exercised in-process (a spawned run reports no
 *  coverage) -- the idiom every ratchet sibling here uses. */
export function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: "string", default: "." },
        base: { type: "string", default: DEFAULT_BASE_REF },
        // Test seam only (mirrors comment-load-ratchet.mjs's `--baseline` override): a fixture
        // pair of baselines is what the falsifier drives, never a second production table.
        table: { type: "string" },
      },
    }));
  } catch (e) {
    console.error(`baseline-monotonic-check: MEASUREMENT FAILED -- invalid arguments: ${String(e.message ?? e)}`);
    return 2;
  }

  const root = resolve(values.root);
  let table = SCORE_TABLE;
  if (values.table) {
    try {
      table = JSON.parse(readFileSync(resolve(values.table), "utf8"));
    } catch (e) {
      console.error(`baseline-monotonic-check: MEASUREMENT FAILED -- cannot read --table ${values.table}: ${String(e.message ?? e)}`);
      return 2;
    }
  }
  const results = [];
  try {
    for (const entry of table) {
      const oldJson = readJsonAtRef(root, values.base, entry.path);
      const newJson = readJsonFromWorkingTree(root, entry.path);
      results.push(evaluateRow(entry, oldJson, newJson));
    }
  } catch (e) {
    console.error(String(e.message ?? e));
    return 2;
  }

  for (const r of results) {
    if (OK_STATUSES.has(r.status)) console.log(`baseline-monotonic-check: OK -- ${r.detail}`);
    else if (r.status === "error") console.error(`baseline-monotonic-check: MEASUREMENT FAILED -- ${r.detail}`);
    else console.error(`baseline-monotonic-check: BLOCKED -- ${r.detail}`);
  }

  if (results.some((r) => r.status === "error")) return 2;
  if (results.some((r) => r.status === "regressed")) return 1;
  console.log(
    `baseline-monotonic-check: OK -- ${results.length} score baseline(s) checked against ${values.base}, ` +
      "none regressed without a reviewed bumpRationale",
  );
  return 0;
}

// Only run when executed directly, never on import -- the idiom every ratchet sibling here uses.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
