#!/usr/bin/env tsx
// scripts/plan-state-claims.mjs
//
// PLAN-STATE SELF-CONSISTENCY gate (W1-T409, MASTER-PLAN §8A/§12A).
//
// W1-T392 split into two halves along the seam its own design note drew: THIS half reads
// MASTER-PLAN.md against ITSELF (offline, no network, no live GitHub state — claims.yaml's own
// contract); W1-T410 (src/lib/retro.ts's planStateTruthRung) reads it against GitHub merge state.
// THIS HALF WOULD NOT HAVE CAUGHT THE W1-T149 INCIDENT — a consistency check over two lists cannot
// see an id absent from BOTH. It is filed anyway because a document that contradicts itself (an id
// recorded as landed in the SHIPPED log while another line asserts it did not land) is a real,
// decidable defect with a real gate available.
//
// WHAT IS REFUSED: a task id appearing BOTH in the "## SHIPPED log" section of MASTER-PLAN.md AND
// in a not-shipped assertion (the vocabulary W1-T410 established: "not shipped", "unbuilt", "did
// not ship") anywhere else in the same file.
//
// THE SHIPPED-LOG EXTRACTOR READS BOTH NOTATIONS the section actually uses: full `W<n>-T<n>` ids,
// and the house-style COMPRESSED PAIR `T<n>/#<pr>` a long-form-only regex cannot see (measured:
// 197 of 284 distinct SHIPPED-log task numbers appear ONLY in compressed-pair form). The bare
// number carries no workstream prefix — the section mixes W1/W2/W3 — so it is resolved against the
// PLAN'S OWN id set (plan/tasks.yaml + plan/tasks.d/*.yaml, loaded via lib/plan.ts's `loadPlan`,
// the same merge every other consumer uses) rather than guessed by prepending `W1-`. An id the plan
// does not know is not resolved and is never invented into a contradiction.
//
// THE NOT-SHIPPED EXTRACTOR REUSES `extractAssertedUnbuiltTaskIds` (src/lib/retro.ts, shipped by
// W1-T410) rather than re-deriving the clause-scoped phrase-binding logic a second time — the
// reuse obligation both split tasks' design notes name explicitly. That function's `ids` are the
// ones this gate treats as "asserted not-shipped"; the per-line citation this gate prints alongside
// a contradiction is derived locally (the exported type carries counts, not per-id line refs) by
// re-scanning for the same not-shipped vocabulary next to the id's text — a display-only lookup,
// never a second membership decision.
//
// A POSITIVE CONTROL, ONE PER SIDE, ON THE FACT THAT DISTINGUISHES A BROKEN SCAN FROM AN HONEST
// EMPTY RESULT (W1-T1232): the shipped-log side has no "read but bound nothing" state, so
// `shippedExamined === 0` still exits non-zero as UNEXAMINED unconditionally. The not-shipped side
// reuses `extractAssertedUnbuiltTaskIds`'s `examinedLines` (phrase-bearing lines READ, whether or
// not a task id bound) rather than the bound-id count: `notShippedLinesExamined === 0` means the
// phrase extractor matched nothing anywhere in the document — a suspect scan (renamed vocabulary,
// encoding fault) — and still exits UNEXAMINED. A region the extractor READ but bound no id in
// (every phrase-bearing clause named a proposal or nothing) is an honest absence, not a broken
// scan, and is reported OK — see MASTER-PLAN.md's rule 9, which tells an author to DELETE a
// corrected id from this region rather than annotate it, and which this distinction exists to
// keep from tripping the gate. The rendered report names the phrase-bearing line count either way.
//
// Usage:
//   node --import tsx scripts/plan-state-claims.mjs [--master-plan MASTER-PLAN.md] [--plan plan/tasks.yaml]
//
// Run under `node --import tsx` (not plain `node`): this script imports directly from .ts modules
// (src/lib/plan.ts, src/lib/retro.ts), the same convention scripts/generate-capability-snapshot.mjs
// and scripts/recovery-drill.mjs already establish.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { loadPlan } from "../src/lib/plan.ts";
import { extractAssertedUnbuiltTaskIds } from "../src/lib/retro.ts";

const SHIPPED_LOG_HEADER_RE = /^## SHIPPED log\s*$/;
const SECTION_HEADER_RE = /^## /;
const LONG_FORM_ID_RE = /\bW(\d+)-T(\d+)\b/g;
const COMPRESSED_PAIR_RE = /\bT(\d+)\/#\d+\b/g;
/** Mirrors src/lib/retro.ts's own (module-private) NOT_SHIPPED_PHRASE_RE — duplicated here ONLY to
 *  locate a citation LINE for an id extractAssertedUnbuiltTaskIds already decided is asserted
 *  not-shipped; it is never used to decide membership (that decision is entirely the reused
 *  function's), so this is a display lookup, not a second phrase-extractor. */
