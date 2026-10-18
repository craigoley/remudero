/**
 * An operator release (`rmd approve`) bypasses the judge's `declined` map, because a release is the
 * operator's own bit and must always be honoured. A release whose `verify: auto` rewrite the linter
 * refuses (a ruling-shaped record: it declares DECISIONS.md, which ruling-verify keeps at
 * `verify: human`) was therefore refused and re-rendered every pass: W1-T5717 was released 2026-10-13
 * and ledgered ~515 identical `machine_judge.refused` rows in a day, each pass opening and disposing a
 * landing worktree and counting as found work, so the judge's pacing never widened.
 *
 * These tests pin the repair: the first pass refuses the release once, stages one inbox proposal that
 * says why, and marks the row as an operator release; an unchanged record is then not rendered again,
 * opens no workspace and is not found work; an edited record (a new pin) is taken again.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import type { GardenCheckout } from "#src/lib/gardener.js";
import {
  MACHINE_JUDGE_STATE_FILE,
  machineJudgeFoundWork,
  runMachineFilingJudge,
  type MachineJudgePorts,
} from "#src/lib/machine-filing-judge.js";
import type { Proposal } from "#src/lib/inbox.js";
import { loadPlan } from "#src/lib/plan.js";
import type { RiskJudgeVerdict } from "#src/lib/risk-judge.js";
import { taskRulingPin } from "#src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const CLOCK = fixedClock(1790980000000);
const ID = "W1-T9601";
const SHARD = `plan/tasks.d/${ID}-x.yaml`;

/** An operator-filed ruling-shaped record: it declares DECISIONS.md, so it must stay verify: human. */
function rulingShard(title: string): string {
  return [
    `- id: ${ID}`,
    `  title: ${JSON.stringify(title)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: human  # ruling-verify: it stamps the status of an operator ruling",
    "  priority: 3",
    "  files: [DECISIONS.md, test/every-decisions-entry-carries-a-status.test.ts]",
    "  status: queued",
    "  acceptance:",
    '    - claim: "every DECISIONS.md entry carries a status"',
    '      proof: "unit test: test/every-decisions-entry-carries-a-status.test.ts"',
    "",
  ].join("\n");
}

function fixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}-`));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(root, SHARD), rulingShard("every DECISIONS.md entry carries a status"));
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}-state-`));
  let workspaces = 0;
  const proposals: Proposal[] = [];
  const openWorkspace = (): GardenCheckout => {
    workspaces++;
    // The landing tree is the plan itself: a refused release writes nothing to it.
    return { root, land: () => assert.fail("a refused release lands nothing"), dispose: () => undefined };
  };
  const pass = async () => {
    const logs: { step: string; extra?: Record<string, unknown> }[] = [];
    const ports: MachineJudgePorts = {
      stateDir,
      plan: () => loadPlan(join(root, "plan", "tasks.yaml")),
      riskJudge: async (): Promise<RiskJudgeVerdict> => assert.fail("an operator release asks no model"),
      openWorkspace,
      prState: () => "merged",
      operatorReleases: () => new Set([ID]),
      stageProposal: (p) => void proposals.push(p),
      log: (step, extra) => void logs.push({ step, extra }),
      clock: CLOCK,
    };
    const report = await runMachineFilingJudge(ports);
    return { report, logs };
  };
  return { root, stateDir, pass, workspaces: () => workspaces, proposals, dirs: [root, stateDir] };
}

test("an operator release the linter refuses is refused once and staged as one inbox proposal", async () => {
  const f = fixture("release-refused-once");
  try {
    const before = readFileSync(join(f.root, SHARD), "utf8");
    const first = await f.pass();
    assert.deepEqual(first.report.refused, [ID]);
    assert.equal(f.workspaces(), 1);
    assert.equal(machineJudgeFoundWork(first.report), true, "the first refusal is news");
    const row = first.logs.find((l) => l.step === "machine_judge.refused");
    assert.equal(row?.extra?.task_id, ID);
    assert.equal(row?.extra?.operator_release, true);
    assert.match(String(row?.extra?.reason), /ruling-verify|DECISIONS\.md/);
    assert.equal(f.proposals.length, 1);
    assert.equal(f.proposals[0]!.id, `machine-judge-release:${ID}`);
    assert.match(f.proposals[0]!.summary, new RegExp(`rmd approve ${ID}`));
    assert.match(f.proposals[0]!.summary, /DECISIONS\.md/);
    assert.equal(readFileSync(join(f.root, SHARD), "utf8"), before, "the record is not rewritten");

    const state = JSON.parse(readFileSync(join(f.stateDir, MACHINE_JUDGE_STATE_FILE), "utf8")) as {
      refusedReleases?: Record<string, string>;
      declined?: Record<string, string>;
    };
    const task = loadPlan(join(f.root, "plan", "tasks.yaml")).byId.get(ID)!;
    assert.equal(state.refusedReleases?.[ID], taskRulingPin(task), "settled by the pin it was refused at");
    assert.equal(state.declined?.[ID], undefined, "a release is not recorded as a declined judge PR");
  } finally {
    for (const d of f.dirs) rmSync(d, { recursive: true, force: true });
  }
});

test("an unchanged released record the linter refused is not re-rendered and opens no workspace", async () => {
  const f = fixture("release-refused-not-rerendered");
  try {
    await f.pass();
    assert.equal(f.workspaces(), 1);
    const second = await f.pass();
    assert.ok(!second.logs.some((l) => l.step === "machine_judge.refused"), "no second refusal row");
    assert.deepEqual(second.report.refused, []);
    assert.equal(f.workspaces(), 1, "no landing worktree is opened for an unchanged refused release");
    assert.equal(machineJudgeFoundWork(second.report), false, "pacing widens: nothing new was found");
    assert.equal(f.proposals.length, 1, "the operator is told once");
  } finally {
    for (const d of f.dirs) rmSync(d, { recursive: true, force: true });
  }
});

test("an edited released record is taken again after a refusal", async () => {
  const f = fixture("release-refused-edited");
  try {
    await f.pass();
    writeFileSync(join(f.root, SHARD), rulingShard("every DECISIONS.md entry carries a status, checked in CI"));
    const edited = await f.pass();
    assert.deepEqual(edited.report.refused, [ID], "a new pin is judged again");
    assert.equal(f.workspaces(), 2);
    const state = JSON.parse(readFileSync(join(f.stateDir, MACHINE_JUDGE_STATE_FILE), "utf8")) as {
      refusedReleases?: Record<string, string>;
    };
    const task = loadPlan(join(f.root, "plan", "tasks.yaml")).byId.get(ID)!;
    assert.equal(state.refusedReleases?.[ID], taskRulingPin(task), "re-pinned at the edited record");
  } finally {
    for (const d of f.dirs) rmSync(d, { recursive: true, force: true });
  }
});
