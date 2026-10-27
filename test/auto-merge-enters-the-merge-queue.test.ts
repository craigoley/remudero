/**
 * W1-T4405 — the fleet's auto-merge works with a merge queue BEFORE one is turned on.
 *
 * On a queue branch the REST merge endpoint is a queue bypass GitHub refuses, and auto-merge is how
 * a PR enters the queue. So when the base branch carries a `merge_queue` rule, attemptArm arms or
 * enqueues and never calls mergeDirect, and "already queued" reads as armed rather than as an arm
 * failure. The ruleset read is proved here against a RECORDED rules response (design iii's dry run),
 * so the call sequence is known before any repository setting changes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "#src/lib/config.js";

import {
  armFailureIsAlreadyQueued,
  attemptArm,
  baseBranchRequiresMergeQueue,
  realArmDeps,
  type ArmDeps,
} from "#src/lib/arm-auto-merge.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { armOutcomeArmed } from "#src/lib/sweep.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const PR = "https://github.com/craigoley/remudero/pull/5";

/** A recorded `GET repos/{o}/{r}/rules/branches/main` response with a merge queue in force. */
const RULES_WITH_QUEUE = [
  { type: "deletion", ruleset_id: 1 },
  { type: "pull_request", ruleset_id: 1, parameters: { required_approving_review_count: 0 } },
  { type: "merge_queue", ruleset_id: 2, parameters: { merge_method: "SQUASH", max_entries_to_build: 5 } },
];

function recordedFetch(rules: unknown) {
  const calls: string[][] = [];
  const fetch = (args: string[]) => {
    calls.push(args);
    if (args[1] === "repos/craigoley/remudero/pulls/5") return { base: { ref: "main" } };
    if (args[1] === "repos/craigoley/remudero/rules/branches/main") return rules;
    throw new Error(`unexpected read ${args.join(" ")}`);
  };
  return { fetch, calls };
}

/** Deps whose arm refuses with `armError` (or succeeds when undefined), recording every write. */
function queueDeps(opts: { queue: boolean; armError?: string; enqueueError?: string; merged?: boolean }) {
  const writes: string[] = [];
  const said: string[] = [];
  const deps: Pick<ArmDeps, "armAuto" | "mergeDirect" | "isMerged" | "say" | "mergeQueue" | "enqueue"> = {
    mergeQueue: () => opts.queue,
    armAuto: () => {
      writes.push("armAuto");
      if (opts.armError) throw Object.assign(new Error(opts.armError), { stderr: opts.armError });
    },
    enqueue: () => {
      writes.push("enqueue");
      if (opts.enqueueError) throw new Error(opts.enqueueError);
    },
    mergeDirect: () => writes.push("mergeDirect"),
    isMerged: () => opts.merged ?? false,
    say: (m) => said.push(m),
  };
  return { deps, writes, said };
}

