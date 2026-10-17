// src/lib/pre-push-refusal.ts — a refusal of the harness's pre-push gate, of ANY gate class, as repair evidence.
//
// W1-T4656 routed only a census-precheck refusal to the pre-PR repair rung; every other gate's refusal of the worker's
// own push was rethrown, ended `failed` at run.error, and threw the finished build away. On 2026-10-17 W1-T9089's
// second census strike cleared the census and was then refused by test-tier-manifest — a gate that names its own
// remedy — and the P1 run ended `failed` at 11:27Z.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import { hostWorktreeGit } from "./worktree-git.js";

/** The shape run-task.ts's census refusal has, so either feeds the same repair rung. */
export interface PrePushRefusal {
  text: string;
  censuses: string[];
  offeredBaselines: string[];
}

/** The line src/lib/git-push.ts's `gateRefusal` writes ahead of the hook's own stderr. */
const GATE_REFUSED = /the harness's pre-push gate \(.*\) refused this push \(.*\); nothing was pushed$/;
const HOOK_TRAILER = /^pre-push REFUSED\./;

/**
 * Any refusal the harness's pre-push gate wrote for this push: the hook's block (its own trailer excluded), the gates
 * its lines name, and every `scripts/*.json` file it names as where its remedy lands. Undefined when the push failed
 * for any other reason (a transport error, a credential), which is not the gate's to repair.
 */
export function prePushGateRefusal(err: unknown): PrePushRefusal | undefined {
  const lines = String((err as Error)?.message ?? err).split("\n");
  const at = lines.findIndex((line) => GATE_REFUSED.test(line));
  if (at < 0) return undefined;
  const after = lines.slice(at + 1);
  const end = after.findIndex((line) => HOOK_TRAILER.test(line));
  const block = (end < 0 ? after : after.slice(0, end)).join("\n").trim();
  if (block === "") return undefined;
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return {
    text: block,
    censuses: uniq(block.split("\n").flatMap((line) => /^([a-z][\w-]*): /.exec(line)?.[1] ?? []).filter((name) => name !== "pre-push")),
    offeredBaselines: uniq(block.match(/\bscripts\/[\w.-]+\.json\b/g) ?? []),
  };
}

export const TEST_TIER_MANIFEST = "scripts/test-tier-manifest.json";

/**
 * Drop every scripts/test-tier-manifest.json row naming a test file this branch DELETED, and commit the drop. The
 * test-tier-manifest gate refuses exactly that row and names this remedy; a row for any other absent file is left
 * for the gate to report. Returns the rows dropped (none when the manifest is absent or names no deleted file).
 */
export function dropDeletedTestTierRows(cwd: string, log: (step: string, extra?: Record<string, unknown>) => void): string[] {
  const path = join(cwd, TEST_TIER_MANIFEST);
  const text = readFileIfExists(path);
  if (text === undefined) return [];
  const deleted = hostWorktreeGit(cwd, ["diff", "--name-only", "--diff-filter=D", "origin/main...HEAD", "--", "test/"])
    .split("\n").map((f) => f.trim()).filter(Boolean);
  if (deleted.length === 0) return [];
  const manifest = JSON.parse(text) as { files?: Record<string, unknown> };
  const rows = deleted.filter((file) => manifest.files !== undefined && Object.hasOwn(manifest.files, file) && !existsSync(join(cwd, file)));
  if (rows.length === 0) return [];
  for (const file of rows) delete manifest.files![file];
  writeAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
  hostWorktreeGit(cwd, ["add", "--", TEST_TIER_MANIFEST]);
  hostWorktreeGit(cwd, ["commit", "-q", "-m", "chore(test): drop the tier-manifest rows of test files this branch deletes"]);
  log("push.tier_rows_dropped", { rows, manifest: TEST_TIER_MANIFEST });
  return rows;
}

/** {@link dropDeletedTestTierRows} before a push, never failing it: a drop that cannot run leaves the gate to name the rows. */
export function dropTierRowsBeforePush(cwd: string, log: (step: string, extra?: Record<string, unknown>) => void): void {
  try {
    dropDeletedTestTierRows(cwd, log);
  } catch (error) {
    log("push.tier_rows_drop_failed", { reason: String((error as Error)?.message ?? error).slice(0, 400) });
  }
}
