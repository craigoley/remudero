import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { restartCycleLedgerRows, restartCycleRow } from "#src/lib/restart-cycle.js";
import { runDaemon } from "#src/lib/daemon.js";
import { rotateLedger } from "#src/lib/ledger.js";
import type { Plan } from "#src/lib/plan.js";

const epoch = Date.now();
const at = (ms: number) => new Date(epoch + ms).toISOString();
type Row = Record<string, unknown>;
const row = (ms: number, step: string, fields: Row = {}): Row => ({ ts: at(ms), step, ...fields });
function fixture(): Row[] {
  return [
    row(0, "daemon.boot", { run_id: "old" }),
    row(50, "review.posted", { pr_url: "https://github.com/o/r/pull/9" }),
    row(110, "daemon.freshness_decision", { action: "defer", stale_since_ms: epoch + 100 }),
    row(120, "review.skipped_stale_reviewer_code", { pr: "1" }),
    row(130, "review.skipped_stale_reviewer_code", { pr: "1" }),
    row(140, "review.reviewer", { run_id: "review-2", worker_duration_ms: 30 }),
    row(150, "review.post_refused", { run_id: "review-2", pr_url: "https://github.com/o/r/pull/2", reviewer_code_freshness: "stale" }),
    row(160, "review.post_refused", { reviewer_code_freshness: "unreadable" }),
    row(170, "daemon.admission_held", { reason: "heap" }),
    row(200, "daemon.freshness_decision", { action: "restart", reason: "upper_age", old_sha: "old", new_sha: "new", stale_since_ms: epoch + 100 }),
    row(210, "daemon.admission_held", { reason: "restart latched" }),
    row(220, "daemon.admission_held", { reason: "restart decided" }),
    row(250, "review.posted", { pr_url: "https://github.com/o/r/pull/3" }),
    row(290, "daemon.freshness_drain.completed", { abandoned_in_flight_reviews: 1, abandoned_detached_sweep_actions: 2, waited_on: [
      { what: "review", kind: "review", pr: 4, admitted_at_ms: epoch + 190, abandoned: true },
      { what: "detached", kind: "fix-dispatch", task_id: "FIX", admitted_at_ms: epoch + 180, abandoned: true },
      { what: "detached", kind: "ci-wait", admitted_at_ms: epoch + 180, abandoned: true },
      { what: "review", kind: "review", admitted_at_ms: epoch + 180, settled_after_ms: 50 },
    ] }),
    row(300, "daemon.freshness_exit", { phases_ms: { drain: 90, total: 100 } }),
    row(301, "daemon_selfrestart_for_freshness", { old_sha: "old", new_sha: "new", stale_since_ms: epoch + 100 }),
    row(400, "daemon.boot", { run_id: "new" }),
    row(500, "review.posted", { pr_url: "https://github.com/o/r/pull/1" }),
    row(550, "review.posted", { pr_url: "https://github.com/o/r/pull/2" }),
  ];
}
const cycle = (rows = fixture()) => {
  const result = restartCycleRow(rows, epoch + 400);
  assert.ok(result);
  return result;
};

test("W1-T12229 criterion 1: five times join both lifetimes", () => {
  const r = cycle();
  assert.deepEqual([r.first_material_change_at, r.decided_at, r.exit_at, r.started_at, r.first_verdict_at],
    [100, 200, 300, 400, 500].map(at));
  assert.equal(r.trigger, "upper_age");
  assert.equal(r.old_sha, "old"); assert.equal(r.new_sha, "new");
  assert.deepEqual(r.phases_ms, { drain: 90, total: 100 });
  assert.equal(restartCycleRow(fixture().filter(r => Date.parse(String(r.ts)) >= epoch + 400), epoch + 400), null);
});

