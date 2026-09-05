import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
// The default `fs` export serves ONLY the run.lock path (writeRunLock/readRunLock/removeRunLock). Invariant: call those
// through `fs.writeFileSync(...)` property access, never destructured, so `t.mock.method(fs, ...)` intercepts them. TRAP: ESM
// named-export bindings off `node:fs` are non-configurable, so spying on a named import throws "Cannot redefine property"
// (W1-T208).
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type Options, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { detectUsageLimitRefusal } from "./classify.js";
import {
  loadConfig,
  workerHomeDir,
  workerShell,
  workerZdotdir,
  type Config,
} from "./config.js";
import { usageSnapshotFromSdk } from "./headroom.js";
import {
  detectCompactionEvents,
  detectCompactionFailures,
  isQualitySuspect,
  type CompactionEvent,
  type CompactionFailure,
} from "./compaction.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { pgrepFailureMeansZero } from "./deployer.js";
import { isHolderStale, type IsHolderStaleOpts } from "./fs-race-safe.js";
import { buildWorkerEnv, billingMode, type BillingMode } from "./env.js";
import {
  readClaudeModelHealth,
  resolveClaudeModelHealth,
  type ClaudeModelHealthReading,
  type ClaudeModelHealthRoute,
  type ClaudeModelHealthSource,
  type ClaudeModelHealthState,
} from "./claude-model-health.js";
import { loadMounts, mountsPath, type CapabilityLadder } from "./mounts.js";
import { loadDefaultPolicy } from "./policy.js";
import { assertLiveSpawnAllowed } from "./spawn-guard.js";
import { validateWorkerSettingsFile } from "./settings.js";
import { DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS, reapWorkerScratch, sweepStaleWorkerScratch } from "./worker-scratch.js";
import { assertLiveWriteAllowed } from "./live-write-guard.js";
// W1-T2777: same primitive `ensureInstallFresh` (run-task.ts) uses, shared via the extracted `install-hash` module so both
// freshness paths compare the same hash — never a parallel implementation that could drift silently. See lib/install-hash.ts
// for the extraction reason.
import { hashInstallInputs } from "./install-hash.js";
import {
  assertWorkerCredentialFile,
  CLAUDE_CONFIG_REL,
  ensureWorkerKeychain,
  materializeWorkerHome,
  perRunWorkerHomeDir,
  reapWorkerHome,
  workerCredentialFilePath,
  workerKeychainPaths,
  type SecurityRunner,
  lostWorkerHomeGrants,
  type WorkerHomeGrantOutcome,
  type WorkerHomeReapResult,
  type WorkerKeychainSummary,
} from "./worker-home.js";
import {
  buildContainedSpawnFn,
  spawnDetachedGroup,
  teardownProcessGroup,
  withWorkerGroupTeardown,
  workerInstallationScope,
  workerMarkerEnv,
  type ContainedProcess,
  type ContainedSpawnOptions,
} from "./worker-containment.js";
import {
  abandonProviderWindowMeasurement,
  beginProviderWindowMeasurement,
  claudeCapacityFromUsage,
  finishProviderWindowMeasurement,
  readCodexCapacity,
  spawnCodexWorker,
  type CodexCapacityDeps,
  type ProviderCapacity,
  ProviderCapacityBlockedError,
  type ProviderSelection,
  type ProviderWindowConsumption,
  type ProviderWindowMeasurement,
} from "./worker-provider.js";
import { resolveProviderRoutingPolicy, selectWorkerProviderForPolicy } from "./provider-routing-policy.js";
import { writeProviderRoutingStatus, type ProviderRoutingWriteInput } from "./provider-routing-status.js";

/** Aggregate token usage off the SDK result envelope's `usage` field (SDK 0.3.209 `sdk.d.ts`: `NonNullableUsage`, snake_case
 * Anthropic-API names, all fields non-nullable). Zeroed when no result envelope was ever seen — a genuine transport failure. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Per-model cost/token breakdown (SDK 0.3.209 `ModelUsage`) — the map KEYS are the model(s) actually used, which may differ
 * from the requested `model`. */
export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  contextWindow: number;
}

/** Structured result of one worker run. */
export interface WorkerResult {
  /** Backend that executed this call. Optional only for pre-connector test fixtures. */
  provider?: "claude" | "codex";
  sessionId: string;
  costUsd: number;
  /** Turns the worker actually took (SDK `num_turns`), recorded on BOTH the success and error paths, because turn count seeds
   * mounts.yaml calibration (W1-T5), so a failed run is never `0`. TRAP: `num_turns` does not count the unit
   * `Options.maxTurns` bounds — measured failures landed at cap+1 and one clean success at 17 under a cap of 8 — so never
   * judge it against a cap unless {@link maxTurns} rides the same row (W1-T303; docs/forensics/worker.md). */
  numTurns: number;
  /** The `maxTurns` THIS call was CONFIGURED with — an INPUT, never read back off the envelope. Ledgered BESIDE `numTurns`,
   * never replacing it, so a row stays checkable against its own cap without consulting a `mounts.yaml` that moves;
   * `RECON_MAX_TURNS` had already moved 8 -> 20 when this was diagnosed. `undefined`, never guessed, when no cap was
   * configured (W1-T303). */
  maxTurns?: number;
  /** Final result text (the `result` field of the SDK result message). */
  text: string;
  /** All assistant text blocks concatenated, in order. */
  blocks: string[];
  /** Everything the child wrote to stderr — proof surface for the billing boundary. */
  stderr: string;
  /** Result subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | … */
  subtype: string;
  isError: boolean;
  /** An Anthropic-side api error hit the stream — a `<synthetic>`/`isApiErrorMessage` message. TRAP: the result ENVELOPE may
   * still report `subtype: "success"` (WS-0 envelope shape), so this field is the only place the signal survives. Transient
   * for the classifier: retry, no strike, never a task failure. */
  apiError: boolean;
  /** The account refused this run for a session or usage limit — the same envelope lie as {@link apiError}, reported as
   * `subtype: "success"`. TRAP: the SDK emits a success envelope and THEN throws, so the catch sets `isError` while nothing
   * rewrites `subtype`. Do not derive a refusal from cost either: seven measured refusals carried a non-zero cost (W1-T2564;
   * docs/forensics/worker.md). */
  usageRefusal?: { matched: string; resetsAtText?: string; resetsAtMs?: number };
  /** Permission denials the SDK surfaced (hook/permission blocks). */
  permissionDenials: unknown[];
  /** The exact env the child was spawned with (billing-boundary proof). */
  childEnvKeys: string[];
  /** The Anthropic account this call's spend is attributed to — the NAME {@link resolveActiveAccountId} returns, never a
   * secret, resolved fresh per spawn on every platform so a ledger line carrying spend also carries the account it was drawn
   * against. `undefined`, never guessed (W1-T265, W1-T268). */
  accountLabel?: string;
  /** The model this call was CONFIGURED to run — the caller's `SpawnWorkerArgs.model`, an INPUT, never a read-back off the
   * envelope. `DEFAULT_MODEL_LABEL` when unspecified. */
  model: string;
  /** Concrete provider model selected after health/capability routing. */
  routedModel?: string;
  /** Health of the originally preferred Claude candidate when Claude was considered. */
  modelHealthState?: ClaudeModelHealthState;
  /** Whether the health decision used a live/fresh read, bounded stale evidence, or no evidence. */
  modelHealthSource?: ClaudeModelHealthSource;
  /** The reasoning effort this call was CONFIGURED to run. Same INPUT-not-output rule as `model`: effort is absent from the
   * SDK result envelope, so this is the configured value (W1-T6). */
  effort: string;
  /** Aggregate token usage off the result envelope (zeroed if none was seen). */
  tokens: TokenUsage;
  /** Per-model breakdown off the envelope's `modelUsage` map (`{}` if none seen). */
  modelUsage: Record<string, ModelUsageEntry>;
  /** The concrete model id the PROVIDER reported serving this call — the served half of the pair whose request half is `model`
   * above, read off the live stream's last real `msg.message.model`. TRAP: never take it from the `modelUsage` keys, a
   * post-hoc cost breakdown rather than a live per-turn report. `null` when the provider named nothing, paired with {@link
   * servedModelReason}; echoing the ask back is the guess this refuses (W1-T2572; docs/forensics/worker.md). */
  servedModel?: string | null;
  /** Present only when {@link servedModel} could not be resolved, naming WHY, so a `null` row reads as "checked, unreportable"
   * rather than "forgot to check". Absent — never a blank string — whenever `servedModel` is a real id (W1-T2572). */
  servedModelReason?: string;
  /** Compaction events observed in this call's stream (MASTER-PLAN 8B), detected live off `type:"system",
   * subtype:"compact_boundary"` messages by `detectCompactionEvents` (compaction.ts). `[]` when the call never compacted. */
  compactionEvents: CompactionEvent[];
  /** Compaction ATTEMPTS that FAILED, read off the SDK's `compact_result: 'failed'` channel, which carries no
   * `compact_boundary` message — so a failed attempt used to read identically to one that never happened. `[]` means checked,
   * not absent. NOT folded into `qualitySuspect`, because a failed attempt compacted nothing (W1-T2245). */
  compactionFailures?: CompactionFailure[];
  /** Whether THIS spawn's `Options` carried `autoCompactEnabled: true`, so a `quality_suspect: false` / `compactionEvents: []`
   * pair reads as NEVER-NEEDED rather than DISABLED. Read by index check, because `Options` declares no such key — it lives
   * on `Settings`, and `spawnWorker` always passes `settingSources: []`. So it reads `false` on every call today, and that IS
   * the finding: the fleet has no live channel to turn auto-compaction on. Adds no key to `options` (W1-T2245). */
  compactionConfigured?: boolean;
  /** Worker-home grants LOST or HEALED for this spawn (see {@link lostWorkerHomeGrants}). Absent when every grant landed, so a
   * healthy run's verdict row grows nothing. */
  lostGrants?: WorkerHomeGrantOutcome[];
  /** `true` the moment ONE compaction fired (`compactionEvents.length > 0`, MASTER-PLAN 8B). This call's acceptance proofs
   * must then be re-verified against repo state (W1-T3F), never trusted from a possibly-lossy REPORT. */
  qualitySuspect: boolean;
  /** Wall-clock milliseconds spent inside the SDK query, measured around {@link collectWorkerResult}'s message loop — the
   * pre-spawn setup above it is local and free. Optional, never guessed: a hand-built fixture omits it and
   * `workerLedgerFields` renders it absent rather than 0 (W1-T477). */
  workerDurationMs?: number;
  /** Reset-stable subscription-window percentage points consumed while this worker exclusively owned its selected provider.
   * Present only on the opt-in multi-provider path; the default Claude-only path performs no extra capacity reads and omits
   * this field byte-for-byte. */
  windowConsumption?: ProviderWindowConsumption;
}

/** `model`/`effort` label logged when a call rides no explicit mount override (e.g. recon, the advisory reviewer) — an honest
 * "unset", never a guessed value. */
export const DEFAULT_MODEL_LABEL = "default";
export const DEFAULT_EFFORT_LABEL = "default";

/** The DEFAULT billing mode. Absent the opt-in overflow valve, `buildWorkerEnv` strips every `ANTHROPIC_*` var before a worker
 * spawns (W1-T1), so the run is metered against the subscription. With the valve engaged (W1-T258) the mode is DERIVED per
 * call from the child's actual key set, so a ledger line reads the env names the worker really spawned with rather than a
 * guess. */
export const BILLING_MODE: BillingMode = "subscription";

/** Cache-token NAMED COLUMNS. Mirrors the nested camelCase `tokens.cacheRead`/`cacheCreation` as flat snake_case columns
 * matching the SDK envelope's own field names, so the cache-reuse signal MASTER-PLAN 8A asks for is grep- and jq-able off one
 * ledger line without reaching into a nested object (W1-T35). */
export function cacheTokenLedgerFields(tokens: TokenUsage): {
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
} {
  return {
    cache_read_input_tokens: tokens.cacheRead,
    cache_creation_input_tokens: tokens.cacheCreation,
  };
}

/** Persisted-stderr length ceiling. Bounds the PERSISTED copy so a runaway transcript cannot bloat the ledger; it never bounds
 * what stays in memory on {@link WorkerResult}.
 * Why: two "Not logged in" spawns died with their only diagnostic in memory (W1-T238). */
export const STDERR_EXCERPT_CAP = 4000;

/** Truncate `s` to {@link STDERR_EXCERPT_CAP} chars, noting how much was cut — never a silent drop. */
export function capStderrExcerpt(s: string, cap: number = STDERR_EXCERPT_CAP): string {
  return s.length > cap ? `${s.slice(0, cap)}…[truncated, ${s.length - cap} more chars]` : s;
}

/** The capped, ledger-safe excerpt of a FAILED spawn's stderr plus error-result text (W1-T238). Returns `undefined` for a
 * clean spawn, so a success line never carries an empty excerpt. */
export function workerFailureExcerpt(r: Pick<WorkerResult, "isError" | "stderr" | "text">): string | undefined {
  if (!r.isError) return undefined;
  const combined = [r.stderr, r.text].filter((s) => s && s.trim().length > 0).join("\n");
  return combined ? capStderrExcerpt(combined) : undefined;
}

/** Persisted-report length ceiling (W1-T407) — the same discipline as {@link STDERR_EXCERPT_CAP}, applied to a
 * terminal-SUCCESS worker's closing narrative rather than a failed spawn's stderr. run-task.ts's silent-no-op guard parses
 * that text three times and used to drop it when no PR came out of the run. */
export const REPORT_EXCERPT_CAP = 4000;

/** THE ONE JOIN, ONE PLACE. TRAP: the SDK's `result` echoes the last assistant block (measured on a real envelope), so a
 * hand-rolled `[r.text, r.blocks.join("\n")].join("\n")` carries the final message TWICE and every count-sensitive parse over
 * it over-counts. Same shape and ordering as that join, with the final message appearing exactly once and nothing dropped
 * when the last block is not a repeat, so "last marker line wins" parsing is unchanged (W1-T2205). */
export function workerTranscript(r: Pick<WorkerResult, "text" | "blocks">): string {
  const overlaps = r.blocks.length > 0 && r.blocks[r.blocks.length - 1] === r.text;
  const blocks = overlaps ? r.blocks.slice(0, -1) : r.blocks;
  return [r.text, ...blocks].join("\n");
}

/** The capped, ledger-safe excerpt of a worker's own report — `text` plus `blocks`, the shape run-task.ts's `fullText` closure
 * builds. Returns `undefined` for whitespace-only input, so a truly silent no-op carries no blank field: the "absent, never
 * empty" discipline {@link workerFailureExcerpt} keeps for stderr. */
export function noPrReportExcerpt(r: Pick<WorkerResult, "text" | "blocks">): string | undefined {
  const combined = [r.text, r.blocks.join("\n")].filter((s) => s && s.trim().length > 0).join("\n");
  const trimmed = combined.trim();
  return trimmed ? capStderrExcerpt(trimmed, REPORT_EXCERPT_CAP) : undefined;
}

/** The standard per-call ledger telemetry. Every worker and brain-plane call spreads THIS shape rather than hand-rolling it,
 * so fields cannot drift between recon, implement, review and retro. `verdict` is this CALL's outcome, distinct from the
 * RUN-level verdict line. Every optional field rides this ONE line for one reason: a reader must not need a second query to
 * interpret a zero — `quality_suspect`/`compaction_events` say whether an outcome is trustworthy,
 * `compaction_configured`/`compaction_failures` separate DISABLED from NEVER-NEEDED from FAILED, `max_turns` makes a row
 * checkable against the cap it ran under, and `stderr_excerpt` appears only when `r.isError`. `served_model` is ALWAYS
 * present, defaulted to `null`, so a silent provider renders an honest unknown rather than a key that looks forgotten, and an
 * unreportable model never fails the run (W1-T6, W1-T36, W1-T2245, W1-T303, W1-T238, W1-T2572). */
export function workerLedgerFields(r: WorkerResult): {
  provider?: "claude" | "codex";
  model: string;
  routed_model?: string;
  model_health_state?: ClaudeModelHealthState;
  model_health_source?: ClaudeModelHealthSource;
  served_model: string | null;
  served_model_reason?: string;
  effort: string;
  tokens: TokenUsage;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number;
  billing_mode: BillingMode;
  account_label?: string;
  verdict: string;
  quality_suspect: boolean;
  compaction_events: CompactionEvent[];
  compaction_configured: boolean;
  compaction_failures: CompactionFailure[];
  max_turns?: number;
  stderr_excerpt?: string;
  lost_grants?: string[];
  worker_duration_ms?: number;
  window_consumption?: {
    provider: "claude" | "codex";
    percent_consumed: number | null;
    window?: string;
    resets_at?: number | string;
    reason?: string;
  };
} {
  const stderrExcerpt = workerFailureExcerpt(r);
  return {
    ...(stderrExcerpt !== undefined ? { stderr_excerpt: stderrExcerpt } : {}),
    // Omitted when every grant landed, so the common case adds no field. Present only when a grant was lost or healed, and
    // then it names which slot and why.
    ...(r.lostGrants?.length
      ? {
          lost_grants: r.lostGrants.map((g) =>
            g.state === "displaced" ? `${g.relFrom}: displaced to ${g.displacedTo}` : `${g.relFrom}: ${g.reason ?? "failed"}`,
          ),
        }
      : {}),
    ...(r.provider ? { provider: r.provider } : {}),
    model: r.model,
    ...(r.routedModel ? { routed_model: r.routedModel } : {}),
    ...(r.modelHealthState ? { model_health_state: r.modelHealthState } : {}),
    ...(r.modelHealthSource ? { model_health_source: r.modelHealthSource } : {}),
    // Always present: `null` is the honest value for "unreportable", never an omitted key that reads as forgotten. See {@link
    // WorkerResult.servedModel} for the contract (W1-T2572).
    served_model: r.servedModel ?? null,
    ...(r.servedModel == null
      ? { served_model_reason: r.servedModelReason ?? "the provider reported no served model for this call" }
      : {}),
    effort: r.effort,
    tokens: r.tokens,
    ...cacheTokenLedgerFields(r.tokens),
    total_cost_usd: r.costUsd,
    billing_mode: billingMode(r.childEnvKeys),
    max_turns: r.maxTurns,
    // The account this spend is attributed to — a NAME, never a credential, carried verbatim off `WorkerResult.accountLabel`.
    // `undefined`, never guessed, when none resolved (W1-T268).
    account_label: r.accountLabel,
    // A REFUSAL OUTRANKS THE ENVELOPE'S OWN SUBTYPE, and the ordering IS the fix: the subtype is exactly the field that lies
    // here. The old ternary rendered both arms "success" on the swallow path, because a SUCCESS envelope wrote `subtype`
    // before the SDK threw. Every other path is unchanged.
    // Why: 793 refusals across five rungs were recorded as completed work (W1-T2564).
    verdict: r.usageRefusal ? "usage_refused" : r.isError ? r.subtype : "success",
    ...(r.usageRefusal
      ? {
          usage_refused: true,
          usage_refusal_matched: r.usageRefusal.matched,
          ...(r.usageRefusal.resetsAtText === undefined ? {} : { usage_resets_at_text: r.usageRefusal.resetsAtText }),
          ...(r.usageRefusal.resetsAtMs === undefined
            ? {}
            : { usage_resets_at: new Date(r.usageRefusal.resetsAtMs).toISOString() }),
        }
      : {}),
    quality_suspect: r.qualitySuspect,
    compaction_events: r.compactionEvents,
    // Defaults for the pre-existing fixture literals across test/; a real `collectWorkerResult` call always populates both
    // explicitly (W1-T2245).
    compaction_configured: r.compactionConfigured ?? false,
    compaction_failures: r.compactionFailures ?? [],
    // Per-call wall-clock, mirrored verbatim off `WorkerResult.workerDurationMs`. `undefined`, never a guessed 0, on a
    // fixture that never spawned; JSON.stringify then drops the key entirely — the same "absent, never guessed" discipline
    // `max_turns` keeps (W1-T477).
    worker_duration_ms: r.workerDurationMs,
    ...(r.windowConsumption
      ? {
          window_consumption: {
            provider: r.windowConsumption.provider,
            percent_consumed: r.windowConsumption.percentConsumed,
            ...(r.windowConsumption.windowName ? { window: r.windowConsumption.windowName } : {}),
            ...(r.windowConsumption.resetsAt !== undefined ? { resets_at: r.windowConsumption.resetsAt } : {}),
            ...(r.windowConsumption.reason ? { reason: r.windowConsumption.reason } : {}),
          },
        }
      : {}),
  };
}

/** The fields a previously-discarded {@link WorkerHomeReapResult} becomes once observed: target, reason and spawn identity, so
 * a query can answer whether a reap ever raced a live sibling spawn. Pure, so a test drives every arm with no process
 * spawned. NOT a ledger row (this module writes none) and deliberately outside `DECISION_RELEVANT_LEDGER_STEPS`, since
 * nothing downstream reads it to decide (W1-T2441). */
export function workerHomeReapLogFields(
  result: WorkerHomeReapResult,
  spawn: { runId?: string; taskId?: string },
): Record<string, unknown> {
  return {
    step: "worker_home_reap",
    reaped: result.reaped,
    target: result.target,
    reason: result.reason,
    run_id: spawn.runId,
    task_id: spawn.taskId,
  };
}

/** Default {@link SpawnWorkerArgs.logHomeReap} sink — one JSON line to stderr, matching this file's other best-effort
 * exit-path diagnostics (e.g. `assertWorktreeBaseCurrent`'s `warn`). */
function defaultLogHomeReap(result: WorkerHomeReapResult, spawn: { runId?: string; taskId?: string }): void {
  console.error(JSON.stringify(workerHomeReapLogFields(result, spawn)));
}

/** The fields `ensureWorkerKeychain`'s {@link WorkerKeychainSummary} becomes once observed here. Logged on EVERY darwin
 * provisioning call, `expectedRunMs` supplied or not, so the rate the expiry margin is really exercised becomes answerable
 * off-host. Pure, for the same reason {@link workerHomeReapLogFields} is.
 * Why: `observedHeadroomMs` shipped in W1-T2398 with this call site discarding it (W1-T2518). */
export function workerKeychainHeadroomLogFields(
  summary: WorkerKeychainSummary,
  expectedRunMs: number | undefined,
  spawn: { runId?: string; taskId?: string },
): Record<string, unknown> {
  return {
    step: "worker_keychain_headroom",
    observed_headroom_ms: summary.observedHeadroomMs,
    expected_run_ms: expectedRunMs,
    provision_reason: summary.reason,
    run_id: spawn.runId,
    task_id: spawn.taskId,
  };
}

/** Default {@link SpawnWorkerArgs.logKeychainHeadroom} sink — one JSON line to stderr, matching this file's other best-effort
 * exit-path diagnostics (e.g. `defaultLogHomeReap` above). */
function defaultLogKeychainHeadroom(
  summary: WorkerKeychainSummary,
  expectedRunMs: number | undefined,
  spawn: { runId?: string; taskId?: string },
): void {
  console.error(JSON.stringify(workerKeychainHeadroomLogFields(summary, expectedRunMs, spawn)));
}

// ── Toolchain resolution ──────────────────────────────────────────────────
//
// TRAP: `config.claudeBin` is resolved once by `which claude` and then CACHED TO DISK, so an auto-update
// can move the real binary out from under it mid-operation. Resolution below runs FRESH at spawn time —
// operator override, live PATH lookup, then the install-location table — memoized per process and
// preflight-checked, so a bad resolution fails loud before any worker-home or keychain work rather than
// deep inside a spawn.
// Why: the vanished-binary incident (W1-T113; MASTER-PLAN Field Finding 12).

/** Operator escape hatch: an explicit path always wins over PATH/the table. */
export const CLAUDE_BIN_ENV_OVERRIDE = "REMUDERO_CLAUDE_BIN";

/** One row of the install-location table — DATA: adding a row resolves a newly seeded location with no resolution-code change.
 * `resolve` returns `undefined` when the row does not apply; a row that does apply is still existence- and
 * runnability-checked, never trusted blind (W1-T113). */
export interface ClaudeExecutableCandidate {
  /** Short label carried into the refusal reason and the boot log. */
  label: string;
  resolve: (env: NodeJS.ProcessEnv, home: string) => string | undefined;
}

/** The known Claude Code install locations, in order — the FIRST existing and runnable candidate wins. Verified from the
 * upstream repo rather than from memory (Standing rule 7): the README's "Installation via npm is deprecated" plus the
 * CHANGELOG entries naming `~/.local/bin/claude` as the native-installer launcher, distinct from the npm-global prefix this
 * fleet still uses (MASTER-PLAN Field Finding 3). */
