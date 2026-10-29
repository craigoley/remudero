import assert from "node:assert/strict";
import test from "node:test";
import {
  freshReadGeneration, freezeReadGeneration, onePassPerGeneration, startReadPlane, TICK_READ_MAX_AGE_MS,
  type ReadGeneration,
} from "#src/lib/read-plane.js";
import { clockFromMillisFn } from "#src/lib/clock.js";

// W1-T9704: at 2026-10-15 17:02:18Z the full sweep refused generation 2 at age 454,974 ms, 4 ms after
// the tick published it. Its read began at 16:54:43Z and took 7.6 min, so it was born past the
// 300,000 ms bound, and the sweep paid the whole read again before its first progress row.

const READ_BEGAN_MS = Date.parse("2026-10-15T16:54:43.478Z");
const READ_MS = 454_974;
type Facts = { openPrs: number[] };

function slowPlane() {
  let clockMs = READ_BEGAN_MS;
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const clock = clockFromMillisFn(() => clockMs);
  const plane = startReadPlane({
    workerUrl: new URL("../src/run-task.ts", import.meta.url), workerInput: {},
    spawn: () => { throw new Error("worker unavailable"); },
    inline: (input: Facts) => { clockMs += READ_MS; return input; },
    clock, log: () => {},
  });
  const bound = { clock, log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); } };
  return { plane, rows, bound, advance: (ms: number) => { clockMs += ms; }, now: () => clockMs };
}

test("W1-T9704: a generation whose read took longer than the bound is served when it is consumed as it is published", async () => {
  const h = slowPlane();
  try {
    const published = await h.plane.read({ openPrs: Array.from({ length: 31 }, (_, i) => 12000 + i) });
    assert.equal(published.publishedAtMs, READ_BEGAN_MS, "the read's start still dates the facts");
    assert.equal(published.settledAtMs, READ_BEGAN_MS + READ_MS, "the instant the read settled is recorded beside it");
    h.advance(4);
    assert.equal(freshReadGeneration(published, { consumer: "full_sweep", ...h.bound }), published);
    assert.deepEqual(h.rows, [], "no refusal row for a generation consumed as it was published");
    let reads = 0;
    const tickRead = onePassPerGeneration(() => published, async (input: Facts) => { reads++; return h.plane.read(input); },
      () => ({ openPrs: [] }), h.bound);
    assert.equal(await tickRead(), published.facts, "the full sweep is served the tick's read, not a second one");
    assert.equal(reads, 0);
  } finally { await h.plane.stop(); }
});

test("W1-T9704: a generation that sat unused past the bound after it was published is still refused", async () => {
  const h = slowPlane();
  try {
    const published = await h.plane.read({ openPrs: [12001] });
    h.advance(TICK_READ_MAX_AGE_MS + 1);
    assert.equal(freshReadGeneration(published, { consumer: "full_sweep", ...h.bound }), undefined);
    assert.deepEqual(h.rows, [{ step: "tick_read.stale_refused", extra: { consumer: "full_sweep", generation: 1,
      age_ms: TICK_READ_MAX_AGE_MS + 1, max_age_ms: TICK_READ_MAX_AGE_MS, read_ms: READ_MS } }],
    "the row ages the generation from its publication and names how long its read took");
    h.advance(-1);
    assert.equal(freshReadGeneration(published, { consumer: "refresh_merged", ...h.bound }), published, "at the bound it is served");
  } finally { await h.plane.stop(); }
});

test("W1-T9704: a generation with no settle time is aged from its read's start, as before", () => {
  const legacy = freezeReadGeneration<ReadGeneration<Facts>>({ generation: 7, source: "worker",
    publishedAtMs: READ_BEGAN_MS, facts: { openPrs: [1] } });
  const rows: string[] = [];
  const clock = clockFromMillisFn(() => READ_BEGAN_MS + TICK_READ_MAX_AGE_MS + 1);
  assert.equal(freshReadGeneration(legacy, { consumer: "board_items", clock, log: (step) => { rows.push(step); } }), undefined);
  assert.deepEqual(rows, ["tick_read.stale_refused"]);
});
