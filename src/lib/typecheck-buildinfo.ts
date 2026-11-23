/**
 * THE FLEET'S FULL TYPE-CHECK IS INCREMENTAL, PER WORKTREE, AND STARTS WARM. A cold check of src plus ~3,000 test files
 * peaked at 3.0–3.7 GB RSS in the daemon container (2026-10-09); against its own buildinfo it reports the identical
 * diagnostics — tsc keys every cached result by file hash and dependency graph — but peaks no lower (W1-T14153,
 * {@link TYPECHECK_WARM_PEAK_BYTES}). Measurements: the PR that added this module.
 *
 * WHERE THE BUILDINFO LIVES. In the checkout's own git directory (`.git/`, or `.git/worktrees/<name>/` for a linked
 * worktree): per worktree, invisible to `git status` and every `git ls-files` census, never committable, gone with the
 * worktree. A tree with no git directory runs the plain check.
 *
 * WHY A SEED NEEDS REBASING. tsc writes every buildinfo path relative to the buildinfo, resolving `node_modules` through
 * its symlink. A fleet worktree at `worktrees/<id>` links the canonical checkout's `node_modules`, so a verbatim seed's
 * `./node_modules/...` names nothing and the first check runs cold. Tree files keep their tree-relative path; anything
 * outside the tree (its `node_modules` and git directory included) keeps its absolute location.
 *
 * A SEED CAN ONLY COST TIME, NEVER CHANGE A RESULT: tsc discards any cached entry whose hash, options or version differ.
 * Node builtins only, so it loads directly under Node's type stripping.
 */
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The buildinfo's file name inside a checkout's git directory. */
export const TYPECHECK_BUILDINFO_NAME = "rmd-typecheck.tsbuildinfo";

/** The peak a COLD full check is expected to reach: the memory one typecheck slot asks the host for. An estimate of
 *  the run, not a limit. OPERATOR DECISION (ruling 2026-10-20), raised from 2.5 GiB: MEASURED 2026-10-20 on the fleet
 *  host, a cold full check of this repo with `declaration` off and {@link TYPECHECK_GOMEMLIMIT} peaked at 3.0–3.2 GB
 *  (RSS 3.0 GB, cgroup peak 3.15 GB); 2.5 GiB (from two 2026-10-10 worker runs at 2.4 and 2.2 GB) undercounted it.
 *  Measurements: PR 13113. */
export const TYPECHECK_COLD_PEAK_BYTES = 3.25 * 1024 ** 3;
/** A warm check's expected peak: the cold one. OBSERVED 2026-11-21 on the fleet host: warm checks in fix trees held
 *  1644–3789 MiB RSS each, as much as a cold check; 2026-10-20's 1.6–1.7 GB (`declaration` off) is history. An
 *  estimate, not a limit (W1-T14153). */
export const TYPECHECK_WARM_PEAK_BYTES = TYPECHECK_COLD_PEAK_BYTES;
/** The peak one tsc run names to its memory admission: the warm or the cold one. */
export function typecheckPeakBytes(warm: boolean): number {
  return warm ? TYPECHECK_WARM_PEAK_BYTES : TYPECHECK_COLD_PEAK_BYTES;
}

/** W1-T14145: the fewest measured warm rows a learned warm peak needs, and the most recent ones it reads. */
export const TYPECHECK_WARM_PEAK_MIN_ROWS = 50;
const TYPECHECK_WARM_PEAK_WINDOW = 200;
const TYPECHECK_PEAK_TAIL_BYTES = 8 * 1024 ** 2;

/** The warm peak a warm check names to its headroom admission (W1-T14145): the p95 of the last
 *  {@link TYPECHECK_WARM_PEAK_WINDOW} measured warm typecheck.peak rows in the ledger's bounded tail. With fewer than
 *  {@link TYPECHECK_WARM_PEAK_MIN_ROWS}, or no readable ledger, it is {@link TYPECHECK_COLD_PEAK_BYTES} (fail closed). */
