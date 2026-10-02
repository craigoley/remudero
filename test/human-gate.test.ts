import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import type { FeedbackEntry } from "../src/lib/feedback.js";
import { projectHumanGates, type HumanGateObservation, type HumanGateSource } from "../src/lib/human-gate.js";
import { NOW_DECISIONS_CAP } from "../src/lib/now-decisions.js";
import { createNowView, type NowViewData } from "../src/lib/now-view.js";
import type { Plan } from "../src/lib/plan.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

const ASKED = "2026-10-02T12:00:00.000Z";

function observation(subject: string, over: Partial<HumanGateObservation> = {}): HumanGateObservation {
  return { kind: "escalation", subject, ownerSurface: "inbox", openedAt: ASKED,
    url: "https://github.com/example/repo/issues/1", reason: "Choose the recovery path.", resolutionVerb: "mark_handled", ...over };
}

function source(gates: readonly HumanGateObservation[], over: Partial<HumanGateSource> = {}): HumanGateSource {
  return { name: "board", instance: "core", state: "complete", gates, ...over };
}

test("human gates deduplicate source conditions without crossing instances", () => {
  const gate = observation("task-1");
  const inputs = [source([gate]), source([gate], { name: "thread" }), source([gate], { instance: "site" })];
  const result = projectHumanGates(inputs);
  assert.equal(result.gates.length, 2);
  assert.deepEqual(result.gates.map((g) => g.key), ["escalation:core:task-1", "escalation:site:task-1"]);
  assert.deepEqual(result.count.inbox, { count: 2 });
  assert.deepEqual(result.count.byKind, { escalation: 2 });
  assert.deepEqual(Object.keys(result.gates[0]!).sort(), ["kind", "key", "ownerSurface", "openedAt", "url", "reason", "resolutionVerb"].sort());
  assert.ok(result.sources.every((s) => !("gates" in s)), "the wire source metadata carries no raw observations");
  assert.equal(projectHumanGates([source([])]).count.inbox.count, 0, "an explicitly complete empty corpus can report zero");
});

test("the oldest issue owns the kind when manual and plain escalations describe one condition", () => {
  const plain = observation("task-1");
  const manual = observation("task-1", { kind: "manual_approval", openedAt: "2026-10-01T12:00:00.000Z", resolutionVerb: "approve" });
  const result = projectHumanGates([source([plain, manual])]);
  assert.equal(result.gates.length, 1);
  assert.equal(result.gates[0]!.kind, "manual_approval");
  assert.equal(result.gates[0]!.resolutionVerb, "approve");
  assert.deepEqual(result, projectHumanGates([source([manual, plain])]));
  assert.equal(projectHumanGates([source([manual, { ...plain, openedAt: "2026-09-30T12:00:00.000Z" }])]).gates[0]!.kind, "escalation");
});

test("condition identity never uses the title and delimiter-bearing instances cannot collide", () => {
  const a = observation("x", { reason: "identical title" });
  const b = observation("b:x", { reason: "identical title" });
  const result = projectHumanGates([source([a], { instance: "a:b" }), source([b], { instance: "a" })]);
  assert.equal(result.gates.length, 2);
  assert.equal(new Set(result.gates.map((g) => g.key)).size, 2);
  assert.notEqual(result.gates[0]!.key, result.gates[1]!.key);
});

test("human gate partial counts retain observed gates and explicit unavailable reasons", () => {
  const result = projectHumanGates([source([observation("task-1")]), source([], { name: "questions", state: "unavailable", reason: "EACCES" })]);
  assert.deepEqual(result.count.inbox, { atLeast: 1 });
  assert.deepEqual(result.count.changeManagement, { atLeast: 0 });
  assert.equal(result.sources[1]!.reason, "EACCES");
  assert.equal(projectHumanGates([source([], { state: "partial" })]).sources[0]!.reason, "source completeness was not established");
  const missing = projectHumanGates([]);
  assert.deepEqual(missing.count.inbox, { atLeast: 0 });
  assert.deepEqual(missing.sources, [{ name: "projection", instance: null, state: "unavailable", reason: "no human-gate sources were provided" }]);
});

test("change-management gates stay outside the Inbox count", () => {
  const result = projectHumanGates([source([
    observation("task-1"), observation("hold-1", { kind: "merge_held", ownerSurface: "change-management", resolutionVerb: "release_hold" }),
  ])]);
  assert.deepEqual(result.count.inbox, { count: 1 });
  assert.deepEqual(result.count.changeManagement, { count: 1 });
  assert.deepEqual(result.count.byKind, { escalation: 1 });
});

