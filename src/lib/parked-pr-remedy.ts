import { posix } from "node:path";
import { isMap, isSeq, parseDocument, stringify } from "yaml";

import { stallLadderSpent, stallRemedyRows } from "./fix-progress-judge.js";
import type { PrBlocker } from "./pr-blocker.js";

/**
 * W1-T12709: an open pull request is never left with "a person must answer" as its only next action. Where the
 * sweep would stand down on a needs-human escalation, it takes one of three remedies and writes one
 * `parked_pr.remedy` row. The console does not deliver escalations, so a question goes into a held task's
 * needs_input (W1-T12715), which the inbox shows.
 */
export const PARKED_PR_REMEDY_STEP = "parked_pr.remedy";
export type ParkedPrRemedy = "fix-on-pr" | "split-follow-up" | "close-and-rebuild";

export interface ParkedPrCriterion {
  claim: string;
  proof?: string;
  reason?: string;
  /** R1: true only when W1-T12714's classifier sorted the question as a real design or input question. */
  needsInput: boolean;
  /** True when W1-T12710's stall remedies before operator-input were all tried on this criterion. */
  ladderSpent: boolean;
}

export interface ParkedPrFacts {
  unmetCriteria: readonly ParkedPrCriterion[];
  redChecks: readonly string[];
  isPlanFiling: boolean;
  /** How many criteria the pull request's task has; undefined when its task file cannot be read. */
  taskCriteria?: number;
  /** W1-T13046: the red checks a design hold covers. A red check cannot leave the task, so it is never split. */
  designHoldChecks?: readonly string[];
}

export interface ParkedPrDecision { remedy: ParkedPrRemedy; reason: string; inputCriteria: readonly ParkedPrCriterion[] }

/** W1-T12709: the remedy for a pull request that would wait on a person. It never returns "wait". PURE. */
export function parkedPrRemedy(facts: ParkedPrFacts): ParkedPrDecision {
  const input = facts.unmetCriteria.filter(c => c.needsInput);
  const fixable = facts.unmetCriteria.length - input.length;
  if (input.length === 0 && (facts.designHoldChecks?.length ?? 0) > 0) {
    return { remedy: "close-and-rebuild", inputCriteria: [],
      reason: `the design hold covers ${facts.designHoldChecks!.length} red checks and no criterion; a red check cannot leave ` +
        "the task, so the pull request is closed and rebuilt as a held task" };
  }
  if (input.length === 0) {
    const reason = fixable + facts.redChecks.length === 0
      ? "nothing is unmet and nothing is red, so the stalled stage or review runs again on the pull request"
      : `a ${facts.isPlanFiling ? "plan-scoped" : "fix"} round acts on ${fixable} unmet criteria and ` +
        `${facts.redChecks.length} red checks on the pull request`;
    return { remedy: "fix-on-pr", reason, inputCriteria: [] };
  }
  if (!facts.isPlanFiling && facts.taskCriteria !== undefined && input.length < facts.taskCriteria) {
    return { remedy: "split-follow-up", inputCriteria: input,
      reason: `${input.length} of the task's ${facts.taskCriteria} criteria need operator input; they move to a held ` +
        "follow-up task and the pull request merges on the rest" };
  }
  if (input.some(c => c.ladderSpent)) {
    return { remedy: "close-and-rebuild", inputCriteria: input,
      reason: "no part of the pull request can merge without operator input, and the stall remedies were tried; " +
        "the pull request is closed and rebuilt as a held task" };
  }
  return { remedy: "fix-on-pr", inputCriteria: input,
    reason: "the criteria that need operator input have not had the stall remedies yet, so a fix round runs on the pull request" };
}

/** The file writes and the one GitHub write a remedy makes. The sweep's production effects wire each one. */
export interface ParkedPrHost {
  readTaskShard(taskId: string): { relPath: string; text: string } | undefined;
  /** R3: an id from reservePlanRepairTaskId. */
  reserveTaskId(): string;
  /** R3: lands new and amended task files through landTaskFilesAsync. */
  landTaskFiles(files: readonly { relPath: string; content: string; claim: string; proof: string }[]):
    Promise<{ prUrl?: string; error?: string }>;
  closePr(prUrl: string, comment: string): Promise<void>;
}