export function learnedTypecheckWarmPeakBytes(ledgerPath: string): number {
  let text: string;
  try {
    const fd = openSync(ledgerPath, "r");
    try {
      const size = fstatSync(fd).size, length = Math.min(size, TYPECHECK_PEAK_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, size - length);
      text = buffer.subarray(0, read).toString("utf8");
      if (length < size) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    // No ledger yet is the common fresh-host case and names nothing; any other failure is said once per check.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(`typecheck: the warm peak could not be learned (${String(error)}); admitting at the cold peak\n`);
    }
    return TYPECHECK_COLD_PEAK_BYTES;
  }
  const peaks: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"typecheck.peak"')) continue;
    try {
      const row = JSON.parse(line) as Partial<TypecheckPeakRow>;
      const peak = row.peak_rss_bytes;
      if (row.step === "typecheck.peak" && row.warm === true && typeof peak === "number" && Number.isSafeInteger(peak) && peak > 0) peaks.push(peak);
    } catch {
      // A torn or foreign line names no peak; it is skipped like an "unknown" one.
    }
  }
  const recent = peaks.slice(-TYPECHECK_WARM_PEAK_WINDOW).sort((a, b) => a - b);
  if (recent.length < TYPECHECK_WARM_PEAK_MIN_ROWS) return TYPECHECK_COLD_PEAK_BYTES;
  return recent[Math.ceil(0.95 * recent.length) - 1]!;
}

/**
 * OPERATOR DECISION (ruling 2026-10-20): the Go soft memory limit every tsc spawn runs under unless `GOMEMLIMIT` is
 * already set. TS 7's compiler is a Go program, so as its heap nears the limit the GC works harder instead of letting
 * the heap grow. MEASURED 2026-10-20 on the fleet host (tsc 7.0.2, a cold full check of this repo, each run alone in a
 * capped scope): memory demand (cgroup peak + swap) 6.2–6.8 GB by default, 4.4–5.2 GB under 3GiB; with `declaration`
 * off as well, 3.2 GB against 3.4–3.6 GB without the limit, at 12–15 s wall against 10 s. It is the effective knob:
 * {@link lowMemoryTypecheckArgs}'s fewer checkers buy only ~0.1–0.2 GB. PRIMARY CONTROL on a check's Go heap, and a
 * SOFT one, never a kill: a check that needs more still finishes, with more collections. `GOMEMLIMIT=off` opts one run
 * out. Measurements: PR 13113.
 */
export const TYPECHECK_GOMEMLIMIT = "3GiB";

/** `env` for a tsc child: {@link TYPECHECK_GOMEMLIMIT} unless a limit is set. `explicit` is the caller's own limit,
 *  `env`'s by default; a caller whose child env is an allowlist (which drops `GOMEMLIMIT`) passes its parent's. */
export function typecheckEnv<E extends Record<string, string | undefined>>(
  env: E,
  explicit: string | undefined = env.GOMEMLIMIT,
): E & { GOMEMLIMIT: string } {
  return { ...env, GOMEMLIMIT: explicit ?? TYPECHECK_GOMEMLIMIT };
}

/** tsc 7's own checker count when no `--checkers` is passed. */
export const TSC_DEFAULT_CHECKERS = 4;
/** The fewest checkers a tight check drops to: MEASURED 2026-10-10 (this repo, cold, 5 runs each), `--checkers 2` peaked
 *  7–10% below the default's Go heap while one checker and `--singleThreaded` peaked no lower; `GOGC=50` changed nothing. */
export const TSC_LOW_MEMORY_MIN_CHECKERS = 2;

/** Extra tsc argv for a check expected to peak at `peakBytes` with `headroom` bytes left: none while the headroom holds
 *  the peak (or reads nothing), else fewer checkers in proportion to the shortfall. Diagnostics are the same; a
 *  buildinfo stays warm across checker counts (tsc keys it by compiler options, which `--checkers` is not). */
export function lowMemoryTypecheckArgs(headroom: number | undefined, peakBytes: number): string[] {
  if (headroom === undefined || !Number.isFinite(headroom) || headroom >= peakBytes) return [];
  const checkers = Math.max(TSC_LOW_MEMORY_MIN_CHECKERS, Math.floor((TSC_DEFAULT_CHECKERS * Math.max(0, headroom)) / peakBytes));
  return checkers >= TSC_DEFAULT_CHECKERS ? [] : ["--checkers", String(checkers)];
}

/** The argv tail of the fleet's full type-check. `buildInfo` undefined is the plain, non-incremental check. */
export function typecheckArgs(buildInfo: string | undefined): string[] {
  const base = ["-p", "tsconfig.json", "--noEmit"];
  return buildInfo === undefined ? base : [...base, "--incremental", "--tsBuildInfoFile", buildInfo];
}

