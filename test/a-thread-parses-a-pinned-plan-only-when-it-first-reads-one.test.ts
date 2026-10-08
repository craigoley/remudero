import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BroadcastChannel, isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { mergePlanBlobsQuarantiningDuplicates, type Plan } from "../src/lib/plan.js";
import { packPlanBlobs } from "../src/lib/serve-plan-reload.js";
import { makeTempDir } from "../src/lib/tmp.js";

type Reply = {
  type: string; ref?: string; decodes: number; pin: string; pinnedRef?: string;
  load?: { plan: Plan; quarantined: unknown[] }; shared?: boolean;
};
type Row = { step: string; extra: Record<string, unknown> };
const record = (id: string, title = id) => `- id: ${id}\n  title: ${title}\n  repo: remudero\n  type: implement\n  depends_on: []\n`;
const blobs = (ref: string, texts: string[]) => texts.map((text, i) => ({
  label: `${ref}:${i === 0 ? "plan/tasks.yaml" : `plan/tasks.d/${i}.yaml`}`, text,
}));

if (!isMainThread) {
  const input = workerData as { path: string };
  let api: typeof import("../src/lib/thread-plan.js") | undefined;
  let decodes = 0;
  const from = Buffer.from;
  // Count actual shared-text decoding, including attempts that fail before an adoption row.
  Buffer.from = ((...args: unknown[]) => {
    if (args[0] instanceof SharedArrayBuffer) decodes++;
    return Reflect.apply(from, Buffer, args);
  }) as typeof Buffer.from;
  const reply = (type: string, extra: Record<string, unknown> = {}) => parentPort!.postMessage({
    type, decodes, pin: api!.threadPlanPin(input.path), pinnedRef: api!.threadPlanPinnedRef(input.path), ...extra,
  });
  const receipts: Record<string, unknown>[] = [];
  const flushReceipts = () => {
    if (api) for (const receipt of receipts.splice(0)) reply("received", receipt);
  };
  // Acknowledge the real listener's completion, including the pin returned to its startup ask.
  const descriptor = Object.getOwnPropertyDescriptor(BroadcastChannel.prototype, "onmessage")!;
  Object.defineProperty(BroadcastChannel.prototype, "onmessage", {
    ...descriptor,
    set(handler: (event: MessageEvent) => void) {
      descriptor.set!.call(this, (event: MessageEvent) => {
        handler.call(this, event);
        const data = event.data;
        if (data.type === "pin" && data.pin.path === input.path) {
          receipts.push({ ref: data.pin.ref, shared: data.text?.buffer instanceof SharedArrayBuffer });
          flushReceipts();
        }
      });
    },
  });
  api = await import("../src/lib/thread-plan.js");
  Object.defineProperty(BroadcastChannel.prototype, "onmessage", descriptor);
  const { threadPlan, threadPlanLoad, threadStrictPlan } = api;
  parentPort!.on("message", (method: "load" | "plan" | "strict") => {
    const first = method === "strict" ? threadStrictPlan(input.path) : method === "plan" ? threadPlan(input.path) : threadPlanLoad(input.path).plan;
    const load = threadPlanLoad(input.path);
    assert.equal(first, load.plan, "all readers share the held Plan");
    assert.equal(threadPlanLoad(input.path), load, "a repeated read reuses the same load");
    reply("read", { load });
  });
  flushReceipts();
  reply("ready");
} else {
  const {
    adoptThreadPlan, PLAN_PIN_ADOPTED_STEP, PLAN_PIN_ADOPT_FAILED_STEP, publishThreadPlan, swapThreadPlanParser,
    threadPlanLoad,
  } = await import("../src/lib/thread-plan.js");
  function fixture(t: TestContext) {
    const prior = swapThreadPlanParser(() => { throw new Error("main must not read plan files"); });
    t.after(() => swapThreadPlanParser(prior));
    const root = makeTempDir("lazy-plan-pin");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "tasks.yaml");
    writeFileSync(path, record("DISK"));
    const rows: Row[] = [];
    let onRow: (() => void) | undefined;
    return {
      root, path, rows,
      publish(ref: string, texts?: string[]) {
        const source = texts && blobs(ref, texts);
        publishThreadPlan({ path, repoDir: root, ref }, {
          plan: { tasks: [], byId: new Map() }, quarantined: [],
          text: source && packPlanBlobs(source), gitMs: 7,
        }, (step, extra = {}) => { rows.push({ step, extra }); onRow?.(); });
      },
      logged(thread: Worker, ref: string, step = PLAN_PIN_ADOPTED_STEP): Promise<Row> {
        return new Promise((resolve) => {
          const check = () => {
            const row = rows.find((row) => row.step === step && row.extra.threadId === thread.threadId && row.extra.ref === ref);
            if (row) { onRow = undefined; resolve(row); }
          };
          onRow = check;
          check();
        });
      },
    };
  }

  function spawn(t: TestContext, path: string, data: Record<string, unknown> = {}) {
    const thread = new Worker(new URL(import.meta.url), { workerData: { ...data, path } });
    t.after(async () => { await thread.terminate(); });
    const messages: Reply[] = [];
    let wake: (() => void) | undefined;
    thread.on("message", (message: Reply) => { messages.push(message); wake?.(); });
    const receive = (type: string, ref?: string): Promise<Reply> => new Promise((resolve) => {
      const check = () => {
        const index = messages.findIndex((message) => message.type === type && (ref === undefined || message.ref === ref));
        if (index >= 0) { wake = undefined; resolve(messages.splice(index, 1)[0]!); }
      };
      wake = check;
      check();
    });
    return { thread, receive, read: (method = "load") => { thread.postMessage(method); return receive("read"); } };
  }

  test("test/a-thread-parses-a-pinned-plan-only-when-it-first-reads-one.test.ts: only the reader parses and it equals an eager parse", { timeout: 10_000 }, async (t) => {
    const f = fixture(t);
    const reader = spawn(t, f.path, { kind: "remudero-read-model-views", lane: "fast" });
    const idle = spawn(t, f.path, { kind: "remudero-read-model-integrity" });
    await reader.receive("ready");
    await idle.receive("ready");
    const texts = [record("BASE", "fixtüre"), record("DUP"), record("DUP")];
    f.publish("first", texts);
    for (const worker of [reader, idle]) {
      const received = await worker.receive("received", "first");
      assert.equal(received.decodes, 0, "receiving a pin does not decode or parse its text");
      assert.equal(received.shared, true);
      assert.equal(received.pin, `ref:${f.root}@first`, "change keys move before the first read");
      assert.equal(received.pinnedRef, "first");
    }
    assert.equal(f.rows.length, 0, "non-readers post neither success nor failure rows");
    const read = await reader.read("strict");
    assert.equal(read.decodes, 1);
    assert.deepEqual(read.load, mergePlanBlobsQuarantiningDuplicates(blobs("first", texts)));
    const row = await f.logged(reader.thread, "first");
    assert.equal(row.extra.threadRole, "views");
    assert.equal(row.extra.gitMs, 7);
    assert.equal(row.extra.parsedBlobs, 3);
    assert.equal(typeof row.extra.parseMs, "number");
    assert.equal((await reader.read("plan")).decodes, 1);
    f.publish("first", texts);
    assert.equal((await reader.receive("received", "first")).decodes, 1);
    assert.equal((await idle.receive("received", "first")).decodes, 0);
    assert.equal((await reader.read()).decodes, 1);
    assert.equal(f.rows.length, 1);
  });

  test("an unread superseded pin is never parsed and a later read uses incremental blob reuse", { timeout: 10_000 }, async (t) => {
    const f = fixture(t);
    const worker = spawn(t, f.path, { kind: "remudero-read-model-views", lane: "heavy" });
    await worker.receive("ready");
    f.publish("superseded", ["not a task list"]);
    assert.equal((await worker.receive("received", "superseded")).decodes, 0);
    const texts = [record("BASE"), record("A")];
    f.publish("current", texts);
    assert.equal((await worker.receive("received", "current")).decodes, 0);
    assert.deepEqual((await worker.read()).load, mergePlanBlobsQuarantiningDuplicates(blobs("current", texts)));
    assert.equal((await f.logged(worker.thread, "current")).extra.threadRole, "heavy");
    const changed = [texts[0]!, record("B")];
    f.publish("next", changed);
    const pending = await worker.receive("received", "next");
    assert.equal(pending.decodes, 1);
    assert.equal(pending.pinnedRef, "next");
    const next = await worker.read("plan");
    assert.equal(next.decodes, 2);
    assert.deepEqual(next.load, mergePlanBlobsQuarantiningDuplicates(blobs("next", changed)));
    const row = await f.logged(worker.thread, "next");
    assert.equal(row.extra.parsedBlobs, 1);
    assert.equal(row.extra.reusedBlobs, 1);
    assert.deepEqual(f.rows.map((row) => row.extra.ref), ["current", "next"]);
  });

  test("startup asks defer parsing and every worker role is carried through the adoption log", { timeout: 15_000 }, async (t) => {
    const f = fixture(t);
    const texts = [record("A")];
    f.publish("published", texts);
    for (const [data, role] of [
      [{ kind: "remudero-read-model" }, "projector"],
      [{ kind: "remudero-read-model-slow-lane" }, "slow-lane"],
      [{ kind: "remudero-console-projection" }, "console"],
      [{ kind: "remudero-board-projection" }, "board"],
      [{ kind: "remudero-read-model-issue" }, "other"],
      [{ kind: "toString" }, "other"],
      [{}, "other"],
    ] as const) {
      const worker = spawn(t, f.path, data);
      await worker.receive("ready");
      assert.equal((await worker.receive("received", "published")).decodes, 0);
      assert.deepEqual((await worker.read()).load, mergePlanBlobsQuarantiningDuplicates(blobs("published", texts)));
      assert.equal((await f.logged(worker.thread, "published")).extra.threadRole, role);
      await worker.thread.terminate();
    }
  });

  test("missing or invalid pin text reports adoption failure only on read and a valid pin recovers", { timeout: 10_000 }, async (t) => {
    const f = fixture(t);
    const worker = spawn(t, f.path);
    await worker.receive("ready");
    for (const [ref, texts, reason] of [
      ["missing", undefined, /carried no plan text/],
      ["invalid", ["- id: [unclosed"], /not valid YAML/],
    ] as const) {
      f.publish(ref, texts && [...texts]);
      await worker.receive("received", ref);
      assert.equal(f.rows.filter((row) => row.extra.ref === ref).length, 0);
      assert.deepEqual((await worker.read()).load?.plan.tasks.map((task) => task.id), ["DISK"]);
      const failed = await f.logged(worker.thread, ref, PLAN_PIN_ADOPT_FAILED_STEP);
      assert.match(String(failed.extra.reason), reason);
    }
    f.publish("recovered", [record("RECOVERED")]);
    await worker.receive("received", "recovered");
    assert.deepEqual((await worker.read()).load?.plan.tasks.map((task) => task.id), ["RECOVERED"]);
    await f.logged(worker.thread, "recovered");
  });

  test("explicit main-thread adoption reports the main role", { timeout: 10_000 }, async (t) => {
    const f = fixture(t);
    f.publish("logger", [record("LOGGER")]);
    const relay = new BroadcastChannel("remudero-thread-plan-pin");
    t.after(() => relay.close());
    const logged = new Promise<Row>((resolve) => {
      relay.onmessage = ({ data }) => {
        if (data.type === "adopted" && data.pin.path === f.path) {
          resolve({ step: PLAN_PIN_ADOPTED_STEP, extra: data });
        }
      };
    });
    adoptThreadPlan({ pin: { path: f.path, repoDir: f.root, ref: "main-read" }, text: packPlanBlobs(blobs("main-read", [record("MAIN")])) });
    const row = await logged;
    assert.equal(row.extra.threadRole, "main");
    assert.deepEqual(threadPlanLoad(f.path), mergePlanBlobsQuarantiningDuplicates(blobs("main-read", [record("MAIN")])));
  });
}
