import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as review from "#src/lib/review.js";
import * as reviewCommand from "#src/cli/commands/review.js";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const PR = "https://github.com/acme/remudero/pull/1";
const FLEET_RUN = "review-PR1-fleet-semantic";
const HAND_RUN = "review-PR1-hand-review";
const CODE = "e".repeat(40);
const CLAIM = "changed exists";
const DOWNGRADE = "proof executed and PASSED on the PR head — NOTE: reviewer judged the proof non-responsive (semantic downgrade): " +
  "the export is never read by any caller";
const NOT_RUN = "no executed evidence — the proof did not run on the PR head and the report does not name the claim";
const EXECUTED_FAIL = "proof executed and FAILED on the PR head (grep: changed in changed.ts)";
const DIFF = "diff --git a/changed.ts b/changed.ts\n+++ b/changed.ts\n@@ -0,0 +1 @@\n+export const changed = true;\n";

function reviewFixtureHost(head: string): reviewCommand.ReviewCommandHost {
  const unrelated = (): never => { throw new Error("unexpected unrelated orchestration port"); };
  return {
    GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
    acceptedReviewAttemptId: value => typeof value === "string" ? value : undefined, attributeWorkerStreamEvent: unrelated,
    ledgeredNonDispatchSpawn: unrelated, lintPlanForReview: unrelated, liveWorkerRunIds: new Set(), materializeReviewWorktree: unrelated,
    readHeadShaRest: () => head, readMainPlanTreeSha: unrelated,
    realDeps: () => ({ reviewWorktree: { fetch: unrelated } }) as unknown as ReturnType<reviewCommand.ReviewCommandHost["realDeps"]>,
    reviewPostedDescription: verdict => verdict.summary, reviewWorkerLockId: runId => runId,
    reviewerClockBoundMs: override => override!, reviewSubjectGit: unrelated,
  };
}

