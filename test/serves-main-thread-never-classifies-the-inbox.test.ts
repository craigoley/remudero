// W1-T5897: serve's main thread never classifies the inbox. Each serve generation started with an empty
// classification memo, and its inbox routes ran a cold pass of 1 to 6.5 minutes over about 1,032 proposals
// while serve forked a generation per merge; single reads blocked up to 13.8 s. The slow lane now persists
// the whole classification, and every main-thread inbox reader answers from it.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { persistedInboxPath, readPersistedInbox } from "../src/lib/fleet-lane.js";
import { inboxThreadId } from "../src/lib/inbox-thread.js";
import { inboxLegacyView, refreshInboxClassification, type InboxRefreshMemo } from "../src/lib/inbox-view.js";
import { buildInboxAttentionCensusRoute, buildInboxRoute, buildInboxThreadReplyRoute, buildInboxThreadRoute, buildInboxThreadsRoute, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { createViewShadow, legacyViewSampler, type ShadowRequest } from "../src/lib/view-shadow.js";
import { buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import { createService, type Route } from "../src/lib/service.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

type TestCtx = { after: (fn: () => void | Promise<void>) => void };

/** A core inbox root, and the slow lane's deps over it: its own object, as the lane's thread holds its own. */
function world(t: TestCtx, proposals: string[]): { stateDir: string; registry: string; laneDeps: PanelGraphDeps } {
  const root = makeTempDir("rmd-inbox-main-thread");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const registry = join(stateDir, "inbox-proposals.json");
  writeProposals(registry, proposals);
  const laneDeps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath,
    github: { prView: () => null },
    statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40),
    inboxGrepAnchor: () => true,
  };
  return { stateDir, registry, laneDeps };
}

function writeProposals(registry: string, ids: string[]): void {
  writeFileSync(registry, JSON.stringify({ proposals: ids.map((id) => ({ id, summary: `about ${id}`, evidenceAnchors: [] })) }));
}

/** A freshly forked generation's deps: a new object, so its classification memo is empty. Every pass it could run
 *  resolves origin/main's sha first, so `passes` counts main-thread classification passes. */
function freshGeneration(laneDeps: PanelGraphDeps): { deps: PanelGraphDeps; passes: () => number } {
  let passes = 0;
  const deps: PanelGraphDeps = {
    ...laneDeps, inboxFromSlowLane: true,
    inboxMainSha: () => {
      passes++;
      return "a".repeat(40);
    },
  };
  return { deps, passes: () => passes };
}

async function get(t: TestCtx, route: Route, path: string, post?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createServer((req, res) => void route.handler(req, res, { params: {} } as never));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const init = post === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(post) };
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("a fresh serve generation answers the inbox from the persisted classification", async (t) => {
  const { stateDir, laneDeps } = world(t, ["ruling:a", "adoption:symbol-no-caller:src/lib/a.ts:x"]);
  const refreshed = await refreshInboxClassification(laneDeps, {}, fixedClock(Date.now()));
  const persisted = readPersistedInbox(stateDir);
  assert.ok(persisted, "the slow lane persisted the whole classification");
  assert.equal(persisted.generatedAt, refreshed.generatedAt);
  assert.equal(persisted.proposals.length, 2);

  const { deps, passes } = freshGeneration(laneDeps);
  const inbox = await get(t, buildInboxRoute(deps), "/v1/inbox");
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.classifiedAt, persisted.generatedAt, "the source age is the slow lane's generatedAt");
  const slowLaneNeedsYou = refreshed.bodies.find((b) => b.key === "section=needsYou")!.data;
  assert.deepEqual(inbox.body.counts, slowLaneNeedsYou.counts, "the lanes are the ones the slow lane built");
  assert.deepEqual((inbox.body.fleet as Array<{ proposalId: string }>).map((i) => i.proposalId), ["adoption:symbol-no-caller:src/lib/a.ts:x"]);

  const threads = await get(t, buildInboxThreadsRoute(deps, undefined, { warm: false }), "/v1/inbox/threads");
  assert.equal(threads.status, 200);
  assert.equal((threads.body.source as { classifiedAt: string }).classifiedAt, persisted.generatedAt);
  assert.deepEqual((threads.body.threads as Array<{ threadId: string }>).map((th) => th.threadId), [inboxThreadId("ruling:a")]);
  assert.equal(passes(), 0, "the fresh generation ran no main-thread classification pass");
});

