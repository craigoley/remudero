import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  attemptArm,
  attemptArmAsync,
  fixRebaseMergeFactsFromRest,
  logArmAttribution,
  type ArmDeps,
  type ArmAttemptResult,
} from "../src/lib/arm-auto-merge.js";

const PR = "https://github.com/craigoley/remudero/pull/9138";
const HEAD = "head5733";
const NOW = Date.parse("2026-10-06T12:00:00Z");
const UNKNOWN = { mergeable: "UNKNOWN", mergeableState: "unknown", behindBy: 0 };
const CLEAN = { mergeable: "MERGEABLE", mergeableState: "clean", behindBy: 0 };

function heldRow(ageMs: number, extra: Record<string, unknown> = {}) {
  return {
    ts: new Date(NOW - ageMs).toISOString(), step: "automerge.plan_pr_held", pr_url: PR,
    prior_head_sha: HEAD, remedy: "mergeability-unknown", ...extra,
  };
}

function harness(opts: {
  facts?: ArmDeps["readMergeFacts"];
  ledger?: Array<Record<string, unknown>>;
  head?: ArmDeps["headSha"];
} = {}) {
  const calls: string[] = [];
  const said: string[] = [];
  const sleeps: number[] = [];
  const deps: ArmDeps = {
    headSha: opts.head ?? (() => HEAD), ledgerLines: () => opts.ledger ?? [],
    readPlanTouch: () => "touched",
    readMergeFacts: () => { calls.push("read"); return (opts.facts ?? (() => UNKNOWN))(PR); },
    sleepSync: (ms) => { calls.push("sleep"); sleeps.push(ms); },
    armAuto: () => { calls.push("arm"); }, disableAuto: () => {},
    mergeDirect: () => { calls.push("merge"); }, isMerged: () => false,
    updateBranch: () => { calls.push("update"); return { ok: true }; },
    say: (line) => { said.push(line); },
  };
  return { deps, calls, said, sleeps };
}

function attribution(result: ArmAttemptResult) {
  const rows: Array<Record<string, unknown>> = [];
  logArmAttribution((step, extra) => { rows.push({ step, ...extra }); },
    result.outcome, PR, "W1-T5733", "review", {}, undefined, result.directMergePreflight);
  return rows;
}

