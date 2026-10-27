import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { machineShardHeaderLines } from "#src/lib/machine-filing.js";
import {
  runMachineFilingJudge, type MachineJudgePorts, type MechanicalPort,
} from "#src/lib/machine-filing-judge.js";
import {
  countRounds, countStepRows, filingEvidenceOf, mechanicalRuling, medianCount, type MechanicalDecision, type SymptomReading,
} from "#src/lib/mechanical-rulings.js";
import { verifyHumanCadence } from "#src/lib/measurement-cadence.js";
import { loadPlan, type Task } from "#src/lib/plan.js";
import type { RiskJudgeVerdict } from "#src/lib/risk-judge.js";
import { approveParkedTask } from "#src/run-task.js";
import { taskRulingPin } from "#src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { ShardUnderJudgement } from "#src/lib/verify-human-judge.js";

const NOW = Date.parse("2026-10-21T00:00:00Z");
const WEEK = 7 * 86_400_000;
const HIGH: RiskJudgeVerdict = { verdict: "high", confidence: 0.9, reasons: ["needs a person"] };

interface Spec {
  id: string;
  step?: string;
  files?: string[];
  title?: string;
  risk?: "low" | "high";
  rationale?: string;
}

/** A plan of machine-filed `verify: human` records, a fake symptom port, and the REAL `approveParkedTask` as the release writer. */
function bed(t: TestContext, specs: Spec[]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mechanical-rulings-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "plan", "tasks.d");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const paths = new Map<string, string>();
  for (const spec of specs) {
    const files = spec.files ?? ["test/triage/x.test.ts"];
    const path = join(dir, `${spec.id}-record.yaml`);
    paths.set(spec.id, path);
    const header = machineShardHeaderLines(files).map((l) => (spec.risk !== undefined && l.startsWith("  risk:") ? `  risk: ${spec.risk}` : l));
    writeFileSync(path, [
      `- id: ${spec.id}`, `  title: ${JSON.stringify(spec.title ?? "stop the recurring failure")}`, "  repo: remudero",
      "  depends_on: []", "  type: implement", ...header,
      `  origin: ${spec.step === undefined ? "architect" : `scout:${spec.step}`}`,
      ...(spec.rationale === undefined ? [] : ["  rationale: |", `    ${spec.rationale}`]),
      "  files:", ...files.map((f) => `    - ${f}`),
      "  acceptance:", "    - claim: the failure stops",
      `      proof: 'grep: stop in ${files[0]}'`, "",
    ].join("\n"));
  }
  const ledgerPath = join(root, "ledger.ndjson");
  const symptoms = new Map<string, SymptomReading | undefined>();
  const declined = new Set<string>();
  const merged = new Set<string>();
  const logs: { step: string; extra?: Record<string, unknown> }[] = [];
  const proposals: unknown[] = [];
  let calls = 0;
  const mechanical: MechanicalPort = {
    read: () => ({ symptom: (task) => symptoms.get(task.id), declined: (task) => declined.has(task.id) }),
    release: (task, provenance) => approveParkedTask(task.id, {
      plan: { tasks: [task], byId: new Map([[task.id, task]]) }, ledgerPath, runId: "machine-judge-mechanical-test", provenance: { ...provenance },
    }),
  };
  const ports: MachineJudgePorts = {
    stateDir: root, writeRoot: root, plan: () => loadPlan(join(root, "plan", "tasks.yaml")),
    riskJudge: async () => { calls++; return HIGH; },
    gardenRecord: () => ({ alpha: 3, beta: 1 }), isMerged: (id) => merged.has(id),
    stageProposal: (p) => { proposals.push(p); }, log: (step, extra) => { logs.push({ step, extra }); },
    clock: { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() },
    mechanical,
  };
  const task = (id: string) => loadPlan(join(root, "plan", "tasks.yaml")).byId.get(id)!;
  const run = async (withRules = true) => {
    logs.length = 0;
    return runMachineFilingJudge({ ...ports, ...(withRules ? {} : { mechanical: undefined }) });
  };
  const rows = (): Record<string, unknown>[] => {
    try { return readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
    catch (e) { assert.equal((e as NodeJS.ErrnoException).code, "ENOENT", "only an absent ledger reads as empty"); return []; }
  };
  return {
    root, task, run, rows, logs, proposals, symptoms, declined, merged, calls: () => calls,
    text: (id: string) => readFileSync(paths.get(id)!, "utf8"),
    ruling: (id: string) => logs.find((l) => l.step === "machine_judge.mechanical_ruling" && l.extra?.task_id === id)?.extra,
  };
}

