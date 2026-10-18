/**
 * W1-T9694 — THE MACHINE-FILING JUDGE SEES MAIN-RED EVIDENCE FOR A FLAKE FILING.
 *
 * Every flake-incident record the judge read with 0 recovered retries was ruled low/proceed (9 of 9), because
 * its input held only the record's own text. On 2026-10-15 W1-T9668 (9 PRs, 0 recovered, 9 also failed, main
 * red on the file from 037a58d8f) was released to verify: auto. These replays run the real pass over a real
 * ledger: a record the gardener's classifier reads as main-inherited is retired and routed to main-health.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
// Namespace imports, so at a base without these exports the file still loads and each test fails on its own.
import * as flake from "#src/lib/flake-incident-gardener.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import { renderMachineShard } from "#src/lib/machine-filing.js";
import { machineJudgeFoundWork, renderRuledShard, runMachineFilingJudge, type MachineJudgePorts } from "#src/lib/machine-filing-judge.js";
import * as rung from "#src/lib/main-health-rung.js";
import { loadPlan, parseTasksFromYaml } from "#src/lib/plan.js";
import type { RiskJudgeInput, RiskJudgeVerdict } from "#src/lib/risk-judge.js";
import { readLedgerLines } from "#src/lib/status.js";
import { taskRulingPin } from "#src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const CLOCK = fixedClock(Date.parse("2026-10-15T16:35:05Z"));
const FILE = "test/the-sweep-never-sends-a-fix-worker-at-a-red-it-cannot-fix.test.ts";
const TITLE = "W1-T9503: a cause owned by a test alone escalates as no-owner";
const ORIGIN = flake.flakeIncidentOrigin(FILE, TITLE);
const BASE = "037a58d8f".padEnd(40, "0");
const sha = (n: number) => `${n}`.padStart(40, "a");

/** A flake incident in the shape the flake-incident gardener files it. */
function flakeRecord(id: string, recovered: number, alsoFailed: number, prs: number[]): string {
  const rendered = renderMachineShard({
    taskId: id,
    title: `FLAKE INCIDENT — '${TITLE}' failed CI on ${prs.length} pull requests whose diffs do not touch it`,
    origin: ORIGIN,
    files: [FILE],
    cost: prs.length,
    acceptance: [
      { claim: `the cause of the intermittent failure ${id} records in ${FILE} is fixed, pinned by a test that forces the failing order`, proof: `unit test: ${id} pins the cause of the intermittent failure` },
      { claim: `the test that pins the cause is added to ${FILE}, beside the test that failed`, proof: `grep: test("${id} pins the cause of the intermittent failure" in ${FILE}` },
    ],
    note: "Filed by the flake-incident gardener (W1-T6406). MACHINE-AUTHORED — the machine-filing judge releases it or escalates it to a person.",
    rationale: [
      `Test: '${TITLE}' (${FILE})`,
      `Failed CI on ${prs.length} distinct pull requests whose changed files include neither the test file nor a module it imports: ${prs.map((n) => `#${n}`).join(", ")}.`,
      `Retry outcomes: ${recovered} recovered on retry, ${alsoFailed} also failed on retry.`,
    ],
  });
  assert.equal(rendered.refused, undefined);
  return rendered.text;
}

/** The ledger the flake-incident gardener leaves: one `test.flake_retry` row per PR, then its filing row. */
function retryRowsFor(id: string, outcomes: ("recovered" | "also_failed")[]): Record<string, unknown>[] {
  const prs = outcomes.map((_, i) => 12000 + i);
  const at = (i: number) => new Date(CLOCK.now() - (outcomes.length - i) * 3_600_000).toISOString();
  return [
    ...outcomes.map((outcome, i) => ({
      ts: at(i), step: "test.flake_retry", source: "selector-shadow", file: FILE, titles: [TITLE], retry_outcome: outcome,
      ci_run_id: 38000 + i, shard: 3, pr_numbers: [prs[i]], base_sha: BASE, head_sha: sha(i),
    })),
    {
      ts: at(outcomes.length), step: "flake_incident.filed", origin: ORIGIN, task_id: id, prs, run_ids: outcomes.map((_, i) => 38000 + i),
      recovered: outcomes.filter((o) => o === "recovered").length, also_failed: outcomes.filter((o) => o === "also_failed").length,
    },
  ];
}

