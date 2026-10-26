import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import { replaceBodyProofs } from "#src/lib/body-repair.js";
import { renderFixPrompt } from "#src/lib/prompt-render.js";
import {
  DEFAULT_SWEEP_POLICY, PLAN_REPAIR_DISPATCH_STEP, fixSeedRead, prBodyDigest, runSweep,
  type FixDispatchEvidence, type FixRungInputs, type OpenPrView, type ProofDiscriminationEvidence, type SweepDeps,
} from "#src/lib/sweep.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { dispatchBodyProofRepair, runFixRung } from "#test/helpers/run-task-test.js";

// PR #13282 carried no task trailer, so its BODY was its Acceptance. The sweep routed its capped proof to a fix round whose
// prompt forbade editing the body and offered only a plan amendment no shard could take; the worker answered NEEDS_DESIGN, and
// W1-T1110's re-arm then read every later same-head stand-down as an ended rung: 112 stand-downs at one head in 7 hours. These
// tests pin the body repair, the plan-repair exclusion, and the hold that releases only when an input the stand-down read moved.

const CLAIM = "escalation triage is set to act";
const OLD_PROOF = "grep: OPERATOR 2026-10-21: act in plan/policy.yaml";
const NEW_PROOF = "grep: ^  mode: act$ in plan/policy.yaml";
const COMMENT_ONLY_PROOF = "grep: OPERATOR 2026-10-21: act. Shadow in plan/policy.yaml";
const PR_NUMBER = 13282;
const PR_URL = `https://github.com/acme/remudero/pull/${PR_NUMBER}`;
const TASKLESS = `PR-${PR_NUMBER}`;
const BODY = `Triage act mode.\n\nAcceptance:\n- ${CLAIM} | ${OLD_PROOF}\n`;
const EDITED_BODY = `${BODY}\nOperator note: rewritten at the same head.\n`;
const REASON = "stale plan proof requires a parent-owned amendment; this worker cannot edit the task criteria";
const report = (proof: string) => [
  "No files were edited.", "", "PROOF_AMENDMENT:", `1. claim: ${CLAIM}`, `   old_proof: ${OLD_PROOF}`, `   new_proof: ${proof}`,
  "", `FIX_OUTCOME: NEEDS_DESIGN ${REASON}`,
].join("\n");

function evidence(bodyRepair: boolean): ProofDiscriminationEvidence {
  return { proofs: [{ claim: CLAIM, proof: OLD_PROOF, proofExec: "executed_stale" }], ...(bodyRepair ? { bodyRepair: true as const } : {}) };
}

function reconstructedReview(headSha: string) {
  return { state: "failure" as const, capped: true, reviewerOutcome: "sweep-reconstructed", testTheater: false,
    summary: "sweep-reconstructed capped review (1 proof(s) need discrimination)", floorDegraded: false, keywordOnly: false,
    planOnly: false, headSha,
    criteria: [{ claim: CLAIM, proof: OLD_PROOF, met: true, reason: "capped proof requires base discrimination", proof_exec: "executed_stale" as const }] };
}

/** A real repository whose merge base is `mode: shadow` and whose head flips it to `act` beside an operator comment. */
function policyFixture() {
  const repo = gitRepo({ kind: "taskless-body-proof-repair" });
  mkdirSync(join(repo.dir, "plan"), { recursive: true });
  const header = "# literals scattered across src/lib/*.ts\n";
  writeFileSync(join(repo.dir, "plan/policy.yaml"), `${header}escalationTriage:\n  mode: shadow\n`);
  repo.git("add", "-A");
  repo.git("commit", "-qm", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo.dir, "plan/policy.yaml"), `${header}# OPERATOR 2026-10-21: act. Shadow 10-14..10-21\nescalationTriage:\n  mode: act\n`);
  repo.git("commit", "-qam", "act");
  return repo;
}

type Row = { step: string } & Record<string, unknown>;

