import { ghJsonAsync } from "./github-transport.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";
import { parseOwnerRepoFromRemoteUrl } from "./onboard/inventory.js";

export interface CommentCompressionFinding { file: string; comments: number }
export const COMMENT_COMPRESSION_SIGNAL_LINES = 250;
export const commentCompressionOrigin = (file: string): string => `comment-compression:${file}`;

/** Nominate one largest untracked maintenance subject; this does not adjudicate its PR. */
export function nextCommentCompression(findings: readonly CommentCompressionFinding[], held: ReadonlySet<string>): CommentCompressionFinding | undefined {
  return findings.filter(f => f.comments > COMMENT_COMPRESSION_SIGNAL_LINES && !held.has(commentCompressionOrigin(f.file)))
    .sort((a, b) => b.comments - a.comments || a.file.localeCompare(b.file))[0];
}


/** Complete, awaited open-PR pages; unread data cannot authorize a duplicate maintenance filing. */
export async function readGateFollowupOrigins(root: string): Promise<string[]> {
  const remote = await hostWorktreeGitAsync(root, ["remote", "get-url", "origin"]);
  const repo = parseOwnerRepoFromRemoteUrl(remote.trim());
  if (!repo) throw new Error("gate follow-ups: origin does not identify a GitHub repository");
  const pages = await ghJsonAsync(["api", "--paginate", "--slurp", `repos/${repo.owner}/${repo.repo}/pulls?state=open&per_page=100`]);
  if (!Array.isArray(pages) || pages.length === 0 || pages.some(page => !Array.isArray(page))) {
    throw new Error("gate follow-ups: open-PR page corpus is unreadable");
  }
  const origins = new Set<string>();
  for (const page of pages) for (const pr of page) {
    if (!pr || typeof pr !== "object" || !(typeof pr.body === "string" || pr.body === null)) {
      throw new Error("gate follow-ups: open-PR body is unreadable");
    }
    for (const match of (pr.body ?? "").matchAll(/(?:comment-compression:[^\s"'`]+|expiring-fixture:test\/[^\s"'`]+\.test\.ts)/g)) origins.add(match[0]);
  }
  return [...origins];
}
