import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
} from "#src/lib/escalate.js";
import {
  TRIAGE_ACTIONS,
  newTriagePass,
  parseEscalationTriagePolicy,
  triageEscalation,
} from "#src/lib/escalation-triage.js";
import { runStaleEscalationRejudge } from "#src/lib/sweep.js";
import type { OpenPrView } from "#src/lib/sweep.js";
import { buildEscalationTriageRuntime, sweepEscalationTriage } from "#src/run-task.js";
import type { GhAsyncExecutor } from "#src/lib/github-transport.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { pendingKicks } from "#src/lib/fleet-control.js";
import type { Config } from "#src/lib/config.js";
import type { EscalationJudgeVerdict } from "#src/lib/escalate.js";

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

test("W1-T8868: the stale rejudge delivers when its triage evidence is unreadable, never asking the judge", async () => {
  const lp = ledger();
  let judged = 0;
  let demoted = 0;
  let autoResolved = 0;
  const result = await runStaleEscalationRejudge([{
    issueUrl: "https://github.com/craigoley/remudero/issues/1", escalation: esc(),
    ageMs: 7 * 60 * 60 * 1000, referentStateNow: "still open", siblingSummaries: [], stateKey: "head-unreadable",
  }], {
    ledgerPath: lp, runId: "sweep",
    judge: async () => { judged++; return { decision: "demote", reason: "can wait" }; },
    demote: () => { demoted++; },
    triage: {
      mode: "act", evidence: () => { throw new Error("unreadable history"); },
      autoResolve: async () => { autoResolved++; },
    },
  });
  assert.equal(judged, 0);
  assert.equal(demoted, 0);
  assert.equal(autoResolved, 0);
  assert.equal(result.demoted, 0);
  const triaged = rows(lp).find((r) => r.step === "escalation.triaged");
  assert.equal(triaged?.triage_outcome, "deliver");
  assert.equal(triaged?.triage_decided_by, "default");
  assert.match(String(triaged?.triage_reason), /triage evidence unreadable \(Error: unreadable history\)/);
  const rejudged = rows(lp).find((r) => r.step === "escalation.rejudged");
  assert.equal(rejudged?.judge_decision, "deliver");
  assert.match(String(rejudged?.judge_reason), /unreadable history/);
});

test("W1-T8868: unreadable history delivers before a rule or model can hide the issue", async () => {
  const lp = ledger();
  // A torn row of the very step the tier is read from: it could be the evidence that stops a digest.
  writeFileSync(lp, '{"step":"panel.escalation_marked_handled","class":"STALE_PR\n');
  const issues = gateway();
  let executed = 0;
  let judged = 0;
  await escalateWithJudge(staleProof(), {
    issues, ledgerPath: lp, runId: "r",
    judge: async () => { judged++; return { decision: "demote", reason: "can wait" }; },
    triage: { mode: "act", pass: newTriagePass(), execute: {
      plan_amendment_pr: () => { executed++; return "opened"; },
    } },
  });
  assert.equal(executed, 0);
  assert.equal(judged, 0);
  assert.ok(issues.calls[0].labels.includes(NEEDS_HUMAN_LABEL));
});

test("W1-T8868: a rekick requires a block and malformed policy cannot enable actions", () => {
  assert.equal(triageEscalation(esc({ class: "GRILL" }), {
    rekick: { newFailureSinceLastStrike: true, priorRekicks: 0 },
  }).kind, "deliver");
  assert.equal(parseEscalationTriagePolicy({ escalationTriage: {
    mode: "act", maxAutoResolvesPerPass: "five",
  } }).mode, "shadow");
  const outcome = triageEscalation(esc(), {}, { decision: "deliver", reason: undefined } as never);
  assert.equal(outcome.kind, "deliver");
  assert.equal(typeof outcome.reason, "string");
});

