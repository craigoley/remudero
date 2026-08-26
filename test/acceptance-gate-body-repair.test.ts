/**
 * test/acceptance-gate-body-repair.test.ts — W1-T2272.
 *
 * THE DEFECT (MEASURED 2026-08-25 on PR #2797 and #2831). `acceptance-author-gate`
 * (scripts/acceptance-author-gate.mjs, reusing `acceptanceAuthorTimeCheck`, src/lib/review.ts)
 * already refuses a PR with a TYPED defect name — `no-header`, `no-trailer`, `unparseable`,
 * `empty-proofs` — and the fix rung already owns a head-preserving body write (`updatePrBody`,
 * `gh pr edit --body`, W1-T307). But that arm fires only for a STALE CHANGESET CLAIM, and only
 * AFTER a strike has already committed something — a PR whose ONLY defect is its body has nothing
 * for that arm to react to, so #2797 (`no-header`) and #2831 (`empty-proofs`) were repaired by an
 * operator's own `gh pr edit`, by hand, at zero CI cost — exactly what an automated repair should
 * have done first.
 *
 * THE FIX. `acceptanceGateBodyRepair` (pure, run-task.ts) re-runs the gate's OWN predicate against
 * the LIVE PR body and, for the two structurally-repairable defects (`no-header`/`empty-proofs`),
 * returns a body `ensureJudgeableBody` (lib/plan-pr-emitter.ts, the SAME instrument W1-T394's retro
 * repair already uses) has made judgeable again — never a guess at the author's intent, never a
 * second predicate. `runFixRung`'s pre-strike gate (site `rung.strike`, BEFORE any commit) calls it
 * on every round; when it returns a repair, `updatePrBody` writes it, the strike counter moves
 * exactly as an ordinary strike would, and the round loops back WITHOUT ever spawning a worker or
 * pushing a commit.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung, acceptanceGateBodyRepair } from "../src/run-task.js";
import { acceptanceAuthorTimeCheck } from "../src/lib/review.js";
import type { CiFailure } from "../src/lib/sweep.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

// ── Fixtures, byte-identical in shape to the ones review.ts's own tests already lock ───────────

/** No `## Acceptance`/`Acceptance:` header and no `Remudero-Task:` trailer anywhere. */
const NO_HEADER_BODY = "This PR fixes the thing.\n\nSee the diff for details.\n";

/** A header, one bullet, no `|` and no `proof:` continuation — the claim has nothing to execute. */
const EMPTY_PROOFS_BODY = "Acceptance:\n- a claim with no proof written anywhere\n";

/** Byte-identical in shape to test/acceptance-author-gate.test.ts's own WRAPPED_BODY — a claim
 *  wrapped onto a second line truncates the block: written 3, parsed 1, empty proof, `unparseable`
 *  — NOT the same shape `bodyNeedsAcceptanceRepair` reliably catches (design note i). */
const WRAPPED_BODY = `## Acceptance

- claim: a claim long enough that an author wrapped it onto
  a second line for readability
  proof: unit test: test/foo.test.ts
- claim: the second criterion
  proof: unit test: test/bar.test.ts
- claim: the third criterion
  proof: unit test: test/baz.test.ts
`;

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

function fakeReview(
  state: "success" | "failure",
  criteria: CriterionVerdict[],
  headSha = "deadbeef",
): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungBaseOpts() {
  return {
    taskId: "PR-2272",
    runId: "PR-2272-1730000000000",
    task: { id: "PR-2272", title: "PR #2272" },
    prUrl: "https://github.com/acme/remudero/pull/2272",
    branch: "fix/some-descriptive-branch",
    worktreePath: "/tmp/rmd-fixrung-gate-body-repair-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-gate-body-repair-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-gate-body-repair-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-gate-body-repair-")), "ledger.ndjson");
}

function fakeIssueStore(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  let seq = 3000;
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
    comment() {},
  };
}

const AUTHOR_GATE_CI_FAILURE: CiFailure = { name: "acceptance-author-gate", logTail: "REFUSED (no-header)" };

// ── acceptanceGateBodyRepair — the pure decision boundary (criteria 2, 3) ──────────────────────