const reading = (count: number, extra: Partial<SymptomReading> = {}): SymptomReading => ({ count, windowMs: WEEK, ...extra });

test("W1-T10371: a shipped or operator-declined record is retired by rule 1", async (t) => {
  const f = bed(t, [
    { id: "W1-T9201", step: "a.shipped" },
    { id: "W1-T9202", step: "a.declined" },
    // The person already decided, so the path class does not matter.
    { id: "W1-T9203", step: "a.shipped-private", files: ["deploy/entrypoint.sh"] },
  ]);
  f.merged.add("W1-T9201");
  f.merged.add("W1-T9203");
  f.declined.add("W1-T9202");
  const report = await f.run();
  assert.equal(f.calls(), 0, "no judge model is called");
  assert.deepEqual([...(report.retired ?? [])].sort(), ["W1-T9201", "W1-T9202", "W1-T9203"]);
  for (const id of ["W1-T9201", "W1-T9202", "W1-T9203"]) {
    const task = f.task(id);
    assert.equal(task.status, "blocked");
    assert.equal(task.retirement, "retired");
    assert.match(f.text(id), /retirement: retired {2}# retired by rule 1 \(already shipped or declined\)/);
    assert.equal(f.ruling(id)?.rule, 1);
    assert.equal(f.ruling(id)?.verdict, "retire");
  }
  assert.match(String(f.ruling("W1-T9201")?.evidence), /Remudero-Task trailer/);
  assert.match(String(f.ruling("W1-T9202")?.evidence), /declined/);
});

test("W1-T10371: a stopped cause on a low-privilege record is retired by rule 2", async (t) => {
  const f = bed(t, [
    { id: "W1-T9211", step: "b.stopped" },
    { id: "W1-T9212", step: "b.stopped", files: [".github/workflows/ci.yml"] },
    { id: "W1-T9213", step: "b.gate", title: "stop the CodeQL Analyze refusals" },
  ]);
  for (const id of ["W1-T9211", "W1-T9212", "W1-T9213"]) f.symptoms.set(id, reading(0));
  const report = await f.run();
  assert.deepEqual(report.retired, ["W1-T9211"]);
  const task = f.task("W1-T9211");
  assert.equal(task.status, "blocked");
  assert.equal(task.retirement, "retired");
  assert.match(f.text("W1-T9211"), /retirement: retired {2}# retired by rule 2 \(cause stopped\).*0 occurrence\(s\) across 7 day\(s\), never seen/);
  assert.equal(f.ruling("W1-T9211")?.rule, 2);
  // The same evidence on a privileged path, or on a gate cause, goes to a person: the backstop escalates the path,
  // and the judge's model is asked about the gate (and says high).
  assert.equal(f.task("W1-T9212").status, "queued");
  assert.equal(f.task("W1-T9212").risk_ruling?.action, "escalate");
  assert.equal(f.task("W1-T9213").status, "queued");
  assert.equal(f.task("W1-T9213").risk_ruling?.action, "escalate");
  assert.equal(f.ruling("W1-T9212"), undefined);
  assert.equal(f.ruling("W1-T9213"), undefined);
  // The gardener's own state naming the cause gone retires as well, whatever the live count.
  const stopped = mechanicalRuling({ id: "W1-T1", title: "t", origin: "flow-blocker:x", files: ["docs/x.md"], risk: "low" }, {
    operatorReleased: false, shipped: false, declined: false, familyCounts: [9],
    symptom: reading(9, { stopped: 'its flow-remedy ladder reads "retired"' }),
  });
  assert.equal((stopped as MechanicalDecision).rule, 2);
  assert.equal((stopped as MechanicalDecision).verdict, "retire");
});

test("W1-T10371: a live low-privilege record is released and its risk ruling settled by rule 3", async (t) => {
  const f = bed(t, [{ id: "W1-T9221", step: "c.live" }, { id: "W1-T9222", step: "c.live-high", risk: "high" }]);
  // Both records first meet the judge's model, which parks them under an escalate pin: today's state of the 104.
  await f.run(false);
  assert.equal(f.task("W1-T9221").risk_ruling?.action, "escalate");
  assert.equal(f.task("W1-T9221").verify, "human");
  const asked = f.calls();
  f.symptoms.set("W1-T9221", reading(5, { lastSeen: "2026-10-20T00:00:00.000Z" }));
  f.symptoms.set("W1-T9222", reading(5));
  const report = await f.run();
  assert.equal(f.calls(), asked, "no model call for a rule-decided record");
  assert.deepEqual(report.proceeded, ["W1-T9221"]);
  const task = f.task("W1-T9221");
  assert.equal(task.verify, "auto");
  assert.equal(task.risk_ruling?.verdict, "rule-3-low-privilege");
  assert.equal(task.risk_ruling?.action, "proceed");
  assert.equal(task.risk_ruling?.pin, taskRulingPin(task));
  const released = f.rows().filter((r) => r.step === "ratify.approved");
  assert.equal(released.length, 1);
  assert.equal(released[0]!.task_id, "W1-T9221");
  assert.equal(released[0]!.released_by, "mechanical-rule");
  assert.equal(released[0]!.rule, "rule-3-low-privilege");
  assert.equal(released[0]!.author_class, "machine");
  assert.match(String(released[0]!.evidence), /last seen 2026-10-20/);
  assert.equal(f.ruling("W1-T9221")?.rule, 3);
  // A record the plan bands risk: high stays with the risk judge, and approveParkedTask's guard stands.
  assert.equal(f.task("W1-T9222").verify, "human");
  assert.equal(f.task("W1-T9222").risk_ruling?.action, "escalate");
  assert.equal(released.some((r) => r.task_id === "W1-T9222"), false);
});

test("W1-T10371: a thin record is held by rule 4 without escalating", async (t) => {
  const f = bed(t, [
    { id: "W1-T9231", step: "d.thin" },
    // The busy records are banded high, so they stay with the risk judge and stay parked: they keep the family's median at 10.
    { id: "W1-T9232", step: "d.busy-1", risk: "high" },
    { id: "W1-T9233", step: "d.busy-2", risk: "high" },
  ]);
  // Origins differ per step but the family is the origin up to its colon, so the three share `scout`.
  f.symptoms.set("W1-T9231", reading(2));
  f.symptoms.set("W1-T9232", reading(10));
  f.symptoms.set("W1-T9233", reading(10));
  const before = f.text("W1-T9231");
  const report = await f.run();
  assert.deepEqual(report.held, ["W1-T9231"]);
  assert.equal(f.text("W1-T9231"), before, "a held record is never rewritten");
  assert.equal(f.task("W1-T9231").status, "queued");
  assert.equal(f.task("W1-T9231").verify, "human");
  assert.equal(f.task("W1-T9231").risk_ruling, undefined);
  assert.equal(f.ruling("W1-T9231")?.rule, 4);
  assert.equal(f.ruling("W1-T9231")?.verdict, "hold");
  // The two risk: high records are escalated by the model as today; the held record has no ask.
  assert.deepEqual((f.proposals as { id: string }[]).map((p) => p.id).sort(), ["machine-judge:W1-T9232", "machine-judge:W1-T9233"], "no inbox ask for the held record");
  assert.equal(f.logs.some((l) => l.step === "machine_judge.reasked" && l.extra?.task_id === "W1-T9231"), false);
  assert.deepEqual(report.proceeded, [], "a risk: high record is never released by rule 3");
  assert.equal(f.calls(), 2, "the model is asked only about the two risk: high records the rules leave to it");
  // A quiet record is not re-recorded every pass, and the hold follows the family's live counts: once the family
  // thins to the record's own level, it is no longer below the median and is released.
  await f.run();
  assert.equal(f.logs.some((l) => l.step === "machine_judge.mechanical_ruling" && l.extra?.task_id === "W1-T9231"), false);
  f.symptoms.set("W1-T9231", reading(10));
  const later = await f.run();
  assert.deepEqual(later.proceeded, ["W1-T9231"]);
});

test("W1-T10371: a record below its own filing rate is held, and the verdict follows the rate", async (t) => {
  const filed = "The ledger step e.rate landed rows in both halves of the trailing 7 days: 6 in the older half, 4 in the newer.";
  const f = bed(t, [{ id: "W1-T9241", step: "e.rate", rationale: filed }]);
  assert.deepEqual(filingEvidenceOf({ rationale: filed }, WEEK), { count: 10, windowMs: WEEK });
  f.symptoms.set("W1-T9241", reading(3, { filing: { count: 10, windowMs: WEEK } }));
  assert.deepEqual((await f.run()).held, ["W1-T9241"]);
  f.symptoms.set("W1-T9241", reading(10, { filing: { count: 10, windowMs: WEEK } }));
  assert.deepEqual((await f.run()).proceeded, ["W1-T9241"]);
  assert.equal(f.calls(), 0);
});

test("W1-T10371: an operator-released or undecidable record is never touched", async (t) => {
  const f = bed(t, [{ id: "W1-T9251", step: "f.none" }, { id: "W1-T9252" }]);
  f.symptoms.set("W1-T9251", undefined);
  await f.run();
  // A family with no reader (W1-T9251) and a record that names no symptom (W1-T9252, an architect filing) keep the judge path.
  assert.equal(f.ruling("W1-T9251"), undefined);
  assert.equal(f.task("W1-T9251").risk_ruling?.action, "escalate");
  assert.equal(f.calls(), 2);
  const base = { files: ["docs/x.md"], origin: "scout:x", title: "t", id: "W1-T1", risk: "low" as const };
  assert.equal(mechanicalRuling(base, { operatorReleased: true, shipped: true, declined: true, symptom: reading(0), familyCounts: [0] }), undefined);
  assert.equal(mechanicalRuling(base, { operatorReleased: false, shipped: false, declined: false, familyCounts: [] }), undefined);
});

test("W1-T10371: every privileged class escalates whatever its symptom", () => {
  const evidence = { operatorReleased: false, shipped: false, declined: false, symptom: reading(0), familyCounts: [0] };
  for (const files of [[".github/workflows/ci.yml"], ["deploy/x.sh"], ["src/lib/code-scanning-merge-policy.mjs"], ["scripts/merge-queue-canary.mjs"]]) {
    const ruling = mechanicalRuling({ id: "W1-T1", title: "t", origin: "scout:x", files, risk: "low" }, evidence);
    assert.ok(ruling !== undefined && "escalate" in ruling, `${files[0]} escalates`);
  }
  for (const title of ["the CodeQL Analyze gate refused", "Semgrep Scan flags a rule", "the coverage-ratchet moved", "the mutation ratchet"]) {
    const ruling = mechanicalRuling({ id: "W1-T1", title, origin: "scout:x", files: ["test/x.test.ts"], risk: "low" }, evidence);
    assert.ok(ruling !== undefined && "escalate" in ruling, `${title} escalates`);
  }
  const retired = mechanicalRuling({ id: "W1-T1", title: "t", origin: "scout:x", files: ["deploy/x.sh"], risk: "low" }, { ...evidence, shipped: true });
  assert.equal((retired as MechanicalDecision).rule, 1, "rule 1 applies whatever the path class");
});

test("W1-T10371: the symptom readers count a gardener's own window", () => {
  const rows = [
    { step: "s", ts: new Date(NOW - 1000).toISOString() },
    { step: "s", ts: new Date(NOW - 2 * WEEK).toISOString() },
    { step: "other", ts: new Date(NOW - 1000).toISOString() },
  ];
  assert.deepEqual(countStepRows(rows, "s", NOW, WEEK), { count: 1, windowMs: WEEK, lastSeen: new Date(NOW - 1000).toISOString() });
  assert.deepEqual(countStepRows(rows, "missing", NOW, WEEK), { count: 0, windowMs: WEEK });
  const rounds = [{ at: new Date(NOW - 5).toISOString(), k: "a" }, { at: new Date(NOW - 3 * WEEK).toISOString(), k: "a" }, { k: "a" }, { at: new Date(NOW).toISOString(), k: "b" }];
  assert.equal(countRounds(rounds, (r) => r.k === "a", NOW, WEEK).count, 2);
  assert.equal(medianCount([]), undefined);
  assert.equal(medianCount([1, 9, 3, 7]), 5);
  assert.equal(filingEvidenceOf({ rationale: "cost 12 PR minute(s) across 4 red run(s) within the measured window on 2 pull request(s)" }, WEEK)?.count, 4);
  assert.equal(filingEvidenceOf({ rationale: "nothing" }, WEEK), undefined);
});

test("W1-T10371: the verify-human cadence defers to the rules and escalates privileged disagreement", async () => {
  const shard = (id: string): ShardUnderJudgement => ({
    id, title: id, rationale: "x", acceptance: ["x"], ageDays: 3, depsAllMerged: false, citedInSrc: false,
  });
  const ruled = shard("W1-T9261");
  const privileged = shard("W1-T9262");
  const judged: string[] = [];
  const staged: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const result = await verifyHumanCadence({
    shards: [ruled, privileged],
    priorVerdicts: new Map(),
    judge: async (s) => { judged.push(s.id); return { decision: "automate", reason: "looks mechanical" }; },
    // The release judge disagrees on the privileged record: it escalates, and a person is asked, as today.
    release: async (s) => (s.id === privileged.id ? { kind: "escalated", reason: "it touches a gate" } : { kind: "released" }),
    stageProposal: (p) => { staged.push(p.id); },
    appendRow: (row) => { rows.push(row); },
    runId: "VERIFY-HUMAN-CADENCE-rules",
    decidedByRules: (s) => (s.id === ruled.id ? { rule: 3, verdict: "release", evidence: "the symptom is live" } : undefined),
  });
  assert.deepEqual(judged, ["W1-T9262"], "a rule-decided shard is never judged");
  assert.deepEqual(result.deferredToRules, ["W1-T9261"]);
  assert.deepEqual(result.released ?? [], [], "and never released by the cadence");
  assert.deepEqual(result.needsOperator, ["W1-T9262"]);
  assert.equal(staged.length, 1, "one ask, for the privileged record the two judges disagree on");
  assert.match(staged[0]!, /W1-T9262/);
  assert.equal(staged.some((id) => id.includes("W1-T9261")), false, "no ask for the rule-decided shard");
  const row = rows.find((r) => r.step === "verify_human.mechanical_ruling");
  assert.deepEqual({ task: row?.task_id, rule: row?.rule, verdict: row?.verdict }, { task: "W1-T9261", rule: 3, verdict: "release" });
  // A deferral already ledgered is not written again.
  rows.length = 0;
  await verifyHumanCadence({
    shards: [ruled], priorVerdicts: new Map(), judge: async () => assert.fail("judged"), stageProposal: () => assert.fail("asked"),
    appendRow: (r) => { rows.push(r); }, runId: "again", priorMechanicalKeys: new Set(["W1-T9261:3:release"]),
    decidedByRules: () => ({ rule: 3, verdict: "release", evidence: "e" }),
  });
  assert.deepEqual(rows, []);
});

test("W1-T10371: a rule-3 release approveParkedTask refuses leaves the record parked", async (t) => {
  const f = bed(t, [{ id: "W1-T9272", step: "g.guard" }]);
  const report = await runMachineFilingJudge({
    stateDir: f.root, writeRoot: f.root, plan: () => loadPlan(join(f.root, "plan", "tasks.yaml")),
    riskJudge: async () => HIGH, gardenRecord: () => ({ alpha: 3, beta: 1 }), isMerged: () => false,
    stageProposal: () => {}, log: () => {}, clock: { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() },
    mechanical: {
      read: () => ({ symptom: () => reading(5), declined: () => false }),
      release: (task: Task) => ({ code: 2, message: `rmd approve: ${task.id} is high-risk in the plan — a machine cannot release its human verification` }),
    },
  });
  assert.deepEqual(report.refused, ["W1-T9272"]);
  assert.equal(f.task("W1-T9272").verify, "human");
  assert.equal(f.task("W1-T9272").risk_ruling, undefined);
});
