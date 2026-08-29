import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { updateProposalRegistry, type EvidenceAnchor, type Proposal, type UpdateProposalRegistryOpts } from "./inbox.js";

/**
 * lib/board-review.ts — W1-T2304: the rung whose UNIT is the whole open board, not one PR.
 *
 * THE GAP THIS CLOSES. `runSweep`'s `DISPOSITION_RULES` and the fix rung both read ONE PR.
 * `retroTriggerCheck` reads runs since a marker. `decideAutoTriage` reads queue capacity. The
 * sweep's one cross-PR reading — `baseCausedCheckName(pr, allPrs)` — is undefined below two PRs
 * and can only ask "is this red base-caused". Nothing reads the board as a board: an operator ran
 * that loop by hand across 2026-08-25/26 and it produced four merged fixes and five filed shards,
 * none of them reachable from inside a single PR's diff (this task's own rationale).
 *
 * THE TRIGGER IS THIS MODULE'S FIRST CONCERN (design (i)), not an afterthought bolted onto a
 * report nobody schedules — a rung without its own trigger is the "merged, green, unreached"
 * class {@link ADOPTION_SHAPE4_PREDICATES} in `measurement-cadence.ts` exists to name. Three DEPTH
 * signals, thresholds derived rather than chosen (measured 2026-08-26): oldest open non-draft age
 * >= {@link BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS} (3x the P90 across the last 50 merged PRs); red
 * count >= {@link BOARD_REVIEW_MIN_RED_COUNT} (structural: one red is the fix rung's own turf, and
 * `baseCausedCheckName` is undefined below two); any unhandled escalation. OPEN COUNT IS NOT A
 * SIGNAL — the board cycled at 4-7 open all night while the hand loop found five defects, so total
 * open count is never read as a depth signal here.
 *
 * OWNERSHIP: `decideMeasurementCadence`'s marker/`minIntervalMinutes`/`maxPerDay PRIMITIVE, a
 * FOURTH VERB on that existing spine (W1-T1259), never a fourth cadence. The marker/pacing shape
 * below is a DELIBERATE, SMALL DUPLICATION of `measurement-cadence.ts`'s own marker functions —
 * not an import — because `measurement-cadence.ts` is this module's CALLER (it wires
 * {@link buildBoardReview} in so the cadence spine reaches it, per this task's own acceptance
 * criterion), and importing back from it would be a cycle. `defaultMeasurementCadenceGitLog`'s own
 * doc comment sets this precedent: "a deliberate, small duplication rather than a cross-layer
 * import."
 *
 * AUTHORITY, READ-ONLY BY CONSTRUCTION (design (ii)). {@link buildBoardReview} reads the whole
 * open board, diagnoses it, writes ONE report artifact, and files registry proposals — nothing
 * else. Its one sanctioned action is re-running a check that died before any test body ran, at
 * most once per fire, through an INJECTED hook (`rerunDeadCheck`) — never a direct API call from
 * this pure module. It pushes to no branch, resolves no conflict, edits no PR body, and a draft
 * (`isDraft === true`) is never counted toward any signal.
 *
 * MINING RIDES THE EXISTING RULE-15 VEHICLE UNCHANGED (design (iii)): findings become proposal
 * candidates through `updateProposalRegistry` — the single writer (W1-T240) — exactly as
 * `rule-efficacy.ts`'s own `escalateRepeatingRules` does. This module FILES NOTHING AND MINTS NO
 * TASK ID; the inbox's tiering and an operator's ratification own a proposal's fate from there.
 *
 * THE RECURSION, BOUNDED (design (iv)): {@link boardItemsInScope} drops every board item born from
 * this rung's own proposals (an `originatesFromProposalId` set on it) until that item's status is
 * `"merged"` or `"dead"` — so a proposal this rung drafted can never inflate the very signal that
 * produced it while it is still in flight. Ratification and the merge gate still own every
 * outcome; this module only refuses to look at its own in-flight children.
 */

// ── Depth thresholds (design (i)) ──────────────────────────────────────────────────────────────

/** 3x the P90 (2.5h) across the last 50 merged PRs measured 2026-08-26 (median 23 minutes); the
 *  night's two real stragglers sat at 19h and 13h. */
export const BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS = 8;

/** Structural, not chosen: one red PR is the fix rung's own home turf, and
 *  `baseCausedCheckName(pr, allPrs)` (lib/sweep.ts) is undefined below two PRs — a cross-PR
 *  reading needs at least two to exist at all. */
export const BOARD_REVIEW_MIN_RED_COUNT = 2;

// ── The board itself ───────────────────────────────────────────────────────────────────────────

