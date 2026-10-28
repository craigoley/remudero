/**
 * W1-T9542: a planned serve handoff is sized by the OVERLAP it takes (both generations resident from the fork until
 * the old one exits), measured by src/lib/serve-supervisor.ts on each completed handoff, times HANDOFF_NEED_MARGIN;
 * before one is measured, by the boot peak sampled at promotion times the same margin. The active generation's
 * lifetime high-water mark is ledgered, never the need. The cgroup's headroom is read below memory.high.
 *
 * The falsifiers: price the handoff by the active generation's lifetime peak again, and the first test's 5 000-byte
 * peak against 3 000 free defers although its 1 500 overlap fits; read memory.max alone again, and the third test's
 * cgroup reads free above its soft limit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cgroupFreeMemory,
  cgroupSoftFreeMemory,
  createServeSupervisor,
  HANDOFF_NEED_MARGIN,
  type GenerationProcess,
  type PreparedSlot,
  type ServeSupervisorOptions,
} from "#src/lib/serve-supervisor.js";
import type { GenerationMessage } from "#src/lib/serve-generation.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

/** Waits at or past this many milliseconds (a memory retry, the drain backstop) never end; shorter ones end at once. */
const NEVER_MS = 60_000;
const RESERVE = 1_000;

interface Fake extends GenerationProcess {
  alive: boolean;
  slot: PreparedSlot;
  sent: GenerationMessage[];
}

function harness(extra: Partial<ServeSupervisorOptions> & { free?: (alive: number) => number | undefined; available?: number }) {
  const generations: Fake[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const spawn: ServeSupervisorOptions["spawn"] = (command) => {
    const slot = JSON.parse(command.args[0]) as PreparedSlot;
    const messages: Array<(m: GenerationMessage) => void> = [];
    const exits: Array<(c: number | null, s: string | null) => void> = [];
    const die = (code: number | null): void => {
      if (!gen.alive) return;
      gen.alive = false;
      exits.forEach((l) => l(code, null));
    };
    const gen: Fake = {
      pid: generations.length + 1,
      alive: true,
      slot,
      sent: [],
      send(message) {
        gen.sent.push(message);
        if (message.type === "rmd.promote") queueMicrotask(() => messages.forEach((l) => l({ type: "rmd.promoted" })));
        if (message.type === "rmd.drain") queueMicrotask(() => die(0));
      },
      onMessage: (l) => void messages.push(l),
      onExit: (l) => void exits.push(l),
      kill: () => die(null),
    };
    generations.push(gen);
    return gen;
  };
  const get: ServeSupervisorOptions["get"] = async (socketPath, path) => {
    const gen = generations[Number(socketPath.split("/").pop()) - 1];
    if (path.startsWith("/v1/ready")) return { status: 200, body: JSON.stringify({ ready: true, criteria: [{ name: "read_model_warm", ok: true }] }) };
    if (path === "/v1/version") return { status: 200, body: JSON.stringify({ sha: gen?.slot.sha }) };
    return { status: 200, body: "{}" };
  };
  let sha = 1;
  const alive = (): number => generations.filter((g) => g.alive).length;
  const { free, available, ...options } = extra;
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async (activeDir) => ({ dir: activeDir === "/slot-a" ? "/slot-b" : "/slot-a", sha: `sha-${++sha}` }),
    spawn,
    get,
    command: (slot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }),
    log: (step, row) => logs.push({ step, extra: row }),
    exit: () => {},
    sleep: (ms) => (ms >= NEVER_MS ? new Promise<void>(() => {}) : Promise.resolve()),
    pollMs: 1,
    drainBackstopMs: NEVER_MS,
    deferMs: NEVER_MS,
    shedBackstopMs: 7,
    rss: () => undefined,
    socketPathFor: (n) => `/sock/${n}`,
    hostPressure: async () => ({ memAvailableBytes: available ?? 64 * 1024 ** 3, swapInPagesPerSec: 0, psiSomeAvg10: 0, psiFullAvg10: 0, unread: [], atMs: Date.now() }),
    upgradeThresholds: () => ({ hostReserveBytes: RESERVE, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10, psiFullAvg10Max: 2, staleMs: 600_000 }),
    ...(free ? { freeMemory: () => free(alive()) } : {}),
    ...options,
  });
  const rows = (step: string): Array<Record<string, unknown> | undefined> => logs.filter((l) => l.step === step).map((l) => l.extra);
  return { supervisor, generations, logs, rows };
}

