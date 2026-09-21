import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { buildCreditCandidates, creditCandidatesFromProjection } from "../src/run-task.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, StatusProjection } from "../src/lib/status.js";

function ledgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-credit-projection-"));
  const path = join(dir, "ledger.ndjson");
  writeFileSync(path, "");
  return path;
}

function task(id: string): Task {
  return { id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0, files: ["src/example.ts"] };
}

function planOf(...ids: string[]): Plan {
  const tasks = ids.map(task);
  return { tasks, byId: new Map(tasks.map((entry) => [entry.id, entry])) };
}

function gateway(
  rows: Array<{ taskId: string; number: number; state: "MERGED" | "OPEN"; body?: string }>,
  counters: { mergedBatch: number; trailerSnapshots: number; trailerFallbacks: number },
  batch: "rows" | "unreadable" = "rows",
): GitHub {
  const byTask = new Map(rows.map((row) => [row.taskId, row]));
  const byNumber = new Map(rows.map((row) => [row.number, row]));
  const pr = (row: (typeof rows)[number]) => ({
    number: row.number,
    url: `https://github.com/craigoley/remudero/pull/${row.number}`,
    state: row.state,
    headRefName: `run-${row.taskId}-1000`,
    body: row.body ?? `Remudero-Task: ${row.taskId}\n`,
  });
  return {
    listMergedHeadBranches: () => {
      counters.mergedBatch += 1;
      return batch === "unreadable" ? null : rows.map(pr);
    },
    mergedTrailerLookup: () => {
      counters.trailerSnapshots += 1;
      return (taskId: string) => {
        const row = byTask.get(taskId);
        return row === undefined ? null : pr(row);
      };
    },
    findMergedByTrailer: () => {
      counters.trailerFallbacks += 1;
      return null;
    },
    prByRef: () => null,
    headRefName: (url: string) => byNumber.get(Number(String(url).split("/").pop())) ? `run-${byNumber.get(Number(String(url).split("/").pop()))!.taskId}-1000` : undefined,
    prBody: (url: string) => {
      const row = byNumber.get(Number(String(url).split("/").pop()));
      return row?.body ?? (row ? `Remudero-Task: ${row.taskId}\n` : undefined);
    },
    changedFiles: () => ["src/example.ts"],
  } as unknown as GitHub;
}

function projection(taskId: string, merged: boolean, prNumber?: number): StatusProjection {
  return {
    taskId,
    status: merged ? "merged" : "queued",
    merged,
    source: merged ? "trailer" : "none",
    ...(prNumber === undefined ? {} : { prNumber, prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}` }),
  };
}

test("credit candidates read the ledger once", () => {
  let reads = 0;
  const counters = { mergedBatch: 0, trailerSnapshots: 0, trailerFallbacks: 0 };
  const candidates = buildCreditCandidates(
    "craigoley",
    "remudero",
    planOf("W1-T3971-A", "W1-T3971-B", "W1-T3971-C"),
    ledgerPath(),
    undefined,
    gateway([], counters),
    () => undefined,
    () => {
      reads += 1;
      return [];
    },
  );
  assert.deepEqual(candidates, []);
  assert.equal(reads, 1, "one whole-plan projection owns one ledger read");
});

test("credit candidates preserve projected candidate equivalence", () => {
  const counters = { mergedBatch: 0, trailerSnapshots: 0, trailerFallbacks: 0 };
  const candidates = buildCreditCandidates(
    "craigoley",
    "remudero",
    planOf("W1-T3971-MERGED", "W1-T3971-OPEN", "W1-T3971-MISSING"),
    ledgerPath(),
    undefined,
    gateway(
      [
        { taskId: "W1-T3971-MERGED", number: 7101, state: "MERGED" },
        { taskId: "W1-T3971-OPEN", number: 7102, state: "OPEN" },
      ],
      counters,
    ),
    () => undefined,
  );
  assert.deepEqual(candidates.map((candidate) => candidate.taskId), ["W1-T3971-MERGED"]);
  assert.equal(candidates[0]?.prNumber, 7101);
  assert.equal(counters.trailerFallbacks, 0, "the projection's merged snapshot is reused");
});

test("credit candidates fail closed on an unreadable merged batch", () => {
  const counters = { mergedBatch: 0, trailerSnapshots: 0, trailerFallbacks: 0 };
  const candidates = buildCreditCandidates(
    "craigoley",
    "remudero",
    planOf("W1-T3971-A", "W1-T3971-B"),
    ledgerPath(),
    undefined,
    gateway([{ taskId: "W1-T3971-A", number: 7103, state: "MERGED" }], counters, "unreadable"),
    () => undefined,
  );
  assert.deepEqual(candidates, []);
  assert.equal(counters.mergedBatch, 1);
  assert.equal(counters.trailerSnapshots, 0, "an unreadable batch cannot fall back to per-task trailer reads");
  assert.equal(counters.trailerFallbacks, 0, "an unreadable batch cannot manufacture a candidate");
});

test("credit candidates do not add projection side effects", () => {
  const ledger = ledgerPath();
  const statusPath = join(dirname(ledger), "status.json");
  const counters = { mergedBatch: 0, trailerSnapshots: 0, trailerFallbacks: 0 };
  buildCreditCandidates(
    "craigoley",
    "remudero",
    planOf("W1-T3971-A"),
    ledger,
    undefined,
    gateway([], counters),
    () => undefined,
  );
  assert.equal(existsSync(statusPath), false, "no cache path means no status.json write");
  assert.equal(counters.mergedBatch, 1, "the projection uses one merged-board batch");
});

test("creditCandidatesFromProjection is the named candidate mapping", () => {
  const candidates = creditCandidatesFromProjection(
    [projection("W1-T3971-A", true, 7201), projection("W1-T3971-B", false)],
    new Map([[7201, "feat: implement W1-T3971-A (#7201)"]]),
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.creditIsImplementation, true);
});
