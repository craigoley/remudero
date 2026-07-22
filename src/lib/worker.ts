import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query, type Options, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, workerHomeDir, workerShell, workerZdotdir, type Config } from "./config.js";
import { detectCompactionEvents, isQualitySuspect, type CompactionEvent } from "./compaction.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { buildWorkerEnv } from "./env.js";
import { validateWorkerSettingsFile } from "./settings.js";
import { ensureWorkerKeychain, materializeWorkerHome, workerKeychainPaths } from "./worker-home.js";

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
   */
  numTurns: number;
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
  qualitySuspect: boolean;
}

/** `model`/`effort` label logged when a call rides no explicit mount override
 * (e.g. recon, the advisory reviewer) — an honest "unset", never a guessed value. */
export const DEFAULT_MODEL_LABEL = "default";
export const DEFAULT_EFFORT_LABEL = "default";

/** Billing mode is constant by construction: `buildWorkerEnv` strips every
 * `ANTHROPIC_*` var before a worker ever spawns (W1-T1), so no worker call can
 * ever be metered API-key-style. One literal, asserted everywhere (never
 * inferred per-call), so a ledger line can never drift from the true boundary. */
export const BILLING_MODE = "subscription" as const;

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
 */
export function workerLedgerFields(r: WorkerResult): {
  model: string;
  effort: string;
  tokens: TokenUsage;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number;
  billing_mode: typeof BILLING_MODE;
  verdict: string;
  quality_suspect: boolean;
  compaction_events: CompactionEvent[];
} {
  return {
    model: r.model,
    effort: r.effort,
    tokens: r.tokens,
    ...cacheTokenLedgerFields(r.tokens),
    total_cost_usd: r.costUsd,
    billing_mode: BILLING_MODE,
    verdict: r.isError ? r.subtype : "success",
    quality_suspect: r.qualitySuspect,
    compaction_events: r.compactionEvents,
  };
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
}

/**
 * Spawn one headless Claude Code worker via the Agent SDK.
 *
 * Uses the installed SDK's isolation options as ground truth (SDK 0.3.209):
 *  - `pathToClaudeCodeExecutable` → the absolute binary from config (never PATH).
 *  - `env` → REPLACES the subprocess env entirely (per the SDK contract), so the
 *    allowlisted, ANTHROPIC-stripped env from buildWorkerEnv() is the billing
 *    boundary. No wholesale process.env inheritance.
 *  - `settings` → the worker settings file (permissions + hooks).
 *  - `settingSources: []` → SDK isolation mode; never loads ~/.claude/settings.json.
 *  - `sandbox` → parsed from the settings file and passed as the validated SDK
 *    option, so a malformed sandbox block fails loud instead of the CLI silently
 *    dropping an invalid settings file and running unsandboxed.
 */
