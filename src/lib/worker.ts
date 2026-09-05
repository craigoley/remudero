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
// Imported ADDITIONALLY as the module's DEFAULT export (a plain, mutable object), used
// ONLY by the run.lock read/write path below (writeRunLock/readRunLock/removeRunLock).
// ESM named-export bindings off `node:fs` are non-configurable (mock.method/
// defineProperty on them throws "Cannot redefine property"), so a test that spies on the
// real module -- the W1-T208 proof that a reader interleaved with the writer never
// observes a torn lock file -- cannot intercept a call already bound to a named import at
// load time. Calling `fs.writeFileSync(...)`/`fs.renameSync(...)` as a property access AT
// CALL TIME (never destructured to a local const) keeps those specific calls a live
// lookup an external `t.mock.method(fs, ...)` actually observes. Matches the identical,
// already-established doctrine atop src/lib/status.ts for the sibling W1-T207 task; the
// rest of this file's fs usage is untouched and keeps its existing named imports.
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
// W1-T2777: same primitive `ensureInstallFresh` (run-task.ts) uses, shared via the extracted
// `install-hash` module so both freshness paths compare the same hash — never a parallel
// implementation that could drift silently. See lib/install-hash.ts for the extraction reason.
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

/**
 * Aggregate token usage off the SDK result envelope's `usage` field (verified
 * ground truth, SDK 0.3.209 `sdk.d.ts`: `NonNullableUsage`, itself `BetaUsage`
 * with ALL fields non-nullable — snake_case Anthropic-API names). Zeroed when
 * no result envelope was ever seen (a genuine transport failure).
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Per-model cost/token breakdown (SDK 0.3.209 `ModelUsage`) — the map KEYS are
 * the model(s) actually used, which may differ from the requested `model`. */
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
  /**
   * Turns the worker actually took (SDK `num_turns` off the result envelope).
   * Recorded on BOTH success and error paths — a run's turn count is telemetry
   * that seeds mounts.yaml calibration (W1-T5), so a failed run is never `0`.
   *
   * W1-T303 GROUND TRUTH: `num_turns` is NOT guaranteed to count the same unit
   * `Options.maxTurns` bounds. sdk.d.ts documents `maxTurns` precisely
   * ("Maximum number of conversation turns before the query stops. A turn
   * consists of a user message and assistant response.") but gives `num_turns`
   * on `SDKResultSuccess`/`SDKResultError` no counting rule at all beyond the
   * bare type `number` — treating the two as interchangeable was always an
   * ASSUMPTION, not something the contract promises. MEASURED over every
   * `recon.done` row for 2026-08-03 under a single hardcoded `maxTurns: 8`:
   * eleven `error_max_turns` failures, across both routed models, every one
   * landing at EXACTLY `num_turns: 9` (cap+1 — consistent with one extra
   * wrap-up turn closing out the error envelope after the cap trips), and one
   * SUCCESS at `num_turns: 17` — nearly double the cap, with no error and no
   * resume/retry involved (recon's retry, W1-T299, always issues a brand-new
   * `query()` call with no `.resume`, never carries a turn count over). A
   * `num_turns` this far past the cap on a clean success means whatever the
   * CLI enforces `maxTurns` against is not simply "the same counter `num_turns`
   * reports" — the leading, falsifiable-but-unverified account is that a
   * mid-run compaction (already detected here as `compactionEvents`) resets
   * the CLI's own enforcement window while `num_turns` keeps a cumulative,
   * whole-session tally; this diagnosis did not confirm that mechanism (it
   * would require inferring from the ledger, which is the same evidence class
   * the puzzle came from) and files it as a follow-up rather than asserting
   * it. Either way: `numTurns` alone cannot be reasoned about against a cap
   * unless the cap it actually ran under rides the SAME row — see `maxTurns`
   * below, which does exactly that.
   */
  numTurns: number;
  /**
   * W1-T303: the `maxTurns` THIS call was CONFIGURED with (from
   * `SpawnWorkerArgs.maxTurns`) — an INPUT, never a read-back off the
   * envelope, mirroring the `model`/`effort` discipline below. Ledgered
   * BESIDE `numTurns`/`num_turns` (never replacing it) precisely so a ledger
   * row can be checked against its own cap without cross-referencing
   * `mounts.yaml`, which changes over time and had already moved
   * (`RECON_MAX_TURNS` 8 → 20) by the time this mismatch was diagnosed —
   * `undefined` (never guessed) when the caller configured no cap.
   */
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
  /**
   * An Anthropic-SIDE api error hit the stream (a `<synthetic>`/`isApiErrorMessage`
   * "API Error: Server error mid-response" message), which the result ENVELOPE may still
   * report as subtype:"success" (WS-0 envelope shape). This is a TRANSIENT signal for the
   * classifier (retry, no strike) — NOT a task failure. Run W1-T12a-1784117152056 lost this
   * because nothing captured it and the classifier was never wired.
   */
  apiError: boolean;
  /**
   * W1-T2564: THE ACCOUNT REFUSED THIS RUN FOR A SESSION/USAGE LIMIT. Same shape and same reason
   * as {@link apiError} directly above — a condition the result ENVELOPE misreports as
   * `subtype: "success"`, so a distinct field is the only place it can survive.
   *
   * THE SDK EMITS A SUCCESS ENVELOPE AND THEN THROWS. `collectWorkerResult`'s catch already
   * swallows that throw (the envelope is real and captured) and sets `isError`, but `subtype` was
   * written by the success envelope BEFORE the throw and nothing rewrites it — so
   * {@link workerLedgerFields}'s `r.isError ? r.subtype : "success"` resolves BOTH arms to
   * "success" and the refusal is erased. MEASURED over the three-form union: 793 rows across five
   * rungs recorded `verdict: "success"` for a run the account had refused, 775 of them
   * `inbox.draft_synthesized`.
   *
   * NOT DERIVED FROM COST. 768 of 1,022 draft rows carried `cost_usd: 0` and every one was a
   * refusal — but SEVEN refusals carried a NON-ZERO cost, so the two sets are not equal and a
   * price test both misses those and catches genuinely free runs.
   */
  usageRefusal?: { matched: string; resetsAtText?: string; resetsAtMs?: number };
  /** Permission denials the SDK surfaced (hook/permission blocks). */
  permissionDenials: unknown[];
  /** The exact env the child was spawned with (billing-boundary proof). */
  childEnvKeys: string[];
  /**
   * W1-T268: the Anthropic account this call's spend is attributed to — the SAME
   * `accountUuid`/`emailAddress` NAME (never a secret) {@link resolveActiveAccountId}
   * resolves and W1-T265's `ensureWorkerKeychain` already compares for identity
   * drift. Resolved fresh per spawn, regardless of platform, so every ledger line
   * carrying a spend figure can also carry the account it was drawn against.
   * `undefined` when no identity could be resolved (e.g. no `~/.claude.json`) —
   * never guessed.
   */
  accountLabel?: string;
  /**
   * The model this call was CONFIGURED to run — an INPUT (the caller's
   * `SpawnWorkerArgs.model`, mount-resolved for implement, unset elsewhere),
   * never a read-back off the envelope (`DEFAULT_MODEL_LABEL` when unspecified).
   */
  model: string;
  /** Concrete provider model selected after health/capability routing. */
  routedModel?: string;
  /** Health of the originally preferred Claude candidate when Claude was considered. */
  modelHealthState?: ClaudeModelHealthState;
  /** Whether the health decision used a live/fresh read, bounded stale evidence, or no evidence. */
  modelHealthSource?: ClaudeModelHealthSource;
  /**
   * The reasoning effort this call was CONFIGURED to run. Same INPUT-not-output
   * rule as `model`: effort is NOT in the SDK result envelope (LEARNINGS — the
   * W1-T6 exploration tax), so this is the configured value, never a read-back.
   */
  effort: string;
  /** Aggregate token usage off the result envelope (zeroed if none was seen). */
  tokens: TokenUsage;
  /** Per-model breakdown off the envelope's `modelUsage` map (`{}` if none seen). */
  modelUsage: Record<string, ModelUsageEntry>;
  /**
   * W1-T2572 (THE SERVED HALF OF THE PAIR): the concrete model id the PROVIDER itself
   * reported serving this call — on the Claude path, read verbatim off the live SDK
   * assistant stream's own `msg.message.model` field (never the `modelUsage` map keys,
   * which are a post-hoc cost breakdown, not a live per-turn report), the LAST real
   * (non-`<synthetic>`) value seen before the stream ended. `model` above is the
   * REQUEST — an INPUT, mount-resolved BEFORE the spawn, unchanged by whatever the
   * provider actually ran. The two ride the SAME row so a run where they disagree (a
   * routed alias resolving to a different concrete snapshot, a Codex account serving
   * off its own preference list) is directly queryable without a second join, and a
   * later per-mount aggregate never silently averages across models it never named.
   *
   * `null` when the provider's own output carried no field naming what it served —
   * paired with {@link servedModelReason}. VERIFIED, not assumed: `codex exec --json`
   * (codex-cli 0.152.0) was probed live and its `thread.started` / `turn.started` /
   * `turn.completed` / `item.completed` / `error` events carry no served-model field at
   * all, so the Codex path records this pair honestly rather than echoing back the
   * `--model` flag it was given — echoing the ASK back as the SERVED value is exactly
   * the guess this field exists to refuse.
   *
   * Optional only so every hand-built `WorkerResult` fixture across test/ that predates
   * this task keeps typechecking unmodified; {@link workerLedgerFields} treats an absent
   * value identically to an explicit `null`.
   */
  servedModel?: string | null;
  /**
   * W1-T2572: present only when {@link servedModel} could not be resolved to a real id
   * — names WHY, so a `null` row reads as "checked, unreportable" rather than "forgot
   * to check". Absent (never a blank string) whenever `servedModel` is a real id.
   */
  servedModelReason?: string;
  /**
   * Compaction events observed in this call's stream (MASTER-PLAN §8B),
   * detected LIVE off `type:"system", subtype:"compact_boundary"` messages
   * (`detectCompactionEvents`, compaction.ts) — `[]` when the call never
   * compacted.
   */
  compactionEvents: CompactionEvent[];
  /**
   * `true` the moment ONE compaction fired (`compactionEvents.length > 0`,
   * MASTER-PLAN §8B) — this call's acceptance proofs must be re-verified
   * against repo state (W1-T3F), never trusted from a possibly-lossy REPORT.
   */
  /**
   * W1-T2245: compaction ATTEMPTS that FAILED — read off the SDK's `compact_result: 'failed'`
   * channel (`SDKStatusMessage`, sdk.d.ts:4684), which carries NO `compact_boundary` message and so
   * was previously invisible to `compactionEvents`/`qualitySuspect` entirely: an attempted-and-
   * failed compaction read identically to one that never happened. `[]` when no failure was seen —
   * same "empty means checked, not absent" discipline as `compactionEvents` itself. Deliberately
   * NOT folded into `qualitySuspect`: a FAILED attempt compacted nothing, so the call's content is
   * no more suspect than before — `qualitySuspect` keeps its exact current meaning (fires ONLY off
   * a real boundary), per this task's own constraint that existing compaction fields are untouched.
   * Optional (never `[]`-by-force) purely so the dozens of hand-built `WorkerResult` fixtures across
   * test/ that predate this task keep typechecking unmodified — `workerLedgerFields` below treats an
   * absent value as `[]`, identical to what a real `collectWorkerResult` call always returns.
   */
  compactionFailures?: CompactionFailure[];
  /**
   * W1-T2245: whether THIS spawn's `Options` object carried `autoCompactEnabled: true` — the row's
   * answer to "was auto-compaction even possible here", so `quality_suspect: false` +
   * `compactionEvents: []` can be read as NEVER-NEEDED (configured, never fired) rather than
   * guessed to mean the same thing as DISABLED (never configured at all). Read off `options`
   * itself at the spawn call site (never a second source), via an index/`in` check rather than a
   * property access: `Options` (sdk.d.ts 0.3.233 ground truth) declares NO `autoCompactEnabled` key
   * at all — that lives only on the separate `Settings` interface, reachable only through a loaded
   * settings file, and `spawnWorker` always passes `settingSources: []`. So this reads `false` on
   * every call today, and that IS the finding this task exists to ledger: the fleet has no live
   * channel to turn auto-compaction on, and the zero was previously silent about it. This task
   * adds NO key to `options` — it only reads whatever is already there, so a future spawn path
   * that legitimately sets the option (not this one) is picked up rather than needing this call
   * site edited. Optional for the SAME reason `compactionFailures` above is: existing hand-built
   * `WorkerResult` fixtures across test/ keep typechecking unmodified; `workerLedgerFields` treats
   * an absent value as `false`, identical to what a real `collectWorkerResult` call always returns.
   */
  compactionConfigured?: boolean;
  /**
   * Worker-home grants that were LOST or HEALED for this spawn (see
   * {@link lostWorkerHomeGrants}) — absent when every grant landed, which is the overwhelmingly
   * common case, so the verdict row grows nothing on a healthy run.
   */
  lostGrants?: WorkerHomeGrantOutcome[];
  qualitySuspect: boolean;
  /**
   * W1-T477: wall-clock milliseconds this call spent inside the actual SDK query — measured in
   * {@link collectWorkerResult}, around the message-consumption loop that IS the worker call
   * (excludes the pre-spawn setup above it in {@link spawnWorker}: config load, worker-home
   * materialization, keychain unlock — all local/free per that function's own "impl-EM" comment).
   * Optional, never guessed: a hand-built `WorkerResult` fixture (every existing test helper in
   * test/) simply omits it, and `workerLedgerFields` renders it absent rather than 0 on a call
   * that was never really timed. Answers the operator's fourth analytics question ("time per
   * command/worker") — before this field, `workerLedgerFields` carried cost/tokens/model/effort
   * and no duration at all (see the rationale this task was filed from).
   */
  workerDurationMs?: number;
  /**
   * Reset-stable subscription-window percentage points consumed while this worker exclusively
   * owned its selected provider. Present only on the opt-in multi-provider path; the default
   * Claude-only path performs no extra capacity reads and omits this field byte-for-byte.
   */
  windowConsumption?: ProviderWindowConsumption;
}

/** `model`/`effort` label logged when a call rides no explicit mount override
 * (e.g. recon, the advisory reviewer) — an honest "unset", never a guessed value. */
export const DEFAULT_MODEL_LABEL = "default";
export const DEFAULT_EFFORT_LABEL = "default";

/** The DEFAULT billing mode: absent the opt-in overflow valve, `buildWorkerEnv`
 * strips every `ANTHROPIC_*` var before a worker spawns (W1-T1), so the run is
 * metered against the subscription. When the operator engages the valve (exports
 * `ANTHROPIC_API_KEY`, W1-T258) the mode is instead DERIVED per-call from the
 * child's actual key set via {@link billingMode}(`childEnvKeys`) — a ledger line
 * still can never drift from the true boundary because it reads the very env
 * names the worker spawned with, not a guess. */
export const BILLING_MODE: BillingMode = "subscription";

/**
 * Cache-token NAMED COLUMNS (MASTER-PLAN §8A / W1-T35): the aggregate
 * `tokens.cacheRead`/`cacheCreation` (camelCase, nested inside `tokens`)
 * mirrored as FLAT, snake_case columns matching the SDK result envelope's own
 * field names (`cache_read_input_tokens`/`cache_creation_input_tokens`). A
 * ledger line's other telemetry (`cost_usd`, `num_turns`, …) is already flat
 * snake_case — the nested `tokens` object was the odd one out and not
 * grep/jq-able as a "column". This makes the cache-reuse signal MASTER-PLAN
 * §8A calls for ("near-zero cache reads on the second worker of a run means
 * the ordering is wrong") directly queryable off a worker's ledger line
 * without reaching into a nested object.
 */
export function cacheTokenLedgerFields(tokens: TokenUsage): {
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
} {
  return {
    cache_read_input_tokens: tokens.cacheRead,
    cache_creation_input_tokens: tokens.cacheCreation,
  };
}

/**
 * Persisted-stderr length ceiling (W1-T238, the "Not logged in" incident): the
 * child's stderr and any swallowed error-result text lived only in
 * `stderrChunks`/`text` in memory and were discarded once the spawn returned —
 * two production spawns failed and the one artifact that named the cause had
 * to be reconstructed by a repro instead of read off disk. This bounds the
 * PERSISTED copy so a runaway transcript cannot bloat the ledger; it never
 * bounds what stays in-memory on {@link WorkerResult} itself.
 */
export const STDERR_EXCERPT_CAP = 4000;

/** Truncate `s` to {@link STDERR_EXCERPT_CAP} chars, noting how much was cut —
 * never a silent drop. */
export function capStderrExcerpt(s: string, cap: number = STDERR_EXCERPT_CAP): string {
  return s.length > cap ? `${s.slice(0, cap)}…[truncated, ${s.length - cap} more chars]` : s;
}

/**
 * The capped, ledger-safe excerpt of a FAILED spawn's stderr + error-result
 * text (W1-T238). Returns `undefined` for a clean spawn (`isError=false`) or
 * one with nothing to say, so a success line never carries this field — a
 * clean spawn must not spam the ledger with an empty/absent excerpt.
 */
export function workerFailureExcerpt(r: Pick<WorkerResult, "isError" | "stderr" | "text">): string | undefined {
  if (!r.isError) return undefined;
  const combined = [r.stderr, r.text].filter((s) => s && s.trim().length > 0).join("\n");
  return combined ? capStderrExcerpt(combined) : undefined;
}

/**
 * Persisted-report length ceiling (W1-T407) — the SAME discipline as {@link STDERR_EXCERPT_CAP}
 * applied to a different string: a terminal-SUCCESS worker's own closing narrative instead of a
 * failed spawn's stderr. Not a new design problem, just this mechanism applied to the text the
 * SILENT NO-OP GUARD in run-task.ts already parses three times (decision request, PR url,
 * already-satisfied claim) and, until now, dropped once no PR came out of it.
 */
export const REPORT_EXCERPT_CAP = 4000;

/**
 * W1-T2205: THE ONE JOIN, ONE PLACE. `text` is documented as "Final result text (the `result`
 * field of the SDK result message)"; `blocks` is "All assistant text blocks concatenated, in
 * order" — and `collectWorkerResult` (worker.ts's result loop) pushes EVERY assistant text
 * block onto `blocks`, THEN sets `text = r.result` off the terminal envelope. If the SDK's
 * `result` is itself an echo of the last assistant text block (measured true for a real
 * captured envelope — see this task's PR body for the citation either way), a hand-rolled
 * `[r.text, r.blocks.join("\n")].join("\n")` carries the worker's final message TWICE. Every
 * count-sensitive parse over that join (OPTION: lines, verdict markers, …) then silently
 * over-counts — this function exists so that never happens more than once.
 *
 * Contract: SAME shape and ordering as the hand-rolled `[r.text, r.blocks.join("\n")].join("\n")`
 * it replaces — `text` first, then `blocks` in their own chronological order — with the final
 * message appearing EXACTLY ONCE. When `blocks`'s own last entry is not simply a repeat of
 * `text` (the overlap does not hold, or `blocks` is empty), nothing is dropped; every existing
 * call site's "last marker line wins" parsing therefore sees the identical text it always did,
 * minus the duplicate.
 */
export function workerTranscript(r: Pick<WorkerResult, "text" | "blocks">): string {
  const overlaps = r.blocks.length > 0 && r.blocks[r.blocks.length - 1] === r.text;
  const blocks = overlaps ? r.blocks.slice(0, -1) : r.blocks;
  return [r.text, ...blocks].join("\n");
}

/**
 * The capped, ledger-safe excerpt of a worker's own report — `text` + `blocks` joined, the
 * same shape run-task.ts's local `fullText` closure already builds for every parse at that
 * call site. Returns `undefined` for empty/whitespace-only input, so a truly silent no-op
 * (nothing said, nothing committed) never carries a blank/empty field on its ledger row — the
 * same "absent, never empty" discipline {@link workerFailureExcerpt} already keeps for stderr.
 */
export function noPrReportExcerpt(r: Pick<WorkerResult, "text" | "blocks">): string | undefined {
  const combined = [r.text, r.blocks.join("\n")].filter((s) => s && s.trim().length > 0).join("\n");
  const trimmed = combined.trim();
  return trimmed ? capStderrExcerpt(trimmed, REPORT_EXCERPT_CAP) : undefined;
}

