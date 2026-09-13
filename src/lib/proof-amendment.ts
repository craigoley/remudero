// src/lib/proof-amendment.ts — W1-T3434: THE WRITER FOR A CAPPED IMPLEMENTATION PR'S STALE PROOF.
//
// #5154 was CAPPED because its `unit test:` proofs passed at both the implementation head and its
// merge base — real evidence the proof needed repair — and the proof-discrimination fix worker was
// told to "repair the PR BODY's Acceptance block only." `resolvePlanCriteriaAtHead` (review.ts)
// reads a trailered PR's criteria from the PLAN at the PR's own head commit, never from the body,
// so that instruction targeted an artifact the verdict cannot read. The safe recovery was a
// separate plan-only PR editing the task's `proof:` fields directly (#5231) — this module makes
// that recovery a parent-owned effect instead of a manual one.
//
// STANDING RULE 15 BOUNDARY (mirrors src/lib/body-repair.ts's own docblock): the implementation
// worker that produced the capped PR may PROPOSE a replacement proof; it is never handed GitHub
// body, branch, PR-create, or task-edit authority. Every proposed entry is validated here against
// OBSERVED state — the claim is byte-identical, the old proof is one of the review's own structured
// stale rows, the replacement parses under the reviewer's own grammar, it discriminates head from
// base, and it names evidence in the implementation diff rather than the plan shard that declares
// it. Only once every entry survives does this module write anything, and what it writes is
// SCOPED: replacement `proof:` scalars in the task's own shard, on a plan-only branch, via the
// existing plan-PR emitter. It never edits `claim:`, never opens a second amendment for the same
// identity, and never merges or arms the implementation PR itself — the guarded update-branch call
// after a merged amendment is the only touch it makes on the implementation PR, and only that.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: decide when a capped review is fix-rung-actionable
// (that gate is `proofDiscriminationEvidenceFromCriteria`/`cappedProofDiscriminationFromLedger`,
// sweep.ts, unchanged), flag a proof for human repair (`insertPlanRepairFlag`/
// `dispatchPlanOnlyRepair`, sweep.ts's W1-T3390 rung, a distinct and lower-privilege remedy left
// untouched), or repair a PR blocked by its own body (body-repair.ts, a disjoint failure mode: a
// taskless PR's body IS authoritative and stays on that path).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execWhitelistedProof, parseWhitelistedProof, type WhitelistedProof } from "./review.js";
import type { ProofDiscriminationEvidence } from "./sweep.js";

/** One worker-proposed replacement, parsed from the fix-rung report (see {@link
 *  parseProofAmendmentProposal}) or constructed directly by a test. `claim`/`oldProof` must be
 *  byte-identical to a row in the triggering {@link ProofDiscriminationEvidence} — a worker cannot
 *  propose a correction for a criterion it was not shown, and cannot describe its own change. */
export interface ProofAmendmentProposalEntry {
  readonly claim: string;
  readonly oldProof: string;
  readonly newProof: string;
}

/** The closed grammar a proof-discrimination worker's report uses to propose a replacement — never
 *  free prose, and never a PR-body edit (contrast {@link parseCriterionRefusals}'s `REFUSED:`
 *  block in review.ts, the same "structure over prose" discipline for a worker's bounded output).
 *  A malformed or out-of-order entry simply ends the parse; a worker that writes nothing here
 *  proposes nothing, which reads as `no-proposal` below rather than a parse failure. */
export function parseProofAmendmentProposal(report: string): ProofAmendmentProposalEntry[] {
  const lines = (report ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*PROOF_AMENDMENT:\s*$/.test(line));
  if (start === -1) return [];
  const entries: ProofAmendmentProposalEntry[] = [];
  let i = start + 1;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }
    const claimMatch = /^\s*\d+\.\s*claim:\s*(\S.*)$/.exec(lines[i]);
    if (!claimMatch) break;
    const oldMatch = /^\s*old_proof:\s*(\S.*)$/.exec(lines[i + 1] ?? "");
    const newMatch = /^\s*new_proof:\s*(\S.*)$/.exec(lines[i + 2] ?? "");
    if (!oldMatch || !newMatch) break;
    entries.push({ claim: claimMatch[1].trim(), oldProof: oldMatch[1].trim(), newProof: newMatch[1].trim() });
    i += 3;
  }
  return entries;
}

