/**
 * `rmd hand-worktree <taskId>` (W1-T5533) — the worktree a HAND build works in, made by one command.
 *
 * Hand builders typed this by hand and hit the same failures on 2026-10-03/04: `git worktree add -b`
 * set an upstream of `origin/refs/heads/main` and refused; a relative path landed under the canonical
 * checkout instead of beside it; every builder paid a fresh ~850 MB `npm ci`, and eight of them filled
 * a 29 GB root disk (ENOSPC); a donor whose `node_modules/.bin` was EMPTY gave hard-linked worktrees
 * no tsc/tsx; and each builder hand-checked origin for a `run-<id>-*` branch or a merged trailer.
 *
 * node_modules is HARD-LINKED (`cp -al`), never symlinked. `linkWorktreeNodeModules` (worker.ts)
 * symlinks for workers, and `ensureInstallFresh` refuses `npm ci` through that link
 * (`SymlinkInstallRefusal`) because an install's clear phase empties the shared tree. A hard-linked
 * copy costs no extra space and is safe to `npm ci` over: unlinking a hard link leaves the source.
 * When no donor qualifies, the next step is REPORTED with the free space, never run here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { systemClock, type Clock } from "./clock.js";

/** A filed task id (`W1-T<n>`, or a consumer prefix's `<P>-T<n>`); `unfiled` is accepted beside it. */
export const HAND_WORKTREE_TASK_ID_RE = /^[A-Z][A-Z0-9]*-T[0-9]+[A-Za-z]?$/;

/**
 * PRIMARY CONTROL: the free space a new hand worktree must find on its target filesystem. A
 * hard-linked worktree costs a source checkout (~100 MB); a fallback `npm ci` costs ~850 MB more, and
 * 2 GiB was the floor the 2026-10-04 builders were told to stop under.
 */
export const HAND_WORKTREE_MIN_FREE_BYTES = 2 * 1024 ** 3;

export interface HandWorktreeRequest {
  /** The checkout whose `origin` the worktree is cut from. */
  repoDir: string;
  /** A filed task id, or `unfiled`. */
  taskId: string;
  /** ABSOLUTE directory the worktree is created in; a relative one is refused. */
  parent: string;
  clock?: Clock;
  minFreeBytes?: number;
  /** The npm binary the donor's `npm ls` runs through. */
  npmCommand?: string;
}

export type NodeModulesOutcome =
  | { kind: "hard-linked"; donor: string }
  | { kind: "npm-ci-needed"; reasons: string[] };

export type HandWorktreeResult =
  | { status: "refused"; reason: string }
  | { status: "created"; path: string; branch: string; freeBytes: number; nodeModules: NodeModulesOutcome };

interface Ran {
  ok: boolean;
  stdout: string;
  detail: string;
}

function run(cmd: string, args: string[], cwd?: string): Ran {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  const detail = r.error ? r.error.message : (r.stderr || r.stdout || `exit ${r.status}`).trim();
  return { ok: r.error === undefined && r.status === 0, stdout: r.stdout ?? "", detail };
}

/** Bytes available to an unprivileged writer on the filesystem holding `path`. */
export function freeBytesAt(path: string): number {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}

/** `1.5 GiB`-style rendering for the operator-facing lines. */
export function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * Why `donor` cannot lend its node_modules to a worktree holding `lock`, or null when it can.
 * `targetDev` is the target filesystem's device: `cp -al` cannot hard-link across filesystems, so a
 * donor on another one (a root-disk checkout lending to a scratch-disk parent) is no donor at all.
 */
export function donorRejection(donor: string, lock: Buffer, npmCommand = "npm", targetDev?: number): string | null {
  const lockPath = join(donor, "package-lock.json");
  if (!existsSync(lockPath)) return "no package-lock.json";
  if (!readFileSync(lockPath).equals(lock)) return "package-lock.json differs";
  const modules = join(donor, "node_modules");
  if (!existsSync(modules) || !lstatSync(modules).isDirectory()) return "node_modules is not a real directory";
  if (targetDev !== undefined && statSync(modules).dev !== targetDev) return "node_modules is on another filesystem (cp -al cannot hard-link across it)";
  const bin = join(modules, ".bin");
  if (!existsSync(bin) || readdirSync(bin).length === 0) return "node_modules/.bin is empty";
  const ls = run(npmCommand, ["ls", "--depth=0", "--offline", "--no-update-notifier"], donor);
  return ls.ok ? null : `npm ls failed: ${ls.detail.split("\n")[0]}`;
}

