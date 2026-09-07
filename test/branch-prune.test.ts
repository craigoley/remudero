// test/branch-prune.test.ts — W1-T3020: the reaper's executing half.
//
// The dry run (W1-T447) classified 143 deletable branches on the live repo and deleted none, by a
// design decision this does NOT reverse: the fleet still never holds the delete. What changes is
// that the operator gets one command instead of a hand sweep, and every removal prints the line
// that puts the branch back.
//
// WHAT THESE TESTS PIN, in order of how badly each would hurt if it broke: that the prune deletes
// EXACTLY the manifest it is handed and never re-derives a classification (a deleter that widened
// its own set could disagree with the report the operator just read); that a branch whose sha will
// not resolve is skipped rather than deleted, because a restore line is the only thing making this
// reversible; that a failing push reports every name in its chunk as SURVIVING rather than
// guessing; and that chunking confines a failure instead of losing every deletion to one bad ref.

import assert from "node:assert/strict";
import { test } from "node:test";
import { pruneDeletableBranches, type BranchManifestEntry } from "../src/lib/branch-reaper.js";

function entries(...names: string[]): BranchManifestEntry[] {
  return names.map((name, i) => ({ name, sha: `${String(i).repeat(40)}`.slice(0, 40) }));
}

/** Records every argv it is handed, so a test asserts on what was ACTUALLY pushed. */
function recordingExec(fail: (names: string[]) => string | undefined = () => undefined) {
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    const names = args.slice(3); // git push origin --delete <names...>
    const err = fail(names);
    if (err) throw new Error(err);
    return "";
  };
  return { exec, calls };
}

test("W1-T3020: the prune deletes exactly the manifest it is given, and pushes those names and no others", () => {
  const manifest = entries("run-W1-T1-1", "run-W1-T2-2", "fix/old-thing");
  const rec = recordingExec();

  const outcome = pruneDeletableBranches(manifest, rec.exec);

  assert.deepEqual(outcome.deleted, ["run-W1-T1-1", "run-W1-T2-2", "fix/old-thing"]);
  assert.deepEqual(outcome.skipped, []);
  assert.deepEqual(outcome.failed, []);
  assert.equal(rec.calls.length, 1, "three names under the chunk size must be one push");
  assert.deepEqual(rec.calls[0], ["git", "push", "origin", "--delete", "run-W1-T1-1", "run-W1-T2-2", "fix/old-thing"]);
});

test("W1-T3020: a branch whose sha did not resolve is skipped with its reason, never deleted", () => {
  const manifest: BranchManifestEntry[] = [
    { name: "resolvable", sha: "a".repeat(40) },
    { name: "vanished-mid-run", sha: "unknown" },
    { name: "empty-sha", sha: "" },
  ];
  const rec = recordingExec();

  const outcome = pruneDeletableBranches(manifest, rec.exec);

  assert.deepEqual(outcome.deleted, ["resolvable"], "only the branch with a restore line may be deleted");
  assert.deepEqual(
    outcome.skipped.map((s) => s.name).sort(),
    ["empty-sha", "vanished-mid-run"],
    "both unresolvable shapes must be skipped",
  );
  for (const s of outcome.skipped) assert.match(s.reason, /reversible/, "each skip must say why");
  assert.deepEqual(
    rec.calls[0].slice(4),
    ["resolvable"],
    "an unresolvable branch must not even appear in the push argv",
  );
});

test("W1-T3020: a failed push reports every name in its chunk as still on origin, and none as deleted", () => {
  const manifest = entries("a", "b", "c");
  const rec = recordingExec(() => "remote rejected");

  const outcome = pruneDeletableBranches(manifest, rec.exec);

  assert.deepEqual(outcome.deleted, [], "a rejected push must claim no deletions");
  assert.equal(outcome.failed.length, 1);
  assert.deepEqual([...outcome.failed[0].names], ["a", "b", "c"], "the whole chunk survives, so name all of it");
  assert.match(outcome.failed[0].error, /remote rejected/, "the push's own error must reach the report");
});

