// W1-T15030: a review run renews its GitHub App token before it publishes, retries once on HTTP 401, posts only while it
// holds its claim, and a run that dies leaves no pending status the sweep cannot re-admit.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { failureRecordingPoster, renewingIssueGateway, reviewCommand, type ReviewCommandDeps, type ReviewCommandHost, runReview,
  withdrawAfterPublication, withdrawArmIfVerdictRefusesAsync } from "#src/cli/commands/review.js";
import { disarmAutoMergeAsync } from "#src/lib/arm-auto-merge.js";
import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import { startInstallationTokenRefresh } from "#src/lib/github-app.js";
import { appendLedger } from "#src/lib/ledger.js";
import type { Mount } from "#src/lib/mounts.js";
import type { AcceptanceCriterion } from "#src/lib/plan.js";
import { holdReviewRunLive, postReviewPending, postReviewStatusGuarded, postUnreadTaskHoldGuarded, refreshReviewPublisherToken,
  renewReviewPublisherToken, reviewDecisionDigest, reviewInputDigest, reviewOwnerOrphaned } from "#src/lib/review.js";
import { tryEscalateAsync } from "#src/lib/escalate.js";
import { readFileSync } from "node:fs";
import { buildOpenPrViewsAsync } from "#src/lib/tick-read-worker.js";
import { readLedgerLines } from "#src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, orphanedOwnerRetryView, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };
const HEAD = "abc1234def5678";
const PR_URL = "https://github.com/acme/remudero/pull/1";

/** The host members runReview uses on this path; calling any other one fails the test by name. */
function hostFor(): ReviewCommandHost {
  const used: Partial<ReviewCommandHost> = {
    JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
    acceptedReviewAttemptId: () => undefined,
    reviewPostedDescription: (verdict) => verdict.summary,
    liveWorkerRunIds: new Set<string>(),
    reviewWorkerLockId: (runId) => `review-worker-${runId}`,
    readHeadShaRest: () => HEAD,
  };
  return new Proxy(used, {
    get(target, key) {
      if (key in target) return target[key as keyof ReviewCommandHost];
      if (key === "then" || key === "triagePullRequest" || key === "reviewWorktreeAsync") return undefined;
      return () => { throw new Error(`host.${String(key)} was called`); };
    },
  }) as ReviewCommandHost;
}

/** The shared `gh` shim's table for runReview's reads. A terminal status POST answers as GitHub's 401 does until a test
 *  adds a route ahead of it. */
const REFUSED_POST = { when: "state=failure", stderr: "gh: Bad credentials (HTTP 401)", exit: 1 };
const READS = [
  { when: "/statuses?", stdout: "[[]]" },
  { when: "reviews?", stdout: "[]" },
  { when: "reviews", stdout: "{}" },
  { when: "pulls/", stdout: JSON.stringify({ number: 1, html_url: PR_URL, state: "open", merged: false, updated_at: "t", body: "",
    head: { ref: "b", sha: HEAD }, base: { ref: "main" } }) },
];

/** reviewCommand's host for the start-failed path; unreached dependencies refuse loudly. */
const START_HOST = {
  GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
  acceptedReviewAttemptId: () => undefined, reviewWorktreeAsync: { fetch: () => {} },
  materializeReviewWorktree: () => { throw new Error("forbidden real materialization"); },
  realDeps: () => { throw new Error("forbidden default worker graph"); },
  reviewPostedDescription: () => "fixture",
  liveWorkerRunIds: new Set<string>(), reviewWorkerLockId: (id: string) => `fixture-${id}`,
} as unknown as ReviewCommandHost;
const REPO_ROOT_FOR_TEST = REPO_ROOT;

const UNMET: AcceptanceCriterion[] = [{ claim: "VISIBLE-CLAIM the surface behaves", proof: "unit test: never-matches-W1-T15030" }];

/** Drive the real runReview to a failing verdict (the keyword floor finds nothing), which withdraws an arm and posts.
 *  `refuse`: the terminal post answers 401 until the run renews its token (`renewAccepted`), or always. */
async function reviewFailing(t: TestContext, opts: {
  token: string; refuse?: boolean; renewAccepted?: boolean; runId?: string;
  midRun?: (ledgerPath: string) => void;
  /** Runs while the run awaits its reviewer-code freshness read, after its first claim check. */
  duringFreshness?: (ledgerPath: string) => void;
}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t15030-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const savedToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = opts.token;
  const order: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const renewals: Array<{ force?: boolean }> = [];
  try {
    return await withGhShim([...(opts.refuse === true ? [REFUSED_POST] : []), ...READS], async (shim) => {
      const verdict = await runReview(hostFor(), {
        owner: "acme", repo: "remudero", prUrl: PR_URL,
        task: { id: "W1-T15030", acceptance: UNMET },
        report: "", settingsFile: join(root, "settings.json"), config: { claudeBin: "/bin/true", root } as Config,
        log: (step, extra = {}) => { logged.push({ ...extra, step }); }, say: () => {},
        account: (r: WorkerResult) => r, spawnReviewer: false, reviewerMount: MOUNT,
        ledgerPath, runId: opts.runId ?? "review-PR1-1",
        readReviewReuseFacts: () => { opts.midRun?.(ledgerPath); return undefined; },
        ...(opts.duringFreshness === undefined ? {} : {
          reviewerCodeFreshness: async () => {
            opts.duringFreshness!(ledgerPath);
            return { status: "fresh" as const, codeSha: "c".repeat(40), originMainSha: "c".repeat(40), advance: "none" as const };
          } }),
        renewToken: async (o) => {
          renewals.push(o ?? {});
          order.push(`renew:${o?.force === true ? "forced" : "due"}`);
          if (opts.renewAccepted !== true) return "fresh";
          // GitHub accepts the renewed token.
          process.env.GH_TOKEN = "renewed-token";
          shim.addRoute({ when: "state=failure", stdout: "{}" });
          return "renewed";
        },
        disarm: () => {
          order.push(`disarm:${process.env.GH_TOKEN}`);
          return "disarmed" as const;
        },
      });
      const terminalPosts = shim.calls().filter((call) => call.includes("-X POST") && call.includes("state=failure")).length;
      return { verdict, order, renewals, terminalPosts, rows: [...readLedgerLines(ledgerPath), ...logged] };
    });
  } finally {
    if (savedToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedToken;
  }
}

/** An App key pair and a fake token exchange, so the real mint records this process's publisher token. */
function fakeApp(t: TestContext, expiresAtMs: () => number, token: () => string) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t15030-app-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const exchanges: string[] = [];
  const fetchImpl = (async () => {
    const minted = token();
    exchanges.push(minted);
    return new Response(JSON.stringify({ token: minted, expires_at: new Date(expiresAtMs()).toISOString() }), { status: 201 });
  }) as unknown as typeof fetch;
  return { pem, exchanges, fetchImpl };
}

