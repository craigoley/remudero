import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import "#src/lib/live-analytics-snapshot-cache.js";
import { fixedClock } from "#src/lib/clock.js";
import { daemonBoot, runDaemon, type DaemonDeps, type OpsTaskDispatchRead } from "#src/lib/daemon.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import { runnableCandidates } from "#src/lib/drain.js";
import { appendLedger, MAX_RETAINED_LINES_PER_STEP, rotateLedger, type LedgerLine } from "#src/lib/ledger.js";
import { mergePlanBlobs, type Plan, type Task } from "#src/lib/plan.js";
import { composeSecondaryPlan } from "#src/lib/task-lookup.js";

const HOLD = "dispatch.ops_catalog_held";
const PRIVATE_VALUE = "private value / fixture";
const PUBLIC_COMMIT = "a".repeat(40);
const OPS_COMMIT = "b".repeat(40);
const NOW = Date.parse("2026-01-01T00:00:00Z");
type Row = { step: string; data: Record<string, unknown> };

function plan(...ids: string[]): Plan {
  return mergePlanBlobs([{ label: "fixture", text: JSON.stringify(ids.map(id => ({
    id, title: id, repo: "remudero", type: "implement",
  }))) }]);
}

function selected(ops: Plan, publicCommit = PUBLIC_COMMIT, opsCommit = OPS_COMMIT): OpsTaskDispatchRead {
  return { outcome: "selected", publicCommit, source: { outcome: "ok", plan: ops, opsCommit, identityDigest: "c".repeat(64) } };
}

function setField(task: Task, field: string, value: unknown): void {
  Object.assign(task, { [field]: value });
}

async function dispatch(primary: Plan, read: (completed: number) => OpsTaskDispatchRead, log?: DaemonDeps["log"]) {
  const ran: string[] = [];
  const merged = new Set<string>();
  const rows: Row[] = [];
  let sleeps = 0;
  const summary = await runDaemon(primary, {
    targetRepo: "remudero",
    refreshMerged: () => id => merged.has(id),
    runOne: async id => {
      ran.push(id);
      merged.add(id);
      return { taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" };
    },
    checkPause: () => undefined,
    checkStop: () => sleeps > 8 ? "fixture stop" : undefined,
    sleep: async () => { sleeps++; },
    now: fixedClock(NOW).date,
    bootCheckoutBlocked: "",
    memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), heapUsed: () => 1, setFlags: () => {} }),
    heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
    log: (step, data = {}) => {
      rows.push({ step, data });
      log?.(step, data);
    },
    readOpsTaskDispatch: () => read(ran.length),
  }, { max: primary.tasks.length + 1, laneCount: 1 });
  return { ran, summary, held: rows.filter(row => row.step === HOLD).map(row => row.data) };
}

test("W1-T13461 criterion 1: the first malformed record is named by id, field and side", async () => {
  const fields = new Map<string, unknown>([
    ["title", { secret: PRIVATE_VALUE }], ["repo", 42], ["depends_on", [42]], ["type", PRIVATE_VALUE],
    ["risk", PRIVATE_VALUE], ["status", PRIVATE_VALUE], ["verify", { proof: PRIVATE_VALUE }],
    ["dispatch_hold", PRIVATE_VALUE], ["priority", PRIVATE_VALUE],
  ]);
  for (const [field, value] of fields) {
    const bad = plan("OPS-T1", "OPS-T2");
    setField(bad.tasks[0]!, field, value);
    setField(bad.tasks[1]!, "verify", { proof: PRIVATE_VALUE });
    assert.deepEqual(composeSecondaryPlan(plan(), bad), { outcome: "malformed", taskId: "OPS-T1", field, side: "secondary" });
  }
  const badId = plan("OPS-T1");
  setField(badId.tasks[0]!, "id", { secret: PRIVATE_VALUE });
  assert.deepEqual(composeSecondaryPlan(plan(), badId),
    { outcome: "malformed", taskId: "OPS-T1", field: "id", side: "secondary" });
  const unsafeId = { ...badId, byId: new Map([[PRIVATE_VALUE, badId.tasks[0]!]]) };
  assert.deepEqual(composeSecondaryPlan(plan(), unsafeId), { outcome: "malformed", field: "id", side: "secondary" });

  const primary = plan("PUBLIC-T1", "PUBLIC-T2");
  primary.tasks[0]!.status = "blocked";
  primary.tasks[0]!.retirement = "withdrawn";
  setField(primary.tasks[0]!, "verify", { proof: PRIVATE_VALUE });
  const secondary = plan("OPS-T1");
  setField(secondary.tasks[0]!, "title", { secret: PRIVATE_VALUE });
  assert.deepEqual(composeSecondaryPlan(primary, secondary),
    { outcome: "malformed", taskId: "PUBLIC-T1", field: "verify", side: "primary" });
  const result = await dispatch(primary, () => selected(secondary));
  assert.deepEqual(result.held, [{ outcome: "malformed", task_id: "PUBLIC-T1", field: "verify", side: "primary" }]);
  assert.doesNotMatch(JSON.stringify(result.held), /private value/);

  const badIndex = { ...primary, byId: new Map<string, Task>() };
  const duplicate = plan("OPS-T1", "OPS-T2");
  duplicate.tasks[1]!.id = duplicate.tasks[0]!.id;
  const badDate = plan("OPS-T1");
  badDate.tasks[0]!.not_before = PRIVATE_VALUE;
  const getter = plan("OPS-T1");
  Object.defineProperty(getter.tasks[0], "title", { get() { throw new Error(PRIVATE_VALUE); } });
  for (const bad of [badIndex, duplicate, badDate, getter]) {
    assert.deepEqual(composeSecondaryPlan(plan(), bad), { outcome: "malformed" });
  }
});

