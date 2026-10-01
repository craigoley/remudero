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
import { parseInstanceRegistry, type RegistryInstance } from "./instance-registry.js";
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
  type RepoShadowFacts,
} from "./repo-dashboard-route.js";
import type { ShadowLegacy } from "./view-shadow.js";
import type { ViewSource } from "./views.js";

/** 2: each summary's `generated_at` left `data` for its `repositories:<instance>` source's `asOf`, so the ETag moves only with content. */
export const REPOSITORIES_VIEW_VERSION = 2;
export const REPOSITORIES_SOURCES_FILE = "repositories-sources.json";

/** The options each instance's summary route is built with, as serve's main thread resolved them. */
export type RepositoriesInstanceOptions = Pick<
  RepoDashboardOptions,
  "root" | "instanceRepository" | "repoRegistryPath" | "ownInstance" | "controlRoot" | "incidentsDir" | "ledgerPath" | "planPath"
>;

export interface RepositoriesSources {
  instances: Array<{ instanceId: string; options: RepositoriesInstanceOptions }>;
}

/** The console's RepoHealthStatus: how far a repository's figures can be trusted, worst first in {@link REPOSITORY_STATE_RANK}. */
export type RepositoryState = "verified" | "stale" | "unknown" | "unavailable";

export const REPOSITORY_STATE_RANK: Record<RepositoryState, number> = { unavailable: 0, stale: 1, unknown: 2, verified: 3 };

export interface RepositoriesProject {
  project: string;
  repos: Array<{ id: string; reponame: string; instanceId: string; state: RepositoryState }>;
  /** The first repository holding the project's worst state: where the operator should look. */
  worst: { state: RepositoryState; repoId: string; repoName: string };
}

/** An instance's summary route body without its clock stamp, which the instance's source carries instead. */
export type RepositoriesSummary = Omit<RepoDashboardResult, "generated_at">;

/** Drops the summary's `generated_at`: a clock stamp inside `data` would move the view's ETag on every recompute. */
export function unstampedSummary(summary: RepoDashboardResult): RepositoriesSummary {
  const { generated_at: _stamp, ...rest } = summary;
  return rest;
}

export interface RepositoriesData {
  instances: Array<{ instanceId: string; summary?: RepositoriesSummary; reason?: string }>;
  /** The console's groupRepoProjects, precomputed: registry projects in first-seen order. */
  projects: RepositoriesProject[];
  /** Why every repository is its own project: the registry naming projects could not be read. */
  projectsReason?: string;
  reason?: string;
}

/** Groups repositories by project in first-seen order and names each project's worst, as the console's /repos page does. */
export function groupRepositoryProjects(repos: ReadonlyArray<RepositoriesProject["repos"][number] & { project: string }>): RepositoriesProject[] {
  const byProject = new Map<string, RepositoriesProject["repos"]>();
  const seen = new Set<string>();
  for (const { project, ...repo } of repos) {
    if (seen.has(repo.id.toLowerCase())) continue;
    seen.add(repo.id.toLowerCase());
    byProject.set(project, [...(byProject.get(project) ?? []), repo]);
  }
  return [...byProject].map(([project, members]) => {
    const worst = members.reduce((a, b) => (REPOSITORY_STATE_RANK[b.state] < REPOSITORY_STATE_RANK[a.state] ? b : a));
    return { project, repos: members, worst: { state: worst.state, repoId: worst.id, repoName: worst.reponame } };
  });
}

function readRegistry(path: string): { instances: RegistryInstance[] } | { reason: string } {
  try {
    return { instances: parseInstanceRegistry(readFileSync(path, "utf8")).instances.filter((i) => i.live) };
  } catch (error) {
    return { reason: `the instance registry could not be parsed: ${(error as Error).message}` };
  }
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
  /** Each own repository's shadow facts, by repository id. */
  shadow?: Record<string, RepoShadowFacts>;
}

type ShadowFactsByInstance = Record<string, Record<string, RepoShadowFacts>>;

const canonicalJson = (value: unknown): string => JSON.stringify(value);

/**
 * Pairs each side's shadow facts under their diff paths into `RepositoriesData`
 * (`instances[instanceId=…].summary.repos[id=…].<field>`). `errorrate` and `cost_7d` are derived from the
 * counts and sum they are computed from; a usage window's `percent_used` from the reading it is, `observed_at`.
 * `condition` and `reasons` are derived from the run counts only when
 * legacy's own signals, given the view's run counts, reproduce the view's exactly; otherwise they stay `real`.
 */
