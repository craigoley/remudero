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
import { canonicalWorkerProviderId, enabledWorkerProviders, type Config, type WorkerProviderId } from "./config.js";
import { resolveRiskJudgeMount } from "./risk-judge.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";

/** What the judge decides for ONE parked shard. None of the values edits or releases a task. */
export type VerifyHumanDecision = "needs_operator" | "automate" | "backlog";

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
  /**
   * THE SHARD'S OWN EVIDENCE, when it carries any. A machine-filed shard cites a corpus in its
   * title ("THE ci-gate GATE REFUSED 36 PULL REQUESTS IN THIS WINDOW") and records the corpus in
   * its record — `ci_learning_prs` on all 42 CI-learning shards — but NONE of them carries a
   * `rationale`, and `rationale` was the only free text this projection passed. So the judge was
   * shown a claim about 36 pull requests and no pull requests, and refused it for exactly that:
   * "references '36 PULL REQUESTS IN THIS WINDOW' without providing the PR list". The refusal was
   * CORRECT ON ITS INPUT; the input was impoverished.
   *
   * BOUNDED ON PURPOSE. These records carry a `note` running to a hundred-plus file paths from a
   * single repair, and pasting it whole would bury the signal it is supposed to supply. Only a
   * summary reaches the judge — see `shardEvidence`. Absent stays ABSENT: a shard with no evidence
   * must look different from one whose evidence was withheld, or this field re-creates the defect
   * it exists to close.
   */
  evidence?: string;
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

const VALID_DECISIONS = new Set<VerifyHumanDecision>(["needs_operator", "automate", "backlog"]);

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
    `WHAT YOU ARE DECIDING, and it is narrow: whether this shard needs the operator, can enter the`,
    `self-improvement flow, or should stay in the visible backlog for now. You are NOT deciding`,
    `whether the work is right, whether it should be done, or whether it can be closed.`,
    `You cannot close it. Nothing you say edits the plan.`,
    ``,
    `SIGNALS THAT IT PROBABLY STILL NEEDS HIM: a genuine judgement call only he can make (his own`,
    `priorities, budget, risk appetite, or intent); a decision that would set policy; something`,
    `time-sensitive; an ask whose answer unblocks other work.`,
    ``,
    `SIGNALS THAT IT PROBABLY DOES NOT NEED THE OPERATOR: its dependencies have not merged, so the`,
    `question cannot even be asked properly; the work appears already done elsewhere; it asks for`,
    `a review of something that has since changed; it is a preference an agent could reasonably`,
    `settle and record itself. Choose automate only when the existing self-improvement flow can take`,
    `the next step without a policy, budget, security, merge, or tenant-isolation decision.`,
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
    ...(shard.evidence ? [``, `EVIDENCE THE RECORD ITSELF CARRIES:`, shard.evidence] : []),
    ``,
    `Decide — exactly one of:`,
    `  needs_operator — put this in front of him; it is a real ask`,
    `  automate      — stage it for the existing self-improvement flow; do not release the task`,
    `  backlog       — it can wait in the visible backlog; it is not an ask today`,
    ``,
    `MACHINE-READABLE OUTPUT (required, in addition to any prose): emit exactly one of each of`,
    `these lines, and nothing else on the line:`,
    `  VERIFY_HUMAN_DECISION: <needs_operator|automate|backlog>`,
    `  VERIFY_HUMAN_REASON: <one concrete, specific reason naming THIS shard's own facts>`,
  ].join("\n");
}

/** Parse the judge's two lines. Anything unreadable fails OPEN
 *  ({@link FAIL_OPEN_VERIFY_HUMAN_VERDICT} — `needs_operator`, and marked as a default). */
/** Markdown and quoting a model wraps a labelled value in: `**bold**`, `` `code` ``, "quotes".
 *  Stripped from BOTH sides of the label's colon before the value is read. This is presentation,
 *  never meaning — the decision itself is still matched against {@link VALID_DECISIONS} below, so
 *  widening what the DECORATION may look like never widens what a decision may SAY. */
const LABEL_DECORATION = "[*_`\"'\\s]*";