export const CLAUDE_EXECUTABLE_LOCATIONS: ClaudeExecutableCandidate[] = [
  { label: "npm-global", resolve: (_env, home) => join(home, ".npm-global", "bin", "claude") },
  { label: "native-installer (~/.local/bin)", resolve: (_env, home) => join(home, ".local", "bin", "claude") },
];

/** The cause of a probed candidate's `--version` failure: an errno or exit `code` plus at most a truncated first line of
 * stderr. Deliberately narrow — never the child environment (the W1-T442 billing and credential boundary) and never an
 * unbounded stderr dump (W1-T901 design (iii)). */
export interface CanExecuteFailure {
  code?: string;
  message?: string;
}

/** One resolution attempt, kept for the refusal reason: which label, which path, whether it existed, whether it ran (only
 * meaningful if it did), and — when it existed but didn't run — the probe's cause (W1-T901). */
export interface SearchedClaudeCandidate {
  label: string;
  path: string;
  existed: boolean;
  ran: boolean;
  cause?: CanExecuteFailure;
}

/** `SearchedClaudeCandidate` -> its outcome, for the refusal message. A candidate that exists but did not run names its cause
 * when one was captured, so a non-executable husk is distinguishable from a binary that runs and crashes; with no cause it
 * falls back to the bare message unchanged (W1-T901, W1-T113). */
function describeSearched(s: SearchedClaudeCandidate): string {
  if (!s.existed) return "missing";
  if (s.ran) return "ok";
  const parts = [s.cause?.code, s.cause?.message].filter((p): p is string => !!p);
  return parts.length ? `exists, --version failed (${parts.join(": ")})` : "exists, --version failed";
}

/** Structured refusal thrown when NO candidate resolves to an existing, runnable executable. Classified as infrastructure,
 * never a task defect (W1-T91). Carries every searched path, so the reason distinguishes "missing" from "exists but
 * `--version` failed". `reasonClass` is a plain string tag, not `instanceof`, so daemon.ts can classify this duck-typed
 * without importing the class as a value. */
export class ClaudeToolchainBlockedError extends Error {
  readonly reasonClass = "blocked_toolchain" as const;
  readonly searched: SearchedClaudeCandidate[];
  constructor(searched: SearchedClaudeCandidate[]) {
    const detail = searched.length
      ? searched.map((s) => `${s.label}=${s.path} (${describeSearched(s)})`).join("; ")
      : "(no candidates configured)";
    super(`claude executable not found or not runnable — searched: ${detail}`);
    this.name = "ClaudeToolchainBlockedError";
    this.searched = searched;
  }
}

/** Per-process memo (see `createClaudeExecutableCache`) — resolution runs at most once per process; every later `spawnWorker`
 * call reuses the answer. */
export interface ClaudeExecutableCache {
  resolved?: string;
}

export function createClaudeExecutableCache(): ClaudeExecutableCache {
  return {};
}

/** Injectable seams for `resolveClaudeExecutable`. The real call site defaults every one to the live filesystem, PATH and
 * subprocess; tests inject fakes so "pinned path absent, table hit" and "everything absent" are provable with no real binary. */
export interface ResolveClaudeExecutableDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
  /** A LIVE `which claude` lookup, never PATH resolved once and cached to disk — that staleness is config.ts's
   * `resolveClaudeBin`, which this routes around. `undefined` when `claude` is off PATH. */
  which?: () => string | undefined;
  /** Does this path actually run (`--version`)? `true` on success. A failure may answer a bare `false` — every existing
   * injection site does, and stays valid — or a `CanExecuteFailure` carrying the probe's cause for the refusal message to
   * render (W1-T901 design (i)). */
  canExecute?: (path: string) => boolean | CanExecuteFailure;
  /** The candidate table — DATA, defaults to `CLAUDE_EXECUTABLE_LOCATIONS`. */
  locations?: ClaudeExecutableCandidate[];
}

