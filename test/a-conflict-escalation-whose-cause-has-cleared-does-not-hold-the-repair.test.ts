// test/a-conflict-escalation-whose-cause-has-cleared-does-not-hold-the-repair.test.ts — W1-T5908.
//
// LIVE 2026-10-05, fleet #9374: one pass read the PR dirty while GitHub's mergeability was still
// `unknown`, captured no conflicting-file evidence, and the W1-T78 clarification rung opened
// needs-human #9384. Every later pass captured the evidence and dispositioned `conflicted`, but the
// fix rung stood down on the open (task, PR, head, cause) escalation until a human merged by hand.
//
// (1) a dirty, evidence-less PR whose mergeability reads `unknown` WAITS, bounded by
//     MERGEABILITY_UNKNOWN_WAIT_BACKSTOP passes on the head, before the no-evidence escalation;
// (2) the escalation records the disposition that raised it (`**Raised-by:**`) and the base it was
//     raised against (`**Base:**`); a merge-conflict round whose evidence is now captured (or whose
//     base moved) is not stood down by it, dispatches, and closes it naming the cleared cause —
//     while an escalation whose cause still holds keeps standing the rung down.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BASE_SHA_LINE_RE,
  CONFLICT_EVIDENCE_MISSING_REASON_CODE,
  CONFLICT_NOT_ADMITTED_REASON_CODE,
  DEFAULT_SWEEP_POLICY,
  MERGEABILITY_UNKNOWN_WAIT_BACKSTOP,
  RAISED_BY_LINE_RE,
  buildSweepEffects,
  clearedConflictEscalationCause,
  conflictEscalationContext,
  deriveDisposition,
  mergeabilityReadUnknown,
  mergeabilityUnknownWaitsFromLedger,
  renderClarificationQuestion,
  runSweep,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import {
  buildFixRungDispatchArgs,
  openEscalationStandDownReason,
  resolveClearedEscalation,
  runFixRung,
} from "./helpers/run-task-test.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { MergeConflictEvidence } from "../src/lib/merge-state.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = Date.parse("2026-10-05T18:31:04.000Z");
const TASK_ID = "W1-T5053";
const PR_NUMBER = 9374;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`;
const HEAD = "71826974eb530b78f0a21ea89a10f43aa6626f1d";
const BRANCH = `run-${TASK_ID}-1791200000000`;
const BASE_AT_ESCALATION = "b2dcd392aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE_MOVED = "c3edd4a3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EVIDENCE: MergeConflictEvidence = {
  files: [{ path: "src/lib/serve.ts", oursDeleted: 24, theirsDeleted: 1 }],
  oursLog: "71826974 merge main",
  theirsLog: "b5889af8 analytics view",
};

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5908-${name}-`));
}

function dirtyPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR_NUMBER,
    prUrl: PR_URL,
    taskId: TASK_ID,
    reviewState: "success",
    checksState: "none",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW).toISOString(),
    headSha: HEAD,
    headRefName: BRANCH,
    autoMergeArmed: false,
    mergeState: "dirty",
    mergeableState: "unknown",
    ...over,
  };
}

const POLICY = { ...DEFAULT_SWEEP_POLICY, mergeConflictAdmissionEnabled: true };

// ── (1) the bounded wait ─────────────────────────────────────────────────────────────────────

test("a dirty PR with unknown mergeability and no evidence waits until the bound, then escalates the no-evidence cause", () => {
  for (let passes = 0; passes < MERGEABILITY_UNKNOWN_WAIT_BACKSTOP; passes++) {
    const d = deriveDisposition(dirtyPr(), POLICY, NOW, { mergeabilityUnknownPasses: passes });
    assert.equal(d.disposition, "wait", `pass ${passes} waits`);
    assert.equal(d.blocker, "conflict");
    assert.match(d.reason, /^mergeability-unknown — /);
  }
  const atBound = deriveDisposition(dirtyPr(), POLICY, NOW, { mergeabilityUnknownPasses: MERGEABILITY_UNKNOWN_WAIT_BACKSTOP });
  assert.equal(atBound.disposition, "blocked-ambiguous");
  assert.match(atBound.reason, /no valid conflicting-file evidence was captured/);
  assert.equal(deriveDisposition(dirtyPr(), POLICY, NOW).disposition, "wait", "omitted facts read as zero passes");
});

