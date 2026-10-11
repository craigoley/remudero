import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { defaultNodePinSyncIo } from "../src/run-task.js";
import { interventionsFromPullRequest } from "../src/lib/fix-lane-gardener.js";

test("W1-T7650: fix-lane-operator-intervention-push clears without a person", () => {
  const calls: string[][] = [];
  const io = defaultNodePinSyncIo("/nonexistent-root", {
    git: (args) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "add") mkdirSync(args[args.length - 2], { recursive: true });
      if (args.includes("commit")) throw new Error("stop after commit");
      return "";
    },
  });
  assert.throws(() => io.commitAndPush({ headRef: "run-x-1", headSha: "a".repeat(40), nvmrc: "22\n", subject: "chore: pin" }), /stop after commit/);
  const commit = calls.find((a) => a.includes("commit"));
  assert.ok(commit, "the node-pin sync commits");
  const name = commit.find((a) => a.startsWith("user.name="))!.slice("user.name=".length);
  const node = (who: string) => ({
    author: { login: "remudero-fleet[bot]" }, state: "OPEN",
    commits: { nodes: [{ commit: { oid: "b".repeat(40), committedDate: "2026-10-01T00:00:00Z", author: { name: who, user: null } } }] },
  });
  assert.deepEqual(interventionsFromPullRequest(1, node(name), 0), []);
});