test("W1-T15030 criterion 1: a review that outlives its token publishes with a renewed token", async (t) => {
  // The run started with a token GitHub now refuses; the renewal before publishing replaces it.
  const run = await reviewFailing(t, { token: "expired-token", refuse: true, renewAccepted: true });
  assert.equal(run.verdict.state, "failure");
  // The renewal comes first; the disarm presents the renewed token, and the one terminal post needs no retry.
  assert.deepEqual(run.order.slice(0, 2), ["renew:due", "disarm:renewed-token"]);
  assert.equal(run.terminalPosts, 1);
  assert.equal(run.rows.some((row) => row.step === "review.posted" && row.state === "failure"), true);
  assert.equal(run.rows.some((row) => row.step === "review.post_refused" && row.reason === "token_unrenewable"), false);

  // The default renewal: this process's own App token, renewed once it has under five minutes left.
  const saved = { ...process.env };
  t.after(() => { for (const key of ["GH_APP_ID", "GH_APP_INSTALLATION_ID", "GH_APP_PRIVATE_KEY_PATH", "GH_TOKEN"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  } });
  let clock = Date.parse("2026-11-26T17:00:00Z");
  let minted = 0;
  const app = fakeApp(t, () => clock + 60 * 60_000, () => `app-token-${++minted}`);
  Object.assign(process.env, { GH_APP_ID: "42", GH_APP_INSTALLATION_ID: "7", GH_APP_PRIVATE_KEY_PATH: "/unused.pem" });
  delete process.env.GH_TOKEN;
  const refresh = (o: Parameters<typeof refreshReviewPublisherToken>[0] = {}) =>
    refreshReviewPublisherToken({ ...o, now: () => clock, fetchImpl: app.fetchImpl, readKey: () => app.pem });
  assert.equal((await refresh()).ok, true);
  assert.equal(process.env.GH_TOKEN, "app-token-1");
  const notArmed = async () => "not_armed" as const;
  clock += 30 * 60_000;
  assert.equal(await renewReviewPublisherToken({ clock: clockFromMillisFn(() => clock), ensureHeld: notArmed, refresh }), "fresh");
  assert.equal(process.env.GH_TOKEN, "app-token-1");
  clock += 27 * 60_000;
  assert.equal(await renewReviewPublisherToken({ clock: clockFromMillisFn(() => clock), ensureHeld: notArmed, refresh }), "renewed");
  assert.equal(process.env.GH_TOKEN, "app-token-2");
  // A token this process did not mint is never renewed, and an armed refresh loop renews its own.
  process.env.GH_TOKEN = "operator-token";
  assert.equal(await renewReviewPublisherToken({ clock: clockFromMillisFn(() => clock), ensureHeld: notArmed, refresh }), "not_held");
  assert.equal(await renewReviewPublisherToken({ ensureHeld: async () => "renewed" }), "renewed");
  assert.equal(await renewReviewPublisherToken({ ensureHeld: async () => "token_expired" }), "token_unrenewable");
  assert.deepEqual(app.exchanges, ["app-token-1", "app-token-2"]);
});

test("W1-T15030 criterion 2: one renew-and-retry on 401, then a named refusal", async (t) => {
  // A 401 on the post and on its retry: one forced renewal between them, then a named refusal.
  const recovered = await reviewFailing(t, { token: "old-token", refuse: true });
  assert.equal(recovered.renewals.filter((o) => o.force === true).length, 1);
  assert.equal(recovered.terminalPosts, 2, "one post and one retry");
  const refused = recovered.rows.filter((row) => row.step === "review.post_refused" && row.reason === "token_unrenewable");
  assert.equal(refused.length, 1, "a second 401 is a named refusal");
  assert.equal(recovered.rows.some((row) => row.step === "review.posted" && row.state === "failure"), false,
    "the refused post leaves the status unchanged");

  // The disarm: one renewal and one retry on 401, then token_unrenewable.
  const said: string[] = [];
  let renewed = 0;
  const failing = (times: number) => {
    let calls = 0;
    return async () => {
      if (++calls <= times) throw Object.assign(new Error("gh failed"), { stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)" });
    };
  };
  const renewal = { renewToken: () => { renewed++; } };
  const deps = (times: number) => ({ disableAuto: failing(times), say: (m: string) => said.push(m), isMerged: () => false });
  assert.equal(await disarmAutoMergeAsync(PR_URL, deps(1), renewal), "disarmed");
  assert.equal(renewed, 1);
  assert.equal(await disarmAutoMergeAsync(PR_URL, deps(2), renewal), "token_unrenewable");
  assert.equal(renewed, 2);
  // Without a renewal, or on any other failure, the disarm is classified as before.
  assert.equal(await disarmAutoMergeAsync(PR_URL, deps(1)), "failed");
  const other = { disableAuto: async () => { throw new Error("can't disable auto-merge"); }, say: () => {}, isMerged: () => false };
  assert.equal(await disarmAutoMergeAsync(PR_URL, other, renewal), "not-armed");
  assert.equal(renewed, 2);
});

/** A sweep fixture over one green PR whose pending status names `runId`, claimed `ageMin` minutes ago. */
function orphanFixture(t: TestContext, ageMin: number, owner: { pid?: number; host?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t15030-sweep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const ledgerPath = join(dir, "ledger.ndjson");
  const runId = `review-PR15030-${now}`;
  const claimedAt = new Date(now - ageMin * 60_000).toISOString();
  const pr: OpenPrView = {
    prNumber: 15030, prUrl: "https://github.com/o/r/pull/15030", taskId: "W1-T15030",
    headSha: "orphan-head", reviewInputDigest: "orphan-input", reviewState: "pending", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: claimedAt,
    reviewPendingSince: claimedAt, reviewPendingOwnerRunId: runId, reviewPendingStatusRunId: runId,
  };
  appendLedger(ledgerPath, { run_id: runId, task_id: pr.taskId!, step: "review.pending_posted", pr_url: pr.prUrl,
    head_sha: pr.headSha, review_input_digest: pr.reviewInputDigest, owner_pid: owner.pid ?? process.pid,
    owner_started_at: claimedAt, ts: claimedAt, ...(owner.host === undefined ? {} : { host: owner.host }) });
  const posted: OpenPrView[] = [];
  const deps: SweepDeps = {
    ledgerPath, runId: "sweep-w1-t15030", now: () => now,
    arm: () => assert.fail("pending review cannot arm"), close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"), escalate: () => assert.fail("unexpected escalation"),
    postReview: (candidate) => { posted.push(candidate); },
    reviewerCodeRecovery: { loadedCodeSha: "fresh-code", isLoadedCodeAtOrAfter: () => true, freshTreeReviewAvailable: true,
      probeFreshness: async () => ({ status: "fresh", codeSha: "fresh-code", originMainSha: "fresh-code", advance: "none" }) },
  };
  const run = async () => {
    await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
    return { row: readLedgerLines(ledgerPath).findLast((row) => row.step === "sweep.disposed"), posted };
  };
  return { pr, runId, now, ledgerPath, run };
}

test("W1-T15030 criterion 3: an orphaned pending owner does not block re-admission", async (t) => {
  // 31 minutes silent, claimed under this process, and not live in it: the sweep re-admits the PR at that head.
  const orphan = orphanFixture(t, 31);
  const { row, posted } = await orphan.run();
  assert.equal(row?.disposition, "post-review", JSON.stringify(row));
  assert.equal(row?.owner_gone_cause, "owner-orphaned");
  assert.match(String(row?.reason), new RegExp(`run ${orphan.runId} has no live process and no ledger row for 30m`));
  assert.equal(posted.length, 1);

  // The same claim while its run is live here, or 29 minutes silent, or written on another host, is still owned.
  const live = orphanFixture(t, 31);
  const release = holdReviewRunLive(live.runId);
  try {
    const held = await live.run();
    assert.notEqual(held.row?.owner_gone_cause, "owner-orphaned");
    assert.equal(held.posted.length, 0);
  } finally {
    release();
  }
  const young = orphanFixture(t, 29);
  assert.equal((await young.run()).posted.length, 0);
  const lines = readLedgerLines(orphan.ledgerPath);
  assert.equal(reviewOwnerOrphaned(orphan.runId, "orphan-head", lines, { now: orphan.now }), true);
  assert.equal(reviewOwnerOrphaned(orphan.runId, "orphan-head", lines, { now: orphan.now, hostname: () => "other-host.example" }), false);
  // A claim under another pid is orphaned only once that pid is not alive.
  assert.equal(reviewOwnerOrphaned(orphan.runId, "orphan-head", lines, { now: orphan.now, pid: -1, isPidAlive: () => true }), false);
  assert.equal(reviewOwnerOrphaned(orphan.runId, "orphan-head", lines, { now: orphan.now, pid: -1, isPidAlive: () => false }), true);
  const view = orphanedOwnerRetryView(orphan.pr, lines, { now: orphan.now });
  assert.deepEqual([view.reviewPendingOwnerDead, view.reviewPendingOwnerGone], [true, "owner-orphaned"]);

  // The re-admitted review's own takeover agrees: under the 42 minute TTL, an orphaned owner holds nothing.
  const statuses: string[] = [];
  const taken = await postReviewPending({
    owner: "o", repo: "r", sha: "orphan-head", taskId: "W1-T15030", runId: "review-PR15030-next", ledgerPath: orphan.ledgerPath,
    prUrl: orphan.pr.prUrl, reviewInputDigest: "orphan-input",
    fetchLifecycle: () => ({ merged: false, closed: false }),
    fetchStatus: () => ({ statuses: [{ context: "remudero-review", state: "pending",
      description: `remudero-review: review in progress (owned by run ${orphan.runId})`, created_at: orphan.pr.reviewPendingSince }] }),
    post: (o) => { statuses.push(String(o.description)); },
    readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
    clock: fixedClock(orphan.now),
    // The daemon's own pid is alive, so the pid proves nothing; only the orphan rule can release the claim.
    assessPendingOwner: () => "active",
  });
  assert.equal(taken.posted, true, taken.reason);
  assert.match(statuses.at(-1) ?? "", new RegExp(`took over run ${orphan.runId}: owner orphaned`));
});

test("W1-T15030 criterion 4: a run that lost its claim cannot post", async (t) => {
  const runId = "review-PR1-lost";
  const run = await reviewFailing(t, { token: "fresh-token", runId, midRun: (ledgerPath) => {
    // Another run takes this run's claim over while its reviewer works.
    appendLedger(ledgerPath, { run_id: "review-PR1-taker", task_id: "W1-T15030", step: "review.pending_posted", pr_url: PR_URL,
      head_sha: HEAD, took_over_run_id: runId, owner_pid: process.pid, owner_started_at: new Date().toISOString() });
  } });
  assert.equal(run.verdict.verdictWithheld, "claim_lost");
  // No terminal post and no disarm; one claim_lost refusal naming the run that took over.
  assert.equal(run.terminalPosts, 0);
  assert.equal(run.order.some((step) => step.startsWith("disarm:")), false);
  const refused = run.rows.filter((row) => row.step === "review.post_refused" && row.reason === "claim_lost");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.taken_over_by_run_id, "review-PR1-taker");
  assert.equal(run.rows.some((row) => row.step === "escalation.filed" || row.step === "review.posted" && row.state !== "pending"), false);
});

test("W1-T15030 criterion 2: a 401 under an armed refresh loop mints a new token, not the timer's fresh one", async (t) => {
  // OBSERVED (review of e08b8f587): with the daemon's loop armed, a forced renewal read "fresh" while the timer was not
  // due, so the retry presented the token GitHub had just refused. Mints stayed 1.
  let clock = Date.parse("2026-11-27T04:00:00Z");
  let mints = 0;
  let accept = true;
  const env: Record<string, string | undefined> = { GH_APP_ID: "42", GH_APP_INSTALLATION_ID: "7", GH_APP_PRIVATE_KEY_PATH: "/unused.pem" };
  const loop = startInstallationTokenRefresh({ log: () => {}, env, now: () => clock, setTimer: () => ({}), clearTimer: () => {},
    refresh: async () => {
      if (!accept) return { ok: false, reason: "exchange_failed" };
      env.GH_TOKEN = `loop-token-${++mints}`;
      return { ok: true, expiresAtMs: clock + 60 * 60_000 };
    } });
  t.after(() => loop.stop?.());
  await loop.ready;
  assert.equal(mints, 1);
  clock += 10 * 60_000;
  // An unforced renewal of a token with 50 minutes left mints nothing.
  assert.equal(await renewReviewPublisherToken({}), "fresh");
  assert.equal(mints, 1);
  // THE CLAIM: a 401's forced renewal mints a new token in the armed loop.
  assert.equal(await renewReviewPublisherToken({ force: true }), "renewed");
  assert.equal(mints, 2);
  assert.equal(env.GH_TOKEN, "loop-token-2");
  // A forced mint that fails is unrenewable, never "fresh".
  accept = false;
  assert.equal(await renewReviewPublisherToken({ force: true }), "token_unrenewable");
});

test("W1-T15030 criterion 2: a disarm refused twice after publication is recorded, not discarded", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const ctx = { prUrl: PR_URL, taskId: "W1-T15030", headSha: HEAD, ledgerPath: "/unused/ledger.ndjson", runId: "review-PR1-1",
    log: (step: string, extra: Record<string, unknown> = {}) => { rows.push({ ...extra, step }); } };
  const pending = { state: "pending" as const, capped: false, planOnly: false };
  const held = await withdrawAfterPublication(pending, ctx, { disarm: () => "token_unrenewable", claimLost: async () => undefined });
  assert.equal(held, "token_unrenewable");
  assert.deepEqual(rows.filter((row) => row.step === "review.post_refused").map((row) => row.reason), ["token_unrenewable"],
    "THE CLAIM: the twice-refused disarm is a named refusal, not discarded");
  rows.length = 0;
  assert.equal(await withdrawAfterPublication(pending, ctx, { disarm: () => "disarmed", claimLost: async () => undefined }), undefined);
  assert.equal(rows.some((row) => row.step === "review.post_refused"), false, "control: a disarm that worked records no refusal");
});

test("W1-T15030 criterion 2: a status post that succeeds on retry is not recorded as failed", async () => {
  await withGhShim([{ when: "state=pending", stderr: "gh: Bad credentials (HTTP 401)", exit: 1 }], async (shim) => {
    const poster = failureRecordingPoster();
    const o = { owner: "acme", repo: "remudero", sha: HEAD, state: "pending" as const, description: "d" };
    await assert.rejects(poster.post(o));
    assert.equal(poster.failed(), true);
    shim.addRoute({ when: "state=pending", stdout: "{}" });
    await poster.post(o);
    assert.equal(poster.published(), true);
    assert.equal(poster.failed(), false, "THE CLAIM: the retry that published clears the earlier failure");
  });
});

test("W1-T15030 criterion 4: a takeover during the freshness read is seen under the status lock, and nothing posts", async (t) => {
  // OBSERVED (review of e08b8f587): the one claim check ran before the awaited freshness read, so a takeover appended
  // during it was missed and the run still posted failure.
  const runId = "review-PR1-raced";
  const run = await reviewFailing(t, { token: "fresh-token", runId, duringFreshness: (ledgerPath) => {
    appendLedger(ledgerPath, { run_id: "review-PR1-taker", task_id: "W1-T15030", step: "review.pending_posted", pr_url: PR_URL,
      head_sha: HEAD, took_over_run_id: runId, owner_pid: process.pid, owner_started_at: new Date().toISOString() });
  } });
  assert.equal(run.verdict.verdictWithheld, "claim_lost");
  assert.equal(run.terminalPosts, 0, "THE CLAIM: the post re-reads the claim under its lock");
  const refused = run.rows.filter((row) => row.step === "review.post_refused" && row.reason === "claim_lost");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.taken_over_by_run_id, "review-PR1-taker");
  // The one disarm ran before the takeover, while the run still held its claim; none follows it.
  assert.equal(run.order.filter((step) => step.startsWith("disarm:")).length, 1);
  assert.equal(run.rows.some((row) => row.step === "escalation.filed" || row.step === "review.posted"), false);

  // The guarded post itself: a named taker refuses before any post, and a held claim posts.
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t15030-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  let posts = 0;
  const base = { owner: "acme", repo: "remudero", sha: HEAD, state: "pending" as const, description: "d", taskId: "W1-T15030",
    evidence: "no_evidence" as const, ledgerPath, runId, prUrl: PR_URL, post: async () => { posts++; },
    fetchLifecycle: async () => ({ state: "open" as const }) };
  const lost = await postReviewStatusGuarded({ ...base, claimLost: async () => "review-PR1-taker" } as never);
  assert.equal(lost.posted, false);
  assert.equal(lost.claimLost, "review-PR1-taker");
  assert.equal(posts, 0);
  assert.equal(readLedgerLines(ledgerPath).filter((row) => row.step === "review.post_refused" && row.reason === "claim_lost").length, 1);
});

