#!/usr/bin/env node
// scripts/diff-coverage.mjs
//
// Per-diff coverage gate (W1-T212, recon R-12, MASTER-PLAN §5 TIER 2 gate 1b).
//
// scripts/coverage-ratchet.mjs's floor is aggregate-only: it sums LF/LH/BRF/BRH across every
// file record in the lcov report and compares two scalars against a recorded baseline. That is
// diff-blind BY DESIGN (test/coverage-ratchet.test.ts's PLAN-ONLY FALSIFIER proves it never reads
// which files a PR touched) -- which means new code with ZERO covering tests merges freely as
// long as the codebase-wide aggregate stays above the floor. The larger remudero grows, the less
// any single untested addition can move that aggregate, so the floor's protection erodes over
// time even though its own tests never change.
//
// This script is a SEPARATE, diff-scoped check that closes that hole without touching the
// aggregate ratchet: it reads the SAME lcov report the aggregate ratchet already produces (no new
// tooling -- the node --test lcov reporter already emits one SF:/DA: record per file, which is
// exactly why the aggregate has to sum them) plus a unified diff, and fails when the diff ADDS a
// line under a file lcov instruments (a `DA:<line>,<hits>` record exists for it) that lcov
// recorded as NEVER HIT (`hits === 0`). A line the diff adds that lcov never instruments at all
// (a comment, a blank line, a brace -- no DA: record for that line) makes no coverage claim
// either way, so it is silently skipped: this gate only polices lines lcov itself considers
// coverable, and only lines the diff itself added (an already-uncovered pre-existing line is the
// aggregate ratchet's problem, not a new regression this diff introduced).
//
// W1-T2325: a "the diff itself added" line and a PRE-EXISTING line that merely moved during a
// restructure both show up as a `+`, and only the first of those is actually this diff's problem.
// computeRelocatedLines (below) recovers the discriminator -- identical text on the diff's own
// `-` side -- and treats a match as exempt, the same way the process-boundary and type-only
// carve-outs already are, never a bypass on the genuinely-new case.
//
// Usage:
//   node scripts/diff-coverage.mjs --lcov <path> --diff <path>
//
// Defaults: --lcov coverage/lcov.info; --diff reads the unified diff from stdin if omitted.
//
// The pure functions below (parseLcovHitsByFile, reconcileDuplicateFunctionDeclarations,
// addedLinesByFile, findUncoveredAddedLines) are exported so a falsifier fixture test can exercise
// the CLI process directly (spawn + exit code) as well as the parsing/comparison logic in
// isolation, the same split coverage-ratchet.mjs uses.

import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/**
 * Parse an lcov report into `Map<filePath, Map<lineNumber, hitCount>>` -- one inner map per
 * `SF:`/`end_of_record` block, populated from that block's `DA:<line>,<hits>` records.
 *
 * MULTIPLE `SF:<path>` BLOCKS FOR THE SAME FILE ARE MERGED, NEVER LAST-WINS-REPLACED (W1-T2276).
 * `--experimental-test-coverage`'s own multi-process merge can emit a SECOND, MALFORMED record
 * for a file -- observed on `src/lib/ledger.ts`: a test file that cannot report its own coverage
 * at all (a `startOffset` crash, zero-byte lcov standalone) instead contributes a shifted copy of
 * ANOTHER module's function table when merged with any sibling, with every `FN:` declaration line
 * exactly 3 lines above its true position. Before this fix, a second `SF:` line for a path already
 * seen replaced `current` with a brand-new empty map, so whichever block the reporter happened to
 * write LAST silently discarded the other block's `DA:` data outright -- measured: 99 lines a
 * single clean process reports as executed (nonzero `DA:`) read `DA:<line>,0` in the merged
 * report, over an IDENTICAL 1,510-line `DA:` line-number set (nothing phantom was added to the
 * denominator; real hits were simply overwritten by a later, zero-valued duplicate). Reusing the
 * SAME per-line map across every `SF:<path>` block for that path turns the DA: reconciliation
 * below into the fix, rather than requiring a second pass.
 * @param {string} lcovText
 */
