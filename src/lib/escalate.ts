import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { appendLedger } from "./ledger.js";
import { assertLiveWriteAllowed } from "./live-write-guard.js";
import { validateDecisionSummary, type DecisionSummary, type SummarizeDeps } from "./feedback.js";
import type { Mount, Mounts } from "./mounts.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";
import { resolveRiskJudgeMount } from "./risk-judge.js";

/**
 * Escalations as GitHub issues (W1-T8, MASTER-PLAN §4 "Escalation taxonomy").
 *
 * The loop never waits on a human except for four classes: BLOCKED (post-diagnose,
 * two-strikes exhausted), MANUAL (secrets, repo creation, deploys, eyeball/playtest
 * gates), HARD_STOP (the deterministic hard-stop list — destructive ops, spend
 * beyond cap, force-push, secret handling), and GRILL (an ambiguous feedback item
 * the intake triage cannot decide alone — MASTER-PLAN §7B, W1-T42; reuses this SAME
 * machinery rather than a second one, per the task's own directive). Every one of
 * these opens a `needs-human` labeled issue carrying the OPTIONS available and the
 * machine's RECOMMENDATION, so the issue itself is actionable rather than a bare
 * alert. (DECISION/DIRECTION classes are absorbed elsewhere — auto-choose and
 * idle-groom respectively — and ASYNC-QUESTION deliberately never escalates; see
 * §2/§4. GRILL does not block the loop either — like BLOCKED it collapses to the
 * digest, never a real-time ping — but it IS a needs-human issue, unlike
 * ASYNC-QUESTION, because MASTER-PLAN §7B names this specific case as reusing §4's
 * escalation taxonomy verbatim.)
 */
export type EscalationClass = "BLOCKED" | "MANUAL" | "HARD_STOP" | "GRILL";

/** One choice a human can make to resolve the escalation. */
export interface EscalationOption {
  label: string;
  detail: string;
}

export interface Escalation {
  class: EscalationClass;
  taskId: string;
  runId?: string;
  /** Short human summary; becomes the issue title. */
  summary: string;
  /** Longer context: what happened, why it's stuck, relevant links. */
  detail: string;
  /** The choices a human can make — REQUIRED; an escalation with no options is a bare alert. */
  options: EscalationOption[];
  /** Which option the machine recommends (auto-choose doctrine, §4) — must be one of options[].label. */
  recommendation: string;
  /**
   * The PR's head commit sha, OPTIONAL (W1-T195 — the composite dedup key's 2nd
   * dimension, alongside the PR number `escalate()` already scrapes from `summary`/
   * `detail`). A caller that omits this keeps today's W1-T104 (taskId, PR) dedup
   * behavior UNCHANGED — {@link escalate}'s dup search only requires equality on a
   * dimension when BOTH the new escalation and the candidate open issue carry a
   * value for it, so an un-migrated caller never regresses. Set by the two rungs
   * whose independent duplicate pairs motivated this task — the fix rung's
   * strike-exhaustion escalate and the clarification rung's blocked-ambiguous
   * escalate (both `run-task.ts`) — from the SAME `headSha`/`review.headSha` each
   * already reads for its own dispatch.
   */
  headSha?: string;
  /**
   * The blocked PR's underlying cause, OPTIONAL (W1-T195 — the composite dedup
   * key's 3rd dimension): 'the review is failing' vs 'the checks are red' vs
   * 'this PR is conflicted' are different operator asks even on the same head sha,
   * so a same-PR/same-sha pair with DIFFERENT causes must still open separately.
   * See {@link escalationCause} — both rungs named above derive this from the SAME
   * booleans they already compute for their own dispatch, so a review-failing
   * observation from EITHER rung normalizes to the identical value the dedup key
   * needs to collapse them. Same permissive-when-absent matching as
   * {@link Escalation.headSha}.
   */
  cause?: EscalationCause;
  /**
   * A machine-written plain-language decision card, generated ONCE at escalation-creation time
   * (see this module's own {@link summarizeEscalation}) and cached here — {@link
   * renderIssueBody} renders it ABOVE the raw `detail` when present. Named `decisionSummary`,
   * NOT `summary` — {@link Escalation.summary} above is already taken (the short issue-title
   * text) and means something different. `null`/absent degrades to exactly today's raw-only
   * body (fail-open, never lossy — W1-T313).
   */
  decisionSummary?: DecisionSummary | null;
}

/** The three-way cause split {@link Escalation.cause} keys on (W1-T195's design). */
export type EscalationCause = "review" | "ci" | "conflict";

/**
 * Classify a blocked PR's underlying cause into the {@link EscalationCause} three-way
 * split, from the SAME two booleans each rung already computes for its own dispatch
 * (the fix rung's `stillConflicted`/`noReviewYet`, the clarification rung's
 * `pr.mergeState === "dirty"`/`isBlockedCi(pr)`) — never a second, independently
 * re-derived classification, and never string-parsing either rung's free-text `reason`
 * (which differs in wording between the two call sites and would be fragile to keep in
 * sync). `conflicted` wins over `ciFailing` because a dirty merge state means GitHub
 * never ran checks at all (see {@link isBlockedCi}'s sibling doc in sweep.ts) — checks
 * read as "none"/stale, not a genuine ci-failing signal, when a PR is unmergeable.
 */
export function escalationCause(conflicted: boolean, ciFailing: boolean): EscalationCause {
  if (conflicted) return "conflict";
  if (ciFailing) return "ci";
  return "review";
}

/** One open issue as the reconciler reads it (fb-1784756088300-6a481e). */
export interface OpenIssue {
  number: number;
  url: string;
  title?: string;
  /** Raw body — carries the `**Task:** <id>` line {@link renderIssueBody} writes, which the
   *  escalation-lifecycle reconciler parses to derive the referenced task's current state. */
  body?: string;
}

/** GitHub issue creation, behind an interface so tests never touch the network. */
/**
 * The `gh api repos/<slug>/issues?labels=…` argv every labelled-issue read in this repo uses.
 *
 * WHY REST, NOT `gh issue list --label`: `gh` implements `--label` filtering on issue lists over
 * GitHub's GraphQL `search()` connection. That connection is throttled account-wide here, so the
 * `--label` form failed 100% of the time — `board_gateway.issue_fetch_ok` never once appeared in
 * the ledger against 505 failures, and the escalation reconciler read an empty list every tick
 * while 79 needs-human issues sat open. REST's `/issues` endpoint answers the same question off
 * the deterministic list API, with no search connection involved.
 *
 * `--slurp` (NOT bare `--paginate`) is load-bearing: `--paginate` alone concatenates one JSON
 * array per page, which `JSON.parse` rejects outright — and the `state=all` read is genuinely
 * multi-page (223 rows over 3 pages when this landed). `--slurp` wraps the pages in one outer
 * array that parses cleanly; {@link parseLabelledIssuesRest} flattens it.
 */
export function labelledIssuesRestArgs(repoArg: string, label: string, state: "open" | "all"): string[] {
  const q = `labels=${encodeURIComponent(label)}&state=${state}&per_page=100`;
  return ["api", `repos/${repoArg}/issues?${q}`, "--paginate", "--slurp"];
}

/** An {@link OpenIssue} plus the `state` field the BATCHED board gateway's own consumer needs
 *  (`state=all` there, so open-vs-closed is the whole question). Superset of both consumer
 *  shapes, so one parse serves the reconciler AND the board gateway. */
export interface LabelledIssue extends OpenIssue {
  /** Lowercase "open"/"closed" as REST reports it — `resolveEscalation` upper-cases before
   *  comparing, so this coexists with `gh --json state`'s "OPEN"/"CLOSED" unchanged. */
  state: string;
}

/** One row exactly as GitHub's REST `/issues` endpoint returns it — the wire shape, never the
 *  shape any consumer here reads (see {@link parseLabelledIssuesRest} for the translation). */
interface RestIssueRow {
  number: number;
  /** The api.github.com URL. Deliberately DROPPED — see parseLabelledIssuesRest. */
  url: string;
  /** The github.com WEB url — what escalate.ts writes into the ledger and consumers match on. */
  html_url: string;
  /** Lowercase "open"/"closed" (REST), where `gh --json state` reports "OPEN"/"CLOSED". */
  state: string;
  title?: string;
  body?: string;
  /** Present ONLY on pull requests: REST's `/issues` returns PRs alongside issues. */
  pull_request?: unknown;
}

