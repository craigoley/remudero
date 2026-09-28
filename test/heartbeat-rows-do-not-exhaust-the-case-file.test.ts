import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fixedClock } from "../src/lib/clock.js";
import type { Task } from "../src/lib/plan.js";
import { buildTaskCaseFile, CASE_TELEMETRY_STEPS, MAX_CASE_TELEMETRY_ROWS_PER_STEP, readTaskCaseLedger,
  readTaskCaseLedgers } from "../src/lib/task-case-file.js";

const asOf = "2026-09-27T14:00:00.000Z";
const archive = "ledger.2026-09-26T16-27-20-296Z.ndjson.gz";
const taskId = "W1-T4651";
const runId = `${taskId}-1790514000000`;
const task = { id: taskId, title: "Heartbeats", repo: "remudero", depends_on: [], type: "implement",
  verify: "auto", risk: "medium", status: "queued", attempts: 0 } as Task;
const prUrl = "https://github.com/craigoley/remudero/pull/7560";
const base = Date.parse("2026-09-27T10:00:00.000Z");
const at = (second: number) => fixedClock(base + second * 1000).iso();
const line = (second: number, step: string, rest: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: at(second), task_id: taskId, run_id: runId, step, ...rest });
const activity = (count: number, from = 10) => Array.from({ length: count }, (_, index) =>
  line(from + index, "worker.activity", { event_kind: "assistant-text", event_at: at(from + index) }));
const opening = [line(0, "run.start"),
  line(1, "worker.assignment", { worker_assignment: { id: "a1", selected: { provider: "claude", model: "claude-opus-5-5" } } })];
const closing = (second: number) => [
  line(second, "worker.attempt", { selection_assignment_id: "a1", served_model: "claude-opus-5-5", billing_mode: "api", total_cost_usd: 1.5 }),
  line(second + 1, "pr.opened", { pr_url: prUrl }),
  line(second + 2, "verdict", { selection_assignment_id: "a1", verdict: "passed" })];

function stateWith(archiveLines: string[], live: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-case-heartbeat-"));
  if (archiveLines.length) writeFileSync(join(dir, archive), gzipSync(archiveLines.map((row) => `${row}\n`).join("")));
  writeFileSync(join(dir, "ledger.ndjson"), live.map((row) => `${row}\n`).join(""));
  return dir;
}

