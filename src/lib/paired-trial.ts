/**
 * lib/paired-trial.ts — W1-T4625: the paired design of the approved paid pilot (W1-T4603). An eligible task,
 * sampled by a seeded draw at the point normal dispatch admits it, runs two EXTRA isolated side attempts, one
 * per arm, in a seeded order; both heads are graded by the task's own proofs and holdouts through the
 * reviewer's executor, and the pair is analysed with paired (McNemar) statistics.
 *
 * INVARIANT: inert by default. With no active paired protocol nothing is read, logged or spawned.
 * INVARIANT: normal dispatch never changes. The trial takes the task by value, returns nothing a caller
 * routes on, and its attempts go through their own seam: never the normal spawn, never a pushed branch or
 * a PR, never review or merge. Only the normal dispatch path produces a merged change.
 * INVARIANT: spend is bounded. Shadow records decisions and never spawns; paid attempts run one pair at a
 * time, and paid-arm admission is re-read immediately before every paid spawn. A pair that cannot be graded
 * on either side is unmeasurable, never a win or a loss for either arm.
 */

import { spawnSync, type execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { exactBinomialHalfPValue } from "./benchmark-aa.js";
import { activePaidPilotProtocols, PAIRED_TRIAL_STEPS, pairedSampleDraw, paidPilotArmAdmission, paidPilotArmFor,
  readPaidPilotControls, readPaidPilotEvidence, summarizePaidPilotSpend, type PaidPilotArm, type PaidPilotControlState,
  type PaidPilotEvidence, type PaidPilotProtocol, type PaidPilotRow, type PaidPilotSpend, type PairedPilotReportView } from "./benchmark-paid-pilot.js";
import { benchmarkNonDispatchSpawn, benchmarkRunAssignmentReceipt, type BenchmarkStackEvidence } from "./benchmark-run.js";
import { systemClock, type Clock } from "./clock.js";
import type { Config } from "./config.js";
import type { WorkerProviderId } from "./config-schema.js";
import { billingMode } from "./env.js";
import { buildEvalCard, normalQuantile, type EvalCard, type EvalCardEvidence } from "./eval-card.js";
import { scoreCorpusReplay, type CorpusProofOutcome } from "./golden-corpus.js";
import { resolveInstallRoot } from "./install-root.js";
import type { AcceptanceCriterion, Task } from "./plan.js";
import { renderImplementPrompt } from "./prompt-render.js";
import { ensureDeps, execWhitelistedProof, parseWhitelistedProof, registerReviewerCheckout, type ProofExecutor } from "./review.js";
import { validateWorkerSettingsFile } from "./settings.js";
import { renderWorkerSettings, spawnWorker, worktreeRemove } from "./worker.js";

export const PAIRED_PILOT_REPORT_VERSION = "benchmark-paired-pilot-v1" as const;
const PAIRED_ALPHA = 0.05;

/** The seeded attempt order: the W1-T4603 draw names the arm that runs first, so it is stable per task. */
export function pairedAttemptOrder(protocol: Pick<PaidPilotProtocol, "assignment">, taskId: string): [PaidPilotArm, PaidPilotArm] {
  return paidPilotArmFor(protocol.assignment.seed, taskId) === "paid" ? ["paid", "control"] : ["control", "paid"];
}

export function pairIdFor(pilotId: string, taskId: string): string {
  return `pair-${createHash("sha256").update(`${pilotId}\0${taskId}`).digest("hex").slice(0, 16)}`;
}

/** A side attempt's stack evidence: prompt, tool, scorer and environment from the protocol's trial manifest,
 *  the harness as this process executes it. */
export function pairedStackEvidence(protocol: Pick<PaidPilotProtocol, "revisions">,
  harness: BenchmarkStackEvidence["harnessRevision"]): BenchmarkStackEvidence {
  const manifest = (revision: string) => ({ source: "trial-manifest" as const, revision });
  return { harnessRevision: harness, promptRevision: manifest(protocol.revisions.promptRevision),
    toolRevision: manifest(protocol.revisions.toolRevision), scorerRevision: manifest(protocol.revisions.scorerRevision),
    environmentRevision: manifest(protocol.revisions.environmentRevision) };
}

/** What one side attempt is asked to do: its own pinned arm, the pilot's pinned revisions, and no way out.
 *  `Arm` is a pilot arm, or an A/A label (W1-T4647): both arms of an A/A pin the one stack. */
export interface PairedAttemptRequest<Arm extends string = PaidPilotArm> {
  pilotId: string;
  pairId: string;
  taskId: string;
  arm: Arm;
  position: 0 | 1;
  pin: PaidPilotProtocol["arms"][PaidPilotArm];
  revisions: PaidPilotProtocol["revisions"];
  /** The contract a dispatcher must keep: a fresh detached worktree, nothing pushed, no PR, nothing merged. */
  isolation: { worktree: "fresh-detached"; push: false; openPr: false; merge: false };
  /** The pins the dispatcher passes into the attempt's own worker assignment receipt. */
  stackEvidence: BenchmarkStackEvidence;
}

/** What a side attempt returns. `headDir` is the local head to grade; null when the attempt produced none. */
export interface PairedAttemptResult {
  headDir: string | null;
  headSha: string | null;
  servedModel: string | null;
  billingMode: "api" | "subscription" | null;
  costUsd: number | null;
  /** Any value here is an isolation breach: the attempt left the sandbox, so the pair is unmeasurable. */
  pushedRef?: string | null;
  prUrl?: string | null;
  /** A named breach of any other kind: a fleet-branch write, or isolation the dispatcher could not verify. */
  breach?: string | null;
  cleanup?: () => void;
}

export type PairedAttemptDispatch<Arm extends string = PaidPilotArm> = (request: PairedAttemptRequest<Arm>) => Promise<PairedAttemptResult>;

function criterionOutcome(criterion: AcceptanceCriterion, headDir: string, exec: ProofExecutor): { outcome: CorpusProofOutcome; reason: string } {
  const whitelisted = parseWhitelistedProof(criterion.proof);
  if (whitelisted === null) return { outcome: "unmeasurable", reason: "proof-not-executable" };
  try {
    const verdict = exec(whitelisted, headDir);
    return verdict === "no-match" ? { outcome: "unmeasurable", reason: "named-test-not-found" } : { outcome: verdict, reason: `executed-${verdict}` };
  } catch {
    const reason = "proof-reached-no-verdict";
    return { outcome: "unmeasurable", reason };
  }
}

/** One head's grade: {@link scoreCorpusReplay}'s rule — any fail fails, any unmeasurable is unmeasurable, all pass passes. */
export interface PairedGrade {
  verdict: CorpusProofOutcome;
  passed: number;
  failed: number;
  unmeasurable: number;
  holdouts: number;
  reasons: string[];
}

/** The production grader: every visible and holdout criterion through the reviewer's own parser and executor. */
export function gradeHeadWithReviewerExecutor(criteria: readonly AcceptanceCriterion[], headDir: string,
  exec: ProofExecutor = execWhitelistedProof): PairedGrade {
  const graded = criteria.map((criterion) => criterionOutcome(criterion, headDir, exec));
  const score = scoreCorpusReplay({ proofs: criteria.map((criterion) => ({ claim: criterion.claim, proof: criterion.proof,
    holdout: criterion.holdout === true })) }, graded.map((entry) => entry.outcome));
  return { ...score, holdouts: criteria.filter((criterion) => criterion.holdout === true).length, reasons: graded.map((entry) => entry.reason) };
}

export type PairedGrader = (input: { taskId: string; headDir: string; criteria: readonly AcceptanceCriterion[] }) => PairedGrade | Promise<PairedGrade>;

/** The trial's input. Every optional field defaults to the production path; nothing here reads config. */
export interface PairedTrialInput {
  task: { id: string; acceptance?: readonly AcceptanceCriterion[] };
  lane: string;
  stateDir: string;
  log: (step: string, fields: Record<string, unknown>) => void;
  clock?: Clock;
  /** The executing harness revision (run-task's module-load attestation); absent reads as unpinned. */
  harnessRevision?: BenchmarkStackEvidence["harnessRevision"];
  protocols?: (stateDir: string, nowIso: string) => PaidPilotProtocol[];
  readEvidence?: (stateDir: string, protocol: PaidPilotProtocol) => Promise<PaidPilotEvidence>;
  readControls?: (stateDir: string, pilotId: string) => PaidPilotControlState;
  /** Absent: a live pair is refused by name, `dispatchRefusal` when the caller gave one. */
  dispatchAttempt?: PairedAttemptDispatch;
  dispatchRefusal?: string;
  grade?: PairedGrader;
  /** Observational only: reports how the side trial ended. Nothing in normal dispatch reads it. */
  settled?: (result: PairedTrialResult) => void;
}

function safeLog(log: PairedTrialInput["log"], step: string, fields: Record<string, unknown>): boolean {
  try { log(step, fields); return true; }
  catch {
    const reason = "paired-trial-ledger-write-failed";
    console.error(JSON.stringify({ event: "paired_trial.ledger_unavailable", reason, step }));
    return false;
  }
}

export type PairedTrialResult =
  | { state: "inert" }
  | { state: "not-eligible"; pilotId: string }
  | { state: "not-sampled" | "shadow" | "refused"; pilotId: string; pairId: string; order: PaidPilotArm[]; reasons: string[] }
  | { state: "measured" | "unmeasurable"; pilotId: string; pairId: string; order: PaidPilotArm[]; reasons: string[];
    outcomes: Record<PaidPilotArm, CorpusProofOutcome | "not-run">; merged: false };

/** A live protocol wins over a shadow one; an unpaired protocol never pairs. */
function selectPairedProtocol(protocols: readonly PaidPilotProtocol[]): PaidPilotProtocol | null {
  const paired = protocols.filter((protocol) => protocol.design === "paired" && protocol.paired !== null);
  return paired.find((protocol) => protocol.paired!.shadow === false) ?? paired[0] ?? null;
}

/** Tasks this pilot already admitted into a pair; a retried dispatch never pairs a task twice. */
function admittedPairTasks(rows: readonly PaidPilotRow[]): Set<string> {
  return new Set(rows.filter((row) => row.step === PAIRED_TRIAL_STEPS.decision && row.paired?.admitted === true).map((row) => row.taskId));
}

/** One process runs at most one live pair; across processes an unreceipted paid spawn marker pauses admission. */
let pairInFlight = false;

/** The one live-pair slot, shared by the paid pilot and the prospective A/A (W1-T4647): the release, or null when held. */
export function claimPairSlot(): (() => void) | null {
  if (pairInFlight) return null;
  pairInFlight = true;
  return () => { pairInFlight = false; };
}

type TrialContext = { input: PairedTrialInput; protocol: PaidPilotProtocol; nowIso: string; pairId: string; order: [PaidPilotArm, PaidPilotArm] };

async function paidAdmissionReasons(context: TrialContext): Promise<string[]> {
  const { input, protocol } = context;
  const evidence = await (input.readEvidence ?? readPaidPilotEvidence)(input.stateDir, protocol);
  const controls = (input.readControls ?? readPaidPilotControls)(input.stateDir, protocol.pilotId);
  const nowIso = (input.clock ?? systemClock).iso();
  const admission = paidPilotArmAdmission({ protocol, lane: input.lane, taskId: input.task.id, nowIso, evidence, controls });
  return admission.paidArm === "admitted" ? [] : admission.reasons.length > 0 ? admission.reasons : [`paid-arm-${admission.paidArm}`];
}

async function sampledReasons(context: TrialContext, claimed: boolean): Promise<string[]> {
  const { input, protocol } = context;
  const evidence = await (input.readEvidence ?? readPaidPilotEvidence)(input.stateDir, protocol);
  const controls = (input.readControls ?? readPaidPilotControls)(input.stateDir, protocol.pilotId);
  const admission = paidPilotArmAdmission({ protocol, lane: input.lane, taskId: input.task.id, nowIso: context.nowIso, evidence, controls });
  const reasons = admission.paidArm === "admitted" ? [] : [...admission.reasons];
  const admitted = admittedPairTasks(evidence.rows);
  if (admitted.has(input.task.id)) reasons.push("task-already-paired");
  if (admitted.size >= protocol.paired!.maxPairs) reasons.push("pair-cap-reached");
  if (!protocol.paired!.shadow && !claimed) reasons.push("pair-in-flight");
  if (!protocol.paired!.shadow && input.dispatchAttempt === undefined) reasons.push(input.dispatchRefusal ?? "attempt-dispatch-not-wired");
  return reasons;
}

function pinnedWork(protocol: PaidPilotProtocol, taskId: string): { taskClass?: string; risk?: string } {
  const task = protocol.population.find((entry) => entry.taskId === taskId);
  return task === undefined ? {} : { taskClass: task.taskClass, risk: task.risk };
}

/** A harness the process executes off the protocol's pin is a stack deviation: recorded on every row, never hidden. */
function harnessDeviations(protocol: PaidPilotProtocol, executing: { state: string; value?: string }): string[] {
  if (executing.state !== "observed") return ["harnessRevision:unpinned"];
  return executing.value === protocol.revisions.harnessRevision ? [] : [`harnessRevision:executing-${executing.value}-pinned-${protocol.revisions.harnessRevision}`];
}

async function runAttempt(context: TrialContext, arm: PaidPilotArm, position: 0 | 1,
  dispatch: PairedAttemptDispatch): Promise<{ outcome: CorpusProofOutcome; reasons: string[]; deviations: string[] }> {
  const { input, protocol, pairId } = context;
  const pin = protocol.arms[arm];
  const stackEvidence = pairedStackEvidence(protocol, input.harnessRevision);
  const receipt = benchmarkRunAssignmentReceipt({ id: `${pairId}:${arm}`, requested: { model: pin.model, effort: pin.effort },
    selected: { provider: pin.provider, model: pin.model, effort: pin.effort } }, pinnedWork(protocol, input.task.id), stackEvidence);
  const deviations = harnessDeviations(protocol, receipt.stack.harnessRevision);
  const base = { pilot_id: protocol.pilotId, pair_id: pairId, arm, position, stack_deviations: deviations };
  if (!safeLog(input.log, PAIRED_TRIAL_STEPS.spawn, { paired_trial: base, benchmark_run: { ...receipt,
    allocation: { method: "paired-order", experimentId: protocol.pilotId, arm, position } } }))
    return { outcome: "unmeasurable", reasons: [`spawn-marker-not-recorded:${arm}`], deviations };
  const reasons: string[] = [];
  let attempt: PairedAttemptResult | null = null;
  try {
    attempt = await dispatch({ pilotId: protocol.pilotId, pairId, taskId: input.task.id, arm, position, pin: protocol.arms[arm],
      revisions: protocol.revisions, isolation: { worktree: "fresh-detached", push: false, openPr: false, merge: false }, stackEvidence });
  } catch {
    const reason = `attempt-failed:${arm}`;
    reasons.push(reason);
  }
  let grade: PairedGrade | null = null;
  if (attempt !== null && (attempt.pushedRef || attempt.prUrl || attempt.breach)) reasons.push(`isolation-breach:${arm}`);
  else if (attempt !== null && attempt.headDir !== null) {
    try { grade = await (input.grade ?? ((req) => gradeHeadWithReviewerExecutor(req.criteria, req.headDir)))({ taskId: input.task.id,
      headDir: attempt.headDir, criteria: input.task.acceptance ?? [] }); }
    catch {
      const reason = `grading-failed:${arm}`;
      reasons.push(reason);
    }
  } else if (attempt !== null) reasons.push(`no-head:${arm}`);
  const outcome: CorpusProofOutcome = reasons.length === 0 && grade !== null ? grade.verdict : "unmeasurable";
  if (outcome === "unmeasurable" && grade !== null) reasons.push(`ungradeable:${arm}`);
  safeLog(input.log, PAIRED_TRIAL_STEPS.attempt, { paired_trial: { ...base, outcome, reasons, head_sha: attempt?.headSha ?? null,
    isolation_breach: attempt?.pushedRef || attempt?.prUrl || attempt?.breach || null,
    grade: grade === null ? null : { passed: grade.passed, failed: grade.failed, unmeasurable: grade.unmeasurable, holdouts: grade.holdouts } },
    served_model: attempt?.servedModel ?? null, billing_mode: attempt?.billingMode ?? null, total_cost_usd: attempt?.costUsd ?? null });
  try { attempt?.cleanup?.(); }
  catch {
    const reason = `cleanup-failed:${arm}`;
    reasons.push(reason);
  }
  return { outcome, reasons, deviations };
}

async function runPair(context: TrialContext, dispatch: PairedAttemptDispatch): Promise<PairedTrialResult> {
  const { input, protocol, pairId, order } = context;
  const outcomes: Record<PaidPilotArm, CorpusProofOutcome | "not-run"> = { paid: "not-run", control: "not-run" };
  const reasons: string[] = [];
  const deviations = new Set<string>();
  for (const [position, arm] of order.entries()) {
    if (arm === "paid") {
      const held = await paidAdmissionReasons(context);
      if (held.length > 0) { reasons.push(`paid-admission-lost:${held.join("+")}`); break; }
    }
    const attempt = await runAttempt(context, arm, position as 0 | 1, dispatch);
    outcomes[arm] = attempt.outcome;
    reasons.push(...attempt.reasons);
    for (const deviation of attempt.deviations) deviations.add(deviation);
    if (attempt.outcome === "unmeasurable") { reasons.push("stopped-after-an-unmeasurable-attempt"); break; }
  }
  const measured = outcomes.paid !== "not-run" && outcomes.paid !== "unmeasurable" && outcomes.control !== "not-run" && outcomes.control !== "unmeasurable";
  const state = measured ? "measured" as const : "unmeasurable" as const;
  safeLog(input.log, PAIRED_TRIAL_STEPS.pair, { paired_trial: { pilot_id: protocol.pilotId, pair_id: pairId, order, outcomes,
    status: state, reasons, stack_deviations: [...deviations], merged: false, pr_opened: false } });
  return { state, pilotId: protocol.pilotId, pairId, order, reasons, outcomes, merged: false };
}

async function pairedTrial(input: PairedTrialInput, claim: () => boolean): Promise<PairedTrialResult> {
  const nowIso = (input.clock ?? systemClock).iso();
  const protocol = selectPairedProtocol((input.protocols ?? activePaidPilotProtocols)(input.stateDir, nowIso));
  if (protocol === null) return { state: "inert" };
  if (input.lane !== "implement" || !protocol.population.some((task) => task.taskId === input.task.id))
    return { state: "not-eligible", pilotId: protocol.pilotId };
  const context: TrialContext = { input, protocol, nowIso, pairId: pairIdFor(protocol.pilotId, input.task.id),
    order: pairedAttemptOrder(protocol, input.task.id) };
  const draw = pairedSampleDraw(protocol.assignment.seed, input.task.id);
  const shadow = protocol.paired!.shadow;
  const sampled = draw < protocol.paired!.samplingRate;
  const reasons = sampled ? await sampledReasons(context, shadow || claim()) : ["not-sampled"];
  const admitted = sampled && reasons.length === 0;
  const recorded = safeLog(input.log, PAIRED_TRIAL_STEPS.decision, { paired_trial: { pilot_id: protocol.pilotId, pair_id: context.pairId,
    shadow, sampled, admitted, order: context.order, reasons },
  randomization: { unit: "task", seed_hash: protocol.assignment.seedHash, draw, sampling_rate: protocol.paired!.samplingRate,
    sample_method: protocol.paired!.sampleMethod, order_method: protocol.assignment.method } });
  const outcome = { pilotId: protocol.pilotId, pairId: context.pairId, order: context.order };
  if (shadow) return { state: "shadow", ...outcome, reasons };
  if (!sampled) return { state: "not-sampled", ...outcome, reasons };
  if (!admitted || !recorded) return { state: "refused", ...outcome, reasons: recorded ? reasons : [...reasons, "decision-not-recorded"] };
  return runPair(context, input.dispatchAttempt!);
}

/**
 * The side trial at normal dispatch admission. Never throws and never rejects; a caller fires it and forgets
 * it, so nothing it does or fails to do can reach the normal dispatch that admitted the task.
 */
export async function runPairedTrial(input: PairedTrialInput): Promise<PairedTrialResult> {
  const slot: { release: (() => void) | null } = { release: null };
  const claim = (): boolean => {
    slot.release = claimPairSlot();
    return slot.release !== null;
  };
  let result: PairedTrialResult;
  try { result = await pairedTrial(input, claim); }
  catch {
    const reason = "paired-trial-failed";
    safeLog(input.log, "paired_trial.error", { reason });
    result = { state: "refused", pilotId: "unknown", pairId: "unknown", order: [], reasons: [reason] };
  } finally {
    slot.release?.();
  }
  try { input.settled?.(result); }
  catch {
    const reason = "settled-observer-failed";
    console.error(JSON.stringify({ event: "paired_trial.observer_unavailable", reason }));
  }
  return result;
}

/** Every pair a CLI process is asked to run: it can exit before its fire-and-forget pair settles, so only the daemon runs one. */
export const PAIRED_CLI_REFUSAL = "pair-needs-the-daemon";

/**
 * BACKSTOP (W1-T4638): the most one sealed side attempt may spend under its own SDK budget. The primary control is the
 * pilot's cash ceiling, re-read before every paid spawn (`paidArmPauseReasons`); this bounds how far one attempt can
 * overshoot it, since a task's own budget defaults far above the whole pilot's.
 */
export const PAIRED_ATTEMPT_MAX_BUDGET_USD = 15;

/** A pull-request url anywhere in a worker's own words. */
export const PAIRED_PR_URL_RE = /https?:\/\/[^\s)>\]]+\/pull\/\d+/;

