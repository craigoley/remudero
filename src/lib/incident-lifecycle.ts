/**
 * lib/incident-lifecycle.ts (W1-T4387) — closes the loop W1-T4385's SRE lane opens by filing an
 * `incident#<fingerprint>`: a small per-fingerprint state machine, `new -> filed -> building (PR
 * n) -> deployed (fix sha running) -> verified | regressed`. A fix PR names its incident with a
 * `Fixes-Incident: <fingerprint>` trailer ({@link linkFixPr}, mirroring `Remudero-Task:`'s own
 * grammar). {@link evaluateDeployedIncident} is the pure decision: a `deployed` record verifies
 * once quiet through the window since deploy, regresses the moment an event fires after deploy —
 * never both, never on a record that is not `deployed`.
 *
 * INVARIANT: verified/regressed each adjust a Beta record for the incident's own `kind`, reusing
 * gardener.ts's alpha/beta shape ({@link readGardenState}) rather than redeclaring it.
 *
 * TRAP this exists to close: `GET /v1/incidents` must report an UNREADABLE store as an error, not
 * the same `200 {incidents: []}` a genuinely quiet fleet returns — the two are indistinguishable
 * to a caller unless the route says which one happened. FALSIFIER: test/incident-lifecycle.test.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fixedClock, systemClock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { gardenStatePath, readGardenState, type GardenState } from "./gardener.js";
import type { IncidentKind, IncidentSource } from "./incident-events.js";
import { sendJson } from "./panel-actions.js";
import type { Route } from "./service.js";
import type { SreLaneInput } from "./sre-lane.js";

// ── the record ───────────────────────────────────────────────────────────────────────────────

export type IncidentStatus = "new" | "filed" | "building" | "deployed" | "verified" | "regressed";

export interface IncidentLifecycleRecord {
  fingerprint: string;
  title: string;
  source: IncidentSource;
  kind: IncidentKind;
  status: IncidentStatus;
  firstSeenMs: number;
  lastSeenMs: number;
  count24h: number;
  feedbackId: string | null;
  pr: number | null;
  /** Set once a fix PR's sha is confirmed running (`markDeployed`) — the verify window's anchor. */
  deploySha?: string;
  deployedAtMs?: number;
}

export type IncidentLifecycleStore = Record<string, IncidentLifecycleRecord>;

/** Never more than the design's own quiet window: a day of no events after deploy. */
export const INCIDENT_VERIFY_WINDOW_MS = 24 * 60 * 60_000;

// ── the fix PR's trailer ─────────────────────────────────────────────────────────────────────

/** Mirrors `Remudero-Task:`'s own anchored, one-per-line trailer grammar (status.ts, board.ts) —
 *  never a second convention for "a PR names something". Named `_PATTERN`, not `_RE`, to match
 *  this same subsystem's own sibling patterns (incident-events.ts's `UUID_PATTERN` et al.). */
const FIXES_INCIDENT_TRAILER_PATTERN = /^Fixes-Incident:\s*(\S+)\s*$/m;

/** The fingerprint a fix PR's body names, if any — `undefined` for a PR that names none. */
export function fixesIncidentFingerprint(prBody: string): string | undefined {
  return FIXES_INCIDENT_TRAILER_PATTERN.exec(prBody)?.[1];
}

/**
 * A fix PR moves its named incident from `filed` (or `new`) to `building`, carrying the PR number
 * forward. A record already `building` or later, or one the trailer does not name, is returned
 * unchanged — this never rewinds a further-along record, and never links the wrong fingerprint.
 */
export function linkFixPr(record: IncidentLifecycleRecord, prNumber: number, prBody: string): IncidentLifecycleRecord {
  if (fixesIncidentFingerprint(prBody) !== record.fingerprint) return record;
  if (record.status !== "new" && record.status !== "filed") return record;
  return { ...record, status: "building", pr: prNumber };
}

/** The fix's sha is confirmed running: `building` -> `deployed`, anchoring the verify window. A
 *  record not `building` is returned unchanged — a deploy cannot be confirmed for work with no PR. */
export function markDeployed(record: IncidentLifecycleRecord, sha: string, atMs: number): IncidentLifecycleRecord {
  if (record.status !== "building") return record;
  return { ...record, status: "deployed", deploySha: sha, deployedAtMs: atMs };
}

