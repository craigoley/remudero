import type { Mount, Mounts } from "./mounts.js";
import { MountsError } from "./mounts.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";

/**
 * Risk judge — P34 clause (b), MASTER-PLAN §4B/§9, W1-T248. A lightweight judge on the
 * dispatch path that assesses each CANDIDATE CHANGE — never the static `task.risk` field,
 * a sizing artifact (W1-T5/§9) that says nothing about a change's danger; {@link
 * RiskJudgeInput} has no field that could carry it in.
 *
 * DECISION SHAPE: low-risk-and-confident PROCEEDS; high-risk or low-confidence ESCALATES,
 * naming the OBSERVED blocker (W1-T186). Judgment ({@link RiskJudgeVerdict}) and action
 * ({@link planRiskJudgeAction}) stay separate — the mapping is pure, no LLM call inside it.
 *
 * JUDGE-UNAVAILABLE (spawn error, timeout, unparseable response) always falls back to
 * ESCALATE, never silent-proceeds (W1-T130) — enforced inside {@link assessRisk} itself.
 *
 * STABLE ON UNCHANGED INPUT (W1-T178): an optional {@link RiskJudgeCache}, keyed on {@link
 * canonicalRiskJudgeInputKey}, reuses a prior verdict rather than risking a flapped re-judgment.
 *
 * REUSABLE (for P28's future auto-ratification): {@link assessRisk} takes `{change,
 * gatesState, planContext}` and returns `{verdict, reasons, confidence}` with no dispatch-only
 * coupling; dispatch orchestration lives one layer up, in {@link runRiskJudge}.
 */
// Why: the mount-resolution rule and every measured incident behind these invariants are
// archived at docs/forensics/risk-judge.md#module-header.

// ── The verdict contract ────────────────────────────────────────────────

export type RiskJudgeVerdictLabel = "low" | "high";
export type RiskJudgeGateConsequence = "LAND" | "REPAIR" | "LAND+DEBT" | "STOP";

export const RISK_JUDGE_GATE_CONSEQUENCES: readonly RiskJudgeGateConsequence[] = [
  "LAND",
  "REPAIR",
  "LAND+DEBT",
  "STOP",
];

/** What the judge returns for one candidate change — the reusable shape acceptance
 *  criterion 6 names verbatim: `{verdict, reasons, confidence}`. */
export interface RiskJudgeVerdict {
  verdict: RiskJudgeVerdictLabel;
  /** Concrete, OBSERVED reasons (W1-T186) — never an inferred symptom. Ledgered verbatim. */
  reasons: string[];
  /** 0..1, the judge's OWN self-reported confidence. Ledgered verbatim (round ii). */
  confidence: number;
  /** Optional gate-posture consequence. Absent for ordinary change-risk judgments. */
  gateConsequence?: RiskJudgeGateConsequence;
}

// ── What the judge is shown — the candidate CHANGE, never task.risk ──────

/** One touched file's bounded change-SHAPE (W1-T1031): path plus added/deleted LINE
 *  COUNTS only — never the lines themselves, never a hunk, never a patch. */
export interface RiskJudgeChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * A bounded, REST-sourced view of the change's actual diff shape (W1-T1031) — distinct
 * from {@link RiskJudgeChange.files}, the caller's DECLARED file list. Capped at {@link
 * RISK_JUDGE_CHANGE_VIEW_FILE_CAP} files via {@link boundRiskJudgeChangeView}; `truncated`
 * says so honestly when the cap fires. Still not a diff — a line count, never code read.
 *
 * Why: the measured incident this view exists to fix, and the file-cap's sizing
 * argument, are archived at docs/forensics/risk-judge.md#riskjudgechangeview.
 */
export interface RiskJudgeChangeView {
  files: RiskJudgeChangedFile[];
  /** True when the file list was longer than the cap and had to be cut — an honest
   *  admission, never a silent truncation. */
  truncated: boolean;
}

