import assert from "node:assert/strict";
import { test } from "node:test";
import { foldRepositoryFlowHistory, type FlowHistory } from "../src/lib/repository-flow-history.js";

const at = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
const head = "a".repeat(40), next = "b".repeat(40);
function history(): FlowHistory {
  return { version: 1, repository: "fixture/repo", observedAt: at(16), publications: [], snapshots: [], inventories: [], costs: [] };
}
function snapshot(pr: number, state = "SUCCESS", sha = head, day = 15) {
  return { pr, head: sha, at: at(day, 1), generation: `checks-${day}-${pr}-${state}`, complete: true,
    policy: { id: "policy-one", required: ["ci"], accepted: ["SUCCESS"] },
    checks: [{ name: "ci", state, attempt: 1, startedAt: at(day), completedAt: at(day, 1) }], round: null };
}

test("W1-T8707: first-pass quality requires complete initial-head evidence", () => {
  const h = history();
  h.publications = [1, 2, 3, 4].map(pr => ({ pr, head, at: at(15), run: `run-${pr}`, task: `W1-T${pr}` }));
  h.snapshots = [snapshot(1), { ...snapshot(2), complete: false }, snapshot(3, "CANCELLED"), snapshot(4, "SUCCESS", next), snapshot(5)];
  const first = foldRepositoryFlowHistory(h, at(16)).windows[0]!.firstPass;
  assert.deepEqual({ cohort: first.cohort, eligible: first.eligible, passing: first.passing, unknown: first.unknown },
    { cohort: 5, eligible: 2, passing: 1, unknown: 3 });
  assert.equal(first.states.CANCELLED, 1);
  assert.equal(first.states.SUCCESS, 1);
  h.snapshots[0]!.policy.id = "policy-two";
  h.snapshots.push({ ...snapshot(1, "FAILURE"), at: at(15, 2) });
  assert.equal(foldRepositoryFlowHistory(h, at(16)).windows[0]!.firstPass.unknown, 4);
});

test("W1-T8707: repair recovery uses verified head clocks and open censoring", () => {
  const h = history();
  h.snapshots = [snapshot(1, "FAILURE"), snapshot(1, "FAILURE"),
    { ...snapshot(1, "SUCCESS", next, 16), round: "repair-1" }, snapshot(2, "FAILURE"),
    { ...snapshot(2, "SUCCESS", next, 16), complete: false }, snapshot(3, "PENDING")];
  const repair = foldRepositoryFlowHistory(h, at(16, 2)).windows[0]!.repairLatency;
  assert.equal(repair.samples, 1);
  assert.equal(repair.censored, 1);
  assert.equal(repair.p50Ms, 86400000);
  assert.equal(repair.p90Ms, 86400000);
  assert.deepEqual(repair.episodes.map(e => [e.pr, e.round, e.recoveredAt]), [[1, "repair-1", at(16, 1)], [2, null, null]]);
  h.snapshots[2]!.checks[0]!.completedAt = at(14);
  assert.equal(foldRepositoryFlowHistory(h, at(16, 2)).windows[0]!.repairLatency.samples, 0);
});

test("W1-T8707: delivered PR efficiency refuses incompatible cost cohorts", () => {
  const h = history();
  h.publications = [{ pr: 1, head, at: at(1), run: "one", task: "W1-T1" },
    { pr: 2, head, at: at(15), run: "shared", task: "W1-T2" },
    { pr: 3, head, at: at(15), run: "shared", task: "W1-T2" }];
  h.costs = [{ identity: "one", at: at(1), run: "one", task: "W1-T1", cash: 0, modeled: null, tokens: null },
    { identity: "shared", at: at(15), run: "shared", task: "W1-T2", cash: 90, modeled: null, tokens: 100 },
    { identity: "unpriced", at: at(15), run: "one", task: "W1-T1", cash: null, modeled: null, tokens: null }];
  const delivered = [{ pr: 1, at: at(15) }, { pr: 2, at: at(15) }];
  const result = foldRepositoryFlowHistory(h, at(16), delivered).windows[0]!.efficiency;
  assert.equal(result.deliveredPrs, 2);
  assert.equal(result.pricedSubtotalUsd, 0);
  assert.equal(result.priced, 1);
  assert.equal(result.unpriced, 1);
  assert.equal(result.unlinked, 1);
  assert.equal(result.totalUsd, null);
  assert.equal(result.operatorEffortMs, null);
});
