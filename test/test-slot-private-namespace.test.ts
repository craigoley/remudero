import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireTestSlot, TEST_SLOT_LEASE_MS, type TestSlotLease, type TestSlotOptions } from "#src/lib/test-slot.js";
import { observeSlotCapacity } from "#src/lib/test-slot-capacity.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-private-namespace-")), path = join(dir, "slot-1.json");
  const now = Date.now();
  const options: TestSlotOptions = { dir, slots: 1, ownershipProtocol: "private-capacity-v1", waitBoundMs: 0,
    platform: "linux", hostname: () => "owner-host", bootId: () => "same-kernel-boot", pidNamespace: () => "pid:[owner]",
    memoryHeadroom: () => undefined, load: () => ({ cores: 4, load1: 0 }), log: () => {} };
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  const age = () => writeFileSync(path, JSON.stringify({ ...read(), heartbeatAt: new Date(now - TEST_SLOT_LEASE_MS - 60_000).toISOString() }));
  return { dir, path, options, read, age, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const refused = (lease: TestSlotLease) => { assert.equal(lease.outcome, "wait_bound_exceeded"); assert.equal(lease.executionAllowed, false); };

for (const differentHost of [false, true]) {
  test(`private live owner in another PID namespace is never reclaimed by an expired heartbeat (${differentHost ? "different" : "same"} hostname)`, () => {
    const fx = fixture(); let owner: TestSlotLease | undefined, peer: TestSlotLease | undefined;
    try {
      owner = acquireTestSlot("live owner", fx.options); assert.equal(owner.outcome, "acquired");
      process.kill(process.pid, 0); // Positive real owner-liveness control; no signal is delivered.
      fx.age(); const before = lstatSync(fx.path), original = fx.read(); let pidProbes = 0;
      peer = acquireTestSlot("foreign namespace", { ...fx.options, hostname: () => differentHost ? "peer-host" : "owner-host",
        pidNamespace: () => "pid:[peer]", isPidAlive: () => { pidProbes++; return false; } });
      refused(peer); assert.equal(pidProbes, 0, "foreign namespace cannot use a local PID probe");
      assert.equal(lstatSync(fx.path).ino, before.ino); assert.deepEqual(fx.read(), original);
      assert.equal(observeSlotCapacity(fx.path, 1).state, "observed", "occupied capacity is preserved");
    } finally { peer?.release(); owner?.release(); fx.cleanup(); }
  });
}

test("private hostname mismatch with a claimed equal namespace stays occupied rather than aging into authority", () => {
  const fx = fixture(); let owner: TestSlotLease | undefined, peer: TestSlotLease | undefined;
  try {
    owner = acquireTestSlot("host identity owner", fx.options); assert.equal(owner.outcome, "acquired");
    fx.age(); const original = fx.read(); let probes = 0;
    peer = acquireTestSlot("unproven host identity", { ...fx.options, hostname: () => "different-host", isPidAlive: () => { probes++; return false; } });
    refused(peer); assert.equal(probes, 0); assert.deepEqual(fx.read(), original);
  } finally { peer?.release(); owner?.release(); fx.cleanup(); }
});

for (const missing of ["owner", "peer", "both"] as const) {
  test(`private expired owner with ${missing} Linux namespace missing never authorizes PID recovery`, () => {
    const fx = fixture(); let owner: TestSlotLease | undefined, peer: TestSlotLease | undefined;
    try {
      owner = acquireTestSlot("unknown identity owner", { ...fx.options, pidNamespace: () => missing === "peer" ? "pid:[owner]" : undefined });
      assert.equal(owner.outcome, "acquired"); fx.age(); const original = fx.read(); let probes = 0;
      peer = acquireTestSlot("unknown identity peer", { ...fx.options, pidNamespace: () => missing === "owner" ? "pid:[owner]" : undefined,
        isPidAlive: () => { probes++; return false; } });
      refused(peer); assert.equal(probes, 0); assert.deepEqual(fx.read(), original);
    } finally { peer?.release(); owner?.release(); fx.cleanup(); }
  });
}

test("private same-identity confirmed dead owner remains recoverable", () => {
  const fx = fixture(); let owner: TestSlotLease | undefined, peer: TestSlotLease | undefined;
  try {
    owner = acquireTestSlot("dead owner", { ...fx.options, pid: 999_999 }); assert.equal(owner.outcome, "acquired");
    const original = fx.read(); let probes = 0;
    peer = acquireTestSlot("same identity recovery", { ...fx.options, isPidAlive: () => { probes++; return false; } });
    assert.equal(peer.outcome, "acquired"); assert(probes > 0); assert.notEqual(fx.read().ownerNonce, original.ownerNonce);
  } finally { peer?.release(); owner?.release(); fx.cleanup(); }
});

test("private same-identity live owner keeps its expired heartbeat reservation", () => {
  const fx = fixture(); let owner: TestSlotLease | undefined, peer: TestSlotLease | undefined;
  try {
    owner = acquireTestSlot("same identity live owner", fx.options); assert.equal(owner.outcome, "acquired");
    fx.age(); const original = fx.read(); let probes = 0;
    peer = acquireTestSlot("same identity live control", { ...fx.options, isPidAlive: () => { probes++; return true; } });
    refused(peer); assert(probes > 0); assert.deepEqual(fx.read(), original);
  } finally { peer?.release(); owner?.release(); fx.cleanup(); }
});

test("private positive different-kernel-boot proof permits recovery across PID namespaces", () => {
  const fx = fixture(); let owner: TestSlotLease | undefined, peer: TestSlotLease | undefined;
  try {
    owner = acquireTestSlot("previous boot", fx.options); assert.equal(owner.outcome, "acquired"); const original = fx.read();
    peer = acquireTestSlot("positive reboot recovery", { ...fx.options, bootId: () => "new-kernel-boot", pidNamespace: () => "pid:[new-boot]",
      isPidAlive: () => { throw new Error("foreign PID probe is not needed for a reboot proof"); } });
    assert.equal(peer.outcome, "acquired"); assert.notEqual(fx.read().ownerNonce, original.ownerNonce);
  } finally { peer?.release(); owner?.release(); fx.cleanup(); }
});

test("private authorized terminal release permits owner-lane recovery with unknown namespace", () => {
  const fx = fixture(); let owner: TestSlotLease | undefined, peer: TestSlotLease | undefined;
  try {
    owner = acquireTestSlot("finished owner", fx.options); assert.equal(owner.outcome, "acquired"); const original = fx.read();
    writeFileSync(fx.path, JSON.stringify({ ...original, releaseRequestedAt: new Date().toISOString() }));
    peer = acquireTestSlot("terminal recovery", { ...fx.options, pidNamespace: () => undefined,
      isPidAlive: () => { throw new Error("terminal release does not need an unproven PID probe"); } });
    assert.equal(peer.outcome, "acquired"); assert.notEqual(fx.read().ownerNonce, original.ownerNonce);
  } finally { peer?.release(); owner?.release(); fx.cleanup(); }
});
