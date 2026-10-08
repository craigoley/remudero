/**
 * lib/escalation-answers.ts — the repository owner's reply on a needs-question escalation
 * reaches the fix rung (W1-T4471; MASTER-PLAN §4/§7, W1-T435, W1-T2496, W1-T2696).
 *
 * THE GAP THIS CLOSES. The fix rung's operator steering (`operatorVerdictEvidence`, lib/sweep.ts)
 * reads exactly two sources: an `operator_feedback` ledger row, and an `answer` line in
 * `plan/questions.ndjson`. The ONLY writer of the latter used to be the console's
 * `POST /v1/questions/answer`. A reply typed on the GitHub issue itself — where the operator was
 * asked, and where a phone push notification takes them — reached nothing: it sat on the issue,
 * unread, forever. This module is the read side that closes that: it polls OPEN needs-question
 * issues the fleet itself opened, and lands an accepted reply in the SAME store
 * `appendQuestionAnswer` (lib/worker.ts) already writes — one sink, whichever channel answered.
 */

/**
 * OPERATOR-ONLY, BY DESIGN (G-6). remudero's own public repo is deliberately excluded from the
 * issues-intake lane (lib/managed-repos.ts) — the public's issue text stays off this fleet's
 * prompts. A needs-question issue is opened on the SAME public repo, so this reader accepts only
 * an explicitly configured human login, or a non-bot `OWNER` when no login list is configured. Every other
 * comment is counted and ledgered as `escalation_answer.ignored` — its TEXT never reaches
 * {@link answerTextFor}, {@link appendQuestionAnswer}, or a prompt. Dropping this check is exactly
 * this task's own falsifier: a public commenter's text would then reach the question store.
 *
 * AN ANSWER IS AN INPUT, NEVER A COMMAND (W1-T2496's invariant, held here too). A reply whose
 * first word names one of the issue's own option labels selects that option — the accepted
 * answer text is that option's LABEL, never a route or a kind, so nothing here can execute
 * anything. Any other reply is recorded verbatim as the constraint the next fix round
 * re-dispatches with. Acknowledgement is a `+1` reaction on the accepted comment (design iv) —
 * this module never posts a comment on the public issue. IDEMPOTENT PER COMMENT (design ii):
 * `plan/questions.ndjson`'s own `origin` field (`issue#<n>:comment:<id>`) is the dedup key.
 *
 * A REACTION ANSWERS TOO (W1-T4471 -> W1-T4676). Typing a comment is not the only channel a phone
 * push notification leaves open — a thumbs-up/thumbs-down on the issue ITSELF is one tap. `+1`
 * accepts the issue's own `## Recommendation` (an option label, same as a typed reply naming it);
 * `-1` declines it; both land in the SAME `plan/questions.ndjson` store as a typed reply would.
 * OPERATOR-ONLY here too, but GitHub's reactions endpoint carries NO `author_association` field the
 * way comments do (there is no per-reaction relationship classification to read) — so this reader
 * compares a reaction's `user.login` against the repo owner login the gateway itself was built
 * with ({@link EscalationAnswerGateway.ownerLogin}, threaded straight from `ghEscalationAnswerGateway`'s
 * own `owner` argument, the same `owner/repo` REST path segment every other read here already
 * uses) when no explicit human list is configured. THE FLEET'S OWN
 * ACKNOWLEDGEMENT REACTION (design iii): accepting a reaction posts the fleet's own `+1` back on
 * the SAME issue ({@link EscalationAnswerGateway.reactPlusOneOnIssue}) so the operator sees it was
 * seen — that reaction's author is whichever account `gh` is authenticated as, never the owner
 * login, so it is excluded by the exact same login comparison and never re-read as a second
 * answer. `listReactions`/`ownerLogin`/`reactPlusOneOnIssue` are OPTIONAL on the gateway interface
 * so every W1-T4471 test double (built before reactions existed) keeps typechecking unchanged;
 * omitting any of the three just reads zero reactions, same as before this task.
 */