test("W1-T13461 criterion 2: advancing either observed commit writes the persistent hold again", async () => {
  const primary = plan("PUBLIC-T1", "PUBLIC-T2", "PUBLIC-T3", "PUBLIC-T4", "PUBLIC-T5");
  setField(primary.tasks[0]!, "verify", { proof: PRIVATE_VALUE });
  primary.tasks[0]!.status = "blocked";
  primary.tasks[0]!.retirement = "withdrawn";
  const secondary = plan("OPS-T1");
  const result = await dispatch(primary, completed => selected(secondary,
    completed < 2 ? PUBLIC_COMMIT : "d".repeat(40),
    completed < 3 ? OPS_COMMIT : "e".repeat(40)));
  assert.deepEqual(result.ran, ["PUBLIC-T2", "PUBLIC-T3", "PUBLIC-T4", "PUBLIC-T5"]);
  assert.equal(result.held.length, 3, "one write at first hold, one after each revision change");
  assert.deepEqual(result.held, Array.from({ length: 3 }, () => ({
    outcome: "malformed", task_id: "PUBLIC-T1", field: "verify", side: "primary",
  })));

  const unkeyed = await dispatch(plan("PUBLIC-T1", "PUBLIC-T2"), () => ({
    outcome: "selected", publicCommit: PUBLIC_COMMIT,
    source: { outcome: "stale", refusalStage: "root_tree", get opsCommit(): string { throw new Error(PRIVATE_VALUE); } },
  }));
  assert.deepEqual(unkeyed.ran, ["PUBLIC-T1", "PUBLIC-T2"]);
  assert.deepEqual(unkeyed.held, [{ outcome: "stale", refusal_stage: "root_tree" }]);
});

function records(text: string): LedgerLine[] {
  return text.trim().split("\n").map(line => JSON.parse(line) as LedgerLine);
}

