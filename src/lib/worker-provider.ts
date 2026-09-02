import { execFileSync, spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, accessSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { detectUsageLimitRefusal, type UsageLimitRefusal } from "./classify.js";
import type { UsageSnapshot } from "./headroom.js";
import type { Config, WorkerProviderId } from "./config.js";
import { loadMounts, mountsPath, type CapabilityLadder } from "./mounts.js";
import {
  spawnDetachedGroup,
  teardownProcessGroup,
  withWorkerGroupTeardown,
  workerMarkerEnv,
  type ContainedProcess,
  type ContainedSpawnOptions,
} from "./worker-containment.js";

interface CodexSpawnArgs {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  env?: Record<string, string>;
  effort?: string;
  maxTurns?: number;
  tools?: string[];
  runId?: string;
  taskId?: string;
  containment?: {
    spawn?: (
      opts: ContainedSpawnOptions,
      onStderr?: (chunk: string) => void,
      onSpawnError?: (error: NodeJS.ErrnoException) => void,
    ) => ContainedProcess;
    teardown?: (pgid: number) => void;
  };
  onSpawnError?: (error: NodeJS.ErrnoException) => void;
  streamObserver?: (event: { kind: "working" | "tool-executing" | "message"; tsMs: number; text?: string }) => void;
  clockBound?: { boundMs: number; now?: () => number; pollMs?: number };
}

interface CodexWorkerResult {
  provider: "codex";
  sessionId: string;
  costUsd: number;
  numTurns: number;
  maxTurns?: number;
  text: string;
  blocks: string[];
  stderr: string;
  subtype: string;
  isError: boolean;
  apiError: boolean;
  usageRefusal?: UsageLimitRefusal;
  permissionDenials: unknown[];
  childEnvKeys: string[];
  accountLabel?: string;
  model: string;
  effort: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  modelUsage: Record<string, never>;
  compactionEvents: [];
  compactionFailures: [];
  compactionConfigured: false;
  qualitySuspect: false;
  workerDurationMs: number;
}

export interface ProviderCapacityWindow {
  name: string;
  usedPercent: number;
  resetsAt?: number | string;
}

export interface ProviderCapacity {
  provider: WorkerProviderId;
  readable: boolean;
  windows: ProviderCapacityWindow[];
  detail?: string;
  accountLabel?: string;
  /** Concrete account-visible model chosen for this capacity reading. */
  model?: string;
  /** Concrete reasoning effort supported by that model. */
  effort?: string;
}

export interface ProviderSelection {
  provider: WorkerProviderId;
  capacity: ProviderCapacity;
  tightestRemainingPercent: number;
}

export class ProviderCapacityBlockedError extends Error {
  readonly reasonClass = "blocked_toolchain";
  constructor(readonly capacities: ProviderCapacity[]) {
    super(
      `no configured worker subscription has readable headroom: ${capacities
        .map((c) => `${c.provider}=${c.readable ? `${tightestRemaining(c)}% remaining` : c.detail ?? "unreadable"}`)
        .join(", ")}`,
    );
    this.name = "ProviderCapacityBlockedError";
  }
}

export class CodexToolchainBlockedError extends Error {
  readonly reasonClass = "blocked_toolchain";
  constructor(message: string) {
    super(message);
    this.name = "CodexToolchainBlockedError";
  }
}

function tightestRemaining(capacity: ProviderCapacity): number {
  if (!capacity.readable || capacity.windows.length === 0) return Number.NEGATIVE_INFINITY;
  return Math.min(...capacity.windows.map((window) => 100 - window.usedPercent));
}

/**
 * Select the eligible subscription with the most room in its tightest window.
 * Unreadable providers and providers at the reserve boundary are excluded.
 */
export function selectWorkerProvider(
  capacities: ProviderCapacity[],
  reservePercent = 5,
  tieBreaker = 0,
): ProviderSelection {
  const ceiling = 100 - reservePercent;
  const eligible = capacities
    .filter(
      (capacity) =>
        capacity.readable &&
        capacity.windows.length > 0 &&
        capacity.windows.every(
          (window) =>
            Number.isFinite(window.usedPercent) &&
            window.usedPercent >= 0 &&
            window.usedPercent <= 100 &&
            window.usedPercent < ceiling,
        ),
    )
    .map((capacity) => ({ provider: capacity.provider, capacity, tightestRemainingPercent: tightestRemaining(capacity) }))
    .sort((a, b) => b.tightestRemainingPercent - a.tightestRemainingPercent);
  if (eligible.length === 0) throw new ProviderCapacityBlockedError(capacities);
  const best = eligible[0].tightestRemainingPercent;
  const tied = eligible.filter((item) => item.tightestRemainingPercent === best);
  return tied[Math.abs(tieBreaker) % tied.length];
}

export function claudeCapacityFromUsage(snapshot: UsageSnapshot | undefined): ProviderCapacity {
  if (!snapshot) return { provider: "claude", readable: false, windows: [], detail: "capacity unreadable" };
  return {
    provider: "claude",
    readable: true,
    windows: [
      { name: "session (5h)", usedPercent: snapshot.session.percentUsed, resetsAt: snapshot.session.resetsAt },
      ...snapshot.weekly.map((window) => ({
        name: `weekly (${window.label})`,
        usedPercent: window.percentUsed,
        resetsAt: window.resetsAt,
      })),
    ],
  };
}

interface CodexRateLimitWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface CodexRateLimitBucket {
  limitId?: unknown;
  limitName?: unknown;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  rateLimitReachedType?: unknown;
  spendControlReached?: unknown;
}

interface CodexRateLimitResult {
  rateLimits?: CodexRateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitBucket> | null;
  accountId?: unknown;
}

export interface CodexModelInfo {
  id: string;
  model?: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
}

interface CodexModelListResult {
  data?: CodexModelInfo[];
  nextCursor?: string | null;
}

type CodexModelTier = "economy" | "balanced" | "frontier";

/**
 * Last-resort Codex candidates (W1-T2573), used ONLY when `.remudero/mounts.yaml`'s
 * `capabilities` axis is unavailable — the routing table failed to load, or a caller (e.g. a
 * unit test) omitted it. Real routing always resolves through {@link CapabilityLadder.codex}
 * (mounts.ts); this is a documented degenerate fallback, not the primary source of truth, so a
 * missing routing table degrades no further than it always has rather than blocking dispatch.
 */
const FALLBACK_CODEX_MODELS: Record<CodexModelTier, string[]> = {
  economy: ["gpt-5.6-luna", "gpt-5.3-codex-spark", "gpt-5.4-mini"],
  balanced: ["gpt-5.6-terra", "gpt-5.5", "gpt-5.4"],
  frontier: ["gpt-5.6-sol", "gpt-5.5"],
};

function normalizedModelName(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function isCodexModelTier(value: unknown): value is CodexModelTier {
  return value === "economy" || value === "balanced" || value === "frontier";
}

/**
 * Resolve the requested Claude model's capability (W1-T2573): a TABLE LOOKUP against
 * `.remudero/mounts.yaml`'s `capabilities.claude` map (src/lib/mounts.ts), never a substring
 * match on the model name. A model with no declared capability — or no capability data at all —
 * resolves to "balanced", the SAME degenerate default the old substring function fell through to
 * for "everything else"; here it is an explicit, documented fallback rather than the silent
 * result of an `.includes()` miss, and any model this table DOES declare (including one whose
 * name carries neither "haiku" nor "opus") resolves correctly regardless of its spelling.
 */
export function codexCapabilityForRequestedModel(
  capabilities: CapabilityLadder | undefined,
  requestedModel: string | undefined,
): CodexModelTier {
  const model = requestedModel?.toLowerCase() ?? "";
  const capability = capabilities?.claude[model];
  return isCodexModelTier(capability) ? capability : "balanced";
}

/**
 * Resolve the ordered Codex candidate models for a (capability, effort) pair — the table lookup
 * that replaces the old tier function's dropped-effort selection (W1-T2573, rationale point 2).
 * `requestedEffort` now genuinely changes which candidates are preferred: whenever the table
 * declares different rows for two efforts under the same capability, a `sonnet/high` mount and a
 * `sonnet/medium` mount resolve DIFFERENT candidate lists — they are not the same Codex request.
 * An effort the table has no row for falls back to "medium"; capability data unavailable at all
 * falls back to {@link FALLBACK_CODEX_MODELS}.
 */
export function codexCandidatesForCapability(
  capabilities: CapabilityLadder | undefined,
  tier: CodexModelTier,
  requestedEffort: string | undefined,
): string[] {
  const byEffort = capabilities?.codex[tier];
  if (!byEffort) return FALLBACK_CODEX_MODELS[tier];
  const row = (requestedEffort && byEffort[requestedEffort]) || byEffort.medium;
  return row ?? FALLBACK_CODEX_MODELS[tier];
}

function codexBucketForModel(result: CodexRateLimitResult, model: CodexModelInfo): CodexRateLimitBucket | undefined {
  const buckets = Object.values(result.rateLimitsByLimitId ?? {});
  const names = new Set([model.id, model.model, model.displayName].map(normalizedModelName).filter(Boolean));
  const named = buckets.find((bucket) => names.has(normalizedModelName(bucket.limitName)));
  return named ?? buckets.find((bucket) => bucket.limitId === "codex") ?? result.rateLimits ?? undefined;
}

function capacityFromBucket(bucket: CodexRateLimitBucket | undefined, accountLabel?: string): ProviderCapacity {
  if (!bucket) return { provider: "codex", readable: false, windows: [], detail: "rate-limit response missing" };
  const label = typeof bucket.limitName === "string" && bucket.limitName ? bucket.limitName : String(bucket.limitId ?? "codex");
  const windows: ProviderCapacityWindow[] = [];
  for (const [kind, window] of [["primary", bucket.primary], ["secondary", bucket.secondary]] as const) {
    if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
    const duration = typeof window.windowDurationMins === "number" ? ` ${window.windowDurationMins}m` : "";
    windows.push({
      name: `${label} ${kind}${duration}`,
      usedPercent: window.usedPercent,
      ...(typeof window.resetsAt === "number" || typeof window.resetsAt === "string" ? { resetsAt: window.resetsAt } : {}),
    });
  }
  if (windows.length === 0) return { provider: "codex", readable: false, windows: [], detail: "no usable rate-limit windows" };
  if (bucket.rateLimitReachedType != null || bucket.spendControlReached === true) windows.push({ name: "reached", usedPercent: 100 });
  return { provider: "codex", readable: true, windows, ...(accountLabel ? { accountLabel } : {}) };
}

/** Map the documented app-server result without treating absent numbers as zero. */
export function codexCapacityFromRateLimits(result: unknown): ProviderCapacity {
  if (!result || typeof result !== "object") {
    return { provider: "codex", readable: false, windows: [], detail: "rate-limit response missing" };
  }
  const reading = result as CodexRateLimitResult;
  const generic = reading.rateLimits ?? reading.rateLimitsByLimitId?.codex;
  return capacityFromBucket(generic ?? undefined, typeof reading.accountId === "string" ? reading.accountId : undefined);
}

/**
 * Pick an account-visible model for the requested Remudero mount and attach only
 * that model's quota bucket. Independent model buckets must not veto each other.
 *
 * `capabilities` (W1-T2573) is the `.remudero/mounts.yaml` capability ladder — see
 * {@link codexCapabilityForRequestedModel} / {@link codexCandidatesForCapability}. It resolves
 * BOTH the capability tier (a table lookup on the Claude model name, never a substring match)
 * and, keyed also on `requestedEffort`, the ordered default candidates for that tier — so effort
 * now genuinely reaches the candidate pool instead of being dropped at the provider boundary. An
 * operator's `workerProviders.codexModels` override, when present, still wins outright per tier
 * (unchanged — it is not effort-keyed) exactly as it did before this axis existed.
 */
export function selectCodexModel(
  models: CodexModelInfo[],
  rateLimits: unknown,
  config: Config,
  requestedModel?: string,
  requestedEffort?: string,
  capabilities?: CapabilityLadder,
): ProviderCapacity {
  const reading = rateLimits && typeof rateLimits === "object" ? rateLimits as CodexRateLimitResult : {};
  const visible = models.filter((model) => !model.hidden && typeof model.id === "string" && model.id !== "");
  const forced = config.workerProviders?.codexModel;
  const tier = codexCapabilityForRequestedModel(capabilities, requestedModel);
  const preferred = forced
    ? [forced]
    : [...(config.workerProviders?.codexModels?.[tier] ?? codexCandidatesForCapability(capabilities, tier, requestedEffort))];
  const accountDefault = visible.find((model) => model.isDefault)?.id;
  if (!forced && accountDefault) preferred.push(accountDefault);
  const candidates = [...new Set(preferred)]
    .map((id) => visible.find((model) => model.id === id || model.model === id))
    .filter((model): model is CodexModelInfo => model !== undefined);
  if (candidates.length === 0) {
    return {
      provider: "codex",
      readable: false,
      windows: [],
      detail: forced
        ? `configured Codex model is not available to this account: ${forced}`
        : `no account-visible Codex model matched the ${tier} preference set`,
    };
  }
  const reserve = config.workerProviders?.reservePercent ?? 5;
  const ranked = candidates.map((model, preference) => {
    const capacity = capacityFromBucket(codexBucketForModel(reading, model));
    return { model, capacity, preference, remaining: tightestRemaining(capacity) };
  }).sort((a, b) => b.remaining - a.remaining || a.preference - b.preference);
  const eligible = ranked.find(({ capacity }) =>
    capacity.readable && capacity.windows.every((window) =>
      Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 && window.usedPercent < 100 - reserve));
  const selected = eligible ?? ranked[0];
  const efforts = (selected.model.supportedReasoningEfforts ?? [])
    .map((entry) => entry.reasoningEffort)
    .filter((effort): effort is string => typeof effort === "string");
  const requested = requestedEffort && efforts.includes(requestedEffort) ? requestedEffort : undefined;
  const effort = requested ?? selected.model.defaultReasoningEffort ?? efforts[0] ?? "default";
  return {
    ...selected.capacity,
    model: selected.model.model ?? selected.model.id,
    effort,
    ...(!eligible ? { readable: false, detail: `${tier} Codex models have no reserved headroom` } : {}),
  };
}

export interface CodexCapacityDeps {
  now?: () => number;
  spawn?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
  requestedModel?: string;
  requestedEffort?: string;
  /** Process environment used only for PATH resolution of an unconfigured Codex binary. */
  resolveEnv?: NodeJS.ProcessEnv;
  /**
   * Injected capability ladder (W1-T2573), bypassing the `loadMounts` disk read below — for a
   * caller that already holds a validated Mounts table, and for tests. When omitted,
   * `readCodexCapacity` loads `.remudero/mounts.yaml` itself via `config.root`.
   */
  capabilities?: CapabilityLadder;
}

/**
 * Resolve the capability ladder `readCodexCapacity` routes through (W1-T2573): the caller's
 * injected `deps.capabilities` when supplied, else `.remudero/mounts.yaml`'s own `capabilities`
 * block via `config.root`. A missing/malformed routing table degrades to `undefined` — the same
 * documented fallback {@link codexCapabilityForRequestedModel} / {@link codexCandidatesForCapability}
 * already define — rather than blocking a capacity read on a routing-table hiccup.
 */
function resolveCapabilityLadder(config: Config, deps: CodexCapacityDeps): CapabilityLadder | undefined {
  if (deps.capabilities) return deps.capabilities;
  try {
    return loadMounts(mountsPath(config.root)).capabilities;
  } catch (error) {
    // Deliberate compatibility fallback: a missing/malformed optional table preserves the
    // pre-capability balanced routing path; callers already treat `undefined` as that state.
    return undefined;
  }
}

interface CodexRuntimeReading {
  rateLimits: unknown;
  models: CodexModelInfo[];
}

const codexCapacityCache = new Map<string, { at: number; value: CodexRuntimeReading }>();

export function clearCodexCapacityCache(): void {
  codexCapacityCache.clear();
}

function resolveCodexBin(config: Config, resolveEnv: NodeJS.ProcessEnv = process.env): string {
  const configured = config.workerProviders?.codexBin;
  let resolved = configured;
  if (!resolved) {
    try {
      resolved = execFileSync("which", ["codex"], { encoding: "utf8", env: resolveEnv }).trim();
    } catch (error) {
      throw new CodexToolchainBlockedError("Codex is enabled but no codex executable is on PATH and workerProviders.codexBin is unset");
    }
  }
  try {
    accessSync(resolved, fsConstants.X_OK);
  } catch (error) {
    throw new CodexToolchainBlockedError(`Codex executable is absent or not executable: ${resolved}`);
  }
  return resolved;
}

function codexHome(config: Config): string {
  return config.workerProviders?.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function codexControlEnv(config: Config): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome(config) };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** Read account-visible models and their subscription buckets through one app-server session. */
export async function readCodexCapacity(config: Config, deps: CodexCapacityDeps = {}): Promise<ProviderCapacity> {
  let bin: string;
  try {
    bin = resolveCodexBin(config, deps.resolveEnv);
  } catch (error) {
    // Toolchain absence is a named unreadable capacity, so routing can still use Claude.
    return { provider: "codex", readable: false, windows: [], detail: (error as Error).message };
  }
  const capabilities = resolveCapabilityLadder(config, deps);
  const now = deps.now ?? Date.now;
  const cacheKey = `${bin}\0${codexHome(config)}`;
  const cached = codexCapacityCache.get(cacheKey);
  const cacheMs = config.workerProviders?.capacityCacheMs ?? 60_000;
  if (cached && now() - cached.at < cacheMs) {
    return selectCodexModel(cached.value.models, cached.value.rateLimits, config, deps.requestedModel, deps.requestedEffort, capabilities);
  }

  const spawn = deps.spawn ?? ((command, args, options) => spawnChild(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }));
  const timeoutMs = deps.timeoutMs ?? 10_000;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, ["app-server", "--listen", "stdio://"], { env: codexControlEnv(config) });
  } catch (error) {
    // A synchronous spawn failure excludes Codex without erasing its reason.
    return { provider: "codex", readable: false, windows: [], detail: `app-server spawn failed: ${(error as Error).message}` };
  }

  const value = await new Promise<CodexRuntimeReading | ProviderCapacity>((resolve) => {
    let settled = false;
    let buffer = "";
    let stderr = "";
    let rateLimits: unknown;
    let models: CodexModelInfo[] | undefined;
    const finish = (result: CodexRuntimeReading | ProviderCapacity) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ provider: "codex", readable: false, windows: [], detail: `rate-limit read timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );
    child.on("error", (error) => finish({ provider: "codex", readable: false, windows: [], detail: `app-server error: ${error.message}` }));
    child.on("exit", (code) => {
      if (!settled) finish({ provider: "codex", readable: false, windows: [], detail: `app-server exited ${code}: ${stderr.slice(-240)}` });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          message = JSON.parse(raw) as typeof message;
        } catch (error) {
          // Non-protocol stdout is skipped; missing RPC responses still fail closed at the timeout.
          continue;
        }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ method: "account/rateLimits/read", id: 2, params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ method: "model/list", id: 3, params: { limit: 100, includeHidden: false } })}\n`);
        } else if (message.id === 2) {
          if (message.error) {
            finish({ provider: "codex", readable: false, windows: [], detail: message.error.message ?? "rate-limit RPC error" });
          } else {
            rateLimits = message.result;
            if (models) finish({ rateLimits, models });
          }
        } else if (message.id === 3) {
          if (message.error) {
            finish({ provider: "codex", readable: false, windows: [], detail: message.error.message ?? "model-list RPC error" });
          } else {
            const result = message.result as CodexModelListResult | undefined;
            if (result?.nextCursor) {
              finish({ provider: "codex", readable: false, windows: [], detail: "model/list exceeded the supported 100-model page" });
            } else {
              models = Array.isArray(result?.data) ? result.data : [];
              if (rateLimits !== undefined) finish({ rateLimits, models });
            }
          }
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({ method: "initialize", id: 1, params: { clientInfo: { name: "remudero", title: "Remudero", version: "0.1.0" } } })}\n`,
    );
  });
  if ("provider" in value) return value;
  codexCapacityCache.set(cacheKey, { at: now(), value });
  return selectCodexModel(value.models, value.rateLimits, config, deps.requestedModel, deps.requestedEffort, capabilities);
}

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  item?: { type?: string; text?: string; command?: string; aggregated_output?: string };
}

export interface ParsedCodexEvents {
  sessionId: string;
  text: string;
  blocks: string[];
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  numTurns: number;
  isError: boolean;
  subtype: string;
  errors: string[];
  usageRefusal?: UsageLimitRefusal;
}

/** Parse Codex exec JSONL into the existing provider-neutral worker envelope. */
export function parseCodexJsonl(raw: string, nowMs = Date.now()): ParsedCodexEvents {
  let sessionId = "";
  const blocks: string[] = [];
  const errors: string[] = [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let numTurns = 0;
  let usageRefusal: UsageLimitRefusal | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: CodexJsonEvent;
    try {
      event = JSON.parse(line) as CodexJsonEvent;
    } catch (error) {
      // Preserve malformed output in the returned error verdict instead of treating it as absence.
      errors.push(`unparseable Codex event: ${line.slice(0, 160)}`);
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") sessionId = event.thread_id;
    if (event.type === "turn.started") numTurns += 1;
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      blocks.push(event.item.text);
    }
    if (event.type === "turn.completed" && event.usage) {
      input += event.usage.input_tokens ?? 0;
      output += event.usage.output_tokens ?? 0;
      cacheRead += event.usage.cached_input_tokens ?? 0;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const message = event.error?.message ?? event.type;
      errors.push(message);
      // Codex 0.152.0 preserves its structured UsageLimitExceeded classification inside app-server,
      // but `codex exec --json` intentionally projects only the terminal message. Normalize at this
      // adapter boundary while the text is known to be provider error evidence; never scan agent
      // output, which may discuss usage limits as part of the task.
      usageRefusal ??= detectUsageLimitRefusal(message, nowMs);
    }
  }
  return {
    sessionId,
    text: blocks.at(-1) ?? "",
    blocks,
    tokens: { input, output, cacheRead, cacheCreation: 0 },
    numTurns,
    isError: errors.length > 0,
    subtype: errors.length > 0 ? "error_codex" : "success",
    errors,
    ...(usageRefusal ? { usageRefusal } : {}),
  };
}

function codexSpawnEnv(config: Config, args: CodexSpawnArgs): Record<string, string | undefined> {
  const allowed = ["PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN"];
  const env: Record<string, string | undefined> = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.HOME = process.env.HOME ?? homedir();
  env.CODEX_HOME = codexHome(config);
  for (const [key, value] of Object.entries(args.env ?? {})) {
    if (!/^ANTHROPIC_|^OPENAI_API_KEY$/.test(key)) env[key] = value;
  }
  Object.assign(env, workerMarkerEnv(args.runId, args.taskId));
  return env;
}

function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    // A not-yet-created path still has a lexical absolute form; callers separately check scope.
    return resolve(path);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolve only this checkout's Git administrative directories. Codex workspace-write protects
 * `.git` by default, while Remudero implementation prompts require the worker to commit. Linked
 * worktrees need both the per-worktree git dir and their shared common dir; paths outside the
 * configured Remudero root are refused instead of widening the sandbox from repository metadata.
 */
export function codexGitWritableRoots(cwd: string, configRoot: string): string[] {
  try {
    const root = physicalPath(configRoot);
    const output = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return [...new Set(output.split("\n").map((line) => line.trim()).filter(Boolean).map(physicalPath))]
      .filter((candidate) => isWithin(root, candidate));
  } catch (error) {
    // A non-repository or unreadable Git layout earns no extra writable root, never a broad grant.
    return [];
  }
}

function codexExecArgs(args: CodexSpawnArgs, config: Config, selection?: Pick<ProviderCapacity, "model" | "effort">): string[] {
  const model = selection?.model ?? config.workerProviders?.codexModel;
  const effort = selection?.effort === "default" ? undefined : selection?.effort;
  const shared = [
    "--json",
    "--ignore-user-config",
    "-c", 'shell_environment_policy.inherit="core"',
    "-c", 'shell_environment_policy.exclude=["CODEX_HOME","OPENAI_API_KEY","ANTHROPIC_API_KEY"]',
  ];
  if (model) shared.push("--model", model);
  if (effort) shared.push("-c", `model_reasoning_effort=\"${effort}\"`);
  if (args.resumeSessionId) return ["exec", "resume", ...shared, args.resumeSessionId, "-"];
  const readOnly = Array.isArray(args.tools) && !args.tools.some((tool) => ["Write", "Edit", "NotebookEdit", "MultiEdit"].includes(tool));
  const gitWritableRoots = readOnly ? [] : codexGitWritableRoots(args.cwd, config.root);
  return [
    "exec",
    ...shared,
    "--sandbox", readOnly ? "read-only" : "workspace-write",
    ...(readOnly ? [] : ["-c", "sandbox_workspace_write.network_access=true"]),
    ...gitWritableRoots.flatMap((root) => ["--add-dir", root]),
    "-C", args.cwd,
    "-",
  ];
}

