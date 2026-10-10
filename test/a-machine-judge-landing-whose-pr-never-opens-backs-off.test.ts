// MEASURED 2026-10-10 on the fleet host: the machine-filing judge re-landed the same six reused rulings every ~60 s.
// Each landing's plan-PR preflight refused it (lint-plan: proof-test-only-discrimination), so no PR opened, yet the
// pass still counted its six `proceeded` ids as new work. Its pacing record read lastPassAt == lastNewAt, so every
// poll booted a ~500 MB garden child for ~40 s and cut a fresh worktree, where the preflight ran six check-proof
// children and the shard census. A landing whose PR never opens moved nothing; the pass must back off like any
// other quiet pass, and a landing that does open its PR must still count.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clockFromMillisFn } from "../src/lib/clock.js";
import { gardenPacingDue, recordGardenPacing } from "../src/lib/garden-registry.js";
import type { GardenCheckout } from "../src/lib/gardener.js";
import { machineShardHeaderLines } from "../src/lib/machine-filing.js";
import { machineJudgeFoundWork, runMachineFilingJudge, type MachineJudgePorts } from "../src/lib/machine-filing-judge.js";
import { loadPlan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const MINUTE = 60_000;

function machineShard(id: string): string {
  const files = ["docs/ci-friction-remedies.md"];
  return [
    `- id: ${id}`,
    `  title: ${JSON.stringify(`record the remedy for ${id}`)}`,
    "  repo: remudero",
    "  depends_on: []",
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

function scratch(t: { after: (fn: () => void) => void }, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Every pass gets a fresh copy of the plan to land from; `land` answers what the plan-PR preflight let through. */
function landingTrees(plan: string, opened: () => string | undefined) {
  const lands: string[][] = [];
  const openWorkspace = (): GardenCheckout => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-landing-`));
    cpSync(join(plan, "plan"), join(root, "plan"), { recursive: true });
    return {
      root,
      land: ({ paths }) => {
        lands.push(paths);
        return opened();
      },
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  };
  return { openWorkspace, lands };
}

function judgePorts(plan: string, stateDir: string, now: () => number, openWorkspace: () => GardenCheckout): MachineJudgePorts {
  return {
    stateDir,
    plan: () => loadPlan(join(plan, "plan", "tasks.yaml")),
    riskJudge: async () => ({ verdict: "low", confidence: 0.9, reasons: ["a docs remedy for a measured gate cost"] }),
    openWorkspace,
    prState: () => "open",
    stageProposal: () => undefined,
    log: () => undefined,
    clock: clockFromMillisFn(now),
  };
}

function seededPlan(t: { after: (fn: () => void) => void }): string {
  const plan = scratch(t, "judge-plan");
  mkdirSync(join(plan, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(plan, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(plan, "plan", "tasks.d", "W1-T9700-x.yaml"), machineShard("W1-T9700"));
  return plan;
}

test("a judge pass whose landing PR never opens is no new work, so an hour of polls backs off instead of re-landing every minute", async (t) => {
  const plan = seededPlan(t);
  const stateDir = scratch(t, "judge-state");
  let now = Date.parse("2026-10-10T15:00:00Z");
  const landing = landingTrees(plan, () => undefined);
  const ports = judgePorts(plan, stateDir, () => now, landing.openWorkspace);
  const pacing = { clock: clockFromMillisFn(() => now), inputs: () => "plan-tree-a" };

  const first = await runMachineFilingJudge(ports);
  assert.deepEqual(first.proceeded, ["W1-T9700"], "the ruling was rendered and handed to the landing");
  assert.equal(first.prUrl, undefined, "the preflight refused: no PR opened");
  assert.deepEqual(first.unlanded, ["W1-T9700"]);
  assert.equal(machineJudgeFoundWork(first), false, "a refused landing moved nothing");
  recordGardenPacing(stateDir, "machine-judge", machineJudgeFoundWork(first), { clock: pacing.clock, inputs: pacing.inputs() });

  // The daemon polls every minute; the garden pass runs only when its pacing is due, as the registered pass does.
  let passes = 1;
  const waits: number[] = [];
  let lastPass = now;
  for (let minute = 1; minute <= 60; minute++) {
    now += MINUTE;
    if (!gardenPacingDue(stateDir, "machine-judge", pacing)) continue;
    const report = await runMachineFilingJudge(ports);
    assert.deepEqual(report.unlanded, ["W1-T9700"], "the reused ruling is offered again and refused again");
    recordGardenPacing(stateDir, "machine-judge", machineJudgeFoundWork(report), { clock: pacing.clock, inputs: pacing.inputs() });
    passes += 1;
    waits.push(now - lastPass);
    lastPass = now;
  }
  assert.equal(landing.lands.length, passes, "every pass that ran attempted the landing once");
  assert.ok(passes < 61, `an hour of refused landings cost ${passes} passes, not one per poll`);
  assert.ok(waits.at(-1)! > waits[0]!, `the wait grows while every landing is refused: ${waits.join(", ")}`);
  assert.equal(gardenPacingDue(stateDir, "machine-judge", { ...pacing, inputs: () => "plan-tree-b" }), true, "a new plan tree is due at once");
});

test("a landing whose PR opens is still new work, and an unlanded id never hides a refused or settled record", async (t) => {
  const plan = seededPlan(t);
  const stateDir = scratch(t, "judge-state");
  const landing = landingTrees(plan, () => "https://github.com/o/r/pull/9700");
  const report = await runMachineFilingJudge(judgePorts(plan, stateDir, () => Date.parse("2026-10-10T15:00:00Z"), landing.openWorkspace));
  assert.equal(report.prUrl, "https://github.com/o/r/pull/9700");
  assert.equal(report.unlanded, undefined);
  assert.equal(machineJudgeFoundWork(report), true, "an opened PR is new work");

  const empty = { proceeded: [], escalated: [], unavailable: [], refused: [], failed: [], settled: [] };
  assert.equal(machineJudgeFoundWork({ ...empty, proceeded: ["W1-T1", "W1-T2"], unlanded: ["W1-T1"] }), true, "a ruling outside the refused landing still counts");
  assert.equal(machineJudgeFoundWork({ ...empty, escalated: ["W1-T1"], unlanded: ["W1-T1"] }), false);
  assert.equal(machineJudgeFoundWork({ ...empty, refused: ["W1-T3"], unlanded: ["W1-T1"] }), true);
  assert.equal(machineJudgeFoundWork({ ...empty, settled: ["W1-T4"], unlanded: ["W1-T1"] }), true);
});
