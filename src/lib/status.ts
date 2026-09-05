import { execFileSync } from "node:child_process";
// W1-T2440: the board pre-warm's walk moves onto a separate OS thread (see `runPrewarmWorker`,
// `buildBatchedGithub`'s own doc) so `execFileSync` below can keep being genuinely synchronous
// without parking the process that serves `/v1/status` while a scheduled warm runs. This is the
// SAME module, loaded a second time in worker mode — `isMainThread`/`workerData` gate the
// worker-only branch near `buildBatchedGithub`, never executed when this file loads normally.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
// Imported as the module's DEFAULT export (a plain, mutable object), not as named
// bindings (`import { existsSync } from "node:fs"`) — deliberately, and load-bearing
// for W1-T115's "assert via injected fs" proof shape. ESM named-export bindings off
// `node:fs` are non-configurable (`Object.defineProperty`/mock.method on them throws
// "Cannot redefine property"), so a test that tries to spy on the real module — the
// generic, DI-agnostic way to prove "no write syscalls happened" — cannot intercept a
// call already bound to a named import at load time, whether or not it goes through
// this module's own {@link LedgerFsDeps} injection. Calling `fs.existsSync(...)` as a
// property access AT CALL TIME (never destructured to a local const) keeps every call
// a live lookup on this same mutable object, so an external spy on `fs.existsSync`/
// `fs.readFileSync`/`fs.writeFileSync` (via `node:test`'s `mock.method`) actually
// observes it — the same guarantee {@link LedgerFsDeps} gives a caller that injects
// its own fake, extended to a caller that only has the real `node:fs` module to spy on.
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
 * Derived task status (MASTER-PLAN v2.1 decision, implemented here).
 *
 * Task merge-state is DERIVED FROM GITHUB, never written back to plan/tasks.yaml.
 * A YAML round-trip destroys comments, status commits spam a public repo, and a
 * machine writer racing a human editor is a conflict class we simply do not have.
 * The `status:` field in tasks.yaml is therefore DECORATIVE (initial-state only);
 * the truth of whether a task landed is computed on demand from GitHub, in a
 * fixed precedence, and cached to a machine-owned projection (state/status.json).
 *
 * Precedence for a task id — an operator correction is checked FIRST and is
 * SUPREME (MASTER-PLAN P9 / W1-T75): it is DECLARED ground truth, not inferred
 * evidence, so it outranks every rung below rather than being read only inside
 * rung (c). Then, absent a correction, a VERIFIED-MERGED credit outranks an
 * open-PR ledger claim (W1-T116, MASTER-PLAN §3): an open PR is only ever the
 * WEAKEST evidence in the system — POSSIBLY RUNNING — so every rung below is
 * checked for a GitHub-confirmed MERGED result BEFORE an open `pr.opened` row
 * is allowed to stand as this task's status:
 *   (a) state/ledger.ndjson `pr.opened` line for this task -> query that PR's state.
 *       A MERGED resolution wins outright; a non-merged one is remembered as the
 *       dedup fallback (below) but does NOT stop the remaining rungs from being
 *       checked for a merged credit;
 *   (b) an explicit `pr:` field in tasks.yaml (tasks executed by hand, pre-ledger)
 *       — checked even when (a) already found a non-merged PR, so a settled `pr:`
 *       credit is never masked by an in-flight ledger row (the W1-T1 149x root
 *       cause: `pr.opened` pointed at an open, later-dispatched PR while `pr: 2`
 *       had long since merged);
 *   (b2) a `manual.completed` ledger line (W1-T1029) — the SAME hand-execution
 *       rung as (b), widened to the two shapes a bare `pr:` NUMBER cannot
 *       express: a completion PR in ANOTHER repository (`pr:` resolves only
 *       against THIS gateway's own configured repo), and a completion with NO
 *       PR at all, because none will ever exist (a manual task whose own work
 *       is a live drill/action, not a diff). DECLARED credit, like (c)'s
 *       correction override above — never re-verified against GitHub, since a
 *       cross-repo PR is unreachable from this gateway and a no-PR completion
 *       has nothing to verify. See {@link latestManualCompletion};
 *   (c) a merged PR whose body carries the trailer `Remudero-Task: <id>` —
 *       ownership-asserted (its head branch must be this task's own `run-<id>-*`),
 *       anchor-verified (the trailer must be an exact line, not a fuzzy search
 *       hit), and correction-aware (a `correction.provenance` line debunking this
 *       exact credit is honored) — MASTER-PLAN P16 / W1-T69, the "W1-T20c
 *       false-credit" class: deriveStatus GATES DISPATCH, so a bad credit here
 *       is worse than the same class W1-T51 fixed in the retro gather.
 * The first rung to resolve a MERGED PR wins. If none merges, (a)'s own
 * non-merged resolution (if any) stands as a "possibly running" dedup signal;
 * otherwise the task is not merged.
 *
 * NOTHING in this module writes tasks.yaml. It reads the plan and the ledger and
 * queries GitHub; the only file it writes is the status.json cache.
 */

/**
 * The precedence sources, plus `none` when GitHub has no evidence, plus
 * `throttled` when GitHub could not be read at all (rate-limited, network error,
 * or any other failed `gh` call) — W1-T119: an exhausted/errored read must never
 * be conflated with a genuinely absent result, the false `source: "none"` that
 * mis-filed W1-T116 as not-merged when GitHub simply hadn't been consulted.
 * `"manual-completion"` (W1-T1029) is the ledger-recorded twin of `"pr-field"`
 * (see {@link latestManualCompletion}) — DECLARED, not GitHub-verified, exactly
 * like `"correction"`, because the whole reason it exists is a completion this
 * gateway's own `prByRef` cannot reach (a different repo) or that never had a
 * PR to look up at all.
 */
export type StatusSource =
  | "ledger"
  | "pr-field"
  | "manual-completion"
  | "trailer"
  | "head-branch"
  | "correction"
  | "none"
  | "throttled";

/**
 * The CLASSIFIED reason a `gh` read actually failed (W1-T119 design (i)) —
 * `"rate_limit"` (quota/secondary-rate-limit exhausted), `"auth"` (expired or
 * missing credentials), `"transport"` (network/DNS/timeout), `"buffer_overflow"`
 * (W1-T181: the child process's stdout exceeded `maxBuffer` before `gh` ever
 * got a chance to exit or write to stderr — detected from the error's `code`,
 * never from `stderr` text, since there is none), and `"unknown"` for anything
 * else UNCLASSIFIABLE. `"unknown"` still counts as UNAVAILABLE, never as
 * absent — the fail-closed direction design (i) calls for, because absence is
 * the conclusion that costs money.
 */
export type GhFailureReason = "rate_limit" | "auth" | "transport" | "buffer_overflow" | "unknown";

/**
 * The FOURTH and FIFTH states {@link GitHub.readFailed}/{@link GitHub.readFailureReason} cannot
 * express on their own (W1-T2219): a boolean plus a reason has room for exactly two answers —
 * "failed" and "not failed" — and a caller reading either BEFORE any fetch has ever completed, or
 * WHILE one is running, gets the second answer indistinguishably from a confirmed-clean read.
 * `readState()` gives the same bookkeeping a fifth-and-sixth-state-free reading:
 *   - `"not_attempted"` — no fetch has completed (or started) since this gateway was built.
 *   - `"in_flight"` — a fetch is currently running (observable from a REENTRANT call made from
 *     inside an injected `fetchAll`/`exec`; the real, synchronous `execFileSync` path blocks the
 *     whole process for its duration, so nothing else on the SAME call stack can observe it, but
 *     it is still bookkept accurately for any caller that can reach in mid-call).
 *   - `"ok"` — the most recently COMPLETED fetch succeeded.
 *   - `"failed"` — the most recently COMPLETED fetch failed; {@link GitHub.readFailed}/
 *     {@link GitHub.readFailureReason} report exactly this same verdict, unchanged.
 */
export type GhReadState = "not_attempted" | "in_flight" | "ok" | "failed";

/**
 * Classify a failed `gh` invocation's exit status + stderr (+ optionally the
 * underlying Node error `code`, W1-T181) into a {@link GhFailureReason}
 * (W1-T119 design (i)). Pure and exported so {@link ghGateway} /
 * {@link buildBatchedGithub} and unit tests share the exact same
 * classification rather than each re-implementing the string matching — an
 * injected gateway in a test can construct the identical reason a real `gh`
 * failure would produce. `status` is accepted for future refinement (some
 * failure classes may one day be distinguishable by exit code alone).
 *
 * MOST failure classes are driven by `stderr`, the one place a rate-limit/
 * auth/transport message actually appears — EXCEPT a `maxBuffer` overflow,
 * which Node raises itself (killing the child before `gh` writes anything):
 * reproduced live (W1-T181), that error has `status: null` and `stderr: ""`,
 * so stderr text can never classify it. It is detected from `code ===
 * "ENOBUFS"` instead, checked FIRST so an overflow is never misread as
 * "unknown" (which is exactly what silently swallowed the 2026-07-20 outage
 * for hours — see the module's W1-T181 note on {@link buildBatchedGithub}).
 */
export function classifyGhFailure(
  status: number | null | undefined,
  stderr: string | null | undefined,
  code?: string | null,
): GhFailureReason {
  if (code === "ENOBUFS") return "buffer_overflow";
  // A KILLED-ON-TIMEOUT CHILD CARRIES NO STDERR, so the transport regex below can never see it —
  // exactly the ENOBUFS shape directly above, and detected the same way, from the Node error
  // `code`. MEASURED: `execFileSync` past its `timeout` throws `code: "ETIMEDOUT"`,
  // `signal: "SIGTERM"`, `status: null` and `stderr: ""`. Without this branch every
  // {@link GH_CALL_TIMEOUT_MS} kill would ledger as "unknown" — the same silent classification
  // that let the 2026-07-20 outage run for hours. "transport" and not a new variant: a `gh` call
  // that never returned is a network-class failure, and the regex below already classifies the
  // stderr-bearing form of it (`etimedout`) that way.
  if (code === "ETIMEDOUT") return "transport";
  const text = String(stderr ?? "");
  if (/rate limit|quota|secondary rate limit/i.test(text)) return "rate_limit";
  if (/bad credentials|authentication|not logged in|gh auth login|401 unauthorized|unauthorized/i.test(text)) return "auth";
  if (/getaddrinfo|econnrefused|econnreset|etimedout|enotfound|could not resolve host|network is unreachable|dial tcp|timeout/i.test(text)) {
    return "transport";
  }
  return "unknown";
}

/**
 * True iff `err` — as `execFileSync`/a `gh` invocation throws it — classifies as `rate_limit` via
 * {@link classifyGhFailure} (W1-T468). The pacing feedback signal {@link GhCallPacer.recordResult}
 * needs: a rate-limit-classified failure must slow the calls that follow it (design (iii)), and
 * this is the one place that decision is made so every guarded call site shares the same rule.
 */
export function isGhRateLimitError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
  return classifyGhFailure(e?.status, e?.stderr != null ? String(e.stderr) : undefined, e?.code) === "rate_limit";
}

/**
 * Wall-clock ceiling on ONE `gh` invocation, for every gateway in this module.
 *
 * WHAT HAS NO BOUND TODAY BLOCKS THE WHOLE DAEMON. Both gateways shell `gh` through
 * `execFileSync`, which is SYNCHRONOUS: a call that never returns does not merely stall the
 * sweep, it parks the daemon's only thread, so the poll loop, every review the sweep would post
 * and every later rung stop with it — with nothing logged, because a hang is not an error. On
 * 2026-08-13 a single sweep pass that began at 10:57 was still running at 11:54, observed on
 * `gh api --paginate repos/…/pulls/768/files`, with four PRs unreviewed the whole time.
 *
 * THE NUMBER IS SIZED SO IT CANNOT FIRE ON A HEALTHY CALL, which is this repo's recurring
 * defect when it does. MEASURED 2026-08-13 against this repo: the heaviest read the board makes
 * — a 100-row closed page carrying every body — took 0.70–0.90 s over six consecutive calls, and
 * a per-PR `--paginate` file list took 0.32–0.40 s. 60 s is ~67x the slowest healthy call
 * observed, and still inside the 60 s `DEFAULT_POLL_INTERVAL_MS`, so one stalled call cannot
 * outlive the poll that issued it.
 *
 * FIRING IS FAIL-SOFT, NEVER FAIL-WRONG. The kill surfaces as a throw, which the callers already
 * classify ({@link classifyGhFailure}, via `code: "ETIMEDOUT"` ⇒ `transport`), ledger
 * (`board_gateway.fetch_failed`) and degrade on — `lastFetchFailed` is reset by the next
 * successful fetch, and `fetchBoardPrsRest` leaves the caller's row cache untouched on a throw,
 * so recovery costs a 2-request delta rather than a cold re-walk. A bounded, named, recoverable
 * failure strictly dominates an unbounded silent hang.
 */
export const GH_CALL_TIMEOUT_MS = 60_000;

/** A PR's identity + GitHub merge state, as seen by the {@link GitHub} gateway. */
export interface PrRef {
  number: number;
  url: string;
  /** GitHub PR state: "MERGED" | "OPEN" | "CLOSED". */
  state: string;
  /**
   * The PR's title (W1-T184) — a pure DECORATION, never a precedence input: nothing in
   * {@link derivePrPrecedence} reads this field, so an absent/stale title never changes
   * merge-state derivation. Optional (added after every pre-existing {@link PrRef} fixture
   * was already written) so no existing literal implementer breaks — omitted ⇒ a caller
   * decorating a row with the PR's title (lib/board.ts's RECENT activity feed) degrades to
   * showing the bare PR number/url instead, the same fail-soft discipline every other
   * optional field on this interface already follows.
   */
  title?: string;
  /**
   * The PR's head branch ref (W1-T256) — rides along on {@link GitHub.findMergedByHeadBranch}'s
   * one `gh pr list` so rung (c2)'s corroboration can re-assert ownership (`run-<taskId>-\d+`)
   * on the SAME fetch, never a second `gh` call. Optional (added after every pre-existing
   * {@link PrRef} literal was written) so no existing implementer breaks — omitted ⇒ a caller
   * that needs it treats the branch as unowned, the same fail-soft discipline as the rest.
   */
  headRefName?: string;
  /**
   * The exact current head commit from the same board fetch (W1-T2727). Optional for legacy and
   * injected rows; omitted means unknown and must never be treated as an exact-head match.
   */
  headRefOid?: string;
  /**
   * The PR's raw body text (W1-T2392) — rides the SAME batched `gh pr list` fetch `title` and
   * `headRefName` already ride, at zero extra cost (see `buildBatchedGithub`'s own `prBody`
   * comment: "`body`/`headRefName`/`title`" all come off the one list call, unlike
   * `changedFiles`). Carried so {@link indexProseNamedTaskIds} can read prose without a second
   * fetch. Optional like every sibling here — omitted ⇒ the prose index sees the title alone.
   */
  body?: string;
}

/**
 * The four IN-FLIGHT run phases the ledger's own `step` names already distinguish
 * (MASTER-PLAN §7/§9, W1-T155 "the board projection exposes the FULL status taxonomy").
 * Never invented vocabulary — each maps 1:1 onto real run-task.ts ledger steps: `recon`
 * (since `run.start`), `implement` (since `recon.done`/`implement.resumed`), `review`
 * (since `implement.done`/`pr.opened`, or again after `fix.resolved`), `fix-rung`
 * (since `fix.dispatch`/`fix.review`).
 */
export type Phase = "recon" | "implement" | "review" | "fix-rung";

/** One task's projected merge-state, derived from GitHub (never from yaml). */
export interface StatusProjection {
  taskId: string;
  /**
   * W1-T2392 — A MERGED BUILD NOBODY CREDITED, REPORTED AND NOTHING ELSE. Present only on a
   * projection that is NOT merged (so all three credit surfaces came back empty) when some merged
   * PR touching `src/` names this task in its own prose. It changes NO decision: `merged` stays
   * false, the task stays as dispatchable as it was, and every consumer that does not read this
   * field behaves byte-identically. A WARN, never a block — the shard forbids a blocking check
   * outright, because all three surfaces are empty on 30.1% of recent builds and twelve of those
   * thirty-one are standalone repairs that name no task at all.
   */
  uncreditedBuild?: UncreditedBuildWarning;
  /**
   * W1-T2397 — AN OPEN, UNMERGED BUILD OF THIS TASK ON SOMEONE ELSE'S BRANCH. A REPORT AND
   * NOTHING ELSE: no eligibility path reads it, `prState` is untouched, and the dispatch proceeds
   * whether or not it is present. Populated by {@link projectPlan} from the OPEN half the gateway
   * already holds. See {@link openSiblingBuild} for why this is a warn and not a refusal.
   */
  openSiblingBuild?: OpenSiblingBuild;
  /**
   * Derived status label in the plan's vocabulary. DELIBERATELY stays within
   * {@link TaskStatus}'s closed set (never a new enum value) even after W1-T155's
   * taxonomy work below — two real consumers are load-bearing on that: daemon.ts's
   * `reconstructOrphan` pattern-matches `=== "running"`, and openapi/daemon.yaml's
   * `StatusProjection.status` enum mirrors {@link TaskStatus} exactly. The FINER
   * taxonomy (in-flight phase, needs-human, armed-awaiting-merge) is carried on the
   * additive fields below instead, so every existing `.status` consumer keeps working
   * unchanged while a caller that wants the full picture reads the extra fields too.
   */
  status: TaskStatus;
  /** The single fact dependency-gating cares about: has this task landed? */
  merged: boolean;
  /** Which precedence source resolved it (or `none`). */
  source: StatusSource;
  prNumber?: number;
  prUrl?: string;
  prState?: string;
  /**
   * LEGIBILITY (P16 / W1-T69): trailer search hits that were REJECTED by rung (c)'s
   * ownership-assert / anchored-trailer verify, each with a machine-readable reason.
   * A false trailer in the wild is thereby VISIBLE, not silently dropped — the same
   * "surface the rejection" discipline the W1-T20c false-credit reproduction motivated.
   * Present (and non-empty) ONLY when a candidate was actually rejected.
   */
  rejected_candidates?: Array<{ pr: string; reason: string }>;
  /**
   * CURRENT phase of an in-flight (non-terminal) run (W1-T155), derived from the
   * ledger's own `run.start` + phase-marker events for the task's LATEST run. Present
   * ONLY while a run is genuinely in flight — a `run.start` with no `verdict` since —
   * and `status` is not already a definitive terminal signal (`blocked`); a stale or
   * concluded EARLIER run's phase never leaks in, because a fresh `run.start` always
   * resets the scan back to `recon` (the falsifier the task's acceptance names: "a
   * stale/earlier phase is not reported").
   */
  phase?: Phase;
  /** ISO-8601 timestamp of the in-flight run's `run.start` ledger line. Present iff `phase` is. */
  startedAt?: string;
  /**
   * Milliseconds elapsed since `startedAt`, as of THIS derivation (`deps.now()`,
   * default `Date.now`) — re-derived fresh on every call, never cached. Present iff
   * `phase`/`startedAt` are.
   */
  elapsedMs?: number;
  /**
   * W1-T944: the in-flight run's CURRENT `worker.state` (W1-T942's 3-value vocabulary --
   * `"working" | "tool-executing" | "quiet"`), the newest such ledger row seen for the run
   * `deriveRunState` just scanned `phase`/`startedAt` off -- ONE scan, not a second one. Present
   * ONLY alongside `phase` (design note v: `isRunningRow`'s existing `phase != null` definition
   * governs liveness for this field too, so a finished run's last known state can never linger on
   * a card as if it were current) AND only once the run has actually emitted a `worker.state` row
   * -- a run with no row yet (every run that started before W1-T942 shipped, or whose observer
   * never fired) leaves this `undefined` so the console renders "state unknown" rather than a
   * healthy-looking default (design note iii).
   */
  workerState?: WorkerState;
  /**
   * ISO-8601 `ts` of the ledger row that transitioned the run INTO its current `workerState` --
   * present ONLY while `workerState === "quiet"` (design note i). The console ages a "quiet Nm"
   * duration off this timestamp, on the SAME 1s tick that already ages `elapsedMs` (design note
   * ii), rather than freezing at whatever value was true when the row last rendered.
   */
  workerStateSince?: string;
  /**
   * PROCESS-UNEVIDENCED (W1-T1240): true when this row's `phase`/`startedAt`/`elapsedMs`/
   * `workerState` above are backed ONLY by an open PR — `recentActivity` (a ledger heartbeat
   * within the liveness bound) and `hasLiveLock` (an inflight-holder pid judged alive by
   * `isHolderStale`) are BOTH false, so nothing here has actually observed a LIVE LOCAL
   * PROCESS. The elapsed clock and `workerState` word are still computed from the ledger's
   * `run.start` as usual (design note v: they stay on the row, never deleted), but that is a
   * claim about a local process backed only by a remote fact — the split that once rendered
   * W1-T314 as `running, 10h25m, $27.75` ten hours after its run was refused. Marks "NOT
   * EVIDENCED", never "dead" (design note iii, the W1-T119/W1-T130 cannot-observe polarity):
   * `inflightHolder` is optional by contract, and an absent probe degrades process evidence to
   * `recentActivity` alone rather than asserting the run is a corpse. Present ONLY alongside
   * `phase` (this row is genuinely rendering `running`) — a row with a fresh heartbeat or a
   * live lock omits it, same sparse convention as `orphaned`/`needsHuman`.
   */
  processUnevidenced?: true;
  /**
   * True when the task has an OPEN escalation (escalate.ts's `escalation.issue_opened`)
   * that no LATER `run.start` has superseded — a human has not yet acted, or the task
   * was never redispatched since. Omitted (not `false`) once superseded by a newer run
   * or once merged — same sparse-field convention as {@link rejected_candidates}.
   */
  needsHuman?: true;
  /**
   * The escalation issue's own URL (W1-T182), from escalate.ts's `escalation.issue_opened`
   * ledger line — carried so NEEDS ME can render a DIRECT link rather than soliciting a URL
   * the ledger already holds. Present iff `needsHuman` is.
   */
  escalationIssueUrl?: string;
  /**
   * The escalation's real one-line ask (W1-T182) — the live issue's title (escalate.ts's
   * `[${class}] ${taskId}: ${summary}`), read through the SAME batched gateway as everything
   * else on this interface. Present iff `needsHuman` is AND the issue's title could actually be
   * read; a caller falls back to a generic label when absent (e.g. an unverified row, below).
   */
  escalationTitle?: string;
  /**
   * True when the escalation's live issue state could NOT be confirmed OPEN — either no
   * {@link GitHub.issueByUrl} support, or the read itself failed (W1-T182 design's FAIL-CLOSED
   * boundary: an unreadable issue state must KEEP the row rather than silently drop it, the
   * opposite direction from W1-T181's merged-count boundary). Present only alongside
   * `needsHuman`, sparse like every other flag on this projection.
   */
  escalationUnverified?: true;
  /**
   * ISO-8601 `ts` of the OPEN escalation's own `escalation.issue_opened` ledger line (W1-T159) —
   * when this became a needs-human item, NOT when its (possibly much earlier, possibly much
   * later — a redispatch can precede an escalation by hours) triggering run started. A caller
   * measuring "how long has this needed a human" (e.g. the GLANCE strip's >24h anomaly emphasis)
   * MUST use this field, never `startedAt`: they name two different events, and NEEDS ME rows
   * had been keying their own age off `startedAt` (the run's start) — a proxy that is wrong
   * whenever the escalation fires well after the run that preceded it began, or long after a
   * later run's own startedAt was overwritten. Present iff `needsHuman` is.
   */
  escalationOpenedAt?: string;
  /**
   * True when the projection's current OPEN PR already has GitHub auto-merge armed,
   * observed via the SAME batched gateway fetch {@link buildBatchedGithub} already
   * makes for every other {@link GitHub} method — W1-T155 preserves the board-fix O(1)
   * invariant (zero extra `gh` calls). Present only when `status === "running"` and
   * the PR is actually armed.
   */
  armedAwaitingMerge?: true;
  /**
   * True when this projection is INDETERMINATE (W1-T119): `source: "throttled"`,
   * because the underlying GitHub read genuinely FAILED rather than resolving to
   * a clean "no evidence". Distinct from ordinary `queued` (whose `source` is
   * `"none"`, ordinary absence) — a caller that gates dispatch or a ledger write
   * off this projection MUST treat `indeterminate` as DO NOT ACT, never as an
   * ordinary queued task, because the evidence a "not merged" conclusion would
   * rest on was never actually consulted. Carried as its own sparse field
   * (mirrors `needsHuman`/`armedAwaitingMerge`) so a caller need not know
   * `"throttled"`'s meaning to gate on it correctly.
   */
  indeterminate?: true;
  /**
   * The CLASSIFIED reason behind an `indeterminate` projection (W1-T119 design
   * (i)/(iii)) — `"rate_limit"` | `"auth"` | `"transport"` | `"unknown"`, from
   * {@link classifyGhFailure} applied to the underlying gateway's exit status
   * + stderr. LEGIBILITY: an operator watching a stalled drain can tell
   * throttle from auth-expiry from a network outage, rather than a bare
   * "indeterminate" with no reason attached. Present ONLY alongside
   * `indeterminate: true` (sparse, same convention as `needsHuman`/
   * `armedAwaitingMerge`) — a caller that only checks `indeterminate` keeps
   * working unchanged.
   */
  unavailableReason?: GhFailureReason;
  /**
   * MONOTONIC UNDER DARKNESS (W1-T179, W1-T155's amended criterion): present ONLY when
   * `status`/`merged`/`source` (and any `pr*` fields) were carried forward from a PRIOR
   * successful observation because THIS cycle's GitHub read genuinely failed and no
   * precedence rung resolved anything fresh — the ISO-8601 timestamp since which this task
   * has been unobservable (the start of the CURRENT unbroken run of failed reads; a LATER
   * failed read never resets it, only a subsequent SUCCESSFUL read clears it by omission).
   * This is the "marked `github_unobservable`" state the amendment named: a credited task's
   * status/merged never silently regresses to an absent-looking `queued` across a gap where
   * GitHub simply could not be consulted (the 12:24->12:58 fail-open this fixes). Always
   * accompanied by `indeterminate: true` / `unavailableReason` — same sparse convention as
   * `needsHuman`/`armedAwaitingMerge`.
   */
  githubUnobservableSince?: string;
  /**
   * LIVENESS BOUND (W1-T179, W1-T155's amended criterion): true when the ledger shows this
   * task DISPATCHED with no terminal verdict since, and NEITHER an open PR nor ledger
   * activity within the liveness bound backs it up — a stale in-flight trace a crashed
   * worker left behind (the W1-T1 27h21m spin-loop fixture). `status` deliberately stays
   * within {@link TaskStatus}'s closed set rather than gaining a new enum value (whatever the
   * PR-precedence rungs above already resolved, ordinarily `queued`); this sparse flag is
   * the "unknown/orphaned, never running" signal a caller checks instead — same additive
   * convention as `needsHuman`/`indeterminate`. Present only while `runState.inFlight` and
   * absent once a fresh heartbeat or an open PR resolves the row back to `running`.
   */
  orphaned?: true;
  /**
   * W1-T485: this task is NOT merged, yet one of its own `grep:` proof symbols was shipped to a
   * declared path of its by a commit carrying a DIFFERENT task's `Remudero-Task:` trailer — the
   * route no credit source covers, because the crediting task was named correctly and it was simply
   * not this one. AN OBSERVATION, NEVER A VERDICT: nothing reads this to gate dispatch, refuse a
   * merge or rewrite a shard, and `merged`/`status`/`source` are untouched beside it. Sparse, like
   * `needsHuman`/`indeterminate`/`orphaned` — present ONLY when {@link DeriveDeps.supersessionSearch}
   * was supplied AND it found such a commit.
   */
  supersededBy?: SupersessionEvidence;
  /**
   * W1-T507: this task is filed `verify: human` in the plan AND this projection's own `merged`
   * is false — the plan has already excluded it from every machine-dispatch path
   * (`isDispatchEligible` in `src/lib/drain.ts`, `assertRunnable` in `src/lib/plan.ts`, and three
   * `task-linter.ts` predicates all return/throw on `task.verify === "human"`), so nothing else
   * in `src/` ever converts that exclusion into a signal a person can see. Set by
   * {@link deriveStatus} itself (unlike `supersededBy` immediately above, which needs an
   * external git-log search dependency `deriveStatus` does not take, and is therefore attached
   * one level up in {@link projectPlan}): this flag is a pure function of `task` plus THIS
   * call's own already-resolved `merged`/`indeterminate`, so computing it here keeps every
   * caller — `projectPlan`'s hoisted pass and a standalone `deriveStatus(task, deps)` call
   * alike — DERIVATION-EQUIVALENT, never diverging by which path reached it.
   *
   * DELIBERATELY A DIFFERENT FIELD FROM `needsHuman`, never a widened one. `needsHuman` backs
   * the NEEDS ME escalation row's own "view issue"/"mark handled" affordance
   * (`escalationIssueUrl`/`escalationTitle`), which a `verify: human` task never has — it is
   * never DISPATCHED, so it never RUNS, so it never escalates. Setting `needsHuman` here would
   * render that affordance with nothing to click. A DISTINCT KIND instead, so a caller (the
   * console) groups by it rather than flattening two different reasons a row needs a person
   * into one flag.
   *
   * "Already credited merged" is exactly this projection's OWN `merged` — the same field every
   * other precedence rung already resolves from EITHER credit path (an anchored
   * `Remudero-Task:` trailer, or a `run-<taskId>-<digits>` head ref), so a task credited through
   * either route is correctly excluded here too, same as everywhere else `merged` gates.
   * Sparse, like `needsHuman`/`indeterminate`/`orphaned`/`supersededBy` — present only when
   * applicable.
   */
  verifyHumanPending?: true;
  /**
   * W1-T951 DELIVERABLE B: true when this MERGED task's durable credit rests on EXACTLY ONE of
   * the two paths (`"trailer"` XOR `"head-branch"`) recorded in {@link CreditStore} — the
   * defect rationale (2) measured: 18 ids credited by head-branch alone, and the branch ref is
   * one GitHub deletes from the repository on merge. Set by {@link derivePrPrecedence} from
   * {@link isSinglePathCredited} against whichever durable store the resolving rung wrote to
   * (or already found), so it is available the SAME call that resolves `merged: true`, never a
   * second query. Sparse, like `needsHuman`/`indeterminate`/`orphaned` — present ONLY when
   * `merged` is true AND the credit is single-path; a task credited by both paths, or not
   * credited at all, omits it (not `false`).
   */
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
   * EVERY merged PR carrying `taskId`'s anchored trailer, newest-first (W1-T441) — the whole
   * candidate set {@link findMergedByTrailer} discards by returning only the first.
   *
   * WHY THE SINGLE ANSWER IS SYSTEMATICALLY THE WRONG ONE. The already-satisfied CLOSE path
   * manufactures duplicates: each close merges a NEWER trailer-bearing PR that displaces the
   * implementation in every later lookup. MEASURED over all 1,172 merged PR bodies (anchored
   * `^Remudero-Task: <id>$`): 496 distinct ids carry a trailer and SIXTEEN are carried by more
   * than one — W1-T254 by six, where #720 is the implementation (`fix(sweep)…`) and the other
   * five change `DECISIONS.md` alone.
   *
   * Returns null if the read FAILED (→ readFailed()/W1-T119), [] on a genuine no-such-PR — the
   * two must stay distinguishable, exactly as {@link findMergedByHeadBranch}'s own doc insists.
   * OPTIONAL (added after every pre-existing {@link GitHub} fixture was written) so no existing
   * implementer breaks — omitted ⇒ callers fall back to {@link findMergedByTrailer}'s single
   * answer and behave exactly as they did before.
   */
  findMergedByTrailerAll?(taskId: string): PrRef[] | null;
  /**
   * CORROBORATION for an empty {@link findMergedByTrailer} (W1-T256): enumerate MERGED PRs
   * whose HEAD BRANCH is `run-<taskId>-*` — the deterministic, ownership-encoding signal that
   * is NOT the eventually-consistent BODY full-text index rung (c) relies on. An exit-0 EMPTY
   * trailer search is INDETERMINATE, never authoritative "not merged": a single search miss on
   * the body index demoted an already-merged task to dispatchable (four spurious 07-24
   * re-dispatches). Returns the (fuzzily-matched) candidates newest-first — callers RE-ASSERT
   * ownership on each `headRefName` before crediting, exactly like rung (c) re-verifies the
   * trailer — or null if the read itself FAILED (→ readFailed()/W1-T119 indeterminate skip),
   * as distinct from an empty array (genuinely no such branch). OPTIONAL (added after every
   * pre-existing {@link GitHub} fixture was written) so no existing implementer breaks —
   * omitted ⇒ the corroboration is skipped and derivation behaves exactly as before.
   */
  findMergedByHeadBranch?(taskId: string): PrRef[] | null;
  /**
   * BATCHED form of {@link findMergedByHeadBranch} (W1-T257): ONE `gh pr list --state merged`
   * carrying every merged PR's `headRefName`, so {@link projectPlan} can match `run-<taskId>-*`
   * CLIENT-SIDE for the whole plan from a single fetch instead of one `gh` call per uncredited
   * task (#737's per-task cost). Like {@link findMergedByTrailer}'s batched twin in
   * {@link buildBatchedGithub}, this matches on the STRUCTURED head ref, NEVER the eventually-
   * consistent body full-text index — reintroducing that index would restore the exact failure
   * this whole mechanism exists to prevent. Returns the merged PRs (each carrying `headRefName`),
   * or null if the read FAILED (→ readFailed()/W1-T119). OPTIONAL — omitted ⇒ projectPlan does no
   * batching and derivation falls back to the per-task {@link findMergedByHeadBranch}.
   */
  listMergedHeadBranches?(): PrRef[] | null;
  /**
   * The OPEN twin of {@link listMergedHeadBranches} (W1-T377): every OPEN PR carrying its
   * `headRefName`, so {@link projectPlan} can match `run-<taskId>-*` CLIENT-SIDE and credit a
   * task with an open PR that the ledger never recorded.
   *
   * WHY THIS IS NEEDED AT ALL. The ONLY route to an OPEN association is rung (a)'s ledger
   * `pr.opened` line — rungs (c)/(c2) are gated on `state === "MERGED"` and answer a different
   * question. So a run that opens a PR but never ledgers the line leaves its task looking
   * dispatchable, and `isDispatchEligible`'s in-flight guard (drain.ts) cannot fire. MEASURED
   * (2026-08-05, W1-T350): run 1785957031821 had its worktree reaped mid-run at 20:01:40, opened
   * PR #1377 at 20:08:02, and never wrote `pr.opened`; the task re-dispatched at 20:11:02, built
   * the whole thing a second time as #1378, merged that, and left #1377 a conflicting duplicate.
   * A full high-risk run (budget_usd 85) spent on work that already existed.
   *
   * COST: ZERO extra calls on the batched path — {@link buildBatchedGithub} already fetches
   * `--state all` and merely filters to MERGED, so the open rows are sitting in the same index.
   * OPTIONAL, like its merged twin: omitted ⇒ the corroboration is skipped and derivation behaves
   * exactly as before. Returns null if the read FAILED (→ readFailed()/W1-T119), never [].
   */
  listOpenHeadBranches?(): PrRef[] | null;
  /**
   * The PR's head branch name, or undefined if it cannot be resolved. Backs
   * rung (c)'s ownership-assert (MASTER-PLAN P16 / W1-T69) — mirrors
   * run-task.ts's `PrHeadGateway` and retro.ts's `ShippedGithub.headRefName`.
   */
  headRefName(prUrl: string): string | undefined;
  /**
   * The PR's raw body text, or undefined if it cannot be resolved. Backs rung
   * (c)'s anchored-trailer verify (P16 / W1-T69): GitHub's body search is a
   * fuzzy full-text match, so a candidate must be re-checked locally for the
   * EXACT `Remudero-Task: <id>` line before it may be credited.
   */
  prBody(prUrl: string): string | undefined;
  /**
   * W1-T2387 — DOES THE COMMIT SURFACE CARRY THIS TASK'S ANCHORED TRAILER FOR THIS PR?
   *
   * The SECOND anchored surface, and the re-verify half of the union {@link findMergedByTrailer}
   * already searches. Reads the SAME memoised commit index that fallback built — no second `git`
   * call, no fetch, and still nothing at all when every body carried its trailer.
   *
   * IT IS NOT A RELAXATION OF {@link creditsByAnchoredTrailer}. `buildCommitTrailerIndex` extracts
   * `^Remudero-Task: <id>$` as its own exact, anchored line and refuses every token the run-id
   * grammar rejects (measured: 170 of 740 commit tokens), so a hit here is the same class of
   * evidence an anchored BODY line is — held to the same grammar, on a different surface. Every
   * other W1-T20c property (the head-branch veto, the unreadable-head fail-closed, the non-merged
   * ownership requirement) is applied to it unchanged.
   *
   * FAILS CLOSED: a commit index that could not be built reads FALSE, never "credited". OPTIONAL —
   * omitted ⇒ the re-verify consults the body alone and behaves exactly as it did before W1-T2387.
   */
  creditedByCommitTrailer?(taskId: string, prUrl: string): boolean;
  /**
   * The PR's changed-file paths (repo-relative), or `undefined` when they cannot be resolved.
   * Backs rung (c)'s PLAN-ONLY refusal (W1-T413): a MERGED, correctly-trailered PR that changed
   * NOTHING outside plan scope filed or re-scoped a task rather than implementing it, and must not
   * credit it as done.
   *
   * `undefined` MEANS UNAVAILABLE AND KEEPS TODAY'S ANSWER — never "no files". A read failure must
   * not flip a task's merge state (buildShellRoute's own rule: "A read failure degrades to UNKNOWN,
   * never to zero"), and here the safe direction is the OPPOSITE of {@link
   * creditsByAnchoredTrailer}'s unreadable-head rule: an absent head cannot be evidence FOR a
   * credit, whereas silently WITHDRAWING a long-standing credit would re-dispatch finished work and
   * spend money on it. So an unreadable head fails closed and an unreadable file list fails open.
   *
   * OPTIONAL, like {@link autoMergeArmed}/{@link warm}/{@link readFailed} and for the same stated
   * reason — every pre-existing fixture across the suite predates it, so omitted ⇒ derivation
   * behaves exactly as it did before this existed.
   */
  changedFiles?(prUrl: string): string[] | undefined;
  /**
   * Is GitHub auto-merge already armed on this PR? OPTIONAL (added W1-T155, after every
   * pre-existing {@link GitHub} fixture across the test suite was already written) so no
   * existing literal implementer breaks — omitted ⇒ deriveStatus treats it as fail-soft
   * "unknown/not armed", the same discipline every other method here already follows.
   */
  autoMergeArmed?(prUrl: string): boolean;
  /**
   * OPTIONAL (W1-T154): force this gateway's underlying fetch to happen NOW, rather than lazily
   * on whichever query method is called first. The serve boot sequence calls this synchronously
   * BEFORE the server ever accepts a request (lib/serve.ts's `prewarmBoardGithub`), so the FIRST
   * `GET /v1/status` is never the request that pays {@link buildBatchedGithub}'s cold first fetch
   * — "pre-warm the batched gateway at boot... so the first request is never cold" (the task's
   * own design note). A per-task gateway with nothing to pre-warm (e.g. {@link ghGateway}, which
   * already fetches fresh on every call) simply does not implement it — omitted ⇒ callers treat
   * warming as a no-op, the same fail-soft discipline every other optional method here follows.
   */
  warm?(): void;
  /**
   * True if a read this gateway attempted actually FAILED (rate-limited, network
   * error, auth failure, or any other non-zero `gh` exit / unparseable output) —
   * as opposed to `gh` succeeding with a genuinely empty/not-found result. W1-T119:
   * lets {@link derivePrPrecedence} tell "GitHub was consulted and has no evidence"
   * apart from "GitHub could not be consulted", so a failed read defers rather than
   * being reported as a confirmed not-merged. OPTIONAL (added after every pre-existing
   * {@link GitHub} fixture was already written) so no existing implementer breaks —
   * omitted ⇒ treated as `false` (every prior null/[] result trusted as a real answer),
   * the same fail-soft discipline every other optional method here already follows.
   *
   * NEVER FORCES A FETCH (W1-T2219): reports the STICKY verdict of the most recently
   * COMPLETED attempt only — a caller that asks this before any query method has ever run
   * gets `false`, the SAME "not attempted" answer {@link ghGateway} (a sticky per-instance
   * flag, no `gh` call of its own) always gave; {@link buildBatchedGithub} used to answer
   * this by forcing its own cold fetch first, which meant asking whether a read failed
   * PERFORMED the read and blocked the caller on it. {@link GitHub.readState} distinguishes
   * "not attempted"/"in flight" from this pair's two answers for a caller that needs to.
   */
  readFailed?(): boolean;
  /**
   * The CLASSIFIED reason the most recent failed read actually failed (W1-T119
   * design (i)) — captured from `gh`'s exit status + stderr instead of
   * discarding them (the pre-W1-T119 `stdio: [ignore, pipe, ignore]` triple
   * threw stderr away, so rate-limit/auth/transport were indistinguishable
   * from each other and from a genuine absence). OPTIONAL — a caller consults
   * this only after `readFailed()` is `true`; {@link derivePrPrecedence}
   * defaults to `"unknown"` when a `readFailed`-reporting gateway does not
   * implement this method, never throwing and never guessing "absent".
   *
   * NEVER FORCES A FETCH (W1-T2219), for the same reason and in the same way as
   * {@link readFailed} above — reads the sticky reason from the most recently COMPLETED
   * attempt, `undefined` before any attempt has completed. Scoped to the PR channel only;
   * {@link issueReadFailureReason} is the independent issue-channel twin.
   */
  readFailureReason?(): GhFailureReason | undefined;
  /**
   * W1-T2219: the state {@link readFailed}/{@link readFailureReason} cannot express on their
   * own — see {@link GhReadState} for what each of its four values means. NEVER forces a
   * fetch, exactly like the pair above; reads this gateway's own bookkeeping only. OPTIONAL,
   * like every other method added after the first {@link GitHub} fixture — omitted ⇒ a
   * caller falls back to `readFailed()` alone and cannot tell "not attempted" from
   * "confirmed not failed", the pre-existing discipline this method sharpens, never replaces
   * (design (ii): "beside the pair, never in place of it").
   */
  readState?(): GhReadState;
  /**
   * True if the most recent read SUCCEEDED but only PARTIALLY — {@link fetchBoardPrsRest}'s walk
   * hit its {@link BOARD_MAX_PAGES} ceiling on the open or closed half before exhausting it
   * (W1-T415). A THIRD accessor rather than a value folded into {@link readFailed}/
   * {@link readFailureReason}: a fetch that FAILED and a fetch that SUCCEEDED PARTIALLY are
   * different facts, and collapsing them would recreate the exact failure/absence conflation
   * W1-T119 exists to keep apart, one level up. Rows the walk never reaches keep their cached
   * values and are never fabricated or altered (open-prs-rest.ts's own comment), so truncation can
   * only OMIT rows — a task this view CREDITS is still soundly credited, and only the "no evidence"
   * conclusion is unsound. {@link derivePrPrecedence} therefore defers on this signal in exactly
   * the same arm it already defers on `readFailed()`, never anywhere upstream of a credit.
   * OPTIONAL, like {@link readFailed} and {@link warm} and for the same reason — every pre-existing
   * {@link GitHub} fixture (and the unbatched {@link ghGateway}, which has no walk and cannot
   * truncate) predates it, so omitted ⇒ treated as `false`, the same fail-soft discipline every
   * other optional method here already follows.
   */
  readTruncated?(): boolean;
  /**
   * R-24 (docs/audits/recon-2026-09-05.md): DROP THE FAILURE VERDICTS LEFT BY EARLIER ATTEMPTS, AND NOTHING ELSE — the one
   * seam that lets a gateway be held for a whole daemon/drain lifetime instead of rebuilt per
   * tick.
   *
   * WHY IT HAS TO EXIST. `buildBatchedGithub` closes over BOTH a delta cache (`knownBoardPrs`,
   * the row set `fetchBoardPrsRest`'s early stop compares against) and a set of failure
   * verdicts. Those two want opposite lifetimes: the cache is worth more the longer it lives —
   * a warm closed half stops at the delta boundary in ~2 requests where a cold one walks the
   * repo (MEASURED at 25 requests / 21.8 s at 2,400 PRs; this repo has passed 4,080) — while a
   * verdict must never outlive the tick that earned it, or one transient outage marks every
   * later tick indeterminate. `drainCommand`/`daemonCommand` used to buy the second property by
   * throwing the whole instance away every tick, which paid for it with the first. This method
   * separates them: the caller holds ONE instance and clears the verdicts at the top of each
   * tick.
   *
   * WHAT IT CLEARS, AND WHY THE EMPTY HALF GOES WITH THE FLAG. A FAILED fetch replaces its half
   * with an EMPTY one and stamps it (the W1-T181 pairing) — the empty rows are only ever safe
   * because they are read alongside `readFailed()`. Clearing the flag while leaving that stamped
   * empty half in place would hand a caller "GitHub says zero PRs" under a healthy label, which
   * is precisely the conflation W1-T181 exists to prevent. So a half is dropped exactly when its
   * failed verdict is, and the next read re-fetches it. `knownBoardPrs`/`knownIssues` are NOT
   * touched: they are already untouched on a throw, so the re-fetch is a cheap delta, not a cold
   * walk.
   *
   * A SUCCESSFUL verdict and its half are left exactly as they are — this is a reset of
   * failures, never of the cache, and it performs no I/O.
   *
   * OPTIONAL, like every other method added after the first {@link GitHub} fixture: omitted ⇒ the
   * caller's `?.()` is a no-op and the gateway keeps whatever verdict lifetime it already had.
   */
  resetFailureFlags?(): void;
  /**
   * Resolve an escalation issue's LIVE state (+ title, for NEEDS ME's one-line ask) by its
   * `issue_url` (W1-T182) — the join that replaces trusting escalate.ts's
   * `escalation.issue_opened` ledger line as a permanent proxy for "still open" ({@link
   * resolveEscalation} below). `null` when the issue cannot be resolved — either genuinely
   * absent, or the underlying read failed; {@link issueReadFailed} distinguishes which, the
   * same split {@link readFailed}/{@link prByRef} already use for PRs.
   * OPTIONAL, but the FAIL-SOFT DIRECTION here INVERTS every other optional method on this
   * interface: omitted, or a `null` result, means "cannot confirm this is closed" — the
   * escalation stays `needsHuman` (marked unverified), never silently dropped. Every other
   * optional method here defaults to false/absent-evidence; this one defaults to "still open"
   * because hiding a possibly-live escalation from the operator's work list costs more than
   * one stale-looking row (W1-T182 design, the inverse of W1-T181's merged-count direction).
   */
  issueByUrl?(url: string): { state: string; title?: string } | null;
  /**
   * True iff the most recent {@link issueByUrl} read genuinely FAILED (rate-limited, network
   * error, auth failure) rather than resolving to a clean not-found. Mirrors {@link
   * readFailed}, but scoped to the issue fetch — an independent batched source from the PR
   * fetch, so the two failure flags never conflate a PR outage with an issue-read outage.
   */
  issueReadFailed?(): boolean;
  /**
   * W1-T2219: the CLASSIFIED reason the most recent failed {@link issueByUrl}-backing fetch
   * actually failed — the issue-channel twin of {@link readFailureReason}, closing the gap
   * rationale (2)(c) names: an issue-fetch failure was already classified and logged
   * (`board_gateway.issue_fetch_failed`) but had no accessor a caller could reach it through,
   * so {@link issueReadFailed} could say THAT the issue channel failed but never WHY. OPTIONAL
   * — a caller consults this only after `issueReadFailed()` is `true`; omitted ⇒ a caller
   * defaults to `"unknown"`, the same discipline `readFailureReason`'s own doc states.
   */
  issueReadFailureReason?(): GhFailureReason | undefined;
  /**
   * W1-T914: the `remudero-review` commit-status state for `prUrl`'s CURRENT head, three-valued
   * plus `"none"` — the SAME vocabulary lib/review.ts's `PostableReviewState` posts
   * (`"success" | "failure" | "pending"`) widened with `"none"` for "no `remudero-review` status
   * has been posted at all", mirroring run-task.ts's own `reviewStateFromRollup`
   * (`OpenPrView.reviewState`) rather than inventing a second taxonomy for the console
   * (MASTER-PLAN's "ONE model" rule — see lib/board.ts's `BoardRow.reviewState`).
   *
   * READS THE SAME COMBINED-STATUS ENDPOINT open-prs-rest.ts's `combinedStatusRestArgs` already
   * documents ("where `remudero-review` ... lives") — never a second, independently-shaped
   * GitHub call. `"none"` is returned ONLY when the read succeeded and genuinely found no
   * `remudero-review` entry in `statuses[]` (never synthesised from the endpoint's own
   * roll-up-of-a-rollup top-level `state`, exactly like `rollupFromRest`'s own rule).
   *
   * W1-T2235: `"not-applicable"` is returned for a MERGED or CLOSED row, ALWAYS, without any
   * network call — a terminal PR's combined status is history, not something `remudero-review`
   * (which watches pending -> success while a PR stays open) has an opinion about. Never
   * collapsed into `"none"`: `"none"` means "asked GitHub, no review status posted",
   * `"not-applicable"` means "did not ask, the question does not apply to a closed row".
   *
   * `undefined` MEANS THE READ ITSELF COULD NOT BE TRUSTED — a `gh`/REST failure, or a `prUrl`
   * this gateway cannot resolve a head ref for — and is NEVER collapsed into `"none"`: a caller
   * that cannot tell "no review posted" from "GitHub could not be asked" would render an outage
   * as a fact about the PR, exactly the merged-0/160 trap MASTER-PLAN's own fixture warns about.
   * {@link BoardDeps} (lib/board.ts) tells the two apart via `readFailed()`, the same W1-T119
   * split every other optional method on this interface already uses.
   *
   * OPTIONAL, like every other method added after the first {@link GitHub} fixtures were written
   * — omitted ⇒ the console renders every row's review state as unresolved ("none"/unknown)
   * rather than inventing a pending or green state it never observed, the same fail-soft
   * discipline this whole interface already follows.
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
  /**
   * Clock for {@link StatusProjection.elapsedMs} (W1-T155); defaults to `Date.now`.
   * Injectable so a test can assert an exact elapsed value without a real sleep.
   */
  now?: () => number;
  /**
   * MONOTONIC UNDER DARKNESS (W1-T179): the LAST successfully-observed projection for a
   * task, consulted ONLY when this cycle's GitHub read has genuinely failed
   * ({@link GitHub.readFailed}) and every precedence rung above resolved nothing fresh.
   * Lets a caller (e.g. {@link projectPlan} reading its own `state/status.json` cache
   * before overwriting it, or a long-lived server keeping its last snapshot in memory)
   * hand back what was true before the gap, so a fetch failure never regresses a
   * credited task to `queued`. Omitted, or returning `undefined` for a given taskId, falls
   * back to the pre-W1-T179 behavior (`queued`/`throttled`) — the same fail-soft discipline
   * every other optional dependency here already follows.
   */
  previousProjection?: (taskId: string) => StatusProjection | undefined;
  /**
   * BATCHED rung (c2) corroboration (W1-T257): a per-task lookup into the merged-PR head-branch
   * index that {@link projectPlan} fetches ONCE per projection and shares across every task — so
   * #737's per-task {@link GitHub.findMergedByHeadBranch} call collapses to a single `gh pr list`
   * per cycle (five 07-23 GraphQL exhaustions were the multiplier this removes). Returns the
   * OWNED merged candidates for a task (client-side matched from the one fetch, `run-<taskId>-*`),
   * an EMPTY array when the batch succeeded but the task has no such branch, or `null` when the
   * BATCHED fetch itself FAILED — in which case {@link derivePrPrecedence} falls back to the
   * per-task {@link GitHub.findMergedByHeadBranch}, and if THAT also fails, `readFailed()` defers
   * via W1-T119, never a false none. Omitted ⇒ the per-task fetch is used directly, exactly as
   * #737 — the same fail-soft discipline every other optional dependency here follows.
   */
  mergedHeadBranches?: (taskId: string) => PrRef[] | null;
  /**
   * The OPEN twin of {@link DeriveDeps.mergedHeadBranches} (W1-T377): this task's OPEN PRs
   * whose head branch is `run-<taskId>-*`, from {@link projectPlan}'s one batched fetch. Backs
   * the (c3) rung — the only thing in this file that can see an open PR the ledger never
   * recorded (see {@link GitHub.listOpenHeadBranches} for the measured incident).
   *
   * SAME "ABSENT ⇒ SKIP" CONTRACT every other optional dependency here follows: `undefined`
   * (no batched index provided) falls back to the per-task {@link GitHub.listOpenHeadBranches},
   * and `null` (the batched read FAILED) skips the rung entirely so `readFailed()`/W1-T119 does
   * the deferring rather than this rung inventing an absence.
   */
  openHeadBranches?: (taskId: string) => PrRef[] | null;
  /**
   * LIVENESS BOUND (W1-T179 design (ii)): how many milliseconds of ledger silence a
   * dispatched, unresolved run tolerates before it is no longer "running" absent an open
   * PR — a data threshold, injectable so a test can assert the boundary without a real
   * sleep (mirrors {@link DeriveDeps.now}). Defaults to {@link DEFAULT_LIVENESS_BOUND_MS}.
   */
  livenessBoundMs?: number;
  /**
   * W1-T2392 — id -> the merged PRs naming it in their own prose, built ONCE by
   * {@link projectPlan} from the merged list it already fetches for W1-T257's batching. Supplied
   * rather than derived here on purpose: a second `listMergedHeadBranches()` call would break
   * W1-T257's own guard, which counts batched fetches. Absent ⇒ {@link
   * StatusProjection.uncreditedBuild} is never set and derivation is exactly as it was.
   */
  proseNamedTaskIds?: Map<string, UncreditedBuildWarning[]>;
  /**
   * THE INFLIGHT-LOCK ANCHOR (the third disjunct beside `hasOpenPr`/`recentActivity`): the
   * task's current in-flight lock holder, or `null` when no lock is held. ABSENT ⇒ SKIP —
   * omitting it degrades this rung to exactly the pre-existing two-disjunct behaviour, the
   * same "absent ⇒ skip" contract {@link DeriveDeps.mergedHeadBranches} already uses, so
   * every call site that predates this is unaffected.
   *
   * WHY A LOCK AND NOT ANOTHER LEDGER STEP. {@link DeriveDeps.livenessBoundMs} infers
   * liveness from ledger CHATTER, which a genuinely-live run can stop producing: measured
   * over the unioned ledger, 96 of 664 runs (14.5%) contain an intra-run gap longer than the
   * 30-minute bound, so a working run that goes quiet renders as not-running. The lock is
   * OBSERVED STATE rather than an event, so it covers the quiet stretch that no start/terminal
   * step table can — and terminals cannot be enumerated their way out of it: of 143 runs with
   * a `run.start` and no `verdict`, 106 end at `settings.validated`, an EARLY step, because
   * the process died and wrote no terminal at all.
   *
   * NOT TRUSTED ALONE, DELIBERATELY. A lock file outlives its process: `withInflightLock`
   * releases in a `finally`, and there are NO signal handlers anywhere in src/, so SIGKILL —
   * and SIGTERM, which Node's default terminates on without unwinding — both leave the file
   * behind (`sweepStaleInflightLocks`' own doc records `W1-T1.lock` holding a pid dead for two
   * days). It is therefore paired with {@link DeriveDeps.isPidAlive} below, which is the same
   * `isStale` predicate `reclaimStaleLock` already conditions its own reclaim on.
   */
  inflightHolder?: (taskId: string) => { pid: number; host?: string; startedAt?: string } | null;
  /**
   * Liveness probe for {@link DeriveDeps.inflightHolder}'s pid; defaults to
   * {@link defaultIsPidAlive} (`kill(pid, 0)`, treating `EPERM` as alive). Injectable so a
   * test can assert the dead-holder arm without spawning a process.
   *
   * W1-T368: no longer the WHOLE story. `kern.maxproc` is 4000 on the fleet host, so the pid
   * space wraps often and a recycled pid used to make a dead holder read as live forever — this
   * probe alone never distinguished "some process owns this number" from "the process that wrote
   * the lock owns it". `deriveStatus` now runs it through the same {@link isHolderStale} every
   * `reclaimStaleLock` caller shares (paired with {@link DeriveDeps.getProcessStartTime} below),
   * so a holder whose `host`/`startedAt` don't check out is judged stale even while this probe
   * alone would still say alive. It remains a REASON TO BELIEVE a run is live, never proof —
   * which is exactly why it is a third disjunct beside the other two and never a replacement.
   */
  isPidAlive?: (pid: number) => boolean;
  /**
   * Process-start-time probe for {@link DeriveDeps.inflightHolder}'s `startedAt` comparison —
   * forwarded to {@link isHolderStale}. Defaults to
   * {@link import("./fs-race-safe.js").defaultGetProcessStartTime}. Injectable so a test can
   * assert the pid-reuse arm without a real subprocess or a real pid wrap.
   */
  getProcessStartTime?: (pid: number) => number | null;
  /**
   * W1-T485 — OPT-IN, and absent by default ON PURPOSE. When supplied, {@link projectPlan} asks
   * this for every UNMERGED task and attaches {@link StatusProjection.supersededBy} where it finds
   * a commit that shipped the task's own proof symbol under a DIFFERENT task's trailer. Omitted,
   * no search runs and no field is emitted, so the 250ms-polled console pays nothing — see
   * {@link buildGitLogSupersessionSearch}'s note on why this is not wired into a hot path.
   */
  supersessionSearch?: SupersessionSearch;
  /**
   * W1-T951: where the durable {@link CreditStore} lives — defaults to
   * {@link defaultCreditStorePath}(`ledgerPath`) when omitted. Injectable so a test (or a caller
   * sharing one store across many per-task ledger directories) can point elsewhere without
   * touching a real file.
   */
  creditStorePath?: string;
  /**
   * Reader for the durable credit store; defaults to {@link loadCreditStore} against
   * `creditStorePath`. Injectable so a test can hand a canned {@link CreditStore} directly —
   * the route acceptance test "a branch-only id is credited from the durable record" uses to
   * prove the resolution never touches `deps.github` at all, not even indirectly through a real
   * file read.
   */
  readCreditStore?: () => CreditStore;
  /**
   * Writer for the durable credit store; defaults to {@link saveCreditStore} against
   * `creditStorePath`. Called by {@link derivePrPrecedence} whenever a live rung (trailer or
   * head-branch) discovers a credit the store does not already have, so a LATER derivation for
   * the same task never needs to read GitHub again (design (ii): durable, not dependent on
   * GitHub retaining the head ref). {@link projectPlan} overrides this to batch every task's
   * writes into ONE save at the end of the plan sweep, the same shape it already uses for the
   * ledger read and the two batched head-branch indexes just below.
   */
  writeCreditStore?: (store: CreditStore) => void;
}

/**
 * Default LIVENESS BOUND (W1-T179 design (ii), 30 minutes): a dispatched task with no
 * terminal verdict and no ledger line newer than this is no longer trusted as "running"
 * absent an open PR — the bound the W1-T1 crash-era spin-loop (27h21m, no PR, no fresh
 * ledger activity) blows past by two orders of magnitude, while comfortably tolerating a
 * slow `pollToGate`/`waitForCiGreen` cadence (a `ci.polling`/`pr.polling` line at most
 * every 5 * 6s = 30s while a PR is open — and an open PR bypasses this bound entirely).
 */
export const DEFAULT_LIVENESS_BOUND_MS = 30 * 60_000;

/**
 * The minimal fs surface {@link readLedgerLines} needs to read the ledger — deliberately
 * exposes ONLY `existsSync`/`readFileSync`, no write/copy capability at all (W1-T115: the
 * 26,711-dir ENOSPC incident's rationale suspected every read copies the ledger into a
 * temp dir first; that was never true, and this injectable surface is what lets a test
 * prove it STRUCTURALLY — an injected fake that only implements these two methods cannot
 * possibly be made to create a temp copy, rather than merely asserting-by-inspection that
 * the real fs module happened not to be called this way).
 */
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
//
// DESIGN DECISION (i), RECORDED IN WRITING per the shard's own requirement: the durable record
// belongs at THIS layer — `src/lib/status.ts`, inside `derivePrPrecedence` — not a new one
// bolted on above `deriveStatus`/`projectPlan`, and not inside `drain.ts`. Every construction
// site that reads `projection.merged` (status-board.ts:1325, panel-graph.ts:1018,
// run-task.ts:10621/:12292) goes THROUGH `deriveStatus`/`projectPlan`; neither rung (c)'s
// trailer search nor rung (c2)'s `corroborateByBranch` persists anything today (rationale (3)),
// and both already live in this one module. Adding a store here means every existing caller of
// `deriveStatus`/`projectPlan` gets the fix for free — the SAME "optional dep, real default"
// shape `readLedger`/`mergedHeadBranches`/every other {@link DeriveDeps} field already uses — with
// zero wiring changes at any of those four construction sites, so `run-task.ts` stays undeclared
// exactly as the shard's note requires (W1-T471: declaring the monolith serialises every task
// naming it).
//
// WHY NOT A NEW LAYER (e.g. a `credit.ts`, or a ledger step): a new module would need its own
// copy of the "read once per `projectPlan` call, write once at the end" batching
// `readLedgerLines`/`mergedHeadBranches` already solved for the identical N-tasks-per-projection
// shape a few lines below — reinventing it, not reusing it. A ledger step (`credit.recorded`)
// was considered and rejected: the ledger is PER-TASK (`deps.ledgerPath` is scoped to one task's
// state directory in the real caller — see `derivePrPrecedence`'s existing ledger reads), while
// credit needs to be looked up FOR a task from a store that does not require that task to have
// ever produced ledger output of its own (a durable record must survive precisely the case the
// ledger cannot: nothing local to the task's own history, only the fact that some PR merged it).

/** One path's persisted merge credit for a task — see {@link CreditStore}. */
export interface CreditStoreEntry {
  source: "trailer" | "head-branch";
  prUrl: string;
  prNumber: number;
  prState: string;
}

/**
 * DELIVERABLE A — the durable, GitHub-independent record of merge credit. Keyed by task id,
 * then by the path that credited it, so a caller can tell in O(1) whether a task's credit rests
 * on ONE path or BOTH: {@link branchOnlyCreditedIds} / {@link singlePathCreditedIds} /
 * {@link isSinglePathCredited} (deliverable B) are pure functions over exactly this shape.
 * Persisted as JSON at {@link defaultCreditStorePath} (sibling of the ledger directory) unless a
 * caller injects {@link DeriveDeps.readCreditStore}/{@link DeriveDeps.writeCreditStore}.
 */
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

/**
 * Reads the durable store — `{}` on a missing OR corrupt file, never a throw: the store is an
 * ACCELERATOR/ARCHIVE, not the sole route to a credit (every live rung below still runs when the
 * store has nothing), so a read failure here must degrade to "nothing durable yet" exactly like
 * `readLedgerLines`' own malformed-line handling, never propagate into a caller that has no
 * reason to expect this optional layer to throw.
 */
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
 * Writes the durable store ATOMICALLY (temp file + rename, the SAME pattern `projectPlan`'s own
 * `state/status.json` cache write already uses just below, for the identical reason: a reader
 * mid-`writeFileSync` must never observe a torn/truncated store). BEST-EFFORT: a write failure
 * (an unwritable/nonexistent directory — every existing test's `ledgerPath` points at one) is
 * swallowed, never thrown — the projection that discovered this credit is already correct and
 * returned regardless of whether the store write that would speed up the NEXT call succeeds; the
 * next successful write (this task's or another's) catches the store up. Mirrors the
 * absent/failed-⇒-skip discipline every other optional {@link DeriveDeps} dependency follows.
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

/**
 * Merges one newly-discovered credit into the store, immutably. Idempotent: a source already
 * recorded for this task is left untouched (no churn on every re-derivation of an
 * already-durable task — which in practice never happens anyway, since the durable rung in
 * {@link derivePrPrecedence} returns before this would ever run again for that task/source pair,
 * but the guard keeps the function correct standing alone too).
 */
export function recordCredit(store: CreditStore, taskId: string, entry: CreditStoreEntry): CreditStore {
  const existing = store[taskId] ?? {};
  if (existing[entry.source]) return store;
  return { ...store, [taskId]: { ...existing, [entry.source]: entry } };
}

/**
 * DELIVERABLE A's enumeration, AS AN OUTPUT of the change (design (ii)): every id whose durable
 * record has a `"head-branch"` entry and NO `"trailer"` entry — exactly the population rationale
 * (2) measured as fragile (18 ids, credited by a ref GitHub deletes from the repository on
 * merge). Sorted for a deterministic report/test diff.
 */
export function branchOnlyCreditedIds(store: CreditStore): string[] {
  return Object.keys(store)
    .filter((id) => {
      const paths = store[id];
      return !!paths["head-branch"] && !paths.trailer;
    })
    .sort();
}

/**
 * DELIVERABLE B: every id credited by EXACTLY ONE of the two paths, either direction — the
 * discoverable signal design (iii) requires. The defect is not that single-path credit exists;
 * it is that it is indistinguishable from double-path credit until the single path disappears.
 * This makes the distinction queryable in advance, over the whole store, not just the one task a
 * live derivation happens to be looking at.
 */
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
 * {@link readLedgerLines}' return type: a plain `Array<Record<string, unknown>>` for every
 * existing consumer (dozens of call sites type it that way — `deps.readLedger?: (path) =>
 * Array<Record<string, unknown>>` and friends — so this stays structurally assignable to
 * that with zero call-site churn), PLUS a `torn` count attached as a NON-ENUMERABLE own
 * property (W1-T206). Non-enumerable specifically so `assert.deepEqual`/`deepStrictEqual`
 * against a plain array literal — used throughout the existing test suite to assert on
 * ledger content — keeps working unchanged: `Object.keys`/`JSON.stringify`/`for..in`/the
 * generic own-enumerable-property walk `assert.deepEqual` does for any object never see it,
 * exactly like a real array's own `.length` is also non-enumerable and invisible to that
 * same walk. A consumer that specifically wants to know whether a line was lost THIS read
 * reads `.torn` by direct property access (which does not care about enumerability) instead
 * of having no way to find out short of scraping stderr.
 */
export type LedgerLines = Array<Record<string, unknown>> & {
  /** Count of unparseable/torn lines dropped THIS read (0 when every line parsed clean). */
  readonly torn: number;
  /**
   * Whether the ledger FILE existed for this read. `false` is the ONLY thing that distinguishes
   * "there is no ledger at this path" from "the ledger is there and has nothing to say" — both
   * of which return an empty array, and which no consumer could previously tell apart.
   *
   * THIS IS THE SAME DEFECT `torn` WAS ADDED FOR (W1-T206, above): an absence that fabricates
   * itself into a legitimate-looking empty result leaves no audience — human or consumer — able
   * to learn that anything was missing. `GET /v1/control/status` is where it bit: a dead daemon
   * (ledger present, last poll stale) and a ledger that is not there at all rendered the same
   * `daemonLive: undefined`, so the console could decline to say the fleet was alive but could
   * never say it was dead. See `deriveDaemonLiveness` (lib/panel-actions.ts) for the taxonomy
   * this field makes expressible.
   *
   * NON-ENUMERABLE for exactly `torn`'s reason — every `assert.deepEqual` against a plain array
   * literal across the existing suite keeps working, and the ~50 call sites that type this as a
   * bare `Array<Record<string, unknown>>` are structurally unaffected. A consumer that wants the
   * answer reads `.present` by direct property access.
   *
   * NOT SET BY AN INJECTED READER. `LedgerReader` is `(path) => Array<Record<string, unknown>>`,
   * so a test fake returns a plain array whose `.present` is `undefined`. That is deliberate and
   * must stay readable as "this reader did not report presence", never as "absent" — a consumer
   * may only act on an explicit `false`. `deriveDaemonLiveness` follows that rule.
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

/** Default NDJSON ledger reader: one JSON object per non-blank line. Reads the ledger
 * file directly via the injected (real, by default) fs — never copies it anywhere first.
 * A line that fails to parse (e.g. a torn append — see ledger.ts's `appendLedger` doc for
 * why that should be rare in practice, but a crash mid-write can still truncate the final
 * line, and no write-side mechanism can fully rule that out) is
 * LOUD, not silent, in TWO ways (W1-T206): `console.error`-logged with the offending path
 * and raw text for a human watching stderr, AND counted into the returned array's `.torn`
 * property for a CONSUMER that has no stderr to watch — the previous fabricated-`{}`-per-
 * torn-line behavior left no way for either audience to tell a line was lost at all. This
 * ledger backs the per-task dispatch circuit breaker (`isDispatchBreakerTripped`/
 * `dispatchesWithoutNewOwnedPr` below) as well as provenance, so a torn `pr.opened` (falsely
 * leaving the breaker tripped) or a torn `run.start` (undercounting toward it) both need to
 * be visible, not silently absorbed into an empty record no consumer could distinguish from
 * a genuinely uneventful line. */
/**
 * How many dated rotations {@link readLedgerUnionBounded} will open before giving up, newest first.
 *
 * MEASURED on the live host (669 rotations): the live file plus the NINE newest rotations contained
 * at least one row of every step the status board reads, and parsing that set cost 0.23s / 0.11 GiB.
 * The full union costs 7.74s / 2.57 GiB through `rmd emissions` — the price this cap exists to
 * refuse. 24 is that measured 9 with headroom for a busier day, and reading all 24 was measured at
 * 0.21s, so the cap is cheap even when the early exit never fires.
 */
export const STATUS_BOARD_MAX_ROTATIONS = 24;

/**
 * How many rotations {@link readMergeCreditedTaskIds} may open before giving up on a task it has
 * not yet found a credit for.
 *
 * MEASURED on this host's real 666-gz/3-plain/1-live corpus, over BOTH credit spellings: every one
 * of the 445 ever-credited ids resolves within 24 files, and the depth distribution is
 * median 0, p90 0. The only ids needing more than 8 are `SBX-T1`/`SBX-T2`/`SBX-T3`/`SB-HELLO`/
 * `CI-GREEN-PROBE` at depth 21 — WS-1 sandbox probe ids that appear in `plan/` only inside a
 * `satisfied_by` PROSE string, never as a task id, so `buildCreditCandidates` (which iterates
 * `plan.tasks`) can never ask about them. For the ids it CAN ask about, the deepest is under 8.
 *
 * COST, measured on the same corpus: 1 file 21 ms / 3.3 MiB, 8 files 197 ms / 16.8 MiB, 24 files
 * 598 ms / 20.4 MiB. The full union is 11.42 s / 0.11 GiB — the price this cap exists to refuse,
 * and a per-pass full-corpus read would be far worse than the treadmill it replaces.
 *
 * THE CAP IS SAFE IN THE DIRECTION THAT MATTERS, which is why a bound is acceptable here at all.
 * This reader only ever ADDS ids it has actually seen, so it cannot invent a credit. Reading too
 * shallow therefore degrades to EXACTLY today's behaviour (the task is re-credited); it can never
 * strand real work by falsely reporting a task already credited. Under-read is cheap and
 * self-correcting; over-report would be the dangerous direction and is unreachable by construction.
 */
export const CREDIT_SCAN_MAX_ROTATIONS = 24;

/**
 * Every task id the ledger has EVER recorded merge credit for, read across all three ledger forms,
 * newest-first, stopping as soon as every `candidate` is resolved.
 *
 * WHY THIS EXISTS — `runCreditBackfill` asked `hasMergeCredit` against `readLedgerLines`, WHICH
 * OPENS EXACTLY ONE FILE. `verdict.merged` and `verdict`/`merged` are both registered in
 * `DECISION_RELEVANT_LEDGER_STEPS`, and the comment on {@link isMergeCreditLine} concluded from that
 * "rotation cannot drop either out from under a reader" — WHICH IS FALSE, and is the belief that
 * hid this defect. Registration stops a step being shed COMPLETELY; it does nothing about
 * `MAX_RETAINED_LINES_PER_STEP`, which keeps only the newest 200 rows PER STEP. Credit older than
 * that leaves the live file, the backfill cannot see it, the task is re-credited, and the fresh row
 * evicts another — self-sustaining.
 *
 * MEASURED at 2026-08-13 on the live corpus, and the arithmetic is exact:
 *   distinct tasks carrying `verdict.merged` in the live file : 385
 *   MAX_RETAINED_LINES_PER_STEP                               : 200
 *     => credits rotation drops                               : 185
 *   `sweep.credit_backfill` rows in the live file             : 185   <- exact match
 * Amplification over the whole corpus: 61,903 `verdict.merged` rows across 386 distinct tasks
 * (160x), with many unrelated ancient tasks sitting at EXACTLY 670 rows apiece — an identical count
 * across unrelated tasks is a systematic signature, not organic activity. And it was not
 * converging: 6,759 corrections across 4,722 full sweeps = 1.43 per sweep, sustained.
 *
 * WHY A SET AND NOT `LedgerLines`. {@link readLedgerUnionBounded} returns every line it read, which
 * is right for a rendering surface that matches steps by prefix but wrong here: this runs on every
 * full sweep and would hold ~20 MiB of raw JSON as parsed objects for a question whose whole answer
 * is a set of ids. Accumulating only the ids keeps the memory bounded by the plan, not the corpus.
 *
 * IT SHARES {@link ledgerRotationEntries} DELIBERATELY. That function is "the one definition of
 * which files in a state dir are ledger rotations", and a fourth spelling of it is the defect this
 * repo keeps re-filing. Callers differ only in how they READ each form and what they accumulate —
 * the difference that is real.
 */
export function readMergeCreditedTaskIds(
  path: string,
  opts: {
    /** Stop as soon as every one of these has been resolved. Omitted ⇒ read to the cap. */
    candidates?: Iterable<string>;
    maxRotations?: number;
    /**
     * The LIVE half only. Exists so a caller that already has an injected ledger reader (every
     * `runCreditBackfill` test does) keeps controlling the live file exactly as before, while the
     * rotations still come from the real corpus — ONE code path, not a legacy branch beside a new
     * one. A temp-dir fixture has no rotations, so an injected reader behaves identically to today.
     */
    readLive?: (path: string) => Iterable<Record<string, unknown>>;
    ledgerFs?: LedgerFsDeps;
    readdirSync?: (dir: string) => string[];
    gunzipSync?: (buf: Buffer) => Buffer;
    readFileBuffer?: (p: string) => Buffer;
  } = {},
): { credited: Set<string>; filesRead: number; complete: boolean } {
  const credited = new Set<string>();
  const wanted = new Set(opts.candidates ?? []);
  // O(1) per line: decrement a counter rather than re-testing the whole candidate set. The board
  // reader's own doc records what the naive form costs — re-scanning a growing array per rotation
  // cost ~2s of wall time — and a bounded read is only cheap if the stop test is cheap too.
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

/**
 * The ledger union a RENDERING surface needs: the live file plus dated rotations, NEWEST FIRST,
 * stopping as soon as `satisfied` is met or {@link STATUS_BOARD_MAX_ROTATIONS} files are open.
 *
 * WHY THE BOARD CANNOT USE {@link readLedgerLines}: that opens exactly ONE path. `rotateLedger`
 * keeps only `MAX_RETAINED_LINES_PER_STEP` per step and only for steps in a retention set, so a
 * step in NO set is shed COMPLETELY and the live file can never hold one. MEASURED: `daemon.summary`
 * had **0 live rows against 524 in rotations** — which is why `rmd status` reported `no cycle
 * recorded` on a host with 524 recorded cycles.
 *
 * IT RETURNS EVERY LINE IT READ, UNFILTERED, and that is deliberate rather than lazy. The board
 * matches `deploy.` BY PREFIX (`step.startsWith("deploy.")` in status-board.ts), so a reader that
 * filtered to an exact step list would silently drop the supervisor-tick rung. Returning whole files
 * keeps every consumer's own matching intact.
 *
 * THE EARLY EXIT IS THE POINT AND THE CAP IS ITS BACKSTOP. Every rung this serves reads the NEWEST
 * row of a step, never a count, so stopping early cannot under-count anything. The cap protects the
 * other direction: a step that is never found would otherwise walk all 669 files and pay the full
 * union price.
 */
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
  // O(1) per line, accumulated ONCE. An earlier revision handed the whole growing array to the
  // predicate on every rotation, which re-scanned 173k lines nine times and cost ~2s of board wall
  // time — a bounded read is only cheap if the stop test is cheap too.
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
 * THE LIVE FILE ALONE — one path, opened, parsed, returned. Nothing else. `readLedgerLines`
 * never resolves rotations and never assembles the archive∪live union; a caller that wants that
 * calls {@link readLedgerUnionBounded} (or hand-rolls it, as {@link readMergeCreditedTaskIds}
 * does) — this function is just the primitive both of those extend.
 *
 * THAT MAKES A BARE CALL AMBIGUOUS AT THE CALL SITE (W1-T1262): a live-file read and "the first
 * step of a union read" are the SAME call, so nothing here tells a reviewer which one a given
 * caller meant. This function's signature is deliberately left unchanged — narrowing it would
 * either break every one of its real callers in one PR or reintroduce the same unmarked choice
 * one level up through a shared façade (W1-T1262's design note, options (b)/(c) and their
 * costs). Instead, every call to {@link readLedgerLines} — checked by
 * {@link ledgerReadIntentViolations} — must carry a `ledger-read-intent: live` or
 * `ledger-read-intent: union` comment on the same line or the line directly above, so the choice
 * is greppable at the call site instead of only inferable from behaviour.
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
 * The two ways a `readLedgerLines` call can be answered — and the only two a caller may declare.
 * `"live"` is exactly what {@link readLedgerLines} always returns: the newest rows, nothing
 * else — the right (and only) answer for something like `rmd doctor`, which wants "what just
 * happened", never twenty archives of it. `"union"` names a call that is itself the seed of an
 * archive∪live assembly, the way {@link readLedgerUnionBounded} and
 * {@link readMergeCreditedTaskIds} both extend one with rotations. Neither value ever changes
 * what {@link readLedgerLines} returns — declaring `"union"` on a bare call does not make it
 * read rotations, the call site must actually do that too — this type only makes the caller's
 * CHOICE a visible fact instead of an inferred one (W1-T1262).
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

/**
 * THE CALLER-SIDE HALF of the structural fix W1-T444 already gave the resolver side
 * (`resolveLedgerUnion`'s coverage refusal, `ledgerRotationEntries` as the one definition of the
 * corpus) — see W1-T1262's rationale for why that task closed only the resolver hole. This is
 * design option (a) from that task: a lint-style source scan, the same house pattern
 * `test/no-raw-nul.test.ts` and `test/no-hand-rolled-fetch-check.test.ts` already use — cheapest,
 * and it needs no call-site ARGUMENT edits, only a declaring comment next to each call.
 *
 * Every call to {@link readLedgerLines} in a given file — other than the function's own
 * definition — is a VIOLATION unless the same line, or the line immediately above it, matches
 * `ledger-read-intent: live` or `ledger-read-intent: union`. Both markers PASS equally: this
 * function polices only whether a choice was DECLARED, never which choice was correct for that
 * call site — auditing the ~50 pre-existing callers for which one they SHOULD declare is exactly
 * the reclassification work W1-T1262's design note (iv) leaves out of scope.
 *
 * Takes `{ path, text }` pairs rather than reading disk itself, so a caller controls IO: the
 * real repo via `git ls-files` + `readFileSync` (mirroring `rawNulViolations` in
 * `test/no-raw-nul.test.ts`), or a planted fixture in a unit test.
 */
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

/**
 * The minimal extra fs surface an INCREMENTAL reader needs on top of {@link LedgerFsDeps}: the
 * current file size, and the bytes from `start` to EOF — never the whole file. Deliberately
 * property-accessed off the same mutable `fs` default import at call time (see this module's
 * header note on why), so a test spying on `fs.statSync`/`fs.openSync`/`fs.readSync` observes
 * every real call, exactly like {@link LedgerFsDeps}'s existing two methods already promise.
 */
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
 * Persistent state a {@link readLedgerTail} caller holds ACROSS calls (one per long-lived route/
 * connection, never reconstructed per render — mirroring board.ts's own `RecentActivityCache`/
 * `BoardSnapshotCache`/SSE `lastLineCount` handles). `lines` is the SAME array reference handed
 * back on every call and only ever appended to, never rebuilt — a caller may hold onto a prior
 * return value across calls and it stays valid (append-only, same identity).
 */
export interface LedgerTailCache {
  /** @internal — byte offset already consumed. */
  offset: number;
  /** @internal — a not-yet-newline-terminated trailing partial line, carried to the next read. */
  pending: string;
  /** @internal — cumulative parsed lines; never re-parsed once minted. */
  lines: Array<Record<string, unknown>>;
  /** Cumulative count of unparseable/torn lines dropped across every read this cache has ever
   *  done (W1-T206) — never re-derived, only ever incremented, so it survives everything
   *  `lines` survives (including a rotation event that freezes rather than wipes `lines` —
   *  see {@link readLedgerTail}'s doc). */
  torn: number;
}

export function createLedgerTailCache(): LedgerTailCache {
  return { offset: 0, pending: "", lines: [], torn: 0 };
}

/**
 * INCREMENTAL ledger read (W1-T184): only the bytes appended since `cache`'s last read are ever
 * pulled off disk and parsed; an UNCHANGED file costs exactly one `statSync` call — no `open`/
 * `read` at all, and NO re-parse of a single already-seen line. This is the fix for {@link
 * readLedgerLines} being a full file re-read on every call, which is fine for the many one-shot
 * CLI callers but wrong for a route polled every ~250ms (lib/board.ts's DEFAULT_POLL_MS) against a
 * ledger that only ever grows — the "a console refresh degrades into an O(history) operation" bug
 * behind both the RECENT feed's per-render cost and GET /v1/status's 2026-07-20 latency outage
 * (a `createBoardSnapshotCache` hit still paid a full re-read+re-parse of the WHOLE ledger just to
 * compute its cache key, before this fix). Returns the SAME cumulative array every call (append-
 * only, never rebuilt) — a caller may safely hold a reference across calls. A file shorter than
 * last observed (rotation/truncation — the append-only ledger writer itself never does this)
 * degrades safely by rescanning from byte 0, mirroring computeRecentActivity's own "ledger got
 * shorter -> rescan from scratch" rule at the line-cursor layer above this one.
 */
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

/**
 * The PR-precedence fields ONLY from a prior {@link StatusProjection} (W1-T179) — `taskId`/
 * `status`/`merged`/`source`/`pr*`/`rejected_candidates`, deliberately EXCLUDING the taxonomy
 * layer `deriveStatus` adds on top (`phase`/`startedAt`/`elapsedMs`/`needsHuman`/
 * `armedAwaitingMerge`/`indeterminate`/`unavailableReason`/`githubUnobservableSince`). The
 * darkness fallback below carries this forward as its `base`; the taxonomy layer is then
 * RE-DERIVED fresh from the ledger (still readable during a GitHub-only outage) exactly as
 * any other call — carrying it forward unfiltered would leak a STALE `needsHuman`/`phase`
 * that a later, un-observed ledger event already superseded (`deriveStatus` only ever SETS
 * those flags true from a fresh scan, never clears a stale `true` it did not itself derive).
 */
function priorPrecedence(p: StatusProjection): StatusProjection {
  const out: StatusProjection = { taskId: p.taskId, status: p.status, merged: p.merged, source: p.source };
  if (p.prNumber !== undefined) out.prNumber = p.prNumber;
  if (p.prUrl !== undefined) out.prUrl = p.prUrl;
  if (p.prState !== undefined) out.prState = p.prState;
  if (p.rejected_candidates !== undefined) out.rejected_candidates = p.rejected_candidates;
  return out;
}

/**
 * Parse a PR number off the END of a ref/url string (W1-T130) — pure text parsing,
 * never a gateway call. Backs ONLY the correction rung's `prNumber` decoration: a
 * correction's `actual_pr_url` is trusted TEXT, never re-resolved via `prByRef`
 * (see {@link derivePrPrecedence}'s SUPREME OFFLINE note), so there is no `PrRef`
 * to read `.number` off of. Mirrors board.ts's `prNumberFromUrl` in spirit but
 * matches trailing digits generally (not just after a literal `/pull/`) since a
 * real gateway's `PrRef.url` is always `.../pull/<n>` but a test fixture's
 * shorthand ref (`"u/51"`) is not — undefined when the string doesn't end in
 * digits, which only ever degrades the decoration, never the (unconditional)
 * merged verdict above it.
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

/** The most recent `pr.opened` ledger line for a task id, if any. */
function lastPrOpened(
  lines: Array<Record<string, unknown>>,
  taskId: string,
): string | undefined {
  let url: string | undefined;
  for (const line of lines) {
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
  /** OPTIONAL: a FULL PR url (self-describing its own owner/repo), never a bare number —
   *  the shape that lets this credit name a PR in ANY repository, not just the one the
   *  calling {@link GitHub} gateway happens to be scoped to. */
  prUrl?: string;
}

/**
 * The most recent `manual.completed` ledger line for a task id (last one wins, same
 * "last assertion wins" convention as {@link lastPrOpened}/{@link latestActualPrUrl}) — an
 * explicit, ACTOR-AND-TIME-STAMPED assertion (W1-T1029 rationale (6)) that a hand-executed
 * task was completed, widening rung (b)'s `task.pr` to the two shapes it structurally cannot
 * express: a completion PR in ANOTHER repository (`task.pr` is a bare number, resolved by
 * {@link GitHub.prByRef} against ONLY the calling gateway's own configured repo — a
 * `remudero-site` PR is unreachable that way), and a completion with NO PR at all, because
 * none will ever exist (a manual task whose deliverable is a live action, e.g. a
 * commissioning drill, not a diff).
 *
 * A line qualifies ONLY with both `actor` and `ts` present as non-empty strings — a line
 * missing either is not a genuine assertion and is silently skipped, the same "malformed
 * line, ignore it" discipline every other ledger reader in this file already applies (see
 * {@link lastPrOpened}'s own `typeof` guard). `ts` is the ledger's own write-time stamp
 * ({@link appendLedger} always sets it), never a second, independently-suppliable field, so
 * the assertion's time can never drift from when it was actually recorded.
 *
 * REVERSIBLE THE SAME WAY EVERY RUNG BELOW THE CORRECTION RUNG ALREADY IS (rationale (8)): a
 * later `correction.provenance` row is checked FIRST, above every branch in
 * {@link derivePrPrecedence} including this one, and supersedes it outright — retracting a
 * wrong assertion never means deleting this line, only outranking it.
 */
export function latestManualCompletion(
  lines: Array<Record<string, unknown>>,
  taskId: string,
): ManualCompletion | undefined {
  let found: ManualCompletion | undefined;
  for (const line of lines) {
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
 * PER-TASK DISPATCH CIRCUIT BREAKER (MASTER-PLAN P29(ii)) — policy-as-data
 * (rule 2), never a hardcoded literal buried in a caller: how many times the
 * SAME task may be dispatched with no NEW owned PR opened since, before the
 * breaker trips. This is §9's per-WORKER runaway tripwire's per-TASK dual — the
 * W1-T1 storm (~130 dispatches / ~$130 / ~10h) tripped no per-run budget cap
 * because no single RUN ran away; the whole TASK did, across many independent
 * runs, and nothing bounded that. This is the BACKSTOP that makes P29(i)'s
 * sibling-credit fix safe to get wrong — even if a future bug reopens the
 * masking hole (i) closes, dispatch of one task cannot spin unbounded again.
 */
export const DEFAULT_MAX_TASK_DISPATCHES = 5;

/**
 * Does this ledger line record a MERGE CREDIT for its task — either a live run's own
 * terminal `verdict: "merged"`, or a `verdict.merged` correction appended by the
 * credit-backfill rung (sweep.ts's `runCreditBackfill`)?
 *
 * ONE DEFINITION, TWO CONSUMERS, DELIBERATELY. `sweep.ts`'s `hasMergeCredit` (the
 * backfill's own idempotence check) and {@link dispatchesWithoutNewOwnedPr}'s reset
 * below both call THIS — they are not two hand-maintained copies of the same shape.
 * The defect this predicate was extracted for is precisely two mechanisms holding the
 * same fact and never comparing notes; a second copy would reproduce it.
 *
 * Both step spellings are required and neither is redundant: a run that merges its own
 * PR writes `step: "verdict", verdict: "merged"`, while a merge the ledger MISSED at the
 * time is corrected later as `step: "verdict.merged"`. Both are in
 * {@link DECISION_RELEVANT_LEDGER_STEPS} (ledger.ts), registered for exactly this reason.
 *
 * CORRECTED 2026-08-13 — this comment used to conclude "so rotation cannot drop either out from
 * under a reader", AND THAT WAS FALSE. It is the belief that hid a live defect for months, so it is
 * corrected here rather than deleted. Registration stops a step being shed COMPLETELY; it says
 * nothing about `MAX_RETAINED_LINES_PER_STEP`, which keeps only the newest 200 rows PER STEP. A
 * registered step with more than 200 rows still loses its oldest to rotation. Any caller asking
 * "was this task EVER credited" therefore needs {@link readMergeCreditedTaskIds}, not a single-file
 * read — see that function for the measured arithmetic.
 */
export function isMergeCreditLine(line: Record<string, unknown>): boolean {
  return line.step === "verdict.merged" || (line.step === "verdict" && line.verdict === "merged");
}

/**
 * W1-T2425 — THE PRIOR COUNT THIS PROCESS DID NOT LIVE THROUGH.
 *
 * {@link evaluateDispatchBreakerDetailed}'s regression guard refuses a count that fell with
 * nothing in the ledger to explain it, but it can only refuse what it can COMPARE against, and
 * its `priorCount` comes from {@link DispatchBreakerCache.lastCounts} — an in-memory Map
 * `breakerGateFor` (run-task.ts) rebuilds PER INVOCATION. That function's own doc scopes its
 * claim honestly to a SAME-PROCESS rotation; a rotation plus a daemon RESTART was never covered,
 * because a brand-new process starts with nothing to compare against and reads a shortened live
 * file as forward progress. MEASURED on the fleet: W1-T1279 was refused every tick for 84 hours,
 * a rotation dropped its two oldest `run.start` rows, the daemon restarted across the same gap,
 * and the fresh process read `freshCount 3 < 5` and dispatched — with no line anywhere recording
 * a reset.
 *
 * THE EVIDENCE WAS ALREADY BEING WRITTEN, JUST NOT KEPT: the `dispatch.circuit_broken` row the
 * breaker's own refusal emits carries `freshCount` — the exact number the comparison needs (78 of
 * 78 rows on the fleet). It was archived by `rotateLedger`'s PASS 1 because the step belonged to
 * none of its three retention sets; this task adds it to `DECISION_RELEVANT_LEDGER_STEPS`, where
 * PASS 4's existing per-step cap bounds it exactly as it bounds `run.start`/`pr.opened`.
 *
 * NOT A WIDER READ: this reads the SAME `lines` the caller already loaded from the live file —
 * no second open, no archive, and `readLedgerLines`' `ledger-read-intent: live` contract at the
 * call site is untouched. NOT A RESET EITHER: a seeded prior can only make the INDETERMINATE arm
 * reachable, and indeterminate already means skip-and-retry, never dispatch.
 *
 * TWO KEYS, DELIBERATELY. The reset lines key the task on `task_id` (the same field
 * {@link dispatchesWithoutNewOwnedPr} filters on), but a `dispatch.circuit_broken` row is written
 * by the DAEMON's own run — its `task_id` is `"DAEMON"` and the task it refused is carried on
 * `task`. Reading `task_id` for both would silently seed nothing, which is a zero that looks
 * exactly like "this task never tripped".
 *
 * THE RESET MIRRORS THE COUNTER'S OWN. A `dispatch.circuit_broken` row OLDER than a `pr.opened`
 * or merge credit describes a streak that has since been legitimately cleared, so forward
 * progress discards the seed exactly as it zeroes the count — otherwise a task that tripped,
 * shipped, and dispatched once would compare its 1 against a stale 5 and refuse itself.
 *
 * The step literal is written INLINE rather than through a constant on purpose:
 * `test/ledger-rotation.test.ts` re-derives the decision-relevant set by scanning consumer
 * sources for an equality comparison against a quoted step name, so hiding this read behind a
 * symbol would blind the very gate that keeps the row from being archived again. That scan is
 * TEXTUAL, not syntactic — it reads comments too, so a doc that spells the comparison out
 * verbatim mints a phantom step and fails the gate. This paragraph describes it instead.
 */
export function seedCountFromCircuitBreak(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
): number | undefined {
  let seed: number | undefined;
  for (const line of lines) {
    if (line.task_id === taskId && (line.step === "pr.opened" || isMergeCreditLine(line))) {
      seed = undefined; // forward progress — the same reset the counter itself applies
      continue;
    }
    if (line.step !== "dispatch.circuit_broken" || line.task !== taskId) continue;
    const fresh = line.freshCount;
    // A row with no usable count records that a refusal happened, not what it decided on —
    // it must not seed a guess. Absence stays absence.
    if (typeof fresh === "number" && Number.isFinite(fresh) && fresh >= 0) seed = fresh;
  }
  return seed;
}

/**
 * How many `run.start` ledger lines exist for `taskId` SINCE its most recent
 * FORWARD-PROGRESS line (or in total, if it has never recorded one) — "dispatches
 * with no NEW owned PR" (P29(ii)'s own phrasing).
 *
 * WHAT COUNTS AS FORWARD PROGRESS, AND WHY IT IS NOT JUST `pr.opened`. The counter's
 * intent is "did this task produce work"; `pr.opened` was a PROXY for it, sound because
 * run-task.ts logs that line only after ITS OWN worker pushes ITS OWN
 * `run-<taskId>-<epochMs>` branch (worker.ts) — so no ownership check is needed here the
 * way rung (c)'s trailer search needs one. THE BRANCH CONVENTION BROKE THE PROXY. A task
 * whose PR lands on a slug-named branch (`run-W1-T377-open-pr-corroboration`) fails
 * `ownsBranch`'s `run-<taskId>-\d+$`, so no `pr.opened` is ever written, and the task is
 * recorded as MERGED by the credit-backfill and as MAKING NO PROGRESS by this counter at
 * the same time. MEASURED: W1-T377 and W1-T378 both shipped (#1386, #1391), both carry
 * `verdict.merged` from the backfill and `pr.opened` ×0, and both ran to exactly 5
 * dispatches against {@link DEFAULT_MAX_TASK_DISPATCHES} before tripping — 10 dispatches
 * re-running finished work.
 *
 * So a merge resets the streak too ({@link isMergeCreditLine}). This RESTORES the stated
 * intent rather than widening the rule: a merged task has self-evidently produced work,
 * and the doc below already said a PR that merely OPENS is enough. The evidence is sound
 * to reset a safety bound on — a `verdict.merged` line comes from `runCreditBackfill`,
 * whose candidates are built by `deriveStatus` (run-task.ts's `buildCreditCandidates`),
 * which re-verifies the trailer as its own exact anchored line locally (rung (c)) rather
 * than trusting GitHub's fuzzy body index, and which refuses to credit a plan-only
 * changeset as an implementation (W1-T413). It does NOT share the `--limit 1` weakness of
 * the raw `findMergedByTrailer` first pass.
 *
 * `pr.merged` is deliberately NOT here: any run reaching it already logged `pr.opened`,
 * so it would reset nothing that is not already reset.
 *
 * A fresh PR (even one that does not merge, e.g. blocked_ci) resets the count to 0 —
 * genuine forward progress is not what this breaker guards against; the W1-T1/W1-T29
 * shape is dispatch after dispatch producing NOTHING new. The "succeeds every time" loop
 * that resets on its own merge each pass is NOT this counter's remit and is unchanged:
 * {@link dispatchesEver} is the lifetime bound that catches it, and no step resets that.
 */
/**
 * W1-T2423 — THE RUN VERDICTS THAT MEAN THE TASK WORKER NEVER STARTED.
 *
 * Both are PREFLIGHT PROBES that run once per dispatch and refuse ahead of every worker;
 * run-task.ts says so on each in its own words — the containment probe confirms an outside-cwd
 * write is OS-denied "before any task worker runs", the isolation probe confirms a worker
 * inherits zero operator aliases "before any task worker (recon/implement) runs", and both FAIL
 * CLOSED. So a run that ends in either tested THE HOST, not the task, and nothing about this
 * task's own ability to open a PR was observed. Counting it toward "dispatched with no new owned
 * PR" measures the wrong thing.
 *
 * W1-T2249 IS SUBSUMED, NOT RE-LITIGATED. It established exactly this principle for ONE probe
 * failure mode — a probe worker that died on a 529 — and its own doc stated the general rule:
 * "A run refused for THIS reason never reached the task worker at all". It keyed the exclusion on
 * `check === "spawn-transport-failure"`, and that key is why it never fired: `check` is stamped at
 * WRITE time, so the rule is FORWARD-ONLY over a counter that reads history backwards. MEASURED
 * over the fleet's three-form union: all 94 `blocked_containment` rows across 63 distinct tasks
 * read `check: "outside-cwd-denial"`, and ZERO of 517 distinct verdict rows carry the transport
 * symbol — so its third conjunct has never once been satisfied, and W1-T1279's rows, written some
 * 31 hours before the symbol existed, could never have been reached by it at all. Every row that
 * arm matched is a strict subset of this set, so its behaviour is preserved exactly.
 *
 * WHY A VERDICT AND NOT A CHECK. `verdict` is written by the same `log("verdict", …)` call that
 * has recorded these refusals since long before either exclusion existed, so a rule keyed on it
 * reads correctly over rows already on disk — the property an allow-list of reason symbols
 * structurally cannot have. It also needs no registration: a probe that grows a new failure
 * reason is covered the day it ships, with nothing to remember to add here.
 *
 * DELIBERATELY THESE TWO AND NO MORE. Other pre-worker returns exist in run-task.ts
 * (`blocked_git_fetch`, `blocked_illformed`, `blocked_inflight`, `task_already_merged`), but they
 * are a different question — they describe the repo, plan or PR state rather than a probe of this
 * host — and they are not a live one: each reads ZERO verdict rows over the whole union, against
 * a control distribution in which nine other verdicts do appear. Widening to them would be a
 * change with no measured population behind it.
 */
const PRE_WORKER_REFUSAL_VERDICTS: ReadonlySet<string> = new Set(["blocked_containment", "blocked_isolation"]);

export function dispatchesWithoutNewOwnedPr(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
): number {
  // PRE-SCAN (W1-T2249's shape, kept; W1-T2423 widens only what it matches) — two passes over
  // the (small, per-task) line set rather than one: a run's own `verdict` line always lands AFTER
  // its `run.start` in ledger order, so the set of run_ids to EXCLUDE must be known before the
  // counting pass below reaches their `run.start` lines. NOTHING ELSE about the counter moves:
  // the threshold is unchanged, the `pr.opened`/merge-credit reset is unchanged, and a genuine
  // dispatch that produces no PR still counts exactly as it does today — see
  // {@link PRE_WORKER_REFUSAL_VERDICTS} for which verdicts qualify and why these two only.
  const preWorkerRefusalRunIds = new Set<string>();
  for (const line of lines) {
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
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    if (line.step === "pr.opened" || isMergeCreditLine(line)) {
      count = 0; // forward progress — a new PR, or a credited merge, resets the streak
    } else if (line.step === "run.start") {
      // W1-T2423: a run.start whose OWN run ended before the task worker started is a refusal by
      // a HOST preflight, not a dispatch that "produced nothing" — exclude it rather than let a
      // probe failure trip the breaker in the task worker's stead. A run with NO verdict row is
      // NOT excluded: unknown stays counted, so a crash can never buy a task extra dispatches.
      if (typeof line.run_id === "string" && preWorkerRefusalRunIds.has(line.run_id)) continue;
      count++;
    }
  }
  return count;
}

/**
 * True once `taskId` has been dispatched {@link DEFAULT_MAX_TASK_DISPATCHES}
 * (or `maxDispatches`) times with no new owned PR since — the caller (drain.ts
 * / daemon.ts's `nextRunnable` wiring) must dispatch NOTHING further and
 * escalate exactly once (P29(ii)). Re-derived FRESH from the ledger on every
 * call — unlike daemon.ts's in-memory per-tick `next.status = "blocked"` flip
 * (block-reason.ts's independent-failure path), this PERSISTS across process
 * restarts, which is exactly what the W1-T1 storm needed: the redispatch
 * spanned many separate daemon/drain invocations over ~10 hours, and an
 * in-memory-only flag resets every time a fresh process starts.
 */
export function isDispatchBreakerTripped(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  maxDispatches: number = DEFAULT_MAX_TASK_DISPATCHES,
): boolean {
  return dispatchesWithoutNewOwnedPr(lines, taskId) >= maxDispatches;
}

/**
 * SIBLING LIFETIME DISPATCH COUNTER (W1-T271). {@link dispatchesWithoutNewOwnedPr} above
 * resets to 0 on every `pr.opened` line — correct for the failure IT guards (dispatch after
 * dispatch producing NOTHING, the W1-T1/W1-T152 shape) but BLIND BY CONSTRUCTION to a task
 * that re-dispatches forever while merging a genuine no-op PR each time: W1-T254, OBSERVED
 * 2026-07-31, dispatched five times in eighty minutes; each run correctly found the work
 * already done, opened and merged its own owned PR, and each merge reset the streak counter
 * to 0 right before the daemon's next tick re-dispatched it again. This counts EVERY
 * `run.start` line for `taskId` across its WHOLE recorded history — no ledger step of any
 * kind resets it, `pr.opened` included — so a "succeeds every time" loop cannot evade it the
 * way it evades the streak counter. Deliberately a SECOND, independent measurement rather
 * than an edit to the streak counter above: see this task's own rationale for why the reset
 * is not simply wrong for the failure it targets.
 */
export function dispatchesEver(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
): number {
  let count = 0;
  for (const line of lines) {
    if (line.task_id === taskId && line.step === "run.start") count++;
  }
  return count;
}

/**
 * THE THRESHOLD IS A MEASUREMENT, NOT A GUESS (W1-T271's own design note). Derived from the
 * unioned ledger's real per-task `run.start` distribution — `state/ledger.ndjson` plus all
 * 661 rotated archives, 4,165,663 lines, measured 2026-07-31, deduped by `run_id` (every
 * archive is a cumulative byte-for-byte snapshot, so the same line recurs across many
 * archive files):
 *
 *   282 tasks have ever been dispatched at least once. 274 of them (97%) were dispatched
 *   1-4 times, ever, and NO task in this entire corpus that was genuinely legitimate work
 *   needed more than 4 lifetime dispatches.
 *   The only counts at or above 5 are all documented FAILURES, not legitimate fix-rung
 *   cycles: W1-T152 (5) is named alongside W1-T1 in this file's own rationale as a
 *   producing-nothing storm; W1-T254 (6, the incident that prompted this task), W3-T1a (6),
 *   W1-T7 (6), and W1-T230 (6) are each separately-documented no-op re-dispatch closures;
 *   W1-T64 (8), W1-T29 (11), and W1-T1 (153) are the two historically largest storms (P29's
 *   own motivating incidents).
 *
 * 10 sits comfortably above the ENTIRE legitimate population (2.5x its observed max of 4) —
 * "much higher" than the 5-dispatch streak cap, per design — while cutting off well short of
 * the two genuine storm magnitudes (11, 153), so it still functions as a real backstop
 * rather than a number so high it never fires.
 */
export const DEFAULT_MAX_TASK_LIFETIME_DISPATCHES = 10;

/**
 * True once `taskId` has been dispatched {@link DEFAULT_MAX_TASK_LIFETIME_DISPATCHES} (or
 * `maxLifetimeDispatches`) times, EVER — unlike {@link isDispatchBreakerTripped}, unaffected
 * by any `pr.opened` line. The caller (drain.ts's `isDispatchEligible`) consults this
 * ALONGSIDE the existing streak breaker, never in place of it — a genuinely fresh PR still
 * legitimately resets the streak counter's own count; it just no longer resets THIS one.
 */
export function isLifetimeDispatchCapExceeded(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  maxLifetimeDispatches: number = DEFAULT_MAX_TASK_LIFETIME_DISPATCHES,
): boolean {
  return dispatchesEver(lines, taskId) >= maxLifetimeDispatches;
}

/**
 * Per-process, cross-tick memory {@link evaluateDispatchBreaker} uses to notice an
 * impossible regression (W1-T206): the ledger's dispatch count for a task dropping
 * without the `pr.opened` line that would legitimately explain it. Held by the caller
 * (drain.ts/daemon.ts's dispatch loop) across every tick of ONE process's lifetime —
 * mirroring {@link LedgerTailCache}'s "one per long-lived route" shape, not rebuilt per
 * task. SCOPE NOTE: this is in-memory only, so a daemon/drain PROCESS RESTART starts
 * with an empty baseline and cannot catch a rotation that happens to land in that
 * exact window — {@link isDispatchBreakerTripped} above already covers the cross-
 * restart case for the ORDINARY (non-rotated) ledger; this cache adds the narrower,
 * complementary "caught it happening under a live process" guarantee `dispatchesWith
 * outNewOwnedPr` alone cannot provide, since a pure re-derive-from-ledger function has
 * no memory of what the ledger used to say.
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
 * Tri-state read of the dispatch breaker for `taskId` (W1-T206): `"tripped"` /
 * `"clear"` behave exactly like {@link isDispatchBreakerTripped}'s boolean, but a third
 * state, `"indeterminate"`, fires instead of a false `"clear"` in the two situations
 * where trusting a freshly-computed count of 0-ish would be trusting an ABSENCE as
 * proof of no dispatches rather than what it actually is — missing information:
 *
 *   1. The ledger file does not exist at read time. On a genuinely fresh checkout this
 *      is fine (there is really nothing to know yet) — `cache.lastCounts` has no entry
 *      for `taskId` either, so it is trusted as `"clear"`. But once THIS cache has ever
 *      observed a nonzero count for `taskId` from a real read, a SUBSEQUENT absence can
 *      no longer be telling the truth — it reads `"indeterminate"`.
 *   2. The ledger exists but its freshly-computed count for `taskId` is LOWER than
 *      `cache.lastCounts` already recorded, AND the fresh read carries no `pr.opened`
 *      line for `taskId` that would legitimately explain the drop (the only way
 *      `dispatchesWithoutNewOwnedPr` is supposed to ever go down). That combination —
 *      count fell, with nothing in the ledger to justify it — is a torn/rotated/
 *      truncated ledger caught in the act, not forward progress.
 *
 * The caller (run-task.ts's drain/daemon dispatch loop) must treat `"indeterminate"`
 * the same way `nextRunnable`'s existing `isIndeterminate` gate already treats a
 * GitHub-read failure: skip dispatch THIS tick, re-check next tick, never escalate on
 * it alone — never fold it into `isCircuitTripped`, whose `true` means "escalate now".
 */
/** One dispatch-breaker outcome. */
export type DispatchBreakerState = "tripped" | "clear" | "indeterminate";

/**
 * WHAT THE BREAKER SAW, not merely that it fired (the W1-T314 gap). Until this
 * existed, `dispatch.circuit_broken` carried `{task}` and nothing else, so a
 * refusal and a dispatch of the SAME task nine minutes apart from the SAME
 * daemon process (2026-08-04T15:02:25 then 15:11:51, no `pr.opened`, no kick,
 * no rotation between) could not be reconciled from the record at all — a guard
 * meant to bound spend keeping no account of bounding it, on a task whose runs
 * cost $130.49.
 *
 * Every field is a value the decision CONSUMED, returned from the one
 * evaluation that produced `state` — never a second call to the predicate,
 * which could answer differently and make the row a plausible lie.
 */
export interface DispatchBreakerDetail {
  /** The outcome the gate ACTED on — post-corroboration when corroboration ran. */
  state: DispatchBreakerState;
  /**
   * The outcome the LEDGER alone produced, BEFORE corroboration. Kept distinct
   * from {@link state} so "the ledger said tripped and GitHub cleared it" stays
   * readable as the two facts it is.
   */
  ledgerState: DispatchBreakerState;
  /** `dispatchesWithoutNewOwnedPr` at decision time — the count the comparison used. */
  freshCount: number;
  /** The bound `freshCount` was compared against. */
  maxDispatches: number;
  /** The cache's prior count for this task; absent on the first observation. W1-T2425: on a
   *  first observation the cache may itself have been seeded from the newest
   *  `dispatch.circuit_broken` row for this task (see {@link seedCountFromCircuitBreak}), so
   *  this can be present on a process's very first call — it is still the cache's value, just
   *  one the cache learned from disk rather than from a read this process performed. */
  priorCount?: number;
  /** Whether a `pr.opened` line exists — the regression check's second term. */
  hasNewOwnedPr: boolean;
  /**
   * The three-way corroboration answer. ABSENT when corroboration was never
   * consulted (the uncorroborated entry point, or a ledger state that already
   * settled the question) — absent and `"unreadable"` are different facts and
   * this repo has collapsed that distinction six times this week.
   */
  corroboration?: "corroborated" | "not-corroborated" | "unreadable";
}

/**
 * The core evaluator — {@link evaluateDispatchBreaker} and
 * {@link evaluateDispatchBreakerCorroborated} are thin `.state` reads over it,
 * so their behaviour is unchanged and every existing caller keeps working.
 *
 * Corroboration runs only when the caller PASSES an `openHeadBranches` key
 * (presence, not value: `undefined` is a real answer meaning "the gateway
 * offered no read", which `corroboratesForwardProgress` reports as
 * `"unreadable"` — never silently as "not corroborated").
 */
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
  const freshCount = dispatchesWithoutNewOwnedPr(lines, taskId);
  let priorCount = cache.lastCounts.get(taskId);
  // W1-T2425: FIRST OBSERVATION OF THIS TASK IN THIS PROCESS — seed the baseline from the
  // breaker's own on-disk record rather than starting blind, so the regression arm below is
  // reachable across a restart. Only ever on a MISS (a live process's own observation always
  // outranks the ledger's), and only from the lines already read here — see
  // {@link seedCountFromCircuitBreak} for why this is neither a wider read nor a reset.
  if (priorCount === undefined) {
    const seeded = seedCountFromCircuitBreak(lines, taskId);
    if (seeded !== undefined) {
      priorCount = seeded;
      cache.lastCounts.set(taskId, seeded);
    }
  }
  const hasNewOwnedPr = lastPrOpened(lines, taskId) !== undefined;
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
  // W1-T2318: RESOLVED HERE, PAST THE GUARD — this is the only line that may read the list, and it
  // is reached only for a task whose ledger breaker is ALREADY tripped. Resolving a thunk at the
  // call site instead would evaluate it as an argument on every call, clear tasks included, which
  // is the eager boot cost this task exists to remove (a board walk MEASURED at 26 REST calls and
  // 22.2s). An array/null/undefined is returned untouched, so every existing caller is unchanged
  // and `null` still reaches `corroboratesForwardProgress` as "read failed" -> "unreadable".
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

/**
 * W1-T414: does GitHub's OWN view of open PRs corroborate `taskId`'s forward progress, even
 * when THIS host's ledger has no local `pr.opened` line to prove it?
 *
 * `dispatchesWithoutNewOwnedPr`'s reset is a statement about a BRANCH NAME — run-task.ts logs
 * `pr.opened` only after ITS OWN worker pushes ITS OWN `run-<taskId>-<epochMs>` branch — and
 * branch names are GitHub's, visible identically from every host. `openHeadBranches` is the
 * batched {@link GitHub.listOpenHeadBranches} answer, ALREADY resolved by the caller (once per
 * drain/daemon invocation — see `breakerGateFor`, run-task.ts) so this stays a pure, zero-cost
 * lookup rather than a second GitHub call.
 *
 * OWNERSHIP is decided by the same three accepted forms {@link branchClaimsOtherTask} already
 * names — {@link ownsBranch}, {@link isBareRunBranch}, {@link isOwnedSlugBranch} — never a
 * fresh notion of what a run branch looks like.
 *
 * THREE-WAY, NOT BOOLEAN, because "no corroborating branch" and "could not check" must stay
 * distinguishable (the same discipline {@link GitHub.listOpenHeadBranches}'s own doc states):
 *   - `"corroborated"` — the read succeeded and named a branch this task owns.
 *   - `"not-corroborated"` — the read succeeded and named no such branch.
 *   - `"unreadable"` — the read FAILED (`null`) or was never offered (`undefined`, e.g. a
 *     gateway that predates {@link GitHub.listOpenHeadBranches} or omits the optional method).
 *     Never treated as `"not-corroborated"`: a caller that collapsed the two would let a
 *     network blip silently withdraw an already-legitimate reset.
 */
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
 * W1-T414: {@link evaluateDispatchBreaker}, CORROBORATED by GitHub's own view of open PRs before
 * a `"tripped"` verdict is handed back — the count itself stays exactly as local as it always
 * was (this calls {@link evaluateDispatchBreaker} verbatim, unmodified, first), and so does its
 * regression/indeterminate handling (W1-T206's, untouched — an `"indeterminate"` or `"clear"`
 * verdict is returned as-is, never reached by the corroboration check below).
 *
 * ONLY a `"tripped"` verdict is reconsidered, and only in ONE direction: a corroborating branch
 * downgrades `"tripped"` to `"clear"`, exactly as a local `pr.opened` line already would; the
 * absence of one, or an unreadable read, leaves `"tripped"` exactly as {@link
 * evaluateDispatchBreaker} computed it — UNREADABLE FALLS BACK TO THE LOCAL COUNT, never to
 * "dispatch anyway" (a network blip cannot itself clear a tripped breaker) and never to "refuse"
 * (this can only ever relax a trip the local count already decided, never add one).
 *
 * `openHeadBranches` is the SAME already-resolved, once-per-invocation batched read {@link
 * corroboratesForwardProgress} consumes — see that function's and `breakerGateFor`'s (run-
 * task.ts) docs for why this is never a per-task GitHub call.
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

/** {@link evaluateDispatchBreakerCorroborated}'s detail — the values the gate consumed. */
/**
 * The open-head-branch list, or a thunk that produces it on demand (W1-T2318). A thunk lets the
 * daemon/drain boot path hand over the ABILITY to walk the board without paying for the walk: the
 * only site that resolves it sits past the already-tripped guard, so a clear task never triggers
 * one. A plain array, `null` and `undefined` all behave exactly as before this type existed.
 */
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

/**
 * `Remudero-Task: <id>` claimed as false for THIS task by a `correction.provenance`
 * ledger line (P9-iv, a FIRST-CLASS event) — the operator has already established
 * the credit is wrong and deriveStatus must never re-surface it, even if GitHub's
 * search keeps turning it up. Every `claimed_pr_url` named for `taskId` is debunked.
 */
function debunkedTrailerUrls(lines: Array<Record<string, unknown>>, taskId: string): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
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
 * CORRECTIONS WIN, SUPREME (P9-iv / W1-T75, generalizing W1-T69): a `correction.provenance`
 * line is the operator's AUTHORITATIVE override of a mis-attribution — it debunks a
 * `claimed_pr_url` AND names the `actual_pr_url` (the real PR, e.g. #80→#91). deriveStatus
 * credits that actual url directly, checked BEFORE rungs (a)/(b)/(c) — a stale ledger
 * `pr.opened` line or a `pr:` field is no more trustworthy than the fuzzy trailer search
 * this originally only outranked. Crucially the actual PR is NOT re-subjected to the
 * ownership/anchor asserts: the correction is a deliberate human act that SUPERSEDES
 * those automated checks (the real PR is often a hand-authored one from a non-`run-`
 * branch — #91 was a docs PR, #134 a `fix/*` PR). Last correction wins. Returns
 * undefined when the task has no correction.
 */
function latestActualPrUrl(lines: Array<Record<string, unknown>>, taskId: string): string | undefined {
  let url: string | undefined;
  for (const line of lines) {
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
 * Extract the task id a fleet-dispatched run branch (`run-<taskId>-<epochMs>`,
 * `worktreeAdd`'s naming) claims, or `undefined` if `head` is not that shape.
 *
 * The ONE named extractor for a shape this repo already tests three other ways:
 * {@link ownsBranch} below VERIFIES a known id (`^run-<taskId>-\d+$`, cannot discover
 * one), and run-task.ts's `isDispatchedRunBranch` answers only "is this a run branch"
 * (a boolean shape test, no capture group). This was previously inlined TWICE inside
 * {@link projectPlan} itself (`/^run-(.+)-\d+$/`, duplicated within that one function);
 * W1-T453 lifted it here so every caller shares one spelling rather than writing a
 * fifth. Both `projectPlan` call sites below now call this instead of matching inline.
 */
export function taskIdFromRunBranch(head: string | undefined): string | undefined {
  const m = /^run-(.+)-\d+$/.exec(head ?? "");
  return m ? m[1] : undefined;
}

/**
 * Extract the task id a SLUG branch declares in its own name, for the shape
 * {@link taskIdFromRunBranch} cannot read at all: no `run-` prefix, e.g.
 * `w1t1060-instrument-declare` (W1-T2629 rationale (4)). PURE, and the ONE new extractor this
 * task adds — no git, no network, no second definition of merge credit; the caller decides
 * separately (via {@link readMergeCreditedTaskIds}) whether the resolved id is credited.
 *
 * TRAP 1, REUSED RATHER THAN REINVENTED: {@link isOwnedSlugBranch}'s doc records that a bare
 * `startsWith(taskId)` would let `W1-T15` credit from `run-W1-T152-…`, and that a boundary
 * character is what makes prefix matching safe. This resolver faces the same trap in a harder
 * shape — `candidateIds` is not one known id to VERIFY, it is the whole plan to search — so the
 * guard cannot rely on a literal `-` the way {@link isOwnedSlugBranch} does: both `head` and
 * every candidate id are first lower-cased and stripped of every non-alphanumeric character
 * (`w1t1060`, `w1-t1060` and `W1-T1060` all normalise to the same `w1t1060`), which DELETES the
 * hyphen boundary along with the case and punctuation noise. What survives is a single check —
 * a candidate is accepted only when it matches at the START of the normalised head (the
 * stripped string has no separators left, so "the character before the match is not
 * alphanumeric" can only ever be true at position zero) AND the character immediately after the
 * match is NOT A DIGIT. That second half is the trap: `w1t1060instrumentdeclare` starts with
 * both `w1t1060` (W1-T1060, next char `i` — accepted) and `w1t106` (W1-T106, next char `0` — a
 * digit, REFUSED) — the digit boundary is what {@link isOwnedSlugBranch}'s `-\d+$` anchor did
 * for the timestamped form, replayed here without a literal separator to anchor on.
 *
 * LONGEST MATCH WINS: `candidateIds` is unordered (it is every task id in the plan, not a
 * ranked list), so ties are broken by preferring the longer normalised id — the more specific
 * candidate — rather than by iteration order.
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

/**
 * RUNG (c) OWNERSHIP-ASSERT (MASTER-PLAN P16 / W1-T69, ratifying the same class
 * W1-T62 fixed on the write side and W1-T51 on the retro read side): a trailer
 * credit is only trustworthy if the PR was opened from THIS task's own branch
 * (`run-<taskId>-<epochMs>`, run-task.ts's naming). A foreign PR that merely
 * mentions the task id in its body — or one whose head ref cannot be resolved —
 * is NOT owned and must never be credited.
 *
 * LOAD-BEARING for the blocked_review FIX RUNG too (W1-T76, absorbs P21): the
 * legit fix workflow amends THIS SAME run branch, never a `fix/*` branch or a
 * fresh PR — creditability here is what lets a fixed task's dependents unblock.
 *
 * SCOPE NARROWED 2026-07-30 (operator ruling). This predicate is no longer the sole
 * gate on rung (c): for a MERGED PR an exactly-anchored trailer is sufficient and the
 * branch NAME may not veto it — see {@link creditsByAnchoredTrailer} and
 * {@link branchClaimsOtherTask}. It REMAINS the gate for non-merged PRs, and it remains
 * the (c2) head-branch corroboration rung's own assert unchanged. The former "never
 * weaken this to accommodate a `fix/*` head" now reads: a merged `fix/*` PR with a
 * correct anchored trailer DOES credit (W1-T64's real PR #115 is exactly that shape and
 * was stranded permanently by the old rule); an unmerged one still does not.
 */
function ownsBranch(head: string | undefined, taskId: string): boolean {
  if (!head) return false;
  return new RegExp(`^run-${escapeRegExp(taskId)}-\\d+$`).test(head);
}

/** What is known about one remote branch, gathered by the caller (W1-T447). */
export interface BranchFacts {
  name: string;
  /**
   * The most decisive PR state for this head: a merged PR beats a closed one beats open.
   * `"unknown"` means the caller could not prove a complete read — e.g. a bulk paginated walk
   * that neither found this head nor proved it reached the end of history, and whose per-head
   * follow-up (W1-T2246) also failed. It must NEVER be produced by silently treating an
   * incomplete read as `"none"` — that collapse is the defect this field exists to end.
   */
  prState: "merged" | "closed" | "open" | "none" | "unknown";
  /**
   * `git merge-base --is-ancestor origin/<name> origin/main` SUCCEEDED — every commit is in
   * main. `"unknown"` means the check itself could not be evaluated (e.g. `origin/<name>` was
   * never fetched on this checkout) — this is DELIBERATELY NOT `false`, because `false` is a
   * decided "not an ancestor" and collapsing an unreadable ref into that decided answer is
   * exactly the second defect W1-T2246 fixes (rationale §6).
   */
  tipInMain: boolean | "unknown";
  /** The branch NAME appears in `src/`, `scripts/`, `deploy/` or `.github/`. */
  namedInSource: boolean;
  /**
   * PATCH-ID EQUIVALENCE (W1-T2247): `git cherry -v origin/main origin/<name>` decides only a
   * quarter of a held set on its own and MISLABELS A SQUASH-MERGE AS ABSENT (every commit reads
   * `+` because the squash collapsed them into one new diff on main), so this field is never
   * consulted for a branch whose `prState` already resolved it — see `planBranchReap`'s ordering.
   * It exists for the OTHER shape: a branch with no PR at all whose commits are, commit-for-
   * commit, already equivalent (every line `-`) to something in main (e.g. cherry-picked by
   * hand). `true` = every commit equivalent. `false` or omitted = not proven equivalent (mixed,
   * every commit genuinely absent, or never measured) — the conservative default, so an absent
   * measurement can never manufacture a resolution the caller never proved.
   */
  patchIdEquivalentInMain?: boolean;
  /**
   * TASK ID THE BRANCH NAME ITSELF DECLARES (W1-T2629), resolved by the caller via
   * {@link taskIdFromSlugBranch} against the plan's known task ids — e.g.
   * `w1t1060-instrument-declare` resolves to `"W1-T1060"`. Omitted, exactly like
   * {@link patchIdEquivalentInMain}, means "never resolved" — NOT "resolves to nothing" — so an
   * absent measurement can never manufacture a split {@link planBranchReap} never proved.
   */
  namedTaskId?: string;
  /**
   * WHETHER {@link namedTaskId}'s task is merge-credited, per the caller's OWN existing
   * {@link readMergeCreditedTaskIds} read — never a second definition of merge credit, and
   * never computed inside this module. Meaningless (and ignored by {@link planBranchReap}) when
   * `namedTaskId` is absent. Omitted while `namedTaskId` is present is the SAME conservative
   * default as omitting it entirely elsewhere in this interface: it can never be read as
   * "credited", only ever as "not proven credited" — see `planBranchReap`'s `named_task_open`
   * split.
   */
  namedTaskCredited?: boolean;
}

/**
 * WHY A BRANCH LANDS WHERE IT LANDS (W1-T2247 design (ii)): five distinct reasons a branch is
 * deletable or held, plus the two carried over unchanged from W1-T447/W1-T2246 (`protected`,
 * `state_undetermined`) — NEVER one shared string. `merged_squash_patch_id_differs` exists
 * because `git cherry`'s squash blind spot (rationale §3) must never be reported as though it
 * were the SAME thing as a genuine `no_pr_ever` — the disposition is identical (deletable) but
 * the reason a reader would grep for is not, and collapsing the two back into one string is
 * exactly the mislabel this task ends.
 *
 * `named_task_credited` and `named_task_open` (W1-T2629) split `no_pr_ever` one step further,
 * for the branch names {@link taskIdFromSlugBranch} can read that the `run-`-anchored
 * `no_pr_ever` never could: the branch's own name declares a task id, and that task's
 * merge-credit state (read by the caller, never here) says whether the named work shipped by
 * another route. NEITHER is a sixth deletable disjunct — see `planBranchReap`'s own comment on
 * why a task shipping elsewhere proves nothing about THIS branch's commits.
 */
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
  /**
   * SUBSET OF `hold` (W1-T2246): the branches held not because they are decisively "no PR, tip
   * not in main" but because at least one of those two facts could not be proven — `prState` read
   * `"unknown"`, or `prState` read `"none"` while `tipInMain` read `"unknown"`. Disposition is
   * unchanged (still held, never swept), only the REASON is separated, because a manifest that
   * calls both cases "no PR" cannot be trusted to tell an operator which of the 74 are the 29 with
   * genuinely no other copy of the work and which are merely unread.
   */
  undetermined: string[];
  /** Branches the NAME GREP protects that the declared list does not — the drift signal. */
  undeclaredGuards: string[];
  /**
   * DECLARED, but no branch of that name is on origin (W1-T2228 form (2)(ii)). `facts` is built
   * only from branches that EXIST (`remoteBranchNames`), so a dead declaration for a deleted
   * branch is never even visited by the loop below — this is the one comparison that must run
   * against the full declared list rather than against `facts`. Citation status is irrelevant
   * here on purpose: `feedback-landing` is cited (via `LANDING_BRANCH`) and routinely absent
   * between landings, so "no branch on origin" alone is a normal, non-drift state for an
   * ephemeral guard — see reapBranchesCommand's separate no-citation check (`orphanDeclarations`,
   * W1-T2226) for the direction that DOES need citation to disambiguate a dead entry from one.
   */
  missingBranches: string[];
  /**
   * EVERY BRANCH NAMES THE TEST THAT PLACED IT (W1-T2247 design (ii)): one {@link BranchReapReason}
   * per `facts` entry, keyed by branch name. `deletable`/`guarded`/`hold`/`undetermined` stay the
   * disjoint bucket arrays callers already depend on — this is the reason WITHIN whichever bucket
   * the name already landed in, never a second classification. A reader who wants "why" greps this
   * map instead of re-deriving it from the bucket the name happens to be in.
   */
  reasons: Record<string, BranchReapReason>;
}

/**
 * Classify remote branches for a DRY-RUN reap. PURE: no git, no network, no deletion —
 * the caller gathers {@link BranchFacts} and decides what to do with the answer.
 *
 * PROTECTION IS EVALUATED FIRST AND WINS OUTRIGHT, and that ordering is the whole safety
 * argument rather than a detail. `decisions-landing` is simultaneously the head of a MERGED PR
 * (so the delete rule matches it) and a live code constant (`DECISIONS_LANDING_BRANCH` in
 * feedback-landing.ts) — evaluated the other way round, the fleet would delete a branch its own
 * source names. `heartbeat` is the same shape against the recency rule: it carries no PR at all
 * and is force-pushed as a PARENTLESS ROOT COMMIT every five minutes, so ordinary history
 * heuristics misread it while the name grep does not.
 *
 * DELETABLE IS THREE DISJUNCTS and the third is the one needing no trust: a merged PR head, a
 * closed-unmerged PR head, or NO PR with a tip already an ancestor of main — the last means every
 * commit exists in main already, so removing the ref cannot lose information. An OPEN PR is never
 * deletable; it lands in `hold` rather than `guarded` because it is in use, not infrastructure.
 * `"unknown"` NEVER SATISFIES A DISJUNCT — an unproven `prState` and an unproven `tipInMain` both
 * read as NOT deletable, the same conservative direction W1-T119 already established for a wholly
 * failed PR read, extended here to a partially incomplete one (W1-T2246).
 *
 * `undetermined` IS THE REASON SPLIT WITHIN `hold` (W1-T2246): a branch lands there when its
 * `hold` disposition rests on a fact that could not be proven, rather than on a decisive "no PR"
 * plus a decisive "tip not in main". Disposition never changes — nothing here is swept — only the
 * label the operator reads is more honest about which of the held branches are truly the only
 * copy of their work and which are simply unread.
 *
 * `undeclaredGuards` IS AN ALARM, NOT A RESULT. A declared list alone rots — measured repeatedly
 * here — and a name grep alone cannot see a branch referenced only through a variable
 * (`LANDING_BRANCH` recreates `feedback-landing` on the next landFeedback, when no branch of that
 * name exists to be found). So both run, and a guard the grep finds but the list omits is
 * REPORTED so it fails loudly rather than being swept in silence.
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
  // THE RAW (2)(ii) CANDIDATE, computed against the declared list directly rather than against
  // `facts` — `facts` has no row at all for a branch that is no longer on origin, so this is the
  // one comparison in this function that cannot be a clause inside the loop below. PURE and
  // UNCONDITIONAL on purpose: this function has no citation information, so it cannot itself
  // decide whether a name absent from `facts` is a dead declaration or an ephemeral one
  // (`feedback-landing` reads identically to a truly dead entry from here). The caller — which
  // does have the citation scan — is where that disambiguation belongs (W1-T2228 design (v)).
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
    // MERGED AND CLOSED ARE DECIDED BY `prState` ALONE, BEFORE PATCH ID IS EVEN CONSULTED
    // (W1-T2247 acceptance: a squash-merged branch must never read "absent" merely because its
    // patch id differs from main's). `patchIdEquivalentInMain` only ever SPLITS THE REASON for an
    // already-deletable merged head — it can never downgrade a merged or closed PR out of
    // `deletable`, and it is never even examined for one.
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
    // THE FOURTH DISJUNCT (W1-T2247): no PR at all, and every commit is patch-id equivalent to
    // one already in main — content-identical even though `tipInMain` may read `false` or
    // `"unknown"` (a rebase or hand cherry-pick changes the sha without changing the patch).
    // Resolved WITHOUT any judgement step, same as the ancestor disjunct above: removing the ref
    // cannot lose information no other ref already holds.
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
      // W1-T2629: the branch's own name declares a task id `taskIdFromRunBranch` cannot read
      // (no `run-` prefix) — the caller resolved it via `taskIdFromSlugBranch` and, separately,
      // whether that task is merge-credited (its own `readMergeCreditedTaskIds` read). NEITHER
      // outcome moves this branch out of `hold` or into `deletable`: a task shipping by another
      // route does not prove THIS branch's commits are in main, so `named_task_credited` still
      // needs the same adjudication `no_pr_ever` always did — it is only a mechanically-checkable
      // CITATION for that adjudication (W1-T2247 rationale §4), never a verdict this function
      // renders itself. `namedTaskCredited` omitted degrades to `named_task_open`, the same
      // conservative default `patchIdEquivalentInMain` documents: an absent measurement can
      // never manufacture a resolution the caller never proved.
      plan.reasons[f.name] = f.namedTaskCredited === true ? "named_task_credited" : "named_task_open";
    } else {
      // Confirmed: no PR ever, tip not an ancestor, not patch-id equivalent, and the branch names
      // no resolvable task either — this is the residue W1-T2247 exists to size correctly
      // (rationale §4: 20, not 75).
      plan.reasons[f.name] = "no_pr_ever";
    }
  }
  return plan;
}

/**
 * A CITATION FOR ONE ADJUDICATION VERDICT (W1-T2247 rationale §5 / design (iii)) — the residue of
 * branches `planBranchReap` could not resolve mechanically (`no_pr_ever`, one per `plan.hold`
 * minus `plan.undetermined` and minus every `open`). "Still needed" is a judgement, and this
 * repo's discipline is that a judgement without a falsifier is a guess: a citation names EITHER a
 * plan task id the change would serve, OR a symbol/path in the CURRENT tree the change targets
 * together with whether that symbol still exists — both re-checkable by a grep against the tree
 * and the plan, WITHOUT re-running whatever produced the verdict.
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
 * THE VERDICT CARRIES ITS CITATION OR IT IS REFUSED (W1-T2247 rationale §5) — refused outright,
 * never downgraded to "unconfirmed" or otherwise accepted with a caveat, because an accepted
 * guess is indistinguishable from a checked answer to every reader downstream of this function.
 * PURE and re-checkable: this function only ever inspects whether a citation is PRESENT and,
 * for a `tree_symbol` citation, whether its own `path` is non-empty — it does not itself walk the
 * plan or the tree (design (iii): that re-check is the caller's job, against the live plan and
 * tree, precisely so a wrong verdict is caught by a grep rather than by trusting this function).
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

/**
 * The BARE run-branch form: `run-<taskId>` with no `-<epochMs>` suffix. Older/hand
 * dispatches produced it (W1-T152's own merged PR #793 is exactly this shape), so it
 * claims the task just as legitimately as {@link ownsBranch}'s timestamped form.
 * Kept separate from `ownsBranch` so the (c2) head-branch CORROBORATION rung — which
 * credits BY branch and must stay strict — is unaffected.
 */
function isBareRunBranch(head: string, taskId: string): boolean {
  return head === `run-${taskId}`;
}

/**
 * The SLUG run-branch form: `run-<taskId>-<anything>` — the task's own branch under a
 * descriptive name rather than an `-<epochMs>` stamp. Third accepted claim form, added
 * for the same reason {@link isBareRunBranch} was: the 2026-07-30 relaxation's own doc
 * records that the old strict rule refused merged, correctly-trailered PRs whose branches
 * "lacked only the `-<epochMs>` suffix", and that named group was never handled. A merged
 * PR on `run-W1-T377-open-pr-corroboration` matched neither accepted form, was therefore
 * judged to claim a DIFFERENT task, and vetoed its own credit — permanently, since the
 * head ref of a merged PR never changes.
 *
 * THE TRAILING `-` IS THE ENTIRE PREFIX-COLLISION GUARD (TRAP 1, the reason
 * {@link ownsBranch} anchors on `-\d+$`). A bare `startsWith(taskId)` would let `W1-T15`
 * credit from `run-W1-T152-1785348476091`; requiring the boundary character makes both
 * directions veto, because neither id is a prefix of the other *followed by a hyphen*.
 *
 * SUBSUMPTION IS DELIBERATE AND NOT A REDUNDANCY BUG: a digit stamp is a slug, so this
 * also matches every {@link ownsBranch} form. {@link branchClaimsOtherTask} still names
 * all three predicates, because the strict ones remain the gate elsewhere (rung (c2), rung
 * (c3), the non-merged path) and reading the veto as "unless it claims this task in one of
 * the three legitimate forms" is what keeps those call sites visible to the next reader.
 *
 * KEPT OUT OF `ownsBranch`, exactly as `isBareRunBranch` is: widening `ownsBranch` would
 * reach the (c2)/(c3) corroboration rungs and the non-merged path, granting credit the
 * 2026-07-30 ruling deliberately refused.
 */
function isOwnedSlugBranch(head: string, taskId: string): boolean {
  return head.startsWith(`run-${taskId}-`);
}

/**
 * RUNG (c) FOREIGN-BRANCH VETO (operator ruling 2026-07-30, supersedes the
 * head-branch NAME veto for MERGED PRs — see {@link creditsByAnchoredTrailer}).
 *
 * `true` iff `head` is a run-branch that claims a DIFFERENT task than `taskId`.
 * That — and ONLY that — still vetoes a trailer credit. A branch carrying no task
 * claim at all (`feat-*`, `fix/*`, `w1-t235-worker-keychain`, …) vetoes nothing:
 * under the ruling, the exactly-anchored trailer on a merged PR is the evidence,
 * and the branch's NAME may not overrule it.
 *
 * PREFIX COLLISION (TRAP 1, the reason `ownsBranch`'s `-\d+$` anchor exists) is held
 * off by the BOUNDARY CHARACTER, not by avoiding prefix matching. An earlier revision of
 * this comment said prefix collision was "structurally impossible here because this
 * function never PREFIX-matches an id"; {@link isOwnedSlugBranch} does prefix-match, and
 * requiring the id to be followed by `-` is what makes that safe — neither of two
 * colliding ids is a prefix of the other *plus a hyphen*. The question asked is "does
 * this run-branch claim THIS task, in any of the three legitimate forms?", vetoing every
 * other `run-*`. So both directions are safe:
 *   - head `run-W1-T152-1785348476091`, taskId `W1-T15`  → claims neither form of
 *     W1-T15 → VETO (correct: that branch is W1-T152's).
 *   - head `run-W1-T15-1785348476091`,  taskId `W1-T152` → VETO (correct, reverse).
 * A `run-*` branch whose remainder is not a task id at all also vetoes — failing
 * CLOSED on an unrecognised run-branch is the conservative direction.
 */
function branchClaimsOtherTask(head: string | undefined, taskId: string): boolean {
  if (!head) return false; // unresolved head ref carries no claim — cannot veto
  if (!head.startsWith("run-")) return false; // no task claim encoded at all
  return !ownsBranch(head, taskId) && !isBareRunBranch(head, taskId) && !isOwnedSlugBranch(head, taskId);
}

/**
 * RUNG (c) ACCEPT TEST — the operator's 2026-07-30 ruling, implemented verbatim:
 * "a correct, exactly-anchored Remudero-Task trailer on a MERGED PR is sufficient
 * evidence that the PR credits that task, and the head-branch NAME must no longer
 * be able to veto it — WITH an explicit guard that a branch clearly belonging to a
 * different task can never credit."
 *
 * WHY THE OLD ASSERT WAS WRONG (all OBSERVED, recon-AO): `ownsBranch` alone refused
 * SEVEN merged, correctly-trailered PRs because their branches were hand-named
 * (`feat-*`, `fix/*`) or lacked only the `-<epochMs>` suffix. Each task then stayed
 * `queued` forever, was re-dispatched, and tripped P29(ii)'s breaker — W1-T258 burned
 * $3.40 ending in `verdict: pr_attribution_failed`. Worse, the
 * escalation-lifecycle reconciler keys on this very `merged` flag, so the defect that
 * created those escalations also made retiring them impossible.
 *
 * TRAP 2 — NO NON-MERGED CREDIT PATH. The relaxation is scoped to `MERGED` and
 * nothing else. `state` is asserted MERGED **here**, from the PrRef, rather than
 * trusted from `findMergedByTrailer`'s name: that is an INTERFACE method a fixture
 * (or a future gateway) may implement with any state, and the (c2) rung already
 * re-asserts `state === "MERGED"` for the same reason. For any non-merged state the
 * OLD strict behaviour is kept unchanged — the branch must be owned — so an OPEN or
 * CLOSED-UNMERGED PR can never earn credit through the widened path.
 */
function creditsByAnchoredTrailer(
  state: string,
  head: string | undefined,
  body: string | undefined,
  taskId: string,
  /**
   * W1-T2387: does the COMMIT surface carry this task's anchored trailer for this PR? The union
   * searches two surfaces, so the re-verify must check both or it discards the very candidate the
   * search just produced — measured on #3005/W1-T2326, where `findMergedByTrailer` returned the
   * PR and this function then threw it away. Defaults FALSE, so every caller that does not supply
   * it (and every pre-existing fixture) sees the body-only behaviour byte-for-byte.
   */
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
 * RUNG (c) ANCHORED-TRAILER VERIFY (P16 / W1-T69): `findMergedByTrailer` is a
 * GitHub full-text body search — fuzzy, tokenized on punctuation, and capable of
 * matching a PR whose trailer actually names a DIFFERENT (e.g. prefix-sharing)
 * task id, the exact "W1-T20c false-credit" class this rung ratifies. The search
 * hit is a first pass only; this is the authoritative local check that the body
 * carries the trailer as its own exact, anchored line.
 */
/**
 * RUNG (c) PLAN-ONLY REFUSAL (W1-T413) — does this changeset prove NOTHING was implemented?
 *
 * True iff `files` is non-empty and EVERY path is in plan scope ({@link isInPlanScope}, CALLED
 * rather than re-derived: `plan/**`, `MASTER-PLAN.md`, `docs/ORIENTATION.md`). A merged PR that
 * changed only those filed, split, re-scoped or closed a task — it did not build one.
 *
 * EMPTY IS FALSE, deliberately. An empty list is what an unreadable or truncated read looks like,
 * and "every element of nothing is in plan scope" is the vacuous pass this repo keeps re-learning.
 * Only a list with something in it can carry this claim.
 *
 * THE REPO ALREADY HOLDS THIS RULE IN THE OTHER ORGAN: `rmd lint-plan` prints its own failing-split
 * evidence as "a Remudero-Task trailer or commit-subject citation on origin/main, with
 * chore(plan)/chore(triage)/chore(feedback)/docs(plan) filing subjects excluded — a filing cites a
 * task; it does not implement it", and `plan-pr-emitter.ts` documents carrying the trailer ONLY
 * when a taskId is given, omitting it for a plan-FILING PR. This is those rules reaching the
 * dispatch path, not a new policy.
 *
 * DELETIONS COUNT (the #1465 lesson): whatever the caller's `changedFiles` reports as changed is
 * tested, so a PR that DELETES a `src/` file while editing plan files is not plan-only.
 */
/** `ghGateway.findMergedByTrailerAll`'s fetch bound (W1-T441). The measured worst case is six
 *  (W1-T254); this leaves an order of magnitude of headroom without becoming an unbounded list. */
export const TRAILER_ALL_LIMIT = 50;

/**
 * BOOKKEEPING-ONLY (W1-T441): a changeset that filed, closed or recorded a task rather than
 * building it. Deliberately WIDER than {@link isPlanOnlyChangeset}, and the difference is the
 * whole point — the already-satisfied close path writes `DECISIONS.md`, which is NOT in plan
 * scope, so `isPlanOnlyChangeset` reads those closes as real work.
 *
 * MEASURED across the 16 task ids carried by more than one merged PR: `isPlanOnlyChangeset`
 * isolates the implementation in 3 of 16 and in ZERO of the five generator sets (W1-T12a,
 * W1-T254, W1-T262, W1-T7, W1-T99 — the ones with a `DECISIONS.md`-only close). This predicate
 * isolates all five.
 */
export function isBookkeepingOnlyChangeset(files: readonly string[]): boolean {
  return files.length > 0 && files.every((f) => isInPlanScope(f) || f === "DECISIONS.md");
}

/**
 * Prefer the merged PR that IMPLEMENTED `taskId` over a later bookkeeping close (W1-T441).
 *
 * ONE LAYER, AND NEWEST-WINS SURVIVES AS THE FALLBACK: drop candidates whose changeset is
 * bookkeeping-only ({@link isBookkeepingOnlyChangeset}); if that would empty the set, keep it
 * whole. So this can only ever NARROW, and when it does not discriminate the caller's existing
 * newest-first order stands untouched — `corroborateOpenByBranch`'s "newest wins on a multi-hit"
 * is NOT repealed here; its reasoning is about OPEN branches and this is the MERGED trailer path.
 *
 * A SECOND LAYER (prefer a candidate touching `src/`) WAS BUILT, MEASURED AND REMOVED: over the
 * 16 multi-hit ids it changes the chosen PR in ZERO of them, because wherever it would have
 * discriminated the implementation was already the newest. A layer with no case that needs it is
 * untestable weight — the falsifier that should have caught its removal stayed green, which is
 * how it was found.
 *
 * MEASURED over the 16 multi-hit ids: this isolates 8, including 5/5 of the generator sets
 * (W1-T12a, W1-T254, W1-T262, W1-T7, W1-T99 — the ones with a `DECISIONS.md`-only close). The
 * rest fall through to newest-first, and they are sets where BOTH PRs are genuine work — there
 * is no "the implementation" to prefer there.
 *
 * `changedFiles` is a per-candidate READ, so this runs only on a genuine multi-hit (16 of 496
 * ids) and never on the single-candidate path. A candidate whose files cannot be read is KEPT,
 * never dropped: an unreadable changeset is missing information, not evidence of bookkeeping.
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
 * Is `head` this task's OWN run branch, in any of the three accepted forms? A free, in-hand test
 * that lets rung (c) credit a worker's own PR without ever reading its file list — the pre-filter
 * that keeps {@link isPlanOnlyChangeset}'s read off the hot path (see `deriveStatus`'s use).
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
 * W1-T2429 — which shape of run-branch-claim gap {@link runBranchClaimGap} found, if any.
 *
 * `"merged-untraced"` — the PR already MERGED and its anchored trailer already credited the
 * task ({@link creditsByAnchoredTrailer}'s `!branchClaimsOtherTask` path — the merge itself was
 * NEVER broken, per this shard's own rationale), but the head branch it merged from was never
 * one of the three accepted claim forms while the PR was open. Reporting this is what makes the
 * gap leave a TRACE after the fact; today it merges clean and leaves none.
 *
 * `"open-unattributable"` — the PR is still OPEN, carries the anchored trailer, and its head is
 * not one of the three accepted forms. `projectPlan` attributes an open PR to a task by
 * `/^run-(.+)-\d+$/` on `headRefName` alone ({@link taskIdFromRunBranch}) and nothing else, so
 * this PR matches none of it: no `pr.opened` line is ever written for it, and a second dispatch
 * of the same task stays admissible until it merges.
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
 * W1-T2429 — DETECTION, AND NOTHING ELSE (rationale §5: no enforcement surface is presumed by
 * this shard's `files:`). Does `pr` carry `taskId`'s anchored trailer on a head branch that
 * claims the task in NONE of the three accepted forms?
 *
 * A PLAN FILING NAMES NOTHING (acceptance 3). {@link hasAnchoredTrailer} is the FIRST gate here,
 * exactly as it is {@link creditsByAnchoredTrailer}'s first gate: a filing's body never carries a
 * `Remudero-Task:` line at all (`plan-pr-emitter.ts` omits the trailer for a filing PR, and the
 * 2026-07-30 ruling's own doc distinguishes a filing from a build on this exact basis), so this
 * returns `undefined` before the head branch is ever inspected. A PR that only MENTIONS the id in
 * loose prose without the anchored line is refused the same way — this is not
 * {@link indexProseNamedTaskIds}'s fuzzy scan.
 *
 * OWNERSHIP IS RE-USED, NEVER RE-DERIVED (acceptance 4). {@link ownsOwnRunBranch} is the exact
 * three-form test ({@link ownsBranch}, {@link isBareRunBranch}, {@link isOwnedSlugBranch})
 * {@link creditsByAnchoredTrailer} and {@link corroboratesForwardProgress} already call — nothing
 * here widens or narrows what "claims the branch" means, so a head that claims the task in any
 * accepted form reads `undefined` exactly as it reads "owned" on every other rung.
 *
 * A MERGED PR IS STILL CREDITED (acceptance 1 REPORTS, it never DENIES): the merge credit path is
 * {@link creditsByAnchoredTrailer}'s `!branchClaimsOtherTask` check, left completely untouched by
 * this function — a `"merged-untraced"` result is a trace of the gap, not a refusal of the credit
 * that already happened.
 *
 * CLOSED-UNMERGED IS OUT OF SCOPE: neither credit path this shard reports on (merge-trailer
 * credit, open-PR dispatch visibility) applies to a closed, unmerged PR, so this reads `undefined`
 * for one.
 *
 * PURE (acceptance 6): reads only fields already present on `pr` — no network call, no file-list
 * fetch, no ledger walk, no `taskId` lookup beyond the one passed in.
 *
 * NEVER CONSULTED BY DISPATCH (acceptance 5): unlike {@link openSiblingBuild} this is not wired
 * into `projectPlan`/`StatusProjection`, `drain.ts`, `worker.ts` or `run-task.ts` — this shard's
 * own `files:` names only this stem and its test; wiring a consumer that acts on the report is,
 * per the rationale, a separate filing.
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

/**
 * PLAN-ONLY-FILING REFUSAL (W1-T1004) — was `prUrl` opened by a plan-only FILING run (the
 * retro/triage/`rmd plan` flows), per THAT run's own positive ledger record, never inferred
 * from the diff? Mirrors `isPlanOnlyFilingPr` (src/run-task.ts, #1527) exactly: true iff the
 * ledger carries a `pr.opened` line for THIS exact `pr_url` with `plan_only: true` — the line
 * those three filing flows write themselves right after their own deterministic plan-only-diff
 * guard passes (run-task.ts's `log("pr.opened", { pr_url, plan_only: true, ... })` call sites).
 *
 * WHY A SEPARATE COPY, NOT A SHARED IMPORT (design note v): `isPlanOnlyFilingPr` stays private to
 * run-task.ts — this task deliberately does not declare that file (see the shard's note: it is
 * named by ~209 of 349 shards and W1-T471 serialises every task that touches it). status.ts
 * already reads the ledger for every other rung below (`readLedgerLines`), so the marker this
 * reads is already in hand — no new signal, no new field, no new dependency.
 *
 * WHY THIS CREDITS A TASK WHOSE OWN DELIVERABLE IS GENUINELY PLAN TEXT (design iv, criterion 4):
 * a task's ordinary implement run opens its PR via the plain `pr.opened` call at run-task.ts:6550,
 * which never carries `plan_only` at all — that field is written ONLY by the three filing flows,
 * which propose OTHER tasks rather than build the one dispatched. So a task like W1-T426 or
 * W1-T314, whose own declared `files:` are plan shards, still reads false here (its PR was opened
 * by its OWN dispatched run, not a filing flow) and credits exactly as before — the diff is never
 * read to tell the two apart.
 */
function isPlanOnlyFilingPr(ledgerLines: Array<Record<string, unknown>>, prUrl: string): boolean {
  return ledgerLines.some((l) => l.step === "pr.opened" && l.pr_url === prUrl && l.plan_only === true);
}

/**
 * Derive one task's PR-precedence merge-state from GitHub (the correction/ledger/
 * pr-field/trailer rungs), in the fixed precedence — the logic `deriveStatus` carried
 * before W1-T155. Takes the ledger already read (its caller reads it once and reuses
 * it for the taxonomy layering below, rather than re-reading the file a second time).
 */
function derivePrPrecedence(task: Task, deps: DeriveDeps, ledgerLines: Array<Record<string, unknown>>): StatusProjection {
  // SUPREMACY (MASTER-PLAN P9 / W1-T75, ratifying the W1-T20c/#134 stranding): an
  // operator correction is checked FIRST, above rungs (a)/(b)/(c) — not merely
  // inside rung (c) ahead of the trailer search. A correction is DECLARED credit
  // (operator ground truth via the sanctioned `rmd correct` writer), not INFERRED
  // evidence, so it is deliberately EXEMPT from the run-branch ownership-assert
  // (that assert guards rung (c)'s fuzzy trailer search, not a human declaration) —
  // the canonical case is a merged PR on a `fix/*` head (#134), which the assert
  // would otherwise reject, making the un-strand impossible by construction.
  //
  // SUPREME OFFLINE (W1-T130, ratifying P9-iv, consuming W1-T119's read-failure
  // distinction rather than re-deriving it): a correction is LEDGER-LOCAL evidence
  // — `applyCorrection` (correct.ts) already resolved `prRef` via a REAL gateway
  // call once, at WRITE time, before the line was ever appended, so re-resolving
  // it here on every derivation buys no new information and puts a gateway call
  // back on the automated dispatch loop's hot path for every corrected task, every
  // poll cycle. That is exactly the mechanism the 2026-07-19 incident exploited:
  // under quota exhaustion `prByRef` returned null for the correction's own
  // target, this rung fell through to "queued", and the daemon re-dispatched a
  // task already SATISFIED BY PR #2 (merged 2026-07-14) — sixty run ids, 76 spends,
  // $206.15 notional, self-reinforcing since each re-dispatch burned more quota.
  // No read result — healthy, throttled, errored, or absent — may ever demote a
  // correction-credited task back to dispatchable: supremacy is UNCONDITIONAL, not
  // best-effort, so this branch returns BEFORE any `deps.github` call at all.
  // `prNumber` is decoration parsed from the URL's own text (never a gate); a
  // corrected task is reported `merged` unconditionally, never re-subjected to
  // whatever GitHub currently says (or fails to say) about `correctedUrl`.
  const correctedUrl = latestActualPrUrl(ledgerLines, task.id);
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

  // W1-T951 DURABLE CREDIT RUNG — directly UNDER `correction` (never above it: a correction must
  // still be able to override a stale/wrong durable entry) and directly ABOVE every rung that
  // reads a live PR record, INCLUDING rung (a)'s own `deps.github.prByRef(openedUrl)` a few lines
  // down. That ordering is the whole point of DELIVERABLE A (design (ii)): once a task's credit
  // is durable, resolving it again costs NO PR-record read at all — not the trailer body search,
  // not the branch corroboration, not even rung (a)/(b)'s ledger-triggered `prByRef` — which is
  // exactly what makes the credit independent of GitHub retaining the head ref (rationale (4)):
  // the ref can be gone, the branch search can be narrowed or paginate short, and this task still
  // resolves merged from a LOCAL record no remote mutation can touch.
  const readCreditStore = deps.readCreditStore ?? (() => loadCreditStore(deps.creditStorePath ?? defaultCreditStorePath(deps.ledgerPath)));
  const writeCreditStore =
    deps.writeCreditStore ?? ((store: CreditStore) => saveCreditStore(deps.creditStorePath ?? defaultCreditStorePath(deps.ledgerPath), store));
  const creditStore = readCreditStore();
  const durableCredit = creditStore[task.id];
  if (durableCredit) {
    // Trailer, when both happen to be durable, is the STURDIER of the two evidentially (a body-
    // search hit anchored by `creditsByAnchoredTrailer`, not a ref GitHub deletes on merge) — but
    // either alone is sufficient; this is a tie-break for which URL/number to report, not a gate.
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
      // W1-T119/W1-T179 PARITY: the durable record proves the MERGE itself beyond doubt, but a
      // caller reading `indeterminate` is asking a DIFFERENT question — "did THIS cycle's
      // GitHub read actually succeed" (an operator dashboard, or a gate that treats
      // indeterminate specially for reasons beyond this one task's credit) — so a genuinely
      // dark cycle is still surfaced here, exactly as the darkness-fallback arm at the bottom
      // of this function surfaces it for a task resolved via `previousProjection`. This checks
      // `readFailed()`/`readTruncated()`/`readFailureReason()` ONLY — cheap flags the gateway
      // already computed from whatever fetch it already attempted (`projectPlan`'s own batched
      // fetch, for the real caller) — never a NEW PR-record read, so acceptance test 2's "without
      // a PR-record read" claim holds on this branch exactly as on the one below it.
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

  // (b2) LEDGER-RECORDED MANUAL COMPLETION (W1-T1029) — the SAME hand-execution rung as (b)
  // below, widened to the two shapes an explicit tasks.yaml `pr:` field cannot express: a
  // completion PR in ANOTHER repository (`task.pr` is a bare number, resolved by
  // {@link GitHub.prByRef} against ONLY the calling gateway's own configured repo — W12-T1's
  // PR lives in `remudero-site` and is unreachable that way), and a completion with NO PR at
  // all, because none will ever exist (W1-T12e, a live drill that leaves no diff to name).
  // DECLARED credit, like the correction rung above — never re-verified against GitHub, for
  // the same reason `correction` isn't (W1-T130's SUPREME OFFLINE note): there is no live read
  // this rung COULD perform even if it wanted to (a cross-repo number, or no PR at all).
  // Checked BEFORE (a)/(b) — a human's recorded assertion is stronger evidence than an
  // in-flight ledger row or a same-repo `pr:` field could ever contradict, and it is
  // REVERSIBLE without deleting it (see {@link latestManualCompletion}'s doc): a later
  // `correction.provenance` row is checked above THIS rung too, so retracting a wrong
  // assertion is already covered by code that already ran.
  const manualCompletion = latestManualCompletion(ledgerLines, task.id);
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

  // (a) ledger `pr.opened` for this task -> query that PR. A MERGED resolution
  // returns immediately, as always. A NON-merged resolution (OPEN/CLOSED) is
  // stashed as `ownResult` rather than returned immediately — SIBLING CREDIT
  // (MASTER-PLAN P29(i)): a LATER redispatch's own closed/open PR must never
  // permanently mask an EARLIER sibling run's already-merged, trailer-owned
  // credit found below at rung (c). This was the W1-T1 spin's actual mechanism:
  // PR #255 (an earlier run) merged, but every LATER run's ledger `pr.opened`
  // line (its own, different, unmerged/absent PR) kept resolving here FIRST and
  // returning unconditionally, so rung (c)'s trailer search — which WOULD have
  // found #255 — was never even reached again.
  let ownResult: StatusProjection | undefined;
  const openedUrl = lastPrOpened(ledgerLines, task.id);
  if (openedUrl) {
    const pr = deps.github.prByRef(openedUrl);
    if (pr) {
      const result: StatusProjection = { taskId: task.id, source: "ledger", ...fromPrState(pr.state), prNumber: pr.number, prUrl: pr.url, prState: pr.state };
      if (result.merged) return result;
      ownResult = result;
    }
  }

  // (b) explicit `pr:` field (hand-executed, pre-ledger) — W1-T116: ALWAYS
  // consulted, even when (a) already captured a non-merged `ownResult` (an
  // open-PR ledger claim). THE INVARIANT: an open-PR ledger claim is only ever
  // the WEAKEST evidence in the system — POSSIBLY RUNNING — and must never
  // outrank a VERIFIED-MERGED credit found anywhere else, pr-field included.
  // This is the live W1-T1 shape: `pr: 2` (GitHub-confirmed MERGED) alongside a
  // ledger `pr.opened` row for #258 (GitHub-confirmed OPEN, from a later
  // dispatch). Before this fix, (a)'s open #258 set `ownResult` and (b) was
  // skipped outright, so the merged #2 credit was never even looked up, the
  // task stayed "running" forever, and the daemon re-dispatched it — the same
  // rung-(a)-masks-a-merged-sibling shape P29(i) fixed for rung (c)'s trailer
  // search, now closed for rung (b) too. A NON-merged (b) result still never
  // displaces an already-captured `ownResult` — that keeps the original
  // "first (a)/(b) hit wins for dedup purposes" behavior when nothing merged.
  if (task.pr !== undefined) {
    const pr = deps.github.prByRef(task.pr);
    if (pr) {
      const result: StatusProjection = { taskId: task.id, source: "pr-field", ...fromPrState(pr.state), prNumber: pr.number, prUrl: pr.url, prState: pr.state };
      if (result.merged) return result;
      if (!ownResult) ownResult = result;
    }
  }

  // (c) a merged PR carrying the `Remudero-Task: <id>` trailer — ownership-
  // asserted, anchor-verified, and correction-aware (MASTER-PLAN P16 / W1-T69).
  // deriveStatus GATES DISPATCH, so a false/foreign credit here is worse than
  // the same attribution class W1-T51 fixed in the retro gather (which only
  // mis-reports); a bad credit here makes the daemon BUILD against an unmet dep.
  //
  // SIBLING CREDIT (P29(i)): this rung is now reached even when (a)/(b) already
  // captured a NON-merged `ownResult` above — the ownership-assert itself is
  // UNCHANGED (`ownsBranch` has always matched `run-<taskId>-*` for ANY run of
  // this task, never just "this run's own branch"; a foreign PR still fails
  // below exactly as before). What changes is that a merged, owned, anchored
  // trailer PR is no longer masked by a DIFFERENT (non-merged) PR that (a)/(b)
  // happened to reference — the assert is strictly narrower than trusting the
  // trailer outright (a foreign PR still fails), strictly wider than "only
  // (a)/(b)'s own reference can credit" (a sibling's merge now credits).
  // (c2) HEAD-BRANCH CORROBORATION (W1-T256). Rung (c)'s `findMergedByTrailer` is GitHub's
  // eventually-consistent BODY full-text search: an exit-0 EMPTY result is INDETERMINATE, not
  // authoritative "not merged". A single such miss demoted an already-merged task to
  // dispatchable — four spurious re-dispatches on 2026-07-24 alone (W1-T1, W1-T12a ×2, W1-T99),
  // each a no-op PR against an already-merged task. Before concluding source:"none", corroborate
  // with a DETERMINISTIC read that does NOT touch the body index: enumerate merged PRs whose HEAD
  // BRANCH is `run-<taskId>-*` (a structured `head:` ref match), then RE-ASSERT ownership on each
  // candidate exactly as rung (c) re-verifies the trailer. `findMergedByHeadBranch` returns null
  // on a `gh` FAILURE (→ readFailed()/W1-T119 indeterminate skip below), an empty array on a
  // genuine no-such-branch — so EMPTY-on-BOTH is genuinely none, SEARCH-EMPTY-BUT-BRANCH-HIT
  // resolves merged via the branch. Cost: one extra structured `gh pr list` per not-yet-credited
  // task per projection — bounded, and only on the path that would otherwise conclude "none".
  const corroborateByBranch = (): StatusProjection | undefined => {
    // BATCHED first (W1-T257): the one-fetch-per-projection index projectPlan injected, if any.
    // It returns null ONLY when the batched fetch FAILED — then, and only then, fall back to the
    // per-task #737 fetch; on a batched+per-task failure `readFailed()` defers via W1-T119 below,
    // never a false none. `undefined` (no batched index provided) also falls back — the exact #737
    // path for direct deriveStatus callers.
    const cands = deps.mergedHeadBranches?.(task.id) ?? deps.github.findMergedByHeadBranch?.(task.id);
    if (!cands) return undefined; // null (read failed → W1-T119) or method absent (fixture) — skip
    const debunked = debunkedTrailerUrls(ledgerLines, task.id);
    const hit = cands.find(
      (pr) =>
        pr.state.toUpperCase() === "MERGED" &&
        ownsBranch(pr.headRefName, task.id) &&
        !debunked.has(pr.url) &&
        // W1-T1004: this rung had NO plan-only guard at all before — a filing PR dispatched
        // from this task's OWN run-<taskId>-* worktree (the retro/triage/plan flows reuse the
        // dispatched task's worktree) would otherwise credit the task it just filed unconditionally.
        !isPlanOnlyFilingPr(ledgerLines, pr.url),
    );
    if (!hit) return undefined;
    // W1-T951 DELIVERABLE A: a merged branch hit is a NEW live credit this task's durable store
    // does not have yet (the durable rung above already returned early if it did) — persist it
    // now, so the NEXT derivation for this task resolves from the store, never GitHub, even after
    // GitHub deletes `hit.headRefName` on its own housekeeping. Best-effort (see
    // {@link saveCreditStore}): a write failure never blocks the projection this call returns.
    writeCreditStore(recordCredit(creditStore, task.id, { source: "head-branch", prUrl: hit.url, prNumber: hit.number, prState: hit.state }));
    return { taskId: task.id, source: "head-branch", ...fromPrState(hit.state), prNumber: hit.number, prUrl: hit.url, prState: hit.state };
  };

  /**
   * (c3) OPEN HEAD-BRANCH CORROBORATION (W1-T377) — the LAST rung, consulted only once every
   * merged path above has declined and (a)/(b) produced no association of their own.
   *
   * THE GAP IT CLOSES: rung (a) is the only route to an OPEN credit, and it reads the LEDGER.
   * (c2) corroborates a ledger miss deterministically by head branch, but only for MERGED — so
   * an open PR whose `pr.opened` line never landed is invisible to every rung, and the task reads
   * dispatchable while a real PR is in flight. Mirrors (c2)'s shape exactly: match the STRUCTURED
   * head ref, never the eventually-consistent body index, and RE-ASSERT ownership with `ownsBranch`
   * on each candidate before crediting.
   *
   * NEWEST WINS on a multi-hit: a task with two open run-branches has been dispatched twice
   * already (the very thing this rung exists to stop), and the newest is the one still working.
   *
   * FAIL DIRECTION, deliberately: a false OPEN credit DEFERS a dispatch; a missed one DUPLICATES a
   * build. Deferral is the cheaper error, and it is not even terminal — `isDispatchEligible`'s
   * W1-T177 `readLiveState` re-read stands a stale OPEN back down on the very next tick, so this
   * rung cannot strand a task the way a false MERGED credit could.
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
  if (trailerPr && !debunkedTrailerUrls(ledgerLines, task.id).has(trailerPr.url)) {
    const head = deps.github.headRefName(trailerPr.url);
    const body = deps.github.prBody(trailerPr.url);
    // W1-T2387: the union's own second surface, read back from the SAME memoised commit index the
    // search used. Absent gateway method ⇒ false ⇒ body-only, exactly as before.
    const commitCredits = deps.github.creditedByCommitTrailer?.(task.id, trailerPr.url) ?? false;
    const wouldCredit = creditsByAnchoredTrailer(trailerPr.state, head, body, task.id, commitCredits);
    // W1-T1004: the ledger-backed plan-only-FILING refusal — checked BEFORE and INDEPENDENTLY of
    // `ownsOwnRunBranch`, unlike the W1-T413 diff-based refusal below. A filing PR (retro/triage/
    // `rmd plan`) dispatched from this task's OWN `run-<taskId>-*` worktree sits on that task's own
    // run branch too, so `ownsOwnRunBranch` would otherwise wave it through as "an implementation by
    // construction" without ever consulting the ledger — exactly the hole rationale (5) names ("the
    // branch shape has no guard at all"). The ledger read is free (already in hand, no gh call), so
    // paying it unconditionally costs nothing.
    const planOnlyFilingRefusal = wouldCredit && isPlanOnlyFilingPr(ledgerLines, trailerPr.url);
    // W1-T413: the DIFF-BASED plan-only refusal, checked only for a hit that would otherwise credit
    // AND that the ledger check above did not already refuse.
    // ORDER IS THE COST CONTROL, not a style choice. `ownsOwnRunBranch` is free — the head ref is
    // already in hand — and a worker's own `run-<taskId>-*` PR is an implementation by
    // construction, so it credits without ever reading a file list. Only the residual case pays:
    // a merged, anchored-trailer PR on a HAND-NAMED branch, which is exactly the population the
    // 2026-07-30 ruling admitted (seven merged PRs whose branches were `feat-*`/`fix/*`) and
    // exactly where a filing PR lands. That bound is what keeps this off the O(N) path the retro
    // gather was measured paying — see `changedFiles`'s own doc for the fail-open direction.
    const planOnlyDiffRefusal =
      wouldCredit && !planOnlyFilingRefusal && !ownsOwnRunBranch(head, task.id)
        ? (() => {
            const files = deps.github.changedFiles?.(trailerPr.url);
            return files !== undefined && isPlanOnlyChangeset(files);
          })()
        : false;
    const planOnlyRefusal = planOnlyFilingRefusal || planOnlyDiffRefusal;
    if (!planOnlyRefusal && wouldCredit) {
      // W1-T951 DELIVERABLE A: persist ONLY the MERGED case — `wouldCredit` is also true for a
      // non-merged own-branch PR (TRAP 2's `ownsBranch` fallback a few lines above, in
      // `creditsByAnchoredTrailer`), and the durable store is a record of MERGE credit, never of
      // an in-flight/closed PR that could still change state on a later derivation.
      if (trailerPr.state.toUpperCase() === "MERGED") {
        writeCreditStore(
          recordCredit(creditStore, task.id, { source: "trailer", prUrl: trailerPr.url, prNumber: trailerPr.number, prState: trailerPr.state }),
        );
      }
      return { taskId: task.id, source: "trailer", ...fromPrState(trailerPr.state), prNumber: trailerPr.number, prUrl: trailerPr.url, prState: trailerPr.state };
    }
    // Rejected: a branch claiming ANOTHER task, a non-merged PR off a foreign branch,
    // or an unanchored search hit — never credited. Corroborate by head branch first (a
    // foreign trailer hit must not mask this task's OWN merged run), then surface WHY
    // (legibility, W1-T69) ONLY when (a)/(b) found nothing to report either — an
    // `ownResult` (this run's own OPEN/CLOSED PR) remains the more informative status
    // than a bare rejection.
    if (!ownResult) {
      const branchCredit = corroborateByBranch();
      if (branchCredit) return branchCredit;
      // (c3) here too — this early return is a SECOND exit that concludes `source: "none"`, and a
      // task whose only trailer hit was foreign/unanchored is exactly as dispatchable-looking as
      // one with no hit at all. Leaving the rung out of this branch would close the gap on one path
      // and leave it open on the other.
      const openHere = corroborateOpenByBranch();
      if (openHere) return openHere;
      // Reason mirrors `creditsByAnchoredTrailer`'s OWN order of refusal, so a rejection
      // never names a cause the accept test did not actually act on: the trailer is
      // checked first there, so an unanchored body reports that regardless of branch.
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

  // (c2, continued) The trailer search credited nothing (EMPTY, debunked, or foreign-with-own-PR):
  // corroborate by head branch before falling back. A merged, ownership-asserted branch hit is a
  // sibling credit exactly like rung (c)'s — it WINS over (a)/(b)'s own non-merged `ownResult`,
  // the same direction rung (c) already established.
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

  // No GitHub evidence: not merged. The yaml `status:` is decorative, not trusted.
  // EXCEPT (W1-T119) when that "no evidence" is actually "GitHub could not be read" —
  // an exhausted/errored `gh` call must defer, never be reported as a confirmed
  // not-merged (the false `source: "none"` that mis-filed W1-T116). W1-T415: a read that
  // SUCCEEDED but only PARTIALLY (readTruncated()) defers here too, for the identical reason —
  // by the time execution reaches this line, every rung above has already credited anything the
  // (possibly truncated) view DID contain, so this arm only ever catches an absence, and an
  // absence from a partial view is exactly as unsound as one from a failed read.
  if (deps.github.readFailed?.() || deps.github.readTruncated?.()) {
    const unavailableReason = deps.github.readFailureReason?.() ?? "unknown";
    // MONOTONIC UNDER DARKNESS (W1-T179 / W1-T155's amended criterion): a genuine gateway
    // FAILURE must never regress a previously-observed status to `queued` -- that IS the
    // 12:24->12:58 fail-open (merged tasks with PR links became every-task-queued with
    // empty PR cells). When a prior successful observation exists, carry its PR-precedence
    // conclusion forward unchanged (see priorPrecedence's note on why only THOSE fields)
    // and mark the gap instead of recomputing an absence. `since` is the START of the
    // CURRENT unbroken run of failures -- carried from the previous projection if it was
    // ALREADY marked unobservable, so consecutive failed reads report the same instant, not
    // a fresh one each poll.
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
  /**
   * `ts` of the LATEST ledger line naming this task, any step (W1-T179's liveness
   * heartbeat) — every `appendLedger` call stamps `ts` (ledger.ts), so this is a real
   * proxy for "the task's worker is still doing something", not a dedicated event type.
   * `undefined` only when no line for this task carries a `ts` at all.
   */
  lastActivityTs?: string;
  /**
   * W1-T944: the newest `worker.state` row's `state` for THIS run, reset back to `undefined` on
   * every fresh {@link LANE_START_STEPS} entry exactly like `phase` resets to `"recon"` -- an
   * earlier run's last-observed state must never leak into a later run's, the same falsifier
   * `phase`'s own reset already guards against.
   */
  workerState?: WorkerState;
  /** `ts` of the ledger row that set {@link workerState} to its current value (a `worker.state`
   *  row is only ever appended ON a transition -- see run-task.ts's `buildWorkerStateSensor` --
   *  so the row's own `ts` IS the transition time, never a later heartbeat's). */
  workerStateSince?: string;
}

/** The ledger `step` a `worker.state` transition rides -- run-task.ts's own
 *  `WORKER_STATE_LEDGER_STEP` constant, mirrored here as a literal (not imported: run-task.ts
 *  imports FROM this module, so the reverse import would be circular) exactly the way
 *  {@link LANE_START_STEPS}/{@link LANE_TERMINAL_STEPS} above already mirror run-task.ts's other
 *  ledger step literals. */
const WORKER_STATE_STEP = "worker.state";

/** Type guard for a `worker.state` ledger row's `state` field -- narrows an untyped ledger value
 *  down to {@link WorkerState}'s closed 3-value vocabulary; a malformed/unrecognized value is
 *  simply ignored (this run's `workerState` stays whatever it was, never a garbage 4th value). */
function isWorkerState(value: unknown): value is WorkerState {
  return value === "working" || value === "tool-executing" || value === "quiet";
}

/**
 * Every REAL ledger step that OPENS a fresh in-flight run, ONE ENTRY PER LANE (W1-T282: "a
 * table of start steps rather than one literal" — generalised off the single `run.start`
 * literal deriveRunState used to switch on exclusively, MEASURED at 63f63ed to be blind to the
 * other six). Verified against run-task.ts source, not guessed: `run.start` (a dispatched TASK
 * run, `runTask`), `daemon.start`/`drain.start`/`plan.start`/`retro.start`/`serve.start`/
 * `triage.start` (the six other command entry points, each stamping its OWN pseudo `task_id` —
 * `DAEMON`/`DRAIN`/`PLAN-<mode>`/`RETRO`/`SERVE`/`TRIAGE-<feedbackId>`, board.ts's
 * `lastActivityByTask` and recent.ts's RECENT feed already key off the same sentinels). A given
 * `taskId` only ever carries ONE lane's own steps (a pseudo id's lines are all that lane's, a
 * real task id's lines are all `run.start`'s own family), so recognising every lane's start
 * step in one shared scan can never conflate two lanes within a single call.
 */
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
 * Every REAL ledger step that CLOSES an in-flight run — deliberately NOT symmetric with
 * {@link LANE_START_STEPS} (W1-T282 design: "the close side is not uniform and must not be
 * pretended uniform"). `verdict` closes a dispatched TASK run exactly as before. `daemon.stop`/
 * `daemon.summary` (daemon.ts, logged on every exit path) and `drain.stop`/`drain.summary`
 * (drain.ts, both call sites) close those two lanes; `plan.verdict`/`plan.error` and
 * `serve.stop` close plan/serve. `retro.error` and `triage.error` are each lane's ONLY terminal
 * step — a SUCCESSFUL retro or triage logs no terminal step at all (confirmed absent from
 * src/), so their close relies entirely on {@link deriveStatus}'s existing liveness bound
 * (`lastActivityTs` vs `livenessBoundMs`) rather than a fabricated terminal step with no writer
 * (the design note's explicit ban — this repo's declared-but-never-written class, hit six
 * times before).
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

/**
 * Scan `taskId`'s ledger lines (chronological, append-only — every line already carries
 * `run_id`/`task_id`, run-task.ts's `log` wrapper stamps both on every call) for the state
 * of its LATEST run: is it still in flight, and — while in flight — the CURRENT phase and
 * when it started (W1-T155). ANY {@link LANE_START_STEPS} entry always resets every field back
 * to `recon`, so an EARLIER run's stale phase/conclusion never leaks into a later run's state —
 * the falsifier the task's acceptance criteria name explicitly ("a stale/earlier phase is not
 * reported"). W1-T282: opening is now driven by {@link LANE_START_STEPS}/closing by
 * {@link LANE_TERMINAL_STEPS} (a table per lane) rather than the single `run.start`/`verdict`
 * literals this function used to switch on exclusively — a dispatched TASK run still opens on
 * `run.start` and closes on `verdict` exactly as before (both remain in their respective
 * tables), so this is a pure generalisation, not a behavior change for that lane. The
 * phase-transition step names below stay TASK-run-specific (a fleet lane like `DAEMON` never
 * emits `recon.done`/`pr.opened`/etc.) and are verified against source, not guessed:
 * `recon.done`, `implement.done`/`implement.resumed`, `pr.opened`, `fix.dispatch`/`fix.review`,
 * `fix.resolved`.
 */
function deriveRunState(lines: ReadonlyArray<Record<string, unknown>>, taskId: string): RunState {
  let inFlight = false;
  let phase: Phase | undefined;
  let startedAt: string | undefined;
  let lastActivityTs: string | undefined;
  let workerState: WorkerState | undefined;
  let workerStateSince: string | undefined;
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    if (typeof line.ts === "string") lastActivityTs = line.ts;
    // Read into a bare local (`rawStep`) BEFORE the typeof guard, never inline off the `line`
    // property access — test/ledger-rotation.test.ts's DECISION_RELEVANT_LEDGER_STEPS
    // consumer-scan regexes grep every consumer file's raw TEXT (comments included) for a
    // property-access equality/inequality check quoting a literal, and are not fussy about
    // WHICH literal follows: an inline guard here once got its OWN type-guard literal mistaken
    // for a decision-relevant step name. Same reason {@link LANE_START_STEPS}/
    // {@link LANE_TERMINAL_STEPS} are Set-membership checks rather than `case` labels —
    // deriveRunState's reads are display-only (see this function's own doc and that test's
    // `verifiedDisplayOnly` note), never decision-relevant, so they must not be mistakenly
    // harvested into that enforcement list either way.
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
    // W1-T944: a worker.state row is only ever appended ON A TRANSITION (run-task.ts's
    // buildWorkerStateSensor), so the row's own `ts` doubles as the transition timestamp --
    // no separate "when did this change" bookkeeping is needed. The comparison below reads the
    // bare local `step`, never the `line.step` property access directly against a quoted
    // literal, for the same DECISION_RELEVANT_LEDGER_STEPS-harvesting reason the comment above
    // this loop explains -- see WORKER_STATE_STEP's own doc for the literal this guards.
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
 * The task's most recent escalation ledger line, IF `escalation.issue_opened` is the LATEST
 * signal among it and `run.start` (a (re)dispatch) — a human has not yet acted, or the task
 * was never redispatched since (W1-T155). Mirrors the "last one wins" scanning idiom every
 * other precedence helper in this module already uses ({@link lastPrOpened},
 * {@link debunkedTrailerUrls}, {@link latestActualPrUrl}) rather than inventing a second.
 *
 * DELIBERATELY DOES NOT ANSWER "is the escalation still open" — that requires a LIVE join
 * against the issue itself ({@link resolveEscalation}, below), which is the whole point of
 * W1-T182: the ledger is append-only, so it can only ever say an escalation WAS opened, never
 * that it has since been closed.
 *
 * `issueUrl` is OPTIONAL on the return value (escalate.ts always writes one, but a malformed
 * or pre-W1-T8 ledger line might not) — its ABSENCE never suppresses the escalation itself,
 * only the live join {@link resolveEscalation} can attempt: same fail-closed direction as an
 * unreadable issue read, never a silently dropped row.
 */
export function latestEscalationLine(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
): { issueUrl?: string; escalationClass?: string; openedAt?: string } | undefined {
  let last: "run" | "escalation" | undefined;
  let issueUrl: string | undefined;
  let escalationClass: string | undefined;
  let openedAt: string | undefined;
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    if (line.step === "run.start") {
      last = "run";
    } else if (line.step === "escalation.issue_opened") {
      last = "escalation";
      issueUrl = typeof line.issue_url === "string" ? line.issue_url : undefined;
      escalationClass = typeof line.class === "string" ? line.class : undefined;
      // W1-T159: the escalation's OWN ledger-line ts — carried forward so a caller can measure
      // "how long has this actually needed a human" against the escalation's real open time,
      // never a run's `startedAt` (a DIFFERENT event — the run that PRECEDED the escalation,
      // not the escalation itself; see StatusProjection.escalationOpenedAt's own doc).
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
 * JOIN LIVE STATE, DO NOT PATCH THE HISTORY SCAN (W1-T182 design). {@link latestEscalationLine}
 * only proves the ledger's own append-only history — that an escalation issue was opened and
 * never superseded by a redispatch. Whether it is STILL a needs-human item depends on the
 * issue's LIVE state, read here through {@link GitHub.issueByUrl} (the same batched-gateway
 * discipline {@link buildBatchedGithub} already uses for PRs — one fetch, not one `gh` call per
 * escalated row).
 *
 * Returns `undefined` (not needs-human) ONLY when the issue is CONFIRMED closed — every other
 * outcome (no `issueByUrl` support, the issue unresolvable, or a read failure) FAILS CLOSED,
 * keeping the row and marking it `unverified`, because hiding a possibly-still-open escalation
 * from the operator's work list is the more dangerous direction of this bug (W1-T182 design,
 * the inverse of W1-T181's merged-count fail-direction — never unify the two behind one
 * "unreadable" policy).
 */
export function resolveEscalation(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  github: GitHub,
): EscalationState | undefined {
  const latest = latestEscalationLine(lines, taskId);
  if (!latest) return undefined;
  // No issue_url at all (malformed/pre-W1-T8 ledger line) ⇒ there is nothing to join against —
  // same fail-closed treatment as an unresolved/unreadable url, never a dropped row.
  let issue: { state: string; title?: string } | null = null;
  if (latest.issueUrl) {
    try {
      // A THROWING issueByUrl (an injected fixture that raises rather than fails soft, or a
      // gateway this module didn't anticipate) must NEVER propagate out of deriveStatus — that
      // would crash the whole projection instead of degrading this ONE task to unverified. Every
      // other read on this interface (ghGateway/buildBatchedGithub) already catches its OWN `gh`
      // errors internally and returns null/false; this call is EXTERNALLY supplied, so it gets
      // its own belt-and-suspenders catch rather than trusting that convention was followed.
      issue = github.issueByUrl?.(latest.issueUrl) ?? null;
    } catch {
      issue = null;
    }
  }
  // Case-INSENSITIVE: `gh issue view/list --json state` reports "OPEN"/"CLOSED" (verified live),
  // but this repo's OTHER GitHub-issue reader (issues-intake.ts, over `gh api`'s raw REST JSON)
  // already sees lowercase "open"/"closed" for the SAME underlying resource — two real, already-
  // coexisting conventions in this codebase. Normalizing here means whichever a `GitHub.issueByUrl`
  // implementation happens to surface, "confirmed open" and "confirmed closed" are read the same.
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

/**
 * Derive one task's FULL status taxonomy (W1-T155, MASTER-PLAN §7/§9): the PR-precedence
 * merge-state {@link derivePrPrecedence} always computed, layered with the in-flight phase
 * + startedAt/elapsed (from the ledger run state), the needs-human flag (from the open
 * escalation), and armed-awaiting-merge (from the PR auto-merge state the batched gateway's
 * single fetch also carries — {@link buildBatchedGithub}, zero extra GitHub calls). Pure
 * over its injected deps — no writes, no tasks.yaml access.
 */
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
    const runState = deriveRunState(ledgerLines, task.id);
    if (runState.inFlight && runState.phase) {
      // LIVENESS BOUND (W1-T179 design (ii), W1-T155's amended criterion): a ledger-only
      // in-flight trace is only "running" while it is BACKED by an open PR (base.status is
      // already "running" from the precedence rungs above -- independent, stronger GitHub
      // evidence, never subject to this bound) OR by ledger activity within the liveness
      // bound. Absent both, it is a stale/orphaned dispatch (a crashed worker's spin-loop --
      // the W1-T1 27h21m fixture) and must NOT render as running.
      const hasOpenPr = base.status === "running";
      const livenessBoundMs = deps.livenessBoundMs ?? DEFAULT_LIVENESS_BOUND_MS;
      const recentActivity =
        runState.lastActivityTs !== undefined && now() - Date.parse(runState.lastActivityTs) <= livenessBoundMs;
      // THE THIRD DISJUNCT (see DeriveDeps.inflightHolder): a HELD lock whose recorded holder
      // is judged STILL ALIVE by isHolderStale (W1-T368: pid liveness alone is not enough — a
      // recycled pid must not count). Both halves are required and neither is sufficient — the
      // lock alone survives its own process (no signal handlers exist, so SIGKILL and SIGTERM
      // both strand the file), and a live pid alone names nothing about this task. Absent
      // `inflightHolder` the whole disjunct is skipped, leaving the prior two-disjunct behaviour
      // byte-for-byte.
      const holder = deps.inflightHolder?.(task.id) ?? null;
      const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
      const hasLiveLock =
        holder !== null &&
        !isHolderStale(holder, { isPidAlive, getProcessStartTime: deps.getProcessStartTime });
      if (hasOpenPr || recentActivity || hasLiveLock) {
        projection.status = "running";
        projection.phase = runState.phase;
        // PROCESS-UNEVIDENCED (design note ii): held SEPARATELY from the disjunction just
        // evaluated — `recentActivity || hasLiveLock` is process evidence, and when an open PR
        // is the ONLY reason this row entered the branch, the decoration below is honest about
        // being backed by a remote fact rather than an observed local process. Never flips the
        // status word (note i) and never turns a merely-skipped lock read into "dead" (note iii).
        if (hasOpenPr && !recentActivity && !hasLiveLock) {
          projection.processUnevidenced = true;
        }
        if (runState.startedAt) {
          projection.startedAt = runState.startedAt;
          projection.elapsedMs = Math.max(0, now() - Date.parse(runState.startedAt));
        }
        // W1-T944: workerState rides the SAME "this row is running" gate as phase/startedAt
        // above (design note v — isRunningRow's phase != null definition governs) so a
        // finished/orphaned run can never carry a lingering worker-liveness word. Absent when
        // the run has emitted no worker.state row yet — the console renders "state unknown"
        // rather than treating a blank as a healthy default (design note iii).
        if (runState.workerState) {
          projection.workerState = runState.workerState;
          // workerStateSince backs the client's "quiet Nm" ageing tick (design note ii) — only
          // meaningful while the CURRENT state is quiet, so it stays sparse otherwise.
          if (runState.workerState === "quiet" && runState.workerStateSince) {
            projection.workerStateSince = runState.workerStateSince;
          }
        }
      } else {
        // Dispatched, no terminal verdict, no open PR, no recent activity, and no live lock:
        // unknown/orphaned, never running (the falsifier: an orphaned dispatch rendered as
        // running). A lock held by a DEAD pid lands here too, which is the point — a stale
        // lock must not resurrect the very defect this rung exists to prevent.
        projection.orphaned = true;
      }
    }
  }

  // W1-T2392: reaching here already proves NOT merged, i.e. every credit path came back empty —
  // so this only ever asks the remaining question, "did a build for this land anyway?". The index
  // is SUPPLIED by `projectPlan` off the merged list it already fetched, never fetched again here:
  // W1-T257's guard counts batched calls and a second one would break it. Absent the dep (every
  // per-task caller) this is silent and derivation is byte-identical to before.
  const uncredited = uncreditedBuildWarning(task.id, deps.proseNamedTaskIds, deps.github.changedFiles?.bind(deps.github));
  if (uncredited) projection.uncreditedBuild = uncredited;

  const escalation = resolveEscalation(ledgerLines, task.id, deps.github);
  if (escalation) {
    projection.needsHuman = true;
    if (escalation.issueUrl) projection.escalationIssueUrl = escalation.issueUrl;
    if (escalation.title) projection.escalationTitle = escalation.title;
    if (escalation.unverified) projection.escalationUnverified = true;
    if (escalation.openedAt) projection.escalationOpenedAt = escalation.openedAt;
  }

  // ARMED-AWAITING-MERGE: only meaningful for a currently OPEN PR — reuses the exact
  // prUrl the precedence rungs above already resolved, so this is never a second,
  // independently-resolved PR reference.
  if (projection.status === "running" && projection.prUrl && deps.github.autoMergeArmed?.(projection.prUrl)) {
    projection.armedAwaitingMerge = true;
  }

  // W1-T507: the OTHER reason a row needs a person — a task filed `verify: human` in the plan
  // itself. `isDispatchEligible` (`src/lib/drain.ts`), `assertRunnable` (`src/lib/plan.ts`) and
  // three `task-linter.ts` predicates all treat `task.verify === "human"` as an EXCLUSION from
  // machine attention and nothing else — the field's only effect anywhere else in this product
  // — so nothing before this point ever tells a person such a task is theirs to look at.
  //
  // COMPUTED HERE, deliberately NOT at the projectPlan level (unlike W1-T485's own
  // `supersededBy`, attached there because it needs an external git-log search dependency this
  // function does not take). This flag is a pure function of `task` plus THIS call's own
  // already-resolved `merged`/`indeterminate` — computing it here keeps every caller
  // (projectPlan's hoisted pass AND a standalone `deriveStatus(task, deps)` call alike)
  // DERIVATION-EQUIVALENT, exactly the invariant test/w1-t187-equivalence.test.ts's own
  // criterion 1 guards over the full production-scale corpus. `merged` is always false at this
  // point (an earlier guard above already returned `base` directly once `base.merged`), so only
  // `indeterminate` needs checking: while set, this cycle's GitHub read genuinely failed, so
  // "not yet credited" was never actually observed — flagging this off an unread state would be
  // the fail-open direction W1-T119 exists to prevent, same discipline the supersession loop in
  // {@link projectPlan} applies to its own field.
  //
  // DELIBERATELY A DIFFERENT FIELD FROM `needsHuman`, never a widened one (design (ii)):
  // `needsHuman`, set just above when applicable, backs the NEEDS ME escalation row's own "view
  // issue"/"mark handled" affordance (`escalationIssueUrl`/`escalationTitle`), which a
  // `verify: human` task never has — it is never DISPATCHED, so it never escalates. Setting
  // `needsHuman` here would render that affordance with nothing to click. A DISTINCT KIND
  // instead, so a caller (the console) groups by it rather than flattening two different
  // reasons a row needs a person into one flag.
  if (task.verify === "human" && !projection.indeterminate) {
    projection.verifyHumanPending = true;
  }

  return projection;
}

/**
 * Every distinct `task_id` named on an `escalation.issue_opened` ledger line (W1-T283) — the
 * ONE scan {@link projectPlan} needs to find escalations that may not belong to any plan task,
 * done once over the already-read ledger, never per candidate id.
 */
function taskIdsWithEscalationLines(lines: ReadonlyArray<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const line of lines) {
    if (line.step !== "escalation.issue_opened") continue;
    if (typeof line.task_id !== "string") continue;
    if (seen.has(line.task_id)) continue;
    seen.add(line.task_id);
    ids.push(line.task_id);
  }
  return ids;
}

// ── W1-T485: SUBSTANCE THAT SHIPPED UNDER ANOTHER TASK'S TRAILER ─────────────────────────────
//
// THE GAP THIS FILLS, AND THE ONE IT DOES NOT. W1-T458's `unresolved_task_scope` advisory
// (lib/review.ts) fires when a merging implementation diff resolves NO task, and its own doc says
// it is keyed on the resolved task's declared files "NEVER off whether the report/diff carries a
// `Remudero-Task:` trailer". So it answers "no task at all". It cannot answer "the WRONG task",
// and the measured case proves it: #1772 shipped that advisory at 2026-08-14T02:38:55Z, and
// #1777 merged three hours and sixteen minutes later carrying `Remudero-Task: W1-T464` while
// shipping W1-T472's substance. A task WAS resolved, so the advisory correctly stayed silent, and
// W1-T472 is still `blocked`/`verify: human` waiting on a ruling about work already on main.
//
// A REPORT, NEVER A GATE. Nothing here refuses a merge, mutates a Task, or adds a credit path. A
// merge-time refusal keyed on a trailer mismatch would fire on every FILING — filings are required
// to omit the trailer (#1527) — and a bound that fires on a healthy condition gets muted, which
// this repo has six measured instances of. A false positive here costs one line of output.

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

/**
 * Search history for a symbol within one path. Returns the commits that introduced or removed it,
 * or `null` when the read itself FAILED — a failed search must never read as "no evidence", the
 * same cannot-observe→defer polarity {@link deriveStatus}'s own `readFailed` rung keeps.
 */
export type SupersessionSearch = (symbol: string, path: string) => readonly SupersessionCommit[] | null;

const TRAILER_RE = /^Remudero-Task:[ \t]*([A-Za-z0-9-]+)[ \t]*$/m;

/**
 * A task's proof-derived symbols paired with every path the task declared.
 *
 * W1-T506 WIDENED THIS FROM `grep:`-ONLY. The instrument used to require a `grep:` proof whose
 * OWN body named a declared path (`SYMBOL in path/to/file`) — dialect-gated, and getting WORSE as
 * filing convention moves proofs from `grep:` to `unit test:` (a `unit test:` proof carries a test
 * TITLE, never an "in <path>" clause, so it produced zero targets no matter how many tasks used it;
 * MEASURED 2026-08-15: both of W1-T485's own motivating cases, W1-T467 and W1-T472, are all-`unit
 * test:` and were therefore invisible to the old predicate). The fix stops asking the proof BODY for
 * a path at all: a task's declared `files:` already supplies one for EVERY task regardless of
 * dialect, so pathing comes from `files:` and symbols come from whichever dialect prefix a proof
 * carries — `grep:` or `unit test:` — making derivation dialect-independent by construction rather
 * than by adding a second special case.
 *
 * WHY THE PROOF TEXT AND NOT THE FILE PATH ALONE, STILL. The cheap predicate — "have all this
 * task's declared paths moved on main since it was filed?" — was measured and REJECTED: it flags 14
 * of 43 unmerged tasks, and spot-checking every one of those 14 by symbol found no supersession in
 * any (a task merely naming `src/run-task.ts` is flagged by a file that moves several times a day).
 * A `grep:` proof pattern is the opposite: `proof-grep-safety` and `proof-resolvability`
 * (lib/task-linter.ts) already force it to be single-line and distinctive enough to match its own
 * subject and nothing else. A `unit test:` proof's raw name is the same kind of distinctive literal
 * by the SAME precedent {@link resolveNameFilteredCandidates} (lib/review.ts) already trusts: a
 * fixed-string search for a test's own title.
 *
 * EVERY SYMBOL IS PAIRED WITH EVERY DECLARED PATH, not just a path the proof body happens to name —
 * COST THAT HONESTLY: this is `O(proofs x files)` rather than `O(proofs)`, still seconds per rationale
 * (1) of this task's shard, never the O(N)-subprocess-per-task shape W1-T187/W1-T257 removed.
 *
 * The `grep:` split MIRRORS {@link proofGrepSafetyViolations} (lib/task-linter.ts) rather than
 * importing review.ts's `parseDialectGrep`, which is not exported — the same precedent, and the
 * same reason: an " in " followed by a PATH-LIKE trailing token is stripped from the SYMBOL when
 * present (kept for continuity with proofs already written that way), but is no longer required —
 * a path-less `grep:` body still yields a symbol now that the path always comes from `files:`.
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
 * The evidence that this task's substance shipped under a DIFFERENT task's trailer, or
 * `undefined` when there is none.
 *
 * FOUR OUTCOMES ARE DELIBERATELY COLLAPSED TO "NO EVIDENCE", AND EACH FOR ITS OWN REASON:
 *   - `opts.merged` is true — the union the caller already resolved this task's merge state
 *     against credits it merged, so reporting it here as "superseded" would contradict a stronger,
 *     already-resolved signal. THIS GUARD LIVES HERE, NOT ONLY AT THE `projectPlan` CALL SITE
 *     (W1-T506): `projectPlan` already skips a merged task before calling in, but the predicate
 *     must hold the same invariant when driven directly, so widening reach can never regress it;
 *   - a commit carrying THIS task's trailer is CREDIT, not supersession — the projection's own
 *     `trailer` source already handles it, and reporting it would name every task that ever merged;
 *   - a commit carrying NO trailer is W1-T458's `unresolved_task_scope` territory, and duplicating
 *     its finding here would put two instruments on one condition;
 *   - a `null` search is a FAILED READ, never an absence (see {@link SupersessionSearch}).
 * Only "a commit that names some OTHER task" survives, which is exactly the uncovered route.
 *
 * THE OLDEST QUALIFYING COMMIT WINS, NOT THE NEWEST (W1-T506, rationale (5) of this task's shard).
 * `search` returns commits in `git log`'s reverse-chronological order (newest first) — walking that
 * order forward and returning the first hit credits whichever task most recently touched the SAME
 * symbol, not the task that introduced it. Reversed, the last (oldest) commit `git log -S` reports
 * for a symbol is the one closest to its introduction, so it is checked FIRST.
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

/**
 * A {@link SupersessionSearch} backed by `git log -S`, the pickaxe that found both measured cases.
 * `exec` is injectable so the predicate above is testable without a repository; a throwing exec
 * yields `null` (failed read), never `[]`.
 *
 * NOT WIRED INTO ANY HOT PATH BY DEFAULT. `projectPlan` runs behind a 250ms-polled console, and one
 * `git log` per task per projection would be the O(N)-subprocess cost W1-T187 and W1-T257 both
 * already had to remove. The caller opts in by supplying `DeriveDeps.supersessionSearch`; absent it,
 * no search runs and no field is emitted.
 */
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
      // `-S<symbol>` with an explicit `--` so a symbol that looks like a flag or a path cannot be
      // read as one. RECORD-SEPARATED output: \x1e between commits, \x00 between fields, so a
      // subject or body containing a newline cannot split a record.
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

/**
 * W1-T2387 — THE TASK-ID GRAMMAR THE COMMIT SURFACE MUST BE FILTERED THROUGH.
 *
 * `appendTaskTrailerToCommit` is called at TWO sites and the second passes a RUN ID, not a task
 * id — `appendTaskTrailerToCommit(worktreePath, runId)` (W1-T1012, the Architect path) — so the
 * commit corpus genuinely contains `Remudero-Task: RETRO-1787193680272`,
 * `Remudero-Task: TRIAGE-fb-…` and `Remudero-Task: PR-2641` lines. A union that indexed those
 * would credit a run as though it were a task, which is a WIDER credit than the body surface
 * gives and the one failure mode this task must not introduce.
 *
 * MEASURED 2026-08-27 against both populations, not asserted: of 921 ids declared across
 * `plan/tasks.yaml` and every `plan/tasks.d/*.yaml` shard, this rejects ZERO; of 740
 * `Remudero-Task:` tokens on `origin/main` commit bodies it accepts 570 and rejects 170 — every
 * rejected one a run id. The optional trailing letter is real (`W1-T123a`, `W1-T123B` are live
 * plan ids), which is why it is not `[0-9]+$`.
 */
export const TASK_ID_TRAILER_RE = /^W[0-9]+-T[0-9]+[A-Za-z]?$/;

/** A squash merge's own PR number, off the `(#N)` suffix `gh` writes into the subject — the SAME
 *  join the shard's 2,389-PR measurement used. A commit whose subject names no PR is skipped
 *  rather than guessed at: without a number there is no {@link PrRef} to return. */
function prNumberFromSquashSubject(subject: string): number | undefined {
  const m = /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : undefined;
}

/**
 * W1-T2387 — THE SECOND TRAILER SURFACE, AS AN INDEX.
 *
 * THE ASYMMETRY THIS CLOSES. The commit trailer is MACHINE-written (`appendTaskTrailerToCommit`
 * amends the worker's tip commit, idempotently, on both PR paths) while the PR-body trailer is
 * HAND-written (`renderBody` emits it only when a caller passes `taskId`). `findMergedByTrailer`
 * read only the hand-written one, so 16 merged PRs carried the trailer in the commit and not the
 * body and nine of them were credited nowhere — four of those nine in two days.
 *
 * A UNION, NEVER A COMPARISON. This is consulted only AFTER the body surface has answered and
 * answered EMPTY, so it can only ever ADD credit. It never withdraws one, never disagrees with
 * one, and has no refuse-a-merge failure mode — which is why it lives on the read path rather
 * than in a gate. (The miss is only observable after merge, once a dispatch is already spent.)
 *
 * NO NEW FETCH. `git log` over a ref that is already local — MEASURED at 32 ms for 3.6 MB over
 * this repo's whole history — and callers memoize it, so it is O(1) subprocesses per gateway
 * instance and runs at all only once some task actually misses on the body surface.
 *
 * `null` on a failed read, never an empty Map: the failure/absence distinction every other
 * reader in this file keeps (W1-T119). Newest first, matching `findMergedByTrailer`'s own
 * documented ordering — `git log` already emits in that order.
 *
 * ⚠ THE WHOLE SURFACE DEPENDS ON A REPO SETTING THIS FILE OTHERWISE NEVER NAMES (W1-T2447).
 * This reads `git log`, which sees only what GitHub actually WROTE into the squash commit — and
 * GitHub chooses that content from the repo's `squash_merge_commit_message` setting.
 * `COMMIT_MESSAGES` concatenates the branch's own commit subjects/bodies into the squash commit,
 * which is the ONLY reason `appendTaskTrailerToCommit`'s amended tip-commit trailer is still
 * there for the `git log` below to find. The other legal value, `PR_BODY`, discards the branch
 * commits entirely and writes the PR body instead. MEASURED against this repository's own
 * settings: `squash_merge_commit_message: "COMMIT_MESSAGES"`. That is an admin-only GitHub UI
 * toggle — no commit, no review, no ledger row — and flipping it to `PR_BODY` does not break
 * this function: it keeps returning a `Map` and {@link deriveStatus} keeps reading it, but every
 * FUTURE squash stops carrying a trailer at all, so the index quietly stops growing while
 * looking exactly as healthy as it does today. Before this comment and the pinning test at
 * `test/commit-trailer-surface-squash-setting.test.ts`, nothing in `src/`, `test/` or
 * `.github/` named `squash_merge_commit_message` at all.
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
        // NOT OPTIONAL HARDENING — MEASURED: this repo's own history renders 3.6 MB through this
        // format, and Node's `execFileSync` default `maxBuffer` is 1 MiB, so the default throws
        // ENOBUFS and the index reads `null` (a FAILED read) on every real repository. The first
        // probe of this reader against the live corpus returned exactly that. `1 << 24` is the
        // same ceiling `orientation.ts`/`plan-pr-emitter.ts`/`measurement-cadence.ts` already use
        // for whole-history git reads.
        maxBuffer: 1 << 24,
      }));
  return () => {
    // THE CHECKOUT MUST BE THIS GATEWAY'S OWN REPO, AND THIS IS NOT DEFENSIVE TIDINESS — IT IS A
    // DEFECT THIS TASK ALREADY SHIPPED ONCE AND CAUGHT. A gateway is constructed for an explicit
    // `owner`/`repo`, but `git log` reads whatever checkout the PROCESS happens to sit in. The
    // first draft consulted it unconditionally, and running every caller in full turned two
    // suites red: a `buildBatchedGithub("o", "r")` fixture asking about `W1-T1` was answered with
    // craigoley/remudero's own #255, and an `("acme", "remudero")` fixture's genuine miss came
    // back as a hit. A local commit surface is evidence about the LOCAL repo and about no other,
    // so it is consulted only when `origin` actually names this gateway's slug.
    //
    // AN EMPTY MAP, NOT `null`: a foreign checkout is a genuine ABSENCE of local evidence, not a
    // failed read, and the two must stay distinguishable (W1-T119) — `null` is reserved for the
    // `git log` itself failing, below.
    let originUrl: string;
    try {
      originUrl = exec(["config", "--get", "remote.origin.url"]).trim();
    } catch {
      // No `origin` remote to read, so this checkout cannot be SHOWN to be this gateway's repo.
      // That is the foreign-checkout case the block comment above describes: a genuine ABSENCE of
      // local evidence, which is an empty map — never `null`, which this file reserves for the
      // `git log` read itself failing.
      return new Map();
    }
    const localSlug = originUrl.replace(/\.git$/, "").replace(/^.*[:/]([^/]+\/[^/]+)$/, "$1");
    if (localSlug.toLowerCase() !== slug.toLowerCase()) return new Map();
    let raw: string;
    try {
      raw = exec(["log", ref, "--format=%H%x00%s%x00%b%x1e"]);
    } catch {
      // The local commit surface could not be READ (no such ref, a shallow clone, a git that would
      // not run). `null` is this file's "unreadable", kept distinct from the empty map above so a
      // failed read is never mistaken for a repo that genuinely credits nothing (W1-T119).
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

/**
 * Derive every task in a plan and cache the projection to `cachePath`
 * (state/status.json). Returns a taskId -> projection map. Writes ONLY the cache.
 */
export function projectPlan(
  plan: Plan,
  deps: DeriveDeps,
  cachePath?: string,
): Map<string, StatusProjection> {
  // MONOTONIC UNDER DARKNESS (W1-T179): when the caller has not already injected its own
  // `previousProjection` (e.g. a long-lived server's in-memory snapshot), fall back to
  // reading THIS cache file's PRIOR contents before they are overwritten below -- the
  // natural "last successfully observed projection" for any caller that persists to
  // `cachePath`. Every existing `projectPlan(plan, deps, statusPath)` call site gets the
  // fix for free, with no wiring changes of its own. Fails soft to "nothing to fall back
  // on" on a missing/corrupt cache, same discipline as readLedgerLines' malformed-line
  // handling above.
  let effectiveDeps = deps;
  if (cachePath && !deps.previousProjection) {
    const previousByTaskId = readCachedProjections(cachePath);
    if (previousByTaskId) {
      effectiveDeps = { ...deps, previousProjection: (taskId) => previousByTaskId.get(taskId) };
    }
  }
  // READ THE LEDGER ONCE (W1-T187): `deriveStatus` reads+parses the WHOLE NDJSON ledger via
  // `deps.readLedger` on every call, and the loop below calls `deriveStatus` once PER TASK --
  // so an N-task plan re-read and re-parsed the entire ledger N times (O(tasks x ledger)),
  // clocked at 5-8s per projection against the 250ms-polled console's <2s budget. `ledgerPath`
  // is a single field on `deps`, shared by every task in this call, and the ledger cannot
  // change mid-loop (nothing here writes to it), so read+parse it exactly once up front and
  // hand every task the SAME already-parsed array via an overriding `readLedger` -- same
  // batch-once-amortize-over-N-tasks shape as {@link buildBatchedGithub}'s fix for the
  // analogous O(N) `gh` subprocess cost below.
  const readLedgerOnce = effectiveDeps.readLedger ?? readLedgerLines;
  const ledgerLinesOnce = readLedgerOnce(effectiveDeps.ledgerPath);
  effectiveDeps = { ...effectiveDeps, readLedger: () => ledgerLinesOnce };
  // W1-T951 DELIVERABLE A, READ+WRITE THE DURABLE CREDIT STORE ONCE PER PLAN — same
  // batch-once-amortize-over-N-tasks shape as the ledger read directly above: without this, an
  // N-task plan would open+JSON.parse the store file once per task (deriveStatus's own default),
  // and — worse — a task-by-task write would fsync N times per projection instead of once. Every
  // write `derivePrPrecedence` discovers during the loop below is accumulated in `creditStoreLive`
  // and flushed in ONE save after the loop, only if it actually changed.
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
  // BATCHED rung (c2) CORROBORATION (W1-T257): #737 corroborates an empty trailer search with a
  // per-task `gh pr list --search head:run-<taskId>-`, which fires for EVERY uncredited task on
  // EVERY projection (the 07-23 GraphQL-exhaustion multiplier). Fetch every merged PR's head ref
  // ONCE here — same batch-once-amortize-over-N-tasks shape as the ledger read above (and
  // buildBatchedGithub) — and hand each task's `deriveStatus` a CLIENT-SIDE `run-<taskId>-\d+`
  // match into that single fetch. Matches the STRUCTURED head ref, never the body full-text index.
  // A FAILED batched read yields `null` for every task: derivePrPrecedence then falls back to the
  // per-task `findMergedByHeadBranch`, and if THAT also fails, `readFailed()` defers via W1-T119 —
  // never a false none. A gateway that doesn't implement the batched method (`undefined`) is left
  // untouched, so per-task callers behave exactly as #737.
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
    // W1-T2392: the SAME `allMerged` rows, walked once more in memory for the prose index — no
    // second fetch, and skipped entirely when the batched read failed (`null`).
    const prose = allMerged !== null ? indexProseNamedTaskIds(allMerged) : undefined;
    effectiveDeps = {
      ...effectiveDeps,
      ...(prose ? { proseNamedTaskIds: prose } : {}),
      mergedHeadBranches: captured ? (taskId: string) => captured.get(taskId) ?? [] : () => null,
    };
  }
  /** W1-T2397: every OPEN PR this pass already fetched, for the open-sibling observation. */
  let openForSiblings: readonly PrRef[] | undefined;
  // BATCHED rung (c3) CORROBORATION (W1-T377) — the same batch-once shape as the merged index
  // directly above, over the OPEN slice of the SAME fetch. Free on `buildBatchedGithub`; a single
  // extra `gh pr list --state open` on `ghGateway`. A FAILED read yields `null` for every task, so
  // the rung skips and `readFailed()`/W1-T119 does the deferring — never a false "no open PR".
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
    // W1-T2397: the SAME `allOpen` rows, kept for the open-sibling observation below — no second
    // enumeration, and `null` (a failed read) stays `undefined` so the observation simply does not
    // fire rather than reporting an absence it cannot see.
    openForSiblings = allOpen ?? undefined;
  }
  const byId = new Map<string, StatusProjection>();
  for (const task of plan.tasks) {
    const p = deriveStatus(task, effectiveDeps);
    // W1-T2397: computed HERE rather than inside `deriveStatus` so it can never be mistaken for a
    // precedence input — it is attached after the projection is decided, and read only by a log.
    if (!p.merged) {
      const sib = openSiblingBuild(task.id, task.files, openForSiblings, effectiveDeps.github.changedFiles?.bind(effectiveDeps.github));
      if (sib) p.openSiblingBuild = sib;
    }
    byId.set(task.id, p);
  }
  // W1-T951: ONE flush for the whole plan sweep — see the batching note above. Skipped entirely
  // when nothing new was discovered this cycle (the common case once a plan's credits are mostly
  // durable), so a steady-state poll loop costs zero writes, not one no-op write per cycle.
  if (creditStoreLive !== creditStoreAtStart) flushCreditStore(creditStoreLive);
  // W1-T485 — attached HERE rather than inside `deriveStatus` so that function, which every
  // precedence rung and every existing test drives, is left byte-identical: this is an additive
  // observation about tasks the rungs have ALREADY resolved, not a new rung. Skips anything the
  // projection judged merged (a merged task's credit is the projection's own business) and
  // anything `indeterminate` (its `merged: false` was never actually observed — reporting a
  // supersession off an unread state would be the fail-open direction W1-T119 exists to prevent).
  const supersessionSearch = effectiveDeps.supersessionSearch;
  if (supersessionSearch) {
    for (const task of plan.tasks) {
      const projection = byId.get(task.id);
      if (!projection || projection.merged || projection.indeterminate) continue;
      // `merged` is always false here (the loop above already skipped a merged projection) --
      // passed explicitly anyway so the invariant is the PREDICATE's, not just this loop's, per
      // findSupersessionEvidence's own doc comment on why the guard lives at both places.
      const evidence = findSupersessionEvidence(task, supersessionSearch, { merged: projection.merged });
      if (evidence) byId.set(task.id, { ...projection, supersededBy: evidence });
    }
  }
  // TASK-LESS ESCALATIONS (W1-T283): the loop above is a function of plan.tasks ALONE, so an
  // escalation whose ledger `task_id` names no plan task (a triage/mount-probe id minted
  // outside the plan) had no row to attach to and could never render, however long it stayed
  // open — the panel read "nothing needs you" while dozens of such issues were open. A SECOND,
  // INDEPENDENT source (never a wider version of the loop above, which would still require a
  // plan Task to hand deriveStatus): scan the ledger once for every escalated task_id and, for
  // any id the plan does NOT own, resolve it live and add its OWN row. An id the plan DOES own
  // is skipped here — it already got its row above — so nothing is ever double-counted.
  for (const taskId of taskIdsWithEscalationLines(ledgerLinesOnce)) {
    if (plan.byId.has(taskId)) continue;
    const escalation = resolveEscalation(ledgerLinesOnce, taskId, effectiveDeps.github);
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
    // ATOMIC WRITE (this task): four call sites (run-task.ts) share this one write path,
    // and a 250ms-polled reader (readCachedProjections above, plus any external tailer of
    // state/status.json) can land its read mid-`writeFileSync` -- a plain truncating write
    // is not atomic, so a torn read sees a truncated prefix, JSON.parse throws, and
    // readCachedProjections fails soft to `undefined`, silently discarding the very
    // "last successfully observed projection" W1-T179's monotonic-under-darkness fallback
    // depends on. Write to a sibling temp file, then rename onto `cachePath`: POSIX rename
    // is atomic within the same directory, so a concurrent reader always observes either the
    // old complete file or the new complete file, never a partial one. The temp name is
    // salted with pid + a random suffix so two writers targeting the same cachePath (e.g. two
    // run-task.ts processes racing on the same plan) never collide on the same temp file.
    const tmpPath = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(projection, null, 2) + "\n");
    fs.renameSync(tmpPath, cachePath);
  }
  return byId;
}

/**
 * Read a previously-written `state/status.json` cache back into a taskId -> projection map
 * (W1-T179) -- undefined on anything short of a well-formed prior write (missing file,
 * unparseable JSON, or a shape that is not `{ tasks: {...} }`), never throwing. Feeds
 * {@link projectPlan}'s own darkness fallback; not exported, since a caller wanting a
 * `previousProjection` for reasons OTHER than "read my own prior cache write" (e.g. an
 * in-memory snapshot) can and should inject it directly on {@link DeriveDeps}.
 */
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
 * Read a repo's REQUIRED status-check contexts straight from GitHub branch
 * protection (W1-T103, the #170 stuck-ambiguous fix) — the authoritative list
 * {@link checksStateFromRollup} in lib/sweep.ts gates checksState on, read
 * ONCE per repo/branch by the real wiring rather than inferred from whichever
 * checks happen to report on a given PR. Fails SOFT to `undefined` on ANY
 * error (missing protection, an unprivileged token, `gh` absent) — never
 * throws, so an unreadable protection rule degrades the caller to its
 * pre-fix conservative fallback instead of crashing the sweep.
 */
/**
 * W1-T2399 — THE THREE READINGS THAT USED TO COLLAPSE INTO ONE `undefined`.
 *
 * {@link ghRequiredStatusCheckContexts} answers `string[] | undefined`, and THREE different facts
 * arrive as that same `undefined`: protection that genuinely declares no required contexts, a
 * protection object that declares an empty list, and a read that FAILED OUTRIGHT (no `gh`, an
 * unprivileged token, a network error, unparseable JSON). The caller then sets one boolean from
 * it, and by the time the sweep renders an escalation the cause is gone — so a repo-wide read
 * outage is reported as a claim about the PR's own checks.
 *
 * This is the same split W1-T2370 made between `unverifiable` and `refuted` on the review surface:
 * "could not check" and "checked, and the answer is none" are different facts and must not share
 * a representation.
 *
 * FAIL-SOFT IS UNCHANGED (W1-T176 boundary (ii) is NOT reopened): this still never throws, and a
 * caller that cannot read protection still treats the gate as unreadable and still escalates. What
 * changes is only that the reason survives the read.
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
    // THE FACT THIS TASK EXISTS TO PRESERVE. One line, classified at the point of failure, because
    // nothing downstream can recover it: `gh` absent, an unprivileged token, a network error and a
    // 404 on an unprotected branch all land here and all used to become a bare `undefined`.
    return { kind: "unreadable", branch, reason: firstLine((e as Error)?.message) || "gh read failed" };
  }
  try {
    const parsed = JSON.parse(raw) as { contexts?: unknown; checks?: Array<{ context?: unknown }> };
    const fromChecks = (parsed.checks ?? [])
      .map((c) => c.context)
      .filter((c): c is string => typeof c === "string" && c.length > 0);
    if (fromChecks.length > 0) return { kind: "contexts", contexts: fromChecks };
    const fromContexts = Array.isArray(parsed.contexts) ? parsed.contexts.filter((c): c is string => typeof c === "string") : [];
    // READ SUCCESSFULLY, AND THE ANSWER IS NONE — a different fact from a failed read, and the
    // whole point of the split. The branch is protected; it simply requires no contexts.
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
  // W1-T2399: a THIN WRAPPER over the classified read above, so every pre-existing caller keeps
  // the exact `string[] | undefined` contract it was written against. `none` and `unreadable` both
  // answer `undefined` here, which is precisely the collapse the classified form exists to avoid —
  // a caller that needs to tell them apart calls `readRequiredStatusCheckContexts` directly.
  const read = readRequiredStatusCheckContexts(owner, repo, branch);
  return read.kind === "contexts" ? read.contexts : undefined;
}

// ── Real GitHub gateway (execs `gh`; runs outside the sandbox — TLS only there).

/**
 * Build a {@link GitHub} gateway scoped to `owner/repo`. Every query is fail-soft:
 * a missing PR or a `gh` error resolves to null, so derivation degrades to the
 * next precedence source rather than throwing.
 *
 * `opts.exec` (W1-T119) is an INJECTABLE stand-in for the raw `gh` invocation —
 * real callers omit it and get the actual `execFileSync("gh", args, ...)` call;
 * unit tests inject a fake that throws an `{status, stderr}`-shaped error to
 * simulate a rate-limited/auth-expired/network-down `gh` failure WITHOUT
 * shelling out, so {@link classifyGhFailure} can be exercised deterministically
 * against exactly the exit status + stderr a real failure would carry.
 */
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
  // W1-T2387 — THE COMMIT SURFACE, MEMOIZED AND LAZY. Built at most ONCE per gateway instance and
  // only once some task has actually missed on the body surface, so a repo whose bodies all carry
  // the trailer never shells `git` at all. This is deliberately NOT TTL'd like the body index:
  // commits are append-only, so a stale index can only ever LACK a very recent merge — which is
  // precisely the case the body surface answers.
  let commitIndex: Map<string, PrRef[]> | null | undefined;
  const commitTrailerFallback = (taskId: string): PrRef[] => {
    if (commitIndex === undefined) commitIndex = (opts.commitTrailerIndex ?? buildCommitTrailerIndex({ slug }))();
    return commitIndex?.get(taskId) ?? [];
  };
  // W1-T2387: the re-verify half, over the SAME memoised index — never a second `git` call.
  const commitCreditsFor = (taskId: string, prUrl: string): boolean =>
    commitTrailerFallback(taskId).some((r) => r.url === prUrl);
  // Sticky for this gateway instance's lifetime (W1-T119): once ANY `gh` call fails,
  // every null/[] result derived since is untrustworthy as "absent", not just the one
  // that failed — a single short-lived gateway (created per command invocation) has
  // no cheaper way to know which earlier calls in the same derivation shared the same
  // outage, so it errs toward "defer everything" rather than risk one still reading
  // as a confirmed not-merged.
  let failed = false;
  let failureReason: GhFailureReason | undefined;
  const rawRun =
    opts.exec ??
    // stdio's 3rd fd is now `pipe`, not `ignore` (W1-T119 design (i)): the
    // pre-fix triple discarded `gh`'s stderr — the one place a rate-limit or
    // auth message appears — before anyone could classify WHY a read failed.
    // `timeout` is not optional hardening here — see GH_CALL_TIMEOUT_MS: execFileSync is
    // synchronous, so an unbounded `gh` parks the whole process, not just this read.
    ((args: string[]) =>
      execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GH_CALL_TIMEOUT_MS }));
  // W1-T2219: `attempted`/`inFlight` back `readState()` below — wrapping the ONE call point
  // every query method already funnels through (`tryJson`/`tryLines`, both call `run`) means
  // neither needs its own bookkeeping. `inFlight` is only observable from a REENTRANT call
  // (an injected `opts.exec` that calls back into this gateway while it runs); the real
  // `execFileSync` path blocks the whole process for its duration, same as everywhere else in
  // this file that notes it.
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
  // Same sticky-failure bookkeeping as `tryJson`, for the ONE call here (`changedFiles`) that
  // reads plain `--jq`-filtered lines rather than a JSON document — mirrors
  // `buildBatchedGithub`'s own `changedFiles` below, which pays this exact same shape for the
  // exact same reason (`--paginate` without `--jq` emits one JSON array PER PAGE, which
  // `JSON.parse` rejects outright).
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
  // `ref` is either a bare PR number (`task.pr`) or a full PR URL (a ledger `pr.opened` line) —
  // the two shapes every real call site here ever passes. REST addresses a PR by number only, so
  // both are folded down to one here rather than re-derived at each call site.
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
  // Body/head-branch search, REST's `/search/issues` (NOT `gh pr list --search`, which — like
  // every other `pr view`/`pr list` invocation — is answered off GraphQL's `search()` connection
  // regardless of the flags passed to it). GitHub's query-qualifier language (`repo:`, `is:pr`,
  // `is:merged`, `in:body`, `head:`) is shared verbatim between the GraphQL and REST search
  // surfaces, so the query string itself does not change — only the transport does. `sort=created`
  // `order=desc` pins the ordering the pre-conversion callers already relied on (`findMergedByTrailer`'s
  // own doc: "newest first") rather than falling back to search's relevance-ranked default, which a
  // bare `--limit 1` read cannot afford to leave unspecified.
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
      // "title" rides along on this SAME fetch (W1-T184) — a decoration, never an extra
      // call: lib/board.ts's RECENT activity feed reads it off the SAME PrRef this
      // method already returns for every other caller.
      const row = fetchPrRow(ref);
      return row && typeof row.number === "number"
        ? { number: row.number, url: row.html_url, state: prStateFromRest(row), title: row.title }
        : null;
    },
    findMergedByTrailer(taskId) {
      // GitHub body search for the exact trailer, merged PRs only, newest first.
      // Fuzzy (P16 / W1-T69) — callers must re-verify via headRefName + prBody
      // before crediting; this is a first pass, never the authority.
      const list = searchMergedPrs(`"Remudero-Task: ${taskId}" in:body`, 1);
      if (list && list.length > 0) return list[0];
      // W1-T2387: THE BODY IS STILL THE FIRST SURFACE — this runs only when the body search
      // SUCCEEDED and found nothing. `null` means the read FAILED, and an outage must keep
      // reporting as an outage (W1-T119/readFailed), never be papered over with local evidence.
      if (list === null) return null;
      return commitTrailerFallback(taskId)[0] ?? null;
    },
    findMergedByTrailerAll(taskId) {
      // W1-T441: the SAME fuzzy body search, widened past `--limit 1`. Unlike the batched twin
      // below this DOES cost a wider fetch, which is why it stays a separate method rather than
      // changing what `findMergedByTrailer` returns: existing callers keep the one-hit answer and
      // pay nothing new. TRAILER_ALL_LIMIT bounds it — a task with more than that many merged
      // trailer-bearing PRs has a bigger problem than attribution.
      const byBody = searchMergedPrs(`"Remudero-Task: ${taskId}" in:body`, TRAILER_ALL_LIMIT);
      // W1-T2387: same union, same order of precedence — body first, commit surface only on a
      // successful empty answer, so every answer the body already gave is byte-identical.
      if (byBody === null || byBody.length > 0) return byBody;
      return commitTrailerFallback(taskId).slice(0, TRAILER_ALL_LIMIT);
    },
    findMergedByHeadBranch(taskId) {
      // Merged PRs whose HEAD BRANCH is `run-<taskId>-*` (W1-T256). `head:` is a
      // STRUCTURED ref qualifier — it matches the branch name, NOT the body
      // full-text index that rung (c)'s `in:body` search depends on and that a
      // single eventually-consistent miss emptied (the false not-merged). Fuzzy
      // like the trailer pass (a `head:` prefix can over-match), so `headRefName`
      // rides along and the caller re-asserts `run-<taskId>-\d+` ownership before
      // crediting. null on a `gh` FAILURE (→ readFailed()/W1-T119), [] on a
      // genuine no-such-branch — the two must stay distinguishable.
      //
      // REST's search-issues result carries no `head` field (it is an Issue shape, not a
      // PullRequest one), unlike GraphQL's search connection which resolved `headRefName`
      // straight off the same fetch — so each (bounded, ≤10) hit pays one more REST read to
      // recover it, the same bounded per-match follow-up shape `changedFiles`/
      // `hydrateMergeStates` already use elsewhere in this file.
      const hits = searchMergedPrs(`head:run-${taskId}-`, 10);
      if (hits === null) return null;
      return hits.map((h) => {
        const row = tryJson<RestPullRow>(singlePrRestArgs(owner, repo, h.number));
        return { ...h, headRefName: row ? mapRestPr(row).headRefName : undefined };
      });
    },
    listMergedHeadBranches() {
      // ONE list of every merged PR's head ref (W1-T257) — projectPlan matches run-<taskId>-*
      // CLIENT-SIDE for the whole plan from this single fetch. Deterministic LIST API, NOT the
      // eventually-consistent body full-text index. null on a `gh` FAILURE (→ readFailed()/W1-T119).
      // REST's `/pulls?state=closed` carries CLOSED-and-unmerged rows too, exactly like
      // `fetchBoardPrsRest`'s own COLD half — `prStateFromRest` (not `state.toUpperCase()`) is
      // what separates a genuinely merged row from a closed-unmerged one here.
      const rows = listPullsByState("closed", 1000);
      if (rows === null) return null;
      return rows
        .filter((r) => prStateFromRest(r) === "MERGED")
        .map((r) => ({ number: r.number, url: r.html_url, state: "MERGED", headRefName: r.head?.ref ?? "" }));
    },
    listOpenHeadBranches() {
      // W1-T377: the OPEN twin of listMergedHeadBranches — one list of every open PR's head ref,
      // matched `run-<taskId>-*` CLIENT-SIDE by projectPlan. Deterministic LIST API, never the
      // body full-text index. null on a `gh` FAILURE (→ readFailed()/W1-T119), [] on genuinely
      // no open PRs — the two must stay distinguishable.
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
      // W1-T413. Mirrors `buildBatchedGithub`'s own `changedFiles` below: `/pulls/{n}/files` has
      // no field-selection story the way `gh --json` did, so this reads filenames straight off
      // `--jq` rather than parsing (and discarding most of) the full file-diff payload.
      // `tryLines` returns null on a `gh`/REST failure, which is the UNAVAILABLE signal the
      // caller keeps today's answer for.
      const n = prNumberFromRef(prUrl);
      if (n === undefined) return undefined;
      const lines = tryLines(["api", "--paginate", `repos/${slug}/pulls/${n}/files`, "--jq", ".[].filename"]);
      if (!lines) return undefined;
      // A row set that parsed but yielded no usable path is a MALFORMED read, not an empty PR —
      // report it as unavailable rather than as a changeset that touches nothing.
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
      // Already non-forcing (W1-T2219): this gateway never shelled out on its own initiative —
      // every `gh` call here is driven by an actual query method — so the sticky `failed` flag
      // is exactly the "most recently completed attempt" verdict `readFailed()` now promises.
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
    // Shares the same sticky `failed` flag as `readFailed()` above (W1-T119's per-instance
    // "one outage taints every read since" discipline) — this per-task gateway makes one `gh`
    // call per query already, so there is no separate batched issue-fetch to distinguish.
    issueReadFailed() {
      return failed;
    },
    // W1-T2219: same one-`gh`-call-per-query shape as `issueReadFailed()` above — no separate
    // issue-channel fetch to distinguish here, so this shares the SAME sticky reason
    // `readFailureReason()` reports.
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
  /**
   * GitHub's raw `autoMergeRequest` field (W1-T155): `null`/absent when auto-merge is not
   * armed, an object when it is. Carried verbatim (never pre-reduced to a boolean) so the
   * gateway's `autoMergeArmed` method applies the SAME `!= null` test `ghGateway` and
   * run-task.ts's `buildOpenPrViews`/`buildOpenPrView` already use for this exact field.
   */
  autoMergeRequest?: unknown;
  /** The PR's title (W1-T184) — see {@link PrRef.title}; carried verbatim off the same batched fetch. */
  title?: string;
}

/**
 * One issue row from the single batched `gh issue list --label needs-human` fetch that backs
 * {@link buildBatchedGithub}'s {@link GitHub.issueByUrl} (W1-T182) — the escalation-state
 * counterpart to {@link BatchedPr}, fetched and cached exactly the same way (one call, TTL-
 * refreshed) so resolving 44+ escalated rows' live state costs the SAME one `gh` call the board
 * already pays for PRs, never one call per row.
 */
export interface BatchedIssue {
  number: number;
  url: string;
  state: string;
  title?: string;
}

/**
 * A GitHub gateway that answers ALL of {@link GitHub}'s methods from ONE batched fetch of the
 * repo's PRs, held in memory (with a short TTL), instead of shelling `gh` PER call.
 *
 * WHY: {@link ghGateway}'s `findMergedByTrailer` runs a `gh pr list --search` PER task, so
 * `projectPlan` over an N-task plan makes O(N) sequential `gh` subprocesses. On the board's
 * `GET /v1/status` request path that is ~0.4s × N — at 183 tasks, ~74s, and the browser hangs at
 * "loading…". This gateway makes it O(1): the first method call fetches every PR once
 * (`number,url,state,headRefName,body`), and all N tasks in a snapshot resolve against the shared
 * in-memory index. The index refreshes after `ttlMs`, so the board stays live.
 *
 * Drop-in for `ghGateway`, but `findMergedByTrailer` matches the ANCHORED `Remudero-Task:` line
 * (not a fuzzy substring) so `W1-T1` never mis-selects a `W1-T15` PR — deriveStatus's rung (c)
 * re-verify then confirms it exactly as before.
 *
 * The underlying fetch is still LAZY by default (the first query method call triggers it) — W1-
 * T154's boot-time pre-warm (lib/serve.ts's `prewarmBoardGithub`) is what turns that into "never
 * cold on the request path", by calling the optional {@link GitHub.warm} this gateway implements
 * BEFORE the server's first request can arrive, then again on a background timer paced to `ttlMs`.
 *
 * W1-T181 (the LIVE OUTAGE this repo's PR JSON crossing 1 MiB caused): the default fetch's
 * `execFileSync` now sets `maxBuffer: 1 << 26` (64 MiB headroom, not a value tuned to today's
 * payload — orientation.ts:72's `1 << 24` is the in-repo precedent for this class of fix). That
 * alone removes today's TRIGGER, but a THROWING fetch — a network blip, an auth expiry, a `gh`
 * upgrade, or simply outgrowing 64 MiB later — is the deeper, still-live defect: the pre-fix catch
 * did `lastFetchFailed = true; return []`, converting "I could not read GitHub" into "GitHub says
 * there are zero PRs", a bare `[]` a caller cannot tell apart from a genuinely empty repo. Fixed
 * here two ways: (1) the catch now lives in {@link index} itself, wrapping the call to `fetchAll`
 * — so an INJECTED `fetchAll` (every unit-test fixture, and any future caller-supplied
 * implementation) that throws is classified and marked exactly like a real `gh` failure, not just
 * the default execFileSync path; (2) `lastFetchFailed`/`lastFetchFailureReason` back this
 * gateway's `readFailed()`/`readFailureReason()`, which `derivePrPrecedence` (below, ~line 596)
 * already consults BEFORE trusting an empty result — the exact `github_unobservable`-shaped signal
 * W1-T179's monotonic-under-darkness criterion is designed to consume (this task is the producer,
 * W1-T179 the consumer; see plan/tasks.yaml W1-T181 design (v)). A failure is also now LOUD: see
 * {@link index}'s catch for the `console.error` + injectable `opts.log` calls, and
 * {@link classifyGhFailure}'s new `"buffer_overflow"` branch — ENOBUFS carries no `gh` stderr and
 * no exit status, so without that branch this exact failure classified `"unknown"` and the
 * 2026-07-20 outage ran for hours with zero error lines anywhere.
 */

/**
 * The commit-status context the merge gate keys on (lib/review.ts's `REVIEW_CONTEXT`,
 * run-task.ts's own `REVIEW_CTX`) — duplicated as a LOCAL literal rather than imported, exactly
 * like run-task.ts already does, so this file never imports lib/review.ts (which itself imports
 * `readLedgerLines` from HERE — an import the other way would be circular).
 */
const REVIEW_STATUS_CONTEXT = "remudero-review";

/**
 * W1-T1005: the process-lifetime {@link GhCallPacer} every {@link buildBatchedGithub} gateway
 * shares when its caller omits `opts.pacer`. Lazily created on first use, never rebuilt — module
 * scope, not function scope, is what makes "shared" true: a pacer built fresh inside
 * `buildBatchedGithub` on every call would give each gateway its own gap-tracking state, which is
 * exactly today's defect (independently-polite callers still collide at second zero) under a new
 * name. See lib/open-prs-rest.ts's `GhCallPacer` doc for why one instance, not one per site, is
 * what actually prevents the collision, and this function's own `pacer` option doc for why an
 * EXPLICIT `opts.pacer` (every test fixture that passes one) still wins over this default.
 *
 * ITS `sleepSync` IS REAL EVERYWHERE EXCEPT UNDER THE NODE TEST RUNNER. `createGhCallPacer`'s
 * default gap is `DEFAULT_GH_PACE_MIN_GAP_MS` (1,500ms) and this default is a MODULE singleton,
 * so every one of a test file's unpaced `buildBatchedGithub` calls that reaches a real fetch
 * shares it and blocks on the SAME real clock — measured on test/status.test.ts alone: 1.3s
 * before this default existed, 64.4s with a plain `createGhCallPacer()` default (48x). `gapMs`
 * still moves and `recordResult` still runs unconditionally; only the actual blocking wait is
 * skipped, via `isTestRunner()` (lib/live-write-guard.ts) — the same established, presence-
 * tested signal `spawn-guard.ts` already reuses for the identical "real effect in every process
 * except the one the test runner itself is" split, so this adds no new test-detection mechanism.
 */
let defaultGhCallPacer: GhCallPacer | undefined;

/**
 * TEST-ONLY (W1-T1005). Installs or clears the module-scoped {@link defaultGhCallPacer} so
 * test/status.test.ts's own suite can prove the DEFAULT is shared/overridable without depending
 * on load order across the file's other ~140 tests (many of which build an unpaced gateway and
 * would otherwise be the ones that lazily create — and thereby pin — the real default first).
 * No production code path calls this: a real daemon process never resets its own default, since
 * module scope is what makes the sharing real. Called from a test's own body, never from a
 * `beforeEach` here, so each of the four W1-T1005 tests below states its own setup explicitly.
 */
export function resetDefaultGhCallPacerForTest(pacer?: GhCallPacer): void {
  defaultGhCallPacer = pacer;
}

// ── W1-T2440 — THE PRE-WARM'S WALK, OFF THE REQUEST-SERVING THREAD ──────────────────────────
//
// `GitHub.warm?(): void` (this module) is a fire-and-forget hook: `lib/serve.ts`'s
// `prewarmBoardGithub` is `setInterval(() => github.warm?.(), DEFAULT_BOARD_PREWARM_MS)` and
// never awaits it, because it cannot — the signature returns `void`. Before this task, `warm()`
// called `index()`/`issueIndex()` DIRECTLY, and both walk the same `execFileSync("gh", …)` this
// module's own `GH_CALL_TIMEOUT_MS` doc already names as parking the whole process for the
// call's duration. A COLD walk is 18-22s (W1-T2323's own measurement); a request that arrives
// during it queued behind a refresh it never asked for.
//
// THE FIX NAMED IN THE TASK: an async fetch at the SAME cadence removes the dead wall clock
// without touching a single bound — `DEFAULT_BOARD_PREWARM_MS` and `GH_CALL_TIMEOUT_MS` are both
// untouched by this block. But `warm?(): void` staying `void` (task rationale: widening it to
// `Promise<void>` reaches every `GitHub` implementer and caller, which this task does not own)
// rules out the usual `async`/`await` rewrite — there is no promise for a caller to await, and
// the actual `gh` shelling is still a blocking child-process wait Node has no non-blocking
// primitive for (see lib/run-task.ts's `execFileAsync`/`ghJsonAsync`, which solves the SAME class
// of problem for its own two poll loops, but by making its caller `async`, which `warm()` cannot
// do without the signature change above).
//
// SO THE WALK MOVES TO A SEPARATE OS THREAD INSTEAD OF A DIFFERENT CALL SHAPE. A `worker_threads`
// `Worker` genuinely does not share this process's event loop — `execFileSync` blocking THAT
// thread never blocks this one — and it reuses `fetchBoardPrsRest`/`fetchLabelledIssuesRest`
// (this module's own imports) UNCHANGED: the worker branch below calls the exact same exported
// functions `restFetchHalf`/`fetchAllIssues` already call, with the exact same delta ("known")
// stop test, the exact same page sizes and the exact same `BOARD_MAX_PAGES` ceiling — there is no
// second walk mechanism to drift out of sync with the synchronous one below, only a second
// THREAD running the first one.
//
// THIS FILE, LOADED TWICE. `new Worker(new URL(import.meta.url), …)` re-imports this exact
// module in a fresh worker thread; `isMainThread`/`workerData` below gate the branch so it only
// ever runs there, never during this module's normal (main-thread) load. `execArgv:
// process.execArgv` carries this process's own loader flags (`tsx` under `npm test`, nothing
// extra once built) so the worker can load this same TypeScript source the main thread did.
//
// SCOPED TO THE REAL DEFAULT, NEVER TO AN INJECTED GATEWAY. A `Worker`'s `workerData` is
// structured-cloned — a JS closure cannot cross that boundary — so `opts.exec`/`opts.fetchAll`/
// `opts.fetchAllIssues` (every fixture in test/status.test.ts, including the three `warm()`
// fixtures that assert the injected fetch count moves the INSTANT `warm()` returns) cannot be
// threaded through a worker at all. `warm()` below keeps calling `index()`/`issueIndex()`
// synchronously, byte-for-byte as before this task, whenever any of those three are supplied —
// only the real, unconfigured production gateway takes the worker path this block adds.
const BOARD_PREWARM_WORKER_KIND = "remudero-board-prewarm-walk" as const;

/** What the main thread hands the worker — plain data only, per `workerData`'s structured-clone
 *  contract. `knownBoardPrs`/`knownIssues` are the SAME delta caches `restFetchHalf`/
 *  `fetchAllIssues` already carry between refreshes (`Map` clones structurally, so the worker's
 *  copy is a snapshot, never a live handle back into this process's memory). */
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

/**
 * THE WALK ITSELF — one channel set, run synchronously wherever it is CALLED FROM. Factored out
 * of the worker branch immediately below (rather than left inline there) so it has exactly ONE
 * body: the worker branch calls it inside the spawned thread; `runPrewarmWorker`'s own
 * spawn-failure fallback (see its doc) calls it DIRECTLY on the main thread when a `Worker`
 * cannot even be constructed, rather than reverting to the pre-worker `index()`/`issueIndex()`
 * pair. That second call site means the fallback also honours `req.ghBin` (the worker's own
 * knob, not the unrelated hardcoded `"gh"` `index()`'s default `exec` would have shelled), and —
 * load-bearing for THIS task's own diff-coverage gate — it gives every line in here a real,
 * main-thread execution a test can force without depending on cross-isolate coverage
 * instrumentation ever reaching into a spawned `Worker` at all.
 */
function runPrewarmChannelsSync(req: PrewarmWorkerRequest): PrewarmWorkerResponse {
  // Its OWN pacer, not the main thread's module-scoped `defaultGhCallPacer` — a `Worker` has its
  // own heap, so the two cannot share one gap-tracking object. This still paces the up-to-three
  // calls THIS walk makes against each other; it does NOT coordinate with the main thread's
  // sweep-driven pacer the way every same-thread caller does today. Priced, not hidden: a
  // narrower rate-limit exposure than before this task, worth a follow-up, never a reason to keep
  // the walk on the request-serving thread in the meantime.
  // `isTestRunner()`-gated exactly like the main thread's own `defaultGhCallPacer` (this file's
  // W1-T1005 doc) — `NODE_TEST_CONTEXT` is inherited from `process.env` at Worker construction
  // (or is simply already set when this runs directly on the main thread), so the same
  // real-vs-test split holds here: real callers still get the genuine 1.5s gap this pacer
  // enforces, and the test suite does not pay it 1.5s at a time per warm().
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
 * EXTRACTED FOR COVERAGE, AND THE EXEMPTION ROUTE IS CLOSED BY DESIGN. Node's
 * `--experimental-test-coverage` instruments the PARENT only, so a statement that runs solely
 * inside a spawned `Worker` records `DA:<line>,0` however many real workers the suite spawns —
 * measured, this line read 0 while its own `if` above read 703. `// diff-cov: process-boundary`
 * cannot cover it either: `scripts/diff-coverage.mjs` refuses that directive unless the guarded
 * declaration contains `spawnSync`/`execFileSync(process.execPath …)`/`process.exit`, in as many
 * words — "the directive may only exempt re-exec/exit glue" — and a `postMessage` is none of
 * those. So the line earns real coverage instead: the main thread can call this directly with a
 * stand-in port, which is exactly what `test/board-prewarm-does-not-block.test.ts` does.
 *
 * The guard below stays a ONE-LINE `if` on purpose: the statement line is then executed (and so
 * covered) on every main-thread load while its body still never runs there.
 */
export function postPrewarmWorkerResponse(
  port: { postMessage: (value: unknown) => void } | null,
  req: PrewarmWorkerRequest,
): void {
  port?.postMessage(runPrewarmChannelsSync(req));
}

// THE WORKER BRANCH ITSELF. Only reachable inside a worker thread this module's own
// `runPrewarmWorker` (below) spawned with `workerData.kind === BOARD_PREWARM_WORKER_KIND` — a
// worker spawned any other way (there are none in this codebase) or the normal main-thread load
// both leave this untouched.
if (!isMainThread && isPrewarmWorkerRequest(workerData)) postPrewarmWorkerResponse(parentPort, workerData);

export function buildBatchedGithub(
  owner: string,
  repo: string,
  opts: {
    ttlMs?: number;
    now?: () => number;
    fetchAll?: () => BatchedPr[];
    /**
     * INJECTABLE stand-in for the raw `gh pr list` invocation (W1-T181, mirrors {@link ghGateway}'s
     * own `opts.exec`) — real callers omit it and get the actual `execFileSync("gh", args, ...)`
     * call; unit tests inject a fake that returns a large seeded JSON string (proving the fetch
     * survives a payload over Node's 1 MiB default) or throws an ENOBUFS/rate-limit/auth/transport-
     * shaped error (proving the failure is classified and marked), all without shelling out AND
     * without bypassing the default's JSON-parse + byte-size-log wrapper the way overriding
     * `fetchAll` entirely would.
     */
    exec?: (args: string[]) => string;
    /** W1-T2387: injectable stand-in for {@link buildCommitTrailerIndex}'s real `git log` read —
     *  real callers omit it. Mirrors {@link ghGateway}'s own seam of the same name. */
    commitTrailerIndex?: () => Map<string, PrRef[]> | null;
    /**
     * Observability hook (W1-T181 design (ii)/(vi)) — called on every fetch attempt:
     * `"board_gateway.fetch_bytes"` (payload size right after a successful default `exec`),
     * `"board_gateway.fetch_ok"` / `"board_gateway.fetch_failed"` (from {@link index}, for EVERY
     * `fetchAll`, default or injected). Defaults to a no-op; real callers (`rmd serve`) wire this to
     * the ledger `log` closure so the NEXT approach to whatever ceiling exists is observable in
     * advance, and a failure is ledgered with its classified reason — never silent the way the
     * 2026-07-20 outage was for hours.
     */
    log?: (event: string, extra?: Record<string, unknown>) => void;
    /**
     * INJECTABLE stand-in for the batched `gh issue list --label needs-human` fetch (W1-T182)
     * {@link GitHub.issueByUrl} resolves against — mirrors `opts.fetchAll`'s role for PRs. Real
     * callers omit it and get the actual `gh issue list` call (via the same `run` exec closure
     * `opts.exec` already overrides); unit tests inject a fixture array or a throwing fake to
     * prove the escalation join is O(1) and fails closed on a read error, without shelling out.
     */
    fetchAllIssues?: () => BatchedIssue[];
    /**
     * PACES this gateway's two REST reads (the PR list `fetchAll` and the issue list
     * `fetchAllIssues`) against the daemon's OTHER burst call site, run-task.ts's
     * `buildOpenPrViews` (W1-T468) — see lib/open-prs-rest.ts's `GhCallPacer` doc for why one
     * shared instance, not independent per-call backoff, is what actually prevents the collision.
     * OPTIONAL: an explicit value here (`run-task.ts`'s `buildSweepHook`, or any test fixture)
     * always wins and is used exactly as given. OMITTED ⇒ W1-T1005's {@link defaultGhCallPacer},
     * a single instance shared by EVERY gateway built in this process without one of its own — not
     * a fresh pacer per construction (which would leave independently-polite gateways colliding at
     * second zero again, design (ii)) and not the old no-op (pre-W1-T1005, every construction but
     * `buildSweepHook`'s left both reads unpaced with no gap and no ledger row).
     */
    pacer?: GhCallPacer;
    /**
     * W1-T2323 OPTION C — THE MERGED HALF'S OWN CLOCK, separate from `ttlMs`, which now governs
     * the OPEN half alone.
     *
     * DEFAULTS TO `ttlMs`, DELIBERATELY, AND THE DEFAULT IS THE ARGUMENT. The shard's option C
     * offers "let the merged half live long and the open half stay short" as the way to cut full
     * walks. MEASURED, that is not where the walks come from: `knownBoardPrs` is per-instance, so
     * a TTL expiry on a WARM gateway is a DELTA walk (2 requests, 825 ms) while a FULL 26-request
     * walk comes from a COLD gateway — a fresh `buildBatchedGithub` that has no cache to expire in
     * the first place. Lengthening this number would therefore buy a handful of cheap deltas and
     * pay for them by making `findMergedByTrailer` answer from older evidence. THE WIN THIS TASK
     * SHIPS IS LAZINESS, NOT LENGTH: the merged half is no longer fetched by a consumer that only
     * wants open rows. The knob exists so the two clocks are genuinely separable — and so a future
     * caller that has measured a reason can lengthen it explicitly — not because a longer default
     * was found to be worth its staleness.
     */
    mergedTtlMs?: number;
    /**
     * W1-T2440: which binary the WORKER-based warm walk shells (see `runPrewarmWorker` below) —
     * mirrors `opts.exec`'s role for the synchronous path, but as a path rather than a function,
     * because a `Worker`'s `workerData` cannot carry a closure across the thread boundary. Real
     * callers omit it and get `"gh"`, exactly what the synchronous default already shells; a test
     * points this at a real (but fake) executable to prove the worker path without a real `gh`.
     */
    ghBin?: string;
    /**
     * W1-T2440 TEST-ONLY SEAM: overrides the URL `runPrewarmWorker` hands `new Worker(...)`.
     * Every REAL caller omits this and gets `new URL(import.meta.url)` — the worker ALWAYS
     * re-imports this exact module in production (see the module-scope doc above
     * `BOARD_PREWARM_WORKER_KIND`, "THIS FILE, LOADED TWICE"); there is no other script it could
     * ever run for a real gateway. Exists solely so a test can point a REAL
     * `worker_threads.Worker` at a tiny, deliberately-throwing script and observe the genuine
     * `worker.once("error", …)` handling below run against an ACTUAL crashed worker thread —
     * never a mocked stand-in for one — the same "prefer a real, fake seam over a mock" shape
     * `ghBin` (immediately above) already uses for the synchronous `gh` call itself.
     */
    workerUrl?: string | URL;
  } = {},
): GitHub {
  const ttlMs = opts.ttlMs ?? 15_000;
  // W1-T2323: A CACHE MUST SERVE FOR AT LEAST AS LONG AS IT COST TO BUILD.
  //
  // `cache.at` is already stamped on COMPLETION, not on request — `now()` inside the cache literal
  // below runs AFTER `fetchAll` returns — so a reading is never older than it claims. That half was
  // ALREADY CORRECT and nothing asserted it; this task PINS it
  // (test/board-index-ttl-outlives-its-fetch.test.ts) rather than rewriting it.
  //
  // WHAT THIS FLOOR ACTUALLY BUYS, MEASURED RATHER THAN ASSUMED. A cold gateway's first walk is
  // FULL: 26 sequential REST calls, 18.7-19.5 s measured on the live board. Once `knownBoardPrs` is
  // populated, a later expiry is a DELTA walk — MEASURED at 825 ms across the raw 15 s boundary, not
  // another 19 s. So the raw TTL was costing sub-second delta refetches, and this floor removes
  // those: a read 15.5 s after a 19 s walk now costs 0 ms instead of 825 ms.
  //
  // WHAT IT DOES NOT BUY, SAID PLAINLY. The expensive walks are the FULL ones, and they come from
  // COLD GATEWAY INSTANCES, not from TTL expiry: `knownBoardPrs` is per-instance (declared below),
  // so every `buildBatchedGithub` call pays one ~19 s walk on its first read however long the TTL
  // is. 65 of today's 170 walks were full. THIS CHANGE DOES NOT REDUCE THAT COUNT, and the boot
  // burst of three full walks in 100 s on 2026-08-26 was three cold instances, not three expiries.
  // Reducing instance count, or separating the open and merged clocks so a cold walk is one page
  // rather than 26, is the larger win and is NOT taken here.
  //
  // THE STALENESS IT ACCEPTS, NAMED. A cached board reading may be up to
  // `max(ttlMs, lastFetchDurationMs)` old instead of `ttlMs` — 19 s rather than 15 s on today's
  // numbers, a FOUR-SECOND increase in the worst-case age of the rollup a sweep disposition reads.
  // It is not a blanket raise: it is self-sizing from a cost the gateway already paid, and can
  // never exceed one fetch.
  //
  // `ttlMs === 0` IS EXEMPT FROM THE FLOOR. A zero TTL is not "a fast cache" — it is the
  // established test-suite idiom for "never cache, refetch every call" (see
  // test/board-prs-rest.test.ts, test/read-failed-not-attempted.test.ts,
  // test/serve-board-pacer-wiring.test.ts), used to isolate a single method's behaviour from the
  // gateway's memoisation. Flooring it would silently turn "always stale" into "stale after one
  // fetch duration", breaking that idiom for no production benefit — nothing in this process ever
  // constructs a gateway with `ttlMs: 0` outside a test.
  // W1-T2323 OPTION C COMPOSES WITH THE FLOOR: ONE FLOOR PER HALF, NOT ONE PER GATEWAY.
  //
  // #2998 shipped a single `lastFetchDurationMs` because there was a single clock. There are now
  // two, and they cost two wildly different amounts: MEASURED on the live board, the open pass is
  // 376 ms and the cold merged walk is 18,753 ms. A SHARED floor would let the merged walk's
  // duration govern the open clock, holding rows that cost under half a second for nineteen
  // seconds.
  //
  // MEASURED, A SHARED FLOOR BEHAVES IDENTICALLY TODAY, and that is exactly why it is not used:
  // `index()` refreshes the open half BEFORE the merged half, so the open stamp has already aged
  // by at least the merged walk's duration by the time anything reads it, and the shared floor is
  // never the binding constraint. That is a coincidence of the current call order, written down
  // nowhere and true only until the order changes or a half is refreshed on its own. The per-half
  // form is correct by construction rather than by accident, for the same cost.
  //
  // `ttlMs === 0` STAYS EXEMPT, ON BOTH HALVES (#2998's own carve-out, and the split makes it
  // load-bearing in more places). A zero TTL is the suite's never-cache idiom, and
  // test/board-prs-rest.test.ts, test/read-failed-not-attempted.test.ts and
  // test/serve-board-pacer-wiring.test.ts all use it AND all take the split path, since they
  // inject `opts.exec` rather than `opts.fetchAll`. Flooring a zero would turn "always stale"
  // into "stale after one fetch duration" for every one of them.
  const mergedTtlMs = opts.mergedTtlMs ?? ttlMs;
  let openFetchDurationMs = 0;
  let mergedFetchDurationMs = 0;
  const effectiveOpenTtlMs = (): number => (ttlMs === 0 ? 0 : Math.max(ttlMs, openFetchDurationMs));
  const effectiveMergedTtlMs = (): number => (mergedTtlMs === 0 ? 0 : Math.max(mergedTtlMs, mergedFetchDurationMs));
  // W1-T1005: an explicit `opts.pacer` always wins (design iii); omitted, every gateway built in
  // this process falls back to the SAME module-scoped instance (created once, on whichever
  // gateway needs it first) rather than each discovering the secondary rate limit on its own.
  const pacer = opts.pacer ?? (defaultGhCallPacer ??= createGhCallPacer(isTestRunner() ? { sleepSync: () => {} } : {}));
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  // W1-T119: reflects only the MOST RECENT fetch attempt (reset on every call, unlike
  // ghGateway's sticky-for-instance-lifetime flag) — this gateway's single batched fetch
  // refreshes on its own `ttlMs` cadence, so a stale failure from an earlier TTL window
  // must not keep shadowing a later fetch that actually succeeded.
  /**
   * W1-T2323: PER HALF, because the halves now attempt independently and a single pair of flags
   * would let the second attempt ERASE the first one's verdict — an open-half outage masked by a
   * merged-half success is precisely the "GitHub says zero PRs" reading W1-T181 exists to
   * prevent, arriving by a new route. Each half still resets its OWN verdict on its OWN next
   * attempt, which is W1-T119's rule applied per channel rather than abandoned.
   *
   * `readFailed()` reports their OR, so the gateway is failed while EITHER half's most recent
   * attempt failed. That is strictly no weaker than the single flag it replaces: on the combined
   * path both entries are written from the one attempt and the reading is identical.
   */
  interface FetchOutcome {
    failed: boolean;
    reason: GhFailureReason | undefined;
  }
  let openOutcome: FetchOutcome | undefined;
  let mergedOutcome: FetchOutcome | undefined;
  let fetchInFlight = false;
  // W1-T2440: true from the moment `runPrewarmWorker` spawns a worker for this channel until its
  // result (success or failure) is applied — `openRows`/`mergedRows`/`issueIndex` check these
  // FIRST so a request arriving mid-warm is served the existing cache instead of racing the
  // worker with a second, synchronous fetch on this thread.
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
  // W1-T2219: backs `readState()` — `"not_attempted"` until `index()` first runs, `"in_flight"`
  // for the duration of one attempt (observable from a REENTRANT call inside an injected
  // `fetchAll`; the real, synchronous default `run` blocks the whole process, same as
  // everywhere else in this file that notes it), then `"ok"`/`"failed"` mirroring
  // `lastFetchFailed` — but, unlike that flag, never forced into being true by an accessor:
  // only `index()` itself (called by an actual query method, or `warm()`) advances this.
  const fetchState = (): GhReadState => {
    if (fetchInFlight) return "in_flight";
    if (!openOutcome && !mergedOutcome) return "not_attempted";
    return lastFetchFailed() ? "failed" : "ok";
  };
  // W1-T415: set from `fetched.truncated` on every fetch this default `fetchAll` performs — an
  // INJECTED `opts.fetchAll` (every unit-test fixture predating this) bypasses `fetchBoardPrsRest`
  // entirely and so never touches this, leaving it at its initial `false`, the same omitted-⇒-
  // false discipline `readTruncated()`'s optionality already documents.
  // W1-T2323: retained PER HALF, because the halves now refresh on independent clocks and a
  // later untruncated OPEN refresh must not clear a truncation the CLOSED walk is still carrying
  // (nor the reverse). `readTruncated()` reports their OR — a partial view is a partial view
  // whichever half was cut short, which is the reading lib/trace.ts's `undecidable` guard wants.
  let lastOpenTruncated = false;
  let lastClosedTruncated = false;
  const lastFetchTruncated = (): boolean => lastOpenTruncated || lastClosedTruncated;
  const run =
    opts.exec ??
    // 3rd fd is `pipe` (W1-T119), not `ignore` — same stderr-capture fix as ghGateway, so this
    // gateway's `readFailureReason()` is real too, not always "unknown". maxBuffer is 64 MiB
    // (W1-T181) — Node's 1 MiB default threw ENOBUFS once this repo's PR JSON (all states, up to
    // 1000 PRs, `body` included) crossed it; classifyGhFailure's "buffer_overflow" branch is how
    // that specific failure is now classified instead of "unknown".
    // `timeout` (GH_CALL_TIMEOUT_MS) bounds the call the 2026-08-13 hour-long sweep was parked
    // on — `changedFiles` below shells this same closure with `--paginate`.
    // W1-T2440: `opts.ghBin ?? "gh"`, not a bare `"gh"` literal — this closure is EVERY
    // synchronous `gh` call this gateway makes OUTSIDE the warm worker (a cache-miss read that
    // lands while no background warm owns that channel, and `runPrewarmChannelsSync`'s own
    // spawn-failure fallback, which calls back INTO this same gateway's `index()`/`issueIndex()`
    // — see that fallback's own doc). A test that sets `ghBin` to prove the worker path never
    // shells a real `gh` must get the SAME fake binary here too, or a read that lands between
    // warms (e.g. a cross-half invalidation forcing a synchronous refetch) silently reaches for
    // the real `gh` instead. Real callers omit `ghBin` and get exactly `"gh"`, unchanged.
    ((args: string[]) =>
      execFileSync(opts.ghBin ?? "gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26, timeout: GH_CALL_TIMEOUT_MS }));
  // W1-T265: the cross-refresh row cache the REST delta stops against. Held HERE, at gateway
  // scope, not inside `index()` — `index()` deliberately replaces its own cache with an EMPTY
  // one on a failed fetch (the W1-T181 pairing below), and reusing that as the delta base would
  // turn one transient failure into a permanent cold re-walk. Untouched on a throw, so a recovery
  // costs 2 requests rather than 8.
  // W1-T2323: IN SPLIT MODE THIS HOLDS CLOSED ROWS ONLY. The open pass is a COMPLETE read of a
  // small set and is given NO `known` (see `restFetchHalf`), so nothing but the closed pass ever
  // writes here and the delta stop test below is comparing like with like. Seeding the open pass
  // from a shared map would be a correctness bug, not an optimisation: the closed pass used to be
  // what overwrote a just-merged row's `OPEN` state inside the same call, and it no longer is.
  let knownBoardPrs: Map<number, BoardPrRest> | undefined;
  // W1-T2222: the issue-fetch's OWN cross-refresh row cache, same reasoning and same "untouched
  // on a throw" discipline as `knownBoardPrs` above — an independent map because the PR delta and
  // the issue delta are independent reads with independent row shapes and independent failure
  // modes (see `lastIssueFetchFailed` below).
  let knownIssues: Map<number, BoardIssueRest> | undefined;
  /** W1-T413: per-URL changed-file memo for {@link GitHub.changedFiles}. `null` records a read
   *  that FAILED, so one unreachable PR is read once per gateway rather than once per task. */
  const changedFilesByUrl = new Map<string, string[] | null>();
  /**
   * W1-T914: per-URL memo for {@link GitHub.reviewState}, TTL-matched to `index()`'s own
   * `ttlMs` for an OPEN row — an open PR's `remudero-review` context is exactly the value this
   * feature exists to keep LIVE (pending -> success/failure while the row stays open), so caching
   * IT past `ttlMs` would silently freeze "review in progress" on the console long after GitHub
   * reported the real outcome.
   *
   * W1-T2217 tried memoising a terminal row's result here forever instead of re-fetching it past
   * `ttlMs`. W1-T2235 found that memo UNREACHABLE for exactly the rows it targeted: the guard
   * only consulted `entry.state` as a modifier on a cache HIT, so a terminal row with no entry yet
   * fell straight through to a network call keyed on `entry.headRefName` — a branch name, deleted
   * the moment its PR merges — which 404s, and the `catch` below caches nothing, so the same row
   * re-fails on every single paint forever.
   *
   * W1-T2235's fix: a MERGED/CLOSED row never reaches this cache at all. `entry.state` is
   * checked FIRST, ahead of any cache lookup or network call, in `reviewState` below, and a
   * terminal row returns `"not-applicable"` straight from that check — a terminal PR's combined
   * status is history, not a value `remudero-review` (which watches pending -> success on an OPEN
   * PR) has any opinion about. Only an OPEN row's result is ever stored here, and it still expires
   * every `ttlMs`, exactly as W1-T2217 left it for that case.
   */
  const reviewStateCache = new Map<string, { at: number; state: "success" | "failure" | "pending" | "none" }>();
  /**
   * ONE HALF OF THE BOARD, OVER REST — W1-T2323 option C's whole mechanism.
   *
   * The body below is byte-for-byte what the single combined fetch always did, parameterised by
   * WHICH half it walks — but this gateway only ever calls it with `"open"` or `"closed"` (see
   * `openRows`/`mergedRows` below). A gateway built with an injected `opts.fetchAll` never reaches
   * this function at all: `bothHalves` below calls `opts.fetchAll` directly, so `"both"` stays a
   * valid {@link BoardFetchHalf} for `fetchBoardPrsRest`'s own default but is not something this
   * wrapper is ever asked to walk.
   *
   * MEASURED 2026-08-26 on this repo: `"open"` is 1 request, 6 rows, 432 ms. `"closed"` cold is
   * 25 requests, 2,400 rows, 21,813 ms. Welded together, `listOpenHeadBranches` — the daemon's
   * only board consumer on the dispatch path — paid 26 requests for the 1 it reads.
   */
  const restFetchHalf = (half: BoardFetchHalf): BatchedPr[] => {
      // W1-T265: REST, NOT `gh pr list --state all --json …`. That flag is implemented over
      // GraphQL, and MEASURED on 2026-07-31 it cost 12 GraphQL points and 2,888,862 bytes per
      // call for this repo's 687 PRs. At the 15 s TTL below, one open console tab drove 240
      // calls/hour = 2,880 of the account's 5,000 GraphQL points — ~58% of the whole budget —
      // and when it ran out this fetch threw, merged-ness became underivable, and long-merged
      // tasks stayed pinned at the head of UP NEXT until the hourly reset. See
      // state/recon-BV-console-visibility.md Q5/Q6, and lib/open-prs-rest.ts for the delta.
      //
      // `autoMergeRequest` (W1-T155), `title` (W1-T184) and `headRefOid` (W1-T2727) still ride
      // along on the SAME fetch — `mapBoardPr` carries all three — so the O(1)-per-projection
      // invariant this gateway exists for is unchanged; only the transport and re-read volume moved.
      let bytes = 0;
      const fetchJson = (args: string[]): unknown => {
        const raw = run(args);
        bytes += Buffer.byteLength(raw, "utf8");
        return JSON.parse(raw);
      };
      // W1-T2323: THE OPEN HALF IS GIVEN NO `known` AND WRITES NONE. It re-reads `state=open`
      // completely on every call — 1 page for this repo's 6 open PRs — so the rows it returns ARE
      // the open set, and a PR that merged since the last call is simply absent from GitHub's
      // answer rather than resurrected from a cache. Seeding it would be the bug: the closed pass
      // is what used to overwrite a just-merged row's `OPEN` state inside the same call, and on
      // this path there is no closed pass to do it.
      const known = half === "open" ? undefined : knownBoardPrs;
      const fetched = fetchBoardPrsRest(owner, repo, fetchJson, known, half);
      if (half !== "open") knownBoardPrs = new Map(fetched.rows.map((r) => [r.number, r]));
      // W1-T415: ledgered below on EVERY successful fetch already; now also RETAINED here so
      // `readTruncated()` can surface it — a truncated view is a SUCCESS (rows) that still hit
      // `BOARD_MAX_PAGES` on the open or closed half, distinct from `lastFetchFailed`, which the
      // catch below sets only on a THROW. Reassigned every successful fetch, exactly like
      // `lastFetchFailed` above, so a later untruncated refresh clears an earlier truncated one.
      // W1-T2323: recorded against the half that produced it, so `readTruncated()`'s OR keeps a
      // live truncation from either walk instead of the last one to finish winning outright.
      // ONLY "open"/"closed" EVER REACH HERE — `bothHalves()` below calls the injected
      // `opts.fetchAll` directly, never this function, so a THIRD `half === "both"` arm would be
      // dead code no fixture could ever exercise; coverage-ratchet caught exactly that when it
      // still existed (W1-T2323 follow-up).
      if (half === "open") lastOpenTruncated = fetched.truncated;
      else lastClosedTruncated = fetched.truncated;
      // W1-T181 design (vi): log the payload size on every SUCCESSFUL fetch, so the next
      // approach to whatever ceiling is set above is observable in advance instead of arriving
      // as a silent outage the way tonight's did. `restCalls`/`mode` are W1-T265 additions — the
      // whole claim of this change is that `restCalls` sits at 2, so it is measured in the
      // ledger rather than asserted.
      log("board_gateway.fetch_bytes", {
        bytes,
        restCalls: fetched.calls,
        mode: fetched.mode,
        truncated: fetched.truncated,
        // W1-T2323: WHICH HALF, in the ledger, so "did the split actually stop the daemon paying
        // for the closed walk" is a measurement over `board_gateway.fetch_bytes` rows rather than
        // a claim. Before this task every row was implicitly `"both"`.
        half: fetched.half,
      });
      return fetched.rows;
  };
  /**
   * W1-T2323: TRUE ONLY WHEN THIS GATEWAY OWNS ITS OWN FETCHES. An injected `opts.fetchAll`
   * returns the WHOLE board in one call and every fixture in this repo counts on it being called
   * exactly once per refresh, so a gateway built with one keeps the single combined clock it has
   * always had — calling an injected fetch twice to fill two halves would change what those
   * fixtures measure without changing anything in production. `opts.exec` gateways (and real
   * ones) go down the split path and are where the halves are exercised.
   */
  const splitHalves = opts.fetchAll === undefined;

  // W1-T182: an INDEPENDENT batched fetch/cache pair for escalation issues, deliberately not
  // folded into the PR fetch/cache above — a PR-fetch outage and an issue-fetch outage are
  // different failures with different classified reasons, and {@link resolveEscalation}'s
  // fail-closed join needs its OWN `issueReadFailed()` signal rather than inheriting the PR
  // fetch's. Scoped to `--label needs-human` (escalate.ts's `NEEDS_HUMAN_LABEL`), which bounds
  // WHICH issues this reads but not how many: MEASURED 2026-08-24, the label-scoped set itself is
  // 523-524 rows (~3.04 MB) — see W1-T2222 and {@link fetchLabelledIssuesRest}'s own doc
  // (open-prs-rest.ts) for why the set's size no longer sets the re-read cost below.
  let lastIssueFetchFailed = false;
  let lastIssueFetchFailureReason: GhFailureReason | undefined;
  const fetchAllIssues =
    opts.fetchAllIssues ??
    (() => {
      // W1-T2222: REST, page-walked under this module's own control — never `--paginate`, which
      // issues every page inside one exec call and so cannot be interrupted mid-walk — and
      // re-reading only what changed since the last successful call. `knownIssues` carries the
      // COLD PR half's proven stop test over to this fetch rather than a second mechanism; see
      // fetchLabelledIssuesRest's own doc for the soundness argument (sorted `updated_at`
      // descending, first match means everything below it is unchanged).
      let bytes = 0;
      const fetchJson = (args: string[]): unknown => {
        const raw = run(args);
        bytes += Buffer.byteLength(raw, "utf8");
        return JSON.parse(raw);
      };
      const fetched = fetchLabelledIssuesRest(owner, repo, NEEDS_HUMAN_LABEL, fetchJson, knownIssues);
      // Reassigned only on a SUCCESSFUL return, exactly like `knownBoardPrs` above — a throw from
      // `fetchLabelledIssuesRest` skips this line, so a transient failure leaves the previous
      // complete snapshot intact and the NEXT successful call is still a cheap delta.
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
    // W1-T2440: same reasoning as `openRows`/`mergedRows`'s own guards — a background worker
    // already owns this refresh. `issueCache ?? { at: 0, byUrl: new Map(), byNum: new Map() }`
    // mirrors this function's own pre-first-fetch answer (empty maps), never a new "no issues"
    // fabrication: a caller reading through `issueByUrl` gets exactly today's cold-cache answer.
    if (issuesWarmInFlight) return issueCache ?? { at: 0, byUrl: new Map(), byNum: new Map() };
    if (!issueCache || now() - issueCache.at >= ttlMs) {
      let all: BatchedIssue[];
      try {
        // W1-T468/W1-T1005: waits its turn on the shared pacer (an explicit `opts.pacer`, or
        // else the module-scoped default resolved above) BEFORE the real call, and reports back
        // whether it was rate-limited — see the `pacer` opt's doc above.
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
        // A bare [] here is the SAME W1-T181 hazard as the PR fetch's — paired with
        // `lastIssueFetchFailed` so `issueReadFailed()` tells resolveEscalation this is a
        // genuine outage, never a confirmed "no such issues".
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
  // Flexible ref resolution — accepts a full issue URL OR a bare number, mirroring the PR
  // `lookup()` below (and `prByRef`/`ghGateway.issueByUrl`, which already delegate to `gh`'s own
  // ref parsing and so already accept either shape). escalate.ts's ledger line always writes a
  // full URL, but a caller resolving by number should not silently miss.
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
  /** The two half-stamps `cache` was last composed from — a union rebuild is needed only when
   *  one of them moves, so a warm `index()` still costs no map construction at all. */
  let composedFrom: { open: number; merged: number } | undefined;
  /**
   * THE MEMO KEY, AND WHY IT IS NOT A TIMESTAMP.
   *
   * This memo was keyed on `openHalf.at` / `mergedHalf.at` — millisecond `Date.now()` readings.
   * Two refreshes completing inside ONE millisecond made `composedFrom` match and `index()` hand
   * back the PREVIOUS union. The reachable case is not theoretical: a failed fetch replaces both
   * halves with empty ones (the W1-T181 pairing), and the very next SUCCESSFUL refresh lands in
   * the same millisecond often enough that the gateway serves the EMPTY union while reporting
   * `readFailed() === false` and `readState() === "ok"` — a silent stale read wearing a healthy
   * label. MEASURED at 8-14 failures per 60 attempts on the real clock.
   *
   * A monotonic counter per half cannot collide. It is bumped on every completed refresh of that
   * half, successful or not, which is exactly the event the union needs to notice.
   */
  let openEpoch = 0;
  let mergedEpoch = 0;

  /**
   * ONE FETCH ATTEMPT, WITH ALL OF W1-T119/W1-T181/W1-T468/W1-T2219's HANDLING AROUND IT.
   *
   * Lifted VERBATIM out of the old `index()` so both halves share exactly one classification,
   * marking, pacing and logging path — a second copy is how a fail-closed contract rots. The
   * flags it sets (`lastFetchFailed`/`lastFetchFailureReason`/`fetchState`) keep their existing
   * meaning of "the most recent attempt", which is now the most recent attempt BY EITHER HALF.
   * That is deliberately the conservative reading: every `null`-on-failure method below still
   * returns `null` while either half's last attempt failed, so nothing this task does can make a
   * caller trust a read it would have distrusted before.
   */
  const attemptFetch = (fetch: () => BatchedPr[], channel: "open" | "merged" | "both"): BatchedPr[] => {
      // #2998's start stamp, moved INTO the one shared attempt — there is no longer a single
      // `index()` guard to hang it off, and both halves must earn their own floor.
      const fetchStartedAt = now();
      const record = (outcome: FetchOutcome): void => {
        if (channel !== "merged") openOutcome = outcome;
        if (channel !== "open") mergedOutcome = outcome;
      };
      // W1-T181: the catch lives HERE, wrapping `fetchAll()` itself — not only inside the
      // default `run`-based implementation above — so an INJECTED `fetchAll` (every unit-test
      // fixture, and any future caller-supplied implementation) that throws is classified and
      // marked exactly like a real `gh` failure, instead of propagating uncaught out of every
      // GitHub method this gateway returns. Before this fix, a throwing `fetchAll` crashed the
      // caller; only the default execFileSync path degraded softly.
      let all: BatchedPr[];
      // W1-T2219: flips BEFORE the attempt so a REENTRANT `readState()` call from inside an
      // injected `fetchAll` observes "in_flight" rather than whatever the PREVIOUS attempt
      // left behind — the exact discard rationale (2)(b)/(3) names ("the flags still hold the
      // previous attempt's verdict" for as long as a call is in flight).
      fetchInFlight = true;
      try {
        // W1-T468: same shared-pacer guard as `fetchAllIssues` above — one pacer instance across
        // BOTH of this gateway's reads (and run-task.ts's sweep enumeration) is what actually
        // keeps three independently-polite callers from colliding at second zero.
        all = paceGhEntry(pacer, isGhRateLimitError, fetch);
        record({ failed: false, reason: undefined });
        log("board_gateway.fetch_ok", { prCount: all.length, channel });
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
        record({ failed: true, reason: classifyGhFailure(e?.status, e?.stderr != null ? String(e.stderr) : undefined, e?.code) });
        // LOUD (W1-T181 design (ii)/(v)): the pre-fix catch was silent for hours — `lastFetchFailed
        // = true; return []` — with zero serve.log error lines, because ENOBUFS classified
        // "unknown" and nothing ever surfaced it. console.error guarantees this reaches
        // stdout/stderr (and therefore whatever log `rmd serve`'s process is redirected into) even
        // if a caller never wires `opts.log`; the injectable `log` ALSO fires so a caller with a
        // ledger can key an alert off the classified reason without scraping console output.
        console.error(`board gateway: batched PR fetch failed (${lastFetchFailureReason()}): ${e?.message ?? String(err)}`);
        log("board_gateway.fetch_failed", { reason: lastFetchFailureReason(), message: e?.message ?? String(err), channel });
        // W1-T181 design (v): a bare [] here is what converted "I could not read GitHub" into
        // "GitHub says there are zero PRs" — every task then silently derived not-merged from an
        // outage that had nothing to do with the repo's actual PRs. The [] below is now always
        // PAIRED with `lastFetchFailed`/`lastFetchFailureReason`, which `readFailed()`/
        // `readFailureReason()` (below) surface to derivePrPrecedence (~line 596): a caller that
        // consults those BEFORE trusting an empty result sees a MARKED failure, never a bare
        // absence — the signal W1-T179's github_unobservable marking is designed to consume.
        all = [];
      } finally {
        fetchInFlight = false;
        // #2998, PER CHANNEL. Recorded on BOTH arms — a failed fetch blocked the loop just as
        // long as a successful one, so it earns the same floor. `at` stays `now()`:
        // completion-stamped, unchanged. On the COMBINED path (`channel === "both"`, an injected
        // `opts.fetchAll`) both halves take the same value, because it really was one refresh.
        const elapsedMs = Math.max(0, now() - fetchStartedAt);
        if (channel !== "merged") openFetchDurationMs = elapsedMs;
        if (channel !== "open") mergedFetchDurationMs = elapsedMs;
      }
      return all;
  };

  /**
   * THE OPEN HALF, ON `ttlMs` — W1-T2323.
   *
   * The rows come straight from GitHub's `state=open` query, so this is a COMPLETE answer, never
   * a cache union: a PR that merged since the last call is absent from it because GitHub does not
   * return it, not because anything here reasoned about the transition. `listOpenHeadBranches`
   * therefore reads open rows that are at least as fresh as the ones the combined fetch produced,
   * for 1 request instead of 26.
   *
   * ON A FAILED FETCH THE HALF IS REPLACED WITH AN EMPTY ONE AND STAMPED, exactly as the combined
   * `cache` always was (the W1-T181 pairing) — the empty result is never handed out unpaired, it
   * is always read alongside `lastFetchFailed` by the methods below.
   */
  const openRows = (): BatchedPr[] => {
    if (!splitHalves) return bothHalves().open;
    // W1-T2440: a background worker already owns this channel's refresh — serving the (possibly
    // stale, possibly absent) cache beats a SECOND, synchronous `execFileSync` walk racing it on
    // THIS thread, which is exactly the block this task removes, reintroduced one layer up. A
    // caller that needs to tell "no PRs" from "not fetched yet" already has `readState()` (W1-
    // T2219), which reports `"in_flight"` for the whole time this guard is taken (`fetchInFlight`
    // is set before the worker spawns, in `runPrewarmWorker`, below).
    if (openWarmInFlight) return openHalf?.rows ?? [];
    if (!openHalf || now() - openHalf.at >= effectiveOpenTtlMs()) {
      const previouslyOpen = openHalf ? new Set(openHalf.rows.map((p) => p.number)) : undefined;
      const fetched = attemptFetch(() => restFetchHalf("open"), "open");
      // STORED VERBATIM — these rows ARE GitHub's answer to `state=open`, and re-deciding their
      // state here would be a second, weaker opinion about a question the query already settled.
      // The `state === "OPEN"` filter still exists, in exactly the two places it always did: the
      // union's `openNewestFirst` and `listOpenHeadBranches` below, so both answers are computed
      // from the same predicate over the same rows as before this task.
      openHalf = { at: now(), rows: fetched };
      openEpoch += 1;
      // W1-T2323: WHAT SEPARATE CLOCKS COST, AND THE ONE LINE THAT PAYS MOST OF IT BACK.
      //
      // The cost is real and worth stating plainly: the merged half can now be older than the
      // open half, so `findMergedByTrailer` and its two siblings can answer "not merged" about a
      // PR that has in fact merged, for up to `mergedTtlMs`. THE CONSUMER THAT ACTS ON THAT IS
      // `buildCreditCandidates` (run-task.ts), whose merge credit decides a task's disposition —
      // not a display. So it is not left to a clock.
      //
      // A PR IN THIS REPO ALWAYS MERGES OUT OF THE OPEN SET. The moment a successful open pass
      // returns without a number the previous one had, that PR left `state=open` — which is the
      // merge (or close) itself, observed, from data already in hand. Expiring the merged clock
      // here means the next merged-row read walks and sees it, so the miss window for the case
      // that actually happens is ZERO rather than `mergedTtlMs`.
      //
      // GUARDED ON A SUCCESSFUL FETCH. A failed open pass yields `[]`, and treating that as "every
      // open PR just merged" would be the W1-T181 hazard wearing a new hat — an outage read as an
      // event. `lastFetchFailed` is checked, so a failure invalidates nothing.
      //
      // WHAT IT DOES NOT COVER, said rather than glossed: a PR that opens AND merges entirely
      // between two open passes is never seen open, so no drop is observed and it waits out
      // `mergedTtlMs` — which defaults to `ttlMs`, so that residue is the same 15 s the combined
      // fetch always had.
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
   * THE MERGED/CLOSED HALF, ON `mergedTtlMs` — W1-T2323.
   *
   * STILL BUILT AND STILL SHARED. `findMergedByTrailer`, `findMergedByTrailerAll` and
   * `findMergedByHeadBranch` all read merged rows off this one index, which is W1-T377's design
   * and is sound; nothing here removes or truncates it, and its walk still stops on `reachedKnown`
   * with `BOARD_MAX_PAGES` and `BOARD_FULL_PAGE_SIZE` exactly as they were. The change is WHEN it
   * is fetched: lazily, by a consumer that actually needs a merged row, instead of by every
   * consumer of any row at all.
   */
  const mergedRows = (): BatchedPr[] => {
    if (!splitHalves) return bothHalves().merged;
    // W1-T2440: same reasoning as `openRows`'s own guard, immediately above it — this channel's
    // background worker owns the refresh, so a query never starts a second one underneath it.
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
   * THE COMBINED PATH, for a gateway built with an injected `opts.fetchAll` — ONE call, ONE
   * clock, filling both halves with the same stamp. This is today's `index()` unchanged, and it
   * is what every existing unit fixture continues to run, so "the split" is a production and
   * `opts.exec` behaviour rather than a rewrite of what the suite measures.
   */
  const bothHalves = (): { open: BatchedPr[]; merged: BatchedPr[] } => {
    if (!openHalf || !mergedHalf || now() - openHalf.at >= effectiveOpenTtlMs()) {
      // `bothHalves` is only ever reached through the two `!splitHalves` guards above, and
      // `splitHalves` is `opts.fetchAll === undefined` — so `opts.fetchAll` is always set on
      // every path that lands here. The assertion states that invariant instead of carrying a
      // `?? restFetchHalf("both")` fallback that could never actually run (the dead branch
      // coverage-ratchet flagged before this fix).
      const all = attemptFetch(opts.fetchAll as () => BatchedPr[], "both");
      const at = now();
      openHalf = { at, rows: all.filter((p) => p.state === "OPEN") };
      mergedHalf = { at, rows: all.filter((p) => p.state !== "OPEN") };
      openEpoch += 1;
      mergedEpoch += 1;
    }
    return { open: openHalf.rows, merged: mergedHalf.rows };
  };

  /**
   * THE UNION, for every consumer that needs a row of any state — `prByRef`, `headRefName`,
   * `prBody`, `autoMergeArmed`, `reviewState`, `warm`, `readTruncated`. Forces BOTH halves, so
   * none of them changes what it costs or what it sees. Only `listOpenHeadBranches` is routed
   * away from here, because it is the one method whose answer is a function of the open half
   * alone — and it is the one the daemon's dispatch path reads.
   */
  const index = (): Index => {
    // W1-T2323: ON THE COMBINED PATH THIS MUST BE ONE CALL, NOT TWO. Asking `openRows()` and then
    // `mergedRows()` would enter `bothHalves()` twice, and at `ttlMs: 0` — which several fixtures
    // use deliberately to isolate pacer behaviour from cache freshness — the second entry sees an
    // already-stale stamp and fetches AGAIN. That doubles the injected fetch count, the pacer's
    // refusal-retry budget and the ledger rows, none of which this task is entitled to change.
    const both = splitHalves ? undefined : bothHalves();
    const open = both ? both.open : openRows();
    const merged = both ? both.merged : mergedRows();
    // KEYED ON THE REFRESH COUNTERS, NEVER ON THE STAMPS — see `openEpoch`'s doc above for the
    // same-millisecond collision that made this memo serve an empty union with a healthy label.
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
   * R-24 — THE PER-TICK VERDICT RESET. See {@link GitHub.resetFailureFlags} for the contract and
   * why this exists at all; what follows is only what the three assignments below actually do.
   *
   * PER HALF, mirroring `openOutcome`/`mergedOutcome`'s own split (W1-T2323): a half whose last
   * attempt SUCCEEDED keeps both its verdict and its rows, so a reset never costs a re-fetch it
   * did not have to pay. A half whose last attempt FAILED loses both together — the verdict AND
   * the stamped EMPTY half that verdict is the only safe pairing for. Dropping one without the
   * other is the W1-T181 hazard in reverse: `readFailed() === false` over rows that are empty
   * because `gh` fell over, which is the "GitHub says zero PRs" reading that file's whole design
   * refuses to produce.
   *
   * `cache`/`composedFrom` need no clearing: a re-fetched half bumps its epoch, and `index()`
   * keys its memo on the epochs precisely so a rebuild cannot be missed.
   *
   * `knownBoardPrs`/`knownIssues` — the delta caches — are DELIBERATELY UNTOUCHED. They are the
   * reason a caller holds one gateway across ticks, they are already untouched on a throw, and
   * clearing them here would convert the recovery from a 2-request delta into the cold walk this
   * whole change exists to stop paying.
   *
   * THE ONE INTERACTION WITH `warm()`, STATED RATHER THAN LEFT TO BE FOUND. Dropping a half while
   * a background walk owns that channel leaves `openRows`/`mergedRows`'s `warmInFlight` guard
   * answering `[]` until the worker's message lands — which is exactly the cold-gateway-mid-warm
   * state those guards already document as legitimate, and `readState()` still reports
   * `"in_flight"` for the whole of it. It self-heals either way: `applyOpenOutcome`/
   * `applyMergedOutcome` write the half and the verdict unconditionally when the walk returns.
   * No caller reaches both today — `warm()` has exactly one caller (`lib/serve.ts`) and the
   * per-tick reset has two (`daemonCommand`/`drainCommand`), and they are different gateways.
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
  // W1-T2387 — the COMMIT surface, memoized and lazy; mirrors {@link ghGateway}'s own fallback
  // exactly (same doc, same precedence). Built at most ONCE per gateway instance and only after a
  // task has actually missed on the body index, so a board whose PRs all carry the body trailer
  // never shells `git`. Deliberately NOT TTL'd alongside the body halves: commits are append-only,
  // so a stale index can only LACK a very recent merge, which is the case the body index answers.
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
  //
  // These three mirror `attemptFetch`'s/`issueIndex()`'s own success/failure bookkeeping exactly
  // (same fields, same log events, same W1-T119/W1-T181 discipline) — they exist because a
  // worker's result arrives on a MESSAGE, not a return value, so there is no call site left for
  // `attemptFetch` itself to wrap. Nothing about WHAT is recorded changes; only WHEN it runs.
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
    // W1-T2323's own cross-half invalidation ("the one line that pays most of it back"),
    // replayed here verbatim for the async path — see `openRows`'s doc for why a PR leaving the
    // open set is the merge/close itself, observed, and must not wait out `mergedTtlMs`.
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

  /**
   * W1-T2440 — `warm()`'S REAL-DEFAULT PATH. See this file's module-scope doc above
   * `BOARD_PREWARM_WORKER_KIND` for why a `Worker`, not an `async`/`await` rewrite.
   *
   * Computes "is a refresh due" per channel EXACTLY as `openRows`/`mergedRows`/`issueIndex`
   * already do (same `now() - X.at >= ttl` shape) so a `warm()` called faster than the TTL is
   * still a no-op, matching the synchronous path's own "a second warm() within the TTL does not
   * refetch" contract (status.test.ts). At most ONE worker is ever in flight — a `warm()` call
   * while `prewarmWorker` is set returns immediately, exactly like the existing TTL no-op.
   */
  const runPrewarmWorker = (): void => {
    if (prewarmWorker) return;
    const fetchOpen = !openHalf || now() - openHalf.at >= effectiveOpenTtlMs();
    const fetchMerged = !mergedHalf || now() - mergedHalf.at >= effectiveMergedTtlMs();
    const fetchIssues = !issueCache || now() - issueCache.at >= ttlMs;
    if (!fetchOpen && !fetchMerged && !fetchIssues) return;
    // Captured BEFORE the walk starts, exactly like `openRows`'s own `previouslyOpen` — the set
    // this compares against must be the pre-refresh snapshot, not whatever `openHalf` becomes by
    // the time the worker's message arrives.
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
      // Spawning itself failed (e.g. this runtime has no worker_threads support) — fall back to
      // running the SAME channel walk (`runPrewarmChannelsSync`, immediately above) synchronously
      // on THIS thread, applied through the SAME `applyOpenOutcome`/`applyMergedOutcome`/
      // `applyIssuesOutcome` bookkeeping a landed worker message uses, rather than the unrelated
      // `index()`/`issueIndex()` pair. The ONE place this task's fix degrades to a blocking
      // `execFileSync` on the request-serving thread, and only when a worker cannot be created at
      // all — but even degraded, it stays `req.ghBin`-aware, never silently reverting to a
      // differently-configured `"gh"` default the way calling `index()` here would have.
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
    // EVERY TERMINAL PATH MUST REACH `finish()` EXACTLY ONCE, AND `exit` IS A TERMINAL PATH.
    //
    // `message` and `error` are not exhaustive: a worker thread can end WITHOUT emitting either —
    // `process.exit()` inside the worker is the ordinary case, an external `terminate()` the other.
    // Before this guard that left `prewarmWorker` SET, so the `if (prewarmWorker) return;` at the
    // top of this function made every LATER warm a permanent no-op while `fetchInFlight` and the
    // three `*WarmInFlight` flags stayed true — the read paths kept returning the in-flight
    // placeholder and the board never refreshed again short of a process restart. MEASURED against
    // a `data:` worker whose whole body is `process.exit(0)`: the gateway never left `in_flight`.
    //
    // `settled` is the once-only latch rather than three independent `once` handlers, because
    // `error` and `exit` BOTH fire for a crashed worker and the second arrival must not re-apply a
    // failure over an outcome already recorded (which would clobber a good `message` result with
    // "unknown" whenever the normal terminate below races the exit event).
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
      // The worker itself died — never a per-channel classified failure, which arrives via a
      // normal message — so every channel THIS call asked for is marked failed, the same "loud,
      // classified, never silent" discipline W1-T181 established for the synchronous path.
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
      // W1-T2387: THIS is the gateway `resolveAlreadySatisfied` actually builds (run-task.ts's
      // `opts.github ?? buildBatchedGithub(owner, task.repo)`), so the union has to live here as
      // well as on `ghGateway` or the fix ships unwired. Body first; a FAILED fetch still reports
      // as a failure rather than falling through to local evidence.
      if (lastFetchFailed()) return null;
      return commitTrailerFallback(taskId)[0] ?? null;
    },
    findMergedByTrailerAll(taskId) {
      // W1-T441: NO ADDITIONAL FETCH. `mergedNewestFirst` already carries every merged PR's body
      // from the ONE batched read, so returning every anchored match is a filter over data in
      // hand — the same `.find` this gateway already ran, widened to `.filter`. null on a fetch
      // failure (→ readFailed()/W1-T119), never [] — the failure/absence distinction.
      const anchored = new RegExp(`^Remudero-Task:\\s*${escapeRegExp(taskId)}\\s*$`, "m");
      if (lastFetchFailed()) return null;
      const byBody = index().mergedNewestFirst.filter((p) => anchored.test(p.body ?? "")).map(asRef);
      // W1-T2387: union, body-first — see the sibling above.
      return byBody.length > 0 ? byBody : commitTrailerFallback(taskId);
    },
    findMergedByHeadBranch(taskId) {
      // W1-T257: client-side head-ref match from the SAME single fetch — zero extra `gh` calls,
      // and on the STRUCTURED head ref, never the body index. null on a fetch failure (W1-T119).
      const idx = index();
      return lastFetchFailed() ? null : idx.mergedNewestFirst.filter((p) => ownsBranch(p.headRefName, taskId)).map(asRef);
    },
    listMergedHeadBranches() {
      // W1-T257: every merged PR (with its head ref) from the ONE fetch — projectPlan groups by
      // run-<taskId>-* client-side. null on a fetch failure (→ readFailed()/W1-T119), never [].
      const idx = index();
      return lastFetchFailed() ? null : idx.mergedNewestFirst.map(asRef);
    },
    listOpenHeadBranches() {
      // W1-T377: ZERO extra `gh`/REST calls beyond the one this half costs. Same null-on-failure
      // contract as the merged twin, so a fetch failure defers via W1-T119 instead of reading as
      // "this task has no open PR".
      //
      // W1-T2323: THE OPEN HALF ONLY — the single behavioural change this task makes to a public
      // method. MEASURED, a cold gateway answering this used to walk 26 REST requests over 22.2 s
      // for 6 open rows; it now walks 1 request over 432 ms. The daemon's dispatch breaker
      // (run-task.ts's `openHeadBranchesForBreaker`, which W1-T2318 already made lazy) is the
      // consumer that pays that difference, on the boot path, on the event loop.
      //
      // THE VALUE IS UNCHANGED, not merely similar: the rows come from GitHub's own `state=open`
      // query rather than from filtering an all-states fetch, and both answers are "every open PR
      // in this repo, newest first". `lastFetchFailed` still gates it, and still reflects EITHER
      // half's last attempt, so this is strictly no less fail-closed than before.
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
      // W1-T413, AND THE O(N) QUESTION ANSWERED RATHER THAN DODGED. The batched fetch is the REST
      // PR *list* (`fetchBoardPrsRest`), and that endpoint does not carry changed files at any
      // page size — files live only on `pulls/{n}/files`. So this cannot ride the one fetch the
      // way `body`/`headRefName`/`title` do, and pretending otherwise would be the vacuous fix.
      //
      // WHY IT IS STILL NOT THE RETRO'S DEFECT (24 x O(N) `gh pr list --search`, a 9-minute suite
      // for an hour): this is O(1) per PR that actually reaches the refusal, it is MEMOISED for
      // the gateway's lifetime, and `deriveStatus` pre-filters on the free `ownsOwnRunBranch`
      // test — so a projection over N tasks pays nothing for every task whose credit comes from
      // its own `run-<taskId>-*` branch, which is every ordinary implementation. The reads that
      // remain are bounded by the hand-named-branch population.
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
      // Cache the failure too (as null), so one unreachable PR cannot be re-read once per task in
      // the same projection — the exact multiplication this method exists to avoid.
      changedFilesByUrl.set(prUrl, paths ?? null);
      return paths;
    },
    autoMergeArmed(prUrl) {
      return index().byUrl.get(prUrl)?.autoMergeRequest != null;
    },
    reviewState(prUrl) {
      // W1-T914: the console's three-state read, over the SAME combined-status endpoint
      // open-prs-rest.ts's `combinedStatusRestArgs` already documents as where `remudero-review`
      // lives — never a second, independently-shaped GitHub call. Keyed off the PR's own head
      // BRANCH NAME (already resolved on this same batched index, zero extra list fetch) rather
      // than its sha: the combined-status endpoint's `:ref` accepts any git ref, and this gateway
      // never fetches a PR's `headRefOid` at all.
      const entry = index().byUrl.get(prUrl);
      if (!entry) return undefined; // this prUrl isn't in the current index -> undetermined
      // W1-T2235: a MERGED or CLOSED row has NO live check state to show, full stop — checked
      // FIRST, ahead of any cache lookup and ahead of any network call, never as a modifier on a
      // cache hit the row can never reach in the first place (that ordering was the whole
      // defect: `entry.headRefName` is a branch name GitHub deletes on merge, so the network call
      // below 404s for every terminal row, and the `catch` at the bottom of this method caches
      // nothing, so the same row re-failed on every single paint, forever). `remudero-review`
      // exists to watch a check go pending -> success on a PR that is still open; a terminal PR's
      // combined status is history, not a value this feature has any opinion about, so the
      // correct answer is not a cheaper fetch of the same field — it is that the field does not
      // apply. `.state` is already sitting on this same batched index; no new call, no new field.
      if (entry.state !== "OPEN") return "not-applicable";
      const headRef = entry.headRefName;
      if (!headRef) return undefined; // open PR with no resolvable head ref -> undetermined
      const cached = reviewStateCache.get(prUrl);
      if (cached && now() - cached.at < ttlMs) return cached.state;
      try {
        const raw = JSON.parse(run(combinedStatusRestArgs(owner, repo, headRef))) as {
          statuses?: Array<{ context?: string; state?: string }>;
        };
        // Only a REAL `statuses[]` row becomes an entry (rollupFromRest's own rule) — the
        // endpoint's top-level `state` is a roll-up-of-a-rollup that reports "pending" for a
        // commit with zero statuses, and synthesising from it would invent a pending review
        // GitHub never actually posted.
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
    // W1-T154: forces a fetch NOW. Boot calls this once (cache is empty -> always fetches); a
    // background timer paced to `ttlMs` calls it again every tick, and by construction the cache
    // is always exactly at (or past) its TTL when that fires, so a refetch happens every time —
    // no separate "force" branch needed.
    // W1-T182: warms the issue index too, on the same cadence — a cold escalation join would
    // otherwise pay its first `gh issue list` on the request path exactly like the pre-W1-T154
    // PR fetch did.
    // W1-T2440: an INJECTED gateway (every fixture above, including the three W1-T154 `warm()`
    // tests that assert the fetch count moves the instant this call returns) keeps calling
    // `index()`/`issueIndex()` directly and SYNCHRONOUSLY — a `Worker` cannot receive a JS
    // closure, so there is no worker path for a fixture-driven gateway to take, and none of this
    // task's fix is observable through one. The real, unconfigured default takes
    // `runPrewarmWorker` instead: same cadence, same `GH_CALL_TIMEOUT_MS` bound, same delta walk,
    // off this thread — see that function's own doc, and the module-scope doc above
    // `BOARD_PREWARM_WORKER_KIND`, for why.
    warm() {
      if (opts.exec || opts.fetchAll || opts.fetchAllIssues) {
        index();
        issueIndex();
        return;
      }
      runPrewarmWorker();
    },
    // W1-T2219: readFailed()/readFailureReason() no longer force `index()`. Pre-fix, EITHER
    // accessor alone forced a fetch — so asking "did the read fail" PERFORMED the read and
    // blocked the caller on a live `gh` call while reporting the PREVIOUS attempt's verdict
    // for the whole duration (rationale (2)(b)/(3)). Every real caller in this codebase already
    // reaches these AFTER a query method (`prByRef`/`findMergedByTrailer`/etc.) that itself
    // calls `index()`, so the reported verdict for a classified failure is UNCHANGED from
    // before this fix; the only case that changes is a caller that asks FIRST, which now gets
    // the honest "not_attempted" reading `readState()` exposes below rather than a forced,
    // blocking fetch pretending to answer about a read nobody has asked for yet.
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
      // Same force-a-fetch-first shape as `readFailed()` used to have (W1-T415, unchanged here
      // — `readTruncated()` is a distinct, THIRD signal this task does not touch): a caller
      // that asks this FIRST (never preceded by any other method call) still reports accurately
      // instead of trivially returning the initial `false`.
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
    // W1-T2219: closes rationale (2)(c) — `lastIssueFetchFailureReason` was already classified
    // and logged (`board_gateway.issue_fetch_failed`) but had no accessor, so an issue-channel
    // failure's REASON was reachable only by reading the ledger, never by a caller. Non-forcing,
    // like `readFailureReason()` above — a caller consults this only after `issueReadFailed()`
    // (which already forces `issueIndex()`) is `true`.
    issueReadFailureReason() {
      return lastIssueFetchFailureReason;
    },
  };
}

// ── W1-T2392 — A BUILD THAT MERGED WITH NO CREDIT ON ANY SURFACE ─────────────────────────────

/**
 * W1-T2392 — WHAT A MERGED, UNCREDITED BUILD LOOKS LIKE ONCE SOMEONE NOTICES.
 *
 * A REPORT, NEVER A CREDIT (the shard's Q2). Carrying this on a projection changes no merge
 * state, no dispatch decision and no disposition: `StatusProjection.merged` is untouched and the
 * task stays exactly as dispatchable as it was. Crediting from prose would be the over-crediting
 * W1-T2387 was required to rule out — a task credited wrongly is never built at all, which is
 * strictly worse than one built twice.
 */
export interface UncreditedBuildWarning {
  /** The merged PR that names this task in its own prose. */
  prNumber: number;
  prUrl: string;
  /** Which prose surface carried the id. Measured at head: 5 of 19 name it in the title, 14 only
   *  in the body — so a title-only reader would have missed #3095, the instance this exists for. */
  namedIn: "title" | "body";
}

/** W1-T2392: the anchored id form, a `[0-9]` class and never `\d`, so `W1-T239` never matches a
 *  mention of `W1-T2392`. Built per lookup rather than per candidate — see
 *  {@link indexProseNamedTaskIds} for why the scan is inverted. */
function proseNamesTaskId(text: string | undefined, taskId: string): boolean {
  if (!text) return false;
  const at = text.indexOf(taskId);
  if (at < 0) return false;
  return new RegExp(`${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^0-9]|$)`).test(text);
}

/**
 * W1-T2392 — THE SCAN IS INVERTED, AND THAT IS A COST DECISION RATHER THAN A STYLE ONE.
 *
 * The naive shape asks, per task, "does any merged PR name me?" — roughly 2,400 merged PRs times
 * roughly 900 plan tasks, over bodies averaging several kilobytes. That is tens of gigabytes of
 * scanning per projection and would make `deriveStatus` unusable.
 *
 * So this walks the merged set ONCE and returns id -> the PRs naming it, and every task then does
 * a map lookup. Titles and bodies are both read because the measurement says they must be: at
 * head, of the 19 uncredited builds naming an id, only 5 name it in the TITLE — #3095, the
 * instance this task exists for, names W1-T2379 in its body alone.
 */
export function indexProseNamedTaskIds(prs: readonly PrRef[]): Map<string, UncreditedBuildWarning[]> {
  const ID = /W1-T[0-9]+/g;
  const out = new Map<string, UncreditedBuildWarning[]>();
  for (const pr of prs) {
    const seen = new Map<string, "title" | "body">();
    for (const m of (pr.title ?? "").matchAll(ID)) seen.set(m[0], "title");
    for (const m of (pr.body ?? "").matchAll(ID)) if (!seen.has(m[0])) seen.set(m[0], "body");
    for (const [id, where] of seen) {
      // Re-assert ANCHORED, because the cheap global scan above matches a prefix: `W1-T239`
      // would otherwise be credited a mention of `W1-T2392`.
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
 * W1-T2392 — DOES THIS TASK HAVE A MERGED BUILD NOBODY CREDITED?
 *
 * THE CREDIT CHECK IS NOT RE-IMPLEMENTED HERE, and that is the point. This is only ever consulted
 * on a projection that is NOT merged, and "not merged" already means every one of the three paths
 * came back empty — `findMergedByTrailer`'s body trailer, `findMergedByHeadBranch`'s
 * `run-<id>-<digits>` head, and W1-T2387's commit surface. So the all-surfaces-empty condition the
 * shard scopes this to is exactly the caller's own state, and no fourth path is built.
 *
 * THE PLAN-ONLY REFUSAL IS LOAD-BEARING, not hygiene. The single largest naming population is
 * shard FILINGS, whose titles name their own id by convention (`chore(plan): file … (W1-T2392)`).
 * Without this every filed task would warn about the PR that filed it. `changedFiles` is the same
 * seam rung (c)'s own plan-only refusal uses (W1-T413), and it fails OPEN exactly as it does
 * there: an unreadable file list yields no warning rather than a fabricated one.
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
 * THE ASYMMETRY THIS NAMES. `isDispatchEligible` already sees open PRs, through `opts.isOpenPr`
 * <- `lastProj?.get(id)?.prState === "OPEN"`, resolved in `corroborateOpenByBranch` off the
 * batched gateway's OPEN half — no second call. But it attributes them by {@link ownsBranch}
 * alone, `^run-<taskId>-<digits>$`: ONE surface, where the merged side now has three. So an
 * operator-briefed build on a `fix/` branch is invisible and the task is dispatched again.
 * Measured: W1-T2387's #3102 was open and 87 minutes old when the fleet produced #3109.
 *
 * A WARN, AND THE MEASUREMENT IS WHY. The naive predicate ("any open PR naming this task") fired
 * four times in 72 hours and THREE OF THOSE MERGED — a refusal would have blocked shipped work.
 * Nor does a staleness bound rescue it: time-to-merge is median 18 minutes, p90 119, p95 255,
 * p99 864, so a threshold has to sit near EIGHT HOURS before it stops firing on healthy work, and
 * a refusal that is right at eight hours still costs eight hours of stall. A warn that is wrong
 * costs one line. THAT ASYMMETRY IS THE ENTIRE ARGUMENT for building this at a population of one.
 *
 * IT MUST NEVER FEED `isOpenPr`. Widening that is what converts this observation into the refusal
 * the shard declined, because `isDispatchEligible` already treats an in-flight PR as a reason to
 * skip. Nothing here is read by any eligibility path, and a test asserts `prState` is byte-
 * identical with and without this present.
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
 * FILE OVERLAP IS THE SIGNAL, NOT THE PROSE, and that is what makes it quiet. Naming a task is
 * not evidence a build of it is in flight: of the four naive firings, two siblings were plan
 * FILINGS (`chore(plan): file …`) and two were builds of DIFFERENT tasks mentioning the id in
 * passing. Requiring a path in the dispatched task's own declared `files:` drops both classes by
 * construction — a filing touches `plan/` alone and never overlaps — and halves the population.
 * Measured on the same window: 101 of 105 dispatches have no open sibling of any kind.
 *
 * THE TASK'S OWN RUN BRANCH IS EXCLUDED, because that is the in-flight case `isOpenPr` already
 * owns; re-reporting it would be noise on the one shape already handled.
 *
 * `changedFiles` UNREADABLE ⇒ NO OBSERVATION, never a guess: an absent file list is a read that
 * failed, and the same fail-open direction {@link GitHub.changedFiles}' own doc sets.
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
  // Newest first: a task with two open builds already has the problem this reports; the newest is
  // the one still moving. Mirrors `corroborateOpenByBranch`'s own tiebreak rather than inventing one.
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
