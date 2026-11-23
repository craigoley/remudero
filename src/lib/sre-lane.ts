import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { fixedClock, systemClock } from "./clock.js";
import { daemonInstanceRegistryPath, instanceForStateRoot } from "./deployer.js";
import { writeAtomic } from "./fs-race-safe.js";
import { listFeedback, readLandedFeedbackEntryAsync, stageFeedbackCaptureAsync, type FeedbackEntry, type FeedbackOrigin, type FeedbackStatus } from "./feedback.js";
import { overlayQueuedFeedbackEntries } from "./feedback-landing.js";
import { runStepsAsync, runStepsSync, step, type Steps } from "./git-push.js";
import type { FleetLaneDeps } from "./fleet-lane.js";
import { type FleetFlowDetector, type FleetFlowInput } from "./fleet-flow-detectors.js";
import { evaluateForeignPauseDetectors, FOREIGN_PAUSE_DETECTOR_ID, foreignPauseDetector } from "./foreign-pause-detector.js";
import { evaluateIdleCapacityDetectors, idleCapacityDetector } from "./idle-capacity-detector.js";
import { evaluateStrandedTaskDetectors, STRANDED_TASK_DETECTOR_ID, strandedTaskDetector } from "./stranded-task-detector.js";
import { assertInstanceRegistryRuntimeCurrent, runtimeInstanceRegistryText, runtimeInstanceRegistryInstanceName, InstanceRegistryRuntimeError } from "./instance-registry-selection.js";
import { parseInstanceRegistry, type RegistryInstance } from "./instance-registry.js";
import { observeSelectedRegistrySync, selectedRegistryObserverInContext } from "./selected-registry-consumers.js";
import {
  type IncidentEvidence,
  type RunbookPassResult,
} from "./sre-runbooks.js";
import { readLiveLedgerRows } from "./sweep.js";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { createLedgerRotationMemo, readLedgerUnionRecordsMemoized, type LedgerUnionRecordRead } from "./ledger-union.js";
import { createHash } from "node:crypto";
import {
  INCIDENT_TEMPLATE_REFUSAL_REASONS,
  isPublishableIncidentFingerprint,
  laneOwnedIncidentTemplateId,
  renderIncidentPublication,
  resolveIncidentTemplate,
  summarizeIncidentRefusalRows,
  type IncidentTemplate,
  type IncidentTemplateRefusalReason,
} from "./incident-templates.js";
import {
  CONTROL_INTERVENTION_STEPS,
  deriveControlInterventions,
  interventionFromLedgerRow,
  interventionIncidentEvent,
  interventionKey,
  interventionLedgerLine,
  INTERVENTION_INCIDENT_KIND,
  OPERATOR_INTERVENTION_STEP,
  type OperatorInterventionRow,
} from "./operator-interventions.js";

export type { IncidentEvidence } from "./sre-runbooks.js";

/** Individual flow detectors register here when their own tasks land. */
export const SRE_LANE_DETECTORS: readonly FleetFlowDetector[] = [idleCapacityDetector(), strandedTaskDetector(), foreignPauseDetector()];

/**
 * lib/sre-lane.ts (W1-T4385) — the SRE gardener's phase 3, in its OWN lane, not inside the core
 * daemon: a shared thread starved by fix dispatches cannot see the stall it should catch (operator
 * ruling 2026-09-23). A small own-timer loop (mirrors gardener.ts, fleet-lane.ts) reads incident
 * evidence (W1-T4383 `incident.event`/`incident.sampled`, W1-T4384 invariant findings), dedupes
 * against work the fleet already has open, gathers evidence, and files one `incident#<fingerprint>`
 * entry per pass via {@link stageFeedbackCaptureAsync} (W1-T9615) — the existing feedback -> triage -> plan -> build
 * pipeline builds the rest.
 *
 * INVARIANT: flow incident rows and filing feedback are this lane's write surfaces besides the allowlisted, reversible
 * runbooks (sre-runbooks.ts, W1-T4386) each incident is handed to first; it never dispatches a build.
 *
 * PACING: never more filings a day than the fleet merged in the last day (mirrors fleet-lane.ts).
 * `sre-lane-decisions.json` tracks what it filed; `state/SRE_LANE_OFF` is its pause switch.
 *
 * TRAP left honest rather than papered over: production wiring (src/run-task.ts) cannot yet supply
 * everything this lane wants. {@link RegistryInstance} has no `state_dir`, so `readEvents` reads
 * only this daemon's own ledger; `framesFor` returns `[]` since incident-events.ts deliberately
 * ledgers no raw frames yet.
 *
 * FALSIFIER: test/sre-lane.test.ts; {@link suspectPullRequests} is proven there with injected
 * frames, ready the day a frame store lands.
 *
 * W1-T13131 — TEMPLATE BOUNDARY: every event this lane considers must resolve a source-owned template
 * (incident-templates.ts) before it is aggregated, handed to a runbook or published. An unresolved
 * one is refused and counted once per input across passes ({@link admitTemplatedEvents}); the filed
 * body is the template's literal plus named safe fields ({@link renderIncidentPublication}), never a
 * ledgered message, name or route. Producers that write no template id stay refused until converted:
 * ci-incidents.ts (test_failure/flake), cost-anomaly.ts (anomaly) and incident-invariants.ts, and any
 * legacy `incident.event` row. This lane's own flow and intervention producers are bound by kind.
 */

// ── evidence ──────────────────────────────────────────────────────────────────────────────────

/** One `incident.event`/`incident.sampled` ledger row (incident-events.ts, incident-invariants.ts)
 *  as this lane reads it — read-only, across whichever instance ledger(s) `readEvents` covers. */
export interface IncidentLedgerEvent {
  fingerprint: string;
  /** Epoch ms — the ledger's own `ts` field, already parsed. */
  ts: number;
  kind: string;
  name: string;
  message?: string;
  route?: string;
  sha?: string;
  /** Which registry instance this row came from — surfaced in the filed evidence. */
  instance: string;
  /** W1-T14005: the {@link interventionKey} an intervention row was routed under; {@link aggregateIncidents} counts each once. */
  interventionKey?: string;
  /** W1-T13131: the row's catalog template id, unchecked — {@link resolveIncidentTemplate} decides it. */
  templateId?: unknown;
  /** W1-T13131: the reporting source the row names; a template must declare it. */
  source?: string;
}

/** One `incident.event`/`incident.sampled` ledger row (loosely typed like the rest of this repo's
 *  ledger readers: any object, since a torn or foreign line must never throw mid-scan) reduced to
 *  an {@link IncidentLedgerEvent} — `undefined` for a row missing `fingerprint`, `ts` or `kind`/
 *  `name`, which a live ledger's OWN rotation and unrelated steps make routine, not exceptional. */
export function incidentEventFromLedgerRow(row: Record<string, unknown>, instance: string): IncidentLedgerEvent | undefined {
  const fingerprint = row.fingerprint;
  const kind = row.kind;
  const name = row.name;
  const tsRaw = row.ts;
  if (typeof fingerprint !== "string" || typeof kind !== "string" || typeof name !== "string" || typeof tsRaw !== "string") {
    return undefined;
  }
  const ts = Date.parse(tsRaw);
  if (!Number.isFinite(ts)) return undefined;
  const message = typeof row.message === "string" ? row.message : undefined;
  const route = typeof row.route === "string" ? row.route : undefined;
  const sha = typeof row.sha === "string" ? row.sha : undefined;
  const key = typeof row.intervention_key === "string" ? { interventionKey: row.intervention_key } : {};
  // W1-T13131: the row's own template id, unchecked; admitTemplatedEvents resolves it (or binds this lane's own kinds).
  const template = row.template_id === undefined ? {} : { templateId: row.template_id };
  const source = typeof row.source === "string" ? { source: row.source } : {};
  return { fingerprint, ts, kind, name, message, route, sha, instance, ...key, ...template, ...source };
}

/** One reported in-app frame — mirrors {@link import("./incident-events.js").IncidentEventFrame}
 *  without importing it, since this lane's own frame source is independent of the ingest route's
 *  wire shape (see the module doc's "what production wiring cannot yet supply"). */
export interface IncidentFrameLike {
  file: string;
  fn: string;
}

