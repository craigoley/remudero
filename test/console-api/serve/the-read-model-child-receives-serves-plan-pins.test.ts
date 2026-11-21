/**
 * W1-T14052: serve hands its threads the plan it pinned on a BroadcastChannel, which reaches only serve's own
 * process. In read-model process mode (W1-T13205) the child heard no pin, so each view check statted every plan
 * file and its views read the generation's unmoving working tree, not the commit serve's main thread follows.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { forkWorkerEntry } from "#src/lib/child-entry-argv.js";
import { mergePlanBlobsQuarantiningDuplicates } from "#src/lib/plan.js";
import { createReadModelWorker, READ_MODEL_PROCESS_SWITCH } from "#src/lib/read-model-worker.js";
import { packPlanBlobs } from "#src/lib/serve-plan-reload.js";
import { PLAN_PIN_ADOPTED_STEP, publishThreadPlan } from "#src/lib/thread-plan.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type TestCtx = { after: (fn: () => void | Promise<void>) => void };
const LIVE = "ledger.ndjson";

const record = (id: string): string => [
  `- id: ${id}`, "  title: pinned fixture", "  repo: remudero", "  depends_on: []",
  "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", "",
].join("\n");

async function until(done: () => boolean, what: string, poke: () => void, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    poke();
    await sleep(50);
  }
  assert.ok(done(), what);
}

/** A slot whose working tree holds only W1-T1, a ledger, and a views module reporting the plan its process sees. */
function world(t: TestCtx, kind: string) {
  const stateDir = readModelFixtureDir(t, `${kind}-state`).dir;
  const ledgerDir = readModelFixtureDir(t, `${kind}-ledger`).dir;
  const repoDir = readModelFixtureDir(t, `${kind}-repo`).dir;
  mkdirSync(join(repoDir, "plan"), { recursive: true });
  const planPath = join(repoDir, "plan", "tasks.yaml");
  writeFileSync(planPath, record("W1-T1"));
  writeFileSync(join(ledgerDir, LIVE), `${JSON.stringify({ ts: new Date().toISOString(), step: "run.start", task_id: "W1-T1", run_id: "boot" })}\n`);
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "switches.json"), JSON.stringify({ views: { planseen: "shadow" } }));
  const modulePath = join(readModelFixtureDir(t, `${kind}-module`).dir, "module.mjs");
  const threadPlanUrl = pathToFileURL(join(REPO_ROOT, "src", "lib", "thread-plan.ts")).href;
  writeFileSync(modulePath, `import { threadPlan, threadPlanPin } from ${JSON.stringify(threadPlanUrl)};
const planPath = ${JSON.stringify(planPath)};
export default [
  { name: "planseen", version: 1, materialize: () => [{ key: "", data: { pid: process.pid, pin: threadPlanPin(planPath),
    ids: threadPlan(planPath).tasks.map((task) => task.id) }, sources: [] }] },
];
`);
  const poke = (): void => writeFileSync(join(ledgerDir, LIVE), `${JSON.stringify({ ts: new Date().toISOString(), step: "run.start", task_id: "W1-T1", run_id: "poke" })}\n`, { flag: "a" });
  return { stateDir, ledgerDir, repoDir, planPath, viewsModule: pathToFileURL(modulePath).href, poke };
}

/** What serve's main thread does after reloadServePlan: publish the plan it read at `ref` to every thread. */
function pin(fixture: ReturnType<typeof world>, ref: string, ids: string[]): void {
  const blobs = [{ label: `${ref}:plan/tasks.yaml`, text: ids.map(record).join("") }];
  const read = mergePlanBlobsQuarantiningDuplicates(blobs);
  publishThreadPlan({ path: fixture.planPath, repoDir: fixture.repoDir, ref }, { ...read, text: packPlanBlobs(blobs) });
}

function withSwitch(t: TestCtx, value: string): void {
  const saved = process.env[READ_MODEL_PROCESS_SWITCH];
  t.after(() => { if (saved === undefined) delete process.env[READ_MODEL_PROCESS_SWITCH]; else process.env[READ_MODEL_PROCESS_SWITCH] = saved; });
  process.env[READ_MODEL_PROCESS_SWITCH] = value;
}

test("W1-T14052 criterion 1: a read-model child process's views read the plan serve pinned, before and after it starts", async (t) => {
  const w = world(t, "pin-child");
  const children: Array<ReturnType<typeof forkWorkerEntry>["child"]> = [];
  const fork: typeof forkWorkerEntry = (url, args, options, opts) => {
    const launched = forkWorkerEntry(url, args, options, opts);
    children.push(launched.child);
    return launched;
  };
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  withSwitch(t, "on");
  pin(w, "sha-one", ["W1-T1", "W1-T2"]);
  const handle = createReadModelWorker({ stateDir: w.stateDir, instances: [{ name: "core", ledgerDir: w.ledgerDir }], viewsModule: w.viewsModule, fork,
    tickMs: 100, every: () => () => undefined, log: (step, extra) => void logs.push({ step, ...(extra ? { extra } : {}) }) });
  onReadModelClose(t, () => void handle.stop());
  handle.start();
  const seen = () => handle.body("planseen")?.body.data as { pid: number; pin: string; ids: string[] } | undefined;
  await until(() => seen()?.pin === `ref:${w.repoDir}@sha-one`, "a pin published before the child started reached its views", w.poke);
  assert.equal(seen()!.pid, children[0]!.pid, "positive control: the view was built in the child process");
  assert.deepEqual(seen()!.ids, ["W1-T1", "W1-T2"], "the views read the pinned commit, not the working tree's one task");
  pin(w, "sha-two", ["W1-T1", "W1-T2", "W1-T3"]);
  await until(() => seen()?.pin === `ref:${w.repoDir}@sha-two`, "a pin published while the child runs reached its views", w.poke);
  assert.deepEqual(seen()!.ids, ["W1-T1", "W1-T2", "W1-T3"]);
  assert.ok(logs.some((l) => l.step === PLAN_PIN_ADOPTED_STEP && l.extra?.ref === "sha-two"), "the child's adoption is logged in serve's ledger");
});

test("W1-T14052 invariant: a respawned read-model child starts on the newest pin serve published", async (t) => {
  const w = world(t, "pin-respawn");
  const children: Array<ReturnType<typeof forkWorkerEntry>["child"]> = [];
  const fork: typeof forkWorkerEntry = (url, args, options, opts) => {
    const launched = forkWorkerEntry(url, args, options, opts);
    children.push(launched.child);
    return launched;
  };
  withSwitch(t, "on");
  const handle = createReadModelWorker({ stateDir: w.stateDir, instances: [{ name: "core", ledgerDir: w.ledgerDir }], viewsModule: w.viewsModule, fork,
    tickMs: 100, every: () => () => undefined });
  onReadModelClose(t, () => void handle.stop());
  handle.start();
  const seen = () => handle.body("planseen")?.body.data as { pid: number; pin: string; ids: string[] } | undefined;
  await until(() => seen() !== undefined, "the first child built the view", w.poke);
  pin(w, "sha-three", ["W1-T1", "W1-T4"]);
  await until(() => seen()?.pin === `ref:${w.repoDir}@sha-three`, "the running child took the pin", w.poke);
  children[0]!.kill("SIGKILL");
  await until(() => children.length === 2 && seen()?.pid === children[1]!.pid, "a respawned child rebuilt the view", w.poke);
  assert.equal(seen()!.pin, `ref:${w.repoDir}@sha-three`, "the respawned child started on the newest pin, not the working tree");
  assert.deepEqual(seen()!.ids, ["W1-T1", "W1-T4"]);
});
