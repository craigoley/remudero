import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import {
  GARDEN_PENDING_RELEASE_MS,
  gardenStatePath,
  judgeGardenPending,
  readGardenState,
  runGarden,
  type GardenAction,
  type GardenCheckout,
  type GardenSpec,
  type GardenState,
  type Outcome,
} from "../src/lib/gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const mergeSeenAt = "2026-10-08T07:00:01.000Z";
const dueAt = Date.parse(mergeSeenAt) + GARDEN_PENDING_RELEASE_MS;
const baseline: Outcome = { trials: 68248, successes: 156 };
const inconclusive: Outcome = { trials: 72109, successes: 166 };

function pendingState(): GardenState<"delete"> {
  return {
    classes: { delete: { alpha: 3, beta: 1 } },
    pending: {
      prUrl: "https://github.com/acme/demo/pull/1", actionClass: "delete",
      baseline, atMerge: baseline, mergeSeenAt,
    },
  };
}

test("W1-T7393: an inconclusive metric with trials since the merge is released after the bound", () => {
  const state = pendingState();
  assert.equal(judgeGardenPending(state, inconclusive, "merged", fixedClock(dueAt - 1)).verdict, "waiting");
  for (const at of [dueAt, dueAt + 12 * 3_600_000]) {
    const judged = judgeGardenPending(state, inconclusive, "merged", fixedClock(at));
    assert.equal(judged.verdict, "released");
    assert.equal(judged.state.pending, undefined);
    assert.deepEqual(judged.state.classes, state.classes, "release neither credits nor debits");
  }
});

test("W1-T7393: a positive-trial legacy metric starts its release clock when observed", () => {
  const state = pendingState();
  delete state.pending!.mergeSeenAt;
  const stamped = judgeGardenPending(state, inconclusive, "merged", fixedClock(dueAt));
  assert.equal(stamped.verdict, "waiting");
  assert.equal(stamped.state.pending?.mergeSeenAt, fixedClock(dueAt).iso());
  assert.equal(judgeGardenPending(stamped.state, inconclusive, "merged",
    fixedClock(dueAt + GARDEN_PENDING_RELEASE_MS)).verdict, "released");
});

test("W1-T7393: decisive metrics and unmerged PRs retain their verdicts", () => {
  const state = pendingState();
  for (const at of [dueAt - 1, dueAt]) {
    for (const [successes, verdict] of [[256, "credit"], [156, "debit"]] as const) {
      const judged = judgeGardenPending(state, { trials: 72109, successes }, "merged", fixedClock(at));
      assert.equal(judged.verdict, verdict);
      assert.deepEqual(judged.state.classes.delete,
        verdict === "credit" ? { alpha: 4, beta: 1 } : { alpha: 3, beta: 2 });
    }
  }
  for (const pr of ["open", "unknown"] as const) {
    assert.equal(judgeGardenPending(state, inconclusive, pr, fixedClock(dueAt)).verdict, "waiting");
  }
  assert.equal(judgeGardenPending(state, inconclusive, "closed", fixedClock(dueAt)).verdict, "debit");
  assert.equal(judgeGardenPending(state, inconclusive, "merged").verdict, "waiting");
});

test("W1-T7393: a frozen inconclusive metric releases on unchanged inputs and logs its evidence once", (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t7393-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = pendingState();
  state.lastCheap = "unchanged";
  state.lastPass = { fingerprint: "unchanged" };
  const path = gardenStatePath(dir, "export");
  writeFileSync(path, JSON.stringify(state));
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let reads = 0;
  const spec: GardenSpec<"delete", Outcome, GardenAction<"delete">, GardenCheckout> = {
    name: "export", classes: ["delete"],
    cheapFingerprint: () => "unchanged",
    inventory: () => { reads++; return inconclusive; },
    fingerprint: () => "unchanged",
    metric: (inventory) => inventory,
    candidates: () => [], scorecard: () => ({}), apply: () => undefined,
  };
  const deps = {
    stateDir: dir, repoRoot: dir, clock: fixedClock(dueAt), seed: 1,
    prState: () => "merged" as const,
    openWorkspace: (): GardenCheckout => { throw new Error("no candidate needs a workspace"); },
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }),
  };
  assert.equal(runGarden(spec, deps).ran, true);
  const saved = readGardenState(path, ["delete"]);
  assert.equal(saved.pending, undefined);
  assert.deepEqual(saved.classes, state.classes);
  assert.deepEqual(rows.filter((row) => row.step === "export.pending_released"), [{
    step: "export.pending_released",
    extra: {
      pr_url: state.pending!.prUrl, action_class: "delete",
      waited_ms: GARDEN_PENDING_RELEASE_MS, bound_ms: GARDEN_PENDING_RELEASE_MS,
      trials: 3861, difference: 10 / 3861 - 156 / 68248,
    },
  }]);
  assert.equal(rows.some((row) => row.step === "export.gardener_judged"), false);
  assert.equal(runGarden(spec, deps).ran, false);
  assert.equal(reads, 1);
  assert.equal(rows.filter((row) => row.step === "export.pending_released").length, 1);
});
