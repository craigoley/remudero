import { execFileSync } from "node:child_process";
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
import { dirname } from "node:path";
import type { Plan, Task, TaskStatus } from "./plan.js";
import { NEEDS_HUMAN_LABEL } from "./escalate.js";

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
 * rung (c). Then, absent a correction:
 *   (a) state/ledger.ndjson `pr.opened` line for this task -> query that PR's state;
 *   (b) an explicit `pr:` field in tasks.yaml (tasks executed by hand, pre-ledger);
 *   (c) a merged PR whose body carries the trailer `Remudero-Task: <id>` —
 *       ownership-asserted (its head branch must be this task's own `run-<id>-*`),
 *       anchor-verified (the trailer must be an exact line, not a fuzzy search
 *       hit), and correction-aware (a `correction.provenance` line debunking this
 *       exact credit is honored) — MASTER-PLAN P16 / W1-T69, the "W1-T20c
 *       false-credit" class: deriveStatus GATES DISPATCH, so a bad credit here
 *       is worse than the same class W1-T51 fixed in the retro gather.
 * First source that resolves a PR wins. If none resolve, the task is not merged.
 *
 * NOTHING in this module writes tasks.yaml. It reads the plan and the ledger and
 * queries GitHub; the only file it writes is the status.json cache.
 */

/**
 * The three precedence sources, plus `none` when GitHub has no evidence, plus
 * `throttled` when GitHub could not be read at all (rate-limited, network error,
 * or any other failed `gh` call) — W1-T119: an exhausted/errored read must never
 * be conflated with a genuinely absent result, the false `source: "none"` that
 * mis-filed W1-T116 as not-merged when GitHub simply hadn't been consulted.
 */
export type StatusSource = "ledger" | "pr-field" | "trailer" | "correction" | "none" | "throttled";

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
  const text = String(stderr ?? "");
  if (/rate limit|quota|secondary rate limit/i.test(text)) return "rate_limit";
  if (/bad credentials|authentication|not logged in|gh auth login|401 unauthorized|unauthorized/i.test(text)) return "auth";
  if (/getaddrinfo|econnrefused|econnreset|etimedout|enotfound|could not resolve host|network is unreachable|dial tcp|timeout/i.test(text)) {
    return "transport";
  }
  return "unknown";
}

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
   */
  readFailureReason?(): GhFailureReason | undefined;
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
   * LIVENESS BOUND (W1-T179 design (ii)): how many milliseconds of ledger silence a
   * dispatched, unresolved run tolerates before it is no longer "running" absent an open
   * PR — a data threshold, injectable so a test can assert the boundary without a real
   * sleep (mirrors {@link DeriveDeps.now}). Defaults to {@link DEFAULT_LIVENESS_BOUND_MS}.
   */
  livenessBoundMs?: number;
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
};

