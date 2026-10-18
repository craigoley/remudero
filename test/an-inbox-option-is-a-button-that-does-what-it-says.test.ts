// W1-T8826: the plain message's options ("Keep parked", "Request clearer proof", "Approve now") were prose with no
// route, so the console could only print them beside the raw approve / decline / edit forms. Each served option now
// carries an `intent` and, where a route is valid for its lane, an `action` naming that existing route. The action is
// attached at serve time from intent + lane + proposal id and is never stored.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { InboxClassification, InboxState } from "#src/lib/inbox.js";
import { buildDecisionSummaryPrompt, validateDecisionSummary } from "#src/lib/feedback.js";
import { backfillPlainMessages, plainSourceFingerprint, plainStorePath, plainTemplate, writePlainMessage, type PlainInboxMessage, type PlainOption } from "#src/lib/inbox-plain.js";
import { inboxThreadId, readThread } from "#src/lib/inbox-thread.js";
import { writePersistedInbox, type PersistedInboxContent } from "#src/lib/fleet-lane.js";
import { buildPanelGraphRoutes, inboxLanes, inboxThreadStorePath, materializeInboxAttentionCensus, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { createService } from "#src/lib/service.js";
import { loadPlan } from "#src/lib/plan.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { SPEC, violations } from "#test/helpers/openapi-strict.js";

const ID = "machine-judge:W1-T5418";
const SUMMARY = "A parked fix is waiting for a ruling on whether to land it.";

const TAGGED: PlainOption[] = [
  { label: "Keep parked", consequence: "The fix stays parked and nothing changes.", intent: "keep" },
  { label: "Request clearer proof", consequence: "The fix goes back to the author for clearer proof.", intent: "reframe" },
  { label: "Approve now", consequence: "The fix is approved and lands.", intent: "approve" },
];

function stored(options: PlainOption[]): PlainInboxMessage {
  return {
    headline: "A parked fix needs your ruling",
    whatHappened: "A fix for a slow build is parked and waiting for a ruling.",
    whatWeNeed: "Decide whether the fix should go ahead.",
    ifNothingHappens: "The fix stays parked and the build cost it targets keeps coming back.",
    options,
    source: "writer",
    sourceFingerprint: plainSourceFingerprint({ id: ID, summary: SUMMARY }),
  };
}

function served(t: { after: (fn: () => void) => void }, state: InboxState, options: PlainOption[], id = ID) {
  const root = makeTempDir("rmd-inbox-option-button");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(plainStorePath(join(root, "state")), JSON.stringify({ [id]: { ...stored(options), sourceFingerprint: plainSourceFingerprint({ id, summary: SUMMARY }) } }));
  const classification: InboxClassification = { proposalId: id, state, reasons: [] };
  const lanes = inboxLanes(
    { proposals: [{ id, summary: SUMMARY, evidenceAnchors: [] }], classifications: [classification], ledgerLines: Object.assign([], { torn: 0, present: true }) },
    root,
  );
  const item = [...lanes.ready, ...lanes.drafting, ...lanes.notReady, ...lanes.declined][0]!;
  const byLabel = (label: string) => item.plain.options.find((o) => o.label === label)!;
  return { item, byLabel };
}

test("W1-T8826: approve is actionable only on a ready item", (t) => {
  const ready = served(t, "ready", TAGGED);
  assert.deepEqual(ready.byLabel("Approve now").action, { method: "POST", path: "/v1/inbox/approve", fields: { proposalId: ID } });
  assert.equal(ready.byLabel("Approve now").intent, "approve");
  assert.deepEqual(ready.byLabel("Request clearer proof").action, { method: "POST", path: "/v1/inbox/reframe", fields: { proposalId: ID }, input: "feedback" });

  for (const state of ["declined", "not_ready", "drafting", "deferred_with_trigger"] as const) {
    const other = served(t, state, TAGGED);
    assert.equal(other.byLabel("Approve now").intent, "approve", `${state}: the intent is still served`);
    assert.equal(other.byLabel("Approve now").action, undefined, `${state}: approve has no route`);
    assert.ok(other.byLabel("Request clearer proof").action, `${state}: control: reframe stays actionable`);
  }
});

test("W1-T8826: a decline, reframe or reply option names its route and its input", (t) => {
  const all: PlainOption[] = [
    { label: "Close it", consequence: "The item is closed and can be brought back.", intent: "decline" },
    { label: "Ask for changes", consequence: "The author is asked to rework it.", intent: "reframe" },
    { label: "Ask a question", consequence: "Your question is added to the thread.", intent: "reply" },
  ];
  for (const state of ["ready", "drafting", "not_ready", "deferred_with_trigger", "declined"] as const) {
    const { byLabel } = served(t, state, all);
    const close = byLabel("Close it");
    assert.equal(close.intent, "decline");
    if (state === "declined") {
      assert.equal(Object.hasOwn(close, "action"), false, "an already declined item has no decline route");
    } else {
      assert.deepEqual(close.action, { method: "POST", path: "/v1/inbox/decline", fields: { proposalId: ID }, input: "reason" }, state);
    }
    assert.equal(byLabel("Ask for changes").intent, "reframe");
    assert.deepEqual(byLabel("Ask for changes").action, { method: "POST", path: "/v1/inbox/reframe", fields: { proposalId: ID }, input: "feedback" }, state);
    assert.equal(byLabel("Ask a question").intent, "reply");
    assert.deepEqual(byLabel("Ask a question").action, {
      method: "POST", path: "/v1/inbox/thread/reply", fields: { threadId: inboxThreadId(ID) }, input: "text",
    }, state);
  }
  assert.equal(inboxThreadId(ID), `thread:${ID}::inbox::-::-`);
});

test("W1-T8826: keep and untagged options carry no action", (t) => {
  for (const state of ["ready", "drafting", "not_ready", "deferred_with_trigger", "declined"] as const) {
    const { byLabel } = served(t, state, [
      TAGGED[0]!,
      { label: "Ask the author", consequence: "The author is asked what they meant." },
      TAGGED[1]!,
    ]);
    assert.equal(byLabel("Keep parked").intent, "keep");
    assert.equal(Object.hasOwn(byLabel("Keep parked"), "action"), false, state);
    assert.equal(byLabel("Ask the author").intent, "reply", "an untagged stored option is served as a reply");
    assert.equal(Object.hasOwn(byLabel("Ask the author"), "action"), false, state);
    assert.deepEqual(byLabel("Request clearer proof").action, {
      method: "POST", path: "/v1/inbox/reframe", fields: { proposalId: ID }, input: "feedback",
    }, "control: a tagged sibling in the same message is actionable in every lane");
  }
});

test("W1-T8826: served writer options match the plain message contract in every lane", (t) => {
  const schema = SPEC.components.schemas.PlainInboxMessage!;
  const choices: PlainOption[][] = [
    TAGGED,
    [
      { label: "Close it", consequence: "The item is closed.", intent: "decline" },
      { label: "Ask why", consequence: "Your question is added to the thread.", intent: "reply" },
      { label: "Leave parked", consequence: "The item stays parked." },
    ],
  ];
  for (const state of ["ready", "drafting", "not_ready", "deferred_with_trigger", "declined"] as const) {
    for (const options of choices) {
      const { item } = served(t, state, options);
      assert.equal(item.plain.source, "writer", "control: validate stored writer data, not a fallback template");
      assert.equal(item.plain.sourceFingerprint, plainSourceFingerprint({ id: ID, summary: SUMMARY }));
      assert.deepEqual(violations(item.plain, schema), [], state);
    }
  }
});

test("W1-T8826: the served option contract refuses malformed intents and actions", (t) => {
  const schema = SPEC.components.schemas.PlainOption!;
  const option = served(t, "ready", TAGGED).byLabel("Request clearer proof");
  assert.deepEqual(violations(option, schema), [], "control: a real served action validates");
  const { intent, ...untagged } = option;
  const { fields, ...withoutFields } = option.action!;
  const malformed = [
    untagged,
    { ...option, intent: "execute" },
    { ...option, action: { ...option.action, method: "GET" } },
    { ...option, action: { ...option.action, input: "command" } },
    { ...option, action: { ...option.action, path: 42 } },
    { ...option, action: { ...option.action, fields: { proposalId: 42 } } },
    { ...option, action: withoutFields },
    { ...option, action: { ...option.action, surprise: true } },
    { ...option, surprise: true },
  ];
  for (const invalid of malformed) {
    assert.ok(violations(invalid, schema).length > 0, `must reject ${JSON.stringify(invalid)}`);
  }
});

test("W1-T8826: the decision card validates an option intent and rejects an unknown one", () => {
  const card = (intent?: unknown) => ({
    headline: "A parked fix needs your ruling",
    what_happened: "A fix is parked.",
    decision: "Decide whether the fix should go ahead.",
    options: [{ label: "Let it go", consequence: "It lands.", ...(intent === undefined ? {} : { intent }) }, { label: "Drop it", consequence: "It is closed." }],
  });
  for (const intent of ["approve", "decline", "reframe", "reply", "keep"] as const) {
    assert.equal(validateDecisionSummary(card(intent))!.options[0]!.intent, intent);
  }
  assert.equal(validateDecisionSummary(card())!.options[0]!.intent, undefined, "an escalation card without intent validates as before");
  for (const intent of ["delete-everything", "", "APPROVE", null, 0, false, {}, []]) {
    assert.equal(validateDecisionSummary(card(intent)), null, `invalid intent: ${JSON.stringify(intent)}`);
  }
});

test("W1-T8826: a template option is tagged and a fleet finding is not offered a thread reply", (t) => {
  assert.ok(plainTemplate({ id: "ruling:W1-T1", summary: "x" }).options.every((o) => o.intent !== undefined));
  const fleet = served(t, "ready", [{ label: "Ask why", consequence: "A question is added to the thread.", intent: "reply" }, TAGGED[0]!], "adoption:W1-T9");
  assert.equal(fleet.byLabel("Ask why").action, undefined);
});

test("W1-T8826: actions are recomputed from the current lane without trusting stored routes", (t) => {
  const root = makeTempDir("rmd-inbox-option-lane");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  const path = plainStorePath(join(root, "state"));
  const stale = { method: "POST", path: "/v1/inbox/approve", fields: { proposalId: "another-item" } };
  const options = TAGGED.map((option) => ({ ...option, action: stale }));
  writeFileSync(path, JSON.stringify({ [ID]: stored(options) }));
  const before = readFileSync(path, "utf8");
  const classification: InboxClassification = { proposalId: ID, state: "ready", reasons: [] };
  const classified = {
    proposals: [{ id: ID, summary: SUMMARY, evidenceAnchors: [] }],
    classifications: [classification],
    ledgerLines: Object.assign([], { torn: 0, present: true }),
  };
  const ready = inboxLanes(classified, root).ready[0]!.plain.options;
  assert.equal(ready[0]!.action, undefined, "keep never inherits a stored action");
  assert.deepEqual(ready[1]!.action, { method: "POST", path: "/v1/inbox/reframe", fields: { proposalId: ID }, input: "feedback" });
  assert.deepEqual(ready[2]!.action, { method: "POST", path: "/v1/inbox/approve", fields: { proposalId: ID } });

  classification.state = "declined";
  const declined = inboxLanes(classified, root).declined[0]!.plain.options;
  assert.equal(declined[2]!.intent, "approve");
  assert.equal(declined[2]!.action, undefined, "a lane change removes the approve action");
  assert.equal(readFileSync(path, "utf8"), before, "serving never rewrites the stored message");

  const untaggedOptions = [
    { label: "Ask the author", consequence: "The author explains the item.", action: stale },
    TAGGED[0]!,
  ];
  writeFileSync(path, JSON.stringify({ [ID]: stored(untaggedOptions) }));
  const untagged = inboxLanes(classified, root).declined[0]!.plain.options[0]!;
  assert.equal(untagged.intent, "reply");
  assert.equal(untagged.action, undefined, "an untagged option never inherits a stored action");
});

test("W1-T8826: a carried slow-lane message recomputes actions for a deferred item", (t) => {
  const root = makeTempDir("rmd-inbox-option-snapshot");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const message = stored(TAGGED);
  const before = JSON.stringify(message);
  const classification: InboxClassification = { proposalId: ID, state: "ready", reasons: [] };
  const classified = {
    proposals: [{ id: ID, summary: SUMMARY, evidenceAnchors: [] }],
    classifications: [classification],
    ledgerLines: Object.assign([], { torn: 0, present: true }),
    stores: { fleetDecisions: {}, plainMessages: { [ID]: message } },
  };
  const ready = inboxLanes(classified, root);
  assert.deepEqual(ready.ready[0]!.plain.options[2]!.action, {
    method: "POST", path: "/v1/inbox/approve", fields: { proposalId: ID },
  });
  assert.deepEqual(ready.needsYou.ready[0]!.plain, ready.ready[0]!.plain);

  classification.state = "deferred_with_trigger";
  const deferred = inboxLanes(classified, root);
  assert.equal(deferred.ready.length, 0);
  const options = deferred.notReady[0]!.plain.options;
  assert.equal(options[0]!.intent, "keep");
  assert.equal(options[0]!.action, undefined);
  assert.equal(options[2]!.intent, "approve");
  assert.equal(options[2]!.action, undefined);
  assert.deepEqual(options[1]!.action, {
    method: "POST", path: "/v1/inbox/reframe", fields: { proposalId: ID }, input: "feedback",
  });
  assert.deepEqual(deferred.needsYou.notReady[0]!.plain, deferred.notReady[0]!.plain);
  assert.equal(JSON.stringify(message), before, "serving leaves the persisted slow-lane message unchanged");
});

test("W1-T8826: the backfill preserves writer intents and stores no model supplied action", async (t) => {
  const root = makeTempDir("rmd-inbox-option-writer");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  const message = stored(TAGGED);
  const untagged = stored(TAGGED.map(({ label, consequence }) => ({ label, consequence })));
  writeFileSync(plainStorePath(join(root, "state")), JSON.stringify({ [ID]: untagged }));
  const classified = {
    proposals: [{ id: ID, summary: SUMMARY, evidenceAnchors: [] }],
    classifications: [{ proposalId: ID, state: "ready" as const, reasons: [] }],
    ledgerLines: Object.assign([], { torn: 0, present: true }),
  };
  const before = inboxLanes(classified, root).ready[0]!.plain.options;
  assert.ok(before.every((option) => option.intent === "reply" && option.action === undefined));
  const count = await backfillPlainMessages({
    stateDir: join(root, "state"),
    readProposals: () => [{ id: ID, summary: SUMMARY }],
    summarize: () => ({
      headline: message.headline,
      what_happened: message.whatHappened,
      decision: message.whatWeNeed,
      if_nothing_happens: message.ifNothingHappens,
      options: TAGGED.map((option) => ({ ...option, action: { method: "POST", path: "/untrusted" } })),
    }),
  }, 1);
  assert.equal(count, 1);
  const saved = JSON.parse(readFileSync(plainStorePath(join(root, "state")), "utf8"))[ID];
  assert.equal(saved.source, "writer");
  assert.deepEqual(saved.options, TAGGED);
  const after = inboxLanes(classified, root).ready[0]!.plain.options;
  assert.deepEqual(after[2]!.action, { method: "POST", path: "/v1/inbox/approve", fields: { proposalId: ID } });
  assert.equal(await backfillPlainMessages({
    stateDir: join(root, "state"),
    readProposals: () => classified.proposals,
    summarize: () => { throw new Error("a tagged current message must not be rewritten"); },
  }, 1), 0);
});

test("W1-T8826: the writer schema permits intents and retries an untagged answer", async () => {
  const message = stored(TAGGED);
  const prompt = buildDecisionSummaryPrompt({ context: SUMMARY });
  assert.match(prompt, /"intent"/);
  assert.match(prompt, /"options": \[\{[^\n]*"intent"/, "the exact option shape includes the optional intent field");
  assert.match(prompt, /optional.*intent/i, "the shared schema allows inbox intents without requiring them on escalation cards");
  let calls = 0;
  const result = await writePlainMessage({ id: ID, summary: SUMMARY }, {
    summarize: (input) => {
      calls++;
      if (calls === 2) assert.match(input.context, /last answer was refused.*intent/);
      return {
        headline: message.headline,
        what_happened: message.whatHappened,
        decision: message.whatWeNeed,
        if_nothing_happens: message.ifNothingHappens,
        options: calls === 1 ? TAGGED.map(({ label, consequence }) => ({ label, consequence })) : TAGGED,
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.source, "writer");
  assert.deepEqual(result.options, TAGGED);
});

test("W1-T8826: repeated untagged writer answers fall back to tagged template choices", async () => {
  const message = stored(TAGGED);
  let calls = 0;
  const result = await writePlainMessage({ id: ID, summary: SUMMARY }, {
    summarize: () => {
      calls++;
      return {
        headline: message.headline,
        what_happened: message.whatHappened,
        decision: message.whatWeNeed,
        if_nothing_happens: message.ifNothingHappens,
        options: TAGGED.map(({ label, consequence }) => ({ label, consequence })),
      };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, plainTemplate({ id: ID, summary: SUMMARY }));
  assert.ok(result.options.every((option) => option.intent !== undefined));
});

test("W1-T8826: HTTP inbox options use existing write routes and refresh when the persisted lane changes", async (t) => {
  const root = makeTempDir("rmd-inbox-option-http");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const options: PlainOption[] = [
    TAGGED[2]!,
    { label: "Close it", consequence: "The item is closed.", intent: "decline" },
    { label: "Ask why", consequence: "Your question is added to the thread.", intent: "reply" },
  ];
  const content: PersistedInboxContent = {
    proposals: [{ id: ID, summary: SUMMARY, evidenceAnchors: [] }],
    classifications: [{ proposalId: ID, state: "ready", reasons: [] }],
    ledgerRows: [], mergedTaskIds: [], projectionIndeterminate: false, complete: true,
    stores: { fleetDecisions: {}, plainMessages: { [ID]: stored(options) } },
  };
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan/tasks.yaml"), "[]\n");
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: content.proposals }));
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath: join(stateDir, "ledger.ndjson"),
    inboxFromSlowLane: true,
    github: { prView: () => null },
    statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    ratify: { approve: () => assert.fail("a read token cannot approve"), reframe: () => assert.fail("a read token cannot reframe") },
  };
  const persist = () => {
    const inputs = { ...content, snapshotScope: { root } };
    const census = materializeInboxAttentionCensus(deps, {
      plan: loadPlan(deps.planPath), registryPath: join(stateDir, "inbox-proposals.json"),
      proposals: content.proposals, classifications: content.classifications,
      ledgerLines: Object.assign([], { torn: 0, present: true }), projection: new Map(),
      attentionEvidence: { archiveLedger: "partial", releases: [], judges: [] },
    }, content.stores!, inputs);
    return writePersistedInbox(stateDir, { ...inputs, snapshotKey: census.snapshotKey, attentionCensus: census }, Date.now());
  };
  const initial = persist();
  const routes = buildPanelGraphRoutes(deps);
  const server = createService({ tokens: { read: "option-reader", write: "option-writer" }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async () => {
    const response = await fetch(`${base}/v1/inbox`, { headers: { authorization: "Bearer option-reader" } });
    assert.equal(response.status, 200);
    return response.json() as Promise<ReturnType<typeof inboxLanes>>;
  };
  const ready = await get();
  assert.deepEqual(ready.needsYou.ready[0]!.plain.options, ready.ready[0]!.plain.options);
  for (const option of ready.ready[0]!.plain.options) {
    const action = option.action!;
    assert.ok(action, `${option.intent} has an action on the ready item`);
    const route = routes.find((route) => route.method === action.method && route.path === action.path);
    assert.equal(route?.scope, "write");
    assert.equal(route?.tier, option.intent === "approve" ? "high" : "low");
    const response = await fetch(`${base}${action.path}`, {
      method: action.method,
      headers: { authorization: "Bearer option-reader", "content-type": "application/json" },
      body: JSON.stringify({ ...action.fields, ...(action.input ? { [action.input]: "Please explain." } : {}) }),
    });
    assert.equal(response.status, 403, `${option.intent} retains its write authorization`);
    await response.arrayBuffer();
  }
  const replyAction = ready.ready[0]!.plain.options[2]!.action!;
  const postReply = (text?: string) => fetch(`${base}${replyAction.path}`, {
    method: replyAction.method,
    headers: { authorization: "Bearer option-writer", "content-type": "application/json" },
    body: JSON.stringify({ ...replyAction.fields, ...(text === undefined ? {} : { [replyAction.input!]: text }) }),
  });
  const missingInput = await postReply();
  assert.equal(missingInput.status, 400, "the advertised text input must be collected before posting");
  await missingInput.arrayBuffer();
  const replyText = "Please explain the evidence for this fix.";
  const replied = await postReply(replyText);
  assert.equal(replied.status, 200, "the served action delivers a reply through the existing route");
  const receipt = await replied.json() as { threadId: string; delivery: string };
  assert.equal(receipt.threadId, inboxThreadId(ID));
  assert.equal(receipt.delivery, "delivered");
  const thread = readThread(inboxThreadId(ID), { threadStorePath: inboxThreadStorePath(root) });
  assert.equal(thread.status, "ok");
  assert.deepEqual(thread.messages.filter((message) => message.role === "reply").map((message) => message.body), [replyText]);
  const audit = readFileSync(deps.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(audit.some((row) => row.step === "inbox.thread_replied" && row.thread_id === inboxThreadId(ID)));
  content.classifications[0]!.state = "declined";
  const changed = persist();
  assert.notEqual(changed.snapshotKey, initial.snapshotKey, "the changed lane is published under its new classification key");
  const declined = await get();
  assert.equal(declined.ready.length, 0);
  assert.equal(declined.declined[0]!.plain.options[0]!.action, undefined);
  assert.equal(declined.declined[0]!.plain.options[1]!.action, undefined);
  assert.equal(declined.declined[0]!.plain.options[2]!.action?.path, "/v1/inbox/thread/reply");
  assert.deepEqual(content.stores!.plainMessages[ID]!.options, options, "serving never stores an action");
});
