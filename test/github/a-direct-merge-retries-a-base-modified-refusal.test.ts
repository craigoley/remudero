// W1-T11259 — #16577 (plan-only, already CLEAN) was refused "Base branch was modified (HTTP 405)" by the
// already-clean direct-merge fallback and sat open ~35 min: that path called mergeDirect once. It now
// reuses W1-T1280's bounded re-read-and-retry, and holds a 'Required status check "ci-gate" is expected'
// refusal for the next checks-green pass instead of failing the arm.
import assert from "node:assert/strict";
import test from "node:test";

import {
  attemptArm,
  REST_MERGE_UNSETTLED_MAX_READS,
  type ArmDeps,
} from "#src/lib/arm-auto-merge.js";

type Facts = ReturnType<NonNullable<ArmDeps["readMergeFacts"]>>;

const PR = "https://github.com/craigoley/remudero/pull/16577";
const CLEAN = "GraphQL: Pull request is in clean status (enablePullRequestAutoMerge)";
const BASE_MODIFIED = "gh: Base branch was modified. Review and try the merge again. (HTTP 405)";
const CI_GATE_EXPECTED = 'gh: Required status check "ci-gate" is expected. (HTTP 405)';

const refuse = (stderr: string) => () => {
  throw Object.assign(new Error("boom"), { stderr });
};

function scene(refusals: string[], reads: Facts[], over: Partial<Parameters<typeof attemptArm>[1]> = {}) {
  const said: string[] = [];
  const writes: number[] = [];
  const slept: number[] = [];
  let readCount = 0;
  const d = {
    armAuto: refuse(CLEAN),
    mergeDirect: () => {
      const refusal = refusals[writes.length];
      writes.push(writes.length);
      if (refusal !== undefined) refuse(refusal)();
    },
    isMerged: () => false,
    say: (m: string) => said.push(m),
    readMergeFacts: () => reads[Math.min(readCount++, reads.length - 1)],
    sleepSync: (ms: number) => slept.push(ms),
    ...over,
  } as Parameters<typeof attemptArm>[1];
  return { d, said, writes, slept, readCount: () => readCount };
}

test("a first direct merge refused Base branch was modified is re-read and retried to direct-merged", () => {
  const s = scene([BASE_MODIFIED], [{ mergeable: "MERGEABLE", behindBy: 0 }]);
  const r = attemptArm(PR, s.d);
  assert.equal(r.outcome, "direct-merged");
  assert.equal(s.writes.length, 2, "one refused write, one retried write");
  assert.ok(s.said.some((m) => m.includes("automerge.clean_status_direct_merge_retry (W1-T11259)")), JSON.stringify(s.said));
});

test("a base-modified refusal whose re-read reads CONFLICTING ends direct-merge-failed with no retry write", () => {
  const s = scene([BASE_MODIFIED], [{ mergeable: "CONFLICTING" }]);
  const r = attemptArm(PR, s.d);
  assert.equal(r.outcome, "direct-merge-failed");
  assert.equal(s.writes.length, 1);
  assert.equal(r.error, BASE_MODIFIED);
});

test("a base-modified refusal whose re-reads stay UNKNOWN stops at the retry cap, direct-merge-failed", () => {
  const s = scene([BASE_MODIFIED], [{ mergeable: "UNKNOWN" }]);
  const r = attemptArm(PR, s.d);
  assert.equal(r.outcome, "direct-merge-failed");
  assert.equal(s.readCount(), REST_MERGE_UNSETTLED_MAX_READS);
  assert.equal(s.writes.length, 1, "never retried the write while unsettled");
  assert.equal(s.slept.length, REST_MERGE_UNSETTLED_MAX_READS - 1);
});

test("a retry refused base-modified again is not retried a second time, direct-merge-failed", () => {
  const s = scene([BASE_MODIFIED, BASE_MODIFIED], [{ mergeable: "MERGEABLE", behindBy: 0 }]);
  const r = attemptArm(PR, s.d);
  assert.equal(r.outcome, "direct-merge-failed");
  assert.equal(s.writes.length, 2);
});

test("a retried merge that landed despite a post-merge error is direct-merged", () => {
  const s = scene([BASE_MODIFIED, "post-merge step failed"], [{ mergeable: "MERGEABLE", behindBy: 0 }], {
    isMerged: (() => s0.writes.length >= 2) as never,
  });
  const s0 = s;
  assert.equal(attemptArm(PR, s.d).outcome, "direct-merged");
});

test("the retry re-runs the direct-merge preflight when updateBranch is wired", () => {
  let updates = 0;
  const s = scene([BASE_MODIFIED], [{ mergeable: "MERGEABLE", behindBy: 0, mergeableState: "clean" }], {
    updateBranch: (() => {
      updates++;
      return { ok: true };
    }) as never,
  });
  const r = attemptArm(PR, s.d);
  assert.equal(r.outcome, "direct-merged");
  assert.equal(updates, 0, "an up-to-date PR is never refreshed");
  assert.ok(s.readCount() >= 3, `initial preflight + retry read + retry preflight, got ${s.readCount()}`);
});

test("a non-405 direct merge error stays direct-merge-failed with no re-read", () => {
  const s = scene(["HTTP 403: Resource not accessible by integration"], [{ mergeable: "MERGEABLE", behindBy: 0 }]);
  const r = attemptArm(PR, s.d);
  assert.equal(r.outcome, "direct-merge-failed");
  assert.equal(s.readCount(), 0);
  assert.equal(s.writes.length, 1);
});

test("a base-modified refusal without readMergeFacts is unchanged: direct-merge-failed", () => {
  const s = scene([BASE_MODIFIED], [], { readMergeFacts: undefined });
  const r = attemptArm(PR, s.d);
  assert.equal(r.outcome, "direct-merge-failed");
  assert.equal(s.writes.length, 1);
});

test("a Required status check is expected refusal returns a retry-later hold, not direct-merge-failed", () => {
  const s = scene([CI_GATE_EXPECTED], [{ mergeable: "MERGEABLE", behindBy: 0 }]);
  const r = attemptArm(PR, s.d);
  assert.equal(r.outcome, "plan-pr-held");
  assert.equal(r.directMergePreflight?.remedy, "retry-later");
  assert.equal(r.directMergePreflight?.mergeableState, "blocked", "the state W1-T9212 re-evaluates on checks-green");
  assert.equal(r.error, CI_GATE_EXPECTED);
  assert.equal(s.writes.length, 1, "no retry write for a check that has not reported");
  assert.ok(!s.said.some((m) => m.includes("direct_merge_failed")));
});
