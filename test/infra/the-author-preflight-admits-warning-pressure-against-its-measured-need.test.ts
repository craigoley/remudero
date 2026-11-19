// W1-T10926: the Mac author preflight WAITS out memory pressure instead of refusing on the first warning flag.
// 53 author runs on this Mac (11-15..11-18) were refused `Mac author capacity NOT_RUN ... pressure:warning` while disk
// had room. A measured stage now starts only when free+inactive memory covers its measured peak (plus the focused
// reserve under a warning), waits at the focused sampling interval while it does not, and refuses only past a limit
// derived from that stage's own past waits, naming every sample. A disk shortfall still refuses at once.
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore the executable .mjs module has no declaration file.
import * as admissionModule from "#scripts/lib/mac-author-admission.mjs";

type Sample = { at: number; pressure: string; pageBytes: number; freePlusInactiveBytesApprox: number; swapins: number;
  swapouts: number; swapFreeBytes: number };
type Need = { row: string; workers: number; peakBytes: number; swapGrowthBytes: number };
type PressureWait = { outcome: string; waitedMs: number; limitMs: number; limitBasis: string; pastWaits: number;
  failedChecks: string[]; samples: { atMs: number; pressure: string; freePlusInactiveBytes: number; swapFreeBytes: number | null }[] };
type Admission = { state: string; reasons: string[]; pressure?: string; admittedUnder?: string; memoryNeed?: Need;
  pressureWait?: PressureWait; platform?: string };
type Memory = { sample: () => Sample; wait: (ms: number) => void; now: () => number; pastWaits: (stage: string) => number[] };
type ReadAdmission = (root: string, options?: object) => Admission;
const admission = admissionModule as unknown as {
  MAC_AUTHOR_MEASURED_MEMORY_BYTES: Record<string, { peakBytes: number; swapGrowthBytes: number }>;
  MAC_FOCUSED_LIMITS: { sampleIntervalMs: number; sampleCount: number; maximumSampleSpanMs: number; reserveBytes: number;
    memoryBudgetBytes: number };
  MacAuthorCapacityRefusal: new (stage: string, admission: object) => Error & { stage: string; admission: Admission };
  readMacAuthorAdmission: (root: string, options?: object) => Admission;
  requireMacAuthorCapacity: (root: string, stage: string, read: ReadAdmission, workload?: object, memory?: Memory | null) => Admission;
  guardedAuthorEntry: (argv: string[], options: { root: string; readAdmission: ReadAdmission; memory?: Memory | null;
    runAuthor: (argv: string[], deps?: { admitHost: (stage: string, workload?: object) => Admission }) => number;
    reportRefusal?: (root: string, admission: Admission) => void; recordEntry?: (admission: Admission) => void }) => number;
  macAuthorMemoryNeed: (workload: object) => Need | null;
  judgeMacAuthorMemory: (need: Need, samples: Sample[]) => { admit: boolean; under: string; reasons: string[] };
  macPressureWaitLimit: (pastWaits: number[]) => { limitMs: number; basis: string; pastWaits: number; p90Ms?: number };
  macAuthorMemorySeams: (options?: object) => Memory;
  readMacMemorySample: (options?: object) => Sample & { swapUsedBytes: number };
  parseMacSwapUsage: (text: string) => { swapTotalBytes: number; swapUsedBytes: number; swapFreeBytes: number };
  macAuthorRefusalReport: (stage: string, admission: object) => { lines: string[] };
};

const GiB = 1024 ** 3;
const LIMITS = admission.MAC_FOCUSED_LIMITS;
const STATIC = { selection: "affected-narrow", workers: 1 };
// Before W1-T10926 there is no measured table: the entry case of the first warning test then fails on the refusal itself.
const NEED = (admission.macAuthorMemoryNeed?.({ stage: "static-preflight", ...STATIC }) ??
  { row: "unmeasured", workers: 1, peakBytes: 0, swapGrowthBytes: 0 }) as Need;
const WARNING_HEADROOM = NEED.peakBytes + LIMITS.reserveBytes;

/** A darwin host with ample disk (or `free` bytes) whose pressure flag reads `flag()` on every native read. */
const host = (flag: () => string, free = 30 * GiB): ReadAdmission => (root, options = {}) =>
  admission.readMacAuthorAdmission(root, { ...options, platform: "darwin", scratch: "/scratch",
    statfs: () => ({ bavail: free, bsize: 1 }), spawn: () => ({ status: 0, stdout: `${flag()}\n` }) });
