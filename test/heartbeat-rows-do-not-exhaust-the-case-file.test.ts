import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fixedClock } from "#src/lib/clock.js";
import type { Task } from "#src/lib/plan.js";
import { deriveStatus } from "#src/lib/status.js";
import * as caseFile from "#src/lib/task-case-file.js";
import { buildTaskCaseFile, CASE_TELEMETRY_STEPS, readTaskCaseLedger, readTaskCaseLedgers } from "#src/lib/task-case-file.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

const asOf = "2026-09-27T14:00:00.000Z";
const archive = "ledger.2026-09-26T16-27-20-296Z.ndjson.gz";
const taskId = "W1-T4651";
const runId = `${taskId}-1790514000000`;
const otherRun = `${taskId}-1790514000001`;
const task = { id: taskId, title: "Heartbeats", repo: "remudero", depends_on: [], type: "implement",
  verify: "auto", risk: "medium", status: "queued", attempts: 0 } as Task;
const prUrl = "https://github.com/craigoley/remudero/pull/7560";
const base = Date.parse("2026-09-27T10:00:00.000Z");
const at = (second: number) => fixedClock(base + second * 1000).iso();
const line = (second: number, step: string, rest: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: at(second), task_id: taskId, run_id: runId, step, ...rest });
const activity = (count: number, from = 10) => Array.from({ length: count }, (_, index) =>
  line(from + index, "worker.activity", { event_kind: "working", event_at: at(from + index) }));
const opening = [line(0, "run.start"),
  line(1, "worker.assignment", { worker_assignment: { id: "a1", selected: { provider: "claude", model: "claude-opus-5-5" } } })];
const closing = (second: number) => [
  line(second, "worker.attempt", { selection_assignment_id: "a1", served_model: "claude-opus-5-5", billing_mode: "api", total_cost_usd: 1.5 }),
  line(second + 1, "pr.opened", { pr_url: prUrl }),
  line(second + 2, "verdict", { selection_assignment_id: "a1", verdict: "passed" })];
const unread = { state: "unavailable", reason: "github-not-read" } as const;

function stateWith(archiveLines: string[], live: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-case-heartbeat-"));
  if (archiveLines.length) writeFileSync(join(dir, archive), gzipSync(archiveLines.map((row) => `${row}\n`).join("")));
  writeFileSync(join(dir, "ledger.ndjson"), live.map((row) => `${row}\n`).join(""));
  return dir;
}

/** A deterministic heartbeat flood: every activity kind and field the status fold reads, valid and invalid values,
 * two runs, two run.start segments and an in-flight end, so the reduction has every chance to lose a value. */
function flood(): string[] {
  let state = 4651;
  const next = (n: number) => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return Math.floor(state / 65_536) % n; };
  const pick = <T>(values: readonly T[]): T => values[next(values.length)]!;
  const rows: string[] = [];
  let second = 0;
  const heartbeat = () => {
    second += 1;
    const run = next(5) === 0 ? otherRun : runId;
    const kind = pick(["worker.activity", "worker.activity", "worker.activity", "worker.state", "run.running_long"]);
    // `beat` makes every row distinct, so the reader's replay check drops none of them.
    const row: Record<string, unknown> = { ts: next(40) === 0 ? "not-a-time" : at(second), task_id: taskId, run_id: run, step: kind, beat: second };
    if (kind === "worker.state") row.state = pick(["working", "tool-executing", "quiet", "bogus", 7]);
    if (kind === "worker.activity") {
      row.event_kind = pick(["working", "tool-executing", "tool-executing", "message", "assistant-text"]);
      if (next(3)) row.event_at = next(30) === 0 ? "" : at(second);
      if (next(4) === 0) row.worker_role = pick(["implementer", "reviewer", "fixer", "nobody"]);
      for (const field of ["provider", "requested_model", "served_model"]) if (next(5) === 0) row[field] = pick([`${field}-${next(3)}`, 3]);
      if (next(2)) row.tool_name = pick(["Bash", "Read", ""]);
      if (next(3) === 0) row.tool_reason = pick(["run the test", "read the file", 1]);
      if (next(3) === 0) row.tool_started_at = at(second - 1);
      if (next(3) === 0) { row.tool_completed_at = at(second); row.tool_duration_ms = pick([1200, -5, "2"]); }
      if (next(3) === 0) row.tool_outcome = pick(["success", "error", "maybe"]);
    }
    rows.push(JSON.stringify(row));
  };
  const evidence = (step: string, rest: Record<string, unknown> = {}) => { second += 1; rows.push(line(second, step, rest)); };
  evidence("run.start");
  evidence("worker.assignment", { worker_assignment: { id: "a1", selected: { provider: "claude", model: "claude-opus-5-5" } } });
  for (let i = 0; i < 1_500; i += 1) heartbeat();
  evidence("recon.done");
  for (let i = 0; i < 1_500; i += 1) heartbeat();
  evidence("verdict", { verdict: "failed" });
  for (let i = 0; i < 300; i += 1) heartbeat();
  evidence("run.start");
  for (let i = 0; i < 2_000; i += 1) heartbeat();
  evidence("pr.opened", { pr_url: prUrl });
  for (let i = 0; i < 1_500; i += 1) heartbeat();
  return rows;
}

