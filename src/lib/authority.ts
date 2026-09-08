/**
 * lib/authority.ts — W1-T2695: what the fleet may do without the operator, in one place.
 *
 * THE QUESTION THIS ANSWERS. "What can this thing do to my repo overnight?" The answer was true
 * and scattered: `armAutoMergeAtOpen` arms at PR-open with no verdict gate (W1-T489's documented
 * asymmetry); `armAutoMerge` arms after CI is green behind two ledger gates; `openPlanPr` opens
 * ratification PRs only when an operator names a proposal to `rmd approve`; `postReviewStatus`
 * writes commit statuses; auto-triage and the dispatch/reservation lanes push internal
 * coordination refs; the fleet-control pause ref is the one write in this table an operator
 * issues directly. Every one of these is gated somewhere; no single surface listed the gates
 * together. This module is that surface, derived from source rather than hand-maintained prose
 * (W1-T2266 measured every prose inventory in this repo going stale within weeks).
 */

/**
 * WHAT "THE GATEWAY MODULES" TURNED OUT TO BE (read before trusting this task's own filing
 * rationale — CLAUDE.md's standing rule to verify the installed code over an inherited claim).
 * The filing rationale names `src/lib/open-prs-rest.ts` and `src/lib/github-app.ts` as "the
 * closed set of write methods on the GitHub gateway". Measured at this module's own HEAD:
 * `open-prs-rest.ts` is REST-read-only by its own module header ("The sweep's open-PR
 * enumeration, over REST only") and contains zero `method:`/`-X` write verbs; `github-app.ts`
 * contains exactly one (`refreshInstallationToken`'s token-exchange POST, an internal auth call,
 * not a repo-content write). Neither file is where `armAutoMerge`, `openPlanPr`,
 * `postReviewStatus`, the escalation issue-filer, or any push actually live. The real, closed,
 * already-coded enumeration of outward GitHub/git effects is `src/lib/live-write-guard.ts`'s
 * `LiveWriteBoundary` union plus its `assertLiveWriteAllowed` call sites — built by recon-AQ for
 * exactly this purpose ("the four outward effects reaching the live repo") — WIDENED here to the
 * gh REST write-verb argv shapes (`-X POST/PATCH/PUT/DELETE`, `pr create|merge|comment|close`,
 * `issue create|close`) and raw `git push` argv literals that the guard does not (yet) wrap.
 * `test/authority-ratchet.test.ts` enumerates from source, not from this paragraph's claim.
 */

/**
 * WHAT DOES NOT CHANGE (design note v). No gate moves, no action gains or loses authority. Two
 * rows below (`post-review-status`/`post-review-pr-comment`, `triage-claim-ref-push`) name real
 * gaps — a write with no `assertLiveWriteAllowed` guard at all — because the report's job is to
 * describe what exists, including a gap, never to quietly close one.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Policy } from "./policy.js";
import type { LedgerUnionResult } from "./ledger-grep.js";

/** What decides whether a row's write fires. Closed vocabulary — design note (i). */
export type AuthorityGateKind = "policy" | "ledger-verdict" | "operator-verb" | "always";

/**
 * The kind of external write a row performs. A superset of {@link
 * import("./live-write-guard.js").LiveWriteBoundary} — that union covers only the five effects
 * `assertLiveWriteAllowed` already wraps; several real writes below (status posts, PR comments,
 * job reruns, internal coordination-ref pushes) are not wrapped by it today, and this table names
 * them rather than omitting them because they fall outside that narrower vocabulary.
 */
export type AuthorityBoundary =
  | "gh-pr-create"
  | "gh-pr-merge"
  | "gh-pr-update-branch"
  | "gh-pr-comment"
  | "gh-pr-close"
  | "gh-pr-body-patch"
  | "gh-issue-create"
  | "gh-issue-close"
  | "gh-issue-comment"
  | "gh-status-post"
  | "gh-job-rerun"
  | "git-push";

