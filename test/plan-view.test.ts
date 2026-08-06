import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { isDispatchBreakerTripped, DEFAULT_MAX_TASK_DISPATCHES, type GitHub, type StatusProjection } from "../src/lib/status.js";
import { runnableCandidates, type MergedSet } from "../src/lib/drain.js";
import { createService } from "../src/lib/service.js";
import {
  buildPlanFrontier,
  buildPlanViewRoute,
  computePlanProgress,
  computePlanSectionCounts,
  createPlanProgressCache,
  createPlanSectionCache,
  DEFAULT_FRONTIER_LIMIT,
  readPlanRefs,
  type PanelGraphDeps,
  type PlanProgressCache,
  type PlanSectionCache,
  type RatifyCliGateway,
} from "../src/lib/panel-graph.js";
import type { PlanIndex } from "../src/lib/plan-index.js";
import type { TraceGithub } from "../src/lib/trace.js";

// ── W1-T315: the Plan tab's progress (done/in-flight/queued) + frontier (next candidates, each
// carrying WHY) -- proves the FOUR acceptance claims in plan/tasks.d/W1-T315-*.yaml. ──────────

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-plan-view-"));
}

/** Writes plan/tasks.yaml under `root` and returns its path -- the root must not already carry
 *  one (mirrors test/panel-graph.test.ts's own `writePlan`, `wx` so a double-write is a loud
 *  test bug, never a silent overwrite). */
function writePlan(root: string, yamlBody: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, yamlBody, { flag: "wx" });
  return planPath;
}

function fixturePlan(root: string, yamlBody: string): Plan {
  return loadPlan(writePlan(root, yamlBody));
}

const NONE_MERGED: MergedSet = () => false;
function mergedSetOf(...ids: string[]): MergedSet {
  const s = new Set(ids);
  return (id) => s.has(id);
}

/** A readFailed()/readFailureReason() stub that counts how many times readFailed() is
 *  consulted -- backs the "ONE batched call, never one per task" acceptance claim. */
function countingGithub(opts: { failed?: boolean; reason?: string } = {}): Pick<GitHub, "readFailed" | "readFailureReason"> & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    readFailed() {
      calls += 1;
      return Boolean(opts.failed);
    },
    readFailureReason() {
      return opts.failed ? ((opts.reason ?? "unknown") as any) : undefined;
    },
  };
}

// ── acceptance (1): progress counts are GitHub-derived, never off the yaml `status:` field ───

test("computePlanProgress: a task whose yaml status is 'queued' but whose projection is merged counts as DONE -- the falsifier is a count read off yaml status", () => {
  const root = tmpRoot();
  const plan = fixturePlan(
    root,
    ["- id: A", "  title: a", "  repo: remudero", "  type: implement", "  depends_on: []", "  status: queued", ""].join("\n"),
  );
  const projection = new Map<string, StatusProjection>([["A", { taskId: "A", status: "merged", merged: true, source: "trailer" }]]);
  const progress = computePlanProgress(plan, projection, countingGithub(), createPlanProgressCache());
  assert.equal(progress.done, 1, "merged in the PROJECTION, despite yaml status: queued");
  assert.equal(progress.inFlight, 0);
  assert.equal(progress.queued, 0);
  assert.equal(progress.unknown, false);
});

test("computePlanProgress: done/in-flight/queued bucket a mixed plan correctly, off status.ts's own projection vocabulary", () => {
  const root = tmpRoot();
  const plan = fixturePlan(
    root,
    [
      "- id: A",
      "  title: a",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "- id: B",
      "  title: b",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "- id: C",
      "  title: c",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "",
    ].join("\n"),
  );
  const projection = new Map<string, StatusProjection>([
    ["A", { taskId: "A", status: "merged", merged: true, source: "trailer" }],
    ["B", { taskId: "B", status: "running", merged: false, source: "pr-field" }],
    // C has no projection entry at all -- the ordinary "never observed yet" absence, buckets queued.
  ]);
  const progress = computePlanProgress(plan, projection, countingGithub(), createPlanProgressCache());
  assert.equal(progress.done, 1);
  assert.equal(progress.inFlight, 1);
  assert.equal(progress.queued, 1);
  assert.equal(progress.total, 3);
});

// ── acceptance (2): an unreadable gateway renders UNKNOWN with the last-known value + age, never
// a zero, through ONE batched call ────────────────────────────────────────────────────────────