export type BoardItemStatus = "open" | "merged" | "dead";

/** One item on the whole open board (a PR, in production) — the unit this rung reads, where every
 *  other rung reads either one PR or a marker/queue-depth proxy. */
export interface BoardItem {
  /** Stable identifier (e.g. a PR number or url) — never re-used across items. */
  id: string;
  isDraft: boolean;
  status: BoardItemStatus;
  /** Hours since this item opened. Only consulted for `status === "open"` items. */
  ageHours: number;
  /** Count of this item's own failing/red checks. Only whether it is `> 0` feeds the board's red
   *  count — this rung asks "how many PRs are red", never "how red is one PR" (that finer-grained
   *  question is the fix rung's turf). */
  redCheckCount: number;
  /** Escalations raised against this item with no operator acknowledgement yet. */
  unhandledEscalations: number;
  /** The escalation's real one-line ask (W1-T182's `StatusProjection.escalationTitle`, threaded
   *  through unread by {@link BoardItem}'s mapper — W1-T2453) — the live issue's title, so a
   *  candidate this rung mints is decidable from its own text rather than only from a count.
   *  Present iff `unhandledEscalations > 0` AND the source projection's title could actually be
   *  read; absent whenever it could not (see {@link escalationUnverified}'s doc for that case),
   *  same sparse convention `StatusProjection` itself uses. */
  escalationTitle?: string;
  /** The escalation issue's own URL (W1-T182's `StatusProjection.escalationIssueUrl`, threaded
   *  through — W1-T2453), so a finding can link directly rather than soliciting a URL the
   *  projection already holds. Present iff `unhandledEscalations > 0` and the source projection
   *  carried one. */
  escalationIssueUrl?: string;
  /** True when the escalation is known but its issue's title/state could NOT be confirmed
   *  (W1-T182's `StatusProjection.escalationUnverified`, threaded through — W1-T2453) — the
   *  FAIL-CLOSED case: the finding still fires and still names the item, its summary just says
   *  the ask could not be read rather than silently rendering as an ordinary bare count. Present
   *  only alongside `unhandledEscalations > 0`, same sparse convention as the fields above. */
  escalationUnverified?: true;
  /** Set when a check on this item died before any test body ran (an infra death, never a real
   *  test failure) — the population {@link buildBoardReview}'s one sanctioned action draws from. */
  deadBeforeTestBody?: boolean;
  /** Set when this item was born from a proposal THIS rung drafted (design (iv)'s recursion
   *  bound) — the registry proposal id that produced it. Absent for every item that arose any
   *  other way (the overwhelming common case). */
  originatesFromProposalId?: string;
}

/** Design (iv)'s recursion bound, mechanized: an item born from this rung's own proposal is
 *  excluded from every depth signal and every finding until it has left the "open" state — this
 *  rung diagnoses the board it found, never the board it made. Every other item passes through
 *  unchanged. */
export function boardItemsInScope(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((it) => !it.originatesFromProposalId || it.status !== "open");
}

function nonDraftOpen(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((it) => !it.isDraft && it.status === "open");
}

// ── The depth trigger (design (i)) — pure, no marker, no pacing ───────────────────────────────

export interface BoardReviewTriggerInputs {
  items: readonly BoardItem[];
}

export type BoardReviewTriggerDecision = { fire: true; reason: string } | { fire: false; reason: string };

/** Depth-only: does the CURRENT shape of the board justify a read, ignoring pacing entirely.
 *  {@link decideBoardReviewCadence} below applies the marker/interval/cap bound on TOP of this. */
export function decideBoardReviewTrigger(inputs: BoardReviewTriggerInputs): BoardReviewTriggerDecision {
  const inScope = nonDraftOpen(boardItemsInScope(inputs.items));

  const oldestOpenAgeHours = inScope.length ? Math.max(...inScope.map((it) => it.ageHours)) : 0;
  if (oldestOpenAgeHours >= BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS) {
    return {
      fire: true,
      reason:
        `oldest open non-draft item has sat ${oldestOpenAgeHours.toFixed(1)}h ` +
        `(>= ${BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS}h threshold)`,
    };
  }

  const unhandledEscalationCount = inScope.reduce((sum, it) => sum + it.unhandledEscalations, 0);
  if (unhandledEscalationCount >= 1) {
    return { fire: true, reason: `${unhandledEscalationCount} unhandled escalation(s) on the open board` };
  }

  const redCount = inScope.reduce((sum, it) => sum + (it.redCheckCount > 0 ? 1 : 0), 0);
  if (redCount >= BOARD_REVIEW_MIN_RED_COUNT) {
    return { fire: true, reason: `${redCount} PR(s) carry a red check (>= ${BOARD_REVIEW_MIN_RED_COUNT} threshold)` };
  }

  return {
    fire: false,
    reason:
      `board younger than every depth threshold — oldest open ${oldestOpenAgeHours.toFixed(1)}h, ` +
      `red count ${redCount}, ${unhandledEscalationCount} unhandled escalation(s)`,
  };
}