function withTornCount(out: Array<Record<string, unknown>>, torn: number): LedgerLines {
  Object.defineProperty(out, "torn", { value: torn, enumerable: false, configurable: true });
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
export function readLedgerLines(path: string, ledgerFs: LedgerFsDeps = realLedgerFs): LedgerLines {
  const out: Array<Record<string, unknown>> = [];
  if (!ledgerFs.existsSync(path)) return withTornCount(out, 0);
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
  return withTornCount(out, torn);
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
 * How many `run.start` ledger lines exist for `taskId` SINCE its most recent
 * `pr.opened` line (or in total, if it has never opened one) — "dispatches
 * with no NEW owned PR" (P29(ii)'s own phrasing). Every `pr.opened` line is
 * inherently OWNED by construction: run-task.ts logs it only after ITS OWN
 * worker pushes ITS OWN `run-<taskId>-<epochMs>` branch (worker.ts), so no
 * separate ownership check is needed here the way rung (c)'s trailer search
 * needs one — a `pr.opened` line can only ever name this task's own work.
 * A fresh PR (even one that does not merge, e.g. blocked_ci) resets the count
 * to 0 — genuine forward progress is not what this breaker guards against;
 * the W1-T1/W1-T29 shape is dispatch after dispatch producing NOTHING new.
 */
export function dispatchesWithoutNewOwnedPr(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
): number {
  let count = 0;
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    if (line.step === "pr.opened") {
      count = 0; // forward progress — a new PR resets the streak
    } else if (line.step === "run.start") {
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
export function evaluateDispatchBreaker(
  ledgerPath: string,
  taskId: string,
  cache: DispatchBreakerCache,
  opts: { maxDispatches?: number; ledgerFs?: LedgerFsDeps } = {},
): "tripped" | "clear" | "indeterminate" {
  const maxDispatches = opts.maxDispatches ?? DEFAULT_MAX_TASK_DISPATCHES;
  const ledgerFs = opts.ledgerFs ?? realLedgerFs;
  const lines = readLedgerLines(ledgerPath, ledgerFs);
  const freshCount = dispatchesWithoutNewOwnedPr(lines, taskId);
  const priorCount = cache.lastCounts.get(taskId);
  const hasNewOwnedPr = lastPrOpened(lines, taskId) !== undefined;

  if (priorCount !== undefined && freshCount < priorCount && !hasNewOwnedPr) {
    return "indeterminate"; // count regressed with nothing in the ledger to explain it
  }

  cache.lastCounts.set(taskId, freshCount);
  return freshCount >= maxDispatches ? "tripped" : "clear";
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
 * Never weaken this assert to accommodate a `fix/*` head.
 */
function ownsBranch(head: string | undefined, taskId: string): boolean {
  if (!head) return false;
  return new RegExp(`^run-${escapeRegExp(taskId)}-\\d+$`).test(head);
}

/**
 * RUNG (c) ANCHORED-TRAILER VERIFY (P16 / W1-T69): `findMergedByTrailer` is a
 * GitHub full-text body search — fuzzy, tokenized on punctuation, and capable of
 * matching a PR whose trailer actually names a DIFFERENT (e.g. prefix-sharing)
 * task id, the exact "W1-T20c false-credit" class this rung ratifies. The search
 * hit is a first pass only; this is the authoritative local check that the body
 * carries the trailer as its own exact, anchored line.
 */
function hasAnchoredTrailer(body: string | undefined, taskId: string): boolean {
  if (!body) return false;
  return new RegExp(`^Remudero-Task:\\s*${escapeRegExp(taskId)}\\s*$`, "m").test(body);
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
  // The un-credit direction (P9-iv): once a correction exists for this task it is
  // authoritative in BOTH directions and deriveStatus never falls through to a
  // stale rung below it — including when the correction's own target PR cannot be
  // resolved (closed/absent/deleted), which derives NOT merged rather than
  // silently re-crediting whatever rung (a)/(b)/(c) would have said.
  const correctedUrl = latestActualPrUrl(ledgerLines, task.id);
  if (correctedUrl) {
    const pr = deps.github.prByRef(correctedUrl);
    if (pr) {
      return { taskId: task.id, source: "correction", ...fromPrState(pr.state), prNumber: pr.number, prUrl: pr.url, prState: pr.state };
    }
    return { taskId: task.id, status: "queued", merged: false, source: "correction" };
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

  // (b) explicit `pr:` field (hand-executed, pre-ledger) — precedence UNCHANGED:
  // only consulted when (a) resolved NOTHING at all (no `openedUrl`, or GitHub
  // could not resolve it) — an `ownResult` already captured from (a), merged or
  // not, still means (b) is never tried, exactly as before this fix.
  if (!ownResult && task.pr !== undefined) {
    const pr = deps.github.prByRef(task.pr);
    if (pr) {
      const result: StatusProjection = { taskId: task.id, source: "pr-field", ...fromPrState(pr.state), prNumber: pr.number, prUrl: pr.url, prState: pr.state };
      if (result.merged) return result;
      ownResult = result;
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
  const trailerPr = deps.github.findMergedByTrailer(task.id);
  if (trailerPr && !debunkedTrailerUrls(ledgerLines, task.id).has(trailerPr.url)) {
    const head = deps.github.headRefName(trailerPr.url);
    const body = deps.github.prBody(trailerPr.url);
    if (ownsBranch(head, task.id) && hasAnchoredTrailer(body, task.id)) {
      return { taskId: task.id, source: "trailer", ...fromPrState(trailerPr.state), prNumber: trailerPr.number, prUrl: trailerPr.url, prState: trailerPr.state };
    }
    // Rejected: foreign/unresolved head branch or an unanchored search hit — never
    // credited. Surface WHY (legibility, W1-T69) ONLY when (a)/(b) found nothing to
    // report either — an `ownResult` (this run's own OPEN/CLOSED PR) remains the
    // more informative status to return than a bare rejection of an unrelated hit.
    if (!ownResult) {
      const reason = !ownsBranch(head, task.id) ? "head-branch-not-owned" : "trailer-not-anchored";
      return {
        taskId: task.id,
        status: "queued",
        merged: false,
        source: "none",
        rejected_candidates: [{ pr: trailerPr.url, reason }],
      };
    }
  }

  // No merged sibling credit found: fall back to (a)/(b)'s own (non-merged)
  // resolution, unchanged from before this fix.
  if (ownResult) return ownResult;

  // No GitHub evidence: not merged. The yaml `status:` is decorative, not trusted.
  // EXCEPT (W1-T119) when that "no evidence" is actually "GitHub could not be read" —
  // an exhausted/errored `gh` call must defer, never be reported as a confirmed
  // not-merged (the false `source: "none"` that mis-filed W1-T116).
  if (deps.github.readFailed?.()) {
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
}

/**
 * Scan `taskId`'s ledger lines (chronological, append-only — every line already carries
 * `run_id`/`task_id`, run-task.ts's `log` wrapper stamps both on every call) for the state
 * of its LATEST run: is it still in flight, and — while in flight — the CURRENT phase and
 * when it started (W1-T155). A `run.start` always resets every field back to `recon`, so an
 * EARLIER run's stale phase/conclusion never leaks into a later run's state — the falsifier
 * the task's acceptance criteria name explicitly ("a stale/earlier phase is not reported").
 * Every step name here is a REAL run-task.ts ledger step (verified against source, not
 * guessed): `run.start`, `recon.done`, `implement.done`/`implement.resumed`, `pr.opened`,
 * `fix.dispatch`/`fix.review`, `fix.resolved`, `verdict`.
 */
function deriveRunState(lines: ReadonlyArray<Record<string, unknown>>, taskId: string): RunState {
  let inFlight = false;
  let phase: Phase | undefined;
  let startedAt: string | undefined;
  let lastActivityTs: string | undefined;
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    if (typeof line.ts === "string") lastActivityTs = line.ts;
    switch (line.step) {
      case "run.start":
        inFlight = true;
        phase = "recon";
        startedAt = typeof line.ts === "string" ? line.ts : undefined;
        break;
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
      case "verdict":
        inFlight = false;
        break;
    }
  }
  return { inFlight, phase, startedAt, lastActivityTs };
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
): { issueUrl?: string; escalationClass?: string } | undefined {
  let last: "run" | "escalation" | undefined;
  let issueUrl: string | undefined;
  let escalationClass: string | undefined;
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    if (line.step === "run.start") {
      last = "run";
    } else if (line.step === "escalation.issue_opened") {
      last = "escalation";
      issueUrl = typeof line.issue_url === "string" ? line.issue_url : undefined;
      escalationClass = typeof line.class === "string" ? line.class : undefined;
    }
  }
  return last === "escalation" ? { issueUrl, escalationClass } : undefined;
}

/** {@link deriveStatus}'s escalation-derived fields, once an escalation resolves as still-relevant. */
export interface EscalationState {
  issueUrl?: string;
  escalationClass?: string;
  title?: string;
  unverified?: true;
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
      if (hasOpenPr || recentActivity) {
        projection.status = "running";
        projection.phase = runState.phase;
        if (runState.startedAt) {
          projection.startedAt = runState.startedAt;
          projection.elapsedMs = Math.max(0, now() - Date.parse(runState.startedAt));
        }
      } else {
        // Dispatched, no terminal verdict, no open PR, no recent activity: unknown/orphaned,
        // never running (the falsifier: an orphaned dispatch rendered as running).
        projection.orphaned = true;
      }
    }
  }

  const escalation = resolveEscalation(ledgerLines, task.id, deps.github);
  if (escalation) {
    projection.needsHuman = true;
    if (escalation.issueUrl) projection.escalationIssueUrl = escalation.issueUrl;
    if (escalation.title) projection.escalationTitle = escalation.title;
    if (escalation.unverified) projection.escalationUnverified = true;
  }

  // ARMED-AWAITING-MERGE: only meaningful for a currently OPEN PR — reuses the exact
  // prUrl the precedence rungs above already resolved, so this is never a second,
  // independently-resolved PR reference.
  if (projection.status === "running" && projection.prUrl && deps.github.autoMergeArmed?.(projection.prUrl)) {
    projection.armedAwaitingMerge = true;
  }

  return projection;
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
  const byId = new Map<string, StatusProjection>();
  for (const task of plan.tasks) byId.set(task.id, deriveStatus(task, effectiveDeps));
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
export function ghRequiredStatusCheckContexts(owner: string, repo: string, branch = "main"): string[] | undefined {
  try {
    const raw = execFileSync(
      "gh",
      ["api", `repos/${owner}/${repo}/branches/${branch}/protection/required_status_checks`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(raw) as { contexts?: unknown; checks?: Array<{ context?: unknown }> };
    const fromChecks = (parsed.checks ?? [])
      .map((c) => c.context)
      .filter((c): c is string => typeof c === "string" && c.length > 0);
    if (fromChecks.length > 0) return fromChecks;
    const fromContexts = Array.isArray(parsed.contexts) ? parsed.contexts.filter((c): c is string => typeof c === "string") : [];
    return fromContexts.length > 0 ? fromContexts : undefined;
  } catch {
    return undefined;
  }
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
export function ghGateway(owner: string, repo: string, opts: { exec?: (args: string[]) => string } = {}): GitHub {
  const slug = `${owner}/${repo}`;
  // Sticky for this gateway instance's lifetime (W1-T119): once ANY `gh` call fails,
  // every null/[] result derived since is untrustworthy as "absent", not just the one
  // that failed — a single short-lived gateway (created per command invocation) has
  // no cheaper way to know which earlier calls in the same derivation shared the same
  // outage, so it errs toward "defer everything" rather than risk one still reading
  // as a confirmed not-merged.
  let failed = false;
  let failureReason: GhFailureReason | undefined;
  const run =
    opts.exec ??
    // stdio's 3rd fd is now `pipe`, not `ignore` (W1-T119 design (i)): the
    // pre-fix triple discarded `gh`'s stderr — the one place a rate-limit or
    // auth message appears — before anyone could classify WHY a read failed.
    ((args: string[]) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
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
  return {
    prByRef(ref) {
      // "title" rides along on this SAME fetch (W1-T184) — a decoration, never an extra
      // `gh` call: lib/board.ts's RECENT activity feed reads it off the SAME PrRef this
      // method already returns for every other caller.
      const pr = tryJson<PrRef>(["pr", "view", String(ref), "--repo", slug, "--json", "number,url,state,title"]);
      return pr && typeof pr.number === "number" ? pr : null;
    },
    findMergedByTrailer(taskId) {
      // GitHub body search for the exact trailer, merged PRs only, newest first.
      // Fuzzy (P16 / W1-T69) — callers must re-verify via headRefName + prBody
      // before crediting; this is a first pass, never the authority.
      const list = tryJson<PrRef[]>([
        "pr", "list", "--repo", slug, "--state", "merged",
        "--search", `"Remudero-Task: ${taskId}" in:body`,
        "--json", "number,url,state", "--limit", "1",
      ]);
      return list && list.length > 0 ? list[0] : null;
    },
    headRefName(prUrl) {
      const view = tryJson<{ headRefName?: string }>(["pr", "view", prUrl, "--json", "headRefName"]);
      return view?.headRefName;
    },
    prBody(prUrl) {
      const view = tryJson<{ body?: string }>(["pr", "view", prUrl, "--json", "body"]);
      return view?.body;
    },
    autoMergeArmed(prUrl) {
      const view = tryJson<{ autoMergeRequest?: unknown }>(["pr", "view", prUrl, "--json", "autoMergeRequest"]);
      return view?.autoMergeRequest != null;
    },
    issueByUrl(url) {
      const view = tryJson<{ state?: string; title?: string }>(["issue", "view", url, "--json", "state,title"]);
      return view && typeof view.state === "string" ? { state: view.state, title: view.title } : null;
    },
    readFailed() {
      return failed;
    },
    readFailureReason() {
      return failureReason;
    },
    // Shares the same sticky `failed` flag as `readFailed()` above (W1-T119's per-instance
    // "one outage taints every read since" discipline) — this per-task gateway makes one `gh`
    // call per query already, so there is no separate batched issue-fetch to distinguish.
    issueReadFailed() {
      return failed;
    },
  };
}

/** One PR row from the single batched `gh pr list` fetch that backs {@link buildBatchedGithub}. */
export interface BatchedPr {
  number: number;
  url: string;
  state: string;
  headRefName?: string;
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
  } = {},
): GitHub {
  const ttlMs = opts.ttlMs ?? 15_000;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const slug = `${owner}/${repo}`;
  // W1-T119: reflects only the MOST RECENT fetch attempt (reset on every call, unlike
  // ghGateway's sticky-for-instance-lifetime flag) — this gateway's single batched fetch
  // refreshes on its own `ttlMs` cadence, so a stale failure from an earlier TTL window
  // must not keep shadowing a later fetch that actually succeeded.
  let lastFetchFailed = false;
  let lastFetchFailureReason: GhFailureReason | undefined;
  const run =
    opts.exec ??
    // 3rd fd is `pipe` (W1-T119), not `ignore` — same stderr-capture fix as ghGateway, so this
    // gateway's `readFailureReason()` is real too, not always "unknown". maxBuffer is 64 MiB
    // (W1-T181) — Node's 1 MiB default threw ENOBUFS once this repo's PR JSON (all states, up to
    // 1000 PRs, `body` included) crossed it; classifyGhFailure's "buffer_overflow" branch is how
    // that specific failure is now classified instead of "unknown".
    ((args: string[]) =>
      execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 }));
  const fetchAll =
    opts.fetchAll ??
    (() => {
      const raw = run([
        // W1-T155: `autoMergeRequest` rides along on this SAME single fetch — the
        // armed-awaiting-merge taxonomy costs zero extra `gh` calls, preserving the
        // board-fix O(1) invariant this gateway exists for.
        // "title" rides along too (W1-T184) — RECENT's PR-title decoration costs zero extra
        // `gh` calls, same O(1) invariant this gateway already holds for autoMergeRequest.
        "pr", "list", "--repo", slug, "--state", "all", "--json", "number,url,state,headRefName,body,autoMergeRequest,title", "--limit", "1000",
      ]);
      // W1-T181 design (vi): log the payload size on every SUCCESSFUL fetch, so the next
      // approach to whatever ceiling is set above is observable in advance instead of arriving
      // as a silent outage the way tonight's did.
      log("board_gateway.fetch_bytes", { bytes: Buffer.byteLength(raw, "utf8") });
      return JSON.parse(raw) as BatchedPr[];
    });

  // W1-T182: an INDEPENDENT batched fetch/cache pair for escalation issues, deliberately not
  // folded into the PR fetch/cache above — a PR-fetch outage and an issue-fetch outage are
  // different failures with different classified reasons, and {@link resolveEscalation}'s
  // fail-closed join needs its OWN `issueReadFailed()` signal rather than inheriting the PR
  // fetch's. Scoped to `--label needs-human` (escalate.ts's `NEEDS_HUMAN_LABEL`) so this stays
  // one small, bounded fetch (dozens of rows) rather than every issue in the repo.
  let lastIssueFetchFailed = false;
  let lastIssueFetchFailureReason: GhFailureReason | undefined;
  const fetchAllIssues =
    opts.fetchAllIssues ??
    (() => {
      const raw = run([
        "issue", "list", "--repo", slug, "--label", NEEDS_HUMAN_LABEL, "--state", "all",
        "--json", "number,url,state,title", "--limit", "1000",
      ]);
      log("board_gateway.issue_fetch_bytes", { bytes: Buffer.byteLength(raw, "utf8") });
      return JSON.parse(raw) as BatchedIssue[];
    });

  interface IssueIndex {
    at: number;
    byUrl: Map<string, BatchedIssue>;
    byNum: Map<string, BatchedIssue>;
  }
  let issueCache: IssueIndex | undefined;
  const issueIndex = (): IssueIndex => {
    if (!issueCache || now() - issueCache.at >= ttlMs) {
      let all: BatchedIssue[];
      try {
        all = fetchAllIssues();
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
  }
  let cache: Index | undefined;
  const index = (): Index => {
    if (!cache || now() - cache.at >= ttlMs) {
      // W1-T181: the catch lives HERE, wrapping `fetchAll()` itself — not only inside the
      // default `run`-based implementation above — so an INJECTED `fetchAll` (every unit-test
      // fixture, and any future caller-supplied implementation) that throws is classified and
      // marked exactly like a real `gh` failure, instead of propagating uncaught out of every
      // GitHub method this gateway returns. Before this fix, a throwing `fetchAll` crashed the
      // caller; only the default execFileSync path degraded softly.
      let all: BatchedPr[];
      try {
        all = fetchAll();
        lastFetchFailed = false;
        lastFetchFailureReason = undefined;
        log("board_gateway.fetch_ok", { prCount: all.length });
      } catch (err) {
        lastFetchFailed = true;
        const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
        lastFetchFailureReason = classifyGhFailure(e?.status, e?.stderr != null ? String(e.stderr) : undefined, e?.code);
        // LOUD (W1-T181 design (ii)/(v)): the pre-fix catch was silent for hours — `lastFetchFailed
        // = true; return []` — with zero serve.log error lines, because ENOBUFS classified
        // "unknown" and nothing ever surfaced it. console.error guarantees this reaches
        // stdout/stderr (and therefore whatever log `rmd serve`'s process is redirected into) even
        // if a caller never wires `opts.log`; the injectable `log` ALSO fires so a caller with a
        // ledger can key an alert off the classified reason without scraping console output.
        console.error(`board gateway: batched PR fetch failed (${lastFetchFailureReason}): ${e?.message ?? String(err)}`);
        log("board_gateway.fetch_failed", { reason: lastFetchFailureReason, message: e?.message ?? String(err) });
        // W1-T181 design (v): a bare [] here is what converted "I could not read GitHub" into
        // "GitHub says there are zero PRs" — every task then silently derived not-merged from an
        // outage that had nothing to do with the repo's actual PRs. The [] below is now always
        // PAIRED with `lastFetchFailed`/`lastFetchFailureReason`, which `readFailed()`/
        // `readFailureReason()` (below) surface to derivePrPrecedence (~line 596): a caller that
        // consults those BEFORE trusting an empty result sees a MARKED failure, never a bare
        // absence — the signal W1-T179's github_unobservable marking is designed to consume.
        all = [];
      }
      cache = {
        at: now(),
        byUrl: new Map(all.map((p) => [p.url, p])),
        byNum: new Map(all.map((p) => [String(p.number), p])),
        // Higher PR number = more recent; mirrors ghGateway's search "newest first".
        mergedNewestFirst: all.filter((p) => p.state === "MERGED").sort((a, b) => b.number - a.number),
      };
    }
    return cache;
  };

  const asRef = (p: BatchedPr): PrRef => ({ number: p.number, url: p.url, state: p.state, title: p.title });
  const lookup = (ref: string | number): BatchedPr | undefined => {
    const idx = index();
    const s = String(ref);
    return idx.byUrl.get(s) ?? idx.byNum.get(s) ?? idx.byNum.get(s.replace(/^.*\/(\d+)$/, "$1"));
  };

  return {
    prByRef(ref) {
      const p = lookup(ref);
      return p && typeof p.number === "number" ? asRef(p) : null;
    },
    findMergedByTrailer(taskId) {
      const anchored = new RegExp(`^Remudero-Task:\\s*${escapeRegExp(taskId)}\\s*$`, "m");
      const hit = index().mergedNewestFirst.find((p) => anchored.test(p.body ?? ""));
      return hit ? asRef(hit) : null;
    },
    headRefName(prUrl) {
      return index().byUrl.get(prUrl)?.headRefName;
    },
    prBody(prUrl) {
      return index().byUrl.get(prUrl)?.body;
    },
    autoMergeArmed(prUrl) {
      return index().byUrl.get(prUrl)?.autoMergeRequest != null;
    },
    issueByUrl(url) {
      const i = lookupIssue(url);
      return i ? { state: i.state, title: i.title } : null;
    },
    // W1-T154: forces `index()` NOW. Boot calls this once (cache is empty -> always fetches);
    // a background timer paced to `ttlMs` calls it again every tick, and by construction the
    // cache is always exactly at (or past) its TTL when that fires, so `index()`'s own
    // `now() - cache.at >= ttlMs` check refetches every time — no separate "force" branch needed.
    // W1-T182: warms the issue index too, on the same cadence — a cold escalation join would
    // otherwise pay its first `gh issue list` on the request path exactly like the pre-W1-T154
    // PR fetch did.
    warm() {
      index();
      issueIndex();
    },
    readFailed() {
      // Forces a fetch first if the cache is cold/expired, so `readFailed()` alone
      // (never preceded by any other method call) still reports accurately instead
      // of trivially returning the initial `false`.
      index();
      return lastFetchFailed;
    },
    readFailureReason() {
      index();
      return lastFetchFailureReason;
    },
    issueReadFailed() {
      issueIndex();
      return lastIssueFetchFailed;
    },
  };
}