test("2500 worker.activity rows before one run's verdict still yield an observed case file recording that verdict", async () => {
  const dir = stateWith([], [...opening, ...activity(2500), ...closing(3000)]);
  try {
    const read = await readTaskCaseLedger(dir, taskId, asOf);
    assert.equal(read.state, "observed");
    assert.equal(read.truncated, false);
    assert.equal(read.telemetryRowsDropped, 2500 - MAX_CASE_TELEMETRY_ROWS_PER_STEP);
    assert.equal(read.rows.length, 5 + MAX_CASE_TELEMETRY_ROWS_PER_STEP);
    // The newest heartbeats are the ones kept, and every kept row stays in ledger order.
    const kept = read.rows.filter((row) => row.step === "worker.activity").map((row) => row.ts as string);
    assert.equal(kept[0], at(10 + 2500 - MAX_CASE_TELEMETRY_ROWS_PER_STEP));
    assert.equal(kept.at(-1), at(10 + 2499));
    assert.deepEqual(read.rows.map((row) => row.ts), [...read.rows.map((row) => row.ts as string)].sort());
    assert.equal(read.rows.at(-1)?.step, "verdict");
    const file = buildTaskCaseFile({ task, ledger: read, asOf, prRead: { state: "unavailable", reason: "github-not-read" } });
    assert.equal(file.ledger.state, "observed");
    if (file.ledger.state === "observed") {
      assert.equal(file.ledger.value.telemetryRowsDropped, 2500 - MAX_CASE_TELEMETRY_ROWS_PER_STEP);
      // matchingRows is the task's size, kept or dropped: a smaller number never reads as a smaller task.
      assert.equal(file.ledger.value.matchingRows, 2505);
    }
    assert.equal(file.runs.length, 1);
    assert.deepEqual({ ...file.runs[0] }, { runId, startedAt: at(0), assignmentId: "a1", assignmentIds: ["a1"],
      selectedProvider: "claude", selectedModel: "claude-opus-5-5", servedModel: "claude-opus-5-5", billingMode: "api",
      costUsd: 1.5, verdict: "passed", prNumber: 7560 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a task with more than the bound of evidence rows still refuses as task-row-bound-exceeded", async () => {
  const dir = stateWith([], [...opening, ...activity(50), ...closing(100)]);
  try {
    const refused = await readTaskCaseLedger(dir, taskId, asOf, { maxRows: 4 });
    assert.equal(refused.state, "unavailable");
    assert.equal(refused.reason, "task-row-bound-exceeded");
    assert.equal(refused.truncated, true);
    assert.deepEqual(refused.rows, []);
    const exact = await readTaskCaseLedger(dir, taskId, asOf, { maxRows: 5 });
    assert.equal(exact.state, "observed");
    assert.equal(exact.rows.length, 55);
    assert.equal(exact.telemetryRowsDropped, 0);
    const file = buildTaskCaseFile({ task, ledger: exact, asOf, prRead: { state: "unavailable", reason: "github-not-read" } });
    assert.equal(file.ledger.state === "observed" && "telemetryRowsDropped" in file.ledger.value, false);
    assert.equal(file.ledger.state === "observed" && file.ledger.value.matchingRows, 55);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("each heartbeat step keeps its own newest rows, so a flood of activity never evicts the last worker.state", async () => {
  assert.deepEqual([...CASE_TELEMETRY_STEPS].sort(), ["run.running_long", "worker.activity", "worker.state"]);
  const rows = [...opening, line(5, "worker.state", { state: "active" }), line(6, "run.running_long", { multiplier: 3 }),
    ...activity(40), line(60, "worker.state", { state: "quiet" }), ...activity(40, 70), ...closing(200)];
  const dir = stateWith([], rows);
  try {
    const read = await readTaskCaseLedger(dir, taskId, asOf, { maxRows: 5, maxTelemetryRowsPerStep: 3 });
    assert.equal(read.state, "observed");
    assert.equal(read.telemetryRowsDropped, 77);
    assert.deepEqual(read.rows.filter((row) => row.step === "worker.state").map((row) => row.state), ["active", "quiet"]);
    assert.equal(read.rows.filter((row) => row.step === "run.running_long").length, 1);
    assert.deepEqual(read.rows.filter((row) => row.step === "worker.activity").map((row) => row.ts), [at(107), at(108), at(109)]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a heartbeat replayed by a later rotation after it was dropped is counted once and never re-kept", async () => {
  // The archive holds the older half; the live file replays all of it before the newer half arrives.
  const older = activity(20);
  const newer = activity(10, 100);
  const dir = stateWith([...opening, ...older], [...older, ...newer, ...older.slice(0, 5), ...closing(300)]);
  try {
    const read = await readTaskCaseLedger(dir, taskId, asOf, { maxTelemetryRowsPerStep: 4 });
    assert.equal(read.state, "observed");
    assert.equal(read.telemetryRowsDropped, 26);
    assert.deepEqual(read.rows.filter((row) => row.step === "worker.activity").map((row) => row.ts),
      [at(106), at(107), at(108), at(109)]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a heartbeat with no readable ts is the first dropped, and the batch read counts each task apart", async () => {
  const undated = JSON.stringify({ ts: "not-a-time", task_id: taskId, run_id: runId, step: "worker.activity", event_kind: "assistant-text" });
  const other = "W1-T4652";
  const otherRow = (second: number) => JSON.stringify({ ts: at(second), task_id: other, run_id: `${other}-1`, step: "worker.activity" });
  const dir = stateWith([], [undated, ...opening, ...activity(3), otherRow(1), ...closing(50)]);
  try {
    const reads = await readTaskCaseLedgers(dir, [taskId, other], asOf, { maxTelemetryRowsPerStep: 3 });
    const mine = reads.get(taskId)!;
    assert.equal(mine.telemetryRowsDropped, 1);
    assert.equal(mine.rows.some((row) => row.ts === "not-a-time"), false);
    assert.equal(reads.get(other)!.telemetryRowsDropped, 0);
    assert.equal(reads.get(other)!.rows.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the heartbeat budget must be a positive integer", async () => {
  for (const bad of [0, -1, 1.5]) {
    await assert.rejects(readTaskCaseLedger("/nonexistent-case-heartbeat", taskId, asOf, { maxTelemetryRowsPerStep: bad }),
      /maxTelemetryRowsPerStep/);
  }
});
