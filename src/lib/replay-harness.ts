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
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRIAL_ID_RE } from "./benchmark-aa.js";
import { loadPaidPilotProtocol, paidArmPauseReasons, readPaidPilotControls, readPaidPilotEvidence,
  reviewerReplayExclusivityReason,
  REVIEWER_REPLAY_STEPS, PAID_PILOT_AA_RECEIPT_MAX_AGE_MS, PAID_PILOT_CASH_CEILING_USD,
  type PaidPilotProtocol, type ReviewerReplayScope } from "./benchmark-paid-pilot.js";
import { systemClock } from "./clock.js";
import { appendLedger } from "./ledger.js";
import { ledgerLivePath } from "./ledger-union.js";
import { SEEDED_GOLDENS, type GoldenTask, type HarnessRunner, type ReplayOutcome } from "./replay.js";
import { runPairedReviewEvaluation, type BlindedReviewInput, type PairedReviewCase,
  type PairedReviewEvalInput, type PairedReviewReport } from "./paired-review-eval.js";
import {
  deriveGoldenCorpus,
  goldenTaskFromCorpusItem,
  replayIdleGate,
  type ReplayIdleSignal,
  type ReplaySample,
  type ReplaySampleSource,
} from "./golden-corpus.js";

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

export { replayIdleGate, type ReplayIdleSignal, type ReplaySample, type ReplaySampleSource } from "./golden-corpus.js";

export function drawReplaySample(req: { argv: readonly string[]; idle: ReplayIdleSignal; source: ReplaySampleSource; limit?: number }): ReplaySample {
  for (const gate of [replayOptIn(req.argv), replayIdleGate(req.idle)]) {
    if (!gate.enabled) return { ...gate, goldens: [], items: [], excluded: [] };
  }
  const reason = "opted in and the fleet is idle";
  if (req.source.kind === "seeded") {
    return { enabled: true, reason, goldens: boundedCorpus(req.source.goldens ?? SEEDED_GOLDENS, req.limit), items: [], excluded: [] };
  }
  const { items, excluded } = deriveGoldenCorpus(req.source.corpus);
  const paired = items.flatMap((item) => {
    const golden = goldenTaskFromCorpusItem(item);
    return golden ? [{ item, golden }] : [];
  });
  const goldens = boundedCorpus(paired.map((p) => p.golden), req.limit);
  return { enabled: true, reason, goldens, items: paired.slice(0, goldens.length).map((p) => p.item), excluded };
}

