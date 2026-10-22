import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { gitRepo } from "#test/helpers/git-repo.js";
import { validateProofAmendmentProposal } from "#src/lib/proof-amendment.js";
import type { ProofDiscriminationEvidence } from "#src/lib/sweep.js";
import type { WhitelistedProof } from "#src/lib/review.js";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { dispatchProofAmendmentWrite, runFixRung } from "#test/helpers/run-task-test.js";

// A proof-discrimination fix round is asked to PROPOSE a replacement for a capped proof in a PROOF_AMENDMENT block, which
// the parent validates and writes (W1-T3434). Five NEEDS_DESIGN rounds since 2026-10-10 carried such a block (W1-T5689,
// W1-T8921, PR-12997 twice, PR-13282) and the core ledger holds no `proof_amendment.requested` row for any of them:
// runFixRung's hand-off arm returned before either writer call. And on a first round the review is the sweep's
// reconstruction, whose `state: "failure"` made the writer read the PR as `review-not-success` (the one such row ever
// ledgered, W1-T3610 on 2026-09-16). The sweep derives this evidence only from a posted success + capped review.

const TASK = "W1-T13282-FIXTURE";
const CLAIM = "escalation triage is set to act";
const OLD_PROOF = "grep: OPERATOR 2026-10-21: act in plan/policy.yaml";
const NEW_PROOF = "grep: ^  mode: act$ in plan/policy.yaml";
const PR_URL = "https://github.com/acme/remudero/pull/13282";
const SHARD = `plan/tasks.d/${TASK}-fixture.yaml`;
const REPORT = [
  "No files were edited.", "", "PROOF_AMENDMENT:", `1. claim: ${CLAIM}`, `   old_proof: ${OLD_PROOF}`, `   new_proof: ${NEW_PROOF}`,
  "", "FIX_OUTCOME: NEEDS_DESIGN stale plan proof requires a parent-owned amendment; this worker cannot edit the task criteria",
].join("\n");

function evidence(): ProofDiscriminationEvidence {
  return { proofs: [{ claim: CLAIM, proof: OLD_PROOF, proofExec: "executed_stale" }] };
}

function reconstructedReview(headSha: string) {
  return { state: "failure" as const, capped: true, reviewerOutcome: "sweep-reconstructed", testTheater: false,
    summary: "sweep-reconstructed capped review (1 proof(s) need discrimination)", floorDegraded: false, keywordOnly: false,
    planOnly: false, headSha,
    criteria: [{ claim: CLAIM, proof: OLD_PROOF, met: true, reason: "capped proof requires base discrimination", proof_exec: "executed_stale" as const }] };
}

/** A real repository whose merge base is `mode: shadow` and whose head flips it to `act` beside an operator comment, the
 *  shape of #13282's diff. The header carries `src/lib/*.ts`, as plan/policy.yaml's own line 8 does. */
function policyFixture(withShard: boolean) {
  const repo = gitRepo({ kind: "needs-design-proof-amendment" });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  const header = "# literals scattered across src/lib/*.ts\n";
  writeFileSync(join(repo.dir, "plan/policy.yaml"), `${header}escalationTriage:\n  mode: shadow\n`);
  if (withShard) {
    writeFileSync(join(repo.dir, SHARD), `- id: ${TASK}\n  acceptance:\n    - claim: "${CLAIM}"\n      proof: "${OLD_PROOF}"\n`);
  }
  repo.git("add", "-A");
  repo.git("commit", "-qm", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo.dir, "plan/policy.yaml"), `${header}# OPERATOR 2026-10-21: act. Shadow 10-14..10-21\nescalationTriage:\n  mode: act\n`);
  repo.git("commit", "-qam", "act");
  return repo;
}

function dispatch(repo: ReturnType<typeof policyFixture>, transcriptText: string) {
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const written: Array<{ path: string; text: string }> = [];
  const created: string[] = [];
  dispatchProofAmendmentWrite(
    { prUrl: PR_URL, taskId: TASK, worktreePath: repo.dir, config: { root: repo.dir } as Config,
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir }, evidence: evidence(), transcriptText,
      review: reconstructedReview(repo.git("rev-parse", "HEAD")), priorHeadSha: repo.git("rev-parse", "HEAD"),
      log: (step, extra) => rows.push({ step, ...extra }), getLedgerLinesNow: () => [] },
    {
      findShardFn: () => ({ path: SHARD, text: readFileSync(join(repo.dir, SHARD), "utf8") }),
      worktreeAddFn: () => {}, worktreeRemoveFn: () => {}, gitFn: () => "amendsha", gitPushFn: () => {},
      writeFileFn: (path, text) => written.push({ path, text }), assertLiveWriteAllowedFn: () => {},
      probeExistingPlanPrFn: () => undefined,
      createPlanPrRestFn: (_fetch, _owner, _repo, o) => {
        created.push(o.head);
        return { prUrl: "https://github.com/acme/remudero/pull/9001", prNumber: 9001 } as never;
      },
    },
  );
  return { rows, written, created };
}

