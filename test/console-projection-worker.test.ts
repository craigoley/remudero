import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { threadId } from "node:worker_threads";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import {
  computeFeedbackProjectionSync,
  indexedDischargeGithub,
  serveConsoleProjections,
  startConsoleProjectionWorker,
  type FeedbackProjectionOutcome,
} from "../src/lib/console-projection-worker.js";
import { CONSOLE_SNAPSHOT_VIEWER_IDLE_MS, consoleProjectionWorker, createConsoleSnapshotCache } from "../src/lib/console-snapshot-cache.js";
import { captureFeedback } from "../src/lib/feedback.js";
import { buildFeedbackInboxRoute, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import type { Route } from "../src/lib/service.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import { feedbackDischargeState, feedbackOriginTag } from "../src/lib/trace.js";

function fixture(): { root: string; planPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-projection-worker-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(
    planPath,
    [
      `- id: W1-T9001\n  title: "filed from the first entry"\n  repo: remudero\n  type: implement\n  origin: "${feedbackOriginTag("fb-1")}"\n`,
      `- id: W1-T9002\n  title: "unrelated"\n  repo: remudero\n  type: implement\n  origin: "architect"\n`,
    ].join(""),
  );
  captureFeedback(root, { raw: "first", origin: "cli", id: "fb-1" });
  captureFeedback(root, { raw: "second", origin: "cli", id: "fb-2" });
  return { root, planPath };
}

const merged = (url: string, headRefName?: string): PrRef => ({ number: Number(url.split("/").pop()), url, state: "MERGED", headRefName });

function gateway(prs: Array<PrRef & { body?: string }>): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: (id) => prs.find((p) => new RegExp(`^Remudero-Task:\\s*${id}\\s*$`, "m").test(p.body ?? "")) ?? null,
    findMergedByHeadBranch: (id) => prs.filter((p) => new RegExp(`^run-${id}-\\d+$`).test(p.headRefName ?? "")),
    mergedTrailerLookup: () => (id) => prs.find((p) => new RegExp(`^Remudero-Task:\\s*${id}\\s*$`, "m").test(p.body ?? "")) ?? null,
    listMergedHeadBranches: () => prs,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    readTruncated: () => false,
  };
}

async function inbox(deps: PanelGraphDeps): Promise<{ status: number; body: { entries: Array<{ id: string; discharged?: boolean }> } }> {
  let status = 0;
  let body = "";
  const res = { writeHead: (code: number) => void (status = code), end: (chunk: string) => void (body = chunk) } as unknown as ServerResponse;
  await buildFeedbackInboxRoute(deps).handler({ url: "/v1/feedback", headers: {} } as IncomingMessage, res, { params: {} });
  return { status, body: JSON.parse(body) };
}

test("a feedback projection runs off the main thread", async () => {
  const { root, planPath } = fixture();
  const worker = startConsoleProjectionWorker();
  try {
    const outcome = await worker.feedback({ root, planPath });
    assert.equal(outcome.ok, true);
    const done = outcome as Extract<FeedbackProjectionOutcome, { ok: true }>;
    assert.notEqual(done.threadId, threadId, "computed on another thread");
    assert.deepEqual(done.entries.map((e) => e.id), ["fb-1", "fb-2"]);
    assert.deepEqual(done.filedTasks, [["fb-1", ["W1-T9001"]], ["fb-2", []]]);
    const again = await worker.feedback({ root, planPath });
    assert.equal((again as { threadId: number }).threadId, done.threadId, "one persistent worker serves every request");
  } finally {
    worker.stop();
  }
});

test("the feedback route reads through the projection worker and keeps its discharge decoration", async () => {
  const { root, planPath } = fixture();
  const worker = startConsoleProjectionWorker();
  try {
    const statusGithub = gateway([merged("https://github.com/o/r/pull/7", "run-W1-T9001-1790000000000")]);
    let perCallScans = 0;
    const scan = statusGithub.findMergedByTrailer;
    statusGithub.findMergedByTrailer = (id) => ((perCallScans += 1), scan(id));
    const { status, body } = await inbox({ root, planPath, statusGithub, projectFeedback: worker.feedback } as unknown as PanelGraphDeps);
    assert.equal(status, 200);
    assert.deepEqual(body.entries.map((e) => [e.id, e.discharged ?? false]), [["fb-1", true], ["fb-2", false]]);
    assert.equal(perCallScans, 0, "discharge answers from the merged index, not one body scan per task");
  } finally {
    worker.stop();
  }
});

test("a failed projection worker falls back to the synchronous build", async () => {
  const { root, planPath } = fixture();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const deps = {
    root,
    planPath,
    statusGithub: gateway([]),
    projectFeedback: async () => ({ ok: false, reason: "console projection worker exited with code 1" }) as FeedbackProjectionOutcome,
    logProjection: (step: string, extra: Record<string, unknown>) => void lines.push({ step, extra }),
  } as unknown as PanelGraphDeps;
  const { status, body } = await inbox(deps);
  assert.equal(status, 200);
  assert.deepEqual(body.entries.map((e) => e.id), ["fb-1", "fb-2"]);
  assert.deepEqual(lines, [{ step: "serve.projection_worker_fallback", extra: { route: "/v1/feedback", reason: "console projection worker exited with code 1" } }]);
});

