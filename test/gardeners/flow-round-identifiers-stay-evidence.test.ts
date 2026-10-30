import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftShard, FLOW_LADDER, ladderGardenSpec, type FlowAction } from "#src/lib/flow-remedy-gardener.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { lintTask } from "#src/lib/task-linter.js";
import { machineShardFilingRefusal } from "#src/lib/machine-filing.js";

const observed = "own-red:fix needs design at this exact head (round DAEMON-<sha>:<n>:<sha>)";
const withoutRound = "own-red:fix needs design at this exact head";
const search = { filesContaining: () => [{ file: "src/lib/sweep.ts", hits: 1 }], fileExists: () => true };
const action: FlowAction = {
  class: "draft", target: `flow-blocker:${observed}`, origin: `flow-blocker:${observed}`, rung: 1, charges: [], population: [1],
  price: { key: observed, hours: 1, prs: 1, owners: ["fix-lane"] }, reason: `Observed cause: ${observed}`,
};

test("a flow round identifier remains evidence without becoming a second acceptance concern", () => {
  const text = draftShard(action, "W1-T99999", search, FLOW_LADDER);
  const task = loadPlanFromYaml(text, "flow:W1-T99999").tasks[0]!;
  assert.equal(task.origin, action.origin);
  assert.ok(task.title.includes(observed));
  assert.ok(task.rationale?.includes(observed));
  assert.equal(task.risk, "low");
  assert.equal(task.verify, "human");
  assert.equal(task.acceptance![0]!.claim, `${withoutRound} is cleared by its owner without manual intervention`);
  assert.deepEqual(lintTask(task).violations, []);
  assert.equal(machineShardFilingRefusal(text, "plan/tasks.d/W1-T99999-flow-own-red-fix-needs-design-at-this-exact-head.yaml", {
    pathExists: path => path === "src/lib/sweep.ts", pathExistsAtBase: path => path === "src/lib/sweep.ts",
  }), undefined);
  const originalClaim = { ...task, acceptance: [{ ...task.acceptance![0]!, claim: `${observed} is cleared by its owner without manual intervention` }] };
  assert.ok(lintTask(originalClaim).violations.some(v => v.check === "sizing" && v.severity === "block"));
});

test("the flow filing path admits the round-labelled remedy with its own matching falsifier slug", t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-flow-round-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spec = ladderGardenSpec({ repoRoot: root, stateDir: root, log: () => {}, openWorkspace: () => { throw new Error("unexpected workspace"); } }, {
    kind: FLOW_LADDER, sources: { mintTaskId: () => { throw new Error("already reserved"); }, ownerSearch: search },
    inventory: () => { throw new Error("already inventoried"); },
  });
  const landing = spec.apply({ root, branch: "fixture", land: () => { throw new Error("no publication"); }, dispose: () => {} },
    { actions: [action], acting: ["draft"] }, {}, ["W1-T99999"]);
  assert.ok(landing);
  assert.deepEqual(landing.paths, ["plan/tasks.d/W1-T99999-flow-own-red-fix-needs-design-at-this-exact-head.yaml"]);
  const text = readFileSync(join(root, landing.paths[0]!), "utf8");
  assert.ok(text.includes(observed));
  assert.equal(spec.landingRefusal?.(root, landing.paths), undefined);
});

test("flow claims preserve real daemon concerns and every other round suffix", () => {
  for (const cause of ["own-red:daemon crashes", "own-red:required checks red", `${withoutRound} (round DAEMON-other)`, `${observed} trailing detail`]) {
    assert.equal(FLOW_LADDER.claim(cause), `${cause} is cleared by its owner without manual intervention`);
  }
});
