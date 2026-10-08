// The console's Agent pages read /v1/operator-agent/{experiments,delegations,emergency/status}. Each one
// re-read the whole ledger union synchronously inside the request whenever its rotation memo lacked an
// archive (every cold start, and after every ~5 min rotation): 8–12 s per route on the fleet host, with
// serve's loop frozen for all of it (CPU profile, 2026-09-30). These tests drive the real routes over a
// large rotated corpus and watch the event loop while they answer.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
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
// ── W1-T6402: the post-rotation read is bounded RELATIVE to its own runner ─────────────────────────────────────────
// A warm read after a new rotation parses that rotation and the live file, never the union. Bounding its loop CPU by a
// fixed 150 ms red healthy PRs on a loaded CI runner (#10058 158.6 ms, #10077, #10089, #10084 152.3 ms after W1-T6337's
// fix; every retry red too). Runner load inflates every read on the thread alike, so the bound is now a RATIO to a
// baseline measured moments earlier in the same process: the median loop CPU of ROTATION_BASELINE_READS warm reads of
// the same route on the same service. A real regression — a rotation that re-reads the corpus — multiplies the subject
// alone. ROTATION_READ_CEILING_MS stays as the catastrophic guard, declared through assertWallClockBound (W1-T2811).
//
// MEASURED 2026-10-08 on a 10-core Mac (node v24.21.0), subject ÷ median(9 baseline reads), 23 runs:
//   idle (11 runs):              healthy ratio 22–51 (median 30); subject 25–47 ms; baseline median 0.8–1.6 ms
//   10 CPU burners (6 runs):     healthy ratio 21–57;  subject 41–98 ms (the fixed 150 ms budget's headroom gone)
//   20 CPU burners (6 runs):     healthy ratio 22–61;  subject 52–85 ms
//   injected full-corpus re-read on the subject alone (same 23 runs): ratio 194–546 (re-read 393–689 ms of CPU)
// R = 120 sits ~2× above the worst healthy ratio (61) and ~1.6× below the mildest regression (194); K = 9 because a
// warm read costs ~1 ms, so a median over nine is cheap and steadies the small denominator.
const ROTATION_BASELINE_READS = 9;
const ROTATION_READ_RATIO = 120;
/** The catastrophic tier: far above any healthy run (98 ms worst measured locally, 159 ms worst on CI). */
const ROTATION_READ_CEILING_MS = 1000;
/** The fixed budget W1-T6402 retired; kept so the acceptance test can show it reds a healthy read on a slower runner. */
const RETIRED_FIXED_BUDGET_MS = 150;

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

type Work<T> = () => Promise<T>;
type WorkWrapper = <T>(work: Work<T>) => Promise<T>;
const EMERGENCY_STATUS = "/v1/operator-agent/emergency/status";

/** A runner `factor`× slower: after `work` finishes, spin this thread for (factor − 1)× the CPU the work itself took. */
async function withCpuTax<T>(factor: number, work: Work<T>): Promise<T> {
  const start = threadCpuMs();
  const value = await work();
  const until = start + (threadCpuMs() - start) * factor;
  while (threadCpuMs() < until) { /* the tax */ }
  return value;
}

/** The regression the relative bound must catch: decode and parse every archive in `dir` on this thread. */
function rereadCorpus(dir: string): number {
  let rows = 0;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".ndjson.gz"))) {
    for (const line of gunzipSync(readFileSync(join(dir, name))).toString("utf8").split("\n")) {
      if (line) { JSON.parse(line); rows += 1; }
    }
  }
  return rows;
}

/** Measure ROTATION_BASELINE_READS warm reads, land rotation `index` carrying stop `stopId`, then measure the read
 *  after it. `everyRead` wraps baseline and subject alike (a uniform tax); `subjectOnly` wraps the subject alone. */
async function measureRotationRead(
  base: string,
  ledger: LedgerFixture,
  index: number,
  stopId: string,
  everyRead: WorkWrapper = (work) => work(),
  subjectOnly: WorkWrapper = (work) => work(),
): Promise<{ baselineMs: number[]; subjectMs: number; stallMs: number; elapsedMs: number; activeStops: string[] }> {
  const baselineMs: number[] = [];
  for (let i = 0; i < ROTATION_BASELINE_READS; i++) {
    baselineMs.push((await longestLoopStall(() => everyRead(() => read(base, EMERGENCY_STATUS)))).busyMs);
  }
  writeLedger([], { dir: ledger.dir, rotations: [archive(index, [stopRow(stopId)])] });
  const subject = await longestLoopStall(() => subjectOnly(() => everyRead(() => read(base, EMERGENCY_STATUS))));
  const activeStops = (subject.value.active as Array<{ id: string }>).map((s) => s.id);
  assert.ok(activeStops.includes(stopId), `the new rotation's stop ${stopId} is active`);
  return { baselineMs, subjectMs: subject.busyMs, stallMs: subject.stallMs, elapsedMs: subject.elapsedMs, activeStops };
}

interface RotationReadVerdict { baselineMedianMs: number; subjectMs: number; ratio: number; withinRatio: boolean; underCeiling: boolean }

