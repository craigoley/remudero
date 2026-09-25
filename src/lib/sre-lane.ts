import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fixedClock, systemClock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { captureFeedback, listFeedback, type FeedbackOrigin, type FeedbackStatus } from "./feedback.js";
import type { FleetLaneDeps } from "./fleet-lane.js";
import {
  type IncidentEvidence,
  type RunbookPassResult,
} from "./sre-runbooks.js";
import { readLedgerLines } from "./status.js";

export type { IncidentEvidence } from "./sre-runbooks.js";

/**
 * lib/sre-lane.ts (W1-T4385) — the SRE gardener's phase 3, in its OWN lane, not inside the core
 * daemon: a shared thread starved by fix dispatches cannot see the stall it should catch (operator
 * ruling 2026-09-23). A small own-timer loop (mirrors gardener.ts, fleet-lane.ts) reads incident
 * evidence (W1-T4383 `incident.event`/`incident.sampled`, W1-T4384 invariant findings), dedupes
 * against work the fleet already has open, gathers evidence, and files one `incident#<fingerprint>`
 * entry per pass via {@link captureFeedback} — the existing feedback -> triage -> plan -> build
 * pipeline builds the rest.
 *
 * INVARIANT: filing feedback is this lane's only write surface besides the allowlisted, reversible
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
  return evidence
    .filter((e) => !isOpen(e.fingerprint))
    .sort((a, b) => b.burnPerHour - a.burnPerHour)[0];
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
 *  {@link listFeedback}, the same store {@link captureFeedback} writes into. */
export function openIncidentFeedbackOrigins(root: string): Set<string> {
  const origins = new Set<string>();
  for (const entry of listFeedback(root)) {
    if (typeof entry.origin === "string" && entry.origin.startsWith("incident#") && entry.status !== CLOSED_FEEDBACK_STATUS) {
      origins.add(entry.origin);
    }
  }
  return origins;
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
 *  squash-merge titles always do, so that is a torn/foreign commit, not evidence to guess from. */
export function mergedPrsSince(
  repoDir: string,
  owner: string,
  repo: string,
  sinceSha: string | undefined,
  run: (args: string[]) => string = (args) => execFileSync("git", args, { encoding: "utf8" }),
): MergedPrFiles[] {
  try {
    const logArgs = sinceSha
      ? ["-C", repoDir, "log", `${sinceSha}..origin/main`, "--first-parent", "--format=%H\u0001%s"]
      : ["-C", repoDir, "log", "origin/main", "--first-parent", "--since=24 hours ago", "--format=%H\u0001%s"];
    const lines = run(logArgs).split("\n").filter(Boolean);
    const out: MergedPrFiles[] = [];
    for (const line of lines) {
      const [sha, subject] = line.split("\u0001");
      const match = sha && subject ? /\(#(\d+)\)\s*$/.exec(subject) : null;
      if (!match) continue;
      const files = run(["-C", repoDir, "show", "--name-only", "--format=", sha]).split("\n").filter(Boolean);
      out.push({ url: `https://github.com/${owner}/${repo}/pull/${match[1]}`, files });
    }
    return out;
  } catch {
    // deliberate: an unreadable merge window names no suspects — never a guessed one.
    return [];
  }
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
  /** Repo root — where {@link captureFeedback}/{@link listFeedback} read and write. */
  root: string;
  /** Every incident.event/incident.sampled row this pass should consider, read-only. */
  readEvents: () => IncidentLedgerEvent[];
  /** True when a plan task already exists for this fingerprint (the plan-side dedupe half). */
  hasOpenTask: (fingerprint: string) => boolean;
  /** The in-app frames captured for a fingerprint's recent samples, for suspect-commit matching. */
  framesFor: (fingerprint: string) => IncidentFrameLike[];
  /** Merged PRs (with files) since a deploy sha — `undefined` sha reads the last 24 hours. */
  mergedPrsSince: (sinceSha: string | undefined) => MergedPrFiles[];
  log: (step: string, extra?: Record<string, unknown>) => void;
  /** W1-T4386: the runbook pass is composed at the daemon boundary. Absent, incidents file as before. */
  runbookPass?: (incident: IncidentEvidence) => Promise<RunbookPassResult>;
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
  const store = readSreLaneStore(deps.stateDir);
  const withinDay = (ts: string) => now - Date.parse(ts) < DAY_MS;
  const filedToday = Object.values(store).filter((d) => withinDay(d.ts)).length;
  const room = sreLaneRoom(deps.mergedLastDay(), filedToday);
  if (room <= 0 && !deps.runbookPass) return { room };

  const openOrigins = openIncidentFeedbackOrigins(deps.root);
  const evidence = aggregateIncidents(deps.readEvents());
  const worst = worstOpenIncident(evidence, (fp) => fingerprintAlreadyOpen(fp, openOrigins, deps.hasOpenTask));
  if (!worst) return { room };

  const runbook = deps.runbookPass ? await deps.runbookPass(worst) : undefined;
  if (room <= 0 || (runbook && !runbook.fileFeedback)) return { room, runbook };

  const frameFiles = deps.framesFor(worst.fingerprint).map((f) => f.file);
  const suspectPrs = suspectPullRequests(deps.mergedPrsSince(worst.deployShas[0]), frameFiles);
  captureFeedback(deps.root, {
    raw: incidentFeedbackRaw(worst, suspectPrs),
    origin: incidentFeedbackOrigin(worst.fingerprint),
    id: `incident-${worst.fingerprint.slice(0, 16)}`,
  });
  store[worst.fingerprint] = { ts: fixedClock(now).iso() };
  writeAtomic(sreLaneStorePath(deps.stateDir), JSON.stringify(store) + "\n");
  deps.log("sre_lane.filed", {
    fingerprint: worst.fingerprint,
    count: worst.count,
    burn_per_hour: worst.burnPerHour,
    suspect_prs: suspectPrs.length,
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
 *  `hasOpenTask`/`framesFor` answer nothing yet — the module doc's TRAP. */
export function daemonSreLaneInput(
  input: Pick<SreLaneInput, "stateDir" | "root" | "mergedLastDay" | "log" | "runbookPass"> & { ledgerPath: string; owner: string; repo: string },
): SreLaneInput {
  return {
    stateDir: input.stateDir,
    root: input.root,
    readEvents: () =>
      readLedgerLines(input.ledgerPath) // ledger-read-intent: live — this lane wants the newest incident rows only.
        .filter((row) => row.task_id === "INCIDENT" && (row.step === "incident.event" || row.step === "incident.sampled"))
        .map((row) => incidentEventFromLedgerRow(row, input.repo))
        .filter((event): event is IncidentLedgerEvent => event !== undefined),
    hasOpenTask: () => false,
    framesFor: () => [],
    mergedPrsSince: (sinceSha) => mergedPrsSince(input.root, input.owner, input.repo, sinceSha),
    mergedLastDay: input.mergedLastDay,
    log: input.log,
    runbookPass: input.runbookPass,
  };
}