const FLAG: Record<string, string> = { normal: "1", warning: "2", critical: "4", unknown: "9" };

/** A replayed memory trace on a fake clock: sample i is trace[min(i, last)], stamped at the clock's time. */
function replay(trace: Partial<Sample>[], history: number[] = []) {
  let time = 0, taken = 0;
  const memory: Memory = {
    now: () => time,
    wait: (ms) => { time += ms; },
    pastWaits: () => history,
    sample: () => {
      const row = trace[Math.min(taken++, trace.length - 1)];
      return { pageBytes: 16384, swapins: 100, swapouts: 200, swapFreeBytes: 4 * GiB, freePlusInactiveBytesApprox: 8 * GiB,
        pressure: "normal", ...row, at: time };
    },
  };
  const flag = () => FLAG[trace[Math.min(Math.max(taken - 1, 0), trace.length - 1)].pressure ?? "normal"];
  return { memory, flag, taken: () => taken, time: () => time };
}

/** The refusal `fn` throws, or a failed assertion when it admits. */
function refusalOf(fn: () => unknown): Admission {
  try { fn(); } catch (error) {
    assert.ok(error instanceof admission.MacAuthorCapacityRefusal, String(error));
    return (error as unknown as { admission: Admission }).admission;
  }
  return assert.fail("the stage was admitted");
}

test("W1-T10926: the measured memory table prices every stage it names and nothing else", () => {
  for (const [row, measured] of Object.entries(admission.MAC_AUTHOR_MEASURED_MEMORY_BYTES)) {
    assert.ok(Number.isSafeInteger(measured.peakBytes) && measured.peakBytes > 0, `${row} has a measured peak`);
    assert.ok(Number.isSafeInteger(measured.swapGrowthBytes) && measured.swapGrowthBytes >= 0, `${row} has a measured swap growth`);
  }
  assert.equal(admission.macAuthorMemoryNeed({ stage: "entry" })?.row, "entry");
  assert.deepEqual(admission.macAuthorMemoryNeed({ stage: "affected-tests", selection: "plan-only", workers: 3 }), {
    row: "affected-tests-per-worker", workers: 3,
    peakBytes: 3 * admission.MAC_AUTHOR_MEASURED_MEMORY_BYTES["affected-tests-per-worker"].peakBytes,
    swapGrowthBytes: 3 * admission.MAC_AUTHOR_MEASURED_MEMORY_BYTES["affected-tests-per-worker"].swapGrowthBytes });
  for (const workload of [{ stage: "static-preflight", selection: "full-fallback" }, { stage: "affected-tests", selection: "affected-narrow" },
    { stage: "static-preflight", selection: "over-capacity" }, { stage: "a-stage-nobody-measured", selection: "plan-only" }, {}])
    assert.equal(admission.macAuthorMemoryNeed(workload), null, JSON.stringify(workload));
});

test("W1-T10926: warning pressure is admitted when headroom and swap cover the measured need", () => {
  // The entry stage under a warning with room to spare: it waits one sampled window, and the author run starts.
  const entry = replay([{ pressure: "warning", freePlusInactiveBytesApprox: 16 * GiB }]);
  let started = 0, recorded: Admission | undefined;
  assert.equal(admission.guardedAuthorEntry([], { root: "/w", readAdmission: host(entry.flag), memory: entry.memory,
    reportRefusal: () => {}, recordEntry: (settled) => { recorded = settled; }, runAuthor: () => { started++; return 0; } }), 0,
  "a warning with measured room is waited out, not refused");
  assert.equal(started, 1);
  assert.equal(recorded?.pressureWait?.outcome, "admitted");
  // The static stage, priced at exactly its measured peak plus the focused reserve.
  const run = replay([{ pressure: "warning", freePlusInactiveBytesApprox: WARNING_HEADROOM }]);
  const admitted = admission.requireMacAuthorCapacity("/w", "static-preflight", host(run.flag), STATIC, run.memory);
  assert.equal(admitted.state, "admitted", JSON.stringify(admitted));
  assert.equal(admitted.admittedUnder, "warning");
  assert.equal(run.taken(), LIMITS.sampleCount, "the focused sampled window: three samples, five seconds apart");
  assert.equal(admitted.pressureWait?.outcome, "admitted");
  assert.equal(admitted.pressureWait?.waitedMs, (LIMITS.sampleCount - 1) * LIMITS.sampleIntervalMs);
  assert.deepEqual(admitted.memoryNeed, NEED);
});

