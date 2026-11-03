import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLOW_LADDER, ladderGardenSpec, remedyScopeRefusal, type FlowAction } from "#src/lib/flow-remedy-gardener.js";
import { FIX_LANE_LADDER } from "#src/lib/fix-lane-gardener.js";

const cause = "text-searched:fix needs design at this exact head";
const searchOf = (file: string) => ({ filesContaining: () => [{ file, hits: 1 }], fileExists: () => true });
const actionOf = (prior?: FlowAction["prior"]): FlowAction => ({
  class: "draft", target: `flow-blocker:${cause}`, origin: `flow-blocker:${cause}`, rung: 1, charges: [], population: [1],
  price: { key: cause, hours: 1, prs: 1, owners: ["fix-lane"] }, reason: `Observed cause: ${cause}`, ...(prior ? { prior } : {}),
});
const priorOf = (file: string): FlowAction["prior"] => ({
  task: { id: "W1-T1", files: [file], origin: "x" } as never, effect: { reason: "did not fall" } as never,
});

function run(kind: typeof FLOW_LADDER, file: string, prior?: FlowAction["prior"]) {
  const root = mkdtempSync(join(tmpdir(), "rmd-ladder-scope-"));
  const escalations: string[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  let minted = 0;
  const spec = ladderGardenSpec({ repoRoot: root, stateDir: root, log: (s, r) => { logs.push([s, r as Record<string, unknown>]); },
    openWorkspace: () => { throw new Error("unexpected workspace"); } }, {
    kind, sources: { mintTaskId: () => { minted++; return "W1-T99999"; }, ownerSearch: searchOf(file),
      escalate: e => { escalations.push(e.detail); return "https://example.test/issue/1"; } },
    inventory: () => { throw new Error("already inventoried"); },
  });
  const ws = { root, branch: "fixture", land: () => { throw new Error("no publication"); }, dispose: () => {} };
  const plan = { actions: [actionOf(prior)], acting: ["draft" as const] };
  const held = spec.prepare ? spec.prepare(ws, plan, false) : undefined;
  const landing = spec.apply(ws, plan, {}, ["W1-T99999"]);
  const written = existsSync(join(root, "plan/tasks.d"));
  rmSync(root, { recursive: true, force: true });
  return { held, landing, written, escalations, logs, minted };
}

test("remedyScopeRefusal names a non-source owner, an own module and a repeated failed remedy", () => {
  assert.match(remedyScopeRefusal("scripts/test-placement/test-folders.tsv", FLOW_LADDER) ?? "", /not a source module/);
  assert.match(remedyScopeRefusal("docs/readme.md", FLOW_LADDER) ?? "", /not a source module/);
  assert.match(remedyScopeRefusal("src/lib/flow-remedy-gardener.ts", FLOW_LADDER) ?? "", /own classifier/);
  assert.match(remedyScopeRefusal("src/lib/fix-lane-gardener.ts", FIX_LANE_LADDER) ?? "", /own classifier/);
  assert.match(remedyScopeRefusal("src/lib/sweep.ts", FLOW_LADDER, priorOf("src/lib/sweep.ts")) ?? "", /W1-T1/);
  assert.equal(remedyScopeRefusal("src/lib/sweep.ts", FLOW_LADDER, priorOf("src/lib/other.ts")), undefined);
  assert.equal(remedyScopeRefusal("src/lib/sweep.ts", FLOW_LADDER), undefined);
  assert.equal(remedyScopeRefusal("scripts/thing.mjs", FIX_LANE_LADDER), undefined);
});

test("a ladder remedy it cannot scope escalates instead of filing a shard", () => {
  for (const [kind, file, prior, why] of [
    [FLOW_LADDER, "scripts/test-placement/test-folders.tsv", undefined, /not a source module/],
    [FLOW_LADDER, "src/lib/flow-remedy-gardener.ts", undefined, /own classifier/],
    [FIX_LANE_LADDER, "src/lib/fix-lane-gardener.ts", undefined, /own classifier/],
    [FLOW_LADDER, "src/lib/sweep.ts", priorOf("src/lib/sweep.ts"), /already used/],
  ] as const) {
    const r = run(kind, file, prior);
    assert.equal(r.landing, undefined, file);
    assert.equal(r.written, false, `${file} wrote a shard directory`);
    assert.equal(r.minted, 0, `${file} spent a task id`);
    assert.equal(r.escalations.length, 1, file);
    assert.match(r.escalations[0]!, why);
    assert.equal(r.logs.filter(([s]) => s === kind.escalatedStep).length, 1, file);
  }
});

test("an admissible owner still files exactly as before", () => {
  const r = run(FLOW_LADDER, "src/lib/sweep.ts", priorOf("src/lib/other.ts"));
  assert.ok(r.landing);
  assert.deepEqual(r.landing.paths, ["plan/tasks.d/W1-T99999-flow-text-searched-fix-needs-design-at-this-exact-head.yaml"]);
  assert.equal(r.escalations.length, 0);
  assert.equal(r.minted, 1);
});

test("an owner the search cannot name is left to draftShard's own error, not escalated as a scope refusal", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-ladder-scope-"));
  const escalations: string[] = [];
  const spec = ladderGardenSpec({ repoRoot: root, stateDir: root, log: () => {}, openWorkspace: () => { throw new Error("unexpected workspace"); } }, {
    kind: FLOW_LADDER, sources: { mintTaskId: () => "W1-T99999", ownerSearch: { filesContaining: () => [], fileExists: () => false },
      escalate: e => { escalations.push(e.detail); return null; } },
    inventory: () => { throw new Error("already inventoried"); },
  });
  const ws = { root, branch: "fixture", land: () => { throw new Error("no publication"); }, dispose: () => {} };
  try {
    assert.throws(() => spec.apply(ws, { actions: [actionOf()], acting: ["draft" as const] }, {}, ["W1-T99999"]), /no source owner found/);
    assert.equal(escalations.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
