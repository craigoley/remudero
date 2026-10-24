import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import {
  buildIssueRevalidationPrompt, conditionReobserved, evidenceNames, isAbsenceOnlyCitation, ISSUE_REVALIDATION_VERDICT_STEP,
  parseIssueRevalidationVerdict, productionIssueRevalidationPorts, runIssueRevalidationGarden,
  type IssueRevalidationPorts, type PriorVerdict, type RevalidationComment, type RevalidationIssue, type RevalidationVerdict,
} from "#src/lib/issue-revalidation-garden.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 13, 15);
const clock = fixedClock(NOW);
const at = (hours: number) => fixedClock(NOW + hours * HOUR).iso();
const issueUrl = (n: number) => `https://github.com/acme/remudero/issues/${n}`;

/** #10269's shape: a BLOCKED escalation naming a hyphenated ledger step and a plan/tasks.d path. */
function blocked(n: number, extra: Partial<RevalidationIssue> = {}): RevalidationIssue {
  return {
    number: n, url: issueUrl(n), title: `[BLOCKED] ci-friction-gardener: the filing has failed 3 times in a row`,
    body: "**Class:** BLOCKED\n**Task:** ci-friction-gardener\n\nIt drafts plan/tasks.d/W1-T1-x.yaml; the ledger's `ci-friction.garden_filing_failed` rows carry each attempt.",
    labels: [], createdAt: at(-100), updatedAt: at(-4), ...extra,
  };
}
const reobservedAt = (hours: number): RevalidationComment => ({
  authorLogin: "remudero-fleet[bot]", authorType: "Bot", authorAssociation: "NONE", createdAt: at(hours),
  body: "Another escalation observed the same condition (task ci-friction-gardener, class BLOCKED) while this issue was already open",
});

test("W1-T9181: the revalidation garden never closes on an absence", async () => {
  // 1. A hyphenated step is read whole; a path fragment is never a step.
  const names = evidenceNames(blocked(10269));
  assert.ok(names.includes("ci-friction.garden_filing_failed"), names.join(", "));
  assert.ok(!names.includes("friction.garden_filing_failed"), names.join(", "));
  assert.ok(!names.includes("tasks.d"), names.join(", "));

  // 2. In act mode: the #10269 verdict (an absence-only citation) and a re-observed escalation with a
  //    present citation are kept with their guards; the control, re-observed only outside the window, closes.
  const verdicts: Record<number, RevalidationVerdict> = {
    10269: { verdict: "resolved", reason: "no recent filing failures", citation: "ledger step ci-friction.garden_filing_failed: 0 row(s) in the last 48 h" },
    20: { verdict: "resolved", reason: "the fix merged", citation: "PR #5 merged" },
    21: { verdict: "resolved", reason: "the fix merged", citation: "PR #6 merged" },
    22: { verdict: "resolved", reason: "the fix merged", citation: "PR #7 merged" },
  };
  const comments: Record<number, RevalidationComment[]> = { 10269: [reobservedAt(-4)], 20: [reobservedAt(-4)], 21: [reobservedAt(-60)], 22: [] };
  const closes: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const p: IssueRevalidationPorts = {
    policy: () => ({ mode: "act", maxClosesPerPass: 5 }),
    listOpenIssues: async () => [blocked(10269), blocked(20), blocked(21), blocked(22, { createdAt: at(-10) })],
    listComments: async (n) => comments[n] ?? [],
    referentVerdicts: async () => new Map(),
    hasReferent: () => false,
    livenessVerdict: () => ({ verdict: "unknown", reason: "n/a" }),
    readModelVerdict: () => ({ verdict: "unknown", reason: "n/a" }),
    evidence: () => ({ facts: [] }),
    judge: async (i) => verdicts[i.number]!,
    priorVerdicts: () => new Map(),
    close: async (url) => void closes.push(url),
    comment: async () => {},
    fileConversion: async () => "fb",
    log: (step, extra = {}) => void (step === ISSUE_REVALIDATION_VERDICT_STEP && rows.push(extra)),
    clock,
  };
  await runIssueRevalidationGarden(p);
  const by = new Map(rows.map((r) => [r.issue_number, r]));
  assert.deepEqual([by.get(10269)?.action, by.get(10269)?.guard], ["keep", "absence-only-citation"]);
  assert.deepEqual([by.get(20)?.action, by.get(20)?.guard], ["keep", "condition-reobserved"]);
  assert.deepEqual([by.get(22)?.action, by.get(22)?.guard], ["keep", "condition-reobserved"], "an escalation opened 10 h ago is live");
  assert.deepEqual(closes, [issueUrl(21)], "only the escalation not seen for 60 h closes");
});

test("an absence-only citation is told from one naming something present", () => {
  assert.equal(isAbsenceOnlyCitation("`frontendApiProxy` does not appear on origin/main"), true);
  assert.equal(isAbsenceOnlyCitation("No recent filing failures are recorded in the ledger."), true);
  assert.equal(isAbsenceOnlyCitation("PR #11344 merged (https://github.com/acme/remudero/pull/11344)"), false);
  assert.equal(isAbsenceOnlyCitation("ledger step a-b.c: 3 row(s) in the last 48 h, newest x"), false);
  assert.equal(isAbsenceOnlyCitation("6/6 runs clean"), false);
  assert.equal(conditionReobserved({ createdAt: at(-100) }, [{ ...reobservedAt(-4), body: undefined }], NOW), false, "a comment without the re-observed text is not a re-observation");
});

