import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isMap, isSeq, parseDocument, stringify } from "yaml";

import { stallLadderSpent, stallRemedyRows } from "./fix-progress-judge.js";
import { isInPlanScope } from "./plan-scope.js";
import { resolveRepoLayout } from "./repo-layout.js";
import type { PrBlocker } from "./pr-blocker.js";
import type { TaskFileInput, TaskFilesLandingResult } from "./feedback-landing.js";

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
export function parkedPrRemedy(facts: ParkedPrFacts): ParkedPrDecision;
/**
 * W1-T13361: the ladder with `spent` skipped, the remedies that were taken and left the pull request unchanged. It names
 * the first remedy that applies and is not spent, or undefined when none is left.
 */
export function parkedPrRemedy(facts: ParkedPrFacts, spent: readonly ParkedPrRemedy[]): ParkedPrDecision | undefined;
export function parkedPrRemedy(facts: ParkedPrFacts, spent: readonly ParkedPrRemedy[] = []): ParkedPrDecision | undefined {
  const left = (remedy: ParkedPrRemedy): boolean => !spent.includes(remedy);
  const input = facts.unmetCriteria.filter(c => c.needsInput);
  const fixable = facts.unmetCriteria.length - input.length;
  if (input.length === 0 && (facts.designHoldChecks?.length ?? 0) > 0 && left("close-and-rebuild")) {
    return { remedy: "close-and-rebuild", inputCriteria: [],
      reason: `the design hold covers ${facts.designHoldChecks!.length} red checks and no criterion; a red check cannot leave ` +
        "the task, so the pull request is closed and rebuilt as a held task" };
  }
  if (input.length === 0) {
    if (!left("fix-on-pr")) return undefined;
    const reason = fixable + facts.redChecks.length === 0
      ? "nothing is unmet and nothing is red, so the stalled stage or review runs again on the pull request"
      : `a ${facts.isPlanFiling ? "plan-scoped" : "fix"} round acts on ${fixable} unmet criteria and ` +
        `${facts.redChecks.length} red checks on the pull request`;
    return { remedy: "fix-on-pr", reason, inputCriteria: [] };
  }
  if (!facts.isPlanFiling && facts.taskCriteria !== undefined && input.length < facts.taskCriteria && left("split-follow-up")) {
    return { remedy: "split-follow-up", inputCriteria: input,
      reason: `${input.length} of the task's ${facts.taskCriteria} criteria need operator input; they move to a held ` +
        "follow-up task and the pull request merges on the rest" };
  }
  if (input.some(c => c.ladderSpent) && left("close-and-rebuild")) {
    return { remedy: "close-and-rebuild", inputCriteria: input,
      reason: "no part of the pull request can merge without operator input, and the stall remedies were tried; " +
        "the pull request is closed and rebuilt as a held task" };
  }
  if (!left("fix-on-pr")) return undefined;
  return { remedy: "fix-on-pr", inputCriteria: input,
    reason: "the criteria that need operator input have not had the stall remedies yet, so a fix round runs on the pull request" };
}

export interface ParkedPrShard { relPath: string; text: string }
/** W1-T13048: the repository that holds a task file, and its checkout. */
export interface ParkedPrTarget { owner: string; repo: string; checkoutDir: string }
/** A task file and the repository that holds it, or the reason the remedy cannot read it. */
export type ParkedPrShardRead =
  | { outcome: "read"; shard: ParkedPrShard; target: ParkedPrTarget }
  | { outcome: "refused"; reason: string; target?: ParkedPrTarget };
/** The answer of the sweep's taskFileRepository: the task and the repository that holds its file, or a reason. */
export type ParkedPrResolution =
  | { outcome: "unreadable"; reason: string }
  | { outcome: "resolved"; task?: unknown; target: ParkedPrTarget };

/**
 * W1-T13048, invariant:no-wrong-catalog: a task file is read from, and edited in, the repository that holds it. An
 * unreadable resolution, or a task in neither catalog, is a refusal. It never falls back to the public repository.
 */
