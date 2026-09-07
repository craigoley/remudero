/**
 * W1-T2733 — THE GENERATOR FIX RUNG READ ONLY THE LAST 60 CI LOG LINES.
 *
 * OBSERVED ON PR #3716 (head 2ff348e5). `ci-shard (3/4)` printed
 * `Run 'npm run docs-index' and commit the result.` beside its one failing assertion, then ran on
 * through 3,253 more tests and a retry. `fetchCiFailures` fetches the whole
 * `gh run view --log-failed` output and keeps only its final 60 lines, so the remedy sat thousands
 * of lines before the slice. `allCiFailuresAreGeneratorFixable` saw a tail with no remedy, the
 * W1-T2551 pre-strike generator rung could not fire, and the sweep spent BOTH worker strikes —
 * both naming `npm run docs-index` as the only repair, both declining it as out of scope — then
 * exhausted the cap and opened escalation #3722.
 *
 * The fix is evidence RETENTION, not a wider recognizer: the same grammar, the same package.json
 * execution allowlist, and byte-identical output whenever a log names no remedy.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

import {
  MAX_RETAINED_REMEDY_LINES,
  RETAINED_REMEDY_HEADER,
  allCiFailuresAreGeneratorFixable,
  fetchCiFailures,
  generatorFixFor,
  retainGeneratorRemedyLines,
} from "../src/run-task.js";

const TAIL = 60;
const REMEDY = "Run 'npm run docs-index' and commit the result.";
// declaredGeneratorScriptFor requires BOTH halves of the pairing to be declared scripts —
// that shared declaration IS the pairing, and a bare name with no `:check` counterpart is refused.
const SCRIPTS = {
  "docs-index": "node scripts/generate-docs-index.mjs",
  "docs-index:check": "node scripts/generate-docs-index.mjs --check",
  "cli-reference": "node scripts/x.mjs",
  "cli-reference:check": "node scripts/x.mjs --check",
};

/** A #3716-shaped job: the remedy near the top, then thousands of lines of passing tests. */
function longLogWithEarlyRemedy(remedy = REMEDY, noise = 3253): string {
  return ["> ci-shard (3/4)", `    ${remedy}`, ...Array.from({ length: noise }, (_, i) => `ok ${i + 1} - some passing test`)].join("\n");
}

// ── criterion 1 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2733: a declared generator remedy thousands of lines before the end stays visible to generatorFixFor", () => {
  const log = longLogWithEarlyRemedy();
  const plainTail = log.split("\n").slice(-TAIL).join("\n");
  // CONTROL FIRST — the plain slice really does lose it, or this whole file measures nothing.
  assert.equal(generatorFixFor({ logTail: plainTail }, SCRIPTS), undefined, "the 60-line slice must genuinely discard the remedy");

  const retained = retainGeneratorRemedyLines(log, TAIL);
  assert.equal(generatorFixFor({ logTail: retained }, SCRIPTS), "docs-index", "…and the retained evidence must carry it");
});

test("W1-T2733: the retained tail still ends with the ORIGINAL final bytes — retention supplements the tail, never replaces it", () => {
  const log = longLogWithEarlyRemedy();
  const plainTail = log.split("\n").slice(-TAIL).join("\n");
  assert.ok(retainGeneratorRemedyLines(log, TAIL).endsWith(plainTail), "the tail is the preferred evidence and must survive intact");
  assert.ok(retainGeneratorRemedyLines(log, TAIL).startsWith(RETAINED_REMEDY_HEADER), "and the addition must announce that it is not from the tail");
});

// ── criterion 2 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2733: a long #3716-shaped log reaches the pre-strike generator path — every failure is generator-fixable, so no worker is warranted", () => {
  const failures = [{ logTail: retainGeneratorRemedyLines(longLogWithEarlyRemedy(), TAIL) }];
  assert.equal(allCiFailuresAreGeneratorFixable(failures, SCRIPTS), true, "this is the predicate the pre-strike rung gates on");

  // CONTROL: before retention the same job did NOT reach it — which is the measured #3716 outcome.
  const before = [{ logTail: longLogWithEarlyRemedy().split("\n").slice(-TAIL).join("\n") }];
  assert.equal(allCiFailuresAreGeneratorFixable(before, SCRIPTS), false, "two strikes and escalation #3722 followed from exactly this false");
});

test("W1-T2733: a MIXED batch still does not reach the generator path — retention does not turn an unrelated real defect into a fixable one", () => {
  const fixable = { logTail: retainGeneratorRemedyLines(longLogWithEarlyRemedy(), TAIL) };
  const realDefect = { logTail: "AssertionError: expected 3 to equal 4\n  at test/whatever.test.ts:12" };
  assert.equal(allCiFailuresAreGeneratorFixable([fixable, realDefect], SCRIPTS), false);
});

