// W1-T13849: a reviewer FAIL names its class. (a) the change does not do what the claim says on the claim's own
// input, (c) it breaks behaviour outside the claim: both fail the criterion exactly as before. (b) a counterexample
// beyond the claim's stated inputs is a follow-up finding, not a FAIL. An untagged FAIL is held once, then folds as
// before. The fixtures replay recorded clauses of 2026-11-19 (core ledger union, review.posted rows).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import * as reviewCommand from "#src/cli/commands/review.js";
import { appendLedger } from "#src/lib/ledger.js";
import * as outcomeClass from "#src/lib/review-outcome-class.js";
import * as review from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

type Criterion = { claim: string; proof: string };

// W1-T12176 #19650, 13:12Z, criterion 2 (gpt-6.2-sol): every proof executed and passed; the clause is beyond the claim.
const W1_T12176: Criterion = {
  claim: "A service with no running process, a last exit code that is not zero and more than three starts fails the check. The line names the label, the count of starts and the last line of its error log",
  proof: "grep: W1-T12176 criterion 2 in test/deploy/doctor-names-a-launchd-service-whose-start-fails-again-and-again.test.ts",
};
const W1_T12176_CLAUSE = "The named test passes. A read-only replay with a valid final log line containing a crash cause followed by 16 KiB of spaces produced “error log unavailable or empty.” The reader discards the start of the final line before applying the report’s length cap, so the failure names the label and count but loses the cause.";
// W1-T13785 #19691, 14:45Z, criterion 1: the claim's own input never reaches the claimed result.
const W1_T13785: Criterion = {
  claim: "rmd approve of a public task the composition holds, while the ops catalog reads ok, handed a plan and as the host runs it, exits 1 with the held message and releases nothing",
  proof: "grep: W1-T13785 criterion 1 in test/an-operator-verdict-releases-a-parked-task.test.ts",
};
const W1_T13785_CLAUSE = "The named test passes by expecting a loader exception for a public task naming an ops ID and its dependant. Both approve entry points stop before composition, so neither case returns the held message or writes the required public-digest refusal row. The test also expects zero refusal rows for duplicate holds on the working-tree fallback.";
// W1-T13709 #19531, 01:31Z, criterion 3: a previously passing suite is now red.
const W1_T13709: Criterion = {
  claim: "invariant:a-served-list-is-guarded-at-act — a pass with any scope but boot that decides from a served list acts as a pass on the last good list does: each acting head is read at act time, a head that moved stands down as sweep.head_moved, and a direct merge names the list's head",
  proof: "grep: W1-T13709 criterion 3 in test/sweep/an-idle-light-pass-decides-from-the-tick-reads-open-pr-views.test.ts",
};
const W1_T13709_CLAUSE = "The named criterion 3 tests pass, but the widened file test/sweep/a-light-pass-decides-from-its-last-good-open-pr-list-when-the-read-fails.test.ts now fails at line 243 (\"W1-T12755 criterion 3\", rerun alone, same result). The PR changed it to `hook(IDLE)` but kept the control `armImpls == [undefined]` (\"a pass on a fresh list arms as today\"). An idle served list now acts as last-good, so `armImpl` is defined. Update that control, or the PR leaves a previously passing test red.";

