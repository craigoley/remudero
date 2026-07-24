// Imported as the module's DEFAULT export (a plain, mutable object), never as named
// bindings — the SAME W1-T115 "assert via injected fs" discipline inventory.ts/recon.ts
// already follow (see inventory.ts's header comment for the full rationale): ESM named
// bindings off `node:fs` are non-configurable, so a test that wants to prove "the only
// writes are answers.json + ledger.ndjson" by spying on the REAL module needs every call
// site below to be a live `fs.<method>(...)` property lookup, never a destructured local.
import fs from "node:fs";
import { dirname, join } from "node:path";
import type { Inventory } from "./inventory.js";

/**
 * `rmd onboard <target-dir> --phase session` — phase 3 of the four-phase `rmd onboard`
 * family (MASTER-PLAN ★P24(3)+(4), W1-T84). Two things this module owns:
 *
 *  1. QUESTION GENERATION (pure, deterministic — rule 2): a question set per the §2
 *     QUESTION contract (worker.ts's `QuestionEntry` shape: `question` / `current_assumption`
 *     / `impact_if_wrong`), extended with the W1-T78 clarification-rung discipline —
 *     every question additionally NAMES its `decision` and at least two `candidateAnswers`
 *     (never a generic "any thoughts?" prompt, {@link validateQuestion}). Questions come
 *     from two sources, mirrored in {@link generateOnboardQuestions}: GAPS the phase-1
 *     inventory could not resolve ({@link generateGapQuestions}, over the inventory
 *     artifact's own `"unknown"` fields) and a fixed GOAL-ELICITATION set
 *     ({@link generateGoalElicitationQuestions} — what done looks like, priorities, risk
 *     appetite, no-touch zones, verify:human boundaries). Both are pure functions of the
 *     phase-1 `plan/onboarding/inventory.json` artifact; the same inventory always
 *     generates the SAME question ids, which is what makes the session resumable without
 *     persisting the question set itself.
 *
 *  2. THE ANSWER LOOP (v1: CLI): {@link runOnboardSession} loads any existing
 *     `plan/onboarding/answers.json`, presents ONLY the unanswered questions to an injected
 *     `ask` function, and for each answer writes BOTH `plan/onboarding/answers.json`
 *     (atomic, whole-file rewrite) and one `onboard.answered` line to
 *     `plan/onboarding/ledger.ndjson` (append-only) — the drafted plan's decisions (W1-T85,
 *     not built here) carry provenance to the operator's own words. This is the banked
 *     `rmd chat`/grill intake primitive's FIRST consumer; a later task can swap `ask` for
 *     that richer surface without touching generation, validation, or the ledger contract.
 *
 * READ-ONLY against the target checkout beyond its own two writes (`answers.json`,
 * `ledger.ndjson`, both under `<target-dir>/plan/onboarding/`) — the SAME write-scope
 * discipline inventory.ts/recon.ts already hold to. Unanswered questions persist across
 * invocations: a second `rmd onboard <target-dir> --phase session` re-presents ONLY the
 * questions absent from `answers.json`, never re-asking an already-answered one.
 */

// ── The §2 QUESTION contract, extended with a named decision + candidate answers ───────

export type ImpactIfWrong = "low" | "med";

