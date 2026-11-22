/**
 * lib/skill-eval-auto.ts — W1-T13861: the fleet starts a staged skill draft's held-out eval by itself.
 *
 * Before this module no eval ever ran: `rmd skill-eval` spends only with the --confirm-spend flag in its argv, and `rmd
 * approve` refuses a skill draft until a passing eval is recorded for its current text. The operator approved on
 * 2026-11-19 that the fleet runs the eval itself, inside the spend limits that already exist, for drafts that pass
 * the quality bar. Approval stays the operator's: a pass makes the draft approvable, and only `rmd approve` writes
 * under .claude/skills/.
 *
 * ONE PASS, AT MOST ONE EVAL. The pass takes the first open draft in registry order whose stored text passes the
 * W1-T13858 whole-draft check and has no eval and no claim for its sha256. It checks the gates in order: the quiet
 * fleet (replayIdleGate), then the spend fit (today's ledgered cost plus SKILL_EVAL_MAX_SPEND_USD at or under the
 * effective daily cost ceiling, no unpriced rows today, and for a stack that bills cash at least that much cash
 * allowance left). A closed gate records why the draft waits and spends nothing. With every gate open it claims
 * the text on the registry entry, writes one claim row, and runs the same eval path as `rmd skill-eval`.
 *
 * ONE EVAL PER TEXT. Only a refusal with zero attempts dispatched releases the claim. A crash, a cancelled run or a
 * finished one keeps it, so no text is ever evaluated twice by the fleet. The workshop's next rewrite is a new
 * sha256 and earns one new eval.
 */
import { createHash, randomUUID } from "node:crypto";
import { systemClock, type Clock } from "./clock.js";
import { replayIdleGate, type ReplayIdleSignal } from "./golden-corpus.js";
import { loadProposalRegistry, SKILL_DRAFT_ID_PREFIX, updateProposalRegistry, type Proposal, type SkillEvalAutoRecord } from "./inbox.js";
import type { LedgerLine } from "./ledger.js";
import { SKILL_EVAL_MAX_SPEND_USD, SKILL_EVAL_STANDING_APPROVAL, type SkillEvalRun } from "./skill-eval.js";
import { hasSkillDraftLedgerReceipt, outcomeOnlyDraftRefusal, readSkillDraftVerdicts,
  withSkillDraftVerdictLock, workshopClosedSkillDraft } from "./skill-workshop.js";

/** The two rows this pass writes; declared in ledger-steps.ts. */
export const SKILL_EVAL_AUTO_STEPS = { waiting: "skill_eval.auto_waiting", claimed: "skill_eval.auto_claimed" } as const;

/** Today's ledgered cost against the effective daily cost ceiling, and, only for a stack that bills cash, the cash
 *  allowance left today (or why it could not be read: an absent `dailyCapUsd` is a refusal). skill-eval-command.ts's
 *  `readSkillEvalSpendFit` produces it. */
export interface SkillEvalSpendFit {
  dayCostUsd: number;
  unpricedRows: number;
  ceilingUsd: number;
  cash?: { remainingUsd: number } | { unreadable: string };
}

/**
 * The seams one pass reads: the same ones `SkillEvalCommandInput` (skill-eval-command.ts) carries, so the retro passes
 * `skillEvalProductionInput` unchanged. Declared here, never imported: this module stays a leaf of the retro, out of
 * the import cycle skill-eval-command.ts sits in.
 */
export interface SkillEvalAutoInput {
  registryPath: () => string;
  stateDir: () => string;
  readIdle: () => Promise<ReplayIdleSignal>;
  /** Absent: the pass waits, since it cannot show the eval fits. */
  readSpendFit?: () => SkillEvalSpendFit;
  log: (row: LedgerLine) => void;
  clock?: Clock;
}

/** The one eval path (skill-eval-command.ts's `evaluateStagedSkillDraft` over the same input), run with the standing
 *  approval and the claim's run id. `refusedBeforeDispatch`: it refused with zero attempts dispatched. */
export type StartClaimedSkillEval = (draftSha256: string, start: () => Promise<SkillEvalRun>) => Promise<SkillEvalRun> | undefined;
export type SkillEvalAutoEvaluate = (proposalId: string, approval: { standingApproval: Readonly<{ ref: string }> }, runId: string,
  startClaimed: StartClaimedSkillEval) => Promise<{ code: number; refusedBeforeDispatch: boolean }>;