/**
 * Flatten `--slurp`'s pages, drop pull requests, and translate the wire shape to the one every
 * consumer reads. THROWS on malformed input (the callers treat a failed read as "do nothing this
 * cycle", never as a confirmed "zero open") — never returns [] to paper over a broken payload.
 *
 * TWO translations are load-bearing:
 *  1. `url` is taken from REST's `html_url`, NOT its `url`. Consumers match against the web URLs
 *     {@link renderIssueBody}/escalate write into the ledger; surfacing api.github.com would make
 *     every lookup miss SILENTLY, a fail-open that reads as "escalation not found".
 *  2. Rows carrying `pull_request` are dropped. REST's `/issues` returns PRs too, and an
 *     escalation is always an issue.
 */
export function parseLabelledIssuesRest(raw: string): LabelledIssue[] {
  const parsed = JSON.parse(raw) as unknown;
  // `--slurp` yields pages-of-rows; tolerate a bare single page so a fixture (or a future gh
  // that stops wrapping) is read correctly rather than silently as zero rows.
  const pages: RestIssueRow[][] = Array.isArray(parsed)
    ? (parsed as unknown[]).every((p) => Array.isArray(p))
      ? (parsed as RestIssueRow[][])
      : [parsed as RestIssueRow[]]
    : [];
  return pages
    .flat()
    .filter((i) => i?.pull_request === undefined)
    .map((i) => ({ number: i.number, url: i.html_url, state: i.state, title: i.title, body: i.body }));
}

export interface IssueGateway {
  /** Create a labeled issue; returns its URL. */
  create(title: string, body: string, labels: string[]): string;
  /**
   * List OPEN issues carrying `label` (fb-1784756088300-6a481e — the escalation-lifecycle
   * reconciler's read side): the queue of live needs-human issues whose referenced task the
   * reconciler re-derives each sweep. THROWS on a `gh` read failure (never returns [] on an
   * outage — the caller treats a failed read as "do nothing this cycle", never "zero open").
   * Optional so create-only fakes keep working unchanged; a gateway omitting it yields no
   * reconciler candidates at all.
   */
  listOpen?(label: string): OpenIssue[];
  /**
   * Close one issue, posting `comment` as the closing citation (fb-1784756088300-6a481e). Used
   * ONLY by the reconciler when a referenced task has resolved — the comment names the resolver
   * (the merged PR) so the closure is legible, never a silent disappearance. Optional, same
   * fail-soft discipline as {@link ensureLabel}.
   */
  closeWithComment?(url: string, comment: string): void;
  /**
   * Post `body` as a plain comment on an OPEN issue, without closing it (W1-T104 — the
   * SECOND OBSERVER of an already-open escalation appends here rather than opening a
   * sibling). Distinct from {@link closeWithComment}: that one is the reconciler's
   * CLOSE-and-cite step; this one keeps the issue open and just adds the new caller's
   * context. Optional, same fail-soft discipline as every other gateway extension here —
   * a gateway omitting it still DEDUPES (no sibling is created) but silently drops the
   * second observation instead of appending it.
   */
  comment?(url: string, body: string): void;
  /**
   * Ensure ONE label exists on the repo (create-if-missing, tolerate-already-exists).
   * Returns true when the label is now safe to attach, false when provisioning itself
   * failed. Optional: a gateway that omits this is treated as "every label already
   * exists" (today's `create()`-only fakes keep working unchanged).
   *
   * LIVE INCIDENT (2026-07-17, W1-T99): the first BLOCKED-class escalation ever fired
   * called `gh issue create --label escalation-blocked`, and the label had never been
   * provisioned on the repo — `gh` failed the WHOLE create outright, so the rendered
   * clarification question was generated and then lost, and the throw propagated
   * through `runSweep` and killed the reconciler for every other open PR. Provisioning
   * is the transport's job, never the operator's memory — see `escalate()`'s
   * ENSURE-LABELS step below, which calls this before every `create()`.
   */
  ensureLabel?(label: string): boolean;
}

/** Per-class label, alongside the blanket `needs-human` queue label. */
const CLASS_LABEL: Record<EscalationClass, string> = {
  BLOCKED: "escalation-blocked",
  MANUAL: "escalation-manual",
  HARD_STOP: "escalation-hard-stop",
  GRILL: "escalation-grill",
};

/**
 * Every needs-me item is one of two asks (W1-T346, oper#needs-me-filings-2026-08-04): an
 * ACTION the operator must PERFORM, or a QUESTION the operator must ANSWER. See
 * {@link classifyAsk}.
 */
export type AskType = "action" | "question";

/** Beside the per-class label, alongside `needs-human` — the ask-type queue split. */
const ASK_TYPE_LABEL: Record<AskType, string> = {
  action: "needs-action",
  question: "needs-question",
};

/**
 * Does this ONE option's own text name something only the OPERATOR can do — grant an
 * override credential, merge/act by hand, or run a host command themselves — as opposed
 * to something the MACHINE carries out once the operator merely picks a label?
 *
 * The three idioms are lifted straight from the corpus {@link classifyAsk} is derived from
 * (measured 2026-08-05 over all 369 historical needs-human issues, W1-T346's rationale):
 * the CAPPED-verdict escalation's own `--override-capped-by <name>` escape hatch, the risk
 * judge's "merge it by hand" option, and the circuit-breaker/crash-loop family's backtick
 * host commands (`` `rmd fix` ``, `` `rmd correct` ``, `` `launchctl bootout` ``). The
 * clarification rung's own options (re-dispatch-with-constraint / revise-spec) name NONE
 * of these — both are things THIS codebase's own machinery carries out once the operator
 * answers — which is exactly what keeps that family classifying as a question below.
 */