function defaultWhich(): string | undefined {
  try {
    const out = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Cap on the captured stderr excerpt (W1-T901 design (iii)) — a diagnosis needs a first line, not a dump. */
const CAN_EXECUTE_FAILURE_MESSAGE_MAX = 200;

/** `execFileSync`'s thrown error becomes a `CanExecuteFailure`: the errno or exit `code` Node attaches plus at most a
 * truncated first non-empty line of stderr. Invariant: never touch the error's `.cmd`, which may embed argv, and never read
 * `process.env` — the child's environment must not enter this message (W1-T442). */
function describeExecFailure(err: unknown): CanExecuteFailure {
  const e = err as (NodeJS.ErrnoException & { stderr?: Buffer | string | null }) | undefined;
  const code = typeof e?.code === "string" ? e.code : undefined;
  const stderrText = e?.stderr ? e.stderr.toString() : "";
  const firstLine = stderrText.split("\n").find((line) => line.trim().length > 0)?.trim();
  const message = firstLine ? firstLine.slice(0, CAN_EXECUTE_FAILURE_MESSAGE_MAX) : undefined;
  return { code, message };
}

function defaultCanExecute(path: string): boolean | CanExecuteFailure {
  try {
    // stdout ignored; stderr piped so a crashing binary's first diagnostic line is capturable, still bounded and never the
    // child env — see describeExecFailure above.
    execFileSync(path, ["--version"], { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch (err) {
    return describeExecFailure(err);
  }
}

/** Resolve the real `claude` binary at SPAWN time: env override, then a live PATH lookup, then the location table, memoized
 * once an answer is found. Every candidate is preflighted — it must exist AND run `--version` — and one that exists but will
 * not run is recorded as such, distinct from missing. Throws {@link ClaudeToolchainBlockedError}, never a raw ENOENT, naming
 * every searched path, so the run is refused cleanly rather than crashing deep inside the SDK's spawn (W1-T113). */
export function resolveClaudeExecutable(cache: ClaudeExecutableCache, deps: ResolveClaudeExecutableDeps = {}): string {
  if (cache.resolved) return cache.resolved;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const exists = deps.exists ?? existsSync;
  const which = deps.which ?? defaultWhich;
  const canExecute = deps.canExecute ?? defaultCanExecute;
  const locations = deps.locations ?? CLAUDE_EXECUTABLE_LOCATIONS;

  // One ordered candidate list walked by a single loop. Every row is the same shape — a label plus a lazy `resolve` — so
  // PATH's subprocess call and the table's plain path joins are short-circuited identically: a row resolves only once every
  // earlier row has failed.
  const candidates: ClaudeExecutableCandidate[] = [
    { label: `env:${CLAUDE_BIN_ENV_OVERRIDE}`, resolve: (e) => e[CLAUDE_BIN_ENV_OVERRIDE] },
    { label: "PATH", resolve: () => which() },
    ...locations,
  ];

  const searched: SearchedClaudeCandidate[] = [];
  for (const candidate of candidates) {
    const path = candidate.resolve(env, home);
    if (!path) continue;
    const existed = exists(path);
    // Only a probed (existing) candidate can carry a cause; a missing one is never probed at all, which is W1-T113's
    // exists/missing distinction, unchanged by W1-T901.
    const probe = existed ? canExecute(path) : false;
    const ran = probe === true;
    const cause = existed && !ran && typeof probe === "object" ? probe : undefined;
    searched.push({ label: candidate.label, path, existed, ran, cause });
    if (ran) {
      cache.resolved = path;
      return path;
    }
  }

  throw new ClaudeToolchainBlockedError(searched);
}

/** The shared, per-process cache every real `spawnWorker` call reuses. Exported so the daemon's boot routine logs the SAME
 * answer once at startup rather than resolving separately (W1-T113). */
export const claudeExecutableCache: ClaudeExecutableCache = createClaudeExecutableCache();

/** Pure: the macOS keychain grant list — the FRESHLY resolved `claudeBin`, never `config.claudeBin`'s stale disk-cached value,
 * plus the fixed `/usr/bin/security` helper. Split out so this is unit-testable without a real keychain side effect or a
 * `process.platform` gate (W1-T113). */
export function workerKeychainGrantApps(claudeBin: string): string[] {
  return [claudeBin, "/usr/bin/security"];
}

/** The Anthropic account identity active on this host — an `accountUuid`/`emailAddress` NAME read fresh, never cached, and
 * forwarded to `ensureWorkerKeychain`'s `accountId` so an account switch is detected. TRAP: do NOT use the keychain item's
 * own `acct` attribute — account-usage.ts measured it to be the OS username, identical across a switch. A private
 * re-implementation rather than an import, because account-usage.ts depends on panel-actions.ts, which depends on this file.
 * Fails soft (W1-T265). */
export function resolveActiveAccountId(path: string = join(homedir(), ".claude.json")): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      oauthAccount?: { accountUuid?: unknown; emailAddress?: unknown };
    };
    const uuid = parsed.oauthAccount?.accountUuid;
    if (typeof uuid === "string" && uuid !== "") return uuid;
    const email = parsed.oauthAccount?.emailAddress;
    return typeof email === "string" && email !== "" ? email : undefined;
  } catch {
    return undefined;
  }
}

/** `<root>/state/account-usage-projection.json`. Invariant: it MUST equal account-usage.ts's own `USAGE_PROJECTION_REL`.
 * Duplicated rather than imported for the cycle reason {@link resolveActiveAccountId} gives, and a test asserts the two
 * literals stay equal (W1-T2516). */
export const WORKER_USAGE_PROJECTION_REL = join("state", "account-usage-projection.json");

/** Capture the worker's usage cache before its home is reaped. Every worker's HOME is redirected, so the
 * `cachedUsageUtilization` its own Claude Code invocation refreshes lands in `<workerHome>/.claude.json`, which
 * `reapWorkerHome` deletes moments later — and nothing here ever wrote the panel's primary source, so on a headless host that
 * never refreshes. Called from `spawnWorker`'s `finally` BEFORE the reap, while the file still exists. Persists a narrower
 * cut than it reads — uuid, `fetchedAtMs`, the two usage windows, and DELIBERATELY never email, org or anything OAuth-shaped
 * — written temp-then-`renameSync` so a reader never sees a half-written file. Best-effort and silent; returns whether a
 * projection was written (W1-T2516). */
export function captureWorkerUsageProjection(
  root: string,
  workerHome: string,
  fsImpl: {
    readFileSync: typeof readFileSync;
    writeFileSync: typeof writeFileSync;
    mkdirSync: typeof mkdirSync;
    renameSync: typeof renameSync;
  } = { readFileSync, writeFileSync, mkdirSync, renameSync },
): boolean {
  try {
    const raw = fsImpl.readFileSync(join(workerHome, CLAUDE_CONFIG_REL), "utf8");
    const parsed = JSON.parse(raw) as {
      cachedUsageUtilization?: {
        accountUuid?: unknown;
        fetchedAtMs?: unknown;
        utilization?: {
          five_hour?: { utilization?: unknown; resets_at?: unknown } | null;
          seven_day?: { utilization?: unknown; resets_at?: unknown } | null;
        };
      };
    };
    const cache = parsed.cachedUsageUtilization;
    if (typeof cache?.fetchedAtMs !== "number" || !Number.isFinite(cache.fetchedAtMs)) return false;

    const window = (w: { utilization?: unknown; resets_at?: unknown } | null | undefined) => {
      if (!w) return undefined;
      const out: { percentUsed?: number; resetsAt?: string } = {};
      if (typeof w.utilization === "number" && Number.isFinite(w.utilization)) out.percentUsed = w.utilization;
      if (typeof w.resets_at === "string" && w.resets_at !== "") out.resetsAt = w.resets_at;
      return out.percentUsed === undefined && out.resetsAt === undefined ? undefined : out;
    };

    const projection: Record<string, unknown> = { cacheFetchedAtMs: cache.fetchedAtMs };
    if (typeof cache.accountUuid === "string" && cache.accountUuid !== "") projection.cacheUuid = cache.accountUuid;
    const fiveHour = window(cache.utilization?.five_hour);
    if (fiveHour) projection.fiveHour = fiveHour;
    const sevenDay = window(cache.utilization?.seven_day);
    if (sevenDay) projection.sevenDay = sevenDay;

    const target = join(root, WORKER_USAGE_PROJECTION_REL);
    fsImpl.mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fsImpl.writeFileSync(tmp, JSON.stringify(projection));
    fsImpl.renameSync(tmp, target);
    return true;
  } catch {
    return false; // best-effort — never blocks or fails a spawn's teardown
  }
}

export interface SpawnWorkerArgs {
  cwd: string;
  permissionMode: PermissionMode;
  /** Path to the worker settings file (permissions + hooks + sandbox). */
  settingsFile: string;
  /** Tool names this spawn is never offered, threaded to the SDK's `Options.disallowedTools`. Deliberately NOT the settings
   * `deny` list: that floor is hook-enforced, and {@link DenyFloorVerdict} exists because the block can LEAK under
   * `bypassPermissions` (claude-code#20946), whereas a disallowed tool is never presented to the model at all. Default
   * UNRESTRICTED (W1-T2591). */
  disallowedTools?: readonly string[];
  prompt: string;
  /** Resume an existing session (auto-choose round-trip, fix rounds). */
  resumeSessionId?: string;
  /** Extra env vars merged into the allowlisted child env (never ANTHROPIC_*). */
  env?: Record<string, string>;
  model?: string;
  /** Reasoning effort (mount-resolved, §9): 'low'|'medium'|'high'|'xhigh'|'max'. */
  effort?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  config?: Config;
  /** Capacity-reader seams for provider-routing tests; production reads both subscriptions live. */
  providerRouting?: {
    readClaudeHealth?: () => Promise<ClaudeModelHealthReading>;
    readClaude?: (request?: Pick<ClaudeCapacityDeps, "forceRefresh">) => Promise<ProviderCapacity>;
    readCodex?: (
      config: Config,
      request: Pick<CodexCapacityDeps, "requestedModel" | "requestedEffort" | "forceRefresh" | "selectedModel" | "preferredModel" | "reservePercent" | "capabilities">,
    ) => Promise<ProviderCapacity>;
    /** Test seam for the selected Codex spawn; production uses the real contained CLI adapter. */
    spawnCodex?: (
      // The Codex spawn REQUIRES the redirected per-spawn worker home, threaded explicitly rather than inferred from
      // `process.env.HOME` or `args.env` ordering, so a test double is held to the contract the real `spawnCodexWorker` is
      // (W1-T2800).
      args: SpawnWorkerArgs & { workerHome: string; zdotdir?: string },
      config: Config,
      selection?: Pick<ProviderCapacity, "model" | "effort">,
    ) => Promise<WorkerResult>;
    tieBreaker?: number;
    /** Best-effort durable projection for the console; never allowed to change spawn outcome. */
    writeStatus?: typeof writeProviderRoutingStatus;
    now?: () => number;
  };
  /** Restrict the model's base built-in tool set (SDK `Options.tools`). Unset means the SDK default. Passing e.g. `["Bash"]`
   * makes a worker read-only BY CONSTRUCTION: Write/Edit/ NotebookEdit/MultiEdit never enter the model's context, so it
   * cannot use one even if asked (isolation.ts's preflight probe, W1-T17). */
  tools?: string[];
  /** Override the toolchain-resolution cache and seams. Omitted means the shared per-process `claudeExecutableCache` and live
   * fs/PATH/subprocess; tests inject a fresh cache and fakes here rather than reaching into the module-level singleton
   * (W1-T113). */
  claudeExecutable?: { cache?: ClaudeExecutableCache; deps?: ResolveClaudeExecutableDeps };
  /** Override the darwin-only keychain-provisioning gate and seams. Omitted means the real `process.platform` and
   * `ensureWorkerKeychain`'s live defaults; tests inject `platform: "darwin"` plus a fake runner and exists to drive this
   * gate on a non-macOS runner with no real keychain (W1-T113). */
  keychain?: {
    platform?: NodeJS.Platform;
    runner?: SecurityRunner;
    exists?: (path: string) => boolean;
    /** Injectable reader for the NON-DARWIN credential file, mirroring `runner`/`exists`. Omitted reads the real file. The
     * suite drives that production default against real fixture files, because a test that only ever supplies its own reader
     * proves nothing about the shipping path. */
    readCredentialFile?: (path: string) => string;
    /** The active Anthropic account identity for THIS spawn — a NAME, never a secret — so an account switch under the
     * unlabelled default store re-provisions instead of silently spending the stale copy. Omitted resolves fresh via {@link
     * resolveActiveAccountId}, never off the keychain's `acct` (W1-T265). */
    accountId?: string;
    /** Set when the PRIOR spawn died on the containment preflight's expiry-named reason, forcing re-provisioning even when the
     * sidecar expiry check saw nothing wrong. NOT YET WIRED to any containment token — this is the hook a future caller sets
     * (W1-T293 arm 3). */
    priorSpawnCredentialExpired?: boolean;
    /** The dispatcher's own run-length estimate, forwarded verbatim to `ensureWorkerKeychain`'s `expectedRunMs`; a real
     * estimate belongs at this call site, never invented inside worker-home.ts. Supplied, it widens the effective expiry skew
     * and — after a re-provision attempt — refuses the spawn with `credential-too-short-for-run` when even a fresh credential
     * cannot outlast the run. Appended LAST, so no positional caller shifts (W1-T2518, W1-T2398). */
    expectedRunMs?: number;
  };
  /** Attribution markers threaded into the child's env. Env propagates downhill through `bash -c`, so every descendant
   * inherits them and the orphan sweep attributes a stray survivor back to its run and task. Optional: omitting them still
   * gets process-group containment, but a survivor cannot be re-attributed if teardown itself never ran (W1-T117). */
  runId?: string;
  taskId?: string;
  /** Injectable seam: override the process-group spawn and teardown. Omitted means the real
   * `spawnDetachedGroup`/`teardownProcessGroup`, so containment wiring stays provable without a real `claude` binary
   * (W1-T117). */
  containment?: {
    spawn?: (
      opts: ContainedSpawnOptions,
      onStderr?: (chunk: string) => void,
      onSpawnError?: (err: NodeJS.ErrnoException) => void,
    ) => ContainedProcess;
    teardown?: (pgid: number) => void;
  };
  /** Sink for a spawn's ASYNCHRONOUS 'error' event — the only place the errno appears, since the no-pid throw unwinds before
   * the event fires. A callback rather than a holder the caller reads after catching, and the reason is a race: the event may
   * not have fired when the catch runs, so a holder is read too early exactly when the spawn failed fastest. Wired here but
   * destined for run-task.ts's ledger, which worker.ts cannot reach. Omitted swallows the error as before (W1-T442). */
  onSpawnError?: (err: NodeJS.ErrnoException) => void;
  /** Injectable seam: override the SDK's own `query()` entry point. Omitted means the real SDK `query`, a live `claude`
   * subprocess. Tests inject a fake async iterable so the process-group teardown wiring is exercised end to end, on both
   * paths, with no real binary (W1-T117). */
  queryFn?: typeof query;
  /** Forwarded verbatim to {@link collectWorkerResult}'s `streamObserver` — the ONE seam turning the SDK message stream this
   * call already consumes into working, tool-executing and heartbeat events. Omitted leaves behaviour byte-identical.
   * run-task.ts wires the REAL observer at its own spawn call sites, so `worker.state` comes from live runs and not only from
   * a test (Standing rule 14; W1-T942). */
  streamObserver?: WorkerStreamObserver;
  /** THE CLOCK BOUND. Omitted means no `AbortController` is constructed at all. When set, {@link
   * createWorkerClockBoundWatchdog} aborts THIS call's query once `boundMs` elapses since the last observed stream activity —
   * never on total run age — and `spawnWorker` throws {@link WorkerAbandonedError} carrying the evidence. run-task.ts wires
   * the real bound at its dispatch-spawn wrapper, never here (Standing rule 14; W1-T1045). */
  clockBound?: { boundMs: number; now?: () => number; pollMs?: number };
  /** Observe the per-spawn worker-home reap this teardown already runs. `reapWorkerHome` ALREADY COMPUTES a {@link
   * WorkerHomeReapResult} naming what it removed and why, and that value was discarded in statement position until this.
   * Called on EVERY exit path including a thrown error, never allowed to throw. INSTRUMENTATION ONLY: it observes, it never
   * decides what is reaped or when (W1-T2441). */
  logHomeReap?: (result: WorkerHomeReapResult, spawn: { runId?: string; taskId?: string }) => void;
  /** Sink for the darwin keychain rung's {@link WorkerKeychainSummary}, observed on EVERY darwin provisioning call whether or
   * not `expectedRunMs` was supplied, so how often the credential's expiry margin is really exercised becomes answerable
   * off-host. Never called on the non-darwin path, which returns no summary. Omitted logs {@link defaultLogKeychainHeadroom}
   * to stderr (W1-T2518). */
  logKeychainHeadroom?: (
    summary: WorkerKeychainSummary,
    expectedRunMs: number | undefined,
    spawn: { runId?: string; taskId?: string },
  ) => void;
}

let providerTieBreaker = 0;
let claudeCapacityCache: { at: number; value: ProviderCapacity } | undefined;

export interface ClaudeCapacityDeps {
  now?: () => number;
  openSession?: () => UsageProbeSession;
  /** Bypass the routing cache at an attribution boundary. */
  forceRefresh?: boolean;
  /** W1-T2828: which account this reading is taken under. Injectable — appended LAST so no
   *  existing caller shifts — and defaulting to {@link readClaudeAccountLabel}. */
  accountLabel?: () => string | undefined;
}

export function clearClaudeCapacityCache(): void {
  claudeCapacityCache = undefined;
}


/**
 * The account a Claude capacity reading was taken under — `oauthAccount.accountUuid`.
 *
 * The operator switches subscriptions by hand, and every instrument follows whatever Claude Code
 * is logged into, so two readings from two accounts are indistinguishable in the ledger. The uuid
 * is stable per account and answers "which account", which is the entire question.
 *
 * NEVER emailAddress OR organizationName. They sit beside the uuid in the same object and are
 * unnecessary exposure; only `accountUuid` is ever bound here, so the others cannot reach a caller
 * even by accident. This mirrors account-usage.ts's own discipline.
 *
 * FAILS OPEN, ALWAYS. An absent, unreadable, unparseable or shape-changed file yields `undefined`,
 * never a throw: the label annotates a reading and is never a precondition for taking one. A host
 * with one account has run fine without it for months and must keep running.
 *
 * FALSIFIER: test/the-capacity-read-cannot-say-which-account-it-measured.test.ts.
 */
/** Why a reading carries no label. Four distinct causes, kept apart for the same reason
 *  account-usage.ts keeps its own: "absent" and "unreadable" are different facts. */
export type ClaudeAccountLabelReason = "unreadable" | "unparseable" | "not-an-object" | "no-account" | "no-uuid";

export type ClaudeAccountLabelRead =
  | { readonly label: string }
  | { readonly label: undefined; readonly reason: ClaudeAccountLabelReason };

/** {@link readClaudeAccountLabel}'s answer WITH its reason. Every failure path names which one it
 *  took, so a host with no label can be told apart from one whose file changed shape. */
export function readClaudeAccountLabelDetailed(
  path: string = join(homedir(), CLAUDE_CONFIG_REL),
  readFile: (p: string, enc: "utf8") => string = readFileSync,
): ClaudeAccountLabelRead {
  let raw: string;
  try {
    raw = readFile(path, "utf8");
  } catch {
    return { label: undefined, reason: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { label: undefined, reason: "unparseable" };
  }
  if (typeof parsed !== "object" || parsed === null) return { label: undefined, reason: "not-an-object" };
  const account: unknown = (parsed as { oauthAccount?: unknown }).oauthAccount;
  if (typeof account !== "object" || account === null) return { label: undefined, reason: "no-account" };
  const uuid: unknown = (account as { accountUuid?: unknown }).accountUuid;
  if (typeof uuid !== "string" || uuid.trim() === "") return { label: undefined, reason: "no-uuid" };
  return { label: uuid };
}

/** The label alone — what the capacity read needs. Fails open to `undefined` on every cause. */
export function readClaudeAccountLabel(
  path: string = join(homedir(), CLAUDE_CONFIG_REL),
  readFile: (p: string, enc: "utf8") => string = readFileSync,
): string | undefined {
  return readClaudeAccountLabelDetailed(path, readFile).label;
}

export async function readClaudeProviderCapacity(
  config: Config,
  deps: ClaudeCapacityDeps = {},
): Promise<ProviderCapacity> {
  const now = deps.now ?? Date.now;
  const cacheMs = config.workerProviders?.capacityCacheMs ?? 60_000;
  if (!deps.forceRefresh && claudeCapacityCache && now() - claudeCapacityCache.at < cacheMs) return claudeCapacityCache.value;
  const session = (deps.openSession ?? openUsageProbeSession)();
  try {
    const method = session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof method !== "function") {
      const value = claudeCapacityFromUsage(undefined);
      claudeCapacityCache = { at: now(), value };
      return value;
    }
    try {
      const value = claudeCapacityFromUsage(
        usageSnapshotFromSdk(await method.call(session) as never),
        (deps.accountLabel ?? readClaudeAccountLabel)(),
      );
      claudeCapacityCache = { at: now(), value };
      return value;
    } catch (error) {
      const value: ProviderCapacity = {
        provider: "claude",
        readable: false,
        windows: [],
        detail: `capacity read failed: ${String((error as Error)?.message ?? error)}`,
      };
      claudeCapacityCache = { at: now(), value };
      return value;
    }
  } finally {
    try {
      await session.return?.(undefined);
    } catch {
      /* capacity teardown never masks the capacity verdict */
    }
  }
}

/** Worker checkouts carry the repository-owned capability policy. TRAP: `config.root` is the daemon state root on the fleet,
 * not the repository root, so resolving from it silently misses `.remudero/mounts.yaml`. Task workers use their checkout
 * `cwd`; early isolation probes run before that worktree exists, so they fall back to the module's installed repository root.
 * Neither path guesses from the state root. */
function resolveWorkerCapabilities(cwd: string): CapabilityLadder | undefined {
  const installRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  for (const root of new Set([cwd, installRoot])) {
    try {
      return loadMounts(mountsPath(root)).capabilities;
    } catch {
      // Try the next repository-owned location; a missing/malformed table remains fail-soft.
    }
  }
  return undefined;
}

async function resolveWorkerClaudeHealth(
  args: SpawnWorkerArgs,
  capabilities: CapabilityLadder | undefined,
): Promise<ClaudeModelHealthRoute> {
  let reading: ClaudeModelHealthReading;
  const requestedCapability = args.model ? capabilities?.claude[args.model.toLowerCase()] : undefined;
  if (!args.model) {
    reading = { degradedModels: [], source: "unknown", detail: "no concrete or aliased Claude model was requested" };
  } else if (!capabilities) {
    reading = { degradedModels: [], source: "unknown", detail: "worker capability table is unavailable" };
  } else if (!requestedCapability) {
    reading = { degradedModels: [], source: "unknown", detail: `requested model '${args.model}' is absent from the capability table` };
  } else if (args.providerRouting?.readClaudeHealth) {
    try {
      reading = await args.providerRouting.readClaudeHealth();
    } catch (error) {
      // Advisory status failure is preserved as unknown health; it must not disable Claude.
      reading = { degradedModels: [], source: "unknown", detail: String((error as Error)?.message ?? error) };
    }
  } else if (args.queryFn !== undefined) {
    // A synthetic Claude query is the established paid-spawn test seam. Keep older worker tests network-free unless they
    // explicitly inject health evidence; the resolver itself still runs.
    reading = { degradedModels: [], source: "unknown", detail: "model health not injected for synthetic query" };
  } else {
    reading = await readClaudeModelHealth(capabilities, { now: args.providerRouting?.now });
  }
  return resolveClaudeModelHealth(args.model, capabilities, reading);
}

function unavailableClaudeCapacity(route: ClaudeModelHealthRoute): ProviderCapacity {
  return {
    provider: "claude",
    readable: false,
    windows: [],
    detail: route.detail ?? "every same-capability Claude candidate is named in an unresolved incident",
  };
}

function annotateClaudeCapacity(
  capacity: ProviderCapacity,
  route: ClaudeModelHealthRoute,
  effort: string | undefined,
): ProviderCapacity {
  const healthDetail = route.state === "degraded" && route.routedModel
    ? `model-health fallback ${route.requestedModel ?? "default"} -> ${route.routedModel} (${route.source})`
    : undefined;
  return {
    ...capacity,
    ...(route.routedModel ? { model: route.routedModel } : {}),
    ...(effort ? { effort } : {}),
    ...(healthDetail ? { detail: capacity.detail ? `${capacity.detail}; ${healthDetail}` : healthDetail } : {}),
  };
}

let activeWorkerSpawns = 0;

/** Current whole-process worker occupancy. Builds and reviews share this one counter. */
export function activeWorkerCount(): number {
  return activeWorkerSpawns;
}

function claimWorkerOccupancy(): () => void {
  activeWorkerSpawns += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWorkerSpawns = Math.max(0, activeWorkerSpawns - 1);
  };
}

/** Claim one process-wide worker slot for the complete async operation and release it on every settlement, including an
 * AbortError/cancellation rejection. Exported so the finally contract is testable without a paid provider spawn. */
export async function withWorkerOccupancy<T>(operation: () => Promise<T>): Promise<T> {
  const release = claimWorkerOccupancy();
  try {
    return await operation();
  } finally {
    release();
  }
}

async function readFreshSelectedCapacity(
  args: SpawnWorkerArgs,
  config: Config,
  selection: ProviderSelection,
  capabilities?: CapabilityLadder,
): Promise<ProviderCapacity> {
  if (selection.provider === "codex") {
    return (args.providerRouting?.readCodex ?? readCodexCapacity)(config, {
      requestedModel: args.model,
      requestedEffort: args.effort,
      forceRefresh: true,
      selectedModel: selection.capacity.model,
      ...(args.model && capabilities ? { capabilities } : {}),
    });
  }
  return (args.providerRouting?.readClaude ?? ((request) => readClaudeProviderCapacity(config, request)))({
    forceRefresh: true,
  });
}

async function beginSelectedCapacityMeasurement(
  args: SpawnWorkerArgs,
  config: Config,
  selection: ProviderSelection,
  capabilities?: CapabilityLadder,
): Promise<ProviderWindowMeasurement | undefined> {
  try {
    return beginProviderWindowMeasurement(await readFreshSelectedCapacity(args, config, selection, capabilities));
  } catch {
    // Attribution telemetry is best-effort: an unreadable boundary omits consumption rather than blocking an otherwise
    // available subscription worker before its model call begins.
    return undefined;
  }
}

async function finishSelectedCapacityMeasurement(
  args: SpawnWorkerArgs,
  config: Config,
  selection: ProviderSelection,
  measurement: ProviderWindowMeasurement | undefined,
  capabilities?: CapabilityLadder,
): Promise<ProviderWindowConsumption | undefined> {
  if (!measurement) return undefined;
  try {
    return finishProviderWindowMeasurement(measurement, await readFreshSelectedCapacity(args, config, selection, capabilities));
  } catch {
    abandonProviderWindowMeasurement(measurement);
    return { provider: selection.provider, percentConsumed: null, reason: "capacity-unreadable" };
  }
}

/** Spawn one headless Claude Code worker via the Agent SDK, or an opted-in Codex worker. The installed SDK's isolation options
 * are the ground truth (SDK 0.3.209):
 *  - `pathToClaudeCodeExecutable` — resolved FRESH at spawn time, never the disk-cached `config.claudeBin` and never bare
 *    PATH inheritance (W1-T113).
 *  - `env` — REPLACES the subprocess env entirely, so buildWorkerEnv()'s ANTHROPIC-stripped env is the billing boundary. No
 *    wholesale `process.env` inheritance.
 *  - `settings` / `settingSources: []` — the worker settings file, and isolation mode, so `~/.claude/settings.json` is never
 *    loaded. `sandbox` is parsed from that file and passed validated, so a malformed block fails loud instead of running
 *    unsandboxed.
 *  - `env.home` — a worker-home dir UNIQUE to this call, reaped in a `finally` whatever the outcome (W1-T170, W1-T2463). */
export async function spawnWorker(args: SpawnWorkerArgs): Promise<WorkerResult> {
  const releaseWorkerOccupancy = claimWorkerOccupancy();
  try {
  // Validate-before-spawn guard, enforced at the spawn boundary rather than by caller convention. TRAP: `claude -p` SILENTLY
  // IGNORES an invalid settings file and drops containment, so it is validated against the pinned SandboxSettingsSchema
  // first, throwing on the first bad key (WS-0 FF10a).
  validateWorkerSettingsFile(args.settingsFile);

  // Capture process-global HOME before the first await. Test harnesses and embedders may vary it between concurrent calls;
  // one worker's advisory status read must not switch another's home.
  const realHome = process.env.HOME ?? homedir();
  const config = args.config ?? loadConfig();
  // HOISTED ABOVE PROVIDER SELECTION so the Codex branch cannot return past the HOME redirection the Claude path has had
  // since W1-T18. Below the early return, `codexSpawnEnv` fell back to the operator's real HOME, and a worker shell sourcing
  // an rc file from it re-exported ANTHROPIC_API_KEY past both of Codex's process-boundary exclusions. Computing the path
  // here is inert; each branch materializes and reaps it (W1-T2800, W1-T170, W1-T2463).
  const workerHomeRoot = workerHomeDir(config);
  const workerHome = perRunWorkerHomeDir(workerHomeRoot, args.runId, { perSpawn: true });
  const routingPolicy = resolveProviderRoutingPolicy(config.root, config, { now: args.providerRouting?.now });
  if (routingPolicy.fallback) {
    console.error(JSON.stringify({
      event: "worker.provider_routing_policy_fallback",
      reason: routingPolicy.fallback.reason,
    }));
  }
  const providers = routingPolicy.routableProviders;
  const capabilities = resolveWorkerCapabilities(args.cwd);
  const claudeHealthRoute = providers.includes("claude")
    ? await resolveWorkerClaudeHealth(args, capabilities)
    : undefined;
  if (claudeHealthRoute) {
    console.error(JSON.stringify({
      event: "worker.model_health.resolved",
      requested_model: args.model ?? DEFAULT_MODEL_LABEL,
      ...(claudeHealthRoute.routedModel ? { routed_model: claudeHealthRoute.routedModel } : {}),
      state: claudeHealthRoute.state,
      source: claudeHealthRoute.source,
      eligible: claudeHealthRoute.eligible,
      ...(claudeHealthRoute.detail ? { detail: claudeHealthRoute.detail } : {}),
    }));
  }
  let routedClaudeSelection: ProviderSelection | undefined;
  if (providers.length === 1 && providers[0] === "claude" && claudeHealthRoute && !claudeHealthRoute.eligible) {
    const capacity = unavailableClaudeCapacity(claudeHealthRoute);
    try {
      (args.providerRouting?.writeStatus ?? writeProviderRoutingStatus)(config.root, {
        state: "blocked",
        enabledProviders: providers,
        reservePercent: routingPolicy.reservePercent,
        observedAtMs: (args.providerRouting?.now ?? Date.now)(),
        cacheValidMs: config.workerProviders?.capacityCacheMs ?? 60_000,
        policy: routingPolicy,
        modelHealth: claudeHealthRoute,
        capacities: [capacity],
      });
    } catch {
      console.error(JSON.stringify({ event: "worker.provider_routing_status_write_failed", reason: "write-failed" }));
    }
    throw new ProviderCapacityBlockedError([capacity]);
  }
  if (
    providers.length === 1 &&
    providers[0] === "claude" &&
    (args.model !== undefined || routingPolicy.provenance === "overridden" || routingPolicy.fallback)
  ) {
    try {
      (args.providerRouting?.writeStatus ?? writeProviderRoutingStatus)(config.root, {
        state: "not-probed",
        enabledProviders: providers,
        reservePercent: routingPolicy.reservePercent,
        observedAtMs: (args.providerRouting?.now ?? Date.now)(),
        cacheValidMs: config.workerProviders?.capacityCacheMs ?? 60_000,
        policy: routingPolicy,
        ...(claudeHealthRoute ? { modelHealth: claudeHealthRoute } : {}),
      });
    } catch {
      console.error(JSON.stringify({ event: "worker.provider_routing_status_write_failed", reason: "write-failed" }));
    }
  }
  if (!(providers.length === 1 && providers[0] === "claude")) {
    const capacities = await Promise.all(
      providers.map((provider) => {
        if (provider === "codex") {
          return (args.providerRouting?.readCodex ?? readCodexCapacity)(config, {
            requestedModel: args.model,
            requestedEffort: args.effort,
            ...(routingPolicy.codexModelPreference ? { preferredModel: routingPolicy.codexModelPreference } : {}),
            reservePercent: routingPolicy.reservePercent,
            ...(args.model && capabilities ? { capabilities } : {}),
          });
        }
        if (claudeHealthRoute && !claudeHealthRoute.eligible) return unavailableClaudeCapacity(claudeHealthRoute);
        return (args.providerRouting?.readClaude ?? (() => readClaudeProviderCapacity(config)))()
          .then((capacity) => claudeHealthRoute
            ? annotateClaudeCapacity(capacity, claudeHealthRoute, args.effort)
            : capacity);
      }),
    );
    const reservePercent = routingPolicy.reservePercent;
    const statusBase = {
      enabledProviders: providers,
      reservePercent,
      observedAtMs: (args.providerRouting?.now ?? Date.now)(),
      cacheValidMs: config.workerProviders?.capacityCacheMs ?? 60_000,
      policy: routingPolicy,
      ...(claudeHealthRoute ? { modelHealth: claudeHealthRoute } : {}),
    };
    const publishProviderRoutingStatus = (input: ProviderRoutingWriteInput): void => {
      try {
        (args.providerRouting?.writeStatus ?? writeProviderRoutingStatus)(config.root, input);
      } catch {
        console.error(JSON.stringify({ event: "worker.provider_routing_status_write_failed", reason: "write-failed" }));
      }
    };
    let selection: ProviderSelection;
    let preferenceBypass: ProviderRoutingWriteInput["preferenceBypass"];
    try {
      const routed = selectWorkerProviderForPolicy(
        capacities,
        routingPolicy,
        args.providerRouting?.tieBreaker ?? providerTieBreaker++,
      );
      selection = routed.selection;
      preferenceBypass = routed.preferenceBypass;
    } catch (error) {
      publishProviderRoutingStatus({ ...statusBase, state: "blocked", capacities });
      throw error;
    }
    publishProviderRoutingStatus({ ...statusBase, state: "selected", capacities, selection, preferenceBypass });
    console.error(
      JSON.stringify({
        event: "worker.provider.selected",
        provider: selection.provider,
        preference: routingPolicy.preference,
        ...(preferenceBypass ? { preference_bypass: preferenceBypass } : {}),
        tightest_remaining_percent: selection.tightestRemainingPercent,
        ...(selection.allocationWeight !== undefined ? { allocation_weight: selection.allocationWeight } : {}),
        ...(selection.allocationSharePercent !== undefined
          ? { allocation_share_percent: selection.allocationSharePercent }
          : {}),
        capacities: capacities.map((capacity) => ({
          provider: capacity.provider,
          readable: capacity.readable,
          ...(capacity.model ? { model: capacity.model, effort: capacity.effort } : {}),
          // W1-T2828: projected for BOTH providers, in the same field and the same shape. Codex
          // already populated `accountLabel` and it never reached a row; Claude never set it at
          // all. A reader comparing two rows must not have to know which provider produced which.
          ...(capacity.accountLabel ? { account_label: capacity.accountLabel } : {}),
          windows: capacity.windows.map((window) => ({ name: window.name, used_percent: window.usedPercent })),
          ...(capacity.allocationWindows
            ? {
                allocation_windows: capacity.allocationWindows.map((window) => ({
                  name: window.name,
                  used_percent: window.usedPercent,
                })),
              }
            : {}),
          ...(capacity.detail ? { detail: capacity.detail } : {}),
        })),
      }),
    );
    if (selection.provider === "codex") {
      const runCodex: NonNullable<NonNullable<SpawnWorkerArgs["providerRouting"]>["spawnCodex"]> =
        args.providerRouting?.spawnCodex ?? spawnCodexWorker;
      if (args.providerRouting?.spawnCodex === undefined) {
        assertLiveSpawnAllowed(`spawnCodexWorker for task ${args.taskId ?? "<no taskId>"}`);
      }
      let measurement: ProviderWindowMeasurement | undefined;
      try {
        // MATERIALIZE the redirected home before the spawn, through the SAME function the Claude path calls, which writes the
        // blank rc files that close the leak. Measured against pinned codex-cli 0.152.0: both Codex exclusions hold at the
        // process boundary while the worker's SHELL still read the operator's exported value from `$HOME/.bashrc`.
        materializeWorkerHome({ workerHome, realHome });
        measurement = await beginSelectedCapacityMeasurement(args, config, selection, capabilities);
        const result = await runCodex({ ...args, workerHome, zdotdir: workerZdotdir(config) }, config, selection.capacity);
        result.routedModel = selection.capacity.model ?? result.model;
        if (args.model) result.model = args.model;
        if (claudeHealthRoute) {
          result.modelHealthState = claudeHealthRoute.state;
          result.modelHealthSource = claudeHealthRoute.source;
        }
        result.accountLabel = selection.capacity.accountLabel;
        result.windowConsumption = await finishSelectedCapacityMeasurement(args, config, selection, measurement, capabilities);
        return result;
      } catch (error) {
        if (measurement) abandonProviderWindowMeasurement(measurement);
        throw error;
      } finally {
        // Reap THIS spawn's per-spawn home on every exit path INCLUDING error — the same guarantee the Claude path's own
        // `finally` below has carried since W1-T170. Best-effort and guarded; it never touches the root (W1-T2800).
        reapWorkerHome(workerHomeRoot, workerHome);
      }
    }
    routedClaudeSelection = selection;
  }
  // PREFLIGHT: resolve the real binary FRESH before any worker-home or keychain work. Throws ClaudeToolchainBlockedError,
  // never a raw ENOENT, naming every searched path and carrying `reasonClass: "blocked_toolchain"` so daemon.ts can classify
  // it duck-typed (W1-T113, W1-T91).
  const claudeBin = resolveClaudeExecutable(args.claudeExecutable?.cache ?? claudeExecutableCache, args.claudeExecutable?.deps);
  // Isolation mechanism: HOME is redirected to a scratch dir holding ONLY empty rc files, with the few paths a worker
  // legitimately needs symlinked back in. Best-effort and idempotent. EVERY SPAWN GETS ITS OWN HOME, a sibling of the root
  // and never the root itself, reaped on every exit path. The singleton root does not survive concurrency (WS-2), and keying
  // on runId alone was not enough either: every fix spawn in one run shared a home, so one teardown tore the directory from
  // under a live sibling. runId stays the FIRST path component, so reclamation is unaffected, and only THIS call site opts in
  // (W1-T18, W1-T170, W1-T2463, W1-T2800).
  try {
    // Keychain-unlock gate, macOS only: guarantee the DEDICATED always-unlocked worker keychain before any spawn and point
    // the redirected HOME's slot at it, so a LOCKED login keychain can no longer kill the spawn "Not logged in" at $0. A
    // credential problem throws WorkerKeychainError HERE, pre-spawn, with a named reason class.
    // Why: a $0 zero-write death read as "containment UNPROVEN" (2026-07-21, W1-T235).
    let workerKeychainPath: string | undefined;
    const platform = args.keychain?.platform ?? process.platform;
    // Resolved fresh per spawn on EVERY platform, never captured once at boot, matching account-usage.ts's
    // identity-is-read-fresh doctrine. Computed unconditionally, not only under the darwin gate, so every WorkerResult can
    // carry the account its spend is attributed to (W1-T265, W1-T268).
    const accountId = args.keychain?.accountId ?? resolveActiveAccountId();
    if (platform === "darwin") {
      const keychainSummary = ensureWorkerKeychain({
        ...workerKeychainPaths(join(config.root, "state")),
        loginKeychainPath: join(realHome, "Library", "Keychains", "login.keychain-db"),
        grantApps: workerKeychainGrantApps(claudeBin),
        runner: args.keychain?.runner,
        exists: args.keychain?.exists,
        accountId,
        priorSpawnCredentialExpired: args.keychain?.priorSpawnCredentialExpired,
        // The first forwarding of expectedRunMs; the widen-then-refuse contract lives on the option's own doc above and in
        // worker-home.ts (W1-T2518).
        expectedRunMs: args.keychain?.expectedRunMs,
      });
      // Surfaced on EVERY darwin call. A throw above skips this line entirely, and that is correct: the error message itself
      // names the headroom and the estimate (W1-T2518).
      (args.logKeychainHeadroom ?? defaultLogKeychainHeadroom)(keychainSummary, args.keychain?.expectedRunMs, {
        runId: args.runId,
        taskId: args.taskId,
      });
      workerKeychainPath = keychainSummary.keychainPath;
    } else {
      // The SAME refusal contract, one rung later in the taxonomy and one platform over; the darwin branch above is
      // untouched. Worth a rung even though `probeContainment` catches a credential-dead worker everywhere, because that
      // catches it by SPAWNING and reading the death while this costs one file read, and throws `WorkerKeychainError` with a
      // named reason class so the failure stays queryable. It refuses only the unambiguously unusable. An EXPIRED token is
      // reported and allowed through: nothing here can re-provision, the CLI maintains its own refresh, and refusing would be
      // a bound firing on a healthy condition (recon-cloud-workers-spike stop 6).
      assertWorkerCredentialFile(workerCredentialFilePath(realHome), args.keychain?.readCredentialFile);
    }
    // A grant that FAILED is not a grant that was OPTIONAL. The absent-target skip stays silent, but a target that EXISTS and
    // could not be reached is a LOST CAPABILITY the worker then runs without. Carried on the RESULT rather than logged here,
    // since this module writes no ledger rows by design.
    // Why: a real `.claude` DIRECTORY in the symlink slot left the usage probe logged out for days with nothing on disk
    //      saying so (W1-T417-adjacent).
    const lostGrants = lostWorkerHomeGrants(
      materializeWorkerHome({ workerHome, realHome, workerKeychainPath }),
    );

    // Shell isolation, resolved from config and never hardcoded, so a worker sources no operator rc. HOME is redirected
    // above, so CLAUDE_CODE_SHELL's Bash-tool snapshot resolves to the scratch HOME's empty rc whatever the operator's
    // dotfiles contain. ZDOTDIR covers any direct zsh (W1-T1C).
    const childEnv = buildWorkerEnv(args.env ?? {}, process.env, {
      zdotdir: workerZdotdir(config),
      shell: workerShell(config),
      home: workerHome,
      // Overflow valve: pass the operator's ANTHROPIC_API_KEY through to bill on API credits ONLY when `config.overflow ===
      // "api_key"`, which validateConfig refuses without a paired dailyCapUsd — so an uncapped api run cannot even be
      // configured. Otherwise ANTHROPIC_* is stripped as before (W1-T258).
      allowApiKey: config.overflow === "api_key",
    });
    // Attribution markers merged in AFTER the allowlist and extras above, so they are authoritative whatever `args.env`
    // contains — no caller has a legitimate reason to set REMUDERO_RUN_ID/TASK_ID/SCOPE itself (W1-T117).
    Object.assign(childEnv, workerMarkerEnv(args.runId, args.taskId, workerInstallationScope(config.root)));

    const stderrChunks: string[] = [];
    const blocks: string[] = [];

    // Worker process-tree containment. `pidRef` is populated lazily by the spawn closure the first time the SDK spawns, and
    // `withWorkerGroupTeardown` guarantees teardown against it once the stream settles on EITHER path, so a run's process
    // group never outlives its own teardown. That closure also owns stderr piping, because a custom spawn gets none from the
    // SDK (W1-T117).
    const pidRef: { pid?: number } = {};
    const spawnContained = args.containment?.spawn ?? spawnDetachedGroup;
    const teardownContained = args.containment?.teardown ?? ((pgid: number) => void teardownProcessGroup(pgid));

    // TRAP (SDK 0.3.209): passing BOTH a `settings` file path and the `sandbox` option throws "Cannot use both …". The
    // sandbox config therefore lives inside the settings file, and the probe (verdict 7) confirms empirically that it engaged
    // rather than being silently dropped.
    const options: Options = {
      cwd: args.cwd,
      permissionMode: args.permissionMode,
      pathToClaudeCodeExecutable: claudeBin,
      env: childEnv,
      settings: args.settingsFile,
      settingSources: [],
      // Run the CLI DETACHED into its own process group and session, so teardown reaches every descendant — including one
      // outliving the CLI's own exit — with a single group signal. This REPLACES the SDK's default local spawn, so
      // `stderrChunks` is fed from THIS closure rather than an `Options.stderr` callback, which the SDK never invokes for a
      // custom spawn (W1-T117).
      spawnClaudeCodeProcess: buildContainedSpawnFn(
        spawnContained,
        (chunk) => stderrChunks.push(chunk),
        pidRef,
        args.onSpawnError,
      ),
    };
    // Omitted entirely when unset, so an unrestricted spawn's option object is byte-identical to what it was — never
    // `disallowedTools: undefined`, a different object for the SDK (W1-T2591).
    if (args.disallowedTools && args.disallowedTools.length > 0) options.disallowedTools = [...args.disallowedTools];
    if (args.resumeSessionId) options.resume = args.resumeSessionId;
    const routedClaudeModel = claudeHealthRoute?.routedModel ?? args.model;
    if (args.model) options.model = args.model;
    if (routedClaudeModel && routedClaudeModel !== args.model) options.model = routedClaudeModel;
    if (args.effort) options.effort = args.effort as Options["effort"];
    if (typeof args.maxTurns === "number") options.maxTurns = args.maxTurns;
    if (typeof args.maxBudgetUsd === "number") options.maxBudgetUsd = args.maxBudgetUsd;
    if (args.tools) options.tools = args.tools;

    // LIVE-SPAWN GUARD — the final authority gate before the SDK invocation, the only line that creates a paid worker.
    // Everything above is local and free and refuses on its own for bad input, so guarding higher would mask three of those
    // refusals. Scoped to a REAL spawn: an injected `args.queryFn` creates no process; what this stops is a test reaching the
    // real SDK through an un-stubbed dep or an `as never` cast.
    // Why: test/mounts-wiring.test.ts once spent $1.42+ and left six ghost branches (impl-EM).
    if (args.queryFn === undefined) {
      assertLiveSpawnAllowed(`spawnWorker for task ${args.taskId ?? "<no taskId>"}`);
    }
    const runQuery = args.queryFn ?? query;

    // THE CLOCK BOUND, constructed here and still local and free: no timer is armed and no `AbortController` exists unless
    // `args.clockBound` is set. Omitted leaves `abandonment` and `stopWatchdog` unpopulated. See SpawnWorkerArgs.clockBound's
    // own doc (W1-T1045).
    let abandonment: WorkerAbandonmentEvidence | undefined;
    let stopWatchdog: (() => void) | undefined;
    let streamObserver = args.streamObserver;
    if (args.clockBound) {
      const controller = new AbortController();
      options.abortController = controller;
      const watchdog = createWorkerClockBoundWatchdog(args.clockBound);
      streamObserver = (event) => {
        watchdog.observer(event);
        args.streamObserver?.(event);
      };
      // Armed immediately before the query runs — see the live-spawn guard above.
      stopWatchdog = watchdog.start((evidence) => {
        abandonment = evidence;
        controller.abort();
      });
    }

    // Multi-provider installs take fresh, reset-aware boundaries only after every local Claude preflight has cleared.
    // Claude-only installs preserve the existing zero-extra-read path.
    const measurement = routedClaudeSelection
      ? await beginSelectedCapacityMeasurement(args, config, routedClaudeSelection, capabilities)
      : undefined;

    try {
      const result = await withWorkerGroupTeardown(
        pidRef,
        () =>
          collectWorkerResult(runQuery({ prompt: args.prompt, options }), {
            childEnvKeys: Object.keys(childEnv).sort(),
            stderrChunks,
            // Logged verbatim as CONFIGURED inputs, never a read-back: effort is absent from the SDK envelope, and model here
            // is the requested knob, which may differ from the envelope's `modelUsage` keys. Unset gives the honest "default"
            // label, never a guess.
            model: args.model ?? DEFAULT_MODEL_LABEL,
            effort: args.effort ?? DEFAULT_EFFORT_LABEL,
            accountLabel: accountId,
            // Mirrored verbatim from the SAME `options.maxTurns` this call was spawned with — see {@link
            // WorkerResult.maxTurns}. `undefined`, never guessed, when no cap was set.
            maxTurns: args.maxTurns,
            lostGrants,
            // Read off THIS spawn's `options` by index access, never a property access the `Options` type does not declare,
            // and never written here. `options` sets this key nowhere today, so it is `false` on every real spawn — the
            // ledger row saying so explicitly is the point (W1-T2245).
            compactionConfigured: (options as Record<string, unknown>).autoCompactEnabled === true,
            // Forwarded verbatim, wrapped with the watchdog's observer above when a clock bound is configured. See
            // SpawnWorkerArgs.streamObserver's doc (W1-T942).
            streamObserver,
            // The SAME injected clock the watchdog polls against. Invariant: every `tsMs` this observer sees comes from ONE
            // clock, never a real `Date.now()` racing the watchdog's synthetic one. `undefined` falls back to
            // collectWorkerResult's own `Date.now` (W1-T1045).
            now: args.clockBound?.now,
          }),
        teardownContained,
      );
      result.provider = "claude";
      result.routedModel = routedClaudeModel;
      if (claudeHealthRoute) {
        result.modelHealthState = claudeHealthRoute.state;
        result.modelHealthSource = claudeHealthRoute.source;
      }
      result.windowConsumption = routedClaudeSelection
        ? await finishSelectedCapacityMeasurement(args, config, routedClaudeSelection, measurement, capabilities)
        : undefined;
      return result;
    } catch (err) {
      if (measurement) abandonProviderWindowMeasurement(measurement);
      // Runs on EVERY thrown error but only REPLACES it when the watchdog tripped; any other transport failure passes through
      // unchanged. Replacing rather than adding a second reject means run-task.ts checks ONE type instead of re-deriving "was
      // this OUR abort" from an undocumented error shape.
      if (abandonment) throw new WorkerAbandonedError(abandonment, err);
      throw err;
    } finally {
      stopWatchdog?.();
    }
  } finally {
    // Reap THIS spawn's per-spawn home on every exit path, including a thrown error or a transport failure — the withTempDir
    // discipline (W1-T115/W1-T131) applied to a resource that must not accumulate. Guarded, so it never touches the root or
    // anything outside its own sibling. `reapWorkerHome` already computes which target it removed and why; that return was
    // discarded until `logHomeReap` surfaced it. Capture the usage cache BEFORE the reap deletes it — see {@link
    // captureWorkerUsageProjection} (W1-T170, W1-T2441, W1-T2463, W1-T2516).
    captureWorkerUsageProjection(config.root, workerHome);
    // The logger is wrapped so a caller-supplied `logHomeReap` can never turn this previously-bulletproof teardown into a new
    // failure mode.
    const homeReapResult = reapWorkerHome(workerHomeRoot, workerHome);
    try {
      (args.logHomeReap ?? defaultLogHomeReap)(homeReapResult, { runId: args.runId, taskId: args.taskId });
    } catch {
      // best-effort observability only — a logger failure must never surface as a failed teardown
    }
  }
  } finally {
    releaseWorkerOccupancy();
  }
}


/** The SDK session type a usage probe needs — narrowed to the control request and teardown, so neither this module nor its
 * callers depend on the experimental method's full shape. */
export interface UsageProbeSession {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
  return?: (v?: unknown) => Promise<unknown>;
}

/** The injectable seam a test passes so no test ever reaches the real SDK — the same shape and the same purpose as {@link
 * SpawnWorkerArgs.queryFn}. */
export type UsageProbeQueryFn = (params: { prompt: AsyncIterable<never> }) => UsageProbeSession;

/** A prompt that yields NOTHING. The control request is answered on session setup, so no user message is ever produced: no
 * prompt sent, no turn spent, no tokens billed. */
async function* emptyUsagePrompt(): AsyncIterable<never> {}

/** Open a control-only SDK session for the usage probe. It lives HERE, in the spawn chokepoint, deliberately:
 * test/spawn-guard.test.ts pins that EXACTLY ONE file imports the SDK's runtime `query` and guards it. STREAMING INPUT IS
 * REQUIRED, NOT PREFERRED — the usage control request is documented "only supported when streaming input/output is used" — so
 * this passes an async generator; converting `spawnWorker` itself is a separate decision (W1-T2516-adjacent). */
export function openUsageProbeSession(runQuery?: UsageProbeQueryFn): UsageProbeSession {
  // Guarded on the same condition spawnWorker uses: only a REAL session is refused under a test runner. An injected
  // `runQuery` creates no connection and is not what this stops.
  if (runQuery === undefined) assertLiveSpawnAllowed("openUsageProbeSession (SDK usage probe)");
  const q = runQuery ?? ((p: { prompt: AsyncIterable<never> }) => query(p as never) as unknown as UsageProbeSession);
  return q({ prompt: emptyUsagePrompt() });
}

/** The 3-value worker activity vocabulary, and no more:
 *  - `working` — assistant TEXT is arriving.
 *  - `tool-executing` — a `tool_use` block has been seen with no later message yet.
 *  - `quiet` — no message of ANY kind for longer than the quiet floor.
 * Pinned at three because a fourth would have to be re-rendered by every consumer. Not a ledgered value on its own: a run
 * with no `worker.state` row is UNKNOWN, never defaulted to `working` (the W1-T130 cannot-observe polarity), and that is
 * `undefined` rather than a fourth string (W1-T942). */
export type WorkerState = "working" | "tool-executing" | "quiet";

/** One classified SDK stream event, as {@link collectWorkerResult}'s `streamObserver` sees it. `"working"`/`"tool-executing"`
 * map 1:1 onto {@link WorkerState}; `"message"` covers every OTHER message — a system event, the terminal envelope, or an
 * assistant message with neither block — a heartbeat proving the worker is alive without asserting either named state, so it
 * still resets the quiet clock. */
export interface WorkerStreamEvent {
  kind: "working" | "tool-executing" | "message";
  /** The injected clock's reading at the moment this event was observed — never `Date.now()` read a second time downstream, so
   * a test drives the whole sequence off one synthetic clock. */
  tsMs: number;
  /** The live-tail-worthy text this event carries: the assistant's own text for `"working"`, a short `[tool_use: <name>]`
   * label for `"tool-executing"`, and ABSENT for `"message"`, which carries no worker-authored output worth tailing (W1-T942
   * design note iv). */
  text?: string;
  /** The cumulative count of raw `assistant`-type SDK messages seen so far this spawn: one increment per message however many
   * blocks it carries, so a message with both fires two events reporting the SAME count, and every event kind carries it so a
   * reader never holds a stale value. DELIBERATELY NOT NAMED `numTurns` — the terminal `num_turns` does not reliably count
   * one message plus one response, and this in-flight approximation must not borrow that name (W1-T2557). */
  turnsSoFar?: number;
}

/** Callback shape {@link collectWorkerResult}'s optional `streamObserver` accepts — see {@link SpawnWorkerArgs.streamObserver}
 * for the injection seam `spawnWorker` forwards this through, and run-task.ts's `buildWorkerStateSensor` for the real (ledger
 * + tail) consumer. */
export type WorkerStreamObserver = (event: WorkerStreamEvent) => void;

/** Default quiet floor: how long with NO message of any kind before a run reads `quiet`. Deliberately short, because this is a
 * raw ACTIVITY sensor, not a stall alarm — the stall detector's threshold is much longer, and the two must stay decoupled or
 * a slow-but-healthy tool call misreports as a stall. */
export const DEFAULT_WORKER_QUIET_FLOOR_MS = 30_000;

/** FOLD a stream of {@link WorkerStreamEvent}s, plus periodic quiet-floor checks, into the 3-value {@link WorkerState},
 * reporting only TRANSITIONS: a per-message ledger row would multiply ledger volume by the turn count. PURE — no fs, no
 * ledger, no clock of its own — so it is unit-testable against a synthetic sequence. Appending the `worker.state` row is
 * run-task.ts's job (W1-T942 design note iii). */
export class WorkerStateTracker {
  private state: WorkerState | undefined; // undefined ⇒ nothing observed yet: UNKNOWN, never a row
  private lastActivityMs: number | undefined;
  // 0 until the first event carrying `turnsSoFar` arrives. A real spawn's first observed event always carries one, so this
  // default is exercised only by a hand-built test event (W1-T2557).
  private turnsSoFarValue = 0;

  constructor(private readonly quietFloorMs: number = DEFAULT_WORKER_QUIET_FLOOR_MS) {}

  /** Fold one observed stream event. Returns the NEW {@link WorkerState} iff this event caused a transition, `undefined` when
   * unchanged — a `"message"` heartbeat never itself asserts `working`/`tool-executing`, it only resets the clock {@link
   * check} reads. */
  observe(event: WorkerStreamEvent): WorkerState | undefined {
    this.lastActivityMs = event.tsMs;
    // The running turn count updates off EVERY event kind, including heartbeats, independent of whether this event is a state
    // transition — see {@link turnsSoFar}'s doc (W1-T2557).
    if (event.turnsSoFar !== undefined) this.turnsSoFarValue = event.turnsSoFar;
    if (event.kind === "message") return undefined;
    return this.transitionTo(event.kind, event.tsMs);
  }

  /** The running count of assistant-message "turns" so far THIS spawn — see {@link WorkerStreamEvent.turnsSoFar} for the
   * counting unit. Unlike {@link currentState}, which changes only on a transition, this updates on every observed event: the
   * in-flight signal a caller can ledger while the spawn still runs (W1-T2557). */
  turnsSoFar(): number {
    return this.turnsSoFarValue;
  }

  /** Call periodically, with the current clock reading, while a spawn is in flight. Transitions to `quiet` iff MORE than
   * `quietFloorMs` has elapsed since the last observed event of ANY kind. A no-op before any event has been observed
   * (UNKNOWN, never `quiet` by default) or while already `quiet`. */
  check(nowMs: number): WorkerState | undefined {
    if (this.lastActivityMs === undefined) return undefined;
    if (this.state === "quiet") return undefined;
    if (nowMs - this.lastActivityMs > this.quietFloorMs) return this.transitionTo("quiet", nowMs);
    return undefined;
  }

  /** Current state, or `undefined` iff nothing has ever been observed — UNKNOWN, never defaulted to `working` (the W1-T130
   * cannot-observe polarity this task's own acceptance criteria name). */
  currentState(): WorkerState | undefined {
    return this.state;
  }

  private transitionTo(next: WorkerState, _atMs: number): WorkerState | undefined {
    if (next === this.state) return undefined; // same state — not a transition, no row
    this.state = next;
    return next;
  }
}

/** Evidence captured the MOMENT the clock-bound watchdog trips, BEFORE anything is released — the lock, the worktree, the
 * process group. `lastState`/`lastStateMs` are `undefined` when the stream never produced one classifiable event: the same
 * UNKNOWN polarity {@link WorkerStateTracker.currentState} keeps, never defaulted to `"working"` (W1-T1045). */
export interface WorkerAbandonmentEvidence {
  /** Milliseconds since the last observed stream activity (of ANY kind — see {@link WorkerStreamEvent}) at the moment the
   * bound tripped. Always > `boundMs`. */
  elapsedMs: number;
  /** The resolved bound this run was measured against — never re-derived by a reader, since policy can move between when this
   * fired and when anything reads it back. */
  boundMs: number;
  lastState?: WorkerState;
  /** The injected clock's reading at the last observed activity — `undefined` iff `lastState` is (nothing was ever observed
   * before the bound tripped). */
  lastStateMs?: number;
}

/** Thrown by {@link spawnWorker} when the clock-bound watchdog trips: the stream produced no activity for longer than
 * `args.clockBound.boundMs`, so the `AbortController` aborted and the iterator settled with an error rather than a result
 * envelope. Carries the {@link WorkerAbandonmentEvidence} run-task.ts needs to write a terminal verdict without re-deriving
 * this judgment; `cause` keeps the raw error reachable. A named, duck-typeable `reasonClass`, never a bare string match
 * against `.message` (W1-T1045). */
export class WorkerAbandonedError extends Error {
  readonly reasonClass = "worker_abandoned" as const;
  readonly evidence: WorkerAbandonmentEvidence;
  constructor(evidence: WorkerAbandonmentEvidence, cause?: unknown) {
    super(
      `worker abandoned: no observed stream activity for ${evidence.elapsedMs}ms, past the ` +
        `${evidence.boundMs}ms clock bound (W1-T1045)`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "WorkerAbandonedError";
    this.evidence = evidence;
  }
}

/** Real-time polling cadence for {@link createWorkerClockBoundWatchdog}, cheap relative to every bound it fires against — the
 * policy floor is 1,200,000ms (plan/policy.yaml's `workerAbandon`). Matches `buildWorkerStateSensor`'s
 * `WORKER_STATE_POLL_MS`: a real timer, tiny relative to what it watches. */
const WORKER_CLOCK_BOUND_POLL_MS = 5_000;

/** THE CLOCK-BOUND WATCHDOG. Pure and independently testable, mirroring `buildWorkerStateSensor`'s observer/poll split one
 * layer down, inside the file that holds the live stream. Reuses {@link WorkerStateTracker}'s elapsed-since-last-activity
 * math: a tracker with `quietFloorMs: boundMs` turns `"quiet"` exactly when this must trip, and it is PRIVATE to this
 * watchdog so the three thresholds stay decoupled. `observer` resets the idle clock on every event, heartbeats included;
 * `start(onTrip)` seeds it with a synthetic heartbeat so a stream yielding ZERO events still trips at `boundMs` — never
 * earlier, never never — and fires exactly once. `now`/`pollMs` are injectable (W1-T1045). */
export function createWorkerClockBoundWatchdog(opts: {
  boundMs: number;
  now?: () => number;
  pollMs?: number;
}): {
  observer: WorkerStreamObserver;
  /** Begin polling; returns a stop function. Calls `onTrip` at most ONCE. */
  start: (onTrip: (evidence: WorkerAbandonmentEvidence) => void) => () => void;
} {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? WORKER_CLOCK_BOUND_POLL_MS;
  const tracker = new WorkerStateTracker(opts.boundMs);
  let lastActivityMs: number | undefined;
  let lastState: WorkerState | undefined;

  const observer: WorkerStreamObserver = (event) => {
    lastActivityMs = event.tsMs;
    const next = tracker.observe(event);
    if (next) lastState = next;
  };

  const start = (onTrip: (evidence: WorkerAbandonmentEvidence) => void): (() => void) => {
    // Seed the tracker's clock when polling begins, so a stream that never says anything trips.
    const startedAtMs = now();
    tracker.observe({ kind: "message", tsMs: startedAtMs });

    let tripped = false;
    const timer = setInterval(() => {
      if (tripped) return;
      const nowMs = now();
      if (tracker.check(nowMs) === "quiet") {
        tripped = true;
        onTrip({
          elapsedMs: nowMs - (lastActivityMs ?? startedAtMs),
          boundMs: opts.boundMs,
          lastState,
          lastStateMs: lastActivityMs,
        });
      }
    }, pollMs);
    // DELIBERATELY NOT `.unref()`'d, unlike `buildWorkerStateSensor`'s cosmetic poll. THIS timer is the enforcement mechanism
    // a stalled worker relies on: the SDK call holds no Node-level handle while hung, so an unref'd interval would let Node
    // judge the loop idle and exit before it fires, silently defeating the bound. `stop()` still clears it on every real exit
    // path.
    return () => clearInterval(timer);
  };

  return { observer, start };
}

/** Reduce the SDK message stream into a {@link WorkerResult}. Split out of spawnWorker so the error-envelope behaviour is
 * unit-testable without a real worker. TRAP (SDK 0.3.209, the WS-1 root cause): the SDK YIELDS the `type:"result"` envelope
 * for an error subtype — carrying `num_turns` and `total_cost_usd` — and only THEN throws, so letting that throw escape loses
 * the run's cost and a failed run looks FREE in the ledger. Invariant: once an envelope is seen the trailing throw is
 * swallowed and it is returned with `isError = true`; a throw with NO envelope is a genuine transport failure and is
 * re-raised. */
export async function collectWorkerResult(
  messages: AsyncIterable<unknown>,
  opts: {
    childEnvKeys: string[];
    stderrChunks?: string[];
    /** Configured input, logged verbatim — defaults to `DEFAULT_MODEL_LABEL`. */
    model?: string;
    /** Configured input, logged verbatim — defaults to `DEFAULT_EFFORT_LABEL`. */
    effort?: string;
    /** W1-T268: the account this call's spend is attributed to — see {@link WorkerResult.accountLabel}. */
    accountLabel?: string;
    /** W1-T303: configured input, mirrored verbatim — see {@link WorkerResult.maxTurns}. */
    maxTurns?: number;
    /** See {@link WorkerResult.lostGrants} — mirrored verbatim, never re-derived here. */
    lostGrants?: WorkerHomeGrantOutcome[];
    /** Configured input, mirrored verbatim — see {@link WorkerResult.compactionConfigured}. Defaults to `false`, never guessed
     * `true`, for every caller that omits it (W1-T2245). */
    compactionConfigured?: boolean;
    /** Invoked per message, classified by kind, with THIS call's own injected clock reading and never a second `Date.now()`.
     * Absent, the loop below behaves byte-identically: no new branch, no new SDK call, no second stream (W1-T942). */
    streamObserver?: WorkerStreamObserver;
    /** The injected clock `streamObserver` timestamps are read from. Omitted uses `Date.now`, so a test drives a synthetic
     * clock and the quiet-floor logic needs no real elapsed time. */
    now?: () => number;
  },
): Promise<WorkerResult> {
  // Started BEFORE the first `for await` pull: this function's body IS the worker call, since everything above it in
  // spawnWorker is local, free setup. No clock injection, because existing tests already drive this loop against near-instant
  // synthetic streams (W1-T477).
  const startedAtMs = Date.now();
  const blocks: string[] = [];
  const stderrChunks = opts.stderrChunks ?? [];

  let sessionId = "";
  let costUsd = 0;
  let numTurns = 0;
  // Independently counted, mid-flight approximation of "turns": one increment per raw assistant message, reported on EVERY
  // observer call including heartbeats, which carry the count without incrementing it. Never asserted to equal the terminal
  // envelope's `numTurns` above (W1-T2557).
  let turnsSoFar = 0;
  let text = "";
  let subtype = "";
  let isError = false;
  let apiError = false;
  let usageRefusal: WorkerResult["usageRefusal"];
  let permissionDenials: unknown[] = [];
  let sawResult = false;
  let tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let modelUsage: Record<string, ModelUsageEntry> = {};
  // The LAST real (non-`<synthetic>`) `msg.message.model` seen on the live assistant stream — see {@link
  // WorkerResult.servedModel}. `undefined` until a genuine value is observed, so a stream carrying none falls through to the
  // explicit-unknown branch below, never a guess (W1-T2572).
  let servedModel: string | undefined;
  const compactionEvents: CompactionEvent[] = [];
  const compactionFailures: CompactionFailure[] = [];
  const nowFn = opts.now ?? Date.now;

  try {
    for await (const raw of messages) {
      const msg = raw as { type?: string; message?: unknown };
      if (msg.type === "system") {
        // Detect a compaction event LIVE off the SDK's own `compact_boundary` system message, reusing the same detector a
        // fixture-driven unit test exercises, so "detected in a test" and "detected live" can never drift apart (MASTER-PLAN
        // 8B, W1-T36).
        compactionEvents.push(...detectCompactionEvents([raw]));
        // Reads the SDK's OTHER compaction channel on the SAME raw message — `{type:"system", subtype:"status",
        // compact_result:"failed"}` — which the boundary detector above never matches, so a FAILED attempt used to leave no
        // trace. No new SDK call and no second stream (W1-T2245).
        compactionFailures.push(...detectCompactionFailures([raw]));
        // A heartbeat: no worker-authored text, but still proof of life for the quiet floor.
        opts.streamObserver?.({ kind: "message", tsMs: nowFn(), turnsSoFar });
      } else if (msg.type === "assistant") {
        // Anthropic-side api error mid-stream (server_error / <synthetic> model / isApiErrorMessage). A TRANSIENT — the
        // envelope may still report success.
        const rawAny = raw as { isApiErrorMessage?: boolean; error?: unknown };
        const model = (msg.message as { model?: string })?.model;
        if (rawAny.isApiErrorMessage === true || model === "<synthetic>") apiError = true;
        // Read verbatim off the SAME per-message field `apiError` reads — the ONE place the live stream names what generated
        // this turn. Never `modelUsage`, a post-hoc cost breakdown, and never `<synthetic>`, an error placeholder. Last real
        // value wins (W1-T2572).
        if (typeof model === "string" && model.length > 0 && model !== "<synthetic>") servedModel = model;
        const content = (msg.message as { content?: unknown }).content;
        // ONE assistant SDK message is ONE observed "turn", incremented once here before the block loop, so a message
        // carrying BOTH a text and a tool_use block reports the SAME `turnsSoFar` on both emitted events rather than
        // double-counting (W1-T2557).
        turnsSoFar += 1;
        // Classify EVERY block in this one pass over `content`, so the loop that already extracts `text` also emits the
        // `tool-executing` signal with no second stream and no extra SDK call. Tool-use blocks used to be dropped here
        // entirely (W1-T942).
        let observedThisMessage = false;
        if (Array.isArray(content)) {
          for (const block of content) {
            const blockType = block && (block as { type?: string }).type;
            if (blockType === "text") {
              const text = (block as { text: string }).text;
              blocks.push(text);
              opts.streamObserver?.({ kind: "working", tsMs: nowFn(), text, turnsSoFar });
              observedThisMessage = true;
            } else if (blockType === "tool_use") {
              const toolName = (block as { name?: string }).name;
              opts.streamObserver?.({
                kind: "tool-executing",
                tsMs: nowFn(),
                text: toolName ? `[tool_use: ${toolName}]` : "[tool_use]",
                turnsSoFar,
              });
              observedThisMessage = true;
            }
          }
        }
        // An assistant message with neither a text nor a tool_use block (e.g. thinking-only) is still a heartbeat — never
        // silently drop the quiet clock's reset.
        if (!observedThisMessage) opts.streamObserver?.({ kind: "message", tsMs: nowFn(), turnsSoFar });
      } else if (msg.type === "result") {
        const r = raw as {
          subtype: string;
          is_error: boolean;
          result?: string;
          session_id: string;
          total_cost_usd: number;
          num_turns?: number;
          permission_denials?: unknown[];
          // `usage`/`modelUsage` are on BOTH SDKResultSuccess and SDKResultError (sdk.d.ts ground truth) — optional here only
          // to tolerate a synthetic test stream that omits them; a real envelope always carries both.
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number | null;
            cache_creation_input_tokens?: number | null;
          };
          modelUsage?: Record<string, Partial<ModelUsageEntry>>;
        };
        sawResult = true;
        // The terminal envelope is a heartbeat too, so a run going straight from spawn to a near-instant result still resets
        // the quiet clock rather than leaving it unset forever.
        opts.streamObserver?.({ kind: "message", tsMs: nowFn(), turnsSoFar });
        subtype = r.subtype;
        isError = r.is_error;
        text = r.result ?? "";
        sessionId = r.session_id;
        costUsd = r.total_cost_usd;
        numTurns = typeof r.num_turns === "number" ? r.num_turns : 0;
        permissionDenials = r.permission_denials ?? [];
        tokens = {
          input: r.usage?.input_tokens ?? 0,
          output: r.usage?.output_tokens ?? 0,
          cacheRead: r.usage?.cache_read_input_tokens ?? 0,
          cacheCreation: r.usage?.cache_creation_input_tokens ?? 0,
        };
        modelUsage = Object.fromEntries(
          Object.entries(r.modelUsage ?? {}).map(([model, u]) => [
            model,
            {
              inputTokens: u.inputTokens ?? 0,
              outputTokens: u.outputTokens ?? 0,
              cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
              cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
              costUSD: u.costUSD ?? 0,
              contextWindow: u.contextWindow ?? 0,
            },
          ]),
        );
      }
    }
  } catch (err) {
    // No result envelope was seen ⇒ this is a real failure (bad binary, network, aborted spawn), not an error-subtype result.
    // Re-raise it.
    if (!sawResult) throw err;
    // Otherwise the throw is the SDK's post-error-result signal; the envelope is already captured. Record the message on
    // stderr for the proof surface.
    const swallowed = String((err as Error)?.message ?? err);
    stderrChunks.push(`\n[collectWorkerResult] error-result throw swallowed: ${swallowed}\n`);
    isError = true;
    // CLASSIFY THE REFUSAL HERE, while the message still exists. `detectUsageLimitRefusal` (lib/classify.ts) is the fleet's
    // ONE usage-limit detector, already wired into the fix-retry loop; this is a second CALLER, never a second classifier
    // (W1-T2564, W1-T2515).
    const refusal = detectUsageLimitRefusal(swallowed, nowFn());
    if (refusal) {
      usageRefusal = {
        matched: refusal.matched,
        ...(refusal.resetsAtText === undefined ? {} : { resetsAtText: refusal.resetsAtText }),
        ...(refusal.resetsAtMs === undefined ? {} : { resetsAtMs: refusal.resetsAtMs }),
      };
    }
  }

  return {
    ...(opts.lostGrants?.length ? { lostGrants: opts.lostGrants } : {}),
    sessionId,
    costUsd,
    numTurns,
    maxTurns: opts.maxTurns,
    text,
    blocks,
    stderr: stderrChunks.join(""),
    subtype,
    isError,
    apiError,
    ...(usageRefusal ? { usageRefusal } : {}),
    permissionDenials,
    childEnvKeys: opts.childEnvKeys,
    accountLabel: opts.accountLabel,
    model: opts.model ?? DEFAULT_MODEL_LABEL,
    // `null`, never a guess, when the live stream carried no real model field — no assistant message at all, or every one a
    // `<synthetic>` placeholder. `servedModelReason` names why only in that branch; see {@link WorkerResult.servedModel} for
    // the contract (W1-T2572).
    servedModel: servedModel ?? null,
    ...(servedModel === undefined
      ? { servedModelReason: "no assistant message in the stream reported a real model before the call ended" }
      : {}),
    effort: opts.effort ?? DEFAULT_EFFORT_LABEL,
    tokens,
    modelUsage,
    compactionEvents,
    compactionFailures,
    compactionConfigured: opts.compactionConfigured ?? false,
    qualitySuspect: isQualitySuspect(compactionEvents),
    workerDurationMs: Date.now() - startedAtMs,
  };
}

// ── Deny-floor containment probe: the dontAsk fallback state machine ───────
// The deterministic deny-floor hook is expected to block a forbidden write even under `bypassPermissions`.
// TRAP: claude-code#20946 reports an async race where the block can leak under bypass, so the probe re-runs
// under `dontAsk`. Extracted from spike.ts so the fallback is unit-testable without a real worker.

/** The permission mode the deny-floor probe falls back to when bypass leaks. */
export const DENY_FLOOR_FALLBACK_MODE: PermissionMode = "dontAsk";

/** Verdict of the WS-0 deny-floor containment probe (spike verdict 4). */
export interface DenyFloorVerdict {
  /** The deny-floor held under `bypassPermissions` — the forbidden write never landed. */
  heldUnderBypass: boolean;
  /** The `dontAsk` fallback path was taken because the floor leaked under bypass. */
  usedDontAskFallback: boolean;
  /** The forbidden write was ultimately blocked (under whichever mode ran last). */
  contained: boolean;
}

/** Fold the containment probe's observations into a {@link DenyFloorVerdict}. Pass only `forbiddenPresentUnderBypass` for the
 * first probe; when it is `true` the floor leaked, so the caller MUST re-run under {@link DENY_FLOOR_FALLBACK_MODE} and pass
 * the second observation. An omitted second observation is treated conservatively as "not contained": an unverified floor
 * never reads as holding. */
export function evaluateDenyFloor(obs: {
  forbiddenPresentUnderBypass: boolean;
  forbiddenPresentUnderDontAsk?: boolean;
}): DenyFloorVerdict {
  if (!obs.forbiddenPresentUnderBypass) {
    return { heldUnderBypass: true, usedDontAskFallback: false, contained: true };
  }
  return {
    heldUnderBypass: false,
    usedDontAskFallback: true,
    contained: obs.forbiddenPresentUnderDontAsk === false,
  };
}

/** Render the committed worker-settings TEMPLATE into a concrete settings file, returning its path. The template ships
 * `${HOOKS_DIR}` so the public tree carries no absolute machine path; the real hooks dir is substituted at runtime and
 * written outside the tree, because workers run with cwd set to a worktree and the hook path must therefore be absolute. */
export function renderWorkerSettings(opts: {
  templatePath: string;
  hooksDir: string;
  outPath: string;
}): string {
  const template = readFileSync(opts.templatePath, "utf8");
  const rendered = template.split("${HOOKS_DIR}").join(opts.hooksDir);
  // Validate JSON before writing so a bad substitution fails loud. TRAP: a settings file that fails validation is SILENTLY
  // ignored by `claude -p`.
  JSON.parse(rendered);
  mkdirSync(join(opts.outPath, ".."), { recursive: true });
  writeFileSync(opts.outPath, rendered, { mode: 0o600 });
  return opts.outPath;
}

// ── Worker output-contract parsers ────────────────────────────────────────
// Parsed from the concatenated worker text. Malformed ⇒ caller decides on a
// reformat retry / strike (out of scope for the spike).

export interface ReconReport {
  observed: string;
  inferred: string;
  couldntVerify: string;
}

export interface Report {
  raw: string;
  prUrl?: string;
}

export interface DecisionRequest {
  raw: string;
  options: string[];
  recommended?: string;
}

export interface QuestionReport {
  raw: string;
  question: string;
  /** The assumption the worker PROCEEDED on (§2: assume, log, keep moving). */
  currentAssumption?: string;
  /** Blast radius if the assumption is wrong. High-impact is never a QUESTION. */
  impactIfWrong?: "low" | "med";
}

/** One durable QUESTION side-channel entry (a line of plan/questions.ndjson). */
export interface QuestionEntry {
  ts: string;
  task: string;
  question: string;
  current_assumption?: string;
  impact_if_wrong?: string;
}

/** Extract a labelled section (`HEADER:` … until the next known header). */
function section(text: string, header: string, stops: string[]): string {
  const re = new RegExp(
    `${header}\\s*:?\\s*\\n?([\\s\\S]*?)(?=\\n\\s*(?:${stops.join("|")})\\s*:|$)`,
    "i",
  );
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

export function parseReconReport(text: string): ReconReport | null {
  if (!/RECON REPORT/i.test(text)) return null;
  return {
    observed: section(text, "OBSERVED", ["INFERRED", "COULDN'?T-?VERIFY"]),
    inferred: section(text, "INFERRED", ["COULDN'?T-?VERIFY"]),
    couldntVerify: section(text, "COULDN'?T-?VERIFY", []),
  };
}

/** ANCHORED PR_URL extraction. The output contract demands a REPORT whose LAST line is exactly `PR_URL: <url>`, so only a line
 * matching `PR_URL:` anchored to its own start counts; every other pull-URL in the text is INERT, and when the contract is
 * honoured twice the LAST line wins. A missing or malformed line yields `undefined`, never a guess.
 * Why: taking the first pull-URL anywhere ledgered a run as merged via Dependabot's PR #80 when its real PR was #91 (W1-T62). */
function anchoredPrUrl(text: string): string | undefined {
  const matches = [
    ...text.matchAll(/^[ \t]*PR_URL:[ \t]*(https:\/\/github\.com\/[^\s)"']+\/pull\/\d+)/gim),
  ];
  return matches.length ? matches[matches.length - 1][1] : undefined;
}

export function parseReport(text: string): Report | null {
  if (!/(^|\n)\s*REPORT/i.test(text) || /RECON REPORT/i.test(text)) {
    if (!/PR_URL/i.test(text)) return null;
  }
  return { raw: text, prUrl: anchoredPrUrl(text) };
}

/** Strip presentation decoration from a decision option or recommendation label, so the value returned is the DATA and not the
 * data plus chrome: the inline `(RECOMMENDED)` marker, markdown emphasis, code ticks and emoji go, then whitespace collapses.
 * Why: the WS-0 `)` bleed and the T1D noise are one class of bug, a decorated label mistaken for the value it dresses up. */
function stripDecoration(value: string): string {
  return value
    .replace(/\(?\s*RECOMMENDED\s*\)?/gi, " ") // inline (RECOMMENDED) marker
    .replace(/[`*]+/g, "") // markdown bold/italic + inline-code ticks
    .replace(/[\p{Extended_Pictographic}️]/gu, " ") // emoji / variation selectors
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDecisionRequest(text: string): DecisionRequest | null {
  if (!/DECISION_REQUEST/i.test(text)) return null;
  // Match option lines on their RAW form first, so the inline `(RECOMMENDED)` marker is still visible for recommendation
  // detection, then normalise each value through stripDecoration.
  const rawOptions = [...text.matchAll(/^\s*(?:[-*]+|\d+[.)])\s*(.+)$/gim)].map((m) => m[1]);
  const options = [...new Set(rawOptions.map(stripDecoration).filter(Boolean))];
  // Prefer an explicit `RECOMMENDED: <value>` line, but ignore one that decorates down to stray punctuation (the WS-0 `)`
  // bleed). Fall back to the raw option carrying the inline marker.
  let recommended = text.match(/^\s*RECOMMENDED\s*[:=]\s*(.+?)\s*$/im)?.[1];
  recommended = recommended ? stripDecoration(recommended) : undefined;
  if (!recommended || /^[)\].,;:]*$/.test(recommended)) {
    const marked = rawOptions.find((o) => /\(?\s*RECOMMENDED\s*\)?/i.test(o));
    recommended = marked ? stripDecoration(marked) : undefined;
  }
  return { raw: text, options, recommended };
}

export function parseQuestion(text: string): QuestionReport | null {
  if (!/(^|\n)\s*QUESTION\b/i.test(text)) return null;
  const question = text.match(/QUESTION\s*:?\s*(.+)/i)?.[1]?.trim() ?? "";
  const currentAssumption = text
    .match(/(?:CURRENT[_\s-]?ASSUMPTION|ASSUMPTION)\s*:?\s*(.+)/i)?.[1]
    ?.trim();
  const impactRaw = text
    .match(/IMPACT[_\s-]?IF[_\s-]?WRONG\s*:?\s*(low|med(?:ium)?)/i)?.[1]
    ?.toLowerCase();
  const impactIfWrong = impactRaw ? (impactRaw.startsWith("med") ? "med" : "low") : undefined;
  return { raw: text, question, currentAssumption, impactIfWrong };
}

/** One typed follow-up line off a worker's optional `## Follow-ups` section. `text` carries its own one-line why, so there is
 * never a separate field for it (W1-T105). */
export interface FollowupEntry {
  type: "research" | "task" | "action";
  text: string;
}

/** Parse the OPTIONAL `## Follow-ups` section of a worker REPORT: "anything discovered that is OUT OF SCOPE for the one
 * concern goes here, never into the diff." One typed entry per line — `research:`, `task:` or `action:` — each carrying its
 * own why. An absent section returns `null`, and a line naming none of the three types is skipped silently rather than
 * failing the whole report (W1-T105). */
export function parseFollowups(text: string): FollowupEntry[] | null {
  // `(?![\s\S])` is TRUE end-of-string, unaffected by the /m flag the leading `^` needs. TRAP: a bare `$` under /m matches
  // before EVERY newline, so the lazy body would stop at the section's first line instead of running to its end.
  const section = text.match(/^[ \t]*##[ \t]*Follow-ups[ \t]*\n([\s\S]*?)(?=\n[ \t]*##[ \t]|(?![\s\S]))/im);
  if (!section) return null;
  const entries: FollowupEntry[] = [];
  const lineRe = /^[ \t]*(?:[-*][ \t]*)?(research|task|action)[ \t]*:[ \t]*(.+?)[ \t]*$/gim;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(section[1]))) {
    const followupText = m[2].trim();
    if (followupText) entries.push({ type: m[1].toLowerCase() as FollowupEntry["type"], text: followupText });
  }
  return entries.length > 0 ? entries : null;
}

/** Append a QUESTION to the durable side-channel store, `plan/questions.ndjson` — one JSON object per line, so it is diffable,
 * append-only and has no round-trip hazard. NON-BLOCKING by contract: the QUESTION channel is the assume-log-keep-moving
 * path, so a write failure is caught and reported as `false`, never thrown. Ensures `plan/` exists so a fresh checkout logs
 * durably on its first question (MASTER-PLAN 2). */
export function appendQuestion(repoRoot: string, entry: QuestionEntry): boolean {
  try {
    const dir = join(repoRoot, "plan");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "questions.ndjson"), JSON.stringify(entry) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** One durable ANSWER entry — a line of `plan/questions.ndjson`. Shares the QUESTION contract's own store, never a second
 * file, and is distinguished from a {@link QuestionEntry} by carrying `answer` instead of `question`, so a reader needs no
 * separate `kind` discriminator (W3-T5, MASTER-PLAN 7). */
export interface QuestionAnswerEntry {
  ts: string;
  task: string;
  answer: string;
  /** Non-reversible id of the bearer token that submitted the answer — never the raw token (see lib/panel-actions.ts's
   * `bearerTokenId`). */
  origin: string;
}

/** Append an operator's ANSWER to the same store `appendQuestion` writes to; the panel's write action is the only caller
 * today. NON-BLOCKING by the same contract: a write failure is reported as `false`, never thrown, so an unwritable store
 * cannot turn an answer into a crash (W3-T5). */
export function appendQuestionAnswer(repoRoot: string, entry: QuestionAnswerEntry): boolean {
  try {
    const dir = join(repoRoot, "plan");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "questions.ndjson"), JSON.stringify(entry) + "\n");
    return true;
  } catch {
    return false;
  }
}

// ── Worktree lifecycle (under config.root/worktrees) ──────────────────────

export function worktreesDir(config: Config): string {
  return join(config.root, "worktrees");
}

/** THE DECLARED HOME FOR HAND-CUT (AD-HOC) LANES, and the only new root W1-T2847 adds. A SIBLING of {@link worktreesDir},
 * never `config.root` itself and never `$HOME`: a reaper pointed at `config.root` would walk live worktrees and non-worktree
 * entries alike (the 2026-07-31 failure), and a home-scoped one would gain `Documents`, `Library` and `.ssh` while still
 * refusing most of the leak. DERIVED, never a hardcoded absolute path, for the same public-repo-hygiene reason {@link
 * worktreesDir} follows.
 * Why: 4.7G of linked worktrees sat one directory above the reaper's 44K scan surface, reachable by nothing (W1-T2847;
 *      docs/forensics/worker.md). */
export function adhocLaneRoot(config: Config): string {
  return join(config.root, "lanes");
}

/** THE AGE CEILING FOR AN OPERATOR LANE, SIZED FOR A HUMAN RATHER THAN FOR A RUN. Deliberately not {@link
 * DEFAULT_WORKTREE_REAP_GRACE_MS}, which is calibrated against run wall-clock: reusing it would fire on a healthy condition,
 * this repo's recurring defect (W1-T312, W1-T380, W1-T382). The longest legitimate idle window for a hand-cut lane is a long
 * weekend, about 84 hours, so fourteen days is roughly four times that while still bounding a directory growing at 15-88
 * entries a day. AGE IS THE BACKSTOP, NOT THE PREDICATE: {@link reapStaleWorktrees} fails closed on a live pid, a live
 * upstream branch and an incomplete probe, so against the measured population this reclaims ZERO today — the value delivered
 * is the bound (W1-T2847; docs/forensics/worker.md). */
export const ADHOC_LANE_REAP_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/** This rmd install's own root — the same derivation `src/lib/policy.ts` uses from a `src/lib/` module. Its `node_modules` is
 * guaranteed populated whenever rmd runs at all, because `bin/rmd` execs `$DIR/node_modules/.bin/tsx`: a missing or empty one
 * means this process could not have started. */
function installRootDir(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
}

/** Which `node_modules` a fresh worktree resolves its dev CLIs from. Prefers the PARENT CLONE's own install, and falls back to
 * this rmd install's, which on the fleet host is the only one that exists: worktrees are cut from
 * `<config.root>/repos/<repo>`, and that clone carries none (measured). Sourcing only from `repoDir` would ship a fix inert
 * on the very host it must repair. */
export function resolveNodeModulesSource(
  repoDir: string,
  installRoot: string = installRootDir(),
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  return [join(repoDir, "node_modules"), join(installRoot, "node_modules")].find((c) => exists(c));
}

export type NodeModulesLinkOutcome =
  | "linked"
  | "already-present"
  | "no-source"
  | "failed"
  // The link was made, but the source's `package.json`+`package-lock.json` hash differed from the worktree's: the worktree
  // was cut from `origin/main` at HEAD while its `node_modules` came from `repoDir`, which may sit arbitrarily far behind.
  // Telling the caller stops a worker reading the resulting "module not found" as a defect in its own diff (W1-T2777).
  | "linked-lockfile-mismatch";

/** Give a fresh worktree a `node_modules`, by SYMLINK — never by installing. INVARIANT: a symlink, never `npm ci`. An install
 * here is what emptied the shared `node_modules` under the live daemon on 2026-07-29, so the commit-msg hook's own "run `npm
 * ci` first" advice must not be taken. Best-effort by contract: every outcome is a RETURN VALUE, never a throw, because
 * creating a worktree must not fail over its dev CLIs.
 * Why: the hook refuses to skip its gate when commitlint is absent, so with no `node_modules` every commit from every
 *      worktree verb was rejected (W1-T137/#842; docs/forensics/worker.md). */
export function linkWorktreeNodeModules(
  repoDir: string,
  worktreePath: string,
  deps: {
    resolveSource?: (repoDir: string) => string | undefined;
    /** Throws when the path is absent. `lstat`, not `stat`, so a BROKEN symlink still counts as taken — linking over either
     * one would write INSIDE the existing target. */
    lstat?: (p: string) => unknown;
    symlink?: (target: string, path: string) => void;
    /** Injectable hasher over `package.json` plus `package-lock.json`, defaulting to the real `hashInstallInputs` shared with
     * `ensureInstallFresh`. Sharing that ONE primitive is what stops two hashes over the same inputs from drifting silently
     * (W1-T2777). */
    hashInstallInputs?: (dir: string) => string;
    /** Surface for the loud channel, defaulting to `console.error` like {@link recordCanonicalCheckoutDrift}. The warning
     * names both sides being compared — the worktree source dir and the `node_modules` source path — so nothing must
     * re-derive them. */
    warn?: (message: string) => void;
  } = {},
): NodeModulesLinkOutcome {
  const dest = join(worktreePath, "node_modules");
  try {
    (deps.lstat ?? lstatSync)(dest);
    return "already-present";
  } catch {
    /* destination is free — fall through and link */
  }
  const source = (deps.resolveSource ?? resolveNodeModulesSource)(repoDir);
  if (!source) return "no-source";
  try {
    (deps.symlink ?? ((t: string, p: string) => symlinkSync(t, p, "dir")))(source, dest);
  } catch {
    // Symlink failed, so no lockfile compare is meaningful: there is nothing linked to compare against. Preserves the
    // pre-W1-T2777 "failed" contract byte-identically.
    return "failed";
  }
  // LOCKFILE COMPARE AT SYMLINK TIME, the right moment: earlier misses that `resolveSource` may point at the install root,
  // later runs after a worker has already seen "Cannot find module". Compared against `parentOf(source)`, not `repoDir`,
  // because the hash inputs live beside `node_modules` (W1-T2777).
  const hashFn = deps.hashInstallInputs ?? ((d: string) => hashInstallInputs(d));
  const nmSourceDir = dirname(source);
  let mismatch = false;
  try {
    // Both reads catch failures internally (see hashInstallInputs' contract). A missing file hashes as empty on both sides,
    // producing a MATCH — the safest verdict with nothing to compare.
    mismatch = hashFn(worktreePath) !== hashFn(nmSourceDir);
  } catch {
    // The hash function is documented non-throwing, so a throw means an injected fake broke that contract. Treat it as
    // "cannot tell" and preserve the pre-fix outcome: never invent a mismatch a real read did not observe.
    mismatch = false;
  }
  if (mismatch) {
    (deps.warn ?? ((m: string) => console.error(m)))(
      `node_modules lockfile mismatch: worktree ${worktreePath} was cut from origin/main HEAD but its ` +
        `node_modules is symlinked from ${nmSourceDir} whose package.json/package-lock.json hash differs — ` +
        "a worker may see 'Cannot find module' or a resolved version its own diff never asked for " +
        "(best-effort — see linkWorktreeNodeModules and recordCanonicalCheckoutDrift)",
    );
    return "linked-lockfile-mismatch";
  }
  return "linked";
}

/** Make git ignore the `node_modules` link above, whether or not the checked-out `.gitignore` covers it. WITHOUT THIS the link
 * is untracked and the out-of-scope push guard refuses the whole branch — and relying on the checked-out repo's own
 * `.gitignore` is exactly the assumption that failed, since `worktreeAdd` serves any repo. MEASURED (git 2.x): a linked
 * worktree honours the COMMON dir's `info/exclude` and IGNORES its own admin one, so that is where this writes. Idempotent
 * and best-effort (W1-T142). */
export function excludeNodeModulesFromGit(
  worktreePath: string,
  deps: {
    commonDir?: (worktreePath: string) => string;
    read?: (p: string) => string;
    write?: (p: string, body: string) => void;
    mkdir?: (p: string) => void;
  } = {},
): "added" | "already-excluded" | "failed" {
  try {
    const commonDir =
      deps.commonDir ??
      ((wt: string) =>
        execFileSync("git", ["-C", wt, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim());
    const infoDir = join(commonDir(worktreePath), "info");
    const excludeFile = join(infoDir, "exclude");
    let body = "";
    try {
      body = (deps.read ?? ((p: string) => readFileSync(p, "utf8")))(excludeFile);
    } catch {
      /* no exclude file yet — created below */
    }
    if (body.split("\n").some((line) => line.trim() === "node_modules")) return "already-excluded";
    (deps.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true })))(infoDir);
    (deps.write ?? ((p: string, b: string) => writeFileSync(p, b)))(
      excludeFile,
      `${body}${body === "" || body.endsWith("\n") ? "" : "\n"}node_modules\n`,
    );
    return "added";
  } catch {
    return "failed";
  }
}

/** Thrown by {@link assertWorktreeBaseCurrent}, and so by `worktreeAdd`, when the base a worktree was just created from
 * differs from an independently-observed remote head. Named so run-task.ts can return `blocked_stale_base` rather than crash.
 * The message names what was OBSERVED, "behind", never a cause it cannot see: the scope guard used to assert a "forged
 * merge-base" for a diff shape a merely-stale base produces identically, and by then the distinguishing evidence is gone
 * (W1-T405). */
export class WorktreeBaseStaleError extends Error {
  constructor(
    public readonly base: string,
    public readonly remoteHead: string,
    public readonly ref: string,
    /** Commit distance `base..remoteHead`, local objects only and never a second network read. "unknown" when the remote
     * head's object is absent locally — the "fetch did not move the ref" shape — so a `worktree.stale_base` line tells a
     * one-commit race from a broken provisioning path (W1-T2621). */
    public readonly behind: number | "unknown" = "unknown",
  ) {
    super(
      `worktree base ${base} is BEHIND ${ref}'s remote head ${remoteHead} — the base is stale ` +
        "— refusing before any worker runs",
    );
    this.name = "WorktreeBaseStaleError";
  }
}

/** Assert-and-refuse: compare the base a worktree was just created from against the remote head an INDEPENDENT read observes
 * now, and throw {@link WorktreeBaseStaleError} when they differ. WHY INDEPENDENT: `worktreeAdd`'s own fetch already moves
 * the local `origin/<ref>`, so ordinarily this never fires — that is the point. It exists for a fetch that exits zero without
 * the worktree landing on the ref it believed it moved, which re-reading the remote (never the just-fetched local ref)
 * catches. STALE MEANS BEHIND BY ANY COMMIT, a deliberate over-approximation: the precise question needs the diff, which
 * needs the run, which is the spend this avoids. UNREADABLE WARNS, NEVER REFUSES, and also ledgers
 * `worktree.base_uncheckable`, because `warn`'s only production channel is `console.error`. PURE aside from the injected
 * callbacks (W1-T405, W1-T2621). */
export function assertWorktreeBaseCurrent(
  base: string,
  ref: string,
  deps: {
    readRemoteHead: () => string;
    warn?: (message: string) => void;
    /** The run's ledger logger — see this function's `worktree.base_uncheckable` note. Absent means no ledger line, exactly as
     * before the option existed (W1-T2621). */
    log?: (step: string, extra?: Record<string, unknown>) => void;
    /** Commit distance `base..remoteHead`, invoked ONLY on the stale branch — the other branches have a trivial distance
     * needing no git call. Local objects only, never a second network read; `worktreeAdd` supplies it, so this function
     * itself stays free of any real git call. Default "unknown" (W1-T2621). */
    countBehind?: (base: string, remoteHead: string) => number | "unknown";
  },
): { remoteHead: string; behind: number | "unknown" } {
  let remoteHead: string;
  try {
    remoteHead = deps.readRemoteHead();
  } catch (e) {
    const errorMessage = String((e as Error)?.message ?? e);
    (deps.warn ?? ((m: string) => console.error(m)))(
      `worktree base currency: remote head for ${ref} could not be read ` +
        `(${errorMessage}) — proceeding without the check rather than ` +
        "refusing on an unmeasurable condition",
    );
    deps.log?.("worktree.base_uncheckable", { ref, base, error: errorMessage });
    return { remoteHead: "unreadable", behind: "unknown" };
  }
  if (remoteHead !== base) {
    const behind = (deps.countBehind ?? (() => "unknown" as const))(base, remoteHead);
    throw new WorktreeBaseStaleError(base, remoteHead, ref, behind);
  }
  return { remoteHead, behind: 0 };
}

/** How many CONSECUTIVE `worktree.add` lines with an UNREADABLE `remote_head` turn "the check could not run this once" into a
 * DEGRADED POSTURE worth naming, rather than continuing indefinitely exactly as though the guard were still running. A NAMED
 * CONSTANT, NOT YET POLICY DATA: `plan/policy.yaml` is its eventual home, but adding a field means editing policy.ts's schema
 * too. 3 matches `fixStrikeCap`'s three-strikes order of magnitude. BACKSTOP, not the primary control — it decides nothing
 * while {@link assertWorktreeBaseCurrent}'s fail-open branch works, and exists only for what that handles SILENTLY and
 * indefinitely, which reads exactly like a guard that is passing (W1-T2626, W1-T1266). */
export const WORKTREE_BASE_UNCHECKABLE_STREAK_BOUND = 3;

/** {@link detectWorktreeBaseUncheckableStreak}'s verdict. */
export interface WorktreeBaseUncheckableStreakVerdict {
  /** true once the CURRENT run of consecutive unreadable outcomes reaches the threshold. */
  degraded: boolean;
  /** Length of the CURRENT run (0 when the newest `worktree.add` line was itself readable). */
  consecutiveUnreadable: number;
  /** `ts` of the newest unreadable line in the run, so a caller can name how long it has run. */
  newestTs?: string;
  /** `ts` of the oldest unreadable line in the run. */
  oldestTs?: string;
}

/** Is the worktree-base currency check DEGRADED — has its remote-head read failed N times running with no intervening readable
 * creation? Pure over ledger lines, oldest-first, in the current-run-only shape {@link detectPostReviewStall} established: a
 * readable head resets the count. READS `worktree.add` LINES ONLY, and every ledgered creation emits exactly one while a
 * refusal emits none, so `remote_head` on that line tells a real sha from the literal "unreadable". ORTHOGONAL TO STALENESS:
 * a `worktree.stale_base` refusal neither resets nor extends the run (W1-T2626 design note (iii)). */
export function detectWorktreeBaseUncheckableStreak(
  lines: ReadonlyArray<Record<string, unknown>>,
  threshold: number = WORKTREE_BASE_UNCHECKABLE_STREAK_BOUND,
): WorktreeBaseUncheckableStreakVerdict {
  const run: Record<string, unknown>[] = [];
  for (const l of lines) {
    if (l.step !== "worktree.add") continue;
    if (l.remote_head === "unreadable") run.push(l);
    else run.length = 0;
  }
  if (run.length === 0) return { degraded: false, consecutiveUnreadable: 0 };
  const newest = run[run.length - 1];
  const oldest = run[0];
  return {
    degraded: run.length >= threshold,
    consecutiveUnreadable: run.length,
    newestTs: typeof newest?.ts === "string" ? newest.ts : undefined,
    oldestTs: typeof oldest?.ts === "string" ? oldest.ts : undefined,
  };
}

/** Result of {@link measureCanonicalCheckoutDrift}: how far the canonical checkout's `HEAD` sits behind the `origin/<ref>` a
 * worktree was just cut from. */
export type CanonicalCheckoutDriftResult =
  | { status: "current" }
  | { status: "behind"; commits: number }
  | { status: "unknown"; reason: string };

/** Real (non-test) local read: commits reachable from `origin/<ref>` but not `HEAD`, i.e. how far `repoDir`'s checked-out
 * branch is behind. No fetch of its own — see the doc on {@link measureCanonicalCheckoutDrift} for why none is needed here. */
function defaultRevListCanonicalBehind(repoDir: string, ref: string): string {
  return execFileSync("git", ["-C", repoDir, "rev-list", "--count", `HEAD..origin/${ref}`], {
    encoding: "utf8",
  });
}

/** Measure how many commits the CANONICAL CHECKOUT's `HEAD` sits behind `origin/<ref>` — the deps source every worker
 * worktree's `node_modules` is symlinked to — read at the moment that link is made, so its staleness becomes OBSERVED rather
 * than assumed. MEASURE, NEVER REPAIR: the only subprocess is `git rev-list --count`, never a package manager, because an
 * install emptying the shared `node_modules` under a live daemon is the outage class the symlink discipline prevents. No new
 * fetch either — every `worktreeAdd` call site fetches first. BEST-EFFORT: anything unreadable degrades to `"unknown"`, since
 * a staleness measurement that broke dispatch would be worse than the drift (W1-T2618). */
export function measureCanonicalCheckoutDrift(
  repoDir: string,
  ref: string,
  deps: {
    /** Commits `HEAD..origin/<ref>` in `repoDir`, as raw `rev-list --count` text. Default: a local `git rev-list --count`, no
     * fetch. Injectable so a test can simulate current / behind / unreadable without a second real remote. */
    revListCount?: (repoDir: string, ref: string) => string;
  } = {},
): CanonicalCheckoutDriftResult {
  let raw: string;
  try {
    raw = (deps.revListCount ?? defaultRevListCanonicalBehind)(repoDir, ref);
  } catch (e) {
    return { status: "unknown", reason: String((e as Error)?.message ?? e) };
  }
  const commits = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(commits) || commits < 0) {
    return { status: "unknown", reason: `unparseable rev-list --count output: ${JSON.stringify(raw)}` };
  }
  return commits === 0 ? { status: "current" } : { status: "behind", commits };
}

/** Report {@link measureCanonicalCheckoutDrift}'s result the way {@link assertWorktreeBaseCurrent} reports an unreadable head:
 * name the checkout and its distance through `warn` when behind, stay silent when current — a detector, not a permanent red.
 * NEVER THROWS, because a stale deps source must not fail worktree creation. Called from `worktreeAdd` right after {@link
 * linkWorktreeNodeModules}. */
export function recordCanonicalCheckoutDrift(
  repoDir: string,
  ref: string,
  deps: {
    measure?: (repoDir: string, ref: string) => CanonicalCheckoutDriftResult;
    warn?: (message: string) => void;
  } = {},
): CanonicalCheckoutDriftResult {
  const result = (deps.measure ?? measureCanonicalCheckoutDrift)(repoDir, ref);
  if (result.status === "behind") {
    (deps.warn ?? ((m: string) => console.error(m)))(
      `canonical checkout drift: ${repoDir} is ${result.commits} commit(s) behind origin/${ref} — ` +
        "the node_modules just symlinked into this worktree comes from that stale tree; " +
        "proceeding anyway (best-effort — see linkWorktreeNodeModules)",
    );
  }
  return result;
}

/** Sibling path recording the commit a worktree was created from — OUTSIDE the working tree, same convention as {@link
 * runLockPath}'s liveness token — so it is never committed and a later refusal can name the base without re-deriving it via
 * `git merge-base`. */
export function worktreeBasePath(worktreePath: string): string {
  return `${worktreePath}.base`;
}

/** Record the base a worktree was just created from. `worktreeAdd` calls this for every worktree it creates, BEFORE the
 * currency check can throw, so a stale-base refusal still leaves an attributable sibling file even though the worktree is
 * about to be abandoned (W1-T405). */
export function recordWorktreeBase(worktreePath: string, base: string): void {
  writeFileSync(worktreeBasePath(worktreePath), `${base}\n`);
}

/** Read a previously-recorded base (see {@link recordWorktreeBase}). `null` when absent or unreadable, never a throw, so a
 * missing record degrades to "unknown" rather than blocking whatever wanted to attribute a refusal. */
export function readWorktreeBase(worktreePath: string): string | null {
  try {
    return readFileSync(worktreeBasePath(worktreePath), "utf8").trim();
  } catch {
    return null;
  }
}

/** Drop a worktree's sibling base record. Its lifetime is its worktree's: it exists so a refusal can be attributed while the
 * corpse is on disk, and must die with it — a removal that leaves it behind fails the guard suite's "cleans up" contract and
 * hands the reaper an orphan per pass. Guarded, never throws. */
export function removeWorktreeBase(worktreePath: string): void {
  try {
    fs.unlinkSync(worktreeBasePath(worktreePath));
  } catch {
    /* absent or unreadable — removal owes nothing here */
  }
}

/** Real (non-test) {@link assertWorktreeBaseCurrent} remote read: a fresh `git ls-remote` against `origin`, independent of
 * whatever the fetch inside `worktreeAdd` just did. */
function defaultReadRemoteHead(repoDir: string, ref: string): string {
  const out = execFileSync(
    "git",
    ["-C", repoDir, "ls-remote", "--exit-code", "origin", `refs/heads/${ref}`],
    { encoding: "utf8" },
  );
  const sha = out.split(/\s+/)[0]?.trim();
  if (!sha) throw new Error(`empty ls-remote output for refs/heads/${ref}`);
  return sha;
}

/** The LOCAL `origin/<ref>` tracking ref, read immediately after `worktreeAdd`'s own fetch. One of the three readings the
 * `worktree.add` line needs — with the created base and the independent remote read — to tell "the add cut from another ref"
 * from "the fetch did not move the ref". No network call of its own, so it degrades to the literal "unreadable" rather than
 * aborting creation over a sensor read (W1-T2621). */
function readLocalOriginRefHead(repoDir: string, ref: string): string {
  try {
    return execFileSync("git", ["-C", repoDir, "rev-parse", `refs/remotes/origin/${ref}`], {
      encoding: "utf8",
    }).trim();
  } catch {
    // This is a best-effort observability read after the fail-closed fetch; "unreadable" keeps sensor failure distinct from
    // an absent or current ref without blocking worktree creation.
    return "unreadable";
  }
}

/** `assertWorktreeBaseCurrent`'s `countBehind` for a real repo: commits `base..remoteHead` over LOCAL OBJECTS ONLY, never a
 * second network call. Returns "unknown", never a guessed number — most notably when `remoteHead`'s object is absent locally,
 * the "fetch did not move the ref" shape (W1-T2621). */
function defaultCountBehind(repoDir: string, base: string, remoteHead: string): number | "unknown" {
  try {
    const out = execFileSync("git", ["-C", repoDir, "rev-list", "--count", `${base}..${remoteHead}`], {
      encoding: "utf8",
    });
    const n = Number.parseInt(out.trim(), 10);
    return Number.isInteger(n) && n >= 0 ? n : "unknown";
  } catch {
    // The remote object may not exist locally; preserve that unmeasurable state explicitly rather than aborting creation or
    // manufacturing a zero distance.
    return "unknown";
  }
}

/** `git worktree add` a fresh branch off origin/<base> for a repo checkout. */
export function worktreeAdd(
  repoDir: string,
  worktreePath: string,
  branch: string,
  base = "origin/main",
  deps: {
    /** Reads the CURRENT remote head for `ref`, independent of the fetch just above — see {@link assertWorktreeBaseCurrent}.
     * Default a fresh `git ls-remote`, injectable so a test simulates stale, current or unreachable without a second real
     * remote. */
    readRemoteHead?: (repoDir: string, ref: string) => string;
    /** Surfaces the "remote head unreadable, proceeding anyway" warning and the "canonical checkout is behind" drift warning.
     * Default `console.error` for both (W1-T2618). */
    warn?: (message: string) => void;
    /** The run's ledger logger. Absent leaves behaviour byte-identical. Present, it emits ONE `worktree.add` line per creation
     * carrying the three-way base reading plus `ref` and `behind`, and on the fail-open branch `worktree.base_uncheckable`. A
     * refusal stays the caller's to ledger, since only the caller decides what it means for dispatch (W1-T2621). */
    log?: (step: string, extra?: Record<string, unknown>) => void;
  } = {},
): void {
  execFileSync("git", ["-C", repoDir, "fetch", "origin", "--quiet"], { stdio: "inherit" });
  const ref = base.replace(/^origin\//, "");
  // Read the LOCAL tracking ref right after the fetch, before the worktree is cut from it — see readLocalOriginRefHead for
  // why this third reading is needed to discriminate the mechanism.
  const localRefHead = readLocalOriginRefHead(repoDir, ref);
  // TRAP: `base` is a remote-tracking start point, so a plain `-b` would ALSO write `branch.<branch>.remote`/`.merge` into
  // the repo's ONE shared `.git/config`, which every concurrent worktreeAdd races for. Nothing here reads that config, so
  // `--no-track` keeps the branch and drops only the write (W1-T1129).
  execFileSync(
    "git",
    ["-C", repoDir, "worktree", "add", "-b", branch, "--no-track", worktreePath, base],
    { stdio: "inherit" },
  );
  // Record the base BEFORE the currency check below: a refusal throws out of this function with no return value, so the
  // record must already be on disk to be attributable (W1-T405).
  const createdBase = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  recordWorktreeBase(worktreePath, createdBase);
  const currency = assertWorktreeBaseCurrent(createdBase, ref, {
    readRemoteHead: () => (deps.readRemoteHead ?? defaultReadRemoteHead)(repoDir, ref),
    warn: deps.warn,
    log: deps.log,
    countBehind: (b, remoteHead) => defaultCountBehind(repoDir, b, remoteHead),
  });
  // ONE line per creation: three readings plus the distance. A stale base never reaches here, because
  // assertWorktreeBaseCurrent throws first, so this is the "passed or degraded-but- proceeded" line and is never emitted for
  // a refusal (W1-T2621).
  deps.log?.("worktree.add", {
    branch,
    worktreePath,
    base: createdBase,
    local_ref_head: localRefHead,
    remote_head: currency.remoteHead,
    ref,
    behind: currency.behind,
  });
  // Point this worktree at the repo's tracked hooks/ dir so `hooks/commit-msg` fires on every commit a worker authors itself.
  // A RELATIVE core.hooksPath resolves against each worktree's OWN top-level dir (verified against git 2.54), so "hooks" is
  // correct even though `git config` writes it to the repo's one shared config file. Idempotent, so it is safe on every call
  // (W1-T137, PR #407).
  execFileSync("git", ["-C", worktreePath, "config", "core.hooksPath", "hooks"], {
    stdio: "inherit",
  });
  // …and give that hook the `commitlint` it resolves, or it rejects every commit made here. Must run AFTER the hooksPath line
  // and AFTER the worktree exists, and excluding FIRST keeps the link from ever being visible to git as an untracked file.
  excludeNodeModulesFromGit(worktreePath);
  linkWorktreeNodeModules(repoDir, worktreePath);
  // The link above ties this worktree's node_modules to repoDir's tree, so measure how far that tree sits behind the
  // origin/<ref> the fetch already moved, here where the coupling is real. `ref` is computed above and no new fetch happens
  // (W1-T2618).
  recordCanonicalCheckoutDrift(repoDir, ref, { warn: deps.warn });
}

/** Does a local branch named `branch` already exist in `repoDir`? A cheap, read-only `show-ref` check — unlike `git branch -D`
 * it never touches a ref, so it cannot itself contend for `.git/refs`'s lock. Used by {@link uniqueRunBranch}, below. */
function localBranchExists(repoDir: string, branch: string): boolean {
  try {
    execFileSync("git", ["-C", repoDir, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false; // `--quiet` folds ref-absent and any other git failure into one "not found" state
  }
}

/** Pick a `run-<runId>` worktree branch name ACTUALLY FREE in `repoDir` right now, falling back to a numbered suffix. A run id
 * can be asked for twice because a rung built once at daemon boot closes over that string and re-invokes on every poll, and
 * `worktreeAdd`'s `-b` correctly refuses an existing branch — the refusal that stops two lanes sharing a checkout — so
 * without this the second call died forever. A LEFTOVER BRANCH IS THE COMMON CASE: `git worktree remove` never deletes the
 * branch it was checked out on. NEVER FORCES OR REUSES, and THE RUN ID ITSELF IS NEVER TOUCHED, so ledger attribution is
 * unchanged (W1-T2493; docs/forensics/worker.md). */
export function uniqueRunBranch(repoDir: string, runId: string): string {
  const base = `run-${runId}`;
  if (!localBranchExists(repoDir, base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}-${n}`;
    if (!localBranchExists(repoDir, candidate)) return candidate;
  }
  throw new Error(`uniqueRunBranch: exhausted numbered suffixes for run id ${runId}`);
}

export function worktreeRemove(repoDir: string, worktreePath: string): void {
  // Reap the worker's SDK scratchpad FIRST, while this cwd still exists for the reap to realpath — the git remove below
  // deletes it. The Claude CLI leaves `/private/tmp/claude-<uid>/<slug>/` behind on a non-graceful exit and nothing else
  // reaps it. Best-effort, guarded, never throws.
  reapWorkerScratch(worktreePath);
  execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", worktreePath], {
    stdio: "inherit",
  });
  removeWorktreeBase(worktreePath); // the sibling base record dies with its worktree
  // Accumulation control, orchestrator-side so it survives a killed worker: reap STALE ORPHAN scratch under the same
  // claude-<uid> root, the fixtures a SIGKILL'd `npm test` leaves behind, which the boot sweep over os.tmpdir() never scans.
  // The 4h ceiling is far above the longest task and far below the 24h boot ceiling, so a live fixture is never reaped and
  // orphans clear within a task cycle. Never throws.
  sweepStaleWorkerScratch({ maxAgeMs: DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS });
}

/** Summary of what a start-of-run prune reclaimed (ledgered for provenance). */
export interface PruneSummary {
  worktrees: string[];
  branches: string[];
  /** Worktrees deliberately LEFT because a live run owns them (liveness guard). */
  skipped: string[];
  /** The `.git/config.lock` path reclaimed this pass, or `null` when none was stale or none existed by {@link
   * isConfigLockStale}'s predicate (W1-T1036). */
  configLock: string | null;
}

/** The liveness token a run writes beside its worktree so a concurrent prune knows the worktree is ALIVE, not debris.
 * Invariant: stored as a SIBLING file (`<worktree>.lock`), never inside the working tree, or a worker's `git add -A` could
 * commit it into the PR. See {@link pruneStaleRuns}. */
export interface RunLockInfo {
  pid: number;
  run_id: string;
  startedAt: string;
}

/** Path of the sibling run.lock for a worktree (outside the working tree). */
export function runLockPath(worktreePath: string): string {
  return `${worktreePath}.lock`;
}

export function writeRunLock(worktreePath: string, info: RunLockInfo): void {
  // ATOMIC OVERWRITE: write to a sibling temp file, then rename() into place. rename(2) swaps the entry atomically on POSIX,
  // so a reader sees complete old or complete new content and never a torn intermediate. The temp name embeds pid and
  // timestamp so racing writers never clobber each other, and this uses the default `fs` import (see the import header) so
  // the write is a spy-able property lookup.
  // Why: a direct write let the prune process read a partial file, whose parse failure returned the same `null` as "no lock
  //      at all", so a live run read as debris and its worktree was force-removed (W1-T208).
  const target = runLockPath(worktreePath);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
  fs.renameSync(tmp, target);
}

/** The three, and only three, things reading a run.lock can honestly conclude. `absent` (no file) is a DIFFERENT fact from
 * `corrupt` (present but unparseable — a reader catching a live writer mid-rename, or real corruption): one means the
 * worktree is free, the other that liveness cannot be determined. Collapsing both into one `null` let a corrupt lock read as
 * silently idle. `live` means the file parsed; whether that pid still runs is the caller's to check (W1-T208). */
export type RunLockRead =
  | { kind: "absent" }
  | { kind: "corrupt"; raw: string }
  | { kind: "live"; info: RunLockInfo };

export function readRunLock(worktreePath: string): RunLockRead {
  let raw: string;
  try {
    raw = fs.readFileSync(runLockPath(worktreePath), "utf8");
  } catch {
    return { kind: "absent" };
  }
  try {
    const o = JSON.parse(raw);
    if (typeof o?.pid === "number") return { kind: "live", info: o as RunLockInfo };
  } catch {
    // falls through to the loud "corrupt" report below — never silently treated as absent
  }
  console.error(
    `run.lock: unparseable lock at ${runLockPath(worktreePath)} (W1-T208) — reporting CORRUPT, ` +
      "not absent, so a torn or garbled lock is never silently mistaken for an idle worktree",
  );
  return { kind: "corrupt", raw };
}

/** One entry from `git worktree list --porcelain`, normalized for callers. */
export interface RegisteredWorktree {
  path: string;
  branch?: string;
}

export type WorktreeSnapshotLike = { status: string; diff: string; untrackedHash: string };
export interface WorktreeStatusFact { path: string; code: string; staged: boolean; unstaged: boolean }
export interface WorktreeDiffStat { filesChanged: number; insertions: number; deletions: number }
export interface ForeignTreeStandDown {
  reason: string;
  porcelainPaths: WorktreeStatusFact[];
  diffstat: WorktreeDiffStat;
  otherWorktrees: RegisteredWorktree[];
}

const EMPTY_UNTRACKED_HASH = createHash("sha256").digest("hex");

export function worktreeSnapshotIsClean(snapshot: WorktreeSnapshotLike | undefined): boolean {
  return !!snapshot && snapshot.status === "" && snapshot.diff === "" && snapshot.untrackedHash === EMPTY_UNTRACKED_HASH;
}

export function worktreeStatusFacts(status: string): WorktreeStatusFact[] {
  return status.split("\0").filter(Boolean).map((entry) => {
    const code = entry.slice(0, 2);
    return { path: entry.slice(3), code, staged: code[0] !== " " && code[0] !== "?", unstaged: code[1] !== " " || code === "??" };
  });
}

export function worktreeDiffStatFromSnapshot(snapshot: WorktreeSnapshotLike): WorktreeDiffStat {
  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  for (const line of snapshot.diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) files.add(header[2]);
    else if (!line.startsWith("+++") && !line.startsWith("---") && line.startsWith("+")) insertions++;
    else if (!line.startsWith("+++") && !line.startsWith("---") && line.startsWith("-")) deletions++;
  }
  for (const fact of worktreeStatusFacts(snapshot.status)) files.add(fact.path);
  return { filesChanged: files.size, insertions, deletions };
}

export function foreignTreeStandDownReason(opts: {
  round: number; branch: string; currentWorktreePath: string;
  birthSnapshot: WorktreeSnapshotLike | undefined; currentSnapshot: WorktreeSnapshotLike | undefined;
  registeredWorktrees?: readonly RegisteredWorktree[];
}): ForeignTreeStandDown | undefined {
  if (opts.round !== 1 || !opts.birthSnapshot || !opts.currentSnapshot) return undefined;
  const dirtyAtBirth = !worktreeSnapshotIsClean(opts.birthSnapshot);
  const driftedBeforeTurn =
    opts.birthSnapshot.status !== opts.currentSnapshot.status ||
    opts.birthSnapshot.diff !== opts.currentSnapshot.diff ||
    opts.birthSnapshot.untrackedHash !== opts.currentSnapshot.untrackedHash;
  if (!dirtyAtBirth && !driftedBeforeTurn) return undefined;
  const reason = dirtyAtBirth
    ? "fix-rung worktree was not byte-clean at birth, before any fix worker turn could author it"
    : "fix-rung worktree differs from its birth snapshot before the first fix worker turn";
  return {
    reason: `${reason} — standing down and escalating rather than committing local content whose author this rung did not observe`,
    porcelainPaths: worktreeStatusFacts(opts.currentSnapshot.status),
    diffstat: worktreeDiffStatFromSnapshot(opts.currentSnapshot),
    otherWorktrees: (opts.registeredWorktrees ?? [])
      .filter((entry) => entry.branch === opts.branch && entry.path !== opts.currentWorktreePath)
      .map((entry) => ({ path: entry.path, branch: entry.branch })),
  };
}

/** Parse `git worktree list --porcelain` once for every consumer that needs registered worktree facts. Linked-worktree callers
 * should reuse this rather than hand-spelling the porcelain scan. */
export function parseRegisteredWorktrees(list: string): RegisteredWorktree[] {
  const entries: RegisteredWorktree[] = [];
  let cur: RegisteredWorktree | undefined;
  const flush = () => {
    if (cur) entries.push(cur);
    cur = undefined;
  };
  for (const line of list.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return entries;
}

/** Read the registered worktrees for `repoDir`. Best-effort: an unreadable git registry reports an empty list, matching the
 * reaper's existing fail-soft contract. */
export function listRegisteredWorktrees(repoDir: string): RegisteredWorktree[] {
  try {
    return parseRegisteredWorktrees(
      execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
      }),
    );
  } catch {
    return [];
  }
}

/** Remove the sibling run.lock (idempotent) — called on terminal verdict / on reap. */
export function removeRunLock(worktreePath: string): void {
  try {
    fs.unlinkSync(runLockPath(worktreePath));
  } catch {
    // already gone
  }
}

/** Grace window (ms) protecting a LOCKLESS worktree that has just been added but has not yet written its {@link runLockPath} —
 * the create-before-lock race; older lockless debris is still reaped. POLICY DATA, not a source literal: read from
 * `plan/policy.yaml` through {@link loadDefaultPolicy}, which self-locates from its install location rather than cwd, so a
 * retune is a reviewed plan PR (W1-T253). */
export const DEFAULT_PRUNE_GRACE_MS = loadDefaultPolicy().values.pruneGraceMs;

export interface PruneOpts {
  /** Injectable liveness probe (tests). Defaults to {@link defaultIsPidAlive}. */
  isPidAlive?: (pid: number) => boolean;
  /** Protect lockless worktrees younger than this (create-before-lock race). Default 0. */
  graceMs?: number;
  /** Injectable clock for the age check (tests). Defaults to Date.now. */
  now?: () => number;
  /** Injectable {@link ConfigLockReclaimOpts} for the `.git/config.lock` rung below, so tests drive age, the live-process
   * probe and the ledger sink without a real `pgrep` (W1-T1036). */
  configLock?: ConfigLockReclaimOpts;
}

// ── Stale `.git/config.lock` reclaimer ────────────────────────────────────
//
// A lock left by a killed process fails every subsequent `git worktree add`, which writes into
// `.git/config`. TRAP: reapStaleWorktrees' widowed-lock pass cannot see it — that pass asks whether the
// directory a lock is named after is gone, and a config lock is paired with no directory at all. This plugs
// into pruneStaleRuns, which every prune-then-add call site already runs first (W1-T1036).

/** Grace window (ms) below which a zero-byte `.git/config.lock` is presumed to be a process still between `open()` and
 * `write()`. A `git config` write takes single-digit milliseconds, so this is orders of magnitude of headroom while still
 * clearing abandoned debris on the next pass (W1-T1036 design (i).1). */
export const DEFAULT_CONFIG_LOCK_GRACE_MS = 2000;

/** Path of the `.git/config.lock` for a repo checkout. */
export function configLockPath(repoDir: string): string {
  return join(repoDir, ".git", "config.lock");
}

/** The outcome of asking the OS "is any `git` process alive right now?". `ran` distinguishes a probe that genuinely answered
 * from one that could not: an ENOENT or any other unrunnable probe is NOT evidence of staleness and must never be conflated
 * with `ran: true, alive: false` (W1-T1036 design (i).2-3). */
export interface LiveGitProcessProbe {
  ran: boolean;
  alive: boolean;
}

/** The one syscall {@link defaultProbeLiveGitProcess} makes, injectable so a test drives its three outcomes without a real
 * subprocess — the same split {@link ProcessStartTimeSyscalls} keeps, for the same reason: the wiring and the branch logic
 * over its result are two different things to falsify. */
export interface PgrepSyscalls {
  execFileSync: typeof execFileSync;
}

const defaultPgrepSyscalls: PgrepSyscalls = { execFileSync };

/** Real probe: `pgrep git`, deliberately not `lsof` — the coarser name match answers "held" more often, which is the safe
 * direction. Reuses {@link pgrepFailureMeansZero} rather than reinventing its exit-code table. TRAP: only `status === 1` is a
 * real zero; ENOENT or any other failure means the read did not happen and must NOT be read as "no git process" (W1-T1036
 * design (i).2, (ii)). */
export function defaultProbeLiveGitProcess(sysImpl: PgrepSyscalls = defaultPgrepSyscalls): LiveGitProcessProbe {
  try {
    sysImpl.execFileSync("pgrep", ["git"], { stdio: "pipe" });
    return { ran: true, alive: true }; // exit 0 — at least one match
  } catch (e) {
    if (pgrepFailureMeansZero(e)) return { ran: true, alive: false }; // exit 1 — genuinely none
    return { ran: false, alive: false }; // ENOENT / exit 2 / exit 3 — the read did not happen
  }
}

export interface ConfigLockReclaimOpts {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Grace window (design (i).1). Default {@link DEFAULT_CONFIG_LOCK_GRACE_MS}. */
  graceMs?: number;
  /** Injectable live-git-process probe (design (i).2-3). Default {@link defaultProbeLiveGitProcess}. */
  probeLiveGitProcess?: () => LiveGitProcessProbe;
  /** Ledger sink, called with the path and the authorising rung BEFORE the file is removed, never after. Default
   * `console.error` (W1-T1036 design (iv)). */
  ledger?: (message: string) => void;
  /** Injectable removal call, so a test drives the race window between the staleness check and the removal — the lock
   * vanishing or turning unremovable in that gap — without a real second writer. Default {@link unlinkSync}. */
  unlink?: typeof unlinkSync;
}

/** THE PREDICATE, AND IT FAILS CLOSED. All three rungs must hold before a `.git/config.lock` is reclaimable:
 *   1. AGE — older than `graceMs`.
 *   2. NO LIVE GIT PROCESS — the probe ran AND found none.
 *   3. THE PROBE RAN — an unrunnable probe is not evidence of staleness and KEEPS the lock.
 * IT MAY NOT BE LOOSENED TOWARD RECLAMATION: clearing a live lock corrupts `.git/config`, while keeping a dead one costs
 * minutes (W1-T1036 design (i)/(ii)). */
export function isConfigLockStale(lockPath: string, opts: ConfigLockReclaimOpts = {}): boolean {
  const now = opts.now ?? (() => Date.now());
  const graceMs = opts.graceMs ?? DEFAULT_CONFIG_LOCK_GRACE_MS;
  const probe = opts.probeLiveGitProcess ?? defaultProbeLiveGitProcess;

  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return false; // absent or unreadable — nothing here to reclaim
  }
  if (now() - mtimeMs < graceMs) return false; // rung 1: may still be mid open()-then-write()

  const result = probe();
  if (!result.ran) return false; // rung 3: the read did not happen — keep, never authorise
  if (result.alive) return false; // rung 2: a live git process holds it — keep

  return true;
}

/** Reclaim a stale `.git/config.lock`, immediately before the `git worktree add` that would fail on it. `unlink`s, never
 * truncates: the artifact is mode `-r--r--r--`, so an open-for-write reclaimer fails on the exact file this clears while
 * removal succeeds under the directory's permission. Ledgers BEFORE removing, naming the path. Best-effort: anything
 * unreclaimable is left alone and reported `false`. */
export function reclaimStaleConfigLock(repoDir: string, opts: ConfigLockReclaimOpts = {}): boolean {
  const lockPath = configLockPath(repoDir);
  if (!isConfigLockStale(lockPath, opts)) return false;
  const ledger = opts.ledger ?? ((m: string) => console.error(m));
  ledger(
    `pruneStaleRuns: reclaiming stale .git/config.lock at ${lockPath} (W1-T1036: past grace, ` +
      "no live git process, probe ran) before the next worktree add",
  );
  const unlink = opts.unlink ?? unlinkSync;
  try {
    unlink(lockPath);
  } catch {
    return false; // vanished, or unremovable, between the check above and here
  }
  return true;
}

/** Reclaim leftovers from crashed prior runs so they cannot block this one: force-remove every DEAD `run-*` worktree, prune
 * the admin records, then delete every remaining local `run-*` branch. Best-effort and per-item guarded; the caller's own
 * about-to-be-created branch does not exist yet, so it is safe. LIVENESS GUARD: a worktree whose sibling {@link runLockPath}
 * names a LIVE pid is SKIPPED. A CORRUPT lock is treated the SAME as an ABSENT one, never as proof of death — both go through
 * the age and grace guard, which is what makes a torn read survivable.
 * Why: force-removing any `run-*` worktree once destroyed a successful 65-turn implement mid-run (DIAGNOSIS.md
 *      diag/drain-concurrency; W1-T208). */
export function pruneStaleRuns(
  repoDir: string,
  worktreesRoot: string,
  opts: PruneOpts = {},
): PruneSummary {
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const graceMs = opts.graceMs ?? 0;
  const now = opts.now ?? (() => Date.now());
  const removedWorktrees: string[] = [];
  const removedBranches: string[] = [];
  const skipped: string[] = [];

  // 0. Reclaim a stale .git/config.lock BEFORE anything below shells out to `git`. Every call site's next step is
  //    worktreeAdd, which writes into `.git/config` and fails outright on a held lock, so this is the earliest point common
  //    to all of them. Fails closed (W1-T1036).
  const reclaimedConfigLock = reclaimStaleConfigLock(repoDir, opts.configLock);
  const configLock = reclaimedConfigLock ? configLockPath(repoDir) : null;

  // 1. Force-remove any registered worktree whose path is under our worktrees root and whose branch is a run-* branch —
  //    UNLESS a live run owns it.
  for (const registered of listRegisteredWorktrees(repoDir)) {
    if (registered.branch) {
      const isRun = registered.branch.startsWith("run-");
      if (isRun && registered.path.startsWith(worktreesRoot)) {
        // LIVENESS GUARD: a worktree whose run.lock names a live pid is IN USE. Never force-remove it — that is the bug that
        // lost a 65-turn implement.
        const lockRead = readRunLock(registered.path);
        if (lockRead.kind === "live" && isPidAlive(lockRead.info.pid)) {
          skipped.push(registered.path);
          continue;
        }
        // AGE GUARD: a LOCKLESS or CORRUPT worktree younger than graceMs may be a run that just added but has not yet written
        // its run.lock, or one caught mid torn-write. Protect either. A "live" lock naming a dead pid skips this guard: that
        // pid cannot still be writing (W1-T208).
        if (lockRead.kind !== "live" && graceMs > 0) {
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(registered.path).mtimeMs;
          } catch {
            mtimeMs = 0;
          }
          if (now() - mtimeMs < graceMs) {
            skipped.push(registered.path);
            continue;
          }
        }
        try {
          execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", registered.path], {
            stdio: "pipe",
          });
          removeRunLock(registered.path); // clear the dead sibling lock so it can't linger
          removeWorktreeBase(registered.path); // the sibling base record dies with its worktree too
          removedWorktrees.push(registered.path);
        } catch {
          // best-effort
        }
      }
    }
  }

  // 2. Prune admin records for worktrees whose directory is already gone.
  try {
    execFileSync("git", ["-C", repoDir, "worktree", "prune"], { stdio: "pipe" });
  } catch {
    // best-effort
  }

  // 3. Delete every remaining local run-* branch (now detached from any worktree).
  let branches = "";
  try {
    branches = execFileSync(
      "git",
      ["-C", repoDir, "for-each-ref", "--format=%(refname:short)", "refs/heads/run-*"],
      { encoding: "utf8" },
    );
  } catch {
    branches = "";
  }
  for (const b of branches.split("\n").map((s) => s.trim()).filter(Boolean)) {
    try {
      execFileSync("git", ["-C", repoDir, "branch", "-D", b], { stdio: "pipe" });
      removedBranches.push(b);
    } catch {
      // A branch still checked out in a worktree we couldn't remove — leave it.
    }
  }

  return { worktrees: removedWorktrees, branches: removedBranches, skipped, configLock };
}

// ── Worktree reaper — closes pruneStaleRuns' three coverage holes ─────────
//
// pruneStaleRuns sees only what it is told to, and only when a run starts: (1) it enumerates ONLY git's
// registry for ONE assumed repoDir; (2) it fires exclusively at the START of a run; (3) its predicate needs
// a `run-*` BRANCH, so a detached-HEAD `sweep-*` dir is orphaned and a widowed `.lock` is never swept.
// reapStaleWorktrees enumerates the DIRECTORY itself and resolves each entry's parent from its OWN `.git`
// pointer, and is deliberately MORE conservative — everything not a definitely-alive pid still goes through
// the age gate — so a wrong reap takes strictly longer to happen (W1-T175).

/** The CADENCE reaper's own age ceiling — see plan/policy.yaml's `worktreeReapGraceMs` for the measurement. Deliberately NOT
 * {@link DEFAULT_PRUNE_GRACE_MS}, which six run-start call sites consume where a longer value delays reclaiming a colliding
 * name; this reaper has no such urgency (W1-T378). */
export const DEFAULT_WORKTREE_REAP_GRACE_MS = loadDefaultPolicy().values.worktreeReapGraceMs;

/** Directory names never descended into by {@link newestActivityMs} — see its doc. */
const ACTIVITY_SKIP_DIRS = new Set([".git", "node_modules"]);

/** How many filesystem entries {@link newestActivityMs} will stat before giving up. */
export const ACTIVITY_WALK_ENTRY_CAP = 20_000;

/** Why {@link reapStaleWorktrees} left an entry alone — the "and why" half of its ledger row. */
export type WorktreeKeepReason =
  /** A run lock naming a pid that is currently alive. */
  | "live-pid"
  /** Registered on a branch still live upstream (an open, unmerged PR). */
  | "live-branch"
  /** Recent file activity somewhere in the tree — the W1-T378 age gate. */
  | "recent-activity"
  /** The activity probe could not complete (unreadable, or past the entry cap), so liveness is UNKNOWN and the entry is kept.
   * An ambiguous signal keeps; it never destroys. */
  | "activity-unknown"
  /** Removal itself failed — best-effort, the rest of the pass continues. */
  | "removal-failed"
  /** The entry's own `.git` is present but could not be read or parsed, so whether an admin record exists in some parent clone
   * is UNKNOWABLE. An ambiguous signal keeps; it never destroys — the same doctrine `activity-unknown` applies one gate
   * above. See {@link planWorktreeRemoval}. */
  | "git-unreadable";

/** The newest mtime anywhere under `dir`, and whether the walk could be trusted. TRAP: a DIRECTORY's mtime advances only when
 * an entry is added to or removed from THAT directory, never when a nested file is modified, so age-gating on the root's own
 * mtime read a value frozen at checkout and the gate degraded to "reap unconditionally". BOUNDED: `.git` and `node_modules`
 * are never descended into and the walk stops at {@link ACTIVITY_WALK_ENTRY_CAP}. `complete: false` means DO NOT TRUST
 * `mtimeMs` — treat it as unknown-and-keep, because a partial max is the value that destroys live work (W1-T378, W1-T350;
 * docs/forensics/worker.md). */
export function newestActivityMs(
  dir: string,
  opts: { entryCap?: number; skipDirs?: ReadonlySet<string> } = {},
): { mtimeMs: number; complete: boolean } {
  const entryCap = opts.entryCap ?? ACTIVITY_WALK_ENTRY_CAP;
  const skipDirs = opts.skipDirs ?? ACTIVITY_SKIP_DIRS;
  // THE ROOT'S OWN MTIME IS THE FLOOR, not a starting zero: a just-created, still-empty entry has nothing to walk, and a zero
  // floor would read as maximally ancient — reaping the create-before-lock race the age gate exists to protect.
  let newest: number;
  try {
    newest = statSync(dir).mtimeMs;
  } catch (e) {
    // GONE is not UNREADABLE. A dir that vanished mid-pass has nothing left to protect, so it stays reapable: `complete:
    // true` with age 0. Any other failure is unknown and must keep.
    return { mtimeMs: 0, complete: (e as NodeJS.ErrnoException)?.code === "ENOENT" };
  }
  let visited = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") continue; // vanished mid-walk — not unreadable
      return { mtimeMs: newest, complete: false }; // unreadable ⇒ unknown, never "old"
    }
    for (const e of entries) {
      if (++visited > entryCap) return { mtimeMs: newest, complete: false };
      if (e.isSymbolicLink()) continue; // never follow — the node_modules symlink alone would leave the repo
      const p = join(cur, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) stack.push(p);
        // A directory's OWN mtime still counts: it advances when a file is created or deleted in it.
      }
      try {
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        // A single vanished entry mid-walk is someone else's cleanup, not an unreadable tree.
      }
    }
  }
  return { mtimeMs: newest, complete: true };
}

/** What a cadence reap pass did, by dir/lock name (not full path). */
export interface WorktreeReapSummary {
  /** Worktree directories force-removed (git-invisible, detached-HEAD orphan, or a registered branch confirmed merged/deleted
   * upstream — always past the age gate). */
  reaped: string[];
  /** Widowed `<name>.lock` AND `<name>.base` files removed because `<name>/` no longer exists (W1-T2628 widened this sweep
   * from `.lock`-only to include `.base`). */
  reapedLocks: string[];
  /** Entries deliberately left: a live pid, a branch still live upstream, or too young. */
  kept: string[];
  /** The same entries as `kept`, each paired with why it survived, so a pass that keeps everything is diagnosable rather than
   * silent. Optional so three-field literals keep typechecking; {@link reapStaleWorktrees} always populates it (W1-T378). */
  keptReasons?: Array<{ name: string; reason: WorktreeKeepReason }>;
}

export interface WorktreeReapOpts {
  /** Injectable liveness probe, defaulting to {@link defaultIsPidAlive} and called as `isPidAlive(pid, info)`. The second
   * argument lets a caller supply a start-time-aware predicate (see {@link worktreeLockIsPidAlive}) without this reaper
   * knowing anything about pid reuse (W1-T406). */
  isPidAlive?: (pid: number, info: RunLockInfo) => boolean;
  /** Age ceiling (ms) below which a terminal-looking entry is still protected — the same create-before-lock and
   * branch-not-yet-pushed race {@link DEFAULT_PRUNE_GRACE_MS} covers in pruneStaleRuns. Default {@link
   * DEFAULT_WORKTREE_REAP_GRACE_MS}, this reaper's OWN ceiling rather than pruneGraceMs (W1-T378). */
  maxAgeMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Whether `branch` (in `repoDir`) is still live upstream — true means KEEP, fail closed. Defaults to {@link
   * defaultBranchIsLiveUpstream} (an `origin` ls-remote). */
  branchIsLiveUpstream?: (branch: string, repoDir: string) => boolean;
  /** The tree-activity probe the age gate measures against. Injectable so a test asserts the boundary without a deep fixture
   * per case. Defaults to {@link newestActivityMs}, the REAL bounded walk, which the fixture-free tests drive (W1-T378). */
  newestActivity?: (dir: string) => { mtimeMs: number; complete: boolean };
  /** SURVEY ONLY when true: an entry that would be reaped is still recorded in `reaped` and `reapedLocks`, so a caller can
   * ledger exactly what it would reclaim, but nothing is removed from disk. Mirrors {@link reapStaleClones}'s own `dryRun`.
   * Default false, unchanged for every existing caller (W1-T406). */
  dryRun?: boolean;
}

/** A {@link WorktreeReapOpts.isPidAlive}-shaped predicate for the one-shot container boot rung: it answers "is THIS the
 * process that wrote the lock", not merely "does some process hold this pid".
 *
 * TRAP: {@link defaultIsPidAlive} answers only the second question, reading this container's OWN pid namespace, which
 * restarts at 1 on every `docker run`. A lock from a previous boot naming a low pid very often finds that number ALIVE as an
 * unrelated process, so the reaper takes the live-pid keep branch forever — PERMANENT NON-RECLAMATION, the shape of the 3.0
 * GB this was filed against, not destruction. Reuses {@link isHolderStale} as written: `pid`/`startedAt` satisfy {@link
 * HolderIdentity} with no `host` key, so its host rung is skipped by construction, and `RunLockInfo` deliberately gains no
 * `host` field because that would import the very hazard — a hostname changing every boot — this avoids. `deps` is injectable
 * so the pid-reuse scenario is drivable (W1-T406, W1-T396, W1-T368). */
export function worktreeLockIsPidAlive(
  pid: number,
  info: RunLockInfo,
  deps: Partial<IsHolderStaleOpts> = {},
): boolean {
  return !isHolderStale({ pid, startedAt: info.startedAt }, { isPidAlive: defaultIsPidAlive, ...deps });
}

/** Resolve a linked worktree's parent repoDir from its OWN `.git` gitdir pointer rather than assuming one. Null when
 * `entryPath` is not a linked worktree at all — exactly the hole-(1) debris this covers. */
function resolveWorktreeRepoDir(entryPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(entryPath, ".git"), "utf8");
  } catch {
    return null;
  }
  const m = raw.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  const gitdir = m[1];
  const marker = `${sep}.git${sep}worktrees${sep}`;
  const idx = gitdir.indexOf(marker);
  return idx === -1 ? null : gitdir.slice(0, idx);
}

/** A linked worktree's registration state, read from ITS OWN resolved repo. */
interface WorktreeRegistration {
  repoDir: string;
  /** undefined when registered but on a DETACHED HEAD — hole (3): a `sweep-*` dir interrupted before `checkout -B` never gets
   * a branch to check upstream. */
  branch?: string;
}

/** Cross-reference `entryPath` against `git worktree list --porcelain` for its OWN resolved repoDir, never a fixed one — the
 * multi-checkout lesson. Null when git does not register the path there, treated identically to "not a worktree": both are
 * hole-(1) debris with no branch to consult. */
function resolveWorktreeRegistration(entryPath: string): WorktreeRegistration | null {
  const repoDir = resolveWorktreeRepoDir(entryPath);
  if (!repoDir) return null;
  const found = listRegisteredWorktrees(repoDir).find((entry) => entry.path === entryPath);
  return found ? { repoDir, branch: found.branch } : null;
}

/** HOW an aged, terminal reap candidate must be REMOVED — never WHETHER, which the gates above decide. `git-remove` deletes
 * the tree AND its admin record in the parent; `rm-only` deletes the tree and carries the parent, when one exists, so the
 * caller can prune behind it; `keep` destroys nothing. */
export type WorktreeRemovalPlan =
  | { kind: "git-remove"; repoDir: string }
  | { kind: "rm-only"; repoDir?: string }
  | { kind: "keep" };

/** Decide {@link WorktreeRemovalPlan} for `entryPath` from its OWN `.git`, BEFORE anything is destroyed.
 *
 * TRAP: everything under {@link worktreesDir} is a LINKED worktree whose admin record lives in the PARENT clone, so `rm -rf`
 * strands that record — git reports it `prunable` and then refuses the branch on the next run that mints the same name. The
 * cases:
 *  - `.git` ABSENT, or a DIRECTORY (a standalone clone) — `rm-only` strands nothing.
 *  - `.git` a FILE and the parent REGISTERS this path — the only case that can strand, so `git-remove`.
 *  - `.git` a FILE with the parent absent or not registering it — `rm-only` is correct, not a concession; `repoDir` rides
 *    along so the caller can prune behind it, which is idempotent.
 *  - `.git` UNREADABLE or UNPARSEABLE — UNKNOWABLE, so it KEEPS. An ambiguous signal never destroys.
 * `registration` is the caller's already-computed lookup, threaded in so this cannot disagree with the `live-branch` gate
 * (the 2026-07-31 destruction; docs/forensics/worker.md). */
export function planWorktreeRemoval(
  entryPath: string,
  registration: WorktreeRegistration | null,
  fsImpl: Pick<typeof fs, "lstatSync" | "existsSync"> = fs,
): WorktreeRemovalPlan {
  // The parent already told us it registers this path — that IS the linked case, and no re-reading of `.git` can contradict a
  // lookup that just succeeded against the real repo.
  if (registration) return { kind: "git-remove", repoDir: registration.repoDir };

  let gitStat: { isDirectory(): boolean };
  try {
    gitStat = fsImpl.lstatSync(join(entryPath, ".git"));
  } catch (e) {
    // ENOENT is "not a worktree" — reapable, and the ONLY error shape that is. Anything else (EACCES, EIO, a `.git` we can
    // see but not stat) leaves the question open, so it keeps.
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "rm-only" } : { kind: "keep" };
  }
  if (gitStat.isDirectory()) return { kind: "rm-only" }; // standalone clone — owns its own records

  const repoDir = resolveWorktreeRepoDir(entryPath);
  if (!repoDir) return { kind: "keep" }; // a `.git` FILE we could not read or parse — unknowable
  // Parsed, but the parent is gone: nothing can hold a record for this tree, so `rmSync` is the only primitive left and is
  // safe precisely because the parent is confirmed absent.
  if (!fsImpl.existsSync(repoDir)) return { kind: "rm-only" };
  // Parent present but not registering this path — the record is already gone. Prune behind the removal anyway; it is
  // idempotent and collects anything the registration lookup missed.
  return { kind: "rm-only", repoDir };
}

