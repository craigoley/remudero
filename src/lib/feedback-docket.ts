/**
 * lib/feedback-docket.ts — W1-T436: the weekly feedback docket.
 *
 * The harness collects human feedback in FIVE places and consumed it in none: reframe texts
 * (W1-T194), `operator_feedback` ledger lines (verdicts AND steering notes once W1-T435 lands),
 * rejected-feedback reasons (`plan/feedback/`), question answers (`plan/questions.ndjson`), and
 * operator notes (W1-T164, `plan/operator-notes.ndjson`). The same correction gets typed into
 * reframes forever; the artifact that caused it never changes.
 *
 * THE PRACTICE THIS ADAPTS (verified in Warp's own production repo,
 * `update-pr-review-local.yml`: cron Mondays, 7-day lookback, regenerates a review skill from
 * the week's human feedback — "agents need feedback loops, not perfect prompts"): an observer
 * synthesizes the week's human feedback and proposes a diff to the governing artifact,
 * human-gated.
 *
 * TWO PURE SEAMS, BOTH INJECTED-DATA / NO-IO / NO-LLM:
 *  - {@link buildFeedbackDocket} — the ONE named deterministic gather (design i). Every input
 *    is ALREADY-READ data (the caller — `run-task.ts`'s scheduled rung — owns every fs/ledger
 *    read); this module never touches a filesystem for the gather itself. Normalizes all five
 *    surfaces to `{source, ts, verbatim, referent}`, windows them, and counts per source WITH
 *    EMPTY SOURCES NAMED — a docket that silently omits a channel with nothing to say reads as
 *    coverage (the vacuous-pass family this repo's own gates distrust).
 *  - {@link synthesizeFeedbackDocketProposal} — drafts AT MOST ONE inbox-proposal CANDIDATE
 *    (design ii/v) by clustering the docket's items by referent ("the same rule") and quoting
 *    every item in the most-indicted cluster VERBATIM. An empty docket returns `{kind:"empty"}`
 *    and drafts nothing — "a loop that must emit weekly manufactures drift; the no-op path is
 *    first-class" (design).
 *
 * The candidate this module returns is filed through `updateProposalRegistry`
 * (`src/lib/inbox.ts`, the W1-T240 single-writer helper) by `run-task.ts`'s
 * `runFeedbackDocketRung` — the SAME registry, and so the SAME NEEDS-ME/APPROVE/REFRAME console
 * path and the SAME `approveCommand` ratification pipeline (branch, plan PR, CI, review,
 * auto-merge arm) every other proposal already rides. This module never invokes an LLM, never
 * opens a branch, and never writes the registry itself — it only decides WHAT to file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ── The five capture surfaces ────────────────────────────────────────────────────────────────

export type DocketSource = "reframe" | "operator_feedback" | "rejected_feedback" | "question_answer" | "operator_note";

export const DOCKET_SOURCES: readonly DocketSource[] = [
  "reframe",
  "operator_feedback",
  "rejected_feedback",
  "question_answer",
  "operator_note",
];

/** One human-feedback item, normalized to the same shape regardless of which surface produced
 *  it (design i). `referent` is "the same rule" the falsifier speaks of — what this item is
 *  ABOUT, extracted deterministically (see {@link extractReferent}), never inferred by an LLM. */
export interface DocketItem {
  source: DocketSource;
  ts: string;
  verbatim: string;
  referent: string;
}

export interface FeedbackDocketWindow {
  /** Inclusive. */
  sinceIso: string;
  /** Exclusive. */
  untilIso: string;
}

export interface FeedbackDocket {
  window: FeedbackDocketWindow;
  /** Every windowed item across all five surfaces, oldest first. */
  items: DocketItem[];
  countsBySource: Record<DocketSource, number>;
  /** Sources with ZERO items in this window — named, not silently omitted (design i). */
  emptySources: DocketSource[];
}

