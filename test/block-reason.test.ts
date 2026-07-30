import assert from "node:assert/strict";
import { test } from "node:test";
import { INITIAL_RETRY_STATE, MAX_TRANSIENT_RETRIES, type RetryState } from "../src/lib/classify.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";
import { reasonAboutBlock, verdictFailureClass } from "../src/lib/block-reason.js";

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

test("reasonAboutBlock: a strike on B (C transitively needs it) is GENUINE BLOCKER, naming C", () => {
  const d = reasonAboutBlock(plan(), "B", "blocked_review", INITIAL_RETRY_STATE);
  assert.deepEqual(d, { kind: "genuine_blocker", dependents: ["C"] });
});

test("reasonAboutBlock: a strike on A (both B and C transitively need it) names BOTH dependents, sorted", () => {
  const d = reasonAboutBlock(plan(), "A", "failed", INITIAL_RETRY_STATE);
  assert.deepEqual(d, { kind: "genuine_blocker", dependents: ["B", "C"] });
});

// ── W1-T174: drain/sweep parity — a FIXABLE genuine blocker routes to the
// fix-rung disposition instead of the truly-stuck halt+escalate one. ───────

test("reasonAboutBlock: the #383/DAEMON-1784570007163 FALSIFIER — a blocked_ci strike on B (C transitively needs it) is FIXABLE, not a truly-stuck genuine blocker", () => {
  const d = reasonAboutBlock(plan(), "B", "blocked_ci", INITIAL_RETRY_STATE);
  assert.deepEqual(d, { kind: "fixable_blocker", dependents: ["C"] });
});

test("reasonAboutBlock: a blocked_review strike WITH a nameable unmet criterion (evidence) is also FIXABLE — same sweep signal, review side", () => {
  const d = reasonAboutBlock(plan(), "B", "blocked_review", INITIAL_RETRY_STATE, {
    unmetCriteria: ["the changelog entry is missing"],
  });
  assert.deepEqual(d, { kind: "fixable_blocker", dependents: ["C"] });
});

test("reasonAboutBlock: a blocked_review strike with NO nameable unmet criterion stays a genuine (truly-stuck) blocker — halt narrows, it does not disappear", () => {
  const noEvidence = reasonAboutBlock(plan(), "B", "blocked_review", INITIAL_RETRY_STATE);
  assert.deepEqual(noEvidence, { kind: "genuine_blocker", dependents: ["C"] });

  const emptyEvidence = reasonAboutBlock(plan(), "B", "blocked_review", INITIAL_RETRY_STATE, { unmetCriteria: [] });
  assert.deepEqual(emptyEvidence, { kind: "genuine_blocker", dependents: ["C"] });
});

test("reasonAboutBlock: a blocked_ci strike on a LEAF (zero transitive dependents) is still INDEPENDENT-FAILURE — fixability never overrides the DAG check", () => {
  const d = reasonAboutBlock(plan(), "C", "blocked_ci", INITIAL_RETRY_STATE);
  assert.deepEqual(d, { kind: "independent_failure", dependents: [] });
});