/**
 * The standard per-call ledger telemetry (W1-T6 acceptance): every worker AND
 * brain-plane (architect/reviewer) call logs `{model, effort, tokens,
 * cache_read_input_tokens, cache_creation_input_tokens, total_cost_usd,
 * billing_mode, verdict}`. Extracted so every call site in run-task.ts spreads
 * the SAME shape rather than hand-rolling it — one definition, so the fields
 * can never drift between recon/implement/review/retro.
 *
 * `verdict` here is this CALL's own outcome (`"success"` or the SDK's error
 * subtype) — distinct from the RUN-level `verdict` ledger line (merged /
 * blocked_* / failed), which judges the whole run, not one worker spawn.
 *
 * `quality_suspect`/`compaction_events` (MASTER-PLAN §8B / W1-T36) ride the
 * SAME line as `verdict` — a compacted call's ledger line is directly
 * queryable/grep-able for both its outcome and whether that outcome should
 * be trusted, with no join against a separate compaction event stream.
 *
 * `stderr_excerpt` (W1-T238) rides the same line, capped via
 * {@link workerFailureExcerpt} — present ONLY when `r.isError`, so the run's
 * own ledger (keyed by `run_id`/`task_id` at every existing call site) is the
 * recoverable-after-the-fact home for the stderr that used to die with the
 * process, never a second, uncapped surface.
 *
 * `max_turns` (W1-T303) rides the same line for the SAME reason `quality_suspect`
 * does: every call site already logs `num_turns: r.numTurns` by hand next to this
 * spread, and `num_turns` alone cannot be reasoned about against a cap that lives
 * only in `mounts.yaml` — a value that moves over time (`RECON_MAX_TURNS` itself
 * moved 8 → 20 the same day this mismatch was found). Ledgering the cap THIS call
 * was configured with, beside `num_turns` rather than replacing it, means every
 * historical row stays checkable against its own cap forever, independent of
 * whatever mounts.yaml says today.
 *
 * `compaction_configured`/`compaction_failures` (W1-T2245) ride the SAME line for the SAME
 * reason: a reader of `quality_suspect: false` / `compaction_events: []` could not previously
 * tell DISABLED (compaction never configured) from NEVER-NEEDED (configured, just never fired)
 * from FAILED (attempted, and the SDK's own `compact_result: 'failed'` channel went unread). All
 * three now ride this one line, so the zero explains itself without a second query.
 *
 * `served_model`/`served_model_reason` (W1-T2572) ride the SAME line beside `model` for the
 * reason {@link WorkerResult.servedModel}'s own doc gives in full: `model` is the REQUEST (an
 * alias like `sonnet`, resolved before the spawn), `served_model` is what the provider actually
 * ran, and only logging both on the SAME row lets a later reader see the two disagree instead of
 * silently collapsing them into one label. ALWAYS present (never omitted, unlike the optional
 * fields above) — defaulted to `null` off an absent `r.servedModel` so a fixture that predates
 * this task, or a provider that reports nothing, renders the SAME honest "unknown" a real
 * unreportable call would, never a key that looks forgotten. `served_model_reason` rides beside
 * it ONLY when the id is `null`, falling back to a generic "provider reported no served model"
 * when `r.servedModelReason` itself was not set (the Codex path today: {@link spawnCodexWorker}
 * sets neither field, verified empirically against codex-cli 0.152.0's `--json` event stream) —
 * fail-soft per this task's own constraint: an unreportable served model must never fail the run,
 * so this function itself never throws over a missing one.
 */
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
    // OMITTED when every grant landed — the common case adds no field at all, which is what
    // keeps a per-run row from carrying four states it does not need. Present only when a grant
    // was lost or healed, and then it names WHICH slot and why.
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
    // W1-T2572: ALWAYS present, unlike the optional fields above — `null` is the honest,
    // explicit value for "unreportable", never an omitted key that reads as forgotten. See
    // this function's own doc and {@link WorkerResult.servedModel} for the full contract.
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
    // W1-T268: the account this spend is attributed to — a NAME (never a
    // credential), same discipline `billing_mode` above already keeps. Carried
    // verbatim off `WorkerResult.accountLabel`; `undefined` (never guessed) when
    // spawnWorker could not resolve one.
    account_label: r.accountLabel,
    // W1-T2564: A REFUSAL OUTRANKS THE ENVELOPE'S OWN SUBTYPE. The previous form was
    // `r.isError ? r.subtype : "success"` — right in intent ("when this errored, name the error")
    // and defeated by the data: on the swallow path `subtype` was written by a SUCCESS envelope
    // seen BEFORE the SDK threw, so `isError` was true, `subtype` was "success", and BOTH arms
    // rendered "success". 793 refusals across five rungs were recorded as completed work.
    //
    // CHECKED FIRST, not folded into the ternary, because the ordering IS the fix: the envelope's
    // subtype is exactly the field that lies here, so a refusal must not consult it. Every other
    // path is byte-identical to before — `recon.done`'s `error_max_turns` (an envelope that DID
    // name its error) still renders `error_max_turns`, and a clean run still renders "success".
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
    // W1-T2245: default `false`/`[]` for the same "optional so the pre-existing fixture literals
    // across test/ keep typechecking" reason both fields on WorkerResult are optional — a real
    // `collectWorkerResult` call always populates both explicitly, so this default is exercised
    // only by hand-built results that predate this task.
    compaction_configured: r.compactionConfigured ?? false,
    compaction_failures: r.compactionFailures ?? [],
    // W1-T477: per-call wall-clock, mirrored verbatim off `WorkerResult.workerDurationMs` — see
    // that field's own doc. `undefined` (never a guessed 0) on a hand-built test fixture that
    // never went through a real spawn; JSON.stringify drops an undefined key, so an untimed call's
    // ledger line simply carries no `worker_duration_ms` key at all, the same "absent, never
    // guessed" discipline `max_turns` above already keeps.
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

/**
 * W1-T2441: the fields the previously-discarded {@link WorkerHomeReapResult} becomes once
 * observed — target/reason/spawn-identity, named so a query over them can answer the falsifier
 * this task's own filing could not close ("a `worker-home-DAEMON-<runid>` removal racing a live
 * sibling spawn — a reap and a still-running child on the same path, both timestamped").
 *
 * Pure — {@link spawnWorker}'s `finally` is the only real caller and the default sink
 * ({@link defaultLogHomeReap}) is a thin `console.error` wrapper around this, so a test can drive
 * every arm (`guard-rejected` / `absent` / reaped-true / a caught error) with no process spawned.
 *
 * NOT a ledger row: this module writes no ledger rows by design (see `workerLedgerFields`'s own
 * "carried on the RESULT rather than logged here" note above `lostGrants`) — reap visibility is
 * diagnostic-only and, per this task's own filing, deliberately does NOT belong in
 * `DECISION_RELEVANT_LEDGER_STEPS`: nothing downstream reads it to decide anything, so adding it
 * there would widen this change's span for nothing.
 */
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

/** Default {@link SpawnWorkerArgs.logHomeReap} sink — one JSON line to stderr, matching this
 *  file's other best-effort exit-path diagnostics (e.g. `assertWorktreeBaseCurrent`'s `warn`). */
function defaultLogHomeReap(result: WorkerHomeReapResult, spawn: { runId?: string; taskId?: string }): void {
  console.error(JSON.stringify(workerHomeReapLogFields(result, spawn)));
}

/**
 * W1-T2518: the fields `ensureWorkerKeychain`'s {@link WorkerKeychainSummary} becomes once
 * observed at THIS call site — `observedHeadroomMs` (worker-home.ts:1080) existed since
 * W1-T2398 but this call site previously discarded the whole summary, chaining `.keychainPath`
 * directly off the call and reading nothing else (`git grep -n '= ensureWorkerKeychain(' src/`
 * read one hit, `.keychainPath` chained straight off it, before this task). Logged on EVERY
 * darwin provisioning call, `expectedRunMs` supplied or not, so the rate the credential's
 * expiry margin is actually exercised becomes answerable off-host — worker-home.ts's own doc
 * names this exact gap ("the rate this shard's own rationale could not measure from a ledger
 * becomes answerable off-host purely by a caller logging this field").
 *
 * Pure — {@link spawnWorker}'s darwin branch is the only real caller and the default sink
 * ({@link defaultLogKeychainHeadroom}) is a thin `console.error` wrapper around this, matching
 * `workerHomeReapLogFields`'s identical discipline just above.
 */
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

/** Default {@link SpawnWorkerArgs.logKeychainHeadroom} sink — one JSON line to stderr, matching
 *  this file's other best-effort exit-path diagnostics (e.g. `defaultLogHomeReap` above). */
function defaultLogKeychainHeadroom(
  summary: WorkerKeychainSummary,
  expectedRunMs: number | undefined,
  spawn: { runId?: string; taskId?: string },
): void {
  console.error(JSON.stringify(workerKeychainHeadroomLogFields(summary, expectedRunMs, spawn)));
}

// ── Toolchain resolution (W1-T113: the vanished-binary incident) ───────────
//
// `config.claudeBin` is resolved ONCE via `which claude` when
// `~/.config/remudero/config.json` is first created (config.ts's
// `resolveClaudeBin`) and then CACHED TO DISK — exactly the "pinned while the
// toolchain self-updates" shape the incident hit: a Claude Code auto-update
// (or a manual migration off npm — the upstream README now reads "Installation
// via npm is deprecated", verified via `gh api repos/anthropics/claude-code`
// since this checkout has no network path to the hosted setup docs, distrust
// this prompt's memory / Standing rule 7) can move the real binary out from
// under that cached path mid-operation. Resolution below runs FRESH at spawn
// time instead, in priority order: an explicit operator override, a live PATH
// lookup, then the known install-location table — never the stale disk cache
// alone. Cached PER PROCESS once resolved (see `ClaudeExecutableCache`), and
// PREFLIGHT-checked (exists AND runs `--version`) before ever reaching the
// SDK, so a bad resolution fails loud — before any worker-home/keychain work
// runs — rather than surfacing deep inside a spawn as "native binary not
// found" (MASTER-PLAN Field Finding 12).

/** Operator escape hatch: an explicit path always wins over PATH/the table. */
export const CLAUDE_BIN_ENV_OVERRIDE = "REMUDERO_CLAUDE_BIN";

/**
 * One row of the install-location table — DATA (W1-T113 acceptance: "the
 * location table is data" — adding a row here resolves a newly seeded
 * location with ZERO resolution-code changes). `resolve` returns `undefined`
 * when a row does not apply; a row that DOES apply is still existence- and
 * runnability-checked like every other candidate, never trusted blind.
 */
export interface ClaudeExecutableCandidate {
  /** Short label carried into the refusal reason and the boot log. */
  label: string;
  resolve: (env: NodeJS.ProcessEnv, home: string) => string | undefined;
}

/**
 * The known Claude Code install locations. Verified from the upstream repo
 * rather than trusted from memory (Standing rule 7): `gh api
 * repos/anthropics/claude-code` — README.md ("Installation via npm is
 * deprecated") + CHANGELOG.md, whose 2.1.143 and 2.1.207 entries both name
 * `~/.local/bin/claude` as the native-installer launcher the auto-updater
 * manages, distinct from the (deprecated but still real, and this fleet's own
 * current install method — MASTER-PLAN Field Finding 3) npm-global prefix.
 * Order matters: the FIRST existing+runnable candidate wins.
 */
export const CLAUDE_EXECUTABLE_LOCATIONS: ClaudeExecutableCandidate[] = [
  { label: "npm-global", resolve: (_env, home) => join(home, ".npm-global", "bin", "claude") },
  { label: "native-installer (~/.local/bin)", resolve: (_env, home) => join(home, ".local", "bin", "claude") },
];

/** The cause of a probed candidate's `--version` failure — an errno/exit
 * `code` (e.g. `EACCES`, `ENOEXEC`) plus at most a truncated first line of
 * stderr. Deliberately narrow (W1-T901 design (iii)): never the child
 * environment (the W1-T442 billing/credential boundary) and never an
 * unbounded stderr dump into an escalation issue body. */
export interface CanExecuteFailure {
  code?: string;
  message?: string;
}

/** One resolution attempt, kept for the refusal reason: which label, which
 * path, whether it existed, whether it ran (only meaningful if it did), and
 * — when it existed but didn't run — the probe's cause (W1-T901). */
export interface SearchedClaudeCandidate {
  label: string;
  path: string;
  existed: boolean;
  ran: boolean;
  cause?: CanExecuteFailure;
}

/** `SearchedClaudeCandidate` -> its outcome, for the refusal message. A
 * candidate that exists but didn't run names its cause when one was
 * captured — `exists, --version failed (EACCES: ...)` — so a non-executable
 * husk is distinguishable from a binary that runs and crashes (W1-T901);
 * with no cause it falls back to the bare W1-T113 message unchanged. */
function describeSearched(s: SearchedClaudeCandidate): string {
  if (!s.existed) return "missing";
  if (s.ran) return "ok";
  const parts = [s.cause?.code, s.cause?.message].filter((p): p is string => !!p);
  return parts.length ? `exists, --version failed (${parts.join(": ")})` : "exists, --version failed";
}

/**
 * Structured refusal (W1-T91 classification: infrastructure, never a task
 * defect) thrown when NO candidate resolves to an existing, runnable
 * executable. Carries every searched path — distinguishing "missing" from
 * "exists but `--version` failed" — so the refusal reason is never a bare
 * "not found". `reasonClass` is a plain string tag (not `instanceof`) so a
 * caller in a different module (daemon.ts) can classify this duck-typed,
 * without importing this class as a value.
 */
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

/** Per-process memo (see `createClaudeExecutableCache`) — resolution runs at
 * most once per process; every later `spawnWorker` call reuses the answer. */
export interface ClaudeExecutableCache {
  resolved?: string;
}

export function createClaudeExecutableCache(): ClaudeExecutableCache {
  return {};
}

/**
 * Injectable seams for `resolveClaudeExecutable` — the real call site defaults
 * every one of these to the live filesystem/PATH/subprocess; tests inject
 * fakes so "pinned path absent, table hit" and "everything absent" are
 * provable over injected fs/exec, with no real binary involved.
 */
export interface ResolveClaudeExecutableDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
  /**
   * A LIVE `which claude` lookup (never PATH resolved once and cached to
   * disk — that staleness is exactly config.ts's `resolveClaudeBin`, which
   * this routes around). Returns `undefined` when `claude` is not on PATH.
   */
  which?: () => string | undefined;
  /**
   * Does this path actually run? (`--version`.) `true` on success, kept as
   * cheap as ever. A failure may answer a bare `false` (every existing
   * injection site does this, and stays valid unchanged — W1-T901 design (i))
   * or a `CanExecuteFailure` carrying the probe's cause for the refusal
   * message to render.
   */
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

/** Cap on the captured stderr excerpt (W1-T901 design (iii)) — a diagnosis
 * needs a first line, not a dump. */
const CAN_EXECUTE_FAILURE_MESSAGE_MAX = 200;

/** `execFileSync`'s thrown error -> a `CanExecuteFailure`: the errno/exit
 * `code` Node attaches to a failed spawn (`EACCES`, `ENOEXEC`, `ENOENT`, ...)
 * plus at most a truncated first non-empty line of stderr. Deliberately does
 * NOT touch the error's `.cmd` (may embed argv) or read `process.env` — the
 * child's environment never enters this message (W1-T442 rule). */
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
    // stdout ignored (never needed); stderr piped so a real failure's cause
    // (e.g. a crashing binary's first diagnostic line) is capturable —
    // still bounded and never the child env, per describeExecFailure above.
    execFileSync(path, ["--version"], { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch (err) {
    return describeExecFailure(err);
  }
}

/**
 * Resolve the real `claude` binary at SPAWN time (W1-T113 part i): an
 * explicit env override, then a live PATH lookup, then the location table —
 * in that order, memoized in `cache` once an answer is found. Every candidate
 * is PREFLIGHTED (W1-T113 part ii: exists AND runs `--version`) before being
 * accepted; a candidate that exists but won't run is recorded as such in the
 * refusal, distinct from one that's simply missing. Throws
 * `ClaudeToolchainBlockedError` (never a raw ENOENT) when nothing resolves,
 * naming every searched path — the run is refused cleanly rather than
 * crashing on a bare `ENOENT` deep inside the SDK's spawn.
 */
export function resolveClaudeExecutable(cache: ClaudeExecutableCache, deps: ResolveClaudeExecutableDeps = {}): string {
  if (cache.resolved) return cache.resolved;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const exists = deps.exists ?? existsSync;
  const which = deps.which ?? defaultWhich;
  const canExecute = deps.canExecute ?? defaultCanExecute;
  const locations = deps.locations ?? CLAUDE_EXECUTABLE_LOCATIONS;

  // One ordered candidate list (env override, then a live PATH lookup, then the
  // location table) walked by a single loop — every row is the SAME shape
  // (`label` + a lazy `resolve`), so PATH's subprocess call and the table's
  // plain path joins are short-circuited identically: a row is only resolved
  // once every earlier row has already failed.
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
    // Only a probed (existing) candidate can carry a cause — a missing
    // candidate is never probed at all (W1-T113's exists/missing
    // distinction, unchanged by W1-T901).
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

/**
 * The shared, PER-PROCESS cache every real `spawnWorker` call reuses (see
 * `ClaudeExecutableCache`'s doc). Exported so the daemon's boot routine can
 * resolve — and log — the SAME answer once at startup rather than a separate,
 * possibly-different resolution (W1-T113 part i: "log the resolved path once
 * at daemon boot").
 */
export const claudeExecutableCache: ClaudeExecutableCache = createClaudeExecutableCache();

/**
 * Pure: the macOS keychain grant list (W1-T113) — the FRESHLY resolved `claudeBin`
 * (never `config.claudeBin`'s stale disk-cached value, exactly the vanished-binary
 * incident's shape) plus the fixed `/usr/bin/security` helper every worker keychain
 * grant needs. Extracted so this one-line assembly is unit-testable directly, without
 * invoking `ensureWorkerKeychain` (a real keychain side effect) or gating a test on
 * `process.platform` (spawnWorker's darwin-only call site, below, is untestable off
 * a Linux CI runner by construction).
 */
export function workerKeychainGrantApps(claudeBin: string): string[] {
  return [claudeBin, "/usr/bin/security"];
}

/**
 * W1-T265: the Anthropic account identity active on this host — an
 * `accountUuid`/`emailAddress` NAME, read fresh (never cached) from
 * `~/.claude.json`'s `oauthAccount` block, forwarded to `ensureWorkerKeychain`'s
 * `accountId` opt so an account switch is detected. Deliberately NOT the copied
 * worker keychain item's own `acct` attribute — account-usage.ts measured that
 * value to be the OS username, identical before and after an Anthropic account
 * switch, so it cannot discriminate accounts.
 *
 * A private, minimal re-implementation rather than importing account-usage.ts's
 * own `readAccountUsageFile`: that module already depends on panel-actions.ts,
 * which depends on THIS file (`appendQuestionAnswer`) — importing it here would
 * close that into an import cycle. Fails soft to `undefined` on any read/parse
 * error or unexpected shape, matching account-usage.ts's own fail-soft doctrine:
 * this must never throw and never block a spawn.
 */
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

/**
 * W1-T2516: `<root>/state/account-usage-projection.json` — MUST resolve to the SAME relative
 * path as account-usage.ts's own `USAGE_PROJECTION_REL`. Duplicated here (not imported) for the
 * SAME reason `resolveActiveAccountId` above re-implements account-usage.ts's own file-reading
 * rather than importing it: account-usage.ts already depends on panel-actions.ts, which depends
 * on THIS file — an import here would close that into a cycle.
 * test/the-headroom-gate-reads-a-file-the-fleet-never-refreshes.test.ts asserts the two
 * literals stay equal, so they cannot drift apart silently.
 */
export const WORKER_USAGE_PROJECTION_REL = join("state", "account-usage-projection.json");

/**
 * W1-T2516: THE FIX. Every worker's HOME is redirected to a Remudero-controlled scratch dir
 * (worker-home.ts), so the `cachedUsageUtilization` a worker's OWN Claude Code invocation
 * refreshes lands inside `<workerHome>/.claude.json` — and `reapWorkerHome` (below, in
 * `spawnWorker`'s `finally`) deletes that whole directory moments later. Nothing in remudero
 * ever wrote the account-usage panel's PRIMARY source, `homedir()/.claude.json`, so on a
 * headless fleet host that file's `cachedUsageUtilization` never refreshes at all (see
 * account-usage.ts's module header for the full argument).
 *
 * Called from `spawnWorker`'s `finally`, BEFORE `reapWorkerHome` runs, so the read happens
 * while `<workerHome>/.claude.json` still exists. Reads ONLY the same six-field slice
 * account-usage.ts's own `readAccountUsageFile` projects `~/.claude.json` down to (this is a
 * private, minimal re-implementation of that projection for the SAME reason
 * `resolveActiveAccountId` above is one — no import path exists that avoids a cycle), then
 * persists a narrower cut of it — `accountUuid`/`fetchedAtMs`/the two usage windows,
 * DELIBERATELY NEVER `email`/`org`/anything OAuth-shaped — to
 * `<root>/state/account-usage-projection.json`. Written via a temp-file-then-`renameSync` swap
 * so a concurrent reader (the console's `GET /v1/account-usage`) can never observe a
 * half-written file.
 *
 * BEST-EFFORT AND SILENT, matching every other piece of this teardown: an absent/unreadable
 * `.claude.json` (a spawn that died before the CLI ever wrote one), a payload carrying no
 * usable `cachedUsageUtilization.fetchedAtMs`, or a write failure are all simply skipped —
 * never thrown, never blocking the teardown this runs inside of. Returns whether a projection
 * was actually written, so a test can assert on it directly rather than re-reading the file.
 */
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
  /**
   * W1-T2591: tool names this spawn is never offered, threaded to the SDK's own
   * `Options.disallowedTools`. NOT the settings `deny` list, deliberately: that floor is enforced
   * by a hook, and this repo's own {@link DenyFloorVerdict} exists because the block can LEAK
   * under `bypassPermissions` (claude-code#20946) and needs a `dontAsk` re-probe to catch it. A
   * disallowed tool is never presented to the model at all, so there is no check to race.
   *
   * The default is UNRESTRICTED — every existing caller spawns exactly as before. Only a lane
   * that has shown it needs no mutation passes this.
   */
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
      // W1-T2800: the Codex spawn now REQUIRES the redirected per-spawn worker home, threaded
      // explicitly rather than inferred from `process.env.HOME` or from `args.env` ordering. The
      // seam carries it so a test double is held to the same contract the real
      // `spawnCodexWorker` is — a fake that could omit it would be proving a spawn shape
      // production can no longer produce.
      args: SpawnWorkerArgs & { workerHome: string; zdotdir?: string },
      config: Config,
      selection?: Pick<ProviderCapacity, "model" | "effort">,
    ) => Promise<WorkerResult>;
    tieBreaker?: number;
    /** Best-effort durable projection for the console; never allowed to change spawn outcome. */
    writeStatus?: typeof writeProviderRoutingStatus;
    now?: () => number;
  };
  /**
   * Restrict the model's base built-in tool set (SDK `Options.tools`). Unset
   * ⇒ the SDK default (all Claude Code tools). Pass e.g. `["Bash"]` to make a
   * worker read-only BY CONSTRUCTION — Write/Edit/NotebookEdit/MultiEdit are
   * never in the model's context, so it cannot use one even if asked
   * (isolation.ts's preflight probe, W1-T17).
   */
  tools?: string[];
  /**
   * W1-T113: override the toolchain-resolution cache/seams — same injection
   * convention `config` above already follows. Omitted ⇒ the shared,
   * PER-PROCESS `claudeExecutableCache` and live fs/PATH/subprocess (the real
   * spawn path); tests can inject a fresh cache + fakes here instead of
   * reaching into the module-level singleton.
   */
  claudeExecutable?: { cache?: ClaudeExecutableCache; deps?: ResolveClaudeExecutableDeps };
  /**
   * W1-T113: override the darwin-only keychain-provisioning gate/seams —
   * same injection convention as `config`/`claudeExecutable` above. Omitted
   * ⇒ the real `process.platform` and `ensureWorkerKeychain`'s own live
   * `security(1)`/fs defaults. Tests inject `platform: "darwin"` plus a fake
   * `runner`/`exists` (matching `ensureWorkerKeychain`'s OWN existing
   * injectable seams, worker-home.ts) to exercise this gate deterministically
   * off a non-macOS CI runner, with no real keychain touched.
   */
  keychain?: {
    platform?: NodeJS.Platform;
    runner?: SecurityRunner;
    exists?: (path: string) => boolean;
    /**
     * recon-cloud-workers-spike stop 6: injectable reader for the NON-DARWIN credential file,
     * mirroring `runner`/`exists` above. Omitted (the production default) reads the real file
     * with `readFileSync` — and the suite drives that default against real fixture files, because
     * a test that only ever supplies its own reader proves nothing about the shipping path.
     */
    readCredentialFile?: (path: string) => string;
    /**
     * W1-T265: the active Anthropic account identity for THIS spawn — an
     * `accountUuid`/`emailAddress` NAME, never a secret — forwarded to
     * `ensureWorkerKeychain`'s `accountId` opt so an account switch under the
     * unlabelled default store re-provisions instead of silently spending the
     * stale copy. Omitted ⇒ resolved fresh, per spawn, by this file's own
     * `resolveActiveAccountId` (never from the keychain's own `acct` attribute —
     * account-usage.ts measured that to be the OS username, identical across an
     * account switch). Tests inject a fixed value here to exercise the gate
     * without touching the real `~/.claude.json`.
     */
    accountId?: string;
    /**
     * W1-T293 arm (3): set when the PRIOR spawn died on the containment preflight's
     * expiry-named reason (W1-T292's `spawn_credential_expired`, once that task wires
     * it through this call site) — forces `ensureWorkerKeychain` to re-provision even
     * when its own before-the-fact sidecar check (worker-home.ts's `expiryPath`) saw
     * nothing wrong. NOT YET WIRED to any containment token here (W1-T292 hasn't
     * shipped one to consume) — this is the hook a future caller sets; omitted ⇒
     * unchanged behavior, matching every other opt-in seam in this block.
     */
    priorSpawnCredentialExpired?: boolean;
    /**
     * W1-T2518: the dispatcher's own run-length estimate, forwarded VERBATIM to
     * `ensureWorkerKeychain`'s `expectedRunMs` (worker-home.ts) — the option W1-T2398 shipped
     * with ZERO callers (`git grep -n expectedRunMs origin/main -- src/` read 9 hits, all
     * inside worker-home.ts itself — the declaration, its docs, and its two use sites — and
     * none a caller). This is that first caller. Omitted ⇒ byte-identical behavior, matching
     * `expectedRunMs`'s own doc ("never derived in here") — this call site is where a real
     * estimate belongs, never invented inside worker-home.ts. Supplied, it widens the
     * effective expiry skew and, after `ensureWorkerKeychain`'s own re-provision attempt,
     * refuses the spawn (`WorkerKeychainError`, `credential-too-short-for-run`) before it
     * starts when even a freshly re-provisioned credential still can't outlast the run — see
     * that option's own doc for the full two-part contract. Appended LAST — no positional
     * caller shifts.
     */
    expectedRunMs?: number;
  };
  /**
   * W1-T117: attribution markers threaded into the child's env
   * (`REMUDERO_RUN_ID`/`REMUDERO_TASK_ID`) — inherited by every descendant
   * process the CLI spawns (env propagates downhill through `bash -c` by
   * default, the same propagation that let the armed `gh pr create` bomb
   * survive), consumed by the orphan sweep (worker-containment.ts's
   * `sweepOrphanWorkers`) to attribute a stray survivor back to the run/task
   * that spawned it. Optional: a caller that omits them still gets
   * process-group containment (teardown kills everything regardless), it
   * just cannot be RE-attributed by a later sweep if teardown itself never
   * ran (e.g. the daemon process was killed mid-run).
   */
  runId?: string;
  taskId?: string;
  /**
   * W1-T117 injectable seam: override the process-group spawn/teardown —
   * same injection convention as `config`/`claudeExecutable`/`keychain`
   * above. Omitted ⇒ the real `spawnDetachedGroup`/`teardownProcessGroup`
   * (worker-containment.ts). Tests inject fakes so containment wiring is
   * provable without a real `claude` binary.
   */
  containment?: {
    spawn?: (
      opts: ContainedSpawnOptions,
      onStderr?: (chunk: string) => void,
      onSpawnError?: (err: NodeJS.ErrnoException) => void,
    ) => ContainedProcess;
    teardown?: (pgid: number) => void;
  };
  /**
   * W1-T442: sink for a spawn's ASYNCHRONOUS 'error' event — the only place the
   * errno (ENOENT / EAGAIN / EMFILE / EACCES) ever appears, since the no-pid
   * throw unwinds before the event fires.
   *
   * A CALLBACK RATHER THAN A MUTABLE HOLDER THE CALLER READS AFTER CATCHING,
   * and the reason is a race, not taste: the event may not have fired when the
   * catch runs, so a holder is read too early exactly when the spawn failed
   * fastest. A callback fires WHEN THE ERROR DOES rather than when the caller
   * happens to look, which is correct regardless of ordering.
   *
   * It is wired HERE and destined for the ledger in `run-task.ts`, because
   * worker.ts cannot reach the ledger: `ledgerPathFor` lives in run-task.ts,
   * run-task.ts already imports this module, and re-spelling
   * `join(config.root, "state", "ledger.ndjson")` here would undo the
   * consolidation that function's own doc records. Omitted ⇒ the error is
   * swallowed exactly as it was before this existed.
   */
  onSpawnError?: (err: NodeJS.ErrnoException) => void;
  /**
   * W1-T117 injectable seam: override the SDK's own `query()` entry point —
   * same injection convention as every other seam above. Omitted ⇒ the real
   * SDK `query` (a live `claude` subprocess). Tests inject a fake async
   * iterable so spawnWorker's OWN process-group-teardown wiring (the code
   * AFTER this call — see the `withWorkerGroupTeardown` call at the bottom
   * of this function) is exercised end-to-end, on both the success and the
   * thrown-error verdict path, with no real claude binary involved.
   */
  queryFn?: typeof query;
  /**
   * W1-T942 (design note i): forwarded VERBATIM to {@link collectWorkerResult}'s own
   * `streamObserver` — the ONE seam that turns the SDK message stream this call already
   * consumes into per-message `working`/`tool-executing`/heartbeat events. Omitted (every
   * caller before this task) ⇒ byte-identical behavior. run-task.ts wires the REAL observer
   * here at its spawn call sites — see `buildWorkerStateSensor` — so `worker.state` is
   * produced by live runs, never only by a test (Standing rule 14).
   */
  streamObserver?: WorkerStreamObserver;
  /**
   * W1-T1045: THE CLOCK BOUND. Omitted (every caller before this task) ⇒ byte-identical
   * behavior — no `AbortController` is ever constructed and `options.abortController` stays
   * unset. When set, a watchdog ({@link createWorkerClockBoundWatchdog}) aborts THIS call's own
   * SDK query the moment `boundMs` elapses since the last observed stream activity (never on
   * total run age — see that function's own doc), and `spawnWorker` throws {@link
   * WorkerAbandonedError} carrying the evidence instead of whatever the SDK's iterator threw on
   * abort. run-task.ts wires the REAL bound here (`policy.values.workerAbandon`) at its own
   * dispatch-spawn wrapper, never at this call site directly (Standing rule 14: the real
   * observer/bound is wired at the real spawn path, not merely available) — the advisory
   * reviewer's and the architect's own direct `spawnWorker` calls omit it and are unaffected.
   */
  clockBound?: { boundMs: number; now?: () => number; pollMs?: number };
  /**
   * W1-T2441: observe the per-spawn worker-home reap this call's teardown already runs
   * (`reapWorkerHome`, worker-home.ts). That call ALREADY COMPUTES a {@link WorkerHomeReapResult}
   * naming the target it removed (or didn't) and why, on every arm (`guard-rejected`, `absent`,
   * reaped-true, a caught error) — it was previously discarded in statement position at the
   * `finally` call site below (`grep -acE "=\s*reapWorkerHome\(" src/lib/worker.ts` read 0 before
   * this task). Called on EVERY exit path, including a thrown error, exactly like the reap
   * itself, and NEVER allowed to throw — see the call site's own try/catch. Omitted ⇒ the default
   * ({@link workerHomeReapLogFields} to `console.error`, one JSON line — the same best-effort
   * exit-path diagnostic-output discipline this file's `assertWorktreeBaseCurrent`'s `warn`
   * already uses).
   *
   * INSTRUMENTATION ONLY, AS OF W1-T2441 (that task's own constraint at the time): this option
   * itself does not change WHAT is reaped or WHEN — it only surfaces the already-computed
   * {@link WorkerHomeReapResult}. W1-T2441's own no-remedy premise — "the home is still keyed on
   * `runId`, so every fix spawn inside one daemon run still shares one" — held at filing but no
   * longer holds at this call site: W1-T2463 shipped the remedy below (`perRunWorkerHomeDir(...,
   * { perSpawn: true })`), so a still-running sibling can no longer lose its home out from under
   * it the moment another sibling exits. This option's own contract (observe, never decide) is
   * unaffected by that — it still just makes whatever `reapWorkerHome` computed observable.
   */
  logHomeReap?: (result: WorkerHomeReapResult, spawn: { runId?: string; taskId?: string }) => void;
  /**
   * W1-T2518: sink for the darwin keychain rung's {@link WorkerKeychainSummary}, observed at
   * THIS call site on EVERY darwin provisioning call — `keychain.expectedRunMs` supplied or
   * not — so the rate `observedHeadroomMs` (worker-home.ts:1080) actually gets exercised
   * becomes answerable off-host purely by reading this line, exactly as that field's own doc
   * anticipates. Never called on the non-darwin path: `assertWorkerCredentialFile` returns no
   * summary carrying this field at all. Omitted ⇒ {@link defaultLogKeychainHeadroom}, one JSON
   * line to stderr — the same best-effort diagnostic-output discipline `logHomeReap` above
   * already uses.
   */
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
}

