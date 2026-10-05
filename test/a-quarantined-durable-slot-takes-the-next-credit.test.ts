import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import {
  deriveStatus,
  invalidateDurableCredit,
  recordCredit,
  type CreditStore,
  type CreditStoreEntry,
  type DeriveDeps,
  type DurableCreditInvalidation,
  type GitHub,
  type PrRef,
} from "../src/lib/status.js";

const task = {
  id: "W9-T5656", title: "recover durable credit", repo: "remudero", depends_on: [],
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0,
} as Task;

function entry(prNumber: number, source: CreditStoreEntry["source"] = "trailer"): CreditStoreEntry {
  return { source, prUrl: `https://github.com/example/repo/pull/${prNumber}`, prNumber, prState: "MERGED" };
}

function mark(prNumber: number): DurableCreditInvalidation {
  const { prUrl } = entry(prNumber);
  return { prUrl, prNumber, reason: "durable-credit-plan-only" };
}

function pr(prNumber: number): PrRef {
  return { number: prNumber, url: entry(prNumber).prUrl, state: "MERGED", headRefName: `run-${task.id}-${prNumber}` };
}

function depsFor(store: CreditStore, github: GitHub): DeriveDeps & { stored(): CreditStore } {
  let serialized = JSON.stringify(store);
  return {
    ledgerPath: "/unused/ledger.ndjson",
    readLedger: () => [],
    readCreditOverrideFile: () => "[]",
    github,
    readCreditStore: () => JSON.parse(serialized) as CreditStore,
    writeCreditStore: (next) => { serialized = JSON.stringify(next); },
    stored: () => JSON.parse(serialized) as CreditStore,
  };
}

function gateway(overrides: Partial<GitHub> = {}): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [],
    headRefName: () => `run-${task.id}-1`,
    prBody: () => `Remudero-Task: ${task.id}`,
    changedFiles: () => ["src/lib/status.ts"],
    ...overrides,
  };
}

test("test/a-quarantined-durable-slot-takes-the-next-credit.test.ts: an older live trailer credit is durable on the next derivation", () => {
  const quarantined = pr(3059);
  const build = pr(2972);
  // Legacy JSON: the quarantine is keyed by source, beside the occupied slot.
  const store: CreditStore = {
    [task.id]: { trailer: entry(3059), invalidated: { trailer: mark(3059) } },
  };
  let searches = 0;
  let allSearches = 0;
  const deps = depsFor(store, gateway({
    findMergedByTrailer: () => { searches += 1; return quarantined; },
    findMergedByTrailerAll: () => { allSearches += 1; return [quarantined, build]; },
    findMergedByHeadBranch: () => [quarantined],
  }));
  const first = deriveStatus(task, deps);
  assert.equal(first.merged, true);
  assert.equal(first.prUrl, build.url);
  assert.equal(first.source, "trailer");
  assert.equal(searches, 1);
  assert.equal(allSearches, 1);

  const second = deriveStatus(task, deps);
  assert.equal(second.merged, true);
  assert.equal(second.prUrl, build.url);
  assert.equal(searches, 1, "the second derivation must answer before searching trailers");
  assert.equal(allSearches, 1);
  assert.deepEqual(deps.stored()[task.id].trailer, entry(2972));
  assert.deepEqual(deps.stored()[task.id].invalidated?.trailer, mark(3059));

  const onlyQuarantined: CreditStore = {
    [task.id]: { ...deps.stored()[task.id], trailer: entry(3059), "head-branch": entry(3059, "head-branch") },
  };
  const rejected = deriveStatus(task, depsFor(onlyQuarantined, gateway({
    findMergedByTrailer: () => quarantined,
    findMergedByTrailerAll: () => [quarantined],
    findMergedByHeadBranch: () => [quarantined],
  })));
  assert.equal(rejected.merged, false, "the old PR cannot return through either durable or live source");
});

