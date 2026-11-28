import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { PROOF_REUSE_SHADOW_STEP, runReview, type ReviewCommandHost } from "#src/cli/commands/review.js";
import { setProofSandboxForTests } from "#src/lib/review.js";
import { buildBaseProofDirAsync } from "#src/lib/check-proof.js";
import { spawnWorker } from "#src/lib/worker.js";
// @ts-expect-error the hosted gate is a plain .mjs module.
import * as gate from "#scripts/proof-discrimination-gate.mjs";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const owner = "acme", repo = "remudero", prUrl = `https://github.com/${owner}/${repo}/pull/14745`;
const diff = "diff --git a/src/proofs.ts b/src/proofs.ts\n--- a/src/proofs.ts\n+++ b/src/proofs.ts\n@@ -1 +1 @@\n-old\n+new\n";
const unexpected = () => { throw new Error("unexpected review fixture dependency"); };
const proof = (i: number) => `grep: proof-${i}-marker in src/proofs.ts`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture(t: TestContext, withBase = false) {
  setProofSandboxForTests({ mode: "unsandboxed", reason: "disposable proof fixture" });
  t.after(() => setProofSandboxForTests());
  const checkout = gitRepo({ scope: t, kind: "proof-audit" });
  const path = join(checkout.dir, "src/proofs.ts");
  const base = withBase ? gitRepo({ scope: t, cloneFrom: checkout.dir, kind: "proof-audit-base" }) : undefined;
  if (base) {
    mkdirSync(join(base.dir, "src"));
    writeFileSync(join(base.dir, "src/proofs.ts"), "export const base = true;\n");
    base.git("add", ".");
    base.git("commit", "-qm", "fixture base");
  }
  for (const [file, contents] of Object.entries({
    "src/proofs.ts": Array.from({ length: 100 }, (_, i) => `export const marker${i} = "proof-${i}-marker";`).join("\n") + "\n",
    "scripts/proof-discrimination-gate.mjs": "export {};\n",
    [gate.PROOF_DISCRIMINATION_WORKFLOW]: "name: Proof discrimination\n",
  })) {
    mkdirSync(dirname(join(checkout.dir, file)), { recursive: true });
    writeFileSync(join(checkout.dir, file), contents);
  }
  checkout.git("add", ".");
  let headSha: string;
  const advance = () => {
    checkout.git("commit", "--allow-empty", "-qm", "fixture head");
    headSha = checkout.git("rev-parse", "HEAD");
    return headSha;
  };
  advance();
  const host: ReviewCommandHost = {
    GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
    acceptedReviewAttemptId: value => typeof value === "string" ? value : undefined,
    attributeWorkerStreamEvent: event => event, ledgeredNonDispatchSpawn: (_lane, raw) => raw ?? spawnWorker,
    lintPlanForReview: unexpected, liveWorkerRunIds: new Set(), materializeReviewWorktree: unexpected,
    readHeadShaRest: () => headSha, readMainPlanTreeSha: unexpected,
    realDeps: () => ({ reviewWorktree: { fetch: () => {} } }) as unknown as ReturnType<ReviewCommandHost["realDeps"]>,
    reviewPostedDescription: verdict => verdict.summary, reviewWorkerLockId: runId => runId,
    reviewerClockBoundMs: () => 60_000, reviewSubjectGit: unexpected,
  };
  const digests = gate.executorDigestsAt(checkout.dir);
  const review = async (proofs: string[], options: {
    hosted?: Array<"pass" | "fail" | "executed_stale" | undefined>; overrides?: Record<string, unknown>;
    runHead?: string; diff?: string; repository?: string; grepBase?: boolean;
  } = {}) => {
    const acceptance = proofs.map((p, index) => ({ claim: `marker ${index} exists`, proof: p }));
    const body = `## Acceptance\n${acceptance.map(c => `- claim: ${c.claim}\n  proof: ${c.proof}`).join("\n")}\n`;
    const hosted = options.hosted ?? proofs.map(() => "pass" as const);
    const baseProof = options.grepBase ? await buildBaseProofDirAsync(acceptance, checkout.dir) : undefined;
    if (baseProof?.baseCheckoutDir) t.after(() => rmSync(baseProof.baseCheckoutDir!, { recursive: true, force: true }));
    const recordBaseSha = options.grepBase ? checkout.git("merge-base", "origin/main", "HEAD") : base?.git("rev-parse", "HEAD");
    const line = gate.resultLine({ format: gate.RESULT_FORMAT, head_sha: headSha, base_sha: recordBaseSha, body_digest: sha(body),
      executor_digest: digests.executor_digest, workflow_digest: digests.workflow_digest,
      proofs: proofs.flatMap((p, index) => hosted[index] === undefined ? [] : [{ proof: p, verdict: hosted[index],
        head: hosted[index] === "fail" ? "fail" : "pass", base: hosted[index] === "executed_stale" ? "pass" : "no-match" }]),
      ...options.overrides });
    const rows: Array<Record<string, unknown>> = [];
    const repository = options.repository ?? repo;
    const result = await withGhShim([
      { when: "pr diff", stdout: options.diff ?? diff },
      { when: "actions/workflows/proof-discrimination-gate.yml/runs", stdout: JSON.stringify({ workflow_runs: [
        { id: 77, head_sha: options.runHead ?? headSha, path: gate.PROOF_DISCRIMINATION_WORKFLOW, conclusion: "success", event: "pull_request" },
      ] }) },
      { when: "actions/runs/77/jobs", stdout: JSON.stringify({ jobs: [
        { id: 88, run_id: 77, name: gate.PROOF_DISCRIMINATION_JOB, head_sha: headSha, conclusion: "success" },
      ] }) },
      { when: "actions/jobs/88/logs", stdout: line },
      { when: "api", stdout: "{}" },
    ], () => runReview(host, { owner, repo: repository, prUrl: prUrl.replace(`/${repo}/`, `/${repository}/`),
      task: { id: "W1-T14745", acceptance, files: ["src/proofs.ts"] }, report: body,
      settingsFile: join(checkout.dir, "settings.json"), config: { root: checkout.dir } as never,
      headCheckoutDir: checkout.dir, ledgerPath: join(checkout.dir, ".git", "ledger.ndjson"), runId: "proof-audit",
      baseCheckoutDir: baseProof?.baseCheckoutDir ?? base?.dir,
      baseIsCheckout: baseProof?.baseIsCheckout ?? base !== undefined, baseIsGrepTree: baseProof?.baseIsGrepTree,
      log: (step, extra) => rows.push({ step, ...extra }), say: () => {}, account: result => result,
      shadow: true, spawnReviewer: false, readReviewReuseFacts: () => undefined, runtimeImageSha: null,
    }));
    const shadow = rows.find(row => row.step === PROOF_REUSE_SHADOW_STEP);
    assert.ok(shadow);
    return { result, shadow, disagreements: rows.filter(row => row.step === "proof_reuse.disagreement") };
  };
  return { advance, review, path, checkout, auditDir: join(checkout.dir, ".git", "review-proof-audit") };
}

