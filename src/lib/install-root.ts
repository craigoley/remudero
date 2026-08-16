/**
 * lib/install-root.ts — the daemon's DEDICATED install checkout (W1-T924, fb-1784913390318-1fcb63).
 *
 * THE DEFECT THIS CLOSES. `deployRunCommand` used to pass `installPath: repoRoot` to the deploy
 * supervisor — `repoRoot` is `resolveRepoRoot(argv, process.cwd())`, the toplevel of WHATEVER
 * CHECKOUT THE SUPERVISOR'S launchd UNIT HAPPENED TO BE POINTED AT. On the mini that is the
 * operator's own WIP tree, so the supervisor's `git -C <path> ...` fast-forward ran against the
 * SAME checkout the operator edits by hand. `deployer.ts`'s own field doc already named the
 * conflation: "the daemon's git checkout to fast-forward (its install path / repoRoot)" — two
 * different nouns joined by a slash, with nothing anywhere resolving the first one.
 *
 * THIS MODULE OWNS EXACTLY ONE NOUN: the install root — where it lives (resolved from config,
 * never cwd — see {@link resolveInstallRoot}), whether it is fit to deploy into ({@link
 * inspectInstallRoot}), the separation invariant that makes "the install tree is clean by
 * construction" checkable ({@link checkInstallSeparation}), and how to provision it
 * (PROVISION-OR-REFUSE, never deploy-into-whatever-is-there — {@link provisionInstallRoot}).
 * `deployer.ts` is UNCHANGED: `DeployDeps.installPath` was already an injected option: the
 * defect was entirely in what the CALLER passed, not in what the deployer did with it.
 *
 * WHY A CLONE, NEVER A LINKED WORKTREE (design note iii): `checkCliFreshness` (self-sync.ts,
 * W1-T452/#1731) returns `{status: "worktree"}` for any linked worktree and skips both its
 * refusals AND its sync — an install-as-worktree would be a tree that freshness path silently
 * declines to reason about. A clone also cannot be moved by anything happening in the operator's
 * own `.git` (a linked worktree shares one `.git` with its origin checkout).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** The subset of {@link Config} this module reads — structural, to avoid a config.ts import
 *  cycle (config.ts owns the field; this module only ever reads it). */
export interface InstallRootConfigLike {
  root: string;
  installRoot?: string;
}

/**
 * `config.installRoot ?? join(config.root, "daemon-install")` (design note ii). NEVER a
 * hardcoded absolute path — `config.ts` sets that precedent twice already ("Derived from
 * `config.root`, NEVER a hardcoded absolute path (public-repo hygiene)"). The mini's
 * `~/Remudero/daemon-install` is exactly this default, resolved, never written down as a
 * literal here.
 */
export function resolveInstallRoot(config: InstallRootConfigLike): string {
  return config.installRoot ?? join(config.root, "daemon-install");
}

/** True when `child` is `parent` itself, or nested under it. Path-string safe: both sides are
 *  resolved to absolute form first, so a relative-vs-absolute spelling of the same directory
 *  (e.g. run from a subdir) compares correctly rather than false-negatively. */
function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface SeparationCheckInputs {
  installRoot: string;
  /** `config.root` — holds `state/`. */
  stateRoot: string;
  /** The checkout the OPERATOR writes (today's `repoRoot`). */
  operatorRepoRoot: string;
}

export type SeparationCheck = { ok: true } | { ok: false; reason: string };

/**
 * THE SEPARATION INVARIANT (design note iv) — the part a test can actually hold. Refuses when
 * the resolved state root sits INSIDE the install root (the install checkout must hold only the
 * daemon's own code, never runtime exhaust), or when the install root sits inside — or equals —
 * a checkout the operator writes (today's production configuration, `install root == repoRoot`,
 * is exactly the case this refuses). Only these two directions are checked, matching the design
 * note's own wording; the reverse (operator checkout nested inside the install root) is not part
 * of the stated invariant and is left alone.
 */
export function checkInstallSeparation(i: SeparationCheckInputs): SeparationCheck {
  if (isPathInside(i.installRoot, i.stateRoot)) {
    return {
      ok: false,
      reason:
        `state root (${i.stateRoot}) resolves INSIDE the install root (${i.installRoot}) — the ` +
        `install checkout must hold only the daemon's own code, never runtime state; point ` +
        `config.root/installRoot so the two never nest`,
    };
  }
  if (isPathInside(i.operatorRepoRoot, i.installRoot)) {
    return {
      ok: false,
      reason:
        `install root (${i.installRoot}) resolves INSIDE the operator's own checkout ` +
        `(${i.operatorRepoRoot}) — a shared tree is the exact defect this module exists to ` +
        `close; set config.installRoot to a checkout of its own`,
    };
  }
  return { ok: true };
}