/** The observed state of the implementation PR this amendment would touch — the fields {@link
 *  proofAmendmentIneligibleReason} reads. Deliberately a plain data shape, not `OpenPrView`: this
 *  module must stay importable from a unit test with no live PR at all. */
export interface ProofAmendmentPrState {
  readonly isOpen: boolean;
  readonly planOnly: boolean;
  readonly taskId?: string;
  readonly reviewState?: string;
  readonly capped?: boolean;
  readonly criteria: ReadonlyArray<{ claim: string; proof: string; met: boolean }>;
}

export type ProofAmendmentIneligibleReason =
  | "not-open"
  | "plan-only-pr"
  | "no-task-trailer"
  | "review-not-success"
  | "not-capped"
  | "unmet-criteria"
  | "no-evidence";

/** The FIVE gates the design's opening sentence names, checked in a fixed order so the reported
 *  reason is always the FIRST one a state fails, never whichever a caller happened to check. */
export function proofAmendmentIneligibleReason(
  pr: ProofAmendmentPrState,
  evidence: ProofDiscriminationEvidence | undefined,
): ProofAmendmentIneligibleReason | undefined {
  if (!pr.isOpen) return "not-open";
  if (pr.planOnly) return "plan-only-pr";
  if (!pr.taskId) return "no-task-trailer";
  if (pr.reviewState !== "success") return "review-not-success";
  if (pr.capped !== true) return "not-capped";
  if (pr.criteria.some((c) => !c.met)) return "unmet-criteria";
  if (!evidence || evidence.proofs.length === 0) return "no-evidence";
  return undefined;
}

export type ProofAmendmentRefusalReason =
  | "no-proposal"
  | "duplicate-claim"
  | "claim-not-recognised"
  | "parse-error"
  | "targets-plan-shard"
  | "head-moved"
  | "head-unreadable"
  | "base-unreadable"
  | "not-discriminating"
  | "shard-not-found"
  | "shard-drifted";

export interface ProofAmendmentRefusal {
  readonly reason: ProofAmendmentRefusalReason;
  readonly detail: string;
}

/** Is `whitelisted`'s target the plan shard the amendment would itself edit (or the plan monolith)?
 *  A replacement proof naming its own criterion's shard would "pass" by construction the moment the
 *  amendment writes it — evidence about the plan text, never about the implementation diff — so
 *  this is checked BEFORE either execution gate below, exactly like R-18/R-12's own before-the-spawn
 *  placement in review.ts's `execWhitelistedProof`. */
function targetsPlanShard(whitelisted: WhitelistedProof, planShardPaths: ReadonlySet<string>): boolean {
  if (whitelisted.kind !== "grep") return false;
  const target = whitelisted.args[whitelisted.args.length - 1];
  return typeof target === "string" && planShardPaths.has(target);
}

export interface ProofAmendmentValidationDeps {
  readonly headCwd: string;
  readonly baseCwd: string | undefined;
  readonly execAtHead?: (whitelisted: WhitelistedProof, cwd: string) => "pass" | "fail" | "no-match";
  readonly execAtBase?: (whitelisted: WhitelistedProof, cwd: string) => "pass" | "fail" | "no-match";
  readonly currentHeadSha: string;
  readonly pinnedHeadSha: string;
  readonly planShardPaths: ReadonlySet<string>;
}

export type ProofAmendmentValidation =
  | { ok: true; validated: ProofAmendmentProposalEntry[] }
  | { ok: false; refusal: ProofAmendmentRefusal };

/** Validate a proof-amendment proposal against OBSERVED state only — see this module's docblock
 *  for the five checks. ALL-OR-NOTHING: one invalid entry refuses the whole proposal rather than
 *  writing a partial amendment, so a duplicate/changed claim can never ride alongside a real
 *  discriminator (the falsifier's "moved implementation head" and "changed a claim" shapes both
 *  land here). */