import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { ghExec, ghTextAsync } from "./github-transport.js";
import { appendLedger, type LedgerWriterDeps } from "./ledger.js";
import { appendQuestionAnswer } from "./worker.js";
import { openLedgerUnion } from "./ledger-union.js";
import {
  ASK_TYPE_LABEL,
  escalationTaskId,
  ghIssueGatewayAsync,
  labelledIssuesRestArgs,
  parseLabelledIssuesRest,
  renderIssueBody,
  splitConcatenatedJsonPages,
  tryEscalateAsync,
  type AsyncIssueGateway,
  type Escalation,
  type OpenIssue,
} from "./escalate.js";

/** The label {@link renderIssueBody} tags a needs-question issue with at creation time — see
 *  escalate.ts's own `ASK_TYPE_LABEL`. Read through the exported constant, never a second
 *  hardcoded string, so a relabel there can never silently orphan this reader. */
const NEEDS_QUESTION_LABEL = ASK_TYPE_LABEL.question;

/** One comment on an OPEN needs-question issue, normalized to the shape this reader needs. */
export interface EscalationIssueComment {
  id: number;
  body: string;
  authorLogin: string;
  /** GitHub's own vocabulary: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, … . Only
   *  `OWNER` is the legacy fallback; an explicit login list replaces it. */
  authorAssociation: string;
  /** `"User"` or `"Bot"` (GitHub's `user.type`) — a bot commenting as the repo owner (a fleet
   *  automation posting under the same account) is still refused. */
  authorType: string;
}

/** One reaction on an OPEN needs-question issue ITSELF (never a comment) — W1-T4676. */
export interface EscalationIssueReaction {
  id: number;
  /** GitHub's own reaction vocabulary (`+1`, `-1`, `laugh`, `hooray`, `confused`, `heart`,
   *  `rocket`, `eyes`) — only `+1`/`-1` are ever acted on; every other content is skipped. */
  content: string;
  authorLogin: string;
  /** `"User"` or `"Bot"` (GitHub's `user.type`) — same defense-in-depth as {@link
   *  EscalationIssueComment.authorType}, though a login mismatch alone already excludes the
   *  fleet's own account (see this module's header). */
  authorType: string;
}

/** What {@link readEscalationAnswers} needs from GitHub — a NARROWER surface than {@link
 *  "./escalate.js".IssueGateway}: it only ever reads (`listOpen`, `listComments`,
 *  `listReactions`) and acknowledges (`reactPlusOne`, `reactPlusOneOnIssue`), never creates,
 *  closes, or comments. `listReactions`/`ownerLogin`/`reactPlusOneOnIssue` are OPTIONAL —
 *  omitting all three (every W1-T4471 test double) just reads zero issue-level reactions. */
export interface EscalationAnswerGateway {
  /** OPEN issues carrying `label` — the same REST read {@link "./escalate.js".IssueGateway.listOpen}
   *  makes. THROWS on a `gh` read failure; the caller degrades to "nothing new this pass". */
  listOpen(label: string): OpenIssue[] | Promise<OpenIssue[]>;
  /** Every comment on one issue, oldest first (GitHub's own order). THROWS on a `gh` read
   *  failure; the caller skips just that issue this pass. */
  listComments(issueNumber: number): EscalationIssueComment[] | Promise<EscalationIssueComment[]>;
  /** Every reaction on the issue ITSELF, oldest first. THROWS on a `gh` read failure; the caller
   *  skips just that issue's reactions this pass. Optional — see the interface's own header. */
  listReactions?(issueNumber: number): EscalationIssueReaction[] | Promise<EscalationIssueReaction[]>;
  /** The repository owner's own GitHub login — the ONLY login {@link readEscalationAnswers}
   *  ever accepts a reaction from (see this module's header on why a reaction, unlike a comment,
   *  cannot be checked via `author_association`). Optional — see the interface's own header. */
  readonly ownerLogin?: string;
  /** Explicit human principals from validated config; when present replaces owner inference on both channels. */
  readonly operatorLogins?: readonly string[];
  /** Refusal alarms use the escalation writer, separate from answer acknowledgements. */
  readonly refusalIssues?: AsyncIssueGateway;
  /** Acknowledge an ACCEPTED reply with a `+1` reaction — never a posted comment (design iv).
   *  Best-effort: a failed reaction never blocks the answer from landing. */
  reactPlusOne(commentId: number): void;
  /** Acknowledge an ACCEPTED issue-level reaction with the fleet's OWN `+1` on the SAME issue —
   *  mirrors {@link reactPlusOne} for a channel with no comment id to react to. Best-effort, and
   *  optional — see the interface's own header. */
  reactPlusOneOnIssue?(issueNumber: number): void;
}

