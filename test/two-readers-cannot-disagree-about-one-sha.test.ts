import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  fetchPrLifecycle,
  judgeReview,
  parseAcceptanceBlock,
  postReviewStatusGuarded,
  resolvePlanCriteriaAtHead,
  reviewInputDigest,
} from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { ciGateFromRollup, fetchCiFailures } from "../src/run-task.js";

const PR_URL = "https://github.com/craigoley/remudero/pull/3840";
const HEAD = "61f35181057c37af013b5e46c29a4cc43d388505";
const TASK_ID = "W1-T2783";
const BODY = [
  "## Acceptance",
  "",
  "- all three fixtures use the sanctioned prefix | unit test: test/mkdtemp-callsite-check.test.ts",
  "- the checker refuses a bare prefix | unit test: test/mkdtemp-callsite-check.test.ts",
  "- the affected modules keep passing | unit tests: test/open-prs-rest.test.ts and test/retro.test.ts",
  "",
  `Remudero-Task: ${TASK_ID}`,
  "",
].join("\n");

function planTask(acceptance: boolean): string {
  return [
    `- id: ${TASK_ID}`,
    "  title: reproduce the fixed-sha review subject",
    "  repo: remudero",
    "  type: implement",
    "  depends_on: []",
    "  verify: auto",
    "  status: queued",
    "  attempts: 0",
    ...(acceptance
      ? [
          "  acceptance:",
          '    - claim: "all three fixtures use the sanctioned prefix"',
          '      proof: "unit test: test/mkdtemp-callsite-check.test.ts"',
          '    - claim: "the checker refuses a bare prefix"',
          '      proof: "unit test: test/mkdtemp-callsite-check.test.ts"',
          '    - claim: "the affected modules keep passing"',
          '      proof: "unit tests: test/open-prs-rest.test.ts and test/retro.test.ts"',
        ]
      : []),
  ].join("\n");
}

function committedPlan(acceptance: boolean): { dir: string; sha: string } {
  const dir = makeTempDir("one-review-subject");
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  mkdirSync(join(dir, "plan"), { recursive: true });
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), planTask(acceptance) + "\n");
  writeFileSync(join(dir, "plan", "tasks.d", ".gitkeep"), "");
  execFileSync("git", ["add", "plan/tasks.yaml", "plan/tasks.d/.gitkeep"], { cwd: dir });
  execFileSync("git", ["commit", "--quiet", "-m", "plan"], { cwd: dir });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  return { dir, sha };
}

test("W1-T2793: one body and one plan blob cannot yield opposite criteria-presence answers or overwrite the current subject", async () => {
  const plan = committedPlan(true);
  const ledgerDir = makeTempDir("one-review-ledger");
  try {
    const planReader = resolvePlanCriteriaAtHead(BODY, plan.dir, "plan/tasks.yaml", plan.sha).criteria;
    const bodyReader = parseAcceptanceBlock(BODY);
    assert.equal(planReader.length, 3);
    assert.equal(bodyReader.length, 3);
    assert.equal(planReader.length > 0, bodyReader.length > 0, "two readers asked about one subject must agree whether criteria exist");

    const lifecycleCalls: string[][] = [];
    const lifecycle = fetchPrLifecycle(PR_URL, (args) => {
      lifecycleCalls.push(args);
      return {
        number: 3840,
        html_url: PR_URL,
        state: "open",
        merged: false,
        updated_at: "2026-09-03T18:52:59Z",
        head: { sha: HEAD },
        body: BODY,
      };
    });
    assert.equal(lifecycleCalls.length, 1, "input freshness rides on the existing lifecycle read; it spends no second GitHub call");

    const ledgerPath = join(ledgerDir, "ledger.ndjson");
    const posts: string[] = [];
    const stale = await postReviewStatusGuarded({
      owner: "craigoley",
      repo: "remudero",
      sha: HEAD,
      state: "failure",
      taskId: TASK_ID,
      evidence: "no_evidence",
      ledgerPath,
      runId: "second-reader",
      prUrl: PR_URL,
      reviewInputDigest: reviewInputDigest(HEAD, ""),
      fetchLifecycle: () => lifecycle,
      post: ({ state }) => {
        posts.push(state);
      },
    });

    assert.equal(stale.posted, false, "a criteria-less observation of a different body must not overwrite this sha's current subject");
    assert.equal(posts.length, 0);
    assert.match(stale.reason ?? "", /review input changed/);
    assert.equal(
      readLedgerLines(ledgerPath).some((line) => line.step === "review.post_refused" && line.reason === stale.reason),
      true,
      "the stale-subject refusal is durable and attributable",
    );
  } finally {
    rmSync(plan.dir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("W1-T2793: a subject that genuinely has no criteria still fails closed", () => {
  const plan = committedPlan(false);
  try {
    const body = `REPORT\n\nRemudero-Task: ${TASK_ID}\n`;
    const planReader = resolvePlanCriteriaAtHead(body, plan.dir, "plan/tasks.yaml", plan.sha).criteria;
    const bodyReader = parseAcceptanceBlock(body);
    assert.equal(planReader.length, 0);
    assert.equal(bodyReader.length, 0);
    assert.equal(judgeReview([], { diff: "", report: body }).state, "failure"); // still fails closed
  } finally {
    rmSync(plan.dir, { recursive: true, force: true });
  }
});

test("W1-T2793: the sibling CI-reader disagreement (instance 1: ciGateFromRollup vs fetchCiFailures) remains explicitly outside this review-status shard", () => {
  // Grounded in the REAL exported symbols (src/run-task.ts), not a re-declared stand-in — a
  // rename or a caller-side fix to either would break THIS import, not just a string literal.
  //
  // Neither reader takes an owner+sha and fetches its own rollup: `ciGateFromRollup` takes only
  // the rollup, and `fetchCiFailures` takes the rollup as its third argument (before the two
  // defaulted trailing params). Neither can pin anything itself, so instance 1's measured
  // disagreement (poll-start sha vs current head) is necessarily supplied by their CALLERS.
  assert.equal(ciGateFromRollup.length, 1, "ciGateFromRollup takes only the rollup it judges");
  assert.equal(fetchCiFailures.length, 3, "fetchCiFailures takes the rollup as its 3rd argument");

  // Fed the IDENTICAL rollup, both readers agree — the parsers themselves do not disagree about
  // one subject; only a caller handing them two DIFFERENT rollups (two different pinned shas)
  // could reproduce instance 1, which is exactly why a parser-only unification cannot close it.
  const sameRollup = [{ name: "ci", conclusion: "SUCCESS" }];
  assert.equal(ciGateFromRollup(sameRollup), "green");
  assert.equal(fetchCiFailures("owner", "repo", sameRollup).length, 0);

  // This shard's declared files are src/lib/sweep.ts, src/lib/review.ts, and this test — NOT
  // src/run-task.ts, where both readers' callers (and their sha-pinning) actually live. So
  // instance 1 stays explicitly out of scope here rather than silently claimed closed.
  const scope =
    "CI rollup reconciliation (src/run-task.ts's ciGateFromRollup/fetchCiFailures callers) " +
    "is out of scope here: its defect is pinning not parsing";
  assert.match(scope, /pinning not parsing/);
});
