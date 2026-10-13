import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { captureHeavyNewBuildStartupGate } from "../src/lib/heavy-ready-startup.js";
import { heavyReadyEscalationSink, readHeavyNewBuildHold, reserveHeavyNewBuilds, HEAVY_READY_ESCALATION_MS } from "../src/lib/heavy-build-reservation.js";

function fixture(t: TestContext): string {
  let root = realpathSync(tmpdir());
  if (process.platform === "linux" && ![0xef53, 0x58465342].includes(statfsSync(root).type)) root = realpathSync(process.cwd());
  assert.equal(lstatSync(root).uid, process.getuid?.());
  const dir = mkdtempSync(join(root, "heavy-deadline-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const load = () => import("../src/lib/heavy-ready-deadline.js");

test("heavy READY refuses void false forged and asynchronous delivery acknowledgements", async t => {
  const dir = fixture(t), h = reserveHeavyNewBuilds("explicit-ack", "gate", { dir });
  const ack = join(dir, `heavy-build-${h.request.id}-delivered.json`, "record.json");
  for (const log of [() => undefined, () => false, () => "ok", () => ({ durable: true, eventId: `${h.request.id}:escalated`, receiptSha256: "a".repeat(64) }), async () => true]) {
    assert.deepEqual(readHeavyNewBuildHold({ dir, now: h.request.expiresAtMs, log }), { state: "clear", observed: 1, pendingEscalations: 1 });
    assert.equal(existsSync(ack), false);
  }
  const reading = (await load()).heavyReadyDeadlineTick(dir, h.request.expiresAtMs);
  assert.deepEqual(reading.reading, { state: "clear", observed: 1, pendingEscalations: 0 });
  assert.equal(existsSync(ack), true);
});

test("heavy READY retains legacy acknowledgements but retries them until a durable inbox receipt exists", async t => {
  const dir = fixture(t), h = reserveHeavyNewBuilds("legacy-ack", "gate", { dir });
  const closedPath = join(dir, `heavy-build-${h.request.id}-closed.json`, "record.json");
  readHeavyNewBuildHold({ dir, now: h.request.expiresAtMs });
  const { createHash } = await import("node:crypto");
  const old = JSON.stringify({ version: 2, closureHash: createHash("sha256").update(JSON.stringify(JSON.parse(readFileSync(closedPath, "utf8")))).digest("hex"), eventId: `${h.request.id}:escalated` });
  const ackDir = join(dir, `heavy-build-${h.request.id}-delivered.json`);
  mkdirSync(ackDir, { mode: 0o700 });writeFileSync(join(ackDir, "record.json"), old, { mode: 0o600 });
  assert.equal(readHeavyNewBuildHold({ dir, now: h.request.expiresAtMs }).state, "clear");
  assert.equal((await load()).heavyReadyDeadlineTick(dir, h.request.expiresAtMs).reading.state, "clear");
  assert.equal(readFileSync(join(ackDir, "record.json"), "utf8"), old, "never rewrites historical ACK");
  assert.deepEqual(readHeavyNewBuildHold({ dir, now: h.request.readyAtMs - 1 }), { state: "clear", observed: 1, pendingEscalations: 0 });
});

test("heavy READY durable sink refuses unbound events and validates an immutable receipt", async t => {
  const dir = fixture(t), h = reserveHeavyNewBuilds("bound-inbox", "gate", { dir }), sink = heavyReadyEscalationSink(dir);
  assert.throws(() => sink("other", {}), /unsupported/);
  assert.throws(() => sink("heavy_ready.escalated", { request_id: h.request.id }), /unbound/);
  (await load()).heavyReadyDeadlineTick(dir, h.request.expiresAtMs);
  const receipt = join(dir, `heavy-build-${h.request.id}-escalation.json`, "record.json"), original = readFileSync(receipt);
  writeFileSync(receipt, "{}", { mode: 0o600 });
  assert.equal(readHeavyNewBuildHold({ dir, now: h.request.expiresAtMs }).state, "unavailable");
  writeFileSync(receipt, original);
  assert.deepEqual(readHeavyNewBuildHold({ dir, now: h.request.expiresAtMs }), { state: "clear", observed: 1, pendingEscalations: 0 });
});

test("heavy READY independent service is default off before reading any directory", async () => {
  const api = await load();
  assert.equal(api.startHeavyReadyDeadlineService({ get dir() { assert.fail("OFF must not inspect directory"); } }), undefined);
  assert.throws(() => api.startHeavyReadyDeadlineService({ enabled: true }), /explicit directory/);
});

test("heavy READY independent deadline survives a blocked main loop without renewing READY", { timeout: 10000 }, async t => {
  const dir = fixture(t), readyAt = Date.now() - HEAVY_READY_ESCALATION_MS + 2000;
  const h = reserveHeavyNewBuilds("blocked-loop", "gate", { dir, now: readyAt }), api = await load();
  const service = api.startHeavyReadyDeadlineService({ enabled: true, dir })!;
  t.after(() => service.stop());
  const waitUntil = Date.now() + 3000;
  while (!service.observation() && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.observation()?.reading.state, "held", "positive control: real worker observed live READY");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500);
  const closed = JSON.parse(readFileSync(join(dir, `heavy-build-${h.request.id}-closed.json`, "record.json"), "utf8"));
  assert.equal(closed.kind, "escalated");assert.equal(closed.atMs, h.request.expiresAtMs);
  assert.equal(existsSync(join(dir, `heavy-build-${h.request.id}-delivered.json`, "record.json")), true);
  assert.equal(reserveHeavyNewBuilds("blocked-loop", "gate", { dir }).request.readyAtMs, readyAt);
  await service.stop();await service.stop();
});

test("heavy READY service reports missing backend as UNKNOWN and never creates it", { timeout: 5000 }, async t => {
  const dir = join(fixture(t), "missing"), service = (await load()).startHeavyReadyDeadlineService({ enabled: true, dir })!;
  t.after(() => service.stop());
  const end = Date.now() + 3000;
  while (!service.observation() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.observation()?.reading.state, "unavailable");assert.equal(existsSync(dir), false);
});

test("heavy READY startup requires a separate service opt-in and refuses invalid wiring only at NEW admission", { timeout: 5000 }, async t => {
  const dir = fixture(t), startupFile = join(dir, "absent.json");
  for (const env of [{ RMD_HEAVY_READY_DEADLINE_SERVICE: "yes" }, { RMD_HEAVY_READY_DEADLINE_SERVICE: "1" }]) {
    const gate = captureHeavyNewBuildStartupGate(() => {}, {}, { env, startupFile });
    assert.throws(gate, /configuration unavailable/);
  }
  const h = reserveHeavyNewBuilds("startup-service", "gate", { dir });
  const gate = captureHeavyNewBuildStartupGate(() => {}, { heavyReadyDirectory: dir }, { env: { RMD_HEAVY_READY_DEADLINE_SERVICE: "1" }, startupFile });
  t.after(() => gate.stop?.());
  const end = Date.now() + 3000;
  let found: unknown;
  while (Date.now() < end) {
    try { found = gate();break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.equal((found as { requestId: string })?.requestId, h.request.id);
  await gate.stop?.();
});
