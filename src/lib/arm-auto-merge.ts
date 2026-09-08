/**
 * W1-T2887 — THE AUTO-MERGE ARM CLUSTER, RELOCATED FROM run-task.ts.
 *
 * `armAutoMerge`, `armAutoMergeDetailed`, `attemptArm`, `armAutoMergeAtOpen`, `disarmAutoMerge`,
 * `armIfVerdictPermits`, `realArmDeps` and their classifiers formed one closed cluster in
 * `src/run-task.ts` around `decideAutoMergeArm` (already in `src/lib/review.ts`) — the pure half
 * of the same decision, sitting beside its effectful half only because that is where the file
 * happened to grow. This module IS that effectful half, moved so the cluster is importable and
 * unit-testable without pulling in the rest of the CLI entrypoint. `src/run-task.ts` imports and
 * re-exports every name below, so every existing call site and every existing test that imports
 * from `../src/run-task.js` keeps resolving to the SAME functions, unchanged.
 *
 * DUPLICATED, NOT IMPORTED: a handful of small REST helpers (`prUrlTarget`-shaped URL parsing,
 * `fixRebaseMergeFactsFromRest`, `ghUpdateBranch`, `readHeadShaRest`, `prNumberFromRef`) still
 * live in run-task.ts because they are ALSO used by subsystems well outside this cluster (the
 * fix-rebase rung, provenance reads, red-base-refresh) — moving them here would misname them as
 * arm-specific and drag unrelated call sites along for a task whose one concern is the arm
 * cluster. `.dependency-cruiser.cjs`'s `lib-no-spike-or-cli` rule (severity: error) forbids this
 * file importing anything from `run-task.ts` in the other direction, so `realArmDeps()`'s own
 * need for those readings is met by small PRIVATE mirrors below, built from the SAME underlying
 * `src/lib/open-prs-rest.ts` / `src/lib/worker.ts` primitives the run-task.ts originals already
 * use — never a re-derivation of the wire shape, just a second thin wrapper around it. A future
 * decomposition step that lifts those shared REST readings into their own lib module could then
 * have both run-task.ts and this file import the ONE copy; noted as a follow-up, not done here.
 */
import { execFileSync } from "node:child_process";
import { loadConfig, type Config } from "./config.js";
import { ledgerPathFor } from "./ledger-path.js";
import { readLedgerLines } from "./status.js";
import {
  ghJson,
  ghRateLimitRefusalUnknown,
  type GhRateLimitRefusal,
} from "./worker.js";
import {
  mapRestPr,
  liveStateFromRest,
  singlePrRestArgs,
  type GhApiFetcher,
  type RestPullRow,
} from "./open-prs-rest.js";
import {
  assertLiveWriteAllowed,
  isTestRunner,
  liveWritesExempt,
  LIVE_WRITE_OVERRIDE_ENV,
} from "./live-write-guard.js";
import {
  automergeHoldFromLedger,
  cappedOverrideFromLedger,
  decideAutoMergeArm,
  decideArmFromLedgerVerdict,
  priorReviewVerdictFromLedger,
  type ReviewVerdict,
} from "./review.js";
import { armOutcomeArmed } from "./sweep.js";

// ── PRIVATE REST mirrors — see this file's own header for why these are duplicates ─────────────

/** Private mirror of run-task.ts's `prUrlTarget` (broad host/scheme match, `{owner,repo,number}`
 *  shape) — the parser {@link readHeadShaRest}/{@link isPrMergedNow} use, mirroring their
 *  pre-move behaviour exactly. */
function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } | undefined {
  const m = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(prUrl.trim());
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined;
}

/** Private mirror of run-task.ts's `prNumberFromRef` — used only by {@link logArmAttribution} and
 *  {@link attemptArm}'s hold check, both of which are always handed a full PR URL in production. */
