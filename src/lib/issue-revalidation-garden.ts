/**
 * lib/issue-revalidation-garden.ts — the issue-revalidation garden (W1-T8864).
 *
 * THE GAP THIS CLOSES. The escalation reconciler (`runEscalationReconcile`, lib/sweep.ts) closes an
 * issue only when its task or PR referent went terminal, so issues with no referent, and hand-filed ones,
 * were never read again (measured in W1-T8864's rationale). This garden reads EVERY open issue, asks "is
 * the condition still true?" of CURRENT evidence for its class, and records one verdict per issue:
 *   resolved        positive evidence the condition is gone (a citation is required)
 *   still-true      the condition holds now
 *   convert-to-task the issue names work no plan task owns
 *   unknown         the evidence could not be read, or does not decide it
 *
 * SHADOW FIRST. `issueRevalidation.mode` (plan/policy.yaml) ships as "shadow": every verdict and the
 * action it WOULD take is ledgered as {@link ISSUE_REVALIDATION_VERDICT_STEP}, and nothing is written to
 * GitHub. The operator flips it to "act" once the shadow table is right (operator ruling 2026-10-13).
 *
 * GUARDRAILS, held in both modes so the shadow table shows exactly what act would do:
 *   - only a `resolved` verdict with a citation can close an issue;
 *   - a MANUAL capacity decision or an open GRILL is never closed (a still-true refresh at most);
 *   - an issue whose newest operator comment is newer than the newest bot comment is never touched;
 *   - at most `maxClosesPerPass` closes a pass; an unknown or unreadable probe always keeps the issue.
 * Each producer closing its own issue on recovery is W1-T8866's; this garden is the backstop for the
 * residue no producer owns.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { attemptAssignmentJoin, benchmarkEvidenceLedgerPath, benchmarkNonDispatchSpawn, benchmarkWorkerAttemptResources, withReceiptIdentity } from "./benchmark-run.js";
import type { Config } from "./config.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { ghIssueGatewayAsync, splitConcatenatedJsonPages, type AsyncIssueGateway } from "./escalate.js";
import { feedbackCaptured, stageFeedbackCapture } from "./feedback.js";
import { overseerStatePath } from "./gardener-overseer.js";
import { ghTextAsync } from "./github-transport.js";
import { issueFeedbackId, renderIssueRaw } from "./issues-intake.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { appendLedger } from "./ledger.js";
import type { Mount } from "./mounts.js";
import { installPolicyPath } from "./policy.js";
import type { spawnWorker, WorkerResult } from "./worker.js";
import { hostWorktreeGit } from "./worktree-git.js";

export const ISSUE_REVALIDATION_VERDICT_STEP = "issue_revalidation.verdict";
export const ISSUE_REVALIDATION_PASS_STEP = "issue_revalidation.pass";
export const ISSUE_REVALIDATION_FAILED_STEP = "issue_revalidation.failed";
export const ISSUE_REVALIDATION_ACTION_FAILED_STEP = "issue_revalidation.action_failed";

/** The garden's timer floor: one pass an hour at most, slower while passes find nothing new. */
export const ISSUE_REVALIDATION_MIN_INTERVAL_MS = 60 * 60 * 1000;
/** A still-true issue gets a dated refresh comment at most this often. */
export const STILL_TRUE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** PRIMARY CONTROL: model judgements per pass. Each is a spawn, so a large backlog drains over several
 *  passes instead of spending an unbounded number of spawns in one; a healthy backlog is that large. */
export const MAX_ISSUE_REVALIDATION_JUDGES_PER_PASS = 10;
/** PRIMARY CONTROL: an escalation opened or re-observed by the fleet this recently is live, whatever the
 *  judge says (W1-T9181: #10269 was re-observed 4 h before a pass judged it resolved). The same 48 h the
 *  evidence pack's ledger counts cover. */
export const ISSUE_REVALIDATION_REOBSERVED_WINDOW_MS = 48 * 60 * 60 * 1000;
/** A dotted ledger step name, hyphens kept (`ci-friction.garden_filing_failed`), never one continuing a
 *  path or a longer word (a shard path's `tasks.d`). W1-T9181. */
const LEDGER_STEP_NAME = /(?<![\w./-])([a-z][a-z0-9_-]*\.[a-z_]+(?:\.[a-z_]+)?)(?![\w/-])/g;
const LEDGER_STEP_NAME_WHOLE = /^[a-z][a-z0-9_-]*\.[a-z_]+(?:\.[a-z_]+)?$/;
/** A READ-MODEL issue is resolved only on at least this many consecutive clean consistency runs. */
export const READ_MODEL_CLEAN_RUNS = 6;
/** The overseer's state must be at most this old for its liveness view to count as current. */
export const OVERSEER_STATE_FRESH_MS = 3 * 60 * 60 * 1000;

// ── Policy ───────────────────────────────────────────────────────────────────────────────────────

export type IssueRevalidationMode = "off" | "shadow" | "act";
export const ISSUE_REVALIDATION_MODES: readonly IssueRevalidationMode[] = ["off", "shadow", "act"];

export interface IssueRevalidationPolicy {
  mode: IssueRevalidationMode;
  maxClosesPerPass: number;
}

function mapping(path: string, raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`policy.yaml: '${path}' must be a mapping.`);
  }
  return raw as Record<string, unknown>;
}

/** Validate `issueRevalidation`. The mode accepts only "off", "shadow" or "act"; the close cap is an
 *  integer inside its own committed [min, max]. Anything else throws, so a typo never acts. */
export function parseIssueRevalidationPolicy(raw: unknown): IssueRevalidationPolicy {
  const block = mapping("issueRevalidation", raw);
  const modeRow = mapping("issueRevalidation.mode", block.mode);
  if (!ISSUE_REVALIDATION_MODES.includes(modeRow.value as IssueRevalidationMode)) {
    throw new Error(`policy.yaml: 'issueRevalidation.mode' accepts only "off", "shadow" or "act", got ${JSON.stringify(modeRow.value)}.`);
  }
  const capRow = mapping("issueRevalidation.maxClosesPerPass", block.maxClosesPerPass);
  const { value, min, max } = capRow;
  if (typeof value !== "number" || typeof min !== "number" || typeof max !== "number" ||
    ![value, min, max].every(Number.isInteger) || value < min || value > max) {
    throw new Error("policy.yaml: 'issueRevalidation.maxClosesPerPass' must be an integer inside integer [min, max].");
  }
  return { mode: modeRow.value as IssueRevalidationMode, maxClosesPerPass: value };
}

