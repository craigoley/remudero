/**
 * Operator ruling 2026-09-29: "There should be an LLM judge in the middle deciding what needs that
 * level of escalation and what can be automated."
 *
 * Every machine filer hard-coded `verify: human`, so 0 of the machine-filed tasks ever dispatched on
 * the record's own authority. These tests pin the four behaviours the ruling asks for: a proceed
 * ruling makes the record dispatchable; an escalate ruling parks it and reaches the inbox; a record
 * edited after judging is judged again; and a judge that fails writes nothing and is asked again.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import { runnableCandidates } from "../src/lib/drain.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { deterministicEscalation, machineShardHeaderLines, machineShardRisk, renderMachineShard } from "../src/lib/machine-filing.js";
import {
  earnedConfidenceBar,
  familyTrackRecord,
  gardenFamilyRecord,
  isRulingShaped,
  judgeMachineShard,
  MACHINE_JUDGE_STATE_FILE,
  readOperatorReleases,
  recordOperatorRelease,
  machineFamily,
  needsMachineJudgement,
  renderRuledShard,
  runMachineFilingJudge,
  startMachineFilingJudge,
  type MachineJudgePorts,
} from "../src/lib/machine-filing-judge.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import type { Proposal } from "../src/lib/inbox.js";
import { rotateLedger } from "../src/lib/ledger.js";
import { loadPlan, loadPlanFromYaml, RELEASE_LEDGER_STEP, releasedTaskIds, type Plan } from "../src/lib/plan.js";
import type { RiskJudgeInput, RiskJudgeVerdict } from "../src/lib/risk-judge.js";
import { selectorShadowMissTask } from "../src/lib/selector-shadow-gardener.js";
import { machineAuthorVerifyViolation, taskRulingPin } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { approveCommand, daemonCommand, parkedVerifyHumanShards, productionMachineFilingJudgePorts } from "../src/run-task.js";
import { releaseAutomatedShard } from "../src/lib/verify-human-release.js";
import { gitRepo } from "./helpers/git-repo.js";

const CLOCK = fixedClock(1790700000000);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function machineShard(id: string, over: { title?: string; files?: string[]; origin?: string } = {}): string {
  const files = over.files ?? ["docs/ci-friction-remedies.md"];
  return [
    `- id: ${id}`,
    `  title: ${JSON.stringify(over.title ?? `record the remedy for ${id}`)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    ...machineShardHeaderLines(files),
    `  origin: ${JSON.stringify(over.origin ?? `ci-friction:${id}`)}`,
    "  files:",
    ...files.map((f) => `    - ${f}`),
    "  acceptance:",
    `    - claim: "the remedy for ${id} is recorded"`,
    `      proof: "grep: ${id} in ${files[0]}"`,
    "",
  ].join("\n");
}

function planDir(shards: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-`));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  for (const [name, text] of Object.entries(shards)) writeFileSync(join(root, "plan", "tasks.d", name), text);
  return root;
}

const readPlan = (root: string): Plan => loadPlan(join(root, "plan", "tasks.yaml"));

function verdict(v: "low" | "high", confidence: number, reason = "a docs remedy for a measured gate cost"): RiskJudgeVerdict {
  return { verdict: v, confidence, reasons: [reason] };
}

function ports(root: string, judge: (input: RiskJudgeInput) => Promise<RiskJudgeVerdict>, extra: Partial<MachineJudgePorts> = {}) {
  const proposals: Proposal[] = [];
  const logs: { step: string; extra?: Record<string, unknown> }[] = [];
  const p: MachineJudgePorts = {
    stateDir: root,
    plan: () => readPlan(root),
    riskJudge: judge,
    writeRoot: root,
    stageProposal: (proposal) => void proposals.push(proposal),
    log: (step, e) => void logs.push({ step, extra: e }),
    clock: CLOCK,
    ...extra,
  };
  return { p, proposals, logs };
}

const dispatchable = (plan: Plan): string[] => runnableCandidates(plan, () => false, 50).map((t) => t.id);

test("a machine shard with a proceed ruling dispatches where the unjudged shard parks", async () => {
  const root = planDir({ "W1-T9001-x.yaml": machineShard("W1-T9001") });
  try {
    assert.deepEqual(dispatchable(readPlan(root)), [], "the control: an unjudged machine record is parked");
    const { p } = ports(root, async () => verdict("low", 0.9));
    const report = await runMachineFilingJudge(p);
    assert.deepEqual(report.proceeded, ["W1-T9001"]);
    const task = readPlan(root).byId.get("W1-T9001")!;
    assert.equal(task.verify, "auto");
    assert.equal(task.risk_ruling?.action, "proceed");
    assert.equal(task.risk_ruling?.pin, taskRulingPin(task));
    assert.equal(machineAuthorVerifyViolation(task), undefined, "the pinned ruling clears Law 5's arm");
    assert.deepEqual(dispatchable(readPlan(root)), ["W1-T9001"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an escalate ruling parks the machine shard and reaches the inbox with the judge's reasons", async () => {
  const root = planDir({ "W1-T9002-x.yaml": machineShard("W1-T9002") });
  try {
    const { p, proposals } = ports(root, async () => verdict("high", 0.9, "it rewrites the merge policy"));
    const report = await runMachineFilingJudge(p);
    assert.deepEqual(report.escalated, ["W1-T9002"]);
    const task = readPlan(root).byId.get("W1-T9002")!;
    assert.equal(task.verify, "human");
    assert.equal(task.risk_ruling?.action, "escalate");
    assert.equal(task.risk_ruling?.pin, taskRulingPin(task), "the escalation is pinned so it is not re-asked every pass");
    assert.deepEqual(dispatchable(readPlan(root)), []);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.id, "machine-judge:W1-T9002");
    assert.match(proposals[0]!.summary, /it rewrites the merge policy/);
    let asked = 0;
    await runMachineFilingJudge(ports(root, async () => (asked++, verdict("low", 0.9))).p);
    assert.equal(asked, 0, "a pinned escalation stays settled while the record is unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale pin re-judges the machine shard after its record is edited", async () => {
  const root = planDir({ "W1-T9003-x.yaml": machineShard("W1-T9003") });
  try {
    await runMachineFilingJudge(ports(root, async () => verdict("low", 0.9)).p);
    let asked = 0;
    const counting = async () => (asked++, verdict("low", 0.9));
    await runMachineFilingJudge(ports(root, counting).p);
    assert.equal(asked, 0, "the control: a freshly pinned record is not asked again");

    const path = join(root, "plan", "tasks.d", "W1-T9003-x.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("record the remedy for W1-T9003", "rewrite the lint rule for W1-T9003"));
    const edited = readPlan(root).byId.get("W1-T9003")!;
    assert.ok(needsMachineJudgement(edited), "the edit made the pin stale");
    assert.ok(machineAuthorVerifyViolation(edited), "and the linter refuses the stale ruling");
    const again = await runMachineFilingJudge(ports(root, async () => (asked++, verdict("high", 0.95, "it rewrites a lint rule"))).p);
    assert.equal(asked, 1);
    assert.deepEqual(again.escalated, ["W1-T9003"]);
    const rejudged = readPlan(root).byId.get("W1-T9003")!;
    assert.equal(rejudged.verify, "human");
    assert.equal(rejudged.risk_ruling?.pin, taskRulingPin(rejudged));
    assert.equal((readFileSync(path, "utf8").match(/risk_ruling:/g) ?? []).length, 1, "the old ruling is replaced and not stacked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("judge failure parks the machine shard unchanged and asks again on the next pass", async () => {
  const text = machineShard("W1-T9004");
  const root = planDir({ "W1-T9004-x.yaml": text });
  const path = join(root, "plan", "tasks.d", "W1-T9004-x.yaml");
  try {
    const threw = ports(root, async () => {
      throw new Error("spawn timed out");
    });
    const first = await runMachineFilingJudge(threw.p);
    assert.deepEqual(first.unavailable, ["W1-T9004"]);
    assert.equal(readFileSync(path, "utf8"), text, "nothing is written on a failed judgment");
    assert.match(String(threw.logs.find((l) => l.step === "machine_judge.unavailable")?.extra?.reason), /spawn timed out/);

    const blank = await runMachineFilingJudge(
      ports(root, async () => ({ verdict: "high", availability: "unavailable", confidence: 0, reasons: ["no parseable verdict"] })).p,
    );
    assert.deepEqual(blank.unavailable, ["W1-T9004"], "a verdict-less answer is a failure and never an escalation");
    assert.equal(readFileSync(path, "utf8"), text);
    assert.deepEqual(dispatchable(readPlan(root)), [], "a judge outage never releases anything");

    const healed = await runMachineFilingJudge(ports(root, async () => verdict("low", 0.9)).p);
    assert.deepEqual(healed.proceeded, ["W1-T9004"], "the next pass asks again and the record flows");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("earned autonomy lowers the bar for a family that helps and raises it for one that fails", async () => {
  assert.equal(earnedConfidenceBar(0.7, 0.5), 0.7, "an even record keeps the policy bar");
  assert.ok(earnedConfidenceBar(0.7, 0.8) < 0.7);
  assert.ok(earnedConfidenceBar(0.7, 0.2) > 0.7);

  const shard = (id: string, family: string, tail: string) => machineShard(id, { origin: `${family}:${id}` }) + tail;
  const root = planDir({
    "W1-T9010-x.yaml": shard("W1-T9010", "helps", ""),
    "W1-T9011-x.yaml": shard("W1-T9011", "fails", ""),
    "W1-T9012-x.yaml": shard("W1-T9012", "fails", "").replace("status: queued", "status: blocked\n  retirement: closed"),
    "W1-T9013-x.yaml": shard("W1-T9013", "fails", "").replace("status: queued", "status: blocked\n  retirement: closed"),
    "W1-T9014-x.yaml": shard("W1-T9014", "helps", "").replace("status: queued", "status: merged"),
    "W1-T9015-x.yaml": shard("W1-T9015", "helps", "").replace("status: queued", "status: merged"),
  });
  try {
    const plan = readPlan(root);
    const merged = (id: string) => plan.byId.get(id)?.status === "merged";
    assert.equal(machineFamily(plan.byId.get("W1-T9010")!), "helps");
    assert.ok(familyTrackRecord(plan, "helps", merged).mean > 0.5);
    assert.ok(familyTrackRecord(plan, "fails", merged).mean < 0.5);
    const seen: RiskJudgeInput[] = [];
    const report = await runMachineFilingJudge(ports(root, async (input) => (seen.push(input), verdict("low", 0.75))).p);
    assert.deepEqual(report.proceeded, ["W1-T9010"], "the same verdict clears the family that has helped");
    assert.deepEqual(report.escalated, ["W1-T9011"], "and escalates the family that has failed");
    assert.match(String(seen[0]!.planContext.family_track_record), /2 merged/);
    assert.match(String(seen[0]!.gatesState.escalate_only_if), /secrets/);
    assert.match(seen[0]!.change.description, /^OPERATOR ESCALATION RULE:/);
    assert.match(seen[0]!.change.description, /verify: auto/, "judged as it would dispatch and not as parked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gardener's own Beta credit counts beyond its optimistic prior", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-garden-`));
  try {
    assert.equal(gardenFamilyRecord(dir, "ci-friction"), undefined);
    writeFileSync(join(dir, "ci-friction-gardener.json"), JSON.stringify({ classes: { draft: { alpha: 5, beta: 4 } } }));
    assert.deepEqual(gardenFamilyRecord(dir, "ci-friction"), { alpha: 5, beta: 4 });
    const plan = loadPlanFromYaml("[]\n", "x");
    const record = familyTrackRecord(plan, "ci-friction", () => false, gardenFamilyRecord(dir, "ci-friction"));
    assert.deepEqual([record.alpha, record.beta], [3, 4]);
    writeFileSync(join(dir, "empty-gardener.json"), JSON.stringify({ classes: {} }));
    assert.equal(gardenFamilyRecord(dir, "empty"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a proceed the record cannot honour at verify auto is escalated with the lint reason", async () => {
  const unscoped = machineShard("W1-T9020").replace(/ {2}files:\n {4}- docs\/ci-friction-remedies\.md\n/, "");
  const root = planDir({ "W1-T9020-x.yaml": unscoped });
  try {
    const { p, proposals } = ports(root, async () => verdict("low", 0.95));
    const report = await runMachineFilingJudge(p);
    assert.deepEqual(report.escalated, ["W1-T9020"]);
    assert.match(proposals[0]!.summary, /fails lint \(declared-scope\)/);
    assert.equal(readPlan(root).byId.get("W1-T9020")!.verify, "human");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the rewrite refuses a record that changed since it was judged or is not one record", () => {
  const text = machineShard("W1-T9030");
  const ruling = { verdict: "low", action: "proceed" as const, confidence: 0.9, reasons: ["r"], judgedAt: "2026-09-29T00:00:00.000Z" };
  assert.match(String((renderRuledShard(text, "plan/tasks.d/a.yaml", "not-the-pin", ruling) as { refused: string }).refused), /changed since/);
  assert.match(String((renderRuledShard(text + text, "plan/tasks.d/a.yaml", "x", ruling) as { refused: string }).refused), /exactly one record/);
  const noVerify = text.replace("  verify: human\n", "");
  assert.match(String((renderRuledShard(noVerify, "plan/tasks.d/a.yaml", "x", ruling) as { refused: string }).refused), /no verify: line/);
  const task = loadPlanFromYaml(text, "plan/tasks.d/a.yaml").tasks[0]!;
  const noReasons = renderRuledShard(text, "plan/tasks.d/a.yaml", taskRulingPin({ ...task, verify: "auto" }), { ...ruling, reasons: [] });
  assert.match((noReasons as { contents: string }).contents, /the judge recorded no reason/);
});

test("the filers write an honest risk and leave verify to the judge", () => {
  assert.equal(machineShardRisk(["src/lib/affected-suites.ts"]), "low");
  assert.equal(machineShardRisk([".github/workflows/ci.yml"]), "high");
  assert.equal(machineShardRisk(["src/lib/auth.ts"]), "high");
  assert.ok(machineShardHeaderLines(["plan/policy.yaml"]).includes("  band_meaning: blast-radius"));
  const miss = { runId: 1, headSha: "abc", selection: "narrow" as const, file: "test/x.test.ts" };
  const yaml = selectorShadowMissTask(miss, "W1-T9040");
  assert.match(yaml, /^ {2}risk: low$/m, "a selector edge repair is not high risk");
  assert.match(yaml, /^ {2}verify: human$/m);
});

test("the verify-human sweep keeps only ruling-shaped records and hands the rest to the machine-filing judge", () => {
  const operator = machineShard("W1-T9050").replace("  author_class: machine\n", "");
  const ruling = machineShard("W1-T9052", { files: ["DECISIONS.md"] }).replace("  author_class: machine\n", "");
  const root = planDir({ "W1-T9050-x.yaml": operator, "W1-T9051-x.yaml": machineShard("W1-T9051"), "W1-T9052-x.yaml": ruling });
  try {
    const plan = readPlan(root);
    assert.deepEqual(parkedVerifyHumanShards(plan, root, CLOCK).map((s) => s.id), ["W1-T9052"]);
    assert.ok(needsMachineJudgement(plan.byId.get("W1-T9050")!), "an operator verify: human record is the judge's");
    assert.equal(needsMachineJudgement(plan.byId.get("W1-T9052")!), false, "a ruling-shaped record stays with the operator");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production machine judge lands one plan PR and waits on it before asking again", async () => {
  const seed = gitRepo({ kind: "machine-judge-seed" });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed.dir, ".remudero"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(seed.dir, "plan", "policy.yaml"), readFileSync(join(REPO_ROOT, "plan", "policy.yaml"), "utf8"));
  writeFileSync(join(seed.dir, ".remudero", "mounts.yaml"), readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), "utf8"));
  writeFileSync(join(seed.dir, "plan", "tasks.d", "W1-T9060-x.yaml"), machineShard("W1-T9060"));
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  const origin = gitRepo({ bare: true, kind: "machine-judge-origin" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "HEAD:main");
  const local = gitRepo({ cloneFrom: origin.dir, kind: "machine-judge-local" });
  local.git("config", "user.email", "g@example.invalid");
  local.git("config", "user.name", "g");
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-state-`));
  const worktrees = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-wt-`));
  const calls: string[][] = [];
  let prOpen = true;
  let spawned = 0;
  let spawnedModel: string | undefined;
  try {
    const p = productionMachineFilingJudgePorts({
      repoRoot: local.dir,
      stateDir,
      worktreesRoot: worktrees,
      owner: "acme",
      repo: "remudero",
      log: () => {},
      clock: CLOCK,
      spawn: (async (args: { model?: string }) => {
        spawned += 1;
        spawnedModel = args.model;
        return { text: "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.9\nRISK_REASON: a docs remedy", costUsd: 0, numTurns: 1 };
      }) as never,
      fetcher: ((args: string[]) => {
        calls.push(args);
        if (args.some((a) => a.includes("/pulls/7"))) return { merged: false, state: prOpen ? "open" : "closed" };
        return { html_url: "https://github.com/acme/remudero/pull/7", number: 7 };
      }) as never,
    });
    assert.equal(p.gardenRecord?.("ci-friction"), undefined);
    assert.equal(p.operatorReleases?.().size, 0);
    p.stageProposal({ id: "machine-judge:probe", summary: "probe", evidenceAnchors: [] });
    assert.match(readFileSync(join(stateDir, "inbox-proposals.json"), "utf8"), /machine-judge:probe/);

    const first = await withLiveWritesAllowed(() => runMachineFilingJudge(p));
    assert.equal(spawned, 1, "the real judge construction ran once over this checkout's mounts");
    assert.equal(spawnedModel, "sonnet", "the machine judge runs on its own named mount");
    assert.equal(first.prUrl, "https://github.com/acme/remudero/pull/7");
    const landed = origin.git("show", `machine-judge-garden-${CLOCK.now()}:plan/tasks.d/W1-T9060-x.yaml`);
    assert.match(landed, /^ {2}verify: auto$/m);
    assert.match(landed, /^ {4}action: proceed$/m);
    const state = JSON.parse(readFileSync(join(stateDir, MACHINE_JUDGE_STATE_FILE), "utf8"));
    assert.deepEqual(state.pending.ids, ["W1-T9060"]);

    await runMachineFilingJudge(p);
    assert.equal(spawned, 1, "an open judge PR is waited on and nothing is asked twice");

    prOpen = false;
    const declined = await runMachineFilingJudge(p);
    assert.equal(spawned, 1, "a closed judge PR is a decline and the unchanged record is not re-asked");
    assert.deepEqual(declined.proceeded, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
    origin.cleanup();
    seed.cleanup();
    local.cleanup();
  }
});

test("a ruling whose shard is absent from the landing tree is refused and nothing is written", async () => {
  const judged = planDir({ "W1-T9070-x.yaml": machineShard("W1-T9070") });
  const landing = planDir({});
  try {
    const { p, logs } = ports(judged, async () => verdict("low", 0.9), { writeRoot: landing });
    const report = await runMachineFilingJudge(p);
    assert.deepEqual(report.refused, ["W1-T9070"]);
    assert.deepEqual(report.proceeded, []);
    assert.match(String(logs.find((l) => l.step === "machine_judge.refused")?.extra?.reason), /absent from the landing tree/);
  } finally {
    rmSync(judged, { recursive: true, force: true });
    rmSync(landing, { recursive: true, force: true });
  }
});

test("the machine judge runs one pass at a time and logs a failed pass", async () => {
  const root = planDir({ "W1-T9080-x.yaml": machineShard("W1-T9080") });
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let asked = 0;
  const { p } = ports(root, async () => {
    asked += 1;
    await gate;
    return verdict("low", 0.9);
  });
  const judge = startMachineFilingJudge(p, 5);
  try {
    for (let waited = 0; asked === 0 && waited < 5_000; waited += 5) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(asked, 1, "later ticks skip while a pass is still running");
  } finally {
    judge.stop();
    release();
    rmSync(root, { recursive: true, force: true });
  }
  const logs: string[] = [];
  const failing = startMachineFilingJudge(
    { ...ports(root, async () => verdict("low", 0.9)).p, plan: () => { throw new Error("plan unreadable"); }, log: (step) => void logs.push(step) },
    60_000,
  );
  try {
    for (let waited = 0; logs.length === 0 && waited < 5_000; waited += 5) await new Promise((r) => setTimeout(r, 5));
  } finally {
    failing.stop();
  }
  assert.deepEqual(logs, ["machine_judge.failed"]);
});

test("a self-hosting daemon wires the machine judge as its ninth garden", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, d): Promise<DaemonSummary> => {
        captured = d;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    // plan, gate, test, config, export, ci-friction, selector-shadow, evidence-coverage, then this one.
    const start = captured?.gardens?.[8];
    assert.ok(start, "a ninth garden is wired after the evidence-coverage gardener");
    // Stopped before its first tick, so no judge is spawned against the real plan.
    start!(60 * 60 * 1000).stop();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a pinned release survives ledger rotation and compaction where a ledger release row is shed", async () => {
  const root = planDir({ "W1-T9090-x.yaml": machineShard("W1-T9090") });
  const ledger = join(root, "ledger.ndjson");
  try {
    const row = (id: string, i: number) =>
      JSON.stringify({ ts: new Date(1790000000000 + i * 1000).toISOString(), run_id: `R${i}`, task_id: id, step: RELEASE_LEDGER_STEP, released: "verify-human" });
    const lines = [row("W1-T9090", 0), ...Array.from({ length: 220 }, (_, i) => row(`W1-T8${String(i).padStart(3, "0")}`, i + 1))];
    writeFileSync(ledger, lines.join("\n") + "\n");
    assert.ok(releasedTaskIds(readFileSync(ledger, "utf8").split("\n")).has("W1-T9090"), "the control: released by a ledger row");
    assert.equal(rotateLedger(ledger, { ceilingBytes: 1, smoothingWindowMs: 0 }).rotated, true);
    const survivors = releasedTaskIds(readFileSync(ledger, "utf8").split("\n"));
    assert.equal(survivors.has("W1-T9090"), false, "rotation shed the ledger release");
    assert.deepEqual(runnableCandidates(readPlan(root), () => false, 50, { releasedIds: survivors }).map((t) => t.id), []);

    await runMachineFilingJudge(ports(root, async () => verdict("low", 0.9)).p);
    assert.deepEqual(
      runnableCandidates(readPlan(root), () => false, 50, { releasedIds: survivors }).map((t) => t.id),
      ["W1-T9090"],
      "the pinned ruling releases with no ledger row at all",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shared filing path renders a whole machine record and names a lint refusal", () => {
  const spec = {
    taskId: "W1-T9095",
    title: "record the remedy for W1-T9095",
    origin: "ci-friction:check:x",
    files: ["docs/ci-friction-remedies.md"],
    acceptance: [{ claim: "the remedy is recorded", proof: "grep: ci-friction:check:x in docs/ci-friction-remedies.md" }],
    note: "priced at 12 PR minutes",
  };
  const ok = renderMachineShard(spec);
  assert.equal(ok.refused, undefined);
  const task = loadPlanFromYaml(ok.text, "a.yaml").tasks[0]!;
  assert.deepEqual([task.verify, task.risk, task.author_class, task.origin], ["human", "low", "machine", "ci-friction:check:x"]);
  assert.match(String(renderMachineShard({ ...spec, acceptance: [{ claim: "c", proof: "no dialect" }] }).refused), /proof/);
  assert.match(String(renderMachineShard({ ...spec, taskId: "not an id: [" }).refused), /unparseable/);
});

type Probe = { id: string; expect: "escalate" | "proceed"; title: string; files: string[]; claims: string[] };
const PROBES = (JSON.parse(readFileSync(join(REPO_ROOT, "test", "fixtures", "machine-judge-probes.json"), "utf8")) as { probes: Probe[] }).probes;

test("the regression eval escalates all six risky probes and passes all four benign ones even under a judge that always proceeds", async () => {
  assert.equal(PROBES.filter((p) => p.expect === "escalate").length, 6);
  assert.equal(PROBES.filter((p) => p.expect === "proceed").length, 4);
  const record = { family: "probe", merged: 0, declined: 0, alpha: 1, beta: 1, mean: 0.5 };
  let asked = 0;
  const lenient = async () => (asked++, verdict("low", 0.99, "looks fine"));
  for (const probe of PROBES) {
    const task = loadPlanFromYaml(machineShard(probe.id, { title: probe.title, files: probe.files }), "p.yaml").tasks[0]!;
    const judged = await judgeMachineShard({ ...task, acceptance: probe.claims.map((claim) => ({ claim, proof: "grep: x in y" })) }, record, {
      riskJudge: lenient,
      policy: { confidenceThreshold: 0.7, verifyHumanReleaseEnabled: true },
      clock: CLOCK,
    });
    assert.equal(judged.kind, "ruled");
    assert.equal(judged.kind === "ruled" && judged.ruling.action, probe.expect, `${probe.id}: ${probe.title}`);
  }
  assert.equal(asked, 4, "the backstop decides the risky six without spending a model call");
});

test("the backstop reads what a record will do and never its note", () => {
  assert.match(String(deterministicEscalation({ title: "x", files: ["src/lib/merge-queue.ts"] })), /merge-queue/);
  assert.match(String(deterministicEscalation({ title: "force-push the rebased branch" })), /irreversible/);
  assert.match(String(deterministicEscalation({ title: "x", prompt: "disable the review gate for docs PRs" })), /policy/);
  assert.equal(deterministicEscalation({ title: "record the lesson", acceptance: [{ claim: "a learnings entry exists" }] }), undefined);
});

const operatorShard = (id: string, over: { title?: string; files?: string[] } = {}) =>
  machineShard(id, { ...over, origin: `operator-request#${id}` }).replace("  author_class: machine\n", "");

test("an operator verify human record is released by a proceed ruling and stays parked on an escalation", async () => {
  const root = planDir({
    "W1-T9100-x.yaml": operatorShard("W1-T9100"),
    "W1-T9101-x.yaml": operatorShard("W1-T9101", { title: "purge every archive in state" }),
  });
  try {
    const seen: RiskJudgeInput[] = [];
    const { p, proposals } = ports(root, async (input) => (seen.push(input), verdict("low", 0.9)));
    const report = await runMachineFilingJudge(p);
    assert.deepEqual(report.proceeded, ["W1-T9100"]);
    assert.deepEqual(report.escalated, ["W1-T9101"], "the backstop holds for operator records too");
    const released = readPlan(root).byId.get("W1-T9100")!;
    assert.equal(released.verify, "auto");
    assert.equal(released.risk_ruling?.pin, taskRulingPin(released));
    assert.equal(seen[0]!.gatesState.author_class, "operator");
    assert.match(proposals[0]!.summary, /is your verify: human record/);
    assert.deepEqual(dispatchable(readPlan(root)), ["W1-T9100"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rmd approve becomes a pinned operator ruling that no ledger rotation can shed", async () => {
  const root = planDir({
    "W1-T9110-x.yaml": operatorShard("W1-T9110"),
    "W1-T9111-x.yaml": machineShard("W1-T9111", { title: "prune the stale backups" }),
  });
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), readFileSync(join(root, "plan", "tasks.d", "W1-T9110-x.yaml"), "utf8"));
  rmSync(join(root, "plan", "tasks.d", "W1-T9110-x.yaml"));
  try {
    assert.equal(await approveCommand(["W1-T9110"], { config: { root } as never, clock: CLOCK }), 0);
    assert.deepEqual([...readOperatorReleases(state)], ["W1-T9110"], "the operator's bit is kept outside the ledger");
    // Monolith records are never rewritten, so file the shard where the judge can pin it.
    writeFileSync(join(root, "plan", "tasks.d", "W1-T9110-x.yaml"), readFileSync(join(root, "plan", "tasks.yaml"), "utf8"));
    writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
    const escalated = await runMachineFilingJudge(ports(root, async () => verdict("high", 0.9, "needs him")).p);
    assert.deepEqual(escalated.escalated.sort(), ["W1-T9110", "W1-T9111"], "the judge and the backstop parked both");

    recordOperatorRelease(state, "W1-T9111", CLOCK.iso());
    let asked = 0;
    const report = await runMachineFilingJudge(
      ports(root, async () => (asked++, verdict("high", 0.99)), { operatorReleases: () => readOperatorReleases(state) }).p,
    );
    assert.equal(asked, 0, "an operator release asks no model and no backstop");
    assert.deepEqual(report.proceeded.sort(), ["W1-T9110", "W1-T9111"]);
    const plan = readPlan(root);
    for (const id of ["W1-T9110", "W1-T9111"]) {
      assert.equal(plan.byId.get(id)!.risk_ruling?.verdict, "operator");
      assert.equal(plan.byId.get(id)!.verify, "auto");
    }
    assert.deepEqual(dispatchable(plan).sort(), ["W1-T9110", "W1-T9111"], "released with an empty ledger");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record the rewrite refuses is settled until it changes and not re-judged every pass", async () => {
  const text = machineShard("W1-T9120").replace("  verify: human\n", "  verify: human # parked\n");
  const root = planDir({ "W1-T9120-x.yaml": text });
  try {
    let asked = 0;
    const counting = async () => (asked++, verdict("low", 0.9));
    const first = await runMachineFilingJudge(ports(root, counting).p);
    assert.deepEqual(first.refused, ["W1-T9120"]);
    await runMachineFilingJudge(ports(root, counting).p);
    assert.equal(asked, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verify-human release refuses a ruling-shaped record", async () => {
  const task = loadPlanFromYaml(operatorShard("W1-T9130", { files: ["DECISIONS.md"] }), "a.yaml").tasks[0]!;
  assert.ok(isRulingShaped(task));
  const out = await releaseAutomatedShard(
    { id: "W1-T9130", title: task.title, rationale: "", acceptance: [], ageDays: 1, depsAllMerged: true, citedInSrc: false },
    { decision: "automate", reason: "r" },
    { task: () => task, riskJudge: async () => verdict("low", 0.99), writeRelease: () => ({ code: 0, message: "x", released: true }) },
  );
  assert.equal(out.kind, "escalated");
});
