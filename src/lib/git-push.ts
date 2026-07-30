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
 *  sites; `setUpstream` is true only at spike.ts's push-fallback, which used `push -u`. */
export interface PushRunBranchOpts {
  stdio?: "inherit" | "ignore";
  setUpstream?: boolean;
  exec?: PushExec;
}

export function gitPushRunBranch(worktreePath: string, opts: PushRunBranchOpts = {}): void {
  // THE GUARD, at the leaf. Every one of the nine former call sites is covered by this
  // single line, and it fires wherever the helper is called from — including before a
  // worker spawn, which none of the old per-site guards could do.
  assertLiveWriteAllowed("git-push", "pushing the run branch to origin");
  const args = ["-C", worktreePath, "push"];
  if (opts.setUpstream) args.push("-u");
  args.push("origin", "HEAD");
  (opts.exec ?? defaultPushExec)("git", args, { stdio: opts.stdio ?? "inherit" });
}
