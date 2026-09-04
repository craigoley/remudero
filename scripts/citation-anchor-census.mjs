#!/usr/bin/env node
// scripts/citation-anchor-census.mjs
//
// CITATION-ANCHOR CENSUS (W1-T2649, origin: followup#W1-T2481-1788113218856).
//
// ONE REPAIRED CITATION ANSWERS NOTHING ABOUT THE REST. W1-T2648 re-anchors ONE citation --
// W1-T2481's rationale names PR #3305 with no sha, no merge state and no date, so a later reader
// can neither re-derive nor falsify the "13 failing" figure it motivates. That single repair
// cannot say whether #3305 was a lapse or the visible edge of a habit. This script counts, so
// the plan does not have to guess: it walks the plan's task records (the monolith,
// MASTER-PLAN.md, and every plan/tasks.d/ shard), finds every `#NNNN` PR-number citation in
// rationale/design/note prose, and classifies each ANCHORED or ANCHORLESS.
//
// ANCHORED means the citation is accompanied, within a bounded prose window, by something
// IMMUTABLE: a git sha of >=7 hex characters, or an explicit merge-state word paired with a
// date. Both forms live in the ANCHOR_SHAPES table below, one row per shape -- mirroring the
// DATA-table discipline SUBSYSTEM_LEXICON / DATA_ARTIFACT_CLASSES / PROOF_PAYLOAD_SHAPES /
// ADVISORY_ROUTING_LEXICON already use in src/lib/task-linter.ts (see that file's module
// comment on ADVISORY_ROUTING_LEXICON for the precedent this design cites by name: a heuristic
// over prose earns its table only by publishing a MEASURED precision, never by assertion).
//
// PRECISION IS DECLARED BEFORE THE COUNT IS TRUSTED. FIXTURES below is a small, hand-labelled
// set lifted VERBATIM from this checkout's own live corpus, in both directions: two known-
// anchored quotes (plan/tasks.d/W1-T2648-*.yaml's rationale, itself illustrating the habit) and
// one known-anchorless quote -- #3305's ORIGINAL citation in plan/tasks.d/W1-T2481-*.yaml's
// rationale, the exact case this whole task exists to measure. measurePrecision() runs every
// fixture through the SAME classify path the census uses and the CLI prints the result ABOVE
// the count, every run -- a count printed without that line would be a feeling, not a
// measurement.
//
// THE WINDOW IS BOUNDED AND THE BOUND IS MEASURED, NOT GUESSED. ANCHOR_WINDOW=60 characters on
// each side of a `#NNNN` match was chosen against this checkout: the two known-anchored fixture
// distances are 4 and 46 characters, comfortably inside; MASTER-PLAN.md's own followup-log entry
// for #3305 carries a "RATIFIED 2026-08-31" trailer 296 characters away (would falsely anchor a
// citation whose OWN TEXT says "no sha, no merge state and no date" if the window reached that
// far) and an unrelated 13-digit followup-id timestamp 139 characters away (would falsely read
// as a sha under a naive hex scan -- see the ANCHOR_SHAPES sha row's own comment on why it
// requires a mixed digit+letter token, not a bare hex-alphabet run).
//
// A NAMED RESIDUAL, NOT A CLAIMED ZERO. The merge-state-plus-date shape is proximity-based, not
// semantic: a passage citing several PR numbers within one clause can attach a neighbour's
// merge word to the wrong number. Measured example: plan/tasks.d/W1-T1103-*.yaml reads
// "`#2032` IS STILL OPEN. `#2438` and `#2360` were closed by hand on 2026-08-23; `#2032` was
// not" -- the FIRST `#2032` sits close enough to "closed ... 2026-08-23" (which names #2438 and
// #2360, not #2032) to read ANCHORED despite the sentence explicitly saying #2032 is NOT closed.
// This is the same class of imprecision ADVISORY_ROUTING_LEXICON accepted and published (0.9%
// residual against a naive scan's 63%) rather than chasing to zero -- a census is a starting
// point an operator reviews, not a certified-perfect classification, and IT REPORTS, IT NEVER
// GATES (below), so a residual misclassification costs a reader's attention, never a CI run.
//
// IT REPORTS AND IT DOES NOT GATE. `main()` exits 0 whenever it completes a census, however many
// citations are anchorless -- that restraint is a criterion this task's design states plainly,
// not a footnote: no lint check is added here, no check name is registered anywhere, and no
// existing check's behaviour changes. The ONLY non-zero exit is an operational failure to find
// the corpus at all (e.g. a bad --plan-tasks-dir), matching the "refuse rather than report
// success on an empty scan" discipline scripts/state-citation-check.mjs already keeps -- that
// is a failure to SCAN, never a verdict on what was found.
//
// Usage:
//   node scripts/citation-anchor-census.mjs [--cwd <repo-root>] [--plan-tasks-dir plan/tasks.d]
//                                            [--master-plan MASTER-PLAN.md]

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

/** Characters of prose inspected on EACH side of a `#NNNN` citation for an anchor. See the
 *  module comment above for the measured choice of 60 against this checkout's own corpus. */
export const ANCHOR_WINDOW = 60;

/**
 * DATA table -- one row per IMMUTABLE anchor SHAPE. A new shape is a new row; {@link isAnchored}
 * never changes (the falsifier proof for this task's DATA-table acceptance criterion is exactly
 * that: pass a caller-supplied table carrying one extra row and a previously-anchorless window
 * reclassifies, with zero edits to isAnchored itself).
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

/** Every citation `findCitations` finds in `text`, classified against `shapes` and tagged with
 *  `recordId` for the report. */
export function classifyRecord(recordId, text, shapes = ANCHOR_SHAPES) {
  return findCitations(text).map((citation) => ({
    recordId,
    prNumber: citation.prNumber,
    line: citation.line,
    anchored: isAnchored(citation.window, shapes),
  }));
}

/**
 * The corpus this census reads: the monolith (MASTER-PLAN.md, its whole body -- it has no
 * rationale:/design:/note: field structure of its own, it IS narrative prose end to end) plus
 * every plan/tasks.d/ shard's rationale, design and note fields (the fields this task's design
 * names, and the only free-text fields a filer actually writes into -- the same field scoping
 * ADVISORY_ROUTING_LEXICON's own module comment documents for {@link Task}, since `design:` is
 * dropped before parsing there and is read directly here instead, off the raw YAML).
 */
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

/**
 * Hand-labelled fixtures, lifted VERBATIM from this checkout's live corpus, in BOTH directions.
 * A classifier that cannot separate these has not earned the right to report a total (this
 * task's design, stated plainly). Sources, so a reader can re-verify by hand without running
 * anything:
 *   - both ANCHORED quotes: plan/tasks.d/W1-T2648-*.yaml's rationale (itself illustrating the
 *     habit the plan already keeps).
 *   - the ANCHORLESS quote: plan/tasks.d/W1-T2481-*.yaml's rationale -- #3305's ORIGINAL
 *     citation, the exact case this task's title asks whether is an outlier or a class.
 */
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
