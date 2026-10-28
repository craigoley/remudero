import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { withTempDir } from "#src/lib/tmp.js";
import {
  assessPendingReviewOwner,
  lastPendingReviewStatusFromLedger,
  postReviewPending,
  reviewInputDigest,
  type PendingReviewOwnerAssessment,
  type PostReviewPendingOpts,
} from "#src/lib/review.js";
import { buildOpenPrViews } from "#src/run-task.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, runSweep, type SweepDeps } from "#test/helpers/sweep-test.js";

function fixture(dir: string) {
  const now = Date.now();
  const ledgerPath = join(dir, "ledger.ndjson");
  const taskId = "W1-T8088";
  const sha = "a".repeat(40);
  const prUrl = "https://github.com/o/r/pull/8088";
  const body = `Remudero-Task: ${taskId}`;
  const postedAt = new Date(now - 5 * 60_000).toISOString();
  const ownerIdentity = { pid: process.pid, startedAt: new Date(now).toISOString() };
  const prior = {
    run_id: "run-dead", task_id: taskId, step: "review.pending_posted",
    ts: postedAt, head_sha: sha, pr_url: prUrl, review_input_digest: reviewInputDigest(sha, body),
    host: hostname(), owner_pid: 41, owner_started_at: postedAt,
  };
  const posts: Array<{ description: string }> = [];
  const status = (runId = prior.run_id, createdAt = postedAt) => ({ statuses: [{
    context: "remudero-review", state: "pending",
    description: `remudero-review: review in progress (owned by run ${runId})`, created_at: createdAt,
  }] });
  const opts: PostReviewPendingOpts = {
    owner: "o", repo: "r", sha, taskId, prUrl, reviewInputDigest: prior.review_input_digest,
    runId: "run-alive", ledgerPath, ownerIdentity,
    fetchLifecycle: () => ({ merged: false, closed: false }),
    fetchStatus: () => ({ statuses: [] }),
    post: (post) => {
      assert.equal(post.state, "pending");
      assert.ok(post.description);
      posts.push({ description: post.description });
    },
  };
  return { now, ledgerPath, prior, posts, status, opts, body, ownerIdentity };
}

test("W1-T8088: a pending claim whose owner is proven dead is taken over inside the TTL", async () => {
  await withTempDir("t8088-local", async (dir) => {
    const h = fixture(dir);
    appendLedger(h.ledgerPath, h.prior);
    let assessed = 0;
    const result = await postReviewPending({ ...h.opts, assessPendingOwner: (record) => {
      assessed++;
      assert.equal(record.runId, h.prior.run_id);
      assert.equal(record.ownerPid, h.prior.owner_pid);
      return "dead";
    } });
    assert.equal(result.posted, true);
    assert.equal(assessed, 1);
    assert.equal(h.posts.length, 1);
    assert.match(h.posts[0]!.description, /took over.*run-dead/);
    assert.match(h.posts[0]!.description, /owner proven dead/);
    assert.doesNotMatch(h.posts[0]!.description, />= 42m/);
    const rows = readLedgerLines(h.ledgerPath).filter((row) => row.step === "review.pending_posted");
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.run_id, h.opts.runId);
    assert.equal(rows[1]!.owner_pid, h.ownerIdentity.pid);
    assert.equal(rows[1]!.owner_started_at, h.ownerIdentity.startedAt);
    assert.equal(rows[1]!.host, hostname());
    assert.equal(rows[1]!.review_input_digest, h.opts.reviewInputDigest);
  });
});

test("W1-T8088: the shared status naming a dead owner run is taken over too", async () => {
  await withTempDir("t8088-shared", async (dir) => {
    const h = fixture(dir);
    appendLedger(h.ledgerPath, h.prior);
    appendLedger(h.ledgerPath, { ...h.prior, run_id: "unrelated-run", owner_pid: 99 });
    appendLedger(h.ledgerPath, { ...h.prior, head_sha: "old-head", owner_pid: 98 });
    const seen: number[] = [];
    const result = await postReviewPending({
      ...h.opts, reviewInputDigest: "changed-body", fetchStatus: () => h.status(),
      assessPendingOwner: (record) => {
        seen.push(record.ownerPid!);
        assert.equal(record.runId, h.prior.run_id);
        assert.equal(record.headSha, h.opts.sha);
        return "dead";
      },
    });
    assert.equal(result.posted, true);
    assert.deepEqual(seen, [41], "the shared owner must match the named run and this head");
    assert.equal(h.posts.length, 1);
    assert.match(h.posts[0]!.description, /took over.*run-dead/);
    assert.match(h.posts[0]!.description, /owner proven dead/);
    assert.doesNotMatch(h.posts[0]!.description, />= 42m/);
    assert.equal(lastPendingReviewStatusFromLedger(readLedgerLines(h.ledgerPath), h.opts.taskId)?.runId, h.opts.runId);
  });
});