test("computePlanProgress: github.readFailed() true with NO prior reading -> unknown:true and no fabricated numbers (never a 0)", () => {
  const root = tmpRoot();
  const plan = fixturePlan(root, ["- id: A", "  title: a", "  repo: remudero", "  type: implement", "  depends_on: []", ""].join("\n"));
  const github = countingGithub({ failed: true, reason: "rate_limit" });
  const progress = computePlanProgress(plan, new Map(), github, createPlanProgressCache());
  assert.equal(progress.unknown, true);
  assert.equal(progress.unavailableReason, "rate_limit");
  assert.equal(progress.done, undefined, "never a fabricated 0 -- absent, since nothing was ever successfully observed");
  assert.equal(progress.inFlight, undefined);
  assert.equal(progress.queued, undefined);
});

test("computePlanProgress: github.readFailed() true WITH a prior successful reading -> unknown:true, counts + asOf CARRY FORWARD the last-known reading verbatim (never a zero, never a shrunk denominator)", () => {
  const root = tmpRoot();
  const plan = fixturePlan(
    root,
    ["- id: A", "  title: a", "  repo: remudero", "  type: implement", "  depends_on: []", "- id: B", "  title: b", "  repo: remudero", "  type: implement", "  depends_on: []", ""].join(
      "\n",
    ),
  );
  const cache: PlanProgressCache = createPlanProgressCache();
  const okGithub = countingGithub({ failed: false });
  const firstReading = computePlanProgress(
    plan,
    new Map([["A", { taskId: "A", status: "merged", merged: true, source: "trailer" } as StatusProjection]]),
    okGithub,
    cache,
    () => 1_000_000,
  );
  assert.equal(firstReading.unknown, false);

  const failingGithub = countingGithub({ failed: true, reason: "transport" });
  const outageReading = computePlanProgress(plan, new Map(), failingGithub, cache, () => 2_000_000);
  assert.equal(outageReading.unknown, true);
  assert.equal(outageReading.unavailableReason, "transport");
  assert.equal(outageReading.done, firstReading.done, "the LAST-KNOWN done count, never 0");
  assert.equal(outageReading.inFlight, firstReading.inFlight);
  assert.equal(outageReading.queued, firstReading.queued);
  assert.equal(outageReading.total, firstReading.total);
  // The AGE: asOf stays the LAST successful reading's own timestamp, never the outage's clock --
  // a caller renders "last known Ns ago" off exactly this field.
  assert.equal(outageReading.asOf, firstReading.asOf);
});

test("computePlanProgress: consults readFailed() exactly ONCE per call, however many tasks the plan carries -- the 'ONE batched call, never one per task' acceptance claim, proven as an upper-bound call count rather than assumed", () => {
  const root = tmpRoot();
  const lines = ["repo: remudero", "type: implement", "depends_on: []"];
  const yaml = Array.from({ length: 25 }, (_, i) => [`- id: T${i}`, `  title: t${i}`, ...lines.map((l) => `  ${l}`)].join("\n")).join("\n") + "\n";
  const plan = fixturePlan(root, yaml);
  const projection = new Map<string, StatusProjection>();
  const github = countingGithub({ failed: false });
  computePlanProgress(plan, projection, github, createPlanProgressCache());
  assert.equal(github.calls, 1, "one readFailed() consultation for a 25-task plan, not 25");
});

// ── acceptance (3) + (4): the frontier binds runnableCandidates for ordering/eligibility, and
// every row (runnable or held) states a machine-derived reason ────────────────────────────────

const FRONTIER_YAML = [
  "- id: P1", // no deps, verify auto, not blocked, not merged -> RUNNABLE, head of file order
  "  title: alpha",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: []",
  "- id: P2", // task.status: blocked -> HELD, named blocker
  "  title: beta",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: []",
  "  status: blocked",
  '  note: "waiting on ops"',
  "- id: P3", // depends on P1, which is not merged -> HELD, named unmet dependency
  "  title: gamma",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: [P1]",
  "- id: P4", // verify: human -> EXCLUDED entirely (permanently parked, not "what's next")
  "  title: delta",
  "  repo: remudero",
  "  type: implement",
  "  verify: human",
  "  depends_on: []",
  "- id: P5", // circuit-tripped via the ledger below -> HELD, named blocker with breaker ETA
  "  title: epsilon",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: []",
  "- id: P6", // MERGED -> excluded entirely (that's PlanProgress.done, not the frontier)
  "  title: zeta",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: []",
  "",
].join("\n");

