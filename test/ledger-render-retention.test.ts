import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CEILING_OVERRIDE_WRITTEN_STEP,
  RENDER_RELEVANT_LEDGER_STEPS,
  RENDER_STEP_RETENTION_WINDOW_MS,
  appendDailyCostCeilingOverrideAudit,
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
