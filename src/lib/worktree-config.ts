import { setTimeout as sleep } from "node:timers/promises";

export type WorktreeConfigGit = (args: string[]) => Promise<string>;

/** BACKSTOP: three short attempts cover a peer's atomic config write, not a permanently held lock. */
export const WORKTREE_CONFIG_LOCK_ATTEMPTS = 3;

function isConfigLockContention(error: unknown): boolean {
  const detail = error as { stderr?: unknown; message?: unknown } | null;
  return /could not lock config file [^\r\n]+: File exists(?:\r?\n|$)/i.test(
    `${String(detail?.stderr ?? "")}\n${String(detail?.message ?? error)}`,
  );
}

/** Enable the shared migration before per-worktree writes. Only an absent key (exit 1) permits
 * migration; unreadable config stays refused. A peer's transient config lock is retried with
 * timers, never deleted. Re-read each time: another process may already have enabled it. */
export async function ensureWorktreeConfigEnabledAsync(
  git: WorktreeConfigGit,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      if ((await git(["config", "--local", "--get", "extensions.worktreeConfig"])).trim() === "true") return;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 1) throw error;
    }
    try {
      await git(["config", "--local", "extensions.worktreeConfig", "true"]);
      return;
    } catch (error) {
      if (attempt >= WORKTREE_CONFIG_LOCK_ATTEMPTS || !isConfigLockContention(error)) throw error;
      await wait(100 * attempt);
    }
  }
}