export async function spawnCodexWorker(
  args: CodexSpawnArgs,
  config: Config,
  selection?: Pick<ProviderCapacity, "model" | "effort">,
): Promise<CodexWorkerResult> {
  const bin = resolveCodexBin(config);
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const pidRef: { pid?: number } = {};
  const spawn = args.containment?.spawn ?? spawnDetachedGroup;
  const teardown = args.containment?.teardown ?? ((pgid: number) => void teardownProcessGroup(pgid));
  const startedAt = Date.now();
  let timedOut = false;
  const contained = spawn(
    { command: bin, args: codexExecArgs(args, config, selection), cwd: args.cwd, env: codexSpawnEnv(config, args) },
    (chunk) => stderrChunks.push(chunk),
    args.onSpawnError,
  );
  pidRef.pid = contained.pid;
  const process = contained.process as unknown as ContainedProcess["process"] & NodeJS.EventEmitter & {
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
  };
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    process.once("exit", (code: number | null) => resolve(code));
    process.once("error", reject);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armClockBound = () => {
    if (!args.clockBound) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      teardown(contained.pid);
    }, args.clockBound.boundMs);
  };
  process.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdoutChunks.push(text);
    if (/\"type\":\"agent_message\"/.test(text)) args.streamObserver?.({ kind: "working", tsMs: Date.now() });
    else args.streamObserver?.({ kind: "message", tsMs: Date.now() });
    armClockBound();
  });
  armClockBound();
  const prompt =
    "Before acting, read and follow the repository instruction files present in the checkout, including CLAUDE.md and AGENTS.md.\n\n" +
    args.prompt;
  process.stdin.write(`${prompt}\n`);
  process.stdin.end();
  try {
    const exitCode = await withWorkerGroupTeardown(pidRef, () => exitPromise, teardown);
    if (timedOut) throw new Error(`Codex worker exceeded the ${args.clockBound?.boundMs}ms clock bound`);
    const parsed = parseCodexJsonl(stdoutChunks.join(""));
    const isError = parsed.isError || exitCode !== 0;
    const model = selection?.model ?? config.workerProviders?.codexModel ?? "codex-default";
    return {
      sessionId: parsed.sessionId || args.resumeSessionId || "",
      costUsd: 0,
      numTurns: parsed.numTurns,
      // Codex exec 0.152.0 exposes no max-turn flag; never ledger the Claude cap as enforced.
      maxTurns: undefined,
      text: parsed.text,
      blocks: parsed.blocks,
      stderr: stderrChunks.join(""),
      subtype: isError ? (parsed.isError ? parsed.subtype : `error_exit_${exitCode}`) : "success",
      isError,
      apiError: parsed.errors.some((error) => /rate limit|server|network/i.test(error)),
      ...(parsed.usageRefusal ? { usageRefusal: parsed.usageRefusal } : {}),
      permissionDenials: parsed.errors.filter((error) => /permission|sandbox|denied/i.test(error)),
      childEnvKeys: Object.keys(codexSpawnEnv(config, args)),
      accountLabel: undefined,
      provider: "codex",
      model,
      effort: selection?.effort ?? args.effort ?? "default",
      tokens: parsed.tokens,
      modelUsage: {},
      compactionEvents: [],
      compactionFailures: [],
      compactionConfigured: false,
      qualitySuspect: false,
      workerDurationMs: Date.now() - startedAt,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