function circuitTrippedLedger(taskId: string, n: number = DEFAULT_MAX_TASK_DISPATCHES): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ ts: new Date(i).toISOString(), run_id: `${taskId}-run-${i}`, task_id: taskId, step: "run.start" }));
}

test("buildPlanFrontier: the RUNNABLE rows are in the EXACT SAME order runnableCandidates itself returns -- binding the existing selector, never a second ordering", () => {
  const root = tmpRoot();
  const plan = fixturePlan(root, FRONTIER_YAML);
  const isMerged = mergedSetOf("P6");
  const ledgerLines = circuitTrippedLedger("P5");

  const frontier = buildPlanFrontier(plan, isMerged, 10, ledgerLines);
  const runnableIds = frontier.filter((r) => r.runnable).map((r) => r.id);

  const isCircuitTripped = (id: string) => isDispatchBreakerTripped(ledgerLines, id);
  const expected = runnableCandidates(plan, isMerged, 10, { isCircuitTripped }).map((t) => t.id);
  assert.deepEqual(runnableIds, expected, "frontier's runnable subset must equal runnableCandidates' own verdict+order exactly");
  assert.deepEqual(runnableIds, ["P1"]);
});

test("buildPlanFrontier: every TEMPORARILY-held task renders AS HELD with a machine-derived reason -- never silently omitted -- naming the unmet dependency, the blocked note, and the circuit breaker's own reset condition; PERMANENTLY-parked verify:human and DONE tasks are excluded from the frontier entirely", () => {
  const root = tmpRoot();
  const plan = fixturePlan(root, FRONTIER_YAML);
  const isMerged = mergedSetOf("P6");
  const ledgerLines = circuitTrippedLedger("P5");

  const frontier = buildPlanFrontier(plan, isMerged, 10, ledgerLines);
  const byId = new Map(frontier.map((r) => [r.id, r]));

  // P6 is DONE (merged) -- excluded from the frontier entirely, it is not "what's next".
  assert.equal(byId.has("P6"), false);

  // P4 is verify:human -- PERMANENTLY parked, excluded from the frontier entirely (never
  // becomes runnable on its own; it already renders, with a better label, under "need you
  // (verify != auto)" in the pinned header -- see idle-reasons-panel.ts).
  assert.equal(byId.has("P4"), false);

  const p1 = byId.get("P1")!;
  assert.equal(p1.runnable, true);
  assert.equal(p1.reasonKind, "file-order");
  assert.match(p1.reason, /head of file order/);

  const p2 = byId.get("P2")!;
  assert.equal(p2.runnable, false);
  assert.equal(p2.reasonKind, "blocked");
  assert.match(p2.reason, /waiting on ops/, "the task's own note is the named reason, not a generic blurb");

  const p3 = byId.get("P3")!;
  assert.equal(p3.runnable, false);
  assert.equal(p3.reasonKind, "unmet-dependency");
  assert.match(p3.reason, /P1/, "names WHICH dependency is unmet");

  const p5 = byId.get("P5")!;
  assert.equal(p5.runnable, false);
  assert.equal(p5.reasonKind, "circuit-breaker");
  assert.match(p5.reason, new RegExp(`${DEFAULT_MAX_TASK_DISPATCHES}/${DEFAULT_MAX_TASK_DISPATCHES}`), "names the breaker's own dispatch tally");
  assert.match(p5.reason, /resets only on a fresh owned PR/, "the breaker's own reset condition -- its ETA");
});

