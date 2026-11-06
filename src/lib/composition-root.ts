import { execFileSync } from "node:child_process";
import { hostWorktreeGit, hostWorktreeGitAsync } from "./worktree-git.js";
import { realArmDeps, type ArmDeps } from "./arm-auto-merge.js";
import { realDeployDeps, type DeployDeps, type RealDeployOpts } from "./deployer.js";
import { realSharedPauseGitDeps, type SharedPauseGitDeps } from "./fleet-control.js";
import { loadConfig, type Config } from "./config.js";
import {
  realGitRemoteDeps,
  realOnboardFsDeps,
  realOnboardGhGateway,
  resolveTargetOwnerRepo,
  type OnboardFsDeps,
  type OnboardGhGateway,
} from "./onboard/inventory.js";
import {
  realReconFsDeps,
  realReconGhGateway,
  type ReconFsDeps,
  type ReconGhGateway,
} from "./onboard/recon.js";
import { realSessionFsDeps, type SessionFsDeps } from "./onboard/session.js";
import {
  realSynthesizeFsDeps,
  realSynthesizeGhGateway,
  realSynthesizeGitGateway,
  type SynthesizeFsDeps,
  type SynthesizeGhGateway,
  type SynthesizeGitGateway,
} from "./onboard/synthesize.js";

export interface ReviewWorktreeDeps<Head = string, Effect = void> {
  fetch: (repoDir: string, prNumber: number, headSha?: string) => Effect;
  addWorktree: (repoDir: string, worktreePath: string, revision: string) => Effect;
  revParseHead: (worktreePath: string) => Head;
  removeWorktree?: (repoDir: string, worktreePath: string) => Effect;
}

/** Same creation and exact-head policy, with awaited Git on the daemon's path. */
export function realReviewWorktreeAsync(): ReviewWorktreeDeps<string | Promise<string>, void | Promise<void>> {
  return realReviewWorktree(
    async (_cmd, args) => hostWorktreeGitAsync(args[1], args.slice(2)),
    async (path) => (await hostWorktreeGitAsync(path, ["rev-parse", "HEAD"])).trim(),
  );
}

type ReviewGitExec = (cmd: string, args: string[], options: { stdio: "pipe" }) => string | Buffer;

type ReviewGitAsyncExec = (cmd: string, args: string[], options: { stdio: "pipe" }) => Promise<string | Buffer>;

function realReviewWorktree(exec?: ReviewGitExec): ReviewWorktreeDeps;
function realReviewWorktree(exec: ReviewGitAsyncExec, readHead: (path: string) => Promise<string>): ReviewWorktreeDeps<string | Promise<string>, void | Promise<void>>;
function realReviewWorktree(
  exec: ReviewGitExec | ReviewGitAsyncExec = execFileSync,
  readHead: (path: string) => string | Promise<string> =
    (worktreePath) => hostWorktreeGit(worktreePath, ["rev-parse", "HEAD"]).trim(),
): ReviewWorktreeDeps<string | Promise<string>, void | Promise<void>> {
  return {
    fetch: (repoDir, prNumber, headSha) => {
      const fetchRef = (ref: string) =>
        exec("git", ["-C", repoDir, "fetch", "--quiet", "--no-write-fetch-head", "origin", ref], { stdio: "pipe" });
      const recover = (error: unknown): void | Promise<void> => {
        // GitHub may omit the pull ref while still serving its exact head SHA (#11708).
        if (headSha === undefined || !/couldn't find remote ref/.test(String((error as { stderr?: unknown }).stderr ?? (error as Error)?.message ?? error))) throw error;
        try {
          const fallback = fetchRef(headSha);
          // A failed fallback preserves the original missing-pull-ref failure in both drivers.
          if (fallback instanceof Promise) return fallback.then(() => {}).catch(() => { throw error; });
        } catch { throw error; }
      };
      try {
        const fetched = fetchRef(`refs/pull/${prNumber}/head`);
        if (fetched instanceof Promise) return fetched.then(() => {}).catch(recover);
      } catch (error) {
        // Recovery fetches the exact SHA or rethrows the original missing-pull-ref failure.
        return recover(error);
      }
    },
    addWorktree: (repoDir, worktreePath, revision) => {
      const added = exec("git", ["-C", repoDir, "worktree", "add", "--detach", worktreePath, revision], { stdio: "pipe" });
      if (added instanceof Promise) return added.then(() => {});
    },
    revParseHead: readHead,
  };
}

export interface CompositionRootConfig {
  repoRoot: string;
  loadConfig?: typeof loadConfig;
  reviewGitExec?: ReviewGitExec;
}

export interface ComposedRealGraph {
  arm: ArmDeps;
  deployFor: (opts: RealDeployOpts) => DeployDeps;
  onboard: {
    fs: OnboardFsDeps;
    gh: OnboardGhGateway;
    resolveOwnerRepo: typeof resolveTargetOwnerRepo;
  };
  recon: {
    fs: ReconFsDeps;
    gh: ReconGhGateway;
  };
  reviewWorktree: ReviewWorktreeDeps;
  session: {
    fs: SessionFsDeps;
  };
  sharedPauseGit: SharedPauseGitDeps;
  synthesize: {
    fs: SynthesizeFsDeps;
    git: SynthesizeGitGateway;
    gh: SynthesizeGhGateway;
  };
}

export function composeRealDeps(config: CompositionRootConfig): ComposedRealGraph {
  const loadConfigImpl = config.loadConfig ?? loadConfig;
  return {
    arm: realArmDeps(loadConfigImpl),
    deployFor: realDeployDeps,
    onboard: {
      fs: realOnboardFsDeps,
      gh: realOnboardGhGateway(),
      resolveOwnerRepo: (targetDir, deps = realGitRemoteDeps) => resolveTargetOwnerRepo(targetDir, deps),
    },
    recon: {
      fs: realReconFsDeps,
      gh: realReconGhGateway(),
    },
    reviewWorktree: realReviewWorktree(config.reviewGitExec),
    session: {
      fs: realSessionFsDeps,
    },
    sharedPauseGit: realSharedPauseGitDeps(config.repoRoot),
    synthesize: {
      fs: realSynthesizeFsDeps,
      git: realSynthesizeGitGateway(),
      gh: realSynthesizeGhGateway(),
    },
  };
}
