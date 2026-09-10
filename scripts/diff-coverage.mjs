#!/usr/bin/env node
// scripts/diff-coverage.mjs
//
// Per-diff coverage gate (W1-T212, recon R-12, MASTER-PLAN §5 tier 2 gate 1b). Blocks a PR that
// adds a source line lcov marks never-hit, complementing coverage-ratchet.mjs's aggregate floor,
// which is diff-blind by design and so cannot catch one untested addition in a large codebase.
//
// INVARIANT: reads the lcov report coverage-ratchet.mjs already produces, plus a unified diff, and
// blocks only an ADDED (`+`) line under a file lcov instruments that lcov recorded as never hit.
// A line lcov never instruments (comment, blank, brace) makes no claim and is skipped; a
// pre-existing uncovered line the diff did not add is out of scope. An added line whose identical
// text was REMOVED elsewhere in the same diff is a RELOCATION, not a regression, and is exempt --
// see computeRelocatedLines (W1-T2325). Falsifier: test/diff-coverage.test.ts.
//
// Usage: node scripts/diff-coverage.mjs --lcov <path> --diff <path>
// Defaults: --lcov coverage/lcov.info; --diff reads the unified diff from stdin if omitted.
//
// Exported (parseLcovHitsByFile, reconcileDuplicateFunctionDeclarations, addedLinesByFile,
// findUncoveredAddedLines) so a falsifier test can exercise the CLI process directly, the same
// split coverage-ratchet.mjs uses.
// Why: the vacuous-pass incident (#1399) and the W1-T2276 corrupted-merge measurement are archived
// in docs/forensics/diff-coverage.md#module-header.

import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { stripTypeScriptTypes } from 'node:module';
import { isMainModule } from "./lib/argv.mjs";
import { parseLcovRecords } from './lib/lcov.mjs';


/**
 * Parse an lcov report into `Map<filePath, Map<lineNumber, hitCount>>`, one inner map per
 * `SF:`/`end_of_record` block's `DA:<line>,<hits>` records.
 * INVARIANT: multiple `SF:<path>` blocks for one file are MERGED, never last-wins-replaced -- a
 * corrupted second block from node's multi-process merge (W1-T2276) would otherwise discard real
 * hit data. Falsifier: test/lcov-function-record-attribution.test.ts.
 * Why: docs/forensics/diff-coverage.md#parselcovhitsbyfile.
 * @param {string} lcovText
 */
export function parseLcovHitsByFile(lcovText) {
  const files = new Map();
  const fnLines = new Map();
  const fnHits = new Map();
  for (const record of parseLcovRecords(lcovText)) {
    const currentPath = record.sourceFile;
    let current = files.get(currentPath);
    if (!current) {
      current = new Map();
      files.set(currentPath, current);
    }
    // FN:<line>,<name> — a declared function; FNDA is the truth for whether it ran, not DA. A
    // LIST: one line can declare several (W1-T481). Why: docs/forensics/diff-coverage.md#fn-record-parsing.
    for (const { line: declLine, names } of record.fn) {
      if (!fnLines.has(currentPath)) fnLines.set(currentPath, new Map());
      const namesByLine = fnLines.get(currentPath);
      if (!namesByLine.has(declLine)) namesByLine.set(declLine, []);
      namesByLine.get(declLine).push(...names);
    }
    // ANY-NON-ZERO, never last-wins, so a later FNDA:0 for a duplicate pair can't erase a real
    // call count. Why: docs/forensics/diff-coverage.md#fnda-record-parsing.
    for (const { name, hits } of record.fnda) {
      if (!fnHits.has(currentPath)) fnHits.set(currentPath, new Map());
      const enteredByName = fnHits.get(currentPath);
      enteredByName.set(name, (enteredByName.get(name) ?? false) || hits > 0);
    }
    // ANY-HIGHER-WINS, never last-wins (W1-T2276, same reasoning as FNDA: above): a duplicate
    // DA: from another SF: block is only ever real evidence, so the larger count wins.
    for (const { line: ln, hits } of record.da) {
      current.set(ln, Math.max(current.get(ln) ?? 0, hits));
    }
  }
  reconcileDuplicateFunctionDeclarations(fnLines);
  return { hits: files, fnLines, fnHits };
}

/**
 * Collapse a merged lcov's duplicate (file, name) function declarations to one entry each: a
 * corrupted merge can emit the same function's `FN:` record at two lines (W1-T2276). Mutates
 * `fnLines` IN PLACE, keeping the LARGEST declared line -- every measured corrupted record sits
 * above the function's true declaration.
 * Falsifier: test/lcov-function-record-attribution.test.ts.
 * Why: docs/forensics/diff-coverage.md#reconcileduplicatefunctiondeclarations.
 * @param {Map<string, Map<number, string[]>>} fnLines
 */
