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
 */
import { execFile } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
      if (err) reject(new Error(`${command} ${args.join(" ")} failed in ${cwd}: ${stderr.trim() || err.message}`));
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

/** Prepares the slot that is not `activeDir` at origin's newest main; ledgers whether the slot was reused or (re)created, and why. */
export function createSlotPreparer(opts: { repoDir: string; gensDir: string; run?: RunCommand; log?: ServeSupervisorOptions["log"] }): (activeDir: string) => Promise<PreparedSlot> {
  const run = opts.run ?? runCommand;
  const log = opts.log ?? (() => undefined);
  return async (activeDir) => {
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
    return { dir, sha, deps };
  };
}