export function validateProofAmendmentProposal(
  proposal: readonly ProofAmendmentProposalEntry[],
  evidence: ProofDiscriminationEvidence,
  deps: ProofAmendmentValidationDeps,
): ProofAmendmentValidation {
  if (proposal.length === 0) {
    return { ok: false, refusal: { reason: "no-proposal", detail: "the worker's report carried no PROOF_AMENDMENT proposal" } };
  }
  if (deps.currentHeadSha !== deps.pinnedHeadSha) {
    return {
      ok: false,
      refusal: {
        reason: "head-moved",
        detail: `implementation head moved from ${deps.pinnedHeadSha} to ${deps.currentHeadSha} since this evidence was read`,
      },
    };
  }
  const seenClaims = new Set<string>();
  for (const entry of proposal) {
    if (seenClaims.has(entry.claim)) {
      return { ok: false, refusal: { reason: "duplicate-claim", detail: `claim proposed more than once: ${entry.claim}` } };
    }
    seenClaims.add(entry.claim);
  }
  const execAtHead = deps.execAtHead ?? execWhitelistedProof;
  const execAtBase = deps.execAtBase ?? execWhitelistedProof;
  for (const entry of proposal) {
    const evidenceRow = evidence.proofs.find((p) => p.claim === entry.claim);
    if (!evidenceRow || evidenceRow.proof !== entry.oldProof) {
      return {
        ok: false,
        refusal: {
          reason: "claim-not-recognised",
          detail: `no capped stale-proof row byte-matches this claim/old-proof pair: ${entry.claim}`,
        },
      };
    }
    const parsed = parseWhitelistedProof(entry.newProof);
    if (!parsed) {
      return {
        ok: false,
        refusal: { reason: "parse-error", detail: `replacement does not parse under the reviewer's proof grammar: ${entry.newProof}` },
      };
    }
    if (targetsPlanShard(parsed, deps.planShardPaths)) {
      return {
        ok: false,
        refusal: { reason: "targets-plan-shard", detail: `replacement names the plan shard rather than the implementation diff: ${entry.newProof}` },
      };
    }
    let headResult: "pass" | "fail" | "no-match";
    try {
      headResult = execAtHead(parsed, deps.headCwd);
    } catch {
      return {
        ok: false,
        refusal: { reason: "head-unreadable", detail: `replacement could not execute at the implementation head: ${entry.newProof}` },
      };
    }
    if (headResult !== "pass") {
      return {
        ok: false,
        refusal: { reason: "not-discriminating", detail: `replacement does not pass at the implementation head: ${entry.newProof}` },
      };
    }
    if (deps.baseCwd === undefined) {
      return { ok: false, refusal: { reason: "base-unreadable", detail: "no merge-base checkout was available to test discrimination" } };
    }
    let baseResult: "pass" | "fail" | "no-match";
    try {
      baseResult = execAtBase(parsed, deps.baseCwd);
    } catch {
      return {
        ok: false,
        refusal: { reason: "base-unreadable", detail: `replacement could not execute at the merge base: ${entry.newProof}` },
      };
    }
    if (baseResult === "pass") {
      return {
        ok: false,
        refusal: { reason: "not-discriminating", detail: `replacement also passes at the merge base, so it discriminates nothing: ${entry.newProof}` },
      };
    }
  }
  return { ok: true, validated: [...proposal] };
}

/** A durable identity for ONE amendment attempt — task id, implementation PR number, its pinned
 *  head sha, and a digest of the exact (claim, old proof) pairs being replaced. Any of those
 *  changing (a new strike's head, a differently-worded proposal) mints a NEW identity rather than
 *  colliding with a stale one; the SAME identity observed twice must resume, never re-file. */
export interface ProofAmendmentIdentity {
  readonly taskId: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly proposal: readonly ProofAmendmentProposalEntry[];
}

