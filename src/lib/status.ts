import { execFileSync } from "node:child_process";
// W1-T2440: the board pre-warm's walk runs on a separate OS thread (`runPrewarmWorker`), so the `execFileSync`
// below can stay genuinely synchronous without parking the process that serves `/v1/status`. That worker loads
// THIS module a second time; `isMainThread`/`workerData` gate the worker-only branch near `buildBatchedGithub`,
// which never runs on a normal load.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
// Imported as the module's DEFAULT export, never as named bindings: those are non-configurable, so a spy cannot
// intercept one. Every call is a property access AT CALL TIME, never destructured. Why: load-bearing for
// W1-T115's "assert via injected fs" proof shape — docs/forensics/status.md
import fs from "node:fs";
import { readdirSync as nodeReaddirSync, readFileSync as nodeReadFileSync } from "node:fs";
import { gunzipSync as nodeGunzipSync } from "node:zlib";
import { dirname } from "node:path";
import { ledgerRotationEntries } from "./ledger-grep.js";
import type { Plan, Task, TaskStatus } from "./plan.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { NEEDS_HUMAN_LABEL } from "./escalate.js";
import { isHolderStale } from "./fs-race-safe.js";
import { isTestRunner } from "./live-write-guard.js";
import type { WorkerState } from "./worker.js";
import {
  type BoardIssueRest,
  boardPrsRestArgs,
  type BoardFetchHalf,
  type BoardPrRest,
  combinedStatusRestArgs,
  createGhCallPacer,
  fetchBoardPrsRest,
  fetchLabelledIssuesRest,
  type GhCallPacer,
  mapRestPr,
  paceGhEntry,
  prStateFromRest,
  type RestPullRow,
  singlePrRestArgs,
} from "./open-prs-rest.js";
import { isInPlanScope } from "./plan-architect.js";

/**
 * Derived task status (MASTER-PLAN v2.1). Merge-state is DERIVED FROM GITHUB, never written back to
 * plan/tasks.yaml, whose `status:` is decorative; the truth is cached to state/status.json.
 *
 * Precedence, highest first: a `correction.provenance` line (DECLARED, SUPREME); (a) `pr.opened`;
 * (b) an explicit `pr:` field; (b2) `manual.completed`, for a completion in another repo or with no
 * PR; (c) a merged PR with the anchored `Remudero-Task:` trailer. First rung to resolve a MERGED PR
 * wins. THE INVARIANT: an open-PR ledger claim is the WEAKEST evidence here, so every rung is
 * checked for a merged credit before one may stand (W1-T116). NOTHING here writes tasks.yaml.
 * Why: the W1-T1 149x storm and the W1-T20c false-credit class set this order — docs/forensics/status.md
 */

/** The precedence sources, plus `none` for no evidence and `throttled` for a read that FAILED — never conflated
 *  (W1-T119). `"manual-completion"` is DECLARED, like `"correction"` (W1-T1029). Why: a false `source: "none"`
 *  mis-filed W1-T116 as not-merged */
export type StatusSource =
  | "ledger"
  | "pr-field"
  | "manual-completion"
  | "trailer"
  | "head-branch"
  | "correction"
  | "none"
  | "throttled";

/** The CLASSIFIED reason a `gh` read failed (W1-T119): rate limit, auth, transport, buffer overflow (W1-T181,
 *  from the error `code`, since there is no stderr) or unknown. Unknown still counts as UNAVAILABLE, never
 *  absent — absence is the conclusion that costs money. */
export type GhFailureReason = "rate_limit" | "auth" | "transport" | "buffer_overflow" | "unknown";

/** The states {@link GitHub.readFailed}/{@link GitHub.readFailureReason} cannot express (W1-T2219):
 *  `"not_attempted"`, `"in_flight"` (observable only from a REENTRANT call), `"ok"` and `"failed"` for the most
 *  recently COMPLETED fetch. A boolean plus a reason cannot tell the first two from a confirmed-clean read. */
export type GhReadState = "not_attempted" | "in_flight" | "ok" | "failed";

/**
 * Classify a failed `gh` invocation's status, stderr and Node error `code` into a {@link GhFailureReason}. Pure
 * and exported so both gateways and the tests share ONE rule. THE TRAP: a `maxBuffer` overflow has no stderr —
 * Node kills the child first — so it is detected from `code === "ENOBUFS"`, checked FIRST. Why: as "unknown" it
 * hid the 2026-07-20 outage for hours
 */
export function classifyGhFailure(
  status: number | null | undefined,
  stderr: string | null | undefined,
  code?: string | null,
): GhFailureReason {
  if (code === "ENOBUFS") return "buffer_overflow";
  // A KILLED-ON-TIMEOUT CHILD CARRIES NO STDERR either, so it is detected from the `code` exactly as ENOBUFS
  // is: MEASURED, `execFileSync` past its `timeout` throws ETIMEDOUT with empty stderr. Classified "transport"
  // — a call that never returned is a network-class failure. Why: without this branch every timeout kill would
  // ledger as "unknown"
  if (code === "ETIMEDOUT") return "transport";
  const text = String(stderr ?? "");
  if (/rate limit|quota|secondary rate limit/i.test(text)) return "rate_limit";
  if (/bad credentials|authentication|not logged in|gh auth login|401 unauthorized|unauthorized/i.test(text)) return "auth";
  if (/getaddrinfo|econnrefused|econnreset|etimedout|enotfound|could not resolve host|network is unreachable|dial tcp|timeout/i.test(text)) {
    return "transport";
  }
  return "unknown";
}

/** True iff `err` classifies as `rate_limit` (W1-T468) — the one place that decision is made, so every guarded
 *  call site slows down on the same rule. */
export function isGhRateLimitError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
  return classifyGhFailure(e?.status, e?.stderr != null ? String(e.stderr) : undefined, e?.code) === "rate_limit";
}

/**
 * Wall-clock ceiling on ONE `gh` invocation, for every gateway here. WHAT HAS NO BOUND BLOCKS THE WHOLE DAEMON:
 * these calls are synchronous, so one that never returns parks the only thread, and a hang is not an error, so
 * nothing is logged. Sized so it cannot fire on a healthy call (~67x the slowest measured) and inside the poll
 * interval. FAIL-SOFT: the kill throws, and callers already classify and degrade on it. Why: an unbounded sweep
 * ran 10:57-11:54 — docs/forensics/status.md
 */
export const GH_CALL_TIMEOUT_MS = 60_000;

/** A PR's identity + GitHub merge state, as seen by the {@link GitHub} gateway. */
export interface PrRef {
  number: number;
  url: string;
  /** GitHub PR state: "MERGED" | "OPEN" | "CLOSED". */
  state: string;
  /** The PR's title (W1-T184) — a pure DECORATION, never a precedence input. Optional, so no
   *  pre-existing literal breaks; omitted ⇒ a caller falls back to the bare number and url. */
  title?: string;
  /** The PR's head branch ref (W1-T256), riding the one list fetch so rung (c2) re-asserts ownership
   *  without a second call. Omitted ⇒ the branch is treated as unowned. */
  headRefName?: string;
  /**
   * The exact current head commit from the same board fetch (W1-T2727). Optional for legacy and
   * injected rows; omitted means unknown and must never be treated as an exact-head match.
   */
  headRefOid?: string;
  /** The PR's raw body text (W1-T2392), riding the SAME batched fetch at zero extra cost. Omitted ⇒
   *  {@link indexProseNamedTaskIds} sees the title alone. */
  body?: string;
}

/** The four IN-FLIGHT run phases the ledger's own `step` names distinguish (MASTER-PLAN §7/§9, W1-T155) — never
 *  invented vocabulary; each maps 1:1 onto a real run-task.ts step. */
export type Phase = "recon" | "implement" | "review" | "fix-rung";

/** One task's projected merge-state, derived from GitHub (never from yaml). */
export interface StatusProjection {
  taskId: string;
  /** W1-T2392 — A MERGED BUILD NOBODY CREDITED, REPORTED AND NOTHING ELSE. Present only when the
   *  projection is NOT merged and a merged PR touching `src/` names this task in prose. Changes NO
   *  decision: a WARN, never a block — see {@link uncreditedBuildWarning}. */
  uncreditedBuild?: UncreditedBuildWarning;
  /** W1-T2397 — AN OPEN, UNMERGED BUILD OF THIS TASK ON ANOTHER BRANCH. A REPORT ONLY: no
   *  eligibility path reads it and `prState` is untouched. See {@link openSiblingBuild}. */
  openSiblingBuild?: OpenSiblingBuild;
  /** Derived status label, DELIBERATELY within {@link TaskStatus}'s closed set, which daemon.ts's
   *  `reconstructOrphan` and openapi/daemon.yaml both depend on. The finer taxonomy rides the
   *  additive fields below, so every existing consumer keeps working (W1-T155). */
  status: TaskStatus;
  /** The single fact dependency-gating cares about: has this task landed? */
  merged: boolean;
  /** Which precedence source resolved it (or `none`). */
  source: StatusSource;
  prNumber?: number;
  prUrl?: string;
  prState?: string;
  /** LEGIBILITY (P16 / W1-T69): trailer hits REJECTED by rung (c), each with a reason, so a false
   *  trailer is VISIBLE rather than silently dropped. Present only when one was rejected. */
  rejected_candidates?: Array<{ pr: string; reason: string }>;
  /** CURRENT phase of an in-flight run (W1-T155). Present ONLY while a run is genuinely in flight
   *  and `status` is not terminal. A fresh `run.start` resets the scan to `recon`, so an earlier
   *  run's phase never leaks in — the falsifier the acceptance criteria name. */
  phase?: Phase;
  /** ISO-8601 timestamp of the in-flight run's `run.start` ledger line. Present iff `phase` is. */
  startedAt?: string;
  /** Milliseconds elapsed since `startedAt`, as of THIS derivation (`deps.now()`, default `Date.now`) —
   *  re-derived fresh on every call, never cached. Present iff `startedAt` is. */
  elapsedMs?: number;
  /** W1-T944: the in-flight run's CURRENT `worker.state`, off the SAME scan `phase` came from.
   *  Present ONLY alongside `phase`, so a finished run's state cannot linger, AND only once the run
   *  has emitted such a row — absent, the console renders "state unknown", not a healthy default. */
  workerState?: WorkerState;
  /** ISO-8601 `ts` of the row that moved the run INTO its current `workerState`. Present ONLY while
   *  that state is quiet; the console ages a duration off it rather than freezing at last render. */
  workerStateSince?: string;
  /** PROCESS-UNEVIDENCED (W1-T1240): the running decoration is backed ONLY by an open PR, with
   *  neither a ledger heartbeat nor a live lock, so nothing observed a LIVE LOCAL PROCESS. Marks
   *  "NOT EVIDENCED", never "dead" — an absent probe degrades evidence, it does not assert a corpse.
   *  Why: W1-T314 rendered `running, 10h25m, $27.75` ten hours after its run was refused */
  processUnevidenced?: true;
  /** True when the task has an OPEN escalation that no LATER `run.start` has superseded. Omitted,
   *  not `false`, once superseded or merged — the sparse convention every flag here follows. */
  needsHuman?: true;
  /** The escalation issue's own URL (W1-T182), carried so NEEDS ME renders a direct link rather than
   *  soliciting a URL the ledger already holds. Present iff `needsHuman` is. */
  escalationIssueUrl?: string;
  /** The escalation's one-line ask (W1-T182) — the live issue's title, off the same batched gateway.
   *  Present iff `needsHuman` is and the title could be read. */
  escalationTitle?: string;
  /** True when the escalation's live issue state could NOT be confirmed OPEN. FAIL-CLOSED
   *  (W1-T182): an unreadable state KEEPS the row, the opposite direction from W1-T181's
   *  merged-count boundary. */
  escalationUnverified?: true;
  /** ISO-8601 `ts` of the escalation's own `escalation.issue_opened` line (W1-T159). A caller
   *  measuring "how long has this needed a human" MUST use this, never `startedAt`: they name
   *  different events, and an escalation can fire hours after its run began. */
  escalationOpenedAt?: string;
  /** True when the current OPEN PR already has auto-merge armed, observed via the SAME batched fetch
   *  — W1-T155 preserves the O(1) invariant, zero extra calls. */
  armedAwaitingMerge?: true;
  /** INDETERMINATE (W1-T119): `source: "throttled"`, because the read genuinely FAILED rather than
   *  resolving to "no evidence". A caller that gates dispatch MUST treat this as DO NOT ACT — the
   *  evidence a "not merged" conclusion would rest on was never consulted. */
  indeterminate?: true;
  /** The CLASSIFIED reason behind an `indeterminate` projection (W1-T119), so an operator can tell
   *  throttle from auth-expiry from a network outage. Present ONLY alongside `indeterminate`. */
  unavailableReason?: GhFailureReason;
  /** MONOTONIC UNDER DARKNESS (W1-T179): present ONLY when the precedence fields were carried
   *  forward from a PRIOR successful observation because this cycle's read failed. The stamp is the
   *  START of the current unbroken run of failures — a later failure never resets it, only a
   *  successful read clears it. Why: the 12:24->12:58 fail-open regressed credited tasks to `queued` */
  githubUnobservableSince?: string;
  /** LIVENESS BOUND (W1-T179): DISPATCHED with no terminal verdict, and neither an open PR nor
   *  activity within the bound backs it up — a crashed worker's stale trace. `status` stays within
   *  {@link TaskStatus}'s closed set; this sparse flag carries the signal.
   *  Why: the W1-T1 27h21m spin-loop fixture */
  orphaned?: true;
  /** W1-T485: NOT merged, yet one of this task's own proof symbols shipped to a declared path of its
   *  under a DIFFERENT task's trailer — the route no credit source covers. AN OBSERVATION, NEVER A
   *  VERDICT: `merged`/`status`/`source` are untouched beside it. */
  supersededBy?: SupersessionEvidence;
  /**
   * W1-T507: filed `verify: human` and not merged. The plan already excludes such a task from every
   * machine-dispatch path, so nothing else in `src/` turns that exclusion into a signal a person can
   * see. Set by {@link deriveStatus} itself, being a pure function of this call's own resolved
   * state, which keeps every caller DERIVATION-EQUIVALENT. DELIBERATELY NOT `needsHuman`, which
   * backs an affordance such a task never has, since it is never dispatched and so never escalates.
   * Why: setting `needsHuman` here would render that affordance with nothing to click
   */
  verifyHumanPending?: true;
  /** W1-T951 DELIVERABLE B: this MERGED task's durable credit rests on EXACTLY ONE of the two paths,
   *  and the branch ref is one GitHub deletes on merge. Present ONLY when `merged` is true and the
   *  credit is single-path. Why: 18 ids were credited by head-branch alone */
  singlePathCredit?: true;
}

/**
 * The GitHub queries deriveStatus needs, behind an interface so unit tests can
 * inject fixtures for all three precedence sources without touching the network.
 */
export interface GitHub {
  /** Resolve a PR by number or url within the gateway's repo. null if absent. */
  prByRef(ref: string | number): PrRef | null;
  /** Find a MERGED PR whose body contains `Remudero-Task: <taskId>`. null if none. */
  findMergedByTrailer(taskId: string): PrRef | null;
  /**
   * EVERY merged PR carrying `taskId`'s anchored trailer, newest-first (W1-T441) — the candidate set {@link
   * findMergedByTrailer} discards by returning only the first, because the already-satisfied CLOSE path
   * manufactures duplicates that displace the implementation. null on a FAILED read, [] on a genuine miss. Why:
   * 16 of 496 trailered ids have more than one PR — docs/forensics/status.md
   */
  findMergedByTrailerAll?(taskId: string): PrRef[] | null;
  /**
   * CORROBORATION for an empty {@link findMergedByTrailer} (W1-T256): merged PRs whose HEAD BRANCH is this
   * task's run prefix — deterministic, NOT the body index, where an exit-0 EMPTY result is INDETERMINATE rather
   * than "not merged". Callers RE-ASSERT ownership. null on FAILURE, distinct from []. Why: one body-index miss
   * caused four spurious re-dispatches
   */
  findMergedByHeadBranch?(taskId: string): PrRef[] | null;
  /** BATCHED form of {@link findMergedByHeadBranch} (W1-T257): ONE list read carrying every merged PR's head
   *  ref, matched CLIENT-SIDE for the whole plan. On the STRUCTURED ref, NEVER the body index — reintroducing
   *  that would restore the failure this prevents. null on FAILURE. */
  listMergedHeadBranches?(): PrRef[] | null;
  /** The OPEN twin of {@link listMergedHeadBranches} (W1-T377), so a task with an open PR the ledger never
   *  recorded can still be credited: rung (a) is the ONLY route to an OPEN association and it reads the ledger,
   *  while the merged rungs answer a different question. Zero extra calls on the batched path. null on FAILURE,
   *  never []. Why: a run rebuilt its own work, leaving a conflicting duplicate — docs/forensics/status.md */
  listOpenHeadBranches?(): PrRef[] | null;
  /** The PR's head branch name, or undefined when unresolvable. Backs rung (c)'s ownership-assert
   *  (MASTER-PLAN P16 / W1-T69). */
  headRefName(prUrl: string): string | undefined;
  /** The PR's raw body text, or undefined when unresolvable. Backs rung (c)'s anchored-trailer
   *  verify (P16 / W1-T69): the body search is fuzzy, so a candidate is re-checked locally. */
  prBody(prUrl: string): string | undefined;
  /**
   * W1-T2387 — DOES THE COMMIT SURFACE CARRY THIS TASK'S ANCHORED TRAILER FOR THIS PR? The SECOND anchored
   * surface, read off the SAME memoised index. NOT A RELAXATION of {@link creditsByAnchoredTrailer}: the index
   * extracts an exact anchored line and refuses every token the run-id grammar rejects, and every other W1-T20c
   * property applies unchanged. FAILS CLOSED — an unbuildable index reads FALSE, never "credited".
   */
  creditedByCommitTrailer?(taskId: string, prUrl: string): boolean;
  /**
   * The PR's changed-file paths, or `undefined` when unresolvable. Backs rung (c)'s PLAN-ONLY refusal
   * (W1-T413). `undefined` MEANS UNAVAILABLE AND KEEPS TODAY'S ANSWER, never "no files": an absent head cannot
   * be evidence FOR a credit, whereas WITHDRAWING one would re-dispatch finished work. So the head fails closed
   * and the file list fails open.
   */
  changedFiles?(prUrl: string): string[] | undefined;
  /** Is auto-merge already armed on this PR? OPTIONAL (W1-T155); omitted ⇒ fail-soft "not armed". */
  autoMergeArmed?(prUrl: string): boolean;
  /** OPTIONAL (W1-T154): force this gateway's fetch NOW rather than lazily on the first query, so the
   *  serve boot sequence can warm it before the first request and never pay a cold fetch on the
   *  request path. Omitted ⇒ a no-op. */
  warm?(): void;
  /** True if a read this gateway attempted actually FAILED, as opposed to succeeding with a genuinely empty
   *  result, so a failed read defers rather than reading as a confirmed not-merged (W1-T119). NEVER FORCES A
   *  FETCH (W1-T2219): the STICKY verdict of the most recently COMPLETED attempt. Why: this accessor used to
   *  force its own cold fetch, so asking PERFORMED the read */
  readFailed?(): boolean;
  /** The CLASSIFIED reason the most recent failed read failed (W1-T119) — the pre-fix stdio triple discarded
   *  stderr, so every cause looked alike. Consulted only after `readFailed()`; absent ⇒ `"unknown"`. NEVER
   *  FORCES A FETCH. Scoped to the PR channel; the issue channel has its own twin. */
  readFailureReason?(): GhFailureReason | undefined;
  /** W1-T2219: the state the failure pair cannot express — see {@link GhReadState}. NEVER forces a
   *  fetch. Omitted ⇒ a caller cannot tell "not attempted" from "confirmed not failed". Beside the
   *  pair, never in place of it. */
  readState?(): GhReadState;
  /** True if the most recent read SUCCEEDED but only PARTIALLY, hitting {@link BOARD_MAX_PAGES} (W1-T415). A
   *  THIRD accessor, because a FAILED fetch and a PARTIAL one are different facts and collapsing them recreates
   *  the conflation W1-T119 prevents. Truncation can only OMIT rows, so a credit stays sound and only "no
   *  evidence" is unsound — hence the deferral sits in the same arm as `readFailed()`, never upstream of a
   *  credit. */
  readTruncated?(): boolean;
  /** R-24 (docs/audits/recon-2026-09-05.md): DROP THE FAILURE VERDICTS LEFT BY EARLIER ATTEMPTS, AND NOTHING
   *  ELSE — the seam that lets a gateway live a whole daemon or drain lifetime, since its delta cache and its
   *  verdicts want opposite lifetimes. THE TRAP: a FAILED fetch replaces its half with an EMPTY one and stamps
   *  it (the W1-T181 pairing), and those rows are only safe read alongside `readFailed()`, so a half is dropped
   *  exactly when its verdict is. The delta caches are NOT touched. Why: the measured cold-walk cost is in
   *  docs/forensics/status.md */
  resetFailureFlags?(): void;
  /** Resolve an escalation issue's LIVE state and title by url (W1-T182) — the join that replaces trusting the
   *  ledger line as a permanent proxy for "still open". THE FAIL-SOFT DIRECTION INVERTS every other optional
   *  method here: omitted, or `null`, means "cannot confirm this is closed", so the escalation stays
   *  `needsHuman`, marked unverified. */
  issueByUrl?(url: string): { state: string; title?: string } | null;
  /** True iff the most recent {@link issueByUrl} read genuinely FAILED rather than resolving to a
   *  clean not-found — scoped to the independent issue fetch, so the two flags never conflate a PR
   *  outage with an issue-read outage. */
  issueReadFailed?(): boolean;
  /** W1-T2219: the CLASSIFIED reason the most recent failed issue fetch failed. It was already
   *  classified and logged but had no accessor, so a caller could learn THAT the channel failed and
   *  never WHY. Absent ⇒ `"unknown"`. */
  issueReadFailureReason?(): GhFailureReason | undefined;
  /**
   * W1-T914: the `remudero-review` commit-status state for `prUrl`'s CURRENT head, three-valued plus `"none"` —
   * the SAME vocabulary lib/review.ts posts, off the combined-status endpoint open-prs-rest.ts documents, never
   * a second call.
   *
   * FOUR ANSWERS THAT MUST NOT COLLAPSE: `"none"` means the read succeeded and found no entry;
   * `"not-applicable"` (W1-T2235) is a MERGED or CLOSED row, answered with no call at all; and `undefined`
   * means the read could not be trusted, NEVER collapsed into `"none"` — a caller that cannot tell them apart
   * would render an outage as a fact about the PR.
   */
  reviewState?(prUrl: string): "success" | "failure" | "pending" | "none" | "not-applicable" | undefined;
}

/** Reader for the append-only ledger; injectable for tests. */
export type LedgerReader = (path: string) => Array<Record<string, unknown>>;

export interface DeriveDeps {
  /** Absolute path to state/ledger.ndjson (source (a)). */
  ledgerPath: string;
  /** GitHub gateway scoped to the task's repo. */
  github: GitHub;
  /** Ledger reader; defaults to reading + parsing NDJSON from disk. */
  readLedger?: LedgerReader;
  /** R-23: the per-projection {@link LedgerIndex}, built ONCE by {@link projectPlan} and shared by
   *  every task — the same batch-once shape as the ledger read (W1-T187). Omitted, or built over a
   *  DIFFERENT array (the identity check catches it), each helper scans as before, so this can only
   *  change how long a derivation takes, never what it derives. */
  ledgerIndex?: LedgerIndex;
  /** TEST-ONLY EQUIVALENCE SEAM (R-23), set by one test and nothing in `src/`: it makes
   *  {@link projectPlan} skip its index, which is how that test proves the indexed and unindexed
   *  projections are deep-equal through the PRODUCTION function rather than a copy. */
  unindexedForEquivalenceTest?: true;
  /**
   * Clock for {@link StatusProjection.elapsedMs} (W1-T155); defaults to `Date.now`.
   * Injectable so a test can assert an exact elapsed value without a real sleep.
   */
  now?: () => number;
  /** MONOTONIC UNDER DARKNESS (W1-T179): the LAST successfully-observed projection, consulted ONLY
   *  when this cycle's read failed and no rung resolved anything fresh, so a fetch failure never
   *  regresses a credited task to `queued`. Omitted ⇒ pre-W1-T179 behaviour. */
  previousProjection?: (taskId: string) => StatusProjection | undefined;
  /** BATCHED rung (c2) corroboration (W1-T257): a per-task lookup into the index
   *  {@link projectPlan} fetches ONCE and shares. [] when the batch succeeded with no such branch,
   *  `null` when the BATCH FAILED — then the per-task method runs, and if that fails too, W1-T119
   *  defers rather than reporting a false none. Why: five 07-23 GraphQL exhaustions */
  mergedHeadBranches?: (taskId: string) => PrRef[] | null;
  /** The OPEN twin of {@link DeriveDeps.mergedHeadBranches} (W1-T377), backing the (c3) rung — the
   *  only thing here that can see an open PR the ledger never recorded. SAME "ABSENT ⇒ SKIP"
   *  contract: `undefined` falls back per-task, `null` skips the rung so W1-T119 defers rather than
   *  this rung inventing an absence. */
  openHeadBranches?: (taskId: string) => PrRef[] | null;
  /** LIVENESS BOUND (W1-T179): milliseconds of ledger silence a dispatched, unresolved run tolerates
   *  before it is no longer "running" absent an open PR. Injectable so a test can assert the boundary
   *  without a real wait. */
  livenessBoundMs?: number;
  /** W1-T2392: id -> the merged PRs naming it in prose, built ONCE by {@link projectPlan} from the
   *  merged list it already fetches. Supplied rather than derived here, because a second batched
   *  fetch would break W1-T257's own guard, which counts them. Absent ⇒ no warning is ever set. */
  proseNamedTaskIds?: Map<string, UncreditedBuildWarning[]>;
  /** THE INFLIGHT-LOCK ANCHOR — the third disjunct beside `hasOpenPr`/`recentActivity`. ABSENT ⇒ SKIP. WHY A
   *  LOCK AND NOT ANOTHER LEDGER STEP: the liveness bound infers liveness from ledger CHATTER, which a live run
   *  can stop producing, and terminals cannot cover the gap either, because a dying process writes none. NOT
   *  TRUSTED ALONE: a lock outlives its process, since the release is in a `finally` and there are NO signal
   *  handlers in src/, hence the pairing with {@link DeriveDeps.isPidAlive}. Why: 96 of 664 runs have a gap
   *  longer than the bound */
  inflightHolder?: (taskId: string) => { pid: number; host?: string; startedAt?: string } | null;
  /** Liveness probe for the holder's pid, defaulting to {@link defaultIsPidAlive}. W1-T368: not the WHOLE story
   *  — the pid space wraps often on the fleet host, so a recycled pid made a dead holder read as live forever.
   *  It is now run through {@link isHolderStale}, and remains a REASON TO BELIEVE a run is live, never proof,
   *  which is why it is a third disjunct and not a replacement. */
  isPidAlive?: (pid: number) => boolean;
  /** Process-start-time probe for the holder's `startedAt` comparison, forwarded to
   *  {@link isHolderStale}. Injectable so a test can assert the pid-reuse arm without a real wrap. */
  getProcessStartTime?: (pid: number) => number | null;
  /** W1-T485 — OPT-IN, absent by default ON PURPOSE: supplied, {@link projectPlan} asks it for every
   *  UNMERGED task; omitted, no search runs and the 250ms-polled console pays nothing. See
   *  {@link buildGitLogSupersessionSearch} for why this is not wired into a hot path. */
  supersessionSearch?: SupersessionSearch;
  /** W1-T951: where the durable {@link CreditStore} lives, defaulting to
   *  {@link defaultCreditStorePath}. Injectable so a test, or a caller sharing one store across many
   *  ledger directories, can point elsewhere. */
  creditStorePath?: string;
  /** Reader for the durable credit store; defaults to {@link loadCreditStore}. Injectable so a test
   *  can hand a canned store directly and prove the resolution never touches `deps.github`. */
  readCreditStore?: () => CreditStore;
  /** Writer for the durable credit store; defaults to {@link saveCreditStore}. Called whenever a live
   *  rung finds a credit the store lacks, so a LATER derivation never reads GitHub again.
   *  {@link projectPlan} overrides it to batch every task's writes into ONE save. */
  writeCreditStore?: (store: CreditStore) => void;
}

/** Default LIVENESS BOUND (W1-T179, 30 minutes): a dispatched task with no terminal verdict and no newer ledger
 *  line is no longer trusted as "running" absent an open PR. The W1-T1 spin-loop (27h21m) blows past it by two
 *  orders of magnitude, while a slow poll cadence sits inside it. */
export const DEFAULT_LIVENESS_BOUND_MS = 30 * 60_000;

/** The minimal fs surface {@link readLedgerLines} needs — deliberately ONLY `existsSync` and `readFileSync`,
 *  with no write or copy capability, so an injected fake CANNOT be made to create a temp copy. That proves
 *  STRUCTURALLY that a ledger read never copies the file first (W1-T115). */
export interface LedgerFsDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf8") => string;
}

// Property access at call time (see the import comment above), not `{ existsSync,
// readFileSync }` captured once — that would silently reintroduce the
// non-interceptable-named-binding problem one indirection later.
const realLedgerFs: LedgerFsDeps = {
  existsSync: (path) => fs.existsSync(path),
  readFileSync: (path, encoding) => fs.readFileSync(path, encoding),
};

// ── W1-T951: DURABLE MERGE CREDIT ───────────────────────────────────────────────────────────
// DESIGN DECISION (i), RECORDED per the shard's requirement: the durable record belongs at THIS layer,
// inside `derivePrPrecedence`. Every site that reads `projection.merged` goes through
// `deriveStatus`/`projectPlan`, neither credit rung persists anything today, and both already live
// here — so a store here fixes every caller for free, with no wiring changes, and `run-task.ts` stays
// undeclared as W1-T471 requires.
// Why: a new module or a ledger step was considered and rejected — docs/forensics/status.md

/** One path's persisted merge credit for a task — see {@link CreditStore}. */
export interface CreditStoreEntry {
  source: "trailer" | "head-branch";
  prUrl: string;
  prNumber: number;
  prState: string;
}

/** DELIVERABLE A — the durable, GitHub-independent record of merge credit, keyed by task id then by the path
 *  that credited it, so a caller can tell in O(1) whether credit rests on ONE path or BOTH. Persisted as JSON
 *  unless a caller injects its own IO. */
export type CreditStore = Record<string, Partial<Record<CreditStoreEntry["source"], CreditStoreEntry>>>;

