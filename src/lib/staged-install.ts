/**
 * Refresh a managed install in a sibling staging directory, then swap it into place.
 * A verified donor with matching install inputs on the same device lends hard links;
 * otherwise npm builds the staged tree. The live tree serves until verification completes.
 * A failed second rename restores the previous tree. Install markers stay private.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { hashInstallInputs, installHashMarkerPath } from "./install-hash.js";
import type { Escalation } from "./escalate.js";

/** A BACKSTOP for a wedged `npm ci` (dead registry socket, hung postinstall), never the control that ends a healthy one:
 *  the same generous 10 minutes as run-task.ts's NPM_CI_TIMEOUT_MS (that file imports this one, never the reverse). */
export const STAGED_NPM_CI_TIMEOUT_MS = 600_000;

export interface StagedInstallFailure {
  repoDir: string;
  /** The lockfile hash the failed install was for — the escalation's once-per-hash key. */
  hash: string;
  error: string;
}

export interface StagedInstallOptions {
  hash?: (repoDir: string) => string;
  /** Runs `npm ci` in `stagingDir` (which holds copies of the install inputs). Throws on failure. */
  runInstall?: (stagingDir: string) => void;
  /** Names of direct dependencies the staged tree does NOT resolve; empty means the tree is whole. */
  verify?: (stagingDir: string, directDependencies: string[]) => string[];
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Called at most once per lockfile hash, on a failed install. Its own failure never masks the install error. */
  escalate?: (failure: StagedInstallFailure) => void;
  clock?: Clock;
  donorDirs?: readonly string[];
  device?: (path: string) => number;
  linkInstall?: (donorDir: string, stagingDir: string) => void;
}

export type StagedInstallOutcome = "noop" | "refreshed" | "skipped_symlink";

/** The install ran and the old tree was kept. Carries the hash so a caller can key on it. */
export class StagedInstallFailedError extends RmdError {
  constructor(readonly failure: StagedInstallFailure) {
    super("install", GENERIC_EXIT_CODE, `staged install failed in ${failure.repoDir} (lockfile ${failure.hash.slice(0, 12)}): ${failure.error}`, {
      repoDir: failure.repoDir,
      hash: failure.hash,
    });
    this.name = "StagedInstallFailedError";
  }
}

/** Dotfile inside the LIVE node_modules: the lockfile hash an escalation was already raised for. */
export function installEscalatedMarkerPath(repoDir: string): string {
  return join(repoDir, "node_modules", ".rmd-install-escalated");
}

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    void error; // absent or unreadable marker reads as "never written"
    return undefined;
  }
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/\s+/g, " ").slice(0, 512);
}

/** Direct dependency names from the checkout's package.json (dependencies + devDependencies). */
function directDependencyNames(repoDir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as Record<string, unknown>;
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies"]) {
    const block = pkg[field];
    if (block && typeof block === "object") for (const name of Object.keys(block)) names.add(name);
  }
  return [...names].sort();
}

/** package.json files of the workspaces a root `workspaces` field names (`dir/*` globs and literal dirs). */
function workspacePackageDirs(repoDir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as { workspaces?: unknown };
  const raw = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : Array.isArray((pkg.workspaces as { packages?: unknown } | undefined)?.packages)
      ? ((pkg.workspaces as { packages: unknown[] }).packages)
      : [];
  const dirs: string[] = [];
  for (const pattern of raw) {
    if (typeof pattern !== "string") continue;
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      let entries: string[] = [];
      try {
        entries = readdirSync(join(repoDir, parent));
      } catch (error) {
        void error; // a workspace glob whose parent is absent matches nothing
      }
      for (const entry of entries.sort()) dirs.push(`${parent}/${entry}`);
    } else if (!pattern.includes("*")) {
      dirs.push(pattern);
    }
  }
  return dirs.filter((dir) => existsSync(join(repoDir, dir, "package.json")));
}

/** Copy only what `npm ci` reads, so staging never drags in sources and a postinstall cannot touch the checkout. */
function copyInstallInputs(repoDir: string, stagingDir: string): void {
  for (const name of ["package.json", "package-lock.json", ".npmrc"]) {
    if (existsSync(join(repoDir, name))) copyFileSync(join(repoDir, name), join(stagingDir, name));
  }
  for (const dir of workspacePackageDirs(repoDir)) {
    mkdirSync(join(stagingDir, dir), { recursive: true });
    copyFileSync(join(repoDir, dir, "package.json"), join(stagingDir, dir, "package.json"));
  }
}

