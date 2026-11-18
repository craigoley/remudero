import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import { inboxBuildMessages, inboxFreshViewBodies, inboxLegacyView, refreshInboxClassification, serveInboxBuilds } from "#src/lib/inbox-view.js";
import { buildSlowLaneInbox, INBOX_BUILD_RETRY_MS, readSlowLaneInbox, startInboxBuildWorker, type InboxBuildInput, type InboxBuildMessage, type InboxBuildOutcome, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

/** A persisted inbox under a fresh root, and a way to persist a different one. */
async function world(t: TestContext, extra: Partial<PanelGraphDeps> = {}) {
  const root = readModelFixtureDir(t, "inbox-off-loop").dir;
  const state = join(root, "state");
  mkdirSync(state);
  mkdirSync(join(root, "plan"));
  const planPath = join(root, "plan", "tasks.yaml"), ledgerPath = join(state, "ledger.ndjson");
  writeFileSync(planPath, "[]\n");
  writeFileSync(ledgerPath, "");
  const registry = join(state, "inbox-proposals.json");
  let now = Date.now();
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const base: PanelGraphDeps = { root, inboxRoot: root, planPath, ledgerPath, inboxFromSlowLane: true,
    github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40), inboxGrepAnchor: () => true };
  let generation = 0;
  const persist = async (count: number) => {
    generation++;
    writeFileSync(registry, JSON.stringify({ proposals: Array.from({ length: count }, (_, i) => ({ id: `ruling:off-loop-${generation}-${i}`, summary: `${generation} ${i} operator context`, evidenceAnchors: [] })) }));
    now += 1_000;
    await refreshInboxClassification({ ...base }, {}, clock);
  };
  await persist(3);
  return { root, state, base, clock, persist, deps: { ...base, inboxClock: clock, ...extra } as PanelGraphDeps, advance: (ms: number) => { now += ms; } };
}

/** An inboxBuild seam the test settles by hand: it counts builds and runs each in process when released. */
function heldBuilds() {
  const calls: InboxBuildInput[] = [];
  const releases: Array<() => void> = [];
  const build = (input: InboxBuildInput) => new Promise<InboxBuildOutcome>((resolve) => {
    calls.push(input);
    releases.push(() => resolve({ ok: true, ...buildSlowLaneInbox(input) }));
  });
  return { calls, build, release: async () => { releases.shift()?.(); await new Promise((settle) => setImmediate(settle)); } };
}

const settled = () => new Promise((settle) => setImmediate(settle));

test("W1-T13692: two deps that name one inbox share one read, one parse and one lanes build", async (t) => {
  const f = await world(t);
  const a = f.deps, b: PanelGraphDeps = { ...f.deps };
  const ra = readSlowLaneInbox(a)!, rb = readSlowLaneInbox(b)!;
  assert.ok(ra && rb, "positive control: both deps see the persisted inbox");
  assert.notEqual(ra, rb, "each deps keeps its own view, with its own plan reader");
  assert.equal(ra.classified, rb.classified, "one parse serves both deps");
  assert.equal(ra.lanes(), rb.lanes(), "one lanes build serves both deps");
  const other: PanelGraphDeps = { ...f.deps, inboxAuditScope: { instance: "other", repository: "o/r" } };
  assert.notEqual(readSlowLaneInbox(other)!.classified, ra.classified, "a deps scoped to another inbox reads its own");
});

test("W1-T13692: a process holds a bounded number of inbox reads, dropping the oldest", async (t) => {
  const f = await world(t);
  const scoped = (i: number): PanelGraphDeps => ({ ...f.deps, inboxAuditScope: { instance: `bounded-${i}`, repository: "o/r" } });
  const first = readSlowLaneInbox(scoped(0))!;
  assert.equal(readSlowLaneInbox(scoped(0))!.classified, first.classified, "positive control: a held read is shared");
  for (let i = 1; i <= 16; i++) readSlowLaneInbox(scoped(i));
  assert.notEqual(readSlowLaneInbox(scoped(0))!.classified, first.classified, "the oldest read was dropped and is read again");
});

