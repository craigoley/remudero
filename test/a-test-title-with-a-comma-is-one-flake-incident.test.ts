// test/a-test-title-with-a-comma-is-one-flake-incident.test.ts — W1-T7125: the FLAKE-RETRY label
// round-trips a test title that itself contains ", ". Before, the producer joined titles with ", "
// and both consumers split on ", ", so one such title became two names, two origins and two
// incident tasks (W1-T6884 / W1-T6885 for one test, PR #10298).
//
// scripts/*.mjs sit outside tsconfig's `include`, so the producer and the aggregator are loaded by
// dynamic import() of the real modules (same convention as test/test-with-retry.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { selectorShadowFlakeEvidence } from "../src/lib/selector-shadow-gardener.js";

const TITLE =
  "runPreflightFast over ONLY the roster's admitted projection passes on a clean HEAD — the roster itself asserts nothing, the measured bound does";
const OTHER = "a second, unrelated failing test";
const FILE = "test/the-census-roster-is-named-not-numbered.test.ts";

async function loadScript<T>(name: string): Promise<T> {
  return (await import(pathToFileURL(resolve(process.cwd(), "scripts", name)).href)) as T;
}

interface Producer { formatFlakeLabel(names: string[]): string }
interface Aggregator { parseFlakeRetryLine(line: string): { headline: string; names: string[] } | null }

/** A one-shard job log whose single retried file carries the given FLAKE-RETRY headline label. */
function shardLog(label: string, headline = "first attempt failed"): string {
  const lines = [
    "SELECTOR-SHADOW-JOB: conclusion=success",
    `2026-10-09T10:00:00Z FLAKE-RETRY: ${headline} — ${label}`,
    `2026-10-09T10:00:01Z FLAKE-RETRY-FILES: retrying 1 failed file(s) uninstrumented — ${FILE}`,
    "2026-10-09T10:00:02Z FLAKE-RETRY-RECOVERED: a flake, not a pass — x",
  ];
  return lines.map((l) => `coverage-shard (1/8)\t${l}`).join("\n");
}

test("W1-T7125: a test title containing a comma is one flake incident, not two", async () => {
  const { formatFlakeLabel } = await loadScript<Producer>("test-with-retry.mjs");
  const { parseFlakeRetryLine } = await loadScript<Aggregator>("flake-retry-aggregate.mjs");

  // producer -> gardener: one title, one origin
  const label = formatFlakeLabel([TITLE]);
  const flakes = selectorShadowFlakeEvidence(shardLog(label));
  assert.equal(flakes.length, 1);
  assert.deepEqual(flakes[0]!.titles, [TITLE], "the comma inside the title does not split it");

  // two titles, one of them with a comma: exactly two, each whole
  const both = selectorShadowFlakeEvidence(shardLog(formatFlakeLabel([TITLE, OTHER])));
  assert.deepEqual(both[0]!.titles, [TITLE, OTHER]);

  // producer -> aggregator: one name
  const parsed = parseFlakeRetryLine(`FLAKE-RETRY: first attempt failed — ${label}`);
  assert.deepEqual(parsed?.names, [TITLE]);

  // a title that starts with "[" is not mistaken for the array form
  const bracket = formatFlakeLabel(["[tag] a plain title"]);
  assert.deepEqual(parseFlakeRetryLine(`FLAKE-RETRY: retry ALSO failed — ${bracket}`)?.names, ["[tag] a plain title"]);
  assert.deepEqual(selectorShadowFlakeEvidence(shardLog(bracket))[0]!.titles, ["[tag] a plain title"]);
});

test("W1-T7125: a log written before the change, with ', '-joined names, is still read", async () => {
  const { formatFlakeLabel } = await loadScript<Producer>("test-with-retry.mjs");
  const { parseFlakeRetryLine } = await loadScript<Aggregator>("flake-retry-aggregate.mjs");

  assert.equal(formatFlakeLabel(["one", "two"]), "one, two", "titles without a comma keep the readable form");
  assert.deepEqual(parseFlakeRetryLine("FLAKE-RETRY: first attempt failed — one, two")?.names, ["one", "two"]);
  assert.deepEqual(selectorShadowFlakeEvidence(shardLog("one, two"))[0]!.titles, ["one", "two"]);
});