/** Where sealed attempts are cut: beside the fleet's worktrees root, never inside it, so no run reaper walks them. */
export function pairedAttemptRoot(root: string): string {
  return join(root, "paired-attempts");
}

/** The contract a sealed attempt's prompt ends with. It is advice; {@link probeSealedIsolation} is the check. */
export const SEALED_ATTEMPT_CONTRACT_LINES: readonly string[] = [
  "# SEALED SIDE ATTEMPT (this section overrides every push, pull request and branch instruction above)",
  "- This checkout is a DETACHED worktree for a measurement attempt. Nothing you do here is pushed or merged.",
  "- Commit your change locally with `git commit`, or leave it saved (the harness commits what is left), then STOP.",
  "- Do NOT `git push`, do NOT open a pull request, and do NOT create, rename or switch to any branch:",
  "  any of those is an isolation breach and voids the attempt.",
  "- End with a REPORT. Write no PR_URL line.",
];

/** `git` in `dir`: trimmed stdout, or null on a non-zero exit. Never throws on a refusal. */
function gitProbe(dir: string, args: readonly string[]): string | null {
  const run = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return run.status === 0 ? run.stdout.trim() : null;
}

function gitOut(dir: string, args: readonly string[]): string {
  const out = gitProbe(dir, args);
  if (out === null) throw new Error(`sealed paired attempt: git ${args.join(" ")} failed in ${dir}`);
  return out;
}

