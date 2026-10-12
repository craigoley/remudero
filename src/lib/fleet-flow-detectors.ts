import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fixedClock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { createLedgerRotationMemo, readLedgerUnionRecordsMemoized } from "./ledger-union.js";

export type FleetFlowRow = Record<string, unknown>;
export type FleetFlowHistory = readonly { population: string; measured: number; ts: number }[];

/** Each registration supplies its reviewed policy; this seam invents no detector thresholds. */
export interface FleetFlowPolicy {
  minSamples: number;
  maxSamples: number;
  longMs: number;
}

export interface FleetFlowFinding {
  name: string;
  subject: string;
  measured: number;
  bound: number | undefined;
  population: string;
  /** Subjects use runbooks' key=value spelling: task=, pr=, instance= or hold=. */
  message: string;
}

export interface FleetFlowDetector {
  id: string;
  inputs: readonly string[];
  policy: FleetFlowPolicy;
  /** Return measurements even while healthy or warming up, so history can learn the population. */
  evaluate(rows: readonly FleetFlowRow[], nowMs: number, history: FleetFlowHistory): readonly FleetFlowFinding[];
}

/** Trailing nearest-rank p90, matching flow-gardener; non-finite observations are not samples. */
export function ownHistoryBound(
  samples: readonly number[],
  policy: Pick<FleetFlowPolicy, "minSamples" | "maxSamples">,
): number | undefined {
  const sorted = samples.filter(Number.isFinite).slice(-policy.maxSamples).sort((a, b) => a - b);
  if (sorted.length < policy.minSamples || sorted.length === 0) return undefined;
  return sorted[Math.ceil(sorted.length * 0.9) - 1];
}

interface DetectorMemory {
  history: FleetFlowHistory;
  emitted: { name: string; subject: string; ts: number }[];
}
interface FlowStore {
  detectors: Record<string, DetectorMemory>;
}

function readStore(path: string): FlowStore {
  if (!existsSync(path)) return { detectors: {} };
  // A corrupt history is unknown, not a healthy empty population: fail this pass visibly.
  const store = JSON.parse(readFileSync(path, "utf8")) as FlowStore;
  if (!store || !store.detectors || typeof store.detectors !== "object" || Array.isArray(store.detectors)) {
    throw new Error(`Invalid fleet-flow history: ${path}`);
  }
  return store;
}

function inWindow(rows: readonly FleetFlowRow[], since: number, now: number): FleetFlowRow[] {
  return rows.filter((row) => {
    const ts = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    return ts > since && ts <= now;
  });
}

function matchesInput(step: unknown, inputs: readonly string[]): boolean {
  return typeof step === "string" && inputs.some((input) =>
    input.endsWith("*") ? step.startsWith(input.slice(0, -1)) :
      input.startsWith("*") ? step.endsWith(input.slice(1)) : step === input);
}

function inputPattern(inputs: readonly string[]): RegExp {
  const alternatives = inputs.map((input) => {
    const prefix = input.endsWith("*");
    const suffix = !prefix && input.startsWith("*");
    const literal = prefix ? input.slice(0, -1) : suffix ? input.slice(1) : input;
    const escaped = JSON.stringify(literal).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return `${suffix ? '[^"]*' : ""}${escaped}${prefix ? '[^"]*' : ""}`;
  });
  return new RegExp(`"step"\\s*:\\s*"(?:${alternatives.join("|")})"`);
}

export interface FleetFlowInput {
  stateDir: string;
  detectors: readonly FleetFlowDetector[];
  nowMs: number;
  readRows?: (sinceMs: number, nowMs: number) => readonly FleetFlowRow[] | Promise<readonly FleetFlowRow[]>;
  writeEvent?: (row: LedgerLine) => void;
}

// One recent, step-filtered rotation memo per registry/state root. No historical ledger rescan for bounds.
const readers = new Map<string, { signature: string; since: number; now: number; read: () => Promise<FleetFlowRow[]> }>();

