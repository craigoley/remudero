import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  gatherRuns,
  GUARD_REASON_FALLBACK_ROWS,
  infrastructureEvents,
  infrastructureRecurrence,
  loadMastMapping,
  mastCategoryDistribution,
  parseLedger,
  renderInfrastructure,
  resolveGuardCheck,
  taskDefectCounts,
  type MastMapping,
} from "../src/lib/retro.js";

/**
 * W1-T91/P23: guard-fired blocks classify as INFRASTRUCTURE at retro-read
 * time, never a task defect. The REAL, committed table — a mapping-row edit
 * flips these tests' outcome with zero code change, same discipline as
 * test/mast-mapping.test.ts's own REAL_MAPPING fixture.
 */
const REAL_MAPPING: MastMapping = loadMastMapping(join(process.cwd(), "plan", "mast-mapping.yaml"));

/** One `run.start` + `verdict` ledger line pair, mirroring run-task.ts's real shape. */
function line(runId: string, taskId: string, verdict: string, extra: Record<string, unknown> = {}): string[] {
  return [
    `{"ts":"2026-07-16T00:00:00.000Z","run_id":"${runId}","task_id":"${taskId}","step":"run.start","type":"implement"}`,
    `{"ts":"2026-07-16T00:01:00.000Z","run_id":"${runId}","task_id":"${taskId}","step":"verdict","verdict":"${verdict}","cost_usd":0${
      Object.keys(extra).length ? "," + Object.entries(extra).map(([k, v]) => `"${k}":${JSON.stringify(v)}`).join(",") : ""
    }}`,
  ];
}

// The ACTUAL 2026-07-16 incident (MASTER-PLAN P23's own investigation, plan/tasks.yaml
// W1-T91's rationale): one bootstrap-night build session on W1-T63, two guard fires,
// written PROSE-ONLY (predating this task's structured guard/check/observed fields) —
// the exact message shapes src/lib/isolation.ts / containment.ts still emit today.
const ISOLATION_REASON =
  "isolation_preflight_failed: worker inherited 0 alias(es) and 2 function(s) from operator shell state " +
  "— isolation is NOT holding on this host/run — FAIL CLOSED, the run does not proceed";
const CONTAINMENT_REASON =
  "containment UNPROVEN: no OS-denial was observed for the outside-cwd write — containment UNPROVEN " +
  "(the write may never have been attempted) — FAIL CLOSED, the run does not proceed";

const SEEDED_LEDGER = [
  // The two historical 2026-07-16 lines — same task, prose-only reason, no structured fields.
  ...line("hist-iso", "W1-T63", "blocked_isolation", { reason: ISOLATION_REASON }),
  ...line("hist-con", "W1-T63", "blocked_containment", { reason: CONTAINMENT_REASON }),
  // A THIRD, NEWER isolation block on a DIFFERENT task/host, written with W1-T91's
  // structured fields directly (the guard/check/observed round-trip, not the fallback).
  ...line("new-iso", "W3-T1a", "blocked_isolation", {
    reason: ISOLATION_REASON,
    guard: "isolation",
    check: "inherited-functions",
    observed: "0 aliases, 1 functions",
  }),
  // A genuine task defect on a THIRD task — must survive in taskDefectCounts,
  // proving exclusion is scoped to guard-fired verdicts, not blanket suppression.
  ...line("real-defect", "W1-T99", "blocked_review"),
  // A merged run — out of scope everywhere (success is never a defect or an
  // infrastructure event).
  ...line("clean", "W1-T100", "merged"),
].join("\n");

test("W1-T91 ACCEPTANCE: the seeded ledger's two 2026-07-16 lines classify infrastructure via the fallback pattern row", () => {
  const runs = gatherRuns(parseLedger(SEEDED_LEDGER));
  const events = infrastructureEvents(runs, REAL_MAPPING);
  // 3 guard-fired blocks total: the two historical (fallback-matched) + the one
  // written with structured fields directly.
  assert.equal(events.length, 3);
  const hist = events.filter((e) => e.runId === "hist-iso" || e.runId === "hist-con");
  assert.equal(hist.length, 2);
  const histIso = events.find((e) => e.runId === "hist-iso");
  assert.deepEqual(histIso && { guard: histIso.guard, check: histIso.check }, { guard: "isolation", check: "inherited-functions" });
  const histCon = events.find((e) => e.runId === "hist-con");
  assert.deepEqual(histCon && { guard: histCon.guard, check: histCon.check }, { guard: "containment", check: "outside-cwd-denial" });
});

