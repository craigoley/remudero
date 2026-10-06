// W1-T5939 — A GITHUB ACTIONS INCIDENT PAUSES THE LANES THAT SPEND CI. During the 2026-10-05
// outage (githubstatus: Actions degraded, then major_outage) jobs that never got a runner were
// cancelled, and the sweep read each cancellation as a red to act on: job requeues refused with
// 403, paid fix workers that returned FLAKE, strikes and escalations spent on infrastructure.
// This module is the reader: a cached poll of githubstatus.com's summary and the PURE classifier
// the sweep calls on it. UNREADABLE IS ITS OWN STATE — a failed read is never "operational".

export const ACTIONS_STATUS_URL = "https://www.githubstatus.com/api/v2/summary.json";
/** At most one githubstatus read per this window, whatever the sweep cadence. */
export const ACTIONS_STATUS_TTL_MS = 3 * 60_000;
/** BACKSTOP: a hold older than this escalates once and stops holding, so a stuck read cannot freeze the fleet. */
export const ACTIONS_INCIDENT_BACKSTOP_MS = 4 * 60 * 60_000;
export const ACTIONS_INCIDENT_HOLD_STEP = "sweep.actions_incident_hold";
export const ACTIONS_INCIDENT_REQUEUE_STEP = "sweep.actions_incident_requeue";
export const ACTIONS_INCIDENT_BACKSTOP_STEP = "sweep.actions_incident_backstop";

export type ActionsStatusRead =
  | { ok: true; body: unknown; fetchedAtMs: number }
  | { ok: false; error: string; fetchedAtMs: number };

export type ActionsIncidentState = "operational" | "incident" | "unreadable";

export interface ActionsIncidentObservation {
  state: ActionsIncidentState;
  /** The Actions component's own status string, when one was read. */
  componentStatus?: string;
  /** The name of an unresolved incident that names Actions, when one is open. */
  incident?: string;
  reason: string;
}

const COMPONENT_STATUSES = new Set(["operational", "degraded_performance", "partial_outage", "major_outage", "under_maintenance"]);
const CLOSED_INCIDENT = new Set(["resolved", "postmortem", "completed"]);

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const isActions = (name: unknown): boolean => typeof name === "string" && name.trim().toLowerCase() === "actions";

/** PURE: what one githubstatus summary read says about GitHub Actions. Anything not positively
 *  read — a failed fetch, no `components`, no Actions component, a status string this code does
 *  not know — is `unreadable`, never `operational`. */
export function classifyActionsIncident(read: ActionsStatusRead): ActionsIncidentObservation {
  if (!read.ok) return { state: "unreadable", reason: `githubstatus summary unreadable: ${read.error}` };
  const body = record(read.body);
  const components = body?.components;
  if (!Array.isArray(components)) return { state: "unreadable", reason: "githubstatus summary carries no components list" };
  const actions = components.map(record).find((c) => isActions(c?.name));
  const componentStatus = typeof actions?.status === "string" ? actions.status : undefined;
  if (componentStatus === undefined) return { state: "unreadable", reason: "githubstatus summary names no Actions component status" };
  if (!COMPONENT_STATUSES.has(componentStatus)) {
    return { state: "unreadable", componentStatus, reason: `githubstatus Actions status "${componentStatus}" is not a known state` };
  }
  const incident = (Array.isArray(body?.incidents) ? body.incidents : []).map(record).find((i) =>
    i !== undefined && !CLOSED_INCIDENT.has(String(i.status ?? "")) &&
    ((Array.isArray(i.components) && i.components.some((c) => isActions(record(c)?.name))) ||
      (typeof i.name === "string" && /\bactions\b/i.test(i.name))));
  const incidentName = typeof incident?.name === "string" ? incident.name : incident ? "(unnamed incident)" : undefined;
  if (componentStatus === "operational" && incidentName === undefined) {
    return { state: "operational", componentStatus, reason: "githubstatus reports Actions operational" };
  }
  return {
    state: "incident",
    componentStatus,
    ...(incidentName !== undefined ? { incident: incidentName } : {}),
    reason: `githubstatus reports Actions ${componentStatus}${incidentName !== undefined ? ` (incident: ${incidentName})` : ""}`,
  };
}

/** The default fetch: one GET with a short timeout; any non-2xx is a thrown, named failure. */
export async function fetchActionsStatusJson(url: string = ACTIONS_STATUS_URL): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/** A cached reader: at most one fetch per `ttlMs`, failures cached too so an outage of the status
 *  page itself is not hammered. A thrown fetch becomes an `ok: false` read, never a throw. */
