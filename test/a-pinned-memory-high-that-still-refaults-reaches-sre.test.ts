import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { Escalation } from "../src/lib/escalate.js";
import {
  evaluateMemory,
  memoryFromPayload,
  parseHeartbeatPayload,
  runHostResourcePass,
  sampleFromPayload,
  type HeartbeatRead,
  type HostResourcePorts,
  type IncidentHandoff,
} from "../src/lib/host-resource-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const MIN = 60_000;
const START = Date.parse("2026-10-10T00:00:00.000Z");
/** Pages of 4 KiB in one MiB. */
const PAGES_PER_MIB = 256;

interface CoreAt {
  /** File refaults over the 300 s beat, MiB. */
  refaultMib: number | "unknown";
  highMib?: number;
  highEvents?: number;
}

/** One heartbeat payload shaped like the fleet host on 2026-10-10: core at 95% of its 8820 MiB memory.max. */
function beat(tsMs: number, core: CoreAt): string {
  const refault = core.refaultMib === "unknown" ? "unknown" : String(core.refaultMib * PAGES_PER_MIB);
  return [
    `beat_ts=${new Date(tsMs).toISOString().replace(/\.\d+Z$/, "Z")}`,
    "root_fs_device=/dev/root",
    "root_fs_free_kb=7000000",
    "mem_containers=remudero-daemon,remudero-console-daemon",
    "mem_interval_s=300",
    `mem_remudero-daemon_high_mib=${core.highMib ?? 8379}`,
    "mem_remudero-daemon_max_mib=8820",
    "mem_remudero-daemon_current_mib=5690",
    "mem_remudero-daemon_anon_mib=4146",
    "mem_remudero-daemon_file_mib=1000",
    "mem_remudero-daemon_policy_high_mib=8192",
    "mem_remudero-daemon_policy_source=tuned_state",
    `mem_remudero-daemon_high_events_delta=${core.highEvents ?? 300}`,
    `mem_remudero-daemon_refault_file_pages_delta=${refault}`,
    "mem_remudero-daemon_tuner_action=grow",
    "mem_remudero-daemon_tuner_ts=2026-10-09T23:34:01Z",
    "mem_remudero-daemon_tuner_reason=174611 high events and 10132 MiB of file refaults per 5 min",
    // Console: far below any ceiling and refaulting hard — the tuner's to grow, never this tier's.
    "mem_remudero-console-daemon_high_mib=2560",
    "mem_remudero-console-daemon_max_mib=8820",
    "mem_remudero-console-daemon_file_mib=200",
    "mem_remudero-console-daemon_high_events_delta=500",
    `mem_remudero-console-daemon_refault_file_pages_delta=${900 * PAGES_PER_MIB}`,
    "mem_remudero-console-daemon_tuner_action=none",
  ].join("\n") + "\n";
}

interface Driven {
  escalations: Escalation[];
  handoffs: IncidentHandoff[];
  steps: Array<{ step: string; extra?: Record<string, unknown> }>;
}