test("W1-T15030 criterion 4: a run that lost its claim posts no start-failed pending", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t15030-start-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  const outcome = "spawn_error";
  const run = async (takeOver: boolean) => {
    const posted: Array<{ state: string; taker?: string }> = [];
    const deps: ReviewCommandDeps = {
      fetchView: () => ({ headRefOid: HEAD, headRefName: "codex/t15030-start", number: 1, url: PR_URL,
        body: "## Acceptance\n- it works | grep: review in src/lib/review.ts\n" }),
      fetchHead: () => {},
      loadConfig: () => ({ root, installRoot: REPO_ROOT_FOR_TEST, claudeBin: "/bin/true" }) as Config,
      postReviewPending: (async () => ({ posted: true })) as never,
      materialize: (() => ({ worktreePath: undefined, failure: { errorClass: "test", message: "fixture" } })) as never,
      runReview: (async (args: { log: (step: string, extra?: Record<string, unknown>) => void; ledgerPath: string; runId: string }) => {
        if (takeOver) appendLedger(args.ledgerPath, { run_id: "review-PR1-taker", task_id: "W1-T15030", step: "review.pending_posted",
          pr_url: PR_URL, head_sha: HEAD, took_over_run_id: args.runId, owner_pid: process.pid, owner_started_at: new Date().toISOString() });
        args.log("review.semantic_incomplete", { reason: `required-semantic-${outcome}`, head_sha: HEAD, pr_url: PR_URL, reviewer_outcome: outcome });
        return { state: "failure", criteria: [], testTheater: false, summary: "s", floorDegraded: true, capped: true, keywordOnly: false,
          planOnly: false, headSha: HEAD, reviewerOutcome: outcome, verdictWithheld: `required-semantic-${outcome}` };
      }) as never,
      // The real guarded post refuses a lost claim; this records what the start-failed post hands it.
      postStatus: (async (opts: Parameters<typeof postReviewStatusGuarded>[0]) => {
        posted.push({ state: opts.state, taker: await opts.claimLost?.() });
        return { posted: true };
      }) as never,
    };
    await reviewCommand(START_HOST, "codex/t15030-start", ["--repo", "acme/remudero"], deps);
    return posted;
  };
  const held = await run(false);
  assert.deepEqual(held, [{ state: "pending", taker: undefined }], "control: a run that holds its claim posts the start-failed pending");
  const lost = await run(true);
  assert.deepEqual(lost, [{ state: "pending", taker: "review-PR1-taker" }],
    "THE CLAIM: the start-failed pending carries the claim check, so the guarded post refuses it claim_lost");
});