function defaultVerify(stagingDir: string, directDependencies: string[]): string[] {
  const resolveFromStaging = createRequire(join(stagingDir, "package.json")).resolve;
  const missing: string[] = [];
  for (const name of directDependencies) {
    try {
      resolveFromStaging(`${name}/package.json`);
      continue;
    } catch (error) {
      // A package whose `exports` hides package.json still resolves on disk; only an absent directory is missing.
      void error;
    }
    if (!existsSync(join(stagingDir, "node_modules", name, "package.json"))) missing.push(name);
  }
  return missing;
}

function defaultRunInstall(stagingDir: string): void {
  execFileSync("npm", ["ci"], { cwd: stagingDir, stdio: "pipe", timeout: STAGED_NPM_CI_TIMEOUT_MS });
}

function defaultDonorDirs(repoDir: string, reasons: string[]): string[] {
  const parent = dirname(resolve(repoDir));
  const root = basename(parent) === "repos" ? dirname(parent) : parent;
  const candidates = [dirname(dirname(dirname(fileURLToPath(import.meta.url)))), join(root, "daemon-install")];
  for (const dir of new Set([parent, join(root, "repos"), join(root, "worktrees")])) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) candidates.push(join(dir, entry.name));
      }
    } catch (error) {
      const reason = `${dir}: ${errorText(error)}`;
      reasons.push(reason);
    }
  }
  return [...new Set(candidates)].filter((dir) => resolve(dir) !== resolve(repoDir));
}

function reuseDonor(
  repoDir: string, stagingDir: string, wanted: string, names: string[],
  deps: StagedInstallOptions, hash: (dir: string) => string, reasons: string[],
): string | undefined {
  const verify = deps.verify ?? defaultVerify;
  const device = deps.device ?? ((path: string) => statSync(path).dev);
  const targetDevice = device(stagingDir);
  for (const donor of deps.donorDirs ?? defaultDonorDirs(repoDir, reasons)) {
    if (resolve(donor) === resolve(repoDir)) continue;
    const modules = join(donor, "node_modules");
    if (readTrimmed(installHashMarkerPath(donor)) !== wanted) continue;
    try {
      if (!lstatSync(modules).isDirectory() || device(modules) !== targetDevice || hash(donor) !== wanted) continue;
      const missing = verify(donor, names);
      if (missing.length > 0) {
        reasons.push(`${donor}: donor does not resolve ${missing.join(", ")}`);
        continue;
      }
      (deps.linkInstall ?? ((from: string, stage: string) => {
        execFileSync("cp", ["-al", join(from, "node_modules"), join(stage, "node_modules")], { stdio: "pipe", timeout: STAGED_NPM_CI_TIMEOUT_MS });
      }))(donor, stagingDir);
      const stagedMissing = verify(stagingDir, names);
      if (stagedMissing.length > 0) throw new Error(`linked tree does not resolve ${stagedMissing.join(", ")}`);
      if (readTrimmed(installHashMarkerPath(stagingDir)) !== wanted || hash(donor) !== wanted) {
        throw new Error("donor inputs or marker changed while linking");
      }
      rmSync(installEscalatedMarkerPath(stagingDir), { force: true });
      return donor;
    } catch (error) {
      const reason = `${donor}: ${errorText(error)}`;
      reasons.push(reason);
      rmSync(join(stagingDir, "node_modules"), { recursive: true, force: true });
    }
  }
  return undefined;
}

/**
 * Bring `repoDir/node_modules` in line with its lockfile without ever emptying the live tree.
 * Returns `"noop"` on a matching hash. THROWS {@link StagedInstallFailedError} after ledgering
 * `managed_checkout.install_failed` and escalating once per lockfile hash; the old tree is still in place.
 */
