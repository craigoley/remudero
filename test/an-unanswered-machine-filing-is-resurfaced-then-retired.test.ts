import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { runnableCandidates } from "#src/lib/drain.js";
import { machineShardHeaderLines } from "#src/lib/machine-filing.js";
import {
  operatorRulingTimes,
  machineJudgeFoundWork,
  recordOperatorRelease,
  readOperatorReleaseRecords,
  renderRuledShard,
  runMachineFilingJudge,
  type MachineJudgePorts,
} from "#src/lib/machine-filing-judge.js";
import { loadPlan, parseTasksFromYaml } from "#src/lib/plan.js";
import { buildStatusBoard, renderStatusBoardText } from "#src/lib/status-board.js";
import type { GitHub } from "#src/lib/status.js";
import { taskRulingPin } from "#src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const DAY = 86_400_000;
const clock = fixedClock(NOW);
const high = { verdict: "high" as const, confidence: 0.99, reasons: ["requires an operator decision"] };

function fixture(t: TestContext, ages: (number | null)[]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}unanswered-filing-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shards = join(root, "plan", "tasks.d");
  mkdirSync(shards, { recursive: true });
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const ids = ages.map((_, i) => `W1-T${9200 + i}`);
  const path = (id: string) => join(shards, `${id}-x.yaml`);
  const text = (id: string) => readFileSync(path(id), "utf8");
  for (const [i, age] of ages.entries()) {
    const id = ids[i]!;
    const rel = `plan/tasks.d/${id}-x.yaml`;
    const raw = [
      `- id: ${id}`, `  title: record the remedy for ${id}`, "  repo: remudero", "  depends_on: []",
      "  type: implement", ...machineShardHeaderLines(["docs/ci-friction-remedies.md"]),
      `  origin: ${i % 2 === 0 ? "ci-friction" : "garden"}:${id}`,
      "  files: [docs/ci-friction-remedies.md]", "  acceptance:",
      `    - claim: the remedy for ${id} is recorded`,
      `      proof: "grep: ${id} in docs/ci-friction-remedies.md"`, "",
    ].join("\n");
    if (age === null) writeFileSync(path(id), raw);
    else {
      const task = parseTasksFromYaml(raw, rel)[0]!;
      const ruled = renderRuledShard(raw, rel, taskRulingPin({ ...task, verify: "auto" }), {
        ...high, action: "escalate", judgedAt: new Date(NOW - age * DAY).toISOString(),
      });
      assert.ok("contents" in ruled, "the fixture must carry a valid escalation pin");
      writeFileSync(path(id), ruled.contents);
    }
  }
  const plan = () => loadPlan(join(root, "plan", "tasks.yaml"));
  const logs: { step: string; extra?: Record<string, unknown> }[] = [];
  const ports: MachineJudgePorts = {
    stateDir: join(root, "state"), plan, riskJudge: async () => high, writeRoot: root,
    operatorRulings: () => () => undefined,
    stageProposal: () => assert.fail("a repeated escalation must not add an individual proposal"),
    log: (step, extra) => void logs.push({ step, extra }), clock,
  };
  return { root, ids, path, text, plan, ports, logs };
}

test("W1-T9043: every machine filing held for a person appears in one rolled-up NEEDS ME digest with its age", (t) => {
  const f = fixture(t, [2, 12, 31, 5, 8, 14, null]);
  const github: GitHub = {
    prByRef: () => null, findMergedByTrailer: () => null,
    headRefName: () => undefined, prBody: () => undefined, readFailed: () => false,
  };
  const model = buildStatusBoard(f.root, join(f.root, "state", "ledger.ndjson"), {
    queryService: () => ({ running: false, pid: null }), repoDir: f.root,
    now: clock.now, resolveOriginMainSha: () => undefined, plan: f.plan(), github,
    readPushedRunBranches: () => "", readDispatchClaims: () => ({ status: "clear" }),
  });
  assert.equal(model.needsMe.parkedProposals?.count, 7);
  assert.deepEqual(model.needsMe.parkedDigest, [
    { family: "ci-friction", records: [
      { id: f.ids[2], ageDays: 31 }, { id: f.ids[4], ageDays: 8 },
      { id: f.ids[0], ageDays: 2 }, { id: f.ids[6], ageDays: null },
    ] },
    { family: "garden", records: [
      { id: f.ids[5], ageDays: 14 }, { id: f.ids[1], ageDays: 12 }, { id: f.ids[3], ageDays: 5 },
    ] },
  ]);
  const rendered = renderStatusBoardText(model);
  assert.equal((rendered.match(/NEEDS ME/g) ?? []).length, 1);
  assert.match(rendered, /ci-friction \(4\): W1-T9202 31d, W1-T9204 8d, W1-T9200 2d, W1-T9206 not yet escalated/);
  assert.match(rendered, /garden \(3\): W1-T9205 14d, W1-T9201 12d, W1-T9203 5d/);
  assert.match(rendered, /30d.*withdrawn.*never released or approved/);
});

