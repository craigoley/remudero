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
  let current = null;
  for (const line of lcovText.split('\n')) {
    if (line.startsWith('SF:')) {
      current = new Map();
      files.set(line.slice(3).trim(), current);
    } else if (line.startsWith('DA:') && current) {
      const [lineNoStr, hitsStr] = line.slice(3).split(',');
      current.set(Number(lineNoStr), Number(hitsStr));
    } else if (line.startsWith('end_of_record')) {
      current = null;
    }
  }
  return files;
}

/**
 * Walk a unified diff (`git diff <base>...HEAD` output) and return `Map<filePath, Set<lineNo>>`
 * of NEW-FILE line numbers the diff ADDS (`+` lines only -- never context or removed lines).
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
      if (!files.has(currentFile)) files.set(currentFile, new Set());
      files.get(currentFile).add(newLineNo);
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
 * Compare added lines against lcov hit data.
 * @param {Map<string, Set<number>>} added
 * @param {Map<string, Map<number, number>>} lcovHits
 * @returns {string[]} `file:line` violations, sorted; empty means the gate is satisfied.
 */
export function findUncoveredAddedLines(added, lcovHits) {
  const violations = [];
  for (const [file, lines] of added) {
    const hitsByLine = lcovHits.get(file);
    if (!hitsByLine) continue; // lcov never saw this file (e.g. test/**) -- no claim to make.
    const uncovered = [...lines]
      .filter((ln) => hitsByLine.has(ln) && hitsByLine.get(ln) === 0)
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
  const violations = findUncoveredAddedLines(added, lcovHits);

  if (violations.length > 0) {
    console.error(
      'diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests, even ' +
        'though the aggregate coverage-ratchet floor may still be satisfied:',
    );
    for (const v of violations) console.error(`  - ${v}`);
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
