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
 *
 * OWNER-ONLY, BY DESIGN (G-6). remudero's own public repo is deliberately excluded from the
 * issues-intake lane (lib/managed-repos.ts) — the public's issue text stays off this fleet's
 * prompts. A needs-question issue is opened on the SAME public repo, so this reader accepts only
 * a comment whose `author_association` is `OWNER` and whose author is not a bot. Every other
 * comment is counted and ledgered as `escalation_answer.ignored` — its TEXT never reaches
 * {@link answerTextFor}, {@link appendQuestionAnswer}, or a prompt. Dropping this check is exactly
 * this task's own falsifier: a public commenter's text would then reach the question store.
 *
 * AN ANSWER IS AN INPUT, NEVER A COMMAND (W1-T2496's invariant, held here too). A reply whose
 * first word names one of the issue's own option labels selects that option — the accepted
 * answer text is that option's LABEL, never a route or a kind, so nothing here can execute
 * anything. Any other reply is recorded verbatim as the constraint the next fix round
 * re-dispatches with. Acknowledgement is a `+1` reaction on the accepted comment (design iv) —
 * this module never posts a comment on the public issue.
 *
 * IDEMPOTENT PER COMMENT (design ii). `plan/questions.ndjson`'s own `origin` field
 * (`issue#<n>:comment:<id>`) is the dedup key — a re-poll of an already-recorded comment creates
 * nothing new, mirroring lib/issues-intake.ts's existsSync-is-the-dedup-check discipline rather
 * than inventing a second store.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ghExec } from "./github-transport.js";
import { appendLedger } from "./ledger.js";
import { appendQuestionAnswer } from "./worker.js";
import {
  ASK_TYPE_LABEL,
  escalationTaskId,
  labelledIssuesRestArgs,
  parseLabelledIssuesRest,
  splitConcatenatedJsonPages,
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
   *  `OWNER` is ever accepted — see this module's own header. */
  authorAssociation: string;
  /** `"User"` or `"Bot"` (GitHub's `user.type`) — a bot commenting as the repo owner (a fleet
   *  automation posting under the same account) is still refused. */
  authorType: string;
}

/** What {@link readEscalationAnswers} needs from GitHub — a NARROWER surface than {@link
 *  "./escalate.js".IssueGateway}: it only ever reads (`listOpen`, `listComments`) and
 *  acknowledges (`reactPlusOne`), never creates, closes, or comments. */
export interface EscalationAnswerGateway {
  /** OPEN issues carrying `label` — the same REST read {@link "./escalate.js".IssueGateway.listOpen}
   *  makes. THROWS on a `gh` read failure; the caller degrades to "nothing new this pass". */
  listOpen(label: string): OpenIssue[];
  /** Every comment on one issue, oldest first (GitHub's own order). THROWS on a `gh` read
   *  failure; the caller skips just that issue this pass. */
  listComments(issueNumber: number): EscalationIssueComment[];
  /** Acknowledge an ACCEPTED reply with a `+1` reaction — never a posted comment (design iv).
   *  Best-effort: a failed reaction never blocks the answer from landing. */
  reactPlusOne(commentId: number): void;
}