test("W1-T9542: a handoff is sized by its measured overlap, not the lifetime peak", async () => {
  // 3 000 free with one generation resident; a standby beside it takes 1 500 until the old one exits.
  // The cold generation's boot peak is 1 000; every later generation's lifetime high-water mark is 5 000.
  const h = harness({ free: (alive) => 3_000 - Math.max(0, alive - 1) * 1_500, peakRss: (pid) => (pid === 1 ? 1_000 : 5_000), available: 4_000 });
  await h.supervisor.start();
  await h.supervisor.requestHandoff();
  const first = h.rows("serve.handoff_admitted")[0];
  assert.deepEqual(
    { basis: first?.needBasis, need: first?.candidateNeedBytes },
    { basis: "boot_peak", need: 1_000 * HANDOFF_NEED_MARGIN },
    "positive control: before any overlap is measured, the cold generation's boot peak prices the first handoff",
  );
  const done = h.rows("serve.handoff_done")[0];
  assert.equal(done?.overlapPeakBytes, 1_500, "the overlap is the pre-fork free less the lowest free before the old generation exited");
  assert.ok(Number(done?.overlapSamples) >= 3, `sampled at the fork, each readiness poll, promote and after the drain (${String(done?.overlapSamples)})`);
  assert.equal(h.supervisor.activeSha(), "sha-2");

  // The active generation now reads a 5 000 lifetime peak against 3 000 free: the measured overlap prices it.
  await h.supervisor.requestHandoff();
  assert.equal(h.rows("serve.handoff_deferred").length, 0, "nothing defers: the lifetime peak is not the need");
  const second = h.rows("serve.handoff_admitted")[1];
  assert.deepEqual(
    { basis: second?.needBasis, need: second?.candidateNeedBytes, overlap: second?.overlapPeakBytes, lifetime: second?.activePeakBytes, free: second?.freeBytes, margin: second?.needMargin },
    { basis: "measured_overlap", need: 1_500 * HANDOFF_NEED_MARGIN, overlap: 1_500, lifetime: 5_000, free: 3_000, margin: HANDOFF_NEED_MARGIN },
    "the overlap times the margin is the need, the lifetime peak stays ledgered as evidence",
  );
  assert.match(String(second?.peakBasis), /largest measured overlap 1500 B \(the handoff to generation 2\)/);
  assert.equal(second?.needBytes, RESERVE + 1_500 * HANDOFF_NEED_MARGIN, "the host admission is judged on the same need, over its reserve");
  assert.equal(h.supervisor.activeSha(), "sha-3", "admitted and handed off");
  assert.equal(h.generations[1].sent.some((m) => m.type === "rmd.shed"), false, "it fit without asking the active generation to shed");
});

