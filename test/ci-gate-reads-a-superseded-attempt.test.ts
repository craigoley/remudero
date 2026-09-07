/**
 * W1-T2804 — THE CI GATE READ A SUPERSEDED ATTEMPT, AND THE TWO READERS ANSWERED ABOUT
 * DIFFERENT COMMITS.
 *
 * `ciGateFromRollup` filtered `remudero-review` and nothing else: no dedupe, no required-context
 * filter. A sha accumulates one rollup entry PER ATTEMPT, so a retried check's superseded
 * CANCELLED/FAILURE entry outvoted its own green successor and the run booked `blocked_ci`
 * against a PR GitHub was already merging. Its three siblings — `checksStateFromRollup`,
 * `fetchCiFailures` and `redQualityGateNames` — had both rules already (W1-T457).
 *
 * THE PARSE IS ONLY HALF. `waitForCiGreen` resolved its own head and the wired
 * `deps.fetchCiFailures` resolved another over a second transport, so the fix rung's stand-down
 * text — "the checks-red rollup and the ci-log evidence miner disagree" — could assert a
 * disagreement about two different commits. A dedupe-only change would leave that intact while
 * looking complete, which is why this file tests BOTH halves and says so.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildFixRungDispatchArgs, ciGateFromRollup, ciGateSha, ciGateState, runFixRung, waitForCiGreen } from "../src/run-task.js";
import { dedupeRollupByLatestAttempt, type RollupCheckEntry } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const PR_URL = "https://github.com/acme/remudero/pull/42";
const OWNER = "acme";
const REPO = "remudero";
const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

/** The measured incident's own three attempts of ONE required check on ONE sha
 *  (`acceptance-author-gate` at edb9cfb3), newest last. */
const THREE_ATTEMPTS: RollupCheckEntry[] = [
  { name: "acceptance-author-gate", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-09-04T13:48:42Z" },
  { name: "acceptance-author-gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-04T13:49:20Z" },
  { name: "acceptance-author-gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-04T13:50:02Z" },
];
const CI_GREEN: RollupCheckEntry = { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-04T13:50:30Z" };

function result(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s", costUsd: 0, numTurns: 0, text: "", blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "default",
    effort: "default", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, ...over,
  };
}

function ciLogInitialReview(headSha = "deadbeef"): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state: "failure", criteria: [], testTheater: false,
    summary: "sweep-reconstructed: required checks red - ci-log dispatch",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha, reviewerOutcome: "sweep-reconstructed-ci-log",
  };
}

function fixRungBaseOpts(task: { id: string; title: string }) {
  return {
    taskId: task.id, runId: `${task.id}-1730000000000`, task, prUrl: PR_URL,
    branch: `run-${task.id}-1730000000000`, worktreePath: "/tmp/rmd-t2804-wt",
    initialSessionId: "", mount: FIX_RUNG_MOUNT, settingsFile: "/tmp/rmd-t2804-settings.json",
    config: {} as Config, budgetUsd: 10,
    reviewBase: { owner: OWNER, repo: REPO, headCheckoutDir: "/tmp/rmd-t2804-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t2804-`)), "ledger.ndjson");
}

function fakeIssueStore(): IssueGateway {
  let seq = 900;
  const issues: Array<{ number: number; url: string; title: string; body: string }> = [];
  return {
    create(title, body) {
      const number = seq++;
      const url = `https://github.com/acme/remudero/issues/${number}`;
      issues.push({ number, url, title, body });
      return url;
    },
    listOpen(): OpenIssue[] {
      return issues.map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body }));
    },
    comment() {
      // not exercised by these tests
    },
  };
}

// ── FORWARD: a superseded red attempt no longer outvotes its own successor ───────────────────

test("W1-T2804: three attempts of one required check whose LATEST is green read green — a superseded red cannot outvote its successor", () => {
  assert.equal(
    ciGateFromRollup([...THREE_ATTEMPTS, CI_GREEN]),
    "green",
    "the 13:49:20 FAILURE is SUPERSEDED by the 13:50:02 SUCCESS on the same sha; only the latest attempt votes",
  );
});

