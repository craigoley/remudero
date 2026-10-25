import { posix } from "node:path";
import { hostWorktreeGit } from "./worktree-git.js";

type PlanBaseGit = (args: readonly string[]) => string;

/** Read only from a verified, pinned commit. Git failures are never evidence of absence. */
export function readPlanBase(
  repoDir: string,
  ref: string,
  path: string,
  git: PlanBaseGit = (args) => hostWorktreeGit(repoDir, args, {
    timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 1 << 26,
  }),
): { commit: string; raw: string; absent: boolean } {
  if (!path || posix.isAbsolute(path) || posix.normalize(path) !== path ||
      path === ".." || path.startsWith("../") || /[\0\\]/.test(path)) {
    throw new Error("base plan requires a normalized repository-relative path");
  }
  const commit = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("invalid base commit identity");
  // Literal pathspec: a plan path containing Git wildcard characters must still name one entry.
  const listing = git(["ls-tree", "-z", commit, "--", `:(literal)${path}`]);
  if (listing === "") return { commit, raw: "[]\n", absent: true };
  const entry = /^(\d{6}) (\w+) ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(listing);
  if (!entry || entry[4] !== path) throw new Error("invalid base plan tree entry");
  if (!/^(100644|100755)$/.test(entry[1]) || entry[2] !== "blob") {
    throw new Error("base plan must be a regular blob");
  }
  return { commit, raw: git(["show", `${commit}:${path}`]), absent: false };
}
