import { execFileSync } from "node:child_process";
import { ghExec } from "./github-transport.js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { createOrReadExclusive } from "./fs-race-safe.js";
import { appendLedger } from "./ledger.js";
import { appendThreadMessage } from "./inbox-thread.js";
import {
  checkOperatorMessage,
  operatorMessageFooter,
  type OperatorMessage,
  type OperatorMessageCheckResult,
} from "./operator-message.js";
import { assertLiveWriteAllowed } from "./live-write-guard.js";
import { validateDecisionSummary, type DecisionSummary, type SummarizeDeps } from "./feedback.js";
import type { Mount, Mounts } from "./mounts.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";
import { resolveRiskJudgeMount } from "./risk-judge.js";
import type { WriteTier } from "./service.js";

/**
 * Escalations as GitHub issues (W1-T8, MASTER-PLAN §4 "Escalation taxonomy").
 *
 * The loop never waits on a human except for four classes: BLOCKED, a post-diagnose PR whose two
 * strikes are spent; MANUAL, an act only a hand can do — secrets, repo creation, deploys, eyeball
 * gates; HARD_STOP, the deterministic hard-stop list; and GRILL, an ambiguous feedback item intake
 * triage cannot decide alone (§7B, W1-T42), reusing this machinery rather than a second copy.
 *
 * INVARIANT: each opens a `needs-human` issue carrying the OPTIONS and the machine's RECOMMENDATION,
 * so the issue is actionable rather than a bare alert. TRAP: DECISION and DIRECTION are absorbed
 * elsewhere and ASYNC-QUESTION never escalates, so a fifth class here would widen what stops the
 * loop. Why: docs/forensics/escalate.md.
 */
export type EscalationClass = "BLOCKED" | "MANUAL" | "HARD_STOP" | "GRILL";

/**
 * The closed set of routes an EXECUTABLE option may name, each at the same {@link WriteTier}
 * serve.ts's route table already declares for it. INVARIANT: the map is CLOSED, so "no merge route,
 * no PR-close route, no reject route" holds by construction — {@link validateEscalationOptionKind}
 * refuses a path outside it. TRAP: re-deriving a tier here instead of copying serve.ts's is the
 * two-enumerator defect that lets this vocabulary drift. FALSIFIER:
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

/** An option's machine-readable KIND (W1-T2273) — closed, like {@link EscalationClass}. An option
 *  either CAN be executed by the console, naming its route, payload and already-gated tier, or it
 *  CANNOT, because the act is the operator's alone, and says so as `operator-only`. */
export type EscalationOptionKind =
  | {
      readonly type: "executable";
      /** One of {@link ESCALATION_OPTION_ROUTES}'s own keys — never a route this task invents. */
      readonly route: EscalationOptionRoute;
      /** MUST equal `ESCALATION_OPTION_ROUTES[route]`, carried explicitly rather than looked up at
       *  render time, so {@link validateEscalationOptionKind} catches a caller whose claimed tier
       *  disagrees with the route's real one. Typed {@link WriteTier}: a fourth tier is not
       *  expressible. */
      readonly tier: WriteTier;
      /** The JSON body the console would POST to `route`. Omitted when the route needs none. */
      readonly payload?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "operator-only" };

/** One choice a human can make to resolve the escalation. `kind` is OPTIONAL (W1-T2273) so every
 *  existing producer renders byte-identical; an option with no `kind` renders exactly like
 *  `operator-only` — prose, no button. The kind is a machine-readable SIBLING of `label`/`detail`,
 *  never a replacement for the sentence. Why: docs/forensics/escalate.md. */
export interface EscalationOption {
  label: string;
  detail: string;
  /** The option's machine-readable kind — see {@link EscalationOptionKind}. */
  kind?: EscalationOptionKind;
}

