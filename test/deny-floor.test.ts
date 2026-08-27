import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// W1-T203 acceptance criterion 4: "the deny-floor refuses a worker attempt to
// POST a commit status, and that refusal is asserted against the floor script
// itself rather than described." So this test spawns the ACTUAL hook script
// (hooks/deny-floor.sh) as the real PreToolUse hook JSON contract does — never
// a description of what the script is supposed to do, never a re-implemented
// stand-in of its regex.

const HOOK_PATH = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));

function runDenyFloor(command: string): { status: number | null; stderr: string } {
  const input = JSON.stringify({ tool_input: { command } });
  const result = spawnSync("bash", [HOOK_PATH], { input, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

// Rule 8 (W1-T2312) keys off the PROJECT directory, not the hook process's own
// $PWD, so these calls carry the real PreToolUse payload shape: a top-level `cwd`
// alongside `tool_input.command` (BaseHookInput.cwd, sdk.d.ts).
function runDenyFloorAt(command: string, cwd: string): { status: number | null; stderr: string } {
  const input = JSON.stringify({ cwd, tool_input: { command } });
  const result = spawnSync("bash", [HOOK_PATH], { input, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

test("deny-floor: refuses a worker POSTing the remudero-review commit status via `gh api`", () => {
  const { status, stderr } = runDenyFloor(
    "gh api -X POST repos/o/r/statuses/abc123 -f context=remudero-review -f state=success",
  );
  assert.equal(status, 2);
  assert.match(stderr, /blocked/i);
});

test("deny-floor: refuses a hostile FAIL post identically to a forged PASS post — the floor blocks the ACT of posting, not a particular state", () => {
  const pass = runDenyFloor("gh api -X POST repos/o/r/statuses/abc123 -f context=remudero-review -f state=success");
  const fail = runDenyFloor("gh api -X POST repos/o/r/statuses/abc123 -f context=remudero-review -f state=failure");
  assert.equal(pass.status, 2);
  assert.equal(fail.status, 2);
});

test("deny-floor: refuses regardless of flag spelling (--method POST) or argument order", () => {
  const longFlag = runDenyFloor(
    "gh api --method POST repos/o/r/statuses/abc123 -f context=remudero-review -f state=success",
  );
  assert.equal(longFlag.status, 2);

  const reordered = runDenyFloor(
    "gh api repos/o/r/statuses/abc123 -X POST -f context=remudero-review -f state=success",
  );
  assert.equal(reordered.status, 2);
});

test("deny-floor: refuses a POST to ANY commit-status context, not only remudero-review — the endpoint is the forge surface, not one context name", () => {
  const { status } = runDenyFloor("gh api -X POST repos/o/r/statuses/abc123 -f context=some-other-check -f state=success");
  assert.equal(status, 2);
});

test("deny-floor: does NOT block reading commit statuses (GET, no -X POST) — the floor owns POSTing, not observing", () => {
  const { status } = runDenyFloor("gh api repos/o/r/commits/abc123/statuses");
  assert.equal(status, 0);
});

test("deny-floor: does NOT collaterally block ordinary, unrelated gh usage", () => {
  const view = runDenyFloor("gh pr view 42 --json state");
  assert.equal(view.status, 0);
  const diff = runDenyFloor("gh pr diff https://github.com/o/r/pull/42");
  assert.equal(diff.status, 0);
});

test("deny-floor: pre-existing rules still hold (regression) — force-push to main is still blocked", () => {
  const { status, stderr } = runDenyFloor("git push --force origin main");
  assert.equal(status, 2);
  assert.match(stderr, /force/i);
});

// W1-T1066 — a lane polled `gh` 80 times at a 45-second cadence against an 8-13
// minute CI cycle and locked the operator out of his own repo for ~90 minutes,
// tripping the SECONDARY rate limit (cadence, not volume). Rule 6 refuses the
// observed shape at the tool boundary: a single command carrying a loop keyword
// AND `sleep` AND a `gh` invocation.

test("W1-T1066: a gh call inside a loop with a sleep is refused", () => {
  const forLoop = runDenyFloor(
    'for i in $(seq 1 25); do gh pr view 42 --json state; sleep 20; done',
  );
  assert.equal(forLoop.status, 2);
  assert.match(forLoop.stderr, /blocked/i);

  const untilLoop = runDenyFloor(
    'until [ "$(gh run view 123 --json status -q .status)" = "completed" ]; do sleep 20; done',
  );
  assert.equal(untilLoop.status, 2);
  assert.match(untilLoop.stderr, /blocked/i);
});

test("W1-T1066: a bare gh call is still allowed", () => {
  const { status } = runDenyFloor("gh pr view 42 --json state");
  assert.equal(status, 0);
});

test("W1-T1066: a loop with a sleep and no gh call is still allowed", () => {
  const localFileWait = runDenyFloor(
    "until [ -f coverage/lcov.info ]; do sleep 30; done",
  );
  assert.equal(localFileWait.status, 0);

  const noGhForLoop = runDenyFloor(
    'for f in *.ts; do echo "$f"; done',
  );
  assert.equal(noGhForLoop.status, 0);

  const bareSleep = runDenyFloor("sleep 30");
  assert.equal(bareSleep.status, 0);
});

test("W1-T1066: the refusal names cadence rather than a bare blocked", () => {
  const { status, stderr } = runDenyFloor(
    'while :; do gh pr view 42 --json state; sleep 45; done',
  );
  assert.equal(status, 2);
  assert.match(stderr, /polling/i);
  assert.match(stderr, /gh/i);
  assert.notEqual(stderr.trim(), "deny-floor: blocked");
});

// W1-T2312 — THE WORKTREE INSTALL HAD NO TOOL-BOUNDARY REFUSAL. `linkWorktreeNodeModules`
// symlinks every worker worktree's `node_modules` to the canonical checkout on purpose, so
// an `npm ci`/`npm install` typed straight into a Bash tool call empties the SHARED tree
// through that link (the 2026-08-05/08-11 outages) — `SymlinkInstallRefusal` guards only
// rmd's own install path, never a raw Bash command. Rule 8 is the tool-boundary refusal;
// these tests spawn the real hook script against a real symlinked/real/absent
// `node_modules`, never a description of the regex.

test("W1-T2312: an install is refused when the project's node_modules is a symlink", () => {
  const canonical = mkdtempSync(join(tmpdir(), "deny-floor-canonical-"));
  mkdirSync(join(canonical, "node_modules"));
  const worktree = mkdtempSync(join(tmpdir(), "deny-floor-worktree-"));
  symlinkSync(join(canonical, "node_modules"), join(worktree, "node_modules"));

  try {
    const { status, stderr } = runDenyFloorAt("npm ci", worktree);
    assert.equal(status, 2);
    assert.match(stderr, /empties the shared node_modules through the symlink/);

    const install = runDenyFloorAt("npm install", worktree);
    assert.equal(install.status, 2);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(canonical, { recursive: true, force: true });
  }
});

test("W1-T2312: an install is allowed when node_modules is real or absent — the symlink test is the discriminator", () => {
  const realTree = mkdtempSync(join(tmpdir(), "deny-floor-real-"));
  mkdirSync(join(realTree, "node_modules"));
  const noTree = mkdtempSync(join(tmpdir(), "deny-floor-none-"));

  try {
    assert.equal(runDenyFloorAt("npm ci", realTree).status, 0);
    assert.equal(runDenyFloorAt("npm install", realTree).status, 0);
    assert.equal(runDenyFloorAt("npm ci", noTree).status, 0);
    assert.equal(runDenyFloorAt("npm install", noTree).status, 0);
  } finally {
    rmSync(realTree, { recursive: true, force: true });
    rmSync(noTree, { recursive: true, force: true });
  }
});

test("W1-T2312: non-installing npm verbs are never blocked, even with a symlinked node_modules", () => {
  const canonical = mkdtempSync(join(tmpdir(), "deny-floor-canonical-"));
  mkdirSync(join(canonical, "node_modules"));
  const worktree = mkdtempSync(join(tmpdir(), "deny-floor-worktree-"));
  symlinkSync(join(canonical, "node_modules"), join(worktree, "node_modules"));

  try {
    assert.equal(runDenyFloorAt("npm run build", worktree).status, 0);
    assert.equal(runDenyFloorAt("npm test", worktree).status, 0);
    assert.equal(runDenyFloorAt("npm ls", worktree).status, 0);
    assert.equal(runDenyFloorAt("npm run typecheck", worktree).status, 0);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(canonical, { recursive: true, force: true });
  }
});

test("W1-T2312: pnpm/yarn install equivalents are refused too when node_modules is a symlink", () => {
  const canonical = mkdtempSync(join(tmpdir(), "deny-floor-canonical-"));
  mkdirSync(join(canonical, "node_modules"));
  const worktree = mkdtempSync(join(tmpdir(), "deny-floor-worktree-"));
  symlinkSync(join(canonical, "node_modules"), join(worktree, "node_modules"));

  try {
    assert.equal(runDenyFloorAt("pnpm install", worktree).status, 2);
    assert.equal(runDenyFloorAt("yarn install", worktree).status, 2);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(canonical, { recursive: true, force: true });
  }
});

test("W1-T2312: the refusal names the shared-tree mechanism and the remedy, not a bare blocked", () => {
  const canonical = mkdtempSync(join(tmpdir(), "deny-floor-canonical-"));
  mkdirSync(join(canonical, "node_modules"));
  const worktree = mkdtempSync(join(tmpdir(), "deny-floor-worktree-"));
  symlinkSync(join(canonical, "node_modules"), join(worktree, "node_modules"));

  try {
    const { stderr } = runDenyFloorAt("npm ci", worktree);
    assert.match(stderr, /refreshing the canonical checkout/);
    assert.match(stderr, /typecheck\/test/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(canonical, { recursive: true, force: true });
  }
});
