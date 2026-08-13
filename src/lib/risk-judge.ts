import type { Mount, Mounts } from "./mounts.js";
import { MountsError } from "./mounts.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";

/**
 * Risk judge — P34 clause (b), MASTER-PLAN §4B/§9, W1-T248.
 *
 * A lightweight judge ON THE DISPATCH PATH that assesses each CANDIDATE CHANGE
 * (never the static `task.risk` field — that field is a SIZING artifact set by
 * subsystem-span counting, W1-T5/§9, and says nothing about a change's danger;
 * {@link RiskJudgeInput} has no field that could carry it, so a caller cannot
 * leak it in even by mistake, the same by-construction discipline
 * flight-judge.ts uses for the worker's own narration).
 *
 * DECISION SHAPE: low-risk-and-confident PROCEEDS; high-risk OR
 * LOW-CONFIDENCE ESCALATES for manual input with the OBSERVED blocker named
 * (the W1-T186 emitter discipline: name what was actually observed, never an
 * inferred symptom). Judgment (the verdict) and action (proceed/escalate) are
 * kept SEPARATE — {@link planRiskJudgeAction} is a pure function, so the
 * verdict->action mapping is unit-testable with no LLM call inside it at all
 * (Standing rule 12, mirroring flight-judge.ts's `planJudgeAction` and
 * risk-score.ts's `planRiskGate`).
 *
 * JUDGE-UNAVAILABLE (a spawn error, a timeout, an unparseable response) falls
 * back to ESCALATE and NEVER silent-proceeds — the cannot-observe->wait
 * polarity (W1-T130), applied to the judge itself. This is enforced inside
 * {@link assessRisk} itself (not left to callers to remember), so every reuse
 * site — dispatch today, P28's graduated auto-ratification tomorrow — gets
 * the fail-closed guarantee for free.
 *
 * STABLE ON UNCHANGED INPUT (W1-T178 doctrine, applied here as: the SAME
 * candidate change assessed twice yields the SAME verdict): a live judge is
 * an LLM call and cannot be trusted to reproduce bit-for-bit, so
 * {@link assessRisk} accepts an optional {@link RiskJudgeCache} keyed on a
 * canonical serialization of the input ({@link canonicalRiskJudgeInputKey}) —
 * once a candidate change has been judged, re-assessing the IDENTICAL input
 * returns the cached verdict rather than risking a flapped re-judgment
 * (mirrors review.ts's W1-T178 verdict-stability rule: a prior verdict is
 * reused unless the input actually changed).
 *
 * VERDICT + REASONS + CONFIDENCE are ledgered VERBATIM per decision (round
 * ii) — {@link runRiskJudge} writes one `risk_judge.decision` ledger line
 * carrying all three fields untouched, so a numeric confidence threshold can
 * be derived from accumulated data later.
 *
 * MOUNT: the judge runs on the CHEAPEST configured tier (haiku-class)
 * resolved from mounts.yaml (W1-T5) — {@link resolveRiskJudgeMount} scans the
 * routing table's own data (`tiers`/`efforts` orderings + every configured
 * mount) rather than hardcoding a model name, so it stays correct as the
 * table's lineup shifts (mirrors mounts.ts's own "the ordering is what
 * matters, not the absolute lineup" design).
 *
 * REUSABLE BY CONSTRUCTION (for P28's graduated auto-ratification):
 * {@link assessRisk}'s interface takes `{change, gatesState, planContext}`
 * and returns `{verdict, reasons, confidence}` with NO dispatch-only
 * coupling — it never imports escalate.ts, run-task.ts, or anything
 * dispatch-specific. The dispatch-specific orchestration (ledgering, calling
 * escalate.ts) lives one layer up in {@link runRiskJudge}, which takes those
 * as INJECTED dependencies (mirrors flight-judge.ts's `FlightJudgeDeps`
 * injection point) — a second caller (P28) can reuse {@link assessRisk}
 * directly, or wrap it in its own orchestrator, without carrying any of this
 * module's dispatch-path assumptions.
 */

