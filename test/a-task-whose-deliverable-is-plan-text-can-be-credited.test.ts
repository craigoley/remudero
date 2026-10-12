/**
 * W1-T5553 — A TASK WHOSE DELIVERABLE IS PLAN TEXT CAN BE CREDITED.
 *
 * THE DEFECT. Rung (c)'s plan-only refusal (W1-T413/W1-T3067) and the head-branch corroboration's
 * diff guard (W1-T1004) refused every merged PR whose changeset is all plan scope. That is right for
 * a filing PR, which only adds the task's own shard. It is wrong for a task whose declared `files:`
 * ARE plan shards: W1-T3981 declares only W1-T3973's shard and was delivered by #6461; W1-T3941
 * declares three shards and was delivered by #6371. Operator PR #8962 had to credit both by hand.
 *
 * WHAT THESE TESTS DRIVE: the real `deriveStatus`, through the LIVE rungs (no durable entry), with
 * both arms — the plan-text deliverable is credited, and a filing PR or a code-declaring task's
 * plan-only PR is still refused. W1-T5552's `isPlanTextDeliverable` is the one predicate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import { deriveStatus, isPlanTextDeliverable, type CreditStore, type GitHub, type PrRef } from "../src/lib/status.js";

function task(id: string, files: string[]): Task {
  return {
    id,
    files,
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "low",
    status: "queued",
    attempts: 0,
  } as unknown as Task;
}

const LEDGER = "/tmp/does-not-exist/ledger.ndjson";
const W1_T3973_SHARD = "plan/tasks.d/W1-T3973-webhook-check-filter-enforcement-needs-a-ratified-contract.yaml";
const W1_T3371_SHARD = "plan/tasks.d/W1-T3371-a-plan-record-may-name-a-type-nothing-can-route.yaml";

/** A merged PR carrying `taskId`'s anchored trailer, found by rung (c)'s body search. */
function trailerGateway(taskId: string, pr: PrRef, changedFiles?: readonly string[]): { github: GitHub; diffReads: () => number } {
  let reads = 0;
  const github = {
    prByRef: () => null,
    findMergedByTrailer: (id: string) => (id === taskId ? pr : null),
    findMergedByHeadBranch: () => [],
    headRefName: () => pr.headRefName,
    prBody: () => `x\n\nRemudero-Task: ${taskId}\n`,
    changedFiles: () => {
      reads += 1;
      return changedFiles;
    },
  } as unknown as GitHub;
  return { github, diffReads: () => reads };
}

interface Run {
  proj: ReturnType<typeof deriveStatus>;
  store: CreditStore;
}

function run(t: Task, github: GitHub, opts: { paths?: Map<number, string[]>; ledger?: Record<string, unknown>[] } = {}): Run {
  let store: CreditStore = {};
  const proj = deriveStatus(t, {
    ledgerPath: LEDGER,
    github,
    readLedger: () => opts.ledger ?? [],
    readCreditStore: () => store,
    writeCreditStore: (s: CreditStore) => { store = s; },
    mergedPathsByPr: opts.paths,
  });
  return { proj, store };
}

test("W1-T5553: a W1-T3981-shaped task whose PR changes only the shard it declares is credited by rung (c)", () => {
  const taskId = "W9-T5553-1";
  const pr: PrRef = { number: 6461, url: "u/6461", state: "MERGED", headRefName: "chore/repair-proof", headRefOid: "ff2fe247" };
  const { github, diffReads } = trailerGateway(taskId, pr);
  const { proj, store } = run(task(taskId, [W1_T3973_SHARD]), github, { paths: new Map([[6461, [W1_T3973_SHARD]]]) });
  assert.equal(proj.merged, true, "a plan-text deliverable must be credited");
  assert.equal(proj.source, "trailer");
  assert.equal(proj.prNumber, 6461);
  assert.equal(store[taskId]?.trailer?.prNumber, 6461, "the credit is persisted like any other trailer credit");
  assert.equal(diffReads(), 0, "free local evidence answered; no GitHub diff read");
});

test("W1-T5553: the task's own shard riding along with its declared shard does not turn a delivery into a filing", () => {
  // #6461's real diff: W1-T3973's shard (the deliverable) plus W1-T3981's own shard (a reservation handoff).
  const taskId = "W9-T5553-2";
  const own = `plan/tasks.d/${taskId}-repair-stale-acceptance-proof.yaml`;
  const pr: PrRef = { number: 6462, url: "u/6462", state: "MERGED", headRefName: "chore/repair-proof" };
  const { proj } = run(task(taskId, [W1_T3973_SHARD]), trailerGateway(taskId, pr).github, {
    paths: new Map([[6462, [W1_T3973_SHARD, own]]]),
  });
  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, 6462);
});

