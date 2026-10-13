import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FLEET_NOTICE_LABEL,
  NEEDS_HUMAN_LABEL,
  escalate,
  escalateWithJudge,
  tryEscalate,
  escalateAsync,
  configureEscalationTriage,
  type Escalation,
  type IssueGateway,
} from "../src/lib/escalate.js";
import {
  TRIAGE_ACTIONS,
  newTriagePass,
  parseEscalationTriagePolicy,
  triageEscalation,
} from "../src/lib/escalation-triage.js";
import { runStaleEscalationRejudge } from "../src/lib/sweep.js";

function ledger(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-triage-")), "ledger.ndjson");
}

function rows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function gateway(): IssueGateway & { calls: Array<{ title: string; labels: string[] }>; comments: string[] } {
  const calls: Array<{ title: string; labels: string[] }> = [];
  const comments: string[] = [];
  return {
    calls,
    comments,
    create(title, _body, labels) {
      calls.push({ title, labels });
      return `https://github.com/craigoley/remudero/issues/${calls.length}`;
    },
    comment(_url, body) {
      comments.push(body);
    },
  };
}

function esc(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-TX",
    summary: "two strikes exhausted",
    detail: "the retry still failed.",
    options: [
      { label: "retry", detail: "resume with a fresh worker" },
      { label: "abandon", detail: "drop the task" },
    ],
    recommendation: "retry",
    ...over,
  };
}

const staleProof = (): Escalation =>
  esc({
    taskId: "W1-TS",
    summary: "W1-TS: a filed proof already passes at the merge base, so branch run-W1-TS-1 cannot open a PR",
    options: [
      { label: "amend-proof", detail: "amend the proof in a plan-only PR" },
      { label: "retire-task", detail: "retire the task" },
    ],
    recommendation: "amend-proof",
  });

const citationGrill = (): Escalation =>
  esc({
    class: "GRILL",
    taskId: "TRIAGE-7",
    summary: "feedback#7 needs a human call: ALREADY_DECIDED was claimed but the citation names X",
    detail: "Open question: ALREADY_DECIDED was claimed but the citation names X",
    options: [
      { label: "confirm-closure", detail: "close it" },
      { label: "file-as-task", detail: "file it" },
    ],
    recommendation: "file-as-task",
  });

