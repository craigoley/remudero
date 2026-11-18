/**
 * W1-T13683: W1-T13205's child-process read model is chosen by serve's environment, so a trial meant recreating the
 * serve container. switches.json's `process` key chooses it too, read when a handle starts (the next generation).
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { forkWorkerEntry } from "#src/lib/child-entry-argv.js";
import { readModelCommand } from "#src/lib/read-model-cli.js";
import { createReadModelWorker, READ_MODEL_PROCESS_CHILD_ARG, READ_MODEL_PROCESS_MODE_STEP, READ_MODEL_PROCESS_SWITCH,
  readModelProcessMode, readModelSwitchesPath, readReadModelSwitches } from "#src/lib/read-model-worker.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

type TestCtx = { after: (fn: () => void | Promise<void>) => void };

function withEnv(t: TestCtx, value: string | undefined): void {
  const saved = process.env[READ_MODEL_PROCESS_SWITCH];
  t.after(() => { if (saved === undefined) delete process.env[READ_MODEL_PROCESS_SWITCH]; else process.env[READ_MODEL_PROCESS_SWITCH] = saved; });
  if (value === undefined) delete process.env[READ_MODEL_PROCESS_SWITCH];
  else process.env[READ_MODEL_PROCESS_SWITCH] = value;
}

function switchesAt(t: TestCtx, kind: string, switches: unknown): string {
  const stateDir = readModelFixtureDir(t, kind).dir;
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), typeof switches === "string" ? switches : JSON.stringify(switches));
  return stateDir;
}

test("W1-T13683: the environment switch wins, and otherwise switches.json's process key chooses the worker's process", (t) => {
  const child = readModelSwitchesPath(switchesAt(t, "mode-child", { views: {}, process: "child" }));
  const thread = readModelSwitchesPath(switchesAt(t, "mode-thread", { views: {}, process: "thread" }));
  const bad = readModelSwitchesPath(switchesAt(t, "mode-bad", { views: {}, process: "fork" }));
  const none = readModelSwitchesPath(readModelFixtureDir(t, "mode-none").dir);
  assert.deepEqual(readModelProcessMode({}, child), { mode: "child", source: "switches" });
  assert.deepEqual(readModelProcessMode({}, thread), { mode: "thread", source: "switches" });
  assert.deepEqual(readModelProcessMode({}, none), { mode: "thread", source: "default" });
  assert.deepEqual(readModelProcessMode({ [READ_MODEL_PROCESS_SWITCH]: "off" }, child), { mode: "thread", source: "env" });
  assert.deepEqual(readModelProcessMode({ [READ_MODEL_PROCESS_SWITCH]: "on" }, thread), { mode: "child", source: "env" });
  const refused = readModelProcessMode({}, bad);
  assert.equal(refused.mode, "thread", "an unreadable switch runs the thread, as before");
  assert.match(String(refused.reason), /process has mode "fork"/);
  assert.equal(readReadModelSwitches(bad).ok, false);
});

test("W1-T13683: rmd read-model switch process child sets the key and keeps every other switch", (t) => {
  const stateDir = switchesAt(t, "cli", { projector: "on", views: { repositories: "serve" }, push: "on" });
  const out: string[] = [], error: string[] = [];
  const opts = { stateDir, out: (l: string) => out.push(l), error: (l: string) => error.push(l) };
  assert.equal(readModelCommand(["switch", "process", "child"], opts), 0);
  assert.deepEqual(JSON.parse(readFileSync(readModelSwitchesPath(stateDir), "utf8")),
    { projector: "on", views: { repositories: "serve" }, push: "on", process: "child" });
  assert.deepEqual(out, ["read-model switch process: thread -> child"]);
  assert.match(readFileSync(join(stateDir, "ledger.ndjson"), "utf8"), /"target":"process","mode":"child","previous":"thread"/);
  assert.equal(readModelCommand(["switch", "process", "fork"], opts), 2);
  assert.match(error.join("\n"), /process takes thread\|child/);
});

test("W1-T13683: a handle started under process child forks its worker and names the switch that chose it", async (t) => {
  withEnv(t, undefined);
  const stateDir = switchesAt(t, "handle-state", { views: { whoami: "shadow" }, process: "child" });
  const ledgerDir = readModelFixtureDir(t, "handle-ledger").dir;
  writeFileSync(join(ledgerDir, "ledger.ndjson"), `${JSON.stringify({ ts: new Date().toISOString(), step: "run.start", task_id: "W1-T1", run_id: "boot" })}\n`);
  const modulePath = join(readModelFixtureDir(t, "handle-module").dir, "module.mjs");
  writeFileSync(modulePath, `export default [
  { name: "whoami", version: 1, materialize: () => [{ key: "", data: { pid: process.pid }, sources: [] }] },
];
`);
  const children: Array<ReturnType<typeof forkWorkerEntry>["child"]> = [];
  const fork: typeof forkWorkerEntry = (url, args, options, opts) => {
    const launched = forkWorkerEntry(url, args, options, opts);
    children.push(launched.child);
    return launched;
  };
  const rows: Array<{ step: string; extra: unknown }> = [];
  let handle: ReturnType<typeof createReadModelWorker> | undefined;
  onReadModelClose(t, () => void handle?.stop());
  handle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir }], viewsModule: pathToFileURL(modulePath).href, fork,
    every: () => () => undefined, log: (step, extra) => rows.push({ step, extra }) });
  handle.start();
  const deadline = Date.now() + 60_000;
  while (handle.body("whoami") === undefined && Date.now() < deadline) await sleep(10);
  assert.equal(children.length, 1, "the worker was forked as a child process");
  assert.deepEqual(children[0]!.spawnargs.slice(-1), [READ_MODEL_PROCESS_CHILD_ARG]);
  assert.equal((handle.body("whoami")!.body.data as { pid: number }).pid, children[0]!.pid);
  assert.deepEqual(rows.find((row) => row.step === READ_MODEL_PROCESS_MODE_STEP)?.extra, { mode: "child", source: "switches" });
  handle.stop();
});
