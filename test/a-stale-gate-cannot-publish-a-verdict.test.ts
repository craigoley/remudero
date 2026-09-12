import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readLedgerLines } from "../src/lib/status.js";
import { postReviewStatusGuarded, type PrLifecycleState } from "../src/lib/review.js";
import { checkReviewerCodeFreshness, SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";

const OLD = "a".repeat(40);
const MAIN = "b".repeat(40);
const OPEN: PrLifecycleState = { merged: false, closed: false };

function materialStale() {
  return checkReviewerCodeFreshness("/unused", {}, {
    checkServiceFreshness: () => ({
      status: "assessed",
      dirty: true,
      behind: { oldSha: OLD, newSha: MAIN, changedPaths: ["src/lib/review.ts"] },
    }),
  });
}

function immaterialAdvance() {
  return checkReviewerCodeFreshness("/unused", {}, {
    checkServiceFreshness: () => ({
      status: "assessed",
      dirty: true,
      behind: { oldSha: OLD, newSha: MAIN, changedPaths: ["docs/review-gate.md"] },
    }),
  });
}

test("W1-T3337: the CLI self-reexec guard never suppresses the reviewer code probe", () => {
  const calls: string[] = [];
  const result = checkReviewerCodeFreshness("/unused", { [SELF_SYNC_GUARD_ENV]: "1" }, {
    checkServiceFreshness: () => ({ status: "guarded" }),
    git: (args) => {
      calls.push(args.join(" "));
      if (args[0] === "fetch") return "";
      if (args.join(" ") === "rev-parse HEAD") return OLD;
      if (args.join(" ") === "rev-parse origin/main") return MAIN;
      if (args[0] === "diff") return "src/lib/review.ts\n";
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  });
  assert.equal(result.status, "stale");
  assert.deepEqual(calls, ["fetch --quiet origin", "rev-parse HEAD", "rev-parse origin/main", `diff --name-only ${OLD}..${MAIN}`]);
});

function postOpts(ledgerPath: string, reviewerCodeFreshness: ReturnType<typeof materialStale>) {
  return {
    owner: "acme",
    repo: "remudero",
    sha: "c".repeat(40),
    state: "failure" as const,
    description: "remudero-review: FAIL — this deliberately long verdict describes a failure while preserving its producer provenance",
    taskId: "W1-T3337",
    evidence: "executed" as const,
    ledgerPath,
    runId: "W1-T3337-test",
    prUrl: "https://github.com/acme/remudero/pull/3337",
    fetchLifecycle: () => OPEN,
    reviewerCodeFreshness,
  };
}

test("W1-T3337: a material source advance withholds the stale reviewer's failure instead of publishing a binding verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-stale-review-"));
  try {
    const stale = materialStale();
    assert.deepEqual(stale, {
      status: "stale",
      codeSha: OLD,
      originMainSha: MAIN,
      changedPaths: ["src/lib/review.ts"],
      diffUnreadable: undefined,
    });
    let postCalls = 0;
    const result = await postReviewStatusGuarded({
      ...postOpts(join(root, "ledger.ndjson"), stale),
      post: () => {
        postCalls++;
      },
    });
    assert.equal(result.posted, false);
    assert.match(result.reason ?? "", /materially behind origin\/main/);
    assert.equal(postCalls, 0, "a stale review process must not POST a failure status");
    const refusal = readLedgerLines(join(root, "ledger.ndjson")).find((line) => line.step === "review.post_refused");
    assert.deepEqual(
      { state: refusal?.attempted_state, code: refusal?.reviewer_code_sha, main: refusal?.origin_main_sha },
      { state: "failure", code: OLD, main: MAIN },
      "the withheld verdict remains attributable to the exact stale evaluator and main advance",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3337: an immaterial advance still publishes and makes the reviewer's loaded code SHA visible on the verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-stale-review-"));
  try {
    const fresh = immaterialAdvance();
    assert.deepEqual(fresh, { status: "fresh", codeSha: OLD, originMainSha: MAIN, advance: "immaterial" });
    const posted: Array<{ state: string; description?: string }> = [];
    const result = await postReviewStatusGuarded({
      ...postOpts(join(root, "ledger.ndjson"), fresh),
      post: ({ state, description }) => {
        posted.push({ state, description });
      },
    });
    assert.equal(result.posted, true);
    assert.deepEqual(posted.map((entry) => entry.state), ["failure"]);
    assert.match(posted[0]?.description ?? "", new RegExp(`\\[review code ${OLD.slice(0, 12)}\\]$`));
    assert.ok((posted[0]?.description?.length ?? Infinity) <= 140, "the provenance must survive GitHub's status-description cap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3337 wiring: every production terminal-review path supplies a just-in-time code-freshness reader", () => {
  const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const readers = source.match(/reviewerCodeFreshness: \(\) => checkReviewerCodeFreshness\(repoRoot, process\.env\)/g) ?? [];
  assert.equal(readers.length, 3, "run-task, its fix-rung re-reviews, and rmd review must all use the same freshness reader");
  assert.match(source, /if \(review\.codeFreshnessWithheld\)/, "a withheld result must stand down before the primary fix rung");
  assert.match(source, /site: "rung\.reviewer_code_freshness"/, "a re-review inside the fix rung must also stand down");
});
