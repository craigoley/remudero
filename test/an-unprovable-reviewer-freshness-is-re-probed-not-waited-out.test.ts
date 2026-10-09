import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import * as selfSync from "../src/lib/self-sync.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { readLedgerLines } from "../src/lib/status.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const MINUTE = 60_000;
const NOW = Date.now();
const CODE = "a".repeat(40);
const MAIN = "b".repeat(40);

function fixture(probe: () => Promise<selfSync.ReviewerCodeFreshness>, freshness = "unreadable") {
  const path = join(mkdtempSync(join(tmpdir(), "rmd-unreadable-reprobe-")), "ledger.ndjson");
  const pr: OpenPrView = {
    prNumber: 5771, prUrl: "https://github.com/o/r/pull/5771", taskId: "W1-T5771",
    headSha: "head", reviewInputDigest: "input", reviewState: "pending", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(NOW - 120 * MINUTE).toISOString(),
    reviewPendingSince: new Date(NOW - MINUTE).toISOString(), reviewPendingOwnerDead: false,
  };
  let clock = NOW;
  let probes = 0;
  const posted: number[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: (p) => { posted.push(p.prNumber); },
    ledgerPath: path, runId: "SWEEP-W1-T5771", now: () => clock,
    reviewerCodeRecovery: {
      loadedCodeSha: CODE, isLoadedCodeAtOrAfter: () => false, freshTreeReviewAvailable: true,
      probeFreshness: async () => { probes++; return probe(); },
    },
  };
  const refuse = (freshness = "unreadable", extra: Record<string, unknown> = {}) => appendLedger(path, {
    ts: new Date(clock).toISOString(), run_id: "review", task_id: pr.taskId!, step: "review.post_refused",
    pr_url: pr.prUrl, head_sha: pr.headSha, review_input_digest: pr.reviewInputDigest,
    reviewer_code_freshness: freshness, ...(freshness === "stale" ? { origin_main_sha: MAIN } : {}), ...extra,
  });
  refuse(freshness);
  return {
    path, pr, deps, posted, refuse,
    probes: () => probes,
    rows: () => readLedgerLines(path).filter(r => r.step === "sweep.reviewer_freshness_probe"),
    sweep: async (minutes: number, policy = DEFAULT_SWEEP_POLICY) => {
      clock = NOW + minutes * MINUTE;
      await runSweep([pr], deps, policy);
    },
  };
}

function commit(repo: GitRepo, path: string): string {
  mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
  writeFileSync(join(repo.dir, path), "export const changed = true;\n");
  repo.git("add", path);
  repo.git("commit", "--quiet", "-m", "fixture advance");
  return repo.git("rev-parse", "HEAD");
}

