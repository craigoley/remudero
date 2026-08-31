import type { ThreadIdentity, ThreadMessage } from "./inbox-thread.js";

/**
 * lib/reply-interpreter.ts (W1-T2499) — the clarification loop, off onboarding.
 *
 * THE GAP THIS CLOSES. `src/lib/onboard/session.ts` and `src/lib/onboard/synthesize.ts` already
 * ship the whole comprehension loop — question generators, {@link
 * import("./onboard/session.js").validateQuestion}, {@link
 * import("./onboard/synthesize.js").unansweredQuestions}, {@link
 * import("./onboard/synthesize.js").assertAnswersComplete} — but every one of those symbols is a
 * pure function of an onboarding `Inventory`, and grep confirms zero modules outside `onboard/`
 * import any of them. A reply that lands anywhere else (an escalation thread, W1-T2496's
 * `POST /v1/escalation/reply`) is filed or acted on, never asked about. THIS module is the SAME
 * design — understood is an empty unanswered set, never a model's own "yes, got it" — reachable
 * from that other subject, WITHOUT moving, rewriting, or adding a caller to the onboarding
 * generators themselves (out of scope; they keep their current behaviour and callers exactly).
 *
 * UNDERSTANDING IS THE ABSENCE OF UNANSWERED QUESTIONS, NEVER A MODEL SAYING IT UNDERSTOOD. Every
 * {@link ClarificationRule} runs its own {@link ClarificationRule.research} FIRST — a pure check
 * over the reply and its thread, deterministic and injectable exactly like `session.ts`'s `ask`
 * or `synthesize.ts`'s `draft` seam — and only a rule research could NOT settle ever becomes a
 * candidate question ({@link interpretReply}'s `status: "understood"` is `allUnresolved.length
 * === 0`, a predicate, never a call asking anything "do you understand?"). A question research
 * DID settle is dropped before it is ever formed into text (acceptance: "a question research
 * could have settled is not asked") — and every question that IS asked is built from that same
 * research finding, so it always states what was already established (acceptance: "recon runs
 * before a question is asked and the question states what it established").
 *
 * THE SAME CLARIFICATION IS NEVER ASKED TWICE, AND ROUNDS ARE BOUNDED. `interpretReply` reads
 * which clarification ids already appear on `ctx.priorMessages` ({@link clarifyingQuestionId})
 * and refuses to re-propose any of them; once {@link DEFAULT_MAX_ROUNDS} distinct clarifications
 * have been asked on one thread, a still-unresolved concern reports as `status: "exhausted"`
 * (naming every question still open) rather than asking a sixth time or silently proceeding on a
 * guess — a loop that can ask forever is a denial of service on the operator answering it.
 *
 * IT ASKS, IT DOES NOT ACT. This module is PURE — no filesystem, no network, no ledger write, no
 * import of `fleet-control.ts`'s dispatch primitives, no ratify gateway, no task-filing call.
 * Reaching "understood" is a STATE this module reports; what happens next (dispatch, fan-out) is
 * W1-T2500's, and the inbound direction (turning an incoming message into a reply in the first
 * place) is W1-T2498's — both explicitly out of scope here.
 */

// ── The §2-style contract this module works over ────────────────────────────────────────────

/** Everything a {@link ClarificationRule} needs to decide, in one pure snapshot — never mutated,
 *  never re-fetched mid-decision, so calling {@link interpretReply} twice with the same `ctx`
 *  always returns the same answer (the same determinism `onboard/session.ts`'s question
 *  generators already hold to). */
export interface ReplyContext {
  identity: ThreadIdentity;
  threadId: string;
  /** The reply text just received — the thing being interpreted. */
  replyText: string;
  /** Every message already on this thread BEFORE this reply (escalation + any prior
   *  clarification round-trips) — the record {@link ClarificationRule.research} and the
   *  never-twice / round-bound checks both read. */
  priorMessages: readonly ThreadMessage[];
}

/** What one {@link ClarificationRule}'s recon found. `settled: true` means research itself
 *  resolved the concern — the rule contributes NO question, ever, no matter how the caller
 *  configures rounds (acceptance: "a question research could have settled is not asked").
 *  `established` is always populated regardless of `settled`, because an UNRESOLVED concern's
 *  eventual question still needs to state what research DID establish before asking what it
 *  could not. */
export interface ResearchFinding {
  established: string;
  settled: boolean;
}

/** One clarifiable concern, folded by the SAME generic engine ({@link interpretReply}) — adding
 *  a new concern is a new row, never a new branch, mirroring `onboard/session.ts`'s own
 *  `DEFAULT_GAP_RULES` table discipline. */
export interface ClarificationRule {
  /** Stable across a thread's whole lifetime — the SAME rule always produces the SAME id, which
   *  is what makes "never ask the same clarification twice" checkable by scanning prior message
   *  ids rather than re-running the rule against the past. */
  id: string;
  /** Recon: pure research over `ctx`, run BEFORE any question is ever formed. */
  research: (ctx: ReplyContext) => ResearchFinding;
  /** The question text ALONE (never re-states `established` itself — {@link
   *  formatClarifyingQuestion} composes the two so every emitted question states what was
   *  established structurally, not by rule-author discipline). */
  question: (ctx: ReplyContext, established: string) => string;
}

