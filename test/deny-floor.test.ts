import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
