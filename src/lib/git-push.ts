import { execFileSync } from "node:child_process";
import { assertLiveWriteAllowed } from "./live-write-guard.js";

/**
 * THE git-push LEAF — the single place this codebase pushes a branch to origin.
 *
 * WHY IT EXISTS. The other three outward operations already had a shared leaf that the
 * live-write guard could sit in: `ghPrCreateFillCommand` for `gh pr create`,
 * `ghIssueGateway().create` for `gh issue create`, and `ghPrMergeSquash`/`realArmDeps()`
 * for `gh pr merge`. `git push` had none — it was written out longhand at NINE call sites
 * across SEVEN top-level functions in two files, so the guard had to be repeated at each
 * one and six of those repetitions sat after a `spawnWorker` call inside commands that
 * take no injectable deps, making them unreachable from any offline test. A guard that
 * cannot be tested is a guard nobody has shown works.
 *
 * Routing every push through here means the boundary is guarded BY CONSTRUCTION: a new
 * call site cannot forget, because there is nothing to forget — it just calls this.
 * `test/live-write-guard.test.ts`'s structural test fails the build if a raw inlined git
 * push reappears anywhere in src/ outside this function. (That sentence deliberately does
 * NOT spell out the argv: the structural test matches on argv substrings, so quoting the
 * shape in a comment would recruit this comment into its own unguarded-call list.)
 *
 * The `exec` seam is the whole point of the extraction: a test drives the real guard and
 * the real argv construction with an injected recorder, no worker and no remote.
 */
export function defaultPushExec(file: string, args: string[], opts: { stdio: "inherit" | "ignore" }): void {
  execFileSync(file, args, opts);
}

/** Injected by tests to observe the argv without running git. */
export type PushExec = (file: string, args: string[], opts: { stdio: "inherit" | "ignore" }) => void;

/** Options per call site — every divergence between the nine sites is a parameter here,
 *  never a second implementation. `stdio` is "ignore" only at the two best-effort fix-rung
 *  sites; `setUpstream` is true only at spike.ts's push-fallback, which used `push -u`.
 *  `force` (W1-T1012) is true only at the two call sites that just amended the worktree's
 *  own last commit (appending the `Remudero-Task:` trailer, `appendTaskTrailerToCommit`,
 *  run-task.ts) AFTER that commit was already on origin — the amend rewrites the tip sha,
 *  so a plain push is a non-fast-forward rejection. Safe here specifically: this branch is
 *  `run-<id>-<epochMs>`, owned exclusively by this one run, so nobody else's work is ever
 *  discarded by the force. */
export interface PushRunBranchOpts {
  stdio?: "inherit" | "ignore";
  setUpstream?: boolean;
  force?: boolean;
  exec?: PushExec;
}

export function gitPushRunBranch(worktreePath: string, opts: PushRunBranchOpts = {}): void {
  // THE GUARD, at the leaf. Every one of the nine former call sites is covered by this
  // single line, and it fires wherever the helper is called from — including before a
  // worker spawn, which none of the old per-site guards could do.
  assertLiveWriteAllowed("git-push", "pushing the run branch to origin");
  const args = ["-C", worktreePath, "push"];
  if (opts.setUpstream) args.push("-u");
  if (opts.force) args.push("--force");
  args.push("origin", "HEAD");
  (opts.exec ?? defaultPushExec)("git", args, { stdio: opts.stdio ?? "inherit" });
}

/** Captures stdout from a git plumbing read/write. Injected by tests so the argv and the
 *  sequencing are observable without a repo or a remote. */
export type GitCapture = (file: string, args: string[]) => string;

export function defaultGitCapture(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export interface PushEmptyCommitOpts {
  capture?: GitCapture;
  exec?: PushExec;
}

/**
 * Push an EMPTY commit onto `branch`, minting a fresh head sha — the ABSENT-check-suite
 * remedy (W1-T186 follow-up). Returns the new sha.
 *
 * WHY IT LIVES HERE. This is a `git push`, so it belongs at THE leaf for the same reason
 * every other push does: the guard above is the boundary, and
 * `test/live-write-guard.test.ts`'s structural test fails the build on a raw inlined push
 * anywhere else in src/. It is not a new outward path — it is the existing one, called with
 * a different ref.
 *
 * WHY PLUMBING RATHER THAN `commit --allow-empty`. The only caller is the sweep, which runs
 * inside the DAEMON'S OWN CHECKOUT. A `git commit` there would move that checkout's HEAD and
 * dirty the very tree `checkCliFreshness` gates on — the exact class of defect W1-T191 exists
 * to remove. `commit-tree` against the head's OWN tree writes a commit object to the object
 * database and touches no working tree, no index, and no local branch (the same discipline
 * `feedback-landing.ts` already uses). The push is a FAST-FORWARD — the new commit's parent is
 * the current head — so it is never a force-push and can never discard someone else's work.
 */
export function gitPushEmptyCommit(
  repoDir: string,
  branch: string,
  headSha: string,
  message: string,
  opts: PushEmptyCommitOpts = {},
): string {
  assertLiveWriteAllowed("git-push", `pushing an empty commit to ${branch} to mint a fresh head sha`);
  const capture = opts.capture ?? defaultGitCapture;
  // The head's OWN tree — so the commit is empty by construction, not by a flag.
  const treeSha = capture("git", ["-C", repoDir, "rev-parse", `${headSha}^{tree}`]).trim();
  const newSha = capture("git", ["-C", repoDir, "commit-tree", treeSha, "-p", headSha, "-m", message]).trim();
  (opts.exec ?? defaultPushExec)("git", ["-C", repoDir, "push", "origin", `${newSha}:refs/heads/${branch}`], {
    stdio: "ignore",
  });
  return newSha;
}