test("W1-T8088: a claim whose owner is not proven dead still holds inside the TTL", async (t) => {
  for (const shared of [false, true]) {
    for (const assessment of ["active", "unknown"] as const satisfies readonly PendingReviewOwnerAssessment[]) {
      await t.test(`${shared ? "shared" : "local"} ${assessment} owner`, async () => {
        await withTempDir("t8088-hold", async (dir) => {
          const h = fixture(dir);
          appendLedger(h.ledgerPath, h.prior);
          const result = await postReviewPending({
            ...h.opts, ...(shared ? { reviewInputDigest: "changed-body", fetchStatus: () => h.status() } : {}),
            assessPendingOwner: () => assessment,
          });
          assert.equal(result.posted, false);
          assert.match(result.reason!, /no-op/);
          assert.equal(h.posts.length, 0);
          assert.equal(readLedgerLines(h.ledgerPath).filter((row) => row.step === "review.pending_posted").length, 1);
        });
      });
    }
    await t.test(`${shared ? "shared" : "local"} unreadable age holds even a dead owner`, async () => {
      await withTempDir("t8088-undated", async (dir) => {
        const h = fixture(dir);
        appendLedger(h.ledgerPath, { ...h.prior, ...(shared ? {} : { ts: "unreadable" }) });
        const result = await postReviewPending({
          ...h.opts, ...(shared ? { reviewInputDigest: "changed-body", fetchStatus: () => h.status("run-dead", "unreadable") } : {}),
          assessPendingOwner: () => "dead",
        });
        assert.equal(result.posted, false);
        assert.equal(h.posts.length, 0);
      });
    });
  }
  for (const shared of [false, true]) {
    for (const identity of ["missing", "foreign", "missing-run", "old-head", "latest-active"] as const) {
      await t.test(`${shared ? "shared" : "local"} ${identity} identity holds with the default assessment`, async () => {
        await withTempDir("t8088-unknown", async (dir) => {
          const h = fixture(dir);
          if (identity !== "missing-run") appendLedger(h.ledgerPath, {
            ...h.prior,
            ...(identity === "missing" ? { owner_pid: undefined } : {}),
            ...(identity === "foreign" ? { host: "another-host" } : {}),
            ...(identity === "old-head" ? { head_sha: "old-head" } : {}),
          });
          if (identity === "latest-active") appendLedger(h.ledgerPath, {
            ...h.prior, owner_pid: process.pid, owner_started_at: h.ownerIdentity.startedAt,
          });
          const result = await postReviewPending({
            ...h.opts, reviewInputDigest: shared ? "changed-body" : h.opts.reviewInputDigest,
            fetchStatus: () => h.status(),
          });
          assert.equal(result.posted, false);
          assert.equal(h.posts.length, 0);
          assert.match(result.reason!, /no-op/);
        });
      });
    }
  }
});

test("W1-T8088: a dead owner is re-reviewed once, and the next pass reads the review in flight", async () => {
  await withTempDir("t8088-sweep", async (dir) => {
    const h = fixture(dir);
    appendLedger(h.ledgerPath, h.prior);
    const view = () => {
      const [pr] = buildOpenPrViews("o", "r", h.ledgerPath, {
        requiredContexts: () => ["ci-gate"],
        assessPendingOwner: (record) => assessPendingReviewOwner(record, {
          isPidAlive: (pid) => pid === process.pid, getProcessStartTime: () => null,
        }),
        fetch: (args) => {
          const path = args.at(-1)!;
          if (path.includes("state=open")) return [{
            number: 8088, html_url: h.opts.prUrl, head: { ref: "run-W1-T8088-1", sha: h.opts.sha },
            updated_at: new Date(h.now).toISOString(), body: h.body, auto_merge: null, state: "open",
          }];
          if (path.includes("check-runs")) return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] };
          if (path.includes("/status")) return h.status();
          if (path.endsWith("/pulls/8088")) return { mergeable: true, mergeable_state: "clean" };
          return [];
        },
      });
      assert.ok(pr);
      return pr;
    };
    const before = view();
    assert.equal(before.reviewPendingOwnerDead, true);
    assert.equal(deriveDisposition(before, DEFAULT_SWEEP_POLICY, h.now).disposition, "post-review");
    let reviewed = 0;
    const deps: SweepDeps = {
      ledgerPath: h.ledgerPath, runId: "sweep-t8088", now: () => Date.now(),
      arm: () => { assert.fail("pending review cannot arm"); }, close: () => {}, dispatchFix: () => {},
      escalate: () => { assert.fail("this review needs no escalation"); },
      postReview: async () => {
        reviewed++;
        const result = await postReviewPending({ ...h.opts, assessPendingOwner: () => "dead", fetchStatus: () => h.status() });
        assert.equal(result.posted, true);
      },
    };
    await runSweep([before], deps, DEFAULT_SWEEP_POLICY);
    const admissions = () => readLedgerLines(h.ledgerPath).filter((row) => row.step === "sweep.review_admitted");
    assert.equal(admissions().length, 1);
    assert.equal(admissions()[0]!.head_sha, h.opts.sha);
    const record = lastPendingReviewStatusFromLedger(readLedgerLines(h.ledgerPath), h.opts.taskId, h.opts.prUrl);
    assert.ok(record);
    assert.equal(record.runId, h.opts.runId);
    assert.equal(assessPendingReviewOwner(record, { isPidAlive: (pid) => pid === process.pid, getProcessStartTime: () => null }), "active");
    const after = view();
    assert.equal(after.reviewPendingOwnerDead, undefined);
    const decision = deriveDisposition(after, DEFAULT_SWEEP_POLICY, Date.now());
    assert.equal(decision.disposition, "wait");
    assert.match(decision.reason, /a review is already in flight/);
    assert.doesNotMatch(decision.reason, /owner proven dead/);
    await runSweep([after], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(reviewed, 1);
    assert.equal(admissions().length, 1);
  });
});

test("W1-T8088: the default owner assessment takes over a process that really exited", async () => {
  for (const shared of [false, true]) await withTempDir("t8088-default", async (dir) => {
    const h = fixture(dir);
    const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
    assert.equal(child.status, 0);
    assert.ok(child.pid > 0);
    appendLedger(h.ledgerPath, { ...h.prior, owner_pid: child.pid });
    const result = await postReviewPending({
      ...h.opts, ...(shared ? { reviewInputDigest: "changed-body", fetchStatus: () => h.status() } : {}),
    });
    assert.equal(result.posted, true);
    assert.match(h.posts[0]!.description, /owner proven dead/);
  });
});
