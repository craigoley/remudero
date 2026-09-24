import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStatusStream, type BoardDeps } from "../src/lib/board.js";
import { deriveStatus } from "../src/lib/status.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { createService, type SseStream } from "../src/lib/service.js";
import type { GitHub } from "../src/lib/status.js";
import { createSsePublisher, parseSseEventId, SSE_BOOT_ID, subscribeStatusStream } from "../src/lib/status-stream-publisher.js";

function task(id: string): Task {
  return { id, title: id, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

const PR_URL = "https://github.com/craigoley/remudero/pull/1";
const github: GitHub = {
  prByRef: (ref) => (String(ref) === PR_URL ? { number: 1, url: PR_URL, state: "MERGED" } : null),
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

function ledgerDeps(): BoardDeps & { lines: Array<Record<string, unknown>>; reads: number } {
  const deps = {
    plan: planOf([task("W1-TA"), task("W1-TB")]),
    ledgerPath: "/unused/ledger.ndjson",
    github,
    lines: [] as Array<Record<string, unknown>>,
    reads: 0,
    readLedger: () => {
      deps.reads += 1;
      return deps.lines;
    },
  };
  return deps as BoardDeps & { lines: Array<Record<string, unknown>>; reads: number };
}

type Frame = { event: string; data: unknown; id?: string };

function recorder(lastEventId?: string): { frames: Frame[]; comments: string[]; send: (e: string, d: unknown, id?: string) => void; stream: SseStream } {
  const frames: Frame[] = [];
  const comments: string[] = [];
  return {
    frames,
    comments,
    send: (event, data, id) => void frames.push({ event, data, id }),
    stream: { lastEventId, comment: (text) => void comments.push(text) },
  };
}

function manualIntervals(): { setInterval: (run: () => void, ms: number) => number; clearInterval: (h: unknown) => void; armed: Map<number, { run: () => void; ms: number }> } {
  const armed = new Map<number, { run: () => void; ms: number }>();
  let next = 1;
  return {
    armed,
    setInterval: (run, ms) => {
      armed.set(next, { run, ms });
      return next++;
    },
    clearInterval: (h) => void armed.delete(h as number),
  };
}

const runStarted = (taskId: string, run: string) => ({ ts: new Date().toISOString(), task_id: taskId, run_id: run, step: "pr.opened", pr_url: PR_URL });

const project = (task: Task, deps: BoardDeps) => deriveStatus(task, deps);

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

test("two status stream subscribers share one ledger tail", async () => {
  const deps = ledgerDeps();
  const a = recorder();
  const b = recorder();
  const stopA = subscribeStatusStream(deps, 10, a, project);
  const primed = deps.reads;
  const stopB = subscribeStatusStream(deps, 10, b, project);
  assert.equal(deps.reads, primed, "the second subscriber costs no read and no derive");
  deps.lines.push(runStarted("W1-TA", "r1"));
  await settle();
  stopA();
  stopB();
  assert.equal(a.frames.length, 1);
  assert.deepEqual(a.frames, b.frames, "both subscribers see the same event with the same id");
  assert.equal(a.frames[0].event, "status");
  assert.equal((a.frames[0].data as { taskId: string }).taskId, "W1-TA");
  assert.equal(parseSseEventId(a.frames[0].id, SSE_BOOT_ID), 1);
  const readsAfterStop = deps.reads;
  await settle();
  assert.equal(deps.reads, readsAfterStop, "the last unsubscribe stops the shared tail");
});

test("a status stream subscribe derives no task until the ledger touches it", async () => {
  const deps = ledgerDeps();
  const stop = subscribeStatusStream(deps, 10, recorder(), project);
  assert.equal(deps.reads, 1, "one cursor read and no per-task derive");
  await settle();
  stop();
  assert.ok(deps.reads > 1, "the shared tail kept polling");
});

test("a line that leaves its task unchanged sends no status event", async () => {
  const deps = ledgerDeps();
  const quiet = recorder();
  const stop = subscribeStatusStream(deps, 10, quiet, project);
  deps.lines.push({ ts: new Date().toISOString(), task_id: "W1-TB", run_id: "r2", step: "recon.start" });
  deps.lines.push({ ts: new Date().toISOString(), task_id: "W1-UNKNOWN", run_id: "r3", step: "recon.start" });
  await settle();
  stop();
  assert.deepEqual(quiet.frames, []);
});

test("a quiet status stream sends a heartbeat within 30 seconds", () => {
  const deps = ledgerDeps();
  const timers = manualIntervals();
  const quiet = recorder();
  const stop = subscribeStatusStream(deps, 60_000, quiet, project, { setInterval: timers.setInterval, clearInterval: timers.clearInterval });
  const heartbeat = [...timers.armed.values()].find((t) => t.ms <= 30_000);
  assert.ok(heartbeat, "a heartbeat interval of at most 30 s is armed");
  heartbeat.run();
  assert.deepEqual(quiet.comments, ["hb"]);
  stop();
  assert.equal(timers.armed.size, 0, "the heartbeat stops with the last subscriber");
});

test("a status stream resume past the retained window receives a resync event", () => {
  const publisher = createSsePublisher({ start: () => () => {}, bootId: "boot", retained: 2 });
  const live = recorder();
  const stopLive = publisher.subscribe(live);
  publisher.publish("status", { n: 1 });
  publisher.publish("status", { n: 2 });
  publisher.publish("status", { n: 3 });
  const late = recorder("boot:0");
  publisher.subscribe(late);
  assert.deepEqual(late.frames, [{ event: "resync", data: { reason: "gap" }, id: "boot:3" }]);
  const restarted = recorder("other-boot:3");
  publisher.subscribe(restarted);
  assert.equal(restarted.frames[0].event, "resync", "a resume across a serve restart is a gap");
  const garbled = recorder("boot:not-a-number");
  publisher.subscribe(garbled);
  assert.equal(garbled.frames[0].event, "resync");
  stopLive();
});

test("a status stream resume inside the retained window replays only what was missed", () => {
  const publisher = createSsePublisher({ start: () => () => {}, bootId: "boot", retained: 5 });
  publisher.subscribe(recorder());
  publisher.publish("status", { n: 1 });
  publisher.publish("status", { n: 2 });
  publisher.publish("status", { n: 3 });
  const back = recorder("boot:1");
  publisher.subscribe(back);
  assert.deepEqual(back.frames, [
    { event: "status", data: { n: 2 }, id: "boot:2" },
    { event: "status", data: { n: 3 }, id: "boot:3" },
  ]);
  const current = recorder("boot:3");
  publisher.subscribe(current);
  assert.deepEqual(current.frames, [], "an up-to-date resume replays nothing");
  const fresh = recorder();
  publisher.subscribe(fresh);
  assert.deepEqual(fresh.frames, [], "a new subscriber is never replayed history");
  assert.equal(publisher.subscriberCount(), 4);
});

test("the source starts on the first subscriber and stops after the last", () => {
  let starts = 0;
  let stops = 0;
  const publisher = createSsePublisher({ start: () => ((starts += 1), () => void (stops += 1)), bootId: "boot" });
  const one = publisher.subscribe(recorder());
  const two = publisher.subscribe(recorder());
  assert.equal(starts, 1);
  one();
  one();
  assert.equal(stops, 0, "a double release does not stop a source another subscriber still holds");
  two();
  assert.equal(stops, 1);
  publisher.subscribe(recorder());
  assert.equal(starts, 2, "a later subscriber restarts it");
});

test("the status stream wire carries ids a heartbeat-safe header set and honours Last-Event-ID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-status-stream-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const deps: BoardDeps = { plan: planOf([task("W1-TA")]), ledgerPath, github };
  const server = createService({ tokens: { read: "r", write: "w" }, sse: [buildStatusStream(deps, 10)] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ac = new AbortController();
  try {
    const res = await fetch(`${base}/v1/status/stream`, { headers: { authorization: "Bearer r", "last-event-id": "someone-else:9" }, signal: ac.signal });
    assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(res.headers.get("x-accel-buffering"), "no");
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("event: resync")) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /^:ok\n\nretry: 3000\n\n/);
    assert.match(text, /id: [^\n]+:0\nevent: resync\ndata: \{"reason":"gap"\}\n\n/);
    writeFileSync(ledgerPath, `${JSON.stringify(runStarted("W1-TA", "r1"))}\n`);
    while (!text.includes("event: status")) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /id: [^\n]+:1\nevent: status\ndata: \{"taskId":"W1-TA"/);
  } finally {
    ac.abort();
    server.close();
  }
});