export function clearClaudeCapacityCache(): void {
  claudeCapacityCache = undefined;
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
      const value = claudeCapacityFromUsage(usageSnapshotFromSdk(await method.call(session) as never));
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

/**
 * Worker checkouts carry the repository-owned capability policy. `config.root` is the daemon
 * state root on the Azure fleet (`/home/node/Remudero`), not the repository root, so resolving
 * from it silently misses `.remudero/mounts.yaml`. Task workers use their checkout `cwd`; early
 * isolation probes use a scratch cwd before that worktree exists, so they fall back to the
 * module's installed repository root. Neither path guesses from the state-root directory.
 */
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
    // A synthetic Claude query is the established paid-spawn test seam. Keep older worker tests
    // network-free unless they explicitly inject health evidence; the resolver itself still runs.
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
    // Attribution telemetry is best-effort: an unreadable boundary omits consumption rather than
    // blocking an otherwise available subscription worker before its model call begins.
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

/**
 * Spawn one headless Claude Code worker via the Agent SDK, or an opted-in Codex worker.
 *
 * Uses the installed SDK's isolation options as ground truth (SDK 0.3.209):
 *  - `pathToClaudeCodeExecutable` → resolved FRESH at spawn time (W1-T113: env
 *    override → live PATH → the install-location table), never `config.claudeBin`'s
 *    disk-cached value directly and never bare PATH inheritance either.
 *  - `env` → REPLACES the subprocess env entirely (per the SDK contract), so the
 *    allowlisted, ANTHROPIC-stripped env from buildWorkerEnv() is the billing
 *    boundary. No wholesale process.env inheritance.
 *  - `settings` → the worker settings file (permissions + hooks).
 *  - `settingSources: []` → SDK isolation mode; never loads ~/.claude/settings.json.
 *  - `sandbox` → parsed from the settings file and passed as the validated SDK
 *    option, so a malformed sandbox block fails loud instead of the CLI silently
 *    dropping an invalid settings file and running unsandboxed.
 *  - `env.home` → a worker-home dir UNIQUE to this call (W1-T170: `perRunWorkerHomeDir`,
 *    preferring `args.runId` when supplied, plus a W1-T2463 per-spawn token so two spawns
 *    SHARING one `runId` still get distinct homes), materialized fresh and reaped in a
 *    `finally` regardless of outcome — the pre-W1-T170 singleton `<root>/worker-home`
 *    does not survive two overlapping spawns (WS-2).
 */
export async function spawnWorker(args: SpawnWorkerArgs): Promise<WorkerResult> {
  // Validate-before-spawn guard (WS-0 FF10a) enforced at the spawn boundary, not
  // by caller convention: `claude -p` SILENTLY IGNORES an invalid settings file
  // and drops containment, so the settings file is validated against the pinned
  // SandboxSettingsSchema before ANY worker is spawned. Throws WorkerSettingsError
  // on the first bad/misplaced key — no unsandboxed worker is ever launched.
  validateWorkerSettingsFile(args.settingsFile);

  // Capture process-global HOME before the first await. Test harnesses and embedders may vary it
  // between concurrent calls; one worker's advisory status read must not switch another's home.
  const realHome = process.env.HOME ?? homedir();
  const config = args.config ?? loadConfig();
  // W1-T2800: HOISTED ABOVE PROVIDER SELECTION so the Codex branch below cannot return past the
  // HOME redirection the Claude path has had since W1-T18. Previously this sequence lived after
  // the `selection.provider === "codex"` early return, so `codexSpawnEnv` fell back to
  // `process.env.HOME` — the OPERATOR'S REAL HOME — and a worker shell sourcing an rc file from
  // it re-exported ANTHROPIC_API_KEY past both of Codex's process-boundary exclusions. Computing
  // the path here is inert (no disk write); each provider branch materializes and reaps it.
  // `{ perSpawn: true }` is preserved verbatim (W1-T170, W1-T2463): two spawns sharing a runId
  // still get distinct homes.
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
        capacities: capacities.map((capacity) => ({
          provider: capacity.provider,
          readable: capacity.readable,
          ...(capacity.model ? { model: capacity.model, effort: capacity.effort } : {}),
          windows: capacity.windows.map((window) => ({ name: window.name, used_percent: window.usedPercent })),
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
        // W1-T2800: MATERIALIZE the redirected home before the spawn — the SAME function the Claude
        // path calls (never a second materializer), which writes the blank rc files
        // (`WORKER_HOME_RC_FILES`) that close the leak. MEASURED against pinned codex-cli 0.152.0:
        // both Codex exclusions hold at the process boundary (zero ANTHROPIC keys in the child's
        // `/proc/self/environ`) while the worker's SHELL still read the operator's exported value
        // from `$HOME/.bashrc`. A blank rc in a redirected HOME is the only boundary that stops it.
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
        // W1-T2800: reap THIS spawn's per-spawn home on every exit path INCLUDING error — the
        // same guarantee (and the same `reapWorkerHome` call) the Claude path's own `finally`
        // below has carried since W1-T170. Best-effort and guarded; never touches the root.
        reapWorkerHome(workerHomeRoot, workerHome);
      }
    }
    routedClaudeSelection = selection;
  }
  // W1-T113 PREFLIGHT: resolve the real binary FRESH (see resolveClaudeExecutable's
  // doc, above) before any worker-home/keychain work runs. Throws
  // ClaudeToolchainBlockedError — never a raw ENOENT — naming every searched
  // path, carrying `reasonClass: "blocked_toolchain"` (the W1-T91 infrastructure
  // classification, never a task defect) for a caller to classify duck-typed —
  // see daemon.ts's `isSpawnInfraBlocked`, which does exactly that.
  const claudeBin = resolveClaudeExecutable(args.claudeExecutable?.cache ?? claudeExecutableCache, args.claudeExecutable?.deps);
  // W1-T18 general isolation mechanism: redirect HOME to a Remudero-controlled
  // scratch dir holding ONLY empty rc files (never the operator's real HOME),
  // with the few paths a worker legitimately needs symlinked back in. Best-
  // effort/idempotent — safe to call before every spawn. See worker-home.ts.
  //
  // W1-T170: the singleton root does NOT survive concurrency (WS-2) — two
  // overlapping spawns truncating/symlinking the SAME rc files and keychain
  // slot race each other. So EVERY spawn gets its OWN home, a sibling of the
  // root (`perRunWorkerHomeDir`), never the shared root itself; reaped below
  // on every exit path (including error) once this spawn is done with it.
  // W1-T2463: opt IN to a per-spawn uniqueness token appended after args.runId (see
  // perRunWorkerHomeDir's own doc, worker-home.ts). Every fix spawn inside one daemon run
  // previously resolved to the SAME `worker-home-<runId>` (keyed on runId alone), so one
  // spawn's teardown (reapWorkerHome, in the `finally` below) tore the directory out from
  // under a still-live sibling — the ENOTEMPTY collision this task fixes. runId stays the
  // FIRST component of the path (workerMarkerEnv below still writes the bare args.runId,
  // untouched), so reclamation is unaffected; only THIS call site opts in — the OTHER
  // caller in src/ (run-task.ts's readUsageSnapshot, "usage-probe") does not, so its
  // stable, non-per-call home is unchanged.
  // W1-T2800: both are resolved ONCE, above provider selection — see that hoist's own comment.
  try {
    // W1-T235 (WS-7 keychain-unlock gate, macOS only): guarantee the DEDICATED
    // always-unlocked worker keychain before any spawn, and point the redirected
    // HOME's keychain slot at it — a LOCKED login keychain can no longer kill the
    // spawn "Not logged in" at $0. A credential problem throws WorkerKeychainError
    // HERE, pre-spawn, with a named reason class — never a $0 worker whose
    // zero-write death reads as "containment UNPROVEN" (the 2026-07-21 incident).
    let workerKeychainPath: string | undefined;
    const platform = args.keychain?.platform ?? process.platform;
    // W1-T265/W1-T268: resolve fresh, per spawn, regardless of platform — never
    // captured once at boot, matching account-usage.ts's own "identity is read
    // fresh" doctrine (that module is the reason this reads accountUuid/
    // emailAddress here rather than the keychain's own `acct` attribute, which it
    // measured to be the OS username and therefore not a discriminator across an
    // Anthropic account switch). Computed unconditionally (not just under the
    // darwin keychain gate below) so every WorkerResult — on any platform — can
    // carry the account its spend is attributed to (W1-T268's ledger dimension).
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
        // W1-T2518: this call's FIRST forwarding of expectedRunMs — see the option's own doc
        // on `SpawnWorkerArgs.keychain`, above, and `expectedRunMs`'s doc in worker-home.ts for
        // the full contract (widen-then-refuse) this now actually exercises.
        expectedRunMs: args.keychain?.expectedRunMs,
      });
      // W1-T2518: surfaced on EVERY darwin call, regardless of whether this refused (a throw
      // above skips this line entirely — nothing to log, the error message itself names the
      // headroom and the estimate) or returned a summary to spawn on.
      (args.logKeychainHeadroom ?? defaultLogKeychainHeadroom)(keychainSummary, args.keychain?.expectedRunMs, {
        runId: args.runId,
        taskId: args.taskId,
      });
      workerKeychainPath = keychainSummary.keychainPath;
    } else {
      // recon-cloud-workers-spike stop 6: the SAME refusal contract, one rung later in the
      // taxonomy and one platform over. The darwin branch above is untouched — this is an
      // `else`, so nothing in production behaviour moves.
      //
      // WHY IT IS WORTH A RUNG AT ALL, since a credential-dead worker is already caught: the
      // containment probe (`probeContainment`) catches it on every platform, but by SPAWNING
      // and reading the death. Here the same fact costs one file read, before anything runs.
      // `assertWorkerCredentialFile` throws `WorkerKeychainError` with a named reason class,
      // exactly as the keychain rung does, so the failure stays queryable rather than prose.
      //
      // It refuses only what is unambiguously unusable — absent, unreadable, malformed, or
      // carrying no Claude credential at all. An EXPIRED token is reported and allowed through:
      // there is nothing to re-provision from on this platform, the CLI maintains its own
      // refresh, and refusing there would be a bound firing on a healthy condition. See
      // worker-home.ts's note above `workerCredentialFilePath` for the full argument.
      assertWorkerCredentialFile(workerCredentialFilePath(realHome), args.keychain?.readCredentialFile);
    }
    // W1-T417-adjacent: a grant that FAILED is not a grant that was OPTIONAL. The absent-target
    // skip stays silent (several are legitimately unavailable), but a target that EXISTS and could
    // not be reached is a LOST CAPABILITY the worker then runs without — exactly how a real
    // `.claude` DIRECTORY in the symlink slot left the usage probe running LOGGED OUT for days
    // with nothing on disk saying so. Carried on the RESULT rather than logged here: this module
    // writes no ledger rows by design, and `workerLedgerFields` already projects the result onto
    // the verdict row every caller writes.
    const lostGrants = lostWorkerHomeGrants(
      materializeWorkerHome({ workerHome, realHome, workerKeychainPath }),
    );

    // Shell isolation (resolved from config, never hardcoded) so a worker sources
    // no operator rc: HOME is redirected (above) so CLAUDE_CODE_SHELL's Bash-tool
    // snapshot (which sources `$HOME/.bashrc`) resolves to the redirected scratch
    // HOME's empty rc, never the operator's — isolation independent of whatever
    // the operator's real dotfiles contain. ZDOTDIR covers any direct zsh (W1-T1C
    // compinit contamination).
    const childEnv = buildWorkerEnv(args.env ?? {}, process.env, {
      zdotdir: workerZdotdir(config),
      shell: workerShell(config),
      home: workerHome,
      // Overflow valve (§9, W1-T258): pass the operator's ANTHROPIC_API_KEY through
      // to bill on API credits ONLY when config.overflow === "api_key" — which
      // validateConfig refuses without a paired dailyCapUsd, so an uncapped api run
      // can never even be configured. Absent that, ANTHROPIC_* is stripped as before.
      allowApiKey: config.overflow === "api_key",
    });
    // W1-T117: attribution markers merged in AFTER the allowlist/extras above —
    // authoritative regardless of whatever `args.env` happens to contain (no
    // caller has a legitimate reason to set REMUDERO_RUN_ID/TASK_ID/SCOPE itself).
    Object.assign(childEnv, workerMarkerEnv(args.runId, args.taskId, workerInstallationScope(config.root)));

    const stderrChunks: string[] = [];
    const blocks: string[] = [];

    // W1-T117: worker process-tree containment. `pidRef` is populated by the
    // spawnClaudeCodeProcess closure below the first time the SDK actually
    // spawns (lazily, on the returned async iterable's first pull);
    // withWorkerGroupTeardown guarantees `teardownFn` runs against it on EITHER
    // path once the message stream settles — normal return (any result
    // subtype, including error_max_turns/error_max_budget_usd) or a thrown
    // transport failure — never leaving a run's process group alive past its
    // own teardown. See worker-containment.ts's file header for the verified
    // SDK spawn-surface ground truth (`Options.spawnClaudeCodeProcess`) this
    // relies on, including why it ALSO owns stderr piping here (a custom spawn
    // gets no stderr wiring from the SDK itself).
    const pidRef: { pid?: number } = {};
    const spawnContained = args.containment?.spawn ?? spawnDetachedGroup;
    const teardownContained = args.containment?.teardown ?? ((pgid: number) => void teardownProcessGroup(pgid));

    // NOTE (SDK 0.3.209 ground truth): passing BOTH a `settings` file path and the
    // `sandbox` option throws "Cannot use both …". The sandbox config therefore
    // lives inside the settings file; the probe (verdict 7) empirically confirms
    // it actually engaged rather than being silently dropped.
    const options: Options = {
      cwd: args.cwd,
      permissionMode: args.permissionMode,
      pathToClaudeCodeExecutable: claudeBin,
      env: childEnv,
      settings: args.settingsFile,
      settingSources: [],
      // W1-T117: run the CLI DETACHED into its own process group/session
      // (setsid-equivalent) so teardown can reach every descendant — including
      // one that outlives the CLI's own exit — with a single group signal.
      // This REPLACES the SDK's default local spawn, so `stderrChunks` is fed
      // from THIS closure (via buildContainedSpawnFn's onStderr sink), not
      // from an `Options.stderr` callback here — the SDK never invokes one for
      // a custom spawn (see the file-header note in worker-containment.ts).
      spawnClaudeCodeProcess: buildContainedSpawnFn(
        spawnContained,
        (chunk) => stderrChunks.push(chunk),
        pidRef,
        args.onSpawnError,
      ),
    };
    // W1-T2591: omitted entirely when unset, so an unrestricted spawn's option object is
    // byte-identical to what it was — never `disallowedTools: undefined`, which would be a
    // different object for the SDK to interpret.
    if (args.disallowedTools && args.disallowedTools.length > 0) options.disallowedTools = [...args.disallowedTools];
    if (args.resumeSessionId) options.resume = args.resumeSessionId;
    const routedClaudeModel = claudeHealthRoute?.routedModel ?? args.model;
    if (args.model) options.model = args.model;
    if (routedClaudeModel && routedClaudeModel !== args.model) options.model = routedClaudeModel;
    if (args.effort) options.effort = args.effort as Options["effort"];
    if (typeof args.maxTurns === "number") options.maxTurns = args.maxTurns;
    if (typeof args.maxBudgetUsd === "number") options.maxBudgetUsd = args.maxBudgetUsd;
    if (args.tools) options.tools = args.tools;

    // impl-EM LIVE-SPAWN GUARD — the final authority gate before the optional attribution boundary
    // and the SDK invocation; only the SDK call creates the paid worker. Everything above this line is local and free (config load, binary
    // resolve, worker-home materialisation, keychain unlock, env construction) and pushes nothing,
    // reaches no network and spends nothing — verified over the whole range. Those steps ALSO refuse
    // on their own for bad input (an invalid settings file, an absent toolchain, a locked keychain),
    // and those refusals are safety features with their own tests; guarding above them would mask
    // three of them and make this guard the reason they stopped being exercised.
    //
    // Scoped to a REAL spawn: `args.queryFn` is the W1-T117 seam replacing the SDK's own `query()`, so
    // a test injecting it creates no process and is not what this refuses. What it stops is the shape
    // that actually cost money — a test reaching the real SDK through an un-stubbed dep or an
    // `as never` cast, which is how test/mounts-wiring.test.ts once spent $1.42+ and left six ghost
    // branches behind. The multi-provider capacity read below is control-plane telemetry, not a
    // model spawn, and catches its own failure without weakening this guard.
    if (args.queryFn === undefined) {
      assertLiveSpawnAllowed(`spawnWorker for task ${args.taskId ?? "<no taskId>"}`);
    }
    const runQuery = args.queryFn ?? query;

    // W1-T1045: THE CLOCK BOUND — constructed here, still local/free (no timer is armed and no
    // `AbortController` even exists below this point unless `args.clockBound` is set). See
    // SpawnWorkerArgs.clockBound's own doc; omitted ⇒ `abandonment`/`stopWatchdog` stay
    // unpopulated and every line below behaves exactly as it did before this task.
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
      // Armed immediately before the query itself runs — see impl-EM's own guard, above.
      stopWatchdog = watchdog.start((evidence) => {
        abandonment = evidence;
        controller.abort();
      });
    }

    // Multi-provider installs take fresh, reset-aware boundaries only after every local Claude
    // preflight has cleared. Claude-only installs preserve the existing zero-extra-read path.
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
            // Logged verbatim as CONFIGURED inputs — never a read-back (effort is not
            // in the SDK envelope at all; model here is the requested knob, which may
            // differ from the envelope's `modelUsage` map keys for the model(s) actually
            // billed). Unset ⇒ the honest "default" label, never a guessed value.
            model: args.model ?? DEFAULT_MODEL_LABEL,
            effort: args.effort ?? DEFAULT_EFFORT_LABEL,
            accountLabel: accountId,
            // W1-T303: mirrored verbatim from the SAME `options.maxTurns` this call was
            // spawned with — see {@link WorkerResult.maxTurns}. `undefined` when the
            // caller configured no cap, never a guessed value.
            maxTurns: args.maxTurns,
            lostGrants,
            // W1-T2245: see {@link WorkerResult.compactionConfigured}'s own doc — read off THIS
            // spawn's `options` via `in`/index access (never a property access `Options`'s type
            // does not declare), never written here. `options` never sets this key today, so this
            // is `false` on every real spawn; it exists so the ledger row says so explicitly
            // instead of a reader having to re-derive it from source.
            compactionConfigured: (options as Record<string, unknown>).autoCompactEnabled === true,
            // W1-T942: forwarded verbatim (wrapped with the watchdog's own observer above when a
            // clock bound is configured) — see SpawnWorkerArgs.streamObserver's doc.
            streamObserver,
            // W1-T1045: the SAME injected clock the watchdog itself polls against (when one was
            // supplied) — every `WorkerStreamEvent.tsMs` this call's observer sees must come from
            // ONE clock, never a real `Date.now()` racing a synthetic test clock the watchdog was
            // given. `undefined` (⇒ collectWorkerResult's own `Date.now` default) when no clock
            // bound is configured at all, byte-identical to before this task.
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
      // W1-T1045: runs on EVERY thrown error, but only REPLACES it when the watchdog itself
      // tripped (`abandonment` populated) — any other transport failure passes through
      // unchanged, exactly as before this task. Replacing rather than adding a second reject
      // means run-task.ts checks ONE type (`instanceof WorkerAbandonedError`) rather than
      // re-deriving "was this OUR abort" from the SDK's own thrown error shape, which is not a
      // documented contract.
      if (abandonment) throw new WorkerAbandonedError(abandonment, err);
      throw err;
    } finally {
      stopWatchdog?.();
    }
  } finally {
    // W1-T170: reap THIS spawn's per-spawn home on every exit path, including a
    // thrown error (validate/toolchain/keychain failures above, or a transport
    // failure out of withWorkerGroupTeardown) — the same withTempDir discipline
    // (W1-T115/W1-T131) applied to a resource that must not accumulate across
    // concurrent or serial spawns. Guarded (never touches the singleton root or
    // anything outside its own sibling) and best-effort — see worker-home.ts.
    //
    // W1-T2441: `reapWorkerHome` ALREADY COMPUTES which target it removed (or didn't) and
    // why, on every arm — previously discarded here in statement position (nothing ever
    // assigned its return value). Surfaced now via `logHomeReap` — the reap call itself
    // (still best-effort, still never throws, still unconditional in this `finally`) is
    // untouched by that instrumentation. W1-T2463: `workerHome` above is now this spawn's OWN
    // per-spawn sibling (`perRunWorkerHomeDir(..., { perSpawn: true })`), not a home shared
    // with every other spawn in the run, so this unconditional `rmSync` no longer tears down
    // a still-live sibling's home out from under it.
    // W1-T2516: capture the usage cache OUT of this spawn's own worker home BEFORE the reap
    // immediately below deletes it — see captureWorkerUsageProjection's own doc for why this is
    // the only place in the codebase this reading is still reachable at all. Best-effort and
    // silent by construction, exactly like the reap it precedes; never gates or delays it.
    captureWorkerUsageProjection(config.root, workerHome);
    // The logger is wrapped so a caller-supplied `logHomeReap` can never turn this
    // previously-bulletproof teardown into a new failure mode.
    const homeReapResult = reapWorkerHome(workerHomeRoot, workerHome);
    try {
      (args.logHomeReap ?? defaultLogHomeReap)(homeReapResult, { runId: args.runId, taskId: args.taskId });
    } catch {
      // best-effort observability only — a logger failure must never surface as a failed teardown
    }
  }
}

