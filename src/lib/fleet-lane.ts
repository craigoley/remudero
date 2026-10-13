import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { isPromiseLike } from "./gardener.js";
import { runStepsAsync, runStepsSync, step, type Steps } from "./git-push.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { fixedClock, systemClock, type Clock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";

import { declinedReasonInLedger, isRatifiedInLedger, parseDraftCache, parseProposalRegistry, type InboxClassification, type Proposal } from "./inbox.js";
import { inboxKind, inboxOwner } from "./inbox-owner.js";
import type { AttentionJudgment } from "./inbox-responder.js";
import { replayBandMeaningRefusals, type ReplayStranded } from "./inbox-replay.js";
import { machineTokens, type PlainStore } from "./inbox-plain.js";
import { appendPanelLedger } from "./panel-actions.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { readLedgerUnionRecords, readLedgerUnionRecordsSync } from "./ledger-union.js";

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
 * It reads that classification from the snapshot serve's slow lane writes on a cadence, whether or not
 * anyone reads the inbox (inbox-view.ts), so a finding the inbox has retired (merged task, adoption
 * finding gone, resolved referent, superseded) never reaches it, and with no snapshot it does nothing.
 *
 * PACE, NOT A CAP. It files no more in a day than the fleet merged in the last day, minus what it
 * already filed in that day, so filing follows real throughput, rises when the fleet is fast, and
 * stops on its own when the fleet falls behind. It hands over ONE finding a pass: concurrent
 * `rmd approve` runs fetch the same checkout and fail on each other's ref locks (2026-09-23: 47
 * spawned in one second, 162 failed).
 *
 * ITS MEMORY IS ITS OWN STORE, `state/fleet-lane-decisions.json`, never the live ledger, which
 * rotates every few minutes: read from the ledger, every decision was forgotten and re-made.
 *
 * Each kind can be switched off with `state/FLEET_LANE_OFF-<kind>` (the PAUSE pattern); a
 * switched-off kind is left untouched. Every decision writes `fleet_lane.decided` with a plain reason.
 */

export type FleetLaneDecision = "file" | "merge";

export interface FleetLaneDeps<R extends number | Promise<number> = number> {
  stateDir: string;
  ledgerPath: string;
  /** How many PRs the fleet merged in the last 24 hours. */
  mergedLastDay: () => R;
  /** Hand one drafted finding to the ordinary approve flow (`rmd approve`, detached). */
  approve: (proposalId: string) => void;
  clock?: Clock;
  /** W1-T9065: whether this process's gateway is still running that hand-off; absent, a hand-off with no rows is left alone. */
  handoffInFlight?: (proposalId: string) => boolean;
  /** W1-T9065: origin/main's sha now, so a repeated unrecorded failure waits for main to move. */
  originMainSha?: () => string | Promise<string>;
  isPidAlive?: (pid: number) => boolean;
  /** W1-T9041: names a band-replay proposal no re-draft could clear (`escalateReplayStranded`); absent, the replay
   *  still writes its row, undelivered. */
  escalateReplayStranded?: (stranded: ReplayStranded) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function classificationSnapshotPath(stateDir: string): string {
  return `${stateDir}/inbox-classified.json`;
}

/** Whether the pass a snapshot records saw every input (W1-T5886): serve's thread list labels rows read from it. */
export interface ClassificationEvidence {
  complete: boolean;
  incompleteReason?: string;
}

/** Written by serve's slow lane (inbox-view.ts), never by a read: each proposal's current classification state. */
export function writeClassificationSnapshot(stateDir: string, classifications: Array<{ proposalId: string; state: string }>, clock: Clock = systemClock, evidence?: ClassificationEvidence): void {
  const states: Record<string, string> = {};
  for (const c of classifications) states[c.proposalId] = c.state;
  writeAtomic(classificationSnapshotPath(stateDir), JSON.stringify({ generatedAt: clock.iso(), ...(evidence ?? {}), states }) + "\n");
}

/** The last written classification, with when it was written; undefined when none is readable. `complete` is absent
 *  when the writer did not record it. */
export function readClassificationSnapshot(stateDir: string): ({ generatedAt: string | null; states: Record<string, string> } & Partial<ClassificationEvidence>) | undefined {
  const raw = readJson(classificationSnapshotPath(stateDir));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { generatedAt?: unknown; states?: unknown; complete?: unknown; incompleteReason?: unknown };
    if (!parsed.states || typeof parsed.states !== "object") return undefined;
    return {
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : null, states: parsed.states as Record<string, string>,
      ...(typeof parsed.complete === "boolean" ? { complete: parsed.complete } : {}),
      ...(typeof parsed.incompleteReason === "string" ? { incompleteReason: parsed.incompleteReason } : {}),
    };
  } catch {
    // deliberate: an unreadable snapshot reads as none, and the lane then does nothing this pass.
    return undefined;
  }
}