/** One merged pull request and the files its commit touched — {@link suspectPullRequests}'s input. */
export interface MergedPrFiles {
  url: string;
  files: string[];
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Group `events` by fingerprint and reduce each group to its {@link IncidentEvidence}. Pure.
 *  W1-T14005: an event that names its intervention key counts once per key, at its first routing, so a repeat routing
 *  never moves the count, the span or the burn. Any other event counts by itself, as on origin/main: a keyless one
 *  origin/main wrote names no intervention, so it cannot be told from another of its message. */
export function aggregateIncidents(events: readonly IncidentLedgerEvent[]): IncidentEvidence[] {
  const byFingerprint = new Map<string, IncidentLedgerEvent[]>();
  for (const event of events) {
    const list = byFingerprint.get(event.fingerprint);
    if (list) list.push(event);
    else byFingerprint.set(event.fingerprint, [event]);
  }
  const out: IncidentEvidence[] = [];
  for (const [fingerprint, rows] of byFingerprint) {
    const counted = new Set<string>();
    const sorted = [...rows].sort((a, b) => a.ts - b.ts).filter((e) => {
      if (e.interventionKey === undefined) return true;
      if (counted.has(e.interventionKey)) return false;
      counted.add(e.interventionKey);
      return true;
    });
    const firstSeenMs = sorted[0].ts;
    const lastSeenMs = sorted[sorted.length - 1].ts;
    const spanHours = Math.max(1, (lastSeenMs - firstSeenMs) / HOUR_MS);
    const deployShas = [...new Set(sorted.map((e) => e.sha).filter((s): s is string => !!s))];
    const instances = [...new Set(sorted.map((e) => e.instance))];
    const sampleMessages = [...new Set(sorted.map((e) => e.message).filter((m): m is string => !!m))].slice(0, 3);
    out.push({
      fingerprint,
      kind: sorted[0].kind,
      name: sorted[0].name,
      sampleMessages,
      firstSeenMs,
      lastSeenMs,
      count: sorted.length,
      burnPerHour: sorted.length / spanHours,
      deployShas,
      instances,
    });
  }
  return out;
}

/** The worst-burning fingerprint among `evidence` for which `isOpen` says no work is already
 *  open — `undefined` when every fingerprint already has open work, or there is none. Pure. */
export function worstOpenIncident(
  evidence: readonly IncidentEvidence[],
  isOpen: (fingerprint: string) => boolean,
): IncidentEvidence | undefined {
  return runStepsSync(worstOpenIncidentSteps(evidence, isOpen));
}

/** W1-T13368: {@link worstOpenIncident}'s walk, written once; the pass awaits an `isOpen` that reads git. */
function* worstOpenIncidentSteps(
  evidence: readonly IncidentEvidence[],
  isOpen: (fingerprint: string) => boolean | Promise<boolean>,
): Steps<IncidentEvidence | undefined> {
  // Sorted first, then the first not-open one: the same answer as filter-then-sort (the sort is stable),
  // but `isOpen` runs only until a survivor is found, since W1-T9624's landed check costs a git read.
  for (const e of [...evidence].sort((a, b) => b.burnPerHour - a.burnPerHour)) {
    if (!(yield* step(() => isOpen(e.fingerprint)))) return e;
  }
  return undefined;
}

// ── dedupe against open work ─────────────────────────────────────────────────────────────────

/** The `FeedbackOrigin` this lane files under — new machine-origin shape (feedback.ts's own union
 *  is grown to accept it), one per fingerprint, never invented text. */
export function incidentFeedbackOrigin(fingerprint: string): FeedbackOrigin {
  return `incident#${fingerprint}` as FeedbackOrigin;
}

/** A `rejected` feedback entry is a closed, considered-and-declined decision — the only status
 *  that does NOT count as "already open" for this fingerprint. Every other status (including
 *  `accepted`, once a task exists) still means the fleet already has this incident in hand. */
const CLOSED_FEEDBACK_STATUS: FeedbackStatus = "rejected";

/** Every `incident#<fingerprint>` origin this repo has open feedback for right now — a read over
 *  {@link listFeedback}, the same store {@link stageFeedbackCaptureAsync} writes into. W1-T9615: given `stateRoot`, the
 *  records waiting in its landing queue count too, so a filing staged last pass is seen before it lands. */
export function openIncidentFeedbackOrigins(root: string, stateRoot?: string): Set<string> {
  const origins = new Set<string>();
  const entries = listFeedback(root);
  for (const entry of stateRoot === undefined ? entries : overlayQueuedFeedbackEntries(entries, stateRoot)) {
    if (typeof entry.origin === "string" && entry.origin.startsWith("incident#") && entry.status !== CLOSED_FEEDBACK_STATUS) {
      origins.add(entry.origin);
    }
  }
  return origins;
}

/** The feedback id this lane files a fingerprint under. */
export function incidentFeedbackId(fingerprint: string): string {
  return `incident-${fingerprint.slice(0, 16)}`;
}

/** W1-T9624: true when origin/main already holds this fingerprint's entry, open. The working tree can lack
 *  a landed entry while the checkout's HEAD lags main, and {@link openIncidentFeedbackOrigins} reads only
 *  the working tree. */
export function landedIncidentOpen(fingerprint: string, readLanded: (id: string) => FeedbackEntry | null): boolean {
  return landedEntryOpen(fingerprint, readLanded(incidentFeedbackId(fingerprint)));
}

function landedEntryOpen(fingerprint: string, landed: FeedbackEntry | null): boolean {
  return landed !== null && landed.origin === incidentFeedbackOrigin(fingerprint) && landed.status !== CLOSED_FEEDBACK_STATUS;
}

/** True when `fingerprint` already has open feedback (this repo's own store) or an open plan task
 *  (`hasOpenTask`, injected — the plan-side half of the same check) — the never-file-twice guard
 *  the design names. */
export function fingerprintAlreadyOpen(
  fingerprint: string,
  openFeedbackOrigins: ReadonlySet<string>,
  hasOpenTask: (fingerprint: string) => boolean,
): boolean {
  return openFeedbackOrigins.has(incidentFeedbackOrigin(fingerprint)) || hasOpenTask(fingerprint);
}

// ── suspect commits ──────────────────────────────────────────────────────────────────────────

/** Merged PRs (each with the files its commit touched) filtered to the ones that touched a file
 *  named in the incident's own in-app frames — the design's "suspect commits". Pure: intersects
 *  two sets, nothing more; `mergedPrs`/`frameFiles` are read by the caller. */
export function suspectPullRequests(mergedPrs: readonly MergedPrFiles[], frameFiles: readonly string[]): string[] {
  const frames = new Set(frameFiles);
  if (frames.size === 0) return [];
  return mergedPrs.filter((pr) => pr.files.some((f) => frames.has(f))).map((pr) => pr.url);
}

/** Real merged-PR-with-files reader: every first-parent commit merged to `origin/main` since
 *  `sinceSha` (exclusive) — or, with no known deploy sha, the last 24 hours — resolved to its own
 *  PR url via this repo's own squash-merge convention (a subject ending `(#NNNN)`) and the files
 *  that commit touched. A commit whose subject carries no PR number names no suspect — this repo's
 *  squash-merge titles always do, so that is a torn/foreign commit, not evidence to guess from.
 *  W1-T9637: ONE awaited `git log --name-only` child, never a synchronous `git show` per commit —
 *  measured 2026-10-15, that per-commit form held the daemon loop 9-16 s a filing (256-259 spawns). */
export async function mergedPrsSince(
  repoDir: string,
  owner: string,
  repo: string,
  sinceSha: string | undefined,
  run: (args: string[]) => Promise<string> = defaultGitRead,
): Promise<MergedPrFiles[]> {
  const range = sinceSha ? [`${sinceSha}..origin/main`] : ["origin/main", "--since=24 hours ago"];
  try {
    const out = await run(["-C", repoDir, "log", ...range, "--first-parent", "--name-only", "--format=%x00%H%x01%s"]);
    const merged: MergedPrFiles[] = [];
    for (const chunk of out.split("\0")) {
      const [head = "", ...files] = chunk.split("\n");
      const [sha, subject] = head.split("\u0001");
      const match = sha && subject ? /\(#(\d+)\)\s*$/.exec(subject) : null;
      if (match) merged.push({ url: `https://github.com/${owner}/${repo}/pull/${match[1]}`, files: files.filter(Boolean) });
    }
    return merged;
  } catch {
    // deliberate: an unreadable merge window names no suspects — never a guessed one.
    return [];
  }
}

const execFileAsync = promisify(execFile);
/** The awaited git read {@link mergedPrsSince} spawns by default: the loop keeps turning while it runs. */
async function defaultGitRead(args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { encoding: "utf8", maxBuffer: 1 << 26 })).stdout;
}

// ── pace ─────────────────────────────────────────────────────────────────────────────────────

/** How many more incidents this lane may file this pass — never more than the fleet merged in the
 *  last day, minus what this lane already filed today. Mirrors fleet-lane.ts's own pacing
 *  arithmetic exactly, kept as its own function so the two lanes never share a state file. */
export function sreLaneRoom(mergedLastDay: number, filedToday: number): number {
  return Math.max(0, mergedLastDay - filedToday);
}

