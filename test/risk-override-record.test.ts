import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  recordRiskOverride,
  type IssueCloser,
  type PanelActionDeps,
  type RiskOverrideRecordInput,
} from "../src/lib/panel-actions.js";
import {
  DECISION_RELEVANT_LEDGER_STEPS,
  RISK_OVERRIDE_DISPOSITIONS,
  RISK_OVERRIDE_RECORDED_STEP,
  RISK_OVERRIDE_REASON_CLASSES,
  appendLedger,
  riskOverrideFromLedger,
} from "../src/lib/ledger.js";
import { cappedOverrideFromLedger } from "../src/lib/review.js";
import { planRiskJudgeAction, type RiskJudgeVerdict } from "../src/lib/risk-judge.js";

// ── W1-T2244 — AN OPERATOR OVERRIDE OF A RISK ESCALATION LEAVES NO RECORD ───────────────────
//
// The CAPPED verdict's own escape hatch (`--override-capped-by`/`--override-capped-reason`,
// run-task.ts) writes an attributable `automerge.capped_override_granted` row. The risk judge's
// own escape hatch is the words "merge it by hand" (escalate.ts) — an operator acting on it
// could, at most, produce `panel.escalation_marked_handled`: no verdict, no confidence, no
// disposition, no reason. `recordRiskOverride` (src/lib/panel-actions.ts) is the missing
// producer; `riskOverrideFromLedger` + `RISK_OVERRIDE_RECORDED_STEP`'s registration in
// `DECISION_RELEVANT_LEDGER_STEPS` (src/lib/ledger.ts) are its reader and its rotation survival.

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-risk-override-record-"));
}

function ledgerPathFor(root: string): string {
  return join(root, "state", "ledger.ndjson");
}

function readLedgerLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function fakeIssueCloser(): IssueCloser & { closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    close(issueUrl: string) {
      closed.push(issueUrl);
    },
  };
}

function depsFor(root: string, issues: IssueCloser = fakeIssueCloser()): PanelActionDeps {
  return { root, ledgerPath: ledgerPathFor(root), issues };
}

function validInput(overrides: Partial<RiskOverrideRecordInput> = {}): RiskOverrideRecordInput {
  return {
    taskId: "W1-T9001",
    issueUrl: "https://github.com/craigoley/remudero/issues/9001",
    headSha: "a".repeat(40),
    verdict: "high",
    confidence: 0.92,
    disposition: "merged_by_hand",
    reasonClass: "risk_accepted",
    reason: "the reviewers already covered this by hand",
    ...overrides,
  };
}

// ── acceptance 1: one ledger row carrying the escalation, the judged verdict/confidence, the
// operator's disposition and a reason class ─────────────────────────────────────────────────
test("recordRiskOverride writes one row carrying the escalation, judged verdict/confidence, disposition and reason class", () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  const origin = "origin-hash-abc";

  const result = recordRiskOverride(deps, validInput(), origin);
  assert.deepEqual(result, { ok: true });

  const lines = readLedgerLines(deps.ledgerPath).filter((l) => l.step === RISK_OVERRIDE_RECORDED_STEP);
  assert.equal(lines.length, 1, "exactly one row for one recordRiskOverride call");
  const row = lines[0];
  assert.equal(row.task_id, "W1-T9001");
  assert.equal(row.issue_url, "https://github.com/craigoley/remudero/issues/9001");
  assert.equal(row.head_sha, "a".repeat(40));
  assert.equal(row.verdict, "high");
  assert.equal(row.confidence, 0.92);
  assert.equal(row.disposition, "merged_by_hand");
  assert.equal(row.reason_class, "risk_accepted");
  assert.equal(row.reason, "the reviewers already covered this by hand");
  assert.equal(row.origin, origin, "attributable — the caller's bearer-derived origin rides the row");
});

// ── acceptance 2: the reason class is a closed set validated on write — an unrecognised class
// is REFUSED and no row is written ──────────────────────────────────────────────────────────
test("an unrecognised reasonClass is refused and writes no row", () => {
  const root = tmpRoot();
  const deps = depsFor(root);

  const result = recordRiskOverride(deps, { ...validInput(), reasonClass: "operator_felt_like_it" as never }, "origin-x");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /reasonClass/);

  assert.equal(existsSync(deps.ledgerPath), false, "no ledger file at all — the refusal happened before any write");
});

test("an unrecognised disposition is likewise refused and writes no row", () => {
  const root = tmpRoot();
  const deps = depsFor(root);

  const result = recordRiskOverride(deps, { ...validInput(), disposition: "quietly_ignored" as never }, "origin-x");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /disposition/);
  assert.equal(existsSync(deps.ledgerPath), false);
});

