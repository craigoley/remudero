/**
 * W1-T4228 — ONE GATEWAY SERVES EVERY INSTANCE.
 *
 * One `rmd serve` process loads ONE config root and ONE plan, so before this module it could only
 * ever show the core daemon. The W1-T4227 registry already names every instance; this module reads
 * it at startup and mounts, for each live instance, a route set built from THAT instance's own state
 * root (ledger, control flags) and THAT instance's own plan, under `/v1/i/<instance>/…`.
 *
 * - The core instance (the gateway's own state) is not rebuilt: its existing routes are mounted a
 *   second time under its prefix, sharing their handlers and read caches. The unprefixed routes are
 *   untouched and stay the core instance's.
 * - Every other instance gets its OWN route objects, so its read caches are its own and one
 *   instance's slow read never holds another's.
 * - An instance whose state or plan cannot be read answers every one of its routes with a 503
 *   naming the reason — never an empty board, never another instance's data, never a boot failure.
 *
 * Inside the gateway container an instance's state root is `<stateBase>/<name>` — the mount
 * `deploy/serve-container.sh` makes from the registry's `state_dir`. Its checkout (and plan) is the
 * directory named after the repo, exactly as the daemon lays out its own state root.
 */
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { buildRecentRoute, buildStatusRoute, type BoardDeps } from "./board.js";
import { parseInstanceRegistry, type RegistryInstance } from "./instance-registry.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import {
  buildControlStatusRoute,
  buildPauseRoute,
  buildResumeRoute,
  buildStopRoute,
  sendJson,
  type ControlStatusDeps,
  type IssueCloser,
} from "./panel-actions.js";
import { loadPlan, type Plan } from "./plan.js";
import { resolveRepoLayout } from "./repo-layout.js";
import type { Route } from "./service.js";
import type { GitHub } from "./status.js";
import { buildTaskCardRoute } from "./task-card.js";

/** The instance whose state IS the gateway's own config root. */
export const CORE_INSTANCE = "core";
/** Where `deploy/serve-container.sh` mounts each non-core instance's state root. */
export const DEFAULT_INSTANCE_STATE_BASE = "/home/node/rmd-instances";

/** One instance's paths inside the gateway. */
export interface InstanceStateRoot {
  instance: string;
  /** The instance's config root: `state/` (ledger, control flags) and its checkout live under it. */
  root: string;
  ledgerPath: string;
  planPath: string;
}

export type InstanceAvailability = { ok: true } | { ok: false; reason: string };

export interface InstanceGatewayOptions {
  /** The repo-tracked registry; serve.ts defaults it to `daemonInstanceRegistryPath` of the checkout. */
  registryPath?: string;
  stateBase?: string;
  coreInstance?: string;
  readText?: (path: string) => string;
  loadPlan?: (planPath: string) => Plan;
  /** The GitHub gateway for one instance's `owner/name`; serve.ts defaults it to a batched gateway. */
  github?: (repo: string) => GitHub;
  probe?: (root: InstanceStateRoot) => Promise<InstanceAvailability>;
  issues?: IssueCloser;
  controlStatus?: Omit<ControlStatusDeps, "root" | "ledgerPath">;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Applied to each instance's raw read routes — serve.ts's per-route read cache and projection. */
  bound?: (routes: Route[], board: BoardDeps) => Route[];
}

export function instanceStateRoot(instance: RegistryInstance, stateBase: string): InstanceStateRoot {
  const root = join(stateBase, instance.name);
  const checkout = join(root, instance.repo.split("/")[1]);
  return {
    instance: instance.name,
    root,
    ledgerPath: join(root, "state", LEDGER_FILENAME),
    planPath: resolveRepoLayout(checkout).planMonolith,
  };
}

/** `/v1/status` → `/v1/i/<instance>/status`; undefined for anything outside `/v1/`. */
export function instancePath(instance: string, path: string): string | undefined {
  if (!path.startsWith("/v1/") || path.startsWith("/v1/i/")) return undefined;
  return `/v1/i/${instance}/${path.slice("/v1/".length)}`;
}

export function mountUnderInstance(routes: readonly Route[], instance: string): Route[] {
  const out: Route[] = [];
  for (const route of routes) {
    const path = instancePath(instance, route.path);
    if (path !== undefined) out.push({ ...route, path });
  }
  return out;
}