export interface ParkedPrSubject {
  prNumber: number;
  prUrl: string;
  headSha: string;
  taskId?: string;
  isPlanFiling?: boolean;
  unmetCriteria: readonly { claim: string; proof?: string; reason?: string }[];
}

export interface ParkedPrContext {
  runId: string;
  ledgerTaskId: string;
  nowIso: string;
  /** What parked the pull request; with the pull request it keys the one held task (invariant one-question). */
  cause: string;
  /** The escalation text the remedy replaces. */
  text: string;
  append: (row: { run_id: string; task_id: string; step: string } & Record<string, unknown>) => void;
}

export interface ParkedPrOutcome { remedy: ParkedPrRemedy; reason: string; heldTaskId?: string; error?: string }

/**
 * R4: the answer the fix lane passes to openEscalationStandDownReason. An operator's answer, or else a fix-on-pr row for
 * this pull request and head, releases the open-escalation stand-down; for any other pull request or head it stands.
 */
export function openEscalationRelease(pendingAnswer: { spent?: true } | undefined, ledger: readonly Record<string, unknown>[],
  prNumber: number | undefined, headSha: string): { spent?: true } | undefined {
  if (pendingAnswer !== undefined) return pendingAnswer;
  return prNumber !== undefined && ledger.some(row => row.step === PARKED_PR_REMEDY_STEP && row.pr_number === prNumber &&
    row.head_sha === headSha && row.remedy === "fix-on-pr" && row.outcome === "taken") ? {} : undefined;
}

/** Acts on `decision`: one row, and for a split or a close one held task. A later pass reuses that task. */
export async function takeParkedPrRemedy(pr: ParkedPrSubject, decision: ParkedPrDecision, ledger: readonly Record<string, unknown>[],
  host: ParkedPrHost, ctx: ParkedPrContext): Promise<ParkedPrOutcome> {
  const row = { run_id: ctx.runId, task_id: ctx.ledgerTaskId, step: PARKED_PR_REMEDY_STEP, pr_number: pr.prNumber,
    head_sha: pr.headSha, cause: ctx.cause, remedy: decision.remedy, text: ctx.text.slice(0, 2000) };
  if (decision.remedy === "fix-on-pr") {
    const written = ledger.some(r => r.step === PARKED_PR_REMEDY_STEP && r.pr_number === pr.prNumber &&
      r.head_sha === pr.headSha && r.cause === ctx.cause && r.remedy === "fix-on-pr" && r.outcome === "taken");
    if (!written) ctx.append({ ...row, outcome: "taken", reason: decision.reason });
    return { remedy: decision.remedy, reason: decision.reason };
  }
  const prior = ledger.findLast(r => r.step === PARKED_PR_REMEDY_STEP && r.pr_number === pr.prNumber && r.cause === ctx.cause &&
    r.outcome === "taken" && typeof r.held_task_id === "string");
  if (prior !== undefined) {
    return { remedy: prior.remedy as ParkedPrRemedy, heldTaskId: prior.held_task_id as string,
      reason: `held task ${String(prior.held_task_id)} was filed for this pull request and cause; this pass reuses it` };
  }
  try {
    const shard = pr.taskId === undefined ? undefined : host.readTaskShard(pr.taskId);
    if (shard === undefined || pr.taskId === undefined) throw new Error(`the task file of ${pr.taskId ?? "the pull request"} cannot be read`);
    const heldTaskId = host.reserveTaskId();
    const files = heldTaskFiles(shard, pr.taskId, heldTaskId, decision, pr, ctx);
    const landed = await host.landTaskFiles(files);
    if (landed.error !== undefined) throw new Error(`the task files did not land: ${landed.error}`);
    const closed = decision.remedy === "close-and-rebuild";
    if (closed) {
      await host.closePr(pr.prUrl, `Closed by the sweep (W1-T12709): no part of this pull request can merge without operator ` +
        `input. The held rebuild task ${heldTaskId} carries the question and this pull request's findings` +
        `${landed.prUrl === undefined ? "" : `, filed in ${landed.prUrl}`}. Answer it in the inbox and the rebuild runs.`);
    }
    ctx.append({ ...row, outcome: "taken", reason: decision.reason, held_task_id: heldTaskId,
      criteria: decision.inputCriteria.map(c => c.claim), ...(landed.prUrl === undefined ? {} : { landing_pr_url: landed.prUrl }),
      ...(closed ? { closed: true } : {}) });
    return { remedy: decision.remedy, heldTaskId,
      reason: `${decision.reason}: held task ${heldTaskId}${landed.prUrl === undefined ? "" : ` (${landed.prUrl})`}` };
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    ctx.append({ ...row, outcome: "refused", reason });
    return { remedy: decision.remedy, error: reason, reason: `the ${decision.remedy} remedy could not act, and the next pass tries it again: ${reason}` };
  }
}

