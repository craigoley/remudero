import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { flowGardenSpec, type FlowGardenSources } from "../src/lib/flow-remedy-gardener.js";
import type { GardenerDeps } from "../src/lib/gardener.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations } from "../src/lib/plan.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { runnableCandidates } from "../src/lib/drain.js";

const TASK_ID = "W1-T5995-fixture";
const TEST_PATH = "test/flow-own-red-required-checks-red.test.ts";
const YAML = `- id: ${TASK_ID}
  title: "A parked flow remedy"
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  risk: low
  status: queued
  attempts: 0
  author_class: machine
  origin: "flow-blocker:own-red:required checks red"
  files:
    - src/lib/sweep.ts
    - ${TEST_PATH}
  acceptance:
    - claim: "the blocker has an owner-authored repair"
      proof: "unit test: ${TEST_PATH}"
`;

test("test/a-flow-remedy-proposal-passes-machine-filing-admission.test.ts: a flow-blocker remedy passes filing admission but verify:human still keeps it out of dispatch", () => {
  const plan = loadPlanFromYaml(YAML, "flow-remedy-admission");
  const task = plan.tasks[0]!;
  assert.deepEqual(machineFilingAdmissionViolations(task, {
    plan,
    releasedIds: new Set(),
    pathExists: path => path === "src/lib/sweep.ts",
    pathExistsAtBase: () => false,
  }), []);
  assert.deepEqual(runnableCandidates(plan, () => false, 10), [], "machine-filing admission does not release a human-verified task");
});

test("flow admission stays limited to source-owner plus new-test shards", () => {
  const outOfShape = YAML.replace(`    - ${TEST_PATH}\n`, `    - ${TEST_PATH}\n    - plan/policy.yaml\n`);
  const plan = loadPlanFromYaml(outOfShape, "flow-remedy-out-of-shape");
  const reasons = machineFilingAdmissionViolations(plan.tasks[0]!, {
    plan,
    releasedIds: new Set(),
    pathExists: path => path === "src/lib/sweep.ts",
    pathExistsAtBase: () => false,
  });
  assert.match(reasons.join("; "), /verify:human — not auto-runnable/);
  assert.match(reasons.join("; "), /plan\/policy\.yaml/);

  const auto = loadPlanFromYaml(YAML.replace("verify: human", "verify: auto"), "flow-remedy-auto");
  const autoReasons = machineFilingAdmissionViolations(auto.tasks[0]!, {
    plan: auto,
    releasedIds: new Set(),
    pathExists: path => path === "src/lib/sweep.ts",
    pathExistsAtBase: () => false,
  });
  assert.match(autoReasons.join("; "), new RegExp(TEST_PATH.replaceAll("/", "\\/")));
});

test("the flow gardener runs admission before it writes a drafted shard", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-flow-admission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "src", "lib", "sweep.ts"), "export {};\n");
  const now = Date.UTC(2026, 9, 6, 12);
  const records: LedgerRecord[] = [
    { step: "sweep.disposed", pr_number: 1, ts: new Date(now - 2 * 3_600_000).toISOString(), blocker: "own-red", reason: "required checks red", blocker_owner: "NONE" },
    { step: "sweep.disposed", pr_number: 1, ts: new Date(now).toISOString(), blocker: "own-red", reason: "required checks red", blocker_owner: "NONE" },
  ];
  const sources: FlowGardenSources = {
    owner: "acme",
    repo: "remudero",
    mintTaskId: () => "W1-T9001",
    ledgerRecords: () => records,
    planState: () => ({ tasks: [] }),
    prOutcomes: () => new Map(),
    ownerSearch: {
      filesContaining: () => [{ file: "src/lib/sweep.ts", hits: 1 }],
      fileExists: path => path === "src/lib/sweep.ts",
    },
  };
  const deps: GardenerDeps = {
    repoRoot: root,
    stateDir: root,
    clock: fixedClock(now),
    log: () => {},
    openWorkspace: () => { throw new Error("unexpected workspace"); },
  };
  const worktree = { root, branch: "flow-garden-123", land: () => { throw new Error("unexpected landing"); }, dispose: () => {} };
  const validSpec = flowGardenSpec(deps, sources);
  const inventory = validSpec.inventory();
  const plan = { actions: validSpec.candidates(inventory, () => 0), acting: ["draft" as const] };
  const landing = validSpec.apply(worktree, plan, validSpec.scorecard(inventory, plan))!;
  const goodDraft = readFileSync(join(root, landing.paths[0]!), "utf8");
  assert.equal(readdirSync(join(root, "plan", "tasks.d")).length, 1);

  const malformed = goodDraft.replace("W1-T9001", "W1-T9002").replace("    - src/lib/sweep.ts\n", "");
  const before = readdirSync(join(root, "plan", "tasks.d")).length;
  const invalidSources: FlowGardenSources = {
    ...sources,
    mintTaskId: () => "W1-T9002",
    draftShard: () => malformed,
  };
  assert.deepEqual(machineFilingAdmissionViolations(
    loadPlanFromYaml(malformed, "flow-remedy-invalid").tasks[0]!,
    {
      plan: loadPlanFromYaml(malformed, "flow-remedy-invalid"),
      releasedIds: new Set(),
      pathExists: path => existsSync(join(root, path)),
      pathExistsAtBase: path => path === "src/lib/sweep.ts",
    },
  ).length > 0, true);
  const invalidSpec = flowGardenSpec(deps, invalidSources);
  assert.throws(() => invalidSpec.apply(worktree, plan, {}), /machine-filing admission/);
  assert.equal(readdirSync(join(root, "plan", "tasks.d")).length, before, "a refused draft never reaches disk");
});

test("a flow remedy the machine-filing judge released to verify:auto keeps its new test path admissible", () => {
  const ruling = (action: string) => `  risk_ruling:\n    verdict: "low"\n    action: ${action}\n    confidence: 0.7\n    reasons:\n      - "fixture"\n    judged_at: "2026-10-06T18:20:44.742Z"\n    pin: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n`;
  const admit = (yaml: string) => {
    const plan = loadPlanFromYaml(yaml, "flow-remedy-judged");
    return machineFilingAdmissionViolations(plan.tasks[0]!, {
      plan,
      releasedIds: new Set(),
      pathExists: path => path === "src/lib/sweep.ts",
      pathExistsAtBase: () => false,
    }).join("; ");
  };
  const auto = YAML.replace("verify: human", "verify: auto");
  assert.doesNotMatch(admit(auto + ruling("proceed")), /exist in neither the checkout nor the base tree/, "a judge-released remedy (#9657's W1-T6044 shape) is admitted");
  assert.match(admit(auto + ruling("escalate")), new RegExp(TEST_PATH.replaceAll("/", "\\/")), "an escalated ruling releases nothing");
  assert.match(admit(auto), new RegExp(TEST_PATH.replaceAll("/", "\\/")), "an unjudged verify:auto remedy is still refused, as #9571 pins");
});
