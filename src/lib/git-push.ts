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
  /**
   * W1-T2610 — THE POST-CONDITION. The sha the CALLER believes it is landing (a fix rung
   * passes the sha it just committed). OPTIONAL and additive: omitted, this function is
   * byte-identical to its pre-W1-T2610 self — the seven non-fix call sites that never pass
   * this stay untouched.
   *
   * WHY THIS CATCHES THE ZERO-REFS-PUSHED CASE A NON-FAST-FORWARD CHECK CANNOT (the incident
   * behind DAEMON-1788016810368 / PR #3261): when a fix round's own worktree gets rewound
   * back to origin's tip BETWEEN the commit and this push, the ref this push actually sends
   * is already on the remote — `git push` sees a legal, zero-ref fast-forward and exits 0
   * with nothing to report, especially with `stdio: "ignore"` (the two fix-rung sites this
   * option exists for). A fast-forward check never fires there; it isn't a disagreement, it's
   * an agreement on the WRONG sha. So this never inspects git's push output at all — it reads
   * the worktree's OWN head with `capture` (the same seam {@link gitPushEmptyCommit} uses,
   * never `stdio`, which the fix-rung sites throw away) right before the push runs, and
   * compares that reading against `expectedHeadSha`. A mismatch means the local ref already
   * drifted off the sha the caller believes it is landing — pushing it would just move the
   * WRONG commit (or move nothing), so this raises instead of pushing.
   */
  expectedHeadSha?: string;
  /** Injected by tests to observe the pre-push HEAD read without a real repo. Defaults to
   *  {@link defaultGitCapture}. Only consulted when `expectedHeadSha` is supplied. */
  capture?: GitCapture;
}

