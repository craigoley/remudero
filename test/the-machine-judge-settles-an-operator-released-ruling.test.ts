/**
 * W1-T5406. W1-T5359 settles a ruling main already carries by comparing the rendered shard with the
 * landing tree byte for byte. A cached machine ruling re-renders identically, but an operator release
 * (`rmd approve`) is rebuilt every pass with `judgedAt: ports.clock.iso()` and never cached, so once
 * main carries it the lagging daemon checkout renders it again with a newer `judged_at:` and opens a PR
 * that only bumps a timestamp.
 *
 * These tests pin the repair: a released ruling that differs from main only in `judged_at` is settled
 * and ledgered `machine_judge.already_landed`; one that differs in any other field still lands; and a
 * machine ruling keeps the exact byte comparison.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock, type Clock } from "../src/lib/clock.js";
import type { GardenCheckout } from "../src/lib/gardener.js";
import { machineShardHeaderLines } from "../src/lib/machine-filing.js";
import { MACHINE_JUDGE_STATE_FILE, runMachineFilingJudge, type MachineJudgePorts } from "../src/lib/machine-filing-judge.js";
import { loadPlan } from "../src/lib/plan.js";
import type { RiskJudgeVerdict } from "../src/lib/risk-judge.js";
import { taskRulingPin } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const EARLIER = fixedClock(1790980000000);
const LATER = fixedClock(1790990000000);

function machineShard(id: string): string {
  const files = ["docs/ci-friction-remedies.md"];
  return [
    `- id: ${id}`,
    `  title: ${JSON.stringify(`record the remedy for ${id}`)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    ...machineShardHeaderLines(files),
    // Priced, so a release never inserts a priority and only the ruling block can differ.
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

/** Every workspace is a fresh copy of `main`; `land` merges its paths into `main` and, like `git
 *  commit` with nothing staged, throws when no path changed. */
function landingOnto(main: string) {
  const lands: string[][] = [];
  const openWorkspace = (): GardenCheckout => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}operator-release-landing-`));
    cpSync(join(main, "plan"), join(root, "plan"), { recursive: true });
    return {
      root,
      land: ({ paths }) => {
        lands.push(paths);
        const changed = paths.filter((p) => readFileSync(join(root, p), "utf8") !== readFileSync(join(main, p), "utf8"));
        if (changed.length === 0) throw new Error("Command failed: git commit (exit 1)");
        for (const p of changed) writeFileSync(join(main, p), readFileSync(join(root, p), "utf8"));
        return `https://github.com/o/r/pull/${8800 + lands.length}`;
      },
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  };
  return { openWorkspace, lands };
}

const low = async (): Promise<RiskJudgeVerdict> => ({ verdict: "low", confidence: 0.95, reasons: ["a docs remedy"] });

interface Pass {
  stateDir: string;
  clock: Clock;
  released?: string[];
}

/** One pass over the daemon's STALE checkout, landing onto `main`. */
function judge(stale: string, landing: ReturnType<typeof landingOnto>) {
  return async ({ stateDir, clock, released }: Pass) => {
    const logs: { step: string; extra?: Record<string, unknown> }[] = [];
    const p: MachineJudgePorts = {
      stateDir,
      plan: () => loadPlan(join(stale, "plan", "tasks.yaml")),
      riskJudge: low,
      openWorkspace: landing.openWorkspace,
      prState: () => "merged",
      stageProposal: () => undefined,
      log: (step, extra) => void logs.push({ step, extra }),
      clock,
      ...(released ? { operatorReleases: () => new Set(released) } : {}),
    };
    return { report: await runMachineFilingJudge(p), logs };
  };
}

const SHARD = "plan/tasks.d/W1-T9600-x.yaml";

