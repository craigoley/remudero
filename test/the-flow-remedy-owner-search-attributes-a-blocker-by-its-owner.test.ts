import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIX_LANE_LADDER } from "#src/lib/fix-lane-gardener.js";
import { draftShard, episodesOf, FLOW_LADDER, ladderOf, markEligibility, type FlowAction } from "#src/lib/flow-remedy-gardener.js";
import { blockerOwnerModule, PR_BLOCKER_OWNER_MODULES, PR_BLOCKER_OWNERS } from "#src/lib/pr-blocker.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const REASON = "required checks red — ci-log fix, strike 1/2 — NOT DISPATCHED this pass: base red";
// The four files `git grep -c -F 'required checks red'` measured on 2026-10-14, one hit each.
const ONE_HIT_FILES = ["src/lib/fix-lane-gardener.ts", "src/lib/machine-filing.ts", "src/lib/sweep.ts", "src/run-task.ts"];

function recordingSearch() {
  const calls: string[] = [];
  return {
    calls,
    search: {
      filesContaining: (text: string) => { calls.push(text); return ONE_HIT_FILES.map(file => ({ file, hits: 1 })); },
      fileExists: () => true,
    },
  };
}

/** One PR held on `blocker` for three hours under `owner`, closed unmerged, so its episode is eligible. */
function actionFor(blocker: string, owner: string): FlowAction {
  const records: LedgerRecord[] = [0, 1, 2, 3].map(h => ({
    step: "sweep.disposed", pr_number: 9533, ts: new Date(NOW - (4 - h) * 3_600_000).toISOString(),
    blocker, reason: REASON, blocker_owner: owner,
  }));
  const episodes = episodesOf(records, new Map([[9533, { state: "closed" as const, at: new Date(NOW - 1_800_000).toISOString() }]]), NOW);
  const thresholds = markEligibility(episodes, NOW);
  const next = ladderOf(FLOW_LADDER, episodes, records, [], NOW, thresholds).next;
  assert.ok(next, "the fixture prices one eligible cause");
  assert.equal(next.price.key, `${blocker}:required checks red`);
  return next;
}

test("W1-T9597: a base-red blocker is owned by its declared owner module", () => {
  const { calls, search } = recordingSearch();
  const text = draftShard(actionFor("base-red", "main-health"), "W1-T99597", search, FLOW_LADDER);
  const task = loadPlanFromYaml(text, "flow:W1-T99597").tasks[0]!;
  assert.equal(task.files![0], "src/lib/sweep.ts", "main-health's declared module, not the name-ordered first text hit");
  assert.notEqual(task.files![0], "src/lib/fix-lane-gardener.ts");
  assert.deepEqual(calls, [], "the repo-wide text search is never called for a PR blocker");
  assert.ok(task.rationale?.includes("Source owner: main-health → src/lib/sweep.ts."), task.rationale);
});

test("W1-T9597: a flow blocker whose owner declares no module escalates as no owner", () => {
  for (const [blocker, owner] of [["base-red", "NONE"], ["escalated", "NONE"], ["operator-hold", "operator"], ["own-red", "not-a-declared-owner"]]) {
    const { calls, search } = recordingSearch();
    assert.throws(() => draftShard(actionFor(blocker!, owner!), "W1-T99597", search, FLOW_LADDER),
      new RegExp(`no source owner found for ${blocker}:required checks red: declared owner ${owner} names no module`), `${blocker}/${owner}`);
    assert.deepEqual(calls, [], `${blocker}/${owner}: no text-match fallback`);
  }
  const mixed = actionFor("own-red", "fix-lane");
  const twoOwners: FlowAction = { ...mixed, charges: [...mixed.charges, { ...mixed.charges[0]!, owner: "main-health" }] };
  const { calls, search } = recordingSearch();
  assert.throws(() => draftShard(twoOwners, "W1-T99597", search, FLOW_LADDER), /declared owner fix-lane, main-health names no module/);
  assert.deepEqual(calls, [], "charges carrying different owners are no owner, never a tie-break");
});

test("W1-T9597: every declared blocker owner names an existing module that is not a remedy filer", () => {
  const owners = new Set<string>(Object.values(PR_BLOCKER_OWNERS));
  for (const owner of owners) {
    const module = blockerOwnerModule(owner);
    if (owner === "NONE" || owner === "operator") { assert.equal(module, undefined, owner); continue; }
    assert.ok(module, `${owner} declares a module in PR_BLOCKER_OWNER_MODULES`);
    assert.ok(existsSync(join(REPO_ROOT, module)), `${owner} → ${module} exists`);
    assert.doesNotMatch(module, /^src\/lib\/[^/]+-gardener\.ts$/, `${owner} → ${module} is not a gardener`);
    assert.notEqual(module, "src/lib/machine-filing.ts", `${owner} → ${module} is not the remedy filer`);
  }
  for (const owner of Object.keys(PR_BLOCKER_OWNER_MODULES)) assert.ok(owners.has(owner), `${owner} is a declared blocker owner`);
  assert.equal(blockerOwnerModule("main-health"), "src/lib/sweep.ts");
});

test("W1-T9597: the fix-lane ladder keeps its text search for a blocker-shaped intervention key", () => {
  const { calls, search } = recordingSearch();
  const flow = actionFor("own-red", "fix-lane");
  const key = "own-red:fix-lane:required checks red";
  const action: FlowAction = { ...flow, price: { ...flow.price, key }, origin: `fix-lane:${key}`, target: `fix-lane:${key}` };
  const task = loadPlanFromYaml(draftShard(action, "W1-T99598", search, FIX_LANE_LADDER), "fix-lane:W1-T99598").tasks[0]!;
  assert.deepEqual(calls, ["fix-lane:required checks red"], "an unchanged ladder still searches the reason text");
  assert.equal(task.files![0], "src/lib/fix-lane-gardener.ts");
});
