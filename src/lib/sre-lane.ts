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
  return { fingerprint, ts, kind, name, message, route, sha, instance, ...key };
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
 *  W1-T14005: an event whose intervention key `keyOf` names counts once, at its first routing, so a repeat routing never
 *  moves the count, the span or the burn; an event with no key counts by itself, as before. */
export function aggregateIncidents(
  events: readonly IncidentLedgerEvent[],
  keyOf: (event: IncidentLedgerEvent) => string | undefined = (event) => event.interventionKey,
): IncidentEvidence[] {
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
      const key = keyOf(e);
      if (key === undefined) return true;
      if (counted.has(key)) return false;
      counted.add(key);
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

function incidentFeedbackRaw(evidence: IncidentEvidence, suspectPrs: readonly string[]): string {
  const lines = [
    `Incident ${evidence.fingerprint.slice(0, 12)}: ${evidence.kind} ${evidence.name}`,
    `First seen: ${fixedClock(evidence.firstSeenMs).iso()}`,
    `Last seen: ${fixedClock(evidence.lastSeenMs).iso()}`,
    `Count: ${evidence.count}, burn: ${evidence.burnPerHour.toFixed(2)}/hr`,
    `Deploy sha(s): ${evidence.deployShas.length ? evidence.deployShas.join(", ") : "unknown"}`,
    `Instance(s): ${evidence.instances.join(", ")}`,
    "Sample events:",
    ...(evidence.sampleMessages.length ? evidence.sampleMessages.map((m) => `  - ${m}`) : ["  (no message sampled)"]),
    "Suspect commits (merged pull requests touching the incident's in-app frames):",
    ...(suspectPrs.length ? suspectPrs.map((p) => `  - ${p}`) : ["  (none found)"]),
  ];
  return lines.join("\n");
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
  ];
  // W1-T8264: every hand action is a cause-classed intervention, routed as one incident per class. W1-T14005: the
  // incident rows show what was already routed, and the interventions read name the key of each one written keyless.
  const interventions = await routeInterventions({ ...flowInput, detectors, routedEvents: () => deps.readEvents() });
  flowRows.push(...interventions.events);
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
  const evidence = aggregateIncidents(events, interventions.keyOf);
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
    raw: incidentFeedbackRaw(worst, suspectPrs),
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

/** Every ledger step the control-surface deriver and its cause lookup read. */
const INTERVENTION_INPUTS: readonly string[] = [
  ...CONTROL_INTERVENTION_STEPS, "cli.invoked", "dispatch.circuit_broken", "dispatch.circuit_broken.verified", OPERATOR_INTERVENTION_STEP,
];
const INTERVENTION_WINDOW_MS = 7 * DAY_MS;

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

/**
 * W1-T14005: the routing memory, each routed key with the latest instant a row that carried it was stamped at: the
 * later of that row's ledger `ts` and its intervention's `at`. A memory written before this holds bare keys, which
 * recorded only their `at`. Absent, it is empty; unparseable or malformed, it throws: a structured entry whose `seen` is
 * not a readable instant is malformed, never read as a bare key, since a key read past it would suppress a routing.
 */
function readInterventionMemory(path: string): Map<string, number> {
  const memory = new Map<string, number>();
  if (!existsSync(path)) return memory;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { routed?: unknown };
  if (parsed.routed !== undefined && !Array.isArray(parsed.routed)) throw new Error(`Invalid operator-intervention memory: ${path}`);
  for (const entry of (parsed.routed ?? []) as unknown[]) {
    if (typeof entry === "string") {
      memory.set(entry, latestMs(memory.get(entry), keyAtMs(entry)));
      continue;
    }
    const record = (typeof entry === "object" && entry !== null ? entry : {}) as { key?: unknown; seen?: unknown };
    const seenMs = typeof record.seen === "string" ? Date.parse(record.seen) : Number.NaN;
    if (typeof record.key !== "string" || !Number.isFinite(seenMs)) throw new Error(`Invalid operator-intervention memory: ${path}`);
    memory.set(record.key, latestMs(memory.get(record.key), seenMs, keyAtMs(record.key)));
  }
  return memory;
}

/**
 * W1-T14005: the intervention key each `incident.event` routed. A row this lane writes carries it. One written before
 * that carries none, and its message and fingerprint name every field of the key but `at` and the invocation, so it is
 * matched to the interventions read this pass: the one that would route as it, and whose row and `at` predate it, is
 * its key. With none (its row is no longer read) or several (they differ only in `at` or invocation) it has no key and
 * counts by itself, as before.
 */
function routedInterventionKeys(
  all: ReadonlyMap<string, OperatorInterventionRow>, firstRead: ReadonlyMap<string, number>, nowMs: number,
): (event: IncidentLedgerEvent) => string | undefined {
  let byEvent: Map<string, Array<{ key: string; sinceMs: number }>> | undefined;
  return (event) => {
    if (event.interventionKey !== undefined || event.kind !== INTERVENTION_INCIDENT_KIND) return event.interventionKey;
    if (!byEvent) {
      byEvent = new Map();
      for (const [key, row] of all) {
        const routed = interventionIncidentEvent(row, nowMs);
        const id = `${String(routed.fingerprint)}\u0000${String(routed.message)}`;
        const sinceMs = Math.max(Date.parse(row.at), firstRead.get(key) ?? nowMs);
        byEvent.set(id, [...byEvent.get(id) ?? [], { key, sinceMs }]);
      }
    }
    const named = (byEvent.get(`${event.fingerprint}\u0000${event.message}`) ?? []).filter((c) => c.sinceMs <= event.ts);
    return named.length === 1 ? named[0].key : undefined;
  };
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
 * `incident.event` of kind `intervention` named by its cause class. The dedupe memory lives beside the fleet-flow
 * store, keyed by {@link interventionKey}: a re-read of the same window never routes a second event.
 */
export async function routeOperatorInterventions(input: InterventionRoutingInput): Promise<LedgerLine[]> {
  return (await routeInterventions(input)).events;
}

/** W1-T14005: `routedEvents` reads the incident rows already written; one that routed an intervention is its routing. */
type InterventionRoutingInput = FleetFlowInput & { routedEvents?: () => readonly IncidentLedgerEvent[] };

/** {@link routeOperatorInterventions}, and the key each incident.event routed ({@link routedInterventionKeys}). */
async function routeInterventions(input: InterventionRoutingInput): Promise<{ events: LedgerLine[]; keyOf: (event: IncidentLedgerEvent) => string | undefined }> {
  const sinceMs = input.nowMs - INTERVENTION_WINDOW_MS;
  let rows: readonly Record<string, unknown>[];
  if (input.readRows) rows = await input.readRows(sinceMs, input.nowMs, { reader: "Operator-intervention", inputs: INTERVENTION_INPUTS });
  else {
    const key = JSON.stringify([input.stateDir, INTERVENTION_INPUTS]);
    let memo = interventionReaders.get(key);
    if (!memo) {
      const pattern = new RegExp(`"step"\\s*:\\s*"(?:${INTERVENTION_INPUTS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})"`);
      memo = createLedgerRotationMemo((records) => records.filter((r) => typeof r.step === "string" && INTERVENTION_INPUTS.includes(r.step)), { pattern });
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
  // W1-T14005: the latest ledger `ts` this pass read each key's row at, which is what decides whether it is read again.
  const carried = new Map<string, number>();
  // W1-T14005: the earliest, which is when the intervention could first have been routed.
  const firstRead = new Map<string, number>();
  for (const row of rows) {
    const read = interventionFromLedgerRow(row);
    if (!read) continue;
    const key = interventionKey(read);
    all.set(key, read);
    const tsMs = typeof row.ts === "string" ? Date.parse(row.ts) : undefined;
    carried.set(key, latestMs(carried.get(key), tsMs));
    if (typeof tsMs === "number" && tsMs < (firstRead.get(key) ?? Number.POSITIVE_INFINITY)) firstRead.set(key, tsMs);
  }
  const path = interventionMemoryPath(input.stateDir);
  const memory = readInterventionMemory(path);
  // A row already in the ledger, or already routed, is never written a second time (a reader that lags the
  // pass's own writes must not mint it again).
  const recorded = new Set([...all.keys(), ...memory.keys()]);
  for (const derived of deriveControlInterventions(rows.filter((r) => r.step !== OPERATOR_INTERVENTION_STEP))) {
    const key = interventionKey(derived);
    if (!recorded.has(key)) {
      write(interventionLedgerLine(derived));
      carried.set(key, latestMs(carried.get(key), input.nowMs));
      firstRead.set(key, input.nowMs);
    }
    all.set(key, derived);
  }
  const keyOf = routedInterventionKeys(all, firstRead, input.nowMs);
  // W1-T14005: an incident.event already written for a key is its routing, though the memory lost the key. origin/main
  // pruned a late row's key by its `at` while the row was still read, and routed it again every pass.
  let routedBefore: Set<string> | undefined;
  const alreadyRouted = (key: string) =>
    (routedBefore ??= new Set((input.routedEvents?.() ?? []).flatMap((event) => keyOf(event) ?? []))).has(key);
  const events: LedgerLine[] = [];
  for (const [key, row] of [...all].sort(([, a], [, b]) => Date.parse(a.at) - Date.parse(b.at))) {
    if (memory.has(key) || !(Date.parse(row.at) <= input.nowMs)) continue;
    if (alreadyRouted(key)) {
      memory.set(key, Number.NaN);
      continue;
    }
    // The key rides on the event, so the lane's evidence counts this intervention once however often it is routed.
    const event: LedgerLine = { ...interventionIncidentEvent(row, input.nowMs), intervention_key: key };
    write(event);
    events.push(event);
    memory.set(key, Number.NaN);
  }
  for (const [key, seenMs] of memory) memory.set(key, latestMs(seenMs, carried.get(key), keyAtMs(key)));
  const keep = interventionMemoryKeep(memory, sinceMs);
  writeAtomic(path, JSON.stringify({ routed: [...keep].map(([key, seenMs]) => ({ key, seen: fixedClock(seenMs).iso() })) }) + "\n");
  return { events, keyOf };
}