test("only an unknown read waits: a KNOWN dirty read, a foreign branch, or captured evidence never takes the wait row", () => {
  assert.equal(mergeabilityReadUnknown({ mergeableState: "unknown" }), true);
  assert.equal(mergeabilityReadUnknown({ mergeableState: "dirty" }), false);
  assert.equal(mergeabilityReadUnknown({}), false);
  assert.equal(deriveDisposition(dirtyPr({ mergeableState: "dirty" }), POLICY, NOW).disposition, "blocked-ambiguous");
  assert.equal(deriveDisposition(dirtyPr({ headRefName: "contributor-branch" }), POLICY, NOW).disposition, "blocked-ambiguous");
  assert.equal(deriveDisposition(dirtyPr({ taskId: undefined }), POLICY, NOW).disposition, "blocked-ambiguous");
  assert.equal(deriveDisposition(dirtyPr({ mergeConflict: EVIDENCE }), POLICY, NOW).disposition, "conflicted");
});

test("the wait count is per head: a new head starts at zero and non-wait rows never count", () => {
  const rows = [
    { step: "sweep.disposed", pr_number: PR_NUMBER, head_sha: "old", disposition: "wait", blocker: "conflict" },
    { step: "sweep.disposed", pr_number: PR_NUMBER, head_sha: HEAD, disposition: "wait", blocker: "conflict" },
    { step: "sweep.disposed", pr_number: PR_NUMBER, head_sha: HEAD, disposition: "blocked-ambiguous", blocker: "conflict" },
    { step: "sweep.disposed", pr_number: PR_NUMBER, head_sha: HEAD, disposition: "wait", blocker: "awaiting-ci" },
    { step: "sweep.disposed", pr_number: PR_NUMBER, head_sha: HEAD, disposition: "wait", blocker: "conflict" },
    { step: "sweep.disposed", pr_number: "9374", head_sha: HEAD, disposition: "wait", blocker: "conflict" },
    { step: "fix.dispatch", pr_number: PR_NUMBER, head_sha: HEAD, disposition: "wait", blocker: "conflict" },
    { step: "sweep.disposed", pr_number: 1, head_sha: "x", disposition: "wait", blocker: "conflict" },
  ];
  const waits = mergeabilityUnknownWaitsFromLedger(rows);
  assert.deepEqual(waits.get(PR_NUMBER), { headSha: HEAD, passes: 2 });
  assert.deepEqual(waits.get(1), { headSha: "x", passes: 1 });
});

function sweepDeps(ledgerPath: string, now: number): SweepDeps & {
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
  fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
} {
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: (pr, evidence) => {
      fixed.push({ pr, evidence });
    },
    escalate: (pr, reason, question) => {
      escalated.push({ pr, reason, question });
    },
    readMainTip: () => BASE_MOVED,
    escalated,
    fixed,
    ledgerPath,
    runId: "SWEEP-W1-T5908",
    now: () => now,
  };
}

