/**
 * `repositories`: the repository portfolio across every instance in one view body (Phase 1 P1-08, design §3.4).
 *
 * It folds `GET /v1/repos/summary` and `/v1/i/<instance>/repos/summary` (#7926) into the read model. Each
 * instance's summary keeps that route's fields, error-rate definition, cash-vs-subscription split and
 * `not_computed` list, because it IS that route's computation (`repoSummarySync`). Only the ledger read
 * differs: the rows come from the instance's `repo_row` table and its `instance_heartbeat`, which the
 * ledger projector maintains exactly once per distinct row, instead of a per-process index over the rotations.
 *
 * Freshness follows #7928. A summary is recomputed on #7926's cadence (30 s after an input moves, else 60 s), well
 * inside #7928's five-minute bound, so it is stale only when its recompute failed: the last good summary stays,
 * marked stale with the reason. A stalled worker is the `ledger:<instance>` source's to report. Serve's main thread publishes each instance's route options to
 * `read-model/repositories-sources.json`, since the worker cannot resolve them from the registry itself.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixedClock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { readOnMtimeChange, startSourcePublisher } from "./nav-badge-view.js";
import { loadPlan, type Plan } from "./plan.js";
import { READ_MODEL_DIRNAME, type ReadModelDb } from "./read-model-db.js";
import {
  REPO_TELEMETRY_CACHE_TTL_MS,
  REPO_TELEMETRY_MIN_AGE_MS,
  REPO_TELEMETRY_WINDOW_MS,
  repoSummarySync,
  type RepoDashboardOptions,
  type RepoDashboardResult,
} from "./repo-dashboard-route.js";
import type { ViewSource } from "./views.js";

export const REPOSITORIES_VIEW_VERSION = 1;
export const REPOSITORIES_SOURCES_FILE = "repositories-sources.json";

/** The options each instance's summary route is built with, as serve's main thread resolved them. */
export type RepositoriesInstanceOptions = Pick<
  RepoDashboardOptions,
  "root" | "instanceRepository" | "repoRegistryPath" | "ownInstance" | "controlRoot" | "incidentsDir" | "ledgerPath" | "planPath"
>;

export interface RepositoriesSources {
  instances: Array<{ instanceId: string; options: RepositoriesInstanceOptions }>;
}

export interface RepositoriesData {
  instances: Array<{ instanceId: string; summary?: RepoDashboardResult; reason?: string }>;
  reason?: string;
}

export function repositoriesSourcesPath(stateDir: string): string {
  return join(stateDir, READ_MODEL_DIRNAME, REPOSITORIES_SOURCES_FILE);
}

/** Writes the instances' route options whenever they change; returns whether it wrote. */
export function createRepositoriesSourcePublisher(opts: { stateDir: string; instances: () => RepositoriesSources["instances"] }): () => boolean {
  const path = repositoriesSourcesPath(opts.stateDir);
  let written: string | undefined;
  return () => {
    const text = JSON.stringify({ instances: opts.instances() } satisfies RepositoriesSources);
    if (text === written) return false;
    writeAtomic(path, text);
    written = text;
    return true;
  };
}

export function startRepositoriesSourcePublisher(
  opts: Parameters<typeof createRepositoriesSourcePublisher>[0] & Parameters<typeof startSourcePublisher>[2],
): () => void {
  return startSourcePublisher(createRepositoriesSourcePublisher(opts), "read_model.repositories_sources_failed", opts);
}

function readSources(path: string): RepositoriesSources | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RepositoriesSources;
  } catch {
    // deliberate: an absent or half-written file reads as unpublished, and the view says so.
    return undefined;
  }
}

/** One instance's `repo_row` rows inside twice the window, plus its newest heartbeat as a `daemon.*` row:
 *  the shape `computeRepoTelemetrySync`'s `readLedger` seam takes. */
export function readRepoRows(db: ReadModelDb, nowMs: number): Array<Record<string, unknown>> {
  const rows = db.prepare("SELECT body FROM repo_row WHERE ts_ms >= ? ORDER BY ts_ms, h").all(nowMs - 2 * REPO_TELEMETRY_WINDOW_MS)
    .map((row) => JSON.parse(String(row.body)) as Record<string, unknown>);
  const beat = db.prepare("SELECT last_ms FROM instance_heartbeat WHERE k = 'daemon'").get();
  if (beat) rows.push({ ts: fixedClock(Number(beat.last_ms)).iso(), step: "daemon.heartbeat" });
  return rows;
}

interface InstanceSummary {
  /** The last attempt, successful or not. */
  atMs: number;
  generation: number;
  sourcesMtimeMs: number;
  summary?: RepoDashboardResult;
  reason?: string;
}