export function reconcileDuplicateFunctionDeclarations(fnLines) {
  for (const namesByLine of fnLines.values()) {
    const linesByName = new Map();
    for (const [ln, names] of namesByLine) {
      for (const name of names) {
        if (!linesByName.has(name)) linesByName.set(name, []);
        linesByName.get(name).push(ln);
      }
    }
    for (const [name, lines] of linesByName) {
      if (lines.length <= 1) continue; // no duplicate for this name -- nothing to reconcile.
      const canonical = Math.max(...lines);
      for (const ln of lines) {
        if (ln === canonical) continue;
        const names = namesByLine.get(ln);
        const idx = names.indexOf(name);
        if (idx !== -1) names.splice(idx, 1);
        if (names.length === 0) namesByLine.delete(ln);
      }
    }
  }
}

/**
 * Walk a unified diff and return `Map<filePath, Map<lineNo, addedText>>` for lines the diff ADDS
 * (`+` only). The text rides along so the gate can recognise non-executable added lines without
 * re-reading the working tree. Parses `@@ -oldStart,oldLines +newStart,newLines @@` itself: context
 * and added lines each consume one new-file line number, removed lines consume none.
 * @param {string} diffText
 */
export function addedLinesByFile(diffText) {
  const files = new Map();
  let currentFile = null;
  let newLineNo = null;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      currentFile = null;
      newLineNo = null;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim();
      currentFile = path === '/dev/null' ? null : path.replace(/^b\//, '');
      newLineNo = null;
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      newLineNo = m ? Number(m[1]) : null;
      continue;
    }
    if (currentFile === null || newLineNo === null) continue;
    if (raw.startsWith('+')) {
      if (!files.has(currentFile)) files.set(currentFile, new Map());
      files.get(currentFile).set(newLineNo, raw.slice(1));
      newLineNo += 1;
    } else if (raw.startsWith('-')) {
      // removed line -- old-file only, consumes no new-file line number.
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" -- not a content line.
    } else {
      newLineNo += 1; // context line -- exists in both files.
    }
  }
  return files;
}

/**
 * The mirror of `addedLinesByFile`: `Map<filePath, Map<oldLineNo, removedText>>` for lines the
 * diff REMOVES. Keyed by the `+++ b/<path>` identity `addedLinesByFile` and lcov both use, so a
 * relocation match compares both sides of one file with no rename handling needed.
 * @param {string} diffText
 */
export function removedLinesByFile(diffText) {
  const files = new Map();
  let currentFile = null;
  let oldLineNo = null;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      currentFile = null;
      oldLineNo = null;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim();
      currentFile = path === '/dev/null' ? null : path.replace(/^b\//, '');
      oldLineNo = null;
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
      oldLineNo = m ? Number(m[1]) : null;
      continue;
    }
    if (currentFile === null || oldLineNo === null) continue;
    if (raw.startsWith('-')) {
      if (!files.has(currentFile)) files.set(currentFile, new Map());
      files.get(currentFile).set(oldLineNo, raw.slice(1));
      oldLineNo += 1;
    } else if (raw.startsWith('+')) {
      // added line -- new-file only, consumes no old-file line number.
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" -- not a content line.
    } else {
      oldLineNo += 1; // context line -- exists in both files.
    }
  }
  return files;
}

/**
 * Every non-deleted TypeScript source path on the new side of a diff. A file every shard omits
 * must fail rather than reaching findUncoveredAddedLines' "lcov never saw this file" carve-out.
 * @param {string} diffText
 */
