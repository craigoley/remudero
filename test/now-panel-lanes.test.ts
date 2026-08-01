/**
 * test/now-panel-lanes.test.ts — W1-T282: deriveRunState opened an in-flight run on exactly
 * one ledger step, `run.start`, so a running `daemon`/`drain`/`plan`/`retro`/`serve`/`triage`
 * lane (each its own pseudo `task_id` — `DAEMON`/`DRAIN`/`PLAN-<mode>`/`RETRO`/`SERVE`/
 * `TRIAGE-<feedbackId>`, run-task.ts) scanned as "nothing in flight" even while genuinely
 * running. Proves, over {@link deriveStatus} (the same public entry point test/status.test.ts's
 * own W1-T155 suite already exercises deriveRunState through — deriveRunState itself is not
 * exported): every lane's own start step opens the run; a lane whose success emits no terminal
 * step (retro/triage — confirmed absent from src/, MEASURED at 63f63ed) still closes via the
 * existing W1-T179 liveness bound rather than hanging open forever; and a dispatched TASK run's
 * own `run.start`/`verdict` behavior is unchanged.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { deriveStatus, type GitHub } from "../src/lib/status.js";

/** A minimal task; fields not under test get sensible defaults (mirrors test/status.test.ts). */
function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

/** A GitHub gateway that resolves nothing — every lane row under test has no PR at all. */
function noGithub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-now-panel-lanes-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

// ── every lane's own start step opens the run (LANE_START_STEPS, status.ts) ────────────────

const LANES: Array<{ name: string; taskId: string; startStep: string }> = [
  { name: "daemon", taskId: "DAEMON", startStep: "daemon.start" },
  { name: "drain", taskId: "DRAIN", startStep: "drain.start" },
  { name: "plan", taskId: "PLAN-expand", startStep: "plan.start" },
  { name: "retro", taskId: "RETRO", startStep: "retro.start" },
  { name: "serve", taskId: "SERVE", startStep: "serve.start" },
  { name: "triage", taskId: "TRIAGE-42", startStep: "triage.start" },
];

for (const lane of LANES) {
  test(`W1-T282: a bare ${lane.startStep} (the ${lane.name} lane's own start step) appears in the projection as in-flight`, () => {
    const ledgerPath = ledgerFile([
      { ts: "2026-08-01T09:00:00.000Z", run_id: `${lane.taskId}-r1`, task_id: lane.taskId, step: lane.startStep },
    ]);
    const proj = deriveStatus(task({ id: lane.taskId }), {
      ledgerPath,
      github: noGithub(),
      now: () => Date.parse("2026-08-01T09:00:05.000Z"), // well inside the liveness bound
    });
    assert.equal(proj.status, "running", `${lane.startStep} must open the run exactly like run.start does`);
    assert.equal(proj.phase, "recon");
  });
}

// ── the close side is asymmetric: daemon/drain/plan/serve close on their own terminal step ──

test("W1-T282: daemon.summary closes the daemon lane's run — no longer running once logged", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-01T09:00:00.000Z", run_id: "DAEMON-r1", task_id: "DAEMON", step: "daemon.start" },
    { ts: "2026-08-01T09:00:01.000Z", run_id: "DAEMON-r1", task_id: "DAEMON", step: "daemon.summary" },
  ]);
  const proj = deriveStatus(task({ id: "DAEMON" }), {
    ledgerPath,
    github: noGithub(),
    now: () => Date.parse("2026-08-01T09:00:05.000Z"),
  });
  assert.notEqual(proj.status, "running");
  assert.equal(proj.phase, undefined);
});

test("W1-T282: drain.stop closes the drain lane's run", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-01T09:00:00.000Z", run_id: "DRAIN-r1", task_id: "DRAIN", step: "drain.start" },
    { ts: "2026-08-01T09:00:01.000Z", run_id: "DRAIN-r1", task_id: "DRAIN", step: "drain.stop" },
  ]);
  const proj = deriveStatus(task({ id: "DRAIN" }), {
    ledgerPath,
    github: noGithub(),
    now: () => Date.parse("2026-08-01T09:00:05.000Z"),
  });
  assert.notEqual(proj.status, "running");
});

test("W1-T282: plan.verdict closes the plan lane's run", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-01T09:00:00.000Z", run_id: "PLAN-expand-r1", task_id: "PLAN-expand", step: "plan.start" },
    { ts: "2026-08-01T09:00:01.000Z", run_id: "PLAN-expand-r1", task_id: "PLAN-expand", step: "plan.verdict" },
  ]);
  const proj = deriveStatus(task({ id: "PLAN-expand" }), {
    ledgerPath,
    github: noGithub(),
    now: () => Date.parse("2026-08-01T09:00:05.000Z"),
  });
  assert.notEqual(proj.status, "running");
});

test("W1-T282: serve.stop closes the serve lane's run", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-01T09:00:00.000Z", run_id: "SERVE-r1", task_id: "SERVE", step: "serve.start" },
    { ts: "2026-08-01T09:00:01.000Z", run_id: "SERVE-r1", task_id: "SERVE", step: "serve.stop" },
  ]);
  const proj = deriveStatus(task({ id: "SERVE" }), {
    ledgerPath,
    github: noGithub(),
    now: () => Date.parse("2026-08-01T09:00:05.000Z"),
  });
  assert.notEqual(proj.status, "running");
});