function repair(repo: ReturnType<typeof policyFixture>, transcriptText: string, liveBody = BODY) {
  const rows: Row[] = [];
  const writes: string[] = [];
  const result = dispatchBodyProofRepair({
    prUrl: PR_URL, reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir }, evidence: evidence(true),
    transcriptText, priorHeadSha: repo.git("rev-parse", "HEAD"), log: (step, extra) => rows.push({ step, ...extra }),
    fetchPrBody: async () => liveBody, updatePrBody: async (_url, body) => { writes.push(body); },
  });
  return { rows, writes, result };
}

const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
const worker = (text: string): WorkerResult => ({
  sessionId: "fix-session", costUsd: 1, numTurns: 2, text, blocks: [], stderr: "",
  subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
  model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
  modelUsage: {}, compactionEvents: [], qualitySuspect: false, provider: "claude",
});

/** One fix-rung round on a taskless PR against `ledger`, recording the prompt, the writes and every ledger row. */
async function round(repo: ReturnType<typeof policyFixture>, opts: { ledger?: Row[]; bodySha?: string; report?: string }) {
  const rows: Row[] = [...(opts.ledger ?? [])];
  const prompts: string[] = [];
  const writes: string[] = [];
  const headSha = repo.git("rev-parse", "HEAD");
  const review = reconstructedReview(headSha);
  const outcome = await runFixRung({
    taskId: TASKLESS, runId: "taskless-run", task: { id: TASKLESS, title: "capped proof", files: ["plan/policy.yaml"] },
    prUrl: PR_URL, branch: "run-unfiled-1", worktreePath: repo.dir, initialSessionId: "initial", mount,
    settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review, proofDiscrimination: evidence(true),
    ...(opts.bodySha === undefined ? {} : { prBodySha256: opts.bodySha }),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      spawn: async (args) => { prompts.push(args.prompt); return worker(opts.report ?? report(NEW_PROOF)); },
      waitForCiGreen: async () => "green", runReview: async () => ({ ...review, state: "success" }),
      fetchPrBody: async () => BODY, updatePrBody: async (_url, body) => { writes.push(body); },
      push: () => { throw new Error("a NEEDS_DESIGN round never pushes"); },
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: TASKLESS, ...extra }), say: () => {}, account: (r) => r,
    },
  });
  return { outcome, rows, prompts, writes, headSha };
}

