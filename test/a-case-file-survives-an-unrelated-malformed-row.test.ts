import assert from "node:assert/strict";
import { createReadStream, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { LedgerUnionStreamIO } from "../src/lib/ledger-union.js";
import type { Task } from "../src/lib/plan.js";
import { caseFileCommand, MAX_CASE_FILE_BATCH_TASKS } from "../src/lib/report-commands.js";
import type { StatusProjection } from "../src/lib/status.js";
import { buildTaskCaseFile, readTaskCaseLedger, readTaskCaseLedgers } from "../src/lib/task-case-file.js";

const asOf = "2026-09-27T14:00:00.000Z";
const archive = "ledger.2026-09-22T16-27-20-296Z.ndjson.gz";
const taskOf = (id: string) => ({ id, title: `Task ${id}`, repo: "remudero", depends_on: [], type: "implement",
  verify: "auto", risk: "high", status: "queued", attempts: 0 }) as Task;
const owned = (taskId: string, suffix = "1790514000000") => JSON.stringify({ ts: "2026-09-27T13:00:00.000Z",
  run_id: `${taskId}-${suffix}`, task_id: taskId, step: "run.start" });
// The 2026-09-27 shape: a truncated DAEMON `sweep.fix` row whose readable prefix still names its identity.
const daemonTorn = '{"ts":"2026-09-20T13:32:26.000Z","run_id":"daemon-1790000000000","task_id":"DAEMON","step":"sweep.fix","pr_nu';

function stateWith(archiveLines: string[], live: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-case-malformed-"));
  writeFileSync(join(dir, archive), gzipSync(archiveLines.map((line) => `${line}\n`).join("")));
  writeFileSync(join(dir, "ledger.ndjson"), live.map((line) => `${line}\n`).join(""));
  return dir;
}

test("an unrelated malformed row leaves the ledger section observed with the malformed count", async () => {
  const dir = stateWith([daemonTorn, owned("W1-T4608", "a")], [owned("W1-T4608", "b")]);
  try {
    const read = await readTaskCaseLedger(dir, "W1-T4608", asOf);
    assert.equal(read.state, "observed");
    assert.equal(read.rows.length, 2);
    assert.equal(read.malformed, 1);
    assert.deepEqual(read.malformedSources, [{ source: archive, form: "gzip", count: 1,
      minTimestamp: "2026-09-20T13:32:26.000Z", maxTimestamp: "2026-09-20T13:32:26.000Z" }]);
    const file = buildTaskCaseFile({ task: taskOf("W1-T4608"), ledger: read, asOf,
      prRead: { state: "unavailable", reason: "github-not-read" } });
    assert.equal(file.ledger.state, "observed");
    if (file.ledger.state === "observed") {
      assert.equal(file.ledger.value.matchingRows, 2);
      assert.equal(file.ledger.value.malformed?.rows, 1);
      assert.equal(file.ledger.value.malformed?.sources[0].source, archive);
    }
    assert.equal(file.runs.length, 2);
    const clean = buildTaskCaseFile({ task: taskOf("W1-T4608"), ledger: { ...read, malformed: 0, malformedSources: undefined },
      asOf, prRead: { state: "unavailable", reason: "github-not-read" } });
    assert.equal(clean.ledger.state === "observed" && "malformed" in clean.ledger.value, false);
    const unsourced = buildTaskCaseFile({ task: taskOf("W1-T4608"), ledger: { ...read, malformedSources: undefined },
      asOf, prRead: { state: "unavailable", reason: "github-not-read" } });
    assert.deepEqual(unsourced.ledger.state === "observed" && unsourced.ledger.value.malformed, { rows: 1, sources: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a malformed row naming the task or one of its runs makes that task's ledger unavailable", async () => {
  const byTaskId = stateWith([owned("W1-T4608", "a"), '{"ts":"2026-09-20T13:32:26.000Z","task_id":"W1-T4608","step":"verd'], []);
  const byRunId = stateWith(['{"ts":"2026-09-20T13:32:26.000Z","run_id":"W1-T4608-1790514000000","st'], []);
  const byMention = stateWith(['{"ts":"2026-09-20T13:32:26.000Z","step":"sweep.fix","branch":"run-W1-T4608-17905'], []);
  try {
    for (const dir of [byTaskId, byRunId, byMention]) {
      const read = await readTaskCaseLedger(dir, "W1-T4608", asOf);
      assert.equal(read.state, "unavailable");
      assert.equal(read.reason, "ledger-source-malformed");
      assert.deepEqual(read.rows, []);
      assert.equal(read.malformed, 1);
    }
    const other = await readTaskCaseLedger(byTaskId, "W1-T4611", asOf);
    assert.equal(other.state, "observed", "another task named nowhere in the damaged row keeps its section");
  } finally {
    for (const dir of [byTaskId, byRunId, byMention]) rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable-identity malformed row inside the window makes the ledger unavailable", async () => {
  const inside = stateWith(['{"ts":"2026-09-20T13:32:26.000Z","step":"sweep.fix","pr_nu'], []);
  const untimed = stateWith(['{"step":"sweep.fix","pr_nu'], []);
  const before = stateWith(['{"ts":"2026-08-01T00:00:00.000Z","step":"sweep.fix","pr_nu',
    '{"ts":"2026-08-02T00:00:00.000Z",BAD', '{"ts":"2026-07-30T00:00:00.000Z",BAD'], []);
  try {
    for (const dir of [inside, untimed]) {
      const read = await readTaskCaseLedger(dir, "W1-T4608", asOf);
      assert.equal(read.state, "unavailable");
      assert.equal(read.reason, "ledger-source-malformed");
    }
    const outside = await readTaskCaseLedger(before, "W1-T4608", asOf);
    assert.equal(outside.state, "observed", "a timed row older than the task's window cannot be the task's");
    assert.deepEqual(outside.malformedSources, [{ source: archive, form: "gzip", count: 3,
      minTimestamp: "2026-07-30T00:00:00.000Z", maxTimestamp: "2026-08-02T00:00:00.000Z" }]);
    const mixed = stateWith(['{"ts":"2026-08-01T00:00:00.000Z",BAD', '{"task_id":"DAEMON",BAD', '{"ts":"2026-08-03T00:00:00.000Z",BAD'], []);
    try {
      const unbounded = await readTaskCaseLedger(mixed, "W1-T4608", asOf);
      assert.equal(unbounded.state, "observed");
      assert.deepEqual(unbounded.malformedSources?.map((entry) => [entry.count, entry.minTimestamp, entry.maxTimestamp]),
        [[3, null, null]], "one untimed damaged row un-bounds its source's time window");
    } finally { rmSync(mixed, { recursive: true, force: true }); }
  } finally {
    for (const dir of [inside, untimed, before]) rmSync(dir, { recursive: true, force: true });
  }
});

test("a batch case-file read streams the ledger once and returns every task under one asOf", async () => {
  const ids = ["W1-T4608", "W1-T4611", "W1-T4620"];
  const dir = stateWith([daemonTorn, owned("W1-T4608", "a"), owned("W1-T4611", "a")], [owned("W1-T4620", "c"), owned("W1-T9", "x")]);
  const opened: string[] = [];
  const io: LedgerUnionStreamIO = { readdirSync: (path) => readdirSync(path), existsSync: (path) => existsSync(path),
    createReadStream: (path, options) => { opened.push(path); return createReadStream(path, options); } };
  try {
    const reads = await readTaskCaseLedgers(dir, ids, asOf, { io });
    assert.deepEqual(opened.length, 2, "one gzip archive plus the live file, opened once for all three tasks");
    assert.deepEqual([...reads.keys()], ids);
    assert.deepEqual([...reads.values()].map((read) => [read.state, read.rows.length, read.malformed]),
      [["observed", 1, 1], ["observed", 1, 1], ["observed", 1, 1]]);
    opened.length = 0;
    const printed: string[] = [];
    const errors: string[] = [];
    const idsFile = join(dir, "ids.txt");
    writeFileSync(idsFile, "W1-T4620\nW1-T4611\n");
    const input = {
      stateDir: dir, nowIso: () => asOf, resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
      readTask: (id: string) => id === "W1-T404" ? undefined : taskOf(id),
      readLedgers: (stateDir: string, taskIds: readonly string[], at: string) => readTaskCaseLedgers(stateDir, taskIds, at, { io }),
      readProjection: (task: Task) => ({ taskId: task.id, status: "queued", merged: false, source: "none" }) as StatusProjection,
      readPr: () => { throw new Error("must not read a PR without a projected one"); },
      out: (line: string) => printed.push(line), err: (line: string) => errors.push(line),
    };
    assert.equal(await caseFileCommand(["--tasks", "W1-T4608,W1-T4611", "--tasks-file", idsFile, "--json"], input), 0);
    assert.equal(opened.length, 2, "the verb's batch form is one union pass");
    const files = JSON.parse(printed[0]) as Array<{ version: string; taskId: string; asOf: string; ledger: { state: string } }>;
    assert.deepEqual(files.map((file) => file.taskId), ["W1-T4608", "W1-T4611", "W1-T4620"]);
    assert.deepEqual([...new Set(files.map((file) => file.asOf))], [asOf]);
    assert.ok(files.every((file) => file.version === "task-case-file-v1" && file.ledger.state === "observed"));
    const tooMany = Array.from({ length: MAX_CASE_FILE_BATCH_TASKS + 1 }, (_, index) => `W1-T${index + 1}`).join(",");
    for (const args of [["--tasks", "W1-T1,nope"], ["--tasks", ","], ["--tasks", tooMany], ["--tasks"],
      ["W1-T1", "--tasks", "W1-T2"], ["--tasks-file", join(dir, "absent.txt")]]) {
      assert.equal(await caseFileCommand(args, input), 2, args.join(" "));
    }
    assert.match(errors.join("\n"), /nope is not a task id[\s\S]*no task ids given[\s\S]*exceed the batch bound[\s\S]*unexpected argument --tasks[\s\S]*unexpected argument W1-T1[\s\S]*absent\.txt is unreadable/);
    assert.equal(await caseFileCommand(["--tasks", "W1-T4608,W1-T404"], input), 2);
    assert.match(errors.at(-1) ?? "", /W1-T404 is not in the plan/);
    assert.equal(await caseFileCommand(["W1-T4608", "--bogus"], input), 2);
    assert.match(errors.at(-1) ?? "", /expected <task-id> \[--json\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