test("W1-T91 ACCEPTANCE: infrastructure is its own MAST category bucket (byCategory.infrastructure), excluded from every agent-failure category", () => {
  const runs = gatherRuns(parseLedger(SEEDED_LEDGER));
  const dist = mastCategoryDistribution(runs, REAL_MAPPING);
  assert.equal(dist.byCategory.infrastructure, 3);
  assert.equal(dist.byCategory.verification ?? 0, 1); // blocked_review only
  assert.equal("merged" in dist.byCategory, false);
});

test("W1-T91 ACCEPTANCE: W1-T63's task-defect count is 0 — both its guard-fired blocks are excluded, never a task defect", () => {
  const runs = gatherRuns(parseLedger(SEEDED_LEDGER));
  const counts = taskDefectCounts(runs, REAL_MAPPING);
  assert.equal(counts["W1-T63"] ?? 0, 0);
  // The genuine defect on a DIFFERENT task survives — exclusion is scoped to
  // guard-fired verdicts, not a blanket "no task ever has a defect" bug.
  assert.equal(counts["W1-T99"], 1);
});

test("W1-T91 ACCEPTANCE: the recurrence trend names the guard+check — the isolation/inherited-functions check recurs across 2 runs (a host signal)", () => {
  const runs = gatherRuns(parseLedger(SEEDED_LEDGER));
  const events = infrastructureEvents(runs, REAL_MAPPING);
  const recurrence = infrastructureRecurrence(events);
  const isoRecur = recurrence.find((r) => r.guard === "isolation" && r.check === "inherited-functions");
  assert.ok(isoRecur, "the isolation/inherited-functions pair must appear in the recurrence trend");
  assert.equal(isoRecur?.count, 2);
  assert.deepEqual(isoRecur?.taskIds.sort(), ["W1-T63", "W3-T1a"]);
  const conRecur = recurrence.find((r) => r.guard === "containment" && r.check === "outside-cwd-denial");
  assert.equal(conRecur?.count, 1);
  // The rendered report NAMES the guard+check pair explicitly (never just a bare count).
  const rendered = renderInfrastructure(events, recurrence);
  assert.match(rendered, /isolation\/inherited-functions: 2x/);
});

test("resolveGuardCheck: prefers the run's OWN structured fields over the fallback table when both are present", () => {
  const gc = resolveGuardCheck({ verdict: "blocked_isolation", guard: "isolation", check: "inherited-functions", reason: "irrelevant" });
  assert.deepEqual(gc, { guard: "isolation", check: "inherited-functions" });
});

test("resolveGuardCheck: a verdict the fallback table names but whose reason does NOT match returns undefined (never a guess)", () => {
  const gc = resolveGuardCheck({ verdict: "blocked_isolation", reason: "some unrelated prose" });
  assert.equal(gc, undefined);
});

test("resolveGuardCheck: a run with neither structured fields nor a fallback match returns undefined", () => {
  assert.equal(resolveGuardCheck({ verdict: "blocked_review" }), undefined);
});

test("GUARD_REASON_FALLBACK_ROWS: exactly the two guard classes shipped today, each pattern matching its own real message shape", () => {
  const iso = GUARD_REASON_FALLBACK_ROWS.find((r) => r.verdict === "blocked_isolation");
  const con = GUARD_REASON_FALLBACK_ROWS.find((r) => r.verdict === "blocked_containment");
  assert.ok(iso && iso.pattern.test(ISOLATION_REASON));
  assert.ok(con && con.pattern.test(CONTAINMENT_REASON));
});

test("infrastructureEvents: a run the mapping names infrastructure but with NO resolvable guard/check still counts, named 'unknown' rather than dropped", () => {
  const tempMapping: MastMapping = {
    rows: [{ verdict: "blocked_solar_flare", mastMode: "N/A", category: "infrastructure" }],
  };
  const runs = gatherRuns(parseLedger(line("z", "TZ", "blocked_solar_flare").join("\n")));
  const events = infrastructureEvents(runs, tempMapping);
  assert.equal(events.length, 1);
  assert.deepEqual({ guard: events[0].guard, check: events[0].check }, { guard: "unknown", check: "unknown" });
});

test("renderInfrastructure: zero events renders an explicit 'None this cycle' line, never a blank section", () => {
  const rendered = renderInfrastructure([], []);
  assert.match(rendered, /None this cycle/);
});