test("W1-T8868: stale demotion awaits the write and records a rejected write", async () => {
  let completed = false;
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const lp = ledger();
  const result = await runStaleEscalationRejudge([{
    issueUrl: "https://github.com/craigoley/remudero/issues/1", escalation: esc(),
    ageMs: 7 * 60 * 60 * 1000, referentStateNow: "still open", siblingSummaries: [], stateKey: "head1",
  }], {
    ledgerPath: lp, runId: "sweep", judge: async () => ({ decision: "demote", reason: "can wait" }),
    demote: async () => {
      await Promise.resolve();
      completed = true;
      throw new Error("label write refused");
    },
    triage: { mode: "act" },
    log: (step, extra) => { logged.push({ step, extra }); },
  });
  assert.equal(completed, true);
  assert.equal(result.demoted, 0);
  assert.equal(result.results[0].outcome, "demote-failed");
  assert.equal(result.results[0].reason, "can wait");
  assert.match(String(logged.find((l) => l.step === "sweep.escalation_rejudge_demote_failed")?.extra?.error), /label write refused/);
});

test("W1-T8868: the runtime shares five actions across birth and stale issues", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-triage-runtime-"));
  const runtime = buildEscalationTriageRuntime({ root, config: { root } as Config, owner: "o", repo: "r" }, {
    readPolicy: () => ({ escalationTriage: { mode: "act", maxAutoResolvesPerPass: 5 } }),
    readRows: () => [], seenAt: () => undefined, windowMs: () => 1,
    amend: async (e) => `${e.taskId}: amendment opened; decline it to undo`,
  });
  const lp = ledger();
  const issues = gateway();
  for (let i = 0; i < 6; i++) {
    await escalateAsync({ ...staleProof(), taskId: `W1-T${i}` }, {
      issues, ledgerPath: lp, runId: "pass", triage: runtime({ issues, ledgerPath: lp, runId: "pass" }),
    });
  }
  assert.equal(rows(lp).filter((r) => r.step === "escalation.auto_resolve_attempted").length, 5);
  assert.ok(issues.calls.slice(0, 5).every((c) => c.labels.includes(FLEET_NOTICE_LABEL)));
  assert.ok(issues.calls[5].labels.includes(NEEDS_HUMAN_LABEL));
});

// ── the production executors, driven through their real defaults ─────────────────────────────

const PLAN_TEXT = [
  "- id: W1-TK", "  title: queued fixture", "  repo: r", "  type: implement", "  status: queued",
  "- id: W1-TD", "  title: done fixture", "  repo: r", "  type: implement", "  status: done", "",
].join("\n");

function runtimeRoot(plan = PLAN_TEXT): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-triage-exec-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), plan);
  return root;
}

const ACT_POLICY = () => ({ escalationTriage: { mode: "act", maxAutoResolvesPerPass: 5 } });

