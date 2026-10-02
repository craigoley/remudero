import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { backfillPlainMessages, checkPlainMessage, plainInboxMessage, plainSourceFingerprint, plainStorePath, plainTemplate, readPlainStore, type PlainInboxMessage } from "../src/lib/inbox-plain.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const proposal = { id: "verify-human:W1-T216", summary: "Sandbox drill awaits a defined scope" };
const message: PlainInboxMessage = {
  headline: "Confirm the isolated scope",
  whatHappened: "The record asks for a contained drill.",
  whatWeNeed: "Confirm the scope before scheduling it.",
  ifNothingHappens: "No drill is authorized by this summary.",
  options: [{ label: "Explain the scope", consequence: "Ask for the evidence." }, { label: "Leave undecided", consequence: "No authorization is provided." }],
  source: "writer",
};
const card = { headline: message.headline, what_happened: message.whatHappened, decision: message.whatWeNeed, options: message.options };
const current = (p = proposal) => ({ ...message, sourceFingerprint: plainSourceFingerprint(p) });
function stateDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}plain-source-`)), "state");
  mkdirSync(dir);
  return dir;
}

test("plain inbox cache requires the exact current proposal identity and summary", () => {
  const cached = current();
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: cached }), cached, "positive control: a current writer record remains usable");
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: message }).source, "template", "legacy unscoped summaries are not current evidence");
  assert.equal(plainInboxMessage({ ...proposal, summary: "The drill is withdrawn" }, { [proposal.id]: cached }).source, "template");
  const other = { ...proposal, id: "verify-human:W1-T147" };
  assert.equal(plainInboxMessage(other, { [other.id]: cached }).source, "template", "a copied summary cannot cross proposal identities");
  assert.equal(plainSourceFingerprint(proposal), plainSourceFingerprint({ summary: proposal.summary, id: proposal.id }), "field order does not change provenance");
});

test("malformed and machine-text cache entries fall back without changing proposal state", () => {
  const invalid = { ...current(), options: null } as unknown as PlainInboxMessage;
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: invalid }).source, "template");
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: { ...current(), source: "unrecognized" } as unknown as PlainInboxMessage }).source, "template");
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: { ...current(), headline: "Run rmd approve" } }).source, "template");
  assert.equal(plainInboxMessage(proposal, {}).source, "template");
  assert.equal(proposal.summary, "Sandbox drill awaits a defined scope");
});

test("backfill replaces legacy and changed-source entries but retains unrelated history", async () => {
  const dir = stateDir();
  const history = { id: "ruling:older", summary: "An older question" };
  writeFileSync(plainStorePath(dir), JSON.stringify({ [proposal.id]: message, [history.id]: current(history) }));
  let asks = 0;
  const deps = { stateDir: dir, readProposals: () => [proposal], summarize: () => { asks += 1; return card; } };
  assert.equal(await backfillPlainMessages(deps, 1), 1);
  assert.equal(await backfillPlainMessages(deps, 1), 0);
  assert.equal(asks, 1);
  const store = readPlainStore(plainStorePath(dir));
  assert.equal(store[proposal.id]?.sourceFingerprint, plainSourceFingerprint(proposal));
  assert.deepEqual(store[history.id], current(history));
  const updated = { ...proposal, summary: "Different question and scope" };
  assert.equal(await backfillPlainMessages({ ...deps, readProposals: () => [updated] }, 1), 1);
  assert.equal(readPlainStore(plainStorePath(dir))[proposal.id]?.sourceFingerprint, plainSourceFingerprint(updated));
});

test("an in-flight writer cannot publish a removed changed or replaced decision", async () => {
  for (const next of [[], [{ ...proposal, summary: "Withdrawn" }], [{ id: "followup:W1-T216", summary: proposal.summary }]]) {
    const dir = stateDir();
    let live = [proposal];
    const n = await backfillPlainMessages({ stateDir: dir, readProposals: () => live, summarize: () => { live = next; return card; } }, 1);
    assert.equal(n, 0);
    assert.deepEqual(readPlainStore(plainStorePath(dir)), {});
  }
  const dir = stateDir();
  const replacement = { ...current(), headline: "A newer verified source summary" };
  const n = await backfillPlainMessages({ stateDir: dir, readProposals: () => [proposal], summarize: () => { writeFileSync(plainStorePath(dir), JSON.stringify({ [proposal.id]: replacement })); return card; } }, 1);
  assert.equal(n, 0);
  assert.deepEqual(JSON.parse(readFileSync(plainStorePath(dir), "utf8"))[proposal.id], replacement);
});

test("unverified fallback summaries do not promise approval closure or execution", () => {
  for (const p of [proposal, { id: "ruling:missing", summary: "operator-owned" }, { id: "machine-judge:W1-T216", summary: "test auto merge" }]) {
    const fallback = plainTemplate(p);
    assert.equal(checkPlainMessage(fallback).ok, true);
    assert.match(fallback.whatHappened, /does not verify/);
    assert.deepEqual(fallback.options.map((o) => o.label), ["Explain this item", "Leave undecided"]);
    assert.doesNotMatch(JSON.stringify(fallback), /automatic review looked again|fleet turns this into planned work|item is closed|work.*stays paused/i);
  }
});
