import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertRunnable,
  loadPlan,
  PlanError,
  RETIREMENT_REASONS,
  selectTask,
  TASK_STATUSES,
  transitiveDependents,
  unmetDependencies,
  visibleCriteria,
} from "../src/lib/plan.js";

function planFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-"));
  const p = join(dir, "tasks.yaml");
  writeFileSync(p, yaml);
  return p;
}

const YAML = `
- id: A
  title: first
  repo: remudero-sandbox
  depends_on: []
  type: implement
  verify: auto
  status: merged
  attempts: 0
- id: B
  title: second
  repo: remudero
  depends_on: [A]
  type: implement
  verify: auto
  status: queued
  attempts: 0
- id: C
  title: third
  repo: remudero
  depends_on: [B]
  type: implement
  verify: auto
  status: queued
  attempts: 0
`;

test("loads and indexes tasks", () => {
  const plan = loadPlan(planFile(YAML));
  assert.equal(plan.tasks.length, 3);
  assert.equal(selectTask(plan, "B").title, "second");
});

test("B is runnable (dep A merged); C is not (dep B queued)", () => {
  const plan = loadPlan(planFile(YAML));
  assert.deepEqual(unmetDependencies(plan, selectTask(plan, "B")), []);
  assert.deepEqual(unmetDependencies(plan, selectTask(plan, "C")), ["B"]);
  assert.doesNotThrow(() => assertRunnable(plan, selectTask(plan, "B")));
  assert.throws(() => assertRunnable(plan, selectTask(plan, "C")), PlanError);
});

/** W1-T3397's fixture, shared by the four criteria below. One retired dependency per retirement
 *  reason, one LIVE unmerged dependency, and two downstream tasks: one depending on both, one on
 *  retired dependencies only. */
function retirementPlan(): ReturnType<typeof loadPlan> {
  const retiredDependencyEntries = RETIREMENT_REASONS.map(
    (reason) => `
- id: W1-T3166-${reason}
  title: retired dependency ${reason}
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: blocked
  retirement: ${reason}
  attempts: 0
`,
  ).join("");
  return loadPlan(planFile(`
${retiredDependencyEntries}
- id: W1-T3199
  title: live dependency
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: queued
  attempts: 0
- id: W1-T3201
  title: downstream task with retired and live dependencies
  repo: remudero
  depends_on: [W1-T3199, W1-T3166-withdrawn]
  type: implement
  verify: auto
  status: queued
  attempts: 0
- id: RETIRED-ONLY
  title: downstream task with only retired dependencies
  repo: remudero
  depends_on: [W1-T3166-retired, W1-T3166-closed, W1-T3166-withdrawn]
  type: implement
  verify: auto
  status: queued
  attempts: 0
`));
}

test("retired dependencies are excluded from unmetDependencies", () => {
  const plan = retirementPlan();
  // Every retirement reason, not just one: the filter keys on `retirement !== undefined`, so a
  // reason-specific implementation would pass a single-reason fixture and fail here.
  assert.deepEqual(unmetDependencies(plan, selectTask(plan, "RETIRED-ONLY")), []);
});

test("live unmerged dependencies remain unmet after retirement filtering", () => {
  const plan = retirementPlan();
  // The guard must not swallow the live dependency sitting beside a retired one — a filter that
  // returned false unconditionally would satisfy the criterion above and fail this one.
  assert.deepEqual(unmetDependencies(plan, selectTask(plan, "W1-T3201")), ["W1-T3199"]);
});

test("assertRunnable accepts retired-only dependencies and rejects live unmet dependencies", () => {
  const plan = retirementPlan();
  assert.doesNotThrow(() => assertRunnable(plan, selectTask(plan, "RETIRED-ONLY")));
  assert.throws(() => assertRunnable(plan, selectTask(plan, "W1-T3201")), PlanError);
});

