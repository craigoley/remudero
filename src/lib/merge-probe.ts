import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { proofChildEnv } from "./review.js";
import { readLedgerLines } from "./status.js";
import { canonicalBuildInfo, hasUsableTypecheckBuildInfo, publishBuildInfo, seedBuildInfo } from "./typecheck-buildinfo.js";
import { acquireTestSlotAsync, type TestSlotOptions } from "./test-slot.js";
import { pinWorktreeGit } from "./worktree-git.js";
import type { OpenPrView } from "./sweep.js";

export const MERGE_PROBE_STEP = "sweep.merge_probe";
/** PRIMARY CONTROL on the git work one pass may spend; unprobed pairs carry over to the next pass. */
export const MERGE_PROBE_LIMIT = 3;
/** BACKSTOP on one ledger row's size; a conflict touching more paths is truncated. */
export const MERGE_PROBE_MAX_PATHS = 20;
const GIT_TIMEOUT_MS = 60_000;

export interface MergeProbeGitResult {
  status: number | null;
  stdout: string;
}
export type MergeProbeGit = (args: readonly string[]) => MergeProbeGitResult | Promise<MergeProbeGitResult>;

export type MergeProbeResult =
  | { verdict: "clean"; tree: string }
  | { verdict: "conflict"; paths: string[] }
  | { verdict: "unreadable"; reason: string };

export function defaultMergeProbeGit(cwd: string): MergeProbeGit {
  // GitHub and merge-tree can take the full timeout. Keep that wait off the daemon's event loop so
  // its review clock can still admit and post reviews while this observation is in flight.
  return (args) => new Promise((resolve) => {
    try {
      execFile("git", [...args], { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({ status: error ? (typeof code === "number" ? code : null) : 0, stdout: stdout ?? "" });
      });
    } catch {
      resolve({ status: null, stdout: "" });
    }
  });
}

/** Read-only test merge: exit 0 is clean, exit 1 a conflict, anything else unreadable. */
export async function probeMerge(input: { headSha: string; mainSha: string; git: MergeProbeGit }): Promise<MergeProbeResult> {
  try {
    const res = await input.git(["merge-tree", "--write-tree", "--name-only", "--no-messages", input.headSha, input.mainSha]);
    const lines = res.stdout.split("\n").filter((line) => line !== "");
    const tree = lines[0] ?? "";
    if (!/^[0-9a-f]{40,64}$/.test(tree) || (res.status !== 0 && res.status !== 1)) {
      return { verdict: "unreadable", reason: `git merge-tree exited ${res.status} without a tree` };
    }
    if (res.status === 0) return { verdict: "clean", tree };
    return { verdict: "conflict", paths: [...new Set(lines.slice(1))].slice(0, MERGE_PROBE_MAX_PATHS) };
  } catch (e) {
    return { verdict: "unreadable", reason: String((e as Error)?.message ?? e) };
  }
}

/** PR numbers a `Stacked on #N` line names, as data only. */
export function stackedOnNumbers(body: string | undefined): number[] {
  const line = (body ?? "").split(/\r?\n/).find((candidate) => /^\s*(?:[-*]\s+)?(?:\*\*)?Stacked on\b/i.test(candidate));
  return line ? [...new Set([...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))] : [];
}

export interface MergeProbeSummary {
  probed: number;
  mainSha?: string;
}

/** Probe each open, non-draft PR head against main once per (head, main) pair. Observation only:
 *  read-only verbs, nothing written to a PR. A throw is logged and never fails the pass. */
