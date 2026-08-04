// W1-T320: the tmp backstop cannot fire before ENOSPC — sweepStaleTempDirs' 24h age ceiling
// was sized for one-function-call dirs and its boot-only cadence never re-swept a healthy
// daemon, so it logged 'removed: 0, kept: 49979' on ten straight boots while the disk filled
// (fb-1785807201821-e4c9dc: 53,310 rmd-* dirs minting at ~200/minute — the whole population is
// younger than 24h when the disk fills, so the old ceiling mathematically cannot fire first).
//
// Four acceptance claims, each proven against the REAL shipped plan/policy.yaml and the REAL
// daemon per-poll composite — never a hand-built fixture (design clause iv, "the W1-T316
// lesson"):
//   1. the age ceiling is a policy row the shipped plan/policy.yaml actually feeds the predicate
//   2. a population minting faster than the OLD 24h ceiling is reaped by the NEW one
//   3. the sweep rides the daemon's poll cadence (buildSweepHook), not only daemonBoot
//   4. daemon.tmp_sweep carries the oldest-kept age, distinguishing health from a quiet leak

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { loadPolicy, policyPath } from "../src/lib/policy.js";
import { DEFAULT_TEMP_SWEEP_MAX_AGE_MS, RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildSweepHook, runTmpSweepRung } from "../src/run-task.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
// The REAL loaded policy value — never a fixture number — so every test below proves behavior
// against what a real daemon would actually read from the committed plan/policy.yaml.
const SHIPPED_TMP_MAX_AGE_MS = loadPolicy(policyPath(REPO_ROOT)).values.sweep.tmpMaxAgeMs;

function seedDir(root: string, name: string, ageMs: number): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const past = new Date(Date.now() - ageMs);
  utimesSync(dir, past, past);
  return dir;
}

function collectingLog(): { log: (step: string, extra?: Record<string, unknown>) => void; lines: Array<{ step: string; extra: Record<string, unknown> }> } {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  return { log: (step, extra = {}) => lines.push({ step, extra }), lines };
}

// ── acceptance 1: the ceiling is a policy row the sweep actually reads ─────────────────────

