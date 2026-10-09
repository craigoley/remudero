import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import { buildLedgerIndex, deriveStatus, type CreditStore, type GitHub, type PrRef } from "../src/lib/status.js";

const id = "W9-T5679";
const delivered = "plan/tasks.d/W9-T100-deliverable.yaml";
const own = `plan/tasks.d/${id}-filing.yaml`;
const task: Task = {
  id, title: "plan text", repo: "remudero", depends_on: [], type: "implement", verify: "auto",
  risk: "low", status: "queued", attempts: 0, files: [delivered, own], acceptance: [],
};
const pr: PrRef = {
  number: 3000, url: "https://github.com/o/r/pull/3000", state: "MERGED",
  headRefName: `run-${id}-1`, headRefOid: "merged-head",
};
const proof = "test/the-plan-text-waiver-reads-past-the-local-window.test.ts";

function run(opts: {
  files?: string[];
  local?: string[];
  ledger?: Record<string, unknown>[];
  branch?: boolean;
  foreign?: boolean;
  indexed?: boolean;
  taskFiles?: string[];
} = {}) {
  const candidate = opts.foreign ? { ...pr, headRefName: "chore/plan-repair" } : pr;
  const ledger = opts.ledger ?? [{ step: "review.posted", plan_only: true, pr_url: pr.url, head_sha: pr.headRefOid }];
  const reads: string[] = [];
  let store: CreditStore = {};
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => opts.branch ? null : candidate,
    findMergedByHeadBranch: () => [candidate],
    headRefName: () => candidate.headRefName,
    prBody: () => `Remudero-Task: ${id}\n`,
    changedFiles: (url) => { reads.push(url); return opts.files; },
  };
  const projection = deriveStatus({ ...task, files: opts.taskFiles ?? task.files }, {
    ledgerPath: "/tmp/rmd-W1-T5679-unwritten/ledger.ndjson", github,
    readLedger: () => ledger, readCreditStore: () => store, writeCreditStore: (next) => { store = next; },
    mergedPathsByPr: new Map(opts.local === undefined ? [] : [[pr.number, opts.local]]),
    ...(opts.indexed ? { ledgerIndex: buildLedgerIndex(ledger) } : {}),
    creditOverrideRows: () => [],
  });
  return { projection, store, reads };
}

for (const branch of [false, true]) {
  for (const indexed of [false, true]) {
    for (const step of ["review.posted", "review.plan_only_reviewed"]) {
      test(`${proof}: out-of-window delivery is credited with one read (${branch ? "branch" : "trailer"}, ${indexed ? "indexed" : "rows"}, ${step})`, () => {
        const { projection, store, reads } = run({ branch, indexed, files: [delivered, own],
          ledger: [{ step, plan_only: true, pr_url: pr.url, head_sha: pr.headRefOid }] });
        const source = branch ? "head-branch" : "trailer";
        assert.equal(projection.merged, true);
        assert.equal(projection.source, source);
        assert.equal(projection.prNumber, pr.number);
        assert.equal(store[id]![source]!.prNumber, pr.number);
        assert.deepEqual(reads, [pr.url]);
      });
    }
  }
  test(`${proof}: out-of-window filing remains refused (${branch ? "branch" : "trailer"})`, () => {
    const { projection, store, reads } = run({ branch, files: [own] });
    assert.equal(projection.merged, false);
    assert.deepEqual(store, {});
    assert.deepEqual(reads, [pr.url]);
    if (!branch) assert.equal(projection.rejected_candidates![0].reason, "plan-only-changeset");
  });
}

test(`${proof}: a foreign trailer delivery reuses the waiver read for the diff guard`, () => {
  const { projection, store, reads } = run({ foreign: true, files: [delivered] });
  assert.equal(projection.merged, true);
  assert.equal(store[id]!.trailer!.prNumber, pr.number);
  assert.deepEqual(reads, [pr.url]);
});

for (const files of [undefined, [], [delivered, "plan/tasks.yaml"]]) {
  test(`${proof}: unreadable, empty or undeclared changes cannot waive the review (${JSON.stringify(files)})`, () => {
    const { projection, store, reads } = run({ files });
    assert.equal(projection.merged, false);
    assert.deepEqual(store, {});
    assert.deepEqual(reads, [pr.url]);
  });
}

test(`${proof}: a task declaring code cannot waive a plan-only review`, () => {
  const { projection, store, reads } = run({ files: [delivered], taskFiles: [delivered, "src/lib/status.ts"] });
  assert.equal(projection.merged, false);
  assert.deepEqual(store, {});
  assert.deepEqual(reads, [pr.url]);
});

test(`${proof}: an empty local path entry falls back to the network`, () => {
  const { projection, reads } = run({ local: [], files: [delivered] });
  assert.equal(projection.merged, true);
  assert.deepEqual(reads, [pr.url]);
});

test(`${proof}: local evidence and absent or stale review rows keep the own-branch zero-read guarantee`, () => {
  for (const opts of [
    { local: [delivered] },
    { local: [own] },
    { ledger: [] },
    { ledger: [{ step: "review.posted", plan_only: true, pr_url: pr.url, head_sha: "old-head" }] },
    { ledger: [{ step: "review.posted", plan_only: false, pr_url: pr.url, head_sha: pr.headRefOid }] },
  ]) {
    const { projection, reads } = run(opts);
    assert.equal(projection.merged, opts.local?.[0] !== own);
    assert.deepEqual(reads, []);
  }
});

test(`${proof}: a pr.opened filing marker is never waived or charged a read`, () => {
  const { projection, store, reads } = run({ files: [delivered], ledger: [
    { step: "pr.opened", plan_only: true, pr_url: pr.url },
    { step: "review.posted", plan_only: true, pr_url: pr.url, head_sha: pr.headRefOid },
  ] });
  assert.equal(projection.merged, false);
  assert.deepEqual(store, {});
  assert.deepEqual(reads, []);
});
