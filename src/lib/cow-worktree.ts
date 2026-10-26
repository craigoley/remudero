/**
 * lib/cow-worktree.ts — W1-T10257: a worktree whose unchanged files are CLONED from the operator checkout.
 *
 * A fresh `git worktree add` writes ~128 MB of tracked files the operator checkout already holds. On
 * APFS a `cp -c` clone shares those blocks (a clone of test/ cost ~3 MB of free space for 57 MB of files),
 * so {@link addCowWorktree} cuts the worktree with `--no-checkout`, clones every tracked regular file the
 * donor holds UNCHANGED (index blob equals the base's blob, working file not dirty), and lets git write
 * the rest. The result is always a correct checkout of `base`: a clone that is wrong is caught by
 * `git status` and rewritten, and a volume that cannot clone gets a plain `git worktree add`.
 *
 * The free-space figures are a shared-filesystem observation (other writers drift the same volume), not a
 * per-job attribution and not proof of reclaimable bytes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statfsSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface GitRun {
  ok: boolean;
  stdout: string;
  detail: string;
}

export interface CloneRun {
  ok: boolean;
  detail: string;
}

/** The seams: git, bulk file cloning and statfs — tests inject them. */
export interface CowWorktreePort {
  /** Run `git <args>` with `cwd` as its working directory. */
  git(args: string[], cwd: string): GitRun;
  /** Clone each of `names` (relative to `srcDir`) into the existing directory `dstDir`. */
  cloneFiles(srcDir: string, dstDir: string, names: string[]): CloneRun;
  /** Bytes available to an unprivileged writer on the filesystem holding `path`. */
  freeBytes(path: string): number;
}

export interface CowWorktreeRequest {
  /** The checkout the worktree is registered with. */
  repoDir: string;
  /** Absolute directory the worktree is created in; it must not exist yet. */
  dir: string;
  branch: string;
  /** The commit-ish the branch is cut from. */
  base: string;
  /** The checkout whose unchanged files are cloned. */
  donorDir: string;
  port?: CowWorktreePort;
}

export interface CowWorktreeResult {
  method: "clone" | "checkout";
  /** Files cloned from the donor. */
  cloned: number;
  /** Tracked paths git wrote itself (the base's tracked paths minus the cloned ones). */
  written: number;
  freeBytesBefore: number;
  freeBytesAfter: number;
  /** Set when the clone pass left a dirty status and a forced rewrite repaired it. */
  reconciledByRewrite: boolean;
  /** Why the method is `checkout`, or null for a clone. */
  fallbackReason: string | null;
}

const CLONE_BATCH = 400;
const CLONE_MODES = new Set(["100644", "100755"]);

function gitRun(args: string[], cwd: string): GitRun {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 300_000, maxBuffer: 256 * 1024 * 1024 });
  const detail = r.error ? r.error.message : (r.stderr || r.stdout || `exit ${r.status}`).trim();
  return { ok: r.error === undefined && r.status === 0, stdout: r.stdout ?? "", detail };
}

/** The platform's copy-on-write cp invocation, or null where no verified backend exists. */
export function cloneCpArgs(platform: NodeJS.Platform): string[] | null {
  if (platform === "darwin") return ["-c"]; // Apple cp -c: clonefile(2)
  if (platform === "linux") return ["--reflink=always"]; // fails on a filesystem without reflink
  return null;
}

function cpCloneFiles(srcDir: string, dstDir: string, names: string[]): CloneRun {
  const flags = cloneCpArgs(process.platform);
  if (flags === null) return { ok: false, detail: `no verified clone backend on ${process.platform}` };
  const r = spawnSync("cp", [...flags, "--", ...names, `${dstDir}/`], { cwd: srcDir, encoding: "utf8", timeout: 300_000 });
  const detail = r.error ? r.error.message : (r.stderr || `exit ${r.status}`).trim();
  return { ok: r.error === undefined && r.status === 0, detail };
}

export const defaultCowWorktreePort: CowWorktreePort = {
  git: gitRun,
  cloneFiles: cpCloneFiles,
  freeBytes: (path) => {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  },
};