export interface ClarifyingQuestion {
  id: string;
  question: string;
  established: string;
}

export interface InterpretReplyDeps {
  /** Defaults to `[]` — an unconfigured caller never asks anything, which is what keeps every
   *  route wiring this in a no-op until it is deliberately handed rules (or, later, an
   *  LLM-backed rule). */
  rules?: readonly ClarificationRule[];
  /** Defaults to {@link DEFAULT_MAX_ROUNDS}. */
  maxRounds?: number;
}

export type InterpretReplyResult =
  | { status: "understood" }
  | { status: "clarifying"; question: ClarifyingQuestion }
  | { status: "exhausted"; unresolved: ClarifyingQuestion[] };

/** PRIMARY CONTROL, not a backstop: this is what normally stops the clarification loop.
 *  "Asking a sixth time" is the rationale's own example of the failure this bound closes. */
export const DEFAULT_MAX_ROUNDS = 5;

// ── Thread-message encoding — how a clarification round-trip is told apart from the original
// escalation prose and the human's own reply, using ONLY the two roles inbox-thread.ts already
// defines (never a third role invented here — inbox-thread.ts is not this task's to change). ──

const CLARIFY_TAG = /^\[clarify:([^\]]+)\]/;
const EXHAUSTED_TAG = "[clarify-exhausted]";

/** The machine-readable id prefix any prior clarification message carries — `undefined` for
 *  every other message (the original escalation prose, a human's reply, an exhaustion report),
 *  which is exactly what lets those keep flowing through the thread unaffected by this module. */
export function clarifyingQuestionId(body: string): string | undefined {
  return CLARIFY_TAG.exec(body)?.[1];
}

/** Render a {@link ClarifyingQuestion} as the machine-taggable, human-readable thread message a
 *  caller appends (role `"escalation"`, same as the original raise — this module never writes,
 *  it only formats what a caller writes). ALWAYS states what research established, structurally
 *  — a rule cannot forget to, because the wrapper composes both parts, never the rule alone. */
export function formatClarifyingQuestion(q: ClarifyingQuestion): string {
  return `[clarify:${q.id}] ${q.question} (already established: ${q.established})`;
}

/** Render the bounded-round exhaustion report a caller appends when {@link interpretReply}
 *  returns `status: "exhausted"` — names every question still open rather than guessing one is
 *  answered. */
export function formatExhaustionReport(unresolved: readonly ClarifyingQuestion[]): string {
  const list = unresolved.map((q) => `- [${q.id}] ${q.question} (already established: ${q.established})`).join("\n");
  return `${EXHAUSTED_TAG} ${unresolved.length} round(s) exhausted; still unresolved:\n${list}`;
}

/** `true` for any message this module itself produced (a clarifying question OR an exhaustion
 *  report) — the complement of "the original escalation / a human's reply", useful for a caller
 *  that wants to render or filter a thread without re-deriving both tags itself. */
export function isInterpreterMessage(body: string): boolean {
  return CLARIFY_TAG.test(body) || body.startsWith(EXHAUSTED_TAG);
}

// ── The predicate itself ─────────────────────────────────────────────────────────────────────

/**
 * Interpret one reply: run every rule's recon, then decide.
 *
 *  - `rules` unconfigured (`[]`, the default) -> always `"understood"` — nothing to ask about.
 *  - A rule whose research SETTLES the concern (`settled: true`) never contributes a question,
 *    no matter what else is unresolved (acceptance: research-settled questions are never asked).
 *  - Every rule research left unresolved (`settled: false`), MINUS whichever ids already appear
 *    on `ctx.priorMessages` ({@link clarifyingQuestionId}), are the ASKABLE set. The empty set —
 *    across ALL unresolved rules, not just the askable ones — is what defines `"understood"`
 *    (acceptance: "understood is defined as an empty unanswered set, never a model assertion").
 *  - Otherwise: if every remaining unresolved concern has already been asked once, or this
 *    thread has already spent {@link DEFAULT_MAX_ROUNDS} distinct clarifications, report
 *    `"exhausted"` naming every unresolved question rather than asking again or guessing.
 *  - Otherwise: ask the first still-askable concern.
 */
export function interpretReply(ctx: ReplyContext, deps: InterpretReplyDeps = {}): InterpretReplyResult {
  const rules = deps.rules ?? [];
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;

  const askedIds = new Set(
    ctx.priorMessages
      .map((m) => clarifyingQuestionId(m.body))
      .filter((id): id is string => id !== undefined),
  );
  const roundsUsed = askedIds.size;

  const findings = rules.map((rule) => ({ rule, finding: rule.research(ctx) }));
  const allUnresolved = findings.filter((f) => !f.finding.settled);

  if (allUnresolved.length === 0) {
    return { status: "understood" };
  }

  const toQuestion = (f: (typeof allUnresolved)[number]): ClarifyingQuestion => ({
    id: f.rule.id,
    question: f.rule.question(ctx, f.finding.established),
    established: f.finding.established,
  });

  const askable = allUnresolved.filter((f) => !askedIds.has(f.rule.id));

  if (askable.length === 0 || roundsUsed >= maxRounds) {
    return { status: "exhausted", unresolved: allUnresolved.map(toQuestion) };
  }

  return { status: "clarifying", question: toQuestion(askable[0]!) };
}
