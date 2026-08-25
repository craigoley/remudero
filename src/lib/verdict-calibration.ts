// lib/verdict-calibration.ts — THE CORRECTNESS JOIN (W1-T424).
//
// THE GAP THIS CLOSES. Every armed merge carries a review verdict in the ledger
// (`automerge.armed` naming the task/head it armed, `review.posted` naming whether that verdict
// was a clean full PASS, fell back to the keyword floor on some criteria, or was CAPPED and only
// armed via an override) — and its post-merge reality is ordinary git history (reverts, and
// fix-typed merges that land nearby). But nothing JOINS the two, so no one can say whether a
// full-PASS verdict predicts stability better than a degraded one, or whether the review floor's
// month of hardening (W1-T273, T362, T387, T400, T401) moved outcomes at all. This module builds
// that join. Completes the measurement triad: W1-T418 measures whether RULES prevent; W1-T423
// locks what JUDGMENT concludes; this measures whether judgment PREDICTS.
//
// A HOST-SIDE VERB, LIKE W1-T418 AND FOR THE SAME REASON: the ledger lives on the daemon host;
// the git side is local history; neither needs the network beyond an ordinary fetch.
//
// THE TWO CORPORA. {@link verdictCalibrationReport} — the entry export, the name is
// load-bearing — is PURE over its two supplied corpora:
//   (a) VERDICT ROWS ({@link VerdictRow}), mined by {@link mineVerdictRows} from the ledger
//       UNION (lib/ledger-grep.ts's `resolveLedgerUnion` — never the live file alone, which is
//       ~0.3% of history, the same undercount lib/rule-efficacy.ts's own module doc measured).
//       Each row joins an `automerge.armed` line (the arm event: task id, head sha, arm
//       timestamp) to the `review.posted` line for the SAME task+head (the verdict that
//       permitted the arm), classifying it {@link VerdictClass}: `full-pass` (clean, no keyword
//       floor anywhere), `keyword-floor` (`floor_degraded` — some criteria fell back while the
//       verdict was NOT capped) or `degraded-arm` (`capped` — zero proofs executed, armed only
//       via a plan-only carve-out or an explicit operator override). A row with no matching
//       `review.posted` line, OR whose `automerge.armed` line itself carried no `head_sha` at all
//       (W1-T2258 — only the review lane's own arm helper put one on the row before this task;
//       every other lane's arm silently could not join), carries `verdictClass: null` and is
//       reported UNMEASURABLE, honestly, with the two shapes told apart by `unjoinableCause` —
//       never silently dropped or guessed, and never merged into one undifferentiated count.
//   (b) a GIT EVENT dump ({@link parseGitEventDump}), the failing-split classifier's
//       `%s%x00%b%x01` shape (run-task.ts's `classifyFailingMergeEvidence`) extended with a
//       leading `\x02` record separator plus the commit sha and committer-date-ISO (needed to
//       locate a SPECIFIC merge commit and date reverts/fixes against it) and `--name-only`'s
//       per-commit file list (needed for the follow-up-fix overlap rule) — see
//       `defaultVerdictCalibrationGitLog` (run-task.ts) for the exact `git log` invocation.
//
// THE JOIN, PER ROW. The row's merge commit is the EARLIEST commit citing its task id (the same
// delimiter-bounded citation idiom `classifyFailingMergeEvidence` uses, widened with the `#<n>`
// form for the synthetic `PR-<n>` ids task-less `rmd review` PRs carry) at or after the arm
// timestamp — "earliest after the arm" is what separates the merge itself from a LATER commit
// that also happens to cite the same task id (a genuine follow-up fix). No such commit means the
// merge sha cannot be recovered, so the row is UNMEASURABLE — the P48 no-naked-zero clause; a
// rate over a silently shrunken denominator is the exact lie this verb exists to end.
//
// FOLLOW-UP FIX ATTRIBUTION IS THE JUDGMENT CALL, SO IT IS DATA ({@link ATTRIBUTION_POLICY}):
// the window (`windowDays`) and the overlap rule live in one exported policy object this
// module's report cites in its own output — moving the boundary is a reviewed diff, not a
// hidden constant. A fix-typed commit (subject matching `/^fix(\(|:)/i`) attributes to a
// verdict's merge when, within the window, EITHER its changed files intersect the merge's
// changed files OR it cites the verdict's task id — citing NEITHER attributes to NOTHING, the
// over-attribution guard (a busy repo fixes things near everything, so file proximity alone
// would over-credit blame onto every verdict class equally and erase the signal this verb
// exists to surface). Reverts use the SAME window: a revert-typed commit (`This reverts commit
// <sha>` naming the merge, or a `Revert` subject citing the same task id) inside the window is a
// miss; the same revert dated outside the window is not.
//
// A MINIMUM-POPULATION FLOOR ({@link MIN_POPULATION_FLOOR}): below that many rows in a verdict
// class, the report prints the count and REFUSES the rate — a percentage over a handful of
// merges is an anecdote wearing a metric.
//
// NOT IN SCOPE: changing any verdict; auto-filing tuning tasks (a follow-on composing with
// W1-T418's inbox machinery once this metric has a baseline); confidence scores the verdicts do
// not yet log (their own small task once this join proves the read side). This verb is
// READ-ONLY — it files nothing and proposes nothing.