function nearestExisting(path: string): string {
  let at = resolve(path);
  while (!existsSync(at)) at = dirname(at);
  return at;
}

function gitOrThrow(port: CowWorktreePort, args: string[], cwd: string): string {
  const r = port.git(args, cwd);
  if (!r.ok) throw new Error(`git ${args.slice(0, 2).join(" ")} failed: ${r.detail}`);
  return r.stdout;
}

/** `<mode> <sha> <stage>\t<path>` records of `git ls-files -s -z`, stage 0 only. */
function donorEntries(out: string): Map<string, { mode: string; sha: string }> {
  const map = new Map<string, { mode: string; sha: string }>();
  for (const rec of out.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const [mode, sha, stage] = rec.slice(0, tab).split(" ");
    if (stage === "0") map.set(rec.slice(tab + 1), { mode, sha });
  }
  return map;
}

/** `<mode> <type> <sha>\t<path>` records of `git ls-tree -r -z`. */
function baseEntries(out: string): Map<string, { mode: string; sha: string }> {
  const map = new Map<string, { mode: string; sha: string }>();
  for (const rec of out.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , sha] = rec.slice(0, tab).split(" ");
    map.set(rec.slice(tab + 1), { mode, sha });
  }
  return map;
}

/** The tracked regular files the donor holds exactly as `base` does; the donor's edits never qualify. */
function selectClonePaths(port: CowWorktreePort, req: CowWorktreeRequest): { paths: string[]; baseTotal: number } {
  const base = baseEntries(gitOrThrow(port, ["ls-tree", "-r", "-z", "--full-tree", req.base], req.repoDir));
  const donor = donorEntries(gitOrThrow(port, ["ls-files", "-s", "-z"], req.donorDir));
  const dirty = new Set(gitOrThrow(port, ["diff-files", "--name-only", "-z"], req.donorDir).split("\0").filter(Boolean));
  const paths: string[] = [];
  for (const [path, want] of base) {
    const have = donor.get(path);
    if (have === undefined || !CLONE_MODES.has(want.mode) || have.mode !== want.mode || have.sha !== want.sha) continue;
    if (dirty.has(path) || path.startsWith("/") || path.split("/").includes("..")) continue;
    const st = lstatSync(join(req.donorDir, path), { throwIfNoEntry: false });
    if (st?.isFile()) paths.push(path);
  }
  return { paths, baseTotal: base.size };
}

/** Why the target volume cannot clone the donor's files, or null when one real clone succeeded there. */
function probeClone(port: CowWorktreePort, req: CowWorktreeRequest, sample: string): string | null {
  const probeDir = mkdtempSync(join(nearestExisting(req.dir), ".rmd-cow-probe-"));
  try {
    const r = port.cloneFiles(req.donorDir, probeDir, [sample]);
    return r.ok ? null : r.detail;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

/** The one raw `git worktree add`: `--no-checkout` when clones will fill the tree, a plain add otherwise. */
function gitWorktreeAdd(port: CowWorktreePort, req: CowWorktreeRequest, noCheckout: boolean): void {
  const flags = noCheckout ? ["--quiet", "--no-checkout"] : ["--quiet"];
  gitOrThrow(port, ["worktree", "add", ...flags, "--no-track", "-b", req.branch, req.dir, req.base], req.repoDir);
}

function dirtyStatus(port: CowWorktreePort, dir: string): string[] {
  gitOrThrow(port, ["update-index", "-q", "--refresh"], dir);
  const out = gitOrThrow(port, ["status", "--porcelain", "--untracked-files=all"], dir);
  return out.split("\n").filter((line) => line !== "" && !/(^|\/)node_modules\/?$/.test(line.slice(3)));
}

function cloneInto(port: CowWorktreePort, req: CowWorktreeRequest, paths: string[]): number {
  const byDir = new Map<string, string[]>();
  for (const path of paths) {
    const dir = dirname(path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), path]);
  }
  let cloned = 0;
  for (const [relDir, files] of byDir) {
    const dst = join(req.dir, relDir);
    mkdirSync(dst, { recursive: true });
    for (let i = 0; i < files.length; i += CLONE_BATCH) {
      const batch = files.slice(i, i + CLONE_BATCH);
      const r = port.cloneFiles(req.donorDir, dst, batch);
      // a failed batch may have cloned a prefix; git writes whatever is missing, so count what exists
      cloned += r.ok ? batch.length : batch.filter((p) => existsSync(join(req.dir, p))).length;
    }
  }
  return cloned;
}

