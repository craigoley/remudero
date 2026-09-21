import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildFreshTreeReviewRunner,
  buildReviewerCodeFreshnessGate,
  spawnRmdReviewForFreshTree,
} from "../src/run-task.js";
import { makeTempDir } from "../src/lib/tmp.js";

// ── W1-T3723 — A STALE REVIEWER REVIEWS FROM A FRESH TREE INSTEAD OF WAITING FOR A RESTART ────
//
// THE LOOP, MEASURED 2026-09-17. #5873 merged, touching src/lib/review.ts. The daemon's reviewer
// went 3 commits behind origin/main and refused to judge (W1-T228 — a stale judge is worse than a
// late one). Its checkout is DETACHED by the entrypoint's pin semantics, and self-sync refuses to
// fast-forward a detached HEAD (W1-T445). So the only recovery was a restart — and
// deploy/recycle-container.sh REFUSED it, because the host's instance registry declares instances
// and the self-restart names none. Seven `review.skipped_stale_reviewer_code` rows in 45 minutes
// naming #5883 and #5876; an hour with no reviews; every green PR reviewed by hand.
//
// Merging a fix to the reviewer stopped the reviewer, and nothing could start it again.

const STALE = { status: "stale" as const, codeSha: "aaaaaaaaaaaa", originMainSha: "bbbbbbbbbbbb", changedPaths: ["src/lib/review.ts"] };
const FRESH = { status: "fresh" as const, codeSha: "cccccccccccc", originMainSha: "cccccccccccc", advance: "none" as const };

function gateWith(freshness: typeof STALE | typeof FRESH, fresh?: (p: string, r: string[], f: never) => Promise<number | undefined>) {
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let nextCalls = 0;
  const gate = buildReviewerCodeFreshnessGate(
    () => freshness,
    (step, extra) => { steps.push({ step, extra }); },
    async () => { nextCalls += 1; return 0; },
    fresh as never,
  );
  return { gate, steps, nextCalls: () => nextCalls };
}

test("a stale reviewer runs the review from a fresh tree instead of skipping it", async () => {
  const seen: string[] = [];
  const { gate, steps } = gateWith(STALE, async (pr) => { seen.push(pr); return 0; });
  const code = await gate.call("5883", [], {} as never);
  assert.equal(code, 0);
  assert.deepEqual(seen, ["5883"], "the fresh-tree runner must actually be asked to review this PR");
  assert.ok(steps.some((s) => s.step === "review.ran_from_fresh_tree"), "the run must be ledgered as such");
  assert.ok(!steps.some((s) => s.step === "review.skipped_stale_reviewer_code"), "a PR that WAS reviewed must not also report a skip");
});

test("a fresh reviewer still reviews in-process, so the ordinary path is untouched", async () => {
  const { gate, steps, nextCalls } = gateWith(FRESH, async () => 0);
  await gate.call("5883", [], {} as never);
  assert.equal(nextCalls(), 1, "a fresh reviewer must not pay for a worktree or a spawn");
  assert.deepEqual(steps, []);
});

test("a fresh tree that cannot be prepared falls back to the skip, never to a stale verdict", async () => {
  // THE DIRECTION THAT MATTERS. This may review with FRESH code or not at all; it must never
  // make a stale reviewer judge anyway.
  const { gate, steps, nextCalls } = gateWith(STALE, async () => undefined);
  const code = await gate.call("5883", [], {} as never);
  assert.equal(code, 0);
  assert.equal(nextCalls(), 0, "the in-process reviewer must NOT run with stale code");
  const skip = steps.find((s) => s.step === "review.skipped_stale_reviewer_code");
  assert.ok(skip, "W1-T3691's recurrence ladder must still see a skip it can escalate");
  assert.equal(skip?.extra?.fresh_tree, "unavailable");
});

test("with no runner wired at all the gate behaves exactly as it did before", async () => {
  const { gate, steps, nextCalls } = gateWith(STALE, undefined);
  assert.equal(await gate.call("5883", [], {} as never), 0);
  assert.equal(nextCalls(), 0);
  assert.equal(steps[0]?.step, "review.skipped_stale_reviewer_code");
  assert.equal(steps[0]?.extra?.fresh_tree, undefined, "the untouched path must not gain a field");
});

test("the stale pass is still reported, so a fresh-tree review does not hide the lag", async () => {
  const { gate } = gateWith(STALE, async () => 0);
  await gate.call("5883", [], {} as never);
  assert.deepEqual(gate.staleThisPass(), { oldSha: STALE.codeSha, newSha: STALE.originMainSha });
});

// ── The runner ───────────────────────────────────────────────────────────────────────────────