test("a zero-row step reaches the judge as absence, and the prompt says absence is not proof", async () => {
  const issue = blocked(10269);
  const p = productionIssueRevalidationPorts({
    owner: "acme", repo: "remudero", stateDir: "/nonexistent", repoRoot: "/nonexistent", log: () => {}, clock,
    referentVerdicts: async () => new Map(), hasReferent: () => false, judgeText: async () => "",
    policy: () => ({ mode: "shadow", maxClosesPerPass: 5 }),
    readText: async () => JSON.stringify([{ number: issue.number, html_url: issue.url, title: issue.title, body: issue.body, labels: [], created_at: issue.createdAt, updated_at: issue.updatedAt }]),
    runGit: () => "",
    readLedgerRows: (steps) => (assert.deepEqual(steps, ["ci-friction.garden_filing_failed"]), []),
    issues: {},
  });
  const [listed] = await p.listOpenIssues();
  const facts = p.evidence(listed!).facts;
  assert.ok(facts.some((f) => /^ledger step ci-friction\.garden_filing_failed: 0 row\(s\) in the last 48 h — absence only/.test(f)), facts.join("\n"));
  assert.match(buildIssueRevalidationPrompt(listed!, "escalation", { facts }), /Absence is not proof/);
});

test("an absence-only still-true judgement is unknown rather than proof of a live problem", () => {
  for (const citation of [
    "no origin/main commit since the issue opened names #13322 in its subject — absence only",
    "ledger step cli.approve: 0 row(s) in the last 48 h — absence only: a misread or unwritten step reads 0 too, so this proves no fix",
    "`frontendApiProxy` does not appear on origin/main",
  ]) {
    const verdict = parseIssueRevalidationVerdict(`REVALIDATION_VERDICT: still-true\nREVALIDATION_REASON: the issue has not been addressed\nREVALIDATION_CITATION: ${citation}`);
    assert.equal(verdict.verdict, "unknown", citation);
    assert.match(verdict.reason, /absence-only/);
    assert.equal(verdict.citation, undefined, "absence is not retained as a deciding citation");
  }
  assert.equal(parseIssueRevalidationVerdict("REVALIDATION_VERDICT: still-true\nREVALIDATION_REASON: a current failure was observed\nREVALIDATION_CITATION: ledger step filing.failed: 3 row(s) in the last 48 h, newest current").verdict, "still-true");
});

test("fresh and cached absence-only revalidation cannot refresh an issue in either mode", async () => {
  for (const mode of ["act", "shadow"] as const) for (const cached of [false, true]) {
    const issue = blocked(13345, { body: "**Class:** GRILL\n**Task:** TRIAGE-observation\nIdentify the historical approvals before classifying them." });
    const unsupported: RevalidationVerdict = { verdict: "still-true", reason: "no approvals were traced", citation: "ledger step cli.approve: 0 row(s) in the last 48 h — absence only" };
    const writes: string[] = [], rows: Record<string, unknown>[] = [];
    let judges = 0;
    const prior: PriorVerdict = { ...unsupported, at: at(-1), issueUpdatedAt: issue.updatedAt, action: "keep", acted: false };
    const p: IssueRevalidationPorts = {
      policy: () => ({ mode, maxClosesPerPass: 5 }), listOpenIssues: async () => [issue], listComments: async () => [],
      referentVerdicts: async () => new Map(), hasReferent: () => false,
      livenessVerdict: () => ({ verdict: "unknown", reason: "not a liveness issue" }),
      readModelVerdict: () => ({ verdict: "unknown", reason: "not a read-model issue" }),
      evidence: () => ({ facts: [unsupported.citation!] }), judge: async () => { judges++; return unsupported; },
      priorVerdicts: () => cached ? new Map([[issue.number, prior]]) : new Map(),
      close: async () => { writes.push("close"); }, comment: async () => { writes.push("comment"); },
      fileConversion: async () => { writes.push("convert"); return "unexpected"; },
      log: (step, extra = {}) => { if (step === ISSUE_REVALIDATION_VERDICT_STEP) rows.push(extra); }, clock,
    };
    await runIssueRevalidationGarden(p);
    assert.equal(judges, cached ? 0 : 1, "the normal unchanged-input cache is retained");
    assert.deepEqual(writes, [], `${mode}, cached=${cached}: no GitHub refresh, close or conversion`);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.verdict, rows[0]!.action, rows[0]!.acted], ["unknown", "keep", false]);
  }
});

test("positive still-true evidence keeps the ordinary refresh and operator protections", async () => {
  const citation = "ledger step ci-friction.garden_filing_failed: 3 row(s) in the last 48 h, newest current";
  const verdict = parseIssueRevalidationVerdict(`REVALIDATION_VERDICT: still-true\nREVALIDATION_REASON: three current failures\nREVALIDATION_CITATION: ${citation}`);
  assert.equal(verdict.verdict, "still-true");
  const prompt = buildIssueRevalidationPrompt(blocked(10269), "escalation", { facts: [citation] });
  assert.match(prompt, /still-true.*positive current evidence/);
  assert.match(prompt, /unknown.*absence-only/);
});
