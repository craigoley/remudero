import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ciFrictionGardenSpec, ciFrictionRecordVerdict } from "#src/lib/ci-friction-gardener.js";
import { fixedClock } from "#src/lib/clock.js";
import { flowGardenSpec } from "#src/lib/flow-remedy-gardener.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import { MACHINE_SHARD_LINT_OPTIONS, machineShardFilingRefusal, machineShardLintRefusal, renderMachineShard, type MachineShardSpec } from "#src/lib/machine-filing.js";
import { ciLearningRecordVerdict, ciLearningShardYaml, fileCiLearningShards, type CiLearningShardDraft } from "#src/lib/measurement-cadence.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations } from "#src/lib/plan.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { lintTask } from "#src/lib/task-linter.js";

const ID = "W1-T998349";
const OWNER = "src/lib/sweep.ts";
const FINDING = "ci-learning:12305:coverage-ratchet";
const LESSON = "learnings/ci.d/ci-learning-12305-coverage-ratchet.yaml";
const FIXTURE = "test/fixtures/golden-verdicts/ci-learning-12305-coverage-ratchet/criteria.yaml";
const DRAFT: CiLearningShardDraft = {
  findingId: FINDING, title: "Carry the coverage lesson to the CI lane", gate: "coverage-ratchet", pr: 12305, prs: [12305],
  repairFiles: [OWNER], dominantRepairFiles: [], author_class: "machine", verify: "human", remedySurface: "learnings/*.yaml",
};

test("W1-T13149 criterion 1: both remedy writers refuse a promoted check before writing its shard", async (t) => {
  const now = Date.UTC(2026, 10, 18);
  const records: LedgerRecord[] = [now - 7_200_000, now].map(ts => ({
    step: "sweep.disposed", pr_number: 1, ts: new Date(ts).toISOString(),
    blocker: "own-red", reason: "required checks red", blocker_owner: "fix-lane",
  }));
  const sources = {
    mintTaskId: () => ID, planState: () => ({ tasks: [] }),
    ownerSearch: { filesContaining: () => [{ file: OWNER, hits: 1 }], fileExists: (path: string) => path === OWNER },
  };

  for (const writer of ["ci-friction", "flow-remedy"] as const) {
    await t.test(writer, () => {
      const root = mkdtempSync(join(tmpdir(), "rmd-promoted-check-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const deps: GardenerDeps = {
        repoRoot: root, stateDir: root, clock: fixedClock(now), log: () => {}, openWorkspace: () => assert.fail("unexpected workspace"),
      };
      const workspace = { root, branch: "promotion-fixture", land: () => assert.fail("unexpected landing"), dispose: () => {} };
      const spec: MachineShardSpec = {
        taskId: ID, title: "A remedy for a check that went red",
        origin: writer === "ci-friction" ? "ci-friction:check:gate" : "flow-blocker:own-red:required checks red",
        files: [OWNER, "test/triage/promotion-fixture.test.ts"],
        invariants: { none: "the remedy adds a new behavior" },
        acceptance: [{ claim: "the remedy clears the blocker", proof: `unit test: ${ID}: the blocker clears` }],
      };
      const clean = renderMachineShard(spec);
      assert.equal(clean.refused, undefined);
      const bad = renderMachineShard({
        ...spec, acceptance: [...spec.acceptance, { claim: "a separate behavior remains reachable", proof: "grep: marker in src/lib/undeclared.ts" }],
      });
      assert.equal(bad.refused, "proof-scope (plan-only promotion)");
      const task = loadPlanFromYaml(bad.text, ID).tasks[0]!;
      assert.equal(lintTask(task, MACHINE_SHARD_LINT_OPTIONS).ok, true, "the unpromoted writer lint admits the draft");
      assert.equal(machineShardFilingRefusal(bad.text, ID, { pathExists: sources.ownerSearch.fileExists }), undefined, "the landing guard admits it");

      if (writer === "ci-friction") {
        const friction = ciFrictionGardenSpec(deps, {
          ...sources, ledgerRecords: () => [], ownerSearch: {
            ...sources.ownerSearch, workflowOwner: () => ({ files: [OWNER], why: ["owns the check"] }),
          },
          gateFireRates: () => ({
            status: "measured", prsScanned: 9, neverFired: [], alwaysFired: [],
            gates: [{ gate: "gate", prs: 9, runs: 12, redRuns: 12, refusals: 12, repaired: 12, overridden: 0, minutes: 300, redMinutes: 300, redPrs: 9 }],
          }),
          draftShard: () => bad.text,
        });
        const actions = friction.candidates(friction.inventory(), () => 0);
        assert.equal(actions.length, 1);
        assert.throws(() => friction.apply(workspace, { actions, acting: ["draft"] }, {}, [ID]), /proof-scope \(plan-only promotion\)/);
        const combined = clean.text + bad.text.replaceAll(ID, "W1-T998350");
        assert.match(ciFrictionRecordVerdict(combined, ID).reason, /must contain exactly one task \(found 2\)/);
      } else {
        const flowSources = {
          ...sources, owner: "fixture", repo: "remudero", ledgerRecords: () => records,
          prOutcomes: () => new Map([[1, { state: "closed" as const, at: new Date(now).toISOString() }]]),
        };
        const flow = flowGardenSpec(deps, { ...flowSources, draftShard: () => bad.text });
        const actions = flow.candidates(flow.inventory(), () => 0);
        assert.equal(actions.length, 1);
        assert.throws(() => flow.apply(workspace, { actions, acting: ["draft"] }, {}, [ID]), /proof-scope \(plan-only promotion\)/);
      }

      assert.equal(existsSync(join(root, "plan", "tasks.d")), false);
    });
  }
});

test("W1-T13149 criterion 2: the filed lesson declares its fixture and its second proof reads it", () => {
  const written: string[] = [];
  const result = fileCiLearningShards([DRAFT], "/fixture", {
    mintTaskId: () => ID, planOrigins: [],
    fs: { mkdirSync: () => undefined, writeFileSync: (_path, contents) => void written.push(contents) },
  });
  assert.deepEqual(result.refused, []);
  assert.equal(written.length, 1);
  const text = written[0]!;
  const task = loadPlanFromYaml(text, ID).tasks[0]!;
  assert.deepEqual(task.files, [LESSON, FIXTURE]);
  assert.deepEqual(task.acceptance?.map(criterion => criterion.proof), [`grep: ${FINDING} in ${LESSON}`, `grep: ${FINDING} in ${FIXTURE}`]);
  assert.equal(machineShardLintRefusal(text, ID), undefined);
  assert.equal(machineShardFilingRefusal(text, ID, { pathExists: () => false }), undefined);
});

test("W1-T13149 criterion 3: admission stays closed to paths beyond the lesson and its fixture", () => {
  const text = ciLearningShardYaml(DRAFT, ID);
  const held = text.replace("  status: queued", "  status: queued\n  dispatch_hold: true");
  const admit = (contents: string) => {
    const plan = loadPlanFromYaml(contents, ID);
    return machineFilingAdmissionViolations(plan.tasks[0]!, { plan, releasedIds: new Set(), pathExists: () => true });
  };
  assert.deepEqual(admit(held), []);
  const extra = held.replace(/  files:\n(?:    - .+\n)+/, `  files:\n    - ${LESSON}\n    - ${FIXTURE}\n    - ${OWNER}\n`);
  assert.match(admit(extra).join("; "), /src\/lib\/sweep\.ts/);
  assert.equal(ciLearningRecordVerdict(extra, ID).ok, false);
});
