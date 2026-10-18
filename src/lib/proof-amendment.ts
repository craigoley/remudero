// src/lib/proof-amendment.ts — W1-T3434: THE WRITER FOR A CAPPED IMPLEMENTATION PR'S STALE PROOF.
// #5154's proof-discrimination fix worker was told to "repair the PR BODY's Acceptance block
// only," but `resolvePlanCriteriaAtHead` (review.ts) reads a trailered PR's criteria from the PLAN
// at its own head commit, never the body, so that instruction targeted an unread artifact.
//
// STANDING RULE 15 BOUNDARY (mirrors src/lib/body-repair.ts's own docblock): the implementation
// worker may PROPOSE a replacement proof; it is never handed GitHub body, branch, PR-create, or
// task-edit authority. Every entry is validated against OBSERVED state — byte-identical claim, the
// old proof is one of the review's own structured stale rows, the replacement parses under the
// reviewer's grammar, discriminates head from base, and names evidence in the implementation diff
// rather than the plan shard declaring it. Only then does this write anything, and only replacement
// `proof:` scalars on a plan-only branch — never `claim:`, never a second amendment for the same
// identity, and the only touch on the implementation PR itself is the guarded update-branch call
// after a merged amendment.
//
// OUT OF SCOPE: deciding when a capped review is fix-rung-actionable (sweep.ts, unchanged), the
// lower-privilege human-flagging rung (`insertPlanRepairFlag`/`dispatchPlanOnlyRepair`, W1-T3390,
// left untouched), and a taskless PR whose body IS authoritative (body-repair.ts, a disjoint path).

import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { RmdError } from "./errors.js";
import { execFileLoopBounded } from "./loop-bounded-child.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { execWhitelistedProof, INSTRUMENT_SURFACE, parseWhitelistedProof, type WhitelistedProof } from "./review.js";
import type { ProofDiscriminationEvidence } from "./sweep.js";
import { renderAcceptanceBlock } from "./plan-pr-emitter.js";
import { parseTasksFromYaml, type Task } from "./plan.js";
import { lintTask, type LintViolation } from "./task-linter.js";
import { taskIdFromRunBranch } from "./status.js";
import { isTaskShardName } from "./task-shard-name.js";

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
  // W1-T5544 — THE GATE-LOG EVIDENCE SOURCE. A PR red on `proof-discrimination` never has a posted
  // success review (review runs only once checks are green), so the three review gates below can
  // never hold for it. The gate's OWN log, read at this head, names the exact stale proofs instead —
  // the fact those gates were standing in for. `validateProofAmendmentProposal` (byte-identical
  // claim, reviewer grammar, head-vs-base discrimination) still runs unchanged after this returns.
  if (evidence?.source === "gate-log") return evidence.proofs.length === 0 ? "no-evidence" : undefined;
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

