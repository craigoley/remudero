import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ORPHAN_RUN_BRANCH_GRACE_MS,
  orphanRunBranchReleased,
  runDrain,
  stillBlockedByPushedRunBranch,
  type OrphanRunBranchEvidence,
  type PushedRunRef,
} from "../src/lib/drain.js";
import { runDaemon } from "../src/lib/daemon.js";
import { orphanRunBranchEvidenceReader, writeAutomaticBranchReapState } from "../src/lib/branch-reaper.js";
import { fixedClock } from "../src/lib/clock.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// The live shape measured on 2026-09-30: twelve tasks each held by ONE run branch the reaper
// proved has no PR, 1-2 commits ahead of main, refused 31 times apiece in 23 hours.
const ORPHAN = "run-W1-T3720-1790578461549";
const ORPHAN_SHA = "4b1c0ffee4b1c0ffee4b1c0ffee4b1c0ffee4b1c";
const ORPHAN_EPOCH = 1790578461549;
const LATER = ORPHAN_EPOCH + ORPHAN_RUN_BRANCH_GRACE_MS + 60_000;

const ref: PushedRunRef = { taskId: "W1-T3720", ref: ORPHAN, sha: ORPHAN_SHA };
const evidence = (over: Partial<OrphanRunBranchEvidence> = {}): OrphanRunBranchEvidence => ({
  noPrHeadShas: { [ORPHAN]: ORPHAN_SHA },
  nowMs: LATER,
  liveTaskIds: new Set(),
  ...over,
});

function tmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${label}-`));
}

function orphanPlan(): Plan {
  const dir = tmp("orphan-plan");
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    `- id: W1-T3720\n  title: orphaned build\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`,
  );
  return loadPlan(f);
}

const ok = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" });

test("an orphan run ref with a proven no-PR tip past the grace and no live run is released", () => {
  assert.equal(orphanRunBranchReleased(ref, evidence()), true);
});

test("an orphan run ref keeps blocking whenever any release condition is unproven", () => {
  assert.equal(orphanRunBranchReleased(ref, undefined), false, "no evidence read at all");
  assert.equal(orphanRunBranchReleased({ ...ref, sha: undefined }, evidence()), false, "a bare ref line carries no sha");
  assert.equal(orphanRunBranchReleased(ref, evidence({ noPrHeadShas: {} })), false, "the reaper never proved no PR");
  assert.equal(
    orphanRunBranchReleased(ref, evidence({ noPrHeadShas: { [ORPHAN]: "0000000000000000000000000000000000000000" } })),
    false,
    "a re-push moved the tip off the proven sha",
  );
  assert.equal(orphanRunBranchReleased(ref, evidence({ nowMs: ORPHAN_EPOCH + 60_000 })), false, "still inside the grace");
  assert.equal(orphanRunBranchReleased(ref, evidence({ liveTaskIds: new Set(["W1-T3720"]) })), false, "a live run holds the lock");
  const oddEpoch: PushedRunRef = { taskId: "W1-T3906", ref: "run-W1-T3906-17899494673N", sha: ORPHAN_SHA };
  assert.equal(
    orphanRunBranchReleased(oddEpoch, evidence({ noPrHeadShas: { "run-W1-T3906-17899494673N": ORPHAN_SHA } })),
    false,
    "a name with no readable epoch is never aged",
  );
  assert.equal(orphanRunBranchReleased(ref, evidence({ graceMs: LATER })), false, "a caller-chosen grace is honoured");
});

test("a second unproven run ref for the same task keeps the orphan task blocked", () => {
  const young: PushedRunRef = { taskId: "W1-T3720", ref: `run-W1-T3720-${LATER - 1000}`, sha: "feedfacefeedfacefeedfacefeedfacefeedface" };
  const pushed = new Set(["W1-T3720"]);
  assert.equal(stillBlockedByPushedRunBranch("W1-T3720", pushed, undefined, [ref], [], evidence()), false);
  assert.equal(stillBlockedByPushedRunBranch("W1-T3720", pushed, undefined, [ref, young], [], evidence()), true);
});

test("the daemon dispatches a task held only by an orphan run branch and ledgers the release", async () => {
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const merged = new Set<string>();
  await runDaemon(
    orphanPlan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      readPushedRunBranches: () => `${ORPHAN_SHA}\trefs/heads/${ORPHAN}`,
      readOrphanRunBranchEvidence: () => evidence(),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return ok(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
      sleep: async () => {},
      // A regression refuses the task and idles: stop on the refusal so it fails instead of hanging.
      checkStop: () => (lines.some((l) => l.extra.reason === "run-branch-already-pushed") ? "test done" : undefined),
    },
    { max: 1 },
  );
  assert.deepEqual(ran, ["W1-T3720"]);
  const release = lines.find((l) => l.step === "dispatch.run_branch_exception");
  assert.equal(release?.extra.reason, "orphan-run-branch-no-pr");
  assert.equal(release?.extra.ref, ORPHAN);
  assert.ok(!lines.some((l) => l.extra.reason === "run-branch-already-pushed"));
});

test("the daemon still refuses the orphan task when no orphan evidence is supplied", async () => {
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDaemon(
    orphanPlan(),
    {
      refreshMerged: () => () => false,
      readPushedRunBranches: () => `${ORPHAN_SHA}\trefs/heads/${ORPHAN}`,
      runOne: async (id) => {
        ran.push(id);
        return ok(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
      sleep: async () => {},
      // Nothing is runnable, so the daemon would idle forever: stop once the refusal is ledgered.
      checkStop: () => (lines.some((l) => l.extra.reason === "run-branch-already-pushed") ? "test done" : undefined),
    },
    { max: 1 },
  );
  assert.deepEqual(ran, []);
  assert.ok(lines.some((l) => l.extra.reason === "run-branch-already-pushed"));
});

test("runDrain releases an orphan run branch through the same shared predicate", async () => {
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDrain(
    orphanPlan(),
    {
      refreshMerged: () => () => false,
      readPushedRunBranches: () => `${ORPHAN_SHA}\trefs/heads/${ORPHAN}`,
      readOrphanRunBranchEvidence: () => evidence(),
      runOne: async (id) => {
        ran.push(id);
        return ok(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.deepEqual(ran, ["W1-T3720"]);
  assert.equal(lines.find((l) => l.step === "dispatch.run_branch_exception")?.extra.reason, "orphan-run-branch-no-pr");
});

test("the multi-lane drain releases an orphan run branch through the same shared predicate", async () => {
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDrain(
    orphanPlan(),
    {
      refreshMerged: () => () => false,
      readPushedRunBranches: () => `${ORPHAN_SHA}\trefs/heads/${ORPHAN}`,
      readOrphanRunBranchEvidence: () => evidence(),
      runOne: async (id) => {
        ran.push(id);
        return ok(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { laneCount: 2, max: 1 },
  );
  assert.deepEqual(ran, ["W1-T3720"]);
  assert.equal(lines.find((l) => l.step === "dispatch.run_branch_exception")?.extra.reason, "orphan-run-branch-no-pr");
});

test("the orphan evidence reader returns the reaper no-PR cache with the clock and live locks", () => {
  const root = tmp("orphan-evidence");
  try {
    const statePath = join(root, "branch-reap-state.remudero.json");
    writeAutomaticBranchReapState(statePath, { lastRunAtMs: 1, noPrHeadShas: { [ORPHAN]: ORPHAN_SHA } });
    const read = orphanRunBranchEvidenceReader(statePath, () => ["W1-T4904"], fixedClock(LATER))();
    assert.deepEqual(read?.noPrHeadShas, { [ORPHAN]: ORPHAN_SHA });
    assert.equal(read?.nowMs, LATER);
    assert.deepEqual([...(read?.liveTaskIds ?? [])], ["W1-T4904"]);
    const empty = orphanRunBranchEvidenceReader(join(root, "absent.json"), () => [], fixedClock(LATER))();
    assert.deepEqual(empty?.noPrHeadShas, {}, "no state file proves nothing and releases nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the orphan evidence reader releases nothing when the live lock read throws", () => {
  const read = orphanRunBranchEvidenceReader(
    "/nonexistent/branch-reap-state.json",
    () => {
      throw new Error("EACCES: inflight dir unreadable");
    },
    fixedClock(LATER),
  )();
  assert.equal(read, undefined);
  assert.equal(orphanRunBranchReleased(ref, read), false);
});