const CODE_DIFF = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+export const changed = true;\n`;
const ORIGIN_MAIN_NOTE = "reviewer judged the proof non-responsive (semantic downgrade)";

/** judgeReview over one criterion whose proof the injected executor answers, with the reviewer text supplied. */
function judged(t: TestContext, criterion: Criterion, transcript: string | undefined, opts: { exec?: "pass" | "fail"; diff?: string } = {}) {
  const dir = ownedFixtureDir(t, "semantic-downgrade-class").dir;
  const report = `${criterion.claim}\n${criterion.proof}`;
  return review.judgeReview([criterion], {
    diff: opts.diff ?? CODE_DIFF("src/changed.ts"), report,
    ...(opts.exec === undefined ? {} : { headCheckoutDir: dir, execProof: () => opts.exec! }),
    ...(transcript === undefined ? {} : {
      semantic: review.parseReviewerVerdicts(transcript, 1),
      semanticClauses: review.parseReviewerVerdictClauses(transcript, 1),
      reviewerUnable: review.parseReviewerUnable(transcript, 1),
    }),
    ...(opts.diff?.includes("plan/") ? { planLint: { ran: true, label: "lint-plan", checked: 1, violations: [] } } : {}),
  });
}

function reviewFixtureHost(head: string): reviewCommand.ReviewCommandHost {
  const unrelatedHostPort = (): never => { throw new Error("unexpected unrelated orchestration port"); };
  return {
    GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
    acceptedReviewAttemptId: value => typeof value === "string" ? value : undefined, attributeWorkerStreamEvent: unrelatedHostPort,
    ledgeredNonDispatchSpawn: unrelatedHostPort, lintPlanForReview: unrelatedHostPort,
    liveWorkerRunIds: new Set(), materializeReviewWorktree: unrelatedHostPort,
    readHeadShaRest: () => head, readMainPlanTreeSha: unrelatedHostPort,
    realDeps: () => ({ reviewWorktree: { fetch: unrelatedHostPort } }) as unknown as ReturnType<reviewCommand.ReviewCommandHost["realDeps"]>,
    reviewPostedDescription: verdict => verdict.summary,
    reviewWorkerLockId: runId => runId,
    reviewerClockBoundMs: override => override!,
    reviewSubjectGit: unrelatedHostPort,
  };
}

const MOUNTS = {
  sonnet: { provider: "claude", model: "sonnet", served: "claude-sonnet-5-5" },
  sol: { provider: "codex", model: "gpt-6.2-sol", served: "gpt-6.2-sol" },
} as const;

/** The production review command over a real checkout whose grep proof executes and passes. */
function reviewFixture(t: TestContext, criterion: Criterion) {
  const repo = gitRepo({ scope: t, kind: "semantic-downgrade-review" });
  const target = criterion.proof.replace(/^grep: .* in /, "");
  const marker = criterion.proof.replace(/^grep: (.*) in .*$/, "$1");
  mkdirSync(join(repo.dir, dirname(target)), { recursive: true });
  writeFileSync(join(repo.dir, target), `test("${marker}", () => {});\n`);
  repo.git("add", ".");
  repo.git("commit", "-qm", "fixture proof");
  const head = repo.git("rev-parse", "HEAD");
  const prUrl = "https://github.com/acme/remudero/pull/1";
  const shim = ghShim([
    { when: "pulls/1/reviews", stdout: "[]" },
    { when: "pulls/1", stdout: JSON.stringify({ number: 1, html_url: prUrl, state: "open", merged_at: null, head: { ref: "b", sha: head } }) },
    { when: "pr diff", stdout: CODE_DIFF(target) },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "/statuses?", stdout: "[[]]" },
    { when: "/status", stdout: '{"statuses":[]}' },
    { when: "api ", stdout: "{}" },
  ], { kind: "semantic-downgrade-review" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  const prompts: string[] = [];
  const drive = async (transcript: string, opts: { mount?: keyof typeof MOUNTS; ledger?: string; headRefName?: string } = {}) => {
    const mount = MOUNTS[opts.mount ?? "sol"];
    const ledgerPath = join(repo.dir, opts.ledger ?? "ledger.ndjson");
    const runId = `semantic-downgrade-${prompts.length}`;
    const verdict = await reviewCommand.runReview(reviewFixtureHost(head), {
      owner: "acme", repo: "remudero", prUrl, ...(opts.headRefName ? { headRefName: opts.headRefName } : {}),
      task: { id: "W1-T13849", files: [target], acceptance: [criterion] },
      report: `${criterion.claim}\n${criterion.proof}`, settingsFile: join(repo.dir, "settings.json"),
      config: { root: repo.dir, claudeBin: "/unused" },
      log: (step: string, extra: Record<string, unknown> = {}) => appendLedger(ledgerPath, { run_id: runId, task_id: "W1-T13849", step, ...extra }),
      say: () => {}, account: (worker: unknown) => worker, spawnReviewer: true, readReviewReuseFacts: () => undefined,
      runtimeImageSha: null,
      reviewerSpawnWorker: async (args: { prompt: string }) => {
        prompts.push(args.prompt);
        return {
          sessionId: "semantic-downgrade", costUsd: 0, numTurns: 1, text: transcript,
          blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, exit: { kind: "exit", code: 0 },
          permissionDenials: [], childEnvKeys: [], model: mount.model, provider: mount.provider, servedModel: mount.served,
          effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
          qualitySuspect: false,
        };
      },
      reviewerMount: { model: mount.model, provider: mount.provider, effort: "high", maxTurns: 10, contextBudget: 120_000 },
      reviewerClockBoundMs: 120_000, headCheckoutDir: repo.dir, ledgerPath, runId,
      disarm: () => "not-armed", arm: () => ({ armed: false, reason: "fixture" }),
    } as never);
    return { verdict, rows: readLedgerLines(ledgerPath) };
  };
  return { drive, prompts, shim, head };
}

/** The posted review comment: the shim logs argv joined by spaces, so a multi-line body spans log lines. */
const reviewBodies = (shim: ReturnType<typeof ghShim>) => {
  const log = shim.calls().join("\n");
  const start = log.indexOf("pulls/1/reviews -f body=");
  return start < 0 ? "" : log.slice(start);
};

test("W1-T13849 criterion 1: a (b) FAIL beyond the claim leaves an executed_pass criterion met and becomes a follow-up finding", async (t) => {
  const { drive, shim } = reviewFixture(t, W1_T12176);
  const { verdict, rows } = await drive(`REVIEW_VERDICT 1: FAIL (b) ${W1_T12176_CLAUSE}`);
  assert.equal(verdict.criteria[0]!.proof_exec, "executed_pass", verdict.criteria[0]!.reason);
  assert.equal(verdict.criteria[0]!.met, true, verdict.criteria[0]!.reason);
  assert.equal(verdict.state, "success", verdict.summary);
  assert.equal(verdict.verdictWithheld, undefined);
  const followUps = rows.filter(row => row.step === "review.follow_up_finding");
  assert.equal(followUps.length, 1, JSON.stringify(rows.map(row => row.step)));
  assert.equal(followUps[0]!.criterion, 1);
  assert.equal(followUps[0]!.model, "gpt-6.2-sol");
  assert.equal(followUps[0]!.provider, "codex");
  assert.equal(followUps[0]!.clause, W1_T12176_CLAUSE);
  assert.equal(followUps[0]!.head_sha, verdict.headSha);
  const posted = rows.find(row => row.step === "review.posted");
  assert.equal(posted?.state, "success");
  const body = reviewBodies(shim);
  assert.match(body, /Follow-up findings/);
  assert.ok(body.includes("16 KiB of spaces"), body);
});

test("W1-T13849 criterion 1: a REVIEW_FOLLOW_UP line beside a PASS is recorded and listed, and changes no verdict", async (t) => {
  const { drive, shim } = reviewFixture(t, W1_T12176);
  const { verdict, rows } = await drive(`REVIEW_VERDICT 1: PASS\nREVIEW_FOLLOW_UP 1: ${W1_T12176_CLAUSE}`);
  assert.equal(verdict.state, "success");
  const followUps = rows.filter(row => row.step === "review.follow_up_finding");
  assert.deepEqual(followUps.map(row => [row.criterion, row.clause, row.model]), [[1, W1_T12176_CLAUSE, "gpt-6.2-sol"]]);
  assert.ok(reviewBodies(shim).includes("16 KiB of spaces"));
});

test("W1-T13849 criterion 2: an (a) FAIL and a (c) FAIL fail the criterion with origin/main's reason text and state", (t) => {
  for (const [criterion, tag, clause] of [[W1_T13785, "a", W1_T13785_CLAUSE], [W1_T13709, "c", W1_T13709_CLAUSE]] as const) {
    const floor = judged(t, criterion, undefined, { exec: "pass" });
    assert.equal(floor.state, "success", "the floor alone passes this criterion");
    const verdict = judged(t, criterion, `REVIEW_VERDICT 1: FAIL (${tag}) ${clause}`, { exec: "pass" });
    const untaggedOnMain = `${floor.criteria[0]!.reason} — NOTE: ${ORIGIN_MAIN_NOTE}: ${clause}`;
    assert.equal(verdict.state, "failure", tag);
    assert.equal(verdict.criteria[0]!.met, false, tag);
    assert.equal(verdict.criteria[0]!.reason, untaggedOnMain, tag);
    assert.equal(verdict.criteria[0]!.downgrade_class, tag);
    assert.equal(verdict.criteria[0]!.followUp, undefined);
  }
});

test("W1-T13849 criterion 2: an (a) FAIL through the production review posts failure on its first attempt", async (t) => {
  const { drive } = reviewFixture(t, W1_T13785);
  const { verdict, rows } = await drive(`REVIEW_VERDICT 1: FAIL (a) ${W1_T13785_CLAUSE}`);
  assert.equal(verdict.verdictWithheld, undefined);
  assert.equal(verdict.state, "failure");
  assert.ok(verdict.criteria[0]!.reason.endsWith(`— NOTE: ${ORIGIN_MAIN_NOTE}: ${W1_T13785_CLAUSE}`), verdict.criteria[0]!.reason);
  assert.equal(rows.filter(row => row.step === "review.semantic_incomplete").length, 0);
  assert.equal(rows.filter(row => row.step === "review.follow_up_finding").length, 0);
});

test("W1-T13849 criterion 3: an untagged FAIL on an executed_pass criterion is withheld once, then fails as on origin/main", async (t) => {
  const { drive } = reviewFixture(t, W1_T12176);
  const transcript = `REVIEW_VERDICT 1: FAIL ${W1_T12176_CLAUSE}`;
  const first = await drive(transcript);
  assert.equal(first.verdict.verdictWithheld, "downgrade-unclassified");
  const held = first.rows.filter(row => row.step === "review.semantic_incomplete");
  assert.deepEqual(held.map(row => [row.reason, row.head_sha]), [["downgrade-unclassified", first.verdict.headSha]]);
  assert.equal(first.rows.filter(row => row.step === "review.posted").length, 0, "the withheld attempt posts no verdict");
  const second = await drive(transcript);
  assert.equal(second.verdict.verdictWithheld, undefined, "the verdict is withheld once, never forever");
  assert.equal(second.verdict.state, "failure");
  assert.equal(second.verdict.criteria[0]!.met, false, "an untagged FAIL never yields a met criterion");
  assert.equal(second.verdict.criteria[0]!.downgrade_class, "unclassified");
  assert.ok(second.verdict.criteria[0]!.reason.endsWith(`— NOTE: ${ORIGIN_MAIN_NOTE}: ${W1_T12176_CLAUSE}`));
  assert.equal(second.rows.filter(row => row.step === "review.semantic_incomplete").length, 1);
  const posted = second.rows.filter(row => row.step === "review.posted");
  assert.equal(posted.length, 1);
  const criteria = (posted[0]!.decision_verdict as { criteria: Array<{ downgrade_class?: string }> }).criteria;
  assert.equal(criteria[0]!.downgrade_class, "unclassified", "the posted row names the unclassified fold");
});

test("W1-T13849 criterion 3: the withhold decision reads the prior hold, and an untagged FAIL is never met", (t) => {
  const input = {
    stage: "semantic", plan_only: false, required_semantic: false, criteria_count: 1, risk_present: true,
    budget_present: true, untasked: false, head_task_resolved: true, own_task_record_missing: false,
    reviewer_outcome: "success", verdict_lines: ["REVIEW_VERDICT 1: FAIL"],
  } as const;
  assert.deepEqual(outcomeClass.classifyReviewOutcome({ ...input, downgrade_unclassified: [1] } as never),
    { class: "withheld", reason: "downgrade-unclassified" });
  assert.equal(outcomeClass.classifyReviewOutcome({ ...input, downgrade_unclassified: [1], downgrade_unclassified_withheld: true } as never).class, "posted");
  assert.equal(outcomeClass.classifyReviewOutcome({ ...input, plan_only: true, downgrade_unclassified: [1] } as never).class, "posted");
  assert.equal(outcomeClass.reviewReplayInputDigest(input as never),
    outcomeClass.reviewReplayInputDigest({ ...input, downgrade_unclassified: undefined } as never), "an unmarked input keeps its digest");
  const verdict = judged(t, W1_T12176, `REVIEW_VERDICT 1: FAIL ${W1_T12176_CLAUSE}`, { exec: "pass" });
  assert.equal(verdict.criteria[0]!.met, false);
  assert.equal(verdict.criteria[0]!.downgrade_class, "unclassified");
  assert.deepEqual(review.classifyDowngrade(`(b) ${W1_T12176_CLAUSE}`), { class: "b", text: W1_T12176_CLAUSE });
  assert.deepEqual(review.classifyDowngrade(W1_T12176_CLAUSE), { class: "unclassified", text: W1_T12176_CLAUSE });
  assert.equal(review.DOWNGRADE_TAG_RE.test(`(c) ${W1_T13709_CLAUSE}`), true);
  assert.equal(review.DOWNGRADE_TAG_RE.test("(proof pastes a grep; needs an executed unit test) a parenthetical reason"), false);
  assert.deepEqual(review.parseReviewerVerdictClauses(`REVIEW_VERDICT 1: FAIL (a) ${W1_T13785_CLAUSE}`, 1), [`(a) ${W1_T13785_CLAUSE}`]);
});

test("W1-T13849 criterion 4: the contract and prompt name the three classes, and the reviewer text is the same for every model", async (t) => {
  const contract = review.reviewerVerdictContract(3);
  assert.match(contract, /REVIEW_VERDICT <n>: FAIL \(a\) <the claim's own input/);
  assert.match(contract, /REVIEW_VERDICT <n>: FAIL \(c\) <the behaviour outside the claim that the change breaks, and where>/);
  assert.match(contract, /REVIEW_FOLLOW_UP <n>: <the input and the result>/);
  assert.match(contract, /OUTSIDE what the claim states is never a FAIL/);
  assert.equal(review.reviewerVerdictContract.length, 1, "the contract takes the criteria count and nothing else");
  const prompt = review.buildReviewPrompt({
    task: { id: "W1-T13849", acceptance: [W1_T12176], design: "keep the floor" },
    prUrl: "https://github.com/acme/remudero/pull/1", owner: "acme", repo: "remudero", headSha: "a".repeat(40),
    evidencePath: "/x/input.json", proofEvidencePath: "/x/proofs.json",
  } as never);
  assert.doesNotMatch(prompt, /Additional checks may help/);
  assert.match(prompt, /violated preservation constraint is \(c\)/);
  assert.match(prompt, /REVIEW_FOLLOW_UP/);
  const { drive, prompts } = reviewFixture(t, W1_T12176);
  await drive("REVIEW_VERDICT 1: PASS", { mount: "sonnet", ledger: "ledger-sonnet.ndjson" });
  await drive("REVIEW_VERDICT 1: PASS", { mount: "sol", ledger: "ledger-sol.ndjson" });
  const normal = (text: string) => text.replace(/"[^"]*rmd-review-(input|proofs)\.json"/g, "<$1>");
  const [sonnet, sol] = [prompts.find(Boolean)!, prompts.at(-1)!].map(normal);
  assert.ok(prompts.length >= 2);
  assert.equal(sol, sonnet, "a Claude and a Sol reviewer receive byte-identical review text");
  assert.ok(sonnet.endsWith(review.reviewerVerdictContract(1)));
});

test("W1-T13849 criterion 5: the gate only narrows — failed proofs, failed floors, (c) and plan-only verdicts stand", async (t) => {
  const b = `REVIEW_VERDICT 1: FAIL (b) ${W1_T12176_CLAUSE}`;
  const failedProof = judged(t, W1_T12176, b, { exec: "fail" });
  assert.equal(failedProof.criteria[0]!.proof_exec, "executed_fail");
  assert.equal(failedProof.criteria[0]!.met, false, "a (b) never rescues a proof that executed and failed");
  assert.equal(failedProof.state, "failure");
  const failedFloor = review.judgeReview([W1_T12176], { diff: CODE_DIFF("src/changed.ts"), report: "unrelated words only",
    semantic: [false], semanticClauses: [`(b) ${W1_T12176_CLAUSE}`] });
  assert.equal(failedFloor.criteria[0]!.met, false, "a (b) never rescues a floor that already failed");
  assert.equal(judged(t, W1_T13709, `REVIEW_VERDICT 1: FAIL (c) ${W1_T13709_CLAUSE}`, { exec: "pass" }).state, "failure");
  const planDiff = "diff --git a/plan/tasks.d/W1-T1.yaml b/plan/tasks.d/W1-T1.yaml\n--- a/plan/tasks.d/W1-T1.yaml\n+++ b/plan/tasks.d/W1-T1.yaml\n@@ -1 +1 @@\n-  status: queued\n+  status: merged\n";
  const planFloor = judged(t, W1_T12176, undefined, { diff: planDiff });
  for (const transcript of [b, `REVIEW_VERDICT 1: FAIL (a) ${W1_T13785_CLAUSE}`, `REVIEW_VERDICT 1: FAIL ${W1_T12176_CLAUSE}`]) {
    const plan = judged(t, W1_T12176, transcript, { diff: planDiff });
    assert.equal(plan.planOnly, true);
    assert.equal(plan.state, planFloor.state, "a plan-only review still decides on the floor");
  }
  const { drive } = reviewFixture(t, W1_T12176);
  const fleet = await drive(b, { mount: "sol", ledger: "ledger-fleet.ndjson", headRefName: "run-W1-T12176-1795104995955" });
  const operator = await drive(b, { mount: "sonnet", ledger: "ledger-operator.ndjson", headRefName: "operator-hand-fix" });
  assert.equal(fleet.verdict.state, "success");
  assert.equal(operator.verdict.state, fleet.verdict.state, "an operator PR and a fleet PR, a Claude and a Sol reviewer: one rule");
  assert.deepEqual(operator.verdict.criteria.map(c => [c.met, c.downgrade_class, c.followUp]),
    fleet.verdict.criteria.map(c => [c.met, c.downgrade_class, c.followUp]));
});
