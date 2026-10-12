import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock, systemClock } from "../src/lib/clock.js";
import { appendLedger } from "../src/lib/ledger.js";
import { postReviewPending, REVIEW_LOCK_TTL_MS } from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";
import { ghShim } from "./helpers/gh-shim.js";
import { runReview } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

const sha = "deadbeef5540";
const runId = "review-local";
const foreignRun = "review-foreign";

async function drive(
  status: unknown,
  options: { merged?: boolean; closed?: boolean; seed?: boolean; readError?: boolean; realRead?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "rmd-cross-host-review-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const clock = fixedClock(systemClock.now());
  const posts: Array<{ description?: string }> = [];
  const events: string[] = [];
  const originalPath = process.env.PATH;
  const shim = options.realRead ? ghShim([
    { when: `commits/${sha}/status`, stdout: JSON.stringify(status) },
  ], { kind: "cross-host-review-gh" }) : undefined;
  try {
    if (shim) process.env.PATH = `${shim.dir}:${originalPath}`;
    if (options.seed) appendLedger(ledgerPath, {
      run_id: foreignRun, task_id: "W1-T5540", step: "review.pending_posted", head_sha: sha,
    });
    const opts = {
      owner: "acme", repo: "remudero", sha, taskId: "W1-T5540", runId, ledgerPath, clock,
      prUrl: "https://github.com/acme/remudero/pull/5540",
      fetchLifecycle: () => {
        events.push("lifecycle");
        return { merged: options.merged ?? false, closed: options.closed ?? false };
      },
      ...(!shim ? { fetchStatus: (args: string[]) => {
        events.push("status");
        assert.deepEqual(args, ["api", `repos/acme/remudero/commits/${sha}/status`]);
        if (options.readError) throw new Error("status unavailable");
        return typeof status === "function" ? status(clock.now()) : status;
      } } : {}),
      post: (post: { description?: string }) => { events.push("post"); posts.push(post); },
    };
    const result = await postReviewPending(opts);
    return { result, posts, events, ledger: readLedgerLines(ledgerPath), calls: shim?.calls() };
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
    if (shim) rmSync(shim.dir, { recursive: true, force: true });
  }
}

function pending(age: number, owner = foreignRun) {
  return (now: number) => ({ statuses: [{
    context: "remudero-review", state: "pending",
    description: `remudero-review: review in progress (owned by run ${owner})`,
    created_at: fixedClock(now - age).iso(),
  }] });
}

test("W1-T5540: a foreign host's live pending claim stands this review down; a stale claim is taken over", async () => {
  for (const age of [0, REVIEW_LOCK_TTL_MS - 1]) {
    const live = await drive(pending(age));
    assert.equal(live.result.posted, false);
    assert.match(live.result.reason ?? "", /review-foreign/);
    assert.match(live.result.reason ?? "", /host-independent/);
    assert.deepEqual(live.posts, []);
    assert.equal(live.ledger.filter(row => row.step === "review.pending_posted").length, 0);
  }
  for (const age of [REVIEW_LOCK_TTL_MS, REVIEW_LOCK_TTL_MS * 2]) {
    const stale = await drive(pending(age));
    assert.equal(stale.result.posted, true);
    assert.equal(stale.posts.length, 1);
    assert.match(stale.posts[0].description ?? "", /took over a stale claim/);
    assert.match(stale.posts[0].description ?? "", /review-foreign/);
    assert.equal(stale.ledger.filter(row => row.step === "review.pending_posted").length, 1);
  }
});

test("W1-T5540: a merged pr is skipped before any proof runs even with a live local claim", async () => {
  const run = await drive({ statuses: [] }, { merged: true, seed: true });
  assert.equal(run.result.lifecycle, "merged");
  assert.equal(run.result.posted, false);
  assert.deepEqual(run.events, ["lifecycle"]);
  assert.deepEqual(run.posts, []);
  const skipped = run.ledger.find(row => row.step === "review.skipped_closed_lifecycle");
  assert.equal(skipped?.reason, "pr_merged");
  assert.equal(skipped?.head_sha, sha);

  const root = mkdtempSync(join(tmpdir(), "rmd-cross-host-merged-"));
  const originalPath = process.env.PATH;
  const shim = ghShim([
    { when: "pulls/5540", stdout: JSON.stringify({
      state: "closed", merged_at: systemClock.iso(), head: { sha }, body: "",
    }) },
    { when: "commits/", stdout: '{"statuses":[]}' },
    { when: "pr diff", exit: 1, stderr: "proof input must never be fetched" },
  ], { kind: "cross-host-merged-gh" });
  try {
    process.env.PATH = `${shim.dir}:${originalPath}`;
    const ledgerPath = join(root, "ledger.ndjson");
    appendLedger(ledgerPath, {
      run_id: foreignRun, task_id: "W1-T5540", step: "review.pending_posted", head_sha: sha,
    });
    const verdict = await runReview({
      owner: "acme", repo: "remudero", prUrl: "https://github.com/acme/remudero/pull/5540",
      task: { id: "W1-T5540", acceptance: [{ claim: "a proof", proof: "grep: proof in test/proof.ts" }] },
      report: "", reportIsSubstitute: true, settingsFile: join(root, "settings.json"),
      config: { root, claudeBin: "/bin/true" } as Config,
      log: () => {}, say: () => {}, account: result => result, spawnReviewer: false,
      headCheckoutDir: root, ledgerPath, runId,
    });
    assert.equal(verdict.verdictWithheld, "pr_merged");
    assert.equal(verdict.reviewerOutcome, "not_attempted_pr_merged");
    assert.deepEqual(verdict.criteria, []);
    assert.ok(shim.calls().every(call => call.includes("pulls/5540")), shim.calls().join("\n"));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T5540: a closed pr is skipped before checking claims or posting", async () => {
  const run = await drive({ statuses: [] }, { closed: true });
  assert.equal(run.result.lifecycle, "closed");
  assert.deepEqual(run.events, ["lifecycle"]);
  assert.equal(run.ledger.find(row => row.step === "review.skipped_closed_lifecycle")?.reason, "pr_closed");
});

test("W1-T5540: absent and terminal shared statuses preserve the open-pr pending post", async () => {
  for (const statuses of [[], [{ context: "other", state: "pending" }],
    ...["success", "failure", "error"].map(state => [{ context: "remudero-review", state }])]) {
    const run = await drive({ statuses });
    assert.equal(run.result.posted, true);
    assert.equal(run.posts.length, 1);
    assert.equal(run.posts[0].description, `remudero-review: review in progress (owned by run ${runId})`);
  }
  const own = await drive(pending(0, runId));
  assert.equal(own.result.posted, true);
});

test("W1-T5540: unreadable shared statuses hold with a reason rather than taking over", async () => {
  for (const status of [null, {}, { statuses: null }, { statuses: [null] },
    { statuses: [{ context: "remudero-review", state: "mystery" }] },
    { statuses: [{ context: "remudero-review", state: "pending", description: "truncated" }] },
    { statuses: [{ context: "remudero-review", state: "pending",
      description: `owned by run ${foreignRun})`, created_at: "bad-date" }] }]) {
    const run = await drive(status);
    assert.equal(run.result.posted, false);
    assert.ok(run.result.reason);
    assert.deepEqual(run.posts, []);
  }
  const failed = await drive(undefined, { readError: true });
  assert.equal(failed.result.posted, false);
  assert.match(failed.result.reason ?? "", /status unavailable/);
  assert.deepEqual(failed.posts, []);
});

test("W1-T5540: a future foreign timestamp holds and the current context wins over other statuses", async () => {
  assert.equal((await drive(pending(-60_000))).result.posted, false);
  const run = await drive((now: number) => ({ statuses: [
    { context: "ci", state: "success" },
    ...pending(0)(now).statuses,
  ] }));
  assert.equal(run.result.posted, false);
});

test("W1-T5540: the default reader shells out to the combined commit-status endpoint", async () => {
  const status = pending(0)(systemClock.now());
  const run = await drive(status, { realRead: true });
  assert.equal(run.result.posted, false);
  assert.match(run.result.reason ?? "", /review-foreign/);
  assert.deepEqual(run.calls, [`api repos/acme/remudero/commits/${sha}/status -i`]);
});
