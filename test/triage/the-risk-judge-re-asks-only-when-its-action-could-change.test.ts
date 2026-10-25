import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { machineShardHeaderLines } from "#src/lib/machine-filing.js";
import {
  MACHINE_JUDGE_REASK_SCALE_MS as DAY, MACHINE_JUDGE_STATE_FILE,
  readOperatorReleaseRecords, recordOperatorRelease, runMachineFilingJudge, type MachineJudgePorts,
} from "#src/lib/machine-filing-judge.js";
import { loadPlan } from "#src/lib/plan.js";
import type { RiskJudgeVerdict } from "#src/lib/risk-judge.js";
import { taskRulingPin } from "#src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const START = Date.parse("2026-10-21T00:00:00Z");
const ID = "W1-T9100";
const HIGH: RiskJudgeVerdict = { verdict: "high", confidence: 0.9, reasons: ["needs a person"] };

function fixture(t: TestContext, files = ["docs/remedy.md"]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}action-reask-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "plan", "tasks.d");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const path = join(dir, `${ID}-remedy.yaml`);
  writeFileSync(path, [
    `- id: ${ID}`, "  title: record the measured remedy", "  repo: remudero",
    "  depends_on: []", "  type: implement", ...machineShardHeaderLines(files),
    "  origin: action-reask:measured", "  files:", ...files.map((f) => `    - ${f}`),
    "  acceptance:", "    - claim: the remedy is recorded",
    "      proof: 'grep: remedy in docs/remedy.md'", "",
  ].join("\n"));
  let now = START;
  let calls = 0;
  let answer = HIGH;
  let garden = { alpha: 3, beta: 1 };
  let cost = 10;
  const merged = new Set<string>();
  const logs: { step: string; extra?: Record<string, unknown> }[] = [];
  const plan = () => loadPlan(join(root, "plan", "tasks.yaml"));
  const ports: MachineJudgePorts = {
    stateDir: root, writeRoot: root, plan,
    riskJudge: async () => { calls++; return answer; },
    gardenRecord: () => garden, costEvidence: () => cost, isMerged: (id) => merged.has(id),
    stageProposal: () => {}, log: (step, extra) => { logs.push({ step, extra }); },
    clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() },
  };
  const statePath = join(root, MACHINE_JUDGE_STATE_FILE);
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const run = async () => { logs.length = 0; return runMachineFilingJudge(ports); };
  return {
    root, path, plan, ports, run, state, logs, merged,
    calls: () => calls, text: () => readFileSync(path, "utf8"),
    answer: (v: RiskJudgeVerdict) => { answer = v; },
    garden: (v: typeof garden) => { garden = v; }, cost: (v: number) => { cost = v; },
    time: (v: number) => { now = v; },
    saveState: (v: unknown) => writeFileSync(statePath, JSON.stringify(v)),
  };
}

test("W1-T10349: a confidence bar drift alone never asks the model", async (t) => {
  for (const verdict of [HIGH, { ...HIGH, verdict: "low", confidence: 0.1 }] as RiskJudgeVerdict[]) {
    const f = fixture(t);
    f.answer(verdict);
    await f.run();
    const before = f.text();
    f.garden({ alpha: 13, beta: 1 });
    await f.run();
    assert.equal(f.calls(), 1);
    assert.equal(f.text(), before);
    assert.equal(f.logs.some((l) => l.step === "machine_judge.reasked"), false);
    assert.equal(f.state().reaskRecord, undefined);
  }
});

test("W1-T10349: a bar crossing a recorded low verdict flips the ruling without the model", async (t) => {
  const f = fixture(t);
  f.answer({ verdict: "low", confidence: 0.6, reasons: ["a docs remedy"] });
  await f.run();
  assert.equal(f.plan().byId.get(ID)!.risk_ruling!.action, "escalate");
  f.garden({ alpha: 13, beta: 1 });
  const report = await f.run();
  assert.equal(f.calls(), 1);
  assert.deepEqual(report.proceeded, [ID]);
  const task = f.plan().byId.get(ID)!;
  assert.equal(task.verify, "auto");
  assert.equal(task.risk_ruling!.action, "proceed");
  assert.equal(task.risk_ruling!.pin, taskRulingPin(task));
  assert.match(task.risk_ruling!.reasons.join(" "), /bar.*cross/i);
  assert.equal(f.state().reaskRecord, undefined);
});

test("W1-T10349: a backstop-pinned escalation is re-asked only when the backstop stops firing", async (t) => {
  const f = fixture(t, ["deploy/entrypoint.sh"]);
  await f.run();
  assert.equal(f.calls(), 0);
  assert.match(f.state().reask[ID].inputs.backstop, /deploy\/entrypoint.sh/);
  const history = { asked: 4, flipped: 1 };
  const s = f.state();
  s.reaskRecord = { "action-reask": history };
  f.saveState(s);
  f.time(START + 20 * DAY);
  f.cost(30);
  f.garden({ alpha: 13, beta: 1 });
  await f.run();
  assert.equal(f.calls(), 0);
  assert.equal(f.logs.some((l) => l.step === "machine_judge.reasked"), false);
  assert.deepEqual(f.state().reaskRecord["action-reask"], history);

  // Simulate a changed backstop implementation: the same pin and recorded backstop reason,
  // but the current task no longer trips it. Also exercises pre-upgrade state without a snapshot.
  const safe = fixture(t);
  await safe.run();
  const reason = f.plan().byId.get(ID)!.risk_ruling!.reasons[0]!;
  writeFileSync(safe.path, safe.text().replace(/(    reasons:\n)      - [^\n]*/, `$1      - ${JSON.stringify(reason)}`));
  const old = safe.state();
  delete old.reask[ID].inputs.backstop;
  safe.saveState(old);
  await safe.run();
  assert.equal(safe.calls(), 2);
  assert.deepEqual(safe.logs.find((l) => l.step === "machine_judge.reasked")!.extra!.moved, ["backstop"]);
  await safe.run();
  assert.equal(safe.calls(), 2);
});

