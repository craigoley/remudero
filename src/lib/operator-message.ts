/**
 * W1-T2498 — THE OPERATOR MESSAGE STANDARD EXISTS, IS RATIFIED, AND CHECKS NO MESSAGE.
 *
 * W1-T2279 wrote docs/operator-message-standard.md, grounded in ISO 24495-1:2023, and its own
 * suite (test/operator-message-standard.test.ts) asserts over the DOCUMENT — never over a
 * message any producer actually emitted. This module is the missing consumer: it applies the
 * standard's structural discipline to a real escalation message, at the one choke point every
 * escalation producer already crosses (`escalate.ts`'s `escalate()`/`escalateWithJudge()`).
 *
 * WHAT THIS MODULE CHECKS, AND WHAT IT DOES NOT. The standard names exactly one thing a machine
 * may prove: whether a slot EXISTS and is POPULATED, or is EXPLICITLY declared empty (`null`) —
 * never whether the words in that slot are the right words (docs/operator-message-standard.md,
 * "What a machine can check, and what only a reader can judge"). This module applies that SAME
 * populated-or-explicitly-null discipline uniformly across the four parts an inbox message needs
 * to be a message rather than a fragment: WHO IS SPEAKING, WHAT HAPPENED, WHAT IS BEING ASKED OF
 * THE READER, and WHAT FOLLOWS FROM DOING NOTHING. It never scores tone, length, clarity, or
 * whether the content is TRUE — a message can fill all four slots with terse, unlovely prose and
 * still pass; a message can be beautifully written and still fail for omitting one slot entirely.
 * See {@link checkOperatorMessage}'s own doc for the presence rule, and this module's test suite
 * (test/every-inbox-message-meets-the-standard.test.ts) for the falsifiers that keep this claim
 * honest.
 *
 * THE FALLBACK IS THE HAZARD, AND IT FAILS TOWARD DELIVERY. `checkOperatorMessage` never throws
 * on a non-conforming message — it REPORTS which parts are missing, by name, so the caller can
 * annotate the delivered message rather than block it. `escalate.ts` wires this in as a
 * best-effort observation, never a gate: an escalation whose message is missing every one of the
 * four parts still reaches the operator, annotated as non-conforming, exactly like the degraded-
 * labels footer `createEscalationIssue` already appends when label provisioning fails. Making the
 * checker's result GATE delivery instead of merely annotating it would trade a badly-structured
 * warning for no warning at all — strictly worse, per this task's own rationale.
 *
 * NO EXISTING MESSAGE IS REWORDED BY THIS MODULE OR BY ANYTHING THAT CONSUMES IT. `detail`,
 * `summary`, `recommendation`, and every option's own prose pass through byte-identical; a
 * non-conforming annotation is purely ADDITIVE, appended after the caller's own text, never a
 * substitute or a rewrite of it (mirrors W1-T2279's own "no reword" constraint, and keeps this
 * task from redressing any of the verbatim exhibits that doc's suite quotes).
 */

/**
 * One slot's value. `undefined` means the caller never considered this part at all — an omitted
 * part, and the thing a non-conforming report names. `null` means the caller considered it and
 * has nothing to say — the standard's own "the message SAYS there is nothing rather than omitting
 * the part" (docs/operator-message-standard.md, part iii) — and counts as PRESENT, same as any
 * non-empty string. Whitespace-only strings ("", "   ") are NOT present: a slot filled with
 * nothing but padding is exactly the omission this check exists to catch.
 */
export type OperatorMessageSlot = string | null | undefined;

/**
 * The four parts an inbox message needs to be a message rather than a fragment (this task's own
 * rationale, operator-brief#an-interpreter-on-the-way-into-the-inbox-2026-08-30): who is
 * speaking, what happened, what is being asked of the reader, and what follows from doing
 * nothing. Every field is OPTIONAL on the type — the type itself cannot force a caller to fill a
 * slot, exactly as {@link checkOperatorMessage} itself never blocks on one being empty.
 */
