import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BOARD_IRRELEVANT_STEPS,
  EMPTY_DECISION_FINGERPRINT,
  createBoardSnapshotCache,
  decisionKey,
  foldDecisionFingerprint,
  isDecisionRelevantRow,
  type BoardDeps,
} from "../src/lib/board.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";

/**
 * test/board-snapshot-cache-ignores-heartbeats.test.ts — W1-T2919.
 *
 * `createBoardSnapshotCache` keyed on the LIVE LEDGER'S TOTAL LINE COUNT. The daemon appends
 * `daemon.alive` on every poll and the board gateway appends `board_gateway.fetch_bytes` on every
 * fetch, so each moved the count, invalidated the snapshot, and made the next console read
 * recompute `projectPlan` synchronously on the single-threaded HTTP server — the console froze for
 * about a second at least once a minute with nothing on the board having changed.
 *
 * THE HONEST LIMIT OF WHAT WAS RE-MEASURED HERE: this container carries NO ledger (`state/` is
 * empty and untracked), so the audit's live figures — 1.1 s at 1,347 tasks × 10k lines, and how
 * much of the corpus is heartbeat — could NOT be re-derived and are not restated as though they
 * had been. What IS re-derived is the part the fix turns on, and it is checked with a control:
 * neither excluded step is READ anywhere in the projection path (`daemon.alive` zero occurrences;
 * every `board_gateway.fetch_bytes` occurrence a `log(...)` write or a comment about one), against
 * a control step that IS read (`run.start`, 43 hits across the same two files).
 */

function task(over: Partial<Task> = {}): Task {
  return { id: "W1-TX", title: "t", repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0, ...over };
}
const planOf = (tasks: Task[]): Plan => ({ tasks, byId: new Map(tasks.map((t) => [t.id, t])) });