export function gitPushRunBranch(worktreePath: string, opts: PushRunBranchOpts = {}): void {
  // THE GUARD, at the leaf. Every one of the nine former call sites is covered by this
  // single line, and it fires wherever the helper is called from — including before a
  // worker spawn, which none of the old per-site guards could do.
  assertLiveWriteAllowed("git-push", "pushing the run branch to origin");
  if (opts.expectedHeadSha !== undefined) {
    // THE POST-CONDITION READ (W1-T2610) — see `PushRunBranchOpts.expectedHeadSha`'s own doc
    // for why this is a pre-push local read rather than trusting the push's own exit code or
    // output. `capture`, never `stdio`: the two fix-rung call sites this guards run with
    // `stdio: "ignore"`, so this must hold with the push's own output thrown away.
    const capture = opts.capture ?? defaultGitCapture;
    const observedHeadSha = capture("git", ["-C", worktreePath, "rev-parse", "HEAD"]).trim();
    if (observedHeadSha !== opts.expectedHeadSha) {
      throw new LanePushForeignHeadError(
        `refusing to push the run branch at ${worktreePath}: it was asked to land ` +
          `${opts.expectedHeadSha} but the worktree's HEAD now reads ${observedHeadSha} — the local ` +
          `ref moved between the commit and this push, so pushing now would either transfer zero refs ` +
          `(a legal, silent fast-forward no-op if HEAD was rewound back to the remote tip) or push the ` +
          `wrong commit entirely; nothing was pushed`,
        worktreePath,
        opts.expectedHeadSha,
      );
    }
  }
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
 * Raised when a lane's push is refused because the branch is not where the lane believed it
 * was (W1-T1288). `expectedHeadSha` is the head the lane carried a lease for — the value it
 * read before minting `newSha` — never the value observed on the remote, because a refused
 * push must never have to know what actually happened out there; that is an operator's read,
 * not this leaf's. See the module header on {@link gitPushEmptyCommit} for the two shapes
 * this covers: a lease git itself rejects, and a lease git elided.
 */
export class LanePushForeignHeadError extends Error {
  override name = "LanePushForeignHeadError";
  constructor(
    message: string,
    public readonly branch: string,
    public readonly expectedHeadSha: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
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
 * WHY PLUMBING RATHER THAN `commit --allow-empty`. The caller (the sweep's post-fix
 * re-verification rung) runs inside the DAEMON'S OWN CHECKOUT. A `git commit` there would move
 * that checkout's HEAD and dirty the very tree `checkCliFreshness` gates on — the exact class
 * of defect W1-T191 exists to remove. `commit-tree` against the head's OWN tree writes a commit
 * object to the object database and touches no working tree, no index, and no local branch (the
 * same discipline `feedback-landing.ts` already uses).
 *
 * W1-T1288 — THE LEASE, AND WHY A FAST-FORWARD PARENT IS NOT ENOUGH ON ITS OWN. The new
 * commit's parent is `headSha`, so the push IS a fast-forward from the head this call was
 * TOLD about — but `branch` is the PR's OWN branch (`sweepPostFixReverification`'s `redrive`
 * passes `pr.headRefName`), a ref other lanes push too, and `headSha` can go stale between the
 * caller's read and this push. A plain `newSha:refs/heads/branch` push has no way to express
 * that staleness: git's non-fast-forward check only fires when the ref EXISTS and disagrees:
 * the incident this task is filed against (oper#lane-push-clobbered-a-shared-branch-2026-08-23,
 * PR #2668) hit the window where the ref was momentarily ABSENT, so the plain push reported
 * `[new branch]` and silently replaced a concurrent lane's work rather than rejecting. So this
 * pushes with `--force-with-lease=refs/heads/<branch>:<headSha>` — a PRECONDITION, not a
 * permission: it requires the remote ref to be exactly at `headSha` right now, and refuses
 * (never creates, never replaces) the moment that stops being true, including while the ref is
 * absent (an absent ref never equals a non-empty `headSha`).
 *
 * THE MEASURED ELISION TRAP (`task-id-reservation.ts`'s header, reused here rather than
 * re-derived): a lease git can ELIDE still exits 0 without ever checking it, so a caller that
 * trusts the exit code alone can read a lease-skipped push as a lease-honoured one. This
 * function does not: after the push returns, it re-reads the remote ref
 * (`git ls-remote origin refs/heads/<branch>`) and throws {@link LanePushForeignHeadError}
 * unless it now reads exactly `newSha` — so an elided or otherwise-wrong result is never
 * mistaken for success.
 *
 * A REFUSAL RESTORES NOTHING. Whether the lease is rejected by git or the post-push read
 * disagrees, this function only throws — it never retries, never re-reads a "current" head to
 * push again, and never force-pushes a second time. The remote ref is left exactly as it was
 * found; deciding which lane's work survives a real clobber stays an operator judgement
 * (design note iv), not something this leaf attempts.
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
  const exec = opts.exec ?? defaultPushExec;
  const ref = `refs/heads/${branch}`;
  // The head's OWN tree — so the commit is empty by construction, not by a flag.
  const treeSha = capture("git", ["-C", repoDir, "rev-parse", `${headSha}^{tree}`]).trim();
  const newSha = capture("git", ["-C", repoDir, "commit-tree", treeSha, "-p", headSha, "-m", message]).trim();
  try {
    exec("git", ["-C", repoDir, "push", `--force-with-lease=${ref}:${headSha}`, "origin", `${newSha}:${ref}`], {
      stdio: "ignore",
    });
  } catch (err) {
    // Rejected non-fast-forward, rejected lease, or the ref moved/vanished under the lease —
    // git's exit code is the whole signal here, and every one of those cases means the same
    // thing to this caller: refuse, touch nothing else, let the caller decide what's next.
    throw new LanePushForeignHeadError(
      `refused to push ${branch}: the branch is no longer at the believed head ${headSha} ` +
        `(a concurrent writer moved or removed it) — nothing was pushed`,
      branch,
      headSha,
      { cause: err },
    );
  }
  // THE ELISION CHECK (see the doc comment above): trust the ref's ACTUAL resulting value,
  // never the exit code alone.
  const observed = capture("git", ["-C", repoDir, "ls-remote", "origin", ref]).trim().split(/\s+/)[0];
  if (observed !== newSha) {
    throw new LanePushForeignHeadError(
      `push to ${branch} reported success but the remote ref reads ${observed ? observed : "<absent>"}, ` +
        `not the pushed ${newSha} — a lease git elided rather than checked; treating this as a refusal`,
      branch,
      headSha,
    );
  }
  return newSha;
}
