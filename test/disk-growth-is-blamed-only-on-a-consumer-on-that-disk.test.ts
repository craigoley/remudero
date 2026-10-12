import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { evaluateHost, runHostResourcePass, sampleFromPayload, samplesPath } from "../src/lib/host-resource-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-04T12:00:00Z");

function history(device = "/dev/state") {
  return Array.from({ length: 9 }, (_, i) => sampleFromPayload("fixture", {
    beat_ts: new Date(NOW - (8 - i) * HOUR).toISOString(),
    root_fs_device: "/dev/root",
    state_fs_device: "/dev/state",
    root_fs_free_kb: String(10_000 - i * 1000),
    state_fs_free_kb: String(10_000 - i * 1000),
    consumer_transcripts_kb: String(1000 + i * 900),
    consumer_transcripts_device: device,
    janitor_last_ts: new Date(NOW - (8 - i) * HOUR).toISOString(),
    janitor_last_freed: "0KB",
  })!);
}

test("test/disk-growth-is-blamed-only-on-a-consumer-on-that-disk.test.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}disk-attribution-`));
  try {
    const samples = history();
    writeFileSync(samplesPath(dir), samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
    const rows: Array<Record<string, unknown>> = [];
    const incidents: string[] = [];
    runHostResourcePass({
      stateDir: dir, clock: fixedClock(NOW), readHeartbeats: () => [], planOrigins: () => [],
      log: (step, row) => { if (step === "host_resource.janitor_ineffective") rows.push(row!); },
      handoff: (incident) => { incidents.push(incident.raw); },
    });
    assert.equal(rows.find((r) => r.device === "root")?.attributed, "unattributed: no measured consumer on root");
    assert.equal(rows.find((r) => r.device === "state")?.attributed, "transcripts");
    assert.ok(incidents.some((raw) => raw.includes("unattributed: no measured consumer on root")));
    assert.ok(incidents.some((raw) => raw.includes("Growth is attributed to transcripts")));

    const mixed = samples.map((s, i) => ({
      ...s,
      consumers: { ...s.consumers, cache: 1000 + i * 100 },
      consumerDevices: { ...s.consumerDevices, cache: "/dev/root" },
    }));
    const findings = evaluateHost("fixture", mixed, NOW);
    assert.equal(findings.find((f) => f.device === "root")?.attribution?.consumer, "cache");
    assert.equal(findings.find((f) => f.device === "state")?.attribution?.consumer, "transcripts");

    const older = history().map((s) => sampleFromPayload("fixture", {
      beat_ts: s.beatTs, root_fs_device: "/dev/root", state_fs_device: "/dev/state",
      root_fs_free_kb: String(s.values.root_free_kb), state_fs_free_kb: String(s.values.state_free_kb),
      consumer_transcripts_kb: String(s.consumers.transcripts),
    })!);
    for (const samples of [older, history("unknown"), history("/dev/root,/dev/state")]) {
      assert.ok(evaluateHost("fixture", samples, NOW).every((f) => f.attribution === undefined));
    }
    const legacy = older.map(({ host, beatTs, tsMs, values, consumers }) => ({ host, beatTs, tsMs, values, consumers }));
    assert.ok(evaluateHost("fixture", legacy, NOW).every((f) => f.attribution === undefined));

    const rootConsumer = history("/dev/root");
    assert.equal(evaluateHost("fixture", rootConsumer, NOW).find((f) => f.device === "root")?.attribution?.consumer, "transcripts");
    assert.equal(evaluateHost("fixture", rootConsumer, NOW).find((f) => f.device === "state")?.attribution, undefined);
    const unknownDisk = history().map((s) => sampleFromPayload("fixture", {
      beat_ts: s.beatTs, root_fs_device: "unknown", root_fs_free_kb: String(s.values.root_free_kb),
      consumer_transcripts_kb: String(s.consumers.transcripts), consumer_transcripts_device: "unknown",
    })!);
    assert.equal(evaluateHost("fixture", unknownDisk, NOW)[0]?.attribution, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
