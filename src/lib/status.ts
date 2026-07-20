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
 * missing credentials), `"transport"` (network/DNS/timeout), and `"unknown"`
 * for anything else UNCLASSIFIABLE. `"unknown"` still counts as UNAVAILABLE,
 * never as absent — the fail-closed direction design (i) calls for, because
 * absence is the conclusion that costs money.
 */
export type GhFailureReason = "rate_limit" | "auth" | "transport" | "unknown";

/**
 * Classify a failed `gh` invocation's exit status + stderr into a {@link
 * GhFailureReason} (W1-T119 design (i)). Pure and exported so {@link ghGateway}
 * / {@link buildBatchedGithub} and unit tests share the exact same
 * classification rather than each re-implementing the string matching — an
 * injected gateway in a test can construct the identical reason a real `gh`
 * failure would produce. `status` is accepted for future refinement (some
 * failure classes may one day be distinguishable by exit code alone) but
 * today the classification is driven entirely by `stderr`, the one place a
 * rate-limit/auth/transport message actually appears.
 */
export function classifyGhFailure(status: number | null | undefined, stderr: string | null | undefined): GhFailureReason {
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
}

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

/** Default NDJSON ledger reader: one JSON object per non-blank line. Reads the ledger
 * file directly via the injected (real, by default) fs — never copies it anywhere first. */
export function readLedgerLines(path: string, ledgerFs: LedgerFsDeps = realLedgerFs): Array<Record<string, unknown>> {
  if (!ledgerFs.existsSync(path)) return [];
  return ledgerFs
    .readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
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
    return {
      taskId: task.id,
      status: "queued",
      merged: false,
      source: "throttled",
      indeterminate: true,
      unavailableReason: deps.github.readFailureReason?.() ?? "unknown",
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
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
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
  return { inFlight, phase, startedAt };
}

/**
 * True iff the LATEST signal for `taskId`, among `run.start` (a (re)dispatch) and
 * `escalation.issue_opened` (escalate.ts's needs-human issue), is the escalation — a
 * human has not yet acted, or the task was never redispatched since (W1-T155, "needs-
 * human from the open escalation"). Mirrors the "last one wins" scanning idiom every
 * other precedence helper in this module already uses ({@link lastPrOpened},
 * {@link debunkedTrailerUrls}, {@link latestActualPrUrl}) rather than inventing a second.
 */
function hasOpenEscalation(lines: ReadonlyArray<Record<string, unknown>>, taskId: string): boolean {
  let last: "run" | "escalation" | undefined;
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    if (line.step === "run.start") last = "run";
    else if (line.step === "escalation.issue_opened") last = "escalation";
  }
  return last === "escalation";
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
      projection.status = "running";
      projection.phase = runState.phase;
      if (runState.startedAt) {
        projection.startedAt = runState.startedAt;
        projection.elapsedMs = Math.max(0, now() - Date.parse(runState.startedAt));
      }
    }
  }

  if (hasOpenEscalation(ledgerLines, task.id)) {
    projection.needsHuman = true;
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
  const byId = new Map<string, StatusProjection>();
  for (const task of plan.tasks) byId.set(task.id, deriveStatus(task, deps));
  if (cachePath) {
    fs.mkdirSync(dirname(cachePath), { recursive: true });
    const projection = {
      generated_at: new Date().toISOString(),
      note: "Machine-owned projection derived from GitHub. tasks.yaml is never rewritten.",
      tasks: Object.fromEntries([...byId].map(([id, p]) => [id, p])),
    };
    fs.writeFileSync(cachePath, JSON.stringify(projection, null, 2) + "\n");
  }
  return byId;
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
      failureReason = classifyGhFailure(e?.status, e?.stderr != null ? String(e.stderr) : undefined);
      return null;
    }
  };
  return {
    prByRef(ref) {
      const pr = tryJson<PrRef>(["pr", "view", String(ref), "--repo", slug, "--json", "number,url,state"]);
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
    readFailed() {
      return failed;
    },
    readFailureReason() {
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
  body?: string;
  /**
   * GitHub's raw `autoMergeRequest` field (W1-T155): `null`/absent when auto-merge is not
   * armed, an object when it is. Carried verbatim (never pre-reduced to a boolean) so the
   * gateway's `autoMergeArmed` method applies the SAME `!= null` test `ghGateway` and
   * run-task.ts's `buildOpenPrViews`/`buildOpenPrView` already use for this exact field.
   */
  autoMergeRequest?: unknown;
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
 */
export function buildBatchedGithub(
  owner: string,
  repo: string,
  opts: { ttlMs?: number; now?: () => number; fetchAll?: () => BatchedPr[] } = {},
): GitHub {
  const ttlMs = opts.ttlMs ?? 15_000;
  const now = opts.now ?? (() => Date.now());
  // W1-T119: reflects only the MOST RECENT fetch attempt (reset on every call, unlike
  // ghGateway's sticky-for-instance-lifetime flag) — this gateway's single batched fetch
  // refreshes on its own `ttlMs` cadence, so a stale failure from an earlier TTL window
  // must not keep shadowing a later fetch that actually succeeded.
  let lastFetchFailed = false;
  let lastFetchFailureReason: GhFailureReason | undefined;
  const fetchAll =
    opts.fetchAll ??
    (() => {
      const slug = `${owner}/${repo}`;
      try {
        const result = JSON.parse(
          execFileSync(
            "gh",
            // W1-T155: `autoMergeRequest` rides along on this SAME single fetch — the
            // armed-awaiting-merge taxonomy costs zero extra `gh` calls, preserving the
            // board-fix O(1) invariant this gateway exists for.
            ["pr", "list", "--repo", slug, "--state", "all", "--json", "number,url,state,headRefName,body,autoMergeRequest", "--limit", "1000"],
            // 3rd fd is `pipe` (W1-T119), not `ignore` — same stderr-capture fix as
            // ghGateway, so this gateway's `readFailureReason()` is real too, not
            // always "unknown".
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          ),
        ) as BatchedPr[];
        lastFetchFailed = false;
        lastFetchFailureReason = undefined;
        return result;
      } catch (err) {
        lastFetchFailed = true;
        const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
        lastFetchFailureReason = classifyGhFailure(e?.status, e?.stderr != null ? String(e.stderr) : undefined);
        return [];
      }
    });

  interface Index {
    at: number;
    byUrl: Map<string, BatchedPr>;
    byNum: Map<string, BatchedPr>;
    mergedNewestFirst: BatchedPr[];
  }
  let cache: Index | undefined;
  const index = (): Index => {
    if (!cache || now() - cache.at >= ttlMs) {
      const all = fetchAll();
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

  const asRef = (p: BatchedPr): PrRef => ({ number: p.number, url: p.url, state: p.state });
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
    // W1-T154: forces `index()` NOW. Boot calls this once (cache is empty -> always fetches);
    // a background timer paced to `ttlMs` calls it again every tick, and by construction the
    // cache is always exactly at (or past) its TTL when that fires, so `index()`'s own
    // `now() - cache.at >= ttlMs` check refetches every time — no separate "force" branch needed.
    warm() {
      index();
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
  };
}
