/**
 * `instances`: ONE instance list, saying what this serve actually serves (arch Phase 4 design §4, P4-T17,
 * W1-T5056).
 *
 * Core kept three lists (the repo registry, the host registry, the mount set fixed when the serve
 * container was created) and the console three more. None said which instances serve mounts, so a
 * registered but unmounted instance stayed invisible until a read 404'd. This view joins them, one
 * entry per instance any list names:
 * - `registered`, `project`, `repo` and `mode` come from the repo registry;
 * - `served` is "this serve projects it and its state dir is mounted";
 * - `liveness` is a band over the instance's newest projected `daemon.*` row;
 * - `readModel.lease` comes from the worker's projector state;
 * - `capabilities` names the views and writes serve answers for it.
 * `drift` names every disagreement: host-only and repo-only names, registered but unmounted, and
 * mounted but unregistered.
 *
 * `GET /v1/registry` answers as {@link registryFromInstances}, a projection of this body, once the
 * view serves. Until then it keeps its own computation, {@link legacyRegistryBody}, which is also this
 * view's shadow side. `data` carries no clock: `liveness.since` is a row's own time, stable while down.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fixedClock } from "./clock.js";
import { QUIET_PULSE_BOUND_MS, STALE_HEARTBEAT_POLL_MULTIPLE } from "./fleet-liveness.js";
import {
  InstanceRegistryError,
  parseInstanceNames,
  parseInstanceRegistry,
  projectRegistry,
  registryDrift,
  type InstanceRegistry,
  type RegistryDrift,
  type RegistryProjection,
} from "./instance-registry.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./poll-interval.js";
import type { ReadModelDb } from "./read-model-db.js";
import type { ShadowLegacy } from "./view-shadow.js";
import type { ViewSource } from "./views.js";

export const INSTANCES_VIEW_NAME = "instances";
export const INSTANCES_VIEW_VERSION = 1;
/** The views serve answers for every instance it projects. */
export const INSTANCE_VIEWS: readonly string[] = ["now", "repositories", "read-model", INSTANCES_VIEW_NAME];
/** The writes each served instance answers under its prefix (`instanceRouteSet`'s control routes). */
export const INSTANCE_WRITES: readonly string[] = ["control/pause", "control/resume", "control/stop"];
/** What only core answers: no `/v1/i/<x>` copy exists, so a console reads core's for every instance. */
export const CORE_ONLY_ROUTES: readonly string[] = ["analytics", "feedback", "inbox", "nav-badge"];
/** PRIMARY CONTROL: DOWN after the stale-heartbeat bound, or a quiet-mode pulse's, whichever is longer (fleet-liveness.ts). */
export const INSTANCE_LIVENESS_BOUND_MS = Math.max(STALE_HEARTBEAT_POLL_MULTIPLE * DEFAULT_POLL_INTERVAL_MS, QUIET_PULSE_BOUND_MS);

export type HostRegistryState = "in_sync" | "drifted" | "unreadable" | "malformed";

export interface InstanceEntry {
  id: string;
  /** In the repo registry as a live row. */
  registered: boolean;
  project?: string;
  repo?: string;
  mode?: "live" | "shadow";
  prefix: string;
  /** Projected by this serve, with its state dir mounted; false is "recreate serve to mount it". */
  served: boolean;
  /** `unknown` until its projector has read a `daemon.*` row; `since` is the newest one's time while down. */
  liveness: { state: "up" | "down" | "unknown"; since?: string };
  readModel: { lease: "held" | "elsewhere" | "none" };
  capabilities: { views: string[]; writes: string[]; coreOnly?: string[] };
}

export interface InstancesData {
  instances: InstanceEntry[];
  hostRegistry: HostRegistryState;
  drift?: { hostOnly: string[]; repoOnly: string[]; unmounted: string[]; unregistered: string[] };
  /** The repo registry's refusal code when it could not be read; `instances` then lists the mounts only. */
  registryError?: string;
}

/** A registry file as read: its text, or the path-free code it failed with. */
export type RegistryRead = { ok: true; text: string } | { ok: false; code: string };

/** `GET /v1/registry`'s answer, less `generatedAt`, which the route stamps. */
export type RegistryRouteAnswer =
  | { status: 200; body: RegistryProjection & { source: "repo"; hostRegistry: HostRegistryState; drift?: RegistryDrift } }
  | { status: 503; body: { error: "registry_unavailable"; reason: string } };

/** Parses the repo registry, turning a refusal into its stable code (fs errors embed paths, so never their text). */
export function parseRegistryRead(read: RegistryRead): { registry: InstanceRegistry } | { code: string } {
  if (!read.ok) return { code: read.code };
  try {
    return { registry: parseInstanceRegistry(read.text) };
  } catch (error) {
    // deliberate: the refusal's stable code is the answer; its message names lines, not paths, but the code is the contract.
    return { code: error instanceof InstanceRegistryError ? error.code : "unreadable" };
  }
}