test("W1-T12229 criterion 2: waiting counts distinguish stale refusals and restart holds", () => {
  const r = cycle();
  assert.equal(r.reviews_not_started, 2);
  assert.equal(r.reviews_refused_after_finish, 1);
  assert.equal(r.refused_review_ms, 30);
  assert.equal(r.admissions_held, 2);
});

test("W1-T12229 criterion 3: abandoned reviews and fix rounds retain each age", () => {
  const rows = fixture().map(r => r.step === "daemon.freshness_drain.completed" ? { ...r, waited_on: [
    ...(r.waited_on as Row[]).map(item => item.kind === "fix-dispatch" ? { ...item, abandoned: undefined, released: true } : item),
  ] } : r);
  // Admission cancellation settles the registry entry after the bound. The explicit abandoned row
  // retains its age even though the final inventory snapshot calls that entry released.
  rows.splice(rows.findIndex(r => r.step === "daemon.freshness_drain.completed"), 0,
    row(285, "daemon.detached_action_abandoned", { action_kind: "fix-dispatch", task_id: "FIX", age_ms: 229 }));
  const r = cycle(rows);
  assert.deepEqual(r.gave_up.reviews?.map(item => [item.pr, item.age_ms]), [[4, 100]]);
  assert.deepEqual(r.gave_up.fix_rounds?.map(item => [item.task_id, item.age_ms]), [["FIX", 229]]);
  assert.equal(r.gave_up_age_ms, 329);
});

test("W1-T12229 criterion 4: verdict count and gap end at the first verdict", () => {
  const r = cycle();
  assert.equal(r.verdicts_posted, 2);
  assert.equal(r.verdict_gap_ms, 250);
});

test("W1-T12229 criterion 5: costs sum known parts and name unavailable parts as null", () => {
  const r = cycle();
  assert.equal(r.review_wait_ms, 380 + 400);
  assert.equal(r.waiting_cost_ms, 810);
  assert.equal(r.restart_cost_ms, 460);
  assert.deepEqual(r.missing_parts, []);
  const missing = cycle(fixture().filter(r => r.step !== "review.reviewer" && r.step !== "daemon.freshness_drain.completed" &&
    !(r.step === "review.posted" && r.ts === at(550))));
  assert.equal(missing.refused_review_ms, null);
  assert.equal(missing.review_wait_ms, null);
  assert.equal(missing.waiting_cost_ms, null);
  assert.equal(missing.gave_up_age_ms, null);
  assert.equal(missing.restart_cost_ms, null);
  for (const part of ["refused_review_ms", "review_wait_ms", "gave_up_age_ms"]) assert.ok(missing.missing_parts.includes(part));
});

async function daemon(rows: Row[], ticks: number, afterSleep?: (tick: number, rows: Row[]) => void,
  read?: (tick: number, rows: Row[]) => readonly string[], freshnessEnabled = false) {
  const logs: Array<{ step: string; fields: Row }> = [];
  let tick = 0, reads = 0;
  const readsByTick = new Map<number, number>();
  const start = rows.filter(r => r.step === "daemon.boot").map(r => Date.parse(String(r.ts))).at(-1) ?? epoch + 400;
  const empty: Plan = { tasks: [], byId: new Map() };
  await runDaemon(empty, {
    now: () => new Date(start + tick * 100),
    readLedgerLines: () => { reads++; readsByTick.set(tick, (readsByTick.get(tick) ?? 0) + 1);
      return read ? read(tick, rows) : rows.map(r => JSON.stringify(r)); },
    ...(freshnessEnabled ? { checkFreshness: () => ({ stale: true, oldSha: "old", newSha: "new",
      staleSinceMs: epoch + 100, changes: [{ sha: "new", subject: "fix: refresh worker", files: ["src/lib/worker.ts"] }] }) } : {}),
    refreshMerged: () => () => false,
    checkStop: () => tick > ticks ? "fixture done" : undefined,
    runOne: async () => { throw new Error("empty plan must not dispatch"); },
    log: (step, fields = {}) => {
      logs.push({ step, fields });
      if (step === "daemon.tick") { tick++; if (tick > 1) afterSleep?.(tick - 1, rows); }
    },
    sleep: async () => {},
  }, { pollIntervalMs: 1 });
  return { cycles: logs.filter(r => r.step === "daemon.restart_cycle").map(r => r.fields), reads, readsByTick, logs };
}