/** `<sha> <ref>` lines, from for-each-ref or ls-remote alike. */
function refPairs(text: string | null): [string, string][] {
  return (text ?? "").split("\n").map((line) => line.trim().split(/\s+/)).filter((cols) => cols.length === 2)
    .map(([sha, ref]) => [sha!, ref!]);
}

/** What the isolation probe reads once the worker returns. */
export interface SealedProbeInput {
  repoDir: string;
  dir: string;
  base: string;
  text: string;
}

export interface SealedIsolationReading {
  pushedRef: string | null;
  prUrl: string | null;
  breach: string | null;
}

/**
 * The production isolation check, which trusts nothing the worker says about itself. The attempt's commits are every
 * sha its detached HEAD visited (reflog and `base..HEAD`) that `base` does not already contain; a remote ref or a
 * remote-tracking ref carrying one is a push, a local branch carrying one (or a HEAD that is no longer detached) is a
 * fleet-branch write, and a remote that cannot be read is isolation this probe could not verify.
 */
export function probeSealedIsolation(input: SealedProbeInput): SealedIsolationReading {
  const prUrl = PAIRED_PR_URL_RE.exec(input.text)?.[0] ?? null;
  const visited = [...(gitProbe(input.dir, ["reflog", "--format=%H", "HEAD"]) ?? "").split("\n"),
    ...(gitProbe(input.dir, ["rev-list", `${input.base}..HEAD`]) ?? "").split("\n")];
  const commits = new Set([...new Set(visited)].filter((sha) => sha !== "" && sha !== input.base
    && gitProbe(input.dir, ["merge-base", "--is-ancestor", sha, input.base]) === null));
  const local = refPairs(gitProbe(input.repoDir, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes"]));
  const remote = gitProbe(input.repoDir, ["ls-remote", "origin"]);
  const pushed = refPairs(remote).find(([sha]) => commits.has(sha))
    ?? local.find(([sha, ref]) => ref.startsWith("refs/remotes/") && commits.has(sha));
  const branch = gitProbe(input.dir, ["symbolic-ref", "-q", "HEAD"])
    ?? local.find(([sha, ref]) => ref.startsWith("refs/heads/") && commits.has(sha))?.[1] ?? null;
  const breach = branch !== null ? `branch-write:${branch}` : remote === null ? "isolation-unverified:remote-unreadable" : null;
  return { pushedRef: pushed?.[1] ?? null, prUrl, breach };
}

/** A raw detached `git worktree add` at the pair's own base: no branch is ever named, so none can be credited. */
function cutSealedAttemptTree(repoDir: string, dir: string, base: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  gitOut(repoDir, ["worktree", "add", "--detach", dir, base]);
}

/** Commit whatever the worker left unsaved, locally and under a fixed identity, so the graded head has a sha. */
function commitSealedEdits(dir: string): void {
  gitOut(dir, ["add", "-A"]);
  if (gitOut(dir, ["status", "--porcelain"]) === "") return;
  gitOut(dir, ["-c", "user.name=remudero paired attempt", "-c", "user.email=paired-attempt@remudero.invalid",
    "commit", "--quiet", "--no-verify", "-m", "paired side attempt (sealed, never pushed)"]);
}

/** The production dispatcher's inputs. Every optional field defaults to the real thing. */
export interface SealedPairedAttemptOptions {
  task: Task;
  config: Config;
  /** The fleet's clone of the task's repo: the attempt borrows its objects, never its branches. */
  repoDir: string;
  baseRef?: string;
  spawn?: typeof spawnWorker;
  maxBudgetUsd?: number;
  clockBoundMs?: number;
  clock?: Clock;
  installDependencies?: typeof execFileSync;
  probeIsolation?: (input: SealedProbeInput) => SealedIsolationReading;
  removeTree?: (repoDir: string, dir: string) => void;
}

/**
 * W1-T4638: the production {@link PairedAttemptDispatch}. Each attempt gets a fresh DETACHED worktree at one base shared
 * by both arms, primed the way the reviewer primes a checkout, and spawns its pinned arm through the ordinary
 * `spawnWorker` with no assignment sink, so the only rows it leaves are the trial's own. The head is committed locally
 * and returned for grading; the worktree is removed by `cleanup`, or here when anything throws.
 */
export function sealedPairedAttemptDispatcher(options: SealedPairedAttemptOptions): PairedAttemptDispatch<string> {
  const clock = options.clock ?? systemClock;
  let base: string | null = null;
  return async (request) => {
    base ??= gitOut(options.repoDir, ["rev-parse", "--verify", `${options.baseRef ?? "origin/main"}^{commit}`]);
    const attemptId = `${request.pairId}-${request.arm}-${clock.now()}`;
    const dir = join(pairedAttemptRoot(options.config.root), attemptId);
    const settingsOut = join(options.config.root, "tmp", `worker-settings-${attemptId}.json`);
    cutSealedAttemptTree(options.repoDir, dir, base);
    const cleanup = (): void => {
      rmSync(settingsOut, { force: true });
      (options.removeTree ?? worktreeRemove)(options.repoDir, dir);
    };
    try {
      registerReviewerCheckout(dir);
      ensureDeps(dir, options.installDependencies);
      const installRoot = resolveInstallRoot(options.config);
      const settingsFile = renderWorkerSettings({ templatePath: join(installRoot, "settings", "worker.json"),
        hooksDir: join(installRoot, "hooks"), outPath: settingsOut });
      validateWorkerSettingsFile(settingsFile);
      const result = await (options.spawn ?? benchmarkNonDispatchSpawn("paired-trial", spawnWorker))({
        cwd: dir, permissionMode: "bypassPermissions", settingsFile, config: options.config,
        prompt: `${renderImplementPrompt(options.task, "", attemptId)}\n${SEALED_ATTEMPT_CONTRACT_LINES.join("\n")}`,
        model: request.pin.model, effort: request.pin.effort, mountProvider: request.pin.provider as WorkerProviderId,
        maxBudgetUsd: Math.min(options.maxBudgetUsd ?? PAIRED_ATTEMPT_MAX_BUDGET_USD, PAIRED_ATTEMPT_MAX_BUDGET_USD),
        runId: `paired-${attemptId}`, taskId: `${request.pairId}:${request.arm}`,
        env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.pushurl", GIT_CONFIG_VALUE_0: "sealed-paired-attempt://push-refused" },
        ...(options.clockBoundMs === undefined ? {} : { clockBound: { boundMs: options.clockBoundMs } }),
      });
      const reading = (options.probeIsolation ?? probeSealedIsolation)({ repoDir: options.repoDir, dir, base,
        text: [result.text, ...result.blocks].join("\n") });
      const sealed = reading.pushedRef === null && reading.prUrl === null && reading.breach === null;
      const measurable = sealed && !result.apiError && result.usageRefusal === undefined;
      if (measurable) commitSealedEdits(dir);
      return { headDir: measurable ? dir : null, headSha: gitProbe(dir, ["rev-parse", "HEAD"]), servedModel: result.servedModel ?? null,
        billingMode: result.provider === "cash" ? "api" : billingMode(result.childEnvKeys), costUsd: result.costUsd, ...reading, cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}

/** A measured pair's two graded outcomes. */
export interface GradedPair {
  paid: "pass" | "fail";
  control: "pass" | "fail";
}

/** McNemar on the discordant pairs, with the exact two-sided binomial p-value (b of b + c against one half). */
export function mcnemarExact(pairs: readonly GradedPair[]) {
  const count = (paid: string, control: string) => pairs.filter((pair) => pair.paid === paid && pair.control === control).length;
  const [bothPass, paidOnly, controlOnly, bothFail] = [count("pass", "pass"), count("pass", "fail"), count("fail", "pass"), count("fail", "fail")];
  return { pairs: pairs.length, bothPass, paidOnly, controlOnly, bothFail, discordant: paidOnly + controlOnly,
    pValue: exactBinomialHalfPValue(paidOnly, paidOnly + controlOnly) };
}

export type PairedDifference = { estimate: number; low: number; high: number } | { unavailable: string };

/** Paired difference in success rate, paid minus control, with a two-sided Wald 95% interval. */
export function pairedDifference(test: ReturnType<typeof mcnemarExact>): PairedDifference {
  if (test.pairs === 0) return { unavailable: "no-measured-pairs" };
  const n = test.pairs;
  const estimate = (test.paidOnly - test.controlOnly) / n;
  const se = Math.sqrt(Math.max(0, test.discordant - (test.paidOnly - test.controlOnly) ** 2 / n)) / n;
  const z = normalQuantile(1 - PAIRED_ALPHA / 2);
  return { estimate, low: estimate - z * se, high: estimate + z * se };
}

/** The private paired-pilot report: shadow decisions, pairs, per-attempt cost, McNemar and the eval card. */
export interface PairedPilotReport {
  version: typeof PAIRED_PILOT_REPORT_VERSION;
  pilotId: string;
  design: "paired";
  shadow: boolean;
  state: "observed" | "observed-partial" | "unavailable";
  unavailableReason: string | null;
  asOf: string;
  visibility: "private";
  export: "none";
  cash: { ceilingUsd: number; spend: PaidPilotSpend | null; counts: "paired-paid-attempts-only" };
  decisions: { eligible: number; sampled: number; admitted: number; refusedBy: Record<string, number>;
    order: { paidFirst: number; controlFirst: number; exactBinomialPValue: number | null } };
  pairs: { pairId: string; order: PaidPilotArm[] | null; status: string; outcomes: Record<PaidPilotArm, string> | null;
    attempts: { arm: PaidPilotArm | null; servedModel: string | null; billingMode: string | null; costUsd: number | null }[] }[];
  counts: { measured: number; unmeasurable: number };
  stack: { revisions: PaidPilotProtocol["revisions"]; deviatingPairs: number; deviations: string[]; offPinAttempts: number; unpinnedAttempts: number };
  mcnemar: ReturnType<typeof mcnemarExact>;
  difference: PairedDifference;
  stoppingRule: { rule: string; met: boolean; analysisAt: string };
  conclusion: { state: "no-conclusion" | "inconclusive"; reason: string } | { state: "difference-observed"; favors: PaidPilotArm };
  winnerDeclared: boolean;
  evalCard: EvalCard;
}

/** One row per pair: the latest pair record, or the earliest decision unless a later one admitted the pair. */
function onePerPair(rows: readonly PaidPilotRow[], step: string): Map<string, PaidPilotRow> {
  const out = new Map<string, PaidPilotRow>();
  for (const row of [...rows].filter((entry) => entry.step === step).sort((a, b) => a.ts.localeCompare(b.ts))) {
    const held = out.get(row.paired!.pairId);
    if (held === undefined || step === PAIRED_TRIAL_STEPS.pair || (held.paired!.admitted !== true && row.paired!.admitted === true))
      out.set(row.paired!.pairId, row);
  }
  return out;
}

function gradedPair(outcomes: Record<PaidPilotArm, string> | null): GradedPair | null {
  const graded = (value: string | undefined): value is "pass" | "fail" => value === "pass" || value === "fail";
  return outcomes !== null && graded(outcomes.paid) && graded(outcomes.control) ? { paid: outcomes.paid, control: outcomes.control } : null;
}

/** Build the paired report. Pure over its input; the operator verb supplies the three-form ledger evidence. */
export function buildPairedPilotReport(input: { protocol: PaidPilotProtocol; evidence: PaidPilotEvidence; nowIso: string }): PairedPilotReport {
  const { protocol, evidence, nowIso } = input;
  const rows = evidence.rows.filter((row) => row.paired !== null);
  const decisions = [...onePerPair(rows, PAIRED_TRIAL_STEPS.decision).values()];
  const refusedBy: Record<string, number> = {};
  for (const reason of decisions.filter((row) => row.paired!.admitted !== true).flatMap((row) => row.paired!.reasons))
    refusedBy[reason] = (refusedBy[reason] ?? 0) + 1;
  const sampled = decisions.filter((row) => row.paired!.sampled === true);
  const paidFirst = sampled.filter((row) => row.paired!.order?.[0] === "paid").length;
  const pairRows = onePerPair(rows, PAIRED_TRIAL_STEPS.pair);
  const attempts = rows.filter((row) => row.step === PAIRED_TRIAL_STEPS.attempt);
  const spawns = rows.filter((row) => row.step === PAIRED_TRIAL_STEPS.spawn);
  const pairs = [...pairRows.values()].map((row) => ({ pairId: row.paired!.pairId, order: row.paired!.order, status: row.paired!.status ?? "unknown",
    outcomes: row.paired!.outcomes, attempts: attempts.filter((attempt) => attempt.paired!.pairId === row.paired!.pairId).map((attempt) => ({
      arm: attempt.paired!.arm, servedModel: attempt.servedModel, billingMode: attempt.billingMode,
      costUsd: attempt.cost.state === "observed" ? attempt.cost.usd : null })) }));
  const graded = pairs.flatMap((pair) => {
    const outcome = pair.status === "measured" ? gradedPair(pair.outcomes) : null;
    return outcome === null ? [] : [outcome];
  });
  const test = mcnemarExact(graded);
  const difference = pairedDifference(test);
  const met = !(Date.parse(nowIso) < Date.parse(protocol.analysisAt));
  const decisive = !("unavailable" in difference) && (difference.low > 0 || difference.high < 0) && test.pValue < PAIRED_ALPHA;
  const card: EvalCardEvidence = { assignments: [], outcomes: [], reviewRows: [], deviations: [] };
  for (const pair of pairs) {
    const decision = decisions.find((row) => row.paired!.pairId === pair.pairId);
    if (decision !== undefined && pair.order !== null) card.assignments.push({ unitId: pair.pairId, arm: pair.order[0]!, assignedAt: decision.ts, taskId: pair.pairId });
    for (const arm of ["paid", "control"] as const) {
      const outcome = pair.outcomes?.[arm];
      card.outcomes.push({ unitId: pair.pairId, arm, stratum: "paired", success: outcome === "pass" ? true : outcome === "fail" ? false : null });
    }
  }
  return {
    version: PAIRED_PILOT_REPORT_VERSION, pilotId: protocol.pilotId, design: "paired", shadow: protocol.paired?.shadow === true,
    state: evidence.state, unavailableReason: evidence.reason ?? null, asOf: nowIso, visibility: "private", export: "none",
    cash: { ceilingUsd: protocol.cash.ceilingUsd, spend: evidence.state === "unavailable" ? null : summarizePaidPilotSpend(evidence.rows, protocol),
      counts: "paired-paid-attempts-only" },
    decisions: { eligible: decisions.length, sampled: sampled.length, admitted: decisions.filter((row) => row.paired!.admitted === true).length,
      refusedBy, order: { paidFirst, controlFirst: sampled.length - paidFirst,
        exactBinomialPValue: sampled.length > 0 ? exactBinomialHalfPValue(paidFirst, sampled.length) : null } },
    pairs, counts: { measured: graded.length, unmeasurable: pairs.length - graded.length },
    stack: { revisions: protocol.revisions, deviatingPairs: [...pairRows.values()].filter((row) => row.paired!.deviations.length > 0).length,
      deviations: [...new Set(rows.flatMap((row) => row.paired!.deviations))].sort(),
      offPinAttempts: spawns.filter((row) => row.revisionsOffPin > 0).length, unpinnedAttempts: spawns.filter((row) => row.revisionsUnpinned > 0).length },
    mcnemar: test, difference,
    stoppingRule: { rule: protocol.stoppingRule, met, analysisAt: protocol.analysisAt },
    conclusion: !met ? { state: "no-conclusion", reason: "stopping-rule-not-met" }
      : "unavailable" in difference ? { state: "inconclusive", reason: difference.unavailable }
      : decisive ? { state: "difference-observed", favors: difference.estimate > 0 ? "paid" : "control" }
      : { state: "inconclusive", reason: "no-decisive-difference" },
    winnerDeclared: met && decisive,
    evalCard: buildEvalCard({ trialId: protocol.pilotId, kind: "paired-pilot", protocolText: protocol.protocolText,
      preRegisteredAt: protocol.activatedAt, registeredProtocolHash: protocol.protocolHash,
      estimand: "paired difference in graded success on one task, paid arm minus subscription control",
      randomizationUnit: "task", propensity: `${protocol.paired?.sampleMethod ?? "unavailable"}; order ${protocol.assignment.method}`,
      plannedAllocation: protocol.assignment.plannedAllocation, cells: ["paid|paired", "control|paired"], aaReceipt: protocol.aaReceipt.reportHash }, card),
  };
}

/** The report verb's view of a paired protocol: the report, the operator's summary lines, and whether it observed. */
export function pairedPilotReportView(input: { protocol: PaidPilotProtocol; evidence: PaidPilotEvidence; nowIso: string }): PairedPilotReportView {
  const report = buildPairedPilotReport(input);
  const spent = report.cash.spend === null ? "unknown" : `$${report.cash.spend.cashEstimateUsd.toFixed(2)}`;
  return { report: report as unknown as Record<string, unknown>, observed: report.state !== "unavailable", lines: [
    `benchmark-paid-pilot ${report.pilotId}: paired${report.shadow ? " SHADOW (no spawn, no spend)" : ""}; ${report.state}`
      + `${report.unavailableReason ? ` (${report.unavailableReason})` : ""}`,
    `  decisions ${report.decisions.eligible} eligible, ${report.decisions.sampled} sampled, ${report.decisions.admitted} admitted; order `
      + `${report.decisions.order.paidFirst} paid-first / ${report.decisions.order.controlFirst} control-first`,
    `  pairs ${report.counts.measured} measured, ${report.counts.unmeasurable} unmeasurable; discordant ${report.mcnemar.paidOnly} paid-only / `
      + `${report.mcnemar.controlOnly} control-only, exact McNemar p ${report.mcnemar.pValue.toFixed(4)}`,
    `  stack ${report.stack.deviatingPairs} deviating pair(s), ${report.stack.unpinnedAttempts} unpinned and ${report.stack.offPinAttempts} off-pin attempt(s)`,
    `  cash estimate ${spent} of $${report.cash.ceilingUsd.toFixed(2)} (paired paid attempts only); conclusion ${report.conclusion.state}; no public export`,
  ] };
}