const UNAUTHORIZED = () => { throw Object.assign(new Error("gh: Bad credentials (HTTP 401)"), { stderr: "HTTP 401" }); };

test("W1-T15030 criterion 2: an input refused token_unrenewable is re-reviewed on the next pass", async (t) => {
  // OBSERVED (review of 43c9ee208): the row carried review_input_digest, the sweep folded it into the durable
  // reviewRefused, and that input was never reviewed again, 24 hours later. A 403 (review.post_failed) was.
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t15030-refold-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pass = async (reason: "token_unrenewable" | "other") => {
    mkdirSync(join(dir, reason));
    const ledgerPath = join(dir, reason, "ledger.ndjson");
    const pr: OpenPrView = {
      prNumber: 15031, prUrl: "https://github.com/o/r/pull/15031", taskId: "W1-T15030", headSha: "refused-head",
      reviewInputDigest: "refused-input", reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0,
      autoMergeArmed: false, lastActivityAt: new Date().toISOString(),
    };
    // The real row: the guarded post refused twice with 401 writes it.
    const posting = await postReviewStatusGuarded({ owner: "o", repo: "r", sha: pr.headSha, state: "pending", description: "d",
      taskId: pr.taskId!, evidence: "no_evidence", ledgerPath, runId: "review-PR15031-1", prUrl: pr.prUrl,
      reviewInputDigest: pr.reviewInputDigest, fetchLifecycle: () => ({ merged: false, closed: false }),
      renewToken: async () => "renewed", post: UNAUTHORIZED });
    assert.equal(posting.posted, false);
    const row = readLedgerLines(ledgerPath).find((line) => line.step === "review.post_refused")!;
    assert.equal(row.reason, "token_unrenewable");
    assert.equal(row.review_input_digest, "refused-input", "the real row carries the input digest");
    if (reason === "other") {
      // Control: the same row with a durable reason stays refused.
      const { ts: _ts, ...rest } = row;
      appendLedger(ledgerPath, { ...rest, run_id: String(row.run_id), task_id: String(row.task_id), step: "review.post_refused",
        reason: "a durable refusal" });
    }
    const posted: OpenPrView[] = [];
    const deps: SweepDeps = {
      ledgerPath, runId: "sweep-w1-t15030-refold", now: () => Date.now(),
      arm: () => {}, close: () => assert.fail("unexpected close"), dispatchFix: () => assert.fail("unexpected fix"),
      escalate: () => {}, postReview: (candidate) => { posted.push(candidate); },
      reviewerCodeRecovery: { loadedCodeSha: "fresh-code", isLoadedCodeAtOrAfter: () => true, freshTreeReviewAvailable: true,
        probeFreshness: async () => ({ status: "fresh", codeSha: "fresh-code", originMainSha: "fresh-code", advance: "none" }) },
    };
    await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
    return posted.length;
  };
  assert.equal(await pass("token_unrenewable"), 1, "THE CLAIM: the next pass re-reviews the refused input");
  assert.equal(await pass("other"), 0, "control: a durable refusal of the same input is not re-reviewed");
});