/** Execute a {@link planWorktreeRemoval} decision. Throws on failure so the reaper records `removal-failed` and the pass
 * continues. `--force` is deliberate: plain `git worktree remove` refuses on modified or untracked files, which a stale run
 * worktree nearly always has, so omitting it would silently disable the reaper. WHETHER a dirty tree deserves protection is
 * the gates' question, not this one. */
function executeWorktreeRemoval(
  entryPath: string,
  // `keep` is excluded at the type level, not merely by convention: the caller must have already acted on it (by keeping the
  // entry) before anything here could destroy something.
  plan: Exclude<WorktreeRemovalPlan, { kind: "keep" }>,
): void {
  if (plan.kind === "git-remove") {
    execFileSync("git", ["-C", plan.repoDir, "worktree", "remove", "--force", entryPath], {
      stdio: "pipe",
    });
    return;
  }
  fs.rmSync(entryPath, { recursive: true, force: true });
  if (!plan.repoDir) return;
  try {
    execFileSync("git", ["-C", plan.repoDir, "worktree", "prune"], { stdio: "pipe" });
  } catch {
    // Best-effort, and never a reason to report the removal itself as failed: the tree IS gone, and `prune` is
    // level-triggered — the next pass (or pruneStaleRuns) collects the record.
  }
}

