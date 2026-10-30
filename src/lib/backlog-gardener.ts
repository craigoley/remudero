import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ghJsonAsync } from "./github-transport.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";
import { parseOwnerRepoFromRemoteUrl } from "./onboard/inventory.js";

import { openDependentFanout } from "./dispatch-value.js";
import { clockFromMillisFn, systemClock, type Clock } from "./clock.js";
import { gardenLedgerBucket, type GardenAction, type GardenCheckout, type GardenerDeps, type GardenSpec } from "./gardener.js";
import { readMainHistory, type MainCommit } from "./hot-file-gardener.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { machineShardLandingRefusal, reparkStaleRuling } from "./machine-filing.js";
import { grepProofHolds, planCheapFingerprint, planInventory, planShards, retirementCandidates, type PlanInventory } from "./plan-gardener.js";
import { PR_OPEN_SATISFIED_BY_MAIN_STEP } from "./pr-open.js";
import { parseTasksFromYaml, type Task } from "./plan.js";
import { deriveTaskClass } from "./task-class.js";
import { lintTask } from "./task-linter.js";

/** W1-T4941: evidence-backed placement of the queue's unprioritized tasks. */
export type BacklogClass = "place" | "retire";
export const BACKLOG_CLASSES: readonly BacklogClass[] = ["place", "retire"];
export type BacklogDisposition = { kind: "band"; band: 2 | 3 | 4 } | { kind: "retire"; retirement: "closed" | "withdrawn" };
export interface BacklogEvidence {
  fanout: number;
  symptoms: Array<{ step: string; recent: number; previousDay: number; earlier: number }>;
  missingFiles: string[];
  presentFiles: string[];
  missingSymbols: string[];
  presentSymbols: string[];
  overtaken?: { sha: string; files: string[] };
  proofsHold: boolean;
  /** A build of this task changed only tests and its filed proof already passed at the merge base. */
  satisfiedByMain?: SatisfiedByMain;
  classValue?: { mean: number; attempts: number };
  /** Still-open PRs that the task's origin feedback names: the stall the task exists to clear. */
  heldPrs?: number[];
  signature: string;
}
/** What `pr.open_satisfied_by_main` recorded: a build that found nothing to change on main. */
export interface SatisfiedByMain { branch: string; headSha: string; files: string[] }
export interface BacklogAction extends GardenAction<BacklogClass> {
  disposition: BacklogDisposition;
  evidence: BacklogEvidence;
}
export interface BacklogInventory {
  plan: PlanInventory;
  candidates: BacklogAction[];
  mergeBudget: number;
  examined: number;
}
export interface BacklogSources {
  repoRoot: string;
  plan: () => PlanInventory;
  /** W1-T5363: called with exactly the steps the examined shards' evidence reads, never unfiltered. */
  ledger: (steps: readonly string[]) => readonly Record<string, unknown>[];
  history: (sinceIso: string) => readonly MainCommit[];
  mergedLastDay: () => number;
  clock: Clock;
  fileExists: (path: string) => boolean;
  proofsHolding: (plan: PlanInventory) => ReadonlySet<string>;
  /** Complete OPEN backlog proposals, read only by the daemon async inventory. */
  openDecisions?: () => Promise<readonly OpenBacklogDecision[]>;
  /** The repository's OPEN PR numbers, read only by the daemon async inventory with its open decisions. */
  openPrs?: () => Promise<OpenPrs>;
  /** Tasks a build showed main already satisfies, from `pr.open_satisfied_by_main` rows. */
  satisfiedByMain?: () => ReadonlyMap<string, SatisfiedByMain>;
  /** Whether every acceptance proof the task filed holds on main; default {@link ownProofsHoldOnMain}. */
  ownProofsHold?: (task: Task, shard: string | undefined) => boolean;
}

/** One complete read of the repository's open PRs: its `owner/repo` and every open PR number. */
export interface OpenPrs {
  repo: string;
  numbers: ReadonlySet<number>;
}

