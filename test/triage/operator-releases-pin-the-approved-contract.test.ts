import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { resolveReleases, runnableCandidates } from "#src/lib/drain.js";
import { renderMachineShard } from "#src/lib/machine-filing.js";
import * as machineJudge from "#src/lib/machine-filing-judge.js";
import { assertRunnable, loadPlan, type Task } from "#src/lib/plan.js";
import { approveParkedTask, productionMachineFilingJudgePorts, releaseReadersFor } from "#src/run-task.js";

const ID = "W1-T9901";
const CLOCK = fixedClock(Date.parse("2026-10-24T10:00:00Z"));

const { readOperatorReleases, recordOperatorRelease, runMachineFilingJudge } = machineJudge;
function readOperatorReleaseRecords(stateDir: string) {
  assert.equal(typeof machineJudge.readOperatorReleaseRecords, "function", "the existing public judge module exposes qualified release evidence");
  return machineJudge.readOperatorReleaseRecords(stateDir);
}

function operatorReleasePin(task: Task): string {
  const state = mkdtempSync(join(tmpdir(), "rmd-release-pin-witness-"));
  try {
    recordOperatorRelease(state, task, CLOCK.iso());
    const record = JSON.parse(readFileSync(join(state, "operator-releases.json"), "utf8")).releases[task.id];
    assert.equal(typeof record?.pin, "string", "the real approval writer records the current contract pin");
    assert.match(record.pin, /^[0-9a-f]{64}$/);
    return record.pin;
  } finally { rmSync(state, { recursive: true, force: true }); }
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-release-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan/tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "plan/tasks.yaml"), "[]\n");
  const rendered = renderMachineShard({ taskId: ID, title: "record the bounded remedy", origin: "flow-blocker:fixture",
    files: ["docs/remedy.md"], acceptance: [{ claim: "remedy recorded", proof: "grep: remedy in docs/remedy.md" }] });
  assert.equal(rendered.refused, undefined);
  const path = join(root, "plan/tasks.d", `${ID}.yaml`);
  writeFileSync(path, rendered.text!);
  const plan = () => loadPlan(join(root, "plan/tasks.yaml"));
  const task = () => plan().byId.get(ID)!;
  const stateDir = join(root, "state");
  const ledger = join(stateDir, "ledger.ndjson");
  writeFileSync(ledger, "");
  let modelCalls = 0;
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const judge = (landingRoot = root) => runMachineFilingJudge({ stateDir, plan, writeRoot: landingRoot,
    operatorReleases: () => readOperatorReleaseRecords(stateDir),
    releaseLedgerLines: () => readFileSync(ledger, "utf8").split("\n"),
    riskJudge: async () => { modelCalls++; return { verdict: "low", confidence: 1, reasons: ["low"] }; },
    isMerged: () => false, stageProposal: () => {}, clock: CLOCK,
    log: (step, extra = {}) => rows.push({ step, extra }),
  });
  return { root, path, plan, task, stateDir, ledger, judge, modelCalls: () => modelCalls, rows };
}

test("an unpinned operator release cannot dispatch or be reapproved by a model", async t => {
  const f = fixture(t);
  for (const store of ["ledger", "durable"] as const) {
    writeFileSync(f.ledger, store === "ledger" ? JSON.stringify({ step: "ratify.approved", task_id: ID }) + "\n" : "");
    writeFileSync(join(f.stateDir, "operator-releases.json"), JSON.stringify({ releases: store === "durable" ? { [ID]: CLOCK.iso() } : {} }));
    const resolution = resolveReleases(releaseReadersFor(f.ledger), f.plan());
    assert.equal(resolution.ids.has(ID), false, store);
    assert.equal(resolution.setAside.has(ID), true, store);
    const report = await f.judge();
    assert.deepEqual(report.proceeded, [], store);
    assert.equal(f.modelCalls(), 0, store);
    assert.equal(f.task().verify, "human");
    const machine = approveParkedTask(ID, { plan: f.plan(), ledgerPath: f.ledger, runId: "machine",
      provenance: { author_class: "machine" }, riskPolicy: { verifyHumanReleaseEnabled: true } as never });
    assert.equal(machine.code, 2, store);
    assert.match(machine.message, /explicit operator reapproval/);
  }
  assert.ok(f.rows.some(row => row.step === "machine_judge.reapproval_required"));
});