test("W1-T4405: auto-merge enqueues when a merge queue is configured", () => {
  // The dry run: the recorded ruleset response, read in exactly this sequence.
  const withQueue = recordedFetch(RULES_WITH_QUEUE);
  assert.equal(baseBranchRequiresMergeQueue(PR, withQueue.fetch), true);
  assert.deepEqual(withQueue.calls, [
    ["api", "repos/craigoley/remudero/pulls/5"],
    ["api", "repos/craigoley/remudero/rules/branches/main"],
  ]);
  assert.equal(baseBranchRequiresMergeQueue(PR, recordedFetch(RULES_WITH_QUEUE.slice(0, 2)).fetch), false);
  // Unreadable or unparsable answers false — the pre-queue path, never a guessed queue.
  assert.equal(baseBranchRequiresMergeQueue(PR, () => { throw new Error("HTTP 502"); }), false);
  assert.equal(baseBranchRequiresMergeQueue("not a pr url", recordedFetch(RULES_WITH_QUEUE).fetch), false);
  assert.equal(baseBranchRequiresMergeQueue(PR, () => ({})), false);

  // Already green on a queue branch: GitHub refuses --auto with "clean status". The PR is ENQUEUED;
  // the REST merge that would bypass the queue is never called.
  const clean = queueDeps({ queue: true, armError: "Pull request is in clean status" });
  assert.equal(attemptArm(PR, clean.deps).outcome, "armed");
  assert.deepEqual(clean.writes, ["armAuto", "enqueue"]);
  // The control: the same refusal on an unqueued branch still takes the direct merge.
  const unqueued = queueDeps({ queue: false, armError: "Pull request is in clean status" });
  assert.equal(attemptArm(PR, unqueued.deps).outcome, "direct-merged");
  assert.deepEqual(unqueued.writes, ["armAuto", "mergeDirect"]);
  // No fallback reaches mergeDirect on a queue branch — not the quota one, not a failed enqueue.
  const quota = queueDeps({ queue: true, armError: "API rate limit exceeded" });
  assert.equal(attemptArm(PR, quota.deps).outcome, "arm-error-ignored");
  const refused = queueDeps({ queue: true, armError: "Pull request is in clean status", enqueueError: "HTTP 422" });
  const r = attemptArm(PR, refused.deps);
  assert.deepEqual([r.outcome, r.error], ["arm-error-ignored", "HTTP 422"]);
  for (const w of [quota.writes, refused.writes]) assert.ok(!w.includes("mergeDirect"), w.join(","));
  // An enqueue that fails because the queue already merged it is still a success.
  assert.equal(attemptArm(PR, queueDeps({ queue: true, armError: "clean status", enqueueError: "boom", merged: true }).deps).outcome, "armed");

  // The production deps read the queue through this same function and never throw on a bad URL.
  const real = realArmDeps();
  assert.equal(real.mergeQueue?.("not a pr url"), false);
  assert.equal(real.mergeQueue?.("not a pr url"), false, "a second read is served from the per-PR cache");
  // The real enqueue is `gh pr merge <url>` — no --squash (the queue owns the merge method), no --auto.
  const securityHead="a".repeat(40);
  const shim = ghShim([
    {when:"/files?",stdout:JSON.stringify([{filename:"docs/queue.md"}])},
    {when:"api repos/craigoley/remudero/pulls/5",stdout:JSON.stringify({state:"open",head:{sha:securityHead},
      base:{sha:"b".repeat(40),ref:"main",repo:{full_name:"craigoley/remudero"}},changed_files:1})},
  ], { kind: "w1t4405" });
  mkdirSync(join(shim.dir, "state"), { recursive: true });
  writeFileSync(join(shim.dir, "state", "ledger.ndjson"), "");
  const scoped = realArmDeps(() => ({ root: shim.dir } as Config));
  const oldPath = process.env.PATH;
  const oldCache = process.env.RMD_GH_CACHE_HOME;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  process.env.RMD_GH_CACHE_HOME=shim.dir;
  try {
    withLiveWritesAllowed(() => scoped.enqueue?.(PR));
  } finally {
    process.env.PATH = oldPath;
    if(oldCache===undefined)delete process.env.RMD_GH_CACHE_HOME;else process.env.RMD_GH_CACHE_HOME=oldCache;
  }
  assert.equal(shim.calls().filter(call=>call.startsWith("api ")).length,3,"complete docs corpus and stable head are read before enqueue");
  assert.equal(shim.calls().at(-1),`pr merge ${PR} --match-head-commit ${securityHead}`);
});

test("W1-T4405: a queued pull request reads as armed, not stuck", () => {
  const armedOnQueue = queueDeps({ queue: true });
  assert.equal(attemptArm(PR, armedOnQueue.deps).outcome, "armed");
  assert.match(armedOnQueue.said.join("\n"), /automerge\.queued \(W1-T4405\)/);
  // A re-arm of a PR already in the queue is armed — not an arm error the sweep would retry forever.
  for (const refusal of ["Pull request is already queued to merge", "pull request is already in the merge queue"]) {
    assert.equal(armFailureIsAlreadyQueued(refusal), true, refusal);
    const again = queueDeps({ queue: true, armError: refusal });
    assert.equal(attemptArm(PR, again.deps).outcome, "armed", refusal);
    assert.match(again.said.join("\n"), /already in the merge queue — armed, not stuck/);
  }
  const enqueuedTwice = queueDeps({ queue: true, armError: "clean status", enqueueError: "already queued" });
  assert.equal(attemptArm(PR, enqueuedTwice.deps).outcome, "armed");
  // What the fleet's own sweep reads the outcome as: armed.
  assert.equal(armOutcomeArmed(attemptArm(PR, queueDeps({ queue: true, armError: "already queued" }).deps).outcome), true);
  // The control: off a queue branch the same text is an ordinary, ignored arm error.
  assert.equal(armFailureIsAlreadyQueued("Pull request is in clean status"), false);
  assert.equal(attemptArm(PR, queueDeps({ queue: false, armError: "already queued to merge" }).deps).outcome, "arm-error-ignored");
});