const NOT_SHIPPED_PHRASE_RE = /not shipped|unbuilt|did not ship/i;

/** The `## SHIPPED log` section's line range within `lines` (0-indexed, `start` inclusive of the
 *  first line AFTER the header, `end` exclusive) — from the header to the next `## ` heading, or
 *  EOF. `{ start: -1, end: -1 }` when no `## SHIPPED log` heading exists at all. */
export function shippedLogLineRange(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SHIPPED_LOG_HEADER_RE.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return { start: -1, end: -1 };
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (SECTION_HEADER_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Every known task id's trailing number (`W1-T148` -> `["148", "W1-T148"]`) as a
 *  number -> ids map, so a bare compressed-pair number resolves ONLY when the plan's own id set
 *  names exactly one id ending `-T<number>` — never invented, never guessed by prefix. */
function numberToKnownIds(knownIds) {
  const map = new Map();
  for (const id of knownIds) {
    const m = /-T(\d+)$/.exec(id);
    if (!m) continue;
    const list = map.get(m[1]) ?? [];
    list.push(id);
    map.set(m[1], list);
  }
  return map;
}

/**
 * Extract every task id the `## SHIPPED log` section records as landed, in EITHER notation, bound
 * to the line (1-indexed) and line text that first recorded it — design (iv)'s citation.
 *
 * `knownIds`: the plan's own id set (lib/plan.ts `loadPlan`). A long-form `W<n>-T<n>` match is
 * taken as-is (unambiguous). A compressed-pair `T<n>/#<pr>` match resolves ONLY when exactly one
 * known id ends `-T<n>` — zero or multiple candidates means the number is not resolved and is
 * dropped, never invented (design (ii)/acceptance criterion 4).
 */
export function extractShippedLogIds(masterPlanMd, knownIds) {
  const lines = masterPlanMd.split("\n");
  const { start, end } = shippedLogLineRange(lines);
  const byNumber = numberToKnownIds(knownIds);
  const shipped = new Map();
  if (start === -1) return shipped;
  for (let i = start; i < end; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    for (const m of line.matchAll(LONG_FORM_ID_RE)) {
      const id = `W${m[1]}-T${m[2]}`;
      if (!shipped.has(id)) shipped.set(id, { lineNumber, lineText: line });
    }
    for (const m of line.matchAll(COMPRESSED_PAIR_RE)) {
      const candidates = byNumber.get(m[1]) ?? [];
      if (candidates.length !== 1) continue; // unknown or ambiguous -- not resolved, not invented
      const id = candidates[0];
      if (!shipped.has(id)) shipped.set(id, { lineNumber, lineText: line });
    }
  }
  return shipped;
}

/** The first line (1-indexed) asserting `id` not-shipped, for the contradiction citation —
 *  see the module doc's note on why this is a display-only re-scan, not a second extractor. */
export function firstNotShippedLine(masterPlanMd, id) {
  // Only a W1- id can appear in bare `T<n>` form -- extractAssertedUnbuiltTaskIds's own
  // normalizeAssertedTaskId assumes bare T<n> means W1-T<n> throughout this corpus.
  const bareForm = id.startsWith("W1-") ? id.slice(3) : undefined; // "W1-T148" -> "T148"
  const bareRe = bareForm ? new RegExp(`\\b${bareForm}\\b`) : undefined;
  const lines = masterPlanMd.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!NOT_SHIPPED_PHRASE_RE.test(line)) continue;
    if (line.includes(id) || (bareRe && bareRe.test(line))) {
      return { lineNumber: i + 1, lineText: line };
    }
  }
  return undefined;
}

/**
 * The gate's whole decision: every SHIPPED-log id (both notations, short-form resolved against
 * `knownIds`) crossed against every not-shipped id (reused from W1-T410's
 * `extractAssertedUnbuiltTaskIds`). `contradictions` names each id found on both sides, with a
 * citation line from each side (design (iv)). `shippedExamined` and `notShippedLinesExamined` are
 * the positive control's two counts (design (iii)) — both must be nonzero for a scan to count as
 * having examined anything at all (W1-T1232: the not-shipped side's control is the PHRASE-LINE
 * count, not the bound-id count — see the module doc). `notShippedExamined` is the bound-id count,
 * carried through separately so the report can still say how many ids it found.
 */