const project = (rows: Record<string, unknown>[], now: number, livenessBoundMs: number) =>
  deriveStatus(task, { ledgerPath: "unused", readLedger: () => rows, github: fakeGitHub(), now: () => now, livenessBoundMs });

test("W1-T14630 criterion 1: a task with any number of evidence rows reads observed with every one of them", async () => {
  // 4,000 evidence rows: twice the old 2,000 bound that refused the whole case file.
  const evidence = Array.from({ length: 4_000 }, (_, index) => line(10 + index, "fix.dispatch", { n: index }));
  const dir = stateWith([], [...opening, ...evidence, ...closing(5_000)]);
  try {
    const read = await readTaskCaseLedger(dir, taskId, asOf);
    assert.equal(read.state, "observed");
    assert.equal(read.reason, undefined);
    assert.equal(read.truncated, false);
    assert.equal(read.rows.length, 4_005);
    assert.deepEqual(read.rows.filter((row) => row.step === "fix.dispatch").map((row) => row.n), evidence.map((_, index) => index));
    const file = buildTaskCaseFile({ task, ledger: read, asOf, prRead: unread });
    assert.equal(file.ledger.state === "observed" && file.ledger.value.matchingRows, 4_005);
    assert.equal(file.runs[0]?.verdict, "passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The bound and its options are gone: no option can bring the refusal back.
  assert.equal("MAX_CASE_TELEMETRY_ROWS_PER_STEP" in caseFile, false);
  const small = stateWith([], [...opening, ...closing(20)]);
  try {
    const read = await readTaskCaseLedger(small, taskId, asOf, { maxRows: 1, maxTelemetryRowsPerStep: 1 } as never);
    assert.equal(read.state, "observed");
    assert.equal(read.rows.length, 5);
  } finally { rmSync(small, { recursive: true, force: true }); }
});

test("W1-T14630 criterion 2: heartbeats reduce only to the rows the status projection reads, and every projected value equals the full row set's", async () => {
  assert.deepEqual([...CASE_TELEMETRY_STEPS].sort(), ["run.running_long", "worker.activity", "worker.state"]);
  const rows = flood();
  const dir = stateWith([], rows);
  try {
    const read = await readTaskCaseLedger(dir, taskId, asOf);
    assert.equal(read.state, "observed");
    const full = rows.map((row) => JSON.parse(row) as Record<string, unknown>);
    // The kept set grows with distinct values, not with the 6,800 heartbeats, and keeps every evidence row in order.
    assert.ok(read.rows.length < 1_000, `kept ${read.rows.length} rows`);
    assert.equal(read.rows.length + read.telemetryRowsDropped!, full.length);
    const isEvidence = (row: Record<string, unknown>) => !CASE_TELEMETRY_STEPS.has(row.step as string);
    assert.deepEqual(read.rows.filter(isEvidence), full.filter(isEvidence));
    const position = new Map(rows.map((row, index) => [row, index]));
    const order = read.rows.map((row) => position.get(JSON.stringify(row))!);
    assert.equal(order.every((index, i) => index !== undefined && (i === 0 || index > order[i - 1]!)), true);
    // Probe lastActivityTs with a liveness bound reaching back to each of the last 40 seconds (and one second short
    // of the last row): running iff the newest own-run activity is inside it. The whole projection (workerState, workerStateSince, workerTelemetry with
    // firstSignalAt) must match at every bound.
    const now = base + 10_000_000;
    const lastMs = Math.max(...full.map((row) => Date.parse(row.ts as string)).filter(Number.isFinite));
    let runningSeen = 0;
    for (let offset = -1_000; offset <= 39_000; offset += 1_000) {
      const bound = now - lastMs + offset;
      const expected = project(full, now, bound);
      assert.deepEqual(project(read.rows, now, bound), expected, `bound ends ${offset} ms before the last row`);
      if (expected.status === "running") runningSeen += 1;
    }
    assert.ok(runningSeen > 0 && runningSeen < 41, `the bound sweep crosses lastActivityTs (${runningSeen} of 41 running)`);
    const expected = project(full, now, 20_000_000);
    assert.equal(expected.status, "running");
    assert.ok(expected.workerTelemetry?.firstSignalAt, "the flood yields a first signal");
    assert.ok(expected.workerState, "the flood yields a worker state");
    assert.deepEqual(project(read.rows, now, 20_000_000), expected);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T14630 criterion 2: 2,500 activity rows before a verdict keep the first and the newest, and the case file records the verdict", async () => {
  const dir = stateWith([], [...opening, ...activity(2500), ...closing(3000)]);
  try {
    const read = await readTaskCaseLedger(dir, taskId, asOf);
    assert.equal(read.state, "observed");
    assert.equal(read.telemetryRowsDropped, 2498);
    assert.deepEqual(read.rows.filter((row) => row.step === "worker.activity").map((row) => row.ts), [at(10), at(2509)]);
    const file = buildTaskCaseFile({ task, ledger: read, asOf, prRead: unread });
    assert.equal(file.ledger.state === "observed" && file.ledger.value.telemetryRowsDropped, 2498);
    // matchingRows is the task's size, kept or dropped: a smaller number never reads as a smaller task.
    assert.equal(file.ledger.state === "observed" && file.ledger.value.matchingRows, 2505);
    assert.deepEqual({ ...file.runs[0] }, { runId, startedAt: at(0), assignmentId: "a1", assignmentIds: ["a1"],
      selectedProvider: "claude", selectedModel: "claude-opus-5-5", servedModel: "claude-opus-5-5", billingMode: "api",
      costUsd: 1.5, verdict: "passed", prNumber: 7560 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T14630 criterion 3: a replayed row in a later rotation is neither kept nor counted twice", async () => {
  // The archive holds the older half; the live file replays all of it before the newer half arrives.
  const older = activity(20);
  const newer = activity(10, 100);
  const dir = stateWith([...opening, ...older], [...opening, ...older, ...newer, ...older.slice(0, 5), ...closing(300)]);
  try {
    const read = await readTaskCaseLedger(dir, taskId, asOf);
    assert.equal(read.state, "observed");
    assert.equal(read.telemetryRowsDropped, 28);
    assert.deepEqual(read.rows.filter((row) => row.step === "worker.activity").map((row) => row.ts), [at(10), at(109)]);
    assert.equal(read.rows.filter((row) => row.step === "run.start").length, 1);
    const file = buildTaskCaseFile({ task, ledger: read, asOf, prRead: unread });
    assert.equal(file.ledger.state === "observed" && file.ledger.value.matchingRows, 35);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T14630 criterion 3: the damaged-row, unreadable-source and missing-corpus refusals are unchanged", async () => {
  const empty = mkdtempSync(join(tmpdir(), "rmd-case-heartbeat-empty-"));
  try {
    assert.equal((await readTaskCaseLedger(empty, taskId, asOf)).reason, "ledger-corpus-missing");
    writeFileSync(join(empty, "ledger.ndjson"), [...opening, `{"task_id":"${taskId}","broken`].join("\n") + "\n");
    const damaged = await readTaskCaseLedger(empty, taskId, asOf);
    assert.equal(damaged.reason, "ledger-source-malformed");
    assert.deepEqual(damaged.rows, []);
    writeFileSync(join(empty, archive), "not gzip");
    writeFileSync(join(empty, "ledger.ndjson"), opening.join("\n") + "\n");
    const unreadable = await readTaskCaseLedger(empty, taskId, asOf);
    assert.equal(unreadable.reason, "ledger-source-unreadable");
    assert.deepEqual(unreadable.rows, []);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test("the batch read reduces each task apart, and a heartbeat with no readable ts is still kept for its slot", async () => {
  const undated = JSON.stringify({ ts: "not-a-time", task_id: taskId, run_id: runId, step: "worker.activity", event_kind: "working" });
  const other = "W1-T4652";
  const otherRow = (second: number) => JSON.stringify({ ts: at(second), task_id: other, run_id: `${other}-1`, step: "worker.activity" });
  const dir = stateWith([], [...opening, undated, ...activity(3), otherRow(1), ...closing(50)]);
  try {
    const reads = await readTaskCaseLedgers(dir, [taskId, other], asOf);
    const mine = reads.get(taskId)!;
    // The undated row is the first of its activity class and the newest heartbeat is the last: the two between drop.
    assert.equal(mine.telemetryRowsDropped, 2);
    assert.deepEqual(mine.rows.filter((row) => row.step === "worker.activity").map((row) => row.ts), ["not-a-time", at(12)]);
    assert.equal(reads.get(other)!.telemetryRowsDropped, 0);
    assert.equal(reads.get(other)!.rows.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the window must be a positive integer", async () => {
  for (const bad of [0, -1, 1.5]) {
    await assert.rejects(readTaskCaseLedger("/nonexistent-case-heartbeat", taskId, asOf, { windowDays: bad }), /windowDays/);
  }
});
