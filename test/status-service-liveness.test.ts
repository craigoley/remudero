import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStatusBoard, livenessState, renderStatusBoardText, type StatusBoardDeps } from "../src/lib/status-board.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";

// ── W1-T301: `rmd status` reported the deploy-supervisor (a launchd StartInterval ONE-SHOT,
// `rmd deploy-run` every ~120s) as "not running" whenever polled between ticks — its NORMAL
// resting state — the identical words a genuinely dead resident service renders. LIVENESS for
// an interval job is RECENCY (a ledger `deploy.*` tick, read the same way daemon.boot already
// is) PLUS EXIT STATUS (`launchctl list`'s Status column, injected here via `queryService`'s
// `lastExitCode`), never instantaneous pid presence — see status-board.ts's `livenessState`.

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "status-liveness-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

const NOW_ISO = "2026-08-03T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const SUPERVISOR_INTERVAL_S = 120; // matches the installed unit's StartInterval, injected below

function baseDeps(overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    resolveSupervisorIntervalS: () => SUPERVISOR_INTERVAL_S,
    ...overrides,
  };
}

function writeLedger(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "status-liveness-ledger-"));
  const path = join(dir, "ledger.ndjson");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

function deploySupervisorRow(model: ReturnType<typeof buildStatusBoard>) {
  const row = model.liveness.services.find((s) => s.service === "deploy-supervisor");
  assert.ok(row, "expected a deploy-supervisor row");
  return row!;
}

// ── W1-T450: QUEUE HEAD's stall rung must stay SILENT on an unknown answer rather than claim a
// stall — no ledger, an unparseable run.start timestamp, or too little dispatch history to learn
// a cadence from are all "we don't know", never "it's stuck" (design (iv)) ─────────────────────

const QUEUE_HEAD_PLAN_YAML = `
- id: W1-T920
  title: a queue-head candidate for the staleness rung
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`;

function plan(): Plan {
  return loadPlanFromYaml(QUEUE_HEAD_PLAN_YAML, "fixture");
}

function fakeGithub(overrides: Partial<GitHub> = {}): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    ...overrides,
  };
}

test("buildStatusBoard: QUEUE HEAD — an unreadable or absent run.start leaves the stall rung silent, never claiming a stall on an unknown answer", () => {
  const fixturePlan = plan();
  const github = fakeGithub();

  // Case A: no ledger file at all — run.start is ABSENT, not merely old.
  const noLedgerDir = mkdtempSync(join(tmpdir(), "status-liveness-noledger-"));
  const noLedgerModel = buildStatusBoard(tmpRoot(), join(noLedgerDir, "does-not-exist.ndjson"), baseDeps({ plan: fixturePlan, github }));
  assert.ok(noLedgerModel.queueHead.rows.length > 0, "the fixture plan must still produce a candidate");
  assert.equal(noLedgerModel.queueHead.stall, undefined, "no ledger at all must never render as a stall");

  // Case B: run.start lines present, but their `ts` does not parse.
  const badTsLedgerPath = writeLedger([
    { run_id: "R1", task_id: "OTHER", step: "run.start", ts: "not-a-real-timestamp" },
    { run_id: "R2", task_id: "OTHER", step: "run.start", ts: "also-not-a-timestamp" },
  ]);
  const badTsModel = buildStatusBoard(tmpRoot(), badTsLedgerPath, baseDeps({ plan: fixturePlan, github }));
  assert.equal(badTsModel.queueHead.stall, undefined, "an unparseable run.start timestamp must never be counted toward a stall");

  // Case C: only ONE dispatch has EVER been recorded — there is no gap yet to learn a cadence
  // from, so the bound itself is unknown and the rung must stay silent rather than guess one.
  const oneDispatchLedgerPath = writeLedger([
    { run_id: "R1", task_id: "OTHER", step: "run.start", ts: new Date(NOW_MS - 5 * 3_600_000).toISOString() },
  ]);
  const oneDispatchModel = buildStatusBoard(tmpRoot(), oneDispatchLedgerPath, baseDeps({ plan: fixturePlan, github }));
  assert.equal(
    oneDispatchModel.queueHead.stall,
    undefined,
    "a single ever-recorded dispatch has no gap to derive a bound from — silent, not stalled",
  );

  for (const model of [noLedgerModel, badTsModel, oneDispatchModel]) {
    assert.doesNotMatch(renderStatusBoardText(model), /STALL/);
  }
});

// ── ACCEPTANCE 1 ─────────────────────────────────────────────────────────────────────────────

