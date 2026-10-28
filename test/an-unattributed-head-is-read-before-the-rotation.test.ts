import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlanFilingFileCache, hydratePlanFilingFiles, type GhApiFetcher } from "#src/lib/open-prs-rest.js";

// W1-T9820, measured on the core ledger 2026-10-16: the light pass read at most 3 uncached heads per
// pass, newest-first. #12299 and #12301 (plan-file heads) stayed `unreadable` from 12:53Z, so they
// queued in the semantic lane behind four reviews waiting for memory, and were admitted only at
// 13:35Z, 38 min after turning green. #12310 and #12313, read in their first pass, waited 13 s.

const sha = (n: number): string => String(n).padStart(40, "0");
const candidate = (number: number, nominated = false) => ({ number, headRefOid: sha(number), nominated });

function fileFetch(calls: number[], failing = new Set<number>()): GhApiFetcher {
  return (args) => {
    const number = Number((args[args.length - 1] ?? "").match(/pulls\/(\d+)\/files/)?.[1]);
    calls.push(number);
    if (failing.has(number)) throw new Error("still unavailable");
    return number >= 900 ? [{ filename: `plan/tasks.d/W1-T${number}-a-filing.yaml` }] : [{ filename: "src/lib/x.ts" }];
  };
}

test("W1-T9820: a nominated head is read in its first pass, ahead of older uncached heads", () => {
  const calls: number[] = [];
  const cache = createPlanFilingFileCache();
  const candidates = [candidate(305), candidate(304), candidate(303), candidate(302), candidate(901, true)];
  const observed = hydratePlanFilingFiles("o", "r", candidates, fileFetch(calls), cache, { missCap: 3 });
  assert.deepEqual(observed.get(901), { state: "complete", paths: ["plan/tasks.d/W1-T901-a-filing.yaml"], cache: "miss" });
  assert.equal(calls[0], 901, "the nominated head takes the first miss of the pass");
  assert.equal(calls.length, 3, "the per-pass bound is unchanged");
});

test("W1-T9820: a nominated head's priority is one read, so an unreadable one cannot starve the rotation", () => {
  const calls: number[] = [];
  const cache = createPlanFilingFileCache();
  const candidates = [candidate(301), candidate(302), candidate(303), candidate(902, true)];
  const fetch = fileFetch(calls, new Set([902]));
  const first = hydratePlanFilingFiles("o", "r", candidates, fetch, cache, { missCap: 2 });
  assert.deepEqual(first.get(902), { state: "unreadable", reason: "fetch-failed" });
  hydratePlanFilingFiles("o", "r", candidates, fetch, cache, { missCap: 2 });
  assert.deepEqual(calls, [902, 301, 302, 303], "the second pass rotates on; the spent head waits its turn");
});
