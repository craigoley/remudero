import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { makeTempDir } from "../src/lib/tmp.js";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");
const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(repo, "src/lib", `${name}.ts`)).href);

test("production worker adapters survive a parent heap flag and retain the TypeScript loader", async (t) => {
  const root = makeTempDir("worker-heap-inheritance");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan/tasks.yaml"), "[]\n");
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  // Read-model protocol fixtures exercise the real spawn adapters without opening GitHub issues
  // or requiring a database lease. Config, console and board below use their actual TS workers.
  const probe = join(root, "protocol.mjs");
  writeFileSync(probe, `
import { parentPort, workerData, threadId } from 'node:worker_threads';
const kind = workerData.kind;
if (kind === 'remudero-read-model-integrity') parentPort.postMessage({ ok: true, ms: threadId });
else if (kind === 'remudero-read-model-issue') parentPort.postMessage({ url: 'fixture-only' });
else {
  if (kind === 'remudero-read-model-views') parentPort.postMessage({ type: 'probe', threadId });
  if (kind === 'remudero-read-model') parentPort.postMessage({ type: 'probe', threadId });
  parentPort.on('message', msg => {
    if (msg.type === 'check') parentPort.postMessage({ type: 'done', id: msg.id, result: { ok: true, rows: threadId, elapsedMs: 0 } });
    if (msg.type === 'stop') {
      if (workerData.signal) { const signal = new Int32Array(workerData.signal); Atomics.store(signal, 1, 1); Atomics.notify(signal, 1); }
      parentPort.close();
    }
  });
}
`);
  const child = join(root, "parent.mjs");
  writeFileSync(child, `
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { configInventory } from ${moduleUrl("config-gardener")};
import { startConsoleProjectionWorker } from ${moduleUrl("console-projection-worker")};
import { createBoardProjectionWorker } from ${moduleUrl("board-worker")};
import { createReadModelWorker, threadIntegrityCheck, threadIssueRequest, threadOracle, threadViews } from ${moduleUrl("read-model-worker")};
import { trackWorkerThreads } from ${moduleUrl("serve-memory")};
const root = ${JSON.stringify(root)}, stateDir = ${JSON.stringify(stateDir)}, planPath = ${JSON.stringify(join(root, "plan/tasks.yaml"))};
const workerUrl = new URL(${JSON.stringify(pathToFileURL(probe).href)});
const book = trackWorkerThreads(), stops = [];
// A ref'd deadline also holds the parent alive while one-shot adapters unref their workers.
const deadline = setTimeout(() => { throw new Error('worker adapters did not settle'); }, 25000);
try {
  assert.ok(process.execArgv.includes('--max-old-space-size=2048'));
  assert.deepEqual((await configInventory({ repoRoot: root, stateDir, log: () => {} })).runs, []);
  const console = startConsoleProjectionWorker(); stops.push(() => console.stop());
  const feedback = await console.feedback({ root, planPath });
  assert.equal(feedback.ok, true); assert.ok(feedback.threadId > 0);
  const github = { readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [], listOpenHeadBranches: () => [],
    headRefName: () => undefined, prBody: () => undefined };
  const board = createBoardProjectionWorker(github, { planPath, ledgerPath: stateDir + '/ledger.ndjson', inflightDir: stateDir });
  stops.push(() => board.stop()); board.start();
  for (let n = 0; n < 400 && !board.isReady(); n++) await pause(10);
  assert.equal(board.current().state, 'ready', JSON.stringify(board.current()));
  const integrity = await new Promise(resolve => threadIntegrityCheck(workerUrl)({}, resolve));
  assert.equal(integrity.ok, true); assert.ok(integrity.ms > 0);
  assert.deepEqual(await threadIssueRequest(workerUrl)({}), { url: 'fixture-only' });
  const oracle = threadOracle({ workerUrl, log: () => {} }); stops.push(() => oracle.close());
  const slice = await new Promise(resolve => oracle.run({}, resolve));
  assert.equal(slice.ok, true); assert.ok(slice.rows > 0);
  let viewResolve;
  const viewReady = new Promise(resolve => viewResolve = resolve);
  const views = threadViews({ workerUrl, data: { stateDir, instances: [], tickMs: 100, holder: 'fixture' },
    relay: msg => viewResolve(msg), log: () => {}, every: () => () => {} });
  stops.push(() => views.close()); assert.ok((await viewReady).threadId > 0);
  let mainResolve;
  const mainReady = new Promise(resolve => mainResolve = resolve);
  const main = createReadModelWorker({ stateDir, instances: [], workerUrl, every: () => () => {},
    observe: msg => mainResolve(msg) });
  stops.push(() => main.stop()); main.start(); assert.ok((await mainReady).threadId > 0);
  process.stdout.write(JSON.stringify({ adapters: 8, node: process.version }));
} finally {
  for (const stop of stops.reverse()) stop();
  await Promise.all(book.live().map(({ thread }) => thread.terminate()));
  book.stop(); clearTimeout(deadline);
}
`);
  const { stdout } = await exec(process.execPath, ["--max-old-space-size=2048", "--import", "tsx", child],
    { cwd: repo, timeout: 35_000, maxBuffer: 1024 * 1024 });
  assert.deepEqual(JSON.parse(stdout), { adapters: 8, node: process.version });
});
