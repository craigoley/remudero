// W1-T5373: the Inbox badge (legacy and read-model served), the needs-you composite, each instance's
// now view and GET /v1/status all report one source-qualified decision count, read through
// consumeHumanGateCounts from the same projection and counted before any display cap.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { writeClassificationSnapshot } from "../src/lib/fleet-lane.js";
import type { HumanGateCountSummary, HumanGateProjection } from "../src/lib/human-gate.js";
import type { InboxState } from "../src/lib/inbox.js";
import { inboxViewBodies } from "../src/lib/inbox-view.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { NAV_BADGE_NO_COMPOSITE, navBadgeView, navBadgeWithDecisions, type NavBadgeData } from "../src/lib/nav-badge-view.js";
import { NEEDS_YOU_VIEW_NAME, withNeedsYouView, type NeedsYouData } from "../src/lib/needs-you-view.js";
import { NOW_DECISIONS_CAP } from "../src/lib/now-decisions.js";
import { createNowView, type NowViewData } from "../src/lib/now-view.js";
import { inboxLanes } from "../src/lib/panel-graph.js";
import type { Plan } from "../src/lib/plan.js";
import { policyPath } from "../src/lib/policy.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import type { ReadModelBodyEntry, ReadModelWorkerHandle } from "../src/lib/read-model-worker.js";
import type { Route } from "../src/lib/service.js";
import { withStatusNeedsYou } from "../src/lib/serve.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";
import type { ViewSource } from "../src/lib/views.js";
import { resolve, violations } from "./helpers/openapi-strict.js";

const AT = "2026-10-04T12:00:00.000Z";
const NOW = Date.parse(AT);
const CLOCK = fixedClock(NOW + 2000);

function tempRoot(t: TestContext): string {
  const root = makeTempDir("human-gate-surface-counts");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** One instance's real now body: open escalation issues from its ledger, read by the production now view. */
function nowEntry(t: TestContext, opts: { escalations: number; githubFails?: boolean; hold?: boolean }): ReadModelBodyEntry {
  const root = tempRoot(t);
  const ledgerDir = join(root, "state");
  const planDir = join(root, "plan");
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "policy.yaml"), readFileSync(policyPath(process.cwd()), "utf8"));
  const ids = Array.from({ length: opts.escalations }, (_, i) => `W1-T${9000 + i}`);
  const rows = [
    { ts: AT, step: "daemon.boot", head_sha: "a".repeat(40) },
    ...ids.map((id, i) => ({ ts: new Date(NOW + i).toISOString(), step: "escalation.issue_opened", task_id: id,
      issue_url: `https://github.com/o/r/issues/${i + 1}`, class: "BLOCKED" })),
    ...(opts.hold ? [{ ts: AT, step: "automerge.hold_engaged", pr_number: 77, by: "operator", reason: "standing hold", authority: "interactive-cli" }] : []),
    { ts: new Date(NOW + 1000).toISOString(), step: "daemon.freshness_not_stale", arm: "up_to_date" },
  ];
  writeFileSync(join(ledgerDir, "ledger.ndjson"), rows.map((r) => JSON.stringify(r) + "\n").join(""));
  const db = openProjectorReadModel(join(root, "read-model"), "site", CLOCK);
  t.after(() => db.close());
  const lease = acquireLease(db, { clock: CLOCK });
  assert.ok(lease.ok);
  createLedgerProjector({ ledgerDir, db, lease: lease.lease, clock: CLOCK }).tick();
  const plan = { tasks: ids.map((id) => ({ id, title: `task ${id}`, repo: "o/r", depends_on: [], type: "implement",
    risk: "low", verify: "auto", status: "queued", attempts: 0 })) } as unknown as Plan;
  plan.byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const github = { readFailed: () => opts.githubFails === true, prByRef: () => null, findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], listOpenPrs: () => [],
    headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => ({ state: "OPEN", title: "decide" }) } as unknown as GitHub;
  const view = createNowView({ instances: [{ name: "site", ledgerDir, planPath: join(planDir, "tasks.yaml") }], coreInstance: "core",
    clock: CLOCK, readPlan: () => plan, planBehind: () => ({ commits: 0 }),
    github: () => ({ github, generation: "known", source: { asOf: AT, state: "fresh" } }),
    hostProbe: { readLive: () => [], diskFree: () => 1000, rateLimit: () => 5000 } });
  const [body] = view.materialize({ now: CLOCK.now(), switches: { views: { now: "serve" } }, instances: [{ db, state: { instance: "site",
    generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: CLOCK.now(), newestTs: null } }] });
  assert.ok(body);
  return { view: "now", key: "instance=site", version: view.version, generation: 1, etag: "now",
    body: { view: "now", version: view.version, generatedAt: CLOCK.iso(), asOf: AT, stale: false, sources: body.sources, data: body.data } };
}