test("acceptanceGateBodyRepair: a no-header body is repaired, and the repaired body re-checks ok:true", () => {
  const repair = acceptanceGateBodyRepair(NO_HEADER_BODY);
  assert.ok(repair, "no-header must be repaired");
  assert.equal(repair!.defect, "no-header");
  const recheck = acceptanceAuthorTimeCheck(repair!.repairedBody);
  assert.equal(recheck.ok, true, "the repaired body must itself pass the SAME gate predicate");
});

test("acceptanceGateBodyRepair: an empty-proofs body is repaired, and the repaired body re-checks ok:true", () => {
  const repair = acceptanceGateBodyRepair(EMPTY_PROOFS_BODY);
  assert.ok(repair, "empty-proofs must be repaired");
  assert.equal(repair!.defect, "empty-proofs");
  const recheck = acceptanceAuthorTimeCheck(repair!.repairedBody);
  assert.equal(recheck.ok, true, "the repaired body must itself pass the SAME gate predicate");
});

test("acceptanceGateBodyRepair: an unparseable (wrapped-claim) body is left alone — undefined, never attempted", () => {
  // Sanity: this really is the defect this fixture produces, from the SAME predicate the repair
  // itself consults — never a guess at what WRAPPED_BODY's shape happens to be.
  assert.equal(acceptanceAuthorTimeCheck(WRAPPED_BODY).defect, "unparseable");
  assert.equal(acceptanceGateBodyRepair(WRAPPED_BODY), undefined);
});

test("acceptanceGateBodyRepair: a body that is already judgeable (ok:true) is left alone — undefined", () => {
  const healthy = "## Acceptance\n\n- the thing works | unit test: test/thing.test.ts\n";
  assert.equal(acceptanceAuthorTimeCheck(healthy).ok, true);
  assert.equal(acceptanceGateBodyRepair(healthy), undefined);
});

test("acceptanceGateBodyRepair: no-trailer is structurally unreachable from this general-shape call — " +
  "it only ever arises when acceptanceAuthorTimeCheck is called WITH an expectedTaskId, which this repair never supplies", () => {
  // A body carrying ANY trailer (even one naming a different id) short-circuits the general-shape
  // check to ok:true BEFORE it ever inspects the body's own Acceptance block — so `no-trailer` can
  // never be the `.defect` this repair observes, matching design note i's own claim.
  const mistrailered = "Some prose.\n\nRemudero-Task: SOME-OTHER-ID\n";
  assert.equal(acceptanceAuthorTimeCheck(mistrailered).ok, true);
  assert.equal(acceptanceGateBodyRepair(mistrailered), undefined);
});

test("acceptanceGateBodyRepair: the fallback claim never asserts the underlying diff or any task's acceptance is met (Q2's boundary)", () => {
  const repair = acceptanceGateBodyRepair(NO_HEADER_BODY);
  assert.ok(repair);
  assert.match(
    repair!.repairedBody,
    /not a claim that the underlying diff is correct, or that any task's acceptance is met/,
    "the appended claim must disclaim task-acceptance credit in its own text",
  );
});

// ── runFixRung, wired end to end ────────────────────────────────────────────────────────────────

test("runFixRung (acceptance 1): a no-header refusal is repaired with a body-only write — no worker spawned, no commit pushed, head sha unmoved", async () => {
  const noReviewYet = fakeReview("failure", [], "original-head-sha");
  const spawnCalls: SpawnWorkerArgs[] = [];
  const pushCalls: Array<{ wt: string; branch: string }> = [];
  const updateCalls: Array<{ prUrl: string; body: string }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: noReviewYet,
    ciFailures: [AUTHOR_GATE_CI_FAILURE],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "should-never-run" });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [AUTHOR_GATE_CI_FAILURE],
      fetchPrBody: async () => NO_HEADER_BODY,
      updatePrBody: async (prUrl, body) => {
        updateCalls.push({ prUrl, body });
      },
      runReview: async () => noReviewYet,
      push: (wt, branch) => {
        pushCalls.push({ wt, branch });
      },
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(updateCalls.length, 1, "the defect must be repaired exactly once");
  assert.equal(updateCalls[0].prUrl, "https://github.com/acme/remudero/pull/2272");
  assert.equal(acceptanceAuthorTimeCheck(updateCalls[0].body).ok, true, "the written body must itself be judgeable");

  assert.equal(spawnCalls.length, 0, "a body-only repair must never spawn a fix worker");
  assert.equal(pushCalls.length, 0, "a body-only repair must never push a commit");
  assert.equal(outcome.review.headSha, "original-head-sha", "the head sha the rung reports is never advanced by a body repair");
  assert.equal(outcome.strikes, 1);
});