test("W1-T13692: invariant:off-loop — a changed file is answered from the last build while one build runs, and many reads start one", async (t) => {
  const held = heldBuilds();
  const f = await world(t, { inboxBuildOffLoop: true, inboxBuild: held.build });
  const first = readSlowLaneInbox(f.deps)!;
  const firstLanes = first.lanes();
  assert.equal(held.calls.length, 0, "a slot's first read is in place");
  await f.persist(5);
  for (let i = 0; i < 5; i++) {
    const read = readSlowLaneInbox({ ...f.deps })!;
    assert.equal(read.snapshotKey, first.snapshotKey, "while the build runs, reads answer from the last build");
    assert.equal(read.lanes(), firstLanes, "and its lanes, built no second time on the loop");
  }
  assert.equal(held.calls.length, 1, "five reads of a changed file start one build");
  assert.equal(held.calls[0]!.knownStamp !== undefined, true, "the build is told which read the caller holds");
  await held.release();
  const next = readSlowLaneInbox(f.deps)!;
  assert.notEqual(next.snapshotKey, first.snapshotKey, "the finished build answers the next read");
  assert.equal(next.classified.proposals.length, 5);
  assert.equal(held.calls.length, 1, "an installed build starts no other");
  const lanes = next.lanes();
  assert.equal(lanes.counts.notReady + lanes.counts.ready + lanes.counts.drafting + lanes.counts.declined + lanes.counts.archived + lanes.counts.snoozed + lanes.counts.kept, 5);
  assert.equal(held.calls.length, 1, "the build's lanes answer: no lanes build on the loop");
  // An operator write moves a lane store, and shows at once: its lanes are rebuilt in place, as before.
  writeFileSync(join(f.state, "fleet-lane-decisions.json"), "{}\n");
  const same = readSlowLaneInbox(f.deps)!;
  assert.equal(same, next, "a lane store change keeps the read");
  assert.notEqual(same.lanes(), lanes, "and rebuilds its lanes at once");
  assert.equal(held.calls.length, 1, "starting no build");
  // A build that finds no usable file leaves no read.
  writeFileSync(join(f.state, "inbox-classification.json"), "{}\n");
  assert.equal(readSlowLaneInbox(f.deps), next, "the unreadable file is built off the loop too");
  await held.release();
  assert.equal(readSlowLaneInbox(f.deps), undefined, "an unusable build answers no read");
});

test("W1-T13692: a failed build is logged, and reads build in place until the retry window passes", async (t) => {
  const logged: Array<[string, Record<string, unknown>]> = [];
  let builds = 0;
  let fail: (outcome: InboxBuildOutcome) => InboxBuildOutcome = (outcome) => outcome;
  const f = await world(t, {
    inboxBuildOffLoop: true, logProjection: (step, extra) => void logged.push([step, extra]),
    inboxBuild: async (input) => { builds++; return fail({ ok: true, ...buildSlowLaneInbox(input) }); },
  });
  const first = readSlowLaneInbox(f.deps)!;
  fail = () => ({ ok: false, reason: "worker exited with code 1" });
  await f.persist(4);
  assert.equal(readSlowLaneInbox(f.deps)!.snapshotKey, first.snapshotKey);
  await settled();
  assert.equal(builds, 1);
  assert.deepEqual(logged.map(([step, extra]) => [step, extra.reason, extra.retryInMs]), [["serve.inbox_build_failed", "worker exited with code 1", INBOX_BUILD_RETRY_MS]]);
  const inPlace = readSlowLaneInbox(f.deps)!;
  assert.notEqual(inPlace.snapshotKey, first.snapshotKey, "inside the retry window the read is built in place");
  assert.equal(builds, 1, "and starts no build");
  await f.persist(2);
  f.advance(INBOX_BUILD_RETRY_MS);
  fail = (outcome) => outcome;
  assert.equal(readSlowLaneInbox(f.deps)!.snapshotKey, inPlace.snapshotKey, "past the window a change is built off the loop again");
  assert.equal(builds, 2);
  await settled();
  assert.equal(readSlowLaneInbox(f.deps)!.classified.proposals.length, 2);
  // A build that throws or rejects is a failed build too.
  const thrown = await world(t, { inboxBuildOffLoop: true, logProjection: (step, extra) => void logged.push([step, extra]),
    inboxBuild: () => { throw new Error("no worker"); } });
  readSlowLaneInbox(thrown.deps);
  await thrown.persist(1);
  readSlowLaneInbox(thrown.deps);
  const rejected = await world(t, { inboxBuildOffLoop: true, logProjection: (step, extra) => void logged.push([step, extra]),
    inboxBuild: () => Promise.reject(new Error("worker died")) });
  readSlowLaneInbox(rejected.deps);
  await rejected.persist(1);
  readSlowLaneInbox(rejected.deps);
  await settled();
  assert.deepEqual(logged.slice(1).map(([, extra]) => extra.reason), ["no worker", "worker died"]);
});