test("buildPlanFrontier: FALSIFIER -- a file-order head of parked verify:human tasks does not spend the row budget; the frontier surfaces the runnable tasks behind them instead", () => {
  const root = tmpRoot();
  const plan = fixturePlan(
    root,
    [
      "- id: H1", // verify: human, head of file order -> parked, must NOT occupy a frontier slot
      "  title: h1",
      "  repo: remudero",
      "  type: implement",
      "  verify: human",
      "  depends_on: []",
      "- id: H2", // verify: human, also ahead of the runnable tasks -> same
      "  title: h2",
      "  repo: remudero",
      "  type: implement",
      "  verify: human",
      "  depends_on: []",
      "- id: R1", // no deps, verify auto -> RUNNABLE, sits behind H1/H2 in file order
      "  title: r1",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "- id: R2", // ditto
      "  title: r2",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "",
    ].join("\n"),
  );

  // A budget of 2: were parked rows still counted, both slots would go to H1/H2 and neither
  // runnable task would ever appear -- exactly the bug this task fixes.
  const frontier = buildPlanFrontier(plan, NONE_MERGED, 2, []);
  assert.deepEqual(frontier.map((r) => r.id), ["R1", "R2"], "the two runnable tasks fill the budget, not the two parked ones ahead of them");
  assert.ok(
    frontier.every((r) => r.runnable),
    "every row the budget spends here is runnable -- none of it went to a permanently-parked row",
  );

  // Even with room for everyone, H1/H2 never appear -- they are excluded, not merely
  // de-prioritised within the budget.
  const wideFrontier = buildPlanFrontier(plan, NONE_MERGED, 10, []);
  const wideIds = wideFrontier.map((r) => r.id);
  assert.deepEqual(wideIds, ["R1", "R2"], "verify:human rows are absent from the frontier at any limit, not just squeezed out by a small one");
});

test("buildPlanFrontier: a smaller limit still counts HELD rows toward it (not just runnable ones) -- 'not-runnable is information, not absence'", () => {
  const root = tmpRoot();
  const plan = fixturePlan(root, FRONTIER_YAML);
  const isMerged = mergedSetOf("P6");
  const ledgerLines = circuitTrippedLedger("P5");

  const frontier = buildPlanFrontier(plan, isMerged, 2, ledgerLines);
  assert.deepEqual(
    frontier.map((r) => r.id),
    ["P1", "P2"],
    "P2 is HELD, not runnable -- it still occupies a frontier slot rather than being skipped past",
  );
});

test("buildPlanFrontier: file-order rank text distinguishes the head from later runnable candidates", () => {
  const root = tmpRoot();
  const plan = fixturePlan(
    root,
    ["- id: Q1", "  title: q1", "  repo: remudero", "  type: implement", "  depends_on: []", "- id: Q2", "  title: q2", "  repo: remudero", "  type: implement", "  depends_on: []", ""].join(
      "\n",
    ),
  );
  const frontier = buildPlanFrontier(plan, NONE_MERGED, 10, []);
  assert.deepEqual(frontier.map((r) => r.id), ["Q1", "Q2"]);
  assert.match(frontier[0].reason, /head of file order/);
  assert.match(frontier[1].reason, /1 runnable task ahead/);
});

test("buildPlanFrontier: an empty plan yields an empty frontier, not an error", () => {
  const root = tmpRoot();
  const plan = fixturePlan(root, "[]\n");
  assert.deepEqual(buildPlanFrontier(plan, NONE_MERGED, 10, []), []);
});

// ── W1-T376: per-section filed/merged COUNTS, joined off plan_refs against plan-index.json ─────
//
// acceptance (1): "section counts key only on headings plan-index resolves, with task-id and
// proposal and workstream refs contributing nothing" -- and the exact-token join must not let a
// bare "§5" ref falsely match a DIFFERENT, longer heading ("5C. ...").
// acceptance (2): "done is taken from the merged projection the route already resolved, so a
// task whose yaml status reads queued while merged counts as merged".

/** A small, hand-built plan-index fixture -- deliberately including a bare "5." heading NEXT TO
 *  "5C. ..." (proves the join is an EXACT leading-token match, never a prefix match: a "§5" ref
 *  must resolve to "5. Principles engine" only, never fall through to "5C. Task pre-flight...")
 *  and a word-shaped, no-digit heading (the "§Self-improvement" fallback case, design (ii)). */
function fixtureIndex(): PlanIndex {
  return {
    source: "MASTER-PLAN.md",
    entries: [
      { heading: "5. Principles engine", line: 10, summary: "" },
      { heading: "5C. Task pre-flight: the plan gate", line: 20, summary: "" },
      { heading: "7. The control panel — ONE web app, three shells", line: 30, summary: "" },
      { heading: "Self-improvement: flywheel, retros, knowledge & the commons", line: 40, summary: "" },
    ],
  };
}