function prNumberFromRef(ref: string): number | undefined {
  const urlMatch = ref.match(/\/pull\/(\d+)/);
  if (urlMatch) return Number(urlMatch[1]);
  const bareMatch = ref.match(/#?(\d+)/);
  return bareMatch ? Number(bareMatch[1]) : undefined;
}

/** Structural twin of run-task.ts's `FixRebaseMergeFacts` — a two-field REST reading with no
 *  behaviour of its own, restated here rather than imported (see this file's own header). */
interface ArmMergeFacts {
  mergeable?: string;
  behindBy?: number;
}

/** Private mirror of run-task.ts's `mergeFactsFromRest`. */
function mergeFactsFromRest(pr: unknown, compare: unknown): ArmMergeFacts {
  const p = (pr ?? {}) as { mergeable?: unknown; mergeable_state?: unknown };
  const c = (compare ?? {}) as { behind_by?: unknown };
  const mergeable =
    p.mergeable === false || p.mergeable_state === "dirty"
      ? "CONFLICTING"
      : p.mergeable === true
        ? "MERGEABLE"
        : "UNKNOWN";
  return {
    mergeable,
    behindBy: typeof c.behind_by === "number" ? c.behind_by : undefined,
  };
}

/** Private mirror of run-task.ts's `fixRebaseMergeFactsFromRest`. */
function fixRebaseMergeFactsFromRest(
  owner: string,
  repo: string,
  prNumber: number,
  fetch: GhApiFetcher = ghJson,
): ArmMergeFacts {
  try {
    const pr = fetch(["api", `repos/${owner}/${repo}/pulls/${prNumber}`]) as {
      base?: { ref?: string };
      head?: { sha?: string };
    };
    const base = pr?.base?.ref;
    const head = pr?.head?.sha;
    const compare = base && head ? fetch(["api", `repos/${owner}/${repo}/compare/${base}...${head}`]) : undefined;
    return mergeFactsFromRest(pr, compare);
  } catch {
    return {};
  }
}

/** Private mirror of run-task.ts's `ghUpdateBranchArgv`. */
function ghUpdateBranchArgv(owner: string, repo: string, prNumber: number): string[] {
  return ["api", "--method", "PUT", `repos/${owner}/${repo}/pulls/${prNumber}/update-branch`];
}

/** Private mirror of run-task.ts's `ghUpdateBranch`. */
function ghUpdateBranch(
  owner: string,
  repo: string,
  prNumber: number,
  exec: typeof execFileSync = execFileSync,
): { ok: boolean; error?: string } {
  assertLiveWriteAllowed("gh-pr-update-branch", `updating the base of ${owner}/${repo}#${prNumber}`);
  try {
    exec("gh", ghUpdateBranchArgv(owner, repo, prNumber), { stdio: "pipe" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** Private mirror of run-task.ts's `headShaRestArgs`. */
function headShaRestArgs(prUrl: string): string[] {
  const target = parsePrUrl(prUrl);
  if (!target) {
    throw new Error(
      `head-sha read: cannot resolve owner/repo/number from ${JSON.stringify(prUrl)} — refusing to fall back ` +
        "to `gh pr view --json`, whose GraphQL budget exhaustion is the defect this read was migrated off",
    );
  }
  return singlePrRestArgs(target.owner, target.repo, target.number);
}

/** Private mirror of run-task.ts's `readHeadShaRest`. */
function readHeadShaRest(prUrl: string, fetch: GhApiFetcher = ghJson): string {
  const sha = mapRestPr(fetch(headShaRestArgs(prUrl)) as RestPullRow).headRefOid;
  if (!sha) {
    throw new Error(`head-sha read: ${prUrl} returned no head sha — refusing to report an empty head`);
  }
  return sha;
}

// ── W1-T1255: the REST direct-merge write — moved here wholesale (its only caller was and is
// realArmDeps().mergeDirect) ─────────────────────────────────────────────────────────────────

/** W1-T1255: the argv for GitHub's own MERGE endpoint — the REST/core-budget twin of
 *  `gh pr merge --squash`, which is GraphQL. See run-task.ts's own `ghUpdateBranchArgv`, whose
 *  shape this copies deliberately: same `gh api --method PUT` mechanism, different endpoint. */
export function ghMergePrArgv(owner: string, repo: string, prNumber: number): string[] {
  return ["api", "--method", "PUT", `repos/${owner}/${repo}/pulls/${prNumber}/merge`, "-f", "merge_method=squash"];
}

/** W1-T1255: resolve the three REST path components out of a PR URL, or `undefined` when the URL
 *  is not one this parser understands. Used by both {@link mergeDirectViaRest} and
 *  {@link realArmDeps}'s `readMergeFacts`/`updateBranch` fields. */
export function mergeTargetFromPrUrl(prUrl: string): { owner: string; repo: string; prNumber: number } | undefined {
  const m = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], prNumber: Number(m[3]) } : undefined;
}

/** W1-T1255: the direct-merge WRITE itself — `gh api --method PUT .../merge`, NOT
 *  `gh pr merge --squash`. `exec` is injected LAST with a real default so no positional caller
 *  shifts, and so the argv and the refusal are unit-testable without a live pull request. */
export function mergeDirectViaRest(
  prUrl: string,
  exec: (file: string, args: string[], opts: { encoding: "utf8"; stdio: "pipe" }) => unknown = execFileSync,
): void {
  const target = mergeTargetFromPrUrl(prUrl);
  if (!target) {
    throw new Error(`W1-T1255: cannot resolve owner/repo/number from ${prUrl} — refusing to merge blind`);
  }
  exec("gh", ghMergePrArgv(target.owner, target.repo, target.prNumber), { encoding: "utf8", stdio: "pipe" });
}

/**
 * W1-T1050: true when GitHub reports `prUrl` as MERGED right now — the ground truth `attemptArm`
 * consults after a {@link ArmDeps.mergeDirect} throw, rather than trusting the exit code alone.
 *
 * FAIL-CLOSED ON A READ FAILURE, deliberately: a rate limit, network blip or unparsable URL
 * answers `false`. A merge that cannot be confirmed must not be reported as one — this can only
 * ever turn a `direct-merge-failed` into a `direct-merged`, never the other way, so a cautious
 * `false` here costs nothing beyond the pre-existing status quo.
 */
export function isPrMergedNow(prUrl: string, fetch: GhApiFetcher = ghJson): boolean {
  const target = parsePrUrl(prUrl);
  if (!target) return false;
  try {
    return liveStateFromRest(target.owner, target.repo, target.number, fetch) === "MERGED";
  } catch {
    return false;
  }
}

// ── W1-T2347: the seam-required guard ───────────────────────────────────────────────────────

/**
 * W1-T2347 — thrown by {@link requireExplicitArmSeam} rather than returning a sentinel: a
 * swallowed refusal would read as "the arm did nothing for some other reason", the same
 * false-confidence failure `LiveWriteBlockedError` (lib/live-write-guard.ts) already argues
 * against for the write leaves this complements.
 */
export class ArmSeamRequiredError extends Error {
  override name = "ArmSeamRequiredError";
  constructor(entryPoint: string) {
    super(
      `run-task: REFUSED to reach ${entryPoint}'s production arm dependency (realArmDeps()) under ` +
        `the node test runner — no seam was supplied. Reaching it performs a live REST head read ` +
        `and reads this machine's own config/ledger, unmocked, BEFORE the live-write guard's own ` +
        `write-leaf fence (assertLiveWriteAllowed) is ever consulted. Supply the seam this test ` +
        `needs — an \`arm\`/\`disarm\` override, or a narrowed ArmDeps passed to ${entryPoint} ` +
        `directly — or, if this suite deliberately drives the real dependency against its own ` +
        `containment, wrap that section in withLiveWritesAllowed(() => …) or set ` +
        `${LIVE_WRITE_OVERRIDE_ENV}=1 (both from src/lib/live-write-guard.ts).`,
    );
  }
}

/**
 * W1-T2347 — REACHING THE REAL AUTO-MERGE ARM FROM A TEST IS OPT-OUT RATHER THAN OPT-IN. See
 * this cluster's original run-task.ts header (preserved in git history) for the full rationale;
 * restated briefly: every entry point below defaults its whole `deps` parameter to
 * `realArmDeps()`, so a fixture that merely forgot to inject a seam was silently wired to the
 * PRODUCTION dependency. This closes it the NARROW way: gated on {@link isTestRunner}, so a
 * daemon/operator/CI process that is not `node --test` calls this and returns immediately —
 * production wiring never moves.
 */
export function requireExplicitArmSeam(
  entryPoint: string,
  seamSupplied: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (seamSupplied) return;
  if (!isTestRunner(env)) return;
  if (env[LIVE_WRITE_OVERRIDE_ENV] === "1") return;
  if (liveWritesExempt()) return;
  throw new ArmSeamRequiredError(entryPoint);
}

/**
 * W1-T2347 — a hidden marker {@link realArmDeps} stamps onto every object it returns, so the
 * four `deps: ArmDeps = realArmDeps()`-shaped entry points can tell "the caller omitted `deps`
 * (or explicitly forwarded the real one)" apart from "the caller supplied its own seam" WITHOUT
 * changing any of their signatures.
 */
const REAL_ARM_DEPS_MARKER: unique symbol = Symbol("run-task.realArmDeps");

/** True only for an object {@link realArmDeps} itself returned — never for a hand-built fixture,
 *  however complete, since no test has any reason to stamp this symbol onto one. */
function isRealArmDepsObject(deps: unknown): boolean {
  return typeof deps === "object" && deps !== null && (deps as Record<PropertyKey, unknown>)[REAL_ARM_DEPS_MARKER] === true;
}

/** Injectable side effects for {@link armAutoMerge} — exported so a behavioral test drives EVERY
 *  branch (incl. the clean-status direct-merge fallback) with fakes; the real defaults are the
 *  same gh calls the function always made. */
export interface ArmDeps {
  /** W1-T2347 — see {@link REAL_ARM_DEPS_MARKER}'s own doc. Optional and never set by a fixture. */
  [REAL_ARM_DEPS_MARKER]?: true;
  /** The PR's live head sha — read over REST, never `gh --json`. */
  headSha: (prUrl: string) => string;
  /** The ledger lines the W1-T230 verdict gate reads. */
  ledgerLines: () => Array<Record<string, unknown>>;
  /** `gh pr merge --auto --squash` — arms the deferred merge; throws on refusal. W1-T1111: NO
   *  `--delete-branch` (see the original ArmDeps.armAuto doc, preserved in git history, for why). */
  armAuto: (prUrl: string) => void;
  /** `gh pr merge --squash` — the clean-status completion. W1-T1050: NO `--delete-branch`. */
  mergeDirect: (prUrl: string) => void;
  /** `gh pr merge --disable-auto` — withdraws an early arm, W1-T125. */
  disableAuto: (prUrl: string) => void;
  /** W1-T1050: post-failure discriminator for a thrown {@link mergeDirect}. Optional; a caller
   *  that omits it keeps the pre-W1-T1050 fail-closed behavior (report `direct-merge-failed`). */
  isMerged?: (prUrl: string) => boolean;
  /** W1-T1280 — OPTIONAL. Fresh merge-facts reading for `prUrl`, over REST (never `--json`). */
  readMergeFacts?: (prUrl: string) => ArmMergeFacts;
  /** W1-T2855 — OPTIONAL companion to {@link readMergeFacts}. When both are present,
   *  {@link attemptArm} requires fresh merge facts before every direct-merge fallback and uses
   *  this existing REST update-branch write once when the PR is behind. */
  updateBranch?: (prUrl: string) => { ok: boolean; error?: string };
  /** W1-T1280 — OPTIONAL. Blocks the calling thread for `ms` between the bounded re-reads
   *  {@link readMergeFacts} above drives. */
  sleepSync?: (ms: number) => void;
  say: (msg: string) => void;
}

export function realArmDeps(
  // W1-T1000002: INJECTABLE, appended as the only parameter. The `[]`-on-failure contract in
  // `ledgerLines` below is the whole reason arming survives a host that cannot resolve a config.
  loadConfigImpl: typeof loadConfig = loadConfig,
): ArmDeps {
  return {
    [REAL_ARM_DEPS_MARKER]: true,
    headSha: (prUrl) => readHeadShaRest(prUrl),
    ledgerLines: () => {
      try {
        return readLedgerLines(ledgerPathFor(loadConfigImpl()));
      } catch {
        return [];
      }
    },
    armAuto: (prUrl) => {
      assertLiveWriteAllowed("gh-pr-merge", `arming auto-merge on ${prUrl}`);
      execFileSync("gh", ["pr", "merge", prUrl, "--auto", "--squash"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    },
    mergeDirect: (prUrl) => {
      assertLiveWriteAllowed("gh-pr-merge", `merging ${prUrl} directly`);
      mergeDirectViaRest(prUrl);
    },
    disableAuto: (prUrl) => {
      assertLiveWriteAllowed("gh-pr-merge", `disabling auto-merge on ${prUrl}`);
      execFileSync("gh", ["pr", "merge", prUrl, "--disable-auto"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    },
    isMerged: (prUrl) => isPrMergedNow(prUrl),
    readMergeFacts: (prUrl) => {
      const target = mergeTargetFromPrUrl(prUrl);
      return target ? fixRebaseMergeFactsFromRest(target.owner, target.repo, target.prNumber) : {};
    },
    updateBranch: (prUrl) => {
      const target = mergeTargetFromPrUrl(prUrl);
      if (!target) return { ok: false, error: `cannot resolve update-branch target from ${prUrl}` };
      return ghUpdateBranch(target.owner, target.repo, target.prNumber);
    },
    sleepSync: (ms) => {
      if (ms <= 0) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
    say: (msg) => console.log(msg),
  };
}

/** Terminal outcome of one arm attempt — returned so tests assert the branch taken. */
export type ArmOutcome =
  | "no-task-id"
  | "head-unavailable"
  | "ledger-refused"
  | "armed"
  | "direct-merged"
  | "direct-merge-failed"
  | "direct-merge-updated"
  | "direct-merge-preflight-refused"
  | "direct-merge-update-failed"
  | "arm-error-ignored"
  // W1-T947: {@link armAutoMergeAtOpen} refused because the diff is classified IRREVERSIBLE
  // (W1-T919) — the ONE outcome this file's arm sites can return that never went through
  // `attemptArm` at all.
  | "irreversible-refused"
  // W1-T1000002: {@link attemptArm} refused because an operator merge hold stands over this PR.
  | "hold-refused";

/**
 * W1-T1079: {@link attemptArm}'s outcome PLUS the raw failure text it captured, when there was
 * one.
 */
export interface ArmAttemptResult {
  outcome: ArmOutcome;
  error?: string;
  /** W1-T1235: set ONLY when the failure `error` carries was recognisably rate-limit-shaped. */
  rateLimit?: GhRateLimitRefusal;
  /** W1-T2855 — the fresh facts and remedy behind a direct-merge preflight outcome. */
  directMergePreflight?: DirectMergePreflightEvidence;
}

export interface DirectMergePreflightEvidence {
  priorHeadSha?: string;
  behindBy?: number;
  mergeable?: string;
  remedy: "direct-merge" | "update-branch" | "retry-later";
  error?: string;
}

export function armAutoMerge(
  prUrl: string,
  taskId: string | undefined,
  deps: ArmDeps = realArmDeps(),
): ArmOutcome {
  // W1-T2347: no guard call of its own — this is a thin forward, and whatever it hands
  // armAutoMergeDetailed is exactly what that function's OWN requireExplicitArmSeam check sees
  // and rules on. Two guard calls for one omission would be a second copy of the same rule.
  return armAutoMergeDetailed(prUrl, taskId, deps).outcome;
}

/**
 * W1-T1079: the SAME gate + attempt {@link armAutoMerge} runs, but returns the raw failure text
 * {@link attemptArm} captured alongside the outcome.
 */
export function armAutoMergeDetailed(
  prUrl: string,
  taskId: string | undefined,
  deps: ArmDeps = realArmDeps(),
): ArmAttemptResult {
  requireExplicitArmSeam("armAutoMergeDetailed", !isRealArmDepsObject(deps));
  if (!taskId) {
    deps.say(`automerge.ledger_refused (W1-T230): no task id resolvable for this PR — arming withheld: ${prUrl}`);
    return { outcome: "no-task-id" };
  }
  let headSha: string;
  try {
    headSha = deps.headSha(prUrl);
  } catch (e) {
    deps.say(
      `automerge.head_sha_unavailable (W1-T230): ${String((e as Error)?.message ?? e)} — arm withheld: ${prUrl}`,
    );
    return { outcome: "head-unavailable" };
  }
  // ONE ledger read feeds both the verdict and its override.
  const ledgerLines = deps.ledgerLines();
  const prior = priorReviewVerdictFromLedger(ledgerLines, taskId);
  const override = prior?.capped ? cappedOverrideFromLedger(ledgerLines, taskId, headSha) : undefined;
  const decision = decideArmFromLedgerVerdict(prior, headSha, override);
  if (!decision.arm) {
    deps.say(`automerge.ledger_refused (W1-T230): ${decision.reason} — ${prUrl}`);
    return { outcome: "ledger-refused" };
  }
  return attemptArm(prUrl, deps, headSha);
}

/**
 * The shared `gh pr merge --auto` attempt + clean-status-direct-merge fallback — factored out
 * (W1-T125) so both the ledger-gated {@link armAutoMerge} and the ungated {@link
 * armAutoMergeAtOpen} share the EXACT same completion logic rather than duplicating it.
 */
type DirectMergePreflightDeps = Pick<ArmDeps, "say"> &
  Partial<Pick<ArmDeps, "headSha" | "readMergeFacts" | "updateBranch">>;

type DirectMergePreflightDecision =
  | { proceed: true; evidence?: DirectMergePreflightEvidence }
  | { proceed: false; result: ArmAttemptResult };

/**
 * W1-T2855 — the one gate every direct REST merge in {@link attemptArm} crosses immediately
 * before its write.
 */
function directMergePreflight(
  prUrl: string,
  deps: DirectMergePreflightDeps,
  priorHeadSha?: string,
  context: Pick<ArmAttemptResult, "error" | "rateLimit"> = {},
): DirectMergePreflightDecision {
  if (!deps.readMergeFacts || !deps.updateBranch) return { proceed: true };

  let observedHead = priorHeadSha;
  if (observedHead === undefined && deps.headSha) {
    try {
      observedHead = deps.headSha(prUrl);
    } catch (e) {
      const headRead = { error: String((e as Error)?.message ?? e) };
      deps.say(
        `automerge.direct_merge_preflight_head_unavailable (W1-T2855): ` +
          `${headRead.error} — refusing an unattributable direct merge: ${prUrl}`,
      );
      return {
        proceed: false,
        result: {
          outcome: "direct-merge-preflight-refused",
          ...context,
          directMergePreflight: { remedy: "retry-later", error: headRead.error },
        },
      };
    }
  }
  let facts: ArmMergeFacts;
  let readError: string | undefined;
  try {
    facts = deps.readMergeFacts(prUrl);
  } catch (e) {
    const failedRead = { error: String((e as Error)?.message ?? e) };
    facts = {};
    readError = failedRead.error;
  }
  const baseEvidence = {
    ...(observedHead !== undefined ? { priorHeadSha: observedHead } : {}),
    ...(facts.behindBy !== undefined ? { behindBy: facts.behindBy } : {}),
    ...(facts.mergeable !== undefined ? { mergeable: facts.mergeable } : {}),
  };
  const behindIsConsistent = Number.isInteger(facts.behindBy) && Number(facts.behindBy) >= 0;

  if (facts.mergeable !== "MERGEABLE" || !behindIsConsistent) {
    const directMergePreflight: DirectMergePreflightEvidence = {
      ...baseEvidence,
      remedy: "retry-later",
      ...(readError !== undefined ? { error: readError } : {}),
    };
    deps.say(
      `automerge.direct_merge_preflight_refused (W1-T2855): mergeability=${String(facts.mergeable)} ` +
        `behind_by=${String(facts.behindBy)} — fresh facts are unreadable, unknown, conflicting, or inconsistent; ` +
        `left unmerged for a later pass: ${prUrl}`,
    );
    return {
      proceed: false,
      result: { outcome: "direct-merge-preflight-refused", ...context, directMergePreflight },
    };
  }

  if (facts.behindBy === 0) {
    return { proceed: true, evidence: { ...baseEvidence, remedy: "direct-merge" } };
  }

  let update: { ok: boolean; error?: string };
  try {
    update = deps.updateBranch(prUrl);
  } catch (e) {
    update = { ok: false, error: String((e as Error)?.message ?? e) };
  }
  const directMergePreflight: DirectMergePreflightEvidence = {
    ...baseEvidence,
    remedy: "update-branch",
    ...(update.error !== undefined ? { error: update.error } : {}),
  };
  if (!update.ok) {
    deps.say(
      `automerge.direct_merge_update_failed (W1-T2855): behind_by=${facts.behindBy}; ` +
        `${update.error ?? "update-branch returned ok=false"} — left unmerged: ${prUrl}`,
    );
    return {
      proceed: false,
      result: { outcome: "direct-merge-update-failed", ...context, directMergePreflight },
    };
  }

  deps.say(
    `automerge.direct_merge_updated (W1-T2855): prior_head=${observedHead ?? "unknown"} ` +
      `behind_by=${facts.behindBy} — updated once; awaiting fresh checks and review: ${prUrl}`,
  );
  return {
    proceed: false,
    result: { outcome: "direct-merge-updated", ...context, directMergePreflight },
  };
}

/**
 * W1-T1280 — TRUE only when a REST merge refusal names the specific status GitHub returns for a
 * pull request whose mergeability it has not (or no longer) computed as definitely conflicting:
 * HTTP 405.
 */
export function mergeDirectRefusalMayBeUnsettled(stderrText: string): boolean {
  return /\bHTTP 405\b/.test(stderrText);
}

/** W1-T1280 — BACKSTOP (W1-T1266): the FIRST 405 plus up to this many re-reads. */
export const REST_MERGE_UNSETTLED_MAX_READS = 3;

/** W1-T1280 — the short interval between one `UNKNOWN` re-read and the next. */
export const REST_MERGE_UNSETTLED_RETRY_INTERVAL_MS = 2_000;

export function attemptArm(
  prUrl: string,
  deps: Pick<ArmDeps, "armAuto" | "mergeDirect" | "isMerged" | "say"> &
    Partial<Pick<ArmDeps, "headSha" | "ledgerLines" | "readMergeFacts" | "updateBranch" | "sleepSync">>,
  priorHeadSha?: string,
): ArmAttemptResult {
  // MERGE (W1-T1000002 x W1-T1079): every caller reads one type.
  const holdLedgerLines = deps.ledgerLines?.();
  if (holdLedgerLines) {
    const prNumber = prNumberFromRef(prUrl);
    const hold = prNumber !== undefined ? automergeHoldFromLedger(holdLedgerLines, prNumber) : undefined;
    if (hold) {
      deps.say(
        `automerge.hold_refused (W1-T1000002): operator hold engaged by ${hold.by} (${hold.reason}) — ` +
          `arm withheld: ${prUrl}`,
      );
      return { outcome: "hold-refused" };
    }
  }
  try {
    deps.armAuto(prUrl);
    return { outcome: "armed" };
  } catch (e) {
    const msg = String((e as { stderr?: unknown })?.stderr ?? (e as Error)?.message ?? e);
    // GitHub REFUSES to enable auto-merge on an ALREADY-mergeable PR ("Pull request is in clean
    // status"): every SWEEP-armed PR can land in exactly that state, so the fallback below
    // completes the merge outright rather than treating the refusal as a no-op.
    if (armFailureAction(msg) === "direct-merge") {
      const preflight = directMergePreflight(prUrl, deps, priorHeadSha);
      if (!preflight.proceed) return preflight.result;
      try {
        deps.mergeDirect(prUrl);
        deps.say(`automerge.clean_status_direct_merge (already green — merged now): ${prUrl}`);
        return { outcome: "direct-merged", directMergePreflight: preflight.evidence };
      } catch (e2) {
        const msg2 = String((e2 as { stderr?: unknown })?.stderr ?? (e2 as Error)?.message ?? e2);
        // W1-T1050: a merge that landed must never be reported as a failed one.
        if (deps.isMerged?.(prUrl)) {
          deps.say(
            `automerge.clean_status_direct_merge (merge landed; a post-merge step failed: ${msg2}): ${prUrl}`,
          );
          return { outcome: "direct-merged", directMergePreflight: preflight.evidence };
        }
        deps.say(`automerge.direct_merge_failed: ${msg2} — ${prUrl}`);
        return { outcome: "direct-merge-failed", directMergePreflight: preflight.evidence };
      }
    }
    // W1-T1255: THE QUOTA FALLBACK. `armFailureIsRateLimited` (W1-T1235) is the ONLY trigger for
    // this second attempt — never `armFailureAction`'s wider `"transient"`, which also matches an
    // ordinary network blip. Arming is still attempted first, every time; this runs only after
    // that attempt has already failed.
    const quota = armFailureIsRateLimited(msg) ? ghRateLimitRefusalUnknown("gh pr merge --auto") : undefined;
    if (quota) {
      deps.say(
        `automerge.rate_limit_refused (W1-T1235): GitHub rate-limit budget exhausted (bucket: ` +
          `${quota.bucket}, resets: ${quota.resetsAt}) — ${msg} — ${prUrl}`,
      );
      const preflight = directMergePreflight(prUrl, deps, priorHeadSha, { error: msg, rateLimit: quota });
      if (!preflight.proceed) return preflight.result;
      try {
        deps.mergeDirect(prUrl);
        deps.say(`automerge.rate_limited_rest_merge (W1-T1255; arm refused on quota, PR already green): ${prUrl}`);
        return { outcome: "direct-merged", error: msg, rateLimit: quota, directMergePreflight: preflight.evidence };
      } catch (e3) {
        let msg3 = String((e3 as { stderr?: unknown })?.stderr ?? (e3 as Error)?.message ?? e3);
        if (deps.isMerged?.(prUrl)) {
          deps.say(`automerge.rate_limited_rest_merge (merge landed; a post-merge step failed: ${msg3}): ${prUrl}`);
          return { outcome: "direct-merged", error: msg, rateLimit: quota, directMergePreflight: preflight.evidence };
        }
        // W1-T1280: THE RETRY. `deps.readMergeFacts` is OPTIONAL — absent, this block is skipped
        // byte-for-byte and the refusal below is unchanged from W1-T1255.
        if (deps.readMergeFacts && mergeDirectRefusalMayBeUnsettled(msg3)) {
          for (let read = 1; read <= REST_MERGE_UNSETTLED_MAX_READS; read++) {
            const facts = deps.readMergeFacts(prUrl);
            if (facts.mergeable === "CONFLICTING") {
              deps.say(
                `automerge.rate_limited_rest_merge_conflict (W1-T1280): mergeFactsFromRest settled ` +
                  `CONFLICTING on read ${read}/${REST_MERGE_UNSETTLED_MAX_READS} — ${prUrl}`,
              );
              break;
            }
            if (facts.mergeable === "MERGEABLE") {
              deps.say(
                `automerge.rate_limited_rest_merge_retry (W1-T1280): mergeFactsFromRest settled ` +
                  `MERGEABLE on read ${read}/${REST_MERGE_UNSETTLED_MAX_READS} — retrying: ${prUrl}`,
              );
              const retryPreflight = directMergePreflight(prUrl, deps, priorHeadSha, {
                error: msg,
                rateLimit: quota,
              });
              if (!retryPreflight.proceed) return retryPreflight.result;
              try {
                deps.mergeDirect(prUrl);
                deps.say(
                  `automerge.rate_limited_rest_merge (W1-T1255; settled mergeable on retry ${read}): ${prUrl}`,
                );
                return {
                  outcome: "direct-merged",
                  error: msg,
                  rateLimit: quota,
                  directMergePreflight: retryPreflight.evidence,
                };
              } catch (e4) {
                msg3 = String((e4 as { stderr?: unknown })?.stderr ?? (e4 as Error)?.message ?? e4);
                if (deps.isMerged?.(prUrl)) {
                  deps.say(
                    `automerge.rate_limited_rest_merge (merge landed; a post-merge step failed: ${msg3}): ${prUrl}`,
                  );
                  return {
                    outcome: "direct-merged",
                    error: msg,
                    rateLimit: quota,
                    directMergePreflight: retryPreflight.evidence,
                  };
                }
              }
              break; // ONE retry attempt once settled MERGEABLE (design note ii) — never a second.
            }
            if (read < REST_MERGE_UNSETTLED_MAX_READS) {
              deps.sleepSync?.(REST_MERGE_UNSETTLED_RETRY_INTERVAL_MS);
            }
          }
        }
        deps.say(`automerge.rate_limited_rest_merge_refused (W1-T1255): ${msg3} — ${prUrl}`);
      }
      return { outcome: "arm-error-ignored", error: msg, rateLimit: quota };
    }
    deps.say(`automerge.arm_error_ignored (W1-T1079, ${armFailureAction(msg)}): ${msg} — ${prUrl}`);
    return { outcome: "arm-error-ignored", error: msg };
  }
}

/**
 * W1-T125: arm auto-merge the INSTANT a run's own PR opens — deliberately UNGATED by any ledger
 * verdict, because none can possibly exist yet.
 */
export function armAutoMergeAtOpen(
  prUrl: string,
  deps: (Pick<ArmDeps, "armAuto" | "mergeDirect" | "isMerged" | "say"> &
    Partial<Pick<ArmDeps, "headSha" | "ledgerLines" | "readMergeFacts" | "updateBranch" | "sleepSync">>) = realArmDeps(),
  irreversible = false,
): ArmOutcome {
  requireExplicitArmSeam("armAutoMergeAtOpen", !isRealArmDepsObject(deps));
  if (irreversible) {
    deps.say(
      `automerge.irreversible_refused (W1-T919/W1-T947): diff classified irreversible — refusing to ` +
        `arm at open; an operator must review and merge this manually: ${prUrl}`,
    );
    return "irreversible-refused";
  }
  return attemptArm(prUrl, deps).outcome;
}

/**
 * W1-T125: best-effort withdrawal of an early {@link armAutoMergeAtOpen} — `gh pr merge
 * --disable-auto`.
 */
export type DisarmOutcome = "disarmed" | "not-armed" | "lost-race" | "failed";

/**
 * W1-T1056 — PURE classifier for a failed `gh pr merge --disable-auto` (exported for test).
 * FAILS TOWARDS `"failed"`, DELIBERATELY: an error this does not recognise is NOT evidence the
 * PR was unarmed.
 */
export function classifyDisarmFailure(
  stderrText: string,
  merged?: boolean,
): "not-armed" | "lost-race" | "failed" {
  if (!/can't disable auto-merge|disablePullRequestAutoMerge/i.test(stderrText)) return "failed";
  return merged === true ? "lost-race" : "not-armed";
}

/**
 * W1-T1056 — did a withdrawal ACTUALLY happen? The one predicate every call site branches on,
 * mirroring `armOutcomeArmed` (lib/sweep.ts) rather than inventing a second rule.
 */
export function disarmOutcomeWithdrawn(outcome: DisarmOutcome | void): boolean {
  if (outcome === undefined) return true;
  return outcome === "disarmed";
}

export function disarmAutoMerge(
  prUrl: string,
  deps: Pick<ArmDeps, "disableAuto" | "say"> & Partial<Pick<ArmDeps, "isMerged">> = realArmDeps(),
): DisarmOutcome {
  requireExplicitArmSeam("disarmAutoMerge", !isRealArmDepsObject(deps));
  try {
    deps.disableAuto(prUrl);
    deps.say(`automerge.disarmed (W1-T125): early arm withdrawn — ${prUrl}`);
    return "disarmed";
  } catch (e) {
    const msg = String((e as { stderr?: unknown })?.stderr ?? (e as Error)?.message ?? e);
    deps.say(`automerge.disarm_failed (W1-T125): ${msg} — ${prUrl}`);
    return classifyDisarmFailure(msg, deps.isMerged?.(prUrl));
  }
}

/**
 * WHICH CALL SITE ARMED. A UNION rather than a bare `string`: a sweep-armed merge and a
 * hand-armed merge are TOLD APART on the ledger, and a mistyped `"sweeep"` would produce a
 * confidently wrong answer that no gate here catches.
 */
export type ArmLane = "review" | "operator" | "sweep";

/**
 * W1-T1052 — TRUE for the two {@link ArmOutcome} values that mean an arm was genuinely ATTEMPTED
 * and did not stick.
 */
function armOutcomeAttemptedAndFailed(outcome: ArmOutcome | "skipped"): boolean {
  return outcome === "direct-merge-failed" || outcome === "direct-merge-update-failed" || outcome === "arm-error-ignored";
}

/**
 * W1-T1052 — THE STEP NAME A NON-ARMING OUTCOME IS FILED UNDER.
 */
function armSkipStepName(outcome: ArmOutcome | "skipped"): string {
  return armOutcomeAttemptedAndFailed(outcome) ? "automerge.arm_failed" : "automerge.arm_skipped";
}

/**
 * W1-T449 — THE ONE PLACE an arm/merge site's LEDGER LINE gains PR identity + lane. Exported so
 * `run-task.ts`'s own `armAndLogOutcome` (which stays there — it wraps this cluster rather than
 * belonging to it) can call the SAME attribution logic every arm site uses.
 */
export function logArmAttribution(
  log: (step: string, extra?: Record<string, unknown>) => void,
  outcome: ArmOutcome,
  prUrl: string,
  taskId: string | undefined,
  lane: ArmLane,
  extra: Record<string, unknown> = {},
  rateLimit?: GhRateLimitRefusal,
  directMergePreflight?: DirectMergePreflightEvidence,
): void {
  const prNumber = prNumberFromRef(prUrl);
  const ghFields = rateLimit
    ? { gh_bucket: rateLimit.bucket, gh_bucket_resets_at: rateLimit.resetsAt, gh_bucket_operation: rateLimit.operation }
    : {};
  const preflightFields = directMergePreflight
    ? {
        ...(directMergePreflight.priorHeadSha !== undefined ? { prior_head_sha: directMergePreflight.priorHeadSha } : {}),
        ...(directMergePreflight.behindBy !== undefined ? { behind_by: directMergePreflight.behindBy } : {}),
        ...(directMergePreflight.mergeable !== undefined ? { mergeability: directMergePreflight.mergeable } : {}),
        remedy: directMergePreflight.remedy,
        ...(directMergePreflight.error !== undefined ? { remedy_error: directMergePreflight.error } : {}),
      }
    : {};
  log(armOutcomeArmed(outcome) ? "automerge.armed" : armSkipStepName(outcome), {
    ...extra,
    ...ghFields,
    ...preflightFields,
    task_id: taskId,
    pr_number: prNumber,
    pr_url: prUrl,
    lane,
  });
  if (outcome === "direct-merged") {
    log("automerge.clean_status_direct_merge", {
      task_id: taskId,
      pr_number: prNumber,
      pr_url: prUrl,
      lane,
      ...preflightFields,
    });
  }
  const preflightStep =
    outcome === "direct-merge-updated"
      ? "automerge.direct_merge_updated"
      : outcome === "direct-merge-preflight-refused"
        ? "automerge.direct_merge_preflight_refused"
        : outcome === "direct-merge-update-failed"
          ? "automerge.direct_merge_update_failed"
          : undefined;
  if (preflightStep) {
    log(preflightStep, { task_id: taskId, pr_number: prNumber, pr_url: prUrl, lane, ...preflightFields });
  }
  if (rateLimit) {
    log("automerge.rate_limit_refused", { task_id: taskId, pr_number: prNumber, pr_url: prUrl, lane, ...ghFields });
  }
}

export function armIfVerdictPermits(
  verdict: Pick<ReviewVerdict, "state" | "capped" | "planOnly">,
  ctx: {
    prUrl: string;
    taskId: string;
    headSha: string;
    ledgerPath: string;
    headRefName?: string;
    log: (step: string, extra?: Record<string, unknown>) => void;
  },
  deps: {
    arm?: (prUrl: string, taskId: string) => ArmOutcome | ArmAttemptResult;
    ledgerLines?: () => Array<Record<string, unknown>>;
  } = {},
): ArmOutcome | "skipped" {
  if (ctx.headRefName?.startsWith("dependabot/")) {
    ctx.log("automerge.arm_skipped", { reason: "dependabot PR — the dep-review lane owns arming for these", head_sha: ctx.headSha });
    return "skipped";
  }
  const override = verdict.capped
    ? cappedOverrideFromLedger(
        (deps.ledgerLines ?? (() => readLedgerLines(ctx.ledgerPath)))(),
        ctx.taskId,
        ctx.headSha,
      )
    : undefined;
  const decision = decideAutoMergeArm(verdict, false, override);
  if (!decision.arm) {
    ctx.log("automerge.arm_skipped", {
      outcome: "skipped",
      reason: decision.reason,
      decision_reason: decision.reason,
      head_sha: ctx.headSha,
      task_id: ctx.taskId,
    });
    return "skipped";
  }
  // W1-T230's own gate still applies inside: it re-reads the live head and refuses a stale
  // verdict. Its OUTCOME is read (impl-BC) rather than discarded, so a refusal is visible.
  const result = (deps.arm ?? armAutoMergeDetailed)(ctx.prUrl, ctx.taskId);
  const outcome = typeof result === "string" ? result : result.outcome;
  const error = typeof result === "string" ? undefined : result.error;
  const rateLimit = typeof result === "string" ? undefined : result.rateLimit;
  const directMergePreflight = typeof result === "string" ? undefined : result.directMergePreflight;
  logArmAttribution(
    ctx.log,
    outcome,
    ctx.prUrl,
    ctx.taskId,
    "review",
    {
      outcome,
      reason: armOutcomeReason(outcome, decision.reason),
      decision_reason: decision.reason,
      head_sha: ctx.headSha,
      ...(error !== undefined ? { error } : {}),
    },
    rateLimit,
    directMergePreflight,
  );
  return outcome;
}

/**
 * impl-BL — the `reason` an `automerge.*` ledger line carries, derived from the OUTCOME that
 * actually occurred rather than from the semantic gate that merely permitted the attempt.
 */
export function armOutcomeReason(outcome: ArmOutcome | "skipped", decisionReason: string): string {
  switch (outcome) {
    case "armed":
      return decisionReason;
    case "direct-merged":
      return `${decisionReason} — GitHub refused --auto on an already-clean PR, so the clean-status fallback merged it outright`;
    case "ledger-refused":
      return "the W1-T230 ledger gate refused: no `review.posted` line for this task matched the PR's current head (see the automerge.ledger_refused console line for which branch)";
    case "no-task-id":
      return "no task id was resolvable for this PR, so the W1-T230 ledger gate had no key to look the verdict up by";
    case "head-unavailable":
      return "the PR's current head could not be read, so the arm was withheld rather than applied to an unknown head";
    case "direct-merge-failed":
      return "GitHub refused --auto as already-clean and the direct-merge fallback then failed";
    case "direct-merge-updated":
      return "the direct-merge preflight found the PR behind current main, updated its branch once, and left it for fresh checks and review";
    case "direct-merge-preflight-refused":
      return "fresh REST mergeability/base-distance facts were unreadable, unknown, conflicting, or inconsistent, so the direct merge failed closed";
    case "direct-merge-update-failed":
      return "the direct-merge preflight found the PR behind current main, but GitHub refused or failed the update-branch remedy; it remains unmerged";
    case "arm-error-ignored":
      return "`gh pr merge --auto` failed for a reason that is not the clean-status case — see this row's `error` field for what gh actually said; left for the next sweep pass";
    case "irreversible-refused":
      return "the diff was classified IRREVERSIBLE (W1-T919/W1-T947) — auto-merge refuses regardless of verdict; an operator must arm this manually";
    case "hold-refused":
      return "an operator merge hold (W1-T1000002) stands over this PR — auto-merge refuses regardless of verdict; only an explicit release lifts it";
    case "skipped":
      return "the semantic gate refused before any arm was attempted";
  }
}

/**
 * PURE classifier for a failed `gh pr merge --auto` (exported for test): the "clean status"
 * class means the PR was ALREADY fully mergeable.
 */
export function armFailureAction(stderrText: string): "direct-merge" | "transient" | "retryable" | "unknown" {
  if (/clean status/i.test(stderrText)) return "direct-merge";
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|secondary rate limit|rate.limit|abuse detection|too many requests|5\d\d\b|GraphQL: (?:Something went wrong|Server Error)/i.test(
    stderrText,
  )) {
    return "transient";
  }
  if (/base branch was modified/i.test(stderrText)) return "retryable";
  return "unknown";
}

/**
 * W1-T1235 — narrower than {@link armFailureAction}'s `"transient"` bucket: TRUE only for the
 * rate-limit/abuse-detection signatures within it.
 */
export function armFailureIsRateLimited(stderrText: string): boolean {
  return /secondary rate limit|rate.limit|abuse detection|too many requests/i.test(stderrText);
}