async function recentRows(input: FleetFlowInput, longMs: number): Promise<readonly FleetFlowRow[]> {
  const since = input.nowMs - longMs;
  if (input.readRows) return input.readRows(since, input.nowMs);
  const inputs = [...new Set(input.detectors.flatMap((d) => [...d.inputs]))];
  const pattern = inputPattern(inputs);
  const signature = JSON.stringify([inputs, longMs]);
  let reader = readers.get(input.stateDir);
  if (!reader || reader.signature !== signature) {
    const fresh = { signature, since, now: input.nowMs, read: async (): Promise<FleetFlowRow[]> => [] };
    const memo = createLedgerRotationMemo((rows) =>
      inWindow(rows, fresh.since, fresh.now).filter((row) => matchesInput(row.step, inputs)), { pattern });
    fresh.read = async () => {
      const result = await readLedgerUnionRecordsMemoized(input.stateDir, memo, {
        since: fixedClock(fresh.since).iso(), rotationWindowMs: longMs,
        step: inputs.every((step) => !step.includes("*")) ? inputs : undefined,
        pattern,
        refuseIncomplete: true,
      });
      if (!result.ok) throw new Error(`Fleet-flow ledger unreadable: ${result.unread.join(", ")}`);
      return inWindow(result.rows, fresh.since, fresh.now).filter((row) => matchesInput(row.step, inputs));
    };
    reader = fresh;
    readers.set(input.stateDir, reader);
  }
  reader.since = since;
  reader.now = input.nowMs;
  return reader.read();
}

/** Evaluate both windows against the PREVIOUS population history, then learn and persist this pass. */
export async function evaluateFleetFlowDetectors(input: FleetFlowInput): Promise<LedgerLine[]> {
  if (input.detectors.length === 0) return [];
  for (const { id, policy } of input.detectors) {
    if (!Number.isInteger(policy.minSamples) || policy.minSamples <= 0 ||
        !Number.isInteger(policy.maxSamples) || policy.maxSamples < policy.minSamples ||
        !Number.isFinite(policy.longMs) || policy.longMs <= 0) {
      throw new Error(`Invalid fleet-flow policy: ${id}`);
    }
  }
  const now = input.nowMs;
  const rows = await recentRows(input, Math.max(...input.detectors.map((d) => d.policy.longMs)));
  const path = join(input.stateDir, "fleet-flow-detectors.json");
  const store = readStore(path);
  const next: FlowStore = { detectors: {} };
  const events: LedgerLine[] = [];
  for (const detector of input.detectors) {
    const { longMs, maxSamples } = detector.policy;
    const shortMs = longMs / 12;
    const memory = store.detectors[detector.id] ?? { history: [], emitted: [] };
    const history = memory.history.filter((s) => s.ts < now && Number.isFinite(s.measured)).slice(-maxSamples);
    const applicable = rows.filter((row) => matchesInput(row.step, detector.inputs));
    const long = detector.evaluate(inWindow(applicable, now - longMs, now), now, history);
    const short = detector.evaluate(inWindow(applicable, now - shortMs, now), now, history);
    const emitted = memory.emitted.filter((entry) => entry.ts > now - shortMs && entry.ts <= now);
    for (const finding of long) {
      const bound = ownHistoryBound(history.filter((s) => s.population === finding.population).map((s) => s.measured), detector.policy);
      const confirmation = short.find((s) => s.name === finding.name && s.subject === finding.subject && s.population === finding.population);
      if (bound === undefined || !Number.isFinite(finding.measured) || finding.measured <= bound ||
          !confirmation || !Number.isFinite(confirmation.measured) || confirmation.measured <= bound) continue;
      if (emitted.some((e) => e.name === finding.name && e.subject === finding.subject)) continue;
      const event: LedgerLine = {
        run_id: `FLOW-${now}-${detector.id}`, task_id: "INCIDENT", step: "incident.event",
        source: "sre-lane", kind: "flow", name: finding.name,
        fingerprint: createHash("sha256").update(`flow\u0000${finding.name}`, "utf8").digest("hex"),
        subject: finding.subject, population: finding.population, measured: finding.measured, bound,
        // Runbooks read the first key=value token, so the finding's exact subject must lead.
        message: finding.message.split(/\s+/, 1)[0] === finding.subject
          ? finding.message : `${finding.subject} ${finding.message}`,
      };
      if (input.writeEvent) input.writeEvent(event);
      else appendLedger(join(input.stateDir, LEDGER_FILENAME), event, { clock: fixedClock(now) });
      events.push(event);
      emitted.push({ name: finding.name, subject: finding.subject, ts: now });
    }
    const measurements = long.filter((s) => Number.isFinite(s.measured))
      .map((s) => ({ population: s.population, measured: s.measured, ts: now }));
    next.detectors[detector.id] = { history: [...history, ...measurements].slice(-maxSamples), emitted };
  }
  writeAtomic(path, JSON.stringify(next) + "\n");
  return events;
}
