import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { systemClock, type Clock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";

import { declinedReasonInLedger, isRatifiedInLedger, parseDraftCache, parseProposalRegistry, type Proposal } from "./inbox.js";
import { inboxKind, inboxOwner } from "./inbox-owner.js";
import { machineTokens } from "./inbox-plain.js";
import { appendPanelLedger } from "./panel-actions.js";

/**
 * lib/fleet-lane.ts (W1-T4089) — the fleet triages its own findings.
 *
 * W1-T4086 took the fleet's own findings (620 of 674 live items on 2026-09-22) out of the operator's
 * inbox. Without this, nothing would move them: the only way a drafted finding became planned work
 * was an operator approve. Each pass, the daemon now:
 *   - MERGES a finding into an older open one about the same subject (same kind, same file, task or
 *     rule), declining the newer with a plain reason — one task, not several;
 *   - FILES findings the inbox classification calls ready, through the ordinary `rmd approve`, which
 *     re-checks readiness and opens the same gate-compliant plan PR an operator's approve does.
 * It reads that classification from the snapshot `GET /v1/inbox` writes, so a finding the inbox has
 * retired (merged task, adoption finding gone, resolved referent, superseded) never reaches it, and
 * with no snapshot it does nothing.
 *
 * PACE, NOT A CAP. It files no more in a day than the fleet merged in the last day, minus what it
 * already filed in that day, so filing follows real throughput, rises when the fleet is fast, and
 * stops on its own when the fleet falls behind.
 *
 * Each kind can be switched off with `state/FLEET_LANE_OFF-<kind>` (the PAUSE pattern); a
 * switched-off kind is left untouched. Every decision writes `fleet_lane.decided` with a plain reason.
 */

export type FleetLaneDecision = "file" | "merge";

export interface FleetLaneDeps {
  stateDir: string;
  ledgerPath: string;
  /** How many PRs the fleet merged in the last 24 hours. */
  mergedLastDay: () => number;
  /** Hand one drafted finding to the ordinary approve flow (`rmd approve`, detached). */
  approve: (proposalId: string) => void;
  clock?: Clock;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function classificationSnapshotPath(stateDir: string): string {
  return `${stateDir}/inbox-classified.json`;
}

/** Written by `GET /v1/inbox` on every read: each proposal's current classification state. */
export function writeClassificationSnapshot(stateDir: string, classifications: Array<{ proposalId: string; state: string }>): void {
  const states: Record<string, string> = {};
  for (const c of classifications) states[c.proposalId] = c.state;
  writeAtomic(classificationSnapshotPath(stateDir), JSON.stringify({ generatedAt: systemClock.iso(), states }) + "\n");
}

function readClassificationStates(stateDir: string): Record<string, string> | undefined {
  const raw = readJson(classificationSnapshotPath(stateDir));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { states?: unknown };
    return parsed.states && typeof parsed.states === "object" ? (parsed.states as Record<string, string>) : undefined;
  } catch {
    // deliberate: an unreadable snapshot reads as none, and the lane then does nothing this pass.
    return undefined;
  }
}

/** The classification states a finding can be worked from: open, not retired, declined or ratified. */
const OPEN_STATES: ReadonlySet<string> = new Set(["ready", "not_ready", "drafting", "deferred_with_trigger"]);
const ORIGIN = "fleet-lane";

/** How many commits landed on origin/main's first-parent line in the last day — the merge rate the
 *  lane paces its filing by. */
export function mergedInLastDay(repoDir: string, run: (args: string[]) => string = (args) => execFileSync("git", args, { encoding: "utf8" })): number {
  try {
    return run(["-C", repoDir, "log", "origin/main", "--first-parent", "--since=24 hours ago", "--format=%H"]).split("\n").filter(Boolean).length;
  } catch {
    // deliberate: an unanswerable merge rate is zero, which files nothing — never a guess upward.
    return 0;
  }
}

export function fleetLaneOffPath(stateDir: string, kind: string): string {
  return `${stateDir}/FLEET_LANE_OFF-${kind}`;
}

/** What a finding is ABOUT: its kind plus the first file path, task id or rule it names. Two open
 *  findings with the same subject are one piece of work. `undefined` when it names nothing shared. */
export function findingSubject(proposalId: string): string | undefined {
  const kind = inboxKind(proposalId);
  const path = /(?:src|test|scripts|docs|plan)\/[\w./-]+?\.\w+/.exec(proposalId)?.[0];
  if (path) return `${kind}|${path}`;
  const task = /\b[A-Z][A-Z0-9]*-T\d+\b/.exec(proposalId)?.[0];
  if (task) return `${kind}|${task}`;
  if (kind === "codeql-quality") return `${kind}|${proposalId.slice(kind.length + 1)}`;
  return undefined;
}

function readJson(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function readLedger(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // deliberate: a torn ledger line is skipped here; this reader only counts and looks up rows.
    }
  }
  return rows;
}

const PLAIN_REASON: Record<FleetLaneDecision, string> = {
  file: "The fleet turned this finding into planned work.",
  merge: "Folded into an older finding about the same thing, so the fleet does the work once.",
};

