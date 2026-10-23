import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { captureInboxInput, causalThreadInputs } from "#src/lib/inbox-thread.js";
import { flushReadModelTransactions } from "#src/lib/read-model-db.js";

import { createDemandBook } from "../src/lib/view-demand.js";
import { createInboxThreadView, inboxThreadViewKey, type InboxThreadViewData } from "../src/lib/inbox-thread-view.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { answerThread, createThreadEventSync, registryThreadItems, startInboxResponder, type InboxResponderDeps, type ThreadDetailView } from "../src/lib/inbox-responder.js";
import { parseProposalRegistry, recordRowThreadEvents, reframeProposal, type Proposal } from "../src/lib/inbox.js";
import { appendThreadReplyOnce, inboxThreadId, inboxThreadIdentity, readThread, type ThreadMessage } from "../src/lib/inbox-thread.js";
import { buildDeclineProposalRoute, buildInboxRoute, buildInboxThreadReplyRoute, buildInboxThreadRoute, buildRestoreProposalRoute, inboxThreadStorePath, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { approveParkedTask } from "../src/run-task.js";

const T0 = Date.parse("2026-10-13T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

interface Fx {
  root: string;
  stateDir: string;
  ledgerPath: string;
  threadStorePath: string;
  deps: PanelGraphDeps;
  proposals: Proposal[];
  base: string;
}

/** A registry on disk, a ledger of the given rows, and the thread routes over both. */
async function fixture(t: { after: (fn: () => void) => void }, registry: Array<Record<string, unknown>>, ledger: Array<Record<string, unknown>> = []): Promise<Fx> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9252-`));
  let server: ReturnType<typeof createService> | undefined;
  t.after(async () => {
    const ownedServer = server;
    if (ownedServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        ownedServer.close(error => error ? reject(error) : resolve());
        ownedServer.closeAllConnections();
      });
    }
    // SQLite close queues its diagnostic writer's final record; deletion must wait for its ACK.
    await flushReadModelTransactions();
    rmSync(root, { recursive: true, force: true });
  });
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const registryText = JSON.stringify({ proposals: registry.map((p) => ({ summary: `${String(p.id)} needs a person`, evidenceAnchors: [], ...p })) });
  writeFileSync(join(stateDir, "inbox-proposals.json"), registryText);
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, ledger.map((row) => JSON.stringify(row) + "\n").join(""));
  const deps: PanelGraphDeps = {
    root,
    inboxRoot: root,
    planPath: join(root, "plan", "tasks.yaml"),
    ledgerPath,
    github: { prView: () => null },
    statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    ratify: { approve: () => {}, reframe: () => {} },
  };
  server = createService({
    tokens: { read: "t9252-read", write: "t9252-write" },
    routes: [buildInboxRoute(deps), buildInboxThreadRoute(deps), buildInboxThreadReplyRoute(deps), buildDeclineProposalRoute(deps), buildRestoreProposalRoute(deps)],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    root, stateDir, ledgerPath, deps,
    threadStorePath: inboxThreadStorePath(root),
    proposals: parseProposalRegistry(registryText),
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

const get = async (fx: Fx, path: string) => {
  const response = await fetch(`${fx.base}${path}`, { headers: { authorization: "Bearer t9252-read" } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const post = async (fx: Fx, path: string, body: unknown) => {
  const response = await fetch(`${fx.base}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer t9252-write", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const threadOf = async (fx: Fx, proposalId: string) => {
  const read = await get(fx, `/v1/inbox/thread?id=${encodeURIComponent(inboxThreadId(proposalId))}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  return read.body as unknown as ThreadDetailView;
};
const eventsOf = (view: ThreadDetailView) => view.messages.filter((m) => m.extra?.event).map((m) => ({ kind: m.extra!.event!.kind, from: m.from, text: m.text }));
const storedEvents = (fx: Fx, proposalId: string): ThreadMessage[] => {
  const read = readThread(inboxThreadId(proposalId), { threadStorePath: fx.threadStorePath });
  assert.equal(read.status, "ok");
  return read.status === "ok" ? read.messages.filter((m) => m.extra?.event) : [];
};
const rowsWritten = (fx: Fx): Array<Record<string, unknown>> => readFileSync(fx.ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

const HUMAN = "verify-human:W1-T900";
const JUDGE = "machine-judge:W1-T900";

test("W1-T9252: reframe, decline and restore each appear once on the thread in order", async (t) => {
  const fx = await fixture(t, [{ id: HUMAN }]);
  const proposal = fx.proposals[0]!;
  reframeProposal(proposal, "Split this into two tasks, one per repo.", {}, { ledgerPath: fx.ledgerPath, runId: "REFRAME-1", threadStorePath: fx.threadStorePath });
  assert.equal((await post(fx, "/v1/inbox/decline", { proposalId: HUMAN, reason: "Already covered by W1-T901." })).status, 200);
  assert.equal((await post(fx, "/v1/inbox/restore", { proposalId: HUMAN, reason: "It was not covered after all." })).status, 200);

  const view = await threadOf(fx, HUMAN);
  assert.deepEqual(eventsOf(view), [
    { kind: "reframed", from: "operator", text: "Split this into two tasks, one per repo." },
    { kind: "declined", from: "operator", text: "Already covered by W1-T901." },
    { kind: "restored", from: "operator", text: "It was not covered after all." },
  ]);
  assert.equal(view.messages[0]!.seq, 0, "the opening message stays first");
  assert.equal(view.waitingOn, "daemon", "the operator's action was the last word, so the thread waits on the fleet");
  // Once each: the verbs' own ledger rows are the same actions, and re-reading them adds nothing.
  assert.equal(await createThreadEventSync({ ledgerPath: fx.ledgerPath, threadStorePath: fx.threadStorePath }).backfill(), 0);
  assert.equal(storedEvents(fx, HUMAN).length, 3);
});

test("W1-T9252: a release appears on every open ask thread for the task", async (t) => {
  const fx = await fixture(t, [{ id: HUMAN }, { id: JUDGE }, { id: "proof-debt:W1-T900" }, { id: "verify-human:W1-T901" }]);
  const plan = { byId: new Map([["W1-T900", { id: "W1-T900", verify: "human", status: "queued" }]]) } as never;
  const out = approveParkedTask("W1-T900", {
    plan, ledgerPath: fx.ledgerPath, runId: "APPROVE-W1-T900", ledgerLines: [],
    recordThreadRow: (row) => void recordRowThreadEvents(rowsWritten(fx).find((line) => line.step === row.step) ?? row, fx.proposals, { threadStorePath: fx.threadStorePath }),
  });
  assert.equal(out.released, true);
  for (const id of [HUMAN, JUDGE]) {
    assert.deepEqual(storedEvents(fx, id).map((m) => [m.extra!.event!.kind, m.role]), [["released", "reply"], ["released_to_fleet", "escalation"]], id);
  }
  assert.equal(storedEvents(fx, "proof-debt:W1-T900").length, 0, "a fleet-owned finding has no operator thread to write on");
  assert.equal(storedEvents(fx, "verify-human:W1-T901").length, 0, "another task's ask is untouched");
});

test("W1-T9252: a redraft, a filed task and a refusal follow the operator action", async (t) => {
  const repository = "fixture/repository";
  const input = captureInboxInput({ repository }, "ruling:P1", "Shorter, please.", "feedback:W1-T9252");
  const fx = await fixture(t, [
    { id: "ruling:P1", reframeHistory: [{ feedback: "Shorter, please.", input }] },
    { id: "ruling:P2" },
  ], [
    { ts: iso(0), run_id: "REFRAME-1", task_id: "ruling:P1", step: "ratify.reframed", feedback: "Shorter, please.", repository, input },
    { ts: iso(1_000), run_id: "DRAFT-1", step: "inbox.drafted", proposal_id: "ruling:P1", lint_clean: true,
      repository, completion_id: "completion:W1-T9252", consumed_inputs: [input], cache_adopted: true },
    { ts: iso(2_000), run_id: "APPROVE-P1", task_id: "ruling:P1", step: "ratify.approved" },
    { ts: iso(3_000), run_id: "APPROVE-P1", step: "approve.shards_written", proposal_id: "ruling:P1", paths: ["plan/tasks.d/W1-T950-the-shorter-thing.yaml"] },
    { ts: iso(4_000), run_id: "APPROVE-P2", task_id: "ruling:P2", step: "ratify.approve_refused", state: "not_ready", reason: "it has no draft yet" },
    { ts: iso(5_000), run_id: "DRAFT-2", step: "inbox.drafted", proposal_id: "ruling:P2", lint_clean: true },
  ]);
  const sync = createThreadEventSync({ ledgerPath: fx.ledgerPath, threadStorePath: fx.threadStorePath });
  assert.equal(await sync.backfill(), 5);

  const first = readThread(inboxThreadId("ruling:P1"), { threadStorePath: fx.threadStorePath });
  assert.equal(first.status, "ok");
  const shown = first.status === "ok" ? first.messages.map((m) => [m.extra!.event!.kind, m.role === "reply" ? "operator" : "daemon", m.ts]) : [];
  assert.deepEqual(shown, [
    ["reframed", "operator", T0], ["redrafted", "daemon", T0 + 1_000], ["approved", "operator", T0 + 2_000], ["task_filed", "daemon", T0 + 3_000],
  ]);
  assert.equal(first.status === "ok" && first.messages[0]!.extra!.input!.id, input.id);
  assert.deepEqual(first.status === "ok" && first.messages[1]!.extra!.response!.inputs, [input], "the adopted redraft consumed this captured direction");
  assert.match(storedEvents(fx, "ruling:P1")[3]!.body, /W1-T950/);
  assert.deepEqual(storedEvents(fx, "ruling:P2").map((m) => m.extra!.event!.kind), ["refused"], "a draft nobody asked to redo is not announced as a redraft");
  assert.match(storedEvents(fx, "ruling:P2")[0]!.body, /no draft yet/);

  // The daemon's tail mirrors a row appended after the backfill, once.
  appendFileSync(fx.ledgerPath, JSON.stringify({ ts: iso(6_000), run_id: "APPROVE-P2", task_id: "ruling:P2", step: "ratify.approve_refused", reason: "still no draft" }) + "\n");
  assert.equal(await sync.sync(), 1);
  assert.equal(await sync.sync(), 0);
  assert.equal(storedEvents(fx, "ruling:P2").length, 2);
});

test("W1-T9252: an unlinked historical draft cannot consume later captured direction", async (t) => {
  const repository = "fixture/repository", proposalId = "ruling:legacy";
  const feedback = "Keep the newer direction pending.";
  const input = captureInboxInput({ repository }, proposalId, feedback, "feedback:W1-T9252-later");
  const fx = await fixture(t, [{ id: proposalId, reframeHistory: [{ feedback: "Legacy direction." }, { feedback, input }] }], [
    { ts: iso(0), run_id: "LEGACY-REFRAME", task_id: proposalId, step: "ratify.reframed", feedback: "Legacy direction." },
    { ts: iso(1_000), run_id: "LEGACY-DRAFT", step: "inbox.drafted", proposal_id: proposalId, lint_clean: true },
    { ts: iso(2_000), run_id: "LATER-REFRAME", task_id: proposalId, step: "ratify.reframed", feedback, repository, input },
  ]);
  const registryPath = join(fx.stateDir, "inbox-proposals.json"), original = readFileSync(registryPath, "utf8");
  const sync = createThreadEventSync({ ledgerPath: fx.ledgerPath, threadStorePath: fx.threadStorePath });
  assert.equal(await sync.backfill(), 2);
  assert.equal(await sync.backfill(), 0, "replay does not manufacture an answer from historical ordering");
  const messages = storedEvents(fx, proposalId);
  assert.deepEqual(messages.map(message => message.extra!.event!.kind), ["reframed", "reframed"]);
  assert.ok(messages.every(message => message.extra?.response === undefined));
  const correspondence = causalThreadInputs(messages, { repository }, proposalId, fx.proposals[0]!.reframeHistory);
  assert.equal(correspondence.unknown, true, "legacy linkage is unknown, not retrofitted");
  assert.deepEqual(correspondence.pending.map(message => message.extra!.input!.id), [input.id]);
  assert.equal(readFileSync(registryPath, "utf8"), original, "the original feedback history is unchanged");
});

test("W1-T9252: a retried verb and a re-run backfill write each event once", async (t) => {
  const fx = await fixture(t, [{ id: HUMAN }], [
    { ts: iso(0), run_id: "REFRAME-1", task_id: HUMAN, step: "ratify.reframed", feedback: "Name the repo." },
    { ts: iso(500), run_id: "PANEL-1", task_id: HUMAN, step: "panel.proposal_declined", origin: "tok", reason: "Not needed." },
  ]);
  const store = { threadStorePath: fx.threadStorePath };
  for (const row of rowsWritten(fx)) {
    assert.equal(recordRowThreadEvents(row, fx.proposals, store), 1);
    assert.equal(recordRowThreadEvents(row, fx.proposals, store), 0, "the retried verb writes nothing new");
  }
  const sync = createThreadEventSync({ ledgerPath: fx.ledgerPath, threadStorePath: fx.threadStorePath });
  assert.equal(await sync.backfill(), 0, "the verbs already wrote them");
  assert.equal(await sync.backfill(), 0, "a re-run backfill writes nothing either");
  assert.deepEqual(storedEvents(fx, HUMAN).map((m) => m.extra!.event!.kind), ["reframed", "declined"]);

  // A store that cannot be read is reported, never thrown into the verb.
  writeFileSync(fx.threadStorePath, "{ not json\n");
  const logged: string[] = [];
  assert.equal(recordRowThreadEvents({ ts: iso(900), run_id: "R", task_id: HUMAN, step: "ratify.reframed", feedback: "x" }, fx.proposals, store, (step) => void logged.push(step)), 0);
  assert.deepEqual(logged, ["inbox.thread_event_failed"]);
});

test("W1-T9252: a thread-reply action is not echoed as a second event", async (t) => {
  const fx = await fixture(t, [{ id: HUMAN }, { id: "ruling:P3" }]);
  const store = { threadStorePath: fx.threadStorePath };
  const reframed: Array<[string, string]> = [];
  const responder = (): InboxResponderDeps => ({
    threadStorePath: fx.threadStorePath,
    ledgerPath: fx.ledgerPath,
    readItems: () => registryThreadItems(fx.stateDir, fx.ledgerPath),
    reframe: (id, feedback) => void reframed.push([id, feedback]),
  });

  appendThreadReplyOnce(inboxThreadIdentity(HUMAN), "Drop it, this is not needed.", "reply-decline-1", store);
  assert.equal(await answerThread(inboxThreadId(HUMAN), responder()), "decline");
  // A reply that asks for a change: the reframe it starts writes `ratify.reframed` with the operator's own words.
  appendThreadReplyOnce(inboxThreadIdentity("ruling:P3"), "Please rewrite it around the console.", "reply-edit-1", store);
  assert.equal(await answerThread(inboxThreadId("ruling:P3"), responder()), "edit");
  reframeProposal(fx.proposals[1]!, "Please rewrite it around the console.", {}, { ledgerPath: fx.ledgerPath, runId: "REFRAME-2", threadStorePath: fx.threadStorePath });

  assert.deepEqual(reframed, [["ruling:P3", "Please rewrite it around the console."]]);
  await createThreadEventSync({ ledgerPath: fx.ledgerPath, threadStorePath: fx.threadStorePath }).backfill();
  assert.equal(storedEvents(fx, HUMAN).filter((m) => m.extra!.event!.kind === "declined").length, 0, "the responder's own decline row is not a second 'declined'");
  assert.equal(storedEvents(fx, "ruling:P3").length, 0, "the reframe of the operator's own reply is not echoed back");
  const did = readThread(inboxThreadId(HUMAN), store);
  assert.deepEqual(did.status === "ok" ? did.messages.map((m) => m.extra?.did?.action ?? m.role) : [], ["reply", "decline"]);
});

test("W1-T9252: a reply to a Board review or machine-judge item succeeds and appears on its thread", async (t) => {
  const waiting = { trigger: { description: "the board item is answered", fired: false } };
  const BOARD = "board-review:escalation:#2101";
  const MJ = "machine-judge:W1-T7001";
  const fx = await fixture(t, [{ id: BOARD, ...waiting }, { id: MJ, ...waiting }]);
  for (const id of [BOARD, MJ]) {
    const threadId = inboxThreadId(id);
    const opening = await get(fx, `/v1/inbox/thread?id=${encodeURIComponent(threadId)}`);
    assert.equal(opening.status, 200, `${id} reads before any reply`);
    assert.equal((opening.body as unknown as ThreadDetailView).messages.length, 1, "no stored conversation: the opening message alone");
    const replied = await post(fx, "/v1/inbox/thread/reply", { threadId, text: "Take the narrower option.", intentId: `intent-${id.length}-abcdefgh` });
    assert.equal(replied.status, 200, JSON.stringify(replied.body));
    const after = await threadOf(fx, id);
    assert.deepEqual(after.messages.map((m) => [m.from, m.text]).slice(1), [["operator", "Take the narrower option."]]);
  }
});

test("W1-T9252: every needsYou item has a readable thread", async (t) => {
  const waiting = { trigger: { description: "later", fired: false } };
  const fx = await fixture(t, [
    { id: "board-review:escalation:#3039", ...waiting },
    { id: "machine-judge:W1-T7002", ...waiting },
    { id: HUMAN },
    { id: "ruling:P9" },
    { id: "verify-human:W1-T902" },
    { id: "proof-debt:W1-T900" },
  ], [
    { ts: iso(0), run_id: "PANEL-9", task_id: "verify-human:W1-T902", step: "panel.proposal_declined", origin: "tok", reason: "Not needed." },
  ]);
  const listed = await get(fx, "/v1/inbox?section=needsYou");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const lanes = listed.body.needsYou as Record<string, Array<{ proposalId: string }>>;
  const ids = Object.values(lanes).flat().map((item) => item.proposalId);
  assert.ok(ids.includes("board-review:escalation:#3039") && ids.includes("machine-judge:W1-T7002"), `the deferred items are listed: ${ids.join(", ")}`);
  assert.ok(!ids.includes("proof-debt:W1-T900"), "a fleet-owned finding is not the operator's");
  for (const id of ids) assert.equal((await threadOf(fx, id)).proposalId, id, `${id} reads through GET /v1/inbox/thread`);

  // The inbox-thread view resolves the same items from the persisted needsYou pages.
  const viewDir = join(fx.root, "read-model");
  mkdirSync(viewDir, { recursive: true });
  const db = openProjectorReadModel(viewDir, "core");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS view_body(view TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL,
      generation INTEGER NOT NULL, etag TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(view, key)) WITHOUT ROWID;`);
    const items = Object.entries(lanes).flatMap(([lane, rows]) => rows.map((row) => ({ ...row, lane })));
    const body = { data: { section: "needsYou", items, page: { index: 0, of: 1, total: items.length } }, sources: [{ name: "inbox-store:core", asOf: iso(0), state: "fresh" }] };
    db.prepare("INSERT OR REPLACE INTO view_body(view, key, version, generation, etag, body) VALUES('inbox', ?, 1, 1, 'e', ?)").run("section=needsYou", JSON.stringify(body));
    const demand = createDemandBook({ clock: { now: () => T0, date: () => new Date(T0), iso: () => iso(0) } });
    for (const id of ids) demand.want("inbox-thread", inboxThreadViewKey(inboxThreadId(id)));
    const bodies = createInboxThreadView({ inboxRoot: fx.root, demand }).materialize({ now: T0, instances: [{ db }] });
    assert.equal(bodies.length, ids.length);
    for (const built of bodies) assert.equal((built.data as InboxThreadViewData).found, true, JSON.stringify(built.data));
  } finally {
    db.close();
  }
});