/** `root`'s git directory: `.git` itself, or the target of a linked worktree's `gitdir:` file. */
export function gitDirOf(root: string): string | undefined {
  const dotGit = join(root, ".git");
  let text: string;
  try {
    text = readFileSync(dotGit, "utf8"); // one read, no stat-then-read race: a directory answers EISDIR
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EISDIR") return dotGit;
    // No readable `.git`: this tree has no git directory to keep a buildinfo in, so it runs the plain check.
    return undefined;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (m === null) return undefined;
  const dir = resolve(root, m[1]!);
  return existsSync(dir) ? dir : undefined;
}

/** Where `root`'s own buildinfo lives, or undefined when `root` has no git directory. */
export function worktreeBuildInfoPath(root: string): string | undefined {
  const gitDir = gitDirOf(root);
  return gitDir === undefined ? undefined : join(gitDir, TYPECHECK_BUILDINFO_NAME);
}

/** The canonical checkout behind `root` and its buildinfo — the seed every worktree of it starts from. For a canonical
 *  checkout that is `root` itself. Undefined with no git directory, or a bare common directory (no tree to check). */
export function canonicalBuildInfo(root: string): { root: string; buildInfo: string } | undefined {
  const gitDir = gitDirOf(root);
  if (gitDir === undefined) return undefined;
  const commondir = join(gitDir, "commondir");
  if (!existsSync(commondir)) return basename(gitDir) === ".git" ? { root, buildInfo: join(gitDir, TYPECHECK_BUILDINFO_NAME) } : undefined;
  let common: string;
  try {
    common = resolve(gitDir, readFileSync(commondir, "utf8").trim());
  } catch {
    // An unreadable commondir names no canonical checkout, so there is no seed to look for.
    return undefined;
  }
  if (basename(common) !== ".git") return undefined;
  return { root: dirname(common), buildInfo: join(common, TYPECHECK_BUILDINFO_NAME) };
}

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep);

/** tsc's spelling of a path relative to the buildinfo: `./x` below it, `../x` above it. */
function tscRelative(fromDir: string, abs: string): string {
  const rel = relative(fromDir, abs).split(sep).join("/");
  if (rel === "") return ".";
  return rel.startsWith("../") || rel === ".." ? rel : `./${rel}`;
}

/** Rebase one buildinfo path. A bare name (`lib.es5.d.ts`) is tsc's bundled lib and has no location. */
function rebasePath(p: string, from: { root: string; dir: string }, to: { root: string; dir: string }): string {
  if (p !== "." && p !== ".." && !p.startsWith("./") && !p.startsWith("../") && !isAbsolute(p)) return p;
  const abs = resolve(from.dir, p);
  const inTree = within(abs, from.root) && !within(abs, join(from.root, "node_modules")) && !within(abs, join(from.root, ".git"));
  return tscRelative(to.dir, inTree ? join(to.root, relative(from.root, abs)) : abs);
}

const PATH_LIST_FIELDS = ["fileNames", "packageJsons", "missingPackageJsons"] as const;

/**
 * Rewrite a buildinfo written for `from` (its tree root and the buildinfo's own path) so it reads correctly at `to`.
 * Returns undefined when the text is not a buildinfo for `tsVersion` — tsc would discard it anyway.
 */
export function rebaseBuildInfo(
  text: string,
  from: { root: string; buildInfo: string },
  to: { root: string; buildInfo: string },
  tsVersion: string,
): string | undefined {
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON: not a buildinfo tsc could use either, so there is nothing to seed from.
    return undefined;
  }
  if (info === null || typeof info !== "object" || info.version !== tsVersion) return undefined;
  const src = { root: resolve(from.root), dir: dirname(resolve(from.buildInfo)) };
  const dst = { root: resolve(to.root), dir: dirname(resolve(to.buildInfo)) };
  for (const field of PATH_LIST_FIELDS) {
    const list = info[field];
    if (Array.isArray(list)) info[field] = list.map((p) => (typeof p === "string" ? rebasePath(p, src, dst) : p));
  }
  const options = info.options;
  if (options !== null && typeof options === "object" && !Array.isArray(options)) {
    const opts = options as Record<string, unknown>;
    for (const [key, value] of Object.entries(opts)) {
      if (typeof value === "string") opts[key] = rebasePath(value, src, dst);
    }
    if (typeof opts.tsBuildInfoFile === "string") opts.tsBuildInfoFile = tscRelative(dst.dir, resolve(to.buildInfo));
  }
  return JSON.stringify(info);
}