/** W1-T5897: everything serve's inbox readers build from, which the slow lane persists so serve's main thread never classifies. */
export function persistedInboxPath(stateDir: string): string {
  return `${stateDir}/inbox-classification.json`;
}

/** What one slow-lane pass classified. `identity` names the content; a re-stamp of the same content keeps it. */
export interface PersistedInboxContent extends ClassificationEvidence {
  sourceIdentity?: InboxSourceIdentity;
  proposals: Proposal[];
  classifications: InboxClassification[];
  /** The only ledger rows the readers take from a pass: fleet-lane decisions and verify-human releases. */
  ledgerRows: Array<Record<string, unknown>>;
  mergedTaskIds: string[];
  projectionIndeterminate: boolean;
  /** Retained attention evidence read by the slow lane, never rescanned by a console request. */
  attentionEvidence?: InboxAttentionEvidence;
  /** The decision and plain-message stores the pass's lanes were built with; absent from a file written before they were carried. */
  stores?: { fleetDecisions: DecisionStore; plainMessages: PlainStore };
}

/** The owned inputs of a non-core classification; a different source is never a substitute. */
export interface InboxSourceIdentity {
  instance: string;
  repository: string;
  root: string;
  planPath: string;
  ledgerPath: string;
  inboxRoot: string;
}

export interface InboxAttentionEvidence {
  archiveLedger: "partial" | "unavailable";
  releases: Array<[taskId: string, receipt: string]>;
  judges: Array<[taskId: string, judgement: AttentionJudgment]>;
}

function validAttentionEvidence(value: InboxAttentionEvidence | undefined, maxTasks: number): InboxAttentionEvidence | undefined {
  const taskId = (id: unknown) => typeof id === "string" && /^W\d+-T[A-Za-z0-9]+$/.test(id);
  if (!value || (value.archiveLedger !== "partial" && value.archiveLedger !== "unavailable") ||
    !Array.isArray(value.releases) || !Array.isArray(value.judges) || value.releases.length > maxTasks || value.judges.length > maxTasks) return undefined;
  const releasesValid = value.releases.every((row) => Array.isArray(row) && row.length === 2 && taskId(row[0]) && typeof row[1] === "string" && row[1].length <= 512);
  const judgesValid = value.judges.every((row) => Array.isArray(row) && row.length === 2 && taskId(row[0]) && row[1] && typeof row[1] === "object" &&
    typeof row[1].reason === "string" && row[1].reason.length <= 300 &&
    (row[1].state === "unclassified" || row[1].state === undefined && typeof row[1].decision === "string" && row[1].decision.length <= 64 ||
      row[1].state === "judged" && ["needs_operator", "automate", "backlog"].includes(row[1].decision) &&
      (row[1].at === null || typeof row[1].at === "string" && row[1].at.length <= 64)));
  return releasesValid && judgesValid ? value : undefined;
}
export interface PersistedInbox extends PersistedInboxContent {
  identity: string;
  generatedAt: string;
}