/** One row: one named external write, the module+symbol that performs it, and its gate. */
export interface AuthorityRow {
  /** Stable, unique, kebab-case — the ratification-pin key and the report's join key. */
  id: string;
  /** One sentence: what this write does. */
  action: string;
  /** Repo-relative path of the module performing the write (git-ls-files spelling). */
  module: string;
  /** The symbol (function/closure) that performs it, as a reader would look it up. */
  symbol: string;
  boundary: AuthorityBoundary;
  gate: AuthorityGateKind;
  /**
   * Dotted path into `Policy.values` this gate reads, when the gate itself is (or partially
   * narrows on) a policy row. Absent when nothing in plan/policy.yaml governs this write.
   */
  policyField?: string;
  /**
   * Ledger step name(s) that record this action firing, enumerated from a literal grep of this
   * write's own call path — never guessed (a guessed step name is indistinguishable from an
   * absent event, and reads false zeros). Empty when no dedicated step exists yet: an honest
   * gap, reported as `"unmapped"`, never silently treated as `"never"`.
   */
  ledgerSteps: string[];
  /** The `rmd <verb>` (or process entry point) that reaches this write. */
  verb: string;
  /** Caveats, the W1-T that shaped this row's gate, or why it is classified as it is. */
  note: string;
}

/**
 * THE TABLE. One row per external write named in `test/authority-ratchet.test.ts`'s source
 * enumeration — every tracked `src/**\/*.ts` file (excluding this module and the guard itself)
 * carrying an `assertLiveWriteAllowed(` call, a `gh api -X POST/PATCH/PUT/DELETE` argv, a
 * `gh pr|issue create/merge/comment/close` argv, or a raw `["push"` argv, must appear here by
 * `module`. The baseline is empty: every write measured at this task's own HEAD is entered below.
 */
