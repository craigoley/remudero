import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rotateLedger, RENDER_RELEVANT_LEDGER_STEPS, RENDER_STEP_RETENTION_WINDOW_MS } from "../src/lib/ledger.js";
import { DEFAULT_LIVENESS_BOUND_MS } from "../src/lib/status.js";

// ── W1-T282 taught the NOW panel to open a run on any lane's start step, not just `run.start`. None
// of the six new ones was retained, so `rotateLedger` dropped them and a long-running lane could
// VANISH from "currently running" mid-flight. Measured on this host before the fix: `drain.start`,
// `retro.start` and `triage.start` each read ZERO in the live ledger against 25/14/34 in the unioned
// corpus — already rotated away, not merely at risk.
//
// EVERY TEST BELOW DRIVES THE REAL `rotateLedger`. Asserting "the string is in the Set" would pass on
// a set rotation ignores, which is exactly the trivially-passing shape this repo has shipped ten
// times this week. What matters is that the LINE SURVIVES THE ROTATION, so that is what is asserted.

const NOW = new Date("2026-08-02T14:00:00.000Z");

/** A ledger line as the producers actually write it — `"step":"…"`, no space after the colon. */
function line(step: string, ts: string, taskId = "DAEMON"): string {
  return JSON.stringify({ ts, run_id: "R-1", task_id: taskId, step, note: "x".repeat(200) });
}

function ledgerWith(lines: string[]): { ledgerPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lane-start-retention-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, lines.join("\n") + "\n");
  return { ledgerPath, dir };
}

/**
 * Rotate with a ceiling the file exceeds but the RETAINED set comfortably fits under.
 *
 * NOT a 1-byte ceiling, and the difference matters: measured, `ceilingBytes: 1` drives rotation's
 * final shed pass to discard EVERYTHING — even `run.start` and `daemon.headroom`, which are
 * protected — leaving only a `ledger.rotation_shed` marker. A test written that way would fail on
 * fixed code and "pass" its falsifier for entirely the wrong reason.
 */
function rotate(ledgerPath: string): void {
  const result = rotateLedger(ledgerPath, { ceilingBytes: 4000, now: () => NOW });
  assert.equal(result.rotated, true, "the fixture must actually exceed the ceiling — otherwise this test proves nothing");
  assert.ok(result.retainedLineCount! > 0, "rotation must have retained SOMETHING — a total shed proves nothing about membership");
}

const PROTECTED_LANE_STARTS = ["daemon.start", "drain.start", "retro.start", "serve.start", "triage.start"] as const;