test("W1-T10926: a warning is priced at the stage's measured need, never the focused 1 GiB budget", () => {
  const focusedHeadroom = LIMITS.memoryBudgetBytes + LIMITS.reserveBytes;
  assert.ok(WARNING_HEADROOM > focusedHeadroom, "the static stage's measured need exceeds the focused budget");
  const run = replay([{ pressure: "warning", freePlusInactiveBytesApprox: WARNING_HEADROOM - 1 }]);
  const refused = refusalOf(() => admission.requireMacAuthorCapacity("/w", "static-preflight", host(run.flag), STATIC, run.memory));
  assert.ok(refused.reasons.includes("memory:below-measured-peak-and-reserve"), JSON.stringify(refused.reasons));
});

test("W1-T10926: normal pressure with swap nearly exhausted is refused", () => {
  // The low-swap jetsam condition: the kernel flag reads normal while free swap cannot take the stage's measured growth.
  // The entry stage's census full pass grew swap when it was measured, so its row prices swap.
  const entry = admission.macAuthorMemoryNeed({ stage: "entry" }) as Need;
  assert.ok(entry.swapGrowthBytes > 0, "the entry stage's measured swap growth");
  const at = (swapFreeBytes: number) => {
    const run = replay([{ pressure: "normal", freePlusInactiveBytesApprox: 16 * GiB, swapFreeBytes }]);
    let reported: Admission | undefined;
    const status = admission.guardedAuthorEntry([], { root: "/w", readAdmission: host(run.flag), memory: run.memory,
      reportRefusal: (_root, settled) => { reported = settled; }, runAuthor: () => 0 });
    return { status, reported };
  };
  const exhausted = at(entry.swapGrowthBytes - 1);
  assert.equal(exhausted.status, 3);
  assert.deepEqual(exhausted.reported?.reasons, ["swap:below-measured-growth"]);
  assert.equal(exhausted.reported?.pressureWait?.outcome, "refused");
  assert.equal(at(entry.swapGrowthBytes).status, 0, "exactly the measured growth free is enough");
});

test("W1-T10926: critical, unknown, new swap-out or unmeasured selection still refuse", () => {
  for (const pressure of ["critical", "unknown"]) {
    const run = replay([{ pressure, freePlusInactiveBytesApprox: 16 * GiB }]);
    const refused = refusalOf(() => admission.requireMacAuthorCapacity("/w", "static-preflight", host(run.flag), STATIC, run.memory));
    assert.ok(refused.reasons.includes(`pressure:${pressure}`), JSON.stringify(refused.reasons));
    assert.deepEqual(refused.pressureWait?.failedChecks, [`pressure:${pressure}`]);
    assert.ok(run.time() >= LIMITS.maximumSampleSpanMs, "it waited its whole limit first");
  }
  // A warning window that swaps out on every interval never starts.
  let swapouts = 200;
  const paging = replay([{ pressure: "warning", freePlusInactiveBytesApprox: 16 * GiB }]);
  const sample = paging.memory.sample;
  paging.memory.sample = () => ({ ...sample(), swapouts: swapouts++ });
  const swapped = refusalOf(() => admission.requireMacAuthorCapacity("/w", "static-preflight", host(paging.flag), STATIC, paging.memory));
  assert.ok(swapped.reasons.includes("paging:new-swap-out"), JSON.stringify(swapped.reasons));
  // An unmeasured selection keeps the normal-only rule: refused on the first read, no sample taken.
  const unmeasured = replay([{ pressure: "warning", freePlusInactiveBytesApprox: 16 * GiB }]);
  const full = refusalOf(() => admission.requireMacAuthorCapacity("/w", "static-preflight", host(() => "2"),
    { selection: "full-fallback", workers: 1 }, unmeasured.memory));
  assert.deepEqual(full.reasons, ["pressure:warning"]);
  assert.equal(unmeasured.taken(), 0);
  assert.equal(full.pressureWait, undefined);
  // A sample that cannot be read refuses at once and names why.
  const broken = replay([{ pressure: "warning" }]);
  broken.memory.sample = () => { throw new Error("vm_stat unreadable"); };
  const unreadable = refusalOf(() => admission.requireMacAuthorCapacity("/w", "static-preflight", host(() => "2"), STATIC, broken.memory));
  assert.deepEqual(unreadable.reasons, ["pressure:warning", "memory-sample:unavailable:vm_stat unreadable"]);
});