export function repositoriesShadowPairing(legacyFacts: ShadowFactsByInstance, viewFacts: ShadowFactsByInstance, view: RepositoriesData | undefined): Required<Pick<ShadowLegacy, "members" | "sums" | "latest" | "derived">> {
  const members: Record<string, { legacy: string[]; view: string[] }> = {};
  const sums: Record<string, { legacy: Array<[string, number]>; view: Array<[string, number]>; precision?: number }> = {};
  const latest: Record<string, { legacy: string | null; view: string | null }> = {};
  const derived: Record<string, string[]> = {};
  for (const instanceId of new Set([...Object.keys(legacyFacts), ...Object.keys(viewFacts)])) {
    for (const repoId of new Set([...Object.keys(legacyFacts[instanceId] ?? {}), ...Object.keys(viewFacts[instanceId] ?? {})])) {
      const l = legacyFacts[instanceId]?.[repoId];
      const v = viewFacts[instanceId]?.[repoId];
      const base = `instances[instanceId=${instanceId}].summary.repos[id=${repoId}]`;
      for (const k of new Set([...Object.keys(l?.counts ?? {}), ...Object.keys(v?.counts ?? {})])) members[`${base}.${k}`] = { legacy: l?.counts[k] ?? [], view: v?.counts[k] ?? [] };
      for (const k of new Set([...Object.keys(l?.sums ?? {}), ...Object.keys(v?.sums ?? {})])) {
        const precision = (l ?? v)!.sums[k]?.precision;
        sums[`${base}.${k}`] = { legacy: l?.sums[k]?.rows ?? [], view: v?.sums[k]?.rows ?? [], ...(precision !== undefined ? { precision } : {}) };
      }
      latest[`${base}.health.last_run`] = { legacy: l?.lastRun ?? null, view: v?.lastRun ?? null };
      const runs = [`${base}.health.runs7d.succeeded`, `${base}.health.runs7d.failed`];
      derived[`${base}.health.errorrate`] = runs;
      derived[`${base}.telemetry.cost_7d`] = [`${base}.telemetry.cash_usd_7d`];
      const shown = view?.instances.find((i) => i.instanceId === instanceId)?.summary?.repos.find((r) => r.id === repoId)?.health;
      const again = shown?.runs7d && l?.condition ? l.condition(shown.runs7d) : undefined;
      if (again && again.condition === shown!.condition && canonicalJson(again.reasons) === canonicalJson(shown!.reasons)) {
        derived[`${base}.health.condition`] = runs;
        derived[`${base}.health.reasons`] = runs;
      }
    }
  }
  for (const { instanceId, summary } of view?.instances ?? []) {
    for (const repo of summary?.repos ?? []) {
      repo.telemetry?.subscription?.windows.forEach((_, i) => {
        const at = `instances[instanceId=${instanceId}].summary.repos[id=${repo.id}].telemetry.subscription.windows[${i}]`;
        derived[`${at}.percent_used`] = [`${at}.observed_at`];
      });
    }
  }
  return { members, sums, latest, derived };
}

/** `repositories`' legacy side: each instance's #7926 summary over its own ledger read, with its shadow facts. */
export function legacyRepositories(sourcesPath: string, nowMs: number): ShadowLegacy & { facts: ShadowFactsByInstance } | undefined {
  let published: RepositoriesSources;
  try {
    published = JSON.parse(readFileSync(sourcesPath, "utf8")) as RepositoriesSources;
  } catch {
    // deliberate: no published sources means no legacy side to compare; the sample is skipped, not a diff.
    return undefined;
  }
  const facts: ShadowFactsByInstance = {};
  const instances: RepositoriesData["instances"] = published.instances.map(({ instanceId, options }) => {
    const outcome = repoSummarySync({ ...options, shadowMembers: true }, nowMs);
    if (!outcome.ok) return { instanceId, reason: outcome.reason };
    facts[instanceId] = outcome.shadow ?? {};
    return { instanceId, summary: unstampedSummary(outcome.summary) };
  });
  const data: RepositoriesData = { instances, ...repositoriesPortfolio(published, { instances }) };
  return { data, asOfMs: nowMs, facts };
}

/** The plan each summary reads, memoized on the plan file's and `tasks.d`'s mtimes; `fresh` says whether a read would hit the memo. */
function planReader(): { read: (path: string) => Plan; fresh: (path: string) => boolean } {
  const memo = new Map<string, { stamp: string; plan: Plan }>();
  const stampOf = (path: string): string => [path, join(dirname(path), "tasks.d")].map((p) => {
    try {
      return String(statSync(p).mtimeMs);
    } catch {
      // deliberate: an absent tasks.d is part of the stamp; loadPlan reports an unreadable plan itself.
      return "absent";
    }
  }).join("|");
  return {
    read: (path) => {
      const stamp = stampOf(path);
      const hit = memo.get(path);
      if (hit?.stamp === stamp) return hit.plan;
      const plan = loadPlan(path);
      memo.set(path, { stamp, plan });
      return plan;
    },
    fresh: (path) => memo.get(path)?.stamp === stampOf(path),
  };
}

