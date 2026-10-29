import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { enabledWorkerProviders } from "./config.js";
import { cashConfiguredAccounts } from "./config-schema.js";
import { systemClock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { humanGatedFamily } from "./model-gate.js";
import { loadMounts, mountsPath } from "./mounts.js";
import {
  OPENWEIGHT_API_KEY_ENV,
  openWeightDeploymentReady,
  readCodexRuntime,
  type CodexModelInfo,
} from "./worker-provider.js";

/** The three states a successor can occupy before it is allowed to change routing. */
export type SuccessorState = "announced" | "deployed-unpriced" | "ready";

export interface ModelCatalog {
  source: "cash" | "codex";
  models: readonly string[];
}

export interface SuccessorModel {
  model: string;
  family: string;
  generation: number;
  state: SuccessorState;
  sources: readonly ("cash" | "codex")[];
  gated: boolean;
  nextStep: string;
  actionable: boolean;
}

export interface SuccessorAlert extends SuccessorModel {
  key: string;
}

export interface SuccessorWatchReading {
  status: "measured" | "refused";
  successors: readonly SuccessorModel[];
  alerted: readonly SuccessorAlert[];
  refusedReason?: string;
}

export interface SuccessorWatchState {
  [key: string]: { state: SuccessorState; updatedAt: string };
}

export interface SuccessorWatchOptions {
  config: Config;
  /** The checkout owns mounts; daemon state roots do not. */
  routedModels?: readonly string[];
  /** Test seam and a useful boundary for a future provider connector. */
  readCash?: () => Promise<readonly string[]>;
  /** Test seam and a useful boundary for a future provider connector. */
  readCodex?: () => Promise<readonly string[]>;
  statePath?: string;
  now?: () => Date;
  ledger?: (row: { step: string; [key: string]: unknown }) => void;
  /** Return a durable issue URL when the alert was delivered; null means it was not delivered. */
  alert?: (alert: SuccessorAlert) => string | null | Promise<string | null>;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,95}$/;
const GENERATIONAL_MODEL = /^gpt-(\d+(?:\.\d+)?)-([a-z0-9][a-z0-9-]*)$/i;
const STATE_FILENAME = "model-successor-watch.json";

function modelIds(models: readonly string[]): string[] {
  return [...new Set(models.filter((model) => MODEL_ID.test(model)))].sort();
}

function generationOf(model: string): { generation: number; family: string } | undefined {
  const match = GENERATIONAL_MODEL.exec(model);
  if (!match) return undefined;
  return { generation: Number(match[1]), family: match[2].toLowerCase() };
}

function collectRoutedModelIds(capabilities: unknown): string[] {
  const table = capabilities as {
    codex?: unknown;
    cash?: unknown;
    claudeCandidates?: unknown;
    claude?: Record<string, unknown>;
  } | undefined;
  const ids = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) collect(item);
      return;
    }
    if (typeof value === "string" && MODEL_ID.test(value)) ids.add(value);
  };
  collect(table?.codex);
  collect(table?.cash);
  collect(table?.claudeCandidates);
  for (const model of Object.keys(table?.claude ?? {})) {
    if (MODEL_ID.test(model)) ids.add(model);
  }
  return [...ids];
}

export function routedModelIdsFromCheckout(root: string): string[] {
  return collectRoutedModelIds(loadMounts(mountsPath(root)).capabilities);
}

function routedModelIds(config: Config): string[] {
  return routedModelIdsFromCheckout(config.root);
}

function nextStep(state: SuccessorState, model: string, gated: boolean): string {
  if (gated) return `operator approval is required before routing ${model}`;
  if (state === "announced") return `deploy ${model} on the Azure cash lane`;
  if (state === "deployed-unpriced") return `add ${model} to the cash pricing, temperature, and context tables`;
  return "no action — routing is ready";
}

/**
 * Classify higher generations in routed families, plus catalog-listed cash deployments at the
 * current generation whose routing is ready. Cash readiness is deliberately the routing gate:
 * Codex can announce a model before Azure has a deployment, while a cash model can be deployed
 * before its local price/shape rows exist.
 */
