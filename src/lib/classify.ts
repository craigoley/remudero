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
  const text = signal.text ?? "";
  if (TRANSIENT_TEXT_PATTERNS.some((re) => re.test(text))) return "transient";
  if (signal.ciConclusion && TRANSIENT_CI_CONCLUSIONS.has(signal.ciConclusion)) return "transient";
  return "strike";
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
  /** Optional backoff between retries (default: no-op — tests never sleep). */
  sleep?: (attemptNumber: number) => Promise<void>;
}

export interface DiagnoseThenRetryResult {
  outcome: "success" | "gave_up";
  strikes: number;
  transientRetries: number;
  /** Whether a DIAGNOSE worker was ever dispatched during this run. */
  diagnosed: boolean;
  attempts: number;
  reason?: string;
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
    if (deps.sleep) await deps.sleep(attempts);
  }
}