/**
 * W1-T2991 — WHY A DECLARED FILE IS ABSENT FROM THE CHANGE, ANSWERED RATHER THAN INFERRED.
 *
 * MEASURED on #4316, 2026-09-06: the risk judge escalated at high risk / confidence 0.85 because
 * "the declared FILES TOUCHED list names src/lib/task-linter.ts, but the ACTUAL CHANGE shows only
 * [a test file] was modified ... represents both drift from plan and an unusual shape for an
 * implementation task". Its own verdict text states the limit that made it wrong: "on the change's
 * description/files alone, NO DIFF WAS READ". `ownFalsifierRenameCandidates` was already present in
 * that file at the PR's merge base — landed by #4019 — so the only missing piece was the falsifier
 * the PR added. A correct, green, review-passing PR was blocked and routed to a human.
 *
 * A declared source file absent from the changed set means ONE OF TWO THINGS — the work was not
 * done, or it was ALREADY done — and no amount of reasoning over a file list separates them. This
 * is the fact that does: the file EXISTS at the base, and the change's own tests REFERENCE it. That
 * shape is a test-only completion of behaviour that already landed, not drift.
 *
 * THE ASYMMETRY DECIDES EVERY UNCERTAIN CASE, AND IT RUNS OPPOSITE TO MOST GATES HERE. A false
 * negative costs one unimplemented task, which proof execution and the coverage gates already catch
 * downstream. A false positive costs an operator's attention EVERY TIME and trains them to close
 * escalations unread — strictly worse than not raising them. So absence of evidence is never
 * treated as evidence: an unreadable base, an unknown reference set, or any declared file this
 * cannot positively account for leaves the escalation exactly where the judge put it.
 */
export interface DeclaredFileBaseFact {
  /** The declared path that the actual change does not touch. */
  path: string;
  /** Did the file exist at the PR's merge base? `undefined` when the read failed — never assumed. */
  existsAtBase?: boolean;
  /** Do any of the change's own changed test files reference this file? `undefined` when unknown. */
  referencedByChangedTests?: boolean;
}

/**
 * True only when EVERY declared source file the change does not touch is positively accounted for:
 * present at the base and referenced by the change's own tests. Empty input is false — "nothing was
 * declared missing" is a different fact from "every missing thing is explained", and only the second
 * may suppress an escalation.
 */
export function isTestOnlyCompletionOfExistingBehaviour(facts: readonly DeclaredFileBaseFact[]): boolean {
  if (facts.length === 0) return false;
  return facts.every((f) => f.existsAtBase === true && f.referencedByChangedTests === true);
}

/**
 * The declared paths the ACTUAL CHANGE does not touch. Pure set arithmetic over the two lists the
 * judge is already given; a truncated change view yields no facts at all, because a path missing
 * from a capped list is not a path missing from the change.
 */
export function declaredFilesAbsentFromChange(
  declared: readonly string[] | undefined,
  changeView: RiskJudgeChangeView | undefined,
): string[] {
  if (!declared || declared.length === 0) return [];
  if (!changeView || changeView.truncated) return [];
  const touched = new Set(changeView.files.map((f) => f.path));
  return declared.filter((d) => !touched.has(d)).sort();
}

/** File cap {@link boundRiskJudgeChangeView} enforces — sized well under the judge's
 *  cheapest-tier context floor; a PR touching more files just reads `truncated: true`.
 *  Why: docs/forensics/risk-judge.md#risk_judge_change_view_file_cap. */
export const RISK_JUDGE_CHANGE_VIEW_FILE_CAP = 60;

/** Apply the cap to a REST-sourced file list — the ONE place both the real REST reader
 *  and any test-built list apply the SAME bound, so the two can never drift apart. */
export function boundRiskJudgeChangeView(files: RiskJudgeChangedFile[]): RiskJudgeChangeView {
  return {
    files: files.slice(0, RISK_JUDGE_CHANGE_VIEW_FILE_CAP),
    truncated: files.length > RISK_JUDGE_CHANGE_VIEW_FILE_CAP,
  };
}

