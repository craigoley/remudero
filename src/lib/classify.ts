/**
 * Transient-vs-strike classifier + diagnose-then-retry (W1-T7, MASTER-PLAN §4
 * "Loop hardening" — the SynthWatch pattern). A bounded, DETERMINISTIC
 * predicate over a failure's observable signals — network errors, GitHub 5xx,
 * CI-infra flake, or a worker's SDK error subtype — decides whether a retry
 * consumes a STRIKE. Network blips, gh 5xx, and CI-infra flake are TRANSIENT:
 * retried (bounded, no strike). Everything else — compile errors, failing
 * tests, a genuinely stuck worker — is a real failure and consumes a strike;
 * TWO strikes dispatch an evidence-only DIAGNOSE worker (mount steps UP, §9)
 * BEFORE any third patch attempt, so the third attempt is diagnose-INFORMED,
 * never a third blind patch.
 *
 * This module is the REUSABLE PRIMITIVE, not a call site: W1-T46 ("drain:
 * intelligent block-handling") and W1-T12 (the daemon) both name this module
 * as what they reuse once they exist (plan/tasks.yaml). It is deliberately
 * dependency-injected (mirrors {@link "./drain.js".runDrain}'s DrainDeps
 * shape) so it is testable without spawning a real worker and callable from
 * either run-task.ts, a future drain v2, or the daemon.
 */

// ── The classifier ──────────────────────────────────────────────────────────

export type FailureClass = "transient" | "strike";

/**
 * Observable evidence for one failed attempt. `subtype` is the SDK's result
 * subtype (worker.ts: 'error_max_turns' | 'error_max_budget_usd' |
 * 'error_during_execution' | …); `text` is free-text evidence — stderr, a `gh`
 * CLI error, or a CI log excerpt; `ciConclusion` is a GitHub check conclusion
 * (run-task.ts's RED_CONCLUSIONS universe: FAILURE/CANCELLED/TIMED_OUT/
 * ACTION_REQUIRED/STARTUP_FAILURE/ERROR). All fields are optional — a caller
 * supplies whichever it has; an EMPTY signal classifies `strike` (fail
 * closed — evidence of transience must be POSITIVE, never assumed).
 */
export interface FailureSignal {
  subtype?: string;
  text?: string;
  ciConclusion?: string;
  /**
   * An Anthropic-SIDE api error hit the worker stream (server_error / `<synthetic>`
   * model / isApiErrorMessage — the "API Error: Server error mid-response" shape). This
   * is POSITIVE evidence of a transient, the same class as a network blip: it must be
   * retried, never counted as a task strike. (worker.ts sets WorkerResult.apiError.)
   */
  apiError?: boolean;
}

// Recorded fixtures (below, in the test suite) drove this list: real network
// exceptions (ECONNRESET/ETIMEDOUT/…), GitHub/gh-CLI 5xx + rate-limit
// backpressure, and known CI-runner-infra flake phrasing (never a test
// assertion or compiler diagnostic — those are always a STRIKE).
const TRANSIENT_TEXT_PATTERNS: RegExp[] = [
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i,
  /HTTP\/[\d.]+\s*5\d\d|(?:^|[^0-9])5\d\d\s+(?:Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)/i,
  /gateway timeout|bad gateway|service unavailable|internal server error/i,
  /rate limit exceeded|secondary rate limit|abuse detection mechanism/i, // gh API backpressure
  /runner has received a shutdown signal|lost communication with the server|no space left on device/i,
  /could not resolve host|network is unreachable|connection reset by peer/i,
  // Anthropic-side api errors (server_error / overload / mid-response truncation) — the
  // SECOND transient class to hit the runner (the autoupdater race was first). NARROW
  // phrasing so a task merely mentioning "API error" in its own output is not caught.
  /server error mid-response|overloaded_error|api error:\s*(server|overloaded)|<synthetic>/i,
];

/** CI conclusions that are ambiguous-but-non-deterministic on their own: a
 * cancelled/timed-out/never-started job says NOTHING about the code's
 * correctness, so it classifies transient even with no matching log text. */
const TRANSIENT_CI_CONCLUSIONS = new Set(["CANCELLED", "TIMED_OUT", "STARTUP_FAILURE"]);