export function changedSourceFiles(diffText) {
  const files = new Set();
  for (const line of diffText.split('\n')) {
    if (!line.startsWith('+++ ')) continue;
    const path = line.slice(4).trim();
    if (path === '/dev/null') continue;
    const relative = path.replace(/^b\//, '');
    if (relative.startsWith('src/') && relative.endsWith('.ts')) files.add(relative);
  }
  return [...files].sort();
}

/**
 * Does this file transpile to NOTHING EXECUTABLE (W1-T2570)? "No `SF:` record" has two causes --
 * no shard imported the file (the real vacuity hazard, #1399) or the file compiles to nothing --
 * and a pure type module was wrongly getting the first verdict. TRANSPILED, NEVER TEXT-SCANNED, a
 * distinction load-bearing enough that a text-scan first draft misjudged a real module type-only.
 * FAILS CLOSED on any read or transpile error, so a broken check can only under-exempt.
 * AND IT SAYS SO, via the optional `onUndecidable` collector — because "can only under-exempt" is
 * the safe direction, not a harmless one. MEASURED 2026-09-09 on #4872: this guard answered TRUE for
 * `src/lib/merge-state.ts` locally and the gate BLOCKED on that same file, on that same head, in
 * CI — twice, deterministically. Feeding a always-throwing guard the same diff reproduces CI's
 * output exactly, so the guard is failing in the runner; WHICH of read/require/transpile fails is
 * not knowable from a verdict that is a bare `false`. A type-only module is then reported as a
 * vacuous-coverage hazard, which is a confident and wrong diagnosis, and the remedy it implies —
 * "write a test that exercises this file" — is IMPOSSIBLE for a module that compiles to nothing.
 * Falsifier: test/a-module-that-compiles-to-nothing-is-not-a-coverage-gap.test.ts.
 * Why: docs/forensics/diff-coverage.md#istypeonlymodule.
 */
export function isTypeOnlyModule(file, readSource = (f) => readFileSync(f, 'utf8'), onUndecidable) {
  let source;
  try {
    source = readSource(file);
  } catch (err) {
    // FAILING CLOSED IS CORRECT AND STILL SILENT WITHOUT THIS. Reported, never rethrown: the verdict
    // is unchanged, only now the run can say the exemption did not get a chance to apply.
    onUndecidable?.({ file, stage: 'read', message: err?.message ?? String(err) });
    return false; // unreadable ⇒ not exempt
  }
  // NODE'S OWN STRIPPER, NOT esbuild, AND THE REASON IS THE JOB THIS RUNS IN. `coverage-ratchet`
  // installs NOTHING -- W1-T3207 asserts it in test/workflow-single-suite-run.test.ts ("the artifact
  // consumer installs neither npm dependencies nor Playwright", and separately that it "must not
  // need npm-installed tsx"). With no `node_modules`, `require('esbuild')` threw, this guard failed
  // closed, and EVERY type-only module was reported as a vacuous-coverage hazard under a remedy --
  // "write a test that exercises this file" -- that is impossible for a file with no executable
  // code. MEASURED 2026-09-09 on #4872: green locally, BLOCKED in CI on the same head twice.
  //
  // `module.stripTypeScriptTypes` is built into the pinned runtime (.nvmrc 22.22.3), so the
  // discriminator now needs nothing installed and the collector above has far less to report.
  //
  // IT STILL TRANSPILES; IT DOES NOT TEXT-SCAN. W1-T2570's trap stands -- a first draft reading
  // source for `function`/`class`/`=>` called `src/lib/proof-grammar.ts` type-only when it is 1,423
  // bytes of real emitted code. What is text-matched below is COMMENTS, and only in output the
  // stripper has already reduced to whitespace-plus-comments (esbuild dropped them; this preserves
  // them, which is the ONLY behavioural difference between the two).
  //
  // VALIDATED AGAINST esbuild OVER THE WHOLE CORPUS, 2026-09-09: 199 of 199 `src/**/*.ts` agree,
  // with ZERO disagreements in EITHER direction -- in particular zero where this exempts a file
  // esbuild does not, the only unsafe direction.
  let stripped;
  try {
    stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  } catch (err) {
    // `enum` and `namespace` EMIT code and the stripper refuses them in this mode, so a throw is the
    // correct "not type-only" answer. Still reported, because an unexpected throw is worth seeing.
    onUndecidable?.({ file, stage: 'transpile', message: err?.message ?? String(err) });
    return false; // cannot transpile ⇒ not exempt
  }
  const code = stripped.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  return code.trim().length === 0;
}

/** Changed source files absent from the merged LCOV surface, excluding type-only ones ({@link isTypeOnlyModule}). */
// Why: docs/forensics/diff-coverage.md#findmissingsourcecoverage.
export function findMissingSourceCoverage(diffText, lcov, isTypeOnly = isTypeOnlyModule, onUndecidable) {
  const hits = lcov.hits ?? lcov;
  return changedSourceFiles(diffText).filter(
    (file) => !hits.has(file) && !isTypeOnly(file, undefined, onUndecidable),
  );
}

/**
 * A RELOCATION, not an addition: a contiguous run of added lines whose trimmed text matches an
 * unconsumed, equally contiguous run of removed lines in the same diff (W1-T2325). Bounded three
 * ways: CONSUME-ONCE (a removed line matches at most one added line); a MINIMUM RUN of identical
 * contiguous lines, since a short match collides by coincidence far more often (MEASURED); and
 * GREEDY LONGEST-FIRST matching for a deterministic result. Names each line's exact counterpart.
 * Falsifier: test/diff-coverage.test.ts's relocation and consume-once cases.
 * Why: docs/forensics/diff-coverage.md#computerelocatedlines.
 * @param {Map<string, Map<number, string>>} added
 * @param {Map<string, Map<number, string>>} removed
 * @param {{minRun?: number}} [opts]
 * @returns {Map<string, Map<number, {counterpartLine: number, runLength: number}>>}
 */
export const MIN_RELOCATION_RUN = 5;

/**
 * Longest contiguous run of `A` starting at `i` that matches a contiguous, unconsumed run of `R`.
 * Greedy longest-first so the result is deterministic. Returns `{ j: -1, len: 0 }` when nothing
 * matches. Extracted by W1-T3138 only so the SAME matching rule can be applied to one candidate
 * source file at a time -- the comparison itself (trimmed text, contiguity on both sides,
 * consume-once) is unchanged from W1-T2325.
 * @param {Array<[number, string]>} A
 * @param {number} i
 * @param {Array<[number, string]>} R
 * @param {Set<number>} consumed
 */
/**
 * The form a line is COMPARED in when hunting for a relocation: `trim()` as always, plus
 * template-literal unescaping (W1-T3189). Code inside a `...` literal carries a backslash before
 * every backtick and `${`; lifting it into a real module strips them, so raw comparison read a
 * move as a rewrite. The costly part is second-order: an unmatched line SPLITS the run around it,
 * so a few escaped lines disqualified the unescaped ones beside them once either piece fell under
 * {@link MIN_RELOCATION_RUN} -- on #4522, 293 escape-affected lines cost 486 (3229 -> 3715).
 * Applied to BOTH sides, so a move INTO a literal normalises identically. Admits nothing new in
 * principle: a relocation is still a contiguous run of >= MIN_RELOCATION_RUN, consumed once.
 * @param {string} text
 */
export function relocationKey(text) {
  return text.replace(/\\`/g, "`").replace(/\\\$\{/g, "${").replace(/\\\\/g, "\\").trim();
}

function bestRunAt(A, i, R, consumed) {
  let bestJ = -1;
  let bestLen = 0;
  for (let j = 0; j < R.length; j++) {
    if (consumed.has(j)) continue;
    if (R[j][1] !== A[i][1]) continue;
    let len = 1;
    while (
      i + len < A.length &&
      j + len < R.length &&
      !consumed.has(j + len) &&
      A[i + len][0] === A[i + len - 1][0] + 1 && // added run stays contiguous in the new file
      R[j + len][0] === R[j + len - 1][0] + 1 && // removed run stays contiguous in the old file
      R[j + len][1] === A[i + len][1]
    ) {
      len++;
    }
    if (len > bestLen) {
      bestLen = len;
      bestJ = j;
    }
  }
  return { j: bestJ, len: bestLen };
}

export function computeRelocatedLines(added, removed, { minRun = MIN_RELOCATION_RUN } = {}) {
  const relocated = new Map();
  // Sorted once per SOURCE file and shared across destinations, with `consumed` keyed by that file
  // so one removed run can never be spent twice -- W1-T2325's consume-once bound, now across files.
  /** @type {Map<string, {R: Array<[number, string]>, consumed: Set<number>}>} */
  const sources = new Map();
  const sourceFor = (file) => {
    let e = sources.get(file);
    if (e === undefined) {
      const lines = removed.get(file);
      if (!lines) return undefined;
      e = { R: [...lines.entries()].map(([n, t]) => [n, relocationKey(t)]).sort((a, b) => a[0] - b[0]), consumed: new Set() };
      sources.set(file, e);
    }
    return e;
  };

  for (const [file, addedLines] of added) {
    const A = [...addedLines.entries()].map(([n, t]) => [n, relocationKey(t)]).sort((a, b) => a[0] - b[0]);
    const fileMap = new Map();
    let i = 0;
    while (i < A.length) {
      // (iii) THE DESTINATION FILE'S OWN REMOVED LINES ARE SEARCHED FIRST, so a within-file move
      // keeps exactly the pairing it had before W1-T3138 and today's verdicts are a strict subset
      // of tomorrow's. A cross-file source is consulted ONLY when the same-file search finds no run
      // long enough -- never to win a tie against it.
      let chosenFile = file;
      let own = sourceFor(file);
      let best = own === undefined ? { j: -1, len: 0 } : bestRunAt(A, i, own.R, own.consumed);
      if (best.len < minRun) {
        // (i) Then every OTHER file that lost lines in this same diff. The added run must map onto a
        // contiguous run within ONE source file: each candidate is scored on its own, so a
        // "relocation" can never be stitched together out of fragments of two different files.
        for (const [candidate] of removed) {
          if (candidate === file) continue;
          const src = sourceFor(candidate);
          if (src === undefined) continue;
          const r = bestRunAt(A, i, src.R, src.consumed);
          if (r.len > best.len) {
            best = r;
            chosenFile = candidate;
          }
        }
      }
      if (best.j !== -1 && best.len >= minRun) {
        const src = sourceFor(chosenFile);
        for (let k = 0; k < best.len; k++) {
          src.consumed.add(best.j + k);
          fileMap.set(A[i + k][0], {
            counterpartLine: src.R[best.j + k][0],
            runLength: best.len,
            // (iv) NAMED so the exemption is auditable: a reviewer can open that file and check the
            // claim instead of taking it. For a same-file move this is the destination itself,
            // which is what the report already printed.
            counterpartFile: chosenFile,
          });
        }
        i += best.len;
      } else {
        i += 1;
      }
    }
    if (fileMap.size > 0) relocated.set(file, fileMap);
  }
  return relocated;
}

/**
 * A line that cannot carry executable coverage no matter what lcov says: blank, a `//` line, or
 * block-comment furniture. Under `--enable-source-maps` (W1-T210 round 2) a new file's leading
 * comment block gets `DA:<line>,0` records too, so the gate would false-block every file that
 * opens with a doc comment without this carve-out. The diff already carries each added line's
 * text, so this reads it directly rather than trusting DA presence as an executability signal.
 * @param {string} text
 */
export function isNonExecutableLine(text) {
  const t = text.trim();
  if (t === '') return true;
  if (t.startsWith('//')) return true;
  if (t.startsWith('/*') || t.startsWith('*')) return true; // /** ... * ... *\/ furniture
  if (/^[}\)\];,]+$/.test(t)) return true; // closer-only punctuation (`};`, `})`, ...) carries no logic
  // A type-only import erases COMPLETELY at transpile, so it is safe to recognise per-line --
  // unlike an interface/type-literal BODY line, which needs computeTypeOnlyRanges's brace context.
  if (/^import\s+type\b/.test(t)) return true;
  return false;
}

