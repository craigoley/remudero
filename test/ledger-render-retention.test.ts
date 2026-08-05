import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RENDER_RELEVANT_LEDGER_STEPS,
  RENDER_STEP_RETENTION_WINDOW_MS,
  ledgerExceedsRotationCeiling,
  rotateLedger,
} from "../src/lib/ledger.js";
import { deriveAccountUsage, USAGE_CACHE_MAX_AGE_MS, type AccountUsageInput } from "../src/lib/account-usage.js";
import { readLedgerLines } from "../src/lib/status.js";

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

// ── W1-T333 (an override with no surface is a value overridden invisibly): the daily cost
// ceiling's own console-write audit trail. `panel.cost_ceiling_override_set`/`_cleared` carry
// WHO (origin)/WHEN (ts)/FROM/TO/the resulting effective value -- the operator's stated audit
// requirement -- and, like daemon.headroom/console.kick_refused above, RENDER not DECISION: the
// live override lives in policy.ts's state/ store; this line is HISTORY, so a rotation must not
// erase it (the falsifier this task names explicitly: "a rotation that would previously have
// erased the audit line now leaves it readable"). NOTHING IN THIS CHECKOUT EMITS THESE STEPS
// YET -- the write route is this task's own deliberately unfiled follow-up -- so these tests
// drive directly-constructed lines, the same shape every other test in this file already uses.

test("RENDER RETENTION — a fresh panel.cost_ceiling_override_set line survives rotation with who/from/to/effective intact, and the ACCOUNT strip's audit reading is real", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const freshMs = nowMs - 60_000;

    const lines: string[] = [
      rawLine("panel.cost_ceiling_override_set", "PANEL", freshMs, {
        origin: "3f1a9c7b2e",
        from_usd: 500,
        to_usd: 900,
        effective_usd: 900,
      }),
    ];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(liveContent.includes("panel.cost_ceiling_override_set"), "the fresh audit line survives rotation");
    assert.ok(liveContent.includes("3f1a9c7b2e"), "who (origin) survives verbatim, not just the step name");

    // The REAL consumer, not a string check: account-usage.ts's own deriveAccountUsage reading
    // the post-rotation live ledger, with a ceiling that currently reads "default" (the
    // disappearance case) -- the surviving audit line is what makes it read "default-vanished"
    // rather than "default", the whole point of retaining it through rotation.
    const input: AccountUsageInput = { unreadable: true };
    const postRotationLines = readLedgerLines(ledgerPath);
    const ceilingReading = { usd: 500, provenance: "default" as const, committedDefaultUsd: 500 };
    const snapshot = deriveAccountUsage(input, postRotationLines, nowMs, ceilingReading);
    assert.equal(snapshot.costCeilingProvenance, "default-vanished", "the surviving audit line must still be read post-rotation");
    assert.equal(snapshot.costCeilingAuditOrigin, "3f1a9c7b2e");
    assert.equal(snapshot.costCeilingAuditFromUsd, 500);
    assert.equal(snapshot.costCeilingAuditToUsd, 900);
    assert.ok(snapshot.costCeilingAuditAsOf, "the audit's own ts must survive rotation and be read back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RENDER RETENTION — a panel.cost_ceiling_override_set line older than RENDER_STEP_RETENTION_WINDOW_MS is archived, not retained forever", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const staleMs = nowMs - (RENDER_STEP_RETENTION_WINDOW_MS + 60_000);
    const freshMarkerMs = nowMs - 60_000;

    const lines: string[] = [
      rawLine("panel.cost_ceiling_override_set", "PANEL", staleMs, { origin: "aaaa1111", from_usd: 500, to_usd: 1_200, effective_usd: 1_200 }),
    ];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshMarkerMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(
      !liveContent.includes("aaaa1111"),
      "an audit line long outside the render window is archived — bounded by recency, not kept forever",
    );

    const archiveContent = readFileSync(result.archivePath as string, "utf8");
    assert.ok(archiveContent.includes("aaaa1111"), "the archived (never deleted) roll still holds the stale audit line verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RENDER RETENTION — a fresh panel.cost_ceiling_override_cleared line survives rotation too, and reads as a deliberate revert (never 'vanished')", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const freshMs = nowMs - 60_000;

    const lines: string[] = [
      rawLine("panel.cost_ceiling_override_cleared", "PANEL", freshMs, { origin: "bbbb2222", from_usd: 900, to_usd: 500, effective_usd: 500 }),
    ];
    for (let i = 0; i < 300; i++) lines.push(noiseLine(i, freshMs));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(nowMs) });
    assert.equal(result.rotated, true);

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(liveContent.includes("panel.cost_ceiling_override_cleared"), "the fresh cleared-audit line survives rotation");

    const input: AccountUsageInput = { unreadable: true };
    const postRotationLines = readLedgerLines(ledgerPath);
    const ceilingReading = { usd: 500, provenance: "default" as const, committedDefaultUsd: 500 };
    const snapshot = deriveAccountUsage(input, postRotationLines, nowMs, ceilingReading);
    assert.equal(snapshot.costCeilingProvenance, "default", "an explicit clear must never read as a vanished override");
    assert.equal(snapshot.costCeilingAuditAction, "cleared");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Sanity: RENDER_RELEVANT_LEDGER_STEPS itself names the two cost-ceiling audit steps (this
// task's own literal ask), matching the analogous sanity tests above for W1-T275/W1-T329.
test("RENDER_RELEVANT_LEDGER_STEPS includes panel.cost_ceiling_override_set and panel.cost_ceiling_override_cleared", () => {
  assert.ok(RENDER_RELEVANT_LEDGER_STEPS.has("panel.cost_ceiling_override_set"));
  assert.ok(RENDER_RELEVANT_LEDGER_STEPS.has("panel.cost_ceiling_override_cleared"));
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