// ── state ────────────────────────────────────────────────────────────────────────────────────

/** `count` (W1-T12836) is the incident's event count when it was filed: the base {@link interventionCountDoubled} reads. */
export type SreLaneStore = Record<string, { ts: string; count?: number }>;

/**
 * W1-T12836: an intervention incident whose count has doubled since it was filed is filed again, even while its
 * first filing is open or accepted. Measured 2026-11-15: incident-88280dcecd16e359 grew to 64 pushes after triage read
 * it as "already decided", and its task sat held — an open entry hid a recurrence that kept costing hand actions.
 * A store row with no recorded count (filed before this) has no base and is never re-filed on count.
 */
export function interventionCountDoubled(evidence: Pick<IncidentEvidence, "kind" | "count">, filed: SreLaneStore[string] | undefined): boolean {
  const base = filed?.count;
  return evidence.kind === INTERVENTION_INCIDENT_KIND && typeof base === "number" && base > 0 && evidence.count >= 2 * base;
}

export function sreLaneStorePath(stateDir: string): string {
  return join(stateDir, "sre-lane-decisions.json");
}

export function sreLaneOffPath(stateDir: string): string {
  return join(stateDir, "SRE_LANE_OFF");
}

export function readSreLaneStore(stateDir: string): SreLaneStore {
  const path = sreLaneStorePath(stateDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SreLaneStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // deliberate: an unreadable store restarts empty for pacing purposes only — the feedback-origin
    // dedupe above is the durable guard against a re-file, so nothing unsafe follows from this.
    return {};
  }
}

// ── the feedback body ────────────────────────────────────────────────────────────────────────

/** W1-T13131: the body is built from the resolved template and named safe fields only, never a sampled message. */
function incidentFeedbackRaw(evidence: IncidentEvidence, admitted: AdmittedIncident, suspectPrs: readonly string[]): string {
  return renderIncidentPublication({
    fingerprint: evidence.fingerprint,
    template: admitted.template,
    kind: evidence.kind,
    sources: [...admitted.sources],
    count: evidence.count,
    firstSeenMs: evidence.firstSeenMs,
    lastSeenMs: evidence.lastSeenMs,
    burnPerHour: evidence.burnPerHour,
    deployShas: evidence.deployShas,
    suspectPrs,
  });
}

// ── the template gate (W1-T13131) ────────────────────────────────────────────────────────────

/** One fingerprint's resolved template and the declared sources its admitted events named. */
export interface AdmittedIncident {
  template: IncidentTemplate;
  sources: Set<string>;
}

export interface TemplateAdmission {
  events: IncidentLedgerEvent[];
  admitted: Map<string, AdmittedIncident>;
  /** Refused inputs this pass saw, by reason, whether or not an earlier pass counted them. */
  refused: Record<IncidentTemplateRefusalReason, number>;
  /** How many of those no earlier pass had counted. */
  newlyCounted: number;
}

export function sreLaneTemplateRefusalsPath(stateDir: string): string {
  return join(stateDir, "sre-lane-template-refusals.json");
}

/** A refused input's counting key: a hash, so the store holds no ledgered value. Two rows identical in every field it
 *  reads (instance, fingerprint, ts, kind, template id, intervention key) are one input. */
function refusalKey(event: IncidentLedgerEvent): string {
  const basis = JSON.stringify([event.instance, event.fingerprint, event.ts, event.kind, typeof event.templateId === "string" ? event.templateId : null,
    event.interventionKey ?? null]);
  return createHash("sha256").update(basis, "utf8").digest("hex");
}

/** How long a counted refusal is remembered: longer than any window this lane reads an incident row over. */
const REFUSAL_MEMORY_MS = 8 * DAY_MS;

