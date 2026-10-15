import assert from "node:assert/strict";
import { test } from "node:test";

import {
  daemonBreakerRunbookHost,
  NON_WORKER_BREAKER_ACTOR,
  readBreakerStrikes,
  releaseBreaker,
} from "../src/lib/breaker-release.js";
import type { GhAsyncExecutor } from "../src/lib/github-transport.js";
import type { SreGovernorTier, SreGovernorVerdict } from "../src/lib/sre-governor.js";
import {
  receiptFromLedgerRow,
  runMatchingRunbook,
  SRE_RUNBOOK_STEP,
  sreRunbookCatalog,
  type IncidentEvidence,
  type SreRunbookHost,
  type SreRunbookReceipt,
} from "../src/lib/sre-runbooks.js";
import { readLedgerLines } from "../src/lib/status.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

/**
 * W1-T8241 — a breaker tripped only by the harness is released by a governed runbook, not a person.
 * The fixture is W1-T7742's 2026-10-11 episode: two restart yields, a claim race, a refused checkpoint push and
 * two node_modules refusals, plus an output-budget stop the breaker still counts today, then the trip at
 * 08:35:15Z. The control task carries one worker-attributable failure among the same harness interruptions.
 */

const REPO = "remudero";
const ISSUE = "https://github.com/craigoley/remudero/issues/10825";

function run(task: string, runId: string, startIso: string, endIso: string, verdict: Record<string, unknown>): Record<string, unknown>[] {
  return [
    { ts: startIso, run_id: runId, task_id: task, repo: REPO, step: "run.start", type: "implement" },
    { ts: endIso, run_id: runId, task_id: task, repo: REPO, step: "verdict", ...verdict },
  ];
}

function episode(task: string, last: Record<string, unknown> = { verdict: "failed", stage: "worker.bounded_output" }): Record<string, unknown>[] {
  return [
    { ts: "2026-10-09T10:00:00.000Z", run_id: `${task}-R0`, task_id: task, repo: REPO, step: "pr.opened" },
    ...run(task, `${task}-R1`, "2026-10-10T20:50:00.000Z", "2026-10-10T21:13:34.000Z", { verdict: "no_pr", reason: "restart_checkpoint_failed" }),
    ...run(task, `${task}-R2`, "2026-10-11T04:40:00.000Z", "2026-10-11T04:49:28.000Z", { verdict: "handed_off", reason: "freshness_yield" }),
    ...run(task, `${task}-R3`, "2026-10-11T06:20:00.000Z", "2026-10-11T06:25:00.000Z", { verdict: "failed", stage: "worktree.node_modules" }),
    ...run(task, `${task}-R4`, "2026-10-11T06:50:00.000Z", "2026-10-11T06:52:00.000Z", { verdict: "blocked_inflight" }),
    ...run(task, `${task}-R5`, "2026-10-11T06:55:00.000Z", "2026-10-11T07:03:40.000Z", { verdict: "handed_off", reason: "recycle_yield" }),
    ...run(task, `${task}-R6`, "2026-10-11T07:10:00.000Z", "2026-10-11T07:12:00.000Z", { verdict: "failed", stage: "worktree.node_modules" }),
    ...run(task, `${task}-R7`, "2026-10-11T07:40:00.000Z", "2026-10-11T08:20:00.000Z", last),
    { ts: "2026-10-11T08:35:15.000Z", run_id: "DAEMON", task, step: "dispatch.circuit_broken", freshCount: 5 },
    { ts: "2026-10-11T08:35:18.000Z", run_id: "DAEMON", task_id: task, repo: REPO, step: "dispatch.circuit_broken.escalated", issue_url: ISSUE },
  ];
}

function incident(task: string, lastSeenMs = Date.parse("2026-10-11T09:00:00.000Z")): IncidentEvidence {
  const subject = `task=${task} since=2026-10-10T20:50:00.000Z causes=claim_race:1,node_modules:2 breaker=tripped passed_over=0`;
  return {
    fingerprint: `${task}`.padEnd(64, "0"),
    kind: "flow",
    name: "stranded-task",
    sampleMessages: [`${subject} stranded_minutes=730 — no worker failure, interrupted only by the harness`],
    firstSeenMs: Date.parse("2026-10-11T08:40:00.000Z"),
    lastSeenMs,
    count: 1,
    burnPerHour: 1,
    deployShas: [],
    instances: ["core"],
  };
}