/** Injected subprocess runner — default `execFileSync`, utf8. Throws on a non-zero exit, same
 *  shape as `deployer.ts`'s `RealDeployOpts.execFile` — real callers pass no `deps` at all. */
export type InstallExecFile = (cmd: string, args: string[]) => string;

export interface InstallRootDeps {
  execFile?: InstallExecFile;
  existsSync?: (p: string) => boolean;
  readdirSync?: (p: string) => string[];
  mkdirSync?: (p: string, opts?: { recursive?: boolean }) => void;
}

function defaultExecFile(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).toString();
}

export type InstallState =
  | { status: "absent" }
  | { status: "not-a-repo" }
  | { status: "healthy"; headSha: string }
  | { status: "unfit"; reason: "dirty" | "diverged" | "off-main"; detail: string };

/** The branch HEAD points at, or `undefined` for a detached HEAD — same read as
 *  self-sync.ts's `currentBranch` (`symbolic-ref -q` exits 1 and prints nothing on detached,
 *  never a plausible-looking string like `rev-parse --abbrev-ref` would). */
function currentBranch(git: (args: string[]) => string): string | undefined {
  try {
    return git(["symbolic-ref", "--short", "-q", "HEAD"]).trim();
  } catch {
    return undefined;
  }
}

/**
 * Read-only assessment of the install root against the four states design note (iii) names:
 *   ABSENT      — does not exist, or exists as an empty directory (a valid clone target).
 *   NOT-A-REPO  — exists, non-empty, holds no `.git` — never rm -rf'd, only ever refused.
 *   HEALTHY     — a clean checkout on `main` whose HEAD is an ancestor of origin/main.
 *   UNFIT       — dirty, off-main/detached, or carrying a commit origin/main does not have
 *                 (diverged); "name the state" — the `reason` distinguishes which.
 *
 * Fetches `origin` once (so HEALTHY/UNFIT are judged against current refs); NEVER mutates the
 * working tree or any branch — that is exclusively {@link provisionInstallRoot}'s job, and only
 * on the HEALTHY/ABSENT branches.
 */