function namesOperatorOnlyAct(option: EscalationOption): boolean {
  const text = `${option.label} ${option.detail}`;
  return (
    /--override[-\w]*\b/i.test(text) ||
    /\bby hand\b|\bhand-merge\b/i.test(text) ||
    /`(?:rmd|gh|git|launchctl|npm|node|bash|sh)\b[^`]*`/.test(text)
  );
}

/**
 * Classify ONE escalation as an ACTION the operator must perform, or a QUESTION the
 * operator must answer (W1-T346; MASTER-PLAN §4, oper#needs-me-filings-2026-08-04) —
 * DERIVABLE from fields the escalation already carries, never a producer-side field, and
 * never an LLM call: PURE, deterministic, and TOTAL (every input classifies).
 *
 * Rules, straight off the rationale's 369-issue read:
 *  - `MANUAL` is ACTION by definition — the whole class exists because only a human hand
 *    can do the thing (secrets, deps, disk, deploys — see this module's header).
 *  - `GRILL` is QUESTION by definition — an ambiguous feedback item is, definitionally, a
 *    human CALL between named options (MASTER-PLAN §7B); it is never a task the operator
 *    executes themselves.
 *  - `BLOCKED`/`HARD_STOP` fall to the OPTIONS-SHAPE test: if ANY option names an
 *    operator-only act (see {@link namesOperatorOnlyAct}) — the CAPPED-verdict override
 *    escape hatch, the risk judge's manual-merge option, the circuit-breaker's `rmd fix` —
 *    it's an ACTION. If EVERY option is something the MACHINE carries out once the
 *    operator merely picks a label (the clarification rung's re-dispatch/revise-spec
 *    pair), it's a QUESTION.
 *
 * Defaults ACTION whenever the options-shape test cannot decide (no options at
 * classify-time, ahead of {@link escalate}'s own zero-options refusal) — presenting a
 * QUESTION as an ACTION costs the operator one wasted read; presenting an ACTION as a
 * QUESTION hides real work behind an answer the operator wrongly believes settles it.
 */
export function classifyAsk(e: Escalation): AskType {
  if (e.class === "MANUAL") return "action";
  if (e.class === "GRILL") return "question";
  if (e.options.length > 0 && e.options.every((o) => !namesOperatorOnlyAct(o))) return "question";
  return "action";
}

/** The label every escalation issue carries — the queue the control panel reads (§4). */
export const NEEDS_HUMAN_LABEL = "needs-human";

/**
 * The DEMOTED queue label (W1-T349, residual-escalation-judge): a fleet-notice issue is
 * exactly a needs-human issue that {@link judgeEscalation} decided did not need the
 * operator's real-time attention. It carries every other label ({@link CLASS_LABEL}, the
 * ask-type label) and the full rendered body UNCHANGED — only the queue label differs, so it
 * leaves the NEEDS ME board (which keys on {@link NEEDS_HUMAN_LABEL}) but remains open,
 * durable, searchable, and listable. Nothing is deleted, nothing is unfiled; recovery is
 * relabelling. See {@link escalateWithJudge}.
 */
export const FLEET_NOTICE_LABEL = "fleet-notice";

// ── OPERATOR PRESENCE (P34 clause (e), MASTER-PLAN §7B/§4; ratified round iii) ──────────────
//
// An operator presence signal keys ONLY escalation DELIVERY — never dispatch. Round iii killed
// the rounds-1-2 presence×risk DISPATCH matrix (MASTER-PLAN's original P34 proposal, superseded
// by the round-3 ratification note directly above it): no dispatch decision (drain.ts's
// `nextRunnable`/`runnableCandidates`, dispatch-overlap.ts) reads this flag, and none should —
// that would resurrect the dead matrix. The control surface on the dispatch path stays gates +
// the risk judge (W1-T248) + escalations + console, exactly as before this task. The ONLY
// real-time-presence waits remain STOP and PAUSE (fleet-control.ts, W1-T11) — untouched here.
//
// This flag answers exactly one question: does a MANUAL/HARD_STOP escalation page the operator
// in real time RIGHT NOW (ATTENDED — today's behavior, unchanged), or does it batch into the
// W1-T163 recap/digest for an ASYNC verdict instead of expecting a sync answer (AWAY)? Either
// way `escalate()` below opens the `needs-human` issue and ledgers `escalation.issue_opened`
// UNCONDITIONALLY — recap.ts/digest.ts already surface every such line off the SAME per-token
// marker regardless of presence (see their module headers). AWAY mode changes only whether a
// CALLER (run-task.ts's `escalateCommand`, the sole real-time-ping site — grep-provable: it is
// the only call to `notify()` gated on `cls === "MANUAL" || cls === "HARD_STOP"`) also fires an
// immediate ping alongside that unconditional issue.

export type PresenceMode = "attended" | "away";

/** `<root>/state/AWAY` — the same existence-gated flag idiom as fleet-control.ts's
 *  STOP/PAUSE/QUIET_HOURS: a corrupt/unreadable state dir still fails to the SAFE default
 *  (`"attended"`, i.e. deliver exactly as today), never silently goes quiet. */
export function awayFilePath(root: string): string {
  return join(root, "state", "AWAY");
}

/** The operator's CURRENT presence mode. Default (no flag file, or a fresh root) is
 *  `"attended"` — away-mode routing is opt-in, never assumed. */
export function presenceMode(root: string): PresenceMode {
  return existsSync(awayFilePath(root)) ? "away" : "attended";
}

/**
 * `rmd away on|off` — the operator sets the mode explicitly (MASTER-PLAN §7B/§4: "an operator
 * presence signal ... OR an explicit `away` mode"). `"away"` writes the flag; `"attended"`
 * clears it (idempotent either way).
 */
export function setPresenceMode(root: string, mode: PresenceMode): void {
  const path = awayFilePath(root);
  if (mode === "away") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ setAt: new Date().toISOString() }, null, 2));
    return;
  }
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Should an escalation for this class deliver as a real-time, sync-answer-expecting ping RIGHT
 * NOW? `false` means: batch into the recap instead — the caller must skip its own real-time
 * `notify()` and rely on `escalation.issue_opened` (already ledgered unconditionally by
 * {@link escalate}/{@link tryEscalate}) surfacing via the marker-aware recap/digest read.
 * ATTENDED (the default) returns `true` for every class exactly as before this flag existed —
 * away-mode routing changes NOTHING attended.
 */
export function deliversRealtime(root: string): boolean {
  return presenceMode(root) === "attended";
}

// ── RESIDUAL ESCALATION JUDGE (W1-T349, MASTER-PLAN §4B) ───────────────────────────────────
//
// Routing-only, downstream of the deterministic stack (the reconciler above, referent-coverage,
// W1-T114's wait disposition, W1-T345's dedup): the reconciler already retires most historical
// volume by watching a referenced PR resolve; this judge is for the RESIDUE it cannot see —
// items with no referent, or whose referent IS the unresolved thing. It sees the full typed
// {@link Escalation} at the one choke point every producer already crosses ({@link escalate}) and
// returns demote|deliver with a one-line reason. It never runs on a duplicate ({@link
// escalateWithJudge} judges only AFTER the same dedup search {@link escalate} itself uses), and
// it never runs at all for MANUAL/GRILL — those are operator-owned by rule (see {@link
// classifyAsk}'s own doc: MANUAL is action-by-definition, only a human hand can do the thing;
// GRILL is question-by-definition, an ambiguous feedback item IS a human call) — {@link
// isEscalationJudgeExempt} is checked BEFORE {@link judgeEscalation} ever calls the judge
// dependency, so an exempt class is delivered by never being asked, not by trusting a possibly-
// wrong answer to override.
//
// THE ASYMMETRY THAT GOVERNS EVERYTHING HERE, and why this module's fail behavior is the MIRROR
// image of risk-judge.ts's/flight-judge.ts's: there, a false POSITIVE (proceeding on real risk)
// is the costly direction, so an unreadable verdict fails CLOSED to escalate. HERE, a false
// NEGATIVE (demoting something the operator actually needed) hides work he cannot know to look
// for — THAT is the costly direction — while a false positive (delivering something that turns
// out not to matter) costs him one skim. So this judge may only DEMOTE, never drop or suppress
// content, and {@link judgeEscalation} fails OPEN to `deliver` on every unreadable-verdict path:
// a spawn error, a timeout, an unparseable response, or a governor refusal all resolve to exactly
// today's needs-human delivery, never silently to demote.

/** What {@link judgeEscalation} decides for one escalation. Demote-only by construction — there
 *  is no third value that could mean "drop"; the type itself cannot express suppression. */
export type EscalationJudgeDecision = "demote" | "deliver";

/** The judge's verdict. `reason` is ledgered verbatim and, on a demotion, becomes the FIRST
 *  comment on the fleet-notice issue (design clause ii) — so the demotion is never silent. */
export interface EscalationJudgeVerdict {
  decision: EscalationJudgeDecision;
  reason: string;
}

/**
 * Classes exempt from judgement ENTIRELY — MANUAL and GRILL are operator-owned by rule (see the
 * module-section doc above), and anything the operator's own CLI escalated is exempt STRUCTURALLY
 * rather than by a field this function reads: `escalateCommand` (run-task.ts) calls {@link
 * escalate} directly, never {@link escalateWithJudge}, so a CLI escalation never reaches this
 * module's judge machinery at all — the same "cannot, not merely told not to" discipline
 * flight-judge.ts's empty tool list uses for read-only.
 */
export function isEscalationJudgeExempt(e: Escalation): boolean {
  return e.class === "MANUAL" || e.class === "GRILL";
}

/**
 * Render the judge's prompt — the FULL typed {@link Escalation} (class, taskId, summary, detail,
 * options, recommendation, cause, askType) at the one choke point every producer already crosses.
 * Carries the asymmetry explicitly: WHEN IN DOUBT, DELIVER.
 */
export function buildEscalationJudgePrompt(e: Escalation): string {
  const options = e.options.map((o, i) => `  ${i + 1}. ${o.label} — ${o.detail}`).join("\n") || "  (none)";
  const lines = [
    `You are the RESIDUAL ESCALATION JUDGE (MASTER-PLAN §4B, W1-T349) — a ROUTING-ONLY judge`,
    `deciding whether ONE already-created needs-human escalation is worth the operator's REAL-TIME`,
    `attention right now, or can wait as a lower-priority fleet notice instead.`,
    ``,
    `YOU MAY ONLY DEMOTE, NEVER DROP. A demoted item still opens as a GitHub issue — it is never`,
    `suppressed, never deleted, never silenced. It only moves off the operator's real-time board`,
    `into a durable, searchable, listable "fleet notice" queue; recovery is a relabel away.`,
    ``,
    `THE ASYMMETRY THAT GOVERNS THIS DECISION: a FALSE NEGATIVE (demoting something the operator`,
    `actually needed) hides work he cannot know to look for — this is the COSTLY direction. A FALSE`,
    `POSITIVE (delivering something that turns out not to matter) costs him one skim — cheap.`,
    `WHEN IN DOUBT, DELIVER.`,
    ``,
    `CLASS: ${e.class}`,
    `TASK: ${e.taskId}`,
    `ASK TYPE: ${classifyAsk(e)}`,
    e.cause ? `CAUSE: ${e.cause}` : undefined,
    `SUMMARY: ${e.summary}`,
    ``,
    `DETAIL:`,
    e.detail || "(none)",
    ``,
    `OPTIONS:`,
    options,
    ``,
    `RECOMMENDATION: ${e.recommendation}`,
    ``,
    `Decide — exactly one of:`,
    `  deliver  — this needs the operator's real-time attention now`,
    `  demote   — this can wait; file it as a fleet notice instead`,
    ``,
    `MACHINE-READABLE OUTPUT (required, in addition to any prose): emit exactly one of each of`,
    `these lines, and nothing else on the line:`,
    `  ESCALATION_JUDGE_DECISION: <deliver|demote>`,
    `  ESCALATION_JUDGE_REASON: <one concrete, specific reason — this becomes the first comment`,
    `    on the issue if demoted>`,
  ];
  return lines.filter((l): l is string => l !== undefined).join("\n");
}

