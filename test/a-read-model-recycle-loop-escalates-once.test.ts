import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Clock } from "../src/lib/clock.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import { READ_MODEL_STALL_MS, createReadModelWorker, type ReadModelWorkerHandle } from "../src/lib/read-model-worker.js";
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

function harness(t: TestCtx, issues: IssueGateway): {
  handle: ReadModelWorkerHandle; logs: Array<{ step: string; extra: Record<string, unknown> }>; ledgerPath: string;
  recycle: () => Promise<void>; steady: (catchUp?: boolean) => Promise<void>; steps: () => string[];
} {
  const stateDir = makeTempDir("recycle-loop");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  let ms = T0;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let watch: (() => void) | undefined;
  let states = 0;
  const handle = createReadModelWorker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], workerUrl: SCRIPTED_WORKER, stopWaitMs: 20, tickMs: 1, clock,
    escalation: { issues, ledgerPath, runId: "read-model-test" },
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
    handle, logs, ledgerPath,
    steps: () => logs.map((l) => l.step).filter((s) => /recycle_loop/.test(s)),
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
  assert.equal(gh.created.length, 1, "one issue for the whole loop");
  assert.match(gh.created[0]!.title, /read-model worker keeps being recycled/);
  assert.match(gh.created[0]!.body, /recycled the read-model worker 2 times/);
  assert.deepEqual(h.steps(), ["read_model.recycle_loop"], "escalated once and not again while the loop is open");
  const row = h.logs.find((l) => l.step === "read_model.recycle_loop")!.extra;
  assert.equal(row.recycles, 2);
  assert.equal(row.loopMs, PAST_ANY_BOUND + 1_000);
  assert.equal((row.last as unknown[]).length, 2);
  assert.equal(row.issueUrl, "https://github.com/craigoley/remudero/issues/900");
});

test("a recovered read-model recycle loop closes its issue and a later loop escalates again", async (t) => {
  const gh = fakeIssues();
  const h = harness(t, gh.issues);
  await h.recycle();
  await h.recycle();
  await h.steady();
  assert.deepEqual(h.steps(), ["read_model.recycle_loop", "read_model.recycle_loop_recovered"]);
  assert.deepEqual(gh.closed.map((c) => c.url), ["https://github.com/craigoley/remudero/issues/900"], "recovery closes the issue it opened");
  assert.equal(gh.open.length, 0);
  await h.recycle();
  await h.recycle();
  assert.equal(gh.created.length, 2, "a later loop is escalated again: recovery never suppresses it");
  assert.deepEqual(h.steps(), ["read_model.recycle_loop", "read_model.recycle_loop_recovered", "read_model.recycle_loop"]);
});

test("a failed recycle-loop escalation is ledgered and the worker still respawns", async (t) => {
  const gh = fakeIssues({ failCreate: true });
  const h = harness(t, gh.issues);
  await h.recycle();
  await h.recycle();
  const row = h.logs.find((l) => l.step === "read_model.recycle_loop")!.extra;
  assert.equal(row.issueUrl, null);
  assert.ok(existsSync(h.ledgerPath));
  const failed = readFileSync(h.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((r) => r.step === "escalation.failed");
  assert.equal(failed.length, 1, "the undelivered escalation has its own ledger row");
  assert.equal(failed[0].task_id, "READ-MODEL-CORE");
  await h.recycle(); // the worker still respawns, and the next recycle tries the delivery again
  assert.deepEqual(h.steps(), ["read_model.recycle_loop", "read_model.recycle_loop"]);
  await h.steady();
  assert.deepEqual(h.steps(), ["read_model.recycle_loop", "read_model.recycle_loop", "read_model.recycle_loop_recovered"], "recovery is recorded with nothing to close");
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
  await h.steady();
  assert.deepEqual(h.steps(), ["read_model.recycle_loop", "read_model.recycle_loop_recovered", "read_model.recycle_loop_close_failed"]);
  assert.match(String(h.logs.at(-1)!.extra.error), /HTTP 403/);
  await h.recycle();
  await h.recycle();
  assert.equal(gh.created.length, 1, "the next loop finds the issue still open and comments instead of opening another");
});