export function parseLcovHitsByFile(lcovText) {
  const files = new Map();
  const fnLines = new Map();
  const fnHits = new Map();
  let current = null;
  let currentPath = null;
  for (const line of lcovText.split('\n')) {
    if (line.startsWith('SF:')) {
      currentPath = line.slice(3).trim();
      current = files.get(currentPath);
      if (!current) {
        current = new Map();
        files.set(currentPath, current);
      }
    } else if (line.startsWith('FN:') && current) {
      // FN:<line>,<name> — a function DECLARED at <line>. Under --enable-source-maps the
      // tsx-compiled map scores declaration lines DA:0 even when the function body is fully
      // covered (observed: FN:62 with FNDA:11 beside DA:62,0) — FNDA is the truth for them.
      //
      // ONE LINE CAN DECLARE SEVERAL FUNCTIONS, so this is a LIST, never a single name (W1-T481).
      // Measured on a full-suite lcov: 282 (file, line) keys carry more than one FN record against
      // 4,042 distinct keys — about one declaration line in fourteen. The shape is always the same,
      // an exported function sharing its line with an anonymous callback (`buildAccountUsageRoute`
      // with `anonymous_14`; `runAlertLane` with `anonymous_12`). Keyed last-wins, the line resolved
      // to the anonymous one and an entered function was reported as never entered.
      const [ln, name] = line.slice(3).split(',');
      if (!fnLines.has(currentPath)) fnLines.set(currentPath, new Map());
      const namesByLine = fnLines.get(currentPath);
      const declLine = Number(ln);
      if (!namesByLine.has(declLine)) namesByLine.set(declLine, []);
      namesByLine.get(declLine).push(name);
    } else if (line.startsWith('FNDA:') && current) {
      // ANY-NON-ZERO, never last-wins. The same (file, name) pair recurs throughout a merged
      // full-suite lcov (measured: 1,362 duplicate pairs, 48 of them with more than one NON-ZERO
      // value — `findMergedByTrailer` carries both FNDA:79 and FNDA:1089), so a later FNDA:0 would
      // erase an earlier real call count. This is deliberately NOT an arithmetic: the sole consumer
      // is declEntered, which asks only `was this function ever entered`, so summing or maxing would
      // invent a call count nothing reads.
      const [hits, name] = line.slice(5).split(',');
      if (!fnHits.has(currentPath)) fnHits.set(currentPath, new Map());
      const enteredByName = fnHits.get(currentPath);
      enteredByName.set(name, (enteredByName.get(name) ?? false) || Number(hits) > 0);
    } else if (line.startsWith('DA:') && current) {
      // ANY-HIGHER-WINS, never last-wins (W1-T2276, same ANY-NON-ZERO shape FNDA: above already
      // uses for exactly this reason). A duplicate `DA:<line>,<hits>` for a line already seen in
      // this file's OTHER `SF:` block(s) can only ever be evidence -- some process really did
      // execute that line N times -- so keeping the larger of the two counts can never invent a
      // false claim of coverage; overwriting a real, nonzero count with a later, zero-valued
      // duplicate (last-wins, the pre-fix behaviour) is what erased 99 genuinely-covered lines to
      // `DA:<line>,0` in the corrupted merge this task measured.
      const [lineNoStr, hitsStr] = line.slice(3).split(',');
      const ln = Number(lineNoStr);
      const hits = Number(hitsStr);
      current.set(ln, Math.max(current.get(ln) ?? 0, hits));
    } else if (line.startsWith('end_of_record')) {
      current = null;
      currentPath = null;
    }
  }
  reconcileDuplicateFunctionDeclarations(fnLines);
  return { hits: files, fnLines, fnHits };
}