const PLAN_REFS_YAML = [
  "- id: A", // §5C -- resolves, merged
  "  title: a",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: []",
  "- id: B", // MASTER-PLAN#5C -- the SAME heading via the second spelling, not merged
  "  title: b",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: []",
  "- id: C", // a TASK-ID ref -- must contribute to no section
  "  title: c",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: []",
  "- id: D", // a RETRO PROPOSAL ref -- must contribute to no section
  "  title: d",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: []",
  "- id: E", // a WORKSTREAM ref -- must contribute to no section
  "  title: e",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: []",
  "- id: F", // §Self-improvement -- word-shaped, resolves via the case-insensitive prefix fallback
  "  title: f",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: []",
  "- id: G", // §5 -- must resolve to "5. Principles engine" EXACTLY, never "5C. ..."
  "  title: g",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: []",
  "- id: H", // yaml status: queued, but the PROJECTION says merged -- W1-T280's own rule
  "  title: h",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: []",
  "  status: queued",
  "",
].join("\n");

function planRefsFixture(): Map<string, string[]> {
  return new Map([
    ["A", ["§5C"]],
    ["B", ["MASTER-PLAN#5C"]],
    ["C", ["W1-T999"]],
    ["D", ["P22"]],
    ["E", ["WS-7"]],
    ["F", ["§Self-improvement"]],
    ["G", ["§5"]],
    ["H", ["§7"]],
  ]);
}

test("computePlanSectionCounts: section counts key only on headings plan-index resolves -- task-id/retro-proposal/workstream refs contribute NOTHING, and an exact-token join never lets a bare ref fall through to a longer, unrelated heading", () => {
  const root = tmpRoot();
  const plan = fixturePlan(root, PLAN_REFS_YAML);
  const projection = new Map<string, StatusProjection>([
    ["A", { taskId: "A", status: "merged", merged: true, source: "trailer" }],
    ["F", { taskId: "F", status: "merged", merged: true, source: "trailer" }],
  ]);
  const cache: PlanSectionCache = createPlanSectionCache();
  const sections = computePlanSectionCounts(plan, projection, planRefsFixture(), fixtureIndex(), false, cache);

  const byHeading = new Map(sections.map((s) => [s.heading, s]));
  // A (§5C) + B (MASTER-PLAN#5C, the SAME heading via the second spelling) -- both spellings join
  // to ONE section; C/D/E's task-id/proposal/workstream refs contribute NOTHING to it.
  assert.deepEqual(byHeading.get("5C. Task pre-flight: the plan gate"), { heading: "5C. Task pre-flight: the plan gate", filed: 2, merged: 1 });
  // G (§5) resolves to the DISTINCT "5." heading, never "5C." -- the falsifier for a prefix-match bug.
  assert.deepEqual(byHeading.get("5. Principles engine"), { heading: "5. Principles engine", filed: 1, merged: 0 });
  // F (§Self-improvement) resolves via the word-shaped, case-insensitive prefix fallback.
  assert.deepEqual(byHeading.get("Self-improvement: flywheel, retros, knowledge & the commons"), {
    heading: "Self-improvement: flywheel, retros, knowledge & the commons",
    filed: 1,
    merged: 1,
  });
  // H (§7) -- present with its own row, unmerged in THIS test's projection.
  assert.deepEqual(byHeading.get("7. The control panel — ONE web app, three shells"), {
    heading: "7. The control panel — ONE web app, three shells",
    filed: 1,
    merged: 0,
  });
  // Exactly FOUR sections total: C/D/E's task-id/proposal/workstream refs never fabricated a fifth/sixth/seventh.
  assert.equal(sections.length, 4);
});

test("computePlanSectionCounts: 'merged' comes from the PROJECTION, never plan/tasks.yaml's own decorative status: field -- a task reading status: queued while its projection says merged counts as merged", () => {
  const root = tmpRoot();
  const plan = fixturePlan(root, PLAN_REFS_YAML);
  const task = plan.byId.get("H")!;
  assert.equal(task.status, "queued", "the fixture's own yaml status is queued -- the falsifier a naive reader would trip on");
  const projection = new Map<string, StatusProjection>([["H", { taskId: "H", status: "merged", merged: true, source: "trailer" }]]);
  const sections = computePlanSectionCounts(plan, projection, planRefsFixture(), fixtureIndex(), false, createPlanSectionCache());
  const section = sections.find((s) => s.heading === "7. The control panel — ONE web app, three shells")!;
  assert.equal(section.filed, 1);
  assert.equal(section.merged, 1, "merged in the PROJECTION despite yaml status: queued");
});

