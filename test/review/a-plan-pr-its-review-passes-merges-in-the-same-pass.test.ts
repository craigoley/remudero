// W1-T11163 — a plan PR whose review just posted success is merged by that same review, not "held for a later pass".
// MEASURED 2026-11-02: #16199, #16210 and #16191 each read mergeable_state=blocked 0.4-1.2 s after their own
// review.posted success, while ci-gate and security-merge-policy were already green, and waited 6-29 min for a
// later pass. The review's arm now reads the head's required checks itself when GitHub still says blocked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { armAutoMergeDetailedAsync, type ArmDeps } from "#src/lib/arm-auto-merge.js";
import { readChecksGreenReviewedAtHead, reviewVerdictArm } from "#src/cli/commands/review.js";

const OWNER = "craigoley";
const REPO = "remudero";
const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/16199`;
const HEAD = "7eab311f47950b27ae7c7ec25a79c3017bc8ce5c";
const TASK = "PR-16199";

const REVIEW_PASSED = {
  ts: new Date(Date.now() - 1_000).toISOString(),
  run_id: "review-PR16199-1793651516262",
  task_id: TASK,
  step: "review.posted",
  lane: "review",
  state: "success",
  head_sha: HEAD,
  pr_url: PR_URL,
  capped: false,
};

/** The GitHub seams #16199's review arm met at 20:32:19Z: mergeable, 21 behind, `blocked`. */
function blockedPlanPr() {
  const calls: string[] = [];
  const said: string[] = [];
  const seams = {
    headSha: () => HEAD,
    ledgerLines: () => [REVIEW_PASSED],
    armAuto: () => void calls.push("armAuto"),
    mergeDirect: () => void calls.push("mergeDirect"),
    disableAuto: () => {},
    isMerged: () => false,
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 0, mergeableState: "blocked" }),
    updateBranch: () => {
      calls.push("updateBranch");
      return { ok: true };
    },
    readPlanTouch: () => "touched" as const,
    stackPrerequisite: () => ({ state: "unstacked" as const, parentNumbers: [] }),
    closingReferences: () => ({ state: "clean" as const, defused: [] }),
    mergeQueue: () => false,
    sleep: () => {},
    say: (msg: string) => void said.push(msg),
  };
  return { seams, calls, said };
}

test("W1-T11163 criterion 1: a blocked plan PR whose head reads green and reviewed is merged directly, once", async () => {
  const gh = blockedPlanPr();
  const asked: Array<[string, string]> = [];
  const result = await armAutoMergeDetailedAsync(PR_URL, TASK, {
    ...gh.seams,
    readChecksGreenReviewed: (prUrl: string, headSha: string) => {
      asked.push([prUrl, headSha]);
      return true;
    },
  } as unknown as ArmDeps<true>);
  assert.equal(result.outcome, "direct-merged");
  assert.deepEqual(gh.calls, ["mergeDirect"]);
  assert.deepEqual(asked, [[PR_URL, HEAD]], "the read names the head the verdict judged");
  assert.ok(gh.said.some((line) => line.startsWith("automerge.plan_pr_checks_green_at_head (W1-T11163)")), gh.said.join("\n"));
});

test("W1-T11163 criterion 1: without the read, or when it says not green or cannot answer, the plan PR is held as before", async () => {
  const absent = blockedPlanPr();
  assert.equal((await armAutoMergeDetailedAsync(PR_URL, TASK, absent.seams as unknown as ArmDeps<true>)).outcome, "plan-pr-held");
  assert.deepEqual(absent.calls, []);

  const pending = blockedPlanPr();
  const notGreen = await armAutoMergeDetailedAsync(PR_URL, TASK,
    { ...pending.seams, readChecksGreenReviewed: () => false } as unknown as ArmDeps<true>);
  assert.equal(notGreen.outcome, "plan-pr-held");
  assert.deepEqual(pending.calls, [], "a head whose checks are not green is never merged");

  const broken = blockedPlanPr();
  const unreadable = await armAutoMergeDetailedAsync(PR_URL, TASK, {
    ...broken.seams,
    readChecksGreenReviewed: () => {
      throw new Error("HTTP 502");
    },
  } as unknown as ArmDeps<true>);
  assert.equal(unreadable.outcome, "plan-pr-held");
  assert.deepEqual(broken.calls, []);
  assert.match(String(unreadable.directMergePreflight?.error), /required checks at 7eab311 unreadable: HTTP 502/);
});

/** A REST reader answering protection, check runs and statuses for HEAD, as the review's own token reads them. */
function restHead(statuses: Array<{ context: string; state: string }>, ciGate = "success") {
  const asked: string[] = [];
  const readText = async (args: string[]) => {
    asked.push(args[1] ?? "");
    if (args[1] === `repos/${OWNER}/${REPO}/branches/main/protection/required_status_checks`) {
      return JSON.stringify({ checks: [{ context: "remudero-review" }, { context: "ci-gate" }, { context: "security-merge-policy" }] });
    }
    throw new Error(`unexpected text read ${args.join(" ")}`);
  };
  const readJson = (args: string[]): unknown => {
    asked.push(args[1] ?? "");
    if (args[1] === `repos/${OWNER}/${REPO}/commits/${HEAD}/check-runs?per_page=100`) {
      return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: ciGate }] };
    }
    if (args[1] === `repos/${OWNER}/${REPO}/commits/${HEAD}/status`) return { statuses };
    throw new Error(`unexpected json read ${args.join(" ")}`);
  };
  return { readJson, readText, asked };
}

test("W1-T11163 criterion 2: the head read is green only when every required check passed and the review reads success", async () => {
  const green = restHead([{ context: "remudero-review", state: "success" }, { context: "security-merge-policy", state: "success" }]);
  assert.equal(await readChecksGreenReviewedAtHead(OWNER, REPO, HEAD, green.readJson, green.readText), true);
  assert.ok(green.asked.some((path) => path.endsWith("/protection/required_status_checks")), "the required list is branch protection's own");

  const policyPending = restHead([{ context: "remudero-review", state: "success" }, { context: "security-merge-policy", state: "pending" }]);
  assert.equal(await readChecksGreenReviewedAtHead(OWNER, REPO, HEAD, policyPending.readJson, policyPending.readText), false);

  const gateRunning = restHead([{ context: "remudero-review", state: "success" }, { context: "security-merge-policy", state: "success" }], "");
  assert.equal(await readChecksGreenReviewedAtHead(OWNER, REPO, HEAD, gateRunning.readJson, gateRunning.readText), false);

  const reviewPending = restHead([{ context: "remudero-review", state: "pending" }, { context: "security-merge-policy", state: "success" }]);
  assert.equal(await readChecksGreenReviewedAtHead(OWNER, REPO, HEAD, reviewPending.readJson, reviewPending.readText), false);

  const unprotected = restHead([{ context: "remudero-review", state: "success" }, { context: "security-merge-policy", state: "success" }]);
  const refused = async () => {
    throw new Error("HTTP 403: Resource not accessible by integration");
  };
  assert.equal(await readChecksGreenReviewedAtHead(OWNER, REPO, HEAD, unprotected.readJson, refused), false,
    "an unreadable required list never manufactures a green");
});

test("W1-T11163 criterion 3: the review's own arm asks its head through the fresh read and merges a blocked plan PR", async () => {
  const gh = blockedPlanPr();
  const asked: Array<[string, string, string]> = [];
  const arm = reviewVerdictArm(OWNER, REPO, () => gh.seams as unknown as ArmDeps<true>, async (owner, repo, headSha) => {
    asked.push([owner, repo, headSha]);
    return true;
  });
  const result = await arm(PR_URL, TASK);
  assert.equal(result.outcome, "direct-merged");
  assert.deepEqual(gh.calls, ["mergeDirect"]);
  assert.deepEqual(asked, [[OWNER, REPO, HEAD]]);
});