// ── retro/triage log ONLY an error terminal — a SUCCESSFUL run emits no terminal step at all,
// so it must NOT hang open forever; the existing W1-T179 liveness bound is what closes it ──────

test("W1-T282: retro.error closes the retro lane's run (its one terminal step, an error path)", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-01T09:00:00.000Z", run_id: "RETRO-r1", task_id: "RETRO", step: "retro.start" },
    { ts: "2026-08-01T09:00:01.000Z", run_id: "RETRO-r1", task_id: "RETRO", step: "retro.error", error: "no PR opened" },
  ]);
  const proj = deriveStatus(task({ id: "RETRO" }), {
    ledgerPath,
    github: noGithub(),
    now: () => Date.parse("2026-08-01T09:00:05.000Z"),
  });
  assert.notEqual(proj.status, "running");
});

test("W1-T282: a SUCCESSFUL retro (no terminal step at all) still reads running while ledger activity is recent", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-01T09:00:00.000Z", run_id: "RETRO-r1", task_id: "RETRO", step: "retro.start" },
  ]);
  const proj = deriveStatus(task({ id: "RETRO" }), {
    ledgerPath,
    github: noGithub(),
    now: () => Date.parse("2026-08-01T09:00:05.000Z"), // 5s later — inside any reasonable bound
    livenessBoundMs: 10 * 60_000,
  });
  assert.equal(proj.status, "running", "still genuinely in flight — no terminal step yet, but recent activity");
});

test("W1-T282: a SUCCESSFUL retro (no terminal step) does NOT hang open forever — the liveness bound closes it once activity goes stale", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-01T09:00:00.000Z", run_id: "RETRO-r1", task_id: "RETRO", step: "retro.start" },
  ]);
  const proj = deriveStatus(task({ id: "RETRO" }), {
    ledgerPath,
    github: noGithub(),
    now: () => Date.parse("2026-08-01T09:31:00.000Z"), // 31 minutes later — past DEFAULT_LIVENESS_BOUND_MS (30 min)
  });
  assert.notEqual(proj.status, "running", "the falsifier: a silently-finished retro rendered as running forever");
  assert.equal(proj.orphaned, true);
});

test("W1-T282: a SUCCESSFUL triage (no terminal step) does NOT hang open forever either", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-01T09:00:00.000Z", run_id: "TRIAGE-42-r1", task_id: "TRIAGE-42", step: "triage.start" },
  ]);
  const proj = deriveStatus(task({ id: "TRIAGE-42" }), {
    ledgerPath,
    github: noGithub(),
    now: () => Date.parse("2026-08-01T09:31:00.000Z"),
  });
  assert.notEqual(proj.status, "running");
  assert.equal(proj.orphaned, true);
});

// ── a dispatched TASK run still opens and closes exactly as it does today ──────────────────

test("W1-T282: a dispatched TASK run.start still opens the run exactly as before", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-01T09:00:00.000Z", run_id: "r1", task_id: "W1-T1", step: "run.start" },
  ]);
  const proj = deriveStatus(task({ id: "W1-T1" }), {
    ledgerPath,
    github: noGithub(),
    now: () => Date.parse("2026-08-01T09:00:05.000Z"),
  });
  assert.equal(proj.status, "running");
  assert.equal(proj.phase, "recon");
});

test("W1-T282: a dispatched TASK run's own verdict still closes it exactly as before", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-01T09:00:00.000Z", run_id: "r1", task_id: "W1-T1", step: "run.start" },
    { ts: "2026-08-01T09:00:01.000Z", run_id: "r1", task_id: "W1-T1", step: "verdict", verdict: "merged" },
  ]);
  const proj = deriveStatus(task({ id: "W1-T1" }), {
    ledgerPath,
    github: noGithub(),
    now: () => Date.parse("2026-08-01T09:00:05.000Z"),
  });
  assert.notEqual(proj.status, "running");
  assert.equal(proj.phase, undefined);
});

test("W1-T282: a dispatched TASK run's phase transitions (recon -> implement -> review -> fix-rung -> review) are unchanged", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-01T09:00:00.000Z", run_id: "r1", task_id: "W1-T1", step: "run.start" },
    { ts: "2026-08-01T09:00:01.000Z", run_id: "r1", task_id: "W1-T1", step: "recon.done" },
    { ts: "2026-08-01T09:00:02.000Z", run_id: "r1", task_id: "W1-T1", step: "implement.done" },
    { ts: "2026-08-01T09:00:03.000Z", run_id: "r1", task_id: "W1-T1", step: "fix.dispatch" },
    { ts: "2026-08-01T09:00:04.000Z", run_id: "r1", task_id: "W1-T1", step: "fix.resolved" },
  ]);
  const proj = deriveStatus(task({ id: "W1-T1" }), {
    ledgerPath,
    github: noGithub(),
    now: () => Date.parse("2026-08-01T09:00:05.000Z"),
  });
  assert.equal(proj.status, "running");
  assert.equal(proj.phase, "review");
});
