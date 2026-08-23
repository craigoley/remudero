import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CEILING_OVERRIDE_WRITTEN_STEP,
  DECISION_RELEVANT_LEDGER_STEPS,
  RENDER_RELEVANT_LEDGER_STEPS,
  RENDER_STEP_RETENTION_WINDOW_MS,
  appendDailyCostCeilingOverrideAudit,
  ledgerExceedsRotationCeiling,
  rotateLedger,
} from "../src/lib/ledger.js";
import { deriveAccountUsage, USAGE_CACHE_MAX_AGE_MS, type AccountUsageInput } from "../src/lib/account-usage.js";
import { readLedgerLines } from "../src/lib/status.js";
import { SWEEP_STALL_MULTIPLIER, judgeSweepLiveness, readSweepPassSummaryTimestamps } from "../src/lib/doctor.js";

// ── W1-T275 (OBSERVED LIVE 2026-07-31, feedback recon): the ACCOUNT strip rendered "unknown" on
// a healthy fleet because the live ledger had just rotated and `daemon.headroom` was absent from
// DECISION_RELEVANT_LEDGER_STEPS — 1,243 headroom lines survived only in the archives, ZERO in
// the live file account-usage.ts actually reads. `console.kick_refused`/`console.kick_dispatched`
// (board.ts's RECENT operator-action feed) have the identical exposure. The fix is NOT widening
// DECISION_RELEVANT_LEDGER_STEPS (that set is the never-rotated core — a render-only step added
// there is retained forever, trading one failure for unbounded growth) but a SECOND,
// RECENCY-BOUNDED category, RENDER_RELEVANT_LEDGER_STEPS, given the exact treatment
// `daemon.boot`/`deploy.*` already get via HEALTH_STEP_RETENTION_WINDOW_MS. This file proves: the
// membership is derived from the actual consumers (not a second hardcoded list), a rotation keeps
// recent lines of each render-relevant step live, and an old one is still archived — bounded by
// recency, not retained forever. ───────────────────────────────────────────────────────────────

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-ledger-render-retention-"));
}

/** Builds one raw ledger line with an EXPLICIT `ts` — bypasses appendLedger's own clock so a test
 *  can place lines precisely in the past/present relative to `rotateLedger`'s `now`. Mirrors
 *  test/ledger-rotation-convergence.test.ts's own `rawLine` helper. */
function rawLine(step: string, taskId: string, tsMs: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: new Date(tsMs).toISOString(),
    run_id: `${step}-${taskId}-${tsMs}`,
    task_id: taskId,
    step,
    ...extra,
  });
}

/** Realistic high-frequency, no-decision-consequence padding — enough of these alone can cross a
 *  small test ceiling, exactly like test/ledger-rotation.test.ts's own `noiseLine`. */
function noiseLine(n: number, tsMs: number): string {
  return JSON.stringify({ ts: new Date(tsMs).toISOString(), step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) });
}