test("W1-T8868: feedback_reply and its observation use the daemon client built from the service token", async () => {
  const root = runtimeRoot();
  const submitted: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/v1/feedback") {
        const parsed = JSON.parse(body) as { replyTo?: string };
        submitted.push({ auth: req.headers.authorization, ...parsed });
        res.end(JSON.stringify({ ok: true, entry: { id: "9", reply_to: parsed.replyTo } }));
      } else if (req.method === "GET" && req.url?.startsWith("/v1/feedback")) {
        res.end(JSON.stringify({ entries: [{ id: "7", status: "answered", answered_by: "9" }] }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "service-tokens.json"), JSON.stringify({ write: "tok-write" }));
    const config = { root, consoleUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } as Config;
    const lp = ledger();
    const settings = buildEscalationTriageRuntime({ root, config, owner: "o", repo: "r" }, {
      readPolicy: ACT_POLICY, readRows: () => [], seenAt: () => undefined, windowMs: () => 1,
    })({ issues: gateway(), ledgerPath: lp, runId: "r" });
    const grill = citationGrill();
    const effect = await settings.execute!.feedback_reply!(grill);
    assert.match(effect, /feedback#9 answers feedback#7/);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].replyTo, "7");
    assert.match(String(submitted[0].auth), /tok-write/);
    assert.match(String(await settings.observe!(grill, "feedback_reply", effect)), /feedback#7 is answered by feedback#9/);
    assert.equal(await settings.observe!(grill, "plan_amendment_pr", "x"), undefined, "a proposed amendment is not yet a resolved block");
    // A referent that does not match the task id is refused before any write.
    await assert.rejects(Promise.resolve().then(() => settings.execute!.feedback_reply!({ ...grill, taskId: "TRIAGE-8" })), /feedback referent is unreadable/);
    assert.equal(submitted.length, 1);
    // An unavailable service token cannot build the client.
    writeFileSync(join(root, "state", "service-tokens.json"), JSON.stringify({ write: "" }));
    await assert.rejects(Promise.resolve().then(() => settings.execute!.feedback_reply!(grill)), /service write token unavailable/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("W1-T8868: rekick_once requests one kick for a dispatchable task and refuses a closed one", () => {
  const root = runtimeRoot();
  const settings = buildEscalationTriageRuntime({ root, config: { root } as Config, owner: "o", repo: "r" }, {
    readPolicy: ACT_POLICY, readRows: () => [], seenAt: () => undefined, windowMs: () => 1,
  })({ issues: gateway(), ledgerPath: ledger(), runId: "r" });
  const effect = settings.execute!.rekick_once!(esc({ taskId: "W1-TK" }));
  assert.match(effect as string, /one dispatch requested for W1-TK/);
  assert.deepEqual(pendingKicks(root).map((k) => [k.taskId, k.origin, k.repo]), [["W1-TK", "escalation-triage", "r"]]);
  assert.throws(() => settings.execute!.rekick_once!(esc({ taskId: "W1-TD" })), /task is not dispatchable/);
  assert.throws(() => settings.execute!.rekick_once!(esc({ taskId: "W1-TNONE" })), /task is not dispatchable/);
  assert.equal(pendingKicks(root).length, 1, "a refused task leaves no second kick");
  // An injected kick seam replaces the marker write.
  const kicked: string[] = [];
  const injected = buildEscalationTriageRuntime({ root, config: { root } as Config, owner: "o", repo: "r" }, {
    readPolicy: ACT_POLICY, readRows: () => [], seenAt: () => undefined, windowMs: () => 1, kick: (e) => { kicked.push(e.taskId); },
  })({ issues: gateway(), ledgerPath: ledger(), runId: "r" });
  injected.execute!.rekick_once!(esc({ taskId: "W1-TD" }));
  assert.deepEqual(kicked, ["W1-TD"]);
});

test("W1-T8868: apply_default records the recommendation, is observed, and refuses once it no longer applies", async () => {
  const root = runtimeRoot();
  const lp = ledger();
  const settings = buildEscalationTriageRuntime({ root, config: { root } as Config, owner: "o", repo: "r" }, {
    readPolicy: ACT_POLICY, readRows: () => [], seenAt: () => 0, windowMs: () => 1,
  })({ issues: gateway(), ledgerPath: lp, runId: "r" });
  const grill = citationGrill();
  const effect = await settings.execute!.apply_default!(grill);
  assert.match(effect, /default recorded: .*file-as-task/);
  assert.ok(rows(lp).some((r) => r.step === "escalation.default_applied" && r.option === "file-as-task" && r.origin === "default"));
  const observed = JSON.parse(String(await settings.observe!(grill, "apply_default", effect))) as Record<string, unknown>;
  assert.deepEqual([observed.taskId, observed.option, observed.origin], ["TRIAGE-7", "file-as-task", "default"]);
  const unseen = buildEscalationTriageRuntime({ root, config: { root } as Config, owner: "o", repo: "r" }, {
    readPolicy: ACT_POLICY, readRows: () => [], seenAt: () => undefined, windowMs: () => 1,
  })({ issues: gateway(), ledgerPath: ledger(), runId: "r" });
  await assert.rejects(Promise.resolve().then(() => unseen.execute!.apply_default!(grill)), /default no longer applies/);
});

test("W1-T8868: evidence counts earlier re-kicks by head or contract revision and detects a new failure cause", () => {
  const root = runtimeRoot();
  const history = [
    { step: "fix.dispatch", task_id: "W1-TK", head_sha: "h1", mode: "ci-log" },
    { step: "escalation.auto_resolve_attempted", task_id: "W1-TK", triage_action: "rekick_once", head_sha: "h1" },
    { step: "escalation.auto_resolve_attempted", task_id: "W1-TK", triage_action: "rekick_once", head_sha: "h0", contract_revision: "c1" },
    { step: "escalation.auto_resolve_attempted", task_id: "W1-TK", triage_action: "rekick_once", head_sha: "h0", contract_revision: "c9" },
  ];
  const settings = buildEscalationTriageRuntime({ root, config: { root } as Config, owner: "o", repo: "r" }, {
    readPolicy: ACT_POLICY, readRows: () => history, seenAt: () => undefined, windowMs: () => 1,
  })({ issues: gateway(), ledgerPath: ledger(), runId: "r" });
  const evidence = settings.evidence!(esc({ taskId: "W1-TK", headSha: "h1", contractRevision: "c1", cause: "conflict" }));
  assert.deepEqual(evidence.rekick, { priorRekicks: 2, newFailureSinceLastStrike: true });
  assert.equal(evidence.defaultApplies, false);
});

test("W1-T8868: plan_amendment_pr over the real sweep effects holds the task and reports an unopened amendment", async () => {
  const root = runtimeRoot();
  // `state` is a plain file, so the hold write fails and the effect's own log line reaches the ledger.
  writeFileSync(join(root, "state"), "not a directory");
  const lp = ledger();
  writeFileSync(lp, "");
  const settings = buildEscalationTriageRuntime(
    { root, config: { root, claudeBin: "/bin/true" } as Config, owner: "o", repo: "r" },
    { readPolicy: ACT_POLICY, readRows: () => [], seenAt: () => undefined, windowMs: () => 1 },
  )({ issues: gateway(), ledgerPath: lp, runId: "RUN-T8868" });
  await assert.rejects(Promise.resolve().then(() => settings.execute!.plan_amendment_pr!({ ...staleProof(), taskId: "W1-TK" })), /amendment not opened: (no_shard|error)/);
  assert.ok(rows(lp).some((r) => r.step === "sweep.refusal_amendment.hold_failed" && r.task_id === "W1-TK" && r.run_id === "RUN-T8868"));
  await assert.rejects(Promise.resolve().then(() => settings.execute!.plan_amendment_pr!({ ...staleProof(), taskId: "W1-TD" })), /amendment not opened: task_closed/);
});

// ── the daemon-loop rejudge sweep ────────────────────────────────────────────────────────────

function sweepFixture(amend: () => Promise<string>, options: {
  subject?: Escalation;
  openPrs?: OpenPrView[];
  judge?: (e: Escalation) => Promise<EscalationJudgeVerdict>;
  defaultRelabel?: boolean;
  execAsync?: GhAsyncExecutor;
} = {}) {
  const root = runtimeRoot();
  const lp = ledger();
  const url = "https://github.com/craigoley/remudero/issues/41";
  const subject = options.subject ?? staleProof();
  const comments: string[] = [];
  const relabels: Array<[string, string]> = [];
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const issues = {
    listOpen: (label: string) => label === NEEDS_HUMAN_LABEL ? [{ number: 41, url, title: subject.summary, body: `**Task:** ${subject.taskId}\n` }] : [],
    comment: (_url: string, body: string) => { comments.push(body); },
  } as unknown as IssueGateway;
  const birth = {
    ts: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), step: "escalation.issue_opened",
    task_id: subject.taskId, issue_url: url, triage_subject: subject,
  };
  const context = { root, config: { root } as Config, owner: "o", repo: "r", ledgerPath: lp, runId: "SWEEP-T8868" };
  const runtime = buildEscalationTriageRuntime(context, {
    readPolicy: ACT_POLICY, readRows: () => [], seenAt: () => undefined, windowMs: () => 1,
    judge: options.judge, amend,
  });
  const run = () => sweepEscalationTriage(context, options.openPrs ?? [], (step, extra) => { logged.push({ step, extra }); }, {
    rows: [birth], issues, runtime,
    ...(options.defaultRelabel ? {} : { relabel: (u: string, label: string) => { relabels.push([u, label]); } }),
    ...(options.execAsync ? { execAsync: options.execAsync } : {}),
  });
  return { run, url, lp, comments, relabels, logged, issues };
}

test("W1-T8868: the rejudge sweep auto-resolves an old issue and relabels it fleet-notice", async () => {
  const f = sweepFixture(async () => "https://github.com/o/r/pull/1 proposes the proof amendment; decline the PR to undo");
  await f.run();
  assert.deepEqual(f.relabels, [[f.url, FLEET_NOTICE_LABEL]]);
  assert.match(f.comments[0], /plan_amendment_pr/);
  assert.ok(rows(f.lp).some((r) => r.step === "escalation.auto_resolve_started" && r.issue_url === f.url));
  assert.ok(rows(f.lp).some((r) => r.step === "escalation.rejudged" && r.issue_url === f.url));
  assert.deepEqual(f.logged.filter((l) => /failed/.test(l.step)), []);
});

test("W1-T8868: a failed auto-resolve in the rejudge sweep puts the issue back on needs-human", async () => {
  const f = sweepFixture(async () => { throw new Error("amendment refused"); });
  await f.run();
  assert.deepEqual(f.relabels, [[f.url, NEEDS_HUMAN_LABEL]]);
  const failed = f.logged.find((l) => l.step === "sweep.escalation_auto_resolve.failed");
  assert.equal(failed?.extra?.issue_url, f.url);
  assert.match(String(failed?.extra?.reason), /auto-resolve declined/);
});

test("W1-T8868: the rejudge sweep skips an open issue that has no recorded triage subject", async () => {
  const f = sweepFixture(async () => "unused");
  writeFileSync(f.lp, "");
  const url = f.url;
  const issues = {
    listOpen: (label: string) => label === NEEDS_HUMAN_LABEL ? [{ number: 41, url, title: "t", body: "**Task:** W1-TS\n" }] : [],
    comment: () => { throw new Error("must not comment"); },
  } as unknown as IssueGateway;
  const root = runtimeRoot();
  const relabels: string[] = [];
  const unrelated = { ts: new Date().toISOString(), step: "escalation.issue_opened", issue_url: url };
  const bad = { ts: "not a date", step: "escalation.issue_opened", issue_url: url, triage_subject: staleProof() };
  await sweepEscalationTriage(
    { root, config: { root } as Config, owner: "o", repo: "r", ledgerPath: f.lp, runId: "SWEEP-T8868" },
    [], () => {}, { rows: [unrelated, bad], issues, relabel: (u) => { relabels.push(u); } },
  );
  assert.deepEqual(relabels, []);
  assert.equal(rows(f.lp).filter((r) => r.step === "escalation.rejudged").length, 0);
});

test("W1-T8868: the sweep's default label edit uses the guarded async GitHub transport", async () => {
  const calls: string[][] = [];
  const execAsync = (async (_file: string, args: string[]) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  }) as unknown as GhAsyncExecutor;
  const f = sweepFixture(async () => "https://github.com/o/r/pull/1 proposes the proof amendment; decline it to undo", {
    defaultRelabel: true, execAsync,
  });
  await withLiveWritesAllowed(f.run);
  assert.deepEqual(calls, [[
    "issue", "edit", f.url, "--repo", "o/r", "--add-label", FLEET_NOTICE_LABEL, "--remove-label", NEEDS_HUMAN_LABEL,
  ]]);
});

test("W1-T8868: the sweep asks its injected judge when the issue has a known PR referent", async () => {
  const subject = esc({ taskId: "W1-TJ", summary: "W1-TJ: a retry needs a fresh review", recommendation: "retry" });
  const judged: Escalation[] = [];
  const openPr = {
    taskId: subject.taskId, prNumber: 17, prUrl: "https://github.com/o/r/pull/17", headSha: "head-17",
    reviewState: "none", checksState: "none", mergeable: "MERGEABLE", mergeableState: "clean",
  } as unknown as OpenPrView;
  const f = sweepFixture(async () => "unused", {
    subject, openPrs: [openPr],
    judge: async (e) => { judged.push(e); return { decision: "deliver", reason: "test judge says keep visible" }; },
  });
  await f.run();
  assert.equal(judged.length, 1);
  assert.match(judged[0].detail, /REFERENT STATE NOW:.*head-17/);
  assert.deepEqual(f.relabels, []);
});

test("W1-T8868: an unreadable issue listing is logged by the rejudge sweep, never thrown", async () => {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const root = runtimeRoot();
  const issues = { listOpen: () => { throw new Error("listing unavailable"); } } as unknown as IssueGateway;
  await sweepEscalationTriage(
    { root, config: { root } as Config, owner: "o", repo: "r", ledgerPath: ledger(), runId: "SWEEP-T8868" },
    [], (step, extra) => { logged.push({ step, extra }); }, { rows: [], issues },
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0].step, "sweep.escalation_triage.failed");
  assert.match(String(logged[0].extra?.reason), /listing unavailable/);
});
