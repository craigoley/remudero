// W1-T2569: two draft batches ran concurrently and the later one's write reverted the earlier
// one's, so the same proposals were redrafted forever at ~$8/spawn.
//
// THE MECHANISM IS ONE LAYER BELOW THE OVERLAP. `DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS` (559_000,
// lib/daemon.ts) stops AWAITING `deps.sweep()` at 9.3 minutes and does NOT CANCEL it. A draft
// batch is 3 sequential drafts at a measured 316s median — ~948s end to end — so it is un-awaited
// EVERY time, keeps running detached, and the next loop iteration starts a fresh sweep carrying a
// fresh batch that reads a pre-write cache.
//
// MEASURED 2026-09-01, six consecutive cycles in perfect alternation (batch -> abandoned -> batch),
// `daemon.sweep.abandoned` carrying `elapsed_ms: 559000` against `bound_ms: 559000`: 16 Architect
// spawns across 5 DISTINCT proposals, $123.30, and a drafts cache frozen at 62 entries throughout.
//
// TWO INDEPENDENT DEFECTS, TWO INDEPENDENT REMEDIES, BOTH PINNED HERE:
//   (1) re-entrancy — a second batch must not start while one is running;
//   (2) the lost update — read-at-start/write-at-end reverts a concurrent writer even when only
//       ONE batch is "running", so the write must merge onto disk rather than onto its snapshot.
// (2) is what still holds when (1) is wrong, which is why it is not folded into it.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireDrainLock } from "../src/lib/drain-lock.js";
import { mergeDraftCaches, type DraftAttemptCache, type DraftCache, type DraftedCandidate } from "../src/lib/inbox.js";
import { buildInboxDraftHook } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

const cand = (id: string): DraftedCandidate => ({
  proposalId: id,
  fragmentYaml: `- id: ${id}\n`,
  stampLine: "stamp",
  anchorFingerprint: "",
});

/** A counting draft batch shared by every test here. SHARED DELIBERATELY: the lock-held test
 *  asserts this body never runs, so if it were inlined there it would be uncovered source in the
 *  diff — the same body is exercised by the tests that DO acquire the lock, which is what makes
 *  "spawned === 0" evidence of the guard rather than evidence of an unreachable fixture. */
function countingBatch(counter: { spawned: number }) {
  return async (due: Array<{ id: string }>) => {
    counter.spawned += due.length;
    return due.map((p) => ({ proposalId: p.id, ok: true as const, candidate: cand(p.id) }));
  };
}

function seedRoot(ids: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-draft-lock-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: ids.map((id) => ({ id, summary: "s", evidenceAnchors: [] })) }),
  );
  return root;
}

// ── (1) re-entrancy ──────────────────────────────────────────────────────────────────────────

test("a second batch does NOT spawn while a first still holds the lock — the abandoned-but-running case", async () => {
  const root = seedRoot(["P1", "P2"]);
  const config = { root } as Config;
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const log = (s: string, e: Record<string, unknown> = {}) => logs.push({ step: s, extra: e });

  // Stand in for the abandoned-but-still-running batch: a LIVE holder (this process).
  const held = acquireDrainLock(join(root, "state", "inbox-draft.lock"));
  try {
    const counter = { spawned: 0 };
    const hook = buildInboxDraftHook("o", "r", config, "RUN-1", log, countingBatch(counter));
    await hook();
    assert.equal(counter.spawned, 0, "a second batch must spawn ZERO Architects while another batch is running");
    const skipped = logs.filter((l) => l.step === "inbox.draft_batch.skipped");
    assert.equal(skipped.length, 1, "and the skip must be visible, not silent — a stuck lock cannot look like a quiet rung");
  } finally {
    held.release();
  }
});

test("once the holder releases, the rung runs again — the guard is a lock, not an off switch", async () => {
  const root = seedRoot(["P1"]);
  const config = { root } as Config;
  const held = acquireDrainLock(join(root, "state", "inbox-draft.lock"));
  held.release();

  const counter = { spawned: 0 };
  const hook = buildInboxDraftHook("o", "r", config, "RUN-1", () => {}, countingBatch(counter));
  await hook();
  assert.equal(counter.spawned, 1, "a released lock must not keep the rung suppressed");
  assert.equal(existsSync(join(root, "state", "inbox-draft.lock")), false, "and the lock is released on the way out");
});

