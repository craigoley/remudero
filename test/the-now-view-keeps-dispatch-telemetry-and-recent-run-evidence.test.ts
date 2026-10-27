import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { computeBoardSnapshot, computeRecentActivity, createRecentActivityCache } from "#src/lib/board.js";
import { fixedClock } from "#src/lib/clock.js";
import { createLedgerProjector, ledgerLineIdentity, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { assembleNowView } from "#src/lib/now-view.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { acquireLease, withWriteTransaction } from "#src/lib/read-model-db.js";
import { projectRecentEntry, readRecentActivity } from "#src/lib/recent-projection.js";
import type { GitHub } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const task: Task = { id: "W1-T1", title: "worker telemetry", repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
const plan: Plan = { tasks: [task], byId: new Map([[task.id, task]]) };
const github = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null,
  findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [], listOpenHeadBranches: () => [],
  headRefName: () => undefined, prBody: () => undefined,
} as unknown as GitHub;
const row = (step: string, at: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ts: new Date(NOW + at).toISOString(), step, task_id: task.id, run_id: "current", ...extra,
});
function project(rows: ReturnType<typeof row>[], instance = "core") {
  const deps = { plan, ledgerPath: "/unused/ledger.ndjson", github, readLedger: () => rows, now: () => NOW + 1000 };
  const snapshot = computeBoardSnapshot(deps);
  const recent = computeRecentActivity(deps, createRecentActivityCache(), 20);
  return assembleNowView({ instance, snapshot, rows, plan, recent, health: { daemon: { state: "polling" } }, decisions: { decisions: [] }, nowMs: NOW + 1000 });
}
const started = () => [row("run.start", 0, { provider: "codex", type: "implement", mount: { model: "requested" } }), row("recon.done", 1)];

test("the now worker projection changes only with proven dispatch identity", () => {
  const rows = started();
  const initial = project(rows).board.tasks[0]!.worker;
  assert.deepEqual(initial, { runId: "current", role: "implementer", provider: "codex", requestedModel: "requested" });
  rows.push(row("worker.activity", 2, { event_kind: "tool-executing", event_at: new Date(NOW + 2).toISOString(), tool_name: "Read", tool_reason: "inspect", turns_so_far: 0 }));
  assert.deepEqual(project(rows).board.tasks[0]!.worker, initial);
  rows.push(row("worker.activity", 3, { event_kind: "message", tool_name: "Read", tool_completed_at: new Date(NOW + 3).toISOString(), tool_duration_ms: 0, tool_outcome: "success" }));
  assert.deepEqual(project(rows).board.tasks[0]!.worker, initial, "tool completion cannot change the dispatch projection");
  rows.push(row("worker.activity", 4, { run_id: "previous", event_kind: "message", provider: "foreign", requested_model: "foreign", served_model: "foreign" }));
  assert.deepEqual(project(rows).board.tasks[0]!.worker, initial, "a later event for another attempt is not this dispatch");
  rows.push(row("worker.activity", 5, { event_kind: "message", served_model: "explicit-receipt" }));
  assert.deepEqual(project(rows).board.tasks[0]!.worker, { ...initial, servedModel: "explicit-receipt" });
  rows.push(row("run.start", 6, { run_id: "next", provider: "claude", mount: { model: "next-requested" } }));
  assert.deepEqual(project(rows).board.tasks[0]!.worker, { runId: "next", role: "recon", provider: "claude", requestedModel: "next-requested" }, "a new dispatch forgets the prior served receipt");
  const unknown = [row("run.start", 0, { run_id: undefined }), row("worker.activity", 1, { event_kind: "message", served_model: "unproved" })];
  assert.equal(project(unknown).board.tasks[0]!.worker?.runId, undefined);
  assert.equal(project(unknown).board.tasks[0]!.worker?.servedModel, undefined);
  for (const run_id of ["", "  "]) {
    const malformed = [row("run.start", 0, { run_id }), row("worker.activity", 1, { run_id, event_kind: "message", served_model: "unproved" })];
    assert.equal(project(malformed).board.tasks[0]!.worker?.runId, undefined);
    assert.equal(project(malformed).board.tasks[0]!.worker?.servedModel, undefined, "two missing identities do not prove a dispatch");
  }
  assert.equal(project(started(), "console").instance, "console", "another source retains its own context");
});