test("a lane start inside the retention window SURVIVES a real rotation", () => {
  const recent = new Date(NOW.getTime() - 60_000).toISOString(); // 1 minute old — well inside the window
  const { ledgerPath, dir } = ledgerWith([
    ...PROTECTED_LANE_STARTS.map((s) => line(s, recent)),
    // `run.start` is DECISION-relevant INDEPENDENTLY of this PR, so rotation always retains at least
    // this line. Without it, removing this PR's additions makes the fixture shed everything and the
    // falsifier fails on the "retained SOMETHING" guard rather than on the claim under test.
    line("run.start", recent, "W1-T1"),
    // Filler so the file is unambiguously over any sane ceiling, and a step nothing protects.
    ...Array.from({ length: 40 }, (_, i) => line("daemon.idle", new Date(NOW.getTime() - i * 1000).toISOString())),
  ]);
  try {
    rotate(ledgerPath);
    const after = readFileSync(ledgerPath, "utf8");
    for (const step of PROTECTED_LANE_STARTS) {
      assert.ok(
        after.includes(`"step":"${step}"`),
        `${step} was dropped by rotation — the NOW panel would show its lane as not running mid-flight`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an UNPROTECTED step is still dropped by the same rotation — proving rotation is doing the work", () => {
  // The control for the test above. Without this, "the line is still there" could mean rotation
  // simply kept everything, and the retention set would be doing nothing at all.
  const recent = new Date(NOW.getTime() - 60_000).toISOString();
  const { ledgerPath, dir } = ledgerWith([
    line("daemon.start", recent),
    line("run.start", recent, "W1-T1"), // protected independently of this PR — see the fixture note above
    ...Array.from({ length: 40 }, (_, i) => line("daemon.idle", new Date(NOW.getTime() - i * 1000).toISOString())),
  ]);
  try {
    rotate(ledgerPath);
    const after = readFileSync(ledgerPath, "utf8");
    assert.ok(after.includes('"step":"daemon.start"'), "the protected step must survive");
    assert.ok(
      !after.includes('"step":"daemon.idle"'),
      "daemon.idle is in NEITHER retention set and must be dropped — if it survived, rotation kept everything and the protected-step assertion above is vacuous",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lane start OLDER than the render window is dropped — the retention is bounded, not forever", () => {
  // RENDER_RELEVANT is recency-bounded on purpose: these are display-only reads, and retaining every
  // lane start forever (the DECISION_RELEVANT treatment) would grow the never-rotated core for a
  // panel that cannot use the old lines anyway.
  const stale = new Date(NOW.getTime() - RENDER_STEP_RETENTION_WINDOW_MS - 60_000).toISOString();
  const { ledgerPath, dir } = ledgerWith([
    line("triage.start", stale),
    // A RECENT protected line so the rotation retains something — otherwise the shed-everything path
    // would drop the stale line for a reason that has nothing to do with the window.
    line("daemon.start", new Date(NOW.getTime() - 60_000).toISOString()),
    line("run.start", new Date(NOW.getTime() - 60_000).toISOString(), "W1-T1"),
    ...Array.from({ length: 40 }, (_, i) => line("daemon.idle", new Date(NOW.getTime() - i * 1000).toISOString())),
  ]);
  try {
    rotate(ledgerPath);
    const after = readFileSync(ledgerPath, "utf8");
    assert.ok(after.includes('"step":"daemon.start"'), "the RECENT protected line must survive — the control for this test");
    assert.ok(!after.includes('"step":"triage.start"'), "a lane start past the window must not be retained forever");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the retention window equals NOW's own liveness bound, so a retained start can never strand a perpetual row", () => {
  // THE ASYMMETRY LOCK. A SUCCESSFUL retro or triage logs no terminal step at all (status.ts's
  // LANE_TERMINAL_STEPS doc: `retro.error`/`triage.error` are each lane's ONLY terminal), so those
  // lanes close purely on deriveStatus's liveness bound. If retention outlived that bound, a
  // successful run's start could sit in the ledger being read as in-flight after NOW had stopped
  // calling it live. Equal windows make that impossible by construction.
  assert.equal(
    RENDER_STEP_RETENTION_WINDOW_MS,
    DEFAULT_LIVENESS_BOUND_MS,
    "if these ever diverge, a lane with no success-terminal can be shown running after it stopped (window > bound) " +
      "or vanish while still live (window < bound)",
  );
});

test("plan.start is deliberately NOT protected — membership for a step nothing emits is the defect in the other direction", () => {
  // `sweep.absent_repush` sits in DECISION_RELEVANT and occurs zero times because nothing emits it.
  // `plan.start` has a real emitter (run-task.ts) but ZERO emissions across 19 days of unioned
  // ledger, so protecting it now would repeat that defect. This pins the decision as deliberate
  // rather than an oversight — flip it when `rmd plan` actually runs.
  assert.equal(RENDER_RELEVANT_LEDGER_STEPS.has("plan.start"), false);
  assert.equal(RENDER_RELEVANT_LEDGER_STEPS.has("run.start"), false, "run.start is DECISION-relevant, protected elsewhere");
  for (const step of PROTECTED_LANE_STARTS) {
    assert.ok(RENDER_RELEVANT_LEDGER_STEPS.has(step), `${step} is emitted and read by NOW, so it must be retained`);
  }
});