export async function probeOpenPrMerges(
  prs: readonly OpenPrView[],
  ledgerPath: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  cwd: string,
  opts: {
    dryRun?: boolean;
    behindMainByPr?: ReadonlyMap<number, number>;
    git?: MergeProbeGit;
    limit?: number;
  } = {},
): Promise<MergeProbeSummary> {
  const eligible = prs.filter((pr) => pr.isDraft !== true);
  if (eligible.length === 0 || opts.dryRun === true) return { probed: 0 };
  try {
    const git = opts.git ?? defaultMergeProbeGit(cwd);
    const fetched = await git(["fetch", "--no-tags", "--quiet", "origin", "main"]);
    const main = fetched.status === 0 ? await git(["rev-parse", "FETCH_HEAD"]) : fetched;
    const mainSha = main.status === 0 ? main.stdout.trim() : "";
    if (mainSha === "") {
      log(`${MERGE_PROBE_STEP}.main_unreadable`, { git_status: main.status });
      return { probed: 0 };
    }
    // ledger-read-intent: live
    const lines = readLedgerLines(ledgerPath);
    const seen = new Set(
      lines.filter((line) => line.step === MERGE_PROBE_STEP).map((line) => `${line.head_sha}:${line.main_sha}`),
    );
    const targets = eligible
      .filter((pr) => !seen.has(`${pr.headSha}:${mainSha}`))
      .sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt) || a.prNumber - b.prNumber)
      .slice(0, opts.limit ?? MERGE_PROBE_LIMIT);
    for (const pr of targets) {
      await git(["fetch", "--no-tags", "--quiet", "origin", `refs/pull/${pr.prNumber}/head`]);
      const result = await probeMerge({ headSha: pr.headSha, mainSha, git });
      const behind = opts.behindMainByPr?.get(pr.prNumber);
      log(MERGE_PROBE_STEP, {
        pr_number: pr.prNumber,
        head_sha: pr.headSha,
        main_sha: mainSha,
        verdict: result.verdict,
        conflict_paths: result.verdict === "conflict" ? result.paths : [],
        github_mergeable_state: pr.mergeableState ?? "absent",
        stacked_on: stackedOnNumbers(pr.body),
        ...(result.verdict === "unreadable" ? { reason: result.reason } : {}),
        ...(behind === undefined ? {} : { behind_by: behind }),
      });
    }
    return { probed: targets.length, mainSha };
  } catch (e) {
    log(`${MERGE_PROBE_STEP}.error`, { error: String((e as Error)?.message ?? e) });
    return { probed: 0 };
  }
}

/** W1-T5658: BACKSTOP on one `tsc --noEmit`; past it the precheck is unavailable and the push proceeds. */
const MERGED_TYPECHECK_TIMEOUT_MS = 10 * 60_000;
const MERGED_TYPECHECK_TEXT_CAP = 4000;

/** What one `tsc --noEmit` came back with. */
export type TypecheckRun = { status: number | null; output: string; timedOut: boolean };

/**
 * The precheck's answer, as distinct values — never collapsed. Only `merged_fails` refuses a push:
 * `skipped` (not behind, a textual conflict, unreadable git, no tsconfig/node_modules, a timeout) and
 * `head_fails` (HEAD itself does not compile, so the merge is not what broke it) both let the push
 * proceed, because a precheck that cannot look must never block.
 */
export type MergedTypecheckResult =
  | { outcome: "passes"; mainSha: string }
  | { outcome: "merged_fails"; mainSha: string; text: string }
  | { outcome: "head_fails"; mainSha: string }
  | { outcome: "skipped"; reason: string };

/** The one spawn the default typecheck makes; a port so a test can observe its argv and env. */
export type TypecheckSpawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type MergedTypecheckPorts = {
  git?: MergeProbeGit;
  /** Runs the typecheck in `dir`; the default spawns the HARNESS's own `tsc` asynchronously. */
  typecheck?: (dir: string, nodeModules: string) => Promise<TypecheckRun>;
  spawn?: TypecheckSpawn;
  /** The ref the head is merged with. */
  mainRef?: string;
  testSlot?: Omit<TestSlotOptions, "sleep">;
};

/** W1-T6155: the harness's OWN typescript, found from this module's location — never from a worktree, whose
 *  `node_modules` entry the worker owns. TS 7's `bin/tsc` is a launcher that execs the native compiler resolved from
 *  its own install, so the program that runs is wholly the harness's. */
