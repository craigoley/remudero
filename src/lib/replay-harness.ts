/**
 * W1-T2689 — THE PRODUCER THE GOLDEN SUITE NEVER HAD.
 *
 * Every other piece of the golden-replay leg shipped and works: the corpus (`SEEDED_GOLDENS`), the
 * seam (`HarnessRunner`), the driver (`replayGoldens`), the emitter (`recordReplayResults` ->
 * `REPLAY_RESULT_STEP`) and the consumer (retro.ts's `replayPassRateForCycle` +
 * `renderReplayCalibration`). Only a PRODUCTION CALLER was missing, so `replayGoldens` had zero
 * production callers and the Self-Harness leg has reported "no replay run recorded" since the day
 * it shipped -- by construction, not by failure.
 *
 * It went unnoticed because the consumer degrades HONESTLY -- "No replay run recorded this cycle --
 * NOT a confirmed 0% (P48: no naked zero)" is correct and reads as normal forever. A
 * silent-but-correct degradation is harder to spot than a red.
 *
 * THIS MODULE IS THE COST BOUNDARY, which is why it is separate from replay.ts: every other rung
 * the retro folds is read-only over the ledger, while a genuine replay dispatches workers and
 * spends real money. Two properties make that safe, stated as code rather than left to a caller:
 * OPT-IN ({@link replayOptIn} refuses unless an operator asked by flag -- no ambient default, no
 * env fallback, the mutation gate's ambient ledger default being the precedent for why), and
 * BOUNDED ({@link REPLAY_CORPUS_BOUND}, which {@link boundedCorpus} clamps to even against a
 * larger ask).
 *
 * NOT IN SCOPE: the corpus, the comparison, `recordReplayResults`'s ledger shape and retro.ts's
 * reducer/renderer are shipped and correct. The renderer's non-run path especially must stay
 * reachable -- a producer that ran zero goldens must still render "no run recorded", never 0%.
 */
import type { GoldenTask, HarnessRunner, ReplayOutcome } from "./replay.js";

/**
 * PRIMARY CONTROL (bound-kind, W1-T2791): this is the mechanism that actually limits what one
 * replay invocation may spend — not a BACKSTOP sitting behind some other limiter, because there is
 * no other limiter. Nothing upstream caps the corpus; if this number is wrong, the spend is wrong.
 *
 * The DECLARED ceiling on how many goldens one invocation may replay. Declared rather than implicit
 * because the thing it bounds is a spend: a reader who wants to know what a replay run can cost
 * must be able to find the number without tracing a call graph.
 *
 * Set to the full seeded corpus (3, one per workflow class), so today it costs nothing in coverage
 * and everything in intent: the moment the corpus grows past it, an invocation replays a bounded
 * prefix instead of silently spending more. {@link boundedCorpus} clamps to it even against an
 * explicit larger request, so the bound is a ceiling and not a default.
 */
export const REPLAY_CORPUS_BOUND = 3;

/** Raised when a replay is attempted with no operator opt-in. A distinct type, not a bare Error, so
 *  a caller can tell "the operator did not ask for this" apart from "the dispatch failed". */
export class ReplayOptInRefusal extends Error {}

/** What actually drives one golden's task spec through a candidate harness -- a real dispatch
 *  against the sandbox venue in production, a recorder in a test. THIS is the seam that spends
 *  money; everything else in this module is arithmetic around it. */
export type ReplayDispatch = (golden: GoldenTask) => ReplayOutcome | Promise<ReplayOutcome>;

/** Dependencies for {@link harnessRunnerOver}. `log` is optional and observational only -- nothing
 *  in the replay decision may depend on whether a caller supplied one. */
export interface ReplayHarnessDeps {
  dispatch: ReplayDispatch;
  log?: (message: string) => void;
}

/**
 * Clamp a corpus to {@link REPLAY_CORPUS_BOUND}.
 *
 * `limit` is what the CALLER asked for; the return is never longer than the declared ceiling however
 * large that ask is. A negative or non-integer limit THROWS rather than being coerced: silently
 * reading `-1` as "none" or `2.5` as "two" would turn an operator's typo into a run that replayed a
 * different corpus than the one they asked for, and this is a spend.
 */
export function boundedCorpus(goldens: readonly GoldenTask[], limit: number = REPLAY_CORPUS_BOUND): GoldenTask[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`replay corpus limit must be a non-negative integer, got ${String(limit)}`);
  }
  return goldens.slice(0, Math.min(limit, REPLAY_CORPUS_BOUND));
}

/**
 * Build the {@link HarnessRunner} `replayGoldens` consumes, over a real dispatch.
 *
 * Deliberately thin: it adapts and observes, and it does NOT catch. A dispatch failure must reach
 * the caller as a thrown error rather than being converted into a `ReplayOutcome` -- a swallowed
 * failure would be compared against the golden's expectation and recorded as a FAILED replay, which
 * reports a harness regression that did not happen. "The dispatch broke" and "the harness produced
 * the wrong answer" are different findings and this seam must not merge them.
 */
export function harnessRunnerOver(deps: ReplayHarnessDeps): HarnessRunner {
  return async (golden: GoldenTask): Promise<ReplayOutcome> => {
    deps.log?.(`replay: dispatching ${golden.id} (${golden.class})`);
    return await deps.dispatch(golden);
  };
}

/** The result of the opt-in check: whether this invocation may spend, and the reason either way.
 *  The reason is always populated -- a refusal that cannot say why is one an operator has to
 *  reverse-engineer from source. */
export interface ReplayOptIn {
  enabled: boolean;
  reason: string;
}

/**
 * THE SPEND GATE. A replay run may proceed only when an operator asked for it explicitly, on this
 * invocation, by flag.
 *
 * No env-var fallback and no config default, on purpose. A retro tick, a CI job or a test-suite
 * spawn must never be able to enable this by inheriting an environment -- that is exactly how the
 * mutation gate's ambient ledger default came to write into an operator's real ledger from every
 * test spawn. A flag is the one signal that cannot be inherited.
 */
export function replayOptIn(argv: readonly string[]): ReplayOptIn {
  if (argv.includes("--confirm-spend")) {
    return { enabled: true, reason: "operator passed --confirm-spend on this invocation" };
  }
  return {
    enabled: false,
    reason:
      "refusing to replay: this dispatches workers against the sandbox and SPENDS REAL MONEY, unlike every " +
      "other retro rung, which is read-only over the ledger. Pass --confirm-spend to authorise this run. " +
      "There is deliberately no env var and no config default for this: a spend must not be inheritable " +
      "by a retro tick, a CI job or a test spawn.",
  };
}