test("successive quarantines retain every PR and a replacement survives the source's old mark", () => {
  for (const source of ["trailer", "head-branch"] as const) {
    let store = invalidateDurableCredit(recordCredit({}, task.id, entry(100, source)), task.id, source, mark(100));
    store = recordCredit(store, task.id, entry(101, source));
    const deps = depsFor(store, gateway({
      findMergedByTrailer: () => pr(101),
      findMergedByTrailerAll: () => [pr(101), pr(100)],
      findMergedByHeadBranch: () => [pr(101), pr(100)],
    }));
    const refused = deriveStatus(task, {
      ...deps, mergedPathsByPr: new Map([[101, ["plan/tasks.d/W9-T5656-filing.yaml"]]]),
    });
    assert.equal(refused.merged, false);
    const quarantines = Object.values(deps.stored()[task.id].invalidated!);
    assert.deepEqual(quarantines.map((m) => m.prUrl).sort(), [mark(100).prUrl, mark(101).prUrl].sort());
    assert.deepEqual(deps.stored()[task.id].invalidated?.[source], mark(100), "the first audit reason stays intact");
    assert.equal(deriveStatus(task, deps).merged, false, "both PRs stay quarantined after the path evidence disappears");

    const recovered = recordCredit(deps.stored(), task.id, entry(102, source));
    const durable = deriveStatus(task, depsFor(recovered, gateway({
      findMergedByTrailer: () => assert.fail("replacement must be durable despite the source's mark"),
    })));
    assert.equal(durable.merged, true);
    assert.equal(durable.prUrl, entry(102).prUrl);
    assert.equal(durable.source, source);
    for (const number of [100, 101]) {
      assert.equal(recordCredit(recovered, task.id, entry(number, source)), recovered);
      assert.equal(recordCredit(recovered, task.id, entry(number, source === "trailer" ? "head-branch" : "trailer")), recovered);
    }
  }
});

test("a live head-branch credit replaces a quarantined slot and is reused durably", () => {
  const store = invalidateDurableCredit(recordCredit({}, task.id, entry(300, "head-branch")), task.id, "head-branch", mark(300));
  let branchSearches = 0;
  let trailerSearches = 0;
  const deps = depsFor(store, gateway({
    findMergedByTrailer: () => { trailerSearches += 1; return null; },
    findMergedByHeadBranch: () => { branchSearches += 1; return [pr(300), pr(301)]; },
  }));
  assert.equal(deriveStatus(task, deps).prUrl, entry(301).prUrl);
  assert.equal(branchSearches, 1);
  assert.equal(trailerSearches, 1);
  assert.equal(deriveStatus(task, deps).prUrl, entry(301).prUrl);
  assert.equal(branchSearches, 1);
  assert.equal(trailerSearches, 1);
  assert.deepEqual(deps.stored()[task.id]["head-branch"], entry(301, "head-branch"));
  assert.deepEqual(deps.stored()[task.id].invalidated?.["head-branch"], mark(300));
});

test("credit and quarantine writers stay immutable and idempotent across sources", () => {
  const original = recordCredit({}, task.id, entry(200));
  assert.equal(recordCredit(original, task.id, entry(201)), original, "a usable filled slot stays occupied");
  const first = invalidateDurableCredit(original, task.id, "trailer", mark(200));
  const second = invalidateDurableCredit(first, task.id, "trailer", mark(201));
  assert.equal(original[task.id].invalidated, undefined);
  assert.deepEqual(Object.values(first[task.id].invalidated!), [mark(200)]);
  assert.deepEqual(Object.values(second[task.id].invalidated!), [mark(200), mark(201)]);
  assert.equal(invalidateDurableCredit(second, task.id, "trailer", mark(201)), second);
  assert.equal(invalidateDurableCredit(second, task.id, "head-branch", mark(200)), second);
  assert.equal(recordCredit(second, task.id, entry(201, "head-branch")), second, "quarantine blocks an empty sibling slot too");
  const recovered = recordCredit(second, task.id, entry(202));
  assert.deepEqual(first[task.id].trailer, entry(200));
  assert.deepEqual(recovered[task.id].trailer, entry(202));
  assert.deepEqual(recovered[task.id].invalidated, second[task.id].invalidated);
});
