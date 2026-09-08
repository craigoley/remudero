/**
 * lib/verify-human-judge.ts — W1-T3188: the `verify: human` backlog, judged.
 *
 * OPERATOR DIRECTION 2026-09-08, verbatim: "We've talked about adding an llm as a judge for the
 * verify human shards to make sure they actually need me, then surface them through the inbox."
 *
 * MEASURED 2026-09-08 over plan/tasks.d + plan/tasks.yaml: 74 `verify: human` shards
 * {queued 56, blocked 6, merged 10, done 2}. Not one has ever been asked whether it still needs a
 * person. A shard filed in July because its author wanted a second opinion sits beside one whose
 * dependency merged weeks ago, and the board cannot tell them apart.
 *
 * WHAT THIS MAY DO, AND THE LIST IS SHORT. It writes a ROUTING verdict to the ledger. That is all.
 * It never edits `plan/tasks.d/`, never flips a `verify:` field, never closes or retires a shard —
 * a judge that could tidy the plan would have been handed rule-15 powers by the back door, and 56
 * tasks nobody approved would become dispatchable. See {@link judgeVerifyHumanShard}: it returns a
 * verdict and performs no effect at all.
 */

import type { Proposal } from "./inbox.js";
import type { Mount, Mounts } from "./mounts.js";
import { resolveRiskJudgeMount } from "./risk-judge.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";

/** What the judge decides for ONE parked shard. Two values, and neither is "close": the type
 *  cannot express removal, so no verdict can make a filed task disappear. */
export type VerifyHumanDecision = "needs_operator" | "backlog";

/** The step written for EVERY judged shard, BOTH arms. W1-T3166 had to establish "has this judge
 *  ever run" from three separate reads because no such row existed; that is not repeated.
 *  Registered in DECISION_RELEVANT_LEDGER_STEPS (lib/ledger.ts) in this same change. */
export const VERIFY_HUMAN_JUDGED_STEP = "verify_human.judged";

/** `reason` is ledgered verbatim and, on `needs_operator`, is what the operator reads first.
 *  `judgeFailed` marks a verdict that is a DEFAULT rather than an answer — see
 *  {@link FAIL_OPEN_VERIFY_HUMAN_VERDICT} for why that distinction is load-bearing. */
export interface VerifyHumanVerdict {
  decision: VerifyHumanDecision;
  reason: string;
  judgeFailed?: true;
}

/**
 * One shard under judgement, with the state a human would actually need to answer the question
 * (design iii). A judge asked "does this need a person" with no state to read is guessing, and its
 * verdict is then noise carrying a model's confidence.
 */
export interface ShardUnderJudgement {
  id: string;
  title: string;
  rationale: string;
  acceptance: readonly string[];
  /** Days since the shard was filed. */
  ageDays: number;
  /** Whether every `depends_on` is merged — a shard blocked on unmerged work rarely needs a person YET. */
  depsAllMerged: boolean;
  /** Whether anything in `src/` cites this id — evidence the work landed under another shard. */
  citedInSrc: boolean;
}

/**
 * FAIL-OPEN DEFAULT: a spawn error, a timeout or an unparseable verdict resolves to this.
 *
 * SAME POLARITY AS escalate.ts's, AND THE OPPOSITE OF ruling-judge.ts's, which is two files away
 * and will invite a reviewer to harmonise them. Here the costly direction is a judge outage
 * quietly deciding the operator does not need to see something — so an unreadable verdict keeps
 * the shard in front of him.
 *
 * `judgeFailed` is what stops that being a permanent misfile: {@link isSettled} refuses to cache a
 * failed verdict, so the shard is re-asked on the next pass and a transient outage self-heals
 * instead of pinning 56 shards to the ask list forever.
 */
export const FAIL_OPEN_VERIFY_HUMAN_VERDICT: VerifyHumanVerdict = {
  decision: "needs_operator",
  reason:
    "judge output carried no parseable VERIFY_HUMAN_DECISION — failing open to needs_operator " +
    "(never let an outage decide the operator does not need to see something)",
  judgeFailed: true,
};

const VALID_DECISIONS = new Set<VerifyHumanDecision>(["needs_operator", "backlog"]);

/**
 * DESIGN (iv): judge once per OBSERVED STATE, never once per poll. 56 shards times every refresh
 * is a token event, not a sweep.
 *
 * The key carries exactly the facts that could change the answer — the two pieces of live state,
 * plus the shard's identity. A dependency merging or a citation appearing CHANGES the key and
 * re-opens the question; a poll five minutes later does not. Age is deliberately EXCLUDED: it
 * changes daily and would re-ask everything every day, which is the cost this key exists to avoid.
 */
export function observedStateKey(shard: ShardUnderJudgement): string {
  return `${shard.id}:deps=${shard.depsAllMerged ? 1 : 0}:cited=${shard.citedInSrc ? 1 : 0}`;
}

/** True when this shard's CURRENT observed state already has a real answer. A FAILED verdict is
 *  never settled — see {@link FAIL_OPEN_VERIFY_HUMAN_VERDICT} — so an outage is re-asked rather
 *  than cached as fact. */
