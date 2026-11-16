import { createHash } from "node:crypto";
import { readActorEvidence } from "./actor-evidence.js";
import { ledgerRowActor, type LedgerLine } from "./ledger.js";

/**
 * W1-T8264: every hand action on the fleet is a cause-classed intervention.
 *
 * MEASURED 2026-10-11 (core ledger union): 5 `fleet.pause` + 5 `fleet.resume`, a `dispatch.breaker_released`, and
 * `cli.invoked release`/`review` rows written by a non-fleet actor, and on GitHub hand update-branches, a hand merge
 * and a hand push. None wrote a row saying an intervention happened or what it answered, and the fix-lane
 * gardener's class for a push was the causeless `operator-intervention:push`.
 *
 * Operator ruling: every hand action is a defect in rmd, so every intervention is evidence with no bound. One row
 * shape, `operator.intervention`, names the surface, the action and the CAUSE: the fleet state the action answered,
 * read from the ledger at or before it. The cause, never the action, is the class a remedy is filed against.
 */

export const OPERATOR_INTERVENTION_STEP = "operator.intervention";
export const INTERVENTION_INCIDENT_KIND = "intervention";

/** Fleet-control ledger steps whose non-fleet writer is, by definition, a hand action. */
export const CONTROL_INTERVENTION_STEPS: ReadonlySet<string> = new Set([
  "fleet.pause",
  "recycle.invoked",
  "fleet.resume",
  "dispatch.breaker_released",
  "automerge.hold_engaged",
  "automerge.hold_released",
]);

/**
 * `cli.invoked` verbs that change fleet state. `pause` and `resume` are absent on purpose: the same invocation
 * writes `fleet.pause`/`fleet.resume`, and counting both would double one action.
 */
export const CONTROL_INTERVENTION_VERBS: ReadonlySet<string> = new Set([
  "release", "review", "stop", "unstop", "retire", "requeue", "merge", "approve", "ratify",
]);

/** Actors that are fleet automation. Every other actor (operator_*, unknown, historical `operator`) is a hand. */
const FLEET_AUTOMATION_ACTORS: ReadonlySet<string> = new Set(["daemon", "service", "worker", "test", "host_automation", "run_child"]);

export type InterventionSurface = "control" | "pr";

/** W1-T12836: a session PR that finished a task the fleet's own run ended without. */
export const HAND_BUILD_ACTION = "hand-build";
/** BACKSTOP on one ledger row's size: how many changed paths an intervention row keeps; `files_total` says how many there were. */
export const MAX_EVIDENCE_FILES = 20;

/**
 * W1-T12836: what the hand changed. `files` is ordered most-changed first (insertions plus deletions, then path), so
 * `files[0]` is the file the incident fingerprint keys on. `files_unread` names why a file list is absent when a
 * read was attempted and failed — an absent list with no reason was never read.
 */
export interface InterventionEvidence {
  commit?: string;
  prior_head?: string;
  task?: string;
  files?: string[];
  files_total?: number;
  files_unread?: string;
  insertions?: number;
  deletions?: number;
}

export interface OperatorInterventionRow {
  at: string;
  surface: InterventionSurface;
  action: string;
  target: string;
  actor: string;
  actor_evidence?: unknown;
  invocation_id?: string;
  cause_class: string;
  source: string;
  evidence?: InterventionEvidence;
}