function planReader(): (path: string) => Plan {
  const memo = new Map<string, { stamp: string; plan: Plan }>();
  return (path) => {
    const stamp = [path, join(dirname(path), "tasks.d")].map((p) => {
      try {
        return String(statSync(p).mtimeMs);
      } catch {
        // deliberate: an absent tasks.d is part of the stamp; loadPlan reports an unreadable plan itself.
        return "absent";
      }
    }).join("|");
    const hit = memo.get(path);
    if (hit?.stamp === stamp) return hit.plan;
    const plan = loadPlan(path);
    memo.set(path, { stamp, plan });
    return plan;
  };
}

/** `repositories` materialized by the read-model worker; `ledgerSource` is the worker's own, passed in. */
export function createRepositoriesReadModelView<S extends { instance: string; tickedAt?: number; generation: number }>(ledgerSource: (state: S, now: number) => ViewSource): {
  name: string;
  version: number;
  materialize(ctx: { now: number; instances: ReadonlyArray<{ state: S; db?: ReadModelDb }> }): Array<{ key: string; data: RepositoriesData; sources: ViewSource[] }>;
} {
  const sourcesFile = readOnMtimeChange(readSources);
  const computed = new Map<string, InstanceSummary>();
  const readPlan = planReader();
  return {
    name: "repositories",
    version: REPOSITORIES_VIEW_VERSION,
    materialize: ({ now, instances }) => {
      const dbPath = instances.find((slot) => slot.db)?.db?.path;
      if (dbPath === undefined) return [];
      const path = join(dirname(dbPath), REPOSITORIES_SOURCES_FILE);
      const published = sourcesFile(path);
      if (published === undefined) return [{ key: "", data: { instances: [], reason: "serve has not published the repository sources yet" }, sources: [] }];
      const sourcesMtimeMs = statSync(path).mtimeMs;
      const sources: ViewSource[] = [];
      const data: RepositoriesData = { instances: [] };
      for (const { instanceId, options } of published.instances) {
        const slot = instances.find((candidate) => candidate.state.instance === instanceId);
        if (slot) sources.push(ledgerSource(slot.state, now));
        const prior = computed.get(instanceId);
        const generation = slot?.state.generation ?? -1;
        const ageMs = prior ? now - prior.atMs : Number.POSITIVE_INFINITY;
        const moved = prior !== undefined && (prior.generation !== generation || prior.sourcesMtimeMs !== sourcesMtimeMs);
        let current = prior;
        if (!prior || ageMs >= REPO_TELEMETRY_CACHE_TTL_MS || (moved && ageMs >= REPO_TELEMETRY_MIN_AGE_MS)) {
          const next = summarize(slot, options, now, readPlan);
          current = next.summary
            ? { atMs: now, generation, sourcesMtimeMs, summary: next.summary }
            : { atMs: now, generation, sourcesMtimeMs, reason: next.reason, ...(prior?.summary ? { summary: prior.summary } : {}) };
          computed.set(instanceId, current);
        }
        sources.push(summarySource(instanceId, current!));
        data.instances.push({ instanceId, ...(current!.summary ? { summary: current!.summary } : {}), ...(current!.reason ? { reason: current!.reason } : {}) });
      }
      return [{ key: "", data, sources }];
    },
  };
}

function summarize(
  slot: { state: { tickedAt?: number }; db?: ReadModelDb } | undefined,
  options: RepositoriesInstanceOptions,
  now: number,
  readPlan: (path: string) => Plan,
): { summary?: RepoDashboardResult; reason?: string } {
  if (slot === undefined || slot.db === undefined) return { reason: "the read model does not project this instance" };
  if (slot.state.tickedAt === undefined) return { reason: "the read model has not projected this instance's ledger yet" };
  const db = slot.db;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = readRepoRows(db, now);
  } catch (error) {
    return { reason: `repository rows unreadable: ${(error as Error).message}` };
  }
  const outcome = repoSummarySync({ ...options, readLedger: () => rows, readPlan }, now);
  return outcome.ok ? { summary: outcome.summary } : { reason: outcome.reason };
}

/** Absent until the first summary, stale while the last recompute failed (#7928), else fresh. */
function summarySource(instanceId: string, current: InstanceSummary): ViewSource {
  const name = `repositories:${instanceId}`;
  const asOf = current.summary?.generated_at ?? null;
  if (current.summary === undefined) return { name, asOf, state: "unavailable", reason: current.reason };
  if (current.reason) return { name, asOf, state: "stale", reason: current.reason };
  return { name, asOf, state: "fresh" };
}
