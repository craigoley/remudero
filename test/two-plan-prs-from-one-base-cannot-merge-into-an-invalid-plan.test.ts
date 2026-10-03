// W1-T5472 — on 2026-10-03 #8872 and #8871 were opened from one base and each added a `priority:`
// line to the same shard. The arm merged #8871 two commits behind main with `mergeable_state:
// clean` (W1-T3694 merges such a PR as-is), git joined the two lines, and main carried a duplicate
// key that refused the whole plan. A behind PR touching plan/ is now updated first, so CI lints
// the tree that will actually land. Every other behind PR keeps W1-T3694's as-is merge.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as armModule from "../src/lib/arm-auto-merge.js";
import { attemptArm, logArmAttribution, realArmDeps, type ArmDeps } from "../src/lib/arm-auto-merge.js";
import { ghShim } from "./helpers/gh-shim.js";

type PlanTouch = "touched" | "untouched" | "unreadable";
type Fetch = (args: string[]) => unknown;
// Read off the namespace so this file still LOADS on a tree without the export, and fails per test.
const planTouchFromRest = (armModule as Record<string, unknown>).planTouchFromRest as (
  owner: string,
  repo: string,
  prNumber: number,
  fetch?: Fetch,
) => PlanTouch;

const PR = "https://github.com/craigoley/remudero/pull/8871";
const HEAD = "1c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff";
const CLEAN = "Pull request is in clean status";

function harness(planTouch: (() => PlanTouch) | undefined, mergeableState = "clean", behindBy = 2) {
  const calls: string[] = [];
  const said: string[] = [];
  const deps = {
    headSha: () => HEAD,
    ledgerLines: () => [],
    armAuto: () => {
      throw Object.assign(new Error("boom"), { stderr: CLEAN });
    },
    mergeDirect: () => void calls.push("mergeDirect"),
    disableAuto: () => {},
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy, mergeableState }),
    updateBranch: () => {
      calls.push("updateBranch");
      return { ok: true };
    },
    ...(planTouch ? { readPlanTouch: planTouch } : {}),
    say: (msg: string) => void said.push(msg),
  } as unknown as ArmDeps;
  return { deps, calls, said };
}

test("a plan-touching PR behind main is updated, not direct-merged, even when mergeable_state is clean", () => {
  const { deps, calls, said } = harness(() => "touched");

  const result = attemptArm(PR, deps, HEAD);

  assert.deepEqual(calls, ["updateBranch"], "the head is updated so CI re-lints the plan that will land");
  assert.equal(result.outcome, "direct-merge-updated");
  assert.equal(result.directMergePreflight?.reason, "plan_pr_behind");
  assert.equal(result.directMergePreflight?.planTouch, "touched");
  assert.match(said.join("\n"), /direct_merge_updated .*reason=plan_pr_behind plan_touch=touched/);
});

test("an unreadable file list is treated as plan-touching", () => {
  const unreadable = harness(() => "unreadable");
  assert.equal(attemptArm(PR, unreadable.deps, HEAD).outcome, "direct-merge-updated");
  assert.deepEqual(unreadable.calls, ["updateBranch"]);

  // A reader that THROWS is the same unreadable case, recorded rather than swallowed.
  const throwing = harness(() => {
    throw new Error("rest files read refused");
  });
  const result = attemptArm(PR, throwing.deps, HEAD);
  assert.deepEqual(throwing.calls, ["updateBranch"]);
  assert.equal(result.directMergePreflight?.planTouch, "unreadable");
  assert.match(throwing.said.join("\n"), /plan_touch_unreadable \(W1-T5472\): rest files read refused/);
});

test("a behind PR touching no plan path still merges as-is", () => {
  const { deps, calls } = harness(() => "untouched");

  const result = attemptArm(PR, deps, HEAD);

  assert.deepEqual(calls, ["mergeDirect"], "W1-T3694's as-is merge is unchanged for a non-plan PR");
  assert.equal(result.outcome, "direct-merged");
  assert.equal(result.directMergePreflight?.planTouch, "untouched");
  assert.equal(result.directMergePreflight?.reason, undefined);
});