test("a projection worker that dies or cannot start is an outcome with its reason", async () => {
  const { root, planPath } = fixture();
  const dying = startConsoleProjectionWorker({ workerUrl: new URL(`data:text/javascript,${encodeURIComponent("process.exit(3);")}`) });
  const died = await dying.feedback({ root, planPath });
  assert.deepEqual(died, { ok: false, reason: "console projection worker exited with code 3" });
  const unstartable = startConsoleProjectionWorker({ workerUrl: new URL("http://example.invalid/worker.js") });
  const refused = await unstartable.feedback({ root, planPath });
  assert.equal(refused.ok, false);
  assert.match((refused as { reason: string }).reason, /could not start/);
  const stopped = startConsoleProjectionWorker({ workerUrl: new URL(`data:text/javascript,${encodeURIComponent("setInterval(() => {}, 1000);")}`) });
  const pending = stopped.feedback({ root, planPath });
  stopped.stop();
  assert.deepEqual(await pending, { ok: false, reason: "console projection worker stopped" });
});

test("the worker body answers each request with its id", () => {
  const { root, planPath } = fixture();
  const posted: Array<{ id: number; outcome: FeedbackProjectionOutcome }> = [];
  let onMessage: ((msg: { id: number; input: { root: string; planPath: string } }) => void) | undefined;
  serveConsoleProjections({ on: (_event, run) => void (onMessage = run), postMessage: (value) => void posted.push(value as never) });
  onMessage?.({ id: 4, input: { root, planPath } });
  onMessage?.({ id: 5, input: { root: join(root, "missing"), planPath: join(root, "missing.yaml") } });
  assert.equal(posted[0].id, 4);
  assert.equal(posted[0].outcome.ok, true);
  assert.equal(posted[1].id, 5);
  assert.equal(posted[1].outcome.ok, true, "a missing store lists nothing rather than failing");
  assert.match(String((posted[1].outcome as { planError?: string }).planError), /missing\.yaml|ENOENT|no such file/i);
  const broken = fixture();
  writeFileSync(join(broken.root, "plan", "feedback", "fb-9-broken.yaml"), "a: [unclosed\n");
  onMessage?.({ id: 6, input: broken });
  assert.equal(posted[2].id, 6);
  assert.match(String((posted[2].outcome as { reason?: string }).reason), /^feedback projection failed: /);
  serveConsoleProjections(null);
});

test("an unreadable plan serves the feedback inbox undecorated", async () => {
  const { root } = fixture();
  const outcome = computeFeedbackProjectionSync({ root, planPath: join(root, "absent.yaml") });
  assert.equal(outcome.ok && outcome.filedTasks, undefined);
  const { body } = await inbox({ root, planPath: join(root, "absent.yaml"), statusGithub: gateway([]) } as unknown as PanelGraphDeps);
  assert.deepEqual(body.entries.map((e) => [e.id, e.discharged]), [["fb-1", undefined], ["fb-2", undefined]]);
});

test("indexed discharge lookups answer what the per-call scans answer", () => {
  const prs = [
    { ...merged("https://github.com/o/r/pull/1"), body: "x\nRemudero-Task: W1-T1\n" },
    merged("https://github.com/o/r/pull/2", "run-W1-T2-1790000000000"),
    merged("https://github.com/o/r/pull/3", "run-TRIAGE-fb-12-ab-1790000000001"),
    merged("https://github.com/o/r/pull/4", "feature/unrelated"),
  ];
  const raw = gateway(prs);
  const indexed = indexedDischargeGithub(raw);
  const plan = { tasks: [], byId: new Map() };
  for (const id of ["W1-T1", "W1-T2", "TRIAGE-fb-12-ab", "TRIAGE-fb-12", "W1-T3"]) {
    assert.deepEqual(indexed.findMergedByTrailer(id), raw.findMergedByTrailer(id), id);
    assert.deepEqual(indexed.findMergedByHeadBranch?.(id), raw.findMergedByHeadBranch?.(id), id);
  }
  assert.deepEqual(feedbackDischargeState({ id: "fb-x" } as never, plan, indexed), { state: "not_discharged", taskIds: [] });
  const bare = { findMergedByTrailer: () => null };
  assert.equal(indexedDischargeGithub(bare), bare, "a gateway without a merged set is used as it is");
});

test("cached console paths refresh in the background only while a viewer is present", async () => {
  let now = 1_790_000_000_000;
  const clock: Clock = { now: () => now, date: () => fixedClock(now).date(), iso: () => fixedClock(now).iso() };
  const timers: Array<() => void> = [];
  let calls = 0;
  const route: Route = {
    method: "GET",
    path: "/v1/feedback",
    scope: "read",
    handler: (_req, res) => {
      calls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
  };
  const cache = createConsoleSnapshotCache(route, { budgetMs: 50, fallbackBody: () => ({}), clock, setTimer: (run) => void timers.push(run) });
  const res = { writeHead() {}, setHeader() {}, end() {} } as unknown as ServerResponse;
  await cache.handler({ url: "/v1/feedback", headers: {} } as IncomingMessage, res, { params: {} });
  now += 10_000;
  timers.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "refreshed with no request while the viewer is recent");
  now += CONSOLE_SNAPSHOT_VIEWER_IDLE_MS;
  timers.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "nothing runs once the viewer has gone");
  assert.equal(timers.length, 0);
});

test("the snapshot cache owns one process-wide projection worker", () => {
  assert.equal(consoleProjectionWorker(), consoleProjectionWorker());
});