// ── verify / regress ─────────────────────────────────────────────────────────────────────────

/**
 * The one decision this module exists for: a `deployed` record verifies once it has stayed quiet
 * through the whole window since deploy, regresses the moment an event is seen AFTER the deploy
 * (even inside the window — a fix that is already firing again gets no benefit of the doubt), and
 * otherwise keeps waiting. A record not `deployed` is returned unchanged: only a deployed fix has
 * anything left to verify. `latestEventMsSinceDeploy` is the caller's own read (ledger union over
 * `incident.event`/`incident.sampled` rows for this fingerprint) so this stays pure and testable
 * without a ledger.
 */
export function evaluateDeployedIncident(
  record: IncidentLifecycleRecord,
  latestEventMsSinceDeploy: number | undefined,
  nowMs: number,
  windowMs: number = INCIDENT_VERIFY_WINDOW_MS,
): IncidentLifecycleRecord {
  if (record.status !== "deployed" || record.deployedAtMs === undefined) return record;
  if (latestEventMsSinceDeploy !== undefined && latestEventMsSinceDeploy > record.deployedAtMs) {
    return { ...record, status: "regressed", lastSeenMs: latestEventMsSinceDeploy };
  }
  if (nowMs - record.deployedAtMs >= windowMs) {
    return { ...record, status: "verified" };
  }
  return record;
}

// ── credit / debit the gardener record ──────────────────────────────────────────────────────

const INCIDENT_LIFECYCLE_GARDEN_NAME = "incident-lifecycle";
const INCIDENT_KINDS: readonly IncidentKind[] = ["exception", "http_5xx", "latency", "invariant"];

export function incidentLifecycleGardenPath(stateDir: string): string {
  return gardenStatePath(stateDir, INCIDENT_LIFECYCLE_GARDEN_NAME);
}

/** Verified credits, regressed debits — the SAME alpha/beta shape gardener.ts already declares
 *  and reads generically, one record per incident `kind`, so a future gardener spec judging
 *  incident classes reads this store with no new code. */
