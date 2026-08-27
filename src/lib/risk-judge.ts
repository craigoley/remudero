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

/**
 * One touched file's bounded change-SHAPE (W1-T1031): the path plus per-file added/deleted
 * LINE COUNTS — never the lines themselves, never a hunk, never a patch. A count is not
 * something a judge can misread as having "read the code" the way a code excerpt could.
 */
export interface RiskJudgeChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * A BOUNDED, REST-sourced view of the change's ACTUAL diff shape (W1-T1031 — "round 2" of
 * W1-T454's Option A, Option B having shipped as #1740). Distinct from {@link
 * RiskJudgeChange.files}, which is the caller's DECLARED file list (a shard's `files:`, or
 * whatever a caller supplies) — this task's own measurement found that list insufficient: a
 * description that correctly NAMES the defect it removes reads to the judge exactly like a
 * description that INTRODUCES one, because nothing about the change's real shape was ever
 * shown (10/75 `risk_judge.decision` rows escalated, 9 merged anyway, none prevented anything;
 * three same-day escalations on implementations whose descriptions named their own subject).
 *
 * CAPPED at {@link RISK_JUDGE_CHANGE_VIEW_FILE_CAP} files via {@link boundRiskJudgeChangeView}
 * — design clause (iii): "a judge that times out on large changes is worse than one that
 * misreads small ones", so the bound is the deliverable, not the diff. `truncated` says so
 * honestly when the cap actually fired, the same discipline {@link evidenceQualifiedReason}
 * already applies to the judge's own output — never a silent drop.
 *
 * STILL NOT A DIFF. `buildRiskJudgePrompt`'s "no patch, no hunks, no code" instruction
 * (W1-T454) stays true with this field populated — see that function's own doc. This task
 * does not touch {@link evidenceQualifiedReason}: a bounded view is still not the whole
 * patch, and the reason text must keep saying so (design clause vii).
 */
export interface RiskJudgeChangeView {
  files: RiskJudgeChangedFile[];
  /** True when the real file list was longer than {@link RISK_JUDGE_CHANGE_VIEW_FILE_CAP} and
   *  had to be cut — an honest admission, never a silent truncation. */
  truncated: boolean;
}

/**
 * The file-count cap {@link boundRiskJudgeChangeView} enforces. The judge's mount resolves to
 * the CHEAPEST configured tier ({@link resolveRiskJudgeMount}) — this repo's own mounts.yaml
 * puts that floor at 40,000 tokens of context (haiku/low). One rendered line per file
 * (`path: +N/-M`) runs well under 100 characters even for a long path, so 60 files caps this
 * section at roughly 6,000 characters — under 2,000 tokens, a small fraction of the floor —
 * while comfortably covering every shard this fleet has filed (`files:` in plan/tasks.d/ is
 * almost always 1-4 paths; W1-T1031's own declared list is 3). A PR that genuinely touches
 * more than 60 files (a vendored dependency bump, a mass rename) is exactly the shape a
 * line-count summary stops being useful for anyway — the honest `truncated` flag is preferable
 * to either silently dropping files or letting one outlier PR inflate every prompt after it.
 */
export const RISK_JUDGE_CHANGE_VIEW_FILE_CAP = 60;

/** Apply {@link RISK_JUDGE_CHANGE_VIEW_FILE_CAP} to a REST-sourced file list — the ONE place
 *  both the real REST reader (src/run-task.ts's `changeView`) and any test-built list apply
 *  the SAME bound, so the two can never drift apart. */
export function boundRiskJudgeChangeView(files: RiskJudgeChangedFile[]): RiskJudgeChangeView {
  return {
    files: files.slice(0, RISK_JUDGE_CHANGE_VIEW_FILE_CAP),
    truncated: files.length > RISK_JUDGE_CHANGE_VIEW_FILE_CAP,
  };
}

/** The candidate change under assessment. Deliberately has no `risk` field —
 *  there is nowhere to put the static sizing artifact, so a caller cannot
 *  leak it in even by mistake (mirrors flight-judge.ts's `JudgeTurnEvidence`
 *  never carrying the worker's own narration). */
