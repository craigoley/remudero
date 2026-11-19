/**
 * W1-T12950 — one start for the GitHub App installation budget, used by the daemon, a run child and
 * serve. Each of them reads with the installation token, so each takes a share of what is left and
 * keeps the write reserve. One function reads the registry, counts the consumers and writes the
 * `github.budget.configured` row, so the three roles cannot drift apart.
 *
 * INVARIANT writes-keep-their-reserve: this module only sets the read budget; writes never ask it.
 * INVARIANT no-budget-when-unconfigured: with no installation id or no readable registry the role sets
 * no budget, reads as before, and its row says why.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { systemClock, type Clock } from "./clock.js";
import { GH_APP_INSTALLATION_ID_ENV } from "./github-app.js";
import { createInstallationBudget, createInstallationBudgetState } from "./github-installation-budget.js";
import { configureGithubInstallationBudget } from "./github-transport.js";
import { DEFAULT_HOST_INSTANCE_REGISTRY_PATH, installationConsumers, registryInstanceForRepo } from "./instance-registry.js";
import { runtimeInstanceRegistryPrivateFile, runtimeInstanceRegistryText } from "./instance-registry-selection.js";

const GITHUB_BUDGET_CONFIGURED_STEP = "github.budget.configured";

/** The daemon sets this in a run child's environment: the host worker budget that splits the run-child share. */
export const INSTALLATION_SHARE_DIVISOR_ENV = "RMD_INSTALLATION_SHARE_DIVISOR";

/**
 * W1-T13179 — the daemon sets these in a run child's environment beside {@link INSTALLATION_SHARE_DIVISOR_ENV}:
 * the registry file the daemon read at its start, whether that file names no installation IDs (the checkout
 * copy), and the daemon's poll interval as the child's wait bound. A run child reads only that file; it never
 * derives a registry path from its config root.
 */
export const INSTALLATION_REGISTRY_PATH_ENV = "RMD_INSTALLATION_REGISTRY_PATH";
export const INSTALLATION_REGISTRY_OMITS_IDS_ENV = "RMD_INSTALLATION_REGISTRY_OMITS_IDS";
/**
 * PRIMARY CONTROL: the env name that carries the daemon's poll interval, the bound a run child's read normally
 * waits under. {@link RUN_CHILD_INSTALLATION_MAX_WAIT_MS} is its backstop when the daemon sets no value.
 */
export const INSTALLATION_MAX_WAIT_MS_ENV = "RMD_INSTALLATION_MAX_WAIT_MS";

/**
 * BACKSTOP: the longest a run child's read waits for the installation reset when the daemon gave it no poll
 * interval. A read whose reset is further away stands down at once and does not wait for the hourly reset.
 */
export const RUN_CHILD_INSTALLATION_MAX_WAIT_MS = 60_000;

/** `path` is the file read when `source` is not a path (a selected registry). */
type InstallationRegistryRead = { text: string; source: string; path?: string; omitsInstallationIds?: boolean };

/** What the daemon read at its start, for the run children it spawns. Empty until the daemon reads a registry. */
let daemonHandOver: Record<string, string> = {};

/**
 * W1-T12553: use the selected registry or the host copy; an unreadable host must reach startup's log.
 * W1-T12670: only a missing host file falls back to the checkout's copy, which names no installation IDs.
 */
export function daemonInstallationRegistry(repoRoot: string): InstallationRegistryRead | undefined {
  const selected = runtimeInstanceRegistryText();
  if (selected !== undefined) {
    const path = runtimeInstanceRegistryPrivateFile();
    return { text: selected, source: "selected", ...(path === undefined ? {} : { path }) };
  }
  try {
    return { text: readFileSync(DEFAULT_HOST_INSTANCE_REGISTRY_PATH, "utf8"), source: DEFAULT_HOST_INSTANCE_REGISTRY_PATH };
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw err;
  }
  const checkout = join(repoRoot, ".remudero", "daemon-instances.yaml");
  return { text: readFileSync(checkout, "utf8"), source: checkout, omitsInstallationIds: true };
}

/**
 * W1-T13179: the environment the daemon gives each run child it spawns: the registry file it read at its start
 * and its wait bound. Empty entries are left out, so a child of a daemon that read no registry says why.
 */
export function runChildInstallationEnv(): Record<string, string> {
  return { ...daemonHandOver };
}

/** The run child's wait bound: the daemon's poll interval from its environment, else the BACKSTOP. */
function runChildMaxWaitMs(env: NodeJS.ProcessEnv): number {
  const raw = env[INSTALLATION_MAX_WAIT_MS_ENV]?.trim();
  const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : RUN_CHILD_INSTALLATION_MAX_WAIT_MS;
}

/**
 * W1-T13179 — a run child's start: it reads the registry file its daemon read (named in its environment),
 * never one under its config root, and its reads wait no longer than a finite bound.
 * INVARIANT no-budget-when-unconfigured: with no path in the environment, or a path it cannot read, the
 * child sets no budget, reads as before, and its row names the path and the error.
 */
