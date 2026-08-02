import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  rotateLedger,
  DECISION_RELEVANT_LEDGER_STEPS,
  RENDER_RELEVANT_LEDGER_STEPS,
  RENDER_STEP_RETENTION_WINDOW_MS,
} from "../src/lib/ledger.js";

// ── `isRenderRelevantStep` is an exact `Set.has`, so a dotted CHILD does not inherit its parent's
// protection. `daemon.headroom` was retained; `daemon.headroom.degraded`/`.unavailable` were not —
// 52 and 215 lines in the unioned corpus, ZERO in the live ledger. The step by which a blind
// governor announces itself was evaporating within the hour, and a blind governor once idled the
// whole fleet for three hours.
//
// EVERY TEST BELOW DRIVES THE REAL `rotateLedger`. "The string is in the Set" would pass on a set
// rotation ignores — the trivially-passing shape shipped eleven times this week.

const NOW = new Date("2026-08-02T14:00:00.000Z");

function line(step: string, ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, run_id: "R-1", task_id: "DAEMON", step, note: "x".repeat(200), ...extra });
}

function ledgerWith(lines: string[]): { ledgerPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-degraded-retention-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, lines.join("\n") + "\n");
  return { ledgerPath, dir };
}

/**
 * Rotate with a ceiling the file exceeds but the retained set fits under.
 *
 * NOT `ceilingBytes: 1`: measured, that drives rotation's final shed pass to discard EVERYTHING,
 * including protected steps — a test built that way fails on correct code and tempts you to loosen
 * the assertion until it passes for the wrong reason.
 */
function rotate(ledgerPath: string): void {
  const result = rotateLedger(ledgerPath, { ceilingBytes: 4000, now: () => NOW });
  assert.equal(result.rotated, true, "the fixture must exceed the ceiling, or this proves nothing");
  assert.ok(result.retainedLineCount! > 0, "rotation must retain SOMETHING — a total shed proves nothing about membership");
}

const RECENT = new Date(NOW.getTime() - 60_000).toISOString();

/** A line protected INDEPENDENTLY of this change, so the shed is provably selective and the
 *  falsifier fails on the claim under test rather than on the retained-something guard. */
const INDEPENDENT = line("run.start", RECENT);

const GOVERNOR_BLINDNESS_STEPS = ["daemon.headroom.degraded", "daemon.headroom.unavailable"] as const;