/** The shipped `issueRevalidation` block. Throws on an invalid block; the garden pass catches it. */
export function loadIssueRevalidationPolicy(path: string = installPolicyPath()): IssueRevalidationPolicy {
  const doc = mapping("policy.yaml", parseYaml(readFileSync(path, "utf8")));
  return parseIssueRevalidationPolicy(doc.issueRevalidation);
}

// ── Issues and their classes ─────────────────────────────────────────────────────────────────────

export interface RevalidationIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RevalidationComment {
  authorLogin: string;
  authorType: string;
  authorAssociation: string;
  createdAt: string;
  /** The comment's text; absent in fixtures that only test authorship. */
  body?: string;
}

/** REST `/issues?state=open` rows, pull requests dropped, labels and times kept. THROWS on a malformed
 *  payload, which the pass treats as "do nothing this pass", never as "nothing is open". */
export function parseOpenIssuesRest(raw: string): RevalidationIssue[] {
  const rows = splitConcatenatedJsonPages(raw).flatMap((chunk) => {
    const page = JSON.parse(chunk) as unknown;
    if (!Array.isArray(page)) throw new Error(`parseOpenIssuesRest: expected a JSON array page, got ${typeof page}`);
    return page as Array<Record<string, unknown>>;
  });
  return rows
    .filter((r) => r.pull_request === undefined)
    .map((r) => ({
      number: Number(r.number),
      url: String(r.html_url ?? ""),
      title: String(r.title ?? ""),
      body: String(r.body ?? ""),
      labels: Array.isArray(r.labels)
        ? r.labels.map((l) => (typeof l === "string" ? l : String((l as { name?: unknown })?.name ?? ""))).filter(Boolean)
        : [],
      createdAt: String(r.created_at ?? ""),
      updatedAt: String(r.updated_at ?? ""),
    }));
}

/** The REST argv for every open issue (no label filter), paginated. */
export function openIssuesRestArgs(owner: string, repo: string): string[] {
  return ["api", `repos/${owner}/${repo}/issues?state=open&per_page=100`, "--paginate"];
}

export type IssueClass =
  | "referent" | "liveness" | "read-model" | "memory-capacity" | "main-repair" | "live-edits" | "triage"
  | "clock-sweep" | "escalation" | "hand-filed";

/** The `**Task:**` an escalation body names ({@link "./escalate.js".renderIssueBody}), if any. */
export function issueTaskId(issue: Pick<RevalidationIssue, "body">): string | undefined {
  return /^\*\*Task:\*\*\s*(\S+)\s*$/m.exec(issue.body)?.[1];
}

/** The `**Class:**` an escalation body names: MANUAL, GRILL, BLOCKED, HARD_STOP... */
export function issueEscalationClass(issue: Pick<RevalidationIssue, "body">): string | undefined {
  return /^\*\*Class:\*\*\s*(\S+)\s*$/m.exec(issue.body)?.[1];
}

/** Classify one issue. Producer classes are named by the task id their producer mints; an escalation
 *  with a plan-task or PR referent is the reconciler's shape; an issue with no `**Class:**` line was
 *  filed by hand. `hasReferent` is the reconciler's own derivation (plan task, `PR-<n>`, or a PR URL). */
export function classifyIssue(issue: RevalidationIssue, hasReferent: (issue: RevalidationIssue) => boolean): IssueClass {
  if (/^clock-sweep:/i.test(issue.title)) return "clock-sweep";
  const taskId = issueTaskId(issue) ?? "";
  if (/-gardener-liveness$/.test(taskId)) return "liveness";
  if (/^READ-MODEL-/.test(taskId)) return "read-model";
  if (/^MEMORY-CAPACITY-/.test(taskId)) return "memory-capacity";
  if (/^main-repair/i.test(taskId)) return "main-repair";
  if (/^LIVE-EDITS/i.test(taskId)) return "live-edits";
  if (issueEscalationClass(issue) === undefined) return "hand-filed";
  if (hasReferent(issue)) return "referent";
  if (/^TRIAGE-/.test(taskId)) return "triage";
  return "escalation";
}

// ── Verdicts and actions ─────────────────────────────────────────────────────────────────────────

export type RevalidationVerdictKind = "resolved" | "still-true" | "convert-to-task" | "unknown";

export interface RevalidationVerdict {
  verdict: RevalidationVerdictKind;
  reason: string;
  /** Required for `resolved`: the evidence a reader can check. A `resolved` without one is unknown. */
  citation?: string;
}

export type RevalidationAction = "close" | "refresh" | "convert" | "keep";

/** Why a verdict's natural action was withheld, or `undefined` when nothing withheld it. */
export type RevalidationGuard =
  | "operator-owned-class" | "newer-operator-comment" | "no-citation" | "close-cap" | "refresh-not-due"
  | "comments-unread" | "absence-only-citation" | "condition-reobserved";

export interface PriorVerdict {
  verdict: RevalidationVerdictKind;
  at: string;
  /** The issue's `updatedAt` the verdict was reached on: an unchanged issue is not judged again. */
  issueUpdatedAt?: string;
  action?: RevalidationAction;
  /** Whether that row's action was performed (act mode) rather than only recorded (shadow). */
  acted?: boolean;
  reason?: string;
  citation?: string;
}

const OPERATOR_OWNED_CLASSES = new Set(["MANUAL", "GRILL"]);
const BOT_SUFFIX = /\[bot\]$/i;

/** Whether a comment's author is a human operator: a configured operator login when a list is set,
 *  else the repository OWNER; never a bot. */
export function isOperatorComment(c: RevalidationComment, operatorLogins: readonly string[] | undefined): boolean {
  if (c.authorType.toLowerCase() === "bot" || BOT_SUFFIX.test(c.authorLogin)) return false;
  if (operatorLogins !== undefined) return operatorLogins.some((l) => l.toLowerCase() === c.authorLogin.toLowerCase());
  return c.authorAssociation === "OWNER";
}

/** The operator's newest comment is newer than the fleet's newest one (or the fleet never commented):
 *  the operator is mid-conversation on this issue, so the garden stays out of it. */