export interface OpenBacklogDecision {
  target: string;
  decision: string;
  prNumber: number;
  headSha: string;
}

/** Read complete OPEN pages, never infer availability from missing or unread ownership data. */
export async function readOpenBacklogDecisions(root: string, ports: {
  origin?: (root: string, args: string[]) => Promise<string>;
  pages?: (args: string[]) => Promise<unknown>;
} = {}): Promise<OpenBacklogDecision[]> {
  return (await readOpenBacklogState(root, ports)).decisions;
}

/** One open-PR read serves both the open decisions and the open PRs a task's origin feedback names. */
export async function readOpenBacklogState(root: string, ports: {
  origin?: (root: string, args: string[]) => Promise<string>;
  pages?: (args: string[]) => Promise<unknown>;
} = {}): Promise<{ decisions: OpenBacklogDecision[]; openPrs: OpenPrs }> {
  const remote = await (ports.origin ?? hostWorktreeGitAsync)(root, ["remote", "get-url", "origin"]);
  const repo = parseOwnerRepoFromRemoteUrl(remote.trim());
  if (!repo) throw new Error("backlog gardener: origin does not identify a GitHub repository");
  const pages = await (ports.pages ?? ghJsonAsync)(["api", "--paginate", "--slurp", `repos/${repo.owner}/${repo.repo}/pulls?state=open&per_page=100`]);
  if (!Array.isArray(pages) || pages.length === 0 || pages.some(page => !Array.isArray(page))) {
    throw new Error("backlog gardener: open-PR pages unreadable");
  }
  const decisions: OpenBacklogDecision[] = [];
  const numbers = new Set<number>();
  for (const page of pages) for (const pr of page) {
    if (!pr || typeof pr !== "object" || !Number.isSafeInteger(pr.number) || pr.number < 1 ||
        typeof pr.head?.ref !== "string" || typeof pr.head?.sha !== "string" || !/^[a-f0-9]{40}$/.test(pr.head.sha) ||
        !(typeof pr.body === "string" || pr.body === null)) {
      throw new Error("backlog gardener: open-PR ownership unreadable");
    }
    numbers.add(pr.number);
    if (!/^backlog-garden-\d+$/.test(pr.head.ref)) continue;
    if (pr.body === null || !pr.body.includes("The backlog gardener (W1-T4941) proposes these plan-only changes.")) {
      throw new Error("backlog gardener: open backlog decision body unreadable");
    }
    const matches = [...pr.body.matchAll(/^- \*\*(W\d+-T\d+)\*\*: (band [234]|closed|withdrawn)\./gm)];
    if (matches.length === 0) throw new Error("backlog gardener: open backlog decision unreadable");
    for (const match of matches) {
      decisions.push({ target: match[1]!, decision: match[2]!, prNumber: pr.number, headSha: pr.head.sha });
    }
  }
  return { decisions, openPrs: { repo: `${repo.owner}/${repo.repo}`, numbers } };
}

/**
 * The PRs a task's origin feedback names: the `/pull/<n>` URLs of this repository in `plan/feedback/<id>.yaml`.
 * A bare `#<n>` never counts: a feedback record quotes upstream text (a Dependabot body's release notes) whose
 * issue numbers no line shape separates from this repository's. Every dep-review record carries its own PR's
 * URL, which is all a band needs. 2026-10-30: W1-T11003 (origin
 * `feedback#fb-dep-review-69bc59bf88007e5e`) was banded 4, "no observed live symptom", while the three
 * Dependabot PRs its feedback named had sat open for two days waiting on it. A task with no feedback origin,
 * or no feedback record, names none.
 */
export function originFeedbackPrs(repoRoot: string, task: Task, repo: string): number[] {
  const id = /^feedback#(fb-[A-Za-z0-9_-]+)$/.exec(task.origin ?? "")?.[1];
  if (id === undefined) return [];
  const path = join(repoRoot, "plan", "feedback", `${id}.yaml`);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const named = new Set<number>();
  for (const m of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/g)) if (m[1]!.toLowerCase() === repo.toLowerCase()) named.add(Number(m[2]));
  return [...named].sort((a, b) => a - b);
}