/** A changed-file list as evidence: most-changed first, bounded to {@link MAX_EVIDENCE_FILES}, with the totals. */
export function fileEvidence(files: readonly { path: string; additions?: number; deletions?: number }[]): InterventionEvidence {
  const churn = (f: { additions?: number; deletions?: number }) => (Number(f.additions) || 0) + (Number(f.deletions) || 0);
  const ranked = [...files].sort((a, b) => churn(b) - churn(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files: ranked.slice(0, MAX_EVIDENCE_FILES).map((f) => f.path),
    files_total: files.length,
    insertions: files.reduce((n, f) => n + (Number(f.additions) || 0), 0),
    deletions: files.reduce((n, f) => n + (Number(f.deletions) || 0), 0),
  };
}

/** The file a PR-surface intervention's incident keys on: its most-changed file, when the row recorded one. */
export function mostChangedFile(row: Pick<OperatorInterventionRow, "surface" | "evidence">): string | undefined {
  return row.surface === "pr" ? row.evidence?.files?.[0] : undefined;
}

function readEvidence(value: unknown): InterventionEvidence | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const out: InterventionEvidence = {};
  for (const key of ["commit", "prior_head", "task", "files_unread"] as const) if (typeof v[key] === "string") out[key] = v[key] as string;
  for (const key of ["files_total", "insertions", "deletions"] as const) if (typeof v[key] === "number" && Number.isFinite(v[key])) out[key] = v[key] as number;
  if (Array.isArray(v.files) && v.files.every((f) => typeof f === "string")) out.files = (v.files as string[]).slice(0, MAX_EVIDENCE_FILES);
  return out;
}

export function isFleetAutomationActor(actor: string): boolean {
  return FLEET_AUTOMATION_ACTORS.has(actor);
}

/** A free-text reason as a stable class token: numbers, shas and durations normalised away. */
export function normalizeClassToken(text: unknown, max = 40): string {
  if (typeof text !== "string") return "";
  return text.toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b[0-9a-f]{7,40}\b/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|m|min|mins|h|hr|hrs|d|days?)\b/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^a-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

const tsMs = (row: Record<string, unknown>): number => (typeof row.ts === "string" ? Date.parse(row.ts) : NaN);

/**
 * A PR's cause class: its newest `sweep.disposed` row at or before `atMs` — blocker, owner and reason signature.
 * `none` stands in for a missing owner; an empty reason signature is left off. A PR the sweep had not yet disposed
 * is `undisposed:none`, which names the absence of a recorded cause instead of falling back to the action.
 */
export function prCauseClass(rows: readonly Record<string, unknown>[], pr: number, atMs: number): string {
  let best: Record<string, unknown> | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.step !== "sweep.disposed" || Number(row.pr_number) !== pr) continue;
    const ms = tsMs(row);
    if (!Number.isFinite(ms) || ms > atMs || ms < bestMs) continue;
    best = row;
    bestMs = ms;
  }
  if (!best) return "undisposed:none";
  const blocker = normalizeClassToken(best.blocker) || "none";
  const owner = normalizeClassToken(best.blocker_owner) || "none";
  const reason = normalizeClassToken(best.reason);
  return reason ? `${blocker}:${owner}:${reason}` : `${blocker}:${owner}`;
}

function latestBefore(rows: readonly Record<string, unknown>[], atMs: number, match: (row: Record<string, unknown>) => boolean) {
  let best: Record<string, unknown> | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const ms = tsMs(row);
    if (!Number.isFinite(ms) || ms > atMs || ms < bestMs || !match(row)) continue;
    best = row;
    bestMs = ms;
  }
  return best;
}

const scopeOf = (row: Record<string, unknown>): string =>
  row.scope === "fleet" ? "fleet" : typeof row.instance === "string" ? row.instance : "instance";

