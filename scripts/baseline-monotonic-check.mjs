#!/usr/bin/env node
// scripts/baseline-monotonic-check.mjs (W1-T2906)
//
// Nothing compared a `scripts/*-baseline.json` SCORE against `origin/main` before this script: a
// PR that edited the JSON to a lower floor (or a higher ceiling) passed its own ratchet by
// construction, because every ratchet reads its baseline from the PR's own tree. This checks each
// row in SCORE_TABLE against `git show <base>:<path>` and refuses a regression unless the working
// tree's `bumpRationale` names a PR or task the base's rationale did not -- the one that reviewed it.
// A reference counts only as a whole word, compares as a number, and a `W1-T<n>` counts only when
// <root>/plan/tasks.d holds its shard.
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

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { git } from "./lib/git.mjs";

export const DEFAULT_BASE_REF = "origin/main";

/** One row per SCALAR score field this check holds monotonic. `direction: "increase"` is a FLOOR
 *  (a drop is the regression); `direction: "decrease"` is a CEILING (a rise is the regression). */
export const SCORE_TABLE = [
  // W1-T3384 — THE coverage-baseline.json/linesPct ROW IS GONE, NOT MOVED. The operator retired
  // that floor on 2026-09-11 ("i don't want hard floors on anything, including code coverage"),
  // so the field no longer exists and this row would hold a value that is not there. Leaving it
  // would not merely be stale: once the retirement is on main, `evaluateRow` reads origin/main's
  // absent field and returns `error` for EVERY subsequent pull request. Coverage is governed by
  // classifyCoverageTier's bands instead, which select a RESPONSE rather than a floor.
  { path: "scripts/mutation-baseline.json", field: "scorePct", direction: "increase" },
  { path: "scripts/cycle-baseline.json", field: "maxCycles", direction: "decrease" },
  { path: "scripts/claude-md-budget-baseline.json", field: "capBytes", direction: "decrease" },
  { path: "scripts/learnings-budget-baseline.json", field: "capChars", direction: "decrease" },
  // THE AUTOMATIC-PROMOTION BARS (src/lib/promotion-bars.ts reads them). The fleet promotes its own changes with no
  // person in the loop, so a bar grades the fleet the way a score floor grades a falsifier: loosening it lets a worse
  // change through. One row per field the loader reads; the promotion-bar suite fails on a field with no row here.
  { path: "scripts/promotion-floors-baseline.json", field: "canaryMinTasksPerSide", direction: "increase" },
  { path: "scripts/promotion-floors-baseline.json", field: "judgeMinPaired", direction: "increase" },
  { path: "scripts/promotion-floors-baseline.json", field: "judgeMinAgreeShare", direction: "increase" },
  { path: "scripts/promotion-floors-baseline.json", field: "skillEvalHeldOutTasks", direction: "increase" },
  { path: "scripts/promotion-floors-baseline.json", field: "skillEvalTrialsPerArm", direction: "increase" },
  { path: "scripts/promotion-floors-baseline.json", field: "skillEvalMinMeanGain", direction: "increase" },
  { path: "scripts/promotion-ceilings-baseline.json", field: "judgeMaxNoAnswerShare", direction: "decrease" },
  { path: "scripts/promotion-ceilings-baseline.json", field: "judgeMaxBrier", direction: "decrease" },
  { path: "scripts/promotion-ceilings-baseline.json", field: "poolMaxRejectedShare", direction: "decrease" },
  { path: "scripts/promotion-ceilings-baseline.json", field: "poolMaxMedianCaseUsd", direction: "decrease" },
  { path: "scripts/promotion-ceilings-baseline.json", field: "canaryMaxCostRatio", direction: "decrease" },
  { path: "scripts/promotion-ceilings-baseline.json", field: "canaryMaxMergeRateDrop", direction: "decrease" },
];

/** A `#<n>` or `W1-T<n>` with no word character on either side, in any script. A format character (a zero-width
 *  space or joiner, which renders as nothing) joins rather than separates, so `W1-T2906<ZWSP>bogus` reads as the
 *  one word it shows. Without the bounds `W1-T2906bogus` named W1-T2906 (PR #20033's third review). */