test("an interval service with last-exit 0 and a tick inside its window renders as healthy-idle with the tick age, never as 'not running'", () => {
  const tickAgo = 30_000; // well inside the 120s*3 overdue window
  const ledgerPath = writeLedger([
    { run_id: "DEPLOY-1", task_id: "DEPLOY", step: "deploy.skip", ts: new Date(NOW_MS - tickAgo).toISOString(), reason: "no-op" },
  ]);
  const deps = baseDeps({
    queryService: (service) => (service === "deploy-supervisor" ? { running: false, pid: null, lastExitCode: 0 } : { running: false, pid: null }),
  });

  const model = buildStatusBoard(tmpRoot(), ledgerPath, deps);
  const row = deploySupervisorRow(model);

  assert.equal(row.running, false); // between-tick rest — the fact the old binary render got wrong
  assert.equal(row.lastExitCode, 0);
  assert.equal(row.tickAgeMs, tickAgo);
  assert.equal(livenessState(row), "idle");

  const text = renderStatusBoardText(model);
  const supervisorLine = text.split("\n").find((l) => l.startsWith("deploy-supervisor"));
  assert.ok(supervisorLine, "expected a deploy-supervisor LIVENESS line");
  assert.match(supervisorLine!, /idle/);
  assert.doesNotMatch(supervisorLine!, /not running/);
});

// ── ACCEPTANCE 2 ─────────────────────────────────────────────────────────────────────────────

test("an interval service overdue past its window or last-exiting nonzero renders as overdue and names the exit code", () => {
  // Case A: healthy exit code, but no tick within the window — overdue by RECENCY.
  const staleLedgerPath = writeLedger([
    { run_id: "DEPLOY-1", task_id: "DEPLOY", step: "deploy.skip", ts: new Date(NOW_MS - 3 * SUPERVISOR_INTERVAL_S * 1000 - 1_000).toISOString() },
  ]);
  const staleDeps = baseDeps({
    queryService: (service) => (service === "deploy-supervisor" ? { running: false, pid: null, lastExitCode: 0 } : { running: false, pid: null }),
  });
  const staleModel = buildStatusBoard(tmpRoot(), staleLedgerPath, staleDeps);
  const staleRow = deploySupervisorRow(staleModel);
  assert.equal(livenessState(staleRow), "overdue");
  const staleText = renderStatusBoardText(staleModel).split("\n").find((l) => l.startsWith("deploy-supervisor"))!;
  assert.match(staleText, /overdue/);

  // Case B: a fresh tick, but the last completed run exited nonzero — overdue by EXIT STATUS,
  // and the render must NAME the exit code (never bury it as a generic "not running"/"overdue").
  const failedLedgerPath = writeLedger([
    { run_id: "DEPLOY-1", task_id: "DEPLOY", step: "deploy.skip", ts: new Date(NOW_MS - 10_000).toISOString() },
  ]);
  const failedDeps = baseDeps({
    queryService: (service) => (service === "deploy-supervisor" ? { running: false, pid: null, lastExitCode: 17 } : { running: false, pid: null }),
  });
  const failedModel = buildStatusBoard(tmpRoot(), failedLedgerPath, failedDeps);
  const failedRow = deploySupervisorRow(failedModel);
  assert.equal(livenessState(failedRow), "overdue");
  assert.equal(failedRow.lastExitCode, 17);
  const failedText = renderStatusBoardText(failedModel).split("\n").find((l) => l.startsWith("deploy-supervisor"))!;
  assert.match(failedText, /overdue/);
  assert.match(failedText, /17/); // the exit code itself must be named, not just "overdue"
  assert.doesNotMatch(failedText, /^deploy-supervisor.*not running/);
});

// ── ACCEPTANCE 3 ─────────────────────────────────────────────────────────────────────────────

test("a resident service is still judged by pid presence, unchanged", () => {
  // A resident service (daemon/serve) never reads its OWN "tick"/"exit code" fields at all —
  // running:false must still render "not running" even if those interval-only fields happen to
  // be set (they never will be from the real CLI wiring, but livenessState must not accidentally
  // key off them for a resident row).
  const ledgerPath = writeLedger([]);
  const deps = baseDeps({
    queryService: (service) => (service === "daemon" ? { running: true, pid: 4242 } : { running: false, pid: null }),
  });

  const model = buildStatusBoard(tmpRoot(), ledgerPath, deps);
  const daemonRow = model.liveness.services.find((s) => s.service === "daemon")!;
  const serveRow = model.liveness.services.find((s) => s.service === "serve")!;

  assert.equal(livenessState(daemonRow), "running");
  assert.equal(livenessState(serveRow), "stopped");

  const text = renderStatusBoardText(model);
  const daemonLine = text.split("\n").find((l) => l.startsWith("daemon"))!;
  const serveLine = text.split("\n").find((l) => l.startsWith("serve"))!;
  assert.match(daemonLine, /running \(pid 4242\)/);
  assert.match(serveLine, /not running/);
  assert.doesNotMatch(serveLine, /idle|overdue/); // resident services never get the interval wording
});
