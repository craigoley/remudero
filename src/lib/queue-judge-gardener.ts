import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { clockFromMillisFn, systemClock, type Clock } from "./clock.js";
import { filingDatesFromPlanHistory, openDependentFanout } from "./dispatch-value.js";
import type { Escalation } from "./escalate.js";
import { writeAtomic } from "./fs-race-safe.js";
import {
  gardenEffectsPath, gardenStatePath, initialGardenState, readGardenEffects, readGardenState, writeGardenEffects,
  type GardenAction, type GardenCheckout, type GardenEffect, type GardenerDeps, type GardenSpec,
} from "./gardener.js";
import { medianMs } from "./gardener-runtime.js";
import { readMainHistory, type MainCommit } from "./hot-file-gardener.js";
import { readIncidentLifecycleStore, type IncidentLifecycleRecord } from "./incident-lifecycle.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { reparkStaleRuling } from "./machine-filing.js";
import { backlogCitedSteps, backlogLandingGuard } from "./backlog-gardener.js";
import { streakRefusal } from "./non-worker-verdict.js";
import { planInventory, planShards, type PlanInventory } from "./plan-gardener.js";
import type { Task } from "./plan.js";
import { spawnSync } from "node:child_process";

/**
 * W1-T9925: an LLM judge re-ranks the queue by measured cost of delay, and is judged on its own predictions.
 *
 * Dispatch (dispatch-value.ts) already turns `priority` into urgency; this gardener makes the number mean something
 * again by rewriting a queued task's `priority:` through its own reviewed plan PR, with a one-line reason on the
 * priority line (the repo's existing reason field) and a marker beneath `status: queued`. Nothing here is a fixed
 * cap: the cadence, the size of a pass and the judge's authority are each read from a measurement (its own review
 * cost, the fleet's starts per hour, its scored predictions) and reported with their inputs.
 */

export type QueueJudgeClass = "raise" | "lower";
export const QUEUE_JUDGE_CLASSES: readonly QueueJudgeClass[] = ["raise", "lower"];
export const QUEUE_JUDGE_NAME = "queue-judge";

type Row = Record<string, unknown>;

/** The operator's rule for what a priority measures, carried verbatim into the judge's prompt. */
export const COST_OF_DELAY_RULE =
  "cost of delay = what waiting costs (dependents and capacity unblocked, incidents and red PRs it ends, protective intent), never the task's age alone";

export const QUEUE_JUDGE_PREDICTION_STEP = "queue_judge.prediction";
export const QUEUE_JUDGE_OUTCOME_STEP = "queue_judge.outcome";
const ESCALATED_STEP = "queue_judge.escalated";
const UNAVAILABLE_STEP = "queue_judge.unavailable";

/** The queue judge's own rows are read without a window: a prediction is scored whenever its task resolves. */
const OWN_STEPS = [QUEUE_JUDGE_PREDICTION_STEP, QUEUE_JUDGE_OUTCOME_STEP, ESCALATED_STEP] as const;
/** The rest of the evidence, each step named: the read is never an unfiltered union (W1-T5363). */
const EVIDENCE_STEPS = [
  "run.start", "verdict", "verdict.merged", "review.posted", "backlog.scorecard", "sweep.disposed",
  "escalation.issue_opened", "escalation.auto_resolved", "escalation.superseded", "dispatch.cost_of_delay.ready",
] as const;
/** A read window, not a policy bound: how far back evidence rows are read. */
const EVIDENCE_WINDOW_MS = 30 * 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const PLAN_TASK_ID = /^[A-Z][A-Z0-9]*-T\d+$/;
const STUCK_DISPOSITION = /^(?:blocked|refused|conflicted|held|escalat)/;

// ── shard text ───────────────────────────────────────────────────────────────────────────────────────────────────

