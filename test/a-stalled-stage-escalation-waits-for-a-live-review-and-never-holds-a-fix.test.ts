import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLedgerLines } from "../src/lib/status.js";
import {
  buildSweepEffects, noteReviewDuration, observedReviewOverrunBoundMs, renderClarificationQuestion,
  resetIdleReviewMemo, runSweep, type OpenPrView, type SweepDeps,
} from "./helpers/sweep-test.js";
import { writeLedger } from "./helpers/ledger-fixture.js";
import { findDuplicateEscalation, type IssueGateway, type OpenIssue } from "../src/lib/escalate.js";
import type { Config } from "../src/lib/config.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// #10848 / #10874: the awaiting-review stage began 13:06:37Z, the review was admitted 13:10:45Z and ran to
// about 13:51Z; the backstop opened a needs-human issue at 13:40Z, and that issue stood the fix rung down.
const now = Date.UTC(2026, 9, 11, 13, 40, 28);
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const pr: OpenPrView = {
  prNumber: 10848, prUrl: "https://github.com/craigoley/remudero/pull/10848", taskId: "W1-T7724",
  headSha: "37d03bc", headRefName: "run-W1-T7724-1", reviewState: "none", checksState: "green",
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: ago(5), autoMergeArmed: false,
};

function fixture(stageMinutes: number, extra: Record<string, unknown>[] = []) {
  const ledger = writeLedger([{
    ts: ago(stageMinutes), run_id: "old", task_id: pr.taskId, step: "sweep.disposed",
    pr_number: pr.prNumber, head_sha: pr.headSha, disposition: "blocked-ambiguous", acted: false,
    blocker: "awaiting-review", blocker_since: ago(stageMinutes),
  }, ...extra]);
  const escalations: Array<{ reason: string; cause?: string }> = [];
  const deps: SweepDeps = {
    ledgerPath: ledger.path, runId: "test-live-review", now: () => now,
    arm: () => "hold-refused", close: () => {}, dispatchFix: () => {}, postReview: () => {},
    escalate: (_pr, reason, question) => { escalations.push({ reason, cause: question.cause }); },
  };
  const rows = (step: string) => readLedgerLines(ledger.path).filter(row => row.step === step);
  return { ledger, deps, escalations, rows };
}

const admitted = (minutesAgo: number) => ({
  ts: ago(minutesAgo), run_id: "old", task_id: pr.taskId, step: "sweep.review_admitted",
  pr_number: pr.prNumber, pr_url: pr.prUrl, head_sha: pr.headSha,
});
const sweep = (f: ReturnType<typeof fixture>) => runSweep([pr], { ...f.deps, actionable: () => false });

test("W1-T8167: a review still running is not escalated as a stalled stage", async () => {
  resetIdleReviewMemo();
  const f = fixture(33.9, [admitted(29.7)]);
  await sweep(f);
  assert.equal(f.rows("pr.stuck").length, 0);
  assert.equal(f.escalations.length, 0);
  const deferred = f.rows("pr.stuck.deferred");
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].blocker, "awaiting-review");
  assert.equal(deferred[0].head_sha, pr.headSha);
  assert.equal(deferred[0].admitted_at, ago(29.7));
  await sweep(f);
  assert.equal(f.rows("pr.stuck.deferred").length, 1, "deferred once per (PR, stage)");
  assert.equal(f.escalations.length, 0);

  // A closing row ends the live owner: the same stage then escalates.
  for (const step of ["review.posted", "review.post_failed", "review.post_refused"]) {
    const done = fixture(40, [admitted(35), { ts: ago(5), step, pr_url: pr.prUrl, pr_number: pr.prNumber, head_sha: pr.headSha }]);
    await sweep(done);
    assert.equal(done.rows("pr.stuck").length, 1, step);
  }
});