test("W1-T9043: an escalation unanswered for 30 days is retired, never released", async (t) => {
  const f = fixture(t, [2, 12, 31, 30, 29]);
  const landings: { paths: string[]; body: string }[] = [];
  let disposed = false;
  f.ports.writeRoot = undefined;
  f.ports.openWorkspace = async () => ({
    root: f.root,
    land: async (input) => { landings.push(input); return "https://example.test/judge/1"; },
    dispose: async () => { disposed = true; },
  });
  const report = await runMachineFilingJudge(f.ports);
  assert.deepEqual(report.withdrawn, [f.ids[2], f.ids[3]]);
  assert.deepEqual(report.proceeded, []);
  assert.deepEqual(report.escalated, []);
  assert.equal(report.prUrl, "https://example.test/judge/1");
  assert.equal(disposed, true);
  assert.equal(landings.length, 1, "all withdrawals use the one judge PR");
  assert.deepEqual(landings[0]!.paths, f.ids.slice(2, 4).map((id) => `plan/tasks.d/${id}-x.yaml`));
  assert.match(landings[0]!.body, /retirement: withdrawn/);
  for (const id of f.ids.slice(2, 4)) {
    const task = f.plan().byId.get(id)!;
    assert.equal(task.status, "blocked");
    assert.equal(task.retirement, "withdrawn");
    assert.equal(task.verify, "human");
    assert.equal(task.risk_ruling?.action, "escalate");
    assert.match(f.text(id), /operator ruling 2026-10-13/);
  }
  for (const id of [f.ids[0]!, f.ids[1]!, f.ids[4]!]) {
    assert.equal(f.plan().byId.get(id)?.status, "queued");
    assert.equal(f.plan().byId.get(id)?.retirement, undefined);
  }
  assert.deepEqual(runnableCandidates(f.plan(), () => false, 50), []);
  assert.deepEqual(f.logs.filter((l) => l.step === "machine_judge.unanswered_withdrawn")
    .map((l) => [l.extra?.task_id, l.extra?.age_days, l.extra?.age_band]), [
    [f.ids[2], 31, 30], [f.ids[3], 30, 30],
  ]);
  assert.deepEqual(f.logs.filter((l) => l.step === "machine_judge.reasked")
    .map((l) => [l.extra?.task_id, l.extra?.age_days, l.extra?.age_band]), [
    [f.ids[0], 2, null], [f.ids[1], 12, null], [f.ids[4], 29, 14],
  ]);
});

test("W1-T9043: an operator ruling inside the window stops the retirement", async (t) => {
  const f = fixture(t, [31, 31, 31, 31, 31]);
  const at = new Date(NOW - 20 * DAY).toISOString();
  recordOperatorRelease(f.ports.stateDir, f.plan().byId.get(f.ids[0]!)!, at);
  f.ports.operatorReleases = () => readOperatorReleaseRecords(f.ports.stateDir);
  const times = operatorRulingTimes([
    { step: "dispatch.breaker_released", task_id: f.ids[1], ts: at },
    { step: "ratify.approved", task_id: f.ids[2], ts: at },
    { step: "dispatch.breaker_released", task_id: f.ids[1], ts: "invalid" },
    { step: "dispatch.breaker_released", task_id: f.ids[1], ts: new Date(NOW - 32 * DAY).toISOString() },
    { step: "review.posted", task_id: f.ids[4], ts: at },
  ]);
  f.ports.operatorRulings = () => (id) => id === f.ids[3] ? at : times.get(id);
  const report = await runMachineFilingJudge(f.ports);
  assert.deepEqual(report.withdrawn, [f.ids[4]], "a review is not an operator ruling");
  assert.deepEqual(report.proceeded, [f.ids[0]], "an explicit approval still takes the release path");
  for (const id of f.ids.slice(1, 4)) {
    assert.equal(f.plan().byId.get(id)?.status, "queued");
    assert.equal(f.plan().byId.get(id)?.retirement, undefined);
  }
});