test("computePlanSectionCounts: darkness parity -- progressUnknown:true carries the LAST-known sections forward (or none, on a first-ever outage), never a fresh/fabricated read", () => {
  const root = tmpRoot();
  const plan = fixturePlan(root, PLAN_REFS_YAML);
  const projection = new Map<string, StatusProjection>([["A", { taskId: "A", status: "merged", merged: true, source: "trailer" }]]);
  const cache: PlanSectionCache = createPlanSectionCache();

  // First-ever outage: nothing cached yet -- empty, never a fabricated count.
  assert.deepEqual(computePlanSectionCounts(plan, projection, planRefsFixture(), fixtureIndex(), true, cache), []);

  // A successful reading populates the cache...
  const fresh = computePlanSectionCounts(plan, projection, planRefsFixture(), fixtureIndex(), false, cache);
  assert.ok(fresh.length > 0);

  // ...and a SUBSEQUENT outage carries that exact reading forward, even though the (unused)
  // projection argument below would produce a DIFFERENT answer if it were consulted.
  const emptyProjection = new Map<string, StatusProjection>();
  const outage = computePlanSectionCounts(plan, emptyProjection, planRefsFixture(), fixtureIndex(), true, cache);
  assert.deepEqual(outage, fresh, "the last-known reading, verbatim -- never re-derived under darkness");
});

// ── readPlanRefs: the best-effort SECOND parse of tasks.yaml + tasks.d/*.yaml for plan_refs ────

test("readPlanRefs: merges plan_refs across tasks.yaml AND its tasks.d/*.yaml shards, keyed by id", () => {
  const root = tmpRoot();
  const planPath = writePlan(root, ["- id: A", "  title: a", "  repo: remudero", "  type: implement", "  depends_on: []", '  plan_refs: ["§5C"]', ""].join("\n"));
  const shardDir = join(root, "plan", "tasks.d");
  mkdirSync(shardDir, { recursive: true });
  writeFileSync(
    join(shardDir, "shard-1.yaml"),
    ["- id: B", "  title: b", "  repo: remudero", "  type: implement", "  depends_on: []", '  plan_refs: ["§7", "W1-T999"]', ""].join("\n"),
  );
  const refs = readPlanRefs(planPath);
  assert.deepEqual(refs.get("A"), ["§5C"]);
  assert.deepEqual(refs.get("B"), ["§7", "W1-T999"]);
});

test("readPlanRefs: an unreadable planPath -> empty map, never a throw", () => {
  const refs = readPlanRefs(join(tmpRoot(), "plan", "does-not-exist.yaml"));
  assert.deepEqual(refs, new Map());
});

test("readPlanRefs: malformed YAML in tasks.yaml, or a malformed shard, is skipped -- never a throw, and a GOOD sibling shard still contributes", () => {
  const root = tmpRoot();
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "not: [valid, yaml", { flag: "wx" }); // unterminated flow sequence -- parseYaml throws
  const shardDir = join(root, "plan", "tasks.d");
  mkdirSync(shardDir, { recursive: true });
  writeFileSync(join(shardDir, "bad.yaml"), "not: [valid, yaml", { flag: "wx" });
  writeFileSync(
    join(shardDir, "good.yaml"),
    ["- id: C", "  title: c", "  repo: remudero", "  type: implement", "  depends_on: []", '  plan_refs: ["P22"]', ""].join("\n"),
    { flag: "wx" },
  );
  const refs = readPlanRefs(planPath);
  assert.equal(refs.size, 1, "only the well-formed shard contributed -- the malformed root file and the malformed shard both skipped silently");
  assert.deepEqual(refs.get("C"), ["P22"]);
});

// ── GET /v1/plan/view — the route wiring: one fetch for the whole tab ──────────────────────────

function fakeGithub(): TraceGithub {
  return { prView: () => null };
}

function fakeRatifyGateway(): RatifyCliGateway {
  return { approve() {}, reframe() {} };
}