/** One pass's outcome: the draft it acted on (absent when none was eligible) and a line the retro prints. */
export interface SkillEvalAutoPass {
  proposalId?: string;
  reason: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function eligibleDraftSha(entry: Proposal, ownRunId?: string): string | undefined {
  if (!entry.id.startsWith(SKILL_DRAFT_ID_PREFIX) || !entry.skillFile ||
    workshopClosedSkillDraft(entry) || outcomeOnlyDraftRefusal(entry.skillFile.markdown) !== undefined) return undefined;
  const sha = sha256(entry.skillFile.markdown);
  if (entry.skillEval?.draftSha256 === sha) return undefined;
  const claim = entry.skillEvalAuto;
  const claimed = claim?.state === "claimed" && claim.draftSha256 === sha;
  return (ownRunId === undefined ? !claimed : claimed && claim.runId === ownRunId) ? sha : undefined;
}

/** Why the spend reading keeps the eval from starting, or undefined when it fits. */
function spendFitRefusal(fit: SkillEvalSpendFit | undefined): string | undefined {
  if (fit === undefined) return "spend-not-measured: no spend reading is wired, so the eval cannot show it fits";
  if (fit.unpricedRows > 0) return "daily-cost-unpriced: some of today's ledger rows carry no price, so today's cost is not known";
  if (fit.dayCostUsd + SKILL_EVAL_MAX_SPEND_USD > fit.ceilingUsd) {
    return `daily-cost-ceiling: today's ledgered cost plus the eval's $${SKILL_EVAL_MAX_SPEND_USD} limit is above the `
      + `$${fit.ceilingUsd} daily cost ceiling`;
  }
  if (fit.cash === undefined) return undefined;
  if ("unreadable" in fit.cash) return `cash-allowance-unreadable: ${fit.cash.unreadable}`;
  if (fit.cash.remainingUsd < SKILL_EVAL_MAX_SPEND_USD) {
    return `cash-allowance: less than the eval's $${SKILL_EVAL_MAX_SPEND_USD} limit is left in today's cash allowance`;
  }
  return undefined;
}

/** A replace of one entry's auto record, only while its stored text is still `draftSha256`. */
function writeAutoRecord(registryPath: string, proposalId: string, draftSha256: string,
  next: (entry: Proposal) => SkillEvalAutoRecord | undefined | null): boolean {
  return updateProposalRegistry(registryPath, (current) => {
    const entry = current.find((p) => p.id === proposalId);
    if (entry?.skillFile === undefined || sha256(entry.skillFile.markdown) !== draftSha256) return null;
    const record = next(entry);
    if (record === null) return null;
    const updated: Proposal = { ...entry };
    if (record === undefined) delete updated.skillEvalAuto;
    else updated.skillEvalAuto = record;
    return current.map((p) => (p === entry ? updated : p));
  }) !== null;
}

/**
 * One auto-eval pass over the proposal registry. Writes only the registry entry's `skillEvalAuto`, its ledger rows
 * and, through the eval, sealed never-pushed attempt worktrees and the verdict record.
 */
export async function autoEvaluateSkillDrafts(input: SkillEvalAutoInput, evaluate: SkillEvalAutoEvaluate): Promise<SkillEvalAutoPass> {
  const clock = input.clock ?? systemClock;
  const registryPath = input.registryPath();
  const candidates = loadProposalRegistry(registryPath).flatMap((entry) => {
    const draftSha256 = eligibleDraftSha(entry);
    return draftSha256 === undefined ? [] : [{ proposalId: entry.id, draftSha256 }];
  });
  if (candidates.length === 0) return { reason: "no skill draft is waiting for an eval" };
  const stateDir = input.stateDir();
  const verdicts = readSkillDraftVerdicts(stateDir);
  if ("unmeasured" in verdicts) return { reason: `no skill draft evaluated: ${verdicts.unmeasured}` };
  const draft = candidates.find(({ proposalId }) => !verdicts.isRatified(proposalId) && verdicts.isDeclined(proposalId) === undefined);
  if (draft === undefined) return { reason: "no skill draft is waiting for an eval" };
  const { proposalId, draftSha256 } = draft;
  const runId = `SKILL-EVAL-${clock.now()}-${randomUUID()}`;
  const row = (step: string, fields: Record<string, unknown>): LedgerLine =>
    ({ ...fields, run_id: runId, task_id: proposalId, step, draft_sha256: draftSha256 });
  const verdictRefusal = (): string | undefined => {
    const current = readSkillDraftVerdicts(stateDir);
    if ("unmeasured" in current) return current.unmeasured;
    if (current.isRatified(proposalId) || current.isDeclined(proposalId) !== undefined) return `${proposalId} is no longer open`;
  };

  const idle = replayIdleGate(await input.readIdle());
  const fit = idle.enabled ? input.readSpendFit?.() : undefined;
  const waitReason = idle.enabled ? spendFitRefusal(fit) : idle.reason;
  const skipped = withSkillDraftVerdictLock(stateDir, proposalId, () => {
    const refusal = verdictRefusal();
    if (refusal !== undefined) return refusal;
    const changed = writeAutoRecord(registryPath, proposalId, draftSha256, (entry) => {
      if (eligibleDraftSha(entry) !== draftSha256) return null;
      const at = clock.iso();
      if (waitReason === undefined) return { draftSha256, state: "claimed", runId, at };
      const prior = entry.skillEvalAuto;
      if (prior?.state === "waiting" && prior.draftSha256 === draftSha256 && prior.reason === waitReason) return null;
      return { draftSha256, state: "waiting", reason: waitReason, at };
    });
    if (waitReason !== undefined) {
      if (changed) input.log(row(SKILL_EVAL_AUTO_STEPS.waiting, { reason: waitReason, ...(fit === undefined ? {} : {
        day_cost_usd: fit.dayCostUsd, unpriced_rows: fit.unpricedRows, daily_cost_ceiling_usd: fit.ceilingUsd }) }));
      return `${proposalId} waits: ${waitReason}`;
    }
    if (!changed) return `${proposalId}'s text or eligibility changed before it was claimed; the next pass looks again`;
    const receipt = row(SKILL_EVAL_AUTO_STEPS.claimed, { max_spend_usd: SKILL_EVAL_MAX_SPEND_USD, approval: SKILL_EVAL_STANDING_APPROVAL.ref });
    input.log(receipt);
    if (!hasSkillDraftLedgerReceipt(stateDir, receipt)) return `${proposalId}'s claim receipt could not be verified; its claim stays on this text`;
  });
  if (skipped !== undefined) return { proposalId, reason: skipped };

  // The common command awaits corpus and headroom again. Recheck under the verdict lock at the
  // synchronous start of the first attempt, without holding the lock through worker execution.
  const outcome = await evaluate(proposalId, { standingApproval: SKILL_EVAL_STANDING_APPROVAL }, runId, (selectedSha, start) =>
    withSkillDraftVerdictLock(stateDir, proposalId, () => {
      const current = loadProposalRegistry(registryPath).find((entry) => entry.id === proposalId);
      if (selectedSha !== draftSha256 || current === undefined || eligibleDraftSha(current, runId) !== draftSha256 ||
        verdictRefusal() !== undefined) return undefined;
      return start();
    }));
  if (outcome.refusedBeforeDispatch) {
    // Nothing was spent, so the text is not judged: release the claim and let a later pass try again.
    writeAutoRecord(registryPath, proposalId, draftSha256, (entry) => (entry.skillEvalAuto?.runId === runId ? undefined : null));
    return { proposalId, reason: `${proposalId}'s eval refused before any attempt; the claim is released` };
  }
  return { proposalId, reason: `${proposalId}'s eval ended with exit ${outcome.code}; its claim stays on this text` };
}

/** The retro's one call: print what the pass did, and never let a throw fail the retro. */
export async function reportSkillEvalAuto(pass: () => Promise<SkillEvalAutoPass>, say: (line: string) => void): Promise<void> {
  try {
    say(`skill eval: ${(await pass()).reason}`);
  } catch (error) {
    say(`skill eval: the auto pass failed: ${String((error as Error)?.message ?? error)}`);
  }
}