test("W1-T9043: missing operator-ruling access keeps an old escalation parked and re-askable", async (t) => {
  const f = fixture(t, [400]);
  f.ports.operatorRulings = undefined;
  const before = f.text(f.ids[0]!);
  const report = await runMachineFilingJudge(f.ports);
  assert.deepEqual(report.withdrawn ?? [], []);
  assert.deepEqual(report.reasked, f.ids);
  assert.equal(f.text(f.ids[0]!), before);
});

test("W1-T9043: unreadable operator rulings postpone withdrawal with a reason", async (t) => {
  const f = fixture(t, [31]);
  f.ports.operatorRulings = () => { throw new Error("ruling store unavailable"); };
  const before = f.text(f.ids[0]!);
  const report = await runMachineFilingJudge(f.ports);
  assert.deepEqual(report.withdrawn ?? [], []);
  assert.equal(f.text(f.ids[0]!), before);
  assert.match(String(f.logs.find((l) => l.step === "machine_judge.withdraw_skipped")?.extra?.reason), /ruling store unavailable/);
});

test("W1-T9043: an operator edit reopens judgment rather than withdrawing the old pin", async (t) => {
  const f = fixture(t, [31]);
  const id = f.ids[0]!;
  writeFileSync(f.path(id), f.text(id).replace(`record the remedy for ${id}`, `investigate the remedy for ${id}`));
  const proposals: string[] = [];
  f.ports.stageProposal = (p) => void proposals.push(p.id);
  const report = await runMachineFilingJudge(f.ports);
  assert.deepEqual(report.withdrawn ?? [], []);
  assert.deepEqual(report.escalated, [id]);
  const task = f.plan().byId.get(id)!;
  assert.equal(task.status, "queued");
  assert.equal(task.risk_ruling?.judged_at, clock.iso());
  assert.equal(task.risk_ruling?.pin, taskRulingPin(task));
  assert.deepEqual(proposals, [`machine-judge:${id}`]);
});

test("W1-T9043: an operator edit before landing prevents the pending withdrawal", async (t) => {
  const f = fixture(t, [31]);
  const id = f.ids[0]!;
  const edited = f.text(id).replace(`record the remedy for ${id}`, `investigate the remedy for ${id}`);
  f.ports.writeRoot = undefined;
  f.ports.openWorkspace = async () => {
    writeFileSync(f.path(id), edited);
    return { root: f.root, land: async () => assert.fail("an edited record must not be withdrawn"), dispose: async () => {} };
  };
  const report = await runMachineFilingJudge(f.ports);
  assert.deepEqual(report.withdrawn ?? [], []);
  assert.deepEqual(report.refused, [id]);
  assert.equal(f.text(id), edited);
  assert.match(String(f.logs.find((l) => l.step === "machine_judge.refused")?.extra?.reason), /changed since/);
});

test("W1-T9043: a bad withdrawal record is reported while a healthy one still lands", async (t) => {
  const f = fixture(t, [31, 31, 31]);
  const landed: string[][] = [];
  f.ports.writeRoot = undefined;
  f.ports.openWorkspace = async () => {
    rmSync(f.path(f.ids[0]!));
    mkdirSync(f.path(f.ids[0]!));
    rmSync(f.path(f.ids[1]!));
    return {
      root: f.root,
      land: async ({ paths }) => { landed.push(paths); return undefined; },
      dispose: async () => {},
    };
  };
  const report = await runMachineFilingJudge(f.ports);
  assert.deepEqual(report.failed, [f.ids[0]]);
  assert.deepEqual(report.refused, [f.ids[1]]);
  assert.deepEqual(report.withdrawn, [f.ids[2]]);
  assert.deepEqual(report.unlanded, [f.ids[2]]);
  assert.deepEqual(landed, [[`plan/tasks.d/${f.ids[2]}-x.yaml`]]);
  assert.match(String(f.logs.find((l) => l.step === "machine_judge.record_failed")?.extra?.error), /EISDIR/);
  assert.match(String(f.logs.find((l) => l.step === "machine_judge.refused")?.extra?.reason), /absent from the landing tree/);
  const cleanReport = { ...report, failed: [], refused: [] };
  assert.equal(machineJudgeFoundWork(cleanReport), false, "an unlanded withdrawal is not completed work");
  assert.equal(machineJudgeFoundWork({ ...cleanReport, unlanded: [] }), true);
});