/** Default {@link WorktreeReapOpts.branchIsLiveUpstream}: does `branch` still exist on `origin`? FAIL CLOSED on anything
 * ambiguous — a network hiccup or unexpected exit code reports "still live", never grounds to reap. Only git's own not-found
 * signal, exit 2, says the branch is gone. */
function defaultBranchIsLiveUpstream(branch: string, repoDir: string): boolean {
  try {
    execFileSync("git", ["-C", repoDir, "ls-remote", "--exit-code", "--heads", "origin", branch], {
      stdio: "pipe",
    });
    return true; // still on origin — merged-with-branch-kept, or simply not deleted yet
  } catch (e) {
    return (e as { status?: number }).status !== 2; // 2 == git's own "no matching refs"
  }
}

/** Cadence reaper for `root` — the backstop for pruneStaleRuns' three coverage holes above. Fail-closed throughout: a live pid
 * is NEVER reaped, a branch still live upstream is NEVER reaped however old, and a per-entry failure never blocks the pass.
 * HOW an entry is removed lives in {@link planWorktreeRemoval}; a bare `rmSync` here is what stranded records as `prunable`
 * on 2026-07-31 (W1-T175). */
export function reapStaleWorktrees(root: string, opts: WorktreeReapOpts = {}): WorktreeReapSummary {
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_WORKTREE_REAP_GRACE_MS;
  const now = opts.now ?? (() => Date.now());
  const branchIsLiveUpstream = opts.branchIsLiveUpstream ?? defaultBranchIsLiveUpstream;
  const newestActivity = opts.newestActivity ?? ((d: string) => newestActivityMs(d));
  const dryRun = opts.dryRun ?? false;
  const reaped: string[] = [];
  const reapedLocks: string[] = [];
  const kept: string[] = [];
  const keptReasons: Array<{ name: string; reason: WorktreeKeepReason }> = [];
  const keep = (name: string, reason: WorktreeKeepReason): void => {
    kept.push(name);
    keptReasons.push({ name, reason });
  };

  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return { reaped, reapedLocks, kept, keptReasons }; // unreadable root — best-effort, never throws
  }

  for (const name of entries) {
    if (name.endsWith(".lock")) continue; // widowed-lock pass below, after dirs settle
    const entryPath = join(root, name);
    let isDir: boolean;
    try {
      isDir = statSync(entryPath).isDirectory();
    } catch {
      continue; // vanished between readdir and stat — someone else's cleanup won the race
    }
    if (!isDir) continue;

    const lockRead = readRunLock(entryPath);
    if (lockRead.kind === "live" && isPidAlive(lockRead.info.pid, lockRead.info)) {
      keep(name, "live-pid"); // LIVE pid — never reaped, the same guard pruneStaleRuns applies
      continue;
    }
    // The lock's OWN pid, confirmed dead by the predicate the live-pid guard just used, outranks the activity probe: an mtime
    // records THAT a write happened, never WHO made it. Same staleness shape drain-lock.ts's `reclaimStaleLock` uses
    // (W1-T381).
    const lockNamesDeadPid = lockRead.kind === "live" && !isPidAlive(lockRead.info.pid, lockRead.info);

    // Not a live-pid worktree. A registered branch still live upstream — an open, unmerged PR — is fail-closed KEPT
    // regardless of age. The sweep-W1-T154 falsifier: a `sweep-*` dir writes no lock at all, so lock state alone cannot tell
    // it from debris; only the branch signal can.
    const registration = resolveWorktreeRegistration(entryPath);
    if (registration?.branch && branchIsLiveUpstream(registration.branch, registration.repoDir)) {
      keep(name, "live-branch");
      continue;
    }

    // Terminal by every available signal: no live pid, and git either no longer registers this directory, registers it on a
    // detached HEAD, or its branch is confirmed gone upstream. AGE GATE: measured against the newest mtime ANYWHERE IN THE
    // TREE, never the root's own. An INCOMPLETE probe means liveness is unknown and keeps, regardless of `lockNamesDeadPid` —
    // only "confirmed dead" overrides the rescue below (W1-T378, W1-T381).
    const activity = newestActivity(entryPath);
    if (!activity.complete) {
      keep(name, "activity-unknown");
      continue;
    }
    // Recent activity may rescue a tree whose lock is ABSENT or names a LIVE pid, never one whose own lock names a pid
    // already confirmed dead above. This only ever WITHDRAWS a rescue the guard would otherwise grant, so it cannot newly
    // reap a tree whose run is alive (W1-T381).
    if (!lockNamesDeadPid && now() - activity.mtimeMs < maxAgeMs) {
      keep(name, "recent-activity");
      continue;
    }
    // HOW to remove it, decided BEFORE anything is destroyed: a linked worktree must die through its parent, or its record is
    // stranded `prunable`. `registration` is the live-branch gate's own lookup.
    const removalPlan = planWorktreeRemoval(entryPath, registration);
    if (removalPlan.kind === "keep") {
      keep(name, "git-unreadable"); // unknowable `.git` — the ambiguous signal keeps, as always
      continue;
    }
    try {
      if (!dryRun) {
        executeWorktreeRemoval(entryPath, removalPlan);
        removeRunLock(entryPath); // clear the sibling lock so it can't linger widowed
        // The base record is a sibling FILE on disk, so its cleanup belongs INSIDE the dryRun guard: removing it during a
        // survey would destroy state while claiming only to look. One orphan per reap otherwise (W1-T406 x W1-T405 merge
        // resolution).
        removeWorktreeBase(entryPath);
      }
      reaped.push(name); // SURVEY (dryRun) or real removal — either way this is what qualified
    } catch {
      keep(name, "removal-failed"); // best-effort: a removal hiccup never blocks the rest of the pass
    }
  }

  // Widowed `.lock`/`.base` siblings whose worktree dir is already gone (hole 3): removeRunLock and removeWorktreeBase fire
  // only INSIDE a successful removal, so a sibling orphaned any other way lingers forever — a `.lock` makes a dead run read
  // as live. No age gate is owed, the owner is already gone (W1-T2628).
  const widowSuffixes = [".lock", ".base"];
  for (const name of entries) {
    const suffix = widowSuffixes.find((s) => name.endsWith(s));
    if (!suffix) continue;
    const dirPath = join(root, name.slice(0, -suffix.length));
    if (existsSync(dirPath)) continue; // owning worktree still present — not widowed
    try {
      if (!dryRun) unlinkSync(join(root, name));
      reapedLocks.push(name); // SURVEY (dryRun) or real removal — same "qualified" meaning as above
    } catch {
      // best-effort
    }
  }

  return { reaped, reapedLocks, kept, keptReasons };
}

