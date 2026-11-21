import { ghExec, ghTextAsync, withSynchronousGhDelivery } from "./github-transport.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createOrReadExclusive, createOrReadPublished, HEX_SECRET_RE, InvalidSecretFileError } from "./fs-race-safe.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { appendLedger } from "./ledger.js";
import { appendThreadMessage } from "./inbox-thread.js";
import { NEEDS_HUMAN_LABEL } from "./poll-interval.js";
import { clockFromMillisFn, systemClock, type Clock } from "./clock.js";
import {
  checkOperatorMessage,
  operatorMessageFooter,
  type OperatorMessage,
  type OperatorMessageCheckResult,
} from "./operator-message.js";
import { assertLiveWriteAllowed } from "./live-write-guard.js";
// W1-T5283/W1-T5284: shared steps run synchronously for CLI callers, asynchronously on the daemon.
import { runStepsAsync, runStepsSync, step, type Steps } from "./git-push.js";
import { validateDecisionSummary, type DecisionSummary, type SummarizeDeps } from "./feedback.js";
import type { Mount, Mounts } from "./mounts.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";
import { benchmarkNonDispatchSpawn, withReceiptIdentity } from "./benchmark-run.js";
import { resolveRiskJudgeMount } from "./risk-judge.js";
import { inferOperatorPresence, learnLeaseMs, replyLatenciesMs } from "./presence.js";
import type { WriteTier } from "./service.js";
import {
  takeAutoResolve,
  triageEscalation,
  type EscalationTriageMode,
  type TriageAction,
  type TriageEvidence,
  type TriageOutcome,
  type TriagePass,
} from "./escalation-triage.js";
import { escalationClassSignal } from "./escalation-precision.js";
import { createLedgerRotationMemo, readLedgerUnionRecordsMemoized, readLedgerUnionRecordsSync } from "./ledger-union.js";

/**
 * Human stops (W1-T8, MASTER-PLAN §4): exhausted post-diagnose strikes (BLOCKED), human-only acts
 * (MANUAL), deterministic HARD_STOPs, and ambiguous intake (GRILL, §7B/W1-T42).
 * INVARIANT: each `needs-human` issue carries options and a recommendation.
 * TRAP: DECISION/DIRECTION are absorbed elsewhere; ASYNC-QUESTION never stops the loop.
 * History: docs/forensics/escalate.md; pre-compression source at commit 2b52efd75 (W1-T11034).
 */
export type EscalationClass = "BLOCKED" | "MANUAL" | "HARD_STOP" | "GRILL";

export type EscalationHeadDedup = "dependent" | "independent";

/**
 * CLOSED executable routes: no merge, PR-close or reject route. {@link validateEscalationOptionKind}
 * refuses outsiders. TRAP: copy serve.ts's {@link WriteTier}; re-deriving it lets the tables drift.
 * FALSIFIER:
 * test/escalation-options-are-executable.test.ts. Why: docs/forensics/escalate.md.
 */
export const ESCALATION_OPTION_ROUTES = {
  "/v1/manual/approve": "high",
  "/v1/drain/kick": "high",
  "/v1/drain/run": "high",
  "/v1/inbox/approve": "high",
  "/v1/skills/run": "high",
  "/v1/control/pause": "middle",
  "/v1/control/resume": "middle",
  "/v1/control/stop": "middle",
  "/v1/escalation/mark-handled": "low",
  "/v1/questions/answer": "low",
  "/v1/drain/feedback": "low",
  "/v1/auth/scope": "low",
} as const satisfies Record<string, WriteTier>;

/** One path from the closed {@link ESCALATION_OPTION_ROUTES} set. */
export type EscalationOptionRoute = keyof typeof ESCALATION_OPTION_ROUTES;

/** W1-T2273: a console-executable route/payload/tier, or an explicitly operator-only act. */
export type EscalationOptionKind =
  | {
      readonly type: "executable";
      /** One of {@link ESCALATION_OPTION_ROUTES}'s own keys — never a route this task invents. */
      readonly route: EscalationOptionRoute;
      /** MUST equal `ESCALATION_OPTION_ROUTES[route]`; validation catches a caller's tier mismatch. */
      readonly tier: WriteTier;
      /** The JSON body the console would POST to `route`. Omitted when the route needs none. */
      readonly payload?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "operator-only" };

/** Human choice (W1-T2273): absent `kind` renders prose like `operator-only`, preserving legacy output.
 *  Machine metadata supplements label/detail. Why: docs/forensics/escalate.md. */
export interface EscalationOption {
  label: string;
  detail: string;
  /** The option's machine-readable kind — see {@link EscalationOptionKind}. */
  kind?: EscalationOptionKind;
}

/** W1-T2273: before issue creation, refuse unknown kinds/routes and mismatched tiers.
 *  `undefined` and `operator-only` pass untouched. */
export function validateEscalationOptionKind(option: EscalationOption): void {
  const kind = option.kind;
  if (kind === undefined || kind.type === "operator-only") return;
  if (kind.type !== "executable") {
    throw new Error(
      `escalation option "${option.label}" carries an unrecognised kind ` +
        `${JSON.stringify((kind as { type?: unknown }).type)} — must be "executable" or "operator-only"`,
    );
  }
  const realTier = (ESCALATION_OPTION_ROUTES as Record<string, WriteTier | undefined>)[kind.route];
  if (realTier === undefined) {
    throw new Error(
      `escalation option "${option.label}" names route ${JSON.stringify(kind.route)}, which is not in the ` +
        `closed set of routes an escalation option may execute`,
    );
  }
  if (realTier !== kind.tier) {
    throw new Error(
      `escalation option "${option.label}" declares tier ${JSON.stringify(kind.tier)} for route ` +
        `${JSON.stringify(kind.route)}, but that route is actually tier ${JSON.stringify(realTier)}`,
    );
  }
}

/** Validate {@link validateEscalationOptionKind} across every option on an escalation. */
function validateEscalationOptionKinds(e: Escalation): void {
  for (const option of e.options) validateEscalationOptionKind(option);
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
  /** W1-T195: dedup head dimension; vetoes a match only when BOTH sides carry disagreeing values. */
  headSha?: string;
  /** W1-T3179: default `dependent`; `independent` renders the head as evidence without a dedup veto. */
  headDedup?: EscalationHeadDedup;
  /** W1-T195: separate asks for review, CI and conflict on one head; permissive when absent. */
  cause?: EscalationCause;
  /** W1-T3579: current authoritative taskContractRevision distinguishes newly authorized repairs
   *  on an unchanged head. Like head/cause, absent on either side preserves legacy dedup. */
  contractRevision?: string;
  /** W1-T313: summarizeEscalation's birth-time card above raw detail. */
  decisionSummary?: DecisionSummary | null;
  /** W1-T2498: inaction consequence; missing is annotated, never held. Explicit `null` counts as
   *  present (docs/operator-message-standard.md); see withExplicitConsequence for normalization. */
  consequence?: string | null;
}

/** W1-T2498: project existing fields onto checkOperatorMessage's four presence slots.
 *  Missing consequences stay visible. Why: docs/forensics/escalate.md. */
export function toOperatorMessage(e: Escalation): OperatorMessage {
  return {
    speaker: e.class,
    whatHappened: e.detail,
    whatIsAsked: e.recommendation,
    consequenceOfInaction: e.consequence,
  };
}

/** {@link checkOperatorMessage}, best-effort (W1-T2498): a checker failure must never stop the
 *  escalation being raised. Returns `undefined` rather than a fabricated verdict, so a caller can
 *  tell "checked and non-conforming" from "could not check at all". */
function checkOperatorMessageSafe(e: Escalation): OperatorMessageCheckResult | undefined {
  try {
    return checkOperatorMessage(toOperatorMessage(e));
  } catch {
    return undefined; // best-effort: a checker failure must never block the escalation itself
  }
}

/** W1-T3391: normalize only an OMITTED consequence to `null` before projection.
 *  Explicit values, including `undefined` in non-conforming fixtures, keep their annotation path. */
function withExplicitConsequence(e: Escalation): Escalation {
  return Object.prototype.hasOwnProperty.call(e, "consequence") ? e : { ...e, consequence: null };
}

/** W1-T195/W1-T8167: stage-stall is separate from fix-probe causes, so a stall issue cannot stand
 *  a fix round down. {@link escalationCause} never returns it. */
export type EscalationCause = "review" | "ci" | "conflict" | "stage-stall";

/** W1-T195: use dispatch's booleans, never parse prose. INVARIANT: conflict wins over CI because
 *  dirty heads have absent/stale checks (sweep.ts isBlockedCi). Why: docs/forensics/escalate.md. */
export function escalationCause(conflicted: boolean, ciFailing: boolean): Exclude<EscalationCause, "stage-stall"> {
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
   *  escalation-lifecycle reconciler parses to derive the referenced task's state. */
  body?: string;
}

/** W1-T1208: labelled reads use REST, never GraphQL-throttled `gh issue list --label`.
 * TRAP: host gh 2.45.0 lacks `--slurp`; bare `--paginate` concatenates arrays, reassembled by
 * {@link parseLabelledIssuesRest}. FALSIFIER: test/escalation-issue-list-rest.test.ts.
 * Why: docs/forensics/escalate.md. */
export function labelledIssuesRestArgs(repoArg: string, label: string, state: "open" | "all"): string[] {
  const q = `labels=${encodeURIComponent(label)}&state=${state}&per_page=100`;
  return ["api", `repos/${repoArg}/issues?${q}`, "--paginate"];
}

/** An {@link OpenIssue} plus the `state` field the BATCHED board gateway needs, so one parse serves
 *  the reconciler and the board gateway. `state` is lowercase as REST reports it; `resolveEscalation`
 *  upper-cases before comparing, so it coexists with `gh --json state`'s "OPEN"/"CLOSED". */
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

/** Split RAW `gh api … --paginate` output into one string per top-level JSON value (W1-T1208) — the
 *  reassembly `--slurp` used to hand back pre-wrapped. A string-aware bracket-depth scan, so a bracket
 *  inside a quoted title or body is never read as a page boundary; one page is one chunk. INVARIANT: it
 *  THROWS on anything left unbalanced, because the caller treats a throw as "do nothing this cycle". */
export function splitConcatenatedJsonPages(raw: string): string[] {
  const chunks: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (start === -1) {
      if (/\s/.test(ch)) continue;
      start = i;
    }
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth < 0) throw new Error("splitConcatenatedJsonPages: unbalanced JSON in gh --paginate output");
      if (depth === 0) {
        chunks.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (depth !== 0 || inString || start !== -1) {
    throw new Error("splitConcatenatedJsonPages: truncated JSON in gh --paginate output");
  }
  return chunks;
}

/** Reassemble bare `--paginate` output, drop pull requests, and translate the wire shape to the one
 *  every consumer reads (W1-T1208). THROWS on malformed input — never returns [] to paper over a broken
 *  payload. TWO translations are load-bearing. `url` comes from REST's `html_url`, not its `url`:
 *  consumers match the web URLs written into the ledger, so surfacing api.github.com would make every
 *  lookup miss SILENTLY. Rows carrying `pull_request` are dropped — REST's `/issues` returns PRs too. */
export function parseLabelledIssuesRest(raw: string): LabelledIssue[] {
  const rows: RestIssueRow[] = splitConcatenatedJsonPages(raw).flatMap((chunk) => {
    const page = JSON.parse(chunk) as unknown;
    if (!Array.isArray(page)) {
      throw new Error(`parseLabelledIssuesRest: expected a JSON array page from gh api, got ${typeof page}`);
    }
    return page as RestIssueRow[];
  });
  return rows
    .filter((i) => i?.pull_request === undefined)
    .map((i) => ({ number: i.number, url: i.html_url, state: i.state, title: i.title, body: i.body }));
}


export interface IssueGateway {
  /** Create a labeled issue; returns its URL. */
  create(title: string, body: string, labels: string[]): string;
  /** List OPEN issues carrying `label` — the reconciler's read side (fb-1784756088300-6a481e).
   *  THROWS on a `gh` read failure, because the caller treats a failed read as "do nothing this
   *  cycle" and never as "zero open". Optional, so create-only fakes keep working. */
  listOpen?(label: string): OpenIssue[];
  /** Close one issue, posting `comment` as the closing citation — used only by the reconciler when
   *  the referenced task resolved, so the closure names its resolver rather than being a silent
   *  disappearance (fb-1784756088300-6a481e). Optional, like {@link ensureLabel}. */
  closeWithComment?(url: string, comment: string, reason?: "not planned"): void;
  /** Post `body` as a plain comment on an OPEN issue without closing it (W1-T104) — the SECOND
   *  OBSERVER of an already-open escalation appends here rather than opening a sibling. A gateway
   *  omitting it still dedupes, but silently drops the second observation. */
  comment?(url: string, body: string): void;
  /** Replace an OPEN issue's body. The sweep keeps a PR's one stall issue's `**Head:**` line on the newest
   *  head it appended (operator ruling 2026-11-01), so a reader of the stored body, such as the
   *  issue-revalidation garden's head-moved rule, never judges that issue against a head it superseded. */
  editBody?(url: string, body: string): void;
  /** W1-T13218 — the issue's comments UPDATED at or after `sinceIso` (REST `?since=`), so finding
   *  today's rolling observation reads one small page, never an issue's whole comment storm. THROWS on
   *  a failed read; the dedup path then posts a new comment. Optional, with {@link editComment}. */
  listCommentsSince?(url: string, sinceIso: string): IssueComment[];
  /** W1-T13218 — replace one issue comment's body by its REST id. THROWS on failure. */
  editComment?(commentId: number, body: string): void;
  /** Ensure ONE label exists on the repo (create-if-missing, tolerate-already-exists). Returns false
   *  when provisioning failed. Optional: a gateway omitting it is treated as "every label already
   *  exists". TRAP: an unprovisioned label used to fail the WHOLE create, losing the rendered
   *  question and killing the reconciler for every other open PR — provisioning is the transport's
   *  job, never the operator's memory. Why: the 2026-07-17 incident, docs/forensics/escalate.md. */
  ensureLabel?(label: string): boolean;
}

/** W1-T13218 — one issue comment as {@link IssueGateway.listCommentsSince} returns it. */
export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/** REST `/issues/<n>/comments` pages (bare `--paginate` output) as {@link IssueComment}s. THROWS on a
 *  malformed payload. */
export function parseIssueCommentRows(raw: string): IssueComment[] {
  return splitConcatenatedJsonPages(raw).flatMap((chunk) => {
    const page = JSON.parse(chunk) as unknown;
    if (!Array.isArray(page)) throw new Error(`parseIssueCommentRows: expected a JSON array page, got ${typeof page}`);
    return (page as Array<Record<string, unknown>>).map((r) => ({
      id: Number(r.id),
      body: String(r.body ?? ""),
      createdAt: String(r.created_at ?? ""),
      updatedAt: String(r.updated_at ?? r.created_at ?? ""),
    }));
  });
}

/** W1-T5283 — an {@link IssueGateway} whose calls may return a promise, which {@link escalateAsync}
 *  awaits. Every sync gateway is one. */
export type AsyncIssueGateway = { [K in keyof IssueGateway]: Awaitable<IssueGateway[K]> };
type Awaitable<F> = F extends (...args: infer P) => infer R ? (...args: P) => R | Promise<R> : F;

/** W1-T10750: the line that keys a repository-maintenance issue by repo path, so a re-escalation never duplicates it. */
export function maintenanceIssueKey(repo: string): string {
  return `**Repository maintenance:** ${repo}`;
}

/** W1-T10750: maintenance operator channel over the existing {@link AsyncIssueGateway}.
 * `open` reuses one needs-human issue per repo, naming kept leftovers/reasons, failure and next survey.
 * `close` cites recovery, looking up the repo key when its issue URL is unknown. */