// ── The verdict contract ────────────────────────────────────────────────

export type RiskJudgeVerdictLabel = "low" | "high";

/** What the judge returns for one candidate change. The reusable shape
 * acceptance criterion 6 names verbatim: `{verdict, reasons, confidence}`. */
export interface RiskJudgeVerdict {
  verdict: RiskJudgeVerdictLabel;
  /** Concrete, OBSERVED reasons for the verdict (W1-T186 emitter discipline) — never an
   *  inferred symptom. Ledgered verbatim alongside the verdict and confidence. */
  reasons: string[];
  /** 0..1 — the judge's OWN self-reported confidence in `verdict`. Ledgered verbatim
   *  (round ii) so a numeric threshold can be derived from accumulated data later. */
  confidence: number;
}

// ── What the judge is shown — the candidate CHANGE, never task.risk ──────

/** The candidate change under assessment. Deliberately has no `risk` field —
 *  there is nowhere to put the static sizing artifact, so a caller cannot
 *  leak it in even by mistake (mirrors flight-judge.ts's `JudgeTurnEvidence`
 *  never carrying the worker's own narration). */
export interface RiskJudgeChange {
  /** Human-readable description of the change (diff summary, PR title/body, etc). */
  description: string;
  /** Touched file paths, when known. */
  files?: string[];
}

/** Deliberately loose/string-keyed: dispatch today and P28 tomorrow each track their
 *  own gates (lint/test/typecheck/review state, headroom, …) under whatever keys make
 *  sense to THEM — this module does not prescribe a shape, only that it gets shown. */
export interface RiskJudgeGatesState {
  [key: string]: unknown;
}

/** Plan coherence context — task id, plan refs, whatever the caller has. Loose/string-keyed
 *  for the same reason as {@link RiskJudgeGatesState}. */
export interface RiskJudgePlanContext {
  taskId?: string;
  planRefs?: string[];
  [key: string]: unknown;
}

/** The reusable input shape (acceptance criterion 6): `{change, gatesState, planContext}`. */
export interface RiskJudgeInput {
  change: RiskJudgeChange;
  gatesState: RiskJudgeGatesState;
  planContext: RiskJudgePlanContext;
}

// ── The fresh judge prompt (never shown the static risk: field) ──────────

function renderRecord(label: string, record: Record<string, unknown>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return `${label}:\n  (none supplied)`;
  const lines = entries.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n");
  return `${label}:\n${lines}`;
}

/**
 * Render the risk judge's prompt. Carries the candidate change, the gates
 * state, and the plan context — NEVER the static `risk:` field (it is not
 * even a parameter this function accepts, {@link RiskJudgeInput} has no such
 * field to render).
 */
export function buildRiskJudgePrompt(input: RiskJudgeInput): string {
  const filesLine = input.change.files?.length ? input.change.files.join(", ") : "(no files listed)";

  return [
    `You are the RISK JUDGE (P34 clause (b), dispatch-path control) assessing ONE`,
    `candidate CHANGE. You judge the CHANGE ITSELF — its coherence with the plan,`,
    `drift risk, and alignment with established practice, in light of the gates`,
    `state below. You are NEVER shown, and must NEVER consult, any static \`risk:\``,
    `field — that field sizes effort, it does not measure danger.`,
    ``,
    `YOU ARE NOT SHOWN A DIFF (W1-T454). The description and files list below are`,
    `everything you get — no patch, no hunks, no code. Do not phrase a RISK_REASON`,
    `as though you read the code ("the code does X", "X is never done") — phrase it`,
    `as what the description/files/gates state below actually show or imply. An`,
    `inference about unseen code, printed in the grammar of an observation, is`,
    `exactly the defect this judge exists to avoid, not one it may commit.`,
    ``,
    `CANDIDATE CHANGE: ${input.change.description}`,
    `FILES TOUCHED: ${filesLine}`,
    ``,
    renderRecord("GATES STATE", input.gatesState),
    ``,
    renderRecord("PLAN CONTEXT", input.planContext),
    ``,
    `Classify this change's RISK — exactly one of:`,
    `  low   — coherent with the plan, well-trodden, gates state is clean; safe to proceed`,
    `  high  — drifts from the plan, unusual, or the gates state itself is concerning`,
    ``,
    `MACHINE-READABLE OUTPUT (required, in addition to any prose): emit exactly one of`,
    `each of these lines, and nothing else on the line:`,
    `  RISK_VERDICT: <low|high>`,
    `  RISK_CONFIDENCE: <0.0-1.0>`,
    `and one or more lines naming the OBSERVED basis for your verdict — observed IN`,
    `THE TEXT ABOVE, never an inferred symptom of code you have not read (the`,
    `W1-T186 emitter discipline, applied to this judge's own evidentiary limits):`,
    `  RISK_REASON: <what the description/files/gates state above actually shows>`,
  ].join("\n");
}