test("retired dependencies bypass isMerged without changing merge status", () => {
  const plan = retirementPlan();
  const asked: string[] = [];
  const spy = (t: { id: string }): boolean => {
    asked.push(t.id);
    return false; // nothing is merged: the ONLY thing clearing a retired dep may be retirement
  };

  assert.deepEqual(unmetDependencies(plan, selectTask(plan, "RETIRED-ONLY"), spy), []);
  assert.deepEqual(asked, [], "a retired dependency must short-circuit BEFORE isMerged is consulted");

  assert.deepEqual(unmetDependencies(plan, selectTask(plan, "W1-T3201"), spy), ["W1-T3199"]);
  assert.deepEqual(asked, ["W1-T3199"], "and the live dependency must still be asked about");

  // "without changing merge status": retirement excuses a dependency, it does not report it as
  // merged. An implementation that made retired tasks answer `isMerged` true would pass every
  // assertion above and fail this one.
  assert.equal(spy(selectTask(plan, "W1-T3166-retired")), false);
});

test("rejects a dependency on an unknown task", () => {
  const bad = `
- id: X
  title: x
  repo: r
  depends_on: [NOPE]
  type: implement
  verify: auto
  status: queued
  attempts: 0
`;
  assert.throws(() => loadPlan(planFile(bad)), PlanError);
});

// ── W1-T2639: the status arm must TEACH the permitted vocabulary, like its
// risk/retirement siblings, instead of just refusing.

test("rejects an out-of-vocabulary status, naming every member of TASK_STATUSES", () => {
  const bad = `
- id: S
  title: s
  repo: r
  depends_on: []
  type: implement
  verify: auto
  status: shipped
  attempts: 0
`;
  assert.throws(() => loadPlan(planFile(bad)), (err: unknown) => {
    assert.ok(err instanceof PlanError);
    assert.match(err.message, /invalid status 'shipped'/);
    for (const s of TASK_STATUSES) {
      assert.ok(err.message.includes(s), `expected message to name '${s}': ${err.message}`);
    }
    return true;
  });
});

test("status vocabulary is unchanged: 'shipped' stays illegal and 'merged'/'done' remain the only merged-meaning members", () => {
  assert.ok(!(TASK_STATUSES as readonly string[]).includes("shipped"));
  assert.deepEqual([...TASK_STATUSES], [
    "queued",
    "recon",
    "prompted",
    "running",
    "review",
    "fixing",
    "diagnosing",
    "blocked",
    "merged",
    "done",
  ]);
});

test("rejects verify:human as not auto-runnable", () => {
  const y = `
- id: H
  title: h
  repo: r
  depends_on: []
  type: implement
  verify: human
  status: queued
  attempts: 0
`;
  const plan = loadPlan(planFile(y));
  assert.throws(() => assertRunnable(plan, selectTask(plan, "H")), PlanError);
});

// ── transitiveDependents (W1-T46 block-reasoning: does anything need this
// task to exist at all?) — A -> B -> C chain.

test("transitiveDependents: C (a leaf, nothing depends on it) is EMPTY — self-contained", () => {
  const plan = loadPlan(planFile(YAML));
  assert.deepEqual(transitiveDependents(plan, "C"), new Set());
});

test("transitiveDependents: B's only direct dependent is C", () => {
  const plan = loadPlan(planFile(YAML));
  assert.deepEqual(transitiveDependents(plan, "B"), new Set(["C"]));
});

test("transitiveDependents: A's transitive dependents are B AND C (through the chain)", () => {
  const plan = loadPlan(planFile(YAML));
  assert.deepEqual(transitiveDependents(plan, "A"), new Set(["B", "C"]));
});

test("transitiveDependents: an id with no declared tasks depending on it at all (unknown/isolated) is EMPTY", () => {
  const plan = loadPlan(planFile(YAML));
  assert.deepEqual(transitiveDependents(plan, "NOPE"), new Set());
});

test("the real plan/tasks.yaml loads; W1-T1 has no deps; W1-T1B gates the rest", () => {
  const plan = loadPlan(join(process.cwd(), "plan", "tasks.yaml"));
  assert.deepEqual(selectTask(plan, "W1-T1").depends_on, []);
  assert.deepEqual(selectTask(plan, "W1-T1B").depends_on, ["W1-T1"]);
  // Every later task depends on the CI gate (self-hosting safety).
  assert.ok(selectTask(plan, "W1-T2").depends_on.includes("W1-T1B"));
});

// ── W1-T166: holdout acceptance criteria ────────────────────────────────────

const YAML_WITH_HOLDOUT = `
- id: H
  title: has a holdout criterion
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: queued
  attempts: 0
  acceptance:
    - claim: "the ordinary criterion is visible"
      proof: "grep: ORDINARY_MARKER in src/x.ts"
    - claim: "HOLDOUT-SECRET-CLAIM-never-shown"
      proof: "HOLDOUT-SECRET-PROOF-never-shown"
      holdout: true
`;