/** One raw comment row as GitHub's REST `/issues/{n}/comments` endpoint returns it. */
interface RestCommentRow {
  id: number;
  body?: string;
  author_association?: string;
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
export function ghEscalationAnswerGateway(owner: string, repo: string): EscalationAnswerGateway {
  const repoArg = `${owner}/${repo}`;
  const run = (args: string[]) => ghExec(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    listOpen(label) {
      return parseLabelledIssuesRest(run(labelledIssuesRestArgs(repoArg, label, "open")));
    },
    listComments(issueNumber) {
      const raw = run(["api", `repos/${repoArg}/issues/${issueNumber}/comments?per_page=100`, "--paginate"]);
      const rows = splitConcatenatedJsonPages(raw).flatMap((chunk) => {
        const page = JSON.parse(chunk) as unknown;
        return Array.isArray(page) ? (page as RestCommentRow[]) : [];
      });
      return rows.map((r) => ({
        id: r.id,
        body: r.body ?? "",
        authorLogin: r.user?.login ?? "",
        authorAssociation: r.author_association ?? "NONE",
        authorType: r.user?.type ?? "User",
      }));
    },
    reactPlusOne(commentId) {
      run(["api", `repos/${repoArg}/issues/comments/${commentId}/reactions`, "-f", "content=+1"]);
    },
  };
}

function isOwnerComment(c: EscalationIssueComment): boolean {
  return c.authorAssociation === "OWNER" && c.authorType.toLowerCase() !== "bot";
}

/** The option labels an issue's own `## Options` section names, in the exact form {@link
 *  "./escalate.js".renderIssueBody} rendered them (`- **label** — detail`). */
function parseOptionLabels(issueBody: string): string[] {
  const section = /##\s*Options\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(issueBody)?.[1] ?? "";
  return [...section.matchAll(/^-\s*\*\*(.+?)\*\*/gm)].map((m) => m[1].trim());
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

export interface ReadEscalationAnswersDeps {
  /** The repo root `plan/questions.ndjson` is read from and written to. */
  root: string;
  ledgerPath: string;
  runId: string;
  issues: EscalationAnswerGateway;
}

export interface EscalationAnswerResult {
  /** New repository-owner replies landed in `plan/questions.ndjson` this pass. */
  accepted: number;
  /** Comments seen this pass whose author was not the repository owner (or was a bot) — counted,
   *  never read into a prompt. */
  ignored: number;
}

/**
 * Poll every OPEN needs-question issue for a NEW repository-owner reply, and land each accepted
 * one in `plan/questions.ndjson` — the exact store {@link "./worker.js".appendQuestionAnswer}
 * already writes, which `operatorVerdictEvidence` (lib/sweep.ts) already reads each sweep pass.
 * FAIL-SOFT throughout (an unreadable list, a single unreadable issue's comments, or a failed
 * reaction never abort the pass) — mirrors lib/issues-intake.ts's own per-repo/per-issue
 * tolerance, so one bad read degrades only its own slice, never the whole poll.
 */
export function readEscalationAnswers(deps: ReadEscalationAnswersDeps): EscalationAnswerResult {
  let accepted = 0;
  let ignored = 0;
  let issues: OpenIssue[];
  try {
    issues = deps.issues.listOpen(NEEDS_QUESTION_LABEL);
  } catch {
    return { accepted, ignored }; // best-effort: a failed list read is "nothing new this pass"
  }
  const recordedOrigins = recordedQuestionStoreOrigins(deps.root);
  for (const issue of issues) {
    const taskId = escalationTaskId(issue.body);
    if (!taskId) continue; // an issue with no recoverable task referent steers nothing
    let comments: EscalationIssueComment[];
    try {
      comments = deps.issues.listComments(issue.number);
    } catch {
      continue; // skip just this issue this pass
    }
    for (const comment of comments) {
      const origin = `issue#${issue.number}:comment:${comment.id}`;
      if (recordedOrigins.has(origin)) continue; // design (ii): idempotent per comment id
      if (!isOwnerComment(comment)) {
        ignored++;
        appendLedger(deps.ledgerPath, {
          run_id: deps.runId,
          task_id: taskId,
          step: "escalation_answer.ignored",
          origin,
          author_association: comment.authorAssociation,
        });
        continue;
      }
      const answer = answerTextFor(comment.body, issue.body ?? "");
      if (!answer) continue;
      const recordedToQuestionStore = appendQuestionAnswer(deps.root, {
        ts: new Date().toISOString(),
        task: taskId,
        answer,
        origin,
      });
      appendLedger(deps.ledgerPath, {
        run_id: deps.runId,
        task_id: taskId,
        step: "panel.question_answered",
        answer,
        origin,
        flows_to: "plan/questions.ndjson",
        recorded_to_question_store: recordedToQuestionStore,
      });
      accepted++;
      recordedOrigins.add(origin);
      try {
        deps.issues.reactPlusOne(comment.id);
      } catch {
        // best-effort acknowledgement — a failed reaction never un-lands the answer.
      }
    }
  }
  return { accepted, ignored };
}
