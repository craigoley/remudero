import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { FLOW_LADDER, ADMISSION_FLOW_LADDER } from "#src/lib/flow-remedy-gardener.js";
import { FIX_LANE_LADDER } from "#src/lib/fix-lane-gardener.js";
import { REGISTERED_GARDEN_NAMES } from "#src/lib/garden-registry.js";
import { deriveJudgeCalibration } from "#src/lib/judge-calibration.js";
import { renderMachineShard } from "#src/lib/machine-filing.js";
import {
  earnedConfidenceBar, familyTrackRecord, gardenFamilyRecord, judgeMachineShard, MACHINE_JUDGE_STATE_FILE,
  readOperatorReleases, recordOperatorRelease, renderRetiredShard, runMachineFilingJudge,
  type MachineJudgePorts,
} from "#src/lib/machine-filing-judge.js";
import { loadPlan, loadPlanFromYaml, type Task } from "#src/lib/plan.js";
import type { RiskJudgeInput } from "#src/lib/risk-judge.js";
import { taskRulingPin } from "#src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const CLOCK = fixedClock(Date.parse("2026-10-24T12:00:00Z"));

function shard(id: string, family = "flow-blocker"): string {
  const result = renderMachineShard({ taskId: id, title: `record the remedy for ${id}`,
    origin: `${family}:fixture`, files: ["docs/remedy.md"],
    acceptance: [{ claim: "the remedy is recorded", proof: "grep: remedy in docs/remedy.md" }] });
  assert.equal(result.refused, undefined);
  return result.text;
}