test("a task's acceptance criteria carry `holdout: true` through YAML parsing unchanged", () => {
  const plan = loadPlan(planFile(YAML_WITH_HOLDOUT));
  const criteria = selectTask(plan, "H").acceptance ?? [];
  assert.equal(criteria.length, 2);
  assert.equal(criteria[0].holdout, undefined, "an ordinary criterion has no holdout flag");
  assert.equal(criteria[1].holdout, true);
});

test("visibleCriteria: filters out every holdout:true entry, keeping ordinary ones — the single choke point every worker-facing prompt assembler routes through", () => {
  const plan = loadPlan(planFile(YAML_WITH_HOLDOUT));
  const criteria = selectTask(plan, "H").acceptance ?? [];
  const visible = visibleCriteria(criteria);
  assert.deepEqual(
    visible.map((c) => c.claim),
    ["the ordinary criterion is visible"],
  );
});

test("visibleCriteria: a task with no declared criteria at all yields [] (never throws)", () => {
  assert.deepEqual(visibleCriteria([]), []);
});

test("visibleCriteria: generic over anything carrying an optional `holdout` flag (e.g. lib/review.ts's CriterionVerdict, not just AcceptanceCriterion)", () => {
  const verdictLike = [
    { claim: "a", met: true, holdout: false },
    { claim: "b", met: false, holdout: true },
  ];
  assert.deepEqual(
    visibleCriteria(verdictLike).map((c) => c.claim),
    ["a"],
  );
});

// ── W1-T4419: `kind: guard` acceptance criteria ─────────────────────────────

test("a criterion's `kind: guard` carries through YAML parsing unchanged; an ordinary criterion's `kind` is undefined", () => {
  const plan = loadPlan(
    planFile(`
- id: G
  title: has a guard criterion alongside an ordinary one
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: queued
  attempts: 0
  acceptance:
    - claim: "the new behaviour exists"
      proof: "grep: NEW_MARKER in src/x.ts"
    - claim: "the old behaviour still works"
      proof: "grep: OLD_MARKER in src/x.ts"
      kind: guard
`),
  );
  const criteria = selectTask(plan, "G").acceptance ?? [];
  assert.equal(criteria.length, 2);
  assert.equal(criteria[0].kind, undefined, "an ordinary criterion has no kind — it defaults to 'change'");
  assert.equal(criteria[1].kind, "guard");
});

test("an invalid `kind` value is refused at parse time, naming the field", () => {
  assert.throws(
    () =>
      loadPlan(
        planFile(`
- id: BADKIND
  title: an invalid kind value
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: queued
  attempts: 0
  acceptance:
    - claim: "something"
      proof: "grep: X in src/x.ts"
      kind: regression
`),
      ),
    (err: unknown) => err instanceof PlanError && /'kind' must be change\|guard/.test((err as Error).message),
  );
});

test("a task whose acceptance criteria are ALL `kind: guard` is refused — nothing discriminates its own work", () => {
  assert.throws(
    () =>
      loadPlan(
        planFile(`
- id: ALLGUARD
  title: every criterion is a guard
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: queued
  attempts: 0
  acceptance:
    - claim: "old behaviour A still works"
      proof: "grep: A_MARKER in src/x.ts"
      kind: guard
    - claim: "old behaviour B still works"
      proof: "grep: B_MARKER in src/x.ts"
      kind: guard
`),
      ),
    (err: unknown) => err instanceof PlanError && /every acceptance criterion is 'kind: guard'/.test((err as Error).message),
  );
});

test("a task with a mix of `kind: guard` and an ordinary (default-kind) criterion loads cleanly — something still discriminates", () => {
  const plan = loadPlan(
    planFile(`
- id: MIXED
  title: one guard, one ordinary
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: queued
  attempts: 0
  acceptance:
    - claim: "old behaviour still works"
      proof: "grep: OLD_MARKER in src/x.ts"
      kind: guard
    - claim: "new behaviour exists"
      proof: "grep: NEW_MARKER in src/x.ts"
`),
  );
  assert.equal((selectTask(plan, "MIXED").acceptance ?? []).length, 2);
});
