/**
 * test/fix-rung-report-provenance.test.ts — W1-T1254.
 *
 * THE DEFECT (MEASURED 2026-08-23 on #2569). `runFixRung` passed `report: reviewReport` into its
 * re-review and set no `reportIsSubstitute`. `reviewReport` is initialised from the WORKER'S OWN
 * narrative, and the real PR body is fetched only under `if (fixMode === "body-coverage")` — so
 * `reviewer-unmet`, `ci-log` and `merge-conflict` all handed the reviewer prose that was never a
 * claim about the changeset. `judgeReview` skips `bodyContradictsDiff` ONLY when it is told the
 * report is a substitute, so the detector — which is correct on the input it is given — scored the
 * worker's own sentences and failed the PR on a claim the body never made. The author could not
 * clear it: the verdict is write-once per head sha, and the document being corrected was not the
 * one being read. On #2569 the stored body scored ZERO contradictions against the real diff (with
 * false controls firing on the same bytes) while the branch's narrative scored two and reproduced
 * the posted verdict verbatim.
 *
 * W1-T1100 (#2415) introduced `reportIsSubstitute` and guarded both consumers; NONE of its
 * `run-task.ts` hunks reached this call site, whose `report:` line still blames to #762
 * (2026-07-24). W1-T3501 closes that second path: every fix mode now reads the live PR body;
 * only an unavailable body falls back to worker prose and keeps the substitute flag set.
 *
 * THE FIX IS THE FLAG, NOT THE DETECTOR. `bodyContradictsDiff` is untouched and narrative text is
 * not exempted from it — a narrative that IS the body must still be scored. The body fetch is
 * intentionally widened to every mode because the authoritative reviewer judges the PR body, not
 * the worker transcript. The fetch remains best-effort and a failure is explicit.
 *
 * WHY THE SECOND HALF OF THE LAST TEST MATTERS. "No contradiction is produced" passes trivially if
 * the check were disabled outright, so the same shorthand is also driven through `judgeReview` as a
 * REAL body and must still contradict. Without that half the first half proves nothing.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveFixRungTaskContractAtHead, runFixRung } from "../src/run-task.js";
import { judgeReview } from "../src/lib/review.js";
import type { CriterionVerdict, PlanCriteriaAtHeadResult, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";

/** A worker narrative that DOES contradict the two-file diff below — the #2569 shape verbatim in
 *  kind: ordinary prose describing the job, which `bodyContradictsDiff` reads as a changeset claim. */
const NARRATIVE_WITH_SHORTHAND =
  "Reworded the ambiguous phrasing rather than asserting plan-only of this PR — no code change; " +
  "the diff already satisfies every acceptance criterion.";

const PR_DIFF = [
  "diff --git a/src/run-task.ts b/src/run-task.ts",
  "--- a/src/run-task.ts",
  "+++ b/src/run-task.ts",
  "@@ -1,1 +1,2 @@",
  " const a = 1;",
  "+const b = 2;",
  "diff --git a/test/fix-rung-report-provenance.test.ts b/test/fix-rung-report-provenance.test.ts",
  "--- a/test/fix-rung-report-provenance.test.ts",
  "+++ b/test/fix-rung-report-provenance.test.ts",
  "@@ -0,0 +1,1 @@",
  "+import assert from 'node:assert/strict';",
].join("\n");

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

function verdict(state: "success" | "failure", criteria: CriterionVerdict[], headSha = "deadbeef"): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
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

/** Unmet-criterion shapes that select each mode, per FIX_MODE_RULES. */
const KEYWORD_UNMET = criterion({ claim: "c", met: false, reason: "matched 1/3 proof keywords" });
const OTHER_UNMET = criterion({ claim: "c", met: false, reason: "not close enough" });

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function issueStore(): IssueGateway {
  return { create: () => "https://github.com/acme/remudero/issues/1", listOpen: (): OpenIssue[] => [], comment: () => {} };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-provenance-")), "ledger.ndjson");
}

/** Drive ONE strike of the fix rung and return exactly what it handed the reviewer. The review it
 *  returns is a PASS, so the loop stops after a single strike. */