/** W1-T13045: the cause a stand-down hold's remedy row names, `stand-down:<site>`. */
export function standDownHoldCause(site: string): string {
  return `stand-down:${site}`;
}

/** True when a parked_pr.remedy row already names the stand-down hold at `site` for this pull request and head. */
export function standDownHoldRemedied(ledger: readonly Record<string, unknown>[], prNumber: number, headSha: string, site: string): boolean {
  return ledger.some(r => r.step === PARKED_PR_REMEDY_STEP && r.pr_number === prNumber && r.head_sha === headSha &&
    r.cause === standDownHoldCause(site) && r.remedy === "fix-on-pr" && r.outcome === "taken");
}

/**
 * W1-T13045: the fix lane stood down (W1-T10339) and nothing it read has changed, so a dispatch would stand down again
 * with no worker. The hold stays, but it opens no needs-human issue: it writes one fix-on-pr row for this pull request,
 * head and stand-down site. A new head, a new task contract or body, or the held-escalation ladder releases the hold.
 */
export function standDownHoldRemedy(pr: ParkedPrSubject, hold: { site: string; reason: string }, ledger: readonly Record<string, unknown>[],
  host: ParkedPrHost, ctx: Omit<ParkedPrContext, "cause" | "text">): Promise<ParkedPrOutcome> {
  const decision: ParkedPrDecision = { remedy: "fix-on-pr", inputCriteria: [],
    reason: `the fix lane stood down at ${hold.site} and nothing it read has changed, so the hold stays until a new head, ` +
      "a new task contract or body, or the held-escalation ladder releases it; no needs-human issue is opened" };
  return takeParkedPrRemedy(pr, decision, ledger, host, { ...ctx, cause: standDownHoldCause(hold.site), text: hold.reason });
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
}