/** Both reads the instance's routes depend on, asked without blocking the event loop. */
export async function probeInstanceState(root: InstanceStateRoot): Promise<InstanceAvailability> {
  for (const [what, path] of [
    ["state directory", join(root.root, "state")],
    ["plan", root.planPath],
  ] as const) {
    try {
      await access(path);
    } catch (error) {
      return { ok: false, reason: `${what} ${path} is unreadable: ${(error as NodeJS.ErrnoException).code ?? String(error)}` };
    }
  }
  return { ok: true };
}

export function guardInstanceRoute(route: Route, instance: string, availability: () => Promise<InstanceAvailability>): Route {
  return {
    ...route,
    handler: async (req, res, ctx) => {
      const state = await availability();
      if (!state.ok) {
        sendJson(res, 503, { error: "instance_unavailable", status: "unavailable", instance, reason: state.reason });
        return;
      }
      await route.handler(req, res, ctx);
    },
  };
}

/** The route set one non-core instance answers, rooted entirely in its own state and plan. */
export function instanceRouteSet(root: InstanceStateRoot, board: BoardDeps, opts: InstanceGatewayOptions): Route[] {
  const panel = { root: root.root, ledgerPath: root.ledgerPath, issues: opts.issues ?? { close() {} } };
  const reads = [buildStatusRoute(board), buildRecentRoute(board), buildTaskCardRoute(board)];
  return [
    ...(opts.bound ? opts.bound(reads, board) : reads),
    buildControlStatusRoute({ ...panel, ...opts.controlStatus }),
    buildPauseRoute(panel),
    buildResumeRoute(panel),
    buildStopRoute(panel),
  ];
}

function registryInstances(opts: InstanceGatewayOptions): RegistryInstance[] {
  if (opts.registryPath === undefined) return [];
  let text: string;
  try {
    text = (opts.readText ?? ((p) => readFileSync(p, "utf8")))(opts.registryPath);
  } catch (error) {
    // No registry is the single-instance install: the gateway serves core alone, as before.
    opts.log?.("serve.instance_registry_absent", { path: opts.registryPath, reason: String(error) });
    return [];
  }
  try {
    return parseInstanceRegistry(text).instances.filter((i) => i.live);
  } catch (error) {
    opts.log?.("serve.instance_registry_malformed", { path: opts.registryPath, reason: String((error as Error).message) });
    return [];
  }
}

/**
 * Every `/v1/i/<instance>/…` route. `coreRoutes` are the gateway's own, already-built routes; each
 * other instance is built here from its own state root. Never throws for one instance's state.
 */
export function buildInstanceGatewayRoutes(coreRoutes: readonly Route[], opts: InstanceGatewayOptions): Route[] {
  const core = opts.coreInstance ?? CORE_INSTANCE;
  const stateBase = opts.stateBase ?? DEFAULT_INSTANCE_STATE_BASE;
  const out: Route[] = [];
  for (const instance of registryInstances(opts)) {
    if (instance.name === core) {
      out.push(...mountUnderInstance(coreRoutes, core));
      continue;
    }
    const root = instanceStateRoot(instance, stateBase);
    let plan: Plan = { tasks: [], byId: new Map() };
    let startupReason: string | undefined;
    try {
      plan = (opts.loadPlan ?? loadPlan)(root.planPath);
    } catch (error) {
      startupReason = `plan ${root.planPath} is unreadable: ${String((error as Error).message ?? error)}`;
      opts.log?.("serve.instance_unavailable", { instance: instance.name, reason: startupReason });
    }
    const github: GitHub =
      startupReason === undefined && opts.github ? opts.github(instance.repo) : { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
    const board: BoardDeps = { plan, ledgerPath: root.ledgerPath, github };
    const probe = opts.probe ?? probeInstanceState;
    const availability = (): Promise<InstanceAvailability> =>
      startupReason === undefined ? probe(root) : Promise.resolve({ ok: false, reason: startupReason });
    const routes = mountUnderInstance(instanceRouteSet(root, board, opts), instance.name);
    out.push(...routes.map((route) => guardInstanceRoute(route, instance.name, availability)));
  }
  return out;
}