test("W1-T2804: attempt order in the rollup array does not decide the verdict — startedAt does", () => {
  const shuffled = [THREE_ATTEMPTS[2], THREE_ATTEMPTS[0], CI_GREEN, THREE_ATTEMPTS[1]];
  assert.equal(ciGateFromRollup(shuffled), "green", "GitHub may report attempts in any order; the timestamp is the rule");
});

// ── REVERSE: the direction that matters more — a dedupe must not manufacture a green ─────────

test("W1-T2804: genuine red still reds — the LATEST attempt FAILURE reads red even with two older siblings", () => {
  const latestRed = [
    { name: "acceptance-author-gate", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-09-04T13:48:42Z" },
    { name: "acceptance-author-gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-04T13:49:20Z" },
    { name: "acceptance-author-gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-04T13:50:02Z" },
  ];
  assert.equal(ciGateFromRollup([...latestRed, CI_GREEN]), "red", "a dedupe that swallowed this would turn a true red into a MERGING green");
});

test("W1-T2804: genuine red still reds — a single FAILURE with no siblings is not satisfiable by an empty gate", () => {
  assert.equal(ciGateFromRollup([{ name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-04T13:50:02Z" }]), "red");
});

// ── BOUNDARY: the ordering dedupeRollupByLatestAttempt defines, now inherited here ───────────

test("W1-T2804: an entry with NO startedAt sorts OLDER than one that has it — the sibling rule's own boundary", () => {
  const noStamp = { name: "ci", status: "COMPLETED", conclusion: "FAILURE" };
  const stamped = { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-04T13:50:02Z" };
  assert.equal(ciGateFromRollup([noStamp, stamped]), "green", "the stamped SUCCESS is the later attempt");
  assert.equal(ciGateFromRollup([stamped, noStamp]), "green", "…and array position does not change that");
});

// ── THE REQUIRED-CONTEXT FILTER, BOTH DIRECTIONS ────────────────────────────────────────────

test("W1-T2804: a red NON-required context does not make the gate red once the required list is readable", () => {
  const rollup = [CI_GREEN, { name: "optional-scan", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-04T13:50:10Z" }];
  assert.equal(ciGateFromRollup(rollup, ["ci"]), "green", "only branch protection's own required contexts vote");
});

test("W1-T2804: a red REQUIRED context still makes the gate red", () => {
  const rollup = [CI_GREEN, { name: "commitlint", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-04T13:50:10Z" }];
  assert.equal(ciGateFromRollup(rollup, ["ci", "commitlint"]), "red");
});

test("W1-T2804: an UNREADABLE required list fails CLOSED — every reported context counts again, never a manufactured green", () => {
  const rollup = [CI_GREEN, { name: "optional-scan", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-04T13:50:10Z" }];
  // The container PAT gets 403 on the protection endpoint, so this is the COMMON case on this
  // fleet, not an edge one. The degrade is read from `checksStateFromRollup`, not re-decided.
  assert.equal(ciGateFromRollup(rollup, undefined), "red", "no list at all");
  assert.equal(ciGateFromRollup(rollup, []), "red", "an empty list is the same darkness");
});

test("W1-T2804: remudero-review's own pinned status is still excluded unconditionally (W1-T102, the #177 exhaustion)", () => {
  const rollup = [CI_GREEN, { context: "remudero-review", state: "FAILURE", startedAt: "2026-09-04T13:50:10Z" }];
  assert.equal(ciGateFromRollup(rollup), "green");
  assert.equal(ciGateFromRollup(rollup, ["ci", "remudero-review"]), "green", "…even when it appears in the required list");
});

test("W1-T2804: the GREEN verdict is unchanged — it still requires a check named `ci` reporting SUCCESS", () => {
  assert.equal(ciGateFromRollup(THREE_ATTEMPTS), "pending", "nothing red, but no `ci` SUCCESS either — sharing RULES with checksStateFromRollup must not merge the two VERDICTS");
});

// ── shared rule not a fourth filter ─────────────────────────────────────────────────────────

test("W1-T2804: shared rule not a fourth filter — applying dedupeRollupByLatestAttempt to the gate's own input changes no verdict", () => {
  // BEHAVIOURAL, never a source-text read. If the gate had grown a FOURTH hand-rolled filter, it
  // would agree with the shared rule on the easy cases and diverge on exactly the two the shared
  // rule DEFINES: a `startedAt` tie (keep the LAST encountered) and a missing `startedAt` (sorts
  // OLDER). Pre-deduping the input with the shared rule must be a no-op for every one of them.
  const corpora: RollupCheckEntry[][] = [
    [...THREE_ATTEMPTS, CI_GREEN],
    [THREE_ATTEMPTS[2], THREE_ATTEMPTS[0], CI_GREEN, THREE_ATTEMPTS[1]],
    // a tie: same name, same startedAt, LAST encountered wins — so the order decides, and both
    // orders are asserted so a filter that kept the FIRST is caught in one direction or the other.
    [{ name: "ci", conclusion: "FAILURE", startedAt: "2026-09-04T13:50:02Z" }, { name: "ci", conclusion: "SUCCESS", startedAt: "2026-09-04T13:50:02Z" }],
    [{ name: "ci", conclusion: "SUCCESS", startedAt: "2026-09-04T13:50:02Z" }, { name: "ci", conclusion: "FAILURE", startedAt: "2026-09-04T13:50:02Z" }],
    // a missing stamp against a present one, both orders
    [{ name: "ci", conclusion: "FAILURE" }, { name: "ci", conclusion: "SUCCESS", startedAt: "2026-09-04T13:50:02Z" }],
    [{ name: "ci", conclusion: "SUCCESS", startedAt: "2026-09-04T13:50:02Z" }, { name: "ci", conclusion: "FAILURE" }],
  ];
  for (const rollup of corpora) {
    assert.equal(
      ciGateFromRollup(rollup),
      ciGateFromRollup(dedupeRollupByLatestAttempt(rollup)),
      `the gate must already have applied W1-T457's rule, so applying it again is a no-op: ${JSON.stringify(rollup)}`,
    );
  }

  // CONTROL ON THE CORPUS: a plausible WRONG rule (keep the first entry per name) picks a different
  // survivor on the tie and missing-stamp cases, so the assertions above are not vacuous.
  const keepFirst = (rollup: RollupCheckEntry[]): RollupCheckEntry[] => {
    const seen = new Map<string, RollupCheckEntry>();
    for (const c of rollup) if (!seen.has(c.name ?? c.context ?? "")) seen.set(c.name ?? c.context ?? "", c);
    return [...seen.values()];
  };
  const divergent = corpora.filter((r) => ciGateFromRollup(keepFirst(r)) !== ciGateFromRollup(r));
  assert.ok(divergent.length >= 2, `the corpus must contain cases a drifted filter gets WRONG (found ${divergent.length})`);
});

// ── one sha per decision / pinning is not parsing ────────────────────────────────────────────

test("W1-T2804: one sha per decision — the gate reports the head it judged, so the evidence miner can be pinned to that same commit", async () => {
  // The head MOVES after the gate resolves. A reader that resolved its own head afterwards would
  // answer about `sha-two`; the gate's verdict was about `sha-one`, and says so.
  const heads = ["sha-one", "sha-two"];
  let rowReads = 0;
  const readJson = async (args: string[]): Promise<unknown> => {
    const path = args[1];
    if (path === `repos/${OWNER}/${REPO}/pulls/42`) {
      const sha = heads[Math.min(rowReads, heads.length - 1)];
      rowReads++;
      return { number: 42, state: "OPEN", merged: false, merged_at: null, head: { sha } };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/sha-one/check-runs?per_page=100`) {
      return { check_runs: [{ name: "ci", status: "completed", conclusion: "success", started_at: "2026-09-04T13:50:30Z" }] };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/sha-one/status`) return { statuses: [] };
    throw new Error(`unrouted read (a SECOND head resolution would land here): ${JSON.stringify(args)}`);
  };

  const outcome = await waitForCiGreen(PR_URL, () => {}, 6, { readJson, sleep: async () => {} });
  assert.equal(ciGateState(outcome), "green");
  assert.equal(ciGateSha(outcome), "sha-one", "the verdict names the commit it was actually read for, not whatever the head became afterwards");
  assert.equal(rowReads, 1, "the sha is the ALREADY-RESOLVED head — a second read would be a second chance to skew");
});

test("W1-T2804: one sha per decision, END TO END — the round's gate sha reaches the miner and the row that reports their disagreement", async () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const minerCalls: Array<string | undefined> = [];
  const spawnCalls: SpawnWorkerArgs[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2804", title: "pin both CI readers to one sha" }),
    strikeCap: 2,
    initialReview: ciLogInitialReview(),
    ciFailures: [{ name: "ci", logTail: "Error: build failed" }],
    ciEvidenceDisagreement: {
      sha: "sweep-resolved-sha",
      rollup: { checks_state: "red", red_checks: ["ci"] },
      miner: { enumerable_failures: [{ name: "ci" }] },
    },
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      // The gate judged `gate-resolved-sha`. Everything downstream in THIS round must answer
      // about that commit, not re-resolve its own.
      waitForCiGreen: async () => ({ state: "red" as const, sha: "gate-resolved-sha" }),
      fetchCiFailures: async (_prUrl: string, sha?: string) => {
        minerCalls.push(sha);
        return []; // the miner enumerates nothing — the disagreement this rung stands down on
      },
      runReview: async () => {
        throw new Error("must never be reached: ci never goes green");
      },
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "stood_down", "an empty miner still stands the rung down rather than spending a strike on empty evidence");
  assert.deepEqual(minerCalls, ["gate-resolved-sha"], "the miner was PINNED to the sha the round's own gate read judged");

  const rows = logs.filter((l) => l.step === "fix.ci_evidence_disagreement");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extra?.sha, "gate-resolved-sha", "and the row names that one commit, so it claims a shared subject only when there is one");
});

test("W1-T2804: pinning is not parsing — a bare verdict pins nothing and every consumer falls open, exactly as before this task", async () => {
  // Every pre-existing `deps.waitForCiGreen` stub returns a BARE verdict. Recorded behaviourally so
  // a later reader cannot mistake the dedupe above for the whole concern: the parse fix alone
  // leaves the two readers free to answer about two different commits, and does so silently.
  assert.equal(ciGateState("timeout"), "timeout");
  assert.equal(ciGateSha("timeout"), undefined);
  assert.equal(ciGateSha({ state: "red" }), undefined);
  assert.equal(ciGateSha({ state: "red", sha: "abc" }), "abc");

  const minerCalls: Array<string | undefined> = [];
  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2804B", title: "a bare verdict pins nothing" }),
    strikeCap: 2,
    initialReview: ciLogInitialReview(),
    ciFailures: [{ name: "ci", logTail: "Error: build failed" }],
    deps: {
      spawn: async () => result({ sessionId: "fix-session-1" }),
      waitForCiGreen: async () => "red", // the pre-existing shape
      fetchCiFailures: async (_prUrl: string, sha?: string) => {
        minerCalls.push(sha);
        return [];
      },
      runReview: async () => {
        throw new Error("must never be reached: ci never goes green");
      },
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });
  assert.equal(outcome.outcome, "stood_down");
  assert.deepEqual(minerCalls, [undefined], "no sha, so the miner resolves its own head — byte-identical to the behaviour before this task");
});

test("W1-T2804: the sweep-reconstructed dispatch carries the head it already resolved, so round 1 is pinned too", () => {
  const args = buildFixRungDispatchArgs({
    task: { id: "W1-T2804C", title: "the dispatch names its own head" },
    runId: "SWEEP-1730000000000",
    prUrl: PR_URL,
    branch: "run-W1-T2804C-1730000000000",
    worktreePath: "/tmp/rmd-t2804-dispatch-wt",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-t2804-dispatch-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    strikeCap: 2,
    evidence: { unmetCriteria: [], ciFailures: [] },
    pr: { headSha: "cafe1234", checksState: "red", redRequiredChecks: ["ci-gate"] },
    reviewBase: { owner: OWNER, repo: REPO, headCheckoutDir: "/tmp/rmd-t2804-dispatch-wt", reviewerMount: FIX_RUNG_MOUNT },
  });
  assert.equal(args.ciEvidenceDisagreement?.sha, "cafe1234", "the sweep mined its evidence from THIS head — naming it is what makes the shared subject legible");
});
