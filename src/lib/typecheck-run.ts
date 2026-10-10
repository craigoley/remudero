/**
 * `npm run typecheck` — the full `tsc -p tsconfig.json --noEmit`, run the way the fleet's own checks run it: incremental
 * against this checkout's per-worktree buildinfo (seeded from the canonical checkout's, src/lib/typecheck-buildinfo.ts),
 * and admitted through a host test slot when it would run cold (W1-T7392).
 *
 * WHY. Worker agents call `npm run typecheck` directly. As plain tsc that path stayed cold, full and unslotted after
 * #10374 and #10487 fixed the harness's own calls: two such checks in run-W1-T7615/W1-T7616 worktrees held 2.4 and
 * 2.2 GB RSS for 18+ minutes while the host sat at load 30, memory PSI full 80% (OBSERVED 2026-10-10 08:12Z).
 *
 * A SANDBOXED WORKER CANNOT WRITE ITS GIT DIR. Codex's sandbox mounts everything but the worktree and /tmp read-only,
 * and a linked worktree's git dir lives in the canonical checkout, so tsc would fail TS5033 writing the buildinfo there
 * (a false red). Then the buildinfo lives in the worktree itself, as {@link WORKTREE_BUILDINFO_NAME} (ignored by the
 * repo's `*.tsbuildinfo` rule, so no diff can carry it), seeded from the git dir's or the canonical checkout's. Not
 * TMPDIR: a predictable name in a shared temp dir is CodeQL's js/insecure-temporary-file. With nowhere writable at all,
 * the plain check runs.
 *
 * SAME RESULT AS PLAIN TSC. The diagnostics and the exit code are tsc's own; a buildinfo only changes what is rebuilt,
 * and tsc discards any cached entry whose hash, options or version differ. Extra argv is passed through to tsc.
 */
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { acquireTestSlot, type TestSlotLease } from "./test-slot.js";
import {
  canonicalBuildInfo,
  hasUsableTypecheckBuildInfo,
  installedTypescriptVersion,
  prepareWorktreeTypecheck,
  seedBuildInfo,
  typecheckArgs,
  worktreeBuildInfoPath,
  type SeedOutcome,
} from "./typecheck-buildinfo.js";

/** The slot label a cold `npm run typecheck` holds while tsc runs. */
export const NPM_TYPECHECK_SLOT_LABEL = "typecheck:npm";

/** The buildinfo's name in the worktree root when the git dir is not writable. */
export const WORKTREE_BUILDINFO_NAME = ".rmd-typecheck.tsbuildinfo";

/** Runs tsc with stdio inherited; returns its exit status (null when it was killed or never started). */
export type TypecheckRunSpawn = (file: string, args: readonly string[], cwd: string) => { status: number | null; error?: Error };

export interface TypecheckRunOptions {
  spawn?: TypecheckRunSpawn;
  canWrite?: (dir: string) => boolean;
  acquireSlot?: (label: string) => TestSlotLease;
  log?: (line: string) => void;
}

const inheritSpawn: TypecheckRunSpawn = (file, args, cwd) => {
  const r = spawnSync(file, [...args], { cwd, stdio: "inherit" });
  return { status: r.status, ...(r.error ? { error: r.error } : {}) };
};

/** Can this process create a file in `dir`? Probed by writing one: a sandbox's read-only bind still passes access(2). */
export function dirIsWritable(dir: string): boolean {
  const probe = join(dir, `.rmd-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, "");
    unlinkSync(probe);
    return true;
  } catch {
    // Read-only mount, sandbox deny or a missing dir: tsc could not write a buildinfo here either.
    return false;
  }
}

export interface PreparedTypecheck {
  args: string[];
  buildInfo?: string;
  seed: SeedOutcome;
  where: "git-dir" | "worktree" | "plain";
}

/** The argv for `root`'s check: its git dir's buildinfo when writable, else one in the worktree root, else plain. */
export function prepareTypecheckRun(root: string, canWrite: (dir: string) => boolean = dirIsWritable): PreparedTypecheck {
  const own = worktreeBuildInfoPath(root);
  if (own !== undefined && canWrite(dirname(own))) return { ...prepareWorktreeTypecheck(root), where: "git-dir" };
  if (!canWrite(root)) return { args: typecheckArgs(undefined), seed: "no-seed", where: "plain" };
  const buildInfo = join(root, WORKTREE_BUILDINFO_NAME);
  const from = own !== undefined && existsSync(own) ? { root, buildInfo: own } : canonicalBuildInfo(root);
  const seed = from === undefined ? (existsSync(buildInfo) ? "kept" : "no-seed")
    : seedBuildInfo(from, { root, buildInfo }, installedTypescriptVersion(root));
  return { args: typecheckArgs(buildInfo), buildInfo, seed, where: "worktree" };
}

/** Run the incremental full typecheck of the checkout at `root`, taking a slot only when it would run cold. */
export function runTypecheck(root: string, extraArgs: readonly string[] = [], opts: TypecheckRunOptions = {}): number {
  const prepared = prepareTypecheckRun(root, opts.canWrite);
  const cold = !hasUsableTypecheckBuildInfo(prepared.buildInfo, installedTypescriptVersion(root));
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  let slot: TestSlotLease | undefined;
  try {
    if (cold) {
      slot = (opts.acquireSlot ?? acquireTestSlot)(NPM_TYPECHECK_SLOT_LABEL);
      log(JSON.stringify({ step: "typecheck.cold", where: prepared.where, seed: prepared.seed, slot: slot.outcome, note: slot.note }));
    }
    const res = (opts.spawn ?? inheritSpawn)(join(root, "node_modules", ".bin", "tsc"), [...prepared.args, ...extraArgs], root);
    if (res.error) {
      log(`typecheck: could not run tsc: ${res.error.message}`);
      return 127;
    }
    return res.status ?? 1;
  } finally {
    slot?.release();
  }
}
