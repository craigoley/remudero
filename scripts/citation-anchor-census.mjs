#!/usr/bin/env node
// scripts/citation-anchor-census.mjs
//
// Citation-anchor census (W1-T2649). One repaired citation (#3305, W1-T2648) says nothing about
// the rest, so this script counts: it scans MASTER-PLAN.md and every plan/tasks.d/ shard's
// rationale/design/note prose for `#NNNN` PR citations and classifies each ANCHORED -- a git sha
// of >=7 hex characters, or a merge/closed word paired with an ISO date, either within
// ANCHOR_WINDOW characters -- or ANCHORLESS. The forms are a DATA table (ANCHOR_SHAPES), the
// same discipline src/lib/task-linter.ts's lexicon tables use: a heuristic over prose earns its
// table only by publishing a measured precision. Precision against hand-labelled FIXTURES prints
// above every count; an unproven classifier has not earned the right to report a total. The
// merge-state-plus-date shape is proximity-based, not semantic, so it carries a named residual --
// see the forensics page below for the measured case and why the census reports rather than
// chases it to zero.
//
// This is a report, not a gate: main() exits 0 for any anchored/anchorless split; the only
// failure is operational -- the corpus could not be read, or zero shards were found to scan.
// Why: the measured false-positive shapes, the window's derivation, and the accepted residual are
// archived in docs/forensics/citation-anchor-census.md (W1-T2649).
//
// Usage:
//   node scripts/citation-anchor-census.mjs [--cwd <repo-root>] [--plan-tasks-dir plan/tasks.d]
//                                            [--master-plan MASTER-PLAN.md]

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { parse as parseYaml } from "yaml";

/** Characters of prose inspected on EACH side of a `#NNNN` citation for an anchor. See the
 *  module comment above for the measured choice of 60 against this checkout's own corpus. */
export const ANCHOR_WINDOW = 60;

/**
 * Data table of immutable anchor shapes -- add a row for a new shape; {@link isAnchored} itself
 * never changes. Falsifier: test/citation-anchor-census.test.ts adds a row and asserts a window
 * reclassifies with no edit to isAnchored.
 */
export const ANCHOR_SHAPES = [
  {
    tag: "sha",
    pattern: /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i,
    reason:
      "a git sha of >=7 hex characters that mixes at least one digit AND one a-f letter, so " +
      "neither a bare run of decimal digits (a followup-id epoch, a task-count) nor an English " +
      "word confined to a-f (\"defaced\", \"effaced\") can ever satisfy it -- both shapes are " +
      "measured false-positive risks in this checkout's own corpus (see module comment).",
  },
  {
    tag: "merge-state-plus-date",
    pattern:
      /(?<![-A-Za-z0-9])(?:merged|closed)\b[\s\S]{0,60}?\b\d{4}-\d{2}-\d{2}\b|\b\d{4}-\d{2}-\d{2}\b[\s\S]{0,60}?(?<![-A-Za-z0-9])(?:merged|closed)\b/i,
    reason:
      "an explicit merge-state word (merged/closed) paired with an ISO date within 60 " +
      "characters of it. The lookbehind excludes a hyphenated compound like \"false-merged\" " +
      "(a real MASTER-PLAN.md phrase describing a MIS-attribution, the opposite of an anchor) " +
      "from ever satisfying the bare word match.",
  },
];

/** True iff `window` (the bounded prose around a `#NNNN` citation) carries at least one
 *  immutable anchor from `shapes`. */
export function isAnchored(window, shapes = ANCHOR_SHAPES) {
  return shapes.some((shape) => shape.pattern.test(window));
}

/** Every `#NNNN` PR-number citation in `text`: its PR number, the bounded window around it (fed
 *  to {@link isAnchored}), and the single source LINE it sits on, trimmed -- what the report
 *  shows a reader, since the window itself is wider than one line and would be noisy to print. */
export function findCitations(text) {
  const citations = [];
  const re = /#(\d{2,6})(?!\d)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const index = match.index;
    const start = Math.max(0, index - ANCHOR_WINDOW);
    const end = Math.min(text.length, index + match[0].length + ANCHOR_WINDOW);
    const lineStart = text.lastIndexOf("\n", index) + 1;
    const nextNewline = text.indexOf("\n", index);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    citations.push({
      prNumber: match[1],
      window: text.slice(start, end),
      line: text.slice(lineStart, lineEnd).trim(),
    });
  }
  return citations;
}

/** Every citation `findCitations` finds in `text`, classified against `shapes` and tagged with `recordId` for the report. */
export function classifyRecord(recordId, text, shapes = ANCHOR_SHAPES) {
  return findCitations(text).map((citation) => ({
    recordId,
    prNumber: citation.prNumber,
    line: citation.line,
    anchored: isAnchored(citation.window, shapes),
  }));
}

/** The corpus: MASTER-PLAN.md's whole body (narrative prose, no field structure of its own) plus
 *  every plan/tasks.d/ shard's rationale, design and note fields -- the only free-text fields a
 *  filer actually writes into. See docs/forensics/citation-anchor-census.md for the field-scoping
 *  precedent this mirrors. */
export function loadCorpus(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const planTasksDir = opts.planTasksDir ?? "plan/tasks.d";
  const masterPlanPath = opts.masterPlanPath ?? "MASTER-PLAN.md";

  const units = [{ id: masterPlanPath, text: readFileSync(resolve(cwd, masterPlanPath), "utf8") }];

  const shardDirFull = resolve(cwd, planTasksDir);
  const shardFiles = readdirSync(shardDirFull)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  for (const file of shardFiles) {
    let doc;
    try {
      doc = parseYaml(readFileSync(join(shardDirFull, file), "utf8"));
    } catch {
      continue; // an unparsable shard is a plan-lint concern, not this census's -- skip, don't crash
    }
    const records = Array.isArray(doc) ? doc : [doc];
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const id = typeof record.id === "string" ? record.id : file;
      const parts = [record.rationale, record.design, record.note].filter((f) => typeof f === "string");
      if (parts.length === 0) continue;
      units.push({ id, text: parts.join("\n\n") });
    }
  }
  return { units, shardCount: shardFiles.length };
}