export function stagedInstall(repoDir: string, deps: StagedInstallOptions = {}): StagedInstallOutcome {
  const hash = deps.hash ?? ((dir: string) => hashInstallInputs(dir));
  const log = deps.log ?? (() => {});
  const clock = deps.clock ?? systemClock;
  const liveTree = join(repoDir, "node_modules");
  const markerPath = installHashMarkerPath(repoDir);

  const wanted = hash(repoDir);
  const before = readTrimmed(markerPath);
  if (before === wanted) return "noop";

  let live: ReturnType<typeof lstatSync> | undefined;
  try {
    live = lstatSync(liveTree);
  } catch (error) {
    void error; // no node_modules yet: the swap below simply has nothing to move aside
  }
  if (live?.isSymbolicLink()) {
    // Renaming over a link would be safe, but a linked tree belongs to whichever checkout owns its target.
    log("managed_checkout.install_skipped", { repo: basename(repoDir), reason: "node_modules is a symlink", hash: wanted });
    return "skipped_symlink";
  }

  const startedAt = clock.now();
  const stagingRoot = join(dirname(repoDir), `.rmd-staged-install-${basename(repoDir)}`);
  const stagingDir = join(stagingRoot, "stage");
  const previousTree = join(stagingRoot, "previous");
  let swapped = false;
  let donor: string | undefined;
  const donorRejections: string[] = [];
  try {
    rmSync(stagingRoot, { recursive: true, force: true }); // a crashed earlier attempt's leftovers
    mkdirSync(stagingDir, { recursive: true });
    copyInstallInputs(repoDir, stagingDir);
    const names = directDependencyNames(repoDir);
    donor = reuseDonor(repoDir, stagingDir, wanted, names, deps, hash, donorRejections);
    if (!donor) (deps.runInstall ?? defaultRunInstall)(stagingDir);
    const missing = donor ? [] : (deps.verify ?? defaultVerify)(stagingDir, names);
    if (missing.length > 0) throw new Error(`staged tree does not resolve ${missing.join(", ")}`);

    // The swap: two renames on one filesystem. The second failing puts the old tree straight back.
    if (live) renameSync(liveTree, previousTree);
    try {
      renameSync(join(stagingDir, "node_modules"), liveTree);
    } catch (error) {
      if (live) renameSync(previousTree, liveTree);
      throw error;
    }
    swapped = true;
    if (donor) rmSync(markerPath, { force: true });
    writeFileSync(markerPath, wanted);
  } catch (error) {
    const failure: StagedInstallFailure = { repoDir, hash: wanted, error: errorText(error) };
    const escalated = readTrimmed(installEscalatedMarkerPath(repoDir)) === wanted;
    log("managed_checkout.install_failed", {
      repo: basename(repoDir),
      hash: wanted,
      swapped,
      method: donor ? "hard-linked" : "npm-ci",
      donor: donor ?? null,
      donor_rejections: donorRejections,
      error: failure.error,
      escalated: !escalated,
      elapsed_ms: clock.now() - startedAt,
    });
    if (!escalated) {
      // Mark BEFORE delivering: an escalation that throws must not be retried on every dispatch.
      try {
        writeFileSync(installEscalatedMarkerPath(repoDir), wanted);
      } catch (markError) {
        log("managed_checkout.install_escalation_unmarked", { repo: basename(repoDir), error: errorText(markError) });
      }
      try {
        deps.escalate?.(failure);
      } catch (escalateError) {
        log("managed_checkout.install_escalation_failed", { repo: basename(repoDir), error: errorText(escalateError) });
      }
    }
    rmSync(stagingRoot, { recursive: true, force: true });
    throw new StagedInstallFailedError(failure);
  }

  rmSync(stagingRoot, { recursive: true, force: true });
  log("managed_checkout.install_refreshed", {
    repo: basename(repoDir),
    before_hash: before ?? null,
    after_hash: wanted,
    method: donor ? "hard-linked" : "npm-ci",
    donor: donor ?? null,
    donor_rejections: donorRejections,
    elapsed_ms: clock.now() - startedAt,
  });
  return "refreshed";
}

/** The needs-human escalation for a managed checkout whose install failed — raised once per lockfile hash. */
export function managedCheckoutInstallEscalation(failure: StagedInstallFailure, taskId: string, runId?: string): Escalation {
  const repo = basename(failure.repoDir);
  return {
    class: "BLOCKED",
    taskId,
    ...(runId ? { runId } : {}),
    summary: `managed checkout ${repo}: npm ci failed for lockfile ${failure.hash.slice(0, 12)} — old node_modules kept`,
    detail:
      `W1-T4933: the managed checkout ${failure.repoDir} has a lockfile its node_modules does not match, and the ` +
      `staged \`npm ci\` that would reinstall it failed:\n\n${failure.error}\n\n` +
      `The previous tree is still in place and still serving, so nothing was emptied. Until the install succeeds the ` +
      `checkout runs stale dependencies — the shape that failed six reviewer proofs on 2026-09-30. This is raised once ` +
      `per lockfile hash; a later dispatch retries the install silently.`,
    options: [
      { label: "fix the install", detail: `Run \`npm ci\` by hand in a copy of ${repo}'s package.json and package-lock.json to see the failure, repair the lockfile or registry access, and the next dispatch retries.` },
    ],
    recommendation: "fix the install",
  };
}