/** One raw comment row as GitHub's REST `/issues/{n}/comments` endpoint returns it. */
interface RestCommentRow {
  id: number;
  body?: string;
  author_association?: string;
  user?: { login?: string; type?: string } | null;
}

/** One raw reaction row as GitHub's REST `/issues/{n}/reactions` endpoint returns it — NO
 *  `author_association` field (unlike {@link RestCommentRow}); see this module's header. */
interface RestReactionRow {
  id: number;
  content?: string;
  user?: { login?: string; type?: string } | null;
}

/** The real gateway: `gh api`, matching escalate.ts's `ghIssueGateway` REST discipline (never
 *  `gh issue`/`gh pr` subcommands, which route through GraphQL `search()` and are throttled
 *  account-wide here). `reactPlusOne` posts with a bare `-f` body and NO `-X`/`--method` flag —
 *  gh infers POST from the presence of `-f` — so it is intentionally NOT one of the write-verb
 *  argv shapes `test/authority-ratchet.test.ts` scans for (this is an acknowledgement reaction,
 *  never a repo-content write in that census's sense: it changes nothing an operator or the fix
 *  rung reads back).
 */
export function ghEscalationAnswerGateway(
  owner: string,
  repo: string,
  // W1-T6248: reads go through the async transport, which awaits the same cadence gap and lock
  // the synchronous one slept through on the daemon loop (a 20.3 s block, live profile 2026-10-07).
  readText: (args: string[]) => Promise<string> = (args) => ghTextAsync(args),
  operatorLogins?: readonly string[],
): EscalationAnswerGateway {
  const repoArg = `${owner}/${repo}`;
  const run = (args: string[]) => ghExec(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    ownerLogin: owner,
    operatorLogins,
    refusalIssues: ghIssueGatewayAsync(owner, repo, { exec: readText }),
    async listOpen(label) {
      return parseLabelledIssuesRest(await readText(labelledIssuesRestArgs(repoArg, label, "open")));
    },
    async listComments(issueNumber) {
      const raw = await readText(["api", `repos/${repoArg}/issues/${issueNumber}/comments?per_page=100`, "--paginate"]);
      const rows = splitConcatenatedJsonPages(raw).flatMap((chunk) => {
        const page = JSON.parse(chunk) as unknown;
        if (!Array.isArray(page)) throw new Error(`listComments: expected a JSON array page, got ${typeof page}`);
        return page as RestCommentRow[];
      });
      return rows.map((r) => ({
        id: r.id,
        body: r.body ?? "",
        authorLogin: r.user?.login ?? "",
        authorAssociation: r.author_association ?? "NONE",
        authorType: r.user?.type ?? "User",
      }));
    },
    async listReactions(issueNumber) {
      const raw = await readText(["api", `repos/${repoArg}/issues/${issueNumber}/reactions?per_page=100`, "--paginate"]);
      const rows = splitConcatenatedJsonPages(raw).flatMap((chunk) => {
        const page = JSON.parse(chunk) as unknown;
        if (!Array.isArray(page)) throw new Error(`listReactions: expected a JSON array page, got ${typeof page}`);
        return page as RestReactionRow[];
      });
      return rows.map((r) => ({
        id: r.id,
        content: r.content ?? "",
        authorLogin: r.user?.login ?? "",
        authorType: r.user?.type ?? "User",
      }));
    },
    reactPlusOne(commentId) {
      run(["api", `repos/${repoArg}/issues/comments/${commentId}/reactions`, "-f", "content=+1"]);
    },
    reactPlusOneOnIssue(issueNumber) {
      run(["api", `repos/${repoArg}/issues/${issueNumber}/reactions`, "-f", "content=+1"]);
    },
  };
}