const EVALUATOR = (sessionId: string) => ({ provider: "codex", requestedModel: "m", servedModel: "m", effort: "high", sessionId });

test("W1-T15030 criterion 2: the conflicting-verdict hold renews a refused token and retries once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t15030-conflict-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const digest = reviewDecisionDigest({ headSha: HEAD, diff: "diff --git a/a.ts b/a.ts\n+export const a = 1;\n", report: "r",
    body: "b", acceptance: [{ claim: "works", proof: "unit test: test/a.test.ts" }], declaredFiles: ["src/a.ts"] });
  const conflict = async (refusals: number) => {
    mkdirSync(join(dir, `conflict-${refusals}`));
    const ledgerPath = join(dir, `conflict-${refusals}`, "ledger.ndjson");
    appendLedger(ledgerPath, { run_id: "review-prior", task_id: "W1-T15030", step: "review.posted", pr_url: PR_URL, head_sha: HEAD,
      state: "success", review_decision_digest: digest, reviewer_outcome: "reviewer_completed", evaluator_provenance: EVALUATOR("prior"),
      decision_verdict: { state: "success", criteria: [], testTheater: false, summary: "s", floorDegraded: false, capped: false,
        keywordOnly: false, planOnly: false } });
    let calls = 0;
    let renewals = 0;
    const result = await postReviewStatusGuarded({ owner: "o", repo: "r", sha: HEAD, state: "failure", taskId: "W1-T15030",
      evidence: "executed", ledgerPath, runId: "review-attempt", prUrl: PR_URL, reviewDecisionDigest: digest,
      evaluatorProvenance: EVALUATOR("attempt"),
      readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }), fetchLifecycle: () => ({ merged: false, closed: false }),
      renewToken: async () => { renewals++; return "renewed"; },
      post: () => { if (++calls <= refusals) UNAUTHORIZED(); } });
    return { result, calls, renewals, rows: readLedgerLines(ledgerPath) };
  };
  const recovered = await conflict(1);
  assert.equal(recovered.result.conflict, true, JSON.stringify(recovered.result));
  assert.equal(recovered.result.posted, true, "THE CLAIM: one 401, one renewal, and the retried conflict hold lands");
  assert.deepEqual([recovered.calls, recovered.renewals], [2, 1]);
  const refused = await conflict(2);
  assert.equal(refused.result.posted, false);
  assert.equal(refused.rows.filter((row) => row.step === "review.post_refused" && row.reason === "token_unrenewable").length, 1,
    "a second 401 is a named refusal");
});

