/**
 * W1-T8830 — A PARKED MACHINE FILING IS ASKED AGAIN WHEN ITS EVIDENCE MOVES.
 *
 * OBSERVED 2026-10-12: the console inbox held 18 `machine-judge:` escalations, some parked since
 * 2026-10-03. The escalate ruling is pinned on the record, and only an edit to the record re-opened
 * it, so an escalation whose evidence later moved was never asked again. These tests cover three
 * things. A moved input (the family's earned bar, the cost the origin names, a merged dependency)
 * re-asks the judge. With nothing moved, a cadence re-asks; it backs off on each repeat and recovers
 * when the family's re-asks flip. An unchanged answer writes nothing, and the pin keeps parking the
 * record through ledger rotation and a lost state file.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "#src/lib/clock.js";
import { runnableCandidates } from "#src/lib/drain.js";
import { rotateLedger } from "#src/lib/ledger.js";
import { machineShardHeaderLines } from "#src/lib/machine-filing.js";
import {
  MACHINE_JUDGE_REASK_SCALE_MS,
  MACHINE_JUDGE_STATE_FILE,
  machineJudgeFoundWork,
  movedEvidence,
  parkedEscalation,
  reaskIntervalMs,
  runMachineFilingJudge,
  type MachineJudgePorts,
} from "#src/lib/machine-filing-judge.js";
import type { Proposal } from "#src/lib/inbox.js";
import { loadPlan, type Plan } from "#src/lib/plan.js";
import type { RiskJudgeInput, RiskJudgeVerdict } from "#src/lib/risk-judge.js";
import { machineAuthorVerifyViolation, taskRulingPin } from "#src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const T0 = 1790700000000;
const DAY = MACHINE_JUDGE_REASK_SCALE_MS;

function machineShard(id: string, origin: string, over: { depends_on?: string[]; status?: string; files?: string[] } = {}): string {
  const files = over.files ?? ["docs/ci-friction-remedies.md"];
  return [
    `- id: ${id}`,
    `  title: ${JSON.stringify(`record the remedy for ${id}`)}`,
    "  repo: remudero",
    `  depends_on: [${(over.depends_on ?? []).join(", ")}]`,
    "  type: implement",
    ...machineShardHeaderLines(files).map((l) => (over.status ? l.replace("status: queued", `status: ${over.status}`) : l)),
    `  origin: ${JSON.stringify(origin)}`,
    ...(files.length > 0 ? ["  files:", ...files.map((f) => `    - ${f}`)] : []),
    "  acceptance:",
    `    - claim: "the remedy for ${id} is recorded"`,
    `      proof: "grep: ${id} in docs/ci-friction-remedies.md"`,
    "",
  ].join("\n");
}

function planDir(shards: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-reask-`));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  for (const [id, text] of Object.entries(shards)) writeFileSync(join(root, "plan", "tasks.d", `${id}-x.yaml`), text);
  return root;
}

const readPlan = (root: string): Plan => loadPlan(join(root, "plan", "tasks.yaml"));
const shardText = (root: string, id: string): string => readFileSync(join(root, "plan", "tasks.d", `${id}-x.yaml`), "utf8");

function movableClock(start: number): Clock & { set: (ms: number) => void } {
  let now = start;
  return { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString(), set: (ms) => void (now = ms) };
}

/** A judge that answers per record and counts each record it is asked about. */
function judge(answers: Record<string, RiskJudgeVerdict | Error>) {
  const asked: string[] = [];
  const fn = async (input: RiskJudgeInput): Promise<RiskJudgeVerdict> => {
    const id = Object.keys(answers).find((k) => input.change.description.includes(k));
    assert.ok(id !== undefined, "the judge was asked about a record the test did not answer for");
    asked.push(id);
    const a = answers[id]!;
    if (a instanceof Error) throw a;
    return a;
  };
  return { fn, asked };
}

const high = (reason = "it rewrites the merge policy"): RiskJudgeVerdict => ({ verdict: "high", confidence: 0.9, reasons: [reason] });
const low: RiskJudgeVerdict = { verdict: "low", confidence: 0.99, reasons: ["a docs remedy"] };

