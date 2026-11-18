/**
 * W1-T13606: serve's Inbox projection re-validated the same persisted classification (a sha256 over about 6.6 MB of
 * JSON) on every inboxLanes call, on its request loop. validInboxSnapshot now answers each object once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { validInboxSnapshot } from "#src/lib/fleet-lane.js";
import { classificationSnapshotKey } from "#src/lib/read-page.js";

/** A persisted classification that passes every check, its snapshot key computed over its own content and census. */
function snapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const counts = { decision: 0, reply: 0, in_progress: 0, history: 0, awaiting_daemon: 0 };
  const facts = { state: "complete", counts, verifiedCounts: counts, decisionReadiness: { ready: 0, needsPreparation: 0, needsTriage: 0, unknown: 0 }, items: [],
    sources: { plan: "observed", registry: "observed", liveLedger: "observed", archiveLedger: "observed", githubProjection: "observed" } };
  const content = { snapshotScope: { root: "/state-root" }, stores: {}, proposals: [], classifications: [], ...extra };
  const key = classificationSnapshotKey(content, facts);
  return { ...content, snapshotKey: key, attentionCensus: { ...facts, snapshotKey: key } };
}

/** The object behind a proxy that counts every property it is asked for. */
function counted<T extends object>(target: T): { value: T; reads: () => number } {
  let reads = 0;
  return { value: new Proxy(target, { get: (t, p, r) => (reads++, Reflect.get(t, p, r)) }), reads: () => reads };
}

test("W1-T13606 criterion 1: a second check of the same object reads none of it", () => {
  const c = counted(snapshot());
  assert.equal(validInboxSnapshot(c.value as never), true);
  const first = c.reads();
  assert.ok(first > 0, "positive control: the first check reads the object");
  assert.equal(validInboxSnapshot(c.value as never), true);
  assert.equal(c.reads(), first, "the second check is answered without reading it");
});

test("W1-T13606 criterion 2: the memo answers what a fresh check answers, per object", () => {
  assert.equal(validInboxSnapshot(snapshot() as never), true, "a valid snapshot");
  const tampered = snapshot({ proposals: [{ id: "P1" }] });
  tampered.proposals = [];
  tampered.classifications = [{ proposalId: "changed" }];
  assert.equal(validInboxSnapshot(tampered as never), false, "content that no longer matches its key is refused");
  const again = counted(snapshot());
  validInboxSnapshot(again.value as never);
  assert.ok(again.reads() > 0, "an equal but new object is checked itself, never borrowed from another");
});

test("W1-T13606 criterion 3: a refused object stays refused without being read again", () => {
  const bad = snapshot();
  (bad.attentionCensus as Record<string, unknown>).snapshotKey = "0".repeat(64);
  const c = counted(bad);
  assert.equal(validInboxSnapshot(c.value as never), false);
  const first = c.reads();
  assert.equal(validInboxSnapshot(c.value as never), false);
  assert.equal(c.reads(), first);
});
