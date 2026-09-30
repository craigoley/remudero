/**
 * 2026-09-30: the machine-filing judge failed every pass from 00:36Z on (217 failures) with
 * "task W1-T2635: depends_on unknown task 'W1-T2481'". The rewrite validated ONE shard in isolation,
 * so any record with a dependency threw, and the throw aborted the whole pass after every record had
 * already been ruled: 1,152 model calls re-ruled the same 19 records and nothing landed.
 *
 * These tests pin the three repairs: a record with a dependency is judged against the whole plan;
 * one record whose landing throws is ledgered and skipped while the rest land; and a record the
 * judge already ruled is not asked again while it is unchanged.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { machineShardHeaderLines, UNPRICED_PRIORITY } from "../src/lib/machine-filing.js";
import { renderRuledShard, runMachineFilingJudge, type MachineJudgePorts } from "../src/lib/machine-filing-judge.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RiskJudgeInput, RiskJudgeVerdict } from "../src/lib/risk-judge.js";
import { taskRulingPin } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const CLOCK = fixedClock(1790800000000);

function machineShard(id: string, dependsOn: string[] = []): string {
  const files = ["docs/ci-friction-remedies.md"];
  return [
    `- id: ${id}`,
    `  title: ${JSON.stringify(`record the remedy for ${id}`)}`,
    "  repo: remudero",
    `  depends_on: [${dependsOn.join(", ")}]`,
    "  type: implement",
    ...machineShardHeaderLines(files),
    `  origin: ${JSON.stringify(`ci-friction:${id}`)}`,
    "  files:",
    ...files.map((f) => `    - ${f}`),
    "  acceptance:",
    `    - claim: "the remedy for ${id} is recorded"`,
    `      proof: "grep: ${id} in ${files[0]}"`,
    "",
  ].join("\n");
}

/** An operator record another shard depends on: already merged, so it is never itself judged. */
const mergedOperatorShard = (id: string): string =>
  [`- id: ${id}`, `  title: "an operator record ${id}"`, "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: merged", ""].join("\n");

function planTree(shards: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-bad-record-`));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  for (const [name, text] of Object.entries(shards)) writeFileSync(join(root, "plan", "tasks.d", name), text);
  return root;
}

const readPlan = (root: string): Plan => loadPlan(join(root, "plan", "tasks.yaml"));
const low = async (): Promise<RiskJudgeVerdict> => ({ verdict: "low", confidence: 0.95, reasons: ["a docs remedy"] });

function judgePorts(planRoot: string, writeRoot: string, judge: (input: RiskJudgeInput) => Promise<RiskJudgeVerdict>) {
  const logs: { step: string; extra?: Record<string, unknown> }[] = [];
  const p: MachineJudgePorts = {
    stateDir: planRoot,
    plan: () => readPlan(planRoot),
    riskJudge: judge,
    writeRoot,
    stageProposal: () => undefined,
    log: (step, extra) => void logs.push({ step, extra }),
    clock: CLOCK,
  };
  return { p, logs };
}

test("a machine record whose depends_on names a task in another shard is judged and lands", async () => {
  const root = planTree({ "W1-T9300-x.yaml": mergedOperatorShard("W1-T9300"), "W1-T9301-x.yaml": machineShard("W1-T9301", ["W1-T9300"]) });
  try {
    const report = await runMachineFilingJudge(judgePorts(root, root, low).p);
    assert.deepEqual(report.proceeded, ["W1-T9301"], "the dependency resolves against the whole plan");
    const task = readPlan(root).byId.get("W1-T9301")!;
    assert.equal(task.verify, "auto");
    assert.equal(task.risk_ruling?.pin, taskRulingPin(task));
    assert.deepEqual(task.depends_on, ["W1-T9300"]);

    const text = machineShard("W1-T9302", ["W1-T9399"]);
    const refused = renderRuledShard(text, "plan/tasks.d/W1-T9302-x.yaml", "pin", { verdict: "low", action: "proceed", confidence: 0.9, reasons: ["r"], judgedAt: CLOCK.iso() }, readPlan(root).byId);
    assert.match(String((refused as { refused?: string }).refused), /depends_on unknown task 'W1-T9399'/, "a dependency the whole plan lacks is refused and never thrown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one record whose landing throws is ledgered and skipped while the rest of the pass lands", async () => {
  const root = planTree({ "W1-T9310-x.yaml": machineShard("W1-T9310"), "W1-T9311-x.yaml": machineShard("W1-T9311") });
  const landing = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-landing-`));
  try {
    cpSync(join(root, "plan"), join(landing, "plan"), { recursive: true });
    writeFileSync(join(landing, "plan", "tasks.d", "W1-T9310-x.yaml"), "- id: W1-T9310\n  title: [unclosed\n");
    const { p, logs } = judgePorts(root, landing, low);
    const report = await runMachineFilingJudge(p);
    assert.deepEqual(report.failed, ["W1-T9310"]);
    assert.deepEqual(report.proceeded, ["W1-T9311"], "the bad record did not abort the others");
    assert.match(readFileSync(join(landing, "plan", "tasks.d", "W1-T9311-x.yaml"), "utf8"), /^ {2}verify: auto$/m);
    const failed = logs.find((l) => l.step === "machine_judge.record_failed");
    assert.equal(failed?.extra?.task_id, "W1-T9310");
    assert.ok(String(failed?.extra?.error).length > 0, "the ledger row carries the reason");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(landing, { recursive: true, force: true });
  }
});

test("an unchanged record the judge already ruled costs zero model calls on the next pass", async () => {
  const root = planTree({ "W1-T9320-x.yaml": machineShard("W1-T9320") });
  const landing = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-landing-`));
  const good = join(root, "plan", "tasks.d", "W1-T9320-x.yaml");
  try {
    cpSync(join(root, "plan"), join(landing, "plan"), { recursive: true });
    writeFileSync(join(landing, "plan", "tasks.d", "W1-T9320-x.yaml"), "- id: W1-T9320\n  title: [unclosed\n");
    let asked = 0;
    const counting = async () => (asked++, low());
    const first = await runMachineFilingJudge(judgePorts(root, landing, counting).p);
    assert.deepEqual(first.failed, ["W1-T9320"]);
    assert.equal(asked, 1);

    const second = judgePorts(root, landing, counting);
    await runMachineFilingJudge(second.p);
    assert.equal(asked, 1, "the ruling is reused while the record is unchanged");
    assert.ok(second.logs.some((l) => l.step === "machine_judge.reused"));
    assert.ok(!second.logs.some((l) => l.step === "machine_judge.ruled"), "no model ruling is ledgered for a reuse");

    writeFileSync(join(landing, "plan", "tasks.d", "W1-T9320-x.yaml"), readFileSync(good, "utf8"));
    const third = await runMachineFilingJudge(judgePorts(root, landing, counting).p);
    assert.deepEqual(third.proceeded, ["W1-T9320"], "the reused ruling lands once the tree can take it");
    assert.equal(asked, 1);
    const released = readPlan(landing).byId.get("W1-T9320")!;
    assert.equal(released.priority, UNPRICED_PRIORITY, "a release on the reused path still carries a priority");

    writeFileSync(good, readFileSync(good, "utf8").replace("record the remedy for W1-T9320", "rewrite the remedy for W1-T9320"));
    await runMachineFilingJudge(judgePorts(root, landing, counting).p);
    assert.equal(asked, 2, "an edited record is asked again");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(landing, { recursive: true, force: true });
  }
});
