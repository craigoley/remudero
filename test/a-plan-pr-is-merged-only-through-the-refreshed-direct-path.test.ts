// W1-T5615 — at 00:16:53Z on 2026-10-04 the review lane armed #8996 (judge) and #8997 (gardener)
// for GitHub auto-merge, 3 ms apart, both cut from one base. GitHub merged #8996 at 00:18 and then
// #8997, now behind it, at 00:22 as-is: nothing re-linted the plan that actually landed, and main
// carried a duplicate `priority:` key in one shard until #9005 repaired it. W1-T5472's refresh of
// a behind plan PR lives only on the direct-merge path, which an arm that SUCCEEDS never reaches.
// So a plan PR is never armed: it takes the refreshed direct path when green, or is held unarmed.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  armAutoMergeAtOpen,
  armOutcomeReason,
  attemptArm,
  logArmAttribution,
  type ArmDeps,
} from "../src/lib/arm-auto-merge.js";

type PlanTouch = "touched" | "untouched" | "unreadable";
interface Facts {
  mergeable?: string;
  behindBy?: number;
  mergeableState?: string;
}

const PR = "https://github.com/craigoley/remudero/pull/8997";
const HEAD = "8997899789978997899789978997899789978997";
const CLEAN = "Pull request is in clean status";

function harness(opts: {
  planTouch?: () => PlanTouch;
  facts?: () => Facts;
  armAuto?: () => void;
  withUpdateBranch?: boolean;
  mergeQueue?: boolean;
}) {
  const calls: string[] = [];
  const said: string[] = [];
  const deps: Record<string, unknown> = {
    headSha: () => HEAD,
    ledgerLines: () => [],
    armAuto: () => {
      calls.push("armAuto");
      opts.armAuto?.();
    },
    mergeDirect: () => void calls.push("mergeDirect"),
    disableAuto: () => {},
    isMerged: () => false,
    say: (msg: string) => void said.push(msg),
  };
  if (opts.facts) {
    const read = opts.facts;
    deps.readMergeFacts = () => {
      calls.push("readMergeFacts");
      return read();
    };
  }
  if (opts.withUpdateBranch !== false) {
    deps.updateBranch = () => {
      calls.push("updateBranch");
      return { ok: true };
    };
  }
  if (opts.planTouch) {
    const read = opts.planTouch;
    deps.readPlanTouch = () => {
      calls.push("readPlanTouch");
      return read();
    };
  }
  if (opts.mergeQueue !== undefined) {
    const queue = opts.mergeQueue;
    deps.mergeQueue = () => queue;
    deps.enqueue = () => void calls.push("enqueue");
  }
  return { deps: deps as unknown as ArmDeps, calls, said };
}

const pending: Facts = { mergeable: "MERGEABLE", behindBy: 0, mergeableState: "blocked" };

test("a plan PR with checks pending is held unarmed: --auto is never called and nothing merges", () => {
  const { deps, calls, said } = harness({ planTouch: () => "touched", facts: () => pending });

  const result = attemptArm(PR, deps, HEAD);

  assert.equal(result.outcome, "plan-pr-held");
  assert.ok(!calls.includes("armAuto"), "GitHub would merge it later as-is, behind whatever lands first");
  assert.ok(!calls.includes("mergeDirect") && !calls.includes("updateBranch"));
  assert.equal(result.directMergePreflight?.planTouch, "touched");
  assert.equal(result.directMergePreflight?.mergeableState, "blocked");
  assert.equal(result.directMergePreflight?.remedy, "retry-later");
  assert.match(said.join("\n"), /automerge\.plan_pr_held \(W1-T5615\): plan_touch=touched mergeable_state=blocked/);
});

test("an unreadable file list, or a reader that throws, is held like a plan PR", () => {
  const unreadable = harness({ planTouch: () => "unreadable", facts: () => pending });
  assert.equal(attemptArm(PR, unreadable.deps, HEAD).outcome, "plan-pr-held");
  assert.ok(!unreadable.calls.includes("armAuto"));

  const throwing = harness({
    planTouch: () => {
      throw new Error("rest files read refused");
    },
    facts: () => pending,
  });
  const result = attemptArm(PR, throwing.deps, HEAD);
  assert.equal(result.outcome, "plan-pr-held");
  assert.equal(result.directMergePreflight?.planTouch, "unreadable");
  assert.ok(!throwing.calls.includes("armAuto"));
  assert.match(throwing.said.join("\n"), /plan_touch_unreadable \(W1-T5472\): rest files read refused/);
});

test("a green plan PR that is behind is updated, never merged as-is and never armed", () => {
  // GitHub reports `behind` when the base requires an up-to-date branch.
  const strict = harness({ planTouch: () => "touched", facts: () => ({ mergeable: "MERGEABLE", behindBy: 3, mergeableState: "behind" }) });
  const strictResult = attemptArm(PR, strict.deps, HEAD);
  assert.equal(strictResult.outcome, "direct-merge-updated");
  assert.deepEqual(strict.calls.filter((c) => c !== "readMergeFacts"), ["readPlanTouch", "updateBranch"]);

  // Without that requirement a behind PR reads `clean`; W1-T5472 still updates a plan PR first.
  const loose = harness({ planTouch: () => "touched", facts: () => ({ mergeable: "MERGEABLE", behindBy: 2, mergeableState: "clean" }) });
  const looseResult = attemptArm(PR, loose.deps, HEAD);
  assert.equal(looseResult.outcome, "direct-merge-updated");
  assert.equal(looseResult.directMergePreflight?.reason, "plan_pr_behind");
  assert.deepEqual(loose.calls.filter((c) => c !== "readMergeFacts"), ["readPlanTouch", "updateBranch"], "the file list is read once per attempt");
});

