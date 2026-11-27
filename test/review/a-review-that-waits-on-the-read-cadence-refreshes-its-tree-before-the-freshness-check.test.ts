// W1-T15037: a fresh-tree review takes its own-start freshness reading before its first gh read, so a long
// read-cadence wait while main moves is not read as stale code; code behind main at its start is still refused.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type ReviewCommandHost, reviewCommand } from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import type { ReviewerCodeFreshness } from "#src/lib/self-sync.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const PREPARED = "a".repeat(40);
const MOVED = "b".repeat(40);
const FRESH: ReviewerCodeFreshness = { status: "fresh", codeSha: PREPARED, originMainSha: PREPARED, advance: "none" };
const BEHIND: ReviewerCodeFreshness = { status: "stale", codeSha: PREPARED, originMainSha: MOVED, changedPaths: ["src/lib/review.ts"] };

/** The members this path uses; calling any other member fails the test by name. */
function hostFor(): ReviewCommandHost {
  const used: Partial<ReviewCommandHost> = {
    JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
    acceptedReviewAttemptId: () => undefined,
    reviewPostedDescription: (verdict) => verdict.summary,
    liveWorkerRunIds: new Set<string>(),
    reviewWorkerLockId: (runId) => `review-worker-${runId}`,
    // The command's default fetch; the deps below supply their own, so it is never called.
    reviewWorktreeAsync: { fetch: () => { throw new Error("host fetch was called"); } } as unknown as ReviewCommandHost["reviewWorktreeAsync"],
  };
  return new Proxy(used, {
    get(target, key) {
      if (key in target) return target[key as keyof ReviewCommandHost];
      if (key === "then" || key === "triagePullRequest") return undefined;
      return () => { throw new Error(`host.${String(key)} was called`); };
    },
  }) as ReviewCommandHost;
}

/** Drive `rmd review` as a fresh-tree child whose first gh read waits while main moves from PREPARED to MOVED. */
async function reviewWaitingOnTheCadence(mainAtStart: "prepared" | "moved") {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t15037-"));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  let mainMoved = mainAtStart === "moved";
  const order: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const errors: string[] = [];
  console.log = () => {};
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  try {
    const code = await reviewCommand(hostFor(), "6011", ["--repo", "acme/remudero"], {
      judgeAtOwnStart: true,
      resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }),
      fetchView: () => {
        // The gh read cadence lock: the read returns only after main has moved.
        order.push("gh-read");
        mainMoved = true;
        return {
          number: 6011,
          html_url: "https://github.com/acme/remudero/pull/6011",
          head: { ref: "fixture", sha: head },
          updated_at: new Date(0).toISOString(),
          body: "## Acceptance\n- the fixture holds | manual fixture",
        };
      },
      loadConfig: () => ({ root, claudeBin: "/bin/true" }) as Config,
      fetchHead: () => {},
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "other", message: "not needed" } }),
      postReviewPending: async () => {
        order.push("pending");
        return { posted: false };
      },
      reviewerCodeFreshness: () => {
        order.push("freshness");
        return mainMoved ? BEHIND : FRESH;
      },
      runReview: async (args) => {
        order.push("reviewer");
        const reading = await args.reviewerCodeFreshness!();
        assert.equal(reading.status, "fresh", "the reviewer publishes against its own-start reading");
        return {
          state: "success", criteria: [{ claim: "the fixture holds", proof: "proof", met: true, reason: "", proof_exec: "not_executable" }],
          testTheater: false, summary: "fixture success", floorDegraded: false, capped: false, keywordOnly: false,
          planOnly: false, headSha: head, reviewerOutcome: "success",
        };
      },
    });
    return { code, order, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T15037 criterion 1: a cadence wait alone does not cause an at-own-start refusal", async () => {
  const { code, order, errors } = await reviewWaitingOnTheCadence("prepared");
  assert.equal(errors.some((line) => line.includes("at its own start")), false, errors.join("\n"));
  // The own-start reading comes before the gh read that waits, and the review goes on to its reviewer.
  assert.deepEqual(order.slice(0, 2), ["freshness", "gh-read"]);
  assert.equal(order.includes("reviewer"), true, order.join(","));
  assert.equal(order.filter((step) => step === "freshness").length, 1, "main moving during the wait is not re-read");
  assert.equal(code, 0);
});

test("W1-T15037 criterion 2: a tree still behind after the refresh is refused as before", async () => {
  const { code, order, errors } = await reviewWaitingOnTheCadence("moved");
  assert.equal(code, 2);
  assert.equal(errors.some((line) => line.includes(`${PREPARED.slice(0, 12)} is behind origin/main ${MOVED.slice(0, 12)} at its own start`)), true,
    errors.join("\n"));
  // W1-T12227: no pending status and no reviewer.
  assert.equal(order.includes("pending"), false, order.join(","));
  assert.equal(order.includes("reviewer"), false, order.join(","));
});