async function reviewArgsFrom(over: {
  unmet: CriterionVerdict;
  narrative: string;
  fetchPrBody?: (prUrl: string) => Promise<string>;
  fetchPrDiffFiles?: (prUrl: string) => Promise<string[]>;
  updatePrBody?: (prUrl: string, body: string) => Promise<void>;
}): Promise<{ report: string; reportIsSubstitute?: boolean }> {
  let captured: { report: string; reportIsSubstitute?: boolean } | undefined;
  await runFixRung({
    taskId: "W1-T1254X",
    runId: "W1-T1254X-1730000000000",
    task: { id: "W1-T1254X", title: "thread the report-provenance flag", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/1",
    branch: "run-W1-T1254X-1730000000000",
    worktreePath: "/tmp/rmd-fixrung-provenance-wt",
    initialSessionId: "session-0",
    mount: MOUNT,
    settingsFile: "/tmp/rmd-fixrung-provenance-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-provenance-wt", reviewerMount: MOUNT },
    strikeCap: 2,
    initialReview: verdict("failure", [over.unmet]),
    deps: {
      spawn: async () => result({ text: over.narrative }),
      waitForCiGreen: async () => "green",
      runReview: async (args) => {
        captured = { report: args.report, reportIsSubstitute: args.reportIsSubstitute };
        return { ...verdict("success", [criterion({ claim: "c", met: true })]), headSha: "sha-1" };
      },
      push: () => {},
      issues: issueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      fetchPrBody: over.fetchPrBody ?? (async () => {
        throw new Error("gh unavailable");
      }),
      ...(over.fetchPrDiffFiles ? { fetchPrDiffFiles: over.fetchPrDiffFiles } : {}),
      ...(over.updatePrBody ? { updatePrBody: over.updatePrBody } : {}),
    },
  });
  assert.ok(captured, "the rung must have run a re-review — otherwise nothing below is measured");
  return captured;
}

// ── criterion 1 ───────────────────────────────────────────────────────────────────────────────

test("criterion 1: reviewer-unmet fetches the live PR body and marks it as authoritative", async () => {
  const body = "## Summary\n\nThis PR body is authoritative.\n";
  const got = await reviewArgsFrom({
    unmet: OTHER_UNMET,
    narrative: NARRATIVE_WITH_SHORTHAND,
    fetchPrBody: async () => body,
  });
  assert.equal(got.reportIsSubstitute, false, "a successful body read is authoritative in every fix mode");
  assert.equal(got.report, body, "the reviewer receives the current body, not worker prose");
});

test("criterion 1 (substitute fallback): worker prose produces no changeset contradiction when the body fetch fails", async () => {
  const got = await reviewArgsFrom({ unmet: OTHER_UNMET, narrative: NARRATIVE_WITH_SHORTHAND });
  const v = judgeReview([{ claim: "c", proof: "unit test: test/fix-rung-report-provenance.test.ts" }], {
    diff: PR_DIFF,
    report: got.report,
    reportIsSubstitute: got.reportIsSubstitute,
  });
  assert.deepEqual(v.changesetContradictions ?? [], [], "a narrative is not a claim about the changeset");
});

// ── criterion 2 ───────────────────────────────────────────────────────────────────────────────

test("criterion 2: a successful body-coverage fetch marks the report NOT a substitute, so a real body is still scored exactly as it is today", async () => {
  const body = "## Summary\n\nThis PR touches src/run-task.ts and its test.\n";
  const got = await reviewArgsFrom({
    unmet: KEYWORD_UNMET,
    narrative: NARRATIVE_WITH_SHORTHAND,
    fetchPrBody: async () => body,
    fetchPrDiffFiles: async () => ["src/run-task.ts", "test/fix-rung-report-provenance.test.ts"],
  });
  assert.equal(got.reportIsSubstitute, false, "the report IS the body — it must be judged as one");
  assert.equal(got.report, body, "and it is the fetched body, not the worker's narrative");
});

// ── criterion 3 ───────────────────────────────────────────────────────────────────────────────

test("criterion 3: a body fetch that THROWS leaves the report marked a substitute rather than falling through as though a body had been read", async () => {
  const got = await reviewArgsFrom({
    unmet: KEYWORD_UNMET,
    narrative: NARRATIVE_WITH_SHORTHAND,
    fetchPrBody: async () => {
      throw new Error("gh outage");
    },
    fetchPrDiffFiles: async () => ["src/run-task.ts"],
  });
  assert.equal(got.reportIsSubstitute, true, "no body was read, so nothing may be judged as one");
  assert.match(got.report, /plan-only/, "the report fell back to the worker narrative, which is exactly why the flag must stay true");
});

// ── criterion 4 ───────────────────────────────────────────────────────────────────────────────

test("criterion 4: when the changeset-claim update replaces the report with a body it just WROTE, the report is marked NOT a substitute so that strike is still scored", async () => {
  const stale = "## Summary\n\nThis PR touches exactly 1 file: `src/run-task.ts`.\n";
  const written: string[] = [];
  const got = await reviewArgsFrom({
    unmet: KEYWORD_UNMET,
    narrative: NARRATIVE_WITH_SHORTHAND,
    fetchPrBody: async () => stale,
    fetchPrDiffFiles: async () => ["src/run-task.ts", "test/fix-rung-report-provenance.test.ts"],
    updatePrBody: async (_url, b) => {
      written.push(b);
    },
  });
  assert.equal(written.length, 1, "the stale claim was rewritten — otherwise this test is not exercising the arm it names");
  assert.equal(got.report, written[0], "the report is the body this strike just wrote");
  assert.equal(got.reportIsSubstitute, false, "a body the rung itself authored is still a body, and must be scored");
});

