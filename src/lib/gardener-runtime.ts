import { join } from "node:path";
import { open } from "node:fs/promises";
import { systemClock, type Clock } from "./clock.js";
import { writeAtomicAsync } from "./fs-race-safe.js";

export const GARDENER_RUNTIME_VERSION = 1;
export const GARDENER_RUNTIME_FILE = "gardener-runtime.json";
/** PRIMARY CONTROL: the 32-entry inventory fits below 64 KiB; no historical payload is admitted. */
export const GARDENER_RUNTIME_MAX_BYTES = 64 * 1024;
export type GardenerPhase = "scheduled" | "queued" | "running" | "completed" | "failed" | "cancelled" | "idle";
export interface GardenerRuntimeEvent {
  name: string;
  phase: GardenerPhase;
  observedAt: string;
  passId: string | null;
  nextDueAt: string | null;
  queueMs: number | null;
  executionMs: number | null;
  exit: number | null;
  reason: "inputs-unchanged" | "process-completed" | "process-failed" | "signal-or-cancelled" | "spawn-failed" | null;
}
export interface GardenerRuntimeEntry extends GardenerRuntimeEvent {
  enabled: boolean;
  cadenceMs: number;
  scope: "repository" | "host" | "fleet";
  attempts: number;
  completions: number;
  failures: number;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}
export interface GardenerRuntimeSnapshot {
  version: 1;
  repository: string;
  daemonRunId: string;
  codeSha: string | null;
  configuredAt: string;
  observedAt: string;
  gardens: GardenerRuntimeEntry[];
}

const phases: readonly unknown[] = ["scheduled", "queued", "running", "completed", "failed", "cancelled", "idle"];
const reasons: readonly unknown[] = [null, "inputs-unchanged", "process-completed", "process-failed", "signal-or-cancelled", "spawn-failed"];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const duration = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);

export function parseGardenerRuntime(raw: unknown): GardenerRuntimeSnapshot {
  if (!object(raw) || raw.version !== GARDENER_RUNTIME_VERSION || typeof raw.repository !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.repository) || typeof raw.daemonRunId !== "string" || !raw.daemonRunId || raw.daemonRunId.length > 128 ||
      !(raw.codeSha === null || (typeof raw.codeSha === "string" && /^[a-f0-9]{40}$/.test(raw.codeSha))) ||
      !time(raw.configuredAt) || !time(raw.observedAt) || !Array.isArray(raw.gardens) || raw.gardens.length < 1 || raw.gardens.length > 32) {
    throw new Error("gardener runtime identity or inventory is malformed");
  }
  const names = new Set<string>();
  const gardens: GardenerRuntimeEntry[] = [];
  for (const entry of raw.gardens) {
    if (!object(entry) || typeof entry.name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.name) || names.has(entry.name) ||
        typeof entry.enabled !== "boolean" || !count(entry.cadenceMs) || entry.cadenceMs < 1 ||
        typeof entry.scope !== "string" || !["repository", "host", "fleet"].includes(entry.scope) ||
        typeof entry.phase !== "string" || !phases.includes(entry.phase) || !time(entry.observedAt) ||
        !(entry.passId === null || (typeof entry.passId === "string" && entry.passId.length > 0 && entry.passId.length <= 128)) ||
        !(entry.nextDueAt === null || time(entry.nextDueAt)) || !duration(entry.queueMs) || !duration(entry.executionMs) ||
        !(entry.exit === null || (typeof entry.exit === "number" && Number.isInteger(entry.exit))) || !reasons.includes(entry.reason) ||
        !count(entry.attempts) || !count(entry.completions) || !count(entry.failures) || entry.completions > entry.attempts ||
        entry.failures > entry.completions || [entry.lastCompletedAt, entry.lastSuccessAt, entry.lastFailureAt]
          .some((stamp) => stamp !== null && !time(stamp))) throw new Error("gardener runtime entry is malformed");
    names.add(entry.name);
    // Validation does not authorize forwarding future or private producer fields.
    const g = entry as unknown as GardenerRuntimeEntry;
    gardens.push({ name: g.name, enabled: g.enabled, cadenceMs: g.cadenceMs, scope: g.scope,
      phase: g.phase, observedAt: g.observedAt, passId: g.passId, nextDueAt: g.nextDueAt,
      queueMs: g.queueMs, executionMs: g.executionMs, exit: g.exit, reason: g.reason,
      attempts: g.attempts, completions: g.completions, failures: g.failures,
      lastCompletedAt: g.lastCompletedAt, lastSuccessAt: g.lastSuccessAt, lastFailureAt: g.lastFailureAt });
  }
  return { version: 1, repository: raw.repository, daemonRunId: raw.daemonRunId,
    codeSha: raw.codeSha, configuredAt: raw.configuredAt, observedAt: raw.observedAt, gardens };
}

