#!/usr/bin/env tsx
// scripts/plan-state-claims.mjs — the plan-state self-consistency gate (W1-T409, MASTER-PLAN
// §8A/§12A). Refuses a task id that MASTER-PLAN.md's "## SHIPPED log" section records as landed
// while another line elsewhere asserts it "not shipped" / "unbuilt" / "did not ship" (the
// vocabulary W1-T410 established) — a document contradicting itself. Checks MASTER-PLAN.md
// against only itself, offline; W1-T410's planStateTruthRung checks it against real GitHub state.
// Why: an id absent from both sides needs that online check instead — see W1-T149.
// docs/forensics/plan-state-claims.md#why-this-gate-exists
//
// The SHIPPED-log side resolves both the long-form `W<n>-T<n>` id and the house-style compressed
// pair `T<n>/#<pr>`, the pair resolved only against the plan's own known ids so an unrecognized
// number is dropped, never guessed. The not-shipped side reuses src/lib/retro.ts's
// extractAssertedUnbuiltTaskIds for membership; the per-line citation here is a separate,
// display-only re-scan.
// Why: reuse is required by both split tasks' own design notes.
// docs/forensics/plan-state-claims.md#the-two-extractors
//
// A scan reading nothing must never report OK: `shippedExamined` and `notShippedLinesExamined`
// both gate the UNEXAMINED verdict, but `notShippedExamined` alone does not, because an honestly
// empty not-shipped region is not a broken scan.
// Why: W1-T1232. docs/forensics/plan-state-claims.md#the-positive-control
//
// Run under `node --import tsx`, not plain `node` — it imports src/lib/plan.ts and
// src/lib/retro.ts directly, same as scripts/generate-capability-snapshot.mjs.
// Usage: node --import tsx scripts/plan-state-claims.mjs [--master-plan <path>] [--plan <path>]

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
/** Mirrors retro.ts's own (module-private) NOT_SHIPPED_PHRASE_RE, to locate a citation line only —
 *  membership is decided entirely by extractAssertedUnbuiltTaskIds, never by this regex. */
const NOT_SHIPPED_PHRASE_RE = /not shipped|unbuilt|did not ship/i;

/** The `## SHIPPED log` section's line range in `lines` (0-indexed; `start` is the line after the
 *  header, `end` exclusive). `{ start: -1, end: -1 }` when there is no such header. */
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

/** Every known id's trailing number (`W1-T148` -> `148`) mapped to the id(s) ending `-T<number>`,
 *  so a compressed-pair number resolves only when exactly one known id matches. */
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
 * Every task id the `## SHIPPED log` section records as landed, in either notation, mapped to the
 * line (1-indexed) and text that first recorded it. `knownIds` resolves a compressed-pair number;
 * an ambiguous or unknown number is dropped, never invented.
 * docs/forensics/plan-state-claims.md#extractshippedlogids
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

/** Every line (1-indexed), in document order, asserting `id` not-shipped — the full citation site
 *  list for a contradiction (W1-T2223). Membership is decided by extractAssertedUnbuiltTaskIds;
 *  this is a display-only re-scan, never a second decision. */
export function notShippedLines(masterPlanMd, id) {
  // Bare `T<n>` means `W1-T<n>` here, matching extractAssertedUnbuiltTaskIds's own assumption.
  const bareForm = id.startsWith("W1-") ? id.slice(3) : undefined; // "W1-T148" -> "T148"
  const bareRe = bareForm ? new RegExp(`\\b${bareForm}\\b`) : undefined;
  const lines = masterPlanMd.split("\n");
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!NOT_SHIPPED_PHRASE_RE.test(line)) continue;
    if (line.includes(id) || (bareRe && bareRe.test(line))) {
      sites.push({ lineNumber: i + 1, lineText: line });
    }
  }
  return sites;
}

/** The first line (1-indexed) asserting `id` not-shipped — kept as the single-site lookup its name
 *  promises; {@link notShippedLines} is the contradiction record's actual citation source.
 *  `undefined` when `id` is never asserted not-shipped. */
export function firstNotShippedLine(masterPlanMd, id) {
  return notShippedLines(masterPlanMd, id)[0];
}

/**
 * The gate's whole decision: every SHIPPED-log id crossed against every not-shipped id (reused
 * from extractAssertedUnbuiltTaskIds). `contradictions` names each id found on both sides, with
 * every not-shipped citation site (W1-T2223), not only the first. `shippedExamined` and
 * `notShippedLinesExamined` are the positive control's two counts — see the module header.
 */
export function checkPlanStateConsistency(masterPlanMd, knownIds) {
  const shipped = extractShippedLogIds(masterPlanMd, knownIds);
  const { ids: notShippedIds, examinedLines: notShippedLinesExamined } =
    extractAssertedUnbuiltTaskIds(masterPlanMd);
  const notShippedSet = new Set(notShippedIds);

  const contradictions = [];
  for (const [id, shippedRef] of shipped) {
    if (!notShippedSet.has(id)) continue;
    // Every not-shipped site, not just the first (W1-T2223) — see the module header.
    const sites = notShippedLines(masterPlanMd, id);
    const notShippedRefs =
      sites.length > 0 ? sites : [{ lineNumber: undefined, lineText: "(not-shipped citation line not found)" }];
    contradictions.push({
      id,
      shippedLineNumber: shippedRef.lineNumber,
      shippedLineText: shippedRef.lineText,
      notShippedRefs,
    });
  }

  return {
    shippedExamined: shipped.size,
    notShippedExamined: notShippedSet.size,
    notShippedLinesExamined,
    contradictions,
  };
}

/** Renders {@link checkPlanStateConsistency}'s result as the CLI's report, in three shapes that
 *  must never read alike: UNEXAMINED (an empty scan), OK (zero contradictions), or a contradiction
 *  list. UNEXAMINED fires on a zero shipped or not-shipped-line count, never on a zero bound
 *  not-shipped-id count alone — an honest empty result. A not-shipped site on the same physical
 *  line as its shipped citation folds into one combined line rather than printing twice (W1-T2223).
 *  docs/forensics/plan-state-claims.md#renderreport */
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
    // A same-line not-shipped site folds into the SHIPPED line (W1-T2223) rather than repeating
    // the line number — see renderReport's doc.
    const sameLine = c.notShippedRefs.filter((r) => r.lineNumber === c.shippedLineNumber);
    const otherSites = c.notShippedRefs.filter((r) => r.lineNumber !== c.shippedLineNumber);
    if (sameLine.length > 0) {
      lines.push(
        `  [${c.id}] SHIPPED AND NOT-SHIPPED on the SAME LINE at MASTER-PLAN.md:${c.shippedLineNumber}: ` +
          `"${c.shippedLineText.trim()}"`,
      );
    } else {
      lines.push(`  [${c.id}] SHIPPED at MASTER-PLAN.md:${c.shippedLineNumber}: "${c.shippedLineText.trim()}"`);
    }
    for (const site of otherSites) {
      lines.push(
        `  [${c.id}] NOT-SHIPPED at MASTER-PLAN.md:${site.lineNumber ?? "?"}: "${site.lineText.trim()}"`,
      );
    }
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

  // Both inputs are already validated above, so checkPlanStateConsistency cannot throw here.
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
