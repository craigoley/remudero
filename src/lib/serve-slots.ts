/**
 * Generation slots for the serve supervisor (arch-phase3-design.md §2, P3-05): where the NEXT serve
 * generation is checked out and installed while the current one keeps serving.
 *
 * Two slots, `a` and `b`, are git worktrees of the serve clone (the disk rule: never more than two).
 * Preparing one fetches main only, checks out its newest sha, and makes the slot's `node_modules`
 * match its lockfile BEFORE any swap:
 *   - the slot already matches its lockfile hash: reused as is;
 *   - the active slot has the same hash: hard-linked from it in seconds (a real tree, never a symlink,
 *     which `ensureInstallFresh` refuses);
 *   - otherwise: `npm ci` in the inactive slot, while the active generation serves.
 * A lockfile merge therefore costs standby time and never serving time.
 *
 * The hash and the marker are the ones `ensureInstallFresh` uses (src/lib/install-hash.ts), so a
 * slot prepared here reads as fresh to serve. The marker is written by temp file and rename: in a
 * hard-linked tree an in-place write would change the other slot's marker too.
 *
 * W1-T9421: after its install, a slot builds its precompiled child entries and worker bundles
 * (scripts/build-child-entries.mjs) in a child process, so serve's workers can start from them (W1-T9370).
 * W1-T10058: unless that tree's existing build is verified current, in a child too, as a memory-deferred retry's is.
 */
import { execFile } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { reclaimStaleGitLocks, type StaleLockReclaimOptions } from "./git-lock-reclaim.js";
import { hashInstallInputs, installHashMarkerPath } from "./install-hash.js";
import type { PreparedSlot, ServeSupervisorOptions } from "./serve-supervisor.js";

export const SLOT_NAMES = ["a", "b"] as const;
/** BACKSTOP on a hung install; a cold `npm ci` measured 20–30 s on the fleet host. */
export const SLOT_INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Runs one command off the loop and resolves its stdout; rejects with its stderr. */
export type RunCommand = (command: string, args: string[], cwd: string) => Promise<string>;

export const runCommand: RunCommand = (command, args, cwd) =>
  new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: SLOT_INSTALL_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${stderr.trim() || `${err.code ?? err.signal ?? err.name}: ${err.message}`}\n` +
        `${command} ${args.join(" ")} failed in ${cwd}`));
      else resolvePromise(stdout);
    });
  });

function readMarker(dir: string): string | undefined {
  try {
    return readFileSync(installHashMarkerPath(dir), "utf8").trim();
  } catch {
    return undefined; // no marker: this tree has never been installed by a hash-checking path
  }
}

function writeMarker(dir: string, hash: string): void {
  const marker = installHashMarkerPath(dir);
  const staged = `${marker}.${process.pid}.tmp`;
  writeFileSync(staged, hash);
  renameSync(staged, marker);
}

/** Recreate `from` at `to` with every file hard-linked and every symlink copied as a link. */
export function linkTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else if (entry.isDirectory()) linkTree(source, target);
    else linkSync(source, target);
  }
}

/** Make `dir`'s node_modules match its own lockfile; returns how. */
export async function prepareSlotDeps(dir: string, activeDir: string, run: RunCommand = runCommand, link: (from: string, to: string) => void = linkTree): Promise<"reused" | "linked" | "installed"> {
  const want = hashInstallInputs(dir);
  if (readMarker(dir) === want) return "reused";
  const modules = join(dir, "node_modules");
  await run("rm", ["-rf", modules], dir);
  if (resolve(activeDir) !== resolve(dir) && hashInstallInputs(activeDir) === want && readMarker(activeDir) === want) {
    const linked = await run("cp", ["-al", join(activeDir, "node_modules"), modules], dir).then(
      () => true,
      () => {
        // GNU `cp -al` links off the loop in a child; BSD cp has no -l, so the in-process walk is the fallback.
        rmSync(modules, { recursive: true, force: true });
        try {
          link(join(activeDir, "node_modules"), modules);
          return true;
        } catch {
          // EXDEV: the boot checkout and the slots are separate bind mounts, so neither can link; install instead.
          rmSync(modules, { recursive: true, force: true });
          return false;
        }
      },
    );
    if (linked) {
      writeMarker(dir, want);
      return "linked";
    }
  }
  await run("npm", ["ci", "--no-audit", "--no-fund"], dir);
  writeMarker(dir, want);
  return "installed";
}

export const CHILD_ENTRY_BUILD_SCRIPT = "scripts/build-child-entries.mjs";
export interface SlotChildEntries {
  /** `absent`: the tree predates the script (an older sha). `failed`: the build exited non-zero; `reason` is its first line. */
  outcome: "built" | "absent" | "failed";
  reason?: string;
  /** W1-T10058, on `built` only: true when the existing build was verified current and not rebuilt. */
  reused?: boolean;
  /** W1-T10058: why the existing build could not be reused, when it was rebuilt. */
  stale?: string;
  ms: number;
}

/**
 * W1-T10058: run in a child, in the tree, by its OWN build module. Every declared child entry and every declared worker
 * bundle must be current against one source hash; `--check` alone judges the child entries and never the workers.
 */
const QUALIFY_SLOT_BUILD = `
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const m = await import(pathToFileURL(resolve(${JSON.stringify(CHILD_ENTRY_BUILD_SCRIPT)})).href);
const ok = typeof m.sourceHash === "function" && typeof m.childEntryIsCurrent === "function" && typeof m.workerBundle === "function" &&
  Array.isArray(m.CHILD_ENTRIES) && m.CHILD_ENTRIES.length > 0 && Array.isArray(m.WORKER_ENTRIES) && m.WORKER_ENTRIES.length > 0;