import { resolveLedgerUnion, type LedgerGrepFsDeps, type LedgerUnionResult } from "./ledger-grep.js";

// ── The verdict side ────────────────────────────────────────────────────────────────────────

export type VerdictClass = "full-pass" | "keyword-floor" | "degraded-arm";

/** Why a {@link VerdictRow} could not be joined to a merge/rate — see {@link
 *  VerdictCalibrationReport.unmeasurableByCause}. `no-head-sha` and `no-review-posted` are set by
 *  {@link mineVerdictRows} (the MINING side: two different reasons the verdict is unrecoverable —
 *  the arm row itself never carried a head, vs one that did but found no matching verdict);
 *  `merge-sha-unrecoverable` and `git-history-unavailable` are set by {@link
 *  verdictCalibrationReport} (the JOIN side, against git history). Kept as ONE enum, not two
 *  parallel ones, so a consumer breaking the count down by cause never has to know which stage
 *  produced it — W1-T2258's whole point is that these must never be merged into a single silent
 *  drop again. */
export type UnmeasurableCause = "no-head-sha" | "no-review-posted" | "merge-sha-unrecoverable" | "git-history-unavailable";

/** One armed merge's verdict, joined from an `automerge.armed` line to its `review.posted`
 *  line. `verdictClass` is `null` — never a guessed default — when the row could not be
 *  classified; `classifyWhy`/`unjoinableCause` then name the reason. */
export interface VerdictRow {
  taskId: string;
  /** ABSENT exactly when the `automerge.armed` line itself carried no `head_sha` (W1-T2258) —
   *  never inferred or defaulted (the module doc's "NOTHING BACKFILLS" clause). A row in this
   *  shape can never join to a `review.posted` line (there is no key to join on) and always
   *  carries `verdictClass: null` with `unjoinableCause: "no-head-sha"`. */
  headSha?: string;
  /** The `automerge.armed` line's own `ts` — the arm event, used to locate the merge commit
   *  (the earliest task-id-citing commit AT OR AFTER this instant). */
  armedTs: string;
  /** The `automerge.armed` line's own `lane` field (W1-T449: `"review"` | `"operator"` |
   *  `"sweep"`, or the ambient lane a caller's own ledger-append closure defaulted to when the
   *  row was written outside `logArmAttribution`, e.g. `"run-task"`), when present. ABSENT for
   *  every row mined before W1-T449 added the field. Read-only passthrough — this module never
   *  classifies differently by lane; {@link verdictCalibrationReport} uses it only to LABEL which
   *  population a published rate was computed over, never to re-derive a verdict (design note
   *  (v): "the review lane is the only one that posts a review.posted row at all" — reviewCommand's
   *  own ledger-append closure hardcodes `lane: "review"` on every `review.posted` line it writes,
   *  whichever higher-level command called it, so a class populated from more than one ARM lane is
   *  blending judgments of different rigor under one rate). */
  lane?: string;
  verdictClass: VerdictClass | null;
  /** Present only when `verdictClass === null`. */
  classifyWhy?: string;
  /** Present only when `verdictClass === null` and set by {@link mineVerdictRows} itself (never
   *  guessed downstream) — see {@link UnmeasurableCause}'s own doc for why this stays a single
   *  enum shared with the join-side causes. */
  unjoinableCause?: "no-head-sha" | "no-review-posted";
}