/**
 * Classify one failed attempt's evidence as transient (retry, no strike) or a
 * strike (a real failure). DETERMINISTIC and pure — no I/O, so a fixture-only
 * unit suite is a complete falsifier (acceptance #1).
 *
 * Precedence: a transient TEXT signature always wins (it is positive evidence
 * of network/infra flake even on an otherwise-deterministic-looking CI
 * conclusion); then an ambiguous CI conclusion; anything else — a genuine
 * `FAILURE`/`ACTION_REQUIRED`/`ERROR` conclusion, a compiler/test-assertion
 * message, an `error_max_turns` worker death, or no evidence at all — is a
 * STRIKE. Fail-closed: "maybe transient" is never good enough to skip a
 * strike.
 */
export function classifyFailure(signal: FailureSignal): FailureClass {
  // An Anthropic-side api error is positive evidence of a transient (like a network blip),
  // regardless of the misleading result subtype (which may say "success"). Check it first.
  if (signal.apiError) return "transient";
  const text = signal.text ?? "";
  if (TRANSIENT_TEXT_PATTERNS.some((re) => re.test(text))) return "transient";
  if (signal.ciConclusion && TRANSIENT_CI_CONCLUSIONS.has(signal.ciConclusion)) return "transient";
  return "strike";
}

/**
 * A USAGE-WINDOW REFUSAL IS NOT A NETWORK BLIP, AND THE DIFFERENCE IS THE SCHEDULE (W1-T2515).
 * Every pattern in {@link TRANSIENT_TEXT_PATTERNS} above describes a condition that may clear in
 * the next second — a reset socket, a 502, a runner losing its host. A session/usage limit clears
 * at a STATED WALL-CLOCK TIME, typically tens of minutes out. Retrying one on the other's schedule
 * is what spent MAX_TRANSIENT_RETRIES in 3.5 seconds against a lockout with 57m23s left to run.
 *
 * PROVIDER-NEUTRAL AND NARROW BY CONSTRUCTION: these are the exact terminal refusal families
 * emitted by the pinned Claude and Codex clients, not generic prose that happens to mention a
 * limit. Callers must still apply this detector only to provider error evidence, never to a
 * worker's ordinary response text.
 *
 * THE FIRST PATTERN ALSO COVERS CODEX'S ROLLING-QUOTA WINDOW, CONFIRMED NOT ACCIDENTAL (W1-T2567):
 * the three Codex-specific patterns below are all HARD refusals (out of credits, spend cap, plan
 * upgrade) — none is the high-frequency rolling window, Codex's analogue of Claude's "session
 * limit". Remudero's own corpus has never observed one to capture a string from (no codex binary
 * on this host or in the daemon container either), so this is pinned against the alternative
 * authoritative source instead: the `codex` CLI's own upstream `UsageLimitReachedError` Display
 * impl (openai/codex, codex-rs/protocol/src/error.rs) — every branch that is not one of the three
 * hard-refusal `RateLimitReachedType` variants, INCLUDING `RateLimitReachedType::RateLimitReached`
 * itself, starts with "You've hit your usage limit", which the first pattern below already
 * matches. See test/codex-quota-window-refusal.test.ts, pinned by the codex team's own captured
 * fixture string (codex-rs/protocol/src/error_tests.rs), not a hand-written approximation.
 */
const USAGE_LIMIT_TEXT_PATTERNS: RegExp[] = [
  /you'?ve hit your (?:session|usage) limit/i,
  /(?:session|usage) limit (?:reached|exceeded)\b/i,
  /your workspace is out of credits\b/i,
  /you hit your spend cap set (?:in|by the owner of) your workspace\b/i,
  /to use codex with your chatgpt plan, upgrade to plus\b/i,
];

/** Extracted from a usage-limit refusal: what it said, and when it says the window reopens. */
export interface UsageLimitRefusal {
  /** The refusal text that matched, trimmed — evidence, never re-derived downstream. */
  matched: string;
  /** The reset clause verbatim as written (e.g. `8:50pm (UTC)`), when one was present. */
  resetsAtText?: string;
  /**
   * Epoch ms the window reopens. Present ONLY when the refusal stated a time AND that time
   * carried an explicit UTC marker — a bare clock time in an unknown zone is NEVER converted,
   * because guessing the operator's zone would produce a confident wrong resume time. Absent is
   * a supported answer: the caller still stops retrying, it just cannot say when to resume.
   */
  resetsAtMs?: number;
}