test("a stale persisted classification reaches the thread list only qualified", async (t) => {
  const { laneDeps } = world(t, ["ruling:a"]);
  await refreshInboxClassification(laneDeps, {}, fixedClock(Date.parse("2026-01-01T00:00:00.000Z")));
  const { deps, passes } = freshGeneration(laneDeps);
  const route = buildInboxThreadsRoute(deps, undefined, { warm: false });
  const plain = await get(t, route, "/v1/inbox/threads");
  assert.equal(plain.status, 503, "a stale classification is never the legacy body (W1-T5269)");
  const qualified = await get(t, route, "/v1/inbox/threads?qualified=1");
  assert.equal(qualified.status, 200);
  assert.equal((qualified.body.source as { state: string }).state, "stale");
  assert.equal(passes(), 0);
});

test("an inbox request on serve's main thread runs no classification pass", async (t) => {
  const { stateDir, laneDeps } = world(t, ["ruling:a"]);
  const { deps, passes } = freshGeneration(laneDeps);
  const thread = `/v1/inbox/thread?id=${encodeURIComponent(inboxThreadId("ruling:a"))}`;

  const notReady = await get(t, buildInboxRoute(deps), "/v1/inbox");
  assert.equal(notReady.status, 503, "nothing persisted is an explicit not-ready answer, never a pass and never an empty list");
  assert.equal(notReady.body.error, "inbox_not_ready");
  assert.equal((await get(t, buildInboxAttentionCensusRoute(deps), "/v1/inbox/attention-census")).status, 503);
  assert.equal((await get(t, buildInboxThreadRoute(deps), thread)).status, 503);
  const reply = await get(t, buildInboxThreadReplyRoute(deps), "/v1/inbox/thread/reply", { threadId: inboxThreadId("ruling:a"), text: "hello" });
  assert.equal(reply.status, 503, "a reply's orphan check reads the persisted classification too");
  writeFileSync(persistedInboxPath(stateDir), "{ torn");
  assert.equal(readPersistedInbox(stateDir), undefined, "a torn file is no classification");
  writeFileSync(persistedInboxPath(stateDir), JSON.stringify({ identity: "x", generatedAt: "2026-10-05T00:00:00.000Z" }));
  assert.equal((await get(t, buildInboxRoute(deps), "/v1/inbox")).status, 503, "a foreign shape is no classification");
  assert.equal(passes(), 0);

  await refreshInboxClassification(laneDeps, {}, fixedClock(Date.now()));
  assert.equal((await get(t, buildInboxRoute(deps), "/v1/inbox?section=needsYou")).status, 200);
  const census = await get(t, buildInboxAttentionCensusRoute(deps), "/v1/inbox/attention-census");
  assert.equal(census.status, 200);
  const detail = await get(t, buildInboxThreadRoute(deps), thread);
  assert.equal(detail.status, 200);
  assert.equal(passes(), 0, "GET /v1/inbox, the attention census and a thread read answered with no main-thread pass");
});