test("a green plan PR that is current is merged directly, never armed", () => {
  const { deps, calls } = harness({ planTouch: () => "touched", facts: () => ({ mergeable: "MERGEABLE", behindBy: 0, mergeableState: "clean" }) });

  const result = attemptArm(PR, deps, HEAD);

  assert.equal(result.outcome, "direct-merged");
  assert.ok(!calls.includes("armAuto"));
  assert.ok(calls.includes("mergeDirect"));
  assert.ok(!calls.includes("updateBranch"));
});

test("a plan PR whose merge facts cannot be read, or with no update-branch seam, is held", () => {
  const throwing = harness({
    planTouch: () => "touched",
    facts: () => {
      throw new Error("HTTP 502 on pulls read");
    },
  });
  const thrown = attemptArm(PR, throwing.deps, HEAD);
  assert.equal(thrown.outcome, "plan-pr-held");
  assert.equal(thrown.directMergePreflight?.error, "HTTP 502 on pulls read");
  assert.match(throwing.said.join("\n"), /plan_pr_held .*HTTP 502 on pulls read/);
  assert.ok(!throwing.calls.includes("armAuto") && !throwing.calls.includes("mergeDirect"));

  const noFacts = harness({ planTouch: () => "touched" });
  assert.equal(attemptArm(PR, noFacts.deps, HEAD).outcome, "plan-pr-held");
  assert.ok(!noFacts.calls.includes("armAuto"));

  // `behind` with no way to update would otherwise reach the preflight's no-seam pass-through.
  const noUpdate = harness({
    planTouch: () => "touched",
    facts: () => ({ mergeable: "MERGEABLE", behindBy: 3, mergeableState: "behind" }),
    withUpdateBranch: false,
  });
  assert.equal(attemptArm(PR, noUpdate.deps, HEAD).outcome, "plan-pr-held");
  assert.ok(!noUpdate.calls.includes("mergeDirect") && !noUpdate.calls.includes("armAuto"));
});

test("a PR touching no plan path is armed exactly as before, with no merge-facts read", () => {
  const untouched = harness({ planTouch: () => "untouched", facts: () => pending });
  assert.equal(attemptArm(PR, untouched.deps, HEAD).outcome, "armed");
  assert.deepEqual(untouched.calls, ["readPlanTouch", "armAuto"]);

  // No reader wired: the pre-W1-T5615 behaviour, byte for byte.
  const unwired = harness({ facts: () => pending });
  assert.equal(attemptArm(PR, unwired.deps, HEAD).outcome, "armed");
  assert.deepEqual(unwired.calls, ["armAuto"]);

  // And its clean-status fallback still merges directly.
  const clean = harness({
    planTouch: () => "untouched",
    facts: () => ({ mergeable: "MERGEABLE", behindBy: 0, mergeableState: "clean" }),
    armAuto: () => {
      throw Object.assign(new Error("boom"), { stderr: CLEAN });
    },
  });
  assert.equal(attemptArm(PR, clean.deps, HEAD).outcome, "direct-merged");
  assert.deepEqual(clean.calls, ["readPlanTouch", "armAuto", "readMergeFacts", "mergeDirect"]);
});

test("a merge-queue branch keeps its queue arm: the queue re-tests the merged result", () => {
  const { deps, calls } = harness({ planTouch: () => "touched", facts: () => pending, mergeQueue: true });
  assert.equal(attemptArm(PR, deps, HEAD).outcome, "armed");
  assert.deepEqual(calls, ["armAuto"]);
});

test("an arm GitHub already holds (W1-T5492's armed-idle fallback) drains through the old direct path", () => {
  const { deps, calls } = harness({
    planTouch: () => "touched",
    facts: () => ({ mergeable: "MERGEABLE", behindBy: 2, mergeableState: "blocked" }),
    armAuto: () => {
      throw Object.assign(new Error("boom"), { stderr: CLEAN });
    },
  });
  const result = attemptArm(PR, { ...deps, armStanding: true }, HEAD);
  assert.equal(result.outcome, "direct-merge-updated", "the preflight still refreshes a behind plan PR");
  assert.deepEqual(calls, ["armAuto", "readMergeFacts", "readPlanTouch", "updateBranch"]);
});

test("the at-open arm holds a plan PR too", () => {
  const { deps, calls } = harness({ planTouch: () => "touched", facts: () => pending });
  assert.equal(armAutoMergeAtOpen(PR, deps), "plan-pr-held");
  assert.ok(!calls.includes("armAuto"));
});

test("a held plan PR is ledgered on automerge.plan_pr_held and reads as not armed", () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const result = attemptArm(PR, harness({ planTouch: () => "touched", facts: () => pending }).deps, HEAD);
  logArmAttribution((step, extra) => void rows.push({ step, extra }), result.outcome, PR, "W1-T5557", "review", { reason: "r" }, undefined, result.directMergePreflight);

  assert.deepEqual(rows.map((r) => r.step), ["automerge.arm_skipped", "automerge.plan_pr_held"]);
  const held = rows[1].extra;
  assert.equal(held?.plan_touch, "touched");
  assert.equal(held?.mergeable_state, "blocked");
  assert.equal(held?.pr_number, 8997);
  assert.equal(held?.lane, "review");
  assert.match(armOutcomeReason("plan-pr-held", "verdict is a full PASS"), /plan PR .*never armed for GitHub auto-merge/);
});