function reviewerSays(text: string): Awaited<ReturnType<NonNullable<Parameters<typeof reviewCommand.runReview>[1]["reviewerSpawnWorker"]>>> {
  return {
    sessionId: "disputed-pass", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    exit: { kind: "exit", code: 0 }, permissionDenials: [], childEnvKeys: [], model: "sonnet", provider: "codex", servedModel: "fixture",
    effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

function failureComment(head: string, reason: string, writer?: { run: string; input: string | undefined }) {
  return {
    commit_id: head, submitted_at: "2026-11-21T19:00:03Z",
    body: `**remudero-review=failure** — the following acceptance criterion is unmet:\n\n1. ${CLAIM}\n   - ${reason}\n\n` +
      "Add the missing work (or escalate). Do NOT edit the acceptance criteria to match the diff." +
      (writer ? `\n\n${reviewCommand.reviewWriterMarker(writer.run, writer.input, CODE)}` : ""),
  };
}

interface Scenario {
  reason: string;
  failRun?: string;
  failInput?: "same" | "other";
  marker?: boolean;
  comment?: boolean;
  failOnOtherHead?: boolean;
  reviewsUnreadable?: boolean;
  acknowledge?: boolean;
}

async function drivePass(t: TestContext, scenario: Scenario) {
  const fixture = gitRepo({ scope: t, kind: "disputed-pass" });
  const root = fixture.dir;
  writeFileSync(join(root, "changed.ts"), "export const changed = true;\n");
  fixture.git("add", "changed.ts");
  fixture.git("commit", "-qm", "changed");
  const head = fixture.git("rev-parse", "HEAD");
  const report = "changed";
  const inputDigest = review.reviewInputDigest(head, report);
  const failHead = scenario.failOnOtherHead ? "f".repeat(40) : head;
  const statuses = scenario.failOnOtherHead ? [] : [
    { id: 2, context: "remudero-review", state: "pending", description: `remudero-review: review in progress (owned by run ${HAND_RUN})` },
    { id: 1, context: "remudero-review", state: "failure", description: `remudero-review: FAIL — 1/1 criteria unmet [review code ${CODE}]` },
  ];
  const writer = scenario.marker === false ? undefined
    : { run: scenario.failRun ?? FLEET_RUN, input: scenario.failInput === "other" ? "0".repeat(64) : inputDigest };
  const reviews = scenario.comment === false ? [] : [failureComment(failHead, scenario.reason, writer)];
  const shim = ghShim([
    { when: `commits/${head}/statuses?per_page`, stdout: JSON.stringify(statuses) },
    scenario.reviewsUnreadable ? { when: "pulls/1/reviews?per_page", stderr: "HTTP 502", exit: 1 }
      : { when: "pulls/1/reviews?per_page", stdout: JSON.stringify(reviews) },
    { when: "pulls/1/reviews", stdout: "{}" },
    { when: "issues?labels=", stdout: "[]" },
    { when: "issue create", stdout: "https://github.com/acme/remudero/issues/77\n" },
    { when: "pulls/1", stdout: JSON.stringify({ number: 1, html_url: PR, state: "open", merged_at: null, head: { ref: "b", sha: head } }) },
    { when: "pr diff", stdout: DIFF },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "/status", stdout: '{"statuses":[]}' },
    { when: "api ", stdout: "{}" },
  ], { kind: "disputed-pass" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  });
  const ledgerPath = join(root, "ledger.ndjson");
  const arms: string[] = [];
  const disarms: string[] = [];
  const reproduced = review.reproducedReviewFailuresFromHistory(statuses, reviews, head);
  const acknowledgement = scenario.acknowledge && reproduced[0] ? `REVIEW_ADDRESSED_FAILURE 1: ${reproduced[0].id}\n` : "";
  const verdict = await withLiveWritesAllowed(() => reviewCommand.runReview(reviewFixtureHost(head), {
    owner: "acme", repo: "remudero", prUrl: PR,
    task: { id: "W1-T14179", files: ["changed.ts"], acceptance: [{ claim: CLAIM, proof: "grep: changed in changed.ts" }] },
    report, settingsFile: join(root, "settings.json"), config: { root, claudeBin: "/unused" },
    log: (step: string, extra: Record<string, unknown> = {}) => appendLedger(ledgerPath, { run_id: HAND_RUN, task_id: "W1-T14179", step, ...extra }),
    say: () => {}, account: (worker: unknown) => worker, spawnReviewer: true, readReviewReuseFacts: () => undefined,
    reviewerSpawnWorker: async () => reviewerSays(`${acknowledgement}REVIEW_VERDICT 1: PASS (re-ran the grep of changed.ts and it now passes)`),
    reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120_000 }, reviewerClockBoundMs: 120_000,
    reviewerCodeFreshness: () => ({ status: "fresh", codeSha: CODE, originMainSha: CODE, advance: "none" }),
    headCheckoutDir: root, ledgerPath, runId: HAND_RUN,
    disarm: (url: string) => { disarms.push(url); return "not-armed"; },
    arm: (url: string) => { arms.push(url); return { armed: false, reason: "fixture" }; },
  } as never));
  const posts = shim.calls().filter(call => call.includes(`statuses/${head}`) && call.includes("state="));
  const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  return { verdict, posts, rows, arms, disarms, calls: shim.calls(), head };
}

function assertHeld(result: Awaited<ReturnType<typeof drivePass>>, failRun: string) {
  assert.equal(result.verdict.state, "pending");
  assert.equal(result.posts.some(call => call.includes("state=success")), false, "no success reaches GitHub");
  const pending = result.posts.filter(call => call.includes("state=pending"));
  assert.ok(pending.some(call => call.includes(`PASS disputes FAIL of run ${failRun}`) && call.includes(`owned by run ${HAND_RUN}`)),
    `the pending status names both runs: ${pending.join("\n")}`);
  assert.match(result.verdict.verdictWithheld ?? "", new RegExp(`PASS of run ${HAND_RUN} disputes the standing FAIL of run ${failRun}`));
  assert.equal(result.arms.length, 0, "auto-merge is never armed");
  assert.ok(result.disarms.length > 0, "an arm taken at open is withdrawn");
  const held = result.rows.find(row => row.step === "review.post_refused" && row.outcome === "disputed_pass_held");
  assert.ok(held, "the disagreement is recorded");
  assert.equal(held.pass_run_id, HAND_RUN);
  assert.equal(held.escalation_issue_url, "https://github.com/acme/remudero/issues/77", "the disagreement is escalated");
  assert.ok(result.calls.some(call => call.includes("issue create") && call.includes("disputes a standing FAIL")));
  assert.equal(result.rows.some(row => row.step === "review.posted"), false, "a held PASS is not a posted verdict");
}