export function classifySuccessors(
  routedModels: readonly string[],
  catalogs: readonly ModelCatalog[],
): SuccessorModel[] {
  const routed = new Map<string, number>();
  for (const model of routedModels) {
    const parsed = generationOf(model);
    if (!parsed) continue;
    routed.set(parsed.family, Math.max(routed.get(parsed.family) ?? -Infinity, parsed.generation));
  }
  const byModel = new Map<string, Set<"cash" | "codex">>();
  for (const catalog of catalogs) {
    for (const model of modelIds(catalog.models)) {
      const parsed = generationOf(model);
      if (!parsed) continue;
      const routedGeneration = routed.get(parsed.family);
      if (routedGeneration === undefined || parsed.generation < routedGeneration) continue;
      const sources = byModel.get(model) ?? new Set<"cash" | "codex">();
      sources.add(catalog.source);
      byModel.set(model, sources);
    }
  }

  return [...byModel.entries()]
    .filter(([model, sources]) => {
      const parsed = generationOf(model)!;
      return parsed.generation > routed.get(parsed.family)!
        || (sources.has("cash") && openWeightDeploymentReady(model));
    })
    .map(([model, sourceSet]) => {
      const parsed = generationOf(model)!;
      const sources = [...sourceSet].sort() as Array<"cash" | "codex">;
      const listedByCash = sourceSet.has("cash");
      const state: SuccessorState = listedByCash
        ? openWeightDeploymentReady(model)
          ? "ready"
          : "deployed-unpriced"
        : "announced";
      const gated = humanGatedFamily(model) !== undefined;
      return {
        model,
        family: parsed.family,
        generation: parsed.generation,
        state,
        sources,
        gated,
        nextStep: nextStep(state, model, gated),
        actionable: !gated && state !== "ready",
      } satisfies SuccessorModel;
    })
    .sort((left, right) => left.model.localeCompare(right.model));
}

function readState(path: string): SuccessorWatchState {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return value as SuccessorWatchState;
  } catch {
    // A missing or torn dedup file is an empty history; the next successful delivery re-seeds it.
    return {};
  }
}

function cashModelsEndpoint(rawEndpoint: string): string {
  const base = new URL(rawEndpoint.endsWith("/") ? rawEndpoint : `${rawEndpoint}/`);
  return new URL("openai/models?api-version=2024-10-21", base).toString();
}

/** W1-T10837: one configured Azure account this catalog read could not read. Carries the
 *  account's own identity (never its key) so the caller can name the failure instead of letting it
 *  collapse into the union it did not affect. */
export interface CashCatalogAccountFailure {
  endpoint: string;
  keyEnv: string;
  reason: string;
}

/**
 * Read Azure's data-plane catalog without persisting any account key.
 *
 * W1-T10837: reads EVERY distinct account {@link cashConfiguredAccounts} names -- the default
 * `cashEndpoint`/`openweightEndpoint` account plus every account a `cashDeploymentEndpoints` entry
 * points at -- each with ITS OWN key, and returns the union. One account that fails to read is
 * named (via `onAccountFailure`, never thrown away silently) WITHOUT hiding another account's
 * listing, so a deployment on a second account still counts as "listed by cash" in
 * {@link classifySuccessors}. Only refuses outright when NO configured account could be read at
 * all -- the same behaviour an unmapped host (exactly one account) already had.
 */