const training = Array.from({ length: 12 }, (_, i) => proof(i));

function sampledProofs(head: string) {
  const candidates = Array.from({ length: 88 }, (_, i) => proof(i + training.length));
  const isAudited = (p: string) => parseInt(sha(JSON.stringify([head, p])).slice(0, 8), 16) / 2 ** 32 < 2 / (training.length + 2);
  const audited = candidates.find(isAudited);
  const reused = candidates.find(p => !isAudited(p));
  assert.ok(audited && reused);
  return { audited, reused };
}

test("W1-T14745 criterion 1: a hosted pass outside the audit skips the host and identifies its run and job", async t => {
  const f = fixture(t, true);
  const cold = await f.review(training);
  assert.equal(cold.result.proofUniqueRuns, training.length * 2);
  const { reused } = sampledProofs(f.advance());
  const { result } = await f.review([reused]);
  assert.equal(result.proofUniqueRuns, 0);
  assert.equal(result.criteria[0]?.met, true);
  assert.equal(result.criteria[0]?.proof_exec, "executed_pass");
  assert.match(result.criteria[0]!.reason, /reused hosted proof PASS \(run 77, job 88\)/);
  const differentBase = await f.review([reused], { overrides: { base_sha: "f".repeat(40) } });
  assert.equal(differentBase.result.proofUniqueRuns, 2);
});

test("W1-T14745 ordinary grep-only review verifies the base tree merge-base and reuses an unaudited pass", async t => {
  const f = fixture(t);
  const cold = await f.review(training);
  f.checkout.git("update-ref", "refs/remotes/origin/main", cold.result.headSha);
  const { reused } = sampledProofs(f.advance());
  const { result, shadow } = await f.review([reused], { grepBase: true });
  assert.equal(result.proofUniqueRuns, 0);
  assert.equal(result.criteria[0]?.met, true);
  assert.match(result.criteria[0]!.reason, /reused hosted proof PASS \(run 77, job 88\)/);
  assert.deepEqual(shadow.reused_proofs, [reused]);
  assert.deepEqual(shadow.audited_proofs, []);
});