export function proofAmendmentIdempotencyKey(identity: ProofAmendmentIdentity): string {
  const digestInput = identity.proposal.map((e) => `${e.claim} ${e.oldProof}`).sort().join("\n");
  const digest = createHash("sha256").update(digestInput).digest("hex").slice(0, 20);
  return `${identity.taskId}:${identity.prNumber}:${identity.headSha}:${digest}`;
}

/** Stable per-implementation-PR branch name — deterministic so a re-run that pushed but crashed
 *  before recording finds its own prior push via {@link ProofAmendmentWriteDeps.probeExisting}
 *  rather than opening a second PR (mirrors `dispatchPlanOnlyRepair`'s `plan-repair/${taskId}`). */
export function proofAmendmentBranchName(taskId: string, prNumber: number): string {
  return `proof-amendment/${taskId}-${prNumber}`;
}

/** Replace ONE criterion's `proof:` scalar in raw shard text, touching nothing else — the same
 *  line-scoped discipline as `insertPlanRepairFlag` (sweep.ts), so `criterionFieldTampered`'s
 *  ADD/DEL-of-a-field-line count sees exactly one field change per entry and nothing beside it.
 *  Returns `undefined` when `oldProof`'s exact text is no longer on a line under `claim`'s nearest
 *  preceding `claim:` line — the shard drifted since the evidence was read, and rewriting the wrong
 *  line would misattribute the repair. */
export function replaceProofScalar(shardText: string, claim: string, oldProof: string, newProof: string): string | undefined {
  const lines = shardText.split("\n");
  const proofIdx = lines.findIndex((line) => /proof\s*:/.test(line) && line.includes(oldProof));
  if (proofIdx < 0) return undefined;
  let claimMatches = false;
  for (let i = proofIdx - 1; i >= 0; i--) {
    if (/claim\s*:/.test(lines[i])) {
      claimMatches = lines[i].includes(claim);
      break;
    }
  }
  if (!claimMatches) return undefined;
  const replacedLine = lines[proofIdx].replace(oldProof, newProof);
  if (replacedLine === lines[proofIdx]) return undefined;
  lines[proofIdx] = replacedLine;
  return lines.join("\n");
}

/** Locate a task's plan shard by the same convention `dispatchPlanOnlyRepair` (sweep.ts) already
 *  uses: a `plan/tasks.d/<taskId>-*.yaml` file, falling back to the monolith `plan/tasks.yaml` when
 *  it declares the task inline. `undefined` when neither carries the task at all. */
export function findTaskShard(repoDir: string, taskId: string): { path: string; text: string } | undefined {
  let shardRelPath: string | undefined;
  try {
    shardRelPath = readdirSync(join(repoDir, "plan", "tasks.d"))
      .filter((f) => f.startsWith(`${taskId}-`) && /\.ya?ml$/.test(f))
      .map((f) => join("plan", "tasks.d", f))[0];
  } catch {
    /* no tasks.d directory readable — fall through to the monolith below */
  }
  if (!shardRelPath) {
    const monolith = join(repoDir, "plan", "tasks.yaml");
    if (existsSync(monolith) && readFileSync(monolith, "utf8").includes(`id: ${taskId}\n`)) {
      shardRelPath = "plan/tasks.yaml";
    }
  }
  if (!shardRelPath) return undefined;
  return { path: shardRelPath, text: readFileSync(join(repoDir, shardRelPath), "utf8") };
}

/** A recorded amendment identity's disposition, read from whatever durable store the caller uses
 *  (production: the ledger, keyed on {@link proofAmendmentIdempotencyKey}). `merged` distinguishes
 *  "resume the still-open PR" from "the amendment landed — request the guarded branch update now." */
export interface ProofAmendmentRecord {
  readonly amendmentUrl: string;
  readonly amendmentNumber: number;
  readonly merged: boolean;
}

