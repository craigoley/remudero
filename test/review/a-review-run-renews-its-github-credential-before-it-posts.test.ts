// W1-T15030: a review run renews its GitHub App token before it publishes, retries once on HTTP 401, posts only while it
// holds its claim, and a run that dies leaves no pending status the sweep cannot re-admit.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { type ReviewCommandHost, runReview } from "#src/cli/commands/review.js";
import { disarmAutoMergeAsync } from "#src/lib/arm-auto-merge.js";
import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import type { Mount } from "#src/lib/mounts.js";
import type { AcceptanceCriterion } from "#src/lib/plan.js";
import { holdReviewRunLive, postReviewPending, refreshReviewPublisherToken, renewReviewPublisherToken,
  reviewOwnerOrphaned } from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, orphanedOwnerRetryView, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import type { WorkerResult } from "#src/lib/worker.js";

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

/** A `gh` stub that answers runReview's reads and records every status POST with the token it presented. A terminal
 *  POST presenting a token named in REFUSED_TOKENS (space separated) fails as GitHub's 401 does. */
function ghStub(dir: string): { bin: string; posts: () => Array<{ state: string; token: string }> } {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "posts.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  *"-X POST"*statuses*)
    state=$(printf '%s\\n' "$@" | sed -n 's/^state=//p')
    printf '%s %s\\n' "$state" "$GH_TOKEN" >> "${log}"
    case " $REFUSED_TOKENS " in
      *" $GH_TOKEN "*) if [ "$state" != pending ]; then echo "gh: Bad credentials (HTTP 401)" >&2; exit 1; fi ;;
    esac
    echo '{}' ;;
  *"/statuses?"*) echo '[[]]' ;;
  *reviews\\?*) echo '[]' ;;
  *reviews*) echo '{}' ;;
  *pulls/*) echo '{"number":1,"html_url":"${PR_URL}","state":"open","merged":false,"updated_at":"t","body":"","head":{"ref":"b","sha":"${HEAD}"},"base":{"ref":"main"}}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 });
  return { bin, posts: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const [state, token] = line.split(" ");
    return { state: state!, token: token ?? "" };
  }) };
}

const UNMET: AcceptanceCriterion[] = [{ claim: "VISIBLE-CLAIM the surface behaves", proof: "unit test: never-matches-W1-T15030" }];

/** Drive the real runReview to a failing verdict (the keyword floor finds nothing), which withdraws an arm and posts. */
async function reviewFailing(t: TestContext, opts: {
  token: string; refused?: string[]; renewTo?: string; runId?: string;
  midRun?: (ledgerPath: string) => void;
}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t15030-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const gh = ghStub(root);
  const saved = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, REFUSED_TOKENS: process.env.REFUSED_TOKENS };
  process.env.PATH = `${gh.bin}:${saved.PATH}`;
  process.env.GH_TOKEN = opts.token;
  process.env.REFUSED_TOKENS = (opts.refused ?? []).join(" ");
  const order: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const renewals: Array<{ force?: boolean }> = [];
  try {
    const verdict = await runReview(hostFor(), {
      owner: "acme", repo: "remudero", prUrl: PR_URL,
      task: { id: "W1-T15030", acceptance: UNMET },
      report: "", settingsFile: join(root, "settings.json"), config: { claudeBin: "/bin/true", root } as Config,
      log: (step, extra = {}) => { logged.push({ ...extra, step }); }, say: () => {}, account: (r: WorkerResult) => r, spawnReviewer: false, reviewerMount: MOUNT,
      ledgerPath, runId: opts.runId ?? "review-PR1-1",
      readReviewReuseFacts: () => { opts.midRun?.(ledgerPath); return undefined; },
      renewToken: async (o) => {
        renewals.push(o ?? {});
        order.push(`renew:${o?.force === true ? "forced" : "due"}`);
        if (opts.renewTo !== undefined) process.env.GH_TOKEN = opts.renewTo;
        return opts.renewTo !== undefined ? "renewed" : "fresh";
      },
      disarm: () => {
        order.push(`disarm:${process.env.GH_TOKEN}`);
        return "disarmed" as const;
      },
    });
    return { verdict, order, renewals, posts: gh.posts(), rows: [...readLedgerLines(ledgerPath), ...logged] };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
  const run = await reviewFailing(t, { token: "expired-token", refused: ["expired-token"], renewTo: "renewed-token" });
  assert.equal(run.verdict.state, "failure");
  // The renewal comes first; the disarm and the terminal post present the renewed token.
  assert.deepEqual(run.order.slice(0, 2), ["renew:due", "disarm:renewed-token"]);
  const terminal = run.posts.filter((post) => post.state === "failure");
  assert.deepEqual(terminal, [{ state: "failure", token: "renewed-token" }]);
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
  assert.equal(await renewReviewPublisherToken({ now: () => clock, ensureHeld: notArmed, refresh }), "fresh");
  assert.equal(process.env.GH_TOKEN, "app-token-1");
  clock += 27 * 60_000;
  assert.equal(await renewReviewPublisherToken({ now: () => clock, ensureHeld: notArmed, refresh }), "renewed");
  assert.equal(process.env.GH_TOKEN, "app-token-2");
  // A token this process did not mint is never renewed, and an armed refresh loop renews its own.
  process.env.GH_TOKEN = "operator-token";
  assert.equal(await renewReviewPublisherToken({ now: () => clock, ensureHeld: notArmed, refresh }), "not_held");
  assert.equal(await renewReviewPublisherToken({ ensureHeld: async () => "renewed" }), "renewed");
  assert.equal(await renewReviewPublisherToken({ ensureHeld: async () => "token_expired" }), "token_unrenewable");
  assert.deepEqual(app.exchanges, ["app-token-1", "app-token-2"]);
});

test("W1-T15030 criterion 2: one renew-and-retry on 401, then a named refusal", async (t) => {
  // A 401 on the post: one forced renewal, one retry, and the retry presents the renewed token.
  const recovered = await reviewFailing(t, { token: "old-token", refused: ["old-token"] , renewTo: undefined });
  assert.equal(recovered.renewals.filter((o) => o.force === true).length, 1);
  assert.deepEqual(recovered.posts.filter((post) => post.state === "failure").map((post) => post.token), ["old-token", "old-token"]);
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
    clock: { now: () => orphan.now } as never,
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
  assert.deepEqual(run.posts.filter((post) => post.state !== "pending"), []);
  assert.equal(run.order.some((step) => step.startsWith("disarm:")), false);
  const refused = run.rows.filter((row) => row.step === "review.post_refused" && row.reason === "claim_lost");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.taken_over_by_run_id, "review-PR1-taker");
  assert.equal(run.rows.some((row) => row.step === "escalation.filed" || row.step === "review.posted" && row.state !== "pending"), false);
});