test("W1-T10926: pressure held critical refuses past its limit and names every sample", () => {
  const run = replay([{ pressure: "critical", freePlusInactiveBytesApprox: 2 * GiB, swapFreeBytes: GiB }]);
  const refused = refusalOf(() => admission.requireMacAuthorCapacity("/w", "static-preflight", host(run.flag), STATIC, run.memory));
  const waited = refused.pressureWait as PressureWait;
  assert.equal(waited.limitBasis, "focused-sampling-span");
  assert.equal(waited.limitMs, LIMITS.maximumSampleSpanMs);
  assert.equal(waited.samples.length, LIMITS.maximumSampleSpanMs / LIMITS.sampleIntervalMs + 1);
  assert.equal(waited.samples.length, run.taken());
  assert.deepEqual(waited.samples.map((row) => row.atMs), waited.samples.map((_, i) => i * LIMITS.sampleIntervalMs));
  assert.ok(waited.samples.every((row) => row.pressure === "critical" && row.freePlusInactiveBytes === 2 * GiB && row.swapFreeBytes === GiB));
  // The operator reads the wait in the refusal itself.
  const { lines } = admission.macAuthorRefusalReport("static-preflight", refused);
  assert.ok(lines.some((line) => line.startsWith(`Memory wait: ${LIMITS.maximumSampleSpanMs} ms of a ${LIMITS.maximumSampleSpanMs} ms limit`) &&
    line.includes(`${waited.samples.length} samples`) && line.includes("pressure:critical")), lines.join("\n"));
  // At entry the refusal is reported with its samples and no author work starts.
  const entry = replay([{ pressure: "critical" }]);
  let reported: Admission | undefined, started = 0;
  assert.equal(admission.guardedAuthorEntry([], { root: "/w", readAdmission: host(entry.flag), memory: entry.memory,
    reportRefusal: (_root, settled) => { reported = settled; }, runAuthor: () => { started++; return 0; } }), 3);
  assert.equal(started, 0);
  assert.equal(reported?.pressureWait?.samples.length, entry.taken());
});

test("W1-T10926: a replayed warning-to-normal trace within the wait limit completes", () => {
  const short = { pressure: "warning", freePlusInactiveBytesApprox: GiB };
  const run = replay([short, short, short, { pressure: "normal", freePlusInactiveBytesApprox: NEED.peakBytes }]);
  const admitted = admission.requireMacAuthorCapacity("/w", "static-preflight", host(run.flag), STATIC, run.memory);
  assert.equal(admitted.state, "admitted", JSON.stringify(admitted));
  assert.equal(admitted.admittedUnder, "normal");
  assert.equal(admitted.pressureWait?.waitedMs, 3 * LIMITS.sampleIntervalMs);
  assert.ok((admitted.pressureWait?.waitedMs ?? Infinity) < LIMITS.maximumSampleSpanMs);
  assert.deepEqual(admitted.pressureWait?.samples.map((row) => row.pressure), ["warning", "warning", "warning", "normal"]);
});

test("W1-T10926: a measured stage never starts while headroom is below its measured peak", () => {
  const below = replay([{ pressure: "normal", freePlusInactiveBytesApprox: NEED.peakBytes - 1 }]);
  const refused = refusalOf(() => admission.requireMacAuthorCapacity("/w", "static-preflight", host(below.flag), STATIC, below.memory));
  assert.ok(refused.reasons.includes("memory:below-measured-peak"), JSON.stringify(refused.reasons));
  const at = replay([{ pressure: "normal", freePlusInactiveBytesApprox: NEED.peakBytes }]);
  const admitted = admission.requireMacAuthorCapacity("/w", "static-preflight", host(at.flag), STATIC, at.memory);
  assert.equal(admitted.state, "admitted");
  assert.equal(at.taken(), 1, "a normal flag with room starts on its first sample");
  assert.equal(admitted.pressureWait, undefined, "no wait happened, so none is recorded");
  // A fresh read that now says critical keeps it waiting; one that turns normal lets the sampled warning start.
  let reads = 0;
  const flip = replay([{ pressure: "warning", freePlusInactiveBytesApprox: 16 * GiB }]);
  const flips = admission.requireMacAuthorCapacity("/w", "static-preflight", host(() => (++reads === 2 ? "4" : "2")), STATIC, flip.memory);
  assert.equal(flips.state, "admitted");
  assert.equal(flip.taken(), LIMITS.sampleCount + 1, "the critical re-read cost one more sample");
});