export function operatorSpokeLast(comments: readonly RevalidationComment[], operatorLogins: readonly string[] | undefined): boolean {
  let operator = -Infinity;
  let bot = -Infinity;
  for (const c of comments) {
    const at = Date.parse(c.createdAt);
    if (!Number.isFinite(at)) continue;
    if (isOperatorComment(c, operatorLogins)) operator = Math.max(operator, at);
    else if (c.authorType.toLowerCase() === "bot" || BOT_SUFFIX.test(c.authorLogin)) bot = Math.max(bot, at);
  }
  return operator > bot;
}

const ABSENCE = /\b0 row\(s\)|\bdoes not appear\b|\babsence only\b|\bnot present\b|\babsent\b|\bno (?:\w+ ){0,2}(?:rows?|records?|failures?|matches?|occurrences?)\b/i;
const PRESENCE = /\bmerged\b|\bappears on origin\/main\b|\b[1-9]\d* row\(s\)|\b[0-9a-f]{7,40}\b/i;

/** A citation that shows only that something is MISSING. A zero is not a measurement: a misread name
 *  or an unwritten step reads zero too (W1-T9181, #10269), so it can never close an issue. */
export function isAbsenceOnlyCitation(citation: string): boolean {
  return ABSENCE.test(citation) && !PRESENCE.test(citation);
}

/** An escalation the fleet opened, or re-observed in an appended comment, within the window before
 *  `nowMs`: its condition was seen live, whatever a judge reads from other evidence. */
export function conditionReobserved(issue: Pick<RevalidationIssue, "createdAt">, comments: readonly RevalidationComment[], nowMs: number): boolean {
  const recent = (at: string) => nowMs - Date.parse(at) < ISSUE_REVALIDATION_REOBSERVED_WINDOW_MS;
  if (recent(issue.createdAt)) return true;
  return comments.some((c) => /observed the same condition/i.test(c.body ?? "") && recent(c.createdAt));
}

/** The action a verdict takes, before the per-pass close cap. Pure, so the shadow table and act mode
 *  can never disagree about what would happen. */
export function decideAction(input: {
  verdict: RevalidationVerdict;
  escalationClass: string | undefined;
  /** `undefined` when the comments could not be read: every write is then withheld. */
  operatorSpokeLast: boolean | undefined;
  /** The fleet re-observed this escalation within the window (conditionReobserved). */
  reobserved?: boolean;
  prior: PriorVerdict | undefined;
  nowMs: number;
}): { action: RevalidationAction; guard?: RevalidationGuard } {
  const { verdict } = input;
  if (verdict.verdict === "unknown") return { action: "keep" };
  if (input.operatorSpokeLast === undefined) return { action: "keep", guard: "comments-unread" };
  if (input.operatorSpokeLast) return { action: "keep", guard: "newer-operator-comment" };
  const operatorOwned = input.escalationClass !== undefined && OPERATOR_OWNED_CLASSES.has(input.escalationClass);
  if (verdict.verdict === "resolved") {
    if (!verdict.citation) return { action: "keep", guard: "no-citation" };
    if (isAbsenceOnlyCitation(verdict.citation)) return { action: "keep", guard: "absence-only-citation" };
    if (operatorOwned) return refreshUnlessRecent(input.prior, input.nowMs, "operator-owned-class");
    if (input.reobserved) return { action: "keep", guard: "condition-reobserved" };
    return { action: "close" };
  }
  if (verdict.verdict === "convert-to-task") {
    if (operatorOwned) return refreshUnlessRecent(input.prior, input.nowMs, "operator-owned-class");
    if (input.prior?.action === "convert" && input.prior.acted) return { action: "keep", guard: "refresh-not-due" };
    return { action: "convert" };
  }
  return refreshUnlessRecent(input.prior, input.nowMs);
}

function refreshUnlessRecent(prior: PriorVerdict | undefined, nowMs: number, guard?: RevalidationGuard): { action: RevalidationAction; guard?: RevalidationGuard } {
  const lastRefresh = prior?.action === "refresh" && prior.acted ? Date.parse(prior.at) : NaN;
  if (Number.isFinite(lastRefresh) && nowMs - lastRefresh < STILL_TRUE_REFRESH_MS) {
    return { action: "keep", guard: guard ?? "refresh-not-due" };
  }
  return guard === undefined ? { action: "refresh" } : { action: "refresh", guard };
}

// ── The pass ─────────────────────────────────────────────────────────────────────────────────────

export interface JudgeEvidence {
  /** Lines of current evidence the judge reads beside the issue text (git and ledger facts). */
  facts: string[];
}

export interface IssueRevalidationPorts {
  policy: () => IssueRevalidationPolicy;
  listOpenIssues: () => Promise<RevalidationIssue[]>;
  listComments: (issueNumber: number) => Promise<RevalidationComment[]>;
  operatorLogins?: readonly string[];
  /** The reconciler's referent derivation for the given issues: a verdict per issue number it could
   *  derive. Issues it cannot derive are absent (unknown). */
  referentVerdicts: (issues: readonly RevalidationIssue[]) => Promise<ReadonlyMap<number, RevalidationVerdict>>;
  /** Whether the reconciler would find a referent for this issue (plan task, `PR-<n>`, or a PR URL). */
  hasReferent: (issue: RevalidationIssue) => boolean;
  /** The current liveness of a named gardener, from the overseer's own persisted state. */
  livenessVerdict: (gardener: string) => RevalidationVerdict;
  /** The latest read-model consistency runs for a `READ-MODEL-<INSTANCE>` task id. */
  readModelVerdict: (taskId: string) => RevalidationVerdict;
  /** Current-main evidence for an issue the deterministic probes cannot decide. */
  evidence: (issue: RevalidationIssue) => JudgeEvidence;
  /** The bounded model judge. A throw is an unknown verdict, never a resolved one. */
  judge: (issue: RevalidationIssue, issueClass: IssueClass, evidence: JudgeEvidence) => Promise<RevalidationVerdict>;
  /** Each issue's newest verdict row from earlier passes, by issue number. */
  priorVerdicts: () => ReadonlyMap<number, PriorVerdict>;
  close: (issueUrl: string, comment: string) => Promise<void>;
  comment: (issueUrl: string, body: string) => Promise<void>;
  /** Files the issue as a feedback entry for the normal triage and filing path; returns its id. */
  fileConversion: (issue: RevalidationIssue, verdict: RevalidationVerdict) => Promise<string>;
  log: (step: string, extra?: Record<string, unknown>) => void;
  clock?: Clock;
}

