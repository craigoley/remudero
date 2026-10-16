import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GENERATION_MESSAGES as M, onShedWorkersRequest, type GenerationChannel, type GenerationMessage,
} from "../src/lib/serve-generation.js";

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function channel(): { port: GenerationChannel; send: (message: GenerationMessage) => void; replies: GenerationMessage[] } {
  let receive!: (message: GenerationMessage) => void;
  const replies: GenerationMessage[] = [];
  return { port: { send: (message) => { replies.push(message); }, onMessage: (listener) => { receive = listener; } },
    send: (message) => receive(message), replies };
}

test("a late worker shed finishes before its already-requested restore", async (t) => {
  const c = channel(), events: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  t.after(finish);
  onShedWorkersRequest(c.port, {
    shed: async () => { events.push("shed-start"); await pending; events.push("shed-end"); return { workers: 2 }; },
    restore: () => { events.push("restore"); },
  }, () => 100);
  c.send({ type: M.shed_workers });
  await turn();
  assert.deepEqual(events, ["shed-start"]);
  c.send({ type: M.restore_workers, reason: "still_short" });
  await turn();
  assert.deepEqual(events, ["shed-start"], "restore cannot overtake a shed whose acknowledgement timed out upstream");
  assert.deepEqual(c.replies, [], "neither action has completed yet");
  finish();
  await turn();
  assert.deepEqual(events, ["shed-start", "shed-end", "restore"]);
  assert.deepEqual(c.replies.map((r) => r.type), [M.shed_workers_done, M.restore_workers_done]);
});

test("a failed worker shed still orders its error acknowledgement before the queued restore", async (t) => {
  const c = channel(), events: string[] = [];
  let fail!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
  // Even an assertion failure settles the fixture's own pending operation.
  t.after(() => fail(new Error("fixture closed")));
  onShedWorkersRequest(c.port, {
    shed: () => pending,
    restore: () => { events.push("restored"); },
  }, () => 100);
  c.send({ type: M.shed_workers });
  c.send({ type: M.restore_workers });
  await turn();
  assert.deepEqual(events, [], "a failed-but-not-yet-settled shed is still in flight");
  fail(new Error("shed failed"));
  await turn();
  assert.deepEqual(events, ["restored"]);
  assert.deepEqual(c.replies.map((r) => r.type), [M.shed_workers_done, M.restore_workers_done]);
  assert.equal(c.replies[0]?.error, "shed failed");
  assert.equal(c.replies[1]?.error, undefined);
});

test("a restore failure does not prevent a later worker shed or turn an unknown message into work", async () => {
  const c = channel(), events: string[] = [];
  onShedWorkersRequest(c.port, {
    shed: () => { events.push("shed"); return { workers: 3, heapBytes: 50 }; },
    restore: () => { throw new Error("restore failed"); },
  }, () => 100);
  c.send({ type: "not-a-worker-lifecycle-command" });
  await turn();
  assert.deepEqual(c.replies, []);
  c.send({ type: M.restore_workers });
  c.send({ type: M.shed_workers });
  await turn();
  assert.deepEqual(events, ["shed"]);
  assert.deepEqual(c.replies.map((r) => r.type), [M.restore_workers_done, M.shed_workers_done]);
  assert.equal(c.replies[0]?.error, "restore failed");
  assert.equal(c.replies[1]?.workers, 3);
  assert.equal(c.replies[1]?.heapBytes, 50);
});

test("the real generation IPC channel restores only after its delayed shed completes", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-serve-worker-order-"));
  const script = join(dir, "generation.mjs");
  const moduleUrl = new URL("../src/lib/serve-generation.ts", import.meta.url).href;
  writeFileSync(script, [
    'import { onShedWorkersRequest, processChannel } from ' + JSON.stringify(moduleUrl) + ";",
    "const events = []; let finish;",
    "const pending = new Promise(resolve => { finish = resolve; });",
    "onShedWorkersRequest(processChannel(), {",
    '  shed: async () => { events.push("shed-start"); process.send({type:"started"}); await pending; events.push("shed-end"); return {workers:2}; },',
    '  restore: () => { events.push("restore"); },',
    "});",
    'process.on("message", m => { if(m.type==="release") finish(); if(m.type==="checkpoint") setImmediate(() => process.send({type:"checkpoint-result", events:[...events]})); });',
    'process.send({type:"ready"});',
  ].join("\n"));
  const child = fork(script, [], { cwd: new URL("..", import.meta.url), execArgv: ["--import", "tsx"],
    env: { ...process.env, NODE_V8_COVERAGE: undefined }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const replies: Record<string, unknown>[] = [];
  const waiters = new Map<string, (message: Record<string, unknown>) => void>();
  child.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Record<string, unknown>;
    replies.push(message);
    waiters.get(String(message.type))?.(message);
  });
  const wait = (type: string): Promise<Record<string, unknown>> => {
    const found = replies.find((r) => r.type === type);
    return found ? Promise.resolve(found) : new Promise((resolve) => { waiters.set(type, resolve); });
  };
  t.after(async () => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    rmSync(dir, { recursive: true, force: true });
  });
  await wait("ready");
  child.send({ type: M.shed_workers });
  await wait("started");
  child.send({ type: M.restore_workers, reason: "upstream backstop ended" });
  child.send({ type: "checkpoint" });
  assert.deepEqual((await wait("checkpoint-result")).events, ["shed-start"], "real IPC must not report restore before the late shed completes");
  child.send({ type: "release" });
  await wait(M.restore_workers_done);
  const workerAcks = new Set<string>([M.shed_workers_done, M.restore_workers_done]);
  assert.deepEqual(replies.filter((r) => workerAcks.has(String(r.type))).map((r) => r.type),
    [M.shed_workers_done, M.restore_workers_done]);
});
