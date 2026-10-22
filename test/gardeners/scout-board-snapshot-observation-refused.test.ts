import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boardObservationPath, createBoardSnapshotCache } from "#src/lib/board-snapshot-cache.js";
import { fixedClock } from "#src/lib/clock.js";
import type { BoardPrRest } from "#src/lib/open-prs-rest.js";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const MIN = 60_000;

function pr(number: number): BoardPrRest {
  return {
    number, url: `https://github.com/o/r/pull/${number}`, state: "MERGED", headRefName: `run-W1-T${number}-1`,
    headRefOid: `sha-${number}`, body: `Remudero-Task: W1-T${number}`, title: `merged ${number}`,
    updatedAt: "2026-09-05T00:00:00Z",
  } as BoardPrRest;
}

test("W1-T10227: board_snapshot.observation_refused no longer recurs", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-obs-refused-"));
  try {
    const rows = [pr(1)];
    const first = createBoardSnapshotCache(dir, "o", "r", { clock: fixedClock(T0) });
    assert.equal(first.commitClosed(rows), true);
    const second = createBoardSnapshotCache(dir, "o", "r", { clock: fixedClock(T0 + 10 * MIN) });
    assert.equal(second.commitClosed(rows), true);
    const sidecar = boardObservationPath(dir, "o", "r");
    assert.equal(fs.existsSync(sidecar), true, "positive control: the unchanged read wrote a sidecar");
    // The data is replaced by a changed read: the old sidecar can no longer certify it.
    assert.equal(second.commitClosed([pr(1), pr(2)]), true);
    assert.equal(fs.existsSync(sidecar), false, "the stale sidecar was removed with the replaced data");
    const events: Array<{ event: string; reason?: unknown }> = [];
    const restarted = createBoardSnapshotCache(dir, "o", "r", {
      clock: fixedClock(T0 + 20 * MIN), log: (event, extra) => events.push({ event, reason: extra?.reason }),
    });
    assert.equal(restarted.rows!().closed?.size, 2);
    assert.deepEqual(events.filter((e) => e.event === "board_snapshot.observation_refused"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