test("a malformed body (missing headSha) is refused and writes no row — FAIL LOUD before any side effect", () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  const { headSha: _drop, ...withoutHeadSha } = validInput();

  const result = recordRiskOverride(deps, withoutHeadSha, "origin-x");
  assert.equal(result.ok, false);
  assert.equal(existsSync(deps.ledgerPath), false);
});

test("confidence outside [0, 1] is refused and writes no row", () => {
  const root = tmpRoot();
  const deps = depsFor(root);

  const result = recordRiskOverride(deps, { ...validInput(), confidence: 1.5 }, "origin-x");
  assert.equal(result.ok, false);
  assert.equal(existsSync(deps.ledgerPath), false);
});

// ── acceptance 3: judge-was-wrong and risk-accepted are DISTINCT classes and a reader can
// partition rows by them — never collapsed into one overridden flag ────────────────────────
test("RISK_OVERRIDE_REASON_CLASSES names exactly the two opposite-signal classes", () => {
  assert.deepEqual([...RISK_OVERRIDE_REASON_CLASSES].sort(), ["judge_wrong", "risk_accepted"]);
});

test("a reader can partition recorded rows by reason class — the two never collapse into one flag", () => {
  const root = tmpRoot();
  const deps = depsFor(root);

  recordRiskOverride(deps, { ...validInput(), taskId: "W1-T9002", headSha: "b".repeat(40), reasonClass: "judge_wrong", disposition: "redispatched" }, "origin-1");
  recordRiskOverride(deps, { ...validInput(), taskId: "W1-T9003", headSha: "c".repeat(40), reasonClass: "risk_accepted", disposition: "merged_by_hand" }, "origin-2");

  const lines = readLedgerLines(deps.ledgerPath).filter((l) => l.step === RISK_OVERRIDE_RECORDED_STEP);
  const byClass = new Map<string, number>();
  for (const line of lines) {
    const key = String(line.reason_class);
    byClass.set(key, (byClass.get(key) ?? 0) + 1);
  }
  assert.equal(byClass.get("judge_wrong"), 1);
  assert.equal(byClass.get("risk_accepted"), 1);
  // Never a single boolean/"overridden" field standing in for the class.
  for (const line of lines) {
    assert.equal("overridden" in line, false, "no collapsed boolean flag — reason_class is the only signal");
  }
});

// ── acceptance 4: the new step is registered in DECISION_RELEVANT_LEDGER_STEPS, so rotation
// retains it as it already retains the escalation and the capped override ──────────────────
test("RISK_OVERRIDE_RECORDED_STEP is registered in DECISION_RELEVANT_LEDGER_STEPS, beside its siblings", () => {
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has(RISK_OVERRIDE_RECORDED_STEP),
    "the operator's risk-override record must survive rotation the same way automerge.capped_override_granted and risk_judge.escalated do",
  );
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("automerge.capped_override_granted"));
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("risk_judge.escalated"));
});

// ── acceptance 5: the row is bound to the head sha it judged and a reader refuses to honour
// it against a different head — the same binding the capped override already carries ───────
test("riskOverrideFromLedger recovers a row recorded for the matching head", () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  const headSha = "d".repeat(40);

  recordRiskOverride(deps, { ...validInput(), taskId: "W1-T9004", headSha }, "origin-3");

  const lines = readLedgerLines(deps.ledgerPath);
  const found = riskOverrideFromLedger(lines, "W1-T9004", headSha);
  assert.ok(found);
  assert.equal(found?.headSha, headSha);
  assert.equal(found?.disposition, "merged_by_hand");
  assert.equal(found?.reasonClass, "risk_accepted");
});

test("riskOverrideFromLedger refuses a row recorded against a DIFFERENT head — a stale grant is treated as absent", () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  const grantedHead = "e".repeat(40);
  const currentHead = "f".repeat(40);

  recordRiskOverride(deps, { ...validInput(), taskId: "W1-T9005", headSha: grantedHead }, "origin-4");

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(
    riskOverrideFromLedger(lines, "W1-T9005", currentHead),
    undefined,
    "a new push must not silently inherit an override granted against the OLD diff",
  );
  // The same lines, re-queried against the head it was actually granted for, still resolve —
  // proving the miss above is the head binding, not a broken reader.
  assert.ok(riskOverrideFromLedger(lines, "W1-T9005", grantedHead));
});