/** The TypeScript version installed for `root`, or undefined when there is none to read. */
export function installedTypescriptVersion(root: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "node_modules", "typescript", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    // No readable typescript install: no version to match a seed against, so no seed is written.
    return undefined;
  }
}

export type SeedOutcome = "kept" | "seeded" | "published" | "no-seed" | "mismatch" | "unwritable";

export function hasUsableTypecheckBuildInfo(buildInfo: string | undefined, tsVersion: string | undefined): boolean {
  if (buildInfo === undefined || tsVersion === undefined || !existsSync(buildInfo)) return false;
  try {
    const info = JSON.parse(readFileSync(buildInfo, "utf8"));
    return info !== null && typeof info === "object" && info.version === tsVersion &&
      Array.isArray(info.fileNames) && info.fileNames.length > 0 && info.fileNames.every((name: unknown) => typeof name === "string") &&
      Array.isArray(info.fileInfos) && info.fileInfos.length === info.fileNames.length;
  } catch (error) {
    process.stderr.write(JSON.stringify({ step: "typecheck.buildinfo_unusable", buildInfo, reason: String(error) }) + "\n");
    return false;
  }
}

/**
 * Write `from`'s buildinfo, rebased, at `to.buildInfo` — replacing whatever is there. Via a temp file and rename, so a
 * concurrent check never reads half a buildinfo.
 */
export function publishBuildInfo(
  from: { root: string; buildInfo: string },
  to: { root: string; buildInfo: string },
  tsVersion: string | undefined,
): SeedOutcome {
  if (tsVersion === undefined || !existsSync(from.buildInfo)) return "no-seed";
  try {
    const rebased = rebaseBuildInfo(readFileSync(from.buildInfo, "utf8"), from, to, tsVersion);
    if (rebased === undefined) return "mismatch";
    const tmp = `${to.buildInfo}.${process.pid}.tmp`;
    writeFileSync(tmp, rebased);
    renameSync(tmp, to.buildInfo);
    return "published";
  } catch {
    // Distinct from "no-seed": the seed existed and could not be read or written. Either way the check runs cold —
    // a seed is an optimisation, never a precondition.
    return "unwritable";
  }
}

/**
 * Give `to.buildInfo` a warm start from `from` when it has none yet. An existing buildinfo is the target's own, newer
 * history and is kept.
 */
export function seedBuildInfo(
  from: { root: string; buildInfo: string },
  to: { root: string; buildInfo: string },
  tsVersion: string | undefined,
): SeedOutcome {
  if (existsSync(to.buildInfo)) return "kept";
  const outcome = publishBuildInfo(from, to, tsVersion);
  return outcome === "published" ? "seeded" : outcome;
}

/** The checkout that holds the install `root`'s `node_modules` resolves to — the fleet's install root — if any. */
export function modulesOwnerRoot(root: string): string | undefined {
  try {
    const real = realpathSync(join(root, "node_modules"));
    return basename(real) === "node_modules" ? dirname(real) : undefined;
  } catch {
    // No node_modules at all: no checkout's check ran against this tree's compiler.
    return undefined;
  }
}

/**
 * Refresh the seed of the canonical checkout behind `root` from the buildinfo of the checkout whose `node_modules`
 * `root` links, whenever that one is newer. WHY: the fleet cuts implement worktrees from `<config.root>/repos/<repo>`,
 * which runs no check of its own, while the checks that write a buildinfo (the sweep's merge probe, whose worktrees hang
 * off the install root) all write the install root's — so `repos/<repo>` never had a seed and every worker's first
 * check ran cold (OBSERVED 2026-10-10). Run by the harness as it cuts a worktree, where that git dir is writable.
 */
export function refreshCanonicalSeed(root: string): SeedOutcome {
  const canonical = canonicalBuildInfo(root);
  const owner = modulesOwnerRoot(root);
  const donor = owner === undefined ? undefined : worktreeBuildInfoPath(owner);
  if (canonical === undefined || owner === undefined || donor === undefined || resolve(donor) === resolve(canonical.buildInfo)) return "no-seed";
  try {
    if (statSync(canonical.buildInfo).mtimeMs >= statSync(donor).mtimeMs) return "kept";
  } catch {
    // One side is absent: a missing seed is published below, a missing donor answers "no-seed" there.
  }
  return publishBuildInfo({ root: owner, buildInfo: donor }, canonical, installedTypescriptVersion(root));
}

