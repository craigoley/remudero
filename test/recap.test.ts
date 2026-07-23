import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecapEvents } from "../src/lib/recap.js";
import type { Plan, Task } from "../src/lib/plan.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

const PLAN = planOf([
  task({ id: "W1-T1", title: "merged one" }),
  task({ id: "W1-T2", title: "blocked one" }),
  task({ id: "W1-T3", title: "escalated one" }),
  task({ id: "W1-T4", title: "answered one" }),
]);

const MARKER = "2026-07-20T00:00:00.000Z";

const LINES = [
  // BEFORE the marker — must never appear (the falsifier).
  { ts: "2026-07-19T00:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged" },
  // AFTER the marker — one of each recap-worthy category.
  { ts: "2026-07-20T01:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged" },
  { ts: "2026-07-20T02:00:00.000Z", step: "verdict", task_id: "W1-T2", verdict: "blocked_ci" },
  { ts: "2026-07-20T03:00:00.000Z", step: "escalation.issue_opened", task_id: "W1-T3", class: "BLOCKED" },
  { ts: "2026-07-20T04:00:00.000Z", step: "panel.question_answered", task_id: "W1-T4", answer: "yes, proceed" },
  { ts: "2026-07-20T05:00:00.000Z", step: "retro.marker.advanced", task_id: "RETRO", runs_seen: 12, learnings_count: 3 },
  // a step this recap doesn't surface at all.
  { ts: "2026-07-20T06:00:00.000Z", step: "implement.done", task_id: "W1-T1", cost_usd: 1.2 },
];

test("buildRecapEvents: every category after the marker appears — merged/blocked/escalated/question_answered/retro", () => {
  const events = buildRecapEvents(LINES, MARKER, PLAN);
  const kinds = events.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ["blocked", "escalated", "merged", "question_answered", "retro"]);
});

test("buildRecapEvents (falsifier): an event BEFORE the marker never appears, even though its task/step otherwise qualifies", () => {
  const events = buildRecapEvents(LINES, MARKER, PLAN);
  const merged = events.filter((e) => e.kind === "merged");
  assert.equal(merged.length, 1, "only the AFTER-marker merge should appear, not the before-marker one too");
  assert.equal(merged[0].ts, "2026-07-20T01:00:00.000Z");
});

test("buildRecapEvents: a row naming a REAL plan task carries a title + a #task= card link", () => {
  const events = buildRecapEvents(LINES, MARKER, PLAN);
  const merged = events.find((e) => e.kind === "merged")!;
  assert.equal(merged.taskId, "W1-T1");
  assert.equal(merged.title, "merged one");
  assert.equal(merged.taskCardLink, "#task=W1-T1");

  const blocked = events.find((e) => e.kind === "blocked")!;
  assert.equal(blocked.taskCardLink, "#task=W1-T2");
  assert.equal(blocked.detail, "blocked_ci");

  const escalated = events.find((e) => e.kind === "escalated")!;
  assert.equal(escalated.taskCardLink, "#task=W1-T3");
  assert.equal(escalated.detail, "BLOCKED");

  const answered = events.find((e) => e.kind === "question_answered")!;
  assert.equal(answered.taskCardLink, "#task=W1-T4");
  assert.equal(answered.detail, "yes, proceed");
});

test("buildRecapEvents: a retro row (pseudo task id RETRO, not a real plan task) carries NO card link", () => {
  const events = buildRecapEvents(LINES, MARKER, PLAN);
  const retro = events.find((e) => e.kind === "retro")!;
  assert.equal(retro.taskId, "RETRO");
  assert.equal(retro.taskCardLink, undefined);
  assert.equal(retro.title, undefined);
  assert.match(retro.detail!, /12 runs/);
  assert.match(retro.detail!, /3 learnings/);
});

test("buildRecapEvents: newest first", () => {
  const events = buildRecapEvents(LINES, MARKER, PLAN);
  const timestamps = events.map((e) => e.ts);
  const sorted = [...timestamps].sort().reverse();
  assert.deepEqual(timestamps, sorted);
});

test("buildRecapEvents: an event whose task id is unknown to the plan renders unlinked rather than throwing", () => {
  const lines = [{ ts: "2026-07-20T01:00:00.000Z", step: "verdict", task_id: "W1-T99", verdict: "merged" }];
  const events = buildRecapEvents(lines, MARKER, PLAN);
  assert.equal(events.length, 1);
  assert.equal(events[0].taskCardLink, undefined);
  assert.equal(events[0].title, undefined);
});

test("buildRecapEvents: an empty window (sinceIso in the future) yields no events", () => {
  assert.deepEqual(buildRecapEvents(LINES, "2027-01-01T00:00:00.000Z", PLAN), []);
});

test("buildRecapEvents: a step this recap does not surface (implement.done) never appears", () => {
  const events = buildRecapEvents(LINES, MARKER, PLAN);
  assert.ok(!events.some((e) => (e as { detail?: string }).detail === undefined && e.taskId === "W1-T1" && e.ts === "2026-07-20T06:00:00.000Z"));
  assert.equal(events.filter((e) => e.ts === "2026-07-20T06:00:00.000Z").length, 0);
});