function readRefusalMemory(path: string): Map<string, number> {
  if (!existsSync(path)) return new Map();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { counted?: unknown };
  const counted = typeof parsed === "object" && parsed !== null && typeof parsed.counted === "object" && parsed.counted !== null ? parsed.counted : {};
  return new Map(Object.entries(counted).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

/**
 * W1-T13131: the template gate. Each event resolves its template ({@link resolveIncidentTemplate}); one that does not, or
 * names an unpublishable fingerprint, is refused, and so is every event of a fingerprint whose events name two different
 * templates (its identity is contested). Refused events are dropped BEFORE aggregation, so a refused worst never hides a
 * later valid candidate, and never reaches a runbook or a filing. Each refused input is counted once: its
 * {@link refusalKey} is kept, at the row's own instant, until it is older than every read window. A pass that counts any
 * input logs one `sre_lane.template_refused` row of bounded counts by reason. An unreadable memory is logged and counts
 * nothing that pass, so a torn store can never re-count an input.
 */
export function admitTemplatedEvents(
  events: readonly IncidentLedgerEvent[],
  input: { stateDir: string; nowMs: number; log: SreLaneInput["log"]; readRefusalRows?: SreLaneInput["readRefusalRows"] },
): TemplateAdmission {
  const zero = () => Object.fromEntries(INCIDENT_TEMPLATE_REFUSAL_REASONS.map((r) => [r, 0])) as Record<IncidentTemplateRefusalReason, number>;
  const resolutions = events.map((event) => {
    const templateId = event.templateId !== undefined ? event.templateId : laneOwnedIncidentTemplateId(event.source, event.kind);
    const resolved = resolveIncidentTemplate({ templateId, kind: event.kind, source: event.source });
    return resolved.ok && !isPublishableIncidentFingerprint(event.fingerprint) ? { ok: false as const, reason: "malformed" as const } : resolved;
  });
  const templatesOf = new Map<string, Set<string>>();
  events.forEach((event, i) => {
    const resolved = resolutions[i];
    if (resolved.ok) templatesOf.set(event.fingerprint, (templatesOf.get(event.fingerprint) ?? new Set()).add(resolved.template.id));
  });
  const admitted = new Map<string, AdmittedIncident>();
  const eligible: IncidentLedgerEvent[] = [];
  const refusals: Array<{ event: IncidentLedgerEvent; reason: IncidentTemplateRefusalReason }> = [];
  events.forEach((event, i) => {
    const resolved = resolutions[i];
    if (!resolved.ok) return void refusals.push({ event, reason: resolved.reason });
    if (templatesOf.get(event.fingerprint)!.size > 1) return void refusals.push({ event, reason: "mismatched" });
    const bound = admitted.get(event.fingerprint) ?? { template: resolved.template, sources: new Set<string>() };
    if (event.source !== undefined) bound.sources.add(event.source);
    admitted.set(event.fingerprint, bound);
    eligible.push(event);
  });
  const refused = zero();
  for (const { reason } of refusals) refused[reason] += 1;
  let newlyCounted = 0;
  if (refusals.length) {
    const path = sreLaneTemplateRefusalsPath(input.stateDir);
    let counted: Map<string, number> | undefined;
    try {
      counted = readRefusalMemory(path);
    } catch (error) {
      input.log("sre_lane.template_refusals_unread", { error: String((error as Error)?.message ?? error) });
    }
    if (counted) {
      const reasons = zero();
      for (const { event, reason } of refusals) {
        const key = refusalKey(event);
        if (counted.has(key)) continue;
        counted.set(key, event.ts);
        newlyCounted += 1;
        reasons[reason] += 1;
      }
      if (newlyCounted) {
        for (const [key, ts] of counted) if (ts < input.nowMs - REFUSAL_MEMORY_MS) counted.delete(key);
        writeAtomic(path, JSON.stringify({ counted: Object.fromEntries(counted) }) + "\n");
        // The ledger's own refusal rows (ingest and earlier passes), read by step: counts only, context for this pass's count.
        const ledgered = input.readRefusalRows ? { ledgered: summarizeIncidentRefusalRows(input.readRefusalRows()) } : {};
        input.log("sre_lane.template_refused", { refused: newlyCounted, ...reasons, ...ledgered });
      }
    }
  }
  return { events: eligible, admitted, refused, newlyCounted };
}

// ── one pass ─────────────────────────────────────────────────────────────────────────────────

/** `stateDir`, `mergedLastDay` and `clock` are fleet-lane.ts's own members — this lane paces and
 *  pauses exactly as that one does — so they are reused from {@link FleetLaneDeps}, not redeclared. */
export type SreLaneInput = Pick<FleetLaneDeps, "stateDir" | "mergedLastDay" | "clock"> & {
  /** Repo root — where {@link stageFeedbackCaptureAsync}/{@link listFeedback} read and write. */
  root: string;
  /** W1-T9615: the daemon's state root, whose landing queue the per-poll async sweep drains. A filing is staged there and
   *  never landed inline. Absent, the entry stays in `root`'s checkout for that sweep's dirty scan. */
  landingStateRoot?: string;
  /** Every incident.event/incident.sampled row this pass should consider, read-only. */
  readEvents: () => IncidentLedgerEvent[];
  /** W1-T13131: the ledger's rows, read only for their refusal steps ({@link summarizeIncidentRefusalRows}). Optional. */
  readRefusalRows?: () => ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** True when a plan task already exists for this fingerprint (the plan-side dedupe half). */
  hasOpenTask: (fingerprint: string) => boolean;
  /** The in-app frames captured for a fingerprint's recent samples, for suspect-commit matching. */
  framesFor: (fingerprint: string) => IncidentFrameLike[];
  /** Merged PRs (with files) since a deploy sha — `undefined` sha reads the last 24 hours. */
  mergedPrsSince: (sinceSha: string | undefined) => MergedPrFiles[] | Promise<MergedPrFiles[]>;
  log: (step: string, extra?: Record<string, unknown>) => void;
  /** W1-T4386: the runbook pass is composed at the daemon boundary. Absent, incidents file as before. */
  runbookPass?: (incident: IncidentEvidence) => Promise<RunbookPassResult>;
  /** W1-T13367: the daemon's reader of {@link SRE_LANE_FLOW_SLICE}. A pass reads it once, off the loop, and each
   *  detector gets its rows from it. Absent, or with `readFlowRows`, each detector reads as before. */
  flowHistory?: (stateDir: string) => Promise<LedgerUnionRecordRead>;
  /** W1-T14005 seam: the intervention incident.event rows written since an instant, rotated ones included. Absent,
   *  {@link readInterventionRoutingHistory} over `stateDir`'s ledger union. */
  readRoutingHistory?: InterventionRoutingHistory;
  detectors?: readonly FleetFlowDetector[];
  readFlowRows?: FleetFlowInput["readRows"];
  writeFlowEvent?: FleetFlowInput["writeEvent"];
  /** W1-T9624 seam: the entry origin/main holds for a feedback id. Absent, {@link readLandedFeedbackEntryAsync}. */
  readLandedEntry?: (id: string) => FeedbackEntry | null | Promise<FeedbackEntry | null>;
};

export interface SreLanePass {
  /** The fingerprint filed this pass, if any. */
  filed?: string;
  /** How many more this pass could have filed under the pace, after this pass's own filing. */
  room: number;
  /** What the runbook matcher did with this pass's incident, when a catalog is wired. */
  runbook?: RunbookPassResult;
}

/** One pass: aggregate evidence, skip fingerprints with open feedback or an open task, hand the
 *  worst-burning survivor to {@link runMatchingRunbook}, and file it at the fleet's own pace unless a
 *  runbook still owns it. The runbook step is NOT paced: a fleet that merged nothing is exactly the
 *  one whose stale checkout most needs healing, and whose fast burn most needs the operator. Never files more than one fingerprint a pass —
 *  the same one-at-a-time discipline fleet-lane.ts's `triageFleetLane` uses, and for the same
 *  reason: a burst of concurrent filers racing the same checkout is worse than a slower lane. */
export async function runSreLanePass(deps: SreLaneInput): Promise<SreLanePass> {
  if (existsSync(sreLaneOffPath(deps.stateDir))) return { room: 0 };
  const now = (deps.clock ?? systemClock).now();
  const detectors = deps.detectors ?? SRE_LANE_DETECTORS;
  const flowInput = { stateDir: deps.stateDir, nowMs: now, readRows: deps.readFlowRows ?? sliceFlowRows(deps, detectors), writeEvent: deps.writeFlowEvent };
  // W1-T8240: the stranded-task detector takes its bound from the ledger and keeps its own dedupe memory, so the
  // shared evaluator (which rewrites the fleet-flow store whole each pass) never sees it.
  const flowRows = [
    ...await evaluateIdleCapacityDetectors({
      ...flowInput,
      detectors: detectors.filter((d) => d.id !== STRANDED_TASK_DETECTOR_ID && d.id !== FOREIGN_PAUSE_DETECTOR_ID),
    }),
    ...await evaluateStrandedTaskDetectors({ ...flowInput, detectors }),
    // W1-T8245: a foreign hold is judged by its idle cost against the instance's own automation holds, from the ledger.
    ...await evaluateForeignPauseDetectors({ ...flowInput, detectors }),
    // W1-T8264: every hand action is a cause-classed intervention, routed as one incident per class.
    ...await routeOperatorInterventions({ ...flowInput, detectors, readRoutingHistory: deps.readRoutingHistory, log: deps.log }),
  ];
  const store = readSreLaneStore(deps.stateDir);
  const withinDay = (ts: string) => now - Date.parse(ts) < DAY_MS;
  const filedToday = Object.values(store).filter((d) => withinDay(d.ts)).length;
  const room = sreLaneRoom(deps.mergedLastDay(), filedToday);
  const runMatchingRunbook = deps.runbookPass;
  if (room <= 0 && !runMatchingRunbook) return { room };

  const openOrigins = openIncidentFeedbackOrigins(deps.root, deps.landingStateRoot);
  const events = [...deps.readEvents()];
  // An injected or lagging incident reader may not yet see this pass's writes. Include each once.
  for (const row of flowRows) {
    if (events.some((e) => e.fingerprint === row.fingerprint && e.ts === now && e.message === row.message)) continue;
    const event = incidentEventFromLedgerRow({ ...row, ts: fixedClock(now).iso() }, deps.root);
    if (event) events.push(event);
  }
  // W1-T14005 round 5: the daemon's incident reader reads the live ledger file only, and a rotation moves keyed routings
  // out of it, so the class's count fell and its burn rose with no new intervention. The routing memory the pass just
  // wrote holds every keyed routing whose row is still read, rotated or not, and reading it decompresses no rotation;
  // aggregateIncidents counts each key once, so a routing in both is counted once.
  const instanceOf = new Map(events.map((e) => [e.fingerprint, e.instance]));
  for (const routing of keyedRoutingEvidence(deps.stateDir, deps.log)) {
    events.push({ ...routing, instance: instanceOf.get(routing.fingerprint) ?? deps.root });
  }
  // W1-T13131: no event reaches aggregation, a runbook or a filing without a resolved template.
  const admission = admitTemplatedEvents(events, { stateDir: deps.stateDir, nowMs: now, log: deps.log, readRefusalRows: deps.readRefusalRows });
  const evidence = aggregateIncidents(admission.events);
  const readLanded = deps.readLandedEntry ?? ((id: string) => readLandedFeedbackEntryAsync(deps.root, id));
  const byFingerprint = new Map(evidence.map((e) => [e.fingerprint, e]));
  const doubled = (fp: string) => interventionCountDoubled(byFingerprint.get(fp)!, store[fp]);
  // W1-T13368: the landed read is awaited, and one pass asks it once for a fingerprint.
  const landedOpen = new Map<string, boolean>();
  const landedIsOpen = async (fp: string): Promise<boolean> => {
    if (!landedOpen.has(fp)) landedOpen.set(fp, landedEntryOpen(fp, await readLanded(incidentFeedbackId(fp))));
    return landedOpen.get(fp)!;
  };
  const worst = await runStepsAsync(worstOpenIncidentSteps(evidence, (fp) => !doubled(fp) &&
    (fingerprintAlreadyOpen(fp, openOrigins, deps.hasOpenTask) || landedIsOpen(fp))));
  if (!worst) return { room };
  const refiled = doubled(worst.fingerprint);

  const runbook = runMatchingRunbook ? await runMatchingRunbook(worst) : undefined;
  if (room <= 0 || (runbook && !runbook.fileFeedback)) return { room, runbook };

  const frameFiles = deps.framesFor(worst.fingerprint).map((f) => f.file);
  const suspectPrs = suspectPullRequests(await deps.mergedPrsSince(worst.deployShas[0]), frameFiles);
  const staged = await stageFeedbackCaptureAsync(deps.root, deps.landingStateRoot, {
    raw: incidentFeedbackRaw(worst, admission.admitted.get(worst.fingerprint)!, suspectPrs),
    origin: incidentFeedbackOrigin(worst.fingerprint),
    // A re-filing is its own entry: the first one's id still names the filing that is open or accepted.
    id: refiled ? `${incidentFeedbackId(worst.fingerprint)}-n${worst.count}` : incidentFeedbackId(worst.fingerprint),
  });
  const priorCount = store[worst.fingerprint]?.count;
  store[worst.fingerprint] = { ts: fixedClock(now).iso(), count: worst.count };
  writeAtomic(sreLaneStorePath(deps.stateDir), JSON.stringify(store) + "\n");
  deps.log("sre_lane.filed", {
    fingerprint: worst.fingerprint,
    count: worst.count,
    ...(refiled ? { refiled: true, prior_count: priorCount } : {}),
    burn_per_hour: worst.burnPerHour,
    suspect_prs: suspectPrs.length,
    landing: staged.queued ? "queued" : "checkout",
    ...(staged.error === undefined ? {} : { landing_error: staged.error }),
  });
  return { filed: worst.fingerprint, room: room - 1, runbook };
}

/** Run {@link runSreLanePass} on its own timer, never two at once — mirrors gardener.ts's and
 *  fleet-lane.ts's own tick wrappers. Returns a `(pollIntervalMs) => {stop}` starter, the exact
 *  shape `src/run-task.ts`'s daemon `gardens` array already takes every other lane as;
 *  `settled()` resolves once the pass in flight (if any) finishes. */
export function startSreLane(deps: SreLaneInput): (pollIntervalMs: number) => { stop: () => void; settled: () => Promise<void> } {
  return (pollIntervalMs: number) => {
    // A runbook awaits its act, so a slow pass must not overlap the next tick: skip, never queue.
    let inFlight: Promise<void> | undefined;
    const tick = () => {
      if (inFlight) return;
      inFlight = runSreLanePass(deps)
        .then(
          () => undefined,
          (e: unknown) => deps.log("sre_lane.failed", { error: String((e as Error)?.message ?? e) }),
        )
        .finally(() => {
          inFlight = undefined;
        });
    };
    tick();
    const timer = setInterval(tick, pollIntervalMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer), settled: async () => inFlight };
  };
}

/** The daemon's lane input (src/run-task.ts): `readEvents` reads only this daemon's own ledger and
 *  `hasOpenTask`/`framesFor` answer nothing yet — the module doc's TRAP. W1-T9615: a filing is staged in the landing
 *  queue of the daemon's state root (the parent of `stateDir` unless named), never landed on the loop. */
export async function daemonSreLaneInput(
  input: Pick<SreLaneInput, "stateDir" | "root" | "mergedLastDay" | "log" | "runbookPass" | "flowHistory"> & { ledgerPath: string; owner: string; repo: string; landingStateRoot?: string },
): Promise<SreLaneInput> {
  const instance = await resolveSreLaneInstance({
    stateRoot: dirname(input.stateDir),
    registryPath: process.env.RMD_SELECTED_INSTANCE_REGISTRY !== undefined
      ? process.env.RMD_SELECTED_INSTANCE_REGISTRY.trim()
      : process.env.RMD_INSTANCE_REGISTRY?.trim() || daemonInstanceRegistryPath(input.root),
  });
  const name = instance.resolved ? instance.name : "unknown";
  return {
    stateDir: input.stateDir,
    root: input.root,
    landingStateRoot: input.landingStateRoot ?? dirname(input.stateDir),
    detectors: SRE_LANE_DETECTORS.map((detector) =>
      detector.id === "idle-capacity" ? idleCapacityDetector(name)
        : detector.id === FOREIGN_PAUSE_DETECTOR_ID ? foreignPauseDetector(name) : detector),
    flowHistory: input.flowHistory,
    // W1-T13367: the live file's rows only, as before, from the tail that parses only the bytes added since its last read.
    readEvents: () =>
      readLiveLedgerRows(input.ledgerPath)
        .filter((row) => row.task_id === "INCIDENT" && (row.step === "incident.event" || row.step === "incident.sampled"))
        .map((row) => incidentEventFromLedgerRow(row, instance.resolved ? instance.name : input.repo))
        .filter((event): event is IncidentLedgerEvent => event !== undefined),
    readRefusalRows: () => readLiveLedgerRows(input.ledgerPath),
    hasOpenTask: () => false,
    framesFor: () => [],
    mergedPrsSince: (sinceSha) => mergedPrsSince(input.root, input.owner, input.repo, sinceSha),
    mergedLastDay: input.mergedLastDay,
    log: input.log,
    runbookPass: input.runbookPass,
  };
}

// ── which instance runs the lane (W1-T8232) ───────────────────────────────────────────────────

/**
 * W1-T8232 — the daemon's own registry row, as the lane's start decision reads it, or why it could
 * not be resolved. MEASURED 2026-10-11: the lane started only on `RMD_SRE_LANE=1`, no container was
 * given that variable, and 284 `incident.event` rows that day reached no reader. The registry's
 * `primary: true` row (W1-T4527) is the selector the old opt-in was waiting for.
 */
export type SreLaneInstance =
  | ({ resolved: true; resolvedBy?: SreLaneResolvedBy } & Pick<RegistryInstance, "name" | "live" | "primary">)
  | { resolved: false; why: string; resolvedBy?: SreLaneResolvedBy };

/**
 * W1-T9500 — how the instance was looked up: `env` is the `RMD_INSTANCE_NAME` the container's
 * creator passed, `state_root` is W1-T8232's match of the state root against the registry's
 * `state_dir`. Absent only when the registry itself could not be read or parsed.
 */
export type SreLaneResolvedBy = "env" | "state_root";

/** The env names the start decision reads — passed in, never read here, so the predicate is pure. */
export interface SreLaneEnv {
  RMD_SRE_LANE?: string;
}

export interface SreLaneStartInput {
  instance: SreLaneInstance;
  env: SreLaneEnv;
}

export type SreLaneDecision =
  | { enabled: true; instance: string | null; enabledBy: "primary" | "env" }
  | { enabled: false; instance: string | null; reason: string };

/**
 * W1-T8232 — whether this daemon runs the SRE lane, and why. `RMD_SRE_LANE=0` is an explicit off
 * that wins everywhere; otherwise the registry's live `primary: true` row runs it with no opt-in;
 * `RMD_SRE_LANE=1` still turns it on anywhere, for existing hand setups. An instance that cannot be
 * resolved is OFF, and the reason says why — never "behave as if primary".
 */
export function sreLaneDecision({ instance, env }: SreLaneStartInput): SreLaneDecision {
  const name = instance.resolved ? instance.name : null;
  const flag = env.RMD_SRE_LANE?.trim();
  if (flag === "0") return { enabled: false, instance: name, reason: "RMD_SRE_LANE=0 turns the lane off explicitly" };
  if (instance.resolved && instance.live && instance.primary === true) return { enabled: true, instance: name, enabledBy: "primary" };
  if (flag === "1") return { enabled: true, instance: name, enabledBy: "env" };
  if (!instance.resolved) return { enabled: false, instance: null, reason: instance.why };
  if (!instance.live) return { enabled: false, instance: name, reason: `instance '${instance.name}' is retired in the registry` };
  return { enabled: false, instance: name, reason: `instance '${instance.name}' is not the registry's primary instance` };
}

/** W1-T8232 — the ONE predicate the daemon decides the lane with (src/run-task.ts). */
export function sreLaneEnabled(input: SreLaneStartInput): boolean {
  return sreLaneDecision(input).enabled;
}

/**
 * W1-T8232 — the one ledger row a daemon start writes about the lane, so "is the SRE lane running"
 * is a ledger read and not a container inspect: `sre_lane.started` {instance, enabled_by} or
 * `sre_lane.disabled` {instance, reason}. W1-T9500: each also carries `resolved_by` (env or
 * state_root) whenever the registry was read, so a disabled row says which lookup missed.
 */
export function sreLaneStartRow(input: SreLaneStartInput): { step: "sre_lane.started" | "sre_lane.disabled"; fields: Record<string, unknown> } {
  const decision = sreLaneDecision(input);
  const by = input.instance.resolvedBy === undefined ? {} : { resolved_by: input.instance.resolvedBy };
  return decision.enabled
    ? { step: "sre_lane.started", fields: { instance: decision.instance, enabled_by: decision.enabledBy, ...by } }
    : { step: "sre_lane.disabled", fields: { instance: decision.instance, reason: decision.reason, ...by } };
}

/**
 * W1-T8232 — this daemon's registry row, or why it could not be resolved. An unreadable registry,
 * a registry the parser refuses, and no or an ambiguous match each resolve to `{resolved: false}`
 * naming the reason.
 *
 * W1-T9500 — THE CREATOR'S NAME FIRST. W1-T8232 matched the state root against each row's
 * `state_dir` ({@link instanceForStateRoot}), but those are HOST paths and inside every container
 * the root is /home/node/Remudero; mountinfo reads the filesystem-relative source (/state2), so the
 * host path cannot be recovered in there either. MEASURED 2026-10-14: 63 `sre_lane.disabled` rows
 * and 0 `sre_lane.started` on core. So `deploy/recycle-container.sh --instance` and the installed
 * launcher pass `RMD_INSTANCE_NAME`, and a set name wins: it must name a parsed row (the parser
 * refuses a name declared twice), and a name the registry does not hold resolves false naming it —
 * never a fallback to the root match, which would hide a misconfigured creator. With no name (a
 * host-side caller), the root match runs as before. `env` defaults to `process.env`: the daemon's callers (src/run-task.ts and
 * {@link daemonSreLaneInput}) read it from the container's own environment.
 */
export async function resolveSreLaneInstance(input: {
  stateRoot: string;
  registryPath: string;
  readText?: (path: string) => string;
  env?: { RMD_INSTANCE_NAME?: string };
}): Promise<SreLaneInstance> {
  await assertInstanceRegistryRuntimeCurrent();
  const selectedText = runtimeInstanceRegistryText();
  if (selectedText === undefined && process.env.RMD_SELECTED_INSTANCE_REGISTRY !== undefined) {
    throw new InstanceRegistryRuntimeError("selection_missing");
  }
  const result = resolveLegacySreLaneInstance(selectedText === undefined ? input : {
    ...input, registryPath: "selected registry", readText: () => selectedText,
    env: { RMD_INSTANCE_NAME: runtimeInstanceRegistryInstanceName() },
  });
  if (selectedText !== undefined && !result.resolved) {
    throw new InstanceRegistryRuntimeError("target_missing_or_mismatched");
  }
  return observeSelectedRegistrySync(selectedRegistryObserverInContext(), "sre-target", {
    instanceName: result.resolved ? result.name : undefined, stateRoot: input.stateRoot,
    namespace: result.resolvedBy === "env" ? "container" : "host",
  }, () => result);
}

function resolveLegacySreLaneInstance(input: {
  stateRoot: string;
  registryPath: string;
  readText?: (path: string) => string;
  env?: { RMD_INSTANCE_NAME?: string };
}): SreLaneInstance {
  let text: string;
  try {
    text = (input.readText ?? ((path) => readFileSync(path, "utf8")))(input.registryPath);
  } catch (error) {
    return { resolved: false, why: `the instance registry ${input.registryPath} is unreadable: ${(error as Error).message}` };
  }
  const named = (input.env ?? process.env).RMD_INSTANCE_NAME?.trim() || undefined;
  const resolvedBy: SreLaneResolvedBy = named === undefined ? "state_root" : "env";
  const name = named ?? instanceForStateRoot(text, input.stateRoot);
  if (name === undefined) {
    return { resolved: false, resolvedBy, why: `state root ${input.stateRoot} is not exactly one instance's state_dir in ${input.registryPath}` };
  }
  let row: RegistryInstance | undefined;
  try {
    // The parser refuses a name declared twice (duplicate_instance), so a found row is the only one.
    row = parseInstanceRegistry(text).instances.find((instance) => instance.name === name);
  } catch (error) {
    return { resolved: false, why: `the instance registry ${input.registryPath} is refused: ${(error as Error).message}` };
  }
  if (row === undefined && named !== undefined) return { resolved: false, resolvedBy, why: `RMD_INSTANCE_NAME '${name}' names no instance in ${input.registryPath}` };
  if (row === undefined) return { resolved: false, resolvedBy, why: `instance '${name}' is not a parsed row of ${input.registryPath}` };
  return { resolved: true, resolvedBy, name: row.name, live: row.live, ...(row.primary === undefined ? {} : { primary: row.primary }) };
}

// ── W1-T8264: hand actions as cause-classed interventions ─────────────────────────────────────

/** The control-surface inputs, recorded interventions, and evidence of prior routings. */
const INTERVENTION_INPUTS: readonly string[] = [
  ...CONTROL_INTERVENTION_STEPS, "cli.invoked", "dispatch.circuit_broken", "dispatch.circuit_broken.verified", OPERATOR_INTERVENTION_STEP,
  "incident.event",
];
const INTERVENTION_WINDOW_MS = 7 * DAY_MS;

function interventionReadPattern(steps: readonly string[]): RegExp {
  const ordinary = steps.filter((step) => step !== "incident.event")
    .map((step) => step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const incidents = /^(?=.*"step"\s*:\s*"incident\.event")(?=.*"kind"\s*:\s*"intervention")/;
  return new RegExp(`"step"\\s*:\\s*"(?:${ordinary})"|${incidents.source}`);
}

/** W1-T13367: the one ledger slice the daemon's lane reads: the registered detectors' inputs and the intervention
 *  inputs. No registered input has a `*`, so each is named as a step; {@link sliceFlowRows} keeps a detector whose
 *  input is not named here on its own reader. */
export const SRE_LANE_FLOW_SLICE = {
  holder: "sre-lane.flow-history",
  steps: [...new Set([...SRE_LANE_DETECTORS.flatMap((d) => [...d.inputs]), ...INTERVENTION_INPUTS])],
};

/** W1-T13367: the row seam over {@link SreLaneInput.flowHistory}. One pass reads the slice once. Each asker gets the
 *  rows of its own steps and window, as its own union read returns them, and fails with its own text when the slice
 *  is not whole. Undefined with no reader, or for a detector input the slice does not name. */
function sliceFlowRows(deps: Pick<SreLaneInput, "flowHistory" | "stateDir">, detectors: readonly FleetFlowDetector[]): FleetFlowInput["readRows"] {
  const history = deps.flowHistory;
  if (!history || !detectors.every((d) => d.inputs.every((input) => SRE_LANE_FLOW_SLICE.steps.includes(input)))) return undefined;
  let read: Promise<LedgerUnionRecordRead> | undefined;
  return async (sinceMs, _nowMs, asker) => {
    const slice = await (read ??= history(deps.stateDir));
    if (!slice.ok) throw new Error(`${asker.reader} ledger unreadable: ${slice.unread.join(", ")}`);
    // The union's own `since` rule: a row with no `ts` string is dropped, and one timed before the window is.
    return slice.rows.filter((row) => typeof row.ts === "string" && !(Date.parse(row.ts) < sinceMs) &&
      typeof row.step === "string" && asker.inputs.includes(row.step));
  };
}
const interventionReaders = new Map<string, ReturnType<typeof createLedgerRotationMemo>>();

function interventionMemoryPath(stateDir: string): string {
  return join(stateDir, "operator-interventions.json");
}

/** The latest finite instant among `values`; NaN when none is. */
function latestMs(...values: Array<number | undefined>): number {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return finite.length ? Math.max(...finite) : Number.NaN;
}

const keyAtMs = (key: string) => Date.parse(key.slice(key.lastIndexOf("|") + 1));

function routingIdentity(row: OperatorInterventionRow): string {
  return JSON.stringify([row.surface, row.action, row.target, row.actor, row.cause_class]);
}

function routingMessageIdentity(message: string | undefined): string | undefined {
  const match = message?.match(/^surface=(control|pr) action=(.*?) target=(.*?) actor=(.*?) cause=(.*?)(?: file=.*?)? — a hand action answered a fleet state no lane resolved$/s);
  return match ? JSON.stringify(match.slice(1)) : undefined;
}

function routingOccurrenceKey(key: string, identity: string): string {
  return JSON.stringify([key, identity]);
}

function emptyInterventionMemory(): InterventionMemory {
  return { routed: new Map(), routings: new Map(), complete: false };
}

/**
 * W1-T14005: the routing memory, each routed key with the latest instant a row that carried it was stamped at: the
 * later of that row's ledger `ts` and its intervention's `at`. A memory written before this holds bare keys, which
 * recorded only their `at`. Absent or empty, it is rebuilt from the ledger. Malformed data throws, since reading a
 * structured entry with an invalid `seen` as a bare key could suppress a routing.
 */
function readInterventionMemory(path: string): InterventionMemory {
  const empty = emptyInterventionMemory();
  const { routed, routings } = empty;
  if (!existsSync(path)) return empty;
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return empty;
  const parsed = JSON.parse(text) as { routed?: unknown; complete?: unknown; pending?: unknown };
  const invalid = () => new Error(`Invalid operator-intervention memory: ${path}`);
  if (parsed.routed !== undefined && !Array.isArray(parsed.routed)) throw invalid();
  if (parsed.complete !== undefined && typeof parsed.complete !== "boolean") throw invalid();
  for (const entry of (parsed.routed ?? []) as unknown[]) {
    if (typeof entry === "string") {
      routed.set(entry, latestMs(routed.get(entry), keyAtMs(entry)));
      continue;
    }
    const record = (typeof entry === "object" && entry !== null ? entry : {}) as { key?: unknown; seen?: unknown };
    const seenMs = typeof record.seen === "string" ? Date.parse(record.seen) : Number.NaN;
    if (typeof record.key !== "string" || !Number.isFinite(seenMs)) throw invalid();
    routed.set(record.key, latestMs(routed.get(record.key), seenMs, keyAtMs(record.key)));
    const routing = (record as { routing?: unknown }).routing;
    if (routing === undefined) continue;
    const r = (typeof routing === "object" && routing !== null ? routing : {}) as { at?: unknown; fingerprint?: unknown; name?: unknown; message?: unknown };
    const atMs = typeof r.at === "string" ? Date.parse(r.at) : Number.NaN;
    if (!Number.isFinite(atMs) || typeof r.fingerprint !== "string" || typeof r.name !== "string" || typeof r.message !== "string") throw invalid();
    routings.set(record.key, { atMs, fingerprint: r.fingerprint, name: r.name, message: r.message });
  }
  let pending: InterventionMemory["pending"];
  if (parsed.pending !== undefined) {
    const marker = (typeof parsed.pending === "object" && parsed.pending !== null ? parsed.pending : {}) as { since?: unknown; through?: unknown };
    const sinceMs = typeof marker.since === "string" ? Date.parse(marker.since) : Number.NaN;
    const throughMs = typeof marker.through === "string" ? Date.parse(marker.through) : Number.NaN;
    if (!Number.isFinite(sinceMs) || !Number.isFinite(throughMs)) throw invalid();
    pending = { sinceMs, throughMs };
  }
  return { routed, routings, complete: parsed.complete === true, ...(pending ? { pending } : {}) };
}

/**
 * W1-T14005 round 5: the routing memory as one pass reads and writes it.
 * - `routed`: each routed key with its `seen` instant ({@link readInterventionMemory}).
 * - `complete`: the last pass recorded no gaps in `routed`. This can avoid an extra history read after the current
 *   ledger window has been checked. A memory written before W1-T14005, or absent, is not complete.
 * - `pending`: written BEFORE a pass writes its first event and cleared by its last memory write. When present, a pass
 *   may have routed rows its memory does not name (its last write failed). `since` is that pass's clock (its events
 *   are stamped at it, so the routing history is read from there, not from a row's own later `ts`); `through` is the
 *   latest instant among the rows it read, so a row stamped after it was not read by that pass.
 * - `routings`: for a key routed keyed, its event's instant, fingerprint, name and message: the lane's evidence of that
 *   intervention once the event has rotated out of the live file ({@link keyedRoutingEvidence}).
 */
interface InterventionMemory {
  routed: Map<string, number>;
  routings: Map<string, InterventionRouting>;
  complete: boolean;
  pending?: { sinceMs: number; throughMs: number };
}

interface InterventionRouting { atMs: number; fingerprint: string; name: string; message: string }

function writeInterventionMemory(path: string, memory: InterventionMemory): void {
  writeAtomic(path, JSON.stringify({
    routed: [...memory.routed].map(([key, seenMs]) => {
      const routing = memory.routings.get(key);
      return { key, seen: fixedClock(seenMs).iso(),
        ...(routing ? { routing: { at: fixedClock(routing.atMs).iso(), fingerprint: routing.fingerprint, name: routing.name, message: routing.message } } : {}) };
    }),
    complete: memory.complete,
    ...(memory.pending ? { pending: { since: fixedClock(memory.pending.sinceMs).iso(), through: fixedClock(memory.pending.throughMs).iso() } } : {}),
  }) + "\n");
}

/** W1-T14005: the intervention incident.event rows written since `sinceMs`, rotated ones included. */
export type InterventionRoutingHistory = (sinceMs: number) => Promise<readonly IncidentLedgerEvent[]>;

/** W1-T14005: extra routing history keeps one event per key. The main window supplies keyless proof from rotations.
 *  Associative: reduce(a ++ b) = reduce(reduce(a) ++ b). */
function latestRoutingRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row.step !== "incident.event" || row.kind !== INTERVENTION_INCIDENT_KIND || typeof row.ts !== "string") continue;
    if (typeof row.intervention_key !== "string") continue;
    const { ts, step, task_id, kind, name, fingerprint, message, intervention_key } = row;
    latest.set(intervention_key, { ts, step, task_id, kind, name, fingerprint, message, intervention_key });
  }
  return [...latest.values()];
}