test("W1-T9542: with no overlap observed the need falls back to the boot peak", async () => {
  // No usable free reading: no overlap is measured, and none is recorded as a zero.
  const blind = harness({ freeMemory: () => undefined, peakRss: () => 1_000 });
  await blind.supervisor.start();
  await blind.supervisor.requestHandoff();
  await blind.supervisor.requestHandoff();
  const blindDone = blind.rows("serve.handoff_done");
  assert.equal(blindDone.length, 2, "positive control: both handoffs completed");
  assert.deepEqual(blindDone.map((r) => [r?.overlapPeakBytes, r?.overlapSamples]), [[undefined, 0], [undefined, 0]], "a handoff with no usable sample records no overlap");
  assert.deepEqual(
    blind.rows("serve.handoff_admitted").map((r) => [r?.needBasis, r?.candidateNeedBytes]),
    [["boot_peak", 1_000 * HANDOFF_NEED_MARGIN], ["boot_peak", 1_000 * HANDOFF_NEED_MARGIN]],
    "with no overlap measured, the boot peak sampled at promotion times the margin is the need",
  );
  assert.match(String(blind.rows("serve.handoff_admitted")[0]?.peakBasis), /generation 1 boot peak 1000 B \(sampled at promotion\) x 1\.5; no overlap measured yet/);

  // A window whose free never fell measures no positive overlap; it is ledgered, and it never sizes the need.
  const flat = harness({ free: () => 3_000, peakRss: () => 1_000 });
  await flat.supervisor.start();
  await flat.supervisor.requestHandoff();
  await flat.supervisor.requestHandoff();
  assert.equal(flat.rows("serve.handoff_done")[0]?.overlapPeakBytes, 0);
  assert.equal(flat.rows("serve.handoff_admitted")[1]?.needBasis, "boot_peak", "a zero overlap does not price a handoff at zero");

  // Neither an overlap nor a boot peak: the named peak_unknown hold, and no standby.
  const unknown = harness({ freeMemory: () => undefined, peakRss: () => undefined });
  await unknown.supervisor.start();
  await unknown.supervisor.requestHandoff();
  const hold = unknown.rows("serve.handoff_deferred")[0];
  assert.deepEqual({ hold: hold?.hold, basis: hold?.needBasis, need: hold?.needBytes }, { hold: "peak_unknown", basis: "unknown", need: undefined });
  assert.match(String(hold?.detail), /no handoff overlap was measured and no generation's boot peak was readable/);
  assert.equal(unknown.generations.length, 1, "nothing was forked");
  await unknown.supervisor.shutdown("test");
});

test("W1-T9542: container headroom is judged against the soft limit", async () => {
  // The live cgroup of 2026-10-14: memory.max 8 053 063 680, memory.high 5 905 580 032 (5632 MiB).
  const MAX = 8_053_063_680;
  const HIGH = 5_905_580_032;
  const CURRENT = 4_960_000_000;
  const CLEAN = 1_000_000_000;
  const stat = `anon 3900000000\nfile ${CLEAN + 30_000_000}\nshmem 10000000\nfile_dirty 15000000\nfile_writeback 5000000\n`;
  const cgroup = (high: string | undefined, max = String(MAX)) => (path: string): string => {
    const files: Record<string, string | undefined> = { "memory.max": `${max}\n`, "memory.high": high === undefined ? undefined : `${high}\n`, "memory.current": `${CURRENT}\n`, "memory.stat": stat };
    const text = files[path.split("/").pop() ?? ""];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return text;
  };
  const held = CURRENT - CLEAN;
  assert.equal(cgroupSoftFreeMemory(cgroup(String(HIGH)), "/cg"), HIGH - held, "memory.high below memory.max is the ceiling");
  assert.equal(cgroupFreeMemory(cgroup(String(HIGH)), "/cg"), MAX - held, "positive control: serve.memory's reader still reads memory.max");
  assert.ok(cgroupSoftFreeMemory(cgroup(String(HIGH)), "/cg")! < cgroupFreeMemory(cgroup(String(HIGH)), "/cg")!);
  assert.equal(cgroupSoftFreeMemory(cgroup("max"), "/cg"), MAX - held, "memory.high `max` leaves memory.max the ceiling");
  assert.equal(cgroupSoftFreeMemory(cgroup(undefined), "/cg"), MAX - held, "an unreadable memory.high leaves memory.max the ceiling");
  assert.equal(cgroupSoftFreeMemory(cgroup(String(MAX + 1)), "/cg"), MAX - held, "a memory.high above memory.max never raises the ceiling");
  assert.equal(cgroupSoftFreeMemory(cgroup(String(HIGH), "max"), "/cg"), HIGH - held, "an unbounded memory.max leaves memory.high the ceiling");
  assert.equal(cgroupSoftFreeMemory(cgroup("max", "max"), "/cg"), undefined, "neither bounded: headroom is not measurable");
  assert.equal(cgroupSoftFreeMemory(() => { throw new Error("EACCES"); }, "/cg"), undefined, "no cgroup v2: nothing to judge");

  // The real default reader, against real-shaped files on disk.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}cg-9542-`));
  for (const name of ["memory.max", "memory.high", "memory.current", "memory.stat"]) writeFileSync(join(root, name), cgroup(String(HIGH))(join(root, name)));
  assert.equal(cgroupSoftFreeMemory(undefined, root), HIGH - held, "the default reader reads the soft limit from disk");
  writeFileSync(join(root, "memory.high"), "max\n");
  assert.equal(cgroupSoftFreeMemory(undefined, root), MAX - held);

  // The supervisor judges with it by default: a handoff with no injected reader still reaches a decision.
  const h = harness({ peakRss: () => 1_000 });
  await h.supervisor.start();
  await h.supervisor.requestHandoff();
  assert.ok(h.logs.some((l) => l.step === "serve.handoff_done" || l.step === "serve.handoff_deferred"), "the default reader answered a handoff decision");
  await h.supervisor.shutdown("test");
});