const PRIORITY_LINE = /^ {2}priority:[ \t]*(-?\d+(?:\.\d+)?)[ \t]*(?:#[ \t]*(.*?))?[ \t]*$/m;
const ANY_PRIORITY_KEY = /^ {2}(?:priority|["']priority["'])[ \t]*:/gm;
const QUEUE_MARKER = /^ {2}# queue judge: priority=(-?\d+(?:\.\d+)?) evidence=([a-f0-9]{16})[ \t]*$/m;
const OPERATOR_PIN = /^operator[- ]\d{4}-\d{2}-\d{2}/;
const evidenceHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

export interface ShardPriority {
  /** The declared value, or undefined when the shard declares none. */
  value: number | undefined;
  comment: string | undefined;
  /** An operator pinned this line (`# operator-YYYY-MM-DD` or `# operator YYYY-MM-DD`). */
  operatorPin: boolean;
  /** The judge's own marker value, when the shard carries one. */
  marker: number | undefined;
  /** The marker names a value the priority no longer holds: someone else edited it after the judge. */
  editedSinceMarker: boolean;
  /** More than one priority key, or one the line rule cannot read: the shard cannot be edited safely. */
  unreadable: boolean;
}

export function readShardPriority(text: string): ShardPriority {
  const keys = text.match(ANY_PRIORITY_KEY) ?? [];
  const line = PRIORITY_LINE.exec(text);
  const marker = QUEUE_MARKER.exec(text);
  const value = line ? Number(line[1]) : undefined;
  const markerValue = marker ? Number(marker[1]) : undefined;
  return {
    value, comment: line?.[2], operatorPin: line?.[2] !== undefined && OPERATOR_PIN.test(line[2]),
    marker: markerValue, editedSinceMarker: markerValue !== undefined && value !== markerValue,
    unreadable: keys.length > 1 || (keys.length === 1 && line === null),
  };
}

// ── evidence ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EvidenceFact { ref: string; text: string; source: string }

export interface EvidencePack {
  id: string;
  title: string;
  priority: number | null;
  /** The priority is not the judge's to raise in number: an operator pin, or an edit made after the judge's marker. */
  pinned: boolean;
  facts: EvidenceFact[];
  /** Every dependent the judge may name as unblocked (transitive), every incident and PR it may name as ended. */
  dependents: string[];
  incidents: string[];
  prs: number[];
  heldBy: string | undefined;
  signature: string;
}

export interface QueueJudgeSources {
  repoRoot: string;
  stateDir: string;
  clock: Clock;
  plan: () => PlanInventory;
  readShard: (rel: string) => string;
  /** Rows of exactly the named steps; `sinceIso` bounds the read, absent reads each step whole. */
  ledger: (steps: readonly string[], sinceIso?: string) => readonly Row[];
  incidents: () => readonly IncidentLifecycleRecord[];
  openPrNumbers: () => ReadonlySet<number>;
  /** Task id → filing time (ms), from first-parent plan history. */
  filingDates: () => ReadonlyMap<string, number>;
  history: (sinceIso: string) => readonly MainCommit[];
  /** Distinct tasks filed, merged, retired or re-prioritized on main's first-parent plan history since `sinceSha`. */
  churn: (sinceSha: string | undefined) => { head: string; changed: number };
  /** One tool-less judge spawn. */
  judgeText: (prompt: string) => Promise<string>;
  /** Tasks with a run in flight and the files they declare, for the file-overlap holder. */
  inFlight?: (rows: readonly Row[]) => ReadonlyMap<string, readonly string[]>;
}

const newestFirst = (rows: readonly Row[]): Row[] => [...rows].sort((a, b) => Date.parse(String(b.ts)) - Date.parse(String(a.ts)));
const tsMs = (row: Row): number => Date.parse(String(row.ts));
const physicalFiles = (task: Task): string[] => (task.files ?? []).filter((p) => !/[?*\[\]{}]/.test(p));

/** Runs with a `run.start` and no closing row in the evidence window, newest start per task. */
export function inFlightTasks(rows: readonly Row[], tasks: readonly Task[]): Map<string, readonly string[]> {
  const closed = new Set(rows.filter((r) => (r.step === "verdict" || r.step === "verdict.merged") && typeof r.run_id === "string").map((r) => r.run_id as string));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Map<string, readonly string[]>();
  for (const r of rows) {
    if (r.step !== "run.start" || typeof r.run_id !== "string" || typeof r.task_id !== "string" || closed.has(r.run_id)) continue;
    const task = byId.get(r.task_id);
    if (task) out.set(task.id, physicalFiles(task));
  }
  return out;
}

/** An escalation is open until a later row settles its issue. */
export function openEscalations(rows: readonly Row[]): Row[] {
  const settled = new Set(rows.flatMap((r) => (r.step === "escalation.auto_resolved" && typeof r.issue_url === "string" ? [r.issue_url]
    : r.step === "escalation.superseded" && typeof r.superseded_issue_url === "string" ? [r.superseded_issue_url] : [])));
  return rows.filter((r) => r.step === "escalation.issue_opened" && typeof r.issue_url === "string" && !settled.has(r.issue_url));
}

export interface EvidenceContext {
  rows: readonly Row[];
  now: Date;
  /** Median open-to-first-start wait in ms, when at least one filed task has started. */
  medianWaitMs: number | undefined;
}

/** The median wait the way a started task's wait reads: from filing to its first `run.start`. */
export function measuredMedianWaitMs(rows: readonly Row[], filed: ReadonlyMap<string, number>): number | undefined {
  const firstStart = new Map<string, number>();
  for (const r of rows) {
    if (r.step !== "run.start" || typeof r.task_id !== "string" || !PLAN_TASK_ID.test(r.task_id) || !Number.isFinite(tsMs(r))) continue;
    firstStart.set(r.task_id, Math.min(firstStart.get(r.task_id) ?? Infinity, tsMs(r)));
  }
  const waits = [...firstStart].flatMap(([id, at]) => (filed.has(id) && at >= filed.get(id)! ? [at - filed.get(id)!] : []));
  return medianMs(waits);
}

/** Why a queued task is not dispatching when that is not its rank. */
export function heldBy(task: Task, openIds: ReadonlySet<string>, now: Date, inFlight: ReadonlyMap<string, readonly string[]>): string | undefined {
  if (task.verify === "human") return "verify-human";
  if (task.dispatch_hold === true) return "dispatch-hold";
  if (task.not_before !== undefined && now.getTime() < Date.parse(task.not_before)) return `not-before:${task.not_before}`;
  const dependency = task.depends_on.find((d) => openIds.has(d));
  if (dependency !== undefined) return `unmerged-dependency:${dependency}`;
  const mine = new Set(physicalFiles(task));
  for (const [other, files] of inFlight) if (other !== task.id && files.some((f) => mine.has(f))) return `file-overlap:${other}`;
  return undefined;
}

export function buildEvidencePack(
  task: Task, shardText: string, all: readonly Task[], openIds: ReadonlySet<string>, fanout: ReadonlyMap<string, number>,
  ctx: EvidenceContext & { filed: ReadonlyMap<string, number>; incidents: readonly IncidentLifecycleRecord[]; escalations: readonly Row[]; openPrs: ReadonlySet<number>; inFlight: ReadonlyMap<string, readonly string[]> },
): EvidencePack {
  const facts: EvidenceFact[] = [];
  const add = (ref: string, text: string, source: string): void => void facts.push({ ref, text, source });
  const shard = readShardPriority(shardText);
  const cited = backlogCitedSteps(task);
  const text = `${task.title}\n${task.rationale ?? ""}\n${shardText}`;

  // Dependents: the open tasks that wait on this one, with the count the dispatch score reads.
  const direct = all.filter((t) => openIds.has(t.id) && t.depends_on.includes(task.id)).map((t) => t.id);
  const reverse = new Map<string, string[]>();
  for (const t of all) if (openIds.has(t.id)) for (const d of t.depends_on) reverse.set(d, [...(reverse.get(d) ?? []), t.id]);
  const transitive = new Set<string>();
  for (const stack = [...direct]; stack.length > 0;) {
    const id = stack.pop()!;
    if (transitive.has(id)) continue;
    transitive.add(id);
    stack.push(...(reverse.get(id) ?? []));
  }
  const dependents = [...transitive].sort();
  if (dependents.length > 0) add("dependents", `${fanout.get(task.id) ?? dependents.length} open dependent(s): ${dependents.join(", ")} (direct: ${direct.join(", ") || "none"})`, `plan depends_on (${task.id})`);

  // Incidents: open records whose fingerprint or title the shard cites, or whose title names the task.
  const incidents = ctx.incidents.filter((i) => i.status !== "verified" && (text.includes(i.fingerprint) || i.title.includes(task.id)));
  for (const i of incidents) add(`incident:${i.fingerprint}`, `open incident (${i.status}, ${i.count24h} in 24h): ${i.title}`, `incident store ${i.fingerprint}`);

  // Escalations: open ones whose row names the task or a fingerprint the shard cites.
  for (const e of ctx.escalations) {
    const named = e.task_id === task.id || (typeof e.summary === "string" && e.summary.includes(task.id)) || incidents.some((i) => JSON.stringify(e).includes(i.fingerprint));
    if (named) add(`escalation:${String(e.issue_url)}`, `open escalation ${String(e.issue_url)}`, `ledger escalation.issue_opened ${String(e.ts)}`);
  }

  // Red PRs it would fix: the newest disposition of each open PR, naming the task or a ledger step the shard cites.
  const newestByPr = new Map<number, Row>();
  for (const r of newestFirst(ctx.rows.filter((x) => x.step === "sweep.disposed" && typeof x.pr_number === "number"))) if (!newestByPr.has(r.pr_number as number)) newestByPr.set(r.pr_number as number, r);
  const prs: number[] = [];
  const stuck: number[] = [];
  for (const [n, r] of newestByPr) {
    if (!ctx.openPrs.has(n)) continue;
    const reason = typeof r.reason === "string" ? r.reason : "";
    if (r.task_id !== task.id && !reason.includes(task.id) && !cited.some((s) => reason.includes(s))) continue;
    prs.push(n);
    if (STUCK_DISPOSITION.test(String(r.disposition))) stuck.push(n);
  }
  prs.sort((a, b) => a - b);
  if (prs.length > 0) add("prs", `${prs.length} open PR(s) cite it: ${prs.map((n) => `#${n}`).join(", ")}; stuck disposition cites it: ${stuck.length > 0 ? stuck.map((n) => `#${n}`).join(", ") : "none"}`, "ledger sweep.disposed (newest per PR)");

  // Age, in measured median waits.
  const filedAt = ctx.filed.get(task.id);
  if (filedAt !== undefined) {
    const ageMs = Math.max(0, ctx.now.getTime() - filedAt);
    add("age", ctx.medianWaitMs ? `${(ageMs / ctx.medianWaitMs).toFixed(1)} median waits (${(ageMs / HOUR_MS).toFixed(1)} h; median wait ${(ctx.medianWaitMs / HOUR_MS).toFixed(1)} h)` : `${(ageMs / HOUR_MS).toFixed(1)} h; no started task yet measures a median wait`, "first-parent plan history");
  }

  // Attempts and failures.
  const runs = ctx.rows.filter((r) => r.step === "run.start" && r.task_id === task.id);
  const verdicts = newestFirst(ctx.rows.filter((r) => (r.step === "verdict" || r.step === "verdict.merged") && r.task_id === task.id));
  const refusals = verdicts.filter((r) => streakRefusal(r) !== undefined).length;
  if (runs.length > 0 || task.attempts > 0 || verdicts.length > 0) {
    add("attempts", `${runs.length} run.start row(s), ${refusals} non-worker refusal(s), shard attempts=${task.attempts}, last verdict=${String(verdicts[0]?.verdict ?? "none")}`, "ledger run.start/verdict");
  }

  // Operator origin.
  const origin = shard.operatorPin ? `operator pin on the priority line (${shard.comment})` : /operator/i.test(task.origin ?? "") ? `origin names an operator session: ${task.origin}` : undefined;
  if (origin !== undefined) add("origin", origin, `shard ${task.id}`);
  if (shard.editedSinceMarker) add("edited", `priority ${String(shard.value)} was edited after the judge's marker (priority=${String(shard.marker)}); the current value is authoritative`, `shard ${task.id}`);

  // Why it is not dispatching, when that is not its rank.
  const held = heldBy(task, openIds, ctx.now, ctx.inFlight);
  if (held !== undefined) add(`held:${held}`, `not dispatching because of ${held}, not its rank`, `shard ${task.id}`);

  const unscored = newestFirst(ctx.rows.filter((r) => r.step === "dispatch.cost_of_delay.ready"))[0];
  if (unscored && Array.isArray(unscored.unscored) && unscored.unscored.includes(task.id)) add("score", "unscored by the dispatch cost-of-delay context", `ledger dispatch.cost_of_delay.ready ${String(unscored.ts)}`);

  const pinned = shard.operatorPin || shard.editedSinceMarker;
  const body = { id: task.id, priority: shard.value ?? null, facts: facts.map((f) => [f.ref, f.text]) };
  return { id: task.id, title: task.title, priority: shard.value ?? null, pinned, facts, dependents, incidents: incidents.map((i) => i.fingerprint), prs, heldBy: held, signature: evidenceHash(body) };
}

// ── the judge's answer ───────────────────────────────────────────────────────────────────────────────────────────

export interface ExpectedOutcome { unblocks_tasks: string[]; ends_incidents: string[]; unsticks_prs: number[]; starts_within: number }

export interface JudgeMove {
  id: string;
  priority: number;
  reason: string;
  evidence: string[];
  expected_cost_of_delay: number;
  expected_outcome: ExpectedOutcome;
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Strict parse, as `parseFixProgressVerdict` reads its answer: anything malformed is undefined, never guessed. */
export function parseQueueJudgeAnswer(text: string): JudgeMove[] | undefined {
  const raw = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return undefined; /* a malformed answer writes nothing; the next pass asks again */ }
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? (value as Record<string, unknown>).moves : undefined;
  if (!Array.isArray(list)) return undefined;
  const moves: JudgeMove[] = [];
  for (const m of list) {
    if (!m || typeof m !== "object") return undefined;
    const v = m as Record<string, unknown>;
    const o = v.expected_outcome as Record<string, unknown> | undefined;
    if (typeof v.id !== "string" || typeof v.priority !== "number" || !Number.isFinite(v.priority) || typeof v.reason !== "string" || !v.reason.trim() ||
        !isStringList(v.evidence) || typeof v.expected_cost_of_delay !== "number" || !Number.isFinite(v.expected_cost_of_delay) || v.expected_cost_of_delay < 0 ||
        !o || typeof o !== "object" || !isStringList(o.unblocks_tasks) || !isStringList(o.ends_incidents) ||
        !Array.isArray(o.unsticks_prs) || !o.unsticks_prs.every((n) => Number.isSafeInteger(n)) ||
        typeof o.starts_within !== "number" || !Number.isFinite(o.starts_within) || o.starts_within <= 0) return undefined;
    moves.push({ id: v.id, priority: v.priority, reason: v.reason.replace(/\s+/g, " ").trim(), evidence: v.evidence, expected_cost_of_delay: v.expected_cost_of_delay,
      expected_outcome: { unblocks_tasks: o.unblocks_tasks, ends_incidents: o.ends_incidents, unsticks_prs: o.unsticks_prs as number[], starts_within: o.starts_within } });
  }
  return moves;
}

export interface QueueJudgeAction extends GardenAction<QueueJudgeClass> {
  from: number | null;
  to: number;
  evidence: string[];
  signature: string;
  expectedCostOfDelay: number;
  expectedOutcome: ExpectedOutcome;
  pinned: boolean;
  heldBy: string | undefined;
}

export interface MoveRefusal { id: string; reason: string }

/**
 * The deterministic checks after the judge, row by row. An unknown id, a task that is not queued, a value outside
 * lint's [0, 99], a cited evidence ref (or claimed dependent, incident, PR) that is not in the pack: each refuses its
 * own row. A pinned priority is never moved to a larger number and nothing may sit below the smallest operator pin:
 * those proposals become escalations, never writes.
 */
export function checkMoves(moves: readonly JudgeMove[], packs: ReadonlyMap<string, EvidencePack>): { accepted: QueueJudgeAction[]; refused: MoveRefusal[]; escalate: QueueJudgeAction[] } {
  const accepted: QueueJudgeAction[] = [], escalate: QueueJudgeAction[] = [], refused: MoveRefusal[] = [];
  const pins = [...packs.values()].filter((p) => p.pinned && p.priority !== null).map((p) => p.priority!);
  const floor = pins.length > 0 ? Math.min(...pins) : undefined;
  const seen = new Set<string>();
  for (const m of moves) {
    const refuse = (reason: string): void => void refused.push({ id: m.id, reason });
    const pack = packs.get(m.id);
    if (!pack) { refuse("unknown id: not a queued task in this pass"); continue; }
    if (seen.has(m.id)) { refuse("proposed twice"); continue; }
    seen.add(m.id);
    if (m.priority < 0 || m.priority > 99 || !/^\d+(?:\.\d{1,2})?$/.test(String(m.priority))) { refuse(`priority ${m.priority} is outside [0, 99] or not a plain decimal`); continue; }
    if (m.evidence.length === 0) { refuse("cites no evidence"); continue; }
    const refs = new Set(pack.facts.map((f) => f.ref));
    const missing = m.evidence.filter((r) => !refs.has(r));
    if (missing.length > 0) { refuse(`cites evidence missing from the pack: ${missing.join(", ")}`); continue; }
    const o = m.expected_outcome;
    const ungrounded = [...o.unblocks_tasks.filter((d) => !pack.dependents.includes(d)), ...o.ends_incidents.filter((i) => !pack.incidents.includes(i)), ...o.unsticks_prs.filter((n) => !pack.prs.includes(n)).map(String)];
    if (ungrounded.length > 0) { refuse(`claims an outcome the pack does not support: ${ungrounded.join(", ")}`); continue; }
    if (pack.priority === m.priority) continue;
    const action: QueueJudgeAction = {
      class: pack.priority === null || m.priority < pack.priority ? "raise" : "lower", target: m.id, reason: m.reason, from: pack.priority, to: m.priority,
      evidence: m.evidence, signature: pack.signature, expectedCostOfDelay: m.expected_cost_of_delay, expectedOutcome: o, pinned: pack.pinned, heldBy: pack.heldBy,
    };
    // An operator's frame: a pin never moves to a larger number, and nothing sits more urgent than the smallest pin.
    if ((pack.pinned && pack.priority !== null && m.priority > pack.priority) || (floor !== undefined && m.priority < floor)) escalate.push(action);
    else accepted.push(action);
  }
  return { accepted, refused, escalate };
}

// ── measurement: cadence, review cost, record ────────────────────────────────────────────────────────────────────

interface PrSample { url: string; openMs: number; shards: number }
const prNumber = (url: string): number | undefined => { const n = /\/pull\/(\d+)/.exec(url)?.[1]; return n === undefined ? undefined : Number(n); };

export interface PrMeasure { prs: number; openToMergeMs: number | undefined; minutesPerShard: number | undefined }

/** Open-to-merge and review cost per shard for merged PRs: the minutes from open to the first PASS `review.posted`, per shard. */
export function measurePrs(samples: readonly PrSample[], rows: readonly Row[], history: readonly MainCommit[]): PrMeasure {
  const merge = new Map<number, number>();
  for (const c of history) { const n = /\(#(\d+)\)$/.exec(c.subject)?.[1]; if (n) merge.set(Number(n), Date.parse(c.at)); }
  const passes = rows.filter((r) => r.step === "review.posted" && r.state === "success" && typeof r.pr_url === "string" && Number.isFinite(tsMs(r)));
  const toMerge: number[] = [], perShard: number[] = [];
  let prs = 0;
  for (const s of samples) {
    const n = prNumber(s.url);
    const mergedAt = n === undefined ? undefined : merge.get(n);
    if (mergedAt === undefined || s.shards < 1) continue;
    prs++;
    toMerge.push(Math.max(0, mergedAt - s.openMs));
    const first = passes.filter((r) => r.pr_url === s.url && tsMs(r) >= s.openMs).map(tsMs).sort((a, b) => a - b)[0];
    if (first !== undefined) perShard.push((first - s.openMs) / 60_000 / s.shards);
  }
  return { prs, openToMergeMs: medianMs(toMerge), minutesPerShard: medianMs(perShard) };
}

export function ownPrSamples(predictions: readonly Row[]): PrSample[] {
  const by = new Map<string, { open: number; tasks: Set<string> }>();
  for (const p of predictions) {
    if (typeof p.pr_url !== "string" || !Number.isFinite(tsMs(p))) continue;
    const g = by.get(p.pr_url) ?? { open: Infinity, tasks: new Set<string>() };
    g.open = Math.min(g.open, tsMs(p));
    g.tasks.add(String(p.task_id));
    by.set(p.pr_url, g);
  }
  return [...by].map(([url, g]) => ({ url, openMs: g.open, shards: g.tasks.size }));
}

export function backlogPrSamples(rows: readonly Row[]): PrSample[] {
  return rows.filter((r) => r.step === "backlog.scorecard" && typeof r.pr_url === "string" && typeof r.actions === "number" && Number.isFinite(tsMs(r)))
    .map((r) => ({ url: r.pr_url as string, openMs: tsMs(r), shards: r.actions as number }));
}

/** Distinct plan tasks that started per hour over the span the evidence covers. */
export function measuredStartsPerHour(rows: readonly Row[], nowMs: number): number | undefined {
  const starts = rows.filter((r) => r.step === "run.start" && typeof r.task_id === "string" && PLAN_TASK_ID.test(r.task_id) && Number.isFinite(tsMs(r)));
  if (starts.length === 0) return undefined;
  const first = Math.min(...starts.map(tsMs));
  const hours = Math.max(1, (nowMs - first) / HOUR_MS);
  return new Set(starts.map((r) => r.task_id)).size / hours;
}

export interface ClassRecordReport {
  class: QueueJudgeClass;
  alpha: number; beta: number; mean: number; priorMean: number;
  hits: number; misses: number; notRanking: number;
  /** Scored misses since the class's last hit. */
  missesSinceCredit: number;
  allowance: number;
  shadow: boolean;
}

/** The fleet's own prior for a garden class is Beta(3, 1): `initialGardenState`, never a number restated here. */
export function classRecords(stateDir: string, outcomes: readonly Row[]): ClassRecordReport[] {
  const state = readGardenState(gardenStatePath(stateDir, QUEUE_JUDGE_NAME), QUEUE_JUDGE_CLASSES);
  const prior = initialGardenState(QUEUE_JUDGE_CLASSES).classes;
  return QUEUE_JUDGE_CLASSES.map((c) => {
    const mine = [...outcomes].filter((o) => o.class === c).sort((a, b) => tsMs(a) - tsMs(b));
    const hits = mine.filter((o) => o.verdict === "hit").length;
    const misses = mine.filter((o) => o.verdict === "miss").length;
    const lastHit = mine.map((o) => o.verdict).lastIndexOf("hit");
    const missesSinceCredit = mine.slice(lastHit + 1).filter((o) => o.verdict === "miss").length;
    const { alpha, beta } = state.classes[c];
    const mean = alpha / (alpha + beta);
    const priorMean = prior[c].alpha / (prior[c].alpha + prior[c].beta);
    return { class: c, alpha, beta, mean, priorMean, hits, misses, notRanking: mine.filter((o) => o.verdict === "not_ranking").length, missesSinceCredit,
      allowance: Math.max(1, Math.floor(alpha / (beta + missesSinceCredit))),
      // A class with no evidence yet sits AT the prior and acts; it falls into shadow once its record has dropped to or below it.
      shadow: mean <= priorMean && (alpha !== prior[c].alpha || beta !== prior[c].beta) };
  });
}

export interface BoundReport {
  reviewMinutesPerShard: number | null;
  reviewCostSource: "own" | "backlog-prior" | "unmeasured";
  reviewPrs: number;
  windowMinutes: number | null;
  fit: number | null;
  startsPerHour: number | null;
  openToMergeMinutes: number | null;
  churnThreshold: number;
}

/** Cost, window and fit from the two PR measures. Without an own merged PR the backlog gardener's PRs are the prior. */
export function boundFrom(own: PrMeasure, backlog: PrMeasure, startsPerHour: number | undefined): BoundReport {
  const useOwn = own.minutesPerShard !== undefined;
  const cost = useOwn ? own : backlog;
  const openToMergeMs = own.openToMergeMs ?? backlog.openToMergeMs;
  const windowMinutes = openToMergeMs === undefined ? null : openToMergeMs / 60_000;
  const fit = cost.minutesPerShard !== undefined && windowMinutes !== null && cost.minutesPerShard > 0 ? Math.max(1, Math.floor(windowMinutes / cost.minutesPerShard)) : null;
  const predicted = startsPerHour !== undefined && openToMergeMs !== undefined ? startsPerHour * (openToMergeMs / HOUR_MS) : undefined;
  return {
    reviewMinutesPerShard: cost.minutesPerShard ?? null, reviewCostSource: cost.minutesPerShard === undefined ? "unmeasured" : useOwn ? "own" : "backlog-prior", reviewPrs: cost.prs,
    windowMinutes, fit, startsPerHour: startsPerHour ?? null, openToMergeMinutes: windowMinutes, churnThreshold: predicted === undefined ? 1 : Math.max(1, Math.ceil(predicted)),
  };
}

/** Rank by predicted change, take the smaller of the review-cost fit and the record's allowance, name the rest deferred. */
export function boundMoves(moves: readonly QueueJudgeAction[], bound: BoundReport, allowance: number): { selected: QueueJudgeAction[]; deferred: QueueJudgeAction[]; limit: number } {
  const ranked = [...moves].sort((a, b) => b.expectedCostOfDelay - a.expectedCostOfDelay || a.target.localeCompare(b.target));
  const limit = Math.min(bound.fit ?? Infinity, allowance);
  return { selected: ranked.slice(0, limit), deferred: ranked.slice(limit), limit };
}

// ── scoring ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type OutcomeVerdict = "hit" | "miss" | "not_ranking";

export interface ScoredOutcome {
  task_id: string;
  prediction_ts: string;
  class: QueueJudgeClass;
  verdict: OutcomeVerdict;
  observed: Record<string, unknown>;
  holder?: string;
}

export interface ScoreContext {
  rows: readonly Row[];
  now: Date;
  openIds: ReadonlySet<string>;
  incidents: readonly IncidentLifecycleRecord[];
  openPrs: ReadonlySet<number>;
  holderNow: (taskId: string) => string | undefined;
  churnSince: (sha: string | undefined) => number;
}

/** One open prediction, scored once its task resolved or the queue turned over twice past its predicted start. */
export function scorePrediction(p: Row, ctx: ScoreContext): ScoredOutcome | undefined {
  const id = String(p.task_id), cls = p.class as QueueJudgeClass, predMs = tsMs(p);
  const startsWithin = typeof p.starts_within_hours === "number" ? p.starts_within_hours : 0;
  const deadline = predMs + startsWithin * HOUR_MS;
  const resolved = !ctx.openIds.has(id);
  const threshold = typeof p.churn_threshold === "number" ? p.churn_threshold : 1;
  const expired = ctx.now.getTime() > deadline && ctx.churnSince(typeof p.main_sha === "string" ? p.main_sha : undefined) >= 2 * threshold;
  if (!resolved && !expired) return undefined;
  const base = { task_id: id, prediction_ts: String(p.ts), class: cls };
  const holder = (typeof p.held_by === "string" ? p.held_by : undefined) ?? (resolved ? undefined : ctx.holderNow(id));
  const firstStart = ctx.rows.filter((r) => r.step === "run.start" && r.task_id === id && tsMs(r) >= predMs).map(tsMs).sort((a, b) => a - b)[0];
  if (holder !== undefined && (firstStart === undefined || cls === "lower")) return { ...base, verdict: "not_ranking", holder, observed: { held_by: holder, first_start: firstStart ?? null } };
  const o = (p.expected_outcome ?? {}) as Partial<ExpectedOutcome>;
  if (cls === "raise") {
    const startedInWindow = firstStart !== undefined && firstStart <= deadline;
    const dependentsStarted = (o.unblocks_tasks ?? []).filter((d) => ctx.rows.some((r) => r.step === "run.start" && r.task_id === d && firstStart !== undefined && tsMs(r) >= firstStart));
    const incidentsVerified = (o.ends_incidents ?? []).filter((f) => ctx.incidents.some((i) => i.fingerprint === f && i.status === "verified"));
    const newest = new Map<number, Row>();
    for (const r of newestFirst(ctx.rows.filter((x) => x.step === "sweep.disposed" && typeof x.pr_number === "number"))) if (!newest.has(r.pr_number as number)) newest.set(r.pr_number as number, r);
    const prsUnstuck = (o.unsticks_prs ?? []).filter((n) => !ctx.openPrs.has(n) || !STUCK_DISPOSITION.test(String(newest.get(n)?.disposition ?? "")));
    const claimsHold = dependentsStarted.length === (o.unblocks_tasks ?? []).length && incidentsVerified.length === (o.ends_incidents ?? []).length && prsUnstuck.length === (o.unsticks_prs ?? []).length;
    return { ...base, verdict: startedInWindow && claimsHold ? "hit" : "miss", observed: { first_start: firstStart ?? null, started_in_window: startedInWindow, deadline_ms: deadline, dependents_started: dependentsStarted, incidents_verified: incidentsVerified, prs_unstuck: prsUnstuck, resolved } };
  }
  const escalations = ctx.rows.filter((r) => r.step === "escalation.issue_opened" && r.task_id === id && tsMs(r) > predMs).map((r) => String(r.issue_url));
  const stuck = ctx.rows.filter((r) => r.step === "sweep.disposed" && r.task_id === id && tsMs(r) > predMs && STUCK_DISPOSITION.test(String(r.disposition))).map((r) => Number(r.pr_number));
  const incidents = ctx.incidents.filter((i) => i.title.includes(id) && i.firstSeenMs > predMs).map((i) => i.fingerprint);
  return { ...base, verdict: escalations.length + stuck.length + incidents.length === 0 ? "hit" : "miss", observed: { escalations, stuck_prs: stuck, incidents, resolved } };
}

export const effectIdFor = (o: Pick<ScoredOutcome, "task_id" | "prediction_ts">): string => `queue-judge:effect:${o.task_id}:${o.prediction_ts}`;

/** Deliver a scored hit or miss to the class's Beta record through the gardener's effects file. The overseer
 *  owns sequenced receipts in that file; this producer's are unsequenced, so it never mixes into a sequenced prefix. */
export function deliverEffects(stateDir: string, outcomes: readonly ScoredOutcome[], at: string): { delivered: ScoredOutcome[]; deferred: ScoredOutcome[] } {
  const scoring = outcomes.filter((o) => o.verdict !== "not_ranking");
  if (scoring.length === 0) return { delivered: [...outcomes], deferred: [] };
  const path = gardenEffectsPath(stateDir, QUEUE_JUDGE_NAME);
  const existing = readGardenEffects(path);
  if (existing.some((e) => e.sequence !== undefined)) return { delivered: outcomes.filter((o) => o.verdict === "not_ranking"), deferred: scoring };
  const have = new Set(existing.map((e) => e.id));
  const added: GardenEffect[] = scoring.filter((o) => !have.has(effectIdFor(o))).map((o) => ({ id: effectIdFor(o), actionClass: o.class, verdict: o.verdict === "hit" ? "credit" : "debit", kind: "effect", at }));
  if (added.length > 0) writeGardenEffects(path, [...existing, ...added]);
  return { delivered: [...outcomes], deferred: [] };
}

// ── the ranking record and cadence ───────────────────────────────────────────────────────────────────────────────

export interface RankingRecord { at: string; mainSha: string; threshold: number; startsPerHour: number | null; openToMergeMinutes: number | null }

export function rankingPath(stateDir: string): string { return join(stateDir, "queue-judge-ranking.json"); }

export function readRanking(stateDir: string): RankingRecord | undefined {
  const path = rankingPath(stateDir);
  if (!existsSync(path)) return undefined;
  let parsed: Partial<RankingRecord>;
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RankingRecord>; }
  catch (e) { throw new Error(`queue judge: ranking record ${path} is unreadable: ${String((e as Error).message)}`, { cause: e }); }
  if (typeof parsed.mainSha !== "string" || typeof parsed.at !== "string" || typeof parsed.threshold !== "number") throw new Error(`queue judge: ranking record ${path} is malformed`);
  return parsed as RankingRecord;
}

/** First-parent plan history since `sinceSha`: distinct tasks whose shard changed or whose merge trailer landed. */
export function gitChurn(repoRoot: string, sinceSha: string | undefined): { head: string; changed: number } {
  const git = (args: string[]) => spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const ref = git(["rev-parse", "--verify", "--quiet", "origin/main"]).status === 0 ? "origin/main" : "HEAD";
  const head = git(["rev-parse", ref]);
  if (head.status !== 0) throw new Error(`queue judge: cannot resolve ${ref}: ${String(head.stderr).trim()}`);
  const sha = String(head.stdout).trim();
  if (sinceSha === undefined || sinceSha === sha) return { head: sha, changed: 0 };
  const log = git(["log", "--first-parent", "--format=%x01%B%x02", "--name-only", `${sinceSha}..${ref}`, "--", "plan"]);
  if (log.status !== 0) throw new Error(`queue judge: git log ${sinceSha}..${ref} failed: ${String(log.stderr).trim()}`);
  const ids = new Set<string>();
  for (const m of String(log.stdout).matchAll(/plan\/tasks\.d\/([A-Z][A-Z0-9]*-T\d+)-/g)) ids.add(m[1]!);
  const trailers = git(["log", "--first-parent", "--format=%B", `${sinceSha}..${ref}`]);
  if (trailers.status === 0) for (const m of String(trailers.stdout).matchAll(/^Remudero-Task:[ \t]+([A-Z][A-Z0-9]*-T\d+)[ \t]*$/gm)) ids.add(m[1]!);
  return { head: sha, changed: ids.size };
}

/** Task id → filing time from main's first-parent plan history, the way dispatch dates a task. */
export function gitFilingDates(repoRoot: string): Map<string, number> {
  const out = spawnSync("git", ["-C", repoRoot, "log", "--first-parent", "--reverse", "--format=filing:%ct", "--no-renames", "-p", "--unified=0", "HEAD", "--", "plan"], { encoding: "utf8", maxBuffer: 1 << 27 });
  if (out.status !== 0) throw new Error(`queue judge: cannot read filing history: ${String(out.stderr).trim() || String(out.error?.message ?? "git failed")}`);
  return filingDatesFromPlanHistory(String(out.stdout));
}

// ── prompt ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function judgePrompt(packs: readonly EvidencePack[], records: readonly ClassRecordReport[], bound: BoundReport): string {
  const record = records.map((r) => `${r.class}: ${r.hits} hit(s), ${r.misses} miss(es), ${r.notRanking} not_ranking; posterior mean ${r.mean.toFixed(2)} against the prior ${r.priorMean.toFixed(2)}; allowance ${r.allowance}${r.shadow ? "; in shadow (no PR opens until hits earn it back)" : ""}`).join("\n");
  return [
    "You re-rank a software fleet's queued tasks. `priority` is a number: a lower one dispatches sooner. Most of the queue shares a few plain priorities, so the number no longer orders anything.",
    "",
    `THE OPERATOR'S RULE, verbatim: ${COST_OF_DELAY_RULE}.`,
    "",
    "Propose a move only where measured evidence shows the current priority misjudges what waiting costs. Cite evidence only by the `ref` values listed under that task; a ref not in its list is refused. Do not recall facts you were not given.",
    "A priority an operator pinned (`pinned: true`) is never moved to a larger number: you may propose it and the operator is asked. You may raise it (a smaller number) like any task.",
    "Priority values are plain decimals in [0, 99] with at most two decimal places. A task held by something other than its rank (`held` in its facts) will not dispatch whatever its priority.",
    "",
    "YOUR OWN RECORD (your predictions are scored against outcomes; a raise is a hit when the task starts in its predicted window and the claimed dependents, incidents and PRs follow):",
    record,
    `Review cost: ${bound.reviewMinutesPerShard === null ? "unmeasured" : `${bound.reviewMinutesPerShard.toFixed(1)} min per shard (${bound.reviewCostSource})`}. Larger predicted changes are kept first when a pass must defer moves.`,
    "",
    'Answer with ONE JSON object and nothing else: {"moves":[{"id":"<task id>","priority":<number>,"reason":"<one line>","evidence":["<ref>",...],"expected_cost_of_delay":<number >= 0>,"expected_outcome":{"unblocks_tasks":["<dependent id from this task\'s dependents fact>"],"ends_incidents":["<incident fingerprint>"],"unsticks_prs":[<pr number>],"starts_within":<hours until it starts, > 0>}}]}. An empty list is a valid answer.',
    "",
    "QUEUED TASKS, one JSON object per line:",
    ...packs.map((p) => JSON.stringify({ id: p.id, title: p.title, priority: p.priority, pinned: p.pinned, facts: p.facts.map((f) => ({ ref: f.ref, text: f.text, source: f.source })) })),
  ].join("\n");
}

// ── inventory ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface QueueJudgeInventory {
  /** Why nothing was asked: an empty queue, or a queue that has not turned over its last ranked head. */
  skipped?: "empty-queue" | "not-due";
  open: number;
  asked: boolean;
  plan?: PlanInventory;
  /** Moves a PR may carry, by class (shadow classes hold none). */
  moves: QueueJudgeAction[];
  deferred: QueueJudgeAction[];
  shadowed: QueueJudgeAction[];
  escalated: string[];
  refused: MoveRefusal[];
  scored: ScoredOutcome[];
  bound?: BoundReport;
  records: ClassRecordReport[];
  mainSha?: string;
  signature: string;
}

const emptyInventory = (skipped: NonNullable<QueueJudgeInventory["skipped"]>, open: number): QueueJudgeInventory =>
  ({ skipped, open, asked: false, moves: [], deferred: [], shadowed: [], escalated: [], refused: [], scored: [], records: [], signature: skipped });

export class QueueJudgeUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`queue judge unavailable: ${reason}`);
    this.name = "QueueJudgeUnavailableError";
  }
}