/** The host copy compared with the repo registry's live names; an unreadable or malformed one is a note. */
export function hostRegistryDrift(liveNames: readonly string[], hostText: string | undefined): { hostRegistry: HostRegistryState; drift?: RegistryDrift } {
  if (hostText === undefined) return { hostRegistry: "unreadable" };
  let hostNames: string[];
  try {
    hostNames = parseInstanceNames(hostText);
  } catch {
    // deliberate: a host copy outside the shell grammar cannot be compared; the state says so.
    return { hostRegistry: "malformed" };
  }
  const drift = registryDrift(liveNames, hostNames);
  return drift ? { hostRegistry: "drifted", drift } : { hostRegistry: "in_sync" };
}

/** The legacy `GET /v1/registry` computation over the two files as read. */
export function legacyRegistryBody(repo: RegistryRead, hostText: string | undefined): RegistryRouteAnswer {
  const parsed = parseRegistryRead(repo);
  if ("code" in parsed) return { status: 503, body: { error: "registry_unavailable", reason: parsed.code } };
  const { hostRegistry, drift } = hostRegistryDrift(parsed.registry.instances.filter((i) => i.live).map((i) => i.name), hostText);
  return { status: 200, body: { ...projectRegistry(parsed.registry), source: "repo", hostRegistry, ...(drift ? { drift } : {}) } };
}

/** `GET /v1/registry` as a projection of the view's body: the same answer, from no file read. */
export function registryFromInstances(data: InstancesData): RegistryRouteAnswer {
  if (data.registryError !== undefined) return { status: 503, body: { error: "registry_unavailable", reason: data.registryError } };
  const instances = data.instances.filter((i) => i.registered).map((i) => ({ name: i.id, project: i.project ?? "", repo: i.repo ?? "", live: true }));
  const drift = data.drift && (data.drift.hostOnly.length > 0 || data.drift.repoOnly.length > 0) ? { hostOnly: data.drift.hostOnly, repoOnly: data.drift.repoOnly } : undefined;
  return { status: 200, body: { ...projectRegistry({ instances }), source: "repo", hostRegistry: data.hostRegistry, ...(drift ? { drift } : {}) } };
}

function readFile(path: string | undefined): RegistryRead & { mtimeMs?: number } {
  if (path === undefined) return { ok: false, code: "unreadable" };
  try {
    const mtimeMs = statSync(path).mtimeMs;
    return { ok: true, text: readFileSync(path, "utf8"), mtimeMs };
  } catch {
    // deliberate: an absent registry is a single-instance install; the code says so without the path.
    return { ok: false, code: "unreadable" };
  }
}

/** The newest projected `daemon.*` row judged against {@link INSTANCE_LIVENESS_BOUND_MS}. */
export function instanceLiveness(db: ReadModelDb | undefined, now: number): InstanceEntry["liveness"] {
  if (db === undefined) return { state: "unknown" };
  let lastMs: number | undefined;
  try {
    const beat = db.prepare("SELECT last_ms FROM instance_heartbeat WHERE k = 'daemon'").get();
    lastMs = beat ? Number(beat.last_ms) : undefined;
  } catch {
    // deliberate: a store without the heartbeat table has projected no daemon row; that is unknown, not down.
    return { state: "unknown" };
  }
  if (lastMs === undefined) return { state: "unknown" };
  return now - lastMs > INSTANCE_LIVENESS_BOUND_MS ? { state: "down", since: fixedClock(lastMs).iso() } : { state: "up" };
}

interface ProjectedState {
  instance: string;
  lease: "held" | "elsewhere" | "none";
}

export interface InstancesViewOptions<S extends ProjectedState> {
  /** Every instance the worker projects, with the state dir its ledger lives in; the first is core. */
  instances: ReadonlyArray<{ name: string; ledgerDir: string }>;
  /** The repo-tracked registry `GET /v1/registry` answers from. */
  repoPath?: string;
  /** The fleet host's copy, compared against it. */
  hostPath?: string;
  ledgerSource: (state: S, now: number) => ViewSource;
  /** Whether a state dir is mounted; `existsSync` by default. */
  mounted?: (dir: string) => boolean;
}