const PR_REFERENCES_RE = /(?<![\p{L}\p{M}\p{N}\p{Pc}\p{Cf}])(?:#(\d+)|W1-T(\d+))(?![\p{L}\p{M}\p{N}\p{Pc}\p{Cf}])/gu;
const PLAN_SHARD_RE = /^w1-t(\d+)(?:-.*)?\.ya?ml$/i;

/** `true` when `newValue` moved the WRONG way for `direction` -- the ratchet's own regression. */
export function isRegression(oldValue, newValue, direction) {
  return direction === "increase" ? newValue < oldValue : newValue > oldValue;
}

/** Every reference `rationale` names, each as a canonical `#<n>` or `W1-T<n>` key. Only a whole word counts:
 *  `W1-T2906bogus`, `xW1-T2906`, `W1-T2906_x` and `#12abc` name nothing. The number is read as an integer, so
 *  leading zeros name the same reference (`W1-T012187` is `W1-T12187`, `#007` is `#7`), and a zero (`#0`, `W1-T0`)
 *  names nothing. None for a non-string. */
export function rationaleReferences(rationale) {
  const refs = new Set();
  if (typeof rationale !== "string") return refs;
  for (const [, pr, task] of rationale.matchAll(PR_REFERENCES_RE)) {
    const n = BigInt(pr ?? task);
    if (n > 0n) refs.add(pr === undefined ? `W1-T${n}` : `#${n}`);
  }
  return refs;
}

/** A reviewed bump names itself: at least one {@link rationaleReferences} reference. */
export function bumpRationaleNamesAPr(rationale) {
  return rationaleReferences(rationale).size > 0;
}

/** No plan to check a task reference against, so none counts. The default for a caller that passes no plan. */
export const NO_PLAN = Object.freeze({ has: () => false, unreadable: "no plan was given to check task references against" });

/** No record to check a PR reference against, so none counts. The default for a caller that passes no PRs. */
export const NO_PRS = Object.freeze({ has: () => false, unreadable: "no PR record was given to check PR references against" });

const MERGED_PR_SUBJECT_RE = /\(#(\d+)\)\s*$|^Merge pull request #(\d+)\b/;

/** The PR number `GITHUB_REF` names on a pull_request run (`refs/pull/<n>/merge` or `/head`), else undefined. */
export function currentPrFromRef(ref) {
  const m = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(ref ?? "");
  return m && BigInt(m[1]) > 0n ? m[1] : undefined;
}

/**
 * The PRs a `#<n>` reference may name: every PR `base`'s history records as merged (a squash subject ending
 * `(#<n>)`, or a `Merge pull request #<n>` subject) and `current`, the PR under check. A number no PR ever held,
 * such as `#999999999999999999999999999999`, names nothing (PR #20033's fourth review). A history that cannot be
 * read counts no PR, and `unreadable` says why.
 */
export function knownPrs(root, base, current) {
  const res = git(["log", "--format=%s", base], { cwd: root });
  if (res.status !== 0 || res.error) {
    return { has: () => false, unreadable: `cannot read the merged PRs in ${base}'s history (${String(res.error?.message ?? res.stderr ?? "").trim()})` };
  }
  const prs = new Set();
  for (const subject of res.stdout.split("\n")) {
    const m = MERGED_PR_SUBJECT_RE.exec(subject);
    if (m) prs.add(`#${BigInt(m[1] ?? m[2])}`);
  }
  if (current !== undefined) prs.add(`#${BigInt(current)}`);
  return { has: (ref) => prs.has(ref) };
}

/** The tasks a `W1-T<n>` reference may name: one per `<root>/plan/tasks.d/W1-T<n>-*.yaml` (either case). A plan
 *  directory that cannot be listed counts no task, and `unreadable` says why. */
export function planTasks(root) {
  let names;
  try {
    names = readdirSync(join(root, "plan", "tasks.d"));
  } catch (e) {
    return { has: () => false, unreadable: `cannot list plan/tasks.d under ${root} (${String(e.message ?? e)})` };
  }
  const ids = new Set();
  for (const name of names) {
    const m = PLAN_SHARD_RE.exec(name);
    if (m && BigInt(m[1]) > 0n) ids.add(`W1-T${BigInt(m[1])}`);
  }
  return { has: (ref) => ids.has(ref) };
}

/** The references in `newRationale` that review THIS move: absent from `oldRationale` as numbers, and, for a task,
 *  a shard in `plan`; for a PR, one `prs` holds. A padded, re-spelled or zero-padded copy of an old reference
 *  reviews nothing new. `unknownTasks` and `unknownPrs` are the new references that name nothing. */
export function freshReviewReferences(newRationale, oldRationale, plan = NO_PLAN, prs = NO_PRS) {
  const previous = rationaleReferences(oldRationale);
  const fresh = [];
  const unknownTasks = [];
  const unknownPrs = [];
  for (const ref of rationaleReferences(newRationale)) {
    if (previous.has(ref)) continue;
    if (ref.startsWith("W1-T") && !plan.has(ref)) unknownTasks.push(ref);
    else if (ref.startsWith("#") && !prs.has(ref)) unknownPrs.push(ref);
    else fresh.push(ref);
  }
  return { fresh, unknownTasks, unknownPrs };
}

/**
 * Pure verdict for one {@link SCORE_TABLE} row. `oldJson` is `undefined` when the file did not
 * exist at the base ref -- a brand-new baseline has nothing to regress against and always passes.
 * A regression passes only when `newJson.bumpRationale` names a PR or task the previous rationale
 * did not ({@link freshReviewReferences}; a task must be in `plan`, a PR in `prs`) -- a stale rationale,
 * carried over from an earlier reviewed move, must not cover a fresh one, however its text is padded.
 */
export function evaluateRow(entry, oldJson, newJson, plan = NO_PLAN, prs = NO_PRS) {
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
  const { fresh, unknownTasks, unknownPrs } = freshReviewReferences(newJson.bumpRationale, oldJson.bumpRationale, plan, prs);
  if (fresh.length > 0) {
    return {
      ...entry,
      status: "reviewed-bump",
      ok: true,
      oldValue,
      newValue,
      detail: `${path}: ${field} moved ${oldValue} -> ${newValue} against origin/main, but its bumpRationale names ${fresh.join(", ")}, which the previous rationale did not`,
    };
  }
  const kind = direction === "increase" ? "floor" : "ceiling";
  const unknown = (unknownTasks.length === 0 ? "" :
    ` ${unknownTasks.join(", ")} cannot count: ${plan.unreadable ?? "no plan/tasks.d shard declares it"}.`) +
    (unknownPrs.length === 0 ? "" :
      ` ${unknownPrs.join(", ")} cannot count: ${prs.unreadable ?? "neither a merged PR in the base's history nor this PR"}.`);
  return {
    ...entry,
    status: "regressed",
    ok: false,
    oldValue,
    newValue,
    detail:
      `${path}: ${field} moved ${oldValue} -> ${newValue} against origin/main -- the WRONG direction for this ${kind}. ` +
      `Restore it, or if the move is deliberate and reviewed, write a "bumpRationale" in ${path} that names a PR or task ` +
      `the previous rationale did not (a "#<n>" or "W1-T<n>" reference, standing as its own word), the convention ` +
      `scripts/claude-md-budget-baseline.json already follows. Rewording, padding or zero-padding the old rationale's ` +
      `references does not count.${unknown}`,
  };
}

function readJsonAtRef(root, ref, path) {
  const res = git(["show", `${ref}:${path}`], { cwd: root });
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
        // The PR under check, which a rationale may name before it merges. Defaults to GITHUB_REF's.
        pr: { type: "string" },
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
  if (values.pr !== undefined && !/^[1-9][0-9]*$/.test(values.pr)) {
    console.error(`baseline-monotonic-check: MEASUREMENT FAILED -- --pr must be a positive PR number, not ${JSON.stringify(values.pr)}`);
    return 2;
  }
  const results = [];
  const plan = planTasks(root);
  const prs = knownPrs(root, values.base, values.pr ?? currentPrFromRef(process.env.GITHUB_REF));
  try {
    for (const entry of table) {
      const oldJson = readJsonAtRef(root, values.base, entry.path);
      const newJson = readJsonFromWorkingTree(root, entry.path);
      results.push(evaluateRow(entry, oldJson, newJson, plan, prs));
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
if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
