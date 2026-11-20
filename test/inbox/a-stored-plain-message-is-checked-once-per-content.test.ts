import assert from "node:assert/strict";
import { test } from "node:test";

import { PLAIN_CHECK_MEMO_MAX, plainCheckMemoSizes, plainInboxMessage, plainSourceFingerprint, type PlainInboxMessage } from "#src/lib/inbox-plain.js";

const proposal = { id: "verify-human:W1-T13877", summary: "Sandbox drill awaits a defined scope" };
const base: PlainInboxMessage = {
  headline: "Confirm the isolated scope",
  whatHappened: "The record asks for a contained drill.",
  whatWeNeed: "Confirm the scope before scheduling it.",
  ifNothingHappens: "No drill is authorized by this summary.",
  options: [{ label: "Explain the scope", consequence: "Ask for the evidence." }, { label: "Leave undecided", consequence: "No authorization is provided." }],
  source: "writer",
  sourceFingerprint: plainSourceFingerprint(proposal),
};

/** A stored message whose whatHappened field counts its reads. */
function counted(whatHappened: string): { message: PlainInboxMessage; reads: () => number } {
  let reads = 0;
  const message = { ...base } as PlainInboxMessage;
  Object.defineProperty(message, "whatHappened", { enumerable: true, get: () => { reads += 1; return whatHappened; } });
  return { message, reads: () => reads };
}

test("W1-T13877 criterion 1: a stored plain message is checked once per content, and a changed content is checked again", () => {
  const { message, reads } = counted("The record asks for a contained drill, checked once.");
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: message }), message, "positive control: a current writer record is served");
  const afterFirst = reads();
  for (let i = 0; i < 5; i += 1) assert.equal(plainInboxMessage(proposal, { [proposal.id]: message }), message);
  assert.equal(reads() - afterFirst, 5, "W1-T13877 memo: each repeat read whatHappened only to name the content, never to check it again");

  const machine = { ...base, whatHappened: "See verify-human:W1-T216 in state/ledger.ndjson." };
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: machine }).source, "template", "a changed content that fails the check is refused");
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: machine }).source, "template", "and stays refused from the memo");
  assert.equal(plainInboxMessage({ ...proposal, summary: "The drill is withdrawn" }, { [proposal.id]: message }).source, "template", "a moved source is still refused");
});

test("W1-T13877 criterion 2: the memo is bounded and answers correctly after it starts over", () => {
  for (let i = 0; i <= PLAIN_CHECK_MEMO_MAX; i += 1) {
    const item = { ...proposal, id: `verify-human:W1-T${i}` };
    const stored = { ...base, sourceFingerprint: plainSourceFingerprint(item) };
    assert.equal(plainInboxMessage(item, { [item.id]: stored }), stored);
    const sizes = plainCheckMemoSizes();
    assert.ok(sizes.fingerprints <= PLAIN_CHECK_MEMO_MAX && sizes.storedChecks <= PLAIN_CHECK_MEMO_MAX, `W1-T13877 bound: ${JSON.stringify(sizes)}`);
  }
  const after = plainCheckMemoSizes();
  assert.ok(after.fingerprints < PLAIN_CHECK_MEMO_MAX && after.storedChecks < PLAIN_CHECK_MEMO_MAX,
    `filling past the bound started both memos over: ${JSON.stringify(after)}`);
  const stored = { ...base };
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: stored }), stored, "after the memo starts over a current record is still served");
  const empty = { ...base, options: null } as unknown as PlainInboxMessage;
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: empty }).source, "template", "and a malformed one is still refused");
});

/** An object nested `depth` levels deep: too deep for JSON.stringify, which throws RangeError. */
function deep(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let i = 0; i < depth; i += 1) value = { next: value };
  return value;
}

test("W1-T13877 memo: content too deep to serialize is still named, and a valid card with deep unused metadata is served", () => {
  assert.throws(() => JSON.stringify(deep(20_000)), RangeError, "positive control: this depth cannot be serialized");
  const malformed = { ...base, options: deep(20_000) } as unknown as PlainInboxMessage;
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: malformed }).source, "template", "a malformed deep record falls back to the template");
  const options = base.options.map((option, index) => index === 0 ? { ...option, metadata: deep(20_000) } : option);
  const valid = { ...base, options } as PlainInboxMessage;
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: valid }), valid, "a valid card with deep unused option metadata is still served");
});

test("W1-T13877 memo: unused option metadata is not part of the content, so a card carrying it is checked once", () => {
  const { message, reads } = counted("The record asks for a contained drill, with option metadata.");
  const withMetadata = { ...message, options: base.options.map((option) => ({ ...option, metadata: deep(20_000) })) } as PlainInboxMessage;
  Object.defineProperty(withMetadata, "whatHappened", Object.getOwnPropertyDescriptor(message, "whatHappened")!);
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: withMetadata }), withMetadata, "positive control: the card is served");
  const afterFirst = reads();
  for (let i = 0; i < 5; i += 1) assert.equal(plainInboxMessage(proposal, { [proposal.id]: withMetadata }), withMetadata);
  assert.equal(reads() - afterFirst, 5, "each repeat read whatHappened only to name the content: deep metadata kept it out of no memo");

  const other = { ...withMetadata, options: withMetadata.options.map((option) => ({ ...option, metadata: { note: "changed" } })) } as PlainInboxMessage;
  Object.defineProperty(other, "whatHappened", Object.getOwnPropertyDescriptor(message, "whatHappened")!);
  const before = plainCheckMemoSizes().storedChecks;
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: other }), other);
  assert.equal(plainCheckMemoSizes().storedChecks, before, "different unused metadata over the same checked content adds no memo entry");

  const nullIntent = { ...base, options: base.options.map((option) => ({ ...option, intent: null })) } as unknown as PlainInboxMessage;
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: nullIntent }).source, "template", "a null intent is still refused, never answered from the absent-intent entry");
});

test("W1-T13877 memo: a record with a deeply nested option label is refused once and then from the memo", () => {
  const { message, reads } = counted("The record asks for a contained drill, with a deep label.");
  const deepLabel = { ...message, options: [{ label: deep(20_000), consequence: "Ask for the evidence." }, base.options[1]] } as unknown as PlainInboxMessage;
  Object.defineProperty(deepLabel, "whatHappened", Object.getOwnPropertyDescriptor(message, "whatHappened")!);
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: deepLabel }).source, "template", "positive control: a non-text label is refused");
  const afterFirst = reads();
  for (let i = 0; i < 5; i += 1) assert.equal(plainInboxMessage(proposal, { [proposal.id]: deepLabel }).source, "template");
  assert.equal(reads() - afterFirst, 5, "each repeat read whatHappened only to name the content: the refusal came from the memo");

  const parsed = JSON.parse(JSON.stringify({ ...base, whatHappened: "Parsed from the store.", options: [{ label: { nested: [1, 2] }, consequence: "x" }, base.options[1]] })) as PlainInboxMessage;
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: parsed }).source, "template", "a JSON-parsed record with an object label is refused");
  const before = plainCheckMemoSizes().storedChecks;
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: JSON.parse(JSON.stringify(parsed)) as PlainInboxMessage }).source, "template");
  assert.equal(plainCheckMemoSizes().storedChecks, before, "the same parsed content read again adds no memo entry");

  const valid = { ...base, whatHappened: "Parsed from the store." };
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: valid }), valid, "the same text with a real label is its own content and is served");
});
