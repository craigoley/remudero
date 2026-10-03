/**
 * W1-T5359. From 19:09Z 2026-10-02 the daemon's machine-filing judge re-landed W1-T5309's ruling,
 * already merged as #8723, at least 38 times. The judge reads its plan from the daemon's own checkout,
 * which lags main, while its landing tree is cut from a fresh origin/main. So the stale plan still said
 * the record needed judging, the cached ruling was reused, and `renderRuledShard` rendered exactly the
 * bytes main already held. `ws.land` then ran `git commit` with nothing staged, which exits 1, and each
 * failed attempt held the daemon's main thread for 85-241 s.
 *
 * These tests pin the repair: a rendered shard byte-identical to the landing tree's record is settled,
 * not landed; it is ledgered `machine_judge.already_landed`; a later pass over the same stale plan does
 * not render it again; and a ruling that does change its record still lands.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { GardenCheckout } from "../src/lib/gardener.js";
import { machineShardHeaderLines } from "../src/lib/machine-filing.js";
import { MACHINE_JUDGE_STATE_FILE, runMachineFilingJudge, type MachineJudgePorts } from "../src/lib/machine-filing-judge.js";
import { loadPlan } from "../src/lib/plan.js";
import type { RiskJudgeVerdict } from "../src/lib/risk-judge.js";
import { taskRulingPin } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const CLOCK = fixedClock(1790980000000);

function machineShard(id: string): string {
  const files = ["docs/ci-friction-remedies.md"];
  return [
    `- id: ${id}`,
    `  title: ${JSON.stringify(`record the remedy for ${id}`)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    ...machineShardHeaderLines(files),
    // Priced, like W1-T5309: a release never inserts a priority, so a re-render is byte-identical.
    "  priority: 1",
    `  origin: ${JSON.stringify(`ci-friction:${id}`)}`,
    "  files:",
    ...files.map((f) => `    - ${f}`),
    "  acceptance:",
    `    - claim: "the remedy for ${id} is recorded"`,
    `      proof: "grep: ${id} in ${files[0]}"`,
    "",
  ].join("\n");
}

function tree(prefix: string, shards: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}-`));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  for (const [name, text] of Object.entries(shards)) writeFileSync(join(root, "plan", "tasks.d", name), text);
  return root;
}

/**
 * The daemon's landing: every workspace is a fresh copy of `main`, and `land` merges its paths into
 * `main` at once. Like `git commit` with nothing staged, a land that changes no path throws.
 */
function landingOnto(main: string) {
  const lands: string[][] = [];
  let opened = 0;
  const openWorkspace = (): GardenCheckout => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-landing-`));
    cpSync(join(main, "plan"), join(root, "plan"), { recursive: true });
    opened += 1;
    return {
      root,
      land: ({ paths }) => {
        lands.push(paths);
        const changed = paths.filter((p) => readFileSync(join(root, p), "utf8") !== readFileSync(join(main, p), "utf8"));
        if (changed.length === 0) throw new Error("Command failed: git commit (exit 1)");
        for (const p of changed) writeFileSync(join(main, p), readFileSync(join(root, p), "utf8"));
        return `https://github.com/o/r/pull/${8700 + lands.length}`;
      },
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  };
  return { openWorkspace, lands, opened: () => opened };
}

const low = async (): Promise<RiskJudgeVerdict> => ({ verdict: "low", confidence: 0.95, reasons: ["a docs remedy"] });
/** W1-T5309's ruling was an escalation: it stays `verify: human`, pinned, and the plan keeps re-offering it. */
const high = async (): Promise<RiskJudgeVerdict> => ({ verdict: "high", confidence: 0.95, reasons: ["it changes a coverage gate"] });

