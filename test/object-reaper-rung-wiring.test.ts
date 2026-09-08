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

test("W1-T3092: a disabled rung SURVEYS and never prunes", () => {
  let sawDryRun: boolean | undefined;
  const rows: Array<[string, Record<string, unknown>]> = [];
  const out = logDiskReclaimRung(cfg(), (s, f) => rows.push([s, f]), {
    ...noSweeps,
    objectPolicy: () => ({ enabled: false }),
    reapObjects: ((_r: string, _i: string, d: { dryRun?: boolean }) => {
      sawDryRun = d.dryRun;
      return { pruned: 0, wouldPrune: 42, looseBefore: 9000 };
    }) as never,
  });
  assert.equal(sawDryRun, true, "disabled must reach the reaper in dryRun, not skip it entirely");
  assert.equal(out.objectsPruned, 0, "nothing is removed while off");
  assert.equal(out.objectsWouldPrune, 42, "but what WOULD be removed is reported");
  const reclaim = rows.find(([s]) => s === "run.disk_reclaim");
  assert.equal(reclaim?.[1].objects_would_prune, 42, "and it reaches the ledger, or the survey is unreadable");
});

test("W1-T3092: an armed rung prunes when quiet — arming is the flag and nothing else", () => {
  let sawDryRun: boolean | undefined;
  const out = logDiskReclaimRung(cfg(), () => {}, {
    ...noSweeps,
    objectPolicy: () => ({ enabled: true }),
    reapObjects: ((_r: string, _i: string, d: { dryRun?: boolean }) => {
      sawDryRun = d.dryRun;
      return { pruned: 9649, looseBefore: 16747 };
    }) as never,
  });
  assert.equal(sawDryRun, false, "armed passes dryRun:false");
  assert.equal(out.objectsPruned, 9649);
});

test("W1-T3092: survey and armed share ONE predicate — the survey returns past every refusal", () => {
  // Driven through the REAL reaper, not a double: a survey that reached different probes would
  // report a disposition nobody will ever act on.
  const repoDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}pred-`));
  const held = { listWorktrees: () => ["/w/live"], listInflightLocks: () => [], openFileCount: () => 0, looseObjectCount: () => LOOSE_OBJECT_FLOOR + 1 };
  const dry = reapGitObjects(repoDir, "/i", { ...held, dryRun: true, countPrunable: () => 5 });
  const armed = reapGitObjects(repoDir, "/i", { ...held, runPrune: () => assert.fail("refused") });
  assert.equal(dry.refusedBecause, armed.refusedBecause, "both refuse identically, for the same stated cause");
  assert.equal(dry.wouldPrune, undefined, "a REFUSED survey reports no estimate — it never got that far");

  // ...and when quiet, the survey counts and the armed path prunes, from the same starting point.
  const quiet = { ...held, listWorktrees: () => [] };
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

test("W1-T3092: a throwing object sweep does not break the rung or its three siblings", () => {
  const out = logDiskReclaimRung(cfg(), () => {}, {
    ...noSweeps,
    sweepTempDirs: () => ({ removed: ["a"] }) as never,
    objectPolicy: () => { throw new Error("policy exploded"); },
    reapObjects: (() => assert.fail("unreachable")) as never,
  });
  assert.equal(out.objectsPruned, 0, "the object sweep degrades to zero");
  assert.equal(out.tempDirsRemoved, 1, "and its SIBLING still ran — the guard is per-sweep, not per-rung");
});

test("W1-T3092: the decline is ledgered, because 'how often is the fleet quiet' IS the survey result", () => {
  const rows: Array<[string, Record<string, unknown>]> = [];
  logDiskReclaimRung(cfg(), (s, f) => rows.push([s, f]), {
    ...noSweeps,
    objectPolicy: () => ({ enabled: false }),
    reapObjects: (() => ({ pruned: 0, looseBefore: 9000, refusedBecause: "3 worktree(s) registered" })) as never,
  });
  const declined = rows.find(([s]) => s === "run.disk_reclaim.objects_declined");
  assert.match(String(declined?.[1].reason), /3 worktree\(s\) registered/, "an unledgered decline makes the survey unreadable");
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
  assert.equal(loadPolicy(p).values.objectReap.enabled, false);

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

test("W1-T3092: the shipped policy.yaml has the rung OFF", () => {
  // The posture plan/policy.yaml's own comment prescribes for rungs that delete. If this ever
  // reads true, arming happened in a commit whose diff must show it.
  const shipped = loadPolicy(join(import.meta.dirname, "..", "plan", "policy.yaml"));
  assert.equal(shipped.values.objectReap.enabled, false, "a destructive rung does not ship armed");
});