test("W1-T12229 criterion 6: runDaemon writes once on the first tick with a verdict", async () => {
  const rows = fixture().filter(r => Date.parse(String(r.ts)) <= epoch + 400);
  const result = await daemon(rows, 3, (tick, ledger) => {
    if (tick === 1) ledger.push(row(500, "review.posted", { pr_url: "https://github.com/o/r/pull/1" }));
  });
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].first_verdict_at, at(500));
  assert.equal(result.cycles[0].started_at, at(400));
  assert.equal(result.reads, 4, "one boot read and one shared read per active tick, including release resolution");
});

test("W1-T12229 criterion 6: freshness scoring and restart observation share each tick read", async () => {
  const rows = fixture().filter(r => Date.parse(String(r.ts)) <= epoch + 400);
  const result = await daemon(rows, 3, (tick, ledger) => {
    if (tick === 1) ledger.push(row(500, "review.posted", { pr_url: "https://github.com/o/r/pull/1" }));
  }, undefined, true);
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].first_verdict_at, at(500));
  assert.ok(result.logs.some(r => r.step === "daemon.freshness_decision"), "freshness scoring ran");
  for (const tick of [1, 2]) assert.equal(result.readsByTick.get(tick), 1, `tick ${tick} reads once`);
  assert.ok((result.readsByTick.get(3) ?? 0) <= 1, "the stopping tick does not reread");
});

test("W1-T12229 criterion 7: the next start closes a lifetime with no verdict", async () => {
  const rows = fixture().filter(r => Date.parse(String(r.ts)) <= epoch + 400);
  rows.push(row(600, "daemon.memory_exit"), row(700, "daemon.boot", { run_id: "third" }));
  const result = await daemon(rows, 1);
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].started_at, at(400));
  assert.equal(result.cycles[0].first_verdict_at, null);
  assert.equal(result.cycles[0].verdict_gap_ms, null);
  assert.equal(restartCycleRow(rows, epoch + 700), null, "a memory exit is not a freshness restart");
  assert.equal((await daemon([row(400, "daemon.boot")], 1)).cycles.length, 0);
  rows.push(row(710, "daemon.restart_cycle", { started_at: at(400) }));
  assert.equal((await daemon(rows, 1)).cycles.length, 0, "a carried cycle is not written again");
});

