import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { restartWorkHistory, runDaemon, type DaemonDeps, type DaemonFreshness } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";
import { readRestartHistoryLines } from "../src/run-task.js";

const minute = 60_000;
const epoch = Date.parse("2026-10-12T23:13:00Z");
const stale: Extract<DaemonFreshness, { stale: true }> = {
  stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  changes: [{ sha: "b".repeat(40), subject: "fix: update worker", files: ["src/lib/worker.ts"] }],
  staleSinceMs: epoch - 120 * minute,
};

function history() {
  const rows: string[] = [];
  const add = (age: number, fields: Record<string, unknown>) => rows.push(JSON.stringify({
    ts: new Date(epoch - age * minute).toISOString(), ...fields,
  }));
  for (const [n, gap] of [60, 62, 64].entries()) {
    add(180, { step: "verdict", task_id: `yield-${n}`, run_id: `old-${n}`, reason: "freshness_yield" });
    add(180 - gap, { step: "run.start", task_id: `yield-${n}`, run_id: `new-${n}`, type: "implement" });
  }
  for (const [n, remaining] of [4, 5, 6].entries()) {
    add(100, { step: "run.phase", waiting_on: "preopen_gate", task_id: `near-${n}`, run_id: `near-${n}` });
    add(100 - remaining, { step: "pr.opened", task_id: `near-${n}`, run_id: `near-${n}` });
    add(100, { step: "run.phase", waiting_on: "implementing", task_id: `far-${n}`, run_id: `far-${n}` });
    add(100 - 62, { step: "pr.opened", task_id: `far-${n}`, run_id: `far-${n}` });
    add(100, { step: "run.phase", waiting_on: "pushing", task_id: `push-${n}`, run_id: `push-${n}` });
    add(97, { step: "pr.opened", task_id: `push-${n}`, run_id: `push-${n}` });
  }
  return rows.reverse(); // Archive ordering must not change the measurements.
}