const VALID_JUDGE_DECISIONS = new Set<EscalationJudgeDecision>(["demote", "deliver"]);

/**
 * FAIL-OPEN default (the acceptance criterion, stated): a spawn error, a timeout, an unparseable
 * verdict, or a governor refusal all resolve to exactly this — needs-human, unchanged, as today.
 * The OPPOSITE polarity from risk-judge.ts's/flight-judge.ts's fail-CLOSED defaults, because the
 * costly direction here is silently HIDING work, not silently proceeding past risk.
 */
const FAIL_OPEN_JUDGE_VERDICT: EscalationJudgeVerdict = {
  decision: "deliver",
  reason:
    "judge output carried no parseable ESCALATION_JUDGE_DECISION — failing open to deliver " +
    "(never silently hide work from the operator)",
};

/**
 * Parse the judge's `ESCALATION_JUDGE_DECISION`/`ESCALATION_JUDGE_REASON` lines into an {@link
 * EscalationJudgeVerdict}. Missing/unrecognized decision fails OPEN ({@link
 * FAIL_OPEN_JUDGE_VERDICT} — `deliver`, never `demote`). Case-insensitive, tolerant of
 * surrounding prose.
 */
export function parseEscalationJudgeVerdict(text: string): EscalationJudgeVerdict {
  const decisionMatch = text.match(/ESCALATION_JUDGE_DECISION:\s*(\w+)/i);
  const decision = decisionMatch?.[1]?.toLowerCase() as EscalationJudgeDecision | undefined;
  if (!decision || !VALID_JUDGE_DECISIONS.has(decision)) {
    return { ...FAIL_OPEN_JUDGE_VERDICT };
  }
  const reasonMatch = text.match(/ESCALATION_JUDGE_REASON:\s*(.+)/i);
  const reason = reasonMatch?.[1]?.trim() || "(no reason stated)";
  return { decision, reason };
}

/** Injectable judge dependency — real callers wire this to {@link realEscalationJudge}; tests
 *  inject a fake, exactly as risk-judge.ts's `RiskJudgeDeps.judge`/flight-judge.ts's
 *  `FlightJudgeDeps.judge`. */
export interface EscalationJudgeDeps {
  judge: (e: Escalation) => Promise<EscalationJudgeVerdict>;
}

/**
 * Decide demote|deliver for ONE escalation. EXEMPT classes (MANUAL, GRILL) are delivered WITHOUT
 * ever calling `deps.judge` — the exemption is enforced by never asking, so a judge stub that
 * WOULD demote a MANUAL item (the falsifier, design clause iv) cannot influence the outcome even
 * if it tried.
 *
 * JUDGE-UNAVAILABLE (a spawn error, a timeout, a thrown rejection) is caught HERE and fails OPEN
 * to `deliver` — the cannot-observe -> DELIVER polarity (the mirror of risk-judge.ts's
 * cannot-observe -> ESCALATE, because here silence is the dangerous direction, not action). Every
 * reuse site gets this guarantee for free; a caller cannot forget to handle it.
 */
export async function judgeEscalation(e: Escalation, deps: EscalationJudgeDeps): Promise<EscalationJudgeVerdict> {
  if (isEscalationJudgeExempt(e)) {
    return { decision: "deliver", reason: `${e.class} is operator-owned by rule — exempt from judgement` };
  }
  try {
    return await deps.judge(e);
  } catch (err) {
    return {
      decision: "deliver",
      reason: `judge unavailable (${err instanceof Error ? err.message : String(err)}) — failing open to ` +
        "deliver, never silently hiding work from the operator",
    };
  }
}

// ── The real spawn (read-only BY CONSTRUCTION — no tools at all, mirrors risk-judge.ts) ────────

/** The judge's SDK tool allowlist — EMPTY by construction, same rationale as risk-judge.ts's
 *  `RISK_JUDGE_TOOLS`/flight-judge.ts's `JUDGE_TOOLS`: everything it needs is already baked into
 *  the prompt, so it has no need (and no ability) to explore the worktree or take any action. */
export const ESCALATION_JUDGE_TOOLS: string[] = [];

/** Build the {@link SpawnWorkerArgs} for a real escalation-judge spawn — a pure function so the
 *  "no tools, cheapest mount" contract is unit-testable without a spawn. */
export function buildEscalationJudgeSpawnArgs(opts: {
  escalation: Escalation;
  mount: Mount;
  cwd: string;
  settingsFile: string;
}): SpawnWorkerArgs {
  return {
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    prompt: buildEscalationJudgePrompt(opts.escalation),
    model: opts.mount.model,
    effort: opts.mount.effort,
    maxTurns: opts.mount.maxTurns,
    tools: ESCALATION_JUDGE_TOOLS,
  };
}

/** Spawn the real judge and parse its verdict. Untested by unit (it shells out via the SDK, same
 *  as every other real spawn in worker.ts) — {@link buildEscalationJudgeSpawnArgs} and {@link
 *  parseEscalationJudgeVerdict} carry the testable contract. */