test("W1-T12229 criterion 7: rotation keeps an unfinished cycle's prior boot boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-restart-cycle-"));
  try {
    const path = join(dir, "ledger.ndjson");
    const now = Date.now();
    const atTime = (offset: number) => new Date(now + offset).toISOString();
    const oldStart = -40 * 60_000;
    const newStart = -20 * 60_000;
    const prior = [
      { ts: atTime(oldStart), step: "daemon.boot", run_id: "old" },
      { ts: atTime(oldStart + 1000), step: "daemon.freshness_decision", action: "restart", stale_since_ms: now + oldStart },
      { ts: atTime(oldStart + 1500), step: "daemon.detached_action_abandoned", action_kind: "fix-dispatch", task_id: "FIX", age_ms: 229 },
      { ts: atTime(oldStart + 2000), step: "daemon.freshness_exit", phases_ms: { total: 1000 } },
      { ts: atTime(newStart), step: "daemon.boot", run_id: "new" },
    ];
    const noise = (n: number) => Array.from({ length: 300 }, (_, i) =>
      ({ ts: atTime(n), step: "ci.polling", detail: `noise-${i}-${"x".repeat(70)}` }));
    writeFileSync(path, [...prior, ...noise(-1000)].map(r => JSON.stringify(r)).join("\n") + "\n");
    assert.equal(rotateLedger(path, { ceilingBytes: 8000, smoothingWindowMs: 0,
      now: () => new Date(now - 500) }).rotated, true);
    const afterFirst = restartCycleLedgerRows(readFileSync(path, "utf8").trim().split("\n")).rows;
    assert.equal(afterFirst.filter(r => r.step === "daemon.boot").length, 2);
    const third = { ts: atTime(0), step: "daemon.boot", run_id: "third" };
    writeFileSync(path, [...afterFirst, { ts: atTime(-1000), step: "daemon.memory_exit" }, third, ...noise(100)]
      .map(r => JSON.stringify(r)).join("\n") + "\n");
    assert.equal(rotateLedger(path, { ceilingBytes: 8000, smoothingWindowMs: 0,
      now: () => new Date(now + 200) }).rotated, true);
    const retained = restartCycleLedgerRows(readFileSync(path, "utf8").trim().split("\n")).rows;
    assert.ok(retained.some(r => r.step === "daemon.boot" && r.ts === atTime(newStart)));
    assert.ok(retained.some(r => r.step === "daemon.detached_action_abandoned" && r.task_id === "FIX"));
    assert.ok(restartCycleRow(retained, now + newStart));
    const result = await daemon(retained as Row[], 1);
    assert.equal(result.cycles.length, 1);
    assert.equal(result.cycles[0].started_at, atTime(newStart));
    assert.equal(result.cycles[0].first_verdict_at, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("startup records every earlier unrecorded freshness cycle after multiple restarts", async () => {
  const rows = [
    row(0, "daemon.boot", { run_id: "first" }),
    row(10, "daemon.freshness_decision", { action: "restart", stale_since_ms: epoch + 5 }),
    row(20, "daemon.freshness_exit"),
    row(100, "daemon.boot", { run_id: "second" }),
    row(110, "review.posted", { pr: 1 }),
    row(120, "daemon.freshness_decision", { action: "restart", stale_since_ms: epoch + 105 }),
    row(130, "daemon.freshness_exit"),
    row(200, "daemon.boot", { run_id: "third" }),
    row(210, "review.posted", { pr: 2 }),
  ];
  const result = await daemon(rows, 1);
  assert.deepEqual(result.cycles.map(r => r.started_at), [at(100), at(200)]);
  assert.deepEqual(result.cycles.map(r => r.first_verdict_at), [at(110), at(210)]);
});

test("an unreadable cycle read carries its error and retries on the next tick", async () => {
  const result = await daemon(fixture(), 2, undefined, (tick, rows) => {
    if (tick === 1) throw new Error("fixture ledger unavailable");
    return rows.map(r => JSON.stringify(r));
  });
  assert.equal(result.cycles.length, 1);
  assert.equal(result.reads, 3, "the failed tick does not retry its ledger read during release resolution");
  assert.match(String(result.logs.find(r => r.step === "daemon.restart_cycle_unreadable")?.fields.error), /fixture ledger unavailable/);
});

test("a torn tick row is reported beside the cycle derived from intact rows", async () => {
  const result = await daemon(fixture(), 1, undefined, (_tick, rows) => ["{", ...rows.map(r => JSON.stringify(r))]);
  assert.equal(result.cycles.length, 1);
  const errors = result.logs.find(r => r.step === "daemon.restart_cycle_unreadable")?.fields.errors;
  assert.ok(Array.isArray(errors)); assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /^ledger row parse failed: SyntaxError:/);
});

test("missing pull request identity and reviewer duration leave waiting cost unknown", () => {
  const rows = fixture().map(r => r.step === "review.skipped_stale_reviewer_code" ? { ...r, pr: undefined }
    : r.step === "review.reviewer" ? { ...r, worker_duration_ms: undefined } : r);
  const r = cycle(rows);
  assert.equal(r.review_wait_ms, null);
  assert.equal(r.refused_review_ms, null);
  assert.equal(r.waiting_cost_ms, null);
});

test("a stale skip naming a pull request by URL joins its next verdict", () => {
  const rows = fixture().map(r => r.step === "review.skipped_stale_reviewer_code" ? { ...r, pr: "https://github.com/o/r/pull/1" } : r);
  assert.equal(cycle(rows).review_wait_ms, 780);
  assert.equal(cycle(rows).waiting_cost_ms, 810);
});

test("the exit marker names the final target when main advances after the decision", () => {
  const rows = fixture().map(r => r.step === "daemon_selfrestart_for_freshness" ? { ...r, new_sha: "final" } : r);
  assert.equal(cycle(rows).new_sha, "final");
  assert.equal(cycle(rows).decided_at, at(200));
});

test("a daemon decision records the first material change for the next lifetime", async () => {
  let tick = 0;
  const decisions: Row[] = [];
  const empty: Plan = { tasks: [], byId: new Map() };
  const result = await runDaemon(empty, {
    now: () => new Date(epoch + 400 + tick * 100),
    refreshMerged: () => () => false,
    checkStop: () => tick > 3 ? "fixture done" : undefined,
    checkFreshness: () => ({ stale: true, oldSha: "old", newSha: "new", staleSinceMs: epoch + 100,
      changes: [{ sha: "new", subject: "fix: refresh worker", files: ["src/lib/worker.ts"] }] }),
    runOne: async () => { throw new Error("empty plan must not dispatch"); },
    log: (step, fields = {}) => {
      if (step === "daemon.tick") tick++;
      if (step === "daemon.freshness_decision") decisions.push(fields);
    },
    sleep: async () => {},
  }, { freshnessMinLifetimeMs: 0, freshnessQuietWindowMs: 0, freshnessScoreLimit: 0, sweepWallClockBoundMs: 1 });
  assert.equal(result.stopReason, "stale");
  assert.equal(decisions.find(r => r.action === "restart")?.stale_since_ms, epoch + 100);
});

test("torn and non-object rows are reported without inventing ledger facts", () => {
  const parsed = restartCycleLedgerRows(["{", "null", "[]", ...fixture().map(r => JSON.stringify(r))]);
  assert.equal(parsed.errors.length, 3);
  assert.match(parsed.errors[0], /^ledger row parse failed: SyntaxError:/);
  assert.deepEqual(parsed.errors.slice(1), ["ledger row is not an object", "ledger row is not an object"]);
  assert.equal(cycle(parsed.rows).restart_cost_ms, 460);
});

test("missing material time, verdicts and admitted ages remain unknown", () => {
  const rows = fixture().filter(r => r.step !== "review.posted").map(r => {
    const { stale_since_ms: _stale, ...rest } = r;
    if (rest.step === "daemon.freshness_drain.completed") return { ...rest, waited_on: [{ what: "review", abandoned: true }] };
    return rest;
  });
  const r = cycle(rows);
  assert.equal(r.first_material_change_at, null);
  assert.equal(r.first_verdict_at, null);
  assert.equal(r.gave_up.reviews?.[0].age_ms, null);
  assert.equal(r.verdict_gap_ms, null);
  assert.equal(r.restart_cost_ms, null);
  assert.ok(r.missing_parts.includes("first_material_change_at"));
});

test("the cycle selects the adjacent freshness exit and stops at the next boot", () => {
  const rows = [...fixture(), row(-100, "daemon.freshness_exit"), row(450, "daemon.boot"), row(460, "review.posted")];
  const original = JSON.stringify(rows);
  assert.equal(cycle(rows).exit_at, at(300));
  assert.equal(cycle(rows).first_verdict_at, null);
  assert.equal(JSON.stringify(rows), original);
  for (const step of ["daemon.memory_exit", "daemon.signal_exit", "daemon.stop"])
    assert.equal(restartCycleRow([...rows, row(350, step)], epoch + 400), null);
});
