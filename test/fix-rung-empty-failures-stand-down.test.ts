/**
 * test/fix-rung-empty-failures-stand-down.test.ts — W1-T1282.
 *
 * THE DEFECT (MEASURED on #2641, `docs/repoint-recovered-research`, at HEAD `cd4b110b`). Dispatch
 * decides ci-log mode off `checksState`, composed from the check-run/status rollup — but the fix
 * rung's actual EVIDENCE is `ciFailures`, produced by a SEPARATE miner that pulls an Actions job id
 * out of `detailsUrl`. The two readers can disagree: `checksState` read "red", the rung dispatched
 * TWO bounded ci-log workers, and then escalated as `issues/2653`, whose own "Failing check(s)"
 * section reads, verbatim, "(no evidence — this was checked and is empty)". A rung with nothing to
 * enumerate spent two strikes before saying so, and printed its own emptiness when it finally did.
 *
 * THE FIX. `runFixRung`'s pre-strike gate (the SAME seam `fixRungStandDownReason`'s three
 * ledger-only reasons and W1-T1227's scope gate already occupy) now stands down BEFORE `strikes++`
 * whenever a ci-log round's OWN evidence (`currentCiFailures`) is a REAL, DEFINED, EMPTY array —
 * never when it is `undefined` (that means "no `fetchCiFailures` dep, or one that threw", i.e.
 * failing-check DETAIL is simply unknown, not zero — standing down on that would be fail-CLOSED,
 * which this rung's discipline forbids everywhere else). No new ledger field, no escalation: it
 * ledgers `fix.stood_down` (site `rung.empty_ci_failures`) and returns `outcome: "stood_down"`
 * WITHOUT ever logging `fix.dispatch` — the one ledger step a strike, and `runSweep`'s own
 * dedup-seeding `prior.fixed`, is counted from (sweep.ts's `dispatchFix` closure only flips its
 * `acted` signal on THAT line) — so a refused pass is never mistaken for one that acted.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung } from "../src/run-task.js";
import type { CiFailure } from "../src/lib/sweep.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

function result(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
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
    ...over,
  };
}

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

// A ci-log dispatch's initial verdict is always a placeholder failing verdict with `criteria: []`
// (`buildFixRungDispatchArgs`'s "sweep-reconstructed-ci-log" shape) — never a review-shaped one,
// so this fixture mirrors that rather than an ordinary reviewer-unmet verdict.
function ciLogInitialReview(headSha = "deadbeef"): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state: "failure",
    criteria: [],
    testTheater: false,
    summary: "sweep-reconstructed: required checks red (0 failing check(s)) — ci-log dispatch",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "sweep-reconstructed-ci-log",
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungBaseOpts(task: { id: string; title: string }) {
  return {
    taskId: task.id,
    runId: `${task.id}-1730000000000`,
    task,
    prUrl: "https://github.com/acme/remudero/pull/2641",
    branch: `run-${task.id}-1730000000000`,
    worktreePath: "/tmp/rmd-fixrung-empty-ci-wt",
    initialSessionId: "",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-empty-ci-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-empty-ci-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-empty-ci-")), "ledger.ndjson");
}

function fakeIssueStore(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  let seq = 900;
  const issues: Array<{ number: number; url: string; title: string; body: string; state: string }> = [];
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      const number = seq++;
      const url = `https://github.com/acme/remudero/issues/${number}`;
      issues.push({ number, url, title, body, state: "open" });
      calls.push({ title, body, labels });
      return url;
    },
    listOpen(): OpenIssue[] {
      return issues.filter((i) => i.state === "open").map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body }));
    },
    comment() {
      // not exercised by these tests
    },
  };
}

// ── criteria 1, 2, 4, 5 — zero enumerable failures stands down, never dispatches ────────────────

test("runFixRung (criteria 1/2/4/5): a ci-log round with ZERO enumerable failures stands down BEFORE strike 1 — never spawns a worker, never spends a strike, records a named reason, and never logs fix.dispatch (so the disposition is not deduped away)", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T1282X", title: "fix red required checks" }),
    strikeCap: 3,
    initialReview: ciLogInitialReview(),
    ciFailures: [], // the exact incident shape: checksState red, the miner enumerated nothing
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => {
        throw new Error("must never be reached — no strike should ever be dispatched");
      },
      push: () => {
        throw new Error("must never be reached — no strike should ever push");
      },
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 0, "no fix worker is ever spawned");
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 0, "no strike consumed");
  assert.match(outcome.standDownReason ?? "", /zero enumerable/i, "names the reason");
  assert.match(outcome.standDownReason ?? "", /nothing to hand/);

  const stoodDown = logs.filter((l) => l.step === "fix.stood_down");
  assert.equal(stoodDown.length, 1, "the stand-down is ledgered, not silent");
  assert.equal(stoodDown[0].extra?.site, "rung.empty_ci_failures");
  assert.equal(stoodDown[0].extra?.strike, 1, "named as the strike that was about to be spent");
  assert.match(String(stoodDown[0].extra?.reason ?? ""), /zero enumerable/i);

  const dispatched = logs.filter((l) => l.step === "fix.dispatch");
  assert.equal(dispatched.length, 0, "fix.dispatch — the one step a strike/acted signal is counted from — is never logged");
});

test("runFixRung (criterion 2): the stand-down escalates NOTHING and rewrites NOTHING — it only ledgers and says, mirroring the terminal-state/mergeConflictCheck reasons beside it", async () => {
  const issues = fakeIssueStore();
  let updatePrBodyCalls = 0;
  const sayLines: string[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T1282Y", title: "fix red required checks" }),
    strikeCap: 3,
    initialReview: ciLogInitialReview(),
    ciFailures: [],
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "green",
      runReview: async () => {
        throw new Error("must never be reached");
      },
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: (msg) => sayLines.push(msg),
      account: (r) => r,
      updatePrBody: async () => {
        updatePrBodyCalls++;
      },
    },
  });

  assert.equal(outcome.outcome, "stood_down");
  assert.equal(issues.calls.length, 0, "no needs-human issue is opened for this reason");
  assert.equal(updatePrBodyCalls, 0, "the stand-down never rewrites the PR body");
  assert.ok(sayLines.some((m) => /standing down/.test(m) && /zero enumerable/i.test(m)), "the operator narration names the reason too");
});

// ── criterion 3 — a rung that DOES have enumerable failures dispatches exactly as before ────────

test("runFixRung (criterion 3): a ci-log round with a NON-EMPTY ciFailures set dispatches exactly as before this guard existed", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const failures: CiFailure[] = [{ name: "ci", logTail: "Error: build failed" }, { name: "ci-gate", logTail: "required check failed" }];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T1282Z", title: "fix red required checks" }),
    strikeCap: 3,
    initialReview: ciLogInitialReview(),
    ciFailures: failures,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({
        ...ciLogInitialReview("sha-1"),
        state: "success",
        criteria: [criterion({ claim: "required checks are green", met: true })],
      }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 1, "the strike is dispatched normally — the guard never blocks real evidence");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 1);
  assert.equal(logs.filter((l) => l.step === "fix.stood_down" && l.extra?.site === "rung.empty_ci_failures").length, 0);
  assert.equal(logs.filter((l) => l.step === "fix.dispatch").length, 1, "the real strike is still counted");
});

test("runFixRung: an UNKNOWN failing-check detail (no fetchCiFailures dep — currentCiFailures stays undefined) never stands down — fails OPEN, exactly like every other pre-strike check in this rung", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T1282W", title: "fix red required checks" }),
    strikeCap: 1,
    initialReview: {
      state: "failure",
      criteria: [criterion({ claim: "some criterion", met: false, reason: "unmet" })],
      testTheater: false,
      summary: "unmet criteria",
      floorDegraded: false,
      capped: false,
      keywordOnly: false,
      planOnly: false,
      headSha: "deadbeef",
      reviewerOutcome: "success",
    },
    // No `ciFailures:` at all — an ordinary blocked_review dispatch, `noReviewYet` false the whole
    // way through, so this guard's `noReviewYet` gate never even opens.
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({
        state: "success",
        criteria: [criterion({ claim: "some criterion", met: true })],
        testTheater: false,
        summary: "all criteria met",
        floorDegraded: false,
        capped: false,
        keywordOnly: false,
        planOnly: false,
        headSha: "sha-1",
        reviewerOutcome: "success",
      }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 1, "the ordinary review-mode strike dispatches — this guard is scoped to ci-log mode only");
  assert.equal(outcome.outcome, "fixed");
});

// ── mid-rung recurrence: the split can reappear after a strike, not only on round 1 ─────────────

test("runFixRung: the split recurring MID-RUNG (round 1 has real evidence and strikes; the refreshed miner then enumerates nothing while checks stay non-green) stands round 2 down instead of striking blind", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T1282V", title: "fix red required checks" }),
    strikeCap: 3,
    initialReview: ciLogInitialReview(),
    ciFailures: [{ name: "ci", logTail: "boom" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      // Checks never go green — every round refreshes ci-log evidence rather than reaching review.
      waitForCiGreen: async () => "red",
      runReview: async () => {
        throw new Error("must never be reached — CI never goes green in this fixture");
      },
      // Round 1's strike refreshes the evidence to EMPTY — the same split, discovered mid-rung.
      fetchCiFailures: async () => [],
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 1, "exactly ONE strike — round 1's; round 2 never dispatches");
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 1, "strikes never incremented past round 1");
  assert.match(outcome.standDownReason ?? "", /zero enumerable/i);

  const stoodDown = logs.filter((l) => l.step === "fix.stood_down" && l.extra?.site === "rung.empty_ci_failures");
  assert.equal(stoodDown.length, 1);
  assert.equal(stoodDown[0].extra?.strike, 2, "named as the strike that was about to be spent");
});