const routingHistoryReaders = new Map<string, ReturnType<typeof createLedgerRotationMemo>>();

/**
 * W1-T14005: the default {@link InterventionRoutingHistory}: the ledger union of `stateDir`, so a routing rotated out of
 * the live file still counts. Rotations are loaded off the loop and kept reduced ({@link latestRoutingRows}); the live
 * file is read from its tail ({@link readLiveLedgerRows}), never whole. An unreadable union throws: what was routed is
 * then unknown, and {@link routeOperatorInterventions} defers the rows it would have proved.
 */
async function readInterventionRoutingHistory(stateDir: string, sinceMs: number): Promise<IncidentLedgerEvent[]> {
  let memo = routingHistoryReaders.get(stateDir);
  if (!memo) {
    memo = createLedgerRotationMemo(latestRoutingRows, { pattern: /"kind"\s*:\s*"intervention"/ });
    routingHistoryReaders.set(stateDir, memo);
  }
  const live = join(stateDir, LEDGER_FILENAME);
  const result = await readLedgerUnionRecordsMemoized(stateDir, memo, {
    since: fixedClock(sinceMs).iso(), step: ["incident.event"], refuseIncomplete: true,
    readLiveRecords: () => readLiveLedgerRows(live) as Iterable<Record<string, unknown>>,
  });
  if (!result.ok) throw new Error(`Operator-intervention routing history unreadable: ${result.unread.join(", ")}`);
  return result.rows.flatMap((row) => {
    const event = row.kind === INTERVENTION_INCIDENT_KIND ? incidentEventFromLedgerRow(row, stateDir) : undefined;
    return event ? [event] : [];
  });
}