function runnerWith(over: { git?: (a: string[]) => string; spawn?: (w: string, a: string[]) => Promise<number>; addWorktree?: (d: string, p: string, r: string) => void } = {}) {
  const gitCalls: string[][] = [];
  const spawns: Array<{ worktree: string; args: string[] }> = [];
  const runner = buildFreshTreeReviewRunner("/repo", {
    git: over.git ?? ((a) => { gitCalls.push(a); return ""; }),
    // Recorded through the SAME channel as the git calls, so the "no ref is moved" assertion sees
    // the worktree creation too rather than going blind to it.
    addWorktree: over.addWorktree ?? ((d, p, r) => { gitCalls.push(["-C", d, "worktree", "add", "--detach", p, r]); }),
    spawnReview: over.spawn ?? (async (worktree, args) => { spawns.push({ worktree, args }); return 0; }),
    worktreeRoot: "/wt",
  });
  return { runner, gitCalls, spawns };
}

test("the runner cuts a DETACHED worktree at origin/main and never moves an existing ref", async () => {
  // W1-T445 refuses self-sync on a detached HEAD because advancing it turns a base-vs-head diff
  // into head-vs-head. Adding a NEW tree cannot do that, and this asserts nothing else is moved.
  const { runner, gitCalls } = runnerWith();
  await runner("5883", [], { originMainSha: "bbbbbbbbbbbb" });
  const joined = gitCalls.map((a) => a.join(" "));
  assert.ok(joined.some((c) => c.includes("worktree add --detach")), "the tree must be detached");
  assert.ok(joined.every((c) => !/\b(merge|reset|checkout|pull)\b/.test(c)), `no ref may be moved: ${joined.join(" | ")}`);
});

test("one worktree per code sha, reused across the PRs of a pass", async () => {
  const { runner, gitCalls, spawns } = runnerWith();
  for (const pr of ["5883", "5876", "5870"]) await runner(pr, [], { originMainSha: "bbbbbbbbbbbb" });
  assert.equal(gitCalls.filter((a) => a.includes("add")).length, 1, "six PRs behind one lag must pay one worktree");
  assert.equal(spawns.length, 3, "but every PR must still be reviewed");
  assert.equal(new Set(spawns.map((s) => s.worktree)).size, 1);
});

test("a different lag gets its own tree, so a later review cannot reuse an earlier sha's code", async () => {
  const { runner, gitCalls } = runnerWith();
  await runner("5883", [], { originMainSha: "bbbbbbbbbbbb" });
  await runner("5884", [], { originMainSha: "dddddddddddd" });
  assert.equal(gitCalls.filter((a) => a.includes("add")).length, 2);
});

test("a git failure is undefined, not an exception and not a verdict", async () => {
  const { runner } = runnerWith({ git: () => { throw new Error("worktree add failed"); } });
  assert.equal(await runner("5883", [], { originMainSha: "bbbbbbbbbbbb" }), undefined);
});

test("a spawn failure is undefined too, so the caller falls back rather than inventing a code", async () => {
  const { runner } = runnerWith({ spawn: async () => { throw new Error("spawn failed"); } });
  assert.equal(await runner("5883", [], { originMainSha: "bbbbbbbbbbbb" }), undefined);
});

test("the child's exit code is returned verbatim, so a real review failure still fails", async () => {
  const { runner } = runnerWith({ spawn: async () => 1 });
  assert.equal(await runner("5883", [], { originMainSha: "bbbbbbbbbbbb" }), 1);
});

// ── The real spawnReview seam (W1-T3723) — the fake above stands in for this in every test up to
// here; this drives the PRODUCTION wiring itself so it is not left an uncalled construction-only
// closure (the shape diff-coverage.mjs flags on an added line lcov never sees hit).

test("spawnRmdReviewForFreshTree executes the fresh tree's bash rmd wrapper and resolves to its exit code", async () => {
  const dir = makeTempDir("t3723-fresh-tree-spawn");
  mkdirSync(join(dir, "bin"), { recursive: true });
  const wrapper = join(dir, "bin", "rmd");
  // The shell grammar deliberately makes the old `process.execPath <bin/rmd>` form fail:
  // the real wrapper must be executed directly and receive the fixed `review` subcommand.
  writeFileSync(wrapper, '#!/usr/bin/env bash\nif [ "$1" != "review" ]; then exit 41; fi\nif [ "$2" != "5883" ]; then exit 42; fi\nexit "$3"\n');
  chmodSync(wrapper, 0o755);
  const code = await spawnRmdReviewForFreshTree(dir, ["5883", "7"]);
  assert.equal(code, 7, "the executable wrapper's own exit code must come back verbatim");
});
