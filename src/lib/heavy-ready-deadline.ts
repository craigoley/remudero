import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { heavyReadyEscalationSink, readHeavyNewBuildHold, type HeavyReservationReading } from "./heavy-build-reservation.js";
import { systemClock } from "./clock.js";

/** PROPOSAL: discovery/retry cadence, not a replacement for the original READY60 deadline. */
export const HEAVY_READY_TICK_MS = 1_000;
/** BACKSTOP: a silent/crashed independent service cannot certify safe NEW admission. */
export const HEAVY_READY_SILENCE_MS = 5_000;
const KIND = "heavy-ready-deadline-v1";
export interface HeavyReadyDeadlineObservation { atMs: number; reading: HeavyReservationReading }
export interface HeavyReadyDeadlineService {
  observation(): HeavyReadyDeadlineObservation | undefined;
  stop(): Promise<void>;
}

/** A tick records the original expiry and fsync-backed LOCAL escalation inbox before ACK.
 * No remote notification, capacity acquisition, grant consumption or run dispatch happens here. */
export function heavyReadyDeadlineTick(dir: string, now = systemClock.now()): HeavyReadyDeadlineObservation {
  return { atMs: now, reading: readHeavyNewBuildHold({ dir, now, log: heavyReadyEscalationSink(dir) }) };
}

/** Explicit opt-in only. A separate thread remains responsive while the daemon's main loop blocks.
 * Worker failure is observable and NEVER restarts a lease, renews READY or clears an UNKNOWN. */
export function startHeavyReadyDeadlineService(opts: { enabled?: boolean; dir?: string }): HeavyReadyDeadlineService | undefined {
  if (opts.enabled !== true) return undefined;
  if (!opts.dir) throw new Error("heavy READY deadline service requires an explicit directory");
  const entry = new URL(import.meta.url);
  const data = { kind: KIND, dir: opts.dir, entry: entry.href };
  // Same tsx worker-loader contract as read-plane.ts; the main-thread loader is not inherited.
  const worker = entry.pathname.endsWith(".ts")
    ? new Worker(`const {workerData}=require('node:worker_threads'); import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}).then(({register})=>{register();return import(workerData.entry);});`, { eval: true, workerData: data })
    : new Worker(entry, { workerData: data });
  let latest: HeavyReadyDeadlineObservation | undefined, stopped = false;
  const fail = (reason: string): void => { latest = { atMs: systemClock.now(), reading: { state: "unavailable", reason } }; };
  worker.on("message", (value: HeavyReadyDeadlineObservation) => { if (!stopped) latest = value; });
  worker.once("error", error => fail(`heavy READY deadline worker failed: ${error.message}`));
  worker.once("exit", code => { if (!stopped) fail(`heavy READY deadline worker exited: ${code}`); });
  worker.unref(); // Attach listeners first: a message listener can otherwise re-ref the thread.
  return {
    observation: () => stopped ? { atMs: systemClock.now(), reading: { state: "unavailable", reason: "heavy READY deadline service stopped" } } : latest,
    stop: async () => { if (stopped) return;stopped = true;await worker.terminate(); },
  };
}

if (!isMainThread && workerData?.kind === KIND && parentPort) {
  const dir = workerData.dir as string;
  const tick = (): void => { parentPort!.postMessage(heavyReadyDeadlineTick(dir)); };
  tick();
  setInterval(tick, HEAVY_READY_TICK_MS);
}