export function maintenanceOperatorChannel(issues: AsyncIssueGateway): {
  open(note: { repo: string; leftovers: Array<{ path: string; reason: string }>; lastReason: string; nextSurveyAt: number }): Promise<string>;
  close(repo: string, issueUrl: string | undefined, comment: string): Promise<void>;
} {
  const findOpen = async (repo: string): Promise<OpenIssue | undefined> =>
    issues.listOpen ? (await issues.listOpen(NEEDS_HUMAN_LABEL)).find((i) => (i.body ?? "").split(/\r?\n/).includes(maintenanceIssueKey(repo))) : undefined;
  return {
    async open(note) {
      const existing = await findOpen(note.repo);
      if (existing) return existing.url;
      const kept = note.leftovers.length === 0 ? ["- none: nothing was left in the store that rmd could name"] :
        note.leftovers.map((l) => `- \`${l.path}\` kept: ${l.reason}`);
      const body = [maintenanceIssueKey(note.repo), "",
        "Repository maintenance exhausted its automatic retries. It keeps re-surveying this store on a growing backoff,",
        "and this issue closes itself on the first verified success.", "",
        `**Last failure:** ${note.lastReason}`,
        `**Next re-survey:** ${clockFromMillisFn(() => note.nextSurveyAt).iso()}`,
        "**Kept leftovers:**", ...kept, ""].join("\n");
      return issues.create(`repository maintenance escalated: ${note.repo}`, body, [NEEDS_HUMAN_LABEL]);
    },
    async close(repo, issueUrl, comment) {
      const url = issueUrl ?? (await findOpen(repo))?.url;
      if (url !== undefined) await issues.closeWithComment?.(url, comment);
    },
  };
}

export interface PrimaryShadowSelection {
  instance: string;
  sourcePath: string;
  digest: string;
  mode: "shadow" | "live";
}

const primaryShadowOperations = new Map<string, Promise<void>>();

/** One instance owns one durable episode; selection digests scope acknowledgements, not issue identity.
 * Unknown selection or an unreadable history never establishes recovery or permission to create. */
export function primaryShadowOperatorChannel(opts: {
  owner: string; repo: string; ledgerPath: string; runId: string;
  selection(): PrimaryShadowSelection | undefined;
  issues?: AsyncIssueGateway;
  clock?: Clock;
  readPrState?(url: string): Promise<{ ok: boolean; state?: string }>;
}): {
  refuse(pr: { prNumber: number; prUrl: string }): Promise<void>;
  reconcile(): Promise<void>;
  resolved(pr: { prNumber: number; prUrl: string }): Promise<void>;
} {
  const issues = opts.issues ?? ghIssueGatewayAsync(opts.owner, opts.repo);
  const clock = opts.clock ?? systemClock;
  type State = { revision: number; first: string; prs: number[]; handledDigests: string[];
    digest: string; sourcePath: string;
    pendingRecovery?: string; publishedTaskId?: string; publishedIssueUrl?: string };
  const states = new Map<string, State>();
  const historyMemo = createLedgerRotationMemo(rows => rows.filter(row =>
    row.step === "primary_shadow.observation" || row.step === "panel.escalation_marked_handled" || row.step === "panel.manual_approved"
    || ((row.step === "escalation.issue_opened" || row.step === "primary_shadow.issue_published")
      && typeof row.task_id === "string" && /^PRIMARY-SHADOW-[a-f0-9]{64}$/.test(row.task_id))), {
    holder: "primary-shadow-notice", durableDigest: { reducerVersion: "primary-shadow-notice-v4" },
    pattern: /primary_shadow\.(observation|issue_published)|panel\.(escalation_marked_handled|manual_approved)|PRIMARY-SHADOW-/, requireObjects: true,
  });
  const identity = (s: PrimaryShadowSelection) => `<!-- primary-shadow ${JSON.stringify([opts.owner, opts.repo, s.instance])} -->`;
  const key = (s: PrimaryShadowSelection) => `PRIMARY-SHADOW-${s.digest}`;
  const list = async () => {
    if (!issues.listOpen) throw new Error("primary shadow alert cannot read open issues");
    return await issues.listOpen(NEEDS_HUMAN_LABEL);
  };
  const state = async (s: PrimaryShadowSelection): Promise<State> => {
    const id = key(s), instanceKey = identity(s), known = states.get(instanceKey);
    if (known) return known;
    let damaged = false;
    const history = await readLedgerUnionRecordsMemoized(dirname(opts.ledgerPath), historyMemo, {
      step: ["primary_shadow.observation", "panel.escalation_marked_handled", "panel.manual_approved", "escalation.issue_opened", "primary_shadow.issue_published"], refuseIncomplete: true,
      onTorn: raw => { if (raw.includes("primary_shadow.observation") || raw.includes("primary_shadow.issue_published")
        || (raw.includes("escalation.issue_opened") && raw.includes("PRIMARY-SHADOW-"))
        || raw.includes("panel.escalation_marked_handled") || raw.includes("panel.manual_approved")) damaged = true; },
    });
    if (!history.ok || damaged) throw new Error("primary shadow alert history is unreadable");
    const current: State = { revision: 0, first: "", prs: [], handledDigests: [], digest: s.digest, sourcePath: s.sourcePath };
    const ownTaskIds = new Set([id, ...history.rows.filter(row => row.instance_key === instanceKey).map(row => row.task_id)]);
    const delivered = new Map<string, string>();
    for (const row of history.rows) {
      if (row.step === "escalation.issue_opened" || row.step === "primary_shadow.issue_published") {
        if (typeof row.issue_url === "string" && typeof row.task_id === "string" && ownTaskIds.has(row.task_id)) {
          delivered.set(row.issue_url, row.task_id);
          current.publishedTaskId = row.task_id; current.publishedIssueUrl = row.issue_url;
        }
        continue;
      }
      if (row.step === "panel.escalation_marked_handled" || row.step === "panel.manual_approved") {
        if (typeof row.task_id === "string" && ownTaskIds.has(row.task_id) && /^PRIMARY-SHADOW-[a-f0-9]{64}$/.test(row.task_id)
          && typeof row.issue_url === "string" && delivered.get(row.issue_url) === row.task_id) {
          const handled = row.task_id.slice("PRIMARY-SHADOW-".length);
          if (!current.handledDigests.includes(handled)) current.handledDigests.push(handled);
        }
        continue;
      }
      if (row.instance_key !== instanceKey && !(row.instance_key === undefined && row.task_id === id)) continue;
      if (!Number.isSafeInteger(row.revision) || Number(row.revision) <= 0 || typeof row.first_refusal_at !== "string"
        || !Array.isArray(row.refused_prs) || row.refused_prs.some(n => !Number.isSafeInteger(n) || n <= 0)
        || (row.pending_recovery !== undefined && (typeof row.pending_recovery !== "string" || !row.pending_recovery))
        || (row.selection_digest !== undefined && (typeof row.selection_digest !== "string" || !/^[a-f0-9]{64}$/.test(row.selection_digest)))) {
        throw new Error("primary shadow alert observation is malformed");
      }
      if (Number(row.revision) >= current.revision) {
        current.revision = Number(row.revision); current.first = row.first_refusal_at; current.prs = [...row.refused_prs];
        current.pendingRecovery = row.pending_recovery as string | undefined;
        current.digest = typeof row.selection_digest === "string" ? row.selection_digest : s.digest;
        current.sourcePath = typeof row.selection_path === "string" ? row.selection_path : s.sourcePath;
      }
    }
    states.set(instanceKey, current);
    return current;
  };
  const save = (s: PrimaryShadowSelection, proposed: State): State => {
    const next = { ...proposed, revision: proposed.revision + 1 };
    appendLedger(opts.ledgerPath, { run_id: opts.runId, task_id: key(s), step: "primary_shadow.observation",
      revision: next.revision, first_refusal_at: next.first, refused_prs: [...next.prs],
      instance_key: identity(s), selection_digest: next.digest, selection_path: next.sourcePath,
      ...(next.pendingRecovery === undefined ? {} : { pending_recovery: next.pendingRecovery }) });
    states.set(identity(s), next);
    return next;
  };
  const close = async (s: PrimaryShadowSelection, open: OpenIssue[], reason: string) => {
    const matching = open.filter(i => i.body?.includes(identity(s))
      && /^PRIMARY-SHADOW-[a-f0-9]{64}$/.test(TASK_LINE_RE.exec(normalizeCandidateBody(i.body))?.[1] ?? ""));
    if (matching.length && !issues.closeWithComment) throw new Error("primary shadow alert cannot close with a recovery citation");
    // Record the positively observed recovery before its transport effect; a failed close retries.
    const current = await state(s);
    if (current.prs.length || current.first || current.pendingRecovery !== reason)
      save(s, { ...current, prs: [], first: "", pendingRecovery: reason });
    for (const issue of matching) {
      await issues.closeWithComment!(issue.url, reason);
      appendLedger(opts.ledgerPath, { run_id: opts.runId,
        task_id: TASK_LINE_RE.exec(normalizeCandidateBody(issue.body!))![1],
        step: "primary_shadow.issue_closed", issue_url: issue.url, reason });
    }
    const recovered = await state(s);
    if (recovered.pendingRecovery) save(s, { ...recovered, pendingRecovery: undefined });
  };
  const publish = async (selected: PrimaryShadowSelection, current: State, boundary: boolean, firstNotice = false): Promise<void> => {
    const open = await list();
    const existing = open.find(i => i.body?.includes(identity(selected))
      && /^PRIMARY-SHADOW-[a-f0-9]{64}$/.test(TASK_LINE_RE.exec(normalizeCandidateBody(i.body))?.[1] ?? ""));
    const begin = "<!-- primary-shadow-observation:start -->", end = "<!-- primary-shadow-observation:end -->";
    const observation = [begin, identity(selected), `Instance: ${selected.instance}`,
      `Selection path: ${JSON.stringify(selected.sourcePath)}`, `Selection digest: ${selected.digest}`,
      `Refusals began: ${current.first}`, `${current.prs.length} refused PRs:`,
      ...current.prs.map(n => `- https://github.com/${opts.owner}/${opts.repo}/pull/${n}`), end].join("\n");
    if (existing) {
      const body = existing.body ?? "", start = body.indexOf(begin), stop = body.indexOf(end, start);
      if (start < 0 || stop < start) throw new Error("primary shadow alert observation section is unavailable");
      const updated = (body.slice(0, start) + observation + body.slice(stop + end.length))
        .replace(/^(\*\*Task:\*\*[ \t]*)\S+/m, `$1${key(selected)}`);
      if (updated !== body) {
        if (!boundary) return;
        // Only the ordinary pass boundary flushes pending edits, through the existing awaited gateway.
        if (!issues.editBody) throw new Error("primary shadow alert cannot update its issue");
        await issues.editBody(existing.url, updated);
      }
      if (boundary && (current.publishedTaskId !== key(selected) || current.publishedIssueUrl !== existing.url)) {
        // An observed matching body also repairs an interrupted edit's missing delivery receipt.
        appendLedger(opts.ledgerPath, { run_id: opts.runId, task_id: key(selected),
          step: "primary_shadow.issue_published", issue_url: existing.url, class: "MANUAL",
          instance_key: identity(selected), reason: "primary shadow alert selection delivered in place" });
      }
    } else if (boundary || firstNotice) {
      const escalation: Escalation = { class: "MANUAL", taskId: key(selected),
        summary: `Primary instance ${selected.instance} refuses merges in shadow mode`, detail: observation,
        consequence: "Reviewed PRs remain unmerged while the primary instance refuses them.",
        options: [
          { label: "Restore intended live mode", detail: "Review the named selection and use the normal qualified deployment path.", kind: { type: "operator-only" } },
          { label: "Acknowledge this selection", detail: "Use the notice's existing mark-handled action to silence only this selection digest.", kind: { type: "operator-only" } },
        ], recommendation: "Restore intended live mode" };
      await escalateAsync(escalation, { issues: { ...issues, listOpen: async () => open }, ledgerPath: opts.ledgerPath, runId: opts.runId });
    }
  };
  const operationKey = JSON.stringify([resolve(opts.ledgerPath), opts.owner, opts.repo]);
  const serial = (body: () => Promise<void>): Promise<void> => {
    const previous = primaryShadowOperations.get(operationKey) ?? Promise.resolve();
    const next = previous.then(async () => { states.clear(); await body(); });
    let tail: Promise<void>;
    const finish = () => {
      // Release readiness only; next retains the operation's rejection for its caller.
      if (primaryShadowOperations.get(operationKey) === tail) primaryShadowOperations.delete(operationKey);
    };
    tail = next.then(finish, finish);
    primaryShadowOperations.set(operationKey, tail);
    return next;
  };
  const resolvePr = async (selected: PrimaryShadowSelection, pr: { prNumber: number; prUrl: string }) => {
    const current = await state(selected);
    if (current.handledDigests.includes(current.digest) || !current.prs.includes(pr.prNumber)) return;
    const remaining = current.prs.filter(n => n !== pr.prNumber);
    if (remaining.length) save(selected, { ...current, prs: remaining });
    else await close(selected, await list(), `Every recorded refused PR has a fresh MERGED observation, including ${pr.prUrl}.`);
  };
  return {
    refuse: pr => serial(async () => {
      const selected = opts.selection();
      if (!selected || selected.mode !== "shadow") return;
      if (!/^[a-f0-9]{64}$/.test(selected.digest) || !Number.isSafeInteger(pr.prNumber) || pr.prNumber <= 0
        || pr.prUrl.toLowerCase() !== `https://github.com/${opts.owner}/${opts.repo}/pull/${pr.prNumber}`.toLowerCase()) {
        throw new Error("primary shadow alert target is not qualified");
      }
      let current = await state(selected);
      if (current.handledDigests.includes(selected.digest)) return;
      const firstNotice = !current.first || (current.publishedTaskId !== undefined
        && current.handledDigests.includes(current.publishedTaskId.slice("PRIMARY-SHADOW-".length)));
      if (!current.prs.includes(pr.prNumber) || current.digest !== selected.digest) current = save(selected, { ...current,
        digest: selected.digest, sourcePath: selected.sourcePath,
        first: current.first || clock.iso(), prs: [...new Set([...current.prs, pr.prNumber])].sort((a, b) => a - b), pendingRecovery: undefined });
      await publish(selected, current, false, firstNotice);
    }),
    reconcile: () => serial(async () => {
      const selected = opts.selection();
      if (!selected) return;
      const open = await list();
      if (selected.mode === "live") {
        const current = await state(selected);
        if (current.prs.length || current.pendingRecovery || open.some(i => i.body?.includes(identity(selected))))
          await close(selected, open, `Primary instance ${selected.instance} is live again; the selected source is readable.`);
        return;
      }
      const current = await state(selected);
      if (current.pendingRecovery) {
        await close(selected, open, current.pendingRecovery);
        return;
      }
      if (current.handledDigests.includes(selected.digest)) return;
      // Production's open-PR population cannot contain a candidate another lane just merged.
      for (const prNumber of current.prs) {
        const prUrl = `https://github.com/${opts.owner}/${opts.repo}/pull/${prNumber}`;
        const observed = await opts.readPrState?.(prUrl);
        if (observed?.ok && observed.state?.toUpperCase() === "MERGED") await resolvePr(selected, { prNumber, prUrl });
      }
      const pending = await state(selected);
      if (pending.prs.length && pending.digest === selected.digest) await publish(selected, pending, true);
    }),
    resolved: pr => serial(async () => {
      const selected = opts.selection();
      if (!selected) return;
      if (!Number.isSafeInteger(pr.prNumber) || pr.prNumber <= 0
        || pr.prUrl.toLowerCase() !== `https://github.com/${opts.owner}/${opts.repo}/pull/${pr.prNumber}`.toLowerCase()) {
        throw new Error("primary shadow alert recovery target is not qualified");
      }
      if (selected.mode === "live") {
        await close(selected, await list(), `Primary instance ${selected.instance} is live again; the selected source is readable.`);
        return;
      }
      await resolvePr(selected, pr);
      // A remaining PR set is durable; its changed body belongs to the next ordinary boundary.
    }),
  };
}

