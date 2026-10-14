/**
 * W1-T2858: THE HOST-MEASURED RUNTIME-CONTRACT VERDICT, AS SERVE MAY READ IT.
 *
 * A live daemon can have restart count zero and a current checkout while two of its commissioned
 * bind mounts (the Codex home, the container provider config) are simply absent, which makes the
 * Codex subscription ineligible. The host sees that (deploy/container-runtime-contract.sh); Serve
 * cannot, because it is deliberately given no Docker socket. `scripts/fleet-heartbeat.sh` runs the
 * verifier on every beat and writes one sanitized snapshot to `<root>/state/fleet-runtime-health.json`.
 * This module is the strict, read-only side: ONE local file read, no Docker, no GitHub.
 *
 * THE LAW, in the direction that matters: a snapshot that is missing, unreadable, malformed,
 * from a newer producer, or stale is `unknown` -- NEVER `healthy`. `healthy` and `drift` are both
 * claims about the host, and each is made only by a fresh, well-formed snapshot that says so.
 * The projection carries destinations and reason codes only; nothing in it names a host path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FLEET_RUNTIME_HEALTH_VERSION = 1;
/** The heartbeat's cron cadence (scripts/fleet-heartbeat.sh header: every 5 minutes). */
export const FLEET_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
/** Four missed beats: one beat's jitter plus a slow consumer walk must not read as a dead producer. */
export const FLEET_RUNTIME_HEALTH_STALE_MS = 4 * FLEET_HEARTBEAT_INTERVAL_MS;
/** A snapshot dated further ahead than this is not from a sane clock; it is not trusted either. */
const FUTURE_SKEW_MS = FLEET_HEARTBEAT_INTERVAL_MS;
const MAX_SNAPSHOT_BYTES = 16 * 1024;
const MAX_DRIFT_ENTRIES = 16;

/** The supported lifecycle remedy. NAMED ONLY: nothing in this file or the response can run it. */
export const FLEET_RUNTIME_REMEDY = "deploy/recycle-container.sh";

export type FleetRuntimeState = "healthy" | "drift" | "unknown";
export type FleetRuntimeDriftReason = "missing" | "wrong_source" | "read_only" | "read_write";
export type FleetRuntimeUnknownReason =
  | "no-snapshot"
  | "unreadable"
  | "malformed"
  | "future-version"
  | "stale"
  | "clock-skew"
  | "producer-unknown";

export interface FleetRuntimeDrift {
  destination: string;
  reason: FleetRuntimeDriftReason;
}

export interface FleetRuntimeAlert {
  severity: "critical";
  title: string;
  detail: string;
  /** The remedy's NAME. The console renders it as text; there is no action behind it. */
  remedy: string;
}

export interface FleetRuntimeHealth {
  state: FleetRuntimeState;
  /** Why `unknown`: one of {@link FleetRuntimeUnknownReason}, or a producer code such as `inspect-unreadable`. */
  reason?: string;
  observedAt?: string;
  ageMs?: number;
  container?: string;
  checked?: number;
  drift?: FleetRuntimeDrift[];
  alert?: FleetRuntimeAlert;
}

export function fleetRuntimeHealthPath(root: string): string {
  return join(root, "state", "fleet-runtime-health.json");
}

const DRIFT_REASONS: ReadonlySet<string> = new Set<FleetRuntimeDriftReason>(["missing", "wrong_source", "read_only", "read_write"]);
// A container destination: absolute, bounded, no control characters or shell-ish surprises.
const DESTINATION = /^\/[A-Za-z0-9._\-/]{0,511}$/;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
// Producer reason codes are short lower-case slugs; anything else is not echoed.
const PRODUCER_REASON = /^[a-z][a-z0-9-]{0,63}$/;

function unknown(reason: FleetRuntimeUnknownReason | string, extra: Partial<FleetRuntimeHealth> = {}): FleetRuntimeHealth {
  return { state: "unknown", reason, ...extra };
}

function parseDrift(value: unknown): FleetRuntimeDrift[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_DRIFT_ENTRIES) return undefined;
  const out: FleetRuntimeDrift[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const { destination, reason } = item as Record<string, unknown>;
    if (typeof destination !== "string" || !DESTINATION.test(destination)) return undefined;
    if (typeof reason !== "string" || !DRIFT_REASONS.has(reason)) return undefined;
    out.push({ destination, reason: reason as FleetRuntimeDriftReason });
  }
  return out;
}