// ── criterion 5 — BOTH WAYS ───────────────────────────────────────────────────────────────────

test("criterion 5: worker narrative with changeset shorthand produces no contradiction through the fix rung, while the SAME shorthand in a real body still does", async () => {
  const asNarrative = await reviewArgsFrom({ unmet: OTHER_UNMET, narrative: NARRATIVE_WITH_SHORTHAND });
  const criteria = [{ claim: "c", proof: "unit test: test/fix-rung-report-provenance.test.ts" }];

  const quiet = judgeReview(criteria, { diff: PR_DIFF, report: asNarrative.report, reportIsSubstitute: asNarrative.reportIsSubstitute });
  assert.deepEqual(quiet.changesetContradictions ?? [], [], "narrative: the check is withheld, not manufactured");

  // THE HALF THAT STOPS THE FIRST PASSING FOR THE WRONG REASON. Identical text, identical diff —
  // only the provenance differs. If the fix had disabled the detector rather than informed it,
  // this would come back empty too.
  const loud = judgeReview(criteria, { diff: PR_DIFF, report: asNarrative.report, reportIsSubstitute: false });
  assert.ok((loud.changesetContradictions ?? []).length > 0, "same bytes as a BODY must still contradict the diff — the detector is untouched");
  assert.ok(
    (loud.changesetContradictions ?? []).some((c) => /plan-only|no code/.test(c.claim)),
    "and it contradicts on the shorthand itself, not on something incidental",
  );
});

// ── W1-T3557 ─────────────────────────────────────────────────────────────────────────────────
//
// THE DEFECT (OBSERVED 2026-09-14, daemon run DAEMON-1789351932540). `runFixRung` passes
// `task: opts.task` — the task snapshot captured once at sweep admission — straight into
// `deps.runReview`, which reads `task.acceptance`/`task.files` directly. A plan split or scope
// amendment landing on the PR head AFTER this rung was dispatched (the W1-T3545 shape) leaves
// `opts.task` answering a SUPERSEDED contract: the terminal verdict judges criteria the plan no
// longer declares. `rmd review` does not have this defect — it re-resolves via
// `resolvePlanCriteriaAtHead` at the PR's actual head before judging. These two tests drive the
// fix rung's own re-resolution of the SAME contract at the SAME kind of boundary.

/** A fresh refreshed-contract fixture, distinguishable from the stale `opts.task` shape every
 *  helper below hands it — a different claim text and a different file list, so a test that reads
 *  the STALE ones back is caught rather than passing on overlap. */
function refreshedContract(over: Partial<PlanCriteriaAtHeadResult> = {}): PlanCriteriaAtHeadResult {
  return {
    criteria: [{ claim: "the head-resolved criterion", proof: "unit test: refreshed" }],
    taskId: "W1-T3557X",
    taskDeclaredFiles: ["src/run-task.ts", "test/fix-rung-report-provenance.test.ts"],
    source: "plan at headsha task W1-T3557X (1 criteria)",
    ...over,
  };
}

/** The shape `deps.runReview` actually receives its `task` argument as (run-task.ts's own
 *  `runReview` param type) — reproduced narrowly here so this test file need not import it. */
interface CapturedReviewTask {
  id: string;
  acceptance?: { claim: string; proof: string }[];
  files?: string[];
}

/** Drive ONE strike of the fix rung, capturing whatever `task` reached `deps.runReview` (or
 *  `undefined` if it was never called) alongside the rung's own terminal outcome — both needed to
 *  tell "refreshed and passed through" apart from "refused before the reviewer ever ran". */