// ── "DERIVE THE MEMBERSHIP, DO NOT HARDCODE A SECOND LIST" (this task's own design note). This
// re-derives the expected render-relevant set from each real consumer's OWN boundary marker —
// account-usage.ts's `daemon.headroom` equality read (deriveGovernorPosture, its only `.step`
// read at all) and board.ts's `OPERATOR_ACTION_STEPS` Set literal (the RECENT feed's own name
// for exactly the operator-action steps it renders) — not from a copy of RENDER_RELEVANT_LEDGER_STEPS
// itself, so a future console reader that starts keying off a new step without updating that Set
// fails HERE. Deliberately narrower than a blanket switch(line.step) scan of board.ts: that switch
// also renders plain decision-relevant steps (verdict, escalation.issue_opened, ...) that already
// have their own permanent retention and cosmetic-only steps (fix.done, implement.done, ...) that
// are out of this task's one concern — OPERATOR_ACTION_STEPS is board.ts's own explicit boundary
// for "the steps this specific operator-action feed needs to survive rotation."
test("RENDER_RELEVANT_LEDGER_STEPS: derived from consumers, not hardcoded — every step account-usage.ts/board.ts render is present", () => {
  const accountUsageSrc = readFileSync(
    fileURLToPath(new URL("../src/lib/account-usage.ts", import.meta.url)),
    "utf8",
  );
  const boardSrc = readFileSync(fileURLToPath(new URL("../src/lib/board.ts", import.meta.url)), "utf8");

  const equalityRead = /\.step\s*(?:===|!==)\s*["']([^"']+)["']/g;
  const discovered = new Set<string>();
  for (const m of accountUsageSrc.matchAll(equalityRead)) discovered.add(m[1]);
  assert.ok(discovered.has("daemon.headroom"), "sanity: account-usage.ts's own daemon.headroom read was found");

  const operatorActionSetMatch = boardSrc.match(/OPERATOR_ACTION_STEPS\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(operatorActionSetMatch, "sanity: board.ts's OPERATOR_ACTION_STEPS boundary marker was found");
  const stringLiteral = /["']([^"']+)["']/g;
  for (const m of (operatorActionSetMatch as RegExpMatchArray)[1].matchAll(stringLiteral)) discovered.add(m[1]);

  assert.ok(discovered.size >= 3, "sanity: the scan found real reads, not an empty/broken pattern");

  const missing = [...discovered].filter((step) => !RENDER_RELEVANT_LEDGER_STEPS.has(step));
  assert.deepEqual(
    missing,
    [],
    `RENDER_RELEVANT_LEDGER_STEPS is missing step(s) a real console consumer reads to render ` +
      `operator-visible history (derived from source, not from the hardcoded list itself): ${missing.join(", ")}`,
  );
});

// ── W1-T1237 (THE SWEEP HEARTBEAT WOULD NOT SURVIVE BEING READ): the derived-from-consumers lock
// above only ever scanned account-usage.ts's `.step ===` equality reads and board.ts's
// `OPERATOR_ACTION_STEPS` Set literal — a doctor.ts-side consumer (src/lib/doctor.ts's
// `judgeSweepLiveness`, W1-T1236) was invisible to it, so `sweep.pass`/`sweep.summary` could have
// been registered here and then silently rotted with no test noticing a future edit dropping
// them. Widened to ALSO scan doctor.ts's own `SWEEP_LIVENESS_STEPS` boundary marker — the exact
// role `OPERATOR_ACTION_STEPS` already plays for board.ts — rather than a blanket
// `switch(line.step)` scan of doctor.ts: that file compares many unrelated steps
// (`daemon.alive`, `fix.dispatch`, `daemon.boot`, ...) that already have their own retention or
// are out of this task's one concern. ─────────────────────────────────────────────────────────
test("W1-T1237: the render set is derived from the sweep-liveness marker too", () => {
  const doctorSrc = readFileSync(fileURLToPath(new URL("../src/lib/doctor.ts", import.meta.url)), "utf8");

  const sweepLivenessSetMatch = doctorSrc.match(/SWEEP_LIVENESS_STEPS:\s*ReadonlySet<string>\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(sweepLivenessSetMatch, "sanity: doctor.ts's SWEEP_LIVENESS_STEPS boundary marker was found");

  const stringLiteral = /["']([^"']+)["']/g;
  const discovered = new Set<string>();
  for (const m of (sweepLivenessSetMatch as RegExpMatchArray)[1].matchAll(stringLiteral)) discovered.add(m[1]);

  assert.ok(discovered.size >= 2, "sanity: the scan found real steps, not an empty/broken pattern");
  assert.ok(discovered.has("sweep.pass"), "sanity: doctor.ts's own sweep.pass read was found");
  assert.ok(discovered.has("sweep.summary"), "sanity: doctor.ts's own sweep.summary read was found");

  const missing = [...discovered].filter((step) => !RENDER_RELEVANT_LEDGER_STEPS.has(step));
  assert.deepEqual(
    missing,
    [],
    `RENDER_RELEVANT_LEDGER_STEPS is missing step(s) the sweep-liveness arm reads (derived from ` +
      `doctor.ts's own SWEEP_LIVENESS_STEPS marker, not from a second hardcoded list): ${missing.join(", ")}`,
  );
});

// ── W1-T1237 design note (4): RECONCILE THE TWO NUMBERS, DO NOT CHOOSE THEM INDEPENDENTLY.
// judgeSweepLiveness (doctor.ts) derives its stale-cadence WARN bound as SWEEP_STALL_MULTIPLIER
// times the longest OBSERVED gap between sweep.pass rows — and a bound LONGER than the render
// window can only ever see zero rows (the row itself has already rotated out of the live ledger
// before its own staleness could ever be judged against that bound), which would make W1-T1236's
// arm permanently WARN/UNKNOWN and useless. This is the sibling of the assertion this file already
// carries for the ACCOUNT strip (RENDER_STEP_RETENTION_WINDOW_MS >= USAGE_CACHE_MAX_AGE_MS,
// above): the window must be able to absorb SWEEP_STALL_MULTIPLIER (imported from doctor.ts,
// never re-typed as a bare "3") applied to the fastest realistic cadence a healthy sweep pass ever
// runs on — daemon.ts's real `rmd daemon` entry's own production default poll interval is 60
// seconds (`DEFAULT_POLL_INTERVAL_MS`), restated here rather than imported: doctor.ts is already
// this task's one authorized new read, and pulling daemon.ts in for a single constant would be a
// new, unrelated coupling this task's design does not ask for. ─────────────────────────────────
test("W1-T1237: the render window is at least the sweep-liveness bound", () => {
  const fastestRealisticSweepPassGapMs = 60_000; // daemon.ts's DEFAULT_POLL_INTERVAL_MS, restated
  const sweepLivenessBoundMs = SWEEP_STALL_MULTIPLIER * fastestRealisticSweepPassGapMs;
  assert.ok(
    RENDER_STEP_RETENTION_WINDOW_MS >= sweepLivenessBoundMs,
    `a render retention window shorter than SWEEP_STALL_MULTIPLIER x the fastest realistic ` +
      `sweep.pass cadence (${sweepLivenessBoundMs}ms) guarantees the sweep-liveness arm's ` +
      `stale-cadence WARN can never fire before the row itself rotates away, reading 0 rows / ` +
      `UNKNOWN instead`,
  );
});

// ── The window itself must be at least the consumer's own staleness bound (this task's design
// note: "SIZE THE WINDOW FROM THE CONSUMER, and state the derivation"), or the ACCOUNT strip is
// guaranteed to read stale/unknown immediately after every rotation. ─────────────────────────
test("RENDER_STEP_RETENTION_WINDOW_MS is at least account-usage.ts's own USAGE_CACHE_MAX_AGE_MS staleness bound", () => {
  assert.ok(
    RENDER_STEP_RETENTION_WINDOW_MS >= USAGE_CACHE_MAX_AGE_MS,
    `a render retention window shorter than the ACCOUNT strip's own staleness bound (${USAGE_CACHE_MAX_AGE_MS}ms) ` +
      `guarantees the strip reads stale/unknown right after a rotation, before its own check would ever fire`,
  );
});

test("RENDER RETENTION — a fresh daemon.headroom line survives rotation and the ACCOUNT strip's governor posture reads real, not 'unknown'", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const freshHeadroomMs = nowMs - 60_000; // a minute ago — comfortably inside any real window

    const lines: string[] = [rawLine("daemon.headroom", "DAEMON", freshHeadroomMs, { enforced: true, window: "5h", percent_used: 42 })];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshHeadroomMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(liveContent.includes("daemon.headroom"), "the fresh daemon.headroom line survives rotation");

    // The REAL consumer, not a string check: account-usage.ts's own deriveAccountUsage reading
    // the post-rotation live ledger must report a real governor posture.
    const input: AccountUsageInput = { unreadable: true }; // isolate the governor half from the usage half
    const postRotationLines = readLedgerLines(ledgerPath);
    const snapshot = deriveAccountUsage(input, postRotationLines, nowMs);
    assert.equal(
      snapshot.governor,
      "armed",
      "the console must still resolve a real governor posture from the post-rotation live ledger, not 'unknown'",
    );
    assert.ok(snapshot.governorAsOf, "governorAsOf must be set from the surviving daemon.headroom line's ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RENDER RETENTION — a daemon.headroom line older than RENDER_STEP_RETENTION_WINDOW_MS is archived, not retained forever", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const staleHeadroomMs = nowMs - (RENDER_STEP_RETENTION_WINDOW_MS + 60_000); // long expired
    const freshHeadroomMs = nowMs - 60_000;

    const lines: string[] = [
      rawLine("daemon.headroom", "DAEMON", staleHeadroomMs, { enforced: true }),
      rawLine("daemon.headroom", "DAEMON", freshHeadroomMs, { enforced: true }),
    ];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshHeadroomMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(
      !liveContent.includes(new Date(staleHeadroomMs).toISOString()),
      "a daemon.headroom line long outside the render window is archived — bounded by recency, not kept forever",
    );
    assert.ok(
      liveContent.includes(new Date(freshHeadroomMs).toISOString()),
      "the fresh daemon.headroom line still survives alongside the stale one being dropped",
    );

    const archiveContent = readFileSync(result.archivePath as string, "utf8");
    assert.ok(
      archiveContent.includes(new Date(staleHeadroomMs).toISOString()),
      "the archived (never deleted) roll still holds the stale line verbatim",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1-T329 (OPERATOR COMPLAINT, 2026-08-04): the two DISPATCH-DEFERRING governors' own
// heartbeats. Same exposure as daemon.headroom above — neither was in either retention set, so a
// fleet deferring every dispatch for ~40 minutes at $152.28 against a $150 ceiling had ZERO
// surviving `daemon.cost_governor`/`daemon.queue_governor` lines the moment a rotation happened.

test("RENDER RETENTION — a fresh daemon.cost_governor line survives rotation and the ACCOUNT strip's cost-governor posture reads deferred, not unknown", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const freshMs = nowMs - 60_000;

    const lines: string[] = [
      rawLine("daemon.cost_governor", "DAEMON", freshMs, { tick: 5, observed_day_cost_usd: 152.28, daily_cost_ceiling_usd: 150, poll_interval_ms: 60000 }),
    ];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(liveContent.includes("daemon.cost_governor"), "the fresh daemon.cost_governor line survives rotation");

    // The REAL consumer, not a string check.
    const input: AccountUsageInput = { unreadable: true };
    const postRotationLines = readLedgerLines(ledgerPath);
    const snapshot = deriveAccountUsage(input, postRotationLines, nowMs);
    assert.equal(snapshot.costGovernor, "deferred", "the console must resolve a real cost-governor deferral from the post-rotation live ledger, not 'unknown'");
    assert.equal(snapshot.costGovernorObservedUsd, 152.28);
    assert.equal(snapshot.costGovernorCeilingUsd, 150);
    assert.ok(snapshot.costGovernorAsOf, "costGovernorAsOf must be set from the surviving line's ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RENDER RETENTION — a daemon.cost_governor line older than RENDER_STEP_RETENTION_WINDOW_MS is archived, not retained forever", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const staleMs = nowMs - (RENDER_STEP_RETENTION_WINDOW_MS + 60_000);
    const freshMarkerMs = nowMs - 60_000;

    const lines: string[] = [rawLine("daemon.cost_governor", "DAEMON", staleMs, { observed_day_cost_usd: 200, daily_cost_ceiling_usd: 150 })];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshMarkerMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(
      !liveContent.includes(new Date(staleMs).toISOString()),
      "a daemon.cost_governor line long outside the render window is archived — bounded by recency, not kept forever",
    );

    const archiveContent = readFileSync(result.archivePath as string, "utf8");
    assert.ok(archiveContent.includes(new Date(staleMs).toISOString()), "the archived roll still holds the stale line verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RENDER RETENTION — a fresh daemon.queue_governor line survives rotation and the ACCOUNT strip's queue-governor posture reads deferred, not unknown", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const freshMs = nowMs - 60_000;

    const lines: string[] = [
      rawLine("daemon.queue_governor", "DAEMON", freshMs, { tick: 5, observed_open_count: 12, wip_limit: 10, poll_interval_ms: 60000 }),
    ];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(liveContent.includes("daemon.queue_governor"), "the fresh daemon.queue_governor line survives rotation");

    const input: AccountUsageInput = { unreadable: true };
    const postRotationLines = readLedgerLines(ledgerPath);
    const snapshot = deriveAccountUsage(input, postRotationLines, nowMs);
    assert.equal(snapshot.queueGovernor, "deferred", "the console must resolve a real queue-governor deferral from the post-rotation live ledger, not 'unknown'");
    assert.equal(snapshot.queueGovernorObservedOpenCount, 12);
    assert.equal(snapshot.queueGovernorWipLimit, 10);
    assert.ok(snapshot.queueGovernorAsOf, "queueGovernorAsOf must be set from the surviving line's ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RENDER RETENTION — a daemon.queue_governor line older than RENDER_STEP_RETENTION_WINDOW_MS is archived, not retained forever", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const staleMs = nowMs - (RENDER_STEP_RETENTION_WINDOW_MS + 60_000);
    const freshMarkerMs = nowMs - 60_000;

    const lines: string[] = [rawLine("daemon.queue_governor", "DAEMON", staleMs, { observed_open_count: 12, wip_limit: 10 })];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshMarkerMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(
      !liveContent.includes(new Date(staleMs).toISOString()),
      "a daemon.queue_governor line long outside the render window is archived — bounded by recency, not kept forever",
    );

    const archiveContent = readFileSync(result.archivePath as string, "utf8");
    assert.ok(archiveContent.includes(new Date(staleMs).toISOString()), "the archived roll still holds the stale line verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RENDER RETENTION — a fresh console.kick_refused line survives rotation with its reason intact, so the RECENT feed's refusal record survives", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const freshRefusalMs = nowMs - 60_000;

    const lines: string[] = [
      rawLine("console.kick_refused", "DAEMON", freshRefusalMs, { task: "W1-T201", reason: "already dispatched" }),
    ];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshRefusalMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(liveContent.includes("console.kick_refused"), "the fresh console.kick_refused line survives rotation");
    assert.ok(liveContent.includes("already dispatched"), "its reason survives verbatim, not just the step name");
    assert.ok(liveContent.includes("W1-T201"), "the refused task id survives so the RECENT feed can attribute the row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RENDER RETENTION — a console.kick_refused line older than the render window is archived, not retained forever", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const staleRefusalMs = nowMs - (RENDER_STEP_RETENTION_WINDOW_MS + 60_000);
    const freshMarkerMs = nowMs - 60_000;

    const lines: string[] = [rawLine("console.kick_refused", "DAEMON", staleRefusalMs, { task: "W1-T099", reason: "stale" })];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshMarkerMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(
      !liveContent.includes("W1-T099"),
      "a console.kick_refused line long outside the render window is archived — bounded by recency, not kept forever",
    );

    const archiveContent = readFileSync(result.archivePath as string, "utf8");
    assert.ok(archiveContent.includes("W1-T099"), "the archived (never deleted) roll still holds the stale refusal verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RENDER RETENTION — a fresh console.kick_dispatched line survives rotation too (the same operator-action feed as kick_refused)", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const freshDispatchMs = nowMs - 60_000;

    const lines: string[] = [rawLine("console.kick_dispatched", "DAEMON", freshDispatchMs, { task: "W1-T202" })];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshDispatchMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(liveContent.includes("console.kick_dispatched"), "the fresh console.kick_dispatched line survives rotation");
    assert.ok(liveContent.includes("W1-T202"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1-T1237 (THE SWEEP HEARTBEAT WOULD NOT SURVIVE BEING READ): src/lib/doctor.ts's
// sweep-liveness arm (W1-T1236) reads `sweep.pass`/`sweep.summary` through its own
// `SWEEP_LIVENESS_STEPS` boundary marker — both were in NEITHER retention set before this task,
// so rotation archived them like any other diagnostic row and the arm would answer off a
// truncated corpus the moment a real rotation ran. Retention is RECENCY-BOUNDED, not permanent —
// the same "fresh survives, old is archived" proof this file already runs for every other entry
// in RENDER_RELEVANT_LEDGER_STEPS. ─────────────────────────────────────────────────────────────

test("W1-T1237: a fresh sweep.pass survives rotation and an old one does not", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const freshPassMs = nowMs - 60_000; // a minute ago — comfortably inside any real window
    const stalePassMs = nowMs - (RENDER_STEP_RETENTION_WINDOW_MS + 60_000); // long expired

    const lines: string[] = [
      rawLine("sweep.pass", "DAEMON", stalePassMs, { enumerated: 4 }),
      rawLine("sweep.pass", "DAEMON", freshPassMs, { enumerated: 7 }),
    ];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshPassMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(
      liveContent.includes(new Date(freshPassMs).toISOString()),
      "the fresh sweep.pass line survives rotation",
    );
    assert.ok(
      !liveContent.includes(new Date(stalePassMs).toISOString()),
      "a sweep.pass line long outside the render window is archived — bounded by recency, not kept forever, exactly like every other render-relevant step",
    );

    const archiveContent = readFileSync(result.archivePath as string, "utf8");
    assert.ok(
      archiveContent.includes(new Date(stalePassMs).toISOString()),
      "the archived (never deleted) roll still holds the stale sweep.pass line verbatim",
    );

    // The REAL consumer, not a string check: doctor.ts's own readSweepPassSummaryTimestamps
    // reading the post-rotation live ledger must still find the fresh row.
    const postRotationLines = readLedgerLines(ledgerPath);
    const { passesMs } = readSweepPassSummaryTimestamps(postRotationLines);
    assert.deepEqual(passesMs, [freshPassMs], "the sweep-liveness arm's own reader finds exactly the surviving fresh row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T1237: sweep.summary is retained beside sweep.pass", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const freshPassMs = nowMs - 120_000;
    const freshSummaryMs = nowMs - 60_000;
    const staleSummaryMs = nowMs - (RENDER_STEP_RETENTION_WINDOW_MS + 60_000);

    const lines: string[] = [
      rawLine("sweep.summary", "DAEMON", staleSummaryMs, { total: 3 }),
      rawLine("sweep.pass", "DAEMON", freshPassMs, { enumerated: 5 }),
      rawLine("sweep.summary", "DAEMON", freshSummaryMs, { total: 5 }),
    ];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshSummaryMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(
      liveContent.includes(new Date(freshSummaryMs).toISOString()),
      "the fresh sweep.summary line survives rotation beside sweep.pass",
    );
    assert.ok(
      !liveContent.includes(new Date(staleSummaryMs).toISOString()),
      "a sweep.summary line long outside the render window is archived — bounded by recency, not kept forever",
    );

    const archiveContent = readFileSync(result.archivePath as string, "utf8");
    assert.ok(
      archiveContent.includes(new Date(staleSummaryMs).toISOString()),
      "the archived (never deleted) roll still holds the stale sweep.summary line verbatim",
    );

    // The REAL consumer, not a string check: the paired derivation (a pass with no summary at or
    // after it) needs BOTH halves surviving, or it is worthless — doctor.ts's own reader must find
    // both the surviving pass and its surviving summary.
    const postRotationLines = readLedgerLines(ledgerPath);
    const { passesMs, summariesMs } = readSweepPassSummaryTimestamps(postRotationLines);
    assert.deepEqual(passesMs, [freshPassMs]);
    assert.deepEqual(summariesMs, [freshSummaryMs]);
    const verdict = judgeSweepLiveness(passesMs, summariesMs, nowMs);
    assert.equal(verdict.verdict, "OK", "post-rotation, the arm reads a real pass finished by its own surviving summary, not UNKNOWN");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T1237: the decision core is unchanged by this registration", () => {
  assert.ok(
    !DECISION_RELEVANT_LEDGER_STEPS.has("sweep.pass"),
    "sweep.pass belongs in the recency-bounded render set, never the never-rotated decision core (W1-T275's ruling, applied unchanged)",
  );
  assert.ok(
    !DECISION_RELEVANT_LEDGER_STEPS.has("sweep.summary"),
    "sweep.summary belongs in the recency-bounded render set, never the never-rotated decision core (W1-T275's ruling, applied unchanged)",
  );
  assert.ok(RENDER_RELEVANT_LEDGER_STEPS.has("sweep.pass"));
  assert.ok(RENDER_RELEVANT_LEDGER_STEPS.has("sweep.summary"));
});

// ── W1-T333 (THE OPERATOR'S AUDIT REQUIREMENT, verbatim in substance): every console write to
// the daily-cost-ceiling override must be ledgered with who/when/from/to and the resulting
// effective value, and that audit line must survive a rotation that would previously have erased
// it -- the SAME exposure daemon.headroom/console.kick_refused/daemon.cost_governor above already
// had, for the same reason: a step absent from either retention set is gone the moment a rotation
// happens, real history or not. ────────────────────────────────────────────────────────────────

test("CONSOLE WRITE AUDIT — appendDailyCostCeilingOverrideAudit ledgers who, from, to and the resulting effective value, and appendLedger's own clock supplies when", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    appendDailyCostCeilingOverrideAudit(ledgerPath, {
      runId: "console-1",
      taskId: "_console",
      who: "operator@example.com",
      fromUsd: 150,
      toUsd: 200,
      effectiveUsd: 200,
    });
    const [line] = readLedgerLines(ledgerPath);
    assert.equal(line.step, CEILING_OVERRIDE_WRITTEN_STEP);
    assert.equal(line.who, "operator@example.com", "WHO");
    assert.equal(line.from_usd, 150, "FROM");
    assert.equal(line.to_usd, 200, "TO");
    assert.equal(line.effective_usd, 200, "the resulting effective value");
    assert.equal(typeof line.ts, "string", "WHEN — appendLedger stamps ts itself, at write time");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RENDER RETENTION — a fresh console.ceiling_override_written line survives rotation and the ACCOUNT strip's audit trail reads the real who/from/to, not absent", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const freshMs = nowMs - 60_000;

    const lines: string[] = [
      rawLine(CEILING_OVERRIDE_WRITTEN_STEP, "_console", freshMs, {
        who: "operator@example.com",
        from_usd: 150,
        to_usd: 200,
        effective_usd: 200,
      }),
    ];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(liveContent.includes(CEILING_OVERRIDE_WRITTEN_STEP), "the fresh audit line survives rotation");

    // The REAL consumer, not a string check: account-usage.ts's own deriveAccountUsage reading
    // the post-rotation live ledger must report the real audit trail.
    const input: AccountUsageInput = { unreadable: true };
    const postRotationLines = readLedgerLines(ledgerPath);
    const snapshot = deriveAccountUsage(input, postRotationLines, nowMs);
    assert.equal(snapshot.dailyCostCeilingAuditWho, "operator@example.com");
    assert.equal(snapshot.dailyCostCeilingAuditFromUsd, 150);
    assert.equal(snapshot.dailyCostCeilingAuditToUsd, 200);
    assert.equal(snapshot.dailyCostCeilingAuditEffectiveUsd, 200);
    assert.ok(snapshot.dailyCostCeilingAuditAsOf, "the audit's own as-of must survive rotation, from the surviving line's ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RENDER RETENTION — a console.ceiling_override_written line older than RENDER_STEP_RETENTION_WINDOW_MS is archived, not retained forever", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const staleMs = nowMs - (RENDER_STEP_RETENTION_WINDOW_MS + 60_000);
    const freshMarkerMs = nowMs - 60_000;

    const lines: string[] = [
      rawLine(CEILING_OVERRIDE_WRITTEN_STEP, "_console", staleMs, { who: "operator@example.com", from_usd: 150, to_usd: 200, effective_usd: 200 }),
    ];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshMarkerMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(
      !liveContent.includes(new Date(staleMs).toISOString()),
      "a console.ceiling_override_written line long outside the render window is archived — bounded by recency, not kept forever",
    );

    const archiveContent = readFileSync(result.archivePath as string, "utf8");
    assert.ok(
      archiveContent.includes(new Date(staleMs).toISOString()),
      "the archived (never deleted) roll still holds the stale audit line verbatim",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RENDER_RELEVANT_LEDGER_STEPS includes console.ceiling_override_written, and the derived-from-consumers lock (above) already re-derives it from account-usage.ts's own source", () => {
  assert.ok(RENDER_RELEVANT_LEDGER_STEPS.has(CEILING_OVERRIDE_WRITTEN_STEP));
});

// ── Sanity: RENDER_RELEVANT_LEDGER_STEPS itself names the three console steps (W1-T275's literal
// ask), matching the analogous "DECISION_RELEVANT_LEDGER_STEPS includes daemon.boot" sanity test
// in test/ledger-rotation-convergence.test.ts. ───────────────────────────────────────────────
test("RENDER_RELEVANT_LEDGER_STEPS includes daemon.headroom, console.kick_refused, console.kick_dispatched", () => {
  assert.ok(RENDER_RELEVANT_LEDGER_STEPS.has("daemon.headroom"));
  assert.ok(RENDER_RELEVANT_LEDGER_STEPS.has("console.kick_refused"));
  assert.ok(RENDER_RELEVANT_LEDGER_STEPS.has("console.kick_dispatched"));
});

// W1-T329's own literal ask, mirroring the sanity test immediately above.
test("RENDER_RELEVANT_LEDGER_STEPS includes daemon.cost_governor and daemon.queue_governor", () => {
  assert.ok(RENDER_RELEVANT_LEDGER_STEPS.has("daemon.cost_governor"));
  assert.ok(RENDER_RELEVANT_LEDGER_STEPS.has("daemon.queue_governor"));
});

test("sanity: an absent ledger never exceeds anything and RENDER_RELEVANT_LEDGER_STEPS is unaffected by that path", () => {
  const dir = tmpDir();
  try {
    assert.equal(ledgerExceedsRotationCeiling(join(dir, "never-created.ndjson"), 10), false);
    assert.equal(readdirSync(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