const VALID_VERDICTS = new Set<RiskJudgeVerdictLabel>(["low", "high"]);

/**
 * FAIL-CLOSED default when the judge's response carries no parseable
 * RISK_VERDICT (malformed output, off-contract prose, …) — mirrors
 * flight-judge.ts's `FAIL_CLOSED_VERDICT` and review.ts's "never silently
 * proceed" doctrine: an unreadable judge response is itself evidence the
 * decision needs a human, not a reason to wave it through.
 */
const FAIL_CLOSED_VERDICT: RiskJudgeVerdict = {
  verdict: "high",
  confidence: 1,
  reasons: ["judge output carried no parseable RISK_VERDICT — failing closed (never silent-proceed)"],
};

/**
 * Parse the judge's `RISK_VERDICT`/`RISK_CONFIDENCE`/`RISK_REASON` lines into
 * a {@link RiskJudgeVerdict}. Missing/unrecognized verdict fails closed
 * ({@link FAIL_CLOSED_VERDICT}); a missing/invalid confidence defaults to 0
 * (never assume high confidence that was never stated). Case-insensitive,
 * tolerant of surrounding prose.
 */
export function parseRiskJudgeVerdict(text: string): RiskJudgeVerdict {
  const verdictMatch = text.match(/RISK_VERDICT:\s*(\w+)/i);
  const confMatch = text.match(/RISK_CONFIDENCE:\s*([\d.]+)/i);

  const verdict = verdictMatch?.[1]?.toLowerCase() as RiskJudgeVerdictLabel | undefined;
  if (!verdict || !VALID_VERDICTS.has(verdict)) {
    return { ...FAIL_CLOSED_VERDICT, reasons: [...FAIL_CLOSED_VERDICT.reasons] };
  }

  let confidence = confMatch ? Number(confMatch[1]) : 0;
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));

  const reasons = [...text.matchAll(/RISK_REASON:\s*(.+)/gi)].map((m) => m[1].trim());

  return { verdict, confidence, reasons };
}

// ── The deterministic controller (Standing rule 12: judgment is advisory;
// supervision/action is deterministic — mirrors flight-judge.ts's
// planJudgeAction / risk-score.ts's planRiskGate) ─────────────────────────

export type RiskJudgeActionKind = "proceed" | "escalate";

export interface RiskJudgeAction {
  kind: RiskJudgeActionKind;
  reason: string;
}

