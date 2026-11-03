import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as census from "#src/lib/daemon-memory-census.js";
import type { DaemonMemoryGrowthRow } from "#src/lib/daemon-memory-census.js";

const {
  compareDaemonMemoryGenerations, DAEMON_MEMORY_STEP, rankHeapCensus, readCgroupMemoryEvents,
  renderHeapCensus, sampleDaemonMemoryCensus, startDaemonMemoryCensus,
} = census;

function generation(sha: string, live: number[], holder?: number[]): DaemonMemoryGrowthRow[] {
  return live.map((bytes, i) => ({
    step: DAEMON_MEMORY_STEP, boot_head_sha: sha, live_after_gc_bytes: bytes,
    holders: holder ? [{ name: "memo:board", bytes: holder[i]! }] : [],
  }));
}

const history = () => [
  ...generation("old-a", [100, 110, 120], [20, 30, 40]),
  ...generation("old-b", [90, 100, 110], [10, 20, 30]),
  ...generation("new-c", [490, 500, 510], [390, 400, 410]),
  ...generation("new-d", [990, 1000, 1010], [890, 900, 910]),
];

test("test/memory/core-live-heap-growth-is-named-by-the-boot-that-brought-it.test.ts", async (t) => {
  await t.test("the first rise names the holder and both boot shas using earlier generation medians", () => {
    const result = compareDaemonMemoryGenerations(history());
    assert.deepEqual(result.rise, {
      holder: "memo:board", before_sha: "old-b", after_sha: "new-c",
      before_bytes: 20, after_bytes: 400, upper_quartile_bytes: 27.5, spread_bytes: 5,
    });
    assert.equal(result.generations[0]!.status, "baseline");
    assert.equal(result.generations[2]!.samples, 3);
  });

  await t.test("a small rise outside zero spread counts, and a large rise inside historical spread does not", () => {
    assert.equal(compareDaemonMemoryGenerations([
      ...generation("a", [1, 1]), ...generation("b", [2, 2]),
    ]).rise?.after_bytes, 2);
    assert.equal(compareDaemonMemoryGenerations([
      ...generation("a", [0, 0]), ...generation("b", [1000, 1000]),
      ...generation("c", [500, 500]),
    ]).generations[2]!.metrics.find((m) => m.holder === "unattributed_live_bytes")!.status, "measured");
    assert.equal(compareDaemonMemoryGenerations([
      ...generation("a", [90, 100, 110]), ...generation("b", [90, 100, 110]),
    ]).rise, undefined);
    // b is the first rise; c is below its earlier upper quartile + IQR despite a 500-byte rise over a.
    const broad = compareDaemonMemoryGenerations([
      ...generation("a", [0, 0]), ...generation("b", [1000, 1000]), ...generation("c", [500, 500]),
    ]);
    const c = broad.generations[2]!.metrics.find((m) => m.holder === "unattributed_live_bytes")!;
    assert.equal(c.median_bytes, 500);
    assert.equal(c.upper_quartile_bytes, 750);
    assert.equal(c.spread_bytes, 500);
  });

  await t.test("sparse generations stay unmeasured and cannot become a baseline for the next rise", () => {
    const result = compareDaemonMemoryGenerations([
      ...generation("a", [100, 100, 100, 100]), ...generation("sparse", [10000]),
      ...generation("c", [200, 200, 200, 200]),
    ]);
    assert.equal(result.generations[1]!.status, "unmeasured");
    assert.equal(result.rise?.before_sha, "a");
    assert.equal(result.rise?.after_sha, "c");
    assert.equal(result.rise?.holder, "unattributed_live_bytes");
  });

  await t.test("samples are counted against the earlier median count rather than a fixed minimum", () => {
    assert.equal(compareDaemonMemoryGenerations([
      ...generation("a", [100]), ...generation("b", [200]),
    ]).rise?.after_sha, "b");
    const result = compareDaemonMemoryGenerations([
      ...generation("a", [100, 100, 100, 100]), ...generation("b", [100, 100]),
      ...generation("c", [200, 200, 200]),
    ]);
    assert.equal(result.generations[1]!.status, "unmeasured");
    assert.equal(result.generations[2]!.status, "measured");
    assert.equal(result.rise?.after_sha, "c");
  });

  await t.test("boot time orders interleaved input and only census rows with a boot sha participate", () => {
    const rows = history().map((row, i) => ({ ...row, ts: new Date(i * 1000).toISOString() }));
    const shuffled = [rows[9]!, rows[6]!, rows[3]!, rows[0]!, ...rows.filter((_, i) => i % 3 !== 0)];
    const result = compareDaemonMemoryGenerations([
      { step: "daemon.alive", boot_head_sha: "noise", live_after_gc_bytes: 90000 },
      { step: DAEMON_MEMORY_STEP, live_after_gc_bytes: 90000 }, ...shuffled,
    ]);
    assert.deepEqual(result.generations.map((g) => g.boot_head_sha), ["old-a", "old-b", "new-c", "new-d"]);
    assert.equal(result.rise?.after_sha, "new-c");
  });

  await t.test("missing, failed, truncated and nonfinite readings are unmeasured rather than zero", () => {
    const rows = [
      ...generation("a", [100, 100, 100], [20, 20, 20]),
      ...generation("b", [100, 100, 100], [200, 200, 200]),
    ];
    rows[3]!.holders = [{ name: "memo:board", bytes: 200, error: "unreadable" }];
    rows[4]!.holders = [{ name: "memo:board", bytes: 200, truncated: true }];
    rows[5]!.holders = [];
    assert.equal(compareDaemonMemoryGenerations(rows).rise, undefined);
    assert.equal(compareDaemonMemoryGenerations(rows).generations[1]!.metrics[0]!.status, "unmeasured");
    const failed = generation("b", [100, 100], [200, 200]);
    for (const row of failed) row.holders = [{ name: "memo:board", bytes: 200, error: "" }];
    assert.equal(compareDaemonMemoryGenerations([
      ...generation("a", [100, 100], [20, 20]), ...failed,
    ]).rise, undefined);
    const missing = compareDaemonMemoryGenerations([
      ...generation("a", [100, 100]), ...generation("b", [NaN, Infinity]),
    ]);
    assert.equal(missing.rise, undefined);
    assert.equal(missing.generations[1]!.status, "unmeasured");
    assert.deepEqual(compareDaemonMemoryGenerations([]), { generations: [] });
  });

  await t.test("holders can identify a rise while total live heap stays flat; absent holders are not zero", () => {
    const result = compareDaemonMemoryGenerations([
      ...generation("a", [100, 100], [10, 10]), ...generation("b", [100, 100], [30, 30]),
    ]);
    assert.equal(result.rise?.holder, "memo:board");
    assert.equal(compareDaemonMemoryGenerations([
      ...generation("a", [100, 100]), ...generation("b", [100, 100], [30, 30]),
    ]).rise, undefined);
  });

  await t.test("each generation has equal baseline weight regardless of its sample count", () => {
    const result = compareDaemonMemoryGenerations([
      ...generation("a", [100]), ...generation("b", Array(8).fill(90)),
      ...generation("c", Array(5).fill(101)),
    ]);
    assert.equal(result.rise, undefined);
    const metric = result.generations[2]!.metrics[0]!;
    assert.equal(metric.median_bytes, 101);
    assert.equal(metric.upper_quartile_bytes, 97.5);
    assert.equal(metric.spread_bytes, 5);
  });
});