/** The close transport reports whether GitHub accepted the citation or only the terminal close. */
export type IssueCloseOutcome = "commented" | "comment_cap";

/** Per-class label, alongside the blanket `needs-human` queue label. */
const CLASS_LABEL: Record<EscalationClass, string> = {
  BLOCKED: "escalation-blocked",
  MANUAL: "escalation-manual",
  HARD_STOP: "escalation-hard-stop",
  GRILL: "escalation-grill",
};

/** Every needs-me item is one of two asks (W1-T346): an ACTION the operator must PERFORM, or a
 *  QUESTION the operator must ANSWER. See {@link classifyAsk}. */
export type AskType = "action" | "question";

/** Beside the per-class label, alongside `needs-human` — the ask-type queue split (read by escalation-answers.ts). */
export const ASK_TYPE_LABEL: Record<AskType, string> = {
  action: "needs-action",
  question: "needs-question",
};

/** Does this ONE option's own text name something only the OPERATOR can do — grant an override
 *  credential, act by hand, or run a host command — rather than something the MACHINE carries out once
 *  the operator picks a label? The three idioms come from the corpus {@link classifyAsk} is derived
 *  from: the CAPPED verdict's `--override-capped-by` escape hatch, the risk judge's "merge it by hand"
 *  option, and the circuit-breaker family's backtick host commands. Why: docs/forensics/escalate.md. */