function tmpLedgerPath(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}board-heartbeat-`));
  const path = join(dir, "ledger.ndjson");
  writeFileSync(path, "");
  return { path, dir };
}

const row = (step: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step, ...extra }) + "\n";

/** A gateway whose `prByRef` counts calls — the same recompute proxy board.test.ts's own cache
 *  tests use: a cache HIT calls github zero times, so `calls` is a direct read of "did a real
 *  re-projection happen". */
function countingGitHub(counter: { calls: number }): GitHub {
  return {
    prByRef: (ref) => {
      counter.calls += 1;
      return String(ref) === "1" ? { number: 1, url: "https://github.com/o/r/pull/1", state: "OPEN" } : null;
    },
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

// ── the behaviour the task exists for ──────────────────────────────────────────────────────────

test("W1-T2919: heartbeat and gateway-telemetry rows do not invalidate the board snapshot", () => {
  const { path: ledgerPath, dir } = tmpLedgerPath();
  try {
    const counter = { calls: 0 };
    const deps: BoardDeps = { plan: planOf([task({ id: "W1-T1", pr: 1 })]), ledgerPath, github: countingGitHub(counter) };
    const cache = createBoardSnapshotCache();

    const first = cache.get(deps);
    assert.equal(counter.calls, 1, "the first read computes");

    // THE CONTROL THAT MAKES THIS LOAD-BEARING: these appends really do move the raw line count,
    // so the OLD key — the count itself — would have invalidated on every one of them. The test
    // is asserting that a change the old code reacted to is now correctly ignored, not that
    // nothing happened.
    const before = foldDecisionFingerprint([], EMPTY_DECISION_FINGERPRINT);
    appendFileSync(ledgerPath, row("daemon.alive"));
    appendFileSync(ledgerPath, row("board_gateway.fetch_bytes", { bytes: 1024 }));
    appendFileSync(ledgerPath, row("daemon.alive"));
    assert.equal(before.foldedUpTo, 0);

    const second = cache.get(deps);
    assert.equal(counter.calls, 1, "three heartbeat/telemetry appends -> ZERO recomputes");
    assert.equal(second, first, "and the SAME snapshot object is returned, not an equal copy");

    // A decision-relevant row invalidates exactly once, and then settles.
    appendFileSync(ledgerPath, row("review.posted"));
    const third = cache.get(deps);
    assert.equal(counter.calls, 2, "a decision-relevant append -> exactly one recompute");
    assert.notEqual(third, second, "and a genuinely fresh snapshot");
    cache.get(deps);
    assert.equal(counter.calls, 2, "which then settles back to a hit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2919: the old line-count key WOULD have invalidated on those same appends — the control, stated as an assertion", () => {
  // Without this, "no recompute happened" is satisfiable by a ledger nothing was appended to.
  const rows = [{ step: "run.start", ts: "1" }, { step: "daemon.alive", ts: "2" }, { step: "board_gateway.fetch_bytes", ts: "3" }];
  assert.equal(rows.length, 3, "the raw COUNT — what the old key read — is 3");
  const fp = foldDecisionFingerprint(rows, EMPTY_DECISION_FINGERPRINT);
  assert.equal(fp.count, 1, "while only ONE row can change a board row");
  assert.equal(decisionKey(foldDecisionFingerprint(rows.slice(0, 1), EMPTY_DECISION_FINGERPRINT)), decisionKey(fp),
    "so the key is identical with and without the two heartbeat rows");
});

// ── the step set, and the direction of its safety ──────────────────────────────────────────────

test("W1-T2919: the irrelevant set is named in ONE place and a new step defaults to decision-relevant", () => {
  assert.deepEqual([...BOARD_IRRELEVANT_STEPS].sort(), ["board_gateway.fetch_bytes", "daemon.alive"]);
  for (const step of BOARD_IRRELEVANT_STEPS) assert.equal(isDecisionRelevantRow({ step }), false, `${step} is excluded`);

  // THE SAFETY DIRECTION, ASSERTED. An INCLUSION list would default an unrecognised step to
  // irrelevant and silently serve a stale board the day a new board-affecting step lands. This
  // exclusion defaults it to relevant: the cache invalidates and only an optimisation is lost.
  assert.equal(isDecisionRelevantRow({ step: "some.step.invented.tomorrow" }), true);
  assert.equal(isDecisionRelevantRow({ step: "review.posted" }), true);
  assert.equal(isDecisionRelevantRow({}), true, "a row with NO step is relevant — unknown stays visible");
  assert.equal(isDecisionRelevantRow({ step: 7 as unknown as string }), true, "and so is a torn one");
});

// ── the fold, including the case the old key had no answer for ─────────────────────────────────

test("W1-T2919: the fold is incremental, and a ROTATION restarts it instead of continuing across a different file", () => {
  const a = [{ step: "run.start", ts: "1" }, { step: "daemon.alive", ts: "2" }];
  const one = foldDecisionFingerprint(a, EMPTY_DECISION_FINGERPRINT);
  assert.equal(one.foldedUpTo, 2);
  assert.equal(one.count, 1);

  // Appending walks only what is new: folding the whole array again from the prior state gives
  // the same answer as folding it once from empty.
  const grown = [...a, { step: "review.posted", ts: "3" }];
  const incremental = foldDecisionFingerprint(grown, one);
  const fromScratch = foldDecisionFingerprint(grown, EMPTY_DECISION_FINGERPRINT);
  assert.equal(decisionKey(incremental), decisionKey(fromScratch), "incremental == from scratch");

  // ROTATION: rotateLedger keeps only the newest rows per step and archives the rest, so the live
  // file shrinks or its head is replaced. Continuing the fold across that would key the cache on
  // a file that no longer exists.
  const rotatedShorter = [{ step: "review.posted", ts: "3" }];
  assert.equal(
    decisionKey(foldDecisionFingerprint(rotatedShorter, incremental)),
    decisionKey(foldDecisionFingerprint(rotatedShorter, EMPTY_DECISION_FINGERPRINT)),
    "a SHRUNK log restarts the fold",
  );
  const rotatedSameLength = [{ step: "review.posted", ts: "9" }, { step: "run.start", ts: "10" }];
  assert.equal(
    decisionKey(foldDecisionFingerprint(rotatedSameLength, one)),
    decisionKey(foldDecisionFingerprint(rotatedSameLength, EMPTY_DECISION_FINGERPRINT)),
    "and so does one whose HEAD changed while its length did not — the case a bare count cannot see",
  );
});

test("W1-T2919: order is part of the key, so a reordering is not mistaken for the same log", () => {
  const forward = [{ step: "run.start", ts: "1" }, { step: "review.posted", ts: "2" }];
  const reversed = [{ step: "review.posted", ts: "2" }, { step: "run.start", ts: "1" }];
  assert.notEqual(
    decisionKey(foldDecisionFingerprint(forward, EMPTY_DECISION_FINGERPRINT)),
    decisionKey(foldDecisionFingerprint(reversed, EMPTY_DECISION_FINGERPRINT)),
  );
  assert.equal(foldDecisionFingerprint([], EMPTY_DECISION_FINGERPRINT).count, 0, "an empty log folds to nothing");
});