/** `instances`, materialized by the read-model worker; `ledgerSource` is the worker's own, passed in. */
export function createInstancesView<S extends ProjectedState>(opts: InstancesViewOptions<S>): {
  name: string;
  version: number;
  materialize(ctx: { now: number; instances: ReadonlyArray<{ state: S; db?: ReadModelDb }> }): Array<{ key: string; data: InstancesData; sources: ViewSource[] }>;
  legacy(key: string, now: number, data: unknown): ShadowLegacy | undefined;
} {
  const mounted = opts.mounted ?? existsSync;
  const core = opts.instances[0]?.name;
  const registrySource = (read: ReturnType<typeof readFile>, parsed: ReturnType<typeof parseRegistryRead>): ViewSource => {
    const name = "registry:repo";
    if ("code" in parsed) return { name, asOf: null, state: "unavailable", reason: `the instance registry is ${read.ok ? "malformed" : "unreadable"}: ${parsed.code}` };
    return { name, asOf: fixedClock(read.mtimeMs ?? 0).iso(), state: "fresh" };
  };
  const hostText = (): string | undefined => {
    const host = readFile(opts.hostPath);
    return host.ok ? host.text : undefined;
  };
  return {
    name: INSTANCES_VIEW_NAME,
    version: INSTANCES_VIEW_VERSION,
    materialize: ({ now, instances }) => {
      const read = readFile(opts.repoPath);
      const parsed = parseRegistryRead(read);
      const live = "registry" in parsed ? parsed.registry.instances.filter((i) => i.live) : [];
      const { hostRegistry, drift } = hostRegistryDrift(live.map((i) => i.name), hostText());
      const projected = new Map(opts.instances.map((i) => [i.name, i]));
      const entry = (id: string, registered: (typeof live)[number] | undefined): InstanceEntry => {
        const slot = instances.find((candidate) => candidate.state.instance === id);
        const dir = projected.get(id)?.ledgerDir;
        const served = slot !== undefined && dir !== undefined && mounted(dir);
        return {
          id, registered: registered !== undefined,
          ...(registered ? { project: registered.project, repo: registered.repo, mode: registered.mode ?? "live" } : {}),
          prefix: `/v1/i/${id}`, served,
          liveness: served ? instanceLiveness(slot.db, now) : { state: "unknown" },
          readModel: { lease: slot?.state.lease ?? "none" },
          capabilities: served ? { views: [...INSTANCE_VIEWS], writes: [...INSTANCE_WRITES], ...(id === core ? { coreOnly: [...CORE_ONLY_ROUTES] } : {}) } : { views: [], writes: [] },
        };
      };
      const entries = live.map((i) => entry(i.name, i));
      const named = new Set(entries.map((e) => e.id));
      for (const { name } of opts.instances) if (!named.has(name)) (named.add(name), entries.push(entry(name, undefined)));
      for (const name of drift?.hostOnly ?? []) if (!named.has(name)) (named.add(name), entries.push(entry(name, undefined)));
      const unmounted = entries.filter((e) => e.registered && !e.served).map((e) => e.id);
      const unregistered = entries.filter((e) => !e.registered && e.served).map((e) => e.id);
      const hostOnly = drift?.hostOnly ?? [];
      const repoOnly = drift?.repoOnly ?? [];
      const data: InstancesData = {
        instances: entries, hostRegistry,
        ...(hostOnly.length + repoOnly.length + unmounted.length + unregistered.length > 0 ? { drift: { hostOnly, repoOnly, unmounted, unregistered } } : {}),
        ...("code" in parsed ? { registryError: parsed.code } : {}),
      };
      return [{ key: "", data, sources: [registrySource(read, parsed), ...instances.map(({ state }) => opts.ledgerSource(state, now))] }];
    },
    /** The shadow side: the legacy registry route's fields over the view's own, so only what `/v1/registry` answers can differ. */
    legacy: (_key, now, data) => {
      const view = data as InstancesData;
      const unregistered = view.instances.filter((i) => !i.registered);
      const legacy = legacyRegistryBody(readFile(opts.repoPath), hostText());
      if (legacy.status === 503) return { data: { instances: unregistered, hostRegistry: view.hostRegistry, ...(view.drift ? { drift: view.drift } : {}), registryError: legacy.body.reason }, asOfMs: now };
      const byId = new Map(view.instances.map((i) => [i.id, i]));
      const registered = legacy.body.projects.flatMap((p) => p.repos.flatMap((r) => r.instances.map((i): InstanceEntry => {
        const base = byId.get(i.name) ?? { id: i.name, prefix: i.prefix, served: false, liveness: { state: "unknown" }, readModel: { lease: "none" }, capabilities: { views: [], writes: [] } };
        return { ...base, id: i.name, registered: true, project: p.id, repo: r.repo, prefix: i.prefix };
      })));
      const drift = { hostOnly: legacy.body.drift?.hostOnly ?? [], repoOnly: legacy.body.drift?.repoOnly ?? [], unmounted: view.drift?.unmounted ?? [], unregistered: view.drift?.unregistered ?? [] };
      const drifted = drift.hostOnly.length + drift.repoOnly.length + drift.unmounted.length + drift.unregistered.length > 0;
      return { data: { instances: [...registered, ...unregistered], hostRegistry: legacy.body.hostRegistry, ...(drifted ? { drift } : {}) }, asOfMs: now };
    },
  };
}