export interface IssueRevalidationRow {
  issueNumber: number;
  issueUrl: string;
  issueClass: IssueClass;
  escalationClass?: string;
  verdict: RevalidationVerdictKind;
  reason: string;
  citation?: string;
  action: RevalidationAction;
  guard?: RevalidationGuard;
  acted: boolean;
  judged: boolean;
}

export interface IssueRevalidationSummary {
  mode: IssueRevalidationMode;
  ran: boolean;
  issuesSeen: number;
  rows: IssueRevalidationRow[];
  /** Whether any verdict differs from the issue's prior one: the garden's pacing signal. */
  found: boolean;
}

/** Neither an uncited resolution nor absence-only evidence of a live problem decides the issue. */
function normalise(v: RevalidationVerdict): RevalidationVerdict {
  if (v.verdict === "still-true" && v.citation && isAbsenceOnlyCitation(v.citation)) {
    return { verdict: "unknown", reason: `still-true with an absence-only citation (${v.reason})` };
  }
  return v.verdict === "resolved" && (v.citation ?? "").trim() === ""
    ? { verdict: "unknown", reason: `resolved without a citation (${v.reason})` }
    : v;
}

function closeComment(row: { verdict: RevalidationVerdict; issueClass: IssueClass }): string {
  return [
    "Closed by the issue-revalidation garden (W1-T8864): the condition this issue reports is no longer true.",
    "",
    `**Evidence:** ${row.verdict.citation}`,
    `**Why:** ${row.verdict.reason}`,
    `**Class:** ${row.issueClass}`,
    "",
    "_Reopen this issue if the condition still holds; the garden never closes an issue whose newest comment is the operator's._",
  ].join("\n");
}

function refreshComment(row: { verdict: RevalidationVerdict; issueClass: IssueClass }, at: string): string {
  return [
    `Still open as of ${at.slice(0, 10)} (issue-revalidation garden, W1-T8864): ${row.verdict.verdict}.`,
    "",
    `**Why:** ${row.verdict.reason}`,
    ...(row.verdict.citation ? [`**Evidence:** ${row.verdict.citation}`] : []),
  ].join("\n");
}

/** One garden pass: list, classify, probe, decide, then ledger (shadow) or act (act mode). Throws only
 *  on a programming error; every I/O failure is ledgered and ends or skips its own part of the pass. */
export async function runIssueRevalidationGarden(ports: IssueRevalidationPorts): Promise<IssueRevalidationSummary> {
  const clock = ports.clock ?? systemClock;
  let policy: IssueRevalidationPolicy;
  try {
    policy = ports.policy();
  } catch (e) {
    ports.log(ISSUE_REVALIDATION_FAILED_STEP, { stage: "policy", error: String((e as Error)?.message ?? e) });
    return { mode: "off", ran: false, issuesSeen: 0, rows: [], found: false };
  }
  if (policy.mode === "off") return { mode: "off", ran: false, issuesSeen: 0, rows: [], found: false };

  let issues: RevalidationIssue[];
  try {
    issues = await ports.listOpenIssues();
  } catch (e) {
    // A failed read is "do nothing this pass", never a confident "nothing is open".
    ports.log(ISSUE_REVALIDATION_FAILED_STEP, { stage: "list", error: String((e as Error)?.message ?? e) });
    return { mode: policy.mode, ran: false, issuesSeen: 0, rows: [], found: false };
  }

  const prior = ports.priorVerdicts();
  const classes = new Map<number, IssueClass>(issues.map((i) => [i.number, classifyIssue(i, ports.hasReferent)]));
  let referents: ReadonlyMap<number, RevalidationVerdict> = new Map();
  const referentIssues = issues.filter((i) => classes.get(i.number) === "referent");
  if (referentIssues.length > 0) {
    try {
      referents = await ports.referentVerdicts(referentIssues);
    } catch (e) {
      ports.log(ISSUE_REVALIDATION_FAILED_STEP, { stage: "referent", error: String((e as Error)?.message ?? e) });
    }
  }

  const nowMs = clock.now();
  let judges = 0;
  let closes = 0;
  let found = false;
  const rows: IssueRevalidationRow[] = [];
  for (const issue of issues) {
    const issueClass = classes.get(issue.number)!;
    const escalationClass = issueEscalationClass(issue);
    const before = prior.get(issue.number);
    let verdict: RevalidationVerdict;
    let judged = false;
    if (issueClass === "referent") {
      verdict = referents.get(issue.number) ?? { verdict: "unknown", reason: "the referent could not be derived this pass" };
    } else if (issueClass === "liveness") {
      verdict = ports.livenessVerdict((issueTaskId(issue) ?? "").replace(/-gardener-liveness$/, ""));
    } else if (issueClass === "read-model") {
      verdict = ports.readModelVerdict(issueTaskId(issue) ?? "");
    } else if (before !== undefined && before.issueUpdatedAt === issue.updatedAt && before.verdict !== "unknown" &&
      nowMs - Date.parse(before.at) < STILL_TRUE_REFRESH_MS) {
      // An unchanged issue judged within the week keeps its verdict: no spawn for unchanged state.
      verdict = { verdict: before.verdict, reason: before.reason ?? "unchanged since the last judgement", ...(before.citation ? { citation: before.citation } : {}) };
    } else if (judges >= MAX_ISSUE_REVALIDATION_JUDGES_PER_PASS) {
      verdict = { verdict: "unknown", reason: "judge cap reached this pass; judged on a later pass" };
    } else {
      judges++;
      judged = true;
      try {
        verdict = await ports.judge(issue, issueClass, ports.evidence(issue));
      } catch (e) {
        verdict = { verdict: "unknown", reason: `judge unavailable (${String((e as Error)?.message ?? e)})` };
      }
    }
    verdict = normalise(verdict);

    let spokeLast: boolean | undefined;
    let reobserved = false;
    if (verdict.verdict !== "unknown") {
      try {
        const comments = await ports.listComments(issue.number);
        spokeLast = operatorSpokeLast(comments, ports.operatorLogins);
        reobserved = escalationClass !== undefined && conditionReobserved(issue, comments, nowMs);
      } catch (e) {
        ports.log(ISSUE_REVALIDATION_FAILED_STEP, { stage: "comments", issue_number: issue.number, error: String((e as Error)?.message ?? e) });
      }
    }
    let { action, guard } = decideAction({ verdict, escalationClass, operatorSpokeLast: spokeLast, reobserved, prior: before, nowMs });
    if (action === "close" && closes >= policy.maxClosesPerPass) {
      action = "keep";
      guard = "close-cap";
    }
    if (action === "close") closes++;

    let acted = false;
    if (policy.mode === "act" && action !== "keep") {
      try {
        if (action === "close") await ports.close(issue.url, closeComment({ verdict, issueClass }));
        else if (action === "refresh") await ports.comment(issue.url, refreshComment({ verdict, issueClass }, clock.iso()));
        else {
          const feedbackId = await ports.fileConversion(issue, verdict);
          await ports.comment(issue.url, `Queued for conversion to a plan task as feedback \`${feedbackId}\` (issue-revalidation garden, W1-T8864). This issue closes once that task is filed.`);
        }
        acted = true;
      } catch (e) {
        ports.log(ISSUE_REVALIDATION_ACTION_FAILED_STEP, { issue_number: issue.number, action, error: String((e as Error)?.message ?? e) });
      }
    }
    if (before?.verdict !== verdict.verdict) found = true;
    const row: IssueRevalidationRow = {
      issueNumber: issue.number, issueUrl: issue.url, issueClass, ...(escalationClass ? { escalationClass } : {}),
      verdict: verdict.verdict, reason: verdict.reason, ...(verdict.citation ? { citation: verdict.citation } : {}),
      action, ...(guard ? { guard } : {}), acted, judged,
    };
    rows.push(row);
    ports.log(ISSUE_REVALIDATION_VERDICT_STEP, {
      mode: policy.mode, issue_number: issue.number, issue_url: issue.url, issue_class: issueClass,
      escalation_class: escalationClass ?? null, issue_updated_at: issue.updatedAt, verdict: verdict.verdict,
      reason: verdict.reason, citation: verdict.citation ?? null, action, guard: guard ?? null, acted, judged,
    });
  }
  const tally = (pick: (r: IssueRevalidationRow) => string) =>
    rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [pick(r)]: (acc[pick(r)] ?? 0) + 1 }), {});
  ports.log(ISSUE_REVALIDATION_PASS_STEP, {
    mode: policy.mode, issues_seen: issues.length, judged: judges, verdicts: tally((r) => r.verdict),
    actions: tally((r) => (r.acted ? `${r.action}:acted` : r.action)), found,
  });
  return { mode: policy.mode, ran: true, issuesSeen: issues.length, rows, found };
}