interface Rig {
  root: string;
  shard: string;
  asked: RiskJudgeInput[];
  lands: { paths: string[]; title: string; body: string }[];
  steps: { step: string; extra?: Record<string, unknown> }[];
  pass: () => ReturnType<typeof runMachineFilingJudge>;
  record: () => ReturnType<typeof loadPlan>["tasks"][number];
}

function rig(t: TestContext, o: {
  id: string; text: string; ledger: Record<string, unknown>[]; mainFailures: (base: string) => readonly string[] | undefined;
  verdict?: RiskJudgeVerdict; landing?: "workspace" | "absent" | "directory";
}): Rig {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flake-judge-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const shard = join(root, "plan", "tasks.d", `${o.id.toLowerCase()}-flake-incident.yaml`);
  writeFileSync(shard, o.text);
  writeFileSync(join(root, LEDGER_FILENAME), o.ledger.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const asked: RiskJudgeInput[] = [];
  const lands: { paths: string[]; title: string; body: string }[] = [];
  const elsewhere = join(root, "landing");
  if (o.landing === "directory") mkdirSync(join(elsewhere, "plan", "tasks.d", `${o.id.toLowerCase()}-flake-incident.yaml`), { recursive: true });
  const steps: { step: string; extra?: Record<string, unknown> }[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => void steps.push({ step, ...(extra ? { extra } : {}) });
  // The port the daemon builds, over this test's ledger: the same rows and main-CI reader the gardener uses.
  const flakeEvidence = flake.flakeJudgeEvidencePort({
    stateDir: root, log, clock: CLOCK, mainFailures: (base) => o.mainFailures(base),
    // ledger-read-intent: live — as productionMachineFilingJudgePorts reads the main.repair rows.
    repairs: () => [...rung.mainRepairRecordsFromLedger(readLedgerLines(join(root, LEDGER_FILENAME))).values()],
  });
  const ports: MachineJudgePorts = {
    stateDir: root,
    plan: () => loadPlan(join(root, "plan", "tasks.yaml")),
    riskJudge: async (input) => {
      asked.push(input);
      return o.verdict ?? { verdict: "low", confidence: 0.95, reasons: ["a test-only repair of a measured flake"] };
    },
    ...(o.landing === "workspace"
      ? { openWorkspace: () => ({ root, branch: "machine-judge-1", land: (l: { paths: string[]; title: string; body: string }) => (lands.push(l), "https://github.com/craigoley/remudero/pull/12200"), dispose: () => {} }) }
      : { writeRoot: o.landing === undefined ? root : elsewhere }),
    stageProposal: () => {},
    log,
    clock: CLOCK,
    flakeEvidence,
  };
  return {
    root, shard, asked, lands, steps,
    pass: () => runMachineFilingJudge(ports),
    record: () => loadPlan(join(root, "plan", "tasks.yaml")).byId.get(o.id)!,
  };
}

const nine = Array.from({ length: 9 }, () => "also_failed" as const);

test("W1-T9694: a flake filing whose retries never recovered and whose base main failed is retired, not released", async (t) => {
  const id = "W1-T9668";
  const r = rig(t, { id, text: flakeRecord(id, 0, 9, nine.map((_, i) => 12000 + i)), ledger: retryRowsFor(id, nine), mainFailures: () => [FILE] });
  const report = await r.pass();

  assert.deepEqual(asked(r), 0, "no model is asked to release a red main itself failed");
  assert.deepEqual(report.proceeded, [], "never released to verify: auto");
  assert.deepEqual(report.retired, [id]);
  const after = r.record();
  assert.equal(after.status, "blocked");
  assert.equal(after.retirement, "retired");
  assert.equal(after.verify, "human");
  assert.match(readFileSync(r.shard, "utf8"), /retirement: retired {2}# not a flake: a red inherited from main\. 0 recovered and 9 also failed on retry over 9 PR\(s\)/);
  assert.match(readFileSync(r.shard, "utf8"), new RegExp(`main's own CI failed it at ${BASE}`));

  const judged = r.steps.find((s) => s.step === "machine_judge.main_inherited");
  assert.deepEqual(judged?.extra, { task_id: id, origin: ORIGIN, recovered: 0, also_failed: 9, main_red: true });
  const routed = r.steps.filter((s) => s.step === flake.FLAKE_INCIDENT_MAIN_INHERITED_STEP);
  assert.equal(routed.length, 1);
  assert.equal(routed[0]!.extra?.route, "main-health");
  assert.equal(routed[0]!.extra?.prs_count, 9);

  // The row reaches W1-T9551's main-health rung as a pending hint, as a gardener-written one does.
  const ledger = join(r.root, "routed.ndjson");
  writeFileSync(ledger, routed.map((s) => JSON.stringify({ step: s.step, ...s.extra })).join("\n") + "\n");
  assert.deepEqual(rung.mainInheritedHintReader(ledger)().pending.map((h) => [h.origin, h.prsCount]), [[ORIGIN, 9]]);

  // A second pass finds a retired record and asks nothing.
  const again = await r.pass();
  assert.deepEqual(again.retired ?? [], []);
  assert.equal(asked(r), 0);
});

function asked(r: Rig): number {
  return r.asked.length;
}

test("W1-T9694: a recovered flake reaches the judge with its main-health evidence", async (t) => {
  const id = "W1-T9701";
  const outcomes = ["recovered", "also_failed", "also_failed"] as const;
  const ledger = [
    ...retryRowsFor(id, [...outcomes]),
    { ts: CLOCK.iso(), step: "main.repair.located", offending_sha: BASE, red_checks: ["ci"], red_detail: [`not ok ${TITLE}`] },
    { ts: CLOCK.iso(), step: "main.repair.fix_opened", offending_sha: BASE, pr_url: "https://github.com/craigoley/remudero/pull/12034" },
  ];
  const r = rig(t, { id, text: flakeRecord(id, 1, 2, [12000, 12001, 12002]), ledger, mainFailures: () => [] });
  const report = await r.pass();

  assert.equal(r.asked.length, 1, "a recovered retry still goes to the model");
  const description = r.asked[0]!.change.description;
  assert.match(description, /FLAKE-INCIDENT EVIDENCE \(from the harness's ledger and main's own CI, not written by the filer\)/);
  assert.match(description, /retry outcomes: 1 recovered on retry, 2 also failed, over 3 filed PR\(s\), 2 of them with a retry that also failed;/);
  assert.match(description, /main's own CI failed the test at the PRs' bases: false;/);
  assert.match(description, new RegExp(`a main-health repair names the test: offending ${BASE}, fix https://github.com/craigoley/remudero/pull/12034\\.`));
  assert.match(description, /the signature of a red inherited from main, not a flake/);
  assert.deepEqual(report.proceeded, [id], "the model's proceed lands as before");
  assert.deepEqual(report.retired ?? [], []);
});

test("W1-T9694: a flake filing whose main evidence is unread reaches the judge, said to be unread", async (t) => {
  const id = "W1-T9702";
  const outcomes = ["also_failed"] as const;
  const r = rig(t, { id, text: flakeRecord(id, 0, 1, [12000]), ledger: retryRowsFor(id, [...outcomes]), mainFailures: () => undefined });
  await r.pass();

  assert.equal(r.asked.length, 1, "one PR and an unread main are too little for the classifier: the model decides");
  assert.match(r.asked[0]!.change.description, /main's own CI failed the test at the PRs' bases: unread;/);
  assert.doesNotMatch(r.asked[0]!.change.description, /bases: false/, "unread is never shown as false");
  assert.equal(r.record().retirement, undefined);
});

test("W1-T9694: a record with no filing row in the ledger is judged with its evidence said to be unread", async (t) => {
  const id = "W1-T9703";
  const r = rig(t, { id, text: flakeRecord(id, 0, 3, [12000, 12001, 12002]), ledger: [], mainFailures: () => [FILE] });
  await r.pass();
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0]!.change.description, /retry outcomes: unread \(no flake_incident\.filed row for this record in the ledger window\);/);
});

test("W1-T9694: a released flake record is reconsidered once on its moved evidence", async (t) => {
  const rel = (id: string) => `plan/tasks.d/${id.toLowerCase()}-flake-incident.yaml`;
  const release = (id: string, text: string): string => {
    const record = parseTasksFromYaml(text, rel(id))[0]!;
    const out = renderRuledShard(text, rel(id), taskRulingPin({ ...record, verify: "auto" }), {
      verdict: "low", action: "proceed", confidence: 0.9, reasons: ["consistent with a genuine flake incident"], judgedAt: "2026-10-10T12:00:00.000Z",
    });
    assert.ok("contents" in out, "the record was released at verify: auto");
    return out.contents;
  };

  // W1-T7532's shape: released on 2026-10-10 before any evidence was shown, and main-inherited.
  const inherited = rig(t, { id: "W1-T7532", text: release("W1-T7532", flakeRecord("W1-T7532", 0, 9, nine.map((_, i) => 12000 + i))), ledger: retryRowsFor("W1-T7532", nine), mainFailures: () => [FILE] });
  assert.equal(inherited.record().verify, "auto");
  const first = await inherited.pass();
  assert.deepEqual(first.retired, ["W1-T7532"]);
  assert.equal(inherited.record().retirement, "retired");
  assert.equal(inherited.asked.length, 0);

  // A released record whose evidence is a real flake is asked once; its unchanged proceed rewrites nothing.
  const id = "W1-T7765";
  const flaky = rig(t, { id, text: release(id, flakeRecord(id, 1, 2, [12000, 12001, 12002])), ledger: retryRowsFor(id, ["recovered", "also_failed", "also_failed"]), mainFailures: () => [] });
  const before = readFileSync(flaky.shard, "utf8");
  const asked1 = await flaky.pass();
  assert.equal(flaky.asked.length, 1, "reconsidered once, with the evidence");
  assert.match(flaky.asked[0]!.change.description, /1 recovered on retry/);
  assert.deepEqual(asked1.proceeded, []);
  assert.equal(readFileSync(flaky.shard, "utf8"), before, "an unchanged proceed writes nothing");
  await flaky.pass();
  assert.equal(flaky.asked.length, 1, "unmoved evidence is not asked again");
  assert.ok(flaky.steps.some((s) => s.step === "machine_judge.flake_reconsidered" && s.extra?.action === "proceed"));

  // The same record asked again escalates when the model now reads the evidence as risky.
  const parked = rig(t, {
    id: "W1-T7799", text: release("W1-T7799", flakeRecord("W1-T7799", 1, 2, [12000, 12001, 12002])),
    ledger: retryRowsFor("W1-T7799", ["recovered", "also_failed", "also_failed"]), mainFailures: () => [],
    verdict: { verdict: "high", confidence: 0.9, reasons: ["the retries say main, not a flake"] },
  });
  const escalated = await parked.pass();
  assert.deepEqual(escalated.escalated, ["W1-T7799"]);
  assert.equal(parked.record().verify, "human");
});

test("W1-T9694: the gardener and the judge share one main-inherited classifier", () => {
  assert.equal(flake.flakeIncidentMainInherited({ recovered: 0, alsoFailedPrs: 2, mainRed: "unread" }), true, "two PRs never recovered");
  assert.equal(flake.flakeIncidentMainInherited({ recovered: 0, alsoFailedPrs: 1, mainRed: true }), true, "main failed it at a base");
  assert.equal(flake.flakeIncidentMainInherited({ recovered: 0, alsoFailedPrs: 1, mainRed: "unread" }), false);
  assert.equal(flake.flakeIncidentMainInherited({ recovered: 1, alsoFailedPrs: 9, mainRed: true }), false, "a recovered retry is a flake candidate");

  // A filing row with no retry rows left in the window answers from its own counts.
  const filedOnly = flake.flakeIncidentRecordEvidence(
    [{ ts: CLOCK.iso(), step: "flake_incident.filed", origin: ORIGIN, task_id: "W1-T9704", prs: [3, 1, 2], recovered: 0, also_failed: 3, also_failed_prs: 3, base_shas: [BASE], run_ids: [7] }],
    ORIGIN, "W1-T9704");
  assert.deepEqual(filedOnly, { file: FILE, title: TITLE, prs: [1, 2, 3], recovered: 0, alsoFailed: 3, alsoFailedPrs: 3, baseShas: [BASE], runs: [7] });
  assert.equal(flake.flakeIncidentRecordEvidence([], ORIGIN, "W1-T9704"), undefined);
});

test("W1-T9694: a retirement lands through the one judge PR, proven by its retirement line", async (t) => {
  const id = "W1-T9705";
  const r = rig(t, { id, text: flakeRecord(id, 0, 9, nine.map((_, i) => 12000 + i)), ledger: retryRowsFor(id, nine), mainFailures: () => [FILE], landing: "workspace" });
  const report = await r.pass();
  assert.deepEqual(report.retired, [id], "the retirement the landing tree reads is current, never withdrawn as stale");
  assert.equal(report.prUrl, "https://github.com/craigoley/remudero/pull/12200");
  assert.equal(machineJudgeFoundWork({ proceeded: [], escalated: [], unavailable: [], refused: [], failed: [], settled: [], retired: [id] }), true);
  assert.equal(r.lands.length, 1);
  assert.match(r.lands[0]!.body, new RegExp(`- \`${id}\`: \\*\\*retire\\*\\* \\(a red inherited from main, routed to main-health; W1-T9694\\)`));
  assert.match(r.lands[0]!.body, new RegExp(`  proof: grep: \\^  retirement: retired in plan/tasks\\.d/${id.toLowerCase()}-flake-incident\\.yaml`));
});

test("W1-T9694: a retirement the landing tree cannot take is refused or failed, never released", async (t) => {
  const absent = rig(t, { id: "W1-T9706", text: flakeRecord("W1-T9706", 0, 9, nine.map((_, i) => 12000 + i)), ledger: retryRowsFor("W1-T9706", nine), mainFailures: () => [FILE], landing: "absent" });
  const refused = await absent.pass();
  assert.deepEqual(refused.refused, ["W1-T9706"]);
  assert.deepEqual(refused.proceeded, []);
  assert.match(String(absent.steps.find((s) => s.step === "machine_judge.refused")?.extra?.reason), /is absent from the landing tree/);
  const again = await absent.pass();
  assert.deepEqual(again.refused, [], "a refused record is declined at its pin, not retried every pass");

  const broken = rig(t, { id: "W1-T9707", text: flakeRecord("W1-T9707", 0, 9, nine.map((_, i) => 12000 + i)), ledger: retryRowsFor("W1-T9707", nine), mainFailures: () => [FILE], landing: "directory" });
  const failed = await broken.pass();
  assert.deepEqual(failed.failed, ["W1-T9707"], "a landing that throws is ledgered and skipped");
  assert.ok(broken.steps.some((s) => s.step === "machine_judge.record_failed"));
});

test("W1-T9694: a released flake record the judge cannot answer is asked again next pass", async (t) => {
  const id = "W1-T9708";
  const rel = `plan/tasks.d/${id.toLowerCase()}-flake-incident.yaml`;
  const text = flakeRecord(id, 1, 2, [12000, 12001, 12002]);
  const out = renderRuledShard(text, rel, taskRulingPin({ ...parseTasksFromYaml(text, rel)[0]!, verify: "auto" }), {
    verdict: "low", action: "proceed", confidence: 0.9, reasons: ["a flake"], judgedAt: "2026-10-10T12:00:00.000Z",
  });
  assert.ok("contents" in out);
  const r = rig(t, {
    id, text: out.contents, ledger: retryRowsFor(id, ["recovered", "also_failed", "also_failed"]), mainFailures: () => [],
    verdict: { verdict: "low", confidence: 0, reasons: ["no model reached"], availability: "unavailable" },
  });
  const first = await r.pass();
  assert.deepEqual(first.unavailable, [id]);
  await r.pass();
  assert.equal(r.asked.length, 2, "an unanswered reconsideration books nothing, so it is asked again");
});
