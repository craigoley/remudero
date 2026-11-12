/**
 * W1-T11847 — a material reviewer-code advance queues exactly one fresh review per affected open PR, and old
 * reviewer-code evidence cannot gate a merge. The judge is the production `reviewerCodeJudge` over a real git
 * history; GitHub is a PATH-shim `gh`, so the pending post, the status reads and the lifecycle read are the
 * production paths. Nothing here asserts a cause for the #17209 failure of 2026-11-08: its reviewer-code sha and
 * run identity were never recorded, which is the gap this task closes.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { readLedgerLines } from "#src/lib/status.js";
import { reviewerCodeJudge, type ReviewerCodeFreshness } from "#src/lib/self-sync.js";
import {
  drainReviewOutbox, judgeReview, postReviewStatusGuarded, reviewCodeShaFromDescription, reviewDescriptionWithCodeProvenance,
  reviewOutboxEntryPath, REVIEWER_CODE_ADVANCED, type ReviewVerdict,
} from "#src/lib/review.js";
import {
  DEFAULT_SWEEP_POLICY, REVIEW_REQUEUED_STEP, REVIEW_STATUS_RESTORED_STEP, runSweep, type OpenPrView, type ReviewDispatchMode,
  type SweepDeps,
} from "#src/lib/sweep.js";
import { buildSweepEffects as commandEffects, reviewerCodeAdvanceFor, type SweepCommandHost } from "#src/cli/commands/sweep.js";
// @ts-expect-error — plain .mjs script with no type declarations
import { attest } from "#scripts/merge-queue-review-attest.mjs";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { makeTempDir } from "#src/lib/tmp.js";

const OWNER = "acme";
const REPO = "scratch";
const PR = 17901;
const URL = `https://github.com/${OWNER}/${REPO}/pull/${PR}`;
const TASK = "W1-T90001";
const HEAD = "d".repeat(40);
const DIGEST = "v2:t11847";
const CRITERION = { claim: "W1-T11847 the thing works", proof: "grep: W1-T11847 in src/x.ts" };
const DIFF = "diff --git a/src/x.ts b/src/x.ts\n+W1-T11847\n";

/** A history with the reviewer code, an unrelated (docs) advance, then a review-path advance. */
function codeHistory(): { dir: string; code: string; immaterial: string; material: string } {
  const repo = gitRepo({ kind: "t11847-code" });
  const commit = (path: string, text: string): string => {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "-m", path);
    return repo.git("rev-parse", "HEAD");
  };
  commit("docs/a.md", "a\n");
  const code = commit("src/lib/review.ts", "export const v = 1;\n");
  const immaterial = commit("docs/a.md", "b\n");
  const material = commit("src/lib/review.ts", "export const v = 2;\n");
  return { dir: repo.dir, code, immaterial, material };
}
const HISTORY = codeHistory();

function judgeAt(mainSha: string): (sha: unknown) => Promise<ReviewerCodeFreshness> {
  return reviewerCodeJudge(() => ({ status: "fresh", codeSha: mainSha, originMainSha: mainSha, advance: "none" }), HISTORY.dir);
}

function verdict(state: "success" | "failure" = "success"): ReviewVerdict {
  const judged = judgeReview([CRITERION], { diff: DIFF, report: "W1-T11847 the thing works.", headCheckoutDir: "/head", execProof: () => "pass" });
  return { ...judged, state };
}