function namesOperatorOnlyAct(option: EscalationOption): boolean {
  const text = `${option.label} ${option.detail}`;
  return (
    /--override[-\w]*\b/i.test(text) ||
    /\bby hand\b|\bhand-merge\b/i.test(text) ||
    /`(?:rmd|gh|git|launchctl|npm|node|bash|sh)\b[^`]*`/.test(text)
  );
}

/** W1-T346; MASTER-PLAN §4: pure, total classification from existing fields, never an LLM.
 * MANUAL is ACTION; GRILL is QUESTION; otherwise {@link namesOperatorOnlyAct} tests options.
 * INVARIANT: uncertainty defaults ACTION: misclassifying real work as a question hides it.
 * Why: docs/forensics/escalate.md. */
export function classifyAsk(e: Escalation): AskType {
  if (e.class === "MANUAL") return "action";
  if (e.class === "GRILL") return "question";
  if (e.options.length > 0 && e.options.every((o) => !namesOperatorOnlyAct(o))) return "question";
  return "action";
}

/** The label every escalation issue carries — the queue the control panel reads (§4). */
export { NEEDS_HUMAN_LABEL };

/** The DEMOTED queue label (W1-T349): a fleet notice is a needs-human issue {@link judgeEscalation}
 *  decided did not need real-time attention. It keeps every other label and the full body, so it
 *  leaves the NEEDS ME board while staying open, durable and searchable. Nothing is deleted;
 *  recovery is a relabel. See {@link escalateWithJudge}. */
export const FLEET_NOTICE_LABEL = "fleet-notice";

// ── OPERATOR PRESENCE (P34 clause (e), MASTER-PLAN §7B/§4; ratified round iii) ──────────────
//
// INVARIANT: this flag keys escalation DELIVERY only, never dispatch. It answers one question —
// does a MANUAL/HARD_STOP escalation page the operator now (ATTENDED), or batch into the W1-T163
// recap for an async verdict (AWAY)? Either way `escalate()` opens the issue and ledgers
// `escalation.issue_opened` UNCONDITIONALLY, and away mode changes only whether the caller pings.
// TRAP: reading this from any dispatch decision would resurrect the presence×risk matrix round iii
// killed. FALSIFIER: test/away-mode-delivery.test.ts.
// Why: the round-iii ratification that killed the dispatch matrix (P34) — docs/forensics/escalate.md.
//
// W1-T4674: the flag is still the OVERRIDE, but with no flag set, presenceMode() no longer
// assumes attended — it infers from the operator's own recent activity (src/lib/presence.ts),
// so an operator who forgot to flip the flag still reads away once they've gone quiet long enough.
// FALSIFIER: test/presence-is-inferred-from-activity.test.ts.

export type PresenceMode = "attended" | "away";

/** `<root>/state/AWAY` — the same existence-gated flag idiom as fleet-control.ts's
 *  STOP/PAUSE: a corrupt/unreadable state dir still fails to the SAFE default
 *  (`"attended"`, i.e. deliver exactly as today), never silently goes quiet. */
export function awayFilePath(root: string): string {
  return join(root, "state", "AWAY");
}

/** W1-T4674 (iii): a manual flag overrides {@link inferOperatorPresence}'s activity inference.
 * Without a flag or activity history, a cold root defaults attended (presence.ts explains why). */
export function presenceMode(root: string): PresenceMode {
  if (existsSync(awayFilePath(root))) return "away";
  return inferOperatorPresence(root);
}

/** `rmd away on|off` — the operator sets the mode explicitly (MASTER-PLAN §7B/§4). `"away"` writes
 *  the flag, `"attended"` clears it; idempotent either way. */
export function setPresenceMode(root: string, mode: PresenceMode): void {
  const path = awayFilePath(root);
  if (mode === "away") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ setAt: new Date().toISOString() }, null, 2));
    return;
  }
  if (existsSync(path)) unlinkSync(path);
}

/** Should an escalation for this class deliver as a real-time, sync-answer-expecting ping right now?
 *  `false` means batch into the recap: the caller skips its own `notify()` and relies on the
 *  `escalation.issue_opened` line {@link escalate} already ledgers unconditionally. ATTENDED, the
 *  default, returns `true` for every class exactly as before this flag existed. */
export function deliversRealtime(root: string): boolean {
  return presenceMode(root) === "attended";
}

// ── A DEFAULT ANSWER, LEDGERED AND UNDOABLE (W1-T4675, MASTER-PLAN §4) ──────────────────────
//
// `e.recommendation` already names the machine's default (§4); nothing ACTED on it, so a
// QUESTION nobody answered sat open forever. Once a QUESTION-shaped escalation ({@link
// classifyAsk} — an ACTION has no "default" to fall back to) has been SEEN and an ADAPTIVE
// WINDOW passes unanswered, the fleet takes the recommendation as the answer, ledgered with
// origin `"default"`, reversible by one {@link undoDefaultAnswer} call. MANUAL/HARD_STOP never
// auto-default (design iii), checked BEFORE the question/action split. The window is LEARNED
// (design ii), reusing presence.ts's own reply-latency lease rather than a second computation —
// its doc names this task as the sibling reader. This module carries no state: "seen" is a read
// mark the caller supplies. Why: docs/forensics/escalate.md.

const NEVER_AUTO_DEFAULT_CLASSES: ReadonlySet<EscalationClass> = new Set(["MANUAL", "HARD_STOP"]);

/** Why {@link shouldApplyDefault} refused — named, never a bare boolean. */
export type DefaultApplyRefusal = "never-auto-defaults" | "not-a-question" | "not-seen" | "window-not-passed";

export type DefaultApplyDecision =
  | { readonly applied: true; readonly option: string }
  | { readonly applied: false; readonly reason: DefaultApplyRefusal };

/** Pure, total, no I/O: should `e`'s recommendation apply as its answer right now? The
 *  never-auto-default check runs FIRST (design iii), before question/action, seen or window. */
export function shouldApplyDefault(
  e: Escalation,
  opts: { readonly seenAtMs?: number; readonly nowMs: number; readonly windowMs: number },
): DefaultApplyDecision {
  if (NEVER_AUTO_DEFAULT_CLASSES.has(e.class)) return { applied: false, reason: "never-auto-defaults" };
  if (classifyAsk(e) !== "question") return { applied: false, reason: "not-a-question" };
  if (opts.seenAtMs === undefined) return { applied: false, reason: "not-seen" };
  if (opts.nowMs - opts.seenAtMs < opts.windowMs) return { applied: false, reason: "window-not-passed" };
  return { applied: true, option: e.recommendation };
}

/** The window a seen question must sit unanswered before its default applies (design ii) —
 *  learned from presence.ts's own reply-latency lease, never a fixed number. */
export function defaultAnswerWindowMs(root: string): number {
  return learnLeaseMs(replyLatenciesMs(root));
}

export const DEFAULT_ANSWER_APPLIED_STEP = "escalation.default_applied";
/** The single-action undo step (design ii). */
export const DEFAULT_ANSWER_UNDONE_STEP = "escalation.default_undone";
/** Origin a taken default carries — read back like an operator's own typed answer. */
export const DEFAULT_ANSWER_ORIGIN = "default";

/** What {@link applyDefaultAnswer} hands back so a caller can later {@link undoDefaultAnswer}
 *  the SAME default without re-deriving it. */
export interface AppliedDefaultAnswer {
  readonly taskId: string;
  readonly class: EscalationClass;
  readonly option: string;
  readonly origin: "default";
  readonly appliedAtMs: number;
}

/** Apply `e`'s default now if {@link shouldApplyDefault} says yes, ledgering {@link
 *  DEFAULT_ANSWER_APPLIED_STEP}. A refusal writes nothing — no trace of a change that never
 *  happened. */
export function applyDefaultAnswer(
  e: Escalation,
  opts: { readonly seenAtMs?: number; readonly nowMs: number; readonly windowMs: number },
  deps: EscalateDeps,
): DefaultApplyDecision & { readonly answer?: AppliedDefaultAnswer } {
  const decision = shouldApplyDefault(e, opts);
  if (!decision.applied) return decision;
  const answer: AppliedDefaultAnswer = {
    taskId: e.taskId,
    class: e.class,
    option: decision.option,
    origin: DEFAULT_ANSWER_ORIGIN,
    appliedAtMs: opts.nowMs,
  };
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: e.taskId,
    step: DEFAULT_ANSWER_APPLIED_STEP,
    class: e.class,
    option: answer.option,
    origin: answer.origin,
    seen_at_ms: opts.seenAtMs,
    applied_at_ms: answer.appliedAtMs,
    window_ms: opts.windowMs,
  });
  return { ...decision, answer };
}

/** Undo ONE previously-applied default (design ii, "a single action undoes it") — ledgers
 *  {@link DEFAULT_ANSWER_UNDONE_STEP} naming the same option and the applied instant reversed. */
export function undoDefaultAnswer(answer: AppliedDefaultAnswer, deps: EscalateDeps): void {
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: answer.taskId,
    step: DEFAULT_ANSWER_UNDONE_STEP,
    class: answer.class,
    option: answer.option,
    origin: answer.origin,
    undoes_applied_at_ms: answer.appliedAtMs,
  });
}

// ── RESIDUAL ESCALATION JUDGE (W1-T349, MASTER-PLAN §4B) ───────────────────────────────────
//
// Routing-only, downstream of the deterministic stack: the reconciler retires most volume by
// watching a referenced PR resolve, and this judge is for the RESIDUE it cannot see. It reads the
// full typed {@link Escalation} at the one choke point every producer crosses ({@link escalate}).
//
// THE ASYMMETRY THAT GOVERNS EVERYTHING HERE is the mirror of risk-judge.ts's. There a false
// positive is the costly direction, so an unreadable verdict fails CLOSED. Here a false NEGATIVE —
// demoting something the operator needed — hides work he cannot know to look for, while a false
// positive costs him one skim. So this judge may only DEMOTE, and {@link judgeEscalation} fails
// OPEN to `deliver` on every unreadable-verdict path. It never runs on a duplicate, and never at
// all for MANUAL/GRILL: {@link isEscalationJudgeExempt} is checked BEFORE the judge dependency is
// called, so an exempt class is delivered by never being asked.
// Why: the residue this judge exists for, and its polarity (W1-T349) — docs/forensics/escalate.md.

/** What {@link judgeEscalation} decides for one escalation. Demote-only by construction — there
 *  is no third value that could mean "drop"; the type itself cannot express suppression. */
export type EscalationJudgeDecision = "demote" | "deliver";

/** The step {@link escalateWithJudge} writes for EVERY judged escalation, both arms — proving the
 *  judge had NEVER run took three reads because no such row existed. READER: the operator, and
 *  W1-T3167's re-judge rung, which needs demotion history to avoid re-asking a settled question.
 *  Retained across rotation in DECISION_RELEVANT_LEDGER_STEPS (lib/ledger.ts), same change. */
export const ESCALATION_JUDGED_STEP = "escalation.judged";

/** W1-T8868 — the step {@link triageRoute} writes for EVERY newly-opened escalation, in shadow and act
 *  mode alike: the would-be (or taken) triage outcome. READER: the operator calibrating the shadow. */
export const ESCALATION_TRIAGED_STEP = "escalation.triaged";

/** The judge's verdict. `reason` is ledgered verbatim and, on a demotion, becomes the FIRST
 *  comment on the fleet-notice issue (design clause ii) — so the demotion is never silent. */
export interface EscalationJudgeVerdict {
  decision: EscalationJudgeDecision;
  reason: string;
}

/** Classes exempt from judgement ENTIRELY — MANUAL and GRILL are operator-owned by rule. Anything
 *  the operator's own CLI escalated is exempt STRUCTURALLY, not by a field read here:
 *  `escalateCommand` (run-task.ts) calls {@link escalate}, never {@link escalateWithJudge}. */
export function isEscalationJudgeExempt(e: Escalation): boolean {
  return e.class === "MANUAL" || e.class === "HARD_STOP" || e.class === "GRILL";
}

/** Render the judge's prompt — the FULL typed {@link Escalation} at the one choke point every
 *  producer crosses. Carries the asymmetry explicitly: WHEN IN DOUBT, DELIVER. */
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

/** FAIL-OPEN default: a spawn error, a timeout, an unparseable verdict or a governor refusal all
 *  resolve to this — needs-human, unchanged. The OPPOSITE polarity from risk-judge.ts's fail-closed
 *  default, because the costly direction here is silently hiding work. */
const FAIL_OPEN_JUDGE_VERDICT: EscalationJudgeVerdict = {
  decision: "deliver",
  reason:
    "judge output carried no parseable ESCALATION_JUDGE_DECISION — failing open to deliver " +
    "(never silently hide work from the operator)",
};

type EscalationJudgeOutputState = "accepted" | "unparseable";
interface EscalationJudgeReceipt {
  state: EscalationJudgeOutputState;
  decision: EscalationJudgeDecision;
  runId: string;
  assignmentId?: string;
}
// Keep telemetry off the public verdict shape. Reusing a verdict object preserves its receipt;
// a clone or an injected verdict has no producer receipt and must remain explicitly unknown.
const escalationJudgeReceipts = new WeakMap<EscalationJudgeVerdict, EscalationJudgeReceipt>();

/** Original model-output evidence, not the final triage decision or verified correctness.
 * Only the real judge producer can supply it; arbitrary properties are never ledgered. */
export function escalationJudgeReceiptFields(verdict: EscalationJudgeVerdict): Record<string, string> {
  const receipt = escalationJudgeReceipts.get(verdict);
  if (!receipt) return { judge_output_state: "unknown" };
  return {
    judge_output_state: receipt.state,
    judge_output_decision: receipt.decision,
    judge_run_id: receipt.runId,
    ...(receipt.assignmentId === undefined ? {} : { judge_selection_assignment_id: receipt.assignmentId }),
  };
}

/** Parse the judge's `ESCALATION_JUDGE_DECISION`/`ESCALATION_JUDGE_REASON` lines. A missing or
 *  unrecognised decision fails OPEN ({@link FAIL_OPEN_JUDGE_VERDICT} — `deliver`, never `demote`). */
export function parseEscalationJudgeVerdict(text: string): EscalationJudgeVerdict {
  return parseEscalationJudgeOutput(text).verdict;
}

function parseEscalationJudgeOutput(text: string): { verdict: EscalationJudgeVerdict; state: EscalationJudgeOutputState } {
  const decisionMatch = text.match(/ESCALATION_JUDGE_DECISION:\s*(\w+)/i);
  const decision = decisionMatch?.[1]?.toLowerCase() as EscalationJudgeDecision | undefined;
  if (!decision || !VALID_JUDGE_DECISIONS.has(decision)) {
    return { verdict: { ...FAIL_OPEN_JUDGE_VERDICT }, state: "unparseable" };
  }
  const reasonMatch = text.match(/ESCALATION_JUDGE_REASON:\s*(.+)/i);
  const reason = reasonMatch?.[1]?.trim() || "(no reason stated)";
  return { verdict: { decision, reason }, state: "accepted" };
}

/** Injectable judge dependency — real callers wire this to {@link realEscalationJudge}; tests
 *  inject a fake, exactly as risk-judge.ts's `RiskJudgeDeps.judge`/flight-judge.ts's
 *  `FlightJudgeDeps.judge`. */
export interface EscalationJudgeDeps {
  judge: (e: Escalation) => Promise<EscalationJudgeVerdict>;
}

/** Decide demote|deliver for ONE escalation. EXEMPT classes are delivered WITHOUT ever calling
 *  `deps.judge`, so a judge stub that would demote a MANUAL item cannot influence the outcome. A
 *  judge-unavailable error is caught HERE and fails OPEN to `deliver` — the cannot-observe →
 *  DELIVER polarity, mirroring risk-judge.ts's cannot-observe → ESCALATE. */
export async function judgeEscalation(e: Escalation, deps: EscalationJudgeDeps): Promise<EscalationJudgeVerdict> {
  if (isEscalationJudgeExempt(e)) {
    return { decision: "deliver", reason: `${e.class} is operator-owned by rule — exempt from judgement` };
  }
  try {
    const verdict = await deps.judge(e);
    if (!verdict || !VALID_JUDGE_DECISIONS.has(verdict.decision) || typeof verdict.reason !== "string") {
      return { ...FAIL_OPEN_JUDGE_VERDICT };
    }
    return verdict;
  } catch (err) {
    return {
      decision: "deliver",
      reason: `judge unavailable (${err instanceof Error ? err.message : String(err)}) — failing open to ` +
        "deliver, never silently hiding work from the operator",
    };
  }
}

// ── The real spawn (read-only BY CONSTRUCTION — no tools at all, mirrors risk-judge.ts) ────────

/** The judge's SDK tool allowlist — EMPTY by construction, like risk-judge.ts's: everything it needs
 *  is baked into the prompt, so it has no ability to explore the worktree or take any action. */
export const ESCALATION_JUDGE_TOOLS: string[] = [];

/** W1-T4645: one judge decision's run id — a digest of exactly what was judged. */
export function escalationJudgeRunId(e: Escalation): string {
  const digest = createHash("sha256").update(buildEscalationJudgePrompt(e)).digest("hex").slice(0, 12);
  return `escalation-summary-${e.taskId}-${digest}`;
}

/** Build the {@link SpawnWorkerArgs} for a real escalation-judge spawn — a pure function so the
 *  "no tools, cheapest mount" contract is unit-testable without a spawn. */
export function buildEscalationJudgeSpawnArgs(opts: {
  escalation: Escalation;
  mount: Mount;
  cwd: string;
  settingsFile: string;
}): SpawnWorkerArgs {
  return withReceiptIdentity({
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    prompt: buildEscalationJudgePrompt(opts.escalation),
    model: opts.mount.model,
    effort: opts.mount.effort,
    maxTurns: opts.mount.maxTurns,
    tools: ESCALATION_JUDGE_TOOLS,
    // W1-T3614: mount affinity, the same field every other routed spawn passes. Undefined leaves
    // the capacity auction untouched, so an unrouted table behaves exactly as it always did.
    ...(opts.mount.provider === undefined ? {} : { mountProvider: opts.mount.provider }),
  }, { taskId: opts.escalation.taskId, runId: escalationJudgeRunId(opts.escalation), guardrailLane: "escalation-judge" });
}

/** Spawn the real judge and parse its verdict. Untested by unit (it shells out via the SDK); {@link
 *  buildEscalationJudgeSpawnArgs} and {@link parseEscalationJudgeVerdict} carry the contract. */
export async function spawnEscalationJudgeWorker(opts: {
  escalation: Escalation;
  mount: Mount;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): Promise<WorkerResult> {
  const spawn = opts.spawn ?? benchmarkNonDispatchSpawn("escalation-summary");
  return spawn(buildEscalationJudgeSpawnArgs(opts));
}

/** Build a `judge` wired to a real spawn on the CHEAPEST configured mount — one cheap-mount call per
 *  delivered escalation. Reuses {@link resolveRiskJudgeMount} rather than re-deriving the same
 *  routing-table walk: that resolver is generic, never risk-specific, despite its name. */
export function realEscalationJudge(opts: {
  mounts: Mounts;
  cwd: string;
  settingsFile: string;
  spawn?: typeof spawnWorker;
}): (e: Escalation) => Promise<EscalationJudgeVerdict> {
  // W1-T3614: the table's OWN escalation-judge row wins when present, so this lane can carry a
  // `provider` without moving the workers `resolveRiskJudgeMount` scans. Absent, behaviour is
  // byte-identical to before: the cheapest routed cell.
  const mount = opts.mounts.escalation_judge ?? resolveRiskJudgeMount(opts.mounts);
  return async (e: Escalation) => {
    const runId = escalationJudgeRunId(e);
    const result = await spawnEscalationJudgeWorker({
      escalation: e,
      mount,
      cwd: opts.cwd,
      settingsFile: opts.settingsFile,
      spawn: opts.spawn,
    });
    const parsed = parseEscalationJudgeOutput(result.text);
    const assignmentId = result.selectionAssignmentId;
    escalationJudgeReceipts.set(parsed.verdict, {
      state: parsed.state, decision: parsed.verdict.decision, runId,
      ...(typeof assignmentId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assignmentId)
        ? { assignmentId } : {}),
    });
    return parsed.verdict;
  };
}

/** impl-DY: pure PR referent readback from {@link renderIssueBody}, not a completion check.
 * INVARIANT: require a FULL `/pull/<n>` URL; bare `#707` may name an unrelated sibling issue.
 * Why: docs/forensics/escalate.md. */
export function prReferentFromIssueText(text: string | undefined): number | undefined {
  const m = /\/pull\/(\d+)/.exec(text ?? "");
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Conservative title bound from the observed createIssue refusal; UTF-16 also bounds astral text safely. */
const GITHUB_ISSUE_TITLE_LIMIT = 256;
function unboundedEscalationTitle(e: Pick<Escalation, "class" | "taskId" | "summary">): string {
  return `[${e.class}] ${e.taskId}: ${e.summary}`;
}

export function escalationIssueTitle(e: Pick<Escalation, "class" | "taskId" | "summary">): string {
  const title = unboundedEscalationTitle(e);
  if (title.length <= GITHUB_ISSUE_TITLE_LIMIT) return title;
  return title.replace(/[\r\n\u2028\u2029]/g, " ").slice(0, GITHUB_ISSUE_TITLE_LIMIT - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

function fullEscalationSummaryLine(e: Pick<Escalation, "summary">): string {
  const text = JSON.stringify(e.summary).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return `**Full summary (JSON):** ${text}`;
}

const MACHINE_FIELDS_HEADING = "## Machine fields";
const OPTIONS_SECTION = "## Options\n";
const RECOMMENDATION_SECTION = "## Recommendation\n";
const DETAILS_SECTION = "## Details\n";
const SECTION_OFFSETS_COMMENT = "<!-- remudero:escalation-sections ";
const ISSUE_FOOTER = "_Opened automatically by Remudero (MASTER-PLAN §4 escalation taxonomy). Closing this issue does_";

/** Open with the decision summary or the producer's summary, then the choices. Keep the raw detail
 * intact for diagnostics and always name Host so operators can identify the affected machine. */
export function renderIssueBody(e: Escalation, notices: readonly string[] = []): string {
  const decisionSummary = validateDecisionSummary(e.decisionSummary ?? null);
  const summary = decisionSummary
    ? ["## Decision Summary", decisionSummary.headline, "", decisionSummary.what_happened, "", `**Decision:** ${decisionSummary.decision}`].join("\n")
    : e.summary.replace(/[\r\n\u2028\u2029]/g, " ");
  const options = OPTIONS_SECTION + e.options.map((o) => `- **${o.label}** — ${o.detail}`).join("\n");
  const recommendation = RECOMMENDATION_SECTION + e.recommendation;
  const lfLength = (section: string) => section.replaceAll("\r\n", "\n").length;
  const optionsAt = lfLength(summary) + 2;
  const recommendationAt = optionsAt + lfLength(options) + 2;
  const detailsAt = recommendationAt + lfLength(recommendation) + 2;
  const lines = [
    summary,
    "",
    options,
    "",
    recommendation,
    "",
    DETAILS_SECTION + e.detail,
    "",
    ISSUE_FOOTER,
    "_not resolve the underlying block by itself — act on it, then resume via `rmd drain`._",
    // W1-T4471: how to answer — QUESTION issues only (an ACTION is performed, not answered);
    // owner-only per G-6, see lib/escalation-answers.ts.
    ...(classifyAsk(e) === "question"
      ? [
          "",
          "**To answer:** reply on this issue (repository owner only — every other reply is",
          "counted and ignored) or reply in the console's escalation panel. Either lands in the",
          "same place the next fix round reads.",
        ]
      : []),
    ...notices.flatMap((notice) => ["", notice]),
    "",
    SECTION_OFFSETS_COMMENT + `${optionsAt} ${recommendationAt} ${detailsAt} -->`,
    "",
    MACHINE_FIELDS_HEADING,
    `**Class:** ${e.class}`,
    `**Task:** ${e.taskId}`,
    `**Host:** ${hostname()}`,
    e.runId ? `**Run:** ${e.runId}` : undefined,
    e.headSha ? `**Head:** ${e.headSha}` : undefined,
    e.cause ? `**Cause:** ${e.cause}` : undefined,
    e.contractRevision ? `**Contract:** ${e.contractRevision}` : undefined,
    ...(escalationIssueTitle(e) !== unboundedEscalationTitle(e) ? [fullEscalationSummaryLine(e)] : []),
  ].filter((l): l is string => l !== undefined);
  return lines.join("\n");
}

/** Writer offsets in LF-normalized text keep quoted headings in their own prose sections. */
export function readEscalationIssueSections(body: string): {
  summary: string; options: string; recommendation: string; detail: string;
} | undefined {
  body = body.replaceAll("\r\n", "\n");
  const marker = body.lastIndexOf(`\n\n${SECTION_OFFSETS_COMMENT}`);
  if (marker === -1) return undefined;
  const offsets = /^(\d+) (\d+) (\d+) -->\n\n## Machine fields\n/.exec(body.slice(marker + 2 + SECTION_OFFSETS_COMMENT.length));
  if (!offsets) return undefined;
  const optionsAt = Number(offsets[1]), recommendationAt = Number(offsets[2]), detailsAt = Number(offsets[3]);
  const optionsStart = optionsAt + OPTIONS_SECTION.length;
  const recommendationStart = recommendationAt + RECOMMENDATION_SECTION.length;
  const detailsStart = detailsAt + DETAILS_SECTION.length;
  const footerAt = body.lastIndexOf(`\n\n${ISSUE_FOOTER}`, marker);
  if (optionsAt < 2 || recommendationAt < optionsStart + 2 || detailsAt < recommendationStart + 2 || footerAt < detailsStart
      || !body.startsWith(`\n\n${OPTIONS_SECTION}`, optionsAt - 2)
      || !body.startsWith(`\n\n${RECOMMENDATION_SECTION}`, recommendationAt - 2)
      || !body.startsWith(`\n\n${DETAILS_SECTION}`, detailsAt - 2)) return undefined;
  return {
    summary: body.slice(0, optionsAt - 2),
    options: body.slice(optionsStart, recommendationAt - 2),
    recommendation: body.slice(recommendationStart, detailsAt - 2),
    detail: body.slice(detailsStart, footerAt),
  };
}

/** Summarize ONE escalation into a {@link DecisionSummary}, FAIL-OPEN like feedback.ts's
 *  `summarizeFeedbackProposal`: a throw, a rejection or an invalid response all resolve to `null`
 *  and never block escalation creation. INVARIANT: `options` is NEVER taken from the summarizer's
 *  response — §4 already refuses an escalation with no options, so this rung passes the escalation's
 *  OWN options through verbatim rather than trusting a paraphrase (W1-T313). */
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

/** W1-T5283: `G` is {@link AsyncIssueGateway} for {@link escalateAsync}, which awaits each call. */
export interface EscalateDeps<G extends AsyncIssueGateway = IssueGateway> {
  issues: G;
  ledgerPath: string;
  runId: string;
  /** OPTIONAL (W1-T2494) — path to the JSONL thread store {@link appendThreadMessage} writes to.
   *  Every caller predating this task omits it: {@link recordThreadMessage} no-ops when unset. */
  threadStorePath?: string;
  /** OPTIONAL (W1-T8868) — how this call triages its escalation. Absent is SHADOW mode: the would-be
   *  outcome is ledgered as `escalation.triaged` and the escalation is delivered exactly as before. */
  triage?: EscalateTriageSettings;
  /** OPTIONAL (W1-T13218) — the clock the rolling observation comment reads; defaults to real time. */
  clock?: Clock;
}

/** W1-T8868 — the knobs {@link triageRoute} reads. Every field is optional; an absent `execute`
 *  entry means that action is not wired, and an auto-resolve for it is DELIVERED instead. */
export interface EscalateTriageSettings {
  /** `shadow` (default) ledgers and still delivers; `act` follows the outcome. */
  mode?: EscalationTriageMode;
  /** The shared pass allowance; absence refuses execution. */
  pass?: TriagePass;
  /** Caller-known evidence the escalation text cannot carry (seen window, re-kick history). */
  evidence?: (e: Escalation) => TriageEvidence;
  judge?: EscalationJudgeDeps["judge"];
  /** The reversible executors, keyed by the CLOSED {@link TriageAction} set. Each returns a one-line
   *  account of the effect AND how to undo it; a throw means the action failed → deliver. */
  execute?: Partial<Record<TriageAction, (e: Escalation) => string | Promise<string>>>;
  observe?: (e: Escalation, action: TriageAction, effect: string) => string | undefined | Promise<string | undefined>;
  /** Production actions can require an async driver before starting any effect. */
  asyncExecutors?: boolean;
}

let productionTriage: ((deps: EscalateDeps<AsyncIssueGateway>) => EscalateTriageSettings) | undefined;

export function configureEscalationTriage(factory: typeof productionTriage): void {
  productionTriage = factory;
}

/** Pull a PR reference out of free text — a full `/pull/<n>` URL, or a bare `PR #<n>`/`PR <n>` — and
 *  return the number. Every current `escalate()` caller embeds one in `summary` or `detail`, so
 *  dedup needs no new field: the CONTENT already carries it. `undefined` means no PR is named, and
 *  those never participate in dedup. */
function extractPrRef(text: string): string | undefined {
  return (
    /\/pull\/(\d+)\b/.exec(text)?.[1] ?? /\bPR\s*#(\d+)\b/i.exec(text)?.[1] ?? /\bPR\s+(\d+)\b/i.exec(text)?.[1]
  );
}

/** W1-T1103 (iii): can the written taskId name a retirable referent? Reject empty/whitespace
 * (`**Task:**` requires `\S+`) and stringified missing values `"undefined"`/`"null"`.
 * Real task IDs and GRILL's `TRIAGE-<feedbackId>` avoid these. Why: docs/forensics/escalate.md. */
function isKnownBrokenTaskId(taskId: string): boolean {
  const trimmed = taskId.trim();
  return trimmed === "" || trimmed === "undefined" || trimmed === "null";
}

/** RESOLVE A REFERENT OR SAY SO (W1-T1103, design iii). Returns the taskId {@link escalate} should
 *  render, or `undefined` when nothing resolvable is available — the caller then refuses to open
 *  rather than mint a permanent operator obligation. `e.taskId` passes through byte-identical unless
 *  {@link isKnownBrokenTaskId} names it; only then does the PR-referent fallback apply, using the
 *  SAME `extractPrRef` scan dedup runs and the `PR-<n>` shape run-task.ts already resolves. */
function resolvedTaskId(e: Escalation): string | undefined {
  if (!isKnownBrokenTaskId(e.taskId)) return e.taskId;
  const prRef = extractPrRef(`${e.summary}\n${e.detail}`);
  return prRef ? `PR-${prRef}` : undefined;
}

/** The `**Task:** <id>` line {@link renderIssueBody} writes on every issue — the same
 *  regex the escalation-lifecycle reconciler (run-task.ts) already reads task ids with. */
const TASK_LINE_RE = /^\*\*Task:\*\*\s*(\S+)\s*$/m;

/** The `**Class:** <class>` line {@link renderIssueBody} writes UNCONDITIONALLY (never optional,
 *  unlike Head/Cause) — the second dimension of the W1-T345 referent-less dedup key. */
const CLASS_LINE_RE = /^\*\*Class:\*\*\s*(\S+)\s*$/m;

/** The `**Head:** <sha>` line {@link renderIssueBody} writes ONLY when {@link Escalation.headSha}
 *  is set (W1-T195) — absent on every issue predating this task or opened by an un-migrated caller. */
const HEAD_SHA_LINE_RE = /^\*\*Head:\*\*\s*(\S+)\s*$/m;

/** The `**Cause:** <review|ci|conflict>` line {@link renderIssueBody} writes ONLY when {@link
 *  Escalation.cause} is set (W1-T195) — absent by default, like {@link HEAD_SHA_LINE_RE}. */
const CAUSE_LINE_RE = /^\*\*Cause:\*\*\s*(\S+)\s*$/m;

/** The `**Contract:** <revision>` line {@link renderIssueBody} writes ONLY when {@link
 *  Escalation.contractRevision} is set (W1-T3579) — absent on every issue predating this task or
 *  opened by a producer this task did not migrate, like {@link HEAD_SHA_LINE_RE}/{@link
 *  CAUSE_LINE_RE}. Exported (unlike its two siblings) so a test can drive both arms of this
 *  validator directly by identifier — see test/fix-rung-open-escalation-stand-down.test.ts. */
/** W1-T3579: revision of the authoritative task identity, sorted files and ordered claim/proof
 * pairs; exclude volatile/decorative fields (status, attempts, satisfied_by, holdout).
 * TRAP: PORTAL-T4 (remudero-site PR #21, 2026-09-14) stayed blocked after a scope amendment
 * authorized the same repair/head. A changed contract must release that stand-down.
 * PURE: hash the caller's live Task/runFixRung opts.task, never disk, reports or PR-body prose;
 * otherwise a worker could authorize its own re-admission (design i). */
export function taskContractRevision(task: {
  id: string;
  files?: readonly string[];
  acceptance?: ReadonlyArray<{ claim: string; proof: string }>;
}): string {
  const files = [...(task.files ?? [])].sort();
  const acceptance = (task.acceptance ?? []).map((c) => ({ claim: c.claim, proof: c.proof }));
  return createHash("sha256").update(JSON.stringify({ id: task.id, files, acceptance })).digest("hex");
}

export function taskSemanticRevision(task: {
  design?: unknown; amendment?: unknown; narrativeUnavailable?: true;
}): string | undefined {
  if (task.narrativeUnavailable || [task.design, task.amendment].some(value => value !== undefined && typeof value !== "string")) return undefined;
  return `narrative-v1:${createHash("sha256").update(JSON.stringify({
    design: task.design ?? "", amendment: task.amendment ?? "",
  })).digest("hex")}`;
}

export const CONTRACT_REVISION_LINE_RE = /^\*\*Contract:\*\*\s*(\S+)\s*$/m;

/** Prefer the trailing producer fields to similarly labelled lines in the issue's prose. */
function machineFields(body = ""): string | undefined {
  body = body.replaceAll("\r\n", "\n");
  if (/^\*\*Class:\*\* [^\n]*\n\*\*Task:\*\* /.test(body)) return undefined;
  const marker = `\n\n${MACHINE_FIELDS_HEADING}\n`;
  const start = body.lastIndexOf(marker);
  return start === -1 ? undefined : body.slice(start + marker.length).split("\n\n", 1)[0];
}

/** The `**Head:** <sha>` sha an already-open issue's body carries, or `undefined` (W1-T2799). Reads
 *  through the SAME {@link HEAD_SHA_LINE_RE} {@link findDuplicateEscalation} matches on — ONE parser,
 *  so a caller asking "is this issue about the head I am about to strike against?" can never disagree
 *  with `escalate()`'s dedup. Exported because the fix rung's pre-strike gate must be STRICTER:
 *  {@link matchesOptionalDimension} is permissive on an absent dimension, the wrong polarity there. */
export function escalationHeadSha(body: string | undefined): string | undefined {
  return HEAD_SHA_LINE_RE.exec(machineFields(body) ?? body ?? "")?.[1];
}

export function escalationIssueCause(body: string | undefined): string | undefined {
  const normalized = normalizeCandidateBody(body ?? "");
  return CAUSE_LINE_RE.exec(machineFields(normalized) ?? normalized)?.[1];
}

/** The `**Task:** <id>` an already-open issue's body carries, or `undefined` (W1-T4471) — via the
 *  SAME {@link TASK_LINE_RE} dedup matches on, so lib/escalation-answers.ts reuses one parser. */
export function escalationTaskId(body: string | undefined): string | undefined {
  return TASK_LINE_RE.exec(machineFields(body) ?? body ?? "")?.[1];
}

export function escalationIssueClass(body: string | undefined): string | undefined {
  return CLASS_LINE_RE.exec(machineFields(body) ?? body ?? "")?.[1];
}

/** The `**Contract:** <revision>` an already-open issue's body carries, or `undefined` (W1-T3579).
 *  Reads through the SAME {@link CONTRACT_REVISION_LINE_RE} {@link findDuplicateEscalation}
 *  matches on — ONE parser, exactly like {@link escalationHeadSha} beside it. Exported so the fix
 *  rung's pre-strike gate can compare a candidate's RECORDED contract against the CURRENT one it
 *  is about to strike against. */
export function escalationContractRevision(body: string | undefined): string | undefined {
  return CONTRACT_REVISION_LINE_RE.exec(machineFields(body) ?? body ?? "")?.[1];
}

/** Does an OPTIONAL composite-key dimension veto a dedup match? Only when BOTH sides carry a value
 *  and they DISAGREE — either side missing says nothing, which keeps every un-migrated caller's
 *  (taskId, PR) dedup unchanged (W1-T195). */
function matchesOptionalDimension(wanted: string | undefined, candidate: string | undefined): boolean {
  return wanted === undefined || candidate === undefined || wanted === candidate;
}

function titleCarriesSameSummary(e: EscalationDedupKey, title: string | undefined, body: string): boolean {
  const raw = unboundedEscalationTitle(e);
  if (title === raw) return true;
  const fields = machineFields(body) ?? body;
  return title === escalationIssueTitle(e) && fields.split("\n").find(line => line.startsWith("**Full summary (JSON):** ")) === fullEscalationSummaryLine(e);
}

/** Read pre-offset bodies with the original headings. */
function issueDetails(body: string): string | undefined {
  const sections = readEscalationIssueSections(body);
  if (sections) return sections.detail;
  const marker = `\n\n${DETAILS_SECTION}`;
  const detailsAt = body.indexOf(marker, body.indexOf(`\n\n${RECOMMENDATION_SECTION}`));
  const footerAt = body.lastIndexOf(`\n\n${ISSUE_FOOTER}`);
  return detailsAt !== -1 && footerAt > detailsAt ? body.slice(detailsAt + marker.length, footerAt) : undefined;
}

/** The producer's summary and Details carry its PR. Choice links can refer to other PRs. */
function candidatePrText(title: string | undefined, detail: string, header: string): string | undefined {
  const line = header.split("\n").find(row => row.startsWith("**Full summary (JSON):** "));
  if (line) {
    let summary: unknown;
    try {
      summary = JSON.parse(line.slice("**Full summary (JSON):** ".length));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      summary = undefined;
    }
    const taskId = TASK_LINE_RE.exec(header)?.[1];
    const issueClass = CLASS_LINE_RE.exec(header)?.[1];
    if (typeof summary === "string" && taskId && issueClass) {
      const key = { summary, taskId, class: issueClass as EscalationClass };
      if (title !== unboundedEscalationTitle(key) && title === escalationIssueTitle(key)
          && line === fullEscalationSummaryLine(key)) return `${summary}\n${detail}`;
    }
  }
  // A clipped numeric token is not an identity when its full producer metadata is unavailable.
  if (/(?:\/pull\/|\bPR\s*#?\s*)\d+…$/i.test(title ?? "")) return undefined;
  return `${title ?? ""}\n${detail}`;
}

function candidatePrRef(title: string | undefined, body: string): string | undefined {
  const fields = machineFields(body);
  const detail = fields === undefined ? body : issueDetails(body) ?? body;
  const text = candidatePrText(title, detail, fields ?? body.split("\n\n", 1)[0]!);
  return text === undefined ? undefined : extractPrRef(text) ?? extractPrRef(body);
}

/** The reconciler requires a full link. Fields-first issues keep their original body/title scan. */
export function escalationIssuePrReferent({ title, body }: Pick<OpenIssue, "title" | "body">): number | undefined {
  const normalized = normalizeCandidateBody(body ?? "");
  const fields = machineFields(normalized);
  if (fields === undefined) return prReferentFromIssueText(body) ?? prReferentFromIssueText(title);
  const detail = issueDetails(normalized) ?? normalized;
  return prReferentFromIssueText(detail) ?? prReferentFromIssueText(candidatePrText(title, "", fields));
}

function matchesHeadDimension(e: EscalationDedupKey, candidate: string | undefined, title: string | undefined, body: string): boolean {
  if (e.headDedup === "independent") return titleCarriesSameSummary(e, title, body);
  return matchesOptionalDimension(e.headSha, candidate);
}

/** The SUBSET of an {@link Escalation} that {@link findDuplicateEscalation} reads (W1-T2799), so a
 *  caller merely ASKING "is there already an open issue about this?" need not fabricate options it is
 *  not filing. Its value is that the compiler now proves the fix rung's pre-strike probe and the
 *  escalation it predicts are keyed IDENTICALLY. `summary`/`detail` are here because the PR reference
 *  the key is built on is scraped from their text, never carried as a field. */
export interface EscalationDedupKey {
  class: EscalationClass;
  taskId: string;
  summary: string;
  detail: string;
  headSha?: string;
  headDedup?: EscalationHeadDedup;
  cause?: EscalationCause;
  /** W1-T3579 — see {@link Escalation.contractRevision}'s own doc. */
  contractRevision?: string;
}

/** The conflict context recorded by the escalation producer and read by both repair gates. */
export const CONFLICT_EVIDENCE_MISSING_REASON_CODE = "conflict-evidence-missing";
export const CONFLICT_NOT_ADMITTED_REASON_CODE = "conflict-not-admitted";
export const RAISED_BY_LINE_RE = /^\*\*Raised-by:\*\*\s*(\S+)\s*$/m;
export const BASE_SHA_LINE_RE = /^\*\*Base:\*\*\s*(\S+)\s*$/m;

/** W1-T5908 — an open conflict escalation's cause when THIS round shows it cleared (evidence now
 *  captured, or the base moved); `undefined` when it still holds or was never recorded. */
export function clearedConflictEscalationCause(
  body: string | undefined,
  current: { conflictEvidenceCaptured: boolean; baseSha?: string },
): string | undefined {
  const raisedBy = RAISED_BY_LINE_RE.exec(body ?? "")?.[1];
  if (raisedBy === CONFLICT_EVIDENCE_MISSING_REASON_CODE && current.conflictEvidenceCaptured) {
    return `raised by ${raisedBy} — the conflicting-file evidence is now captured and the PR dispositions conflicted`;
  }
  const raisedBase = BASE_SHA_LINE_RE.exec(body ?? "")?.[1];
  if (raisedBase !== undefined && current.baseSha !== undefined && raisedBase !== current.baseSha) {
    return `raised against base ${raisedBase} — the base has moved to ${current.baseSha}`;
  }
  return undefined;
}

/** The false-block question both the sweep and the fix rung would re-ask. */
export function fixEscalationDedupKey(
  taskId: string, prUrl: string, headSha: string, conflicted: boolean, ciFailing: boolean,
  contractRevision?: string,
): EscalationDedupKey {
  return { class: "BLOCKED", taskId, summary: `review false-block — ${prUrl}`, detail: "",
    headSha, cause: escalationCause(conflicted, ciFailing), contractRevision };
}

/** A duplicate may refuse a repair only when it positively names this head. A changed recorded
 * contract, cleared conflict, or unspent operator answer releases the same question in both lanes.
 * W1-T12544: a conflict round (`conflictRound`) is held only by an issue whose cause is the conflict. */
export function openEscalationStandDownReason(
  headSha: string,
  candidate: OpenIssue | undefined,
  currentContractRevision?: string,
  current?: { conflictEvidenceCaptured: boolean; baseSha?: string; conflictRound?: true },
  redCheckNames?: readonly string[],
  pendingAnswer?: { spent?: true },
): { reason: string } | undefined {
  if (pendingAnswer && !pendingAnswer.spent) return undefined;
  if (!candidate) return undefined; // nothing open on this key — the ordinary path
  // The sweep writes the question immediately after its clarification context paragraph.
  const question = /(?:^|\n)The CLARIFICATION-QUESTION rung [^\n]*\n\n([^\n]*)/.exec(candidate.body ?? "")?.[1];
  if (question?.startsWith("PR stage stalled:")) return undefined;
  const summary = /(?:^|\n)The CLARIFICATION-QUESTION rung [^\n]* to BLOCKED-AMBIGUOUS: ([^\n]*)/.exec(candidate.body ?? "")?.[1];
  const metadataChecks = /^metadata-only required checks (.+?) need title\/body repair:/.exec(summary ?? "")?.[1].split(", ");
  if (metadataChecks && redCheckNames?.some(name => !metadataChecks.includes(name))) return undefined;
  const candidateHead = escalationHeadSha(candidate.body);
  // STRICTER THAN THE MATCHER (both arms): a candidate naming NO head, or naming a DIFFERENT one,
  // never refuses a worker. The first arm is the legacy-issue case, the second is a genuinely new
  // push whose issue has not been filed yet — in both, the failure direction of guessing wrong is
  // "stop fixing things", so both fail open.
  if (candidateHead === undefined || candidateHead !== headSha) return undefined;
  if (current?.conflictRound && escalationIssueCause(candidate.body) !== "conflict") return undefined;
  const candidateRevision = escalationContractRevision(candidate.body);
  // W1-T3579: a genuine disagreement between the RECORDED and CURRENT contract revision means the
  // question this issue asked has since changed underneath it — re-admit rather than stand down.
  // Either side missing (a legacy issue, or a caller with no live task to hash) says nothing, so
  // the original head-only stand-down applies unchanged — fail toward standing down, never toward
  // mass-retrying, on anything short of a positively OBSERVED contract change.
  if (candidateRevision !== undefined && currentContractRevision !== undefined && candidateRevision !== currentContractRevision) {
    return undefined;
  }
  if (current && clearedConflictEscalationCause(candidate.body, current) !== undefined) return undefined;
  return {
    reason:
      `a needs-human escalation for this exact (task, PR, head ${headSha}, cause) is ALREADY OPEN and ` +
      `awaiting a human (${candidate.url}) — a strike here would re-ask a question already in front of ` +
      `someone and append to that same issue; standing down until it is closed, the head moves, or the ` +
      `task contract changes, or an operator answers`,
  };
}

/** W1-T974: normalize bare CR/U+2028/U+2029 to spaces ONLY on candidate-body readback.
 * TRAP: JS multiline regexes treat them as line starts, allowing log-tail text to forge Head/Cause.
 * Preserve `\n` so honest metadata still parses (criterion 2); never normalize renderIssueBody,
 * whose new issue detail must remain byte-identical (criterion 3; summarizeCiFailure, run-task.ts). */
function normalizeCandidateBody(body: string): string {
  return body.replaceAll("\r\n", "\n").replace(/\r|\u2028|\u2029/g, " ");
}

/** Scan an already-fetched OPEN-issue list for a duplicate of `e` — the pure matching predicate
 *  {@link findDuplicateEscalation} and {@link lookupDuplicateEscalation} both apply to whatever
 *  `listOpen` returned, so a change to the matching rule can never drift between the two callers. */
export function matchDuplicateEscalation(e: EscalationDedupKey, open: OpenIssue[]): OpenIssue | undefined {
  const prRef = extractPrRef(`${e.summary}\n${e.detail}`);
  return open.find((issue) => {
    const body = normalizeCandidateBody(issue.body ?? "");
    const fields = machineFields(body) ?? body;
    if (TASK_LINE_RE.exec(fields)?.[1] !== e.taskId) return false;
    const candidateCause = CAUSE_LINE_RE.exec(fields)?.[1];
    if (prRef) {
      // W1-T195: taskId + PR must match; head/cause veto only when both values exist and disagree.
      if (candidatePrRef(issue.title, body) !== prRef) return false;
      const candidateHead = HEAD_SHA_LINE_RE.exec(fields)?.[1];
      if (matchesHeadDimension(e, candidateHead, issue.title, body) === false) return false;
      if (!matchesOptionalDimension(e.cause, candidateCause)) return false;
      // W1-T3579: contract disagreements permit a new issue; missing revisions preserve legacy dedup.
      // Keep the named predicate: absence and disagreement must not collapse into `!chain?.`.
      const candidateContract = CONTRACT_REVISION_LINE_RE.exec(fields)?.[1];
      if (!matchesOptionalDimension(e.contractRevision, candidateContract)) return false;
      return true;
    }
    // W1-T345: without a PR, match taskId/class and permissive cause. With no causes, the rendered
    // title distinguishes producers while deduping a producer's repeated firing.
    if (CLASS_LINE_RE.exec(fields)?.[1] !== e.class) return false;
    if (e.cause !== undefined || candidateCause !== undefined) {
      return matchesOptionalDimension(e.cause, candidateCause);
    }
    return titleCarriesSameSummary(e, issue.title, body);
  });
}

/** Pre-strike duplicate probe: absent, failed or unmatched reads return `undefined` (W1-T2912).
 *  INVARIANT: unreadability must never manufacture a fix stand-down. Issue creation instead uses
 *  {@link lookupDuplicateEscalation}, which distinguishes unreadability from no match. */
export function findDuplicateEscalation(e: EscalationDedupKey, deps: Pick<EscalateDeps, "issues">): OpenIssue | undefined {
  return findDuplicateEscalations(e, deps)[0];
}

/** All matching probe candidates: a released question must not mask an independent open hold. */
export function findDuplicateEscalations(e: EscalationDedupKey, deps: Pick<EscalateDeps, "issues">): OpenIssue[] {
  if (!deps.issues.listOpen) return [];
  let open: OpenIssue[];
  try {
    open = deps.issues.listOpen(NEEDS_HUMAN_LABEL);
  } catch {
    return []; // best-effort dedup: a failed read must never block the PROBE itself
  }
  return open.filter(issue => matchDuplicateEscalation(e, [issue]) !== undefined);
}

/** W1-T2912: unreadable is distinct from no match. Otherwise a REST-read outage with working
 *  issue creation floods one duplicate per tick. Refuse creation and retry the durable ask later. */
export type DedupLookup =
  // W1-T4659: "none" carries the OPEN list already read, so a new-issue caller can rescan it.
  | { kind: "none"; open: OpenIssue[] }
  | { kind: "found"; issue: OpenIssue }
  | { kind: "unreadable"; error: unknown };

/** Creation-only twin of findDuplicateEscalation: same predicate, but throwing reads are unreadable.
 *  The pre-strike probe keeps its fail-open predicate. */
function* lookupDuplicateEscalation(e: EscalationDedupKey, deps: Pick<EscalateDeps<AsyncIssueGateway>, "issues">): Steps<DedupLookup> {
  if (!deps.issues.listOpen) return { kind: "none", open: [] };
  let open: OpenIssue[];
  try {
    open = yield* step(() => deps.issues.listOpen!(NEEDS_HUMAN_LABEL));
  } catch (error) {
    return { kind: "unreadable", error };
  }
  const match = matchDuplicateEscalation(e, open);
  return match ? { kind: "found", issue: match } : { kind: "none", open };
}

/** W1-T2912: ledger `escalation.dedup_unreadable`, refuse creation, return `""` (no issue URL).
 *  The ledger row is the durable failure record. */
function recordUnreadableDedup(e: Escalation, error: unknown, deps: Pick<EscalateDeps, "ledgerPath" | "runId">): string {
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: e.taskId,
    step: "escalation.dedup_unreadable",
    class: e.class,
    error: String((error as Error)?.message ?? error),
  });
  return "";
}

/** Append the dedup comment and the `escalation.deduped` ledger line for an already-found duplicate —
 *  extracted so {@link escalateWithJudge} shares it exactly, never a second `listOpen` read.
 *  W1-T13218: with a gateway that can list and edit comments, the observation is ROLLING — the first
 *  match of a UTC day posts one comment, and every later match that day edits it in place. */
function* recordDuplicateEscalation(e: Escalation, dup: OpenIssue, deps: EscalateDeps<AsyncIssueGateway>): Steps<string> {
  const prRef = extractPrRef(`${e.summary}\n${e.detail}`);
  const observedHead = e.headDedup === "independent" && e.headSha ? `, observed head ${e.headSha}` : "";
  const observedKey = prRef
    ? `task ${e.taskId}, PR #${prRef}${observedHead}`
    : `task ${e.taskId}, class ${e.class}${e.cause ? `, cause ${e.cause}` : ""}`;
  const heading =
    `Another escalation observed the same condition (${observedKey}) while this issue ` +
    `was already open — appending rather than opening a sibling (W1-T104/W1-T345).`;
  const issues = deps.issues;
  let observation: RollingObservationOutcome = "appended";
  if (issues.listCommentsSince && issues.editComment) {
    observation = yield* writeRollingObservation(e, dup, heading, deps);
  } else {
    yield* step(() => issues.comment?.(dup.url, `${heading}\n\n${renderIssueBody(e)}`));
  }
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: e.taskId,
    step: "escalation.deduped",
    class: e.class,
    issue_url: dup.url,
    observation_comment: observation,
  });
  return dup.url;
}

/** W1-T13218 — how a dedup match reached the issue: `appended` (a gateway without comment edits),
 *  `posted` (the day's first observation), `edited` (today's comment updated in place), or
 *  `posted-after-read-failed` / `posted-after-edit-failed` (the fallback, named so it is countable). */
type RollingObservationOutcome = "appended" | "posted" | "edited" | "posted-after-read-failed" | "posted-after-edit-failed";

/** W1-T13218 — the hidden marker line of a rolling observation comment: task id, count, first time. */
export const ROLLING_OBSERVATION_RE = /<!-- rmd-observation:(\S+) count=(\d+) first=(\S+) -->/;

/** The hidden line that keys a rolling observation comment to its task, count and first time. */
function rollingObservationMarker(taskId: string, count: number, firstIso: string): string {
  return `<!-- rmd-observation:${taskId} count=${count} first=${firstIso} -->`;
}

function rollingObservationBody(e: Escalation, heading: string, count: number, firstIso: string, newestIso: string): string {
  return (
    `${heading}\n\n` +
    `Observed ${count} time(s) on ${newestIso.slice(0, 10)} (UTC): first ${firstIso}, newest ${newestIso}. ` +
    `Later observations today edit this comment (W1-T13218).\n\n` +
    `${renderIssueBody(e)}\n\n${rollingObservationMarker(e.taskId, count, firstIso)}`
  );
}

/** Today's newest rolling observation comment for `taskId`, created at or after `dayStartIso`. */
export function findRollingObservation(
  comments: readonly IssueComment[],
  taskId: string,
  dayStartIso: string,
): { id: number; count: number; firstIso: string } | undefined {
  const dayStart = Date.parse(dayStartIso);
  let best: { id: number; count: number; firstIso: string; at: number } | undefined;
  for (const c of comments) {
    const m = ROLLING_OBSERVATION_RE.exec(c.body);
    if (!m || m[1] !== taskId) continue;
    const at = Date.parse(c.createdAt);
    if (!Number.isFinite(at) || at < dayStart || !Number.isFinite(c.id)) continue;
    if (!best || at > best.at) best = { id: c.id, count: Number(m[2]), firstIso: m[3]!, at };
  }
  return best && { id: best.id, count: best.count, firstIso: best.firstIso };
}

/** INVARIANT dedup-never-blocks-the-probe: a failed read or edit falls back to posting a new comment,
 *  the path that ran before W1-T13218, and never throws into the probe. */
function* writeRollingObservation(e: Escalation, dup: OpenIssue, heading: string, deps: EscalateDeps<AsyncIssueGateway>): Steps<RollingObservationOutcome> {
  const issues = deps.issues;
  const nowIso = (deps.clock ?? systemClock).iso();
  const dayStartIso = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
  let prior: ReturnType<typeof findRollingObservation>;
  let fallback: RollingObservationOutcome = "posted";
  try {
    const comments = yield* step(() => issues.listCommentsSince!(dup.url, dayStartIso));
    prior = findRollingObservation(comments, e.taskId, dayStartIso);
  } catch {
    // deliberate: an unreadable comment list must never block the probe; the observation is posted
    // as a new comment instead, and the ledger row names the fallback as posted-after-read-failed.
    fallback = "posted-after-read-failed";
  }
  if (prior) {
    const body = rollingObservationBody(e, heading, prior.count + 1, prior.firstIso, nowIso);
    try {
      yield* step(() => issues.editComment!(prior!.id, body));
      return "edited";
    } catch {
      // deliberate: a failed edit falls back to posting a new comment, so the observation is never
      // lost; the ledger row names the fallback as posted-after-edit-failed.
      fallback = "posted-after-edit-failed";
    }
  }
  yield* step(() => issues.comment?.(dup.url, rollingObservationBody(e, heading, 1, nowIso, nowIso)));
  return fallback;
}

/** The issue number out of a `gh issue create` URL — falls back to the raw url on an unrecognized
 *  shape, for the "superseded by #<n>" citation below. */
function issueRefFromUrl(url: string): string {
  const n = /\/(\d+)\s*$/.exec(url)?.[1];
  return n ? `#${n}` : url;
}

/** W1-T4659 (#7561/W1-T3721): only a newly opened issue with headSha retires older-head issues.
 *  Reuse the fetched OPEN list; require the same task/PR and an explicit, disagreeing Head line.
 *  Never retire on a dedup hit, missing Head or another task/PR (design iii).
 *  CANNOT-OBSERVE MEANS WAIT (W1-T130): failed closes stay open and ledger failure, never throw. */
function* closeSupersededEscalations(e: Escalation, prRef: string, open: OpenIssue[], newIssueUrl: string, deps: EscalateDeps<AsyncIssueGateway>): Steps<void> {
  if (!e.headSha) return;
  const newIssueRef = issueRefFromUrl(newIssueUrl);
  for (const issue of open) {
    const body = normalizeCandidateBody(issue.body ?? "");
    const fields = machineFields(body) ?? body;
    if (TASK_LINE_RE.exec(fields)?.[1] !== e.taskId) continue;
    if (candidatePrRef(issue.title, body) !== prRef) continue;
    const candidateHead = HEAD_SHA_LINE_RE.exec(fields)?.[1];
    if (!candidateHead || candidateHead === e.headSha) continue;
    const comment =
      `Superseded by ${newIssueRef} (head \`${e.headSha}\`) — a newer push moved this task/PR forward, so ` +
      `this issue's head (\`${candidateHead}\`) is stale. Closing automatically (W1-T4659); the new issue ` +
      `carries the live question.`;
    let delivered = false;
    let failure: string | undefined;
    if (!deps.issues.closeWithComment) {
      failure = "issue gateway cannot close issues";
    } else {
      try {
        yield* step(() => deps.issues.closeWithComment!(issue.url, comment));
        delivered = true;
      } catch (err) {
        // CANNOT-OBSERVE MEANS WAIT: never rethrown — the ledger row below carries this as `failure`.
        failure = String((err as Error)?.message ?? err);
      }
    }
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: e.taskId,
      step: "escalation.superseded",
      superseded_issue_url: issue.url,
      superseded_head: candidateHead,
      new_issue_url: newIssueUrl,
      new_head: e.headSha,
      delivered,
      ...(failure ? { failure } : {}),
    });
  }
}