test("recent telemetry keeps explicit run evidence and rejects foreign attempts", (t) => {
  const rows = [...started(), row("worker.activity", 2, {
    event_kind: "message", event_at: new Date(NOW + 2).toISOString(), worker_role: "implementer", provider: "codex",
    requested_model: "requested", turns_so_far: 0, tool_name: "Read", tool_reason: "inspect changed code",
    tool_started_at: new Date(NOW + 1).toISOString(), tool_completed_at: new Date(NOW + 2).toISOString(), tool_duration_ms: 0, tool_outcome: "success",
    prompt: "secret-prompt", tool_input: { token: "secret-input" }, output: "secret-output",
  }), row("daemon.heartbeat", 3), row("worker.activity", 4, { run_id: "previous", event_kind: "working", provider: "claude", served_model: "old-explicit" })];
  const data = project(rows);
  const current = data.recent.entries.find((e) => e.runId === "current" && e.verb === "worker")!;
  assert.ok(current, "the actual Now serializer preserves run correlation");
  assert.equal(current.provider, "codex");
  assert.equal(current.workerRole, "implementer");
  assert.equal(current.requestedModel, "requested");
  assert.equal(current.servedModel, undefined, "assignment/requested identity is never a served receipt");
  assert.equal(current.eventKind, "message");
  assert.equal(current.eventAt, rows[2]!.event_at);
  assert.equal(current.turnsSoFar, 0);
  assert.equal(current.toolDurationMs, 0);
  assert.equal(current.toolName, "Read");
  assert.equal(current.toolReason, "inspect changed code");
  assert.equal(current.toolOutcome, "success");
  assert.equal(data.board.tasks[0]!.worker?.servedModel, undefined, "historical recent entries never become the current attempt");
  assert.equal(data.recent.entries[0]!.runId, "previous", "history remains explicitly historical");
  assert.ok(!JSON.stringify(data).includes("secret-"), "raw prompts, arguments and outputs stay out");
  assert.equal(data.recent.entries.length, 3, "a daemon heartbeat does not mint activity");

  const dir = makeTempDir("dispatch-recent-evidence");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = fixedClock(NOW + 1000);
  const db = openProjectorReadModel(dir, "core", clock);
  t.after(() => db.close());
  const lease = acquireLease(db, { clock });
  assert.ok(lease.ok);
  createLedgerProjector({ ledgerDir: dir, db, lease: lease.lease, clock }).tick();
  withWriteTransaction(db, lease.lease, () => {
    for (const r of rows) projectRecentEntry(db, "core", r, ledgerLineIdentity(JSON.stringify(r)));
    const foreign = row("worker.activity", 5, { provider: "foreign-instance", event_kind: "working" });
    projectRecentEntry(db, "console", foreign, ledgerLineIdentity(JSON.stringify(foreign)));
  });
  assert.deepEqual(readRecentActivity(db, "core", { plan, nowMs: NOW + 1000 }).entries, data.recent.entries);
  assert.equal(readRecentActivity(db, "console", { plan, nowMs: NOW + 1000 }).entries[0]!.provider, "foreign-instance");
});

test("recent telemetry bounds malformed fields while retaining measured zeros and unknowns", () => {
  const rows = [...started(), row("worker.activity", 2, {
    run_id: "x".repeat(161), event_kind: "working", event_at: "not-a-time", worker_role: "invented",
    provider: "p".repeat(2000), requested_model: "m".repeat(2000), tool_name: "n".repeat(2000),
    tool_reason: "r".repeat(2000), tool_duration_ms: -1, turns_so_far: Number.POSITIVE_INFINITY,
    tool_started_at: "bad", tool_completed_at: "bad", tool_outcome: "maybe", raw_tool_arguments: "secret",
  }), row("worker.activity", 3, { run_id: undefined, event_kind: "message", tool_duration_ms: Number.NaN }),
  ...Array.from({ length: 205 }, (_, i) => row("worker.activity", i + 4, { run_id: "bounded", event_kind: "working", turns_so_far: 0, tool_duration_ms: 0 }))];
  const malformed = project(rows.slice(0, 4)).recent.entries.find((e) => e.provider)!;
  assert.equal(malformed.runId, undefined, "oversized correlation is absent, never truncated into an alias");
  assert.equal(malformed.provider!.length, 160);
  assert.equal(malformed.requestedModel!.length, 160);
  assert.equal(malformed.toolName!.length, 160);
  assert.equal(malformed.toolReason!.length, 240);
  for (const key of ["eventAt", "workerRole", "toolDurationMs", "turnsSoFar", "toolStartedAt", "toolCompletedAt", "toolOutcome", "raw_tool_arguments"]) {
    assert.equal((malformed as unknown as Record<string, unknown>)[key], undefined, key);
  }
  const missing = project(rows.slice(0, 4)).recent.entries[0]!;
  assert.equal(missing.runId, undefined);
  assert.equal(missing.servedModel, undefined);
  assert.equal(missing.toolDurationMs, undefined, "a malformed measurement is not zero");
  const bounded = project(rows).recent.entries;
  assert.equal(bounded.length, 20, "Now retains the existing recent display bound");
  assert.ok(bounded.every((e) => e.turnsSoFar === 0 && e.toolDurationMs === 0));
});