function operatorRefusal(
  author: Pick<EscalationIssueComment, "authorLogin" | "authorType">,
  operatorLogins: readonly string[] | undefined,
  legacyOwner: boolean,
): string | undefined {
  if (author.authorType.toLowerCase() === "bot") return "bot";
  if (operatorLogins !== undefined) {
    return operatorLogins.some(login => login.toLowerCase() === author.authorLogin.toLowerCase())
      ? undefined : "not-configured-operator";
  }
  return legacyOwner ? undefined : "not-owner";
}

/** OWNER-ONLY for a reaction — a login match against `ownerLogin` (see this module's header for
 *  why a reaction, unlike a comment, cannot be checked via `author_association`), plus the same
 *  not-a-bot defense-in-depth the comment reader applies. Exported for a direct unit test. */
export function isOwnerReaction(r: EscalationIssueReaction, ownerLogin: string): boolean {
  return operatorRefusal(r, undefined, r.authorLogin.toLowerCase() === ownerLogin.toLowerCase()) === undefined;
}

/** The option labels an issue's own `## Options` section names, in the exact form {@link
 *  "./escalate.js".renderIssueBody} rendered them (`- **label** — detail`). */
function parseOptionLabels(issueBody: string): string[] {
  const section = /##\s*Options\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(issueBody)?.[1] ?? "";
  return [...section.matchAll(/^-\s*\*\*(.+?)\*\*/gm)].map((m) => m[1].trim());
}

/** The `## Recommendation` line {@link "./escalate.js".renderIssueBody} rendered — one option's
 *  own label (`Escalation.recommendation` "must be one of options[].label", escalate.ts), never
 *  a multi-line block, so ONLY the line right after the heading is read (the heading's section
 *  runs to the body's end, unlike {@link parseOptionLabels}'s `## Options`, since Recommendation
 *  is renderIssueBody's LAST heading — reading to "the next `##`" would swallow the footer too). */
function parseRecommendation(issueBody: string): string {
  return /##\s*Recommendation\s*\n([^\n]*)/i.exec(issueBody)?.[1]?.trim() ?? "";
}

/**
 * The answer text {@link appendQuestionAnswer} records for one accepted comment — design (ii).
 * When the reply's own FIRST WORD names one of the issue's option labels (case-insensitive,
 * trailing punctuation ignored), the recorded answer is that option's own label, so
 * `operatorVerdictEvidence` (lib/sweep.ts) quotes back exactly the choice the operator made.
 * Otherwise the reply's whole trimmed text is recorded verbatim as the re-dispatch constraint.
 * Exported for a direct, GitHub-free unit test of the selection rule.
 */
export function answerTextFor(replyText: string, issueBody: string): string {
  const trimmed = replyText.trim();
  const firstWord = trimmed.split(/\s+/)[0]?.replace(/[.,!:;]+$/, "");
  if (firstWord) {
    const match = parseOptionLabels(issueBody).find((label) => label.toLowerCase() === firstWord.toLowerCase());
    if (match) return match;
  }
  return trimmed;
}

/**
 * The answer text {@link appendQuestionAnswer} records for an ACCEPTED `+1`/`-1` reaction on the
 * issue itself — design (i)/(ii). A reaction carries no text of its own to select or record, so
 * both cases record the issue's own `## Recommendation` label: `+1` records it verbatim, exactly
 * like a typed reply naming that option (see {@link answerTextFor}); `-1` records the SAME label
 * prefixed with a plain decline, so `operatorVerdictEvidence`'s downstream constraint (lib/sweep.ts)
 * reads unambiguously as a refusal rather than a second acceptance. `undefined` for any OTHER
 * reaction content (`heart`, `rocket`, …) or an issue with no recoverable recommendation — neither
 * is ever recorded. Exported for a direct, GitHub-free unit test of the selection rule.
 */
export function reactionAnswerText(content: string, issueBody: string): string | undefined {
  const recommendation = parseRecommendation(issueBody);
  if (!recommendation) return undefined;
  if (content === "+1") return recommendation;
  if (content === "-1") return `no — declining "${recommendation}"`;
  return undefined;
}