/** Shared issue creation for escalate/escalateWithJudge (W1-T349); opts.queueLabel selects queue.
 * INVARIANT: NEVER degrade the queue label: sweep.ts's RETIRABLE_ESCALATION_LABELS cannot see
 * unlabelled issues. Class/ask labels may degrade; an unavailable queue label must fail create
 * visibly and retriably. Why: docs/forensics/escalate.md. */
function* createEscalationIssue(
  e: Escalation,
  deps: EscalateDeps<AsyncIssueGateway>,
  opts: {
    queueLabel: string;
    step: string;
    firstComment?: string;
    extra?: Record<string, unknown>;
    messageCheck?: OperatorMessageCheckResult;
  },
): Steps<string> {
  const title = escalationIssueTitle(e);
  yield* step(() => deps.issues.ensureLabel?.(opts.queueLabel));
  const wanted = [CLASS_LABEL[e.class], ASK_TYPE_LABEL[classifyAsk(e)]];
  const labels: string[] = [opts.queueLabel];
  const degradedLabels: string[] = [];
  for (const label of wanted) {
    if (!deps.issues.ensureLabel || (yield* step(() => deps.issues.ensureLabel!(label)))) {
      labels.push(label);
    } else {
      degradedLabels.push(label);
    }
  }
  const notices: string[] = [];
  if (degradedLabels.length > 0) {
    notices.push(
      `_Degraded: label(s) ${degradedLabels.join(", ")} could not be provisioned on this repo — ` +
      `this issue was opened without them so the escalation itself is never lost (W1-T99)._`,
    );
  }
  // W1-T2498: a non-conforming operator message is ANNOTATED, never dropped or held — the footer is
  // purely additive, so detail, summary and recommendation render exactly as the caller wrote them.
  const messageFooter = opts.messageCheck ? operatorMessageFooter(opts.messageCheck) : undefined;
  if (messageFooter) notices.push(messageFooter);
  const body = renderIssueBody(e, notices);
  const url = yield* step(() => deps.issues.create(title, body, labels));
  const firstComment = opts.firstComment;
  if (firstComment) {
    // W1-T349 design clause (ii): a demoted item's judge reason rides as the FIRST comment —
    // posted immediately after create(), before anything else can land on the issue.
    yield* step(() => deps.issues.comment?.(url, firstComment));
  }
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: e.taskId,
    ...(degradedLabels.length > 0 ? { degraded_labels: degradedLabels } : {}),
    ...(opts.messageCheck
      ? {
          operator_message_ok: opts.messageCheck.ok,
          ...(opts.messageCheck.ok ? {} : { operator_message_missing: opts.messageCheck.missing }),
        }
      : {}),
    step: opts.step,
    class: e.class,
    issue_url: url,
    labels,
    ...opts.extra,
  });
  return url;
}