test("W1-T9252: the tail treats a missing live ledger as empty and starts from its first sight", async (t) => {
  const fx = await fixture(t, [{ id: HUMAN }]);
  const missing = join(fx.root, "state", "not-yet", "ledger.ndjson");
  const sync = createThreadEventSync({ ledgerPath: missing, threadStorePath: fx.threadStorePath, stateDir: fx.stateDir });
  assert.equal(sync.poll(), 0, "no ledger yet: nothing to mirror, and the first poll only records where it stands");
  mkdirSync(join(fx.root, "state", "not-yet"));
  writeFileSync(missing, JSON.stringify({ ts: iso(0), run_id: "REFRAME-1", task_id: HUMAN, step: "ratify.reframed", feedback: "Name the repo." }) + "\n");
  assert.equal(sync.poll(), 1, "a row that arrives after the first poll is mirrored from the start of the file");
  assert.deepEqual(storedEvents(fx, HUMAN).map((m) => m.extra!.event!.kind), ["reframed"]);
});

test("W1-T9252: the tail reports a row it cannot read and still mirrors the rest", async (t) => {
  const fx = await fixture(t, [{ id: HUMAN }]);
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  const sync = createThreadEventSync({ ledgerPath: fx.ledgerPath, threadStorePath: fx.threadStorePath, log: (step, extra) => void logged.push([step, extra]) });
  assert.equal(await sync.backfill(), 0);
  appendFileSync(fx.ledgerPath, `{"step":"ratify.reframed", torn\n`);
  appendFileSync(fx.ledgerPath, JSON.stringify({ ts: iso(0), run_id: "REFRAME-1", task_id: HUMAN, step: "ratify.reframed", feedback: "Name the repo." }) + "\n");
  assert.equal(sync.poll(), 1);
  assert.deepEqual(logged.map(([step]) => step), ["inbox.thread_event_row_unreadable"]);
  assert.equal(typeof logged[0]![1]!.error, "string");
  assert.deepEqual(storedEvents(fx, HUMAN).map((m) => m.extra!.event!.kind), ["reframed"]);
});