const unused = async (): Promise<never> => {
  throw new Error("the breaker runbook must not reach this host method");
};
const baseHost: Omit<SreRunbookHost, "breakers"> = {
  failedCi: unused, rerunJob: unused, checkout: unused, fastForward: unused, reinstall: unused,
  canRecycle: unused, recycle: unused, lock: unused, removeLock: unused, reviewRequested: unused, requestReview: unused,
};

/** A gh child that answers `pr list` with `prs` and records each argv. */
function fakeGh(prs: unknown[], calls: string[][]): GhAsyncExecutor {
  return (async (_file: string, args: string[]) => {
    calls.push(args);
    return { stdout: JSON.stringify(prs), stderr: "" };
  }) as unknown as GhAsyncExecutor;
}

function harness(ledgerPath: string, opts: { prs?: unknown[]; receipts?: SreRunbookReceipt[] } = {}) {
  const closed: string[] = [];
  const ghCalls: string[][] = [];
  const receipts = opts.receipts ?? [];
  const breakers = daemonBreakerRunbookHost({
    ledgerPath,
    owner: "craigoley",
    repo: REPO,
    execAsync: fakeGh(opts.prs ?? [], ghCalls),
    closeIssue: (repo) => async (url) => { closed.push(`${repo} ${url}`); },
  });
  const catalog = sreRunbookCatalog({ ...baseHost, breakers }, () => receipts);
  const pass = (evidence: IncidentEvidence, tier: SreGovernorTier = "live") =>
    runMatchingRunbook(
      evidence,
      catalog,
      (): SreGovernorVerdict => ({ tier, reason: `test ${tier}` }),
      () => receipts,
      () => null,
      (step, extra) => {
        if (step === SRE_RUNBOOK_STEP) receipts.push(receiptFromLedgerRow({ step, ...extra }) as SreRunbookReceipt);
      },
      () => Date.parse("2026-10-11T09:00:00.000Z"),
    );
  return { catalog, pass, closed, ghCalls, receipts };
}

const releases = (ledgerPath: string) => readLedgerLines(ledgerPath).filter((r) => r.step === "dispatch.breaker_released");

test("W1-T8241: a breaker with only non-worker strikes is released", async () => {
  const task = "W1-T7742";
  const ledger = writeLedger(episode(task));
  const h = harness(ledger.path, { prs: [{ number: 11001, headRefName: "run-W1-T77420-1", body: "Remudero-Task: W1-T77420" }] });
  assert.ok(h.catalog.some((r) => r.id === "release-non-worker-breaker"), "a host that reads breakers offers the runbook");
  assert.equal(readBreakerStrikes(readLedgerLines(ledger.path), task).tripped, true, "sanity: the breaker is tripped");

  // GOVERNED: in shadow it only records the release it would make.
  const shadow = await h.pass(incident(task, Date.parse("2026-10-11T08:50:00.000Z")), "shadow");
  assert.equal(shadow.outcome, "would_act");
  assert.equal(releases(ledger.path).length, 0, "shadow writes no release");

  const live = await h.pass(incident(task));
  assert.equal(live.outcome, "cleared");
  assert.equal(live.runbook, "release-non-worker-breaker");
  const rows = releases(ledger.path);
  assert.equal(rows.length, 1, "exactly one dispatch.breaker_released");
  assert.equal(rows[0]!.task_id, task);
  assert.equal(rows[0]!.repo, REPO);
  assert.equal(rows[0]!.released_by, NON_WORKER_BREAKER_ACTOR);
  assert.deepEqual(rows[0]!.strike_run_ids, [1, 2, 3, 4, 5, 6, 7].map((n) => `${task}-R${n}`));
  assert.match(String(rows[0]!.reason), /W1-T7742-R1=restart_checkpoint/);
  assert.match(String(rows[0]!.reason), /W1-T7742-R4=claim_race/);
  assert.match(String(rows[0]!.reason), /W1-T7742-R7=output_budget/);
  assert.equal(readBreakerStrikes(readLedgerLines(ledger.path), task).tripped, false, "dispatchable again");
  assert.deepEqual(h.closed, [`${REPO} ${ISSUE}`], "the breaker's escalation issue is closed");
  assert.deepEqual(h.ghCalls[h.ghCalls.length - 1], ["pr", "list", "--repo", "craigoley/remudero", "--state", "open", "--limit", "1000", "--json", "number,headRefName,body"]);
  const receipt = h.receipts.find((r) => r.mode === "live")!;
  assert.equal(receipt.subject, `${task}@${[1, 2, 3, 4, 5, 6, 7].map((n) => `${task}-R${n}`).join(",")}`);
});