/** The candidate change under assessment. Deliberately has no `risk` field — nowhere to
 *  put the static sizing artifact, so a caller cannot leak it in even by mistake. */
export interface RiskJudgeChange {
  /** Human-readable description of the change (diff summary, PR title/body, etc). */
  description: string;
  /** Touched file paths, when known — the caller's DECLARED list (e.g. a shard's `files:`). */
  files?: string[];
  /** Optional bounded, REST-sourced diff-shape view (W1-T1031); rendered as a section
   *  distinct from `files` above when present. */
  changeView?: RiskJudgeChangeView;
}

/** Loose/string-keyed by design: dispatch today and P28 tomorrow each track their own
 *  gates under whatever keys make sense to them — only that it gets shown. */
export interface RiskJudgeGatesState {
  [key: string]: unknown;
}

/** Plan coherence context — task id, plan refs, whatever the caller has. */
export interface RiskJudgePlanContext {
  taskId?: string;
  planRefs?: string[];
  [key: string]: unknown;
}

/** The reusable input shape (acceptance criterion 6): `{change, gatesState, planContext}`.
 *  `prNumber`/`headSha` (W1-T970) are optional, dispatch-only, and never rendered into the
 *  prompt — {@link runRiskJudge} needs them for a sha-keyed `risk_judge.escalated` row the
 *  sweep reads back. The caller MUST supply the head it actually assessed, never a re-read
 *  at write time. Why: docs/forensics/risk-judge.md#riskjudgeinput. */
export interface RiskJudgeInput {
  change: RiskJudgeChange;
  gatesState: RiskJudgeGatesState;
  planContext: RiskJudgePlanContext;
  /** The PR number this candidate change belongs to, when the caller has one. */
  prNumber?: number;
  /** The head sha this candidate change was assessed at — MUST be the exact head
   *  {@link assessRisk} judged, not a value re-read later. */
  headSha?: string;
}

// ── The fresh judge prompt (never shown the static risk: field) ──────────

function renderRecord(label: string, record: Record<string, unknown>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return `${label}:\n  (none supplied)`;
  const lines = entries.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n");
  return `${label}:\n${lines}`;
}

/** Render the ACTUAL CHANGE section for {@link buildRiskJudgePrompt} — still not a diff. */
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

function riskJudgeGateConsequenceLines(input: RiskJudgeInput): string[] {
  if (!("gate_finding" in input.gatesState)) return [];
  return [
    ``,
    `DETERMINISTIC GATE FINDING: the GATES STATE includes a gate_finding object.`,
    `Treat that finding as TRUE. Do not decide whether it happened, whether the`,
    `predicate is well-written, or whether the diff can talk it away. Judge only`,
    `the consequence the automation should take from that already-established fact.`,
    ``,
    `Choose exactly one gate consequence:`,
    `  LAND      — the finding is immaterial; proceed and ledger the reason`,
    `  REPAIR    — the remedy is computable; apply it and land`,
    `  LAND+DEBT — land only after filing a bounded follow-up for the deferred work`,
    `  STOP      — unrecoverable only: secrets, destructive migration, or broken recovery path`,
    ``,
    `STOP is not the consequence for ordinary incompleteness. If the finding is`,
    `recoverable but real, prefer REPAIR or LAND+DEBT.`,
  ];
}

/** Render the risk judge's prompt: candidate change, gates state, plan context — never
 *  the static `risk:` field. */