describe("test/an-unprovable-reviewer-freshness-is-re-probed-not-waited-out.test.ts", () => {
  test("a passing re-probe releases the review after the short backstop, once per probe", async () => {
    const f = fixture(async () => ({ status: "fresh", codeSha: CODE, originMainSha: CODE, advance: "none" }));
    await f.sweep(2);
    assert.deepEqual(f.posted, []);
    assert.equal(f.probes(), 0);
    await f.sweep(10);
    assert.deepEqual(f.posted, [5771]);
    assert.equal(f.probes(), 1, "discovery and action-time checks share the recorded probe");
    assert.equal(f.rows().length, 1);
    assert.equal(f.rows()[0].outcome, "fresh");
    assert.equal(f.rows()[0].loaded_code_sha, CODE);
    assert.equal(f.rows()[0].review_input_digest, "input");
  });

  test("failed probes double the durable backoff and stop at the pending ceiling", async () => {
    const f = fixture(async () => ({ status: "unreadable", reason: "ls-remote timed out" }));
    for (const [at, next] of [[5, 10], [15, 20], [35, 40], [75, 60], [135, 60]]) {
      await f.sweep(at);
      assert.equal(f.rows().at(-1)?.backoff_minutes, next);
      assert.equal(f.rows().at(-1)?.outcome, "unreadable");
      assert.equal(f.rows().at(-1)?.reason, "ls-remote timed out");
      const count = f.probes();
      await f.sweep(at + next - 1);
      assert.equal(f.probes(), count, "a new sweep folds the hold from the ledger");
    }
    assert.equal(f.rows().length, 5);
    assert.deepEqual(f.posted, []);
  });

  test("a later passing probe releases a failed hold, and a smaller pending ceiling caps retries", async () => {
    let healthy = false;
    const f = fixture(async () => healthy
      ? { status: "fresh", codeSha: CODE, originMainSha: CODE, advance: "none" }
      : { status: "unreadable", reason: "remote unavailable" });
    const policy = { ...DEFAULT_SWEEP_POLICY, pendingCeilingMinutes: 8 };
    await f.sweep(5, policy);
    assert.equal(f.rows()[0].backoff_minutes, 8);
    healthy = true;
    await f.sweep(12, policy);
    assert.deepEqual(f.posted, []);
    await f.sweep(13, policy);
    assert.deepEqual(f.posted, [5771]);
    assert.equal(f.probes(), 2);
    assert.equal(f.rows()[1].outcome, "fresh");
    assert.equal(f.rows()[1].backoff_minutes, 0);
  });

  test("an immaterial advance releases, a material advance holds, and a throw carries its reason", async () => {
    for (const status of ["fresh", "stale", "throw"] as const) {
      const f = fixture(async () => {
        if (status === "throw") throw new Error("probe transport broke");
        return status === "fresh"
          ? { status, codeSha: CODE, originMainSha: MAIN, advance: "immaterial" }
          : { status, codeSha: CODE, originMainSha: MAIN, changedPaths: ["src/lib/review.ts"] };
      });
      await f.sweep(5);
      assert.deepEqual(f.posted, status === "fresh" ? [5771] : []);
      assert.equal(f.rows().length, 1);
      assert.equal(f.rows()[0].outcome, status === "throw" ? "unreadable" : status);
      if (status === "throw") assert.match(String(f.rows()[0].reason), /probe transport broke/);
      else assert.equal(f.rows()[0].origin_main_sha, MAIN);
    }
  });

  test("new refusals and loaded code invalidate a successful probe; dry runs do not probe", async () => {
    const f = fixture(async () => ({ status: "fresh", codeSha: CODE, originMainSha: CODE, advance: "none" }));
    f.deps.dryRun = true;
    await f.sweep(5);
    assert.equal(f.probes(), 0);
    f.deps.dryRun = false;
    await f.sweep(5);
    f.refuse();
    await f.sweep(7);
    assert.equal(f.probes(), 1);
    await f.sweep(10);
    assert.equal(f.probes(), 2);
    f.deps.reviewerCodeRecovery!.loadedCodeSha = MAIN;
    await f.sweep(15);
    assert.equal(f.probes(), 3);
  });

  test("stale refusals retain the five-minute fresh-tree path without re-probing", async () => {
    const f = fixture(async () => { throw new Error("stale path must not probe"); }, "stale");
    await f.sweep(2);
    assert.deepEqual(f.posted, []);
    await f.sweep(5);
    assert.deepEqual(f.posted, [5771]);
    assert.equal(f.probes(), 0);
  });

  test("a newer in-flight review and a different review input never inherit a probe hold", async () => {
    const f = fixture(async () => { throw new Error("must not probe an active review"); });
    f.pr.reviewPendingSince = new Date(NOW + MINUTE).toISOString();
    await f.sweep(10);
    assert.deepEqual(f.posted, []);
    assert.equal(f.probes(), 0);
    f.pr.reviewState = "none";
    f.pr.reviewInputDigest = "new-input";
    await f.sweep(10);
    assert.deepEqual(f.posted, [5771]);
    assert.equal(f.probes(), 0);
  });

  test("the real bounded ls-remote compares loaded code, even after the checkout advances", async () => {
    const origin = gitRepo({ bare: true });
    const repo = gitRepo();
    try {
      repo.addRemote("origin", origin.dir);
      repo.git("push", "--quiet", "origin", "main");
      const loaded = repo.git("rev-parse", "HEAD");
      const probe = () => selfSync.probeReviewerCodeFreshnessAsync(loaded, { repoDir: repo.dir });
      assert.deepEqual(await probe(), { status: "fresh", codeSha: loaded, originMainSha: loaded, advance: "none" });
      const docs = commit(repo, "docs/example.md");
      repo.git("push", "--quiet", "origin", "main");
      assert.deepEqual(await probe(), { status: "fresh", codeSha: loaded, originMainSha: docs, advance: "immaterial" });
      const material = commit(repo, "src/lib/review.ts");
      repo.git("push", "--quiet", "origin", "main");
      assert.deepEqual(await probe(), { status: "stale", codeSha: loaded, originMainSha: material,
        changedPaths: ["docs/example.md", "src/lib/review.ts"] });
    } finally { repo.cleanup(); origin.cleanup(); }
  });

  test("missing provenance, malformed refs, timeouts and unavailable objects never prove freshness", async () => {
    assert.deepEqual(await selfSync.probeReviewerCodeFreshnessAsync(undefined), {
      status: "unreadable", reason: "loaded reviewer code sha is unavailable",
    });
    assert.deepEqual(await selfSync.probeReviewerCodeFreshnessAsync("not-a-sha"), {
      status: "unreadable", reason: "loaded reviewer code sha is malformed",
    });
    for (const output of ["", "bad\trefs/heads/main", `${CODE}\trefs/heads/other`, `${CODE}\trefs/heads/main\n${MAIN}\trefs/heads/main`]) {
      const result = await selfSync.probeReviewerCodeFreshnessAsync(CODE, { gitAsync: async () => output });
      assert.equal(result.status, "unreadable");
      if (result.status === "unreadable") assert.match(result.reason, /main ref/);
    }
    let aborted = false;
    const timed = await selfSync.probeReviewerCodeFreshnessAsync(CODE, {
      timeoutMs: 5, gitAsync: (_args, signal) => new Promise(() => {
        signal!.addEventListener("abort", () => { aborted = true; });
      }),
    });
    assert.equal(timed.status, "unreadable");
    assert.equal(aborted, true);
    if (timed.status === "unreadable") assert.match(timed.reason, /5ms bound/);
    const missing = await selfSync.probeReviewerCodeFreshnessAsync(CODE, {
      gitAsync: async (args) => {
        assert.deepEqual(args, ["ls-remote", "origin", "refs/heads/main"]);
        return `${MAIN}\trefs/heads/main`;
      },
      git: () => { throw new Error("remote object is absent"); },
    });
    assert.equal(missing.status, "unreadable");
    if (missing.status === "unreadable") assert.match(missing.reason, /remote object is absent/);
  });
});
