// W1-T8826: the plain message's options ("Keep parked", "Request clearer proof", "Approve now") were prose with no
// route, so the console could only print them beside the raw approve / decline / edit forms. Each served option now
// carries an `intent` and, where a route is valid for its lane, an `action` naming that existing route. The action is
// attached at serve time from intent + lane + proposal id and is never stored.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { InboxClassification, InboxState } from "../src/lib/inbox.js";
import { buildDecisionSummaryPrompt, validateDecisionSummary } from "../src/lib/feedback.js";
import { backfillPlainMessages, plainSourceFingerprint, plainStorePath, plainTemplate, writePlainMessage, type PlainOption } from "../src/lib/inbox-plain.js";
import { inboxThreadId } from "../src/lib/inbox-thread.js";
import { inboxLanes } from "../src/lib/panel-graph.js";
import { makeTempDir } from "../src/lib/tmp.js";

const ID = "machine-judge:W1-T5418";
const SUMMARY = "A parked fix is waiting for a ruling on whether to land it.";

const TAGGED: PlainOption[] = [
  { label: "Keep parked", consequence: "The fix stays parked and nothing changes.", intent: "keep" },
  { label: "Request clearer proof", consequence: "The fix goes back to the author for clearer proof.", intent: "reframe" },
  { label: "Approve now", consequence: "The fix is approved and lands.", intent: "approve" },
];

function stored(options: PlainOption[]) {
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

  for (const state of ["declined", "not_ready", "drafting"] as const) {
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
  const { byLabel } = served(t, "ready", all);
  assert.deepEqual(byLabel("Close it").action, { method: "POST", path: "/v1/inbox/decline", fields: { proposalId: ID }, input: "reason" });
  assert.deepEqual(byLabel("Ask for changes").action, { method: "POST", path: "/v1/inbox/reframe", fields: { proposalId: ID }, input: "feedback" });
  assert.deepEqual(byLabel("Ask a question").action, {
    method: "POST", path: "/v1/inbox/thread/reply", fields: { threadId: inboxThreadId(ID) }, input: "text",
  });
  assert.equal(inboxThreadId(ID), `thread:${ID}::inbox::-::-`);

  const declined = served(t, "declined", all);
  assert.equal(declined.byLabel("Close it").action, undefined, "an already declined item has no decline route");
  assert.ok(declined.byLabel("Ask for changes").action, "control: reframe is valid in every lane");
});

test("W1-T8826: keep and untagged options carry no action", (t) => {
  const { byLabel } = served(t, "ready", [
    TAGGED[0]!,
    { label: "Ask the author", consequence: "The author is asked what they meant." },
    TAGGED[2]!,
  ]);
  assert.equal(byLabel("Keep parked").intent, "keep");
  assert.equal(byLabel("Keep parked").action, undefined);
  assert.equal(byLabel("Ask the author").intent, "reply", "an untagged stored option is served as a reply");
  assert.equal(byLabel("Ask the author").action, undefined);
  assert.ok(byLabel("Approve now").action, "control: a tagged sibling in the same message is actionable");
});

test("W1-T8826: the decision card validates an option intent and rejects an unknown one", () => {
  const card = (intent?: unknown) => ({
    headline: "A parked fix needs your ruling",
    what_happened: "A fix is parked.",
    decision: "Decide whether the fix should go ahead.",
    options: [{ label: "Let it go", consequence: "It lands.", ...(intent === undefined ? {} : { intent }) }, { label: "Drop it", consequence: "It is closed." }],
  });
  assert.equal(validateDecisionSummary(card("approve"))!.options[0]!.intent, "approve");
  assert.equal(validateDecisionSummary(card())!.options[0]!.intent, undefined, "an escalation card without intent validates as before");
  assert.equal(validateDecisionSummary(card("delete-everything")), null);
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

test("W1-T8826: the backfill preserves writer intents and stores no model supplied action", async (t) => {
  const root = makeTempDir("rmd-inbox-option-writer");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  const message = stored(TAGGED);
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
});

test("W1-T8826: the writer schema permits intents and retries an untagged answer", async () => {
  const message = stored(TAGGED);
  const prompt = buildDecisionSummaryPrompt({ context: SUMMARY });
  assert.match(prompt, /"intent"/);
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
