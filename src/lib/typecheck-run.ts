/**
 * `npm run typecheck` — the full `tsc -p tsconfig.json --noEmit`, run the way the fleet's own checks run it: incremental
 * against this checkout's per-worktree buildinfo (seeded from the canonical checkout's, src/lib/typecheck-buildinfo.ts),
 * and admitted through a host test slot when it would run cold (W1-T7392).
 *
 * WHY. Worker agents call `npm run typecheck` directly. As plain tsc that path stayed cold, full and unslotted after
 * #10374 and #10487 fixed the harness's own calls: two such checks in run-W1-T7615/W1-T7616 worktrees held 2.4 and
 * 2.2 GB RSS for 18+ minutes while the host sat at load 30, memory PSI full 80% (OBSERVED 2026-10-10 08:12Z).
 *
 * SAME RESULT AS PLAIN TSC. The diagnostics and the exit code are tsc's own; a buildinfo only changes what is rebuilt,
 * and tsc discards any cached entry whose hash, options or version differ. Extra argv is passed through to tsc.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { acquireTestSlot, type TestSlotLease } from "./test-slot.js";
import { hasUsableTypecheckBuildInfo, installedTypescriptVersion, prepareWorktreeTypecheck } from "./typecheck-buildinfo.js";

/** The slot label a cold `npm run typecheck` holds while tsc runs. */
export const NPM_TYPECHECK_SLOT_LABEL = "typecheck:npm";

/** Runs tsc with stdio inherited; returns its exit status (null when it was killed or never started). */
export type TypecheckRunSpawn = (file: string, args: readonly string[], cwd: string) => { status: number | null; error?: Error };

export interface TypecheckRunOptions {
  spawn?: TypecheckRunSpawn;
  acquireSlot?: (label: string) => TestSlotLease;
  log?: (line: string) => void;
}

const inheritSpawn: TypecheckRunSpawn = (file, args, cwd) => {
  const r = spawnSync(file, [...args], { cwd, stdio: "inherit" });
  return { status: r.status, ...(r.error ? { error: r.error } : {}) };
};

/** Run the incremental full typecheck of the checkout at `root`, taking a slot only when it would run cold. */
export function runTypecheck(root: string, extraArgs: readonly string[] = [], opts: TypecheckRunOptions = {}): number {
  const prepared = prepareWorktreeTypecheck(root);
  const cold = !hasUsableTypecheckBuildInfo(prepared.buildInfo, installedTypescriptVersion(root));
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  let slot: TestSlotLease | undefined;
  try {
    if (cold) {
      slot = (opts.acquireSlot ?? acquireTestSlot)(NPM_TYPECHECK_SLOT_LABEL);
      log(JSON.stringify({ step: "typecheck.cold", seed: prepared.seed, slot: slot.outcome, note: slot.note }));
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