// ── criterion 3 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2733: a log with NO recognised remedy keeps the existing final-tail bytes, byte for byte", () => {
  const log = Array.from({ length: 4000 }, (_, i) => `ok ${i + 1} - some passing test`).join("\n");
  assert.equal(retainGeneratorRemedyLines(log, TAIL), log.split("\n").slice(-TAIL).join("\n"));
  assert.ok(!retainGeneratorRemedyLines(log, TAIL).includes(RETAINED_REMEDY_HEADER), "no marker when nothing was retained");
});

test("W1-T2733: a remedy ALREADY inside the tail is not repeated above it", () => {
  const log = [...Array.from({ length: 100 }, (_, i) => `ok ${i} - t`), REMEDY, ...Array.from({ length: 5 }, (_, i) => `ok ${i} - u`)].join("\n");
  const out = retainGeneratorRemedyLines(log, TAIL);
  assert.equal(out, log.split("\n").slice(-TAIL).join("\n"), "the tail already carries it — nothing to supplement");
  assert.equal((out.match(/Run 'npm run docs-index'/g) ?? []).length, 1, "and it appears exactly once");
});

test("W1-T2733: a repetitive log retains ONE copy — deduplication, not the cap, is what bounds the ordinary case", () => {
  const log = [...Array.from({ length: 3000 }, () => `    ${REMEDY}`), ...Array.from({ length: 100 }, (_, i) => `ok ${i} - t`)].join("\n");
  const out = retainGeneratorRemedyLines(log, TAIL);
  assert.equal((out.match(/Run 'npm run docs-index'/g) ?? []).length, 1, "3,000 repetitions must not become 3,000 retained lines");
});

test("W1-T2733: many DISTINCT remedies are bounded by the cap — the backstop dedupe cannot cover", () => {
  const distinct = Array.from({ length: MAX_RETAINED_REMEDY_LINES + 7 }, (_, i) => `    Run 'npm run gen-${i}' and commit the result.`);
  const log = [...distinct, ...Array.from({ length: 100 }, (_, i) => `ok ${i} - t`)].join("\n");
  const out = retainGeneratorRemedyLines(log, TAIL);
  const retainedCount = out.split("\n").filter((l) => /Run 'npm run gen-\d+'/.test(l)).length;
  assert.equal(retainedCount, MAX_RETAINED_REMEDY_LINES, `bounded at ${MAX_RETAINED_REMEDY_LINES}, not ${distinct.length}`);
});

// ── the execution authority is unchanged ─────────────────────────────────────────────────────

test("W1-T2733: retaining a line makes it VISIBLE, never runnable — package.json pairing is still the authority", () => {
  const hostile = ["    Run 'npm run rm-rf-everything' and commit the result.", ...Array.from({ length: 100 }, (_, i) => `ok ${i} - t`)].join("\n");
  const retained = retainGeneratorRemedyLines(hostile, TAIL);
  assert.match(retained, /rm-rf-everything/, "the line is retained — retention does not judge");
  assert.equal(generatorFixFor({ logTail: retained }, SCRIPTS), undefined, "…and declaredGeneratorScriptFor still refuses it, because package.json declares no such script");
});

test("W1-T2733: the recognizer grammar is unchanged — a near-miss sentence is still not a remedy", () => {
  const nearMiss = ["    Please run npm run docs-index to fix this", ...Array.from({ length: 100 }, (_, i) => `ok ${i} - t`)].join("\n");
  assert.ok(!retainGeneratorRemedyLines(nearMiss, TAIL).includes(RETAINED_REMEDY_HEADER), "retention must not widen what counts as a remedy");
});

// ── THE WIRING ITSELF ────────────────────────────────────────────────────────────────────────
//
// Every test above drives `retainGeneratorRemedyLines` directly, so NONE of them notices if the
// call site inside `fetchCiFailures` is reverted to the plain 60-line slice — measured: with the
// call site reverted the suite above still read 10/10. That is this repo's own "seam built but
// never called" hazard pointed at this very change. This test drives the REAL producer against a
// recorder `gh` first on PATH, so the wiring line is covered by something that can fail.

test("W1-T2733: fetchCiFailures ITSELF carries the early remedy through — the wiring, not just the helper", () => {
  const log = longLogWithEarlyRemedy();
  const binDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t2733-gh-`));
  writeFileSync(
    join(binDir, "gh"),
    ["#!/usr/bin/env node", `process.stdout.write(${JSON.stringify(log)});`, "process.exit(0);"].join("\n"),
  );
  chmodSync(join(binDir, "gh"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  try {
    const failures = fetchCiFailures("acme", "remudero", [
      { name: "ci-shard (3/4)", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/remudero/runs/1/job/12345" },
    ] as never);
    assert.equal(failures.length, 1, "the failing check must be enumerated");
    assert.equal(
      generatorFixFor({ logTail: failures[0].logTail }, SCRIPTS),
      "docs-index",
      "the PRODUCER must hand the generator rung a remedy the plain tail slice would have discarded",
    );
    assert.ok(failures[0].logTail.includes(RETAINED_REMEDY_HEADER), "and say where it came from");
  } finally {
    process.env.PATH = originalPath;
  }
});