let verdict = { current: false, reason: "check-unsupported" };
if (ok) {
  const treeHash = m.sourceHash(".");
  const judged = [
    ...m.CHILD_ENTRIES.map((e) => ["child " + e.name, m.childEntryIsCurrent(".", e.name, { treeHash })]),
    ...m.WORKER_ENTRIES.map((w) => ["worker " + w, m.workerBundle(".", w, { treeHash })]),
  ];
  const stale = judged.find(([, v]) => v?.current !== true);
  verdict = stale ? { current: false, reason: stale[0] + ": " + stale[1]?.reason } : { current: true, children: m.CHILD_ENTRIES.length, workers: m.WORKER_ENTRIES.length };
}
process.stdout.write(JSON.stringify(verdict) + "\\n");
`;

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);

/**
 * W1-T10058: whether `dir`'s existing build may be reused. Only the child's positive, complete verdict qualifies: a failed
 * or unsupported check, or output that is not that verdict, reads as not current, so the caller builds.
 */
export async function qualifySlotChildEntries(dir: string, run: RunCommand = runCommand): Promise<{ current: boolean; reason: string }> {
  let stdout: string;
  try {
    stdout = await run(process.execPath, ["--input-type=module", "-e", QUALIFY_SLOT_BUILD], dir);
  } catch (err) {
    return { current: false, reason: `check-failed: ${firstLine(err)}` };
  }
  let verdict: { current?: unknown; reason?: unknown; children?: unknown; workers?: unknown };
  try {
    verdict = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch (err) {
    return { current: false, reason: `check-output-malformed: ${firstLine(err).slice(0, 80)}` };
  }
  const counted = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
  if (verdict?.current === true && counted(verdict.children) && counted(verdict.workers)) return { current: true, reason: "current" };
  return { current: false, reason: typeof verdict?.reason === "string" ? verdict.reason.slice(0, 200) : "check-output-malformed" };
}

/**
 * W1-T9421: builds `dir`'s child entries and worker bundles with its own build script, in a child process so its memory is
 * never serve's. W1-T10058: a build the tree's own validators find wholly current is reused, not rebuilt. Never throws: a tree without the script, or a failed build, leaves the workers on their .ts source, and the
 * build removes its manifest before it writes, so a failed build never leaves a stale bundle vouched for.
 */
export async function buildSlotChildEntries(dir: string, run: RunCommand = runCommand, clock: Clock = systemClock): Promise<SlotChildEntries> {
  const started = clock.now();
  if (!existsSync(join(dir, CHILD_ENTRY_BUILD_SCRIPT))) return { outcome: "absent", ms: clock.now() - started };
  const qualified = await qualifySlotChildEntries(dir, run);
  if (qualified.current) return { outcome: "built", reused: true, ms: clock.now() - started };
  try {
    await run(process.execPath, [CHILD_ENTRY_BUILD_SCRIPT], dir);
    return { outcome: "built", reused: false, stale: qualified.reason, ms: clock.now() - started };
  } catch (err) {
    return { outcome: "failed", reason: firstLine(err), ms: clock.now() - started };
  }
}

/**
 * Why `dir` cannot be reused as a worktree of `repoDir`, or undefined when it can. A `.git` file is
 * not proof: its admin dir can be pruned away (2026-10-02, every handoff aborted at checkout), or it
 * can belong to a different clone than the one the supervisor fetches into.
 */
async function slotUnfit(dir: string, repoDir: string, run: RunCommand): Promise<{ reason: string; detail?: string } | undefined> {
  if (!existsSync(join(dir, ".git"))) return { reason: "absent" };
  try {
    await run("git", ["-C", dir, "rev-parse", "--git-dir"], dir);
  } catch (err) {
    return { reason: "dangling_git_link", detail: err instanceof Error ? err.message : String(err) };
  }
  const listed = (await run("git", ["-C", repoDir, "worktree", "list", "--porcelain"], repoDir))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .map((path) => (existsSync(path) ? realpathSync(path) : path));
  return listed.includes(realpathSync(dir)) ? undefined : { reason: "foreign_worktree", detail: `not in ${repoDir}'s worktree list` };
}

