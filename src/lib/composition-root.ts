import { execFileSync } from "node:child_process";
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
  fetch: (repoDir: string, prNumber: number) => void;
  addWorktree: (repoDir: string, worktreePath: string, revision: string) => void;
  revParseHead: (worktreePath: string) => string;
  removeWorktree?: (repoDir: string, worktreePath: string) => void;
}

type ReviewGitExec = (cmd: string, args: string[], options: { stdio: "pipe" }) => string | Buffer;

function realReviewWorktree(exec: ReviewGitExec = execFileSync): ReviewWorktreeDeps {
  return {
    fetch: (repoDir, prNumber) => {
      exec(
        "git",
        ["-C", repoDir, "fetch", "--quiet", "--no-write-fetch-head", "origin", `refs/pull/${prNumber}/head`],
        { stdio: "pipe" },
      );
    },
    addWorktree: (repoDir, worktreePath, revision) => {
      exec("git", ["-C", repoDir, "worktree", "add", "--detach", worktreePath, revision], { stdio: "pipe" });
    },
    revParseHead: (worktreePath) =>
      exec("git", ["-C", worktreePath, "rev-parse", "HEAD"], { stdio: "pipe" }).toString().trim(),
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
