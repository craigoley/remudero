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
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { systemClock, type Clock } from "./clock.js";
import { ghExec, ghTextAsync } from "./github-transport.js";
import { appendLedger, type LedgerWriterDeps } from "./ledger.js";
import { appendQuestionAnswer } from "./worker.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";
import { contributionOriginFromRest, feedbackContentDigest, observeFeedbackSource, readAdmissionRestAsync,
  type AdmissionRead, type AdmissionSettings, type FeedbackAdmissionSubject } from "./contributor-admission.js";
import { openLedgerUnion } from "./ledger-union.js";
import { captureFeedbackReply, feedbackReplyQueueFingerprint, replyRefusalFor, type PanelGraphDeps } from "./panel-graph.js";
import { feedbackEntryRepoPath, findFeedbackBySubmissionKey, isValidFeedbackOrigin, type FeedbackEntry } from "./feedback.js";
import { readQueuedFeedbackRecords, type QueuedFeedbackRecord } from "./feedback-landing.js";
import {
  ASK_TYPE_LABEL,
  escalationTaskId,
  escalationIssueTitle,
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
  sourceSubject?: FeedbackAdmissionSubject;
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
  sourceSubject?: FeedbackAdmissionSubject;
}

/** What {@link readEscalationAnswers} needs from GitHub — a NARROWER surface than {@link
 *  "./escalate.js".IssueGateway}: it only ever reads (`listOpen`, `listComments`,
 *  `listReactions`) and acknowledges (`reactPlusOne`, `reactPlusOneOnIssue`), never creates,
 *  closes, or comments. `listReactions`/`ownerLogin`/`reactPlusOneOnIssue` are OPTIONAL —
 *  omitting all three (every W1-T4471 test double) just reads zero issue-level reactions. */
export interface EscalationAnswerGateway {
  readonly admission?: AdmissionSettings;
  readonly sourceRead?: AdmissionRead;
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
  updated_at?: string;
  user?: { id?: number; login?: string; type?: string } | null;
}

/** One raw reaction row as GitHub's REST `/issues/{n}/reactions` endpoint returns it — NO
 *  `author_association` field (unlike {@link RestCommentRow}); see this module's header. */