/**
 * Seed `buildInfo` — the check of the tree at `root` — from the canonical checkout behind `root`, when it has none yet.
 * The canonical checkout's own check needs no seed: its buildinfo IS the seed.
 */
export function seedFromCanonical(root: string, buildInfo: string): SeedOutcome {
  const canonical = canonicalBuildInfo(root);
  if (canonical === undefined || resolve(canonical.buildInfo) === resolve(buildInfo)) return "no-seed";
  return seedBuildInfo(canonical, { root, buildInfo }, installedTypescriptVersion(root));
}

/**
 * The full incremental check's argv tail for the checkout at `root`, seeding its buildinfo from the canonical
 * checkout's on first use. A tree with no git directory gets the plain check.
 */
export function prepareWorktreeTypecheck(root: string): { args: string[]; buildInfo?: string; seed: SeedOutcome } {
  const buildInfo = worktreeBuildInfoPath(root);
  if (buildInfo === undefined) return { args: typecheckArgs(undefined), seed: "no-seed" };
  return { args: typecheckArgs(buildInfo), buildInfo, seed: seedFromCanonical(root, buildInfo) };
}

export type TypecheckEntry = "npm" | "preflight" | "merge-probe" | "bwrap";

export interface TypecheckObservation {
  peak?: number;
  rechecked?: number;
}

export interface TypecheckPeakRow {
  step: "typecheck.peak";
  entry: TypecheckEntry;
  warm: boolean;
  peak_rss_bytes: number | "unknown";
  rechecked_files?: number;
  /** W1-T14145: how long the check's memory admission waited before tsc started. */
  waited_ms?: number;
}

const RECHECKED_FILES = /^(?:Files rechecked|Rechecked files):[ \t]*(\d+)[ \t]*\r?$/im;
const TYPECHECK_PEAK_MARKER = "\nrmd-typecheck-observation:";

export function recordTypecheckPeak(
  write: (row: TypecheckPeakRow) => void, entry: TypecheckEntry, warm: boolean,
  observation?: TypecheckObservation, output = "", waitedMs?: number,
): void {
  const peak = observation?.peak;
  const rechecked = observation?.rechecked ?? Number(RECHECKED_FILES.exec(output)?.[1]);
  const waited = waitedMs === undefined ? NaN : Math.round(waitedMs);
  const row: TypecheckPeakRow = {
    step: "typecheck.peak", entry, warm,
    peak_rss_bytes: peak !== undefined && Number.isSafeInteger(peak) && peak > 0 ? peak : "unknown",
    ...(Number.isSafeInteger(rechecked) && rechecked >= 0 ? { rechecked_files: rechecked } : {}),
    ...(Number.isSafeInteger(waited) && waited >= 0 ? { waited_ms: waited } : {}),
  };
  try {
    write(row);
  } catch (error) {
    process.stderr.write(`typecheck: could not record peak: ${String(error)}\n`);
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (entry !== "bwrap" && (code === "EACCES" || code === "EPERM" || code === "EROFS")) {
      // A Codex command has a read-only state mount. Its provider can record the bounded sample from command output.
      process.stderr.write(`\nrmd-typecheck-peak:${JSON.stringify(row)}\n`);
    }
  }
}

// Keep this function self-contained: the same sampler runs in the observer subprocess.
// TS 7's bin/tsc execs the native compiler, but the fleet's .bin/tsc shim also has a Node parent.
export function readTypecheckRss(pid: number, read: (path: string, encoding: "utf8") => string): number | undefined {
  const pending = [pid];
  while (pending.length > 0) {
    const current = pending.pop()!;
    try {
      const status = read(`/proc/${current}/status`, "utf8");
      if (/^Name:\s+tsc\s*$/m.test(status)) {
        const bytes = Number(/^VmHWM:[ \t]+(\d+) kB$/m.exec(status)?.[1]) * 1024;
        if (Number.isSafeInteger(bytes) && bytes > 0) return bytes;
      }
      const children = read(`/proc/${current}/task/${current}/children`, "utf8").match(/\d+/g) ?? [];
      for (const child of children) pending.push(Number(child));
    } catch {
      // The process exited between reads, or procfs is hidden. Keep the previous valid sample.
    }
  }
  return undefined;
}