test("W1-T10339: a taskless capped proof is repaired in the PR body", async () => {
  const repo = policyFixture();
  const { outcome, rows, prompts, writes } = await round(repo, { bodySha: prBodyDigest(BODY) });
  assert.equal(outcome.outcome, "needs_design");
  // The prompt names the body, not a plan shard, as what review judges and asks for the same PROOF_AMENDMENT block.
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /THIS PR HAS NO TASK, SO ITS OWN BODY'S Acceptance BLOCK IS WHAT REVIEW JUDGES/);
  assert.doesNotMatch(prompts[0]!, /THE PLAN, NOT THIS PR'S BODY, IS WHAT A TRAILERED PR IS JUDGED AGAINST/);
  assert.match(prompts[0]!, /PROOF_AMENDMENT:/);
  // The validated replacement lands in the live body, replacing the proof and nothing else; no plan amendment is requested.
  assert.deepEqual(writes, [BODY.replace(OLD_PROOF, NEW_PROOF)]);
  const repaired = rows.find((r) => r.step === "fix.body_proof_repaired");
  assert.deepEqual([repaired?.old_body_sha256, repaired?.new_body_sha256], [prBodyDigest(BODY), prBodyDigest(writes[0])]);
  assert.equal(rows.some((r) => r.step === "proof_amendment.requested"), false, JSON.stringify(rows.map((r) => r.step)));
  // The same round's design handoff records what it read: head, contract and the body digest.
  const design = rows.find((r) => r.step === "fix.needs_design");
  assert.deepEqual([design?.read_head_sha, design?.read_body_sha256], [repo.git("rev-parse", "HEAD"), prBodyDigest(BODY)]);
  // The trailered prompt is unchanged: it still forbids the body edit.
  const trailered = renderFixPrompt({ task: { id: "W1-T1", title: "capped", files: ["plan/policy.yaml"] }, round: 1,
    branch: "run-W1-T1-1", evidence: { proofDiscrimination: evidence(false) } });
  assert.match(trailered, /THE PLAN, NOT THIS PR'S BODY, IS WHAT A TRAILERED PR IS JUDGED AGAINST/);
});

test("W1-T10339: a comment-only body proof replacement is refused by the shared validator", async () => {
  const repo = policyFixture();
  const refused = repair(repo, report(COMMENT_ONLY_PROOF));
  const result = await refused.result;
  assert.equal(result.kind, "refused");
  const row = refused.rows.find((r) => r.step === "fix.body_proof_repair_refused");
  assert.equal(row?.reason, "not-discriminating");
  assert.match(String(row?.detail), /only comment lines/);
  assert.deepEqual(refused.writes, [], "the body is not written");
  // An empty proposal, a body that drifted, and a replacement that does not parse each refuse with their own reason and write nothing.
  const empty = repair(repo, "No files were edited.");
  assert.equal((await empty.result).kind, "refused");
  assert.equal(empty.rows.find((r) => r.step === "fix.body_proof_repair_refused")?.reason, "no-proposal");
  const drifted = repair(repo, report(NEW_PROOF), "Acceptance:\n- something else entirely | grep: x in y\n");
  assert.equal((await drifted.result).kind, "refused");
  assert.equal(drifted.rows.find((r) => r.step === "fix.body_proof_repair_refused")?.reason, "body-drifted");
  const unparsed = repair(repo, report("grep: no path clause here"));
  assert.equal((await unparsed.result).kind, "refused");
  assert.equal(unparsed.rows.find((r) => r.step === "fix.body_proof_repair_refused")?.reason, "parse-error");
  for (const attempt of [empty, drifted, unparsed]) assert.deepEqual(attempt.writes, []);
  // The writer never reads a claim and refuses an ambiguous proof rather than guessing which line it meant.
  assert.equal(replaceBodyProofs(`- a | ${OLD_PROOF}\n- b | ${OLD_PROOF}\n`, [{ oldProof: OLD_PROOF, newProof: NEW_PROOF }]), undefined);
  assert.equal(replaceBodyProofs(BODY, [{ oldProof: OLD_PROOF, newProof: NEW_PROOF }]), BODY.replace(OLD_PROOF, NEW_PROOF));
  // A throw from the live write is a refusal that names it, never an exception out of the round.
  const thrown = await dispatchBodyProofRepair({
    prUrl: PR_URL, reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir }, evidence: evidence(true),
    transcriptText: report(NEW_PROOF), priorHeadSha: repo.git("rev-parse", "HEAD"), log: () => {},
    fetchPrBody: async () => BODY, updatePrBody: async () => { throw new Error("gh edit failed"); },
  });
  assert.deepEqual(thrown, { kind: "refused", reason: "error (gh edit failed)" });
});

function cappedFixture(body: string | undefined, taskId: string | undefined, priorStrikes: number) {
  const headSha = "c".repeat(40);
  const rows: Row[] = [{
    task_id: taskId ?? TASKLESS, step: "review.posted", pr_url: PR_URL, head_sha: headSha, state: "success", capped: true, plan_only: false,
    decision_verdict: { state: "success", capped: true, planOnly: false, criteria: [{
      claim: CLAIM, proof: OLD_PROOF, met: true, reason: "every executor-returned matching line is a comment", proof_exec: "executed_stale" }] },
  }];
  const pr: OpenPrView = {
    prNumber: PR_NUMBER, prUrl: PR_URL, ...(taskId === undefined ? {} : { taskId }), headSha, headRefName: "run-unfiled-123",
    checksState: "green", reviewState: "success", unmetCriteria: [], priorStrikes, autoMergeArmed: false,
    lastActivityAt: new Date(Date.parse("2026-10-21T12:00:00Z")).toISOString(), ciFailures: [], ...(body === undefined ? {} : { body }),
  };
  const seen = { body: 0, plan: 0, evidence: [] as FixDispatchEvidence[] };
  const deps: SweepDeps = {
    ledgerPath: "/unused/capped-ledger", runId: "capped-run", now: () => Date.parse("2026-10-21T12:00:00Z"),
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row as Row); },
    dispatchFix: (_pr, ev) => { seen.body++; seen.evidence.push(ev); },
    dispatchPlanOnlyRepair: () => { seen.plan++; return true; },
    arm: () => "armed", escalate: () => {}, close: () => {},
  };
  return { pr, rows, deps, seen };
}