/**
 * Reduce the SDK message stream into a {@link WorkerResult}. Extracted from
 * spawnWorker so the error-envelope behavior is unit-testable without spawning
 * a real worker.
 *
 * CRITICAL (SDK 0.3.209 ground truth, WS-1 root cause): the SDK still YIELDS the
 * `type:"result"` envelope for an error subtype (error_max_turns,
 * error_max_budget_usd, …) — carrying `num_turns` and `total_cost_usd` — and
 * only THEN throws `Error("Claude Code returned an error result: …")` from the
 * iterator. If that throw escapes, the run's cost + turns are lost and a failed
 * run looks FREE in the ledger. So: once a result envelope is seen, the trailing
 * throw is swallowed and the captured envelope is returned with isError=true. A
 * throw with NO result envelope is a genuine transport/spawn failure — re-raised.
 */
/**
 * The SDK session type a usage probe needs — narrowed to the control request and teardown, so
 * neither this module nor its callers depend on the experimental method's full shape.
 */
export interface UsageProbeSession {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
  return?: (v?: unknown) => Promise<unknown>;
}

/** The injectable seam a test passes so no test ever reaches the real SDK — the same shape and
 *  the same purpose as {@link SpawnWorkerArgs.queryFn}. */
export type UsageProbeQueryFn = (params: { prompt: AsyncIterable<never> }) => UsageProbeSession;

/** A prompt that yields NOTHING. The control request is answered on session setup, so no user
 *  message is ever produced: no prompt sent, no turn spent, no tokens billed. */
async function* emptyUsagePrompt(): AsyncIterable<never> {}

/**
 * OPEN A CONTROL-ONLY SDK SESSION FOR THE USAGE PROBE — and it lives HERE, in the spawn
 * chokepoint, deliberately.
 *
 * `test/spawn-guard.test.ts` pins that EXACTLY ONE file imports the SDK's runtime `query`, and
 * that that file calls {@link assertLiveSpawnAllowed} before reaching it: "If a second file now
 * spawns workers, guard it too rather than widening this list." Putting the probe's session here
 * keeps both halves true — one importer, one guard — instead of widening a stated invariant for a
 * session that, while it spawns no worker, still opens a real SDK connection and so deserves the
 * same treatment.
 *
 * STREAMING INPUT IS REQUIRED, NOT PREFERRED. The usage control request is declared inside
 * `Query`'s control-request block, documented "only supported when streaming input/output is
 * used", so this passes an async generator rather than the string `spawnWorker` uses. Converting
 * `spawnWorker` itself to streaming input is a separate decision and is NOT made here.
 */
export function openUsageProbeSession(runQuery?: UsageProbeQueryFn): UsageProbeSession {
  // Guarded on the same condition spawnWorker uses: only a REAL session is refused under a test
  // runner. An injected `runQuery` creates no connection and is not what this stops.
  if (runQuery === undefined) assertLiveSpawnAllowed("openUsageProbeSession (SDK usage probe)");
  const q = runQuery ?? ((p: { prompt: AsyncIterable<never> }) => query(p as never) as unknown as UsageProbeSession);
  return q({ prompt: emptyUsagePrompt() });
}

/**
 * The 3-value worker activity vocabulary (W1-T942 design note ii) — and no more. A fourth
 * value invented here would have to be re-rendered by every consumer (W1-T943's stall
 * detector, W1-T944's NOW card, W1-T945's `rmd peek`) and re-judged by the first of those, so
 * the vocabulary is pinned at exactly these three:
 *  - `working`        — assistant TEXT is arriving.
 *  - `tool-executing`  — a `tool_use` content block has been seen with no subsequent message yet.
 *  - `quiet`           — no message of ANY kind has arrived for longer than the quiet floor.
 *
 * DELIBERATELY NOT A LEDGERED VALUE ON ITS OWN: a run with no `worker.state` row yet is
 * `UNKNOWN`, never defaulted to `working` (the W1-T130 cannot-observe polarity) — see
 * {@link WorkerStateTracker.currentState}'s doc for how that is represented (`undefined`,
 * never a 4th string).
 */
export type WorkerState = "working" | "tool-executing" | "quiet";

/**
 * One classified SDK stream event, as {@link collectWorkerResult}'s `streamObserver` sees it.
 * `"working"`/`"tool-executing"` map 1:1 onto {@link WorkerState}; `"message"` covers every
 * OTHER message the stream yields (a `system` event, the terminal `result` envelope, or an
 * `assistant` message whose content carries neither a text nor a `tool_use` block) — a
 * heartbeat that proves the worker is still alive without asserting either named state, so it
 * still resets the quiet clock a {@link WorkerStateTracker} tracks.
 */
export interface WorkerStreamEvent {
  kind: "working" | "tool-executing" | "message";
  /** The injected clock's reading at the moment this event was observed — never `Date.now()`
   *  read a second time downstream, so a test drives the whole sequence off one synthetic clock. */
  tsMs: number;
  /**
   * The live-tail-worthy text this event carries — the assistant's own text for `"working"`,
   * a short `[tool_use: <name>]` label for `"tool-executing"`, and ABSENT for `"message"` (a
   * system/result envelope carries no worker-authored output worth tailing — see W1-T942
   * design note iv, "the worker's recent output").
   */
  text?: string;
  /**
   * W1-T2557: the cumulative count of raw `assistant`-type SDK messages {@link
   * collectWorkerResult} has seen SO FAR this spawn, as of this event — one increment per raw
   * assistant message, regardless of how many text/tool_use blocks it carries (so a message
   * with both fires two `WorkerStreamEvent`s that report the SAME `turnsSoFar`, never double
   * counted). Present on every event kind, including `"message"` heartbeats, so a reader never
   * has to guess a stale value forward across a heartbeat-only stretch.
   *
   * DELIBERATELY NAMED `turnsSoFar`, NOT `numTurns`: {@link WorkerResult.numTurns}'s own doc
   * (W1-T303 ground truth) already established that the SDK's terminal `num_turns` does not
   * reliably count "one turn = one user message + one assistant response" — an independently
   * counted mid-flight approximation must not borrow that name and imply it is the same figure.
   * This is the HONEST count available while the spawn is still in flight, never asserted to
   * equal whatever `num_turns` lands on the terminal envelope.
   */
  turnsSoFar?: number;
}

/** Callback shape {@link collectWorkerResult}'s optional `streamObserver` accepts — see
 *  {@link SpawnWorkerArgs.streamObserver} for the injection seam `spawnWorker` forwards this
 *  through, and run-task.ts's `buildWorkerStateSensor` for the real (ledger + tail) consumer. */
export type WorkerStreamObserver = (event: WorkerStreamEvent) => void;

/**
 * Default quiet floor (W1-T942 design note ii): how long with NO message of any kind before a
 * run reads `quiet`. Deliberately short — this is a raw ACTIVITY sensor ("has this worker said
 * anything lately"), not a stall alarm (W1-T943's own, much longer, threshold): the two must
 * stay decoupled or a slow-but-healthy tool call would misreport as the stall detector's own
 * escalation-worthy condition before that detector even exists.
 */
export const DEFAULT_WORKER_QUIET_FLOOR_MS = 30_000;

/**
 * FOLD a stream of {@link WorkerStreamEvent}s (plus periodic quiet-floor checks) into the
 * 3-value {@link WorkerState}, reporting only the TRANSITIONS — never one result per message
 * (W1-T942 design note iii: a per-message ledger row would multiply ledger volume by the turn
 * count and slow every reader in the repo).
 *
 * PURE: no fs, no ledger, no clock of its own — every timestamp is supplied by the caller (the
 * SAME injected clock `collectWorkerResult` uses, or a test's synthetic one), so this is
 * unit-testable against a synthetic event sequence with zero real time elapsed and no SDK
 * stream at all. `worker.ts` still cannot reach the ledger (see this file's own header comment
 * on `onSpawnError`) — appending the `worker.state` row is run-task.ts's job
 * (`buildWorkerStateSensor`), consuming this tracker's return values.
 */
export class WorkerStateTracker {
  private state: WorkerState | undefined; // undefined ⇒ nothing observed yet: UNKNOWN, never a row
  private lastActivityMs: number | undefined;
  // W1-T2557: 0 until the first event carrying `turnsSoFar` arrives — a real spawn's first
  // observed event always carries one (collectWorkerResult populates it on every call), so this
  // default is exercised only by a hand-built test event that omits the field on purpose.
  private turnsSoFarValue = 0;

  constructor(private readonly quietFloorMs: number = DEFAULT_WORKER_QUIET_FLOOR_MS) {}

  /**
   * Fold one observed message-stream event. Returns the NEW {@link WorkerState} iff this event
   * caused a transition (the caller ledgers it); `undefined` when the state is unchanged — a
   * `"message"` heartbeat NEVER itself asserts `working`/`tool-executing` (it only resets the
   * clock {@link check} reads), so it never returns a transition on its own.
   */
  observe(event: WorkerStreamEvent): WorkerState | undefined {
    this.lastActivityMs = event.tsMs;
    // W1-T2557: the running turn count updates off EVERY event kind (a heartbeat carries the
    // latest known count too), independent of whether this event is itself a state transition —
    // see {@link turnsSoFar}'s own doc for why this is tracked here rather than folded into
    // `state`.
    if (event.turnsSoFar !== undefined) this.turnsSoFarValue = event.turnsSoFar;
    if (event.kind === "message") return undefined;
    return this.transitionTo(event.kind, event.tsMs);
  }

  /**
   * W1-T2557: the running count of assistant-message "turns" observed so far THIS spawn — see
   * {@link WorkerStreamEvent.turnsSoFar}'s own doc for the counting unit and why it is not
   * asserted to equal the terminal envelope's `num_turns`. THE MID-FLIGHT VISIBILITY THIS TASK
   * ADDS: unlike {@link currentState}, which only changes on a working/quiet/tool-executing
   * TRANSITION (and can go a whole run without firing again for a continuously-`working`
   * worker), this updates on every single observed event — the running spend signal a caller
   * (run-task.ts's `buildWorkerStateSensor`) can ledger WHILE the spawn is still in flight.
   */
  turnsSoFar(): number {
    return this.turnsSoFarValue;
  }

  /**
   * Call periodically (a live caller polls this on an interval WHILE a spawn is in flight —
   * see run-task.ts's `buildWorkerStateSensor`) with the current clock reading. Transitions to
   * `quiet` iff MORE than `quietFloorMs` has elapsed since the last observed event of ANY kind
   * (design note ii: "no message of any kind for longer than the quiet floor"). A no-op
   * (returns `undefined`) before any event has ever been observed (UNKNOWN, never `quiet` by
   * default) or while already `quiet` (no repeat transition).
   */
  check(nowMs: number): WorkerState | undefined {
    if (this.lastActivityMs === undefined) return undefined;
    if (this.state === "quiet") return undefined;
    if (nowMs - this.lastActivityMs > this.quietFloorMs) return this.transitionTo("quiet", nowMs);
    return undefined;
  }

  /** Current state, or `undefined` iff nothing has ever been observed — UNKNOWN, never
   *  defaulted to `working` (the W1-T130 cannot-observe polarity this task's own acceptance
   *  criteria name). */
  currentState(): WorkerState | undefined {
    return this.state;
  }

  private transitionTo(next: WorkerState, _atMs: number): WorkerState | undefined {
    if (next === this.state) return undefined; // same state — not a transition, no row
    this.state = next;
    return next;
  }
}

/**
 * Evidence captured the MOMENT the clock-bound watchdog (W1-T1045, {@link
 * createWorkerClockBoundWatchdog}) trips — BEFORE anything is released (the lock, the
 * worktree, the process group; run-task.ts writes this evidence to the ledger before doing any
 * of that). `lastState`/`lastStateMs` are `undefined` when the stream never produced even one
 * classifiable `working`/`tool-executing` event before going silent — the same UNKNOWN
 * polarity {@link WorkerStateTracker.currentState} keeps (never defaulted to `"working"`).
 */
export interface WorkerAbandonmentEvidence {
  /** Milliseconds since the last observed stream activity (of ANY kind — see {@link
   *  WorkerStreamEvent}) at the moment the bound tripped. Always > `boundMs`. */
  elapsedMs: number;
  /** The resolved bound this run was measured against — never re-derived by a reader, since
   *  policy can move between when this fired and when anything reads it back. */
  boundMs: number;
  lastState?: WorkerState;
  /** The injected clock's reading at the last observed activity — `undefined` iff `lastState`
   *  is (nothing was ever observed before the bound tripped). */
  lastStateMs?: number;
}

/**
 * Thrown by {@link spawnWorker} when the W1-T1045 clock-bound watchdog trips: the stream
 * produced no observed activity for longer than `args.clockBound.boundMs`, so this call's own
 * `AbortController` was aborted and the SDK's iterator settled with an error rather than a
 * result envelope (see {@link collectWorkerResult}'s `if (!sawResult) throw err` path — a
 * stalled stream never produces one). Carries the {@link WorkerAbandonmentEvidence} the caller
 * (run-task.ts) needs to write a terminal verdict without re-deriving the same judgment this
 * watchdog already made; `cause` keeps the raw underlying error reachable for a post-mortem,
 * never discarded.
 *
 * A NAMED, DUCK-TYPEABLE reason, matching this file's existing convention for a refusal a
 * caller must recognize (`ClaudeToolchainBlockedError.reasonClass`, `WorkerKeychainError`) —
 * never a bare string match against `.message`.
 */
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

/** Real-time polling cadence for {@link createWorkerClockBoundWatchdog} — cheap relative to
 *  every bound this fires against (the policy floor is 1,200,000ms; see plan/policy.yaml's
 *  `workerAbandon` row), matching `buildWorkerStateSensor`'s own `WORKER_STATE_POLL_MS`
 *  (run-task.ts) sibling constant for the SAME "real timer, tiny relative to what it watches"
 *  reasoning. */
const WORKER_CLOCK_BOUND_POLL_MS = 5_000;