/** W1-T14005 round 5: the keyed routings the routing memory of `stateDir` holds, as incident events. */
function keyedRoutingEvidence(stateDir: string, log: SreLaneInput["log"]): IncidentLedgerEvent[] {
  let memory: InterventionMemory;
  try {
    memory = readInterventionMemory(interventionMemoryPath(stateDir));
  } catch (error) {
    log("sre_lane.routing_memory_unread", { error: String((error as Error)?.message ?? error) });
    return [];
  }
  // W1-T13131: the memory holds only this lane's own routings, so each names that producer's source.
  return [...memory.routings].map(([interventionKey, r]) => ({
    fingerprint: r.fingerprint, ts: r.atMs, kind: INTERVENTION_INCIDENT_KIND, name: r.name, message: r.message, instance: stateDir, interventionKey,
    source: "sre-lane",
  }));
}

/**
 * W1-T14005: the routed keys a pass keeps — each one whose carrying row can still be read, by the union's own `since`
 * rule (a row stamped before `sinceMs` is not read). The bound is the read window itself: a key outlives no row that
 * could route it again, and nothing older stays. The fix-lane gardener records a PR-surface intervention after the hand
 * action, so a row read by its `ts` can carry an `at` already outside the window; pruned by `at` alone, its key was
 * dropped on every pass and routed again on every pass. MEASURED on the core ledger, 2026-11-19 12:17Z to 11-20 14:25Z:
 * 130,837 intervention incident.event rows over 1,149 passes for 142 distinct messages, each routed on every pass.
 */