test("an exact current operator approval survives rotation and its verification transition", async t => {
  const f = fixture(t);
  writeFileSync(f.ledger, JSON.stringify({ step: "ratify.approved", task_id: ID }) + "\n");
  writeFileSync(join(f.stateDir, "operator-releases.json"), JSON.stringify({ releases: { [ID]: "2026-10-01T00:00:00Z" } }));
  const appended: Array<Record<string, unknown>> = [];
  const outcome = approveParkedTask(ID, { plan: f.plan(), ledgerPath: f.ledger, runId: "operator",
    append: (_path, row) => { appended.push(row); writeFileSync(f.ledger, readFileSync(f.ledger, "utf8") + JSON.stringify(row) + "\n"); },
    recordDurableRelease: task => recordOperatorRelease(f.stateDir, task, CLOCK.iso()) });
  assert.equal(outcome.released, true);
  assert.equal(appended.length, 1, "the old unpinned row cannot suppress a fresh explicit approval");
  assert.equal(appended[0]!.release_pin, operatorReleasePin(f.task()));
  const durable = readOperatorReleaseRecords(f.stateDir).get(ID) as Record<string, unknown>;
  assert.equal(durable.legacy, "2026-10-01T00:00:00Z");
  assert.equal(resolveReleases(releaseReadersFor(f.ledger), f.plan()).ids.has(ID), true);
  writeFileSync(f.ledger, "");
  assert.equal(resolveReleases(releaseReadersFor(f.ledger), f.plan()).ids.has(ID), true);
  const pin = operatorReleasePin(f.task());
  const report = await f.judge();
  assert.deepEqual(report.proceeded, [ID]);
  assert.equal(f.modelCalls(), 0);
  assert.equal(f.task().verify, "auto");
  assert.equal(operatorReleasePin(f.task()), pin);
  assert.equal(readOperatorReleases(f.stateDir, f.plan().tasks).has(ID), true);
});

test("contract drift requires reapproval and cannot hide in a matching machine receipt", async t => {
  const f = fixture(t);
  recordOperatorRelease(f.stateDir, f.task(), CLOCK.iso());
  const approved = operatorReleasePin(f.task());
  writeFileSync(f.path, readFileSync(f.path, "utf8") + "  amendment: permit a different production action\n");
  assert.notEqual(operatorReleasePin(f.task()), approved);
  writeFileSync(f.ledger, JSON.stringify({ step: "ratify.approved", task_id: ID, author_class: "machine", release_pin: operatorReleasePin(f.task()) }) + "\n");
  assert.equal(resolveReleases(releaseReadersFor(f.ledger), f.plan()).ids.has(ID), false);
  assert.deepEqual((await f.judge()).proceeded, []);
  assert.equal(f.modelCalls(), 0);
  assert.equal(readOperatorReleases(f.stateDir, f.plan().tasks).has(ID), false);
});

test("an operator contract that changes in the landing tree cannot receive a new ruling", async t => {
  const f = fixture(t);
  recordOperatorRelease(f.stateDir, f.task(), CLOCK.iso());
  const landing = mkdtempSync(join(tmpdir(), "rmd-release-landing-"));
  t.after(() => rmSync(landing, { recursive: true, force: true }));
  mkdirSync(join(landing, "plan/tasks.d"), { recursive: true });
  const target = join(landing, "plan/tasks.d", `${ID}.yaml`);
  const drifted = readFileSync(f.path, "utf8") + "  amendment: additional unapproved action\n";
  writeFileSync(target, drifted);
  const report = await f.judge(landing);
  assert.deepEqual(report.proceeded, []);
  assert.deepEqual(report.refused, [ID]);
  assert.equal(readFileSync(target, "utf8"), drifted);
  assert.equal(f.modelCalls(), 0);
});

test("release pins ignore only bookkeeping and the verification transition", t => {
  const f = fixture(t);
  const task = f.task();
  const pin = operatorReleasePin(task);
  assert.equal(operatorReleasePin({ ...task, sourcePath: "elsewhere", attempts: 99, verify: "auto" }), pin);
  for (const update of [{ design: "expanded" }, { amendment: "expanded" }, { files: ["src/expanded.ts"] },
    { dispatch_hold: true }, { retirement: "retired" }, { status: "blocked" }, { budget_usd: 200 }]) {
    assert.notEqual(operatorReleasePin({ ...task, ...update } as Task), pin);
  }
});