function shim(t: TestContext, over: { lifecycle?: "open" | "closed"; liveState?: string } = {}) {
  const routes: GhShimRoute[] = [
    { when: "/statuses?", stdout: "[[]]\n" },
    { when: `commits/${HEAD}/status`, stdout: JSON.stringify({ sha: HEAD, statuses: [{ context: "remudero-review",
      state: over.liveState ?? "success", description: "remudero-review: PASS" }] }) + "\n" },
    { when: "statuses/", stdout: "{}\n" },
    { when: `pulls/${PR}`, stdout: JSON.stringify({ state: over.lifecycle ?? "open", merged: false, head: { sha: HEAD } }) + "\n" },
  ];
  const gh = ghShim(routes, { kind: "t11847-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const posts = (): string[] => gh.calls().filter((call) => call.includes(`statuses/${HEAD}`));
  return { posts };
}

function sweepFixture(t: TestContext, mainSha: string, over: Partial<OpenPrView> = {}) {
  const dir = makeTempDir("t11847-sweep");
  const ledgerPath = join(dir, "ledger.ndjson");
  const now = Date.parse("2026-11-11T13:30:00Z");
  const pr: OpenPrView = {
    prNumber: PR, prUrl: URL, taskId: TASK, headSha: HEAD, reviewInputDigest: DIGEST, reviewState: "success",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: "2026-11-11T12:00:00Z", ...over,
  };
  const reviews: ReviewDispatchMode[] = [];
  const armed: number[] = [];
  let onReview: () => void = () => undefined;
  const advance = reviewerCodeAdvanceFor({ owner: OWNER, repo: REPO, ledgerPath, runId: "sweep-t11847" }, judgeAt(mainSha));
  const deps: SweepDeps = {
    ledgerPath, runId: "sweep-t11847", now: () => now, reviewerCodeAdvance: advance,
    arm: (view) => { armed.push(view.prNumber); }, close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"), escalate: () => assert.fail("unexpected escalation"),
    postReview: (_pr, mode = { kind: "full-review" }) => { reviews.push(mode); onReview(); },
  };
  const deliver = (row: Record<string, unknown> = {}) => appendLedger(ledgerPath, {
    run_id: "review-original", task_id: TASK, step: "review.posted", state: "success", pr_url: URL, head_sha: HEAD,
    review_input_digest: DIGEST, decision_verdict: verdict(), reviewer_code_sha: HISTORY.code, ...row,
  });
  const run = async (view: OpenPrView = pr) => {
    await withLiveWritesAllowed(() => runSweep([view], deps, DEFAULT_SWEEP_POLICY));
    return readLedgerLines(ledgerPath).findLast((row) => row.step === "sweep.disposed");
  };
  const requeues = () => readLedgerLines(ledgerPath).filter((row) => row.step === REVIEW_REQUEUED_STEP && row.reason === REVIEWER_CODE_ADVANCED);
  return { pr, reviews, armed, deliver, run, requeues, ledgerPath, setOnReview: (fn: () => void) => { onReview = fn; } };
}

test("W1-T11847: terminal review provenance is full in the ledger and visible status", async (t) => {
  const code = HISTORY.code;
  const long = "remudero-review: PASS — ".repeat(12);
  const described = reviewDescriptionWithCodeProvenance(long, code);
  assert.ok(described.length <= 140, described);
  assert.ok(described.endsWith(`[review code ${code}]`), described);
  assert.equal(reviewCodeShaFromDescription(described), code);
  assert.equal(reviewDescriptionWithCodeProvenance(described, code), described, "re-applying the provenance never doubles it");
  assert.equal(reviewCodeShaFromDescription(`remudero-review: PASS [review code ${code.slice(0, 12)}]`), undefined, "a 12-character sha is incomplete");
  assert.equal(reviewCodeShaFromDescription("remudero-review: PASS"), undefined, "a legacy status names no sha");

  const dir = makeTempDir("t11847-post");
  const posted: Array<{ state: string; description?: string; sha: string }> = [];
  const result = await postReviewStatusGuarded({
    owner: OWNER, repo: REPO, sha: HEAD, state: "success", description: "remudero-review: PASS", taskId: TASK,
    evidence: "executed", ledgerPath: join(dir, "ledger.ndjson"), runId: "review-t11847", prUrl: URL,
    reviewerCodeFreshness: { status: "fresh", codeSha: code, originMainSha: code, advance: "none" },
    readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
    fetchLifecycle: () => ({ merged: false, closed: false }),
    post: (status) => { posted.push(status); },
  });
  assert.equal(result.posted, true, result.reason);
  assert.equal(posted[0]?.sha, HEAD, "the status binds the exact PR head");
  assert.equal(reviewCodeShaFromDescription(posted[0]?.description), code);

  // The sweep's verdict reuse writes a review.posted row of its own; it keeps the full sha of the code that judged it.
  const reuse = adapterFixture(t, { reviewer_code_sha: code }, code);
  await withLiveWritesAllowed(() => reuse.effects.postReview!(reuse.pr, { kind: "reuse", judgedHeadSha: "e".repeat(40) }));
  const row = readLedgerLines(reuse.ledgerPath).findLast((r) => r.step === "review.posted" && r.review_reused === true);
  assert.ok(row, JSON.stringify(reuse.calls));
  assert.equal(row.head_sha, HEAD);
  assert.equal(row.reviewer_code_sha, code);
  assert.match(reuse.posts().join("\n"), new RegExp(`review code ${code}`));
});

test("W1-T11847: one reviewer-code advance posts pending and admits one review", async (t) => {
  const gh = shim(t);
  const f = sweepFixture(t, HISTORY.material);
  f.deliver();
  f.setOnReview(() => {
    assert.equal(gh.posts().filter((call) => call.includes("state=pending")).length, 1, "pending is posted before the review is admitted");
    // The admitted review is still judging: its own pending row is the newest review row for this head.
    appendLedger(f.ledgerPath, { run_id: "review-fresh", task_id: TASK, step: "review.posted", state: "pending", pr_url: URL,
      head_sha: HEAD, review_input_digest: DIGEST, decision_verdict: { ...verdict(), state: "pending" } });
  });
  const first = await f.run();
  assert.equal(first?.disposition, "post-review", JSON.stringify(first));
  assert.deepEqual(f.reviews.map((mode) => mode.kind), ["full-review"]);
  const [requeue] = f.requeues();
  assert.equal(f.requeues().length, 1);
  assert.equal(requeue?.pr_url, URL);
  assert.equal(requeue?.head_sha, HEAD);
  assert.equal(requeue?.judged_reviewer_code_sha, HISTORY.code);
  assert.equal(requeue?.origin_main_sha, HISTORY.material);
  assert.equal(requeue?.requeue_key, `${URL}|${HEAD}|${HISTORY.code}`);

  for (let pass = 0; pass < 2; pass++) await f.run({ ...f.pr, reviewState: "pending" });
  assert.equal(f.requeues().length, 1, "repeated sweeps of the same URL, head and code sha add no requeue");
  assert.equal(f.reviews.length, 1, "repeated sweeps enqueue no duplicate review");
  assert.equal(gh.posts().length, 1, "repeated sweeps post no second status");
});

test("W1-T11847: failure becomes pending before the only fresh terminal review", async (t) => {
  const gh = shim(t, { liveState: "failure" });
  const f = sweepFixture(t, HISTORY.material, { reviewState: "failure", unmetCriteria: verdict("failure").criteria });
  f.deliver({ state: "failure", decision_verdict: verdict("failure") });
  f.setOnReview(() => appendLedger(f.ledgerPath, { run_id: "review-fresh", task_id: TASK, step: "review.posted", state: "success",
    pr_url: URL, head_sha: HEAD, review_input_digest: DIGEST, decision_verdict: verdict(), reviewer_code_sha: HISTORY.material }));
  await f.run();
  assert.deepEqual(f.reviews.map((mode) => mode.kind), ["full-review"]);
  assert.deepEqual(gh.posts().map((call) => /state=(\w+)/.exec(call)?.[1]), ["pending"], "the old failure is never re-posted");
  const after = await f.run({ ...f.pr, reviewState: "success", unmetCriteria: [] });
  assert.equal(after?.disposition, "mergeable", "the fresh verdict of current reviewer code stands");
  assert.equal(f.requeues().length, 1);
  assert.equal(f.reviews.length, 1);

  // A moved head has no delivered verdict: nothing is requeued and nothing is posted on the old head.
  const movedGh = shim(t);
  const moved = sweepFixture(t, HISTORY.material, { headSha: "f".repeat(40), reviewState: "none" });
  moved.deliver();
  await moved.run();
  assert.equal(moved.requeues().length, 0);
  assert.equal(movedGh.posts().length, 0);

  // A closed PR refuses the pending post, so no review is admitted and no status is written.
  const closedGh = shim(t, { lifecycle: "closed" });
  const closed = sweepFixture(t, HISTORY.material);
  closed.deliver();
  const row = await closed.run();
  assert.equal(row?.disposition, "wait", JSON.stringify(row));
  assert.equal(closed.reviews.length, 0);
  assert.equal(closedGh.posts().length, 0);
});

function attestApi(state: string | undefined, description: string | undefined, statusSha: string = HEAD) {
  return async (url: string) => {
    const path = url.replace("https://api.github.com", "");
    const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (path.startsWith("/repos/o/r/compare/")) return reply({ commits: [{ sha: "s0", commit: { message: "a change (#12)" } }] });
    if (path === "/repos/o/r/pulls/12") return reply({ head: { sha: HEAD } });
    if (path.startsWith(`/repos/o/r/commits/${HEAD}/status`)) {
      return reply({ sha: statusSha, statuses: state === undefined ? [] : [{ context: "remudero-review", state, description }] });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

async function attestAt(mainSha: string | undefined, state: string | undefined, description: string | undefined, statusSha?: string) {
  const repo = gitRepo({ kind: "t11847-attest", cloneFrom: HISTORY.dir });
  if (mainSha === undefined) repo.git("update-ref", "-d", "refs/remotes/origin/main");
  else repo.git("update-ref", "refs/remotes/origin/main", mainSha);
  const event = { merge_group: { head_sha: "c".repeat(40), base_sha: "b".repeat(40), head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${"a".repeat(40)}` } };
  return attest({ event, repo: "o/r", token: "t", fetchImpl: attestApi(state, description, statusSha), repoDir: repo.dir }) as Promise<{ ok: boolean; lines: string[] }>;
}

test("W1-T11847: stale or incomplete reviewer-code provenance cannot attest merge", async () => {
  const full = `remudero-review: PASS [review code ${HISTORY.code}]`;
  const current = await attestAt(HISTORY.immaterial, "success", full);
  assert.equal(current.ok, true, current.lines.join("\n"));
  const refusals: Array<[string, Awaited<ReturnType<typeof attestAt>>]> = [
    ["stale", await attestAt(HISTORY.material, "success", full)],
    ["short", await attestAt(HISTORY.immaterial, "success", `remudero-review: PASS [review code ${HISTORY.code.slice(0, 12)}]`)],
    ["legacy", await attestAt(HISTORY.immaterial, "success", "remudero-review: PASS")],
    ["missing", await attestAt(HISTORY.immaterial, undefined, undefined)],
    ["pending", await attestAt(HISTORY.immaterial, "pending", full)],
    ["unknown code", await attestAt(HISTORY.immaterial, "success", `remudero-review: PASS [review code ${"9".repeat(40)}]`)],
    ["unreadable main", await attestAt(undefined, "success", full)],
    ["another head", await attestAt(HISTORY.immaterial, "success", full, "e".repeat(40))],
  ];
  for (const [name, result] of refusals) assert.equal(result.ok, false, `${name}: ${result.lines.join("\n")}`);
  assert.match(refusals[0]![1].lines.join("\n"), /stale/);
});

test("W1-T11847: unrelated main churn leaves the reviewer-code result current", async (t) => {
  const gh = shim(t);
  const f = sweepFixture(t, HISTORY.immaterial);
  f.deliver();
  const row = await f.run();
  assert.equal(row?.disposition, "mergeable", JSON.stringify(row));
  assert.deepEqual(f.armed, [PR]);
  assert.equal(f.requeues().length, 0, "an advance that cannot change the verdict requeues nothing");
  assert.equal(f.reviews.length, 0);
  assert.equal(gh.posts().length, 0, "the current verdict is left as it is on GitHub");
  const attested = await attestAt(HISTORY.immaterial, "success", `remudero-review: PASS [review code ${HISTORY.code}]`);
  assert.equal(attested.ok, true, attested.lines.join("\n"));
});

function adapterFixture(t: TestContext, row: Record<string, unknown>, mainSha: string) {
  const root = makeTempDir("t11847-adapter");
  const ledgerPath = join(root, "ledger.ndjson");
  const gh = shim(t);
  appendLedger(ledgerPath, { run_id: "review-original", task_id: TASK, step: "review.posted", state: "success", pr_url: URL,
    head_sha: HEAD, review_input_digest: DIGEST, decision_verdict: verdict(), ...row });
  const calls: string[] = [];
  const unexpected = (): never => { throw new Error("the adapter made an unexpected host call"); };
  const host = {
    freshTreeGit: unexpected,
    realDeps: () => ({ reviewWorktree: { addWorktree: unexpected } }),
    buildFreshTreeReviewRunner: () => unexpected,
    buildReviewerCodeFreshnessGate: () => ({ call: unexpected, staleThisPass: () => undefined }),
    buildBaseReproductionProbe: () => unexpected, buildImportClosureRead: () => unexpected,
    buildRequiredFixReviewRunner: () => unexpected, readyDraftViaGh: () => unexpected,
    reviewPostedDescription: (posted: { summary: string }) => posted.summary,
  } as unknown as SweepCommandHost & Required<Pick<SweepCommandHost, "freshTreeGit">>;
  const effects = commandEffects(host, {
    owner: OWNER, repo: REPO, localRepoName: "not-scratch", config: { root } as never, ledgerPath, runId: "adapter-t11847",
    plan: { tasks: [], byId: new Map() } as never, log: (step) => calls.push(step),
    reviewRunner: async () => { calls.push("full-review"); return 0; },
    reviewerCodeFreshnessImpl: () => ({ status: "fresh", codeSha: mainSha, originMainSha: mainSha, advance: "none" }),
  });
  const pr = { prNumber: PR, prUrl: URL, taskId: TASK, headSha: HEAD, reviewInputDigest: DIGEST, reviewState: "pending",
    reviewPendingSince: "2026-11-11T12:43:17.000Z", checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    // expiring-fixture: exempt -- the adapter is called directly, so no stale-days disposition is derived.
    lastActivityAt: "2026-11-11T12:00:00Z", currentOwnDiffDigest: "own", currentMergeBaseSha: "b".repeat(40) } as OpenPrView;
  return { effects, pr, calls, ledgerPath, posts: gh.posts };
}

function outboxEntry(ledgerPath: string, codeSha: string | undefined): void {
  const path = reviewOutboxEntryPath(ledgerPath, URL, DIGEST);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    version: 1, input_key: DIGEST, head_sha: HEAD, state: "success", owner: OWNER, repo: REPO, task_id: TASK, pr_url: URL,
    run_id: "review-outboxed", evidence: "executed", review_decision_digest: "decision", decision_verdict: verdict(),
    description: codeSha === undefined ? "remudero-review: PASS" : reviewDescriptionWithCodeProvenance("remudero-review: PASS", codeSha),
    ...(codeSha === undefined ? {} : { reviewer_code_sha: codeSha }), written_at: "2026-11-11T12:00:00.000Z",
  })}\n`);
}

test("W1-T11847: a reused, restored or outboxed verdict carries current reviewer code", async (t) => {
  // Verdict reuse whose prior verdict names no reviewer-code sha runs one fresh review instead of re-posting it.
  const reuse = adapterFixture(t, {}, HISTORY.code);
  await withLiveWritesAllowed(() => reuse.effects.postReview!(reuse.pr, { kind: "reuse", judgedHeadSha: "e".repeat(40) }));
  assert.deepEqual(reuse.calls.filter((step) => step === "full-review"), ["full-review"]);
  assert.equal(reuse.posts().length, 0);
  assert.equal(readLedgerLines(reuse.ledgerPath).some((r) => r.review_reused === true), false);

  // A restore of a delivered verdict whose reviewer code is missing, or cannot be shown current against origin/main
  // in the reviewer's own checkout, posts nothing and writes no restore row.
  const regression = `input:${JSON.stringify([TASK, URL, HEAD, DIGEST])}|2026-11-11T12:43:17.000Z`;
  for (const row of [{}, { reviewer_code_sha: HISTORY.code }]) {
    const withheld = adapterFixture(t, row, HISTORY.material);
    await withLiveWritesAllowed(() => withheld.effects.postReview!(withheld.pr, { kind: "restore", judgedHeadSha: HEAD, regressionKey: regression }));
    assert.equal(withheld.posts().length, 0, JSON.stringify(row));
    assert.equal(readLedgerLines(withheld.ledgerPath).some((r) => r.step === REVIEW_STATUS_RESTORED_STEP), false);
  }
  // The same restore from the code origin/main names posts the delivered state with the full sha.
  const fresh = adapterFixture(t, { reviewer_code_sha: HISTORY.code }, HISTORY.code);
  await withLiveWritesAllowed(() => fresh.effects.postReview!(fresh.pr, { kind: "restore", judgedHeadSha: HEAD, regressionKey: regression }));
  assert.match(fresh.posts().join("\n"), new RegExp(`state=success[\\s\\S]*review code ${HISTORY.code}`));
  assert.equal(readLedgerLines(fresh.ledgerPath).findLast((r) => r.step === REVIEW_STATUS_RESTORED_STEP)?.reviewer_code_sha, HISTORY.code);

  // The outbox drain discards a stored verdict whose reviewer code is missing or stale, and posts a current one.
  const drained: Record<string, { outcome: string; posts: number; row?: Record<string, unknown> }> = {};
  for (const [name, codeSha, mainSha] of [["missing", undefined, HISTORY.code], ["stale", HISTORY.code, HISTORY.material],
    ["current", HISTORY.code, HISTORY.immaterial]] as const) {
    const ledgerPath = join(makeTempDir("t11847-outbox"), "ledger.ndjson");
    outboxEntry(ledgerPath, codeSha);
    const posted: Array<{ description?: string }> = [];
    const result = await drainReviewOutbox({
      owner: OWNER, repo: REPO, sha: HEAD, taskId: TASK, runId: "drain-t11847", ledgerPath, prUrl: URL, reviewInputDigest: DIGEST,
      fetchLifecycle: () => ({ merged: false, closed: false }), readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
      post: (status) => { posted.push(status); }, judgeReviewerCode: judgeAt(mainSha),
    });
    drained[name] = { outcome: result.outcome, posts: posted.length,
      row: readLedgerLines(ledgerPath).findLast((r) => r.step === "review.posted") };
    if (name === "current") assert.equal(reviewCodeShaFromDescription(posted[0]?.description), HISTORY.code);
  }
  assert.deepEqual([drained.missing?.outcome, drained.missing?.posts], ["discarded", 0]);
  assert.deepEqual([drained.stale?.outcome, drained.stale?.posts], ["discarded", 0]);
  assert.deepEqual([drained.current?.outcome, drained.current?.posts], ["posted", 1]);
  assert.equal(drained.current?.row?.reviewer_code_sha, HISTORY.code);
});