export function watchTypecheckRss(pid: number | undefined): () => number | undefined {
  if (process.platform !== "linux" || pid === undefined) return () => undefined;
  let peak: number | undefined;
  const timer = setInterval(() => { peak = readTypecheckRss(pid, readFileSync) ?? peak; }, 20);
  return () => {
    clearInterval(timer);
    return peak;
  };
}

const TYPECHECK_OBSERVER = String.raw`
const { spawn } = require("node:child_process");
const { readFileSync, writeSync } = require("node:fs");
const { constants } = require("node:os");
const readPeak = (${readTypecheckRss.toString()});
const [mode, file, ...args] = process.argv.slice(1);
const child = spawn(file, args, { stdio: [0, mode === "stream" ? "pipe" : 1, 2] });
let peak, tail = "";
child.stdout?.on("data", chunk => { tail = (tail + chunk.toString()).slice(-16384); });
child.stdout?.pipe(process.stdout);
const timer = process.platform === "linux" && child.pid !== undefined
  ? setInterval(() => { peak = readPeak(child.pid, readFileSync) ?? peak; }, 20)
  : undefined;
const forwardTerm = () => child.kill("SIGTERM");
const forwardInt = () => child.kill("SIGINT");
process.on("SIGTERM", forwardTerm);
process.on("SIGINT", forwardInt);
let error;
child.on("error", err => { error = err.message; });
child.on("close", (status, signal) => {
  clearInterval(timer);
  const rechecked = Number(${RECHECKED_FILES}.exec(tail)?.[1]);
  try {
    writeSync(mode === "sandbox" ? 2 : 3, ${JSON.stringify(TYPECHECK_PEAK_MARKER)} +
      JSON.stringify({ peak, rechecked: Number.isSafeInteger(rechecked) ? rechecked : undefined, error }) + "\n");
  } catch {
    // Losing the telemetry channel cannot change tsc's result.
  }
  process.off("SIGTERM", forwardTerm);
  process.off("SIGINT", forwardInt);
  if (signal) {
    process.exitCode = 128 + constants.signals[signal];
    process.kill(process.pid, signal);
  } else process.exitCode = status ?? 127;
});
`;

export function measuredTypecheckArgs(mode: "stream" | "capture" | "sandbox", file: string, args: readonly string[]): string[] {
  return ["--input-type=commonjs", "-e", TYPECHECK_OBSERVER, "--", mode, file, ...args];
}

export function takeTypecheckObservation(stderr: string): {
  stderr: string; observation?: TypecheckObservation & { error?: string };
} {
  const start = stderr.lastIndexOf(TYPECHECK_PEAK_MARKER);
  if (start < 0 || !stderr.endsWith("\n")) return { stderr };
  try {
    const observation: unknown = JSON.parse(stderr.slice(start + TYPECHECK_PEAK_MARKER.length));
    if (observation === null || typeof observation !== "object" || Array.isArray(observation)) return { stderr };
    return { stderr: stderr.slice(0, start), observation };
  } catch {
    // A killed observer can leave a partial report. Preserve the original diagnostics.
    return { stderr };
  }
}

export function measuredTypecheckInvocation(
  file: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding, stream = false,
): { file: string; args: string[]; options: SpawnSyncOptionsWithStringEncoding } {
  const env = { ...options.env, RMD_TSC_ENTRY: "1" } as NodeJS.ProcessEnv;
  // The observer pipes stdout to collect the summary. Carry the terminal's default color behavior.
  if (stream && process.stdout.isTTY && env.TERM !== "dumb" && env.NO_COLOR === undefined && env.FORCE_COLOR === undefined) {
    env.FORCE_COLOR = "1";
  }
  return {
    file: process.execPath,
    args: measuredTypecheckArgs(stream ? "stream" : "capture", file, args),
    options: {
      ...options, env,
      stdio: stream ? ["inherit", "inherit", "inherit", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],
    },
  };
}

export function measuredTypecheckResult(result: SpawnSyncReturns<string>) {
  const { observation } = takeTypecheckObservation(result.output?.[3] ?? "");
  const error = observation?.error ? new Error(observation.error) : result.error;
  return { ...result, status: error ? null : result.status, error, observation };
}
