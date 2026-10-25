import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  escalateWithJudge, escalationJudgeReceiptFields, escalationJudgeRunId, judgeEscalation,
  parseEscalationJudgeVerdict, realEscalationJudge,
  type Escalation, type EscalationJudgeVerdict,
} from "#src/lib/escalate.js";
import { runStaleEscalationRejudge, type StaleEscalationRejudgeCandidate } from "#src/lib/sweep.js";
import type { Mount, Mounts } from "#src/lib/mounts.js";
import type { spawnWorker, WorkerResult } from "#src/lib/worker.js";

const assignment = "11111111-2222-4333-8444-555555555555";
const mount: Mount = { model: "haiku", effort: "low", maxTurns: 1, contextBudget: 60000 };
const mounts: Mounts = {
  tiers: { haiku: 1, opus: 2 }, efforts: { low: 1, high: 2 },
  architect: { ...mount, model: "opus", effort: "high" },
  judge: { ...mount, model: "opus", effort: "high" }, escalation_judge: mount,
  synthesis: { retro: mount, triage: mount, inbox_draft: mount },
  routes: { recon: { low: { src: mount } } },
};
const subject: Escalation = {
  class: "BLOCKED", taskId: "W1-RECEIPT", summary: "A live unresolved condition",
  detail: "The referent remains open.", options: [{ label: "wait", detail: "Preserve the owning repair" }],
  recommendation: "wait",
};
const output = "ESCALATION_JUDGE_DECISION: demote\nESCALATION_JUDGE_REASON: routine repeat";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-judge-output-")), ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { ledgerPath, rows: () => readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) };
}

function worker(text: string, id: string | undefined = assignment): WorkerResult {
  return {
    sessionId: "test-session", costUsd: 0.001, numTurns: 1, text, blocks: [text], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "haiku", effort: "low", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
    ...(id === undefined ? {} : { selectionAssignmentId: id }),
  };
}

function judgeFor(text: string, id: string | undefined = assignment) {
  return realEscalationJudge({ mounts, cwd: "/unused", settingsFile: "/unused/settings.json",
    spawn: (async () => worker(text, id)) as typeof spawnWorker });
}

function candidate(issue: number): StaleEscalationRejudgeCandidate {
  return { issueUrl: `https://example.test/issues/${issue}`, issueNumber: issue,
    escalation: subject, ageMs: 7 * 60 * 60 * 1000, referentStateNow: "open",
    siblingSummaries: [], stateKey: `state-${issue}` };
}

test("escalation output receipts distinguish parsed decisions from fail-open output without changing the public parser", async () => {
  for (const text of [output, "ESCALATION_JUDGE_DECISION: DELIVER", "", "ESCALATION_JUDGE_DECISION: bogus"]) {
    const parsed = parseEscalationJudgeVerdict(text), verdict = await judgeFor(text)(subject);
    assert.deepEqual(verdict, parsed, "receipt metadata must not widen the verdict or change parsing");
    assert.deepEqual(escalationJudgeReceiptFields(parsed), { judge_output_state: "unknown" });
    assert.deepEqual(escalationJudgeReceiptFields(verdict), {
      judge_output_state: text === output || text.includes("DELIVER") ? "accepted" : "unparseable",
      judge_output_decision: parsed.decision, judge_run_id: escalationJudgeRunId(subject),
      judge_selection_assignment_id: assignment,
    });
  }
});

test("escalation output receipts never invent a missing or malformed assignment identity", async () => {
  for (const id of [undefined, "", "foreign-id", "prompt-or-error-secret", "11111111-2222-4333-8444-555555555555\n"]) {
    // Explicitly delete the default fixture id for the absent case.
    const result = worker(output);
    if (id === undefined) delete result.selectionAssignmentId;
    else result.selectionAssignmentId = id;
    const judge = realEscalationJudge({ mounts, cwd: "/unused", settingsFile: "/unused/settings.json",
      spawn: (async () => result) as typeof spawnWorker });
    assert.deepEqual(escalationJudgeReceiptFields(await judge(subject)), {
      judge_output_state: "accepted", judge_output_decision: "demote", judge_run_id: escalationJudgeRunId(subject),
    });
  }
});

test("escalation output receipts bind identity before an asynchronous caller can mutate its subject", async () => {
  const input = { ...subject }, expected = escalationJudgeRunId(input);
  const judge = realEscalationJudge({ mounts, cwd: "/unused", settingsFile: "/unused/settings.json",
    spawn: (async args => {
      assert.ok(args.prompt.includes(subject.detail));
      input.detail = "A later condition, not what this worker judged";
      return worker(output);
    }) as typeof spawnWorker });
  const verdict = await judge(input);
  assert.notEqual(escalationJudgeRunId(input), expected);
  assert.equal(escalationJudgeReceiptFields(verdict).judge_run_id, expected);
});

test("escalation birth ledgers the actual model receipt while preserving shadow delivery", async t => {
  const f = fixture(t), labels: string[][] = [];
  const url = await escalateWithJudge(subject, {
    ledgerPath: f.ledgerPath, runId: "parent-daemon", judge: judgeFor(output),
    issues: { create: (_title, _body, given) => { labels.push(given); return "https://example.test/issues/1"; } },
    triage: { mode: "shadow", evidence: () => ({ classTier: "issue" }) },
  });
  assert.equal(url, "https://example.test/issues/1");
  assert.ok(labels[0]?.includes("needs-human"), "shadow still delivers an actual model demotion");
  const row = f.rows().find(row => row.step === "escalation.judged");
  assert.equal(row?.run_id, "parent-daemon");
  assert.equal(row?.judge_decision, "demote");
  assert.equal(row?.judge_output_state, "accepted");
  assert.equal(row?.judge_run_id, escalationJudgeRunId(subject));
  assert.equal(row?.judge_selection_assignment_id, assignment);
});