const backlogDecision = (action: BacklogAction): string => action.disposition.kind === "band"
  ? `band ${action.disposition.band}` : action.disposition.retirement;

/** The newest `pr.open_satisfied_by_main` row per task. */
export function satisfiedByMainFromRows(rows: readonly Record<string, unknown>[]): Map<string, SatisfiedByMain> {
  const out = new Map<string, SatisfiedByMain>();
  for (const row of rows) {
    if (row.step !== PR_OPEN_SATISFIED_BY_MAIN_STEP || typeof row.task_id !== "string") continue;
    const files = Array.isArray(row.changed_files) ? row.changed_files.filter((f): f is string => typeof f === "string") : [];
    out.set(row.task_id, { branch: String(row.branch ?? ""), headSha: String(row.head_sha ?? ""), files });
  }
  return out;
}

const MARKER = /^ {2}# backlog gardener: band=(2|3|4) evidence=([a-f0-9]{16})$/m;
/** W1-T9053: when the gardener last placed a band, so a re-band waits out a day. */
const PLACED = /^ {2}# backlog gardener: placed=(\S+)[ \t]*$/m;
const REBAND_FLOOR_MS = 24 * 3_600_000;
const DECLARED_PRIORITY = /^ {2}priority: (-?\d+(?:\.\d+)?)[ \t]*$/m;
const DECLARED_PRIORITY_LINE = /^ {2}priority: -?\d+(?:\.\d+)?[ \t]*\n/m;
const STEP = /\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\b/g;
const physicalFiles = (task: Task): string[] => (task.files ?? []).filter((p) => !/[?*\[\]{}]/.test(p));
const filingNumber = (id: string): number => Number(/-T(\d+)/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER);
const evidenceHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
/** The step `backlogEvidence` reads for every examined shard, cited or not: its class-value lookup. */
export const BACKLOG_CLASS_VALUE_STEP = "dispatch.value.calibrated";

/** The one citation rule: explicit ledger step names in the shard's title/rationale, file names excluded. */
export function backlogCitedSteps(task: Task): string[] {
  return [...new Set([...(task.title + "\n" + (task.rationale ?? "")).matchAll(STEP)].map((m) => m[0]!).filter((s) => !s.includes(".ts") && !s.includes(".md")))];
}

/** W1-T5363: the union read is bounded to the steps the evidence reads. No `sinceTs`: the `earlier`
 * window and the latest class value both reach back without limit, so the oldest window is not finite. */
export function readBacklogLedgerRecords(stateDir: string, steps: readonly string[], reader: typeof readLedgerUnionRecordsSync = readLedgerUnionRecordsSync): readonly Record<string, unknown>[] {
  const result = reader(stateDir, { step: steps, refuseIncomplete: true });
  if (!result.ok) throw new Error(`backlog gardener: incomplete ledger union: ${result.unread.join(", ")}`);
  return result.rows;
}

/**
 * Whether the task's OWN acceptance proofs all hold on main, each `grep:` proof read the way check-proof reads it
 * (`grep -arn` over the checkout). A proof that is not a grep, or a task with no proof beyond a grep of its own
 * shard, cannot be read here and never counts as holding.
 */
export function ownProofsHoldOnMain(repoRoot: string, task: Task, shard: string | undefined): boolean {
  const proofs = (task.acceptance ?? []).map((c) => c.proof ?? "");
  const outside = proofs.filter((p) => shard === undefined || !p.trim().endsWith(` in ${shard}`));
  return outside.length > 0 && proofs.every((p) => grepProofHolds(repoRoot, p));
}

/**
 * A merged PR that covered every declared file is a lead, never proof: every selector-edge task declares the same
 * two files, so one selector fix "covered" all of them (#10740 withdrew W1-T5161 and W1-T6007 on #10699, which
 * added neither edge). So the task's own acceptance proofs must also hold on main.
 */
