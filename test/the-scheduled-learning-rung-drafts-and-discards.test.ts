/**
 * W1-T3324 — THE SCHEDULED CI-LEARNING RUNG DRAFTED AND DISCARDED.
 *
 * MEASURED before this change, across all three ledger rotation forms:
 *   ci_learning_cadence.ran  2026-09-07  drafts=3 excluded=20
 *   ci_learning_cadence.ran  2026-09-08  drafts=3 excluded=30
 * and `grep -rl 'origin:.*ci-learning' plan/tasks.d/` returned ZERO. Six drafts minted, none filed.
 *
 * TWO CALLERS DISAGREED AND ONLY ONE WAS WIRED. `rmd ci-learning` typed by hand called
 * `fileCiLearningShards`; the daemon arm called `mintCiLearningShards(corpus, [])` and returned
 * four counts. This suite pins the daemon arm to the filing contract the CLI already honours.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCiLearningCadenceRunner } from "../src/run-task.js";

/** One repaired pair is the minimum mintable corpus — the lesson is in the DELTA. */
function windowWithOneRepair() {
  return {
    prs: [
      {
        number: 4321,
        commits: [
          { sha: "aaa1111", rollup: [{ name: "ci-gate", conclusion: "FAILURE" }], changedFiles: ["src/lib/x.ts"] },
          { sha: "bbb2222", rollup: [{ name: "ci-gate", conclusion: "SUCCESS" }], changedFiles: ["src/lib/x.ts"] },
        ],
      },
    ],
  } as never;
}

/** A recorder standing in for the real filer, so no shard is written to a real plan. */
function recordingFiler() {
  const calls: Array<{ drafts: unknown[]; planOrigins: string[] }> = [];
  const fn = (drafts: unknown[], _root: string, opts: { planOrigins: string[] }) => {
    calls.push({ drafts, planOrigins: opts.planOrigins });
    return { filed: drafts.map((_, i) => ({ taskId: `W1-TNEW${i}`, relPath: `plan/tasks.d/x${i}.yaml` })), skipped: [], refused: [] };
  };
  return { calls, fn };
}

test("W1-T3324: the scheduled rung calls the filer, so a drafted shard reaches the plan instead of a counter", async () => {
  const filer = recordingFiler();
  const run = buildCiLearningCadenceRunner({
    root: "/tmp/w1t3324-root",
    checkoutRoot: "/tmp/w1t3324-checkout",
    loadWindow: () => windowWithOneRepair(),
    fileShards: filer.fn as never,
    planOrigins: ["operator-session#something-else"],
    recordFire: () => {},
  });

  const result = await run();

  assert.equal(filer.calls.length, 1, "the scheduled path must call the filer exactly once");
  assert.ok(result.filedCount >= 1, `the run result must report what LANDED, got filedCount=${result.filedCount}`);
});

test("W1-T3324: the plan-origins surface is LOAD-BEARING — a cause already filed is deduped away", async () => {
  // The shipped arm passed `[]`, so nothing could ever dedup and wiring the filer alone would
  // re-file the same cause four times a day. Proving the array is PASSED is weaker than proving it
  // WORKS, so this drives both sides of the same surface.
  const fresh = recordingFiler();
  const runFresh = buildCiLearningCadenceRunner({
    root: "/tmp/w1t3324-root",
    checkoutRoot: "/tmp/w1t3324-checkout",
    loadWindow: () => windowWithOneRepair(),
    fileShards: fresh.fn as never,
    planOrigins: ["operator-session#unrelated"],
    recordFire: () => {},
  });
  const freshResult = await runFresh();
  assert.ok(freshResult.draftCount >= 1, "control: an unrelated origin surface leaves the cause mintable");
  assert.equal(fresh.calls.length, 1, "and the filer is reached");
  // BOTH CONSUMERS, because the surface is used twice and a falsifier proved one assertion missed
  // the other: `mintCiLearningShards` dedups at mint time, and `fileCiLearningShards` dedups again
  // at write time. Emptying only the filer's copy left this suite green until this line existed.
  assert.deepEqual(
    fresh.calls[0]!.planOrigins,
    ["operator-session#unrelated"],
    "the FILER must receive the same real origin surface the minter got, not an empty array",
  );

  // Now the SAME corpus against a surface that already holds this cause.
  const dup = recordingFiler();
  const runDup = buildCiLearningCadenceRunner({
    root: "/tmp/w1t3324-root",
    checkoutRoot: "/tmp/w1t3324-checkout",
    loadWindow: () => windowWithOneRepair(),
    fileShards: dup.fn as never,
    planOrigins: ["ci-learning:4321:ci-gate"],
    recordFire: () => {},
  });
  const dupResult = await runDup();
  assert.equal(dupResult.draftCount, 0, "a cause the plan already holds must not be re-drafted");
  assert.equal(dup.calls.length, 0, "and the filer must not be reached at all");
});