/** The minimal fs surface the durable credit store needs — same "inject or default to a
 *  property-accessed `fs` call" shape {@link LedgerFsDeps}/`realLedgerFs` already establish just
 *  above, so an external `mock.method` spy on the real `fs` module observes every real call. */
export interface CreditStoreFsDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf8") => string;
  mkdirSync: (path: string) => void;
  writeFileSync: (path: string, data: string) => void;
  renameSync: (from: string, to: string) => void;
}

const realCreditStoreFs: CreditStoreFsDeps = {
  existsSync: (path) => fs.existsSync(path),
  readFileSync: (path, encoding) => fs.readFileSync(path, encoding),
  mkdirSync: (path) => fs.mkdirSync(path, { recursive: true }),
  writeFileSync: (path, data) => fs.writeFileSync(path, data),
  renameSync: (from, to) => fs.renameSync(from, to),
};

/** Default store location: a sibling of the ledger this call is already scoped to, so no new
 *  required `DeriveDeps` field is needed for the common case — only a test, or a caller wanting
 *  a shared store across many ledger directories, injects {@link DeriveDeps.creditStorePath}. */
export function defaultCreditStorePath(ledgerPath: string): string {
  return `${dirname(ledgerPath)}/merge-credit.json`;
}

/** Reads the durable store — `{}` on a missing OR corrupt file, never a throw. The store is an ACCELERATOR, not
 *  the sole route to a credit, so a read failure degrades to "nothing durable yet" rather than propagating into
 *  a caller with no reason to expect this layer to throw. */
export function loadCreditStore(path: string, fsDeps: CreditStoreFsDeps = realCreditStoreFs): CreditStore {
  if (!fsDeps.existsSync(path)) return {};
  try {
    const parsed = JSON.parse(fsDeps.readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CreditStore) : {};
  } catch {
    return {};
  }
}

/**
 * Writes the durable store ATOMICALLY — temp file plus rename, the SAME pattern the status.json write uses, so
 * a reader mid-write never sees a torn store. BEST-EFFORT: a write failure is swallowed, because the projection
 * that found this credit is already correct, and the next write catches up.
 */
export function saveCreditStore(path: string, store: CreditStore, fsDeps: CreditStoreFsDeps = realCreditStoreFs): void {
  try {
    fsDeps.mkdirSync(dirname(path));
    const tmpPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fsDeps.writeFileSync(tmpPath, JSON.stringify(store, null, 2) + "\n");
    fsDeps.renameSync(tmpPath, path);
  } catch {
    // best-effort — see doc comment above.
  }
}

/** Merges one newly-discovered credit into the store, immutably. Idempotent: a source already recorded is left
 *  untouched. The durable rung returns before this would run again for that pair, but the guard keeps the
 *  function correct standing alone. */
export function recordCredit(store: CreditStore, taskId: string, entry: CreditStoreEntry): CreditStore {
  const existing = store[taskId] ?? {};
  if (existing[entry.source]) return store;
  return { ...store, [taskId]: { ...existing, [entry.source]: entry } };
}

/** DELIVERABLE A's enumeration (design (ii)): every id with a head-branch entry and NO trailer entry — the
 *  population measured as fragile, credited by a ref GitHub deletes on merge. Sorted for a deterministic report
 *  and test diff. */
export function branchOnlyCreditedIds(store: CreditStore): string[] {
  return Object.keys(store)
    .filter((id) => {
      const paths = store[id];
      return !!paths["head-branch"] && !paths.trailer;
    })
    .sort();
}

/** DELIVERABLE B: every id credited by EXACTLY ONE of the two paths, either direction. The defect is not that
 *  single-path credit exists; it is that it is indistinguishable from double-path credit until the single path
 *  disappears. This makes the distinction queryable in advance. */
export function singlePathCreditedIds(store: CreditStore): string[] {
  return Object.keys(store)
    .filter((id) => Object.keys(store[id]).length === 1)
    .sort();
}

/** Per-task twin of {@link singlePathCreditedIds}, for {@link derivePrPrecedence} to attach
 *  {@link StatusProjection.singlePathCredit} without scanning the whole store. */
export function isSinglePathCredited(store: CreditStore, taskId: string): boolean {
  const paths = store[taskId];
  return !!paths && Object.keys(paths).length === 1;
}

/**
 * {@link readLedgerLines}' return type: a plain array for every existing consumer, so it stays structurally
 * assignable with zero call-site churn, PLUS a `torn` count as a NON-ENUMERABLE own property (W1-T206) —
 * non-enumerable so `assert.deepEqual` against a plain array literal keeps working, exactly like a real array's
 * own `.length`. A consumer reads it by direct access.
 */
export type LedgerLines = Array<Record<string, unknown>> & {
  /** Count of unparseable/torn lines dropped THIS read (0 when every line parsed clean). */
  readonly torn: number;
  /**
   * Whether the ledger FILE existed for this read. `false` is the ONLY thing distinguishing "there is no ledger
   * at this path" from "the ledger is there and has nothing to say" — both return an empty array. THE SAME
   * DEFECT `torn` WAS ADDED FOR (W1-T206). NOT SET BY AN INJECTED READER, so `undefined` must read as "did not
   * report presence", never "absent": act only on an explicit `false`. Why: a dead daemon and an absent ledger
   * both rendered `daemonLive: undefined`
   */
  readonly present: boolean;
};

/** Attach {@link LedgerLines}' non-enumerable read metadata. Both properties describe THIS read,
 *  never the file's contents, which is why they ride the returned array rather than a wrapper
 *  object no existing call site could consume. */
function withReadMeta(out: Array<Record<string, unknown>>, torn: number, present: boolean): LedgerLines {
  Object.defineProperty(out, "torn", { value: torn, enumerable: false, configurable: true });
  Object.defineProperty(out, "present", { value: present, enumerable: false, configurable: true });
  return out as LedgerLines;
}

/** Default NDJSON ledger reader: one JSON object per non-blank line, read through the injected fs and
 *  never copied first. A torn line is LOUD in TWO ways (W1-T206) — logged to stderr for a human, and
 *  counted into `.torn` for a consumer with no stderr to watch, where the old fabricated-`{}`
 *  behaviour let neither audience tell. */
/** How many dated rotations {@link readLedgerUnionBounded} opens, newest first. MEASURED: the live
 *  file plus the NINE newest held a row of every step the board reads, for 0.23s against 7.74s for the
 *  full union. 24 is that 9 with headroom, and all 24 cost 0.21s. */
export const STATUS_BOARD_MAX_ROTATIONS = 24;

/**
 * How many rotations {@link readMergeCreditedTaskIds} may open before giving up on a task. THE CAP IS SAFE IN
 * THE DIRECTION THAT MATTERS: this reader only ADDS ids it has seen, so it cannot invent a credit. Reading too
 * shallow degrades to today's behaviour — the task is re-credited — and can never strand real work, so
 * under-read is self-correcting while over-report is unreachable. Why: all 445 ever-credited ids resolve within
 * 24 files — docs/forensics/status.md
 */
export const CREDIT_SCAN_MAX_ROTATIONS = 24;

/**
 * Every task id the ledger has EVER recorded merge credit for, across all three ledger forms, newest-first,
 * stopping as soon as every candidate resolves.
 *
 * WHY THIS EXISTS. The backfill asked its question against {@link readLedgerLines}, WHICH OPENS EXACTLY ONE
 * FILE, on the belief that registering both credit steps meant rotation could not drop them. THAT BELIEF IS
 * FALSE and is what hid the defect: registration stops a step being shed COMPLETELY but says nothing about the
 * per-step row cap, so older credit leaves the live file, the task is re-credited, and the fresh row evicts
 * another — self-sustaining. Why: a Set rather than the lines, the shared rotation helper, and the exact
 * arithmetic — docs/forensics/status.md
 */
export function readMergeCreditedTaskIds(
  path: string,
  opts: {
    /** Stop as soon as every one of these has been resolved. Omitted ⇒ read to the cap. */
    candidates?: Iterable<string>;
    maxRotations?: number;
    /** The LIVE half only, so a caller with an injected reader keeps controlling the live file while
     *  rotations still come from the real corpus — ONE code path, not a legacy branch beside a new
     *  one. A temp-dir fixture has no rotations, so behaviour is identical to today. */
    readLive?: (path: string) => Iterable<Record<string, unknown>>;
    ledgerFs?: LedgerFsDeps;
    readdirSync?: (dir: string) => string[];
    gunzipSync?: (buf: Buffer) => Buffer;
    readFileBuffer?: (p: string) => Buffer;
  } = {},
): { credited: Set<string>; filesRead: number; complete: boolean } {
  const credited = new Set<string>();
  const wanted = new Set(opts.candidates ?? []);
  // O(1) per line: decrement a counter rather than re-testing the whole candidate set. The board reader's own
  // doc records what the naive form costs — a bounded read is only cheap if the stop test is cheap too.
  let outstanding = wanted.size;
  const take = (line: Record<string, unknown>): void => {
    if (!isMergeCreditLine(line)) return;
    const id = line.task_id;
    if (typeof id !== "string" || credited.has(id)) return;
    credited.add(id);
    if (wanted.has(id)) outstanding -= 1;
  };
  const done = (): boolean => wanted.size > 0 && outstanding <= 0;

  // ledger-read-intent: live — this function's own seed, extended with rotations below.
  const live = opts.readLive ? opts.readLive(path) : readLedgerLines(path, opts.ledgerFs ?? realLedgerFs);
  for (const l of live) take(l);
  let filesRead = 1;
  if (done()) return { credited, filesRead, complete: true };

  let names: string[];
  try {
    names = (opts.readdirSync ?? nodeReaddirSync)(dirname(path));
  } catch {
    // An unreadable state dir degrades to the live answer — i.e. exactly today's behaviour — never
    // to a throw. W1-T119: a read that failed is not a read that said no.
    return { credited, filesRead, complete: false };
  }
  const rotations = ledgerRotationEntries(names, dirname(path)).sort((a, b) =>
    a.path < b.path ? 1 : a.path > b.path ? -1 : 0,
  );
  const cap = opts.maxRotations ?? CREDIT_SCAN_MAX_ROTATIONS;
  for (const entry of rotations.slice(0, cap)) {
    let text: string;
    try {
      const buf = (opts.readFileBuffer ?? ((p: string) => nodeReadFileSync(p)))(entry.path);
      text = (entry.form === "gzip" ? (opts.gunzipSync ?? nodeGunzipSync)(buf) : buf).toString("utf8");
    } catch {
      continue; // a corrupt rotation costs its rows, never the answer
    }
    filesRead += 1;
    for (const raw of text.split("\n")) {
      const l = raw.trim();
      if (!l) continue;
      try {
        take(JSON.parse(l) as Record<string, unknown>);
      } catch {
        // a torn line costs its own credit, never the walk
      }
    }
    if (done()) return { credited, filesRead, complete: true };
  }
  // `complete: false` means the cap or the corpus ran out with candidates still unresolved — those
  // get re-credited, which is today's behaviour, not a regression.
  return { credited, filesRead, complete: wanted.size === 0 ? true : outstanding <= 0 };
}

/** The ledger union a RENDERING surface needs: the live file plus dated rotations, NEWEST FIRST, stopping at
 *  `satisfied` or {@link STATUS_BOARD_MAX_ROTATIONS}. {@link readLedgerLines} cannot serve it, opening exactly
 *  ONE path, and a step in no retention set is shed COMPLETELY. IT RETURNS EVERY LINE UNFILTERED, since the
 *  board matches some steps BY PREFIX. Why: `daemon.summary` had 0 live rows against 524 in rotations, so `rmd
 *  status` reported "no cycle recorded" on a host with 524 cycles */
export function readLedgerUnionBounded(
  path: string,
  opts: {
    satisfied?: (stepsSeen: ReadonlySet<string>) => boolean;
    maxRotations?: number;
    ledgerFs?: LedgerFsDeps;
    readdirSync?: (dir: string) => string[];
    gunzipSync?: (buf: Buffer) => Buffer;
    readFileBuffer?: (p: string) => Buffer;
  } = {},
): LedgerLines {
  const ledgerFs = opts.ledgerFs ?? realLedgerFs;
  // ledger-read-intent: live — this function's own seed, extended with rotations below.
  const live = readLedgerLines(path, ledgerFs);
  const satisfied = opts.satisfied;
  // O(1) per line, accumulated ONCE. An earlier revision handed the whole growing array to the predicate on
  // every rotation, which re-scanned 173k lines nine times and cost ~2s of board wall time — a bounded read is
  // only cheap if the stop test is cheap too.
  const stepsSeen = new Set<string>();
  for (const l of live) {
    const s0 = l.step;
    if (typeof s0 === "string") stepsSeen.add(s0);
  }
  if (satisfied?.(stepsSeen)) return live;

  const stateDir = dirname(path);
  let names: string[];
  try {
    names = (opts.readdirSync ?? nodeReaddirSync)(stateDir);
  } catch {
    return live; // an unreadable state dir degrades to exactly today's answer, never to a throw
  }
  // NEWEST FIRST. The rotation stamp is an ISO instant, so a descending lexicographic sort IS
  // chronological — the same property `rmd ledger-grep`'s own sort relies on.
  const rotations = ledgerRotationEntries(names, stateDir).sort((a, b) => (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));

  const out: Array<Record<string, unknown>> = [...live];
  let torn = live.torn ?? 0;
  const cap = opts.maxRotations ?? STATUS_BOARD_MAX_ROTATIONS;
  for (const entry of rotations.slice(0, cap)) {
    let text: string;
    try {
      const buf = (opts.readFileBuffer ?? ((p: string) => nodeReadFileSync(p)))(entry.path);
      text = (entry.form === "gzip" ? (opts.gunzipSync ?? nodeGunzipSync)(buf) : buf).toString("utf8");
    } catch {
      continue; // a corrupt rotation is skipped, never fatal — the live answer still renders
    }
    for (const raw of text.split("\n")) {
      const l = raw.trim();
      if (!l) continue;
      try {
        const parsed = JSON.parse(l) as Record<string, unknown>;
        out.push(parsed);
        const s1 = parsed.step;
        if (typeof s1 === "string") stepsSeen.add(s1);
      } catch {
        torn++;
      }
    }
    if (satisfied?.(stepsSeen)) break;
  }
  return withReadMeta(out, torn, live.present);
}

/**
 * THE LIVE FILE ALONE — one path, opened, parsed, returned; it never resolves rotations. THAT MAKES A BARE CALL
 * AMBIGUOUS AT THE CALL SITE (W1-T1262), since a live read and the first step of a union read are the SAME
 * call. The signature is deliberately unchanged; instead every call — checked by {@link
 * ledgerReadIntentViolations} — must declare `ledger-read-intent: live` or `ledger-read-intent: union` on the
 * same line or the one above.
 */
export function readLedgerLines(path: string, ledgerFs: LedgerFsDeps = realLedgerFs): LedgerLines {
  const out: Array<Record<string, unknown>> = [];
  // `present: false` is the whole point of this early return carrying metadata at all — see
  // LedgerLines.present. The empty array itself is unchanged, so no existing consumer moves.
  if (!ledgerFs.existsSync(path)) return withReadMeta(out, 0, false);
  let torn = 0;
  for (const raw of ledgerFs.readFileSync(path, "utf8").split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l) as Record<string, unknown>);
    } catch {
      torn++;
      console.error(`ledger: dropping unparseable line in ${path}: ${l}`);
    }
  }
  return withReadMeta(out, torn, true);
}

/**
 * The two ways a `readLedgerLines` call can be answered, and the only two a caller may declare. Neither value
 * changes the return — declaring `"union"` does not make a bare call read rotations, the call site must do that
 * too. This only makes the CHOICE visible (W1-T1262).
 */
export type LedgerReadIntent = "live" | "union";

/**
 * One undeclared {@link readLedgerLines} call site, named — file and line — never folded into a
 * bare count (W1-T1262's fourth acceptance claim: "the check names the offending reader").
 */
export interface LedgerReadIntentViolation {
  file: string;
  line: number;
  text: string;
}

const LEDGER_READ_INTENT_CALL_RE = /\breadLedgerLines\s*\(/;
const LEDGER_READ_INTENT_DEFINITION_RE = /\bfunction\s+readLedgerLines\s*\(/;
const LEDGER_READ_INTENT_MARKER_RE = /ledger-read-intent:\s*(live|union)\b/;

/** THE CALLER-SIDE HALF of the structural fix W1-T444 gave the resolver side — a lint-style source scan, the
 *  house pattern `test/no-raw-nul.test.ts` already uses. Every call other than the definition is a VIOLATION
 *  unless the same line, or the one above, declares an intent. Both markers PASS equally: this polices only
 *  whether a choice was DECLARED, never which was correct (W1-T1262). */
export function ledgerReadIntentViolations(
  files: ReadonlyArray<{ path: string; text: string }>,
): LedgerReadIntentViolation[] {
  const violations: LedgerReadIntentViolation[] = [];
  for (const { path, text } of files) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!LEDGER_READ_INTENT_CALL_RE.test(line)) continue;
      if (LEDGER_READ_INTENT_DEFINITION_RE.test(line)) continue; // the definition, not a call
      const declaredHere = LEDGER_READ_INTENT_MARKER_RE.test(line);
      const declaredAbove = i > 0 && LEDGER_READ_INTENT_MARKER_RE.test(lines[i - 1]);
      if (!declaredHere && !declaredAbove) {
        violations.push({ file: path, line: i + 1, text: line.trim() });
      }
    }
  }
  return violations;
}

/** The minimal extra fs surface an INCREMENTAL reader needs on top of {@link LedgerFsDeps}: the size, and the
 *  bytes from `start` to EOF — never the whole file. Property-accessed off the same mutable default import at
 *  call time, so a spy on the real module observes every call. */
export interface LedgerTailFsDeps extends LedgerFsDeps {
  statSize: (path: string) => number;
  readRange: (path: string, start: number, end: number) => string;
}

