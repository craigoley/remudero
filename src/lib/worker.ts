import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type Options, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, workerHomeDir, workerShell, workerZdotdir, type Config } from "./config.js";
import { detectCompactionEvents, isQualitySuspect, type CompactionEvent } from "./compaction.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, type IsHolderStaleOpts } from "./fs-race-safe.js";
import { buildWorkerEnv, billingMode, type BillingMode } from "./env.js";
import { loadDefaultPolicy } from "./policy.js";
import { assertLiveSpawnAllowed } from "./spawn-guard.js";
import { validateWorkerSettingsFile } from "./settings.js";
import { DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS, reapWorkerScratch, sweepStaleWorkerScratch } from "./worker-scratch.js";
import { assertLiveWriteAllowed } from "./live-write-guard.js";
import {
  assertWorkerCredentialFile,
  ensureWorkerKeychain,
  materializeWorkerHome,
  perRunWorkerHomeDir,
  reapWorkerHome,
  workerCredentialFilePath,
  workerKeychainPaths,
  type SecurityRunner,
  lostWorkerHomeGrants,
  type WorkerHomeGrantOutcome,
} from "./worker-home.js";
import {
  buildContainedSpawnFn,
  spawnDetachedGroup,
  teardownProcessGroup,
  withWorkerGroupTeardown,
  workerMarkerEnv,
  type ContainedProcess,
  type ContainedSpawnOptions,
} from "./worker-containment.js";

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
 */
export function workerLedgerFields(r: WorkerResult): {
  model: string;
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
  max_turns?: number;
  stderr_excerpt?: string;
  lost_grants?: string[];
  worker_duration_ms?: number;
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
    model: r.model,
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
    verdict: r.isError ? r.subtype : "success",
    quality_suspect: r.qualitySuspect,
    compaction_events: r.compactionEvents,
    // W1-T477: per-call wall-clock, mirrored verbatim off `WorkerResult.workerDurationMs` — see
    // that field's own doc. `undefined` (never a guessed 0) on a hand-built test fixture that
    // never went through a real spawn; JSON.stringify drops an undefined key, so an untimed call's
    // ledger line simply carries no `worker_duration_ms` key at all, the same "absent, never
    // guessed" discipline `max_turns` above already keeps.
    worker_duration_ms: r.workerDurationMs,
  };
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

/** One resolution attempt, kept for the refusal reason: which label, which
 * path, whether it existed, and whether it ran (only meaningful if it did). */
export interface SearchedClaudeCandidate {
  label: string;
  path: string;
  existed: boolean;
  ran: boolean;
}