export const AUTHORITY_TABLE: readonly AuthorityRow[] = [
  // ── src/lib/arm-auto-merge.ts (W1-T2887: moved from src/run-task.ts, which still imports and
  // re-exports every symbol below so every verb/call site is unchanged) ───────────────────────
  {
    id: "arm-auto-merge-at-open",
    action: "arm `gh pr merge --auto --squash` on a freshly opened task PR, before any review verdict",
    module: "src/lib/arm-auto-merge.ts",
    symbol: "armAutoMergeAtOpen",
    boundary: "gh-pr-merge",
    gate: "always",
    ledgerSteps: ["automerge.armed", "automerge.arm_failed", "automerge.arm_skipped", "automerge.hold_refused"],
    verb: "rmd run-task / rmd drain",
    note:
      "W1-T489's documented asymmetry: fires ~16s after PR-open consulting NO review verdict. Refuses only on an " +
      "irreversible diff (W1-T919/W1-T947) or a standing operator merge hold (automergeHoldFromLedger, W1-T1000002).",
  },
  {
    id: "arm-auto-merge-ledger-gated",
    action: "arm `gh pr merge --auto --squash` after CI is green and a ledgered review verdict permits it",
    module: "src/lib/arm-auto-merge.ts",
    symbol: "armAutoMerge / armAutoMergeDetailed",
    boundary: "gh-pr-merge",
    gate: "ledger-verdict",
    policyField: "armCalibrationBands",
    ledgerSteps: ["automerge.armed", "automerge.arm_failed"],
    verb: "rmd review <pr> (armIfVerdictPermits)",
    note:
      "decideArmFromLedgerVerdict (lib/review.ts) refuses without a ledgered review.posted verdict for the CURRENT " +
      "head sha (a push invalidates a prior verdict); decideAutoMergeArm then bands the verdict class against " +
      "plan/policy.yaml's armCalibrationBands.",
  },
  {
    id: "disarm-auto-merge",
    action: "withdraw a standing `--auto` arm with `gh pr merge --disable-auto`",
    module: "src/lib/arm-auto-merge.ts",
    symbol: "realArmDeps().disableAuto",
    boundary: "gh-pr-merge",
    gate: "always",
    ledgerSteps: ["automerge.disarmed", "automerge.disarm_skipped"],
    verb: "rmd run-task / rmd drain (attemptArm's own capped-refusal branch)",
    note: "W1-T125: withdraws an arm that failed for a capped reason. Never independently operator-invoked.",
  },
  {
    id: "arm-direct-merge-fallback",
    action: "merge a PR directly (`gh pr merge --squash`, no `--auto`) when GitHub already reports it clean-mergeable",
    module: "src/lib/arm-auto-merge.ts",
    symbol: "realArmDeps().mergeDirect (attemptArm's clean-status fallback)",
    boundary: "gh-pr-merge",
    gate: "always",
    ledgerSteps: ["automerge.clean_status_direct_merge"],
    verb: "rmd run-task / rmd drain",
    note:
      "W1-T1050: reached only from inside attemptArm, whose caller (armAutoMergeAtOpen or the ledger-gated " +
      "armAutoMerge) already decided to attempt the arm; this fallback adds no gate of its own. No --delete-branch.",
  },
  {
    id: "update-branch-on-arm",
    action: "REST PUT a PR's `update-branch` endpoint to bring a mergeable-but-behind head current before merging",
    module: "src/lib/arm-auto-merge.ts",
    symbol: "ArmDeps.updateBranch -> (private) ghUpdateBranch",
    boundary: "gh-pr-update-branch",
    gate: "always",
    ledgerSteps: ["automerge.direct_merge_updated", "automerge.direct_merge_update_failed", "automerge.direct_merge_preflight_refused"],
    verb: "rmd run-task / rmd drain",
    note:
      "W1-T2855: directMergePreflight requires a definitely-MERGEABLE head that compare evidence shows behind base. " +
      "W1-T2887: this is now a PRIVATE mirror of run-task.ts's own (still public) ghUpdateBranch, not a shared " +
      "function — a lib module may not import run-task.ts (dependency-cruiser lib-no-spike-or-cli).",
  },
  // ── src/run-task.ts ──────────────────────────────────────────────────────────────────────
  {
    id: "open-task-pr",
    action: "open the PR for a completed task run (plan/triage/retro/implement)",
    module: "src/run-task.ts",
    symbol: "ghPrCreateFillCommand",
    boundary: "gh-pr-create",
    gate: "always",
    ledgerSteps: ["pr.opened"],
    verb: "rmd run-task / rmd drain / rmd plan",
    note: "The one shared argv builder every task-completion PR-open call reaches, so the guard covers all four callers at once.",
  },
  {
    id: "open-ratification-pr-single",
    action: "open the PR that ratifies one plan proposal into a filed task",
    module: "src/run-task.ts",
    symbol: "openPlanPr (approveCommand)",
    boundary: "gh-pr-create",
    gate: "operator-verb",
    ledgerSteps: ["pr.opened"],
    verb: "rmd approve <P##>",
    note: "Fires only when an operator names a proposal id; never autonomous.",
  },
  {
    id: "open-ratification-pr-batch",
    action: "open one PR that ratifies several named plan proposals together",
    module: "src/run-task.ts",
    symbol: "openPlanPr (approveBatchCommand)",
    boundary: "gh-pr-create",
    gate: "operator-verb",
    ledgerSteps: ["pr.opened"],
    verb: "rmd approve <P1> <P2> ...",
    note: "approveCommand refuses an unnamed batch — the operator must name every id, never an implicit \"approve everything ready\".",
  },
  {
    id: "pr-body-patch",
    action: "REST PATCH a PR's body (acceptance repair, trailer stamp, retro repair)",
    module: "src/run-task.ts",
    symbol: "prBodyRestArgs / writePrBodyRest",
    boundary: "gh-pr-body-patch",
    gate: "always",
    ledgerSteps: [],
    verb: "rmd run-task / rmd drain / rmd review",
    note: "W1-T2948: the one shared transport the three production PR-body writers use. No dedicated ledger step found; reported as unmapped, not guessed.",
  },
  {
    id: "sweep-close-superseded-pr",
    action: "close an unmerged PR the sweep judged superseded",
    module: "src/run-task.ts",
    symbol: "buildSweepEffects(...).close",
    boundary: "gh-pr-close",
    gate: "policy",
    policyField: "sweep.supersessionDisposal",
    ledgerSteps: [],
    verb: "rmd drain (sweep supersession disposition)",
    note: "Gated on sweep.supersessionDisposal (default off in policy.ts's type doc). W1-T921: never carries --delete-branch, unlike the merge paths beside it.",
  },
  {
    id: "sweep-ci-job-rerun",
    action: "REST POST one failed CI job's rerun endpoint",
    module: "src/run-task.ts",
    symbol: "buildSweepEffects(...).requeueCheck",
    boundary: "gh-job-rerun",
    gate: "always",
    ledgerSteps: ["sweep.check_requeue.dispatched", "sweep.check_requeue.no_job_id", "sweep.check_requeue.error"],
    verb: "rmd drain (sweep check-requeue rung)",
    note: "W1-T1223: the JOB endpoint, deliberately never the RUN endpoint — re-running the run would re-spend every green sibling job.",
  },
  // ── src/lib/worker.ts ────────────────────────────────────────────────────────────────────
  {
    id: "worker-direct-merge-squash",
    action: "merge a PR directly (`gh pr merge --squash`)",
    module: "src/lib/worker.ts",
    symbol: "ghPrMergeSquash",
    boundary: "gh-pr-merge",
    gate: "operator-verb",
    ledgerSteps: [],
    verb: "node src/spike.ts (the WS-0 sandbox spike)",
    note: "The only caller today is the one-shot sandbox spike tool (craigoley/remudero-sandbox), never the live repo, and a human runs it deliberately.",
  },
  // ── src/spike.ts ─────────────────────────────────────────────────────────────────────────
  {
    id: "open-sandbox-spike-pr",
    action: "open a PR against the WS-0 sandbox repo when the spawned worker's own REPORT carried no PR url",
    module: "src/spike.ts",
    symbol: "spike's PR-open fallback",
    boundary: "gh-pr-create",
    gate: "operator-verb",
    ledgerSteps: [],
    verb: "node src/spike.ts",
    note: "Targets craigoley/remudero-sandbox by a literal in this file, never the live repo. A human runs the spike, not the drain loop.",
  },
  // ── src/lib/feedback-landing.ts ──────────────────────────────────────────────────────────
  {
    id: "open-landing-pr",
    action: "open the PR that lands one plan/feedback/**.yaml file",
    module: "src/lib/feedback-landing.ts",
    symbol: "ensurePrOpen",
    boundary: "gh-pr-create",
    gate: "always",
    ledgerSteps: ["pr.opened"],
    verb: "rmd drain (feedback-landing sweep rung)",
    note: "Fires once per unlanded feedback id whose landing branch has diverged from main.",
  },
  {
    id: "arm-landing-pr-automerge",
    action: "arm `gh pr merge --auto --squash` on a just-opened feedback-landing PR",
    module: "src/lib/feedback-landing.ts",
    symbol: "landing PR auto-merge arm",
    boundary: "gh-pr-merge",
    gate: "ledger-verdict",
    ledgerSteps: ["automerge.armed"],
    verb: "rmd drain (feedback-landing sweep rung)",
    note: "Consults automergeHoldFromLedger before arming, and only in the call that creates the PR — never re-armed on a later poll.",
  },
  {
    id: "force-push-landing-branch",
    action: "force-push a bot-owned feedback-landing branch to a fresh commit",
    module: "src/lib/feedback-landing.ts",
    symbol: "finishLanding's force-push",
    boundary: "git-push",
    gate: "always",
    ledgerSteps: [],
    verb: "rmd drain (feedback-landing sweep rung)",
    note: "Scoped to a branch the fleet alone owns (comment: force-push is safe here); no ledger step name confirmed by grep, reported as unmapped.",
  },
  // ── src/lib/git-push.ts ──────────────────────────────────────────────────────────────────
  {
    id: "push-run-branch",
    action: "push one task run's own branch to origin",
    module: "src/lib/git-push.ts",
    symbol: "gitPushRunBranch",
    boundary: "git-push",
    gate: "always",
    ledgerSteps: [],
    verb: "rmd run-task / rmd drain / rmd plan / rmd approve",
    note: "The single push helper that replaced nine longhand `git push` call sites; every task run's branch goes out through this.",
  },
  {
    id: "push-empty-commit-rebase",
    action: "force-with-lease push an empty commit to mint a fresh head sha without a real rebase",
    module: "src/lib/git-push.ts",
    symbol: "gitPushEmptyCommit",
    boundary: "git-push",
    gate: "always",
    ledgerSteps: [],
    verb: "rmd run-task / rmd drain (fix-rung)",
    note: "Used where a rebase is unnecessary but a fresh head sha is required to invalidate a stale verdict.",
  },
  // ── src/lib/escalate.ts ──────────────────────────────────────────────────────────────────
  {
    id: "file-needs-human-issue",
    action: "file a `needs-human` GitHub issue",
    module: "src/lib/escalate.ts",
    symbol: "ghIssueGateway(...).create",
    boundary: "gh-issue-create",
    gate: "always",
    ledgerSteps: ["escalation.issue_opened"],
    verb: "rmd run-task / rmd drain (escalate())",
    note: "escalate()'s own dedup search (keyed on task/PR/class/cause) must find no matching OPEN issue first — see escalation.deduped.",
  },
  {
    id: "escalate-issue-close-comment",
    action: "close or comment on a `needs-human` issue once its cause resolves",
    module: "src/lib/escalate.ts",
    symbol: "ghIssueGateway(...).close / .comment (the reconciler)",
    boundary: "gh-issue-close",
    gate: "always",
    ledgerSteps: [],
    verb: "rmd drain (escalation reconciler rung)",
    note: "Not wrapped by assertLiveWriteAllowed today, unlike the create half beside it — a real gap this row names rather than hides (design note v).",
  },
  // ── src/lib/review.ts ────────────────────────────────────────────────────────────────────
  {
    id: "post-review-status",
    action: "POST a commit status (`repos/.../statuses/<sha>`) recording a review verdict",
    module: "src/lib/review.ts",
    symbol: "postReviewStatusGuarded -> postReviewStatus",
    boundary: "gh-status-post",
    gate: "always",
    ledgerSteps: ["review.posted", "review.post_failed", "review.post_refused"],
    verb: "rmd review <pr>",
    note:
      "NOT wrapped by live-write-guard.ts's assertLiveWriteAllowed — the table names this gap rather than closing it " +
      "(design note v: no gate moves in this task). postReviewStatusGuarded is the only call path run-task.ts uses (its own doc).",
  },
  {
    id: "post-review-pr-comment",
    action: "post a PR comment appending review evidence",
    module: "src/lib/review.ts",
    symbol: "execFileSync(\"gh\", [\"pr\", \"comment\", ...])",
    boundary: "gh-pr-comment",
    gate: "always",
    ledgerSteps: [],
    verb: "rmd review <pr>",
    note: "Same live-write-guard gap as post-review-status. Refuses to append when the body is byte-identical to what is already posted.",
  },
  // ── src/lib/specialist-panel.ts ──────────────────────────────────────────────────────────
  {
    id: "specialist-panel-comment",
    action: "post the specialist panel's comment on a PR",
    module: "src/lib/specialist-panel.ts",
    symbol: "buildSpecialistCommentArgs -> gh pr comment",
    boundary: "gh-pr-comment",
    gate: "always",
    ledgerSteps: [],
    verb: "rmd run-task / rmd drain (specialist panel rung)",
    note: "Same live-write-guard gap as the review-comment rows above.",
  },
  // ── src/lib/auto-triage.ts ───────────────────────────────────────────────────────────────
  {
    id: "triage-claim-ref-push",
    action: "push/release a `refs/...` claim ref that locks one feedback id to this worker",
    module: "src/lib/auto-triage.ts",
    symbol: "triage claim/release ref push",
    boundary: "git-push",
    gate: "always",
    ledgerSteps: ["triage.claim", "triage.claim_released"],
    verb: "rmd triage / rmd drain",
    note: "An internal coordination ref, not repo content — also not wrapped by assertLiveWriteAllowed; a gap this row names.",
  },
  // ── src/lib/dispatch-claim.ts ────────────────────────────────────────────────────────────
  {
    id: "dispatch-claim-ref-push",
    action: "push/release/repair a `refs/...` claim ref that locks one task id (or PR repair) to this worker",
    module: "src/lib/dispatch-claim.ts",
    symbol: "dispatch claim/release/repair ref push",
    boundary: "git-push",
    gate: "always",
    ledgerSteps: [],
    verb: "rmd run-task / rmd drain",
    note: "Same shape and same live-write-guard gap as the triage claim ref above.",
  },
  // ── src/lib/fleet-control.ts ─────────────────────────────────────────────────────────────
  {
    id: "fleet-pause-ref-push",
    action: "push/release the shared `refs/...` pause ref that halts (or resumes) the whole fleet",
    module: "src/lib/fleet-control.ts",
    symbol: "sharedPauseRef push/release",
    boundary: "git-push",
    gate: "operator-verb",
    ledgerSteps: [],
    verb: "rmd pause / rmd resume",
    note: "The one write in this table an operator issues directly, not the drain loop — a durable, explicit halt.",
  },
  // ── src/lib/task-id-reservation.ts ───────────────────────────────────────────────────────
  {
    id: "task-id-reservation-ref-push",
    action: "atomically claim a W1-T<n> id by pushing `refs/rmd-id/<id>`",
    module: "src/lib/task-id-reservation.ts",
    symbol: "reservation ref push",
    boundary: "git-push",
    gate: "always",
    ledgerSteps: [],
    verb: "rmd next-task-id --reserve / rmd run-task / rmd drain",
    note: "W1-T1055: the push IS the claim, so two concurrent minters cannot leave holding the same number.",
  },
  // ── src/lib/branch-reaper.ts ─────────────────────────────────────────────────────────────
  {
    id: "prune-deletable-branches",
    action: "delete every branch in an already-classified manifest via `git push origin --delete`",
    module: "src/lib/branch-reaper.ts",
    symbol: "the prune's `git push origin --delete` chunk loop (the reap-branches executing half)",
    boundary: "git-push",
    gate: "operator-verb",
    ledgerSteps: ["branch_reap.pruned"],
    verb: "rmd reap-branches --prune",
    note:
      "W1-T3020: operator-invoked only — no daemon rung, sweep or cadence calls this, and a census test fails if " +
      "that ever changes. Re-derives no classification of its own; it deletes exactly the manifest planBranchReap " +
      "(lib/status.ts) already produced.",
  },
  // ── src/lib/onboard/synthesize.ts ────────────────────────────────────────────────────────
  {
    id: "onboard-draft-pr",
    action: "open exactly one draft PR proposing onboarding output against a target repo",
    module: "src/lib/onboard/synthesize.ts",
    symbol: "onboarding drafter (branch + push + `gh pr create --draft`)",
    boundary: "gh-pr-create",
    gate: "operator-verb",
    ledgerSteps: [],
    verb: "rmd onboard",
    note: "Standing rule 15: exactly one branch, one commit, one draft PR — a human runs `rmd onboard` deliberately.",
  },
  // ── src/lib/panel-actions.ts ─────────────────────────────────────────────────────────────
  {
    id: "issue-close-panel-action",
    action: "close a GitHub issue from a console panel action",
    module: "src/lib/panel-actions.ts",
    symbol: "ghIssueCloser().close",
    boundary: "gh-issue-close",
    gate: "operator-verb",
    ledgerSteps: [],
    verb: "console panel action route (an operator click, MASTER-PLAN §12)",
    note: "Mirrors escalate.ts's ghIssueGateway shape; fired only by an authenticated console action, never the drain loop.",
  },
] as const;