// ── The pacing bound — a deliberate, small duplication of measurement-cadence.ts's marker shape
//    (see this file's header doc for why it isn't an import) ─────────────────────────────────────

export interface BoardReviewPolicy {
  enabled: boolean;
  minIntervalMinutes: number;
  maxPerDay: number;
}

export interface BoardReviewMarker {
  /** ISO timestamps of recent fires, newest last. Trimmed to the rolling window by the writer. */
  fires: string[];
}

export type BoardReviewMarkerResolution =
  | { kind: "ok"; marker: BoardReviewMarker }
  | { kind: "absent" }
  | { kind: "corrupt" };

export function boardReviewMarkerPath(root: string): string {
  return join(root, "state", "last-board-review.json");
}

/** A malformed file resolves `corrupt`, NOT `absent` — the caller must fail closed on it, exactly
 *  as `readMeasurementCadenceMarker`/`readAutoTriageMarker` do. */
export function readBoardReviewMarker(path: string): BoardReviewMarkerResolution {
  if (!existsSync(path)) return { kind: "absent" };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return { kind: "corrupt" };
    const fires = (raw as BoardReviewMarker).fires;
    if (!Array.isArray(fires) || fires.some((f) => typeof f !== "string")) return { kind: "corrupt" };
    return { kind: "ok", marker: { fires } };
  } catch {
    return { kind: "corrupt" };
  }
}

/** Append a fire and trim to the rolling window. NEVER called from inside {@link buildBoardReview}
 *  itself (design's own writes bound, acceptance criterion 5) — this is the daemon wiring's own
 *  "record the fire first" step (mirroring `buildMeasurementCadenceDaemonHooks`'s `run` hook),
 *  left for that follow-up wiring to call. */