test("escalation rejudge preserves the original output receipt before triage overwrites the final decision", async t => {
  const f = fixture(t);
  const summary = await runStaleEscalationRejudge([candidate(1)], {
    ledgerPath: f.ledgerPath, runId: "parent-daemon", judge: () => judgeFor(output)(subject),
    demote: () => assert.fail("shadow mode must not demote"), triage: { mode: "shadow" },
  });
  assert.equal(summary.results[0]?.decision, "deliver");
  assert.deepEqual(summary.judgedStateKeys, ["state-1"], "receipt capture must not change memo eligibility");
  const row = f.rows().find(row => row.step === "escalation.rejudged");
  assert.equal(row?.judge_decision, "deliver");
  assert.equal(row?.judge_output_decision, "demote");
  assert.equal(row?.judge_output_state, "accepted");
  assert.equal(row?.judge_run_id, escalationJudgeRunId(subject));
  assert.equal(row?.judge_selection_assignment_id, assignment);
});

test("escalation rejudge records unparseable output separately from a genuine deliver verdict", async t => {
  const f = fixture(t);
  await runStaleEscalationRejudge([candidate(1)], {
    ledgerPath: f.ledgerPath, runId: "parent-daemon", judge: () => judgeFor("unstructured output")(subject),
    demote: () => assert.fail("unparseable output must still fail open"), triage: { mode: "act" },
  });
  const row = f.rows().find(row => row.step === "escalation.rejudged");
  assert.equal(row?.judge_decision, "deliver");
  assert.equal(row?.judge_output_decision, "deliver");
  assert.equal(row?.judge_output_state, "unparseable");
  assert.equal(row?.judge_selection_assignment_id, assignment);
  assert.ok(!JSON.stringify(row).includes("unstructured output"), "new receipt fields retain no raw model output");
});

test("escalation cached rejudges retain one actual assignment across sibling issue receipts", async t => {
  const f = fixture(t);
  let spawns = 0;
  const real = realEscalationJudge({ mounts, cwd: "/unused", settingsFile: "/unused/settings.json",
    spawn: (async () => { spawns++; return worker(output); }) as typeof spawnWorker });
  const memo = real(subject);
  await runStaleEscalationRejudge([candidate(1), candidate(2)], {
    ledgerPath: f.ledgerPath, runId: "parent-daemon", judge: () => memo,
    demote: () => assert.fail("shadow mode must not demote"), triage: { mode: "shadow" },
  });
  const rows = f.rows().filter(row => row.step === "escalation.rejudged");
  assert.equal(spawns, 1);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.judge_output_state), ["accepted", "accepted"]);
  assert.deepEqual([...new Set(rows.map(row => row.judge_selection_assignment_id))], [assignment],
    "count cash per actual assignment, not once per issue");
});

test("escalation injected or cloned verdicts cannot forge producer receipts or change normal demotion", async t => {
  const f = fixture(t), actual = await judgeFor(output)(subject), demoted: string[] = [];
  const forged = { ...actual, receipt: { state: "accepted", assignmentId: assignment },
    judge_output_state: "accepted", judge_selection_assignment_id: assignment };
  assert.deepEqual(escalationJudgeReceiptFields(forged), { judge_output_state: "unknown" });
  await runStaleEscalationRejudge([candidate(1)], {
    ledgerPath: f.ledgerPath, runId: "parent-daemon", judge: async () => forged,
    demote: url => { demoted.push(url); },
  });
  assert.deepEqual(demoted, [candidate(1).issueUrl]);
  const row = f.rows().find(row => row.step === "escalation.rejudged");
  assert.equal(row?.judge_output_state, "unknown");
  assert.equal(row?.judge_selection_assignment_id, undefined);
  assert.equal(row?.judge_run_id, undefined);
});

test("escalation unavailable exempt and deterministic paths remain unknown without extra model calls", async t => {
  const f = fixture(t);
  let spawns = 0;
  const unavailable = async (): Promise<EscalationJudgeVerdict> => { spawns++; throw Error("unavailable"); };
  const exempt = await judgeEscalation({ ...subject, class: "MANUAL" }, { judge: unavailable });
  assert.equal(spawns, 0);
  assert.deepEqual(escalationJudgeReceiptFields(exempt), { judge_output_state: "unknown" });
  const failed = await judgeEscalation(subject, { judge: unavailable });
  assert.equal(failed.decision, "deliver");
  assert.deepEqual(escalationJudgeReceiptFields(failed), { judge_output_state: "unknown" });
  await runStaleEscalationRejudge([candidate(1)], {
    ledgerPath: f.ledgerPath, runId: "parent-daemon", judge: unavailable,
    demote: () => assert.fail("deterministic shadow path must deliver"),
    triage: { mode: "shadow", evidence: () => ({ classTier: "digest" }) },
  });
  assert.equal(spawns, 1, "only the explicit unavailable judge call ran");
  assert.equal(f.rows().find(row => row.step === "escalation.rejudged")?.judge_output_state, "unknown");
});
