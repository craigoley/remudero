import assert from "node:assert/strict";
import { createReadStream, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { test, type TestContext } from "node:test";
import { recoverPromisedFollowUpReports, type PromisedFollowUpObservation } from "#src/lib/review.js";
import { makeTempDir } from "#src/lib/tmp.js";

const taskId = "W1-T8775", prUrl = "https://github.com/o/r/pull/11255";
const firstRun = "2026-10-12T10:00:00.000Z";
const observation: PromisedFollowUpObservation = {
  state: "complete", promised: [{ path: "docs/adr/example.md", text: "file the child task", taskId }], planRecords: [],
};
const line = (row: object) => JSON.stringify(row) + "\n";
function fixture(t: TestContext) {
  const dir = makeTempDir("promise-damage");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const start = line({ ts: firstRun, step: "run.start", task_id: taskId, run_id: taskId + "-123" });
  writeFileSync(ledgerPath, start);
  return { dir, ledgerPath, taskId, prUrl, prCreatedAt: firstRun, start };
}

test("a promise harvest ignores malformed rotations and live tails owned by another task", async t => {
  const args = fixture(t);
  const foreign = '{"task_id":"W1-T9007","step":"report.followups",broken}\n';
  writeFileSync(join(args.dir, "ledger.2026-10-12T11-00-00-000Z.ndjson"), foreign);
  writeFileSync(join(args.dir, "ledger.2026-10-12T12-00-00-000Z.ndjson.gz"), gzipSync(foreign));
  writeFileSync(args.ledgerPath, args.start + '{"run_id":"W1-T9007-123","step":"worker.activity",');
  const opened: string[] = [];
  const result = await recoverPromisedFollowUpReports(observation, { ...args, io: {
    readdirSync, existsSync, createReadStream: (path, options) => { opened.push(basename(path)); return createReadStream(path, options); },
  } });
  assert.deepEqual(opened, ["ledger.ndjson", "ledger.2026-10-12T11-00-00-000Z.ndjson", "ledger.2026-10-12T12-00-00-000Z.ndjson.gz"], "coverage control: the same absence sweep read every corpus form");
  assert.equal(result.state, "complete", "foreign damage cannot turn this task's proven absence into a pending review");
  if (result.state === "complete") {
    assert.equal(result.harvestCorpusComplete, true);
    assert.deepEqual(result.harvested, []);
  }
  const entries = [{ type: "task", text: observation.promised[0]!.text }];
  writeFileSync(join(args.dir, "ledger.2026-10-12T11-00-00-000Z.ndjson"), foreign + line({ task_id: taskId, pr_url: prUrl, step: "report.followups", entries }));
  const found = await recoverPromisedFollowUpReports(observation, args);
  assert.equal(found.state, "complete");
  if (found.state === "complete") assert.deepEqual(found.harvested, entries, "positive control: this same query finds its own report");
});

test("a promise harvest ignores anonymous archive damage before its age bound", async t => {
  const args = fixture(t);
  writeFileSync(join(args.dir, "ledger.2026-10-12T11-00-00-000Z.ndjson"), '{"ts":"2026-10-12T09:00:00.000Z",broken}\n');
  const result = await recoverPromisedFollowUpReports(observation, args);
  assert.equal(result.state, "complete");
  if (result.state === "complete") assert.equal(result.harvestCorpusComplete, true);
});

test("a promise harvest names unread archives, could-belong malformed rows and live torn tails separately", async t => {
  const args = fixture(t);
  const own = `{"task_id":"${taskId}","step":"report.followups",broken}\n`;
  writeFileSync(join(args.dir, "ledger.2026-10-12T11-00-00-000Z.ndjson"), own + '{anonymous damage}\n');
  writeFileSync(join(args.dir, "ledger.2026-10-12T12-00-00-000Z.ndjson.gz"), "not gzip");
  writeFileSync(args.ledgerPath, args.start + `{"task_id":"${taskId}","step":"report.followups",`);
  const result = await recoverPromisedFollowUpReports(observation, args);
  assert.equal(result.state, "unknown", "own and unidentified damage still cannot prove absence");
  if (result.state === "unknown") {
    assert.equal(result.cause, "promise-harvest-incomplete");
    assert.match(result.reason, /unread archives: 1/);
    assert.match(result.reason, /could-belong malformed rows: 2/);
    assert.match(result.reason, /live torn tails: 1/);
  }
});

test("a promise harvest keeps unidentified live tails and names live read failures", async t => {
  const args = fixture(t);
  writeFileSync(args.ledgerPath, args.start + '{unidentified tail');
  const torn = await recoverPromisedFollowUpReports(observation, args);
  assert.equal(torn.state, "unknown");
  if (torn.state === "unknown") assert.match(torn.reason, /live torn tails: 1/);
  const unread = await recoverPromisedFollowUpReports(observation, { ...args, io: {
    readdirSync, existsSync, createReadStream: (path, options) => {
      if (basename(path) === "ledger.ndjson") throw new Error("EACCES");
      return createReadStream(path, options);
    },
  } });
  assert.equal(unread.state, "unknown");
  if (unread.state === "unknown") {
    assert.match(unread.reason, /unread live: 1/);
    assert.match(unread.reason, /live not observed: true/);
  }
});

test("a promise harvest still refuses invalid own report values and identifies the gap", async t => {
  const args = fixture(t);
  writeFileSync(args.ledgerPath, args.start + line({ task_id: taskId, pr_url: prUrl, step: "report.followups", entries: [null] }));
  const result = await recoverPromisedFollowUpReports(observation, args);
  assert.equal(result.state, "unknown");
  if (result.state === "unknown") assert.match(result.reason, /invalid follow-up values: 1/);
});
