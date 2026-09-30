import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { Escalation } from "../src/lib/escalate.js";
import type { GardenCheckout } from "../src/lib/gardener.js";
import {
  consumerShardYaml,
  evaluateHost,
  fileConsumerVia,
  incidentOrigin,
  isPersistentGrower,
  parseHeartbeatPayload,
  projectSeries,
  readSamples,
  runHostResourcePass,
  samplesPath,
  sampleFromPayload,
  startHostResourceGardener,
  tierFor,
  type ConsumerFiling,
  type HostResourcePorts,
  type HostSample,
} from "../src/lib/host-resource-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const GB = 1024 * 1024;

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-resource-`));
}

function payload(over: Record<string, string>): string {
  const base: Record<string, string> = {
    beat_ts: "2026-09-30T11:55:00Z",
    root_fs_device: "/dev/root",
    state_fs_device: "/dev/root",
    root_fs_free_kb: "40000000",
    root_fs_total_kb: "130000000",
    swap_used_kb: "800000",
    swap_total_kb: "29000000",
    root_fs_inodes_free: "7000000",
    janitor_last_ts: "2026-09-30T08:00:00Z",
    janitor_last_freed: "4MB",
  };
  return Object.entries({ ...base, ...over }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

function ports(dir: string, over: Partial<HostResourcePorts> = {}): HostResourcePorts & { rows: Array<{ step: string; extra?: Record<string, unknown> }> } {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { stateDir: dir, clock: fixedClock(NOW), log: (step, extra) => rows.push({ step, extra }), readHeartbeats: () => [], planOrigins: () => [], rows, ...over };
}

/** A host's samples every `stepMin` minutes ending at NOW; free space falls per `freeAt`. */
function history(over: { host?: string; count?: number; stepMin?: number; freeAt: (i: number, n: number) => number; janitorEveryH?: number; consumers?: (i: number) => Record<string, number>; freed?: number; endAgoMs?: number }): HostSample[] {
  const n = over.count ?? 144;
  const step = (over.stepMin ?? 30) * 60_000;
  return Array.from({ length: n }, (_, i) => {
    const tsMs = NOW - (over.endAgoMs ?? 0) - (n - 1 - i) * step;
    const passEvery = (over.janitorEveryH ?? 6) * HOUR;
    const janitorTs = new Date(Math.floor(tsMs / passEvery) * passEvery).toISOString();
    return {
      host: over.host ?? "azure",
      beatTs: new Date(tsMs).toISOString(),
      tsMs,
      values: { root_free_kb: over.freeAt(i, n) },
      consumers: over.consumers?.(i) ?? {},
      janitorTs,
      janitorFreedKb: over.freed ?? 4 * 1024,
    };
  });
}

function seed(dir: string, samples: readonly HostSample[]): void {
  writeFileSync(samplesPath(dir), samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

test("W1-T4804: a heartbeat sample is appended only for a new beat", () => {
  const dir = stateDir();
  try {
    let beats = [{ host: "azure", payload: payload({}) }];
    const p = ports(dir, { readHeartbeats: () => beats });
    assert.equal(runHostResourcePass(p).appended, 1);
    assert.equal(runHostResourcePass(p).appended, 0, "the same beat read again adds nothing");
    beats = [{ host: "azure", payload: payload({ beat_ts: "2026-09-30T11:50:00Z" }) }];
    assert.equal(runHostResourcePass(p).appended, 0, "an older beat is not a new one");
    beats = [{ host: "azure", payload: payload({ beat_ts: "2026-09-30T12:00:00Z", root_fs_free_kb: "39990000" }) }, { host: "mini", payload: payload({ beat_ts: "2026-09-30T11:59:00Z" }) }];
    assert.equal(runHostResourcePass(p).appended, 2, "a newer beat, and another host's first beat, are appended");
    const stored = readSamples(dir);
    assert.deepEqual(stored.map((s) => s.host).sort(), ["azure", "azure", "mini"]);
    assert.equal(stored.find((s) => s.host === "azure" && s.values["root_free_kb"] === 39990000)?.values["swap_used_kb"], 800000);

    // Samples age out by TIME: a beat three weeks old is dropped, a recent one stays whatever the count.
    seed(dir, [...history({ count: 3, freeAt: () => 1, endAgoMs: 21 * 24 * HOUR }), ...history({ count: 3, freeAt: () => 1 })]);
    runHostResourcePass(ports(dir, { readHeartbeats: () => [] }));
    runHostResourcePass(ports(dir, { readHeartbeats: () => [{ host: "azure", payload: payload({ beat_ts: "2026-09-30T12:00:30Z" }) }] }));
    assert.equal(readSamples(dir).length, 4, "the three old samples aged out; three recent and the new beat remain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4804: an unreadable heartbeat field is absent, never zero", () => {
  const s = sampleFromPayload("azure", parseHeartbeatPayload(payload({ swap_used_kb: "unknown", root_fs_inodes_free: "unknown", janitor_last_freed: "unknown", janitor_last_ts: "unknown" })))!;
  assert.equal("swap_used_kb" in s.values, false);
  assert.equal("inodes_free" in s.values, false);
  assert.equal(s.janitorFreedKb, undefined);
  assert.equal(s.janitorTs, undefined);
  assert.equal(sampleFromPayload("x", { beat_ts: "garbage" }), undefined);
  // The state root is a separate device only when it names a different one.
  assert.equal("state_free_kb" in s.values, false);
  const split = sampleFromPayload("azure", parseHeartbeatPayload(payload({ state_fs_device: "/dev/nvme0n2p1", state_fs_free_kb: "9000" })))!;
  assert.equal(split.values["state_free_kb"], 9000);
});

test("W1-T4804: a falling series projects time to full robust to an outlier", () => {
  const RATE = 1000; // kb per hour
  const START = 100_000;
  const points = Array.from({ length: 97 }, (_, i) => ({ x: NOW - (96 - i) * 0.5 * HOUR, y: START - RATE * i * 0.5 }));
  const clean = projectSeries(points)!;
  const trueHours = (START - RATE * 48) / RATE;
  assert.ok(Math.abs(clean.slopePerHour + RATE) < 1, `slope ${clean.slopePerHour}`);
  assert.ok(Math.abs(clean.hoursToFull! - trueHours) < 0.5, `hours ${clean.hoursToFull} vs ${trueHours}`);

  // One sample where a huge file was briefly written (and one where a snapshot freed a lot).
  const noisy = points.map((p, i) => (i === 90 ? { ...p, y: 0 } : i === 30 ? { ...p, y: START * 3 } : p));
  const robust = projectSeries(noisy)!;
  assert.ok(Math.abs(robust.hoursToFull! - trueHours) / trueHours < 0.05, `outlier moved the projection: ${robust.hoursToFull} vs ${trueHours}`);

  // An ordinary least-squares line over the same points is dragged well off — the falsifier.
  const n = noisy.length;
  const mx = noisy.reduce((s, p) => s + p.x, 0) / n;
  const my = noisy.reduce((s, p) => s + p.y, 0) / n;
  const ols = noisy.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / noisy.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const olsHours = noisy[n - 1]!.y / (-ols * HOUR);
  assert.ok(!(olsHours > 0 && Math.abs(olsHours - trueHours) / trueHours < 0.05), `OLS would have been ${olsHours}`);

  // A rising or flat series never projects a time to full.
  assert.equal(projectSeries(points.map((p) => ({ x: p.x, y: 5 })))!.hoursToFull, undefined);
  assert.equal(projectSeries(points.slice(0, 2)), undefined, "two points are not a trend");
});

test("W1-T4804: the tier follows the projection relative to janitor cadence", () => {
  // The SAME 10 h projection is three different tiers on three different cadences.
  assert.equal(tierFor(10, 2), "record");
  assert.equal(tierFor(10, 4), "projected");
  assert.equal(tierFor(10, 12), "escalate");
  assert.equal(tierFor(undefined, 6), undefined);

  // Through the whole pass: a disk with ~20 h left, on hosts whose janitors run every 4, 12 and 24 h.
  const falling = (i: number, n: number): number => 20 * 1000 + (n - 1 - i) * 500 * 1; // 1000 kb/h → 20 h at the end
  const outcome = (janitorEveryH: number) => {
    const dir = stateDir();
    try {
      seed(dir, history({ freeAt: falling, janitorEveryH, count: 240 }));
      const handed: string[] = [];
      const escalated: Escalation[] = [];
      const p = ports(dir, { handoff: (h) => handed.push(h.origin), escalate: (e) => (escalated.push(e), "https://issue/1") });
      const first = runHostResourcePass(p);
      runHostResourcePass(p);
      return { tier: first.findings[0]?.tier, handed, escalated };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const fast = outcome(4);
  assert.equal(fast.tier, "record");
  assert.deepEqual([fast.handed.length, fast.escalated.length], [0, 0], "beyond a few passes it only records");
  const mid = outcome(12);
  assert.equal(mid.tier, "projected");
  assert.deepEqual([mid.handed, mid.escalated.length], [[incidentOrigin("azure", "root")], 0], "inside a few passes it hands the SRE lane ONE incident");
  const slow = outcome(24);
  assert.equal(slow.tier, "escalate");
  assert.equal(slow.escalated.length, 1, "inside one pass it escalates once per episode, though the pass ran twice");
  assert.equal(slow.escalated[0]!.headDedup, "independent");
  assert.equal(slow.handed.length, 1);

  // A heartbeat that went silent while the samples were falling escalates whatever the projection.
  const dir = stateDir();
  try {
    seed(dir, history({ freeAt: (i, n) => 90 * GB + (n - 1 - i) * 1000, endAgoMs: 6 * HOUR, count: 96 }));
    const p = ports(dir, { escalate: () => "https://issue/2" });
    const finding = runHostResourcePass(p).findings[0]!;
    assert.equal(finding.stale, true);
    assert.equal(finding.tier, "escalate");
    assert.ok(finding.projection.hoursToFull! > 3 * finding.cadenceHours, "the projection alone would only have recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // A janitor pass that freed nothing while the series keeps falling is itself a finding.
  const dir2 = stateDir();
  try {
    seed(dir2, history({ freeAt: (i, n) => 500 * GB + (n - 1 - i) * 4000, freed: 0 }));
    const p = ports(dir2);
    runHostResourcePass(p);
    runHostResourcePass(p);
    assert.equal(p.rows.filter((r) => r.step === "host_resource.janitor_ineffective").length, 1);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("W1-T4804: a persistent consumer is attributed and filed once", () => {
  const dir = stateDir();
  try {
    // 72 h, the disk falling 2 GB/h; worktrees grows 1.6 GB/h, state is flat, npm cache grows a little.
    const samples = history({
      count: 144,
      freeAt: (i, n) => 400 * GB + (n - 1 - i) * 1 * GB,
      consumers: (i) => ({ worktrees: 10 * GB + i * 0.8 * GB, state: 3 * GB, npm_cache: 1 * GB + i * 0.01 * GB }),
    });
    seed(dir, samples);
    const finding = evaluateHost("azure", samples, NOW)[0]!;
    assert.equal(finding.attribution?.consumer, "worktrees", "the consumer that explains the fall, not the flat or the tiny one");
    assert.ok(finding.attribution!.share > 0.5 && finding.attribution!.share < 1.5, `share ${finding.attribution!.share}`);

    const filed: ConsumerFiling[] = [];
    const p = ports(dir, { fileConsumer: (f) => (filed.push(f), "https://github.com/x/y/pull/9") });
    runHostResourcePass(p);
    runHostResourcePass(p);
    runHostResourcePass(ports(dir, { fileConsumer: (f) => (filed.push(f), "https://github.com/x/y/pull/10") }));
    assert.equal(filed.length, 1, "filed once across passes, and across a restart of the gardener");
    assert.equal(filed[0]!.origin, "host-resource:azure:worktrees");
    assert.equal(p.rows.filter((r) => r.step === "host_resource.filed").length, 1);

    // A plan that already holds the origin is never filed again, even with no state file.
    rmSync(join(dir, "host-resource-state.json"));
    runHostResourcePass(ports(dir, { planOrigins: () => ["host-resource:azure:worktrees"], fileConsumer: (f) => (filed.push(f), "x") }));
    assert.equal(filed.length, 1);

    // The filed record is a valid, lint-clean, machine-authored task judged by that consumer's growth.
    const yaml = consumerShardYaml(filed[0]!, "W1-T9999");
    assert.match(yaml, /origin: "host-resource:azure:worktrees"/);
    assert.match(yaml, /author_class: machine/);
    assert.match(yaml, /growth rate/);

    // A grower the janitor DID reap (its size falls back) is not attributed.
    const reaped = history({ freeAt: (i, n) => 400 * GB + (n - 1 - i) * GB, consumers: (i) => ({ worktrees: 10 * GB - i * 0.01 * GB }) });
    assert.equal(evaluateHost("azure", reaped, NOW)[0]!.attribution, undefined);

    // One that grew only briefly, across one janitor pass, is not filed.
    const brief = history({ count: 30, freeAt: (i, n) => 400 * GB + (n - 1 - i) * GB, consumers: (i) => ({ worktrees: i * GB }) });
    const briefAttribution = evaluateHost("azure", brief, NOW)[0]?.attribution;
    assert.equal(briefAttribution?.consumer, "worktrees", "it is attributed, being the grower");
    assert.equal(isPersistentGrower(briefAttribution), false, "but a 15 h burst across one or two passes is not persistent");
    assert.equal(isPersistentGrower(finding.attribution), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4804: a torn sample line and an unreadable state file are survived, not fatal", () => {
  const dir = stateDir();
  try {
    const good = history({ count: 2, freeAt: () => 1000 });
    writeFileSync(samplesPath(dir), JSON.stringify(good[0]) + "\n{\"host\":\"azure\",\"tsM\n" + JSON.stringify(good[1]) + "\n");
    assert.equal(readSamples(dir).length, 2, "the torn line is dropped, both whole ones stay");

    writeFileSync(join(dir, "host-resource-state.json"), "{ not json");
    const p = ports(dir);
    assert.equal(runHostResourcePass(p).ran, true, "an unreadable state file restarts the episodes");
    assert.equal(JSON.parse(readFileSync(join(dir, "host-resource-state.json"), "utf8")).filed !== undefined, true, "and is rewritten whole");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4804: a filing lands the shard alone through a checkout, which is always disposed", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-resource-ws-`));
  try {
    const filing: ConsumerFiling = {
      host: "azure",
      device: "root",
      consumer: "worktrees",
      origin: "host-resource:azure:worktrees",
      attribution: { consumer: "worktrees", growthKbPerHour: 0.8 * GB, share: 0.8, spanHours: 72, points: 144, janitorPasses: 12 },
    };
    const landed: Array<{ paths: string[]; title: string; body: string }> = [];
    let disposed = 0;
    const checkout = (branch: string | undefined) => (): GardenCheckout => ({
      root,
      ...(branch ? { branch } : {}),
      land: (opts) => (landed.push(opts), "https://github.com/x/y/pull/11"),
      dispose: () => void disposed++,
    });
    const url = fileConsumerVia(checkout("host-resource-garden-1"), (b) => (assert.equal(b, "host-resource-garden-1"), "W1-T9998"))(filing);
    assert.equal(url, "https://github.com/x/y/pull/11");
    assert.equal(disposed, 1);
    assert.equal(landed.length, 1);
    assert.equal(landed[0]!.paths.length, 1, "the filing PR carries the shard alone");
    const relPath = landed[0]!.paths[0]!;
    assert.match(relPath, /^plan\/tasks\.d\/W1-T9998-host-resource-azure-worktrees.*\.yaml$/);
    assert.match(readFileSync(join(root, relPath), "utf8"), /origin: "host-resource:azure:worktrees"/);
    assert.match(landed[0]!.body, new RegExp(`proof: grep: host-resource:azure:worktrees in ${relPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    // A checkout with no branch cannot reserve a task id: it throws, and is still disposed.
    assert.throws(() => fileConsumerVia(checkout(undefined), () => "W1-T9997")(filing), /no branch/);
    assert.equal(disposed, 2);
    assert.equal(landed.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4804: a pass that throws is logged and the timer survives", () => {
  const dir = stateDir();
  try {
    const p = ports(dir, {
      readHeartbeats: () => {
        throw new Error("fetch failed");
      },
    });
    const handle = startHostResourceGardener(p, 60_000);
    handle.stop();
    const failed = p.rows.filter((r) => r.step === "host_resource.failed");
    assert.equal(failed.length, 1);
    assert.match(String(failed[0]!.extra?.["error"]), /fetch failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4804: the off switch stops the pass and a filing failure retries later, not every pass", () => {
  const dir = stateDir();
  try {
    seed(dir, history({ freeAt: (i, n) => 400 * GB + (n - 1 - i) * GB, consumers: (i) => ({ worktrees: 10 * GB + i * 0.8 * GB }) }));
    let calls = 0;
    const p = ports(dir, { fileConsumer: () => { calls++; throw new Error("no worktree"); } });
    runHostResourcePass(p);
    runHostResourcePass(p);
    assert.equal(calls, 1, "a failed filing waits out its retry window");
    assert.equal(p.rows.filter((r) => r.step === "host_resource.file_failed").length, 1);
    writeFileSync(join(dir, "HOST_RESOURCE_OFF"), "");
    assert.equal(runHostResourcePass(ports(dir, { readHeartbeats: () => { throw new Error("must not read"); } })).ran, false);
    assert.ok(existsSync(join(dir, "HOST_RESOURCE_OFF")));
    assert.match(readFileSync(samplesPath(dir), "utf8"), /"host":"azure"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