function harnessTypescript(): { tsc: string; version: string; modules: string } {
  const pkgPath = createRequire(import.meta.url).resolve("typescript/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string; bin: { tsc: string } };
  const pkgDir = realpathSync(dirname(pkgPath));
  return { tsc: join(pkgDir, pkg.bin.tsc), version: pkg.version, modules: dirname(pkgDir) };
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root + sep);
const realOrUndefined = (path: string): string | undefined => (existsSync(path) ? realpathSync(path) : undefined);

/** Options a tree's tsconfig could use to make the compiler WRITE outside the scratch dir (tsBuildInfoFile, a trace
 *  directory, a cpu profile) are reset by a harness-owned wrapper config that `extends` the tree's — the harness then
 *  names its own scratch buildinfo on the command line, which wins over any config; the rest of the
 *  tree's config is read as data. `references` is not inherited through `extends`, which `--noEmit -p` never builds.
 *  The wrapper sits at the materialised tree's root so default `typeRoots` resolve from there, as they would in CI. */
const WRAPPER_CONFIG = "tsconfig.rmd-merged-typecheck.json";
const WRAPPER_COMPILER_OPTIONS = {
  noEmit: true, incremental: false, composite: false, tsBuildInfoFile: null, generateTrace: null, generateCpuProfile: null,
};

/** Where one probe's checks keep their incremental state: the canonical checkout's buildinfo (lib/typecheck-buildinfo.ts)
 *  seeds the first, each check seeds the next, and the first completed check is published back as the canonical seed. */
export type ProbeBuildInfo = { canonical?: { root: string; buildInfo: string }; tsVersion: string };

/** The argv of one probe check. The buildinfo is the scratch dir's, so the compiler still writes nothing outside it. */
export function mergedTypecheckArgv(tsc: string, buildInfo: string, config: string): string[] {
  return [tsc, "--noEmit", "--incremental", "--tsBuildInfoFile", buildInfo, "-p", config];
}

function harnessTypecheck(
  tsc: string, scratch: string, spawnChild: TypecheckSpawn, state: ProbeBuildInfo, testSlot?: Omit<TestSlotOptions, "sleep">,
): (dir: string, nodeModules: string) => Promise<TypecheckRun> {
  let n = 0;
  let previous = state.canonical;
  let published = false;
  return async (dir) => {
    n += 1;
    const home = join(scratch, `home-${n}`);
    mkdirSync(home);
    const config = join(dir, WRAPPER_CONFIG);
    writeFileSync(config, JSON.stringify({ extends: "./tsconfig.json", compilerOptions: WRAPPER_COMPILER_OPTIONS }));
    // W1-T5658's check at about half the cold peak memory: tsc reuses only the results whose file hashes still match.
    const self = { root: dir, buildInfo: join(scratch, `typecheck-${n}.tsbuildinfo`) };
    if (previous !== undefined) seedBuildInfo(previous, self, state.tsVersion);
    const slot = hasUsableTypecheckBuildInfo(self.buildInfo, state.tsVersion)
      ? undefined : await acquireTestSlotAsync("typecheck:merge-probe", testSlot);
    try {
      return await new Promise<TypecheckRun>((resolveRun) => {
        let output = "";
        let timedOut = false;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (status: number | null, extra = "") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (status !== null && !timedOut) {
            previous = self;
            if (!published && state.canonical !== undefined) {
              published = true;
              publishBuildInfo(self, state.canonical, state.tsVersion);
            }
          }
          resolveRun({ status, output: output + extra, timedOut });
        };
        try {
          const child = spawnChild(process.execPath, mergedTypecheckArgv(tsc, self.buildInfo, config), {
            cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: proofChildEnv(home),
          });
          timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, MERGED_TYPECHECK_TIMEOUT_MS);
          const take = (chunk: Buffer) => { if (output.length < 1_000_000) output += chunk.toString("utf8"); };
          child.stdout?.on("data", take);
          child.stderr?.on("data", take);
          child.on("error", (e) => finish(null, `\nspawn failed: ${e.message}`));
          child.on("close", (code) => finish(code));
        } catch (error) {
          finish(null, `\nspawn failed: ${String(error)}`);
        }
      });
    } finally {
      slot?.release();
    }
  };
}

/** Where a worktree's `node_modules` may resolve and still be read as type DATA: inside the worktree, the harness's own
 *  install, or the managed checkout's `node_modules` — found from the gitdir {@link pinWorktreeGit} vouches for, never
 *  from the worktree's own `.git` text. A plain repository has no separate managed checkout. */
function declarationRoots(wt: string, harnessModules: string): string[] {
  const roots = [realpathSync(wt), harnessModules];
  const pin = pinWorktreeGit(wt);
  if (pin.source === "git-directory") return roots;
  const common = resolve(pin.gitDir, readFileSync(join(pin.gitDir, "commondir"), "utf8").trim());
  const managed = realOrUndefined(join(dirname(common), "node_modules"));
  return managed === undefined ? roots : [...roots, managed];
}

/**
 * W1-T5658: would CI's `refs/pull/N/merge` — this head merged with main — still typecheck? Two sides can add
 * the same import at different lines (#9085: TS2300), which git merges with no textual conflict, so a head that
 * compiles alone says nothing about the tree CI builds. Run `git merge-tree --write-tree`, materialise a clean
 * merge in a scratch directory with the worktree's node_modules linked, and run `tsc --noEmit` there — async,
 * off the daemon's loop. Only when that fails AND the head alone passes is the push refused.
 * W1-T6155: the compiler is the harness's, its env the proof allowlist with a throwaway HOME (W1-T6124); the trees
 * and their declarations are data. A tree whose installed typescript is not the harness's version is skipped by
 * name rather than judged by a compiler CI would not run.
 */