export async function spawnWorker(args: SpawnWorkerArgs): Promise<WorkerResult> {
  // Validate-before-spawn guard (WS-0 FF10a) enforced at the spawn boundary, not
  // by caller convention: `claude -p` SILENTLY IGNORES an invalid settings file
  // and drops containment, so the settings file is validated against the pinned
  // SandboxSettingsSchema before ANY worker is spawned. Throws WorkerSettingsError
  // on the first bad/misplaced key — no unsandboxed worker is ever launched.
  validateWorkerSettingsFile(args.settingsFile);

  const config = args.config ?? loadConfig();
  // W1-T18 general isolation mechanism: redirect HOME to a Remudero-controlled
  // scratch dir holding ONLY empty rc files (never the operator's real HOME),
  // with the few paths a worker legitimately needs symlinked back in. Best-
  // effort/idempotent — safe to call before every spawn. See worker-home.ts.
  const workerHome = workerHomeDir(config);
  const realHome = process.env.HOME ?? homedir();
  // W1-T235 (WS-7 keychain-unlock gate, macOS only): guarantee the DEDICATED
  // always-unlocked worker keychain before any spawn, and point the redirected
  // HOME's keychain slot at it — a LOCKED login keychain can no longer kill the
  // spawn "Not logged in" at $0. A credential problem throws WorkerKeychainError
  // HERE, pre-spawn, with a named reason class — never a $0 worker whose
  // zero-write death reads as "containment UNPROVEN" (the 2026-07-21 incident).
  let workerKeychainPath: string | undefined;
  if (process.platform === "darwin") {
    workerKeychainPath = ensureWorkerKeychain({
      ...workerKeychainPaths(join(config.root, "state")),
      loginKeychainPath: join(realHome, "Library", "Keychains", "login.keychain-db"),
      grantApps: [config.claudeBin, "/usr/bin/security"],
    }).keychainPath;
  }
  materializeWorkerHome({ workerHome, realHome, workerKeychainPath });

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
  });

  const stderrChunks: string[] = [];
  const blocks: string[] = [];

  // NOTE (SDK 0.3.209 ground truth): passing BOTH a `settings` file path and the
  // `sandbox` option throws "Cannot use both …". The sandbox config therefore
  // lives inside the settings file; the probe (verdict 7) empirically confirms
  // it actually engaged rather than being silently dropped.
  const options: Options = {
    cwd: args.cwd,
    permissionMode: args.permissionMode,
    pathToClaudeCodeExecutable: config.claudeBin,
    env: childEnv,
    settings: args.settingsFile,
    settingSources: [],
    stderr: (data: string) => {
      stderrChunks.push(data);
    },
  };
  if (args.resumeSessionId) options.resume = args.resumeSessionId;
  if (args.model) options.model = args.model;
  if (args.effort) options.effort = args.effort as Options["effort"];
  if (typeof args.maxTurns === "number") options.maxTurns = args.maxTurns;
  if (typeof args.maxBudgetUsd === "number") options.maxBudgetUsd = args.maxBudgetUsd;
  if (args.tools) options.tools = args.tools;

  return collectWorkerResult(query({ prompt: args.prompt, options }), {
    childEnvKeys: Object.keys(childEnv).sort(),
    stderrChunks,
    // Logged verbatim as CONFIGURED inputs — never a read-back (effort is not
    // in the SDK envelope at all; model here is the requested knob, which may
    // differ from the envelope's `modelUsage` map keys for the model(s) actually
    // billed). Unset ⇒ the honest "default" label, never a guessed value.
    model: args.model ?? DEFAULT_MODEL_LABEL,
    effort: args.effort ?? DEFAULT_EFFORT_LABEL,
  });
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
export async function collectWorkerResult(
  messages: AsyncIterable<unknown>,
  opts: {
    childEnvKeys: string[];
    stderrChunks?: string[];
    /** Configured input, logged verbatim — defaults to `DEFAULT_MODEL_LABEL`. */
    model?: string;
    /** Configured input, logged verbatim — defaults to `DEFAULT_EFFORT_LABEL`. */
    effort?: string;
  },
): Promise<WorkerResult> {
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
    sessionId,
    costUsd,
    numTurns,
    text,
    blocks,
    stderr: stderrChunks.join(""),
    subtype,
    isError,
    apiError,
    permissionDenials,
    childEnvKeys: opts.childEnvKeys,
    model: opts.model ?? DEFAULT_MODEL_LABEL,
    effort: opts.effort ?? DEFAULT_EFFORT_LABEL,
    tokens,
    modelUsage,
    compactionEvents,
    qualitySuspect: isQualitySuspect(compactionEvents),
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

/** `git worktree add` a fresh branch off origin/<base> for a repo checkout. */
export function worktreeAdd(
  repoDir: string,
  worktreePath: string,
  branch: string,
  base = "origin/main",
): void {
  execFileSync("git", ["-C", repoDir, "fetch", "origin", "--quiet"], { stdio: "inherit" });
  execFileSync(
    "git",
    ["-C", repoDir, "worktree", "add", "-b", branch, worktreePath, base],
    { stdio: "inherit" },
  );
}

export function worktreeRemove(repoDir: string, worktreePath: string): void {
  execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", worktreePath], {
    stdio: "inherit",
  });
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
  writeFileSync(runLockPath(worktreePath), JSON.stringify(info, null, 2));
}

export function readRunLock(worktreePath: string): RunLockInfo | null {
  try {
    const o = JSON.parse(readFileSync(runLockPath(worktreePath), "utf8"));
    if (typeof o?.pid === "number") return o as RunLockInfo;
    return null;
  } catch {
    return null;
  }
}

/** Remove the sibling run.lock (idempotent) — called on terminal verdict / on reap. */
export function removeRunLock(worktreePath: string): void {
  try {
    unlinkSync(runLockPath(worktreePath));
  } catch {
    // already gone
  }
}

/**
 * Grace window (ms) below which a LOCKLESS worktree is presumed to be a run that has
 * just `git worktree add`-ed but not yet written its {@link runLockPath} — the tiny
 * create-before-lock race. Callers pass this to protect that window; genuinely old
 * lockless debris (past the window) is still reaped.
 */
export const DEFAULT_PRUNE_GRACE_MS = 120_000;

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
        const lock = readRunLock(curPath);
        if (lock && isPidAlive(lock.pid)) {
          skipped.push(curPath);
          continue;
        }
        // AGE GUARD: a LOCKLESS worktree younger than graceMs may be a run that just
        // `git worktree add`-ed but has not yet written its run.lock (the create race).
        // Protect it; only genuinely-old lockless debris (or a dead-pid lock) is reaped.
        if (!lock && graceMs > 0) {
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
  return execFileSync("gh", ["pr", "merge", prUrl, "--squash", "--delete-branch"], {
    encoding: "utf8",
  });
}
