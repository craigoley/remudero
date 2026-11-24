/**
 * W1-T14628: one PR comment, edited in place after each landed fix-lane push, that says what the round changed and
 * gives the exact command that undoes it.
 *
 * INVARIANT one-round-comment: a PR the fix lane has pushed to carries exactly one fix-round comment, found by its
 * hidden marker among the comments the fleet's own login wrote, and each landed push edits that comment rather than
 * adding another. A marker comment by any other author is never edited. Older rounds' rows are kept from the previous
 * body, so the comment is the history of the rounds, newest first.
 *
 * The writer never throws: a failed read or write logs `fix.round_comment_failed` and returns `failed`, so a comment
 * can never fail the round that pushed.
 */
import { ghTextAsync } from "./github-transport.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

export const FIX_ROUND_COMMENT_MARKER = "<!-- rmd-fix-round:v1 -->";
/** The fleet App as the REST issue-comments API spells its author. */
export const FIX_ROUND_COMMENT_AUTHOR = "remudero-fleet[bot]";

const TABLE_HEADER = "| Round site | Prior head | Pushed head | Files changed | Red checks answered |";
const TABLE_RULE = "| --- | --- | --- | --- | --- |";

/** One landed round, as the fix lane saw it when its push reached the remote branch. */
export interface FixRoundCommentRound {
  site: string;
  priorHead: string;
  pushedHead: string;
  redChecks: readonly string[];
}

export interface FixRoundCommentInput {
  prUrl: string;
  branch: string;
  /** The worktree the round pushed from; the changed files are read from it. */
  cwd: string;
  round: FixRoundCommentRound;
}

/** The writer the fix round is handed as a dependency: production wires {@link upsertFixRoundComment}; a round handed
 *  none posts no comment. */
export type FixRoundCommentWriter = (input: FixRoundCommentInput, log: Log) => Promise<FixRoundCommentResult>;

export type FixRoundCommentResult =
  | { action: "created" | "edited"; commentId: number }
  | { action: "failed"; reason: string };

export type Log = (step: string, extra?: Record<string, unknown>) => void;

/** The paths that differ between the round's prior and pushed heads, read with `git diff` in the worktree through
 *  the hardened worktree leaf. */
export async function fixRoundChangedFiles(cwd: string, priorHead: string, pushedHead: string): Promise<string[]> {
  const stdout = await hostWorktreeGitAsync(cwd, ["diff", "--name-only", priorHead, pushedHead], { maxBuffer: 1 << 26 });
  return stdout.split("\n").filter((line) => line !== "");
}

/** The exact command that undoes the round: it reverts every commit the round pushed and pushes the result. */
export function fixRoundRevertCommand(branch: string, priorHead: string, pushedHead: string): string {
  return `git fetch origin ${branch} && git checkout ${branch} && git revert --no-edit ${priorHead}..${pushedHead} && git push origin HEAD:${branch}`;
}

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const codeList = (items: readonly string[], none: string) => items.length === 0 ? none : items.map((item) => `\`${cell(item)}\``).join(", ");

function roundRow(round: FixRoundCommentRound, files: readonly string[] | undefined): string {
  return `| ${cell(round.site)} | \`${round.priorHead}\` | \`${round.pushedHead}\` | ${files === undefined ? "(unread)" : codeList(files, "(none)")} | ${codeList(round.redChecks, "(none)")} |`;
}

/** The table rows a previous body carries, in its order. A row whose pushed head is `pushedHead` is dropped: the
 *  round now being written replaces it. */
export function previousFixRoundRows(body: string, pushedHead: string): string[] {
  const lines = body.split("\n");
  const start = lines.indexOf(TABLE_RULE);
  if (start < 0) return [];
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("| ")) break;
    if (line.includes(` | \`${pushedHead}\` | `)) continue;
    rows.push(line);
  }
  return rows;
}