export async function spawnEscalationJudgeWorker(opts: {
  escalation: Escalation;
  mount: Mount;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): Promise<WorkerResult> {
  const spawn = opts.spawn ?? spawnWorker;
  return spawn(buildEscalationJudgeSpawnArgs(opts));
}

/**
 * Build a `judge` function ({@link EscalationJudgeDeps.judge}) wired to a real spawn on the
 * CHEAPEST configured mount — the filing's "one cheap-mount call per delivered escalation".
 * Reuses risk-judge.ts's {@link resolveRiskJudgeMount} rather than re-deriving the same
 * routing-table walk here: that resolver's logic (lowest tier/effort rank across every
 * configured mount) is generic, never risk-specific, despite its name.
 */
export function realEscalationJudge(opts: {
  mounts: Mounts;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): (e: Escalation) => Promise<EscalationJudgeVerdict> {
  const mount = resolveRiskJudgeMount(opts.mounts);
  return async (e: Escalation) => {
    const result = await spawnEscalationJudgeWorker({
      escalation: e,
      mount,
      cwd: opts.cwd,
      settingsFile: opts.settingsFile,
      spawn: opts.spawn,
    });
    return parseEscalationJudgeVerdict(result.text);
  };
}

/**
 * The PULL-REQUEST NUMBER an escalation issue names in its own text, or `undefined` (impl-DY).
 *
 * The escalation-lifecycle reconciler resolves a referent from the `**Task:** <id>` line and looks it up in
 * the plan. An id the plan does not own — a `TRIAGE-fb-…` minted outside the plan, a mount-probe id — has no
 * task to derive from, and PR #1041's `PR-<n>` escape only covers ids that were minted in that exact shape.
 * Everything else is dropped and can never be retired by the machine, however long ago its work landed. That
 * is how `TRIAGE-fb-1784732687221-3be743` (PR #707, merged 2026-07-24) and
 * `TRIAGE-fb-1784917146019-88250d` (PR #775, merged 2026-07-25) outlived a hand-cleanup of 55 siblings.
 *
 * The referent is not actually missing — {@link renderIssueBody} writes the PR as a FULL URL into the issue
 * text, so it can be read back. This reads the FIRST `/pull/<n>` in the given text.
 *
 * MATCHES A FULL URL ONLY, never a bare `#707`. On GitHub `#707` is ambiguous between an issue and a pull
 * request, and an escalation body routinely cites sibling issue numbers; resolving one of those as a PR would
 * retire a live escalation against an unrelated referent. A `/pull/<n>` path is unambiguous by construction.
 *
 * PURE. It answers "what does this issue SAY it is about", never "is that thing finished" — the caller joins
 * the number against live GitHub state and applies its own fail-closed policy.
 */
export function prReferentFromIssueText(text: string | undefined): number | undefined {
  const m = /\/pull\/(\d+)/.exec(text ?? "");
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Render the issue body: context, the options, and the recommendation called out.
 *
 * W1-T313: when `e.decisionSummary` validates, a "## Decision Summary" block (headline /
 * what-happened / the decision, imperative) renders ABOVE the raw `detail` — so the summary
 * rides the SAME GitHub-mobile push channel the operator sees the issue on first. `e.detail`
 * itself is untouched, byte-identical either way: the summary block is purely additive, never
 * a replacement. Re-validates `e.decisionSummary` here (not just trusting whatever a caller
 * attached) so this render path degrades to exactly today's raw-only body — fail-open, never
 * lossy — even if something upstream attached a malformed value. Options are DELIBERATELY not
 * repeated inside the summary block: the "## Options" section below already renders `e.options`
 * verbatim, and {@link summarizeEscalation} guarantees any decisionSummary's own `options`
 * equal that same list — duplicating them here would just be the same text twice.
 *
 * W1-T972: `**Host:**` names the machine whose process rendered THIS body — unconditional,
 * never optional like Run/Head/Cause below, because the defect it fixes is a reader on one
 * host unable to tell an issue about theirs from an issue about the other cell's (rationale
 * (2)/(3)): nine correct crash-loop escalations were followed to a healthy unit because
 * nothing on the issue said which machine it described. `os.hostname()` is called directly
 * (the same identity primitive the lock-holder records in drain-lock.ts/inflight-lock.ts/
 * review.ts already key `host` on) rather than threaded through `Escalation`, since the
 * value describes the RENDERING process, not a fact the caller composes.
 */
export function renderIssueBody(e: Escalation): string {
  const decisionSummary = validateDecisionSummary(e.decisionSummary ?? null);
  const lines = [
    `**Class:** ${e.class}`,
    `**Task:** ${e.taskId}`,
    `**Host:** ${hostname()}`,
    e.runId ? `**Run:** ${e.runId}` : undefined,
    // W1-T195: round-trip the composite dedup key's optional dimensions the SAME
    // way `**Task:**` already round-trips — {@link escalate}'s dup search reads
    // these back off a candidate OPEN issue's body via HEAD_SHA_LINE_RE/CAUSE_LINE_RE.
    // Omitted entirely (never a blank/placeholder line) when the caller didn't set
    // the field, so an un-migrated caller's issues render byte-identical to before.
    e.headSha ? `**Head:** ${e.headSha}` : undefined,
    e.cause ? `**Cause:** ${e.cause}` : undefined,
    "",
    ...(decisionSummary
      ? ["## Decision Summary", decisionSummary.headline, "", decisionSummary.what_happened, "", `**Decision:** ${decisionSummary.decision}`, ""]
      : []),
    e.detail,
    "",
    "## Options",
    ...e.options.map((o) => `- **${o.label}** — ${o.detail}`),
    "",
    "## Recommendation",
    e.recommendation,
    "",
    "_Opened automatically by Remudero (MASTER-PLAN §4 escalation taxonomy). Closing this issue does_",
    "_not resolve the underlying block by itself — act on it, then resume via `rmd drain`._",
  ].filter((l): l is string => l !== undefined);
  return lines.join("\n");
}

/**
 * Summarize ONE escalation into a {@link DecisionSummary}, FAIL-OPEN exactly like
 * feedback.ts's `summarizeFeedbackProposal` (a throw, a rejected promise, or an invalid
 * response all resolve to `null`, never propagate — never blocks escalation creation).
 * `options` is NEVER taken from the summarizer's own response: §4 already refuses an
 * escalation with no options, so this escalation ARRIVES with its own real options, and this
 * rung PASSES THEM THROUGH VERBATIM (mapped to the DecisionSummary option shape) rather than
 * trusting a paraphrase the model might invent (W1-T313 acceptance: "the options it renders
 * are the escalation's OWN options passed through verbatim, never paraphrased" — enforced HERE
 * as a code guarantee, not merely a prompt instruction the model could ignore).
 *
 * A caller wanting a decision summary on the issue calls this BEFORE {@link escalate}/{@link
 * tryEscalate} and attaches the result to `e.decisionSummary` — `escalate()` itself stays
 * synchronous and unchanged, so no existing call site is forced to become async by this task.
 */
export async function summarizeEscalation(e: Escalation, deps: SummarizeDeps): Promise<DecisionSummary | null> {
  try {
    const out = await deps.summarize({ context: `${e.summary}\n\n${e.detail}` });
    if (typeof out !== "object" || out === null) return null;
    const o = out as Record<string, unknown>;
    const composed = {
      headline: o.headline,
      what_happened: o.what_happened,
      decision: o.decision,
      options: e.options.map((opt) => ({ label: opt.label, consequence: opt.detail })),
    };
    return validateDecisionSummary(composed);
  } catch {
    return null;
  }
}

export interface EscalateDeps {
  issues: IssueGateway;
  ledgerPath: string;
  runId: string;
}

/**
 * Pull a PR reference out of free text — a full `.../pull/<n>` URL, or a bare
 * `PR #<n>` / `PR <n>` mention — and return just the number. Every current caller of
 * `escalate()` embeds one of these forms directly in `summary` or `detail` (the fix
 * rung's `${opts.prUrl}`, the clarification rung's `PR #${pr.prNumber}`, dep-review's
 * PR url, …), so this needs no new field on {@link Escalation} to key dedup on — the
 * CONTENT already carries it. Returns `undefined` when no PR is named (a task-level
 * escalation like the dispatch circuit breaker, or the GRILL/CLI paths) — those never
 * participate in dedup, exactly as before this task.
 */
function extractPrRef(text: string): string | undefined {
  return (
    /\/pull\/(\d+)\b/.exec(text)?.[1] ?? /\bPR\s*#(\d+)\b/i.exec(text)?.[1] ?? /\bPR\s+(\d+)\b/i.exec(text)?.[1]
  );
}

/**
 * W1-T1103 (design iii) — does `e.taskId`, AS WRITTEN, name a referent SOME lookup can retire?
 * `""` is deliberately excluded even though it is "a value": {@link renderIssueBody}'s `**Task:**
 * ${e.taskId}` line needs at least one non-whitespace character after the colon for {@link
 * "../run-task.js".buildEscalationReconcileCandidates}'s own `\S+` read to match at all — an
 * empty taskId renders a line the reconciler treats as ABSENT (its own `droppedNoTaskTrailer`
 * counter), which is rationale (5)'s `no_task_trailer: 2` measurement.
 *
 * `"undefined"`/`"null"` are the OTHER measured shape (rationale (5): "#2301, #2302 and #2304 ...
 * the body reads `Task undefined`") — the textbook symptom of a caller stringifying a missing
 * value (`` `${maybeUndefined}` ``) into something that satisfies `Escalation.taskId`'s `string`
 * type at compile time while carrying no real referent at runtime. Neither string is a shape any
 * real task id or GRILL's `TRIAGE-<feedbackId>` id ever takes, so excluding them cannot misfire
 * on a legitimate caller.
 *
 * Real, resolvable non-plan ids — GRILL's `TRIAGE-fb-…`, the daemon-lane escalations' fixed
 * task-level ids — are left alone: this function's caller ({@link resolvedTaskId}) only ever
 * reaches its PR-referent fallback when THIS predicate is false, and neither of those shapes is.
 */
function isKnownBrokenTaskId(taskId: string): boolean {
  const trimmed = taskId.trim();
  return trimmed === "" || trimmed === "undefined" || trimmed === "null";
}

/**
 * W1-T1103 (design iii) — RESOLVE A REFERENT OR SAY SO. Returns the taskId {@link escalate}/
 * {@link escalateWithJudge} should actually render, or `undefined` when NOTHING resolvable is
 * available — the caller refuses to open rather than mint a permanent operator obligation
 * (rationale (5): "nothing links a merge to an issue, so terminality of the referent is
 * unreachable when the referent itself is unresolvable").
 *
 * `e.taskId` passes through BYTE-IDENTICAL whenever it is not one of the known-broken sentinel
 * shapes {@link isKnownBrokenTaskId} names — every existing caller (a real plan task id, GRILL's
 * `TRIAGE-<feedbackId>`, a daemon-lane fixed id) is completely unaffected by this task.
 *
 * Only a KNOWN-BROKEN taskId falls to the PR-referent fallback — the SAME `extractPrRef` scan
 * {@link findDuplicateEscalation}'s dedup already runs over `${e.summary}\n${e.detail}` (never a
 * second, independently-drifting text scan), rendered as the `PR-<n>` synthetic shape
 * `buildEscalationReconcileCandidates` (run-task.ts) ALREADY resolves via a bare PR-number lookup
 * — no plan entry required, and no dependence on the rendered body ALSO happening to carry a full
 * `/pull/<n>` URL the way {@link prReferentFromIssueText}'s OWN fallback needs.
 */
function resolvedTaskId(e: Escalation): string | undefined {
  if (!isKnownBrokenTaskId(e.taskId)) return e.taskId;
  const prRef = extractPrRef(`${e.summary}\n${e.detail}`);
  return prRef ? `PR-${prRef}` : undefined;
}

/** The `**Task:** <id>` line {@link renderIssueBody} writes on every issue — the same
 *  regex the escalation-lifecycle reconciler (run-task.ts) already reads task ids with. */
const TASK_LINE_RE = /^\*\*Task:\*\*\s*(\S+)\s*$/m;

/** The `**Class:** <class>` line {@link renderIssueBody} writes UNCONDITIONALLY on every issue
 *  (never optional, unlike Head/Cause below) — the second dimension of the W1-T345 referent-less
 *  dedup key, read back exactly like {@link TASK_LINE_RE}. */
const CLASS_LINE_RE = /^\*\*Class:\*\*\s*(\S+)\s*$/m;

/** The `**Head:** <sha>` line {@link renderIssueBody} writes ONLY when {@link Escalation.headSha}
 *  is set (W1-T195) — absent on every issue predating this task or opened by an un-migrated caller. */
const HEAD_SHA_LINE_RE = /^\*\*Head:\*\*\s*(\S+)\s*$/m;

/** The `**Cause:** <review|ci|conflict>` line {@link renderIssueBody} writes ONLY when
 *  {@link Escalation.cause} is set (W1-T195) — same absent-by-default discipline as
 *  {@link HEAD_SHA_LINE_RE}. */
const CAUSE_LINE_RE = /^\*\*Cause:\*\*\s*(\S+)\s*$/m;

/**
 * Does an OPTIONAL composite-key dimension veto a dedup match? A dimension only vetoes
 * when BOTH sides carry a value and they DISAGREE — either side missing means that
 * dimension says nothing (permissive), which is exactly what keeps every un-migrated
 * caller's dedup behavior (taskId + PR only) unchanged by this task (W1-T195).
 */
function matchesOptionalDimension(wanted: string | undefined, candidate: string | undefined): boolean {
  return wanted === undefined || candidate === undefined || wanted === candidate;
}

/**
 * Open a labeled GitHub issue for one escalation + log the ledger line. Returns the
 * issue URL. An escalation with zero options is refused — bare alerts with no
 * actionable choice are exactly what this taxonomy exists to avoid (§4).
 *
 * DEDUP LIVES HERE, IN THE TRANSPORT (W1-T104 — the #178/#180 duplicate): a sweep
 * escalation and a drain-path exhaustion escalation for the SAME (task, PR) used to
 * each open their own issue, because each caller deduped only against ITS OWN prior
 * actions (different title templates, different ledger keys) and never saw the
 * other's issue. The fix is a single content-keyed check inside `escalate()` itself,
 * so EVERY caller inherits it by construction rather than re-implementing it. TWO
 * matching modes, chosen by whether a PR reference resolves out of this escalation's
 * own summary/detail text:
 *
 *   PR-KEYED (unchanged since W1-T195): key = (taskId, the PR number found in
 *     summary/detail, and {@link Escalation.headSha}/{@link Escalation.cause} when the
 *     caller set them). headSha/cause are matched permissively (see
 *     {@link matchesOptionalDimension}): they veto a match only when BOTH sides carry
 *     a value and disagree, so an un-migrated caller's dedup is unchanged (taskId + PR
 *     only) while the two rungs that DO set them (the fix rung's strike-exhaustion
 *     escalate and the clarification rung's blocked-ambiguous escalate) get the real
 *     fix W1-T195 exists for: a new push (new headSha) or a different cause on the
 *     same sha each open their own issue instead of being silenced by a stale one.
 *
 *   REFERENT-LESS (W1-T345 — the #1220 "dispatch queue starved" storm, SEVEN
 *     byte-identical siblings #1223-#1271, one per daemon tick the condition held):
 *     no PR resolves for a daemon/queue-level escalation (escalateStarvation,
 *     escalateCrashLoop, escalateCircuitBreak, escalateLifetimeCapExceeded,
 *     escalateHeadroomReserve — none of these name a PR), so key = (taskId, class,
 *     cause). class is matched EXACTLY, never permissively — it is always rendered
 *     (never optional, unlike headSha/cause) so every candidate carries a value.
 *     cause is matched permissively exactly like the PR-keyed path — DISTINCT causes
 *     on the same (taskId, class) still open separately (W1-T195's discipline
 *     extends, it does not collapse). When NEITHER side sets a cause (every current
 *     referent-less producer), the fallback discriminator is the rendered title's
 *     summary text: it is a fixed, per-producer-constant phrase (escalateStarvation's
 *     "dispatch queue starved…" vs escalateCrashLoop's "daemon crash-loop…"), so two
 *     DIFFERENT producers sharing one (taskId, class) — e.g. "DAEMON"/BLOCKED for
 *     both crash-loop and post-review-stall — never collide into each other's issue,
 *     while the SAME producer's repeated firing (the storm shape) does dedup.
 *
 *   Both modes:
 *   - search OPEN `needs-human` issues (never closed ones — a closed issue recorded a
 *     human's resolution, and a fresh escalation on a recurrence must NOT be silenced
 *     by it) whose `**Task:**` line matches this escalation's taskId.
 *   - found -> append THIS caller's own summary/detail as a comment (never dropped —
 *     the second observer often knows something the first did not) and ledger
 *     `escalation.deduped` instead of creating a sibling.
 *   - not found -> create exactly as before.
 * A `listOpen` read failure (or a gateway that omits `listOpen` altogether) falls
 * through to the ordinary create path — dedup is a best-effort nicety, and must never
 * be the reason a real escalation goes undelivered.
 *
 * ENSURE-LABELS, DEGRADE DON'T LOSE (W1-T99): every wanted label is passed through
 * `deps.issues.ensureLabel` first (a gateway lacking that method is treated as
 * "already exists"). A label whose provisioning fails is DROPPED from the `create()`
 * call rather than taking the whole issue down with it — the payload (the options +
 * recommendation a human needs to act on) outranks its label decoration. The drop is
 * never silent: it's noted both in the issue body and on this escalation's ledger
 * line as `degraded_labels`.
 */
/**
 * Search OPEN `needs-human` issues for a duplicate of `e` — extracted from {@link escalate} so
 * {@link escalateWithJudge} can run the IDENTICAL search once, up front, to decide whether the
 * judge should even be asked (design clause i: "never judging a duplicate"). Returns the matched
 * {@link OpenIssue}, or `undefined` when no gateway `listOpen`, a failed read, or no match — the
 * SAME best-effort, fail-open-to-"no dup found" contract {@link escalate} always had.
 */
function findDuplicateEscalation(e: Escalation, deps: EscalateDeps): OpenIssue | undefined {
  if (!deps.issues.listOpen) return undefined;
  let open: OpenIssue[];
  try {
    open = deps.issues.listOpen(NEEDS_HUMAN_LABEL);
  } catch {
    return undefined; // best-effort dedup: a failed read must never block the escalation itself
  }
  const prRef = extractPrRef(`${e.summary}\n${e.detail}`);
  const title = `[${e.class}] ${e.taskId}: ${e.summary}`;
  return open.find((issue) => {
    const body = issue.body ?? "";
    if (TASK_LINE_RE.exec(body)?.[1] !== e.taskId) return false;
    if (prRef) {
      // W1-T195: the composite key. taskId + PR are REQUIRED matches (unchanged
      // from W1-T104). headSha/cause are matched via matchesOptionalDimension — a
      // dimension only vetoes the match when BOTH this escalation and the
      // candidate issue carry a value and they disagree, so a caller that never
      // sets headSha/cause (every caller except the two rungs this task wires)
      // keeps today's (taskId, PR) dedup exactly as before. A caller that DOES set
      // both, on the other hand, gets the real fix: a new push (new headSha) or a
      // different cause on the same sha each open their OWN issue rather than
      // being silently suppressed by a stale one.
      if (extractPrRef(`${issue.title ?? ""}\n${body}`) !== prRef) return false;
      if (!matchesOptionalDimension(e.headSha, HEAD_SHA_LINE_RE.exec(body)?.[1])) return false;
      if (!matchesOptionalDimension(e.cause, CAUSE_LINE_RE.exec(body)?.[1])) return false;
      return true;
    }
    // W1-T345: no PR resolves — dedup on (taskId, class, cause) instead of
    // skipping the search outright. class is REQUIRED equal (it is always
    // rendered, never optional). cause is matched permissively, same discipline
    // as the PR-keyed branch above: distinct causes on the same (taskId, class)
    // still open separately. When neither side names a cause, fall back to
    // comparing the rendered title verbatim — its summary segment is a fixed,
    // per-producer-constant phrase, so two different referent-less producers
    // sharing one (taskId, class) never collide into each other's issue while the
    // SAME producer's repeated firing (the storm shape) does dedup.
    if (CLASS_LINE_RE.exec(body)?.[1] !== e.class) return false;
    const candidateCause = CAUSE_LINE_RE.exec(body)?.[1];
    if (e.cause !== undefined || candidateCause !== undefined) {
      return matchesOptionalDimension(e.cause, candidateCause);
    }
    return (issue.title ?? "") === title;
  });
}

/**
 * Append the DEDUP comment + `escalation.deduped` ledger line for an already-found duplicate —
 * extracted from {@link escalate} so {@link escalateWithJudge} shares the exact same behavior on
 * its own dedup path (never a second `listOpen` read: both callers pass the SAME {@link
 * findDuplicateEscalation} result in).
 */
function recordDuplicateEscalation(e: Escalation, dup: OpenIssue, deps: EscalateDeps): string {
  const prRef = extractPrRef(`${e.summary}\n${e.detail}`);
  const observedKey = prRef
    ? `task ${e.taskId}, PR #${prRef}`
    : `task ${e.taskId}, class ${e.class}${e.cause ? `, cause ${e.cause}` : ""}`;
  deps.issues.comment?.(
    dup.url,
    `Another escalation observed the same condition (${observedKey}) while this issue ` +
      `was already open — appending rather than opening a sibling (W1-T104/W1-T345).\n\n${renderIssueBody(e)}`,
  );
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: e.taskId,
    step: "escalation.deduped",
    class: e.class,
    issue_url: dup.url,
  });
  return dup.url;
}

