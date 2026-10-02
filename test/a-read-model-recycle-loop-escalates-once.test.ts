import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Clock } from "../src/lib/clock.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import {
  READ_MODEL_STALL_MS, answerReadModelIssueRequest, createReadModelWorker, threadIssueRequest,
  type ReadModelIssueAnswer, type ReadModelIssueRequest, type ReadModelWorkerHandle,
} from "../src/lib/read-model-worker.js";
import type { ShadowRequest } from "../src/lib/view-shadow.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-01T12:00:00.000Z");
/** Far past any watchdog bound the tests reach, so every advance recycles a silent worker. */
const PAST_ANY_BOUND = 2 * READ_MODEL_STALL_MS * 2 ** 12;

/**
 * A worker that says nothing on its own, so the watchdog recycles it. It announces each start, and
 * answers a `shadow` message carrying `tickedAt` with a state whose lease is held: a completed tick,
 * with a backlog when `catchUp` is set.
 */
const SCRIPTED_WORKER = new URL(`data:text/javascript,${encodeURIComponent(`
import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "log", step: "test.worker_started", extra: {} });
parentPort.on("message", (m) => {
  if (m.type !== "shadow") return;
  const state = { instance: "core", lease: "held", tickedAt: m.tickedAt, generation: 1, failures: 0, newestTs: null, ...(m.catchUp ? { catchUp: { rowsBehind: 10, etaMs: 1000, at: m.tickedAt } } : {}) };
  parentPort.postMessage({ type: "state", at: m.tickedAt, instances: [state], switches: { projector: "on", views: {} } });
});
setInterval(() => {}, 1000);
`)}`);

type TestCtx = { after: (fn: () => void) => void };
type IssueRunner = (request: ReadModelIssueRequest) => Promise<ReadModelIssueAnswer>;

function fakeIssues(opts: { failCreate?: boolean } = {}): { issues: IssueGateway; created: Array<{ title: string; body: string }>; closed: Array<{ url: string; comment: string }>; open: OpenIssue[] } {
  const created: Array<{ title: string; body: string }> = [];
  const closed: Array<{ url: string; comment: string }> = [];
  const open: OpenIssue[] = [];
  const issues: IssueGateway = {
    create: (title, body) => {
      if (opts.failCreate) throw new Error("gh: HTTP 502");
      const url = `https://github.com/craigoley/remudero/issues/${900 + created.length}`;
      created.push({ title, body });
      open.push({ url, title, body } as OpenIssue);
      return url;
    },
    listOpen: () => [...open],
    closeWithComment: (url, comment) => {
      closed.push({ url, comment });
      open.splice(open.findIndex((issue) => issue.url === url), 1);
    },
    comment: () => undefined,
  };
  return { issues, created, closed, open };
}

function harness(t: TestCtx, issues: IssueGateway, issueRequest?: IssueRunner): {
  logs: Array<{ step: string; extra: Record<string, unknown> }>; ledgerPath: string; watch: () => void; advance: (ms: number) => void;
  recycle: () => Promise<void>; steady: (catchUp?: boolean) => Promise<void>; steps: () => string[]; settled: () => Promise<void>;
} {
  const stateDir = makeTempDir("recycle-loop");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  let ms = T0;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let watch: (() => void) | undefined;
  let states = 0;
  let inFlight = 0;
  /** The fake gateway answers on a later turn of the event loop, as the issue thread would. */
  const later: IssueRunner = async (request) => {
    inFlight++;
    await sleep(1);
    inFlight--;
    return answerReadModelIssueRequest(request.op === "escalate" ? { ...request, ledgerPath } : request, issues);
  };
  const handle: ReadModelWorkerHandle = createReadModelWorker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], workerUrl: SCRIPTED_WORKER, stopWaitMs: 20, tickMs: 1, clock,
    escalationRepository: "craigoley/remudero", issueRequest: issueRequest ?? later,
    log: (step, extra = {}) => void logs.push({ step, extra }), every: (run) => ((watch = run), () => undefined),
    observe: (msg) => void (msg.type === "state" && states++),
  });
  t.after(() => handle.stop());
  const count = (step: string): number => logs.filter((l) => l.step === step).length;
  const until = async (done: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 500 && !done(); i++) await sleep(5);
    assert.ok(done(), `timed out waiting for ${what}`);
  };
  handle.start();
  return {
    logs, ledgerPath, watch: () => watch?.(), advance: (by) => void (ms += by),
    steps: () => logs.map((l) => l.step).filter((s) => /recycle_loop/.test(s)),
    settled: async () => {
      await until(() => inFlight === 0, "the issue requests to settle");
      await sleep(2);
    },
    recycle: async () => {
      await until(() => count("test.worker_started") > count("read_model.worker_recycled"), "the worker to start");
      const started = count("test.worker_started");
      ms += PAST_ANY_BOUND;
      watch?.();
      await until(() => count("test.worker_started") > started, "the recycled worker to respawn");
    },
    steady: async (catchUp = false) => {
      const before = states;
      ms += 1_000;
      handle.shadow({ tickedAt: ms, ...(catchUp ? { catchUp: true } : {}) } as unknown as ShadowRequest);
      await until(() => states > before, "the worker's state");
    },
  };
}