test("W1-T9252: the responder's timer logs a failing event sync and keeps answering", async (t) => {
  const fx = await fixture(t, [{ id: "ruling:P5" }]);
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  let calls = 0;
  const pump = startInboxResponder({
    threadStorePath: fx.threadStorePath,
    ledgerPath: fx.ledgerPath,
    readItems: () => registryThreadItems(fx.stateDir, fx.ledgerPath),
    reframe: () => {},
    syncEvents: async () => {
      calls += 1;
      if (calls === 1) throw new Error("ledger union unreadable");
      return 2;
    },
  }, 10, (step, extra) => void lines.push([step, extra]));
  t.after(() => pump.stop());
  await pump.settled();
  assert.deepEqual(lines[0], ["inbox.thread_event_sync_failed", { error: "ledger union unreadable" }]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  pump.stop();
  await pump.settled();
  assert.ok(lines.some(([step, extra]) => step === "inbox.thread_events_mirrored" && extra?.count === 2), "a later tick mirrors again");
});

test("W1-T9252: a thread reply reaches the daemon as reframe direction", async (t) => {
  const fx = await fixture(t, [{ id: "ruling:P4" }]);
  const store = { threadStorePath: fx.threadStorePath };
  const reframed: Array<[string, string]> = [];
  const deps: InboxResponderDeps = {
    threadStorePath: fx.threadStorePath,
    ledgerPath: fx.ledgerPath,
    readItems: () => registryThreadItems(fx.stateDir, fx.ledgerPath),
    reframe: (id, feedback) => void reframed.push([id, feedback]),
    decide: async () => ({ action: "edit", reply: "I asked for the item to be redrafted." }),
  };
  appendThreadReplyOnce(inboxThreadIdentity("ruling:P4"), "Make the first option the cheap one.", "reply-direction-1", store);
  assert.equal(await answerThread(inboxThreadId("ruling:P4"), deps), "edit", "a valid explicit edit decision carries the operator's direction");
  assert.deepEqual(reframed, [["ruling:P4", "Make the first option the cheap one."]]);
  assert.ok(rowsWritten(fx).some((row) => row.step === "panel.proposal_reframe_requested" && row.feedback === "Make the first option the cheap one."));
  const stored = readThread(inboxThreadId("ruling:P4"), store);
  assert.equal(stored.status === "ok" ? stored.messages.at(-1)?.extra?.did?.action : undefined, "edit");

  // A valid clarifying question remains a question, not an implicit edit decision.
  appendThreadReplyOnce(inboxThreadIdentity("ruling:P4"), "Hmm, which one?", "reply-direction-2", store);
  assert.equal(await answerThread(inboxThreadId("ruling:P4"), { ...deps, decide: async () => ({ action: "question", reply: "Do you want the cheap one first?" }) }), "question");
  assert.equal(reframed.length, 1);
});