/** Each issue's newest {@link ISSUE_REVALIDATION_VERDICT_STEP} row, from ledger rows in any order. */
export function priorVerdictsFromRows(rows: Iterable<Record<string, unknown>>): Map<number, PriorVerdict> {
  const out = new Map<number, PriorVerdict>();
  for (const r of rows) {
    if (r.step !== ISSUE_REVALIDATION_VERDICT_STEP) continue;
    const n = Number(r.issue_number);
    const at = String(r.ts ?? "");
    if (!Number.isSafeInteger(n) || !Number.isFinite(Date.parse(at))) continue;
    const seen = out.get(n);
    if (seen !== undefined && Date.parse(seen.at) >= Date.parse(at)) continue;
    out.set(n, {
      verdict: String(r.verdict) as RevalidationVerdictKind, at,
      ...(typeof r.issue_updated_at === "string" ? { issueUpdatedAt: r.issue_updated_at } : {}),
      ...(typeof r.action === "string" ? { action: r.action as RevalidationAction } : {}),
      acted: r.acted === true,
      ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
      ...(typeof r.citation === "string" ? { citation: r.citation } : {}),
    });
  }
  return out;
}

// ── Deterministic probes over local evidence ─────────────────────────────────────────────────────

/** A READ-MODEL issue's verdict from the newest consistency runs for its task id (newest last). */
export function readModelVerdictFromRows(taskId: string, rows: readonly Record<string, unknown>[]): RevalidationVerdict {
  const runs = rows.filter((r) => r.task_id === taskId && r.step === "read_model.consistency")
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (runs.length < READ_MODEL_CLEAN_RUNS) {
    return { verdict: "unknown", reason: `only ${runs.length} consistency run(s) recorded for ${taskId}; ${READ_MODEL_CLEAN_RUNS} needed` };
  }
  const recent = runs.slice(-READ_MODEL_CLEAN_RUNS);
  const bad = recent.filter((r) => !["agree", "transient", "healed"].includes(String(r.outcome)));
  const last = recent[recent.length - 1]!;
  if (bad.length === 0) {
    return {
      verdict: "resolved",
      reason: `the last ${READ_MODEL_CLEAN_RUNS} read-model consistency runs for ${taskId} all agreed`,
      citation: `${READ_MODEL_CLEAN_RUNS}/${READ_MODEL_CLEAN_RUNS} read_model.consistency runs clean, newest ${String(last.ts)}`,
    };
  }
  return { verdict: "still-true", reason: `${bad.length} of the last ${READ_MODEL_CLEAN_RUNS} consistency runs for ${taskId} were ${[...new Set(bad.map((r) => String(r.outcome)))].join("/")}` };
}

/** A gardener-liveness issue's verdict from the overseer's persisted episodes: an episode exists only
 *  while the overseer judges that gardener unhealthy. A stale or unreadable state is unknown. */
export function livenessVerdictFromOverseerState(
  gardener: string, state: { episodes?: Record<string, { kind?: string; since?: string }> } | undefined, stateMtimeMs: number | undefined, nowMs: number,
): RevalidationVerdict {
  if (state === undefined || stateMtimeMs === undefined) return { verdict: "unknown", reason: "the overseer's state could not be read" };
  if (nowMs - stateMtimeMs > OVERSEER_STATE_FRESH_MS) {
    return { verdict: "unknown", reason: `the overseer's state is ${Math.round((nowMs - stateMtimeMs) / 60_000)} min old` };
  }
  const episode = state.episodes?.[gardener];
  if (episode !== undefined) return { verdict: "still-true", reason: `the overseer still holds a ${episode.kind ?? "health"} episode for ${gardener} since ${episode.since ?? "?"}` };
  return {
    verdict: "resolved",
    reason: `the overseer holds no unhealthy episode for the ${gardener} gardener`,
    citation: `gardener-overseer.json, written ${fixedClock(stateMtimeMs).iso()}, has no episode for ${gardener}`,
  };
}