/**
 * The reset clause a refusal carries. 12-hour with am/pm or 24-hour; the zone is optional in the
 * text but a NON-UTC or ABSENT zone yields no epoch (see {@link UsageLimitRefusal.resetsAtMs}).
 *
 * EXPORTED so its REFUSING arm is testable by name (W1-T2317's negative-reachability ratchet): a
 * validator whose rejection has never been exercised is the exact shape that ratchet exists to
 * catch, and this one decides whether a resume time is believed at all.
 */
export const USAGE_WINDOW_RESET_RE = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]{1,16})\))?/i;

/**
 * Recognise a usage/session-window refusal in one attempt's evidence, and extract its stated
 * reset when it carries one. PURE — `nowMs` is a parameter, never `Date.now()`, so the rollover
 * arithmetic below is a fixture test rather than a timing test.
 *
 * ROLLOVER: the refusal states a clock time, not a date. The reset is the NEXT occurrence of that
 * time at or after `nowMs`; a time that has already passed today rolls to tomorrow. That is the
 * right reading for a refusal read the moment it is produced, which is the only place this runs.
 */
export function detectUsageLimitRefusal(text: string | undefined, nowMs: number): UsageLimitRefusal | undefined {
  const t = text ?? "";
  const hit = USAGE_LIMIT_TEXT_PATTERNS.map((re) => re.exec(t)).find((m) => m !== null);
  if (!hit) return undefined;
  const out: UsageLimitRefusal = { matched: hit[0].trim() };

  const reset = USAGE_WINDOW_RESET_RE.exec(t);
  if (!reset) return out;
  out.resetsAtText = reset[0].replace(/^resets?\s+/i, "").trim();

  const zone = (reset[4] ?? "").trim().toUpperCase();
  if (zone !== "UTC") return out; // never invent a zone — see resetsAtMs's doc

  let hour = Number(reset[1]);
  const minute = Number(reset[2] ?? "0");
  const meridiem = (reset[3] ?? "").toLowerCase();
  // BOUNDS, NOT TYPE CHECKS: the capture groups are \d{1,2} and \d{2}, so Number() cannot
  // produce NaN here — a `Number.isFinite` guard would be unreachable code whose mutants can
  // never be killed. `99:99` IS reachable, and is what these two bounds refuse.
  if (hour > 23 || minute > 59) return out;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  // No second bound: `pm` only adds 12 when hour < 12, so the adjusted hour cannot exceed 23.

  const now = new Date(nowMs);
  const candidate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0);
  out.resetsAtMs = candidate >= nowMs ? candidate : candidate + 24 * 60 * 60 * 1000;
  return out;
}

/**
 * THE PRIMARY CONTROL (W1-T1266's taxonomy): the wait before the FIRST retry, and the base every
 * later one doubles from. This is what normally paces a transient retry — before W1-T2515 the pace
 * was zero, which is how MAX_TRANSIENT_RETRIES was spent in 3.519 seconds. Policy-as-data (rule 2).
 */
export const TRANSIENT_BACKOFF_BASE_MS = 1_000;

/**
 * A BACKSTOP, not the primary control above: it binds only once the doubling has already run away —
 * from attempt 6 onward — and exists so "bounded" is a property of the code rather than a promise
 * about how many retries there will ever be. If it is ever OBSERVED to bind in normal operation,
 * that is a signal about MAX_TRANSIENT_RETRIES, not a reason to raise this.
 */
export const TRANSIENT_BACKOFF_CEILING_MS = 30_000;

/**
 * How long to wait before retry number `attempts + 1`. Bounded exponential, PURE, and monotonic
 * up to the ceiling — the ceiling is what makes "never unbounded" a property rather than a hope.
 * `attempts` below 1 is clamped, so a caller that miscounts cannot produce a negative delay.
 */
export function transientBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  const raw = TRANSIENT_BACKOFF_BASE_MS * 2 ** (n - 1);
  return Math.min(raw, TRANSIENT_BACKOFF_CEILING_MS);
}

// ── The strike/diagnose state machine ──────────────────────────────────────

/** Accumulated retry state, threaded across attempts by the caller. */
export interface RetryState {
  strikes: number;
  transientRetries: number;
}

export const INITIAL_RETRY_STATE: RetryState = { strikes: 0, transientRetries: 0 };