test("the inbox view's legacy side reads the same snapshot as the slow lane's body", async (t) => {
  const { registry, laneDeps } = world(t, ["ruling:a"]);
  const memo: InboxRefreshMemo = {};
  const first = await refreshInboxClassification(laneDeps, memo, fixedClock(Date.parse("2026-10-05T12:00:00.000Z")));
  const body = first.bodies.find((b) => b.key === "section=needsYou")!;
  assert.equal(body.sources[0]?.asOf, first.generatedAt, "the body names the snapshot it was built from");

  const { deps, passes } = freshGeneration(laneDeps);
  const sample = (atMs: number): ShadowRequest => {
    const posted: ShadowRequest[] = [];
    legacyViewSampler({ legacy: [inboxLegacyView(deps, fixedClock(atMs))], post: (r) => posted.push(r), clock: fixedClock(atMs), defer: (run) => run() })(
      "inbox", "section=needsYou", new URLSearchParams({ section: "needsYou" }));
    assert.ok(posted[0]?.legacy, "the legacy side rendered");
    return posted[0]!;
  };
  const evidence = () => ({ legacyAsOfMs: null, viewAsOfMs: null, named: new Set<string>(), namedBeforeHorizon: new Set<string>(), namedInGap: new Set<string>(), rowsInGap: 0, duplicateIds: new Set<string>(), duplicateRows: 0 });
  const shadow = createViewShadow({ clock: fixedClock(Date.parse("2026-10-05T12:30:00.000Z")), log: () => {}, evidence });
  const compare = (request: ShadowRequest) => shadow.compare({ view: "inbox", key: request.key, requests: 1, legacy: request.legacy!, body: { data: body.data, asOf: body.sources[0]!.asOf, sources: body.sources } });

  const paired = sample(Date.parse("2026-10-05T12:01:00.000Z"));
  assert.equal(paired.legacy?.paired?.items?.asOf, first.generatedAt, "legacy read the snapshot the body was built from");
  assert.deepEqual(compare(paired).diffs, [], "one snapshot, two computations over it: nothing differs");
  const late = inboxLegacyView(deps, fixedClock(Date.parse("2026-10-05T13:00:00.000Z"))).compute(new URLSearchParams({ section: "needsYou" }));
  assert.ok(!("error" in late) && late.sources[0]?.state === "stale", "a snapshot past its budget is labelled stale, as of its own generatedAt");

  // A new proposal, and the first one moving lane.
  writeProposals(registry, ["ruling:a", "ruling:b"]);
  appendFileSync(laneDeps.ledgerPath, `${JSON.stringify({ ts: "2026-10-05T12:01:30.000Z", step: "panel.proposal_declined", task_id: "ruling:a", reason: "not now" })}\n`);
  const second = await refreshInboxClassification(laneDeps, memo, fixedClock(Date.parse("2026-10-05T12:02:00.000Z")));
  assert.ok(second.changed);
  const later = sample(Date.parse("2026-10-05T12:03:00.000Z"));
  assert.equal(later.legacy?.paired?.items?.asOf, second.generatedAt);
  const diffs = compare(later).diffs;
  assert.ok(diffs.length > 0, "the newer snapshot differs from the body built over the older one");
  assert.deepEqual([...new Set(diffs.map((d) => d.classification))], ["timing"], "a diff between two snapshots is timing, never real");
  assert.equal(passes(), 0);
});

test("serve under its slow lane answers GET /v1/inbox from the persisted classification", async (t) => {
  const { laneDeps } = world(t, ["ruling:a"]);
  let passes = 0;
  const panelGraph: PanelGraphDeps = { ...laneDeps, inboxMainSha: () => (passes++, "a".repeat(40)) };
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath: laneDeps.ledgerPath, github: fakeGitHub() }, panelGraph, ledgerPath: laneDeps.ledgerPath,
    issues: { close() {} }, fleetControlRoot: laneDeps.inboxRoot, questionsRoot: laneDeps.inboxRoot, tokens: { read: "r-token", write: "w-token" },
    githubAppRefresh: { start: () => ({ armed: false }) },
    readModel: { slowLane: { inbox: { root: laneDeps.root, planPath: laneDeps.planPath, ledgerPath: laneDeps.ledgerPath, inboxRoot: laneDeps.inboxRoot, repository: "o/r" } } },
  };
  const server = createService({ tokens: deps.tokens, routes: buildServeRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const inbox = (query = "") => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox${query}`, { headers: { authorization: "Bearer r-token" } });
  const cold = await inbox();
  assert.equal(cold.status, 503, "a cold serve with nothing persisted says not ready");
  const { generatedAt } = await refreshInboxClassification(laneDeps, {}, fixedClock(Date.now()));
  // The console cache keeps the cold answer for its refresh period; another query is its own entry.
  const warm = await inbox("?section=needsYou");
  assert.equal(warm.status, 200);
  assert.equal(((await warm.json()) as { classifiedAt?: string }).classifiedAt, generatedAt);
  assert.equal(passes, 0, "serve's own deps ran no classification pass");
});
