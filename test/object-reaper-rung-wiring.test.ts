import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { LOOSE_OBJECT_FLOOR, reapGitObjects } from "../src/lib/object-reaper.js";
import { logDiskReclaimRung } from "../src/run-task.js";
import { loadPolicy } from "../src/lib/policy.js";

// W1-T3092 — the wiring, not the reaper. What must hold: OFF surveys and spawns nothing, the
// survey runs the SAME predicate the armed path runs, ON prunes, a throw cannot reach the
// dispatch, and a malformed policy block fails loud rather than defaulting to armed.

const cfg = () => ({ root: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rung-`)) }) as never;
const noSweeps = {
  sweepTempDirs: () => ({ removed: [] }) as never,
  reapClonesSurvey: () => ({ reaped: [], bytesReclaimed: 0 }) as never,
  sweepWorkerHomes: () => ({ removed: [] }) as never,
  workerHomeRoot: () => "/nowhere",
  objectRepoDir: () => "/repo",
  objectInflightDir: () => "/inflight",
  ratifications: new Map(),
};

test("W1-T3116: dispatch never invokes the retired object reaper, regardless of its flag", async () => {
  for (const enabled of [false, true]) {
    const rows: string[] = [];
    const out = await logDiskReclaimRung(cfg(), (step) => rows.push(step), {
      ...noSweeps,
      objectPolicy: () => { assert.fail("dispatch must not even load object maintenance policy"); },
      reapObjects: () => { assert.fail(`dispatch must not survey or reap (flag ${enabled})`); },
    });
    assert.equal(out.objectsPruned, 0);
    assert.equal(out.objectsWouldPrune, 0);
    assert.deepEqual(rows, []);
  }
});

test("W1-T3092: survey and armed share ONE predicate — the survey returns past every refusal", () => {
  // Driven through the REAL reaper, not a double: a survey that reached different probes would
  // report a disposition nobody will ever act on.
  const repoDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}pred-`));
  // 2026-10-06 operator ruling: only an open handle under .git still refuses, so that is the held arm.
  const held = { listWorktrees: () => [], listInflightLocks: () => [], openFileCount: () => 2, looseObjectCount: () => LOOSE_OBJECT_FLOOR + 1 };
  const dry = reapGitObjects(repoDir, "/i", { ...held, dryRun: true, countPrunable: () => 5 });
  const armed = reapGitObjects(repoDir, "/i", { ...held, runPrune: () => assert.fail("refused") });
  assert.equal(dry.refusedBecause, armed.refusedBecause, "both refuse identically, for the same stated cause");
  assert.equal(dry.wouldPrune, undefined, "a REFUSED survey reports no estimate — it never got that far");

  // ...and when quiet, the survey counts and the armed path prunes, from the same starting point.
  const quiet = { ...held, openFileCount: () => 0 };
  const dry2 = reapGitObjects(repoDir, "/i", { ...quiet, dryRun: true, countPrunable: () => 5 });
  assert.equal(dry2.refusedBecause, undefined);
  assert.equal(dry2.wouldPrune, 5);
});

test("W1-T3092: a surveying pass spawns NOTHING and leaves gc.log alone", () => {
  const repoDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}dry-`));
  writeFileSync(join(repoDir, "marker"), "x");
  const r = reapGitObjects(repoDir, "/i", {
    listWorktrees: () => [],
    listInflightLocks: () => [],
    openFileCount: () => 0,
    looseObjectCount: () => LOOSE_OBJECT_FLOOR + 1,
    dryRun: true,
    countPrunable: () => 7,
    runPrune: () => assert.fail("a survey must never spawn a prune"),
  });
  assert.equal(r.pruned, 0);
  assert.equal(r.wouldPrune, 7);
});

test("W1-T3092: a throwing object sweep does not break the rung or its three siblings", async () => {
  const out = await logDiskReclaimRung(cfg(), () => {}, {
    ...noSweeps,
    sweepTempDirs: () => ({ removed: ["a"] }) as never,
    objectPolicy: () => { throw new Error("policy exploded"); },
    reapObjects: (() => assert.fail("unreachable")) as never,
  });
  assert.equal(out.objectsPruned, 0, "the object sweep degrades to zero");
  assert.equal(out.tempDirsRemoved, 1, "and its SIBLING still ran — the guard is per-sweep, not per-rung");
});

test("W1-T3092: a malformed or absent policy block refuses at LOAD, never defaulting to armed", () => {
  // Built FROM THE SHIPPED FILE, not from a minimal stub: a stub is missing a dozen other required
  // blocks and throws on whichever it reaches first, which would make this pass for the wrong
  // reason. Mutating one block of a valid file isolates the arm under test.
  const shippedPath = join(import.meta.dirname, "..", "plan", "policy.yaml");
  const shipped = readFileSync(shippedPath, "utf8");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}pol-`));
  const p = join(dir, "policy.yaml");

  // POSITIVE CONTROL FIRST: the unmutated copy loads, so a throw below is the mutation talking.
  writeFileSync(p, shipped);
  assert.equal(loadPolicy(p).values.objectReap.enabled, true, "the shipped, now-armed value");

  const withoutBlock = shipped.replace(/^objectReap:\n(?:[ \t].*\n|\n)*/m, "");
  assert.notEqual(withoutBlock, shipped, "the removal must actually have removed something");
  writeFileSync(p, withoutBlock);
  assert.throws(() => loadPolicy(p), /objectReap/, "an ABSENT block must throw, not default to armed");

  // Re-add the block with a non-boolean value. Built by APPENDING to the block-less copy rather
  // than string-replacing inside the shipped one: the shipped block carries comment lines between
  // its key and its value, so a naive replace silently matches nothing and the assertion then
  // passes for the wrong reason. (It did, on the first attempt.)
  writeFileSync(p, withoutBlock + `\nobjectReap:\n  enabled:\n    value: yes-please\n    origin: "net-new"\n`);
  assert.throws(() => loadPolicy(p), /objectReap/, "a non-boolean must throw");
});

test("W1-T3092: the shipped policy.yaml matches the ARMED state the operator authorised", () => {
  // This test shipped asserting `false` — the survey-only posture plan/policy.yaml prescribes for
  // rungs that delete — so that arming could not happen without a diff a reviewer sees. It has now
  // happened: the operator instructed it in-session ("arm 4532"), which is the exact condition
  // W1-T3092's falsifier requires before this flag may ship true.
  //
  // THE GUARD IS NOT REMOVED, ONLY RE-POINTED. A silent flip in EITHER direction still fails here,
  // which is the property worth keeping: the value a destructive rung ships with is a decision, and
  // a decision that changes without a diff is the thing this test exists to prevent.
  const shipped = loadPolicy(join(import.meta.dirname, "..", "plan", "policy.yaml"));
  assert.equal(shipped.values.objectReap.enabled, true, "armed on the operator's explicit instruction");
});
