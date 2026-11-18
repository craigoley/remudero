/**
 * W1-T13435 — A REVIEW'S PENDING POST READS ITS PR LIFECYCLE OFF THE LOOP.
 *
 * reviewCommand gave postReviewPending the synchronous fetchPrLifecycle: an execFileSync of gh plus a cadence that may
 * sleep with Atomics.wait, on the daemon loop. It now gives the awaited fetchPrLifecycleAsync, as its other pending
 * post does. gh answers from a PATH shim; the review itself is stubbed.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { ledgerPathFor } from "#src/lib/ledger-path.js";
import * as review from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { reviewCommand } from "#test/helpers/run-task-test.js";

const HEAD = childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const NUMBER = 13435;
const PR = `https://github.com/acme/remudero/pull/${NUMBER}`;
const BODY = "## Acceptance\n- the fixture holds | manual fixture";
const savedPath = process.env.PATH;
let root: string;

const row = (state: "open" | "closed", merged: boolean) => ({
  number: NUMBER, state, merged, merged_at: merged ? "2026-11-17T00:00:00Z" : null,
  head: { sha: HEAD, ref: "fixture" }, base: { ref: "main" }, body: BODY,
});

/** A gh on PATH that answers the pull request read with `answer`, after `delaySeconds`. */
function withGh(answer: { stdout?: string; stderr?: string; exit?: number }, delaySeconds?: number): GhShim {
  const shim = ghShim([{ when: `pulls/${NUMBER}`, ...answer, ...(delaySeconds === undefined ? {} : { delaySeconds }) }]);
  process.env.PATH = `${shim.dir}:${savedPath ?? ""}`;
  return shim;
}

type Captured = Parameters<typeof review.postReviewPending>[0];

/** Drives reviewCommand to its pending post; `pending` stands in for postReviewPending. */
async function drive(pending: (opts: Captured) => Promise<review.PostReviewPendingResult>): Promise<{ code: number; rows: Record<string, unknown>[]; reviewed: number }> {
  let reviewed = 0;
  const log = console.log;
  console.log = () => {};
  try {
    const code = await reviewCommand(String(NUMBER), ["--repo", "acme/remudero"], {
      fetchView: () => ({ number: NUMBER, html_url: PR, head: { ref: "fixture", sha: HEAD }, updated_at: "2026-11-17T00:00:00Z", body: BODY }),
      loadConfig: () => ({ root, claudeBin: "/bin/true" }),
      fetchHead: () => {},
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "other", message: "not needed" } }),
      postReviewPending: pending,
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" }),
      reviewStartFreshness: { status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" },
      runReview: async () => {
        reviewed += 1;
        return { state: "success", criteria: [], testTheater: false, summary: "fixture", floorDegraded: false, capped: false,
          keywordOnly: false, planOnly: false, headSha: HEAD, reviewerOutcome: "success", verdictWithheld: "fixture does not publish" };
      },
    } as Parameters<typeof reviewCommand>[2]).catch(() => 1);
    return { code, rows: readLedgerLines(ledgerPathFor({ root } as Parameters<typeof ledgerPathFor>[0])) as Record<string, unknown>[], reviewed };
  } finally {
    console.log = log;
  }
}

/** The fetchLifecycle reviewCommand hands its pending post. */
async function capturedFetchLifecycle(): Promise<Captured["fetchLifecycle"]> {
  let captured: Captured["fetchLifecycle"] | undefined;
  await drive(async (opts) => { captured = opts.fetchLifecycle; return { posted: false }; });
  assert.ok(captured, "reviewCommand reached its pending post");
  return captured;
}

before(() => { root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13435-`)); });
after(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

describe("a review's pending post reads its PR lifecycle off the loop", () => {
  it("W1-T13435 criterion 1: the pending post's fetchLifecycle returns a promise with the synchronous read's answer", async () => {
    const fetchLifecycle = await capturedFetchLifecycle();
    for (const [name, pull] of [["open", row("open", false)], ["merged", row("closed", true)], ["closed", row("closed", false)]] as const) {
      withGh({ stdout: JSON.stringify(pull) });
      const answer = fetchLifecycle();
      assert.ok(answer instanceof Promise, `${name}: the read is awaited`);
      const got = await answer;
      const want = review.fetchPrLifecycle(PR, () => pull);
      assert.deepEqual(
        { merged: got.merged, closed: got.closed, baseRef: got.baseRef, reviewInputDigest: got.reviewInputDigest },
        { merged: want.merged, closed: want.closed, baseRef: want.baseRef, reviewInputDigest: want.reviewInputDigest }, name);
    }
  });

  it("W1-T13435 criterion 2: the read makes no sync child_process call and no Atomics.wait; a 20 ms timer fires while gh is held 1 s", async () => {
    const fetchLifecycle = await capturedFetchLifecycle();
    withGh({ stdout: JSON.stringify(row("open", false)) }, 1);
    const cp = (childProcess as unknown as { default: Record<string, (...a: unknown[]) => unknown> }).default;
    const originals = new Map<string, (...a: unknown[]) => unknown>();
    let syncCalls = 0;
    for (const name of ["execFileSync", "execSync", "spawnSync"]) {
      const original = cp[name]!;
      originals.set(name, original);
      cp[name] = (...a: unknown[]) => { syncCalls++; return original(...a); };
    }
    syncBuiltinESMExports();
    const wait = Atomics.wait;
    let waits = 0;
    Atomics.wait = ((...a: Parameters<typeof Atomics.wait>) => { waits++; return wait(...a); }) as typeof Atomics.wait;
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(performance.now()), 20);
    const began = performance.now();
    try {
      const got = await fetchLifecycle();
      assert.equal(got.merged, false);
    } finally {
      clearInterval(timer);
      Atomics.wait = wait;
      for (const [name, original] of originals) cp[name] = original;
      syncBuiltinESMExports();
    }
    const elapsed = performance.now() - began;
    assert.equal(syncCalls, 0, "no synchronous child_process call");
    assert.equal(waits, 0, "no Atomics.wait cadence sleep");
    assert.ok(elapsed >= 1000, `gh held the read for one second (${Math.round(elapsed)} ms)`);
    assert.ok(ticks.length >= 25, `the timer kept firing: ${ticks.length} ticks in ${Math.round(elapsed)} ms`);
  });

  it("W1-T13435 criterion 3: a failed read logs review.pending_post.error and the review goes on; merged or closed posts nothing", async () => {
    withGh({ stderr: "gh: Not Found (HTTP 404)", exit: 1 });
    const failed = await drive((opts) => review.postReviewPending({ ...opts, post: () => assert.fail("no post on a failed read") }));
    const error = failed.rows.find((r) => r.step === "review.pending_post.error");
    assert.ok(error, "the failure is written");
    assert.match(String(error.error), /\S/, "with the error text");
    assert.equal(failed.reviewed, 1, "the review went on");
    for (const pull of [row("closed", true), row("closed", false)]) {
      withGh({ stdout: JSON.stringify(pull) });
      const posts: string[] = [];
      const done = await drive((opts) => review.postReviewPending({ ...opts, post: ({ state }) => { posts.push(state); } }));
      assert.deepEqual(posts, [], `no pending status on a ${pull.merged ? "merged" : "closed"} pull request`);
      assert.ok(done.rows.some((r) => r.step === "review.skipped_closed_lifecycle" && r.reason === (pull.merged ? "pr_merged" : "pr_closed")));
    }
  });
});