export function readParkedPrShard(resolution: ParkedPrResolution, read: (checkoutDir: string) => ParkedPrShard | undefined):
  ParkedPrShardRead {
  if (resolution.outcome === "unreadable") return { outcome: "refused", reason: resolution.reason };
  if (resolution.task === undefined) return { outcome: "refused", reason: "task-absent" };
  const shard = read(resolution.target.checkoutDir);
  return shard === undefined
    ? { outcome: "refused", reason: `the task file cannot be read in ${resolution.target.owner}/${resolution.target.repo}`, target: resolution.target }
    : { outcome: "read", shard, target: resolution.target };
}

/** The file writes and the one GitHub write a remedy makes. The sweep's production effects wire each one. */
export interface ParkedPrHost {
  /** The pull request's repository, for a plan filing with no task in either catalog. */
  planFilingTarget?: ParkedPrTarget;
  /** W1-T13048: the task file from the repository that holds it (readParkedPrShard). */
  readTaskShard(taskId: string): Promise<ParkedPrShardRead>;
  /** R3: an id from reservePlanRepairTaskIdAsync, for the landing branch of `target`. W1-T13830: awaited, off the loop. */
  reserveTaskId(target: ParkedPrTarget): string | Promise<string>;
  /**
   * R3: lands new and amended task files through landTaskFilesAsync, in `target`. W1-T13830: `refusalChecks` names the
   * plan preflight checks that refused the draft (planPreflightRefusalChecks), only for a verdict on the draft itself.
   */
  landTaskFiles(files: readonly TaskFileInput[], target: ParkedPrTarget):
    Promise<{ prUrl?: string; error?: string; refusalChecks?: readonly string[] }>;
  closePr(prUrl: string, comment: string): Promise<void>;
  /** W1-T13047: the paths the pull request adds or changes, for a plan filing rebuilt from the pull request itself. */
  readPrFiles?(prUrl: string): Promise<readonly string[]>;
}

export interface ParkedPrSubject {
  prNumber: number;
  prUrl: string;
  headSha: string;
  taskId?: string;
  isPlanFiling?: boolean;
  unmetCriteria: readonly { claim: string; proof?: string; reason?: string }[];
  /** W1-T13047: the plan files a plan filing adds or changes; a rebuild with no readable task file is built from them. */
  planFiles?: readonly string[];
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
  /**
   * W1-T13361: what this pass read of the pull request. With it a fix-on-pr row records the body digest and the red
   * checks, and actOnParkedPr does not take a fix-on-pr that dispatches nothing a second time at the same head, body and
   * red checks. Without it the remedy is judged per head and cause, as before.
   */
  observed?: ParkedPrObserved;
}

/** W1-T13361: the state a later pass compares, and the sweep's own escalation for a ladder with no remedy left. */
export interface ParkedPrObserved {
  /** The digest of the pull request's body; undefined when the pass read no body. */
  bodyDigest: string | undefined;
  /** The red checks of the pull request, without the review's criteria. */
  redChecks: readonly string[];
  /** A red check's refusal line, where the check rollup carries one. */
  refusalLine(check: string): string | undefined;
  /** Opens one needs-human issue through the sweep's escalation. Absent on a pass that may not escalate (a light pass). */
  escalate?: (text: string) => void | Promise<void>;
  /** True when an open needs-human issue already names this pull request and head. */
  issueOpen(): boolean | Promise<boolean>;
}

/**
 * W1-T13361: true when the last fix-on-pr row taken for this pull request and cause recorded the head, the body digest
 * and the red checks this pass reads: the remedy left the pull request unchanged. A row that recorded no red checks was
 * written before the state was kept, and proves nothing. PURE.
 */
