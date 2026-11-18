/**
 * W1-T13205: serve's read-model worker shared serve's heap, garbage collector and memory lock as a thread. Behind
 * RMD_READ_MODEL_PROCESS=on it runs as a child process: the same entry, the same message stream, its own heap.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { forkWorkerEntry } from "#src/lib/child-entry-argv.js";
import { createReadModelWorker, READ_MODEL_PROCESS_CHILD_ARG, READ_MODEL_PROCESS_STOP_WAIT_MS, READ_MODEL_PROCESS_SWITCH, threadViews } from "#src/lib/read-model-worker.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

type TestCtx = { after: (fn: () => void | Promise<void>) => void };
const LIVE = "ledger.ndjson";

async function until(done: () => boolean, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(10);
  assert.ok(done(), what);
}

/** A state and ledger dir with one view switched to shadow, and a views module whose body names its process. */
function world(t: TestCtx, kind: string) {
  const stateDir = readModelFixtureDir(t, `${kind}-state`).dir;
  const ledgerDir = readModelFixtureDir(t, `${kind}-ledger`).dir;
  writeFileSync(join(ledgerDir, LIVE), `${JSON.stringify({ ts: new Date().toISOString(), step: "run.start", task_id: "W1-T1", run_id: "boot" })}\n`);
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "switches.json"), JSON.stringify({ views: { whoami: "shadow" } }));
  const modulePath = join(readModelFixtureDir(t, `${kind}-module`).dir, "module.mjs");
  writeFileSync(modulePath, `export default [
  { name: "whoami", version: 1, materialize: () => [{ key: "", data: { pid: process.pid, token: process.env.GH_TOKEN ?? null }, sources: [] }] },
];
`);
  return { stateDir, ledgerDir, viewsModule: pathToFileURL(modulePath).href };
}

/** Set the RMD_READ_MODEL_PROCESS switch for one handle's creation, restoring it after the test. */
function withSwitch(t: TestCtx, value: string | undefined): void {
  const saved = process.env[READ_MODEL_PROCESS_SWITCH];
  t.after(() => { if (saved === undefined) delete process.env[READ_MODEL_PROCESS_SWITCH]; else process.env[READ_MODEL_PROCESS_SWITCH] = saved; });
  if (value === undefined) delete process.env[READ_MODEL_PROCESS_SWITCH];
  else process.env[READ_MODEL_PROCESS_SWITCH] = value;
}

/** forkWorkerEntry, recording each child it starts. */
function recordingFork() {
  const children: Array<ReturnType<typeof forkWorkerEntry>["child"]> = [];
  const fork: typeof forkWorkerEntry = (url, args, options, opts) => {
    const launched = forkWorkerEntry(url, args, options, opts);
    children.push(launched.child);
    return launched;
  };
  return { fork, children };
}

test("W1-T13205 criterion 1: with the switch on, a child process builds the body the handle serves; off, it is a thread", async (t) => {
  const w = world(t, "child-on");
  const { fork, children } = recordingFork();
  let handle: ReturnType<typeof createReadModelWorker> | undefined;
  onReadModelClose(t, () => void handle?.stop());
  withSwitch(t, "on");
  handle = createReadModelWorker({ stateDir: w.stateDir, instances: [{ name: "core", ledgerDir: w.ledgerDir }], viewsModule: w.viewsModule, fork, every: () => () => undefined });
  handle.start();
  await until(() => handle!.body("whoami") !== undefined, "the child's body reached the handle");
  assert.equal(children.length, 1, "one child was forked");
  assert.deepEqual(children[0]!.spawnargs.slice(-1), [READ_MODEL_PROCESS_CHILD_ARG]);
  const pid = (handle.body("whoami")!.body.data as { pid: number }).pid;
  assert.equal(pid, children[0]!.pid, "the body was built in the child process");
  assert.notEqual(pid, process.pid);
  assert.ok(handle.state().instances.size > 0, "state messages arrive from the child");
  handle.stop();

  const off = world(t, "child-off");
  const offFork = recordingFork();
  let thread: ReturnType<typeof createReadModelWorker> | undefined;
  onReadModelClose(t, () => void thread?.stop());
  delete process.env[READ_MODEL_PROCESS_SWITCH];
  thread = createReadModelWorker({ stateDir: off.stateDir, instances: [{ name: "core", ledgerDir: off.ledgerDir }], viewsModule: off.viewsModule, fork: offFork.fork, every: () => () => undefined });
  thread.start();
  await until(() => thread!.body("whoami") !== undefined, "the thread's body reached the handle");
  assert.equal(offFork.children.length, 0, "the switch off forks nothing");
  assert.equal((thread.body("whoami")!.body.data as { pid: number }).pid, process.pid, "positive control: a thread builds in this process");
});