test("W1-T8241: a breaker with a worker strike is not released", async () => {
  const task = "W1-T9902";
  const ledger = writeLedger(episode(task, { verdict: "failed", stage: "worker.turns" }));
  const h = harness(ledger.path);
  const result = await h.pass(incident(task));
  assert.equal(result.outcome, "precheck_refused");
  assert.equal(result.fileFeedback, true, "left for the existing path");
  assert.equal(releases(ledger.path).length, 0);
  assert.match(h.receipts[0]!.before ?? "", /1 worker-attributable strike\(s\): .*W1-T9902-R7=worker/);
  assert.deepEqual(h.ghCalls, [], "a worker strike refuses before any GitHub read");
});

test("W1-T8241: a breaker whose task has an open PR, or that is not tripped, is not released", async () => {
  const task = "W1-T9903";
  const ledger = writeLedger(episode(task));
  const open = harness(ledger.path, { prs: [{ number: 12, headRefName: "feature", body: `x\nRemudero-Task: ${task}\n` }] });
  const refused = await open.pass(incident(task));
  assert.equal(refused.outcome, "precheck_refused");
  assert.match(open.receipts[0]!.before ?? "", /W1-T9903 has open PR #12/);
  assert.equal(releases(ledger.path).length, 0);

  const clear = writeLedger(episode(task).filter((r) => r.step !== "dispatch.circuit_broken"));
  const notTripped = harness(clear.path);
  assert.equal((await notTripped.pass(incident(task))).outcome, "precheck_refused");
  assert.match(notTripped.receipts[0]!.before ?? "", /breaker not tripped/);

  const other = harness(ledger.path);
  const clearIncident = { ...incident(task), sampleMessages: [`task=${task} breaker=clear passed_over=9`] };
  assert.equal((await other.pass(clearIncident)).outcome, "no_match", "a stranded task with a clear breaker is not this runbook's");
  const noTask = { ...incident(task), sampleMessages: ["breaker=tripped"] };
  assert.equal((await other.pass(noTask)).outcome, "precheck_refused");
  assert.equal(other.receipts[0]!.before, "incident names no task=<id>");

  const notArray = daemonBreakerRunbookHost({ ledgerPath: ledger.path, owner: "o", repo: REPO, execAsync: fakeGh({} as unknown as unknown[], []) });
  await assert.rejects(() => notArray.openPr(task, REPO), /was not an array/);
});

test("W1-T8241: the same strikes are never released twice", async () => {
  const task = "W1-T7742";
  const rows = episode(task);
  const ledger = writeLedger(rows);
  const h = harness(ledger.path);
  assert.equal((await h.pass(incident(task))).outcome, "cleared");
  assert.equal(releases(ledger.path).length, 1);

  // Newer evidence for the same episode: the release already reset the streak.
  const again = await h.pass(incident(task, Date.parse("2026-10-11T09:30:00.000Z")));
  assert.equal(again.outcome, "precheck_refused");
  assert.equal(releases(ledger.path).length, 1, "never a second release row");

  // A live ledger that no longer holds the release row (a replay of the same strikes) still holds the
  // runbook's own receipt for the same evidence fingerprint, so it does not release again.
  const replay = writeLedger(rows);
  const second = harness(replay.path, { receipts: h.receipts });
  const replayed = await second.pass(incident(task, Date.parse("2026-10-11T10:00:00.000Z")));
  assert.equal(replayed.outcome, "precheck_refused");
  assert.match(second.receipts[second.receipts.length - 1]!.before ?? "", /already released once for W1-T7742@W1-T7742-R1,/);
  assert.equal(releases(replay.path).length, 0);
});

test("W1-T8241: releaseBreaker reports a failed issue close without failing the release", async () => {
  const task = "W1-T9904";
  const ledger = writeLedger(episode(task));
  const result = await releaseBreaker({
    ledgerPath: ledger.path,
    taskId: task,
    repo: REPO,
    reason: "test",
    actor: "operator",
    releasedBy: "operator (`rmd release W1-T9904`)",
    closeIssue: () => {
      throw new Error("boom");
    },
    nowMs: () => 42,
  });
  assert.deepEqual(result, { runId: `RELEASE-${task}-42`, releasedCount: 1, issue: { kind: "close_failed", url: ISSUE, error: "boom" } });
  assert.equal(releases(ledger.path).length, 1);
  const none = await releaseBreaker({ ledgerPath: ledger.path, taskId: task, repo: REPO, reason: "again", actor: "operator", releasedBy: "x" });
  assert.deepEqual(none.issue, { kind: "none" }, "the earlier release retired the escalation");
});
