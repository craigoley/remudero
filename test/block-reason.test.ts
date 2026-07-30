import assert from "node:assert/strict";
import { test } from "node:test";
import { INITIAL_RETRY_STATE, MAX_STRIKES, MAX_TRANSIENT_RETRIES, type RetryState } from "../src/lib/classify.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";
import { reasonAboutBlock, verdictFailureClass, verdictIsFixable } from "../src/lib/block-reason.js";

// A -> B -> C (chain); D independent (no dependents at all, no dependencies).
const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: B
  title: b
  repo: remudero
  type: implement
  depends_on: [A]
  status: queued
- id: C
  title: c
  repo: remudero
  type: implement
  depends_on: [B]
  status: queued
- id: D
  title: d
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function plan(): Plan {
  return loadPlanFromYaml(YAML, "fixture");
}

// ── verdictFailureClass: blocked_transient is the ONLY transient verdict ───

test("verdictFailureClass: blocked_transient classifies transient", () => {
  assert.equal(verdictFailureClass("blocked_transient"), "transient");
});

test("verdictFailureClass: every other non-merged verdict classifies strike (fail-closed)", () => {
  const verdicts = [
    "blocked",
    "blocked_ci",
    "blocked_review",
    "blocked_budget",
    "blocked_containment",
    "blocked_isolation",
    "blocked_inflight",
    "blocked_git_fetch",
    "blocked_illformed",
    "no_pr",
    "pr_attribution_failed",
    "failed",
  ] as const;
  for (const v of verdicts) assert.equal(verdictFailureClass(v), "strike", v);
});

// ── acceptance #1: TRANSIENT retries, no strike ─────────────────────────────

test("reasonAboutBlock: a first blocked_transient retries (no strike), bumping transientRetries", () => {
  const d = reasonAboutBlock(plan(), "D", "blocked_transient", INITIAL_RETRY_STATE);
  assert.equal(d.kind, "retry_transient");
  if (d.kind === "retry_transient") {
    assert.equal(d.state.transientRetries, 1);
    assert.equal(d.state.strikes, 0, "a transient never touches strikes");
  }
});

test("reasonAboutBlock: transient retries are BOUNDED — exhausting MAX_TRANSIENT_RETRIES falls through to DAG classification", () => {
  let state: RetryState = INITIAL_RETRY_STATE;
  for (let i = 0; i < MAX_TRANSIENT_RETRIES; i++) {
    const d = reasonAboutBlock(plan(), "D", "blocked_transient", state);
    assert.equal(d.kind, "retry_transient", `attempt ${i + 1}/${MAX_TRANSIENT_RETRIES}`);
    if (d.kind === "retry_transient") state = d.state;
  }
  // One more blocked_transient exhausts the bound — no longer safe to assume
  // transience, so it reclassifies via the DAG (D is a leaf: independent).
  const exhausted = reasonAboutBlock(plan(), "D", "blocked_transient", state);
  assert.equal(exhausted.kind, "independent_failure");
});

// ── acceptance #3: INDEPENDENT-FAILURE — a self-contained failure (zero
// transitive dependents) skips ONLY itself, never the rest of the plan ─────

test("reasonAboutBlock: a strike on a task with ZERO transitive dependents is INDEPENDENT-FAILURE", () => {
  const d = reasonAboutBlock(plan(), "D", "blocked_review", INITIAL_RETRY_STATE);
  assert.deepEqual(d, { kind: "independent_failure", dependents: [] });
});

test("reasonAboutBlock: a strike on C (a leaf of the chain, nothing depends on IT) is also INDEPENDENT-FAILURE", () => {
  const d = reasonAboutBlock(plan(), "C", "blocked_ci", INITIAL_RETRY_STATE);
  assert.deepEqual(d, { kind: "independent_failure", dependents: [] });
});

// ── acceptance #2: GENUINE BLOCKER — one or more transitive dependents ─────
// never silently skipped.

test("reasonAboutBlock: an UNFIXABLE strike on B (C transitively needs it) is GENUINE BLOCKER, naming C", () => {
  const d = reasonAboutBlock(plan(), "B", "blocked_budget", INITIAL_RETRY_STATE);
  assert.deepEqual(d, { kind: "genuine_blocker", dependents: ["C"] });
});

test("reasonAboutBlock: a strike on A (both B and C transitively need it) names BOTH dependents, sorted", () => {
  const d = reasonAboutBlock(plan(), "A", "failed", INITIAL_RETRY_STATE);
  assert.deepEqual(d, { kind: "genuine_blocker", dependents: ["B", "C"] });
});

// ── W1-T174: drain/sweep PARITY — a FIXABLE genuine blocker routes to the
// fix rung (a bounded, strike-capped attempt), NOT straight to halt+escalate.
// Halt+escalate NARROWS to the truly-stuck; it is never removed. ───────────

test("verdictIsFixable: blocked_ci and blocked_review are fixable — the SAME signal classes the W1-T77 sweep routes to its fix rung", () => {
  assert.equal(verdictIsFixable("blocked_ci"), true);
  assert.equal(verdictIsFixable("blocked_review"), true);
});

test("verdictIsFixable: every other non-transient verdict is NOT fixable — no nameable criterion the rung could act on", () => {
  const verdicts = [
    "blocked",
    "blocked_budget",
    "blocked_containment",
    "blocked_isolation",
    "blocked_inflight",
    "blocked_git_fetch",
    "blocked_illformed",
    "no_pr",
    "pr_attribution_failed",
    "failed",
  ] as const;
  for (const v of verdicts) assert.equal(verdictIsFixable(v), false, v);
});

test("reasonAboutBlock: a FIXABLE genuine blocker (blocked_ci — the #382 fixture's own verdict) routes to fixable_blocker, NOT straight to halt+escalate", () => {
  const d = reasonAboutBlock(plan(), "B", "blocked_ci", INITIAL_RETRY_STATE);
  assert.equal(d.kind, "fixable_blocker");
  if (d.kind === "fixable_blocker") {
    assert.deepEqual(d.dependents, ["C"]);
    assert.equal(d.state.strikes, 1, "the fix attempt consumes ONE strike of the bound");
    assert.equal(d.state.transientRetries, 0, "strikes and transient retries are independent counters");
  }
});

test("reasonAboutBlock: a FIXABLE genuine blocker (blocked_review — a nameable unmet criterion) ALSO routes to fixable_blocker", () => {
  const d = reasonAboutBlock(plan(), "B", "blocked_review", INITIAL_RETRY_STATE);
  assert.equal(d.kind, "fixable_blocker");
  if (d.kind === "fixable_blocker") assert.deepEqual(d.dependents, ["C"]);
});

test("reasonAboutBlock: fixable-blocker fix attempts are BOUNDED — exhausting the strike cap falls through to GENUINE BLOCKER (the W1-T168 anti-regression guard: it does not fix-loop forever)", () => {
  let state: RetryState = INITIAL_RETRY_STATE;
  for (let i = 0; i < MAX_STRIKES; i++) {
    const d = reasonAboutBlock(plan(), "B", "blocked_ci", state);
    assert.equal(d.kind, "fixable_blocker", `attempt ${i + 1}/${MAX_STRIKES}`);
    if (d.kind === "fixable_blocker") state = d.state;
  }
  // One more blocked_ci exhausts the strike bound — no longer safe to keep
  // attempting a fix; falls through to the SAME halt+escalate an unfixable
  // block always got, still naming the real dependents.
  const exhausted = reasonAboutBlock(plan(), "B", "blocked_ci", state);
  assert.deepEqual(exhausted, { kind: "genuine_blocker", dependents: ["C"] });
});