/** Feed the gardener one beat every 5 minutes, as the host cron does, running a pass after each. */
function drive(coreAt: (minute: number) => CoreAt, minutes: number): Driven {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-mem-`));
  const out: Driven = { escalations: [], handoffs: [], steps: [] };
  try {
    for (let m = 0; m <= minutes; m += 5) {
      const now = START + m * MIN;
      const reads: HeartbeatRead[] = [{ host: "azure", payload: beat(now, coreAt(m)) }];
      const ports: HostResourcePorts = {
        stateDir: dir,
        clock: fixedClock(now + 30_000),
        log: (step, extra) => out.steps.push({ step, ...(extra ? { extra } : {}) }),
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

const named = (run: Driven, step: string) => run.steps.filter((s) => s.step === step);

test("a heartbeat's mem_ keys become a per-container reading; unknown stays absent, never 0", () => {
  const reading = memoryFromPayload(parseHeartbeatPayload(beat(START, { refaultMib: 800 })));
  assert.deepEqual(reading?.["remudero-daemon"], {
    highMib: 8379,
    maxMib: 8820,
    policyHighMib: 8192,
    fileMib: 1000,
    highEvents: 300,
    refaultFilePages: 800 * PAGES_PER_MIB,
    intervalS: 300,
    tunerAction: "grow",
  });
  const blind = memoryFromPayload(parseHeartbeatPayload(beat(START, { refaultMib: "unknown" })));
  assert.equal(blind?.["remudero-daemon"]?.refaultFilePages, undefined);
  assert.ok(sampleFromPayload("azure", parseHeartbeatPayload(beat(START, { refaultMib: 800 })))?.memory?.["remudero-daemon"], "the sample keeps it");
});

test("a container pinned at its ceiling that keeps refaulting for an hour is recorded, then handed to SRE once, and recovers", () => {
  // 80% of its page cache re-read every 5 minutes for two hours, then the squeeze stops.
  const run = drive((m) => ({ refaultMib: m <= 120 ? 800 : 0 }), 240);
  const pinned = named(run, "host_resource.memory_pinned");
  assert.ok(pinned.length >= 1);
  assert.equal(pinned[0]!.extra?.["container"], "remudero-daemon");
  assert.equal(run.handoffs.length, 1, "one SRE handoff per episode, not one per beat");
  const h = run.handoffs[0]!;
  assert.match(h.raw, /^host-mem:azure:remudero-daemon/);
  assert.match(h.raw, /memory\.high 8379 MiB \(policy 8192 MiB\) is pinned at 95% of its 8820 MiB memory\.max/);
  assert.match(h.raw, /refaulted a median 800 MiB per 5 min — churn 80% of its 1000 MiB page cache/);
  assert.match(h.origin, /^incident#[0-9a-f]{64}$/);
  assert.equal(run.escalations.length, 0, "this tier hands off to SRE; it never escalates or blocks");
  assert.equal(named(run, "host_resource.memory_pinned_recovered").length, 1, "the episode ends once the refaults stop");
  assert.ok(!run.steps.some((s) => s.extra?.["container"] === "remudero-console-daemon"), "a container under its ceiling is the tuner's to grow");
});

test("light churn is recorded only, and a burst, an unpinned container or an unmeasured beat earns nothing", () => {
  const light = drive(() => ({ refaultMib: 150 }), 90);
  assert.equal(named(light, "host_resource.memory_pinned")[0]?.extra?.["tier"], "record");
  assert.equal(light.handoffs.length, 0, "15% churn for an hour is recorded, not handed off");
  assert.equal(drive((m) => ({ refaultMib: m >= 30 && m <= 45 ? 1000 : 0 }), 180).steps.some((s) => s.step === "host_resource.memory_pinned"), false, "a 15-minute burst is not sustained");
  assert.equal(drive(() => ({ refaultMib: 800, highMib: 8192 }), 120).handoffs.length, 0, "below the ceiling the tuner still has room");
  assert.equal(drive(() => ({ refaultMib: 800, highEvents: 0 }), 120).handoffs.length, 0, "never throttled at memory.high: not a squeeze");
  assert.equal(drive(() => ({ refaultMib: "unknown" }), 120).steps.some((s) => s.step === "host_resource.memory_pinned"), false, "unknown is never read as churn");
});

test("a stale heartbeat produces no memory finding", () => {
  const samples = Array.from({ length: 13 }, (_, i) => sampleFromPayload("azure", parseHeartbeatPayload(beat(START + i * 5 * MIN, { refaultMib: 800 })))!);
  assert.deepEqual(evaluateMemory("azure", samples, START + 61 * MIN).map((f) => [f.container, f.tier]), [["remudero-daemon", "projected"]]);
  assert.deepEqual(evaluateMemory("azure", samples, START + 6 * 60 * MIN), [], "a squeeze read hours ago describes the past");
});