/**
 * THE THIRD (file, name) RECONCILIATION, BESIDE `fnLines`'s per-line name LIST and `fnHits`'s
 * ANY-NON-ZERO merge above (W1-T2276): a merged lcov can carry the SAME function name declared at
 * TWO DIFFERENT lines in one file -- not "one line declares several functions" (a legitimate,
 * different shape those two mitigations already handle, W1-T481), but one function whose `FN:`
 * record itself was emitted twice, at two different line numbers, by two different processes'
 * merged coverage. Observed on `src/lib/ledger.ts`: 16 function names each carrying two `FN:`
 * records, every one of the 16 pairs exactly 3 lines apart (`rotateLedger` at both 1095 and 1098;
 * `appendLedger`, uncorrupted, carries exactly one). Mutates `fnLines` (`Map<path, Map<declLine,
 * name[]>>`) IN PLACE, same shape as `dedupeRollupByLatestAttempt` (src/lib/sweep.ts): group by
 * key -- here `(path, name)` -- and collapse every duplicate group down to exactly one entry.
 *
 * The kept line is the LARGEST of the duplicate's declared lines. This is not an arbitrary
 * tie-break: every corrupted pair measured has the malformed record 3 lines ABOVE the function's
 * true declaration (this task's own title), so the true line is always the larger one; a name
 * that legitimately appears at only one line is untouched either way. The smaller (phantom) line's
 * entry is removed for that name only -- never the whole line, which may still legitimately carry
 * OTHER function names (W1-T481) -- so a function whose real declaration coincidentally shares a
 * line with a phantom duplicate is unaffected.
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
 * Walk a unified diff (`git diff <base>...HEAD` output) and return
 * `Map<filePath, Map<lineNo, addedText>>` for lines the diff ADDS (`+` lines only -- never
 * context or removed lines). The TEXT rides along so the gate can recognise non-executable
 * added lines (comments/blanks) without re-reading the working tree.
 * Dependency-free hunk-header parser: `@@ -oldStart,oldLines +newStart,newLines @@` gives the
 * new-file starting line; context and added lines each consume one new-file line number in
 * order, removed lines consume none (they exist only in the old file).
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
      // Removed line -- exists only in the old file; does not consume a new-file line number.
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" -- not a content line, no line number to consume.
    } else {
      // Context line -- exists in both files.
      newLineNo += 1;
    }
  }
  return files;
}

/**
 * The mirror of `addedLinesByFile`: walk the same unified diff and return
 * `Map<filePath, Map<oldLineNo, removedText>>` for lines the diff REMOVES (`-` lines only).
 * Keyed by the file's `+++ b/<path>` identity (the SAME key `addedLinesByFile` and the lcov
 * report use), not `--- a/<path>` -- a relocation match compares an added line in the new tree
 * against a removed line from the SAME file's old content, and this repo's diffs are read (and
 * this gate's own fixtures are written) without a rename in play, so the `+++` path is both the
 * simpler read and the one every other map in this file already keys by. Old-file line numbers
 * (from the hunk header's `@@ -oldStart,oldLines +newStart,newLines @@`) are what a human reading
 * `git diff` sees beside a `-` line, so the relocation report below names counterparts by them.
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
      // Added line -- exists only in the new file; does not consume an old-file line number.
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" -- not a content line, no line number to consume.
    } else {
      // Context line -- exists in both files.
      oldLineNo += 1;
    }
  }
  return files;
}

/**
 * A RELOCATION, not an addition: a contiguous run of added lines whose trimmed text matches an
 * unconsumed, equally contiguous run of removed lines in the SAME diff (W1-T2325). The header
 * comment above already settles the policy question -- "an already-uncovered pre-existing line is
 * the aggregate ratchet's problem, not a new regression this diff introduced)" -- and a line that
 * merely moved to a new offset during a restructure IS pre-existing text by that definition, even
 * though the diff can only ever show it as a `+`. This function recovers the ONLY evidence that
 * distinguishes the two cases: identical text on the `-` side of the SAME changeset.
 *
 * THREE BOUNDS keep this from becoming a bypass (see the shard's design, Q3):
 *
 * (i) CONSUME-ONCE. Each removed line matches AT MOST ONE added line -- `consumed` below is a
 * per-file Set of removed-array indices, checked before every candidate match. Duplicating an
 * untested block three times exempts only the first copy; the other two have no unconsumed
 * counterpart left and still block (relocated-duplicate.diff/.lcov fixture).
 *
 * (ii) A RUN, NOT A LINE. `MIN_RELOCATION_RUN` lines of identical, line-number-contiguous text are
 * required before a match counts at all -- a lone `return;` or `const x = 0;` collides with base
 * text by coincidence far too often to trust. This was MEASURED, not picked by taste: scanning
 * src/run-task.ts (29,352 lines) for non-trivial trimmed-text runs that recur anywhere else in the
 * same file, the coincidental-collision rate falls from 1,065/15,376 (~6.9%) at a 1-line run to
 * 77/7,510 (~1.0%) at 5 lines -- a single line is roughly 7x more likely to be a coincidence than a
 * genuine relocation than a 5-line run is.
 *
 * (iii) GREEDY, LONGEST-FIRST, LEFT TO RIGHT. For each added line not yet claimed by an earlier
 * match, every unconsumed removed line with matching text is tried as a possible run start, and the
 * LONGEST resulting contiguous match wins (ties keep the first candidate found). This makes the
 * match deterministic and biases toward the strongest evidence rather than the first coincidence.
 *
 * Every accepted line pairs 1:1 with exactly one counterpart old-line number, so the caller can
 * print the exact counterpart per Q3(iii) of the design ("PRINT EVERY EXEMPTION, naming the
 * counterpart") -- never just "this file had a relocation somewhere".
 * @param {Map<string, Map<number, string>>} added
 * @param {Map<string, Map<number, string>>} removed
 * @param {{minRun?: number}} [opts]
 * @returns {Map<string, Map<number, {counterpartLine: number, runLength: number}>>}
 */