export function parkedPrUnchanged(ledger: readonly Record<string, unknown>[], pr: Pick<ParkedPrSubject, "prNumber" | "headSha">,
  cause: string, observed: Pick<ParkedPrObserved, "bodyDigest" | "redChecks">): boolean {
  const last = ledger.findLast(r => r.step === PARKED_PR_REMEDY_STEP && r.pr_number === pr.prNumber && r.cause === cause &&
    r.remedy === "fix-on-pr" && r.outcome === "taken");
  const names = (checks: readonly unknown[]) => JSON.stringify([...checks].map(String).sort());
  return last !== undefined && last.head_sha === pr.headSha && last.body_digest === observed.bodyDigest &&
    Array.isArray(last.red_checks) && names(last.red_checks) === names(observed.redChecks);
}

/**
 * W1-T13830: `unchanged` is set when a split or rebuild was refused by the plan preflight at this same input, so the
 * remedy reserved nothing, landed nothing and wrote no row. actOnParkedPr takes the ladder's next remedy.
 */
export interface ParkedPrOutcome { remedy: ParkedPrRemedy; reason: string; heldTaskId?: string; error?: string; unchanged?: true }

/**
 * W1-T13830, invariant:retry-on-transient: the sorted check names of the first refused or set-aside entry's plan
 * preflight failures. Undefined for anything that is not a verdict on the draft: no failures, a timed-out preflight,
 * or a red that main alone has. PURE.
 */
export function planPreflightRefusalChecks(landed: Pick<TaskFilesLandingResult, "refused" | "setAside">): string[] | undefined {
  const entry = landed.refused[0] ?? landed.setAside[0];
  if (entry === undefined || (entry.failures?.length ?? 0) === 0 || entry.timedOut === true || entry.mainRed === true) return undefined;
  return [...new Set(entry.failures!.map(f => f.check))].sort();
}

/** W1-T13830: the input a split or rebuild acts on: the head, the task file (or the plan files) and the moved criteria. */
function remedyInputDigest(remedy: ParkedPrRemedy, pr: ParkedPrSubject, shard: ParkedPrShard | undefined,
  decision: ParkedPrDecision): string {
  const source = shard === undefined ? { planFiles: [...new Set(pr.planFiles ?? [])].sort() } : { relPath: shard.relPath, text: shard.text };
  return createHash("sha256").update(JSON.stringify({ remedy, head: pr.headSha, source,
    criteria: decision.inputCriteria.map(c => c.claim).sort() })).digest("hex");
}

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

/** W1-T13361: the fields a row keeps of the state a pass read; none when the pass handed no state over. */
function observedFields(observed: ParkedPrObserved | undefined): Record<string, unknown> {
  if (observed === undefined) return {};
  return { ...(observed.bodyDigest === undefined ? {} : { body_digest: observed.bodyDigest }), red_checks: [...observed.redChecks].sort() };
}