test("an observed legacy reapproval hold survives rotation until an explicit new approval", async t => {
  const f = fixture(t);
  writeFileSync(f.ledger, JSON.stringify({ step: "ratify.approved", task_id: ID }) + "\n");
  assert.deepEqual((await f.judge()).proceeded, []);
  writeFileSync(f.ledger, "");
  assert.equal(resolveReleases(releaseReadersFor(f.ledger), f.plan()).setAside.has(ID), true);
  assert.deepEqual((await f.judge()).proceeded, []);
  assert.equal(f.modelCalls(), 0);
  assert.equal(f.rows.filter(row => row.step === "machine_judge.reapproval_required").length, 1,
    "an unchanged hold is recorded once rather than flooding every garden pass");
  const outcome = approveParkedTask(ID, { plan: f.plan(), ledgerPath: f.ledger, runId: "operator",
    recordDurableRelease: task => recordOperatorRelease(f.stateDir, task, CLOCK.iso()) });
  assert.equal(outcome.released, true);
  assert.deepEqual((await f.judge()).proceeded, [ID]);
  assert.equal(f.modelCalls(), 0);
});

test("a landed operator ruling cannot authorize a later narrative change", async t => {
  const f = fixture(t);
  recordOperatorRelease(f.stateDir, f.task(), CLOCK.iso());
  assert.deepEqual((await f.judge()).proceeded, [ID]);
  assert.equal(f.task().risk_ruling?.operator_release_pin, operatorReleasePin(f.task()));
  writeFileSync(f.path, readFileSync(f.path, "utf8") + "  amendment: a different production action\n");
  assert.deepEqual(runnableCandidates(f.plan(), () => false, 10).map(task => task.id), []);
  assert.throws(() => assertRunnable(f.plan(), f.task(), () => false), /reapproval/);
  assert.deepEqual((await f.judge()).proceeded, []);
  assert.equal(f.modelCalls(), 0);
  writeFileSync(f.path, readFileSync(f.path, "utf8").replace("  verify: auto", "  verify: human"));
  const outcome = approveParkedTask(ID, { plan: f.plan(), ledgerPath: f.ledger, runId: "operator-new",
    recordDurableRelease: task => recordOperatorRelease(f.stateDir, task, CLOCK.iso()) });
  assert.equal(outcome.released, true);
  assert.deepEqual((await f.judge()).proceeded, [ID]);
  assert.equal(f.task().risk_ruling?.operator_release_pin, operatorReleasePin(f.task()));
});

test("unread operator history cannot be overruled by a machine receipt", async t => {
  const f = fixture(t);
  const row = { step: "ratify.approved", task_id: ID, author_class: "machine", release_pin: operatorReleasePin(f.task()) };
  writeFileSync(f.ledger, JSON.stringify(row) + "\n");
  writeFileSync(join(f.stateDir, "operator-releases.json"), "{ torn");
  const unknown = resolveReleases(releaseReadersFor(f.ledger), f.plan());
  assert.equal(unknown.ids.has(ID), false);
  assert.equal(unknown.unknownReleaseHistory?.has(ID), true);
  assert.match(unknown.durableUnreadable!, /JSON/);
  writeFileSync(f.ledger, JSON.stringify({ ...row, author_class: "operator" }) + "\n");
  assert.equal(resolveReleases(releaseReadersFor(f.ledger), f.plan()).ids.has(ID), true,
    "a matching explicit operator receipt remains positive authority independently of the failed reader");

  writeFileSync(join(f.stateDir, "operator-releases.json"), JSON.stringify({ releases: {} }));
  writeFileSync(f.ledger, JSON.stringify(row) + "\n");
  writeFileSync(join(f.root, "plan/policy.yaml"), "{}\n");
  let modelCalls = 0;
  let writes = 0;
  const ports = {
    ...productionMachineFilingJudgePorts({ repoRoot: f.root, stateDir: f.stateDir,
      worktreesRoot: join(f.root, "worktrees"), owner: "fixture", repo: "fixture", log: () => {}, clock: CLOCK }),
    plan: f.plan, writeRoot: f.root, isMerged: () => false, stageProposal: () => {},
    riskJudge: async () => { modelCalls++; return { verdict: "low" as const, confidence: 1, reasons: ["low"] }; },
  };
  assert.deepEqual(ports.releaseLedgerLines!(), [JSON.stringify(row)], "the production reader sees the receipt while readable");
  assert.equal(resolveReleases(releaseReadersFor(f.ledger), f.plan()).ids.has(ID), true);
  const before = readFileSync(f.path, "utf8");
  rmSync(f.ledger);
  mkdirSync(f.ledger); // EISDIR is a real read failure even when tests run as root.
  const unread = resolveReleases(releaseReadersFor(f.ledger), f.plan());
  assert.match(unread.ledgerUnreadable!, /EISDIR/);
  assert.equal(unread.ids.has(ID), false);
  assert.throws(() => approveParkedTask(ID, { plan: f.plan(), ledgerPath: f.ledger, runId: "machine-unread",
    provenance: { author_class: "machine" }, append: () => { writes++; } }), /EISDIR/);
  await assert.rejects(runMachineFilingJudge(ports), /EISDIR/);
  assert.equal(modelCalls, 0, "the production judge cannot ask a model past unread operator history");
  assert.equal(writes, 0, "the approval writer cannot mint another machine receipt");
  assert.equal(readFileSync(f.path, "utf8"), before, "an unread ledger cannot rewrite the parked contract");

  recordOperatorRelease(f.stateDir, f.task(), CLOCK.iso());
  const approved = resolveReleases(releaseReadersFor(f.ledger), f.plan());
  assert.equal(approved.ids.has(ID), true, "a pinned durable operator receipt is independent positive authority");
  assert.match(approved.ledgerUnreadable!, /EISDIR/);
  rmSync(f.ledger, { recursive: true });
  assert.deepEqual(ports.releaseLedgerLines!(), [], "a fresh checkout without a ledger still has empty history");
  assert.equal(resolveReleases(releaseReadersFor(f.ledger), f.plan()).ledgerUnreadable, undefined);
  assert.deepEqual((await runMachineFilingJudge(ports)).proceeded, [ID], "the judge resumes when history is readable");
  assert.equal(modelCalls, 0, "the restored judge honors the explicit approval without a model call");
});