export const MIN_RELOCATION_RUN = 5;
export function computeRelocatedLines(added, removed, { minRun = MIN_RELOCATION_RUN } = {}) {
  const relocated = new Map();
  for (const [file, addedLines] of added) {
    const removedLines = removed.get(file);
    if (!removedLines) continue;
    const A = [...addedLines.entries()].sort((a, b) => a[0] - b[0]);
    const R = [...removedLines.entries()].sort((a, b) => a[0] - b[0]);
    const consumed = new Set();
    const fileMap = new Map();
    let i = 0;
    while (i < A.length) {
      let bestJ = -1;
      let bestLen = 0;
      for (let j = 0; j < R.length; j++) {
        if (consumed.has(j)) continue;
        if (R[j][1].trim() !== A[i][1].trim()) continue;
        let len = 1;
        while (
          i + len < A.length &&
          j + len < R.length &&
          !consumed.has(j + len) &&
          A[i + len][0] === A[i + len - 1][0] + 1 && // added run stays contiguous in the new file
          R[j + len][0] === R[j + len - 1][0] + 1 && // removed run stays contiguous in the old file
          R[j + len][1].trim() === A[i + len][1].trim()
        ) {
          len++;
        }
        if (len > bestLen) {
          bestLen = len;
          bestJ = j;
        }
      }
      if (bestJ !== -1 && bestLen >= minRun) {
        for (let k = 0; k < bestLen; k++) {
          consumed.add(bestJ + k);
          fileMap.set(A[i + k][0], { counterpartLine: R[bestJ + k][0], runLength: bestLen });
        }
        i += bestLen;
      } else {
        i += 1;
      }
    }
    if (fileMap.size > 0) relocated.set(file, fileMap);
  }
  return relocated;
}

