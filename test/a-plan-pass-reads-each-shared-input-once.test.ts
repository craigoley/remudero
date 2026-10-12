/**
 * A `projectPlan` pass derives every plan task, and the read model's `workstreams` view runs one per build
 * (2026-10-06: builds of 2.5 to 33 s on the views thread, starving the `host` view's 60 s re-probe). Three
 * inputs are the same for every task of a pass, yet were loaded per task or per pass from scratch:
 * - the credit override record: a file read and a YAML parse per task that asked (~3,000 a pass);
 * - the prose index of every merged PR, built though a pass that skips the uncredited-build warning never reads it;
 * - the merged-trailer map, rescanned over every merged body although the gateway's index had not moved.
 * Each case counts the reads, so none depends on the wall clock.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Plan, Task } from "../src/lib/plan.js";
import { buildBatchedGithub, projectPlan, type BatchedPr, type GitHub, type PrRef } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

const ledgerPath = (): string => {
  const path = join(makeTempDir("plan-pass-inputs"), "ledger.ndjson");
  writeFileSync(path, "");
  return path;
};

const task = (id: string): Task =>
  ({ id, title: id, repo: "o/r", type: "implement", depends_on: [], verify: "auto", risk: "high", status: "queued", attempts: 0 }) as Task;

const plan = (ids: string[]): Plan => {
  const tasks = ids.map(task);
  return { tasks, byId: new Map(tasks.map((entry) => [entry.id, entry])) } as Plan;
};

const url = (n: number): string => `https://github.com/o/r/pull/${n}`;

const IDS = ["W1-T9001", "W1-T9002", "W1-T9003", "W1-T9004", "W1-T9005"];

/** Each task merged off its own run branch: every derivation then asks the override record about its PR. */
function mergedByBranch(): GitHub {
  const merged = IDS.map((id, i): PrRef => ({ number: 100 + i, url: url(100 + i), state: "MERGED", headRefName: `run-${id}-1700000000000` }));
  return {
    prByRef: (ref: string | number) => merged.find((pr) => pr.url === ref || pr.number === Number(ref)) ?? null,
    findMergedByTrailer: () => null,
    listMergedHeadBranches: () => merged,
    mergedTrailerLookup: () => () => null,
    headRefName: (prUrl: string) => merged.find((pr) => pr.url === prUrl)?.headRefName,
    prBody: () => "",
  } as unknown as GitHub;
}

test("unit test: a projectPlan pass loads the credit override record once, however many tasks ask it", () => {
  let reads = 0;
  const projection = projectPlan(plan(IDS), {
    ledgerPath: ledgerPath(),
    github: mergedByBranch(),
    readCreditStore: () => ({}),
    writeCreditStore: () => {},
    readCreditOverrideFile: () => {
      reads++;
      return `- task: W1-T9003\n  pr: 102\n  action: remove-credit\n  reason: "built the wrong thing"\n  author_class: operator\n`;
    },
  });
  // POSITIVE CONTROL: every task's derivation consulted the record, and the one loaded answers each of them.
  assert.deepEqual(IDS.map((id) => projection.get(id)?.merged), [true, true, false, true, true], "the override still refuses its one pairing");
  assert.equal(projection.get("W1-T9003")?.creditOverride?.pr, 102);
  assert.equal(reads, 1, `the record is read once a pass, not once per task (read ${reads} times for ${IDS.length} tasks)`);
});

/** Merged PRs whose `title` reads are counted: only the prose index reads a merged PR's title. */
function countingTitles(): { github: GitHub; titleReads: () => number } {
  let titleReads = 0;
  const merged = IDS.map((id, i): PrRef => {
    const pr = { number: 200 + i, url: url(200 + i), state: "MERGED", headRefName: `feature-${i}`, body: "" } as PrRef;
    Object.defineProperty(pr, "title", { enumerable: true, get: () => (titleReads++, `mentions ${id}`) });
    return pr;
  });
  const github = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    listMergedHeadBranches: () => merged,
    mergedTrailerLookup: () => () => null,
    headRefName: () => undefined,
    prBody: () => "",
  } as unknown as GitHub;
  return { github, titleReads: () => titleReads };
}

test("unit test: a projectPlan pass that skips the uncredited-build warning does not index every merged PR's prose", () => {
  const control = countingTitles();
  projectPlan(plan(IDS), { ledgerPath: ledgerPath(), github: control.github, readCreditStore: () => ({}), writeCreditStore: () => {} });
  assert.ok(control.titleReads() >= IDS.length, `positive control: a pass that warns walks every merged title (${control.titleReads()})`);

  const skipping = countingTitles();
  const projection = projectPlan(plan(IDS), {
    ledgerPath: ledgerPath(), github: skipping.github, readCreditStore: () => ({}), writeCreditStore: () => {}, skipUncreditedBuildWarning: true,
  });
  assert.equal(projection.size, IDS.length, "control: the pass derived every task");
  assert.equal(skipping.titleReads(), 0, "no reader of the skipped warning, so no walk of the merged prose");
});

test("unit test: the batched gateway's merged-trailer lookup reuses its map until the board index moves", () => {
  let bodyReads = 0;
  let fetches = 0;
  const rows = (): BatchedPr[] => IDS.map((id, i) => {
    const row = { number: 300 + i, url: url(300 + i), state: "MERGED", headRefName: `feature-${i}` } as BatchedPr;
    Object.defineProperty(row, "body", { enumerable: true, get: () => (bodyReads++, `build\n\nRemudero-Task: ${id}\n`) });
    return row;
  });
  let now = 0;
  const github = buildBatchedGithub("o", "r", { ttlMs: 1_000, mergedTtlMs: 1_000, now: () => now, fetchAll: () => (fetches++, rows()), commitTrailerIndex: () => new Map() });

  const first = github.mergedTrailerLookup!();
  const scanned = bodyReads;
  assert.ok(scanned >= IDS.length, `positive control: the first lookup scans every merged body (${scanned})`);
  const second = github.mergedTrailerLookup!();
  assert.equal(second?.("W1-T9004")?.number, 303, "the reused map still answers each trailer");
  assert.equal(first?.("W1-T9004")?.number, 303);
  assert.equal(bodyReads, scanned, "a second pass over the same index rescans no body");

  now = 5_000;
  github.mergedTrailerLookup!();
  assert.equal(fetches, 2, "control: the TTL refreshed the board");
  assert.ok(bodyReads > scanned, "a refreshed index is scanned afresh");
});