export interface RiskJudgeChange {
  /** Human-readable description of the change (diff summary, PR title/body, etc). */
  description: string;
  /** Touched file paths, when known — the caller's DECLARED list (e.g. a shard's `files:`). */
  files?: string[];
  /** OPTIONAL bounded, REST-sourced view of the change's ACTUAL diff shape (W1-T1031) — see
   *  {@link RiskJudgeChangeView}'s own doc. Optional because a caller without a real PR yet
   *  (or P28's future reuse site, before one exists) has none to supply; when present, {@link
   *  buildRiskJudgePrompt} renders it as a SEPARATE, clearly-labeled section from `files`
   *  above, distinguishing "what the caller declared" from "what the diff actually shows". */
  changeView?: RiskJudgeChangeView;
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

/** The reusable input shape (acceptance criterion 6): `{change, gatesState, planContext}`.
 *
 * `prNumber`/`headSha` (W1-T970) are OPTIONAL and dispatch-only — never rendered into the
 * judge's prompt ({@link buildRiskJudgePrompt} reads only `change`/`gatesState`/`planContext`,
 * unchanged) and never required by a reuse site (P28's caller simply omits them, exactly as
 * acceptance-6's "callable with only {change, gatesState, planContext}" test already pins).
 * They exist so {@link runRiskJudge} can write a SHA-KEYED `risk_judge.escalated` row: the
 * sweep's arming predicate (src/lib/sweep.ts's `priorActionsFromLedger`) has no other way to
 * learn which PR/head a refusal binds to, and a refusal it cannot bind to a head is a refusal
 * the next sweep pass silently erases. THE CALLER MUST SUPPLY THE HEAD IT ACTUALLY ASSESSED —
 * never a re-read at write time — because a refusal keyed to a head the judge never saw is
 * worse than none. */
export interface RiskJudgeInput {
  change: RiskJudgeChange;
  gatesState: RiskJudgeGatesState;
  planContext: RiskJudgePlanContext;
  /** The PR number this candidate change belongs to, when the caller has one. */
  prNumber?: number;
  /** The head sha this candidate change was assessed at, when the caller has one — MUST be the
   *  exact head {@link assessRisk} judged, not a value re-read later. */
  headSha?: string;
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
function renderChangeViewLines(changeView: RiskJudgeChangeView | undefined): string[] {
  if (!changeView) {
    return [`ACTUAL CHANGE (REST-sourced, W1-T1031): (no bounded change view supplied)`];
  }
  if (changeView.files.length === 0) {
    return [`ACTUAL CHANGE (REST-sourced, W1-T1031): (0 files reported)`];
  }
  const lines = [
    `ACTUAL CHANGE (REST-sourced, W1-T1031 — the real touched-file list, distinct from`,
    `FILES TOUCHED above, with each file's added/deleted LINE COUNTS only — never the`,
    `lines themselves, never a hunk, never a patch):`,
    ...changeView.files.map((f) => `  ${f.path}: +${f.additions}/-${f.deletions}`),
  ];
  if (changeView.truncated) {
    lines.push(`  … (truncated at ${RISK_JUDGE_CHANGE_VIEW_FILE_CAP} files; more files were touched)`);
  }
  return lines;
}

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
    `A BOUNDED, REST-SOURCED VIEW OF THE ACTUAL CHANGE MAY ALSO APPEAR BELOW`,
    `(W1-T1031, labeled ACTUAL CHANGE) — the real touched-file list with each file's`,
    `added/deleted LINE COUNTS, sourced fresh from the PR rather than the caller's`,
    `declared FILES TOUCHED list. This is STILL NOT A DIFF: a line count is not code`,
    `you have read, so the instruction above applies to it exactly as it applies to`,
    `everything else here — do not phrase a reason as though a count showed you what`,
    `the added/deleted lines actually say.`,
    ``,
    `THE DESCRIPTION NAMES THE DEFECT THE TASK EXISTS TO REMOVE (W1-T2284): every`,
    `shard this fleet files is titled as a defect statement, in the NEGATIVE VOICE —`,
    `stating what is currently BROKEN. The CANDIDATE CHANGE description below is`,
    `built from that title, so it is naming the defect the change under assessment`,
    `REMOVES, not a defect the change introduces. THE CHANGE IS THE REMEDY, not a`,
    `restatement of the problem — the more precisely the description names what is`,
    `wrong, the more precisely the fix is doing its job. Do NOT classify a change`,
    `HIGH on the strength of the description alone, and do not read a sharply-named`,
    `defect as evidence the change is dangerous.`,
    ``,
    `THIS FRAMING IS NOT A LICENCE. It tells you what the description IS, not that`,
    `the change is therefore safe: if the GATES STATE below is itself concerning, or`,
    `the change drifts from the plan or established practice, or the ACTUAL CHANGE`,
    `shape looks unusual, classify HIGH exactly as you would otherwise — regardless`,
    `of how the description reads.`,
    ``,
    `CANDIDATE CHANGE: ${input.change.description}`,
    `FILES TOUCHED (declared): ${filesLine}`,
    ``,
    ...renderChangeViewLines(input.change.changeView),
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
 * THE THIRD STATE (W1-T2212), AS A TYPE, NOT A POLICY. An unparseable judge response is NOT a
 * verdict — it carries no `verdict`/`confidence`/`reasons` at all, so nothing downstream can
 * mistake it for one by reading a label. {@link parseRiskJudgeResponse} is the ONE place raw
 * judge text becomes either a real {@link RiskJudgeVerdict} (`kind: "parsed"`) or this
 * (`kind: "unparseable"`) — a caller that wants to retry ONLY on the latter (design (i): "the
 * retry branch is reachable ONLY from that arm") narrows on `.kind`, not on a boolean or a
 * string field living inside a shared verdict shape (which would re-create the exact defect
 * this task exists to remove, one level down).
 */
export type RiskJudgeParseOutcome =
  | { kind: "parsed"; verdict: RiskJudgeVerdict }
  | { kind: "unparseable"; raw: string };

/**
 * Parse the judge's `RISK_VERDICT`/`RISK_CONFIDENCE`/`RISK_REASON` lines. Missing/unrecognized
 * `RISK_VERDICT` is UNPARSEABLE — a distinct state (see {@link RiskJudgeParseOutcome}), never a
 * fabricated `RiskJudgeVerdict` — so the only thing a caller can do with it is retry or fail
 * closed, never mistake it for a real judgment. A missing/invalid confidence on a PARSED verdict
 * still defaults to 0 (never assume high confidence that was never stated). Case-insensitive,
 * tolerant of surrounding prose.
 */
export function parseRiskJudgeResponse(text: string): RiskJudgeParseOutcome {
  const verdictMatch = text.match(/RISK_VERDICT:\s*(\w+)/i);
  const confMatch = text.match(/RISK_CONFIDENCE:\s*([\d.]+)/i);

  const verdict = verdictMatch?.[1]?.toLowerCase() as RiskJudgeVerdictLabel | undefined;
  if (!verdict || !VALID_VERDICTS.has(verdict)) {
    return { kind: "unparseable", raw: text };
  }

  let confidence = confMatch ? Number(confMatch[1]) : 0;
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));