function pass(root: string, clock: Clock, answers: Record<string, RiskJudgeVerdict | Error>, extra: Partial<MachineJudgePorts> = {}) {
  const j = judge(answers);
  const proposals: Proposal[] = [];
  const logs: { step: string; extra?: Record<string, unknown> }[] = [];
  const p: MachineJudgePorts = {
    stateDir: root,
    plan: () => readPlan(root),
    riskJudge: j.fn,
    writeRoot: root,
    stageProposal: (x) => void proposals.push(x),
    log: (step, e) => void logs.push({ step, extra: e }),
    clock,
    ...extra,
  };
  return { run: () => runMachineFilingJudge(p), asked: j.asked, proposals, logs };
}

test("W1-T8830: an escalation is asked again when its evidence moves", async () => {
  const root = planDir({
    "W1-T9100": machineShard("W1-T9100", "ci-friction:W1-T9100"),
    "W1-T9101": machineShard("W1-T9101", "upstream:W1-T9101", { status: "merged" }),
    "W1-T9102": machineShard("W1-T9102", "deps:W1-T9102", { depends_on: ["W1-T9101"] }),
    "W1-T9103": machineShard("W1-T9103", "priced:W1-T9103"),
  });
  const clock = movableClock(T0);
  let garden = { alpha: 3, beta: 1 };
  const merged = new Set<string>();
  let cost = 120;
  const world: Partial<MachineJudgePorts> = {
    gardenRecord: (family) => (family === "ci-friction" ? garden : undefined),
    isMerged: (id) => merged.has(id),
    costEvidence: (task) => (task.id === "W1-T9103" ? cost : undefined),
  };
  const everyone = { "W1-T9100": high(), "W1-T9102": high(), "W1-T9103": high() };
  try {
    const first = await pass(root, clock, everyone, world).run();
    assert.deepEqual(first.escalated, ["W1-T9100", "W1-T9102", "W1-T9103"]);
    for (const id of first.escalated) assert.ok(parkedEscalation(readPlan(root).byId.get(id)!), `${id} is parked under its pin`);

    const control = pass(root, clock, everyone, world);
    await control.run();
    assert.deepEqual(control.asked, [], "the control: nothing moved and the cadence is not due, so no record is asked");

    // The falsifier: the family's earned confidence bar moves, and only that family's record is asked.
    garden = { alpha: 3, beta: 3 };
    const noRoom = pass(root, clock, everyone, { ...world, limit: 0 });
    await noRoom.run();
    assert.deepEqual(noRoom.asked, [], "a pass with no room left asks nothing");
    const bar = pass(root, clock, everyone, world);
    const barReport = await bar.run();
    assert.deepEqual(bar.asked, ["W1-T9100"], "a moved bar re-asks its family's parked escalation");
    assert.deepEqual(barReport.reasked, ["W1-T9100"]);
    const barRow = bar.logs.find((l) => l.step === "machine_judge.reasked")?.extra;
    assert.deepEqual(barRow?.moved, ["confidence_bar"], "the re-ask is ledgered with the input that moved");
    assert.equal(barRow?.changed, false);
    assert.equal(barRow?.cadence_due, false);

    // A dependency merges: the record is asked, now proceeds, and lands re-pinned through the one judge path.
    merged.add("W1-T9101");
    const deps = pass(root, clock, { ...everyone, "W1-T9102": low }, world);
    const depsReport = await deps.run();
    assert.deepEqual(deps.asked, ["W1-T9102"]);
    assert.deepEqual(deps.logs.find((l) => l.step === "machine_judge.reasked")?.extra?.moved, ["depends_on"]);
    assert.deepEqual(depsReport.proceeded, ["W1-T9102"], "a changed answer lands");
    const released = readPlan(root).byId.get("W1-T9102")!;
    assert.equal(released.verify, "auto");
    assert.equal(released.risk_ruling?.action, "proceed");
    assert.equal(released.risk_ruling?.pin, taskRulingPin(released), "re-pinned to the record as rewritten");
    assert.equal((shardText(root, "W1-T9102").match(/risk_ruling:/g) ?? []).length, 1);

    // The cost the origin names falls.
    cost = 40;
    const priced = pass(root, clock, everyone, world);
    await priced.run();
    assert.deepEqual(priced.asked, ["W1-T9103"]);
    assert.deepEqual(priced.logs.find((l) => l.step === "machine_judge.reasked")?.extra?.moved, ["cost"]);

    assert.deepEqual(movedEvidence({ bar: 0.7, cost: null, merged_deps: [] }, { bar: 0.8, cost: 5, merged_deps: ["W1-T1"] }), ["confidence_bar", "cost", "depends_on"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T8830: the re-ask cadence backs off on a repeat and recovers on a flip", async () => {
  // The interval: one scale unit at an even family record, doubled per unchanged answer, shorter as the family flips.
  assert.equal(reaskIntervalMs(undefined, 0), DAY);
  assert.equal(reaskIntervalMs(undefined, 1), 2 * DAY);
  assert.ok(reaskIntervalMs({ asked: 4, flipped: 0 }, 0) > reaskIntervalMs({ asked: 4, flipped: 2 }, 0), "a family that flips is asked sooner");
  assert.ok(reaskIntervalMs({ asked: 40, flipped: 0 }, 6) > 365 * DAY, "no cap: a record that never moves is asked ever more rarely");
  assert.ok(reaskIntervalMs({ asked: 40, flipped: 40 }, 0) < DAY / 10, "no floor: a family whose re-asks keep flipping is asked ever sooner");

  const root = planDir({
    "W1-T9110": machineShard("W1-T9110", "cadence:W1-T9110"),
    "W1-T9111": machineShard("W1-T9111", "cadence:W1-T9111"),
  });
  const clock = movableClock(T0);
  let cost = 10;
  const world: Partial<MachineJudgePorts> = { costEvidence: (t) => (t.id === "W1-T9110" ? cost : undefined) };
  const both = { "W1-T9110": high(), "W1-T9111": high() };
  try {
    await pass(root, clock, both, world).run();
    const textX = shardText(root, "W1-T9110");

    clock.set(T0 + DAY - 1);
    const early = pass(root, clock, both, world);
    await early.run();
    assert.deepEqual(early.asked, [], "not yet due");

    clock.set(T0 + DAY);
    const due = pass(root, clock, both, world);
    const dueReport = await due.run();
    assert.deepEqual(due.asked, ["W1-T9110", "W1-T9111"], "with nothing moved, the cadence asks again");
    const rows = due.logs.filter((l) => l.step === "machine_judge.reasked").map((l) => l.extra!);
    assert.deepEqual(rows.map((r) => [r.cadence_due, r.moved, r.interval_ms]), [[true, [], DAY], [true, [], DAY]]);
    assert.equal(machineJudgeFoundWork(dueReport), false, "an unchanged re-ask is no new work, so pacing backs off");

    // BACKED OFF: two repeats in the family make the next wait 3 (odds) x 2 (one repeat) = 6 days, not one.
    clock.set(T0 + 4 * DAY);
    const backedOff = pass(root, clock, both, world);
    await backedOff.run();
    assert.deepEqual(backedOff.asked, [], "a day after a repeat, and three days, the record is not asked: the interval grew");

    // A FLIP: W1-T9110's cost moves and the judge now proceeds. The family's flip rate rises, and
    // W1-T9111 (three days since its last ask) falls due under the shortened interval.
    cost = 3;
    const flip = pass(root, clock, { ...both, "W1-T9110": low }, world);
    const flipReport = await flip.run();
    assert.deepEqual(flip.asked, ["W1-T9110"]);
    assert.deepEqual(flipReport.proceeded, ["W1-T9110"]);
    assert.notEqual(shardText(root, "W1-T9110"), textX);
    const recovered = pass(root, clock, both, world);
    await recovered.run();
    assert.deepEqual(recovered.asked, ["W1-T9111"], "the flip shortened the sibling's wait from six days to three");
    assert.equal(recovered.logs.find((l) => l.step === "machine_judge.reasked")?.extra?.interval_ms, 3 * DAY);
    const state = JSON.parse(readFileSync(join(root, MACHINE_JUDGE_STATE_FILE), "utf8"));
    assert.deepEqual(state.reaskRecord.cadence, { asked: 4, flipped: 1 });
    assert.equal(state.reask["W1-T9111"].repeats, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T8830: an unchanged re-ask writes nothing and keeps the pin", async () => {
  const root = planDir({
    "W1-T9120": machineShard("W1-T9120", "ci-friction:W1-T9120"),
    // A record that cannot honour a proceed (no declared files): a proceed it is given is held, not landed.
    "W1-T9121": machineShard("W1-T9121", "ci-friction:W1-T9121", { files: [] }),
  });
  const clock = movableClock(T0);
  try {
    const first = await pass(root, clock, { "W1-T9120": high(), "W1-T9121": low }).run();
    assert.deepEqual(first.escalated, ["W1-T9120", "W1-T9121"]);
    const texts = { a: shardText(root, "W1-T9120"), b: shardText(root, "W1-T9121") };

    clock.set(T0 + DAY);
    const again = pass(root, clock, { "W1-T9120": high("it still rewrites the merge policy"), "W1-T9121": low });
    const report = await again.run();
    assert.deepEqual(again.asked, ["W1-T9120", "W1-T9121"]);
    assert.deepEqual([report.proceeded, report.escalated, report.refused, report.settled], [[], [], [], []]);
    assert.equal(report.prUrl, undefined);
    assert.equal(shardText(root, "W1-T9120"), texts.a, "an unchanged answer rewrites nothing");
    assert.equal(shardText(root, "W1-T9121"), texts.b, "a proceed the record cannot honour is held, and nothing is rewritten");
    assert.deepEqual(again.proposals, [], "and stages nothing new in the inbox");
    assert.match(String(again.logs.find((l) => l.step === "machine_judge.reask_held")?.extra?.reason), /fails lint/);
    assert.deepEqual(again.logs.filter((l) => l.step === "machine_judge.reasked").map((l) => l.extra?.changed), [false, true]);

    // A judge outage on a re-ask writes nothing either, and the record is asked again on the next pass.
    clock.set(T0 + 100 * DAY);
    const down = pass(root, clock, { "W1-T9120": new Error("spawn timed out"), "W1-T9121": high() });
    const downReport = await down.run();
    assert.deepEqual(downReport.unavailable, ["W1-T9120"]);
    assert.equal(down.logs.find((l) => l.step === "machine_judge.unavailable")?.extra?.reask, true);
    const healed = pass(root, clock, { "W1-T9120": high(), "W1-T9121": high() });
    await healed.run();
    assert.deepEqual(healed.asked, ["W1-T9120"], "the outage left W1-T9120 due");

    // The ledger rotates and the judge's state is lost: the pin alone still parks the record.
    const ledger = join(root, "ledger.ndjson");
    const rows = [...again.logs, ...healed.logs].map((l, i) => JSON.stringify({ ts: new Date(T0 + i).toISOString(), run_id: `R${i}`, step: l.step, ...l.extra }));
    const filler = Array.from({ length: 220 }, (_, i) => JSON.stringify({ ts: new Date(T0 + 1000 + i).toISOString(), run_id: `F${i}`, step: "filler" }));
    writeFileSync(ledger, [...rows, ...filler].join("\n") + "\n");
    assert.equal(rotateLedger(ledger, { ceilingBytes: 1, smoothingWindowMs: 0 }).rotated, true);
    assert.doesNotMatch(readFileSync(ledger, "utf8"), /machine_judge\.reasked/, "rotation shed the re-ask rows");
    rmSync(join(root, MACHINE_JUDGE_STATE_FILE));
    const parked = readPlan(root).byId.get("W1-T9120")!;
    assert.equal(parked.verify, "human");
    assert.equal(parked.risk_ruling?.action, "escalate");
    assert.equal(parked.risk_ruling?.pin, taskRulingPin(parked), "the pin survives on the record");
    assert.equal(machineAuthorVerifyViolation(parked), undefined);
    assert.deepEqual(runnableCandidates(readPlan(root), () => false, 50).map((t) => t.id), [], "still parked");

    // With the state lost, the schedule restarts from the ruling's own judged_at: due, asked once, and nothing written.
    const reseeded = pass(root, clock, { "W1-T9120": high(), "W1-T9121": high() });
    await reseeded.run();
    assert.deepEqual(reseeded.asked, ["W1-T9120", "W1-T9121"]);
    assert.equal(shardText(root, "W1-T9120"), texts.a);
    const settled = pass(root, clock, { "W1-T9120": high(), "W1-T9121": high() });
    await settled.run();
    assert.deepEqual(settled.asked, [], "and then it backs off");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