test("W1-T15030 criterion 3: a review run called the way runTask calls it stays live past the orphan window", async (t) => {
  // OBSERVED (review of 43c9ee208): only reviewCommand held its run live, so a runTask or fix-lane review claimed under the
  // daemon's pid read as orphaned after 30 silent minutes, and a live run was taken over at 31.
  const runId = "review-PR1-run-task";
  let duringRun: boolean | undefined;
  const window = 31 * 60_000;
  const run = await reviewFailing(t, { token: "fresh-token", runId, midRun: (ledgerPath) => {
    appendLedger(ledgerPath, { run_id: runId, task_id: "W1-T15030", step: "review.pending_posted", pr_url: PR_URL, head_sha: HEAD,
      owner_pid: process.pid, owner_started_at: new Date().toISOString() });
    duringRun = reviewOwnerOrphaned(runId, HEAD, readLedgerLines(ledgerPath), { now: Date.now() + window });
  } });
  assert.equal(run.verdict.state, "failure");
  assert.equal(duringRun, false, "THE CLAIM: the live run is held live inside runReview itself, so it is not orphaned");
  // Control: once the run has returned, the same silence is an orphan.
  const lines = run.rows.filter((row) => row.step === "review.pending_posted");
  assert.equal(reviewOwnerOrphaned(runId, HEAD, lines, { now: Date.now() + window }), true);
  // Nested holds: an outer hold (reviewCommand's) outlives an inner one's release.
  const outer = holdReviewRunLive("nested-run");
  holdReviewRunLive("nested-run")();
  assert.equal(reviewOwnerOrphaned("nested-run", HEAD, [{ run_id: "nested-run", step: "review.pending_posted", head_sha: HEAD,
    owner_pid: process.pid, ts: new Date().toISOString() }], { now: Date.now() + window }), false);
  outer();
});

/** W1-T15030 — THE RENEW-AND-RETRY CENSUS. Every GitHub write a review run can reach, by symbol:
 *  status posts (all through postRenewingOnce in src/lib/review.ts):
 *    - publishReviewStatusLocked's decision post: the terminal verdict (postReviewStatusGuarded)
 *    - postReviewPending's claim post (also the start-failed pending, via postReviewStatusGuarded)
 *    - publishSemanticHold, publishCappedHold, publishTaskHold, postUnreadTaskHoldGuarded: the hold posts
 *    - postReviewStatusGuarded's conflicting-verdict hold
 *    - drainReviewOutbox and the replay restore: they publish through postReviewStatusGuarded
 *    - failureRecordingPoster: the raw poster each of those is handed as `post`
 *  disarms (disarmAutoMergeAsync with a renewal, src/lib/arm-auto-merge.ts):
 *    - withdrawArmIfVerdictRefusesAsync: the pre-post withdrawal
 *    - withdrawAfterPublication: every withdrawal after publication, the replay's and the disputed-pass hold's
 *  escalation posts (renewingIssueGateway, src/cli/commands/review.ts):
 *    - holdDisputedPass, cannotEvaluateEscalation (run and replay), the managed-checkout install escalation
 *  Each site is driven through its real entry point with 401-then-ok (lands after one renewal) and 401-then-401 (a
 *  token_unrenewable refusal is recorded and nothing lands). A source census below fails when a site is added outside
 *  these helpers. */
type Drive = (refusals: number) => Promise<{ landed: boolean; renewals: number; unrenewable: number }>;

function censusLedger(t: TestContext, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rmd-w1-t15030-census-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "ledger.ndjson");
}
const refusing = (refusals: number, onLand: () => void) => {
  let calls = 0;
  return () => { if (++calls <= refusals) UNAUTHORIZED(); onLand(); };
};
const unrenewableRows = (ledgerPath: string) =>
  readLedgerLines(ledgerPath).filter((row) => row.step === "review.post_refused" && row.reason === "token_unrenewable").length;