/**
 * Ensure labels, render the body, create the issue, and ledger it — extracted from {@link
 * escalate} so {@link escalateWithJudge} can create a FLEET-NOTICE-labelled issue (W1-T349)
 * through the exact same label-provisioning/degrade-don't-lose machinery (W1-T99) instead of a
 * second, drifting copy. `opts.queueLabel` is the only thing that varies between a needs-human
 * open and a demoted one — everything else (title, class label, ask-type label, body, degrade
 * behavior) is byte-identical either way.
 *
 * W1-T1103 (design ii) — `opts.queueLabel` IS NEVER DEGRADED, unlike the class/ask-type labels
 * below. The measured board (rationale (4)) found six open issues carrying NO label at all —
 * `RETIRABLE_ESCALATION_LABELS` (sweep.ts) is the ONLY thing the reconciler filters open issues
 * on, so a queue-label-less issue is invisible to it forever, whatever its class/ask-type labels
 * say. `ensureLabel` is still attempted first (the common "never provisioned on this repo yet"
 * case self-heals silently, same as before), but its return value is never consulted for this
 * one label: it is unconditionally the first entry `create()` receives. The falsifier is the
 * PROPERTY (W1-T99's own doc, quoted in the task rationale: "the falsifier is the property, not
 * the path"), so this can no longer be a per-call race with whatever `ensureLabel` happened to
 * answer that pass. A repo where this label genuinely cannot be attached fails `create()` itself
 * — `escalate()`'s documented throw contract, degraded by `tryEscalate` to `escalation.failed` —
 * which is a VISIBLE, retriable failure, never a silent, permanently un-retirable issue.
 */