/** Bound on TRANSIENT retries — network flake is retried, not retried forever. */
export const MAX_TRANSIENT_RETRIES = 3;

/** The strike count at which a DIAGNOSE worker is dispatched — BEFORE the next
 * (third) patch attempt, per acceptance #2. */
export const DIAGNOSE_AT_STRIKES = 2;

/** The strike count beyond which the loop gives up rather than patch blindly
 * forever — one diagnose-informed retry after DIAGNOSE_AT_STRIKES, then stop. */
export const MAX_STRIKES = 2;

export type RetryAction =
  | { kind: "retry_transient"; state: RetryState }
  | { kind: "retry_strike"; state: RetryState }
  | { kind: "diagnose"; state: RetryState }
  | { kind: "give_up"; state: RetryState; reason: string };

/**
 * Pure decision: given the CURRENT retry state and this attempt's failure
 * class, what happens next. Transient failures NEVER touch `strikes` (they
 * bump only `transientRetries`, bounded by {@link MAX_TRANSIENT_RETRIES}); a
 * strike bumps `strikes`. Hitting `strikes === DIAGNOSE_AT_STRIKES` returns
 * `diagnose` — the driver spawns the evidence-only worker and folds its
 * findings into the NEXT attempt, so that attempt (the third) is never blind.
 * Exceeding `MAX_STRIKES` after the diagnose-informed attempt still fails
 * gives up rather than patching forever.
 */
export function planRetry(state: RetryState, cls: FailureClass): RetryAction {
  if (cls === "transient") {
    const next: RetryState = { ...state, transientRetries: state.transientRetries + 1 };
    if (next.transientRetries > MAX_TRANSIENT_RETRIES) {
      return { kind: "give_up", state: next, reason: `transient retries exhausted (${MAX_TRANSIENT_RETRIES})` };
    }
    return { kind: "retry_transient", state: next };
  }
  const next: RetryState = { ...state, strikes: state.strikes + 1 };
  if (next.strikes === DIAGNOSE_AT_STRIKES) return { kind: "diagnose", state: next };
  if (next.strikes > MAX_STRIKES) {
    return { kind: "give_up", state: next, reason: `strikes exhausted (${MAX_STRIKES})` };
  }
  return { kind: "retry_strike", state: next };
}

// ── The diagnose-then-retry driver ─────────────────────────────────────────

export interface AttemptSuccess {
  success: true;
}
export interface AttemptFailure {
  success: false;
  evidence: FailureSignal;
}
export type AttemptOutcome = AttemptSuccess | AttemptFailure;

/**
 * Injectable dependencies — mirrors {@link "./drain.js".DrainDeps}'s shape so
 * the SAME dependency-injection pattern this codebase already uses for
 * drain.ts applies here. The real caller wires `attempt` to a patch/implement
 * retry (e.g. a resumed implement worker) and `diagnose` to a fresh,
 * evidence-only worker spawned on the "diagnose" mount (mounts.yaml — model
 * steps UP; §9). Neither is called by this module directly against the SDK,
 * so the whole state machine is testable with fakes, with no real spawn.
 */
export interface DiagnoseThenRetryDeps {
  /**
   * Run one patch attempt. `findings` carries the prior DIAGNOSE worker's
   * evidence-only report (undefined on the first attempt, or on a blind
   * transient retry) — a diagnose-informed attempt must actually receive the
   * findings, never be re-issued the identical blind prompt.
   */
  attempt: (findings?: string) => Promise<AttemptOutcome>;
  /**
   * Spawn the evidence-only DIAGNOSE worker. Called exactly once per
   * DIAGNOSE_AT_STRIKES threshold crossing — never itself a patch (the worker
   * it wraps must only explain the failure, never touch the diff).
   */
  diagnose: () => Promise<{ text: string }>;
  /** One ledger-shaped line per step; no-op default (real callers ledger it). */
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /**
   * Wait this many MILLISECONDS before the next retry. W1-T2515 changed this from an
   * attempt-number to a duration: the caller owns the clock, this module owns the schedule
   * (see transientBackoffMs). Omitted means no wait, which is what every caller got before
   * that task because the ONE production call site never supplied it at all — three retries
   * in 3.5 seconds against a 57-minute lockout.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the usage-window reset arithmetic. Defaults to Date.now. */
  now?: () => number;
}