test("W1-T13461 criterion 3: rotation retains the newest hold of each surviving boot", async t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-ops-hold-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.ndjson");
  for (const [runId, started] of [["DAEMON-expired", NOW - 3_600_000], ["DAEMON-first", NOW - 9_000], ["DAEMON-second", NOW - 4_000]] as const) {
    let at = started;
    const log: NonNullable<DaemonDeps["log"]> = (step, data) => {
      appendLedger(path, { run_id: runId, task_id: "DAEMON", lane: "daemon", step, ...data }, { clock: fixedClock(at++) });
    };
    await daemonBoot(log, { RMD_SPAWN_HELPER: "off" });
    const run = await dispatch(plan("PUBLIC-T1", "PUBLIC-T2"), completed => ({
      outcome: "unavailable", reason: completed === 0 ? "source_pending" : "stale",
    }), log);
    assert.equal(run.held.length, 2);
  }
  const before = records(readFileSync(path, "utf8"));
  const boots = before.filter(row => row.step === "daemon.boot").map(row => row.run_id);
  assert.deepEqual(before.filter(row => row.step === HOLD).map(row => row.run_id), boots.flatMap(id => [id, id]));
  const rotated = rotateLedger(path, { ceilingBytes: statSync(path).size - 1, now: fixedClock(NOW).date, smoothingWindowMs: 0 });
  assert.equal(rotated.rotated, true);
  const live = records(readFileSync(path, "utf8"));
  const survivingBoots = live.filter(row => row.step === "daemon.boot").map(row => row.run_id);
  assert.deepEqual(survivingBoots, ["DAEMON-first", "DAEMON-second"]);
  assert.deepEqual(live.filter(row => row.step === HOLD).map(row => [row.run_id, row.outcome]),
    survivingBoots.map(id => [id, "stale"]));
  assert.ok(rotated.archivePath);
  const archive = readFileSync(rotated.archivePath);
  const archived = records((rotated.archivePath.endsWith(".gz") ? gunzipSync(archive) : archive).toString("utf8"));
  assert.deepEqual(archived.filter(row => row.step === HOLD && row.outcome === "source_pending").map(row => row.run_id), boots);
});

test("W1-T13461 criterion 4: hold evidence is bounded and dispatch uses the same candidates", async () => {
  const primary = plan("PUBLIC-T1", "PUBLIC-T2", "PUBLIC-T3");
  const healthy = plan("OPS-T1");
  const result = composeSecondaryPlan(primary, healthy);
  assert.equal(result.outcome, "ok");
  const expected = new Set(["PUBLIC-T1", "PUBLIC-T2", "PUBLIC-T3", "OPS-T1"]);
  assert.deepEqual(new Set(result.plan.tasks.map(task => task.id)), expected);
  assert.deepEqual(new Set(runnableCandidates(result.plan, () => false, 4).map(task => task.id)), expected);
  const composed = await dispatch(primary, () => selected(healthy));
  assert.deepEqual(new Set(composed.ran), expected);
  assert.deepEqual(composed.held, []);

  const bad = plan("OPS-T1", "OPS-T2");
  const baseline = await dispatch(primary, () => ({ outcome: "off" }));
  const held = await dispatch(primary, completed => {
    setField(bad.tasks[0]!, "verify", completed < 2 ? { proof: PRIVATE_VALUE } : "auto");
    setField(bad.tasks[1]!, "verify", { proof: PRIVATE_VALUE });
    return selected(bad);
  });
  assert.deepEqual(held.ran, baseline.ran);
  assert.deepEqual(held.summary.attempted, baseline.summary.attempted);
  assert.deepEqual(held.summary.merged, baseline.summary.merged);
  assert.deepEqual(held.held, ["OPS-T1", "OPS-T2"].map(task_id => ({ outcome: "malformed", task_id, field: "verify", side: "secondary" })));
});

test("W1-T13461 criterion 3: per-boot holds survive the per-step cap and leave with shed boots", t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-ops-hold-ceiling-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.ndjson");
  const bootCount = MAX_RETAINED_LINES_PER_STEP + 1;
  const rows = Array.from({ length: bootCount }, (_, index) => {
    const run_id = `DAEMON-${index}`;
    const row = (step: string, offset: number) => JSON.stringify({
      ts: new Date(NOW - 10_000 + index * 10 + offset).toISOString(), run_id, task_id: "DAEMON", step,
    });
    return [row("daemon.boot", 0), row(HOLD, 1), row(HOLD, 2), row("fixture.noise", 3)];
  });
  writeFileSync(path, rows.flat().join("\n") + "\n");
  const rotate = (ceilingBytes: number) => {
    assert.equal(rotateLedger(path, { ceilingBytes, now: fixedClock(NOW).date, smoothingWindowMs: 0 }).rotated, true);
    const live = records(readFileSync(path, "utf8"));
    const starts = live.filter(row => row.step === "daemon.boot").map(row => row.run_id);
    assert.deepEqual(live.filter(row => row.step === HOLD).map(row => row.run_id), starts);
    return starts;
  };
  assert.equal(rotate(statSync(path).size - 1).length, bootCount);
  const ceiling = Math.floor(statSync(path).size / 2);
  const surviving = rotate(ceiling);
  assert.ok(surviving.length > 0 && surviving.length < bootCount);
  assert.ok(statSync(path).size < ceiling);
});