test("W1-T10926: a disk shortfall still refuses at once, before any memory sample", () => {
  const run = replay([{ pressure: "warning", freePlusInactiveBytesApprox: 16 * GiB }]);
  const refused = refusalOf(() => admission.requireMacAuthorCapacity("/w", "static-preflight", host(() => "2", GiB), STATIC, run.memory));
  assert.ok(refused.reasons.some((reason) => reason.includes("below-measured-static-preflight-reserve")), JSON.stringify(refused.reasons));
  assert.equal(run.taken(), 0, "no sample was taken");
  assert.equal(run.time(), 0, "no time was waited");
  // A disk that fills while the stage waits refuses on the fresh read, not at the limit.
  let reads = 0;
  const filling = replay([{ pressure: "warning", freePlusInactiveBytesApprox: 16 * GiB }]);
  const read: ReadAdmission = (root, options = {}) => admission.readMacAuthorAdmission(root, { ...options, platform: "darwin",
    scratch: "/scratch", statfs: () => ({ bavail: ++reads > 2 ? GiB : 30 * GiB, bsize: 1 }), spawn: () => ({ status: 0, stdout: "2\n" }) });
  const filled = refusalOf(() => admission.requireMacAuthorCapacity("/w", "static-preflight", read, STATIC, filling.memory));
  assert.deepEqual(filled.reasons.filter((reason) => !reason.startsWith("pressure:")), ["workspaceFreeBytes:below-measured-static-preflight-reserve",
    "scratchFreeBytes:below-measured-static-preflight-reserve"]);
  assert.equal(filling.time(), (LIMITS.sampleCount - 1) * LIMITS.sampleIntervalMs, "refused on that read, not at the wait limit");
  assert.equal(filling.taken(), LIMITS.sampleCount);
  // At entry, a disk shortfall is reported at once and starts nothing.
  const entry = replay([{ pressure: "warning" }]);
  assert.equal(admission.guardedAuthorEntry([], { root: "/w", readAdmission: host(() => "2", GiB), memory: entry.memory,
    reportRefusal: () => {}, runAuthor: () => 0 }), 3);
  assert.equal(entry.taken(), 0);
});

test("W1-T10926: the wait limit is the p90 of the stage's own past waits, else the focused sampling span", () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => n * 7_000);
  assert.deepEqual(admission.macPressureWaitLimit(ten), { limitMs: 63_000, basis: "p90-of-past-waits", pastWaits: 10, p90Ms: 63_000 });
  // The limit follows the history: no number of seconds is fixed in it.
  assert.equal(admission.macPressureWaitLimit(ten.map((ms) => ms * 3)).limitMs, 189_000);
  // Too little history for a p90: the focused sampling rule's own observation span.
  assert.deepEqual(admission.macPressureWaitLimit(ten.slice(1)), { limitMs: LIMITS.maximumSampleSpanMs, basis: "focused-sampling-span",
    pastWaits: 9, needed: 10 });
  assert.equal(admission.macPressureWaitLimit([]).limitMs, LIMITS.maximumSampleSpanMs);
  // Never shorter than one focused window, so a warning can ever be judged.
  assert.equal(admission.macPressureWaitLimit(Array(10).fill(0)).limitMs, (LIMITS.sampleCount - 1) * LIMITS.sampleIntervalMs);
  assert.equal(admission.macPressureWaitLimit([NaN, -1, ...ten]).pastWaits, 10);
  // A stage really waits as long as its history says, and only its own stage's history is asked for.
  const asked: string[] = [];
  const run = replay([{ pressure: "critical" }], ten);
  const pastWaits = run.memory.pastWaits;
  run.memory.pastWaits = (stage) => { asked.push(stage); return pastWaits(stage); };
  const refused = refusalOf(() => admission.requireMacAuthorCapacity("/w", "static-preflight", host(run.flag), STATIC, run.memory));
  assert.deepEqual(asked, ["static-preflight"], "read once, lazily, for this stage");
  assert.equal(refused.pressureWait?.limitMs, 63_000);
  assert.equal(refused.pressureWait?.limitBasis, "p90-of-past-waits");
  assert.equal(run.time(), 65_000, "it sampled at the focused interval until the limit passed");
});

