import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { classifyAskRecordItem, projectClassifiedHumanGates } from "../src/lib/ask-classification.js";
import { fixedClock } from "../src/lib/clock.js";
import { writeClassificationSnapshot } from "../src/lib/fleet-lane.js";
import type { HumanGateProjection } from "../src/lib/human-gate.js";
import type { InboxClassification, InboxState, Proposal } from "../src/lib/inbox.js";
import { inboxViewBodies } from "../src/lib/inbox-view.js";
import { appendThreadMessage, inboxThreadId, inboxThreadIdentity } from "../src/lib/inbox-thread.js";
import { INBOX_THREAD_VIEW_NAME, createInboxThreadView, inboxThreadStoreFile, inboxThreadViewKey } from "../src/lib/inbox-thread-view.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { navBadgeView } from "../src/lib/nav-badge-view.js";
import { composeNeedsYou } from "../src/lib/needs-you-view.js";
import { inboxLanes } from "../src/lib/panel-graph.js";
import type { ReadModelBodyEntry } from "../src/lib/read-model-worker.js";
import type { NowDecision } from "../src/lib/now-decisions.js";
import { projectConsoleStatusResponse } from "../src/lib/serve.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createDemandBook } from "../src/lib/view-demand.js";
import type { ViewSource } from "../src/lib/views.js";

const CLOCK = fixedClock(Date.parse("2026-10-04T12:00:00Z"));
const SOURCE: ViewSource = { name: "inbox-store:core", instance: "core", asOf: CLOCK.iso(), state: "fresh" };
const STATES = {
  ready: "ASK", not_ready: "ASK", deferred_with_trigger: "ASK", drafting: "RECORD",
  declined: "RECORD", ratified: "RECORD", retired: "RECORD",
} as const satisfies Record<InboxState, "ASK" | "RECORD">;