export interface DiagnoseThenRetryResult {
  outcome: "success" | "gave_up";
  strikes: number;
  transientRetries: number;
  /** Whether a DIAGNOSE worker was ever dispatched during this run. */
  diagnosed: boolean;
  attempts: number;
  reason?: string;
  /**
   * W1-T2515: set ONLY when the loop stopped because the account's usage window is shut. The
   * caller (and, through it, the daemon) needs the stated reset to decide when to resume; a
   * gave_up carrying this field is a FLEET condition, not a task failure, and must never be
   * read as one. Absent on every other outcome, an ordinary exhausted-retries give-up included.
   */
  usageLimit?: UsageLimitRefusal;
}

/**
 * The driver: attempt → on failure, classify → plan the next action → repeat.
 * TRANSIENT failures retry with no strike (bounded); STRIKEs accumulate; at
 * {@link DIAGNOSE_AT_STRIKES} a DIAGNOSE worker runs BEFORE the next attempt,
 * whose findings are threaded into that attempt — the loop's core guarantee
 * (acceptance #2): two strikes always produce a diagnose run before any third
 * patch, and that patch is diagnose-informed, never blind.
 */
export async function runDiagnoseThenRetry(deps: DiagnoseThenRetryDeps): Promise<DiagnoseThenRetryResult> {
  const log = deps.log ?? (() => {});
  let state: RetryState = INITIAL_RETRY_STATE;
  let diagnosed = false;
  let findings: string | undefined;
  let attempts = 0;

  for (;;) {
    attempts++;
    const result = await deps.attempt(findings);
    if (result.success) {
      log("retry.success", {
        attempts,
        strikes: state.strikes,
        transient_retries: state.transientRetries,
        diagnosed,
      });
      return { outcome: "success", strikes: state.strikes, transientRetries: state.transientRetries, diagnosed, attempts };
    }

    // W1-T2515: A SHUT WINDOW IS NOT A FLAKE. Checked BEFORE classification, because
    // classifyFailure would call it transient (correctly — it is not the task's fault) and the
    // loop would then spend the whole transient budget against a lockout that clears on a
    // wall-clock schedule this loop must not wait out: waiting here holds a dispatch lane for
    // the full window. Stop, carry the stated reset out, and let the daemon own the resume.
    const usageLimit = detectUsageLimitRefusal(result.evidence.text, (deps.now ?? Date.now)());
    if (usageLimit) {
      log("retry.usage_limit", {
        attempts,
        strikes: state.strikes,
        transient_retries: state.transientRetries,
        matched: usageLimit.matched,
        resets_at_text: usageLimit.resetsAtText,
        resets_at_ms: usageLimit.resetsAtMs,
      });
      return {
        outcome: "gave_up",
        strikes: state.strikes,
        transientRetries: state.transientRetries,
        diagnosed,
        attempts,
        reason: usageLimit.resetsAtText
          ? `usage window shut — ${usageLimit.matched} (resets ${usageLimit.resetsAtText})`
          : `usage window shut — ${usageLimit.matched} (no reset time stated)`,
        usageLimit,
      };
    }

    const cls = classifyFailure(result.evidence);
    const action = planRetry(state, cls);
    state = action.state;
    log("retry.classified", {
      attempts,
      class: cls,
      action: action.kind,
      strikes: state.strikes,
      transient_retries: state.transientRetries,
    });

    if (action.kind === "give_up") {
      log("retry.exhausted", { attempts, reason: action.reason, strikes: state.strikes, transient_retries: state.transientRetries });
      return {
        outcome: "gave_up",
        strikes: state.strikes,
        transientRetries: state.transientRetries,
        diagnosed,
        attempts,
        reason: action.reason,
      };
    }

    if (action.kind === "diagnose") {
      log("diagnose.spawn", { attempts, strikes: state.strikes });
      const report = await deps.diagnose();
      findings = report.text;
      diagnosed = true;
      log("diagnose.done", { attempts, strikes: state.strikes, findings_chars: findings.length });
      continue; // Next attempt is diagnose-INFORMED — never a third blind patch.
    }

    // retry_transient | retry_strike: loop again (blind retry; `findings`
    // carries forward unchanged — a diagnose report already in hand keeps
    // informing subsequent attempts too).
    if (deps.sleep) await deps.sleep(transientBackoffMs(attempts));
  }
}