test("W1-T14745 criterion 2: fail, stale, absent and ineligible hosted evidence still reach the host", async t => {
  const f = fixture(t);
  await f.review(training);
  const head = f.advance();
  const { audited, reused } = sampledProofs(head);
  for (const options of [
    { hosted: ["fail", "executed_stale"] as const },
    { hosted: [undefined, "pass"] as const },
    { runHead: "f".repeat(40) },
    { overrides: { head_sha: "f".repeat(40) } },
    { overrides: { executor_digest: "0".repeat(64) } },
    { overrides: { workflow_digest: "0".repeat(64) } },
    { diff: `${diff}diff --git a/scripts/proof-discrimination-gate.mjs b/scripts/proof-discrimination-gate.mjs\n` },
  ]) {
    const { result, shadow } = await f.review([reused, audited], {
      ...options, hosted: options.hosted && [...options.hosted],
    });
    assert.equal(result.proofUniqueRuns, 2, JSON.stringify(options));
    assert.deepEqual(result.criteria.map(c => c.proof_exec), ["executed_pass", "executed_pass"]);
    assert.deepEqual(shadow.reused_proofs, []);
  }
});

test("W1-T14745 criterion 3: agreement reduces the audit share and a disagreement restores a full audit", async t => {
  const f = fixture(t);
  const cold = await f.review(training);
  assert.equal(cold.shadow.audit_share, 1);
  assert.deepEqual(cold.shadow.audited_proofs, training);
  const { audited, reused } = sampledProofs(f.advance());
  const warm = await f.review([audited, reused]);
  assert.equal(warm.shadow.audit_share, 2 / (training.length + 2));
  assert.deepEqual(warm.shadow.audited_proofs, [audited]);
  const repeated = await f.review([audited, reused]);
  assert.equal(repeated.shadow.audit_share, warm.shadow.audit_share);
  assert.deepEqual(repeated.shadow.audited_proofs, [audited]);
  assert.deepEqual(repeated.shadow.reused_proofs, [reused]);

  writeFileSync(f.path, "export const host = 'missing both markers';\n");
  const disagreed = await f.review([audited, reused]);
  assert.equal(disagreed.result.state, "failure");
  assert.deepEqual(disagreed.result.criteria.map(c => c.proof_exec), ["executed_fail", "executed_fail"]);
  assert.deepEqual(disagreed.shadow.reused_proofs, []);
  assert.deepEqual(disagreed.shadow.audited_proofs, [audited, reused]);
  assert.equal(disagreed.shadow.audit_share, 1);
  assert.deepEqual(disagreed.disagreements.map(row => [row.pr_url, row.head_sha, row.proof, row.hosted, row.host]), [
    [prUrl, disagreed.result.headSha, audited, "pass", "executed_fail"],
    [prUrl, disagreed.result.headSha, reused, "pass", "executed_fail"],
  ]);
  f.advance();
  const reset = await f.review([audited]);
  assert.equal(reset.shadow.audit_share, 1);
  assert.equal(reset.result.proofUniqueRuns, 1);
});

test("W1-T14745 criterion 4: the shadow row names real audits and reused passes beside a host failure", async t => {
  const f = fixture(t);
  await f.review(training);
  const { reused, audited } = sampledProofs(f.advance());
  const failsOnHost = proof(100);
  const proofs = [reused, audited, failsOnHost];
  const otherRepository = await f.review(proofs, { hosted: ["pass", "pass", "fail"], repository: "other" });
  assert.equal(otherRepository.result.proofUniqueRuns, 3);
  const { result, shadow } = await f.review(proofs, { hosted: ["pass", "pass", "fail"] });
  assert.equal(result.proofUniqueRuns, 2);
  assert.equal(result.state, "failure");
  assert.equal(result.criteria[2]?.proof_exec, "executed_fail");
  assert.deepEqual(shadow.reused_proofs, [reused]);
  assert.deepEqual(shadow.audited_proofs, [audited]);
  assert.equal(shadow.agreed, 2);
  assert.ok(typeof shadow.saved_ms === "number" && shadow.saved_ms >= 0);
});

test("an unavailable audit state leaves the hosted pass to the host executor", async t => {
  const f = fixture(t);
  writeFileSync(f.auditDir, "prevents audit database creation");
  const { result, shadow } = await f.review([proof(0)]);
  assert.equal(result.proofUniqueRuns, 1);
  assert.deepEqual(shadow.reused_proofs, []);
  assert.match(String(shadow.audit_unavailable), /EEXIST/);
});
