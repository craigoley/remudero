import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { changedFilesCachePath, createChangedFilesCache } from "../src/lib/changed-files-cache.js";
import { buildBatchedGithub, type BatchedPr } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";
import type { Clock } from "../src/lib/clock.js";
import { ghShim } from "./helpers/gh-shim.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

const url = (n: number): string => `https://github.com/o/r/pull/${n}`;
const pr = (n: number, state: string): BatchedPr => ({ number: n, url: url(n), state, headRefName: `b${n}`, body: "" });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const movable = (start = 1_000): Clock & { advance(ms: number): void } => {
  let t = start;
  return { now: () => t, date: () => new Date(t), iso: () => new Date(t).toISOString(), advance: (ms) => void (t += ms) };
};

/** A board gateway whose synchronous `gh` seam FAILS THE TEST if it is ever reached. */
function boardGateway(rows: BatchedPr[], cache: ReturnType<typeof createChangedFilesCache>, syncCalls: string[][]) {
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => rows,
    exec: (args) => {
      syncCalls.push(args);
      return "blocking-read.ts\n";
    },
    changedFilesCache: cache,
  });
  gh.headRefName(url(rows[0].number)); // builds the index the board derivation has always built first
  return gh;
}

test("a merged pr's changed files are served from the durable cache after a restart", async () => {
  const root = makeTempDir("changed-files-cache");
  const fetched: string[] = [];
  const fetch = async (n: string): Promise<string[]> => {
    fetched.push(n);
    await sleep(20);
    return ["src/a.ts", "test/a.test.ts"];
  };
  const syncCalls: string[][] = [];
  const first = createChangedFilesCache(root, "o", "r", { fetch });
  const before = boardGateway([pr(7, "MERGED")], first, syncCalls);
  assert.equal(before.changedFiles?.(url(7)), undefined);
  await first.settle();
  assert.deepEqual(before.changedFiles?.(url(7)), ["src/a.ts", "test/a.test.ts"]);
  assert.deepEqual(fetched, ["7"]);
  assert.ok(existsSync(changedFilesCachePath(root, "o", "r")));

  // THE RESTART: a fresh cache and gateway over the same root, whose fetch must never run.
  const afterFetches: string[] = [];
  const second = createChangedFilesCache(root, "o", "r", {
    fetch: async (n) => {
      afterFetches.push(n);
      return undefined;
    },
  });
  const after = boardGateway([pr(7, "MERGED")], second, syncCalls);
  assert.deepEqual(after.changedFiles?.(url(7)), ["src/a.ts", "test/a.test.ts"]);
  await second.settle();
  assert.deepEqual(afterFetches, [], "a durable hit makes no GitHub call");
  assert.deepEqual(syncCalls, [], "the synchronous gh seam is never reached on the board path");
});

test("an uncached pr answers unreadable at once and is fetched off the event loop", async () => {
  const root = makeTempDir("changed-files-cache");
  let started = 0;
  let active = 0;
  let peak = 0;
  const fetch = async (n: string): Promise<string[]> => {
    started += 1;
    active += 1;
    peak = Math.max(peak, active);
    await sleep(150); // a slow GitHub
    active -= 1;
    return [`src/pr${n}.ts`];
  };
  const syncCalls: string[][] = [];
  const cache = createChangedFilesCache(root, "o", "r", { fetch, concurrency: 2 });
  const rows = [pr(1, "MERGED"), pr(2, "MERGED"), pr(3, "CLOSED"), pr(4, "MERGED"), pr(5, "MERGED")];
  const gh = boardGateway(rows, cache, syncCalls);

  const t0 = performance.now();
  for (let round = 0; round < 3; round++) for (const r of rows) assert.equal(gh.changedFiles?.(r.url), undefined);
  const elapsed = performance.now() - t0;
  assertWallClockBound(elapsed, 50, "15 misses answered without waiting on GitHub");
  assert.equal(started, 0, "no read starts inside the synchronous derivation");
  assert.deepEqual(syncCalls, [], "the synchronous gh seam is never reached");

  // The event loop stays free while the reads are in flight.
  let ticked = false;
  setImmediate(() => (ticked = true));
  await sleep(10);
  assert.ok(ticked);
  assert.ok(started > 0 && started <= 2, `concurrency bounded to 2, started ${started}`);

  await cache.settle();
  assert.equal(started, 5, "one read per PR however often it was asked for");
  assert.equal(peak, 2);
  assert.deepEqual(gh.changedFiles?.(url(3)), ["src/pr3.ts"]);
});