test("W1-T5553: a plan-only review row for the merged head does not refuse a plan-text deliverable", () => {
  // judgeReview stamps `plan_only: true` on ANY all-plan diff, so the row is diff evidence, not a filing marker.
  const taskId = "W9-T5553-3";
  const pr: PrRef = { number: 6371, url: "u/6371", state: "MERGED", headRefName: `run-${taskId}-1`, headRefOid: "53624979" };
  const ledger = [{ step: "review.posted", plan_only: true, pr_url: pr.url, head_sha: "53624979" }];
  const t = task(taskId, [W1_T3371_SHARD, `plan/tasks.d/${taskId}-durable-retirement.yaml`]);
  const { proj } = run(t, trailerGateway(taskId, pr).github, { paths: new Map([[6371, [W1_T3371_SHARD]]]), ledger });
  assert.equal(proj.merged, true);
  assert.equal(proj.source, "trailer");
});

test("W1-T5553: a plan-text deliverable outside the local path window is credited from the network diff", () => {
  const taskId = "W9-T5553-4";
  const pr: PrRef = { number: 3000, url: "u/3000", state: "MERGED", headRefName: "chore/elsewhere" };
  const { github, diffReads } = trailerGateway(taskId, pr, [W1_T3973_SHARD]);
  const { proj } = run(task(taskId, [W1_T3973_SHARD]), github);
  assert.equal(proj.merged, true);
  assert.equal(diffReads(), 1);
});

test("W1-T5553: a plan-text deliverable on the task's own run branch is credited by head-branch corroboration", () => {
  const taskId = "W9-T5553-5";
  const pr: PrRef = { number: 6372, url: "u/6372", state: "MERGED", headRefName: `run-${taskId}-1` };
  const github = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [pr],
    headRefName: () => undefined,
    prBody: () => undefined,
    changedFiles: () => undefined,
  } as unknown as GitHub;
  const { proj, store } = run(task(taskId, [W1_T3371_SHARD]), github, { paths: new Map([[6372, [W1_T3371_SHARD]]]) });
  assert.equal(proj.merged, true);
  assert.equal(proj.source, "head-branch");
  assert.equal(store[taskId]?.["head-branch"]?.prNumber, 6372);
});

test("W1-T5553: a filing PR that only adds the task's own shard is still refused, on every rung", () => {
  const taskId = "W9-T5553-6";
  const own = `plan/tasks.d/${taskId}-file-me.yaml`;
  const t = task(taskId, [own, W1_T3973_SHARD]);
  const pr: PrRef = { number: 3880, url: "u/3880", state: "MERGED", headRefName: `run-${taskId}-1` };
  const paths = new Map([[3880, [own]]]);
  const viaTrailer = run(t, trailerGateway(taskId, pr).github, { paths });
  assert.equal(viaTrailer.proj.merged, false, "rung (c) must refuse a filing");
  assert.deepEqual(viaTrailer.store, {}, "nothing is persisted");
  const viaBranch = run(t, { ...trailerGateway(taskId, pr).github, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [pr] } as GitHub, { paths });
  assert.equal(viaBranch.proj.merged, false, "head-branch corroboration must refuse a filing");
  const viaNetwork = run(t, trailerGateway(taskId, { ...pr, headRefName: "chore/file" }, [own]).github);
  assert.equal(viaNetwork.proj.merged, false, "the network fallback must refuse a filing");
});

test("W1-T5553: a plan-only filing run's own pr.opened marker still refuses, even when the diff looks like a delivery", () => {
  const taskId = "W9-T5553-7";
  const pr: PrRef = { number: 3881, url: "u/3881", state: "MERGED", headRefName: "chore/plan" };
  const ledger = [{ step: "pr.opened", plan_only: true, pr_url: pr.url }];
  const { proj } = run(task(taskId, [W1_T3973_SHARD]), trailerGateway(taskId, pr).github, {
    paths: new Map([[3881, [W1_T3973_SHARD]]]),
    ledger,
  });
  assert.equal(proj.merged, false);
});

test("W1-T5553: a plan-only PR for a task that declares code files is still refused", () => {
  const taskId = "W9-T5553-8";
  const pr: PrRef = { number: 3882, url: "u/3882", state: "MERGED", headRefName: `run-${taskId}-1` };
  const t = task(taskId, [W1_T3973_SHARD, "src/lib/status.ts"]);
  const paths = new Map([[3882, [W1_T3973_SHARD]]]);
  assert.equal(run(t, trailerGateway(taskId, pr).github, { paths }).proj.merged, false);
  const viaBranch = run(t, { ...trailerGateway(taskId, pr).github, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [pr] } as GitHub, { paths });
  assert.equal(viaBranch.proj.merged, false);
});

test("W1-T5553: a PR that changes an undeclared plan path beyond the task's own shard is still refused", () => {
  const taskId = "W9-T5553-9";
  const pr: PrRef = { number: 3883, url: "u/3883", state: "MERGED", headRefName: "chore/plan" };
  const { proj } = run(task(taskId, [W1_T3973_SHARD]), trailerGateway(taskId, pr).github, {
    paths: new Map([[3883, [W1_T3973_SHARD, "plan/tasks.yaml"]]]),
  });
  assert.equal(proj.merged, false);
  assert.equal(isPlanTextDeliverable({ id: taskId, files: [W1_T3973_SHARD] }, [`plan/tasks.d/${taskId}.yaml`]), false, "own shard alone");
});