/** `repositories` materialized by the read-model worker; `ledgerSource` is the worker's own, passed in. */
export function createRepositoriesReadModelView<S extends { instance: string; tickedAt?: number; generation: number }>(ledgerSource: (state: S, now: number) => ViewSource): {
  name: string;
  version: number;
  prepare(ctx: { now: number; instances: ReadonlyArray<{ state: S; db?: ReadModelDb }> }, more: () => boolean): boolean;
  materialize(ctx: { now: number; instances: ReadonlyArray<{ state: S; db?: ReadModelDb }> }): Array<{ key: string; data: RepositoriesData; sources: ViewSource[] }>;
  legacy(key: string, now: number, data: unknown): ShadowLegacy | undefined;
} {
  const sourcesFile = readOnMtimeChange(readSources);
  const registryFile = readOnMtimeChange(readRegistry);
  const computed = new Map<string, InstanceSummary>();
  const plans = planReader();
  let sourcesPath: string | undefined;
  type Slot = { state: S; db?: ReadModelDb } | undefined;
  /** Whether an instance's summary is recomputed now: #7926's cadence, 30 s after an input moves, else 60 s. */
  const due = (instanceId: string, slot: Slot, sourcesMtimeMs: number, now: number): boolean => {
    const prior = computed.get(instanceId);
    if (!prior) return true;
    const ageMs = now - prior.atMs;
    const moved = prior.generation !== (slot?.state.generation ?? -1) || prior.sourcesMtimeMs !== sourcesMtimeMs;
    return ageMs >= REPO_TELEMETRY_CACHE_TTL_MS || (moved && ageMs >= REPO_TELEMETRY_MIN_AGE_MS);
  };
  const refresh = (instanceId: string, slot: Slot, options: RepositoriesInstanceOptions, sourcesMtimeMs: number, now: number): void => {
    const prior = computed.get(instanceId);
    const generation = slot?.state.generation ?? -1;
    const next = summarize(slot, options, now, plans.read);
    computed.set(instanceId, next.summary
      ? { atMs: now, generation, sourcesMtimeMs, summary: next.summary, ...(next.shadow ? { shadow: next.shadow } : {}) }
      : { atMs: now, generation, sourcesMtimeMs, reason: next.reason, ...(prior?.summary ? { summary: prior.summary, ...(prior.shadow ? { shadow: prior.shadow } : {}) } : {}) });
  };
  const published = (instances: ReadonlyArray<{ db?: ReadModelDb }>): { path: string; sources?: RepositoriesSources } | undefined => {
    const dbPath = instances.find((slot) => slot.db)?.db?.path;
    if (dbPath === undefined) return undefined;
    sourcesPath = join(dirname(dbPath), REPOSITORIES_SOURCES_FILE);
    return { path: sourcesPath, sources: sourcesFile(sourcesPath) };
  };
  return {
    name: "repositories",
    version: REPOSITORIES_VIEW_VERSION,
    /** The shadow comparator's legacy side, its facts paired with this view's own summaries' facts. */
    legacy(_key, now, data) {
      const legacy = sourcesPath === undefined ? undefined : legacyRepositories(sourcesPath, now);
      if (!legacy) return undefined;
      const mine = Object.fromEntries([...computed].map(([instanceId, s]) => [instanceId, s.shadow ?? {}]));
      return { data: legacy.data, asOfMs: legacy.asOfMs, ...repositoriesShadowPairing(legacy.facts, mine, data as RepositoriesData) };
    },
    /** Each due instance's plan read and summary, one step each, so a cold build is never one unit. */
    prepare: ({ now, instances }, more) => {
      const at = published(instances);
      if (at?.sources === undefined) return true;
      const sourcesMtimeMs = statSync(at.path).mtimeMs;
      for (const { instanceId, options } of at.sources.instances) {
        const slot = instances.find((candidate) => candidate.state.instance === instanceId);
        if (!due(instanceId, slot, sourcesMtimeMs, now)) continue;
        const planPath = options.planPath ?? join(options.root, "plan", "tasks.yaml");
        if (slot?.db !== undefined && slot.state.tickedAt !== undefined && !plans.fresh(planPath)) {
          if (!more()) return false;
          try {
            plans.read(planPath);
          } catch {
            // deliberate: the summary step reads the plan again and turns this failure into the instance's reason.
          }
        }
        if (!more()) return false;
        refresh(instanceId, slot, options, sourcesMtimeMs, now);
      }
      return true;
    },
    materialize: ({ now, instances }) => {
      const at = published(instances);
      if (at === undefined) return [];
      if (at.sources === undefined) return [{ key: "", data: { instances: [], projects: [], reason: "serve has not published the repository sources yet" }, sources: [] }];
      const sourcesMtimeMs = statSync(at.path).mtimeMs;
      const sources: ViewSource[] = [];
      const data: RepositoriesData = { instances: [], projects: [] };
      for (const { instanceId, options } of at.sources.instances) {
        const slot = instances.find((candidate) => candidate.state.instance === instanceId);
        if (slot) sources.push(ledgerSource(slot.state, now));
        if (due(instanceId, slot, sourcesMtimeMs, now)) refresh(instanceId, slot, options, sourcesMtimeMs, now);
        const current = computed.get(instanceId)!;
        sources.push(summarySource(instanceId, current));
        data.instances.push({ instanceId, ...(current.summary ? { summary: unstampedSummary(current.summary) } : {}), ...(current.reason ? { reason: current.reason } : {}) });
      }
      Object.assign(data, repositoriesPortfolio(at.sources, data, registryFile));
      return [{ key: "", data, sources }];
    },
  };
}