/** The cause a control row answered, read from the ledger at or before the row. */
function controlCauseClass(row: Record<string, unknown>, atMs: number, all: readonly Record<string, unknown>[]): string {
  switch (row.step) {
    case "fleet.resume": {
      const pause = latestBefore(all, atMs, (r) => r.step === "fleet.pause" && scopeOf(r) === scopeOf(row) && tsMs(r) < atMs);
      if (!pause) return "hold-ended:unrecorded-hold";
      const kind = isFleetAutomationActor(ledgerRowActor(pause)) ? "automation-pause" : "foreign-pause";
      return `${kind}:${normalizeClassToken(pause.reason) || "no-reason"}`;
    }
    case "recycle.invoked":
      return `hand-recycle:${readActorEvidence(row.actor_evidence)?.caller_class ?? "actor unrecorded"}`;
    case "fleet.pause":
      return `hand-pause:${normalizeClassToken(row.reason) || "no-reason"}`;
    case "dispatch.breaker_released": {
      const task = row.task_id ?? row.task;
      const verified = latestBefore(all, atMs, (r) => r.step === "dispatch.circuit_broken.verified" && (r.task_id ?? r.task) === task);
      if (verified) return `breaker:${normalizeClassToken(verified.disposition) || "unclassified"}`;
      const tripped = latestBefore(all, atMs, (r) => r.step === "dispatch.circuit_broken" && (r.task_id ?? r.task) === task);
      return tripped ? "breaker:unverified" : "breaker:not-tripped";
    }
    case "automerge.hold_engaged":
    case "automerge.hold_released":
      return `automerge-hold:${normalizeClassToken(row.reason) || "no-reason"}`;
    default: {
      // cli.invoked: the invocation records no target, so the cause is the verb's own unclassified class.
      const verb = normalizeClassToken(row.verb) || "unknown";
      return `cli-${verb}:no-recorded-cause`;
    }
  }
}

function controlTarget(row: Record<string, unknown>): string {
  if (row.step === "dispatch.breaker_released") return String(row.task_id ?? row.task ?? "unknown");
  if (row.step === "cli.invoked") return `cli:${String(row.verb ?? "unknown")}`;
  if (typeof row.pr_number === "number") return `pr#${row.pr_number}`;
  return scopeOf(row);
}

/**
 * The control-surface deriver. Takes ledger rows the fleet already writes, and returns one
 * {@link OperatorInterventionRow} per fleet-control row whose actor is not fleet automation. W1-T7839's actor
 * evidence rides along when the row carries it. A pure function of its input: the same rows give the same answer,
 * so a re-read of the same window never mints a second intervention.
 */
