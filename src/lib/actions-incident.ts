/**
 * W1-T5939 — GITHUB'S OWN ACTIONS STATUS, read so the sweep can tell an outage from a broken PR.
 *
 * During the 2026-10-05 incident (githubstatus.com: Actions degraded, then major_outage) required
 * jobs that never got a runner were cancelled and ci-gate timed out; the sweep answered each as an
 * ordinary red. This module reads the public summary feed (cached, at most once per
 * {@link ACTIONS_STATUS_CACHE_MS}), classifies it with the pure {@link classifyActionsIncident}, and
 * folds the sweep's hold rows. An unreadable feed is its own state, never "operational".
 */
import { fetchBoundedStatusJson } from "./claude-model-health.js";
import { systemClock, type Clock } from "./clock.js";

export const GITHUB_STATUS_SUMMARY_URL = "https://www.githubstatus.com/api/v2/summary.json";
/** PRIMARY CONTROL: how long one status read (or one failed read) answers every sweep pass. */
export const ACTIONS_STATUS_CACHE_MS = 3 * 60_000;
/** BACKSTOP: the summary feed answers in well under a second; this fires only on a hung read. */
export const ACTIONS_STATUS_TIMEOUT_MS = 5_000;
/** BACKSTOP: the 2026-10-05 incident lasted 2.5 hours; a hold older than this escalates once and
 *  stops holding, so a stuck status read cannot freeze the fleet. */
export const ACTIONS_INCIDENT_HOLD_BACKSTOP_MS = 4 * 60 * 60_000;

export const ACTIONS_INCIDENT_HOLD_STEP = "sweep.actions_incident_hold";
export const ACTIONS_INCIDENT_HOLD_ESCALATED_STEP = "sweep.actions_incident_hold.escalated";

export type ActionsIncidentState = "operational" | "degraded" | "major_outage" | "unreadable";

export interface ActionsIncident {
  state: ActionsIncidentState;
  detail: string;
}

const COMPONENT_STATES: Readonly<Record<string, ActionsIncidentState>> = {
  operational: "operational",
  degraded_performance: "degraded",
  partial_outage: "degraded",
  under_maintenance: "degraded",
  major_outage: "major_outage",
};

const OPEN_INCIDENT_STATES = new Set(["investigating", "identified", "monitoring"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function namesActions(incident: Record<string, unknown>): boolean {
  if (typeof incident.name === "string" && /\bActions\b/.test(incident.name)) return true;
  return Array.isArray(incident.components) && incident.components.some((c) => record(c)?.name === "Actions");
}

/** Pure: the Actions component's status plus any open incident naming Actions. */
export function classifyActionsIncident(summary: unknown): ActionsIncident {
  const body = record(summary);
  if (!body || !Array.isArray(body.components)) return { state: "unreadable", detail: "githubstatus.com summary has no components" };
  const status = body.components.map(record).find((c) => c?.name === "Actions")?.status;
  const componentState = typeof status === "string" ? COMPONENT_STATES[status] : undefined;
  if (!componentState) return { state: "unreadable", detail: `githubstatus.com Actions status unreadable (${String(status)})` };
  const open = (Array.isArray(body.incidents) ? body.incidents : [])
    .map(record)
    .filter((i): i is Record<string, unknown> => i !== undefined && OPEN_INCIDENT_STATES.has(String(i.status)) && namesActions(i))
    .map((i) => `"${String(i.name)}"`);
  const state = componentState === "operational" && open.length > 0 ? "degraded" : componentState;
  return { state, detail: `Actions component ${String(status)}${open.length > 0 ? `; open incident ${open.join(", ")}` : ""}` };
}

/** A failed read, named: the third outcome, never collapsed into "operational". */
export function unreadableActionsIncident(error: unknown): ActionsIncident {
  return { state: "unreadable", detail: `githubstatus.com unreadable: ${String((error as Error)?.message ?? error)}` };
}

export interface ActionsStatusReaderOptions {
  url?: string;
  clock?: Clock;
  cacheMs?: number;
  timeoutMs?: number;
  fetchJson?: (signal: AbortSignal) => Promise<unknown>;
}

/** A cached, single-flight summary reader; a failed read is cached and rethrown for the window. */
export function createActionsStatusReader(opts: ActionsStatusReaderOptions = {}): () => Promise<unknown> {
  const url = opts.url ?? GITHUB_STATUS_SUMMARY_URL;
  const clock = opts.clock ?? systemClock;
  const fetchJson = opts.fetchJson ?? ((signal: AbortSignal) => fetchBoundedStatusJson(url, { signal }));
  let cached: { atMs: number; read: Promise<unknown> } | undefined;
  return () => {
    if (!cached || clock.now() - cached.atMs >= (opts.cacheMs ?? ACTIONS_STATUS_CACHE_MS)) {
      cached = { atMs: clock.now(), read: fetchJson(AbortSignal.timeout(opts.timeoutMs ?? ACTIONS_STATUS_TIMEOUT_MS)) };
    }
    return cached.read;
  };
}

/** The process-wide reader the sweep's effects use. */
export const readGithubActionsStatus = createActionsStatusReader();

export interface ActionsIncidentHoldRecord {
  heldAtMs: number;
  escalated: boolean;
}

/** `holds` per `${pr}@${head}`; `fresh` per `${head}@${check}`: the run attempt a hold saw, voiding an
 *  earlier requeue's bound until a requeue row after the hold spends it. */
export function actionsIncidentHoldsFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  requeueStep: string,
): { holds: Map<string, ActionsIncidentHoldRecord>; fresh: Map<string, number | null> } {
  const holds = new Map<string, ActionsIncidentHoldRecord>();
  const fresh = new Map<string, number | null>();
  for (const l of lines) {
    const key = `${String(l.pr_number)}@${String(l.head_sha)}`;
    if (l.step === ACTIONS_INCIDENT_HOLD_STEP) {
      holds.set(key, { heldAtMs: typeof l.held_at_ms === "number" ? l.held_at_ms : 0, escalated: false });
      for (const c of Array.isArray(l.cancelled_checks) ? l.cancelled_checks.map(record) : []) {
        if (c) fresh.set(`${String(l.head_sha)}@${String(c.name)}`, typeof c.run_attempt === "number" ? c.run_attempt : null);
      }
    } else if (l.step === ACTIONS_INCIDENT_HOLD_ESCALATED_STEP) {
      holds.set(key, { heldAtMs: holds.get(key)?.heldAtMs ?? 0, escalated: true });
    } else if (l.step === requeueStep) {
      fresh.delete(`${String(l.head_sha)}@${String(l.check_name)}`);
    }
  }
  return { holds, fresh };
}

/** Pure: hold an incident-shaped red, escalate it once at the BACKSTOP, or proceed as before. */
export function actionsIncidentHoldDecision(
  incident: ActionsIncident,
  hold: ActionsIncidentHoldRecord | undefined,
  nowMs: number,
): "hold" | "escalate" | "proceed" {
  if (hold?.escalated) return "proceed";
  const active = incident.state === "degraded" || incident.state === "major_outage";
  if (!active && !(hold && incident.state === "unreadable")) return "proceed";
  if (hold && nowMs - hold.heldAtMs >= ACTIONS_INCIDENT_HOLD_BACKSTOP_MS) return "escalate";
  return "hold";
}