function fixture(t: { after(fn: () => void): void }, shards: Record<string, string>,
  root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-prior-`))) {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  for (const [id, text] of Object.entries(shards)) writeFileSync(join(root, "plan", "tasks.d", `${id}.yaml`), text);
  const inputs: RiskJudgeInput[] = [];
  const rows: Record<string, unknown>[] = [];
  const ports: MachineJudgePorts = {
    stateDir: root, writeRoot: root, plan: () => loadPlan(join(root, "plan", "tasks.yaml")),
    riskJudge: async input => { inputs.push(input); return { verdict: "low", confidence: 0.65, reasons: ["bounded remedy"] }; },
    operatorReleases: () => readOperatorReleases(root),
    log: (step, extra) => { rows.push({ ts: CLOCK.iso(), step, ...extra }); },
    stageProposal: () => undefined, clock: CLOCK,
  };
  return { root, ports, inputs, rows };
}

test("W1-T9045: an operator approval moves the family's earned bar before the task merges", async t => {
  const f = fixture(t, { "W1-T9901": shard("W1-T9901"), "W1-T9902": shard("W1-T9902") });
  f.ports.isMerged = () => false;
  delete f.ports.operatorReleases;
  recordOperatorRelease(f.root, "W1-T9901", CLOCK.iso());
  recordOperatorRelease(f.root, "W1-T9901", CLOCK.iso());
  const report = await runMachineFilingJudge(f.ports);
  assert.deepEqual(report.proceeded, ["W1-T9901", "W1-T9902"]);
  const row = f.rows.find(r => r.step === "machine_judge.ruled" && r.task_id === "W1-T9902");
  assert.equal(row?.family_mean, 2 / 3, "one approval is one credit, even after repeated release writes");
  assert.equal(row?.confidence_bar, earnedConfidenceBar(0.7, 2 / 3));
  assert.equal(loadPlan(join(f.root, "plan", "tasks.yaml")).byId.get("W1-T9901")?.status, "queued");
  const plan = await f.ports.plan();
  const record = familyTrackRecord(plan, "flow-blocker", () => false);
  assert.equal(record.alpha, 2, "the pinned operator ruling retains its credit without the release store");
  assert.equal(familyTrackRecord(plan, "flow-blocker", id => id === "W1-T9901", undefined,
    { released: readOperatorReleases(f.root) }).alpha, 3, "a merged build adds a separate credit; release and pin count once");
});

test("W1-T9045: every ladder gardener's origin family reads its own gardener record", t => {
  const f = fixture(t, {});
  for (const kind of [FLOW_LADDER, ADMISSION_FLOW_LADDER, FIX_LANE_LADDER]) {
    assert.ok(REGISTERED_GARDEN_NAMES.includes(kind.name as typeof REGISTERED_GARDEN_NAMES[number]));
    writeFileSync(join(f.root, `${kind.name}-gardener.json`), JSON.stringify({ classes: {
      draft: { alpha: 6, beta: 2 }, measure: { alpha: 5, beta: 4 },
    } }));
    assert.deepEqual(gardenFamilyRecord(f.root, kind.prefix), { alpha: 8, beta: 5 }, kind.prefix);
  }
  writeFileSync(join(f.root, "ci-friction-gardener.json"), JSON.stringify({ classes: { draft: { alpha: 7, beta: 3 } } }));
  assert.deepEqual(gardenFamilyRecord(f.root, "ci-friction"), { alpha: 7, beta: 3 });
  assert.equal(gardenFamilyRecord(f.root, "../escape"), undefined);
  assert.equal(gardenFamilyRecord(f.root, "not-registered"), undefined);
});

test("W1-T9045: a default pass credits squash trailers and ignores a shard's merged status", async t => {
  const repo = gitRepo({ seedCommit: false, kind: "judge-prior" });
  const f = fixture(t, {
    "W1-T9901": shard("W1-T9901").replace("status: queued", "status: blocked"),
    "W1-T9902": shard("W1-T9902"),
    "W1-T9903": shard("W1-T9903").replace("status: queued", "status: merged"),
    "W1-T9904": shard("W1-T9904").replace("status: queued", "status: done"),
  }, repo.dir);
  repo.git("add", "plan");
  const message = join(f.root, "commit-message.txt");
  writeFileSync(message, "fixture\n\n" + "unrelated narrative\n".repeat(60_000) +
    "Remudero-Task: W1-T9901\nRemudero-Task: W1-T9901\nprose Remudero-Task: W1-T9903\n");
  repo.git("commit", "-q", "-F", message);
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.equal(f.ports.isMerged, undefined, "exercise the production default");
  const report = await runMachineFilingJudge(f.ports);
  assert.deepEqual(report.proceeded, ["W1-T9902"]);
  const row = f.rows.find(r => r.step === "machine_judge.ruled");
  assert.equal(row?.family_mean, 2 / 3);
  assert.match(String(f.inputs[0]?.planContext.family_track_record), /1 merged/);
});

test("W1-T9045: a failed merge-history read is reported and never falls back to shard status", async t => {
  const f = fixture(t, { "W1-T9901": shard("W1-T9901"),
    "W1-T9902": shard("W1-T9902").replace("status: queued", "status: merged") });
  mkdirSync(join(f.root, ".git"));
  const report = await runMachineFilingJudge(f.ports);
  assert.deepEqual(report.escalated, ["W1-T9901"]);
  assert.ok(f.rows.some(r => r.step === "machine_judge.merge_history_unavailable" && typeof r.reason === "string"));
  assert.equal(f.rows.find(r => r.step === "machine_judge.ruled")?.family_mean, 0.5);
});

test("W1-T9045: an operator decline debits once and a duplicate withdrawal debits nothing", async t => {
  const f = fixture(t, { "W1-T9901": shard("W1-T9901"), "W1-T9902": shard("W1-T9902") });
  const task = loadPlan(join(f.root, "plan", "tasks.yaml")).byId.get("W1-T9901")!;
  writeFileSync(join(f.root, MACHINE_JUDGE_STATE_FILE), JSON.stringify({ pending: {
    prUrl: "https://github.com/fixture/repo/pull/1", ids: [task.id],
  } }));
  f.ports.prState = () => "closed";
  await runMachineFilingJudge(f.ports);
  assert.equal(f.rows.find(r => r.step === "machine_judge.ruled")?.family_mean, 1 / 3);
  const state = JSON.parse(readFileSync(join(f.root, MACHINE_JUDGE_STATE_FILE), "utf8"));
  assert.equal(state.operatorDeclined[task.id], CLOCK.iso());
  const duplicate = { ...task, retirement: "withdrawn" } as Task;
  const retired = { ...task, retirement: "closed" } as Task;
  const plan = (tasks: Task[]) => ({ tasks, byId: new Map(tasks.map(t => [t.id, t])) });
  assert.equal(familyTrackRecord(plan([duplicate]), "flow-blocker", () => false).beta, 1);
  assert.equal(familyTrackRecord(plan([retired]), "flow-blocker", () => false).beta, 2);
});

test("W1-T9045: a machine landing refusal is not an operator decline", async t => {
  const f = fixture(t, { "W1-T9901": shard("W1-T9901"), "W1-T9902": shard("W1-T9902") });
  const task = (await f.ports.plan()).byId.get("W1-T9901")!;
  writeFileSync(join(f.root, MACHINE_JUDGE_STATE_FILE), JSON.stringify({ declined: { [task.id]: taskRulingPin(task) } }));
  await runMachineFilingJudge(f.ports);
  assert.equal(f.rows.find(r => r.step === "machine_judge.ruled")?.family_mean, 0.5);
});

test("W1-T9045: a silence-policy withdrawal debits the family on the next pass", async t => {
  const f = fixture(t, { "W1-T9901": shard("W1-T9901") });
  f.ports.isMerged = () => false;
  f.ports.clock = fixedClock(CLOCK.now() - 31 * 86_400_000);
  f.ports.riskJudge = async () => ({ verdict: "high", confidence: 0.95, reasons: ["needs a person"] });
  await runMachineFilingJudge(f.ports);
  f.ports.clock = CLOCK;
  f.ports.operatorRulings = () => () => undefined;
  const withdrawn = await runMachineFilingJudge(f.ports);
  assert.deepEqual(withdrawn.withdrawn, ["W1-T9901"]);
  const state = JSON.parse(readFileSync(join(f.root, MACHINE_JUDGE_STATE_FILE), "utf8"));
  assert.equal(state.unansweredWithdrawn["W1-T9901"], CLOCK.iso(), "the silence outcome survives a restart");
  writeFileSync(join(f.root, "plan", "tasks.d", "W1-T9902.yaml"), shard("W1-T9902"));
  f.rows.length = 0;
  await runMachineFilingJudge(f.ports);
  assert.equal(f.rows.find(r => r.step === "machine_judge.ruled")?.family_mean, 1 / 3);
  const out = renderRetiredShard(shard("W1-T9903"), "plan/tasks.d/W1-T9903.yaml", "duplicate", "withdrawn");
  assert.ok("contents" in out);
  const duplicate = loadPlanFromYaml(out.contents, "fixture");
  assert.equal(familyTrackRecord(duplicate, "flow-blocker", () => false).beta, 1);
});

test("W1-T9045: model verdicts reach calibration once while operator releases add no model verdict", async t => {
  const f = fixture(t, { "W1-T9901": shard("W1-T9901"), "W1-T9902": shard("W1-T9902") });
  mkdirSync(join(f.root, ".remudero"));
  writeFileSync(join(f.root, ".remudero", "mounts.yaml"), readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml")));
  recordOperatorRelease(f.root, "W1-T9901", CLOCK.iso());
  await runMachineFilingJudge(f.ports);
  const decisions = f.rows.filter(r => r.step === "risk_judge.decision");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.task_id, "W1-T9902");
  assert.equal(decisions[0]?.verdict, "low");
  const calibration = deriveJudgeCalibration(f.rows, { asOf: CLOCK.iso(), labels: { labels: [] } });
  assert.equal(calibration.state, "observed");
  assert.equal(calibration.judges[0]?.verdicts, 1);
  await runMachineFilingJudge(f.ports);
  assert.equal(f.rows.filter(r => r.step === "risk_judge.decision").length, 1);
});

test("W1-T9045: calibration records an unreadable model and excludes unavailable and deterministic verdicts", async t => {
  const f = fixture(t, { "W1-T9901": shard("W1-T9901") });
  mkdirSync(join(f.root, ".remudero"));
  writeFileSync(join(f.root, ".remudero", "mounts.yaml"), "not: valid mounts\n");
  f.ports.isMerged = () => false;
  await runMachineFilingJudge(f.ports);
  assert.match(String(f.rows.find(r => r.step === "risk_judge.decision")?.model_reason), /judge mount is unreadable:/);
  const unknownModel = deriveJudgeCalibration(f.rows, { asOf: CLOCK.iso(), labels: { labels: [] } });
  assert.equal(unknownModel.excluded["judge-model-unrecorded"], 1);

  const task = (await f.ports.plan()).tasks[0]!;
  const record = familyTrackRecord(await f.ports.plan(), "flow-blocker", () => false);
  f.rows.length = 0;
  const judged = await judgeMachineShard(task, record, {
    riskJudge: async () => ({ verdict: "high", confidence: 0, reasons: ["provider offline"], availability: "unavailable" }),
    policy: { confidenceThreshold: 0.7, verifyHumanReleaseEnabled: true }, clock: CLOCK, log: f.ports.log,
  });
  assert.equal(judged.kind, "unavailable");
  assert.equal(deriveJudgeCalibration(f.rows, { asOf: CLOCK.iso(), labels: { labels: [] } }).excluded["judge-unavailable"], 1);
  f.rows.length = 0;
  await judgeMachineShard({ ...task, files: ["deploy/Dockerfile"], title: "change deployment permissions" }, record, {
    riskJudge: async () => { assert.fail("a deterministic escalation must not ask the model"); },
    policy: { confidenceThreshold: 0.7, verifyHumanReleaseEnabled: true }, clock: CLOCK, log: f.ports.log,
  });
  assert.deepEqual(f.rows, [], "a deterministic backstop contributes no LLM judgment");
});

test("W1-T9045: a model re-ask contributes a fresh calibration verdict", async t => {
  const f = fixture(t, { "W1-T9901": shard("W1-T9901") });
  mkdirSync(join(f.root, ".remudero"));
  writeFileSync(join(f.root, ".remudero", "mounts.yaml"), readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml")));
  f.ports.isMerged = () => false;
  f.ports.riskJudge = async () => ({ verdict: "high", confidence: 0.95, reasons: ["needs a person"] });
  await runMachineFilingJudge(f.ports);
  f.ports.clock = fixedClock(CLOCK.now() + 2 * 86_400_000);
  const report = await runMachineFilingJudge(f.ports);
  assert.deepEqual(report.reasked, ["W1-T9901"]);
  assert.equal(f.rows.filter(r => r.step === "risk_judge.decision").length, 2);
  assert.equal(deriveJudgeCalibration(f.rows, { asOf: f.ports.clock.iso(), labels: { labels: [] } }).judges[0]?.verdicts, 2);
});