export function inspectInstallRoot(path: string, deps: InstallRootDeps = {}): InstallState {
  const execFile = deps.execFile ?? defaultExecFile;
  const exists = deps.existsSync ?? existsSync;
  const readdir = deps.readdirSync ?? readdirSync;

  if (!exists(path) || readdir(path).length === 0) {
    return { status: "absent" };
  }
  if (!exists(join(path, ".git"))) {
    return { status: "not-a-repo" };
  }

  const git = (args: string[]) => execFile("git", ["-C", path, ...args]);
  git(["fetch", "--quiet", "origin"]);
  const headSha = git(["rev-parse", "HEAD"]).trim();

  const porcelain = git(["status", "--porcelain"]).trim();
  if (porcelain.length > 0) {
    return {
      status: "unfit",
      reason: "dirty",
      detail: `${porcelain.split("\n").length} locally-modified path(s) — the install checkout is the one tree in the system where a local edit is a bug`,
    };
  }

  let ffPossible = true;
  try {
    git(["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
  } catch {
    ffPossible = false;
  }
  if (!ffPossible) {
    return {
      status: "unfit",
      reason: "diverged",
      detail: `HEAD (${headSha.slice(0, 9)}) carries a commit origin/main does not have — not a fast-forward`,
    };
  }

  const branch = currentBranch(git);
  if (branch !== "main") {
    const where = branch === undefined ? "a DETACHED HEAD" : `branch \`${branch}\``;
    return { status: "unfit", reason: "off-main", detail: `on ${where}, not \`main\`` };
  }

  return { status: "healthy", headSha };
}

/** Render an {@link InstallState} as an operator-facing sentence naming the specific defect —
 *  used both by `rmd deploy-run`'s no-op line and `rmd install-checkout`'s report, so the two
 *  surfaces never describe the same state two different ways. */
export function describeInstallState(path: string, state: InstallState): string {
  switch (state.status) {
    case "absent":
      return `install root absent at ${path} — run \`rmd install-checkout --write\` to provision it (clone origin/main)`;
    case "not-a-repo":
      return `install root at ${path} exists and is non-empty but is not a git checkout — refusing to touch it (never rm -rf); inspect it by hand`;
    case "unfit":
      return `install root at ${path} is unfit (${state.reason}: ${state.detail}) — never falling back to the invoking checkout`;
    case "healthy":
      return `install root at ${path} is healthy (HEAD ${state.headSha.slice(0, 9)})`;
  }
}

export type ProvisionOutcome =
  | { action: "cloned"; headSha: string }
  | { action: "fast-forwarded"; fromSha: string; toSha: string }
  | { action: "up-to-date"; headSha: string }
  | { action: "refused"; reason: "not-a-repo" | "dirty" | "diverged" | "off-main"; detail: string };

/**
 * PROVISION-OR-REFUSE (design note iii) — the only function in this module that mutates
 * anything. Handles the four states {@link inspectInstallRoot} names, explicitly:
 *   ABSENT      -> clone origin/main into it.
 *   HEALTHY     -> ff-only to origin/main (the fetch already happened inside `inspectInstallRoot`,
 *                  so this merge is local-only), nothing else.
 *   NOT-A-REPO  -> refused, directory untouched.
 *   UNFIT       -> refused, directory untouched — a `reset --hard` here would destroy the
 *                  evidence of how a supposedly-daemon-only tree acquired a local edit.
 */
export function provisionInstallRoot(path: string, originUrl: string, deps: InstallRootDeps = {}): ProvisionOutcome {
  const execFile = deps.execFile ?? defaultExecFile;
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const state = inspectInstallRoot(path, deps);

  if (state.status === "absent") {
    mkdir(dirname(path), { recursive: true });
    execFile("git", ["clone", "--quiet", "-b", "main", originUrl, path]);
    const headSha = execFile("git", ["-C", path, "rev-parse", "HEAD"]).trim();
    return { action: "cloned", headSha };
  }
  if (state.status === "not-a-repo") {
    return {
      action: "refused",
      reason: "not-a-repo",
      detail: `${path} exists and is non-empty but is not a git checkout — refusing to touch it (never rm -rf)`,
    };
  }
  if (state.status === "unfit") {
    return { action: "refused", reason: state.reason, detail: state.detail };
  }

  // HEALTHY: origin/main was already fetched by inspectInstallRoot above, so this is local-only.
  const git = (args: string[]) => execFile("git", ["-C", path, ...args]);
  git(["merge", "--ff-only", "--quiet", "origin/main"]);
  const toSha = git(["rev-parse", "HEAD"]).trim();
  if (toSha === state.headSha) return { action: "up-to-date", headSha: toSha };
  return { action: "fast-forwarded", fromSha: state.headSha, toSha };
}

export type InstallAssessment = { ok: true; installRoot: string } | { ok: false; reason: string };

/**
 * THE DEPLOY-PATH GATE (design note vi) — FAIL SAFE, NOT FAIL FAST. Given an already-resolved
 * `installRoot` (callers resolve it once via {@link resolveInstallRoot} and pass it in, so the
 * grep proof at the call site names the real resolver, not a wrapper around it), checks the
 * separation invariant and current fitness, and returns either the (unchanged) install root
 * ready to deploy into, or a NAMED reason to no-op. Never provisions — that is exclusively `rmd
 * install-checkout`'s job (design note i: this is the one line of substance `deployRunCommand`
 * changes, plus this guard); a deploy cycle that silently provisioned would blur "the install was
 * never set up" into "the install was fine", which is precisely the wrong failure mode for a
 * runaway-supervisor guard to have.
 */
export function assessInstallForDeploy(
  installRoot: string,
  opts: { operatorRepoRoot: string; stateRoot: string; deps?: InstallRootDeps },
): InstallAssessment {
  const separation = checkInstallSeparation({
    installRoot,
    stateRoot: opts.stateRoot,
    operatorRepoRoot: opts.operatorRepoRoot,
  });
  if (!separation.ok) return { ok: false, reason: separation.reason };

  const state = inspectInstallRoot(installRoot, opts.deps);
  if (state.status === "healthy") return { ok: true, installRoot };
  return { ok: false, reason: describeInstallState(installRoot, state) };
}
