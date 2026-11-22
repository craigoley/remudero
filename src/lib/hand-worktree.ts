/**
 * `rmd hand-worktree <taskId>` (W1-T5533) — the worktree a HAND build works in, made by one command.
 *
 * Hand builders typed this by hand and hit the same failures on 2026-10-03/04: `git worktree add -b`
 * set an upstream of `origin/refs/heads/main` and refused; a relative path landed under the canonical
 * checkout instead of beside it; every builder paid a fresh ~850 MB `npm ci`, and eight of them filled
 * a 29 GB root disk (ENOSPC); a donor whose `node_modules/.bin` was EMPTY gave hard-linked worktrees
 * no tsc/tsx; and each builder hand-checked origin for a `run-<id>-*` branch or a merged trailer.
 *
 * The tracked files are materialized by `addCowWorktree` (W1-T10257): unchanged files are cloned
 * copy-on-write from the checkout where the volume supports it, a normal checkout otherwise.
 *
 * node_modules is HARD-LINKED (`cp -al`), never symlinked. `linkWorktreeNodeModules` (worker.ts)
 * symlinks for workers, and `ensureInstallFresh` refuses `npm ci` through that link
 * (`SymlinkInstallRefusal`) because an install's clear phase empties the shared tree. A hard-linked
 * copy costs no extra space and is safe to `npm ci` over: unlinking a hard link leaves the source.
 * When no donor qualifies, the next step is REPORTED with the free space, never run here.
 *
 * W1-T14307 — A FILED HAND WORKTREE IS PUBLISHED BEFORE IT IS BUILT. The drain dispatches a task unless
 * published work exists (an open PR or a pushed run branch), so a worktree cut only locally left the task
 * free for the fleet until the builder's first push; on 2026-11-22 the fleet built W1-T14147 again as
 * #20129 beside an unpushed hand worktree. So, once the worktree is cut, it takes the fleet's own dispatch
 * claim through the reserver `rmd claim` uses and pushes its run branch at the base sha, then lists origin's
 * branches for the id again: another one, or a failed push or listing, removes what it made and refuses.
 * INVARIANT a-hand-build-is-published-before-it-is-built: a filed hand worktree exists only with its run
 * branch on origin, or with the operator's explicit --no-claim.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statfsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { addCowWorktree, type CowWorktreeResult } from "./cow-worktree.js";
import { configuredDependencySeedRoot, materializeDependencySeed, type SeedMethod } from "./dependency-seeds.js";
import { decideDispatchClaim, dispatchClaimRef, type DispatchClaimReserver } from "./dispatch-claim.js";
import { hostWorktreeGit } from "./worktree-git.js";

export function defaultHandWorktreeParent(
  repoDir: string,
  { scratchRoot = "/mnt/scratch", exists = (path: string) => existsSync(path) && statSync(path).isDirectory() }:
    { scratchRoot?: string; exists?: (path: string) => boolean } = {},
): string {
  return exists(scratchRoot) ? join(scratchRoot, "hand") : dirname(resolve(repoDir));
}

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
  createParent?: boolean;
  clock?: Clock;
  minFreeBytes?: number;
  /** The npm binary the donor's `npm ls` runs through. */
  npmCommand?: string;
  /** W1-T14307: the dispatch-claim reserver `rmd claim` uses (run-task.ts `dispatchClaimReserverFor`). With none,
   *  a filed worktree still pushes its run branch, and its claim line says no dispatch claim was taken. */
  claimReserver?: DispatchClaimReserver;
  /** W1-T14307: `--no-claim`, for an offline host — no dispatch claim and no run-branch push, said in the output. */
  noClaim?: boolean;
}

export type NodeModulesOutcome =
  | { kind: "hard-linked"; donor: string }
  | { kind: "seeded"; donor: string; method: SeedMethod }
  | { kind: "npm-ci-needed"; reasons: string[] };

/** W1-T14307: what on origin says this hand build holds its task. */
export type HandWorktreeClaim =
  | { kind: "pushed"; sha: string; dispatch: { taken: true; ref: string } | { taken: false; reason: string } }
  | { kind: "skipped" }
  | { kind: "not-applicable" };

export type HandWorktreeResult =
  | { status: "refused"; reason: string }
  | { status: "created"; path: string; branch: string; freeBytes: number; nodeModules: NodeModulesOutcome; cow?: CowWorktreeResult; claim: HandWorktreeClaim };

interface Ran {
  ok: boolean;
  stdout: string;
  detail: string;
}

const GIT_TIMEOUT_MS = 120_000;

