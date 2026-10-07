// The console's Agent pages read /v1/operator-agent/{experiments,delegations,emergency/status}. Each one
// re-read the whole ledger union synchronously inside the request whenever its rotation memo lacked an
// archive (every cold start, and after every ~5 min rotation): 8–12 s per route on the fleet host, with
// serve's loop frozen for all of it (CPU profile, 2026-09-30). These tests drive the real routes over a
// large rotated corpus and watch the event loop while they answer.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createEmergencyStop } from "../src/lib/emergency-control.js";
import { EMERGENCY_STOP_ISSUED_LEDGER_STEP } from "../src/lib/ledger.js";
import { DELEGATION_PROFILE_LEDGER_STEP } from "../src/lib/delegation-profile.js";
import { OPERATOR_AGENT_EXPERIMENT_STEP, settleOperatorAgentUnionLoads } from "../src/lib/operator-agent.js";
import { builtProfile, READ_TOKEN, withDelegationService } from "./helpers/delegation-profile-fixture.js";
import { writeLedger, type LedgerFixture, type LedgerRotationFixture } from "./helpers/ledger-fixture.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const ARCHIVES = 80;
const LINES_PER_ARCHIVE = 10_000;
/** Longest the loop may go without a turn while a route answers. The old sync union read held it 500+ ms here. */
const LOOP_STALL_BUDGET_MS = 150;
/** Busy time a warm read after a new rotation may take: it parses that rotation and the live file, never the union. */
const WARM_ANSWER_BUDGET_MS = 150;

function filler(archive: number, line: number): Record<string, unknown> {
  return {
    ts: new Date(Date.UTC(2026, 8, 1) + archive * 3_600_000 + line * 300).toISOString(),
    step: "worker.activity",
    run_id: `RUN-${archive}-${line}`,
    task_id: `W1-T${1000 + (line % 500)}`,
    detail: { tool: "Bash", summary: "ran the scoped test file and read the result", bytes: line * 7, archive },
  };
}

function stopRow(id: string): Record<string, unknown> {
  const stop = createEmergencyStop({
    id,
    scope: "fleet",
    reason: "halt the fleet while the incident is triaged",
    issuedBy: "operator",
    issuedAt: "2026-09-20T10:00:00.000Z",
    clearPolicy: "explicit-clear-required",
    incidentReceiptId: `incident:${id}`,
  });
  return { ts: "2026-09-20T10:00:00.000Z", step: EMERGENCY_STOP_ISSUED_LEDGER_STEP, stop };
}

function experimentRow(): Record<string, unknown> {
  return {
    ts: "2026-09-20T10:00:00.000Z",
    step: OPERATOR_AGENT_EXPERIMENT_STEP,
    experiment: {
      version: "experiment-v1",
      experimentId: "experiment:repo:archived",
      proposalId: "operator-agent:repo:scale:queue-pressure",
      hypothesis: "Increasing the worker pool will reduce queue latency for the repository's worker tasks.",
      intervention: { summary: "Increase the worker pool from 2 to 4 for one observation window.", plan: "Apply the scoped worker-pool setting and restore it if the regression guard fires." },
      scope: { repo: "owner/repo", taskType: "worker", lane: "main", evidenceAnchors: ["ledger:queue-latency"] },
      baseline: {
        metricName: "queue_latency_p50",
        value: 8,
        unit: "minutes",
        denominator: 20,
        comparisonPopulation: "owner/repo worker tasks on main",
        windowStart: "2026-09-18T10:00:00.000Z",
        windowEnd: "2026-09-20T10:00:00.000Z",
        source: "ledger:queue-latency",
        freshness: "verified",
      },
      rollback: { plan: "Restore worker pool size to 2 and record the deployment receipt.", reason: "Rollback if queue latency regresses.", receipt: "change:worker-pool-restore" },
      createdAt: "2026-09-20T10:00:00.000Z",
      state: "proposed",
    },
  };
}

function archive(index: number, extra: Array<Record<string, unknown>> = []): LedgerRotationFixture {
  const rows = Array.from({ length: LINES_PER_ARCHIVE }, (_, line) => filler(index, line));
  return { at: new Date(Date.UTC(2026, 8, 1) + index * 3_600_000).toISOString(), rows: [...rows, ...extra], gz: true };
}

function writeArchives(count: number, make: (index: number) => LedgerRotationFixture = archive, write: typeof writeLedger = writeLedger): LedgerFixture {
  const ledger = write();
  // Release each archive's input rows before constructing the next; the on-disk corpus is unchanged.
  for (let i = 0; i < count; i++) write([], { dir: ledger.dir, rotations: [make(i)] });
  return ledger;
}

test("rotated scan fixtures write each archive before generating the next archive's rows", () => {
  const order: string[] = [];
  const ledger: LedgerFixture = { dir: "/fixture-only/owned", path: "/fixture-only/owned/ledger.ndjson", append() {} };
  const result = writeArchives(3, (i) => {
    order.push(`make:${i}`);
    return { at: new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString(), rows: [{ archive: i }], gz: true };
  }, (rows = [], opts = {}) => {
    assert.deepEqual(rows, []);
    if (opts.rotations === undefined) order.push("ledger:create");
    else {
      assert.equal(opts.dir, ledger.dir);
      assert.equal(opts.rotations.length, 1, "only one archive's input rows may be live at the writer");
      order.push(`write:${opts.rotations[0]!.rows[0]!.archive}`);
    }
    return ledger;
  });
  assert.equal(result, ledger);
  assert.deepEqual(order, ["ledger:create", "make:0", "write:0", "make:1", "write:1", "make:2", "write:2"]);
});