test("W1-T3324: a firing whose window read THROWS releases its allowance, so a transient outage does not spend the day", async () => {
  // The observed 2026-09-09 shape: `gh: Bad credentials (HTTP 401)` from loadCiFailureWindow, with
  // `maxPerDay: 1`, consumed the day and produced nothing.
  const fires: string[] = [];
  const releases: string[] = [];
  const run = buildCiLearningCadenceRunner({
    root: "/tmp/w1t3324-root",
    checkoutRoot: "/tmp/w1t3324-checkout",
    loadWindow: () => {
      throw new Error("Command failed: gh api ... Bad credentials (HTTP 401)");
    },
    fileShards: recordingFiler().fn as never,
    planOrigins: [],
    recordFire: () => fires.push("fired"),
    releaseFire: () => releases.push("released"),
  });

  await assert.rejects(run(), /Bad credentials/, "the throw must still surface — this is not a swallow");
  assert.deepEqual(fires, ["fired"], "the fire is still recorded first, guarding the crash-loop");
  assert.deepEqual(releases, ["released"], "and released, because this run did no work");
});

test("W1-T3324: a firing that FILED keeps its fire, so the crash-loop guard still holds", async () => {
  // The mirror. A run that did work must not release — otherwise the expensive window re-runs every
  // tick, which is what "THE FIRE FIRST" exists to stop.
  const fires: string[] = [];
  const releases: string[] = [];
  const run = buildCiLearningCadenceRunner({
    root: "/tmp/w1t3324-root",
    checkoutRoot: "/tmp/w1t3324-checkout",
    loadWindow: () => windowWithOneRepair(),
    fileShards: recordingFiler().fn as never,
    planOrigins: [],
    recordFire: () => fires.push("fired"),
    releaseFire: () => releases.push("released"),
  });

  await run();
  assert.deepEqual(fires, ["fired"]);
  assert.deepEqual(releases, [], "a run that filed must KEEP its fire");
});

test("W1-T3324: the run result names what LANDED, so filed-nothing and drafted-nothing are distinguishable", async () => {
  // A filer that refuses everything: drafts exist, nothing lands. Reporting only draftCount would
  // render this identically to a clean, fully-filed run.
  const refusingFiler = (drafts: unknown[]) => ({
    filed: [],
    skipped: [],
    refused: (drafts as Array<{ findingId?: string }>).map((d) => ({ findingId: d.findingId ?? "?", reason: "linter refused" })),
  });
  const run = buildCiLearningCadenceRunner({
    root: "/tmp/w1t3324-root",
    checkoutRoot: "/tmp/w1t3324-checkout",
    loadWindow: () => windowWithOneRepair(),
    fileShards: refusingFiler as never,
    planOrigins: [],
    recordFire: () => {},
  });

  const result = await run();
  assert.ok(result.draftCount >= 1, "control: the corpus really did produce a draft");
  assert.equal(result.filedCount, 0, "and the result must say nothing landed");
  assert.ok(result.refusedCount >= 1, "naming the refusal, never dropping it");
});

test("W1-T3324: every record the scheduled path drafts still carries author_class machine and verify human", async () => {
  const filer = recordingFiler();
  const run = buildCiLearningCadenceRunner({
    root: "/tmp/w1t3324-root",
    checkoutRoot: "/tmp/w1t3324-checkout",
    loadWindow: () => windowWithOneRepair(),
    fileShards: filer.fn as never,
    planOrigins: [],
    recordFire: () => {},
  });

  await run();
  const drafts = filer.calls[0]!.drafts as Array<{ author_class?: string; verify?: string }>;
  assert.ok(drafts.length >= 1, "control: a draft was handed to the filer");
  for (const d of drafts) {
    assert.equal(d.author_class, "machine", "a machine-filed record must say so");
    assert.equal(d.verify, "human", "and must park until a ruling or an operator releases it");
  }
});