/** Refuse an option whose `kind` is unrecognised, whose `route` is outside {@link
 *  ESCALATION_OPTION_ROUTES}, or whose `tier` disagrees with that route's real tier (W1-T2273).
 *  `undefined` and `operator-only` pass untouched. Called from {@link escalate}/{@link
 *  escalateWithJudge}, so no caller reaches {@link createEscalationIssue} with an option the
 *  console has no honest way to render. */
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
  /** The PR's head commit sha, OPTIONAL (W1-T195) — the dedup key's 2nd dimension. An omitting
   *  caller keeps today's (taskId, PR) behaviour, because {@link escalate}'s dup search requires
   *  equality here only when BOTH sides carry a value. Why: docs/forensics/escalate.md. */
  headSha?: string;
  /** The blocked PR's underlying cause, OPTIONAL (W1-T195) — the key's 3rd dimension. A failing
   *  review, red checks and a conflict are different operator asks on the same head sha, so those
   *  must still open separately. See {@link escalationCause}; permissive when absent, like
   *  {@link Escalation.headSha}. */
  cause?: EscalationCause;
  /** A plain-language decision card, generated ONCE at creation time by {@link summarizeEscalation};
   *  {@link renderIssueBody} renders it above the raw `detail`. Named `decisionSummary` because
   *  {@link Escalation.summary} is the issue title. Absent degrades to the raw-only body (W1-T313). */
  decisionSummary?: DecisionSummary | null;
  /** OPTIONAL (W1-T2498) — what follows from doing nothing: the fourth part of {@link
   *  checkOperatorMessage}'s presence check. Unset reads as an omitted part, which is reported
   *  non-conforming, annotated and delivered anyway. `null` is an EXPLICIT "nothing follows from
   *  inaction" (docs/operator-message-standard.md) and counts as present. */
  consequence?: string | null;
}

/** Project an {@link Escalation} onto the four presence slots {@link checkOperatorMessage} reads
 *  (W1-T2498). Every field is read from something the escalation ALREADY carries, so no producer
 *  changes. `consequenceOfInaction` is the part most producers omit, and making that gap visible is
 *  the point. Why: docs/forensics/escalate.md. */
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

/** The three-way cause split {@link Escalation.cause} keys on (W1-T195's design). */
export type EscalationCause = "review" | "ci" | "conflict";

/** Classify a blocked PR's cause from the SAME two booleans each rung already computes for dispatch
 *  (W1-T195) — never a second classification, never string-parsing a free-text reason. INVARIANT:
 *  `conflicted` wins over `ciFailing`, because a dirty merge state means GitHub never ran checks at
 *  all, so checks read "none"/stale rather than genuinely failing (see {@link isBlockedCi} in
 *  sweep.ts). Why: docs/forensics/escalate.md. */
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
   *  escalation-lifecycle reconciler parses to derive the referenced task's state. */
  body?: string;
}

/**
 * The `gh api repos/<slug>/issues?labels=…` argv every labelled-issue read here uses.
 *
 * INVARIANT: REST, never `gh issue list --label`. `gh` routes `--label` through GitHub's GraphQL
 * `search()` connection, throttled account-wide here, so that form failed every time while the
 * reconciler read an empty list. TRAP: `--slurp` needs `gh` 2.51 and this fleet's operator host runs
 * 2.45.0, so bare `--paginate` is the ceiling — and it concatenates one array per page with no
 * separator, which {@link parseLabelledIssuesRest} reassembles. FALSIFIER:
 * test/escalation-issue-list-rest.test.ts. Why: docs/forensics/escalate.md (W1-T1208).
 */
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
  closeWithComment?(url: string, comment: string): void;
  /** Post `body` as a plain comment on an OPEN issue without closing it (W1-T104) — the SECOND
   *  OBSERVER of an already-open escalation appends here rather than opening a sibling. A gateway
   *  omitting it still dedupes, but silently drops the second observation. */
  comment?(url: string, body: string): void;
  /** Ensure ONE label exists on the repo (create-if-missing, tolerate-already-exists). Returns false
   *  when provisioning failed. Optional: a gateway omitting it is treated as "every label already
   *  exists". TRAP: an unprovisioned label used to fail the WHOLE create, losing the rendered
   *  question and killing the reconciler for every other open PR — provisioning is the transport's
   *  job, never the operator's memory. Why: the 2026-07-17 incident, docs/forensics/escalate.md. */
  ensureLabel?(label: string): boolean;
}

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