export async function mergedHeadTypechecks(wt: string, ports: MergedTypecheckPorts = {}): Promise<MergedTypecheckResult> {
  const git = ports.git ?? defaultMergeProbeGit(wt);
  const mainRef = ports.mainRef ?? "origin/main";
  let scratch: string | undefined;
  try {
    const head = await git(["rev-parse", "HEAD"]);
    const main = await git(["rev-parse", mainRef]);
    const headSha = head.stdout.trim();
    const mainSha = main.stdout.trim();
    if (head.status !== 0 || main.status !== 0 || headSha === "" || mainSha === "") return { outcome: "skipped", reason: `${mainRef} unreadable` };
    if (headSha === mainSha) return { outcome: "skipped", reason: "head is main" };
    // Not behind: main is already an ancestor of the head, so the merge IS the head.
    if ((await git(["merge-base", "--is-ancestor", mainSha, headSha])).status === 0) return { outcome: "skipped", reason: "head contains main" };
    const probe = await probeMerge({ headSha, mainSha, git });
    if (probe.verdict !== "clean") return { outcome: "skipped", reason: `merge ${probe.verdict}` };
    const nodeModules = join(wt, "node_modules");
    if (!existsSync(nodeModules) || !existsSync(join(wt, "tsconfig.json"))) return { outcome: "skipped", reason: "no tsconfig or node_modules to typecheck with" };
    const harness = harnessTypescript();
    const realModules = realpathSync(nodeModules);
    if (!declarationRoots(wt, harness.modules).some((root) => within(realModules, root))) {
      return { outcome: "skipped", reason: `node_modules resolves outside the worktree, the managed checkout and the harness install: ${realModules}` };
    }
    const treeTs = join(realModules, "typescript", "package.json");
    const treeVersion = existsSync(treeTs) ? (JSON.parse(readFileSync(treeTs, "utf8")) as { version?: unknown }).version : undefined;
    if (treeVersion !== undefined && treeVersion !== harness.version) {
      return { outcome: "skipped", reason: `typescript version skew: harness ${harness.version}, tree ${String(treeVersion)}` };
    }
    const root = mkdtempSync(join(tmpdir(), "rmd-merged-typecheck-"));
    scratch = root;
    const typecheck = ports.typecheck ?? harnessTypecheck(harness.tsc, root, ports.spawn ?? spawn, {
      canonical: canonicalBuildInfo(wt), tsVersion: harness.version,
    }, ports.testSlot);
    const materialise = async (treeish: string, name: string): Promise<string | undefined> => {
      const tar = join(root, `${name}.tar`);
      const dir = join(root, name);
      mkdirSync(dir);
      if ((await git(["archive", "--format=tar", `--output=${tar}`, treeish])).status !== 0) return undefined;
      await new Promise<void>((done, fail) => execFile("tar", ["-xf", tar, "-C", dir], (e) => (e ? fail(e) : done())));
      symlinkSync(realModules, join(dir, "node_modules"));
      return dir;
    };
    const tree = await materialise(probe.tree, "tree");
    if (tree === undefined) return { outcome: "skipped", reason: "git archive of the merged tree failed" };
    const merged = await typecheck(tree, join(tree, "node_modules"));
    if (merged.timedOut) return { outcome: "skipped", reason: "typecheck timed out" };
    if (merged.status === null) return { outcome: "skipped", reason: `typecheck could not run:${merged.output.slice(-200)}` };
    if (merged.status === 0) return { outcome: "passes", mainSha };
    const headTree = await materialise(headSha, "head");
    if (headTree === undefined) return { outcome: "skipped", reason: "git archive of the head failed" };
    const alone = await typecheck(headTree, join(headTree, "node_modules"));
    if (alone.timedOut) return { outcome: "skipped", reason: "head typecheck timed out" };
    if (alone.status !== 0) return { outcome: "head_fails", mainSha };
    return { outcome: "merged_fails", mainSha, text: merged.output.slice(0, MERGED_TYPECHECK_TEXT_CAP) };
  } catch (e) {
    return { outcome: "skipped", reason: `precheck failed: ${String((e as Error)?.message ?? e)}` };
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}