test("riskOverrideFromLedger is 'last one wins' per task, mirroring cappedOverrideFromLedger's own idiom", () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  const headSha = "1".repeat(40);

  recordRiskOverride(deps, { ...validInput(), taskId: "W1-T9006", headSha, reasonClass: "judge_wrong" }, "origin-5");
  recordRiskOverride(deps, { ...validInput(), taskId: "W1-T9006", headSha, reasonClass: "risk_accepted" }, "origin-6");

  const lines = readLedgerLines(deps.ledgerPath);
  const found = riskOverrideFromLedger(lines, "W1-T9006", headSha);
  assert.equal(found?.reasonClass, "risk_accepted", "the most recently recorded row for this task/head wins");
});

// ── acceptance 6: recording changes no gate — the escalation still blocks, auto-merge still
// refuses, and no dispatch or merge decision reads the new row ─────────────────────────────
test("recordRiskOverride never closes the escalation issue — it records, it never checks off", () => {
  const root = tmpRoot();
  const closer = fakeIssueCloser();
  const deps = depsFor(root, closer);

  recordRiskOverride(deps, validInput(), "origin-7");
  assert.deepEqual(closer.closed, [], "recording an override must not itself close the escalation issue");
});

test("a recorded risk override is invisible to the CAPPED-verdict arming gate — cappedOverrideFromLedger still returns undefined", () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  const headSha = "2".repeat(40);

  recordRiskOverride(deps, { ...validInput(), taskId: "W1-T9007", headSha }, "origin-8");

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(
    cappedOverrideFromLedger(lines, "W1-T9007", headSha),
    undefined,
    "a risk-judge override must never be mistaken by the EXISTING auto-merge arming gate for a capped-verdict grant",
  );
});

test("RISK_OVERRIDE_RECORDED_STEP is a distinct step from automerge.capped_override_granted", () => {
  assert.notEqual(RISK_OVERRIDE_RECORDED_STEP, "automerge.capped_override_granted");
});

test("recordRiskOverride's own result shape carries no grant/arm signal — {ok:true} or {ok:false,error}, nothing else", () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  const result = recordRiskOverride(deps, validInput(), "origin-9");
  assert.deepEqual(Object.keys(result).sort(), ["ok"]);
});

// ── acceptance 7: no confidence value auto-grants an override — a low-confidence escalation
// still escalates and is never bypassed by the recording path ──────────────────────────────
test("a low-confidence verdict still escalates via planRiskJudgeAction, before and after a risk override is recorded", () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  const lowConfidenceVerdict: RiskJudgeVerdict = { verdict: "low", confidence: 0.1, reasons: ["thin description"] };

  const before = planRiskJudgeAction(lowConfidenceVerdict);
  assert.equal(before.kind, "escalate", "W1-T248's fail-closed contract: LOW confidence escalates rather than proceeding");

  // Recording an override — even one accepting the risk at the LOWEST possible confidence — is
  // a downstream, after-the-fact write. planRiskJudgeAction takes no ledger/override input at
  // all, so it cannot be swayed by anything recorded here; re-run to prove the point directly.
  recordRiskOverride(deps, { ...validInput(), confidence: 0, verdict: "low", reasonClass: "risk_accepted" }, "origin-10");
  const after = planRiskJudgeAction(lowConfidenceVerdict);
  assert.deepEqual(after, before, "a recorded override must not change what the judge itself decides for the next case");
});

test("a HIGH verdict still escalates regardless of confidence, unaffected by any recorded override", () => {
  const highVerdict: RiskJudgeVerdict = { verdict: "high", confidence: 0.99, reasons: ["touches auth"] };
  const root = tmpRoot();
  const deps = depsFor(root);
  recordRiskOverride(deps, { ...validInput(), verdict: "high", confidence: 0.99 }, "origin-11");
  assert.equal(planRiskJudgeAction(highVerdict).kind, "escalate");
});

// ── falsifier: the closed-set gate actually gates (proves acceptance 2's test isn't vacuous) ─
test("the falsifier — a VALID reasonClass/disposition pair is accepted, proving the refusals above test the gate and not a broken validator", () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  for (const reasonClass of RISK_OVERRIDE_REASON_CLASSES) {
    for (const disposition of RISK_OVERRIDE_DISPOSITIONS) {
      const result = recordRiskOverride(
        deps,
        { ...validInput(), taskId: `W1-T${reasonClass}-${disposition}`, headSha: "9".repeat(40), reasonClass, disposition },
        "origin-12",
      );
      assert.deepEqual(result, { ok: true }, `${reasonClass}/${disposition} is a valid combination and must be accepted`);
    }
  }
});