/** The Inbox's real needsYou page and the classification snapshot the nav badge reads, from the same proposals. */
function inboxEntry(root: string, proposals: ReadonlyArray<[string, InboxState]>): ReadModelBodyEntry {
  mkdirSync(join(root, "state"), { recursive: true });
  const rows = proposals.map(([id, state]) => ({ proposal: { id, summary: id, evidenceAnchors: [] }, classification: { proposalId: id, state, reasons: [] } }));
  writeClassificationSnapshot(join(root, "state"), rows.map((r) => r.classification), CLOCK);
  const lanes = inboxLanes({ proposals: rows.map((r) => r.proposal), classifications: rows.map((r) => r.classification),
    ledgerLines: Object.assign([], { torn: 0, present: true }) }, root);
  const source: ViewSource = { name: "inbox-store:core", instance: "core", asOf: CLOCK.iso(), state: "fresh" };
  const page = inboxViewBodies(lanes, source).find((b) => b.key === "section=needsYou")!;
  return { view: "inbox", key: page.key, version: 1, generation: 1, etag: "inbox",
    body: { view: "inbox", version: 1, generatedAt: CLOCK.iso(), asOf: CLOCK.iso(), stale: false, sources: page.sources, data: page.data } };
}

/** GET /v1/status as serve wraps it, over a board body whose blocked backlog is not a decision count. */
async function statusNeedsYou(read: () => HumanGateProjection | undefined): Promise<{ counts: { blocked: number }; needsYou: HumanGateCountSummary }> {
  const board: Route = { method: "GET", path: "/v1/status", scope: "read", handler: (_req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ counts: { blocked: 40 }, tasks: [{ taskId: "W1-T1", status: "blocked", needsHuman: true }] }));
  } };
  let sent = "";
  const res = { writeHead: () => res, end: (chunk?: string) => { sent = chunk ?? ""; } } as unknown as ServerResponse;
  await withStatusNeedsYou(board, read).handler({ url: "/v1/status", headers: {} } as never, res, {} as never);
  return JSON.parse(sent);
}

interface Surfaces {
  now: HumanGateCountSummary;
  composite: HumanGateCountSummary;
  servedBadge: HumanGateCountSummary;
  legacyBadge: HumanGateCountSummary;
  legacyBadgeData: NavBadgeData;
  status: HumanGateCountSummary;
  statusBlocked: number;
  compositeData: NeedsYouData;
}