function run(cmd: string, args: string[], cwd?: string): Ran {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
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
  const targetDev = configuredDependencySeedRoot() ? undefined : statSync(target).dev;
  const reasons: string[] = [];
  for (const line of list.stdout.split("\n")) {
    const candidate = line.startsWith("worktree ") ? line.slice("worktree ".length) : "";
    if (candidate === "" || realpathSync(candidate) === realpathSync(target)) continue;
    const why = donorRejection(candidate, lock, npmCommand, targetDev);
    if (why === null) return { donor: candidate };
    reasons.push(`${candidate}: ${why}`);
  }
  return { reasons: reasons.length > 0 ? reasons : ["no other worktree exists"] };
}

/** `cp -al` the donor's node_modules into `target`: a hard-linked copy, never a symlink. */
export function hardLinkNodeModules(donor: string, target: string): NodeModulesOutcome {
  const root = configuredDependencySeedRoot();
  if (root) {
    try {
      const result = materializeDependencySeed(target, { root, sourceDir: donor });
      if (result.status === "materialized") return { kind: "seeded", donor, method: result.method };
      return { kind: "npm-ci-needed", reasons: ["dependency destination is already occupied"] };
    } catch (error) { return { kind: "npm-ci-needed", reasons: [`dependency seed refused: ${(error as Error).message}`] }; }
  }
  const cp = run("cp", ["-al", join(donor, "node_modules"), join(target, "node_modules")]);
  return cp.ok ? { kind: "hard-linked", donor } : { kind: "npm-ci-needed", reasons: [`cp -al from ${donor} failed: ${cp.detail}`] };
}

/** `git ls-remote` rows as `[sha, ref]`. */
function lsRemoteRows(stdout: string): Array<[string, string]> {
  return stdout.split("\n").filter(Boolean).map((l) => {
    const [sha = "", ref = ""] = l.split("\t");
    return [sha, ref];
  });
}

/** The first line of a thrown git error, which names the command and git's own reason. */
function firstLine(error: unknown): string {
  return String((error as Error)?.message ?? error).trim().split("\n")[0] ?? "";
}

/** ` (<anchor's first line>)` for a held claim when the reserver can read it, else nothing. */
function claimHolderNote(reserver: DispatchClaimReserver | undefined, taskId: string, sha: string): string {
  const message = reserver?.anchorMessage?.(taskId, sha)?.split("\n")[0]?.trim();
  return message ? ` (${message})` : "";
}

/** Refuse what a hand builder used to check by hand: a fleet branch, the fleet's dispatch claim (W1-T14307), or a
 *  merged trailer, for the id. One listing reads the branches and the claim; a failed read refuses, never reads free. */
function duplicateWork(repoDir: string, taskId: string, reserver?: DispatchClaimReserver): string | null {
  const claimRef = dispatchClaimRef(taskId);
  const heads = run("git", ["-C", repoDir, "ls-remote", "origin", `refs/heads/run-${taskId}-*`, claimRef]);
  if (!heads.ok) return `cannot read origin's run-${taskId}-* branches or its ${claimRef} claim: ${heads.detail}`;
  const rows = lsRemoteRows(heads.stdout);
  const claim = rows.find(([, ref]) => ref === claimRef);
  if (claim !== undefined) {
    return `origin holds ${claimRef} at ${claim[0]}${claimHolderNote(reserver, taskId, claim[0])} — the fleet or another hand build has claimed ${taskId}`;
  }
  const branches = rows.map(([, ref]) => ref).filter((ref) => ref.startsWith(`refs/heads/run-${taskId}-`));
  if (branches.length > 0) return `origin already has ${branches.join(", ")} — someone is building ${taskId}`;
  const merged = run("git", ["-C", repoDir, "log", "origin/main", "-1", "--format=%h %s", `--grep=^Remudero-Task: ${taskId}$`]);
  if (!merged.ok) return `cannot read origin/main's Remudero-Task trailers: ${merged.detail}`;
  return merged.stdout.trim() === "" ? null : `${taskId} is already merged on origin/main: ${merged.stdout.trim()}`;
}

/**
 * W1-T14307: remove what a refused claim made — origin's run branch when it was pushed, the dispatch claim when it was
 * taken, then the worktree and its local branch — and return `cause` with what could not be removed. Every git call
 * runs through the hardened leaf (worktree-git.ts), as the census in
 * test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.ts requires.
 */
