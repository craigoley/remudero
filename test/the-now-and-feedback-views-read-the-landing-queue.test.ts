// W1-T5730: the feedback view and the now view's grill list read the checkout's entries only, so a queued
// decision read `proposed` (an answered grill still asked) and a console capture W1-T5628 moved into the
// landing queue was invisible on both until the sweep landed it. Both views now overlay the one queue.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import { materializeFeedbackView } from "../src/lib/feedback-view.js";
import { queuedFeedbackDir } from "../src/lib/feedback-landing.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, type NowViewData } from "../src/lib/now-view.js";
import type { Plan } from "../src/lib/plan.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const T0 = Date.parse("2026-10-01T04:00:00.000Z");
type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx): string {
  const dir = makeTempDir("landing-queue-views");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function entry(id: string, status: string, extra: string[] = []): string {
  return [`id: ${id}`, "ts: '2026-09-30T00:00:00.000Z'", `raw: a note ${id}`, "attachments: []", "origin: cli", `status: ${status}`, "proposal_pr: null", ...extra, ""].join("\n");
}

/** A checkout with `checkout` entries, and `queued` records staged under `<stateRoot>/state/feedback-landing-pending`. */
function world(t: TestCtx, checkout: Record<string, string>, queued: Record<string, string>): { root: string; stateRoot: string } {
  const root = scratch(t);
  const stateRoot = join(root, "core");
  mkdirSync(join(root, "checkout", "plan", "feedback"), { recursive: true });
  mkdirSync(queuedFeedbackDir(stateRoot), { recursive: true });
  writeFileSync(join(root, "checkout", "plan", "tasks.yaml"), "[]\n");
  for (const [id, body] of Object.entries(checkout)) writeFileSync(join(root, "checkout", "plan", "feedback", `${id}.yaml`), body);
  for (const [id, body] of Object.entries(queued)) writeFileSync(join(queuedFeedbackDir(stateRoot), `${id}.yaml`), body);
  return { root: join(root, "checkout"), stateRoot };
}

function feedbackBodies(w: { root: string; stateRoot: string }) {
  return materializeFeedbackView({ root: w.root, planPath: join(w.root, "plan", "tasks.yaml"), stateRoot: w.stateRoot }, fakeGitHub(), fixedClock(T0));
}

function nowGrills(t: TestCtx, w: { root: string; stateRoot: string }): { data: NowViewData } {
  const clock: Clock = fixedClock(T0);
  const ledgerDir = join(w.stateRoot, "state");
  mkdirSync(ledgerDir, { recursive: true });
  const db = openProjectorReadModel(join(w.stateRoot, "read-model-home"), "core", clock);
  t.after(() => db.close());
  const acquired = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(acquired.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: acquired.lease, clock });
  appendFileSync(join(ledgerDir, "ledger.ndjson"), `${JSON.stringify({ ts: clock.iso(), host: "h1", step: "daemon.tick" })}\n`);
  projector.tick();
  const plan: Plan = { tasks: [], byId: new Map() };
  const view = createNowView({
    instances: [{ name: "core", ledgerDir, feedbackRoot: w.root }], clock, readPlan: () => plan,
    github: () => ({ github: fakeGitHub(), generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 4321, diskFree: () => 1 },
  });
  const bodies = view.materialize({
    now: clock.now(), switches: { views: { now: "shadow" } },
    instances: [{ state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: clock.now(), newestTs: null }, db }],
  });
  const body = bodies.find((b) => b.key === "instance=core");
  assert.ok(body, "a core body");
  return body as { data: NowViewData };
}

const grillIds = (data: NowViewData): string[] => data.decisions.filter((d) => d.kind === "grill").map((d) => d.id).sort();

test("the feedback view reads a queued decision as decided and lists a queue-only capture", (t) => {
  const w = world(t, { "fb-prop": entry("fb-prop", "proposed") }, {
    "fb-prop": entry("fb-prop", "accepted"),
    "fb-fresh": entry("fb-fresh", "new"),
  });
  const bodies = feedbackBodies(w);
  const all = bodies.find((b) => b.key === "")!;
  assert.deepEqual(all.data.entries.map((e) => [e.id, e.status, e.landing]), [["fb-prop", "accepted", "queued"], ["fb-fresh", "new", "queued"]]);
  assert.deepEqual(all.data.counts, { total: 2, byStatus: { accepted: 1, new: 1 } });
  assert.deepEqual(bodies.find((b) => b.key === "status=accepted")!.data.entries.map((e) => e.id), ["fb-prop"]);
  assert.deepEqual(all.sources.map((s) => s.name), ["feedback-store:core"]);
});

test("an empty queue leaves the feedback view exactly the checkout's entries", (t) => {
  const w = world(t, { "fb-prop": entry("fb-prop", "proposed") }, {});
  const all = feedbackBodies(w).find((b) => b.key === "")!;
  assert.deepEqual(all.data.entries.map((e) => [e.id, e.status, e.landing]), [["fb-prop", "proposed", undefined]]);
});

test("an unreadable queue is named in the feedback view's sources, and the checkout still reads", (t) => {
  const w = world(t, { "fb-prop": entry("fb-prop", "proposed") }, { "fb-bad": "just: a string\n" });
  const all = feedbackBodies(w).find((b) => b.key === "")!;
  assert.deepEqual(all.data.entries.map((e) => [e.id, e.status]), [["fb-prop", "proposed"]]);
  const queue = all.sources.find((s) => s.name === "feedback-landing-queue:core");
  assert.ok(queue, "the queue is named among the sources");
  assert.equal(queue.state, "unavailable");
  assert.match(queue.reason ?? "", /not a feedback entry/);
});

test("an answered queued grill leaves the now view's grill list while a queue-only grill joins it", (t) => {
  const w = world(t, { "fb-answered": entry("fb-answered", "grilling"), "fb-open": entry("fb-open", "grilling") }, {
    "fb-answered": entry("fb-answered", "answered", ["answered_by: fb-reply"]),
    "fb-queued-grill": entry("fb-queued-grill", "grilling"),
  });
  const { data } = nowGrills(t, w);
  assert.deepEqual(grillIds(data), ["grill:fb-open", "grill:fb-queued-grill"]);
  assert.equal(data.decisionsReasons?.grill, undefined);
});

test("an unreadable queue is named in the now view's sources, and the checkout's grills still show", (t) => {
  const w = world(t, { "fb-open": entry("fb-open", "grilling") }, { "fb-bad": "just: a string\n" });
  const { data } = nowGrills(t, w);
  assert.deepEqual(grillIds(data), ["grill:fb-open"]);
  assert.match(data.decisionsReasons?.grill ?? "", /landing queue is unreadable.*not a feedback entry/);
  const feedback = data.humanGates?.sources.find((s) => s.name === "feedback");
  assert.equal(feedback?.state, "unavailable");
});
