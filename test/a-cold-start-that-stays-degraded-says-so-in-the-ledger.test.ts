/**
 * #8429: a cold start is promoted once it listens and serves degraded until ready. The ledger said so
 * ONCE, at promotion (`serve.cold_start_degraded`), when the board is necessarily still `not_ready`;
 * a stall then wrote nothing until `serve.cold_start_ready`, so a cold start that STAYED degraded,
 * and why, never reached the ledger. These drive src/lib/serve-supervisor.ts with a fake generation,
 * a fake clock and a sleep that advances it: no real time passes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLD_START_STILL_DEGRADED_EVERY_MS,
  STANDBY_READY_BOUND_MS,
  createServeSupervisor,
  type GenerationProcess,
} from "../src/lib/serve-supervisor.js";
import type { Clock } from "../src/lib/clock.js";
import type { GenerationMessage } from "../src/lib/serve-generation.js";

const REASON = "worker_projection_failed: allMerged is not iterable";
const STILL = "serve.cold_start_still_degraded";

type Row = { step: string; extra?: Record<string, unknown> };

/**
 * One cold start whose `/v1/ready` reports the board unavailable (with REASON) until `readyAtMs`,
 * or forever when it is undefined. Resolves once the watch logs `serve.cold_start_ready`, or once
 * the fake clock reaches `horizonMs`, where the sleep parks for good.
 */
async function coldStart(readyAtMs: number | undefined, horizonMs: number): Promise<Row[]> {
  let now = 0;
  const rows: Row[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const sleep = async (ms: number): Promise<void> => {
    if (now >= horizonMs) {
      finish();
      return new Promise<void>(() => {});
    }
    now += ms;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const spawn = (): GenerationProcess => {
    const listeners: Array<(message: GenerationMessage) => void> = [];
    return {
      pid: undefined,
      send: (message) => {
        if (message.type === "rmd.promote") queueMicrotask(() => listeners.forEach((l) => l({ type: "rmd.promoted" })));
      },
      onMessage: (listener) => void listeners.push(listener),
      onExit: () => {},
      kill: () => {},
    };
  };
  const get = async (_socket: string, path: string): Promise<{ status: number; body: string }> => {
    if (path === "/v1/version") return { status: 200, body: JSON.stringify({ sha: "sha-cold" }) };
    if (!path.startsWith("/v1/ready")) return { status: 200, body: "{}" };
    const ready = readyAtMs !== undefined && now >= readyAtMs;
    const board = ready
      ? { name: "board_computed", ok: true, detail: { state: "ready" } }
      : { name: "board_computed", ok: false, detail: { state: "unavailable", reason: REASON, msSinceBuildStarted: now } };
    const criteria = [{ name: "plan_loaded", ok: true, detail: { tasks: 3 } }, board];
    return { status: ready ? 200 : 503, body: JSON.stringify({ ready, criteria }) };
  };
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-cold" },
    prepare: () => Promise.reject(new Error("a cold start prepares nothing")),
    command: (slot) => ({ exec: "gen", execArgv: [], args: [], cwd: slot.dir }),
    spawn,
    get,
    sleep,
    clock,
    pollMs: 500,
    rss: () => undefined,
    peakRss: () => undefined,
    socketPathFor: (n) => `/sock/${n}`,
    exit: (code) => rows.push({ step: "exit", extra: { code } }),
    log: (step, extra) => {
      rows.push({ step, extra });
      if (step === "serve.cold_start_ready") finish();
    },
  });
  await supervisor.start();
  await finished;
  return rows;
}

test("a cold start still degraded past the interval writes a still-degraded row carrying the board's reason", async () => {
  const rows = await coldStart(undefined, COLD_START_STILL_DEGRADED_EVERY_MS + 2_000);
  assert.deepEqual(rows.find((r) => r.step === "serve.cold_start_degraded")?.extra?.unmet, ["board_computed"]);
  const still = rows.filter((r) => r.step === STILL);
  assert.equal(still.length, 1, "one interval of degradation, one row");
  const row = still[0]!.extra!;
  assert.equal(row.sha, "sha-cold");
  assert.deepEqual(row.unmet, ["board_computed"], "only the criteria still unmet are named");
  const board = (row.criteria as Array<{ name: string; detail?: { reason?: string } }>).find((c) => c.name === "board_computed");
  assert.equal(board?.detail?.reason, REASON, "the row says WHY the board is not ready, not just that it is not");
  assert.ok((row.elapsedMs as number) >= COLD_START_STILL_DEGRADED_EVERY_MS, "it is written only once the interval has passed");
  assert.equal(rows.some((r) => r.step === "exit"), false);
});

test("a cold start that becomes ready before the interval writes no still-degraded row", async () => {
  const rows = await coldStart(COLD_START_STILL_DEGRADED_EVERY_MS - 10_000, 10 * STANDBY_READY_BOUND_MS);
  assert.ok(rows.some((r) => r.step === "serve.cold_start_degraded"), "it was promoted degraded");
  assert.ok(rows.some((r) => r.step === "serve.cold_start_ready"), "and became ready");
  assert.deepEqual(rows.filter((r) => r.step === STILL), [], "a healthy boot is not reported as a stall");
});

test("a cold start degraded far past the ready bound writes a bounded number of rows, spaced by the interval", async () => {
  const rows = await coldStart(undefined, 10 * STANDBY_READY_BOUND_MS);
  const still = rows.filter((r) => r.step === STILL).map((r) => r.extra!.elapsedMs as number);
  assert.equal(still.length, Math.floor(STANDBY_READY_BOUND_MS / COLD_START_STILL_DEGRADED_EVERY_MS), "never more rows than the ready bound holds intervals");
  for (let i = 1; i < still.length; i += 1) assert.ok(still[i]! - still[i - 1]! >= COLD_START_STILL_DEGRADED_EVERY_MS, `row ${i + 1} waited a whole interval`);
});

test("still-degraded rows stop at serve.cold_start_ready", async () => {
  const rows = await coldStart(2.5 * COLD_START_STILL_DEGRADED_EVERY_MS, 10 * STANDBY_READY_BOUND_MS);
  const steps = rows.map((r) => r.step).filter((s) => s === STILL || s === "serve.cold_start_ready");
  assert.deepEqual(steps, [STILL, STILL, "serve.cold_start_ready"]);
});