/** Every `origin` already recorded in `plan/questions.ndjson` — the idempotency check (design
 *  ii). Tolerant of an absent or torn file, same discipline as every other reader of this store
 *  (run-task.ts's `readQuestionsNdjson`, worker.ts's `appendQuestion`). */
function recordedQuestionStoreOrigins(root: string): Set<string> {
  const path = join(root, "plan", "questions.ndjson");
  const origins = new Set<string>();
  if (!existsSync(path)) return origins;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.origin === "string") origins.add(parsed.origin);
    } catch {
      // torn/malformed line — skipped, never taking out the whole read.
    }
  }
  return origins;
}

export interface EscalationAnswerResult {
  /** New repository-owner replies landed in `plan/questions.ndjson` this pass. */
  accepted: number;
  /** Comments seen this pass whose author was not the repository owner (or was a bot) — counted,
   *  never read into a prompt. */
  ignored: number;
  /** Reads that FAILED this pass (the issue list, or one issue's comments) — kept apart from
   *  "nothing new", which is `accepted: 0` with this at 0. */
  unreadable: number;
}

interface RefusalHistory {
  login: string;
  reason: string;
  origins: Map<string, { issue: string; passes: Set<string> }>;
  excluded: Set<string>;
  alarm?: string;
}

function observeRefusal(groups: Map<string, RefusalHistory>, row: Record<string, unknown>): void {
  if (row.step === "panel.question_answered" && typeof row.author_login === "string") {
    for (const group of groups.values()) {
      if (group.login !== row.author_login.toLowerCase()) continue;
      group.excluded = new Set(group.origins.keys());
      group.alarm = undefined;
    }
    return;
  }
  const login = row.step === "escalation_answer.refusal_alarm" ? row.login : row.author_login;
  if (typeof login !== "string" || !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(login) ||
      (row.reason !== "not-owner" && row.reason !== "not-configured-operator") ||
      (typeof row.author_type === "string" && row.author_type.toLowerCase() === "bot")) return;
  const normalized = login.toLowerCase();
  const key = `${normalized}:${row.reason}`;
  const group: RefusalHistory = groups.get(key) ?? { login: normalized, reason: row.reason, origins: new Map(), excluded: new Set() };
  groups.set(key, group);
  if (row.step === "escalation_answer.refusal_alarm") {
    if (row.status === "closed") {
      group.excluded = new Set(Array.isArray(row.origins) ? row.origins as string[] : group.origins.keys());
      group.alarm = undefined;
    } else if (typeof row.issue_url === "string") group.alarm = row.issue_url;
    return;
  }
  if (row.step !== "escalation_answer.ignored" || typeof row.origin !== "string") return;
  const issueNumber = /^issue#(\d+):comment:\d+$/.exec(row.origin)?.[1];
  if (!issueNumber) return;
  const entry = group.origins.get(row.origin) ?? { issue: `issue#${issueNumber}`, passes: new Set<string>() };
  if (typeof row.issue_url === "string") entry.issue = row.issue_url;
  const pass = row.pass_id ?? row.run_id;
  if (typeof pass === "string") entry.passes.add(pass);
  group.origins.set(row.origin, entry);
}