export function createActionsStatusReader(deps: {
  fetchJson?: () => Promise<unknown>;
  nowMs?: () => number;
  ttlMs?: number;
} = {}): () => Promise<ActionsStatusRead> {
  const fetchJson = deps.fetchJson ?? (() => fetchActionsStatusJson());
  const nowMs = deps.nowMs ?? Date.now;
  const ttlMs = deps.ttlMs ?? ACTIONS_STATUS_TTL_MS;
  let cached: ActionsStatusRead | undefined;
  return async () => {
    const at = nowMs();
    if (cached && at - cached.fetchedAtMs < ttlMs) return cached;
    try {
      cached = { ok: true, body: await fetchJson(), fetchedAtMs: at };
    } catch (e) {
      cached = { ok: false, error: String((e as Error)?.message ?? e), fetchedAtMs: at };
    }
    return cached;
  };
}

interface RedEvidence {
  redRequiredChecks?: readonly string[];
  ciFailures?: ReadonlyArray<{ name: string; conclusion?: string; logTail?: string }>;
  cancelledRequiredChecks?: ReadonlyArray<{ name: string }>;
}

const GENUINE_FAILURE = /AssertionError|(?:^|\n)\s*not ok\s+\d+|# fail\s+[1-9]|\berror TS\d{4}\b|diff-coverage: FAIL/i;
const NEVER_STARTED_TAIL = /TIMED OUT waiting for required check\(s\) to complete|SHARD HANG\W+the matrix was cancelled/;
const NEVER_STARTED_CONCLUSION = new Set(["CANCELLED", "STARTUP_FAILURE"]);

/** PURE: the check names when a PR's WHOLE red is cancelled or never-started checks — the only
 *  red an Actions incident may hold. Any genuine failure, or any red check with no cancellation
 *  evidence, returns undefined: that PR is handled exactly as before. */
export function cancelledOnlyRedChecks(pr: RedEvidence): string[] | undefined {
  const names = new Set((pr.cancelledRequiredChecks ?? []).map((c) => c.name));
  for (const f of pr.ciFailures ?? []) {
    if (names.has(f.name)) continue;
    const tail = f.logTail ?? "";
    if (GENUINE_FAILURE.test(tail)) return undefined;
    if (!NEVER_STARTED_CONCLUSION.has((f.conclusion ?? "").toUpperCase()) && !NEVER_STARTED_TAIL.test(tail)) return undefined;
    names.add(f.name);
  }
  if ((pr.redRequiredChecks ?? []).some((n) => !names.has(n))) return undefined;
  return names.size > 0 ? [...names] : undefined;
}

export interface ActionsIncidentHoldState {
  /** An unreleased hold stands at this (PR, head): a hold row with no later requeue row. */
  open: boolean;
  heldSince?: string;
  backstopped: boolean;
}

/** PURE: the ledger's hold history for one (PR, head). A requeue row closes the episode; a
 *  backstop row ends holding at that head for good. */
export function actionsIncidentHoldState(
  lines: ReadonlyArray<Record<string, unknown>>,
  pr: { prNumber: number; headSha: string },
): ActionsIncidentHoldState {
  let open = false;
  let heldSince: string | undefined;
  let backstopped = false;
  for (const l of lines) {
    if (l.pr_number !== pr.prNumber || l.head_sha !== pr.headSha) continue;
    if (l.step === ACTIONS_INCIDENT_HOLD_STEP && !open) {
      open = true;
      heldSince = typeof l.held_since === "string" ? l.held_since : typeof l.ts === "string" ? l.ts : undefined;
    } else if (l.step === ACTIONS_INCIDENT_REQUEUE_STEP) {
      open = false;
      heldSince = undefined;
    } else if (l.step === ACTIONS_INCIDENT_BACKSTOP_STEP) {
      backstopped = true;
    }
  }
  return { open, ...(heldSince !== undefined ? { heldSince } : {}), backstopped };
}

export type ActionsIncidentDecision =
  | { kind: "proceed" }
  | { kind: "hold"; record: boolean }
  | { kind: "keep-hold" }
  | { kind: "requeue" }
  | { kind: "backstop"; heldMs: number };

/** PURE: what the sweep does with one cancelled-only red, given the observation and its hold. */
export function decideActionsIncidentHold(
  obs: ActionsIncidentObservation,
  hold: ActionsIncidentHoldState,
  nowMs: number,
  backstopMs: number = ACTIONS_INCIDENT_BACKSTOP_MS,
): ActionsIncidentDecision {
  if (hold.backstopped) return { kind: "proceed" };
  const since = hold.heldSince !== undefined ? Date.parse(hold.heldSince) : Number.NaN;
  if (hold.open && Number.isFinite(since) && nowMs - since >= backstopMs) return { kind: "backstop", heldMs: nowMs - since };
  if (obs.state === "incident") return { kind: "hold", record: !hold.open };
  if (!hold.open) return { kind: "proceed" };
  return obs.state === "operational" ? { kind: "requeue" } : { kind: "keep-hold" };
}