test("W1-T8167: a review running past its observed length escalates", async () => {
  resetIdleReviewMemo();
  [4, 9, 7].forEach(minutes => noteReviewDuration(minutes * 60_000));
  assert.equal(observedReviewOverrunBoundMs([4, 9, 7].map(m => m * 60_000)), 9 * 60_000);
  assert.equal(observedReviewOverrunBoundMs([]), undefined);
  const f = fixture(40, [admitted(20)]);
  await sweep(f);
  resetIdleReviewMemo();
  assert.equal(f.rows("pr.stuck").length, 1);
  assert.equal(f.rows("pr.stuck")[0].diagnosis, "review running past its observed length");
  assert.equal(f.rows("pr.stuck.deferred").length, 0);
  assert.equal(f.escalations.length, 1);
  assert.match(f.escalations[0].reason, /DIAGNOSIS: review running past its observed length/);

  // Within the observed length the same review is still a live owner.
  [4, 9, 7].forEach(minutes => noteReviewDuration(minutes * 60_000));
  const within = fixture(40, [admitted(8)]);
  await sweep(within);
  resetIdleReviewMemo();
  assert.equal(within.rows("pr.stuck").length, 0);
  assert.equal(within.rows("pr.stuck.deferred").length, 1);
});

test("W1-T8167: an awaiting-review stage with no live owner still escalates", async () => {
  resetIdleReviewMemo();
  const f = fixture(33);
  await sweep(f);
  assert.equal(f.rows("pr.stuck").length, 1);
  assert.equal(f.rows("pr.stuck")[0].diagnosis, "unknown signature");
  assert.equal(f.escalations.length, 1);
  assert.equal(f.escalations[0].cause, "stage-stall");

  // An admission for another head, or one that predates the stage, is no owner of this stage.
  const other = fixture(33, [{ ...admitted(20), head_sha: "other" }]);
  await sweep(other);
  assert.equal(other.rows("pr.stuck").length, 1);
});

test("a review whose setup refuses on every pass at one head escalates at the backstop, naming the refusal", async () => {
  resetIdleReviewMemo();
  // #13305 (2026-10-21): each pass re-admitted the review and it refused (head-task-metadata-unavailable) a minute later,
  // so the newest admission always looked live and the stall was deferred, then misdiagnosed as a long review.
  const refused = (minutesAgo: number, head = pr.headSha) => ({ ts: ago(minutesAgo), step: "review.semantic_setup_refused",
    pr_url: pr.prUrl, head_sha: head, reason: "head-task-metadata-unavailable" });
  const f = fixture(33, [admitted(21), refused(20), admitted(11), refused(10), admitted(0.5)]);
  await sweep(f);
  assert.equal(f.rows("pr.stuck.deferred").length, 0, "a refusing review is no live owner");
  assert.equal(f.rows("pr.stuck").length, 1);
  assert.equal(f.rows("pr.stuck")[0].diagnosis,
    "review setup refused at this head on every pass (head-task-metadata-unavailable, 2 refusals)");
  assert.equal(f.escalations.length, 1);
  assert.equal(f.escalations[0].cause, "stage-stall");
  assert.match(f.escalations[0].reason, /DIAGNOSIS: review setup refused at this head on every pass/);

  // A review that started after the refusal is a live owner again; a refusal at another head names nothing here.
  for (const extra of [[refused(10), { ts: ago(9), step: "review.pending_posted", pr_url: pr.prUrl }], [refused(10, "other")]]) {
    resetIdleReviewMemo();
    const live = fixture(33, [...extra, admitted(0.5)]);
    await sweep(live);
    assert.equal(live.rows("pr.stuck").length, 0);
    assert.equal(live.rows("pr.stuck.deferred").length, 1);
  }
});