export interface PaidPairedReviewInput extends Omit<PairedReviewEvalInput, "admitReview"> {
  argv: readonly string[];
  idle: ReplayIdleSignal;
  stateDir: string;
  pilotId: string;
  phase: "aa" | "comparison";
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function scopeCase(scope: ReviewerReplayScope, pair: PairedReviewCase): boolean {
  const found = scope.cases.find((item) => item.id === pair.id);
  return found !== undefined && found.corpusTaskId === pair.corpusTaskId && found.repo === pair.repo
    && found.baseSha === pair.baseSha && found.bugHeadSha === pair.bug.headSha
    && found.benignHeadSha === pair.benign.headSha && found.sealedManifestDigest === digest(pair);
}

function reviewerAaPrefix(pilotId: string): string {
  return `benchmark-paid-pilot-v1.${pilotId}.reviewer-aa.`;
}

function reviewerAaVerdict(report: PairedReviewReport, model: string, seed: string): "no-integrity-concern-detected" | "integrity-concerns" {
  if (report.totalPairs === 0 || report.gradedPairs !== report.totalPairs || report.costMissingArms > 0) return "integrity-concerns";
  const groups = new Set<number>();
  const assignments = new Set<string>();
  for (const pair of report.pairs) {
    groups.add(parseInt(digest(`${seed}:${pair.caseId}`).slice(0, 2), 16) % 2);
    if (pair.models.bug !== model || pair.models.benign !== model || pair.missing.length > 0
      || pair.assignments.bug === null || pair.assignments.benign === null) return "integrity-concerns";
    for (const id of [pair.assignments.bug, pair.assignments.benign]) {
      if (assignments.has(id)) return "integrity-concerns";
      assignments.add(id);
    }
  }
  return groups.size === 2 ? "no-integrity-concern-detected" : "integrity-concerns";
}

function aaEvidenceStatus(stateDir: string, protocol: PaidPilotProtocol, input: PaidPairedReviewInput):
  { ok: true } | { ok: false; reason: string } {
  try {
    const latest = readdirSync(stateDir).filter((name) => name.startsWith(reviewerAaPrefix(protocol.pilotId)) && name.endsWith(".json"))
      .sort().at(-1);
    if (!latest) return { ok: false, reason: "reviewer-aa-missing" };
    const record = JSON.parse(readFileSync(join(stateDir, latest), "utf8"));
    const report = record.report as PairedReviewReport;
    const receipt = record.receipt;
    const age = systemClock.now() - Date.parse(String(receipt?.asOf));
    const caseIds = report.pairs.map((pair) => pair.caseId).sort();
    const scopedIds = protocol.reviewerReplay?.cases.map((item) => item.id).sort();
    const valid = receipt?.version === "paid-reviewer-aa-v1" && receipt.protocolDigest === protocol.digest
      && receipt.scopeDigest === digest(protocol.reviewerReplay)
      && receipt.stackDigest === digest(input.stack) && receipt.seedDigest === digest(input.seed)
      && receipt.reportDigest === digest(report) && receipt.verdict === "no-integrity-concern-detected"
      && reviewerAaVerdict(report, protocol.arms.paid.model, input.seed) === receipt.verdict
      && Number.isFinite(age) && age >= 0 && age <= PAID_PILOT_AA_RECEIPT_MAX_AGE_MS
      && Date.parse(String(receipt.asOf)) >= Date.parse(protocol.activatedAt)
      && Date.parse(String(receipt.asOf)) < Date.parse(protocol.expiresAt)
      && JSON.stringify(caseIds) === JSON.stringify(scopedIds);
    return valid ? { ok: true } : { ok: false, reason: "reviewer-aa-invalid-or-failed" };
  } catch { return { ok: false, reason: "reviewer-aa-unreadable" }; }
}

export async function replayPairedReviews(input: PaidPairedReviewInput): Promise<{ state: "refused"; reason: string }
  | { state: "evaluated"; report: PairedReviewReport; excludedPairIds: string[]; aaVerdict: string | null; reason?: string }> {
  for (const gate of [replayOptIn(input.argv), replayIdleGate(input.idle)]) {
    if (!gate.enabled) return { state: "refused", reason: gate.reason };
  }
  if (!TRIAL_ID_RE.test(input.pilotId)) return { state: "refused", reason: "pilot-id-invalid" };
  if (input.phase !== "aa" && input.phase !== "comparison") return { state: "refused", reason: "reviewer-phase-invalid" };
  const loaded = loadPaidPilotProtocol(input.stateDir, input.pilotId);
  if (!loaded.ok) return { state: "refused", reason: loaded.reason };
  const protocol = loaded.protocol;
  const scope = protocol.reviewerReplay;
  if (scope === undefined || scope.version !== "paid-reviewer-replay-v1" || !Array.isArray(scope.cases) || scope.cases.length === 0)
    return { state: "refused", reason: "reviewer-population-not-authorized" };
  if (typeof scope.cashReserveUsdPerCall !== "number" || !Number.isFinite(scope.cashReserveUsdPerCall)
    || scope.cashReserveUsdPerCall <= 0 || scope.cashReserveUsdPerCall > PAID_PILOT_CASH_CEILING_USD
    || protocol.cash.ceilingUsd !== PAID_PILOT_CASH_CEILING_USD)
    return { state: "refused", reason: "reviewer-cash-scope-invalid" };
  if (protocol.design !== "paired" || protocol.paired?.shadow !== true)
    return { state: "refused", reason: "reviewer-pilot-not-shadow-isolated" };
  const exclusive = reviewerReplayExclusivityReason(input.stateDir, input.pilotId, systemClock.iso());
  if (exclusive !== null) return { state: "refused", reason: exclusive };
  if (protocol.assignment.seed !== input.seed || protocol.repos.length !== 3 || !input.validatePair || !input.validateLabel || !input.score
    || input.stack.harness !== protocol.revisions.harnessRevision || input.stack.prompt !== protocol.revisions.promptRevision
    || input.stack.tool !== protocol.revisions.toolRevision || input.stack.scorer !== protocol.revisions.scorerRevision
    || input.stack.environment !== protocol.revisions.environmentRevision)
    return { state: "refused", reason: "reviewer-evidence-or-stack-unpinned" };
  if (input.phase === "comparison") {
    const aa = aaEvidenceStatus(input.stateDir, protocol, input);
    if (!aa.ok) return { state: "refused", reason: aa.reason };
  }
  const admitted = new Set(boundedCorpus(input.corpus.flatMap((item) => {
    const golden = goldenTaskFromCorpusItem(item);
    return golden ? [golden] : [];
  })).map((golden) => golden.task.id));
  const pairs = input.pairs.filter((pair) => admitted.has(pair.corpusTaskId) && scopeCase(scope, pair));
  const excludedPairIds = input.pairs.filter((pair) => !pairs.includes(pair)).map((pair) => pair.id);
  if (pairs.length === 0) return { state: "refused", reason: "no-sealed-held-out-reviewer-pair" };
  const lockPath = join(input.stateDir, `benchmark-paid-pilot-v1.${input.pilotId}.reviewer-lock`);
  try { mkdirSync(lockPath); }
  catch { return { state: "refused", reason: "reviewer-paid-arm-busy-or-state-unavailable" }; }
  try {
    const reserved = new Map<string, { callId: string; pair: PairedReviewCase; arm: "bug" | "benign" }>();
    const match = (blinded: BlindedReviewInput) => pairs.flatMap((pair) => ["bug", "benign"].flatMap((arm) =>
      pair[arm as "bug" | "benign"].headSha === blinded.headSha && pair.baseSha === blinded.baseSha && pair.repo === blinded.repo
        ? [{ pair, arm: arm as "bug" | "benign" }] : []));
    const report = await runPairedReviewEvaluation({ ...input, pairs,
      admitReview: async (blinded) => {
        const matches = match(blinded);
        if (matches.length !== 1) return { allowed: false, reason: "reviewer-head-ambiguous" };
        const fresh = loadPaidPilotProtocol(input.stateDir, input.pilotId);
        if (!fresh.ok || fresh.protocol.digest !== protocol.digest) return { allowed: false, reason: "reviewer-protocol-changed" };
        const exclusive = reviewerReplayExclusivityReason(input.stateDir, input.pilotId, systemClock.iso());
        if (exclusive !== null) return { allowed: false, reason: exclusive };
        const controls = readPaidPilotControls(input.stateDir, input.pilotId);
        // The evaluator converts an unexpected read exception into an explicit admission failure.
        const evidence = await readPaidPilotEvidence(input.stateDir, protocol);
        const pause = paidArmPauseReasons(protocol, evidence, systemClock.iso(), scope.cashReserveUsdPerCall);
        if (controls.state !== "observed" || controls.paused) pause.reasons.push(controls.reason ?? "operator-paused");
        if (pause.reasons.length > 0) return { allowed: false, reason: pause.reasons.join("+") };
        const callId = randomUUID();
        const { pair, arm } = matches[0]!;
        const aaGroup = parseInt(digest(`${input.seed}:${pair.id}`).slice(0, 2), 16) % 2;
        try {
          appendLedger(ledgerLivePath(input.stateDir), { run_id: `reviewer-${callId}`, task_id: pair.corpusTaskId,
            step: REVIEWER_REPLAY_STEPS.reserve, billing_mode: "api", total_cost_usd: scope.cashReserveUsdPerCall,
            reviewer_replay: { pilot_id: protocol.pilotId, protocol_digest: protocol.digest, call_id: callId, case_id: pair.id,
              arm, head_sha: blinded.headSha, phase: input.phase, sealed_manifest_digest: digest(pair),
              seed_digest: digest(input.seed), stack_digest: digest(input.stack), aa_group: input.phase === "aa" ? aaGroup : null,
              selection_propensity: 0.5,
              requested_model: protocol.arms.paid.model, requested_effort: protocol.arms.paid.effort } });
        } catch { return { allowed: false, reason: "reviewer-reservation-not-durable" }; }
        reserved.set(blinded.opaqueArmId, { callId, pair, arm });
        return { allowed: true, reason: "reviewer-paid-call-reserved" };
      },
      review: async (blinded) => {
        const claim = reserved.get(blinded.opaqueArmId);
        if (!claim) throw new Error("reviewer-call-not-reserved");
        reserved.delete(blinded.opaqueArmId);
        const output = await input.review({ ...blinded, requestedModel: protocol.arms.paid.model,
          requestedEffort: protocol.arms.paid.effort });
        appendLedger(ledgerLivePath(input.stateDir), { run_id: `reviewer-${claim.callId}`, task_id: claim.pair.corpusTaskId,
          step: REVIEWER_REPLAY_STEPS.receipt, billing_mode: output.billingMode ?? null, total_cost_usd: output.costUsd ?? null,
          served_model: output.servedModel ?? null, served_effort: output.servedEffort ?? null,
          assignment_id: output.assignmentId ?? null, elapsed_ms: output.elapsedMs ?? null,
          input_tokens: output.inputTokens ?? null, output_tokens: output.outputTokens ?? null,
          verdict: output.verdict, finding_ids: output.findings?.map((finding) => finding.id) ?? null,
          reviewer_replay: { pilot_id: protocol.pilotId, protocol_digest: protocol.digest, call_id: claim.callId,
            case_id: claim.pair.id, arm: claim.arm, head_sha: blinded.headSha, phase: input.phase } });
        if (output.billingMode !== "api" || output.requestedModel !== protocol.arms.paid.model
          || output.servedModel !== protocol.arms.paid.model || output.servedEffort !== protocol.arms.paid.effort)
          throw new Error("reviewer-model-or-billing-deviation");
        return output;
      },
    });
    const complete = report.totalPairs === scope.cases.length && report.gradedPairs === report.totalPairs
      && report.costMissingArms === 0 && report.cashCostUsd !== null
      && report.pairs.every((pair) => pair.missing.length === 0);
    const retained = input.phase === "aa" || !complete ? { ...report, byModel: [] } : report;
    const reportName = `benchmark-paid-pilot-v1.${protocol.pilotId}.reviewer-report.${systemClock.now()}.${randomUUID()}.json`;
    try {
      writeFileSync(join(input.stateDir, reportName), JSON.stringify({ version: "paid-reviewer-report-v1", phase: input.phase,
        protocolDigest: protocol.digest, report: retained }), { flag: "wx", mode: 0o600 });
      appendLedger(ledgerLivePath(input.stateDir), { run_id: `reviewer-report-${randomUUID()}`, task_id: pairs[0]!.corpusTaskId,
        step: "reviewer_replay.result", reviewer_replay: { pilot_id: protocol.pilotId, protocol_digest: protocol.digest,
          phase: input.phase, report_digest: digest(retained), report_file: reportName,
          seed_digest: retained.seedDigest, stack_digest: digest(retained.stack), total_pairs: retained.totalPairs,
          graded_pairs: retained.gradedPairs, incomplete_pairs: retained.incompletePairs, ungradable_pairs: retained.ungradablePairs,
          cost_missing_arms: retained.costMissingArms } });
    } catch {
      return { state: "evaluated", report: { ...report, byModel: [] }, excludedPairIds,
        aaVerdict: null, reason: "reviewer-result-not-durable" };
    }
    let aaVerdict: string | null = null;
    if (input.phase === "aa") {
      aaVerdict = retained.totalPairs === scope.cases.length
        ? reviewerAaVerdict(retained, protocol.arms.paid.model, input.seed) : "integrity-concerns";
      const receipt = { version: "paid-reviewer-aa-v1", protocolDigest: protocol.digest, scopeDigest: digest(scope),
        stackDigest: digest(input.stack), seedDigest: digest(input.seed), reportDigest: digest(retained),
        asOf: systemClock.iso(), verdict: aaVerdict };
      const path = join(input.stateDir, `${reviewerAaPrefix(protocol.pilotId)}${systemClock.now()}.${randomUUID()}.json`);
      // A missing receipt is a failed invocation, never an evaluated A/A result.
      writeFileSync(path, JSON.stringify({ receipt, report: retained }), { flag: "wx", mode: 0o600 });
    }
    return { state: "evaluated", report: retained, excludedPairIds, aaVerdict };
  } finally { rmdirSync(lockPath); }
}