  const reasons = [...text.matchAll(/RISK_REASON:\s*(.+)/gi)].map((m) => m[1].trim());

  return { kind: "parsed", verdict: { verdict, confidence, reasons } };
}

/**
 * FAIL-CLOSED default for {@link parseRiskJudgeVerdict}'s old one-shot contract — BYTE-IDENTICAL
 * to this file's pre-W1-T2212 shape (never touched by this task: `test/risk-judge.test.ts` is
 * outside its declared `files:` scope, so this constant, and the function below that returns it,
 * keep their exact prior value/text rather than being folded into {@link
 * MALFORMED_RESPONSE_VERDICT}'s new confidence-0 wording).
 */
const FAIL_CLOSED_VERDICT: RiskJudgeVerdict = {
  verdict: "high",
  confidence: 1,
  reasons: ["judge output carried no parseable RISK_VERDICT — failing closed (never silent-proceed)"],
};

/**
 * Back-compat single-shot parse: a real {@link RiskJudgeVerdict} either way, collapsing
 * {@link RiskJudgeParseOutcome}'s `unparseable` arm into {@link FAIL_CLOSED_VERDICT} with no
 * retry — unchanged from before this task. {@link realRiskJudge} does NOT use this — it retries
 * on the `unparseable` arm directly via {@link parseRiskJudgeResponse} (W1-T2212) and fails
 * closed to {@link MALFORMED_RESPONSE_VERDICT} instead, only once its bound is exhausted.
 */
export function parseRiskJudgeVerdict(text: string): RiskJudgeVerdict {
  const outcome = parseRiskJudgeResponse(text);
  if (outcome.kind === "parsed") return outcome.verdict;
  return { ...FAIL_CLOSED_VERDICT, reasons: [...FAIL_CLOSED_VERDICT.reasons] };
}

/**
 * FAIL-CLOSED default once every bounded retry ({@link RISK_JUDGE_MAX_ATTEMPTS},
 * {@link realRiskJudge}) has still produced no parseable `RISK_VERDICT` — mirrors
 * flight-judge.ts's `FAIL_CLOSED_VERDICT` and review.ts's "never silently proceed" doctrine: an
 * unreadable judge response is itself evidence the decision needs a human, not a reason to wave
 * it through. `confidence: 0` (never 1, W1-T2212 design (iv)) — this judge never READ a verdict,
 * so it must use the SAME "never assume high confidence that was never stated" default
 * {@link parseRiskJudgeResponse}'s own parsed path already uses for an absent
 * `RISK_CONFIDENCE`, not the opposite extreme. The reasons text names this a MALFORMED RESPONSE
 * explicitly, apart from an adverse judgment (acceptance criterion 6) — the exact confusion
 * issue #2696's title (`ESCALATED (high, confidence 1.00)`) caused when this was 1. Distinct from
 * {@link FAIL_CLOSED_VERDICT} above (the OLD one-shot contract's unchanged fallback): ONLY
 * {@link realRiskJudge}'s bound-exhausted branch ever returns this one.
 */
const MALFORMED_RESPONSE_VERDICT: RiskJudgeVerdict = {
  verdict: "high",
  confidence: 0,
  reasons: [
    "judge output carried no parseable RISK_VERDICT — failing closed (never silent-proceed); " +
      "this is a MALFORMED RESPONSE, not an adverse risk judgment",
  ],
};

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
 * The internal fail-closed reasons ({@link FAIL_CLOSED_VERDICT}, {@link MALFORMED_RESPONSE_VERDICT}
 * and the catch branch in {@link assessRisk}, all prefixed "judge ...") are exempt: they already
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

/**
 * W1-T2383 (rank 1) — WHAT ONE RISK-JUDGE JUDGMENT COST, carried from the spawn that paid it to
 * the `risk_judge.decision` row that reports it.
 *
 * THE ROW EXISTS AND THE FIGURE DOES NOT: measured 2026-08-27, 276 risk-judge rows (249 decisions,
 * 27 escalations) carry no cost and no mount, so {@link resolveRiskJudgeMount}'s DELIBERATE choice
 * of the cheapest configured tier is a design decision whose consequence nobody can read. This
 * type is what makes it readable; it changes no verdict, no threshold and no mount.
 *
 * THE CAP RIDES BESIDE THE COUNT, never instead of it — the same W1-T2238/W1-T303 discipline
 * `WorkerResult.maxTurns` already records: a historical row must stay checkable against its own
 * cap after `mounts.yaml` moves.
 */
export interface RiskJudgeSpend {
  /** Summed `WorkerResult.costUsd` across every spawn this judgment paid for. */
  costUsd: number;
  /** Summed `WorkerResult.numTurns` across those same spawns. */
  numTurns: number;
  /** The configured cap each spawn ran under (an INPUT, never read back). */
  maxTurns?: number;
  /** The mount actually spawned — the tier whose price this row makes readable. */
  model: string;
  effort: string;
  /** Billing account, so a wired spend reader credits the row instead of refusing it. */
  accountLabel?: string;
  /** How many spawns this judgment paid for — 1 on the healthy path (W1-T2212). */
  attempts: number;
}

/**
 * The one place a judgment's spend is accumulated. {@link realRiskJudge} RECORDS one entry per
 * spawn; {@link runRiskJudge} READS the total once, just before it writes the row it already
 * writes. Two seams would let the summing rule live in two places — this keeps it in one.
 *
 * A judgment that SPAWNED NOTHING reports `undefined`, never a zero: a cache hit
 * ({@link RiskJudgeDeps.cache}) and a judge that threw before any spawn both genuinely cost
 * nothing to spawn, and a `0` would read as "measured, free" rather than "not measured".
 */
export interface RiskJudgeSpendCollector {
  record(entry: RiskJudgeSpend): void;
  total(): RiskJudgeSpend | undefined;
}

/** Build a fresh {@link RiskJudgeSpendCollector}. One per judgment — never shared across two. */
export function riskJudgeSpendCollector(): RiskJudgeSpendCollector {
  let acc: RiskJudgeSpend | undefined;
  return {
    record(entry: RiskJudgeSpend): void {
      acc =
        acc === undefined
          ? { ...entry }
          : {
              ...entry,
              costUsd: acc.costUsd + entry.costUsd,
              numTurns: acc.numTurns + entry.numTurns,
              attempts: acc.attempts + entry.attempts,
            };
    },
    total(): RiskJudgeSpend | undefined {
      return acc;
    },
  };
}

export interface RiskJudgeOrchestratorDeps extends RiskJudgeDeps {
  /** Open (or reuse) a needs-human escalation for this verdict/action. Mirrors
   *  escalate.ts's `escalate()` — sync or async, either is accepted. */
  escalate: (verdict: RiskJudgeVerdict, action: RiskJudgeAction) => Promise<string> | string;
  /** One ledger-shaped line per step; no-op default (real callers ledger it). */
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** W1-T2383 (rank 1): the collector {@link realRiskJudge} recorded this judgment's spawns into.
   *  Omitted by a caller that wires none, in which case the decision row is byte-identical to
   *  before this field existed — the same omit-rather-than-undefined shape W1-T970 used for
   *  `pr_number`/`head_sha` on the sibling escalation row. */
  spend?: RiskJudgeSpendCollector;
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