test("W1-T10339: a taskless capped PR is never routed to plan repair", async () => {
  // Body strikes spent: a trailered PR's next rung is the plan shard; a taskless PR has none, so it is exhausted instead.
  for (const taskId of ["unfiled"]) {
    const spent = cappedFixture("Acceptance:\n- " + `${CLAIM} | ${OLD_PROOF}\n`, taskId, DEFAULT_SWEEP_POLICY.strikeCap);
    await runSweep([spent.pr], spent.deps);
    const disposed = spent.rows.findLast((r) => r.step === "sweep.disposed")!;
    assert.notEqual(disposed.blocker_owner, "plan-repair", String(disposed.reason));
    assert.notEqual(disposed.disposition, "blocked-fixable");
    assert.equal(spent.seen.plan, 0);
    assert.doesNotMatch(String(disposed.reason), /plan-only repair of the offending shard/);

    // Body strikes remain: the fix lane owns it, and the round carries the body-repair marker.
    const open = cappedFixture("Acceptance:\n- " + `${CLAIM} | ${OLD_PROOF}\n`, taskId, 0);
    await runSweep([open.pr], open.deps);
    const routed = open.rows.findLast((r) => r.step === "sweep.disposed")!;
    assert.equal(routed.disposition, "blocked-fixable");
    assert.deepEqual([routed.blocker, routed.blocker_owner], ["own-red", "fix-lane"]);
    assert.equal(open.seen.plan, 0);
    assert.equal(open.seen.body, 1);
    assert.equal(open.seen.evidence[0]?.proofDiscrimination?.bodyRepair, true);
  }
  // Regression guard: a trailered PR keeps the plan-amendment route, with its plan-repair owner and no body marker.
  const trailered = cappedFixture(`Acceptance:\n- ${CLAIM} | ${OLD_PROOF}\n\nRemudero-Task: W1-T10339\n`, "W1-T10339", DEFAULT_SWEEP_POLICY.strikeCap);
  trailered.rows.push({ task_id: "W1-T10339", step: PLAN_REPAIR_DISPATCH_STEP, pr_number: PR_NUMBER, outcome: "dispatched" });
  trailered.rows[0]!.task_id = "W1-T10339";
  await runSweep([trailered.pr], trailered.deps);
  const kept = trailered.rows.findLast((r) => r.step === "sweep.disposed")!;
  assert.equal(kept.blocker_owner, "plan-repair", String(kept.reason));
  assert.equal(trailered.seen.evidence.some((ev) => ev.proofDiscrimination?.bodyRepair === true), false);
});

// ── the stand-down hold ─────────────────────────────────────────────────────────────────────────────────────────────────
const HEAD = "a".repeat(40);
const RUN = "taskless-hold-run";
const NOW = Date.parse("2026-10-21T04:30:00Z");
const seedRow: Row = { step: "sweep.disposed", pr_number: PR_NUMBER, head_sha: HEAD, task_id: "SWEEP", run_id: RUN,
  disposition: "blocked-fixable", acted: true, ts: "2026-10-21T03:49:00.000Z" };
const dispatchRow: Row = { step: "fix.dispatch", task_id: TASKLESS, head_sha: HEAD, run_id: RUN, mode: "proof-discrimination", ts: "2026-10-21T03:49:01.000Z" };
const standDown = (over: Record<string, unknown> = {}): Row => ({ step: "fix.stood_down", task_id: TASKLESS, head_sha: HEAD, run_id: RUN,
  site: "rung.needs_design", reason: REASON, read_head_sha: HEAD, read_body_sha256: prBodyDigest(BODY), ts: "2026-10-21T04:22:00.000Z", ...over });