function undoHandWorktree(
  repoDir: string,
  path: string,
  branch: string,
  made: { pushed?: boolean; claim?: { ref: string; drop: () => boolean } },
  cause: string,
): string {
  const left: string[] = [];
  const remove = (what: string, act: () => unknown): void => {
    try {
      if (act() === false) left.push(what);
    } catch (error) {
      // Not erased: the failure's first line joins `left`, and the refusal names it ("could not remove …").
      left.push(`${what} (${firstLine(error)})`);
    }
  };
  if (made.pushed) remove(`origin's ${branch}`, () => hostWorktreeGit(path, ["push", "--quiet", "origin", `:refs/heads/${branch}`], { timeout: GIT_TIMEOUT_MS }));
  if (made.claim) remove(`origin's ${made.claim.ref}`, made.claim.drop);
  remove(`the worktree ${path}`, () => hostWorktreeGit(repoDir, ["worktree", "remove", "--force", path], { timeout: GIT_TIMEOUT_MS }));
  remove(`the local branch ${branch}`, () => hostWorktreeGit(repoDir, ["branch", "-D", branch], { timeout: GIT_TIMEOUT_MS }));
  return left.length === 0
    ? `${cause}; removed the new worktree and branch`
    : `${cause}; could not remove ${left.join(", ")} — remove them by hand`;
}

/**
 * W1-T14307: publish a filed hand worktree. Takes the dispatch claim through `req.claimReserver`, pushes the run
 * branch at the worktree's base, then lists origin's `run-<id>-*` branches again. A claim another lane took, a second
 * branch, or a failed push or listing undoes the worktree and refuses. A dispatch-claim push the host refuses (a proxy
 * that refuses `refs/rmd-*`) is said, and the run branch alone is the claim.
 */
function claimHandWorktree(req: HandWorktreeRequest, taskId: string, branch: string, path: string): HandWorktreeClaim | { refused: string } {
  if (req.noClaim) return { kind: "skipped" };
  const reserver = req.claimReserver;
  const ref = dispatchClaimRef(taskId);
  let dispatch: { taken: true; ref: string } | { taken: false; reason: string };
  let claim: { ref: string; drop: () => boolean } | undefined;
  if (reserver === undefined) dispatch = { taken: false, reason: "no dispatch-claim reserver was given" };
  else {
    const anchor = reserver.mintAnchor();
    const outcome = anchor === "" ? "unreachable" : reserver.attempt(taskId, anchor);
    if (outcome === "taken") {
      const why = decideDispatchClaim("taken", { taskId, holder: reserver.holder(taskId) }).reason;
      return { refused: undoHandWorktree(req.repoDir, path, branch, {}, `${ref} was taken while the worktree was cut: ${why}`) };
    }
    if (outcome === "created") {
      dispatch = { taken: true, ref };
      claim = { ref, drop: () => reserver.drop(taskId, { expect: anchor }) };
    } else {
      dispatch = { taken: false, reason: anchor === "" ? `could not mint an anchor for ${ref}`
        : decideDispatchClaim("unreachable", { taskId, stderr: reserver.lastAttemptStderr?.() }).reason };
    }
  }
  try {
    hostWorktreeGit(path, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { timeout: GIT_TIMEOUT_MS });
  } catch (error) {
    return { refused: undoHandWorktree(req.repoDir, path, branch, { claim }, `could not push ${branch} to origin: ${firstLine(error)}`) };
  }
  let listed: string;
  try {
    listed = hostWorktreeGit(path, ["ls-remote", "origin", `refs/heads/run-${taskId}-*`], { timeout: GIT_TIMEOUT_MS });
  } catch (error) {
    return { refused: undoHandWorktree(req.repoDir, path, branch, { pushed: true, claim },
      `pushed ${branch}, then could not list origin's run-${taskId}-* branches: ${firstLine(error)}`) };
  }
  const rows = lsRemoteRows(listed);
  const sha = rows.find(([, r]) => r === `refs/heads/${branch}`)?.[0];
  const others = rows.map(([, r]) => r).filter((r) => r !== `refs/heads/${branch}`);
  if (others.length > 0 || sha === undefined) {
    return { refused: undoHandWorktree(req.repoDir, path, branch, { pushed: true, claim }, others.length > 0
      ? `another branch for ${taskId} reached origin during the push: ${others.join(", ")} — two builders must never both proceed`
      : `origin does not list the ${branch} just pushed`) };
  }
  return { kind: "pushed", sha, dispatch };
}

/** Create the worktree; every refusal before the claim happens BEFORE `git worktree add` writes anything, and a
 *  refused claim removes what the cut made (W1-T14307). */
