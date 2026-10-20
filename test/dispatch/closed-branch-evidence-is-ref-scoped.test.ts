import assert from "node:assert/strict";
import { test } from "node:test";
import { lazyClosedUnmerged, runBranchDispatchOpts, runBranchStateFrom } from "#src/lib/daemon.js";
import { runDrain } from "#src/lib/drain.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";

const taskId = "A";
const older = "run-A-1792500000000";
const newer = "run-A-1792506000000";
const sha = "1".repeat(40);
const pushed = (...refs: string[]) => refs.map((ref) => `${sha}\trefs/heads/${ref}`).join("\n");
const closed = (...refs: string[]) => refs.map((ref) => `${ref}\ttrue`).join("\n");
function options(refs: string[], read?: () => string) {
  return runBranchDispatchOpts(runBranchStateFrom(pushed(...refs), undefined, new Map(), lazyClosedUnmerged(read)), [], () => undefined);
}

test("a closed older run branch cannot release a newer pushed branch of the same task", () => {
  assert.notEqual(older, newer);
  assert.equal(options([newer], () => closed(older)).hasPushedRunBranch?.(taskId), true);
});

test("closed evidence must cover every pushed ref before the task is released", () => {
  assert.equal(options([older, newer], () => closed(older)).hasPushedRunBranch?.(taskId), true);
  assert.equal(options([older, newer], () => closed(older, newer)).hasPushedRunBranch?.(taskId), false);
});

test("an exact closed ref is released and its reader is memoized", () => {
  let reads = 0;
  const opts = options([older], () => { reads++; return closed(older); });
  assert.equal(opts.hasPushedRunBranch?.(taskId), false);
  assert.equal(opts.hasPushedRunBranch?.(taskId), false);
  assert.equal(reads, 1);
});

test("missing unreadable merged and malformed evidence cannot release a pushed ref", async (t) => {
  for (const [label, read] of [
    ["absent", undefined],
    ["unreadable", () => { throw new Error("fixture unreadable"); }],
    ["merged", () => `${older}\tfalse`],
    ["malformed", () => `${older}\tmaybe\ngarbage\ttrue`],
  ] as const) {
    await t.test(label, () => assert.equal(options([older], read).hasPushedRunBranch?.(taskId), true));
  }
});

test("both real drain selection paths keep the newer ref blocked after an older PR closes", async (t) => {
  for (const laneCount of [1, 2]) {
    await t.test(`lanes ${laneCount}`, async () => {
      const plan = loadPlanFromYaml(`
- id: A
  title: a task with a newer pushed ref
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
- id: B
  title: independent eligible work
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
`, "ref-scoped-closed-fixture");
      const ran: string[] = [];
      const merged = new Set<string>();
      let reads = 0;
      await runDrain(plan, {
        refreshMerged: () => (id) => merged.has(id),
        readPushedRunBranches: () => pushed(older, newer),
        readClosedRunBranchPrs: () => { reads++; return closed(older); },
        runOne: async (id) => {
          ran.push(id);
          merged.add(id);
          return { taskId: id, runId: `fixture-${id}`, merged: true, costUsd: 0, verdict: "merged" as const };
        },
      }, { max: 2, laneCount });
      assert.deepEqual(ran, ["B"]);
      assert.equal(reads, 1);
    });
  }
});