test("an open pr's changed files are never persisted", async () => {
  const root = makeTempDir("changed-files-cache");
  const cache = createChangedFilesCache(root, "o", "r", { fetch: async (n) => [`src/open${n}.ts`] });
  const gh = boardGateway([pr(9, "OPEN"), pr(8, "MERGED")], cache, []);
  gh.changedFiles?.(url(9));
  gh.changedFiles?.(url(8));
  await cache.settle();
  assert.deepEqual(gh.changedFiles?.(url(9)), ["src/open9.ts"], "memoised in memory for this process");
  const onDisk = JSON.parse(readFileSync(changedFilesCachePath(root, "o", "r"), "utf8")) as { entries: Array<{ url: string }> };
  assert.deepEqual(onDisk.entries.map((e) => e.url), [url(8)]);

  const restarted = createChangedFilesCache(root, "o", "r", { fetch: async () => undefined });
  assert.equal(restarted.lookup(url(9), "OPEN"), undefined);
  assert.deepEqual(restarted.lookup(url(8), "MERGED"), ["src/open8.ts"]);
});

test("changed-files cache: a pr read while open is re-read once it merges and only then persisted", async () => {
  const root = makeTempDir("changed-files-cache");
  let version = 0;
  const cache = createChangedFilesCache(root, "o", "r", { fetch: async () => [`v${++version}.ts`] });
  cache.lookup(url(4), "OPEN");
  await cache.settle();
  assert.deepEqual(cache.lookup(url(4), "MERGED"), ["v1.ts"], "the older answer is served meanwhile");
  await cache.settle();
  assert.deepEqual(cache.lookup(url(4), "MERGED"), ["v2.ts"]);
  await cache.settle();
  assert.equal(version, 2, "a durable entry is never re-read");
  const restarted = createChangedFilesCache(root, "o", "r", { fetch: async () => undefined });
  assert.deepEqual(restarted.lookup(url(4), undefined), ["v2.ts"]);
});

test("changed-files cache: a failed read is remembered briefly and retried after it expires", async () => {
  const root = makeTempDir("changed-files-cache");
  const clock = movable();
  const logged: string[] = [];
  let calls = 0;
  const cache = createChangedFilesCache(root, "o", "r", {
    clock,
    failureTtlMs: 60_000,
    log: (event) => logged.push(event),
    fetch: async () => {
      calls += 1;
      if (calls === 1) return undefined;
      if (calls === 2) throw new Error("secondary rate limit");
      return ["x.ts"];
    },
  });
  cache.lookup(url(5), "MERGED");
  await cache.settle();
  cache.lookup(url(5), "MERGED");
  await cache.settle();
  assert.equal(calls, 1, "not retried inside the failure window");
  clock.advance(60_000);
  cache.lookup(url(5), "MERGED");
  await cache.settle();
  assert.equal(calls, 2);
  assert.ok(logged.includes("changed_files_cache.fetch_failed"));
  clock.advance(60_000);
  cache.lookup(url(5), "MERGED");
  await cache.settle();
  assert.deepEqual(cache.lookup(url(5), "MERGED"), ["x.ts"]);
});

