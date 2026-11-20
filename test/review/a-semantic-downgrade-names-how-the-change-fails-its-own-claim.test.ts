// W1-T13849: a reviewer FAIL names its class. (a) the change does not do what the claim says on the claim's own
// input, (c) it breaks behaviour outside the claim: both fail the criterion exactly as before. (b) a counterexample
// beyond the claim's stated inputs is a follow-up finding, not a FAIL. An explained, untagged FAIL is held once,
// then folds as before. The fixtures replay recorded clauses of 2026-11-19 (core ledger union, review.posted rows).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import * as reviewCommand from "#src/cli/commands/review.js";
import type { AsyncIssueGateway } from "#src/lib/escalate.js";
import { appendLedger } from "#src/lib/ledger.js";
import type { MainRepairLane } from "#src/lib/main-health-rung.js";
import * as outcomeClass from "#src/lib/review-outcome-class.js";
import * as review from "#src/lib/review.js";
import * as health from "#src/lib/reviewer-health.js";
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

/** The production review command over a real checkout with observable grep proof results. */
function reviewFixture(t: TestContext, criterion: Criterion, failingCriterion?: Criterion) {
  const repo = gitRepo({ scope: t, kind: "semantic-downgrade-review" });
  const criteria = failingCriterion ? [criterion, failingCriterion] : [criterion];
  const target = criterion.proof.replace(/^grep: .* in /, "");
  const marker = criterion.proof.replace(/^grep: (.*) in .*$/, "$1");
  mkdirSync(join(repo.dir, dirname(target)), { recursive: true });
  writeFileSync(join(repo.dir, target), `test("${marker}", () => {});\n`);
  if (failingCriterion) {
    const missingMarkerTarget = failingCriterion.proof.replace(/^grep: .* in /, "");
    mkdirSync(join(repo.dir, dirname(missingMarkerTarget)), { recursive: true });
    writeFileSync(join(repo.dir, missingMarkerTarget), "// The cited marker is absent.\n");
  }
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
  ], { kind: "semantic-downgrade-review", parent: ownedFixtureDir(t, "semantic-downgrade-gh").dir });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  const prompts: string[] = [];
  const drive = async (transcript: string, opts: {
    mount?: keyof typeof MOUNTS; ledger?: string; headRefName?: string; shadow?: boolean; inputBody?: string;
    readReviewStatusHistory?: review.ReviewStatusHistoryReader;
  } = {}) => {
    const mount = MOUNTS[opts.mount ?? "sol"];
    const ledgerPath = join(repo.dir, opts.ledger ?? "ledger.ndjson");
    const runId = `semantic-downgrade-${prompts.length}`;
    const verdict = await reviewCommand.runReview(reviewFixtureHost(head), {
      owner: "acme", repo: "remudero", prUrl, ...(opts.headRefName ? { headRefName: opts.headRefName } : {}),
      task: { id: "W1-T13849", files: [target], acceptance: criteria },
      report: criteria.map(c => `${c.claim}\n${c.proof}`).join("\n"),
      reviewInputBody: opts.inputBody, shadow: opts.shadow, settingsFile: join(repo.dir, "settings.json"),
      config: { root: repo.dir, claudeBin: "/unused" },
      log: (step: string, extra: Record<string, unknown> = {}) => appendLedger(ledgerPath, {
        run_id: runId, task_id: "W1-T13849", step: health.reviewerShadowStep(step, opts.shadow === true), ...extra,
      }),
      say: () => {}, account: (worker: unknown) => worker, spawnReviewer: true, readReviewReuseFacts: () => undefined,
      readReviewStatusHistory: opts.readReviewStatusHistory,
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
  return { drive, prompts, shim, head, ledgerPath: join(repo.dir, "ledger.ndjson") };
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
  assert.ok(posted?.review_input_digest);
  assert.equal(followUps[0]!.review_input_digest, posted.review_input_digest);
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

test("W1-T13849 criterion 1: verdict syntax quoted by a follow-up cannot override a (b) FAIL", async (t) => {
  const { drive, shim } = reviewFixture(t, W1_T12176);
  const clause = "The log literally contains `REVIEW_VERDICT 1: FAIL (c) legacy path breaks` and `REVIEW_VERDICT 1: UNABLE`.";
  const finding = `REVIEW_FOLLOW_UP 1: ${clause}`;
  assert.equal(review.REVIEWER_RECORD_LINE_RE.test(finding), true);
  assert.equal(review.REVIEWER_RECORD_LINE_RE.test("The reviewer described a test run."), false);
  const { verdict, rows } = await drive(`REVIEW_VERDICT 1: FAIL (b) ${W1_T12176_CLAUSE}\n${finding}`);
  assert.equal(verdict.state, "success");
  assert.equal(verdict.criteria[0]?.proof_exec, "executed_pass");
  assert.equal(verdict.criteria[0]?.downgrade_class, "b");
  assert.deepEqual(rows.filter(row => row.step === "review.follow_up_finding").map(row => row.clause),
    [W1_T12176_CLAUSE, clause]);
  assert.ok(reviewBodies(shim).includes(`- criterion 1: ${clause}`));
  assert.deepEqual(outcomeClass.recordedReviewVerdictLines(finding, 1), []);
  assert.deepEqual(review.parseReviewerVerdicts(finding, 1), [undefined]);
  assert.deepEqual(review.parseReviewerUnable(finding, 1), [undefined]);
  assert.deepEqual(review.parseReviewerFollowUps(`REVIEW_VERDICT 1: FAIL (c) The test logs ${finding}`, 1), [undefined]);
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
  assert.equal(second.verdict.criteria[0]!.met, false, "an explained, untagged FAIL still downgrades on retry");
  assert.equal(second.verdict.criteria[0]!.downgrade_class, "unclassified");
  assert.ok(second.verdict.criteria[0]!.reason.endsWith(`— NOTE: ${ORIGIN_MAIN_NOTE}: ${W1_T12176_CLAUSE}`));
  assert.equal(second.rows.filter(row => row.step === "review.semantic_incomplete").length, 1);
  const posted = second.rows.filter(row => row.step === "review.posted");
  assert.equal(posted.length, 1);
  const criteria = (posted[0]!.decision_verdict as { criteria: Array<{ downgrade_class?: string }> }).criteria;
  assert.equal(criteria[0]!.downgrade_class, "unclassified", "the posted row names the unclassified fold");
});

test("W1-T13849 criterion 3: an untagged arrow expression survives the first hold and the binding retry", async (t) => {
  const { drive } = reviewFixture(t, W1_T12176);
  const clause = "() => reload() throws on the claim input";
  const transcript = `REVIEW_VERDICT 1: FAIL ${clause}`;
  const first = await drive(transcript);
  assert.equal(first.verdict.verdictWithheld, "downgrade-unclassified");
  assert.equal(first.rows.find(row => row.step === "review.semantic_incomplete")?.reason, "downgrade-unclassified");
  assert.equal(first.rows.some(row => row.step === "review.posted"), false);

  const retry = await drive(transcript);
  assert.equal(retry.verdict.verdictWithheld, undefined);
  assert.equal(retry.verdict.state, "failure");
  assert.equal(retry.verdict.criteria[0]?.proof_exec, "executed_pass");
  assert.equal(retry.verdict.criteria[0]?.met, false);
  assert.equal(retry.verdict.criteria[0]?.downgrade_class, "unclassified");
  assert.ok(retry.verdict.criteria[0]?.reason.endsWith(clause));
  assert.equal(retry.rows.filter(row => row.step === "review.semantic_incomplete").length, 1);
  assert.equal(retry.rows.find(row => row.step === "review.posted")?.state, "failure");
});

test("W1-T13849 criterion 3: an explained, untagged FAIL holds once for each input digest", async (t) => {
  const { drive, head } = reviewFixture(t, W1_T12176);
  const transcript = `REVIEW_VERDICT 1: FAIL ${W1_T12176_CLAUSE}`;
  const inputBody = "first PR body";
  const first = await drive(transcript, { inputBody });
  assert.equal(first.verdict.verdictWithheld, "downgrade-unclassified");
  assert.equal(first.rows.some(row => row.step === "review.posted"), false);
  const second = await drive(transcript, { inputBody });
  assert.equal(second.verdict.verdictWithheld, undefined);
  assert.equal(second.verdict.state, "failure");
  assert.equal(second.verdict.criteria[0]!.proof_exec, "executed_pass");
  assert.equal(second.verdict.criteria[0]!.met, false);
  assert.ok(second.verdict.criteria[0]!.reason.endsWith(`— NOTE: ${ORIGIN_MAIN_NOTE}: ${W1_T12176_CLAUSE}`));
  const posted = second.rows.find(row => row.step === "review.posted");
  const decision = posted?.decision_verdict as review.ReviewVerdict | undefined;
  assert.equal(decision?.criteria[0]?.downgrade_class, "unclassified");

  const changed = await drive(transcript, { inputBody: "changed PR body" });
  assert.equal(changed.verdict.verdictWithheld, "downgrade-unclassified");
  const holds = changed.rows.filter(row => row.step === "review.semantic_incomplete");
  assert.deepEqual(holds.map(row => [row.head_sha, row.reason, row.review_input_digest]), [
    [head, "downgrade-unclassified", review.reviewInputDigest(head, inputBody)],
    [head, "downgrade-unclassified", review.reviewInputDigest(head, "changed PR body")],
  ]);
});

test("W1-T13849 criterion 3: an unreadable rotation cannot cause a second hold", async (t) => {
  const { drive, head, ledgerPath } = reviewFixture(t, W1_T12176);
  const transcript = `REVIEW_VERDICT 1: FAIL ${W1_T12176_CLAUSE}`;
  const inputBody = "archived hold";
  const first = await drive(transcript, { inputBody });
  assert.equal(first.verdict.verdictWithheld, "downgrade-unclassified");
  const decisionDigest = first.verdict.reviewDecisionDigest!;
  const inputDigest = review.reviewInputDigest(head, inputBody);
  const rotation = join(dirname(ledgerPath), "ledger.2026-11-20T00-00-00-000Z.ndjson.gz");
  writeFileSync(rotation, gzipSync(readFileSync(ledgerPath)));
  writeFileSync(ledgerPath, "");
  assert.equal(await reviewCommand.unclassifiedHoldRecorded(ledgerPath, head, inputDigest, decisionDigest), true);
  assert.equal(await reviewCommand.unclassifiedHoldRecorded(ledgerPath, head, "unrelated-input", decisionDigest), false);

  writeFileSync(rotation, "unreadable gzip rotation");
  const second = await drive(transcript, { inputBody });
  assert.equal(second.verdict.verdictWithheld, undefined);
  assert.equal(second.verdict.state, "failure");
  assert.equal(second.verdict.criteria[0]!.proof_exec, "executed_pass");
  assert.equal(second.verdict.criteria[0]!.met, false);
  assert.equal(second.verdict.criteria[0]!.downgrade_class, "unclassified");
  assert.equal(second.rows.some(row => row.step === "review.semantic_incomplete"), false);
  assert.equal(second.rows.find(row => row.step === "review.posted")?.state, "failure");
});

test("W1-T13849 criterion 3: each shadow input holds once independently of production", async (t) => {
  const { drive } = reviewFixture(t, W1_T12176);
  const transcript = `REVIEW_VERDICT 1: FAIL ${W1_T12176_CLAUSE}`;
  const first = await drive(transcript, { shadow: true });
  assert.equal(first.verdict.verdictWithheld, "downgrade-unclassified");
  const second = await drive(transcript, { shadow: true });
  assert.equal(second.verdict.verdictWithheld, "reviewer-health shadow: no publication");
  assert.equal(second.verdict.state, "failure");
  assert.equal(second.verdict.criteria[0]!.downgrade_class, "unclassified");
  assert.equal(second.rows.filter(row => row.step === "shadow.review.semantic_incomplete").length, 1);
  assert.equal(second.rows.some(row => row.step === "review.posted"), false);
  assert.equal((await drive(transcript)).verdict.verdictWithheld, "downgrade-unclassified",
    "a shadow hold never consumes the production retry");
});

test("W1-T13849 criterion 3: a rotation after archive listing cannot hide the same-input hold", async (t) => {
  const { drive, head, ledgerPath } = reviewFixture(t, W1_T12176);
  const transcript = `REVIEW_VERDICT 1: FAIL ${W1_T12176_CLAUSE}`;
  const inputBody = "hold before rotation";
  const first = await drive(transcript, { inputBody });
  assert.equal(first.verdict.verdictWithheld, "downgrade-unclassified");

  const stateDir = dirname(ledgerPath);
  const readFile = fsPromises.readFile;
  const initialLedger = readFileSync(ledgerPath);
  let rotations = 0;
  let rotationsRemaining = 1;
  t.mock.method(fsPromises, "readFile", (...args: Parameters<typeof readFile>) => {
    if (args[0] === ledgerPath && rotationsRemaining > 0) {
      rotationsRemaining -= 1;
      rotations += 1;
      writeFileSync(join(stateDir, `ledger.${rotations}.ndjson.gz`), gzipSync(readFileSync(ledgerPath)));
      const nextLive = join(stateDir, "replacement-live");
      writeFileSync(nextLive, "");
      renameSync(nextLive, ledgerPath);
    }
    return readFile(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  assert.equal(await reviewCommand.unclassifiedHoldRecorded(ledgerPath, head, "unrelated-input", first.verdict.reviewDecisionDigest!), false);
  assert.equal(rotations, 1);
  // Put the first hold back on the live path to force the same race through publication.
  writeFileSync(ledgerPath, initialLedger);
  unlinkSync(join(stateDir, "ledger.1.ndjson.gz"));
  rotationsRemaining = 1;
  const retry = await drive(transcript, { inputBody });
  assert.equal(rotations, 2);
  assert.equal(retry.verdict.verdictWithheld, undefined);
  assert.equal(retry.rows.some(row => row.step === "review.semantic_incomplete"), false);
  const posted = retry.rows.find(row => row.step === "review.posted");
  const decision = posted?.decision_verdict as review.ReviewVerdict | undefined;
  assert.equal(posted?.state, "failure");
  assert.equal(decision?.criteria[0]?.downgrade_class, "unclassified");

  rotationsRemaining = 2;
  assert.equal(await reviewCommand.unclassifiedHoldRecorded(ledgerPath, head, "unrelated-input", first.verdict.reviewDecisionDigest!), true,
    "two successive changes leave the history uncertain, so another hold is refused");
  assert.equal(rotations, 4);
});

test("W1-T13849 criterion 3: the decision reads the prior hold, and an explained, untagged FAIL still downgrades", (t) => {
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
  assert.deepEqual(contract.match(/^  REVIEW_VERDICT <n>: FAIL.*$/gm)?.map(line => line.match(/FAIL \(([a-z])\)/)?.[1]), ["a", "c"]);
  assert.match(contract, /\(c\): the change breaks behaviour outside the claim/);
  assert.match(contract, /\(b\): a counterexample on an input outside the claim that exposes no regression\s+or preservation violation/);
  assert.match(contract, /Emit PASS if \(b\) is the only finding/);
  assert.equal(review.reviewerVerdictContract.length, 1, "the contract takes the criteria count and nothing else");
  const prompt = review.buildReviewPrompt({
    task: { id: "W1-T13849", acceptance: [W1_T12176], design: "keep the floor" },
    prUrl: "https://github.com/acme/remudero/pull/1", owner: "acme", repo: "remudero", headSha: "a".repeat(40),
    evidencePath: "/x/input.json", proofEvidencePath: "/x/proofs.json",
  } as never);
  assert.doesNotMatch(prompt, /Additional checks may help/);
  assert.match(prompt, /violated preservation constraint is \(c\)/);
  assert.match(prompt, /false on its own inputs is \(a\)/);
  assert.match(prompt, /changes neither claimed nor existing\s+behaviour[\s\S]*?is a \(b\) REVIEW_FOLLOW_UP line/);
  const { drive, prompts } = reviewFixture(t, W1_T12176);
  await drive("REVIEW_VERDICT 1: PASS", { mount: "sonnet", ledger: "ledger-sonnet.ndjson" });
  await drive("REVIEW_VERDICT 1: PASS", { mount: "sol", ledger: "ledger-sol.ndjson" });
  const normal = (text: string) => text.replace(/"[^"]*rmd-review-(input|proofs)\.json"/g, "<$1>");
  const [sonnet, sol] = [prompts.find(Boolean)!, prompts.at(-1)!].map(normal);
  assert.ok(prompts.length >= 2);
  assert.equal(sol, sonnet, "a Claude and a Sol reviewer receive byte-identical review text");
  assert.ok(sonnet.endsWith(review.reviewerVerdictContract(1)));
});

test("W1-T13849 criterion 5: a failing proof posts failure despite an unclassified FAIL on another criterion", async (t) => {
  const { drive } = reviewFixture(t, W1_T12176, W1_T13709);
  const { verdict, rows } = await drive(`REVIEW_VERDICT 1: FAIL ${W1_T12176_CLAUSE}\nREVIEW_VERDICT 2: PASS`);
  assert.equal(verdict.verdictWithheld, undefined);
  assert.equal(verdict.state, "failure");
  assert.deepEqual(verdict.criteria.map(c => [c.proof_exec, c.met]), [["executed_pass", false], ["executed_fail", false]]);
  assert.equal(rows.some(row => row.step === "review.semantic_incomplete"), false);
  assert.equal(rows.find(row => row.step === "review.posted")?.state, "failure");
});

test("W1-T13849 criterion 5: the same-input stability guard suppresses an unclassified downgrade before it can hold", async (t) => {
  const { drive, head, ledgerPath } = reviewFixture(t, W1_T12176);
  const inputBody = "previously reviewed PR body";
  const inputDigest = review.reviewInputDigest(head, inputBody);
  appendLedger(ledgerPath, {
    run_id: "prior", task_id: "W1-T13849", step: "review.posted", state: "success", head_sha: head,
    pr_url: "https://github.com/acme/remudero/pull/1", review_input_digest: inputDigest,
    review_contract_digest: review.reviewContractDigest({ taskId: "W1-T13849", acceptance: [W1_T12176],
      declaredFiles: [W1_T12176.proof.replace(/^grep: .* in /, "")], risk: undefined, budgetUsd: undefined }),
  });

  const transcript = `REVIEW_VERDICT 1: FAIL ${W1_T12176_CLAUSE}`;
  const { verdict, rows } = await drive(transcript, { inputBody });
  assert.equal(verdict.verdictWithheld, undefined);
  assert.equal(verdict.state, "success");
  assert.equal(verdict.criteria[0]?.met, true);
  assert.equal(rows.some(row => row.step === "review.downgrade_suppressed"), true);
  assert.equal(rows.some(row => row.step === "review.semantic_incomplete"), false);
  assert.equal(rows.filter(row => row.step === "review.posted").at(-1)?.state, "success");

  const changed = await drive(transcript, { inputBody: "edited PR body" });
  assert.equal(changed.verdict.verdictWithheld, "downgrade-unclassified");
});

test("W1-T13849 criterion 5: duplicate FAIL lines retain a binding failure and separate follow-up findings", (t) => {
  const edge = `REVIEW_VERDICT 1: FAIL (b) ${W1_T12176_CLAUSE}`;
  const bare = "REVIEW_VERDICT 1: FAIL";
  const explained = `REVIEW_VERDICT 1: FAIL ${W1_T12176_CLAUSE}`;
  const finding = `REVIEW_FOLLOW_UP 1: ${W1_T12176_CLAUSE}`;
  for (const [criterion, tag, clause] of [[W1_T13785, "a", W1_T13785_CLAUSE], [W1_T13709, "c", W1_T13709_CLAUSE]] as const) {
    const binding = `REVIEW_VERDICT 1: FAIL (${tag}) ${clause}`;
    for (const weaker of [edge, bare, explained]) {
      for (const lines of [[binding, weaker], [weaker, binding]]) {
        const transcript = [...lines, finding].join("\n");
        const verdict = judged(t, criterion, transcript, { exec: "pass" });
        assert.equal(verdict.state, "failure");
        assert.equal(verdict.criteria[0]!.downgrade_class, tag);
        assert.ok(verdict.criteria[0]!.reason.endsWith(clause));
        assert.deepEqual(review.reviewFollowUps(verdict.criteria, transcript),
          [{ criterion: 1, clause: W1_T12176_CLAUSE, source: "follow-up-line" }]);
      }
    }
  }
  for (const [unclassified, met] of [[bare, true], [explained, false]] as const) {
    for (const lines of [[unclassified, edge], [edge, unclassified]]) {
      const transcript = lines.join("\n");
      const verdict = judged(t, W1_T12176, transcript, { exec: "pass" });
      assert.equal(verdict.state, met ? "success" : "failure");
      assert.equal(verdict.criteria[0]!.preProofVerdict, "unmet");
      assert.equal(verdict.criteria[0]!.downgrade_class, met ? undefined : "unclassified");
    }
  }
});

test("W1-T13849 criterion 5: a tagged regression starting with an empty argument list still binds", (t) => {
  const clause = "() => reload() now throws in the legacy caller at src/legacy.ts:12";
  const verdict = judged(t, W1_T13709, `REVIEW_VERDICT 1: FAIL (c) ${clause}`, { exec: "pass" });
  assert.equal(verdict.criteria[0]!.proof_exec, "executed_pass");
  assert.equal(verdict.criteria[0]!.met, false);
  assert.equal(verdict.criteria[0]!.downgrade_class, "c");
  assert.ok(verdict.criteria[0]!.reason.endsWith(`— NOTE: ${ORIGIN_MAIN_NOTE}: ${clause}`));
  assert.equal(verdict.state, "failure");
});

test("W1-T13849 criterion 5: follow-up prose cannot resolve a reproduced failure on the same head", async (t) => {
  for (const mode of ["bare PASS", "quoted PASS", "explained PASS"] as const) {
    await t.test(mode, async (t) => {
      const { drive, head, shim } = reviewFixture(t, W1_T12176);
      const id = createHash("sha256").update("same-head reproduced failure").digest("hex");
      const failure = {
        headSha: head, criterion: 1, id, summary: "padded final log line loses the crash cause",
        finding: `1. ${W1_T12176.claim}\n   - proof executed and PASSED — NOTE: reviewer judged the proof non-responsive: ${W1_T12176_CLAUSE}`,
      };
      const acknowledgement = `REVIEW_ADDRESSED_FAILURE 1: ${id}`;
      const explanation = `re-ran reproduction ${id}; it now passes`;
      const pass = `REVIEW_VERDICT 1: PASS (${explanation})`;
      const transcript = mode === "explained PASS" ? `${acknowledgement}\n${pass}`
        : `${acknowledgement}\nREVIEW_VERDICT 1: PASS${mode === "quoted PASS" ? `\nREVIEW_FOLLOW_UP 1: ${pass}` : ""}`;
      const { verdict, rows } = await drive(transcript, {
        readReviewStatusHistory: async () => ({ kind: "readable", failures: [failure] }),
      });
      const expected = mode === "explained PASS" ? "success" : "failure";
      assert.equal(verdict.state, expected);
      assert.equal(rows.find(row => row.step === "review.posted")?.state, expected);
      if (mode === "quoted PASS") assert.ok(reviewBodies(shim).includes(pass), "the quotation is still reported as a follow-up");
      if (expected === "failure") assert.ok(verdict.criteria[0]?.reason.includes(W1_T12176_CLAUSE));
      else assert.deepEqual(verdict.reproducedFailureIdsAddressed, [id]);
    });
  }
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

// W1-T13849 guard (operator ruling 2026-11-19): reviewer health reads the first downgrade-unclassified hold per
// head and input digest as pending, so a wave of first holds after this change deploys is not a reviewer regression.
type HealthRow = Record<string, unknown>;
const sha40 = (seed: string): string => createHash("sha1").update(seed).digest("hex");
let healthClock = Date.parse("2026-11-19T00:00:00.000Z");
const healthTick = (): string => new Date((healthClock += 1000)).toISOString();
const PULLS = "https://github.com/acme/remudero/pull";
const healthUnit = (pr: number) => ({ pr_url: `${PULLS}/${pr}`, head_sha: sha40(`head-${pr}`) });
const postedRow = (sha: string, pr: number): HealthRow =>
  ({ ts: healthTick(), host: "core", step: "review.posted", state: "success", plan_only: false, reviewer_code_sha: sha, ...healthUnit(pr) });
/** The row #19727 writes (src/cli/commands/review.ts): reason, reviewer_outcome and both digests. */
const holdRow = (sha: string, pr: number, opts: { digest?: string; ts?: string; outcome?: string; reason?: string } = {}): HealthRow =>
  ({ ts: opts.ts ?? healthTick(), host: "core", step: "review.semantic_incomplete", reason: opts.reason ?? outcomeClass.DOWNGRADE_UNCLASSIFIED,
    reviewer_outcome: opts.outcome ?? "success", review_decision_digest: `decision-${pr}`, review_input_digest: opts.digest ?? `input-${pr}`,
    reviewer_code_sha: sha, ...healthUnit(pr) });
/** A clean history: three reviewer code shas, 150 posted code reviews each, none withheld. */
const cleanHistory = (): HealthRow[] => [0, 1, 2].flatMap(i => Array.from({ length: 150 }, (_, j) => postedRow(sha40(`clean-${i}`), 1000 * (i + 1) + j)));

/** evaluateReviewerHealthNow over a row queue; the issue gateway and repair lane record, git knows no sha. */
function healthFixture(t: TestContext) {
  const dir = ownedFixtureDir(t, "reviewer-health-hold").dir;
  const statePath = join(dir, "reviewer-health.json");
  const queue: HealthRow[] = [];
  const steps: string[] = [];
  const calls = { issues: 0, reverts: 0 };
  const issues: AsyncIssueGateway = {
    create: async () => { calls.issues += 1; return "https://github.com/acme/remudero/issues/1"; },
    listOpen: async () => [], ensureLabel: async () => true, comment: async () => {}, closeWithComment: async () => {},
  };
  const lane: MainRepairLane = {
    openFixPr: async () => { throw new Error("a reviewer regression opens no fix PR"); },
    openRevertPr: async () => { calls.reverts += 1; return { prUrl: `${PULLS}/900` }; },
    readPr: async () => ({ state: "open" as const }), closePr: async () => {},
  };
  const git: health.GitText = async () => { throw new Error("no git history in this fixture"); };
  const evaluate = (current: string) => health.evaluateReviewerHealthNow({ originMainSha: current }, statePath,
    async () => ({ rows: queue.splice(0), cursor: { liveOffset: 0 } }), git,
    { issues, ledgerPath: join(dir, "ledger.ndjson"), runId: "w1-t13849-guard" }, lane,
    (step: string) => { steps.push(step); }, { iso: () => new Date(healthClock).toISOString() });
  return { queue, steps, calls, evaluate, state: () => health.loadReviewerHealthState(statePath) };
}

test("W1-T13849 guard: first-attempt holds, each re-asked to a posted verdict at the same sha, open no reviewer-regression incident", async (t) => {
  const S = sha40("deployed-19727");
  const h = healthFixture(t);
  h.queue.push(...cleanHistory());
  await h.evaluate(sha40("clean-2"));
  assert.equal(h.state().coverage.rows, 450, "the clean history was read");
  const classes: string[] = [];
  for (let pr = 1; pr <= 4; pr++) {
    h.queue.push(holdRow(S, pr));
    await h.evaluate(S); // judged before its re-ask posts
    classes.push(h.state().shas[S]!.units[`${PULLS}/${pr}#${sha40(`head-${pr}`)}`]!);
    h.queue.push(postedRow(S, pr));
    await h.evaluate(S);
  }
  assert.deepEqual(h.steps.filter(step => step.startsWith("reviewer.regression_")), [], "no incident opens, extends or carries");
  const state = h.state();
  assert.equal(state.incident, null);
  assert.equal(state.shas[S]!.regressedAt, undefined, "the sha is never judged regressed");
  assert.deepEqual([h.calls.issues, h.calls.reverts], [0, 0], "no issue, no revert PR");
  assert.deepEqual(classes, ["withheld-pending", "withheld-pending", "withheld-pending", "withheld-pending"]);
  assert.deepEqual(health.shaCounts(state.shas[S]!), { k: 0, n: 4 }, "the sha reads as its posted verdicts alone");
  assert.deepEqual(state.shas[S]!.reasons, {}, "a pending hold adds no failure reason");
  assert.equal(state.shas[S]!.firstFailHost, undefined, "nor a first-fail host");
  assert.notEqual(health.judgeReviewerSha(state, S).state, "regressed");

  // The seed replays the same rows, every hold before its re-ask: nothing regresses, nothing is carried.
  const seed = healthFixture(t);
  seed.queue.push(...cleanHistory(), ...[1, 2, 3, 4].map(pr => holdRow(S, pr)), ...[1, 2, 3, 4].map(pr => postedRow(S, pr)));
  await seed.evaluate(S);
  assert.deepEqual(seed.steps.filter(step => step.startsWith("reviewer.regression_")), []);
  assert.equal(seed.state().shas[S]!.regressedAt, undefined);
  assert.deepEqual(seed.state().closed, []);

  // The production writer's own hold row is the one classed pending.
  const { drive } = reviewFixture(t, W1_T12176);
  const written = (await drive(`REVIEW_VERDICT 1: FAIL ${W1_T12176_CLAUSE}`)).rows.find(row => row.step === "review.semantic_incomplete")!;
  const classed = health.classifyReviewerHealthRow(written as HealthRow);
  assert.equal(classed?.kind === "outcome" ? classed.cls : undefined, "withheld-pending");
});

test("W1-T13849 guard: a second hold on the same head and input digest counts failing, as on origin/main", async (t) => {
  const S = sha40("second-hold");
  const h = healthFixture(t);
  h.queue.push(...cleanHistory());
  await h.evaluate(sha40("clean-2"));
  const first = holdRow(S, 7, { digest: "input-a" });
  h.queue.push(first, holdRow(S, 7, { digest: "input-b" }));
  await h.evaluate(S);
  const unit = `${PULLS}/7#${sha40("head-7")}`;
  assert.equal(h.state().shas[S]!.units[unit], "withheld-pending", "a first hold per digest is pending");
  assert.equal(h.state().incident, null);
  h.queue.push(first); // the same row read again is not a second hold
  await h.evaluate(S);
  assert.equal(h.state().shas[S]!.units[unit], "withheld-pending");
  h.queue.push(holdRow(S, 7, { digest: "input-a" }));
  await h.evaluate(S);
  const state = h.state();
  assert.equal(state.shas[S]!.units[unit], "withheld-success", "the second hold on head and digest input-a fails");
  assert.deepEqual(state.shas[S]!.reasons, { [outcomeClass.DOWNGRADE_UNCLASSIFIED]: 1 }, "its reason is recorded though it replaced a pending unit");
  assert.equal(state.shas[S]!.firstFailHost, "core");
  assert.deepEqual(h.steps.filter(step => step === "reviewer.regression_opened"), ["reviewer.regression_opened"]);
  assert.deepEqual(state.incident?.signature, [outcomeClass.DOWNGRADE_UNCLASSIFIED]);
  assert.equal(state.incident?.regressedSha, S);
});

test("W1-T13849 guard: every other withheld reason and outcome classes and counts as on origin/main", async (t) => {
  const S = sha40("other-reason");
  const cls = (row: HealthRow) => { const c = health.classifyReviewerHealthRow(row); return c?.kind === "outcome" ? c.cls : undefined; };
  assert.equal(cls(holdRow(S, 1, { reason: "required-semantic-incomplete-verdicts" })), "withheld-success");
  assert.equal(cls(holdRow(S, 1, { outcome: "error" })), "withheld-failure", "a hold whose reviewer failed is provider health");
  const undigested = holdRow(S, 1);
  delete undigested.review_input_digest;
  delete undigested.review_decision_digest;
  assert.equal(cls(undigested), "withheld-success", "a hold naming no digest cannot be the first: it fails");
  assert.equal(cls({ ...postedRow(S, 1) }), "posted");
  assert.equal(cls({ ts: healthTick(), host: "core", step: "review.semantic_setup_refused", reason: "head-task-metadata-unavailable",
    reviewer_code_sha: S, ...healthUnit(1) }), "setup-refused");
  const h = healthFixture(t);
  h.queue.push(...cleanHistory());
  await h.evaluate(sha40("clean-2"));
  h.queue.push(holdRow(S, 9, { reason: "required-semantic-incomplete-verdicts" }));
  await h.evaluate(S);
  const state = h.state();
  assert.deepEqual(health.shaCounts(state.shas[S]!), { k: 1, n: 1 });
  assert.deepEqual(state.incident?.signature, ["required-semantic-incomplete-verdicts"], "one other-reason hold regresses the sha as before");
  assert.deepEqual(h.steps.filter(step => step === "reviewer.regression_opened"), ["reviewer.regression_opened"]);
});