interface RestReactionRow {
  id: number;
  content?: string;
  created_at?: string;
  user?: { id?: number; login?: string; type?: string } | null;
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
  feedback?: { settings: AdmissionSettings; read?: AdmissionRead },
): EscalationAnswerGateway {
  const repoArg = `${owner}/${repo}`;
  const run = (args: string[]) => ghExec(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parents = new Map<number, FeedbackAdmissionSubject>();
  let repository: FeedbackAdmissionSubject["repository"];
  const subject = (kind: FeedbackAdmissionSubject["kind"], sourceRef: string, issueNumber: number,
    item: RestCommentRow | RestReactionRow, parent?: FeedbackAdmissionSubject): FeedbackAdmissionSubject => ({
    kind, sourceRef, repository, issueNumber, itemId: item.id, observedAtMs: systemClock.now(),
    origin: contributionOriginFromRest(item),
    revision: "content" in item
      ? { createdAt: (item as RestReactionRow).created_at, contentDigest: feedbackContentDigest(item.content) }
      : { updatedAt: (item as RestCommentRow).updated_at, contentDigest: feedbackContentDigest((item as RestCommentRow).body) },
    ...(parent?.itemId && parent.revision ? { parent: { kind: "issue" as const, itemId: parent.itemId, revision: parent.revision } } : {}),
  });
  return {
    admission: feedback?.settings,
    sourceRead: feedback?.read,
    ownerLogin: owner,
    operatorLogins,
    refusalIssues: ghIssueGatewayAsync(owner, repo, { exec: readText }),
    async listOpen(label) {
      const raw = await readText(labelledIssuesRestArgs(repoArg, label, "open"));
      const issues = parseLabelledIssuesRest(raw);
      if (feedback === undefined) return issues;
      repository = undefined;
      parents.clear();
      try {
        const response = await (feedback.read ?? readAdmissionRestAsync)(`repos/${repoArg}`);
        const row = response.body as { id?: number; full_name?: string; private?: boolean } | null;
        if (response.status === 200 && row?.full_name === repoArg && Number.isSafeInteger(row.id) && row.id! > 0
          && typeof row.private === "boolean") repository = { id: row.id, fullName: row.full_name, private: row.private };
      } catch { /* Unreadable identity stays missing; accepted legacy replies still land in shadow. */ }
      for (const item of splitConcatenatedJsonPages(raw).flatMap(chunk => JSON.parse(chunk)) as Array<RestCommentRow & {
        number: number; title?: string; labels?: unknown; pull_request?: unknown;
      }>) {
        if ("pull_request" in item) continue;
        parents.set(item.number, { ...subject("issue", `${repoArg}#${item.number}`, item.number, item),
          revision: { updatedAt: item.updated_at, contentDigest: feedbackContentDigest([item.title, item.body, item.labels]) } });
      }
      return issues;
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
        ...(feedback === undefined ? {} : { sourceSubject: subject("issue-comment", `${repoArg}#${issueNumber}/comment/${r.id}`, issueNumber, r) }),
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
        ...(feedback === undefined ? {} : { sourceSubject: subject("issue-reaction", `${repoArg}#${issueNumber}/reaction/${r.id}`, issueNumber, r, parents.get(issueNumber)) }),
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
  return optionLabelNamed(replyText, issueBody) ?? replyText.trim();
}

/** Whether a reply is ONLY the option label {@link answerTextFor} records for it (case-insensitive, trailing punctuation
 *  ignored). A reply that names an option and adds text (`revise-pr, but only the test`) is a QUALIFIED answer whose
 *  recorded text is still the bare label, so a reader that acts on the label alone (fix-progress-judge.ts
 *  `unfiledScopeGrant`, #14217) reads this, ledgered as `bare_option`, to tell the two apart. */
function replyIsBareOption(replyText: string, issueBody: string): boolean {
  return replyText.trim().split(/\s+/).length === 1 && optionLabelNamed(replyText, issueBody) !== undefined;
}

/** The issue's option label the reply's FIRST WORD names (case-insensitive, trailing punctuation ignored), else undefined. */
function optionLabelNamed(replyText: string, issueBody: string): string | undefined {
  const firstWord = replyText.trim().split(/\s+/)[0]?.replace(/[.,!:;]+$/, "");
  if (!firstWord) return undefined;
  return parseOptionLabels(issueBody).find((label) => label.toLowerCase() === firstWord.toLowerCase());
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

/** W1-T8511: the feedback record a `TRIAGE-<feedback id>` escalation grills — any id shape (an `fb-*` capture or a
 *  gardener's `evidence-coverage-*` record), never a path: the id must be one plain file-name segment. */
export function grilledFeedbackId(taskId: string): string | undefined {
  const id = /^TRIAGE-(.+)$/.exec(taskId)?.[1];
  return id !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..") ? id : undefined;
}

/** One accepted operator answer on an issue, stored this pass or on an earlier one. */
interface AcceptedAnswer {
  origin: string;
  text: string;
  namesOption: boolean;
}

/** W1-T8511 design step 6: when an issue holds several accepted answers, the one whose FIRST WORD is one of the
 *  issue's option labels (the match {@link answerTextFor} makes) wins over an earlier prose reply; only when none
 *  names an option does the earliest apply. */
export function pickFeedbackAnswer<T extends { namesOption: boolean }>(answers: readonly T[]): T | undefined {
  return answers.find((a) => a.namesOption) ?? answers[0];
}

function unchangedQueuedCapture(id: string, queued: QueuedFeedbackRecord, canonical: FeedbackEntry | undefined): boolean {
  if (queued.status !== "new" || queued.proposal_pr != null || queued.summary != null || queued.answered_by != null
    || canonical?.id !== id || canonical.status !== "grilling" || canonical.answered_by != null
    || typeof canonical.ts !== "string" || typeof canonical.raw !== "string"
    || !Array.isArray(canonical.attachments) || !canonical.attachments.every(item => typeof item === "string")
    || typeof canonical.origin !== "string" || !isValidFeedbackOrigin(canonical.origin)) return false;
  const capture = (record: object) => Object.fromEntries(Object.entries(record)
    .filter(([key]) => !["status", "proposal_pr", "summary", "answered_by"].includes(key)));
  return isDeepStrictEqual(capture(queued), capture(canonical));
}

/**
 * W1-T8511: apply the picked operator answer to the grilled feedback record through the console's own reply writer
 * ({@link captureFeedbackReply}). Only a record still `grilling` is touched (design step 7): a queued record is read
 * first, then the route's own {@link replyRefusalFor} status read over an async origin/main read, both BEFORE any write — so an answered, rejected or
 * otherwise moved record gets no write at all. The answer's origin is the reply's `submission_key`, so a second pass
 * finds it and writes nothing (design step 3). Returns the ledger row to write: `feedback_applied` on a write,
 * `feedback_unreadable` when a store could not be read, and undefined when there is nothing to apply.
 * W1-T10789: an unchanged queued capture at `new` may follow canonical `grilling`; queued decisions
 * remain authoritative, and the writer rechecks the queue's byte identity before capturing a reply.
 */
async function applyGrilledFeedbackAnswer(
  feedback: Pick<PanelGraphDeps, "root" | "inboxRoot" | "feedbackLand">,
  issue: OpenIssue,
  taskId: string,
  answers: readonly AcceptedAnswer[],
): Promise<({ step: string; task_id: string } & Record<string, unknown>) | undefined> {
  const feedbackId = grilledFeedbackId(taskId);
  const picked = pickFeedbackAnswer(answers);
  if (feedbackId === undefined || picked === undefined) return undefined;
  const base = { task_id: taskId, feedback_id: feedbackId, origin: picked.origin, issue_url: issue.url };
  try {
    const queueFingerprint = feedbackReplyQueueFingerprint(feedback.inboxRoot);
    const queued = readQueuedFeedbackRecords(feedback.inboxRoot);
    const queuedRecord = queued.get(feedbackEntryRepoPath(feedbackId));
    if (queuedRecord !== undefined && !["new", "grilling"].includes(queuedRecord.status)) return undefined;
    // The route's own status read, fed origin/main's blob read off the loop (a rejection reads as unreadable).
    const mainBlob = await hostWorktreeGitAsync(feedback.root, ["show", `origin/main:${feedbackEntryRepoPath(feedbackId)}`])
      .catch((error: unknown) => ({ unreadable: error }));
    const canonical = typeof mainBlob === "string" ? parseYaml(mainBlob) as FeedbackEntry | undefined : undefined;
    if (queuedRecord?.status === "new" && !unchangedQueuedCapture(feedbackId, queuedRecord, canonical)) {
      throw new Error("queued capture lacks unchanged canonical grilling evidence");
    }
    if (replyRefusalFor(feedback.root, feedbackId, queued, () => {
      if (typeof mainBlob !== "string") throw mainBlob.unreadable;
      return mainBlob;
    })) return undefined;
    if (findFeedbackBySubmissionKey(feedback.root, picked.origin, feedback.inboxRoot)) return undefined;
    const { entry, landingError } = captureFeedbackReply(feedback, {
      text: picked.text, replyTo: feedbackId, submissionKey: picked.origin, origin: "issue",
    }, { target: queuedRecord?.status === "grilling" ? queuedRecord as unknown as FeedbackEntry : canonical, queueFingerprint });
    return { ...base, step: "escalation_answer.feedback_applied", reply_id: entry.id, answer: picked.text,
      ...(landingError === undefined ? { landing: "queued" } : { landing_error: landingError }) };
  } catch (error) {
    return { ...base, step: "escalation_answer.feedback_unreadable", reason: String((error as Error)?.message ?? error) };
  }
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
        url: issueUrl, title: escalationIssueTitle(alarm), body: renderIssueBody(alarm) });
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
  // W1-T8511: `feedback`, when set, ALSO answers the grilled feedback record a `TRIAGE-<id>` issue names.
  deps: LedgerWriterDeps & { feedback?: Pick<PanelGraphDeps, "root" | "inboxRoot" | "feedbackLand"> },
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
  const landAnswer = async (taskId: string, origin: string, answer: string, authorLogin: string, subject?: FeedbackAdmissionSubject,
    replyFields: { bare_option?: boolean } = {}) => {
    const observation = gateway.admission === undefined || subject === undefined ? undefined
      : await observeFeedbackSource(gateway.admission, subject, "question-answer", (step, fields) =>
        writeLedger(deps.ledgerPath, { ...fields, step, run_id: runId, task_id: taskId }), gateway.sourceRead, clock);
    const contribution = gateway.admission === undefined ? undefined : {
      kind: subject?.kind ?? "unresolved", source_ref: subject?.sourceRef ?? origin,
      ...(subject === undefined ? {} : { subject: structuredClone(subject) }),
      admission: observation?.decision ?? { outcome: "unknown", reason: "lineage-unreadable" },
    };
    const recordedToQuestionStore = appendQuestionAnswer(root, { ts: clock.iso(), task: taskId, answer, origin,
      ...(contribution === undefined ? {} : { contribution }) });
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
      ...replyFields,
      ...(contribution === undefined ? {} : { contribution }),
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
    // W1-T8511: every accepted operator answer on this issue, new or already stored, for the feedback record.
    const acceptedAnswers: AcceptedAnswer[] = [];
    for (const comment of comments) {
      const origin = `issue#${issue.number}:comment:${comment.id}`;
      const refusal = operatorRefusal(comment, gateway.operatorLogins, comment.authorAssociation === "OWNER");
      const accepted = (): void => {
        const text = comment.body.trim();
        if (text) acceptedAnswers.push({ origin, text, namesOption: optionLabelNamed(text, issue.body ?? "") !== undefined });
      };
      if (recordedOrigins.has(origin)) { // design (ii): idempotent per comment id
        if (refusal === undefined) accepted();
        continue;
      }
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
      await landAnswer(taskId, origin, answer, comment.authorLogin, comment.sourceSubject,
        { bare_option: replyIsBareOption(comment.body, issue.body ?? "") });
      accepted();
      try {
        gateway.reactPlusOne(comment.id);
      } catch {
        // best-effort acknowledgement — a failed reaction never un-lands the answer.
      }
    }
    // W1-T4676: reactions on the ISSUE itself — optional surface, see the gateway's own header.
    if (gateway.listReactions && (gateway.ownerLogin || gateway.operatorLogins !== undefined)) {
      let reactions: EscalationIssueReaction[] = [];
      try {
        reactions = await gateway.listReactions(issue.number);
      } catch {
        unreadable++; // counted, then just this issue's reactions are skipped this pass
      }
      for (const reaction of reactions) {
        const origin = `issue#${issue.number}:reaction:${reaction.id}`;
        if (operatorRefusal(reaction, gateway.operatorLogins,
            reaction.authorLogin.toLowerCase() === gateway.ownerLogin?.toLowerCase()) !== undefined) continue;
        const answer = reactionAnswerText(reaction.content, issue.body ?? "");
        if (!answer) continue; // not a +1/-1, or no recoverable recommendation to attach it to
        const namesOption = reaction.content === "+1";
        if (recordedOrigins.has(origin)) { // design (ii): idempotent per reaction id
          acceptedAnswers.push({ origin, text: answer, namesOption });
          continue;
        }
        await landAnswer(taskId, origin, answer, reaction.authorLogin, reaction.sourceSubject);
        acceptedAnswers.push({ origin, text: answer, namesOption });
        try {
          gateway.reactPlusOneOnIssue?.(issue.number);
        } catch {
          // best-effort acknowledgement — a failed reaction never un-lands the answer.
        }
      }
    }
    // W1-T8511: the question-store write above is unchanged; a feedback GRILL issue ALSO answers its record.
    if (deps.feedback) {
      const row = await applyGrilledFeedbackAnswer(deps.feedback, issue, taskId, acceptedAnswers);
      if (row) writeLedger(deps.ledgerPath, { ...row, run_id: runId });
    }
  }
  if (gateway.refusalIssues && historyReadable) {
    unreadable += await raiseRefusalAlarms(history, current, gateway.refusalIssues, deps, runId);
  }
  return { accepted, ignored, unreadable };
}