test("a read-model worker recycled once that then ticks steady is never escalated", async (t) => {
  const gh = fakeIssues();
  const h = harness(t, gh.issues);
  await h.recycle();
  await h.steady();
  await h.recycle();
  await h.steady();
  await h.settled();
  assert.equal(h.logs.filter((l) => l.step === "read_model.worker_recycled").length, 2, "both recycles are still ledgered");
  assert.deepEqual(h.steps(), [], "a recycle followed by a steady tick is no loop");
  assert.equal(gh.created.length, 0);
});

test("a read-model worker recycled again before any steady tick escalates once with the evidence", async (t) => {
  const gh = fakeIssues();
  const h = harness(t, gh.issues);
  await h.recycle();
  await h.steady(true); // a tick still catching up is not steady: the re-ingest livelock's shape
  await h.recycle();
  await h.recycle();
  await h.recycle();
  await h.settled();
  assert.equal(gh.created.length, 1, "one issue for the whole loop");
  assert.match(gh.created[0]!.title, /read-model worker keeps being recycled/);
  assert.match(gh.created[0]!.body, /recycled the read-model worker 2 times/);
  assert.deepEqual(h.steps(), ["read_model.recycle_loop", "read_model.recycle_loop_escalated"], "escalated once and not again while the loop is open");
  const row = h.logs.find((l) => l.step === "read_model.recycle_loop")!.extra;
  assert.equal(row.recycles, 2);
  assert.equal(row.loopMs, PAST_ANY_BOUND + 1_000);
  assert.equal((row.last as unknown[]).length, 2);
  assert.equal(h.logs.find((l) => l.step === "read_model.recycle_loop_escalated")!.extra.issueUrl, "https://github.com/craigoley/remudero/issues/900");
});

test("a recovered read-model recycle loop closes its issue and a later loop escalates again", async (t) => {
  const gh = fakeIssues();
  const h = harness(t, gh.issues);
  await h.recycle();
  await h.recycle();
  await h.settled();
  await h.steady();
  await h.settled();
  assert.deepEqual(h.steps(), ["read_model.recycle_loop", "read_model.recycle_loop_escalated", "read_model.recycle_loop_recovered", "read_model.recycle_loop_closed"]);
  assert.deepEqual(gh.closed.map((c) => c.url), ["https://github.com/craigoley/remudero/issues/900"], "recovery closes the issue it opened");
  assert.equal(gh.open.length, 0);
  await h.recycle();
  await h.recycle();
  await h.settled();
  assert.equal(gh.created.length, 2, "a later loop is escalated again: recovery never suppresses it");
  assert.deepEqual(h.steps().slice(4), ["read_model.recycle_loop", "read_model.recycle_loop_escalated"]);
});

test("a read-model loop that recovers while its issue is being opened still closes it", async (t) => {
  const gh = fakeIssues();
  let answer: ((value: ReadModelIssueAnswer) => void) | undefined;
  const h = harness(t, gh.issues, (request) => request.op === "close"
    ? Promise.resolve(answerReadModelIssueRequest(request, gh.issues))
    : new Promise((resolve) => void (answer = resolve)));
  await h.recycle();
  await h.recycle();
  await h.steady();
  answer!({ url: "https://github.com/craigoley/remudero/issues/41" });
  await sleep(5);
  assert.deepEqual(h.steps(), ["read_model.recycle_loop", "read_model.recycle_loop_recovered", "read_model.recycle_loop_escalated", "read_model.recycle_loop_closed"]);
  assert.deepEqual(gh.closed.map((c) => c.url), ["https://github.com/craigoley/remudero/issues/41"]);
});