/** Beside the per-class label, alongside `needs-human` — the ask-type queue split. */
const ASK_TYPE_LABEL: Record<AskType, string> = {
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

/**
 * Classify ONE escalation as an ACTION the operator must perform or a QUESTION they must answer
 * (W1-T346; MASTER-PLAN §4) — derived from fields the escalation already carries, never a
 * producer-side field and never an LLM call. Pure, deterministic and total.
 *
 * MANUAL is ACTION by definition, GRILL is QUESTION by definition. BLOCKED and HARD_STOP fall to the
 * options-shape test: any option naming an operator-only act ({@link namesOperatorOnlyAct}) makes it
 * an ACTION; options the machine carries out make it a QUESTION. INVARIANT: it defaults ACTION when
 * that test cannot decide — a question shown as an action costs one wasted read, an action shown as
 * a question hides real work. Why: docs/forensics/escalate.md.
 */
export function classifyAsk(e: Escalation): AskType {
  if (e.class === "MANUAL") return "action";
  if (e.class === "GRILL") return "question";
  if (e.options.length > 0 && e.options.every((o) => !namesOperatorOnlyAct(o))) return "question";
  return "action";
}

/** The label every escalation issue carries — the queue the control panel reads (§4). */
export const NEEDS_HUMAN_LABEL = "needs-human";

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

export type PresenceMode = "attended" | "away";

/** `<root>/state/AWAY` — the same existence-gated flag idiom as fleet-control.ts's
 *  STOP/PAUSE: a corrupt/unreadable state dir still fails to the SAFE default
 *  (`"attended"`, i.e. deliver exactly as today), never silently goes quiet. */
export function awayFilePath(root: string): string {
  return join(root, "state", "AWAY");
}

/** The operator's CURRENT presence mode. Default (no flag file, or a fresh root) is
 *  `"attended"` — away-mode routing is opt-in, never assumed. */
export function presenceMode(root: string): PresenceMode {
  return existsSync(awayFilePath(root)) ? "away" : "attended";
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
  return e.class === "MANUAL" || e.class === "GRILL";
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

/** Parse the judge's `ESCALATION_JUDGE_DECISION`/`ESCALATION_JUDGE_REASON` lines. A missing or
 *  unrecognised decision fails OPEN ({@link FAIL_OPEN_JUDGE_VERDICT} — `deliver`, never `demote`). */
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

/** Decide demote|deliver for ONE escalation. EXEMPT classes are delivered WITHOUT ever calling
 *  `deps.judge`, so a judge stub that would demote a MANUAL item cannot influence the outcome. A
 *  judge-unavailable error is caught HERE and fails OPEN to `deliver` — the cannot-observe →
 *  DELIVER polarity, mirroring risk-judge.ts's cannot-observe → ESCALATE. */
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

/** The judge's SDK tool allowlist — EMPTY by construction, like risk-judge.ts's: everything it needs
 *  is baked into the prompt, so it has no ability to explore the worktree or take any action. */
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

/** Spawn the real judge and parse its verdict. Untested by unit (it shells out via the SDK); {@link
 *  buildEscalationJudgeSpawnArgs} and {@link parseEscalationJudgeVerdict} carry the contract. */
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

/** Build a `judge` wired to a real spawn on the CHEAPEST configured mount — one cheap-mount call per
 *  delivered escalation. Reuses {@link resolveRiskJudgeMount} rather than re-deriving the same
 *  routing-table walk: that resolver is generic, never risk-specific, despite its name. */
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

/** The PULL-REQUEST NUMBER an escalation issue names in its own text, or `undefined` (impl-DY).
 *  {@link renderIssueBody} writes the PR as a full URL, so the referent can be read back off an issue
 *  whose `**Task:** <id>` the reconciler cannot resolve. INVARIANT: it matches a FULL `/pull/<n>` URL
 *  only, never a bare `#707` — on GitHub that is ambiguous between an issue and a PR, and an
 *  escalation body routinely cites sibling issue numbers, so resolving one as a PR would retire a
 *  live escalation against an unrelated referent. PURE: it says what the issue is ABOUT, never
 *  whether that thing is finished. Why: docs/forensics/escalate.md. */
export function prReferentFromIssueText(text: string | undefined): number | undefined {
  const m = /\/pull\/(\d+)/.exec(text ?? "");
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Render the issue body: context, the options, and the recommendation called out.
 *
 * A validating `e.decisionSummary` renders a "## Decision Summary" block ABOVE the raw `detail`, so
 * the summary rides the same GitHub-mobile channel the operator sees first (W1-T313). It is purely
 * additive — `e.detail` is byte-identical either way — and is re-validated here, so a malformed
 * attach degrades to the raw-only body. `**Host:**` names the machine whose process rendered THIS
 * body, unconditionally (W1-T972). TRAP: nothing on the issue used to say which machine it described,
 * so correct crash-loop escalations were followed to a healthy unit. Why: docs/forensics/escalate.md.
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

export interface EscalateDeps {
  issues: IssueGateway;
  ledgerPath: string;
  runId: string;
  /** OPTIONAL (W1-T2494) — path to the JSONL thread store {@link appendThreadMessage} writes to.
   *  Every caller predating this task omits it: {@link recordThreadMessage} no-ops when unset. */
  threadStorePath?: string;
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

/** Does `e.taskId`, AS WRITTEN, name a referent some lookup can retire (W1-T1103, design iii)? `""` is
 *  excluded because {@link renderIssueBody}'s `**Task:**` line needs one non-whitespace character for
 *  the reconciler's own `\S+` read to match. `"undefined"` and `"null"` are the textbook symptom of a
 *  caller stringifying a missing value into something that satisfies `string` at compile time and
 *  carries no referent at runtime — and neither is a shape a real task id or GRILL's
 *  `TRIAGE-<feedbackId>` ever takes. Why: docs/forensics/escalate.md. */
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

/** The `**Head:** <sha>` sha an already-open issue's body carries, or `undefined` (W1-T2799). Reads
 *  through the SAME {@link HEAD_SHA_LINE_RE} {@link findDuplicateEscalation} matches on — ONE parser,
 *  so a caller asking "is this issue about the head I am about to strike against?" can never disagree
 *  with `escalate()`'s dedup. Exported because the fix rung's pre-strike gate must be STRICTER:
 *  {@link matchesOptionalDimension} is permissive on an absent dimension, the wrong polarity there. */
export function escalationHeadSha(body: string | undefined): string | undefined {
  return HEAD_SHA_LINE_RE.exec(body ?? "")?.[1];
}

/** Does an OPTIONAL composite-key dimension veto a dedup match? Only when BOTH sides carry a value
 *  and they DISAGREE — either side missing says nothing, which keeps every un-migrated caller's
 *  (taskId, PR) dedup unchanged (W1-T195). */
function matchesOptionalDimension(wanted: string | undefined, candidate: string | undefined): boolean {
  return wanted === undefined || candidate === undefined || wanted === candidate;
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
  cause?: EscalationCause;
}

/** Search OPEN `needs-human` issues for a duplicate of `e` — extracted from {@link escalate} so
 *  {@link escalateWithJudge} runs the IDENTICAL search once, up front, and never judges a duplicate.
 *  Returns `undefined` for no `listOpen`, a failed read, or no match. */
export function findDuplicateEscalation(e: EscalationDedupKey, deps: Pick<EscalateDeps, "issues">): OpenIssue | undefined {
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
      // W1-T195: the composite key. taskId + PR are REQUIRED matches. headSha/cause veto only when
      // both sides carry a value and disagree, so a caller setting neither keeps today's dedup while
      // the two rungs that set both get their own issue on a new push or a different cause.
      if (extractPrRef(`${issue.title ?? ""}\n${body}`) !== prRef) return false;
      if (!matchesOptionalDimension(e.headSha, HEAD_SHA_LINE_RE.exec(body)?.[1])) return false;
      if (!matchesOptionalDimension(e.cause, CAUSE_LINE_RE.exec(body)?.[1])) return false;
      return true;
    }
    // W1-T345: no PR resolves — dedup on (taskId, class, cause) instead of skipping the search.
    // class is REQUIRED equal; cause is permissive, so distinct causes still open separately. With
    // no cause on either side, compare the rendered title: its summary segment is a fixed,
    // per-producer phrase, so two producers sharing one (taskId, class) never collide, while the
    // same producer's repeated firing does dedup.
    if (CLASS_LINE_RE.exec(body)?.[1] !== e.class) return false;
    const candidateCause = CAUSE_LINE_RE.exec(body)?.[1];
    if (e.cause !== undefined || candidateCause !== undefined) {
      return matchesOptionalDimension(e.cause, candidateCause);
    }
    return (issue.title ?? "") === title;
  });
}

/** Append the dedup comment and the `escalation.deduped` ledger line for an already-found duplicate —
 *  extracted so {@link escalateWithJudge} shares it exactly, never a second `listOpen` read. */
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

/** Ensure labels, render the body, create the issue and ledger it — extracted from {@link escalate} so
 *  {@link escalateWithJudge} can open a FLEET-NOTICE-labelled issue (W1-T349) through the same label
 *  machinery instead of a drifting copy. `opts.queueLabel` is the only thing that varies. INVARIANT:
 *  `opts.queueLabel` IS NEVER DEGRADED, unlike the class and ask-type labels — `RETIRABLE_ESCALATION_LABELS`
 *  (sweep.ts) is the only thing the reconciler filters open issues on, so a queue-label-less issue is
 *  invisible to it forever. A repo where the label genuinely cannot be attached fails `create()`: a
 *  visible, retriable failure, never a permanently un-retirable issue. Why: docs/forensics/escalate.md. */
function createEscalationIssue(
  e: Escalation,
  deps: EscalateDeps,
  opts: {
    queueLabel: string;
    step: string;
    firstComment?: string;
    extra?: Record<string, unknown>;
    messageCheck?: OperatorMessageCheckResult;
  },
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
  // W1-T2498: a non-conforming operator message is ANNOTATED, never dropped or held — the footer is
  // purely additive, so detail, summary and recommendation render exactly as the caller wrote them.
  const messageFooter = opts.messageCheck ? operatorMessageFooter(opts.messageCheck) : undefined;
  if (messageFooter) body += `\n\n${messageFooter}`;
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

/** Append THIS escalation's prose onto the thread its derived identity belongs to — taskId, class,
 *  cause and the SAME PR referent dedup already scrapes (W1-T2494; inbox-thread.ts says why the id is
 *  DERIVED, never minted). Fires on EVERY call, dup or not: the dup path re-raises the identical
 *  concern, which is the "appends rather than starting a new thread" case. BEST-EFFORT, like the dedup
 *  read: an unset `threadStorePath` is a silent no-op and a throwing write is swallowed, so "an
 *  escalation that never reaches the console behaves exactly as it does today" stays literal. */
function recordThreadMessage(e: Escalation, deps: EscalateDeps): void {
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

/**
 * Open a labeled GitHub issue for one escalation and ledger it; returns the issue URL. Zero options
 * is refused — a bare alert with no actionable choice is what §4 exists to avoid.
 *
 * DEDUP LIVES HERE, IN THE TRANSPORT (W1-T104), so every caller inherits it instead of deduping only
 * against its own prior actions. Two modes, chosen by whether a PR reference resolves out of this
 * escalation's own text: PR-KEYED (taskId, PR, plus headSha/cause when set, matched permissively) and
 * REFERENT-LESS (taskId, class, cause, with the rendered title as fallback discriminator — W1-T345).
 * Both search OPEN issues only, because a closed one recorded a human's resolution and must not
 * silence a recurrence; a duplicate takes the second observer's context as a comment, and an absent or
 * failed `listOpen` falls through to create. Why: docs/forensics/escalate.md.
 */
export function escalate(e: Escalation, deps: EscalateDeps): string {
  if (e.options.length === 0) {
    throw new Error(`escalation for ${e.taskId} has no options — every escalation needs an actionable choice`);
  }
  validateEscalationOptionKinds(e);
  const resolved = refuseUnlessResolvable(e);
  recordThreadMessage(resolved, deps);
  const dup = findDuplicateEscalation(resolved, deps);
  if (dup) return recordDuplicateEscalation(resolved, dup, deps);
  const messageCheck = checkOperatorMessageSafe(resolved);
  return createEscalationIssue(resolved, deps, {
    queueLabel: NEEDS_HUMAN_LABEL,
    step: "escalation.issue_opened",
    messageCheck,
  });
}

/** THE JUDGED CHOKE POINT (W1-T349) — {@link escalate} plus the residual escalation judge. Producers
 *  opt in; anyone still calling {@link escalate}/{@link tryEscalate} gets today's unjudged
 *  needs-human behaviour. ORDER MATTERS: dedup runs FIRST, through the exact same {@link
 *  findDuplicateEscalation} search, so the judge never sees a duplicate. A `demote` opens the issue
 *  fleet-notice-labelled with the judge's reason as the first comment; anything else — deliver, an
 *  exempt class, or a judge failure — opens it needs-human-labelled. */
export async function escalateWithJudge(
  e: Escalation,
  deps: EscalateDeps & EscalationJudgeDeps,
): Promise<string> {
  if (e.options.length === 0) {
    throw new Error(`escalation for ${e.taskId} has no options — every escalation needs an actionable choice`);
  }
  validateEscalationOptionKinds(e);
  const resolved = refuseUnlessResolvable(e);
  recordThreadMessage(resolved, deps);
  const dup = findDuplicateEscalation(resolved, deps);
  if (dup) return recordDuplicateEscalation(resolved, dup, deps);

  const verdict = await judgeEscalation(resolved, deps);
  const messageCheck = checkOperatorMessageSafe(resolved);
  if (verdict.decision === "demote") {
    return createEscalationIssue(resolved, deps, {
      queueLabel: FLEET_NOTICE_LABEL,
      step: "escalation.demoted",
      firstComment: verdict.reason,
      extra: { judge_reason: verdict.reason },
      messageCheck,
    });
  }
  return createEscalationIssue(resolved, deps, {
    queueLabel: NEEDS_HUMAN_LABEL,
    step: "escalation.issue_opened",
    messageCheck,
  });
}

/** NON-THROWING escalation, for callers inside a SUPERVISED LOOP. Returns the issue URL, or `null`
 *  when it could not be delivered; a failure is recorded on its own `escalation.failed` ledger step,
 *  so an undelivered escalation is degraded and legible rather than silent. TRAP: `escalate()` throws
 *  on any nonzero `gh` exit, right for a one-shot command and wrong inside `rmd daemon`'s `for(;;)` —
 *  an uncaught escalation ends the PROCESS, launchd reads the exit as a crash, and the fresh process
 *  re-selects the same circuit-broken task and throws again. This also catches the zero-options
 *  programming error deliberately. */
// Why: the 2026-07-21 daemon boot loop this wrapper ended (W1-T197's sibling) — docs/forensics/escalate.md.
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

/** THE CHOKE POINT (W1-T348) — compose {@link summarizeEscalation} and {@link escalate} into the ONE
 *  call an await-capable producer makes, for the same reason dedup lives inside `escalate()`: a
 *  caller inherits summary generation by construction instead of hand-composing two calls. NOT every
 *  producer switches — the synchronous dispatch-loop breaker callbacks (run-task.ts) cannot await
 *  without making their callback interface async, so they keep calling {@link escalate} and never
 *  attach a summary, the documented fail-open default. */
export async function escalateWithSummary(e: Escalation, deps: EscalateWithSummaryDeps): Promise<string> {
  const decisionSummary = await summarizeEscalation(e, deps);
  return escalate({ ...e, decisionSummary }, deps);
}

/** Real gateway: `gh issue create`, scoped to `owner/repo`. Runs outside the sandbox (gh is
 *  documented to fail TLS verification under Seatbelt, §4A) but still inside bypass plus the
 *  deny-hook floor, carrying only the scoped PAT. `ensureLabel` provisions with `gh label create …
 *  --force`, so an existing label is a no-op and a hard failure returns false. `opts.exec`
 *  (mirroring `ghGateway` in status.ts) is an injectable stand-in for the raw `gh` invocation, so
 *  both the tolerate-failure branch and `create`'s URL plumbing are exercised without shelling out. */
export function ghIssueGateway(
  owner: string,
  repo: string,
  opts: { exec?: (args: string[]) => string } = {},
): IssueGateway {
  const repoArg = `${owner}/${repo}`;
  const run =
    opts.exec ??
    ((args: string[]) => ghExec(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
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
      // OPEN issues only, with body (carries `**Task:** <id>`). Read over REST's `/issues`, NOT
      // `gh issue list --label`: that routes label filtering through GitHub's GraphQL `search()`
      // connection, throttled account-wide here, and made this read fail 100% of the time. THROWS
      // on a `gh` failure — the caller degrades to no action this cycle, never "zero open".
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

// ── W1-T2696: signed, single-use answer links ────────────────────────────────
//
// The loop is half built. `rmd escalate` opens a needs-human issue with typed options
// (W1-T2273); the console executes them through a closed route map; notify() pages the operator
// with prose. The operator reads the ping on a phone and must open the console to act.
//
// A link, not a bot: a Telegram or Slack bot is a new channel with its own identity problem
// (channel spoofing). A signed link inherits the console's token model and W1-T2211's boundary —
// the secret is minted by the daemon under the state root, which a worker tree cannot read.
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

/** Create-once, read-thereafter, mode 600 — the discipline `loadServiceTokens` already uses.
 *  A rotation is: stop the daemon, delete the file, start it again. */
export function loadEscalationLinkSecret(
  root: string,
  io: { create: typeof createOrReadExclusive; write: typeof writeSync; close: typeof closeSync; mkdir: typeof mkdirSync } = {
    create: createOrReadExclusive,
    write: writeSync,
    close: closeSync,
    mkdir: mkdirSync,
  },
): string {
  const path = escalationLinkSecretPath(root);
  io.mkdir(dirname(path), { recursive: true });
  const result = io.create(path, 0o600);
  if (result.created) {
    const secret = randomBytes(32).toString("hex");
    io.write(result.fd, `${secret}\n`);
    io.close(result.fd);
    return secret;
  }
  return result.raw.trim();
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

/**
 * One answer URL for one executable option.
 *
 * Only an `executable` option gets a link: an `operator-only` option names an act the console
 * cannot perform, so a link for it would be a button that does nothing. Returns `undefined`
 * there rather than a dead URL, and the caller keeps rendering the prose.
 */
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

/**
 * Check a link's query before anything acts on it.
 *
 * The three failures are checked independently and reported apart, because they mean different
 * things to the operator: `forged` is an attack or a corrupted URL, `expired` is a stale ping
 * worth re-raising, `already-used` is a double-tap and is benign. Collapsing them into one
 * refusal would make the ledger unable to tell an attack from a second tap.
 */
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