test("the shipped plan/policy.yaml carries sweep.tmpMaxAgeMs well below the pre-W1-T320 24h default, and feeding that REAL loaded value into the predicate (never a fixture number) reaps by it", () => {
  assert.ok(
    SHIPPED_TMP_MAX_AGE_MS < DEFAULT_TEMP_SWEEP_MAX_AGE_MS,
    "the shipped ceiling must be strictly tighter than the old 24h default — otherwise nothing changed",
  );
  const root = mkdtempSync(join(tmpdir(), "rmd-backstop-root-"));
  try {
    const stale = seedDir(root, `${RMD_TMP_PREFIX}claim1-stale`, SHIPPED_TMP_MAX_AGE_MS + 60_000);
    const fresh = seedDir(root, `${RMD_TMP_PREFIX}claim1-fresh`, Math.max(0, SHIPPED_TMP_MAX_AGE_MS - 60_000));
    const { log } = collectingLog();

    // SHIPPED_TMP_MAX_AGE_MS was loaded straight off the committed plan/policy.yaml above — the
    // exact value the real daemonCommand threads via its own `policy` read (never re-read inside
    // runTmpSweepRung itself: see that function's doc on staying off test/config-reader-seams.test.ts's
    // unredirectable-reader list by taking the value in rather than reading it a second time).
    const summary = runTmpSweepRung(log, { root, maxAgeMs: SHIPPED_TMP_MAX_AGE_MS });

    assert.deepEqual(summary.removed, [`${RMD_TMP_PREFIX}claim1-stale`]);
    assert.ok(summary.kept.includes(`${RMD_TMP_PREFIX}claim1-fresh`));
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(fresh), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 2: a population minting faster than the OLD 24h ceiling is reaped now ───────

test("a population minting faster than the OLD 24h ceiling — every dir older than the shipped ceiling but younger than 24h is reaped, younger-than-the-ceiling dirs are kept", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-backstop-root-"));
  try {
    const overShippedCeilingAgeMs = SHIPPED_TMP_MAX_AGE_MS + 5 * 60_000;
    assert.ok(
      overShippedCeilingAgeMs < DEFAULT_TEMP_SWEEP_MAX_AGE_MS,
      "the seeded age must still be YOUNGER than the old 24h ceiling — this is exactly the " +
        "population the old boot-only 24h sweep could never catch before the disk filled",
    );
    const minted = Array.from({ length: 5 }, (_, i) =>
      seedDir(root, `${RMD_TMP_PREFIX}mint-${i}`, overShippedCeilingAgeMs),
    );
    seedDir(root, `${RMD_TMP_PREFIX}mint-young`, 1_000);
    const { log } = collectingLog();

    const summary = runTmpSweepRung(log, { root, maxAgeMs: SHIPPED_TMP_MAX_AGE_MS });

    assert.equal(summary.removed.length, 5, "every dir older than the new ceiling (but younger than the old one) is reaped");
    for (const dir of minted) assert.equal(existsSync(dir), false);
    assert.ok(summary.kept.includes(`${RMD_TMP_PREFIX}mint-young`), "a genuinely fresh dir survives the sweep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 3: the sweep rides the daemon's poll cadence, not only boot ─────────────────

test("buildSweepHook's per-poll composite (the daemon's REAL deps.sweep() wiring) reaches the tmp-sweep rung every tick — not only daemonBoot", async () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-backstop-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const root = mkdtempSync(join(tmpdir(), "rmd-backstop-hook-"));
  try {
    const ledgerPath = join(root, "ledger.ndjson");
    const { log, lines } = collectingLog();
    const hook = buildSweepHook(
      "o",
      "r",
      { root, claudeBin: "/bin/true" } as Config,
      ledgerPath,
      "SWEEP-1",
      { tasks: [], byId: new Map() } as Plan,
      log,
      // The exact value the real daemonCommand threads: policy.values.sweep.tmpMaxAgeMs off
      // the SHIPPED plan/policy.yaml — never an invented fixture number.
      SHIPPED_TMP_MAX_AGE_MS,
    );
    await hook();

    assert.ok(
      lines.some((l) => l.step === "daemon.tmp_sweep"),
      "the daemon's poll-cadence sweep composite must reach the tmp-sweep rung on every tick, " +
        "not only at boot — this IS the fix for the boot-only cadence gap",
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 4: daemon.tmp_sweep carries the oldest-kept age ─────────────────────────────

test("daemon.tmp_sweep carries the oldest-kept age (ms) when something is kept — distinguishing a quietly-aging population from a clean sweep", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-backstop-root-"));
  try {
    const keptAgeMs = 90_000;
    seedDir(root, `${RMD_TMP_PREFIX}claim4-kept`, keptAgeMs);
    const { log, lines } = collectingLog();

    runTmpSweepRung(log, { root, maxAgeMs: SHIPPED_TMP_MAX_AGE_MS });

    const line = lines.find((l) => l.step === "daemon.tmp_sweep");
    assert.ok(line, "daemon.tmp_sweep is logged");
    assert.equal(line!.extra.kept, 1);
    assert.ok(
      typeof line!.extra.oldest_kept_age_ms === "number" && (line!.extra.oldest_kept_age_ms as number) >= keptAgeMs,
      `oldest_kept_age_ms (${line!.extra.oldest_kept_age_ms}) must be carried and at least the seeded ${keptAgeMs}ms age`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon.tmp_sweep: nothing qualified (kept: 0) logs a null oldest-kept age, never a stale number left over from a prior tick", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-backstop-empty-"));
  try {
    const { log, lines } = collectingLog();

    runTmpSweepRung(log, { root, maxAgeMs: SHIPPED_TMP_MAX_AGE_MS });

    const line = lines.find((l) => l.step === "daemon.tmp_sweep");
    assert.ok(line);
    assert.equal(line!.extra.kept, 0);
    assert.equal(line!.extra.oldest_kept_age_ms, null, "'nothing qualified' must read as null, distinguishable from 'a quiet leak at age 0'");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the wrapper's CATCH arm — diff-coverage flagged run-task.ts's `catch (e)` as uncovered ──
//
// `runTmpSweepRung`'s own doc says `sweepStaleTempDirs` "itself never throws", which is why the
// catch is DEFENSIVE and why every other test in this file lands on the happy path — leaving both
// of its lines with zero covering tests. The seam that reaches it without inventing a new one:
// `TempSweepOpts.now` is injectable, and `sweepStaleTempDirs` calls `now()` OUTSIDE its two inner
// try blocks (after the stat guard), so a throwing clock propagates out of the callee and into
// this wrapper. That is exactly the "something unexpected escaped the callee" case the catch
// promises to absorb, driven through the REAL function rather than a stubbed one.

test("runTmpSweepRung ABSORBS a throw escaping sweepStaleTempDirs — it ledgers daemon.tmp_sweep with the error and returns an empty summary, so a sweep hiccup never escapes into the composite around it", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-backstop-throw-"));
  try {
    // A real, stat-able rmd-owned dir, so the loop reaches the `now()` call rather than
    // short-circuiting on the prefix or the stat guard.
    seedDir(root, `${RMD_TMP_PREFIX}throwcase`, 60_000);
    const { log, lines } = collectingLog();

    const summary = runTmpSweepRung(log, {
      root,
      maxAgeMs: 1,
      now: () => {
        throw new Error("clock exploded");
      },
    });

    // DEGRADED, NOT THROWN: the wrapper returned normally.
    assert.deepEqual(summary, { removed: [], kept: [], oldestKeptAgeMs: null });

    const swept = lines.filter((l) => l.step === "daemon.tmp_sweep");
    assert.equal(swept.length, 1, "exactly one daemon.tmp_sweep line, carrying the failure");
    assert.match(
      String(swept[0].extra.error),
      /clock exploded/,
      "the ledger line names the real cause rather than a generic failure",
    );
    // FALSIFIER: on the success path this line carries removed/kept counts and never an error —
    // asserting the error field is present is what distinguishes the catch arm from the try.
    assert.equal(swept[0].extra.removed, undefined, "the error line is the catch arm's, not the success arm's");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