test("a failed recycle-loop escalation is ledgered and the worker still respawns", async (t) => {
  const gh = fakeIssues({ failCreate: true });
  const h = harness(t, gh.issues);
  await h.recycle();
  await h.recycle();
  await h.settled();
  assert.equal(h.logs.find((l) => l.step === "read_model.recycle_loop_escalated")!.extra.issueUrl, null);
  assert.ok(existsSync(h.ledgerPath));
  const failed = readFileSync(h.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((r) => r.step === "escalation.failed");
  assert.equal(failed.length, 1, "the undelivered escalation has its own ledger row");
  assert.equal(failed[0].task_id, "READ-MODEL-CORE");
  await h.recycle(); // the worker still respawns, and the next recycle tries the delivery again
  await h.settled();
  assert.deepEqual(h.steps(), ["read_model.recycle_loop", "read_model.recycle_loop_escalated", "read_model.recycle_loop", "read_model.recycle_loop_escalated"]);
  await h.steady();
  await h.settled();
  assert.equal(h.steps().at(-1), "read_model.recycle_loop_recovered", "recovery is recorded with nothing to close");
  assert.equal(h.logs.at(-1)!.extra.issueUrl, null);
});

test("a recycle-loop issue that will not close is ledgered and the worker carries on", async (t) => {
  const gh = fakeIssues();
  gh.issues.closeWithComment = () => {
    throw new Error("gh: HTTP 403");
  };
  const h = harness(t, gh.issues);
  await h.recycle();
  await h.recycle();
  await h.settled();
  await h.steady();
  await h.settled();
  assert.equal(h.steps().at(-1), "read_model.recycle_loop_close_failed");
  assert.match(String(h.logs.at(-1)!.extra.error), /HTTP 403/);
  await h.recycle();
  await h.recycle();
  await h.settled();
  assert.equal(gh.created.length, 1, "the next loop finds the issue still open and comments instead of opening another");
});

test("the recycle watchdog never waits on the issue request", async (t) => {
  const gh = fakeIssues();
  let answer: ((value: ReadModelIssueAnswer) => void) | undefined;
  const requests: ReadModelIssueRequest[] = [];
  const h = harness(t, gh.issues, (request) => (requests.push(request), new Promise((resolve) => void (answer = resolve))));
  await h.recycle();
  await h.recycle();
  assert.equal(requests.length, 1, "the request was made");
  assert.deepEqual(h.steps(), ["read_model.recycle_loop"], "the watchdog returned while the request is still pending");
  answer!({ url: "https://github.com/craigoley/remudero/issues/77" });
  await sleep(5);
  assert.deepEqual(h.steps(), ["read_model.recycle_loop", "read_model.recycle_loop_escalated"]);
});

test("a steady read-model worker returns the watchdog to its base bound", async (t) => {
  const h = harness(t, fakeIssues().issues);
  await h.recycle();
  await h.steady();
  h.advance(2 * READ_MODEL_STALL_MS);
  h.watch();
  const recycled = h.logs.filter((l) => l.step === "read_model.worker_recycled");
  assert.equal(recycled.length, 2, "a stall after recovery is recycled at the base bound");
  assert.equal(recycled[1]!.extra.boundMs, 2 * READ_MODEL_STALL_MS);
  assert.equal(recycled[1]!.extra.recycles, 1);
});

test("the issue thread answers off the event loop and a dead one answers with why", async (t) => {
  const answering = new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort, workerData } from "node:worker_threads"; parentPort.postMessage({ url: workerData.request.url });`)}`);
  const dying = new URL(`data:text/javascript,${encodeURIComponent(`process.exit(3);`)}`);
  const close = { op: "close", repository: "o/r", url: "https://github.com/o/r/issues/5", comment: "done" } as const;
  const alive = setInterval(() => undefined, 1_000); // the thread is unref'd, as serve's other threads are
  t.after(() => clearInterval(alive));
  assert.deepEqual(await threadIssueRequest(answering)(close), { url: "https://github.com/o/r/issues/5" });
  assert.deepEqual(await threadIssueRequest(dying)(close), { error: "the issue thread exited with code 3" });
  const closed: string[] = [];
  assert.deepEqual(answerReadModelIssueRequest(close, { create: () => "", closeWithComment: (url) => void closed.push(url) }), { url: close.url });
  assert.deepEqual(closed, [close.url]);
});

test("the real issue thread runs the escalation through tryEscalate and answers", async (t) => {
  const stateDir = makeTempDir("recycle-loop-thread");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const alive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(alive));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  // No options: escalate() refuses before any `gh` call, and tryEscalate ledgers the refusal.
  const escalation = { class: "MANUAL", taskId: "READ-MODEL-CORE", summary: "s", detail: "d", options: [], recommendation: "r" } as const;
  assert.deepEqual(await threadIssueRequest()({ op: "escalate", repository: "o/r", ledgerPath, escalation: { ...escalation, options: [] } }), { url: null });
  const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((r) => [r.step, r.task_id]), [["escalation.failed", "READ-MODEL-CORE"]]);
});