function pinEscalation(a: QueueJudgeAction, floor: boolean): Escalation {
  return {
    class: "MANUAL",
    taskId: a.target,
    summary: `queue judge proposes priority ${String(a.from)} -> ${a.to} on ${a.target}, which ${floor ? "would sit more urgent than your smallest pin" : "you pinned"}`,
    detail: `The queue judge re-ranks by measured cost of delay and never moves an operator-pinned priority to a larger number, nor above your smallest pin. Nothing was written to the shard.\n\nReason: ${a.reason}\n\nEvidence it cited: ${a.evidence.join(", ")}\nExpected cost of delay: ${a.expectedCostOfDelay}\nExpected outcome: ${JSON.stringify(a.expectedOutcome)}`,
    options: [
      { label: "confirm", detail: `edit ${a.target}'s priority line to ${a.to} yourself, with your own \`# operator-YYYY-MM-DD:\` reason` },
      { label: "keep", detail: "leave the pin as it is; the judge will not propose this value again from the same evidence" },
    ],
    recommendation: "keep",
    headDedup: "independent",
  };
}

export async function queueJudgeInventory(sources: QueueJudgeSources, deps: Pick<GardenerDeps, "log" | "escalate">): Promise<QueueJudgeInventory> {
  const plan = sources.plan();
  if (plan.open.length === 0) return emptyInventory("empty-queue", 0);
  const now = sources.clock.date();
  const ranking = readRanking(sources.stateDir);
  if (ranking !== undefined && sources.churn(ranking.mainSha).changed < ranking.threshold) return emptyInventory("not-due", plan.open.length);

  const since = clockFromMillisFn(() => now.getTime() - EVIDENCE_WINDOW_MS).iso();
  const own = sources.ledger(OWN_STEPS);
  const recent = sources.ledger(EVIDENCE_STEPS, since);
  const rows = [...own, ...recent];
  const openIds = new Set(plan.open.map((t) => t.id));
  const incidents = sources.incidents();
  const openPrs = sources.openPrNumbers();
  const inFlight = (sources.inFlight ?? ((r: readonly Row[]) => inFlightTasks(r, plan.all)))(recent);
  const holderNow = (id: string): string | undefined => { const t = plan.open.find((x) => x.id === id); return t ? heldBy(t, openIds, now, inFlight) : undefined; };
  const history = sources.history(since);
  const filed = sources.filingDates();

  // 1. Score every open prediction first, so this pass's authority reflects its record.
  const predictions = own.filter((r) => r.step === QUEUE_JUDGE_PREDICTION_STEP && typeof r.task_id === "string");
  const priorOutcomes = own.filter((r) => r.step === QUEUE_JUDGE_OUTCOME_STEP);
  const scoredKeys = new Set(priorOutcomes.map((o) => `${String(o.task_id)}@${String(o.prediction_ts)}`));
  const scoreCtx: ScoreContext = { rows: recent, now, openIds, incidents, openPrs, holderNow, churnSince: (sha) => sources.churn(sha).changed };
  const scored = predictions.filter((p) => !scoredKeys.has(`${String(p.task_id)}@${String(p.ts)}`))
    .flatMap((p) => { const s = scorePrediction(p, scoreCtx); return s ? [s] : []; });
  if (scored.length > 0) {
    const { delivered, deferred } = deliverEffects(sources.stateDir, scored, now.toISOString());
    for (const o of delivered) deps.log(QUEUE_JUDGE_OUTCOME_STEP, { ...o });
    if (deferred.length > 0) deps.log("queue_judge.scoring_deferred", { reason: "the gardener's effects file holds the overseer's sequenced receipts; these are scored once it is folded", tasks: deferred.map((d) => d.task_id) });
  }
  const outcomes = [...priorOutcomes, ...scored.map((o) => ({ ...o, ts: now.toISOString() }) as Row)];
  const records = classRecords(sources.stateDir, outcomes);

  // 2. Measure pace and size from its own record, with the backlog gardener's PRs as the prior until it has one.
  const ownMeasure = measurePrs(ownPrSamples(predictions), recent, history);
  const backlogMeasure = measurePrs(backlogPrSamples(recent), recent, history);
  const bound = boundFrom(ownMeasure, backlogMeasure, measuredStartsPerHour(recent, now.getTime()));

  // 3. One evidence pack per queued task, then one judge spawn.
  const fanout = openDependentFanout(plan.all, openIds);
  const escalations = openEscalations(recent);
  const medianWaitMs = measuredMedianWaitMs(recent, filed);
  const packs = new Map<string, EvidencePack>();
  for (const task of [...plan.open].sort((a, b) => a.id.localeCompare(b.id))) {
    const rel = plan.shards.get(task.id);
    if (!rel) continue;
    // The machine-filing judge prices an unjudged machine task when it rules; ranking it first races that write.
    if (task.author_class === "machine" && task.risk_ruling === undefined) continue;
    const text = sources.readShard(rel);
    if (readShardPriority(text).unreadable) continue;
    packs.set(task.id, buildEvidencePack(task, text, plan.all, openIds, fanout, { rows: recent, now, medianWaitMs, filed, incidents, escalations, openPrs, inFlight }));
  }
  if (packs.size === 0) return { ...emptyInventory("empty-queue", plan.open.length), scored, records };

  let answer: string;
  try {
    answer = await sources.judgeText(judgePrompt([...packs.values()], records, bound));
  } catch (e) {
    deps.log(UNAVAILABLE_STEP, { reason: `judge spawn failed: ${String((e as Error)?.message ?? e)}` });
    throw new QueueJudgeUnavailableError(`judge spawn failed: ${String((e as Error)?.message ?? e)}`);
  }
  const proposed = parseQueueJudgeAnswer(answer);
  if (proposed === undefined) {
    deps.log(UNAVAILABLE_STEP, { reason: "the judge's answer was not the strict JSON shape; nothing is written and it is asked again" });
    throw new QueueJudgeUnavailableError("malformed judge answer");
  }
  const checked = checkMoves(proposed, packs);
  for (const r of checked.refused) deps.log("queue_judge.row_refused", { task_id: r.id, reason: r.reason });
  if (proposed.length > 0 && checked.accepted.length + checked.escalate.length === 0 && checked.refused.length === proposed.length) {
    deps.log(UNAVAILABLE_STEP, { reason: `every proposed row was refused: ${checked.refused.map((r) => `${r.id}: ${r.reason}`).join("; ")}` });
    throw new QueueJudgeUnavailableError("every proposed row was refused");
  }

  // 4. A move already predicted from this value, still open, is not asked for again.
  const open = new Set(predictions.filter((p) => !scoredKeys.has(`${String(p.task_id)}@${String(p.ts)}`)).map((p) => `${String(p.task_id)}>${String(p.to)}`));
  const fresh = checked.accepted.filter((a) => !open.has(`${a.target}>${a.to}`));
  const byClass = new Map(records.map((r) => [r.class, r]));
  const moves: QueueJudgeAction[] = [], deferred: QueueJudgeAction[] = [], shadowed: QueueJudgeAction[] = [];
  for (const cls of QUEUE_JUDGE_CLASSES) {
    const record = byClass.get(cls)!;
    const ofClass = fresh.filter((a) => a.class === cls);
    if (record.shadow) { shadowed.push(...ofClass); continue; }
    const bounded = boundMoves(ofClass, bound, record.allowance);
    moves.push(...bounded.selected);
    deferred.push(...bounded.deferred);
  }
  const mainSha = sources.churn(undefined).head;
  for (const a of shadowed) deps.log(QUEUE_JUDGE_PREDICTION_STEP, predictionRow(a, bound, mainSha, undefined, true));

  // 5. A proposal to move a pinned priority to a larger number is ONE escalation, never a write.
  const escalated: string[] = [];
  const already = new Set(own.filter((r) => r.step === ESCALATED_STEP).map((r) => `${String(r.task_id)}>${String(r.to)}@${String(r.evidence_signature)}`));
  const pinFloor = [...packs.values()].filter((p) => p.pinned && p.priority !== null).map((p) => p.priority!);
  for (const a of checked.escalate) {
    if (already.has(`${a.target}>${a.to}@${a.signature}`) || records.find((r) => r.class === a.class)?.shadow) continue;
    const url = deps.escalate?.(pinEscalation(a, pinFloor.length > 0 && a.to < Math.min(...pinFloor)));
    deps.log(ESCALATED_STEP, { task_id: a.target, from: a.from, to: a.to, evidence_signature: a.signature, reason: a.reason, evidence: a.evidence, issue_url: url ?? null });
    escalated.push(a.target);
  }

  // 6. The queue's ranking now covers this head: the next pass is due once the queue turns over by what it predicted.
  writeAtomic(rankingPath(sources.stateDir), JSON.stringify({ at: now.toISOString(), mainSha, threshold: bound.churnThreshold, startsPerHour: bound.startsPerHour, openToMergeMinutes: bound.openToMergeMinutes } satisfies RankingRecord, null, 2) + "\n");
  return { open: plan.open.length, asked: true, plan, moves, deferred, shadowed, escalated, refused: checked.refused, scored, bound, records, mainSha, signature: evidenceHash(moves.map((m) => [m.target, m.to, m.signature])) };
}