export function renderFixRoundComment(input: Pick<FixRoundCommentInput, "branch" | "round">,
  files: readonly string[] | undefined, previousBody = ""): string {
  const { branch, round } = input;
  return [
    FIX_ROUND_COMMENT_MARKER,
    "### Fix rounds",
    "",
    "The fix lane pushed these rounds to this branch, newest first.",
    "",
    TABLE_HEADER,
    TABLE_RULE,
    roundRow(round, files),
    ...previousFixRoundRows(previousBody, round.pushedHead),
    "",
    `To undo the newest round (\`${round.priorHead}..${round.pushedHead}\`):`,
    "",
    "```sh",
    fixRoundRevertCommand(branch, round.priorHead, round.pushedHead),
    "```",
    "",
  ].join("\n");
}

interface IssueComment { id: number; body: string; login: string }

function issueComments(raw: string): IssueComment[] {
  const pages = JSON.parse(raw) as unknown[];
  const out: IssueComment[] = [];
  for (const entry of pages.flat()) {
    const comment = entry as { id?: unknown; body?: unknown; user?: { login?: unknown } | null };
    if (typeof comment.id !== "number" || typeof comment.body !== "string" || typeof comment.user?.login !== "string") continue;
    out.push({ id: comment.id, body: comment.body, login: comment.user.login });
  }
  return out;
}

/** The fleet's own fix-round comment, the oldest when there is more than one. Another author's marker is ignored. */
export function ownFixRoundComment(comments: readonly IssueComment[]): IssueComment | undefined {
  return comments
    .filter((comment) => comment.login.toLowerCase() === FIX_ROUND_COMMENT_AUTHOR && comment.body.startsWith(FIX_ROUND_COMMENT_MARKER))
    .sort((a, b) => a.id - b.id)[0];
}

/** Create or edit the PR's one fix-round comment for a round whose push landed. Call it once per landed push.
 *  `gh` goes through the GitHub transport (broker, cadence, credential resolution); the fix round's seam is the writer
 *  itself, handed to it as a dependency ({@link FixRoundCommentWriter}). */
export async function upsertFixRoundComment(input: FixRoundCommentInput, log: Log): Promise<FixRoundCommentResult> {
  const gh = (args: string[]) => ghTextAsync(args);
  const target = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(input.prUrl);
  const prNumber = target ? Number(target[3]) : undefined;
  const fields = { pr_number: prNumber, site: input.round.site, head_sha: input.round.pushedHead, prior_head_sha: input.round.priorHead };
  try {
    if (!target) throw new Error(`not a GitHub pull request URL: ${input.prUrl}`);
    const repo = `repos/${target[1]}/${target[2]}`;
    let files: string[] | undefined;
    try {
      files = await fixRoundChangedFiles(input.cwd, input.round.priorHead, input.round.pushedHead);
    } catch (error) {
      // An unreadable diff still leaves the heads and the revert command worth posting; the row says "(unread)".
      log("fix.round_comment_files_unread", { ...fields, reason: String((error as Error)?.message ?? error).slice(0, 500) });
    }
    const existing = ownFixRoundComment(issueComments(await gh(["api", `${repo}/issues/${prNumber}/comments?per_page=100`, "--paginate", "--slurp"])));
    const body = renderFixRoundComment(input, files, existing?.body);
    const written = existing
      ? await gh(["api", "--method", "PATCH", `${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`])
      : await gh(["api", "--method", "POST", `${repo}/issues/${prNumber}/comments`, "-f", `body=${body}`]);
    const commentId = existing?.id ?? Number((JSON.parse(written) as { id?: unknown }).id);
    if (!Number.isSafeInteger(commentId) || commentId <= 0) throw new Error("the comment write returned no comment id");
    const action = existing ? "edited" : "created";
    log("fix.round_comment", { ...fields, comment_id: commentId, action, pushed_head_sha: input.round.pushedHead });
    return { action, commentId };
  } catch (error) {
    const reason = String((error as Error)?.message ?? error).slice(0, 500);
    log("fix.round_comment_failed", { ...fields, reason });
    return { action: "failed", reason };
  }
}