export function persistedInboxIdentity(content: PersistedInboxContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 32);
}

/** Written atomically by the slow lane, stamped at `atMs`, the same instant the view bodies it built name. */
export function writePersistedInbox(stateDir: string, content: PersistedInboxContent, atMs: number): PersistedInbox {
  const persisted = { identity: persistedInboxIdentity(content), generatedAt: fixedClock(atMs).iso(), ...content };
  writeAtomic(persistedInboxPath(stateDir), JSON.stringify(persisted) + "\n");
  return persisted;
}

/** The last persisted classification; undefined when none is readable, which a reader answers as not ready. */
export function readPersistedInbox(stateDir: string): PersistedInbox | undefined {
  const raw = readJson(persistedInboxPath(stateDir));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedInbox>;
    const valid = typeof parsed.identity === "string" && Number.isFinite(Date.parse(parsed.generatedAt ?? "")) && Array.isArray(parsed.proposals) &&
      Array.isArray(parsed.classifications) && Array.isArray(parsed.ledgerRows) && Array.isArray(parsed.mergedTaskIds) && typeof parsed.complete === "boolean";
    return valid ? { ...parsed, attentionEvidence: validAttentionEvidence(parsed.attentionEvidence, parsed.proposals!.length) } as PersistedInbox : undefined;
  } catch {
    // deliberate: a torn or foreign file is no classification, answered as not ready until the next pass rewrites it.
    return undefined;
  }
}

/** The classification states a finding can be worked from: open, not retired, declined or ratified. */
const OPEN_STATES: ReadonlySet<string> = new Set(["ready", "not_ready", "drafting", "deferred_with_trigger"]);
const ORIGIN = "fleet-lane";

/** How many commits landed on origin/main's first-parent line in the last day — the merge rate the
 *  lane paces its filing by. */
export function mergedInLastDay(repoDir: string, run: (args: string[]) => string = (args) => execFileSync("git", args, { encoding: "utf8" })): number {
  return runStepsSync(mergedInLastDaySteps(repoDir, run));
}

const mergeRateExecFile = promisify(execFile);

export function mergedInLastDayAsync(
  repoDir: string,
  run: (args: string[]) => string | Promise<string> = async (args) => (await mergeRateExecFile("git", args, { encoding: "utf8" })).stdout,
): Promise<number> {
  return runStepsAsync(mergedInLastDaySteps(repoDir, run));
}