function interventionMemoryKeep(memory: ReadonlyMap<string, number>, sinceMs: number): Map<string, number> {
  return new Map([...memory].filter(([, seenMs]) => seenMs >= sinceMs));
}

/**
 * Derive the control-surface interventions from the ledger, write each new one as an `operator.intervention` row,
 * and route every intervention (control and the PR-surface rows the fix-lane gardener wrote) as ONE
 * `incident.event` of kind `intervention` named by its cause class. The window's incident messages identify
 * prior routings by surface, action, target, actor and cause, including events written without a key.
 */
export async function routeOperatorInterventions(
  input: FleetFlowInput & { readRoutingHistory?: InterventionRoutingHistory; log?: SreLaneInput["log"] },
): Promise<LedgerLine[]> {
  const sinceMs = input.nowMs - INTERVENTION_WINDOW_MS;
  let rows: readonly Record<string, unknown>[];
  if (input.readRows) rows = await input.readRows(sinceMs, input.nowMs, { reader: "Operator-intervention", inputs: INTERVENTION_INPUTS });
  else {
    const key = JSON.stringify([input.stateDir, INTERVENTION_INPUTS]);
    let memo = interventionReaders.get(key);
    if (!memo) {
      memo = createLedgerRotationMemo((records) => records.filter((r) => typeof r.step === "string" && INTERVENTION_INPUTS.includes(r.step)),
        { pattern: interventionReadPattern(INTERVENTION_INPUTS) });
      interventionReaders.set(key, memo);
    }
    const result = await readLedgerUnionRecordsMemoized(input.stateDir, memo, {
      since: fixedClock(sinceMs).iso(), rotationWindowMs: INTERVENTION_WINDOW_MS, step: [...INTERVENTION_INPUTS], refuseIncomplete: true,
    });
    if (!result.ok) throw new Error(`Operator-intervention ledger unreadable: ${result.unread.join(", ")}`);
    rows = result.rows;
  }
  const write = (line: LedgerLine) => {
    if (input.writeEvent) input.writeEvent(line);
    else appendLedger(join(input.stateDir, LEDGER_FILENAME), line, { clock: fixedClock(input.nowMs) });
  };
  const all = new Map<string, OperatorInterventionRow>();
  const recorded = new Map<string, Set<string>>();
  const carried = new Map<string, number>();
  const firstRead = new Map<string, number>();
  const shown = new Map<string, IncidentLedgerEvent>();
  const shownKeys = new Map<string, { identity: string; event: IncidentLedgerEvent }>();
  const path = interventionMemoryPath(input.stateDir);
  let memory: InterventionMemory;
  try {
    memory = readInterventionMemory(path);
  } catch (error) {
    input.log?.("sre_lane.routing_memory_unread", { error: String(error) });
    memory = emptyInterventionMemory();
  }
  const { routed, routings, pending } = memory;
  const usedKeys = new Set(routed.keys());
  const cached = new Map<string, string>();
  for (const [key, routing] of routings) {
    const identity = routingMessageIdentity(routing.message);
    if (identity !== undefined) cached.set(identity, key);
  }
  const show = (event: IncidentLedgerEvent) => {
    if (event.kind !== INTERVENTION_INCIDENT_KIND || (event.interventionKey === undefined && event.ts < sinceMs)) return;
    if (event.interventionKey !== undefined) usedKeys.add(event.interventionKey);
    const identity = routingMessageIdentity(event.message);
    if (identity === undefined) return;
    if (event.interventionKey !== undefined) shownKeys.set(event.interventionKey, { identity, event });
    if (shown.get(identity)?.interventionKey === undefined) shown.set(identity, event);
  };
  const collect = (row: OperatorInterventionRow, tsMs: number) => {
    const identity = routingIdentity(row);
    const occurrences = recorded.get(identity) ?? new Set<string>();
    occurrences.add(interventionKey(row));
    recorded.set(identity, occurrences);
    const existing = all.get(identity);
    if (existing === undefined || Date.parse(row.at) < Date.parse(existing.at)) all.set(identity, row);
    carried.set(identity, latestMs(carried.get(identity), tsMs));
    if (tsMs < (firstRead.get(identity) ?? Number.POSITIVE_INFINITY)) firstRead.set(identity, tsMs);
  };
  for (const row of rows) {
    if (row.step === "incident.event" && row.kind === INTERVENTION_INCIDENT_KIND) {
      const event = incidentEventFromLedgerRow(row, input.stateDir);
      if (event !== undefined) show(event);
      continue;
    }
    const read = interventionFromLedgerRow(row);
    if (!read || !Number.isFinite(Date.parse(read.at))) continue;
    collect(read, typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN);
  }
  // The current window proves routings even if a stale cache claims completeness. The extra history read can
  // still recover older routings when the cache is incomplete or a prior pass left its pending marker.
  const cachedKey = (identity: string, row: OperatorInterventionRow) => {
    const cachedEvent = cached.get(identity);
    if (cachedEvent !== undefined && (shownKeys.get(cachedEvent)?.identity ?? identity) === identity) return cachedEvent;
    for (const key of recorded.get(identity) ?? [interventionKey(row)]) {
      if (routed.has(key) && !routings.has(key) && (shownKeys.get(key)?.identity ?? identity) === identity) return key;
    }
    return undefined;
  };
  const firstReadOf = (key: string) => firstRead.get(key) ?? input.nowMs;
  const mayBeRouted = (key: string) => (!memory.complete && firstReadOf(key) < input.nowMs) ||
    (pending !== undefined && firstReadOf(key) <= pending.throughMs);
  const unproven = [...all].filter(([key, row]) => cachedKey(key, row) === undefined && !shown.has(key) && Date.parse(row.at) <= input.nowMs && mayBeRouted(key))
    .map(([key]) => key);
  const readHistory = input.readRoutingHistory ?? ((since: number) => readInterventionRoutingHistory(input.stateDir, since));
  let deferred: ReadonlySet<string> = new Set();
  if (unproven.length) {
    // From the earliest first read, or the failed pass's clock when it is earlier: that pass stamped its events at its
    // clock, which is before the ts of a row the fix-lane gardener appended after that clock was taken.
    const historySinceMs = Math.min(...unproven.map(firstReadOf), pending?.sinceMs ?? Number.POSITIVE_INFINITY);
    try {
      for (const event of await readHistory(historySinceMs)) show(event);
    } catch (error) {
      deferred = new Set(unproven);
      input.log?.("sre_lane.routing_deferred", { deferred: deferred.size, error: String((error as Error)?.message ?? error) });
    }
  }
  const controlRows = rows.filter((r) => r.step !== OPERATOR_INTERVENTION_STEP && r.step !== "incident.event");
  for (const derived of deriveControlInterventions(controlRows)) {
    const identity = routingIdentity(derived);
    if (recorded.get(identity)?.has(interventionKey(derived)) || shown.has(identity) || cachedKey(identity, derived) !== undefined) continue;
    write(interventionLedgerLine(derived));
    collect(derived, input.nowMs);
  }
  const toRoute: Array<[string, OperatorInterventionRow]> = [];
  const remember = (key: string, identity: string, atMs: number) => {
    routed.set(key, latestMs(routed.get(key), carried.get(identity), atMs));
  };
  const rememberProof = (identity: string, event: IncidentLedgerEvent) => {
    const key = event.interventionKey;
    if (key !== undefined && event.message !== undefined && routingMessageIdentity(routings.get(key)?.message) !== identity) {
      routings.set(key, { atMs: event.ts, fingerprint: event.fingerprint, name: event.name, message: event.message });
    }
  };
  for (const [key, { identity, event }] of shownKeys) {
    const atMs = keyAtMs(key);
    if (!recorded.get(identity)?.has(key) || atMs > input.nowMs) continue;
    remember(key, identity, atMs);
    rememberProof(identity, event);
  }
  for (const [identity, row] of [...all].sort(([, a], [, b]) => Date.parse(a.at) - Date.parse(b.at))) {
    if (deferred.has(identity) || Date.parse(row.at) > input.nowMs) continue;
    const proof = shown.get(identity);
    const key = proof?.interventionKey ?? cachedKey(identity, row);
    if (key !== undefined) {
      remember(key, identity, Date.parse(row.at));
      if (proof !== undefined) rememberProof(identity, proof);
    } else if (proof === undefined) toRoute.push([identity, row]);
  }
  const settled = (): Map<string, number> => {
    const keep = interventionMemoryKeep(routed, sinceMs);
    for (const key of routings.keys()) if (!keep.has(key)) routings.delete(key);
    return keep;
  };
  if (toRoute.length) {
    // W1-T14005 round 5: the marker is written before the first event, so a pass whose last memory write fails leaves
    // the rows it may have routed named for the next pass to prove. Unwritable, the pass throws before any event.
    const throughMs = latestMs(input.nowMs, ...carried.values(), pending?.throughMs);
    const sinceMarkMs = Math.min(input.nowMs, pending?.sinceMs ?? Number.POSITIVE_INFINITY);
    writeInterventionMemory(path, { routed: settled(), routings: memory.routings, complete: memory.complete, pending: { sinceMs: sinceMarkMs, throughMs } });
  }
  const events: LedgerLine[] = [];
  for (const [identity, row] of toRoute) {
    const originalKey = interventionKey(row);
    // Preserve existing event keys and separate distinct actors or causes that share an occurrence key.
    const key = usedKeys.has(originalKey) ? routingOccurrenceKey(originalKey, identity) : originalKey;
    usedKeys.add(key);
    const event: LedgerLine = { ...interventionIncidentEvent(row, input.nowMs), intervention_key: key };
    write(event);
    events.push(event);
    remember(key, identity, Date.parse(row.at));
    routings.set(key, { atMs: input.nowMs, fingerprint: String(event.fingerprint), name: String(event.name), message: String(event.message) });
  }
  // Every row this pass read is now routed, proven routed, or not yet due, unless some were deferred: then the memory
  // stays as complete as it was, and an earlier failed pass's marker stays until a readable pass proves its rows.
  const keptPending = deferred.size && pending && pending.throughMs >= sinceMs ? { pending } : {};
  writeInterventionMemory(path, { routed: settled(), routings: memory.routings, complete: memory.complete || deferred.size === 0, ...keptPending });
  return events;
}