/** Already-read, unnormalized records for each surface — the caller (run-task.ts's rung) does
 *  every fs/ledger read; {@link buildFeedbackDocket} only normalizes and windows. `ledgerLines`
 *  carries BOTH reframe (`ratify.reframed`) and `operator_feedback` records — both live in the
 *  same append-only ledger (`lib/ledger.ts`). */
export interface RawFeedbackDocketInputs {
  ledgerLines: ReadonlyArray<Record<string, unknown>>;
  rejectedFeedback: ReadonlyArray<{ id: string; ts: string; raw: string }>;
  questionLines: ReadonlyArray<Record<string, unknown>>;
  operatorNotes: ReadonlyArray<{ ts: string; taskId: string; note: string }>;
  window: FeedbackDocketWindow;
}

// ── Referent extraction — deterministic, never an LLM ───────────────────────────────────────

// This codebase's OWN provenance convention (LEARNINGS.md: "Each fact cites its source" via a
// trailing bracket tag, e.g. "...never trust host state without re-probing it. [PR #8]" or
// "[learnings#standing-rule-7]") — reused here rather than invented, so a human who tags their
// own reframe/note with what it is about gets that tag read back deterministically.
const TRAILING_TAG_RE = /\[([^[\]]+)]\s*$/;

/** Extract a deterministic REFERENT from a human feedback string: a trailing bracket tag if
 *  present, else `fallback` (the surface's own natural identifier — a proposal id, task id, or
 *  entry id). Never inferred by an LLM — this is the "no LLM" half of design (i)'s pure gather. */
