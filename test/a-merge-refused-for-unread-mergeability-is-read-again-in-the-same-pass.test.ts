// W1-T12059 — GitHub reads mergeability as UNKNOWN for a few seconds after a status changes. The
// direct-merge preflight reads the pull request again in the same pass, and judges only the new facts.
import assert from "node:assert/strict";
import test from "node:test";

import {
  attemptArm,
  attemptArmAsync,
  PLAN_PR_UNKNOWN_MAX_REREADS,
  REST_MERGE_UNSETTLED_RETRY_INTERVAL_MS,
} from "#src/lib/arm-auto-merge.js";

const PR = "https://github.com/craigoley/remudero/pull/17900";
const HEAD = "1111111111111111111111111111111111111111";
const NEW_HEAD = "2222222222222222222222222222222222222222";
const CLEAN = "Pull request is in clean status";

type AttemptDeps = Parameters<typeof attemptArm>[1];
type ArmMergeFacts = { mergeable?: string; behindBy?: number; mergeableState?: string };

function harness(reads: ArmMergeFacts[], over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const said: string[] = [];
  const sleeps: number[] = [];
  let read = 0;
  const deps = {
    headSha: () => HEAD,
    armAuto: () => {
      throw Object.assign(new Error("boom"), { stderr: CLEAN });
    },
    mergeDirect: () => void calls.push("mergeDirect"),
    isMerged: () => false,
    readMergeFacts: () => {
      calls.push("readMergeFacts");
      return reads[Math.min(read++, reads.length - 1)];
    },
    updateBranch: () => {
      calls.push("updateBranch");
      return { ok: true };
    },
    sleepSync: (ms: number) => void sleeps.push(ms),
    say: (message: string) => void said.push(message),
    ...over,
  } as unknown as AttemptDeps;
  return { deps, calls, said, sleeps };
}

test("W1-T12059 criterion 1: an unknown read is read again in the same pass and merges when the second read is clean", async () => {
  const h = harness([{ mergeable: "UNKNOWN", behindBy: 0 }, { mergeable: "MERGEABLE", behindBy: 0, mergeableState: "clean" }]);
  const result = attemptArm(PR, h.deps, HEAD);
  assert.equal(result.outcome, "direct-merged");
  assert.deepEqual(h.calls, ["readMergeFacts", "readMergeFacts", "mergeDirect"]);
  assert.deepEqual(h.sleeps, [REST_MERGE_UNSETTLED_RETRY_INTERVAL_MS], "the second read waits one pacing interval");
  assert.deepEqual(result.directMergePreflight, { priorHeadSha: HEAD, behindBy: 0, mergeable: "MERGEABLE", remedy: "direct-merge" });
  assert.ok(h.said.some((line) => line.startsWith("automerge.direct_merge_preflight_reread (W1-T12059)")));

  // The daemon's async path takes the same steps, with the wait awaited.
  const waits: number[] = [];
  const a = harness([{ mergeable: "UNKNOWN", behindBy: 0 }, { mergeable: "MERGEABLE", behindBy: 0 }], {
    sleepSync: undefined,
    sleep: async (ms: number) => void waits.push(ms),
  });
  const asyncResult = await attemptArmAsync(PR, a.deps as Parameters<typeof attemptArmAsync>[1], HEAD);
  assert.equal(asyncResult.outcome, "direct-merged");
  assert.deepEqual(waits, [REST_MERGE_UNSETTLED_RETRY_INTERVAL_MS]);
});

test("W1-T12059 criterion 2: the head, the base distance and the plan-touch check use the second read only", () => {
  // No head from the caller: the preflight reads the head again on the second read.
  let headReads = 0;
  const planTouchHeads: Array<string | undefined> = [];
  const fresh = harness([{ mergeable: "UNKNOWN", behindBy: 0 }, { mergeable: "MERGEABLE", behindBy: 3, mergeableState: "clean" }], {
    headSha: () => (headReads++ === 0 ? HEAD : NEW_HEAD),
    readPlanTouch: (_pr: string, head?: string) => {
      planTouchHeads.push(head);
      return "untouched";
    },
  });
  const result = attemptArm(PR, fresh.deps);
  assert.equal(result.outcome, "direct-merged");
  assert.equal(headReads, 2, "the head is read again with the second facts read");
  assert.deepEqual(planTouchHeads, [undefined, NEW_HEAD], "the plan-touch check reads the new head, not the first one");
  assert.deepEqual(result.directMergePreflight, {
    priorHeadSha: NEW_HEAD, behindBy: 3, mergeable: "MERGEABLE", planTouch: "untouched", remedy: "direct-merge",
  });

  // A second read that is behind where the branch must be current is updated, judged on its own distance.
  const behind = harness([{ mergeable: "UNKNOWN", behindBy: 0 }, { mergeable: "MERGEABLE", behindBy: 2, mergeableState: "behind" }]);
  const behindResult = attemptArm(PR, behind.deps, HEAD);
  assert.equal(behindResult.outcome, "direct-merge-updated");
  assert.deepEqual(behind.calls, ["readMergeFacts", "readMergeFacts", "updateBranch"]);
  assert.equal(behindResult.directMergePreflight?.behindBy, 2);

  // The caller's reviewed head moved during the wait: no merge on a head nobody judged.
  const moved = harness([{ mergeable: "UNKNOWN", behindBy: 0 }, { mergeable: "MERGEABLE", behindBy: 0 }], { headSha: () => NEW_HEAD });
  const movedResult = attemptArm(PR, moved.deps, HEAD);
  assert.equal(movedResult.outcome, "direct-merge-preflight-refused");
  assert.deepEqual(moved.calls, ["readMergeFacts"], "neither a second facts read, nor an update, nor a merge");
  assert.equal(movedResult.directMergePreflight?.remedy, "retry-later");
  assert.match(String(movedResult.directMergePreflight?.error), new RegExp(`head moved from ${HEAD} to ${NEW_HEAD}`));
});

test("W1-T12059 criterion 3: a read that stays unknown is refused as before and waits for the next sweep", () => {
  const h = harness([{ mergeable: "UNKNOWN", behindBy: 0 }]);
  const result = attemptArm(PR, h.deps, HEAD);
  assert.equal(result.outcome, "direct-merge-preflight-refused");
  assert.equal(h.calls.filter((c) => c === "readMergeFacts").length, 1 + PLAN_PR_UNKNOWN_MAX_REREADS);
  assert.equal(h.calls.includes("mergeDirect") || h.calls.includes("updateBranch"), false);
  assert.deepEqual(result.directMergePreflight, { priorHeadSha: HEAD, behindBy: 0, mergeable: "UNKNOWN", remedy: "retry-later" });
  assert.equal(h.said.filter((line) => line.startsWith("automerge.direct_merge_preflight_refused (W1-T2855)")).length, 1);

  // A conflict or an unreadable read on the second read is refused at once, with no further reads.
  for (const second of [{ mergeable: "CONFLICTING", behindBy: 0 }, { mergeable: "UNKNOWN" }] as ArmMergeFacts[]) {
    const s = harness([{ mergeable: "UNKNOWN", behindBy: 0 }, second]);
    const r = attemptArm(PR, s.deps, HEAD);
    assert.equal(r.outcome, "direct-merge-preflight-refused", JSON.stringify(second));
    assert.deepEqual(s.calls, ["readMergeFacts", "readMergeFacts"], JSON.stringify(second));
  }
});