/**
 * THE CLOCK-BOUND WATCHDOG ITSELF (W1-T1045) — pure and independently testable, mirroring
 * `buildWorkerStateSensor`'s own observer/poll split (run-task.ts) one layer down, inside the
 * file that actually holds the live stream.
 *
 * Reuses {@link WorkerStateTracker}'s own "elapsed since last activity" math rather than
 * re-deriving it: constructing one with `quietFloorMs: boundMs` makes its `check()` transition
 * to `"quiet"` at EXACTLY the moment this watchdog must trip — the SAME `"quiet"` concept
 * {@link DEFAULT_WORKER_QUIET_FLOOR_MS} names, at a much longer floor, on a tracker instance
 * PRIVATE to this watchdog (never the run-level one `buildWorkerStateSensor` owns — the three
 * thresholds {@link WorkerStreamEvent}'s own doc names stay decoupled).
 *
 * `observer` wraps a `WorkerStreamObserver` so every observed event (working/tool-executing/
 * message — `"message"` heartbeats included, deliberately: see {@link WorkerStreamEvent}'s own
 * doc for why a heartbeat still resets the quiet clock) resets the idle clock; `start(onTrip)`
 * seeds that clock the moment polling begins (a synthetic `"message"` event) so a stream that
 * yields ZERO events before going silent still trips at `boundMs` — never earlier, never never
 * — and fires `onTrip` EXACTLY ONCE, carrying the evidence, the moment elapsed silence exceeds
 * the bound. Criterion 6 (a stream still producing events is never tripped, however long it
 * runs) holds because every event — via `observer` — pushes the tracker's own clock forward.
 *
 * `now`/`pollMs` are injectable, the SAME `now?: () => number` convention every clock-bearing
 * function in this file already follows (`collectWorkerResult`, `WorkerStateTracker.check`), so
 * a test trips this deterministically without a real multi-hour wait.
 */
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
    // Seed the tracker's clock the moment polling begins — see this function's own doc for why
    // a stream that never says anything at all must still trip.
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
    // DELIBERATELY NOT `.unref()`'d, unlike `buildWorkerStateSensor`'s own cosmetic poll
    // (run-task.ts): that timer only feeds a display/telemetry row, so losing it costs nothing.
    // THIS timer is the enforcement mechanism a genuinely stalled worker relies on — the SDK
    // call itself holds no Node-level timer or handle while it's hung, so an unref'd interval
    // here can let Node decide the event loop is idle and let the process exit (or, under a
    // runner, be torn down) before it ever fires, silently defeating the whole bound. `stop()`
    // (returned below) still clears it on every real exit path (spawnWorker's `finally`), so a
    // HEALTHY run is never kept alive a moment longer than the call it's watching.
    return () => clearInterval(timer);
  };

  return { observer, start };
}

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
    /**
     * W1-T2245: configured input, mirrored verbatim — see {@link WorkerResult.compactionConfigured}.
     * Defaults to `false` (never guessed `true`) for every existing caller/test that omits it,
     * matching every call site in this repo today: `spawnWorker` never sets `autoCompactEnabled`.
     */
    compactionConfigured?: boolean;
    /**
     * W1-T942: invoked per message, classified by kind, with THIS call's own injected clock
     * reading (never a second `Date.now()` read) — the ONE observer seam the design calls for.
     * Absent (every caller before this task, and every caller that omits it) ⇒ the loop below
     * behaves BYTE-IDENTICALLY to before this existed: no new branch, no new SDK call, no
     * second stream. See {@link WorkerStreamObserver}.
     */
    streamObserver?: WorkerStreamObserver;
    /** W1-T942: the injected clock `streamObserver` timestamps are read from. Omitted ⇒
     *  `Date.now`, exactly the discipline `worker_duration_ms` above already uses — a test
     *  drives a synthetic clock so the quiet-floor logic needs no real elapsed time. */
    now?: () => number;
  },
): Promise<WorkerResult> {
  // W1-T477: started BEFORE the first `for await` pull below — this function's body, start to
  // return, IS the worker call (spawnWorker's own "impl-EM" comment: everything ABOVE this call
  // is local/free setup). No clock injection: existing callers/tests already exercise this loop
  // against synthetic (near-instant) message streams, so `worker_duration_ms` on those results is
  // small but present, never a reason to add an injectable `now` seam this module didn't need
  // before.
  const startedAtMs = Date.now();
  const blocks: string[] = [];
  const stderrChunks = opts.stderrChunks ?? [];

  let sessionId = "";
  let costUsd = 0;
  let numTurns = 0;
  // W1-T2557: independently counted, mid-flight approximation of "turns" — one increment per
  // raw `assistant`-type SDK message, populated on EVERY `streamObserver` call below (including
  // system/result heartbeats, which report the count AS OF that event without incrementing it).
  // See `WorkerStreamEvent.turnsSoFar`'s own doc for why this is never asserted to equal the
  // terminal envelope's own `numTurns` above.
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
  // W1-T2572: the LAST real (non-`<synthetic>`) `msg.message.model` seen on the live
  // assistant stream — see {@link WorkerResult.servedModel}'s own doc. `undefined` until
  // (unless) a genuine value is observed, so a stream that never carries one falls
  // through to the explicit-unknown branch in the return below, never a guess.
  let servedModel: string | undefined;
  const compactionEvents: CompactionEvent[] = [];
  const compactionFailures: CompactionFailure[] = [];
  const nowFn = opts.now ?? Date.now;

  try {
    for await (const raw of messages) {
      const msg = raw as { type?: string; message?: unknown };
      if (msg.type === "system") {
        // MASTER-PLAN §8B / W1-T36: detect + ledger a compaction event LIVE,
        // off the SDK's own `compact_boundary` system message — reuses the
        // same detector a fixture-driven unit test exercises (compaction.ts),
        // so "detected in a test" and "detected live" can never drift apart.
        compactionEvents.push(...detectCompactionEvents([raw]));
        // W1-T2245: reads the SDK's OTHER compaction channel on the SAME message —
        // `{type:"system", subtype:"status", compact_result:"failed"}` (sdk.d.ts:4684) — never
        // matched by `detectCompactionEvents` above (it only matches `compact_boundary`), so a
        // FAILED attempt used to leave no trace at all. No new SDK call, no second stream: this is
        // the same raw message the boundary detector already receives.
        compactionFailures.push(...detectCompactionFailures([raw]));
        // W1-T942: a heartbeat — no worker-authored text, but still proof-of-life for the
        // quiet floor (design note ii, "no message of ANY kind").
        opts.streamObserver?.({ kind: "message", tsMs: nowFn(), turnsSoFar });
      } else if (msg.type === "assistant") {
        // Anthropic-side api error mid-stream (server_error / <synthetic> model /
        // isApiErrorMessage). A TRANSIENT — the envelope may still report success.
        const rawAny = raw as { isApiErrorMessage?: boolean; error?: unknown };
        const model = (msg.message as { model?: string })?.model;
        if (rawAny.isApiErrorMessage === true || model === "<synthetic>") apiError = true;
        // W1-T2572: verbatim off the SAME per-message field `apiError` above already reads —
        // the ONE place the live Claude stream names what actually generated this turn. Never
        // `modelUsage` (a post-hoc cost breakdown keyed by whatever the envelope reports at the
        // END, not a live per-turn signal) and never `<synthetic>` (that value marks an
        // Anthropic-side error placeholder, not a model that served anything). Last real value
        // wins, matching `text`/`subtype` below overwriting on each new message.
        if (typeof model === "string" && model.length > 0 && model !== "<synthetic>") servedModel = model;
        const content = (msg.message as { content?: unknown }).content;
        // W1-T2557: ONE assistant SDK message is ONE observed "turn" — incremented ONCE here,
        // before the block loop below, so a message carrying BOTH a text and a tool_use block
        // (the very next test case in test/worker-state-sensor.test.ts) reports the SAME
        // `turnsSoFar` on both emitted events rather than double-counting.
        turnsSoFar += 1;
        // W1-T942: TOOL-USE BLOCKS USED TO BE DROPPED ENTIRELY HERE — this task's whole
        // rationale. Classify EVERY block (never a second pass over `content`) so the SAME
        // loop that already extracts `text` also emits the `tool-executing` signal, with no
        // second stream and no extra SDK call (acceptance criterion 1).
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
        // An assistant message with neither a text nor a tool_use block (e.g. thinking-only)
        // is still a heartbeat — never silently drop the quiet clock's reset.
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
          // `usage`/`modelUsage` are on BOTH SDKResultSuccess and SDKResultError
          // (sdk.d.ts ground truth) — optional here only to tolerate a synthetic
          // test stream that omits them; a real envelope always carries both.
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number | null;
            cache_creation_input_tokens?: number | null;
          };
          modelUsage?: Record<string, Partial<ModelUsageEntry>>;
        };
        sawResult = true;
        // W1-T942: the terminal envelope is a heartbeat too — a run that goes straight from
        // spawn to a near-instant result (a synthetic test stream, or a genuinely trivial
        // call) still resets the quiet clock rather than leaving it unset forever.
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
    // No result envelope was seen ⇒ this is a real failure (bad binary, network,
    // aborted spawn), not an error-subtype result. Re-raise it.
    if (!sawResult) throw err;
    // Otherwise the throw is the SDK's post-error-result signal; the envelope is
    // already captured. Record the message on stderr for the proof surface.
    const swallowed = String((err as Error)?.message ?? err);
    stderrChunks.push(`\n[collectWorkerResult] error-result throw swallowed: ${swallowed}\n`);
    isError = true;
    // W1-T2564: CLASSIFY THE REFUSAL HERE, where the message still exists. `detectUsageLimitRefusal`
    // is the fleet's ONE usage-limit detector (lib/classify.ts, W1-T2515 — "A SHUT WINDOW IS NOT A
    // FLAKE"), already wired into the fix-retry loop; this is a second CALLER, never a second
    // classifier. Verified against the real stderr: it matches "You've hit your session limit" and
    // recovers `resetsAtMs` 2026-09-01T11:50:00.000Z — the reset the API actually stated, and MORE
    // ACCURATE than the 12:00:00.000Z the headroom governor believed at that same instant.
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
    // W1-T2572: `null` (never a guess) when the live stream never carried a real model
    // field — e.g. no assistant message at all, or every one was a `<synthetic>`
    // placeholder. `servedModelReason` names WHY only in that branch; see
    // {@link WorkerResult.servedModel}'s own doc for the full contract.
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
// The deterministic deny-floor hook is expected to block a forbidden write even
// under `bypassPermissions`. claude-code#20946 reported an async race where the
// block can leak under bypass; the spike guards against it by re-probing under
// the `dontAsk` permission mode. This state machine is extracted from spike.ts
// so the fallback is unit-testable WITHOUT spawning a real worker (the same
// rationale that split collectWorkerResult out of spawnWorker).

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

/**
 * Fold the containment probe's observations into a {@link DenyFloorVerdict}.
 *
 * Pass only `forbiddenPresentUnderBypass` for the first (bypass) probe. When it
 * is `true` the floor leaked, so the caller MUST re-run the probe under
 * {@link DENY_FLOOR_FALLBACK_MODE} and pass `forbiddenPresentUnderDontAsk` from
 * that second run. An omitted second observation is treated conservatively as
 * "not contained" — an unverified floor is never reported as holding.
 */
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

/**
 * Render the committed worker-settings TEMPLATE into a concrete settings file.
 *
 * The template ships `${HOOKS_DIR}` in its hook command so the public tree
 * carries no absolute machine path. At runtime we substitute the real hooks dir
 * and write the result outside the tree (workers run with cwd = a worktree, so
 * the hook path must be absolute, not `$CLAUDE_PROJECT_DIR`-relative). Returns
 * the path to the rendered file.
 */
export function renderWorkerSettings(opts: {
  templatePath: string;
  hooksDir: string;
  outPath: string;
}): string {
  const template = readFileSync(opts.templatePath, "utf8");
  const rendered = template.split("${HOOKS_DIR}").join(opts.hooksDir);
  // Validate JSON before writing so a bad substitution fails loud (a settings
  // file that fails validation is SILENTLY ignored by `claude -p`).
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

/**
 * ANCHORED PR_URL extraction (W1-T62). The OUTPUT CONTRACT (run-task.ts) demands
 * a REPORT whose LAST line is exactly `PR_URL: <url>` — but the prior parse took
 * the FIRST pull-URL ANYWHERE in the worker output, so an evidence pull-URL
 * (e.g. a dependency PR cited to satisfy acceptance criteria) appearing BEFORE
 * the real PR_URL line won attribution instead. Run W1-T54b-1784151420811 was
 * ledgered verdict=merged via PR #80 (Dependabot's own PR) by exactly this
 * defect; the run's real PR was #91.
 *
 * Only a line matching `PR_URL:` (anchored to the start of that line, case
 * -insensitive) followed by a well-formed github pull-request URL counts; every
 * other pull-URL in the text — evidence, prose, quoted contract text — is INERT.
 * When the contract is honored more than once (e.g. a DECISION_REQUEST resume
 * appends a second REPORT), the LAST such line wins, matching "last line of the
 * REPORT". A missing or malformed line yields `undefined` — never a guess.
 */
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

/**
 * Strip presentation decoration from a decision option/recommendation label so
 * the returned value is the DATA, never the DATA-plus-chrome. Decoration is not
 * data: the WS-0 `)` bleed (an inline `(RECOMMENDED)` marker leaking its closing
 * paren) and the T1D `**`…`**` / backtick / ✅ / trailing `****` noise are the
 * same class of bug — a decorated label mistaken for the value it dresses up.
 * Removes the inline recommend marker, markdown emphasis (`*`) and code ticks
 * (`` ` ``), and emoji, then collapses the leftover whitespace.
 */
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
  // Match option lines on their RAW form first (so the inline `(RECOMMENDED)`
  // marker is still visible for recommendation detection), then normalise each
  // value through stripDecoration so the option list carries no chrome.
  const rawOptions = [...text.matchAll(/^\s*(?:[-*]+|\d+[.)])\s*(.+)$/gim)].map((m) => m[1]);
  const options = [...new Set(rawOptions.map(stripDecoration).filter(Boolean))];
  // Prefer an explicit `RECOMMENDED: <value>` line, but ignore a value that
  // decorates down to stray punctuation (the WS-0 `)` bleed). Fall back to the
  // raw option line that carries the inline marker — decoration stripped.
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

/** One typed follow-up line off a worker's OPTIONAL `## Follow-ups` §2 section
 *  (W1-T105) — `text` carries its own one-line why, never a separate field. */
export interface FollowupEntry {
  type: "research" | "task" | "action";
  text: string;
}

/**
 * Parse the OPTIONAL `## Follow-ups` section of a worker REPORT (§2 OUTPUT
 * CONTRACT, W1-T105): "anything discovered that is OUT OF SCOPE for the one
 * concern goes here, never into the diff." One typed entry per line —
 * `research:` | `task:` | `action:` (an optional leading `-`/`*` bullet is
 * tolerated) — each line's own text carries its why, so no separate why field
 * is ever required. Absent section -> `null`, a byte-identical no-op for
 * every existing caller (parseReport/parseQuestion are untouched by this
 * parser and never see it). A line that names none of the three types is
 * silently skipped, never crashes the whole report over one malformed line.
 */
export function parseFollowups(text: string): FollowupEntry[] | null {
  // (?![\s\S]) — TRUE end-of-string, unaffected by the /m flag the leading `^`
  // needs (a bare `$` under /m matches before EVERY newline, so the lazy body
  // would stop at the section's FIRST line instead of running to its end).
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

/**
 * Append a QUESTION to the durable side-channel store, `plan/questions.ndjson`
 * (one JSON object per line — diffable, append-only, no round-trip hazard).
 *
 * NON-BLOCKING by contract (MASTER-PLAN §2): the QUESTION channel is the
 * assume-log-keep-moving path, so it must NEVER stall the loop. A write failure
 * is caught and reported as `false` rather than thrown. Ensures `plan/` exists so
 * a fresh checkout logs durably on its first question. Returns whether the line
 * was written.
 */
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

/**
 * One durable ANSWER entry — a line of `plan/questions.ndjson` (W3-T5, MASTER-PLAN §7: "the
 * question backlog... answers flow to the Architect"). Shares the QUESTION contract's own
 * store (never a second file) so an answer lands in the SAME diffable, append-only channel
 * every future question consumer (the Architect's triage/retro loop, the daily digest) already
 * watches — distinguished from a {@link QuestionEntry} by carrying `answer` instead of
 * `question`, so a reader can tell the two apart without a separate `kind` discriminator.
 */
export interface QuestionAnswerEntry {
  ts: string;
  task: string;
  answer: string;
  /** Non-reversible id of the bearer token that submitted the answer — never the raw token (see lib/panel-actions.ts's `bearerTokenId`). */
  origin: string;
}

/**
 * Append an operator's ANSWER to the SAME durable side-channel store `appendQuestion` writes
 * to, `plan/questions.ndjson` — the panel's write action (W3-T5) is this function's only
 * caller today (lib/panel-actions.ts's `buildAnswerQuestionRoute`). NON-BLOCKING by the same
 * contract as `appendQuestion`: a write failure is caught and reported as `false`, never
 * thrown — an unwritable store must not turn an operator's answer into an unhandled crash.
 */
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

/** This rmd install's own root — the SAME derivation `src/lib/policy.ts:344` uses from a
 *  `src/lib/` module. Its `node_modules` is guaranteed populated whenever rmd is running
 *  at all, because `bin/rmd` execs `$DIR/node_modules/.bin/tsx`: a missing or empty one
 *  means this process could not have started. */
function installRootDir(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
}

/**
 * Which `node_modules` a fresh worktree should resolve its dev CLIs from.
 *
 * Prefers the PARENT CLONE's own install, which is the right answer whenever that clone
 * has been installed. Falls back to this rmd install's, which on the fleet host is the
 * only one that exists: worktrees are cut from `<config.root>/repos/<repo>`, and that
 * clone carries NO `node_modules` at all (measured). Sourcing only from `repoDir` would
 * therefore ship a fix that is inert on the very host it is meant to repair.
 */
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
  // W1-T2777: the link was made (best-effort contract unchanged) but the source's
  // `package.json`+`package-lock.json` hash differed from the worktree's. The worktree's
  // source tree was cut from `origin/main` at HEAD; its `node_modules` came from
  // `repoDir` (see {@link resolveNodeModulesSource}) which may sit arbitrarily far behind
  // (see {@link recordCanonicalCheckoutDrift} for the coupling that surfaces this). This
  // outcome tells the caller so a worker cannot start with a lockfile it cannot resolve
  // and read the resulting "module not found" as a defect in its own diff.
  | "linked-lockfile-mismatch";

/**
 * Give a fresh worktree a `node_modules`, by SYMLINK — never by installing.
 *
 * WHY THIS EXISTS. W1-T137 (#842) shipped `hooks/commit-msg`, wired into every worktree by
 * the `core.hooksPath` line below. That hook resolves `$(git rev-parse --show-toplevel)/
 * node_modules/.bin/commitlint` and, finding none, exits 1 with "commitlint is not installed
 * in this worktree" — by design, it refuses to skip the gate silently. But `worktreeAdd` never
 * supplied a `node_modules`, so EVERY commit from EVERY worktree verb (runTask, retro, triage,
 * plan, draftProposalBatch, approve — all six share this function) has been rejected since
 * 2026-07-29. W1-T137's own suite passes only because it symlinks one in itself
 * (`symlinkNodeModules`, test/commit-msg-hook.test.ts:78).
 *
 * A symlink is the remedy this repo already prescribes for exactly this (CLAUDE.md, 2026-07-29:
 * "Wire a worktree up with `ln -s <canonical>/node_modules <worktree>/node_modules`"), and it is
 * emphatically NOT `npm ci`: an install here is what emptied the shared `node_modules` under the
 * live daemon on 2026-07-29. The hook's own advice ("run `npm ci` first") must not be taken.
 *
 * Best-effort by contract: every outcome is a RETURN VALUE, never a throw. Creating a worktree
 * must not fail because its dev CLIs could not be wired up.
 */
export function linkWorktreeNodeModules(
  repoDir: string,
  worktreePath: string,
  deps: {
    resolveSource?: (repoDir: string) => string | undefined;
    /** Throws when the path is absent — `lstat`, not `stat`, so a BROKEN symlink still counts
     *  as taken. Linking over either one would write INSIDE the existing target. */
    lstat?: (p: string) => unknown;
    symlink?: (target: string, path: string) => void;
    /**
     * W1-T2777: injectable hasher over `package.json` + `package-lock.json` (default the real
     * `hashInstallInputs` shared with `ensureInstallFresh`). A test hands both sides to prove
     * both directions of the compare — matching lockfiles stay quiet, differing ones return
     * `linked-lockfile-mismatch`. Sharing this ONE primitive with the run-task freshness path
     * is what stops two independent hashes on the same inputs from drifting silently.
     */
    hashInstallInputs?: (dir: string) => string;
    /**
     * W1-T2777: surface for the loud channel. Default `console.error`, matching
     * {@link recordCanonicalCheckoutDrift}'s existing convention rather than inventing a second
     * one. The warning names the two sides being compared (worktree source dir and the
     * `node_modules` source path) so the operator or the caller has both without re-deriving.
     */
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
    // Symlink failed — no lockfile compare is meaningful because there is nothing linked to
    // compare against. Preserves the pre-W1-T2777 "failed" contract byte-identically.
    return "failed";
  }
  // W1-T2777: LOCKFILE COMPARE AT SYMLINK TIME. The link is already in place (best-effort
  // contract from the header holds), and now the two `package.json`+`package-lock.json` hashes
  // decide whether it is SAFE-TO-USE or KNOWN-STALE. The source of node_modules is
  // `parentOf(source)` — `resolveNodeModulesSource` returns `<x>/node_modules` and the
  // hashInputs live in `<x>` — not `repoDir`, because on the fleet host the fallback branch
  // resolves to the install root's own tree, not repoDir's (see the doc for `resolveSource`).
  // WHY THIS IS THE RIGHT MOMENT. Any comparison earlier misses the fact that resolveSource
  // may point at the install root rather than repoDir; any comparison later runs after a worker
  // has already imported code and seen "Cannot find module" without the operator being told
  // whose fault it was. Here, the link is fresh, the two source trees are identifiable, and
  // the outcome propagates to the caller by return value — the existing best-effort pattern
  // (`recordCanonicalCheckoutDrift`) uses the same idiom for the same reason.
  const hashFn = deps.hashInstallInputs ?? ((d: string) => hashInstallInputs(d));
  const nmSourceDir = dirname(source);
  let mismatch = false;
  try {
    // Both reads catch failures internally (see hashInstallInputs' contract). A missing file
    // hashes as empty content on both sides, which produces a MATCH — safest possible verdict
    // when there is nothing to compare.
    mismatch = hashFn(worktreePath) !== hashFn(nmSourceDir);
  } catch {
    // The hash function is documented to be non-throwing; a throw here means the injected
    // fake broke that contract. Treat as "cannot tell" and preserve the pre-fix outcome —
    // never invent a mismatch a real read did not observe.
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

/**
 * Make git ignore the `node_modules` link above, independent of whether the checked-out
 * `.gitignore` happens to cover it.
 *
 * WITHOUT THIS the link is an untracked file, and W1-T142's out-of-scope push guard refuses
 * the whole branch with "NOT pushing: node_modules" — turning a commit fix into a push
 * regression. remudero's own `.gitignore` does list it, but relying on the checked-out repo
 * to do so is exactly the assumption that failed here; `worktreeAdd` serves any repo.
 *
 * MEASURED (this host, git 2.x): a linked worktree honours the COMMON dir's `info/exclude`
 * and IGNORES its own per-worktree admin one, so that is where this writes — the same
 * shared-scope write the `core.hooksPath` line already makes. Idempotent and best-effort.
 */
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

/**
 * Thrown by {@link assertWorktreeBaseCurrent} (and so by `worktreeAdd`) when the base a
 * worktree was just created from differs from an independently-observed remote head.
 * Named so a caller can catch it specifically — see `run-task.ts`'s `runTask`, which turns
 * it into a `blocked_stale_base` verdict rather than letting it propagate as a bare crash.
 *
 * W1-T405: the message names what was OBSERVED — behind — never a cause it cannot see. The
 * out-of-scope scope guard (`scopeGuardOutOfScopeFiles` in run-task.ts) used to assert a
 * "forged merge-base" for a diff shape that a merely-stale base produces identically; that
 * guard cannot tell the two apart because by the time it runs (after recon, implement, and
 * commit) the distinguishing evidence — what the base actually was at creation time — is
 * long gone. This error exists so staleness is caught, and named for what it is, before
 * that guard ever gets a chance to guess.
 */
export class WorktreeBaseStaleError extends Error {
  constructor(
    public readonly base: string,
    public readonly remoteHead: string,
    public readonly ref: string,
    /** W1-T2621: commit distance `base..remoteHead`, local objects only (never a second
     *  network read) — "unknown" when the remote head's object is not present locally, the
     *  "fetch did not move the ref" shape this task exists to surface. Lets a caller's ledger
     *  line (`worktree.stale_base`) tell a one-commit race from a broken provisioning path. */
    public readonly behind: number | "unknown" = "unknown",
  ) {
    super(
      `worktree base ${base} is BEHIND ${ref}'s remote head ${remoteHead} — the base is stale ` +
        "— refusing before any worker runs",
    );
    this.name = "WorktreeBaseStaleError";
  }
}

/**
 * Assert-and-refuse (W1-T405 design note (i)): compare the base a worktree was just
 * created from against the remote head an INDEPENDENT read observes right now, and throw
 * {@link WorktreeBaseStaleError} when they differ.
 *
 * WHY INDEPENDENT. `worktreeAdd`'s own `git fetch` already moves the local `origin/<ref>`
 * tracking ref before the worktree is cut, so in the ordinary case this can never fire —
 * that is the point; every one of `worktreeAdd`'s six call sites already fetches before
 * creating. It exists for the failure mode source review cannot rule out (W1-T405's own
 * rationale): a fetch that exits zero without the worktree actually landing on the ref that
 * fetch believed it moved. Re-reading the remote here — never the just-fetched local ref,
 * which is exactly the thing in question — catches that regardless of which path let it
 * through, without this function having to name the path.
 *
 * STALE MEANS BEHIND BY ANY COMMIT (design note (ii)) — a deliberate over-approximation:
 * the precise question ("behind in a way that affects the diff") needs the diff, which
 * needs the run, which is the spend this check exists to avoid paying before finding out.
 *
 * UNREADABLE WARNS, NEVER REFUSES (design note (iii)): `deps.readRemoteHead` throwing (an
 * unreachable forge, a transport error) is treated as "cannot be measured", not "is stale"
 * — refusing on an unmeasurable condition would convert a network blip into a stalled
 * queue, the exact failure this repo keeps re-learning (ci-gate's wait cap, a deploy
 * ceiling burned by a dry run, a check-wait bound, the idle-gate ceiling). The warning
 * still surfaces so an operator can tell the check ran and could not measure, rather than
 * silently skipping it.
 *
 * W1-T2621: the SAME unreadable branch also ledgers `worktree.base_uncheckable` (carrying
 * `ref`, `base`, and the error) through `deps.log` when one is supplied, IN ADDITION to the
 * `warn` above — `warn`'s only channel in production is `console.error` (a worktreeAdd
 * caller with no `worktreeBaseDeps` gets the default), which is neither durable nor read by
 * anything; `log`, when supplied, is the run's own ledger, so the fail-open leaves a trace
 * an operator can find after the fact instead of only at the moment it happened. Polarity is
 * unchanged: this still returns (proceeds) rather than throwing.
 *
 * PURE aside from the injected callbacks — no git/network call of its own — so a test
 * drives every branch (stale / current / unreadable) without a second real remote.
 */
export function assertWorktreeBaseCurrent(
  base: string,
  ref: string,
  deps: {
    readRemoteHead: () => string;
    warn?: (message: string) => void;
    /** W1-T2621: the run's ledger logger — see the function doc's "ledgers
     *  worktree.base_uncheckable" note. Optional; absent means no ledger line, exactly as
     *  before this option existed. */
    log?: (step: string, extra?: Record<string, unknown>) => void;
    /** W1-T2621: commit distance `base..remoteHead`, invoked ONLY on the stale branch (the
     *  current/unreadable branches have a trivial distance — 0 / "unknown" — that needs no
     *  git call at all). Local objects only, never a second network read; the caller
     *  (`worktreeAdd`) is the one with a `repoDir` to read them from, so it supplies this —
     *  omitting it here keeps this function itself free of any real git/network call.
     *  Default: "unknown", never a guessed number. */
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

/**
 * How many CONSECUTIVE `worktree.add` lines with an UNREADABLE `remote_head` — the shape
 * {@link assertWorktreeBaseCurrent}'s fail-open branch produces, see its own doc — turn "the
 * currency check could not run this once" into a DEGRADED POSTURE worth naming, rather than
 * continuing indefinitely, one `console.error` at a time, exactly as though the guard were
 * still running (W1-T2626 design note (iii)).
 *
 * A NAMED CONSTANT, NOT YET POLICY DATA. `plan/policy.yaml` is this value's eventual home — the
 * same substrate `fixStrikeCap`/`sweep.strikeCap` already ride — but wiring a NEW field through
 * there means editing `src/lib/policy.ts`'s schema too, outside this task's declared scope
 * (`src/lib/worker.ts` + `src/run-task.ts` + this feature's own test). Design note (iii)'s own
 * parenthetical covers exactly this: "a single named constant with its bound stated until
 * then". 3 — the same "three strikes" order of magnitude `fixStrikeCap`/`sweep.strikeCap`
 * already use in `plan/policy.yaml` — rules out one flaky `ls-remote` (noise the existing
 * warn/fail-open already fully absorbs on its own) while still catching a persistently
 * unreachable remote well before an entire session passes under a guard that silently never ran.
 *
 * BACKSTOP (W1-T1266's bound-kind tag). The PRIMARY CONTROL for a base that cannot be read is
 * `assertWorktreeBaseCurrent`'s own warn/fail-open branch: it runs on every add, decides every
 * ordinary case, and is what deliberately absorbs a single flaky `ls-remote`. This constant decides
 * nothing on that path and never fires while that control is working. It exists only for the case
 * the primary handles SILENTLY and indefinitely — a remote unreachable run after run, which reads
 * exactly like a guard that is passing. That is the backstop shape: it catches the failure of the
 * control above it, not the condition that control was written for.
 */
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

/**
 * Is the worktree-base currency check currently DEGRADED — has its remote-head read failed N
 * times running, with no intervening readable creation? Pure over ledger lines, oldest-first,
 * the SAME "current-run-only, a success resets it" shape {@link detectPostReviewStall}
 * (`lib/sweep.ts`) already established for the sweep's post-review path — a success (or, here, a
 * readable head) resets the count rather than letting one good day forgive a permanent latch.
 *
 * READS `worktree.add` LINES ONLY. Every worktree creation that reaches the point of being
 * ledgered emits exactly one — a refusal (`WorktreeBaseStaleError`) never does, `worktreeAdd`
 * throws before that log call runs — so this single step name can't double-count a creation
 * whose `worktree.base_uncheckable` companion line rotated out independently; `remote_head` on
 * that one line already tells "readable" (a real sha) from "unreadable" (the literal string)
 * without needing the companion line at all.
 *
 * ORTHOGONAL TO STALENESS: a `worktree.stale_base` refusal (a READABLE remote head that simply
 * differs from the base) neither resets nor extends this run — base currency and base
 * READABILITY are different questions, and design note (iii) is scoped to the unreadable branch
 * only.
 */
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

/**
 * Result of {@link measureCanonicalCheckoutDrift}: how far the canonical checkout's `HEAD`
 * sits behind the `origin/<ref>` a worktree was just cut from.
 */
export type CanonicalCheckoutDriftResult =
  | { status: "current" }
  | { status: "behind"; commits: number }
  | { status: "unknown"; reason: string };

/** Real (non-test) local read: commits reachable from `origin/<ref>` but not `HEAD`, i.e.
 *  how far `repoDir`'s checked-out branch is behind. No fetch of its own — see the doc on
 *  {@link measureCanonicalCheckoutDrift} for why none is needed here. */
function defaultRevListCanonicalBehind(repoDir: string, ref: string): string {
  return execFileSync("git", ["-C", repoDir, "rev-list", "--count", `HEAD..origin/${ref}`], {
    encoding: "utf8",
  });
}

/**
 * Measure how many commits the CANONICAL CHECKOUT's `HEAD` sits behind `origin/<ref>` — the
 * deps SOURCE every worker worktree's `node_modules` is symlinked to by
 * {@link linkWorktreeNodeModules} (W1-T2618). Read at the exact moment that link is made, so
 * the staleness of the tree a fresh worktree resolves its dev CLIs through becomes an
 * OBSERVED quantity instead of an assumed-fresh one.
 *
 * MEASURE, NEVER REPAIR (design note (i)). This does not fetch, pull, or install anything to
 * fix a stale checkout — what to DO about one (refresh it, refuse, warn) is a later ruling,
 * not decided here. It runs no package manager and performs no install on any path: the only
 * subprocess it launches is `git rev-list --count`, never `npm`/`yarn`/`pnpm` — the exact
 * outage class (an install emptying the shared `node_modules` under a live daemon) the
 * symlink discipline exists to prevent.
 *
 * REUSES THE ALREADY-FETCHED REF (design note (ii)), NO NEW FETCH. Every `worktreeAdd` call
 * site runs `git fetch origin --quiet` in `repoDir` before this ever runs (see the `fetch`
 * line above the `linkWorktreeNodeModules` call below), which already moves `repoDir`'s
 * local `origin/<ref>` tracking ref to the current remote head. So `origin/<ref>` here is
 * already current, and the `rev-list` below is a purely LOCAL, no-network read comparing two
 * refs already on disk — it does not re-fetch.
 *
 * BEST-EFFORT, LIKE ITS SIBLING (design note (iii)): mirrors `linkWorktreeNodeModules`'s own
 * "every outcome is a RETURN VALUE, never a throw" contract exactly. An unreadable repo, a
 * missing `origin/<ref>`, or unparseable `rev-list` output all degrade to `"unknown"`, never
 * a thrown error — a staleness measurement that could itself break dispatch would be worse
 * than the drift it measures.
 *
 * PURE aside from the injected callback — no git call of its own beyond the default — so a
 * test drives every branch (current / behind / unknown) without a second real remote.
 */
export function measureCanonicalCheckoutDrift(
  repoDir: string,
  ref: string,
  deps: {
    /** Commits `HEAD..origin/<ref>` in `repoDir`, as raw `rev-list --count` text. Default: a
     *  local `git rev-list --count`, no fetch. Injectable so a test can simulate current /
     *  behind / unreadable without a second real remote. */
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

/**
 * Report {@link measureCanonicalCheckoutDrift}'s result the way {@link assertWorktreeBaseCurrent}
 * reports an unreadable remote head: NAME the checkout and its measured distance via `warn`
 * when it is behind (acceptance claim 2), and stay silent when it is current — a detector,
 * not a permanent red (acceptance claim 3). NEVER THROWS regardless of outcome: the symlink
 * this runs right after is best-effort by contract, and a stale deps source must never fail
 * worktree creation (acceptance claim 2, design note (iii)). Called from `worktreeAdd`
 * immediately after `linkWorktreeNodeModules` — the one place the system already knows a
 * worktree's deps source.
 */
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

/**
 * Sibling path recording the commit a worktree was created from — OUTSIDE the working
 * tree, same convention as {@link runLockPath}'s liveness token — so it is never committed
 * and a later refusal can name the base without re-deriving it via `git merge-base`.
 */
export function worktreeBasePath(worktreePath: string): string {
  return `${worktreePath}.base`;
}

/**
 * Record the base a worktree was just created from (W1-T405 acceptance (4)). `worktreeAdd`
 * calls this for every worktree it creates, BEFORE the currency check below can throw, so a
 * stale-base refusal still leaves an attributable sibling file even though the worktree
 * itself is about to be abandoned.
 */
export function recordWorktreeBase(worktreePath: string, base: string): void {
  writeFileSync(worktreeBasePath(worktreePath), `${base}\n`);
}

/**
 * Read a previously-recorded base (see {@link recordWorktreeBase}). `null` when absent or
 * unreadable — never throws, so a missing record (a worktree predating W1-T405, or one
 * whose sibling file was cleaned up) degrades to "unknown" rather than blocking whatever
 * wanted to attribute a refusal.
 */
export function readWorktreeBase(worktreePath: string): string | null {
  try {
    return readFileSync(worktreeBasePath(worktreePath), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Drop a worktree's sibling base record. The record's lifetime is its worktree's: it exists
 * so a refusal can be attributed while the corpse is still on disk, and it must die when the
 * corpse does — a removal that leaves it behind fails the guard suite's "cleans up" contract
 * (the approve refusal path found exactly that residue) and would hand the reaper one orphaned
 * file per pass. Guarded, never throws: a worktree predating W1-T405 has no record to drop.
 */
export function removeWorktreeBase(worktreePath: string): void {
  try {
    fs.unlinkSync(worktreeBasePath(worktreePath));
  } catch {
    /* absent or unreadable — removal owes nothing here */
  }
}

/** Real (non-test) {@link assertWorktreeBaseCurrent} remote read: a fresh `git ls-remote`
 *  against `origin`, independent of whatever the fetch inside `worktreeAdd` just did. */
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

/** W1-T2621: the LOCAL `origin/<ref>` tracking ref, read immediately after `worktreeAdd`'s own
 *  `git fetch` — one of the three readings the `worktree.add` ledger line needs (the other two
 *  are the created base and {@link defaultReadRemoteHead}'s independent remote read) to tell
 *  "the add cut from a ref other than the one it was told to" apart from "the fetch did not
 *  move the ref" after the fact. No network call of its own — purely local, right after a
 *  fetch that already succeeded (fail-closed), so failure here is not expected; it degrades to
 *  the literal `"unreadable"` rather than aborting worktree creation over a sensor read. */
function readLocalOriginRefHead(repoDir: string, ref: string): string {
  try {
    return execFileSync("git", ["-C", repoDir, "rev-parse", `refs/remotes/origin/${ref}`], {
      encoding: "utf8",
    }).trim();
  } catch {
    // This is a best-effort observability read after the fail-closed fetch; "unreadable" keeps
    // sensor failure distinct from an absent or current ref without blocking worktree creation.
    return "unreadable";
  }
}

/** W1-T2621: `assertWorktreeBaseCurrent`'s `countBehind` for a real repo — commits
 *  `base..remoteHead`, LOCAL OBJECTS ONLY (`git rev-list --count`), never a second network
 *  call. Returns `"unknown"`, never a guessed number, when the count cannot be produced — most
 *  notably when `remoteHead`'s object is not present locally at all, which is exactly the "the
 *  fetch did not move the ref" shape this task exists to surface rather than silently render
 *  as `behind: 0`. */
function defaultCountBehind(repoDir: string, base: string, remoteHead: string): number | "unknown" {
  try {
    const out = execFileSync("git", ["-C", repoDir, "rev-list", "--count", `${base}..${remoteHead}`], {
      encoding: "utf8",
    });
    const n = Number.parseInt(out.trim(), 10);
    return Number.isInteger(n) && n >= 0 ? n : "unknown";
  } catch {
    // The remote object may not exist locally; preserve that unmeasurable state explicitly rather
    // than aborting creation or manufacturing a zero distance.
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
    /** Reads the CURRENT remote head for `ref` (the branch name `base` names, e.g.
     *  "main"), independent of the fetch just above — see {@link assertWorktreeBaseCurrent}.
     *  Default: a fresh `git ls-remote`. Injectable so a test can simulate stale / current /
     *  unreachable without standing up a second real remote. */
    readRemoteHead?: (repoDir: string, ref: string) => string;
    /** Surfaces the "remote head unreadable, proceeding anyway" warning (design note
     *  (iii)) AND (W1-T2618) the "canonical checkout is behind" drift warning. Default:
     *  `console.error` for both. */
    warn?: (message: string) => void;
    /** W1-T2621: the run's ledger logger. Absent (the default) leaves behaviour BYTE-IDENTICAL
     *  to before this option existed — `spike.ts` and any other caller with no ledger are
     *  unchanged. Present, this emits ONE `worktree.add` line per creation carrying the
     *  three-way base reading (`base`, `local_ref_head`, `remote_head`) plus `ref` and
     *  `behind`, and — on the currency check's fail-open branch — `worktree.base_uncheckable`
     *  (see {@link assertWorktreeBaseCurrent}). `run-task.ts`'s call sites supply it; a
     *  refusal (`WorktreeBaseStaleError`) is still the caller's own to ledger, since only the
     *  caller decides what a refusal means for its dispatch. */
    log?: (step: string, extra?: Record<string, unknown>) => void;
  } = {},
): void {
  execFileSync("git", ["-C", repoDir, "fetch", "origin", "--quiet"], { stdio: "inherit" });
  const ref = base.replace(/^origin\//, "");
  // W1-T2621: read the LOCAL tracking ref right after the fetch, before the worktree is cut
  // from it — see readLocalOriginRefHead's own doc for why this reading, not just the
  // created base and the independent remote head, is needed to discriminate the mechanism.
  const localRefHead = readLocalOriginRefHead(repoDir, ref);
  // W1-T1129: `base` (e.g. "origin/main") is a remote-tracking start point, so plain
  // `-b <branch>` would ALSO write `branch.<branch>.remote`/`.merge` into the repo's ONE
  // shared `.git/config` — a write every other concurrent worktreeAdd/checkout -B call
  // races for the same `.git/config.lock` (rationale (3)/(4)). Nothing here reads that
  // tracking config, so `--no-track` keeps the branch (still at `base`'s commit, still
  // pushable) and drops only the config write.
  execFileSync(
    "git",
    ["-C", repoDir, "worktree", "add", "-b", branch, "--no-track", worktreePath, base],
    { stdio: "inherit" },
  );
  // W1-T405: record the base BEFORE the currency check below — a refusal throws out of
  // this function with no return value, so the record must already be on disk for it to
  // be attributable at all. See recordWorktreeBase's own doc.
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
  // W1-T2621: ONE line per creation, THREE readings plus the distance (design note (ii)) — a
  // stale base never reaches here (assertWorktreeBaseCurrent above throws first), so this is
  // the "currency check passed or degraded-but-proceeded" line, never emitted for a refusal.
  deps.log?.("worktree.add", {
    branch,
    worktreePath,
    base: createdBase,
    local_ref_head: localRefHead,
    remote_head: currency.remoteHead,
    ref,
    behind: currency.behind,
  });
  // W1-T137: point this worktree at the repo's tracked hooks/ dir so its real git
  // commit-msg hook (hooks/commit-msg) fires on every commit the worker authors
  // itself — the only backstop PR #407 explicitly left unbuilt (it shaped only the
  // two HARNESS-built commit-header sites, never a worker's own `git commit`).
  // A RELATIVE core.hooksPath resolves against each worktree's OWN top-level dir
  // (verified against git 2.54: a linked worktree finds <worktree>/hooks, not the
  // main checkout's), so "hooks" is correct here even though `git config` (no
  // `extensions.worktreeConfig`) writes it to the repo's ONE shared config file —
  // every worktree, this one and every future one off the same repoDir, resolves
  // the same relative value against its own checked-out hooks/. Idempotent: safe
  // to set on every worktreeAdd call, including ones after it is already set.
  execFileSync("git", ["-C", worktreePath, "config", "core.hooksPath", "hooks"], {
    stdio: "inherit",
  });
  // …and give that hook the `commitlint` it resolves, or it rejects every commit made here.
  // Must run AFTER the hooksPath line and AFTER the worktree exists. See the doc comments.
  // Excluding FIRST keeps the link from ever being visible to git as an untracked file.
  excludeNodeModulesFromGit(worktreePath);
  linkWorktreeNodeModules(repoDir, worktreePath);
  // W1-T2618: the link just above ties this worktree's node_modules to repoDir's own tree
  // — measure how far THAT tree sits behind the origin/<ref> the fetch above just moved,
  // right here where the coupling is real. `ref` is already computed above; no new fetch.
  recordCanonicalCheckoutDrift(repoDir, ref, { warn: deps.warn });
}

/** Does a local branch named `branch` already exist in `repoDir`? A cheap, read-only
 *  `show-ref` check — unlike `git branch -D` it never touches a ref, so it cannot itself
 *  contend for `.git/refs`'s lock. Used by {@link uniqueRunBranch}, below. */
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

/**
 * Pick a `run-<runId>` worktree branch name that is ACTUALLY FREE in `repoDir` right now,
 * falling back to a numbered suffix (`run-<runId>-2`, `-3`, …) when the plain name is
 * already taken (W1-T2493).
 *
 * WHY A RUN ID CAN BE ASKED FOR TWICE. `runId` identifies a PROCESS across every ledger row
 * it writes — right for a run id — but a rung built ONCE at daemon boot and re-invoked on
 * every later poll (`buildInboxDraftHook`/`draftProposalBatch`, run-task.ts) closes over that
 * SAME string and hands it to this function again on every poll that has work. `worktreeAdd`'s
 * `-b` correctly refuses an existing branch — that refusal is exactly what stops two lanes
 * silently sharing a checkout — so without this, the SECOND call in one boot died on
 * `fatal: a branch named 'run-<runId>' already exists`, deterministically, forever, because
 * nothing about the requested name ever changed between polls.
 *
 * WHY A LEFTOVER BRANCH IS THE COMMON CASE, NOT THE EXCEPTION. `git worktree remove` (see
 * `worktreeRemove`, below) never deletes the branch a worktree was checked out on — that is
 * ordinary git, not a bug — so even a worktree that finished CLEANLY leaves `run-<runId>`
 * behind as a local ref the very next call to this function will find. A worktree reaped after
 * a crash leaves the identical residue. Either shape must be tolerated without assuming a
 * clean namespace, which is exactly what re-checking existence per candidate gives for free.
 *
 * NEVER FORCES OR REUSES. This function only ever returns a name it just observed to be free
 * — it does not delete, rename, or `-f` over anything. A genuine race (two lanes computing the
 * identical candidate at the same instant) is still refused: `worktreeAdd`'s own `-b` throws
 * if the real `git worktree add` loses that race, exactly as it always has.
 *
 * THE RUN ID ITSELF IS NEVER TOUCHED. Only the returned branch NAME can gain a suffix; every
 * caller keeps passing the original `runId` to `log`/`writeRunLock` unchanged, so ledger
 * attribution for this process's whole life is byte-identical to before this function existed.
 */
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
  // Reap the worker's SDK scratchpad (lib/worker-scratch.ts) FIRST, while this cwd
  // still exists for the reap to realpath — the git remove below deletes it. The
  // Claude CLI leaves `/private/tmp/claude-<uid>/<slug>/` behind on a non-graceful
  // worker exit; nothing else reaps it. Best-effort, guarded, never throws.
  reapWorkerScratch(worktreePath);
  execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", worktreePath], {
    stdio: "inherit",
  });
  removeWorktreeBase(worktreePath); // the sibling base record dies with its worktree
  // Accumulation control (orchestrator-side, survives a killed worker): also reap
  // STALE ORPHAN scratch under the same claude-<uid> root — the `rmd-*` test fixtures
  // a SIGKILL'd `npm test` leaves behind (its own finally + tmp-hygiene's exit handler
  // are both skipped on SIGKILL), which the daemon boot sweep (os.tmpdir()) never
  // scans. The 4h ceiling is far above the longest task, so a concurrent live fixture
  // is never reaped; far below the 24h boot ceiling, so orphans clear within a task
  // cycle. Disjoint from the per-<slug> reap above and best-effort/never-throws.
  sweepStaleWorkerScratch({ maxAgeMs: DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS });
}

/** Summary of what a start-of-run prune reclaimed (ledgered for provenance). */
export interface PruneSummary {
  worktrees: string[];
  branches: string[];
  /** Worktrees deliberately LEFT because a live run owns them (liveness guard). */
  skipped: string[];
  /** W1-T1036: the `.git/config.lock` path reclaimed this pass, or `null` if none was
   *  stale (or none existed) by the predicate in {@link isConfigLockStale}. */
  configLock: string | null;
}

/**
 * The liveness token a run writes beside its worktree so a concurrent prune knows
 * the worktree is ALIVE, not debris. Stored as a SIBLING file (`<worktree>.lock`),
 * never inside the worktree working tree — otherwise a worker's `git add -A` could
 * commit it into the PR. See {@link pruneStaleRuns}.
 */
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
  // ATOMIC OVERWRITE (W1-T208): write to a sibling temp file, then rename() into place.
  // The prior direct writeFileSync(target) let a concurrent readRunLock() (pruneStaleRuns
  // runs in a DIFFERENT process, on its own schedule) observe a partially-written file —
  // JSON.parse then throws, and the old readRunLock caught that and returned null, the
  // exact same value "no lock at all" also produces. That misclassified a live, mid-write
  // run as abandoned debris, handing pruneStaleRuns a green light to --force remove its
  // worktree (the same class of bug DIAGNOSIS.md/drain-concurrency already called out for
  // the no-lock case). rename(2) atomically swaps the directory entry on a POSIX
  // filesystem, so a reader can only ever see the complete old content or the complete
  // new content — never a torn intermediate — which removes the ambiguity at its source
  // instead of trying to distinguish "torn" from "absent" after the fact. The temp name
  // embeds pid + timestamp so two writers racing on the same lock path never clobber each
  // other's in-flight temp file. Uses the default `fs` import (see the header comment on
  // that import) so the write is a live property lookup a test can spy on.
  const target = runLockPath(worktreePath);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
  fs.renameSync(tmp, target);
}

/**
 * The three, and only three, things reading a run.lock can honestly conclude (W1-T208).
 * `absent` (no file) is a DIFFERENT fact from `corrupt` (a file is there but did not
 * parse into a valid {@link RunLockInfo} — e.g. a reader caught a live writer mid
 * rename, or genuine on-disk corruption): one means the worktree is free, the other means
 * something is wrong and liveness cannot be determined. Collapsing both into the same
 * `null` (the pre-fix shape) let a corrupt lock read as silently idle. `live` means the
 * file parsed; whether that pid is still running is for the caller (isPidAlive) to check.
 */
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

/**
 * Parse `git worktree list --porcelain` once for every consumer that needs registered worktree
 * facts. Linked-worktree callers should reuse this rather than hand-spelling the porcelain scan.
 */
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

/**
 * Read the registered worktrees for `repoDir`. Best-effort: an unreadable git registry reports
 * an empty list, matching the reaper's existing fail-soft contract.
 */
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

/**
 * Grace window (ms) below which a LOCKLESS worktree is presumed to be a run that has
 * just `git worktree add`-ed but not yet written its {@link runLockPath} — the tiny
 * create-before-lock race. Callers pass this to protect that window; genuinely old
 * lockless debris (past the window) is still reaped.
 *
 * W1-T253 (P37 CONSUMERS): read from `plan/policy.yaml`'s `pruneGraceMs` (a POLICY value now,
 * never a source literal) via {@link loadDefaultPolicy} — a retune is a reviewed plan PR, not
 * a code edit. `loadDefaultPolicy` self-locates the policy file from its own install location
 * (never cwd), so this resolves identically regardless of which directory a caller runs from.
 */
export const DEFAULT_PRUNE_GRACE_MS = loadDefaultPolicy().values.pruneGraceMs;

export interface PruneOpts {
  /** Injectable liveness probe (tests). Defaults to {@link defaultIsPidAlive}. */
  isPidAlive?: (pid: number) => boolean;
  /** Protect lockless worktrees younger than this (create-before-lock race). Default 0. */
  graceMs?: number;
  /** Injectable clock for the age check (tests). Defaults to Date.now. */
  now?: () => number;
  /** W1-T1036: injectable {@link ConfigLockReclaimOpts} for the `.git/config.lock` rung
   *  below — tests drive age / the live-process probe / the ledger sink without a real
   *  `pgrep` or a real clock. */
  configLock?: ConfigLockReclaimOpts;
}

// ── Stale `.git/config.lock` reclaimer (W1-T1036) ──────────────────────────
//
// A `.git/config.lock` left behind by a killed process (rationale (1): an OOM-stalled VM)
// fails every subsequent `git worktree add` outright — that call writes
// `branch.<name>.remote`/`.merge` into `.git/config` (rationale (2)) — and the EXISTING
// widowed-lock pass in reapStaleWorktrees cannot see it: that pass enumerates the worktrees
// directory and asks "is the directory this lock is named after gone?", but a config lock
// lives in a different tree entirely and is paired with no directory at all (rationale (3)).
//
// This reclaimer plugs into pruneStaleRuns (below), the shared function every prune-then-add
// call site already runs immediately before worktreeAdd (design (v)) — so the fix reaches all
// of them without src/run-task.ts needing to declare or change anything.

/**
 * Grace window (ms) below which a zero-byte `.git/config.lock` is presumed to be a process
 * still between `open()` and `write()` — design (i).1. A `git config` write completes in
 * single-digit milliseconds, so this is orders of magnitude of headroom over the only
 * legitimate race, while remaining short enough that genuinely abandoned debris (the
 * OOM-killed process in rationale (1)) clears on the very next prune pass.
 */
export const DEFAULT_CONFIG_LOCK_GRACE_MS = 2000;

/** Path of the `.git/config.lock` for a repo checkout. */
export function configLockPath(repoDir: string): string {
  return join(repoDir, ".git", "config.lock");
}

/** The outcome of asking the OS "is any `git` process alive right now?" (design (i).2-3).
 *  `ran` distinguishes a probe that genuinely answered from one that could not — an ENOENT
 *  or any other unrunnable probe must be treated as NOT evidence of staleness (design (i).3),
 *  never conflated with `ran: true, alive: false`. */
export interface LiveGitProcessProbe {
  ran: boolean;
  alive: boolean;
}

/** The one syscall {@link defaultProbeLiveGitProcess} makes, injectable so a test can drive its
 *  three outcomes without a real subprocess (mirrors {@link ProcessStartTimeSyscalls} in
 *  fs-race-safe.ts, the same split for the same reason: the default wiring to a real syscall and
 *  the branch logic over its result are two different things to falsify). */
export interface PgrepSyscalls {
  execFileSync: typeof execFileSync;
}

const defaultPgrepSyscalls: PgrepSyscalls = { execFileSync };

/**
 * Real probe: `pgrep git` (design (i).2 — deliberately `pgrep`, not `lsof`; both are declared
 * in the image, and the coarser name-match answers "held" more often, which is the safe
 * direction per design (ii)). Reuses {@link pgrepFailureMeansZero} (deployer.ts) rather than
 * reinventing its exit-code table: `status === 1` is pgrep's own documented "no processes
 * matched" (a real, ran-to-completion zero); anything else — ENOENT (binary absent, rationale
 * (5)'s measured failure mode), a syntax error, a fatal error — means the read did not happen
 * and must NOT be read as "no git process".
 */
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
  /** Ledger sink (design (iv)) — called with the path and the authorising rung BEFORE the
   *  file is removed, never after. Default `console.error`. */
  ledger?: (message: string) => void;
  /** Injectable removal call (tests) — lets a test drive the race window between the
   *  staleness check and the removal itself (the lock vanishing or becoming unremovable in
   *  that gap) without needing a real second writer. Default {@link unlinkSync}. */
  unlink?: typeof unlinkSync;
}

/**
 * THE PREDICATE, AND IT FAILS CLOSED (design (i)). All three rungs must hold before a
 * `.git/config.lock` is considered reclaimable:
 *   1. AGE — older than `graceMs`.
 *   2. NO LIVE GIT PROCESS — the probe ran AND found none.
 *   3. THE PROBE RAN — an unrunnable probe is not evidence of staleness and KEEPS the lock.
 * THIS PREDICATE MAY NOT BE LOOSENED TOWARD RECLAMATION (design (ii)): clearing a live lock
 * lets two writers race and corrupts `.git/config`; keeping a dead one costs only minutes.
 */
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

/**
 * Reclaim a stale `.git/config.lock` for `repoDir` (design (i)-(iv)) — meant to run
 * immediately before the `git worktree add` that would otherwise fail on it (rationale (2)).
 *
 * `unlink`s, never truncates/overwrites (design (iii)): the observed artifact is mode
 * `-r--r--r--`, so an "open for write and truncate" reclaimer fails on the exact file this
 * function exists to clear, while removal succeeds under the DIRECTORY's own permission.
 *
 * Ledgers BEFORE removing, naming the path (design (iv)): nothing about a zero-byte file
 * tells a later reader what was removed or why, so an unledgered reclaim would be
 * indistinguishable from the corruption it exists to prevent.
 *
 * Best-effort and per-item guarded, like every other reclaim in this module: an absent,
 * unreadable, still-live, or already-vanished lock is left alone and reported `false`.
 */
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

/**
 * Reclaim leftovers from crashed prior runs so they cannot block this one.
 *
 * A run that dies without reaching its cleanup (WS-1: max-turns run died with the
 * worktree + branch still on disk) leaves a `run-*` worktree and local branch
 * behind. `git worktree add -b run-…` for a NEW run has a unique timestamp so it
 * never collides — but the debris accumulates and a stale branch name could later
 * clash. At run start we force-remove every DEAD `run-*` worktree, `git worktree prune`
 * the admin records, then delete every remaining local `run-*` branch. All
 * best-effort and per-item guarded: a repo with nothing to prune returns empties.
 * The caller's own about-to-be-created branch does not exist yet, so it is safe.
 *
 * LIVENESS GUARD (DIAGNOSIS.md, diag/drain-concurrency): this prune ORIGINALLY
 * force-removed ANY `run-*` worktree, an assumption valid ONLY under strictly
 * sequential execution. Under ANY overlap (two drains; a manual `run-task` beside a
 * drain) it became an active saboteur — it once `--force`-removed a LIVE worktree
 * mid-run and destroyed a successful 65-turn implement. We now SKIP any worktree
 * whose sibling {@link runLockPath} names a LIVE pid, and reap only genuinely dead
 * ones (no lock, or the lock's pid is dead). A live-pid worktree is NEVER removed.
 *
 * W1-T208: a CORRUPT lock (present but unparseable — e.g. a reader caught a live writer
 * mid-write) is treated the SAME as an ABSENT one here, never as proof of death: both go
 * through the age/grace guard below rather than an immediate force-remove. That is the
 * guard that makes a torn read survivable — it must keep applying to the corrupt case
 * exactly as it already did to the lockless case, unchanged by this fix.
 */
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

  // 0. W1-T1036: reclaim a stale .git/config.lock BEFORE anything below shells out to
  //    `git` against repoDir. Every call site's very next step after pruneStaleRuns is
  //    worktreeAdd, whose `git worktree add` writes into `.git/config` and fails outright
  //    on a held lock (rationale (2)) — this is the earliest point common to all of them
  //    (design (v)). Best-effort and fails closed: see reclaimStaleConfigLock's own doc.
  const reclaimedConfigLock = reclaimStaleConfigLock(repoDir, opts.configLock);
  const configLock = reclaimedConfigLock ? configLockPath(repoDir) : null;

  // 1. Force-remove any registered worktree whose path is under our worktrees
  //    root and whose branch is a run-* branch — UNLESS a live run owns it.
  for (const registered of listRegisteredWorktrees(repoDir)) {
    if (registered.branch) {
      const isRun = registered.branch.startsWith("run-");
      if (isRun && registered.path.startsWith(worktreesRoot)) {
        // LIVENESS GUARD: a worktree whose run.lock names a live pid is IN USE.
        // Never force-remove it — that is the bug that lost a 65-turn implement.
        const lockRead = readRunLock(registered.path);
        if (lockRead.kind === "live" && isPidAlive(lockRead.info.pid)) {
          skipped.push(registered.path);
          continue;
        }
        // AGE GUARD: a LOCKLESS ("absent") OR CORRUPT ("W1-T208: unparseable — may be a
        // live writer caught mid-write, not proof of death) worktree younger than graceMs
        // may be a run that just `git worktree add`-ed but has not yet written its
        // run.lock (the create race), or one whose lock a reader caught mid torn-write.
        // Protect either; only genuinely-old debris (or a definitively dead-pid lock) is
        // reaped. A "live" lock naming a dead pid skips this guard entirely below — that
        // pid cannot still be writing, so no grace period is owed to it.
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

// ── Worktree reaper (W1-T175) — closes pruneStaleRuns' coverage holes ─────
//
// pruneStaleRuns (above) is a real, working owner, but it only sees what it is
// TOLD to look at, and only at moments a run happens to start:
//   (1) it enumerates ONLY `git worktree list --porcelain` for ONE assumed
//       repoDir, so a directory git no longer registers is invisible to it;
//   (2) it fires exclusively at the START of a run — an idle fleet reaps
//       nothing, however long a crashed run's debris sits;
//   (3) its predicate requires a `run-*` BRANCH, so a `sweep-*` worktree
//       interrupted before `checkout -B` (still on a detached HEAD) is
//       permanently orphaned, and a widowed `.lock` whose worktree dir is
//       already gone is never swept (removeRunLock only runs INSIDE a
//       successful removal).
// reapStaleWorktrees closes all three: it enumerates the DIRECTORY itself
// (never git's registry) and resolves each entry's parent repo from its OWN
// `.git` gitdir pointer — never a fixed/assumed repoDir, which matters on a
// host with more than one checkout of the same project. It is intentionally
// MORE conservative than pruneStaleRuns: every path that is not a definitely-
// alive pid still goes through the age gate (pruneStaleRuns lets a
// definitively-dead pid skip that grace; this reaper does not need that
// nuance — it runs on a cadence, not to urgently reclaim a name collision at
// run start), so a wrong reap here would take strictly longer to happen.

/**
 * The CADENCE reaper's own age ceiling (W1-T378) — see plan/policy.yaml's `worktreeReapGraceMs`
 * for the measurement behind the number. Deliberately NOT {@link DEFAULT_PRUNE_GRACE_MS}: that
 * one is consumed by six `pruneStaleRuns` call sites at RUN START, where a longer value delays
 * reclaiming a colliding worktree name; this reaper runs on a cadence with no such urgency.
 */
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
  /** Recent file activity somewhere in the tree — the W1-T378 gate. */
  | "recent-activity"
  /** The activity probe could not complete (unreadable, or past the entry cap), so liveness is
   *  UNKNOWN and the entry is kept. An ambiguous signal keeps; it never destroys. */
  | "activity-unknown"
  /** Removal itself failed — best-effort, the rest of the pass continues. */
  | "removal-failed"
  /** The entry's own `.git` is present but could not be read or parsed, so whether an admin
   *  record exists in some parent clone is UNKNOWABLE. An ambiguous signal keeps; it never
   *  destroys — the same doctrine `activity-unknown` applies one gate above. See
   *  {@link planWorktreeRemoval}. */
  | "git-unreadable";

/**
 * The newest mtime anywhere under `dir`, and whether the walk could be trusted (W1-T378).
 *
 * WHY THIS EXISTS. `reapStaleWorktrees` age-gated on `statSync(worktreeRoot).mtimeMs`, and a
 * DIRECTORY's mtime advances only when an entry is added to or removed from THAT directory —
 * never when a file nested inside it is modified. A worker editing `src/lib/feedback.ts` touches
 * `src/lib/`'s mtime, not the root's; `git commit` in a linked worktree writes to
 * `<parent>/.git/worktrees/<name>/index`, outside the tree entirely. So the root's mtime was
 * effectively FROZEN AT CHECKOUT and the age gate degraded to "reap unconditionally".
 * MEASURED CONSEQUENCE (2026-08-05, W1-T350): a run that was actively committing had its worktree
 * destroyed 40 minutes in; it stayed alive another 51 minutes but lost its ledger identity, and the
 * task re-dispatched and rebuilt itself (see W1-T377 for the other half of that incident).
 *
 * BOUNDED, because this runs per candidate on every cadence pass: `.git` and `node_modules` are
 * never descended into ({@link ACTIVITY_SKIP_DIRS}) — `.git` churns for reasons unrelated to the
 * worker and `node_modules` is a symlink to the shared canonical tree on this host — and the walk
 * stops after {@link ACTIVITY_WALK_ENTRY_CAP} entries.
 *
 * `complete: false` means DO NOT TRUST `mtimeMs`: either the walk hit the cap (so the max is
 * partial and could be older than the true newest) or a read failed. Callers must treat that as
 * unknown-and-keep, never as "old enough to reap" — a partial max is exactly the value that would
 * destroy live work.
 */
export function newestActivityMs(
  dir: string,
  opts: { entryCap?: number; skipDirs?: ReadonlySet<string> } = {},
): { mtimeMs: number; complete: boolean } {
  const entryCap = opts.entryCap ?? ACTIVITY_WALK_ENTRY_CAP;
  const skipDirs = opts.skipDirs ?? ACTIVITY_SKIP_DIRS;
  // THE ROOT'S OWN MTIME IS THE FLOOR, not a starting zero. An entry that was just created and is
  // still EMPTY (a `git worktree add` caught mid-flight, or a lockless `sweep-*` dir whose lock is
  // a SIBLING outside it) has nothing to walk, and a zero floor would read as maximally ancient —
  // reaping the exact create-before-lock race the age gate exists to protect. Measured: this is
  // what broke prune-liveness's "PROTECTS a git-invisible, dead-pid directory within the age gate".
  let newest: number;
  try {
    newest = statSync(dir).mtimeMs;
  } catch (e) {
    // GONE is not UNREADABLE. A dir that vanished mid-pass (a registration lookup removing it as a
    // side effect) has nothing left to protect, so it stays reapable — `complete: true` with age 0.
    // Any OTHER failure (permissions, I/O) is genuinely unknown and must keep.
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
  /** Worktree directories force-removed (git-invisible, detached-HEAD orphan, or a
   *  registered branch confirmed merged/deleted upstream — always past the age gate). */
  reaped: string[];
  /** Widowed `<name>.lock` AND `<name>.base` files removed because `<name>/` no longer
   *  exists (W1-T2628 widened this sweep from `.lock`-only to include `.base`). */
  reapedLocks: string[];
  /** Entries deliberately left: a live pid, a branch still live upstream, or too young. */
  kept: string[];
  /**
   * W1-T378: the SAME entries as {@link WorktreeReapSummary.kept}, each paired with the reason it
   * survived, so a pass that keeps everything is diagnosable instead of silent — and so the
   * `activity-unknown` keeps (the ones that bound disk growth) are visible to an operator.
   * OPTIONAL so callers holding a `{ reaped: [], reapedLocks: [], kept: [] }` literal keep
   * typechecking; {@link reapStaleWorktrees} always populates it.
   */
  keptReasons?: Array<{ name: string; reason: WorktreeKeepReason }>;
}

export interface WorktreeReapOpts {
  /** Injectable liveness probe (tests). Defaults to {@link defaultIsPidAlive}, called as
   *  `isPidAlive(lockRead.info.pid, lockRead.info)` — the second, RunLockInfo argument is
   *  new (W1-T406) and exists so a caller can supply a start-time-aware predicate (see
   *  {@link worktreeLockIsPidAlive}) without reapStaleWorktrees having to know anything
   *  about pid reuse itself. {@link defaultIsPidAlive} ignores the extra argument. */
  isPidAlive?: (pid: number, info: RunLockInfo) => boolean;
  /** Age ceiling (ms) below which a terminal-looking entry is still protected — the
   * same create-before-lock / branch-not-yet-pushed race {@link DEFAULT_PRUNE_GRACE_MS}
   * protects against in pruneStaleRuns. Default {@link DEFAULT_WORKTREE_REAP_GRACE_MS}
   * (W1-T378 — this reaper's OWN ceiling, no longer pruneGraceMs). */
  maxAgeMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Whether `branch` (in `repoDir`) is still live upstream — true means KEEP, fail
   * closed. Defaults to {@link defaultBranchIsLiveUpstream} (an `origin` ls-remote). */
  branchIsLiveUpstream?: (branch: string, repoDir: string) => boolean;
  /**
   * W1-T378: the tree-activity probe the age gate measures against. Injectable so a test can
   * assert the boundary without constructing a deep fixture for every case. Defaults to
   * {@link newestActivityMs} — the REAL bounded walk, which the fixture-free tests drive.
   */
  newestActivity?: (dir: string) => { mtimeMs: number; complete: boolean };
  /**
   * W1-T406: SURVEY ONLY when true — an entry that would be reaped is still recorded in the
   * returned `reaped`/`reapedLocks` (so a caller can ledger exactly what it would reclaim),
   * but nothing is actually removed from disk. Mirrors {@link reapStaleClones}'s own `dryRun`
   * shape. Default false, unchanged for every existing caller (the daemon poll hook and
   * `rmd sweep`, via {@link runWorktreeReapRung}, never pass this).
   */
  dryRun?: boolean;
}

/**
 * A {@link WorktreeReapOpts.isPidAlive}-shaped predicate for the W1-T406 ONE-SHOT CONTAINER
 * boot rung: answers "is THIS the same process that wrote the lock", not merely "does some
 * process hold this pid right now". {@link defaultIsPidAlive} (drain-lock.ts, `process.kill(pid,
 * 0)`) answers only the second question — it reads this container's OWN pid namespace, which
 * restarts at 1 on every `docker run`. A lock written by a previous boot naming a low pid
 * therefore very often finds that number ALIVE as an entirely unrelated process, and
 * reapStaleWorktrees then takes the live-pid keep branch and never reaps it — PERMANENT
 * NON-RECLAMATION, the shape of the 3.0 GB this task was filed against, not destruction.
 *
 * Reuses {@link isHolderStale} (fs-race-safe.ts, W1-T396/W1-T368) exactly as written rather
 * than reinventing its rung-3 start-time comparison — `pid`/`startedAt` structurally satisfy
 * {@link HolderIdentity} with no `host` key at all, so isHolderStale's host rung (rung 1) is
 * skipped by construction; there is nothing for it to read. `RunLockInfo` deliberately gains
 * no `host` field to make that rung reachable — see this task's plan shard for why that would
 * import the exact hazard (a container's hostname changing every boot) this predicate exists
 * to avoid.
 *
 * `deps` is injectable (tests only — appended LAST, defaulting to the real syscalls) so the
 * pid-reuse scenario itself — a live pid whose ACTUAL start time is after the lock's recorded
 * `startedAt` — is drivable without a real process wrapping a real pid number.
 */
export function worktreeLockIsPidAlive(
  pid: number,
  info: RunLockInfo,
  deps: Partial<IsHolderStaleOpts> = {},
): boolean {
  return !isHolderStale({ pid, startedAt: info.startedAt }, { isPidAlive: defaultIsPidAlive, ...deps });
}

/**
 * Resolve a linked worktree's parent repoDir from its OWN `.git` gitdir pointer file
 * — `gitdir: <repoDir>/.git/worktrees/<name>` — rather than assuming a fixed repoDir.
 * Returns null when `entryPath` is not a linked git worktree at all (no `.git` file,
 * or it does not parse): exactly the shape hole (1) exists to cover — debris that
 * never was, or no longer is, a registered worktree.
 */
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
  /** undefined when registered but on a DETACHED HEAD — hole (3): a `sweep-*` dir
   *  interrupted before `checkout -B` never gets a branch to check upstream. */
  branch?: string;
}

/**
 * Cross-reference `entryPath` against `git worktree list --porcelain` for its OWN
 * resolved repoDir (never a fixed/assumed one — the multi-checkout lesson from this
 * task's fixture forensics). Returns null when git does not register this path at
 * all under that repo, which this function treats identically to "not a worktree" —
 * both are hole (1) debris with no branch to consult.
 */
function resolveWorktreeRegistration(entryPath: string): WorktreeRegistration | null {
  const repoDir = resolveWorktreeRepoDir(entryPath);
  if (!repoDir) return null;
  const found = listRegisteredWorktrees(repoDir).find((entry) => entry.path === entryPath);
  return found ? { repoDir, branch: found.branch } : null;
}

/**
 * HOW an aged, terminal reap candidate must be REMOVED — never WHETHER it should be, which
 * every gate above this decides and this function deliberately does not revisit.
 *
 * `git-remove` deletes the working tree AND its admin record in one operation, in the parent.
 * `rm-only` deletes the tree directly, and carries the parent (when one exists) so the caller
 * can `git worktree prune` behind it. `keep` destroys nothing.
 */
export type WorktreeRemovalPlan =
  | { kind: "git-remove"; repoDir: string }
  | { kind: "rm-only"; repoDir?: string }
  | { kind: "keep" };

/**
 * Decide {@link WorktreeRemovalPlan} for `entryPath` from its OWN `.git`, BEFORE anything is
 * destroyed.
 *
 * WHY THIS EXISTS (the 2026-07-31 destruction, CLAUDE.md "Never do interactive work inside
 * `<config.root>/worktrees`"). `reapStaleWorktrees` removed every candidate with a bare
 * `fs.rmSync`. Everything under {@link worktreesDir} is a LINKED worktree — {@link worktreeAdd}
 * is what puts it there — and a linked worktree's admin record lives in the PARENT clone at
 * `<repoDir>/.git/worktrees/<name>`. `rm -rf` on one deletes the tree and STRANDS that record:
 * `git worktree list` reports it `prunable`, and git still refuses to re-check-out the branch
 * (`fatal: '<branch>' is already used by worktree at <path>`) on the next run that mints the same
 * name. `lib/clone-reaper.ts`'s own header cites this same failure as its reason for touching
 * nothing whose `.git` is not a DIRECTORY; this function is the other half of that lesson —
 * the reaper that DOES own linked worktrees, removing them through git instead of around it.
 *
 * THE CASES, and why each primitive is the correct one rather than a fallback:
 *
 *   `.git` ABSENT — not a worktree at all: hole (1) debris, or a tree something else already
 *     removed mid-pass. No record anywhere points at it, so `rmSync` strands nothing. `rm-only`.
 *
 *   `.git` is a DIRECTORY — a STANDALONE clone. It owns its objects and its admin dir outright,
 *     so removing the tree removes every record with it. `rm-only`.
 *
 *   `.git` is a FILE and the resolved parent REGISTERS this path — the real linked case, and the
 *     only one that can strand anything. `git-remove`: `git worktree remove --force` in that
 *     parent, the same primitive {@link pruneStaleRuns} already uses.
 *
 *   `.git` is a FILE, the parent exists, but does NOT register this path — the record is already
 *     gone (a parent that pruned it, or a tree that was never registered there). There is nothing
 *     left to strand, so `rmSync` is CORRECT here, not a concession; the `repoDir` rides along so
 *     the caller can prune behind it anyway, which is idempotent and collects any record this
 *     lookup could not see.
 *
 *   `.git` is a FILE and the parent is ABSENT — the parent clone is gone, so no admin record can
 *     exist to be stranded and no `git worktree remove` is even possible. `rmSync` is the only
 *     primitive left AND is safe for exactly that reason. (This is the shape 52 of the 54
 *     directories measured in `$HOME` on 2026-09-04 had: linked worktrees outliving their parent.)
 *
 *   `.git` is UNREADABLE or UNPARSEABLE — whether a record exists is UNKNOWABLE, so this KEEPS.
 *     An ambiguous signal never destroys; that is the same direction `activity-unknown` already
 *     fails one gate above, and the direction the 2026-07-31 incident was decided in the wrong
 *     one. A kept directory costs disk; a wrongly removed one costs work.
 *
 * `registration` is the caller's ALREADY-COMPUTED {@link resolveWorktreeRegistration} result —
 * threaded in rather than re-derived so this decision cannot disagree with the `live-branch`
 * gate that read the same lookup, and so the reaper still shells `git worktree list` exactly once
 * per entry.
 */
export function planWorktreeRemoval(
  entryPath: string,
  registration: WorktreeRegistration | null,
  fsImpl: Pick<typeof fs, "lstatSync" | "existsSync"> = fs,
): WorktreeRemovalPlan {
  // The parent already told us it registers this path — that IS the linked case, and no
  // re-reading of `.git` can contradict a lookup that just succeeded against the real repo.
  if (registration) return { kind: "git-remove", repoDir: registration.repoDir };

  let gitStat: { isDirectory(): boolean };
  try {
    gitStat = fsImpl.lstatSync(join(entryPath, ".git"));
  } catch (e) {
    // ENOENT is "not a worktree" — reapable, and the ONLY error shape that is. Anything else
    // (EACCES, EIO, a `.git` we can see but not stat) leaves the question open, so it keeps.
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "rm-only" } : { kind: "keep" };
  }
  if (gitStat.isDirectory()) return { kind: "rm-only" }; // standalone clone — owns its own records

  const repoDir = resolveWorktreeRepoDir(entryPath);
  if (!repoDir) return { kind: "keep" }; // a `.git` FILE we could not read or parse — unknowable
  // Parsed, but the parent is gone: nothing can hold a record for this tree, so `rmSync` is the
  // only primitive left and is safe precisely because the parent is confirmed absent.
  if (!fsImpl.existsSync(repoDir)) return { kind: "rm-only" };
  // Parent present but not registering this path — the record is already gone. Prune behind the
  // removal anyway; it is idempotent and collects anything the registration lookup missed.
  return { kind: "rm-only", repoDir };
}

/**
 * Execute a {@link planWorktreeRemoval} decision. Throws on failure so the reaper's own
 * per-entry try/catch records `removal-failed` and the pass continues — the same best-effort
 * shape every other removal in this file already has.
 *
 * `--force` is deliberate and is what keeps this a DEFECT FIX rather than a selection change:
 * plain `git worktree remove` refuses on a tree with modified OR untracked files (measured:
 * `fatal: '<path>' contains modified or untracked files, use --force to delete it`), and a stale
 * run worktree nearly always carries untracked build output — so omitting `--force` would keep
 * almost everything and silently disable the W1-T175 reaper. Today's `rmSync` already removes
 * these trees unconditionally; `--force` reproduces exactly that set while adding the admin-record
 * cleanup. WHETHER a dirty tree deserves protection is a SELECTION question, owned by the
 * liveness/age gates above, and is not reopened here.
 */
function executeWorktreeRemoval(
  entryPath: string,
  // `keep` is excluded at the type level, not merely by convention: the caller must have already
  // acted on it (by keeping the entry) before anything here could destroy something.
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
    // Best-effort, and never a reason to report the removal itself as failed: the tree IS gone,
    // and `prune` is level-triggered — the next pass (or pruneStaleRuns) collects the record.
  }
}

/**
 * Default {@link WorktreeReapOpts.branchIsLiveUpstream}: does `branch` still exist on
 * `origin`? Mirrors the fixture forensics' own check (`gh api .../branches/<b>` => 404
 * ⇒ deleted upstream) with plain git plumbing. FAIL CLOSED on anything ambiguous — a
 * network hiccup or an unexpected exit code is reported as "still live", never as
 * grounds to reap; only git's own not-found signal (exit 2) says the branch is gone.
 */
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

/**
 * Cadence reaper for `root` (pass {@link worktreesDir}(config)) — the backstop for
 * pruneStaleRuns' three coverage holes (see the block comment above). Fail-closed
 * throughout: a live pid is NEVER reaped; a branch still live upstream is NEVER
 * reaped, however old; everything else is reaped only once past `maxAgeMs`. A
 * per-entry failure (a removal hiccup, an unreadable entry) is best-effort and
 * never blocks the rest of the pass — mirrors pruneStaleRuns' own per-item guards.
 *
 * HOW an entry is removed is a separate decision from WHETHER, and lives in
 * {@link planWorktreeRemoval}: a LINKED worktree (which is what {@link worktreeAdd} puts under
 * {@link worktreesDir}) dies through `git worktree remove --force` in its own parent, so its
 * admin record dies with it. A bare `rmSync` here is what stranded records as `prunable` and
 * left git refusing the branch — the 2026-07-31 destruction CLAUDE.md records.
 */
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
    // W1-T381: the lock's OWN pid, confirmed dead by the same predicate the live-pid guard above
    // just used, is stronger evidence than anything the activity probe below can produce — an
    // mtime records THAT a write happened, never WHO made it, so it cannot vouch for a run whose
    // own lock says it is over. Reused, not reinvented: `!isPidAlive(pid)` is the same staleness
    // shape as drain-lock.ts's `reclaimStaleLock` (`isStale: (held) => !isAlive(held.pid)`).
    const lockNamesDeadPid = lockRead.kind === "live" && !isPidAlive(lockRead.info.pid, lockRead.info);

    // Not a live-pid worktree. A registered branch still live upstream (an open,
    // unmerged PR) is fail-closed KEPT regardless of age — the sweep-W1-T154
    // falsifier: a sweep-* dir writes no lock at all, so lock state alone cannot
    // tell it apart from genuine debris; only the branch/PR signal can.
    const registration = resolveWorktreeRegistration(entryPath);
    if (registration?.branch && branchIsLiveUpstream(registration.branch, registration.repoDir)) {
      keep(name, "live-branch");
      continue;
    }

    // Terminal by every available signal: no live pid, and either git no longer
    // registers this directory at all (hole 1), it is registered but on a detached
    // HEAD with no branch to check (hole 3), or its branch is confirmed
    // merged-or-deleted upstream. Age-gate before acting on any of them.
    // AGE GATE, W1-T378: measured against the newest mtime ANYWHERE IN THE TREE, not the root
    // directory's own — see {@link newestActivityMs} for why the root's is frozen at checkout and
    // what that cost. An INCOMPLETE probe means liveness is unknown, and an ambiguous signal keeps
    // — that holds regardless of `lockNamesDeadPid`: "unknown" and "confirmed dead" are different
    // questions, and only the latter overrides the rescue below (W1-T381).
    const activity = newestActivity(entryPath);
    if (!activity.complete) {
      keep(name, "activity-unknown");
      continue;
    }
    // W1-T381: recent activity may rescue a tree whose lock is ABSENT or names a LIVE pid — never
    // one whose own lock names a pid already confirmed dead above. This only ever WITHDRAWS a
    // rescue the guard below would otherwise have granted; it grants none, so it cannot newly reap
    // a tree whose run is alive (that run already holds a live-pid lock and was kept above).
    if (!lockNamesDeadPid && now() - activity.mtimeMs < maxAgeMs) {
      keep(name, "recent-activity");
      continue;
    }
    // HOW to remove it, decided BEFORE anything is destroyed — a linked worktree must die through
    // its parent (`git worktree remove`), or its admin record is stranded `prunable` and git keeps
    // refusing the branch. See {@link planWorktreeRemoval} for all five cases and the 2026-07-31
    // destruction that motivates them. `registration` is the lookup the live-branch gate above
    // already made, threaded in rather than re-derived.
    const removalPlan = planWorktreeRemoval(entryPath, registration);
    if (removalPlan.kind === "keep") {
      keep(name, "git-unreadable"); // unknowable `.git` — the ambiguous signal keeps, as always
      continue;
    }
    try {
      if (!dryRun) {
        executeWorktreeRemoval(entryPath, removalPlan);
        removeRunLock(entryPath); // clear the sibling lock so it can't linger widowed
        // MERGE RESOLUTION (W1-T406 × W1-T405): main added this base-record cleanup while this
        // branch added the `dryRun` guard. It belongs INSIDE the guard — the base record is a
        // sibling FILE on disk, so removing it during a survey would be destroying state while
        // claiming to only look. One orphan per reap otherwise.
        removeWorktreeBase(entryPath);
      }
      reaped.push(name); // SURVEY (dryRun) or real removal — either way this is what qualified
    } catch {
      keep(name, "removal-failed"); // best-effort: a removal hiccup never blocks the rest of the pass
    }
  }

  // Widowed `.lock`/`.base` siblings whose worktree dir is already gone (hole 3):
  // removeRunLock/removeWorktreeBase only ever fire INSIDE a successful removal
  // (worktreeRemove, pruneStaleRuns, or the reap above), so a sibling orphaned by any
  // OTHER path — e.g. a manual `rm -rf` of the worktree dir — lingers forever: a `.lock`
  // makes a dead run read as live to anything that trusts it, and a `.base` accumulates
  // without bound (W1-T2628 — pruneStaleRuns is one such other path, now closed above,
  // but this sweep still owes any widow left by causes this file cannot enumerate). No
  // age gate is owed here: the owning directory is already gone, so nothing in flight
  // can be harmed.
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

/**
 * The W1-T175 worktree-reap RUNG: resolve `config`'s worktreesDir, run
 * {@link reapStaleWorktrees} against it, and best-effort-ledger the outcome via `log`. Shared by
 * `rmd sweep` (sweepCommand) and the daemon's own per-poll hook (buildSweepHook) so both run the
 * EXACT same rung on the EXACT same cadence-doctrine — pulled out to one place after the first
 * draft duplicated this try/catch verbatim at both call sites (a duplicate-drift risk the two
 * rungs' own doc comments already warned about). The try/catch here guards ONLY
 * `worktreesDir(config)` itself (a malformed `config.root` throws from `path.join`) —
 * {@link reapStaleWorktrees} is fail-closed internally and never throws under default opts — so
 * a reap-rung failure never masks, or is masked by, the caller's OWN error handling.
 */
export function runWorktreeReapRung(
  config: Config,
  log: (step: string, extra?: Record<string, unknown>) => void,
): WorktreeReapSummary {
  let reapSummary: WorktreeReapSummary = { reaped: [], reapedLocks: [], kept: [] };
  try {
    reapSummary = reapStaleWorktrees(worktreesDir(config));
    if (reapSummary.reaped.length || reapSummary.reapedLocks.length) log("worktree.reaped", { ...reapSummary });
    // W1-T378: an `activity-unknown` keep is the one outcome that needs its own row. It is the
    // reaper declining to decide, and it is what bounds disk growth now that an ambiguous signal
    // keeps rather than destroys — so a tree that can never be probed would otherwise accumulate
    // silently, which is exactly the invisible-leak shape W1-T175 was filed against. Logged even
    // when nothing was reaped (the pass above stays quiet in that case), and NOT logged for the
    // ordinary live-pid/live-branch/recent-activity keeps, which are the reaper working correctly.
    const undecidable = (reapSummary.keptReasons ?? []).filter((k) => k.reason === "activity-unknown");
    if (undecidable.length) log("worktree.reap.undecidable", { kept: undecidable.map((k) => k.name) });
  } catch (e) {
    log("worktree.reap.error", { error: String((e as Error)?.message ?? e) });
  }
  return reapSummary;
}

// ── gh helpers (run outside the sandbox; TLS fails under Seatbelt) ─────────

/**
 * `gh`'s `X-Ratelimit-*` response headers, parsed off the SAME response the metered call itself
 * carried (W1-T525 design (iii)) — never a separate `gh api rate_limit` probe. That probe is
 * FREE (measured: ten such calls moved `used` by 4 while ten real calls moved it by 23) which is
 * exactly what makes it tempting, but it answers about a DIFFERENT bucket with a DIFFERENT reset
 * — measured back to back, an ordinary `gh api repos/…` call carried remaining=3259 while `gh api
 * rate_limit` in the same window reported remaining=4960. A floor read from the probe would be
 * wrong by the gap between those two numbers. All fields are `undefined` when the header was
 * absent, which is every `gh` invocation this file issues that is not `gh api …` — `pr view`,
 * `pr list`, etc. are answered over GraphQL internally and carry no REST rate-limit header for
 * the CLI to expose.
 */
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

/**
 * Parse `X-Ratelimit-Remaining`/`-Used`/`-Limit`/`-Reset`/`-Resource` off ONE response's raw
 * header block. This is the ONLY place in this file that reads these headers — see {@link ghJson}
 * for the single call site that supplies the block.
 */
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

/**
 * W1-T1235 — sentinel recorded for a bucket or reset that could not be READ, never one that was
 * merely inconvenient to look up: an unreadable reset must be recorded as unknown rather than
 * given an invented wait (design (ii)/(iii) of this task — the exact discipline
 * `defaultGhRetryAfterSeconds` (lib/open-prs-rest.ts) already applies to its own `undefined`
 * return). Shared by every consumer of {@link GhRateLimitRefusal} — the auto-merge arm's own row
 * and `rmd status`'s GitHub-buckets section both render "no reading" identically, rather than
 * each inventing its own ad hoc placeholder string.
 */
export const GH_RATE_LIMIT_BUCKET_UNKNOWN = "unknown";

/**
 * W1-T1235 — one GitHub quota bucket's REFUSAL, ready to ledger. `bucket` and `resetsAt` are
 * {@link GH_RATE_LIMIT_BUCKET_UNKNOWN} when there was no header to read them from — never a
 * guess — see {@link ghRateLimitRefusalFromReading}/{@link ghRateLimitRefusalUnknown}.
 */
export interface GhRateLimitRefusal {
  /** `X-Ratelimit-Resource` (e.g. `"core"`, `"graphql"`) — read off the response's OWN field,
   *  never inferred from which `gh` subcommand or operation was refused. */
  bucket: string;
  /** ISO-8601, converted from the header's Unix-epoch-seconds `X-Ratelimit-Reset`. */
  resetsAt: string;
  /** What was refused — free text a caller supplies for the ledger row / console line. */
  operation: string;
}

/**
 * W1-T1235 — THE ONE PLACE a {@link GhRateLimitReading} becomes a refusal record.
 *
 * `remaining === 0` is the ONLY evidence this treats as an actual refusal: a reading with
 * `remaining` merely low, or entirely absent (every non-`gh api` call {@link ghJson} issues —
 * see that function's own doc), returns `undefined` rather than a manufactured refusal, so a
 * call that was never rate limited produces no row (design (iv); this is what keeps ordinary
 * traffic from ever seeding a false refusal).
 *
 * `bucket` is read off `reading.resource` ALONE, `resetsAt` off `reading.reset` ALONE — either
 * missing renders {@link GH_RATE_LIMIT_BUCKET_UNKNOWN}, never inferred from `operation` and
 * never invented. This is what makes the bucket this function names provably the response's
 * OWN field rather than a guess keyed on which caller happened to be refused.
 */
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

/**
 * W1-T1235 — the auto-merge arm's OWN shape: `gh pr merge --auto` is `execFileSync`'d directly
 * (run-task.ts's `ArmDeps.armAuto`), never through {@link ghJson}, so no header block ever
 * reaches this file for it — see {@link ghJson}'s own doc, above, "captures stderr TEXT, never
 * headers". A refusal recognisably rate-limit-SHAPED by its stderr text (run-task.ts's own
 * narrow `armFailureIsRateLimited` classifier) is still worth NAMING as one — design (ii)'s
 * second acceptable option — rather than folding silently into the same undifferentiated
 * `arm-error-ignored` bucket every other permanent refusal already falls into.
 *
 * Both fields are {@link GH_RATE_LIMIT_BUCKET_UNKNOWN}: this is called ONLY when there is no
 * header to read, so hardcoding `"graphql"` here — however true structurally (the arm has no
 * REST form at all) — would be exactly the by-caller inference {@link ghRateLimitRefusalFromReading}'s
 * own doc forbids for a refusal record. Honest-unknown, not a guess.
 */
export function ghRateLimitRefusalUnknown(operation: string): GhRateLimitRefusal {
  return { bucket: GH_RATE_LIMIT_BUCKET_UNKNOWN, resetsAt: GH_RATE_LIMIT_BUCKET_UNKNOWN, operation };
}

/**
 * Split `gh api -i`'s combined stdout into its HTTP header block and its JSON body — mirroring
 * curl's `-i`: a status line, the response headers (CRLF-terminated, per measurement), one blank
 * line, then the body. Anything that does not start with an HTTP status line (every `gh`
 * invocation this file issues that is not `gh api …`, which never receives `-i` — see
 * {@link ghJson}) is returned whole as `body` with an empty `headers` block, so a caller with no
 * reading to parse can never mis-split real JSON.
 */
export function splitGhHeaderBlock(out: string): { headers: string; body: string } {
  if (!out.startsWith("HTTP/")) return { headers: "", body: out };
  const sep = out.match(/\r?\n\r?\n/);
  if (!sep || sep.index === undefined) return { headers: "", body: out };
  return { headers: out.slice(0, sep.index), body: out.slice(sep.index + sep[0].length) };
}

/**
 * Shared `gh ... --json` invocation + parse, used by ~13 call sites across run-task.ts (mostly
 * single-PR `pr view` reads, O(1) regardless of repo size). W1-T181's sibling-audit named exactly
 * ONE of those callers as repo-size-SCALING: run-task.ts's `buildOpenPrViews` (`pr list --state
 * open --limit 100 --json ...,body,...,statusCheckRollup`) — up to 100 open PRs' full bodies +
 * check rollups in one payload, the same shape (body-heavy, N-PRs-wide) that crossed Node's 1 MiB
 * `execFileSync` default and caused status.ts's batched-board-gateway outage. `maxBuffer` is
 * therefore set here, on the ONE shared codepath, rather than duplicated per call site — it is
 * strictly headroom (`1 << 24` = 16 MiB, the orientation.ts:72 in-repo precedent) for every other
 * O(1) caller, since a larger ceiling costs nothing unless it is actually approached.
 *
 * W1-T525: THE METERED ENTRY POINT — the single place a `gh` invocation is issued AND observed.
 * For a `gh api …` call this now passes `-i`/`--include` (today ZERO sites do — the rationale's
 * "NOTHING READS THE HEADER, AND NOTHING EVEN RECEIVES IT"), splits the response into its header
 * block and body, parses the rate-limit reading off THAT header block, and — when `onRateLimit`
 * is supplied — hands the reading back before returning, so a caller can feed it to
 * `GhCallPacer.recordResult` (lib/open-prs-rest.ts) and widen pacing proactively, before any call
 * has failed (design ii). `-i` is added ONLY for `gh api` calls: it is not a flag `gh pr
 * view`/`gh pr list`/etc. accept (confirmed against `gh`'s own `--help`), and those subcommands
 * are answered over GraphQL internally, so they carry no REST rate-limit header to read either
 * way. The parsed body returned is byte-for-byte what `JSON.parse(out)` returned before this
 * change, and `onRateLimit` is optional — every existing call site (all 11 today) omits it and is
 * therefore unaffected: this changes no caller's contract.
 *
 * `exec` is injectable (mirrors `GhApiFetcher`/`ghGateway`'s own `opts.exec` seam elsewhere in
 * this codebase) purely so this metered entry point itself is testable with zero network and no
 * real `gh` binary — this leaf previously had no test driving it at all. Every real caller omits
 * it and gets the genuine `execFileSync`.
 */
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
  // W1-T1050: NO `--delete-branch`. `gh pr merge --help` documents the flag as deleting the
  // LOCAL branch too, which needs a resolvable current branch — a caller running from the
  // daemon's deliberately detached checkout (the self-sync guard depends on that) has none, so
  // the call failed "not on any branch" even when the merge itself landed. The repository
  // already carries `delete_branch_on_merge: true`, so the head branch is still deleted, just
  // server-side rather than by this local call.
  return execFileSync("gh", ["pr", "merge", prUrl, "--squash"], {
    encoding: "utf8",
  });
}
