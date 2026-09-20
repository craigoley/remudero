/**
 * W1-T3763 — one projection used to call `findMergedByTrailer` once per task. On the batched
 * gateway each miss linearly scanned every merged PR body, so a large plan crossed the gateway's
 * 15-second TTL before its own pass ended and restarted the board read instead of reaching review.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildBatchedGithub, projectPlan, type BatchedPr, type GitHub, type PrRef } from "../src/lib/status.js";
import type { Plan, Task } from "../src/lib/plan.js";

const ledgerPath = (): string => {
  const path = join(mkdtempSync(join(tmpdir(), "rmd-t3763-")), "ledger.ndjson");
  writeFileSync(path, "");
  return path;
};

const task = (id: string): Task =>
  ({ id, title: id, repo: "o/r", type: "implement", depends_on: [], verify: "auto", risk: "high", status: "queued", attempts: 0 }) as Task;

const plan = (ids: string[]): Plan => {
  const tasks = ids.map(task);
  return { tasks, byId: new Map(tasks.map((entry) => [entry.id, entry])) } as Plan;
};

const row = (number: number, body: string): BatchedPr => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  state: "MERGED",
  headRefName: `run-W1-T${number}-1700000000000`,
  body,
});

test("W1-T3763 criterion 1: a captured lookup keeps body-first credit and lazy commit fallback without re-entering an expired board snapshot", () => {
  let fetches = 0;
  let commits = 0;
  let now = 0;
  const github = buildBatchedGithub("o", "r", {
    ttlMs: 1,
    now: () => now,
    fetchAll: () => {
      fetches++;
      return [row(3763, "build\n\nRemudero-Task: W1-T3763\n")];
    },
    commitTrailerIndex: () => {
      commits++;
      return new Map<string, PrRef[]>([["W1-T3764", [{ number: 3764, url: "https://github.com/o/r/pull/3764", state: "MERGED" }]]]);
    },
  });

  const lookup = github.mergedTrailerLookup!();
  now = 2;

  assert.equal(lookup?.("W1-T3763")?.number, 3763, "the body surface still wins");
  assert.equal(lookup?.("W1-T3764")?.number, 3764, "a body miss still reaches the existing commit fallback");
  assert.equal(fetches, 1, "the captured lookup does not refresh after its gateway TTL passes");
  assert.equal(commits, 1, "the fallback remains lazy and memoized");
});

test("W1-T3763 criterion 2: projectPlan never calls the direct merged-body search once its batched snapshot is captured", () => {
  let fetches = 0;
  let directCalls = 0;
  let commitCalls = 0;
  const github = buildBatchedGithub("o", "r", {
    fetchAll: () => {
      fetches++;
      return [row(3763, "build\n\nRemudero-Task: W1-T3763\n")];
    },
    commitTrailerIndex: () => {
      commitCalls++;
      return new Map();
    },
  });
  github.findMergedByTrailer = () => {
    directCalls++;
    throw new Error("projectPlan must use its captured lookup, not rescan every merged body");
  };

  const ids = ["W1-T3763", ...Array.from({ length: 300 }, (_, i) => `W1-T${4000 + i}`)];
  const projection = projectPlan(plan(ids), { ledgerPath: ledgerPath(), github });

  assert.equal(projection.get("W1-T3763")?.merged, true, "the trailer-credited task is still merged");
  assert.equal(directCalls, 0, "zero per-task direct searches across the whole plan");
  assert.equal(fetches, 1, "one board snapshot backs the projection");
  assert.equal(commitCalls, 1, "the first genuine body miss initializes the existing shared commit index once");
});

test("W1-T3763 criterion 3: a failed captured trailer lookup is propagated to every task without reopening direct searches", () => {
  let directCalls = 0;
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => {
      directCalls++;
      throw new Error("a failed batch must not fan out into direct reads");
    },
    listMergedHeadBranches: () => [],
    mergedTrailerLookup: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => true,
  };

  const projection = projectPlan(plan(["W1-T3763", "W1-T3764"]), { ledgerPath: ledgerPath(), github });

  assert.equal(directCalls, 0, "the failed snapshot does not reopen one search per task");
  assert.equal(projection.get("W1-T3763")?.indeterminate, true, "the failure remains visible rather than becoming an absence");
  assert.equal(projection.get("W1-T3764")?.indeterminate, true, "every task receives the same failed-read fact");
});
