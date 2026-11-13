import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import type { Escalation } from "#src/lib/escalate.js";
import * as gardener from "#src/lib/host-resource-gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const GIB = 1024 ** 2;

function payload(over: Record<string, string> = {}, omit: readonly string[] = []): string {
  const fields: Record<string, string> = {
    beat_ts: new Date(NOW).toISOString(),
    root_fs_device: "/dev/root",
    state_fs_device: "/dev/state",
    root_fs_free_kb: String(14 * GIB),
    root_fs_reserve_kb: String(10 * GIB),
    state_fs_free_kb: String(40 * GIB),
    state_fs_reserve_kb: String(20 * GIB),
    ...over,
  };
  return Object.entries(fields).filter(([key]) => !omit.includes(key)).map(([k, v]) => `${k}=${v}`).join("\n");
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reserve-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const escalations: Escalation[] = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let beat = payload();
  const ports = (): gardener.HostResourcePorts => ({
    stateDir: dir,
    clock: fixedClock(NOW),
    readHeartbeats: async () => [{ host: "azure", payload: beat }],
    planOrigins: () => [],
    escalate: (e) => { escalations.push(e); return "https://example.test/issues/1"; },
    log: (step, extra) => rows.push({ step, extra }),
  });
  return { dir, escalations, rows, ports, setBeat: (value: string) => { beat = value; } };
}

test("W1-T12254 criterion 1: either volume escalates between its reserve and 1.5 times it", async (t) => {
  const f = fixture(t);
  for (const device of ["root", "state"] as const) {
    f.setBeat(payload({
      beat_ts: new Date(NOW + (device === "state" ? 60_000 : 0)).toISOString(),
      root_fs_free_kb: String((device === "root" ? 14 : 40) * GIB),
      state_fs_free_kb: String((device === "state" ? 29 : 40) * GIB),
    }));
    await gardener.runHostResourcePassAsync(f.ports());
    const e = f.escalations.at(-1)!;
    const [free, reserve] = device === "root" ? [14, 10] : [29, 20];
    const summary = `Free disk on azure ${device} is ${free.toFixed(1)} GiB. The reserve is ${reserve.toFixed(1)} GiB.`;
    assert.equal(e.taskId, `host-reserve-azure-${device}`);
    assert.equal(e.summary, summary);
    assert.equal(e.detail.split("\n")[0], summary);
    assert.match(e.detail, /janitor pass fails/i);
  }
  assert.equal(f.escalations.length, 2);
});

test("W1-T12254 criterion 2: three largest consumers belong to the affected volume", async (t) => {
  const f = fixture(t);
  f.setBeat(payload({
    consumer_small_kb: String(GIB), consumer_small_device: "/dev/root",
    consumer_other_kb: String(100 * GIB), consumer_other_device: "/dev/state",
    consumer_second_kb: String(3 * GIB), consumer_second_device: "/dev/root",
    consumer_first_kb: String(4 * GIB), consumer_first_device: "/dev/root",
    consumer_third_kb: String(2 * GIB), consumer_third_device: "/dev/root",
    consumer_unlocated_kb: String(200 * GIB),
  }));
  await gardener.runHostResourcePassAsync(f.ports());
  const detail = f.escalations[0]!.detail;
  assert.deepEqual(detail.split("\n").filter((line) => line.startsWith("- ")),
    ["- first: 4.0 GiB", "- second: 3.0 GiB", "- third: 2.0 GiB"]);
  assert.doesNotMatch(detail, /other|unlocated|small/);
  f.setBeat(payload({ beat_ts: new Date(NOW + 60_000).toISOString(),
    root_fs_free_kb: String(40 * GIB), state_fs_free_kb: String(GIB),
    consumer_root_only_kb: String(10 * GIB), consumer_root_only_device: "/dev/root" }));
  await gardener.runHostResourcePassAsync(f.ports());
  assert.match(f.escalations[1]!.detail, /no measured consumers on state/i);
});

test("W1-T12254 criterion 3: episodes persist across later passes and a restarted gardener", async (t) => {
  const f = fixture(t);
  const ports = f.ports();
  await gardener.runHostResourcePassAsync(ports);
  await gardener.runHostResourcePassAsync(ports);
  f.setBeat(payload({ beat_ts: new Date(NOW + 60_000).toISOString() }));
  await gardener.runHostResourcePassAsync(f.ports());
  assert.equal(f.escalations.length, 1);
  const saved = JSON.parse(readFileSync(gardener.hostResourceStatePath(f.dir), "utf8"));
  assert.equal(saved.episodes["azure:root:reserve"].escalatedAt, new Date(NOW).toISOString());
  f.setBeat(payload({ beat_ts: new Date(NOW + 120_000).toISOString(), state_fs_free_kb: String(29 * GIB) }));
  await gardener.runHostResourcePassAsync(f.ports());
  assert.deepEqual(f.escalations.map((e) => e.taskId), ["host-reserve-azure-root", "host-reserve-azure-state"]);
});

test("W1-T12254 criterion 4: recovery at the boundary is recorded once and permits a new fall", async (t) => {
  const f = fixture(t);
  await gardener.runHostResourcePassAsync(f.ports());
  f.setBeat(payload({ beat_ts: new Date(NOW + 60_000).toISOString(), root_fs_free_kb: String(15 * GIB) }));
  await gardener.runHostResourcePassAsync(f.ports());
  await gardener.runHostResourcePassAsync(f.ports());
  assert.deepEqual(f.rows.filter((r) => r.step === "host_resource.recovered").map((r) => r.extra?.key), ["azure:root:reserve"]);
  f.setBeat(payload({ beat_ts: new Date(NOW + 120_000).toISOString() }));
  await gardener.runHostResourcePassAsync(f.ports());
  assert.equal(f.escalations.length, 2);
});

