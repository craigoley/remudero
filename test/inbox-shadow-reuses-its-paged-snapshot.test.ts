import assert from "node:assert/strict";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import { persistedInboxPath, fleetLaneStorePath } from "#src/lib/fleet-lane.js";
import { inboxLegacyView, refreshInboxClassification } from "#src/lib/inbox-view.js";
import { INBOX_STALE_AFTER_MS } from "#src/lib/nav-badge-view.js";
import { readSlowLaneInbox, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

async function world(t: TestContext, count = 180) {
  const root = makeTempDir("inbox-shadow-pages");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  mkdirSync(state);
  mkdirSync(join(root, "plan"));
  const planPath = join(root, "plan", "tasks.yaml"), ledgerPath = join(state, "ledger.ndjson");
  writeFileSync(planPath, "[]\n");
  writeFileSync(ledgerPath, "");
  const registry = join(state, "inbox-proposals.json");
  const proposals = Array.from({ length: count }, (_, i) => ({ id: `ruling:shadow-${i}`, summary: `${i} ${"operator context ".repeat(70)}`, evidenceAnchors: [] }));
  writeFileSync(registry, JSON.stringify({ proposals }));
  let now = Date.now();
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const deps: PanelGraphDeps = { root, inboxRoot: root, planPath, ledgerPath, inboxFromSlowLane: true,
    github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40), inboxGrepAnchor: () => true };
  const first = await refreshInboxClassification(deps, {}, clock);
  const view = inboxLegacyView(deps, clock);
  return { deps, state, registry, proposals, first, view, clock, advance: (ms: number) => { now += ms; } };
}

test("Inbox shadow pages rebuild lanes once per source snapshot, not once per page key", async t => {
  const f = await world(t);
  const read = readSlowLaneInbox(f.deps)!;
  let summaryReads = 0;
  for (const proposal of read.classified.proposals) {
    const summary = proposal.summary;
    Object.defineProperty(proposal, "summary", { get: () => { summaryReads++; return summary; } });
  }
  const first = f.view.compute(new URLSearchParams({ section: "needsYou" }));
  assert.ok(!("error" in first));
  const initial = summaryReads;
  assert.ok(initial > 0, "positive control: the first page actually built lanes");
  assert.ok(f.first.bodies.length > 10, "the corpus contains continuation pages");
  for (const expected of f.first.bodies) {
    const actual = f.view.compute(new URLSearchParams(expected.key));
    assert.ok(!("error" in actual));
    assert.deepEqual(actual.data, expected.data, "every shadow key retains its independently materialized content");
  }
  assert.equal(summaryReads, initial, "walking all shadow keys must not rebuild the whole classification per key");
  writeFileSync(fleetLaneStorePath(f.state), "{}\n");
  assert.ok(!("error" in f.view.compute(new URLSearchParams({ section: "needsYou" }))));
  assert.ok(summaryReads > initial, "a changed lane-store stamp invalidates the retained lanes and pages");
});

test("cached Inbox pages follow replacement snapshots and reject their old continuation cursors", async t => {
  const f = await world(t);
  const old = f.view.compute(new URLSearchParams({ section: "needsYou" }));
  assert.ok(!("error" in old));
  assert.ok(old.data.page.next);
  writeFileSync(f.registry, JSON.stringify({ proposals: f.proposals.slice(0, 2) }));
  f.advance(1_000);
  await refreshInboxClassification(f.deps, {}, f.clock);
  const fresh = f.view.compute(new URLSearchParams({ section: "needsYou" }));
  assert.ok(!("error" in fresh));
  assert.equal(fresh.data.page.total, 2);
  assert.notEqual(fresh.data.snapshotKey, old.data.snapshotKey);
  const obsolete = f.view.compute(new URLSearchParams({ section: "needsYou", cursor: old.data.page.next }));
  assert.ok("error" in obsolete);
  assert.equal(obsolete.error, "inbox_snapshot_changed");
});

test("cached Inbox pages never bypass stale or missing maintained-source refusal", async t => {
  const f = await world(t, 2);
  const params = new URLSearchParams({ section: "needsYou" });
  assert.ok(!("error" in f.view.compute(params)));
  f.advance(INBOX_STALE_AFTER_MS + 1);
  const stale = f.view.compute(params);
  assert.ok("error" in stale);
  assert.equal(stale.error, "inbox_snapshot_stale");
  unlinkSync(persistedInboxPath(f.state));
  const missing = f.view.compute(params);
  assert.ok("error" in missing);
  assert.equal(missing.error, "inbox_snapshot_pending");
});