test("runFixRung (acceptance 2): the repair is dispatched from the gate's own defect name, not any inspection of the body's prose — an unrelated-looking body with the SAME structural defect still repairs", async () => {
  // A body about something entirely different, but still headerless/trailerless — the repair
  // must fire on the STRUCTURAL defect (no-header), never on keywords in the prose.
  const unrelatedBody = "Bumps a transitive dependency to patch a CVE. No behavior change intended.\n";
  assert.equal(acceptanceAuthorTimeCheck(unrelatedBody).defect, "no-header");

  const noReviewYet = fakeReview("failure", []);
  const updateCalls: string[] = [];
  const spawnCalls: SpawnWorkerArgs[] = [];

  await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: noReviewYet,
    ciFailures: [AUTHOR_GATE_CI_FAILURE],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "should-never-run" });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [AUTHOR_GATE_CI_FAILURE],
      fetchPrBody: async () => unrelatedBody,
      updatePrBody: async (_prUrl, body) => {
        updateCalls.push(body);
      },
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(updateCalls.length, 1);
  assert.equal(spawnCalls.length, 0);
});

test("runFixRung (acceptance 3): a defect the rung cannot repair deterministically (unparseable) falls through to the ordinary strike, and updatePrBody is never called", async () => {
  const failing = fakeReview("failure", []);
  const passing = fakeReview("success", [], "new-head-sha");
  const updateCalls: string[] = [];
  const spawnCalls: SpawnWorkerArgs[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    ciFailures: [{ name: "acceptance-author-gate", logTail: "REFUSED (unparseable)" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-1", text: "rewrapped the claim onto one line" });
      },
      waitForCiGreen: async () => "green",
      fetchCiFailures: async () => [{ name: "acceptance-author-gate", logTail: "REFUSED (unparseable)" }],
      fetchPrBody: async () => WRAPPED_BODY,
      updatePrBody: async (_prUrl, body) => {
        updateCalls.push(body);
      },
      runReview: async () => passing,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(updateCalls.length, 0, "an unparseable defect must never be mechanically 'repaired' — it needs a real reformat");
  assert.equal(spawnCalls.length, 1, "the ordinary strike still dispatches for whatever else the round evidences");
  assert.equal(outcome.outcome, "fixed");
});

test("runFixRung (acceptance 4): a repaired body is never recorded as satisfying any task's acceptance — the fix.dispatch line carries no criteria credit, and the review verdict is left exactly as it was", async () => {
  const failing = fakeReview("failure", [criterion({ claim: "some real criterion", met: false })], "same-head-sha");
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: failing,
    ciFailures: [AUTHOR_GATE_CI_FAILURE],
    deps: {
      spawn: async () => result({ sessionId: "should-never-run" }),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [AUTHOR_GATE_CI_FAILURE],
      fetchPrBody: async () => NO_HEADER_BODY,
      updatePrBody: async () => {},
      runReview: async () => failing,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  const dispatchLines = logs.filter((l) => l.step === "fix.dispatch");
  assert.equal(dispatchLines.length, 1);
  assert.equal(dispatchLines[0].extra?.mode, "body-repair");
  assert.equal(dispatchLines[0].extra?.unmet_count, 0, "never counted against the task's own unmet criteria");
  assert.equal(outcome.review.state, "failure", "the underlying verdict is never rewritten to success by a body repair");
  assert.equal(outcome.review.headSha, "same-head-sha");
});

test("runFixRung (acceptance 5): the strike ceiling counts a body repair exactly as it counts any other attempt — a strikeCap of 1 is exhausted BY the repair alone", async () => {
  const noReviewYet = fakeReview("failure", []);
  const spawnCalls: SpawnWorkerArgs[] = [];
  const updateCalls: string[] = [];
  const issues = fakeIssueStore();

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: noReviewYet,
    ciFailures: [AUTHOR_GATE_CI_FAILURE],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "should-never-run" });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [AUTHOR_GATE_CI_FAILURE],
      fetchPrBody: async () => NO_HEADER_BODY,
      updatePrBody: async (_prUrl, body) => {
        updateCalls.push(body);
      },
      runReview: async () => noReviewYet,
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(updateCalls.length, 1, "the cap allows exactly ONE attempt, and the repair spent it");
  assert.equal(spawnCalls.length, 0, "no budget left for a real strike once the cap is spent on the repair");
  assert.equal(outcome.strikes, 1);
  assert.equal(outcome.outcome, "escalated", "the cap's own exhaustion path fires exactly as it would after any other attempt");
  assert.equal(issues.calls.length, 1);
});

test("runFixRung (acceptance 6): an unchanged tree still stands the rung down after a body repair — the SECOND round never repeats the write", async () => {
  const noReviewYet = fakeReview("failure", []);
  const spawnCalls: SpawnWorkerArgs[] = [];
  const updateCalls: string[] = [];
  const unchangedSnapshot = { status: "", diff: "", untrackedHash: "h1" };

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 3,
    initialReview: noReviewYet,
    ciFailures: [AUTHOR_GATE_CI_FAILURE],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "should-never-run" });
      },
      // The SAME check keeps failing every round — a mock `gh` that never actually persisted the
      // edit, or GitHub simply not having re-evaluated it yet. Either way, the LOCAL worktree is
      // what this task's own criterion is about, and it genuinely never changes.
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [AUTHOR_GATE_CI_FAILURE],
      fetchPrBody: async () => NO_HEADER_BODY,
      updatePrBody: async (_prUrl, body) => {
        updateCalls.push(body);
      },
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      captureWorktreeSnapshot: async () => unchangedSnapshot,
    },
  });

  assert.equal(updateCalls.length, 1, "the write happens ONCE — the next round's unchanged-tree gate refuses before a repeat");
  assert.equal(spawnCalls.length, 0);
  assert.equal(outcome.strikes, 1);
  assert.equal(outcome.outcome, "stood_down");
  assert.match(outcome.standDownReason ?? "", /byte-identical/);
});