test("a governor-blindness line SURVIVES a real rotation", () => {
  const { ledgerPath, dir } = ledgerWith([
    line("daemon.headroom.degraded", RECENT, { consecutive_unreadable: 42, poll_interval_ms: 60000 }),
    line("daemon.headroom.unavailable", RECENT, { consecutive_unreadable: 2 }),
    INDEPENDENT,
    ...Array.from({ length: 40 }, (_, i) => line("daemon.idle", new Date(NOW.getTime() - i * 1000).toISOString())),
  ]);
  try {
    rotate(ledgerPath);
    const after = readFileSync(ledgerPath, "utf8");
    for (const step of GOVERNOR_BLINDNESS_STEPS) {
      assert.ok(
        after.includes(`"step":"${step}"`),
        `${step} was dropped by rotation — a blind governor would be indistinguishable from a healthy one`,
      );
    }
    // The DURATION must survive with the line: a reader concludes "blind for N minutes" from the
    // counter, not from how much history rotation happened to keep.
    assert.match(after, /"consecutive_unreadable":42/, "the blindness duration must survive with its line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an UNPROTECTED step is still shed by the same rotation — the shed is selective", () => {
  const { ledgerPath, dir } = ledgerWith([
    line("daemon.headroom.degraded", RECENT),
    INDEPENDENT,
    ...Array.from({ length: 40 }, (_, i) => line("daemon.idle", new Date(NOW.getTime() - i * 1000).toISOString())),
  ]);
  try {
    rotate(ledgerPath);
    const after = readFileSync(ledgerPath, "utf8");
    assert.ok(after.includes('"step":"daemon.headroom.degraded"'), "the protected step must survive");
    assert.ok(
      !after.includes('"step":"daemon.idle"'),
      "daemon.idle is in NEITHER set and must be shed — if it survived, rotation kept everything and the assertion above is vacuous",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a governor-blindness line older than the render window is shed — the retention stays bounded", () => {
  const stale = new Date(NOW.getTime() - RENDER_STEP_RETENTION_WINDOW_MS - 60_000).toISOString();
  const { ledgerPath, dir } = ledgerWith([
    line("daemon.headroom.degraded", stale),
    INDEPENDENT,
    ...Array.from({ length: 40 }, (_, i) => line("daemon.idle", new Date(NOW.getTime() - i * 1000).toISOString())),
  ]);
  try {
    rotate(ledgerPath);
    const after = readFileSync(ledgerPath, "utf8");
    assert.ok(after.includes('"step":"run.start"'), "the independently-protected line must survive — this test's own control");
    assert.ok(!after.includes('"step":"daemon.headroom.degraded"'), "a stale blindness line must not be retained forever");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the 30-minute window is sufficient because a blind governor re-emits every tick", () => {
  // Measured: 49 of 51 consecutive `degraded` gaps are under ten minutes, median 2.32. So a blind
  // episode always has a line inside the window. This pins the ASSUMPTION that justifies the window
  // choice — a poll interval slower than the window would invalidate it.
  const pollIntervalMs = 60_000;
  assert.ok(
    pollIntervalMs * 2 < RENDER_STEP_RETENTION_WINDOW_MS,
    "the render window must comfortably exceed the daemon's poll interval, or a blind episode could fall between retained lines",
  );
});

test("daemon.headroom_reserve.escalated is NOT swept in — the exclusion is deliberate", () => {
  // A prefix-aware `startsWith("daemon.headroom")` would also match this step, which is DECISION-
  // relevant (never rotated). Because rotation's PASS 2 windows ANY render/health match without
  // exempting decision-relevant steps, that would silently DOWNGRADE it from never-rotated to a
  // 30-minute window. Pinned here so a future "just use a prefix" change fails loudly.
  assert.equal([...DECISION_RELEVANT_LEDGER_STEPS].includes("daemon.headroom_reserve.escalated"), true);
  assert.equal(RENDER_RELEVANT_LEDGER_STEPS.has("daemon.headroom_reserve.escalated"), false);
  for (const step of GOVERNOR_BLINDNESS_STEPS) {
    assert.ok(RENDER_RELEVANT_LEDGER_STEPS.has(step), `${step} is emitted and will be read, so it must be retained`);
  }
});

test("dual membership DOWNGRADES protection — the measured reason not to use a prefix rule", () => {
  // `daemon.boot` is in DECISION_RELEVANT *and* matches isHealthOrDeployStep, and rotation's PASS 2
  // windows it anyway. That is deliberate for daemon.boot, but it means any prefix rule added later
  // silently reduces whatever DECISION step it catches. Asserted against the real rotation so the
  // hazard is demonstrated rather than described.
  const old = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
  const { ledgerPath, dir } = ledgerWith([
    line("daemon.boot", old),
    line("run.start", old),
    ...Array.from({ length: 40 }, (_, i) => line("daemon.idle", new Date(NOW.getTime() - i * 1000).toISOString())),
  ]);
  try {
    rotateLedger(ledgerPath, { ceilingBytes: 4000, now: () => NOW });
    const after = readFileSync(ledgerPath, "utf8");
    assert.ok(after.includes('"step":"run.start"'), "DECISION-only: kept unconditionally");
    assert.ok(
      !after.includes('"step":"daemon.boot"'),
      "DECISION + health match: windowed and shed — this is why a prefix rule is not a safe generalisation",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
