import { fetchBoundedStatusJson, type readClaudeModelHealth } from "./claude-model-health.js";

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
  const incidents = body?.incidents;
  if (incidents === undefined) return { state: "unreadable", componentStatus, reason: "githubstatus summary carries no incidents list" };
  if (!Array.isArray(incidents)) return { state: "unreadable", componentStatus, reason: "githubstatus summary carries a malformed incidents list" };
  const incident = incidents.map(record).find((i) =>
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
  return fetchBoundedStatusJson(url, { signal: AbortSignal.timeout(5_000) });
}

/** A cached reader: at most one fetch per `ttlMs`, failures cached too so an outage of the status
 *  page itself is not hammered. A thrown fetch becomes an `ok: false` read, never a throw. */
export function createActionsStatusReader(
  deps: Pick<NonNullable<Parameters<typeof readClaudeModelHealth>[1]>, "fetchJson" | "now" | "freshMs"> = {},
): () => Promise<ActionsStatusRead> {
  const fetchJson = deps.fetchJson ?? (() => fetchActionsStatusJson());
  const nowMs = deps.now ?? Date.now;
  const ttlMs = deps.freshMs ?? ACTIONS_STATUS_TTL_MS;
  let cached: ActionsStatusRead | undefined;
  let inFlight: Promise<ActionsStatusRead> | undefined;
  return async () => {
    const at = nowMs();
    if (cached && at - cached.fetchedAtMs < ttlMs) return cached;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        cached = { ok: true, body: await fetchJson(AbortSignal.timeout(5_000)), fetchedAtMs: at };
      } catch (error) {
        cached = { ok: false, error: String((error as Error)?.message ?? error), fetchedAtMs: at };
      }
      return cached;
    })();
    try { return await inFlight; }
    finally { inFlight = undefined; }
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
    const tail = f.logTail ?? "";
    if (GENUINE_FAILURE.test(tail)) return undefined;
    if (names.has(f.name)) continue;
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
  requeuedChecks: string[];
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
  const requeuedChecks = new Set<string>();
  for (const l of lines) {
    if (l.pr_number !== pr.prNumber || l.head_sha !== pr.headSha) continue;
    if (l.step === ACTIONS_INCIDENT_HOLD_STEP && !open) {
      open = true;
      requeuedChecks.clear();
      heldSince = typeof l.held_since === "string" ? l.held_since : typeof l.ts === "string" ? l.ts : undefined;
    } else if (l.step === ACTIONS_INCIDENT_REQUEUE_STEP) {
      open = false;
      heldSince = undefined;
    } else if (l.step === ACTIONS_INCIDENT_BACKSTOP_STEP) {
      backstopped = true;
    } else if (open && typeof l.check_name === "string") {
      if (l.step === "sweep.check_requeued" && l.surface === "actions_incident_recovery") requeuedChecks.add(l.check_name);
      else if (l.step === "sweep.check_requeue.deferred" && l.outcome === "deferred") requeuedChecks.delete(l.check_name);
    }
  }
  return { open, ...(heldSince !== undefined ? { heldSince } : {}), backstopped, requeuedChecks: [...requeuedChecks] };
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
  if (obs.state === "operational" && hold.open) return { kind: "requeue" };
  const since = hold.heldSince !== undefined ? Date.parse(hold.heldSince) : Number.NaN;
  if (hold.open && Number.isFinite(since) && nowMs - since >= backstopMs) return { kind: "backstop", heldMs: nowMs - since };
  if (obs.state === "incident") return { kind: "hold", record: !hold.open };
  if (!hold.open) return { kind: "proceed" };
  return { kind: "keep-hold" };
}
