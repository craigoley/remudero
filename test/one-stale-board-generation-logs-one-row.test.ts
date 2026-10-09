import test from "node:test";
import assert from "node:assert/strict";
import { fixedClock } from "../src/lib/clock.js";
import {
  freezeReadGeneration, freshReadGeneration, TICK_READ_MAX_AGE_MS, type ReadGeneration,
} from "../src/lib/read-plane.js";

test("test/one-stale-board-generation-logs-one-row.test.ts", () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const bound = { consumer: "board_items", clock: fixedClock(TICK_READ_MAX_AGE_MS + 1),
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); } };
  const stale = freezeReadGeneration<ReadGeneration<string[]>>({ generation: 1, source: "worker",
    publishedAtMs: 0, facts: ["old board"] });
  const rowFor = (consumer: string, generation: number) => ({ step: "tick_read.stale_refused",
    extra: { consumer, generation, age_ms: TICK_READ_MAX_AGE_MS + 1, max_age_ms: TICK_READ_MAX_AGE_MS } });

  assert.equal(freshReadGeneration(stale, bound), undefined, "prefetch refuses stale items");
  assert.equal(freshReadGeneration(stale, { ...bound }), undefined, "check also refuses stale items");
  assert.deepEqual(rows, [rowFor("board_items", 1)], "the same pair writes one refusal row");

  assert.equal(freshReadGeneration(stale, { ...bound, consumer: "refresh_merged" }), undefined);
  const newer = freezeReadGeneration({ ...stale, generation: 2 });
  assert.equal(freshReadGeneration(newer, bound), undefined);
  assert.equal(freshReadGeneration(newer, bound), undefined);
  assert.equal(freshReadGeneration(stale, { ...bound, consumer: "refresh_merged" }), undefined);
  assert.deepEqual(rows, [rowFor("board_items", 1), rowFor("refresh_merged", 1), rowFor("board_items", 2)],
    "each consumer retains its own latest refused generation");

  const fresh = freezeReadGeneration({ ...newer, publishedAtMs: 1, facts: ["current board"] });
  assert.equal(freshReadGeneration(fresh, bound), fresh, "a generation exactly at the bound is served");
  assert.equal(freshReadGeneration(fresh, bound), fresh, "fresh reads remain repeatable");
  assert.equal(freshReadGeneration(undefined, bound), undefined);
  assert.equal(rows.length, 3, "fresh and absent generations write no refusal rows");

  assert.equal(freshReadGeneration(stale, bound), undefined);
  assert.deepEqual(rows.at(-1), rowFor("board_items", 1));
  assert.equal(rows.length, 4, "only the latest generation is remembered, rather than all history");
});

test("independent read-plane ledgers can log the same consumer and generation", () => {
  const stale: ReadGeneration<null> = { generation: 1, source: "inline", publishedAtMs: 0, facts: null };
  const clock = fixedClock(2);
  assert.equal(freshReadGeneration(stale, { consumer: "board_items", clock, maxAgeMs: 1 }), undefined);
  for (let plane = 0; plane < 2; plane++) {
    const rows: string[] = [];
    const bound = { consumer: "board_items", clock, maxAgeMs: 1,
      log: (step: string) => { rows.push(step); } };
    assert.equal(freshReadGeneration(stale, bound), undefined);
    assert.equal(freshReadGeneration(stale, bound), undefined);
    assert.deepEqual(rows, ["tick_read.stale_refused"]);
  }
});