/**
 * The line ranges of a TypeScript `interface`/object-`type` declaration -- its body compiles to
 * ZERO runtime JS, so every member line still gets a `DA:<line>,0` record no test can ever turn
 * positive (W1-T171 false-blocked a new file for exactly this). A bare line like `task: string;`
 * is only safe to exempt once the surrounding brace structure confirms it sits inside the
 * declaration -- the same brace-matching shape as computeBoundaryRanges, needing no directive
 * since a type body can never carry business logic.
 * Falsifier: test/diff-coverage.test.ts's type-only cases.
 * @param {string} fileText
 * @returns {Array<{start: number, end: number, reason: string, kind: 'type-only'}>}
 */
export function computeTypeOnlyRanges(fileText) {
  const lines = fileText.split('\n');
  const ranges = [];
  const OPEN = /^(\s*)(?:export\s+)?(?:declare\s+)?interface\s+\S.*\{\s*$/;
  const TYPE_OPEN = /^(\s*)(?:export\s+)?type\s+\S+[^={]*=\s*\{\s*$/;
  const CLOSER = /^(\s*)\}/;
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]) ?? TYPE_OPEN.exec(lines[i]);
    if (!m) continue;
    const indent = m[1];
    let end = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const cm = CLOSER.exec(lines[k]);
      if (cm && cm[1] === indent) {
        end = k;
        break;
      }
    }
    if (end === -1) continue; // no matching closer found -- leave unexempted, the gate stays safe
    ranges.push({
      start: i + 1,
      end: end + 1,
      reason: 'interface/type-literal member -- erases to zero runtime code, can never carry a hit',
      kind: 'type-only',
    });
  }
  return ranges;
}