function assertPosted(result: Awaited<ReturnType<typeof drivePass>>) {
  assert.equal(result.verdict.state, "success", result.verdict.verdictWithheld);
  assert.ok(result.posts.some(call => call.includes("state=success")), "today's behaviour: the PASS posts");
  assert.equal(result.rows.some(row => row.outcome === "disputed_pass_held"), false);
  assert.equal(result.arms.length, 1, "the arm path runs as it does today");
}

test("W1-T14179 criterion 1: a second writer's PASS over a standing semantic FAIL on the same head, input and code posts pending and arms nothing", async t => {
  const result = await drivePass(t, { reason: DOWNGRADE });
  assertHeld(result, FLEET_RUN);
  const held = result.rows.find(row => row.outcome === "disputed_pass_held")!;
  assert.equal(held.fail_run_id, FLEET_RUN);
  assert.deepEqual(held.unanswered_criteria, [CLAIM]);
});

test("W1-T14179 criterion 1: a FAIL whose writer or criteria cannot be read is not replaced", async t => {
  await t.test("a FAIL comment that names no writer", async st => assertHeld(await drivePass(st, { reason: DOWNGRADE, marker: false }), "unknown"));
  await t.test("a FAIL with no evidence comment", async st => assertHeld(await drivePass(st, { reason: DOWNGRADE, comment: false }), "unknown"));
  await t.test("an unreadable review history", async st => {
    const result = await drivePass(st, { reason: DOWNGRADE, reviewsUnreadable: true });
    assert.equal(result.verdict.state, "pending");
    assert.equal(result.posts.some(call => call.includes("state=success")), false);
    assert.equal(result.arms.length, 0);
  });
});

test("W1-T14179 criterion 2: a PASS that answers every unmet criterion with an executed proof posts", async t => {
  await t.test("the FAIL's proof never ran; the PASS's proof executed and passed", async st => assertPosted(await drivePass(st, { reason: NOT_RUN })));
  await t.test("a reproduced failure the PASS addressed", async st => assertPosted(await drivePass(st, { reason: EXECUTED_FAIL, acknowledge: true })));
});

test("W1-T14179 criterion 2: a new head, a new input digest or the same writer's re-post keeps today's behaviour", async t => {
  await t.test("new head", async st => assertPosted(await drivePass(st, { reason: DOWNGRADE, failOnOtherHead: true })));
  await t.test("new input digest", async st => assertPosted(await drivePass(st, { reason: DOWNGRADE, failInput: "other" })));
  await t.test("same writer's re-post", async st => assertPosted(await drivePass(st, { reason: DOWNGRADE, failRun: HAND_RUN })));
});

test("W1-T14179 criterion 2: a FAIL replacing a PASS and a reproduced failure keep their rules", () => {
  const head = "a".repeat(40);
  const statuses = [{ context: "remudero-review", state: "failure", description: `remudero-review: FAIL [review code ${CODE}]` }];
  const standing = reviewCommand.standingReviewFailureFromHistory(statuses, [failureComment(head, DOWNGRADE, { run: FLEET_RUN, input: "d" })], head);
  assert.deepEqual(standing, { headSha: head, runId: FLEET_RUN, inputDigest: "d", codeSha: CODE, unmet: [{ claim: CLAIM, reason: DOWNGRADE }] });
  const history = { kind: "readable" as const, failures: [], standingFailure: standing };
  const criteria = [{ claim: CLAIM, proof: "grep: changed", met: false, reason: "unmet", proof_exec: "executed_fail" as const }];
  assert.equal(reviewCommand.passDisputesStandingFailure({ state: "failure", criteria }, head, { runId: HAND_RUN, inputDigest: "d" }, history), undefined,
    "a FAIL may always replace what stands");
  const passing = [{ ...criteria[0], met: true, proof_exec: "executed_pass" as const }];
  assert.ok(reviewCommand.passDisputesStandingFailure({ state: "success", criteria: passing }, head, { runId: HAND_RUN, inputDigest: "d" }, history));
  assert.equal(reviewCommand.standingReviewFailureFromHistory([{ ...statuses[0], state: "success" }, ...statuses], [], head), undefined,
    "a FAIL that a later terminal status replaced does not stand");
});

