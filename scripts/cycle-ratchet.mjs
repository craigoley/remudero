#!/usr/bin/env node
// scripts/cycle-ratchet.mjs
//
// CANONICAL CYCLE-COUNT RATCHET.
//
// #2798 cut the `open-prs-rest` <-> `sweep` type-only edge and took the cycle count from 24 to
// 13. That figure was measured with a dependency-cruiser config held OUTSIDE the repo, and
// nothing in CI held the result -- so the remaining 13 could grow back one edge at a time with
// no check saying so. This script is what holds it, in the lineage of
// `scripts/task-id-existence-check.mjs` and `test/no-raw-nul.test.ts` (W1-T438): a small written
// baseline, a falsifier test proving the gate is ACTIVE, and a loud failure naming the delta.
//
// WHAT IT DOES NOT DO: it does not raise `no-circular` to `error`. That rule stays `warn`
// (.dependency-cruiser.cjs's own severity note explains why) because `error` fails EVERY PR that
// touches any module in an existing ring -- thirteen rings knot much of `src/lib`, and this repo
// ships against those files daily. A bound that fires on a healthy condition is the shape this
// repo has refused repeatedly. THE RATCHET HOLDS NET GROWTH, WHICH IS A DIFFERENT PREDICATE: a
// PR may touch a ring freely, and fails only if the COUNT goes up.
//
// THE COUNT IS DISTINCT RINGS, NOT REPORTED VIOLATIONS. dependency-cruiser reports one violation
// per cycle it finds, and at the captured sha those two figures were equal (13 and 13). They are
// not guaranteed to stay equal -- the same ring reached from two entry points would report twice
// -- so each ring is canonicalised by rotating it to its lexicographically smallest member before
// counting. That makes the ceiling a property of the GRAPH rather than of the traversal.
//
// Usage:
//   node scripts/cycle-ratchet.mjs                    # cruise `src` and check the ceiling
//   node scripts/cycle-ratchet.mjs --json <path>      # check an existing cruise result instead
//   node scripts/cycle-ratchet.mjs --baseline <path>  # non-default baseline (tests use this)
//   node scripts/cycle-ratchet.mjs --print            # print the count and the rings, exit 0

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CYCLE_RULE_NAME = 'no-circular';

/**
 * Rotate a ring to start at its lexicographically smallest member, so the SAME ring discovered
 * from two different entry points canonicalises to one key. The trailing repeat of the entry
 * module (dependency-cruiser closes the loop) is dropped first.
 */
export function canonicalRing(modules) {
  const ring = modules.length > 1 && modules[modules.length - 1] === modules[0] ? modules.slice(0, -1) : modules.slice();
  if (ring.length === 0) return '';
  let at = 0;
  for (let i = 1; i < ring.length; i += 1) if (ring[i] < ring[at]) at = i;
  return [...ring.slice(at), ...ring.slice(0, at)].join(' -> ');
}

/** Every DISTINCT canonical ring a cruise result reports under {@link CYCLE_RULE_NAME}, sorted. */
export function distinctCycles(cruiseResult) {
  const violations = cruiseResult?.summary?.violations ?? [];
  const rings = new Set();
  for (const v of violations) {
    if (v?.rule?.name !== CYCLE_RULE_NAME) continue;
    const modules = [v.from, ...(v.cycle ?? []).map((c) => (typeof c === 'string' ? c : c.name))];
    rings.add(canonicalRing(modules));
  }
  return [...rings].sort();
}

/**
 * Pure verdict. `ok` is `count <= maxCycles` -- AT OR BELOW, never equality, so cutting a cycle
 * without ratcheting the file down is never a failure (the ratchet-down is a deliberate, reviewed
 * edit, exactly as scripts/coverage-baseline.json's own note requires for its floor).
 */
export function evaluateCycleRatchet(count, maxCycles) {
  return { ok: count <= maxCycles, count, maxCycles, delta: count - maxCycles };
}

/** Read + validate the baseline. A missing or non-numeric `maxCycles` is a hard error, never a
 *  silently-disarmed ceiling -- W1-T1277 records four ratchets that disarmed on a malformed
 *  threshold, and this one refuses to be the fifth. */
export function readBaseline(text, path) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`cycle-ratchet: ${path} is not valid JSON: ${String(e)}`);
  }
  if (typeof parsed.maxCycles !== 'number' || !Number.isInteger(parsed.maxCycles) || parsed.maxCycles < 0) {
    throw new Error(`cycle-ratchet: ${path} must carry an integer 'maxCycles' >= 0, got ${JSON.stringify(parsed.maxCycles)}`);
  }
  return parsed;
}

function cruise(root) {
  const bin = join(root, 'node_modules', '.bin', 'depcruise');
  const out = execFileSync(bin, ['src', '--config', join(root, '.dependency-cruiser.cjs'), '--output-type', 'json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function main(argv) {
  const root = process.cwd();
  const jsonAt = argv.indexOf('--json');
  const baseAt = argv.indexOf('--baseline');
  const baselinePath = baseAt >= 0 ? argv[baseAt + 1] : join(root, 'scripts', 'cycle-baseline.json');
  const result = jsonAt >= 0 ? JSON.parse(readFileSync(argv[jsonAt + 1], 'utf8')) : cruise(root);
  const rings = distinctCycles(result);

  if (argv.includes('--print')) {
    console.log(`cycle-ratchet: ${rings.length} distinct cycle(s)`);
    for (const r of rings) console.log(`  ${r}`);
    return 0;
  }

  const baseline = readBaseline(readFileSync(baselinePath, 'utf8'), baselinePath);
  const verdict = evaluateCycleRatchet(rings.length, baseline.maxCycles);
  if (verdict.ok) {
    console.log(
      `cycle-ratchet: OK -- ${verdict.count} distinct cycle(s), ceiling ${verdict.maxCycles}` +
        (verdict.delta < 0 ? ` (${-verdict.delta} below; ratchet ${baselinePath} DOWN to ${verdict.count} to hold the gain)` : ''),
    );
    return 0;
  }
  console.error(
    `cycle-ratchet: BLOCKED -- ${verdict.count} distinct dependency cycle(s), ceiling ${verdict.maxCycles} ` +
      `(+${verdict.delta}). This diff adds a cycle. Cut it, or -- if the new ring is deliberate and ` +
      `reviewed -- raise 'maxCycles' in ${baselinePath} with the reason. The rings now present:`,
  );
  for (const r of rings) console.error(`  ${r}`);
  return 1;
}

// W1-T438's own idiom: importing this module must not run it (process.argv[1] is undefined when eval'd).
if (process.argv[1] && process.argv[1].endsWith('cycle-ratchet.mjs')) process.exit(main(process.argv.slice(2)));