/**
 * A line that cannot carry executable coverage no matter what lcov says about it: blank, a
 * pure `//` line, or a line living entirely inside `/* ... *\/` block-comment furniture
 * (`/**`, ` * ...`, ` *\/`). Under `--enable-source-maps` (W1-T210 round 2) the tsx-compiled
 * module PREAMBLE maps onto a new file's LEADING comment block as `DA:<line>,0` records --
 * lcov "instruments" lines that are not code, and the gate would false-block every new file
 * that opens with a doc comment. The diff already carries each added line's text, so the gate
 * recognises these directly rather than trusting DA presence as an executability signal.
 * @param {string} text
 */
export function isNonExecutableLine(text) {
  const t = text.trim();
  if (t === '') return true;
  if (t.startsWith('//')) return true;
  if (t.startsWith('/*') || t.startsWith('*')) return true; // /** ... * ... *\/ furniture
  if (/^[}\)\];,]+$/.test(t)) return true; // closer-only punctuation (`};`, `})`, ...) carries no logic
  // A type-only import (`import type { X } from "...";`) is erased COMPLETELY at transpile --
  // it is unambiguous (unlike a value import, which runs for its side effects) and carries no
  // runtime code under any circumstance, so it is safe to recognise per-line with no surrounding
  // context (see computeTypeOnlyRanges below for the analogous interface/type-literal BODY case,
  // which needs brace-matching context to distinguish from a real object literal).
  if (/^import\s+type\b/.test(t)) return true;
  return false;
}

/**
 * The line ranges of a TypeScript `interface`/object-`type` declaration -- W1-T171's
 * dispatch-overlap.ts (a brand-new file whose whole surface is `export interface`/`import type`)
 * false-blocked here first: an interface body compiles to ZERO runtime JS, so under
 * `--enable-source-maps` every one of its member lines still gets a `DA:<line>,0` record (lcov
 * "instruments" a line that literally cannot execute, the same source-map artifact
 * `isNonExecutableLine`'s comment/blank carve-out above already documents for a file's leading
 * doc comment) -- no amount of additional test writing can ever turn that 0 into a positive hit,
 * so treating it as a real coverage gap would block the PR forever. Unlike the comment/blank
 * cases, a bare line like `task: string;` is NOT safely recognisable in isolation (an object
 * literal property or a class field initializer can look identical) -- it is only safe once we
 * know, from the surrounding brace structure, that it sits inside an `interface X { ... }` or
 * `type X = { ... }` declaration, never inside a runtime value. This mirrors
 * `computeBoundaryRanges`'s brace-matching shape exactly (same repo-wide uniform-indent brace
 * style), just with no directive required: an interface/type-literal body can NEVER carry
 * business logic, so -- unlike `// diff-cov: process-boundary` -- there is no misuse risk in
 * exempting it unconditionally.
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
 * Recognise the `// diff-cov: process-boundary — <reason>` directive and return the source
 * regions it exempts (W1-T221, fb-1784807764940-ce2404 + W1-T79/PR#662). Glue that lives at a
 * process boundary cannot carry a `DA:<line>,N>0` hit without actually forking a subprocess, so
 * the diff gate would block it forever. Two boundary shapes qualify:
 *   - RE-EXEC/EXIT: `spawnSync(process.execPath, ...)` then `process.exit(...)` -- you cannot
 *     unit-test a `process.exit` or a re-exec without forking (W1-T221 / PR #662).
 *   - WORKER SPAWN: a thin wrapper `return spawnWorker(buildXArgs(opts))` -- the codebase's
 *     canonical "the arg-builder carries the testable read-only contract; the spawn wrapper is
 *     untested by design because it shells out via the Agent SDK" pattern (spawnSpecialistWorker,
 *     spawnReconSpecialist; W1-T83 / PR #698). The tested contract is the arg-builder; the
 *     one-line spawn delegation around it is the irreducible boundary.
 * This lets an author mark ONE such function, and only such a function: the directive is honoured
 * only when it immediately precedes a declaration whose body (a) contains a process-boundary
 * call and (b) is small (<= MAX_BOUNDARY_EXEC_LINES executable lines). Anything else is an
 * INVALID directive that fails the gate CLOSED (a directive can never hide business logic --
 * misuse blocks the PR harder, not softer), and every honoured exemption is logged by main()
 * so no line is ever silently waved through. Note the boundary call must be DIRECT: a function
 * that calls `spawnReconSpecialist` (itself a wrapper) rather than `spawnWorker` is NOT exempt --
 * it must earn coverage, because such a caller typically carries real orchestration logic.
 *
 * The exempt region runs from the declaration line to the first `}` at the declaration's own
 * indent -- reliable given the repo's uniform brace style. Reads the checked-out file because
 * the diff carries only added lines, not the surrounding declaration/close.
 * @param {string} fileText
 * @returns {{ranges: Array<{start:number,end:number,reason:string,directiveLine:number}>, errors: Array<{directiveLine:number,message:string}>}}
 */