test("runSweep waits BACKSTOP passes on the unknown read without escalating, escalates after, and dispatches once evidence lands", async () => {
  const ledgerPath = join(tmp("sweep"), "ledger.ndjson");
  const escalations: number[] = [];
  for (let pass = 0; pass <= MERGEABILITY_UNKNOWN_WAIT_BACKSTOP; pass++) {
    const deps = sweepDeps(ledgerPath, NOW + pass * 60_000);
    await runSweep([dirtyPr()], deps, POLICY);
    escalations.push(deps.escalated.length);
  }
  const disposed = readLedgerLines(ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.deepEqual(
    disposed.map((l) => l.disposition),
    [...Array(MERGEABILITY_UNKNOWN_WAIT_BACKSTOP).fill("wait"), "blocked-ambiguous"],
  );
  assert.deepEqual(escalations, [...Array(MERGEABILITY_UNKNOWN_WAIT_BACKSTOP).fill(0), 1], "no escalation until the bound");

  const captured = sweepDeps(ledgerPath, NOW + 10 * 60_000);
  await runSweep([dirtyPr({ mergeableState: "dirty", mergeable: false, mergeConflict: EVIDENCE })], captured, POLICY);
  assert.equal(captured.fixed.length, 1, "the evidence-captured pass dispatches the merge-conflict worker");
  assert.equal(captured.fixed[0]!.evidence.baseSha, BASE_MOVED, "the dispatch carries the base it was derived against");
});

// ── (2) the escalation records its raising disposition and base ──────────────────────────────

type IssueStore = IssueGateway & {
  created: Array<{ number: number; url: string; title: string; body: string }>;
  closed: Array<{ url: string; comment: string }>;
};

function issueStore(): IssueStore {
  let seq = 9384;
  const created: IssueStore["created"] = [];
  const closed: IssueStore["closed"] = [];
  return {
    created,
    closed,
    create(title, body) {
      const number = seq++;
      const url = `https://github.com/craigoley/remudero/issues/${number}`;
      created.push({ number, url, title, body });
      return url;
    },
    comment() {},
    listOpen: (): OpenIssue[] =>
      created
        .filter((i) => !closed.some((c) => c.url === i.url))
        .map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body })),
    closeWithComment(url, comment) {
      closed.push({ url, comment });
    },
  };
}

function effectsFor(issues: IssueStore, mainSha: string | null) {
  const root = tmp("effects");
  return buildSweepEffects({
    owner: "craigoley",
    repo: "remudero",
    repoRoot: root,
    config: { claudeBin: "claude", root } as Config,
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "SWEEP-W1-T5908",
    plan: { tasks: [], byId: new Map() },
    log: () => {},
    issuesImpl: issues,
    readJsonImpl: async (args) => {
      assert.deepEqual(args, ["api", "repos/craigoley/remudero/commits/main"]);
      if (mainSha === null) throw new Error("rate limited");
      return { sha: mainSha };
    },
  });
}

async function raiseNoEvidenceEscalation(issues: IssueStore, mainSha: string | null = BASE_AT_ESCALATION): Promise<string> {
  const pr = dirtyPr({ mergeableState: "dirty" });
  const reason = deriveDisposition(pr, POLICY, NOW).reason;
  await effectsFor(issues, mainSha).escalate(pr, reason, renderClarificationQuestion(pr, reason));
  return issues.created.at(-1)!.body;
}

test("the no-evidence conflict escalation records its reason code and the base it was raised against", async () => {
  const issues = issueStore();
  const body = await raiseNoEvidenceEscalation(issues);
  assert.match(body, /^\*\*Head:\*\* 71826974eb530b78f0a21ea89a10f43aa6626f1d$/m);
  assert.match(body, /^\*\*Cause:\*\* conflict$/m);
  assert.equal(RAISED_BY_LINE_RE.exec(body)?.[1], CONFLICT_EVIDENCE_MISSING_REASON_CODE);
  assert.equal(BASE_SHA_LINE_RE.exec(body)?.[1], BASE_AT_ESCALATION);

  const unreadMain = issueStore();
  const noBase = await raiseNoEvidenceEscalation(unreadMain, null);
  assert.equal(RAISED_BY_LINE_RE.test(noBase), true, "an unreadable main still records the reason code");
  assert.equal(BASE_SHA_LINE_RE.test(noBase), false, "and never invents a base");

  const ciIssues = issueStore();
  const ciPr = dirtyPr({ mergeState: undefined, mergeableState: undefined, checksState: "red" });
  effectsFor(ciIssues, BASE_AT_ESCALATION).escalate(ciPr, "checks red", renderClarificationQuestion(ciPr, "checks red"));
  assert.equal(ciIssues.created.length, 1, "a non-conflict escalation files synchronously, as before");
  assert.equal(RAISED_BY_LINE_RE.test(ciIssues.created[0]!.body), false, "and carries no conflict context");

  assert.match(conflictEscalationContext({ mergeConflict: EVIDENCE }, undefined), /^\*\*Raised-by:\*\* conflict-not-admitted\n\n$/);
});