test("changed-files cache: the durable file keeps the newest entries and evicts the oldest first", async () => {
  const root = makeTempDir("changed-files-cache");
  const clock = movable();
  const cache = createChangedFilesCache(root, "o", "r", { clock, maxEntries: 2, fetch: async (n) => [`f${n}.ts`] });
  for (const n of [1, 2, 3]) {
    cache.lookup(url(n), "MERGED");
    await cache.settle();
    clock.advance(1_000);
  }
  const restarted = createChangedFilesCache(root, "o", "r", { fetch: async () => undefined });
  assert.equal(restarted.lookup(url(1), "MERGED"), undefined);
  assert.deepEqual(restarted.lookup(url(2), "MERGED"), ["f2.ts"]);
  assert.deepEqual(restarted.lookup(url(3), "MERGED"), ["f3.ts"]);
  await restarted.settle();
});

test("changed-files cache: an unusable durable file is refused and the gateway boots empty", async () => {
  const root = makeTempDir("changed-files-cache");
  const path = changedFilesCachePath(root, "o", "r");
  mkdirSync(join(path, ".."), { recursive: true });
  const cases: Array<[string, string, { maxBytes?: number }]> = [
    ["invalid_json", "{not json", {}],
    ["invalid_schema", JSON.stringify({ schema: 99, repository: "o/r", entries: [] }), {}],
    ["invalid_schema", JSON.stringify({ schema: 1, repository: "x/y", entries: [] }), {}],
    ["oversized", JSON.stringify({ schema: 1, repository: "o/r", entries: [{ url: url(1), files: ["a"], at: 1 }] }), { maxBytes: 4 }],
  ];
  for (const [reason, body, bounds] of cases) {
    writeFileSync(path, body);
    const events: Array<Record<string, unknown> | undefined> = [];
    const cache = createChangedFilesCache(root, "o", "r", { ...bounds, fetch: async () => undefined, log: (_e, x) => events.push(x) });
    assert.equal(events[0]?.reason, reason);
    assert.equal(cache.lookup(url(1), "MERGED"), undefined);
    await cache.settle();
  }
  writeFileSync(path, JSON.stringify({ schema: 1, repository: "o/r", entries: [{ url: url(1), files: [], at: 1 }, { url: url(2), files: ["b"], at: 2 }] }));
  const cache = createChangedFilesCache(root, "o", "r", { fetch: async () => undefined });
  assert.deepEqual(cache.lookup(url(2), "MERGED"), ["b"]);
  assert.equal(cache.lookup("https://github.com/o/r/issues/2", "MERGED"), undefined);
  await cache.settle();
  await cache.settle();
});

test("changed-files cache: a failed durable write is logged and the answer is still served", async () => {
  const root = makeTempDir("changed-files-cache");
  const path = changedFilesCachePath(root, "o", "r");
  mkdirSync(join(path, "occupied"), { recursive: true }); // the target is a non-empty DIRECTORY: rename refuses
  const events: string[] = [];
  const cache = createChangedFilesCache(root, "o", "r", { fetch: async () => ["a.ts"], log: (e) => events.push(e) });
  cache.lookup(url(1), "MERGED");
  await cache.settle();
  assert.ok(events.includes("changed_files_cache.write_failed"));
  assert.deepEqual(cache.lookup(url(1), "MERGED"), ["a.ts"]);
});

test("changed-files cache: the default read really shells out to gh asynchronously", async () => {
  const root = makeTempDir("changed-files-cache");
  const shim = ghShim([
    { when: "pulls/11/files", stdout: "src/one.ts\nsrc/two.ts" },
    { when: "pulls/12/files", stdout: "" },
  ]);
  const cache = createChangedFilesCache(root, "o", "r", { ghBin: join(shim.dir, "gh") });
  cache.lookup(url(11), "MERGED");
  cache.lookup(url(12), "MERGED");
  await cache.settle();
  assert.deepEqual(cache.lookup(url(11), "MERGED"), ["src/one.ts", "src/two.ts"]);
  assert.equal(cache.lookup(url(12), "MERGED"), undefined, "an empty read is unreadable, never 'no files'");
  assert.ok(shim.calls().includes("api --paginate repos/o/r/pulls/11/files --jq .[].filename"));
});
