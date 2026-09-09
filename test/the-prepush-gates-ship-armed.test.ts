/**
 * W1-T3222 — THE PRE-PUSH GATES SHIPPED DISARMED, SO EVERY WORKER PUSHED PAST THEM.
 *
 * `core.hooksPath=hooks` puts this hook in every worker worktree, and it read
 * `[ "${RMD_PREPUSH_GATES:-0}" = "1" ] || exit 0` — armed only when a variable nothing set was
 * set. The gates existed, were tested, and never ran.
 *
 * THIS FILE EXISTS BECAUSE THE SHARD'S PROOFS NAME IT. All four criteria cite
 * `test/the-prepush-gates-ship-armed.test.ts`; while the cases lived in
 * test/prepush-gates-refuse.test.ts every proof resolved to no artifact, all four fell to the
 * keyword floor, and the verdict capped at 0 proofs executed — a review that certifies nothing.
 * Its sibling keeps the REFUSAL surface (what each check reports, and what it cannot enumerate);
 * this one keeps the ARMING property, which is a different question about the same hook.
 *
 * The scrub W1-T3224 added runs ABOVE the arming check and unconditionally, so these cases also
 * cover a hook that has already unset git's per-invocation environment before reaching them.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO_ROOT, "hooks", "pre-push");

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-prepush-"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

function runHook(cwd: string, env: Record<string, string>): { status: number; stderr: string } {
  // spawnSync, NOT execFileSync: the latter RETURNS stdout and surfaces stderr only by throwing, so
  // a hook that exits 0 while naming a skip on stderr would read here as having said nothing — the
  // exact case two of these tests exist to pin.
  const res = spawnSync("sh", [HOOK], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: cwd, ...env },
  });
  assert.equal(res.error, undefined, `the hook itself failed to launch: ${String(res.error)}`);
  return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}

function violatingPrecheck(dir: string): void {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "rule15-precheck.mjs"), "process.exit(1)\n");
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