/**
 * W1-T2371 — a subject that DECLARES plan work rather than implementing it.
 *
 * THE SAME VOCABULARY as `FILING_SUBJECT_RE` (`src/lib/sweep.ts`), and IMPORTING IT WAS TRIED
 * FIRST. It cannot be: `risk-judge` -> `sweep` closes a cycle through `feedback.ts`, which
 * depcruise reports as 15 further `no-circular` violations (13 -> 28, MEASURED 2026-09-07). A
 * cycle to avoid a duplicated regex is the worse trade.
 *
 * SO DRIFT IS FORBIDDEN BY A TEST INSTEAD, not by convention: this file's own suite asserts this
 * pattern's `source` equals `FILING_SUBJECT_RE`'s, character for character. A test may import both
 * because tests are outside the module graph depcruise cruises — the one place the two lists can be
 * compared without creating the cycle. `lint-plan`'s failing-split already treats this exact
 * vocabulary as "a filing cites a task; it does not implement it".
 */
export const PLAN_DECLARING_SUBJECT_RE = /^(?:chore\(plan\)|fix\(plan\)|chore\(triage\)|chore\(feedback\)|docs\(plan\)|plan:|docs:|chore:)/;

/**
 * W1-T2371 — is this change a plan-only AMENDMENT: a filing-shaped subject over a diff that touches
 * nothing but `plan/`? The founding shape is a shard whose `files:` names src paths the diff does
 * not contain, which reads as misdeclared scope and is not.
 *
 * BOTH HALVES ARE REQUIRED, and each falsifier below is a real refusal rather than a formality. A
 * plan subject over a diff that also touches `src/` is judged exactly as today; a `feat(...)`
 * subject over a plan-only diff buys no narrowing however plan-ish it reads.
 *
 * A TRUNCATED VIEW CANNOT PROVE PLAN-ONLY, so it declines. Absence from a capped enumeration is not
 * absence from the change — the same reasoning `declaredFilesAbsentFromChange` already applies, and
 * the failure direction is toward today's behaviour rather than toward a narrower judgement.
 *
 * AN EMPTY VIEW DECLINES TOO: "no files observed" is not evidence that the files are all plan ones.
 */
export function isPlanOnlyAmendment(
  description: string | undefined,
  changeView: RiskJudgeChangeView | undefined,
): boolean {
  if (description === undefined || !PLAN_DECLARING_SUBJECT_RE.test(description.trim())) return false;
  if (changeView === undefined || changeView.truncated) return false;
  if (changeView.files.length === 0) return false;
  return changeView.files.every((file) => file.path.startsWith("plan/"));
}

export function buildRiskJudgePrompt(input: RiskJudgeInput): string {
  const filesLine = input.change.files?.length ? input.change.files.join(", ") : "(no files listed)";
  // W1-T2371: NARROWED ONLY on the founding shape, and the narrowing is stated to the judge rather
  // than applied silently — it may still classify HIGH for any other reason it sees.
  const planOnlyAmendmentNote = isPlanOnlyAmendment(input.change.description, input.change.changeView)
    ? [
        ``,
        `THIS IS A PLAN-ONLY AMENDMENT. The subject declares plan work and the observed`,
        `change touches nothing outside \`plan/\`. A shard's \`files:\` naming source paths this`,
        `diff does not contain is EXPECTED here, and is NOT`,
        `evidence of incomplete work or of misdeclared scope. Do not classify HIGH on`,
        `that mismatch alone.`,
        ``,
        `THIS NARROWS ONE INFERENCE ONLY. Every other ground for HIGH survives intact:`,
        `if the amendment weakens a criterion, contradicts a ruling, or drifts from`,
        `established practice, classify HIGH exactly as you would on any other change.`,
      ]
    : [];

  return [
    ...planOnlyAmendmentNote,
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
    ...riskJudgeGateConsequenceLines(input),
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
    ...("gate_finding" in input.gatesState ? [`  RISK_GATE_CONSEQUENCE: <LAND|REPAIR|LAND+DEBT|STOP>`] : []),
    `and one or more lines naming the OBSERVED basis for your verdict — observed IN`,
    `THE TEXT ABOVE, never an inferred symptom of code you have not read (the`,
    `W1-T186 emitter discipline, applied to this judge's own evidentiary limits):`,
    `  RISK_REASON: <what the description/files/gates state above actually shows>`,
  ].join("\n");
}