export interface ProofAmendmentWriteDeps {
  readonly repoDir: string;
  readonly findShard: (repoDir: string, taskId: string) => { path: string; text: string } | undefined;
  readonly worktreeAdd: (repoDir: string, worktreePath: string, branch: string) => void;
  readonly worktreeRemove: (repoDir: string, worktreePath: string) => void;
  readonly writeFile: (absPath: string, text: string) => void;
  readonly gitAdd: (worktreePath: string, relPath: string) => void;
  /** Commits the staged change and returns the new commit's sha (the push's `expectedHeadSha`). */
  readonly gitCommit: (worktreePath: string, message: string) => string;
  readonly gitPush: (worktreePath: string, branch: string, expectedHeadSha: string) => void;
  readonly probeExisting: (branch: string) => { prUrl: string; prNumber: number } | undefined;
  readonly createPr: (opts: { title: string; body: string; head: string; base: string }) => { prUrl: string; prNumber: number };
  readonly worktreePathFor: (taskId: string, prNumber: number) => string;
  readonly lookupIdentity: (key: string) => ProofAmendmentRecord | undefined;
  readonly recordIdentity: (key: string, record: ProofAmendmentRecord) => void;
  /** The existing expected-head guarded update-branch operation (run-task.ts's `ghUpdateBranch`,
   *  never re-implemented here) — the ONLY touch this module makes on the implementation PR itself. */
  readonly updateBranch: (prUrl: string, expectedHeadSha: string) => { ok: boolean; error?: string };
}

export interface ProofAmendmentRequest {
  readonly taskId: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly pr: ProofAmendmentPrState;
  readonly evidence: ProofDiscriminationEvidence | undefined;
  readonly proposal: readonly ProofAmendmentProposalEntry[];
  readonly headSha: string;
  readonly currentHeadSha: string;
  readonly headCwd: string;
  readonly baseCwd: string | undefined;
  readonly execAtHead?: (whitelisted: WhitelistedProof, cwd: string) => "pass" | "fail" | "no-match";
  readonly execAtBase?: (whitelisted: WhitelistedProof, cwd: string) => "pass" | "fail" | "no-match";
}

export type ProofAmendmentOutcome =
  | { kind: "ineligible"; reason: ProofAmendmentIneligibleReason }
  | { kind: "refused"; reason: ProofAmendmentRefusalReason; detail: string }
  | { kind: "resumed"; amendmentUrl: string; amendmentNumber: number }
  | { kind: "created"; amendmentUrl: string; amendmentNumber: number }
  | { kind: "branch_update_requested"; ok: boolean; error?: string };

function buildAmendmentCommitMessage(taskId: string, prNumber: number, entries: readonly ProofAmendmentProposalEntry[]): string {
  const subject = `repair ${entries.length} stale proof(s) discriminated by #${prNumber}`;
  const extraBody =
    `${taskId}'s shard declared a proof that reads MET without discriminating #${prNumber}'s implementation ` +
    `head from its merge base. A validated replacement, executed at both revisions by the parent (never the ` +
    `implementation worker), now passes at the head and fails at the base. This changes proof scalars only.`;
  return `fix(plan): ${subject}\n\n${extraBody}`;
}

function buildAmendmentTitle(taskId: string, prNumber: number): string {
  return `fix(plan): repair ${taskId}'s stale proof(s) discriminated by #${prNumber}`;
}

function buildAmendmentBody(
  taskId: string,
  prNumber: number,
  shardPath: string,
  entries: readonly ProofAmendmentProposalEntry[],
): string {
  const intro =
    `AUTOMATED PROOF AMENDMENT (W1-T3434): #${prNumber} (\`Remudero-Task: ${taskId}\`) read CAPPED — every ` +
    `criterion was met, but ${entries.length} proof(s) below passed identically at the implementation head ` +
    `and its merge base, so they discriminated nothing. Each replacement was executed by this parent process ` +
    `(never the implementation worker) at both revisions and passes only at the head. This PR changes ` +
    `${shardPath}'s \`proof:\` scalars only; it never touches \`claim:\`, the PR body of #${prNumber}, or its ` +
    `implementation branch.`;
  const criteria = entries.map((e) => ({ claim: `${taskId}'s "${e.claim}" proof now discriminates #${prNumber}`, proof: e.newProof }));
  return [
    intro,
    "",
    "Acceptance:",
    ...criteria.map((c) => `- ${c.claim} | ${c.proof}`),
  ].join("\n");
}