export function extractReferent(verbatim: string, fallback: string): string {
  const m = TRAILING_TAG_RE.exec(verbatim.trim());
  const tag = m?.[1]?.trim();
  return tag && tag.length > 0 ? tag : fallback;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isInWindow(ts: string, window: FeedbackDocketWindow): boolean {
  return ts >= window.sinceIso && ts < window.untilIso;
}

// ── Per-surface normalizers ──────────────────────────────────────────────────────────────────

function reframeItems(lines: ReadonlyArray<Record<string, unknown>>): DocketItem[] {
  return lines
    .filter((l) => l.step === "ratify.reframed" && typeof l.feedback === "string")
    .map((l) => {
      const verbatim = asString(l.feedback);
      const fallback = asString(l.task_id) || "unknown-proposal";
      return { source: "reframe" as const, ts: asString(l.ts), verbatim, referent: extractReferent(verbatim, fallback) };
    });
}

function operatorFeedbackItems(lines: ReadonlyArray<Record<string, unknown>>): DocketItem[] {
  return lines
    .filter((l) => l.step === "operator_feedback")
    .map((l) => {
      // W1-T435: a steering NOTE, when present, is the human's own words and outranks the
      // bare verdict as the docket's verbatim quote; a verdict with no note still counts.
      const note = typeof l.note === "string" && l.note.trim().length > 0 ? l.note : `verdict: ${asString(l.verdict) || "unknown"}`;
      const fallback = asString(l.task_id) || "unknown-task";
      return {
        source: "operator_feedback" as const,
        ts: asString(l.ts),
        verbatim: note,
        referent: extractReferent(note, fallback),
      };
    });
}

function rejectedFeedbackItems(entries: RawFeedbackDocketInputs["rejectedFeedback"]): DocketItem[] {
  return entries.map((e) => ({
    source: "rejected_feedback" as const,
    ts: e.ts,
    verbatim: e.raw,
    referent: extractReferent(e.raw, e.id),
  }));
}

function questionAnswerItems(lines: ReadonlyArray<Record<string, unknown>>): DocketItem[] {
  return lines
    .filter((l) => typeof l.answer === "string" && l.answer.trim().length > 0)
    .map((l) => {
      const verbatim = asString(l.answer);
      const fallback = asString(l.task) || "unknown-task";
      return { source: "question_answer" as const, ts: asString(l.ts), verbatim, referent: extractReferent(verbatim, fallback) };
    });
}

function operatorNoteItems(notes: RawFeedbackDocketInputs["operatorNotes"]): DocketItem[] {
  return notes.map((n) => ({
    source: "operator_note" as const,
    ts: n.ts,
    verbatim: n.note,
    referent: extractReferent(n.note, n.taskId || "unknown-task"),
  }));
}

/**
 * The docket's ONE named deterministic gather seam (design i) — the call-site criterion greps
 * its CONSUMER (`buildFeedbackDocket(` in `src/run-task.ts`), so the name is load-bearing. Pure
 * over already-read inputs; no fs, no LLM. Normalizes all five capture surfaces, windows them to
 * `[window.sinceIso, window.untilIso)`, and returns counts per source WITH EMPTY SOURCES NAMED.
 */
export function buildFeedbackDocket(inputs: RawFeedbackDocketInputs): FeedbackDocket {
  const bySource: Record<DocketSource, DocketItem[]> = {
    reframe: reframeItems(inputs.ledgerLines),
    operator_feedback: operatorFeedbackItems(inputs.ledgerLines),
    rejected_feedback: rejectedFeedbackItems(inputs.rejectedFeedback),
    question_answer: questionAnswerItems(inputs.questionLines),
    operator_note: operatorNoteItems(inputs.operatorNotes),
  };

  const countsBySource = {} as Record<DocketSource, number>;
  const emptySources: DocketSource[] = [];
  const items: DocketItem[] = [];
  for (const source of DOCKET_SOURCES) {
    const windowed = bySource[source].filter((item) => isInWindow(item.ts, inputs.window));
    countsBySource[source] = windowed.length;
    if (windowed.length === 0) emptySources.push(source);
    items.push(...windowed);
  }
  items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  return { window: inputs.window, items, countsBySource, emptySources };
}

// ── Synthesis: at most ONE inbox proposal per cycle (design ii, v) ─────────────────────────

/** The shape `run-task.ts` hands to `updateProposalRegistry` — deliberately a subset of
 *  `lib/inbox.ts`'s `Proposal` (id/summary/evidenceAnchors) so this module never imports
 *  inbox.ts's types and stays a pure, standalone gather+synthesis seam. */
export interface DocketProposalCandidate {
  id: string;
  summary: string;
  evidenceAnchors: Array<{ description: string; pattern: string; path?: string }>;
}

export type DocketSynthesisResult =
  | { kind: "empty" }
  | { kind: "proposal"; candidate: DocketProposalCandidate; referent: string; consumed: DocketItem[] };

/**
 * Lowercase kebab of arbitrary prose, capped and never empty. EXPORTED (was private) so the
 * ratification writer in lib/inbox.ts reuses this exact rule rather than adding a fourth private
 * copy — `issues-intake.ts` and `ops.ts` each already carry their own near-identical one, and a
 * fifth spelling is how a filename convention drifts from the shards that follow it. `maxLen`
 * defaults to 40, so every existing caller is byte-identical; a caller whose convention is longer
 * (the shard filenames) passes its own.
 */
export function slug(s: string, maxLen = 40): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLen) || "item"
  );
}

/**
 * From a built docket, draft AT MOST ONE inbox-proposal candidate (design ii/v): clusters items
 * by referent ("the same rule" the falsifier speaks of), picks the MOST-indicted referent (ties
 * broken by whichever was raised earliest), and quotes every item in that cluster VERBATIM with
 * its source and timestamp — never a paraphrase, never dropped (design iv: "every proposal
 * cites its docket items verbatim with sources"). An empty docket returns `{kind:"empty"}` and
 * drafts NOTHING — "a loop that must emit weekly manufactures drift; the no-op path is
 * first-class" (design).
 *
 * The candidate's `summary` names the v0-closed target-artifact set (a CLAUDE.md rule, a
 * learnings/ entry, or a review-rubric line — never src/, never a plan shard, never MASTER-PLAN
 * prose) as GUIDANCE for the Architect draft that follows once this is filed — this function
 * never drafts the diff itself (no LLM; that leg is the EXISTING draft rung, `lib/inbox.ts`'s
 * `runDraftRung`, which this task only composes with).
 */