test("W1-T8868: an escalation is triaged before it reaches the operator", async () => {
  // ── deterministic rules pick an action only from the closed set ──────────────────────────
  const grill = triageEscalation(citationGrill());
  assert.deepEqual([grill.kind, grill.kind === "auto_resolve" && grill.action], ["auto_resolve", "feedback_reply"]);
  const proof = triageEscalation(staleProof());
  assert.deepEqual([proof.kind, proof.kind === "auto_resolve" && proof.action], ["auto_resolve", "plan_amendment_pr"]);
  const rekick = triageEscalation(esc(), { rekick: { newFailureSinceLastStrike: true, priorRekicks: 0 } });
  assert.equal(rekick.kind === "auto_resolve" && rekick.action, "rekick_once");
  const twice = triageEscalation(esc(), { rekick: { newFailureSinceLastStrike: true, priorRekicks: 1 } });
  assert.equal(twice.kind, "deliver", "a head is re-kicked at most once");
  const dflt = triageEscalation(esc(), { defaultApplies: true });
  assert.equal(dflt.kind === "auto_resolve" && dflt.action, "apply_default");
  for (const o of [grill, proof, rekick, dflt]) {
    assert.ok(o.kind === "auto_resolve" && (TRIAGE_ACTIONS as readonly string[]).includes(o.action));
  }
  assert.equal(triageEscalation(esc(), { classTier: "digest" }).kind, "digest");
  assert.equal(triageEscalation(esc(), { classTier: "issue" }).kind, "deliver");

  // ── the model never picks an action: it only chooses digest or deliver on the remainder ──
  const demote = { decision: "demote", reason: "can wait" } as const;
  const modelOnRemainder = triageEscalation(esc(), {}, demote);
  assert.deepEqual([modelOnRemainder.kind, modelOnRemainder.decidedBy], ["digest", "model"]);
  const modelOverRule = triageEscalation(staleProof(), {}, demote);
  assert.equal(modelOverRule.kind, "auto_resolve", "a model verdict cannot displace a rule");
  assert.equal(triageEscalation(esc(), {}, { decision: "deliver", reason: "x" }).kind, "deliver");

  // ── MANUAL / HARD_STOP are always delivered, whatever the evidence or the model says ─────
  for (const cls of ["MANUAL", "HARD_STOP"] as const) {
    const e = { ...staleProof(), class: cls };
    const o = triageEscalation(e, { classTier: "digest", defaultApplies: true, rekick: { newFailureSinceLastStrike: true, priorRekicks: 0 } }, demote);
    assert.equal(o.kind, "deliver", `${cls} is never auto-resolved or digested`);
  }

  // ── any failure delivers ─────────────────────────────────────────────────────────────────
  const hostile = { get class(): never { throw new Error("boom"); } } as unknown as Escalation;
  assert.equal(triageEscalation(hostile).kind, "deliver");

  // ── bare producers are triaged: escalate AND tryEscalate ledger the outcome (shadow) while
  //    still delivering as needs-human ─────────────────────────────────────────────────────
  const lp = ledger();
  const issues = gateway();
  escalate(staleProof(), { issues, ledgerPath: lp, runId: "r" });
  tryEscalate(esc({ taskId: "W1-TY" }), { issues, ledgerPath: lp, runId: "r" });
  const triaged = rows(lp).filter((r) => r.step === "escalation.triaged");
  assert.equal(triaged.length, 2, "both bare entry points cross the triage");
  assert.deepEqual(
    [triaged[0].triage_outcome, triaged[0].triage_action, triaged[0].triage_mode],
    ["auto_resolve", "plan_amendment_pr", "shadow"],
  );
  assert.equal(triaged[1].triage_outcome, "deliver");
  assert.ok(issues.calls.every((c) => c.labels.includes(NEEDS_HUMAN_LABEL)), "shadow mode still delivers");
  assert.equal(issues.comments.length, 0);

  // ── act mode: an auto-resolve runs its executor, stays open under fleet-notice, is audited ─
  const alp = ledger();
  const actIssues = gateway();
  const ran: string[] = [];
  await escalateWithJudge(staleProof(), {
    issues: actIssues,
    ledgerPath: alp,
    runId: "r",
    judge: async () => ({ decision: "deliver", reason: "x" }),
    triage: { mode: "act", pass: newTriagePass(), execute: { plan_amendment_pr: (e) => (ran.push(e.taskId), "opened plan-only PR #1; decline it to undo") } },
  });
  assert.deepEqual(ran, ["W1-TS"]);
  assert.ok(actIssues.calls[0].labels.includes(FLEET_NOTICE_LABEL));
  assert.match(actIssues.comments[0], /plan_amendment_pr.*opened plan-only PR #1/s);
  assert.ok(rows(alp).some((r) => r.step === "escalation.auto_resolve_started" && r.triage_action === "plan_amendment_pr"));

  // an unwired executor, a failing executor and a spent pass cap all fall back to needs-human
  const unwired = gateway();
  escalate(staleProof(), { issues: unwired, ledgerPath: ledger(), runId: "r", triage: { mode: "act" } });
  assert.ok(unwired.calls[0].labels.includes(NEEDS_HUMAN_LABEL));
  const failing = gateway();
  escalate(staleProof(), {
    issues: failing,
    ledgerPath: ledger(),
    runId: "r",
    triage: { mode: "act", pass: newTriagePass(), execute: { plan_amendment_pr: () => { throw new Error("nope"); } } },
  });
  assert.ok(failing.calls[0].labels.includes(NEEDS_HUMAN_LABEL));
  const pass = newTriagePass(1);
  const capped = gateway();
  const cfg = { mode: "act", pass, execute: { plan_amendment_pr: () => "done" } } as const;
  escalate(staleProof(), { issues: capped, ledgerPath: ledger(), runId: "r", triage: cfg });
  escalate({ ...staleProof(), taskId: "W1-TT" }, { issues: capped, ledgerPath: ledger(), runId: "r", triage: cfg });
  assert.deepEqual(capped.calls.map((c) => c.labels.includes(FLEET_NOTICE_LABEL)), [true, false], "cap of 1 per pass");

  // act mode never auto-resolves a MANUAL escalation, even with an executor wired for it
  const manual = gateway();
  escalate({ ...staleProof(), class: "MANUAL" }, {
    issues: manual,
    ledgerPath: ledger(),
    runId: "r",
    triage: { mode: "act", execute: { plan_amendment_pr: () => "must not run" } },
  });
  assert.ok(manual.calls[0].labels.includes(NEEDS_HUMAN_LABEL));

  // ── policy: absent or unreadable is shadow; the per-pass cap never exceeds 5 ──────────────
  assert.equal(parseEscalationTriagePolicy({}).mode, "shadow");
  assert.equal(parseEscalationTriagePolicy({ escalationTriage: "act" }).mode, "shadow");
  assert.deepEqual(parseEscalationTriagePolicy({ escalationTriage: { mode: "act", maxAutoResolvesPerPass: 99 } }), {
    mode: "act",
    maxAutoResolvesPerPass: 5,
  });
});

test("W1-T8868: a judged producer inherits the installed policy and executors", async () => {
  const issues = gateway();
  let executed = 0;
  configureEscalationTriage(() => ({
    mode: "act", pass: newTriagePass(),
    execute: { plan_amendment_pr: () => { executed++; return "amendment opened; decline to undo"; } },
  }));
  try {
    await escalateWithJudge(staleProof(), {
      issues, ledgerPath: ledger(), runId: "r", judge: async () => ({ decision: "deliver", reason: "x" }),
    });
    assert.equal(executed, 1);
    assert.ok(issues.calls[0].labels.includes(FLEET_NOTICE_LABEL));
  } finally {
    configureEscalationTriage(undefined);
  }
});

test("W1-T8868: malformed evidence and model output deliver", () => {
  assert.equal(triageEscalation(staleProof(), { rekick: { priorRekicks: NaN, newFailureSinceLastStrike: true } }).kind, "deliver");
  assert.equal(triageEscalation(esc(), {}, { decision: "demote", reason: undefined } as never).kind, "deliver");
});

test("W1-T8868: shadow delivers model demotions and hard stops without asking the model", async () => {
  for (const cls of ["BLOCKED", "MANUAL", "HARD_STOP"] as const) {
    const issues = gateway();
    let judged = 0;
    const lp = ledger();
    await escalateWithJudge(esc({ class: cls }), {
      issues, ledgerPath: lp, runId: "shadow",
      judge: async () => { judged++; return { decision: "demote", reason: "can wait" }; },
    });
    assert.ok(issues.calls[0].labels.includes(NEEDS_HUMAN_LABEL));
    assert.equal(judged, cls === "BLOCKED" ? 1 : 0);
    assert.equal(rows(lp).find((r) => r.step === "escalation.triaged")?.triage_outcome,
      cls === "BLOCKED" ? "digest" : "deliver");
  }
});

test("W1-T8868: deterministic rules run before the judge and async bare producers ask for the remainder", async () => {
  let judged = 0;
  const judge = async () => { judged++; return { decision: "demote", reason: "can wait" } as const; };
  const issues = gateway();
  const lp = ledger();
  await escalateWithJudge(staleProof(), { issues, ledgerPath: lp, runId: "r", judge });
  assert.equal(judged, 0);
  await escalateAsync(esc(), { issues, ledgerPath: lp, runId: "r", triage: { judge } });
  assert.equal(judged, 1);
  assert.equal(rows(lp).filter((r) => r.step === "escalation.triaged")[1].triage_outcome, "digest");
});

test("W1-T8868: unreadable evidence cannot digest and an absent pass cannot authorize an action", async () => {
  const issues = gateway();
  const lp = ledger();
  await escalateWithJudge(esc(), {
    issues, ledgerPath: lp, runId: "r", judge: async () => ({ decision: "demote", reason: "can wait" }),
    triage: { mode: "act", evidence: () => { throw new Error("unreadable history"); } },
  });
  assert.ok(issues.calls[0].labels.includes(NEEDS_HUMAN_LABEL));
  assert.match(String(rows(lp).find((r) => r.step === "escalation.triaged")?.triage_reason), /unreadable history/);
  let executed = 0;
  escalate(staleProof(), {
    issues, ledgerPath: lp, runId: "r", triage: {
      mode: "act", execute: { plan_amendment_pr: () => { executed++; return "done"; } },
    },
  });
  assert.equal(executed, 0);
  assert.ok(issues.calls[1].labels.includes(NEEDS_HUMAN_LABEL));
});

test("W1-T8868: the stale rejudge records shadow triage without demoting", async () => {
  const lp = ledger();
  let demoted = 0;
  const result = await runStaleEscalationRejudge([{
    issueUrl: "https://github.com/craigoley/remudero/issues/1", escalation: esc(),
    ageMs: 7 * 60 * 60 * 1000, referentStateNow: "still open", siblingSummaries: [], stateKey: "head1",
  }], {
    ledgerPath: lp, runId: "sweep", judge: async () => ({ decision: "demote", reason: "can wait" }),
    demote: () => { demoted++; }, triage: { mode: "shadow" },
  });
  assert.equal(demoted, 0);
  assert.equal(result.demoted, 0);
  assert.equal(rows(lp).find((r) => r.step === "escalation.triaged")?.triage_outcome, "digest");
});