export function recordBoardReviewFire(path: string, at: Date, windowMs: number): BoardReviewMarker {
  const prior = readBoardReviewMarker(path);
  const kept =
    prior.kind === "ok"
      ? prior.marker.fires.filter((f) => at.getTime() - Date.parse(f) < windowMs && !Number.isNaN(Date.parse(f)))
      : [];
  const marker: BoardReviewMarker = { fires: [...kept, at.toISOString()] };
  // W1: THE DIRECTORY IS CREATED, NOT ASSUMED — and the failure mode this closes is the expensive
  // one. A bare write into an absent `state/` throws ENOENT BEFORE the marker lands, and an absent
  // marker correctly resolves to NO PRIOR FIRE, so the cadence check reads `fire: true` on every
  // tick forever and each fire pays for a whole re-read. MEASURED on a root without `state/`:
  // three consecutive ticks, all `fire: true`, no marker on disk, every run throwing.
  //
  // FOUR OF THE SEVEN `last-*.json` WRITERS ALREADY DO THIS (`last-seen.ts`, `digest.ts`,
  // `feedback-docket.ts`'s `writeFeedbackDocketMarker`, `retro.ts`) — one of them,
  // `recordDigestCadenceFire`, mkdirs and then delegates HERE, which is a caller working around
  // this very gap. This makes the writer carry the guarantee instead of its callers.
  //
  // IT CHANGES NOTHING ELSE. Same path, same contents, same rolling-window argument, and the
  // read side is untouched: a marker that EXISTS and cannot be parsed still fails closed, while an
  // ABSENT marker still means no prior fire. That distinction is the point and survives.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker, null, 2));
  return marker;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BoardReviewCadenceInputs {
  policy: BoardReviewPolicy;
  marker: BoardReviewMarkerResolution;
  now: Date;
  items: readonly BoardItem[];
}

export type BoardReviewCadenceDecision = BoardReviewTriggerDecision;

/** The rung's real fire decision: the depth trigger (design (i)) gated by the SAME marker/
 *  interval/cap shape every other cadence in this fleet uses, on this rung's OWN policy row —
 *  never a fourth cadence bolted onto `measurementCadence`'s (design's own "Ownership" note). */
export function decideBoardReviewCadence(i: BoardReviewCadenceInputs): BoardReviewCadenceDecision {
  if (!i.policy.enabled) {
    return { fire: false, reason: "board review disabled (policy.boardReview.enabled=false)" };
  }
  if (i.marker.kind === "corrupt") {
    return { fire: false, reason: "board review marker unreadable — failing closed" };
  }

  const depth = decideBoardReviewTrigger({ items: i.items });
  if (!depth.fire) return depth;

  const fires = i.marker.kind === "ok" ? i.marker.marker.fires : [];
  const parsed = fires.map((f) => Date.parse(f)).filter((n) => !Number.isNaN(n));

  const lastFire = parsed.length ? Math.max(...parsed) : undefined;
  if (lastFire !== undefined) {
    const sinceMin = (i.now.getTime() - lastFire) / 60_000;
    if (sinceMin < i.policy.minIntervalMinutes) {
      return {
        fire: false,
        reason:
          `depth trigger fired (${depth.reason}) but only ${sinceMin.toFixed(1)}m since the last run ` +
          `(minInterval ${i.policy.minIntervalMinutes}m)`,
      };
    }
  }

  const inWindow = parsed.filter((t) => i.now.getTime() - t < DAY_MS).length;
  if (inWindow >= i.policy.maxPerDay) {
    return {
      fire: false,
      reason: `depth trigger fired (${depth.reason}) but daily cap reached (${inWindow}/${i.policy.maxPerDay} in the last 24h)`,
    };
  }

  return { fire: true, reason: depth.reason };
}

// ── The producer (design (ii)/(iii)) ───────────────────────────────────────────────────────────

interface BoardFinding {
  id: string;
  summary: string;
  /** The board item that produced this finding (W1-T2451) — carried through onto the minted
   *  proposal's OWN {@link Proposal.originatingItemId} so referent liveness becomes an
   *  expressible, structured fact rather than something a reader has to parse back out of the
   *  `id` string (see this task's own header note on why {@link approveRunBranch}'s id-shape
   *  enumeration is a warning sign, not a reusable identity source). */
  itemId: string;
}

/** Findings become proposal candidates, never tasks (design (iii)) — one per stale item and one
 *  per item carrying unhandled escalations, over the SAME in-scope, non-draft-open population the
 *  trigger itself reads. */
function diagnoseBoardFindings(items: readonly BoardItem[]): BoardFinding[] {
  const findings: BoardFinding[] = [];
  for (const it of items) {
    if (it.ageHours >= BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS) {
      findings.push({
        id: `board-review:stale:${it.id}`,
        summary:
          `board-review: ${it.id} has sat open ${it.ageHours.toFixed(1)}h, past the ` +
          `${BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS}h depth threshold`,
        itemId: it.id,
      });
    }
    if (it.unhandledEscalations > 0) {
      // W1-T2453: NAME the escalation instead of just counting it — the ask and the link are
      // already on the item (threaded from `StatusProjection` by the mapper, zero extra reads),
      // so a candidate is decidable from its own text. HONEST ABSENCE (design (iii), inheriting
      // W1-T182's FAIL-CLOSED direction): a title that could not be read is never dropped and
      // never silently rendered as the old bare count — the summary SAYS so instead.
      const summary = it.escalationTitle
        ? `board-review: ${it.id} — unhandled escalation: "${it.escalationTitle}"` +
          (it.escalationIssueUrl ? ` — ${it.escalationIssueUrl}` : "")
        : `board-review: ${it.id} carries an unhandled escalation whose ask could not be read` +
          (it.escalationUnverified ? " (issue state unverified)" : "") +
          (it.escalationIssueUrl ? ` — ${it.escalationIssueUrl}` : "");
      findings.push({
        id: `board-review:escalation:${it.id}`,
        summary,
        itemId: it.id,
      });
    }
  }
  return findings;
}

export interface BoardReviewReport {
  generatedAt: string;
  fire: boolean;
  reason: string;
  oldestOpenAgeHours: number;
  redCount: number;
  unhandledEscalationCount: number;
  itemsConsidered: number;
  /** Items dropped by {@link boardItemsInScope} — this rung's own in-flight children. */
  itemsExcludedAsSelfProduced: number;
  /** Registry proposal ids actually drafted this run (empty on a no-fire tick, or when every
   *  candidate was already open — `updateProposalRegistry`'s own idempotence). */
  proposalIds: string[];
  /** Set only when the one sanctioned action (design (ii)) actually ran this tick. */
  rerunAttempted?: { itemId: string; at: string };
}

export interface BuildBoardReviewOpts {
  policy: BoardReviewPolicy;
  marker: BoardReviewMarkerResolution;
  items: readonly BoardItem[];
  now?: Date;
  /** `<root>/state`-shaped roots for the two paths below — same convention as
   *  `measurement-cadence.ts`'s own `stateDir`. */
  reportPath: string;
  registryPath: string;
  /** Injectable — production takes a real `writeFileSync`. Tests intercept to prove this is the
   *  ONLY non-registry write this module ever makes (acceptance criterion 5). */
  writeReport?: (path: string, content: string) => void;
  /** Injectable — production takes `updateProposalRegistry` (the W1-T240 single writer). */
  updateRegistry?: (
    registryPath: string,
    update: (current: Proposal[]) => Proposal[] | null,
    opts?: UpdateProposalRegistryOpts,
  ) => Proposal[] | null;
  /** The ONE sanctioned action (design (ii)): re-run a check that died before any test body ran,
   *  at most once per fire. Omitted ⇒ report-only, no action taken — never a direct API call from
   *  this pure module. */
  rerunDeadCheck?: (item: BoardItem) => void;
}

/**
 * Run one board-review tick. Callers decide WHETHER to call this (via
 * {@link decideBoardReviewCadence}); this function assumes it should run and does the read +
 * diagnose + write. Its ONLY writes are the report artifact and, when findings exist, the
 * registry proposals it drafts through `updateRegistry` — it never records its own fire (that is
 * the daemon wiring's job, mirroring `buildMeasurementCadenceDaemonHooks`'s "record the fire
 * first" hook) and it never writes a marker, a task, or a PR itself.
 */
export function buildBoardReview(opts: BuildBoardReviewOpts): BoardReviewReport {
  const now = opts.now ?? new Date();
  const writeReport = opts.writeReport ?? ((path, content) => writeFileSync(path, content));
  const updateRegistry = opts.updateRegistry ?? updateProposalRegistry;

  const decision = decideBoardReviewCadence({ policy: opts.policy, marker: opts.marker, now, items: opts.items });

  const inScope = boardItemsInScope(opts.items);
  const relevant = nonDraftOpen(inScope);
  const oldestOpenAgeHours = relevant.length ? Math.max(...relevant.map((it) => it.ageHours)) : 0;
  const redCount = relevant.reduce((sum, it) => sum + (it.redCheckCount > 0 ? 1 : 0), 0);
  const unhandledEscalationCount = relevant.reduce((sum, it) => sum + it.unhandledEscalations, 0);

  const report: BoardReviewReport = {
    generatedAt: now.toISOString(),
    fire: decision.fire,
    reason: decision.reason,
    oldestOpenAgeHours,
    redCount,
    unhandledEscalationCount,
    itemsConsidered: inScope.length,
    itemsExcludedAsSelfProduced: opts.items.length - inScope.length,
    proposalIds: [],
  };

  if (!decision.fire) {
    writeReport(opts.reportPath, JSON.stringify(report, null, 2));
    return report;
  }

  // ── mining: findings become proposal candidates through the registry — the single writer,
  // exactly as rule-efficacy.ts's escalateRepeatingRules does (design (iii)) ────────────────────
  const findings = diagnoseBoardFindings(relevant);
  if (findings.length > 0) {
    const drafted = updateRegistry(opts.registryPath, (current) => {
      const existingIds = new Set(current.map((p) => p.id));
      const additions: Proposal[] = findings
        .filter((f) => !existingIds.has(f.id))
        .map((f) => ({
          id: f.id,
          summary: f.summary,
          evidenceAnchors: [] as EvidenceAnchor[],
          // W1-T2451: bind the referent structurally. `evidenceAnchors` is permanently empty for
          // this whole proposal family (a PR NUMBER is not in the tree — a git-grep anchor would
          // be a category error dressed as a fix, per this task's own design), which makes the
          // `evidence_anchors` drift predicate mechanically unreachable for it. Recording WHICH
          // board item minted this finding is what lets classifyProposal (inbox.ts) ask "has the
          // referent resolved" instead — a question the id string alone couldn't structurally
          // answer.
          originatingItemId: f.itemId,
        }));
      return additions.length > 0 ? [...current, ...additions] : null;
    });
    const draftedIds = new Set((drafted ?? []).map((p) => p.id));
    report.proposalIds = findings.map((f) => f.id).filter((id) => draftedIds.has(id));
  }

  // ── the ONE sanctioned action (design (ii)): re-run a check dead before any test body ran,
  // at most once per fire ──────────────────────────────────────────────────────────────────────
  const deadCheckItem = relevant.find((it) => it.deadBeforeTestBody);
  if (deadCheckItem && opts.rerunDeadCheck) {
    opts.rerunDeadCheck(deadCheckItem);
    report.rerunAttempted = { itemId: deadCheckItem.id, at: now.toISOString() };
  }

  writeReport(opts.reportPath, JSON.stringify(report, null, 2));
  return report;
}
