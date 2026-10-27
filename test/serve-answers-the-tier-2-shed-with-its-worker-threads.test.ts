/**
 * W1-T9508: the supervisor's memory tier 2 (W1-T8873) asks the ACTIVE generation to shed its worker threads, and on
 * 10-13/14 none of 122 asks was answered: no generation registered `onShedWorkersRequest`, so each timed out. A
 * supervised serve now answers it: the read model's worker (its views lanes, slow lane and oracle with it) and the board
 * projection exit, the reply counts and sizes them, and a restore starts them again.
 *
 * The falsifier: drop the registration in src/run-task.ts and the shed is never answered.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBoardProjectionWorker } from "#src/lib/board-worker.js";
import { createReadModelWorker } from "#src/lib/read-model-worker.js";
import { GENERATION_MESSAGES, type GenerationMessage } from "#src/lib/serve-generation.js";
import { workerThreads } from "#src/lib/worker-heaps.js";
import { serveCommand } from "#src/run-task.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const BOARD_BRANCH_LISTS = { listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], findMergedByHeadBranch: () => [] };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const gatewayShim = ghShim([{ when: "api ", stdout: "[]" }], { kind: "tier-2-shed-gh" });
const READ_MODEL = /^read-model-worker:/;
const BOARD = /^board-worker:/;
const live = (kind: RegExp): number => workerThreads().live().filter((worker) => kind.test(worker.kind)).length;

async function until(what: string, ok: () => boolean, boundMs = 30_000): Promise<void> {
  for (const deadline = Date.now() + boundMs; Date.now() < deadline; await sleep(25)) if (ok()) return;
  assert.fail(`timed out waiting for ${what}; live threads: ${workerThreads().live().map((worker) => worker.kind).join(", ")}`);
}

/** The threads are counted process-wide: an earlier test's serve stops its own as it closes. */
const quiet = (): Promise<void> => until("an earlier test's threads to exit", () => live(READ_MODEL) === 0 && live(BOARD) === 0);

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function overSocket(socketPath: string, path: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.setTimeout(5_000, () => req.destroy(new Error(`private serve request timed out: ${path}`)));
    req.on("error", reject);
    req.end();
  });
}

test("W1-T9508: serve answers the tier-2 shed with its worker threads", { timeout: 240_000 }, async (t) => {
  workerThreads(); // the book subscribes on first call: before serve spawns anything
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), "rmd-tier2-shed-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT, serve: { host: "127.0.0.1", port } }));
  const socketPath = join(home, "gen.sock");
  const saved = { HOME: process.env.HOME, role: process.env.RMD_SERVE_ROLE, socket: process.env.RMD_SERVE_READY_SOCKET };
  process.env.HOME = home;
  process.env.RMD_SERVE_ROLE = "standby";
  process.env.RMD_SERVE_READY_SOCKET = socketPath;
  const realLog = console.log;
  const realErr = console.error;
  console.log = () => {};
  console.error = () => {};

  const sent: GenerationMessage[] = [];
  const listeners: Array<(m: GenerationMessage) => void> = [];
  const tell = (message: GenerationMessage): void => listeners.forEach((listener) => listener(message));
  const reply = (type: string): GenerationMessage | undefined => sent.find((m) => m.type === type);
  // The production composition: the real gateway (over a gh shim), so the board projection thread and the read model's
  // slow lane run as they do in serve.
  const running = serveCommand([], {
    branch: () => "main",
    boardGhBin: join(gatewayShim.dir, "gh"),
    generation: { send: (m) => void sent.push(m), onMessage: (l) => void listeners.push(l) },
  });
  let stopping: Promise<void> | undefined;
  const stopServe = (): Promise<void> => stopping ??= (async () => {
    if (!reply(GENERATION_MESSAGES.promoted)) tell({ type: GENERATION_MESSAGES.promote });
    await until("the promote before teardown", () => reply(GENERATION_MESSAGES.promoted) !== undefined, 20_000).catch(() => {});
    process.emit("SIGTERM");
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      running.then(() => true, () => true),
      new Promise<boolean>((resolve) => { stopTimer = setTimeout(() => resolve(false), 10_000); }),
    ]);
    if (stopTimer) clearTimeout(stopTimer);
    console.log = realLog;
    console.error = realErr;
    process.env.HOME = saved.HOME;
    for (const [key, value] of [["RMD_SERVE_ROLE", saved.role], ["RMD_SERVE_READY_SOCKET", saved.socket]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!stopped) {
      console.error("tier-2 shed serve teardown could not stop the process");
      process.exit(1);
    }
  })();
  t.after(stopServe);

  let ready: number | undefined;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && ready === undefined; await sleep(100)) {
    ready = await overSocket(socketPath, "/v1/ready").catch(() => undefined);
  }
  assert.ok(ready, "the standby answers readiness on its private socket");
  tell({ type: GENERATION_MESSAGES.promote });
  await until("the promote", () => reply(GENERATION_MESSAGES.promoted) !== undefined);
  await until("the read model and board threads", () => live(READ_MODEL) > 0 && live(BOARD) > 0, 60_000);

  tell({ type: GENERATION_MESSAGES.shed_workers });
  await until("the tier-2 shed answer", () => reply(GENERATION_MESSAGES.shed_workers_done) !== undefined, 15_000);
  const done = reply(GENERATION_MESSAGES.shed_workers_done)!;
  t.diagnostic(`shed answer: ${JSON.stringify(done)}`);
  assert.equal(done.error, undefined, `the shed did not fail: ${String(done.error)}`);
  assert.ok(Number(done.workers) >= 2, `the read model and the board projection were shed, nested threads counted: ${JSON.stringify(done)}`);
  assert.ok(Number(done.heapBytes) > 0, "the reply sizes the heaps it shed, as last read");
  assert.equal(typeof done.beforeBytes, "number");
  assert.equal(live(READ_MODEL), 0, "the read model's worker has exited");
  assert.equal(live(BOARD), 0, "the board projection's worker has exited");
  const ledger = (): string => readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
  assert.match(ledger(), /"step":"read_model\.paused"/);
  assert.match(ledger(), /"step":"serve\.workers_shed"/);

  tell({ type: GENERATION_MESSAGES.restore_workers, reason: "handoff_abandoned" });
  await until("the tier-2 restore answer", () => reply(GENERATION_MESSAGES.restore_workers_done) !== undefined, 15_000);
  assert.equal(reply(GENERATION_MESSAGES.restore_workers_done)!.error, undefined);
  await until("the threads to start again", () => live(READ_MODEL) > 0 && live(BOARD) > 0);
  assert.match(ledger(), /"step":"serve\.workers_restored",.*"reason":"handoff_abandoned"/, "the restore ledgers why");
});

