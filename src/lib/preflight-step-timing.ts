import { performance } from "node:perf_hooks";
import { clockFromMillisFn, type Clock } from "./clock.js";
import { defaultPreflightSpawn, type PreflightSpawn } from "./commit-message.js";

export type StaticTimingPhase = "initial" | "remeasure" | "reference";
export interface StaticSpawnAttempt {
  phase: StaticTimingPhase;
  requestedBy?: string;
  durationMs: number | null;
  outcome: "returned" | "threw";
  status: number | null;
  signal: string | null;
  spawnError: boolean;
}
export interface StaticCheckTiming {
  scope: "direct-synchronous-spawn-wall";
  trainingEligible: false;
  durationMs: number | null;
  attempts: StaticSpawnAttempt[];
}

/** Clock failure is missing diagnostic evidence, never a new check verdict. */
function readTimingClock(clock: Clock): number | null {
  try {
    const value = clock.now();
    return Number.isFinite(value) ? value : null;
  } catch {
    // A failed clock supplies unknown diagnostic cost, not zero or a check verdict.
    // Spawn results and thrown command errors remain the authoritative outcomes.
    return null;
  }
}

/** Observes the original synchronous seam only; no command, retry, admission or I/O of its own. */
export function createStaticCheckTiming(
  spawn: PreflightSpawn = defaultPreflightSpawn,
  clock: Clock = clockFromMillisFn(() => performance.now()),
) {
  const attempts: StaticSpawnAttempt[] = [];
  return {
    wrap(phase: StaticTimingPhase, requestedBy?: string): PreflightSpawn {
      return (file, args, opts) => {
        const started = readTimingClock(clock);
        let result: ReturnType<PreflightSpawn> | undefined;
        let returned = false;
        try {
          result = spawn(file, args, opts);
          returned = true;
          return result;
        } finally {
          const finished = readTimingClock(clock);
          const delta = started !== null && finished !== null ? finished - started : NaN;
          const durationMs = Number.isFinite(delta) && delta >= 0 &&
            Number.isSafeInteger(Math.ceil(delta)) ? Math.ceil(delta) : null;
          attempts.push({
            phase,
            ...(requestedBy === undefined ? {} : { requestedBy }),
            durationMs,
            outcome: returned ? "returned" : "threw",
            status: result?.status ?? null,
            signal: result?.signal ?? null,
            spawnError: Boolean(result?.error),
          });
        }
      };
    },
    snapshot(): StaticCheckTiming {
      const rows = attempts.map(row => ({ ...row }));
      const total = rows.length > 0 && rows.every(row => row.durationMs !== null)
        ? rows.reduce((sum, row) => sum + row.durationMs!, 0) : null;
      return {
        scope: "direct-synchronous-spawn-wall",
        trainingEligible: false,
        durationMs: total !== null && Number.isSafeInteger(total) ? total : null,
        attempts: rows,
      };
    },
  };
}