export interface ProofAmendmentValidationInput {
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
  input: ProofAmendmentValidationInput,
): ProofAmendmentValidation {
  if (proposal.length === 0) {
    return { ok: false, refusal: { reason: "no-proposal", detail: "the worker's report carried no PROOF_AMENDMENT proposal" } };
  }
  if (input.currentHeadSha !== input.pinnedHeadSha) {
    return {
      ok: false,
      refusal: {
        reason: "head-moved",
        detail: `implementation head moved from ${input.pinnedHeadSha} to ${input.currentHeadSha} since this evidence was read`,
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
  const execAtHead = input.execAtHead ?? execWhitelistedProof;
  const execAtBase = input.execAtBase ?? execWhitelistedProof;
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
    if (targetsPlanShard(parsed, input.planShardPaths)) {
      return {
        ok: false,
        refusal: { reason: "targets-plan-shard", detail: `replacement names the plan shard rather than the implementation diff: ${entry.newProof}` },
      };
    }
    let headResult: "pass" | "fail" | "no-match";
    try {
      headResult = execAtHead(parsed, input.headCwd);
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
    if (input.baseCwd === undefined) {
      return { ok: false, refusal: { reason: "base-unreadable", detail: "no merge-base checkout was available to test discrimination" } };
    }
    let baseResult: "pass" | "fail" | "no-match";
    try {
      baseResult = execAtBase(parsed, input.baseCwd);
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
  const digestInput = identity.proposal.map((e) => `${e.claim}\0${e.oldProof}`).sort().join("\n");
  const digest = createHash("sha256").update(digestInput).digest("hex").slice(0, 20);
  return `${identity.taskId}:${identity.prNumber}:${identity.headSha}:${digest}`;
}

/** Stable per-implementation-PR branch name — deterministic so a re-run that pushed but crashed
 *  before recording finds its own prior push via {@link ProofAmendmentWritePorts.probeExisting}
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

/** Locate a task's plan shard through the repository's resolved layout, falling back to its plan
 *  monolith when it declares the task inline. `undefined` when neither carries the task at all. */
export function findTaskShard(repoDir: string, taskId: string): { path: string; text: string } | undefined {
  const layout = resolveRepoLayout(repoDir);
  const toRepoRelative = (path: string) => relative(repoDir, path).split(sep).join("/");
  let shardRelPath: string | undefined;
  try {
    shardRelPath = readdirSync(join(layout.planDir, "tasks.d"))
      .filter((f) => isTaskShardName(f, taskId) && /\.ya?ml$/.test(f))
      .map((f) => toRepoRelative(join(layout.planDir, "tasks.d", f)))[0];
  } catch {
    /* no readable task-shard directory — fall through to the monolith below */
  }
  if (!shardRelPath) {
    const monolith = layout.planMonolith;
    if (existsSync(monolith) && readFileSync(monolith, "utf8").includes(`id: ${taskId}\n`)) {
      shardRelPath = toRepoRelative(monolith);
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

export interface ProofAmendmentWritePorts {
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
export function requestProofAmendment(request: ProofAmendmentRequest, deps: ProofAmendmentWritePorts): ProofAmendmentOutcome {
  const ineligible = proofAmendmentIneligibleReason(request.pr, request.evidence);
  if (ineligible) return { kind: "ineligible", reason: ineligible };
  const evidence = request.evidence!;

  const shard = deps.findShard(deps.repoDir, request.taskId);
  if (!shard) return { kind: "refused", reason: "shard-not-found", detail: `no plan shard found for ${request.taskId}` };

  const planShardPaths = new Set<string>([shard.path]);
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

/**
 * The grep pattern that proves a scope amendment added `path` to a task's `files`: it matches only the
 * entry this writer inserts (always JSON-quoted), never a rationale that already names the path — #10141's
 * bare-path proof matched at the merge base and proof-discrimination refused it. The review gate runs it as
 * `grep -arn -- <pattern> <shard>` (a basic regex), so the path is escaped and the line anchored.
 */
export function addedFilesEntryPattern(path: string, flow: boolean, singleLineFlow: boolean): string {
  const quoted = JSON.stringify(path).replace(/[.*[\\^$]/g, "\\$&");
  if (!flow) return `^ *- ${quoted}$`;
  return singleLineFlow ? `^ *files: \\[.*${quoted}` : `, ${quoted}`;
}

/** W1-T7959: the blocking lint violations an amended shard introduces for `taskId`, judged the way
 *  lint-plan's diff-scoped run judges them (the base task is the `riskTransition` base). A violation
 *  is NEW when it blocks on the amended task and the base task has no counterpart (same check and
 *  message). `undefined` means no verdict: the base shard does not load as a plan, so there is no
 *  baseline to attribute a violation against and the lint stays silent, as it does everywhere a fact
 *  is absent. */
export function newAmendedBlockers(baseText: string, amendedText: string, label: string, taskId: string):
  { blockers: LintViolation[]; task: Task | undefined } | undefined {
  const load = (text: string): { task?: Task; error?: string } => {
    try { return { task: parseTasksFromYaml(text, label).find((t) => t.id === taskId) }; }
    catch (e) { return { error: (e as Error).message }; }
  };
  const baseTask = load(baseText).task;
  if (!baseTask) return undefined;
  const { task, error } = load(amendedText);
  if (!task) {
    return { task, blockers: [{ check: "shard-shape", severity: "block",
      message: `the amended shard no longer loads as a plan task${error ? `: ${error}` : ""}` }] };
  }
  const had = new Set(lintTask(baseTask).violations.filter((v) => v.severity === "block").map((v) => `${v.check}\0${v.message}`));
  const blockers = lintTask(task, { riskTransition: { baseTask } }).violations
    .filter((v) => v.severity === "block" && !had.has(`${v.check}\0${v.message}`));
  return { task, blockers };
}

/** Rule 19's own remedy for a sizing block, applied as a line edit: `risk:` becomes `high` (its
 *  trailing comment replaced to name the subsystems and the amendment PR), and `band_meaning: span`
 *  is added only when the task declares none. Returns `undefined` when the task's mapping is not in
 *  an editable block shape. */
function raiseRiskToHigh(source: string, taskId: string, subsystems: string, prNumber: number): string | undefined {
  let text = source;
  const find = () => {
    const doc = parseDocument(text);
    const task = (isSeq(doc.contents) ? doc.contents.items : []).find((item) =>
      isMap(item) && isScalar(item.get("id", true)) && String((item.get("id", true) as { value: unknown }).value) === taskId);
    return isMap(task) && !task.flow ? task : undefined;
  };
  const lineEnd = (at: number) => { const i = text.indexOf("\n", at); return i < 0 ? text.length : i; };
  const lineStart = (at: number) => text.lastIndexOf("\n", at - 1) + 1;
  const comment = `# Rule 19 span: widened to ${subsystems} by a scope amendment for #${prNumber}`;
  let task = find();
  if (!task) return undefined;
  const risk = task.get("risk", true);
  if (isScalar(risk) && risk.range) {
    const [start, end] = risk.range;
    text = `${text.slice(0, start)}high  ${comment}${text.slice(lineEnd(end))}`;
  } else if (risk === undefined || risk === null) {
    const id = task.get("id", true);
    const firstKey = task.items[0]?.key;
    if (!isScalar(id) || !id.range || !isScalar(firstKey) || !firstKey.range) return undefined;
    const col = firstKey.range[0] - lineStart(firstKey.range[0]);
    text = `${text.slice(0, lineEnd(id.range[1]))}\n${" ".repeat(col)}risk: high  ${comment}${text.slice(lineEnd(id.range[1]))}`;
  } else return undefined;
  task = find();
  if (!task) return undefined;
  if (task.get("band_meaning", true) === undefined) {
    const at = task.get("risk", true);
    const key = task.items.find((pair) => isScalar(pair.key) && pair.key.value === "risk")?.key;
    if (!isScalar(at) || !at.range || !isScalar(key) || !key.range) return undefined;
    const col = key.range[0] - lineStart(key.range[0]);
    const eol = lineEnd(at.range[1]);
    text = `${text.slice(0, eol)}\n${" ".repeat(col)}band_meaning: span${text.slice(eol)}`;
  }
  return text;
}

export interface ScopeAmendmentRequest {
  readonly taskId: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly headSha: string;
  readonly trailerTaskId?: string;
  /** W1-T6465: the implementation PR's head ref. A fleet build PR names its task by its
   *  run-<taskId>-<epochMs> head, not a trailer — head-identity-gate accepts either form. */
  readonly headRef?: string;
  readonly paths: readonly string[];
  readonly changedPaths: readonly string[];
}

export type ScopeAmendmentOutcome = Exclude<ProofAmendmentOutcome, { kind: "ineligible" } | { kind: "refused" }> |
  { kind: "amendment_merged"; amendmentNumber: number } |
  { kind: "refused"; reason: string; detail: string };

export function requestScopeAmendment(request: ScopeAmendmentRequest, deps: ProofAmendmentWritePorts): ScopeAmendmentOutcome {
  const refuse = (reason: string, detail: string): ScopeAmendmentOutcome => ({ kind: "refused", reason, detail });
  if (!Number.isSafeInteger(request.prNumber) || request.prNumber <= 0) return refuse("invalid-pr", "no implementation PR number");
  // W1-T6465: identity is the trailer OR the run-<taskId>-<epochMs> head ref, as head-identity-gate
  // admits; every identity the PR does carry must name THIS task, so a conflicting one still refuses.
  const identities = [request.trailerTaskId, taskIdFromRunBranch(request.headRef)].filter((id) => id !== undefined && id !== "");
  if (identities.length === 0 || identities.some((id) => id !== request.taskId)) {
    return refuse("no-task-trailer", "the implementation PR must carry the matching task trailer or run-<taskId>-<epochMs> head");
  }
  const paths = [...new Set(request.paths)].sort();
  if (paths.length === 0) return refuse("no-paths", "the worker requested no paths");
  for (const path of paths) {
    if (/^(?:\/|[A-Za-z]:)/.test(path) || /[\\\x00-\x1f\x7f]/.test(path) ||
        path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      return refuse("invalid-path", path);
    }
    if (path.startsWith("plan/")) return refuse("plan-path", path);
    if (INSTRUMENT_SURFACE.some((pattern) => new RegExp(pattern).test(path)) || /(?:-ratchet\.mjs|-baseline\.json)$/.test(path)) {
      return refuse("instrument-path", path);
    }
    if (path.startsWith("test/")) return refuse("test-path", path);
    if (!request.changedPaths.includes(path)) return refuse("path-not-changed", path);
  }
  const digest = createHash("sha256").update(paths.join("\0")).digest("hex").slice(0, 20);
  const key = `scope:${request.taskId}:${request.prNumber}:${digest}`;
  const existing = deps.lookupIdentity(key);
  if (existing?.merged) {
    return { kind: "amendment_merged", amendmentNumber: existing.amendmentNumber };
  }
  if (existing) return { kind: "resumed", amendmentUrl: existing.amendmentUrl, amendmentNumber: existing.amendmentNumber };
  const branch = `scope-amendment/${request.taskId}-${request.prNumber}`;
  const probed = deps.probeExisting(branch);
  if (probed) {
    deps.recordIdentity(key, { amendmentUrl: probed.prUrl, amendmentNumber: probed.prNumber, merged: false });
    return { kind: "resumed", amendmentUrl: probed.prUrl, amendmentNumber: probed.prNumber };
  }
  const shard = deps.findShard(deps.repoDir, request.taskId);
  if (!shard || !shard.path.startsWith("plan/")) return refuse("shard-not-found", request.taskId);
  const doc = parseDocument(shard.text);
  const tasks = isSeq(doc.contents) ? doc.contents.items : [];
  const matches = tasks.filter((task) => {
    const id = isMap(task) ? task.get("id", true) : undefined;
    return isScalar(id) && String(id.value) === request.taskId;
  });
  const task = matches[0];
  const files = isMap(task) ? task.get("files", true) : undefined;
  if (doc.errors.length > 0 || matches.length !== 1 || !isSeq(files) || !files.range ||
      !files.items.every((item) => isScalar(item) && typeof item.value === "string")) {
    return refuse("shard-drifted", "the task must have one readable files sequence");
  }
  const additions = paths.filter((path) => !files.toJSON().includes(path));
  if (additions.length === 0) return refuse("already-declared", "all requested paths are already in files");
  const [start, end] = files.range;
  let insert: number;
  let extra: string;
  if (files.flow) {
    const last = files.items.at(-1);
    insert = isScalar(last) ? last.range![1] : start + 1;
    extra = `${files.items.length > 0 ? ", " : ""}${additions.map((path) => JSON.stringify(path)).join(", ")}`;
  } else {
    insert = end;
    const lineStart = shard.text.lastIndexOf("\n", start) + 1;
    const indent = shard.text.slice(lineStart, start).match(/^ */)![0];
    extra = `${shard.text[insert - 1] === "\n" ? "" : "\n"}${additions.map((path) => `${indent}- ${JSON.stringify(path)}\n`).join("")}`;
  }
  let text = shard.text.slice(0, insert) + extra + shard.text.slice(insert);
  if (parseDocument(text).errors.length > 0) return refuse("shard-drifted", "appending paths would invalidate the files sequence");
  // W1-T7959: lint what this writer writes BEFORE any worktree exists. Widening files: is the edit that
  // adds a subsystem, so Rule 19 sizing is the violation it produces by construction, and the linter's
  // own remedy for it (raise to risk:high) is applied; anything else new that blocks is refused.
  let riskRaise: { subsystems: string } | undefined;
  let verdict = newAmendedBlockers(shard.text, text, shard.path, request.taskId);
  if (verdict && verdict.blockers.length > 0) {
    const sizing = verdict.blockers.filter((v) => v.check === "sizing" && verdict!.task !== undefined && verdict!.task.risk !== "high");
    if (sizing.length === verdict.blockers.length) {
      const subsystems = /\((.*?)\) at risk:/.exec(sizing[0]!.message)?.[1] ?? "more than one subsystem";
      const raised = raiseRiskToHigh(text, request.taskId, subsystems, request.prNumber);
      if (raised !== undefined && parseDocument(raised).errors.length === 0) {
        text = raised;
        riskRaise = { subsystems };
        verdict = newAmendedBlockers(shard.text, text, shard.path, request.taskId);
      }
    }
  }
  if (verdict && verdict.blockers.length > 0) {
    return refuse("amended-shard-lint", verdict.blockers.map((v) => `${v.check}: ${v.message}`).join("; "));
  }
  const wp = deps.worktreePathFor(request.taskId, request.prNumber);
  deps.worktreeAdd(deps.repoDir, wp, branch);
  try {
    const currentShard = deps.findShard(wp, request.taskId);
    if (currentShard?.path !== shard.path || currentShard.text !== shard.text) {
      return refuse("shard-drifted", "the amendment base differs from the observed task shard");
    }
    deps.writeFile(join(wp, shard.path), text);
    deps.gitAdd(wp, shard.path);
    const title = `fix(plan): extend ${request.taskId.toLowerCase()}'s files for #${request.prNumber}`;
    const sha = deps.gitCommit(wp, riskRaise
      ? `${title}\n\nAppend validated worker paths to files and raise risk to high: the task linter counted ` +
        `${riskRaise.subsystems} (Rule 19 sizing). band_meaning: span is added only when none was declared.`
      : `${title}\n\nAppend validated worker paths to files only.`);
    deps.gitPush(wp, branch, sha);
    const created = deps.createPr({ title, head: branch, base: "main",
      body: (riskRaise
        ? `Scope amendment for #${request.prNumber}. ${shard.path}'s files list changes and its risk is raised to high ` +
          `because the task linter counted ${riskRaise.subsystems} (Rule 19 sizing); band_meaning: span is added only when none was declared.\n\n`
        : `Scope amendment for #${request.prNumber}. Only ${shard.path}'s files list changes.\n\n`) +
        renderAcceptanceBlock([...additions.map((path) => ({ claim: `files includes ${path}`,
          proof: `grep: ${addedFilesEntryPattern(path, files.flow === true, !shard.text.slice(start, end).includes("\n"))} in ${shard.path}` })),
          ...(riskRaise ? [{ claim: `risk is raised to high for ${riskRaise.subsystems}`, proof: `grep: ^ *risk: high in ${shard.path}` }] : [])]) });
    deps.recordIdentity(key, { amendmentUrl: created.prUrl, amendmentNumber: created.prNumber, merged: false });
    return { kind: "created", amendmentUrl: created.prUrl, amendmentNumber: created.prNumber };
  } finally {
    deps.worktreeRemove(deps.repoDir, wp);
  }
}

export interface ScopeAmendmentWork {
  root: string;
  worktreePath: string;
  taskId: string;
  prNumber: number;
  amendmentNumber: number;
  paths: readonly string[];
}

function scopeWorkIdentity(input: ScopeAmendmentWork): string {
  return JSON.stringify([input.taskId, input.prNumber, input.amendmentNumber, [...new Set(input.paths)].sort()]);
}

function scopeWorkRecoveryPath(input: ScopeAmendmentWork): string {
  const key = createHash("sha256").update(scopeWorkIdentity(input)).digest("hex");
  return join(input.root, "recovery", "scope-amendment", `${key}.json`);
}

// Recovery copies contain regular files or deletions only; neither a source nor a destination may
// follow a worker-controlled symlink out of the worktree (including an ancestor directory).
function scopeWorkParts(path: string): string[] {
  if (!path || /[\\\x00-\x1f\x7f:]/.test(path) || path.split("/").some((p) => !p || p === "." || p === ".." || p === ".git")) {
    throw new Error(`unsafe scope recovery path: ${path}`);
  }
  return path.split("/");
}

interface ScopeWorkEntry { path: string; data: string | null; mode: number }

interface ScopeWorkIo { run: (script: string, input: string) => string | Promise<string> }
// BACKSTOP: bound the rare recovery subprocess and its private IPC, never truncate saved work.
const SCOPE_WORK_IO_TIMEOUT_MS = 30_000;
const SCOPE_WORK_IO_MAX_BYTES = 64 * 1024 * 1024;
const scopeWorkIo: ScopeWorkIo = { async run(script, input) {
  const command = execFileLoopBounded("python3", ["-I", "-c", script], {
    encoding: "utf8", timeout: SCOPE_WORK_IO_TIMEOUT_MS, maxBuffer: SCOPE_WORK_IO_MAX_BYTES,
    killSignal: "SIGKILL",
  });
  const fed = new Promise<void>((resolveInput, rejectInput) => {
    const stdin = command.child.stdin!;
    stdin.once("error", rejectInput);
    stdin.end(input, (error?: Error | null) => error ? rejectInput(error) : resolveInput());
  });
  const [{ stdout }] = await Promise.all([command, fed]);
  return stdout;
} };

// Python3 is already required by the deploy image. Its dir_fd operations expose openat/renameat
// on both supported POSIX hosts; /dev/fd/<directory>/<child> is not portable to macOS.
const SCOPE_WORK_FILES = String.raw`
import base64, contextlib, errno, json, os, stat, sys, uuid

def recover(request):
    required = (os.open, os.mkdir, os.unlink, os.rename, os.stat)
    if not all(fn in os.supports_dir_fd for fn in required) or not hasattr(os, "O_NOFOLLOW"):
        raise ValueError("descriptor-relative scope recovery is unavailable")
    entries = request["entries"]
    for entry in entries:
        name = entry["path"]
        if not name or any(ord(c) < 32 or ord(c) == 127 or c in "\\:" for c in name) or any(p in ("", ".", "..", ".git") for p in name.split("/")):
            raise ValueError("unsafe scope recovery path")
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    with contextlib.ExitStack() as stack:
        def held(fd):
            stack.callback(os.close, fd)
            return fd
        root = held(os.open(request["root"], directory_flags))
        def parent_for(name, create):
            parent = root
            for part in name.split("/")[:-1]:
                try:
                    child = os.open(part, directory_flags, dir_fd=parent)
                except FileNotFoundError:
                    if not create:
                        return None
                    try:
                        os.mkdir(part, mode=0o755, dir_fd=parent)
                        os.fsync(parent)
                    except FileExistsError:
                        pass
                    child = os.open(part, directory_flags, dir_fd=parent)
                parent = held(child)
            return parent
        plans = []
        for entry in entries:
            parent = parent_for(entry["path"], request["restore"] and entry["data"] is not None)
            leaf = entry["path"].split("/")[-1]
            if request["restore"] and parent is not None:
                try:
                    current = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    current = None
                if current is not None and not stat.S_ISREG(current.st_mode):
                    raise ValueError("scope recovery requires a regular path")
            plans.append((entry, parent, leaf))
        result = []
        for entry, parent, leaf in plans:
            if not request["restore"]:
                try:
                    if parent is None:
                        raise FileNotFoundError()
                    fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                except FileNotFoundError:
                    result.append(dict(path=entry["path"], data=None, mode=0))
                    continue
                with os.fdopen(fd, "rb") as source:
                    info = os.fstat(source.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        raise ValueError("scope recovery requires a regular path without hard links")
                    result.append(dict(path=entry["path"], data=base64.b64encode(source.read()).decode("ascii"), mode=stat.S_IMODE(info.st_mode) & 0o777))
            elif parent is not None:
                if entry["data"] is None:
                    try:
                        os.unlink(leaf, dir_fd=parent)
                        os.fsync(parent)
                    except FileNotFoundError:
                        pass
                else:
                    data = base64.b64decode(entry["data"], validate=True)
                    temporary = ".scope-restore-" + uuid.uuid4().hex
                    fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                    published = False
                    try:
                        with os.fdopen(fd, "w+b") as target:
                            target.write(data)
                            target.flush()
                            os.fchmod(target.fileno(), entry["mode"])
                            os.fsync(target.fileno())
                            target.seek(0)
                            if target.read() != data:
                                raise ValueError("restored scope recovery bytes did not verify")
                        os.replace(temporary, leaf, src_dir_fd=parent, dst_dir_fd=parent)
                        published = True
                        os.fsync(parent)
                    finally:
                        if not published:
                            os.unlink(temporary, dir_fd=parent)
        return result

try:
    print(json.dumps(dict(ok=True, entries=recover(json.load(sys.stdin)))))
except (OSError, ValueError) as error:
    message = "scope recovery requires a regular path" if isinstance(error, OSError) and error.errno in (errno.ELOOP, errno.ENOTDIR) else str(error)
    print(json.dumps(dict(ok=False, error=message)))
`;

async function scopeWorkFiles(input: ScopeAmendmentWork, entries: ScopeWorkEntry[], restore: boolean, io: ScopeWorkIo): Promise<ScopeWorkEntry[]> {
  for (const entry of entries) scopeWorkParts(entry.path);
  const result = JSON.parse(await io.run(SCOPE_WORK_FILES, JSON.stringify({ root: resolve(input.worktreePath), entries, restore })));
  if (result.ok !== true) throw new ScopeRecoveryError(String(result.error ?? "scope recovery filesystem unavailable"));
  if (!Array.isArray(result.entries)) throw new Error("scope recovery filesystem response did not verify");
  return result.entries;
}

class ScopeRecoveryError extends RmdError {
  constructor(message: string) {
    super("scope_recovery", 1, message);
    this.name = "ScopeRecoveryError";
  }
}

class MissingScopeWorkError extends ScopeRecoveryError {
  constructor() {
    super("missing saved work from the round that asked for scope");
    this.name = "MissingScopeWorkError";
  }
}

function readScopeWork(input: ScopeAmendmentWork): ScopeWorkEntry[] {
  const file = scopeWorkRecoveryPath(input);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new MissingScopeWorkError();
  }
  const saved = JSON.parse(text);
  if (saved.identity !== scopeWorkIdentity(input) || typeof saved.payload !== "string" ||
      saved.digest !== createHash("sha256").update(saved.payload).digest("hex")) {
    throw new Error("scope recovery identity or digest did not verify");
  }
  const entries: ScopeWorkEntry[] = JSON.parse(saved.payload);
  const paths = [...new Set(input.paths)].sort();
  if (!Array.isArray(entries) || entries.length !== paths.length || entries.some((entry, i) =>
    entry.path !== paths[i] || (entry.data !== null && typeof entry.data !== "string") ||
    !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) {
    throw new Error("scope recovery paths or file content did not verify");
  }
  return entries;
}

/** Shared by any lane that parks edits behind a scope amendment. A resume verifies its existing
 *  immutable copy instead of replacing the asking round's work with an empty, later checkout. */
export async function saveScopeAmendmentWork(input: ScopeAmendmentWork, io: ScopeWorkIo = scopeWorkIo): Promise<string> {
  const file = scopeWorkRecoveryPath(input);
  try {
    readScopeWork(input);
    return file;
  } catch (error) {
    if (!(error instanceof MissingScopeWorkError)) throw error;
  }
  const entries = await scopeWorkFiles(input, [...new Set(input.paths)].sort().map((path) => ({ path, data: null, mode: 0 })), false, io);
  const payload = JSON.stringify(entries);
  const text = JSON.stringify({ identity: scopeWorkIdentity(input), payload,
    digest: createHash("sha256").update(payload).digest("hex") });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(join(input.root, "recovery", ".rmd-scratch-keep"), "preserved scope-amendment work\n", { flush: true });
  // Publish a complete file in one link; a losing writer can then verify the winner's bytes.
  const staging = join(dirname(file), `.scope-work-${randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(staging, text, { flag: "wx", mode: 0o600, flush: true });
    try {
      linkSync(staging, file);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    rmSync(staging, { force: true });
  }
  if (created) {
    if (readFileSync(file, "utf8") !== text) throw new Error("saved scope recovery bytes did not verify");
    for (const path of [dirname(file), dirname(dirname(file)), input.root]) {
      const fd = openSync(path, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  readScopeWork(input);
  return file;
}

export async function restoreScopeAmendmentWork(input: ScopeAmendmentWork, io: ScopeWorkIo = scopeWorkIo): Promise<string[]> {
  const entries = readScopeWork(input);
  await scopeWorkFiles(input, entries, true, io);
  return entries.map((entry) => entry.path);
}

