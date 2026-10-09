// W1-T7093: missing or reset host-memory storage is not evidence that reservations are gone.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import {
  openMemoryReservation,
  readMemoryLedger,
  sweepMemoryReservations,
  type HostMemoryLedgerOptions,
} from "../src/lib/host-memory-ledger.js";
import { activeWorkerCount, withWorkerOccupancy } from "../src/lib/worker.js";
import { acquireTestSlot } from "../src/lib/test-slot.js";

function world() {
  const dir = `/missing-ledger/${randomUUID()}`;
  const files = new Map<string, string>();
  const logs: Array<Record<string, unknown>> = [];
  const deps: HostMemoryLedgerOptions = {
    location: () => ({ dir, scope: "host" }),
    instance: () => ({ name: "core", hostUnique: true }),
    generation: () => ({ containerId: "container-1", initStart: "proc:1" }),
    ownerPid: 100,
    probe: (pid) => pid === 100 ? { state: "alive", start: "proc:10" } : { state: "gone" },
    listProcesses: () => ({ rows: [], complete: true }),
    write: (path, content) => void files.set(path, content),
    read: (path) => {
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return value;
    },
    list: (path) => [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => key.slice(path.length + 1)),
    remove: (path) => void files.delete(path),
    createSentinel: (path, content) => {
      if (files.has(path)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" });
      files.set(path, content);
    },
    log: (event) => void logs.push(event),
  };
  return { dir, files, logs, deps };
}

function paths(w: ReturnType<typeof world>) {
  return [...w.files.keys()];
}

test("a missing directory or sentinel is explicit, and a replacement sentinel is reset", () => {
  const w = world();
  const handle = openMemoryReservation({ workerClass: "implement" }, w.deps);
  const entryPath = join(w.dir, `${handle.id}.json`);
  assert.equal(readMemoryLedger(w.deps)?.state, "missing", "the first read retains the missing-sentinel fact until an owner sweep reconciles it");

  w.files.clear(); // The shared scratch directory vanished while this owner still holds the reservation.
  const missing = readMemoryLedger(w.deps);
  assert.equal(missing?.state, "missing");
  assert.equal(missing?.entries.some((entry) => entry.id === handle.id), true, "the process-local owner copy remains visible");

  const recovered = sweepMemoryReservations(w.deps);
  assert.equal(recovered?.reading.state, "reset");
  assert.equal(recovered?.released.length, 0);
  assert.equal(w.files.has(entryPath), true, "the vanished owner's entry is rewritten, not released");
  assert.equal(readMemoryLedger(w.deps)?.entries.some((entry) => entry.id === handle.id), true);

  const sentinel = join(w.dir, ".ledger-id");
  w.files.set(sentinel, `${randomUUID()}\n`);
  assert.equal(readMemoryLedger(w.deps)?.state, "reset", "a changed sentinel is never presented as a healthy empty ledger");
  const reset = sweepMemoryReservations(w.deps);
  assert.equal(reset?.reading.state, "reset");
  assert.equal(reset?.released.length, 0);
  assert.equal(w.files.has(entryPath), true);
  assert.equal(sweepMemoryReservations(w.deps)?.reading.state, "present");
});

test("a vanished owner entry is diagnosed and rewritten without release", () => {
  const w = world();
  const handle = openMemoryReservation({ workerClass: "review" }, w.deps);
  const path = join(w.dir, `${handle.id}.json`);
  w.files.delete(path);

  const result = sweepMemoryReservations(w.deps);
  assert.deepEqual(result?.released, []);
  assert.equal(result?.reading.entries.some((entry) => entry.id === handle.id), true);
  assert.equal(w.files.has(path), true);
  assert.ok(w.logs.some((event) => event.op === "own-entry-missing"));
});

test("test-slot acquire, release and stale reclaim never removes host-memory entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-memory-slot-"));
  const host = hostname();
  const clock = fixedClock(Date.parse("2026-10-09T00:00:00Z"));
  const slotOptions = {
    dir,
    slots: 1,
    waitBoundMs: 0,
    pollMs: 0,
    clock,
    hostname: () => host,
    bootId: () => "boot-test",
    isPidAlive: () => false,
    pid: 12345,
    load: () => ({ cores: 8, load1: 0 }),
    sleep: () => { throw new Error("unexpected wait"); },
    log: () => undefined,
  };
  try {
    const ledger: HostMemoryLedgerOptions = {
      location: () => ({ dir: join(dir, "host-memory"), scope: "host" }),
      root: join(dir, "Remudero"),
      log: () => undefined,
    };
    const first = acquireTestSlot("memory-preservation", slotOptions);
    assert.equal(first.outcome, "acquired");
    const reservation = openMemoryReservation({ workerClass: "fix" }, ledger);
    const reservationPath = join(dir, "host-memory", `${reservation.id}.json`);
    assert.equal(existsSync(reservationPath), true);
    first.release();
    assert.equal(existsSync(reservationPath), true, "releasing a slot only removes slot-N.json");

    writeFileSync(join(dir, "slot-1.json"), JSON.stringify({
      pid: 54321,
      host,
      bootId: "boot-test",
      startedAt: clock.iso(),
      heartbeatAt: clock.iso(),
      label: "dead-holder",
      ownerNonce: "stale-nonce",
      processStart: "proc:dead",
      concurrency: 1,
    }));
    const reclaimed = acquireTestSlot("memory-preservation-reclaim", slotOptions);
    assert.equal(reclaimed.outcome, "acquired", "the dead test-slot holder is reclaimed");
    assert.equal(existsSync(reservationPath), true);
    assert.equal(JSON.parse(readFileSync(reservationPath, "utf8")).id, reservation.id);
    reclaimed.release();
    assert.equal(existsSync(reservationPath), true, "slot cleanup leaves the sibling host-memory directory alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unwritable or full ledger store does not change worker-start behavior", async () => {
  const w = world();
  const enospc = Object.assign(new Error("ENOSPC: host-memory store full"), { code: "ENOSPC" });
  const broken = {
    ...w.deps,
    createSentinel: () => { throw enospc; },
    write: () => { throw enospc; },
  };
  const before = activeWorkerCount();
  const result = await withWorkerOccupancy(async () => {
    assert.equal(activeWorkerCount(), before + 1);
    return "worker-start-unaffected";
  }, { workerClass: "fix", ledger: broken });
  assert.equal(result, "worker-start-unaffected");
  assert.equal(activeWorkerCount(), before);
  assert.ok(w.logs.some((event) => event.op === "sentinel"));
  assert.ok(w.logs.some((event) => event.op === "open-write"));
});