async function raiseRefusalAlarms(
  history: Record<string, unknown>[], current: Record<string, unknown>[],
  issues: AsyncIssueGateway, deps: LedgerWriterDeps, runId: string,
): Promise<number> {
  const writeLedger = deps.writeLedger ?? appendLedger;
  const groups = new Map<string, RefusalHistory>();
  for (const row of history.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")))) observeRefusal(groups, row);
  const active = [...groups.values()].filter(group => group.alarm !== undefined);
  let open: OpenIssue[] = [];
  if (groups.size > 0 || current.some(row => row.step === "escalation_answer.ignored" && row.reason !== "bot")) {
    try {
      if (!issues.listOpen) throw new Error("refusal alarm gateway cannot read open issues");
      open = await issues.listOpen("needs-human");
      for (const group of active) {
        if (open.some(issue => issue.url === group.alarm)) continue;
        const row = { step: "escalation_answer.refusal_alarm", run_id: runId, task_id: `ESCALATION-ANSWERS:${group.login}`, login: group.login,
          reason: group.reason, comments: group.origins.size, issue_url: group.alarm,
          status: "closed", origins: [...group.origins.keys()] };
        writeLedger(deps.ledgerPath, row);
        observeRefusal(groups, row);
      }
    } catch (error) {
      writeLedger(deps.ledgerPath, { step: "escalation_answer.refusal_alarm_unreadable", run_id: runId, task_id: "ESCALATION-ANSWERS",
        reason: String((error as Error).message ?? error) });
      return 1;
    }
  }
  for (const row of current) observeRefusal(groups, row);
  for (const group of groups.values()) {
    if (group.alarm !== undefined) continue;
    const comments = [...group.origins].filter(([origin]) => !group.excluded.has(origin));
    const passes = new Set(comments.flatMap(([, entry]) => [...entry.passes]));
    if (comments.length < 3 && passes.size < 2) continue;
    const recommendation = "configure the human operator";
    const alarm: Escalation = {
      class: "MANUAL", taskId: `ESCALATION-ANSWERS:${group.login}`, runId,
      summary: `answers from ${group.login} keep being ignored`,
      detail: `${group.login} was refused on ${comments.length} distinct comments (${group.reason}).\n` +
        `Issues commented on: ${[...new Set(comments.map(([, entry]) => entry.issue))].join(", ")}.\n` +
        "To admit this human, set operatorGithubLogins in config.json. Without a configured list, " +
        "the repository-owner rule accepts only a non-bot OWNER comment. Verify the login before configuring it.",
      options: [{ label: recommendation, detail: "Verify the login and add it to operatorGithubLogins in config.json." },
        { label: "keep refusing this login", detail: "Leave the authority configuration unchanged and close this alarm." }],
      recommendation,
      consequence: "These replies will remain ignored and the questions they answer will remain unanswered.",
    };
    const issueUrl = await tryEscalateAsync(alarm, { issues: { ...issues, listOpen: () => open }, ledgerPath: deps.ledgerPath, runId });
    if (issueUrl !== null) {
      writeLedger(deps.ledgerPath, { step: "escalation_answer.refusal_alarm", run_id: runId, task_id: alarm.taskId,
        login: group.login, reason: group.reason, comments: comments.length, issue_url: issueUrl });
      if (!open.some(issue => issue.url === issueUrl)) open.push({ number: Number(issueUrl.split("/").at(-1)),
        url: issueUrl, title: `[${alarm.class}] ${alarm.taskId}: ${alarm.summary}`, body: renderIssueBody(alarm) });
    }
  }
  return 0;
}

/**
 * Poll every OPEN needs-question issue for a NEW repository-owner reply, and land each accepted
 * one in `plan/questions.ndjson` — the exact store {@link "./worker.js".appendQuestionAnswer}
 * already writes, which `operatorVerdictEvidence` (lib/sweep.ts) already reads each sweep pass.
 * A failed read degrades only its own slice (the whole list, or one issue) and is counted in
 * `unreadable`; a failed reaction never un-lands an answer. `root` holds the question store.
 */
export async function readEscalationAnswers(
  root: string,
  runId: string,
  gateway: EscalationAnswerGateway,
  deps: LedgerWriterDeps,
  clock: Clock = systemClock,
): Promise<EscalationAnswerResult> {
  const current: Record<string, unknown>[] = [];
  const writeLedger: typeof appendLedger = (path, row) => {
    current.push(row);
    (deps.writeLedger ?? appendLedger)(path, row);
  };
  const passId = randomUUID();
  let accepted = 0;
  let ignored = 0;
  let unreadable = 0;
  let issues: OpenIssue[];
  try {
    issues = await gateway.listOpen(NEEDS_QUESTION_LABEL);
  } catch {
    return { accepted, ignored, unreadable: 1 }; // the list itself was unreadable this pass
  }
  const history: Record<string, unknown>[] = [];
  let historyReadable = true;
  if (gateway.refusalIssues) {
    for await (const row of openLedgerUnion(dirname(deps.ledgerPath), {
      step: ["escalation_answer.ignored", "escalation_answer.refusal_alarm", "panel.question_answered"],
      onUnreadArchive: () => { historyReadable = false; },
      onUnreadLive: () => { historyReadable = false; },
    })) history.push(row);
    if (!historyReadable) {
      unreadable++;
      writeLedger(deps.ledgerPath, { step: "escalation_answer.refusal_alarm_unreadable", run_id: runId, task_id: "ESCALATION-ANSWERS",
        reason: "unreadable ledger history" });
    }
  }
  const recordedOrigins = recordedQuestionStoreOrigins(root);
  /** Land one ACCEPTED answer (a comment or a reaction) in the shared store — design (ii)'s "one
   *  sink, whichever channel answered", now three channels deep. */
  const landAnswer = (taskId: string, origin: string, answer: string, authorLogin: string) => {
    const recordedToQuestionStore = appendQuestionAnswer(root, { ts: clock.iso(), task: taskId, answer, origin });
    writeLedger(deps.ledgerPath, {
      run_id: runId,
      task_id: taskId,
      step: "panel.question_answered",
      answer,
      origin,
      author_login: authorLogin,
      authority: gateway.operatorLogins === undefined ? "repository-owner" : "configured-operator",
      flows_to: "plan/questions.ndjson",
      recorded_to_question_store: recordedToQuestionStore,
    });
    accepted++;
    recordedOrigins.add(origin);
  };
  for (const issue of issues) {
    const taskId = escalationTaskId(issue.body);
    if (!taskId) continue; // an issue with no recoverable task referent steers nothing
    let comments: EscalationIssueComment[];
    try {
      comments = await gateway.listComments(issue.number);
    } catch {
      unreadable++; // counted, then just this issue is skipped this pass
      continue;
    }
    for (const comment of comments) {
      const origin = `issue#${issue.number}:comment:${comment.id}`;
      if (recordedOrigins.has(origin)) continue; // design (ii): idempotent per comment id
      const refusal = operatorRefusal(comment, gateway.operatorLogins, comment.authorAssociation === "OWNER");
      if (refusal !== undefined) {
        ignored++;
        writeLedger(deps.ledgerPath, {
          run_id: runId,
          task_id: taskId,
          step: "escalation_answer.ignored",
          origin,
          author_association: comment.authorAssociation,
          author_login: comment.authorLogin,
          author_type: comment.authorType,
          issue_url: issue.url,
          pass_id: passId,
          reason: refusal,
        });
        continue;
      }
      const answer = answerTextFor(comment.body, issue.body ?? "");
      if (!answer) continue;
      landAnswer(taskId, origin, answer, comment.authorLogin);
      try {
        gateway.reactPlusOne(comment.id);
      } catch {
        // best-effort acknowledgement — a failed reaction never un-lands the answer.
      }
    }
    // W1-T4676: reactions on the ISSUE itself — optional surface, see the gateway's own header.
    if (!gateway.listReactions || (!gateway.ownerLogin && gateway.operatorLogins === undefined)) continue;
    let reactions: EscalationIssueReaction[];
    try {
      reactions = await gateway.listReactions(issue.number);
    } catch {
      unreadable++; // counted, then just this issue's reactions are skipped this pass
      continue;
    }
    for (const reaction of reactions) {
      const origin = `issue#${issue.number}:reaction:${reaction.id}`;
      if (recordedOrigins.has(origin)) continue; // design (ii): idempotent per reaction id
      if (operatorRefusal(reaction, gateway.operatorLogins,
          reaction.authorLogin.toLowerCase() === gateway.ownerLogin?.toLowerCase()) !== undefined) continue;
      const answer = reactionAnswerText(reaction.content, issue.body ?? "");
      if (!answer) continue; // not a +1/-1, or no recoverable recommendation to attach it to
      landAnswer(taskId, origin, answer, reaction.authorLogin);
      try {
        gateway.reactPlusOneOnIssue?.(issue.number);
      } catch {
        // best-effort acknowledgement — a failed reaction never un-lands the answer.
      }
    }
  }
  if (gateway.refusalIssues && historyReadable) {
    unreadable += await raiseRefusalAlarms(history, current, gateway.refusalIssues, deps, runId);
  }
  return { accepted, ignored, unreadable };
}