/** The held task, and for a split the amended task file that no longer carries the moved criteria. */
function heldTaskFiles(shard: { relPath: string; text: string }, taskId: string, heldTaskId: string, decision: ParkedPrDecision,
  pr: ParkedPrSubject, ctx: ParkedPrContext): { relPath: string; content: string; claim: string; proof: string }[] {
  const doc = parseDocument(shard.text);
  const seq = doc.contents;
  const index = isSeq(seq) ? seq.items.findIndex(node => isMap(node) && (node.toJSON() as { id?: unknown }).id === taskId) : -1;
  const item = isSeq(seq) ? seq.items[index] : undefined;
  if (!isMap(item)) throw new Error(`${shard.relPath} does not declare ${taskId}`);
  const task = item.toJSON() as Record<string, unknown>;
  const acceptance = Array.isArray(task.acceptance) ? task.acceptance as { claim?: unknown }[] : [];
  const split = decision.remedy === "split-follow-up";
  const claims = new Set(decision.inputCriteria.map(c => c.claim));
  const moved = split ? acceptance.filter(c => typeof c.claim === "string" && claims.has(c.claim)) : acceptance;
  if (split && moved.length !== claims.size) throw new Error(`a criterion that needs input is not in ${shard.relPath}`);
  const question = (`Pull request ${pr.prUrl} (task ${taskId}) cannot ${split ? "meet these criteria" : "merge"} without your ` +
    `input. ${[...claims].map(c => `"${c}"`).join("; ")}${claims.size > 0 ? ". " : ""}What it needs: ${ctx.text}`).slice(0, 1500);
  const findings = pr.unmetCriteria.map(c => `- ${c.claim}: ${c.reason ?? "unmet"}`).join("\n");
  const { pr: _pr, note: _note, ...rest } = task;
  const dependsOn = Array.isArray(task.depends_on) ? task.depends_on : [];
  const held = { ...rest, id: heldTaskId, title: `${String(task.title)} (${split ? "held follow-up" : "held rebuild"})`,
    depends_on: split ? [taskId, ...dependsOn.filter(d => d !== taskId)] : dependsOn, status: "queued", attempts: 0,
    acceptance: moved, needs_input: { question, source_pr: pr.prUrl, asked_at: ctx.nowIso },
    rationale: `${split ? `FOLLOW-UP of ${taskId}` : `REBUILD of ${taskId}`}, filed by the sweep (W1-T12709) from ${pr.prUrl} at ` +
      `${pr.headSha}: ${decision.reason}.\nFINDINGS of the pull request:\n${findings || "- no unmet criterion was recorded"}\n` +
      `${typeof task.rationale === "string" ? task.rationale : ""}` };
  const dir = shard.relPath.includes("/tasks.d/") ? posix.dirname(shard.relPath) : posix.join(posix.dirname(shard.relPath), "tasks.d");
  const heldRel = `${dir}/${heldTaskId}-${slug(String(task.title))}.yaml`;
  const files = [{ relPath: heldRel, content: stringify([held], { lineWidth: 0 }),
    claim: `the held ${split ? "follow-up" : "rebuild"} task ${heldTaskId} for ${pr.prUrl} is filed`, proof: `grep: id: ${heldTaskId} in ${heldRel}` }];
  if (split) {
    const node = item.get("acceptance", true);
    if (isSeq(node)) node.items = node.items.filter(c => !(isMap(c) && claims.has(String((c.toJSON() as { claim?: unknown }).claim))));
    doc.setIn([index, "rationale"], `${typeof task.rationale === "string" ? task.rationale : ""}\nMOVED to ${heldTaskId} by the sweep ` +
      `(W1-T12709): ${moved.length} criteria that need operator input, so ${pr.prUrl} merges on the rest.\n`);
    files.push({ relPath: shard.relPath, content: doc.toString({ lineWidth: 0 }),
      claim: `${taskId} no longer carries the criteria moved to ${heldTaskId}`, proof: `grep: MOVED to ${heldTaskId} in ${shard.relPath}` });
  }
  return files;
}

/** The number of criteria the task file declares for `taskId`, or undefined when it cannot be read. */
export function taskCriteriaCount(host: Pick<ParkedPrHost, "readTaskShard">, taskId: string | undefined): number | undefined {
  const shard = taskId === undefined ? undefined : host.readTaskShard(taskId);
  if (shard === undefined) return undefined;
  const seq = parseDocument(shard.text).toJSON() as unknown;
  const task = Array.isArray(seq) ? seq.find(t => (t as { id?: unknown } | null)?.id === taskId) as { acceptance?: unknown } | undefined : undefined;
  return Array.isArray(task?.acceptance) ? task.acceptance.length : undefined;
}

export interface ParkedPrSweepOutcome extends ParkedPrOutcome {
  disposition: "blocked-fixable" | "post-review" | "wait";
  blocker: PrBlocker;
}

/** W1-T13046: what a design hold is about: the unmet claims and the red check names its fix round was given. */
export interface DesignHoldCoverage { criteria: readonly string[]; checks: readonly string[] }

/** W1-T13046: the coverage a `fix.needs_design` row records, or undefined for a row that records neither field. */
export function designHoldCoverage(row: Record<string, unknown> | undefined): DesignHoldCoverage | undefined {
  const names = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
  const criteria = names(row?.covers_criteria), checks = names(row?.covers_checks);
  return criteria === undefined && checks === undefined ? undefined : { criteria: criteria ?? [], checks: checks ?? [] };
}

/**
 * The facts of a pull request the sweep would set refused-escalate for, or hold on an escalated blocker. A design
 * question (W1-T12714's design kind) marks the unmet criteria its hold covers as needing input and ladder-spent: the
 * round answered NEEDS_DESIGN, so no stall round runs for them (W1-T13046). A hold with no coverage marks every unmet
 * criterion as needing input. PURE apart from `host` reads.
 */