const VALID_VERDICTS = new Set<RiskJudgeVerdictLabel>(["low", "high"]);
const VALID_GATE_CONSEQUENCES = new Set<RiskJudgeGateConsequence>(RISK_JUDGE_GATE_CONSEQUENCES);

/** The third state (W1-T2212), as a TYPE, not a policy: an unparseable response carries no
 *  `verdict`/`confidence`/`reasons` at all, so callers narrow on `.kind`, never on a boolean
 *  or string field living inside a shared verdict shape. */
export type RiskJudgeParseOutcome =
  | { kind: "parsed"; verdict: RiskJudgeVerdict }
  | { kind: "unparseable"; raw: string };

/** Parse the judge's `RISK_VERDICT`/`RISK_CONFIDENCE`/`RISK_REASON` lines. A missing or
 *  unrecognized `RISK_VERDICT` is UNPARSEABLE, never a fabricated verdict. A missing/invalid
 *  confidence on a parsed verdict defaults to 0 — never an unstated high confidence. */
export function parseRiskJudgeResponse(text: string): RiskJudgeParseOutcome {
  const verdictMatch = text.match(/RISK_VERDICT:\s*(\w+)/i);
  const confMatch = text.match(/RISK_CONFIDENCE:\s*([\d.]+)/i);
  const gateConsequenceMatch = text.match(/RISK_GATE_CONSEQUENCE:\s*([A-Z+_-]+)/i);

  const verdict = verdictMatch?.[1]?.toLowerCase() as RiskJudgeVerdictLabel | undefined;
  if (!verdict || !VALID_VERDICTS.has(verdict)) {
    return { kind: "unparseable", raw: text };
  }

  const gateConsequence = gateConsequenceMatch?.[1]?.toUpperCase() as RiskJudgeGateConsequence | undefined;
  if (gateConsequence !== undefined && !VALID_GATE_CONSEQUENCES.has(gateConsequence)) {
    return { kind: "unparseable", raw: text };
  }

  let confidence = confMatch ? Number(confMatch[1]) : 0;
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));

  const reasons = [...text.matchAll(/RISK_REASON:\s*(.+)/gi)].map((m) => m[1].trim());

  return {
    kind: "parsed",
    verdict:
      gateConsequence === undefined
        ? { verdict, confidence, reasons }
        : { verdict, confidence, reasons, gateConsequence },
  };
}

/** Fail-closed default for {@link parseRiskJudgeVerdict}'s old one-shot contract — kept
 *  byte-identical to the pre-W1-T2212 shape; test/risk-judge.test.ts pins it. */
const FAIL_CLOSED_VERDICT: RiskJudgeVerdict = {
  verdict: "high",
  confidence: 1,
  reasons: ["judge output carried no parseable RISK_VERDICT — failing closed (never silent-proceed)"],
};

/** Back-compat single-shot parse: always returns a real verdict, collapsing `unparseable`
 *  into {@link FAIL_CLOSED_VERDICT} with no retry. {@link realRiskJudge} does not use this —
 *  it retries directly (W1-T2212) and fails closed to {@link MALFORMED_RESPONSE_VERDICT}. */
export function parseRiskJudgeVerdict(text: string): RiskJudgeVerdict {
  const outcome = parseRiskJudgeResponse(text);
  if (outcome.kind === "parsed") return outcome.verdict;
  return { ...FAIL_CLOSED_VERDICT, reasons: [...FAIL_CLOSED_VERDICT.reasons] };
}

/** Fail-closed default once every retry ({@link RISK_JUDGE_MAX_ATTEMPTS}) has produced no
 *  parseable `RISK_VERDICT`. `confidence: 0`, never 1 (W1-T2212 iv) — this judge never read
 *  a verdict. Names itself a MALFORMED RESPONSE, distinct from an adverse judgment.
 *  Why: docs/forensics/risk-judge.md#malformed_response_verdict. */
