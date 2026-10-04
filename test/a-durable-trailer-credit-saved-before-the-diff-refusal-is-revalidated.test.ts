/**
 * W1-T5552 — A DURABLE TRAILER CREDIT SAVED BEFORE THE DIFF REFUSAL IS REVALIDATED.
 *
 * THE DEFECT. W1-T3996 gave a durable HEAD-BRANCH entry in `merge-credit.json` one more look before
 * `deriveStatus`'s durable rung trusts it, and waved every TRAILER entry through on the premise that
 * rung (c) only persists one after `planOnlyRefusal` cleared. That premise holds only for entries
 * written AFTER the diff refusal (W1-T413/W1-T3067) shipped. W1-T380 stayed credited by #1437, a
 * plan-only PR, until operator PR #8962 un-credited it by hand.
 *
 * WHAT THESE TESTS DRIVE: the real `deriveStatus`. Every gateway here counts its calls by method,
 * so "no GitHub read is added" is an assertion, not a comment: `prByRef` (the head-branch arm's
 * one PR-record read) and `changedFiles` (rung (c)'s network fallback) are never called on the
 * trailer arm's behalf.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import {
  deriveStatus,
  invalidateDurableCredit,
  isPlanTextDeliverable,
  recordCredit,
  type CreditStore,
  type GitHub,
  type PrRef,
} from "../src/lib/status.js";

function task(id: string, files?: string[]): Task {
  return {
    id,
    ...(files ? { files } : {}),
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

/** A gateway with nothing on any live rung unless `over` says otherwise, counting every call. */
function countingGateway(over: Partial<Record<keyof GitHub, unknown>> = {}): { github: GitHub; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const base: Record<string, unknown> = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [],
    headRefName: () => undefined,
    prBody: () => undefined,
    changedFiles: () => undefined,
    ...over,
  };
  const github = Object.fromEntries(
    Object.entries(base).map(([name, fn]) => [
      name,
      (...args: unknown[]) => {
        calls.set(name, (calls.get(name) ?? 0) + 1);
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as GitHub;
  return { github, calls };
}

const LEDGER = "/tmp/does-not-exist/ledger.ndjson";
/** #1437's shape: the whole merged diff is plan shards — it filed or closed W1-T380, it did not build it. */
const PLAN_ONLY_PATHS = ["plan/tasks.d/W1-T380-x.yaml", "plan/tasks.d/W1-T381-y.yaml"];
const CODE_PATHS = ["src/lib/status.ts", "test/x.test.ts"];

function trailerStore(taskId: string, prNumber: number): CreditStore {
  return recordCredit({}, taskId, { source: "trailer", prUrl: `u/${prNumber}`, prNumber, prState: "MERGED" });
}

test("W1-T5552: a durable trailer credit whose merged PR changed only plan files is revalidated and quarantined once from local evidence", () => {
  const taskId = "W9-T5552-1";
  let store = trailerStore(taskId, 1437);
  const writes: CreditStore[] = [];
  const { github, calls } = countingGateway();
  const deps = {
    ledgerPath: LEDGER,
    github,
    readLedger: () => [],
    readCreditStore: () => store,
    writeCreditStore: (s: CreditStore) => {
      writes.push(s);
      store = s;
    },
    mergedPathsByPr: new Map([[1437, PLAN_ONLY_PATHS]]),
  };

  const first = deriveStatus(task(taskId), deps);
  assert.equal(first.merged, false, "a plan-only PR saved as a durable trailer credit must not mark the task merged");
  assert.equal(first.status, "queued");
  assert.equal(writes.length, 1, "the quarantine is persisted exactly once");
  assert.deepEqual(store[taskId]?.invalidated?.trailer, { prUrl: "u/1437", prNumber: 1437, reason: "durable-credit-plan-only" });
  assert.ok(store[taskId]?.trailer, "subtract-only: the entry itself stays, the mark sits beside it");

  // PAID ONCE: a later projection with NO path map in hand reads the mark instead of re-deriving it.
  const second = deriveStatus(task(taskId), { ...deps, mergedPathsByPr: undefined });
  assert.equal(second.merged, false, "a quarantined trailer credit must not resurrect when the path map is absent");
  assert.equal(writes.length, 1, "an already-quarantined entry is not re-written");

  // NO GITHUB READ ADDED: neither the head-branch arm's PR-record read nor the diff network fallback ran.
  assert.equal(calls.get("prByRef") ?? 0, 0);
  assert.equal(calls.get("changedFiles") ?? 0, 0);
});

test("W1-T5552: a durable trailer credit with code changes stays merged without any GitHub read", () => {
  const taskId = "W9-T5552-2";
  const store = trailerStore(taskId, 7100);
  let writes = 0;
  const { github, calls } = countingGateway();
  const proj = deriveStatus(task(taskId), {
    ledgerPath: LEDGER,
    github,
    readLedger: () => [],
    readCreditStore: () => store,
    writeCreditStore: () => { writes += 1; },
    mergedPathsByPr: new Map([[7100, CODE_PATHS]]),
  });
  assert.equal(proj.merged, true);
  assert.equal(proj.source, "trailer");
  assert.equal(proj.prNumber, 7100);
  assert.equal(writes, 0);
  assert.equal([...calls.values()].reduce((a, b) => a + b, 0), 0, "the durable rung answered with zero gateway calls");
});

test("W1-T5552: a durable trailer credit with no local path evidence is trusted as before", () => {
  const taskId = "W9-T5552-3";
  const store = trailerStore(taskId, 7101);
  const { github, calls } = countingGateway();
  // The map exists but has no entry for this PR (outside the scan window), and an EMPTY list is an
  // unreadable read, never "every path is plan" — both are no opinion.
  for (const map of [new Map<number, string[]>(), new Map([[7101, [] as string[]]]), undefined]) {
    const proj = deriveStatus(task(taskId), {
      ledgerPath: LEDGER,
      github,
      readLedger: () => [],
      readCreditStore: () => store,
      writeCreditStore: () => assert.fail("no evidence must never write a quarantine"),
      mergedPathsByPr: map,
    });
    assert.equal(proj.merged, true);
    assert.equal(proj.source, "trailer");
  }
  assert.equal([...calls.values()].reduce((a, b) => a + b, 0), 0);
});

test("W1-T5552: the live trailer rung cannot re-credit a quarantined trailer PR off its own run branch", () => {
  const taskId = "W9-T5552-4";
  let store = trailerStore(taskId, 1437);
  store = invalidateDurableCredit(store, taskId, "trailer", { prUrl: "u/1437", prNumber: 1437, reason: "durable-credit-plan-only" });
  // The body search finds the SAME PR again, on this task's own run branch, with an anchored trailer.
  // With no path map, rung (c)'s run-branch shortcut would credit it without reading its files —
  // the quarantine must refuse it first, and nothing may be re-persisted.
  const pr: PrRef = { number: 1437, url: "u/1437", state: "MERGED", headRefName: `run-${taskId}-1` };
  let writes = 0;
  const { github, calls } = countingGateway({
    findMergedByTrailer: () => pr,
    headRefName: () => pr.headRefName,
    prBody: () => `x\n\nRemudero-Task: ${taskId}\n`,
    findMergedByHeadBranch: () => [pr],
  });
  const proj = deriveStatus(task(taskId), {
    ledgerPath: LEDGER,
    github,
    readLedger: () => [],
    readCreditStore: () => store,
    writeCreditStore: () => { writes += 1; },
  });
  assert.equal(proj.merged, false);
  assert.equal(writes, 0, "a quarantined PR is never re-persisted under either source");
  assert.equal(calls.get("changedFiles") ?? 0, 0, "the quarantine answers before any diff read");
});

test("W1-T5552: an older real build behind a quarantined newest trailer hit still credits the task", () => {
  // W1-T2318's shape: the build #2972 merged first, then amendment #3059 ("already shipped, but
  // uncredited") carried the same trailer, changed only plan files, and became the durable entry.
  const taskId = "W9-T5552-8";
  let store = trailerStore(taskId, 3059);
  const filing: PrRef = { number: 3059, url: "u/3059", state: "MERGED", headRefName: `run-${taskId}-2` };
  const build: PrRef = { number: 2972, url: "u/2972", state: "MERGED", headRefName: `run-${taskId}-1` };
  const { github } = countingGateway({
    findMergedByTrailer: () => filing,
    findMergedByTrailerAll: () => [filing, build],
    headRefName: (url: string) => (url === build.url ? build.headRefName : filing.headRefName),
    prBody: () => `x\n\nRemudero-Task: ${taskId}\n`,
  });
  const proj = deriveStatus(task(taskId), {
    ledgerPath: LEDGER,
    github,
    readLedger: () => [],
    readCreditStore: () => store,
    writeCreditStore: (s: CreditStore) => { store = s; },
    mergedPathsByPr: new Map([[3059, PLAN_ONLY_PATHS], [2972, CODE_PATHS]]),
  });
  assert.equal(proj.merged, true, "un-crediting the amendment must not un-credit the build it pointed past");
  assert.equal(proj.source, "trailer");
  assert.equal(proj.prNumber, 2972);
  assert.equal(store[taskId]?.invalidated?.trailer?.prNumber, 3059);
});

test("W1-T5552: a head-branch entry for the quarantined trailer PR does not keep the credit alive", () => {
  const taskId = "W9-T5552-5";
  let store = trailerStore(taskId, 1437);
  store = recordCredit(store, taskId, { source: "head-branch", prUrl: "u/1437", prNumber: 1437, prState: "MERGED" });
  store = invalidateDurableCredit(store, taskId, "trailer", { prUrl: "u/1437", prNumber: 1437, reason: "durable-credit-plan-only" });
  const { github } = countingGateway();
  const proj = deriveStatus(task(taskId), {
    ledgerPath: LEDGER,
    github,
    readLedger: () => [],
    readCreditStore: () => store,
    writeCreditStore: () => {},
  });
  assert.equal(proj.merged, false, "the same proven-plan-only PR must not credit through its sibling source");
});

test("W1-T5552: a quarantined trailer entry yields to a head-branch sibling that names a real build", () => {
  const taskId = "W9-T5552-6";
  let store = trailerStore(taskId, 1437);
  store = recordCredit(store, taskId, { source: "head-branch", prUrl: "u/7200", prNumber: 7200, prState: "MERGED" });
  let writes = 0;
  const { github, calls } = countingGateway();
  const proj = deriveStatus(task(taskId), {
    ledgerPath: LEDGER,
    github,
    readLedger: () => [],
    readCreditStore: () => store,
    writeCreditStore: (s) => {
      writes += 1;
      store = s;
    },
    mergedPathsByPr: new Map([[1437, PLAN_ONLY_PATHS], [7200, CODE_PATHS]]),
  });
  assert.equal(proj.merged, true);
  assert.equal(proj.source, "head-branch");
  assert.equal(proj.prNumber, 7200);
  assert.equal(writes, 1);
  assert.equal(store[taskId]?.invalidated?.trailer?.prNumber, 1437);
  assert.equal(store[taskId]?.invalidated?.["head-branch"], undefined);
  assert.equal([...calls.values()].reduce((a, b) => a + b, 0), 0);
});

test("W1-T5552: a head-branch rung hit on the quarantined trailer PR is not re-persisted", () => {
  const taskId = "W9-T5552-7";
  let store = trailerStore(taskId, 1437);
  store = invalidateDurableCredit(store, taskId, "trailer", { prUrl: "u/1437", prNumber: 1437, reason: "durable-credit-plan-only" });
  const pr: PrRef = { number: 1437, url: "u/1437", state: "MERGED", headRefName: `run-${taskId}-1` };
  let writes = 0;
  const { github } = countingGateway({ findMergedByHeadBranch: () => [pr] });
  const proj = deriveStatus(task(taskId), {
    ledgerPath: LEDGER,
    github,
    readLedger: () => [],
    readCreditStore: () => store,
    writeCreditStore: () => { writes += 1; },
  });
  assert.equal(proj.merged, false);
  assert.equal(writes, 0);
});

// W1-T5553's exemption, applied HERE so this revalidation cannot quarantine a task whose deliverable
// IS plan text before W1-T5553 itself lands. W1-T2648 declared only W1-T2481's shard, and its PR
// #3896 changed exactly that shard.
const W1_T2481_SHARD = "plan/tasks.d/W1-T2481-a-scope-rule-fires-on-records-dispatch-can-never-reach.yaml";

test("W1-T5552: a W1-T2648-shaped plan-text deliverable keeps its durable credit under either source", () => {
  for (const source of ["trailer", "head-branch"] as const) {
    const taskId = `W9-T5552-9-${source}`;
    const store = recordCredit({}, taskId, { source, prUrl: "u/3896", prNumber: 3896, prState: "MERGED" });
    const proj = deriveStatus(task(taskId, [W1_T2481_SHARD]), {
      ledgerPath: LEDGER,
      github: countingGateway().github,
      readLedger: () => [],
      readCreditStore: () => store,
      writeCreditStore: () => assert.fail("a plan-text deliverable must not be quarantined"),
      mergedPathsByPr: new Map([[3896, [W1_T2481_SHARD]]]),
    });
    assert.equal(proj.merged, true, source);
    assert.equal(proj.prNumber, 3896);
  }
});

test("W1-T5552: a filing PR that only adds the task's own shard is still quarantined for a plan-text task", () => {
  const taskId = "W9-T5552-10";
  const ownShard = `plan/tasks.d/${taskId}-file-me.yaml`;
  let store = trailerStore(taskId, 3880);
  const proj = deriveStatus(task(taskId, [ownShard, W1_T2481_SHARD]), {
    ledgerPath: LEDGER,
    github: countingGateway().github,
    readLedger: () => [],
    readCreditStore: () => store,
    writeCreditStore: (s: CreditStore) => { store = s; },
    mergedPathsByPr: new Map([[3880, [ownShard]]]),
  });
  assert.equal(proj.merged, false);
  assert.equal(store[taskId]?.invalidated?.trailer?.prNumber, 3880);
});

test("W1-T5552: isPlanTextDeliverable refuses every shape that is not a declared plan-text delivery", () => {
  const id = "W9-T1";
  const own = `plan/tasks.d/${id}.yaml`;
  assert.equal(isPlanTextDeliverable({ id, files: [W1_T2481_SHARD] }, [W1_T2481_SHARD]), true);
  assert.equal(isPlanTextDeliverable({ id, files: [own, W1_T2481_SHARD] }, [own, W1_T2481_SHARD]), true);
  assert.equal(isPlanTextDeliverable({ id, files: [own, W1_T2481_SHARD] }, [own]), false, "own shard only: a filing");
  assert.equal(isPlanTextDeliverable({ id }, [W1_T2481_SHARD]), false, "no declared files");
  assert.equal(isPlanTextDeliverable({ id, files: [W1_T2481_SHARD, "src/x.ts"] }, [W1_T2481_SHARD]), false, "declares code");
  assert.equal(isPlanTextDeliverable({ id, files: [W1_T2481_SHARD] }, [W1_T2481_SHARD, "plan/other.yaml"]), false, "not a subset");
  assert.equal(isPlanTextDeliverable({ id, files: [W1_T2481_SHARD] }, []), false, "empty is unreadable");
});
