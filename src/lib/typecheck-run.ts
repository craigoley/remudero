/**
 * `npm run typecheck` — the full `tsc -p tsconfig.json --noEmit`, run the way the fleet's own checks run it: incremental
 * against this checkout's per-worktree buildinfo (seeded from the canonical checkout's, src/lib/typecheck-buildinfo.ts),
 * and admitted by its peak: a cold check through a host test slot (W1-T7392), a warm one by memory headroom alone at
 * the warm peak learned from the ledger (W1-T14145).
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
import { basename, dirname, join, resolve } from "node:path";

import { appendProducerLedger } from "./ledger.js";
import { ledgerPathFor } from "./ledger-path.js";
import { discoverLiveLedgerRoot } from "./live-write-guard.js";
import {
  acquireTestSlot, admitStaticWork, readMemoryHeadroom, testSlotExecutionAllowed, type StaticAdmission, type TestSlotLease, type TestSlotOptions,
} from "./test-slot.js";
import {
  canonicalBuildInfo,
  hasUsableTypecheckBuildInfo,
  installedTypescriptVersion,
  learnedTypecheckWarmPeakBytes,
  lowMemoryTypecheckArgs,
  measuredTypecheckInvocation,
  measuredTypecheckResult,
  prepareWorktreeTypecheck,
  recordTypecheckPeak,
  seedBuildInfo,
  typecheckArgs,
  typecheckEnv,
  typecheckPeakBytes,
  worktreeBuildInfoPath,
  type SeedOutcome,
  type TypecheckObservation,
  type TypecheckPeakRow,
} from "./typecheck-buildinfo.js";

/** The slot label an `npm run typecheck` holds while tsc runs. */
export const NPM_TYPECHECK_SLOT_LABEL = "typecheck:npm";

/** The buildinfo's name in the worktree root when the git dir is not writable. */
export const WORKTREE_BUILDINFO_NAME = ".rmd-typecheck.tsbuildinfo";

/** Runs tsc with stdio inherited in `env`; returns its exit status (null when it was killed or never started). */
export type TypecheckRunSpawn = (
  file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv,
) => { status: number | null; error?: Error; observation?: TypecheckObservation };

export interface TypecheckRunOptions {
  spawn?: TypecheckRunSpawn;
  canWrite?: (dir: string) => boolean;
  acquireSlot?: (label: string) => TestSlotLease;
  /** Options for the default slot acquisition; a check names its peak, {@link typecheckPeakBytes}, unless these do. */
  testSlot?: TestSlotOptions;
  log?: (line: string) => void;
}

const inheritSpawn: TypecheckRunSpawn = (file, args, cwd, env) => {
  const command = measuredTypecheckInvocation(file, args, { cwd, env, encoding: "utf8" }, true);
  return measuredTypecheckResult(spawnSync(command.file, command.args, command.options));
};

/** The ledger a check of the tree at `root` writes its typecheck.peak row to, and reads its learned warm peak from. */
function typecheckLedgerPath(root: string): string {
  const parent = dirname(resolve(root));
  // Fleet worktrees are rooted under config.root/worktrees, including when a worker has a redirected HOME.
  const managed = !process.env.NODE_TEST_CONTEXT && basename(parent) === "worktrees" && existsSync(join(dirname(parent), "state"));
  const ledgerRoot = process.env.NODE_TEST_CONTEXT
    ? canonicalBuildInfo(root)?.root ?? root : managed ? dirname(parent) : discoverLiveLedgerRoot();
  return ledgerPathFor({ root: ledgerRoot });
}

export function typecheckPeakWriter(root: string): (row: TypecheckPeakRow) => void {
  return row => appendProducerLedger(typecheckLedgerPath(root), "CLI", { run_id: "unattributed", ...row });
}

/** The peak a check names to its admission: the cold one, or the warm peak learned from the ledger (W1-T14145). */
export function typecheckAdmissionPeak(root: string, warm: boolean): number {
  if (!warm) return typecheckPeakBytes(false);
  try {
    return learnedTypecheckWarmPeakBytes(typecheckLedgerPath(root));
  } catch (error) {
    // An unreadable live-ledger config names no ledger: the warm check fails closed, at the cold peak.
    process.stderr.write(JSON.stringify({ step: "typecheck.warm_peak_unread", reason: String(error) }) + "\n");
    return typecheckPeakBytes(false);
  }
}

/** A warm check's headroom admission (W1-T14145), as the lease `runTypecheck` holds. */
function staticLease(admission: StaticAdmission): TestSlotLease {
  return {
    outcome: admission.outcome === "wait_bound_exceeded" ? "wait_bound_exceeded" : "acquired", executionAllowed: admission.executionAllowed,
    concurrency: 1, waitedMs: admission.waitedMs, note: admission.note, refresh: () => {}, release: () => admission.release(),
  };
}

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

/** Run the incremental full typecheck of the checkout at `root`, warm or cold, inside an admission sized by its peak. */
export function runTypecheck(root: string, extraArgs: readonly string[] = [], opts: TypecheckRunOptions = {}): number {
  const prepared = prepareTypecheckRun(root, opts.canWrite);
  const cold = !hasUsableTypecheckBuildInfo(prepared.buildInfo, installedTypescriptVersion(root));
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const peak = typecheckAdmissionPeak(root, !cold);
  let slot: TestSlotLease | undefined;
  try {
    // W1-T14145: a cold check takes a slot; a warm one waits on memory headroom alone, never on a slot count.
    slot = opts.acquireSlot ? opts.acquireSlot(NPM_TYPECHECK_SLOT_LABEL)
      : cold ? acquireTestSlot(NPM_TYPECHECK_SLOT_LABEL, { memoryBytes: peak, ...opts.testSlot })
      : staticLease(admitStaticWork(NPM_TYPECHECK_SLOT_LABEL, { memoryBytes: peak, ...opts.testSlot }));
    if (!testSlotExecutionAllowed(slot)) {
      log(JSON.stringify({ step: "typecheck.not_run", note: slot.note }));
      return 75;
    }
    log(JSON.stringify({ step: cold ? "typecheck.cold" : "typecheck.warm", where: prepared.where, seed: prepared.seed, slot: slot.outcome, note: slot.note }));
    // Read after any wait for a slot: a tight container runs tsc with fewer checkers, same diagnostics.
    const headroom = (opts.testSlot?.memoryHeadroom ?? readMemoryHeadroom)();
    const tight = lowMemoryTypecheckArgs(headroom, peak);
    if (tight.length > 0) log(JSON.stringify({ step: "typecheck.low_memory", headroomMiB: Math.round(headroom! / 1024 ** 2), args: tight }));
    let res: ReturnType<TypecheckRunSpawn> | undefined;
    try {
      res = (opts.spawn ?? inheritSpawn)(
        join(root, "node_modules", ".bin", "tsc"), [...prepared.args, ...tight, ...extraArgs], root, typecheckEnv(process.env),
      );
    } finally {
      recordTypecheckPeak(typecheckPeakWriter(root), "npm", !cold, res?.observation, "", slot.waitedMs);
    }
    if (res.error) {
      log(`typecheck: could not run tsc: ${res.error.message}`);
      return 127;
    }
    return res.status ?? 1;
  } finally {
    slot?.release();
  }
}
