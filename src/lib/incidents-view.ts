/**
 * `incidents`: the console's /incidents page as ONE body across instances (arch Phase 4 design §1.1, P4-T15,
 * W1-T5054). The page read GET /v1/incidents, each instance's GET /v1/operator-agent/emergency/status and
 * daemon health separately; this view stitches the three reads in the read-model worker.
 *
 * - `store`: the incident lifecycle store, exactly GET /v1/incidents' list ({@link incidentsNewestFirst}), or
 *   the reason that route answers 503. Re-read only when the store file's fingerprint (size, mtime, inode)
 *   moves. Source: `incidents-store:<home>`.
 * - `instances[].emergency.active`: the route's {@link activeEmergencyStopsAt} over the instance's
 *   `panel.emergency_stop_*` rows, taken from the agent view's persisted `panel.*` fold (W1-T5051,
 *   {@link AGENT_FOLDS}), so no ledger read happens here. Source: `ledger:<i>`.
 * - `instances[].liveness`: a BAND over the newest projected `daemon.*` row ({@link instanceLiveness}): `up`,
 *   `unknown`, or `down` with the row's own time. The raw heartbeat time is never carried, so a beat inside
 *   the band leaves the ETag where it was.
 *
 * A body whose content did not change is the previous object, so its build record (and the ETag) stays put.
 */
import { statSync } from "node:fs";
import { fixedClock } from "./clock.js";
import type { EmergencyStop } from "./emergency-control.js";
import { incidentLifecycleStorePath, incidentsNewestFirst, readIncidentLifecycleStore, type IncidentWire } from "./incident-lifecycle.js";
import { instanceLiveness, type InstanceEntry } from "./instances-view.js";
import { EMERGENCY_STOP_CLEARED_LEDGER_STEP, EMERGENCY_STOP_ISSUED_LEDGER_STEP } from "./ledger.js";
import { createLedgerRotationMemo, readLedgerUnionRecordsSync, type LedgerRotationMemo } from "./ledger-union.js";
import { activeEmergencyStopsAt } from "./operator-agent.js";
import { AGENT_FOLDS, type AgentFolds, type ReadModelDb, type ReadModelLease } from "./read-model-db.js";
import type { ShadowLegacy } from "./view-shadow.js";
import type { ViewSource } from "./views.js";

export const INCIDENTS_VIEW_NAME = "incidents";
export const INCIDENTS_VIEW_VERSION = 1;

/** GET /v1/incidents' list, or the reason it answers 503 `incidents_unavailable`. */
export type IncidentsStorePart = { state: "ok"; incidents: IncidentWire[] } | { state: "unavailable"; reason: string };

export interface IncidentsInstance {
  instance: string;
  /** What GET /v1/operator-agent/emergency/status answers as `active` for this instance. */
  emergency: { active: EmergencyStop[] };
  liveness: InstanceEntry["liveness"];
}

export interface IncidentsViewData {
  store: IncidentsStorePart;
  instances: IncidentsInstance[];
}

type Row = Record<string, unknown>;
type Slot<S> = { state: S; db?: ReadModelDb; lease?: ReadModelLease };

const EMERGENCY_STEPS: ReadonlySet<unknown> = new Set([EMERGENCY_STOP_ISSUED_LEDGER_STEP, EMERGENCY_STOP_CLEARED_LEDGER_STEP]);
const EMERGENCY_ROW = /"step":"panel\.emergency_stop_/;
const isEmergencyRow = (row: Row): boolean => EMERGENCY_STEPS.has(row.step);

/** The store file's fingerprint and its mtime as the source's as-of; an absent store has neither. */
function storeStat(path: string): { fingerprint: string; asOf: string | null } {
  try {
    const stat = statSync(path);
    return { fingerprint: `${stat.size}:${stat.mtimeMs}:${stat.ino}`, asOf: fixedClock(Math.floor(stat.mtimeMs)).iso() };
  } catch {
    // deliberate: a store that does not exist is the route's healthy empty list (readIncidentLifecycleStore).
    return { fingerprint: "absent", asOf: null };
  }
}

/** GET /v1/incidents' answer over the store at `stateDir`, as a body part. */
export function incidentsStorePart(stateDir: string): IncidentsStorePart {
  const read = readIncidentLifecycleStore(stateDir);
  return read.ok ? { state: "ok", incidents: incidentsNewestFirst(read.store) } : { state: "unavailable", reason: read.reason };
}

export interface IncidentsViewOptions<S extends { instance: string; tickedAt?: number }> {
  instances: ReadonlyArray<{ name: string; ledgerDir: string }>;
  /** The worker's `ledger:<i>` judge. */
  ledgerSource: (state: S, now: number) => ViewSource;
  /** Where the store lives: serve's GET /v1/incidents reads `dirname(ledgerPath)`, the home instance's ledger dir. */
  incidentsDir?: string;
  folds?: AgentFolds;
}

/** What a body was built from, so the shadow's legacy side reads the same inputs. */
interface Built {
  builtMs: number;
  newestTsMs: Map<string, number>;
}