/** Shared refuse-or-normalize step for {@link escalate}/{@link escalateWithJudge} (W1-T1103, design
 *  iii): both cross it BEFORE the dedup search, so no caller can observe a partially-opened escalation
 *  whose Task field is a known-broken sentinel. Returns `e` unchanged when its taskId resolves, else a
 *  COPY carrying the `PR-<n>` referent, so search, judge prompt and rendered body see the same value. */
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

/** W1-T2494: append every call (including duplicates) to the derived taskId/class/cause/PR thread
 * (inbox-thread.ts), reusing dedup's PR referent. BEST-EFFORT: no threadStorePath is a no-op;
 * failed writes never block escalation delivery. */
function recordThreadMessage(e: Escalation, deps: Pick<EscalateDeps, "threadStorePath">): void {
  if (!deps.threadStorePath) return;
  try {
    appendThreadMessage(
      { taskId: e.taskId, class: e.class, cause: e.cause, prRef: extractPrRef(`${e.summary}\n${e.detail}`) },
      "escalation",
      `${e.summary}\n\n${e.detail}`,
      { threadStorePath: deps.threadStorePath },
    );
  } catch {
    // best-effort — see doc above; a thread-store failure must never block the escalation itself.
  }
}

/** Open and ledger an actionable issue; zero options are refused (§4).
 *  DEDUP LIVES HERE, IN THE TRANSPORT (W1-T104): PR-keyed or referent-less (W1-T345), as above.
 *  Search OPEN issues only: human-resolved issues must not silence recurrence. Duplicates append
 *  observer context. Missing listOpen permits creation; throwing listOpen refuses it (W1-T2912).
 *  Why: docs/forensics/escalate.md. */
