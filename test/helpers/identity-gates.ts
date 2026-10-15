/**
 * W1-T9583 — both identity gates, judged the way each one judges a pushed head: head-identity-gate's own
 * readers (`readHeadCommitMessage`, `changedPathsAtHead`) and predicate, and worker-branch-shape's full
 * check-mode pipeline, run on a fresh checkout of `branch` from `originDir`. No verdict is re-implemented
 * here, so a lane whose head one gate would refuse in CI or preflight is refused by this helper too.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

import { gitRepo } from "./git-repo.js";

const SCRIPTS = fileURLToPath(new URL("../../scripts/", import.meta.url));

export interface GateVerdict {
  ok: boolean;
  message: string;
}

export interface IdentityGateVerdicts {
  headIdentity: GateVerdict;
  branchShape: GateVerdict;
  headMessage: string;
}

export async function identityGateVerdicts(originDir: string, branch: string): Promise<IdentityGateVerdicts> {
  // `scripts/**` sits outside tsconfig's `include` (TS7016), so both gates are reached by dynamic import.
  const identity = (await import(pathToFileURL(join(SCRIPTS, "head-identity-gate.mjs")).href)) as {
    readHeadCommitMessage: (worktreePath: string) => string | undefined;
    changedPathsAtHead: (worktreePath: string, baseRef: string) => string[] | undefined;
    evaluateHeadIdentityGate: (input: { headCommitMessage: string; headRef: string; changedPaths?: readonly string[] }) => GateVerdict;
  };
  const shape = (await import(pathToFileURL(join(SCRIPTS, "worker-branch-shape.mjs")).href)) as {
    resolveMergeBase: (worktreePath: string, baseRef: string) => string | undefined;
    commitMessagesSinceBase: (worktreePath: string, mergeBase: string | undefined) => string;
    addedFilesSinceBase: (worktreePath: string, mergeBase: string | undefined) => string[];
    changedFilesSinceBase: (worktreePath: string, mergeBase: string | undefined) => string[];
    declaredTaskIds: (worktreePath: string) => string[];
    evaluateWorkerBranchShape: (input: Record<string, unknown>) => GateVerdict;
  };
  const pushed = gitRepo({ cloneFrom: originDir, kind: "identity-gate-head" });
  try {
    pushed.git("checkout", "--quiet", branch);
    const headMessage = identity.readHeadCommitMessage(pushed.dir) ?? "";
    const headIdentity = identity.evaluateHeadIdentityGate({
      headCommitMessage: headMessage,
      headRef: branch,
      changedPaths: identity.changedPathsAtHead(pushed.dir, "main"),
    });
    const base = shape.resolveMergeBase(pushed.dir, "origin/main");
    const branchShape = shape.evaluateWorkerBranchShape({
      headRef: branch,
      commitMessages: shape.commitMessagesSinceBase(pushed.dir, base),
      addedFiles: shape.addedFilesSinceBase(pushed.dir, base),
      readFile: () => undefined,
      changedFiles: shape.changedFilesSinceBase(pushed.dir, base),
      declaredTaskIds: shape.declaredTaskIds(pushed.dir),
    });
    return { headIdentity, branchShape, headMessage };
  } finally {
    pushed.cleanup();
  }
}