async function parkedReapprovalControl(t: TestContext, store: "ledger" | "durable") {
  const f = fixture(t);
  let now = CLOCK.now();
  let modelCalls = 0;
  let answer: "high" | "low" = "high";
  const run = () => runMachineFilingJudge({ stateDir: f.stateDir, plan: f.plan, writeRoot: f.root,
    operatorReleases: () => readOperatorReleaseRecords(f.stateDir),
    releaseLedgerLines: () => readFileSync(f.ledger, "utf8").split("\n"),
    riskJudge: async () => { modelCalls++; return { verdict: answer, confidence: 1, reasons: [answer] }; },
    isMerged: () => false, stageProposal: () => {}, clock: fixedClock(now), log: () => {},
  });
  assert.deepEqual((await run()).escalated, [ID]);
  assert.equal(modelCalls, 1);
  assert.equal(f.task().risk_ruling?.action, "escalate");
  const before = readFileSync(f.path, "utf8");
  if (store === "ledger") writeFileSync(f.ledger, JSON.stringify({ step: "ratify.approved", task_id: ID }) + "\n");
  else writeFileSync(join(f.stateDir, "operator-releases.json"), JSON.stringify({ releases: { [ID]: CLOCK.iso() } }));
  answer = "low";
  now += 20 * machineJudge.MACHINE_JUDGE_REASK_SCALE_MS;
  const held = await run();
  assert.equal(modelCalls, 1, "a due escalation cannot ask the model past an explicit reapproval hold");
  assert.deepEqual(held.proceeded, []);
  assert.deepEqual(held.reasked ?? [], []);
  assert.equal(readFileSync(f.path, "utf8"), before);
  assert.equal(resolveReleases(releaseReadersFor(f.ledger), f.plan()).setAside.has(ID), true);
  writeFileSync(f.ledger, "");
  writeFileSync(join(f.stateDir, "operator-releases.json"), JSON.stringify({ releases: {} }));
  now += 4 * machineJudge.MACHINE_JUDGE_REASK_SCALE_MS;
  const rotated = await run();
  assert.equal(modelCalls, 1, "the remembered hold survives losing the original receipt");
  assert.deepEqual(rotated.proceeded, []);
  assert.deepEqual(rotated.reasked ?? [], []);
  assert.equal(readFileSync(f.path, "utf8"), before);
  const approval = approveParkedTask(ID, { plan: f.plan(), ledgerPath: f.ledger, runId: "operator-current-escalation",
    recordDurableRelease: task => recordOperatorRelease(f.stateDir, task, fixedClock(now).iso()) });
  assert.equal(approval.released, true);
  assert.deepEqual((await run()).proceeded, [ID]);
  assert.equal(modelCalls, 1, "explicit approval uses its own authority without another model call");
  assert.equal(f.task().verify, "auto");
}

test("an unpinned operator release cannot dispatch or be reapproved by a model during parked escalation re-asks", async t => {
  await parkedReapprovalControl(t, "ledger");
});

test("an observed legacy reapproval hold survives rotation until an explicit new approval during parked escalation re-asks", async t => {
  await parkedReapprovalControl(t, "durable");
});