test("the cleared-cause read: captured evidence answers a no-evidence escalation, a moved base answers any conflict escalation", () => {
  const noEvidence = `**Raised-by:** ${CONFLICT_EVIDENCE_MISSING_REASON_CODE}\n**Base:** ${BASE_AT_ESCALATION}\n`;
  const notAdmitted = `**Raised-by:** ${CONFLICT_NOT_ADMITTED_REASON_CODE}\n**Base:** ${BASE_AT_ESCALATION}\n`;
  assert.match(clearedConflictEscalationCause(noEvidence, { conflictEvidenceCaptured: true })!, /evidence is now captured/);
  assert.equal(clearedConflictEscalationCause(noEvidence, { conflictEvidenceCaptured: false, baseSha: BASE_AT_ESCALATION }), undefined);
  assert.equal(clearedConflictEscalationCause(notAdmitted, { conflictEvidenceCaptured: true, baseSha: BASE_AT_ESCALATION }), undefined);
  assert.match(clearedConflictEscalationCause(notAdmitted, { conflictEvidenceCaptured: true, baseSha: BASE_MOVED })!, /base has moved/);
  assert.equal(clearedConflictEscalationCause(undefined, { conflictEvidenceCaptured: true, baseSha: BASE_MOVED }), undefined);
  assert.equal(RAISED_BY_LINE_RE.test("**Raised-by:**"), false);
  assert.equal(BASE_SHA_LINE_RE.test("Base: abc"), false);
});

test("openEscalationStandDownReason: a head-qualified escalation whose cause cleared does not stand down; one whose cause holds does", () => {
  const candidate: OpenIssue = {
    number: 9384,
    url: "https://github.com/craigoley/remudero/issues/9384",
    body: `**Head:** ${HEAD}\n**Cause:** conflict\n\n**Raised-by:** ${CONFLICT_EVIDENCE_MISSING_REASON_CODE}\n**Base:** ${BASE_AT_ESCALATION}\n`,
  };
  assert.equal(openEscalationStandDownReason(HEAD, candidate, undefined, { conflictEvidenceCaptured: true, baseSha: BASE_AT_ESCALATION }), undefined);
  assert.match(
    openEscalationStandDownReason(HEAD, candidate, undefined, { conflictEvidenceCaptured: false, baseSha: BASE_AT_ESCALATION })!.reason,
    /ALREADY OPEN/,
  );
  assert.match(openEscalationStandDownReason(HEAD, candidate)!.reason, /ALREADY OPEN/, "no current facts keeps the head-only stand-down");
});