/** The full census over `units`: total citations, the anchored/anchorless split, and every
 *  anchorless citation in full -- record id plus its line -- so a reader can inspect the
 *  population the count summarises rather than take a number on trust. */
export function census(units, shapes = ANCHOR_SHAPES) {
  const citations = units.flatMap((unit) => classifyRecord(unit.id, unit.text, shapes));
  const anchorless = citations.filter((c) => !c.anchored);
  const anchoredCount = citations.length - anchorless.length;
  return { total: citations.length, anchoredCount, anchorlessCount: anchorless.length, anchorless };
}

/** Hand-labelled fixtures lifted verbatim from the live corpus, in both directions: two anchored
 *  quotes from W1-T2648's rationale, and the anchorless quote that is #3305's original citation --
 *  the exact case this census exists to measure. Full sourcing: docs/forensics/citation-anchor-census.md. */
export const FIXTURES = [
  {
    label: "#591 sha-window (W1-T2648 rationale, verbatim)",
    text: '"observed on #591 at 1f990d2"',
    expected: "anchored",
  },
  {
    label: "#1399 merge-word-plus-sha (W1-T2648 rationale, verbatim)",
    text: '"observed on #1399 (judgeRubric advisory wiring, merged 64e5d4c)"',
    expected: "anchored",
  },
  {
    label: "#3305 original form (W1-T2481 rationale, verbatim)",
    text:
      "Measured on #3305: applying the retirement ruling to every anchored tombstone reddened " +
      "lint-plan with 13 failing, all of them this class, and the backfill had to ship 20 of 33 " +
      "to stay green.",
    expected: "anchorless",
  },
];

/** Runs every fixture through the SAME classify path the real census uses, and reports how many
 *  the classifier got right. The count below is trusted only as far as this number says it can
 *  be -- printed BESIDE the count by {@link formatReport}, never in place of it. */
export function measurePrecision(fixtures = FIXTURES, shapes = ANCHOR_SHAPES) {
  const results = fixtures.map((fixture) => {
    const citations = classifyRecord(fixture.label, fixture.text, shapes);
    const anchoredCount = citations.filter((c) => c.anchored).length;
    const got =
      citations.length === 0 ? "no-citation-found" : anchoredCount === citations.length ? "anchored" : anchoredCount === 0 ? "anchorless" : "mixed";
    return { ...fixture, got, correct: got === fixture.expected };
  });
  const correct = results.filter((r) => r.correct).length;
  return { total: results.length, correct, results };
}

/** Renders the census as a report -- precision first, then the split, then every anchorless
 *  citation named by record id and its line. */
export function formatReport(precision, censusResult) {
  const lines = [];
  lines.push("CITATION-ANCHOR CENSUS (W1-T2649)");
  lines.push("");
  const precisionVerdict = precision.correct === precision.total ? "trusted" : "DO NOT TRUST THE COUNT BELOW";
  lines.push(
    `PRECISION (declared before the count is trusted): ${precision.correct}/${precision.total} ` +
      `hand-labelled fixtures classified correctly -- ${precisionVerdict}`,
  );
  for (const result of precision.results) {
    lines.push(`  ${result.correct ? "OK  " : "FAIL"} ${result.label}: expected ${result.expected}, got ${result.got}`);
  }
  lines.push("");
  lines.push(
    `CITATIONS: ${censusResult.total} total, ${censusResult.anchoredCount} anchored, ` +
      `${censusResult.anchorlessCount} anchorless`,
  );
  if (censusResult.anchorlessCount > 0) {
    lines.push("");
    lines.push("ANCHORLESS (record id, then the citing line):");
    for (const citation of censusResult.anchorless) {
      lines.push(`  ${citation.recordId} #${citation.prNumber}: ${citation.line}`);
    }
  }
  lines.push("");
  lines.push(
    "This is a REPORT, not a gate: exit status is 0 regardless of the split above. No lint " +
      "check reads this output and no required-check name changes for it.",
  );
  return lines.join("\n");
}

export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      cwd: { type: "string" },
      "plan-tasks-dir": { type: "string" },
      "master-plan": { type: "string" },
    },
  });
  const opts = {
    cwd: values.cwd ?? process.cwd(),
    planTasksDir: values["plan-tasks-dir"],
    masterPlanPath: values["master-plan"],
  };

  let corpus;
  try {
    corpus = loadCorpus(opts);
  } catch (err) {
    console.error(`citation-anchor-census: could not read the corpus -- ${err.message}`);
    process.exitCode = 1; // an operational failure to SCAN, never a verdict on what was found
    return;
  }
  if (corpus.shardCount === 0) {
    console.error(
      "citation-anchor-census: scanned ZERO plan/tasks.d/ shards -- refusing a vacuous report " +
        "(the same 'empty because the query was malformed' failure state.md-citation-check " +
        "and claims-check already refuse to pass silently).",
    );
    process.exitCode = 1;
    return;
  }

  const precision = measurePrecision();
  const result = census(corpus.units);
  console.log(formatReport(precision, result));
  process.exitCode = 0; // REPORTS, NEVER GATES -- unconditional, however many are anchorless.
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