function* mergedInLastDaySteps(repoDir: string, run: (args: string[]) => string | Promise<string>): Steps<number> {
  try {
    const raw = yield* step(() => run(["-C", repoDir, "log", "origin/main", "--first-parent", "--since=24 hours ago", "--format=%H"]));
    return raw.split("\n").filter(Boolean).length;
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

export function fleetLaneStorePath(stateDir: string): string {
  return `${stateDir}/fleet-lane-decisions.json`;
}

/** W1-T9065: a `file` decision's hand-off is `pending` until a row settles it; one that exited with no
 *  outcome row keeps `unrecorded` (the sha it failed at, and how often in a row) and no longer holds. */
export type DecisionStore = Record<string, {
  decision: FleetLaneDecision;
  ts: string;
  handoff?: "pending";
  unrecorded?: { sha?: string; count: number };
}>;

/** Every decision the lane has made. An unreadable store THROWS: read as empty, every finding would
 *  be decided again — the defect this store replaces — so the pass fails loudly instead. */
export function readFleetLaneStore(stateDir: string): DecisionStore {
  const raw = readJson(fleetLaneStorePath(stateDir));
  return raw === undefined ? {} : (JSON.parse(raw) as DecisionStore);
}

function decide(deps: FleetLaneDeps<number | Promise<number>>, store: DecisionStore, proposalId: string, decision: FleetLaneDecision, extra: Record<string, unknown> = {}): void {
  const reason = PLAIN_REASON[decision];
  if (machineTokens(reason).length > 0) throw new Error(`fleet-lane: reason for ${decision} is not plain`);
  const unrecorded = store[proposalId]?.unrecorded;
  store[proposalId] = {
    decision, ts: (deps.clock ?? systemClock).iso(),
    ...(decision === "file" ? { handoff: "pending" as const, ...(unrecorded ? { unrecorded } : {}) } : {}),
  };
  writeAtomic(fleetLaneStorePath(deps.stateDir), JSON.stringify(store) + "\n");
  appendPanelLedger(deps.ledgerPath, "fleet_lane.decided", proposalId, ORIGIN, { decision, reason, ...extra });
}

export interface FleetLanePass {
  filed: string[];
  merged: string[];
  /** How many more this pass could have filed under the pace. */
  room: number;
  /** How old the classification this pass acted on was; absent when it carried no time. */
  classificationAgeMs?: number;
}

/** W1-T9065: the rows that settle a hand-off, written by the approve child or its gateway. */
const HANDOFF_OUTCOME_STEPS: ReadonlySet<string> = new Set(["ratify.approved", "ratify.approve_refused", "approve.error", "self_sync.refused", "ratify.handoff_failed"]);
const HANDOFF_STEPS = [...HANDOFF_OUTCOME_STEPS, "ratify.cli_started", "ratify.cli_exited"];
type HandoffRows = (ledgerPath: string, since: string) => Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>;

/** One pass over the fleet lane. Pure over its deps except for the ledger rows and approve calls. */
export function triageFleetLane(deps: FleetLaneDeps): FleetLanePass {
  return runStepsSync(triageFleetLaneSteps(deps, (path, since) => readLedgerUnionRecordsSync(dirname(path), { since, step: HANDOFF_STEPS }).rows));
}

export function triageFleetLaneAsync(deps: FleetLaneDeps<number | Promise<number>>): Promise<FleetLanePass> {
  return runStepsAsync(triageFleetLaneSteps(deps, (path, since) => readLedgerUnionRecords(dirname(path), { since, step: HANDOFF_STEPS })));
}

/**
 * W1-T9065 — A HAND-OFF THAT LEFT NO OUTCOME IS A RECORDED FAILURE. The lane used to count every
 * `rmd approve` it spawned as filed and hold the finding a day, though 1,171 of them died at the
 * self-sync guard writing no row. Each pending hand-off is read against the ledger union since its
 * decision: an outcome row settles it; a child that exited (an exit row, or a dead recorded pid, or a
 * gateway this process no longer runs) without one writes `fleet_lane.approve_unrecorded` and frees
 * the finding. A running one is left alone.
 */
function* settleHandoffs(deps: FleetLaneDeps<number | Promise<number>>, store: DecisionStore, readRows: HandoffRows, withinDay: (ts: string) => boolean): Steps<void> {
  const pending = Object.entries(store).filter(([, d]) => d.handoff === "pending" && withinDay(d.ts));
  if (pending.length === 0) return;
  const since = pending.map(([, d]) => d.ts).sort()[0]!;
  const rows = yield* step(() => readRows(deps.ledgerPath, since));
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  let changed = false;
  for (const [id, entry] of pending) {
    const mine = rows.filter((r) => r.task_id === id && typeof r.ts === "string" && r.ts >= entry.ts);
    const gateway = (name: string) => mine.filter((r) => r.step === name && r.verb === "approve").at(-1);
    if (mine.some((r) => HANDOFF_OUTCOME_STEPS.has(String(r.step)))) {
      store[id] = { decision: entry.decision, ts: entry.ts };
      changed = true;
      continue;
    }
    const exited = gateway("ratify.cli_exited");
    const started = gateway("ratify.cli_started");
    if (!exited) {
      const inFlight = deps.handoffInFlight?.(id);
      if (inFlight === true) continue;
      // A started child with a live pid is still running; with no start row, only a gateway that says it
      // is no longer running here (a restart lost it before the spawn) proves the hand-off is over.
      if (started ? isPidAlive(Number(started.pid)) : inFlight === undefined) continue;
    }
    changed = true;
    const fate = exited ?? started ?? {};
    const sha = typeof fate.sha === "string" ? fate.sha : undefined;
    const count = sha !== undefined && entry.unrecorded?.sha === sha ? entry.unrecorded.count + 1 : 1;
    store[id] = { decision: entry.decision, ts: entry.ts, unrecorded: { ...(sha ? { sha } : {}), count } };
    appendPanelLedger(deps.ledgerPath, "fleet_lane.approve_unrecorded", id, ORIGIN, {
      code: exited ? exited.code ?? null : null, signal: exited?.signal ?? null, log: fate.log ?? null, sha: sha ?? null, count,
    });
  }
  if (changed) writeAtomic(fleetLaneStorePath(deps.stateDir), JSON.stringify(store) + "\n");
}

/** A hand-off that failed unrecorded frees its finding, unless it failed twice at the sha main still reads. */
function* releasedHandoffs(deps: FleetLaneDeps<number | Promise<number>>, store: DecisionStore): Steps<Set<string>> {
  const failed = Object.entries(store).filter(([, d]) => d.decision === "file" && d.handoff === undefined && d.unrecorded !== undefined);
  let mainSha: string | undefined;
  if (failed.some(([, d]) => d.unrecorded!.count >= 2)) {
    try {
      mainSha = yield* step(() => deps.originMainSha?.());
    } catch {
      // deliberate: an unreadable main is not a moved main, so a repeated failure keeps waiting.
      mainSha = undefined;
    }
  }
  return new Set(failed.filter(([, d]) => d.unrecorded!.count < 2 || (mainSha !== undefined && mainSha !== d.unrecorded!.sha)).map(([id]) => id));
}

function* triageFleetLaneSteps(deps: FleetLaneDeps<number | Promise<number>>, readRows: HandoffRows): Steps<FleetLanePass> {
  // W1-T8714: the one-shot replay of the proposals the band split lost. It only drops their cached drafts, so the
  // draft rung re-drafts them and the FILE step below hands each to `rmd approve` at this lane's own pace. W1-T9041:
  // each pass also re-lints its open entries' cached drafts, re-offering what a lint change cleared.
  replayBandMeaningRefusals({
    stateDir: deps.stateDir, ledgerPath: deps.ledgerPath, clock: deps.clock,
    classificationStates: () => readClassificationSnapshot(deps.stateDir)?.states,
    escalate: deps.escalateReplayStranded,
  });
  const now = (deps.clock ?? systemClock).now();
  const snapshot = readClassificationSnapshot(deps.stateDir);
  if (!snapshot) return { filed: [], merged: [], room: 0 };
  const { states } = snapshot;
  const generatedMs = snapshot.generatedAt === null ? Number.NaN : Date.parse(snapshot.generatedAt);
  const age = Number.isFinite(generatedMs) ? { classificationAgeMs: now - generatedMs } : {};
  const ledger = readLedger(deps.ledgerPath);
  const store = readFleetLaneStore(deps.stateDir);
  const proposals = parseProposalRegistry(readJson(`${deps.stateDir}/inbox-proposals.json`));
  const drafts = parseDraftCache(readJson(`${deps.stateDir}/inbox-drafts.json`));
  // A merge is final (the finding is declined). A file is retried after a day if the finding is
  // still open — `rmd approve` refuses one that is not ready, and that must not strand it.
  const withinDay = (ts: string) => now - Date.parse(ts) < DAY_MS;
  yield* settleHandoffs(deps, store, readRows, withinDay);
  const released = yield* releasedHandoffs(deps, store);
  const unrecorded = (id: string) => store[id]?.handoff === undefined && store[id]?.unrecorded !== undefined;
  const decidedIds = new Set(Object.entries(store).filter(([id, d]) => d.decision === "merge" || (withinDay(d.ts) && !released.has(id))).map(([id]) => id));
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
      decide(deps, store, p.id, "merge", { into: keeper });
      appendPanelLedger(deps.ledgerPath, "panel.proposal_declined", p.id, ORIGIN, { reason: `${PLAIN_REASON.merge} (${keeper})` });
      merged.push(p.id);
      continue;
    }
    if (subject) keeperBySubject.set(subject, p.id);
    survivors.push(p);
  }

  // FILE: drafted findings, oldest of the most common kind first, at the fleet's own pace.
  const filedToday = Object.entries(store).filter(([id, d]) => d.decision === "file" && withinDay(d.ts) && !unrecorded(id)).length;
  const room = Math.max(0, (yield* step(() => deps.mergedLastDay())) - filedToday);
  const kindCount = new Map<string, number>();
  for (const p of survivors) kindCount.set(inboxKind(p.id), (kindCount.get(inboxKind(p.id)) ?? 0) + 1);
  const drafted = survivors
    .map((p, order) => ({ p, order }))
    .filter(({ p }) => states[p.id] === "ready" && drafts[p.id] !== undefined)
    .sort((a, b) => (kindCount.get(inboxKind(b.p.id)) ?? 0) - (kindCount.get(inboxKind(a.p.id)) ?? 0) || a.order - b.order)
    .map(({ p }) => p);
  const filed: string[] = [];
  for (const p of drafted.slice(0, Math.min(room, 1))) {
    decide(deps, store, p.id, "file");
    deps.approve(p.id);
    filed.push(p.id);
  }
  return { filed, merged, room: room - filed.length, ...age };
}

