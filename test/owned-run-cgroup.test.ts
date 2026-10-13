import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openMemoryReservation, ownedMemoryRunBinding, readMemoryLedger, sweepMemoryReservations } from "../src/lib/host-memory-ledger.js";

const api = () => import("../src/lib/owned-run-cgroup.js");
test("owned whole-run cgroup is default off and never chooses a root or inspects a parent", async () => {
  const { createOwnedRunCgroup } = await api();
  assert.equal(createOwnedRunCgroup({ get parent(): string { throw new Error("OFF must not inspect a parent"); } }), undefined);
  assert.throws(() => createOwnedRunCgroup({ enabled: true }), /explicit delegated/);
  assert.throws(() => createOwnedRunCgroup({ enabled: true, parent: "/sys/fs/cgroup" }), /explicit delegated/);
});
test("owned whole-run cgroup refuses an ordinary filesystem and copied self-join identity", async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-cgroup-refusal-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { createOwnedRunCgroup, joinOwnedRunCgroupSelf } = await api();
  assert.throws(() => createOwnedRunCgroup({ enabled: true, parent: dir }), /identity\/backend unavailable/);
  assert.throws(() => joinOwnedRunCgroupSelf({ path: dir, dev: 0, ino: 0, ownerPid: process.pid, ownerStart: "copied", namespace: "copied" }), /genuine child/);
});
test("canonical memory binding distinguishes fresh own capacity from bound foreign and missing records", t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-memory-binding-"))), previous = process.env.RMD_TEST_SLOT_DIR;
  process.env.RMD_TEST_SLOT_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.RMD_TEST_SLOT_DIR;else process.env.RMD_TEST_SLOT_DIR = previous;rmSync(dir, { recursive: true, force: true }); });
  const lease = openMemoryReservation({ workerClass: "unclassified", root: dir });
  assert.ok(lease.id);assert.equal(lease.published, true);
  assert.equal(ownedMemoryRunBinding(lease.id!).state, "unavailable", "new/reset storage is not qualified capacity");
  assert.ok(sweepMemoryReservations());
  assert.equal(readMemoryLedger()?.state, "present", "fresh read after canonical initialization positively observes the store");
  assert.deepEqual(ownedMemoryRunBinding(lease.id!), { state: "fresh" });
  assert.equal(ownedMemoryRunBinding("foreign").state, "unavailable");
  lease.bindRoot(process.pid);
  const bound = ownedMemoryRunBinding(lease.id!);
  assert.equal(bound.state, "bound");if (bound.state === "bound") assert.equal(bound.roots[0]?.pid, process.pid);
  lease.releaseOccupancy();
  assert.equal(ownedMemoryRunBinding(lease.id!).state, "unavailable");
});