  // W1-T2383 (rank 1): read ONCE, after `assessRisk` has done whatever spawning it was going to
  // do, and spread onto the SAME row rather than a second one — a field on a row already being
  // written costs no ledger line and needs no retention decision (the shard's own Q2). Every key
  // is OMITTED, not `undefined`, when no collector was wired.
  const spent = deps.spend?.total();
  log("risk_judge.decision", {
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    confidence: verdict.confidence,
    action: action.kind,
    reason: action.reason,
    ...(spent === undefined
      ? {}
      : {
          cost_usd: spent.costUsd,
          num_turns: spent.numTurns,
          ...(spent.maxTurns === undefined ? {} : { max_turns: spent.maxTurns }),
          model: spent.model,
          effort: spent.effort,
          ...(spent.accountLabel === undefined ? {} : { account_label: spent.accountLabel }),
          attempts: spent.attempts,
        }),
  });

  if (action.kind === "escalate") {
    const url = await deps.escalate(verdict, action);
    // W1-T970: pr_number/head_sha ride onto the SAME row the sweep's `priorActionsFromLedger`
    // reads back into its `riskRefused` set — see RiskJudgeInput's own doc for why these are
    // read straight off `input` rather than re-derived here. Omitted (not just `undefined`)
    // when the caller supplies neither, so a caller with no identifiers (e.g. a future P28
    // caller) ledgers byte-identical to before this task.
    log("risk_judge.escalated", {
      issue_url: url,
      ...(input.prNumber === undefined ? {} : { pr_number: input.prNumber }),
      ...(input.headSha === undefined ? {} : { head_sha: input.headSha }),
    });
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

/**
 * BACKSTOP (W1-T1266): the healthy path — a PARSED verdict, adverse or not — returns on attempt
 * 1, always; this bound fires only once something else has already failed (the judge repeatedly
 * returning unparseable output), never as the thing that normally stops the loop. The small, hard
 * bound on unparseable-response retries (W1-T2212 design (iii)): "a small attempt cap; at the
 * bound the SAME escalation fires as today, with the same class and the same blocking effect."
 * Never applies to a PARSED verdict — only {@link RiskJudgeParseOutcome}'s `unparseable` arm ever
 * reaches the retry branch in {@link realRiskJudge}.
 */
export const RISK_JUDGE_MAX_ATTEMPTS = 3;

/**
 * Build a `judge` function ({@link RiskJudgeDeps.judge}) wired to a real spawn — the production
 * wiring for {@link assessRisk}/{@link runRiskJudge}.
 *
 * THE RETRY RE-REQUESTS, IT NEVER RE-ASKS (W1-T2212 design (ii)): {@link buildRiskJudgeSpawnArgs}
 * is called EXACTLY ONCE, before the loop, and the SAME resulting args value (prompt included)
 * is handed to `spawn` on every attempt — nothing about the request varies between them. Only
 * {@link RiskJudgeParseOutcome}'s `unparseable` arm is reachable from `parseRiskJudgeResponse`
 * ({@link parseRiskJudgeResponse}) is retried, bounded at {@link RISK_JUDGE_MAX_ATTEMPTS}
 * (design iii); a PARSED verdict — `low` or `high` — returns immediately on the FIRST attempt
 * and is never retried (design vi: "No retry on any parsed verdict, adverse or not"). At the
 * bound, {@link MALFORMED_RESPONSE_VERDICT} is returned — still fail-closed to ESCALATE, exactly
 * as a single unparseable response always has. `opts.log`, when supplied, ledgers one row per
 * attempt (design iii: "each attempt writes its own ledger row so the count is auditable after
 * the fact rather than inferred") — optional and no-op by default so an existing caller that
 * supplies no `log` is byte-identical to before this parameter existed.
 */
export function realRiskJudge(opts: {
  mount: Mount;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
  maxAttempts?: number;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** W1-T2383 (rank 1): one entry per SPAWN, so a retried judgment (W1-T2212) reports what all
   *  of its attempts cost rather than only the last. Optional and no-op by default. */
  spend?: RiskJudgeSpendCollector;
}): (input: RiskJudgeInput) => Promise<RiskJudgeVerdict> {
  const spawn = opts.spawn ?? spawnWorker;
  const maxAttempts = opts.maxAttempts ?? RISK_JUDGE_MAX_ATTEMPTS;
  if (maxAttempts < 1) throw new Error("realRiskJudge: maxAttempts must be >= 1");
  return async (input: RiskJudgeInput) => {
    // Built ONCE, outside the loop, and reused BY REFERENCE on every attempt below — the
    // byte-identical request the falsifier test in test/unparseable-verdict-third-state.test.ts
    // pins.
    const spawnArgs = buildRiskJudgeSpawnArgs({ input, mount: opts.mount, cwd: opts.cwd, settingsFile: opts.settingsFile });
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await spawn(spawnArgs);
      // W1-T2383 (rank 1): recorded BEFORE the parse, so an UNPARSEABLE attempt's spend is
      // counted too — a retry that produced nothing readable still cost real money, and a
      // figure that silently dropped it would understate exactly the case worth watching.
      opts.spend?.record({
        costUsd: result.costUsd,
        numTurns: result.numTurns,
        maxTurns: result.maxTurns,
        model: opts.mount.model,
        effort: opts.mount.effort,
        accountLabel: result.accountLabel,
        attempts: 1,
      });
      const outcome = parseRiskJudgeResponse(result.text);
      opts.log?.("risk_judge.parse_attempt", { attempt, max_attempts: maxAttempts, kind: outcome.kind });
      if (outcome.kind === "parsed") return outcome.verdict;
      if (attempt === maxAttempts) {
        return {
          ...MALFORMED_RESPONSE_VERDICT,
          reasons: [
            `judge output carried no parseable RISK_VERDICT after ${attempt} attempt(s) — failing ` +
              "closed (never silent-proceed); this is a MALFORMED RESPONSE, not an adverse risk judgment",
          ],
        };
      }
    }
    /* c8 ignore next */
    throw new Error("realRiskJudge: unreachable — the loop above always returns by its last iteration");
  };
}