function adjustIncidentClass(stateDir: string, kind: IncidentKind, credit: boolean): GardenState<IncidentKind> {
  const path = incidentLifecycleGardenPath(stateDir);
  const state = readGardenState<IncidentKind>(path, INCIDENT_KINDS);
  const current = state.classes[kind];
  const classes = { ...state.classes, [kind]: credit ? { ...current, alpha: current.alpha + 1 } : { ...current, beta: current.beta + 1 } };
  const next = { ...state, classes };
  writeAtomic(path, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function creditIncidentClass(stateDir: string, kind: IncidentKind): GardenState<IncidentKind> {
  return adjustIncidentClass(stateDir, kind, true);
}

export function debitIncidentClass(stateDir: string, kind: IncidentKind): GardenState<IncidentKind> {
  return adjustIncidentClass(stateDir, kind, false);
}

// ── the store ────────────────────────────────────────────────────────────────────────────────

export function incidentLifecycleStorePath(stateDir: string): string {
  return join(stateDir, "incident-lifecycle.json");
}

/** A store that does not exist yet is genuinely, healthily empty — nothing has ever been filed.
 *  A store that exists but cannot be parsed is a DIFFERENT fact and must never collapse to the
 *  same `ok: true, store: {}` shape: that is exactly the "unreadable read as empty" this task's
 *  route exists to stop happening (see this module's own header). */
export type IncidentLifecycleStoreRead = { ok: true; store: IncidentLifecycleStore } | { ok: false; reason: string };

export function readIncidentLifecycleStore(stateDir: string): IncidentLifecycleStoreRead {
  const path = incidentLifecycleStorePath(stateDir);
  if (!existsSync(path)) return { ok: true, store: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "malformed" };
    }
    return { ok: true, store: parsed as IncidentLifecycleStore };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

export function writeIncidentLifecycleStore(stateDir: string, store: IncidentLifecycleStore): void {
  writeAtomic(incidentLifecycleStorePath(stateDir), JSON.stringify(store, null, 2) + "\n");
}

// ── one pass ─────────────────────────────────────────────────────────────────────────────────

/** `stateDir`, `clock` and `log` are sre-lane.ts's own members — this pass closes the loop that
 *  lane opens — so they are reused from {@link SreLaneInput}, never redeclared as another seam. */
export type IncidentLifecyclePassInput = Pick<SreLaneInput, "stateDir" | "clock" | "log"> & {
  windowMs?: number;
  /** The newest `incident.event`/`incident.sampled` row's ts (ms) for `fingerprint` strictly after
   *  `sinceMs`, read-only — `undefined` when none fired. Mirrors sre-lane.ts's own `readEvents`
   *  seam: the caller owns the ledger union, this module owns only the decision. */
  latestEventMsSince: (fingerprint: string, sinceMs: number) => number | undefined;
};

/**
 * Evaluate every `deployed` record in `store` and apply {@link evaluateDeployedIncident}, crediting
 * or debiting the incident's `kind` exactly once, on the pass that FIRST observes the transition —
 * a record that has already verified or regressed is inert here forever after, so nothing is ever
 * credited or debited twice for the same fingerprint.
 */
export function runIncidentLifecyclePass(store: IncidentLifecycleStore, deps: IncidentLifecyclePassInput): IncidentLifecycleStore {
  const clock = deps.clock ?? systemClock;
  const nowMs = clock.now();
  let next = store;
  for (const record of Object.values(store)) {
    if (record.status !== "deployed" || record.deployedAtMs === undefined) continue;
    const latest = deps.latestEventMsSince(record.fingerprint, record.deployedAtMs);
    const updated = evaluateDeployedIncident(record, latest, nowMs, deps.windowMs);
    if (updated.status === record.status) continue;
    next = { ...next, [record.fingerprint]: updated };
    if (updated.status === "verified") creditIncidentClass(deps.stateDir, record.kind);
    else if (updated.status === "regressed") debitIncidentClass(deps.stateDir, record.kind);
    deps.log(updated.status === "verified" ? "incident_lifecycle.verified" : "incident_lifecycle.regressed", {
      fingerprint: record.fingerprint,
      pr: record.pr,
      kind: record.kind,
    });
  }
  if (next !== store) writeIncidentLifecycleStore(deps.stateDir, next);
  return next;
}

// ── GET /v1/incidents ────────────────────────────────────────────────────────────────────────

interface IncidentWire {
  fingerprint: string;
  title: string;
  source: IncidentSource;
  kind: IncidentKind;
  status: IncidentStatus;
  firstSeen: string;
  lastSeen: string;
  count24h: number;
  feedbackId: string | null;
  pr: number | null;
}

function projectIncidentRecord(record: IncidentLifecycleRecord): IncidentWire {
  return {
    fingerprint: record.fingerprint,
    title: record.title,
    source: record.source,
    kind: record.kind,
    status: record.status,
    firstSeen: fixedClock(record.firstSeenMs).iso(),
    lastSeen: fixedClock(record.lastSeenMs).iso(),
    count24h: record.count24h,
    feedbackId: record.feedbackId,
    pr: record.pr,
  };
}

/** `stateDir`/`clock` are the pass's own (and so sre-lane.ts's) members, reused, not redeclared. */
export type IncidentsRouteInput = Pick<IncidentLifecyclePassInput, "stateDir" | "clock"> & {
  /** Injectable so a test drives the "unreadable" (`ok: false`) path without a real state dir —
   *  the same seam `replay`/`peek`/`selfMeasurement` already use in serve.ts. */
  readStore?: (stateDir: string) => IncidentLifecycleStoreRead;
};

/** `GET /v1/incidents` (read, W1-T4387): the lifecycle store, newest-first. An unreadable store is
 *  a 503 naming why, never a `200 {incidents: []}` a console cannot tell apart from "all clear". */
export function buildIncidentsRoute(deps: IncidentsRouteInput): Route {
  const clock = deps.clock ?? systemClock;
  const readStore = deps.readStore ?? readIncidentLifecycleStore;
  return {
    method: "GET",
    path: "/v1/incidents",
    scope: "read",
    handler: async (_req, res) => {
      const result = readStore(deps.stateDir);
      if (!result.ok) {
        sendJson(res, 503, { error: "incidents_unavailable", reason: result.reason });
        return;
      }
      const incidents = Object.values(result.store)
        .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
        .map(projectIncidentRecord);
      sendJson(res, 200, { incidents, generatedAt: clock.iso() });
    },
  };
}