test("W1-T3020: chunking confines a failure — one bad ref loses its own chunk, not every deletion", () => {
  const manifest = entries("a", "b", "c", "d", "e");
  // Fail only the chunk containing "c".
  const rec = recordingExec((names) => (names.includes("c") ? "bad ref c" : undefined));

  const outcome = pruneDeletableBranches(manifest, rec.exec, { chunkSize: 2 });

  assert.equal(rec.calls.length, 3, "five names at chunkSize 2 must be three pushes");
  assert.deepEqual(outcome.deleted, ["a", "b", "e"], "the healthy chunks must still delete");
  assert.deepEqual([...outcome.failed[0].names], ["c", "d"], "only the failing chunk's names survive");
});

test("W1-T3020: an empty manifest is a no-op that pushes nothing at all", () => {
  const rec = recordingExec();
  const outcome = pruneDeletableBranches([], rec.exec);
  assert.deepEqual(outcome, { deleted: [], skipped: [], failed: [] });
  assert.equal(rec.calls.length, 0, "nothing to delete must mean no push, not an empty --delete");
});

test("W1-T3020: the prune is operator-invoked — no daemon, sweep or cadence rung calls it", async () => {
  const { execFileSync } = await import("node:child_process");
  const hits = execFileSync("git", ["grep", "-l", "pruneDeletableBranches", "--", "src/"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(
    hits.sort(),
    ["src/lib/branch-reaper.ts", "src/run-task.ts"],
    "only its own module and the CLI verb may reference the deleter — a daemon.ts or sweep.ts hit means the fleet " +
      "gained the delete, which is the one thing W1-T447's design forbids",
  );
});

// ── the fold that decides whether a REF is live (W1-T3020) ──────────────────────────────────────

/*
 * FOUND BY CROSS-CHECKING THE DELETE SET AGAINST OPEN PR HEADS BEFORE RUNNING THE PRUNE, not by
 * reading the code: two branches sat in `plan.deletable` while carrying an OPEN pull request.
 * `foldPrState` ordered merged above open, which is correct for a name used once and wrong for a
 * REUSED one — `claude/resolve-p27-findings-rnvu61` carries ten merged PRs and one open, and the
 * merged rows won. The dry run had been mis-reporting those branches long before a prune existed;
 * shipping the prune is what made it matter.
 */

test("W1-T3020: an open PR on a reused branch name dominates every merged PR that name ever carried", async () => {
  const { foldPrState } = await import("../src/run-task.js");

  // The live shape: many merged rows, then the open one, in either arrival order.
  let mergedFirst: ReturnType<typeof foldPrState> | undefined;
  for (let i = 0; i < 10; i++) mergedFirst = foldPrState(mergedFirst, "closed", "true");
  assert.equal(foldPrState(mergedFirst, "open", "false"), "open", "an open PR must survive ten merged ones");

  let openFirst: ReturnType<typeof foldPrState> | undefined = foldPrState(undefined, "open", "false");
  for (let i = 0; i < 10; i++) openFirst = foldPrState(openFirst, "closed", "true");
  assert.equal(openFirst, "open", "and must not be downgraded by merged rows arriving after it");
});

test("W1-T3020: merged still beats closed, so the fold did not simply become 'last row wins'", () => {
  assert.equal(foldPrStateSync(undefined, "closed", "true"), "merged");
  assert.equal(foldPrStateSync(foldPrStateSync(undefined, "closed", "true"), "closed", "false"), "merged");
  assert.equal(foldPrStateSync(foldPrStateSync(undefined, "closed", "false"), "closed", "true"), "merged");
  assert.equal(foldPrStateSync(undefined, "closed", "false"), "closed");
});

// Imported eagerly for the synchronous test above; the async import in the first test proves the
// symbol is reachable from the CLI module itself rather than only through this alias.
import { foldPrState as foldPrStateSync } from "../src/run-task.js";