/**
 * Recognise the `// diff-cov: process-boundary — <reason>` directive and return the regions it
 * exempts (W1-T221 / PR #662, W1-T83 / PR #698): re-exec/exit or a thin `spawnWorker(...)`
 * wrapper, glue that cannot carry a hit without actually forking. Honoured only when the directive
 * precedes a small (<= MAX_BOUNDARY_EXEC_LINES) declaration with a DIRECT boundary call -- an
 * indirect caller is NOT exempt, since it typically carries real orchestration logic. Anything
 * else is INVALID and fails CLOSED; every honoured exemption is logged by main().
 * Falsifier: test/diff-coverage.test.ts's process-boundary cases.
 * @param {string} fileText
 * @returns {{ranges: Array<{start:number,end:number,reason:string,directiveLine:number}>, errors: Array<{directiveLine:number,message:string}>}}
 */
export const MAX_BOUNDARY_EXEC_LINES = 15;
const BOUNDARY_CALL =
  /\b(?:spawnSync|execFileSync)\(\s*process\.execPath\b|\bprocess\.exit(?:Code\s*=|\s*\()|\bspawnWorker\s*\(/;

/**
 * W1-T3304 — A REAL BROWSER IS A SECOND KIND OF IRREDUCIBLE I/O, AND IT GETS ITS OWN WORD.
 *
 * `process-boundary` stays exactly as narrow as it is: re-exec and exit glue, nothing else. Widening
 * it to cover browsers would have made one word mean two things and put a 46-line function under a
 * predicate written for a 3-line one. A blanket exemption is how coverage gates die.
 *
 * WHY A SEPARATE CAP AND NOT THE SAME 15. Re-exec glue is irreducibly TINY -- spawn, exit, done.
 * Driving a browser is irreducibly WORDIER: launch, context, page, navigate, evaluate, close, and
 * the error arm for each. MEASURED 2026-09-09 on the only real instance in the tree,
 * `defaultOpenViewport` in scripts/console-live-review.mjs (#4865): 66 raw lines, 46 executable by
 * this file's own `isNonExecutableLine` metric. 60 clears that with modest headroom and still
 * refuses an orchestration function that has grown a second job.
 *
 * THE COST, STATED PLAINLY: 60 is a lot of unmeasured lines to hand out on one comment, and the
 * only thing bounding it is the predicate below — which demands a REAL launch call in the guarded
 * declaration, so the directive cannot be pasted over ordinary logic. That is ONE guard where
 * `process-boundary` effectively has two (a rare call AND a tiny ceiling). Every honoured exemption
 * is still printed by main() with its reason, so none of this is silent.
 * RE-DERIVE THIS NUMBER once more instances exist; it is sized from a population of one.
 */
export const MAX_BROWSER_EXEC_LINES = 60;
const BROWSER_LAUNCH_CALL =
  /\b(?:chromium|firefox|webkit|browserType|puppeteer)\s*\.\s*(?:launch|launchPersistentContext)\s*\(/;

/** The author-written `diff-cov:` directives, each with the call its guarded declaration must
 *  actually contain and the ceiling it may not exceed. A directive whose predicate is unenforceable
 *  is a comment (W1-T3304 design (ii)), so every entry here carries one. */
const DIRECTIVE_KINDS = {
  'process-boundary': {
    call: BOUNDARY_CALL,
    maxExecLines: MAX_BOUNDARY_EXEC_LINES,
    missing:
      'guarded declaration contains no process-boundary call (spawnSync/execFileSync(process.execPath …) or process.exit) — the directive may only exempt re-exec/exit glue',
    extract: 'the non-boundary logic',
  },
  'browser-boundary': {
    call: BROWSER_LAUNCH_CALL,
    maxExecLines: MAX_BROWSER_EXEC_LINES,
    missing:
      'guarded declaration contains no browser launch (chromium/firefox/webkit/browserType/puppeteer .launch(…)) — the directive may only exempt a region that genuinely drives a real browser',
    extract: 'the pure result-shaping beside the browser calls',
  },
};

/** Every directive word an author may write, for the fail-closed message when they write another. */
export const DIFF_COV_DIRECTIVES = Object.keys(DIRECTIVE_KINDS).sort();
export function computeBoundaryRanges(fileText) {
  const lines = fileText.split('\n');
  const ranges = [];
  const errors = [];
  // ANY word, not just the one that existed — an unrecognised directive must REFUSE and say which
  // words exist (W1-T3304 design (iii)). Before this, `// diff-cov: anything-else` matched nothing,
  // was silently ignored, and the author learned only that their lines were uncovered. #4865 stalled
  // on the neighbouring version of that: told the directive it used was wrong, and no right one.
  const DIRECTIVE_TAG = /^\s*\/\/\s*diff-cov:\s*([a-z][a-z-]*)\b(.*)$/;
  const CLOSER = /^(\s*)\}/;
  for (let i = 0; i < lines.length; i++) {
    const tag = DIRECTIVE_TAG.exec(lines[i]);
    if (!tag) continue;
    const directiveLine = i + 1; // 1-indexed, matches lcov/diff line numbers
    const word = tag[1];
    const spec = DIRECTIVE_KINDS[word];
    if (!spec) {
      errors.push({
        directiveLine,
        message: `unrecognised diff-cov directive "${word}" — the directives that exist are: ${DIFF_COV_DIRECTIVES.join(', ')}`,
      });
      continue;
    }
    const reasonMatch = /^\s*[—–-]+\s*(\S.*)$/.exec(tag[2]);
    if (!reasonMatch) {
      errors.push({ directiveLine, message: `${word} directive requires "— <reason>"` });
      continue;
    }
    const reason = reasonMatch[1].trim();
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++; // the declaration it guards
    if (j >= lines.length) {
      errors.push({ directiveLine, message: `no declaration follows the ${word} directive` });
      continue;
    }
    const declIndent = (lines[j].match(/^\s*/) ?? [''])[0];
    let end = -1;
    for (let k = j + 1; k < lines.length; k++) {
      const cm = CLOSER.exec(lines[k]);
      if (cm && cm[1] === declIndent) { end = k; break; }
    }
    if (end === -1) {
      errors.push({ directiveLine, message: 'could not find the end of the guarded declaration' });
      continue;
    }
    const start = j + 1; // 1-indexed decl line
    const endLine = end + 1;
    const bodyText = lines.slice(j, end + 1).join('\n');
    if (!spec.call.test(bodyText)) {
      errors.push({ directiveLine, message: spec.missing });
      continue;
    }
    const execCount = lines
      .slice(j, end + 1)
      .filter((t) => !isNonExecutableLine(t)).length;
    if (execCount > spec.maxExecLines) {
      errors.push({
        directiveLine,
        message: `guarded declaration has ${execCount} executable lines (> ${spec.maxExecLines}) — too large to exempt; extract ${spec.extract} and test it`,
      });
      continue;
    }
    ranges.push({ start, end: endLine, reason, directiveLine, kind: word });
  }
  return { ranges, errors };
}

/**
 * Compare added lines against lcov hit data.
 * @param {Map<string, Map<number, string>>} added
 * @param {Map<string, Map<number, number>>} lcovHits
 * @returns {string[]} `file:line` violations, sorted; empty means the gate is satisfied.
 */
export function findUncoveredAddedLines(added, lcov) {
  const violations = [];
  const lcovHits = lcov.hits ?? lcov; // tolerate the pre-FN Map shape (older callers/tests)
  const fnLines = lcov.fnLines ?? new Map();
  const fnHits = lcov.fnHits ?? new Map();
  for (const [file, lines] of added) {
    const hitsByLine = lcovHits.get(file);
    if (!hitsByLine) continue; // lcov never saw this file (e.g. test/**) -- no claim to make.
    const fnsAt = fnLines.get(file);
    const fnHit = fnHits.get(file);
    // A declaration line is covered if ANY function declared there was entered (W1-T481).
    // Why: docs/forensics/diff-coverage.md#finduncoveredaddedliness-declentered-rescue.
    const declEntered = (ln) => {
      const names = fnsAt?.get(ln);
      if (names === undefined) return false;
      return names.some((name) => fnHit?.get(name) === true);
    };
    const uncovered = [...lines.keys()]
      .filter((ln) => hitsByLine.has(ln) && hitsByLine.get(ln) === 0)
      .filter((ln) => !isNonExecutableLine(lines.get(ln) ?? ''))
      .filter((ln) => !declEntered(ln)) // an ENTERED function's declaration line is covered, whatever DA says
      .sort((a, b) => a - b);
    for (const ln of uncovered) violations.push(`${file}:${ln}`);
  }
  return violations.sort();
}

// SELF-DESCRIBING FAILURES: a red run used to name its cause only in the job log, unreachable
// from a diagnosing agent, so this writes an ANNOTATION instead (a workflow command GitHub turns
// into a readable check-run annotation), gated on `RMD_CI_REPORT` (set per-STEP in ci.yml) so a
// blocking test fixture never publishes as a real annotation.
// Why: the #2828/#2895 incident is archived in docs/forensics/diff-coverage.md#self-describing-failures-the-check-run-annotation-channel.

/** Render a blocked/clean report as one plain-text block. Pure: no env, no I/O. */
export function formatCiReport(tool, headline, details, { cap = 100 } = {}) {
  const shown = details.slice(0, cap);
  const lines = [`${tool}: ${headline}`, ...shown.map((d) => `  - ${d}`)];
  // No silent caps: a trimmed list says so and names the cap (same rule the exempt-line printing below follows).
  if (details.length > shown.length) {
    lines.push(`  ... ${details.length - shown.length} more not listed (cap ${cap})`);
  }
  return lines.join('\n');
}

/** Encode a report for a `::error::` workflow command. `%` FIRST or the escapes eat each other. */
export function encodeAnnotation(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Write the report to the two channels a job can actually reach. No-op unless RMD_CI_REPORT is set. */
export function emitCiReport(tool, report, { blocked, env = process.env, log = console.log, append = null } = {}) {
  if (!env.RMD_CI_REPORT) return false;
  if (blocked) log(`::error title=${tool}::${encodeAnnotation(report)}`);
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const write = append ?? appendFileSync;
    write(summaryPath, `### ${tool}\n\n\u0060\u0060\u0060\n${report}\n\u0060\u0060\u0060\n\n`);
  }
  return true;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      lcov: { type: 'string', default: 'coverage/lcov.info' },
      diff: { type: 'string' },
    },
  });

  const lcovText = readFileSync(values.lcov, 'utf8');
  const diffText = values.diff ? readFileSync(values.diff, 'utf8') : readFileSync(0, 'utf8');
  const lcovHits = parseLcovHitsByFile(lcovText);
  const undecidable = [];
  const missingSourceFiles = findMissingSourceCoverage(diffText, lcovHits, isTypeOnlyModule, (d) =>
    undecidable.push(d));
  if (missingSourceFiles.length > 0) {
    const headline =
      'BLOCKED -- changed source file(s) have no SF record in the coverage report; ' +
      'coverage would otherwise pass vacuously:';
    // THE TYPE-ONLY EXEMPTION MAY SIMPLY NOT HAVE RUN, and without this the two causes of a blocked
    // file are indistinguishable in the log. Named here rather than left to a re-run: a re-run
    // reproduces it identically and teaches nothing.
    const detail = undecidable.map(
      (d) => `  ! ${d.file}: the type-only exemption could not be decided (${d.stage}: ${d.message})`,
    );
    console.error(`diff-coverage: ${headline}`);
    for (const file of missingSourceFiles) console.error(`  - ${file}`);
    for (const line of detail) console.error(line);
    emitCiReport(
      'diff-coverage',
      formatCiReport('diff-coverage', headline, [...missingSourceFiles, ...detail]),
      { blocked: true },
    );
    process.exitCode = 1;
    return;
  }
  const added = addedLinesByFile(diffText);
  const removed = removedLinesByFile(diffText);
  const rawViolations = findUncoveredAddedLines(added, lcovHits);
  // See computeRelocatedLines (W1-T2325) for the consume-once / contiguous-run bounds.
  const relocatedByFile = computeRelocatedLines(added, removed);

  // Resolve process-boundary/type-only ranges only for files with an uncovered added line.
  const filesWithViolations = new Set(rawViolations.map((v) => v.slice(0, v.lastIndexOf(':'))));
  const rangesByFile = new Map();
  const directiveErrors = [];
  for (const file of filesWithViolations) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // file not on disk (renamed/deleted) -- nothing to exempt, violation stands
    }
    const { ranges, errors } = computeBoundaryRanges(text);
    const typeOnlyRanges = computeTypeOnlyRanges(text);
    const allRanges = [...ranges, ...typeOnlyRanges];
    if (allRanges.length > 0) rangesByFile.set(file, allRanges);
    for (const e of errors) directiveErrors.push({ file, ...e });
  }

  if (directiveErrors.length > 0) {
    const headline = 'INVALID process-boundary directive(s) -- the gate fails closed:';
    const details = directiveErrors.map((e) => `${e.file}:${e.directiveLine} -- ${e.message}`);
    console.error(`diff-coverage: ${headline}`);
    for (const d of details) console.error(`  - ${d}`);
    emitCiReport('diff-coverage', formatCiReport('diff-coverage', headline, details), { blocked: true });
    process.exitCode = 1;
    return;
  }

  const exempt = [];
  const blocking = [];
  for (const v of rawViolations) {
    const idx = v.lastIndexOf(':');
    const file = v.slice(0, idx);
    const ln = Number(v.slice(idx + 1));
    const hit = (rangesByFile.get(file) ?? []).find((r) => ln >= r.start && ln <= r.end);
    if (hit) {
      exempt.push({ v, reason: hit.reason, kind: hit.kind ?? 'process-boundary' });
      continue;
    }
    // Relocation resolves per EXACT line, never a range -- see computeRelocatedLines.
    const reloc = relocatedByFile.get(file)?.get(ln);
    if (reloc) {
      exempt.push({
        v,
        reason: `relocated from ${reloc.counterpartFile}:${reloc.counterpartLine} (${reloc.runLength}-line contiguous match against the diff's removed lines)`,
        kind: 'relocated',
      });
      continue;
    }
    blocking.push(v);
  }

  // No silent caps: every exempted line prints its declared reason, auditable in the CI log.
  for (const e of exempt) console.log(`diff-coverage: exempt (${e.kind}) ${e.v} -- ${e.reason}`);

  if (blocking.length > 0) {
    const headline =
      'BLOCKED -- this diff adds source line(s) with zero covering tests, even ' +
      'though the aggregate coverage-ratchet floor may still be satisfied:';
    console.error(`diff-coverage: ${headline}`);
    for (const v of blocking) console.error(`  - ${v}`);
    emitCiReport('diff-coverage', formatCiReport('diff-coverage', headline, blocking), { blocked: true });
    process.exitCode = 1;
    return;
  }

  console.log('diff-coverage: OK -- every added source line lcov instruments is covered.');
  emitCiReport(
    'diff-coverage',
    formatCiReport('diff-coverage', 'OK -- every added source line lcov instruments is covered.', []),
    { blocked: false },
  );
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/diff-coverage.mjs ...`), never on import.
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