test("W1-T13205 criterion 2: stop() waits for the child's receipt and kills it; a child that dies is respawned", async (t) => {
  const w = world(t, "child-stop");
  const { fork, children } = recordingFork();
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  withSwitch(t, "on");
  const handle = createReadModelWorker({ stateDir: w.stateDir, instances: [{ name: "core", ledgerDir: w.ledgerDir }], viewsModule: w.viewsModule, fork, tickMs: 100,
    every: () => () => undefined, log: (step, extra) => void logs.push({ step, ...(extra ? { extra } : {}) }) });
  onReadModelClose(t, () => void handle.stop());
  handle.start();
  await until(() => handle.body("whoami") !== undefined, "the first child is up");
  children[0]!.kill("SIGKILL");
  await until(() => children.length === 2, "a dead child is respawned");
  assert.ok(logs.some((l) => l.step === "read_model.worker_exited"), "the death is logged with its backoff");
  await until(() => handle.state().instances.size > 0 && children[1]!.connected, "the second child is connected");
  await sleep(500);
  const exited = new Promise<void>((resolve) => children[1]!.once("exit", () => resolve()));
  assert.equal(READ_MODEL_PROCESS_STOP_WAIT_MS, 10_000);
  assert.equal(handle.stop(), true, "the child's stopped receipt arrived within READ_MODEL_PROCESS_STOP_WAIT_MS");
  await exited;
  assert.deepEqual(logs.filter((l) => l.step === "read_model.stop").map((l) => l.extra?.confirmed), [true]);
});

test("W1-T13205 criterion 3: a refreshed GH_TOKEN reaches the child before its next recheck's work", async (t) => {
  const w = world(t, "child-token");
  const saved = process.env.GH_TOKEN;
  t.after(() => { if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved; });
  process.env.GH_TOKEN = "token-one";
  const ticks: Array<() => void> = [];
  withSwitch(t, "on");
  const handle = createReadModelWorker({ stateDir: w.stateDir, instances: [{ name: "core", ledgerDir: w.ledgerDir }], viewsModule: w.viewsModule, tickMs: 100,
    every: (run) => (ticks.push(run), () => undefined) });
  onReadModelClose(t, () => void handle.stop());
  handle.start();
  const token = () => (handle.body("whoami")?.body.data as { token?: string } | undefined)?.token;
  await until(() => token() === "token-one", "the child starts with the parent's token");
  process.env.GH_TOKEN = "token-two";
  for (const run of ticks) run();
  writeFileSync(join(w.ledgerDir, LIVE), `${JSON.stringify({ ts: new Date().toISOString(), step: "run.start", task_id: "W1-T2", run_id: "again" })}\n`, { flag: "a" });
  await until(() => token() === "token-two", "the refreshed token reached the child", 60_000);
});

test("the real view-lane worker enters through the read-model worker module", async (t) => {
  const messages: unknown[] = [];
  const lane = threadViews({
    data: { stateDir: readModelFixtureDir(t, "view-entry").dir, instances: [], tickMs: 20, holder: "view-entry" },
    relay: (message) => messages.push(message),
    log: () => {},
  });
  onReadModelClose(t, () => lane.close());
  lane.state([]);
  lane.want("task", "");
  await until(() => messages.length > 0, "the view-lane worker sent its first message");
});
