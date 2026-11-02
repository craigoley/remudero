import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireTestSlot } from "#src/lib/test-slot.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-slot-file-safety-")), logs: string[] = [];
  const lease = acquireTestSlot("owned safety fixture", { dir: root, slots: 1, memoryHeadroom: () => undefined,
    ownershipProtocol: "private-capacity-v1",
    load: () => ({ cores: 8, load1: 0 }), log: (line: string) => logs.push(line) });
  assert.equal(lease.outcome, "acquired");
  return { root, logs, lease, path: join(root, "slot-1.json"), cleanup: () => { lease.release(); rmSync(root, { recursive: true, force: true }); } };
}
test("a host test slot keeps ownership bytes private while capacity is projected separately", () => {
  const fx = fixture(); try {
    assert.equal(statSync(fx.path).mode & 0o022, 0);
    assert.equal(statSync(fx.path).mode & 0o600, 0o600);
    assert.equal(statSync(fx.path).mode & 0o077, 0);
    fx.lease.refresh(); assert.equal(JSON.parse(readFileSync(fx.path, "utf8")).pid, process.pid);
  } finally { fx.cleanup(); }
});
test("a permissive caller umask cannot make an owned test slot group or world writable", () => {
  const previous = process.umask(0); let fx: ReturnType<typeof fixture> | undefined;
  try {
    fx = fixture();
    assert.equal(statSync(fx.path).mode & 0o777, 0o600);
    fx.lease.refresh(); assert.equal(statSync(fx.path).mode & 0o022, 0);
  } finally { try { fx?.cleanup(); } finally { process.umask(previous); } }
});
test("a restrictive caller umask keeps private ownership private without hiding its capacity directory", () => {
  const previous = process.umask(0o077); let fx: ReturnType<typeof fixture> | undefined;
  try {
    fx = fixture(); assert.equal(statSync(fx.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(fx.root, `capacity-${process.getuid?.()}`)).mode & 0o777, 0o755);
  }
  finally { try { fx?.cleanup(); } finally { process.umask(previous); } }
});
test("a refreshed test slot never follows a replacement symlink or overwrites its owned sentinel", () => {
  const fx = fixture(); try {
    const sentinel = join(fx.root, "sentinel.json"); writeFileSync(sentinel, '{"owned-sentinel":true}');
    renameSync(fx.path, join(fx.root, "original-record")); symlinkSync(sentinel, fx.path);
    fx.lease.refresh(); assert.equal(readFileSync(sentinel, "utf8"), '{"owned-sentinel":true}');
    assert(fx.logs.some(x => JSON.parse(x).step === "test_slot.refresh_lost"));
    fx.lease.release(); assert.equal(readFileSync(sentinel, "utf8"), '{"owned-sentinel":true}');
  } finally { fx.cleanup(); }
});
test("a foreign replacement record survives old lease refresh and release", () => {
  const fx = fixture(); try {
    renameSync(fx.path, join(fx.root, "old-record")); const foreign = '{"foreign-lease":true}'; writeFileSync(fx.path, foreign);
    fx.lease.refresh(); fx.lease.release(); assert.equal(readFileSync(fx.path, "utf8"), foreign);
  } finally { fx.cleanup(); }
});
test("an in-place changed owner nonce cannot regain the old lease heartbeat", () => {
  const fx = fixture(); try {
    const changed = { ...JSON.parse(readFileSync(fx.path, "utf8")), ownerNonce: "replacement-owner" };
    writeFileSync(fx.path, JSON.stringify(changed)); fx.lease.refresh(); fx.lease.release();
    assert.equal(JSON.parse(readFileSync(fx.path, "utf8")).ownerNonce, "replacement-owner");
  } finally { fx.cleanup(); }
});
test("an unavailable or malformed own lease record is reported without following another file", () => {
  const fx = fixture(); try {
    writeFileSync(fx.path, "not-json"); fx.lease.refresh(); fx.lease.release();
    assert.equal(readFileSync(fx.path, "utf8"), "not-json");
    assert(fx.logs.some(x => JSON.parse(x).step === "test_slot.refresh_lost"));
  } finally { fx.cleanup(); }
});
test("a missing canonical lease path closes only the owned descriptor and reports refresh failure", () => {
  const fx = fixture(); try {
    const orphan = join(fx.root, "owned-orphan"), before = readFileSync(fx.path, "utf8");
    renameSync(fx.path, orphan); fx.lease.refresh(); fx.lease.release();
    assert.equal(readFileSync(orphan, "utf8"), before);
    assert(fx.logs.some(x => {
      const log = JSON.parse(x);
      return log.step === "test_slot.refresh_failed" && String(log.error).includes("ENOENT");
    }), "the missing-path control must exercise native ENOENT, not a swallowed programming error");
  } finally { fx.cleanup(); }
});