const view = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: PR_NUMBER, prUrl: PR_URL, headSha: HEAD, checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 1, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(), body: BODY,
  ciFailures: [{ name: "test-shard (1/8)", logTail: "not ok 1 - the policy fixture" }], ...over,
});

function holdFixture(rows: Row[]) {
  const state = { escalated: 0, dispatched: 0, admissions: 0, reasons: [] as string[] };
  const deps: SweepDeps = {
    ledgerPath: "/unused/stand-down-hold-ledger", runId: RUN, now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row as Row); },
    fixProgressJudge: async () => ({ verdict: "continue", reason: "the red names one failing proof" }),
    arm: () => {}, close: () => {},
    escalate: (_pr, reason) => { state.escalated++; state.reasons.push(String(reason)); },
    dispatchFix: () => { state.dispatched++; },
    claimFixAdmission: () => { state.admissions++; return { admitted: true }; },
  };
  return { deps, state };
}

test("W1-T10339: a stood-down repair is not re-dispatched on unchanged inputs", async () => {
  const rows: Row[] = [seedRow, dispatchRow, standDown()];
  const f = holdFixture(rows);
  await runSweep([view()], f.deps);
  assert.equal(f.state.dispatched, 0, "no worker is dispatched at an unchanged head, contract and body");
  assert.equal(f.state.admissions, 0, "no capacity is spent");
  assert.equal(f.state.escalated, 1, "the hold is escalated once, with the stand-down's own reason");
  assert.match(f.state.reasons[0]!, /stale plan proof requires a parent-owned amendment/);
  const first = rows.findLast((r) => r.step === "sweep.disposed")!;
  assert.deepEqual([first.disposition, first.stand_down_hold, first.stand_down_site], ["refused-escalate", true, "rung.needs_design"]);
  for (let pass = 0; pass < 5; pass++) await runSweep([view()], f.deps);
  assert.equal(f.state.dispatched, 0);
  assert.equal(f.state.escalated, 1, "a later pass does not escalate again");
  const later = rows.findLast((r) => r.step === "sweep.disposed")!;
  assert.equal(later.acted, false);
  assert.match(String(later.stand_down_reason), /stand-down hold: .*nothing it read has changed/);
  assert.match(String(later.stand_down_reason), /no worker dispatched and no capacity spent/);
  // A proof_amendment.requested refusal written by the same round is neither a changed input nor a release.
  rows.push({ step: "proof_amendment.requested", task_id: TASKLESS, outcome: "refused", reason: "shard-not-found" });
  await runSweep([view()], f.deps);
  assert.equal(f.state.dispatched, 0);
  // Not only the design handoff: every stand-down site holds at unchanged inputs (the strike site is the named exception).
  for (const site of ["rung.empty_review_evidence", "rung.exhaustion", "rung.review_decision", "rung.pre_dispatch_review", "rung.body_proof_repair"]) {
    const siteRows: Row[] = [seedRow, dispatchRow, standDown({ site })];
    const g = holdFixture(siteRows);
    for (let pass = 0; pass < 3; pass++) await runSweep([view()], g.deps);
    assert.deepEqual([g.state.dispatched, g.state.admissions, g.state.escalated], [0, 0, 1], `${site}: held, escalated once`);
    assert.equal(siteRows.find((r) => r.step === "sweep.disposed")?.stand_down_site, site);
  }
});

