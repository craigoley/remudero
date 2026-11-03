import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { fixedClock, systemClock } from "./clock.js";
import { daemonInstanceRegistryPath, instanceForStateRoot } from "./deployer.js";
import { writeAtomic } from "./fs-race-safe.js";
import { listFeedback, readLandedFeedbackEntry, stageFeedbackCapture, type FeedbackEntry, type FeedbackOrigin, type FeedbackStatus } from "./feedback.js";
import { overlayQueuedFeedbackEntries } from "./feedback-landing.js";
import type { FleetLaneDeps } from "./fleet-lane.js";
import { type FleetFlowDetector, type FleetFlowInput } from "./fleet-flow-detectors.js";
import { evaluateForeignPauseDetectors, FOREIGN_PAUSE_DETECTOR_ID, foreignPauseDetector } from "./foreign-pause-detector.js";
import { evaluateIdleCapacityDetectors, idleCapacityDetector } from "./idle-capacity-detector.js";
import { evaluateStrandedTaskDetectors, STRANDED_TASK_DETECTOR_ID, strandedTaskDetector } from "./stranded-task-detector.js";
import { parseInstanceRegistry, type RegistryInstance } from "./instance-registry.js";
import { observeSelectedRegistrySync, selectedRegistryObserverInContext } from "./selected-registry-consumers.js";
import {
  type IncidentEvidence,
  type RunbookPassResult,
} from "./sre-runbooks.js";
import { readLedgerLines } from "./status.js";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { createLedgerRotationMemo, readLedgerUnionRecordsMemoized } from "./ledger-union.js";
import {
  CONTROL_INTERVENTION_STEPS,
  deriveControlInterventions,
  interventionFromLedgerRow,
  interventionIncidentEvent,
  interventionKey,
  interventionLedgerLine,
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
 * entry per pass via {@link stageFeedbackCapture} (W1-T9615) — the existing feedback -> triage -> plan -> build
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
  return { fingerprint, ts, kind, name, message, route, sha, instance };
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

/** Group `events` by fingerprint and reduce each group to its {@link IncidentEvidence}. Pure. */
export function aggregateIncidents(events: readonly IncidentLedgerEvent[]): IncidentEvidence[] {
  const byFingerprint = new Map<string, IncidentLedgerEvent[]>();
  for (const event of events) {
    const list = byFingerprint.get(event.fingerprint);
    if (list) list.push(event);
    else byFingerprint.set(event.fingerprint, [event]);
  }
  const out: IncidentEvidence[] = [];
  for (const [fingerprint, rows] of byFingerprint) {
    const sorted = [...rows].sort((a, b) => a.ts - b.ts);
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
  // Sorted first, then the first not-open one: the same answer as filter-then-sort (the sort is stable),
  // but `isOpen` runs only until a survivor is found, since W1-T9624's landed check costs a git read.
  return [...evidence].sort((a, b) => b.burnPerHour - a.burnPerHour).find((e) => !isOpen(e.fingerprint));
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
 *  {@link listFeedback}, the same store {@link stageFeedbackCapture} writes into. W1-T9615: given `stateRoot`, the
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
  const landed = readLanded(incidentFeedbackId(fingerprint));
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

export type SreLaneStore = Record<string, { ts: string }>;

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
  /** Repo root — where {@link stageFeedbackCapture}/{@link listFeedback} read and write. */
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
  detectors?: readonly FleetFlowDetector[];
  readFlowRows?: FleetFlowInput["readRows"];
  writeFlowEvent?: FleetFlowInput["writeEvent"];
  /** W1-T9624 seam: the entry origin/main holds for a feedback id. Absent, {@link readLandedFeedbackEntry}. */
  readLandedEntry?: (id: string) => FeedbackEntry | null;
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
  const flowInput = { stateDir: deps.stateDir, nowMs: now, readRows: deps.readFlowRows, writeEvent: deps.writeFlowEvent };
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
    ...await routeOperatorInterventions({ ...flowInput, detectors }),
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
  const evidence = aggregateIncidents(events);
  const readLanded = deps.readLandedEntry ?? ((id: string) => readLandedFeedbackEntry(deps.root, id));
  const worst = worstOpenIncident(evidence, (fp) => fingerprintAlreadyOpen(fp, openOrigins, deps.hasOpenTask) || landedIncidentOpen(fp, readLanded));
  if (!worst) return { room };

  const runbook = runMatchingRunbook ? await runMatchingRunbook(worst) : undefined;
  if (room <= 0 || (runbook && !runbook.fileFeedback)) return { room, runbook };

  const frameFiles = deps.framesFor(worst.fingerprint).map((f) => f.file);
  const suspectPrs = suspectPullRequests(await deps.mergedPrsSince(worst.deployShas[0]), frameFiles);
  const staged = stageFeedbackCapture(deps.root, deps.landingStateRoot, {
    raw: incidentFeedbackRaw(worst, suspectPrs),
    origin: incidentFeedbackOrigin(worst.fingerprint),
    id: incidentFeedbackId(worst.fingerprint),
  });
  store[worst.fingerprint] = { ts: fixedClock(now).iso() };
  writeAtomic(sreLaneStorePath(deps.stateDir), JSON.stringify(store) + "\n");
  deps.log("sre_lane.filed", {
    fingerprint: worst.fingerprint,
    count: worst.count,
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
export function daemonSreLaneInput(
  input: Pick<SreLaneInput, "stateDir" | "root" | "mergedLastDay" | "log" | "runbookPass"> & { ledgerPath: string; owner: string; repo: string; landingStateRoot?: string },
): SreLaneInput {
  const instance = resolveSreLaneInstance({
    stateRoot: dirname(input.stateDir),
    registryPath: process.env.RMD_INSTANCE_REGISTRY?.trim() || daemonInstanceRegistryPath(input.root),
  });
  const name = instance.resolved ? instance.name : "unknown";
  return {
    stateDir: input.stateDir,
    root: input.root,
    landingStateRoot: input.landingStateRoot ?? dirname(input.stateDir),
    detectors: SRE_LANE_DETECTORS.map((detector) =>
      detector.id === "idle-capacity" ? idleCapacityDetector(name)
        : detector.id === FOREIGN_PAUSE_DETECTOR_ID ? foreignPauseDetector(name) : detector),
    readEvents: () =>
      readLedgerLines(input.ledgerPath) // ledger-read-intent: live — this lane wants the newest incident rows only.
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
export function resolveSreLaneInstance(input: {
  stateRoot: string;
  registryPath: string;
  readText?: (path: string) => string;
  env?: { RMD_INSTANCE_NAME?: string };
}): SreLaneInstance {
  const result = resolveLegacySreLaneInstance(input);
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
const interventionReaders = new Map<string, ReturnType<typeof createLedgerRotationMemo>>();

function interventionMemoryPath(stateDir: string): string {
  return join(stateDir, "operator-interventions.json");
}

/**
 * Derive the control-surface interventions from the ledger, write each new one as an `operator.intervention` row,
 * and route every intervention (control and the PR-surface rows the fix-lane gardener wrote) as ONE
 * `incident.event` of kind `intervention` named by its cause class. The dedupe memory lives beside the fleet-flow
 * store, keyed by {@link interventionKey}: a re-read of the same window never routes a second event.
 */
export async function routeOperatorInterventions(input: FleetFlowInput): Promise<LedgerLine[]> {
  const sinceMs = input.nowMs - INTERVENTION_WINDOW_MS;
  let rows: readonly Record<string, unknown>[];
  if (input.readRows) rows = await input.readRows(sinceMs, input.nowMs);
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
  for (const row of rows) {
    const read = interventionFromLedgerRow(row);
    if (read) all.set(interventionKey(read), read);
  }
  const path = interventionMemoryPath(input.stateDir);
  const memory = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { routed?: string[] }) : {};
  if (memory.routed !== undefined && !Array.isArray(memory.routed)) throw new Error(`Invalid operator-intervention memory: ${path}`);
  const routed = new Set(memory.routed ?? []);
  // A row already in the ledger, or already routed, is never written a second time (a reader that lags the
  // pass's own writes must not mint it again).
  const recorded = new Set([...all.keys(), ...routed]);
  for (const derived of deriveControlInterventions(rows.filter((r) => r.step !== OPERATOR_INTERVENTION_STEP))) {
    const key = interventionKey(derived);
    if (!recorded.has(key)) write(interventionLedgerLine(derived));
    all.set(key, derived);
  }
  const events: LedgerLine[] = [];
  for (const [key, row] of [...all].sort(([, a], [, b]) => Date.parse(a.at) - Date.parse(b.at))) {
    if (routed.has(key) || !(Date.parse(row.at) <= input.nowMs)) continue;
    const event = interventionIncidentEvent(row, input.nowMs);
    write(event);
    events.push(event);
    routed.add(key);
  }
  // Keep only keys still inside the window: an older intervention is no longer re-read, so it cannot be re-routed.
  const live = [...routed].filter((key) => Date.parse(key.slice(key.lastIndexOf("|") + 1)) > sinceMs);
  writeAtomic(path, JSON.stringify({ routed: live }) + "\n");
  return events;
}