test("incremental scan fixtures preserve every native gzip archive and live-ledger byte", () => {
  const make = (i: number): LedgerRotationFixture => archive(i, i === 1 ? [stopRow("fixture-byte-control")] : []);
  const bulk = writeLedger([], { rotations: Array.from({ length: 3 }, (_, i) => make(i)) });
  const incremental = writeArchives(3, make);
  const names = readdirSync(bulk.dir).sort();
  assert.equal(names.filter((name) => name.endsWith(".ndjson.gz")).length, 3, "positive control: all three rotations exist");
  assert.deepEqual(readdirSync(incremental.dir).sort(), names);
  for (const name of names) assert.deepEqual(readFileSync(join(incremental.dir, name)), readFileSync(join(bulk.dir, name)), name);
});

/** How much CPU this thread spent between two 5 ms ticks at most (`stallMs`), and in total (`busyMs`), while `work` ran:
 *  the longest block of work that kept the loop from turning. Wall-clock tick gaps, and event-loop utilization too, also
 *  count time the OS took the thread away, so a CPU-starved CI runner read a healthy chunked route as a 150+ ms stall
 *  (#9871: 158 ms; 217 ms measured under 12-way contention). Thread CPU time is what a synchronous union read inflates:
 *  500+ ms in one block, whatever the host's load. */
function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

async function longestLoopStall<T>(work: () => Promise<T>): Promise<{ value: T; stallMs: number; busyMs: number; elapsedMs: number }> {
  const startCpu = threadCpuMs();
  let lastCpu = startCpu;
  let stallMs = 0;
  const probe = setInterval(() => {
    const now = threadCpuMs();
    stallMs = Math.max(stallMs, now - lastCpu);
    lastCpu = now;
  }, 5);
  const started = performance.now();
  try {
    const value = await work();
    const end = threadCpuMs();
    stallMs = Math.max(stallMs, end - lastCpu);
    return { value, stallMs, busyMs: end - startCpu, elapsedMs: performance.now() - started };
  } finally {
    clearInterval(probe);
  }
}

async function read(base: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
  assert.equal(res.status, 200, path);
  return (await res.json()) as Record<string, unknown>;
}

const COLD_ROUTES: Array<{ path: string; answered: (body: Record<string, unknown>) => unknown; expected: unknown }> = [
  { path: "/v1/operator-agent/experiments", answered: (body) => (body.experiments as Array<{ experimentId: string }>).map((e) => e.experimentId), expected: ["experiment:repo:archived"] },
  { path: "/v1/operator-agent/delegations", answered: (body) => (body.profiles as unknown[]).length, expected: 1 },
  { path: "/v1/operator-agent/emergency/status", answered: (body) => (body.active as Array<{ id: string }>).map((s) => s.id), expected: ["stop-archived"] },
];

test("each operator-agent scan route answers a cold large corpus without holding the event loop", async () => {
  const template = writeArchives(ARCHIVES, (i) => archive(i, i === 3 ? [experimentRow(), stopRow("stop-archived")] :
    i === 7 ? [{ ts: "2026-09-20T10:00:00.000Z", step: DELEGATION_PROFILE_LEDGER_STEP, profile: builtProfile() }] : []));
  assert.equal(readdirSync(template.dir).filter((name) => name.endsWith(".ndjson.gz")).length, ARCHIVES, "every real rotation remains in the cold corpus");
  for (const route of COLD_ROUTES) {
    // A state dir of its own, so every route meets the corpus cold.
    const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}oa-scan-`));
    cpSync(template.dir, dir, { recursive: true });
    await withDelegationService(join(dir, "ledger.ndjson"), async (base) => {
      const cold = await longestLoopStall(() => read(base, route.path));
      assert.deepEqual(route.answered(cold.value), route.expected, `${route.path} answers every archived row`);
      assertWallClockBound(cold.stallMs, LOOP_STALL_BUDGET_MS, `a cold ${route.path} read held the loop ${Math.round(cold.stallMs)} ms`);
    });
  }
  await settleOperatorAgentUnionLoads();
});

test("after a rotation lands the emergency status answers within budget and sees the new stop", async () => {
  const ledger = writeArchives(ARCHIVES);
  await withDelegationService(ledger.path, async (base) => {
    await read(base, "/v1/operator-agent/emergency/status");
    writeLedger([], { dir: ledger.dir, rotations: [archive(ARCHIVES, [stopRow("stop-rotated")])] });
    const warm = await longestLoopStall(() => read(base, "/v1/operator-agent/emergency/status"));
    assert.deepEqual((warm.value.active as Array<{ id: string }>).map((s) => s.id), ["stop-rotated"], "the new rotation's stop is active");
    assertWallClockBound(warm.busyMs, WARM_ANSWER_BUDGET_MS, `the read after a rotation spent ${Math.round(warm.busyMs)} ms of loop CPU (${Math.round(warm.elapsedMs)} ms elapsed)`);
    assertWallClockBound(warm.stallMs, LOOP_STALL_BUDGET_MS, `the read after a rotation held the loop ${Math.round(warm.stallMs)} ms`);
  });
  await settleOperatorAgentUnionLoads();
});

test("time the OS takes the thread away is not counted as the loop being held", async () => {
  // A deterministic stand-in for a CPU-starved runner: a child stops this whole process for 200 ms, then resumes it.
  const paused = await longestLoopStall(() =>
    promisify(execFile)("sh", ["-c", `kill -STOP ${process.pid}; sleep 0.2; kill -CONT ${process.pid}`]));
  assert.ok(paused.elapsedMs >= 190, `control: the process really was stopped (${Math.round(paused.elapsedMs)} ms elapsed)`);
  assertWallClockBound(paused.stallMs, 50, `a stopped, idle thread read as holding the loop ${Math.round(paused.stallMs)} ms`);
});
