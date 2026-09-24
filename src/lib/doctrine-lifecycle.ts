// lib/doctrine-lifecycle.ts — DOCTRINE THAT CAN CHANGE, AND A RULE THAT STOPS BEING PROSE (W1-T4097).
//
// THE GAP THIS CLOSES. `test/fixtures/doctrine-pre-migration-W1-T3323.json` froze each of the 56
// pre-migration rules' headline and body VERBATIM, with a comment saying an edit "should say why"
// but nothing MECHANICAL checking it. (i)+(ii): freeze the rule's IDENTITY ({@link slugifyRuleId})
// and MEANING ({@link computeMeaningHash} of its headline) instead — a body's bytes may then be
// corrected as long as the row records WHY ({@link verifyDoctrineReword}) and the meaning did not
// silently drift too. (iv): {@link resolveCanonicalRuleId} is the alias table a merge (folding
// investigation-discipline's (a)-(k) into one rule) writes once so every old id still resolves.
// (iii): `rule-efficacy.ts`'s `escalateRepeatingRules` only ever DRAFTS a proposal for a human to
// notice — this task's worked example (bound-fires-on-healthy-condition, effective 2026-08-06) kept
// recurring past that. {@link risingRecurrenceRuleIds}/{@link draftInstrumentTaskProposal} are what
// its new `promoteRecurringRules` calls when a rule's recurrence count RISES across two passes —
// already flagged once, got worse anyway — still through the same reviewed registry, on its own
// distinct id, never a raw `plan/` write (Law 5).
//
// PURE THROUGHOUT: nothing here touches a filesystem or a registry; `rule-efficacy.ts` owns the one
// sanctioned write and calls into these functions for the decision.

import { createHash } from "node:crypto";
import type { EvidenceAnchor, Proposal } from "./inbox.js";

// ── (i)+(ii): freeze the id and the meaning, not the wording ──────────────────────────────────

/** One frozen doctrine row — `test/fixtures/doctrine-pre-migration-W1-T3323.json`'s real shape. */
export interface DoctrineFreezeRow {
  /** A stable identity for this rule, independent of its wording — see {@link slugifyRuleId}. */
  id: string;
  headline: string;
  bodyBytes: number;
  bodySha256: string;
  /** {@link computeMeaningHash} of `headline` as of the last DELIBERATE freeze/re-freeze — the
   *  rule's intent, which a mere wording correction must never move. */
  meaningHash: string;
  /** ISO date of the most recent deliberate edit to this row, if any. */
  refrozenAt?: string;
  /** WHY this row's `bodySha256` (and, if the rule's meaning genuinely changed, `meaningHash`)
   *  moved — mandatory on any edit (see {@link verifyDoctrineReword}), never inferred from the
   *  diff alone. */
  refrozenReason?: string;
  /** Every id this rule used to carry before a merge folded it in as one sub-case of a canonical
   *  rule (design iv) — see {@link resolveCanonicalRuleId}. Present only on the CANONICAL row. */
  aliases?: string[];
}

/** Normalize a headline down to the words that carry its meaning: markdown emphasis stripped,
 *  everything but letters/digits collapsed to single spaces, lower-cased. Two headlines that
 *  normalize the same way are considered to say the same thing for {@link computeMeaningHash}. */