test("a lock stranded by a KILLED daemon is reclaimed, not honoured forever — the W1-T1067 failure, one file over", async () => {
  const root = seedRoot(["P1"]);
  const config = { root } as Config;
  // A holder whose pid cannot be alive, on THIS host: the shape a `docker kill` leaves behind.
  //
  // ⚠ THE HOST MUST BE THE LOCAL ONE, AND THAT IS THE POINT, NOT AN INCIDENTAL FIXTURE DETAIL.
  // `isHolderStale` REFUSES to declare a foreign host's lock stale — it cannot probe a pid on
  // another machine, and guessing would let one host sweep another's live lock. A first draft of
  // this test used a made-up hostname and read as a missing staleness bound when the rule was in
  // fact correct. A daemon killed HERE records THIS host, which is the case that must reclaim.
  writeFileSync(
    join(root, "state", "inbox-draft.lock"),
    JSON.stringify({ pid: 2147483646, host: hostname(), startedAt: new Date(0).toISOString() }),
  );
  const counter = { spawned: 0 };
  const hook = buildInboxDraftHook("o", "r", config, "RUN-1", () => {}, countingBatch(counter));
  await hook();
  assert.equal(counter.spawned, 1, "without a staleness bound a stranded lock suppresses this rung forever — the W1-T1067 lesson");
});

// ── (2) the lost update, independent of the guard ────────────────────────────────────────────

test("no draft written by a concurrent writer is missing after this batch commits — merge, not spread", async () => {
  // EXACTLY the measured failure: a batch snapshots an empty cache, another writer commits A while
  // it runs, and the batch then writes its own B. A plain `{...snapshot, ...mine}` reverts A.
  const snapshot = { drafts: {} as DraftCache, attempts: {} as DraftAttemptCache };
  const onDiskNow = { drafts: { A: cand("A") } as DraftCache, attempts: { A: "::0" } as DraftAttemptCache };
  const mine = { drafts: { B: cand("B") } as DraftCache, attempts: { B: "::0" } as DraftAttemptCache };

  const naive = { ...snapshot.drafts, ...mine.drafts };
  assert.equal(naive.A, undefined, "the spread this replaces really does lose A — the defect, reproduced");

  const merged = mergeDraftCaches(onDiskNow, mine);
  assert.ok(merged.drafts.A, "A must survive: it was committed by another writer while this batch ran");
  assert.ok(merged.drafts.B, "and B must land: it is this batch's own result");
  assert.deepEqual(Object.keys(merged.attempts).sort(), ["A", "B"]);
});

test("on the same id THIS batch's result wins — the fresher observation, never a silent drop", () => {
  const onDisk = { drafts: { A: cand("A-old") } as DraftCache, attempts: { A: "old" } as DraftAttemptCache };
  const mine = { drafts: { A: cand("A-new") } as DraftCache, attempts: { A: "new" } as DraftAttemptCache };
  const merged = mergeDraftCaches(onDisk, mine);
  assert.equal(merged.drafts.A.proposalId, "A-new");
  assert.equal(merged.attempts.A, "new");
});

test("the batch's write MERGES onto disk end to end, so a concurrent commit survives a real hook run", async () => {
  const root = seedRoot(["P1"]);
  const config = { root } as Config;
  const draftsPath = join(root, "state", "inbox-drafts.json");
  const attemptsPath = join(root, "state", "inbox-draft-attempts.json");

  const hook = buildInboxDraftHook("o", "r", config, "RUN-1", () => {}, async (due) => {
    // Another writer commits WHILE this batch runs — the ~950s window the measured defect had.
    writeFileSync(draftsPath, JSON.stringify({ OTHER: cand("OTHER") }));
    writeFileSync(attemptsPath, JSON.stringify({ OTHER: "::0" }));
    return due.map((p) => ({ proposalId: p.id, ok: true as const, candidate: cand(p.id) }));
  });
  await hook();

  const drafts = JSON.parse(readFileSync(draftsPath, "utf8"));
  assert.ok(drafts.OTHER, "the concurrent writer's entry must survive — losing it is the $123.30 defect");
  assert.ok(drafts.P1, "and this batch's own result must land");
});
