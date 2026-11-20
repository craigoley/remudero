import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { acquireTestSlot, type TestSlotHolder, type TestSlotOptions } from "#src/lib/test-slot.js";

// W1-T13811: all fixture time is injected; no dated fixture is compared with the real clock.
const NOW = Date.parse("2026-11-19T07:00:00Z");
const NS = "pid:[4026531836]";
const CURRENT_BOOT = "91a39ae7-58f6-4d77-8be5-6ebe51c8b20d";
const EARLIER_BOOT = "434cb588-5921-4f94-917b-8895b2a9a5d5";

const holder = (extra: Partial<TestSlotHolder> = {}): TestSlotHolder => ({
  pid: 354, host: "vm", bootId: EARLIER_BOOT, pidNs: NS, processStart: "proc:1716", ownerUid: process.getuid?.(),
  startedAt: new Date(NOW - 5_400_000).toISOString(), heartbeatAt: new Date(NOW - 4_800_000).toISOString(),
  heartbeatIntervalMs: 60_000, label: "preflight-author:static-and-affected", ownerNonce: "1dd5cbde-earlier", ...extra,
});

function slot(t: TestContext, held: TestSlotHolder, boot: () => string | undefined = () => CURRENT_BOOT) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13811-`));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir + ".queue", { recursive: true, force: true });
  });
  const path = join(dir, "slot-1.json");
  writeFileSync(path, JSON.stringify(held), { mode: 0o644 });
  const rows: Record<string, unknown>[] = [];
  const acquire = (extra: Partial<TestSlotOptions> = {}) => {
    const lease = acquireTestSlot("earlier-boot waiter", {
      dir, slots: 1, queue: false, waitBoundMs: 0, platform: "linux",
      clock: { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() },
      hostname: () => "vm", bootId: boot, pidNamespace: () => NS, cgroupNamespace: () => "cgroup:[waiter]",
      isPidAlive: () => false, memoryHeadroom: () => undefined, load: () => ({ cores: 8, load1: 0 }),
      log: line => rows.push(JSON.parse(line)), say: () => {},
      treeProbe: () => ({ state: "unknown", coverage: "none", reason: "fixture tree probe sees nothing" }), ...extra,
    });
    t.after(() => lease.release());
    return lease;
  };
  return { path, rows, acquire };
}

const reclaims = (rows: Record<string, unknown>[]) => rows.filter(row => row.step === "test_slot.reclaimed_quiescent");

test("W1-T13811: a same-host, same-namespace slot record from an earlier boot is reclaimed at once with a boot-change reason", t => {
  const f = slot(t, holder());
  const lease = f.acquire();
  assert.equal(lease.executionAllowed, true, `the waiter runs instead of waiting: ${lease.note}`);
  const rows = reclaims(f.rows);
  assert.equal(rows.length, 1, "exactly one reclaim row");
  assert.equal(rows[0]!.coverage, "earlier-boot");
  assert.match(String(rows[0]!.reason), new RegExp(`boot ${EARLIER_BOOT}.*current boot is ${CURRENT_BOOT}`));
  assert.equal(f.rows.some(row => row.step === "test_slot.reclaim_withheld"), false, "nothing is withheld");
});

test("W1-T13811: the same record under the current boot id is still withheld", t => {
  const f = slot(t, holder({ bootId: CURRENT_BOOT }));
  const lease = f.acquire();
  assert.equal(lease.executionAllowed, false);
  assert.equal(reclaims(f.rows).length, 0);
  assert.equal(existsSync(f.path), true, "the slot file is kept");
});

test("W1-T13811: an unreadable current boot id never frees a slot by this rule", t => {
  const f = slot(t, holder(), () => undefined);
  const lease = f.acquire();
  assert.equal(lease.executionAllowed, false, `an unreadable boot id keeps the slot withheld: ${lease.note}`);
  assert.equal(reclaims(f.rows).length, 0, "nothing is reclaimed");
  assert.equal(readFileSync(f.path, "utf8"), JSON.stringify(holder()), "the original record is kept, not replaced");
});

test("W1-T13811: a record from another pid namespace is not freed by the earlier-boot rule", t => {
  const f = slot(t, holder({ pidNs: "pid:[12345]" }));
  f.acquire();
  assert.equal(reclaims(f.rows).some(row => row.coverage === "earlier-boot"), false);
});

test("W1-T13811: an earlier-boot record is reclaimed even when its pid number is live again in this boot", t => {
  const f = slot(t, holder());
  const lease = f.acquire({ isPidAlive: () => true });
  assert.equal(lease.executionAllowed, true, `a reused pid number does not hold the slot: ${lease.note}`);
  const rows = reclaims(f.rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.coverage, "earlier-boot");
});

test("W1-T13811: an earlier-boot record with no heartbeat cadence is reclaimed with the boot-change reason", t => {
  const f = slot(t, holder({ heartbeatIntervalMs: undefined }));
  const lease = f.acquire({ isPidAlive: () => true });
  assert.equal(lease.executionAllowed, true, lease.note);
  const rows = reclaims(f.rows);
  assert.equal(rows.length, 1, "the reclaim is ledgered, not a silent unlink");
  assert.equal(rows[0]!.coverage, "earlier-boot");
  assert.match(String(rows[0]!.reason), new RegExp(`boot ${EARLIER_BOOT}.*current boot is ${CURRENT_BOOT}`));
});