/** One commit on main, as `git log --format=MAIN_COMMIT_LOG_FORMAT` prints it. */
export interface MainCommit { sha: string; committedAt: string; subject: string }
export const MAIN_COMMIT_LOG_FORMAT = "%h%x09%cI%x09%s";
export const ISSUE_REVALIDATION_COMMITS_PER_ISSUE = 5;

export function parseMainCommitLog(text: string): MainCommit[] {
  return text.split("\n").flatMap((line) => {
    const [sha, committedAt, ...subject] = line.split("\t");
    return sha && committedAt ? [{ sha, committedAt, subject: subject.join("\t") }] : [];
  });
}

/** The commits (newest first, as git logs them) committed after the issue opened whose SUBJECT names it
 *  — the present evidence a hand-filed issue's fix leaves, as #11264's "(#8429)" did (W1-T9308). A plan
 *  filing works on an issue and never fixes it, and `#84290` does not name #8429. */
export function commitsNamingIssue(issue: Pick<RevalidationIssue, "number" | "createdAt">, commits: readonly MainCommit[]): MainCommit[] {
  const names = new RegExp(`#${issue.number}(?!\\d)`);
  const opened = Date.parse(issue.createdAt);
  return commits.filter((c) => Date.parse(c.committedAt) > opened && names.test(c.subject) && !c.subject.startsWith("chore(plan):"))
    .slice(0, ISSUE_REVALIDATION_COMMITS_PER_ISSUE);
}

// ── The model judge's prompt and verdict ─────────────────────────────────────────────────────────

export function buildIssueRevalidationPrompt(issue: RevalidationIssue, issueClass: IssueClass, evidence: JudgeEvidence): string {
  return [
    "You re-check ONE open GitHub issue against CURRENT evidence and say whether its condition still holds.",
    "The costly mistake is closing an issue whose condition is still true: WHEN IN DOUBT, ANSWER unknown.",
    "Answer resolved ONLY when the evidence below positively shows the condition is gone, and cite that evidence.",
    "Absence is not proof: a zero count or a name that does not appear never shows a fix. Cite something PRESENT.",
    "Answer still-true only with positive current evidence that the condition holds; an old issue is not a fresh observation.",
    "Answer unknown for an absence-only citation: a missing commit or zero rows proves neither persistence nor resolution.",
    "A commit that names the issue shows work against it, not a fix: cite it only when its subject says the condition was removed.",
    "",
    `ISSUE #${issue.number} (${issueClass}), opened ${issue.createdAt}, last updated ${issue.updatedAt}`,
    `TITLE: ${issue.title}`,
    "BODY:",
    issue.body.slice(0, 6000),
    "",
    "CURRENT EVIDENCE (read from main and the fleet ledger just now):",
    ...(evidence.facts.length > 0 ? evidence.facts.map((f) => `  - ${f}`) : ["  (none could be read)"]),
    "",
    "Decide exactly one: resolved | still-true | convert-to-task | unknown.",
    "  convert-to-task: the issue names concrete work that no existing plan task covers.",
    "MACHINE-READABLE OUTPUT (required): emit each line once, alone on its line:",
    "  REVALIDATION_VERDICT: <resolved|still-true|convert-to-task|unknown>",
    "  REVALIDATION_REASON: <one specific sentence>",
    "  REVALIDATION_CITATION: <the evidence line that decides it, or none>",
  ].join("\n");
}

const VERDICT_KINDS = new Set<RevalidationVerdictKind>(["resolved", "still-true", "convert-to-task", "unknown"]);

/** Parse the judge's lines. Anything unparseable is unknown, and a resolved verdict needs a citation. */
export function parseIssueRevalidationVerdict(text: string): RevalidationVerdict {
  const kind = /REVALIDATION_VERDICT:\s*([a-z-]+)/i.exec(text)?.[1]?.toLowerCase() as RevalidationVerdictKind | undefined;
  if (!kind || !VERDICT_KINDS.has(kind)) return { verdict: "unknown", reason: "the judge's output carried no parseable REVALIDATION_VERDICT" };
  const reason = /REVALIDATION_REASON:\s*(.+)/i.exec(text)?.[1]?.trim() || "(no reason stated)";
  const cited = /REVALIDATION_CITATION:\s*(.+)/i.exec(text)?.[1]?.trim();
  const citation = cited && !/^none\.?$/i.test(cited) ? cited : undefined;
  return normalise({ verdict: kind, reason, ...(citation ? { citation } : {}) });
}

/** The names an issue's text points at: backticked tokens, then path-like and dotted ledger-step words.
 *  Bounded, so one long issue cannot make the evidence pack unbounded. */