function statusGithubOf(prState: Record<string, string>, opts: { failRead?: boolean } = {}): GitHub {
  return {
    prByRef(ref: string | number) {
      const state = prState[String(ref)];
      return state ? { number: 1, url: String(ref), state } : null;
    },
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => Boolean(opts.failRead),
    readFailureReason: () => (opts.failRead ? "unknown" : undefined),
  };
}

function routeDeps(root: string, planPath: string, statusGithub: GitHub): PanelGraphDeps {
  return {
    root,
    inboxRoot: root,
    planPath,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    github: fakeGithub(),
    statusGithub,
    ratify: fakeRatifyGateway(),
  };
}

async function withRoute<T>(deps: PanelGraphDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: "read-token", write: "write-token" }, routes: [buildPlanViewRoute(deps)] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("GET /v1/plan/view: renders { progress, frontier } off ONE plan load + ONE projectPlan() call, defaulting the frontier to DEFAULT_FRONTIER_LIMIT rows", async () => {
  const root = tmpRoot();
  const planPath = writePlan(root, FRONTIER_YAML);
  const deps = routeDeps(root, planPath, statusGithubOf({}));
  await withRoute(deps, async (base) => {
    const res = await fetch(`${base}/v1/plan/view`, { headers: { Authorization: "Bearer read-token" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { progress: { done: number; unknown: boolean }; frontier: Array<{ id: string }> };
    assert.equal(body.progress.unknown, false);
    assert.ok(body.frontier.length <= DEFAULT_FRONTIER_LIMIT);
    assert.ok(body.frontier.some((r) => r.id === "P1"));
  });
});

test("GET /v1/plan/view: ?frontier=<n> bounds the row count; a non-numeric/non-positive value -> 400", async () => {
  const root = tmpRoot();
  const planPath = writePlan(root, FRONTIER_YAML);
  const deps = routeDeps(root, planPath, statusGithubOf({}));
  await withRoute(deps, async (base) => {
    const bounded = await fetch(`${base}/v1/plan/view?frontier=2`, { headers: { Authorization: "Bearer read-token" } });
    const body = (await bounded.json()) as { frontier: Array<{ id: string }> };
    assert.equal(body.frontier.length, 2);

    assert.equal((await fetch(`${base}/v1/plan/view?frontier=bogus`, { headers: { Authorization: "Bearer read-token" } })).status, 400);
    assert.equal((await fetch(`${base}/v1/plan/view?frontier=0`, { headers: { Authorization: "Bearer read-token" } })).status, 400);
  });
});

test("GET /v1/plan/view: an unreadable statusGithub -> 200 with progress.unknown:true (never a throw, never a fabricated zero)", async () => {
  const root = tmpRoot();
  const planPath = writePlan(root, FRONTIER_YAML);
  const deps = routeDeps(root, planPath, statusGithubOf({}, { failRead: true }));
  await withRoute(deps, async (base) => {
    const res = await fetch(`${base}/v1/plan/view`, { headers: { Authorization: "Bearer read-token" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { progress: { unknown: boolean; done?: number } };
    assert.equal(body.progress.unknown, true);
    assert.equal(body.progress.done, undefined);
  });
});

// ── W1-T376, end-to-end: the route reads plan_refs off the REAL tasks.yaml + a REAL
// plan/plan-index.json sitting next to it (never a new GitHub call) and returns `sections`. ────

test("GET /v1/plan/view: `sections` is derived off the real plan/plan-index.json sitting next to planPath -- a task's plan_refs joins to its heading with NO percent anywhere in the payload's shape", async () => {
  const root = tmpRoot();
  const planPath = writePlan(
    root,
    [
      "- id: A",
      "  title: a",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      '  plan_refs: ["§5C"]',
      "- id: B",
      "  title: b",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      '  plan_refs: ["W1-T999"]', // a task-id ref -- must contribute nothing
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "plan", "plan-index.json"),
    JSON.stringify({ source: "MASTER-PLAN.md", entries: [{ heading: "5C. Task pre-flight: the plan gate", line: 1, summary: "" }] }),
  );
  const deps = routeDeps(root, planPath, statusGithubOf({}));
  await withRoute(deps, async (base) => {
    const res = await fetch(`${base}/v1/plan/view`, { headers: { Authorization: "Bearer read-token" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sections: Array<{ heading: string; filed: number; merged: number }> };
    assert.deepEqual(body.sections, [{ heading: "5C. Task pre-flight: the plan gate", filed: 1, merged: 0 }]);
  });
});