function predictionRow(a: QueueJudgeAction, bound: BoundReport, mainSha: string | undefined, prUrl: string | undefined, shadow: boolean): Record<string, unknown> {
  return {
    task_id: a.target, class: a.class, from: a.from, to: a.to, reason: a.reason, evidence: a.evidence, evidence_signature: a.signature,
    expected_cost_of_delay: a.expectedCostOfDelay, expected_outcome: a.expectedOutcome, starts_within_hours: a.expectedOutcome.starts_within,
    churn_threshold: bound.churnThreshold, main_sha: mainSha ?? null, held_by: a.heldBy ?? null, pr_url: prUrl ?? null, shadow,
  };
}

// ── write-back ───────────────────────────────────────────────────────────────────────────────────────────────────

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Rewrite each action's shard: priority with its reason, the marker beneath `status: queued`, and the machine re-park. */
export function applyQueueJudgeActions(root: string, shards: ReadonlyMap<string, string>, actions: readonly QueueJudgeAction[], now: Date, read: (path: string) => string, write: (path: string, text: string) => void): string[] {
  const paths: string[] = [];
  const day = now.toISOString().slice(0, 10);
  for (const action of actions) {
    const rel = shards.get(action.target);
    if (!rel) continue;
    const path = join(root, rel);
    const text = read(path);
    const shard = readShardPriority(text);
    if (!/^ {2}status: queued[ \t]*$/m.test(text) || /^ {2}retirement:/m.test(text) || shard.unreadable) continue;
    // The shard moved since the inventory read it: that edit is authoritative, so nothing is written over it.
    if ((shard.value ?? null) !== action.from) continue;
    const reason = oneLine(action.reason);
    const comment = shard.operatorPin ? `${oneLine(shard.comment ?? "")} | queue-judge-${day}: ${reason}` : `queue-judge-${day}: ${reason}`;
    const priorityLine = `  priority: ${action.to}  # ${comment}`;
    let next = text.replace(/^ {2}# queue judge: .*\r?\n?/gm, "").replace(/^ {2}# backlog gardener: (?:band=|placed=).*\r?\n?/gm, "");
    next = shard.value === undefined ? next.replace(/^ {2}status: queued[ \t]*$/m, () => `${priorityLine}\n  status: queued`) : next.replace(PRIORITY_LINE, () => priorityLine);
    next = next.replace(/^ {2}status: queued[ \t]*$/m, () => `  status: queued\n  # queue judge: priority=${action.to} evidence=${action.signature}`);
    // `priority` sits inside a judged machine record's `risk_ruling` pin; the machine-filing judge re-rules it.
    next = reparkStaleRuling(next, rel);
    if (next === text) continue;
    write(path, next);
    paths.push(rel);
  }
  return paths.sort();
}

const fmt = (n: number | null): string => (n === null ? "none" : String(n));

/** The spec's sources: production readers over `deps`, each replaceable by `overrides`. */
export function buildQueueJudgeSources(deps: GardenerDeps, overrides: Partial<QueueJudgeSources> = {}): QueueJudgeSources {
  const clock = overrides.clock ?? deps.clock ?? systemClock;
  const sources: QueueJudgeSources = {
    repoRoot: deps.repoRoot,
    stateDir: deps.stateDir,
    clock,
    plan: () => planInventory(deps.repoRoot, deps.stateDir),
    readShard: (rel) => readFileSync(join(deps.repoRoot, rel), "utf8"),
    ledger: (steps, sinceIso) => {
      const read = readLedgerUnionRecordsSync(deps.stateDir, { step: steps, refuseIncomplete: true, ...(sinceIso ? { sinceTs: sinceIso } : {}) });
      if (!read.ok) throw new Error(`queue judge: incomplete ledger union: ${read.unread.join(", ")}`);
      return read.rows;
    },
    incidents: () => {
      const read = readIncidentLifecycleStore(deps.stateDir);
      if (!read.ok) throw new Error(`queue judge: incident store is ${read.reason}`);
      return Object.values(read.store);
    },
    openPrNumbers: () => { throw new Error("the queue judge's open-PR read is not wired"); },
    filingDates: () => gitFilingDates(deps.repoRoot),
    history: (since) => readMainHistory(deps.repoRoot, since),
    churn: (sha) => gitChurn(deps.repoRoot, sha),
    judgeText: () => Promise.reject(new Error("the queue judge's spawn is not wired")),
    ...overrides,
  };
  return sources;
}

export function queueJudgeGardenSpec(
  deps: GardenerDeps,
  overrides: Partial<QueueJudgeSources> = {},
): GardenSpec<QueueJudgeClass, QueueJudgeInventory, QueueJudgeAction, GardenCheckout> {
  const sources = buildQueueJudgeSources(deps, overrides);
  const clock = sources.clock;
  return {
    name: QUEUE_JUDGE_NAME,
    classes: QUEUE_JUDGE_CLASSES,
    review: { raise: "a priority is a judgement call.", lower: "a priority is a judgement call." },
    landingRefusal: backlogLandingGuard(deps),
    // Due once the queue has turned over its last ranked head by what that ranking predicted; a first pass is due at once.
    cheapFingerprint: () => {
      const ranking = readRanking(deps.stateDir);
      if (ranking === undefined) return "first";
      const { head, changed } = sources.churn(ranking.mainSha);
      return changed >= ranking.threshold ? `due:${head}` : `quiet:${ranking.mainSha}`;
    },
    inventory: () => { throw new Error("the queue judge asks its judge asynchronously: drive it with runGardenAsync"); },
    inventoryAsync: () => queueJudgeInventory(sources, deps),
    fingerprint: (i) => `${i.signature}:${i.moves.length}`,
    unfinished: (i) => i.moves.length > 0,
    candidates: (i) => i.moves,
    scorecard: (i, plan) => {
      const card = {
        open: i.open, asked: i.asked, skipped: i.skipped ?? null, moves: i.moves.length, shadowed: i.shadowed.map((a) => a.target), escalated: i.escalated,
        refused: i.refused.length, scored: i.scored.map((o) => `${o.task_id}:${o.verdict}`), acting: plan.acting,
        deferred: i.deferred.map((a) => ({ task_id: a.target, class: a.class, expected_cost_of_delay: a.expectedCostOfDelay })),
        bound: i.bound ?? null, records: i.records, main_sha: i.mainSha ?? null,
      };
      if (i.asked) deps.log("queue_judge.scorecard", card);
      return card;
    },
    apply: (ws, plan, scorecard) => {
      const shards = planShards(ws.root);
      const paths = applyQueueJudgeActions(ws.root, shards, plan.actions, clock.date(), (p) => readFileSync(p, "utf8"), (p, t) => writeAtomic(p, t));
      if (paths.length === 0) return undefined;
      const landed = plan.actions.filter((a) => paths.includes(shards.get(a.target) ?? ""));
      // The predictions are ledgered once the PR has a URL, and the pass lands through `ws.land`, so name them there.
      const bound = scorecard.bound as BoundReport;
      const mainSha = scorecard.main_sha as string | undefined;
      const record = (url: string | undefined): void => {
        if (url !== undefined) for (const a of landed) deps.log(QUEUE_JUDGE_PREDICTION_STEP, predictionRow(a, bound, mainSha, url, false));
      };
      const land = ws.land.bind(ws);
      ws.land = ((opts: Parameters<GardenCheckout["land"]>[0]) => {
        const result = land(opts) as unknown;
        if (result !== null && typeof result === "object" && typeof (result as PromiseLike<unknown>).then === "function") return (result as Promise<string | undefined>).then((url) => { record(url); return url; });
        record(result as string | undefined);
        return result;
      }) as GardenCheckout["land"];
      return {
        paths,
        title: `chore(plan): queue judge re-ranks ${landed.length} task(s) by measured cost of delay`,
        body: [
          "The queue judge (W1-T9925) re-ranks these queued tasks by measured cost of delay. Close this PR to decline them.", "",
          ...landed.map((a) => `- **${a.target}**: priority ${fmt(a.from)} -> ${a.to} (${a.class}). ${oneLine(a.reason)} Evidence: ${a.evidence.join(", ")}. Expected cost of delay: ${a.expectedCostOfDelay}. Expected outcome: ${JSON.stringify(a.expectedOutcome)}. Shard: \`${shards.get(a.target)}\`.`),
          "", "## Acceptance",
          ...landed.map((a) => `- claim: ${a.target} carries the judged priority\n  proof: grep: # queue judge: priority=${a.to} evidence=${a.signature} in ${shards.get(a.target)}`),
        ].join("\n"),
      };
    },
  };
}