/** Read one descriptor, with a hard byte bound; no ledger, model call or GitHub read. */
export async function readGardenerRuntime(stateDir: string): Promise<GardenerRuntimeSnapshot> {
  const handle = await open(join(stateDir, GARDENER_RUNTIME_FILE), "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > GARDENER_RUNTIME_MAX_BYTES) throw new Error("gardener runtime exceeds its read bound");
    const bytes = Buffer.alloc(GARDENER_RUNTIME_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > GARDENER_RUNTIME_MAX_BYTES) throw new Error("gardener runtime grew beyond its read bound");
    return parseGardenerRuntime(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
  } finally { await handle.close(); }
}

/** Coalesce only the read projection; the ledger preserves every lifecycle event. One writer owns
 * this daemon generation, so overlapping asynchronous writes cannot regress a completed pass. */
export function createGardenerRuntimeWriter(input: {
  stateDir: string; repository: string; daemonRunId: string; codeSha?: string; clock?: Clock;
  gardens: Array<{ name: string; enabled: boolean; cadenceMs: number; scope: GardenerRuntimeEntry["scope"] }>;
  log: (step: string, extra?: Record<string, unknown>) => void;
  write?: (path: string, text: string) => Promise<void>;
}) {
  const clock = input.clock ?? systemClock;
  const configuredAt = clock.iso();
  const snapshot = parseGardenerRuntime({ version: 1, repository: input.repository, daemonRunId: input.daemonRunId,
    codeSha: input.codeSha ?? null, configuredAt, observedAt: configuredAt,
    gardens: input.gardens.map((entry) => ({ ...entry, phase: "scheduled", observedAt: configuredAt,
      passId: null, nextDueAt: null, queueMs: null, executionMs: null, exit: null, reason: null,
      attempts: 0, completions: 0, failures: 0, lastCompletedAt: null, lastSuccessAt: null, lastFailureAt: null })) });
  let revision = 1, written = 0, running: Promise<void> | undefined;
  const write = input.write ?? writeAtomicAsync;
  const flush = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      while (written < revision) {
        const target = revision;
        await write(join(input.stateDir, GARDENER_RUNTIME_FILE), JSON.stringify(parseGardenerRuntime(snapshot)) + "\n");
        written = target;
      }
    })().finally(() => { running = undefined; });
    return running;
  };
  return {
    flush,
    record(event: GardenerRuntimeEvent): void {
      const entry = snapshot.gardens.find((garden) => garden.name === event.name);
      if (!entry || !entry.enabled) throw new Error("gardener event is outside the configured inventory");
      // A cheap unchanged-input observation is not a new pass and must retain its last timings.
      if (event.phase === "idle") Object.assign(entry, { phase: event.phase, observedAt: event.observedAt,
        nextDueAt: event.nextDueAt, reason: event.reason });
      else Object.assign(entry, event);
      if (event.phase === "queued") entry.attempts++;
      if (["completed", "failed", "cancelled"].includes(event.phase)) { entry.completions++; entry.lastCompletedAt = event.observedAt; }
      if (event.phase === "completed") entry.lastSuccessAt = event.observedAt;
      if (event.phase === "failed") { entry.failures++; entry.lastFailureAt = event.observedAt; }
      snapshot.observedAt = event.observedAt;
      revision++;
      input.log("garden.lifecycle", { ...event, repository: input.repository, daemon_run_id: input.daemonRunId });
      void flush().catch(() => input.log("garden.telemetry_failed", { name: event.name, reason: "runtime-write-failed" }));
    },
  };
}