test("NEEDS_DESIGN proof amendment: a reconstructed capped review is eligible and opens the one plan amendment", () => {
  const repo = policyFixture(true);
  const { rows, written, created } = dispatch(repo, REPORT);
  const requested = rows.find((r) => r.step === "proof_amendment.requested");
  assert.equal(requested?.outcome, "created", JSON.stringify(rows));
  assert.deepEqual(created, [`proof-amendment/${TASK}-13282`]);
  assert.equal(written.length, 1);
  assert.match(written[0]!.text, /proof: "grep: \^ {2}mode: act\$ in plan\/policy\.yaml"/, "the one proof scalar is replaced, with its `$` literal");
});

test("NEEDS_DESIGN proof amendment: a replacement whose head match is only a comment is refused, as the reviewer caps it", () => {
  // plan/policy.yaml's header holds `src/lib/*.ts`, and the reviewer's mask reads every later line as a comment for a
  // literal pattern. The same check here refuses the proposal instead of opening an amendment the reviewer caps again.
  const repo = policyFixture(true);
  const comment = dispatch(repo, REPORT.replace(NEW_PROOF, "grep: OPERATOR 2026-10-21: act. Shadow in plan/policy.yaml"));
  const requested = comment.rows.find((r) => r.step === "proof_amendment.requested");
  assert.deepEqual([requested?.outcome, requested?.reason], ["refused", "not-discriminating"], JSON.stringify(comment.rows));
  assert.match(String(requested?.detail), /only comment lines/);
  assert.equal(comment.created.length, 0);

  const head = mkdtempSync(join(tmpdir(), "rmd-comment-proof-head-"));
  const base = mkdtempSync(join(tmpdir(), "rmd-comment-proof-base-"));
  mkdirSync(join(head, "src"));
  mkdirSync(join(base, "src"));
  writeFileSync(join(head, "src/x.ts"), "// marker of the change\nexport const live = 1;\n");
  writeFileSync(join(base, "src/x.ts"), "export const live = 0;\n");
  const input = { headCwd: head, baseCwd: base, currentHeadSha: "h", pinnedHeadSha: "h", planShardPaths: new Set<string>() };
  const entry = (newProof: string) => [{ claim: CLAIM, oldProof: OLD_PROOF, newProof }];
  assert.equal(validateProofAmendmentProposal(entry("grep: marker of the change in src/x.ts"), evidence(), input).ok, false);
  assert.equal(validateProofAmendmentProposal(entry("grep: export const live = 1; in src/x.ts"), evidence(), input).ok, true);
  // A matched line whose file the context cannot read falls back to the line's own text, as the reviewer's does.
  const fakeHead = (w: WhitelistedProof) => {
    w.matchedLines = ["src/gone.ts:1:// gone"];
    return "pass" as const;
  };
  assert.equal(validateProofAmendmentProposal(entry("grep: gone in src/gone.ts"), evidence(),
    { ...input, execAtHead: fakeHead, execAtBase: () => "fail" }).ok, false);
});

test("NEEDS_DESIGN proof amendment: a proof-discrimination round that ends NEEDS_DESIGN hands its proposal to the writer first", async () => {
  // No shard in this repository, so the writer runs and refuses by name with no worktree, push or GitHub call.
  const repo = policyFixture(false);
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
  const worker: WorkerResult = {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text: REPORT, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, provider: "claude",
  };
  const review = reconstructedReview(repo.git("rev-parse", "HEAD"));
  const outcome = await runFixRung({
    taskId: TASK, runId: "needs-design-run", task: { id: TASK, title: "capped proof", files: ["plan/policy.yaml"] },
    prUrl: PR_URL, branch: `run-${TASK}-1`, worktreePath: repo.dir, initialSessionId: "initial", mount,
    settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review, proofDiscrimination: evidence(),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      spawn: async () => worker, waitForCiGreen: async () => "green", runReview: async () => ({ ...review, state: "success" }),
      fetchPrBody: async () => "body", push: () => { throw new Error("a NEEDS_DESIGN round never pushes"); },
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: TASK, ...extra }), say: () => {}, account: (r) => r,
    },
  });
  assert.equal(outcome.outcome, "needs_design");
  const requested = rows.find((r) => r.step === "proof_amendment.requested");
  assert.deepEqual([requested?.outcome, requested?.reason], ["refused", "shard-not-found"], JSON.stringify(rows.map((r) => r.step)));
  assert.ok(rows.findIndex((r) => r.step === "proof_amendment.requested") < rows.findIndex((r) => r.step === "fix.needs_design"));
});