function createEscalationIssue(
  e: Escalation,
  deps: EscalateDeps,
  opts: { queueLabel: string; step: string; firstComment?: string; extra?: Record<string, unknown> },
): string {
  const title = `[${e.class}] ${e.taskId}: ${e.summary}`;
  deps.issues.ensureLabel?.(opts.queueLabel);
  const wanted = [CLASS_LABEL[e.class], ASK_TYPE_LABEL[classifyAsk(e)]];
  const labels: string[] = [opts.queueLabel];
  const degradedLabels: string[] = [];
  for (const label of wanted) {
    if (!deps.issues.ensureLabel || deps.issues.ensureLabel(label)) {
      labels.push(label);
    } else {
      degradedLabels.push(label);
    }
  }
  let body = renderIssueBody(e);
  if (degradedLabels.length > 0) {
    body +=
      `\n\n_Degraded: label(s) ${degradedLabels.join(", ")} could not be provisioned on this repo — ` +
      `this issue was opened without them so the escalation itself is never lost (W1-T99)._`;
  }
  const url = deps.issues.create(title, body, labels);
  if (opts.firstComment) {
    // W1-T349 design clause (ii): a demoted item's judge reason rides as the FIRST comment —
    // posted immediately after create(), before anything else can land on the issue.
    deps.issues.comment?.(url, opts.firstComment);
  }
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: e.taskId,
    ...(degradedLabels.length > 0 ? { degraded_labels: degradedLabels } : {}),
    step: opts.step,
    class: e.class,
    issue_url: url,
    labels,
    ...opts.extra,
  });
  return url;
}

/**
 * W1-T1103 (design iii) — shared refuse-or-normalize step for {@link escalate}/{@link
 * escalateWithJudge}: both cross this BEFORE the dedup search runs, mirroring the existing
 * zero-options refusal immediately above each of their call sites, so a caller can never observe
 * a partially-opened escalation whose Task field is a known-broken sentinel. Returns `e`
 * unchanged when its own taskId already resolves — every existing caller (a real plan task id,
 * GRILL's `TRIAGE-<feedbackId>`, a daemon-lane fixed id) is untouched by this task. Returns a
 * COPY with taskId replaced by the `PR-<n>` synthetic referent when only that fallback resolves,
 * so the dedup search, the judge prompt, and the rendered issue body all see the SAME normalized
 * value — never the broken one a caller happened to pass in.
 */
function refuseUnlessResolvable(e: Escalation): Escalation {
  const resolved = resolvedTaskId(e);
  if (resolved === undefined) {
    throw new Error(
      `escalation (class ${e.class}, "${e.summary}") carries no resolvable referent — its Task field is ` +
        `${JSON.stringify(e.taskId)} and no PR is nameable in its own summary/detail — refusing to open an ` +
        `issue no lookup could ever retire (W1-T1103)`,
    );
  }
  return resolved === e.taskId ? e : { ...e, taskId: resolved };
}

export function escalate(e: Escalation, deps: EscalateDeps): string {
  if (e.options.length === 0) {
    throw new Error(`escalation for ${e.taskId} has no options — every escalation needs an actionable choice`);
  }
  const resolved = refuseUnlessResolvable(e);
  const dup = findDuplicateEscalation(resolved, deps);
  if (dup) return recordDuplicateEscalation(resolved, dup, deps);
  return createEscalationIssue(resolved, deps, { queueLabel: NEEDS_HUMAN_LABEL, step: "escalation.issue_opened" });
}