function judgeRotationRead(baselineMs: readonly number[], subjectMs: number): RotationReadVerdict {
  assert.equal(baselineMs.length, ROTATION_BASELINE_READS, "the relative bound needs its full same-run baseline");
  const sorted = [...baselineMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Thread CPU has microsecond resolution; the floor only keeps a zero reading from dividing by zero.
  const baselineMedianMs = Math.max(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2, 0.001);
  const ratio = subjectMs / baselineMedianMs;
  return { baselineMedianMs, subjectMs, ratio, withinRatio: ratio <= ROTATION_READ_RATIO, underCeiling: subjectMs < ROTATION_READ_CEILING_MS };
}

function describeVerdict(v: RotationReadVerdict): string {
  return `subject ${v.subjectMs.toFixed(1)} ms of loop CPU is ${v.ratio.toFixed(1)}× the same-run baseline median ` +
    `${v.baselineMedianMs.toFixed(2)} ms (bound ${ROTATION_READ_RATIO}×, ceiling ${ROTATION_READ_CEILING_MS} ms)`;
}

test("after a rotation lands the emergency status answers within budget and sees the new stop", async (t) => {
  const ledger = writeArchives(ARCHIVES);
  await withDelegationService(ledger.path, async (base) => {
    await read(base, EMERGENCY_STATUS);
    const warm = await measureRotationRead(base, ledger, ARCHIVES, "stop-rotated");
    assert.deepEqual(warm.activeStops, ["stop-rotated"], "the new rotation's stop is active");
    const verdict = judgeRotationRead(warm.baselineMs, warm.subjectMs);
    // Recorded on every run, so CI's own ratio distribution is readable from its logs.
    t.diagnostic(`W1-T6402 rotation read: ${describeVerdict(verdict)}; baseline ${warm.baselineMs.map((ms) => ms.toFixed(1)).join(",")}`);
    assert.ok(verdict.withinRatio, `the read after a rotation outgrew its same-run baseline: ${describeVerdict(verdict)}`);
    assertWallClockBound(warm.subjectMs, ROTATION_READ_CEILING_MS, `the read after a rotation spent ${Math.round(warm.subjectMs)} ms of loop CPU (${Math.round(warm.elapsedMs)} ms elapsed)`);
    assertWallClockBound(warm.stallMs, LOOP_STALL_BUDGET_MS, `the read after a rotation held the loop ${Math.round(warm.stallMs)} ms`);
  });
  await settleOperatorAgentUnionLoads();
});

test("W1-T6402: a rotation read is bounded by a same-run baseline, and a re-read of the corpus still fails", async (t) => {
  const ledger = writeArchives(ARCHIVES);
  await withDelegationService(ledger.path, async (base) => {
    await read(base, "/v1/operator-agent/emergency/status");

    // Positive control: a healthy post-rotation read, untaxed, passes the relative bound and the ceiling.
    const healthy = await measureRotationRead(base, ledger, ARCHIVES, "stop-healthy");
    const healthyVerdict = judgeRotationRead(healthy.baselineMs, healthy.subjectMs);
    assert.ok(healthyVerdict.withinRatio && healthyVerdict.underCeiling, `control: a healthy rotation read passes — ${describeVerdict(healthyVerdict)}`);

    // A runner `factor`× slower taxes the baseline and the subject alike. The factor is sized from the healthy read so
    // the taxed subject lands near 3× the retired fixed budget on any runner, fast or slow.
    const factor = Math.max(2, Math.ceil((3 * RETIRED_FIXED_BUDGET_MS) / Math.max(healthy.subjectMs, 1)));
    const taxed = await measureRotationRead(base, ledger, ARCHIVES + 1, "stop-taxed", (work) => withCpuTax(factor, work));
    const taxedVerdict = judgeRotationRead(taxed.baselineMs, taxed.subjectMs);
    assert.throws(
      () => assertWallClockBound(taxed.subjectMs, RETIRED_FIXED_BUDGET_MS, `a ${factor}× slower runner's rotation read spent ${Math.round(taxed.subjectMs)} ms`),
      /WALL-CLOCK DEPENDENT/,
      `the retired fixed ${RETIRED_FIXED_BUDGET_MS} ms budget reds a healthy read on a ${factor}× slower runner (${Math.round(taxed.subjectMs)} ms)`,
    );
    assert.ok(taxedVerdict.withinRatio, `a uniform ${factor}× CPU tax cancels against the same-run baseline — ${describeVerdict(taxedVerdict)}`);

    // A real regression: the read after the rotation re-reads every archive on the loop thread. The baseline is untouched.
    const reread = await measureRotationRead(base, ledger, ARCHIVES + 2, "stop-reread", undefined, async (work) => {
      const value = await work();
      rereadCorpus(ledger.dir);
      return value;
    });
    const rereadVerdict = judgeRotationRead(reread.baselineMs, reread.subjectMs);
    t.diagnostic(`healthy: ${describeVerdict(healthyVerdict)}`);
    t.diagnostic(`${factor}× taxed: ${describeVerdict(taxedVerdict)}`);
    t.diagnostic(`corpus re-read: ${describeVerdict(rereadVerdict)}`);
    assert.equal(rereadVerdict.withinRatio, false, `a post-rotation read that re-reads the corpus must fail the relative bound — ${describeVerdict(rereadVerdict)}`);
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