const realLedgerTailFs: LedgerTailFsDeps = {
  ...realLedgerFs,
  statSize: (path) => fs.statSync(path).size,
  readRange: (path, start, end) => {
    const fd = fs.openSync(path, "r");
    try {
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, end - start, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  },
};

/**
 * Persistent state a {@link readLedgerTail} caller holds ACROSS calls — one per long-lived route, never rebuilt
 * per render. `lines` is the SAME array reference every call and only ever appended to, so a caller may hold a
 * prior return value across calls and it stays valid.
 */
export interface LedgerTailCache {
  /** @internal — byte offset already consumed. */
  offset: number;
  /** @internal — a not-yet-newline-terminated trailing partial line, carried to the next read. */
  pending: string;
  /** @internal — cumulative parsed lines; never re-parsed once minted. */
  lines: Array<Record<string, unknown>>;
  /** Cumulative count of unparseable/torn lines dropped across every read this cache has ever
   *  done (W1-T206) — never re-derived, only incremented, so it survives everything `lines`
   *  survives, including a rotation event that freezes rather than wipes `lines`. */
  torn: number;
}

export function createLedgerTailCache(): LedgerTailCache {
  return { offset: 0, pending: "", lines: [], torn: 0 };
}

/** INCREMENTAL ledger read (W1-T184): only the bytes appended since the cache's last read are parsed, so an
 *  UNCHANGED file costs one `statSync`. The fix for {@link readLedgerLines} being a full re-read — fine for
 *  one-shot CLI callers, wrong for a route polled every ~250ms. A file SHORTER than last observed degrades
 *  safely by rescanning from byte 0. Why: a console refresh degraded into an O(history) operation, behind the
 *  2026-07-20 latency outage */
export function readLedgerTail(
  path: string,
  cache: LedgerTailCache,
  fsDeps: LedgerTailFsDeps = realLedgerTailFs,
): Array<Record<string, unknown>> {
  if (!fsDeps.existsSync(path)) {
    if (cache.offset !== 0 || cache.lines.length > 0) {
      cache.offset = 0;
      cache.pending = "";
      cache.lines = [];
    }
    return cache.lines;
  }
  const size = fsDeps.statSize(path);
  if (size === cache.offset) return cache.lines; // unchanged -- one statSync, nothing else.
  if (size < cache.offset) {
    cache.offset = 0;
    cache.pending = "";
    cache.lines = [];
  }
  const chunk = fsDeps.readRange(path, cache.offset, size);
  cache.offset = size;
  const text = cache.pending + chunk;
  const segments = text.split("\n");
  cache.pending = segments.pop() ?? ""; // the last segment may be a not-yet-newline-terminated partial line.
  for (const raw of segments) {
    const line = raw.trim();
    if (!line) continue;
    try {
      cache.lines.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Loud, not silent — see readLedgerLines' doc: a torn append must never be
      // masked as a fabricated `{}` standing in for the lost record.
      console.error(`ledger: dropping unparseable line in ${path}: ${line}`);
    }
  }
  return cache.lines;
}

/** The PR-precedence fields ONLY from a prior {@link StatusProjection} (W1-T179), deliberately EXCLUDING the
 *  taxonomy layer, which is RE-DERIVED fresh from the ledger, still readable during a GitHub-only outage.
 *  Carrying it forward unfiltered would leak a STALE `needsHuman`/`phase` a later, unobserved event already
 *  superseded, since `deriveStatus` never clears a stale `true`. */
function priorPrecedence(p: StatusProjection): StatusProjection {
  const out: StatusProjection = { taskId: p.taskId, status: p.status, merged: p.merged, source: p.source };
  if (p.prNumber !== undefined) out.prNumber = p.prNumber;
  if (p.prUrl !== undefined) out.prUrl = p.prUrl;
  if (p.prState !== undefined) out.prState = p.prState;
  if (p.rejected_candidates !== undefined) out.rejected_candidates = p.rejected_candidates;
  return out;
}

/**
 * Parse a PR number off the END of a ref or url (W1-T130) — pure text parsing, never a gateway call. Backs ONLY
 * the correction rung's decoration: a correction's url is trusted TEXT, never re-resolved (see the SUPREME
 * OFFLINE note), so there is no `PrRef` to read `.number` off. Undefined when the string does not end in
 * digits, which degrades the decoration, never the verdict.
 */
function prNumberFromRef(ref: string): number | undefined {
  const n = Number(ref.match(/(\d+)$/)?.[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Map a GitHub PR state onto a plan status label + the merged predicate. */
function fromPrState(state: string): { status: TaskStatus; merged: boolean } {
  switch (state.toUpperCase()) {
    case "MERGED":
      return { status: "merged", merged: true };
    case "OPEN":
      return { status: "running", merged: false };
    case "CLOSED":
      return { status: "blocked", merged: false };
    default:
      return { status: "queued", merged: false };
  }
}

/**
 * ONE PASS OVER THE LEDGER, SHARED BY EVERY PER-TASK HELPER (R-23). The ledger is already read once (W1-T187),
 * but each of the ten helpers then walks that whole array once per task.
 *
 * BUCKETED ON THE TWO ID FIELDS, NOT ONE: nine helpers filter on `task_id` but one filters on `task`, so a
 * single-field bucket would silently drop its rows. Each helper re-filters its own bucket, so the bucket need
 * only be a SUPERSET in ledger order — which makes the substitution an identity, and an index that has drifted
 * falls back to a full scan, costing time and never an answer. Why: 776 ms per projection at 1,393 tasks x
 * 29,567 rows
 */
export interface LedgerIndex {
  /** The exact array this index was built over — identity-compared, never re-read. */
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** Rows naming an id in `task_id` OR `task`, in ledger order, each row at most once per id. */
  readonly byTask: ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>>;
  /** Rows by `step`, in ledger order — backs the whole-ledger step scans, not the per-task ones. */
  readonly byStep: ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>>;
  /** Every `pr_url` carried by a `plan_only: true` `pr.opened` row — `isPlanOnlyFilingPr`'s set. */
  readonly planOnlyFilingPrUrls: ReadonlySet<string>;
}

/** Append `row` to `id`'s bucket, creating it on first use. */
function pushIndexed(
  buckets: Map<string, Array<Record<string, unknown>>>,
  key: string,
  row: Record<string, unknown>,
): void {
  const bucket = buckets.get(key);
  if (bucket) bucket.push(row);
  else buckets.set(key, [row]);
}

/** Build the {@link LedgerIndex} for `rows` in a single pass. */
export function buildLedgerIndex(rows: ReadonlyArray<Record<string, unknown>>): LedgerIndex {
  const byTask = new Map<string, Array<Record<string, unknown>>>();
  const byStep = new Map<string, Array<Record<string, unknown>>>();
  const planOnlyFilingPrUrls = new Set<string>();
  for (const row of rows) {
    const step = row.step;
    if (typeof step === "string") {
      pushIndexed(byStep, step, row);
      if (step === "pr.opened" && row.plan_only === true && typeof row.pr_url === "string") {
        planOnlyFilingPrUrls.add(row.pr_url);
      }
    }
    const taskId = row.task_id;
    const task = row.task;
    if (typeof taskId === "string") pushIndexed(byTask, taskId, row);
    // DEDUPED against `task_id` above: a row carrying the same id in both fields must land in the bucket ONCE,
    // or {@link dispatchesEver} would count one dispatch twice.
    if (typeof task === "string" && task !== taskId) pushIndexed(byTask, task, row);
  }
  return { rows, byTask, byStep, planOnlyFilingPrUrls };
}

/** The empty bucket handed back for an id the index saw no rows for — never `lines`. */
const NO_INDEXED_ROWS: ReadonlyArray<Record<string, unknown>> = Object.freeze([]);

/** `taskId`'s rows from `index`, or `lines` itself when there is no usable index for them. */
function indexedTaskRows(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  index: LedgerIndex | undefined,
): ReadonlyArray<Record<string, unknown>> {
  if (index === undefined || index.rows !== lines) return lines;
  return index.byTask.get(taskId) ?? NO_INDEXED_ROWS;
}

/** `step`'s rows from `index`, or `lines` itself when there is no usable index for them. */
function indexedStepRows(
  lines: ReadonlyArray<Record<string, unknown>>,
  step: string,
  index: LedgerIndex | undefined,
): ReadonlyArray<Record<string, unknown>> {
  if (index === undefined || index.rows !== lines) return lines;
  return index.byStep.get(step) ?? NO_INDEXED_ROWS;
}

/** The most recent `pr.opened` ledger line for a task id, if any. */
function lastPrOpened(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  index?: LedgerIndex,
): string | undefined {
  let url: string | undefined;
  for (const line of indexedTaskRows(lines, taskId, index)) {
    if (line.step === "pr.opened" && line.task_id === taskId && typeof line.pr_url === "string") {
      url = line.pr_url; // keep scanning: last one wins
    }
  }
  return url;
}

/** One `manual.completed` ledger line, resolved — see {@link latestManualCompletion}. */
export interface ManualCompletion {
  actor: string;
  ts: string;
  /** OPTIONAL: a FULL PR url, self-describing its own owner and repo, never a bare number — the
   *  shape that lets this credit name a PR in ANY repository, not just the one the calling
   *  {@link GitHub} gateway happens to be scoped to. */
  prUrl?: string;
}

/** The most recent `manual.completed` line for a task id — last one wins. An ACTOR-AND-TIME-STAMPED assertion
 *  (W1-T1029) widening rung (b) to the two shapes a bare number cannot express: a PR in another repository, and
 *  a completion with no PR at all. A line qualifies ONLY with both `actor` and `ts` non-empty, and `ts` is the
 *  ledger's own write-time stamp, so it cannot drift. REVERSIBLE without deletion, since a later
 *  `correction.provenance` row is checked above this rung. */
export function latestManualCompletion(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  index?: LedgerIndex,
): ManualCompletion | undefined {
  let found: ManualCompletion | undefined;
  for (const line of indexedTaskRows(lines, taskId, index)) {
    if (
      line.step === "manual.completed" &&
      line.task_id === taskId &&
      typeof line.actor === "string" &&
      line.actor.length > 0 &&
      typeof line.ts === "string" &&
      line.ts.length > 0
    ) {
      found = {
        actor: line.actor,
        ts: line.ts,
        ...(typeof line.pr_url === "string" && line.pr_url.length > 0 ? { prUrl: line.pr_url } : {}),
      }; // keep scanning: last one wins
    }
  }
  return found;
}

/**
 * PER-TASK DISPATCH CIRCUIT BREAKER (MASTER-PLAN P29(ii)) — policy-as-data, never a literal buried in a caller:
 * how many times the SAME task may be dispatched with no NEW owned PR since. §9's per-WORKER tripwire's
 * per-TASK dual, and the BACKSTOP that makes P29(i)'s fix safe to get wrong. Why: the W1-T1 storm ran ~130
 * dispatches / ~$130 / ~10h with no single RUN running away
 */
export const DEFAULT_MAX_TASK_DISPATCHES = 5;

/**
 * Does this ledger line record a MERGE CREDIT for its task? ONE DEFINITION, TWO CONSUMERS, DELIBERATELY: the
 * defect it was extracted for is two mechanisms holding the same fact and never comparing notes.
 *
 * CORRECTED 2026-08-13 — this comment used to conclude "so rotation cannot drop either out from under a
 * reader", AND THAT WAS FALSE. It is the belief that hid a live defect for months, so it is corrected rather
 * than deleted: registration stops a step being shed COMPLETELY and says nothing about the per-step row cap.
 * "Was this EVER credited" needs {@link readMergeCreditedTaskIds}.
 */
export function isMergeCreditLine(line: Record<string, unknown>): boolean {
  return line.step === "verdict.merged" || (line.step === "verdict" && line.verdict === "merged");
}

/**
 * W1-T2425 — THE PRIOR COUNT THIS PROCESS DID NOT LIVE THROUGH. The breaker's regression guard can only refuse
 * what it can COMPARE against, and its prior lives in an in-memory Map rebuilt PER INVOCATION, so a rotation
 * plus a daemon RESTART was never covered: a new process starts with nothing to compare and reads a shortened
 * live file as forward progress. The evidence was already written and simply not kept — the refusal row carries
 * the exact count needed.
 *
 * TWO KEYS, DELIBERATELY: the reset lines key on `task_id`, but a refusal row is written by the DAEMON and
 * carries the refused task elsewhere, so reading one field for both would seed nothing — a zero that looks like
 * "never tripped". The step literal is INLINE on purpose: the rotation test scans consumer sources TEXTUALLY,
 * comments included, so a symbol would blind that gate and spelling the comparison out would mint a phantom
 * step. Why: W1-T1279 was refused every tick for 84 hours, then a restart let a fresh process dispatch
 */
export function seedCountFromCircuitBreak(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  index?: LedgerIndex,
): number | undefined {
  let seed: number | undefined;
  // The ONE helper reading `task` as well as `task_id` — see {@link LedgerIndex} for why the bucket is keyed on
  // both fields, which is what keeps this scan's row set unchanged.
  for (const line of indexedTaskRows(lines, taskId, index)) {
    if (line.task_id === taskId && (line.step === "pr.opened" || isMergeCreditLine(line))) {
      seed = undefined; // forward progress — the same reset the counter itself applies
      continue;
    }
    if (line.step !== "dispatch.circuit_broken" || line.task !== taskId) continue;
    const fresh = line.freshCount;
    // A row with no usable count records that a refusal happened, not what it decided on, so it must not seed a
    // guess. Absence stays absence.
    if (typeof fresh === "number" && Number.isFinite(fresh) && fresh >= 0) seed = fresh;
  }
  return seed;
}

/**
 * How many `run.start` lines exist for `taskId` SINCE its most recent FORWARD-PROGRESS line — P29(ii)'s
 * "dispatches with no NEW owned PR".
 *
 * WHY FORWARD PROGRESS IS NOT JUST `pr.opened`. That line was a sound PROXY, logged only after a worker pushes
 * its own run branch. THE BRANCH CONVENTION BROKE IT: a PR on a slug-named branch fails `ownsBranch`, so no
 * line is written and the task reads as MERGED to the backfill and as MAKING NO PROGRESS here at once. So a
 * merge resets the streak too ({@link isMergeCreditLine}) — RESTORING the stated intent, not widening it. A
 * fresh PR resets the count even if it never merges; a "succeeds every time" loop is {@link dispatchesEver}'s
 * remit. Why: two tasks both shipped yet ran to 5 dispatches each — docs/forensics/status.md / /** W1-T2423 —
 * THE RUN VERDICTS THAT MEAN THE TASK WORKER NEVER STARTED. Both are PREFLIGHT PROBES that refuse ahead of
 * every worker and FAIL CLOSED, so a run ending in either tested THE HOST, not the task. W1-T2249 IS SUBSUMED,
 * NOT RE-LITIGATED: it keyed the exclusion on a field stamped at WRITE time, making the rule FORWARD-ONLY over
 * a counter that reads history backwards, which is why it never fired. WHY A VERDICT AND NOT A CHECK: `verdict`
 * is written by the same call that has recorded these refusals all along, so the rule reads correctly over rows
 * already on disk. Why: the measured verdict distribution is in docs/forensics/status.md
 */
const PRE_WORKER_REFUSAL_VERDICTS: ReadonlySet<string> = new Set(["blocked_containment", "blocked_isolation"]);

export function dispatchesWithoutNewOwnedPr(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  index?: LedgerIndex,
): number {
  const rows = indexedTaskRows(lines, taskId, index);
  // PRE-SCAN (W1-T2249's shape, widened by W1-T2423) — two passes over the small per-task line set, because a
  // run's verdict always lands AFTER its `run.start`, so the run ids to EXCLUDE must be known before the
  // counting pass reaches them. Nothing else about the counter moves.
  const preWorkerRefusalRunIds = new Set<string>();
  for (const line of rows) {
    if (
      line.task_id === taskId &&
      line.step === "verdict" &&
      typeof line.verdict === "string" &&
      PRE_WORKER_REFUSAL_VERDICTS.has(line.verdict) &&
      typeof line.run_id === "string"
    ) {
      preWorkerRefusalRunIds.add(line.run_id);
    }
  }
  let count = 0;
  for (const line of rows) {
    if (line.task_id !== taskId) continue;
    if (line.step === "pr.opened" || isMergeCreditLine(line)) {
      count = 0; // forward progress — a new PR, or a credited merge, resets the streak
    } else if (line.step === "run.start") {
      // W1-T2423: a dispatch whose OWN run ended before the task worker started is a refusal by a HOST
      // preflight, not a dispatch that produced nothing — excluded rather than allowed to trip the breaker in
      // the task worker's stead. A run with NO verdict row is NOT excluded: unknown stays counted, so a crash
      // can never buy a task extra dispatches.
      if (typeof line.run_id === "string" && preWorkerRefusalRunIds.has(line.run_id)) continue;
      count++;
    }
  }
  return count;
}

/**
 * True once `taskId` has been dispatched {@link DEFAULT_MAX_TASK_DISPATCHES} times with no new owned PR since —
 * the caller must dispatch nothing further and escalate exactly once (P29(ii)). Re-derived FRESH from the
 * ledger every call, so unlike an in-memory flip it PERSISTS across restarts, which is what the W1-T1 storm
 * needed: it spanned many invocations.
 */
export function isDispatchBreakerTripped(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  maxDispatches: number = DEFAULT_MAX_TASK_DISPATCHES,
  index?: LedgerIndex,
): boolean {
  return dispatchesWithoutNewOwnedPr(lines, taskId, index) >= maxDispatches;
}

/**
 * SIBLING LIFETIME DISPATCH COUNTER (W1-T271). The streak counter resets on every `pr.opened` — correct for the
 * failure IT guards, but BLIND BY CONSTRUCTION to a task that re-dispatches forever while merging a genuine
 * no-op PR each time. This counts EVERY `run.start` and no step resets it. Why: W1-T254 dispatched five times
 * in eighty minutes, each merge resetting the streak counter
 */
export function dispatchesEver(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  index?: LedgerIndex,
): number {
  let count = 0;
  for (const line of indexedTaskRows(lines, taskId, index)) {
    if (line.task_id === taskId && line.step === "run.start") count++;
  }
  return count;
}

/**
 * THE THRESHOLD IS A MEASUREMENT, NOT A GUESS (W1-T271), from the unioned ledger's real per-task distribution:
 * 274 of 282 ever-dispatched tasks (97%) were dispatched 1-4 times ever, and every count at or above 5 is a
 * documented FAILURE. 10 sits above the ENTIRE legitimate population while cutting off short of the two genuine
 * storm magnitudes. Why: the corpus and per-task counts are in docs/forensics/status.md
 */
export const DEFAULT_MAX_TASK_LIFETIME_DISPATCHES = 10;

/** True once `taskId` has been dispatched {@link DEFAULT_MAX_TASK_LIFETIME_DISPATCHES} times EVER — unlike
 *  {@link isDispatchBreakerTripped}, unaffected by any `pr.opened`. Consulted ALONGSIDE the streak breaker,
 *  never in place of it. */
export function isLifetimeDispatchCapExceeded(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  maxLifetimeDispatches: number = DEFAULT_MAX_TASK_LIFETIME_DISPATCHES,
  index?: LedgerIndex,
): boolean {
  return dispatchesEver(lines, taskId, index) >= maxLifetimeDispatches;
}

/**
 * Per-process, cross-tick memory {@link evaluateDispatchBreaker} uses to notice an impossible regression
 * (W1-T206): a task's count dropping without the `pr.opened` line that would explain it. SCOPE NOTE: in-memory
 * only, so a RESTART starts with an empty baseline; {@link isDispatchBreakerTripped} covers the cross-restart
 * case, and this adds the narrower "caught it happening under a live process" guarantee a pure re-derive cannot
 * give.
 */
export interface DispatchBreakerCache {
  /** @internal highest per-task `dispatchesWithoutNewOwnedPr` count ever observed
   *  while the ledger was genuinely readable and consistent. */
  lastCounts: Map<string, number>;
}

export function createDispatchBreakerCache(): DispatchBreakerCache {
  return { lastCounts: new Map() };
}

/**
 * Tri-state read of the dispatch breaker (W1-T206). `"indeterminate"` fires instead of a false
 * `"clear"` in the two cases where trusting a fresh count would be trusting an ABSENCE as proof rather
 * than as missing information: the ledger file is gone after this cache has seen a nonzero count, or
 * the fresh count is LOWER with no `pr.opened` line to explain the drop. The caller must treat it as
 * skip-this-tick, never escalate on it alone, and never fold it into the escalate-now predicate.
 */
/** One dispatch-breaker outcome. */
export type DispatchBreakerState = "tripped" | "clear" | "indeterminate";

/** WHAT THE BREAKER SAW, not merely that it fired (the W1-T314 gap): the refusal row used to carry the task id
 *  and nothing else, so a refusal and a dispatch of the SAME task minutes apart from the SAME process could not
 *  be reconciled. Every field is a value the decision CONSUMED, from the one evaluation that produced `state`,
 *  never a second call that could answer differently. */
export interface DispatchBreakerDetail {
  /** The outcome the gate ACTED on — post-corroboration when corroboration ran. */
  state: DispatchBreakerState;
  /** The outcome the LEDGER alone produced, BEFORE corroboration. Kept distinct from {@link state} so "the
   *  ledger said tripped and GitHub cleared it" stays readable as the two facts it is. */
  ledgerState: DispatchBreakerState;
  /** `dispatchesWithoutNewOwnedPr` at decision time — the count the comparison used. */
  freshCount: number;
  /** The bound `freshCount` was compared against. */
  maxDispatches: number;
  /** The cache's prior count for this task; absent on the first observation. W1-T2425: on a first
   *  observation the cache may itself have been seeded from the newest breaker-refusal row for this
   *  task (see {@link seedCountFromCircuitBreak}), so this can be present on a process's very first
   *  call — still the cache's value, just one it learned from disk. */
  priorCount?: number;
  /** Whether a `pr.opened` line exists — the regression check's second term. */
  hasNewOwnedPr: boolean;
  /** The three-way corroboration answer. ABSENT when corroboration was never consulted; absent and
   *  `"unreadable"` are different facts, and this repo has collapsed that distinction repeatedly. */
  corroboration?: "corroborated" | "not-corroborated" | "unreadable";
}

/** The core evaluator — the two public entry points are thin `.state` reads over it, so their behaviour is
 *  unchanged. Corroboration runs only when the caller PASSES the key: presence, not value, because `undefined`
 *  is a real answer meaning "the gateway offered no read", reported as `"unreadable"`. */
export function evaluateDispatchBreakerDetailed(
  ledgerPath: string,
  taskId: string,
  cache: DispatchBreakerCache,
  opts: {
    maxDispatches?: number;
    ledgerFs?: LedgerFsDeps;
    openHeadBranches?: OpenHeadBranchesSource;
  } = {},
): DispatchBreakerDetail {
  const maxDispatches = opts.maxDispatches ?? DEFAULT_MAX_TASK_DISPATCHES;
  const ledgerFs = opts.ledgerFs ?? realLedgerFs;
  // ledger-read-intent: live — the dispatch breaker wants the newest rows only.
  const lines = readLedgerLines(ledgerPath, ledgerFs);
  // R-23: ONE pass to bucket, then per-task lookups — the helpers below otherwise walk this whole array end to
  // end each.
  const index = buildLedgerIndex(lines);
  const freshCount = dispatchesWithoutNewOwnedPr(lines, taskId, index);
  let priorCount = cache.lastCounts.get(taskId);
  // W1-T2425: FIRST OBSERVATION OF THIS TASK IN THIS PROCESS — seed the baseline from the breaker's own on-disk
  // record rather than starting blind, so the regression arm below is reachable across a restart. Only ever on
  // a MISS (a live process's own observation always outranks the ledger's), and only from the lines already
  // read here.
  if (priorCount === undefined) {
    const seeded = seedCountFromCircuitBreak(lines, taskId, index);
    if (seeded !== undefined) {
      priorCount = seeded;
      cache.lastCounts.set(taskId, seeded);
    }
  }
  const hasNewOwnedPr = lastPrOpened(lines, taskId, index) !== undefined;
  const base = { freshCount, maxDispatches, priorCount, hasNewOwnedPr };

  if (priorCount !== undefined && freshCount < priorCount && !hasNewOwnedPr) {
    // count regressed with nothing in the ledger to explain it
    return { ...base, state: "indeterminate", ledgerState: "indeterminate" };
  }

  cache.lastCounts.set(taskId, freshCount);
  const ledgerState: DispatchBreakerState = freshCount >= maxDispatches ? "tripped" : "clear";
  if (ledgerState !== "tripped" || !("openHeadBranches" in opts)) {
    return { ...base, state: ledgerState, ledgerState };
  }
  // W1-T2318: RESOLVED HERE, PAST THE GUARD — the only line that may read the list, reached only for a task
  // already tripped. Resolving a thunk at the call site would evaluate it on every call, clear tasks included,
  // which is the eager boot cost this removes. An array, null or undefined passes through untouched, so `null`
  // still reaches the corroboration as "read failed".
  const branches = resolveOpenHeadBranches(opts.openHeadBranches);
  const corroboration = corroboratesForwardProgress(branches, taskId);
  return { ...base, ledgerState, corroboration, state: corroboration === "corroborated" ? "clear" : "tripped" };
}

export function evaluateDispatchBreaker(
  ledgerPath: string,
  taskId: string,
  cache: DispatchBreakerCache,
  opts: { maxDispatches?: number; ledgerFs?: LedgerFsDeps } = {},
): "tripped" | "clear" | "indeterminate" {
  return evaluateDispatchBreakerDetailed(ledgerPath, taskId, cache, opts).state;
}

/** W1-T414: does GitHub's OWN view of open PRs corroborate `taskId`'s forward progress, even when THIS host's
 *  ledger has no local `pr.opened` line? The streak counter's reset is a statement about a BRANCH NAME, visible
 *  identically from every host, and the list is ALREADY resolved once per invocation. THREE-WAY, NOT BOOLEAN:
 *  collapsing `"unreadable"` into `"not-corroborated"` would let a network blip silently withdraw an
 *  already-legitimate reset. */
export function corroboratesForwardProgress(
  openHeadBranches: ReadonlyArray<PrRef> | null | undefined,
  taskId: string,
): "corroborated" | "not-corroborated" | "unreadable" {
  if (openHeadBranches == null) return "unreadable"; // null (failed read) or undefined (unoffered)
  const owned = openHeadBranches.some((pr) => {
    const head = pr.headRefName;
    return head !== undefined &&
      (ownsBranch(head, taskId) || isBareRunBranch(head, taskId) || isOwnedSlugBranch(head, taskId));
  });
  return owned ? "corroborated" : "not-corroborated";
}

/**
 * W1-T414: {@link evaluateDispatchBreaker}, CORROBORATED by GitHub's own view of open PRs before a `"tripped"`
 * verdict is handed back. ONLY `"tripped"` is reconsidered, and only in ONE direction: a corroborating branch
 * downgrades it, exactly as a local `pr.opened` would. UNREADABLE FALLS BACK TO THE LOCAL COUNT — this can only
 * relax a trip, never add one.
 */
export function evaluateDispatchBreakerCorroborated(
  ledgerPath: string,
  taskId: string,
  cache: DispatchBreakerCache,
  openHeadBranches: ReadonlyArray<PrRef> | null | undefined,
  opts: { maxDispatches?: number; ledgerFs?: LedgerFsDeps } = {},
): "tripped" | "clear" | "indeterminate" {
  return evaluateDispatchBreakerCorroboratedDetailed(ledgerPath, taskId, cache, openHeadBranches, opts).state;
}

/** /** The open-head-branch list, or a thunk producing it on demand (W1-T2318), so the boot path gets the
 *  ABILITY to walk the board without paying for the walk: the only site that resolves it sits past the
 *  already-tripped guard. Array, `null` and `undefined` behave exactly as before. */
export type OpenHeadBranchesSource =
  | ReadonlyArray<PrRef>
  | null
  | undefined
  | (() => ReadonlyArray<PrRef> | null | undefined);

/** Collapse an {@link OpenHeadBranchesSource} to the value `corroboratesForwardProgress` reads. */
export function resolveOpenHeadBranches(
  source: OpenHeadBranchesSource,
): ReadonlyArray<PrRef> | null | undefined {
  return typeof source === "function" ? source() : source;
}

export function evaluateDispatchBreakerCorroboratedDetailed(
  ledgerPath: string,
  taskId: string,
  cache: DispatchBreakerCache,
  openHeadBranches: OpenHeadBranchesSource,
  opts: { maxDispatches?: number; ledgerFs?: LedgerFsDeps } = {},
): DispatchBreakerDetail {
  return evaluateDispatchBreakerDetailed(ledgerPath, taskId, cache, { ...opts, openHeadBranches });
}

/** Escape a string for literal use inside a `RegExp` (dot/hyphen-safe task ids). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `Remudero-Task: <id>` claimed as false for THIS task by a `correction.provenance` line (P9-iv, a FIRST-CLASS
 *  event): the operator has established the credit is wrong, so deriveStatus must never re-surface it even if
 *  the search keeps turning it up. */
function debunkedTrailerUrls(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  index?: LedgerIndex,
): Set<string> {
  const out = new Set<string>();
  for (const line of indexedTaskRows(lines, taskId, index)) {
    if (
      line.step === "correction.provenance" &&
      line.task_id === taskId &&
      typeof line.claimed_pr_url === "string"
    ) {
      out.add(line.claimed_pr_url);
    }
  }
  return out;
}

/**
 * CORRECTIONS WIN, SUPREME (P9-iv / W1-T75): the line debunks a claimed url AND names the actual one, credited
 * directly and checked BEFORE rungs (a)/(b)/(c), since a stale `pr.opened` line is no more trustworthy than the
 * fuzzy search this originally outranked. The actual PR is NOT re-subjected to the ownership and anchor asserts
 * — a deliberate human act SUPERSEDES them, and the real PR is often hand-authored from a non-`run-` branch.
 * Last correction wins.
 */
function latestActualPrUrl(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  index?: LedgerIndex,
): string | undefined {
  let url: string | undefined;
  for (const line of indexedTaskRows(lines, taskId, index)) {
    if (
      line.step === "correction.provenance" &&
      line.task_id === taskId &&
      typeof line.actual_pr_url === "string"
    ) {
      url = line.actual_pr_url; // keep scanning: last correction wins
    }
  }
  return url;
}

/**
 * Extract the task id a fleet-dispatched run branch claims, or `undefined`. The ONE named extractor for a shape
 * tested three other ways: {@link ownsBranch} VERIFIES a known id and cannot discover one, and run-task.ts's
 * predicate is a boolean shape test with no capture group. W1-T453 lifted it out of {@link projectPlan}, where
 * it was inlined TWICE, so every caller shares one spelling.
 */
export function taskIdFromRunBranch(head: string | undefined): string | undefined {
  const m = /^run-(.+)-\d+$/.exec(head ?? "");
  return m ? m[1] : undefined;
}

/**
 * Extract the task id a SLUG branch declares in its own name — the shape {@link taskIdFromRunBranch} cannot
 * read, having no `run-` prefix (W1-T2629). PURE: the caller decides whether the id is credited.
 *
 * TRAP 1, REUSED RATHER THAN REINVENTED. A bare prefix match would let `W1-T15` credit from a `W1-T152` branch.
 * Here the candidates are the whole plan to SEARCH, so normalisation DELETES the hyphen boundary and one check
 * replaces it: a candidate matches at the START of the normalised head AND the next character is NOT A DIGIT.
 * LONGEST MATCH WINS, since the candidates are unordered.
 */
export function taskIdFromSlugBranch(
  head: string | undefined,
  candidateIds: Iterable<string>,
): string | undefined {
  if (!head) return undefined;
  const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedHead = normalize(head);
  if (!normalizedHead) return undefined;
  let best: string | undefined;
  let bestLength = -1;
  for (const candidateId of candidateIds) {
    const normalizedCandidate = normalize(candidateId);
    if (!normalizedCandidate) continue;
    if (!normalizedHead.startsWith(normalizedCandidate)) continue;
    const after = normalizedHead[normalizedCandidate.length];
    if (after !== undefined && /[0-9]/.test(after)) continue; // TRAP 1: digit boundary veto
    if (normalizedCandidate.length > bestLength) {
      best = candidateId;
      bestLength = normalizedCandidate.length;
    }
  }
  return best;
}

/** RUNG (c) OWNERSHIP-ASSERT (MASTER-PLAN P16 / W1-T69): a trailer credit is only trustworthy if the PR was
 *  opened from THIS task's own branch. LOAD-BEARING for the fix rung too (W1-T76), since that workflow amends
 *  the SAME run branch. SCOPE NARROWED 2026-07-30 (operator ruling): for a MERGED PR an anchored trailer is
 *  sufficient and the branch NAME may not veto it, but this REMAINS the gate for non-merged PRs and for rung
 *  (c2). Why: the old rule stranded W1-T64's real PR #115 permanently */
function ownsBranch(head: string | undefined, taskId: string): boolean {
  if (!head) return false;
  return new RegExp(`^run-${escapeRegExp(taskId)}-\\d+$`).test(head);
}

/** What is known about one remote branch, gathered by the caller (W1-T447). */
export interface BranchFacts {
  name: string;
  /** The most decisive PR state for this head: merged beats closed beats open. `"unknown"` means the
   *  caller could not prove a complete read, and must NEVER be produced by treating an incomplete read
   *  as `"none"` — that collapse is the defect this field exists to end (W1-T2246). */
  prState: "merged" | "closed" | "open" | "none" | "unknown";
  /** The tip is already an ancestor of main. `"unknown"` means the check could not be evaluated, and
   *  is DELIBERATELY NOT `false`, which is a decided "not an ancestor": collapsing an unreadable ref
   *  into that decided answer is the second defect W1-T2246 fixes. */
  tipInMain: boolean | "unknown";
  /** The branch NAME appears in `src/`, `scripts/`, `deploy/` or `.github/`. */
  namedInSource: boolean;
  /** PATCH-ID EQUIVALENCE (W1-T2247): the cherry check decides only a quarter of a held set alone and
   *  MISLABELS A SQUASH-MERGE AS ABSENT, so it is never consulted once `prState` has resolved a branch.
   *  It exists for the OTHER shape: no PR at all, but commits already equivalent to main's. Omitted =
   *  not proven equivalent, so an absent measurement cannot manufacture a resolution. */
  patchIdEquivalentInMain?: boolean;
  /** TASK ID THE BRANCH NAME ITSELF DECLARES (W1-T2629), resolved by the caller. Omitted means "never
   *  resolved", NOT "resolves to nothing", so an absent measurement cannot manufacture a split
   *  {@link planBranchReap} never proved. */
  namedTaskId?: string;
  /** WHETHER {@link namedTaskId}'s task is merge-credited, per the caller's OWN existing read — never
   *  a second definition of merge credit. Omitted while `namedTaskId` is present reads as "not proven
   *  credited", never as "credited". */
  namedTaskCredited?: boolean;
}

/** WHY A BRANCH LANDS WHERE IT LANDS (W1-T2247): five distinct reasons a branch is deletable or held, plus two
 *  carried over — NEVER one shared string. The squash-patch-id reason exists because the cherry check's blind
 *  spot must not be reported as a genuine "no PR ever". The two named-task reasons (W1-T2629) split that one
 *  step further; NEITHER is a sixth deletable disjunct, since a task shipping elsewhere proves nothing about
 *  THIS branch's commits. */
export type BranchReapReason =
  | "protected"
  | "merged"
  | "merged_squash_patch_id_differs"
  | "closed_unmerged"
  | "tip_in_main"
  | "patch_id_equivalent"
  | "open"
  | "no_pr_ever"
  | "named_task_credited"
  | "named_task_open"
  | "state_undetermined";

/** Operator-facing label for each {@link BranchReapReason} — never printed as one shared string. */
export const BRANCH_REAP_REASON_LABEL: Readonly<Record<BranchReapReason, string>> = {
  protected: "guarded — named in source or on the declared list",
  merged: "PR merged",
  merged_squash_patch_id_differs:
    "PR merged (squash) — patch id differs from main, so patch-id alone would misreport this as absent",
  closed_unmerged: "PR closed unmerged — already declined by a human, not unknown",
  tip_in_main: "no PR — every commit already an ancestor of main",
  patch_id_equivalent: "no PR — every commit patch-id equivalent to a commit already in main, resolved without judgement",
  open: "PR open — in use, not swept",
  no_pr_ever: "no PR ever opened and no commit proven landed — the residue that needs adjudication",
  named_task_credited:
    "no PR — branch names a task already merge-credited elsewhere, but that does not prove THIS branch's own commits are in main — still needs adjudication",
  named_task_open:
    "no PR — branch names a task that is not merge-credited — a candidate stuck-task flag, still needs adjudication",
  state_undetermined: "could not be proven either way — state undetermined, not a confirmed no-PR hold",
};

/** The dry run's answer: three disjoint buckets plus the drift alarms (W1-T447, W1-T2228). */
export interface BranchReapPlan {
  deletable: string[];
  guarded: string[];
  hold: string[];
  /** SUBSET OF `hold` (W1-T2246): held because one of the two facts could not be PROVEN, not because
   *  they were decided. Disposition is unchanged; only the REASON is separated, because a manifest
   *  calling both cases "no PR" cannot tell an operator which held branches are the only copy. */
  undetermined: string[];
  /** Branches the NAME GREP protects that the declared list does not — the drift signal. */
  undeclaredGuards: string[];
  /** DECLARED, but no branch of that name is on origin (W1-T2228). `facts` holds only branches that
   *  EXIST, so this is the one comparison that must run against the full declared list. Citation status
   *  is irrelevant here on purpose: an ephemeral guard is cited and routinely absent between landings,
   *  so "no branch on origin" alone is a normal, non-drift state. */
  missingBranches: string[];
  /** EVERY BRANCH NAMES THE TEST THAT PLACED IT (W1-T2247): one reason per entry. The bucket arrays
   *  stay the disjoint sets callers depend on — this is the reason WITHIN whichever bucket the name
   *  landed in, so a reader greps it instead of re-deriving "why". */
  reasons: Record<string, BranchReapReason>;
}

/**
 * Classify remote branches for a DRY-RUN reap. PURE: no git, no network, no deletion.
 *
 * PROTECTION IS EVALUATED FIRST AND WINS OUTRIGHT, and that ordering is the whole safety argument: a landing
 * branch can be simultaneously a MERGED PR head, which the delete rule matches, AND a live code constant, so
 * the other order would delete a branch its own source names.
 *
 * DELETABLE IS THREE DISJUNCTS and the third needs no trust: a merged head, a closed-unmerged head, or no PR
 * with a tip already in main. `"unknown"` NEVER SATISFIES ONE. `undeclaredGuards` IS AN ALARM, NOT A RESULT,
 * since a declared list rots and a name grep cannot see a variable reference. Why: `heartbeat` and the
 * ephemeral landing branches — docs/forensics/status.md
 */
export function planBranchReap(
  facts: readonly BranchFacts[],
  declaredGuards: readonly string[],
): BranchReapPlan {
  const declared = new Set(declaredGuards);
  const plan: BranchReapPlan = {
    deletable: [],
    guarded: [],
    hold: [],
    undetermined: [],
    undeclaredGuards: [],
    missingBranches: [],
    reasons: {},
  };
  // THE RAW CANDIDATE, computed against the declared list rather than `facts`, which has no row for a branch no
  // longer on origin — the one comparison that cannot be a clause in the loop below. PURE and UNCONDITIONAL:
  // this function has no citation information, so it cannot tell a dead declaration from an ephemeral one; the
  // caller, which has the citation scan, decides that (W1-T2228 (v)).
  const factNames = new Set(facts.map((f) => f.name));
  for (const name of declaredGuards) {
    if (name !== "main" && !factNames.has(name)) plan.missingBranches.push(name);
  }
  for (const f of facts) {
    // `main` is never a candidate, whatever else is true of it.
    const isGuarded = f.name === "main" || f.namedInSource || declared.has(f.name);
    if (isGuarded) {
      plan.guarded.push(f.name);
      plan.reasons[f.name] = "protected";
      if (f.namedInSource && !declared.has(f.name) && f.name !== "main") plan.undeclaredGuards.push(f.name);
      continue;
    }
    // MERGED AND CLOSED ARE DECIDED BY `prState` ALONE, BEFORE PATCH ID IS EVEN CONSULTED (W1-T2247: a
    // squash-merged branch must never read "absent" merely because its patch id differs from main's).
    // `patchIdEquivalentInMain` only ever SPLITS THE REASON for an already-deletable merged head; it can never
    // downgrade one out of `deletable`.
    if (f.prState === "merged") {
      plan.deletable.push(f.name);
      plan.reasons[f.name] = f.patchIdEquivalentInMain === false ? "merged_squash_patch_id_differs" : "merged";
      continue;
    }
    if (f.prState === "closed") {
      plan.deletable.push(f.name);
      plan.reasons[f.name] = "closed_unmerged";
      continue;
    }
    if (f.prState === "none" && f.tipInMain === true) {
      plan.deletable.push(f.name);
      plan.reasons[f.name] = "tip_in_main";
      continue;
    }
    // THE FOURTH DISJUNCT (W1-T2247): no PR at all, and every commit is patch-id equivalent to one already in
    // main — content-identical even where the tip check reads `false` or `"unknown"`, since a rebase or hand
    // cherry-pick changes the sha without changing the patch. Resolved WITHOUT any judgement step: removing the
    // ref cannot lose information.
    if (f.prState === "none" && f.patchIdEquivalentInMain === true) {
      plan.deletable.push(f.name);
      plan.reasons[f.name] = "patch_id_equivalent";
      continue;
    }
    plan.hold.push(f.name);
    // `"unknown"` PR state means merged/closed was never ruled out; `"none"` PR state paired with
    // an `"unknown"` tip means the third disjunct's own precondition (`tipInMain === true`) was
    // never provable either way — both are "could not tell", not "confirmed no PR" (W1-T2246).
    if (f.prState === "unknown" || (f.prState === "none" && f.tipInMain === "unknown")) {
      plan.undetermined.push(f.name);
      plan.reasons[f.name] = "state_undetermined";
    } else if (f.prState === "open") {
      plan.reasons[f.name] = "open";
    } else if (f.namedTaskId !== undefined) {
      // W1-T2629: the branch's name declares a task id the run-anchored extractor cannot read, and the caller
      // resolved it and whether that task is credited. NEITHER outcome moves this branch out of `hold`: a task
      // shipping by another route does not prove THIS branch's commits are in main, so this is a
      // mechanically-checkable CITATION for the same adjudication, never a verdict.
      plan.reasons[f.name] = f.namedTaskCredited === true ? "named_task_credited" : "named_task_open";
    } else {
      // Confirmed: no PR ever, tip not an ancestor, not patch-id equivalent, and the branch names no resolvable
      // task either — the residue W1-T2247 exists to size correctly (20, not 75).
      plan.reasons[f.name] = "no_pr_ever";
    }
  }
  return plan;
}

/**
 * A CITATION FOR ONE ADJUDICATION VERDICT (W1-T2247) — the residue `planBranchReap` could not resolve
 * mechanically. "Still needed" is a judgement, and a judgement without a falsifier is a guess: a citation names
 * EITHER a plan task id the change would serve OR a symbol and path in the CURRENT tree, both re-checkable by a
 * grep WITHOUT re-running whatever produced the verdict.
 */
export type AdjudicationCitation =
  | { kind: "plan_task"; taskId: string }
  | { kind: "tree_symbol"; path: string; exists: boolean };

/** One operator-facing verdict on a held, no-PR branch (W1-T2247 design (iii)). */
export interface AdjudicationVerdict {
  branch: string;
  verdict: "still needed" | "no longer needed";
  /** Absent means the verdict cites nothing — {@link admitAdjudicationVerdict} refuses it. */
  citation?: AdjudicationCitation;
}

/** {@link admitAdjudicationVerdict}'s answer: never a silent downgrade, only admit or refuse. */
export interface AdjudicationAdmission {
  admissible: boolean;
  /** Set only when `admissible` is `false` — why this verdict does not count as an answer. */
  refusalReason?: string;
}

/**
 * THE VERDICT CARRIES ITS CITATION OR IT IS REFUSED (W1-T2247) — refused outright, never downgraded or accepted
 * with a caveat, because an accepted guess is indistinguishable from a checked answer downstream. PURE: it only
 * checks that a citation is PRESENT and non-empty, leaving the walk of the plan and tree to the caller, so a
 * wrong verdict is caught by a grep rather than by trust.
 */
export function admitAdjudicationVerdict(verdict: AdjudicationVerdict): AdjudicationAdmission {
  const c = verdict.citation;
  const hasPlanCitation = c?.kind === "plan_task" && c.taskId.trim().length > 0;
  const hasTreeCitation = c?.kind === "tree_symbol" && c.path.trim().length > 0;
  if (!hasPlanCitation && !hasTreeCitation) {
    return {
      admissible: false,
      refusalReason:
        `adjudication verdict for "${verdict.branch}" cites neither a plan task id nor a current ` +
        "tree symbol — refused, not downgraded (W1-T2247 rationale §5)",
    };
  }
  return { admissible: true };
}

/** The BARE run-branch form, with no timestamp suffix. Older and hand dispatches produced it — W1-T152's own
 *  merged PR #793 is this shape — so it claims the task as legitimately as {@link ownsBranch}'s form. Kept
 *  separate so rung (c2), which credits BY branch, stays strict. */
function isBareRunBranch(head: string, taskId: string): boolean {
  return head === `run-${taskId}`;
}

/**
 * The SLUG run-branch form — the task's own branch under a descriptive name rather than a timestamp. Third
 * accepted claim form: the old rule refused merged, correctly-trailered PRs whose branches "lacked only the
 * `-<epochMs>` suffix", so such a PR was judged to claim a DIFFERENT task and vetoed its own credit
 * permanently, since a merged PR's head never changes.
 *
 * THE TRAILING `-` IS THE ENTIRE PREFIX-COLLISION GUARD (TRAP 1). KEPT OUT OF `ownsBranch`: widening that would
 * reach the corroboration rungs and grant credit the ruling deliberately refused.
 */
function isOwnedSlugBranch(head: string, taskId: string): boolean {
  return head.startsWith(`run-${taskId}-`);
}

/**
 * RUNG (c) FOREIGN-BRANCH VETO (operator ruling 2026-07-30). `true` iff `head` is a run-branch claiming a
 * DIFFERENT task — that, and ONLY that, still vetoes a trailer credit, since a branch carrying no task claim
 * vetoes nothing.
 *
 * PREFIX COLLISION (TRAP 1) is held off by the BOUNDARY CHARACTER, not by avoiding prefix matching. An earlier
 * revision said collision was "structurally impossible here because this function never PREFIX-matches an id";
 * {@link isOwnedSlugBranch} does, and the required hyphen is what makes it safe.
 */
function branchClaimsOtherTask(head: string | undefined, taskId: string): boolean {
  if (!head) return false; // unresolved head ref carries no claim — cannot veto
  if (!head.startsWith("run-")) return false; // no task claim encoded at all
  return !ownsBranch(head, taskId) && !isBareRunBranch(head, taskId) && !isOwnedSlugBranch(head, taskId);
}

/**
 * RUNG (c) ACCEPT TEST — the operator's 2026-07-30 ruling, implemented verbatim: an exactly-anchored trailer on
 * a MERGED PR is sufficient evidence, and the head-branch NAME may no longer veto it, WITH a guard that a
 * branch clearly belonging to a different task can never credit.
 *
 * TRAP 2 — NO NON-MERGED CREDIT PATH: `state` is asserted MERGED **here**, from the PrRef, not trusted from a
 * method name a fixture may implement with any state. Why: the old assert refused seven merged,
 * correctly-trailered PRs — docs/forensics/status.md
 */
function creditsByAnchoredTrailer(
  state: string,
  head: string | undefined,
  body: string | undefined,
  taskId: string,
  /** W1-T2387: does the COMMIT surface carry this task's anchored trailer for this PR? The union
   *  searches two surfaces, so the re-verify must check both or it discards the very candidate the
   *  search just produced. Defaults FALSE, so every pre-existing fixture sees body-only behaviour.
   *  Why: measured on #3005, where the search returned the PR and this function threw it away */
  commitCredits = false,
): boolean {
  // W1-T2387: EITHER anchored surface satisfies this, and NOTHING below is relaxed — the branch
  // veto, the unreadable-head fail-closed and the non-merged ownership check all still apply to a
  // commit-credited candidate exactly as they do to a body-credited one.
  if (!hasAnchoredTrailer(body, taskId) && !commitCredits) return false;
  if (state.toUpperCase() !== "MERGED") {
    // Non-merged: unchanged from before the ruling (TRAP 2).
    return ownsBranch(head, taskId);
  }
  // UNREADABLE HEAD FAILS CLOSED (W1-T119, unchanged by the ruling). An ABSENT head ref is a
  // read that FAILED, not a branch that carries no claim — and an errored read is never
  // conflated with evidence. The ruling removed the veto power of a branch NAME we can SEE;
  // it did not make an unreadable one creditable.
  if (!head) return false;
  return !branchClaimsOtherTask(head, taskId);
}

/**
 * RUNG (c) ANCHORED-TRAILER VERIFY (P16 / W1-T69): the merged-trailer search is a fuzzy full-text body
 * search, capable of matching a PR whose trailer names a DIFFERENT, prefix-sharing id — the "W1-T20c
 * false-credit" class this rung ratifies. That hit is a first pass; this is the authoritative check.
 */
/**
 * RUNG (c) PLAN-ONLY REFUSAL (W1-T413): true iff `files` is non-empty and EVERY path is in plan scope
 * ({@link isInPlanScope}, CALLED rather than re-derived) — such a PR filed or closed a task, it did not
 * build one. EMPTY IS FALSE, deliberately: an empty list is what an unreadable read looks like, and
 * "every element of nothing is in plan scope" is the vacuous pass this repo keeps re-learning.
 * DELETIONS COUNT (the #1465 lesson).
 */
/** `findMergedByTrailerAll`'s fetch bound (W1-T441). The measured worst case is six; this leaves an
 *  order of magnitude of headroom without becoming an unbounded list. */
export const TRAILER_ALL_LIMIT = 50;

/** BOOKKEEPING-ONLY (W1-T441): a changeset that filed, closed or recorded a task rather than building it.
 *  Deliberately WIDER than {@link isPlanOnlyChangeset}, because the close path writes `DECISIONS.md`, which is
 *  NOT in plan scope, so the narrower predicate reads those closes as real work. Why: the narrow one isolates 3
 *  of 16 multi-hit ids; this isolates all five generator sets */
export function isBookkeepingOnlyChangeset(files: readonly string[]): boolean {
  return files.length > 0 && files.every((f) => isInPlanScope(f) || f === "DECISIONS.md");
}

/**
 * Prefer the merged PR that IMPLEMENTED `taskId` over a later bookkeeping close (W1-T441). ONE LAYER, AND
 * NEWEST-WINS SURVIVES AS THE FALLBACK, so this can only NARROW. A candidate whose files cannot be read is
 * KEPT: unreadable is missing information, not evidence.
 *
 * A SECOND LAYER (prefer a candidate touching `src/`) WAS BUILT, MEASURED AND REMOVED: it changes the chosen PR
 * in ZERO of the 16 multi-hit ids, and the falsifier that should have caught its removal stayed green — which
 * is how it was found. Why: this isolates 8 of the 16, including 5/5 generators
 */
export function preferImplementingPr(
  candidates: readonly PrRef[],
  changedFiles: (prUrl: string) => readonly string[] | undefined,
): PrRef | undefined {
  if (candidates.length <= 1) return candidates[0];
  const notBookkeeping = candidates.filter((pr) => {
    const f = changedFiles(pr.url);
    return f === undefined || !isBookkeepingOnlyChangeset(f);
  });
  return (notBookkeeping.length > 0 ? notBookkeeping : candidates)[0];
}

export function isPlanOnlyChangeset(files: readonly string[]): boolean {
  return files.length > 0 && files.every((f) => isInPlanScope(f));
}

/**
 * Is `head` this task's OWN run branch, in any of the three accepted forms? A free, in-hand test that lets rung
 * (c) credit a worker's own PR without ever reading its file list — the pre-filter that keeps {@link
 * isPlanOnlyChangeset}'s read off the hot path.
 */
function ownsOwnRunBranch(head: string | undefined, taskId: string): boolean {
  if (!head) return false;
  return ownsBranch(head, taskId) || isBareRunBranch(head, taskId) || isOwnedSlugBranch(head, taskId);
}

function hasAnchoredTrailer(body: string | undefined, taskId: string): boolean {
  if (!body) return false;
  return new RegExp(`^Remudero-Task:\\s*${escapeRegExp(taskId)}\\s*$`, "m").test(body);
}

// ── W1-T2429 — A BUILD ON AN UNCLAIMED BRANCH IS INVISIBLE FOR THE WHOLE TIME A PR IS OPEN ─────

/**
 * W1-T2429 — which shape of run-branch-claim gap {@link runBranchClaimGap} found. `"merged-untraced"`: the PR
 * MERGED and its trailer already credited the task (the merge itself was NEVER broken), but its head was never
 * an accepted claim form, so the gap leaves no trace today. `"open-unattributable"`: still OPEN on an
 * unaccepted head, so no `pr.opened` line is written and a second dispatch stays admissible until it merges.
 */
export type RunBranchClaimGapKind = "merged-untraced" | "open-unattributable";

/** W1-T2429 — one PR's run-branch-claim gap, named and nothing else. */
export interface RunBranchClaimGap {
  kind: RunBranchClaimGapKind;
  taskId: string;
  prNumber: number;
  prUrl: string;
  headRefName?: string;
}

/**
 * W1-T2429 — DETECTION, AND NOTHING ELSE (rationale §5). Does `pr` carry `taskId`'s anchored trailer on a head
 * branch that claims the task in NONE of the three accepted forms?
 *
 * A PLAN FILING NAMES NOTHING (acceptance 3): {@link hasAnchoredTrailer} is the FIRST gate, so a filing returns
 * `undefined` before the head is inspected. OWNERSHIP IS RE-USED, NEVER RE-DERIVED (acceptance 4). A MERGED PR
 * IS STILL CREDITED (acceptance 1 REPORTS, never DENIES). PURE (acceptance 6), and NEVER CONSULTED BY DISPATCH
 * (acceptance 5).
 */
export function runBranchClaimGap(pr: PrRef, taskId: string): RunBranchClaimGap | undefined {
  if (!hasAnchoredTrailer(pr.body, taskId)) return undefined;
  if (ownsOwnRunBranch(pr.headRefName, taskId)) return undefined;
  const state = pr.state.toUpperCase();
  if (state === "MERGED") {
    return { kind: "merged-untraced", taskId, prNumber: pr.number, prUrl: pr.url, headRefName: pr.headRefName };
  }
  if (state === "OPEN") {
    return { kind: "open-unattributable", taskId, prNumber: pr.number, prUrl: pr.url, headRefName: pr.headRefName };
  }
  return undefined; // CLOSED (unmerged): no credit path either way — nothing to report
}

/** PLAN-ONLY-FILING REFUSAL (W1-T1004) — was `prUrl` opened by a plan-only FILING run, per THAT run's own
 *  positive ledger record, never inferred from the diff? WHY A SEPARATE COPY, NOT A SHARED IMPORT (design note
 *  v): the run-task.ts twin stays private there, and this task does not declare that file, since W1-T471
 *  serialises every task naming it. A task whose own deliverable is genuinely plan text still reads false here,
 *  because an ordinary implement run never writes the marker. */
function isPlanOnlyFilingPr(
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  prUrl: string,
  index?: LedgerIndex,
): boolean {
  if (index !== undefined && index.rows === ledgerLines) return index.planOnlyFilingPrUrls.has(prUrl);
  return ledgerLines.some((l) => l.step === "pr.opened" && l.pr_url === prUrl && l.plan_only === true);
}

/**
 * Derive one task's PR-precedence merge-state from GitHub (the correction/ledger/
 * pr-field/trailer rungs), in the fixed precedence — the logic `deriveStatus` carried
 * before W1-T155. Takes the ledger already read (its caller reads it once and reuses
 * it for the taxonomy layering below, rather than re-reading the file a second time).
 */
function derivePrPrecedence(task: Task, deps: DeriveDeps, ledgerLines: Array<Record<string, unknown>>): StatusProjection {
  // SUPREMACY (MASTER-PLAN P9 / W1-T75): an operator correction is checked FIRST, above rungs (a)/(b)/(c). It
  // is DECLARED credit, not INFERRED evidence, so it is deliberately EXEMPT from the ownership-assert, which
  // guards the fuzzy search and not a human declaration.
  //
  // SUPREME OFFLINE (W1-T130): `applyCorrection` already resolved the ref through a real gateway call at WRITE
  // time, so re-resolving buys nothing and puts a gateway call back on the dispatch hot path. No read result
  // may demote a correction-credited task, so this returns BEFORE any `deps.github` call. Why: under quota
  // exhaustion this rung re-dispatched an already satisfied task — docs/forensics/status.md
  const ledgerIndex = deps.ledgerIndex;
  const correctedUrl = latestActualPrUrl(ledgerLines, task.id, ledgerIndex);
  if (correctedUrl) {
    return {
      taskId: task.id,
      source: "correction",
      status: "merged",
      merged: true,
      prUrl: correctedUrl,
      prNumber: prNumberFromRef(correctedUrl),
    };
  }

  // W1-T951 DURABLE CREDIT RUNG — directly UNDER `correction`, which must still override a stale entry, and
  // directly ABOVE every rung that reads a live PR record. That ordering is the point of DELIVERABLE A: once
  // credit is durable, resolving it again costs NO PR-record read, which is what makes it independent of GitHub
  // retaining the head ref.
  const readCreditStore = deps.readCreditStore ?? (() => loadCreditStore(deps.creditStorePath ?? defaultCreditStorePath(deps.ledgerPath)));
  const writeCreditStore =
    deps.writeCreditStore ?? ((store: CreditStore) => saveCreditStore(deps.creditStorePath ?? defaultCreditStorePath(deps.ledgerPath), store));
  const creditStore = readCreditStore();
  const durableCredit = creditStore[task.id];
  if (durableCredit) {
    // Trailer is the STURDIER of the two evidentially — an anchored body hit, not a ref GitHub deletes on merge
    // — but either alone suffices: this is a tie-break for which url to report.
    const entry = durableCredit.trailer ?? durableCredit["head-branch"];
    if (entry) {
      const base: StatusProjection = {
        taskId: task.id,
        source: entry.source,
        status: "merged",
        merged: true,
        prUrl: entry.prUrl,
        prNumber: entry.prNumber,
        prState: entry.prState,
        // DELIVERABLE B: the discoverable signal (design (iii)) — a task credited by exactly one
        // of the two durable paths says so right here, in the SAME projection every existing
        // caller of `merged`/`source` already reads, no second query required.
        ...(isSinglePathCredited(creditStore, task.id) ? { singlePathCredit: true as const } : {}),
      };
      // W1-T119/W1-T179 PARITY: the durable record proves the MERGE beyond doubt, but a caller reading
      // `indeterminate` is asking whether THIS cycle's read succeeded, so a dark cycle is still surfaced. Only
      // cheap flags the gateway already computed are checked, never a NEW PR-record read.
      if (deps.github.readFailed?.() || deps.github.readTruncated?.()) {
        const previous = deps.previousProjection?.(task.id);
        const now = deps.now ?? Date.now;
        return {
          ...base,
          indeterminate: true,
          unavailableReason: deps.github.readFailureReason?.() ?? "unknown",
          githubUnobservableSince: previous?.githubUnobservableSince ?? new Date(now()).toISOString(),
        };
      }
      return base;
    }
  }

  // (b2) LEDGER-RECORDED MANUAL COMPLETION (W1-T1029) — the same hand-execution rung as (b), widened to
  // the two shapes a `pr:` number cannot express: a PR in ANOTHER repository, and a completion with NO
  // PR because none will ever exist. DECLARED credit, never re-verified, for the correction rung's
  // reason: there is no live read this rung COULD perform. Checked BEFORE (a)/(b), since a human's
  // recorded assertion outweighs an in-flight row, and reversible by a correction checked above it.
  const manualCompletion = latestManualCompletion(ledgerLines, task.id, ledgerIndex);
  if (manualCompletion) {
    return {
      taskId: task.id,
      source: "manual-completion",
      status: "merged",
      merged: true,
      ...(manualCompletion.prUrl
        ? { prUrl: manualCompletion.prUrl, prNumber: prNumberFromRef(manualCompletion.prUrl) }
        : {}),
    };
  }

  // (a) ledger `pr.opened` -> query that PR. A MERGED resolution returns immediately; a NON-merged one
  // is stashed rather than returned — SIBLING CREDIT (P29(i)): a later redispatch's own closed or open
  // PR must never permanently mask an earlier sibling run's already-merged credit found at rung (c).
  // Why: this was the W1-T1 spin's mechanism — an earlier PR merged, but every later run's own
  // `pr.opened` line resolved here first and returned, so rung (c) was never reached again
  let ownResult: StatusProjection | undefined;
  const openedUrl = lastPrOpened(ledgerLines, task.id, ledgerIndex);
  if (openedUrl) {
    const pr = deps.github.prByRef(openedUrl);
    if (pr) {
      const result: StatusProjection = { taskId: task.id, source: "ledger", ...fromPrState(pr.state), prNumber: pr.number, prUrl: pr.url, prState: pr.state };
      if (result.merged) return result;
      ownResult = result;
    }
  }

  // (b) explicit `pr:` field — W1-T116: ALWAYS consulted, even when (a) captured a non-merged result.
  // THE INVARIANT: an open-PR ledger claim is the WEAKEST evidence in the system and must never outrank
  // a VERIFIED-MERGED credit found anywhere else. A non-merged (b) result still never displaces an
  // existing one, keeping the original dedup behaviour.
  // Why: a merged `pr: 2` sat beside an open row from a later dispatch, (b) was skipped outright, and
  // the task stayed "running" forever and re-dispatched
  if (task.pr !== undefined) {
    const pr = deps.github.prByRef(task.pr);
    if (pr) {
      const result: StatusProjection = { taskId: task.id, source: "pr-field", ...fromPrState(pr.state), prNumber: pr.number, prUrl: pr.url, prState: pr.state };
      if (result.merged) return result;
      if (!ownResult) ownResult = result;
    }
  }

  // (c) a merged PR carrying the anchored `Remudero-Task:` trailer — ownership-asserted and
  // correction-aware (P16 / W1-T69). deriveStatus GATES DISPATCH, so a false credit makes the daemon
  // BUILD against an unmet dep. SIBLING CREDIT (P29(i)): reached even when (a)/(b) captured a
  // non-merged result, with the ownership assert UNCHANGED, so a foreign PR still fails.
  //
  // (c2) HEAD-BRANCH CORROBORATION (W1-T256): rung (c) reads the eventually-consistent BODY index, where
  // an exit-0 EMPTY result is INDETERMINATE rather than "not merged", so corroborate deterministically
  // by head branch and RE-ASSERT ownership. null on FAILURE and [] on a genuine miss keep the two apart.
  // Why: one body-index miss caused four spurious 07-24 re-dispatches
  const corroborateByBranch = (): StatusProjection | undefined => {
    // BATCHED first (W1-T257): the one-fetch-per-projection index. It returns null ONLY when the batch FAILED —
    // then, and only then, the per-task fetch runs; on both failing, W1-T119 defers rather than reporting a
    // false none. No batched index also falls back.
    const cands = deps.mergedHeadBranches?.(task.id) ?? deps.github.findMergedByHeadBranch?.(task.id);
    if (!cands) return undefined; // null (read failed → W1-T119) or method absent (fixture) — skip
    const debunked = debunkedTrailerUrls(ledgerLines, task.id, ledgerIndex);
    const hit = cands.find(
      (pr) =>
        pr.state.toUpperCase() === "MERGED" &&
        ownsBranch(pr.headRefName, task.id) &&
        !debunked.has(pr.url) &&
        // W1-T1004: this rung had NO plan-only guard at all before — a filing PR dispatched from this task's
        // OWN worktree, which the retro, triage and plan flows reuse, would otherwise credit the task it just
        // filed unconditionally.
        !isPlanOnlyFilingPr(ledgerLines, pr.url, ledgerIndex),
    );
    if (!hit) return undefined;
    // W1-T951 DELIVERABLE A: a merged branch hit is a NEW live credit this task's durable store does not have
    // yet — the durable rung above already returned early if it did — so persist it now, and the NEXT
    // derivation resolves from the store even after GitHub deletes the head ref. Best-effort: a write failure
    // never blocks the projection this call returns.
    writeCreditStore(recordCredit(creditStore, task.id, { source: "head-branch", prUrl: hit.url, prNumber: hit.number, prState: hit.state }));
    return { taskId: task.id, source: "head-branch", ...fromPrState(hit.state), prNumber: hit.number, prUrl: hit.url, prState: hit.state };
  };

  /**
   * (c3) OPEN HEAD-BRANCH CORROBORATION (W1-T377) — the LAST rung, consulted only once every merged path
   * has declined. THE GAP IT CLOSES: rung (a) is the only route to an OPEN credit and it reads the
   * LEDGER, while (c2) covers MERGED only, so an open PR whose `pr.opened` line never landed is
   * invisible. NEWEST WINS on a multi-hit. FAIL DIRECTION, deliberately: a false OPEN credit DEFERS a
   * dispatch while a missed one DUPLICATES a build, and the deferral is not even terminal.
   */
  const corroborateOpenByBranch = (): StatusProjection | undefined => {
    const cands = deps.openHeadBranches?.(task.id) ?? deps.github.listOpenHeadBranches?.();
    if (!cands) return undefined; // null (read failed → W1-T119) or method absent (fixture) — skip
    const hit = cands
      .filter((pr) => pr.state.toUpperCase() === "OPEN" && ownsBranch(pr.headRefName, task.id))
      .sort((a, b) => b.number - a.number)[0];
    return hit
      ? { taskId: task.id, source: "head-branch", ...fromPrState(hit.state), prNumber: hit.number, prUrl: hit.url, prState: hit.state }
      : undefined;
  };

  const trailerPr = deps.github.findMergedByTrailer(task.id);
  if (trailerPr && !debunkedTrailerUrls(ledgerLines, task.id, ledgerIndex).has(trailerPr.url)) {
    const head = deps.github.headRefName(trailerPr.url);
    const body = deps.github.prBody(trailerPr.url);
    // W1-T2387: the union's own second surface, read back from the SAME memoised commit index the
    // search used. Absent gateway method ⇒ false ⇒ body-only, exactly as before.
    const commitCredits = deps.github.creditedByCommitTrailer?.(task.id, trailerPr.url) ?? false;
    const wouldCredit = creditsByAnchoredTrailer(trailerPr.state, head, body, task.id, commitCredits);
    // W1-T1004: the ledger-backed plan-only-FILING refusal, checked BEFORE and INDEPENDENTLY of
    // `ownsOwnRunBranch`, unlike the diff-based refusal below — a filing PR dispatched from this task's OWN run
    // branch sits on that branch too, so that test would otherwise wave it through as an implementation by
    // construction. The ledger read is already in hand.
    const planOnlyFilingRefusal = wouldCredit && isPlanOnlyFilingPr(ledgerLines, trailerPr.url, ledgerIndex);
    // W1-T413: the DIFF-BASED plan-only refusal, only for a hit that would otherwise credit and that the ledger
    // check did not refuse. ORDER IS THE COST CONTROL, not style: `ownsOwnRunBranch` is free and a worker's own
    // run-branch PR is an implementation by construction, so only the residual case pays — a merged, anchored
    // PR on a HAND-NAMED branch, exactly the population the ruling admitted.
    const planOnlyDiffRefusal =
      wouldCredit && !planOnlyFilingRefusal && !ownsOwnRunBranch(head, task.id)
        ? (() => {
            const files = deps.github.changedFiles?.(trailerPr.url);
            return files !== undefined && isPlanOnlyChangeset(files);
          })()
        : false;
    const planOnlyRefusal = planOnlyFilingRefusal || planOnlyDiffRefusal;
    if (!planOnlyRefusal && wouldCredit) {
      // W1-T951 DELIVERABLE A: persist ONLY the MERGED case. `wouldCredit` is also true for a non-merged
      // own-branch PR (TRAP 2's fallback in `creditsByAnchoredTrailer`), and the durable store is a record of
      // MERGE credit, never of an in-flight or closed PR that could still change state on a later derivation.
      if (trailerPr.state.toUpperCase() === "MERGED") {
        writeCreditStore(
          recordCredit(creditStore, task.id, { source: "trailer", prUrl: trailerPr.url, prNumber: trailerPr.number, prState: trailerPr.state }),
        );
      }
      return { taskId: task.id, source: "trailer", ...fromPrState(trailerPr.state), prNumber: trailerPr.number, prUrl: trailerPr.url, prState: trailerPr.state };
    }
    // Rejected: a branch claiming ANOTHER task, a non-merged PR off a foreign branch, or an unanchored
    // hit. Corroborate by head branch first, so a foreign trailer hit cannot mask this task's own merged
    // run, then surface WHY (W1-T69) only when (a)/(b) found nothing either.
    if (!ownResult) {
      const branchCredit = corroborateByBranch();
      if (branchCredit) return branchCredit;
      // (c3) here too — this early return is a SECOND exit that concludes `source: "none"`, and a
      // task whose only trailer hit was foreign or unanchored is exactly as dispatchable-looking
      // as one with no hit at all. Leaving the rung out of this branch would close the gap on one
      // path and leave it open on the other.
      const openHere = corroborateOpenByBranch();
      if (openHere) return openHere;
      // Reason mirrors `creditsByAnchoredTrailer`'s OWN order of refusal, so a rejection never names a cause
      // the accept test did not act on: the trailer is checked first there, so an unanchored body reports that
      // regardless of branch.
      const reason = planOnlyRefusal
        ? "plan-only-changeset"
        : !hasAnchoredTrailer(body, task.id) && !commitCredits
          ? "trailer-not-anchored"
          : branchClaimsOtherTask(head, task.id)
            ? "branch-claims-other-task"
            : "trailer-pr-not-merged";
      return {
        taskId: task.id,
        status: "queued",
        merged: false,
        source: "none",
        rejected_candidates: [{ pr: trailerPr.url, reason }],
      };
    }
  }

  // (c2, continued) The trailer search credited nothing — empty, debunked, or foreign with an own PR — so
  // corroborate by head branch before falling back. A merged, ownership-asserted branch hit is a sibling credit
  // exactly like rung (c)'s, and WINS over (a)/(b)'s non-merged `ownResult`, the same direction rung (c)
  // established.
  const branchCredit = corroborateByBranch();
  if (branchCredit) return branchCredit;

  // No merged sibling credit found: fall back to (a)/(b)'s own (non-merged)
  // resolution, unchanged from before this fix.
  if (ownResult) return ownResult;

  // (c3) Nothing merged anywhere and NO association of this task's own — the one state in which an
  // open PR the ledger never recorded is the best evidence available. Strictly BELOW `ownResult`
  // and every merged rung above, so this can only ever fill a hole, never displace a credit.
  const openCredit = corroborateOpenByBranch();
  if (openCredit) return openCredit;

  // No GitHub evidence: not merged. The yaml `status:` is decorative. EXCEPT (W1-T119) when that "no evidence"
  // is really "GitHub could not be read", which must defer. A read that SUCCEEDED but only PARTIALLY defers
  // here too (W1-T415): by this line every rung above has credited anything the truncated view DID contain, so
  // this arm only catches an absence — as unsound from a partial view as from a failed one.
  if (deps.github.readFailed?.() || deps.github.readTruncated?.()) {
    const unavailableReason = deps.github.readFailureReason?.() ?? "unknown";
    // MONOTONIC UNDER DARKNESS (W1-T179): a genuine FAILURE must never regress a previously observed status to
    // `queued`. Carry the prior precedence conclusion forward and mark the gap rather than recomputing an
    // absence. The stamp is the START of the current unbroken run of failures, carried forward if already
    // marked, so consecutive failures report the same instant.
    const previous = deps.previousProjection?.(task.id);
    if (previous) {
      const now = deps.now ?? Date.now;
      return {
        ...priorPrecedence(previous),
        indeterminate: true,
        unavailableReason,
        githubUnobservableSince: previous.githubUnobservableSince ?? new Date(now()).toISOString(),
      };
    }
    // No prior observation to fall back on (this task has never been seen) -- nothing to
    // keep monotonic, so the pre-W1-T179 shape stands.
    return {
      taskId: task.id,
      status: "queued",
      merged: false,
      source: "throttled",
      indeterminate: true,
      unavailableReason,
    };
  }
  return { taskId: task.id, status: "queued", merged: false, source: "none" };
}

/** {@link derivePrPrecedence}'s scan of a task's LATEST run, for the in-flight taxonomy. */
interface RunState {
  /** A `run.start` for this task with no `verdict` line since — still executing. */
  inFlight: boolean;
  phase?: Phase;
  /** The in-flight run's `run.start` `ts`. */
  startedAt?: string;
  /** `ts` of the LATEST ledger line naming this task, any step (W1-T179's liveness heartbeat). Every
   *  append stamps `ts`, so this is a real proxy for "the worker is still doing something" rather than a
   *  dedicated event type. */
  lastActivityTs?: string;
  /** W1-T944: the newest worker-state row's state for THIS run, reset to `undefined` on every fresh
   *  {@link LANE_START_STEPS} entry exactly like `phase` resets — an earlier run's last-observed state
   *  must never leak into a later run's. */
  workerState?: WorkerState;
  /** `ts` of the ledger row that set {@link workerState} to its current value. Such a row is only
   *  ever appended ON a transition (run-task.ts's `buildWorkerStateSensor`), so the row's own `ts`
   *  IS the transition time, never a later heartbeat's. */
  workerStateSince?: string;
}

/** The ledger step a `worker.state` transition rides — run-task.ts's own constant, mirrored here
 *  as a literal rather than imported, because run-task.ts imports FROM this module and the reverse
 *  would be circular. The same way {@link LANE_START_STEPS}/{@link LANE_TERMINAL_STEPS} already
 *  mirror run-task.ts's other step literals. */
const WORKER_STATE_STEP = "worker.state";

/** Type guard for a `worker.state` ledger row's `state` field -- narrows an untyped ledger value
 *  down to {@link WorkerState}'s closed 3-value vocabulary; a malformed/unrecognized value is
 *  simply ignored (this run's `workerState` stays whatever it was, never a garbage 4th value). */
function isWorkerState(value: unknown): value is WorkerState {
  return value === "working" || value === "tool-executing" || value === "quiet";
}

/** Every REAL ledger step that OPENS a fresh in-flight run, ONE ENTRY PER LANE (W1-T282), generalised off the
 *  single literal this used to switch on, MEASURED to be blind to the other six. Verified against run-task.ts
 *  source, not guessed. A given id only ever carries ONE lane's steps, so one shared scan cannot conflate two
 *  lanes. */
const LANE_START_STEPS: ReadonlySet<string> = new Set([
  "run.start",
  "daemon.start",
  "drain.start",
  "plan.start",
  "retro.start",
  "serve.start",
  "triage.start",
]);

/**
 * Every REAL ledger step that CLOSES an in-flight run — deliberately NOT symmetric with {@link
 * LANE_START_STEPS} (W1-T282: "the close side is not uniform and must not be pretended uniform"). The retro and
 * triage lanes have only an error terminal, since a SUCCESSFUL run of either logs none, so their close relies
 * on the liveness bound rather than a fabricated step with no writer.
 */
const LANE_TERMINAL_STEPS: ReadonlySet<string> = new Set([
  "verdict",
  "daemon.stop",
  "daemon.summary",
  "drain.stop",
  "drain.summary",
  "plan.verdict",
  "plan.error",
  "retro.error",
  "serve.stop",
  "triage.error",
]);

/** Scan `taskId`'s ledger lines for the state of its LATEST run: still in flight, and if so the CURRENT phase
 *  and start (W1-T155). ANY {@link LANE_START_STEPS} entry resets every field to `recon`, so an earlier run's
 *  stale phase never leaks in — the falsifier the acceptance criteria name. W1-T282: opening and closing are
 *  table-driven, and a dispatched TASK run behaves exactly as before. */
function deriveRunState(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  index?: LedgerIndex,
): RunState {
  let inFlight = false;
  let phase: Phase | undefined;
  let startedAt: string | undefined;
  let lastActivityTs: string | undefined;
  let workerState: WorkerState | undefined;
  let workerStateSince: string | undefined;
  for (const line of indexedTaskRows(lines, taskId, index)) {
    if (line.task_id !== taskId) continue;
    if (typeof line.ts === "string") lastActivityTs = line.ts;
    // Read into a bare local BEFORE the typeof guard, never inline off the property access: the rotation test's
    // consumer scan greps every consumer file's raw TEXT, comments included, for a property-access equality
    // check quoting a literal, and is not fussy about WHICH literal follows — an inline guard here once had its
    // OWN type-guard literal mistaken for a decision-relevant step name. Same reason the lane tables are
    // Set-membership checks rather than case labels: this function's reads are display-only and must not be
    // harvested.
    const rawStep = line.step;
    const step = typeof rawStep === "string" ? rawStep : undefined;
    if (step !== undefined && LANE_START_STEPS.has(step)) {
      inFlight = true;
      phase = "recon";
      startedAt = typeof line.ts === "string" ? line.ts : undefined;
      // W1-T944: a fresh run.start resets worker.state exactly like phase resets to "recon" —
      // an earlier run's last-observed liveness must never leak into a later run's row.
      workerState = undefined;
      workerStateSince = undefined;
      continue;
    }
    if (step !== undefined && LANE_TERMINAL_STEPS.has(step)) {
      inFlight = false;
      continue;
    }
    // W1-T944: a worker-state row is only appended ON A TRANSITION, so its own `ts` doubles as the transition
    // time. The comparison reads the bare local, never the property access against a quoted literal, for the
    // harvesting reason the comment above this loop explains.
    if (step === WORKER_STATE_STEP) {
      const rawState = line.state;
      if (isWorkerState(rawState)) {
        workerState = rawState;
        workerStateSince = typeof line.ts === "string" ? line.ts : undefined;
      }
      continue;
    }
    switch (step) {
      case "recon.done":
      case "implement.resumed":
        if (inFlight) phase = "implement";
        break;
      case "implement.done":
      case "pr.opened":
        if (inFlight) phase = "review";
        break;
      case "fix.dispatch":
      case "fix.review":
        if (inFlight) phase = "fix-rung";
        break;
      case "fix.resolved":
        if (inFlight) phase = "review";
        break;
    }
  }
  return { inFlight, phase, startedAt, lastActivityTs, workerState, workerStateSince };
}

/**
 * The task's most recent escalation line, IF `escalation.issue_opened` is the LATEST signal among it and a
 * redispatch (W1-T155). DELIBERATELY DOES NOT ANSWER "is the escalation still open": the ledger is append-only,
 * so it can say one WAS opened but never that it has since closed — that needs the live join in {@link
 * resolveEscalation}. An absent url never suppresses the escalation, only the join.
 */
export function latestEscalationLine(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  index?: LedgerIndex,
): { issueUrl?: string; escalationClass?: string; openedAt?: string } | undefined {
  let last: "run" | "escalation" | undefined;
  let issueUrl: string | undefined;
  let escalationClass: string | undefined;
  let openedAt: string | undefined;
  for (const line of indexedTaskRows(lines, taskId, index)) {
    if (line.task_id !== taskId) continue;
    if (line.step === "run.start") {
      last = "run";
    } else if (line.step === "escalation.issue_opened") {
      last = "escalation";
      issueUrl = typeof line.issue_url === "string" ? line.issue_url : undefined;
      escalationClass = typeof line.class === "string" ? line.class : undefined;
      // W1-T159: the escalation's OWN ledger-line ts, carried forward so a caller can measure "how long has
      // this actually needed a human" against the escalation's real open time, never a run's `startedAt` — a
      // DIFFERENT event. See {@link StatusProjection.escalationOpenedAt}.
      openedAt = typeof line.ts === "string" ? line.ts : undefined;
    }
  }
  return last === "escalation" ? { issueUrl, escalationClass, openedAt } : undefined;
}

/** {@link deriveStatus}'s escalation-derived fields, once an escalation resolves as still-relevant. */
export interface EscalationState {
  issueUrl?: string;
  escalationClass?: string;
  title?: string;
  unverified?: true;
  openedAt?: string;
}

/**
 * JOIN LIVE STATE, DO NOT PATCH THE HISTORY SCAN (W1-T182). Returns `undefined` ONLY when the issue is
 * CONFIRMED closed; every other outcome FAILS CLOSED, keeping the row and marking it unverified, because hiding
 * a possibly-open escalation is the more dangerous direction — the inverse of W1-T181's fail-direction, and the
 * two must never be unified behind one "unreadable" policy.
 */
export function resolveEscalation(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  github: GitHub,
  index?: LedgerIndex,
): EscalationState | undefined {
  const latest = latestEscalationLine(lines, taskId, index);
  if (!latest) return undefined;
  // No issue_url at all (malformed/pre-W1-T8 ledger line) ⇒ there is nothing to join against —
  // same fail-closed treatment as an unresolved/unreadable url, never a dropped row.
  let issue: { state: string; title?: string } | null = null;
  if (latest.issueUrl) {
    try {
      // A THROWING issueByUrl — an injected fixture that raises, or a gateway this module did not anticipate —
      // must NEVER propagate out of deriveStatus, which would crash the whole projection instead of degrading
      // this ONE task to unverified. Every other read here catches its own errors internally; this call is
      // EXTERNALLY supplied, so it gets its own catch.
      issue = github.issueByUrl?.(latest.issueUrl) ?? null;
    } catch {
      issue = null;
    }
  }
  // Case-INSENSITIVE: the issue-list read reports uppercase states while this repo's OTHER GitHub-issue reader
  // sees lowercase ones for the SAME resource — two real, coexisting conventions, so normalising here means
  // both surfaces read the same.
  const state = typeof issue?.state === "string" ? issue.state.toUpperCase() : undefined;
  if (state === "CLOSED") return undefined; // confirmed resolved — the only way to drop the row.
  return {
    issueUrl: latest.issueUrl,
    escalationClass: latest.escalationClass,
    title: issue?.title,
    unverified: state === "OPEN" ? undefined : true,
    openedAt: latest.openedAt,
  };
}

/** Derive one task's FULL status taxonomy (W1-T155, MASTER-PLAN §7/§9): the PR-precedence merge-state {@link
 *  derivePrPrecedence} computes, layered with the in-flight phase and elapsed clock, the needs-human flag, and
 *  armed-awaiting-merge from the auto-merge state the batched gateway's single fetch already carries — zero
 *  extra calls. Pure over its injected deps. */
export function deriveStatus(task: Task, deps: DeriveDeps): StatusProjection {
  const readLedger = deps.readLedger ?? readLedgerLines;
  const ledgerLines = readLedger(deps.ledgerPath);
  const base = derivePrPrecedence(task, deps, ledgerLines);

  // MERGED is terminal — nothing below can add anything more useful than "it landed".
  if (base.merged) return base;

  const now = deps.now ?? (() => Date.now());
  const projection: StatusProjection = { ...base };

  // IN-FLIGHT + PHASE: never overrides an already-definitive `blocked` (a closed PR is
  // stronger GitHub evidence than an unresolved ledger scan reaching a stale run.start).
  if (base.status !== "blocked") {
    const runState = deriveRunState(ledgerLines, task.id, deps.ledgerIndex);
    if (runState.inFlight && runState.phase) {
      // LIVENESS BOUND (W1-T179 design (ii), W1-T155's amended criterion): a ledger-only in-flight trace is
      // only "running" while it is BACKED by an open PR — independent, stronger GitHub evidence, never subject
      // to this bound — OR by ledger activity within the bound. Absent both, it is a stale or orphaned dispatch
      // and must NOT render as running.
      const hasOpenPr = base.status === "running";
      const livenessBoundMs = deps.livenessBoundMs ?? DEFAULT_LIVENESS_BOUND_MS;
      const recentActivity =
        runState.lastActivityTs !== undefined && now() - Date.parse(runState.lastActivityTs) <= livenessBoundMs;
      // THE THIRD DISJUNCT (see {@link DeriveDeps.inflightHolder}): a HELD lock whose holder is judged STILL
      // ALIVE by `isHolderStale` (W1-T368 — pid liveness alone is not enough, since a recycled pid must not
      // count). Both halves are required and neither suffices. Absent the dependency the disjunct is skipped,
      // leaving the prior behaviour byte-for-byte.
      const holder = deps.inflightHolder?.(task.id) ?? null;
      const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
      const hasLiveLock =
        holder !== null &&
        !isHolderStale(holder, { isPidAlive, getProcessStartTime: deps.getProcessStartTime });
      if (hasOpenPr || recentActivity || hasLiveLock) {
        projection.status = "running";
        projection.phase = runState.phase;
        // PROCESS-UNEVIDENCED (design note ii): held SEPARATELY from the disjunction just evaluated. When an
        // open PR is the ONLY reason this row entered the branch, the decoration below is honest about resting
        // on a remote fact rather than an observed local process. Never flips the status word, and never turns
        // a skipped lock read into "dead".
        if (hasOpenPr && !recentActivity && !hasLiveLock) {
          projection.processUnevidenced = true;
        }
        if (runState.startedAt) {
          projection.startedAt = runState.startedAt;
          projection.elapsedMs = Math.max(0, now() - Date.parse(runState.startedAt));
        }
        // W1-T944: `workerState` rides the SAME "this row is running" gate as `phase`/`startedAt` above, so a
        // finished or orphaned run can never carry a lingering liveness word. Absent when the run has emitted
        // no such row yet — the console renders "state unknown" rather than treating a blank as a healthy
        // default.
        if (runState.workerState) {
          projection.workerState = runState.workerState;
          // workerStateSince backs the client's "quiet Nm" ageing tick (design note ii) — only
          // meaningful while the CURRENT state is quiet, so it stays sparse otherwise.
          if (runState.workerState === "quiet" && runState.workerStateSince) {
            projection.workerStateSince = runState.workerStateSince;
          }
        }
      } else {
        // Dispatched, no terminal verdict, no open PR, no recent activity and no live lock: orphaned, never
        // running — the falsifier being an orphaned dispatch rendered as running. A lock held by a DEAD pid
        // lands here too, which is the point: a stale lock must not resurrect the very defect this rung
        // prevents.
        projection.orphaned = true;
      }
    }
  }

  // W1-T2392: reaching here already proves NOT merged, so this only asks the remaining question, "did a build
  // for this land anyway?". The index is SUPPLIED by `projectPlan` off the merged list it already fetched,
  // never fetched again here — W1-T257's guard counts batched calls and a second one would break it. Absent the
  // dep, this is silent and derivation is byte-identical.
  const uncredited = uncreditedBuildWarning(task.id, deps.proseNamedTaskIds, deps.github.changedFiles?.bind(deps.github));
  if (uncredited) projection.uncreditedBuild = uncredited;

  const escalation = resolveEscalation(ledgerLines, task.id, deps.github, deps.ledgerIndex);
  if (escalation) {
    projection.needsHuman = true;
    if (escalation.issueUrl) projection.escalationIssueUrl = escalation.issueUrl;
    if (escalation.title) projection.escalationTitle = escalation.title;
    if (escalation.unverified) projection.escalationUnverified = true;
    if (escalation.openedAt) projection.escalationOpenedAt = escalation.openedAt;
  }

  // ARMED-AWAITING-MERGE: only meaningful for a currently OPEN PR, and it reuses the exact url the precedence
  // rungs above already resolved, so this is never a second, independently-resolved PR reference.
  if (projection.status === "running" && projection.prUrl && deps.github.autoMergeArmed?.(projection.prUrl)) {
    projection.armedAwaitingMerge = true;
  }

  // W1-T507: the OTHER reason a row needs a person — a task filed `verify: human`. Three call sites treat that
  // as an EXCLUSION from machine attention and nothing else, so nothing before this point tells a person such a
  // task is theirs.
  //
  // COMPUTED HERE, deliberately NOT at the projectPlan level: this is a pure function of `task` plus this
  // call's own resolved state, which keeps every caller DERIVATION-EQUIVALENT. `merged` is always false here,
  // so only `indeterminate` needs checking — flagging off an unread state is the fail-open direction W1-T119
  // prevents. DELIBERATELY A DIFFERENT FIELD FROM `needsHuman`, which backs an affordance such a task never
  // has.
  if (task.verify === "human" && !projection.indeterminate) {
    projection.verifyHumanPending = true;
  }

  return projection;
}

/** Every distinct `task_id` named on an `escalation.issue_opened` line (W1-T283) — the ONE scan {@link
 *  projectPlan} needs to find escalations belonging to no plan task, done once over the already-read ledger
 *  rather than per candidate id. */
function taskIdsWithEscalationLines(
  lines: ReadonlyArray<Record<string, unknown>>,
  index?: LedgerIndex,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const line of indexedStepRows(lines, "escalation.issue_opened", index)) {
    if (line.step !== "escalation.issue_opened") continue;
    if (typeof line.task_id !== "string") continue;
    if (seen.has(line.task_id)) continue;
    seen.add(line.task_id);
    ids.push(line.task_id);
  }
  return ids;
}

// ── W1-T485: SUBSTANCE THAT SHIPPED UNDER ANOTHER TASK'S TRAILER ─────────────────────────────
// THE GAP THIS FILLS: W1-T458's `unresolved_task_scope` advisory fires when a merging diff resolves NO
// task, so it answers "no task at all" and cannot answer "the WRONG task".
//
// A REPORT, NEVER A GATE. A merge-time refusal keyed on a trailer mismatch would fire on every FILING,
// since filings must omit the trailer (#1527), and a bound that fires on a healthy condition gets muted.
// Why: a PR merged carrying one task's trailer while shipping another's — docs/forensics/status.md

/** One commit `git log -S` attributes to a symbol, with whatever trailer it carries. */
export interface SupersessionCommit {
  sha: string;
  subject: string;
  /** The `Remudero-Task:` trailer this commit carries, when it carries one. */
  trailerTaskId?: string;
}

/** Evidence that an unmerged task's substance is already on main under ANOTHER task's trailer. */
export interface SupersessionEvidence {
  /** The task's OWN `grep:` proof pattern that matched — its most distinctive string. */
  symbol: string;
  /** The task's own declared path the symbol was searched in. */
  path: string;
  /** The task the crediting commit actually named — never this task. */
  creditedTaskId: string;
  sha: string;
  subject: string;
}

/** Search history for a symbol within one path. Returns the commits that introduced or removed it, or `null`
 *  when the read FAILED — a failed search must never read as "no evidence", the same cannot-observe-then-defer
 *  polarity `deriveStatus`'s own failure rung keeps. */
export type SupersessionSearch = (symbol: string, path: string) => readonly SupersessionCommit[] | null;

const TRAILER_RE = /^Remudero-Task:[ \t]*([A-Za-z0-9-]+)[ \t]*$/m;

/**
 * A task's proof-derived symbols paired with every path the task declared.
 *
 * W1-T506 WIDENED THIS FROM `grep:`-ONLY, which was dialect-gated and getting worse as convention moves proofs
 * to `unit test:`, whose body carries a TITLE and never a path. The fix stops asking the proof BODY for a path
 * at all: `files:` supplies one for EVERY task.
 *
 * WHY THE PROOF TEXT AND NOT THE FILE PATH ALONE: the cheap predicate was measured and REJECTED, since a task
 * naming a busy file is flagged by a file that moves daily, while a proof pattern is forced by the linter to be
 * distinctive enough to match its own subject. Why: both motivating cases were all-`unit test:` and invisible
 * to the old predicate
 */
export function proofGrepTargets(task: Task): Array<{ symbol: string; path: string }> {
  const declared = task.files ?? [];
  const symbols: string[] = [];
  for (const c of task.acceptance ?? []) {
    const proof = typeof c.proof === "string" ? c.proof : "";
    const trimmed = proof.trim();
    const grepMatch = trimmed.match(/^grep:\s*([\s\S]*)$/i);
    if (grepMatch) {
      const split = grepMatch[1].match(/^([\s\S]*?)\s+in\s+(\S*[./]\S*)\s*$/i);
      const symbol = (split ? split[1] : grepMatch[1]).trim();
      if (symbol) symbols.push(symbol);
      continue;
    }
    const unitMatch = trimmed.match(/^unit test:\s*([\s\S]*)$/i);
    if (unitMatch) {
      const symbol = unitMatch[1].trim();
      if (symbol) symbols.push(symbol);
    }
  }
  if (symbols.length === 0 || declared.length === 0) return [];
  const out: Array<{ symbol: string; path: string }> = [];
  for (const symbol of symbols) for (const path of declared) out.push({ symbol, path });
  return out;
}

/**
 * The evidence that this task's substance shipped under a DIFFERENT task's trailer, or `undefined`.
 *
 * FOUR OUTCOMES ARE DELIBERATELY COLLAPSED TO "NO EVIDENCE": `opts.merged` contradicts a stronger signal — and
 * THIS GUARD LIVES HERE, NOT ONLY AT THE CALL SITE (W1-T506); a commit with THIS task's trailer is CREDIT; one
 * with NO trailer is W1-T458's territory; and a `null` search is a FAILED READ. THE OLDEST QUALIFYING COMMIT
 * WINS, since the search returns newest-first and the first hit would credit whichever task most recently
 * touched the symbol rather than the one that introduced it.
 */
export function findSupersessionEvidence(
  task: Task,
  search: SupersessionSearch,
  opts?: { merged?: boolean },
): SupersessionEvidence | undefined {
  if (opts?.merged) return undefined;
  for (const { symbol, path } of proofGrepTargets(task)) {
    const commits = search(symbol, path);
    if (commits === null) continue; // a failed read is not evidence of absence
    for (let i = commits.length - 1; i >= 0; i--) {
      const c = commits[i];
      const credited = c?.trailerTaskId;
      if (!c || !credited || credited === task.id) continue;
      return { symbol, path, creditedTaskId: credited, sha: c.sha, subject: c.subject };
    }
  }
  return undefined;
}

/** A {@link SupersessionSearch} backed by the `git log` pickaxe that found both measured cases. `exec` is
 *  injectable so the predicate above is testable without a repository; a throwing exec yields `null`, never
 *  `[]`. NOT WIRED INTO ANY HOT PATH BY DEFAULT: one history search per task per projection would be the
 *  O(N)-subprocess cost W1-T187 and W1-T257 both had to remove. */
export function buildGitLogSupersessionSearch(opts: {
  ref?: string;
  cwd?: string;
  exec?: (args: string[]) => string;
}): SupersessionSearch {
  const ref = opts.ref ?? "origin/main";
  const exec =
    opts.exec ??
    ((args: string[]) =>
      execFileSync("git", args, { encoding: "utf8", cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] }));
  return (symbol, path) => {
    let raw: string;
    try {
      // `-S<symbol>` with an explicit `--` so a symbol that looks like a flag or a path cannot be read as one.
      // RECORD-SEPARATED output, so a subject or body containing a newline cannot split a record.
      raw = exec(["log", ref, `-S${symbol}`, "--format=%H%x00%s%x00%b%x1e", "--", path]);
    } catch {
      return null;
    }
    const out: SupersessionCommit[] = [];
    for (const record of raw.split("\x1e")) {
      const trimmed = record.replace(/^\n+/, "");
      if (!trimmed.trim()) continue;
      const [sha, subject, body] = trimmed.split("\x00");
      if (!sha || subject === undefined) continue;
      const trailer = (body ?? "").match(TRAILER_RE);
      out.push({ sha: sha.trim(), subject, ...(trailer ? { trailerTaskId: trailer[1] } : {}) });
    }
    return out;
  };
}

/** W1-T2387 — THE TASK-ID GRAMMAR THE COMMIT SURFACE MUST BE FILTERED THROUGH. The trailer-appending helper is
 *  called at TWO sites and the second passes a RUN ID (W1-T1012), so the commit corpus contains trailer lines
 *  naming run ids, and a union that indexed those would credit a run as though it were a task. The optional
 *  trailing letter is real, since ids like `W1-T123a` are live. Why: this rejects 0 of 921 plan ids and 170 of
 *  740 commit tokens, every rejected one a run id */
export const TASK_ID_TRAILER_RE = /^W[0-9]+-T[0-9]+[A-Za-z]?$/;

/** A squash merge's own PR number, off the `(#N)` suffix in the subject — the SAME join the
 *  shard's 2,389-PR measurement used. A commit whose subject names no PR is skipped rather than
 *  guessed at: without a number there is no {@link PrRef} to return. */
function prNumberFromSquashSubject(subject: string): number | undefined {
  const m = /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : undefined;
}

/**
 * W1-T2387 — THE SECOND TRAILER SURFACE, AS AN INDEX. The commit trailer is MACHINE-written while the PR-body
 * trailer is HAND-written, and the merged search read only the hand-written one.
 *
 * A UNION, NEVER A COMPARISON: consulted only AFTER the body surface answers EMPTY, so it can only ADD credit
 * and has no refuse-a-merge failure mode. NO NEW FETCH — an already-local `git log`, MEASURED at 32 ms for 3.6
 * MB. `null` on a failed read, never [].
 *
 * ⚠ THE WHOLE SURFACE DEPENDS ON A REPO SETTING THIS FILE OTHERWISE NEVER NAMES (W1-T2447):
 * `squash_merge_commit_message`, an admin-only UI toggle with no commit, review or ledger row. MEASURED as
 * `COMMIT_MESSAGES` here, which is the ONLY reason the amended trailer survives the squash. The other legal
 * value, `PR_BODY`, discards the branch commits entirely, and flipping to it does not break this function:
 * every FUTURE squash simply stops carrying a trailer, so the index quietly stops growing while looking exactly
 * as healthy as it does today. Pinned by `test/commit-trailer-surface-squash-setting.test.ts`. Why: 16 merged
 * PRs carried the trailer in the commit and not the body — docs/forensics/status.md
 */
export function buildCommitTrailerIndex(opts: {
  /** `owner/repo`, only ever used to render the {@link PrRef} url — never to fetch anything. */
  slug: string;
  ref?: string;
  cwd?: string;
  exec?: (args: string[]) => string;
}): () => Map<string, PrRef[]> | null {
  const slug = opts.slug;
  const ref = opts.ref ?? "origin/main";
  const exec =
    opts.exec ??
    ((args: string[]) =>
      execFileSync("git", args, {
        encoding: "utf8",
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // NOT OPTIONAL HARDENING — MEASURED: this repo's history renders 3.6 MB through this format and Node's
        // default `maxBuffer` is 1 MiB, so the default throws ENOBUFS and the index reads `null` on every real
        // repository. The first probe against the live corpus returned exactly that.
        maxBuffer: 1 << 24,
      }));
  return () => {
    // THE CHECKOUT MUST BE THIS GATEWAY'S OWN REPO, AND THIS IS NOT DEFENSIVE TIDINESS — IT IS A DEFECT THIS
    // TASK SHIPPED ONCE AND CAUGHT. A gateway is constructed for an explicit owner and repo, but `git log`
    // reads whatever checkout the PROCESS sits in, and the first draft consulted it unconditionally, turning
    // two suites red: a fixture asking about one repo was answered from another's history. A local commit
    // surface is evidence about the LOCAL repo and no other. AN EMPTY MAP, NOT `null`: a foreign checkout is a
    // genuine ABSENCE, not a failed read (W1-T119).
    let originUrl: string;
    try {
      originUrl = exec(["config", "--get", "remote.origin.url"]).trim();
    } catch {
      // No `origin` remote to read, so this checkout cannot be SHOWN to be this gateway's repo — the
      // foreign-checkout case above, a genuine ABSENCE of local evidence. An empty map, never `null`, which
      // this file reserves for the history read itself failing.
      return new Map();
    }
    const localSlug = originUrl.replace(/\.git$/, "").replace(/^.*[:/]([^/]+\/[^/]+)$/, "$1");
    if (localSlug.toLowerCase() !== slug.toLowerCase()) return new Map();
    let raw: string;
    try {
      raw = exec(["log", ref, "--format=%H%x00%s%x00%b%x1e"]);
    } catch {
      // The local commit surface could not be READ (no such ref, a shallow clone, a git that would not run).
      // `null` is this file's "unreadable", kept distinct from the empty map above so a failed read is never
      // mistaken for a repo that genuinely credits nothing (W1-T119).
      return null;
    }
    const out = new Map<string, PrRef[]>();
    for (const record of raw.split("\x1e")) {
      const trimmed = record.replace(/^\n+/, "");
      if (!trimmed.trim()) continue;
      const [, subject, body] = trimmed.split("\x00");
      if (subject === undefined) continue;
      const token = (body ?? "").match(TRAILER_RE)?.[1];
      // THE GRAMMAR CHECK IS LOAD-BEARING, not defensive tidiness: without it every run-id
      // trailer above becomes an indexed "task".
      if (!token || !TASK_ID_TRAILER_RE.test(token)) continue;
      const number = prNumberFromSquashSubject(subject);
      if (number === undefined) continue;
      const list = out.get(token) ?? [];
      list.push({ number, url: `https://github.com/${slug}/pull/${number}`, state: "merged" });
      out.set(token, list);
    }
    return out;
  };
}

/** Derive every task in a plan and cache the projection to `cachePath` (state/status.json). Returns a taskId ->
 *  projection map. Writes ONLY the cache. */
export function projectPlan(
  plan: Plan,
  deps: DeriveDeps,
  cachePath?: string,
): Map<string, StatusProjection> {
  // MONOTONIC UNDER DARKNESS (W1-T179): absent an injected `previousProjection`, read THIS cache file's PRIOR
  // contents before overwriting them — the natural "last successfully observed projection" for any caller that
  // persists here, so every existing call site gets the fix free. Fails soft on a missing or corrupt cache.
  let effectiveDeps = deps;
  if (cachePath && !deps.previousProjection) {
    const previousByTaskId = readCachedProjections(cachePath);
    if (previousByTaskId) {
      effectiveDeps = { ...deps, previousProjection: (taskId) => previousByTaskId.get(taskId) };
    }
  }
  // READ THE LEDGER ONCE (W1-T187): `deriveStatus` parses the WHOLE ledger on every call and the loop below
  // calls it once PER TASK, so an N-task plan re-read it N times — clocked at 5-8s per projection against the
  // console's <2s budget. The path is shared and cannot change mid-loop, so it is parsed once and every task is
  // handed the SAME array.
  const readLedgerOnce = effectiveDeps.readLedger ?? readLedgerLines;
  const ledgerLinesOnce = readLedgerOnce(effectiveDeps.ledgerPath);
  // R-23: AND INDEX IT ONCE, for the same reason. Reading once was half the fix — the ten per-task helpers each
  // still walked the whole array, so an N-task plan scanned it ~10N times.
  const ledgerIndex = effectiveDeps.unindexedForEquivalenceTest ? undefined : buildLedgerIndex(ledgerLinesOnce);
  effectiveDeps = { ...effectiveDeps, readLedger: () => ledgerLinesOnce, ledgerIndex };
  // W1-T951 DELIVERABLE A, READ AND WRITE THE DURABLE STORE ONCE PER PLAN — the same batch-once shape. Without
  // it an N-task plan would parse the store once per task and, worse, fsync N times per projection instead of
  // once.
  const creditStorePathOnce = effectiveDeps.creditStorePath ?? defaultCreditStorePath(effectiveDeps.ledgerPath);
  const creditStoreAtStart = effectiveDeps.readCreditStore ? effectiveDeps.readCreditStore() : loadCreditStore(creditStorePathOnce);
  const flushCreditStore = effectiveDeps.writeCreditStore ?? ((store: CreditStore) => saveCreditStore(creditStorePathOnce, store));
  let creditStoreLive = creditStoreAtStart;
  effectiveDeps = {
    ...effectiveDeps,
    readCreditStore: () => creditStoreLive,
    writeCreditStore: (store: CreditStore) => {
      creditStoreLive = store;
    },
  };
  // BATCHED rung (c2) CORROBORATION (W1-T257): the per-task corroboration fires for EVERY uncredited task on
  // EVERY projection, which was the 07-23 GraphQL-exhaustion multiplier. Fetch every merged PR's head ref ONCE
  // here and match CLIENT-SIDE, on the STRUCTURED ref rather than the body index. A FAILED batch yields `null`
  // for every task, so derivation falls back per-task and, failing that, W1-T119 defers rather than a false
  // none.
  const allMerged = effectiveDeps.github.listMergedHeadBranches?.();
  if (allMerged !== undefined) {
    let byTask: Map<string, PrRef[]> | null = null;
    if (allMerged !== null) {
      byTask = new Map<string, PrRef[]>();
      for (const pr of allMerged) {
        const owner = taskIdFromRunBranch(pr.headRefName);
        if (owner === undefined) continue;
        const existing = byTask.get(owner);
        if (existing) existing.push(pr);
        else byTask.set(owner, [pr]);
      }
    }
    const captured = byTask;
    // W1-T2392: the SAME rows, walked once more in memory for the prose index — no second fetch, and skipped
    // entirely when the batched read failed.
    const prose = allMerged !== null ? indexProseNamedTaskIds(allMerged) : undefined;
    effectiveDeps = {
      ...effectiveDeps,
      ...(prose ? { proseNamedTaskIds: prose } : {}),
      mergedHeadBranches: captured ? (taskId: string) => captured.get(taskId) ?? [] : () => null,
    };
  }
  /** W1-T2397: every OPEN PR this pass already fetched, for the open-sibling observation. */
  let openForSiblings: readonly PrRef[] | undefined;
  // BATCHED rung (c3) CORROBORATION (W1-T377) — the same batch-once shape as the merged index above, over the
  // OPEN slice of the SAME fetch. Free on `buildBatchedGithub`; one extra list read on `ghGateway`. A FAILED
  // read yields `null` for every task, so the rung skips and W1-T119 does the deferring — never a false "no
  // open PR".
  const allOpen = effectiveDeps.github.listOpenHeadBranches?.();
  if (allOpen !== undefined) {
    let openByTask: Map<string, PrRef[]> | null = null;
    if (allOpen !== null) {
      openByTask = new Map<string, PrRef[]>();
      for (const pr of allOpen) {
        const owner = taskIdFromRunBranch(pr.headRefName);
        if (owner === undefined) continue;
        const existing = openByTask.get(owner);
        if (existing) existing.push(pr);
        else openByTask.set(owner, [pr]);
      }
    }
    const capturedOpen = openByTask;
    effectiveDeps = {
      ...effectiveDeps,
      openHeadBranches: capturedOpen ? (taskId: string) => capturedOpen.get(taskId) ?? [] : () => null,
    };
    // W1-T2397: the SAME rows, kept for the open-sibling observation below — no second enumeration, and a
    // failed read stays `undefined` so the observation simply does not fire rather than reporting an absence it
    // cannot see.
    openForSiblings = allOpen ?? undefined;
  }
  const byId = new Map<string, StatusProjection>();
  for (const task of plan.tasks) {
    const p = deriveStatus(task, effectiveDeps);
    // W1-T2397: computed HERE rather than inside `deriveStatus` so it can never be mistaken for a precedence
    // input — attached after the projection is decided, and read only by a log.
    if (!p.merged) {
      const sib = openSiblingBuild(task.id, task.files, openForSiblings, effectiveDeps.github.changedFiles?.bind(effectiveDeps.github));
      if (sib) p.openSiblingBuild = sib;
    }
    byId.set(task.id, p);
  }
  // W1-T951: ONE flush for the whole plan sweep. Skipped entirely when nothing new was discovered this cycle,
  // which is the common case once a plan's credits are mostly durable, so a steady-state poll loop costs zero
  // writes rather than one no-op write per cycle.
  if (creditStoreLive !== creditStoreAtStart) flushCreditStore(creditStoreLive);
  // W1-T485 — attached HERE rather than inside `deriveStatus`, so that function, which every precedence rung
  // and every existing test drives, is left byte-identical: this is an additive observation about tasks the
  // rungs have ALREADY resolved, not a new rung. Skips anything judged merged, and anything `indeterminate`,
  // whose `merged: false` was never actually observed — reporting off an unread state would be the fail-open
  // direction W1-T119 prevents.
  const supersessionSearch = effectiveDeps.supersessionSearch;
  if (supersessionSearch) {
    for (const task of plan.tasks) {
      const projection = byId.get(task.id);
      if (!projection || projection.merged || projection.indeterminate) continue;
      // `merged` is always false here, since the loop above already skipped a merged projection. Passed
      // explicitly anyway so the invariant is the PREDICATE's, not just this loop's — see {@link
      // findSupersessionEvidence} on why the guard lives in both places.
      const evidence = findSupersessionEvidence(task, supersessionSearch, { merged: projection.merged });
      if (evidence) byId.set(task.id, { ...projection, supersededBy: evidence });
    }
  }
  // TASK-LESS ESCALATIONS (W1-T283): the loop above is a function of plan.tasks ALONE, so an escalation whose
  // `task_id` names no plan task had no row to attach to and could never render — the panel read "nothing needs
  // you" while dozens of such issues were open. A SECOND, INDEPENDENT source, never a wider version of that
  // loop, which would still need a plan Task. An id the plan DOES own is skipped.
  for (const taskId of taskIdsWithEscalationLines(ledgerLinesOnce, ledgerIndex)) {
    if (plan.byId.has(taskId)) continue;
    const escalation = resolveEscalation(ledgerLinesOnce, taskId, effectiveDeps.github, ledgerIndex);
    if (!escalation) continue; // confirmed closed (or otherwise resolved) — no row, same as above.
    byId.set(taskId, {
      taskId,
      status: "blocked",
      merged: false,
      source: "none",
      needsHuman: true,
      ...(escalation.issueUrl !== undefined ? { escalationIssueUrl: escalation.issueUrl } : {}),
      ...(escalation.title !== undefined ? { escalationTitle: escalation.title } : {}),
      ...(escalation.unverified !== undefined ? { escalationUnverified: true } : {}),
      ...(escalation.openedAt !== undefined ? { escalationOpenedAt: escalation.openedAt } : {}),
    });
  }
  if (cachePath) {
    fs.mkdirSync(dirname(cachePath), { recursive: true });
    const projection = {
      generated_at: new Date().toISOString(),
      note: "Machine-owned projection derived from GitHub. tasks.yaml is never rewritten.",
      tasks: Object.fromEntries([...byId].map(([id, p]) => [id, p])),
    };
    // ATOMIC WRITE: four call sites share this path and a 250ms-polled reader can land mid-write. A plain
    // truncating write is not atomic, so a torn read parses as garbage and the reader fails soft to
    // `undefined`, silently discarding the very "last successfully observed projection" W1-T179's fallback
    // depends on. Temp file then rename, which POSIX makes atomic within a directory, with the temp name salted
    // by pid and a random suffix so two writers never collide.
    const tmpPath = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(projection, null, 2) + "\n");
    fs.renameSync(tmpPath, cachePath);
  }
  return byId;
}

/** Read a previously-written `state/status.json` cache back into a taskId -> projection map (W1-T179) —
 *  undefined on anything short of a well-formed prior write, never throwing. Feeds {@link projectPlan}'s
 *  darkness fallback. Not exported: a caller wanting a `previousProjection` for other reasons can inject one
 *  directly. */
function readCachedProjections(cachePath: string): Map<string, StatusProjection> | undefined {
  if (!fs.existsSync(cachePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { tasks?: Record<string, StatusProjection> };
    if (!parsed || typeof parsed.tasks !== "object" || parsed.tasks === null) return undefined;
    return new Map(Object.entries(parsed.tasks));
  } catch {
    return undefined;
  }
}

/**
 * Read a repo's REQUIRED status-check contexts straight from GitHub branch protection (W1-T103, the #170
 * stuck-ambiguous fix) — the authoritative list the sweep gates on, read ONCE per repo and branch. Fails SOFT
 * to `undefined` on ANY error. / /** W1-T2399 — THE THREE READINGS THAT USED TO COLLAPSE INTO ONE `undefined`:
 * no required contexts, an empty list, and a read that FAILED OUTRIGHT. The caller sets one boolean from it, so
 * a repo-wide outage was reported as a claim about the PR's own checks. The same split W1-T2370 made between
 * `unverifiable` and `refuted`. FAIL-SOFT IS UNCHANGED (W1-T176 (ii) is NOT reopened).
 */
export type RequiredContextsRead =
  | { kind: "contexts"; contexts: string[] }
  | { kind: "none" }
  | { kind: "unreadable"; branch: string; reason: string };

/** W1-T2399: the classified read. {@link ghRequiredStatusCheckContexts} is now a thin wrapper over
 *  this, so every pre-existing caller keeps its exact signature and behaviour. */
export function readRequiredStatusCheckContexts(owner: string, repo: string, branch = "main"): RequiredContextsRead {
  let raw: string;
  try {
    raw = execFileSync(
      "gh",
      ["api", `repos/${owner}/${repo}/branches/${branch}/protection/required_status_checks`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (e) {
    // THE FACT THIS TASK EXISTS TO PRESERVE. One line, classified at the point of failure, because nothing
    // downstream can recover it: an absent binary, an unprivileged token, a network error and a 404 on an
    // unprotected branch all land here and all used to become a bare `undefined`.
    return { kind: "unreadable", branch, reason: firstLine((e as Error)?.message) || "gh read failed" };
  }
  try {
    const parsed = JSON.parse(raw) as { contexts?: unknown; checks?: Array<{ context?: unknown }> };
    const fromChecks = (parsed.checks ?? [])
      .map((c) => c.context)
      .filter((c): c is string => typeof c === "string" && c.length > 0);
    if (fromChecks.length > 0) return { kind: "contexts", contexts: fromChecks };
    const fromContexts = Array.isArray(parsed.contexts) ? parsed.contexts.filter((c): c is string => typeof c === "string") : [];
    // READ SUCCESSFULLY, AND THE ANSWER IS NONE — a different fact from a failed read, and the whole point of
    // the split. The branch is protected; it simply requires no contexts.
    return fromContexts.length > 0 ? { kind: "contexts", contexts: fromContexts } : { kind: "none" };
  } catch (e) {
    return { kind: "unreadable", branch, reason: firstLine((e as Error)?.message) || "unparseable protection payload" };
  }
}

/** W1-T2399: keeps a multi-line `gh` error to one legible sentence for an escalation body. */
function firstLine(msg: string | undefined): string {
  if (!msg) return "";
  const line = msg.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim().slice(0, 160);
}

export function ghRequiredStatusCheckContexts(owner: string, repo: string, branch = "main"): string[] | undefined {
  // W1-T2399: a THIN WRAPPER over the classified read above, so every pre-existing caller keeps the exact
  // `string[] | undefined` contract it was written against. `none` and `unreadable` both answer `undefined`
  // here, which is precisely the collapse the classified form avoids — a caller that needs to tell them apart
  // calls {@link readRequiredStatusCheckContexts} directly.
  const read = readRequiredStatusCheckContexts(owner, repo, branch);
  return read.kind === "contexts" ? read.contexts : undefined;
}

// ── Real GitHub gateway (execs `gh`; runs outside the sandbox — TLS only there).

/** Build a {@link GitHub} gateway scoped to `owner/repo`. Every query is fail-soft: a missing PR or an error
 *  resolves to null, so derivation degrades to the next precedence source rather than throwing. `opts.exec`
 *  (W1-T119) is an INJECTABLE stand-in for the raw invocation, so a test can simulate a classified failure
 *  without shelling out. */
export function ghGateway(
  owner: string,
  repo: string,
  opts: {
    exec?: (args: string[]) => string;
    /** W1-T2387: injectable stand-in for {@link buildCommitTrailerIndex}'s real `git log` read —
     *  real callers omit it. */
    commitTrailerIndex?: () => Map<string, PrRef[]> | null;
  } = {},
): GitHub {
  const slug = `${owner}/${repo}`;
  // W1-T2387 — THE COMMIT SURFACE, MEMOIZED AND LAZY: built at most ONCE per gateway instance and only once a
  // task has actually missed on the body surface. NOT TTL'd like the body index, since commits are append-only,
  // so a stale index can only LACK a very recent merge — the case the body surface answers.
  let commitIndex: Map<string, PrRef[]> | null | undefined;
  const commitTrailerFallback = (taskId: string): PrRef[] => {
    if (commitIndex === undefined) commitIndex = (opts.commitTrailerIndex ?? buildCommitTrailerIndex({ slug }))();
    return commitIndex?.get(taskId) ?? [];
  };
  // W1-T2387: the re-verify half, over the SAME memoised index — never a second `git` call.
  const commitCreditsFor = (taskId: string, prUrl: string): boolean =>
    commitTrailerFallback(taskId).some((r) => r.url === prUrl);
  // Sticky for this gateway instance's lifetime (W1-T119): once ANY call fails, every null or empty result
  // derived since is untrustworthy as "absent". A short-lived gateway cannot know which earlier calls shared
  // the outage, so it errs toward deferring.
  let failed = false;
  let failureReason: GhFailureReason | undefined;
  const rawRun =
    opts.exec ??
    // stdio's 3rd fd is `pipe`, not `ignore` (W1-T119): the pre-fix triple discarded stderr, the one place a
    // rate-limit or auth message appears. `timeout` is not optional hardening — this call is synchronous, so an
    // unbounded one parks the whole process (see {@link GH_CALL_TIMEOUT_MS}).
    ((args: string[]) =>
      execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GH_CALL_TIMEOUT_MS }));
  // W1-T2219: these back `readState()`. Wrapping the ONE call point every query method funnels through means
  // neither needs its own bookkeeping. In-flight is observable only from a REENTRANT call.
  let attempted = false;
  let inFlight = false;
  const run = (args: string[]): string => {
    attempted = true;
    inFlight = true;
    try {
      return rawRun(args);
    } finally {
      inFlight = false;
    }
  };
  const tryJson = <T>(args: string[]): T | null => {
    try {
      return JSON.parse(run(args)) as T;
    } catch (err) {
      failed = true;
      const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
      failureReason = classifyGhFailure(e?.status, e?.stderr != null ? String(e.stderr) : undefined, e?.code);
      return null;
    }
  };
  // Same sticky-failure bookkeeping as the JSON path, for the ONE call reading plain `--jq`-filtered lines —
  // the same shape `buildBatchedGithub` pays for the same reason: paginating without `--jq` emits one JSON
  // array PER PAGE, which the parser rejects outright.
  const tryLines = (args: string[]): string[] | null => {
    try {
      return run(args).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    } catch (err) {
      failed = true;
      const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
      failureReason = classifyGhFailure(e?.status, e?.stderr != null ? String(e.stderr) : undefined, e?.code);
      return null;
    }
  };
  // `ref` is either a bare PR number or a full PR URL — the two shapes every real call site passes. REST
  // addresses a PR by number only, so both are folded down here rather than at each call site.
  const prNumberFromRef = (ref: string | number): number | undefined => {
    if (typeof ref === "number") return Number.isInteger(ref) ? ref : undefined;
    const fromPath = ref.match(/\/pull\/(\d+)(?:[/?#]|$)/)?.[1];
    if (fromPath) return Number(fromPath);
    return /^\d+$/.test(ref.trim()) ? Number(ref.trim()) : undefined;
  };
  const fetchPrRow = (ref: string | number): RestPullRow | null => {
    const n = prNumberFromRef(ref);
    return n === undefined ? null : tryJson<RestPullRow>(singlePrRestArgs(owner, repo, n));
  };
  /** One REST search-issues result item — the shape actually needed off it, not the whole schema. */
  interface RestSearchItem {
    number: number;
    html_url: string;
    state?: string;
    pull_request?: { merged_at?: string | null };
  }
  // Body and head-branch search over REST's search endpoint, not the CLI's list verb, which is answered off
  // GraphQL's search connection whatever flags are passed. The query-qualifier language is shared verbatim, so
  // only the transport changes. Sorting is pinned to creation order, which the pre-conversion callers relied
  // on, rather than search's relevance-ranked default.
  const searchMergedPrs = (query: string, limit: number): PrRef[] | null => {
    const q = `repo:${slug} is:pr is:merged ${query}`;
    const res = tryJson<{ items?: RestSearchItem[] }>([
      "api", `search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=${limit}`,
    ]);
    if (!res) return null;
    return (res.items ?? []).slice(0, limit).map((it) => ({
      number: it.number,
      url: it.html_url,
      state: prStateFromRest({ state: it.state, merged_at: it.pull_request?.merged_at }),
    }));
  };
  const listPullsByState = (state: "open" | "closed", maxItems: number): RestPullRow[] | null => {
    const perPage = 100;
    const out: RestPullRow[] = [];
    for (let page = 1; out.length < maxItems; page += 1) {
      const rows = tryJson<RestPullRow[]>(boardPrsRestArgs(owner, repo, state, page, perPage));
      if (rows === null) return null;
      out.push(...rows);
      if (rows.length < perPage) break;
    }
    return out.slice(0, maxItems);
  };
  return {
    prByRef(ref) {
      // "title" rides this SAME fetch (W1-T184) — a decoration, never an extra call: the RECENT activity feed
      // reads it off the SAME PrRef this method already returns.
      const row = fetchPrRow(ref);
      return row && typeof row.number === "number"
        ? { number: row.number, url: row.html_url, state: prStateFromRest(row), title: row.title }
        : null;
    },
    findMergedByTrailer(taskId) {
      // Body search for the exact trailer, merged only, newest first. Fuzzy (P16 / W1-T69), so callers must
      // re-verify head ref and body before crediting: a first pass, never the authority.
      const list = searchMergedPrs(`"Remudero-Task: ${taskId}" in:body`, 1);
      if (list && list.length > 0) return list[0];
      // W1-T2387: THE BODY IS STILL THE FIRST SURFACE — this runs only when that search SUCCEEDED and found
      // nothing. `null` means the read FAILED, and an outage must keep reporting as an outage (W1-T119), never
      // be papered over with local evidence.
      if (list === null) return null;
      return commitTrailerFallback(taskId)[0] ?? null;
    },
    findMergedByTrailerAll(taskId) {
      // W1-T441: the SAME fuzzy body search widened past the single-hit limit. Unlike the batched twin this
      // DOES cost a wider fetch, which is why it is a separate method: existing callers keep the one-hit answer
      // and pay nothing new. {@link TRAILER_ALL_LIMIT} bounds it.
      const byBody = searchMergedPrs(`"Remudero-Task: ${taskId}" in:body`, TRAILER_ALL_LIMIT);
      // W1-T2387: same union, same order of precedence — body first, commit surface only on a successful empty
      // answer, so every answer the body already gave is byte-identical.
      if (byBody === null || byBody.length > 0) return byBody;
      return commitTrailerFallback(taskId).slice(0, TRAILER_ALL_LIMIT);
    },
    findMergedByHeadBranch(taskId) {
      // Merged PRs whose HEAD BRANCH matches this task's run prefix (W1-T256). That qualifier is STRUCTURED —
      // the branch name, NOT the body index rung (c) depends on and that a single eventually-consistent miss
      // emptied. Fuzzy, since a prefix can over-match, so the head ref rides along and the caller re-asserts
      // ownership. REST's search result carries no head field, being an Issue shape, so each bounded hit pays
      // one more read to recover it.
      const hits = searchMergedPrs(`head:run-${taskId}-`, 10);
      if (hits === null) return null;
      return hits.map((h) => {
        const row = tryJson<RestPullRow>(singlePrRestArgs(owner, repo, h.number));
        return { ...h, headRefName: row ? mapRestPr(row).headRefName : undefined };
      });
    },
    listMergedHeadBranches() {
      // ONE list of every merged PR's head ref (W1-T257), matched CLIENT-SIDE for the whole plan. Deterministic
      // LIST API, NOT the body index. The closed listing carries CLOSED-and-unmerged rows too, so
      // `prStateFromRest` rather than a raw state comparison separates the two.
      const rows = listPullsByState("closed", 1000);
      if (rows === null) return null;
      return rows
        .filter((r) => prStateFromRest(r) === "MERGED")
        .map((r) => ({ number: r.number, url: r.html_url, state: "MERGED", headRefName: r.head?.ref ?? "" }));
    },
    listOpenHeadBranches() {
      // W1-T377: the OPEN twin — one list of every open PR's head ref, matched CLIENT-SIDE. Deterministic LIST
      // API, never the body index. null on FAILURE, [] on genuinely no open PRs.
      const rows = listPullsByState("open", 1000);
      if (rows === null) return null;
      return rows.map((r) => ({ number: r.number, url: r.html_url, state: "OPEN", headRefName: r.head?.ref ?? "" }));
    },
    headRefName(prUrl) {
      const row = fetchPrRow(prUrl);
      return row ? mapRestPr(row).headRefName : undefined;
    },
    prBody(prUrl) {
      const row = fetchPrRow(prUrl);
      return row ? mapRestPr(row).body : undefined;
    },
    // W1-T2387: the union's second anchored surface, for `creditsByAnchoredTrailer`'s re-verify.
    creditedByCommitTrailer(taskId, prUrl) {
      return commitCreditsFor(taskId, prUrl);
    },
    changedFiles(prUrl) {
      // W1-T413. Mirrors the batched gateway's own changed-files read: the files endpoint has no
      // field-selection story, so filenames come straight off `--jq`. null on a failure is the UNAVAILABLE
      // signal the caller keeps today's answer for.
      const n = prNumberFromRef(prUrl);
      if (n === undefined) return undefined;
      const lines = tryLines(["api", "--paginate", `repos/${slug}/pulls/${n}/files`, "--jq", ".[].filename"]);
      if (!lines) return undefined;
      // A row set that parsed but yielded no usable path is a MALFORMED read, not an empty PR — reported as
      // unavailable rather than as a changeset that touches nothing.
      return lines.length > 0 ? lines : undefined;
    },
    autoMergeArmed(prUrl) {
      const row = fetchPrRow(prUrl);
      return (row ? mapRestPr(row).autoMergeRequest : null) != null;
    },
    issueByUrl(url) {
      const n = url.match(/\/issues\/(\d+)/)?.[1];
      if (!n) return null;
      const view = tryJson<{ state?: string; title?: string }>(["api", `repos/${slug}/issues/${n}`]);
      return view && typeof view.state === "string" ? { state: view.state, title: view.title } : null;
    },
    readFailed() {
      // Already non-forcing (W1-T2219): this gateway never shelled out on its own initiative, so the sticky
      // flag is exactly the "most recently completed attempt" verdict `readFailed()` promises.
      return failed;
    },
    readFailureReason() {
      return failureReason;
    },
    readState() {
      if (inFlight) return "in_flight";
      if (!attempted) return "not_attempted";
      return failed ? "failed" : "ok";
    },
    // Shares the same sticky flag as `readFailed()` (W1-T119's "one outage taints every read since"
    // discipline): this per-task gateway makes one call per query, so there is no separate batched issue fetch
    // to distinguish.
    issueReadFailed() {
      return failed;
    },
    // W1-T2219: same one-call-per-query shape as the flag above — no separate issue-channel fetch here, so this
    // shares the SAME sticky reason.
    issueReadFailureReason() {
      return failureReason;
    },
  };
}

/** One PR row from the single batched `gh pr list` fetch that backs {@link buildBatchedGithub}. */
export interface BatchedPr {
  number: number;
  url: string;
  state: string;
  headRefName?: string;
  /** The exact current head commit; see {@link PrRef.headRefOid}. */
  headRefOid?: string;
  body?: string;
  /** GitHub's raw auto-merge field (W1-T155): absent when not armed, an object when it is. Carried
   *  verbatim, never pre-reduced to a boolean, so the gateway applies the SAME null test `ghGateway` and
   *  run-task.ts already use. */
  autoMergeRequest?: unknown;
  /** The PR's title (W1-T184) — see {@link PrRef.title}; carried verbatim off the same batched fetch. */
  title?: string;
}

/** One issue row from the single batched issue-list fetch backing {@link GitHub.issueByUrl} (W1-T182) — the
 *  escalation counterpart to {@link BatchedPr}, cached the same way, so resolving 44+ escalated rows costs the
 *  SAME one call the board already pays for PRs. */
export interface BatchedIssue {
  number: number;
  url: string;
  state: string;
  title?: string;
}

/**
 * A GitHub gateway that answers ALL of {@link GitHub}'s methods from ONE batched fetch of the repo's PRs, held
 * in memory with a short TTL, instead of one subprocess PER call.
 *
 * WHY: {@link ghGateway}'s trailer search runs one search PER task, so `projectPlan` over an N-task plan makes
 * O(N) sequential subprocesses — at 183 tasks, ~74s, and the browser hangs at "loading…". Its trailer search
 * matches the ANCHORED line rather than a fuzzy substring, so `W1-T1` never mis-selects a `W1-T15` PR.
 *
 * W1-T181: a THROWING fetch was the deep defect, since the pre-fix catch converted "I could not read GitHub"
 * into "GitHub says there are zero PRs". The catch now wraps `fetchAll` itself, so an INJECTED implementation
 * that throws is classified like a real failure, and the flags back `readFailed()`, consulted BEFORE trusting
 * an empty result. Why: ENOBUFS carries no stderr, so it classified "unknown" and the outage ran for hours in
 * silence
 */

/** The commit-status context the merge gate keys on — duplicated as a LOCAL literal rather than imported,
 *  exactly like run-task.ts does, because lib/review.ts imports `readLedgerLines` from HERE and the reverse
 *  import would be circular. */
const REVIEW_STATUS_CONTEXT = "remudero-review";

/**
 * W1-T1005: the process-lifetime {@link GhCallPacer} every gateway shares when its caller omits `opts.pacer`.
 * Module scope, not function scope, is what makes "shared" true — a pacer built per construction would give
 * each gateway its own gap state, which is the defect under a new name.
 *
 * ITS BLOCKING WAIT IS REAL EVERYWHERE EXCEPT UNDER THE NODE TEST RUNNER: as a module singleton with a 1,500ms
 * gap, every unpaced gateway in a test file blocks on the SAME real clock — measured on test/status.test.ts
 * alone, 1.3s before this existed and 64.4s with a plain default.
 */
let defaultGhCallPacer: GhCallPacer | undefined;

/**
 * TEST-ONLY (W1-T1005). Installs or clears the module-scoped {@link defaultGhCallPacer} so test/status.test.ts
 * can prove the DEFAULT is shared and overridable without depending on load order across that file's other ~140
 * tests, many of which would otherwise be the ones that lazily create — and thereby pin — the real default
 * first. No production path calls this.
 */
export function resetDefaultGhCallPacerForTest(pacer?: GhCallPacer): void {
  defaultGhCallPacer = pacer;
}

// ── W1-T2440 — THE PRE-WARM'S WALK, OFF THE REQUEST-SERVING THREAD ──────────────────────────
// `GitHub.warm?(): void` is fire-and-forget and cannot be awaited, since the signature returns `void`.
// Before this task it called the two index builders DIRECTLY, and both walk the same synchronous call
// {@link GH_CALL_TIMEOUT_MS} names as parking the whole process: a COLD walk is 18-22s, so a request
// arriving during it queued behind a refresh it never asked for. Widening the signature to a promise
// reaches every implementer and caller, which this task does not own.
//
// SO THE WALK MOVES TO A SEPARATE OS THREAD INSTEAD OF A DIFFERENT CALL SHAPE, reusing the same exported
// fetch helpers UNCHANGED, so there is no second walk mechanism to drift — only a second THREAD running
// the first one. THIS FILE IS LOADED TWICE, with `isMainThread`/`workerData` gating the branch. SCOPED
// TO THE REAL DEFAULT: `workerData` is structured-cloned, so an injected exec keeps the sync path.
const BOARD_PREWARM_WORKER_KIND = "remudero-board-prewarm-walk" as const;

/** What the main thread hands the worker — plain data only, per `workerData`'s structured-clone
 *  contract. The two `known` maps are the SAME delta caches the fetch helpers already carry
 *  between refreshes; a Map clones structurally, so the worker's copy is a snapshot, never a live
 *  handle back into this process's memory. */
interface PrewarmWorkerRequest {
  kind: typeof BOARD_PREWARM_WORKER_KIND;
  owner: string;
  repo: string;
  ghBin: string;
  fetchOpen: boolean;
  fetchMerged: boolean;
  fetchIssues: boolean;
  knownBoardPrs?: Map<number, BoardPrRest>;
  knownIssues?: Map<number, BoardIssueRest>;
}

function isPrewarmWorkerRequest(v: unknown): v is PrewarmWorkerRequest {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === BOARD_PREWARM_WORKER_KIND;
}

/** One channel's outcome, classified exactly like `attemptFetch`'s own catch (same
 *  {@link classifyGhFailure}), so a worker-side failure reads identically to a synchronous one. */
type PrewarmChannelOutcome<T> =
  | { ok: true; rows: T[]; truncated: boolean; bytes: number; calls: number; mode: "full" | "delta" }
  | { ok: false; reason: GhFailureReason; message: string };

interface PrewarmWorkerResponse {
  open?: PrewarmChannelOutcome<BoardPrRest>;
  merged?: PrewarmChannelOutcome<BoardPrRest>;
  issues?: PrewarmChannelOutcome<BoardIssueRest>;
}

/** Runs one channel's fetch inside the worker and NEVER throws out of this function — a failure
 *  becomes data in the response instead of an uncaught worker exception, mirroring `attemptFetch`
 *  W1-T181's "the catch classifies and marks, it never propagates" discipline. */
function prewarmRunChannel<T, R extends { rows: T[]; truncated: boolean; calls: number; mode: "full" | "delta" }>(
  fetch: () => R,
  bytes: () => number,
): PrewarmChannelOutcome<T> {
  try {
    const fetched = fetch();
    return { ok: true, rows: fetched.rows, truncated: fetched.truncated, bytes: bytes(), calls: fetched.calls, mode: fetched.mode };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
    return {
      ok: false,
      reason: classifyGhFailure(e?.status, e?.stderr != null ? String(e.stderr) : undefined, e?.code),
      message: e?.message ?? String(err),
    };
  }
}

/** THE WALK ITSELF — one channel set, run synchronously wherever it is CALLED FROM. Factored out of the worker
 *  branch so it has exactly ONE body: the worker calls it in the spawned thread, and the spawn-failure fallback
 *  calls it on the main thread, which keeps that fallback binary-aware and — load- bearing for this task's
 *  diff-coverage gate — gives every line here a real, forceable execution. */
function runPrewarmChannelsSync(req: PrewarmWorkerRequest): PrewarmWorkerResponse {
  // Its OWN pacer, not the main thread's module-scoped default — a `Worker` has its own heap, so the two cannot
  // share one gap-tracking object. This paces the up-to-three calls THIS walk makes against each other but does
  // NOT coordinate with the main thread's pacer. Priced, not hidden: a narrower rate-limit exposure, worth a
  // follow-up, never a reason to keep the walk on the serving thread.
  const walkPacer = createGhCallPacer(isTestRunner() ? { sleepSync: () => {} } : {});
  const runSync = (args: string[]): string =>
    execFileSync(req.ghBin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26, timeout: GH_CALL_TIMEOUT_MS });
  const makeFetchJson = (): { fetchJson: (args: string[]) => unknown; bytes: () => number } => {
    let bytes = 0;
    return {
      fetchJson: (args: string[]): unknown => {
        const raw = paceGhEntry(walkPacer, isGhRateLimitError, () => runSync(args));
        bytes += Buffer.byteLength(raw, "utf8");
        return JSON.parse(raw);
      },
      bytes: () => bytes,
    };
  };
  const response: PrewarmWorkerResponse = {};
  if (req.fetchOpen) {
    const { fetchJson, bytes } = makeFetchJson();
    response.open = prewarmRunChannel(() => fetchBoardPrsRest(req.owner, req.repo, fetchJson, undefined, "open"), bytes);
  }
  if (req.fetchMerged) {
    const { fetchJson, bytes } = makeFetchJson();
    response.merged = prewarmRunChannel(() => fetchBoardPrsRest(req.owner, req.repo, fetchJson, req.knownBoardPrs, "closed"), bytes);
  }
  if (req.fetchIssues) {
    const { fetchJson, bytes } = makeFetchJson();
    response.issues = prewarmRunChannel(
      () => fetchLabelledIssuesRest(req.owner, req.repo, NEEDS_HUMAN_LABEL, fetchJson, req.knownIssues),
      bytes,
    );
  }
  return response;
}

/**
 * THE WORKER BRANCH's whole body, as a named function rather than an inline statement.
 *
 * EXTRACTED FOR COVERAGE, AND THE EXEMPTION ROUTE IS CLOSED BY DESIGN: Node's coverage instruments the PARENT
 * only, so a statement running solely inside a spawned `Worker` records zero hits, and the diff-coverage script
 * refuses the process-boundary directive unless the declaration is re-exec or exit glue. So the line earns real
 * coverage instead. The guard below stays a ONE-LINE `if` on purpose.
 */
export function postPrewarmWorkerResponse(
  port: { postMessage: (value: unknown) => void } | null,
  req: PrewarmWorkerRequest,
): void {
  port?.postMessage(runPrewarmChannelsSync(req));
}

// THE WORKER BRANCH ITSELF. Only reachable inside a worker thread this module's own `runPrewarmWorker` spawned
// with the matching kind — a worker spawned any other way (there are none here) and the normal main-thread load
// both leave this untouched.
if (!isMainThread && isPrewarmWorkerRequest(workerData)) postPrewarmWorkerResponse(parentPort, workerData);

export function buildBatchedGithub(
  owner: string,
  repo: string,
  opts: {
    ttlMs?: number;
    now?: () => number;
    fetchAll?: () => BatchedPr[];
    /** INJECTABLE stand-in for the raw PR-list invocation (W1-T181, mirroring {@link ghGateway}'s seam).
     *  Tests inject a fake returning a large seeded JSON string, proving the fetch survives a payload
     *  over Node's 1 MiB default, or throwing a classified-failure-shaped error — without shelling out,
     *  and without bypassing the default's parse and byte-size-log wrapper. */
    exec?: (args: string[]) => string;
    /** W1-T2387: injectable stand-in for {@link buildCommitTrailerIndex}'s real `git log` read —
     *  real callers omit it. Mirrors {@link ghGateway}'s own seam of the same name. */
    commitTrailerIndex?: () => Map<string, PrRef[]> | null;
    /** Observability hook (W1-T181), called on every fetch attempt: the payload size after a successful
     *  read, then the outcome for EVERY `fetchAll`. Defaults to a no-op; real callers wire it to the
     *  ledger so the next approach to a ceiling is observable in advance and a failure is ledgered with
     *  its classified reason. */
    log?: (event: string, extra?: Record<string, unknown>) => void;
    /** INJECTABLE stand-in for the batched escalation-issue fetch (W1-T182), mirroring `fetchAll`'s role
     *  for PRs. Tests inject a fixture array or a throwing fake to prove the escalation join is O(1) and
     *  fails closed on a read error, without shelling out. */
    fetchAllIssues?: () => BatchedIssue[];
    /** PACES this gateway's two REST reads against the daemon's OTHER burst call site (W1-T468) — see
     *  lib/open-prs-rest.ts for why one shared instance prevents the collision. An explicit value always wins.
     *  OMITTED ⇒ W1-T1005's {@link defaultGhCallPacer}: not a fresh pacer per construction, which would leave
     *  polite gateways colliding at second zero, and not the old unpaced no-op. */
    pacer?: GhCallPacer;
    /**
     * W1-T2323 OPTION C — THE MERGED HALF'S OWN CLOCK, separate from `ttlMs`, which now governs the OPEN half
     * alone. DEFAULTS TO `ttlMs`, DELIBERATELY, AND THE DEFAULT IS THE ARGUMENT: MEASURED, full walks come from
     * COLD gateways with no cache to expire, not from TTL expiry on warm ones. THE WIN IS LAZINESS, NOT LENGTH
     * — the merged half is no longer fetched by a consumer wanting open rows.
     */
    mergedTtlMs?: number;
    /** W1-T2440: which binary the WORKER-based warm walk shells — `opts.exec`'s role for the synchronous
     *  path, but a path rather than a function, because `workerData` cannot carry a closure. A test points
     *  this at a real but fake executable to prove the worker path. */
    ghBin?: string;
    /** W1-T2440 TEST-ONLY SEAM: overrides the URL handed to `new Worker(...)`. Every REAL caller omits it,
     *  since the worker ALWAYS re-imports this exact module in production. It exists solely so a test can
     *  point a REAL `Worker` at a deliberately throwing script and observe the genuine error handling run
     *  against an ACTUAL crashed thread — the "prefer a real, fake seam over a mock" shape. */
    workerUrl?: string | URL;
  } = {},
): GitHub {
  const ttlMs = opts.ttlMs ?? 15_000;
  // W1-T2323: A CACHE MUST SERVE FOR AT LEAST AS LONG AS IT COST TO BUILD. The completion stamp was ALREADY
  // CORRECT and nothing asserted it; this task PINS it rather than rewriting it.
  //
  // WHAT IT DOES NOT BUY, SAID PLAINLY: the expensive walks are the FULL ones, and they come from COLD GATEWAY
  // INSTANCES, not from TTL expiry, so this DOES NOT REDUCE THAT COUNT. Reducing instance count is the larger
  // win and is NOT taken here.
  //
  // ONE FLOOR PER HALF, NOT ONE PER GATEWAY: a SHARED floor would let the merged walk's duration govern the
  // open clock. MEASURED it behaves identically today, but only because the open half refreshes first — a
  // coincidence of call order, written down nowhere. `ttlMs === 0` IS EXEMPT ON BOTH HALVES, being the suite's
  // never-cache idiom (#2998's carve-out). Why: the measured per-half walk costs are in
  // docs/forensics/status.md
  const mergedTtlMs = opts.mergedTtlMs ?? ttlMs;
  let openFetchDurationMs = 0;
  let mergedFetchDurationMs = 0;
  const effectiveOpenTtlMs = (): number => (ttlMs === 0 ? 0 : Math.max(ttlMs, openFetchDurationMs));
  const effectiveMergedTtlMs = (): number => (mergedTtlMs === 0 ? 0 : Math.max(mergedTtlMs, mergedFetchDurationMs));
  // W1-T1005: an explicit `opts.pacer` always wins (design iii); omitted, every gateway built in this process
  // falls back to the SAME module-scoped instance, created once on whichever gateway needs it first, rather
  // than each discovering the secondary rate limit on its own.
  const pacer = opts.pacer ?? (defaultGhCallPacer ??= createGhCallPacer(isTestRunner() ? { sleepSync: () => {} } : {}));
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  // W1-T119: reflects only the MOST RECENT fetch attempt, reset every call, because this gateway
  // refreshes on its own cadence.
  /**
   * W1-T2323: PER HALF, because the halves attempt independently and a single pair of flags would let the
   * second attempt ERASE the first one's verdict — an open-half outage masked by a merged-half success is
   * the "GitHub says zero PRs" reading W1-T181 prevents, arriving by a new route. `readFailed()` reports
   * their OR, strictly no weaker than the single flag it replaces.
   */
  interface FetchOutcome {
    failed: boolean;
    reason: GhFailureReason | undefined;
  }
  let openOutcome: FetchOutcome | undefined;
  let mergedOutcome: FetchOutcome | undefined;
  let fetchInFlight = false;
  // W1-T2440: true from the moment `runPrewarmWorker` spawns a worker for this channel until its result,
  // success or failure, is applied. The row readers check these FIRST, so a request arriving mid-warm is served
  // the existing cache instead of racing the worker with a second, synchronous fetch on this thread.
  let openWarmInFlight = false;
  let mergedWarmInFlight = false;
  let issuesWarmInFlight = false;
  /** The one background walk this gateway ever has in flight at a time (W1-T2440) — a second
   *  `warm()` call while this is set is a no-op, exactly like the existing "within TTL" no-op
   *  the synchronous path already has (status.test.ts's own W1-T154 fixture). */
  let prewarmWorker: Worker | undefined;
  const lastFetchFailed = (): boolean => (openOutcome?.failed ?? false) || (mergedOutcome?.failed ?? false);
  const lastFetchFailureReason = (): GhFailureReason | undefined =>
    (openOutcome?.failed ? openOutcome.reason : undefined) ?? (mergedOutcome?.failed ? mergedOutcome.reason : undefined);
  // W1-T2219: backs `readState()` — not attempted until the index first runs, in flight for the duration of one
  // attempt (observable only from a REENTRANT call, since the real default blocks the process), then mirroring
  // the failure flag. Unlike that flag, never forced true by an accessor: only an actual query or `warm()`
  // advances this.
  const fetchState = (): GhReadState => {
    if (fetchInFlight) return "in_flight";
    if (!openOutcome && !mergedOutcome) return "not_attempted";
    return lastFetchFailed() ? "failed" : "ok";
  };
  // W1-T415: set on every fetch this default performs; an INJECTED `opts.fetchAll` never touches it, leaving it
  // `false` — the omitted-means-false discipline the accessor documents. W1-T2323: retained PER HALF, since the
  // halves refresh on independent clocks and a later untruncated refresh of one must not clear a truncation the
  // other still carries. The accessor reports their OR.
  let lastOpenTruncated = false;
  let lastClosedTruncated = false;
  const lastFetchTruncated = (): boolean => lastOpenTruncated || lastClosedTruncated;
  const run =
    opts.exec ??
    // 3rd fd is `pipe` (W1-T119), not `ignore` — the stderr-capture fix, so this gateway's failure reason is
    // real rather than always "unknown". maxBuffer is 64 MiB (W1-T181), and `timeout` bounds the call the
    // 2026-08-13 hour-long sweep was parked on. W1-T2440: the binary comes from `opts.ghBin`, since this
    // closure is EVERY synchronous call made OUTSIDE the warm worker — a test that sets it must get the SAME
    // fake binary here, or a read landing between warms reaches the real one.
    ((args: string[]) =>
      execFileSync(opts.ghBin ?? "gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26, timeout: GH_CALL_TIMEOUT_MS }));
  // W1-T265: the cross-refresh row cache the REST delta stops against, held at gateway scope rather than inside
  // the index builder, which deliberately replaces its cache with an EMPTY one on a failed fetch (the W1-T181
  // pairing) — reusing that as the delta base would turn one transient failure into a permanent cold re-walk.
  // W1-T2323: IN SPLIT MODE THIS HOLDS CLOSED ROWS ONLY, since the open pass is a COMPLETE read given no delta
  // base, so the stop test compares like with like.
  let knownBoardPrs: Map<number, BoardPrRest> | undefined;
  // W1-T2222: the issue fetch's OWN cross-refresh cache, same reasoning and same untouched-on-a-throw
  // discipline — an independent map, because the two deltas have independent row shapes and failure modes.
  let knownIssues: Map<number, BoardIssueRest> | undefined;
  /** W1-T413: per-URL changed-file memo for {@link GitHub.changedFiles}. `null` records a read
   *  that FAILED, so one unreachable PR is read once per gateway rather than once per task. */
  const changedFilesByUrl = new Map<string, string[] | null>();
  /**
   * W1-T914: per-URL memo for {@link GitHub.reviewState}, TTL-matched to the index's own clock for an OPEN row,
   * since that context is exactly the value this feature keeps LIVE.
   *
   * W1-T2217 tried memoising a terminal row forever; W1-T2235 found that memo UNREACHABLE for exactly those
   * rows, because the guard consulted the cached state only on a cache HIT, so a terminal row fell through to a
   * call keyed on a branch name GitHub deletes on merge — a 404 the catch never cached, so the row re-failed on
   * every paint. The fix: a MERGED or CLOSED row never reaches this cache at all.
   */
  const reviewStateCache = new Map<string, { at: number; state: "success" | "failure" | "pending" | "none" }>();
  /** ONE HALF OF THE BOARD, OVER REST — W1-T2323 option C's whole mechanism. The body is byte-for-byte what the
   *  single combined fetch always did, parameterised by WHICH half it walks. A gateway built with an injected
   *  `opts.fetchAll` never reaches it: the combined path calls that directly. Why: welded together,
   *  `listOpenHeadBranches` paid a 26-request closed walk for the 1 request it reads */
  const restFetchHalf = (half: BoardFetchHalf): BatchedPr[] => {
      // W1-T265: REST, not the CLI's all-states list verb, which is implemented over GraphQL and MEASURED at 12
      // GraphQL points and 2,888,862 bytes per call for this repo's 687 PRs — at a 15 s TTL, one console tab
      // drove ~58% of the account's whole GraphQL budget, and when it ran out merged-ness became underivable
      // and long-merged tasks stayed pinned at the head of UP NEXT. The three decoration fields still ride the
      // SAME fetch, so the O(1)-per-projection invariant is unchanged.
      let bytes = 0;
      const fetchJson = (args: string[]): unknown => {
        const raw = run(args);
        bytes += Buffer.byteLength(raw, "utf8");
        return JSON.parse(raw);
      };
      // W1-T2323: THE OPEN HALF IS GIVEN NO DELTA BASE AND WRITES NONE. It re-reads the open set completely
      // every call, so the rows it returns ARE the open set, and a PR that merged since is absent from GitHub's
      // answer rather than resurrected from a cache. Seeding it would be the bug: the closed pass is what used
      // to overwrite a just-merged row's open state, and here there is no closed pass.
      const known = half === "open" ? undefined : knownBoardPrs;
      const fetched = fetchBoardPrsRest(owner, repo, fetchJson, known, half);
      if (half !== "open") knownBoardPrs = new Map(fetched.rows.map((r) => [r.number, r]));
      // W1-T415: ledgered on every successful fetch and now RETAINED so `readTruncated()` can surface it — a
      // truncated view is a SUCCESS that still hit the page ceiling, distinct from a failure, which the catch
      // sets only on a THROW. W1-T2323: recorded against the half that produced it, so the OR keeps a live
      // truncation from either walk. Only the two real halves reach here, so a third arm would be dead code no
      // fixture could exercise — which coverage-ratchet caught.
      if (half === "open") lastOpenTruncated = fetched.truncated;
      else lastClosedTruncated = fetched.truncated;
      // W1-T181: log the payload size on every SUCCESSFUL fetch, so the next approach to whatever ceiling is
      // set above is observable in advance instead of arriving as a silent outage. The call count and mode are
      // W1-T265 additions — that change's whole claim is the count, so it is measured here.
      log("board_gateway.fetch_bytes", {
        bytes,
        restCalls: fetched.calls,
        mode: fetched.mode,
        truncated: fetched.truncated,
        // W1-T2323: WHICH HALF, in the ledger, so "did the split actually stop the daemon paying for the closed
        // walk" is a measurement over these rows rather than a claim. Before this task every row was implicitly
        // both.
        half: fetched.half,
      });
      return fetched.rows;
  };
  /** W1-T2323: TRUE ONLY WHEN THIS GATEWAY OWNS ITS OWN FETCHES. An injected `opts.fetchAll` returns the WHOLE
   *  board in one call and every fixture counts on it being called exactly once per refresh, so a gateway built
   *  with one keeps the single combined clock it has always had — calling an injected fetch twice to fill two
   *  halves would change what those fixtures measure without changing anything in production. Real gateways go
   *  down the split path. */
  const splitHalves = opts.fetchAll === undefined;

  // W1-T182: an INDEPENDENT batched fetch and cache pair for escalation issues, deliberately not folded into
  // the PR fetch — a PR-fetch outage and an issue-fetch outage are different failures with different classified
  // reasons, and the fail-closed escalation join needs its OWN signal. Scoped to the needs-human label, which
  // bounds WHICH issues are read but not how many: MEASURED 2026-08-24, that set is 523-524 rows (~3.04 MB).
  let lastIssueFetchFailed = false;
  let lastIssueFetchFailureReason: GhFailureReason | undefined;
  const fetchAllIssues =
    opts.fetchAllIssues ??
    (() => {
      // W1-T2222: REST, page-walked under this module's own control — never a paginating flag, which issues
      // every page inside one exec call and cannot be interrupted mid-walk — re-reading only what changed. The
      // delta cache carries the COLD PR half's proven stop test over rather than a second mechanism.
      let bytes = 0;
      const fetchJson = (args: string[]): unknown => {
        const raw = run(args);
        bytes += Buffer.byteLength(raw, "utf8");
        return JSON.parse(raw);
      };
      const fetched = fetchLabelledIssuesRest(owner, repo, NEEDS_HUMAN_LABEL, fetchJson, knownIssues);
      // Reassigned only on a SUCCESSFUL return, exactly like `knownBoardPrs` above — a throw skips this line,
      // so a transient failure leaves the previous complete snapshot intact and the NEXT successful call is
      // still a cheap delta.
      knownIssues = new Map(fetched.rows.map((r) => [r.number, r]));
      log("board_gateway.issue_fetch_bytes", {
        bytes,
        restCalls: fetched.calls,
        mode: fetched.mode,
        truncated: fetched.truncated,
      });
      return fetched.rows.map((r) => ({ number: r.number, url: r.url, state: r.state, title: r.title }));
    });

  interface IssueIndex {
    at: number;
    byUrl: Map<string, BatchedIssue>;
    byNum: Map<string, BatchedIssue>;
  }
  let issueCache: IssueIndex | undefined;
  const issueIndex = (): IssueIndex => {
    // W1-T2440: same reasoning as the row readers' own guards — a background worker already owns this refresh.
    // The fallback mirrors this function's own pre-first-fetch answer (empty maps), never a new "no issues"
    // fabrication: a caller reading through `issueByUrl` gets exactly today's cold-cache answer.
    if (issuesWarmInFlight) return issueCache ?? { at: 0, byUrl: new Map(), byNum: new Map() };
    if (!issueCache || now() - issueCache.at >= ttlMs) {
      let all: BatchedIssue[];
      try {
        // W1-T468/W1-T1005: waits its turn on the shared pacer — an explicit `opts.pacer`, or the module-scoped
        // default resolved above — BEFORE the real call, and reports back whether it was rate-limited. See the
        // `pacer` option's own doc.
        all = paceGhEntry(pacer, isGhRateLimitError, fetchAllIssues);
        lastIssueFetchFailed = false;
        lastIssueFetchFailureReason = undefined;
        log("board_gateway.issue_fetch_ok", { issueCount: all.length });
      } catch (err) {
        lastIssueFetchFailed = true;
        const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
        lastIssueFetchFailureReason = classifyGhFailure(e?.status, e?.stderr != null ? String(e.stderr) : undefined, e?.code);
        console.error(`board gateway: batched issue fetch failed (${lastIssueFetchFailureReason}): ${e?.message ?? String(err)}`);
        log("board_gateway.issue_fetch_failed", { reason: lastIssueFetchFailureReason, message: e?.message ?? String(err) });
        // A bare [] here is the SAME W1-T181 hazard as the PR fetch's, so it is paired with the issue-channel
        // failure flag: `issueReadFailed()` tells `resolveEscalation` this is a genuine outage, never a
        // confirmed "no such issues".
        all = [];
      }
      issueCache = {
        at: now(),
        byUrl: new Map(all.map((i) => [i.url, i])),
        byNum: new Map(all.map((i) => [String(i.number), i])),
      };
    }
    return issueCache;
  };
  // Flexible ref resolution — accepts a full issue URL OR a bare number, mirroring the PR lookup below, which
  // already accepts either shape. escalate.ts's ledger line always writes a full URL, but a caller resolving by
  // number should not silently miss.
  const lookupIssue = (ref: string): BatchedIssue | undefined => {
    const idx = issueIndex();
    return idx.byUrl.get(ref) ?? idx.byNum.get(ref) ?? idx.byNum.get(ref.replace(/^.*\/(\d+)$/, "$1"));
  };

  interface Index {
    at: number;
    byUrl: Map<string, BatchedPr>;
    byNum: Map<string, BatchedPr>;
    mergedNewestFirst: BatchedPr[];
    /** W1-T377: the OPEN slice of the SAME fetch, for `listOpenHeadBranches`. */
    openNewestFirst: BatchedPr[];
  }
  /** W1-T2323: one half's rows and the clock that governs THAT half, nothing else. */
  interface Half {
    at: number;
    rows: BatchedPr[];
  }
  let openHalf: Half | undefined;
  let mergedHalf: Half | undefined;
  let cache: Index | undefined;
  /** The two half-stamps `cache` was last composed from — a union rebuild is needed only when one
   *  of them moves, so a warm `index()` still costs no map construction at all. */
  let composedFrom: { open: number; merged: number } | undefined;
  /**
   * THE MEMO KEY, AND WHY IT IS NOT A TIMESTAMP. Keyed on millisecond readings, two refreshes completing inside
   * ONE millisecond made the key match and the index hand back the PREVIOUS union. Reachable, not theoretical:
   * a failed fetch empties both halves (the W1-T181 pairing), and the next SUCCESSFUL refresh often lands in
   * the same millisecond, so the gateway serves the EMPTY union while reporting healthy. A monotonic counter
   * per half cannot collide. Why: MEASURED at 8-14 failures per 60 attempts
   */
  let openEpoch = 0;
  let mergedEpoch = 0;

  /** ONE FETCH ATTEMPT, WITH ALL OF W1-T119/W1-T181/W1-T468/W1-T2219's HANDLING AROUND IT. Lifted VERBATIM out
   *  of the old index builder so both halves share exactly one classification, marking, pacing and logging path
   *  — a second copy is how a fail-closed contract rots. The flags keep their meaning of "the most recent
   *  attempt", now by EITHER half, deliberately the conservative reading. */
  const attemptFetch = (fetch: () => BatchedPr[], channel: "open" | "merged" | "both"): BatchedPr[] => {
      // #2998's start stamp, moved INTO the one shared attempt — there is no longer a single
      // `index()` guard to hang it off, and both halves must earn their own floor.
      const fetchStartedAt = now();
      const record = (outcome: FetchOutcome): void => {
        if (channel !== "merged") openOutcome = outcome;
        if (channel !== "open") mergedOutcome = outcome;
      };
      // W1-T181: the catch lives HERE, wrapping `fetchAll()` itself rather than only inside the default
      // implementation above, so an INJECTED `fetchAll` that throws is classified and marked exactly like a
      // real failure instead of propagating uncaught out of every GitHub method this gateway returns. Before
      // this fix a throwing injected fetch crashed the caller; only the default path degraded softly.
      let all: BatchedPr[];
      // W1-T2219: flips BEFORE the attempt so a REENTRANT `readState()` call from inside an injected `fetchAll`
      // observes "in_flight" rather than whatever the PREVIOUS attempt left behind — the exact discard
      // rationale (2)(b)/(3) names.
      fetchInFlight = true;
      try {
        // W1-T468: same shared-pacer guard as the issue fetch above — one pacer instance across BOTH of this
        // gateway's reads, and run-task.ts's sweep enumeration, is what keeps three independently-polite
        // callers from colliding at second zero.
        all = paceGhEntry(pacer, isGhRateLimitError, fetch);
        record({ failed: false, reason: undefined });
        log("board_gateway.fetch_ok", { prCount: all.length, channel });
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
        record({ failed: true, reason: classifyGhFailure(e?.status, e?.stderr != null ? String(e.stderr) : undefined, e?.code) });
        // LOUD (W1-T181 design (ii)/(v)): the pre-fix catch was silent for hours, with zero error lines,
        // because ENOBUFS classified "unknown" and nothing surfaced it. `console.error` guarantees this reaches
        // whatever log the process is redirected into even if a caller never wires `opts.log`; the injectable
        // log ALSO fires, so a caller with a ledger can key an alert off the classified reason without scraping
        // console output.
        console.error(`board gateway: batched PR fetch failed (${lastFetchFailureReason()}): ${e?.message ?? String(err)}`);
        log("board_gateway.fetch_failed", { reason: lastFetchFailureReason(), message: e?.message ?? String(err), channel });
        // W1-T181 design (v): a bare [] here is what converted "I could not read GitHub" into "GitHub says
        // there are zero PRs" — every task then silently derived not-merged from an outage that had nothing to
        // do with the repo's actual PRs. The [] below is now always PAIRED with the failure flags, which
        // `readFailed()`/`readFailureReason()` surface to `derivePrPrecedence`: a caller that consults those
        // BEFORE trusting an empty result sees a MARKED failure, never a bare absence — the signal W1-T179
        // consumes.
        all = [];
      } finally {
        fetchInFlight = false;
        // #2998, PER CHANNEL. Recorded on BOTH arms: a failed fetch blocked the loop just as long as a
        // successful one, so it earns the same floor. The completion stamp is unchanged. On the COMBINED path
        // both halves take the same value, because it really was one refresh.
        const elapsedMs = Math.max(0, now() - fetchStartedAt);
        if (channel !== "merged") openFetchDurationMs = elapsedMs;
        if (channel !== "open") mergedFetchDurationMs = elapsedMs;
      }
      return all;
  };

  /** THE OPEN HALF, ON `ttlMs` — W1-T2323. The rows come straight from GitHub's open-state query, so this is a
   *  COMPLETE answer, never a cache union: a PR that merged since is absent because GitHub does not return it.
   *  ON A FAILED FETCH THE HALF IS REPLACED WITH AN EMPTY ONE AND STAMPED (the W1-T181 pairing) — never handed
   *  out unpaired. */
  const openRows = (): BatchedPr[] => {
    if (!splitHalves) return bothHalves().open;
    // W1-T2440: a background worker already owns this channel's refresh, and serving the possibly stale,
    // possibly absent cache beats a SECOND synchronous walk racing it on THIS thread — which is exactly the
    // block this task removes, reintroduced one layer up. A caller that needs to tell "no PRs" from "not
    // fetched yet" already has `readState()`, which reports `"in_flight"` for the whole time this guard is
    // taken.
    if (openWarmInFlight) return openHalf?.rows ?? [];
    if (!openHalf || now() - openHalf.at >= effectiveOpenTtlMs()) {
      const previouslyOpen = openHalf ? new Set(openHalf.rows.map((p) => p.number)) : undefined;
      const fetched = attemptFetch(() => restFetchHalf("open"), "open");
      // STORED VERBATIM — these rows ARE GitHub's answer to the open-state query, and re-deciding their state
      // here would be a second, weaker opinion about a question the query already settled. The open filter
      // still exists in exactly the two places it always did, so both answers are computed from the same
      // predicate over the same rows as before this task.
      openHalf = { at: now(), rows: fetched };
      openEpoch += 1;
      // W1-T2323: WHAT SEPARATE CLOCKS COST, AND THE ONE LINE THAT PAYS MOST OF IT BACK. The merged half can
      // now be older, so the merged searches can answer "not merged" about a PR that has in fact merged — and
      // the consumer that acts on that decides a task's disposition, not a display.
      //
      // A PR IN THIS REPO ALWAYS MERGES OUT OF THE OPEN SET, so a successful open pass returning without a
      // number the previous one had IS the merge or close, observed. Expiring the merged clock here makes the
      // miss window ZERO for the case that actually happens. GUARDED ON A SUCCESSFUL FETCH, since treating a
      // failed pass's `[]` as "every open PR just merged" would be the W1-T181 hazard again.
      if (!lastFetchFailed() && previouslyOpen) {
        const stillOpen = new Set(openHalf.rows.map((p) => p.number));
        for (const number of previouslyOpen) {
          if (!stillOpen.has(number)) {
            mergedHalf = undefined;
            break;
          }
        }
      }
    }
    return openHalf.rows;
  };

  /**
   * THE MERGED/CLOSED HALF, ON `mergedTtlMs` — W1-T2323. STILL BUILT AND STILL SHARED: all three merged lookups
   * read off this one index, which is W1-T377's design, and its walk still stops on the delta boundary with the
   * same ceiling. The change is WHEN it is fetched: lazily, by a consumer that actually needs a merged row,
   * instead of by every consumer of any row at all.
   */
  const mergedRows = (): BatchedPr[] => {
    if (!splitHalves) return bothHalves().merged;
    // W1-T2440: same reasoning as `openRows`'s own guard immediately above — this channel's background worker
    // owns the refresh, so a query never starts a second one underneath it.
    if (mergedWarmInFlight) return mergedHalf?.rows ?? [];
    if (!mergedHalf || now() - mergedHalf.at >= effectiveMergedTtlMs()) {
      const fetched = attemptFetch(() => restFetchHalf("closed"), "merged");
      // Verbatim, same reasoning as the open half — `mergedNewestFirst`'s `state === "MERGED"`
      // filter is untouched and is still the only thing that decides merged-ness.
      mergedHalf = { at: now(), rows: fetched };
      mergedEpoch += 1;
    }
    return mergedHalf.rows;
  };

  /**
   * THE COMBINED PATH, for a gateway built with an injected `opts.fetchAll` — ONE call, ONE clock, both halves
   * stamped alike. The pre-split behaviour unchanged, and what every existing fixture runs, so "the split" is a
   * production behaviour rather than a rewrite of what the suite measures.
   */
  const bothHalves = (): { open: BatchedPr[]; merged: BatchedPr[] } => {
    if (!openHalf || !mergedHalf || now() - openHalf.at >= effectiveOpenTtlMs()) {
      // `bothHalves` is only ever reached through the two split-mode guards above, so `opts.fetchAll` is always
      // set on every path that lands here. The assertion states that invariant instead of carrying a fallback
      // that could never actually run — the dead branch coverage-ratchet flagged before this fix.
      const all = attemptFetch(opts.fetchAll as () => BatchedPr[], "both");
      const at = now();
      openHalf = { at, rows: all.filter((p) => p.state === "OPEN") };
      mergedHalf = { at, rows: all.filter((p) => p.state !== "OPEN") };
      openEpoch += 1;
      mergedEpoch += 1;
    }
    return { open: openHalf.rows, merged: mergedHalf.rows };
  };

  /** THE UNION, for every consumer that needs a row of any state. Forces BOTH halves, so none of them changes
   *  what it costs or sees. Only `listOpenHeadBranches` is routed away from here, being the one method whose
   *  answer is a function of the open half alone — and the one the dispatch path reads. */
  const index = (): Index => {
    // W1-T2323: ON THE COMBINED PATH THIS MUST BE ONE CALL, NOT TWO. Asking for each half in turn would enter
    // `bothHalves()` twice, and at `ttlMs: 0` — which several fixtures use to isolate pacer behaviour from
    // cache freshness — the second entry sees an already-stale stamp and fetches AGAIN, doubling the injected
    // fetch count, the pacer's retry budget and the ledger rows, none of which this task is entitled to change.
    const both = splitHalves ? undefined : bothHalves();
    const open = both ? both.open : openRows();
    const merged = both ? both.merged : mergedRows();
    // KEYED ON THE REFRESH COUNTERS, NEVER ON THE STAMPS — see `openEpoch`'s doc above for the same-millisecond
    // collision that made this memo serve an empty union with a healthy label.
    const openAt = openEpoch;
    const mergedAt = mergedEpoch;
    if (!cache || composedFrom?.open !== openAt || composedFrom?.merged !== mergedAt) {
      // MERGED LAST, so a row present in both halves (one open pass behind a merge the closed
      // pass has already picked up) resolves to its TERMINAL state, never the stale open one.
      const all = [...new Map([...open, ...merged].map((p) => [p.number, p])).values()];
      cache = {
        // The union is only as fresh as its OLDER half — reported honestly rather than as the
        // newer stamp, which would claim a currency the merged rows do not have.
        at: Math.min(openHalf?.at ?? 0, mergedHalf?.at ?? 0),
        byUrl: new Map(all.map((p) => [p.url, p])),
        byNum: new Map(all.map((p) => [String(p.number), p])),
        // Higher PR number = more recent; mirrors ghGateway's search "newest first".
        mergedNewestFirst: all.filter((p) => p.state === "MERGED").sort((a, b) => b.number - a.number),
        openNewestFirst: all.filter((p) => p.state === "OPEN").sort((a, b) => b.number - a.number),
      };
      composedFrom = { open: openAt, merged: mergedAt };
    }
    return cache;
  };

  /**
   * R-24 — THE PER-TICK VERDICT RESET. See {@link GitHub.resetFailureFlags} for the contract.
   *
   * PER HALF, mirroring the outcome split (W1-T2323): a half whose last attempt SUCCEEDED keeps verdict and
   * rows, so a reset never costs a re-fetch it did not have to pay, while a FAILED half loses both together —
   * the verdict AND the stamped EMPTY half it is the only safe pairing for. Dropping one without the other is
   * the W1-T181 hazard in reverse.
   *
   * The delta caches are DELIBERATELY UNTOUCHED: they are the reason a caller holds one gateway across ticks,
   * and clearing them would convert recovery into the cold walk this exists to stop.
   */
  const resetFailureFlags = (): void => {
    if (openOutcome?.failed) {
      openOutcome = undefined;
      openHalf = undefined;
    }
    if (mergedOutcome?.failed) {
      mergedOutcome = undefined;
      mergedHalf = undefined;
    }
    if (lastIssueFetchFailed) {
      lastIssueFetchFailed = false;
      lastIssueFetchFailureReason = undefined;
      issueCache = undefined;
    }
  };

  // W1-T2392: `body` rides along for the prose index — already on the row, no extra fetch.
  const asRef = (p: BatchedPr): PrRef => ({
    number: p.number,
    url: p.url,
    state: p.state,
    title: p.title,
    headRefName: p.headRefName,
    ...(p.headRefOid ? { headRefOid: p.headRefOid } : {}),
    body: p.body,
  });
  // W1-T2387 — the COMMIT surface, memoized and lazy; mirrors {@link ghGateway}'s own fallback exactly, same
  // doc and same precedence. Built at most ONCE per gateway instance and only after a task has actually missed
  // on the body index, so a board whose PRs all carry the body trailer never shells out. Deliberately NOT TTL'd
  // alongside the body halves: commits are append-only, so a stale index can only LACK a very recent merge,
  // which is the case the body index answers.
  let commitIndex: Map<string, PrRef[]> | null | undefined;
  const commitTrailerFallback = (taskId: string): PrRef[] => {
    if (commitIndex === undefined) {
      commitIndex = (opts.commitTrailerIndex ?? buildCommitTrailerIndex({ slug: `${owner}/${repo}` }))();
    }
    return commitIndex?.get(taskId) ?? [];
  };
  // W1-T2387: the re-verify half, over the SAME memoised index — never a second `git` call.
  const commitCreditsFor = (taskId: string, prUrl: string): boolean =>
    commitTrailerFallback(taskId).some((r) => r.url === prUrl);
  const lookup = (ref: string | number): BatchedPr | undefined => {
    const idx = index();
    const s = String(ref);
    return idx.byUrl.get(s) ?? idx.byNum.get(s) ?? idx.byNum.get(s.replace(/^.*\/(\d+)$/, "$1"));
  };

  // ── W1-T2440 — APPLYING A WORKER'S RESULT, ON THIS THREAD ──────────────────────────────────
  // These three mirror the synchronous success and failure bookkeeping exactly — same fields, same log
  // events, same W1-T119/W1-T181 discipline. They exist because a worker's result arrives on a MESSAGE,
  // not a return value, so there is no call site left to wrap. Only WHEN it runs changes.
  const applyOpenOutcome = (outcome: PrewarmChannelOutcome<BoardPrRest>, elapsedMs: number, previouslyOpen: Set<number> | undefined): void => {
    openFetchDurationMs = elapsedMs;
    if (!outcome.ok) {
      openOutcome = { failed: true, reason: outcome.reason };
      console.error(`board gateway: batched PR fetch failed (${outcome.reason}): ${outcome.message}`);
      log("board_gateway.fetch_failed", { reason: outcome.reason, message: outcome.message, channel: "open" });
      return;
    }
    openOutcome = { failed: false, reason: undefined };
    openHalf = { at: now(), rows: outcome.rows };
    openEpoch += 1;
    lastOpenTruncated = outcome.truncated;
    log("board_gateway.fetch_ok", { prCount: outcome.rows.length, channel: "open" });
    log("board_gateway.fetch_bytes", { bytes: outcome.bytes, restCalls: outcome.calls, mode: outcome.mode, truncated: outcome.truncated, half: "open" });
    // W1-T2323's own cross-half invalidation, replayed here verbatim for the async path — see `openRows`'s doc
    // for why a PR leaving the open set is the merge or close itself, observed, and must not wait out
    // `mergedTtlMs`.
    if (previouslyOpen) {
      const stillOpen = new Set(outcome.rows.map((p) => p.number));
      for (const number of previouslyOpen) {
        if (!stillOpen.has(number)) {
          mergedHalf = undefined;
          break;
        }
      }
    }
  };
  const applyMergedOutcome = (outcome: PrewarmChannelOutcome<BoardPrRest>, elapsedMs: number): void => {
    mergedFetchDurationMs = elapsedMs;
    if (!outcome.ok) {
      mergedOutcome = { failed: true, reason: outcome.reason };
      console.error(`board gateway: batched PR fetch failed (${outcome.reason}): ${outcome.message}`);
      log("board_gateway.fetch_failed", { reason: outcome.reason, message: outcome.message, channel: "merged" });
      return;
    }
    mergedOutcome = { failed: false, reason: undefined };
    mergedHalf = { at: now(), rows: outcome.rows };
    mergedEpoch += 1;
    lastClosedTruncated = outcome.truncated;
    knownBoardPrs = new Map(outcome.rows.map((r) => [r.number, r]));
    log("board_gateway.fetch_ok", { prCount: outcome.rows.length, channel: "merged" });
    log("board_gateway.fetch_bytes", { bytes: outcome.bytes, restCalls: outcome.calls, mode: outcome.mode, truncated: outcome.truncated, half: "closed" });
  };
  const applyIssuesOutcome = (outcome: PrewarmChannelOutcome<BoardIssueRest>): void => {
    if (!outcome.ok) {
      lastIssueFetchFailed = true;
      lastIssueFetchFailureReason = outcome.reason;
      console.error(`board gateway: batched issue fetch failed (${outcome.reason}): ${outcome.message}`);
      log("board_gateway.issue_fetch_failed", { reason: outcome.reason, message: outcome.message });
      return;
    }
    knownIssues = new Map(outcome.rows.map((r) => [r.number, r]));
    const all: BatchedIssue[] = outcome.rows.map((r) => ({ number: r.number, url: r.url, state: r.state, title: r.title }));
    issueCache = { at: now(), byUrl: new Map(all.map((i) => [i.url, i])), byNum: new Map(all.map((i) => [String(i.number), i])) };
    lastIssueFetchFailed = false;
    lastIssueFetchFailureReason = undefined;
    log("board_gateway.issue_fetch_ok", { issueCount: all.length });
  };

  /** W1-T2440 — `warm()`'S REAL-DEFAULT PATH. See the module-scope doc above {@link BOARD_PREWARM_WORKER_KIND}
   *  for why a `Worker` rather than an async rewrite. Computes "is a refresh due" per channel EXACTLY as the
   *  three read paths do, so a `warm()` faster than the TTL is still a no-op, and at most ONE worker is ever in
   *  flight. */
  const runPrewarmWorker = (): void => {
    if (prewarmWorker) return;
    const fetchOpen = !openHalf || now() - openHalf.at >= effectiveOpenTtlMs();
    const fetchMerged = !mergedHalf || now() - mergedHalf.at >= effectiveMergedTtlMs();
    const fetchIssues = !issueCache || now() - issueCache.at >= ttlMs;
    if (!fetchOpen && !fetchMerged && !fetchIssues) return;
    // Captured BEFORE the walk starts, exactly like `openRows`'s own snapshot — the set this compares against
    // must be the pre-refresh one, not whatever the half becomes by the time the worker's message arrives.
    const previouslyOpen = fetchOpen && openHalf ? new Set(openHalf.rows.map((p) => p.number)) : undefined;
    const startedAt = now();
    if (fetchOpen) openWarmInFlight = true;
    if (fetchMerged) mergedWarmInFlight = true;
    if (fetchIssues) issuesWarmInFlight = true;
    fetchInFlight = true;
    const finish = (): void => {
      prewarmWorker = undefined;
      openWarmInFlight = false;
      mergedWarmInFlight = false;
      issuesWarmInFlight = false;
      fetchInFlight = false;
    };
    const req: PrewarmWorkerRequest = {
      kind: BOARD_PREWARM_WORKER_KIND,
      owner,
      repo,
      ghBin: opts.ghBin ?? "gh",
      fetchOpen,
      fetchMerged,
      fetchIssues,
      knownBoardPrs,
      knownIssues,
    };
    let worker: Worker;
    try {
      worker = new Worker(opts.workerUrl ?? new URL(import.meta.url), { workerData: req, execArgv: process.execArgv });
    } catch (err) {
      // Spawning itself failed (e.g. no worker_threads support) — fall back to running the SAME channel walk
      // synchronously on THIS thread, applied through the SAME bookkeeping a landed message uses, rather than
      // the unrelated index builders. The ONE place this fix degrades to a blocking call on the request-serving
      // thread, and even degraded it stays binary-aware.
      finish();
      console.error(`board gateway: prewarm worker spawn failed, falling back to a synchronous walk: ${err instanceof Error ? err.message : String(err)}`);
      const elapsedMs = Math.max(0, now() - startedAt);
      const response = runPrewarmChannelsSync(req);
      if (response.open) applyOpenOutcome(response.open, elapsedMs, previouslyOpen);
      if (response.merged) applyMergedOutcome(response.merged, elapsedMs);
      if (response.issues) applyIssuesOutcome(response.issues);
      return;
    }
    prewarmWorker = worker;
    // EVERY TERMINAL PATH MUST REACH `finish()` EXACTLY ONCE, AND `exit` IS A TERMINAL PATH. `message` and
    // `error` are not exhaustive — an in-worker exit emits neither — and before this guard that left the handle
    // SET, so every LATER warm became a permanent no-op while the in-flight flags stayed true and the board
    // never refreshed again short of a restart. The once-only latch is not three independent handlers, because
    // `error` and `exit` BOTH fire for a crashed worker.
    let settled = false;
    const settle = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      apply();
      finish();
    };
    worker.once("exit", (code) => {
      settle(() => {
        const elapsedMs = Math.max(0, now() - startedAt);
        const failure = {
          ok: false as const,
          reason: "unknown" as GhFailureReason,
          message: `prewarm worker exited with code ${code} before reporting`,
        };
        if (fetchOpen) applyOpenOutcome(failure, elapsedMs, previouslyOpen);
        if (fetchMerged) applyMergedOutcome(failure, elapsedMs);
        if (fetchIssues) applyIssuesOutcome(failure);
      });
    });
    worker.once("message", (msg: PrewarmWorkerResponse) => {
      settle(() => {
        const elapsedMs = Math.max(0, now() - startedAt);
        if (msg.open) applyOpenOutcome(msg.open, elapsedMs, previouslyOpen);
        if (msg.merged) applyMergedOutcome(msg.merged, elapsedMs);
        if (msg.issues) applyIssuesOutcome(msg.issues);
      });
      void worker.terminate();
    });
    worker.once("error", (err) => {
      // The worker itself died — never a per-channel classified failure, which arrives via a normal message —
      // so every channel THIS call asked for is marked failed, the same "loud, classified, never silent"
      // discipline W1-T181 established for the synchronous path.
      settle(() => {
        const elapsedMs = Math.max(0, now() - startedAt);
        const failure = { ok: false as const, reason: "unknown" as GhFailureReason, message: err instanceof Error ? err.message : String(err) };
        if (fetchOpen) applyOpenOutcome(failure, elapsedMs, previouslyOpen);
        if (fetchMerged) applyMergedOutcome(failure, elapsedMs);
        if (fetchIssues) applyIssuesOutcome(failure);
      });
    });
  };

  return {
    prByRef(ref) {
      const p = lookup(ref);
      return p && typeof p.number === "number" ? asRef(p) : null;
    },
    findMergedByTrailer(taskId) {
      const anchored = new RegExp(`^Remudero-Task:\\s*${escapeRegExp(taskId)}\\s*$`, "m");
      const hit = index().mergedNewestFirst.find((p) => anchored.test(p.body ?? ""));
      if (hit) return asRef(hit);
      // W1-T2387: THIS is the gateway `resolveAlreadySatisfied` actually builds, so the union has to live here
      // as well as on {@link ghGateway} or the fix ships unwired. Body first; a FAILED fetch still reports as a
      // failure rather than falling through to local evidence.
      if (lastFetchFailed()) return null;
      return commitTrailerFallback(taskId)[0] ?? null;
    },
    findMergedByTrailerAll(taskId) {
      // W1-T441: NO ADDITIONAL FETCH. The merged index already carries every merged PR's body from the ONE
      // batched read, so returning every anchored match is a filter over data in hand — the same lookup this
      // gateway already ran, widened. null on a fetch failure (W1-T119), never [] — the failure/absence
      // distinction.
      const anchored = new RegExp(`^Remudero-Task:\\s*${escapeRegExp(taskId)}\\s*$`, "m");
      if (lastFetchFailed()) return null;
      const byBody = index().mergedNewestFirst.filter((p) => anchored.test(p.body ?? "")).map(asRef);
      // W1-T2387: union, body-first — see the sibling above.
      return byBody.length > 0 ? byBody : commitTrailerFallback(taskId);
    },
    findMergedByHeadBranch(taskId) {
      // W1-T257: client-side head-ref match from the SAME single fetch — zero extra calls, and on the
      // STRUCTURED head ref, never the body index. null on a fetch failure (W1-T119).
      const idx = index();
      return lastFetchFailed() ? null : idx.mergedNewestFirst.filter((p) => ownsBranch(p.headRefName, taskId)).map(asRef);
    },
    listMergedHeadBranches() {
      // W1-T257: every merged PR, with its head ref, from the ONE fetch — projectPlan groups by
      // `run-<taskId>-*` client-side. null on a fetch failure (W1-T119), never [].
      const idx = index();
      return lastFetchFailed() ? null : idx.mergedNewestFirst.map(asRef);
    },
    listOpenHeadBranches() {
      // W1-T377: ZERO extra calls beyond the one this half costs, with the same null-on-failure contract as the
      // merged twin. W1-T2323: THE OPEN HALF ONLY — the single behavioural change to a public method. MEASURED,
      // a cold gateway answering this walked 26 REST requests over 22.2 s for 6 open rows; it now walks 1
      // request over 432 ms. THE VALUE IS UNCHANGED, not merely similar: the rows come from GitHub's own
      // open-state query rather than from filtering an all-states fetch.
      const open = openRows();
      return lastFetchFailed()
        ? null
        : open
            .filter((p) => p.state === "OPEN")
            .sort((a, b) => b.number - a.number)
            .map(asRef);
    },
    headRefName(prUrl) {
      return index().byUrl.get(prUrl)?.headRefName;
    },
    prBody(prUrl) {
      return index().byUrl.get(prUrl)?.body;
    },
    // W1-T2387: the union's second anchored surface, for `creditsByAnchoredTrailer`'s re-verify.
    creditedByCommitTrailer(taskId, prUrl) {
      return commitCreditsFor(taskId, prUrl);
    },
    changedFiles(prUrl) {
      // W1-T413, AND THE O(N) QUESTION ANSWERED RATHER THAN DODGED. The batched fetch is the REST PR *list*,
      // and that endpoint does not carry changed files at any page size, so this cannot ride the one fetch the
      // way body, head ref and title do. WHY IT IS STILL NOT THE RETRO'S DEFECT: it is O(1) per PR that
      // actually reaches the refusal, MEMOISED for the gateway's lifetime, and pre-filtered by the free
      // own-run-branch test — so a projection pays nothing for every ordinary implementation.
      const cached = changedFilesByUrl.get(prUrl);
      if (cached !== undefined) return cached ?? undefined;
      const number = prUrl.match(/\/pull\/(\d+)/)?.[1];
      if (!number) return undefined;
      let paths: string[] | undefined;
      try {
        const raw = run(["api", "--paginate", `repos/${owner}/${repo}/pulls/${number}/files`, "--jq", ".[].filename"]);
        const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
        paths = lines.length > 0 ? lines : undefined;
      } catch {
        paths = undefined; // UNAVAILABLE — the caller keeps today's answer, never withdraws a credit.
      }
      // Cache the failure too, as null, so one unreachable PR cannot be re-read once per task in the same
      // projection — the exact multiplication this method exists to avoid.
      changedFilesByUrl.set(prUrl, paths ?? null);
      return paths;
    },
    autoMergeArmed(prUrl) {
      return index().byUrl.get(prUrl)?.autoMergeRequest != null;
    },
    reviewState(prUrl) {
      // W1-T914: the console's three-state read, over the SAME combined-status endpoint open-prs-rest.ts
      // documents — never a second, independently-shaped call. Keyed off the PR's own head BRANCH NAME, already
      // on this batched index at zero cost, rather than its sha: the endpoint accepts any git ref, and this
      // gateway never fetches a head oid at all.
      const entry = index().byUrl.get(prUrl);
      if (!entry) return undefined; // this prUrl isn't in the current index -> undetermined
      // W1-T2235: a MERGED or CLOSED row has NO live check state to show, full stop — checked FIRST, ahead of
      // any cache lookup and any call, never as a modifier on a cache hit the row can never reach. That
      // ordering was the whole defect: the head ref is a branch name GitHub deletes on merge, so the call below
      // 404s for every terminal row, and the catch caches nothing, so the row re-failed on every paint forever.
      // The correct answer is that the field does not apply, and the state is already here.
      if (entry.state !== "OPEN") return "not-applicable";
      const headRef = entry.headRefName;
      if (!headRef) return undefined; // open PR with no resolvable head ref -> undetermined
      const cached = reviewStateCache.get(prUrl);
      if (cached && now() - cached.at < ttlMs) return cached.state;
      try {
        const raw = JSON.parse(run(combinedStatusRestArgs(owner, repo, headRef))) as {
          statuses?: Array<{ context?: string; state?: string }>;
        };
        // Only a REAL status row becomes an entry — the endpoint's top-level state is a roll-up-of-a-rollup
        // that reports pending for a commit with zero statuses, and synthesising from it would invent a pending
        // review GitHub never posted.
        const entry = (raw.statuses ?? []).find((s) => s.context === REVIEW_STATUS_CONTEXT);
        const raw_state = (entry?.state ?? "").toLowerCase();
        const state: "success" | "failure" | "pending" | "none" = !entry
          ? "none"
          : raw_state === "success"
            ? "success"
            : raw_state === "failure" || raw_state === "error"
              ? "failure"
              : "pending";
        reviewStateCache.set(prUrl, { at: now(), state });
        return state;
      } catch {
        return undefined; // UNREADABLE — board.ts marks the row explicitly, never guesses "none".
      }
    },
    issueByUrl(url) {
      const i = lookupIssue(url);
      return i ? { state: i.state, title: i.title } : null;
    },
    // W1-T154: forces a fetch NOW. Boot calls this once with an empty cache, and a background timer paced to
    // `ttlMs` calls it again every tick — by construction the cache is always at or past its TTL when that
    // fires, so no separate force branch is needed. W1-T182: warms the issue index on the same cadence.
    // W1-T2440: an INJECTED gateway keeps calling the index builders directly and SYNCHRONOUSLY, since a
    // `Worker` cannot receive a closure; the real, unconfigured default takes `runPrewarmWorker`.
    warm() {
      if (opts.exec || opts.fetchAll || opts.fetchAllIssues) {
        index();
        issueIndex();
        return;
      }
      runPrewarmWorker();
    },
    // W1-T2219: these accessors no longer force a fetch. Pre-fix, EITHER alone did, so asking "did the read
    // fail" PERFORMED the read and blocked the caller while reporting the PREVIOUS attempt's verdict
    // throughout. Every real caller reaches these AFTER a query method that fetches, so the reported verdict is
    // UNCHANGED; only a caller that asks FIRST changes, and it now gets the honest "not attempted" reading
    // rather than a forced, blocking fetch.
    readFailed() {
      return lastFetchFailed();
    },
    readFailureReason() {
      return lastFetchFailureReason();
    },
    readState() {
      return fetchState();
    },
    readTruncated() {
      // Same force-a-fetch-first shape `readFailed()` used to have (W1-T415, unchanged here — `readTruncated()`
      // is a distinct, THIRD signal this task does not touch): a caller that asks this FIRST, never preceded by
      // another method call, still reports accurately instead of trivially returning the initial `false`.
      index();
      return lastFetchTruncated();
    },
    // R-24: NEVER forces a fetch and performs no I/O — the whole point is that a caller can call
    // it at the top of every tick for free. See `resetFailureFlags`'s own doc above.
    resetFailureFlags() {
      resetFailureFlags();
    },
    issueReadFailed() {
      issueIndex();
      return lastIssueFetchFailed;
    },
    // W1-T2219: closes rationale (2)(c) — the issue-channel failure reason was already classified and logged
    // but had no accessor, so it was reachable only by reading the ledger, never by a caller. Non-forcing, like
    // `readFailureReason()` above: a caller consults this only after `issueReadFailed()`, which already forces
    // the issue index, is `true`.
    issueReadFailureReason() {
      return lastIssueFetchFailureReason;
    },
  };
}

// ── W1-T2392 — A BUILD THAT MERGED WITH NO CREDIT ON ANY SURFACE ─────────────────────────────

/** W1-T2392 — WHAT A MERGED, UNCREDITED BUILD LOOKS LIKE ONCE SOMEONE NOTICES. A REPORT, NEVER A CREDIT (the
 *  shard's Q2): carrying this changes no merge state, no dispatch decision and no disposition. Crediting from
 *  prose would be the over-crediting W1-T2387 was required to rule out — a task credited wrongly is never built
 *  at all, which is strictly worse than one built twice. */
export interface UncreditedBuildWarning {
  /** The merged PR that names this task in its own prose. */
  prNumber: number;
  prUrl: string;
  /** Which prose surface carried the id. Measured at head: 5 of 19 name it in the title and 14
   *  only in the body, so a title-only reader would have missed the instance this exists for. */
  namedIn: "title" | "body";
}

/** W1-T2392: the anchored id form, using an explicit digit class so `W1-T239` never matches a
 *  mention of `W1-T2392`. Built per lookup rather than per candidate — see
 *  {@link indexProseNamedTaskIds} for why the scan is inverted. */
function proseNamesTaskId(text: string | undefined, taskId: string): boolean {
  if (!text) return false;
  const at = text.indexOf(taskId);
  if (at < 0) return false;
  return new RegExp(`${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^0-9]|$)`).test(text);
}

/**
 * W1-T2392 — THE SCAN IS INVERTED, AND THAT IS A COST DECISION RATHER THAN A STYLE ONE. The naive shape asks,
 * per task, "does any merged PR name me?" — roughly 2,400 merged PRs times roughly 900 plan tasks over
 * multi-kilobyte bodies, tens of gigabytes per projection. So this walks the merged set ONCE. Titles and bodies
 * are both read because the measurement says so: of the 19 uncredited builds naming an id at head, only 5 name
 * it in the TITLE.
 */
export function indexProseNamedTaskIds(prs: readonly PrRef[]): Map<string, UncreditedBuildWarning[]> {
  const ID = /W1-T[0-9]+/g;
  const out = new Map<string, UncreditedBuildWarning[]>();
  for (const pr of prs) {
    const seen = new Map<string, "title" | "body">();
    for (const m of (pr.title ?? "").matchAll(ID)) seen.set(m[0], "title");
    for (const m of (pr.body ?? "").matchAll(ID)) if (!seen.has(m[0])) seen.set(m[0], "body");
    for (const [id, where] of seen) {
      // Re-assert ANCHORED, because the cheap global scan above matches a prefix: `W1-T239` would otherwise be
      // credited a mention of `W1-T2392`.
      const text = where === "title" ? pr.title : pr.body;
      if (!proseNamesTaskId(text, id)) continue;
      const arr = out.get(id) ?? [];
      arr.push({ prNumber: pr.number, prUrl: pr.url, namedIn: where });
      out.set(id, arr);
    }
  }
  return out;
}

/**
 * W1-T2392 — DOES THIS TASK HAVE A MERGED BUILD NOBODY CREDITED? THE CREDIT CHECK IS NOT RE-IMPLEMENTED HERE:
 * this is only consulted on a projection that is NOT merged, and "not merged" already means all three paths
 * came back empty, so no fourth path is built.
 *
 * THE PLAN-ONLY REFUSAL IS LOAD-BEARING, not hygiene: the largest naming population is shard FILINGS, whose
 * titles name their own id by convention, so without it every filed task would warn about the PR that filed it.
 * It fails OPEN, exactly as rung (c)'s own plan-only refusal does (W1-T413).
 */
export function uncreditedBuildWarning(
  taskId: string,
  named: Map<string, UncreditedBuildWarning[]> | undefined,
  changedFiles: ((prUrl: string) => string[] | undefined) | undefined,
): UncreditedBuildWarning | undefined {
  const candidates = named?.get(taskId);
  if (!candidates || candidates.length === 0) return undefined;
  if (!changedFiles) return undefined; // no way to tell a build from a filing — say nothing
  for (const c of candidates) {
    const files = changedFiles(c.prUrl);
    if (files === undefined) continue; // unreadable — fail OPEN, never fabricate
    if (files.some((f) => f.startsWith("src/") && !f.endsWith(".test.ts"))) return c;
  }
  return undefined;
}

// ── W1-T2397 — AN OPEN, UNMERGED BUILD OF THIS TASK, OBSERVED AND NEVER ACTED ON ─────────────

/**
 * W1-T2397 — WHAT AN OPEN SIBLING BUILD LOOKS LIKE, AND WHY IT IS ONLY EVER A REPORT.
 *
 * THE ASYMMETRY THIS NAMES: the eligibility check already sees open PRs but attributes them by {@link
 * ownsBranch} alone — ONE surface, where the merged side now has three — so an operator-briefed build on a
 * `fix/` branch is invisible and the task is dispatched again.
 *
 * A WARN, AND THE MEASUREMENT IS WHY: the naive predicate fired four times in 72 hours and THREE OF THOSE
 * MERGED, and no staleness bound rescues it, since a threshold must sit near EIGHT HOURS before it stops firing
 * on healthy work. A warn that is wrong costs one line. IT MUST NEVER FEED THE ELIGIBILITY SIGNAL. Why: the
 * time-to-merge distribution is in docs/forensics/status.md
 */
export interface OpenSiblingBuild {
  prNumber: number;
  prUrl: string;
  headRefName?: string;
  /** The declared paths this open PR touches — the discriminator, not the prose. */
  overlappingPaths: string[];
}

/**
 * W1-T2397 — IS THERE AN OPEN PR BUILDING THIS TASK THAT IS NOT ITS OWN RUN BRANCH?
 *
 * FILE OVERLAP IS THE SIGNAL, NOT THE PROSE, and that is what makes it quiet: of the four naive firings, two
 * siblings were plan FILINGS and two were builds of DIFFERENT tasks mentioning the id in passing, and requiring
 * a path in the dispatched task's own declared `files:` drops both classes by construction. THE TASK'S OWN RUN
 * BRANCH IS EXCLUDED. `changedFiles` UNREADABLE ⇒ NO OBSERVATION, never a guess.
 */
export function openSiblingBuild(
  taskId: string,
  declaredFiles: readonly string[] | undefined,
  openPrs: readonly PrRef[] | null | undefined,
  changedFiles: ((prUrl: string) => string[] | undefined) | undefined,
): OpenSiblingBuild | undefined {
  if (!declaredFiles || declaredFiles.length === 0) return undefined;
  if (!openPrs || openPrs.length === 0) return undefined;
  if (!changedFiles) return undefined;
  const declared = new Set(declaredFiles);
  // Newest first: a task with two open builds already has the problem this reports, and the newest is the one
  // still moving. Mirrors `corroborateOpenByBranch`'s own tiebreak rather than inventing one.
  for (const pr of [...openPrs].sort((a, b) => b.number - a.number)) {
    if (pr.state.toUpperCase() !== "OPEN") continue;
    if (ownsBranch(pr.headRefName, taskId)) continue; // the in-flight case `isOpenPr` already owns
    const files = changedFiles(pr.url);
    if (files === undefined) continue; // unreadable — never a guess
    const overlappingPaths = files.filter((f) => declared.has(f));
    if (overlappingPaths.length === 0) continue;
    return { prNumber: pr.number, prUrl: pr.url, headRefName: pr.headRefName, overlappingPaths };
  }
  return undefined;
}