export const MAX_BOUNDARY_EXEC_LINES = 15;
const BOUNDARY_CALL =
  /\b(?:spawnSync|execFileSync)\(\s*process\.execPath\b|\bprocess\.exit(?:Code\s*=|\s*\()|\bspawnWorker\s*\(/;
export function computeBoundaryRanges(fileText) {
  const lines = fileText.split('\n');
  const ranges = [];
  const errors = [];
  const DIRECTIVE_TAG = /^\s*\/\/\s*diff-cov:\s*process-boundary\b(.*)$/;
  const CLOSER = /^(\s*)\}/;
  for (let i = 0; i < lines.length; i++) {
    const tag = DIRECTIVE_TAG.exec(lines[i]);
    if (!tag) continue;
    const directiveLine = i + 1; // 1-indexed, matches lcov/diff line numbers
    const reasonMatch = /^\s*[—–-]+\s*(\S.*)$/.exec(tag[1]);
    if (!reasonMatch) {
      errors.push({ directiveLine, message: 'process-boundary directive requires "— <reason>"' });
      continue;
    }
    const reason = reasonMatch[1].trim();
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++; // the declaration it guards
    if (j >= lines.length) {
      errors.push({ directiveLine, message: 'no declaration follows the process-boundary directive' });
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
    if (!BOUNDARY_CALL.test(bodyText)) {
      errors.push({
        directiveLine,
        message:
          'guarded declaration contains no process-boundary call (spawnSync/execFileSync(process.execPath …) or process.exit) — the directive may only exempt re-exec/exit glue',
      });
      continue;
    }
    const execCount = lines
      .slice(j, end + 1)
      .filter((t) => !isNonExecutableLine(t)).length;
    if (execCount > MAX_BOUNDARY_EXEC_LINES) {
      errors.push({
        directiveLine,
        message: `guarded declaration has ${execCount} executable lines (> ${MAX_BOUNDARY_EXEC_LINES}) — too large to exempt; extract the non-boundary logic and test it`,
      });
      continue;
    }
    ranges.push({ start, end: endLine, reason, directiveLine, kind: 'process-boundary' });
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
    // A declaration line is covered when ANY function declared there was entered (W1-T481).
    // PERMISSIVE IS RIGHT HERE AND COSTS NO STRICTNESS: an unentered function that merely shares
    // its declaration line still has its own DA records for its BODY, which are judged
    // independently, so this rescues one line and lets no uncovered code through. The strict
    // reading would block a genuinely-covered exported function because an anonymous callback
    // happens to share its line — the false positive this exists to fix.
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

// ── SELF-DESCRIBING FAILURES (the check-run annotation channel) ──────────────
//
// WHY THIS EXISTS. A red run's uncovered-line list lived ONLY in the job log, and the log blob is
// unreachable from a diagnosing agent: `GET /actions/jobs/<id>/logs` 302s to
// `productionresultssa11.blob.core.windows.net`, which a proxied environment refuses (measured: the
// CONNECT tunnel returns 403), and the blob is ~12MB against execFileSync's 1MB default buffer.
// Meanwhile the check-run itself carried ONE annotation reading, in full, `Process completed with
// exit code 1.` -- so #2828 sat 13 hours and #2895 could not be diagnosed at all.
//
// THE CHANNEL IS THE ANNOTATION, NOT `output.summary`. A job cannot write `output.summary` (that
// field belongs to whoever created the check run -- Actions itself -- and is empty on every run
// here, measured). What a job CAN write with no extra token or permission is a workflow command,
// which GitHub turns into a check-run annotation readable at
// `GET /repos/<o>/<r>/check-runs/<id>/annotations` -- an endpoint that returns 200 through the same
// proxy that 403s the blob. `%0A` encoding keeps the whole list inside ONE annotation message.
// $GITHUB_STEP_SUMMARY is written too (same shape scripts/test-with-retry.mjs already uses) so the
// list is also on the run page for a human; that channel has no REST endpoint, so it is a
// convenience, never the fix.
//
// OPT-IN, AND DELIBERATELY NOT `GITHUB_ACTIONS`. This job runs the whole suite to produce its lcov,
// and test/{coverage-ratchet,diff-coverage}.test.ts spawn THIS script over BLOCKING fixtures with
// no `env` override -- so a `GITHUB_ACTIONS`-gated emit would publish fixture failures as real
// annotations and make this instrument untrustworthy exactly where it is meant to be trusted.
// `RMD_CI_REPORT` is set per-STEP on the two gate steps in ci.yml (never job-wide, which would
// reach the test step too), so only a real gate invocation reports.

/** Render a blocked/clean report as one plain-text block. Pure: no env, no I/O. */
export function formatCiReport(tool, headline, details, { cap = 100 } = {}) {
  const shown = details.slice(0, cap);
  const lines = [`${tool}: ${headline}`, ...shown.map((d) => `  - ${d}`)];
  // NO SILENT CAPS (the same rule the exempt-line printing below follows): if the list is trimmed,
  // the report says so and names the cap, so a truncated read is never mistaken for a short list.
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
  const added = addedLinesByFile(diffText);
  const removed = removedLinesByFile(diffText);
  const rawViolations = findUncoveredAddedLines(added, lcovHits);
  // W1-T2325: an added line whose identical text was REMOVED elsewhere in the SAME diff is
  // pre-existing text that merely moved, not a new regression -- see computeRelocatedLines for the
  // consume-once / contiguous-run bounds that keep this from becoming a bypass. Derived entirely
  // from the diff's own `+`/`-` lines, no second coverage run.
  const relocatedByFile = computeRelocatedLines(added, removed);

  // Resolve `// diff-cov: process-boundary` directives PLUS automatic type-only-declaration
  // ranges (interface/type-literal bodies -- see computeTypeOnlyRanges), but ONLY for files that
  // actually have an uncovered added line -- an unused directive on an otherwise-clean file
  // exempts nothing and is left unvalidated. A malformed/abused directive on a file WITH
  // violations fails the gate CLOSED; type-only ranges need no directive (no misuse risk -- an
  // interface/type-literal body can never carry business logic).
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
    // Relocation is resolved per EXACT line (a 1:1 consume-once pairing with one counterpart old
    // line), never a range -- see computeRelocatedLines. Checked after, never instead of, the
    // existing carve-outs above: none of them change behaviour.
    const reloc = relocatedByFile.get(file)?.get(ln);
    if (reloc) {
      exempt.push({
        v,
        reason: `relocated from ${file}:${reloc.counterpartLine} (${reloc.runLength}-line contiguous match against the diff's removed lines)`,
        kind: 'relocated',
      });
      continue;
    }
    blocking.push(v);
  }

  // No silent caps: every exempted line is printed with its declared reason, so each use of the
  // directive (or the automatic type-only carve-out) is auditable in the CI log as well as
  // diff-visible to the review gate and the human.
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
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
