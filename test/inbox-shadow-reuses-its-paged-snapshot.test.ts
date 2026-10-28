import assert from "node:assert/strict";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import { persistedInboxPath, fleetLaneStorePath } from "#src/lib/fleet-lane.js";
import { INBOX_VIEW_NAME, INBOX_VIEW_VERSION, inboxLegacyView, refreshInboxClassification } from "#src/lib/inbox-view.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { createReadModelTicker, createReadModelWorker, loadCommittedViewBodies, readModelStatusView, readModelSwitchesPath, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import { INBOX_STALE_AFTER_MS } from "#src/lib/nav-badge-view.js";
import { readSlowLaneInbox, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { viewMode } from "#src/lib/views.js";
import { readShadowCounters } from "#src/lib/view-shadow-store.js";
import { viewShadowPath } from "#src/lib/view-shadow.js";

async function world(t: TestContext, count = 180) {
  const root = makeTempDir("inbox-shadow-pages");
  const closers: Array<() => void> = [];
  t.after(() => { for (const close of closers) close(); rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
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
  return { deps, state, registry, proposals, first, view, clock, advance: (ms: number) => { now += ms; }, closesFirst: (close: () => void) => { closers.push(close); } };
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

test("Inbox sampler identities preserve scope filters and exact revision cursors", async () => {
  const { inboxShadowSampleKey } = await import("#src/lib/inbox-view.js");
  const { snapshotCursor } = await import("#src/lib/read-page.js");
  const snapshotKey = "a".repeat(64), scope = { instance: "core", repository: "craigoley/remudero" };
  const data = { snapshotKey, section: "needsYou", page: { index: 1 } };
  const params = new URLSearchParams({ section: "needsYou", cursor: snapshotCursor({ snapshotKey, section: "needsYou", offset: 10 }), label: "perf" });
  const key = inboxShadowSampleKey(data, params, scope);
  assert.equal(key, JSON.stringify([scope.instance, scope.repository, "needsYou", 1, [["label", "perf"]]]));
  assert.notEqual(inboxShadowSampleKey(data, params, { instance: "site", repository: "craigoley/remudero-site" }), key);
  const otherFilter = new URLSearchParams(params); otherFilter.set("label", "chores");
  assert.notEqual(inboxShadowSampleKey(data, otherFilter, scope), key);
  for (const [field, value] of [["instance", "site"], ["repository", "craigoley/remudero-site"], ["repo", "craigoley/remudero-site"]]) {
    const foreign = new URLSearchParams(params); foreign.set(field!, value!);
    assert.equal(inboxShadowSampleKey(data, foreign, scope), undefined, "a foreign declared scope reaches the actual helper's explicit refusal path");
  }
  const old = new URLSearchParams(params); old.set("cursor", snapshotCursor({ snapshotKey: "b".repeat(64), section: "needsYou", offset: 10 }));
  assert.equal(inboxShadowSampleKey(data, old, scope), undefined);
  const duplicated = new URLSearchParams(params); duplicated.append("section", "needsYou");
  assert.equal(inboxShadowSampleKey(data, duplicated, scope), undefined);
  for (const invalid of [null, {}, { ...data, snapshotKey: "invalid" }, { ...data, section: "unknown" }, { ...data, page: { index: -1 } }]) assert.equal(inboxShadowSampleKey(invalid, params, scope), undefined);
});

test("W1-T10917: readiness preserves exact cursors scope and producer generation", async t => {
  const f = await world(t), repository = "craigoley/remudero";
  mkdirSync(join(f.state, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(f.state), JSON.stringify({ views: { inbox: "auto" } }));
  const messages: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir: f.state, instances: [{ name: "core", ledgerDir: f.state, repo: repository }],
    clock: f.clock, holder: "inbox-qualified-producer", oracle: "off", views: [readModelStatusView], post: message => { messages.push(message); } });
  f.closesFirst(() => ticker.release());
  ticker.start(); ticker.tick();
  ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: f.first.bodies });
  const entries = () => loadCommittedViewBodies(f.state, "core", f.clock.now()).bodies.filter(entry => entry.view === INBOX_VIEW_NAME);
  const first = entries();
  assert.equal(first.length, f.first.bodies.length, "the real producer persists every page of its completed population");
  const generation = first[0]!.qualificationGeneration;
  assert.equal(typeof generation, "string"); assert.match(generation!, /^inbox-current-pages-v1:/);
  assert.ok(first.every(entry => entry.qualificationGeneration === generation), "every persisted page binds the same producer population");
  assert.ok(first.every(entry => entry.body.generatedAt === f.clock.iso()), "one captured clock-port instant stamps the entire committed population");
  const continuation = f.first.bodies.find(body => body.data.section === "needsYou" && body.data.page.index === 1)!;
  assert.ok(continuation, "the genuine classification contains continuation pages");
  const legacy = f.view.compute(new URLSearchParams(continuation.key)); assert.ok(!("error" in legacy));
  assert.equal(ticker.shadow({ view: INBOX_VIEW_NAME, key: continuation.key, requests: 0, legacy: { data: legacy.data, asOfMs: f.clock.now() } }), true);
  f.advance(1000); ticker.tick();
  const status = messages.flatMap(message => message.type === "body" && message.entry.view === "read-model"
    ? [(message.entry.body.data as { shadow?: Array<{ view: string; samples: number; ready: boolean; qualificationGeneration?: string }> }).shadow?.find(row => row.view === INBOX_VIEW_NAME)] : []).filter(Boolean).at(-1)!;
  assert.deepEqual([status.samples, status.ready, status.qualificationGeneration], [1, false, generation], "the actual default comparator measured one matching pair without borrowing history");
  const warm = () => createReadModelWorker({ stateDir: f.state, instances: [{ name: "core", ledgerDir: f.state, repo: repository }], clock: f.clock, every: () => () => {} });
  const restored = warm();
  assert.equal(restored.qualificationGeneration?.(INBOX_VIEW_NAME), generation, "warm readiness requires separately committed producer metadata");
  assert.ok(restored.shadowIdentity?.(INBOX_VIEW_NAME, continuation.key)?.key, "the real consumer derives a scoped sample identity only for a verified current body");
  const firstPageIdentity = restored.shadowIdentity?.(INBOX_VIEW_NAME, "section=needsYou")?.key;
  assert.ok(firstPageIdentity);
  assert.equal(viewMode(restored, INBOX_VIEW_NAME), "shadow", "a genuine one-sample population has not qualified for a day");
  const foreign = createReadModelWorker({ stateDir: f.state, instances: [{ name: "core", ledgerDir: f.state, repo: "craigoley/remudero-site" }], clock: f.clock, every: () => () => {} });
  assert.notEqual(foreign.qualificationGeneration?.(INBOX_VIEW_NAME), generation, "another repository cannot borrow this qualification");
  assert.equal(viewMode(foreign, INBOX_VIEW_NAME), "shadow");
  assert.equal(foreign.shadowIdentity?.(INBOX_VIEW_NAME, continuation.key)?.key, undefined);
  assert.equal(ticker.shadow({ view: INBOX_VIEW_NAME, key: "retired-routing-key", requests: 100 }), false, "a missing routing body is not a comparison");
  const traffic = Object.values(readShadowCounters(viewShadowPath(f.state), true)!.states).find(state => state.view === INBOX_VIEW_NAME && state.qualificationGeneration?.includes(":scope:") && !state.qualificationGeneration.includes(":retired:"));
  assert.ok(traffic);
  assert.deepEqual([traffic.requests, traffic.samples, traffic.streakKeys?.length], [100, 1, f.first.bodies.length], "retired-body traffic reaches the unchanged view-wide request floor without adding a page or sample");
  writeFileSync(f.registry, JSON.stringify({ proposals: f.proposals.slice(0, 2) })); f.advance(1000);
  const replacement = await refreshInboxClassification(f.deps, {}, f.clock), mark = messages.length;
  ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: replacement.bodies });
  const next = entries(), nextGeneration = next[0]!.qualificationGeneration;
  assert.notEqual(nextGeneration, generation, "retiring pages changes the required population incarnation");
  assert.deepEqual(next.map(entry => entry.key).sort(), replacement.bodies.map(body => body.key).sort());
  assert.ok(restored.reload() > 0, "the existing warm consumer reloads the replacement committed snapshot");
  assert.equal(restored.qualificationGeneration?.(INBOX_VIEW_NAME), nextGeneration);
  assert.equal(restored.body(INBOX_VIEW_NAME, continuation.key), undefined, "reload retires the old exact continuation instead of retaining a stale body");
  assert.equal(restored.shadowIdentity?.(INBOX_VIEW_NAME, "section=needsYou")?.key, firstPageIdentity);
  const obsolete = f.view.compute(new URLSearchParams(continuation.key)); assert.ok("error" in obsolete);
  assert.equal(obsolete.error, "inbox_snapshot_changed", "normal routing still rejects the old exact cursor");
  const publication = messages.slice(mark) as Array<{ type: string; view?: string; generation?: string; entry?: { view: string } }>;
  const pendingAt = publication.findIndex(message => message.type === "qualification" && message.view === INBOX_VIEW_NAME && message.generation === "inbox-current-pages-v1:pending");
  const identityAt = publication.findIndex(message => message.type === "qualification" && message.view === INBOX_VIEW_NAME && message.generation === nextGeneration);
  const firstBodyAt = publication.findIndex(message => message.type === "body" && message.entry?.view === INBOX_VIEW_NAME);
  const lastBodyAt = publication.findLastIndex(message => message.type === "body" && message.entry?.view === INBOX_VIEW_NAME);
  assert.ok(pendingAt >= 0 && firstBodyAt > pendingAt && identityAt > lastBodyAt, "the consumer stays unqualified until the complete committed body batch has arrived");
  assert.equal(warm().shadowIdentity?.(INBOX_VIEW_NAME, "section=needsYou")?.key, firstPageIdentity, "snapshot churn does not create a new throttle bucket for a continuing logical page");
  const beforePartial = next.map(entry => [entry.key, entry.etag, entry.qualificationGeneration]);
  const bad = [...replacement.bodies.slice(1)];
  ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: bad });
  assert.deepEqual(entries().map(entry => [entry.key, entry.etag, entry.qualificationGeneration]), beforePartial, "an incomplete producer cannot partially replace a committed population");
  assert.equal(viewMode(warm(), INBOX_VIEW_NAME), "shadow", "restart retains the incomplete-source refusal");
  restored.reload();
  assert.equal(restored.qualificationGeneration?.(INBOX_VIEW_NAME), "inbox-current-pages-v1:pending", "reload independently retains the failed producer's qualification refusal");
  assert.equal(restored.shadowIdentity?.(INBOX_VIEW_NAME, "section=needsYou")?.key, undefined);
  ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: replacement.bodies });
  const controls = openProjectorReadModel(f.state, "core", f.clock);
  f.closesFirst(() => controls.close());
  const metadata = controls.meta("inbox_qualification_population"); assert.equal(typeof metadata, "string", "the control targets actual independent producer metadata");
  controls.prepare("UPDATE meta SET v = ? WHERE k = ?").run("{", "inbox_qualification_population");
  assert.notEqual(warm().qualificationGeneration?.(INBOX_VIEW_NAME), nextGeneration, "readiness never reconstructs missing or malformed producer evidence from cached bodies");
  let expectedReason: string | undefined;
  try { JSON.parse("{"); } catch (error) { expectedReason = (error as Error).message; }
  assert.ok(expectedReason, "positive control: the malformed fixture has a native parser failure");
  assert.equal(loadCommittedViewBodies(f.state, "core", f.clock.now()).inboxQualificationReason, expectedReason, "the actual warm reader preserves its precise refusal cause");
  controls.prepare("UPDATE meta SET v = ? WHERE k = ?").run(metadata!, "inbox_qualification_population");
  assert.equal(warm().qualificationGeneration?.(INBOX_VIEW_NAME), nextGeneration);
  const lease = controls.prepare("SELECT name, holder FROM lease").all().find(row => row.holder === "inbox-qualified-producer");
  assert(lease && typeof lease.name === "string" && typeof lease.holder === "string", "positive control: this isolated fixture owns the actual projector lease");
  const leaseName = lease.name, leaseHolder = lease.holder, beforeFence = entries().map(entry => [entry.key, entry.etag, entry.qualificationGeneration]);
  const postsBeforeFence = messages.filter(message => message.type === "body").length;
  controls.prepare("UPDATE lease SET holder = ? WHERE name = ? AND holder = ?").run("foreign-fixture-holder", leaseName, leaseHolder);
  try {
    ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: replacement.bodies });
    assert.deepEqual(entries().map(entry => [entry.key, entry.etag, entry.qualificationGeneration]), beforeFence);
    assert.equal(messages.filter(message => message.type === "body").length, postsBeforeFence);
    assert.ok(messages.some(message => message.type === "log" && message.step === "read_model.inbox_qualification_refusal_uncommitted"), "a lost real write fence cannot persist a false refusal receipt or fresh bodies");
  } finally {
    assert.equal(controls.prepare("UPDATE lease SET holder = ? WHERE name = ? AND holder = ?").run(leaseHolder, leaseName, "foreign-fixture-holder").changes, 1);
  }
  ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: replacement.bodies });
  ticker.release();
  const committed = entries().map(entry => [entry.key, entry.etag, entry.qualificationGeneration]);
  const bodyPosts = messages.filter(message => message.type === "body").length;
  ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: replacement.bodies });
  assert.deepEqual(entries().map(entry => [entry.key, entry.etag, entry.qualificationGeneration]), committed, "a released writer preserves committed evidence");
  assert.equal(messages.filter(message => message.type === "body").length, bodyPosts, "a released writer cannot publish uncommitted bodies");
});