test("W1-T11134 criterion 2: a named rise enters census proposals and each row carries cgroup oom counts", async () => {
  const ranking = rankHeapCensus([], {
    liveSetBytes: 500, censusSha: "offline", censusDate: "fixture", memoryRows: history(),
  });
  const proposal = ranking.growth!.proposed_task!;
  assert.equal(proposal.holder, "memo:board");
  assert.match(proposal.subject, /memo:board.*old-b.*new-c/);
  assert.match(proposal.evidence.join("\n"), /400.*27.5.*5/);
  assert.match(proposal.acceptance, /boot_head_sha/);
  assert.match(renderHeapCensus(ranking), /memo:board.*old-b.*new-c/);
  const known = rankHeapCensus([{
    name: "board memo", holder: "memo:board", entries: 1, retained_bytes: 1, grown_bytes: 1,
    files: ["src/lib/board.ts"],
  }], { liveSetBytes: 500, censusSha: "offline", censusDate: "fixture", memoryRows: history() });
  assert.equal(known.holders[0]!.proposed_task, known.growth!.proposed_task);
  assert.deepEqual(known.holders[0]!.proposed_task!.files, ["src/lib/board.ts"]);
  const sparse = rankHeapCensus([], {
    liveSetBytes: 100, censusSha: "offline", censusDate: "fixture",
    memoryRows: [...generation("a", [100, 100]), ...generation("sparse", [10000])],
  });
  assert.match(renderHeapCensus(sparse), /sparse.*unmeasured/);
  const unattributed = rankHeapCensus([], {
    liveSetBytes: 101, censusSha: "offline", censusDate: "fixture",
    memoryRows: [...generation("a", [100]), ...generation("b", [101])],
  }).growth!.proposed_task!;
  assert.equal(unattributed.holder, "unattributed_live_bytes");
  assert.match(unattributed.subject, /a.*b/);
  assert.match(unattributed.evidence.join("\n"), /live_after_gc_bytes median/);
  assert.equal(rankHeapCensus([], {
    liveSetBytes: 100, censusSha: "offline", censusDate: "fixture", memoryRows: generation("a", [100]),
  }).growth!.proposed_task, undefined);

  let tick: (() => void) | undefined;
  let written: { step: string; row: Record<string, unknown> } | undefined;
  const stop = startDaemonMemoryCensus({
    holders: () => [], bootHeadSha: "new-c", io: { cgroupMemoryEvents: () => "oom 12\noom_kill 7\n" },
    log: (step, row) => { written = { step, row }; },
    setTimer: (fn) => { tick = fn; return {}; }, clearTimer: () => {},
  });
  try {
    tick!();
    for (let i = 0; i < 20 && !written; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(written!.step, DAEMON_MEMORY_STEP);
    assert.deepEqual(written!.row.cgroup_memory_events, { oom: 12, oom_kill: 7 });
  } finally { stop(); }
});

test("cgroup events preserve measured zero and leave missing or unreadable counters absent", async () => {
  assert.deepEqual(readCgroupMemoryEvents(() => "low 9\noom 0\noom_kill 0\n"), { oom: 0, oom_kill: 0 });
  assert.deepEqual(readCgroupMemoryEvents(() => "oom 4\n"), { oom: 4 });
  assert.deepEqual(readCgroupMemoryEvents(() => "oom -1\noom_kill nope\n"), {});
  assert.deepEqual(readCgroupMemoryEvents(() => "oom 9007199254740992\n"), {});
  assert.deepEqual(readCgroupMemoryEvents(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }), {
    error: "unreadable:EACCES",
  });
  const row = await sampleDaemonMemoryCensus([], {}, { cgroupMemoryEvents: () => { throw new TypeError("failed"); } });
  assert.deepEqual(row.cgroup_memory_events, { error: "unreadable:TypeError" });
  assert.equal("oom_kill" in (row.cgroup_memory_events as object), false);
});

test("the sampler's default reads this container's real cgroup events", async () => {
  const expected = readCgroupMemoryEvents(() => readFileSync("/sys/fs/cgroup/memory.events", "utf8"));
  const row = await sampleDaemonMemoryCensus([]);
  const actual = row.cgroup_memory_events as Record<string, number | string>;
  if (expected.error) assert.equal(actual.error, expected.error);
  else for (const counter of ["oom", "oom_kill"]) {
    if (typeof expected[counter] === "number") assert.ok((actual[counter] as number) >= expected[counter]);
    else assert.equal(actual[counter], undefined);
  }
});