function overtakenBy(task: Task, history: readonly MainCommit[], ownProofsHold: () => boolean): BacklogEvidence["overtaken"] {
  const files = physicalFiles(task);
  if (files.length < 2) return undefined;
  for (const commit of history) {
    if (!/\(#\d+\)$/.test(commit.subject)) continue;
    const shared = files.filter((p) => commit.files.includes(p));
    if (shared.length >= 2 && shared.length === files.length) return ownProofsHold() ? { sha: commit.sha, files: shared } : undefined;
  }
  return undefined;
}

/** Only explicit ledger step names in the shard's rationale/title are queried. A historical hit is
 * the positive control for claiming that a symptom stopped; an absent step is never such evidence. */
export function backlogEvidence(
  task: Task,
  repoRoot: string,
  fanout: ReadonlyMap<string, number>,
  rows: readonly Record<string, unknown>[],
  history: readonly MainCommit[],
  now: Date,
  fileExists: (path: string) => boolean,
  proofsHold: boolean,
  satisfiedByMain?: SatisfiedByMain,
  ownProofsHold: () => boolean = () => false,
  heldPrs: readonly number[] = [],
): BacklogEvidence {
  const since = now.getTime() - 24 * 3_600_000;
  const previousSince = since - 24 * 3_600_000;
  const mentioned = backlogCitedSteps(task);
  const symptoms = mentioned.map((step) => {
    const hits = rows.filter((r) => r.step === step && typeof r.ts === "string" && Number.isFinite(Date.parse(r.ts)));
    return {
      step,
      recent: hits.filter((r) => Date.parse(r.ts as string) >= since).length,
      previousDay: hits.filter((r) => Date.parse(r.ts as string) >= previousSince && Date.parse(r.ts as string) < since).length,
      earlier: hits.filter((r) => Date.parse(r.ts as string) < since).length,
    };
  });
  const files = physicalFiles(task);
  const missingFiles = files.filter((p) => !fileExists(p));
  const presentFiles = files.filter((p) => fileExists(p));
  const symbols = [...new Set([...(task.rationale ?? "").matchAll(/`([A-Za-z_$][A-Za-z0-9_$]{2,})`/g)].map((m) => m[1]!).filter((s) => !["priority", "status", "queued", "retirement"].includes(s)))];
  const source = presentFiles.flatMap((p) => {
    try { return symbols.length > 0 ? [readFileSync(join(repoRoot, p), "utf8")] : []; }
    catch (error) { throw new Error(`backlog gardener: cannot read ${p} for symbol evidence`, { cause: error }); }
  }).join("\n");
  const presentSymbols = symbols.filter((s) => source.includes(s));
  const missingSymbols = symbols.filter((s) => !source.includes(s));
  const overtaken = overtakenBy(task, history, ownProofsHold);
  const classValue = [...rows].reverse().find((r) => r.step === BACKLOG_CLASS_VALUE_STEP && r.task_class === deriveTaskClass(task) && typeof r.mean === "number" && typeof r.attempts === "number");
  const value = classValue ? { mean: classValue.mean as number, attempts: classValue.attempts as number } : undefined;
  const facts = { fanout: fanout.get(task.id) ?? 0, symptoms, missingFiles, presentFiles, missingSymbols, presentSymbols, overtaken, proofsHold, ...(satisfiedByMain ? { satisfiedByMain } : {}), classValue: value, ...(heldPrs.length > 0 ? { heldPrs: [...heldPrs] } : {}) };
  return { ...facts, signature: evidenceHash(facts) };
}

/** Retirement requires proof or a merged replacement, not an unexplained quiet period. */
export function judgeBacklog(e: BacklogEvidence): { disposition: BacklogDisposition; reason: string } {
  if (e.satisfiedByMain) return { disposition: { kind: "retire", retirement: "closed" }, reason: `Its build on ${e.satisfiedByMain.branch} (${e.satisfiedByMain.headSha.slice(0, 12)}) changed only tests (${e.satisfiedByMain.files.join(", ")}) and its filed proof already passed at the merge base: main ships the behaviour.` };
  if (e.proofsHold) return { disposition: { kind: "retire", retirement: "closed" }, reason: "Acceptance proofs now hold on main and did not at filing." };
  if (e.overtaken) return { disposition: { kind: "retire", retirement: "withdrawn" }, reason: `Merged commit ${e.overtaken.sha} covered its declared surface: ${e.overtaken.files.join(", ")}, and every acceptance proof it filed holds on main.` };
  if (e.heldPrs?.length) return { disposition: { kind: "band", band: 2 }, reason: `Its origin feedback names ${e.heldPrs.length} still-open PR(s) waiting on it: ${e.heldPrs.map((n) => `#${n}`).join(", ")}.` };
  if (e.fanout > 0 || e.symptoms.some((s) => s.recent > 0 && s.recent >= 2 * s.previousDay)) return { disposition: { kind: "band", band: 2 }, reason: e.fanout > 0 ? `Unblocks ${e.fanout} open dependent(s).` : "Its cited symptom is growing against the previous day." };
  if (e.symptoms.some((s) => s.recent > 0)) return { disposition: { kind: "band", band: 3 }, reason: "Its cited symptom remains live." };
  return { disposition: { kind: "band", band: 4 }, reason: "No observed live symptom or open dependent; the task remains valid." };
}

export function backlogInventory(sources: BacklogSources, include: (action: BacklogAction) => boolean = () => true, openPrs?: OpenPrs): BacklogInventory {
  const plan = sources.plan();
  const now = sources.clock.date();
  const mergeBudget = Math.max(0, Math.floor(sources.mergedLastDay()));
  if (mergeBudget === 0) return { plan, candidates: [], mergeBudget, examined: 0 };
  const eligible: Array<{ task: Task; marker: RegExpExecArray | null }> = [];
  // Held back by a declared priority unless a build showed main already satisfies them.
  const prioritized: Array<{ task: Task; marker: RegExpExecArray | null }> = [];
  for (const task of [...plan.open].sort((a, b) => filingNumber(a.id) - filingNumber(b.id) || a.id.localeCompare(b.id))) {
    const rel = plan.shards.get(task.id);
    if (!rel) continue;
    // W1-T6307: the machine-filing judge prices an unjudged machine task when it rules; banding it
    // first races that write, and update-branch merges both lines into one shard (#9979).
    if (task.author_class === "machine" && task.risk_ruling === undefined) continue;
    const text = readFileSync(join(sources.repoRoot, rel), "utf8");
    const marker = MARKER.exec(text);
    // A marked priority is ours only while it still equals the band in our marker. Any other
    // priority, including an operator amendment of a previously banded task, is authoritative.
    if (task.priority !== undefined && (!marker || task.priority !== Number(marker[1]))) {
      prioritized.push({ task, marker });
      continue;
    }
    eligible.push({ task, marker });
  }
  // W1-T5363: read only what the evidence of a shard this pass may examine can query.
  // A prioritized shard is never examined, so only its satisfied-by-main evidence is read for it.
  const steps =
    eligible.length > 0 ? [...new Set([BACKLOG_CLASS_VALUE_STEP, PR_OPEN_SATISFIED_BY_MAIN_STEP, ...eligible.flatMap(({ task }) => backlogCitedSteps(task))])].sort()
    : prioritized.length > 0 ? [PR_OPEN_SATISFIED_BY_MAIN_STEP]
    : [];
  const rows = steps.length === 0 ? [] : sources.ledger(steps);
  const satisfied = sources.satisfiedByMain?.() ?? satisfiedByMainFromRows(rows);
  eligible.push(...prioritized.filter(({ task }) => satisfied.has(task.id)));
  const history = sources.history(clockFromMillisFn(() => now.getTime() - 7 * 24 * 3_600_000).iso());
  const openIds = new Set(plan.open.map((t) => t.id));
  const fanout = openDependentFanout(plan.all, openIds);
  const proofsHolding = sources.proofsHolding(plan);
  const candidates: BacklogAction[] = [];
  let examined = 0;
  for (const { task, marker } of eligible) {
    if (examined >= mergeBudget) break;
    const ownProofsHold = () => (sources.ownProofsHold ?? ((t, shard) => ownProofsHoldOnMain(sources.repoRoot, t, shard)))(task, plan.shards.get(task.id));
    const held = openPrs === undefined ? [] : originFeedbackPrs(sources.repoRoot, task, openPrs.repo).filter((n) => openPrs.numbers.has(n));
    const evidence = backlogEvidence(task, sources.repoRoot, fanout, rows, history, now, sources.fileExists, proofsHolding.has(task.id), satisfied.get(task.id), ownProofsHold, held);
    const judged = judgeBacklog(evidence);
    // A new evidence sample is not a new placement decision. In particular, rolling ledger
    // counts change every day even while the chosen band remains the same.
    if (marker && judged.disposition.kind === "band" && judged.disposition.band === Number(marker[1])) continue;
    // W1-T9053: a band placed within the last day stands; routine volume does not re-band it.
    const placedAt = PLACED.exec(readFileSync(join(sources.repoRoot, plan.shards.get(task.id)!), "utf8"));
    if (marker && placedAt && judged.disposition.kind === "band" && (now.getTime() - Date.parse(placedAt[1]!)) >= 0 && now.getTime() - Date.parse(placedAt[1]!) < REBAND_FLOOR_MS) continue;
    const action: BacklogAction = { class: judged.disposition.kind === "retire" ? "retire" : "place", target: task.id, reason: judged.reason, disposition: judged.disposition, evidence };
    if (!include(action)) continue;
    examined++;
    candidates.push(action);
  }
  return { plan, candidates, mergeBudget, examined };
}

function describe(e: BacklogEvidence): string {
  const symptoms = e.symptoms.length ? e.symptoms.map((s) => `${s.step}: ${s.recent} in trailing day, ${s.earlier} earlier`).join("; ") : "no ledger step cited";
  return `fanout=${e.fanout}; symptoms=${symptoms}; files present=${e.presentFiles.join(", ") || "none"}; missing=${e.missingFiles.join(", ") || "none"}; symbols present=${e.presentSymbols.join(", ") || "none"}; missing=${e.missingSymbols.join(", ") || "none"}; merged surface=${e.overtaken?.sha ?? "none"}; proofs=${e.proofsHold ? "hold" : "not proven"}; satisfied by main=${e.satisfiedByMain ? `${e.satisfiedByMain.branch} changed only ${e.satisfiedByMain.files.join(", ")}` : "no"}; class value=${e.classValue ? `${e.classValue.mean} over ${e.classValue.attempts} attempts` : "unavailable"}${e.heldPrs?.length ? `; held open PRs=${e.heldPrs.map((n) => `#${n}`).join(", ")}` : ""}`;
}

export function applyBacklogActions(root: string, shards: ReadonlyMap<string, string>, actions: readonly BacklogAction[], now?: Date): string[] {
  const paths: string[] = [];
  for (const action of actions) {
    const rel = shards.get(action.target);
    if (!rel) continue;
    const path = join(root, rel);
    const text = readFileSync(path, "utf8");
    const old = MARKER.exec(text);
    const oldBand = old ? Number(old[1]) : undefined;
    // W1-T6307: any numeric value is a declared priority — the machine-filing judge writes `2.5`.
    const priorities = text.match(/^ {2}(?:priority|["']priority["'])[ \t]*:[^\r\n]*$/gm) ?? [];
    const declared = DECLARED_PRIORITY.exec(text);
    // W1-T9053: main already carries this band; new evidence alone is not a placement.
    if (action.disposition.kind === "band" && oldBand === action.disposition.band) continue;
    if (!/^ {2}status: queued[ \t]*$/m.test(text) || /^ {2}retirement:/m.test(text)) continue;
    if (priorities.length && (priorities.length !== 1 || !declared)) continue;
    if (declared && (!old || Number(declared[1]) !== oldBand) && action.evidence.satisfiedByMain === undefined) continue;
    let next = old ? text.replace(/^ {2}# backlog gardener: band=(?:2|3|4) evidence=[a-f0-9]{16}\r?\n?/m, "") : text;
    next = next.replace(/^ {2}# backlog gardener: placed=\S+[ \t]*\r?\n?/m, "");
    if (action.disposition.kind === "band") {
      const band = action.disposition.band;
      next = declared ? next.replace(DECLARED_PRIORITY, `  priority: ${band}`) : next.replace(/^ {2}status: queued[ \t]*$/m, `  priority: ${band}\n  status: queued`);
      next = next.replace(/^ {2}status: queued[ \t]*$/m, `  status: queued\n  # backlog gardener: band=${band} evidence=${action.evidence.signature}${now ? `\n  # backlog gardener: placed=${now.toISOString()}` : ""}`);
    } else {
      next = next.replace(DECLARED_PRIORITY_LINE, "");
      next = next.replace(/^ {2}status: queued[ \t]*$/m, `  status: blocked\n  retirement: ${action.disposition.retirement}\n  # backlog gardener: retirement evidence=${action.evidence.signature}`);
    }
    // A band or retirement edits a pinned field (`priority`); a judged machine record goes back to the judge.
    next = reparkStaleRuling(next, rel);
    if (next === text) continue;
    writeFileSync(path, next);
    paths.push(rel);
  }
  return paths.sort();
}

/**
 * What lint-plan and the shard census (test/every-shard-on-main-is-lintable.test.ts) would refuse in a backlog
 * landing, checked before its PR is drafted: #10474's machine-filing admission and lint for machine records, and
 * for every record in a landed shard, a blocking lint violation its copy in `deps.repoRoot` did not carry.
 * 2026-10-10: four landings in a row were refused by the plan-PR preflight on machine-author-verify and the census.
 */
export function backlogLandingGuard(deps: Pick<GardenerDeps, "repoRoot" | "landingRefusal">): (root: string, paths: readonly string[]) => string | undefined {
  if (deps.landingRefusal) return deps.landingRefusal;
  const parse = (dir: string, rel: string): Task[] | Error => {
    try {
      return existsSync(join(dir, rel)) ? parseTasksFromYaml(readFileSync(join(dir, rel), "utf8"), rel) : [];
    } catch (e) {
      // Not erased: the caller compares it with the base copy and refuses a shard only this landing broke.
      return e as Error;
    }
  };
  return (root, paths) => {
    const reasons: string[] = [];
    const blocks = (task: Task | undefined): Map<string, string> => new Map((task === undefined ? [] : lintTask(task, { moduleExists: (p) => existsSync(join(root, p)) }).violations)
      .filter((v) => v.severity === "block").map((v) => [v.check, v.message]));
    for (const rel of paths.filter((p) => /(^|\/)tasks\.d\/[^/]+\.ya?ml$/.test(p) && existsSync(join(root, p)))) {
      const head = parse(root, rel);
      const base = parse(deps.repoRoot, rel);
      // Only what this change introduces: a shard that already failed to load is not this landing's doing.
      if (head instanceof Error) {
        if (!(base instanceof Error)) reasons.push(`${rel}: does not load: ${head.message}`);
        continue;
      }
      if (head.some((t) => t.author_class === "machine")) {
        const machine = machineShardLandingRefusal(root, [rel], (p) => existsSync(join(deps.repoRoot, p)));
        if (machine !== undefined) reasons.push(machine);
      }
      for (const task of head) {
        if (task.author_class === "machine") continue; // linted whole, with admission, above
        const had = blocks(base instanceof Error ? undefined : base.find((b) => b.id === task.id));
        for (const [check, message] of blocks(task)) if (!had.has(check)) reasons.push(`${rel}: ${task.id}: ${check}: ${message}`);
      }
    }
    return reasons.length > 0 ? reasons.join("; ") : undefined;
  };
}

export function backlogGardenSpec(
  deps: GardenerDeps,
  overrides: Partial<BacklogSources> = {},
  reader: typeof readLedgerUnionRecordsSync = readLedgerUnionRecordsSync,
): GardenSpec<BacklogClass, BacklogInventory, BacklogAction, GardenCheckout> {
  const clock = overrides.clock ?? deps.clock ?? systemClock;
  const sources: BacklogSources = {
    repoRoot: deps.repoRoot,
    plan: () => planInventory(deps.repoRoot, deps.stateDir),
    ledger: (steps) => readBacklogLedgerRecords(deps.stateDir, steps, reader),
    history: (since) => readMainHistory(deps.repoRoot, since),
    mergedLastDay: () => readMainHistory(deps.repoRoot, clockFromMillisFn(() => clock.now() - 24 * 3_600_000).iso()).filter((c) => /\(#\d+\)$/.test(c.subject)).length,
    clock,
    fileExists: (path) => existsSync(join(deps.repoRoot, path)),
    proofsHolding: (plan) => new Set(retirementCandidates(plan, deps.repoRoot).filter((a) => a.retirement === "closed").map((a) => a.target)),
    ...overrides,
  };
  return {
    name: "backlog",
    classes: BACKLOG_CLASSES,
    review: { place: "priority placement is a judgement call.", retire: "retirement is a judgement call." },
    landingRefusal: backlogLandingGuard(deps),
    cheapFingerprint: () => `${planCheapFingerprint(deps.repoRoot, deps.stateDir)}:${gardenLedgerBucket(deps.clock ?? systemClock)}`,
    inventory: () => backlogInventory(sources),
    inventoryAsync: async () => {
      const state = sources.openDecisions === undefined && sources.openPrs === undefined
        ? await readOpenBacklogState(deps.repoRoot)
        : { decisions: await (sources.openDecisions ?? (() => readOpenBacklogDecisions(deps.repoRoot)))(), openPrs: await sources.openPrs?.() };
      const open = state.decisions;
      return backlogInventory(sources, action => {
        const decisions = open.filter(pr => pr.target === action.target && pr.decision === backlogDecision(action));
        if (decisions.length > 0) deps.log("backlog.open_decision_deferred", { decisions });
        return decisions.length === 0;
      }, state.openPrs);
    },
    fingerprint: (i) => i.candidates.map((a) => `${a.target}:${a.evidence.signature}`).join("|") + `:${i.mergeBudget}`,
    unfinished: (i) => i.candidates.length > 0,
    candidates: (i) => i.candidates,
    scorecard: (i) => ({ open: i.plan.open.length, examined: i.examined, merge_budget: i.mergeBudget, proposed: i.candidates.length }),
    apply: (ws, plan) => {
      const shards = planShards(ws.root);
      const paths = applyBacklogActions(ws.root, shards, plan.actions, clock.date());
      if (paths.length === 0) return undefined;
      const landed = plan.actions.filter((a) => paths.includes(shards.get(a.target) ?? ""));
      return {
        paths,
        title: `chore(plan): backlog gardener proposes ${plan.acting[0]} for ${landed.length} task(s)`,
        body: ["The backlog gardener (W1-T4941) proposes these plan-only changes. Close this PR to decline them.", "", ...landed.map((a) => `- **${a.target}**: ${a.disposition.kind === "band" ? `band ${a.disposition.band}` : a.disposition.retirement}. ${a.reason} Evidence: ${describe(a.evidence)}. Shard: \`${shards.get(a.target)}\`.`), "", "## Acceptance", ...landed.map((a) => `- claim: ${a.target} carries the proposed backlog decision\n  proof: grep: # backlog gardener: ${a.disposition.kind === "band" ? `band=${a.disposition.band}` : "retirement"} evidence=${a.evidence.signature} in ${shards.get(a.target)}`)].join("\n"),
      };
    },
  };
}
