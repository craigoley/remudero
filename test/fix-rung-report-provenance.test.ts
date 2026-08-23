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
 * (2026-07-24). A second path it never covered, not a regression on the one it did.
 *
 * THE FIX IS THE FLAG, NOT THE DETECTOR. `bodyContradictsDiff` is untouched and narrative text is
 * not exempted from it — a narrative that IS the body must still be scored. The body fetch is NOT
 * widened to the other three modes either: that would spend a GraphQL call per strike on a bucket
 * this repo has already run to 0/5000 in a day, to fetch a document those modes do not need.
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

import { runFixRung } from "../src/run-task.js";
import { judgeReview } from "../src/lib/review.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
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
      ...(over.fetchPrBody ? { fetchPrBody: over.fetchPrBody } : {}),
      ...(over.fetchPrDiffFiles ? { fetchPrDiffFiles: over.fetchPrDiffFiles } : {}),
      ...(over.updatePrBody ? { updatePrBody: over.updatePrBody } : {}),
    },
  });
  assert.ok(captured, "the rung must have run a re-review — otherwise nothing below is measured");
  return captured;
}

// ── criterion 1 ───────────────────────────────────────────────────────────────────────────────

test("criterion 1: a mode that never fetches the PR body marks its report a substitute, so the changeset check is skipped rather than scored against worker prose", async () => {
  const got = await reviewArgsFrom({ unmet: OTHER_UNMET, narrative: NARRATIVE_WITH_SHORTHAND });
  assert.equal(got.reportIsSubstitute, true, "reviewer-unmet never fetches a body — the report is the worker's narrative");
  assert.match(got.report, /plan-only/, "and it really is the narrative, not a body: the shorthand is present in what was handed over");
});

test("criterion 1 (the flag is not merely present): the SAME narrative reaches judgeReview and produces no changeset contradiction", async () => {
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