function fixture(t: { after: (fn: () => void) => void }) {
  const root = makeTempDir("human-gate-classification");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function proposal(proposalId: string, state: InboxState): { proposal: Proposal; classification: InboxClassification } {
  return {
    proposal: { id: proposalId, summary: proposalId, evidenceAnchors: [] },
    classification: { proposalId, state, reasons: [], ...(state === "deferred_with_trigger" ? { trigger: { description: "after the source PR merges", fired: false } } : {}) },
  };
}

function lanes(root: string, rows: ReturnType<typeof proposal>[]) {
  return inboxLanes({ proposals: rows.map((r) => r.proposal), classifications: rows.map((r) => r.classification), ledgerLines: Object.assign([], { torn: 0, present: true }) }, root);
}

function badge(root: string) {
  const result = navBadgeView({ scopes: () => [], inboxRoot: root, clock: CLOCK }).compute(new URLSearchParams());
  assert.ok(!("error" in result));
  return result;
}

function composite(input: ReturnType<typeof lanes>) {
  const page = inboxViewBodies(input, SOURCE).find((b) => b.key === "section=needsYou")!;
  const entry: ReadModelBodyEntry = {
    view: "inbox", key: page.key, version: 1, generation: 1, etag: "fixture",
    body: { view: "inbox", version: 1, generatedAt: CLOCK.iso(), asOf: CLOCK.iso(), stale: false, sources: page.sources, data: page.data },
  };
  return { page, result: composeNeedsYou(new Map([["inbox", entry]]), []) };
}

test("every proposal state agrees across Inbox badge and classifier", (t) => {
  const root = fixture(t);
  for (const [state, expected] of Object.entries(STATES) as [InboxState, "ASK" | "RECORD"][]) {
    const row = proposal("ruling:state", state);
    writeClassificationSnapshot(join(root, "state"), [row.classification], CLOCK);
    const input = lanes(root, [row]);
    const { page, result } = composite(input);
    const asks = page.data.items.filter((item) => (item as typeof item & { classification?: string }).classification === "ASK");
    assert.equal(classifyAskRecordItem({ kind: "proposal", state }), expected, state);
    assert.equal(asks.length, expected === "ASK" ? 1 : 0, `Inbox ${state}`);
    assert.equal(badge(root).data.inbox.needsYou, expected === "ASK" ? 1 : 0, `badge ${state}`);
    assert.equal(result.data.humanGates.gates.length, expected === "ASK" ? 1 : 0, `composite ${state}`);
    assert.deepEqual(result.data.inbox?.items, page.data.items);
    assert.equal(input.counts.needsYou.ready + input.counts.needsYou.notReady + input.counts.needsYou.drafting + input.counts.needsYou.declined, expected === "ASK" ? 1 : 0, `Inbox decision count ${state}`);
    if (state === "drafting" || state === "declined") {
      assert.equal(input[state].length, 1, "record history stays visible");
      assert.equal(page.data.items.length, 1, "thread readers still see the record in the Inbox page");
      assert.equal((page.data.items[0] as typeof page.data.items[number] & { classification?: string }).classification, "RECORD");
    }
  }
});

test("deferred asks retain their trigger without reviving declined proposals", (t) => {
  const root = fixture(t);
  const deferred = proposal("ruling:deferred", "deferred_with_trigger");
  const declined = proposal("ruling:declined", "declined");
  declined.classification.declinedReason = "the operator declined this";
  const input = lanes(root, [deferred, declined]);
  const { page, result } = composite(input);
  assert.deepEqual(page.data.items.map((i) => i.proposalId), [deferred.proposal.id, declined.proposal.id]);
  assert.equal(input.counts.needsYou.declined, 0);
  const item = page.data.items[0] as unknown as { trigger: unknown; state: InboxState; resolution: { method: string; path: string; fields: unknown } };
  assert.equal(item.state, "deferred_with_trigger");
  assert.deepEqual(item.trigger, deferred.classification.trigger);
  assert.deepEqual(item.resolution, { method: "POST", path: "/v1/inbox/reframe", fields: { proposalId: deferred.proposal.id } });
  assert.deepEqual(result.data.inbox?.items, page.data.items);
  assert.equal(result.data.humanGates.gates[0]?.reason, deferred.classification.trigger?.description);
  assert.equal(input.declined[0]?.reason, "the operator declined this");
});

test("shared gate projection excludes records and retains unknown source evidence", () => {
  const gate = { kind: "escalation", subject: "task", ownerSurface: "inbox", openedAt: CLOCK.iso(), url: "https://github.com/o/r/issues/1", reason: "needs a decision", resolutionVerb: "mark_handled" } as const;
  const gates = [
    { ...gate, subject: "open", classification: { kind: "gate", gate, resolved: false } as const },
    { ...gate, subject: "closed", classification: { kind: "gate", gate, resolved: true } as const },
    { ...gate, subject: "rundown", classification: { kind: "rundown", outcome: "escalated" } as const },
    { ...gate, subject: "machine", classification: { kind: "proposal", state: "ready", owner: "fleet" } as const },
  ];
  const result = projectClassifiedHumanGates([
    { name: "board", instance: "core", state: "complete", gates },
    { name: "questions", instance: "core", state: "unavailable", reason: "EACCES", gates: [] },
  ]);
  assert.deepEqual(result.gates.map((g) => g.key), ["escalation:core:open"]);
  assert.deepEqual(result.count.inbox, { atLeast: 1 });
  assert.equal(result.sources[1]?.reason, "EACCES");
  assert.equal(classifyAskRecordItem({ kind: "gate", gate, resolved: true }), "RECORD");
});

test("composite projects full instance gates before caps without crossing identities", (t) => {
  const root = fixture(t);
  const empty = composite(lanes(root, [])).page;
  const inbox: ReadModelBodyEntry = {
    view: "inbox", key: empty.key, version: 1, generation: 1, etag: "inbox",
    body: { view: "inbox", version: 1, generatedAt: CLOCK.iso(), asOf: CLOCK.iso(), stale: false, sources: empty.sources, data: empty.data },
  };
  const bodies = new Map<string, ReadModelBodyEntry>([["inbox", inbox]]);
  for (const instance of ["core", "other:instance"]) {
    const observed = { kind: "escalation", subject: "same:task", ownerSurface: "inbox", openedAt: CLOCK.iso(), url: "https://github.com/o/r/issues/1", reason: "choose a disposition", resolutionVerb: "mark_handled" } as const;
    const projection = projectClassifiedHumanGates([{ name: "escalations", instance, state: "complete", gates: [observed, { ...observed, subject: "off-page" }] }]);
    const decision: NowDecision = {
      id: "escalation:same:task", kind: "escalation", instance, taskId: observed.subject, title: "same title", prompt: observed.reason,
      answer: { method: "POST", path: instance === "core" ? "/v1/escalation/mark-handled" : "/v1/i/other:instance/escalation/mark-handled", tier: "low", fields: { taskId: observed.subject, issueUrl: observed.url }, input: "choice" },
    };
    bodies.set(instance, {
      view: "now", key: new URLSearchParams({ instance }).toString(), version: 3, generation: 1, etag: instance,
      body: { view: "now", version: 3, generatedAt: CLOCK.iso(), asOf: CLOCK.iso(), stale: false, sources: [], data: { decisions: [decision, decision], decisionsMore: 1, actions: [], humanGates: projection } },
    });
  }
  const result = composeNeedsYou(bodies, ["core", "other:instance"]);
  assert.deepEqual(result.data.humanGates.count.inbox, { count: 4 });
  assert.equal(new Set(result.data.humanGates.gates.map((g) => g.key)).size, 4);
  assert.equal(result.data.decisions.length, 2, "one displayed ask per source condition and instance");
  assert.equal(result.data.decisions[1]?.answer.path, "/v1/i/other:instance/escalation/mark-handled");
  assert.ok(result.data.humanGates.gates.every((g) => g.openedAt === CLOCK.iso()));
});

test("initial board keeps unverified asks through the shared projection", () => {
  const tasks = Array.from({ length: 501 }, (_, i) => ({ taskId: `task-${i}`, title: "task", status: "queued" }));
  const ask = { taskId: "ask", title: "operator decision", status: "blocked", needsHuman: true, escalationUnverified: true };
  tasks.push(ask);
  const result = projectConsoleStatusResponse({ tasks, counts: { total: tasks.length } }) as { tasks: unknown[] };
  assert.deepEqual(result.tasks, [ask]);
});

test("an incomplete Inbox page preserves observed asks and names the coverage gap", (t) => {
  const root = fixture(t);
  const rows = Array.from({ length: 120 }, (_, i) => {
    const row = proposal(`ruling:${i}`, "ready");
    row.proposal.summary = "source condition ".repeat(60);
    return row;
  });
  const { page, result } = composite(lanes(root, rows));
  assert.ok(page.data.page.of > 1, "the production pager must actually cap this fixture");
  assert.deepEqual(result.data.humanGates.count.inbox, { atLeast: page.data.items.length });
  assert.ok(result.data.humanGates.sources.some((source) => source.state === "partial" && source.reason === "only the Inbox display page is available"));
});

test("unavailable read-model evidence remains unavailable in the classified projection", (t) => {
  const root = fixture(t);
  const page = composite(lanes(root, [proposal("ruling:observed", "ready")])).page;
  const source: ViewSource = { ...SOURCE, state: "unavailable", reason: "classification could not be refreshed" };
  const inbox: ReadModelBodyEntry = {
    view: "inbox", key: page.key, version: 1, generation: 1, etag: "partial",
    body: { view: "inbox", version: 1, generatedAt: CLOCK.iso(), asOf: CLOCK.iso(), stale: true, sources: [source], data: page.data },
  };
  const result = composeNeedsYou(new Map([["inbox", inbox]]), []);
  assert.deepEqual(result.data.humanGates.count.inbox, { atLeast: 1 });
  assert.ok(result.data.humanGates.sources.some((s) => s.name === SOURCE.name && s.state === "unavailable" && s.reason === source.reason));
});

test("record classification preserves the actual Inbox thread reader and its history", (t) => {
  const root = fixture(t);
  const id = "ruling:history";
  const threadId = inboxThreadId(id);
  appendThreadMessage(inboxThreadIdentity(id), "escalation", "the prior source decision", { threadStorePath: inboxThreadStoreFile(root), now: CLOCK.now });
  const demand = createDemandBook({ clock: CLOCK });
  demand.want(INBOX_THREAD_VIEW_NAME, inboxThreadViewKey(threadId));
  const view = createInboxThreadView({ inboxRoot: root, demand, clock: CLOCK });
  const db = openProjectorReadModel(join(root, "read-model"), "core");
  try {
    db.exec("CREATE TABLE view_body(view TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, generation INTEGER NOT NULL, etag TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(view,key)) WITHOUT ROWID");
    for (const state of ["drafting", "declined"] as const) {
      const { page } = composite(lanes(root, [proposal(id, state)]));
      db.prepare("INSERT OR REPLACE INTO view_body VALUES('inbox', ?, 1, 1, ?, ?)").run(page.key, state, JSON.stringify({ data: page.data, sources: page.sources }));
      const body = view.materialize({ now: CLOCK.now(), instances: [{ db }] })[0]!;
      assert.equal(body.data.found, true, state);
      if (state === "declined") assert.equal(body.data.thread?.attention, "history");
      assert.equal((page.data.items[0] as typeof page.data.items[number] & { classification?: string }).classification, "RECORD");
      assert.ok(body.data.thread?.messages.some((message) => message.text === "the prior source decision"));
    }
  } finally {
    db.close();
  }
});

test("classifier preserves source coverage and machine ownership", (t) => {
  const root = fixture(t);
  const rows = [proposal("ruling:one", "ready"), proposal("adoption:one", "ready"), proposal("adoption:draft", "drafting")];
  const input = lanes(root, rows);
  writeClassificationSnapshot(join(root, "state"), rows.map((r) => r.classification), CLOCK);
  const { result } = composite(input);
  assert.equal(badge(root).data.inbox.needsYou, 1);
  assert.equal(input.fleet.length, 2, "machine records stay in their fleet lane");
  const projected = (result.data as typeof result.data & { humanGates?: HumanGateProjection }).humanGates;
  assert.ok(projected, "the composite carries the shared projection");
  assert.deepEqual(projected.count.inbox, { atLeast: 1 }, "absent instance evidence cannot become an exact count");
  assert.deepEqual(projected.gates.map((g) => g.key), ["proposal:core:ruling%3Aone"]);
  assert.ok(projected.sources.some((s) => s.state === "unavailable" && s.reason));
  const empty = composeNeedsYou(new Map(), ["core"]);
  assert.deepEqual((empty.data as typeof empty.data & { humanGates?: HumanGateProjection }).humanGates?.count.inbox, { atLeast: 0 });
  assert.equal(empty.data.instances[0]?.counts, undefined);
  rmSync(join(root, "state", "inbox-classified.json"));
  assert.equal(badge(root).data.inbox.needsYou, undefined);
  assert.match(badge(root).data.inbox.reason ?? "", /no inbox classification/);
});
