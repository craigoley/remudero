import { execFileSync } from "node:child_process";
import { hostWorktreeGit } from "./worktree-git.js";
import { realArmDeps, type ArmDeps } from "./arm-auto-merge.js";
import { realDeployDeps, type DeployDeps, type RealDeployOpts } from "./deployer.js";
import { realSharedPauseGitDeps, type SharedPauseGitDeps } from "./fleet-control.js";
import { loadConfig, type Config } from "./config.js";
import {
  realGitRemoteDeps,
  realOnboardFsDeps,
  realOnboardGhGateway,
  resolveTargetOwnerRepo,
  type GitRemoteDeps,
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

export interface ReviewWorktreeDeps {
  fetch: (repoDir: string, prNumber: number, headSha?: string) => void;
  addWorktree: (repoDir: string, worktreePath: string, revision: string) => void;
  revParseHead: (worktreePath: string) => string;
  removeWorktree?: (repoDir: string, worktreePath: string) => void;
}

type ReviewGitExec = (cmd: string, args: string[], options: { stdio: "pipe" }) => string | Buffer;

function realReviewWorktree(exec: ReviewGitExec = execFileSync): ReviewWorktreeDeps {
  return {
    fetch: (repoDir, prNumber, headSha) => {
      const fetchRef = (ref: string) =>
        exec("git", ["-C", repoDir, "fetch", "--quiet", "--no-write-fetch-head", "origin", ref], { stdio: "pipe" });
      try {
        fetchRef(`refs/pull/${prNumber}/head`);
      } catch (error) {
        // #11708 (2026-10-14): GitHub served refs/pull/N/merge but never created refs/pull/N/head for a REST-opened PR,
        // so every review materialized nothing and posted a keyword-only FAIL. The head commit is still fetchable by sha.
        if (headSha === undefined || !/couldn't find remote ref/.test(String((error as { stderr?: unknown }).stderr ?? (error as Error)?.message ?? error))) throw error;
        try {
          fetchRef(headSha);
        } catch {
          throw error; // the sha is not served either: the missing pull ref stays the named failure (W1-T2751)
        }
      }
    },
    addWorktree: (repoDir, worktreePath, revision) => {
      exec("git", ["-C", repoDir, "worktree", "add", "--detach", worktreePath, revision], { stdio: "pipe" });
    },
    // W1-T6122: the tree is the PR head's, so its read is the leaf's (the seam keeps fetch/add).
    revParseHead: (worktreePath) => hostWorktreeGit(worktreePath, ["rev-parse", "HEAD"]).trim(),
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
  gitRemote: GitRemoteDeps;
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
    gitRemote: realGitRemoteDeps,
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
