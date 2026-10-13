// W1-T8826: the plain message's options ("Keep parked", "Request clearer proof", "Approve now") were prose with no
// route, so the console could only print them beside the raw approve / decline / edit forms. Each served option now
// carries an `intent` and, where a route is valid for its lane, an `action` naming that existing route. The action is
// attached at serve time from intent + lane + proposal id and is never stored.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { InboxClassification, InboxState } from "../src/lib/inbox.js";
import { validateDecisionSummary } from "../src/lib/feedback.js";
import { plainSourceFingerprint, plainStorePath, plainTemplate, type PlainOption } from "../src/lib/inbox-plain.js";
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