describe("test/a-plan-pr-on-unknown-mergeability-is-re-read-then-merged-or-escalated.test.ts", () => {
  test("unknown then clean merges in the same attempt through a sleeping re-read", () => {
    let reads = 0;
    const h = harness({ facts: () => ++reads === 1 ? UNKNOWN : CLEAN });
    assert.equal(attemptArm(PR, h.deps, HEAD).outcome, "direct-merged");
    assert.deepEqual(h.calls, ["read", "sleep", "read", "merge"]);
    assert.deepEqual(h.sleeps, [2_000]);
  });

  test("a null REST mergeability reading is re-read even when its state says clean", () => {
    let reads = 0;
    const h = harness({ facts: () => fixRebaseMergeFactsFromRest("craigoley", "remudero", 9138,
      (args) => args[1]?.includes("/compare/") ? { behind_by: 0 } : {
        mergeable: ++reads > 1 ? true : null, mergeable_state: "clean",
        base: { ref: "main" }, head: { sha: HEAD },
      }) });
    assert.equal(attemptArm(PR, h.deps, HEAD).outcome, "direct-merged");
    assert.deepEqual(h.calls, ["read", "sleep", "read", "merge"]);
  });

  test("unknown then behind uses the existing refresh path", () => {
    let reads = 0;
    const h = harness({ facts: () => ++reads === 1 ? UNKNOWN : { ...CLEAN, mergeableState: "behind", behindBy: 2 } });
    assert.equal(attemptArm(PR, h.deps, HEAD).outcome, "direct-merge-updated");
    assert.deepEqual(h.calls, ["read", "sleep", "read", "update"]);
  });

  test("persistent unknown is bounded and ledgered with its head and distinct remedy", () => {
    const h = harness();
    const result = attemptArm(PR, h.deps);
    assert.equal(result.outcome, "plan-pr-held");
    assert.equal(result.directMergePreflight?.remedy, "mergeability-unknown");
    assert.equal(result.directMergePreflight?.priorHeadSha, HEAD);
    assert.deepEqual(h.calls, ["read", "sleep", "read", "sleep", "read", "sleep", "read"]);
    const row = attribution(result).find((r) => r.step === "automerge.plan_pr_held");
    assert.equal(row?.remedy, "mergeability-unknown");
    assert.equal(row?.prior_head_sha, HEAD);
    assert.equal(row?.mergeability_unknown_elapsed_ms, 0);
  });

  test("an unknown head held for ten minutes escalates to the operator instead of being held again", (t) => {
    t.mock.method(Date, "now", () => NOW);
    const h = harness({ ledger: [heldRow(600_000)] });
    const result = attemptArm(PR, h.deps, HEAD);
    assert.equal(result.outcome, "direct-merge-preflight-refused");
    assert.equal(result.directMergePreflight?.remedy, "operator");
    assert.equal(result.directMergePreflight?.reason, "plan_pr_mergeability_unknown_bound");
    const rows = attribution(result);
    const escalated = rows.find((r) => r.step === "automerge.plan_pr_mergeability_unknown_escalated");
    assert.equal(escalated?.prior_head_sha, HEAD);
    assert.equal(escalated?.mergeability_unknown_elapsed_ms, 600_000);
    assert.ok(!rows.some((r) => r.step === "automerge.plan_pr_held"));
    assert.match(h.said.join("\n"), /head5733.*elapsed_ms=600000.*operator/);
    assert.ok(!h.calls.some((c) => ["arm", "merge", "update"].includes(c)));
  });

  test("the earliest matching held row determines age and one millisecond under the bound still holds", (t) => {
    t.mock.method(Date, "now", () => NOW);
    const h = harness({ ledger: [heldRow(1), heldRow(599_999), heldRow(200)] });
    const result = attemptArm(PR, h.deps, HEAD);
    assert.equal(result.outcome, "plan-pr-held");
    assert.equal(attribution(result)[1]?.mergeability_unknown_elapsed_ms, 599_999);
  });

  test("another PR, another head, another remedy, invalid or future timestamps do not age this hold", (t) => {
    t.mock.method(Date, "now", () => NOW);
    const h = harness({ ledger: [
      heldRow(900_000, { pr_url: `${PR}0` }), heldRow(900_000, { prior_head_sha: "old" }),
      heldRow(900_000, { remedy: "retry-later" }), heldRow(900_000, { step: "automerge.arm_skipped" }),
      heldRow(900_000, { ts: "bad" }), heldRow(900_000, { ts: undefined }), heldRow(-1),
    ] });
    const result = attemptArm(PR, h.deps, HEAD);
    assert.equal(result.outcome, "plan-pr-held");
    assert.equal(result.directMergePreflight?.remedy, "mergeability-unknown");
    assert.equal(attribution(result)[1]?.mergeability_unknown_elapsed_ms, 0);
  });

  test("a re-read that resolves to blocked stops retrying and keeps the ordinary hold", () => {
    let reads = 0;
    const h = harness({ facts: () => ++reads === 1 ? UNKNOWN : { ...CLEAN, mergeableState: "blocked" } });
    const result = attemptArm(PR, h.deps, HEAD);
    assert.equal(result.outcome, "plan-pr-held");
    assert.equal(result.directMergePreflight?.remedy, "retry-later");
    assert.deepEqual(h.calls, ["read", "sleep", "read"]);
  });

  test("a failed re-read retains its error and cannot merge or escalate from stale unknown facts", () => {
    let reads = 0;
    const h = harness({ ledger: [heldRow(900_000)], facts: () => {
      if (++reads > 1) throw new Error("REST re-read failed");
      return UNKNOWN;
    } });
    const result = attemptArm(PR, h.deps, HEAD);
    assert.equal(result.outcome, "plan-pr-held");
    assert.equal(result.directMergePreflight?.remedy, "retry-later");
    assert.equal(result.directMergePreflight?.error, "REST re-read failed");
    assert.deepEqual(h.calls, ["read", "sleep", "read"]);
  });

  test("an unreadable head preserves the hold and names the head-read failure", () => {
    const h = harness({ head: () => { throw new Error("head read failed"); } });
    const result = attemptArm(PR, h.deps);
    assert.equal(result.outcome, "plan-pr-held");
    assert.equal(result.directMergePreflight?.error, "head read failed");
    assert.equal(result.directMergePreflight?.remedy, "mergeability-unknown");
  });

  test("a known re-read merges even when earlier unknown holds exceeded the bound", (t) => {
    t.mock.method(Date, "now", () => NOW);
    let reads = 0;
    const h = harness({ ledger: [heldRow(900_000)], facts: () => ++reads === 1 ? UNKNOWN : CLEAN });
    assert.equal(attemptArm(PR, h.deps, HEAD).outcome, "direct-merged");
  });

  test("the async driver uses the same bounded plan re-read", async () => {
    let reads = 0;
    const h = harness({ facts: () => ++reads === 1 ? UNKNOWN : CLEAN });
    assert.equal((await attemptArmAsync(PR, h.deps, HEAD)).outcome, "direct-merged");
    assert.deepEqual(h.calls, ["read", "sleep", "read", "merge"]);
  });
});