/** THE PARENT-OWNED EFFECT. Given an implementation PR's observed state, this round's proof-
 *  discrimination evidence, and a worker's proposal, either refuses with no write, resumes/probes
 *  a prior identical filing, opens exactly one plan-only amendment PR, or — once that amendment has
 *  merged — requests a same-head guarded branch update so the ordinary CI/review/arm path picks up
 *  the corrected criteria on its own. Never merges or arms anything itself. */
export function requestProofAmendment(request: ProofAmendmentRequest, deps: ProofAmendmentWriteDeps): ProofAmendmentOutcome {
  const ineligible = proofAmendmentIneligibleReason(request.pr, request.evidence);
  if (ineligible) return { kind: "ineligible", reason: ineligible };
  const evidence = request.evidence!;

  const shard = deps.findShard(deps.repoDir, request.taskId);
  if (!shard) return { kind: "refused", reason: "shard-not-found", detail: `no plan shard found for ${request.taskId}` };

  const planShardPaths = new Set<string>([shard.path, "plan/tasks.yaml"]);
  const validation = validateProofAmendmentProposal(request.proposal, evidence, {
    headCwd: request.headCwd,
    baseCwd: request.baseCwd,
    execAtHead: request.execAtHead,
    execAtBase: request.execAtBase,
    currentHeadSha: request.currentHeadSha,
    pinnedHeadSha: request.headSha,
    planShardPaths,
  });
  if (!validation.ok) return { kind: "refused", reason: validation.refusal.reason, detail: validation.refusal.detail };

  const key = proofAmendmentIdempotencyKey({
    taskId: request.taskId,
    prNumber: request.prNumber,
    headSha: request.headSha,
    proposal: validation.validated,
  });
  const existing = deps.lookupIdentity(key);
  if (existing) {
    if (existing.merged) {
      const result = deps.updateBranch(request.prUrl, request.currentHeadSha);
      return { kind: "branch_update_requested", ok: result.ok, error: result.error };
    }
    return { kind: "resumed", amendmentUrl: existing.amendmentUrl, amendmentNumber: existing.amendmentNumber };
  }

  const branch = proofAmendmentBranchName(request.taskId, request.prNumber);
  const probed = deps.probeExisting(branch);
  if (probed) {
    deps.recordIdentity(key, { amendmentUrl: probed.prUrl, amendmentNumber: probed.prNumber, merged: false });
    return { kind: "resumed", amendmentUrl: probed.prUrl, amendmentNumber: probed.prNumber };
  }

  let text = shard.text;
  for (const entry of validation.validated) {
    const replaced = replaceProofScalar(text, entry.claim, entry.oldProof, entry.newProof);
    if (replaced === undefined) {
      return { kind: "refused", reason: "shard-drifted", detail: `shard text no longer carries the exact old proof for: ${entry.claim}` };
    }
    text = replaced;
  }

  const worktreePath = deps.worktreePathFor(request.taskId, request.prNumber);
  deps.worktreeAdd(deps.repoDir, worktreePath, branch);
  try {
    deps.writeFile(join(worktreePath, shard.path), text);
    deps.gitAdd(worktreePath, shard.path);
    const commitSha = deps.gitCommit(worktreePath, buildAmendmentCommitMessage(request.taskId, request.prNumber, validation.validated));
    deps.gitPush(worktreePath, branch, commitSha);
    const created = deps.createPr({
      title: buildAmendmentTitle(request.taskId, request.prNumber),
      body: buildAmendmentBody(request.taskId, request.prNumber, shard.path, validation.validated),
      head: branch,
      base: "main",
    });
    deps.recordIdentity(key, { amendmentUrl: created.prUrl, amendmentNumber: created.prNumber, merged: false });
    return { kind: "created", amendmentUrl: created.prUrl, amendmentNumber: created.prNumber };
  } finally {
    deps.worktreeRemove(deps.repoDir, worktreePath);
  }
}
