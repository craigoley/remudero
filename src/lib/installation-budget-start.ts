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
import { runtimeInstanceRegistryText } from "./instance-registry-selection.js";

const GITHUB_BUDGET_CONFIGURED_STEP = "github.budget.configured";

/** The daemon sets this in a run child's environment: the host worker budget that splits the run-child share. */
export const INSTALLATION_SHARE_DIVISOR_ENV = "RMD_INSTALLATION_SHARE_DIVISOR";

type InstallationRegistryRead = { text: string; source: string; omitsInstallationIds?: boolean };

/**
 * W1-T12553: use the selected registry or the host copy; an unreadable host must reach startup's log.
 * W1-T12670: only a missing host file falls back to the checkout's copy, which names no installation IDs.
 */
export function daemonInstallationRegistry(repoRoot: string): InstallationRegistryRead | undefined {
  const selected = runtimeInstanceRegistryText();
  if (selected !== undefined) return { text: selected, source: "selected" };
  try {
    return { text: readFileSync(DEFAULT_HOST_INSTANCE_REGISTRY_PATH, "utf8"), source: DEFAULT_HOST_INSTANCE_REGISTRY_PATH };
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw err;
  }
  const checkout = join(repoRoot, ".remudero", "daemon-instances.yaml");
  return { text: readFileSync(checkout, "utf8"), source: checkout, omitsInstallationIds: true };
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
 */
export function startProcessInstallationBudget(opts: {
  role: "daemon" | "run_child" | "serve";
  readRegistry: () => InstallationRegistryRead | undefined;
  env: NodeJS.ProcessEnv;
  log: (step: string, extra?: Record<string, unknown>) => void;
  clock?: Clock;
  targetRepo?: string;
  maxWaitMs?: number;
}): void {
  const { role, env, log, targetRepo, maxWaitMs } = opts;
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
    if (read !== undefined && !named) {
      const own = targetRepo === undefined ? { reason: "no_target" } : registryInstanceForRepo(read.text, targetRepo);
      if ("name" in own) instance = own.name;
      else instanceReason = own.reason;
    }
    consumers = read === undefined ? undefined
      : installationConsumers(read.text, installationId, { countOmitted: read.omitsInstallationIds === true });
  } catch (err) {
    return unset("registry_unreadable", { installation_id: installationId, error: err instanceof Error ? err.message : String(err) });
  }
  if (read === undefined) return unset("registry_unreadable", { installation_id: installationId });
  if (consumers === undefined) return unset("no_instance_on_installation", { installation_id: installationId, source: read.source });
  const divisor = role === "run_child" ? shareDivisorOf(env[INSTALLATION_SHARE_DIVISOR_ENV]) : undefined;
  const split = role !== "run_child" ? {}
    : divisor === undefined ? { share_divisor: 1, divisor_reason: "divisor_missing" } : { share_divisor: divisor };
  configureGithubInstallationBudget(createInstallationBudget({
    consumers: consumers * (divisor ?? 1), instance, clock: opts.clock ?? systemClock, maxWaitMs,
    ...(role === "daemon" ? { sharedState: createInstallationBudgetState() } : {}),
  }));
  log(GITHUB_BUDGET_CONFIGURED_STEP, {
    role, outcome: "configured", ...who(), installation_id: installationId, consumers, ...split, source: read.source,
  });
}