/** The worktree-reap RUNG: resolve `config`'s worktreesDir, run {@link reapStaleWorktrees}, ledger the outcome. Shared by `rmd
 * sweep` and the daemon's per-poll hook so both run the EXACT same rung. The try/catch guards ONLY `worktreesDir(config)`,
 * which throws on a malformed root, so a reap-rung failure never masks the caller's own error handling (W1-T175). */
export function runWorktreeReapRung(
  config: Config,
  log: (step: string, extra?: Record<string, unknown>) => void,
): WorktreeReapSummary {
  let reapSummary: WorktreeReapSummary = { reaped: [], reapedLocks: [], kept: [] };
  try {
    reapSummary = reapStaleWorktrees(worktreesDir(config));
    if (reapSummary.reaped.length || reapSummary.reapedLocks.length) log("worktree.reaped", { ...reapSummary });
    // An `activity-unknown` keep is the one outcome needing its own row: the reaper declining to decide, and what bounds disk
    // growth now that an ambiguous signal keeps. Logged even when nothing was reaped, and never for the ordinary keeps, which
    // are the reaper working correctly (W1-T378).
    const undecidable = (reapSummary.keptReasons ?? []).filter((k) => k.reason === "activity-unknown");
    if (undecidable.length) log("worktree.reap.undecidable", { kept: undecidable.map((k) => k.name) });
  } catch (e) {
    log("worktree.reap.error", { error: String((e as Error)?.message ?? e) });
  }
  return reapSummary;
}