export async function readCashModelCatalog(
  config: Config,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  onAccountFailure?: (failure: CashCatalogAccountFailure) => void,
): Promise<string[]> {
  const accounts = cashConfiguredAccounts(config);
  if (accounts.length === 0) throw new Error("cash model catalog requires workerProviders.cashEndpoint");
  const models = new Set<string>();
  const failures: CashCatalogAccountFailure[] = [];
  for (const account of accounts) {
    const key = env[account.keyEnv];
    if (!key) {
      const reason = account.keyEnv === OPENWEIGHT_API_KEY_ENV
        ? `cash model catalog requires ${OPENWEIGHT_API_KEY_ENV}`
        : `cash model catalog requires ${account.keyEnv} for ${account.endpoint}`;
      failures.push({ endpoint: account.endpoint, keyEnv: account.keyEnv, reason });
      onAccountFailure?.({ endpoint: account.endpoint, keyEnv: account.keyEnv, reason });
      continue;
    }
    try {
      const response = await fetchImpl(cashModelsEndpoint(account.endpoint), { headers: { "api-key": key } });
      if (!response.ok) throw new Error(`cash model catalog failed with HTTP ${response.status}`);
      const payload = await response.json() as { data?: Array<{ id?: unknown; model?: unknown }> };
      for (const id of (payload.data ?? []).flatMap((row) => [row.id, row.model].filter((value): value is string => typeof value === "string"))) {
        models.add(id);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({ endpoint: account.endpoint, keyEnv: account.keyEnv, reason });
      onAccountFailure?.({ endpoint: account.endpoint, keyEnv: account.keyEnv, reason });
    }
  }
  // Every configured account failed: nothing to union, so refuse naming every reason rather than
  // silently returning an empty catalog that would read as "cash lists nothing" instead of "cash
  // was unreadable".
  if (models.size === 0 && failures.length > 0) throw new Error(failures.map((failure) => failure.reason).join("; "));
  return modelIds([...models]);
}

/** Read Codex's account catalog through the same bounded app-server exchange as routing. */
export async function readCodexModelCatalog(config: Config): Promise<string[]> {
  const reading = await readCodexRuntime(config, config.workerProviders?.codexBin ?? "codex", { timeoutMs: 10_000 });
  if ("provider" in reading) throw new Error(reading.detail ?? "Codex model catalog was unreadable");
  return modelIds(reading.models.flatMap((model: CodexModelInfo) => [model.id, model.model].filter((value): value is string => typeof value === "string")));
}

/**
 * Measure both provider catalogs, ledger every reading, and alert only on a successor's first
 * observation of each state. A failed provider read refuses the whole measurement: a partial
 * catalog must never look like a missing model and trigger a misleading deployment alert.
 */
export async function watchSuccessorModels(opts: SuccessorWatchOptions): Promise<SuccessorWatchReading> {
  const now = opts.now ?? (() => systemClock.date());
  const statePath = opts.statePath ?? join(opts.config.root, "state", STATE_FILENAME);
  const providers = enabledWorkerProviders(opts.config);
  // W1-T10837: a per-account read failure is named on the ledger instead of disappearing into the
  // union it did not affect -- "one unreadable account is reported by name and does not hide the
  // other account's listing" (design ii).
  const cashReader = opts.readCash ?? (providers.includes("cash") ? () => readCashModelCatalog(opts.config, undefined, undefined,
    (failure) => opts.ledger?.({ step: "model.successor.catalog_account_unreadable", source: "cash", endpoint: failure.endpoint, keyEnv: failure.keyEnv, reason: failure.reason })) : undefined);
  const codexReader = opts.readCodex ?? (providers.includes("codex") ? () => readCodexModelCatalog(opts.config) : undefined);
  if (!cashReader && !codexReader) {
    opts.ledger?.({ step: "model.successor.read", successor_count: 0, reason: "no catalog providers enabled" });
    return { status: "measured", successors: [], alerted: [] };
  }
  let cash: readonly string[] = [];
  let codex: readonly string[] = [];
  try {
    [cash, codex] = await Promise.all([
      cashReader ? cashReader() : Promise.resolve([]),
      codexReader ? codexReader() : Promise.resolve([]),
    ]);
  } catch (error) {
    const reason = `model catalog read refused: ${String((error as Error)?.message ?? error)}`;
    opts.ledger?.({ step: "model.successor.refused", reason });
    return { status: "refused", successors: [], alerted: [], refusedReason: reason };
  }

  const successors = classifySuccessors(opts.routedModels ?? routedModelIds(opts.config), [
    { source: "cash", models: cash },
    { source: "codex", models: codex },
  ]);
  const previous = readState(statePath);
  const nextState: SuccessorWatchState = { ...previous };
  const alerted: SuccessorAlert[] = [];
  for (const successor of successors) {
    const key = `${successor.model}:${successor.state}`;
    const alert = { ...successor, key } satisfies SuccessorAlert;
    opts.ledger?.({
      step: "model.successor.read",
      model: successor.model,
      family: successor.family,
      generation: successor.generation,
      state: successor.state,
      sources: successor.sources,
      gated: successor.gated,
      next_step: successor.nextStep,
    });
    if (previous[successor.model]?.state === successor.state) continue;
    const issueUrl = opts.alert ? await opts.alert(alert) : null;
    if (issueUrl === null) continue;
    alerted.push(alert);
    nextState[successor.model] = { state: successor.state, updatedAt: now().toISOString() };
    opts.ledger?.({ step: "model.successor.alerted", model: successor.model, state: successor.state, issue_url: issueUrl });
  }
  writeAtomic(statePath, JSON.stringify(nextState, null, 2) + "\n", { mode: 0o600 });
  return { status: "measured", successors, alerted };
}