/** The registry core's summary route reads names each instance's project and repository. */
export function repositoriesPortfolio(
  published: RepositoriesSources,
  data: Pick<RepositoriesData, "instances">,
  registryFile: (path: string) => ReturnType<typeof readRegistry> | undefined = readOnMtimeChange(readRegistry),
): Pick<RepositoriesData, "projects" | "projectsReason"> {
  const path = published.instances.find((i) => i.options.repoRegistryPath)?.options.repoRegistryPath;
  const registry = path === undefined ? { reason: "no instance names a registry" } : registryFile(path) ?? { reason: `the instance registry ${path} is unreadable` };
  const rows = "instances" in registry ? registry.instances : [];
  const projectOf = new Map(rows.map((i) => [i.repo.toLowerCase(), i.project]));
  const repoOf = new Map(rows.map((i) => [i.name, i.repo]));
  const repos = data.instances.flatMap(({ instanceId, summary, reason }) => {
    const entries = summary?.repos.map((r) => ({ id: r.id, reponame: r.reponame, instanceId,
      state: (reason ? "stale" : r.health.status === "verified" ? "verified" : "unknown") as RepositoryState }));
    if (entries && (entries.length > 0 || summary!.registry?.state !== "unavailable")) return entries;
    const options = published.instances.find((i) => i.instanceId === instanceId)!.options;
    const id = options.instanceRepository ? `${options.instanceRepository.owner}/${options.instanceRepository.repo}` : repoOf.get(instanceId) ?? instanceId;
    return [{ id, reponame: id.split("/").pop()!, instanceId, state: "unavailable" as const }];
  });
  const projects = groupRepositoryProjects(repos.map((r) => ({ ...r, project: projectOf.get(r.id.toLowerCase()) ?? r.reponame })));
  return { projects, ...("reason" in registry ? { projectsReason: registry.reason } : {}) };
}

function summarize(
  slot: { state: { tickedAt?: number }; db?: ReadModelDb } | undefined,
  options: RepositoriesInstanceOptions,
  now: number,
  readPlan: (path: string) => Plan,
): { summary?: RepoDashboardResult; reason?: string; shadow?: Record<string, RepoShadowFacts> } {
  if (slot === undefined || slot.db === undefined) return { reason: "the read model does not project this instance" };
  if (slot.state.tickedAt === undefined) return { reason: "the read model has not projected this instance's ledger yet" };
  const db = slot.db;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = readRepoRows(db, now);
  } catch (error) {
    return { reason: `repository rows unreadable: ${(error as Error).message}` };
  }
  const outcome = repoSummarySync({ ...options, readLedger: () => rows, readPlan, shadowMembers: true }, now);
  return outcome.ok ? { summary: outcome.summary, ...(outcome.shadow ? { shadow: outcome.shadow } : {}) } : { reason: outcome.reason };
}

/** Absent until the first summary, stale while the last recompute failed (#7928), else fresh. */
function summarySource(instanceId: string, current: InstanceSummary): ViewSource {
  const name = `repositories:${instanceId}`;
  const asOf = current.summary?.generated_at ?? null;
  if (current.summary === undefined) return { name, asOf, state: "unavailable", reason: current.reason };
  if (current.reason) return { name, asOf, state: "stale", reason: current.reason };
  return { name, asOf, state: "fresh" };
}