/** Every human decision surface, each through its production path, over one set of read-model bodies. */
async function surfaces(root: string, now: ReadModelBodyEntry, inbox: ReadModelBodyEntry, known: string[]): Promise<Surfaces> {
  const legacy = navBadgeView({ scopes: () => [], inboxRoot: root, clock: CLOCK });
  const plain = legacy.compute(new URLSearchParams());
  assert.ok(!("error" in plain));
  const badgeBody: ReadModelBodyEntry = { view: "nav-badge", key: "", version: 1, generation: 1, etag: "badge",
    body: { view: "nav-badge", version: 1, generatedAt: CLOCK.iso(), asOf: CLOCK.iso(), stale: false, sources: plain.sources, data: plain.data } };
  const bodies = new Map<string, ReadModelBodyEntry>([[`now\u0000${now.key}`, now], [`inbox\u0000${inbox.key}`, inbox], ["nav-badge\u0000", badgeBody]]);
  const inner = { bodies, body: (view: string, key = "") => bodies.get(`${view}\u0000${key}`), onBody: () => () => true,
    state: () => ({ instances: new Map(known.map((name) => [name, {}])), switches: { views: {} } }) } as unknown as ReadModelWorkerHandle;
  const handle = withNeedsYouView(inner, CLOCK);
  const gates = (): HumanGateProjection | undefined => (handle.body(NEEDS_YOU_VIEW_NAME)?.body.data as NeedsYouData | undefined)?.humanGates;
  const compositeData = handle.body(NEEDS_YOU_VIEW_NAME)!.body.data as NeedsYouData;
  const served = handle.body("nav-badge")!.body.data as NavBadgeData;
  const decorated = navBadgeWithDecisions(legacy, gates).compute(new URLSearchParams());
  assert.ok(!("error" in decorated));
  const status = await statusNeedsYou(gates);
  return {
    now: (now.body.data as NowViewData).needsYou!, composite: compositeData.needsYou, servedBadge: served.inbox.decisions!,
    legacyBadge: decorated.data.inbox.decisions!, legacyBadgeData: decorated.data, status: status.needsYou,
    statusBlocked: status.counts.blocked, compositeData,
  };
}

const SUMMARY_SCHEMA = resolve({ $ref: "#/components/schemas/HumanGateCountSummary" });

const withoutDisplay = ({ display: _display, ...summary }: HumanGateCountSummary) => summary;

test("every human decision surface reports the same uncapped source-qualified count", async (t) => {
  const root = tempRoot(t);
  const now = nowEntry(t, { escalations: NOW_DECISIONS_CAP + 3 });
  const nowData = now.body.data as NowViewData;
  assert.equal(nowData.decisions.length, NOW_DECISIONS_CAP, "the now view's display page is capped");
  assert.equal(nowData.decisionsMore, 3);
  const all = await surfaces(root, now, inboxEntry(root, [["followup:machine", "ready"]]), ["site"]);
  const expected = { count: NOW_DECISIONS_CAP + 3 };
  for (const [name, summary] of Object.entries({ now: all.now, composite: all.composite, servedBadge: all.servedBadge, legacyBadge: all.legacyBadge, status: all.status })) {
    assert.deepEqual(summary.inbox, expected, `${name} counts every decision, not the displayed rows`);
    assert.deepEqual(violations(summary, SUMMARY_SCHEMA), [], `${name} sends the declared wire shape`);
    assert.deepEqual(summary.byKind, { escalation: NOW_DECISIONS_CAP + 3 }, name);
    assert.deepEqual(summary.changeManagement, { count: 0 }, name);
    assert.deepEqual(summary.uncertain, [], `${name}: every source is complete, so the count is exact`);
    assert.deepEqual(summary.instances.find((i) => i.instance === "site")?.inbox, expected, `${name} keeps the instance identity`);
    if (name !== "now") assert.deepEqual(summary.instances.find((i) => i.instance === "core")?.inbox, { count: 0 }, `${name}: a complete source may report exact zero`);
    assert.ok(summary.kinds.covered.includes("escalation") && summary.kinds.covered.includes("proposal") || name === "now", name);
    assert.ok(summary.kinds.covered.includes("held_root") && summary.kinds.missing.length > 0 && !summary.kinds.missing.some((kind) => summary.kinds.covered.includes(kind)), `${name} names the gate kinds no adapter reads yet`);
  }
  assert.deepEqual(all.now.display, { shown: NOW_DECISIONS_CAP, more: { count: 3 } }, "the now view exposes its paging");
  assert.deepEqual(all.composite.display, { shown: NOW_DECISIONS_CAP, more: { count: 3 } }, "the composite exposes its paging");
  for (const summary of [all.servedBadge, all.legacyBadge, all.status]) assert.deepEqual(summary, withoutDisplay(all.composite));
});

