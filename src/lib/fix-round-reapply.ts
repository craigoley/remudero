import { hostWorktreeGitAsync } from "./worktree-git.js";

/**
 * A FIX ROUND WHOSE BRANCH MOVED WHILE ITS WORKER RAN MERGES THE NEW TIP AND PUSHES ONCE.
 *
 * #10497 guards the tip a round STARTED from. A fleet refresh, another fix lane or an operator push
 * can still move the remote branch while the worker runs; the round's leased push is then refused
 * and its finished, correct commit was thrown away (about 8 times since 2026-10-05).
 *
 * When the remote tip DESCENDS from the round's lease base, the round merges that tip into its own
 * commit (merge only — never a rebase or a force) and the caller pushes once more through the same
 * prechecks, leased on the new tip. A conflict, a tip that rewrote the base's history, or a tip that
 * cannot be read keeps today's refusal, so a round never overwrites a commit it did not see.
 */

export type FixRoundReapplyPlan =
  | { action: "none"; reason: string }
  | { action: "reapply"; remoteTip: string; reason: string }
  | { action: "refuse"; reason: string };

export interface FixRoundReapplyInput {
  leaseBaseSha: string;
  committedSha: string;
  remoteTip: string | undefined;
  isAncestor: (ancestor: string, descendant: string) => boolean;
}

export function planFixRoundReapply(input: FixRoundReapplyInput): FixRoundReapplyPlan {
  const { leaseBaseSha, committedSha, remoteTip } = input;
  if (remoteTip === undefined || remoteTip === "") return { action: "refuse", reason: "the remote tip was unreadable" };
  if (remoteTip === committedSha) return { action: "none", reason: "the remote already holds this round's commit" };
  if (remoteTip === leaseBaseSha) return { action: "none", reason: "the remote did not move; the push failed for another reason" };
  let descends: boolean;
  try {
    descends = input.isAncestor(leaseBaseSha, remoteTip);
  } catch (error) {
    return { action: "refuse", reason: `ancestry unreadable: ${String(error)}` };
  }
  if (!descends) {
    return { action: "refuse",
      reason: `the remote tip ${remoteTip.slice(0, 7)} rewrote ${leaseBaseSha.slice(0, 7)}'s history` };
  }
  return { action: "reapply", remoteTip,
    reason: `the branch moved ${leaseBaseSha.slice(0, 7)} -> ${remoteTip.slice(0, 7)} while the round ran` };
}

export interface FixRoundReapplyPorts {
  remoteTip: (wt: string, branch: string) => Promise<string | undefined>;
  headSha: (wt: string) => Promise<string>;
  /** Throws for unreadable ancestry; false only for git's "not an ancestor" answer. */
  isAncestor: (wt: string, ancestor: string, descendant: string) => Promise<boolean>;
  /** Merges the already-fetched `tip` into HEAD; aborts and reports on any conflict. */
  merge: (wt: string, branch: string, tip: string) => Promise<{ merged: true; head: string } | { merged: false; reason: string }>;
}

export type FixRoundReapplyResult =
  | { reapplied: true; mergedHeadSha: string; remoteTip: string }
  | { reapplied: false; reason: string };

/** Decides and, when safe, performs the merge. Logs `fix.round_reapplied` or `fix.round_reapply_refused`. */
export async function reapplyFixRoundOnMovedTip(
  args: { wt: string; branch: string; leaseBaseSha: string; committedSha: string },
  ports: FixRoundReapplyPorts,
  log: (step: string, extra?: Record<string, unknown>) => void,
): Promise<FixRoundReapplyResult> {
  const base = { branch: args.branch, lease_base_sha: args.leaseBaseSha, committed_sha: args.committedSha };
  const refuse = (reason: string, extra: Record<string, unknown> = {}): FixRoundReapplyResult => {
    log("fix.round_reapply_refused", { ...base, ...extra, reason });
    return { reapplied: false, reason };
  };
  let remoteTip: string | undefined;
  try {
    remoteTip = await ports.remoteTip(args.wt, args.branch);
  } catch (error) {
    return refuse(`the remote tip was unreadable: ${String(error)}`);
  }
  // The planner is synchronous; ancestry is read once here and handed to it as a fixed answer.
  let ancestry: boolean | Error | undefined;
  if (remoteTip !== undefined && remoteTip !== "" && remoteTip !== args.committedSha && remoteTip !== args.leaseBaseSha) {
    ancestry = await ports.isAncestor(args.wt, args.leaseBaseSha, remoteTip).catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)));
  }
  const plan = planFixRoundReapply({ leaseBaseSha: args.leaseBaseSha, committedSha: args.committedSha, remoteTip,
    isAncestor: () => { if (ancestry instanceof Error) throw ancestry; return ancestry === true; } });
  if (plan.action === "none") return { reapplied: false, reason: plan.reason };
  if (plan.action === "refuse") return refuse(plan.reason, remoteTip === undefined ? {} : { remote_tip: remoteTip });
  let head: string;
  try {
    head = await ports.headSha(args.wt);
  } catch (error) {
    return refuse(`the round's head was unreadable: ${String(error)}`, { remote_tip: plan.remoteTip });
  }
  if (head !== args.committedSha) {
    return refuse(`the worktree head ${head.slice(0, 7)} is not this round's commit`, { remote_tip: plan.remoteTip });
  }
  const merged = await ports.merge(args.wt, args.branch, plan.remoteTip).catch((error: unknown) =>
    ({ merged: false as const, reason: `merge failed: ${String(error)}` }));
  if (!merged.merged) return refuse(merged.reason, { remote_tip: plan.remoteTip });
  log("fix.round_reapplied", { ...base, remote_tip: plan.remoteTip, merged_head_sha: merged.head, reason: plan.reason });
  return { reapplied: true, mergedHeadSha: merged.head, remoteTip: plan.remoteTip };
}

/** The host git behind {@link reapplyFixRoundOnMovedTip}: merge only, aborted on any conflict. */
export const realFixRoundReapplyPorts: FixRoundReapplyPorts = {
  // Fetched, not only listed: ancestry and the merge below both need the tip's objects locally.
  remoteTip: async (wt, branch) => {
    await hostWorktreeGitAsync(wt, ["fetch", "origin", `refs/heads/${branch}`]);
    return (await hostWorktreeGitAsync(wt, ["rev-parse", "FETCH_HEAD"])).trim() || undefined;
  },
  headSha: async (wt) => (await hostWorktreeGitAsync(wt, ["rev-parse", "HEAD"])).trim(),
  isAncestor: async (wt, ancestor, descendant) => {
    try {
      await hostWorktreeGitAsync(wt, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return false;
      throw error;
    }
  },
  merge: async (wt, _branch, tip) => {
    try {
      await hostWorktreeGitAsync(wt, ["merge", "--no-edit", tip]);
    } catch (error) {
      const aborted = await hostWorktreeGitAsync(wt, ["merge", "--abort"]).then(() => "", (abortError: unknown) =>
        `; merge --abort also failed: ${String((abortError as Error)?.message ?? abortError).slice(0, 200)}`);
      return { merged: false, reason: `merging ${tip.slice(0, 7)} did not complete cleanly: ${String((error as Error)?.message ?? error).slice(0, 300)}${aborted}` };
    }
    return { merged: true, head: (await hostWorktreeGitAsync(wt, ["rev-parse", "HEAD"])).trim() };
  },
};