/**
 * Cut `req.dir` as a worktree of `req.repoDir` on a new `req.branch` at `req.base`, cloning the donor's
 * unchanged tracked files. Throws when git itself cannot make the worktree.
 */
export function addCowWorktree(req: CowWorktreeRequest): CowWorktreeResult {
  const port = req.port ?? defaultCowWorktreePort;
  const space = nearestExisting(req.dir);
  const freeBytesBefore = port.freeBytes(space);
  const { paths, baseTotal } = selectClonePaths(port, req);
  const fallbackReason = paths.length === 0 ? "no unchanged donor file to clone" : probeClone(port, req, paths[0]);
  if (fallbackReason !== null) {
    gitWorktreeAdd(port, req, false);
    return {
      method: "checkout", cloned: 0, written: baseTotal, freeBytesBefore, reconciledByRewrite: false,
      freeBytesAfter: port.freeBytes(space), fallbackReason,
    };
  }
  gitWorktreeAdd(port, req, true);
  const cloned = cloneInto(port, req, paths);
  gitOrThrow(port, ["read-tree", req.base], req.dir);
  // exits 1 when a cloned file already exists (the fresh index holds no stat data to call it up to date):
  // the exit is not evidence either way, the refreshed status below is, and a forced rewrite repairs it
  port.git(["checkout-index", "-a", "-q"], req.dir);
  let reconciledByRewrite = false;
  const leftover = dirtyStatus(port, req.dir);
  if (leftover.length > 0) {
    gitOrThrow(port, ["checkout-index", "-a", "-f", "-q"], req.dir);
    const still = dirtyStatus(port, req.dir);
    if (still.length > 0) throw new Error(`worktree ${req.dir} is not a clean checkout of ${req.base}: ${still.slice(0, 5).join("; ")}`);
    reconciledByRewrite = true;
  }
  return {
    method: "clone", cloned, written: Math.max(0, baseTotal - cloned), freeBytesBefore, reconciledByRewrite,
    freeBytesAfter: port.freeBytes(space), fallbackReason: null,
  };
}

/** The operator-facing lines for a made worktree; the delta is a shared-volume observation. */
export function renderCowWorktree(dir: string, branch: string, r: CowWorktreeResult): string {
  const delta = r.freeBytesBefore - r.freeBytesAfter;
  const lines = [`path:   ${dir}`, `branch: ${branch} (no upstream; push with \`git push -u origin HEAD\`)`];
  lines.push(`method: ${r.method}${r.reconciledByRewrite ? " (reconciled-by-rewrite)" : ""}`);
  if (r.fallbackReason !== null) lines.push(`  fell back to a normal checkout: ${r.fallbackReason}`);
  lines.push(`files:  ${r.cloned} cloned, ${r.written} written by git`);
  lines.push(`df:     ${(delta / 1024 ** 2).toFixed(1)} MiB less free on the target volume (a shared-volume observation, other writers included)`);
  return lines.join("\n");
}

/** The repo's main worktree (the operator checkout): the first record of `git worktree list --porcelain`. */
export function mainWorktreeOf(repoDir: string, port: CowWorktreePort = defaultCowWorktreePort): string {
  const first = gitOrThrow(port, ["worktree", "list", "--porcelain"], repoDir).split("\n")[0] ?? "";
  if (!first.startsWith("worktree ")) throw new Error(`cannot find the main worktree of ${repoDir}`);
  return first.slice("worktree ".length);
}

/** Symlink the donor's node_modules into `dir`, as the house rule does; false when there is nothing to link. */
export function linkDonorNodeModules(donorDir: string, dir: string): boolean {
  const from = join(donorDir, "node_modules");
  const to = join(dir, "node_modules");
  if (!existsSync(from) || existsSync(to)) return false;
  symlinkSync(from, to);
  return true;
}