async function rig(options: { rows?: string[]; unreadable?: boolean; self?: "path" | "scope" | "install" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t8927-"));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "- id: W1-T8825\n  title: holdout replay\n  repo: remudero\n  type: implement\n  status: queued\n  files: [src/fixture.ts]\n");
  let now = epoch;
  let latched = false;
  let finish!: (result: RunResult) => void;
  let boundary!: NonNullable<Parameters<DaemonDeps["runOne"]>[1]>["restartAtWorkerBoundary"];
  const sleeps: Array<() => void> = [];
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const freshness = options.self ? { ...stale, changes: [{ sha: stale.newSha,
    subject: options.self === "scope" ? "fix(daemon): refresh loop" : "fix: refresh loop",
    files: options.self === "path" ? ["src/lib/daemon.ts"] : options.self === "install" ? ["package-lock.json"] : ["src/lib/worker.ts"],
  }] } : stale;
  const run = runDaemon(loadPlan(path), {
    now: () => new Date(now), refreshMerged: () => () => false,
    checkFreshness: () => latched ? freshness : { stale: false },
    readLedgerLines: () => [],
    readRestartHistory: () => { if (options.unreadable) throw new Error("history unavailable"); return options.rows ?? history(); },
    runOne: (_id, opts) => { boundary = opts!.restartAtWorkerBoundary; return new Promise((resolve) => { finish = resolve; }); },
    log: (step, fields) => rows.push({ step, fields: fields ?? {} }),
    sleep: () => new Promise<void>((resolve) => sleeps.push(resolve)),
  } as DaemonDeps, { laneCount: 1, max: 1 });
  await flush();
  latched = true;
  now += 5 * minute;
  sleeps.shift()?.();
  await flush();
  await flush();
  assert.ok(rows.some((row) => row.step === "daemon.freshness_decision" && row.fields.action === "restart"));
  return {
    rows,
    boundary: (waitingOn: string) => boundary({ waitingOn, runId: "W1-T8825-replay" }),
    advance: (minutes: number) => { now += minutes * minute; },
    close: async () => {
      finish({ taskId: "W1-T8825", runId: "W1-T8825-replay", merged: false, verdict: "handed_off", costUsd: 0,
        prUrl: "https://github.com/acme/remudero/pull/1" });
      await run;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("W1-T8927: a run near its PR is a holdout, not asked to yield", async () => {
  const h = await rig();
  try {
    assert.equal(h.boundary("preopen_gate"), undefined);
    const decision = h.rows.find((row) => row.step === "daemon.restart_holdout");
    assert.ok(decision);
    assert.equal(decision.fields.task_id, "W1-T8825");
    assert.equal(decision.fields.run_id, "W1-T8825-replay");
    assert.equal(decision.fields.phase, "preopen_gate");
    assert.equal(decision.fields.remaining_ms, 5 * minute);
    assert.equal(decision.fields.yield_cost_ms, 62 * minute);
    assert.equal(decision.fields.remaining_samples, 3);
    assert.equal(decision.fields.yield_samples, 3);
    h.advance(4);
    assert.equal(h.boundary("preopen_gate"), undefined);
    assert.equal(h.rows.some((row) => row.step === "daemon.restart_yield_asked"), false);
  } finally { await h.close(); }
});

test("W1-T8927: a run far from its PR or past its estimate still yields", async () => {
  for (const phase of ["implementing", "preopen_gate"]) {
    const h = await rig();
    try {
      if (phase === "preopen_gate") {
        assert.equal(h.boundary(phase), undefined);
        h.advance(5);
      }
      assert.equal(h.boundary(phase), stale);
      const decision = h.rows.findLast((row) => row.step === "daemon.restart_yield_asked");
      assert.ok(decision);
      assert.equal(decision.fields.reason, phase === "implementing" ? "yield_is_cheaper" : "estimate_elapsed");
      assert.equal(decision.fields.phase, phase);
      assert.equal(decision.fields.remaining_ms, (phase === "implementing" ? 62 : 5) * minute);
      assert.equal(decision.fields.yield_cost_ms, 62 * minute);
      assert.equal(decision.fields.remaining_samples, 3);
      assert.equal(decision.fields.yield_samples, 3);
      h.advance(1);
      assert.equal(h.boundary("preopen_gate"), stale, "a yielded lane cannot regain a holdout");
    } finally { await h.close(); }
  }
});

test("W1-T8927: no history or a self-scoped change keeps every run yielding", async () => {
  for (const opts of [{ rows: [] }, { rows: ["torn", "null"] }, { unreadable: true },
    { rows: history().filter((raw) => JSON.parse(raw).step === "run.phase" || JSON.parse(raw).step === "pr.opened") },
    { rows: history().filter((raw) => JSON.parse(raw).step === "verdict" || JSON.parse(raw).step === "run.start") },
    { self: "path" as const }, { self: "scope" as const }, { self: "install" as const }]) {
    const h = await rig(opts);
    try {
      assert.ok(h.boundary("preopen_gate"));
      assert.equal(h.rows.some((row) => row.step === "daemon.restart_holdout"), false);
      const decision = h.rows.find((row) => row.step === "daemon.restart_yield_asked");
      assert.ok(decision);
      assert.equal(decision.fields.reason, "self" in opts ? "self_scoped_change" : "no_history");
    } finally { await h.close(); }
  }
});

test("W1-T8927: an unmeasured phase yields even when other phases have cheap remaining work", async () => {
  const h = await rig();
  try {
    assert.equal(h.boundary("recon"), stale);
    const decision = h.rows.find((row) => row.step === "daemon.restart_yield_asked");
    assert.ok(decision);
    assert.equal(decision.fields.phase, "recon");
    assert.equal(decision.fields.reason, "no_history");
    assert.equal(decision.fields.remaining_ms, null);
    assert.equal(decision.fields.remaining_samples, 0);
    assert.equal(decision.fields.yield_cost_ms, 62 * minute);
    assert.equal(decision.fields.yield_samples, 3);
    assert.equal(h.boundary("preopen_gate"), stale);
  } finally { await h.close(); }
});

test("W1-T8927: a later phase cannot extend the original holdout deadline", async () => {
  const h = await rig();
  try {
    assert.equal(h.boundary("preopen_gate"), undefined);
    h.advance(4);
    assert.equal(h.boundary("pushing"), undefined);
    h.advance(1);
    assert.equal(h.boundary("pushing"), stale);
    assert.equal(h.rows.findLast((row) => row.step === "daemon.restart_yield_asked")?.fields.deadline_ms,
      epoch + 10 * minute);
  } finally { await h.close(); }
});

test("W1-T8927: only paired recent observations contribute to restart medians", () => {
  const lines = history();
  const add = (age: number, fields: Record<string, unknown>) => lines.push(JSON.stringify({
    ts: new Date(epoch - age * minute).toISOString(), ...fields,
  }));
  lines.push(...lines, "{", "null", JSON.stringify({ ts: "bad", run_id: "bad" }));
  add(9 * 24 * 60, { step: "verdict", task_id: "old", run_id: "old", reason: "freshness_yield" });
  add(8 * 24 * 60, { step: "run.start", task_id: "old", run_id: "old-start" });
  add(1, { step: "verdict", task_id: "unresumed", run_id: "unresumed", reason: "freshness_yield" });
  add(-100, { step: "run.start", task_id: "unresumed", run_id: "future" });
  add(10, { step: "run.phase", waiting_on: "preopen_gate", run_id: "failed" });
  add(9, { step: "verdict", run_id: "failed", verdict: "failed" });
  add(8, { step: "pr.opened", run_id: "failed" });
  add(10, { step: "run.phase", waiting_on: "preopen_gate", run_id: "unfinished" });
  add(10, { step: "run.phase", waiting_on: "preopen_gate", run_id: "zero" });
  add(10, { step: "pr.opened", run_id: "zero" });
  const estimates = restartWorkHistory(lines, epoch);
  assert.deepEqual(estimates.yieldCost, { ms: 62 * minute, samples: 3 });
  assert.deepEqual(estimates.remaining.get("preopen_gate"), { ms: 5 * minute, samples: 3 });
  assert.equal(estimates.remaining.has("checkpointed"), false);
});

test("W1-T8927: boot reads compressed, plain and live history before choosing a holdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t8927-history-"));
  try {
    const lines = history();
    writeFileSync(join(dir, "ledger.2026-10-12T23-00-00Z.ndjson.gz"), gzipSync(lines.slice(0, 6).join("\n") + "\n"));
    writeFileSync(join(dir, "ledger.2026-10-12T23-05-00Z.ndjson"), lines.slice(6, 12).join("\n") + "\n");
    writeFileSync(join(dir, "ledger.ndjson"), lines.slice(12).join("\n") + "\n");
    const read = readRestartHistoryLines(dir, epoch);
    assert.equal(read.length, lines.length, "positive control: every history row was opened");
    const estimates = restartWorkHistory(read, epoch);
    assert.deepEqual(estimates.yieldCost, { ms: 62 * minute, samples: 3 });
    assert.deepEqual(estimates.remaining.get("preopen_gate"), { ms: 5 * minute, samples: 3 });
    writeFileSync(join(dir, "ledger.2026-10-12T23-00-00Z.ndjson.gz"), "invalid gzip");
    assert.throws(() => readRestartHistoryLines(dir, epoch), /restart history unreadable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T8927: a repeated start of the yielded run is not its resumption", () => {
  const rows = [
    { age: 80, step: "verdict", run_id: "yielded", reason: "freshness_yield" },
    { age: 79, step: "run.start", run_id: "yielded" },
    { age: 18, step: "run.start", run_id: "resumed" },
  ].map(({ age, ...fields }) => JSON.stringify({
    ts: new Date(epoch - age * minute).toISOString(), task_id: "repeated", ...fields,
  }));
  assert.deepEqual(restartWorkHistory(rows, epoch).yieldCost, { ms: 62 * minute, samples: 1 });
  assert.deepEqual(restartWorkHistory(rows.slice(0, 2), epoch).yieldCost, { ms: undefined, samples: 0 });
});

test("W1-T8927: even medians and historical phase receipts retain measured durations", () => {
  const even = restartWorkHistory(history().filter((raw) => !JSON.parse(raw).task_id.endsWith("-1")), epoch);
  assert.deepEqual(even.yieldCost, { ms: 62 * minute, samples: 2 });
  assert.deepEqual(even.remaining.get("preopen_gate"), { ms: 5 * minute, samples: 2 });
  const legacy = restartWorkHistory([
    [20, "recon.done"], [10, "implement.unfinished"], [8, "implement.done"],
    [5, "fallback_push.cause"], [3, "pr.opened"],
  ].map(([age, step]) => JSON.stringify({ step, run_id: "legacy", ts: new Date(epoch - Number(age) * minute).toISOString() })), epoch);
  assert.deepEqual([...legacy.remaining], [
    ["implementing", { ms: 17 * minute, samples: 1 }], ["checkpointed", { ms: 7 * minute, samples: 1 }],
    ["preopen_gate", { ms: 5 * minute, samples: 1 }], ["pushing", { ms: 2 * minute, samples: 1 }],
  ]);
});