function decide(deps: FleetLaneDeps, proposalId: string, decision: FleetLaneDecision, extra: Record<string, unknown> = {}): void {
  const reason = PLAIN_REASON[decision];
  if (machineTokens(reason).length > 0) throw new Error(`fleet-lane: reason for ${decision} is not plain`);
  appendPanelLedger(deps.ledgerPath, "fleet_lane.decided", proposalId, ORIGIN, { decision, reason, ...extra });
}

export interface FleetLanePass {
  filed: string[];
  merged: string[];
  /** How many more this pass could have filed under the pace. */
  room: number;
}

/** One pass over the fleet lane. Pure over its deps except for the ledger rows and approve calls. */
export function triageFleetLane(deps: FleetLaneDeps): FleetLanePass {
  const now = (deps.clock ?? systemClock).now();
  const states = readClassificationStates(deps.stateDir);
  if (!states) return { filed: [], merged: [], room: 0 };
  const ledger = readLedger(deps.ledgerPath);
  const proposals = parseProposalRegistry(readJson(`${deps.stateDir}/inbox-proposals.json`));
  const drafts = parseDraftCache(readJson(`${deps.stateDir}/inbox-drafts.json`));
  // A merge is final (the finding is declined). A file is retried after a day if the finding is
  // still open — `rmd approve` refuses one that is not ready, and that must not strand it.
  const decidedIds = new Set(
    ledger
      .filter((l) => l.step === "fleet_lane.decided" && (l.decision === "merge" || (typeof l.ts === "string" && now - Date.parse(l.ts) < DAY_MS)))
      .map((l) => String(l.task_id)),
  );
  const open = proposals.filter(
    (p: Proposal) =>
      inboxOwner(p) === "fleet" &&
      OPEN_STATES.has(states[p.id] ?? "") &&
      !existsSync(fleetLaneOffPath(deps.stateDir, inboxKind(p.id))) &&
      !isRatifiedInLedger(ledger as never, p.id) &&
      declinedReasonInLedger(ledger as never, p.id) === undefined &&
      !decidedIds.has(p.id),
  );

  // MERGE: keep the oldest (registry order) finding per subject; decline the rest.
  const merged: string[] = [];
  const keeperBySubject = new Map<string, string>();
  const survivors: Proposal[] = [];
  for (const p of open) {
    const subject = findingSubject(p.id);
    const keeper = subject ? keeperBySubject.get(subject) : undefined;
    if (subject && keeper) {
      decide(deps, p.id, "merge", { into: keeper });
      appendPanelLedger(deps.ledgerPath, "panel.proposal_declined", p.id, ORIGIN, { reason: `${PLAIN_REASON.merge} (${keeper})` });
      merged.push(p.id);
      continue;
    }
    if (subject) keeperBySubject.set(subject, p.id);
    survivors.push(p);
  }

  // FILE: drafted findings, oldest of the most common kind first, at the fleet's own pace.
  const filedToday = ledger.filter(
    (l) => l.step === "fleet_lane.decided" && l.decision === "file" && typeof l.ts === "string" && now - Date.parse(l.ts) < DAY_MS,
  ).length;
  const room = Math.max(0, deps.mergedLastDay() - filedToday);
  const kindCount = new Map<string, number>();
  for (const p of survivors) kindCount.set(inboxKind(p.id), (kindCount.get(inboxKind(p.id)) ?? 0) + 1);
  const drafted = survivors
    .map((p, order) => ({ p, order }))
    .filter(({ p }) => states[p.id] === "ready" && drafts[p.id] !== undefined)
    .sort((a, b) => (kindCount.get(inboxKind(b.p.id)) ?? 0) - (kindCount.get(inboxKind(a.p.id)) ?? 0) || a.order - b.order)
    .map(({ p }) => p);
  const filed: string[] = [];
  for (const p of drafted.slice(0, room)) {
    decide(deps, p.id, "file");
    deps.approve(p.id);
    filed.push(p.id);
  }
  return { filed, merged, room: room - filed.length };
}

/** The latest fleet-lane decision per finding, for `GET /v1/inbox`'s fleet list. */
export function fleetLaneDecisions(ledger: Array<{ step?: unknown; task_id?: unknown; decision?: unknown; reason?: unknown }>): Map<string, { decision: FleetLaneDecision; reason: string }> {
  const out = new Map<string, { decision: FleetLaneDecision; reason: string }>();
  for (const l of ledger) {
    if (l.step !== "fleet_lane.decided" || typeof l.task_id !== "string") continue;
    if (l.decision !== "file" && l.decision !== "merge") continue;
    out.set(l.task_id, { decision: l.decision, reason: typeof l.reason === "string" ? l.reason : PLAIN_REASON[l.decision] });
  }
  return out;
}

/** Run one fleet-lane pass ({@link triageFleetLane}) on its own timer, never two at once. */
export function startFleetLane(
  pass: () => FleetLanePass,
  intervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
): { stop: () => void } {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      const result = pass();
      if (result.filed.length + result.merged.length > 0) log("fleet_lane.pass", { filed: result.filed.length, merged: result.merged.length, room: result.room });
    } catch (e) {
      log("fleet_lane.failed", { error: String((e as Error)?.message ?? e) });
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