export interface RiskJudgeConfig {
  /** Below this self-reported confidence, even a `low` verdict escalates. Default 0.7. */
  confidenceThreshold?: number;
}

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * W1-T454: {@link RiskJudgeChange} carries only a free-text `description` and a
 * `files` path list — never a patch — so every reason a LIVE judge call produces is
 * necessarily an INFERENCE from that text, not an observation of code. Issue #1723
 * printed four such inferences in the grammar of observations ('Unspent nonces ARE
 * never deleted') against a diff that refuted every one, because nothing forced the
 * printed reason to say what it actually rests on. This wraps each reason with its
 * true evidence basis BY CONSTRUCTION — a deterministic string transform downstream
 * of the judge's own text, not a prompt instruction it could ignore or comply with
 * inconsistently — so the text a human reads in the escalation is honest even when
 * the judge's own prose is not.
 *
 * The two internal fail-closed reasons ({@link FAIL_CLOSED_VERDICT} and the catch
 * branch in {@link assessRisk}, both prefixed "judge ...") are exempt: they already
 * truthfully name their OWN basis — the judge's unavailability or unparseable
 * output — not a claim about the change, so qualifying them again would be noise
 * at best and misleading at worst (they have nothing to do with the description).
 */
function evidenceQualifiedReason(reason: string): string {
  if (reason.startsWith("judge ")) return reason;
  return `on the change's description/files alone, no diff was read — ${reason}`;
}

function reasonsText(verdict: RiskJudgeVerdict): string {
  if (verdict.reasons.length === 0) return "no reasons stated";
  return verdict.reasons.map(evidenceQualifiedReason).join("; ");
}

/**
 * Pure verdict -> action mapping, no LLM call inside it: `high` OR
 * below-confidence ESCALATES (naming the verdict's own reasons, each wrapped by
 * {@link evidenceQualifiedReason} — W1-T454 — with the evidence it actually rests
 * on, the W1-T186 emitter discipline applied to the judge's own evidentiary
 * limits); otherwise PROCEEDS. The static `risk:` field plays no part — this
 * function's only inputs are the judge's own verdict and the confidence floor.
 */
export function planRiskJudgeAction(verdict: RiskJudgeVerdict, config: RiskJudgeConfig = {}): RiskJudgeAction {
  const threshold = config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  if (verdict.verdict === "high") {
    return {
      kind: "escalate",
      reason: `high-risk verdict at confidence ${verdict.confidence.toFixed(2)} — ${reasonsText(verdict)}`,
    };
  }
  if (verdict.confidence < threshold) {
    return {
      kind: "escalate",
      reason: `low-confidence verdict (${verdict.confidence.toFixed(2)} < ${threshold}) — ${reasonsText(verdict)}`,
    };
  }
  return {
    kind: "proceed",
    reason: `low-risk at confidence ${verdict.confidence.toFixed(2)} — ${reasonsText(verdict)}`,
  };
}

// ── Stability (W1-T178 doctrine, applied to the judge itself) ────────────
// A live judge call is an LLM round-trip, so it cannot be trusted to
// reproduce bit-for-bit on its own; the cache is what MAKES it stable on
// unchanged input, the same shape as review.ts's W1-T178 rule reusing a
// prior verdict rather than trusting a fresh, possibly-flapped one.

/** Deterministic, order-independent serialization — object keys are sorted
 *  recursively so two structurally-equal inputs built in different key
 *  orders still produce the SAME cache key. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The canonical cache key for one {@link RiskJudgeInput} — same input, same key,
 *  regardless of object key insertion order. */
export function canonicalRiskJudgeInputKey(input: RiskJudgeInput): string {
  return stableStringify(input);
}

/** Minimal cache contract {@link assessRisk} consults for stability. */
export interface RiskJudgeCache {
  get(key: string): RiskJudgeVerdict | undefined;
  set(key: string, verdict: RiskJudgeVerdict): void;
}

/** A plain in-memory cache — enough for one process's lifetime (one drain run). */
export function createInMemoryRiskJudgeCache(): RiskJudgeCache {
  const store = new Map<string, RiskJudgeVerdict>();
  return {
    get: (key) => store.get(key),
    set: (key, verdict) => {
      store.set(key, verdict);
    },
  };
}

// ── assessRisk: the reusable organ (acceptance criterion 6) ──────────────

export interface RiskJudgeDeps {
  /** Spawn the fresh judge and return its verdict. Real callers wire this to
   *  {@link spawnRiskJudgeWorker} + {@link parseRiskJudgeVerdict}; tests inject a fake. */
  judge: (input: RiskJudgeInput) => Promise<RiskJudgeVerdict>;
  /** Optional stability cache (W1-T178 doctrine) — when supplied, an unchanged input
   *  short-circuits to the previously-computed verdict instead of re-invoking `judge`. */
  cache?: RiskJudgeCache;
}

/**
 * Assess ONE candidate change: `{change, gatesState, planContext} ->
 * {verdict, reasons, confidence}` (acceptance criterion 6 — the reusable
 * shape, no dispatch-only coupling anywhere in this function).
 *
 * JUDGE-UNAVAILABLE (a spawn error, a timeout, any thrown rejection) is
 * caught HERE and turned into a fail-closed `high`/confidence-0 verdict —
 * never silent-proceed, the cannot-observe->wait polarity (W1-T130) applied
 * to the judge itself. Every reuse site gets this guarantee for free; a
 * caller cannot forget to handle it.
 *
 * STABLE ON UNCHANGED INPUT (W1-T178 doctrine): when `deps.cache` is
 * supplied, re-assessing an unchanged input returns the cached verdict
 * rather than re-invoking `judge` (which, being an LLM call, is not itself
 * guaranteed to reproduce bit-for-bit).
 */
export async function assessRisk(input: RiskJudgeInput, deps: RiskJudgeDeps): Promise<RiskJudgeVerdict> {
  const key = canonicalRiskJudgeInputKey(input);
  const cached = deps.cache?.get(key);
  if (cached) return cached;

  let verdict: RiskJudgeVerdict;
  try {
    verdict = await deps.judge(input);
  } catch (err) {
    verdict = {
      verdict: "high",
      confidence: 0,
      reasons: [
        `judge unavailable (${err instanceof Error ? err.message : String(err)}) — failing closed to ESCALATE, ` +
          "never silent-proceed (the cannot-observe→wait polarity, W1-T130, applied to the judge itself)",
      ],
    };
  }

  deps.cache?.set(key, verdict);
  return verdict;
}

// ── runRiskJudge: the dispatch-side DI orchestrator ───────────────────────
// Mirrors flight-judge.ts's runFlightJudge: real callers wire `judge` to a
// real spawn and `escalate` to escalate.ts's own `escalate()`; no dispatch
// coupling lives inside assessRisk/planRiskJudgeAction themselves — only
// HERE, one layer up, exactly where P28 is free to NOT reuse this
// orchestrator and instead wrap assessRisk in its own.

export interface RiskJudgeOrchestratorDeps extends RiskJudgeDeps {
  /** Open (or reuse) a needs-human escalation for this verdict/action. Mirrors
   *  escalate.ts's `escalate()` — sync or async, either is accepted. */
  escalate: (verdict: RiskJudgeVerdict, action: RiskJudgeAction) => Promise<string> | string;
  /** One ledger-shaped line per step; no-op default (real callers ledger it). */
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

export interface RiskJudgeResult {
  verdict: RiskJudgeVerdict;
  action: RiskJudgeAction;
  escalationUrl?: string;
}

/**
 * Assess one candidate change and act deterministically on the verdict:
 * PROCEED (nothing further happens) or ESCALATE (`deps.escalate` is called).
 * Ledgers ONE `risk_judge.decision` line carrying the verdict, reasons, AND
 * confidence VERBATIM (round ii) — before deciding whether to escalate, so
 * the ledger line exists regardless of what `deps.escalate` itself does.
 */
export async function runRiskJudge(
  input: RiskJudgeInput,
  deps: RiskJudgeOrchestratorDeps,
  config: RiskJudgeConfig = {},
): Promise<RiskJudgeResult> {
  const log = deps.log ?? (() => {});
  const verdict = await assessRisk(input, deps);
  const action = planRiskJudgeAction(verdict, config);

  log("risk_judge.decision", {
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    confidence: verdict.confidence,
    action: action.kind,
    reason: action.reason,
  });

  if (action.kind === "escalate") {
    const url = await deps.escalate(verdict, action);
    log("risk_judge.escalated", { issue_url: url });
    return { verdict, action, escalationUrl: url };
  }
  return { verdict, action };
}

// ── Mount resolution: the cheapest configured tier (haiku-class, W1-T5) ──

/**
 * Resolve the CHEAPEST mount configured anywhere in the routing table — the
 * haiku-class tier the design calls for, without hardcoding a model name:
 * this scans every `routes.<type>.<risk>.<class>` cell (deterministic
 * traversal order: type/risk/class keys sorted, so the result is stable
 * regardless of the YAML's own key order) and keeps the mount whose model
 * has the LOWEST `tiers` rank (ties broken by the lowest `efforts` rank).
 * Throws {@link MountsError} if the table defines no routes at all (would
 * already have failed {@link import("./mounts.js").validateMounts} at load).
 */
export function resolveRiskJudgeMount(mounts: Mounts): Mount {
  let best: Mount | undefined;
  let bestTierRank = Infinity;
  let bestEffortRank = Infinity;

  for (const type of Object.keys(mounts.routes).sort()) {
    const byRisk = mounts.routes[type];
    for (const risk of Object.keys(byRisk).sort()) {
      const byClass = byRisk[risk];
      for (const cls of Object.keys(byClass).sort()) {
        const mount = byClass[cls];
        const tierRank = mounts.tiers[mount.model];
        const effortRank = mounts.efforts[mount.effort];
        if (tierRank < bestTierRank || (tierRank === bestTierRank && effortRank < bestEffortRank)) {
          best = mount;
          bestTierRank = tierRank;
          bestEffortRank = effortRank;
        }
      }
    }
  }

  if (!best) {
    throw new MountsError("no worker mount found in mounts.yaml routes to resolve the risk judge's cheapest tier from.");
  }
  return best;
}

// ── The real spawn (mirrors flight-judge.ts's spawnFlightJudgeWorker) ─────

/** The judge's SDK tool allowlist — EMPTY by construction, same rationale as
 *  flight-judge.ts's `JUDGE_TOOLS`: everything it needs is already baked into
 *  the prompt, so it has no need (and no ability) to explore the worktree. */
export const RISK_JUDGE_TOOLS: string[] = [];

/** Build the {@link SpawnWorkerArgs} for a real risk-judge spawn — a pure
 *  function so the "no write tool, cheapest mount" contract is unit-testable
 *  without a spawn. */
export function buildRiskJudgeSpawnArgs(opts: {
  input: RiskJudgeInput;
  mount: Mount;
  cwd: string;
  settingsFile: string;
}): SpawnWorkerArgs {
  return {
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    prompt: buildRiskJudgePrompt(opts.input),
    model: opts.mount.model,
    effort: opts.mount.effort,
    maxTurns: opts.mount.maxTurns,
    tools: RISK_JUDGE_TOOLS,
  };
}

/** Spawn the real risk judge and parse its verdict. Untested by unit (it shells
 *  out via the SDK, same as every other real spawn in worker.ts) —
 *  {@link buildRiskJudgeSpawnArgs} and {@link parseRiskJudgeVerdict} carry the
 *  testable contract. `spawn` is injectable so a real caller can thread its own
 *  already-resolved worker-spawn dependency through (mirrors run-task.ts's own
 *  `opts.spawn ?? spawnWorker` idiom). */
export async function spawnRiskJudgeWorker(opts: {
  input: RiskJudgeInput;
  mount: Mount;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): Promise<WorkerResult> {
  const spawn = opts.spawn ?? spawnWorker;
  return spawn(buildRiskJudgeSpawnArgs(opts));
}

/** Build a `judge` function ({@link RiskJudgeDeps.judge}) wired to a real spawn —
 *  the production wiring for {@link assessRisk}/{@link runRiskJudge}. */
export function realRiskJudge(opts: {
  mount: Mount;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): (input: RiskJudgeInput) => Promise<RiskJudgeVerdict> {
  return async (input: RiskJudgeInput) => {
    const result = await spawnRiskJudgeWorker({ input, mount: opts.mount, cwd: opts.cwd, settingsFile: opts.settingsFile, spawn: opts.spawn });
    return parseRiskJudgeVerdict(result.text);
  };
}
