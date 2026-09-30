import assert from "node:assert/strict";
import { test } from "node:test";
import { checkServiceFreshness, fetchOriginRetryingRefLock } from "../src/lib/self-sync.js";

// MEASURED 2026-09-30: #8017's review computed PASS, then withheld it because `git fetch origin` hit
// "cannot lock ref 'refs/remotes/origin/main': Unable to create ... main.lock: File exists" while another
// fetch in the same repo held the lock. The lock was gone within minutes; the PR waited on the pending
// ceiling instead.

const LOCK = Object.assign(new Error("Command failed: git fetch"), {
  stderr: "error: cannot lock ref 'refs/remotes/origin/main': Unable to create '.git/refs/remotes/origin/main.lock': File exists.",
});

function scriptedGit(failures: unknown[], answers: Record<string, string> = {}) {
  const calls: string[] = [];
  const git = (args: string[]): string => {
    calls.push(args.join(" "));
    if (args[0] === "fetch" && failures.length > 0) throw failures.shift();
    return answers[args.join(" ")] ?? "";
  };
  return { git, calls };
}

test("a fetch that meets a transient ref lock retries and succeeds", () => {
  const { git, calls } = scriptedGit([LOCK]);
  const slept: number[] = [];
  fetchOriginRetryingRefLock(git, (ms) => slept.push(ms));
  assert.equal(calls.filter((c) => c.startsWith("fetch")).length, 2);
  assert.equal(slept.length, 1);
});

test("any other fetch failure, or a lock that outlasts the retries, still fails", () => {
  const other = scriptedGit([new Error("fatal: unable to access remote")]);
  assert.throws(() => fetchOriginRetryingRefLock(other.git, () => {}), /unable to access remote/);
  assert.equal(other.calls.length, 1, "a non-lock failure is never retried");
  const stuck = scriptedGit([LOCK, LOCK, LOCK, LOCK]);
  assert.throws(() => fetchOriginRetryingRefLock(stuck.git, () => {}), /Command failed/);
  assert.equal(stuck.calls.length, 3);
});

test("service freshness is not degraded by a lock another fetch released", () => {
  const { git } = scriptedGit([LOCK], { "rev-parse HEAD": "abc123\n", "rev-parse origin/main": "abc123\n" });
  const r = checkServiceFreshness("/unused", {}, { git, sleep: () => {} } as never);
  assert.notEqual(r.status, "degraded", JSON.stringify(r));
});