export function startRunChildInstallationBudget(opts: {
  env: NodeJS.ProcessEnv;
  log: (step: string, extra?: Record<string, unknown>) => void;
  clock?: Clock;
}): void {
  const { env } = opts;
  const path = env[INSTALLATION_REGISTRY_PATH_ENV]?.trim() || undefined;
  startProcessInstallationBudget({
    role: "run_child", env, log: opts.log, clock: opts.clock, maxWaitMs: runChildMaxWaitMs(env),
    registryPath: path ?? null,
    readRegistry: () => path === undefined ? undefined : {
      text: readFileSync(path, "utf8"), source: path, ...(env[INSTALLATION_REGISTRY_OMITS_IDS_ENV] === "1" ? { omitsInstallationIds: true } : {}),
    },
  });
}

/** A whole number of 1 or more, else undefined. */
function shareDivisorOf(raw: string | undefined): number | undefined {
  const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * Give this process its share of the installation. Every pacer in the process reads the budget set here.
 * The daemon shares its budget state with its read worker thread; a run child and serve have no worker
 * to share with. A run child's allowance is its run-child share divided by the host worker budget in
 * {@link INSTALLATION_SHARE_DIVISOR_ENV}; with no divisor it divides by 1 and the row says divisor_missing.
 * W1-T13786: the registry's consumers, before that divisor, are the instances that set the secondary spacing.
 */
export function startProcessInstallationBudget(opts: {
  role: "daemon" | "run_child" | "serve";
  readRegistry: () => InstallationRegistryRead | undefined;
  env: NodeJS.ProcessEnv;
  log: (step: string, extra?: Record<string, unknown>) => void;
  clock?: Clock;
  targetRepo?: string;
  maxWaitMs?: number;
  /** A run child's registry file from its environment, named on its unconfigured rows; null when the environment names none. */
  registryPath?: string | null;
}): void {
  const { role, env, log, targetRepo, maxWaitMs, registryPath } = opts;
  if (role === "daemon") daemonHandOver = maxWaitMs === undefined ? {} : { [INSTALLATION_MAX_WAIT_MS_ENV]: String(maxWaitMs) };
  const pathField = registryPath === undefined ? {} : { registry_path: registryPath ?? `${INSTALLATION_REGISTRY_PATH_ENV} unset` };
  const installationId = env[GH_APP_INSTALLATION_ID_ENV]?.trim();
  const named = env.RMD_INSTANCE_NAME?.trim();
  let instance = named || "unknown";
  let instanceReason = "no_registry";
  const who = (): Record<string, unknown> => !named && instance === "unknown" ? { instance, instance_reason: instanceReason } : { instance };
  const unset = (reason: string, extra: Record<string, unknown> = {}): void => {
    configureGithubInstallationBudget(undefined);
    log(GITHUB_BUDGET_CONFIGURED_STEP, { role, outcome: "unconfigured", ...who(), reason, ...extra });
  };
  if (!installationId) return unset("no_installation_id");
  let read: InstallationRegistryRead | undefined;
  let consumers: number | undefined;
  try {
    read = opts.readRegistry();
    if (read !== undefined && role === "daemon") {
      daemonHandOver[INSTALLATION_REGISTRY_PATH_ENV] = read.path ?? read.source;
      if (read.omitsInstallationIds === true) daemonHandOver[INSTALLATION_REGISTRY_OMITS_IDS_ENV] = "1";
    }
    if (read !== undefined && !named) {
      const own = targetRepo === undefined ? { reason: "no_target" } : registryInstanceForRepo(read.text, targetRepo);
      if ("name" in own) instance = own.name;
      else instanceReason = own.reason;
    }
    consumers = read === undefined ? undefined
      : installationConsumers(read.text, installationId, { countOmitted: read.omitsInstallationIds === true });
  } catch (err) {
    return unset("registry_unreadable", { installation_id: installationId, ...pathField, error: err instanceof Error ? err.message : String(err) });
  }
  if (read === undefined && registryPath === null) {
    return unset("registry_path_missing", { installation_id: installationId, ...pathField, error: `${INSTALLATION_REGISTRY_PATH_ENV} is not set` });
  }
  if (read === undefined) return unset("registry_unreadable", { installation_id: installationId, ...pathField });
  if (consumers === undefined) return unset("no_instance_on_installation", { installation_id: installationId, source: read.source });
  const divisor = role === "run_child" ? shareDivisorOf(env[INSTALLATION_SHARE_DIVISOR_ENV]) : undefined;
  const split = role !== "run_child" ? {}
    : divisor === undefined ? { share_divisor: 1, divisor_reason: "divisor_missing" } : { share_divisor: divisor };
  configureGithubInstallationBudget(createInstallationBudget({
    consumers: consumers * (divisor ?? 1), instances: consumers, instance, clock: opts.clock ?? systemClock, maxWaitMs,
    ...(role === "daemon" ? { sharedState: createInstallationBudgetState() } : {}),
  }));
  log(GITHUB_BUDGET_CONFIGURED_STEP, {
    role, outcome: "configured", ...who(), installation_id: installationId, consumers, ...split, source: read.source,
  });
}