export interface OnboardQuestion {
  /** Stable across invocations — the SAME inventory always generates the SAME id, which is
   *  what makes "re-present only the unanswered set" possible without persisting the
   *  question set itself (only `answers.json`, keyed by this id, needs to survive). */
  id: string;
  /** What this question decides — REQUIRED (the W1-T78 discipline at day zero): a question
   *  that cannot name its own decision is not a QUESTION, it is a generic "any thoughts?"
   *  prompt, and {@link validateQuestion} refuses it. */
  decision: string;
  /** The question text itself, as presented to the operator. */
  question: string;
  /** At least two named candidate answers — the W1-T78 "decidable" discipline applied to
   *  goal elicitation: an operator is never handed a blank box, only ever a decision with
   *  named options (free text is still accepted by the CLI loop; these are what's OFFERED). */
  candidateAnswers: string[];
  /** The §2 contract's own field: what the loop proceeds on while this question is
   *  unanswered (mirrors worker.ts's `QuestionEntry.current_assumption`). */
  currentAssumption?: string;
  /** The §2 contract's own field: blast radius if `currentAssumption` is wrong. */
  impactIfWrong: ImpactIfWrong;
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

function isNonBlank(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * FAIL LOUD (control-surface-fail-loud discipline, LEARNINGS.md): a question with no id,
 * no named decision, no question text, fewer than two non-blank candidate answers, or an
 * `impactIfWrong` outside `low|med` throws {@link SessionError} rather than silently
 * entering the session as an unanswerable or generic prompt. This is what makes "a generic
 * question without a named decision fails generation" (acceptance criterion 1) true of
 * every question this module ever emits, hand-authored or generated.
 */
export function validateQuestion(question: OnboardQuestion): void {
  if (!isNonBlank(question.id)) {
    throw new SessionError(`onboard question has no id: ${JSON.stringify(question)}`);
  }
  if (!isNonBlank(question.decision)) {
    throw new SessionError(
      `onboard question "${question.id}" does not name a decision (the §2 contract requires every ` +
        `question to name what it decides, never a generic prompt): ${JSON.stringify(question)}`,
    );
  }
  if (!isNonBlank(question.question)) {
    throw new SessionError(`onboard question "${question.id}" has no question text: ${JSON.stringify(question)}`);
  }
  const answers = (question.candidateAnswers ?? []).filter(isNonBlank);
  if (answers.length < 2) {
    throw new SessionError(
      `onboard question "${question.id}" must name at least two candidate answers (the W1-T78 ` +
        `decidable-question discipline): ${JSON.stringify(question)}`,
    );
  }
  if (question.impactIfWrong !== "low" && question.impactIfWrong !== "med") {
    throw new SessionError(
      `onboard question "${question.id}" has an invalid impact_if_wrong (must be "low" or "med"): ${JSON.stringify(question)}`,
    );
  }
}

/** Validate a whole question set: every question individually valid, no duplicate ids.
 *  Returns a shallow copy on success (never mutates). */
export function validateQuestions(questions: readonly OnboardQuestion[]): OnboardQuestion[] {
  const seen = new Set<string>();
  for (const q of questions) {
    validateQuestion(q);
    if (seen.has(q.id)) {
      throw new SessionError(`duplicate onboard question id: "${q.id}"`);
    }
    seen.add(q.id);
  }
  return [...questions];
}

// ── Source 1: GAP questions — pure function of the phase-1 inventory's own "unknown"s ──

interface GapRule {
  readonly id: string;
  readonly decision: string;
  readonly applies: (inventory: Inventory) => boolean;
  readonly question: (inventory: Inventory) => string;
  readonly candidateAnswers: readonly string[];
  readonly currentAssumption: (inventory: Inventory) => string;
  readonly impactIfWrong: ImpactIfWrong;
}

/** RULE 2 (policy as data): every gap this phase can ask about is a ROW here, all folded by
 *  the SAME generic engine ({@link generateGapQuestions}) — adding a new gap type is a new
 *  row, never a new branch, mirroring inventory.ts's own detector-table discipline. */
export const DEFAULT_GAP_RULES: readonly GapRule[] = [
  {
    id: "gap-github-facts",
    decision: "how to treat this target's unresolved GitHub facts (existence/protection/issue counts)",
    applies: (inv) => inv.github.repoExists === "unknown",
    question: (inv) =>
      `The phase-1 scan could not resolve GitHub facts for ${inv.target.owner}/${inv.target.repo} ` +
      `(auth/network gap, or --owner/--repo was never resolved). How should the session proceed?`,
    candidateAnswers: [
      "proceed without GitHub-derived facts (treat issue/milestone mining and branch-protection baselines as absent)",
      "re-run inventory with an explicit --owner/--repo once access is available",
    ],
    currentAssumption: (inv) => `${inv.target.owner}/${inv.target.repo}'s GitHub facts stay "unknown" until answered.`,
    impactIfWrong: "med",
  },
  {
    id: "gap-branch-protection",
    decision: "whether the default branch's protection state should be treated as a ratchet floor",
    applies: (inv) => inv.github.repoExists !== "unknown" && inv.github.branchProtected === "unknown",
    question: () =>
      "The phase-1 scan resolved the repo but could not resolve whether its default branch is " +
      "protected. Should the drafted plan assume protection is OFF (propose arming it) or defer this?",
    candidateAnswers: ["assume unprotected — propose arming branch protection in the drafted plan", "defer — leave protection state out of the drafted plan"],
    currentAssumption: () => "branch protection stays unasserted in the drafted plan until answered.",
    impactIfWrong: "med",
  },
  {
    id: "gap-ci-systems",
    decision: "whether a CI system should be proposed for this target",
    applies: (inv) => inv.ciSystems.length === 0,
    question: () => "No CI system was detected for this target. Should the drafted plan propose one?",
    candidateAnswers: ["yes — propose a CI system in the drafted plan", "no — CI exists but wasn't detected; I'll name it instead"],
    currentAssumption: () => "no CI system is assumed to exist until answered.",
    impactIfWrong: "low",
  },
  {
    id: "gap-languages",
    decision: "which language(s) the drafted plan's conventions section should target",
    applies: (inv) => inv.languages.length === 0,
    question: () => "No language was detected for this target. Which language(s) should the drafted plan's conventions target?",
    candidateAnswers: ["name the language(s) explicitly", "this is a non-code (docs-only/config-only) repo — no language section needed"],
    currentAssumption: () => "the drafted plan's conventions section stays language-agnostic until answered.",
    impactIfWrong: "low",
  },
];

/** Generate GAP questions: one per {@link DEFAULT_GAP_RULES} row whose `applies` predicate
 *  is true for this inventory — a repo with every fact resolved yields zero gap questions,
 *  never a padded set. */
export function generateGapQuestions(inventory: Inventory, rules: readonly GapRule[] = DEFAULT_GAP_RULES): OnboardQuestion[] {
  return rules
    .filter((rule) => rule.applies(inventory))
    .map((rule) => ({
      id: rule.id,
      decision: rule.decision,
      question: rule.question(inventory),
      candidateAnswers: [...rule.candidateAnswers],
      currentAssumption: rule.currentAssumption(inventory),
      impactIfWrong: rule.impactIfWrong,
    }));
}

// ── Source 2: goal elicitation — a fixed set, always asked once per target ─────────────

/** The fixed goal-elicitation set (MASTER-PLAN P24(3): "what done looks like, priorities,
 *  risk appetite, no-touch zones, which criteria are verify:human") — asked of EVERY
 *  target, independent of what phase 1/2 found; these are the questions no scan can ever
 *  answer on the operator's behalf. */
export const GOAL_ELICITATION_QUESTIONS: readonly OnboardQuestion[] = [
  {
    id: "elicit-definition-of-done",
    decision: "what \"done\" looks like for this onboarding's drafted plan",
    question: "In one or two sentences, what does \"done\" look like for this repo's stewarded plan?",
    candidateAnswers: [
      "ship the mined ROADMAP/TODO/issue backlog as the plan's initial goals",
      "something narrower — I'll name the specific goals myself",
    ],
    impactIfWrong: "med",
  },
  {
    id: "elicit-priorities",
    decision: "how to order the mined/inferred candidate goals in the drafted plan",
    question: "How should the drafted plan order its candidate goals?",
    candidateAnswers: ["highest-value-first", "quick-wins-first", "risk-reduction-first"],
    impactIfWrong: "low",
  },
  {
    id: "elicit-risk-appetite",
    decision: "the risk appetite for autonomous execution of the drafted plan",
    question: "What risk appetite should the drafted plan assume for autonomous (verify: auto) execution?",
    candidateAnswers: ["conservative — favor verify: human by default", "balanced — verify: auto unless a criterion is clearly risky", "aggressive — verify: auto by default"],
    currentAssumption: "verify: human by default (conservative) until answered.",
    impactIfWrong: "med",
  },
  {
    id: "elicit-no-touch-zones",
    decision: "which paths, if any, the drafted plan must never propose touching",
    question: "Are there any no-touch zones — paths or subsystems the drafted plan must never propose changing?",
    candidateAnswers: ["name the specific path(s)", "none — everything is in scope"],
    currentAssumption: "no no-touch zones are assumed until answered.",
    impactIfWrong: "med",
  },
  {
    id: "elicit-verify-human-boundary",
    decision: "which acceptance criteria default to verify: human vs verify: auto",
    question: "Which kinds of acceptance criteria should default to verify: human rather than verify: auto?",
    candidateAnswers: ["anything user-facing (UI/UX, copy, visual)", "default everything to auto unless a task explicitly flags it"],
    impactIfWrong: "med",
  },
];

export function generateGoalElicitationQuestions(): OnboardQuestion[] {
  return GOAL_ELICITATION_QUESTIONS.map((q) => ({ ...q, candidateAnswers: [...q.candidateAnswers] }));
}

/**
 * The full phase-3 question set: GAP questions first (specific to this target's own
 * scan), then the fixed goal-elicitation set — VALIDATED as one list (acceptance criterion
 * 1: every question conforms to the §2 contract shape, names its decision, and carries
 * candidate answers; a malformed question throws rather than reaching the operator).
 */
export function generateOnboardQuestions(inventory: Inventory): OnboardQuestion[] {
  return validateQuestions([...generateGapQuestions(inventory), ...generateGoalElicitationQuestions()]);
}

// ── The injectable fs surface + real deps ───────────────────────────────────────────────

export interface SessionFsDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
  mkdirSync: (path: string, opts: { recursive: true }) => void;
  writeFileSync: (path: string, content: string) => void;
  renameSync: (from: string, to: string) => void;
  appendFileSync: (path: string, content: string) => void;
}

export const realSessionFsDeps: SessionFsDeps = {
  existsSync: (path) => fs.existsSync(path),
  readFileSync: (path) => fs.readFileSync(path, "utf8"),
  mkdirSync: (path, opts) => {
    fs.mkdirSync(path, opts);
  },
  writeFileSync: (path, content) => {
    fs.writeFileSync(path, content, "utf8");
  },
  renameSync: (from, to) => {
    fs.renameSync(from, to);
  },
  appendFileSync: (path, content) => {
    fs.appendFileSync(path, content, "utf8");
  },
};

// ── Answers + the onboard.answered ledger ───────────────────────────────────────────────

export interface OnboardAnswer {
  id: string;
  decision: string;
  question: string;
  answer: string;
}

function answersPathFor(targetDir: string): string {
  return join(targetDir, "plan", "onboarding", "answers.json");
}

function ledgerPathFor(targetDir: string): string {
  return join(targetDir, "plan", "onboarding", "ledger.ndjson");
}

/** Atomic temp-file + `renameSync` write — the SAME idiom as recon.ts's
 *  `writeReconArtifactAtomic` / inventory.ts's `writeInventoryAtomic`. */
function writeJsonAtomic(fsDeps: SessionFsDeps, path: string, value: unknown): void {
  fsDeps.mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  fsDeps.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n");
  fsDeps.renameSync(tmpPath, path);
}

/** Read `plan/onboarding/answers.json`; `{}` when absent. A PRESENT but malformed file
 *  fails loud — a corrupted answers store must stop the session before it is overwritten,
 *  never silently be treated as "nothing answered yet" (control-surface-fail-loud). */
function readAnswers(fsDeps: SessionFsDeps, path: string): Record<string, OnboardAnswer> {
  if (!fsDeps.existsSync(path)) return {};
  try {
    return JSON.parse(fsDeps.readFileSync(path)) as Record<string, OnboardAnswer>;
  } catch {
    throw new SessionError(`onboard session: ${path} exists but is not valid JSON — refusing to overwrite it`);
  }
}

/** Read the phase-1 inventory artifact `runOnboardSession` needs to generate questions.
 *  Missing entirely → loud refusal naming the prerequisite phase (never a guessed
 *  inventory), matching recon.ts's own "target directory does not exist" refusal shape. */
function readInventory(fsDeps: SessionFsDeps, targetDir: string): Inventory {
  const path = join(targetDir, "plan", "onboarding", "inventory.json");
  if (!fsDeps.existsSync(path)) {
    throw new SessionError(`rmd onboard session: ${path} not found — run \`rmd onboard ${targetDir} --phase inventory\` first`);
  }
  try {
    return JSON.parse(fsDeps.readFileSync(path)) as Inventory;
  } catch {
    throw new SessionError(`rmd onboard session: ${path} exists but is not valid JSON`);
  }
}

export interface OnboardSessionState {
  questions: OnboardQuestion[];
  answers: Record<string, OnboardAnswer>;
  unanswered: OnboardQuestion[];
  answersPath: string;
  ledgerPath: string;
}

/**
 * Load the current session state — the full question set, the answers already on disk,
 * and the (possibly empty) unanswered remainder — WITHOUT asking anything. This is the
 * seam a headless/no-TTY caller uses to preview the backlog without ever blocking on an
 * operator that may not exist (Standing rule 18 / LEARNINGS.md
 * no-live-operator-in-headless-worker); {@link runOnboardSession} below calls this first,
 * then drives the interactive loop over its own `unanswered` list.
 */
export function loadOnboardSessionState(targetDir: string, fsDeps: SessionFsDeps = realSessionFsDeps): OnboardSessionState {
  const inventory = readInventory(fsDeps, targetDir);
  const questions = generateOnboardQuestions(inventory);
  const answersPath = answersPathFor(targetDir);
  const ledgerPath = ledgerPathFor(targetDir);
  const answers = readAnswers(fsDeps, answersPath);
  const unanswered = questions.filter((q) => !(q.id in answers));
  return { questions, answers, unanswered, answersPath, ledgerPath };
}

export interface OnboardSessionDeps {
  fs?: SessionFsDeps;
  /** Ask ONE question, returning the operator's raw (untrimmed) answer text. The real CLI
   *  wrapper (run-task.ts) supplies a readline-backed implementation; tests supply canned
   *  answers, so every deterministic part of this module — generation, validation,
   *  resumability, the ledger write — is exercised without ever touching a real TTY. */
  ask: (question: OnboardQuestion) => Promise<string>;
}

export interface OnboardSessionResult extends OnboardSessionState {
  /** Questions actually answered THIS invocation (a subset of the prior `unanswered`) —
   *  distinct from `answers`, which also carries answers from a prior invocation. */
  newlyAnswered: OnboardAnswer[];
}

/**
 * Run phase 3: load the session state, then for each UNANSWERED question call `deps.ask`,
 * and for a non-blank reply write BOTH `plan/onboarding/answers.json` (whole-file atomic
 * rewrite — the answer set is small, a full rewrite per answer keeps the write dead simple
 * and crash-safe) and one `onboard.answered` line to `plan/onboarding/ledger.ndjson`
 * (append-only, `{ts, step: "onboard.answered", id, decision, question, answer}`). A BLANK
 * reply is skipped — the question stays unanswered and is re-presented next invocation
 * (resumability, acceptance criterion 3); it is never recorded as an empty answer.
 */
export async function runOnboardSession(targetDir: string, deps: OnboardSessionDeps): Promise<OnboardSessionResult> {
  const fsDeps = deps.fs ?? realSessionFsDeps;
  const state = loadOnboardSessionState(targetDir, fsDeps);
  const answers = { ...state.answers };
  const newlyAnswered: OnboardAnswer[] = [];

  for (const question of state.unanswered) {
    const raw = await deps.ask(question);
    const answer = raw.trim();
    if (!answer) continue;
    const entry: OnboardAnswer = { id: question.id, decision: question.decision, question: question.question, answer };
    answers[question.id] = entry;
    newlyAnswered.push(entry);
    writeJsonAtomic(fsDeps, state.answersPath, answers);
    fsDeps.appendFileSync(
      state.ledgerPath,
      JSON.stringify({ ts: new Date().toISOString(), step: "onboard.answered", ...entry }) + "\n",
    );
  }

  return {
    questions: state.questions,
    answers,
    unanswered: state.questions.filter((q) => !(q.id in answers)),
    answersPath: state.answersPath,
    ledgerPath: state.ledgerPath,
    newlyAnswered,
  };
}

// ── CLI arg parsing (pure) — independent of inventory.ts's/recon.ts's own parsers, the
// SAME "own parser per phase" shape recon.ts's header comment explains — run-task.ts peeks
// `--phase` and routes to THIS parser for `--phase session` before inventory.ts's parser
// (whose KNOWN_ONBOARD_PHASES stays exactly `["inventory"]`) ever sees it. ────────────────

export const SESSION_PHASE = "session" as const;

export interface ParsedSessionArgs {
  targetDir: string;
}

export type ParseSessionArgsResult = { ok: true; args: ParsedSessionArgs } | { ok: false; error: string };

const SESSION_VALUE_FLAGS = ["--phase"];

/** Parse+validate `rmd onboard <target-dir> --phase session`'s argv tail. FAIL LOUD,
 *  BEFORE ANY WORK — the same control-surface-fail-loud discipline inventory.ts's/recon.ts's
 *  own parsers already apply. */
export function parseSessionArgs(rest: string[]): ParseSessionArgsResult {
  const targetDir = rest[0];
  if (!targetDir || targetDir.startsWith("--")) {
    return { ok: false, error: "rmd onboard: <target-dir> is required as the first positional argument" };
  }

  const tail = rest.slice(1);
  for (let i = 0; i < tail.length; i++) {
    const tok = tail[i]!;
    if (SESSION_VALUE_FLAGS.includes(tok)) {
      i++;
      continue;
    }
    return { ok: false, error: `rmd onboard: unrecognized argument '${tok}'` };
  }

  const phase = tail[tail.indexOf("--phase") + 1];
  if (phase !== SESSION_PHASE) {
    return { ok: false, error: `rmd onboard session: --phase must be "${SESSION_PHASE}" here; got ${phase ? `"${phase}"` : "nothing"}` };
  }

  return { ok: true, args: { targetDir } };
}