export interface VerdictMiningResult {
  /** ALWAYS set — unlike lib/rule-efficacy.ts's `ledger` (which stays `undefined` when its
   *  signature table has no measurable rule at all, skipping the read entirely),
   *  {@link mineVerdictRows} unconditionally calls `resolveLedgerUnion` — there is no
   *  "nothing to look for" case here, only `ok: true`/`ok: false`. */
  ledger: LedgerUnionResult;
  rows: VerdictRow[];
}

function parseLedgerJson(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Mine {@link VerdictRow}s from the ledger UNION under `stateDir` (never the live file alone —
 * see the module doc). ONE union read matching both `automerge.armed` and `review.posted` lines,
 * then joined in memory by `task_id`+`head_sha`. When the union itself can't be read (zero
 * archive files matched), this returns zero rows — the same "degrade rather than answer from a
 * live-file-only fragment" discipline lib/rule-efficacy.ts's `ruleEfficacyReport` follows.
 */
export function mineVerdictRows(stateDir: string, fsDeps?: LedgerGrepFsDeps): VerdictMiningResult {
  const pattern = /"step":"(?:automerge\.armed|review\.posted)"/;
  const ledger = resolveLedgerUnion(stateDir, pattern, fsDeps);
  if (!ledger.ok) return { ledger, rows: [] };

  const armedLines: Record<string, unknown>[] = [];
  // Keyed `taskId\0headSha`; last-write-wins in ledger iteration order (archives sorted,
  // then the live file) — the same "most recent line for this key" idiom
  // `cappedOverrideFromLedger` (lib/review.ts) already uses for the same corpus.
  const posted = new Map<string, Record<string, unknown>>();
  for (const raw of ledger.matches) {
    const line = parseLedgerJson(raw);
    if (!line) continue;
    if (line.step === "automerge.armed") {
      armedLines.push(line);
    } else if (line.step === "review.posted") {
      const taskId = typeof line.task_id === "string" ? line.task_id : undefined;
      const headSha = typeof line.head_sha === "string" ? line.head_sha : undefined;
      if (taskId && headSha) posted.set(`${taskId}\0${headSha}`, line);
    }
  }

  const rows: VerdictRow[] = [];
  for (const line of armedLines) {
    const taskId = typeof line.task_id === "string" ? line.task_id : undefined;
    const headSha = typeof line.head_sha === "string" ? line.head_sha : undefined;
    const armedTs = typeof line.ts === "string" ? line.ts : undefined;
    const lane = typeof line.lane === "string" ? line.lane : undefined;
    // No task id or no arm timestamp: genuinely no identity to key or date a row by — this
    // `continue` stays silent, matching resolveLedgerUnion's own line-shape discipline.
    if (!taskId || !armedTs) continue;
    // W1-T2258 — THE DEFECT THIS CLOSES. This used to share ONE guard with the branch above
    // (`!taskId || !headSha || !armedTs`), so a row with a real task id and timestamp but no
    // `head_sha` was dropped exactly as silently as a structurally malformed line — no
    // `classifyWhy`, no entry in the unmeasurable list — even though `:139-149` two lines below
    // already had the vocabulary for "counted, and here is why it could not be classified".
    // Measured: only the review lane's own arm helper (`armIfVerdictPermits`) put `head_sha` on
    // its row; every other lane's arm (run-task's deferred at-verdict arm, and every
    // `armAndLogOutcome` caller: dep-review, retro, triage, plan, approve, sweep) systematically
    // did not — a LANE SPLIT, not a sample, so a caveat alone would still misrepresent the
    // resulting rate as fleet-wide (see verdictCalibrationReport's own doc).
    if (!headSha) {
      rows.push({
        taskId,
        armedTs,
        lane,
        verdictClass: null,
        unjoinableCause: "no-head-sha",
        classifyWhy:
          `automerge.armed row for task ${taskId} at ${armedTs} carries no head_sha — this arm's ` +
          "write path never put one on the row, so it cannot be joined to any review.posted line " +
          "(never inferred from the PR's current head, a git read, or defaulted)",
      });
      continue;
    }
    const postedLine = posted.get(`${taskId}\0${headSha}`);
    if (!postedLine) {
      rows.push({
        taskId,
        headSha,
        armedTs,
        lane,
        verdictClass: null,
        unjoinableCause: "no-review-posted",
        classifyWhy:
          `no matching review.posted line for task ${taskId} at head ${headSha} — the verdict ` +
          "this arm relied on could not be recovered from the union",
      });
      continue;
    }
    const verdictClass: VerdictClass =
      postedLine.capped === true ? "degraded-arm" : postedLine.floor_degraded === true ? "keyword-floor" : "full-pass";
    rows.push({ taskId, headSha, armedTs, lane, verdictClass });
  }
  return { ledger, rows };
}