test("W1-T9508: a board projection pause keeps its snapshot, and resume starts the thread again", { timeout: 30_000 }, async (t) => {
  await quiet();
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-pause-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, "- id: W1-T1\n  title: pause fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n");
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const board = createBoardProjectionWorker(fakeGitHub(BOARD_BRANCH_LISTS), { planPath, ledgerPath, inflightDir: join(dir, "inflight") }, { intervalMs: 60_000 });
  t.after(() => board.stop());
  assert.equal(await board.pause(), false, "nothing running: nothing to pause");
  board.resume();
  assert.equal(live(BOARD), 0, "a resume with nothing paused starts nothing");
  board.start();
  await until("the first snapshot", () => board.isReady(), 20_000);
  assert.equal(await board.pause(), true);
  assert.equal(live(BOARD), 0);
  assert.equal(board.current().state, "ready", "the last snapshot is kept, dated by its generated_at");
  board.resume();
  assert.equal(live(BOARD), 1);
  board.stop();
  assert.equal(await board.pause(), false, "a stopped projection never pauses");
});

test("W1-T9508: a read model pause that the worker never confirms still terminates it", { timeout: 30_000 }, async (t) => {
  await quiet();
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-read-model-pause-"));
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const silent = new URL("data:text/javascript,setInterval(() => {}, 1000)");
  const model = createReadModelWorker({ stateDir, instances: [], tickMs: 60_000, workerUrl: silent, stopWaitMs: 50, log: (step, extra) => void steps.push({ step, extra }) });
  t.after(() => void model.stop());
  assert.equal(await model.pause!(), false, "never started: nothing to pause");
  model.resume!();
  assert.equal(live(READ_MODEL), 0, "a resume with nothing paused starts nothing");
  model.start();
  assert.equal(live(READ_MODEL), 1);
  assert.equal(await model.pause!(), true);
  assert.equal(live(READ_MODEL), 0, "the worker has exited when the pause resolves");
  assert.deepEqual(steps.find((s) => s.step === "read_model.paused")?.extra, { confirmed: false }, "the bound, not the worker, ended the wait");
  assert.equal(await model.pause!(), false, "a second pause is a no-op");
  model.start();
  assert.equal(live(READ_MODEL), 0, "start() does not undo a pause");
  model.resume!();
  assert.equal(live(READ_MODEL), 1, "resume starts the worker again");
  model.stop();
  assert.equal(await model.pause!(), false, "a stopped model never pauses");
  model.resume!();
});

test("W1-T9508: a read model whose worker died is paused through its pending respawn", { timeout: 30_000 }, async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-read-model-dead-"));
  const steps: string[] = [];
  const exits = (): number => steps.filter((step) => step === "read_model.worker_exited").length;
  const dies = new URL("data:text/javascript,");
  const model = createReadModelWorker({ stateDir, instances: [], tickMs: 100, workerUrl: dies, log: (step) => void steps.push(step) });
  t.after(() => void model.stop());
  model.start();
  await until("the first death", () => exits() >= 1);
  const died = exits();
  assert.equal(await model.pause!(), false, "no worker to terminate");
  await sleep(500);
  assert.equal(exits(), died, "the pending respawn was cancelled");
  model.resume!();
  await until("the worker to start again", () => exits() > died);
  model.stop();
});
