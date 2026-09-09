import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO_ROOT, "hooks", "pre-push");

/**
 * test/the-prepush-gates-ship-armed.test.ts — W1-T3222.
 *
 * Replaces the two SHIPS-OFF-by-default tests that lived in test/prepush-gates-refuse.test.ts
 * (W1-T3059): that file's claim was the old default, and the default is exactly what this task
 * changes. See this task's plan record's own note for why the successor gets a new file rather
 * than editing the old one — a proof naming a suite that already exists on the PR head grades
 * non-discriminating against remudero-review's merge-base comparison.
 *
 * Two halves, because "zero false positives" alone cannot tell an armed gate from a blanket
 * block, and "it refuses" alone cannot tell an armed gate from the old silent exit:
 *   - unset now RUNS the checks and REFUSES a violating tree (before: silent exit 0)
 *   - unset still PASSES a clean tree (arming is not a blanket refusal)
 * Plus the mirror property the new predicate adds: only the exact string "0" disarms, so a
 * stray value (the old hazard ran the other way — only exact "1" armed) cannot turn the fleet's
 * gates off. And the escape hatch's own name must still appear in a refusal.
 */

/** A scratch repo the hook can run in — same shape as test/prepush-gates-refuse.test.ts's
 *  `scratch()`: a real worktree always has node_modules symlinked in by spawnWorker, and the
 *  hook's checks run under the tsx loader, so a fixture without it would fail for a reason the
 *  hook is not responsible for. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-prepush-armed-"));
  return dir;
}

function violatingPrecheck(dir: string): void {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "rule15-precheck.mjs"), "process.exit(1)\n");
}

/** spawnSync, NOT execFileSync: a hand invocation, matching the sibling suite's own choice, and
 *  for the same reason a real `git push` cannot be used here — see this task's plan record's
 *  dependency on W1-T3224 (unmerged at authoring time) for why a hand invocation is also the
 *  SAFE choice while that fix is outstanding: git exports GIT_DIR to a hook only when it invokes
 *  the hook itself, never when a test spawns the script directly, so this route cannot reach the
 *  defect PR #4774 describes even though it cannot rule it out for a real push either. */
function runHook(cwd: string, env: Record<string, string>): { status: number; stderr: string } {
  const res = spawnSync("sh", [HOOK], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: cwd, ...env },
  });
  assert.equal(res.error, undefined, `the hook itself failed to launch: ${String(res.error)}`);
  return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}

test("ARMED BY DEFAULT: with the switch unset, a violating tree is refused, not waved through", () => {
  const dir = scratch();
  violatingPrecheck(dir);
  const { status, stderr } = runHook(dir, {});
  assert.equal(status, 1, "unset must now run the checks, where before it exited 0 before touching one");
  assert.match(stderr, /pre-push REFUSED/, "the refusal must actually fire, not just the checks running");
});

test("ARMED BY DEFAULT: with the switch unset, a clean tree still passes", () => {
  const dir = scratch();
  // No scripts/rule15-precheck.mjs, no scripts/test-tier-manifest.mjs, no ./bin/rmd: every check
  // reports itself skipped-with-a-name, none of which is a violation.
  const { status } = runHook(dir, {});
  assert.equal(status, 0, "arming is not a blanket refusal — a tree with nothing wrong must still pass");
});

test("only the exact string 0 disarms — a stray value cannot turn the fleet's gates off", () => {
  const dir = scratch();
  violatingPrecheck(dir);
  for (const value of ["", "1", "true", "yes", "no", "false", "disabled"]) {
    const { status } = runHook(dir, { RMD_PREPUSH_GATES: value });
    assert.equal(status, 1, `RMD_PREPUSH_GATES=${JSON.stringify(value)} must still be armed, not disarmed`);
  }
});

test("RMD_PREPUSH_GATES=0 is the one value that disarms, and it stays silent like the old default", () => {
  const dir = scratch();
  violatingPrecheck(dir);
  const { status, stderr } = runHook(dir, { RMD_PREPUSH_GATES: "0" });
  assert.equal(status, 0, "the exact string 0 is the documented escape hatch");
  assert.equal(stderr.trim(), "", "a disarmed hook must not even announce itself, same as the old default");
});

test("the refusal still names RMD_PREPUSH_GATES=0 as the way out, with the switch left unset", () => {
  const dir = scratch();
  violatingPrecheck(dir);
  const { stderr } = runHook(dir, {});
  assert.match(stderr, /RMD_PREPUSH_GATES=0 git push/, "a hook with no escape hatch is its own hazard");
});