/** `SearchedClaudeCandidate` -> its one-word outcome, for the refusal message. */
function describeSearched(s: SearchedClaudeCandidate): string {
  if (!s.existed) return "missing";
  return s.ran ? "ok" : "exists, --version failed";
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
  /** Does this path actually run? (`--version`, discarding output.) */
  canExecute?: (path: string) => boolean;
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

function defaultCanExecute(path: string): boolean {
  try {
    execFileSync(path, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
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
    const ran = existed && canExecute(path);
    searched.push({ label: candidate.label, path, existed, ran });
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

export interface SpawnWorkerArgs {
  cwd: string;
  permissionMode: PermissionMode;
  /** Path to the worker settings file (permissions + hooks + sandbox). */
  settingsFile: string;
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
}

/**
 * Spawn one headless Claude Code worker via the Agent SDK.
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
 *    preferring `args.runId` when supplied), materialized fresh and reaped in a
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

  const config = args.config ?? loadConfig();
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
  const workerHomeRoot = workerHomeDir(config);
  const workerHome = perRunWorkerHomeDir(workerHomeRoot, args.runId);
  const realHome = process.env.HOME ?? homedir();
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
      workerKeychainPath = ensureWorkerKeychain({
        ...workerKeychainPaths(join(config.root, "state")),
        loginKeychainPath: join(realHome, "Library", "Keychains", "login.keychain-db"),
        grantApps: workerKeychainGrantApps(claudeBin),
        runner: args.keychain?.runner,
        exists: args.keychain?.exists,
        accountId,
        priorSpawnCredentialExpired: args.keychain?.priorSpawnCredentialExpired,
      }).keychainPath;
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
    // caller has a legitimate reason to set REMUDERO_RUN_ID/TASK_ID itself).
    Object.assign(childEnv, workerMarkerEnv(args.runId, args.taskId));

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
    if (args.resumeSessionId) options.resume = args.resumeSessionId;
    if (args.model) options.model = args.model;
    if (args.effort) options.effort = args.effort as Options["effort"];
    if (typeof args.maxTurns === "number") options.maxTurns = args.maxTurns;
    if (typeof args.maxBudgetUsd === "number") options.maxBudgetUsd = args.maxBudgetUsd;
    if (args.tools) options.tools = args.tools;

    // impl-EM LIVE-SPAWN GUARD — the last statement before the SDK is invoked, and the SDK call is
    // what creates the paid worker. Everything above this line is local and free (config load, binary
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
    // branches behind.
    if (args.queryFn === undefined) {
      assertLiveSpawnAllowed(`spawnWorker for task ${args.taskId ?? "<no taskId>"}`);
    }
    const runQuery = args.queryFn ?? query;
    return await withWorkerGroupTeardown(
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
        }),
      teardownContained,
    );
  } finally {
    // W1-T170: reap THIS spawn's per-spawn home on every exit path, including a
    // thrown error (validate/toolchain/keychain failures above, or a transport
    // failure out of withWorkerGroupTeardown) — the same withTempDir discipline
    // (W1-T115/W1-T131) applied to a resource that must not accumulate across
    // concurrent or serial spawns. Guarded (never touches the singleton root or
    // anything outside its own sibling) and best-effort — see worker-home.ts.
    reapWorkerHome(workerHomeRoot, workerHome);
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
  let text = "";
  let subtype = "";
  let isError = false;
  let apiError = false;
  let permissionDenials: unknown[] = [];
  let sawResult = false;
  let tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let modelUsage: Record<string, ModelUsageEntry> = {};
  const compactionEvents: CompactionEvent[] = [];

  try {
    for await (const raw of messages) {
      const msg = raw as { type?: string; message?: unknown };
      if (msg.type === "system") {
        // MASTER-PLAN §8B / W1-T36: detect + ledger a compaction event LIVE,
        // off the SDK's own `compact_boundary` system message — reuses the
        // same detector a fixture-driven unit test exercises (compaction.ts),
        // so "detected in a test" and "detected live" can never drift apart.
        compactionEvents.push(...detectCompactionEvents([raw]));
      } else if (msg.type === "assistant") {
        // Anthropic-side api error mid-stream (server_error / <synthetic> model /
        // isApiErrorMessage). A TRANSIENT — the envelope may still report success.
        const rawAny = raw as { isApiErrorMessage?: boolean; error?: unknown };
        const model = (msg.message as { model?: string })?.model;
        if (rawAny.isApiErrorMessage === true || model === "<synthetic>") apiError = true;
        const content = (msg.message as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && (block as { type?: string }).type === "text") {
              blocks.push((block as { text: string }).text);
            }
          }
        }
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
    stderrChunks.push(
      `\n[collectWorkerResult] error-result throw swallowed: ${String((err as Error)?.message ?? err)}\n`,
    );
    isError = true;
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
    permissionDenials,
    childEnvKeys: opts.childEnvKeys,
    accountLabel: opts.accountLabel,
    model: opts.model ?? DEFAULT_MODEL_LABEL,
    effort: opts.effort ?? DEFAULT_EFFORT_LABEL,
    tokens,
    modelUsage,
    compactionEvents,
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

export type NodeModulesLinkOutcome = "linked" | "already-present" | "no-source" | "failed";

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
    return "linked";
  } catch {
    return "failed";
  }
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
 * PURE aside from the two injected callbacks — no git/network call of its own — so a test
 * drives every branch (stale / current / unreadable) without a second real remote.
 */
export function assertWorktreeBaseCurrent(
  base: string,
  ref: string,
  deps: {
    readRemoteHead: () => string;
    warn?: (message: string) => void;
  },
): void {
  let remoteHead: string;
  try {
    remoteHead = deps.readRemoteHead();
  } catch (e) {
    (deps.warn ?? ((m: string) => console.error(m)))(
      `worktree base currency: remote head for ${ref} could not be read ` +
        `(${String((e as Error)?.message ?? e)}) — proceeding without the check rather than ` +
        "refusing on an unmeasurable condition",
    );
    return;
  }
  if (remoteHead !== base) {
    throw new WorktreeBaseStaleError(base, remoteHead, ref);
  }
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
     *  (iii)). Default: `console.error`. */
    warn?: (message: string) => void;
  } = {},
): void {
  execFileSync("git", ["-C", repoDir, "fetch", "origin", "--quiet"], { stdio: "inherit" });
  execFileSync(
    "git",
    ["-C", repoDir, "worktree", "add", "-b", branch, worktreePath, base],
    { stdio: "inherit" },
  );
  // W1-T405: record the base BEFORE the currency check below — a refusal throws out of
  // this function with no return value, so the record must already be on disk for it to
  // be attributable at all. See recordWorktreeBase's own doc.
  const createdBase = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  recordWorktreeBase(worktreePath, createdBase);
  const ref = base.replace(/^origin\//, "");
  assertWorktreeBaseCurrent(createdBase, ref, {
    readRemoteHead: () => (deps.readRemoteHead ?? defaultReadRemoteHead)(repoDir, ref),
    warn: deps.warn,
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

  // 1. Force-remove any registered worktree whose path is under our worktrees
  //    root and whose branch is a run-* branch — UNLESS a live run owns it.
  let list = "";
  try {
    list = execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
  } catch {
    list = "";
  }
  let curPath = "";
  for (const line of list.split("\n")) {
    if (line.startsWith("worktree ")) curPath = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim(); // e.g. refs/heads/run-…
      const isRun = /\/run-/.test(ref) || ref.startsWith("run-");
      if (isRun && curPath.startsWith(worktreesRoot)) {
        // LIVENESS GUARD: a worktree whose run.lock names a live pid is IN USE.
        // Never force-remove it — that is the bug that lost a 65-turn implement.
        const lockRead = readRunLock(curPath);
        if (lockRead.kind === "live" && isPidAlive(lockRead.info.pid)) {
          skipped.push(curPath);
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
            mtimeMs = statSync(curPath).mtimeMs;
          } catch {
            mtimeMs = 0;
          }
          if (now() - mtimeMs < graceMs) {
            skipped.push(curPath);
            continue;
          }
        }
        try {
          execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", curPath], {
            stdio: "pipe",
          });
          removeRunLock(curPath); // clear the dead sibling lock so it can't linger
          removedWorktrees.push(curPath);
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

  return { worktrees: removedWorktrees, branches: removedBranches, skipped };
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
  /** rmSync itself failed — best-effort, the rest of the pass continues. */
  | "removal-failed";

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
  /** Widowed `<name>.lock` files removed because `<name>/` no longer exists. */
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
  let list = "";
  try {
    list = execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  let curPath = "";
  let curBranch: string | undefined;
  let found = false;
  for (const line of list.split("\n")) {
    if (line.startsWith("worktree ")) {
      curPath = line.slice("worktree ".length).trim();
      curBranch = undefined;
      if (curPath === entryPath) found = true;
    } else if (line.startsWith("branch ") && curPath === entryPath) {
      curBranch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  return found ? { repoDir, branch: curBranch } : null;
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
    try {
      if (!dryRun) {
        fs.rmSync(entryPath, { recursive: true, force: true });
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

  // Widowed `.lock` siblings whose worktree dir is already gone (hole 3):
  // removeRunLock only ever fires INSIDE a successful removal (worktreeRemove,
  // pruneStaleRuns, or the reap above), so a lock orphaned by any OTHER path —
  // e.g. a manual `rm -rf` of the worktree dir — lingers forever and makes a dead
  // run read as live to anything that trusts the lock. No age gate is owed here:
  // the owning directory is already gone, so nothing in flight can be harmed.
  for (const name of entries) {
    if (!name.endsWith(".lock")) continue;
    const dirPath = join(root, name.slice(0, -".lock".length));
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
 * Shared `gh ... --json` invocation + parse, used by ~13 call sites across run-task.ts (mostly
 * single-PR `pr view` reads, O(1) regardless of repo size). W1-T181's sibling-audit named exactly
 * ONE of those callers as repo-size-SCALING: run-task.ts's `buildOpenPrViews` (`pr list --state
 * open --limit 100 --json ...,body,...,statusCheckRollup`) — up to 100 open PRs' full bodies +
 * check rollups in one payload, the same shape (body-heavy, N-PRs-wide) that crossed Node's 1 MiB
 * `execFileSync` default and caused status.ts's batched-board-gateway outage. `maxBuffer` is
 * therefore set here, on the ONE shared codepath, rather than duplicated per call site — it is
 * strictly headroom (`1 << 24` = 16 MiB, the orientation.ts:72 in-repo precedent) for every other
 * O(1) caller, since a larger ceiling costs nothing unless it is actually approached.
 */
export function ghJson(args: string[]): unknown {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 24 });
  return JSON.parse(out);
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
  return execFileSync("gh", ["pr", "merge", prUrl, "--squash", "--delete-branch"], {
    encoding: "utf8",
  });
}