function fixture(prefix: string) {
  const stale = tree(`${prefix}-stale`, { "W1-T9600-x.yaml": machineShard("W1-T9600") });
  const main = tree(`${prefix}-main`, { "W1-T9600-x.yaml": machineShard("W1-T9600") });
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}-state-`));
  const landing = landingOnto(main);
  return { stale, main, stateDir, pass: judge(stale, landing), lands: () => landing.lands.length, dirs: [stale, main, stateDir] };
}

test("an operator-released ruling main carries with an earlier judged_at is settled and lands nothing", async () => {
  const f = fixture("operator-release-settles");
  try {
    const first = await f.pass({ stateDir: f.stateDir, clock: EARLIER, released: ["W1-T9600"] });
    assert.deepEqual(first.report.proceeded, ["W1-T9600"]);
    assert.equal(f.lands(), 1);
    const onMain = loadPlan(join(f.main, "plan", "tasks.yaml")).byId.get("W1-T9600")!;
    assert.equal(onMain.risk_ruling?.verdict, "operator");
    assert.equal(onMain.risk_ruling?.judged_at, EARLIER.iso());
    const mainText = readFileSync(join(f.main, SHARD), "utf8");

    // The PR merged; the stale plan still reads the record as released and due, an hour later.
    const second = await f.pass({ stateDir: f.stateDir, clock: LATER, released: ["W1-T9600"] });
    assert.equal(f.lands(), 1, "the released record is not landed again");
    assert.equal(second.report.prUrl, undefined, "no PR that only bumps judged_at");
    assert.deepEqual(second.report.proceeded, []);
    assert.deepEqual(second.report.failed, []);
    assert.deepEqual(second.report.settled, ["W1-T9600"]);
    const row = second.logs.find((l) => l.step === "machine_judge.already_landed");
    assert.equal(row?.extra?.task_id, "W1-T9600");
    assert.equal(row?.extra?.pin, onMain.risk_ruling!.pin);
    assert.ok(!second.logs.some((l) => l.step === "machine_judge.landed"));
    assert.equal(readFileSync(join(f.main, SHARD), "utf8"), mainText, "main keeps its earlier judged_at");

    const state = JSON.parse(readFileSync(join(f.stateDir, MACHINE_JUDGE_STATE_FILE), "utf8")) as { settled?: Record<string, string> };
    const staleTask = loadPlan(join(f.stale, "plan", "tasks.yaml")).byId.get("W1-T9600")!;
    assert.equal(state.settled?.["W1-T9600"], taskRulingPin(staleTask), "settled by the pin it was judged at");

    const third = await f.pass({ stateDir: f.stateDir, clock: LATER, released: ["W1-T9600"] });
    assert.deepEqual(third.logs, [], "a settled release is not rendered again");
    assert.equal(f.lands(), 1);
  } finally {
    for (const d of f.dirs) rmSync(d, { recursive: true, force: true });
  }
});

test("an operator-released ruling that differs from main in any field but judged_at still lands", async () => {
  // A different reason on main: the release restores its own.
  const edited = fixture("operator-release-reasons");
  try {
    await edited.pass({ stateDir: edited.stateDir, clock: EARLIER, released: ["W1-T9600"] });
    const path = join(edited.main, SHARD);
    writeFileSync(path, readFileSync(path, "utf8").replace("released by the operator with rmd approve", "released by hand"));
    const again = await edited.pass({ stateDir: edited.stateDir, clock: LATER, released: ["W1-T9600"] });
    assert.deepEqual(again.report.proceeded, ["W1-T9600"]);
    assert.deepEqual(again.report.settled, []);
    assert.equal(edited.lands(), 2);
    const onMain = loadPlan(join(edited.main, "plan", "tasks.yaml")).byId.get("W1-T9600")!;
    assert.deepEqual(onMain.risk_ruling?.reasons, ["released by the operator with rmd approve"]);
    assert.equal(onMain.risk_ruling?.judged_at, LATER.iso());
  } finally {
    for (const d of edited.dirs) rmSync(d, { recursive: true, force: true });
  }

  // A machine verdict on main: the operator's release replaces it.
  const machine = fixture("operator-release-verdict");
  try {
    await machine.pass({ stateDir: machine.stateDir, clock: EARLIER });
    assert.equal(loadPlan(join(machine.main, "plan", "tasks.yaml")).byId.get("W1-T9600")!.risk_ruling?.verdict, "low");
    const released = await machine.pass({ stateDir: machine.stateDir, clock: LATER, released: ["W1-T9600"] });
    assert.deepEqual(released.report.proceeded, ["W1-T9600"]);
    assert.deepEqual(released.report.settled, []);
    assert.equal(machine.lands(), 2);
    assert.equal(loadPlan(join(machine.main, "plan", "tasks.yaml")).byId.get("W1-T9600")!.risk_ruling?.verdict, "operator");
  } finally {
    for (const d of machine.dirs) rmSync(d, { recursive: true, force: true });
  }
});

test("a machine ruling keeps the exact byte comparison, so a fresh judged_at still lands", async () => {
  const f = fixture("machine-ruling-exact");
  const fresh = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-ruling-exact-fresh-state-`));
  try {
    await f.pass({ stateDir: f.stateDir, clock: EARLIER });
    assert.equal(f.lands(), 1);
    // No cached ruling to reuse: the judge rules afresh at a later time on the same record.
    const second = await f.pass({ stateDir: fresh, clock: LATER });
    assert.deepEqual(second.report.settled, [], "only an operator release ignores judged_at");
    assert.deepEqual(second.report.proceeded, ["W1-T9600"]);
    assert.equal(f.lands(), 2);
    assert.equal(loadPlan(join(f.main, "plan", "tasks.yaml")).byId.get("W1-T9600")!.risk_ruling?.judged_at, LATER.iso());
  } finally {
    for (const d of [...f.dirs, fresh]) rmSync(d, { recursive: true, force: true });
  }
});