test("W1-T12254 criterion 5: missing and unreadable values stay absent and never escalate", async (t) => {
  const f = fixture(t);
  const readable = gardener.sampleFromPayload("azure", gardener.parseHeartbeatPayload(payload()))!;
  assert.equal(readable.values.root_reserve_kb, 10 * GIB);
  assert.equal(readable.values.state_reserve_kb, 20 * GIB);
  const fields = ["root_fs_reserve_kb", "state_fs_reserve_kb", "root_fs_free_kb", "state_fs_free_kb"];
  let tick = 0;
  for (const field of fields) {
    for (const raw of [undefined, "unknown", "junk", ""]) {
      const beat = payload({ root_fs_free_kb: "0", state_fs_free_kb: "0",
        beat_ts: new Date(NOW + ++tick * 60_000).toISOString(),
        ...(raw === undefined ? {} : { [field]: raw }),
      }, [...fields.filter((k) => k.startsWith(field.startsWith("root") ? "state" : "root")),
        ...(raw === undefined ? [field] : [])]);
      f.setBeat(beat);
      await gardener.runHostResourcePassAsync(f.ports());
      const sample = gardener.sampleFromPayload("azure", gardener.parseHeartbeatPayload(beat))!;
      const valueKey = field.replace("_fs", "");
      assert.equal(Object.hasOwn(sample.values, valueKey), false, `${field}=${raw}`);
    }
  }
  assert.deepEqual(f.escalations, []);
});

test("W1-T12254 criterion 6: steady low disk escalates without altering trend findings", async (t) => {
  const f = fixture(t);
  const samples = Array.from({ length: 5 }, (_, i) => gardener.sampleFromPayload("azure", gardener.parseHeartbeatPayload(payload({
    beat_ts: new Date(NOW - (4 - i) * 3_600_000).toISOString(),
  })))!);
  writeFileSync(gardener.samplesPath(f.dir), samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
  assert.deepEqual(gardener.evaluateHost("azure", samples, NOW), []);
  const falling = samples.map((s, i) => ({ ...s, values: { ...s.values, root_free_kb: (18 - i) * GIB } }));
  const withoutReserves = falling.map((s) => ({ ...s, values: { root_free_kb: s.values.root_free_kb! } }));
  const before = gardener.evaluateHost("azure", withoutReserves, NOW);
  assert.equal(before.length, 1);
  assert.deepEqual(gardener.evaluateHost("azure", falling, NOW), before);
  assert.deepEqual((await gardener.runHostResourcePassAsync(f.ports())).findings, []);
  assert.equal(f.escalations.length, 1);
});

test("reserve episodes survive an unreadable sample until measured recovery", async (t) => {
  const f = fixture(t);
  await gardener.runHostResourcePassAsync(f.ports());
  f.setBeat(payload({ beat_ts: new Date(NOW + 60_000).toISOString(), root_fs_free_kb: "unknown" }));
  await gardener.runHostResourcePassAsync(f.ports());
  assert.deepEqual(f.rows.filter((r) => r.step === "host_resource.recovered"), []);
  f.setBeat(payload({ beat_ts: new Date(NOW + 120_000).toISOString() }));
  await gardener.runHostResourcePassAsync(f.ports());
  assert.equal(f.escalations.length, 1);
});

test("reserve escalation respects HOST_RESOURCE_OFF", async (t) => {
  const f = fixture(t);
  writeFileSync(gardener.hostResourceOffPath(f.dir), "");
  assert.equal((await gardener.runHostResourcePassAsync(f.ports())).ran, false);
  assert.deepEqual(f.escalations, []);
});

test("reserve evaluation reads only the newest sample of the requested host", () => {
  const sample = (host: string, over: Record<string, string>) =>
    gardener.sampleFromPayload(host, gardener.parseHeartbeatPayload(payload(over)))!;
  const old = sample("azure", { beat_ts: new Date(NOW - 60_000).toISOString(), root_fs_free_kb: "0" });
  const latest = sample("azure", { root_fs_free_kb: String(16 * GIB) });
  const other = sample("other", { beat_ts: new Date(NOW + 60_000).toISOString(), root_fs_free_kb: "0" });
  assert.deepEqual(gardener.evaluateReserve("azure", [latest, other, old]), []);
  assert.deepEqual(gardener.evaluateReserve("absent", [latest, old]), []);
  assert.deepEqual(gardener.evaluateReserve("azure", []), []);
  const low = sample("azure", {});
  assert.deepEqual(gardener.evaluateReserve("azure", [low]), [{
    host: "azure", device: "root", freeKb: 14 * GIB, reserveKb: 10 * GIB, consumers: [],
  }]);
  assert.deepEqual(gardener.evaluateReserve("azure", [sample("azure", { root_fs_reserve_kb: "0" })]), []);
});

test("unknown consumer devices and a shared state volume are never borrowed", async (t) => {
  const f = fixture(t);
  f.setBeat(payload({ root_fs_device: "unknown", state_fs_device: "unknown",
    state_fs_free_kb: "0", consumer_mystery_kb: String(GIB), consumer_mystery_device: "unknown" }));
  await gardener.runHostResourcePassAsync(f.ports());
  assert.equal(f.escalations.length, 1);
  assert.match(f.escalations[0]!.detail, /No measured consumers on root/);
  assert.doesNotMatch(f.escalations[0]!.detail, /mystery/);
});

test("an unconnected escalation port does not mark a reserve episode as escalated", async (t) => {
  const f = fixture(t);
  await gardener.runHostResourcePassAsync({ ...f.ports(), escalate: undefined });
  await gardener.runHostResourcePassAsync(f.ports());
  assert.equal(f.escalations.length, 1);
});
