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
// Usage:
//   node scripts/diff-coverage.mjs --lcov <path> --diff <path>
//
// Defaults: --lcov coverage/lcov.info; --diff reads the unified diff from stdin if omitted.
//
// The pure functions below (parseLcovHitsByFile, addedLinesByFile, findUncoveredAddedLines) are
// exported so a falsifier fixture test can exercise the CLI process directly (spawn + exit code)
// as well as the parsing/comparison logic in isolation, the same split coverage-ratchet.mjs uses.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/**
 * Parse an lcov report into `Map<filePath, Map<lineNumber, hitCount>>` -- one inner map per
 * `SF:`/`end_of_record` block, populated from that block's `DA:<line>,<hits>` records.
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
      current = new Map();
      currentPath = line.slice(3).trim();
      files.set(currentPath, current);
    } else if (line.startsWith('FN:') && current) {
      // FN:<line>,<name> — a function DECLARED at <line>. Under --enable-source-maps the
      // tsx-compiled map scores declaration lines DA:0 even when the function body is fully
      // covered (observed: FN:62 with FNDA:11 beside DA:62,0) — FNDA is the truth for them.
      const [ln, name] = line.slice(3).split(',');
      if (!fnLines.has(currentPath)) fnLines.set(currentPath, new Map());
      fnLines.get(currentPath).set(Number(ln), name);
    } else if (line.startsWith('FNDA:') && current) {
      const [hits, name] = line.slice(5).split(',');
      if (!fnHits.has(currentPath)) fnHits.set(currentPath, new Map());
      fnHits.get(currentPath).set(name, Number(hits));
    } else if (line.startsWith('DA:') && current) {
      const [lineNoStr, hitsStr] = line.slice(3).split(',');
      current.set(Number(lineNoStr), Number(hitsStr));
    } else if (line.startsWith('end_of_record')) {
      current = null;
      currentPath = null;
    }
  }
  return { hits: files, fnLines, fnHits };
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
  return false;
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
    ranges.push({ start, end: endLine, reason, directiveLine });
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
    const declEntered = (ln) => {
      const name = fnsAt?.get(ln);
      return name !== undefined && (fnHit?.get(name) ?? 0) > 0;
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
  const rawViolations = findUncoveredAddedLines(added, lcovHits);

  // Resolve `// diff-cov: process-boundary` directives, but ONLY for files that actually have an
  // uncovered added line -- an unused directive on an otherwise-clean file exempts nothing and is
  // left unvalidated. A malformed/abused directive on a file WITH violations fails the gate CLOSED.
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
    if (ranges.length > 0) rangesByFile.set(file, ranges);
    for (const e of errors) directiveErrors.push({ file, ...e });
  }

  if (directiveErrors.length > 0) {
    console.error('diff-coverage: INVALID process-boundary directive(s) -- the gate fails closed:');
    for (const e of directiveErrors) console.error(`  - ${e.file}:${e.directiveLine} -- ${e.message}`);
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
    if (hit) exempt.push({ v, reason: hit.reason });
    else blocking.push(v);
  }

  // No silent caps: every exempted line is printed with its declared reason, so each use of the
  // directive is auditable in the CI log as well as diff-visible to the review gate and the human.
  for (const e of exempt) console.log(`diff-coverage: exempt (process-boundary) ${e.v} -- ${e.reason}`);

  if (blocking.length > 0) {
    console.error(
      'diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests, even ' +
        'though the aggregate coverage-ratchet floor may still be satisfied:',
    );
    for (const v of blocking) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }

  console.log('diff-coverage: OK -- every added source line lcov instruments is covered.');
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/diff-coverage.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