/** The `incidents` view as the read-model worker materializes it: one body, key `""`. */
export function createIncidentsView<S extends { instance: string; tickedAt?: number }>(opts: IncidentsViewOptions<S>): {
  name: string;
  version: number;
  prepare(ctx: { instances: ReadonlyArray<Slot<S>> }, more: () => boolean): boolean;
  materialize(ctx: { now: number; instances: ReadonlyArray<Slot<S>> }): Array<{ key: string; data: IncidentsViewData; sources: ViewSource[] }>;
  legacy(key: string, now: number, data: unknown): ShadowLegacy | undefined;
} {
  const folds = opts.folds ?? AGENT_FOLDS;
  const byName = new Map(opts.instances.map((instance) => [instance.name, instance]));
  const storeDir = opts.incidentsDir ?? opts.instances[0]?.ledgerDir;
  const storeSource = `incidents-store:${opts.instances[0]?.name}`;
  const shown = new WeakMap<IncidentsViewData, Built>();
  const legacyMemos = new Map<string, LedgerRotationMemo>();
  let store: { fingerprint: string; asOf: string | null; part: IncidentsStorePart } | undefined;
  let last: { json: string; data: IncidentsViewData } | undefined;
  const slotsOf = (instances: ReadonlyArray<Slot<S>>) => instances.flatMap((slot) =>
    byName.has(slot.state.instance) && slot.db && slot.state.tickedAt !== undefined ? [{ ...slot, db: slot.db, name: slot.state.instance }] : []);
  const foldSlot = (slot: { name: string; db: ReadModelDb; lease?: ReadModelLease }) => ({ instance: slot.name, db: slot.db, ...(slot.lease ? { lease: slot.lease } : {}) });
  return {
    name: INCIDENTS_VIEW_NAME,
    version: INCIDENTS_VIEW_VERSION,
    prepare: ({ instances }, more) => slotsOf(instances).every((slot) => folds.advance(foldSlot(slot), more)),
    materialize: ({ now, instances }) => {
      if (storeDir === undefined) return [];
      const stat = storeStat(incidentLifecycleStorePath(storeDir));
      if (store?.fingerprint !== stat.fingerprint) store = { ...stat, part: incidentsStorePart(storeDir) };
      const newestTsMs = new Map<string, number>();
      const slots = slotsOf(instances);
      const data: IncidentsViewData = {
        store: store.part,
        instances: slots.map((slot) => {
          const fold = folds.current(foldSlot(slot));
          newestTsMs.set(slot.name, fold.newestTsMs);
          return { instance: slot.name, emergency: { active: activeEmergencyStopsAt(fold.rows.filter(isEmergencyRow), now) }, liveness: instanceLiveness(slot.db, now) };
        }),
      };
      const json = JSON.stringify(data);
      if (last?.json !== json) {
        last = { json, data };
        shown.set(data, { builtMs: now, newestTsMs });
      }
      const read: ViewSource = store.part.state === "ok"
        ? { name: storeSource, asOf: store.asOf, state: "fresh" }
        : { name: storeSource, asOf: store.asOf, state: "unavailable", reason: `the incident lifecycle store is ${store.part.reason}` };
      return [{ key: "", data: last.data, sources: [read, ...slots.map((slot) => opts.ledgerSource(slot.state, now))] }];
    },
    /**
     * The shadow side: GET /v1/incidents over a fresh read of the store, and each instance's emergency status
     * route over the ledger union read the routes' way, up to the fold's newest row at the build. Liveness is
     * the body's own reading: no route bands a heartbeat, so a second sample would compare two instants.
     */
    legacy: (_key, _now, data) => {
      const view = data as IncidentsViewData;
      const built = shown.get(view);
      if (!built || storeDir === undefined) return undefined;
      const instances = view.instances.map(({ instance, liveness }) => {
        const memo = legacyMemos.get(instance) ?? createLedgerRotationMemo((rows) => rows.filter(isEmergencyRow), { pattern: EMERGENCY_ROW });
        legacyMemos.set(instance, memo);
        const pass = memo.pass({ parseMissing: true });
        const union = readLedgerUnionRecordsSync(byName.get(instance)!.ledgerDir, { pattern: EMERGENCY_ROW, rotationRecords: pass.rotationRecords }).rows;
        pass.complete();
        const newestTsMs = built.newestTsMs.get(instance)!;
        const rows = union.filter((row) => isEmergencyRow(row) && !(Date.parse(String(row.ts)) > newestTsMs));
        return { instance, emergency: { active: activeEmergencyStopsAt(rows, built.builtMs) }, liveness };
      });
      const stat = storeStat(incidentLifecycleStorePath(storeDir));
      return {
        data: { store: incidentsStorePart(storeDir), instances },
        asOfMs: built.builtMs,
        // A store written between the build and this read is two inputs, not a diff.
        paired: { store: { source: storeSource, asOf: stat.asOf } },
      };
    },
  };
}