export function isSettled(shard: ShardUnderJudgement, priorVerdicts: ReadonlyMap<string, VerifyHumanVerdict>): boolean {
  const prior = priorVerdicts.get(observedStateKey(shard));
  return prior !== undefined && prior.judgeFailed !== true;
}

/** The shards a pass should actually spend a judge call on. */
export function shardsNeedingJudgement(
  shards: readonly ShardUnderJudgement[],
  priorVerdicts: ReadonlyMap<string, VerifyHumanVerdict>,
): ShardUnderJudgement[] {
  return shards.filter((s) => !isSettled(s, priorVerdicts));
}

/** Render the judge's prompt. NOT the escalation judge's prompt reused: that one reasons about an
 *  issue with options and a recommendation, and a parked shard has none of those — a prompt
 *  describing fields that do not exist invites a confident answer about nothing. */
export function buildVerifyHumanJudgePrompt(shard: ShardUnderJudgement): string {
  const acceptance = shard.acceptance.map((a, i) => `  ${i + 1}. ${a}`).join("\n") || "  (none stated)";
  return [
    `You are the VERIFY-HUMAN JUDGE (W1-T3188). ONE task in this repo's plan was filed`,
    `\`verify: human\` — meaning a person, not a machine, was supposed to verify it. It has been`,
    `sitting for ${shard.ageDays} days. Decide whether it STILL needs that person.`,
    ``,
    `WHAT YOU ARE DECIDING, and it is narrow: whether this shard should be put in front of the`,
    `operator as something to act on, or whether it can stay in the visible backlog for now. You`,
    `are NOT deciding whether the work is right, whether it should be done, or whether it can be`,
    `closed. You cannot close it. Nothing you say edits the plan.`,
    ``,
    `SIGNALS THAT IT PROBABLY STILL NEEDS HIM: a genuine judgement call only he can make (his own`,
    `priorities, budget, risk appetite, or intent); a decision that would set policy; something`,
    `time-sensitive; an ask whose answer unblocks other work.`,
    ``,
    `SIGNALS THAT IT PROBABLY DOES NOT, YET: its dependencies have not merged, so the question`,
    `cannot even be asked properly; the work appears already done elsewhere; it asks for a review`,
    `of something that has since changed; it is a preference an agent could reasonably settle and`,
    `record itself.`,
    ``,
    `THE ASYMMETRY THAT GOVERNS THIS: a FALSE "backlog" leaves the operator unaware of something he`,
    `needed — he cannot know to look for it. A FALSE "needs_operator" costs him one skim. WHEN IN`,
    `DOUBT, SAY needs_operator.`,
    ``,
    `TASK: ${shard.id}`,
    `AGE: ${shard.ageDays} days since filing`,
    `DEPENDENCIES ALL MERGED: ${shard.depsAllMerged ? "yes" : "no"}`,
    `ITS ID IS CITED IN src/: ${shard.citedInSrc ? "yes — the work may already have landed" : "no"}`,
    ``,
    `TITLE:`,
    shard.title,
    ``,
    `WHY IT WAS FILED:`,
    shard.rationale || "(no rationale recorded)",
    ``,
    `WHAT IT CLAIMS TO DELIVER:`,
    acceptance,
    ``,
    `Decide — exactly one of:`,
    `  needs_operator — put this in front of him; it is a real ask`,
    `  backlog        — it can wait in the visible backlog; it is not an ask today`,
    ``,
    `MACHINE-READABLE OUTPUT (required, in addition to any prose): emit exactly one of each of`,
    `these lines, and nothing else on the line:`,
    `  VERIFY_HUMAN_DECISION: <needs_operator|backlog>`,
    `  VERIFY_HUMAN_REASON: <one concrete, specific reason naming THIS shard's own facts>`,
  ].join("\n");
}

/** Parse the judge's two lines. Anything unreadable fails OPEN
 *  ({@link FAIL_OPEN_VERIFY_HUMAN_VERDICT} — `needs_operator`, and marked as a default). */
export function parseVerifyHumanVerdict(text: string): VerifyHumanVerdict {
  const m = text.match(/VERIFY_HUMAN_DECISION:\s*(\w+)/i);
  const decision = m?.[1]?.toLowerCase() as VerifyHumanDecision | undefined;
  if (!decision || !VALID_DECISIONS.has(decision)) return { ...FAIL_OPEN_VERIFY_HUMAN_VERDICT };
  const reasonMatch = text.match(/VERIFY_HUMAN_REASON:\s*(.+)/i);
  return { decision, reason: reasonMatch?.[1]?.trim() || "(no reason stated)" };
}

/** Injectable judge dependency — real callers wire {@link realVerifyHumanJudge}; tests inject a
 *  fake, exactly as escalate.ts's and ruling-judge.ts's do. */
export interface VerifyHumanJudgeDeps {
  judge: (shard: ShardUnderJudgement) => Promise<VerifyHumanVerdict>;
}