/** Every `AUTHORITY_TABLE.id` — asserted unique by `test/authority-table.test.ts`. */
export function authorityTableIds(): string[] {
  return AUTHORITY_TABLE.map((r) => r.id);
}

/** Every distinct `module` value the table documents — the ratchet's join key. */
export function authorityTableModules(): Set<string> {
  return new Set(AUTHORITY_TABLE.map((r) => r.module));
}

function getPolicyValue(policy: Policy | undefined, path: string): unknown {
  if (!policy) return undefined;
  let cur: unknown = policy.values;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export type AuthorityLastFired = { status: "measured"; ts: string } | { status: "never" } | { status: "unmapped" };

export interface AuthorityReportRow extends AuthorityRow {
  policyValue: unknown;
  pin: string | undefined;
  lastFired: AuthorityLastFired;
}

export type AuthorityReport =
  | { status: "measured"; rows: AuthorityReportRow[] }
  | { status: "refused"; reason: string; rows: AuthorityReportRow[] };

/**
 * One regex covering every `ledgerSteps` entry the table declares — the pattern
 * `authorityCommand` hands `resolveLedgerUnion` so the union read stays scoped to lines this
 * report can actually use, rather than pulling the whole corpus into memory unfiltered.
 */
export function authorityLedgerPattern(): RegExp {
  const steps = new Set<string>();
  for (const row of AUTHORITY_TABLE) for (const step of row.ledgerSteps) steps.add(step);
  const escaped = [...steps].sort().map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // No declared steps (every row unmapped) would build `"step":"(?:)"`, which matches every
  // line's empty alternative — refuse the empty-alternation shape explicitly instead.
  return escaped.length === 0 ? /"step":"(?!)"/ : new RegExp(`"step":"(?:${escaped.join("|")})"`);
}

function lastFiredFor(row: AuthorityRow, lines: readonly string[]): AuthorityLastFired {
  if (row.ledgerSteps.length === 0) return { status: "unmapped" };
  const steps = new Set(row.ledgerSteps);
  let latest: string | undefined;
  for (const raw of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // a corrupt/partial line is neither evidence of firing nor of not firing
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const step = (parsed as Record<string, unknown>).step;
    const ts = (parsed as Record<string, unknown>).ts;
    if (typeof step !== "string" || !steps.has(step)) continue;
    if (typeof ts !== "string") continue;
    if (latest === undefined || ts > latest) latest = ts;
  }
  return latest === undefined ? { status: "never" } : { status: "measured", ts: latest };
}

export interface BuildAuthorityReportOpts {
  /** Absent when policy.yaml could not be loaded — every policy-gated row's `policyValue` reads `undefined`. */
  policy?: Policy;
  /** `AUTHORITY_TABLE.id` -> ratification pin text (W1-T2694's file, if it carries one for this id). */
  pins?: Record<string, string>;
  /** Already-resolved ledger union (see {@link authorityLedgerPattern}); this function does no I/O of its own. */
  ledger: LedgerUnionResult;
}

/**
 * Join `AUTHORITY_TABLE` to `policy`'s values, `pins`, and the ledger union's last-fired line per
 * row. REFUSES (design note i) rather than blanking every row's `lastFired` when the ledger union
 * itself could not be read — `ledger.ok === false` means an archive went unread or none exist,
 * and a per-row "never fired" printed from that state would be indistinguishable from a row that
 * genuinely never fired, which is exactly the false-confidence shape this task exists to remove
 * (same posture as lib/autonomy.ts's `"unmeasured"` and lib/ledger-grep.ts's own `ok` field).
 */
export function buildAuthorityReport(opts: BuildAuthorityReportOpts): AuthorityReport {
  const { policy, pins = {}, ledger } = opts;
  if (!ledger.ok) {
    return {
      status: "refused",
      reason:
        `ledger union unreadable under ${ledger.stateDir} ` +
        `(archiveCount=${ledger.archiveCount}, unread=${JSON.stringify(ledger.unread)})`,
      rows: [],
    };
  }
  const rows: AuthorityReportRow[] = AUTHORITY_TABLE.map((row) => ({
    ...row,
    policyValue: row.policyField === undefined ? undefined : getPolicyValue(policy, row.policyField),
    pin: pins[row.id],
    lastFired: lastFiredFor(row, ledger.matches),
  }));
  return { status: "measured", rows };
}

/** Repo root, resolved from this module's own location — mirrors policy.ts's `installPolicyPath`. */
function installRepoRoot(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
}

/**
 * `plan/ratifications.yaml` (W1-T2694), read as a flat `id -> pin text` map. That file does not
 * exist yet at this task's own HEAD (W1-T2694 is still queued) — absence, unreadable YAML, or a
 * non-object top level all degrade to `{}`, never a throw, so this report works today and picks
 * up pins the moment that file ships, with no further change here (design note i: "if any").
 */
export function loadRatificationPins(root: string = installRepoRoot()): Record<string, string> {
  const path = join(root, "plan", "ratifications.yaml");
  try {
    if (!existsSync(path)) return {};
    const raw: unknown = parseYaml(readFileSync(path, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [id, pin] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof pin === "string") out[id] = pin;
    }
    return out;
  } catch {
    // Unreadable path, invalid YAML, or a read racing a concurrent write all degrade to "no pins
    // known yet" — the same posture as an absent file (W1-T2694's file may not exist at all).
    return {};
  }
}

function renderLastFired(lf: AuthorityLastFired): string {
  if (lf.status === "measured") return lf.ts;
  if (lf.status === "never") return "never";
  return "unmapped";
}

/** The human-readable render `rmd authority` prints without `--json`. */
export function renderAuthorityReport(report: AuthorityReport): string {
  if (report.status === "refused") {
    return `rmd authority: REFUSED — ${report.reason}`;
  }
  const lines = [
    "action                                    gate            boundary              policy-value  pin      last-fired",
  ];
  for (const row of report.rows) {
    const policyValue = row.policyValue === undefined ? "-" : JSON.stringify(row.policyValue);
    lines.push(
      [
        row.id.padEnd(42),
        row.gate.padEnd(15),
        row.boundary.padEnd(21),
        policyValue.padEnd(13),
        (row.pin ?? "-").padEnd(8),
        renderLastFired(row.lastFired),
      ].join(" "),
    );
  }
  return lines.join("\n");
}