export function escalate(e: Escalation, deps: EscalateDeps): string {
  return driveSynchronousEscalation(() => runStepsSync(escalateSteps(e, deps)));
}

const asyncIssueTwins = new WeakMap<IssueGateway, AsyncIssueGateway>();

function driveSynchronousEscalation<T>(drive: () => T): T {
  // Latched producers and SRE feedback can consume an incident after this call. Preserve
  // synchronous delivery for default and custom routes until their durable async handoff.
  return withSynchronousGhDelivery(drive);
}

/** W1-T5283 — {@link escalate} with every gateway call awaited, for the main-health rung on the
 *  daemon loop. The SAME steps under the async driver, so it opens, dedupes, supersedes and ledgers
 *  exactly what the sync form does. */
export function escalateAsync(e: Escalation, deps: EscalateDeps<AsyncIssueGateway>): Promise<string> {
  return runStepsAsync(escalateSteps(e, deps, true));
}

/** An unreadable precision ledger propagates to the funnel's deliver fallback. */
function ledgerClassTier(e: Escalation, ledgerPath: string): TriageEvidence["classTier"] {
  if (e.class === "MANUAL" || e.class === "HARD_STOP") return undefined;
  // A torn row that NAMES the step could have been the evidence that stops a digest, so it refuses;
  // an unattributable torn line elsewhere in the corpus is a healthy ledger's normal residue.
  let damaged = false;
  const lines = readLedgerUnionRecordsSync(dirname(ledgerPath), {
    step: "panel.escalation_marked_handled", refuseIncomplete: true,
    onTorn: (raw) => { if (raw.includes("panel.escalation_marked_handled")) damaged = true; },
  });
  if (!lines.ok || damaged) throw new Error("escalation precision history is unreadable");
  return escalationClassSignal(lines.rows, e.class).tier;
}

/** The escalation as the later re-judge reads it back from the `issue_opened` row. An escalation whose
 *  fields cannot be serialised is still raised: it simply carries no subject, so it is never re-judged. */
function serialisableSubject(e: Escalation): { triage_subject?: Escalation } {
  try {
    return { triage_subject: JSON.parse(JSON.stringify(e)) as Escalation };
  } catch {
    // deliberate: an unserialisable escalation is raised without a subject (see above); nothing is lost but the re-judge.
    return {};
  }
}

/** Where a triaged escalation is routed when the triage ACTS (see {@link triageRoute}). */
interface TriageRoute {
  queueLabel: string;
  step: string;
  firstComment?: string;
  extra?: Record<string, unknown>;
  pending?: { action: TriageAction; effect: string; cfg: EscalateTriageSettings };
}

/** W1-T8868: every new issue crosses triageEscalation once and ledgers escalation.triaged.
 * Only act mode changes routing; shadow delivers unchanged. Auto-resolve keeps a fleet-notice
 * issue OPEN with effect/undo in its first comment. Missing/throwing executor or spent pass cap
 * falls back to needs-human. */
function* triageRoute(
  e: Escalation,
  deps: EscalateDeps<AsyncIssueGateway>,
  allowAsyncJudge = false,
): Steps<TriageRoute> {
  let cfg: EscalateTriageSettings | undefined;
  let mode: EscalationTriageMode = "shadow";
  let outcome: TriageOutcome;
  try {
    cfg = { ...productionTriage?.(deps), ...deps.triage };
    mode = cfg?.mode === "act" ? "act" : "shadow";
    // W1-T13324: a tier the evidence supplies is used as it is; only its absence costs the ledger read.
    const supplied = cfg?.evidence?.(e);
    const evidence: TriageEvidence = supplied && "classTier" in supplied ? supplied
      : { classTier: ledgerClassTier(e, deps.ledgerPath), ...supplied };
    outcome = triageEscalation(e, evidence);
    if (allowAsyncJudge && cfg?.judge && outcome.kind === "deliver" && outcome.decidedBy === "default") {
      const verdict = yield* step(() => judgeEscalation(e, { judge: cfg!.judge! }));
      appendLedger(deps.ledgerPath, {
        run_id: deps.runId, task_id: e.taskId, step: ESCALATION_JUDGED_STEP,
        class: e.class, judge_decision: verdict.decision, judge_reason: verdict.reason,
        ...escalationJudgeReceiptFields(verdict),
      });
      outcome = triageEscalation(e, evidence, verdict);
    }
  } catch (err) {
    outcome = { kind: "deliver", decidedBy: "default", reason: `triage evidence unreadable (${String(err)})` };
  }
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: e.taskId,
    step: ESCALATION_TRIAGED_STEP,
    class: e.class,
    triage_mode: mode,
    triage_outcome: outcome.kind,
    ...(outcome.kind === "auto_resolve" ? { triage_action: outcome.action } : {}),
    triage_decided_by: outcome.decidedBy,
    triage_reason: outcome.reason,
  });
  if (mode !== "act") return { queueLabel: NEEDS_HUMAN_LABEL, step: "escalation.issue_opened" };
  if (outcome.kind === "deliver") return { queueLabel: NEEDS_HUMAN_LABEL, step: "escalation.issue_opened" };
  if (outcome.kind === "digest") {
    return {
      queueLabel: FLEET_NOTICE_LABEL,
      step: "escalation.demoted",
      firstComment: outcome.reason,
      extra: { judge_reason: outcome.reason },
    };
  }
  const action = outcome.action;
  const execute = cfg?.execute?.[action];
  const deliverBecause = (why: string): TriageRoute => {
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: e.taskId,
      step: "escalation.auto_resolve_declined",
      class: e.class,
      triage_action: action,
      reason: why,
    });
    return { queueLabel: NEEDS_HUMAN_LABEL, step: "escalation.issue_opened" };
  };
  if (!execute) return deliverBecause(`no executor wired for ${action}`);
  if (cfg?.asyncExecutors && !allowAsyncJudge) return deliverBecause("action awaits the async sweep driver");
  if (cfg?.pass === undefined || !takeAutoResolve(cfg.pass)) return deliverBecause("auto-resolve cap for this pass is unavailable or spent");
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId, task_id: e.taskId, step: "escalation.auto_resolve_attempted",
    class: e.class, triage_action: action, head_sha: e.headSha, contract_revision: e.contractRevision,
  });
  let effect: string;
  try {
    effect = yield* step(() => execute(e));
    if (typeof effect !== "string" || !effect.trim()) throw new Error("executor supplied no effect receipt");
  } catch (err) {
    return deliverBecause(`${action} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    queueLabel: FLEET_NOTICE_LABEL,
    step: "escalation.auto_resolve_started",
    firstComment:
      `Auto-resolved by \`${action}\` (${outcome.reason}). ${effect}\n\n` +
      "This issue stays open until the action's effect is observed; reopen it to undo.",
    extra: { triage_action: action },
    pending: { action, effect, cfg },
  };
}

function* escalateSteps(e: Escalation, deps: EscalateDeps<AsyncIssueGateway>, allowAsyncJudge = false): Steps<string> {
  if (allowAsyncJudge) {
    const asyncIssues = asyncIssueTwins.get(deps.issues as IssueGateway);
    if (asyncIssues) deps = { ...deps, issues: asyncIssues };
  }
  if (e.options.length === 0) {
    throw new Error(`escalation for ${e.taskId} has no options — every escalation needs an actionable choice`);
  }
  validateEscalationOptionKinds(e);
  const resolved = withExplicitConsequence(refuseUnlessResolvable(e));
  recordThreadMessage(resolved, deps);
  const dedup = yield* lookupDuplicateEscalation(resolved, deps);
  if (dedup.kind === "found") return yield* recordDuplicateEscalation(resolved, dedup.issue, deps);
  if (dedup.kind === "unreadable") return recordUnreadableDedup(resolved, dedup.error, deps);
  const messageCheck = checkOperatorMessageSafe(resolved);
  const route = yield* triageRoute(resolved, deps, allowAsyncJudge);
  const url = yield* createEscalationIssue(resolved, deps, {
    queueLabel: route?.queueLabel ?? NEEDS_HUMAN_LABEL,
    step: route?.step ?? "escalation.issue_opened",
    ...(route?.firstComment ? { firstComment: route.firstComment } : {}),
    extra: { ...route.extra, ...serialisableSubject(resolved) },
    messageCheck,
  });
  // W1-T4659: a new issue for a NEW head retires whichever older-head issue(s) it just superseded.
  const prRef = extractPrRef(`${resolved.summary}\n${resolved.detail}`);
  if (prRef) yield* closeSupersededEscalations(resolved, prRef, dedup.open, url, deps);
  if (route.pending?.cfg.observe && deps.issues.closeWithComment) {
    try {
      const pending = route.pending;
      const observed = yield* step(() => pending.cfg.observe!(resolved, pending.action, pending.effect));
      if (observed) {
        yield* step(() => deps.issues.closeWithComment!(url, `Action effect observed: ${observed}. Reopen this issue to undo.`));
        appendLedger(deps.ledgerPath, {
          run_id: deps.runId, task_id: resolved.taskId, step: "escalation.auto_resolved",
          issue_url: url, triage_action: pending.action, evidence: observed,
        });
      }
    } catch (err) {
      appendLedger(deps.ledgerPath, {
        run_id: deps.runId, task_id: resolved.taskId, step: "escalation.auto_resolve_observation_failed",
        issue_url: url, reason: String(err),
      });
    }
  }
  return url;
}

/** Async triage with an explicit residual judge; shadow still delivers every outcome.
 * ORDER MATTERS: lookupDuplicateEscalation runs first; duplicates/unreadable reads never reach
 * the judge (W1-T2912). Demote opens fleet-notice with judge reason first; other outcomes,
 * exemptions and failures open needs-human. W1-T5765: await every gateway call; sync is accepted. */
export async function escalateWithJudge(
  e: Escalation,
  deps: EscalateDeps<AsyncIssueGateway> & EscalationJudgeDeps,
): Promise<string> {
  return runStepsAsync(escalateSteps(e, {
    ...deps, triage: { ...deps.triage, judge: deps.judge },
  }, true));
}

/** NON-THROWING escalation for supervised loops: URL on delivery, `null` otherwise.
 *  Failures (including zero options) ledger `escalation.failed`. TRAP: uncaught gh failures can
 *  crash-loop the daemon on the same task. Normalize unreadable-dedup `""` to `null` too
 *  (W1-T2912), so `!== null` delivery callers cannot report phantom success. */
// Why: the 2026-07-21 daemon boot loop this wrapper ended (W1-T197's sibling) — docs/forensics/escalate.md.
export function tryEscalate(e: Escalation, deps: EscalateDeps): string | null {
  return driveSynchronousEscalation(() => runStepsSync(tryEscalateSteps(e, deps)));
}

/** W1-T5283 — {@link tryEscalate} over {@link escalateAsync}: never rejects, and ledgers the same
 *  `escalation.failed` row for a failure. */
export function tryEscalateAsync(e: Escalation, deps: EscalateDeps<AsyncIssueGateway>): Promise<string | null> {
  return runStepsAsync(tryEscalateSteps(e, deps, true));
}

function* tryEscalateSteps(e: Escalation, deps: EscalateDeps<AsyncIssueGateway>, allowAsyncJudge = false): Steps<string | null> {
  try {
    return (yield* escalateSteps(e, deps, allowAsyncJudge)) || null;
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
export interface EscalateWithSummaryDeps extends EscalateDeps<AsyncIssueGateway>, SummarizeDeps {}

/** W1-T348: await-capable producers inherit summarizeEscalation + escalateAsync here.
 * TRAP: synchronous dispatch-loop breaker callbacks (run-task.ts) cannot await; they retain
 * escalate without a summary, the documented fail-open default. */
export async function escalateWithSummary(e: Escalation, deps: EscalateWithSummaryDeps): Promise<string> {
  const decisionSummary = await summarizeEscalation(e, deps);
  return escalateAsync({ ...e, decisionSummary }, deps);
}

/** Reuse the birth funnel for an existing issue, without creating or deduplicating another one. */
export async function triageExistingEscalation(
  e: Escalation, url: string, deps: EscalateDeps<AsyncIssueGateway>,
  relabel: (url: string, label: string) => void | Promise<void>,
): Promise<void> {
  const route = await runStepsAsync(triageRoute(e, deps, true));
  if (route.queueLabel === NEEDS_HUMAN_LABEL) throw new Error("auto-resolve declined; retain needs-human");
  await relabel(url, route.queueLabel);
  if (route.firstComment) await deps.issues.comment?.(url, route.firstComment);
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId, task_id: e.taskId, step: route.step, issue_url: url, ...route.extra,
  });
  const pending = route.pending;
  if (pending === undefined || pending.cfg.observe === undefined || !deps.issues.closeWithComment) return;
  const observed = await pending.cfg.observe(e, pending.action, pending.effect);
  if (!observed) return;
  await deps.issues.closeWithComment(url, `Action effect observed: ${observed}. Reopen to undo.`);
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId, task_id: e.taskId, step: "escalation.auto_resolved", issue_url: url,
    triage_action: pending.action, evidence: observed,
  });
}

/** Real owner/repo-scoped gh issue gateway: outside sandbox for Seatbelt TLS (§4A), within
 * bypass/deny-hook floor, scoped PAT only. ensureLabel uses `gh label create … --force`:
 * existing labels succeed, hard failures return false. opts.exec injects raw gh (like status.ts's
 * ghGateway) for failure and URL tests. */
