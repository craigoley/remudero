import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { GhReadBroker, type GhUpstreamExec } from "#src/lib/gh-read-broker.js";
import { GH_BROKER_INVALIDATIONS } from "#src/lib/gh-read-broker-client.js";
import { parseGhApiArgv } from "#src/lib/github-transport.js";

function maps(broker: GhReadBroker) {
  return broker as unknown as {
    memo: Map<string, unknown>;
    entries: Map<string, unknown>;
    inflight: Map<string, unknown>;
    lastServed: Map<string, unknown>;
  };
}

function fixture(t: TestContext, body = "é".repeat(128), maxAge = 3600) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-broker-memory-"));
  let now = Date.now();
  let free = 1e12;
  let calls = 0;
  let conditional = false;
  const exec: GhUpstreamExec = async (args) => {
    if (args[0] === "api" && parseGhApiArgv(args).endpoint === "user") return { stdout: "reader\n", stderr: "", exitCode: 0 };
    calls += 1;
    conditional = args.includes('If-None-Match: "v1"');
    return {
      stdout: `HTTP/2.0 ${conditional ? "304 Not Modified" : "200 OK"}\r\nCache-Control: max-age=${maxAge}\r\nETag: "v1"\r\n\r\n${conditional ? "" : body}`,
      stderr: "", exitCode: 0,
    };
  };
  const broker = new GhReadBroker(dir, exec, clockFromMillisFn(() => now), async (ms) => { now += ms; }, () => free, { sharedPaceRoot: null });
  broker.pacer("core").gapMs = 0;
  t.after(() => {
    now += 1e12;
    broker.status();
    rmSync(dir, { recursive: true, force: true });
  });
  const read = (id: number) => broker.read({ op: "read", args: ["api", `repos/o/r/pulls/${id}`], class: "agent", caller: `caller-${id}` });
  return { dir, broker, read, calls: () => calls, conditional: () => conditional,
    advance: (ms: number) => { now += ms; }, budget: (bytes: number) => { free = bytes / broker.cacheShareOfFree; } };
}

test("W1-T12073 criterion 1: distinct reads stay within the memory budget and expired bodies leave memory", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 200; i += 1) await f.read(i);
  const m = maps(f.broker);
  t.diagnostic(`after 200 reads: memo=${m.memo.size}, entries=${m.entries.size}, lastServed=${m.lastServed.size}, inflight=${m.inflight.size}`);
  assert.equal(m.memo.size, 200);
  assert.equal(m.entries.size, 200);
  assert.equal(m.lastServed.size, 1, "one caller cursor per limiter/class, not per caller");
  assert.equal(m.inflight.size, 0, "completed requests leave no in-flight record");
  t.diagnostic(`serialized payload after 200 reads: ${f.broker.status().memory_bytes} bytes`);
  f.budget(4000);
  const bounded = f.broker.status();
  assert.equal(bounded.memory_budget_bytes, 4000);
  assert.ok(Number(bounded.memory_bytes) > 0);
  assert.ok(Number(bounded.memory_bytes) <= 4000);
  assert.equal(bounded.memory_entries, m.memo.size);
  assert.ok(m.memo.size < 200);
  assert.equal(m.entries.size, 200, "memory pressure does not change the disk index");
  for (let i = 200; i < 400; i += 1) {
    await f.read(i);
    const status = f.broker.status();
    assert.ok(Number(status.memory_bytes) <= 4000);
    assert.ok(Number(status.memory_entries) <= Math.floor(4000 / 512), "every retained entry holds both body and stdout");
  }
  f.advance(3_600_000);
  const expired = f.broker.status();
  assert.equal(expired.memory_entries, 0);
  assert.equal(expired.memory_bytes, 0);
  assert.equal(m.memo.size, 0);
  assert.ok(readdirSync(join(f.dir, "cache")).length > 0, "expiry leaves disk revalidation intact");
});

test("W1-T12073 criterion 1: an oversized body and a zero budget never retain a memo", async (t) => {
  const f = fixture(t, "large".repeat(1000));
  f.budget(100);
  assert.equal((await f.read(1)).exitCode, 0);
  assert.equal(maps(f.broker).memo.size, 0);
  assert.equal(f.broker.status().memory_bytes, 0);
  assert.equal((await f.read(1)).outcome, "hit-fresh", "an oversized fresh disk entry still works");
  assert.equal(maps(f.broker).memo.size, 0, "disk reads obey the same memory bound");
  f.budget(0);
  await f.read(2);
  assert.equal(f.broker.status().memory_entries, 0);
  assert.equal(f.broker.status().memory_budget_bytes, 0);
});