export function evidenceNames(issue: Pick<RevalidationIssue, "title" | "body">, limit = 8): string[] {
  const text = `${issue.title}\n${issue.body}`;
  const names = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{3,80})`/g)) names.add(m[1]!.trim());
  for (const m of text.matchAll(/\b((?:src|test|scripts|deploy|docs)\/[\w./-]+\.\w+)\b/g)) names.add(m[1]!);
  for (const m of text.matchAll(LEDGER_STEP_NAME)) if (!/\.(ts|js|md|mjs|json|yaml|yml|sh)$/.test(m[1]!)) names.add(m[1]!);
  return [...names].slice(0, limit);
}

/** REST `/issues/<n>/comments` rows as the operator check reads them. THROWS on a malformed payload. */
export function parseIssueCommentsRest(raw: string): RevalidationComment[] {
  return splitConcatenatedJsonPages(raw).flatMap((chunk) => {
    const page = JSON.parse(chunk) as unknown;
    if (!Array.isArray(page)) throw new Error(`parseIssueCommentsRest: expected a JSON array page, got ${typeof page}`);
    return (page as Array<Record<string, unknown>>).map((r) => {
      const user = (r.user ?? {}) as { login?: unknown; type?: unknown };
      return {
        authorLogin: String(user.login ?? ""),
        authorType: String(user.type ?? "User"),
        authorAssociation: String(r.author_association ?? "NONE"),
        createdAt: String(r.created_at ?? ""),
        body: String(r.body ?? ""),
      };
    });
  });
}

// ── Production ports ─────────────────────────────────────────────────────────────────────────────

/** The ledger window the garden reads: its own prior verdicts (a week of them) and read-model runs. */
export const ISSUE_REVALIDATION_LEDGER_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

export interface ProductionIssueRevalidationOpts {
  owner: string;
  repo: string;
  stateDir: string;
  /** The daemon's own checkout: its origin/main is the evidence the judge reads. */
  repoRoot: string;
  operatorLogins?: readonly string[];
  log: (step: string, extra?: Record<string, unknown>) => void;
  /** The reconciler's referent derivation, built where the plan and the batched gateway live. */
  referentVerdicts: IssueRevalidationPorts["referentVerdicts"];
  hasReferent: IssueRevalidationPorts["hasReferent"];
  /** The judge model's raw text for a prompt (one spawn). */
  judgeText: (prompt: string, issueNumber: number) => Promise<string>;
  clock?: Clock;
  policy?: () => IssueRevalidationPolicy;
  /** `gh` reads through the shared, paced async transport. */
  readText?: (args: string[]) => Promise<string>;
  /** Closes and comments through the escalation issue gateway, the one audited write path. */
  issues?: Pick<AsyncIssueGateway, "closeWithComment" | "comment">;
  runGit?: (args: string[]) => string;
  readLedgerRows?: (steps: readonly string[], sinceIso: string) => Array<Record<string, unknown>>;
  /** W1-T9696: the daemon's state root; a conversion stages in its landing queue, never landed on the loop. */
  landingStateRoot?: string;
}

/** The garden's ports as the daemon builds them. Reads are lazy and read once per pass. */
export function productionIssueRevalidationPorts(opts: ProductionIssueRevalidationOpts): IssueRevalidationPorts {
  const clock = opts.clock ?? systemClock;
  const readText = opts.readText ?? ((args: string[]) => ghTextAsync(args));
  const issues = opts.issues ?? ghIssueGatewayAsync(opts.owner, opts.repo);
  const runGit = opts.runGit ?? ((args: string[]) => hostWorktreeGit(opts.repoRoot, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }));
  const readLedgerRows = opts.readLedgerRows ?? ((steps: readonly string[], since: string) => {
    const read = readLedgerUnionRecordsSync(opts.stateDir, { step: steps, since, rotationWindowMs: ISSUE_REVALIDATION_LEDGER_WINDOW_MS, minRotations: 1 });
    if (!read.ok) throw new Error(`issue-revalidation ledger union unreadable: ${read.unread.join(", ") || "incomplete"}`);
    return read.rows;
  });
  const repoArg = `${opts.owner}/${opts.repo}`;
  const sinceIso = () => fixedClock(clock.now() - ISSUE_REVALIDATION_LEDGER_WINDOW_MS).iso();
  let ownRows: Array<Record<string, unknown>> | undefined;
  const rows = () => (ownRows ??= readLedgerRows([ISSUE_REVALIDATION_VERDICT_STEP, "read_model.consistency"], sinceIso()));
  let listed: RevalidationIssue[] = [];
  let stepRows: Array<Record<string, unknown>> | undefined;
  let commits: MainCommit[] | undefined;
  return {
    policy: opts.policy ?? (() => loadIssueRevalidationPolicy()),
    operatorLogins: opts.operatorLogins,
    clock,
    log: opts.log,
    listOpenIssues: async () => {
      listed = parseOpenIssuesRest(await readText(openIssuesRestArgs(opts.owner, opts.repo)));
      stepRows = undefined;
      commits = undefined;
      return listed;
    },
    listComments: async (n) => parseIssueCommentsRest(await readText(["api", `repos/${repoArg}/issues/${n}/comments?per_page=100`, "--paginate"])),
    referentVerdicts: opts.referentVerdicts,
    hasReferent: opts.hasReferent,
    livenessVerdict: (gardener) => {
      const path = overseerStatePath(opts.stateDir);
      // One descriptor for both the age and the content, so the two describe the same file.
      let fd: number | undefined;
      try {
        fd = openSync(path, "r");
        const mtime = fstatSync(fd).mtimeMs;
        const state = JSON.parse(readFileSync(fd, "utf8")) as { episodes?: Record<string, { kind?: string; since?: string }> };
        return livenessVerdictFromOverseerState(gardener, state, mtime, clock.now());
      } catch (e) {
        // An unreadable overseer state is an unknown verdict, never a resolved one.
        return { verdict: "unknown", reason: `the overseer's state could not be read (${String((e as Error)?.message ?? e).slice(0, 120)})` };
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
    readModelVerdict: (taskId) => readModelVerdictFromRows(taskId, rows()),
    priorVerdicts: () => priorVerdictsFromRows(rows()),
    evidence: (issue) => {
      const facts: string[] = [];
      for (const name of evidenceNames(issue)) {
        try {
          const hits = runGit(["grep", "-l", "-F", "-e", name, "origin/main", "--", "src", "scripts", "deploy", "test"])
            .split("\n").filter(Boolean).map((l) => l.replace(/^origin\/main:/, ""));
          facts.push(hits.length > 0 ? `\`${name}\` appears on origin/main in ${hits.length} file(s): ${hits.slice(0, 3).join(", ")}` : `\`${name}\` does not appear on origin/main`);
        } catch (e) {
          // git grep exits 1 on no match: that is the fact "absent", not an unread one.
          const status = (e as { status?: number }).status;
          facts.push(status === 1 ? `\`${name}\` does not appear on origin/main` : `\`${name}\` could not be searched (${String((e as Error)?.message ?? e).slice(0, 120)})`);
        }
      }
      const steps = [...new Set(listed.flatMap((i) => evidenceNames(i)).filter((n) => LEDGER_STEP_NAME_WHOLE.test(n) && !/\.(ts|js|md|mjs|json|yaml|yml|sh)$/.test(n)))];
      try {
        stepRows ??= steps.length === 0 ? [] : readLedgerRows(steps, fixedClock(clock.now() - 48 * 60 * 60 * 1000).iso());
        for (const name of evidenceNames(issue).filter((n) => steps.includes(n))) {
          const mine = stepRows.filter((r) => r.step === name);
          const newest = mine.map((r) => String(r.ts)).sort().pop();
          facts.push(mine.length > 0
            ? `ledger step ${name}: ${mine.length} row(s) in the last 48 h, newest ${newest}`
            : `ledger step ${name}: 0 row(s) in the last 48 h — absence only: a misread or unwritten step reads 0 too, so this proves no fix`);
        }
      } catch (e) {
        // An unread ledger is told to the judge as such, so it cannot read silence as "no rows".
        facts.push(`the ledger could not be read (${String((e as Error)?.message ?? e).slice(0, 120)})`);
      }
      try {
        // One log per pass, from the oldest issue it judges.
        const since = [...listed, issue].map((i) => i.createdAt).sort()[0]!;
        commits ??= parseMainCommitLog(runGit(["log", "origin/main", `--since=${since}`, `--format=${MAIN_COMMIT_LOG_FORMAT}`]));
        const naming = commitsNamingIssue(issue, commits);
        facts.push(...(naming.length > 0
          ? naming.map((c) => `commit ${c.sha} on origin/main names #${issue.number}: ${c.subject}`)
          : [`no origin/main commit since the issue opened names #${issue.number} in its subject — absence only`]));
      } catch (e) {
        // An unread log is told as unread, so the judge cannot take it for "no commit names this issue".
        facts.push(`main's commit log could not be read (${String((e as Error)?.message ?? e).slice(0, 120)})`);
      }
      return { facts };
    },
    judge: async (issue, issueClass, evidence) => parseIssueRevalidationVerdict(await opts.judgeText(buildIssueRevalidationPrompt(issue, issueClass, evidence), issue.number)),
    close: async (url, comment) => {
      if (!issues.closeWithComment) throw new Error("the issue gateway cannot close");
      await issues.closeWithComment(url, comment);
    },
    comment: async (url, body) => {
      if (!issues.comment) throw new Error("the issue gateway cannot comment");
      await issues.comment(url, body);
    },
    fileConversion: async (issue, verdict) => {
      const id = issueFeedbackId(opts.owner, opts.repo, issue.number);
      if (feedbackCaptured(opts.repoRoot, id, opts.landingStateRoot)) return id;
      const raw = renderIssueRaw({ owner: opts.owner, repo: opts.repo, number: issue.number, title: issue.title, body: issue.body,
        state: "open", createdAt: issue.createdAt, url: issue.url, labels: issue.labels });
      stageFeedbackCapture(opts.repoRoot, opts.landingStateRoot, { id, raw: `${raw}\n\nissue-revalidation (W1-T8864): ${verdict.reason}`, origin: `issue#${issue.number}` });
      return id;
    },
  };
}