test("runFixRung (acceptance 7, fail-open): a live-body fetch that throws is never treated as a repairable defect — no write is attempted, and the round still reaches the ordinary strike", async () => {
  const failing = fakeReview("failure", []);
  const passing = fakeReview("success", [], "new-head-sha");
  const updateCalls: string[] = [];
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    ciFailures: [AUTHOR_GATE_CI_FAILURE],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-1", text: "fixed whatever else the round evidenced" });
      },
      waitForCiGreen: async () => "green",
      fetchCiFailures: async () => [AUTHOR_GATE_CI_FAILURE],
      fetchPrBody: async () => {
        throw new Error("gh api rate-limited");
      },
      updatePrBody: async (_prUrl, body) => {
        updateCalls.push(body);
      },
      runReview: async () => passing,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  const errorLines = logs.filter((l) => l.step === "fix.body_gate_check_error");
  assert.equal(errorLines.length, 1, "a throwing fetch is ledgered, never silently swallowed");
  assert.equal(updateCalls.length, 0, "with no live body, there is nothing to repair");
  assert.equal(spawnCalls.length, 1, "the ordinary strike still dispatches for whatever else the round evidences");
  assert.equal(outcome.outcome, "fixed");
});

test("runFixRung (acceptance 8, fail-open): a body write that throws mid-repair falls through to the ordinary strike instead of blocking the rung", async () => {
  const failing = fakeReview("failure", []);
  const passing = fakeReview("success", [], "new-head-sha");
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let updateAttempts = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    ciFailures: [AUTHOR_GATE_CI_FAILURE],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-1", text: "fixed whatever else the round evidenced" });
      },
      waitForCiGreen: async () => "green",
      fetchCiFailures: async () => [AUTHOR_GATE_CI_FAILURE],
      fetchPrBody: async () => NO_HEADER_BODY,
      updatePrBody: async () => {
        updateAttempts += 1;
        throw new Error("gh pr edit failed: 502");
      },
      runReview: async () => passing,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  const errorLines = logs.filter((l) => l.step === "fix.body_gate_repair_error");
  assert.equal(errorLines.length, 1, "a throwing write is ledgered, never silently swallowed");
  assert.equal(errorLines[0].extra?.strike, 1);
  assert.equal(updateAttempts, 1, "exactly one write is attempted before falling through");
  assert.equal(spawnCalls.length, 1, "a failed write never blocks the ordinary strike from still running");
  assert.equal(outcome.outcome, "fixed");
});