test("source times sort oldest first with deterministic unknown-time and equal-time ordering", () => {
  const inputs = Object.freeze([source(Object.freeze([
    observation("z", { openedAt: null }), observation("c", { openedAt: "not-a-date" }),
    observation("b"), observation("a"), observation("old", { openedAt: "2026-09-01T12:00:00.000Z" }),
  ]))]);
  const before = JSON.stringify(inputs);
  const result = projectHumanGates(inputs);
  assert.deepEqual(result.gates.map((g) => g.key), ["escalation:core:old", "escalation:core:a", "escalation:core:b", "escalation:core:c", "escalation:core:z"]);
  assert.equal(JSON.stringify(inputs), before, "the pure projection does not mutate source order or observations");
  const a = observation("same", { url: null, reason: "first" });
  const b = observation("same", { url: null, reason: "second" });
  assert.deepEqual(projectHumanGates([source([a, b])]), projectHumanGates([source([b, a])]));
  assert.equal(projectHumanGates([source([a, a])]).gates.length, 1);
});

function materialize(t: { after(fn: () => void): void }, opts: { count?: number; root?: boolean; unreadableStore?: boolean; githubUnavailable?: boolean } = {}): NowViewData {
  const root = makeTempDir("human-gate");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = fixedClock(Date.parse(ASKED));
  const db = openProjectorReadModel(root, "core", clock);
  t.after(() => db.close());
  const lease = acquireLease(db, { clock });
  assert.ok(lease.ok);
  const ledgerDir = join(root, "state");
  mkdirSync(ledgerDir);
  writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
  const feedbackRoot = join(root, "checkout");
  mkdirSync(join(feedbackRoot, "plan"), { recursive: true });
  if (opts.unreadableStore) mkdirSync(join(feedbackRoot, "plan", "questions.ndjson"));
  const instance = { name: "core", ledgerDir, ...(opts.root === false ? {} : { feedbackRoot }) };
  const plan: Plan = { tasks: [], byId: new Map() };
  const github = {
    readFailed: () => opts.githubUnavailable === true, prByRef: () => null,
    findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
    listMergedHeadBranches: () => [], listOpenHeadBranches: () => [],
    listOpenPrs: () => [], headRefName: () => undefined, prBody: () => undefined,
    issueByUrl: () => ({ state: "OPEN", title: "question" }),
  } as unknown as GitHub;
  const entries = Array.from({ length: opts.count ?? 0 }, (_, i) => ({
    id: `fb-${i}`, ts: new Date(Date.parse(ASKED) + i * 1000).toISOString(),
    raw: `Choose the next step for ${i}?`, status: "grilling",
  })) as FeedbackEntry[];
  const view = createNowView({
    instances: [instance], clock, readPlan: () => plan,
    github: () => ({ github, generation: "known", source: { asOf: ASKED, state: "fresh" } }),
    listGrilling: () => entries, planBehind: () => ({ commits: 0 }),
    hostProbe: { readLive: () => [], diskFree: () => 1_000_000, rateLimit: () => 5000 },
  });
  const bodies = view.materialize({
    now: clock.now(), switches: { views: { now: "serve" } },
    instances: [{ db, lease: lease.lease, state: { instance: "core", generation: 0, lease: "held", failures: 0, tickedAt: clock.now(), newestTs: null } }],
  });
  assert.equal(bodies.length, 1);
  return bodies[0]!.data;
}

test("human gates count before display caps and retain source times", (t) => {
  const data = materialize(t, { count: NOW_DECISIONS_CAP + 3 });
  assert.equal(data.decisions.length, NOW_DECISIONS_CAP);
  assert.equal(data.decisionsMore, 3);
  const projected = (data as NowViewData & { humanGates?: { gates: Array<{ openedAt: string; key: string }>; count: { inbox: { count?: number; atLeast?: number } } } }).humanGates;
  assert.ok(projected, "the production now view consumes the projection");
  assert.equal(projected.gates.length, NOW_DECISIONS_CAP + 3);
  assert.equal(projected.count.inbox.count ?? projected.count.inbox.atLeast, NOW_DECISIONS_CAP + 3);
  assert.equal(projected.gates[0]!.openedAt, ASKED);
  assert.equal(projected.gates[0]!.key, "feedback_grill:core:fb-0");
  assert.deepEqual(data.decisions[0]!.answer, { method: "POST", path: "/v1/feedback", tier: "low", fields: { replyTo: "fb-52" }, input: "text" });
});

test("human gate counts preserve unavailable source evidence", (t) => {
  const data = materialize(t, { root: false, githubUnavailable: true });
  const projection = (data as NowViewData & { humanGates?: { count: { inbox: unknown }; sources: Array<{ name: string; state: string; reason?: string }> } }).humanGates;
  assert.ok(projection);
  assert.deepEqual(projection.count.inbox, { atLeast: 0 });
  assert.ok(projection.sources.some((s) => s.state === "unavailable" && s.reason === "no feedback root is configured"));
  assert.ok(projection.sources.some((s) => s.name === "escalations" && s.state !== "complete"));
});

test("an unreadable question store remains named in the human gate source", (t) => {
  const data = materialize(t, { unreadableStore: true });
  const projection = (data as NowViewData & { humanGates?: { sources: Array<{ name: string; state: string; reason?: string }> } }).humanGates;
  assert.ok(projection);
  assert.ok(projection.sources.some((s) => s.name === "task-questions" && s.state === "unavailable" && s.reason?.includes("EISDIR")));
});