const MALFORMED_RESPONSE_VERDICT: RiskJudgeVerdict = {
  verdict: "high",
  confidence: 0,
  reasons: [
    "judge output carried no parseable RISK_VERDICT — failing closed (never silent-proceed); " +
      "this is a MALFORMED RESPONSE, not an adverse risk judgment",
  ],
};

// ── The deterministic controller (Standing rule 12: judgment advisory, action deterministic) ──

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

/** Wraps a judge-produced reason with its true evidence basis, BY CONSTRUCTION (W1-T454):
 *  issue #1723 printed inferences in the grammar of observations against a diff that
 *  refuted them, so this stays honest even when the judge's own prose is not. Internal
 *  fail-closed reasons (prefixed "judge …") are exempt — already truthful about their basis.
 *  Why: docs/forensics/risk-judge.md#evidencequalifiedreason. */
function evidenceQualifiedReason(reason: string): string {
  if (reason.startsWith("judge ")) return reason;
  return `on the change's description/files alone, no diff was read — ${reason}`;
}

function reasonsText(verdict: RiskJudgeVerdict): string {
  if (verdict.reasons.length === 0) return "no reasons stated";
  return verdict.reasons.map(evidenceQualifiedReason).join("; ");
}

/** Pure verdict → action mapping, no LLM call inside it: `high`, or below-confidence,
 *  ESCALATES; otherwise PROCEEDS. The static `risk:` field plays no part. */
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

// ── Stability (W1-T178): a live judge call can't reproduce bit-for-bit; the cache below
// is what makes it stable on unchanged input ──────────────────────────────────────────

/** Deterministic, order-independent serialization — keys sorted recursively so two
 *  structurally-equal inputs built in different key orders yield the SAME cache key. */
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
  /** Spawn the fresh judge and return its verdict; real callers wire this to
   *  {@link spawnRiskJudgeWorker} + {@link parseRiskJudgeVerdict}. */
  judge: (input: RiskJudgeInput) => Promise<RiskJudgeVerdict>;
  /** Optional stability cache (W1-T178) — an unchanged input short-circuits to the
   *  previously-computed verdict instead of re-invoking `judge`. */
  cache?: RiskJudgeCache;
}

/** Assess ONE candidate change: `{change, gatesState, planContext} -> {verdict, reasons,
 *  confidence}` (acceptance criterion 6). JUDGE-UNAVAILABLE (spawn error, timeout, thrown
 *  rejection) is caught HERE and turned into a fail-closed `high`/confidence-0 verdict —
 *  never silent-proceed (W1-T130); every reuse site inherits the guarantee. STABLE ON
 *  UNCHANGED INPUT (W1-T178): with `deps.cache`, an unchanged input returns the cached
 *  verdict rather than re-invoking `judge`. */
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

// ── runRiskJudge: the dispatch-side DI orchestrator (mirrors flight-judge.ts's
// runFlightJudge; P28 may wrap assessRisk in its own orchestrator instead) ────────────

/** W1-T2383 (rank 1): what one risk-judge judgment cost, carried from the spawn that paid
 *  it to the `risk_judge.decision` row that reports it — the cheapest-tier design choice
 *  was otherwise unmeasurable. The cap rides beside the count, so a historical row stays
 *  checkable against its own cap after `mounts.yaml` moves.
 *  Why: docs/forensics/risk-judge.md#riskjudgespend. */
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

/** The one place a judgment's spend is accumulated: {@link realRiskJudge} records one
 *  entry per spawn; {@link runRiskJudge} reads the total once. `undefined`, never a zero,
 *  when nothing was spawned — a cache hit or an early throw both cost nothing, and `0`
 *  would read as "measured, free" rather than "not measured". */
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
  /** Open (or reuse) a needs-human escalation for this verdict/action. */
  escalate: (verdict: RiskJudgeVerdict, action: RiskJudgeAction) => Promise<string> | string;
  /** One ledger-shaped line per step; no-op default. */
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** The collector {@link realRiskJudge} records this judgment's spawns into (W1-T2383). */
  spend?: RiskJudgeSpendCollector;
}