/**
 * W1-T349: THE JUDGED CHOKE POINT — {@link escalate} plus the residual escalation judge. Producers
 * that want judge routing call this instead of {@link escalate}; a producer that doesn't (every
 * producer this task does not wire — NOT IN SCOPE per this task's own design clause) keeps calling
 * {@link escalate}/{@link tryEscalate} directly and gets exactly today's needs-human behavior,
 * unjudged — the same opt-in shape {@link escalateWithSummary} already established for W1-T348.
 *
 * ORDER MATTERS: dedup runs FIRST via the exact same {@link findDuplicateEscalation} search
 * `escalate()` itself uses — the judge NEVER sees a duplicate (design clause i). Only once dedup
 * finds nothing does {@link judgeEscalation} run (which itself never asks the judge dependency for
 * an exempt class, MANUAL/GRILL — see that function's own doc). A `demote` verdict opens the issue
 * FLEET-NOTICE-labelled with the judge's reason as the first comment (design clause ii); anything
 * else — `deliver`, an exempt class, or a judge failure (fail-open) — opens it needs-human-labelled,
 * byte-identical to {@link escalate}.
 */
export async function escalateWithJudge(
  e: Escalation,
  deps: EscalateDeps & EscalationJudgeDeps,
): Promise<string> {
  if (e.options.length === 0) {
    throw new Error(`escalation for ${e.taskId} has no options — every escalation needs an actionable choice`);
  }
  const resolved = refuseUnlessResolvable(e);
  const dup = findDuplicateEscalation(resolved, deps);
  if (dup) return recordDuplicateEscalation(resolved, dup, deps);

  const verdict = await judgeEscalation(resolved, deps);
  if (verdict.decision === "demote") {
    return createEscalationIssue(resolved, deps, {
      queueLabel: FLEET_NOTICE_LABEL,
      step: "escalation.demoted",
      firstComment: verdict.reason,
      extra: { judge_reason: verdict.reason },
    });
  }
  return createEscalationIssue(resolved, deps, { queueLabel: NEEDS_HUMAN_LABEL, step: "escalation.issue_opened" });
}

/**
 * NON-THROWING escalation, for callers inside a SUPERVISED LOOP.
 *
 * `escalate()` reaches GitHub through `gh issue create` via execFileSync, which throws on any
 * nonzero exit — a rate-limit, an expired token, a network partition. That contract is right for
 * a one-shot command (a failed escalation should fail the run loudly), and wrong inside
 * `rmd daemon`'s `for(;;)`, where the throw is not contained: an uncaught escalation ends the
 * PROCESS, launchd's KeepAlive{SuccessfulExit:false} reads the nonzero exit as a crash and
 * relaunches, the fresh process re-selects the same circuit-broken task, escalates, and throws
 * again. Observed 2026-07-21 04:02-04:13 as one boot per minute (460 `daemon.boot` lines since
 * Jul 19) — the SECOND boot-loop cause, distinct from W1-T197's headroom exit-1 loop, and NOT
 * headroom: that window is post-reset.
 *
 * Returns the issue URL, or `null` when the escalation could not be delivered. Never throws.
 * A failure is recorded on its own `escalation.failed` ledger step, so an undelivered
 * escalation is degraded and legible rather than silent.
 *
 * NOTE: this also catches `escalate()`'s zero-options programming error. That is deliberate —
 * inside a supervised loop even a bug in the escalation payload must not take the fleet down;
 * the `escalation.failed` line carries the message.
 */
export function tryEscalate(e: Escalation, deps: EscalateDeps): string | null {
  try {
    return escalate(e, deps);
  } catch (err) {
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: e.taskId,
      step: "escalation.failed",
      class: e.class,
      error: String((err as Error)?.message ?? err),
    });
    return null;
  }
}

/** {@link EscalateDeps} plus the one extra dependency {@link escalateWithSummary} needs. */
export interface EscalateWithSummaryDeps extends EscalateDeps, SummarizeDeps {}

/**
 * W1-T348: THE CHOKE POINT — compose {@link summarizeEscalation} + {@link escalate} into the
 * ONE call an await-capable producer makes at escalation-creation time, mirroring why dedup
 * itself lives inside `escalate()` rather than being reimplemented per caller (see that
 * function's own doc above): a caller that switches to this wrapper inherits summary
 * generation "by construction" instead of hand-composing the two calls (and risking forgetting
 * the `decisionSummary` attach `summarizeEscalation`'s own doc describes). Fail-open is
 * inherited unchanged from `summarizeEscalation` — a throw, a rejected promise, or an invalid
 * response resolve to `null`, so a summarizer outage degrades to exactly today's raw-body
 * issue, never a lost or delayed escalation.
 *
 * NOT every producer switches to this: the handful of SYNCHRONOUS dispatch-loop breaker
 * callbacks (`escalateCircuitBreak` and its siblings, run-task.ts) cannot await without
 * making their callback interface async, so they keep calling `escalate`/`tryEscalate`
 * directly and simply never attach a decisionSummary — the documented fail-open default,
 * since `Escalation.decisionSummary` is optional.
 */
export async function escalateWithSummary(e: Escalation, deps: EscalateWithSummaryDeps): Promise<string> {
  const decisionSummary = await summarizeEscalation(e, deps);
  return escalate({ ...e, decisionSummary }, deps);
}

/**
 * Real gateway: `gh issue create`, scoped to `owner/repo`. Runs outside the sandbox
 * (gh is documented to fail TLS verification under Seatbelt, §4A) but still inside
 * bypass + the deny-hook floor, carrying only the scoped PAT.
 *
 * `ensureLabel` provisions the label via `gh label create ... --force` (create-or-update,
 * so an existing label is a no-op rather than an error — the "tolerate-exists" half of
 * W1-T99's design) BEFORE `create()` is ever asked to attach it. A hard failure (no repo
 * access, rate-limited, network partition) returns false so `escalate()` degrades that one
 * label instead of losing the whole issue to it — the 2026-07-17 incident this task fixes.
 *
 * `opts.exec` (mirrors {@link ghGateway} in status.ts, W1-T119) is an INJECTABLE stand-in
 * for the raw `gh` invocation — real callers omit it and get the actual
 * `execFileSync("gh", args, ...)` call; unit tests inject a fake that returns a canned
 * string or throws, so both `ensureLabel`'s tolerate-failure branch and `create`'s URL
 * plumbing are exercised deterministically WITHOUT shelling out.
 */
export function ghIssueGateway(
  owner: string,
  repo: string,
  opts: { exec?: (args: string[]) => string } = {},
): IssueGateway {
  const repoArg = `${owner}/${repo}`;
  const run =
    opts.exec ??
    ((args: string[]) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  return {
    ensureLabel(label) {
      try {
        run(["label", "create", label, "--repo", repoArg, "--color", "ededed", "--force"]);
        return true;
      } catch {
        return false;
      }
    },
    create(title, body, labels) {
      assertLiveWriteAllowed("gh-issue-create", `filing an issue on ${repoArg}`);
      const args = ["issue", "create", "--repo", repoArg, "--title", title, "--body", body];
      for (const label of labels) args.push("--label", label);
      return run(args).trim();
    },
    listOpen(label) {
      // OPEN issues only, with body (carries `**Task:** <id>`). Read over REST's `/issues`
      // endpoint, NOT `gh issue list --label`: the latter routes label filtering through
      // GitHub's GraphQL `search()` connection, which is throttled account-wide here and made
      // this read fail 100% of the time (the reconciler saw "zero open" every tick while 79
      // needs-human issues were open). The pre-REST comment here claimed this was "never a
      // full-text search" — it was, via `gh`'s own implementation; that is now literally true.
      // THROWS on a `gh` failure (the caller degrades to no action this cycle, never "zero open").
      return parseLabelledIssuesRest(run(labelledIssuesRestArgs(repoArg, label, "open")));
    },
    closeWithComment(url, comment) {
      run(["issue", "close", url, "--repo", repoArg, "--comment", comment]);
    },
    comment(url, body) {
      run(["issue", "comment", url, "--repo", repoArg, "--body", body]);
    },
  };
}