// ── The git side ────────────────────────────────────────────────────────────────────────────

/** One commit off the git-event dump — see the module doc for the exact `git log` shape
 *  `defaultVerdictCalibrationGitLog` (run-task.ts) produces. */
export interface GitCommitEvent {
  sha: string;
  /** Committer date, ISO 8601 (`%cI`) — the merge commit's own date IS its merge date. */
  ts: string;
  subject: string;
  body: string;
  /** `--name-only`'s per-commit changed-file list. */
  files: string[];
}

/**
 * Parse the `\x02%H%x00%cI%x00%s%x00%b%x01` + `--name-only` dump into {@link GitCommitEvent}s.
 * `\x02` never appears in a commit message, so it safely delimits records; each record's
 * metadata run up to `\x01`, and everything after (up to the next `\x02`) is `--name-only`'s
 * newline-delimited file list for that commit. A record whose metadata can't be split into at
 * least sha+date+subject is skipped, never crashing on a truncated/malformed dump.
 */
export function parseGitEventDump(dump: string): GitCommitEvent[] {
  const events: GitCommitEvent[] = [];
  for (const chunk of dump.split("\x02")) {
    if (!chunk) continue;
    const sep = chunk.indexOf("\x01");
    if (sep === -1) continue;
    const parts = chunk.slice(0, sep).split("\x00");
    const [sha, ts, subject] = parts;
    const body = parts.slice(3).join("\x00");
    if (!sha || !ts) continue;
    const files = chunk
      .slice(sep + 1)
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    events.push({ sha, ts, subject: subject ?? "", body, files });
  }
  return events;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Citation forms a commit might use to name `taskId` — the same delimiter-bounded,
 *  case-insensitive idiom `classifyFailingMergeEvidence` (run-task.ts) uses for the identical
 *  problem, widened with the `#<n>` form: a task-less `rmd review` PR's synthetic id is
 *  `PR-<n>`, but its merge commit's subject carries GitHub's own `(#<n>)`, never the literal
 *  string `PR-<n>`. */
function taskCitationForms(taskId: string): string[] {
  const forms = [taskId];
  const m = /^PR-(\d+)$/i.exec(taskId);
  if (m) forms.push(`#${m[1]}`);
  return forms;
}

function citesTaskId(event: GitCommitEvent, taskId: string): boolean {
  const subject = ` ${event.subject.toLowerCase()} `;
  const body = ` ${event.body.toLowerCase()} `;
  return taskCitationForms(taskId).some((form) => {
    const re = new RegExp(`[(\\s,:]${escapeRegExp(form.toLowerCase())}[)\\s,:.]`);
    return re.test(subject) || re.test(body);
  });
}

/** Arming precedes the actual GitHub merge by seconds to minutes (the ledger `ts` and git's
 *  committer-date come from different clocks) — this absorbs that drift without reaching far
 *  enough to swallow a genuinely later, unrelated citing commit. */
const CLOCK_SKEW_SLACK_MS = 60 * 60 * 1000;

/**
 * The row's merge commit: the EARLIEST commit citing `taskId` at or after `armedTs` minus
 * {@link CLOCK_SKEW_SLACK_MS}. "Earliest after the arm" is what distinguishes the merge itself
 * from a LATER commit that also cites the same task id — a genuine follow-up fix, never
 * mistaken for the merge because it necessarily sorts after it.
 */
function locateMergeCommit(commits: readonly GitCommitEvent[], taskId: string, armedTs: string): GitCommitEvent | undefined {
  const floorMs = new Date(armedTs).getTime() - CLOCK_SKEW_SLACK_MS;
  return commits
    .filter((c) => citesTaskId(c, taskId))
    .filter((c) => new Date(c.ts).getTime() >= floorMs)
    .sort((a, b) => a.ts.localeCompare(b.ts))[0];
}

function shaNames(candidate: string, mergeSha: string): boolean {
  const a = candidate.toLowerCase();
  const b = mergeSha.toLowerCase();
  return a.length >= 7 && b.length >= 7 && (a === b || b.startsWith(a) || a.startsWith(b));
}

/** A revert inside `windowDays` of `merge` is a MISS; the same revert dated outside the window
 *  is not (the falsifier design (v) names by name). Two citation shapes, either sufficient:
 *  a `This reverts commit <sha>` body naming `merge`'s own sha, or a `Revert`-typed subject that
 *  also cites `taskId` (GitHub's default revert PR subject quotes the original title verbatim,
 *  which is where the task-id citation the original merge carried survives). */
function wasReverted(commits: readonly GitCommitEvent[], merge: GitCommitEvent, taskId: string, windowDays: number): boolean {
  const mergedMs = new Date(merge.ts).getTime();
  const windowEndMs = mergedMs + windowDays * 24 * 60 * 60 * 1000;
  return commits.some((c) => {
    const ts = new Date(c.ts).getTime();
    if (!(ts > mergedMs && ts <= windowEndMs)) return false;
    const bodyMatch = /This reverts commit\s+([0-9a-f]{7,40})/i.exec(c.body);
    if (bodyMatch && shaNames(bodyMatch[1], merge.sha)) return true;
    return /^revert\b/i.test(c.subject.trim()) && citesTaskId(c, taskId);
  });
}

const FIX_TYPE_RE = /^fix(\(|:)/i;

function filesOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(b);
  return a.some((f) => set.has(f));
}

/** {@link ATTRIBUTION_POLICY}'s overlap rule, applied to one merge — see the module doc's
 *  "over-attribution guard" paragraph for why citing NEITHER attributes to nothing. */
function hasFollowupFix(commits: readonly GitCommitEvent[], merge: GitCommitEvent, taskId: string, windowDays: number): boolean {
  const mergedMs = new Date(merge.ts).getTime();
  const windowEndMs = mergedMs + windowDays * 24 * 60 * 60 * 1000;
  return commits.some((c) => {
    if (!FIX_TYPE_RE.test(c.subject.trim())) return false;
    const ts = new Date(c.ts).getTime();
    if (!(ts > mergedMs && ts <= windowEndMs)) return false;
    return filesOverlap(c.files, merge.files) || citesTaskId(c, taskId);
  });
}

// ── The policy, as data ─────────────────────────────────────────────────────────────────────

export interface AttributionPolicy {
  /** How many days after a merge a revert/follow-up-fix still attributes to it. */
  readonly windowDays: number;
  /** Printed verbatim alongside the figures — the metric travels with its rule. */
  readonly overlapRuleDescription: string;
}

/** THE starting policy (design note (iii): "moving the boundary is a reviewed diff, not a
 *  hidden constant"). 14 days: long enough to catch a same-sprint regression report, short
 *  enough that an unrelated fix landing in the same files weeks later is not swept in. */
export const ATTRIBUTION_POLICY: AttributionPolicy = {
  windowDays: 14,
  overlapRuleDescription:
    "within windowDays after the merge, a fix-typed commit (subject matching /^fix(\\(|:)/i) attributes to " +
    "the verdict when EITHER its changed files intersect the merge's changed files OR its subject/body " +
    "cites the verdict's task id; citing NEITHER attributes to NOTHING (the over-attribution guard — a " +
    "busy repo fixes things near everything). Reverts use the same window: a `This reverts commit <sha>` " +
    "body naming the merge, or a Revert-typed subject citing the same task id.",
};

/** Below this many rows in a verdict class, the report prints the count and REFUSES the rate —
 *  a percentage over a handful of merges is an anecdote wearing a metric. */
export const MIN_POPULATION_FLOOR = 5;

// ── The report ───────────────────────────────────────────────────────────────────────────────

export interface ClassOutcome {
  verdictClass: VerdictClass;
  /** The denominator, NAMED — never a silently shrunken one (P48). */
  total: number;
  revertedCount: number;
  followupFixedCount: number;
  /** `null` when the rate is REFUSED — see {@link ClassOutcome.rateRefusedReason}. */
  revertRate: number | null;
  /** `null` under the same refusal. */
  followupFixRate: number | null;
  /** The lane(s) `total` was actually drawn from — an armed row's own `lane` field, deduped,
   *  sorted, comma-joined; `"none"` at `total: 0`. Absent-lane rows read as `"review"` (the only
   *  lane capable of producing a classified row before W1-T2258 fixed the other write paths —
   *  see the module doc's "review lane is the only one that posts a review.posted row" finding).
   *  NEVER blended into a fleet-wide claim without saying so: design note (v)'s reporting
   *  decision — a caveat is not enough when the exclusion (by lane) tracks the very axis (verdict
   *  class) this report measures, so this field is the label a consumer reads instead. */
  lanes: string;
  /** Set exactly when a rate is `null` — WHY it was refused, so "too few rows" (a population
   *  floor refusal) is never confused with "spans more than one arm lane" (a lane-purity refusal
   *  — the fleet-wide-vs-per-lane reporting decision itself). */
  rateRefusedReason?: "below-population-floor" | "mixed-lane-population";
}

export interface UnmeasurableRow {
  taskId: string;
  /** Absent exactly when the row's own {@link VerdictRow.headSha} was absent — see that field's
   *  own doc; never inferred here either. */
  headSha?: string;
  why: string;
  /** Which of the four {@link UnmeasurableCause} shapes this row is — see that type's own doc
   *  for why it is ONE enum shared across the mining and join stages. */
  cause: UnmeasurableCause;
}

export interface VerdictCalibrationReport {
  policy: AttributionPolicy;
  minPopulationFloor: number;
  /** One entry per {@link VerdictClass}, always all three, even at `total: 0` — an empty corpus
   *  prints counts and refuses rates rather than omitting a class outright. */
  classes: ClassOutcome[];
  /** Rows whose merge sha (or verdict class) could not be recovered — P48's no-naked-zero
   *  clause: every one of these is named, never folded into a denominator as if measured. */
  unmeasurable: UnmeasurableRow[];
  /** `verdictRows.length` — every arm row this report was actually handed, so a consumer can
   *  always see the denominator behind `classes`/`unmeasurable` (W1-T2258 acceptance: "the report
   *  states how many arms it saw"). Always equals `armsClassified + unmeasurable.length` — every
   *  row this report iterates lands in exactly one of the two. Rows `mineVerdictRows` itself
   *  never turned into a `VerdictRow` at all (no task id, or no arm timestamp — the one silent
   *  drop this task leaves silent, see that function's own doc) are outside this count. */
  armsSeen: number;
  /** `classes[].total` summed — the arms that reached a verdict class AND a locatable merge
   *  commit. */
  armsClassified: number;
  /** `unmeasurable.length` broken out by {@link UnmeasurableCause}, so "no head sha" is never
   *  merged into "merge sha could not be recovered" or "no matching review.posted line". */
  unmeasurableByCause: Record<UnmeasurableCause, number>;
}

const VERDICT_CLASSES: readonly VerdictClass[] = ["full-pass", "keyword-floor", "degraded-arm"];

/**
 * ENTRY EXPORT (the name is load-bearing — see the module doc). PURE over its two supplied
 * corpora: `verdictRows` (from {@link mineVerdictRows}) and `gitDump` (the raw text from
 * `defaultVerdictCalibrationGitLog`, run-task.ts) — no I/O of its own.
 *
 * `opts.gitReadError`, when set, degrades EVERY row to UNMEASURABLE naming that error rather
 * than attempting to search an empty/partial dump — the same "a live-file-only zero is not
 * proof of prevention" discipline lib/rule-efficacy.ts's `ruleEfficacyReport` applies to an
 * unreadable ledger union, applied here to an unreadable git history.
 *
 * FALSIFIER-shaped by construction (design (v)): a fixture pair where a full-PASS merge is
 * reverted inside the window classifies as a miss (`revertedCount` includes it); the same
 * revert dated OUTSIDE the window does not; a fix-typed commit with zero file overlap and no id
 * citation attributes to NOTHING; and an empty `verdictRows` prints every class at `total: 0`
 * with both rates `null`, never a false-healthy 0%.
 */
export function verdictCalibrationReport(
  verdictRows: readonly VerdictRow[],
  gitDump: string,
  opts: { policy?: AttributionPolicy; minPopulationFloor?: number; gitReadError?: string } = {},
): VerdictCalibrationReport {
  const policy = opts.policy ?? ATTRIBUTION_POLICY;
  const minPopulationFloor = opts.minPopulationFloor ?? MIN_POPULATION_FLOOR;
  const commits = opts.gitReadError ? [] : parseGitEventDump(gitDump);

  const totals = new Map<VerdictClass, { total: number; reverted: number; fixed: number; lanes: Set<string> }>(
    VERDICT_CLASSES.map((c) => [c, { total: 0, reverted: 0, fixed: 0, lanes: new Set<string>() }]),
  );
  const unmeasurable: UnmeasurableRow[] = [];
  const unmeasurableByCause: Record<UnmeasurableCause, number> = {
    "no-head-sha": 0,
    "no-review-posted": 0,
    "merge-sha-unrecoverable": 0,
    "git-history-unavailable": 0,
  };
  const pushUnmeasurable = (row: Pick<VerdictRow, "taskId" | "headSha">, why: string, cause: UnmeasurableCause): void => {
    unmeasurable.push({ taskId: row.taskId, headSha: row.headSha, why, cause });
    unmeasurableByCause[cause] += 1;
  };

  for (const row of verdictRows) {
    if (opts.gitReadError) {
      pushUnmeasurable(row, `git history unavailable: ${opts.gitReadError}`, "git-history-unavailable");
      continue;
    }
    if (row.verdictClass === null) {
      pushUnmeasurable(
        row,
        row.classifyWhy ?? "verdict class could not be determined from the ledger",
        // row.unjoinableCause is set by mineVerdictRows for both its own drop shapes; a
        // hand-built VerdictRow (fixtures, other callers) that sets verdictClass: null without it
        // falls back to the pre-existing "no matching review.posted line" reading.
        row.unjoinableCause ?? "no-review-posted",
      );
      continue;
    }
    const merge = locateMergeCommit(commits, row.taskId, row.armedTs);
    if (!merge) {
      pushUnmeasurable(
        row,
        `no commit on the read git history cites ${row.taskId} at or after its arm timestamp ` +
          `(${row.armedTs}) — the merge sha could not be recovered`,
        "merge-sha-unrecoverable",
      );
      continue;
    }
    const bucket = totals.get(row.verdictClass)!;
    bucket.total += 1;
    // W1-T2258 — every row is counted regardless of lane (never a second silent drop), but the
    // LANE it came from travels with the bucket so the rate below can refuse to blend lanes.
    bucket.lanes.add(row.lane ?? "review");
    if (wasReverted(commits, merge, row.taskId, policy.windowDays)) bucket.reverted += 1;
    if (hasFollowupFix(commits, merge, row.taskId, policy.windowDays)) bucket.fixed += 1;
  }

  const classes: ClassOutcome[] = VERDICT_CLASSES.map((verdictClass) => {
    const b = totals.get(verdictClass)!;
    const belowFloor = b.total < minPopulationFloor;
    const mixedLane = b.lanes.size > 1;
    const refuseRate = belowFloor || mixedLane;
    const rateRefusedReason: ClassOutcome["rateRefusedReason"] = !refuseRate
      ? undefined
      : belowFloor
        ? "below-population-floor"
        : "mixed-lane-population";
    return {
      verdictClass,
      total: b.total,
      revertedCount: b.reverted,
      followupFixedCount: b.fixed,
      revertRate: refuseRate ? null : b.reverted / b.total,
      followupFixRate: refuseRate ? null : b.fixed / b.total,
      lanes: b.lanes.size === 0 ? "none" : Array.from(b.lanes).sort().join(", "),
      ...(rateRefusedReason ? { rateRefusedReason } : {}),
    };
  });

  const armsClassified = classes.reduce((sum, c) => sum + c.total, 0);

  return { policy, minPopulationFloor, classes, unmeasurable, armsSeen: verdictRows.length, armsClassified, unmeasurableByCause };
}
