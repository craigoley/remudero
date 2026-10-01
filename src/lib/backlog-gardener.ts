import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openDependentFanout } from "./dispatch-value.js";
import { systemClock } from "./clock.js";
import { gardenLedgerBucket, type GardenAction, type GardenCheckout, type GardenerDeps, type GardenSpec } from "./gardener.js";
import { readMainHistory, type MainCommit } from "./hot-file-gardener.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { planCheapFingerprint, planInventory, planShards, retirementCandidates, type PlanInventory } from "./plan-gardener.js";
import type { Task } from "./plan.js";
import { deriveTaskClass } from "./task-class.js";

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
  classValue?: { mean: number; attempts: number };
  signature: string;
}
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
  ledger: () => readonly Record<string, unknown>[];
  history: (sinceIso: string) => readonly MainCommit[];
  mergedLastDay: () => number;
  now: () => Date;
  fileExists: (path: string) => boolean;
  proofsHolding: (plan: PlanInventory) => ReadonlySet<string>;
}

const MARKER = /^ {2}# backlog gardener: band=(2|3|4) evidence=([a-f0-9]{16})$/m;
const STEP = /\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\b/g;
const physicalFiles = (task: Task): string[] => (task.files ?? []).filter((p) => !/[?*\[\]{}]/.test(p));
const filingNumber = (id: string): number => Number(/-T(\d+)/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER);
const evidenceHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** A shared surface is a lead for review only when a recent merged PR covered at least two declared files. */
function overtakenBy(task: Task, history: readonly MainCommit[]): BacklogEvidence["overtaken"] {
  const files = physicalFiles(task);
  if (files.length < 2) return undefined;
  for (const commit of history) {
    if (!/\(#\d+\)$/.test(commit.subject)) continue;
    const shared = files.filter((p) => commit.files.includes(p));
    if (shared.length >= 2 && shared.length === files.length) return { sha: commit.sha, files: shared };
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
): BacklogEvidence {
  const since = now.getTime() - 24 * 3_600_000;
  const previousSince = since - 24 * 3_600_000;
  const mentioned = [...new Set([...(task.title + "\n" + (task.rationale ?? "")).matchAll(STEP)].map((m) => m[0]!).filter((s) => !s.includes(".ts") && !s.includes(".md")))];
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
    try { return symbols.length > 0 ? [readFileSync(join(repoRoot, p), "utf8")] : []; } catch { return []; }
  }).join("\n");
  const presentSymbols = symbols.filter((s) => source.includes(s));
  const missingSymbols = symbols.filter((s) => !source.includes(s));
  const overtaken = overtakenBy(task, history);
  const classValue = [...rows].reverse().find((r) => r.step === "dispatch.value.calibrated" && r.task_class === deriveTaskClass(task) && typeof r.mean === "number" && typeof r.attempts === "number");
  const value = classValue ? { mean: classValue.mean as number, attempts: classValue.attempts as number } : undefined;
  const facts = { fanout: fanout.get(task.id) ?? 0, symptoms, missingFiles, presentFiles, missingSymbols, presentSymbols, overtaken, proofsHold, classValue: value };
  return { ...facts, signature: evidenceHash(facts) };
}

/** Retirement requires positive evidence. A missing recent row alone is never enough. */
export function judgeBacklog(e: BacklogEvidence): { disposition: BacklogDisposition; reason: string } {
  if (e.proofsHold) return { disposition: { kind: "retire", retirement: "closed" }, reason: "Acceptance proofs now hold on main and did not at filing." };
  if (e.overtaken) return { disposition: { kind: "retire", retirement: "withdrawn" }, reason: `Merged commit ${e.overtaken.sha} covered its declared surface: ${e.overtaken.files.join(", ")}.` };
  const stopped = e.symptoms.filter((s) => s.earlier > 0 && s.recent === 0);
  if (stopped.length > 0 && e.fanout === 0) return { disposition: { kind: "retire", retirement: "withdrawn" }, reason: `Previously observed symptom stopped in the trailing day: ${stopped.map((s) => `${s.step} (${s.earlier} earlier, 0 recent)`).join(", ")}.` };
  if (e.fanout > 0 || e.symptoms.some((s) => s.recent > s.previousDay && s.recent > 0)) return { disposition: { kind: "band", band: 2 }, reason: e.fanout > 0 ? `Unblocks ${e.fanout} open dependent(s).` : "Its cited symptom is growing against the previous day." };
  if (e.symptoms.some((s) => s.recent > 0)) return { disposition: { kind: "band", band: 3 }, reason: "Its cited symptom remains live." };
  return { disposition: { kind: "band", band: 4 }, reason: "No observed live symptom or open dependent; the task remains valid." };
}

export function backlogInventory(sources: BacklogSources): BacklogInventory {
  const plan = sources.plan();
  const now = sources.now();
  const mergeBudget = Math.max(0, Math.floor(sources.mergedLastDay()));
  if (mergeBudget === 0) return { plan, candidates: [], mergeBudget, examined: 0 };
  const rows = sources.ledger();
  const history = sources.history(new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString());
  const openIds = new Set(plan.open.map((t) => t.id));
  const fanout = openDependentFanout(plan.all, openIds);
  const proofsHolding = sources.proofsHolding(plan);
  const candidates: BacklogAction[] = [];
  let examined = 0;
  for (const task of [...plan.open].sort((a, b) => filingNumber(a.id) - filingNumber(b.id) || a.id.localeCompare(b.id))) {
    const rel = plan.shards.get(task.id);
    if (!rel) continue;
    const text = readFileSync(join(sources.repoRoot, rel), "utf8");
    const marker = MARKER.exec(text);
    // A marked priority is ours only while it still equals the band in our marker. Any other
    // priority, including an operator amendment of a previously banded task, is authoritative.
    if (task.priority !== undefined && (!marker || task.priority !== Number(marker[1]))) continue;
    if (examined >= mergeBudget) break;
    const evidence = backlogEvidence(task, sources.repoRoot, fanout, rows, history, now, sources.fileExists, proofsHolding.has(task.id));
    if (marker && marker[2] === evidence.signature) continue;
    examined++;
    const judged = judgeBacklog(evidence);
    candidates.push({ class: judged.disposition.kind === "retire" ? "retire" : "place", target: task.id, reason: judged.reason, disposition: judged.disposition, evidence });
  }
  return { plan, candidates, mergeBudget, examined };
}

function describe(e: BacklogEvidence): string {
  const symptoms = e.symptoms.length ? e.symptoms.map((s) => `${s.step}: ${s.recent} in trailing day, ${s.earlier} earlier`).join("; ") : "no ledger step cited";
  return `fanout=${e.fanout}; symptoms=${symptoms}; files present=${e.presentFiles.join(", ") || "none"}; missing=${e.missingFiles.join(", ") || "none"}; symbols present=${e.presentSymbols.join(", ") || "none"}; missing=${e.missingSymbols.join(", ") || "none"}; merged surface=${e.overtaken?.sha ?? "none"}; proofs=${e.proofsHold ? "hold" : "not proven"}; class value=${e.classValue ? `${e.classValue.mean} over ${e.classValue.attempts} attempts` : "unavailable"}`;
}

export function applyBacklogActions(root: string, shards: ReadonlyMap<string, string>, actions: readonly BacklogAction[]): string[] {
  const paths: string[] = [];
  for (const action of actions) {
    const rel = shards.get(action.target);
    if (!rel) continue;
    const path = join(root, rel);
    const text = readFileSync(path, "utf8");
    const old = MARKER.exec(text);
    const oldBand = old ? Number(old[1]) : undefined;
    const declared = /^ {2}priority: (\d+)[ \t]*$/m.exec(text);
    if (!/^ {2}status: queued[ \t]*$/m.test(text) || /^ {2}retirement:/m.test(text)) continue;
    if (declared && (!old || Number(declared[1]) !== oldBand)) continue;
    let next = old ? text.replace(MARKER, "") : text;
    if (action.disposition.kind === "band") {
      const band = action.disposition.band;
      next = declared ? next.replace(/^ {2}priority: \d+[ \t]*$/m, `  priority: ${band}`) : next.replace(/^ {2}status: queued[ \t]*$/m, `  priority: ${band}\n  status: queued`);
      next = next.replace(/^ {2}status: queued[ \t]*$/m, `  status: queued\n  # backlog gardener: band=${band} evidence=${action.evidence.signature}`);
    } else {
      next = next.replace(/^ {2}priority: \d+[ \t]*\n/m, "");
      next = next.replace(/^ {2}status: queued[ \t]*$/m, `  status: blocked\n  retirement: ${action.disposition.retirement}\n  # backlog gardener: retirement evidence=${action.evidence.signature}`);
    }
    if (next === text) continue;
    writeFileSync(path, next);
    paths.push(rel);
  }
  return paths.sort();
}

export function backlogGardenSpec(deps: GardenerDeps, overrides: Partial<BacklogSources> = {}): GardenSpec<BacklogClass, BacklogInventory, BacklogAction, GardenCheckout> {
  const readLedger = (): readonly Record<string, unknown>[] => {
    const result = readLedgerUnionRecordsSync(deps.stateDir, { refuseIncomplete: true });
    if (!result.ok) throw new Error(`backlog gardener: incomplete ledger union: ${result.unread.join(", ")}`);
    return result.rows;
  };
  const sources: BacklogSources = {
    repoRoot: deps.repoRoot,
    plan: () => planInventory(deps.repoRoot, deps.stateDir),
    ledger: readLedger,
    history: (since) => readMainHistory(deps.repoRoot, since),
    mergedLastDay: () => readMainHistory(deps.repoRoot, new Date((deps.clock?.now() ?? Date.now()) - 24 * 3_600_000).toISOString()).filter((c) => /\(#\d+\)$/.test(c.subject)).length,
    now: () => new Date((deps.clock?.now() ?? Date.now())),
    fileExists: (path) => existsSync(join(deps.repoRoot, path)),
    proofsHolding: (plan) => new Set(retirementCandidates(plan, deps.repoRoot).filter((a) => a.retirement === "closed").map((a) => a.target)),
    ...overrides,
  };
  return {
    name: "backlog",
    classes: BACKLOG_CLASSES,
    review: { place: "priority placement is a judgement call.", retire: "retirement is a judgement call." },
    cheapFingerprint: () => `${planCheapFingerprint(deps.repoRoot, deps.stateDir)}:${gardenLedgerBucket(deps.clock ?? systemClock)}`,
    inventory: () => backlogInventory(sources),
    fingerprint: (i) => i.candidates.map((a) => `${a.target}:${a.evidence.signature}`).join("|") + `:${i.mergeBudget}`,
    unfinished: (i) => i.candidates.length > 0,
    candidates: (i) => i.candidates,
    scorecard: (i) => ({ open: i.plan.open.length, examined: i.examined, merge_budget: i.mergeBudget, proposed: i.candidates.length }),
    apply: (ws, plan) => {
      const shards = planShards(ws.root);
      const paths = applyBacklogActions(ws.root, shards, plan.actions);
      if (paths.length === 0) return undefined;
      const landed = plan.actions.filter((a) => paths.includes(shards.get(a.target) ?? ""));
      return {
        paths,
        title: `chore(plan): backlog gardener proposes ${plan.acting[0]} for ${landed.length} task(s)`,
        body: ["The backlog gardener (W1-T4941) proposes these plan-only changes. Close this PR to decline them.", "", ...landed.map((a) => `- **${a.target}**: ${a.disposition.kind === "band" ? `band ${a.disposition.band}` : a.disposition.retirement}. ${a.reason} Evidence: ${describe(a.evidence)}. Shard: \`${shards.get(a.target)}\`.`), "", "## Acceptance", ...landed.map((a) => `- claim: ${a.target} carries the proposed backlog decision\n  proof: grep: backlog gardener: in ${shards.get(a.target)}`)].join("\n"),
      };
    },
  };
}