test("a ruling main already carries is settled, not landed, and a stale plan does not render it again", async () => {
  const stale = tree("machine-judge-stale-checkout", { "W1-T9500-x.yaml": machineShard("W1-T9500") });
  const main = tree("machine-judge-main", { "W1-T9500-x.yaml": machineShard("W1-T9500") });
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-state-`));
  const landing = landingOnto(main);
  let asked = 0;
  const pass = async () => {
    const logs: { step: string; extra?: Record<string, unknown> }[] = [];
    const p: MachineJudgePorts = {
      stateDir,
      // The daemon's own checkout: it never catches up with main in this suite.
      plan: () => loadPlan(join(stale, "plan", "tasks.yaml")),
      riskJudge: async () => (asked++, high()),
      openWorkspace: landing.openWorkspace,
      prState: () => "merged",
      stageProposal: () => undefined,
      log: (step, extra) => void logs.push({ step, extra }),
      clock: CLOCK,
    };
    return { report: await runMachineFilingJudge(p), logs };
  };
  try {
    // Pass 1: the ruling changes the record, so it lands and main now carries it.
    const first = await pass();
    assert.deepEqual(first.report.escalated, ["W1-T9500"]);
    assert.deepEqual(landing.lands, [["plan/tasks.d/W1-T9500-x.yaml"]], "a ruling that changes its record lands");
    const onMain = loadPlan(join(main, "plan", "tasks.yaml")).byId.get("W1-T9500")!;
    assert.equal(onMain.verify, "human");
    assert.equal(onMain.risk_ruling?.action, "escalate");
    const mainText = readFileSync(join(main, "plan", "tasks.d", "W1-T9500-x.yaml"), "utf8");

    // Pass 2: the PR merged, but the plan still reads the stale, unjudged record. A second record
    // filed meanwhile shows the same pass still lands what main does not yet carry.
    for (const root of [stale, main]) writeFileSync(join(root, "plan", "tasks.d", "W1-T9501-x.yaml"), machineShard("W1-T9501"));
    const second = await pass();
    assert.ok(second.logs.some((l) => l.step === "machine_judge.reused" && l.extra?.task_id === "W1-T9500"), "the stale plan re-offers it");
    assert.deepEqual(second.report.failed, []);
    assert.deepEqual(second.report.settled, ["W1-T9500"], "counted as settled, not failed or refused");
    assert.deepEqual(second.report.refused, []);
    assert.deepEqual(second.report.escalated, ["W1-T9501"]);
    assert.deepEqual(landing.lands[1], ["plan/tasks.d/W1-T9501-x.yaml"], "the settled path is never handed to land");
    assert.ok(!second.logs.some((l) => l.step === "machine_judge.failed"));
    const settledRow = second.logs.find((l) => l.step === "machine_judge.already_landed");
    assert.equal(settledRow?.extra?.task_id, "W1-T9500");
    assert.equal(settledRow?.extra?.pin, onMain.risk_ruling!.pin, "the row names the pin main carries");
    assert.equal(readFileSync(join(main, "plan", "tasks.d", "W1-T9500-x.yaml"), "utf8"), mainText, "main is untouched");

    const state = JSON.parse(readFileSync(join(stateDir, MACHINE_JUDGE_STATE_FILE), "utf8")) as {
      rulings?: Record<string, unknown>;
      settled?: Record<string, string>;
    };
    assert.equal(state.rulings?.["W1-T9500"], undefined, "the cached ruling is dropped");
    const staleTask = loadPlan(join(stale, "plan", "tasks.yaml")).byId.get("W1-T9500")!;
    assert.equal(state.settled?.["W1-T9500"], taskRulingPin(staleTask), "settled by the pin it was judged at");

    // Pass 3: the plan is still stale, yet the settled record is neither re-rendered nor landed. The
    // record landed last pass is now on main too, so it settles in its turn.
    const third = await pass();
    assert.ok(!third.logs.some((l) => l.extra?.task_id === "W1-T9500"), "no reuse, no render, no row for a settled record");
    assert.deepEqual(third.report.settled, ["W1-T9501"]);
    assert.equal(landing.lands.length, 2, "nothing new lands");

    // Pass 4: with both settled, nothing is due, so no landing tree is even cut.
    const opened = landing.opened();
    const fourth = await pass();
    assert.deepEqual(fourth.logs.map((l) => l.step), [], "a quiet pass writes no rows");
    assert.equal(landing.opened(), opened, "with nothing due, no landing tree is cut");
    assert.equal(asked, 2, "one model call per record, ever");

    // Once its record changes, its pin changes and the judge rules on it again.
    writeFileSync(join(stale, "plan", "tasks.d", "W1-T9500-x.yaml"), machineShard("W1-T9500").replace("record the remedy", "rewrite the remedy"));
    const fifth = await pass();
    assert.ok(fifth.logs.some((l) => l.step === "machine_judge.ruled" && l.extra?.task_id === "W1-T9500"), "an edited record is judged again");
    assert.equal(asked, 3);
  } finally {
    for (const d of [stale, main, stateDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("a pass whose only due ruling main already carries opens no PR and leaves nothing pending", async () => {
  const stale = tree("machine-judge-stale-only", { "W1-T9510-x.yaml": machineShard("W1-T9510") });
  const main = tree("machine-judge-main-only", { "W1-T9510-x.yaml": machineShard("W1-T9510") });
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-state-only-`));
  const landing = landingOnto(main);
  const ports = (logs: string[]): MachineJudgePorts => ({
    stateDir,
    plan: () => loadPlan(join(stale, "plan", "tasks.yaml")),
    riskJudge: low,
    openWorkspace: landing.openWorkspace,
    prState: () => "merged",
    stageProposal: () => undefined,
    log: (step) => void logs.push(step),
    clock: CLOCK,
  });
  try {
    await runMachineFilingJudge(ports([]));
    assert.equal(landing.lands.length, 1);
    const logs: string[] = [];
    const report = await runMachineFilingJudge(ports(logs));
    assert.equal(report.prUrl, undefined, "no PR is opened");
    assert.equal(landing.lands.length, 1, "land is never called");
    assert.deepEqual(report.settled, ["W1-T9510"]);
    assert.ok(logs.includes("machine_judge.already_landed"));
    assert.ok(!logs.includes("machine_judge.landed"));
    const state = JSON.parse(readFileSync(join(stateDir, MACHINE_JUDGE_STATE_FILE), "utf8")) as { pending?: unknown };
    assert.equal(state.pending, undefined, "nothing is left pending on a PR that was never opened");
  } finally {
    for (const d of [stale, main, stateDir]) rmSync(d, { recursive: true, force: true });
  }
});