export function parkedPrFacts(pr: ParkedPrSubject, input: { redChecks: readonly string[]; designQuestion?: string;
  designCoverage?: DesignHoldCoverage; fixModelOrder: readonly string[] }, ledger: readonly Record<string, unknown>[],
host: Pick<ParkedPrHost, "readTaskShard">): ParkedPrFacts {
  const coverage = input.designQuestion === undefined ? undefined : input.designCoverage;
  const unmet = pr.unmetCriteria.map(c => {
    const covered = coverage?.criteria.includes(c.claim) === true;
    return { claim: c.claim, ...(c.proof === undefined ? {} : { proof: c.proof }), ...(c.reason === undefined ? {} : { reason: c.reason }),
      needsInput: input.designQuestion !== undefined && (coverage === undefined || covered),
      ladderSpent: covered || stallLadderSpent(stallRemedyRows(ledger, pr.prNumber, `review:${c.claim}`), { fixModelOrder: input.fixModelOrder }) };
  });
  const designHoldChecks = coverage === undefined ? [] : input.redChecks.filter(name => coverage.checks.includes(name));
  return { unmetCriteria: unmet, redChecks: input.redChecks, isPlanFiling: pr.isPlanFiling === true,
    ...(unmet.some(c => c.needsInput) ? { taskCriteria: taskCriteriaCount(host, pr.taskId) } : {}),
    ...(designHoldChecks.length > 0 ? { designHoldChecks } : {}) };
}

/** Takes the sweep's remedy and names the disposition the pull request goes on with. It is never refused-escalate. */
export async function actOnParkedPr(pr: ParkedPrSubject, decision: ParkedPrDecision, facts: ParkedPrFacts,
  ledger: readonly Record<string, unknown>[], host: ParkedPrHost, ctx: ParkedPrContext): Promise<ParkedPrSweepOutcome> {
  const outcome = await takeParkedPrRemedy(pr, decision, ledger, host, ctx);
  const fixableUnmet = facts.unmetCriteria.some(c => !c.needsInput);
  if (outcome.error !== undefined || outcome.remedy === "close-and-rebuild") return { ...outcome, disposition: "wait", blocker: "other" };
  if (outcome.remedy === "split-follow-up") {
    return fixableUnmet || facts.redChecks.length > 0
      ? { ...outcome, disposition: "blocked-fixable", blocker: fixableUnmet ? "review-failed" : "own-red" }
      : { ...outcome, disposition: "wait", blocker: "awaiting-review" };
  }
  if (facts.isPlanFiling) return { ...outcome, disposition: "wait", blocker: "own-red" };
  if (facts.unmetCriteria.length > 0) return { ...outcome, disposition: "blocked-fixable", blocker: "review-failed" };
  return facts.redChecks.length > 0 ? { ...outcome, disposition: "blocked-fixable", blocker: "own-red" }
    : { ...outcome, disposition: "post-review", blocker: "awaiting-review" };
}

/**
 * R5: W1-T12710's last stall remedy, operator-input, becomes a split of the stalled criterion into a held follow-up
 * task. The split is impossible when the stall is a red check or the task's only criterion; then the pull request
 * is closed and rebuilt.
 */
export async function remedyStalledCriterion(pr: ParkedPrSubject, criterion: string, stalledOn: string,
  ledger: readonly Record<string, unknown>[], host: ParkedPrHost, ctx: Omit<ParkedPrContext, "cause" | "text">): Promise<ParkedPrOutcome> {
  const claim = criterion.startsWith("review:") ? criterion.slice("review:".length) : undefined;
  const known = claim === undefined ? undefined : pr.unmetCriteria.find(c => c.claim === claim);
  const decision = parkedPrRemedy({ redChecks: [], isPlanFiling: false,
    unmetCriteria: [{ claim: claim ?? criterion, ...(known?.reason === undefined ? {} : { reason: known.reason }), needsInput: true, ladderSpent: true }],
    ...(claim === undefined ? {} : { taskCriteria: taskCriteriaCount(host, pr.taskId) }) });
  return takeParkedPrRemedy(pr, decision, ledger, host, { ...ctx, cause: `stall:${criterion}`, text: stalledOn });
}