const statusSite = (t: TestContext, name: string, publish: (o: { ledgerPath: string; post: () => void;
  renewToken: () => Promise<"renewed"> }) => Promise<unknown>): Drive => async (refusals) => {
  const ledgerPath = censusLedger(t, `${name}-${refusals}`);
  let landed = false;
  let renewals = 0;
  await publish({ ledgerPath, post: refusing(refusals, () => { landed = true; }), renewToken: async () => { renewals++; return "renewed"; } });
  return { landed, renewals, unrenewable: unrenewableRows(ledgerPath) };
};

const GUARDED = { owner: "o", repo: "r", sha: HEAD, taskId: "W1-T15030", runId: "review-census", prUrl: PR_URL,
  fetchLifecycle: () => ({ merged: false, closed: false }), readReviewStatusHistory: async () => ({ kind: "readable" as const, failures: [] }) };
const PASS = { state: "success" as const, criteria: [], testTheater: false, summary: "pass", floorDegraded: false, capped: false,
  keywordOnly: false, planOnly: false };

test("W1-T15030 criterion 2: census — every status post, disarm and escalation renews once on 401, then is a named refusal", async (t) => {
  const sites: Record<string, Drive> = {
    "publishReviewStatusLocked decision post": statusSite(t, "decision", (o) => postReviewStatusGuarded({ ...GUARDED, ...o,
      state: "failure", description: "fail", evidence: "executed" })),
    "postReviewPending claim post": statusSite(t, "pending", (o) => postReviewPending({ ...GUARDED, ...o,
      reviewInputDigest: "census-input", fetchStatus: () => ({ statuses: [] }) } as never)),
    "publishSemanticHold": statusSite(t, "semantic", (o) => postReviewStatusGuarded({ ...GUARDED, ...o, state: "success",
      verdict: PASS, description: "pass", evidence: "executed", semanticJudgement: { planOnly: false, reviewerOutcome: "error" },
      fetchCurrentStatusEntry: () => undefined })),
    "publishCappedHold": statusSite(t, "capped", (o) => postReviewStatusGuarded({ ...GUARDED, ...o, state: "success",
      verdict: { ...PASS, capped: true }, description: "pass", evidence: "no_evidence",
      semanticJudgement: { planOnly: false, reviewerOutcome: "success" } })),
    "postUnreadTaskHoldGuarded": statusSite(t, "taskhold", (o) => postUnreadTaskHoldGuarded({ ...GUARDED, ...o, description: "d",
      refusal: "the task's catalog is unread" })),
    "postReviewStatusGuarded conflict hold": statusSite(t, "conflict", (o) => {
      const digest = reviewDecisionDigest({ headSha: HEAD, diff: "d", report: "r", body: "b", acceptance: [], declaredFiles: [] });
      appendLedger(o.ledgerPath, { run_id: "review-prior", task_id: "W1-T15030", step: "review.posted", pr_url: PR_URL, head_sha: HEAD,
        state: "success", review_decision_digest: digest, reviewer_outcome: "reviewer_completed", evaluator_provenance: EVALUATOR("prior"),
        decision_verdict: PASS });
      return postReviewStatusGuarded({ ...GUARDED, ...o, state: "failure", evidence: "executed", reviewDecisionDigest: digest,
        evaluatorProvenance: EVALUATOR("attempt") });
    }),
    "withdrawArmIfVerdictRefusesAsync pre-post disarm": async (refusals) => {
      let renewals = 0;
      const disarm = (url: string) => disarmAutoMergeAsync(url, { say: () => {}, isMerged: () => false,
        disableAuto: async () => { if (renewals < refusals) UNAUTHORIZED(); } }, { renewToken: () => { renewals++; } });
      const { outcome } = await withdrawArmIfVerdictRefusesAsync({ state: "failure", capped: false, planOnly: false },
        { prUrl: PR_URL, taskId: "W1-T15030", headSha: HEAD, ledgerPath: "/unused", log: () => {} }, { disarm });
      return { landed: outcome === "disarmed", renewals, unrenewable: outcome === "token_unrenewable" ? 1 : 0 };
    },
    "withdrawAfterPublication disarm": async (refusals) => {
      const rows: Array<Record<string, unknown>> = [];
      let renewals = 0;
      const disarm = (url: string) => disarmAutoMergeAsync(url, { say: () => {}, isMerged: () => false,
        disableAuto: async () => { if (renewals < refusals) UNAUTHORIZED(); } }, { renewToken: () => { renewals++; } });
      const held = await withdrawAfterPublication({ state: "pending", capped: false, planOnly: false }, { prUrl: PR_URL, taskId: "W1-T15030",
        headSha: HEAD, ledgerPath: "/unused", runId: "review-census", log: (step, extra = {}) => { rows.push({ ...extra, step }); } },
        { disarm, claimLost: async () => undefined });
      return { landed: held === undefined, renewals,
        unrenewable: rows.filter((row) => row.step === "review.post_refused" && row.reason === "token_unrenewable").length };
    },
    "renewingIssueGateway escalation post": async (refusals) => {
      const ledgerPath = censusLedger(t, `escalation-${refusals}`);
      const rows: Array<Record<string, unknown>> = [];
      let renewals = 0;
      let filed = false;
      const land = refusing(refusals, () => { filed = true; });
      const gateway = renewingIssueGateway({ ensureLabel: () => true, listOpen: () => [], comment: () => {},
        create: () => { land(); return "https://github.com/o/r/issues/1"; } },
        { log: (step, extra = {}) => { rows.push({ ...extra, step }); }, renewToken: async () => { renewals++; } });
      await tryEscalateAsync({ class: "MANUAL", taskId: "W1-T15030", runId: "review-census", headSha: HEAD, cause: "review",
        summary: "s", detail: "d", options: [{ label: "a", detail: "b" }], recommendation: "a", consequence: "c" },
        { issues: gateway, ledgerPath, runId: "review-census" });
      return { landed: filed, renewals,
        unrenewable: rows.filter((row) => row.step === "review.post_refused" && row.reason === "token_unrenewable").length };
    },
  };
  for (const [site, drive] of Object.entries(sites)) {
    const recovered = await drive(1);
    assert.deepEqual(recovered, { landed: true, renewals: 1, unrenewable: 0 }, `${site}: one 401, one renewal, and the retry lands`);
    const refused = await drive(2);
    assert.deepEqual(refused, { landed: false, renewals: 1, unrenewable: 1 },
      `${site}: a second 401 is one token_unrenewable refusal, and nothing lands`);
  }

  // The source census: a GitHub write added outside these helpers fails here.
  const review = readFileSync(join(REPO_ROOT, "src/lib/review.ts"), "utf8");
  const helper = review.slice(review.indexOf("async function postRenewingOnce"), review.indexOf("/** W1-T15030: GitHub refused the token"));
  assert.equal([...review.matchAll(/\bawait post\(/g)].length, [...helper.matchAll(/\bawait post\(/g)].length + 1,
    "every remudero-review status post in src/lib/review.ts is inside postRenewingOnce (the one other is postRepairLease's, which no review path calls)");
  assert.equal([...review.matchAll(/\bpostRenewingOnce(?:<S>)?\(/g)].length, 3, "postRenewingOnce: its definition, the decision post and the conflict hold");
  const cli = readFileSync(join(REPO_ROOT, "src/cli/commands/review.ts"), "utf8");
  assert.deepEqual([...cli.matchAll(/\btryEscalate\(|\bghIssueGateway\(|\bdisarmAutoMerge\(prUrl/g)].map((m) => m[0]), [],
    "no review escalation or disarm uses a sync gateway or the sync disarm");
  const escalations = [...cli.matchAll(/tryEscalateAsync\(/g)].length;
  const renewing = [...cli.matchAll(/issues: renewingIssueGateway\(/g)].length;
  assert.equal(escalations, renewing, "every review escalation's gateway renews");
  assert.equal([...cli.matchAll(/disarmAutoMergeAsync\(prUrl, realArmDepsAsync\(\), \{ renewToken \}\)/g)].length, 1,
    "the one real disarm carries its renewal");
  const sweep = readFileSync(join(REPO_ROOT, "src/lib/sweep.ts"), "utf8");
  assert.equal(/\bpostReviewStatus\(/.test(sweep), false, "the sweep posts no review status of its own");
});

test("W1-T15030 criterion 2: a pending post refused twice is re-reviewed on the next pass, end to end", async (t) => {
  // OBSERVED (review of 94ba7979a): two 401s on postReviewPending's POST wrote post_refused token_unrenewable with the
  // input digest; tick-read-worker's reviewPostRefusedFor read it as durable, and 24h later the PR was a blocked-ambiguous
  // escalation with 0 reviews. The fix is the one shared classifier, isRetryableReviewThrow.
  const pass = async (durable: boolean) => {
    const ledgerPath = censusLedger(t, durable ? "e2e-durable" : "e2e");
    const sha = "e".repeat(40);
    const body = "Remudero-Task: W1-T15030";
    const prUrl = "https://github.com/o/r/pull/15032";
    const digest = reviewInputDigest(sha, body);
    const claim = await postReviewPending({ owner: "o", repo: "r", sha, taskId: "W1-T15030", prUrl, reviewInputDigest: digest,
      runId: "review-PR15032-1", ledgerPath, fetchLifecycle: () => ({ merged: false, closed: false }),
      fetchStatus: () => ({ statuses: [] }), renewToken: async () => "renewed", post: UNAUTHORIZED } as never);
    assert.equal(claim.posted, false);
    const refusal = readLedgerLines(ledgerPath).find((row) => row.step === "review.post_refused")!;
    assert.deepEqual([refusal.reason, refusal.review_input_digest], ["token_unrenewable", digest], "the real row");
    if (durable) {
      const { ts: _ts, ...rest } = refusal;
      appendLedger(ledgerPath, { ...rest, run_id: String(refusal.run_id), task_id: "W1-T15030", step: "review.post_refused",
        reason: "a durable refusal" });
    }
    const updated = new Date(Date.now() - 60_000).toISOString();
    // The daemon's own producer (openPrViewSteps, whose reviewPostRefusedFor read the refusal as durable).
    const [view] = await buildOpenPrViewsAsync("o", "r", ledgerPath, {
      requiredContexts: () => ["ci-gate"],
      fetchAsync: async (args) => {
        const path = args.at(-1)!;
        if (path.includes("state=open")) return [{ number: 15032, html_url: prUrl, head: { ref: "run-W1-T15030-1", sha },
          updated_at: updated, body, auto_merge: null, state: "open" }];
        if (path.includes("check-runs")) return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] };
        if (path.endsWith("/status")) return { statuses: [] };
        if (path.includes("/statuses?")) return [];
        if (path.endsWith("/pulls/15032")) return { mergeable: true, mergeable_state: "clean" };
        return [];
      },
    });
    assert.ok(view);
    let reviewed = 0;
    const escalated: string[] = [];
    await runSweep([view], {
      ledgerPath, runId: "sweep-w1-t15030-e2e", now: () => Date.now(),
      arm: () => {}, close: () => assert.fail("unexpected close"), dispatchFix: () => assert.fail("unexpected fix"),
      escalate: (_pr, reason) => { escalated.push(String(reason)); }, postReview: () => { reviewed++; },
      reviewerCodeRecovery: { loadedCodeSha: "fresh-code", isLoadedCodeAtOrAfter: () => true, freshTreeReviewAvailable: true,
        probeFreshness: async () => ({ status: "fresh", codeSha: "fresh-code", originMainSha: "fresh-code", advance: "none" }) },
    } as SweepDeps, DEFAULT_SWEEP_POLICY);
    return { reviewed, escalated, view };
  };
  const retried = await pass(false);
  assert.equal(retried.reviewed, 1, `THE CLAIM: the next pass re-reviews the refused input: ${JSON.stringify(retried.view)}`);
  assert.deepEqual(retried.escalated, [], "no escalation");
  const blocked = await pass(true);
  assert.equal(blocked.reviewed, 0, "control: a durable refusal of the same input still blocks");
});