test("W1-T13692: the worker builds the read, the lanes and the pages an in-place read builds, and the view answers from its pages", async (t) => {
  const worker = startInboxBuildWorker();
  t.after(() => worker.stop());
  const f = await world(t, { inboxBuildOffLoop: true, inboxBuild: (input) => worker.build(input) });
  const inPlace = readSlowLaneInbox(f.base)!;
  const built = await worker.build({ inboxRoot: f.root });
  assert.ok(built.ok && built.usable && built.persisted && built.lanes && built.pages, `the real worker built every part: ${JSON.stringify(built).slice(0, 200)}`);
  assert.equal(built.persisted.snapshotKey, inPlace.snapshotKey, "the same read");
  assert.deepEqual(built.lanes.built, inPlace.lanes(), "the same lanes");
  assert.deepEqual(built.pages, inboxFreshViewBodies(inPlace.lanes(), inPlace.generatedAt, inPlace.snapshotKey), "the same pages");
  const known = await worker.build({ inboxRoot: f.root, knownStamp: built.stamp });
  assert.ok(known.ok && known.usable && !known.persisted && known.lanes, "a read the caller holds is not sent back");

  const view = inboxLegacyView(f.deps, f.clock);
  readSlowLaneInbox(f.deps);
  await f.persist(6);
  const before = readSlowLaneInbox(f.deps)!.snapshotKey;
  let read = readSlowLaneInbox(f.deps)!;
  for (let i = 0; i < 200 && read.snapshotKey === before; i++) {
    await new Promise((settle) => setTimeout(settle, 10));
    read = readSlowLaneInbox(f.deps)!;
  }
  assert.notEqual(read.snapshotKey, before, "the worker's build was installed");
  const pages = read.builtPages(read.lanes());
  assert.ok(pages && pages.length > 0, "the installed read carries the worker's pages");
  const answered = view.compute(new URLSearchParams({ section: "notReady" }));
  assert.ok(!("error" in answered), JSON.stringify(answered));
  assert.equal(answered.data, pages.find((body) => body.key === "section=notReady")!.data, "the view answers with the worker's own page");
});

test("W1-T13692: the worker body answers each build in three messages, and a failure as one", async () => {
  const f = { root: "/nonexistent-inbox-root" };
  assert.deepEqual(inboxBuildMessages(1, { inboxRoot: f.root }), [
    { id: 1, part: "read", stamp: undefined, usable: false }, { id: 1, part: "lanes" }, { id: 1, part: "pages" }]);
  const [failed] = inboxBuildMessages(2, { inboxRoot: undefined as unknown as string });
  assert.equal(failed!.part, "error");
  const posted: InboxBuildMessage[] = [];
  let run: ((msg: { id: number; input: InboxBuildInput }) => void) | undefined;
  serveInboxBuilds({ on: (_event, handler) => { run = handler; }, postMessage: (value) => void posted.push(value) });
  serveInboxBuilds(null);
  run!({ id: 3, input: { inboxRoot: f.root } });
  assert.deepEqual(posted.map((message) => message.part), ["read", "lanes", "pages"]);
});

test("W1-T13692: a worker that fails, exits or cannot start settles every build it holds", async (t) => {
  const bad = startInboxBuildWorker({ workerUrl: new URL("data:text/javascript,throw new Error('boom')") });
  const outcome = await bad.build({ inboxRoot: "/nonexistent-inbox-root" });
  assert.ok(!outcome.ok && /inbox build worker (failed|exited)/.test(outcome.reason), JSON.stringify(outcome));
  const unstartable = startInboxBuildWorker({ workerUrl: new URL("file:///nonexistent/inbox-build-worker.ts") });
  const refused = await unstartable.build({ inboxRoot: "/nonexistent-inbox-root" });
  assert.ok(!refused.ok, JSON.stringify(refused));
  const errored = await startInboxBuildWorker().build({ inboxRoot: undefined as unknown as string });
  assert.ok(!errored.ok && /inbox build failed/.test(errored.reason), JSON.stringify(errored));
  const stopped = startInboxBuildWorker();
  t.after(() => stopped.stop());
  const pending = stopped.build({ inboxRoot: "/nonexistent-inbox-root" });
  stopped.stop();
  assert.deepEqual(await pending, { ok: false, reason: "inbox build worker stopped" });
});

test("W1-T13692: serve's boot read is in place under the off-loop flag, and starts no build", async (t) => {
  const held = heldBuilds();
  const f = await world(t, { inboxBuildOffLoop: true, inboxBuild: held.build });
  const first = readSlowLaneInbox(f.deps)!;
  await f.persist(2);
  const boot = readSlowLaneInbox(f.deps, { inPlace: true })!;
  assert.notEqual(boot.snapshotKey, first.snapshotKey, "the boot read takes the changed file");
  assert.equal(boot.classified.proposals.length, 2);
  assert.equal(held.calls.length, 0, "and starts no build");
});