/** Acts on `decision`: one row, and for a split or a close one held task. A later pass reuses that task. */
export async function takeParkedPrRemedy(pr: ParkedPrSubject, decision: ParkedPrDecision, ledger: readonly Record<string, unknown>[],
  host: ParkedPrHost, ctx: ParkedPrContext): Promise<ParkedPrOutcome> {
  const row = { run_id: ctx.runId, task_id: ctx.ledgerTaskId, step: PARKED_PR_REMEDY_STEP, pr_number: pr.prNumber,
    head_sha: pr.headSha, cause: ctx.cause, remedy: decision.remedy, text: ctx.text.slice(0, 2000) };
  if (decision.remedy === "fix-on-pr") {
    // W1-T13361: with the pass's state in hand the row records it, and a changed body or red check writes a new row.
    const written = ctx.observed !== undefined ? parkedPrUnchanged(ledger, pr, ctx.cause, ctx.observed)
      : ledger.some(r => r.step === PARKED_PR_REMEDY_STEP && r.pr_number === pr.prNumber &&
        r.head_sha === pr.headSha && r.cause === ctx.cause && r.remedy === "fix-on-pr" && r.outcome === "taken");
    if (!written) ctx.append({ ...row, outcome: "taken", reason: decision.reason, ...observedFields(ctx.observed) });
    return { remedy: decision.remedy, reason: decision.reason };
  }
  const prior = ledger.findLast(r => r.step === PARKED_PR_REMEDY_STEP && r.pr_number === pr.prNumber && r.cause === ctx.cause &&
    r.outcome === "taken" && typeof r.held_task_id === "string");
  if (prior !== undefined) {
    return { remedy: prior.remedy as ParkedPrRemedy, heldTaskId: prior.held_task_id as string,
      reason: `held task ${String(prior.held_task_id)} was filed for this pull request and cause; this pass reuses it` };
  }
  let inputDigest: string | undefined;
  let refusalChecks: string[] | undefined;
  try {
    const closed = decision.remedy === "close-and-rebuild";
    const read = pr.taskId === undefined ? undefined : await host.readTaskShard(pr.taskId);
    // W1-T13047: a plan filing with no readable task file is rebuilt from the pull request's own plan files.
    const fromPr = read?.outcome !== "read" && closed && pr.isPlanFiling === true;
    if (read?.outcome === "refused" && (!fromPr || (read.target === undefined && read.reason !== "task-absent"))) {
      throw new Error(read.reason);
    }
    if (!fromPr && read === undefined) throw new Error("the task file of the pull request cannot be read");
    if (fromPr && (pr.planFiles ?? []).length === 0) throw new Error("the plan files the pull request adds or changes cannot be read");
    const target = read?.target ?? host.planFilingTarget;
    if (target === undefined) throw new Error("the repository for the held plan rebuild cannot be resolved");
    // W1-T13830: the plan preflight refused this same input before, so a retry would get the same verdict.
    inputDigest = remedyInputDigest(decision.remedy, pr, read?.outcome === "read" ? read.shard : undefined, decision);
    const last = ledger.findLast(r => r.step === PARKED_PR_REMEDY_STEP && r.pr_number === pr.prNumber && r.cause === ctx.cause &&
      r.remedy === decision.remedy);
    if (last?.outcome === "refused" && last.input_digest === inputDigest && Array.isArray(last.refusal_checks) &&
        last.refusal_checks.length > 0) {
      return { remedy: decision.remedy, unchanged: true, reason: `the ${decision.remedy} remedy was refused by the plan preflight ` +
        `(${last.refusal_checks.map(String).join(", ")}) at this head, task file and criteria, so it is not tried again (W1-T13830)` };
    }
    const heldTaskId = await host.reserveTaskId(target);
    const files = read?.outcome === "read" ? heldTaskFiles(read.shard, pr.taskId!, heldTaskId, decision, pr, ctx)
      : heldPlanRebuildFiles(heldTaskId, decision, pr, ctx);
    const landed = await host.landTaskFiles(files, target);
    if ((landed.refusalChecks?.length ?? 0) > 0) refusalChecks = [...landed.refusalChecks!].sort();
    if (landed.error !== undefined) throw new Error(`the task files did not land: ${landed.error}`);
    if (closed) {
      await host.closePr(pr.prUrl, `Closed by the sweep (${pr.isPlanFiling === true ? "W1-T13047" : "W1-T12709"}): ` +
        `${pr.isPlanFiling === true ? "the plan-scoped round on this plan filing is exhausted, so it" : "no part of this pull request"} ` +
        `can merge without operator input. The held rebuild task ${heldTaskId} carries the question and this pull request's findings` +
        `${landed.prUrl === undefined ? "" : `, filed in ${landed.prUrl}`}. Answer it in the inbox and the rebuild runs.`);
    }
    ctx.append({ ...row, outcome: "taken", reason: decision.reason, held_task_id: heldTaskId,
      criteria: decision.inputCriteria.map(c => c.claim), ...(landed.prUrl === undefined ? {} : { landing_pr_url: landed.prUrl }),
      ...(closed ? { closed: true } : {}) });
    return { remedy: decision.remedy, heldTaskId,
      reason: `${decision.reason}: held task ${heldTaskId}${landed.prUrl === undefined ? "" : ` (${landed.prUrl})`}` };
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    ctx.append({ ...row, outcome: "refused", reason, ...(inputDigest === undefined ? {} : { input_digest: inputDigest }),
      ...(refusalChecks === undefined ? {} : { refusal_checks: refusalChecks }) });
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
  pr: ParkedPrSubject, ctx: ParkedPrContext): TaskFileInput[] {
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
  const files: TaskFileInput[] = [{ relPath: heldRel, content: stringify([held], { lineWidth: 0 }),
    claim: `the held ${split ? "follow-up" : "rebuild"} task ${heldTaskId} for ${pr.prUrl} is filed`, proof: `grep: id: ${heldTaskId} in ${heldRel}`, newFile: true }];
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

/**
 * W1-T13047: the held rebuild of a plan filing whose task file cannot be read. Its files are the plan files the pull
 * request adds or changes, and its rationale carries the red gates, the refusal and the plan files' paths.
 */
function heldPlanRebuildFiles(heldTaskId: string, decision: ParkedPrDecision, pr: ParkedPrSubject, ctx: ParkedPrContext):
  TaskFileInput[] {
  const files = [...new Set(pr.planFiles ?? [])].sort();
  const repo = /github\.com\/[^/]+\/([^/]+)\/pull\//.exec(pr.prUrl)?.[1] ?? "remudero";
  const title = `Rebuild the plan filing of pull request ${pr.prNumber}`;
  const question = (`Pull request ${pr.prUrl} is a plan filing that cannot merge without your input: ${decision.reason}. ` +
    `What it needs: ${ctx.text}`).slice(0, 1500);
  const acceptance = files.map(path => {
    const id = /\/tasks\.d\/(W\d+-T\d+)-/.exec(path)?.[1];
    return { claim: `${path} carries the plan change of ${pr.prUrl}, and the plan gates pass on it`,
      proof: id === undefined ? `manual-check: the plan gates pass on ${path}` : `grep: id: ${id} in ${path}` };
  });
  const held = { id: heldTaskId, title: `${title} (held rebuild)`, repo, type: "implement", files, status: "queued", attempts: 0,
    acceptance, needs_input: { question, source_pr: pr.prUrl, asked_at: ctx.nowIso },
    rationale: `REBUILD of the plan filing ${pr.prUrl}, filed by the sweep (W1-T13047) at ${pr.headSha}: ${decision.reason}.\n` +
      `RED GATES AND REFUSAL: ${ctx.text}\nPLAN FILES of the pull request:\n${files.map(f => `- ${f}`).join("\n")}\n` };
  const heldRel = posix.join(resolveRepoLayout("", () => undefined).planDir, "tasks.d", `${heldTaskId}-${slug(title)}.yaml`);
  return [{ relPath: heldRel, content: stringify([held], { lineWidth: 0 }),
    claim: `the held rebuild task ${heldTaskId} for ${pr.prUrl} is filed`, proof: `grep: id: ${heldTaskId} in ${heldRel}`, newFile: true }];
}

/** The number of criteria the task file declares for `taskId`, or undefined when it cannot be read. */
export async function taskCriteriaCount(host: Pick<ParkedPrHost, "readTaskShard">, taskId: string | undefined): Promise<number | undefined> {
  const read = taskId === undefined ? undefined : await host.readTaskShard(taskId);
  if (read?.outcome !== "read") return undefined;
  const seq = parseDocument(read.shard.text).toJSON() as unknown;
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
export async function parkedPrFacts(pr: ParkedPrSubject, input: { redChecks: readonly string[]; designQuestion?: string;
  designCoverage?: DesignHoldCoverage; fixModelOrder: readonly string[] }, ledger: readonly Record<string, unknown>[],
host: Pick<ParkedPrHost, "readTaskShard">): Promise<ParkedPrFacts> {
  const coverage = input.designQuestion === undefined ? undefined : input.designCoverage;
  const unmet = pr.unmetCriteria.map(c => {
    const covered = coverage?.criteria.includes(c.claim) === true;
    return { claim: c.claim, ...(c.proof === undefined ? {} : { proof: c.proof }), ...(c.reason === undefined ? {} : { reason: c.reason }),
      needsInput: input.designQuestion !== undefined && (coverage === undefined || covered),
      ladderSpent: covered || stallLadderSpent(stallRemedyRows(ledger, pr.prNumber, `review:${c.claim}`), { fixModelOrder: input.fixModelOrder }) };
  });
  const designHoldChecks = coverage === undefined ? [] : input.redChecks.filter(name => coverage.checks.includes(name));
  return { unmetCriteria: unmet, redChecks: input.redChecks, isPlanFiling: pr.isPlanFiling === true,
    ...(unmet.some(c => c.needsInput) ? { taskCriteria: await taskCriteriaCount(host, pr.taskId) } : {}),
    ...(designHoldChecks.length > 0 ? { designHoldChecks } : {}) };
}

/** The disposition and blocker the pull request goes on with once `remedy` is taken. PURE. */
function parkedPrAnswer(remedy: ParkedPrRemedy, facts: ParkedPrFacts): Pick<ParkedPrSweepOutcome, "disposition" | "blocker"> {
  const fixableUnmet = facts.unmetCriteria.some(c => !c.needsInput);
  if (remedy === "close-and-rebuild") return { disposition: "wait", blocker: "other" };
  if (remedy === "split-follow-up") {
    return fixableUnmet || facts.redChecks.length > 0
      ? { disposition: "blocked-fixable", blocker: fixableUnmet ? "review-failed" : "own-red" }
      : { disposition: "wait", blocker: "awaiting-review" };
  }
  if (facts.isPlanFiling) return { disposition: "wait", blocker: "own-red" };
  if (facts.unmetCriteria.length > 0) return { disposition: "blocked-fixable", blocker: "review-failed" };
  return facts.redChecks.length > 0 ? { disposition: "blocked-fixable", blocker: "own-red" }
    : { disposition: "post-review", blocker: "awaiting-review" };
}

/**
 * Takes the sweep's remedy and names the disposition the pull request goes on with. It is never refused-escalate.
 * W1-T13361: a fix-on-pr answered with a wait dispatches nothing, so one that left the head, the body and the red checks
 * unchanged is not taken again. The ladder's next remedy is taken, or with none left one needs-human issue is opened. A
 * fix-on-pr that hands the pull request to the fix lane or to review is that lane's to bound, and is judged as before.
 */
export async function actOnParkedPr(pr: ParkedPrSubject, decision: ParkedPrDecision, facts: ParkedPrFacts,
  ledger: readonly Record<string, unknown>[], host: ParkedPrHost, ctx: ParkedPrContext,
  spent: readonly ParkedPrRemedy[] = []): Promise<ParkedPrSweepOutcome> {
  if (ctx.observed !== undefined && decision.remedy === "fix-on-pr" && parkedPrAnswer("fix-on-pr", facts).disposition === "wait" &&
      parkedPrUnchanged(ledger, pr, ctx.cause, ctx.observed)) {
    const nowSpent = [...spent, "fix-on-pr" as const];
    const next = parkedPrRemedy(facts, nowSpent);
    return next === undefined ? askPerson(pr, facts, ledger, ctx, ctx.observed, spent)
      : actOnParkedPr(pr, next, facts, ledger, host, ctx, nowSpent);
  }
  const outcome = await takeParkedPrRemedy(pr, decision, ledger, host, ctx);
  // W1-T13830, invariant:never-parked: a split or rebuild refused at this same input is spent for this pass.
  if (outcome.unchanged === true) {
    const nowSpent = [...spent, decision.remedy];
    const next = parkedPrRemedy(facts, nowSpent);
    // No remedy left means fix-on-pr is spent too: parkedPrRemedy names fix-on-pr whenever it is left.
    return next !== undefined ? actOnParkedPr(pr, next, facts, ledger, host, ctx, nowSpent)
      : askPerson(pr, facts, ledger, ctx, ctx.observed, nowSpent.filter(r => r !== "fix-on-pr"));
  }
  if (outcome.error !== undefined) return { ...outcome, disposition: "wait", blocker: "other" };
  return { ...outcome, ...parkedPrAnswer(outcome.remedy, facts) };
}

/**
 * W1-T13361: no remedy is left for a pull request that fix-on-pr left unchanged. One needs-human issue is opened for
 * this head and body, through the sweep's escalation, and one row records it. The issue is opened before the row is
 * written, so an escalation that failed is tried again on the next pass. A pass that may not escalate leaves it to one
 * that may. The pull request keeps its wait.
 */
async function askPerson(pr: ParkedPrSubject, facts: ParkedPrFacts, ledger: readonly Record<string, unknown>[], ctx: ParkedPrContext,
  observed: ParkedPrObserved | undefined, refusedAtInput: readonly ParkedPrRemedy[] = []): Promise<ParkedPrSweepOutcome> {
  const answer = { remedy: "fix-on-pr" as const, ...parkedPrAnswer("fix-on-pr", facts) };
  const refused = refusedAtInput.length === 0 ? "" : `; ${refusedAtInput.join(" and ")} was refused by the plan preflight at ` +
    "this same input, so it is not tried again (W1-T13830)";
  const held = `fix-on-pr was taken at head ${pr.headSha.slice(0, 7)} and left the head, the body and the red checks unchanged, ` +
    `so it is not taken again (W1-T13361)${refused}, and no remedy is left`;
  if (observed === undefined) return { ...answer, reason: `${held}; the needs-human issue waits for a pass that reads the pull request's state` };
  if (ledger.some(r => r.step === PARKED_PR_REMEDY_STEP && r.pr_number === pr.prNumber && r.needs_human === true &&
      r.head_sha === pr.headSha && r.body_digest === observed.bodyDigest)) {
    return { ...answer, reason: `${held}; one needs-human issue was opened for this head and body` };
  }
  const escalate = observed.escalate;
  if (escalate === undefined) return { ...answer, reason: `${held}; the needs-human issue waits for a pass that may escalate` };
  const row = { run_id: ctx.runId, task_id: ctx.ledgerTaskId, step: PARKED_PR_REMEDY_STEP, pr_number: pr.prNumber, head_sha: pr.headSha,
    cause: ctx.cause, remedy: answer.remedy, outcome: "refused", text: ctx.text.slice(0, 2000), ...observedFields(observed) };
  const counts = new Map<string, number>();
  for (const r of ledger) {
    if (r.step === PARKED_PR_REMEDY_STEP && r.pr_number === pr.prNumber && r.outcome === "taken") {
      counts.set(String(r.remedy), (counts.get(String(r.remedy)) ?? 0) + 1);
    }
  }
  const tried = [...counts].map(([remedy, count]) => `${count} x ${remedy}`).join(", ");
  const red = observed.redChecks.map(check => {
    const line = observed.refusalLine(check);
    return line === undefined ? check : `${check} (${line})`;
  }).join("; ") || "none";
  try {
    const open = await observed.issueOpen();
    if (!open) await escalate(`${ctx.text} — ${held}. Red checks: ${red}. Remedies tried: ${tried}.`);
    const asked = open ? "an open needs-human issue already names this head, so no second one is opened"
      : `one needs-human issue is opened, naming the red checks (${red}) and the remedies tried (${tried})`;
    ctx.append({ ...row, needs_human: true, tried, reason: `${held}; ${asked}` });
    return { ...answer, reason: `${held}; ${asked}` };
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    ctx.append({ ...row, reason: `the needs-human issue could not be opened: ${reason}` });
    return { ...answer, error: reason, reason: `${held}; the needs-human issue could not be opened, and the next pass tries it again: ${reason}` };
  }
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
    ...(claim === undefined ? {} : { taskCriteria: await taskCriteriaCount(host, pr.taskId) }) });
  return takeParkedPrRemedy(pr, decision, ledger, host, { ...ctx, cause: `stall:${criterion}`, text: stalledOn });
}

/** W1-T13047: the cause of the remedy for a plan filing whose plan-scoped round is exhausted. */
export const PLAN_ROUND_EXHAUSTED_CAUSE = "plan-round-exhausted";

export interface PlanRoundExhaustedFacts {
  /** The red gates on the pull request; empty for a merge-conflict round. */
  redChecks: readonly string[];
  /** The log lines planLintViolationsFromCiFailures found. */
  violations: readonly string[];
  /** Why the plan-scoped round is exhausted: the repeated refusal, and the judge's verdict when it gave one. */
  refusal: string;
  /** True when the exhausted round was the plan-scoped merge-conflict round (mergeState dirty). */
  conflict?: boolean;
  /** Plan files the sweep already knows, such as the conflicting paths; host.readPrFiles adds the rest. */
  knownPlanFiles?: readonly string[];
}

/**
 * W1-T13047: a plan filing whose plan-scoped round is exhausted is closed and rebuilt as a held task, and no person is
 * asked through a needs-human issue. invariant:round-first, the sweep calls this only for an exhausted round.
 * invariant:one-question, takeParkedPrRemedy reuses the held task a prior pass filed for this pull request and cause.
 */
export async function planRoundExhaustedRemedy(pr: ParkedPrSubject & { changedFiles?: readonly string[] }, facts: PlanRoundExhaustedFacts,
  ledger: readonly Record<string, unknown>[], host: ParkedPrHost, ctx: Omit<ParkedPrContext, "cause" | "text">): Promise<ParkedPrSweepOutcome> {
  const red = facts.redChecks.length > 0 ? facts.redChecks.join(", ")
    : facts.conflict === true ? "none (a merge conflict, mergeState dirty)" : "a required check";
  const text = `the plan-scoped ${facts.conflict === true ? "conflict " : ""}round on this plan filing is exhausted. ` +
    `Red gates: ${red}.${facts.violations.length > 0 ? ` Its log names: ${facts.violations.join("; ")}.` : ""} ` +
    `Refusal: ${facts.refusal}`;
  const reason = `the plan-scoped round is exhausted, so the plan filing is closed and rebuilt as a held task`;
  const prior = ledger.some(r => r.step === PARKED_PR_REMEDY_STEP && r.pr_number === pr.prNumber &&
    r.cause === PLAN_ROUND_EXHAUSTED_CAUSE && r.outcome === "taken" && typeof r.held_task_id === "string");
  let read: readonly string[] = [];
  let readFailure = "";
  if (!prior && host.readPrFiles !== undefined) {
    try { read = await host.readPrFiles(pr.prUrl); } catch (error) {
      const reason = String((error as Error)?.message ?? error);
      readFailure = ` The pull request's file list could not be read: ${reason}.`;
    }
  }
  const planFiles = [...new Set([...(pr.planFiles ?? []), ...(facts.knownPlanFiles ?? []), ...(pr.changedFiles ?? []), ...read])]
    .filter(isInPlanScope).sort();
  const outcome = await takeParkedPrRemedy({ ...pr, isPlanFiling: true, planFiles }, { remedy: "close-and-rebuild", reason, inputCriteria: [] },
    ledger, host, { ...ctx, cause: PLAN_ROUND_EXHAUSTED_CAUSE, text: `${text}${readFailure}` });
  return { ...outcome, disposition: "wait", blocker: "other" };
}