const HEAD ="37d03bcaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function issueStore(): IssueGateway & { created: Array<{ url: string; title: string; body: string }> } {
  const created: Array<{ url: string; title: string; body: string }> = [];
  return {
    created,
    create(title, body) {
      const url = `https://github.com/craigoley/remudero/issues/${10874 + created.length}`;
      created.push({ url, title, body });
      return url;
    },
    comment() {},
    listOpen: (): OpenIssue[] => created.map((i, n) => ({ number: 10874 + n, url: i.url, title: i.title, body: i.body })),
  };
}

test("W1-T8167: an open stall issue does not stand a fix round down", async () => {
  const issues = issueStore();
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stall-vs-fix-`));
  const task = { id: pr.taskId, files: ["src/x.ts"], acceptance: [] } as unknown as Task;
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", repoRoot: root, config: { claudeBin: "claude", root } as Config,
    ledgerPath: join(root, "ledger.ndjson"), runId: "SWEEP-stall-vs-fix",
    plan: { tasks: [task], byId: new Map([[pr.taskId!, task]]) } as Plan, log: () => {}, issuesImpl: issues,
    reloadPlanForFixImpl: () => undefined, readJsonImpl: async () => { throw new Error("no read expected"); },
  });
  const stalled = { ...pr, headSha: HEAD };
  const reason = `PR stage stalled: #${pr.prNumber} ${pr.prUrl} — awaiting-review for 33 minutes (BACKSTOP 30); ` +
    `since 2026-10-11T13:06:37.000Z; DIAGNOSIS: unknown signature`;
  await effects.escalate(stalled, reason, { ...renderClarificationQuestion(stalled, reason), cause: "stage-stall" });
  assert.equal(issues.created.length, 1);
  assert.match(issues.created[0].body, /\*\*Cause:\*\* stage-stall/);

  // The fix rung's pre-strike probe key (src/run-task.ts): cause "review" for a PR with no conflict and no red CI.
  const probe = (cause: "review" | "stage-stall") => findDuplicateEscalation({
    class: "BLOCKED", taskId: pr.taskId!, summary: `review false-block — ${pr.prUrl}`, detail: "", headSha: HEAD, cause,
  }, { issues });
  const matched = probe("review");
  assert.equal(matched, undefined);

  // Positive control: the same probe does match an issue carrying the fix rung's own cause, and stands down.
  const control = issueStore();
  control.create("[BLOCKED] fix", issues.created[0].body.replace("stage-stall", "review"), []);
  const controlMatch = findDuplicateEscalation({
    class: "BLOCKED", taskId: pr.taskId!, summary: `review false-block — ${pr.prUrl}`, detail: "", headSha: HEAD, cause: "review",
  }, { issues: control });
  assert.ok(controlMatch);

  // Another stall report for the same PR still dedups onto its own issue.
  assert.ok(probe("stage-stall"));
  await effects.escalate(stalled, reason, { ...renderClarificationQuestion(stalled, reason), cause: "stage-stall" });
  assert.equal(issues.created.length, 1);
});

test("#14898: a stalled stage whose PR a fresh read finds merged or closed is never escalated", async () => {
  resetIdleReviewMemo();
  for (const state of ["MERGED", "CLOSED"]) {
    const f = fixture(33);
    await runSweep([pr], { ...f.deps, actionable: () => false, readLiveState: () => ({ ok: true, state }) });
    assert.equal(f.escalations.length, 0, state);
    assert.equal(f.rows("pr.stuck").length, 0, state);
    assert.equal(f.rows("pr.stuck.not_open")[0]?.reason, `state is ${state} (only an OPEN PR carries a live block)`);
  }
  // An open PR, a failed read and a throwing read all escalate exactly as before.
  for (const readLiveState of [() => ({ ok: true, state: "OPEN" }), () => ({ ok: false }), () => { throw new Error("gh down"); }]) {
    const f = fixture(33);
    await runSweep([pr], { ...f.deps, actionable: () => false, readLiveState });
    assert.equal(f.escalations.length, 1);
    assert.equal(f.rows("pr.stuck.not_open").length, 0);
  }
});