// ── the merge-conflict round itself ──────────────────────────────────────────────────────────

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function worker(): WorkerResult {
  return {
    sessionId: "fix-session",
    costUsd: 0,
    numTurns: 1,
    text: "REPORT\nresolved the conflict.\nPR_URL: (unchanged)",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

async function conflictRound(issues: IssueStore, baseSha: string) {
  const root = tmp("rung");
  const spawned: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const args = buildFixRungDispatchArgs({
    task: { id: TASK_ID, title: "analytics view" },
    runId: `${TASK_ID}-run`,
    prUrl: PR_URL,
    branch: BRANCH,
    worktreePath: join(root, "wt"),
    mount: MOUNT,
    settingsFile: join(root, "settings.json"),
    config: { root } as Config,
    budgetUsd: 5,
    strikeCap: 1,
    evidence: { unmetCriteria: [], mergeConflict: EVIDENCE, baseSha },
    pr: { headSha: HEAD },
    reviewBase: { owner: "craigoley", repo: "remudero", headCheckoutDir: join(root, "wt"), reviewerMount: MOUNT },
  });
  assert.equal(args.baseSha, baseSha, "the dispatch args thread the base through to the rung");
  const outcome = await runFixRung({
    ...args,
    deps: {
      spawn: async (a: SpawnWorkerArgs) => {
        spawned.push(a);
        return worker();
      },
      waitForCiGreen: async () => "green" as const,
      fetchPrBody: async () => "PR body",
      runReview: async () => ({ ...args.initialReview, state: "success" as const, criteria: [] }),
      push: () => {},
      issues,
      ledgerPath: join(root, "ledger.ndjson"),
      log: (step: string, extra?: Record<string, unknown>) => logs.push({ step, extra }),
      say: () => {},
      account: (r: WorkerResult) => r,
      readLiveState: async () => ({ ok: true as const, state: "OPEN" as const }),
    },
  } as never);
  return { outcome, spawned, logs };
}

test("an open no-evidence conflict escalation does not stand down the round once evidence is captured: it dispatches and closes the escalation naming the cleared cause", async () => {
  const issues = issueStore();
  await raiseNoEvidenceEscalation(issues);
  const issueUrl = issues.created[0]!.url;

  const { spawned, logs } = await conflictRound(issues, BASE_AT_ESCALATION);

  assert.equal(
    logs.some((l) => l.step === "fix.stood_down" && /ALREADY OPEN/.test(String(l.extra?.reason))),
    false,
    "the #9374 stand-down on a cleared cause",
  );
  assert.ok(spawned.length >= 1, "the bounded merge-conflict worker is dispatched");
  assert.equal(issues.closed.length, 1, "the stale escalation is closed");
  assert.equal(issues.closed[0]!.url, issueUrl);
  assert.match(issues.closed[0]!.comment, /Resolved by change/);
  assert.match(issues.closed[0]!.comment, /conflict-evidence-missing — the conflicting-file evidence is now captured/);
  const superseded = logs.find((l) => l.step === "escalation.superseded");
  assert.equal(superseded?.extra?.delivered, true);
  assert.equal(superseded?.extra?.superseded_issue_url, issueUrl);
});

test("a conflict escalation whose cause still holds keeps standing the round down, until the base moves", async () => {
  const issues = issueStore();
  const issueUrl = issues.create(
    `[BLOCKED] ${TASK_ID}: PR ${PR_URL} needs a clarification — conflict repair was not admitted`,
    `**Class:** BLOCKED\n**Task:** ${TASK_ID}\n**Head:** ${HEAD}\n**Cause:** conflict\n\n` +
      `**Raised-by:** ${CONFLICT_NOT_ADMITTED_REASON_CODE}\n**Base:** ${BASE_AT_ESCALATION}\n\nPR ${PR_URL}`,
    [],
  );

  const held = await conflictRound(issues, BASE_AT_ESCALATION);
  assert.equal(held.outcome.outcome, "stood_down");
  assert.match(String(held.outcome.standDownReason), new RegExp(`ALREADY OPEN.*${issueUrl.replace(/\//g, "\\/")}`));
  assert.equal(held.spawned.length, 0, "no worker while the question still applies");
  assert.equal(issues.closed.length, 0);

  const moved = await conflictRound(issues, BASE_MOVED);
  assert.ok(moved.spawned.length >= 1, "a moved base re-admits a conflict cause, as a moved head does");
  assert.match(issues.closed[0]!.comment, /base has moved to c3edd4a3/);
});

test("resolveClearedEscalation ledgers an undelivered close rather than losing it", () => {
  const rows: Array<Record<string, unknown>> = [];
  const log = (step: string, extra?: Record<string, unknown>) => rows.push({ step, ...extra });
  resolveClearedEscalation({ create: () => "" }, log, TASK_ID, "https://github.com/x/y/issues/1", "cleared");
  resolveClearedEscalation(
    { create: () => "", closeWithComment: () => { throw new Error("HTTP 502"); } },
    log,
    TASK_ID,
    "https://github.com/x/y/issues/2",
    "cleared",
  );
  assert.deepEqual(rows.map((r) => [r.delivered, r.failure]), [
    [false, "issue gateway cannot close issues"],
    [false, "HTTP 502"],
  ]);
});