/** THE AD-HOC LANE RUNG: the same reaper, pointed at {@link adhocLaneRoot}, shipping SURVEY-FIRST. NO SECOND REMOVAL, BY
 * CONSTRUCTION — it delegates to {@link reapStaleWorktrees} and makes no filesystem call at all, so the 2026-07-31 defect
 * cannot be reinstated here, and the liveness doctrine is inherited whole. It adds one thing only: a different root and a
 * different age ceiling. SURVEY-FIRST IS THE DEFAULT AND THE DEFAULT IS OFF: `enabled` defaults to `false`, so the pass
 * ledgers what it WOULD reclaim while removing nothing. Arming is a separate operator decision (W1-T2847;
 * docs/forensics/worker.md). */
export function runAdhocLaneReapRung(
  config: Config,
  log: (step: string, extra?: Record<string, unknown>) => void,
  deps: {
    root?: () => string;
    reap?: typeof reapStaleWorktrees;
    /** Survey-only while this reads false — the shipped default. See the doc above. */
    enabled?: () => boolean;
    maxAgeMs?: number;
    isPidAlive?: (pid: number, info: RunLockInfo) => boolean;
    /** W1-T2847 design (vi), the REPORTING half. When given, the parent checkout whose registration is read for lanes outside
     * BOTH managed roots — see {@link unmanagedWorktreeLanes}. Omitted ⇒ that report is skipped entirely. */
    repoDir?: string;
    listUnmanaged?: typeof unmanagedWorktreeLanes;
  } = {},
): WorktreeReapSummary | null {
  try {
    const enabled = (deps.enabled ?? (() => false))();
    const reap = deps.reap ?? reapStaleWorktrees;
    const root = (deps.root ?? (() => adhocLaneRoot(config)))();
    const summary = reap(root, {
      dryRun: !enabled,
      maxAgeMs: deps.maxAgeMs ?? ADHOC_LANE_REAP_GRACE_MS,
      isPidAlive: deps.isPidAlive ?? worktreeLockIsPidAlive,
    });
    // LEDGER THE SURVEY EVEN THOUGH NOTHING WAS REMOVED — that IS the deliverable while disarmed. `reapStaleWorktrees`
    // populates `reaped`/`reapedLocks` under `dryRun` precisely so a caller can record what it would have reclaimed
    // (W1-T406's own shape).
    if (summary.reaped.length || summary.reapedLocks.length) {
      log("adhoc_lane.reap", {
        dry_run: !enabled,
        root,
        reaped: summary.reaped.length,
        reaped_locks: summary.reapedLocks.length,
      });
    }
    // W1-T378's doctrine, unchanged: an `activity-unknown` keep is the reaper declining to decide, and it is what bounds
    // growth now that an ambiguous signal keeps rather than destroys.
    const undecidable = (summary.keptReasons ?? []).filter((k) => k.reason === "activity-unknown");
    if (undecidable.length) log("adhoc_lane.reap.undecidable", { kept: undecidable.map((k) => k.name) });
    // NAME the lanes no cadence can reach: that population being invisible, not merely unreaped, is the whole reason 4.7G
    // accumulated with no ledger row. Reported beside the survey and NEVER acted on — by definition these sit outside both
    // managed roots (W1-T2847 design (vi)).
    if (deps.repoDir !== undefined) {
      const unmanaged = (deps.listUnmanaged ?? unmanagedWorktreeLanes)(config, deps.repoDir);
      if (unmanaged.length) log("adhoc_lane.unmanaged", { count: unmanaged.length, lanes: unmanaged });
    }
    return summary;
  } catch (e) {
    // Best-effort, exactly like the sibling boot sweeps — a reclaim rung never blocks a dispatch.
    log("adhoc_lane.reap.error", { error: String((e as Error)?.message ?? e) });
    return null;
  }
}