test("W1-T14179 criterion 1: a hand rmd review cannot restore its cached PASS over another writer's later FAIL", async t => {
  const fixture = gitRepo({ scope: t, kind: "disputed-replay" });
  const root = fixture.dir;
  writeFileSync(join(root, "changed.ts"), "export const changed = true;\n");
  fixture.git("add", "changed.ts");
  fixture.git("commit", "-qm", "changed");
  const head = fixture.git("rev-parse", "HEAD");
  const body = `## Acceptance\n- ${CLAIM} | grep: changed in changed.ts\n`;
  const view = { number: 1, state: "open", merged_at: null, body, html_url: PR, head: { ref: "topic", sha: head } };
  const shim = ghShim([
    { when: `commits/${head}/statuses?per_page`, stdout: "[]" },
    { when: "pulls/1/reviews?per_page", stdout: "[]" },
    { when: "pulls/1/reviews", stdout: "{}" },
    { when: "issues?labels=", stdout: "[]" },
    { when: "issue create", stdout: "https://github.com/acme/remudero/issues/78\n" },
    { when: "pulls/1", stdout: JSON.stringify(view) },
    { when: "pr diff", stdout: DIFF },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "/status", stdout: '{"statuses":[]}' },
    { when: "api ", stdout: "{}" },
  ], { kind: "disputed-replay" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  });
  const host = reviewFixtureHost(head);
  const decisions: Awaited<ReturnType<typeof reviewCommand.runReview>>[] = [];
  const arms: string[] = [];
  const drive = () => withLiveWritesAllowed(() => reviewCommand.reviewCommand(host, "1", ["--repo", "acme/remudero"], {
    resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }),
    fetchView: () => view,
    loadConfig: () => ({ root, installRoot: root, claudeBin: "/unused" }) as never,
    fetchHead: () => {},
    executionMode: "deterministic",
    materialize: () => ({ worktreePath: root }),
    withMaterialized: async (_path, _repo, run) => run(),
    buildBaseProof: () => ({ baseCheckoutDir: undefined, baseUnreadablePaths: new Set(), baseIsCheckout: false, addedTestFiles: new Set() }),
    postReviewPending: async () => ({ posted: true }),
    reviewerCodeFreshness: () => ({ status: "fresh", codeSha: CODE, originMainSha: CODE, advance: "none" }),
    disarm: () => "not-armed",
    runReview: async args => {
      const result = await reviewCommand.runReview(host, {
        ...args, headCheckoutDir: root, readReviewReuseFacts: () => undefined, spawnReviewer: true, requireSemanticReview: false,
        reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120_000 }, reviewerClockBoundMs: 120_000,
        reviewerSpawnWorker: async () => reviewerSays("REVIEW_VERDICT 1: PASS (the changed file proves the claim)"),
        disarm: () => "not-armed", arm: (url: string) => { arms.push(url); return "hold-refused"; },
      });
      decisions.push(result);
      return result;
    },
  }));
  assert.equal(await drive(), 0, "the first hand review computes and posts its PASS");
  assert.equal(decisions[0].state, "success");
  const fail = [{ id: 3, context: "remudero-review", state: "failure", description: `remudero-review: FAIL [review code ${CODE}]` }];
  shim.addRoute({ when: `commits/${head}/status`, stdout: JSON.stringify({ statuses: fail }) });
  shim.addRoute({ when: `commits/${head}/statuses?per_page`, stdout: JSON.stringify(fail) });
  shim.addRoute({ when: "pulls/1/reviews?per_page", stdout: JSON.stringify([failureComment(head, DOWNGRADE,
    { run: FLEET_RUN, input: review.reviewInputDigest(head, body) })]) });
  const before = shim.calls().length;
  assert.equal(await drive(), 2, "the replayed PASS is withheld");
  assert.equal(decisions[1].decisionDisposition, "replayed", "the second run exercises the cached restore");
  const later = shim.calls().slice(before).filter(call => call.includes(`statuses/${head}`) && call.includes("state="));
  assert.equal(later.some(call => call.includes("state=success")), false, "the cached PASS is not restored over the FAIL");
  assert.ok(later.some(call => call.includes("state=pending") && call.includes(`PASS disputes FAIL of run ${FLEET_RUN}`)), later.join("\n"));
  assert.equal(arms.length, 1, "only the first, undisputed PASS reached the arm path");
});