test("W1-T10339: a body edit releases a taskless stand-down at the same head", async () => {
  // The sweep: the same head, an edited body.
  const rows: Row[] = [seedRow, dispatchRow, standDown()];
  const f = holdFixture(rows);
  await runSweep([view({ body: EDITED_BODY })], f.deps);
  assert.equal(f.state.dispatched, 1, "the edited body is a new input, so the PR is routed normally");
  assert.equal(f.state.escalated, 0);
  // The fix rung's own reuse: a handoff read on the old body is not reused on the edited one.
  const repo = policyFixture();
  const headSha = repo.git("rev-parse", "HEAD");
  const handoff: Row = { step: "fix.needs_design", task_id: TASKLESS, head_sha: headSha, reason: REASON, read_body_sha256: prBodyDigest(BODY) };
  const unchanged = await round(repo, { ledger: [handoff], bodySha: prBodyDigest(BODY) });
  assert.equal(unchanged.prompts.length, 0, "an unchanged body stands down at rung.needs_design with no worker");
  const standDownRow = unchanged.rows.find((r) => r.step === "fix.stood_down" && r.site === "rung.needs_design");
  assert.deepEqual([standDownRow?.read_head_sha, standDownRow?.read_body_sha256], [headSha, prBodyDigest(BODY)]);
  const edited = await round(repo, { ledger: [handoff], bodySha: prBodyDigest(EDITED_BODY) });
  assert.equal(edited.prompts.length, 1, "an edited body gets a real round");
  assert.equal(edited.rows.some((r) => r.step === "fix.stood_down" && r.site === "rung.needs_design"), false);
  // A handoff row from before these fields existed keeps the head-only reuse.
  const legacy = await round(repo, { ledger: [{ ...handoff, read_body_sha256: undefined }], bodySha: prBodyDigest(EDITED_BODY) });
  assert.equal(legacy.prompts.length, 0);
});

test("W1-T10339: a hold is released by a new head and a changed contract, and legacy or live rows keep their reading", () => {
  const current: FixRungInputs = { headSha: HEAD, bodySha256: prBodyDigest(BODY) };
  const pr = { prNumber: PR_NUMBER, headSha: HEAD };
  const read = (rows: Row[], now = current) => fixSeedRead([seedRow, dispatchRow, ...rows], pr, RUN, now);
  assert.equal(read([standDown()])?.kind, "held");
  assert.equal(read([standDown()], { ...current, headSha: "b".repeat(40) })?.kind, "ended", "a new head releases every hold");
  assert.equal(read([standDown()], { ...current, bodySha256: prBodyDigest(EDITED_BODY) })?.kind, "ended");
  assert.equal(read([standDown({ read_contract_revision: "contract-A" })], { ...current, contractRevision: "contract-A" })?.kind, "held");
  assert.equal(read([standDown({ read_contract_revision: "contract-A" })], { ...current, contractRevision: "contract-B" })?.kind, "ended");
  assert.equal(read([standDown({ read_head_sha: undefined, read_body_sha256: undefined })])?.kind, "ended", "a row without the fields keeps today's re-dispatch");
  assert.equal(read([standDown({ site: "rung.strike" })])?.kind, "ended", "an issue-released strike stand-down is out of scope");
  assert.equal(read([standDown({ site: "rung.empty_review_evidence" })])?.kind, "held", "every stand-down site holds, not only the design handoff");
  assert.equal(read([standDown({ site: "rung.empty_review_evidence" })], { ...current, headSha: "b".repeat(40) })?.kind, "ended");
  assert.equal(read([standDown({ site: "rung.body_proof_repair" })])?.kind, "held", "a refused body proposal holds");
  assert.equal(read([standDown({ outcome: "handed_off", site: "rung.ci_handoff" })])?.kind, "live", "a handed_off stand-down is still a live wait");
  assert.equal(read([])?.kind, "live", "a live in-flight rung stays deduped");
  assert.equal(read([standDown(), { ...dispatchRow, ts: "2026-10-21T05:00:00.000Z" }])?.kind, "live", "a later dispatch is a live rung");
  assert.equal(fixSeedRead([seedRow, dispatchRow, standDown()], pr, RUN)?.kind, "ended", "no current inputs: today's reading");
  assert.equal(read([standDown(), { step: "proof_amendment.requested", task_id: TASKLESS, outcome: "refused", reason: "shard-not-found" }])?.kind, "held");
});
