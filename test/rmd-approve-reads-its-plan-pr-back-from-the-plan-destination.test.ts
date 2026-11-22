/**
 * W1-T14311: `rmd approve` read the plan PR it had just opened back from the PUBLIC repository, so a ratification
 * filed in the plan destination (remudero-ops) 404ed on `repos/<public>/pulls/<n>` and was recorded as approve.error.
 * The read is the review command's first fetch: given a PR URL it kept only the number and resolved the owner and
 * repository from this checkout. These tests drive the REAL review command (review.ts) with the arguments approve's
 * exported seam `planPrReviewInvocation` produces, over a GitHub that 404s every read outside the repository the
 * PR lives in. The run-task.ts call sites are proved by a source grep (no new importer of run-task.ts).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { reviewCommand, type ReviewCommandHost } from "#src/cli/commands/review.js";
import { planPrReviewInvocation } from "#src/lib/plan-pr-emitter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const PUBLIC = { owner: "acme", repo: "public-repo" };
const OPS = { owner: "acme", repo: "ops-repo" };
const NUMBER = 297;
const OPS_URL = `https://github.com/${OPS.owner}/${OPS.repo}/pull/${NUMBER}`;
const PUBLIC_URL = `https://github.com/${PUBLIC.owner}/${PUBLIC.repo}/pull/${NUMBER}`;

function unexpected(): never { throw new Error("unexpected review fixture dependency"); }
const host: ReviewCommandHost = {
  GIT_UNTRACKED_FILES_ALL: "--untracked-files=all",
  JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
  acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined,
  attributeWorkerStreamEvent: (event) => event,
  ledgeredNonDispatchSpawn: unexpected,
  lintPlanForReview: unexpected,
  liveWorkerRunIds: new Set<string>(),
  materializeReviewWorktree: unexpected,
  readHeadShaRest: unexpected,
  readMainPlanTreeSha: unexpected,
  realDeps: () => ({ reviewWorktree: { fetch: () => {} } }) as unknown as ReturnType<ReviewCommandHost["realDeps"]>,
  reviewPostedDescription: (verdict) => verdict.summary,
  reviewWorkerLockId: (runId) => runId,
  reviewerClockBoundMs: () => 60_000,
  reviewSubjectGit: unexpected,
};

/** One PR that lives in `home`: a read of any other repository answers like GitHub does, with a 404. */
async function readBack(t: TestContext, invocation: { prArg: string; rest: string[] }, home: { owner: string; repo: string }) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t14311-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reads: string[] = [];
  const quiet = console.log;
  console.log = () => {};
  let code: number;
  try {
    code = await reviewCommand(host, invocation.prArg, invocation.rest, {
      resolveOwnerRepo: () => PUBLIC,
      loadConfig: () => ({ claudeBin: "/bin/true", root }) as never,
      fetchView: (args: string[]) => {
        const path = args.find((a) => a.startsWith("repos/")) ?? args.join(" ");
        reads.push(path);
        if (!path.startsWith(`repos/${home.owner}/${home.repo}/pulls/`)) throw new Error(`gh: Not Found (HTTP 404): ${path}`);
        return { number: NUMBER, html_url: `https://github.com/${home.owner}/${home.repo}/pull/${NUMBER}`, state: "closed",
          merged_at: "2026-11-22T12:00:00Z", body: "", head: { ref: "run-approve", sha: "a".repeat(40) } };
      },
    } as never);
  } finally {
    console.log = quiet;
  }
  return { reads, code };
}

test("W1-T14311 criterion 1: a plan PR opened in the plan destination is read back from that repository", async (t) => {
  const invocation = planPrReviewInvocation({ ...OPS, destination: true }, OPS_URL, String(NUMBER));
  const { reads } = await readBack(t, invocation, OPS);
  assert.deepEqual(reads, [`repos/${OPS.owner}/${OPS.repo}/pulls/${NUMBER}`]);
  // The defect, on the arguments origin/main passed (the bare URL, no --repo): the public repository, a 404.
  await assert.rejects(readBack(t, { prArg: OPS_URL, rest: [] }, OPS), /404.*public-repo\/pulls\/297/);
});

test("W1-T14311 criterion 1: both approve call sites hand the review command the seam's arguments", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.equal(src.split("planPrReviewInvocation(filing, result.prUrl, prNum)").length - 1, 2, "single and batch approve");
  assert.equal(src.includes("reviewCommand(filing.destination ? result.prUrl : prNum)"), false, "the unqualified read is gone");
  assert.equal(src.split("reviewCommand(reviewAs.prArg, reviewAs.rest)").length - 1, 4, "triage, plan, approve and batch");
});

test("W1-T14311 criterion 1: the triage and plan gates route a destination PR through the same seam", async (t) => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.ok(src.includes("{ ...prTarget, destination: true } : { owner, repo, destination: false }, prUrl, prNum)"), "triage: a destination PR reads from its own URL's repository");
  assert.ok(src.includes("planPrReviewInvocation({ owner: prOwner, repo: prRepo, destination: !isPublic }, prUrl, prNum)"), "plan: a destination side reads from its own repository");
  assert.equal(src.includes("reviewCommand(view === undefined ? prNum : prUrl)"), false);
  assert.equal(src.includes("reviewCommand(isPublic ? prNum : prUrl)"), false);
  // Triage: the destination PR (target parsed from its URL) and plan: the destination side (side.owner/repo).
  const triage = planPrReviewInvocation({ ...OPS, destination: true }, OPS_URL, String(NUMBER));
  assert.deepEqual((await readBack(t, triage, OPS)).reads, [`repos/${OPS.owner}/${OPS.repo}/pulls/${NUMBER}`]);
  // A public PR of the same run stays on the bare number, as today.
  assert.deepEqual(planPrReviewInvocation({ ...PUBLIC, destination: false }, PUBLIC_URL, String(NUMBER)), { prArg: String(NUMBER), rest: [] });
});

test("W1-T14311 criterion 2: a ratification that opens and merges in the plan destination reads back without an error", async (t) => {
  const invocation = planPrReviewInvocation({ ...OPS, destination: true }, OPS_URL, String(NUMBER));
  const { code } = await readBack(t, invocation, OPS);
  // The merged PR reads as closed before review (exit 2), which mergedBeforeGate turns into approve's exit 0.
  // Before the fix this read threw, and approve's catch wrote approve.error and exited 1.
  assert.equal(code, 2);
});

test("W1-T14311 criterion 3: a public plan destination reads back exactly as before", async (t) => {
  assert.deepEqual(planPrReviewInvocation({ ...PUBLIC, destination: false }, PUBLIC_URL, String(NUMBER)),
    { prArg: String(NUMBER), rest: [] });
  const invocation = planPrReviewInvocation({ ...PUBLIC, destination: false }, PUBLIC_URL, String(NUMBER));
  const { reads, code } = await readBack(t, invocation, PUBLIC);
  assert.deepEqual(reads, [`repos/${PUBLIC.owner}/${PUBLIC.repo}/pulls/${NUMBER}`]);
  assert.equal(code, 2);
});