export function createHandWorktree(req: HandWorktreeRequest): HandWorktreeResult {
  const { repoDir, taskId, parent } = req;
  const filed = taskId !== "unfiled";
  if (filed && !HAND_WORKTREE_TASK_ID_RE.test(taskId)) return { status: "refused", reason: `'${taskId}' is not a task id (W1-T<n>) or 'unfiled'` };
  if (!isAbsolute(parent)) return { status: "refused", reason: `--parent '${parent}' is relative — give an absolute directory` };
  if (req.createParent) {
    try {
      mkdirSync(parent, { recursive: true });
    } catch (error) {
      return { status: "refused", reason: `cannot create scratch parent ${parent}: ${(error as Error).message}` };
    }
  }
  if (!existsSync(parent) || !statSync(parent).isDirectory()) return { status: "refused", reason: `--parent '${parent}' is not a directory` };
  const freeBytes = freeBytesAt(parent);
  const floor = req.minFreeBytes ?? HAND_WORKTREE_MIN_FREE_BYTES;
  if (freeBytes < floor) return { status: "refused", reason: `${formatGiB(freeBytes)} free under ${parent}, below the ${formatGiB(floor)} floor` };
  const fetched = run("git", ["-C", repoDir, "fetch", "--quiet", "origin", "main"]);
  if (!fetched.ok) return { status: "refused", reason: `git fetch origin main failed: ${fetched.detail}` };
  const duplicate = filed ? duplicateWork(repoDir, taskId, req.claimReserver) : null;
  if (duplicate !== null) return { status: "refused", reason: duplicate };
  const branch = `run-${taskId}-${(req.clock ?? systemClock).now()}`;
  const path = join(parent, branch);
  if (existsSync(path)) return { status: "refused", reason: `${path} already exists` };
  let cow: CowWorktreeResult;
  try {
    cow = addCowWorktree({ repoDir, dir: path, branch, base: "origin/main", donorDir: repoDir });
  } catch (error) {
    return { status: "refused", reason: `git worktree add failed: ${(error as Error).message}` };
  }
  const claim = filed ? claimHandWorktree(req, taskId, branch, path) : { kind: "not-applicable" as const };
  if ("refused" in claim) return { status: "refused", reason: claim.refused };
  const donor = findDonor(repoDir, path, req.npmCommand);
  let nodeModules: NodeModulesOutcome;
  const root = configuredDependencySeedRoot();
  if ("donor" in donor) nodeModules = hardLinkNodeModules(donor.donor, path);
  else if (root) {
    try {
      const result = materializeDependencySeed(path, { root });
      nodeModules = result.status === "materialized" ? { kind: "seeded", donor: result.seed, method: result.method }
        : { kind: "npm-ci-needed", reasons: ["dependency destination is already occupied"] };
    } catch (error) { nodeModules = { kind: "npm-ci-needed", reasons: [`dependency seed refused: ${(error as Error).message}`] }; }
  } else nodeModules = { kind: "npm-ci-needed", reasons: donor.reasons };
  return { status: "created", path, branch, freeBytes: freeBytesAt(parent), nodeModules, cow, claim };
}

/** W1-T14307: the claim line — which claim on origin this hand build holds, if any. */
function renderClaim(result: Extract<HandWorktreeResult, { status: "created" }>): string {
  const claim = result.claim;
  if (claim.kind === "skipped") return "claim:  skipped (--no-claim) — nothing on origin says this task is held, so the fleet may dispatch it";
  if (claim.kind === "not-applicable") return "claim:  not applicable (unfiled)";
  const dispatch = claim.dispatch.taken ? `${claim.dispatch.ref} taken`
    : `dispatch claim not taken (${claim.dispatch.reason}); the run branch alone is the claim`;
  return `claim:  ${result.branch} pushed to origin at ${claim.sha}; ${dispatch}`;
}

/** The operator-facing lines for a created worktree. */
export function renderHandWorktree(result: Extract<HandWorktreeResult, { status: "created" }>): string {
  const lines = [`path:   ${result.path}`, `branch: ${result.branch} (no upstream; push with \`git push -u origin HEAD\`)`, renderClaim(result)];
  if (result.nodeModules.kind === "hard-linked") {
    lines.push(`node_modules: hard-linked from ${result.nodeModules.donor} (identical package-lock.json)`);
  } else if (result.nodeModules.kind === "seeded") {
    lines.push(`node_modules: ${result.nodeModules.method} from a validated dependency seed`);
  } else {
    lines.push(`node_modules: none linked — next step: \`npm ci\` in ${result.path} (~850 MB; ${formatGiB(result.freeBytes)} free)`);
    for (const reason of result.nodeModules.reasons) lines.push(`  no donor: ${reason}`);
  }
  const cow = result.cow;
  if (cow !== undefined) lines.push(`files:  ${cow.method === "clone" ? `${cow.cloned} cloned copy-on-write, ${cow.written} written by git` : `normal checkout (${cow.fallbackReason})`}`);
  lines.push(`free:   ${formatGiB(result.freeBytes)} on the target filesystem`);
  return lines.join("\n");
}