async function runContractRefreshRung(over: {
  resolveTaskContractAtHead?: (
    prUrl: string,
    taskId: string,
  ) => PlanCriteriaAtHeadResult | undefined | Promise<PlanCriteriaAtHeadResult | undefined>;
}): Promise<{
  reviewedTask: CapturedReviewTask | undefined;
  reviewCalled: boolean;
  outcome: string;
  reason: string;
}> {
  let reviewCalled = false;
  let reviewedTask: CapturedReviewTask | undefined;
  const staleTask = {
    id: "W1-T3557X",
    title: "the sweep-start snapshot, stale by the time this rung re-reviews",
    // Six criteria, standing in for the pre-split contract the note describes — deliberately
    // disjoint from `refreshedContract()`'s one criterion so the two can never be confused.
    acceptance: Array.from({ length: 6 }, (_, i) => ({ claim: `stale criterion ${i}`, proof: "stale proof" })),
    files: ["src/stale-only-file.ts"],
  };
  const rung = await runFixRung({
    taskId: "W1-T3557X",
    runId: "W1-T3557X-1730000000000",
    task: staleTask,
    prUrl: "https://github.com/acme/remudero/pull/2",
    branch: "run-W1-T3557X-1730000000000",
    worktreePath: "/tmp/rmd-fixrung-contract-wt",
    initialSessionId: "session-0",
    mount: MOUNT,
    settingsFile: "/tmp/rmd-fixrung-contract-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-contract-wt", reviewerMount: MOUNT },
    strikeCap: 2,
    initialReview: verdict("failure", [OTHER_UNMET]),
    deps: {
      spawn: async () => result({ text: NARRATIVE_WITH_SHORTHAND }),
      waitForCiGreen: async () => "green",
      runReview: async (args) => {
        reviewCalled = true;
        reviewedTask = args.task;
        return { ...verdict("success", [criterion({ claim: "c", met: true })]), headSha: "sha-1" };
      },
      push: () => {},
      issues: issueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      ...(over.resolveTaskContractAtHead ? { resolveTaskContractAtHead: over.resolveTaskContractAtHead } : {}),
    },
  });
  return { reviewedTask, reviewCalled, outcome: rung.outcome, reason: rung.reason };
}

test("W1-T3557 criterion 1: a fix-rung re-review refreshes its task contract at the current PR head", async () => {
  let resolveArgs: { prUrl: string; taskId: string } | undefined;
  const got = await runContractRefreshRung({
    resolveTaskContractAtHead: (prUrl, taskId) => {
      resolveArgs = { prUrl, taskId };
      return refreshedContract();
    },
  });
  assert.ok(got.reviewCalled, "the reviewer must still run once a readable head contract resolves");
  assert.deepEqual(
    resolveArgs,
    { prUrl: "https://github.com/acme/remudero/pull/2", taskId: "W1-T3557X" },
    "the resolver is asked about THIS PR and THIS task, not some other identity",
  );
  assert.deepEqual(
    got.reviewedTask?.acceptance,
    refreshedContract().criteria,
    "the reviewer receives the HEAD-resolved criteria, not opts.task's six-criterion sweep-start snapshot",
  );
  assert.deepEqual(
    got.reviewedTask?.files,
    refreshedContract().taskDeclaredFiles,
    "the reviewer also receives the HEAD-resolved declared files, not opts.task's stale one-file list",
  );
});

test("W1-T3557 criterion 2: a fix-rung re-review refuses an unreadable current task contract without replaying stale criteria", async () => {
  const got = await runContractRefreshRung({
    resolveTaskContractAtHead: () => ({
      criteria: [],
      taskId: "W1-T3557X",
      divergence: { taskId: "W1-T3557X", reason: "duplicate id W1-T3557X in plan/tasks.yaml", cause: "readable-object" },
    }),
  });
  assert.equal(got.reviewCalled, false, "an unreadable head contract must never reach the reviewer at all");
  assert.equal(got.outcome, "stood_down", "the rung stands down rather than fabricating or reusing a contract");
  assert.match(got.reason, /unreadable/, "the stand-down reason names the unreadable-contract cause, not a generic failure");
});

test("W1-T3557 criterion 2 (the OTHER unreadable shape): a resolver that throws also refuses rather than falling back to opts.task", async () => {
  const got = await runContractRefreshRung({
    resolveTaskContractAtHead: () => {
      throw new Error("gh outage resolving plan at head");
    },
  });
  assert.equal(got.reviewCalled, false, "a throwing resolver is exactly as unreadable as one returning a divergence");
  assert.equal(got.outcome, "stood_down");
  assert.match(got.reason, /unreadable/);
});

test("W1-T3557: resolveFixRungTaskContractAtHead's production wiring returns undefined (not a thrown error) when reading the PR's live head sha fails", () => {
  // Exercises the production seam directly rather than through a mocked deps override — this is
  // the ONE call site that decides "unreadable" for the caller above, so its own throw-to-undefined
  // boundary needs a test that cannot pass by mocking the boundary away.
  const got = resolveFixRungTaskContractAtHead(
    "https://github.com/acme/remudero/pull/2",
    "W1-T3557X",
    "/tmp/rmd-fixrung-contract-wt",
    () => {
      throw new Error("rate-limited reading head sha over REST");
    },
  );
  assert.equal(got, undefined, "an unreadable head sha must surface as undefined, the same 'unreadable' shape the fix rung's stand-down arm checks for");
});