function labelledValue(text: string, label: string): string | undefined {
  // The label may itself be emphasised (`**LABEL:**`), and so may the value (`**automate**`).
  const re = new RegExp(`${LABEL_DECORATION}${label}${LABEL_DECORATION}:${LABEL_DECORATION}([^\n]*)`, "i");
  return re.exec(text)?.[1];
}

/**
 * Parse the judge's two lines. Anything unreadable fails OPEN
 * ({@link FAIL_OPEN_VERIFY_HUMAN_VERDICT} — `needs_operator`, and marked as a default).
 *
 * TOLERANT OF DECORATION, STRICT ABOUT MEANING. The previous pattern required a word character
 * immediately after the colon, so every markdown-emphasised rendering failed open. MEASURED: 5 of
 * 6 realistic shapes failed (`**LABEL:** automate`, `LABEL: **automate**`, backticked, quoted),
 * while the same model's prose in the very same reply uses bold headings. On the fleet that read
 * as "no parseable VERIFY_HUMAN_DECISION" — a PARSE failure recorded as an operator decision.
 *
 * FAILING OPEN IS UNTOUCHED: an unreadable verdict must never auto-release. The defect was never
 * the fallback, it was how often an ANSWERED verdict reached it.
 */
export function parseVerifyHumanVerdict(text: string): VerifyHumanVerdict {
  const raw = labelledValue(text, "VERIFY_HUMAN_DECISION");
  // Take the first bare word of the captured value: `automate**` and `automate` both yield
  // `automate`, while a sentence yields its first word and is then refused by VALID_DECISIONS.
  const decision = /([a-z_]+)/i.exec(raw ?? "")?.[1]?.toLowerCase() as VerifyHumanDecision | undefined;
  // W1-T3916: judge fallback still fails open on an unusable verdict
  if (!decision || !VALID_DECISIONS.has(decision)) return { ...FAIL_OPEN_VERIFY_HUMAN_VERDICT };
  const reason = labelledValue(text, "VERIFY_HUMAN_REASON")
    ?.replace(/[*`_"']+\s*$/, "")
    .trim();
  return { decision, reason: reason || "(no reason stated)" };
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

/** Distinct from the operator-facing proposal so a route change updates state rather than
 *  duplicating or conflating two different next actions. */
export function verifyHumanAutomationProposalId(shard: ShardUnderJudgement): string {
  return `verify-human-automate:${shard.id}`;
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

/** An `automate` verdict enters the existing inbox/draft self-improvement flow. It is deliberately
 *  a proposal, not a release: the normal draft, PR, review and merge path still owns every write. */
export function automationProposalFromJudgedShard(shard: ShardUnderJudgement, verdict: VerifyHumanVerdict): Proposal {
  return {
    id: verifyHumanAutomationProposalId(shard),
    summary:
      `${shard.id} was filed \`verify: human\` ${shard.ageDays} days ago and a judge reads it as ` +
      `safe to enter the self-improvement flow:\n  ${verdict.reason}\n\n` +
      `${shard.title}\n\n` +
      `Dependencies all merged: ${shard.depsAllMerged ? "yes" : "no"}. ` +
      `Cited in src/: ${shard.citedInSrc ? "yes" : "no"}.\n\n` +
      `This is an automation candidate only. The existing inbox/draft flow owns the next step; ` +
      `the shard, plan records, release rows, and merge gates remain unchanged.`,
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
    ...(opts.mount.provider === undefined ? {} : { mountProvider: opts.mount.provider }),
  };
}

/** Spawn and parse. The `spawn` seam is injectable precisely so this IS unit-reachable: the note
 *  here used to read "untested by unit (it shells out via the SDK)", and diff-coverage answered by
 *  naming all 20 lines of this function and {@link realVerifyHumanJudge} as added and uncovered.
 *  A recorder drives both with no subprocess, exactly as risk-judge.ts's own pair is driven. */
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

/** Resolve the read-only judge mount against the providers this host actually enables. A
 * host-local provider mismatch is stale routing metadata, not a reason to turn an automated sweep
 * into a permanent operator queue. Removing only the unavailable affinity lets the existing
 * worker router choose from already-enabled providers. Explicitly enabled providers remain
 * mount-affine, including the paid cash lane. */
// W1-T3916: explicitly enabled cash keeps its configured mount affinity
export function resolveVerifyHumanJudgeMount(
  mounts: Mounts,
  config?: Pick<Config, "workerProviders">,
): Mount {
  const mount = mounts.verify_human_judge ?? resolveRiskJudgeMount(mounts);
  if (config === undefined || mount.provider === undefined) return mount;
  const provider = canonicalWorkerProviderId(mount.provider) as WorkerProviderId;
  if (enabledWorkerProviders(config).includes(provider)) return mount;
  return { ...mount, provider: undefined };
}

/** A `judge` wired to a real spawn on the CHEAPEST configured mount. Reuses
 *  `resolveRiskJudgeMount` rather than re-deriving the same routing-table walk: that resolver is
 *  generic, never risk-specific, despite its name. */
export function realVerifyHumanJudge(opts: {
  mounts: Mounts;
  config?: Pick<Config, "workerProviders">;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): (shard: ShardUnderJudgement) => Promise<VerifyHumanVerdict> {
  const mount = resolveVerifyHumanJudgeMount(opts.mounts, opts.config);
  return async (shard: ShardUnderJudgement) => {
    const result = await spawnVerifyHumanJudgeWorker({
      shard, mount, cwd: opts.cwd, settingsFile: opts.settingsFile, spawn: opts.spawn,
    });
    return parseVerifyHumanVerdict(result.text);
  };
}


export type VerifyHumanReleaseOutcome =
  | { kind: "released"; reason: string }
  | { kind: "escalated"; reason: string }
  | { kind: "unavailable"; reason: string };

export type VerifyHumanReleaseHook = (
  shard: ShardUnderJudgement,
  verdict: VerifyHumanVerdict,
) => Promise<VerifyHumanReleaseOutcome>;

export const VERIFY_HUMAN_RELEASE_ESCALATED_STEP = "verify_human.release_escalated";
export const VERIFY_HUMAN_RELEASE_UNAVAILABLE_STEP = "verify_human.release_unavailable";

export function releaseEscalatedKeys(rows: readonly Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (row?.step !== VERIFY_HUMAN_RELEASE_ESCALATED_STEP) continue;
    if (typeof row.observed_state === "string" && row.observed_state) out.add(row.observed_state);
  }
  return out;
}

export function awaitingRelease(
  shards: readonly ShardUnderJudgement[],
  priorVerdicts: ReadonlyMap<string, VerifyHumanVerdict>,
  releasedIds: ReadonlySet<string>,
  escalatedKeys: ReadonlySet<string>,
): ShardUnderJudgement[] {
  return shards.filter((shard) => {
    if (releasedIds.has(shard.id)) return false;
    const key = observedStateKey(shard);
    const prior = priorVerdicts.get(key);
    return prior?.decision === "automate" && !prior.judgeFailed && !escalatedKeys.has(key);
  });
}

export interface ApplyAutomateHooks {
  release?: VerifyHumanReleaseHook;
  stageProposal: (proposal: Proposal) => void;
  appendRow: (row: Record<string, unknown>) => void;
  runId: string;
}

export async function applyAutomateVerdict(
  shard: ShardUnderJudgement,
  verdict: VerifyHumanVerdict,
  hooks: ApplyAutomateHooks,
): Promise<"released" | "needsOperator" | "automated"> {
  if (!hooks.release) {
    hooks.stageProposal(automationProposalFromJudgedShard(shard, verdict));
    return "automated";
  }
  const outcome = await hooks.release(shard, verdict);
  if (outcome.kind === "released") return "released";
  if (outcome.kind === "escalated") {
    hooks.appendRow({
      run_id: hooks.runId,
      task_id: shard.id,
      step: VERIFY_HUMAN_RELEASE_ESCALATED_STEP,
      observed_state: observedStateKey(shard),
      reason: outcome.reason,
    });
    hooks.stageProposal(
      proposalFromJudgedShard(shard, { decision: "needs_operator", reason: `the risk judge escalated this release: ${outcome.reason}` }),
    );
    return "needsOperator";
  }
  hooks.appendRow({
    run_id: hooks.runId,
    task_id: shard.id,
    step: VERIFY_HUMAN_RELEASE_UNAVAILABLE_STEP,
    observed_state: observedStateKey(shard),
    reason: outcome.reason,
  });
  hooks.stageProposal(automationProposalFromJudgedShard(shard, verdict));
  return "automated";
}