/** The REPORTING half: every worktree git registers for `repoDir` under NEITHER {@link worktreesDir} NOR {@link adhocLaneRoot}
 * — the lanes no cadence can reach. Reads git's own registration, never a shell-command pattern, because lanes cut by another
 * agent leave no matching command log. REPORTS, NEVER REAPS: these sit outside both managed roots by definition (W1-T2847;
 * docs/forensics/worker.md). */
export function unmanagedWorktreeLanes(
  config: Config,
  repoDir: string,
  runGit: (args: string[], cwd: string) => string = defaultLaneListGit,
): string[] {
  let out: string;
  try {
    out = runGit(["worktree", "list", "--porcelain"], repoDir);
  } catch {
    return []; // unreadable registration ⇒ report nothing, never guess a population
  }
  const managed = [worktreesDir(config), adhocLaneRoot(config)];
  const lanes: string[] = [];
  for (const line of out.split("\n")) {
    const m = /^worktree (.+)$/.exec(line.trim());
    if (!m) continue;
    const path = m[1];
    // The main checkout reports itself first and is not a lane; a path under either managed root is already covered by a
    // rung. Compared with a trailing separator so `…/lanes-old` can never read as being inside `…/lanes`.
    if (path === repoDir) continue;
    if (managed.some((root) => path === root || path.startsWith(`${root}/`))) continue;
    lanes.push(path);
  }
  return lanes;
}

/** The real `git worktree list` reader {@link unmanagedWorktreeLanes} defaults to. Separated so the survey's own seam is
 * injectable without this file's tests shelling git for every case. */
function defaultLaneListGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 24 });
}

// ── gh helpers (run outside the sandbox; TLS fails under Seatbelt) ─────────

/** `gh`'s `X-Ratelimit-*` headers, parsed off the SAME response the metered call carried. TRAP: never read them from a
 * separate `gh api rate_limit` probe — it answers about a DIFFERENT bucket with a DIFFERENT reset (measured 3259 against the
 * probe's 4960 in one window). Every field is `undefined` when the header was absent, which is every non-`gh api` call here
 * (W1-T525; docs/forensics/worker.md). */
export interface GhRateLimitReading {
  remaining?: number;
  used?: number;
  limit?: number;
  reset?: number;
  resource?: string;
}

/** One `X-Ratelimit-*` field out of an HTTP header block, case-insensitively (RFC 7230). */
function ghRateLimitHeaderField(headerBlock: string, name: string): string | undefined {
  return headerBlock.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "im"))?.[1];
}

/** Parse `X-Ratelimit-Remaining`/`-Used`/`-Limit`/`-Reset`/`-Resource` off ONE response's raw header block. This is the ONLY
 * place in this file that reads these headers — see {@link ghJson} for the single call site that supplies the block. */
export function parseGhRateLimitHeaders(headerBlock: string): GhRateLimitReading {
  const num = (name: string): number | undefined => {
    const raw = ghRateLimitHeaderField(headerBlock, name);
    return raw === undefined ? undefined : Number(raw);
  };
  return {
    remaining: num("X-Ratelimit-Remaining"),
    used: num("X-Ratelimit-Used"),
    limit: num("X-Ratelimit-Limit"),
    reset: num("X-Ratelimit-Reset"),
    resource: ghRateLimitHeaderField(headerBlock, "X-Ratelimit-Resource"),
  };
}

/** Sentinel for a bucket or reset that could not be READ, never one merely inconvenient to look up: an unreadable reset is
 * recorded as unknown rather than given an invented wait. Shared by every consumer of {@link GhRateLimitRefusal}, so no
 * caller invents its own placeholder (W1-T1235 design (ii)/(iii)). */
export const GH_RATE_LIMIT_BUCKET_UNKNOWN = "unknown";

/** One GitHub quota bucket's REFUSAL, ready to ledger. `bucket` and `resetsAt` are {@link GH_RATE_LIMIT_BUCKET_UNKNOWN} when
 * there was no header to read them from, never a guess — see {@link ghRateLimitRefusalFromReading} and {@link
 * ghRateLimitRefusalUnknown} (W1-T1235). */
export interface GhRateLimitRefusal {
  /** `X-Ratelimit-Resource` (e.g. `"core"`, `"graphql"`) — read off the response's OWN field, never inferred from which `gh`
   * subcommand or operation was refused. */
  bucket: string;
  /** ISO-8601, converted from the header's Unix-epoch-seconds `X-Ratelimit-Reset`. */
  resetsAt: string;
  /** What was refused — free text a caller supplies for the ledger row / console line. */
  operation: string;
}

/** THE ONE PLACE a {@link GhRateLimitReading} becomes a refusal record. `remaining === 0` is the ONLY evidence treated as a
 * refusal: merely low, or entirely absent as on every non-`gh api` call, returns `undefined` rather than a manufactured
 * refusal, which keeps ordinary traffic from seeding a false one. `bucket` comes off `reading.resource` ALONE and `resetsAt`
 * off `reading.reset` ALONE, either missing rendering {@link GH_RATE_LIMIT_BUCKET_UNKNOWN} — never inferred from `operation`,
 * so the bucket named is provably the response's OWN field rather than a guess keyed on the caller (W1-T1235 design (iv)). */
export function ghRateLimitRefusalFromReading(
  reading: GhRateLimitReading,
  operation: string,
): GhRateLimitRefusal | undefined {
  if (reading.remaining !== 0) return undefined;
  return {
    bucket: reading.resource ?? GH_RATE_LIMIT_BUCKET_UNKNOWN,
    resetsAt: reading.reset !== undefined ? new Date(reading.reset * 1000).toISOString() : GH_RATE_LIMIT_BUCKET_UNKNOWN,
    operation,
  };
}

/** The auto-merge arm's OWN shape: `gh pr merge --auto` is `execFileSync`'d directly, so no header block reaches this file.
 * Both fields are {@link GH_RATE_LIMIT_BUCKET_UNKNOWN}, because this is called ONLY when there is nothing to read: hardcoding
 * `"graphql"`, however true structurally, is the by-caller inference {@link ghRateLimitRefusalFromReading} forbids (W1-T1235;
 * docs/forensics/worker.md). */
export function ghRateLimitRefusalUnknown(operation: string): GhRateLimitRefusal {
  return { bucket: GH_RATE_LIMIT_BUCKET_UNKNOWN, resetsAt: GH_RATE_LIMIT_BUCKET_UNKNOWN, operation };
}

/** Split `gh api -i`'s combined stdout into its HTTP header block and its JSON body — mirroring curl's `-i`: a status line,
 * the response headers (CRLF-terminated, per measurement), one blank line, then the body. Anything that does not start with
 * an HTTP status line (every `gh` invocation this file issues that is not `gh api …`, which never receives `-i` — see {@link
 * ghJson}) is returned whole as `body` with an empty `headers` block, so a caller with no reading to parse can never
 * mis-split real JSON. */
export function splitGhHeaderBlock(out: string): { headers: string; body: string } {
  if (!out.startsWith("HTTP/")) return { headers: "", body: out };
  const sep = out.match(/\r?\n\r?\n/);
  if (!sep || sep.index === undefined) return { headers: "", body: out };
  return { headers: out.slice(0, sep.index), body: out.slice(sep.index + sep[0].length) };
}

/** THE METERED ENTRY POINT: the single place a `gh` invocation is issued AND observed. `maxBuffer` is set here, on the ONE
 * shared codepath, because `buildOpenPrViews` is the one repo-size-scaling caller and its payload crossed Node's 1 MiB
 * default once. For a `gh api …` call this passes `-i`, splits the response, and hands the rate-limit reading to
 * `onRateLimit`; no other subcommand accepts `-i`, and those carry no REST header anyway. The parsed body and every caller's
 * contract are unchanged, and `exec` is injectable so this is testable with no network (W1-T525, W1-T181;
 * docs/forensics/worker.md). */
export function ghJson(
  args: string[],
  onRateLimit?: (reading: GhRateLimitReading) => void,
  exec: (file: string, execArgs: string[], opts: { encoding: "utf8"; maxBuffer: number }) => string = execFileSync,
): unknown {
  const isApiCall = args[0] === "api";
  const execArgs = isApiCall ? [...args, "-i"] : args;
  const out = exec("gh", execArgs, { encoding: "utf8", maxBuffer: 1 << 24 });
  if (!isApiCall) return JSON.parse(out);
  const { headers, body } = splitGhHeaderBlock(out);
  if (onRateLimit) onRateLimit(parseGhRateLimitHeaders(headers));
  return JSON.parse(body);
}

export function ghPrView(prUrl: string): { state: string; mergeable: string; url: string } {
  return ghJson(["pr", "view", prUrl, "--json", "state,mergeable,url"]) as {
    state: string;
    mergeable: string;
    url: string;
  };
}

export function ghPrMergeSquash(prUrl: string): string {
  assertLiveWriteAllowed("gh-pr-merge", `merging ${prUrl}`);
  // TRAP: NO `--delete-branch`. `gh pr merge --help` documents it as deleting the LOCAL branch too, which needs a resolvable
  // current branch — and a caller running from the daemon's deliberately detached checkout has none, so the call failed "not
  // on any branch" even when the merge landed. The repository carries `delete_branch_on_merge: true`, so the head branch is
  // still deleted, server-side (W1-T1050).
  return execFileSync("gh", ["pr", "merge", prUrl, "--squash"], {
    encoding: "utf8",
  });
}