/**
 * Decide needs_operator|backlog for ONE shard. PURE OF EFFECTS BY CONSTRUCTION: it returns a
 * verdict and writes nothing — no plan file, no ledger, no console. That is design clause (ii)
 * expressed as a signature rather than as a promise, so "the judge cannot edit the plan" is not a
 * property a reviewer has to check but one there is no code path to violate.
 *
 * A judge-unavailable error is caught HERE and fails OPEN.
 */
export async function judgeVerifyHumanShard(
  shard: ShardUnderJudgement,
  deps: VerifyHumanJudgeDeps,
): Promise<VerifyHumanVerdict> {
  try {
    return await deps.judge(shard);
  } catch (err) {
    return {
      ...FAIL_OPEN_VERIFY_HUMAN_VERDICT,
      reason: `judge unavailable (${err instanceof Error ? err.message : String(err)}) — failing open to needs_operator`,
    };
  }
}

/** The ledger row for one verdict, on EITHER arm (design v). A plain object, so the caller owns
 *  the write and this module stays effect-free. */
export function verifyHumanVerdictRow(shard: ShardUnderJudgement, verdict: VerifyHumanVerdict, runId: string): Record<string, unknown> {
  return {
    run_id: runId,
    task_id: shard.id,
    step: VERIFY_HUMAN_JUDGED_STEP,
    judge_decision: verdict.decision,
    judge_reason: verdict.reason,
    observed_state: observedStateKey(shard),
    ...(verdict.judgeFailed ? { judge_failed: true } : {}),
  };
}

/** Derived from the shard, so the same ask staged twice is one proposal rather than two. */
export function verifyHumanProposalId(shard: ShardUnderJudgement): string {
  return `verify-human:${shard.id}`;
}

/**
 * A `needs_operator` shard, as an ordinary inbox {@link Proposal} — the operator's own words were
 * "then surface them through the inbox", and this is that surface. `evidenceAnchors` is EMPTY on
 * purpose: anchors tier a proposal READY by asking "has the thing this depends on landed on main",
 * and this proposal depends on nothing landing; its evidence is prose he reads.
 */
export function proposalFromJudgedShard(shard: ShardUnderJudgement, verdict: VerifyHumanVerdict): Proposal {
  return {
    id: verifyHumanProposalId(shard),
    summary:
      `${shard.id} was filed \`verify: human\` ${shard.ageDays} days ago and a judge reads it as ` +
      `still needing you:\n  ${verdict.reason}\n\n` +
      `${shard.title}\n\n` +
      `Dependencies all merged: ${shard.depsAllMerged ? "yes" : "no"}. ` +
      `Cited in src/: ${shard.citedInSrc ? "yes" : "no"}.\n\n` +
      `Nothing about the shard has been changed — this is a routing verdict, not a plan edit.`,
    evidenceAnchors: [],
  };
}

// ── The real spawn (read-only BY CONSTRUCTION — no tools, mirrors its two siblings) ────────────

/** EMPTY by construction, like escalate.ts's and ruling-judge.ts's: everything the judge needs is
 *  in the prompt, so it can neither explore the worktree nor take any action. */
export const VERIFY_HUMAN_JUDGE_TOOLS: string[] = [];

/** Pure, so the "no tools, cheapest mount" contract is unit-testable without a spawn. */
export function buildVerifyHumanJudgeSpawnArgs(opts: {
  shard: ShardUnderJudgement;
  mount: Mount;
  cwd: string;
  settingsFile: string;
}): SpawnWorkerArgs {
  return {
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    prompt: buildVerifyHumanJudgePrompt(opts.shard),
    model: opts.mount.model,
    effort: opts.mount.effort,
    maxTurns: opts.mount.maxTurns,
    tools: VERIFY_HUMAN_JUDGE_TOOLS,
  };
}

/** Spawn and parse. Untested by unit (it shells out via the SDK); the two pure functions above
 *  carry the contract. */
export async function spawnVerifyHumanJudgeWorker(opts: {
  shard: ShardUnderJudgement;
  mount: Mount;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): Promise<WorkerResult> {
  const spawn = opts.spawn ?? spawnWorker;
  return spawn(buildVerifyHumanJudgeSpawnArgs(opts));
}

/** A `judge` wired to a real spawn on the CHEAPEST configured mount. Reuses
 *  `resolveRiskJudgeMount` rather than re-deriving the same routing-table walk: that resolver is
 *  generic, never risk-specific, despite its name. */
export function realVerifyHumanJudge(opts: {
  mounts: Mounts;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): (shard: ShardUnderJudgement) => Promise<VerifyHumanVerdict> {
  const mount = resolveRiskJudgeMount(opts.mounts);
  return async (shard: ShardUnderJudgement) => {
    const result = await spawnVerifyHumanJudgeWorker({
      shard, mount, cwd: opts.cwd, settingsFile: opts.settingsFile, spawn: opts.spawn,
    });
    return parseVerifyHumanVerdict(result.text);
  };
}
