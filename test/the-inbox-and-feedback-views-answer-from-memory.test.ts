// Arch Phase 4 (design §1.1 priorities 1 and 2, D9, P4-T06/P4-T07): the inbox and feedback views are
// materialized by serve's slow lane with no reader, paged by key under 64 KiB, and served from memory.
// Measured before: GET /v1/inbox/threads 15.2 s cold, /v1/inbox?section=needsYou 3.7 s and stale on
// every read, bare /v1/inbox 1.96 MB, /v1/feedback 462 KB.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { fixedClock } from "../src/lib/clock.js";
import { FEEDBACK_VIEW_NAME, FEEDBACK_VIEW_VERSION, feedbackLegacyView, feedbackViewBodies, materializeFeedbackView } from "../src/lib/feedback-view.js";
import { INBOX_VIEW_NAME, INBOX_VIEW_SECTIONS, INBOX_VIEW_VERSION, inboxLegacyView, inboxViewBodies, refreshInboxClassification } from "../src/lib/inbox-view.js";
import { buildInboxRoute, inboxLanes, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { createReadModelTicker, createReadModelWorker, loadCommittedViewBodies, readModelSwitchesPath, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { buildReadModelViewRoutes, renderView, viewKey, type ViewSource } from "../src/lib/views.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { allowGhRefusals } from "./setup/tmp-hygiene.js";

allowGhRefusals("the real slow lane thread re-runs test setup, which puts the refusal stub ahead on that thread's PATH; an empty plan classifies the same with its board read refused");

type TestCtx = { after: (fn: () => void) => void };

const T0 = Date.parse("2026-10-01T04:00:00.000Z");
const SOURCE: ViewSource = { name: "inbox-store:core", asOf: new Date(T0).toISOString(), state: "fresh" };

function root(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An inbox of `n` operator proposals with long summaries, plus `fleet` fleet findings. */
function inboxWorld(t: TestCtx, n: number, fleet = 0): PanelGraphDeps {
  const dir = root(t, "rmd-inbox-view");
  mkdirSync(join(dir, "state"), { recursive: true });
  mkdirSync(join(dir, "plan"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(dir, "state", "ledger.ndjson"), "");
  const proposals = [
    ...Array.from({ length: n }, (_, i) => ({ id: `ruling:p${i}`, summary: `${"a long operator summary ".repeat(20)}${i}`, evidenceAnchors: [] })),
    ...Array.from({ length: fleet }, (_, i) => ({ id: `proof-debt:W1-T${9000 + i}`, summary: `fleet finding ${i}`, evidenceAnchors: [] })),
  ];
  writeFileSync(join(dir, "state", "inbox-proposals.json"), JSON.stringify({ proposals }));
  return {
    root: dir, inboxRoot: dir, planPath: join(dir, "plan", "tasks.yaml"), ledgerPath: join(dir, "state", "ledger.ndjson"),
    github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40), inboxGrepAnchor: () => true,
  };
}

/** The body the route would send for one view body, to measure what a reader receives. */
function wireBytes(name: string, data: unknown, sources: ViewSource[]): number {
  const rendered = renderView({ name, version: 1, compute: () => ({ data, sources }) }, fixedClock(T0));
  assert.ok(!("error" in rendered));
  return Buffer.byteLength(JSON.stringify(rendered.body));
}

test("the inbox view pages every section under 64 KiB with counts on every key", async (t) => {
  const deps = inboxWorld(t, 400, 3);
  const refreshed = await refreshInboxClassification(deps, {}, fixedClock(T0));
  const bodies = refreshed.bodies;
  for (const body of bodies) assert.ok(wireBytes(INBOX_VIEW_NAME, body.data, body.sources) <= 64 * 1024, `${body.key} is ${wireBytes(INBOX_VIEW_NAME, body.data, body.sources)} bytes`);
  const needsYou = bodies.filter((b) => b.data.section === "needsYou");
  assert.ok(needsYou.length >= 4, `400 long proposals take several pages, got ${needsYou.length}`);
  assert.equal(needsYou[0]!.key, "section=needsYou");
  // The first page's `next` is the second page's cursor, and so on: the pages chain to every item exactly once.
  const seen: string[] = [];
  let key: string | undefined = "section=needsYou";
  while (key) {
    const body = bodies.find((b) => b.key === key);
    assert.ok(body, `page ${key} exists`);
    seen.push(...body.data.items.map((i) => i.proposalId));
    key = body.data.page.next === undefined ? undefined : viewKey(new URLSearchParams({ section: "needsYou", cursor: body.data.page.next }));
  }
  assert.equal(new Set(seen).size, 400);
  assert.ok(bodies.every((b) => b.data.counts.needsYou.notReady === 400 && b.data.counts.fleet === 3), "every key carries every lane's counts");
  assert.deepEqual([...new Set(bodies.map((b) => b.data.section))].sort(), [...INBOX_VIEW_SECTIONS].sort(), "every section has a key, even an empty one");
  assert.deepEqual(bodies.find((b) => b.key === "section=fleet")!.data.items.map((i) => i.proposalId).length, 3);
  assert.ok(needsYou.every((b) => b.data.items.every((i) => i.lane === "notReady")), "a needsYou item names its lane");
});

test("the legacy inbox view pages the last classification without classifying", async (t) => {
  const deps = inboxWorld(t, 3);
  const legacy = inboxLegacyView(deps, fixedClock(T0));
  assert.deepEqual(legacy.compute(new URLSearchParams({ section: "needsYou" })), { error: "serve has not classified the inbox yet" }, "a cold serve never classifies on the request path");
  assert.match(String((legacy.compute(new URLSearchParams({ section: "everything" })) as { error: string }).error), /section must be one of/);
  // GET /v1/inbox warms the memo the legacy side pages.
  const route = buildInboxRoute(deps);
  const server = createServer((req, res) => void route.handler(req, res, { params: {} } as never));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  assert.equal((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox`)).status, 200);
  const answered = legacy.compute(new URLSearchParams({ section: "needsYou" }));
  const view = (await refreshInboxClassification(deps, {}, fixedClock(T0))).bodies.find((b) => b.key === "section=needsYou")!;
  assert.ok(!("error" in answered));
  assert.deepEqual(answered.data, view.data, "the shadow comparator's legacy side equals the slow lane's body over the same classification");
  assert.match(String((legacy.compute(new URLSearchParams({ section: "needsYou", cursor: "99" })) as { error: string }).error), /no such page/);
});

test("the feedback view projects a merged proposal as accepted and writes nothing", (t) => {
  const dir = root(t, "rmd-feedback-view");
  mkdirSync(join(dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "- id: W1-T1\n  title: filed from fb-new\n  repo: remudero\n  type: implement\n  origin: feedback:fb-new\n");
  const entry = (id: string, status: string, pr = "null"): string => ["id: " + id, "ts: '2026-09-30T00:00:00.000Z'", "raw: a note " + id, "attachments: []", "origin: cli", `status: ${status}`, `proposal_pr: ${pr}`, ""].join("\n");
  writeFileSync(join(dir, "plan", "feedback", "fb-merged.yaml"), entry("fb-merged", "proposed", "'https://github.com/o/r/pull/7'"));
  writeFileSync(join(dir, "plan", "feedback", "fb-open.yaml"), entry("fb-open", "proposed", "'https://github.com/o/r/pull/8'"));
  writeFileSync(join(dir, "plan", "feedback", "fb-new.yaml"), entry("fb-new", "new"));
  const before = readFileSync(join(dir, "plan", "feedback", "fb-merged.yaml"), "utf8");
  const github = fakeGitHub({ prByRef: (ref: string | number) => (String(ref).endsWith("/7") ? { number: 7, url: String(ref), state: "MERGED" } : null), readFailed: () => true });
  const bodies = materializeFeedbackView({ root: dir, planPath: join(dir, "plan", "tasks.yaml") }, github, fixedClock(T0));
  const all = bodies.find((b) => b.key === "")!;
  assert.deepEqual(all.data.entries.map((e) => [e.id, e.status, e.unverified ?? false]), [["fb-merged", "accepted", false], ["fb-new", "new", false], ["fb-open", "proposed", true]]);
  assert.deepEqual(all.data.counts, { total: 3, byStatus: { accepted: 1, new: 1, proposed: 1 } });
  assert.deepEqual(bodies.find((b) => b.key === "status=accepted")!.data.entries.map((e) => e.id), ["fb-merged"]);
  assert.deepEqual(bodies.find((b) => b.key === "status=grilling")!.data.entries, [], "an empty status still has its key");
  assert.equal(readFileSync(join(dir, "plan", "feedback", "fb-merged.yaml"), "utf8"), before, "the projection writes nothing");
  assert.deepEqual(all.sources.map((s) => s.name), ["feedback-store:core"]);

  const panel: PanelGraphDeps = {
    root: dir, planPath: join(dir, "plan", "tasks.yaml"), statusGithub: github, ledgerPath: join(dir, "ledger.ndjson"), inboxRoot: dir,
    github: { prView: () => null }, ratify: { approve: () => undefined, reframe: () => undefined },
  };
  const legacy = feedbackLegacyView(panel, () => ({ tasks: [], byId: new Map() }) as never, fixedClock(T0));
  const answered = legacy.compute(new URLSearchParams({ status: "accepted" }));
  assert.ok(!("error" in answered));
  assert.deepEqual(answered.data, bodies.find((b) => b.key === "status=accepted")!.data, "the legacy side equals the slow lane's body");
  assert.match(String((legacy.compute(new URLSearchParams({ status: "lost" })) as { error: string }).error), /status must be one of/);
  assert.match(String((legacy.compute(new URLSearchParams({ cursor: "40" })) as { error: string }).error), /no such page/);
  const unlabelled = feedbackLegacyView(panel).compute(new URLSearchParams());
  assert.ok(!("error" in unlabelled) && unlabelled.data.entries.length === 3, "with no plan snapshot it parses the plan itself");
});

test("feedback pages chain under 64 KiB", () => {
  const entries = Array.from({ length: 300 }, (_, i) => ({ id: `fb-${String(i).padStart(3, "0")}`, ts: "2026-09-30T00:00:00.000Z", raw: "x".repeat(600), attachments: [], origin: "cli", status: "new", proposal_pr: null }) as never);
  const bodies = feedbackViewBodies(entries, SOURCE);
  const pages = bodies.filter((b) => b.data.status === "new");
  assert.ok(pages.length >= 3);
  for (const body of bodies) assert.ok(wireBytes(FEEDBACK_VIEW_NAME, body.data, body.sources) <= 64 * 1024);
  assert.equal(pages[1]!.key, viewKey(new URLSearchParams({ status: "new", cursor: pages[0]!.data.page.next! })));
  assert.equal(pages.reduce((sum, b) => sum + b.data.entries.length, 0), 300);
});

function tickerFor(t: TestCtx, mode: string | undefined): { posted: ReadModelWorkerMessage[]; ticker: ReturnType<typeof createReadModelTicker>; stateDir: string } {
  const stateDir = root(t, "rmd-accept-state");
  const ledgerDir = join(stateDir, "core");
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  if (mode) writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { inbox: mode } }));
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], holder: "accept", oracle: "off", views: [], post: (m) => void posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  return { posted, ticker, stateDir };
}

test("a page that empties is dropped from the read model and from serve", async (t) => {
  const deps = inboxWorld(t, 400);
  const many = (await refreshInboxClassification(deps, {}, fixedClock(T0))).bodies;
  const { posted, ticker, stateDir } = tickerFor(t, "serve");
  ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: many });
  const keys = (): string[] => loadCommittedViewBodies(stateDir, "core").bodies.filter((b) => b.view === INBOX_VIEW_NAME).map((b) => b.key).sort();
  assert.deepEqual(keys(), many.map((b) => b.key).sort(), "every page is persisted");
  const bodiesPosted = posted.filter((m) => m.type === "body").length;
  ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: many });
  assert.equal(posted.filter((m) => m.type === "body").length, bodiesPosted, "an unchanged page is not posted again");

  const few = inboxViewBodies(inboxLanes({ proposals: [], classifications: [], ledgerLines: [] as never }, deps.inboxRoot), SOURCE);
  ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: few });
  const dropped = posted.filter((m): m is Extract<ReadModelWorkerMessage, { type: "drop" }> => m.type === "drop").map((m) => m.key).sort();
  assert.deepEqual(dropped, many.map((b) => b.key).filter((k) => !few.some((f) => f.key === k)).sort(), "every page that emptied is dropped");
  assert.deepEqual(keys(), few.map((b) => b.key).sort());

  // A restarted worker knows the persisted keys too: it drops a page an earlier run served.
  const again = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: join(stateDir, "core") }], holder: "accept-2", oracle: "off", views: [], post: (m) => void posted.push(m) });
  ticker.release();
  again.start();
  again.tick();
  again.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: few.filter((b) => b.key !== "section=fleet") });
  assert.ok(!keys().includes("section=fleet"));
  again.release();
});

test("a dark view takes no slow lane bodies", async (t) => {
  const deps = inboxWorld(t, 2);
  const bodies = (await refreshInboxClassification(deps, {}, fixedClock(T0))).bodies;
  for (const mode of [undefined, "off"]) {
    const { posted, ticker, stateDir } = tickerFor(t, mode);
    ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies });
    assert.equal(posted.filter((m) => m.type === "body").length, 0, `switch ${mode}: nothing posted`);
    assert.deepEqual(loadCommittedViewBodies(stateDir, "core").bodies.filter((b) => b.view === INBOX_VIEW_NAME), []);
  }
  const { posted, ticker } = tickerFor(t, "shadow");
  ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: [{ key: "section=ready", data: { bad: 1n }, sources: [] }] });
  assert.ok(posted.some((m) => m.type === "log" && m.step === "read_model.materialize_failed"), "a body that cannot be stored is logged, not thrown");
});

test("serve forgets a body its worker dropped", async (t) => {
  const dir = root(t, "rmd-drop-worker");
  const path = join(dir, "worker.mjs");
  const body = { view: "inbox", key: "section=ready", version: 1, generation: 0, etag: 'W/"x"', body: { view: "inbox", version: 1, generatedAt: "", asOf: null, stale: false, sources: [], data: {} } };
  writeFileSync(path, `import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "body", entry: ${JSON.stringify(body)} });
setTimeout(() => parentPort.postMessage({ type: "drop", view: "inbox", key: "section=ready" }), 200);
setInterval(() => {}, 1000);
`);
  const handle = createReadModelWorker({ stateDir: dir, instances: [{ name: "core", ledgerDir: dir }], workerUrl: pathToFileURL(path), every: () => () => {} });
  t.after(() => void handle.stop());
  handle.start();
  const deadline = Date.now() + 10_000;
  while (!handle.body("inbox", "section=ready") && Date.now() < deadline) await sleep(5);
  assert.ok(handle.body("inbox", "section=ready"), "the body arrived");
  while (handle.body("inbox", "section=ready") && Date.now() < deadline) await sleep(5);
  assert.equal(handle.body("inbox", "section=ready"), undefined, "and is gone after its drop");
});

test("the inbox view is materialized by a real slow lane with no reader and served from memory", async (t) => {
  const deps = inboxWorld(t, 5);
  const stateDir = root(t, "rmd-inbox-view-e2e");
  const ledgerDir = join(stateDir, "core");
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { inbox: "serve", feedback: "serve" } }));
  const logs: string[] = [];
  const handle = createReadModelWorker({
    stateDir, instances: [{ name: "core", ledgerDir }], log: (step) => logs.push(step), every: () => () => {},
    slowLane: { intervalMs: 60_000, inbox: { root: deps.root, planPath: deps.planPath, ledgerPath: deps.ledgerPath, inboxRoot: deps.inboxRoot, repository: "o/r" } },
  });
  t.after(() => void handle.stop());
  handle.start();
  const deadline = Date.now() + 60_000;
  while ((!handle.body(INBOX_VIEW_NAME, "section=needsYou") || !handle.body(FEEDBACK_VIEW_NAME, "")) && Date.now() < deadline) await sleep(20);
  assert.ok(handle.body(INBOX_VIEW_NAME, "section=needsYou"), `the slow lane materialized the inbox; logs ${logs.join(",")}`);
  assert.ok(handle.body(FEEDBACK_VIEW_NAME, ""), "and the feedback view");
  assert.ok(existsSync(join(deps.inboxRoot, "state", "inbox-classified.json")), "the same pass wrote the fleet lane's snapshot");

  const [route] = buildReadModelViewRoutes({ legacy: [], readModel: handle, readModelViews: [INBOX_VIEW_NAME], requiredParams: { [INBOX_VIEW_NAME]: ["section"] } });
  const server = createServer((req, res) => void route!.handler(req, res, { params: {} } as never));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/views/inbox?section=needsYou`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { items: Array<{ proposalId: string }>; counts: { needsYou: { notReady: number } } }; sources: ViewSource[] };
  assert.equal(body.data.items.length, 5);
  assert.equal(body.data.counts.needsYou.notReady, 5);
  // E27: the lane reads the owner's board snapshot, and with none written yet the body names that gap.
  assert.deepEqual(body.sources.map((s) => [s.name, s.state, s.kind]), [["inbox-store:core", "fresh", "inbox-store"], ["github:o/r", "unavailable", "github"]]);
  assert.equal((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/views/inbox`)).status, 400, "a read without a section is refused");
});