/** Pick the first sibling worktree of `repoDir` that may lend `target` its node_modules. */
export function findDonor(repoDir: string, target: string, npmCommand = "npm"): { donor: string } | { reasons: string[] } {
  const targetLock = join(target, "package-lock.json");
  if (!existsSync(targetLock)) return { reasons: [`${target} has no package-lock.json`] };
  const list = run("git", ["-C", repoDir, "worktree", "list", "--porcelain"]);
  if (!list.ok) return { reasons: [`git worktree list failed: ${list.detail}`] };
  const lock = readFileSync(targetLock);
  const targetDev = statSync(target).dev;
  const reasons: string[] = [];
  for (const line of list.stdout.split("\n")) {
    const candidate = line.startsWith("worktree ") ? line.slice("worktree ".length) : "";
    if (candidate === "" || resolve(candidate) === resolve(target)) continue;
    const why = donorRejection(candidate, lock, npmCommand, targetDev);
    if (why === null) return { donor: candidate };
    reasons.push(`${candidate}: ${why}`);
  }
  return { reasons: reasons.length > 0 ? reasons : ["no other worktree exists"] };
}

/** `cp -al` the donor's node_modules into `target`: a hard-linked copy, never a symlink. */
export function hardLinkNodeModules(donor: string, target: string): NodeModulesOutcome {
  const cp = run("cp", ["-al", join(donor, "node_modules"), join(target, "node_modules")]);
  return cp.ok ? { kind: "hard-linked", donor } : { kind: "npm-ci-needed", reasons: [`cp -al from ${donor} failed: ${cp.detail}`] };
}

/** Refuse what a hand builder used to check by hand: a fleet branch, or a merged trailer, for the id. */
function duplicateWork(repoDir: string, taskId: string): string | null {
  const heads = run("git", ["-C", repoDir, "ls-remote", "--heads", "origin", `run-${taskId}-*`]);
  if (!heads.ok) return `cannot read origin's run-${taskId}-* branches: ${heads.detail}`;
  const branches = heads.stdout.split("\n").filter(Boolean).map((l) => l.split("\t")[1]);
  if (branches.length > 0) return `origin already has ${branches.join(", ")} — someone is building ${taskId}`;
  const merged = run("git", ["-C", repoDir, "log", "origin/main", "-1", "--format=%h %s", `--grep=^Remudero-Task: ${taskId}$`]);
  if (!merged.ok) return `cannot read origin/main's Remudero-Task trailers: ${merged.detail}`;
  return merged.stdout.trim() === "" ? null : `${taskId} is already merged on origin/main: ${merged.stdout.trim()}`;
}

/** Create the worktree; every refusal happens BEFORE `git worktree add` writes anything. */
export function createHandWorktree(req: HandWorktreeRequest): HandWorktreeResult {
  const { repoDir, taskId, parent } = req;
  const filed = taskId !== "unfiled";
  if (filed && !HAND_WORKTREE_TASK_ID_RE.test(taskId)) return { status: "refused", reason: `'${taskId}' is not a task id (W1-T<n>) or 'unfiled'` };
  if (!isAbsolute(parent)) return { status: "refused", reason: `--parent '${parent}' is relative — give an absolute directory` };
  if (!existsSync(parent) || !statSync(parent).isDirectory()) return { status: "refused", reason: `--parent '${parent}' is not a directory` };
  const freeBytes = freeBytesAt(parent);
  const floor = req.minFreeBytes ?? HAND_WORKTREE_MIN_FREE_BYTES;
  if (freeBytes < floor) return { status: "refused", reason: `${formatGiB(freeBytes)} free under ${parent}, below the ${formatGiB(floor)} floor` };
  const fetched = run("git", ["-C", repoDir, "fetch", "--quiet", "origin", "main"]);
  if (!fetched.ok) return { status: "refused", reason: `git fetch origin main failed: ${fetched.detail}` };
  const duplicate = filed ? duplicateWork(repoDir, taskId) : null;
  if (duplicate !== null) return { status: "refused", reason: duplicate };
  const branch = `run-${taskId}-${(req.clock ?? systemClock).now()}`;
  const path = join(parent, branch);
  if (existsSync(path)) return { status: "refused", reason: `${path} already exists` };
  const added = run("git", ["-C", repoDir, "worktree", "add", "--quiet", "--no-track", "-b", branch, path, "origin/main"]);
  if (!added.ok) return { status: "refused", reason: `git worktree add failed: ${added.detail}` };
  const donor = findDonor(repoDir, path, req.npmCommand);
  const nodeModules = "donor" in donor ? hardLinkNodeModules(donor.donor, path) : { kind: "npm-ci-needed" as const, reasons: donor.reasons };
  return { status: "created", path, branch, freeBytes: freeBytesAt(parent), nodeModules };
}

/** The operator-facing lines for a created worktree. */
export function renderHandWorktree(result: Extract<HandWorktreeResult, { status: "created" }>): string {
  const lines = [`path:   ${result.path}`, `branch: ${result.branch} (no upstream; push with \`git push -u origin HEAD\`)`];
  if (result.nodeModules.kind === "hard-linked") {
    lines.push(`node_modules: hard-linked from ${result.nodeModules.donor} (identical package-lock.json)`);
  } else {
    lines.push(`node_modules: none linked — next step: \`npm ci\` in ${result.path} (~850 MB; ${formatGiB(result.freeBytes)} free)`);
    for (const reason of result.nodeModules.reasons) lines.push(`  no donor: ${reason}`);
  }
  lines.push(`free:   ${formatGiB(result.freeBytes)} on the target filesystem`);
  return lines.join("\n");
}