test("W1-T12073 criterion 1: memory eviction follows the last served order", async (t) => {
  const f = fixture(t);
  await f.read(1);
  const first = [...maps(f.broker).memo.keys()][0];
  const oneBytes = Number(f.broker.status().memory_bytes);
  await f.read(2);
  const second = [...maps(f.broker).memo.keys()][1];
  await f.read(1);
  f.budget(oneBytes);
  f.broker.status();
  assert.ok(maps(f.broker).memo.has(first));
  assert.ok(!maps(f.broker).memo.has(second), "the untouched entry leaves first");
  assert.equal(f.broker.status().memory_entries, 1);
  assert.equal(f.broker.status().cache_entries, 2, "only memory is evicted");
});

test("W1-T12073 criterion 1: expiry runs while idle and stale disk entries can revalidate", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, "body", 1);
  await f.read(1);
  assert.equal(maps(f.broker).memo.size, 1);
  f.advance(1000);
  t.mock.timers.tick(1000);
  assert.equal(maps(f.broker).memo.size, 0, "no read or status call is needed to expire memory");
  const refreshed = await f.read(1);
  assert.equal(refreshed.outcome, "revalidated-304");
  assert.equal(refreshed.stdout, "body");
  assert.equal(f.conditional(), true);
  assert.equal(f.broker.status().memory_entries, 1);
});

test("W1-T12073 criterion 2: a fresh memo serves the body without disk or upstream access", async (t) => {
  const f = fixture(t);
  const first = await f.read(1);
  assert.equal(f.broker.status().memory_entries, 1);
  rmSync(join(f.dir, "cache"), { recursive: true });
  f.advance(1000);
  const fresh = await f.read(1);
  assert.equal(fresh.outcome, "hit-fresh");
  assert.equal(fresh.stdout, first.stdout);
  assert.equal(f.calls(), 1);
  assert.equal(f.broker.status().memory_entries, 1);
});

test("W1-T12073 criterion 3: status reports retained payload bytes, entries, budget and each map count", async (t) => {
  const f = fixture(t);
  const empty = f.broker.status();
  assert.equal(empty.memory_entries, 0);
  assert.equal(empty.memory_bytes, 0);
  assert.equal(empty.memory_budget_bytes, 1e10);
  await f.read(1);
  const status = f.broker.status();
  assert.equal(status.memory_entries, 1);
  const diskBytes = readdirSync(join(f.dir, "cache")).reduce((sum, name) => sum + statSync(join(f.dir, "cache", name)).size, 0);
  assert.equal(status.memory_bytes, diskBytes, "count the complete serialized entry in bytes");
  assert.ok(Number(status.memory_bytes) > 256, "account for the whole entry, including multibyte content");
  assert.ok(Number(status.memory_bytes) <= Number(status.memory_budget_bytes));
  assert.deepEqual(status.memory_maps, { memo: 1, entries: 1, last_served: 1, inflight: 0 });
  assert.equal(status.cache_entries, 1);
  assert.ok(Number(status.cache_bytes) > 0);
});

test("W1-T12073 criterion 1: uncacheable freshness never leaves a body in memory", async (t) => {
  const f = fixture(t, "stale", 0);
  await f.read(1);
  assert.equal(maps(f.broker).memo.size, 0);
  assert.equal(f.broker.status().memory_bytes, 0);
  assert.equal((await f.read(1)).outcome, "revalidated-304");
  assert.equal(f.broker.status().memory_entries, 0);
});

test("W1-T12073 criterion 1: immutable logs survive age expiry but obey a shrinking budget", async (t) => {
  const f = fixture(t);
  const request = { op: "read" as const, args: ["run", "view", "123", "--log"], class: "agent" as const, caller: "test" };
  const first = await f.broker.read(request);
  f.advance(1e12);
  assert.equal((await f.broker.read(request)).stdout, first.stdout);
  assert.equal(f.calls(), 1);
  assert.equal(f.broker.status().memory_entries, 1);
  f.budget(0);
  assert.equal(f.broker.status().memory_entries, 0);
  assert.equal(f.broker.status().memory_bytes, 0);
});

test("W1-T12073 criterion 1: invalidation releases the memo's accounted bytes", async (t) => {
  const f = fixture(t);
  await f.read(1);
  writeFileSync(join(f.dir, GH_BROKER_INVALIDATIONS), "o/r 1\n");
  f.broker.applyInvalidations();
  assert.equal(f.broker.status().memory_bytes, 0);
  assert.equal(f.broker.status().memory_entries, 0);
  assert.equal(f.broker.status().cache_entries, 0);
  await f.read(1);
  assert.equal(f.broker.status().memory_entries, 1);
  assert.ok(Number(f.broker.status().memory_bytes) > 0);
});