export function ghIssueGateway(
  owner: string,
  repo: string,
  opts: { exec?: (args: string[]) => string } = {},
): IssueGateway {
  const run =
    opts.exec ??
    ((args: string[]) => ghExec(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const gateway = issueGatewaySteps(`${owner}/${repo}`, run, runStepsSync) as IssueGateway;
  if (opts.exec === undefined) asyncIssueTwins.set(gateway, ghIssueGatewayAsync(owner, repo));
  return gateway;
}

/** W1-T5283 — {@link ghIssueGateway} for the main-health rung on the daemon loop: the same argv and
 *  failure classification, each `gh` child awaited on {@link ghTextAsync}. */
export function ghIssueGatewayAsync(
  owner: string,
  repo: string,
  opts: { exec?: (args: string[]) => Promise<string> } = {},
): AsyncIssueGateway {
  return issueGatewaySteps(`${owner}/${repo}`, opts.exec ?? ((args: string[]) => ghTextAsync(args)), runStepsAsync);
}

const OPEN_ISSUES_BY_LABEL_QUERY =
  "query($owner:String!,$name:String!,$label:String!,$cursor:String){repository(owner:$owner,name:$name){" +
  "issues(labels:[$label],states:OPEN,first:100,after:$cursor){nodes{number url title body}pageInfo{hasNextPage endCursor}}}}";

const CREATE_ISSUE_MUTATION =
  "mutation($repositoryId:ID!,$title:String!,$body:String!,$labelIds:[ID!]){" +
  "createIssue(input:{repositoryId:$repositoryId,title:$title,body:$body,labelIds:$labelIds}){issue{url}}}";

/** W1-T13690: an issue gateway that reads and opens issues through `gh api graphql` only, so it spends
 *  none of the core budget. The quota notice uses it for a core exhaustion. `listOpen` returns the shape
 *  {@link parseLabelledIssuesRest} returns; `create` reads the repository id and every label id in one
 *  query, then calls the createIssue mutation. There is no `ensureLabel`: a label with no id fails the create. */
export function ghIssueGatewayGraphql(
  owner: string,
  repo: string,
  opts: { exec?: (args: string[]) => Promise<string> } = {},
): AsyncIssueGateway {
  const repoArg = `${owner}/${repo}`;
  const run = opts.exec ?? ((args: string[]) => ghTextAsync(args));
  const graphql = async (query: string, vars: Record<string, string>): Promise<Record<string, unknown>> => {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(vars)) args.push("-f", `${key}=${value}`);
    const answer = JSON.parse(await run(args)) as { data?: Record<string, unknown> | null; errors?: unknown };
    if (answer.errors !== undefined || !answer.data) {
      throw new Error(`GraphQL answer for ${repoArg} carried no data: ${JSON.stringify(answer.errors ?? null)}`);
    }
    return answer.data;
  };
  return {
    async listOpen(label) {
      const issues: LabelledIssue[] = [];
      let cursor: string | undefined;
      do {
        const data = await graphql(OPEN_ISSUES_BY_LABEL_QUERY, { owner, name: repo, label, ...(cursor === undefined ? {} : { cursor }) });
        const page = (data.repository as { issues?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } } | null)?.issues;
        if (!page || !Array.isArray(page.nodes)) throw new Error(`GraphQL issue list for ${repoArg} carried no nodes`);
        for (const node of page.nodes as Array<{ number: number; url: string; title?: string; body?: string }>) {
          issues.push({ number: node.number, url: node.url, state: "open", title: node.title, body: node.body });
        }
        const next = page.pageInfo?.endCursor;
        if (page.pageInfo?.hasNextPage === true && typeof next !== "string") throw new Error(`GraphQL issue list for ${repoArg} has a next page and no cursor`);
        cursor = page.pageInfo?.hasNextPage === true ? next as string : undefined;
      } while (cursor !== undefined);
      return issues;
    },
    async create(title, body, labels) {
      assertLiveWriteAllowed("gh-issue-create", `filing an issue on ${repoArg}`);
      const decl = labels.map((_, i) => `,$l${i}:String!`).join("");
      const fields = labels.map((_, i) => `l${i}:label(name:$l${i}){id}`).join(" ");
      const ids = await graphql(`query($owner:String!,$name:String!${decl}){repository(owner:$owner,name:$name){id ${fields}}}`,
        { owner, name: repo, ...Object.fromEntries(labels.map((label, i) => [`l${i}`, label])) });
      const repository = ids.repository as Record<string, unknown> | null;
      if (typeof repository?.id !== "string") throw new Error(`GraphQL read of ${repoArg} carried no repository id`);
      const labelIds = labels.map((label, i) => {
        const id = (repository[`l${i}`] as { id?: unknown } | null | undefined)?.id;
        if (typeof id !== "string") throw new Error(`label ${label} has no id on ${repoArg}`);
        return id;
      });
      const args = ["api", "graphql", "-f", `query=${CREATE_ISSUE_MUTATION}`, "-f", `repositoryId=${repository.id}`,
        "-f", `title=${title}`, "-f", `body=${body}`];
      for (const id of labelIds) args.push("-f", `labelIds[]=${id}`);
      const answer = JSON.parse(await run(args)) as { data?: { createIssue?: { issue?: { url?: unknown } } } | null; errors?: unknown };
      const url = answer.data?.createIssue?.issue?.url;
      if (answer.errors !== undefined || typeof url !== "string") {
        throw new Error(`GraphQL createIssue on ${repoArg} returned no issue: ${JSON.stringify(answer.errors ?? null)}`);
      }
      return url;
    },
  };
}

function issueGatewaySteps(
  repoArg: string,
  run: (args: string[]) => string | Promise<string>,
  drive: (steps: Steps<unknown>) => unknown,
): AsyncIssueGateway {
  const gh = (args: string[]) => step(() => run(args));
  return {
    ensureLabel: (label) =>
      drive(
        (function* () {
          try {
            yield* gh(["label", "create", label, "--repo", repoArg, "--color", "ededed", "--force"]);
            return true;
          } catch {
            return false;
          }
        })(),
      ),
    create: (title, body, labels) =>
      drive(
        (function* () {
          assertLiveWriteAllowed("gh-issue-create", `filing an issue on ${repoArg}`);
          const args = ["issue", "create", "--repo", repoArg, "--title", title, "--body", body];
          for (const label of labels) args.push("--label", label);
          return (yield* gh(args)).trim();
        })(),
      ),
    // OPEN issues only, with body (carries `**Task:** <id>`). Read over REST's `/issues`, NOT
    // `gh issue list --label`: that routes label filtering through GitHub's GraphQL `search()`
    // connection, throttled account-wide here; `ghJson(` cannot parse this bare `--paginate` shape. THROWS
    // on a `gh` failure — the caller degrades to no action this cycle, never "zero open".
    listOpen: (label) =>
      drive(
        (function* () {
          return parseLabelledIssuesRest(yield* gh(labelledIssuesRestArgs(repoArg, label, "open")));
        })(),
      ),
    closeWithComment: (url, comment, reason) =>
      drive(
        (function* () {
          // W1-T13221: "not planned" marks a superseded duplicate; absent, gh closes as completed.
          const why = reason ? ["--reason", reason] : [];
          try {
            yield* gh(["issue", "close", url, "--repo", repoArg, "--comment", comment, ...why]);
            return "commented";
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const cap1 = "Commenting is disabled on issues with more than 2500 comments";
            const cap2 = "Commenting is disabled on issues with more than 2500 comments.";
            if (msg.includes(cap1) || msg.includes(cap2)) {
              // GitHub rejects closing with a citation comment when the cap is reached; close without a comment
              yield* gh(["issue", "close", url, "--repo", repoArg, ...why]);
              return "comment_cap";
            }
            throw err;
          }
        })(),
      ),
    comment: (url, body) =>
      drive(
        (function* () {
          yield* gh(["issue", "comment", url, "--repo", repoArg, "--body", body]);
        })(),
      ),
    editBody: (url, body) =>
      drive(
        (function* () {
          yield* gh(["issue", "edit", url, "--repo", repoArg, "--body", body]);
        })(),
      ),
    listCommentsSince: (url, sinceIso) =>
      drive(
        (function* () {
          const n = /\/issues\/(\d+)\s*$/.exec(url)?.[1];
          if (!n) throw new Error(`listCommentsSince: no issue number in ${url}`);
          const path = `repos/${repoArg}/issues/${n}/comments?since=${encodeURIComponent(sinceIso)}&per_page=100`;
          return parseIssueCommentRows(yield* gh(["api", path, "--paginate"]));
        })(),
      ),
    editComment: (commentId, body) =>
      drive(
        (function* () {
          yield* gh(["api", "-X", "PATCH", `repos/${repoArg}/issues/comments/${commentId}`, "-f", `body=${body}`]);
        })(),
      ),
  } as AsyncIssueGateway;
}

// ── W1-T2696: signed, single-use answer links ────────────────────────────────
//
// Signed option links let a notification execute a console choice (W1-T2273) without a new bot
// identity. W1-T2211 boundary: the daemon mints the secret under the worker-inaccessible state root.
//
// INVARIANT: a link authorises exactly one option on exactly one escalation, once, before its
// expiry. Signature, expiry and single-use are checked independently, and a refusal names which.
// FALSIFIER: test/escalation-answer-links.test.ts.

/** `<root>/state/escalation-link-secret` — the same state-root boundary
 *  `serviceTokensPath` sits behind, which settings/worker.json already denies a worker. */
export function escalationLinkSecretPath(root: string): string {
  return join(root, "state", "escalation-link-secret");
}

/** Where a consumed link's marker lands. Named by the signature, so the marker never
 *  reveals which option it answered to anyone listing the directory. */
export function escalationLinkUsedPath(root: string, signature: string): string {
  return join(root, "state", "escalation-links", `${signature}.used`);
}

/** Create-once, published whole, mode 600; a file that is not a 64-hex secret throws (an empty
 *  key forges every link). A rotation is: stop the daemon, delete the file, start it again. */
export function loadEscalationLinkSecret(
  root: string,
  io: { claim: typeof createOrReadPublished; mkdir: typeof mkdirSync } = {
    claim: createOrReadPublished,
    mkdir: mkdirSync,
  },
): string {
  const path = escalationLinkSecretPath(root);
  io.mkdir(dirname(path), { recursive: true });
  const result = io.claim(path, 0o600);
  if (result.created) {
    try {
      const secret = randomBytes(32).toString("hex");
      result.publish(`${secret}\n`);
      return secret;
    } finally {
      result.release();
    }
  }
  const secret = result.raw.trim();
  if (!HEX_SECRET_RE.test(secret)) {
    throw new InvalidSecretFileError(path, `holds ${secret.length} characters after trim, not a 64-hex secret`);
  }
  return secret;
}

/** No secret under this state root: no answer link was ever minted here, so none can verify. */
export class EscalationLinkSecretMissingError extends RmdError {
  readonly reason = "escalation-link-secret-missing";
  constructor(readonly path: string) {
    super("registry", GENERIC_EXIT_CODE, `escalation-link-secret-missing: ${path} does not exist, so no answer link was minted under this root`, { path });
    this.name = "EscalationLinkSecretMissingError";
  }
}

/** {@link loadEscalationLinkSecret} without the create (W1-T5057): what GET /v1/escalation/confirm
 *  verifies with, so a read never writes. The ping that mints a link creates the secret first. */
export function readEscalationLinkSecret(root: string): string {
  const path = escalationLinkSecretPath(root);
  if (!existsSync(path)) throw new EscalationLinkSecretMissingError(path);
  const secret = readFileSync(path, "utf8").trim();
  if (!HEX_SECRET_RE.test(secret)) throw new InvalidSecretFileError(path, `holds ${secret.length} characters after trim, not a 64-hex secret`);
  return secret;
}

/** The fields a link signs over. Order is fixed: a signature is over this exact string. */
export interface OptionLinkClaims {
  readonly escalationId: string;
  /** The escalation's class. Carried and SIGNED because the answer must derive the same
   *  {@link ThreadIdentity} the escalation was raised under, and a class taken from an
   *  unsigned query could redirect an answer onto a different thread. */
  readonly cls: string;
  readonly route: EscalationOptionRoute;
  readonly expiresAtMs: number;
}

/** The signed payload, canonical and delimiter-separated. A field may not contain the
 *  delimiter, which `mintOptionLink` enforces rather than assuming. */
function optionLinkPayload(c: OptionLinkClaims): string {
  for (const [name, value] of [["escalation id", c.escalationId], ["class", c.cls]] as const) {
    if (value.includes("|")) {
      throw new Error(`${name} ${JSON.stringify(value)} contains the signing delimiter "|"`);
    }
  }
  return `${c.escalationId}|${c.cls}|${c.route}|${c.expiresAtMs}`;
}

export function signOptionLink(claims: OptionLinkClaims, secret: string): string {
  return createHmac("sha256", secret).update(optionLinkPayload(claims), "utf8").digest("hex");
}

/** How long a minted link stays answerable. Picked, not measured — an escalation the operator
 *  has not answered in a day wants a fresh look at the issue, not a stale one-tap. */
export const OPTION_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** Executable options get one answer URL. Operator-only acts return undefined, preserving
 * prose rather than rendering a link the console cannot execute. */
export function mintOptionLink(
  escalationId: string,
  cls: string,
  kind: EscalationOptionKind,
  secret: string,
  nowMs: number,
  baseUrl: string,
): string | undefined {
  if (kind.type !== "executable") return undefined;
  const claims: OptionLinkClaims = { escalationId, cls, route: kind.route, expiresAtMs: nowMs + OPTION_LINK_TTL_MS };
  const sig = signOptionLink(claims, secret);
  const q = new URLSearchParams({
    e: claims.escalationId,
    c: claims.cls,
    r: claims.route,
    x: String(claims.expiresAtMs),
    s: sig,
  });
  return `${baseUrl.replace(/\/$/, "")}/v1/escalation/confirm?${q.toString()}`;
}

export type OptionLinkRefusal = "bad-request" | "forged" | "expired" | "already-used";
export type OptionLinkCheck =
  | { readonly ok: true; readonly claims: OptionLinkClaims; readonly signature: string }
  | { readonly ok: false; readonly reason: OptionLinkRefusal; readonly detail: string };

/** Verify before acting; keep independent refusals actionable: forged = attack/corruption,
 * expired = stale ping to re-raise, already-used = benign double-tap. Collapsing them hides
 * attacks among second taps in the ledger. */
export function verifyOptionLink(
  query: URLSearchParams,
  secret: string,
  nowMs: number,
  isUsed: (signature: string) => boolean,
): OptionLinkCheck {
  const e = query.get("e");
  const c = query.get("c");
  const r = query.get("r");
  const x = query.get("x");
  const s = query.get("s");
  if (!e || !c || !r || !x || !s || !/^[0-9a-f]{64}$/.test(s) || !/^\d+$/.test(x)) {
    return { ok: false, reason: "bad-request", detail: "a link must carry e, c, r, x and a 64-hex s" };
  }
  if (!(r in ESCALATION_OPTION_ROUTES)) {
    return { ok: false, reason: "bad-request", detail: `route ${JSON.stringify(r)} is outside the closed set` };
  }
  const claims: OptionLinkClaims = { escalationId: e, cls: c, route: r as EscalationOptionRoute, expiresAtMs: Number(x) };
  // Signature FIRST: an expired or used link whose signature does not verify is forged, and
  // reporting it as merely expired would hide that.
  const expected = Buffer.from(signOptionLink(claims, secret), "utf8");
  const given = Buffer.from(s, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "forged", detail: "signature does not verify" };
  }
  if (claims.expiresAtMs <= nowMs) {
    return { ok: false, reason: "expired", detail: `expired at ${new Date(claims.expiresAtMs).toISOString()}` };
  }
  if (isUsed(s)) {
    return { ok: false, reason: "already-used", detail: "this link has already answered its escalation" };
  }
  return { ok: true, claims, signature: s };
}

/** Mark a verified link consumed. Exclusive-create, so two taps racing cannot both win: the
 *  loser sees the marker already there and is refused `already-used` on its own check. */
export function consumeOptionLink(
  root: string,
  signature: string,
  io: { create: typeof createOrReadExclusive; close: typeof closeSync; mkdir: typeof mkdirSync } = {
    create: createOrReadExclusive,
    close: closeSync,
    mkdir: mkdirSync,
  },
): boolean {
  const path = escalationLinkUsedPath(root, signature);
  io.mkdir(dirname(path), { recursive: true });
  const result = io.create(path, 0o600);
  if (result.created) {
    io.close(result.fd);
    return true;
  }
  return false;
}