function driftAlert(container: string | undefined, drift: readonly FleetRuntimeDrift[]): FleetRuntimeAlert {
  const mounts = drift.map((entry) => `${entry.destination} (${entry.reason.replace("_", " ")})`).join(", ");
  return {
    severity: "critical",
    title: "Runtime launch drift: the live container lost commissioned mounts",
    detail:
      `${container ?? "the daemon container"} is running without ${drift.length === 1 ? "an expected mount" : "expected mounts"}: ${mounts}. ` +
      "Liveness and source freshness can read green while a provider (for example Codex) is unavailable.",
    remedy: FLEET_RUNTIME_REMEDY,
  };
}

/**
 * Read and judge the heartbeat's runtime-health snapshot. Total: every failure is a value, and
 * every failure is `unknown`. `readText` is the one seam (a test reads a fixture through it).
 */
export function readFleetRuntimeHealth(
  root: string,
  nowMs: number,
  readText: (path: string) => string = (path) => readFileSync(path, "utf8"),
): FleetRuntimeHealth {
  let raw: string;
  try {
    raw = readText(fleetRuntimeHealthPath(root));
  } catch (error) {
    return unknown((error as NodeJS.ErrnoException).code === "ENOENT" ? "no-snapshot" : "unreadable");
  }
  if (raw.length > MAX_SNAPSHOT_BYTES) return unknown("malformed");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return unknown("malformed");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return unknown("malformed");
  const record = body as Record<string, unknown>;
  if (typeof record.version !== "number" || !Number.isInteger(record.version) || record.version < 1) return unknown("malformed");
  if (record.version > FLEET_RUNTIME_HEALTH_VERSION) return unknown("future-version");

  const observedAt = record.observed_at;
  const observedMs = typeof observedAt === "string" ? Date.parse(observedAt) : Number.NaN;
  if (typeof observedAt !== "string" || !Number.isFinite(observedMs)) return unknown("malformed");
  const container = typeof record.container === "string" && CONTAINER_NAME.test(record.container) ? record.container : undefined;
  if (container === undefined) return unknown("malformed");
  const ageMs = nowMs - observedMs;
  if (ageMs < -FUTURE_SKEW_MS) return unknown("clock-skew", { observedAt, container });
  const known = { observedAt, container, ageMs: Math.max(0, ageMs) };
  // Staleness outranks the verdict: an old "healthy" is the exact reading this task exists to refuse.
  if (ageMs > FLEET_RUNTIME_HEALTH_STALE_MS) return unknown("stale", known);

  const status = record.status;
  const checked = record.checked;
  const drift = parseDrift(record.drift);
  if (status === "unknown") {
    const reason = typeof record.reason === "string" && PRODUCER_REASON.test(record.reason) ? record.reason : "producer-unknown";
    return unknown(reason, known);
  }
  if (typeof checked !== "number" || !Number.isInteger(checked) || checked < 0 || checked > MAX_DRIFT_ENTRIES || drift === undefined) {
    return unknown("malformed", known);
  }
  if (status === "healthy") {
    // A healthy verdict over zero expectations or with drift attached is incoherent, not healthy.
    if (checked < 1 || drift.length > 0) return unknown("malformed", known);
    return { state: "healthy", ...known, checked, drift: [] };
  }
  if (status === "drift") {
    if (drift.length === 0 || drift.length > checked) return unknown("malformed", known);
    return { state: "drift", ...known, checked, drift, alert: driftAlert(container, drift) };
  }
  return unknown("malformed", known);
}

/**
 * Change-only telemetry: one bounded line when the (state, reason) pair changes, silence on every
 * repeat read -- the console polls `/v1/status` on a timer and must not turn that into log volume.
 */
export function fleetRuntimeHealthTelemetry(
  emit: (line: string) => void = (line) => console.error(line),
): (health: FleetRuntimeHealth) => FleetRuntimeHealth {
  let last: string | undefined;
  return (health) => {
    const key = `${health.state}:${health.reason ?? ""}`;
    if (key !== last) {
      last = key;
      emit(JSON.stringify({ event: "serve.fleet_runtime_health", state: health.state, reason: health.reason ?? null, drift: health.drift?.length ?? 0 }));
    }
    return health;
  };
}