export function checkPlanStateConsistency(masterPlanMd, knownIds) {
  const shipped = extractShippedLogIds(masterPlanMd, knownIds);
  const { ids: notShippedIds, examinedLines: notShippedLinesExamined } =
    extractAssertedUnbuiltTaskIds(masterPlanMd);
  const notShippedSet = new Set(notShippedIds);

  const contradictions = [];
  for (const [id, shippedRef] of shipped) {
    if (!notShippedSet.has(id)) continue;
    const notShippedRef = firstNotShippedLine(masterPlanMd, id);
    contradictions.push({
      id,
      shippedLineNumber: shippedRef.lineNumber,
      shippedLineText: shippedRef.lineText,
      notShippedLineNumber: notShippedRef?.lineNumber,
      notShippedLineText: notShippedRef?.lineText ?? "(not-shipped citation line not found)",
    });
  }

  return {
    shippedExamined: shipped.size,
    notShippedExamined: notShippedSet.size,
    notShippedLinesExamined,
    contradictions,
  };
}

/** Render {@link checkPlanStateConsistency}'s result as the CLI's human-readable report. Three
 *  DISTINCT shapes (design (iii)): UNEXAMINED never reads like OK, and OK never reads like a
 *  contradiction report -- "zero contradictions found and zero claims examined must never print
 *  the same text". UNEXAMINED fires on `shippedExamined === 0` (unchanged) or
 *  `notShippedLinesExamined === 0` (W1-T1232: no not-shipped-phrase-bearing line was read at all --
 *  a broken scan) -- NEVER on `notShippedExamined === 0` alone, which just means every
 *  phrase-bearing line that WAS read bound a proposal or nothing, an honest empty result. All
 *  three shapes name the phrase-bearing line count so a reader can tell which case fired. */
export function renderReport(result) {
  const { shippedExamined, notShippedExamined, notShippedLinesExamined, contradictions } = result;
  if (shippedExamined === 0 || notShippedLinesExamined === 0) {
    return (
      `plan-state-claims: UNEXAMINED -- ${shippedExamined} shipped-log id(s) examined, ` +
      `${notShippedLinesExamined} not-shipped-phrase-bearing line(s) read, ` +
      `${notShippedExamined} not-shipped id(s) examined -- an empty scan is not a clean result.`
    );
  }
  if (contradictions.length === 0) {
    return (
      `plan-state-claims: OK -- ${shippedExamined} shipped-log id(s) examined, ` +
      `${notShippedLinesExamined} not-shipped-phrase-bearing line(s) read, ` +
      `${notShippedExamined} not-shipped id(s) examined, 0 contradiction(s).`
    );
  }
  const lines = [
    "plan-state-claims: DOCUMENT CONTRADICTS ITSELF -- the following id(s) are asserted BOTH " +
      "shipped and not-shipped:",
    "",
  ];
  for (const c of contradictions) {
    lines.push(`  [${c.id}] SHIPPED at MASTER-PLAN.md:${c.shippedLineNumber}: "${c.shippedLineText.trim()}"`);
    lines.push(
      `  [${c.id}] NOT-SHIPPED at MASTER-PLAN.md:${c.notShippedLineNumber ?? "?"}: "${c.notShippedLineText.trim()}"`,
    );
  }
  lines.push("");
  lines.push(
    `(examined ${shippedExamined} shipped-log id(s), ${notShippedLinesExamined} ` +
      `not-shipped-phrase-bearing line(s) read, ${notShippedExamined} not-shipped id(s))`,
  );
  return lines.join("\n");
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "master-plan": { type: "string", default: "MASTER-PLAN.md" },
      plan: { type: "string", default: join("plan", "tasks.yaml") },
    },
  });

  let masterPlanMd;
  try {
    masterPlanMd = readFileSync(values["master-plan"], "utf8");
  } catch (err) {
    console.error(`plan-state-claims: cannot read ${values["master-plan"]}: ${String(err)}`);
    process.exitCode = 1;
    return;
  }

  let knownIds;
  try {
    knownIds = loadPlan(values.plan).tasks.map((t) => t.id);
  } catch (err) {
    console.error(`plan-state-claims: cannot load plan ${values.plan}: ${String(err)}`);
    process.exitCode = 1;
    return;
  }

  // No try/catch here, unlike the two reads above: `masterPlanMd` is always a string (readFileSync
  // succeeded with an explicit "utf8" encoding) and `knownIds` is always an array of validated,
  // non-empty string ids (loadPlan's own parseTasksFromYaml rejects a task with a missing/blank
  // id before this line is ever reached) -- checkPlanStateConsistency's extractors are pure
  // string/regex operations over those two guaranteed-valid inputs and have no other failure
  // mode to catch.
  const result = checkPlanStateConsistency(masterPlanMd, knownIds);
  const report = renderReport(result);
  if (
    result.shippedExamined === 0 ||
    result.notShippedLinesExamined === 0 ||
    result.contradictions.length > 0
  ) {
    console.error(report);
    process.exitCode = 1;
    return;
  }
  console.log(report);
  process.exitCode = 0;
}

// Only run when executed directly, never on import (same convention as scripts/claims-check.mjs).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