export function deriveControlInterventions(rows: readonly Record<string, unknown>[]): OperatorInterventionRow[] {
  const seen = new Set<string>();
  const out: OperatorInterventionRow[] = [];
  const timeline = [...rows].filter((r) => Number.isFinite(tsMs(r))).sort((a, b) => tsMs(a) - tsMs(b));
  for (const row of timeline) {
    const step = String(row.step);
    const recycle = step === "recycle.invoked";
    const automatedRecycle = recycle && typeof row.caller === "string" &&
      (row.caller === "deploy-tick" || /^(?:watchdog|sre-runbook):.+$/.test(row.caller));
    if (automatedRecycle) continue;
    const control = recycle || CONTROL_INTERVENTION_STEPS.has(step) ||
      (step === "cli.invoked" && typeof row.verb === "string" && CONTROL_INTERVENTION_VERBS.has(row.verb));
    if (!control) continue;
    const actor = ledgerRowActor(row);
    if (!recycle && isFleetAutomationActor(actor)) continue;
    const invocation = recycle ? JSON.stringify([row.run_id ?? "", row.pid ?? "", row.writer_start ?? ""]) : undefined;
    const key = `${step}\u0000${String(row.ts)}\u0000${controlTarget(row)}\u0000${String(row.run_id ?? "")}\u0000${invocation ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      at: String(row.ts),
      surface: "control",
      action: step === "cli.invoked" ? `cli.${String(row.verb)}` : step,
      target: controlTarget(row),
      actor,
      ...(row.actor_evidence !== undefined ? { actor_evidence: row.actor_evidence } : {}),
      ...(invocation !== undefined ? { invocation_id: invocation } : {}),
      cause_class: controlCauseClass(row, tsMs(row), timeline),
      source: "ledger",
    });
  }
  return out;
}

/** The fields of an `operator.intervention` row, as a gardener's `log(step, fields)` takes them. */
export function interventionLedgerFields(row: OperatorInterventionRow): Record<string, unknown> {
  return {
    at: row.at,
    surface: row.surface,
    action: row.action,
    target: row.target,
    intervention_actor: row.actor,
    ...(row.actor_evidence !== undefined ? { actor_evidence: row.actor_evidence } : {}),
    ...(row.invocation_id !== undefined ? { invocation_id: row.invocation_id } : {}),
    cause_class: row.cause_class,
    source: row.source,
    ...(row.evidence !== undefined ? { evidence: row.evidence } : {}),
  };
}

/** The `operator.intervention` ledger line for one intervention. */
export function interventionLedgerLine(row: OperatorInterventionRow): LedgerLine {
  return {
    run_id: `INTERVENTION-${Date.parse(row.at)}`,
    task_id: "INCIDENT",
    step: OPERATOR_INTERVENTION_STEP,
    ...interventionLedgerFields(row),
  };
}

/** Invocation identity separates recycles sharing an instant; the final timestamp also bounds routing memory. */
export function interventionKey(row: Pick<OperatorInterventionRow, "surface" | "action" | "target" | "at" | "invocation_id">): string {
  const invocation = row.invocation_id !== undefined ? `|${encodeURIComponent(row.invocation_id)}` : "";
  return `${row.surface}|${row.action}|${row.target}${invocation}|${row.at}`;
}

/** An `operator.intervention` ledger row read back as an {@link OperatorInterventionRow}; undefined if malformed. */
export function interventionFromLedgerRow(row: Record<string, unknown>): OperatorInterventionRow | undefined {
  if (row.step !== OPERATOR_INTERVENTION_STEP) return undefined;
  const { at, surface, action, target, intervention_actor: actor, cause_class: cause, source } = row;
  if (typeof at !== "string" || (surface !== "control" && surface !== "pr") || typeof action !== "string" ||
      typeof target !== "string" || typeof actor !== "string" || typeof cause !== "string" || typeof source !== "string") {
    return undefined;
  }
  if (row.invocation_id !== undefined && typeof row.invocation_id !== "string") return undefined;
  const evidence = readEvidence(row.evidence);
  return { at, surface, action, target, actor, cause_class: cause, source,
    ...(row.invocation_id !== undefined ? { invocation_id: row.invocation_id } : {}),
    ...(row.actor_evidence !== undefined ? { actor_evidence: row.actor_evidence } : {}),
    ...(evidence !== undefined ? { evidence } : {}) };
}

/**
 * The routing identity of an intervention class: kind plus name, so one class is one incident however often it recurs.
 * W1-T12836: a PR-surface row that recorded its most-changed file keys on that file too — measured 2026-11-15, one
 * cause class held 64 pushes on unrelated files as a single incident. A row with no file keeps the class-only key.
 */
export function interventionFingerprint(causeClass: string, file?: string): string {
  const key = file === undefined ? `${INTERVENTION_INCIDENT_KIND}\u0000${causeClass}` : `${INTERVENTION_INCIDENT_KIND}\u0000${causeClass}\u0000${file}`;
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** The `incident.event` that carries an intervention to the SRE lane: kind `intervention`, name = cause class. */
export function interventionIncidentEvent(row: OperatorInterventionRow, nowMs: number): LedgerLine {
  const file = mostChangedFile(row);
  const message = `surface=${row.surface} action=${row.action} target=${row.target} actor=${row.actor} ` +
    `cause=${row.cause_class}${file === undefined ? "" : ` file=${file}`} — a hand action answered a fleet state no lane resolved`;
  return {
    run_id: `INTERVENTION-${nowMs}`,
    task_id: "INCIDENT",
    step: "incident.event",
    source: "sre-lane",
    kind: INTERVENTION_INCIDENT_KIND,
    name: row.cause_class,
    fingerprint: interventionFingerprint(row.cause_class, file),
    subject: file === undefined ? `cause=${row.cause_class}` : `cause=${row.cause_class} file=${file}`,
    message,
  };
}