export function synthesizeFeedbackDocketProposal(
  docket: FeedbackDocket,
  opts: { idFor?: (referent: string, window: FeedbackDocketWindow) => string } = {},
): DocketSynthesisResult {
  if (docket.items.length === 0) return { kind: "empty" };

  const byReferent = new Map<string, DocketItem[]>();
  for (const item of docket.items) {
    const list = byReferent.get(item.referent);
    if (list) list.push(item);
    else byReferent.set(item.referent, [item]);
  }

  let winnerReferent = "";
  let winnerItems: DocketItem[] = [];
  for (const [referent, clusterItems] of byReferent) {
    const isLarger = clusterItems.length > winnerItems.length;
    const isEarlierTie = clusterItems.length === winnerItems.length && winnerItems.length > 0 && clusterItems[0].ts < winnerItems[0].ts;
    if (isLarger || isEarlierTie || winnerItems.length === 0) {
      winnerReferent = referent;
      winnerItems = clusterItems;
    }
  }

  const idFor = opts.idFor ?? ((referent, window) => `FD-${window.untilIso.slice(0, 10)}-${slug(referent)}`);
  const id = idFor(winnerReferent, docket.window);
  const quotes = winnerItems.map((i) => `- [${i.source} ${i.ts}] ${i.verbatim}`).join("\n");

  const candidate: DocketProposalCandidate = {
    id,
    summary:
      `Feedback docket ${docket.window.sinceIso}..${docket.window.untilIso}: ${winnerItems.length} item(s) indict "${winnerReferent}".\n` +
      "Target artifact (v0, closed set): a CLAUDE.md rule, a learnings/ entry, or a review-rubric " +
      "line — never src/, never a plan shard, never MASTER-PLAN prose.\n" +
      `Docket excerpt (verbatim, cited):\n${quotes}`,
    evidenceAnchors: [{ description: `"${winnerReferent}" is still an open referent`, pattern: winnerReferent }],
  };

  return { kind: "proposal", candidate, referent: winnerReferent, consumed: winnerItems };
}

// ── Weekly cadence marker — never twice inside one rolling 7-day period ────────────────────

export interface FeedbackDocketMarker {
  lastFireIso: string;
}

/** `<config.root>/state/last-feedback-docket.json` reader; ABSENT/corrupt fails OPEN (fires) —
 *  the honest pre-population state for a daemon that has never run the docket rung yet, the
 *  same "never lies about its own state" posture this file's other markers use (contrast with
 *  auto-triage's spend-bearing marker, which fails CLOSED — this rung's worst failure mode is
 *  one extra weekly cycle, not unattended spend). */
export function readFeedbackDocketMarker(path: string): FeedbackDocketMarker | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return undefined;
    const lastFireIso = (raw as { lastFireIso?: unknown }).lastFireIso;
    return typeof lastFireIso === "string" && !Number.isNaN(Date.parse(lastFireIso)) ? { lastFireIso } : undefined;
  } catch {
    return undefined;
  }
}

export function writeFeedbackDocketMarker(path: string, marker: FeedbackDocketMarker): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker));
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether the docket rung should fire now: never twice inside a rolling 7-day period —
 *  this daemon's continuous-poll-loop translation of the Warp precedent's "cron Mondays, 7-day
 *  lookback". Absent/corrupt marker fires (see {@link readFeedbackDocketMarker}'s doc). */
export function feedbackDocketDue(marker: FeedbackDocketMarker | undefined, now: Date): boolean {
  if (!marker) return true;
  const last = Date.parse(marker.lastFireIso);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= SEVEN_DAYS_MS;
}

/** `[sinceIso, untilIso)` — the rolling 7-day lookback window ending at `now` (design: "cron
 *  Mondays, 7-day lookback", Warp's `update-pr-review-local.yml` precedent). */
export function feedbackDocketLookbackWindow(now: Date): FeedbackDocketWindow {
  return { sinceIso: new Date(now.getTime() - SEVEN_DAYS_MS).toISOString(), untilIso: now.toISOString() };
}
