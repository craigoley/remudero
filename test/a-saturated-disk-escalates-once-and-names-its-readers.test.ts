import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { Escalation } from "../src/lib/escalate.js";
import { evaluateIo, runHostResourcePass, sampleFromPayload, type HeartbeatRead, type HostResourcePorts, type IncidentHandoff } from "../src/lib/host-resource-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const MIN = 60_000;
const START = Date.parse("2026-10-09T12:00:00.000Z");

/** One heartbeat payload whose data disk was `util` % busy over the beat. */
function beat(tsMs: number, util: number): string {
  return [
    `beat_ts=${new Date(tsMs).toISOString().replace(/\.\d+Z$/, "Z")}`,
    "root_fs_device=/dev/root",
    "root_fs_free_kb=7000000",
    "io_devices=nvme0n2,nvme0n1",
    "io_interval_s=300",
    "io_nvme0n2_roles=root",
    "io_nvme0n2_util_pct=6",
    "io_nvme0n2_await_ms=1.0",
    "io_nvme0n2_tps=60.0",
    "io_nvme0n1_roles=state,daemon",
    `io_nvme0n1_util_pct=${util}`,
    "io_nvme0n1_await_ms=190.0",
    "io_nvme0n1_tps=480.0",
    "io_nvme0n1_readers=remudero-site-daemon:7700000:158.0,remudero-console-daemon:1900000:50.0",
  ].join("\n") + "\n";
}

interface Driven {
  escalations: Escalation[];
  handoffs: IncidentHandoff[];
  steps: string[];
}

/** Feed the gardener one beat every 5 minutes, as the host cron does, running a pass after each. */
function drive(utilAt: (minute: number) => number, minutes: number): Driven {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-io-`));
  const out: Driven = { escalations: [], handoffs: [], steps: [] };
  try {
    for (let m = 0; m <= minutes; m += 5) {
      const now = START + m * MIN;
      const reads: HeartbeatRead[] = [{ host: "azure", payload: beat(now, utilAt(m)) }];
      const ports: HostResourcePorts = {
        stateDir: dir,
        clock: fixedClock(now + 30_000),
        log: (step) => out.steps.push(step),
        readHeartbeats: () => reads,
        planOrigins: () => [],
        handoff: (h) => out.handoffs.push(h),
        escalate: (e) => {
          out.escalations.push(e);
          return `https://github.com/craigoley/remudero/issues/${out.escalations.length}`;
        },
      };
      runHostResourcePass(ports);
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a heartbeat's io_ keys become a per-disk reading with its top readers", () => {
  const sample = sampleFromPayload("azure", Object.fromEntries(beat(START, 93).trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])));
  assert.deepEqual(sample?.io?.["nvme0n1"], {
    utilPct: 93,
    awaitMs: 190,
    tps: 480,
    roles: ["state", "daemon"],
    readers: [
      { cgroup: "remudero-site-daemon", readBytesPerS: 7_700_000, readIops: 158 },
      { cgroup: "remudero-console-daemon", readBytesPerS: 1_900_000, readIops: 50 },
    ],
  });
});

test("a disk saturated for a sustained hour escalates once, names its top readers, and recovers", () => {
  // 90+ % busy from minute 0 to 120, then idle for two hours.
  const run = drive((m) => (m <= 120 ? 93 : 10), 240);
  assert.equal(run.escalations.length, 1, "one escalation per episode, not one per beat");
  const e = run.escalations[0]!;
  assert.equal(e.taskId, "host-io-azure-nvme0n1");
  assert.match(e.summary, /disk nvme0n1 has stayed saturated/);
  assert.match(e.detail, /backs state, daemon/);
  assert.match(e.detail, /Top readers: remudero-site-daemon 7\.3 MB\/s \(158 r\/s\); remudero-console-daemon 1\.8 MB\/s/);
  assert.equal(run.handoffs.length, 1, "the SRE lane hears about it once too");
  assert.match(run.handoffs[0]!.raw, /^host-io:azure:nvme0n1/);
  assert.ok(run.steps.includes("host_resource.io_escalated"));
  assert.ok(run.steps.includes("host_resource.io_recovered"), "the episode ends once the disk calms down");
  assert.equal(run.steps.filter((s) => s === "host_resource.io_pressure").length >= 1, true);
});

test("a brief burst and a busy-but-coping disk never escalate; the tier grows with how long it lasts", () => {
  assert.equal(drive((m) => (m >= 30 && m <= 45 ? 99 : 5), 180).escalations.length, 0, "a 15-minute burst is not sustained");
  const busy = drive(() => 60, 60);
  assert.equal(busy.escalations.length, 0);
  assert.equal(busy.handoffs.length, 0, "an hour at 60% is recorded only");
  assert.ok(busy.steps.includes("host_resource.io_pressure"));
  const long = drive(() => 80, 200);
  assert.equal(long.handoffs.length, 1, "an hour at 80% is an incident");
  assert.equal(long.escalations.length, 1, "three hours at 80% escalates");
});

test("an idle root disk and a stale heartbeat produce no io finding", () => {
  const samples = Array.from({ length: 13 }, (_, i) => sampleFromPayload("azure", Object.fromEntries(beat(START + i * 5 * MIN, 95).trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])))!);
  const fresh = evaluateIo("azure", samples, START + 61 * MIN);
  assert.deepEqual(fresh.map((f) => [f.device, f.tier]), [["nvme0n1", "escalate"]]);
  assert.deepEqual(evaluateIo("azure", samples, START + 6 * 60 * MIN), [], "pressure read hours ago describes the past");
});