/**
 * Prepares the slot that is not `activeDir` at origin's newest main; ledgers whether the slot was reused or (re)created, and why.
 * Before the fetch, stale maintenance leftovers of a killed gc are removed (src/lib/git-lock-reclaim.ts): left in place they
 * make every fetch's automatic maintenance a silent no-op (2026-10-06: 40,208 loose objects, 1.54 GiB, in a week).
 */
export function createSlotPreparer(opts: { repoDir: string; gensDir: string; run?: RunCommand; log?: ServeSupervisorOptions["log"]; lockReclaim?: StaleLockReclaimOptions }): (activeDir: string) => Promise<PreparedSlot> {
  const run = opts.run ?? runCommand;
  const log = opts.log ?? (() => undefined);
  return async (activeDir) => {
    const gitDir = resolve(opts.repoDir, (await run("git", ["-C", opts.repoDir, "rev-parse", "--git-common-dir"], opts.repoDir)).trim());
    const reclaim = await reclaimStaleGitLocks(gitDir, opts.lockReclaim);
    if (reclaim.removed.length > 0 || reclaim.failed !== undefined) log("serve.slot_git_lock_reclaimed", { git_dir: gitDir, removed: reclaim.removed, failed: reclaim.failed });
    if (reclaim.refused !== undefined) log("serve.slot_git_lock_reclaim_refused", { git_dir: gitDir, ...reclaim.refused });
    await run("git", ["-C", opts.repoDir, "fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"], opts.repoDir);
    const sha = (await run("git", ["-C", opts.repoDir, "rev-parse", "refs/remotes/origin/main"], opts.repoDir)).trim();
    const dir = SLOT_NAMES.map((name) => join(opts.gensDir, name)).find((candidate) => resolve(candidate) !== resolve(activeDir)) as string;
    const unfit = await slotUnfit(dir, opts.repoDir, run);
    log("serve.slot_prepare", { slot: dir, sha, path: unfit === undefined ? "reused" : unfit.reason === "absent" ? "created" : "recreated", reason: unfit?.reason, detail: unfit?.detail });
    if (unfit === undefined) {
      await run("git", ["-C", dir, "checkout", "--quiet", "--detach", "--force", sha], dir);
      await run("git", ["-C", dir, "reset", "--quiet", "--hard", sha], dir);
    } else {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(opts.gensDir, { recursive: true });
      await run("git", ["-C", opts.repoDir, "worktree", "prune"], opts.repoDir);
      await run("git", ["-C", opts.repoDir, "worktree", "add", "--quiet", "--detach", "--force", dir, sha], opts.repoDir);
    }
    const deps = await prepareSlotDeps(dir, activeDir, run);
    log("serve.slot_child_entries", { slot: dir, sha, ...(await buildSlotChildEntries(dir, run)) });
    return { dir, sha, deps };
  };
}