/** The latest fleet-lane decision per finding, for `GET /v1/inbox`'s fleet list: the lane's own store
 *  first, so a decision outlives the live ledger's rotation, then any newer ledger row's reason. */
export function fleetLaneDecisions(
  ledger: Array<{ step?: unknown; task_id?: unknown; decision?: unknown; reason?: unknown }>,
  store: DecisionStore = {},
): Map<string, { decision: FleetLaneDecision; reason: string }> {
  const out = new Map<string, { decision: FleetLaneDecision; reason: string }>();
  for (const [id, d] of Object.entries(store)) out.set(id, { decision: d.decision, reason: PLAIN_REASON[d.decision] });
  for (const l of ledger) {
    if (l.step !== "fleet_lane.decided" || typeof l.task_id !== "string") continue;
    if (l.decision !== "file" && l.decision !== "merge") continue;
    out.set(l.task_id, { decision: l.decision, reason: typeof l.reason === "string" ? l.reason : PLAIN_REASON[l.decision] });
  }
  return out;
}

/** Run one fleet-lane pass ({@link triageFleetLane}) on its own timer, never two at once. */
export function startFleetLane(
  pass: () => FleetLanePass | Promise<FleetLanePass>,
  intervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
): { stop: () => void } {
  let running = false;
  const report = (result: FleetLanePass) => {
    if (result.filed.length + result.merged.length > 0) {
      log("fleet_lane.pass", { filed: result.filed.length, merged: result.merged.length, room: result.room, classificationAgeMs: result.classificationAgeMs });
    }
  };
  const failed = (e: unknown) => log("fleet_lane.failed", { error: String((e as Error)?.message ?? e) });
  const done = () => { running = false; };
  const tick = () => {
    if (running) return;
    running = true;
    try {
      const result = pass();
      if (isPromiseLike(result)) return void result.then(report).catch(failed).finally(done);
      report(result);
    } catch (e) {
      log("fleet_lane.failed", { error: String((e as Error)?.message ?? e) });
    }
    done();
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