test("W1-T10349: only a cadence re-ask doubles the interval", async (t) => {
  const f = fixture(t);
  await f.run();
  f.cost(20);
  await f.run();
  assert.equal(f.state().reask[ID].repeats, 0);
  assert.deepEqual(f.state().reaskRecord["action-reask"], { asked: 1, flipped: 0 });
  const inputRow = f.logs.find((l) => l.step === "machine_judge.reasked")!.extra!;
  assert.equal(inputRow.cadence_due, false);
  assert.equal(inputRow.next_due_at, new Date(START + 2 * DAY).toISOString());
  f.time(START + 2 * DAY);
  await f.run();
  assert.equal(f.calls(), 3);
  assert.equal(f.state().reask[ID].repeats, 1);
  const row = f.logs.find((l) => l.step === "machine_judge.reasked")!.extra!;
  assert.equal(row.cadence_due, true);
  assert.equal(row.interval_ms, 2 * DAY);
  assert.equal(row.next_due_at, new Date(START + 8 * DAY).toISOString());
  const before = f.text();
  f.cost(40);
  await f.run();
  assert.equal(f.state().reask[ID].repeats, 1);
  assert.equal(f.text(), before);
});

test("a merged dependency still asks once and a flip uses the judge landing path", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "plan", "tasks.d", "W1-T9000-upstream.yaml"),
    f.text().replaceAll(ID, "W1-T9000").replace("status: queued", "status: merged"));
  writeFileSync(f.path, f.text().replace("depends_on: []", "depends_on: [W1-T9000]"));
  await f.run();
  f.merged.add("W1-T9000");
  f.answer({ verdict: "low", confidence: 0.99, reasons: ["a docs remedy"] });
  const report = await f.run();
  assert.equal(f.calls(), 2);
  assert.deepEqual(report.proceeded, [ID]);
  assert.deepEqual(f.logs.find((l) => l.step === "machine_judge.reasked")!.extra!.moved, ["depends_on"]);
});

test("an edit re-pins fresh and an operator release never re-asks", async (t) => {
  const f = fixture(t);
  await f.run();
  const pin = f.plan().byId.get(ID)!.risk_ruling!.pin;
  writeFileSync(f.path, f.text().replace("record the measured remedy", "record a newer measured remedy"));
  await f.run();
  assert.equal(f.calls(), 2);
  assert.notEqual(f.plan().byId.get(ID)!.risk_ruling!.pin, pin);
  recordOperatorRelease(f.root, f.plan().byId.get(ID)!, new Date(START).toISOString());
  f.ports.operatorReleases = () => readOperatorReleaseRecords(f.root);
  f.time(START + 2 * DAY);
  f.cost(40);
  await f.run();
  assert.equal(f.calls(), 2);
  assert.equal(f.logs.some((l) => l.step === "machine_judge.reasked"), false);
});

test("a thirty-day unanswered escalation is withdrawn without re-asking", async (t) => {
  const f = fixture(t);
  await f.run();
  f.ports.operatorRulings = () => () => undefined;
  f.time(START + 30 * DAY);
  const report = await f.run();
  assert.equal(f.calls(), 1);
  assert.deepEqual(report.withdrawn, [ID]);
  assert.equal(f.plan().byId.get(ID)!.retirement, "withdrawn");
});

test("a changed backstop answer is deterministic and never counts as a model re-ask", async (t) => {
  const f = fixture(t, ["deploy/entrypoint.sh"]);
  await f.run();
  const s = f.state();
  s.reask[ID].inputs.backstop = "a former backstop answer";
  s.reask[ID].repeats = 3;
  f.saveState(s);
  await f.run();
  assert.equal(f.calls(), 0);
  assert.equal(f.state().reaskRecord, undefined);
  assert.equal(f.state().reask[ID].repeats, 3);
  assert.deepEqual(f.logs.find((l) => l.step === "machine_judge.reasked")!.extra!.moved, ["backstop"]);
  await f.run();
  assert.equal(f.logs.some((l) => l.step === "machine_judge.reasked"), false);
});

test("a legacy runaway interval does not throw while logging an input re-ask", async (t) => {
  const f = fixture(t);
  await f.run();
  const s = f.state();
  s.reask[ID].repeats = 48;
  f.saveState(s);
  f.cost(20);
  await f.run();
  assert.equal(f.calls(), 2);
  assert.equal(f.state().reask[ID].repeats, 48);
  const row = f.logs.find((l) => l.step === "machine_judge.reasked")!.extra!;
  assert.equal(row.next_due_at, null, "a legacy date beyond ISO's range has no representable time");
});