test("the plan-touch read runs only where W1-T3694 would merge a behind PR as-is", () => {
  let reads = 0;
  const count = () => {
    reads += 1;
    return "touched" as const;
  };
  // Not behind at all: nothing to re-lint.
  const current = harness(count, "clean", 0);
  assert.deepEqual((attemptArm(PR, current.deps, HEAD), current.calls), ["mergeDirect"]);
  // GitHub already reports `behind`: the update happens anyway, with no extra REST read.
  const strict = harness(count, "behind");
  const strictResult = attemptArm(PR, strict.deps, HEAD);
  assert.deepEqual(strict.calls, ["updateBranch"]);
  assert.equal(strictResult.directMergePreflight?.reason, undefined);
  assert.equal(reads, 0);
  // No reader wired: the pre-W1-T5472 behaviour, byte for byte.
  const unwired = harness(undefined);
  assert.deepEqual((attemptArm(PR, unwired.deps, HEAD), unwired.calls), ["mergeDirect"]);
});

test("the update is ledgered on automerge.direct_merge_updated with reason plan_pr_behind", () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const result = attemptArm(PR, harness(() => "touched").deps, HEAD);
  logArmAttribution((step, extra) => void rows.push({ step, extra }), result.outcome, PR, "W1-T5431", "review", { reason: "verdict is a full PASS" }, undefined, result.directMergePreflight);

  const updated = rows.find((r) => r.step === "automerge.direct_merge_updated");
  assert.equal(updated?.extra?.reason, "plan_pr_behind");
  assert.equal(updated?.extra?.plan_touch, "touched");
  const main = rows.find((r) => r.step !== "automerge.direct_merge_updated");
  assert.equal(main?.extra?.reason, "verdict is a full PASS", "the outcome line keeps its own reason");
});

test("planTouchFromRest classifies the REST files page, and every unprovable list is unreadable", () => {
  const page = (rows: unknown): Fetch => () => rows;
  const seen: string[][] = [];
  const touched = planTouchFromRest("o", "r", 8871, (args) => {
    seen.push(args);
    return [{ filename: "src/x.ts" }, { filename: "plan/tasks.d/w1-t5431-selector-shadow-miss.yaml" }];
  });
  assert.equal(touched, "touched");
  assert.deepEqual(seen, [["api", "repos/o/r/pulls/8871/files?per_page=100"]]);
  assert.equal(planTouchFromRest("o", "r", 1, page([{ filename: "plan.md", previous_filename: "plan/old.yaml" }])), "touched", "a rename out of plan/ counts");
  assert.equal(planTouchFromRest("o", "r", 1, page([{ filename: "src/plan/x.ts" }, null])), "untouched");
  assert.equal(planTouchFromRest("o", "r", 1, page([])), "unreadable", "an empty list proves nothing");
  assert.equal(planTouchFromRest("o", "r", 1, page({ message: "Not Found" })), "unreadable");
  const fullPage = Array.from({ length: 100 }, (_, i) => ({ filename: `src/f${i}.ts` }));
  assert.equal(planTouchFromRest("o", "r", 1, page(fullPage)), "unreadable", "a full page may hide a plan path past it");
  assert.equal(
    planTouchFromRest("o", "r", 1, () => {
      throw new Error("HTTP 502");
    }),
    "unreadable",
  );
});

test("realArmDeps().readPlanTouch reads the PR files page through gh, and refuses an unaddressable URL", () => {
  const shim = ghShim([{ when: "pulls/8871/files", stdout: '[{"filename":"plan/tasks.d/a.yaml"}]' }], { kind: "w1t5472" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  try {
    const real = realArmDeps() as ArmDeps & { readPlanTouch?: (prUrl: string) => PlanTouch };
    assert.equal(real.readPlanTouch?.(PR), "touched");
    assert.ok(shim.calls().some((c) => c.includes("repos/craigoley/remudero/pulls/8871/files")));
    assert.equal(real.readPlanTouch?.("not-a-pr-url"), "unreadable");
  } finally {
    process.env.PATH = oldPath;
  }
});
