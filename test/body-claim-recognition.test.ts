/**
 * test/body-claim-recognition.test.ts — W1-T1264.
 *
 * THE DEFECT. Every arm of `bodyContradictsDiff` (lib/review.ts) fires only on one literal
 * token shape — `exactly … file(s)`, a bare `no <path>`, an anchored shorthand — so a claim's
 * TRUTH and its RECOGNITION are independent facts. A body that says "exactly one file: a.ts" over
 * a genuinely one-file diff and a body that never mentions its changeset at all both report
 * `changesetContradictions: []` — the SAME silent zero, with nothing on the author's side able to
 * tell "checked, and it agrees" apart from "never read a claim at all".
 *
 * THE FIX (design (i)-(iv)). `recognizeChangesetClaims` computes everything `bodyContradictsDiff`
 * always has, PLUS `recognisedCount` (how many claim-shaped tokens passed an arm's own subject
 * anchor, whether they agreed with the diff or not) and `fenceUnbalancedAtEof` (whether the
 * quote-stripping pass reached end-of-body still inside an open fence, which silently starves that
 * count). `bodyContradictsDiff` itself is UNCHANGED — a thin wrapper around the same engine — so
 * every existing caller/fixture keeps its exact behavior (acceptance 6). `judgeReview` carries the
 * two new numbers on `ReviewVerdict`; `runFixRung` (run-task.ts) logs the identical count at its
 * own call site, so BOTH consumers reach the surface an author actually reads (design (iii)).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { bodyContradictsDiff, recognizeChangesetClaims, judgeReview, CHANGESET_CLAIM_FALSIFIER_NOTE } from "../src/lib/review.js";
import { runFixRung } from "../src/run-task.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";

// ── fixtures shared across this file ────────────────────────────────────────

const CRITERIA: AcceptanceCriterion[] = [{ claim: "a report was filed", proof: "report" }];
const RESPONSIVE_REPORT = `
REPORT
The fix lands in the diff below.
PR_URL: https://github.com/o/r/pull/1
`.trim();

const ONE_FILE_DIFF = `
diff --git a/a.ts b/a.ts
+++ b/a.ts
@@
+export function a() {}
`.trim();
const ONE_FILE_DIFF_FILES = ["a.ts"];

const TWO_FILE_DIFF = `
diff --git a/a.ts b/a.ts
+++ b/a.ts
@@
+export function a() {}
diff --git a/b.ts b/b.ts
+++ b/b.ts
@@
+export function b() {}
`.trim();
const TWO_FILE_DIFF_FILES = ["a.ts", "b.ts"];

// ── acceptance 1: the gate reports a RECOGNISED count, not only a contradicted one ─────────────

test("recognizeChangesetClaims (acceptance 1): a false 'exactly N files' claim is BOTH recognised AND contradictory — the count is not merely a re-derivation of contradictions.length", () => {
  const body = "This PR touches exactly two files.";
  const recognition = recognizeChangesetClaims(body, ONE_FILE_DIFF_FILES); // diff has 1 file, claim says 2
  assert.equal(recognition.recognisedCount, 1, "the claim shape was read — a fact bodyContradictsDiff's [] alone cannot report");
  assert.equal(recognition.contradictions.length, 1, "and it disagreed with the diff");
  assert.deepEqual(
    recognition.contradictions,
    bodyContradictsDiff(body, ONE_FILE_DIFF_FILES),
    "recognizeChangesetClaims must never disagree with bodyContradictsDiff — same engine, strictly additive",
  );
});

test("recognizeChangesetClaims (acceptance 1): a body with TWO claims — one recognised-and-true, one recognised-and-false — counts BOTH as recognised even though only one becomes a contradiction", () => {
  const body = "This PR touches exactly two files: a.ts, test/a.test.ts. No test/ changes.";
  const recognition = recognizeChangesetClaims(body, ["a.ts", "test/a.test.ts"]);
  assert.equal(recognition.recognisedCount, 2, "both the count claim and the 'no test/' claim were read");
  assert.equal(recognition.contradictions.length, 1, "only the 'no test/' claim disagrees — test/a.test.ts IS in the diff, so the count claim (2 of 2, correctly named) is TRUE");
});

// ── acceptance 2: a recognised-and-consistent claim is distinguishable from no claim at all ────

test("recognizeChangesetClaims (acceptance 2): a TRUE 'exactly one file' claim and a body with no changeset claim both score zero contradictions, but only recognisedCount tells them apart", () => {
  const agreeing = recognizeChangesetClaims("This PR touches exactly one file: a.ts.", ONE_FILE_DIFF_FILES);
  const noClaim = recognizeChangesetClaims("Just some prose about the change, nothing countable here.", ONE_FILE_DIFF_FILES);

  assert.deepEqual(agreeing.contradictions, [], "a true claim is never a contradiction");
  assert.deepEqual(noClaim.contradictions, [], "no claim at all is also never a contradiction — both print [] today");

  assert.equal(agreeing.recognisedCount, 1, "checked, and it agrees");
  assert.equal(noClaim.recognisedCount, 0, "never read a claim at all");
  assert.notEqual(
    agreeing.recognisedCount,
    noClaim.recognisedCount,
    "the two zero-contradiction bodies must be distinguishable by SOMETHING — that something is recognisedCount",
  );
});

// ── acceptance 3: a count claim phrased without the literal adverb is reported as unrecognised ─

test("recognizeChangesetClaims (acceptance 3): 'This PR changes 7 files.' (no 'exactly') is UNRECOGNISED — even though it is genuinely false against a 1-file diff, nothing here widens the arm to catch it", () => {
  const body = "This PR changes 7 files.";
  const recognition = recognizeChangesetClaims(body, ONE_FILE_DIFF_FILES);
  assert.equal(recognition.recognisedCount, 0, "the literal 'exactly' adverb is what countRe requires — silence without it");
  assert.deepEqual(recognition.contradictions, [], "unrecognised, so never a contradiction either — refused by design (v)");
});

// ── acceptance 4: an absence claim phrased as a sentence is reported as unrecognised ────────────

test("recognizeChangesetClaims (acceptance 4): 'This PR touches no plan/ files.' — the sentence form — is UNRECOGNISED (rationale (3): an ordinary word right after the token reads as a compound-noun modifier, not the claim), even though the diff's only file genuinely IS under plan/", () => {
  const body = "This PR touches no plan/ files.";
  const recognition = recognizeChangesetClaims(body, ["plan/tasks.yaml"]); // the claim IS false
  assert.equal(recognition.recognisedCount, 0, "the sentence form is not one of the recognised claim shapes");
  assert.deepEqual(recognition.contradictions, []);
});

test("recognizeChangesetClaims: the SAME token as a bare label — 'No plan/.' — IS recognised (control, unchanged arm behaviour)", () => {
  const recognition = recognizeChangesetClaims("No plan/.", ["plan/tasks.yaml"]);
  assert.equal(recognition.recognisedCount, 1, "punctuation right after the token ends the claim — the token IS the claim");
  assert.equal(recognition.contradictions.length, 1);
});

// ── acceptance 5: a body whose fence never closes is NAMED, not silently blanked ────────────────

test("recognizeChangesetClaims (acceptance 5): an unbalanced fence is NAMED via fenceUnbalancedAtEof, and the claim it swallows is reported as UNRECOGNISED rather than as a silent 'no contradiction'", () => {
  const body = "```\nThis PR touches exactly one file: a.ts\n";
  const recognition = recognizeChangesetClaims(body, TWO_FILE_DIFF_FILES); // genuinely false if read: 2 files, not 1
  assert.equal(recognition.fenceUnbalancedAtEof, true, "the fence state must be reported as still open at EOF");
  assert.equal(recognition.recognisedCount, 0, "the claim inside the unclosed fence is blanked — but now the caller can tell WHY");
  assert.deepEqual(recognition.contradictions, []);
});

test("recognizeChangesetClaims: a body whose fence DOES close is not flagged, and its claim is read normally (control for acceptance 5)", () => {
  const body = "```\nsome code sample\n```\nThis PR touches exactly one file: a.ts";
  const recognition = recognizeChangesetClaims(body, ONE_FILE_DIFF_FILES);
  assert.equal(recognition.fenceUnbalancedAtEof, false);
  assert.equal(recognition.recognisedCount, 1);
  assert.deepEqual(recognition.contradictions, []);
});

test("recognizeChangesetClaims: a body with NO fence at all is never flagged (control)", () => {
  const recognition = recognizeChangesetClaims("Plain prose, no code fences anywhere.", ONE_FILE_DIFF_FILES);
  assert.equal(recognition.fenceUnbalancedAtEof, false);
});

// ── acceptance 6: every arm still fails a PR exactly when it fails one today ────────────────────

test("bodyContradictsDiff (acceptance 6 — regression): unchanged in shape and behaviour — recognizeChangesetClaims is strictly additive, never a widened or narrowed arm", () => {
  // #974's shape: still caught.
  assert.ok(
    bodyContradictsDiff("exactly one file: MASTER-PLAN.md. No src/, no test/, no docs/ORIENTATION.md.", [
      "MASTER-PLAN.md",
      "plan/tasks.yaml",
      "docs/ORIENTATION.md",
    ]).length >= 2,
  );
  // #1025's shape: still caught.
  assert.ok(bodyContradictsDiff("data-only: no code.", ["src/lib/a.ts", "test/a.test.ts"]).length > 0);
  // A truthful count claim: still silent.
  assert.deepEqual(bodyContradictsDiff("This PR touches exactly two files.", TWO_FILE_DIFF_FILES), []);
  // No changeset claim at all: still silent.
  assert.deepEqual(bodyContradictsDiff("Just prose about the fix.", ONE_FILE_DIFF_FILES), []);
  // "no bugs" — a bare English word, not a path: still silent (never widened to natural language).
  assert.deepEqual(bodyContradictsDiff("This change introduces no bugs.", ["src/lib/a.ts"]), []);
  // An unanchored count with no changeset word: still silent (the #1077 false-positive fix).
  assert.deepEqual(bodyContradictsDiff("Each unit-test proof resolves to exactly one file.", TWO_FILE_DIFF_FILES), []);
});

test("judgeReview (acceptance 6 — regression): a false changeset claim still FORCES state=failure exactly as before, and now ALSO carries changesetClaimsRecognised", () => {
  const body = `${RESPONSIVE_REPORT}\n\nThis PR touches exactly one file: a.ts.`;
  const v = judgeReview(CRITERIA, { diff: TWO_FILE_DIFF, report: body });
  assert.equal(v.state, "failure");
  assert.equal(v.floorState, "failure");
  assert.ok(v.changesetContradictions && v.changesetContradictions.length > 0);
  assert.equal(v.changesetClaimsRecognised, 1, "the false claim was recognised, not merely contradicted");
});

test("judgeReview: a TRUE 'exactly one file' claim over a genuinely one-file diff PASSES, with changesetContradictions empty AND changesetClaimsRecognised = 1 — 'checked, and it agrees' now legible on the verdict itself", () => {
  const body = `${RESPONSIVE_REPORT}\n\nThis PR touches exactly one file: a.ts.`;
  const v = judgeReview(CRITERIA, { diff: ONE_FILE_DIFF, report: body });
  assert.equal(v.state, "success", v.summary);
  assert.deepEqual(v.changesetContradictions, []);
  assert.equal(v.changesetClaimsRecognised, 1);
});

test("judgeReview: a body making NO changeset claim also passes, but changesetClaimsRecognised is 0 — the two zero-contradiction PASSES are now distinguishable on the verdict", () => {
  const v = judgeReview(CRITERIA, { diff: ONE_FILE_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(v.state, "success");
  assert.deepEqual(v.changesetContradictions, []);
  assert.equal(v.changesetClaimsRecognised, 0);
});

test("judgeReview: on a substitute report the whole check — including the new recognition fields — is WITHHELD (undefined), never a manufactured 0/false, mirroring changesetContradictions' own withholding", () => {
  const v = judgeReview(CRITERIA, { diff: ONE_FILE_DIFF, report: "no code.", reportIsSubstitute: true });
  assert.deepEqual(v.changesetContradictions, []);
  assert.equal(v.changesetClaimsRecognised, undefined);
  assert.equal(v.changesetFenceUnbalancedAtEof, undefined);
});

// ── acceptance 7: the falsifier technique is stated where an author meets the gate ──────────────

test("CHANGESET_CLAIM_FALSIFIER_NOTE (acceptance 7): the falsifier technique from rationale (6) is exported and explains the actual technique — reword into a deliberately false variant and re-run", () => {
  assert.match(CHANGESET_CLAIM_FALSIFIER_NOTE, /deliberately false/i);
  assert.match(CHANGESET_CLAIM_FALSIFIER_NOTE, /reword/i);
  assert.match(CHANGESET_CLAIM_FALSIFIER_NOTE, /recognis/i);
});

test("CHANGESET_CLAIM_FALSIFIER_NOTE (acceptance 7): stated BESIDE the gate — declared in the same source neighbourhood as recognizeChangesetClaims/bodyContradictsDiff, not off in a separate doc file an author debugging the detector would never open", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/review.ts", import.meta.url)), "utf8");
  const noteIdx = src.indexOf("export const CHANGESET_CLAIM_FALSIFIER_NOTE");
  const recognizeIdx = src.indexOf("export function recognizeChangesetClaims(");
  const bodyContradictsIdx = src.indexOf("export function bodyContradictsDiff(");
  assert.ok(noteIdx > 0, "CHANGESET_CLAIM_FALSIFIER_NOTE must be declared in lib/review.ts");
  assert.ok(recognizeIdx > 0, "recognizeChangesetClaims must be declared in lib/review.ts");
  assert.ok(bodyContradictsIdx > 0, "bodyContradictsDiff must be declared in lib/review.ts");
  assert.ok(
    Math.abs(noteIdx - bodyContradictsIdx) < 2000,
    `the falsifier note (offset ${noteIdx}) must sit within the same doc neighbourhood as the gate it explains ` +
      `(bodyContradictsDiff at ${bodyContradictsIdx}) — not buried pages away`,
  );
});

// ── design (iii): BOTH consumers carry the count — the run-task.ts (fix rung) half ─────────────

function workerResult(over: Partial<WorkerResult> = {}): WorkerResult {
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

function criterionVerdict(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
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
    taskId: "W1-T1264X",
    runId: "W1-T1264X-1730000000000",
    task: { id: "W1-T1264X", title: "Some task" },
    prUrl: "https://github.com/acme/remudero/pull/1264",
    branch: "run-W1-T1264X-1730000000000",
    worktreePath: "/tmp/rmd-fixrung-claimrecognition-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-claimrecognition-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: {
      owner: "acme",
      repo: "remudero",
      headCheckoutDir: "/tmp/rmd-fixrung-claimrecognition-wt",
      reviewerMount: FIX_RUNG_MOUNT,
    },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-claimrecognition-")), "ledger.ndjson");
}

function fakeIssues(): IssueGateway {
  return {
    create() {
      return "https://github.com/acme/remudero/issues/9";
    },
  };
}

test("runFixRung (design (iii) — 'both consumers carry it'): the fix rung logs the changeset-claims-recognised count at ITS OWN call site, before deriveChangesetClaimUpdate ever runs — not only inside judgeReview's later verdict object", async () => {
  const failing = fakeReview("failure", [
    criterionVerdict({ claim: "criterion A is covered", met: false, reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)" }),
  ]);
  const passing = fakeReview("success", [criterionVerdict({ claim: "criterion A is covered", met: true })]);
  const STALE_BODY = "This PR touches exactly 4 files: `a.ts`, `b.ts`, `c.ts`, `d.ts`.\n\nRemudero-Task: W1-T1264X\n";
  const CURRENT_DIFF_FILES = ["a.ts", "b.ts", "c.ts", "d.ts", "e.test.ts"];

  const logs: Array<{ step: string; fields: unknown }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    deps: {
      spawn: async () => workerResult({ sessionId: "fix-1", text: "committed the missing coverage test" }),
      waitForCiGreen: async () => "green",
      fetchPrBody: async () => STALE_BODY,
      fetchPrDiffFiles: async () => CURRENT_DIFF_FILES,
      updatePrBody: async () => {},
      runReview: async (args) => (args.report.includes("exactly 5 files") ? passing : failing),
      push: () => {},
      issues: fakeIssues(),
      ledgerPath: tmpLedgerPath(),
      log: (step, fields) => logs.push({ step, fields }),
      say: () => {},
      account: (r) => r,
    },
  });

  const recognitionLog = logs.find((l) => l.step === "fix.body_claim_recognition");
  assert.ok(recognitionLog, "the fix rung must log its own recognition count independently of judgeReview's verdict");
  assert.deepEqual(
    recognitionLog?.fields,
    { strike: 1, recognised: 1, contradictions: 1, fence_unbalanced_at_eof: false },
    "the STALE_BODY's 'exactly 4 files' claim is recognised (1) and, against the CURRENT 5-file diff, contradictory (1)",
  );
  assert.equal(outcome.outcome, "fixed", "the count is observability only — the repair still lands exactly as before");
});

test("runFixRung: a body with no changeset claim at all logs recognised: 0 alongside contradictions: 0 — the fix rung's own log distinguishes silence from agreement too", async () => {
  const failing = fakeReview("failure", [
    criterionVerdict({ claim: "criterion A is covered", met: false, reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)" }),
  ]);
  const passing = fakeReview("success", [criterionVerdict({ claim: "criterion A is covered", met: true })]);
  const PLAIN_BODY = "## Summary\nAdds the missing coverage test.\n\nRemudero-Task: W1-T1264X\n";

  const logs: Array<{ step: string; fields: unknown }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: failing,
    deps: {
      spawn: async () => workerResult({ sessionId: "fix-1" }),
      waitForCiGreen: async () => "green",
      fetchPrBody: async () => PLAIN_BODY,
      fetchPrDiffFiles: async () => ["a.ts", "b.ts", "new.test.ts"],
      updatePrBody: async () => {},
      runReview: async () => passing,
      push: () => {},
      issues: fakeIssues(),
      ledgerPath: tmpLedgerPath(),
      log: (step, fields) => logs.push({ step, fields }),
      say: () => {},
      account: (r) => r,
    },
  });

  const recognitionLog = logs.find((l) => l.step === "fix.body_claim_recognition");
  assert.ok(recognitionLog);
  assert.deepEqual(recognitionLog?.fields, { strike: 1, recognised: 0, contradictions: 0, fence_unbalanced_at_eof: false });
  assert.equal(outcome.outcome, "fixed");
});