test("every human decision surface preserves lower bounds and unavailable sources", async (t) => {
  const root = tempRoot(t);
  const now = nowEntry(t, { escalations: 2, githubFails: true });
  const all = await surfaces(root, now, inboxEntry(root, [["ruling:ask", "ready"]]), ["other", "site"]);
  for (const [name, summary] of Object.entries({ composite: all.composite, servedBadge: all.servedBadge, legacyBadge: all.legacyBadge, status: all.status })) {
    assert.equal(summary.inbox.count, undefined, `${name} never reports an exact count over unreadable evidence`);
    assert.deepEqual(violations(summary, SUMMARY_SCHEMA), [], name);
    assert.ok((summary.inbox.atLeast ?? -1) >= 1, `${name} keeps the observed lower bound`);
    assert.ok(summary.uncertain.some((s) => s.instance === "other" && s.state === "unavailable" && s.reason === "no now body for this instance yet"), name);
    assert.ok(summary.uncertain.some((s) => s.name === "escalations" && s.instance === "site" && s.state === "partial"), name);
    assert.deepEqual(summary.instances.find((i) => i.instance === "other")?.inbox, { atLeast: 0 }, `${name}: an unread instance is not a zero`);
  }
  assert.equal(all.now.inbox.count, undefined, "the instance's own now view keeps its lower bound too");
  assert.ok(all.now.uncertain.some((s) => s.name === "escalations" && s.state === "partial"));
  assert.deepEqual(all.composite.display?.more, { atLeast: 0 }, "the remainder past a page is a lower bound as well");
  // No composite at all (serve runs no read model): the badge and status name why rather than reporting zero.
  const legacy = navBadgeWithDecisions(navBadgeView({ scopes: () => [], inboxRoot: root, clock: CLOCK }), () => undefined).compute(new URLSearchParams());
  assert.ok(!("error" in legacy));
  const status = await statusNeedsYou(() => undefined);
  for (const summary of [legacy.data.inbox.decisions!, status.needsYou]) {
    assert.deepEqual(summary.inbox, { atLeast: 0 });
    assert.deepEqual(summary.uncertain, [{ name: "needs-you", instance: "core", state: "unavailable", reason: NAV_BADGE_NO_COMPOSITE }]);
  }
});

test("Inbox counts exclude machine work and separately label change management", async (t) => {
  const root = tempRoot(t);
  const now = nowEntry(t, { escalations: 2, hold: true });
  const all = await surfaces(root, now, inboxEntry(root, [
    ["ruling:operator", "ready"], ["followup:fleet-owned", "ready"], ["ruling:drafting", "drafting"],
  ]), ["site"]);
  assert.deepEqual(all.now.inbox, { count: 2 }, "the instance's escalations, without its merge hold");
  assert.deepEqual(all.now.changeManagement, { count: 1 }, "the standing merge hold is change management");
  for (const [name, summary] of Object.entries({ composite: all.composite, servedBadge: all.servedBadge, legacyBadge: all.legacyBadge, status: all.status })) {
    assert.deepEqual(summary.inbox, { count: 3 }, `${name}: two escalations and one operator proposal; machine work and records excluded`);
    assert.deepEqual(summary.byKind, { escalation: 2, proposal: 1 }, name);
    assert.deepEqual(summary.changeManagement, { count: 1 }, `${name} labels the hold separately`);
    assert.equal((summary.byKind as Record<string, number>).merge_held, undefined, `${name} never counts a hold as an Inbox ask`);
  }
  assert.equal(all.statusBlocked, 40, "the status board's blocked backlog stays its own field");
  assert.equal(all.legacyBadgeData.inbox.needsYou, 1, "the badge's old proposal-lane field is preserved");
  assert.ok(all.compositeData.humanGates.gates.some((g) => g.kind === "merge_held" && g.ownerSurface === "change-management"));
});
