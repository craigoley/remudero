// #10685 made the machine-filing judge check its `verify: auto` rewrite the way lint-plan --base checks the landing
// PR, but only with lintTask. lint-plan --base also runs the machine-filing admission (W1-T3843) on every changed
// machine record, and at verify: auto that refuses a record whose depends_on has not merged — a check verify: human
// parks past. So the judge could still offer a proceed the plan-PR preflight refuses on every pass. The judge now runs
// the admission too, and a release it refuses becomes the escalation that names it, landed once.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { Proposal } from "../src/lib/inbox.js";
import { machineShardHeaderLines } from "../src/lib/machine-filing.js";
import { renderRuledShard, runMachineFilingJudge } from "../src/lib/machine-filing-judge.js";
import { loadPlan, machineFilingAdmissionViolations, parseTasksFromYaml } from "../src/lib/plan.js";
import type { FilingRiskRuling } from "../src/lib/risk-judge.js";
import { taskRulingPin } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const CLOCK = fixedClock(Date.parse("2026-10-10T18:30:00Z"));
const DOC = "docs/ci-friction-remedies.md";
const DEP = "W1-T9893";

/** A machine-filed docs remedy that waits on `dependsOn`. */
function dependentRemedy(id: string, dependsOn: string): string {
  return [
    `- id: ${id}`,
    `  title: ${JSON.stringify(`record the remedy for ${id}`)}`,
    "  repo: remudero",
    `  depends_on: [${dependsOn}]`,
    "  type: implement",
    ...machineShardHeaderLines([DOC]),
    `  origin: ${JSON.stringify(`ci-friction:${id}`)}`,
    "  files:",
    `    - ${DOC}`,
    "  acceptance:",
    `    - claim: "the remedy for ${id} is recorded"`,
    `      proof: "grep: ${id} in ${DOC}"`,
    "",
  ].join("\n");
}

/** The task it waits on: operator work, queued, so not merged. */
const dependency = [
  `- id: ${DEP}`,
  `  title: "the operator change ${DEP} the remedy builds on"`,
  "  repo: remudero",
  "  depends_on: []",
  "  type: implement",
  "  verify: auto",
  "  risk: low",
  "  status: queued",
  "  attempts: 0",
  "  files:",
  `    - ${DOC}`,
  "  acceptance:",
  `    - claim: "the change ${DEP} is recorded"`,
  `      proof: "grep: ${DEP} in ${DOC}"`,
  "",
].join("\n");

function planRoot(t: { after: (fn: () => void) => void }, shards: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-admission-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, DOC), "# remedies\n");
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  for (const [name, text] of Object.entries(shards)) writeFileSync(join(root, "plan", "tasks.d", name), text);
  return root;
}

const proceed: FilingRiskRuling = { verdict: "low", action: "proceed", confidence: 0.95, reasons: ["a docs remedy for a measured gate cost"], judgedAt: CLOCK.iso() };

test("the ruled-shard rewrite refuses a proceed that lint-plan's machine-filing admission would refuse at verify auto", (t) => {
  const root = planRoot(t, { "w1-t9893-dep.yaml": dependency, "w1-t9894-remedy.yaml": dependentRemedy("W1-T9894", DEP) });
  const plan = loadPlan(join(root, "plan", "tasks.yaml"));
  const rel = "plan/tasks.d/w1-t9894-remedy.yaml";
  const text = dependentRemedy("W1-T9894", DEP);
  const record = parseTasksFromYaml(text, rel)[0]!;
  const pin = taskRulingPin({ ...record, verify: "auto" });
  const admission = { plan, pathExists: (p: string) => p === DOC };

  const released = renderRuledShard(text, rel, pin, proceed, plan.byId, admission);
  assert.ok("refused" in released, "a proceed the admission refuses is not rendered");
  assert.equal(released.lint, true, "it is refused the way a lint refusal is, which the pass turns into an escalation");
  assert.match(released.refused, /machine-filing admission refuses it \(.*unmerged dependencies: W1-T9893/);

  const escalated = renderRuledShard(text, rel, pin, { ...proceed, action: "escalate" }, plan.byId, admission);
  assert.ok("contents" in escalated, "the escalation it becomes renders: the record's own parked reason is not introduced by the ruling");
  const after = parseTasksFromYaml(escalated.contents, rel)[0]!;
  assert.deepEqual(
    machineFilingAdmissionViolations(after, { plan, releasedIds: new Set(), pathExists: admission.pathExists }),
    machineFilingAdmissionViolations(record, { plan, releasedIds: new Set(), pathExists: admission.pathExists }),
    "the escalation adds no admission reason the filed record did not already carry",
  );
});

test("a judge pass escalates a proceed lint-plan's machine-filing admission refuses, naming the unmerged dependency", async (t) => {
  const root = planRoot(t, { "w1-t9893-dep.yaml": dependency, "w1-t9895-remedy.yaml": dependentRemedy("W1-T9895", DEP) });
  const proposals: Proposal[] = [];
  const report = await runMachineFilingJudge({
    stateDir: root,
    plan: () => loadPlan(join(root, "plan", "tasks.yaml")),
    riskJudge: async () => ({ verdict: "low", confidence: 0.95, reasons: ["a docs remedy for a measured gate cost"] }),
    writeRoot: root,
    stageProposal: (p) => void proposals.push(p),
    log: () => {},
    clock: CLOCK,
  });

  assert.deepEqual(report.proceeded, [], "the release lint-plan would refuse is never offered for landing");
  assert.deepEqual(report.escalated, ["W1-T9895"]);
  assert.equal(proposals.length, 1);
  assert.match(proposals[0]!.summary, /the judge said proceed, but W1-T9895: at verify: auto lint-plan's machine-filing admission refuses it/);
  const after = loadPlan(join(root, "plan", "tasks.yaml")).byId.get("W1-T9895")!;
  assert.equal(after.verify, "human");
  assert.equal(after.risk_ruling?.action, "escalate");
});
