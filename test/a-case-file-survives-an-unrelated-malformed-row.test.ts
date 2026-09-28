import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { openLedgerUnion } from "../src/lib/ledger-union.js";
import { buildTaskCaseFile, readTaskCaseLedger, readTaskCaseLedgers } from "../src/lib/task-case-file.js";
import { caseFileBatchCommand } from "../src/run-task.js";
import type { Task } from "../src/lib/plan.js";
import type { StatusProjection } from "../src/lib/status.js";

const asOf = "2026-09-27T14:00:00.000Z";
const taskId = "W1-T4607";
const otherId = "W1-T4608";
const row = (id: string) => JSON.stringify({ ts: "2026-09-27T13:00:00.000Z", task_id: id,
  run_id: `${id}-1790514000000`, step: "run.start" }) + "\n";
const damaged = (id: string) => `{"ts":"2026-09-27T13:01:00.000Z","task_id":"${id}","run_id":"${id}-1790514000000",`;

test("unrelated malformed archived row leaves the case-file ledger observed with its source and count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-case-unrelated-"));
  const source = join(dir, "ledger.2026-09-27T13-10-00-000Z.ndjson.gz");
  writeFileSync(source, gzipSync(row(taskId) + damaged("DAEMON") + "\n"));
  const ledger = await readTaskCaseLedger(dir, taskId, asOf);
  assert.equal(ledger.state, "observed");
  assert.equal(ledger.malformed, 1);
  assert.deepEqual(ledger.malformedSources, [source]);
  const task = { id: taskId, title: "Case file", repo: "remudero", depends_on: [], type: "implement",
    verify: "auto", risk: "high", status: "queued", attempts: 0 } as Task;
  const file = buildTaskCaseFile({ task, ledger, prRead: { state: "unavailable", reason: "offline" }, asOf });
  assert.equal(file.ledger.state, "observed");
  assert.equal(file.runs.length, 1);
  if (file.ledger.state === "observed") {
    assert.equal(file.ledger.value.malformed, 1);
    assert.deepEqual(file.ledger.value.malformedSources, [source]);
  }
});

test("malformed row naming a task or lacking a readable timestamp keeps its ledger unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-case-owned-"));
  writeFileSync(join(dir, "ledger.ndjson"), row(taskId) + damaged(taskId) + "\n");
  const owned = await readTaskCaseLedger(dir, taskId, asOf);
  assert.equal(owned.state, "unavailable");
  assert.equal(owned.reason, "ledger-source-malformed");
  writeFileSync(join(dir, "ledger.ndjson"), row(taskId) + "{bad-json}\n");
  const ambiguous = await readTaskCaseLedger(dir, taskId, asOf);
  assert.equal(ambiguous.state, "unavailable");
  assert.equal(ambiguous.reason, "ledger-source-malformed");
});

test("a damaged prefix naming only a task-owned run id still makes that task unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-case-run-prefix-"));
  writeFileSync(join(dir, "ledger.2026-09-27T13-10-00-000Z.ndjson.gz"), gzipSync(
    `{"ts":"2026-09-27T13:01:00.000Z","run_id":"${taskId}-1790514000000",\n`));
  const owned = await readTaskCaseLedger(dir, taskId, asOf);
  const unrelated = await readTaskCaseLedger(dir, otherId, asOf);
  assert.equal(owned.reason, "ledger-source-malformed");
  assert.equal(unrelated.state, "observed");
});

test("a malformed row dated before the task ledger window cannot invalidate its current rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-case-old-row-"));
  writeFileSync(join(dir, "ledger.2026-09-27T13-10-00-000Z.ndjson.gz"), gzipSync(
    `{"ts":"2026-07-01T13:01:00.000Z","task_id":"${taskId}",\n` + row(taskId)));
  const result = await readTaskCaseLedger(dir, taskId, asOf);
  assert.equal(result.state, "observed");
  assert.equal(result.malformed, 1);
  assert.equal(result.rows.length, 1);
});

test("malformed metadata reaching its memory bound refuses classification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-case-malformed-bound-"));
  writeFileSync(join(dir, "ledger.2026-09-27T13-10-00-000Z.ndjson.gz"), gzipSync(
    damaged("DAEMON") + "\n" + damaged("DAEMON") + "\n"));
  const result = await readTaskCaseLedger(dir, taskId, asOf, { maxRows: 1 });
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "ledger-malformed-bound-exceeded");
  assert.equal(result.malformed, 2);
});

test("batch ledger read streams the union once for every requested task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-case-batch-"));
  writeFileSync(join(dir, "ledger.ndjson"), row(taskId) + row(otherId));
  writeFileSync(join(dir, "ledger.2026-09-27T13-10-00-000Z.ndjson.gz"), gzipSync(damaged("DAEMON") + "\n"));
  let streams = 0;
  const ledgers = await readTaskCaseLedgers(dir, [taskId, otherId], asOf, {
    openUnion: (stateDir, options) => { streams += 1; return openLedgerUnion(stateDir, options); },
  });
  assert.equal(streams, 1);
  assert.deepEqual([...ledgers.keys()], [taskId, otherId]);
  assert.deepEqual([...ledgers.values()].map((ledger) => ledger.rows.length), [1, 1]);
  assert.deepEqual([...ledgers.values()].map((ledger) => ledger.state), ["observed", "observed"]);
  assert.deepEqual([...ledgers.values()].map((ledger) => ledger.asOf), [asOf, asOf]);
});

test("--tasks emits a task-case-file-v1 array with one shared asOf", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-case-cli-batch-"));
  writeFileSync(join(dir, "ledger.ndjson"), row(taskId) + row(otherId));
  const printed: string[] = [];
  let clockReads = 0;
  const code = await caseFileBatchCommand(["--tasks", `${taskId},${otherId}`, "--json"], {
    stateDir: dir, nowIso: () => { clockReads += 1; return asOf; },
    readTask: (id) => ({ id, title: id, repo: "remudero", depends_on: [], type: "implement",
      verify: "auto", risk: "high", status: "queued", attempts: 0 } as Task),
    readProjection: (task) => ({ taskId: task.id, status: "queued", merged: false, source: "none" } as StatusProjection),
    resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    buildGithub: () => ({} as never),
    out: (line) => printed.push(line),
  });
  assert.equal(code, 0);
  assert.equal(clockReads, 1);
  assert.equal(printed.length, 1);
  const files = JSON.parse(printed[0]);
  assert.deepEqual(files.map((file: { taskId: string }) => file.taskId), [taskId, otherId]);
  assert.deepEqual(files.map((file: { version: string; asOf: string }) => [file.version, file.asOf]),
    [["task-case-file-v1", asOf], ["task-case-file-v1", asOf]]);
  assert.deepEqual(files.map((file: { ledger: { state: string } }) => file.ledger.state), ["observed", "observed"]);
});