/** The existing single judge spawn, with best-effort monetary receipts before parsing can discard a
 * paid result. The optional config names only the evidence sink, never the router or child environment. */
export function issueRevalidationJudgeText(opts: { mount: Mount; cwd: string; settingsFile: string; spawn?: typeof spawnWorker; config?: Config }): (prompt: string, issueNumber: number) => Promise<string> {
  const spawn = opts.spawn ?? benchmarkNonDispatchSpawn("escalation-summary");
  return async (prompt, issueNumber) => {
    const identity = { taskId: "ISSUE-REVALIDATION", runId: `issue-revalidation-${issueNumber}-${createHash("sha256").update(prompt).digest("hex").slice(0, 12)}` };
    let assignmentId: string | undefined, unstartedRecorded = false;
    const recordedIds = new Set<string>(), unkeyedResults = new WeakSet<WorkerResult>(), keyedResults = new WeakSet<WorkerResult>();
    const record = (result: WorkerResult | undefined, id: string | undefined): void => {
      if (id !== undefined && recordedIds.has(id)) return;
      if (result && (unkeyedResults.has(result) || id === undefined && keyedResults.has(result))) {
        if (id !== undefined) recordedIds.add(id);
        return;
      }
      if (id !== undefined) recordedIds.add(id);
      if (result) (id === undefined ? unkeyedResults : keyedResults).add(result);
      else if (id === undefined) { if (unstartedRecorded) return; unstartedRecorded = true; }
      try {
        let resources: ReturnType<typeof benchmarkWorkerAttemptResources> | undefined;
        try { if (result) resources = benchmarkWorkerAttemptResources(result); }
        catch { /* unreportable worker accounting is unknown, not a free call */ }
        const { billing_mode = "unknown" } = resources ?? {};
        const price = resources?.total_cost_usd, notional = resources?.notional_cost_usd;
        const priced = typeof price === "number" && Number.isFinite(price) && price >= 0;
        const path = benchmarkEvidenceLedgerPath(opts.config);
        if (path === undefined) return;
        appendLedger(path, {
          run_id: identity.runId, task_id: identity.taskId, step: "issue_revalidation.attempt_spend",
          ...attemptAssignmentJoin(id, result === undefined),
          attempt_state: result ? "result" : id ? "failed" : "not-started",
          accounting_source: "worker-result-estimate-not-invoice",
          provider: result?.provider === "claude" || result?.provider === "codex" || result?.provider === "cash" ? result.provider : "unknown",
          billing_mode, price_state: priced ? "reported" : "unknown",
          ...(priced ? { total_cost_usd: price } : {}),
          ...(typeof notional === "number" && Number.isFinite(notional) && notional >= 0 ? { notional_cost_usd: notional } : {}),
        });
      } catch { /* monetary telemetry must not change the result, rejection or existing retry flow */ }
    };
    let result: WorkerResult;
    try {
      result = await spawn(withReceiptIdentity({
        cwd: opts.cwd, permissionMode: "bypassPermissions", settingsFile: opts.settingsFile, prompt,
        model: opts.mount.model, effort: opts.mount.effort, maxTurns: opts.mount.maxTurns, tools: [],
        ...(opts.mount.provider === undefined ? {} : { mountProvider: opts.mount.provider }),
        onSelectionAssignment: assignment => { assignmentId = assignment.id; },
        onModelFallbackAttempt: attempt => record(attempt.result, attempt.selectionAssignmentId ?? attempt.result?.selectionAssignmentId),
      }, identity));
    } catch (error) { record(undefined, assignmentId); throw error; }
    record(result, result.selectionAssignmentId ?? assignmentId);
    return result.text;
  };
}