export interface OperatorMessage {
  /** WHO IS SPEAKING — the producer or class raising this message (e.g. an escalation's own
   *  `class`), so a reader juggling several concurrent threads knows whose voice this is. */
  speaker?: OperatorMessageSlot;
  /** WHAT HAPPENED — the condition, named as observed (docs/operator-message-standard.md,
   *  part i). */
  whatHappened?: OperatorMessageSlot;
  /** WHAT IS BEING ASKED OF THE READER — the ask; a filled slot, or an explicit `null` declaring
   *  there is nothing to do (docs/operator-message-standard.md, part iii). */
  whatIsAsked?: OperatorMessageSlot;
  /** WHAT FOLLOWS FROM DOING NOTHING — the consequence of inaction, in the reader's own terms. */
  consequenceOfInaction?: OperatorMessageSlot;
}

/** The closed set of {@link OperatorMessage} keys {@link checkOperatorMessage} inspects, in the
 *  fixed order the standard names them — never derived from `Object.keys`, so an extra property
 *  a caller happens to attach can never masquerade as a fifth part. */
export const OPERATOR_MESSAGE_PARTS = [
  "speaker",
  "whatHappened",
  "whatIsAsked",
  "consequenceOfInaction",
] as const;

/** One of {@link OPERATOR_MESSAGE_PARTS}. */
export type OperatorMessagePart = (typeof OPERATOR_MESSAGE_PARTS)[number];

export interface OperatorMessageCheckResult {
  /** `true` only when every part in {@link OPERATOR_MESSAGE_PARTS} is present. */
  ok: boolean;
  /** The parts that are missing, in {@link OPERATOR_MESSAGE_PARTS} order — empty when `ok`. */
  missing: OperatorMessagePart[];
}

/**
 * Is one slot PRESENT — populated, or explicitly declared empty? See {@link OperatorMessageSlot}
 * for the three-way `string | null | undefined` split this implements. PURE, and the only thing
 * this module ever asks of a slot's VALUE — it is never inspected for length, wording, or tone.
 */
function isPresent(value: OperatorMessageSlot): boolean {
  if (value === null) return true;
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Check a message against the standard's four-part structure (docs/operator-message-standard.md,
 * applied — see this module's own header doc for the mapping). MECHANICAL AND STRUCTURAL ONLY:
 * this asks whether each of {@link OPERATOR_MESSAGE_PARTS} is present, never whether what it says
 * is correct, well-written, or the right length — the standard itself draws that line, and this
 * function never crosses it (docs/operator-message-standard.md: "no readability score, no
 * word-count gate, and no sentence-length threshold — none should ever be added in this
 * standard's name"). Never throws — a message this function cannot make sense of simply reports
 * every part missing rather than raising, so a caller can always treat the result as advisory.
 */
export function checkOperatorMessage(message: OperatorMessage): OperatorMessageCheckResult {
  const missing = OPERATOR_MESSAGE_PARTS.filter((part) => !isPresent(message[part]));
  return { ok: missing.length === 0, missing };
}

/**
 * Render the non-conforming footer {@link OperatorMessageCheckResult} implies, in the SAME
 * additive-annotation idiom `escalate.ts`'s `createEscalationIssue` already uses for a degraded
 * label (never a rewrite of the caller's own text — see this module's header doc). Returns
 * `undefined` when the check passed: a conforming message is delivered with no footer at all, so
 * it renders byte-identical to how it would have without this task ever existing (the acceptance
 * claim "an escalation whose message already conforms is passed through unchanged", made literal
 * — {@link checkOperatorMessage}'s presence check never touches the caller's own prose, and this
 * function adds nothing when there is nothing to report).
 */
export function operatorMessageFooter(result: OperatorMessageCheckResult): string | undefined {
  if (result.ok) return undefined;
  return (
    `_Non-conforming operator message (W1-T2498, docs/operator-message-standard.md): missing ` +
    `${result.missing.join(", ")} — delivered anyway, never dropped or held._`
  );
}
