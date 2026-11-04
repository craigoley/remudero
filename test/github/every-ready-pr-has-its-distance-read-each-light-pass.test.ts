import assert from "node:assert/strict";
import { test } from "node:test";
import { createReadyPrCompareReader } from "#src/lib/light-pass-compare.js";
import { LightPassPreReviewTiming, type OpenPrView } from "#src/lib/sweep.js";
import { DISTANCE_REFRESH_PROBE_LIMIT, distanceRefreshProbeTargets } from "#src/lib/tick-read-worker.js";

// W1-T11293 — on 2026-11-03 the light pass read only a three-per-window rotation slice of the READY PRs, so #16546 and
// #16548 sat "ready PR distance is unreadable" for ~90 minutes. A ready PR is the only kind that can merge.

const MAIN = "m".repeat(40);

function readyPr(prNumber: number): OpenPrView {
  return {
    prNumber, headSha: `${prNumber}`.padEnd(40, "a"), lastActivityAt: `2026-11-04T00:00:0${prNumber % 10}Z`,
    isDraft: false, mergeState: "clean", mergeable: true, checksState: "green", reviewState: "success",
  } as unknown as OpenPrView;
}

function compareStub(behave: (headSha: string) => unknown) {
  const calls: string[] = [];
  const read = async (args: string[]): Promise<unknown> => {
    const path = args[1]!;
    calls.push(path);
    const head = path.split("/compare/")[1]!.split("...")[0]!;
    return behave(head);
  };
  return { calls, read };
}

test("W1-T11293: every ready PR handed to the light pass has its distance read in one pass, memoized per head and main", async () => {
  const prs = [1, 2, 3, 4, 5].map(readyPr);
  // Positive control: the stale-distance rotation this reader no longer uses would have measured only a slice.
  assert.equal(DISTANCE_REFRESH_PROBE_LIMIT, 3);
  assert.equal(distanceRefreshProbeTargets(prs, 0).length, DISTANCE_REFRESH_PROBE_LIMIT,
    "the stale-distance refresh stays bounded to its rotation slice");
  const stub = compareStub(() => ({ ahead_by: 2, files: [{ filename: "src/lib/x.ts" }] }));
  const reader = createReadyPrCompareReader("owner", "repo", stub.read);
  const timing = new LightPassPreReviewTiming();
  try {
    const facts = await reader.read(prs, MAIN, timing);
    assert.deepEqual([...facts.behindMainByPr.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5],
      "every ready PR is measured, not only the rotation slice");
    assert.equal(stub.calls.length, 5);
    assert.deepEqual(facts.baseChangedFilesByPr.get(4)?.files, ["src/lib/x.ts"]);
    const again = await reader.read(prs, MAIN, timing);
    assert.equal(again.behindMainByPr.size, 5);
    assert.equal(stub.calls.length, 5, "a second read at the same main is served from the (head, main) memo");
    assert.ok(timing.compareReads.slice(5).every((row) => row.cache_hit === true));
  } finally {
    timing.finish();
  }
});

test("W1-T11293 criterion 2: with more ready PRs than the old slice, one pass measures each, and a failed compare holds only its own PR", async () => {
  const prs = [11, 12, 13, 14, 15, 16].map(readyPr);
  assert.ok(prs.length > DISTANCE_REFRESH_PROBE_LIMIT);
  const failing = readyPr(13).headSha, unreadable = readyPr(15).headSha;
  const stub = compareStub((head) => {
    if (head === failing) throw new Error("gh: compare failed (HTTP 502)");
    if (head === unreadable) return { message: "no ahead_by" };
    return { ahead_by: 1 };
  });
  const reader = createReadyPrCompareReader("owner", "repo", stub.read);
  const timing = new LightPassPreReviewTiming();
  try {
    const facts = await reader.read(prs, MAIN, timing);
    assert.deepEqual([...facts.behindMainByPr.keys()].sort((a, b) => a - b), [11, 12, 14, 16],
      "the four readable ready PRs are measured in this one pass");
    const outcome = (n: number) => timing.compareReads.find((row) => row.pr_number === n)?.outcome;
    assert.equal(outcome(13), "error", "a thrown compare is held, by itself");
    assert.equal(outcome(15), "unreadable", "a compare without ahead_by is held, by itself");
    assert.equal(outcome(12), "read");
    // A failed compare is not memoized: the next pass asks again for exactly those two.
    const before = stub.calls.length;
    await reader.read(prs, MAIN, timing);
    assert.equal(stub.calls.length - before, 2, "only the held PRs are re-read; the measured ones come from the memo");
  } finally {
    timing.finish();
  }
});