export interface RiskJudgeResult {
  verdict: RiskJudgeVerdict;
  action: RiskJudgeAction;
  escalationUrl?: string;
}

/** Assess one candidate change and act deterministically: PROCEED (nothing further
 *  happens) or ESCALATE (`deps.escalate` is called). Ledgers ONE `risk_judge.decision`
 *  line, verdict/reasons/confidence verbatim, before deciding whether to escalate. */
export async function runRiskJudge(
  input: RiskJudgeInput,
  deps: RiskJudgeOrchestratorDeps,
  config: RiskJudgeConfig = {},
): Promise<RiskJudgeResult> {
  const log = deps.log ?? (() => {});
  const verdict = await assessRisk(input, deps);
  const action = planRiskJudgeAction(verdict, config);

  // Read once, after assessRisk's own spawning is done, onto the same row (keys OMITTED when unwired).
  const spent = deps.spend?.total();
  log("risk_judge.decision", {
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    confidence: verdict.confidence,
    ...(verdict.gateConsequence === undefined ? {} : { gate_consequence: verdict.gateConsequence }),
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
    // W1-T970: rides onto this row for the sweep's priorActionsFromLedger; omitted when absent.
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

/** Resolve the CHEAPEST mount configured anywhere in the routing table, without
 *  hardcoding a model name: scans every routed cell (keys sorted for a stable result)
 *  and keeps the lowest `tiers` rank, ties broken by `efforts` rank. */
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

/** Empty by construction — everything the judge needs is baked into the prompt, so it
 *  has no need (and no ability) to explore the worktree. */
export const RISK_JUDGE_TOOLS: string[] = [];

/** Build the spawn args for a real risk-judge run — pure, so the "no write tool,
 *  cheapest mount" contract is unit-testable without a spawn. */
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

/** Spawn the real risk judge and parse its verdict. Untested by unit — it shells out
 *  via the SDK; {@link buildRiskJudgeSpawnArgs}/{@link parseRiskJudgeVerdict} carry the
 *  testable contract. `spawn` is injectable for a caller's own resolved dependency. */
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

/** BACKSTOP (W1-T1266): the healthy path — any parsed verdict, adverse or not — returns
 *  on attempt 1, always. Fires only once the judge repeatedly returns unparseable output. */
export const RISK_JUDGE_MAX_ATTEMPTS = 3;

/** Build a `judge` function wired to a real spawn. THE RETRY RE-REQUESTS, NEVER RE-ASKS
 *  (W1-T2212): the same args (prompt included) go to `spawn` on every attempt. Only an
 *  `unparseable` outcome retries, bounded at {@link RISK_JUDGE_MAX_ATTEMPTS}; a parsed
 *  verdict returns immediately. At the bound, {@link MALFORMED_RESPONSE_VERDICT} returns,
 *  still fail-closed to ESCALATE. Why: docs/forensics/risk-judge.md#realriskjudge. */
export function realRiskJudge(opts: {
  mount: Mount;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
  maxAttempts?: number;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** One entry per SPAWN, so a retried judgment (W1-T2212) reports what all attempts cost. */
  spend?: RiskJudgeSpendCollector;
}): (input: RiskJudgeInput) => Promise<RiskJudgeVerdict> {
  const spawn = opts.spawn ?? spawnWorker;
  const maxAttempts = opts.maxAttempts ?? RISK_JUDGE_MAX_ATTEMPTS;
  if (maxAttempts < 1) throw new Error("realRiskJudge: maxAttempts must be >= 1");
  return async (input: RiskJudgeInput) => {
    // Built once, reused by reference every attempt — the byte-identical request
    // test/unparseable-verdict-third-state.test.ts pins.
    const spawnArgs = buildRiskJudgeSpawnArgs({ input, mount: opts.mount, cwd: opts.cwd, settingsFile: opts.settingsFile });
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await spawn(spawnArgs);
      // Recorded BEFORE the parse — an unparseable attempt still cost real money.
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

// ── FILING-TIME RULING (W1-T3143) ────────────────────────────────────────────────────────────
//
// W1-T2977 shipped the consumer, the schema and the drift pin for `risk_ruling` and no producer, so
// only the BLOCKING rows of `machineAuthorVerifyViolation`'s ladder were reachable and every
// machine-filed record parked forever. These two functions are that producer.
//
// POLARITY — UPLIFT-ONLY, the opposite of this module's dispatch-time caller and deliberately so. A
// ruling may RELEASE a record to `verify: auto`; a judge that errors, times out or returns
// unparseable text writes NOTHING, and absence keeps meaning "unjudged", which already blocks. A
// judge outage therefore produces MORE operator review, never an unreviewed auto-file.

/** What a filing-time judge concluded about ONE record. Structurally the judge's own verdict plus
 *  `planRiskJudgeAction`'s kind — never a second scoring scheme, and never re-derived here. */
export interface FilingRiskRuling {
  verdict: string;
  action: "proceed" | "escalate";
  confidence: number;
  reasons: string[];
  /** ISO-8601, supplied by the caller so this stays pure and a test needs no clock seam. */
  judgedAt: string;
}

/**
 * The judge's input for ONE plan record — what the task may DO, never a diff (none exists at filing
 * time). THE STATIC `risk:` FIELD IS DELIBERATELY ABSENT: W1-T248 binds this judge to the candidate
 * change, and `risk:` is set by Rule 19's subsystem count, so feeding it here would launder a sizing
 * band into a safety verdict. It stays inside `taskRulingPin`, which asks a different question.
 */
export function buildFilingRiskJudgeInput(task: {
  id: string;
  title: string;
  type: string;
  verify: string;
  files?: readonly string[];
  acceptance?: readonly { claim?: string; proof?: string }[];
  prompt?: string;
  plan_refs?: readonly string[];
}): RiskJudgeInput {
  const criteria = (task.acceptance ?? []).map((c, i) => `${i + 1}. ${c.claim ?? ""} | ${c.proof ?? ""}`);
  const description = [
    `FILED PLAN RECORD (no diff exists yet — this is what the task may DO).`,
    `id: ${task.id}`,
    `type: ${task.type}`,
    `verify: ${task.verify}`,
    `title: ${task.title}`,
    task.prompt ? `prompt: ${task.prompt}` : undefined,
    criteria.length > 0 ? `acceptance:\n${criteria.join("\n")}` : "acceptance: (none declared)",
  ]
    .filter((l): l is string => l !== undefined)
    .join("\n");
  return {
    change: { description, files: [...(task.files ?? [])] },
    gatesState: { filingTime: true },
    planContext: { taskId: task.id, planRefs: [...(task.plan_refs ?? [])] },
  };
}

/**
 * Attach a filing-time ruling to a record, pinned by the SHARED {@link
 * "./task-linter.js".taskRulingPin} — imported by the caller and passed in rather than re-derived
 * here, so a pin written by this function and a pin checked by the linter cannot diverge.
 *
 * `ruling === undefined` is the FAIL-CLOSED arm and returns the task untouched: no field, no
 * partial record, no synthesised proceed.
 */
export function recordFilingRiskRuling<T extends { id: string }>(
  task: T,
  ruling: FilingRiskRuling | undefined,
  pinOf: (t: T) => string,
): T {
  if (!ruling) return task;
  return {
    ...task,
    risk_ruling: {
      verdict: ruling.verdict,
      action: ruling.action,
      confidence: ruling.confidence,
      reasons: [...ruling.reasons],
      judged_at: ruling.judgedAt,
      pin: pinOf(task),
    },
  };
}