test("W1-T10926: off the Mac nothing samples, and a faked host reading never borrows this host's memory", () => {
  const never: Memory = { sample: () => { throw new Error("sampled off the Mac"); }, wait: () => {}, now: () => 0, pastWaits: () => [] };
  const linux: ReadAdmission = (root, options = {}) => admission.readMacAuthorAdmission(root, { ...options, platform: "linux" });
  assert.equal(admission.requireMacAuthorCapacity("/w", "static-preflight", linux, STATIC, never).state, "not-applicable");
  assert.equal(admission.guardedAuthorEntry([], { root: "/w", readAdmission: linux, memory: never, runAuthor: () => 7 }), 7);
  // No memory seams given with a faked reader: the single read decides, exactly as before this task.
  assert.deepEqual(refusalOf(() => admission.requireMacAuthorCapacity("/w", "static-preflight", host(() => "2"), STATIC)).reasons,
    ["pressure:warning"]);
  assert.deepEqual(refusalOf(() => admission.requireMacAuthorCapacity("/w", "static-preflight", host(() => "2"), STATIC, null)).reasons,
    ["pressure:warning"]);
});

test("W1-T10926: the native memory sample reads vm_stat, the pressure flag and swap usage, bounded", () => {
  const vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 5.\nPages inactive: 7.\nSwapins: 100.\nSwapouts: 200.\n";
  const calls: string[] = [];
  const spawn = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => {
    calls.push([file, ...args].join(" "));
    assert.equal(options.timeout, 2000);
    assert.equal(options.maxBuffer, 4096);
    const stdout = file === "/usr/bin/vm_stat" ? vm : args.includes("vm.swapusage")
      ? "total = 8192.00M  used = 6620.56M  free = 1571.44M  (encrypted)\n" : "2\n";
    return { status: 0, stdout };
  };
  const seams = admission.macAuthorMemorySeams({ spawn, now: () => 42 });
  assert.deepEqual(seams.sample(), { pageBytes: 16384, freePlusInactiveBytesApprox: 12 * 16384, swapins: 100, swapouts: 200,
    pressure: "warning", at: 42, swapFreeBytes: Math.round(1571.44 * 1024 ** 2), swapUsedBytes: Math.round(6620.56 * 1024 ** 2) });
  assert.deepEqual(calls, ["/usr/bin/vm_stat", "/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level", "/usr/sbin/sysctl -n vm.swapusage"]);
  assert.deepEqual(seams.pastWaits("entry"), []);
  assert.equal(seams.now(), 42);
  const before = Date.now();
  seams.wait(5);
  assert.ok(Date.now() - before >= 4, "the default wait really sleeps");
  assert.deepEqual(admission.parseMacSwapUsage("total = 2.00G  used = 512.00K  free = 1.00G  (encrypted)"),
    { swapTotalBytes: 2 * GiB, swapUsedBytes: 512 * 1024, swapFreeBytes: GiB });
  for (const broken of ["", "total = 8192.00M  used = 1.00M", "total = 8192.00M  used = 1.00M  free = 1.00X", "total = 1.00M  used = 1.00M  free = 99999999999999999999T"])
    assert.throws(() => admission.parseMacSwapUsage(broken), /swap field/);
  if (process.platform !== "darwin") return;
  const native = admission.readMacMemorySample();
  assert.ok(Number.isSafeInteger(native.swapFreeBytes) && native.swapFreeBytes >= 0);
  assert.ok(Number.isSafeInteger(native.freePlusInactiveBytesApprox) && native.freePlusInactiveBytesApprox > 0);
  assert.ok(["normal", "warning", "critical"].includes(native.pressure));
});