function normalizeForMeaning(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

/** The rule's MEANING fingerprint — sha256 of its normalized headline. The headline states INTENT
 *  ("a bound that fires on a healthy condition is this repo's recurring defect"); the body is
 *  evidence FOR it. Freezing this instead of the body's exact bytes is what lets a body's wording
 *  be corrected without touching what the rule actually promises. */
export function computeMeaningHash(headline: string): string {
  return createHash("sha256").update(normalizeForMeaning(headline), "utf8").digest("hex");
}

/** A stable id derived from a headline: ASCII, kebab-case, accents stripped, capped at 64
 *  characters so two headlines sharing a long common prefix still diverge in their tail before the
 *  cap bites (every real headline in the fixture diverges well inside that many characters). */
export function slugifyRuleId(headline: string): string {
  const slug = headline
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents left behind by NFKD
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug.slice(0, 64).replace(/-+$/g, "");
}

export type DoctrineRewordVerdict = { ok: true } | { ok: false; reason: string };

/**
 * THE MECHANISM design (i) describes: a frozen row's live body may drift from `row.bodySha256` —
 * that drift is what makes a correction or a reword possible at all — but ONLY when the row itself
 * records BOTH why (`refrozenReason`, non-empty) and that the edit was reviewed against the rule's
 * own meaning (`row.meaningHash` still matches `computeMeaningHash(row.headline)`). A row whose
 * `meaningHash` has drifted from its own headline is refused regardless of `refrozenReason`: that
 * shape means the row's OWN bookkeeping is inconsistent (the headline changed, or the hash was
 * hand-edited, without recomputing the other), which is a worse failure than an un-reasoned reword
 * because it cannot be trusted to describe what the rule means at all.
 */
export function verifyDoctrineReword(row: DoctrineFreezeRow, liveBodySha256: string): DoctrineRewordVerdict {
  if (computeMeaningHash(row.headline) !== row.meaningHash) {
    return {
      ok: false,
      reason: `"${row.headline.slice(0, 60)}" meaningHash does not match its own headline — the row's bookkeeping is inconsistent`,
    };
  }
  if (liveBodySha256 === row.bodySha256) return { ok: true }; // untouched — nothing to justify
  if (!row.refrozenReason || row.refrozenReason.trim().length === 0) {
    return {
      ok: false,
      reason: `"${row.headline.slice(0, 60)}" body drifted from its frozen bytes with no refrozenReason recorded`,
    };
  }
  return { ok: true };
}

// ── (iv): a merged rule keeps every old id resolving ───────────────────────────────────────────

export interface MergedRuleGroup {
  canonicalId: string;
  aliasIds: string[];
}

/** Every id a reader might still hold — the merged rule's own canonical id plus every id it
 *  absorbed — resolves to the ONE canonical id doctrine now stores it under. An id naming no group
 *  resolves to itself: merging is additive, never a trap for an unrelated pointer that was never
 *  part of any merge. */
export function resolveCanonicalRuleId(groups: readonly MergedRuleGroup[], id: string): string {
  for (const group of groups) {
    if (group.canonicalId === id || group.aliasIds.includes(id)) return group.canonicalId;
  }
  return id;
}

// ── (iii): a rule that keeps failing becomes an instrument, automatically ─────────────────────

export interface RuleRecurrenceSnapshot {
  ruleId: string;
  recurrenceCount: number;
}

/**
 * Rules whose recurrence count is RISING between two rule-efficacy passes: at or above `threshold`
 * BOTH times, and strictly higher THIS pass than last. A rule seen for the first time this pass (no
 * `previous` entry) is never "rising" here — there is nothing yet to compare it against, and a
 * first-time crossing is `escalateRepeatingRules`'s own job, not this one's.
 */
export function risingRecurrenceRuleIds(
  previous: readonly RuleRecurrenceSnapshot[],
  current: readonly RuleRecurrenceSnapshot[],
  threshold: number,
): string[] {
  const prevById = new Map(previous.map((r) => [r.ruleId, r.recurrenceCount]));
  const out: string[] = [];
  for (const c of current) {
    if (c.recurrenceCount < threshold) continue;
    const prev = prevById.get(c.ruleId);
    if (prev !== undefined && prev >= threshold && c.recurrenceCount > prev) out.push(c.ruleId);
  }
  return out;
}

/** The proposal id a rule's instrument-task promotion is filed under — deterministic, and
 *  DISTINCT from `rule-efficacy.ts`'s own `ruleEfficacyProposalId`, so a rule that already carries
 *  an open (or declined) plain escalation and then gets WORSE mints a SECOND, more urgent proposal
 *  rather than silently upgrading the first — an operator who already saw and declined the mild ask
 *  still sees the stronger one on its own id. */
export function instrumentTaskProposalId(ruleId: string): string {
  return `instrument-task:${ruleId}`;
}

/** Draft the {@link Proposal} `rule-efficacy.ts`'s `promoteRecurringRules` files for a rule whose
 *  recurrences kept RISING across two passes — "prose restated it and the count went up anyway" is
 *  evidence that an instrument (a mechanized gate), not more prose, is what is missing. PURE:
 *  returns a value and writes nothing — the caller owns the single-writer registry call. */
export function draftInstrumentTaskProposal(
  rule: { ruleId: string; citation: string; description: string; recurrences: readonly { ts: string; step: string }[] },
  priorRecurrenceCount: number,
): Proposal {
  const dates = rule.recurrences.map((r) => r.ts).join(", ");
  const anchors: EvidenceAnchor[] = [];
  return {
    id: instrumentTaskProposalId(rule.ruleId),
    summary:
      `turn-into-instrument: "${rule.ruleId}" (${rule.citation}) recurred ${priorRecurrenceCount} time(s) at the ` +
      `PRIOR rule-efficacy pass and now ${rule.recurrences.length} — RISING, not falling, after already being ` +
      `flagged (rmd rule-efficacy). Dates: ${dates}. The rule stayed prose across an escalation that named it ` +
      `once already; the ask now is a plan task that turns it into an enforced instrument, not another restatement.`,
    evidenceAnchors: anchors,
  };
}
