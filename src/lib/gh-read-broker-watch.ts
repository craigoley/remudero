/**
 * W1-T11944 — the daemon's watch on the GitHub read broker's heartbeat.
 *
 * Readers judge the heartbeat only at read time (gh-read-broker-client.ts, hooks/deny-floor.sh), so a broker
 * that is dead or crash-looping while nobody reads is reported by nothing: on 2026-11-09 one crash-looped for
 * about 85 minutes and every session fell back to the 180 s floor in silence. The daemon tick calls
 * {@link watchReadBrokerHeartbeat}, which reads the same file the same way and writes one ledger row per
 * stale episode and one when the episode closes.
 *
 * SHADOW RELEASE: rows only. Raising the existing alert path is a later switch, once the rows are audited.
 * The watch never decides a read: it only reads the heartbeat file, and every failure is a reading.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { systemClock } from "./clock.js";
import { GH_BROKER_HEARTBEAT, ghBrokerDir } from "./gh-read-broker-client.js";

/** The launchd agent deploy/mac/install-gh-read-broker.sh installs. */
export const GH_BROKER_LAUNCH_AGENT = "Library/LaunchAgents/com.remudero.gh-read-broker.plist";

export const GH_BROKER_STALE_STEP = "github.broker.heartbeat_stale";
export const GH_BROKER_NOT_SERVING_STEP = "github.broker.no_broker_serving";
export const GH_BROKER_UNKNOWN_STEP = "github.broker.heartbeat_unknown";
export const GH_BROKER_RECOVERED_STEP = "github.broker.heartbeat_recovered";

export type ReadBrokerHeartbeatReading =
  | { state: "fresh"; heartbeat: string; ageMs: number; intervalS: number }
  | { state: "stale"; heartbeat: string; ageMs: number; intervalS: number }
  | { state: "no_broker_serving"; heartbeat: string }
  | { state: "not_installed" }
  | { state: "unknown"; reason: string };

/** The episode open since a reading first went bad; the daemon keeps one for its whole life. */
export interface ReadBrokerWatchState {
  episode?: { state: "stale" | "no_broker_serving" | "unknown"; sinceMs: number };
}

/** Whether this host runs the broker: its launchd agent is installed, or a broker has served here. */
function brokerInstalled(dir: string, env: NodeJS.ProcessEnv): boolean {
  return existsSync(dir) || (env.HOME !== undefined && env.HOME !== "" && existsSync(join(env.HOME, GH_BROKER_LAUNCH_AGENT)));
}

/** Reads the heartbeat as a reader would (ghBrokerDirLive): stale at TWICE the interval the broker wrote into it. */
export function readBrokerHeartbeat(env: NodeJS.ProcessEnv, nowMs: number): ReadBrokerHeartbeatReading {
  // A test process watches only a cache root of its own, never the account's real broker (as ghBrokerRouteFor).
  if (env.NODE_TEST_CONTEXT && !env.RMD_GH_CACHE_HOME) return { state: "not_installed" };
  const dir = ghBrokerDir(env);
  if (dir === undefined) return { state: "unknown", reason: "no cache root to find the broker directory in" };
  const heartbeat = join(dir, GH_BROKER_HEARTBEAT);
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(heartbeat, "utf8");
    mtimeMs = statSync(heartbeat).mtimeMs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return brokerInstalled(dir, env) ? { state: "no_broker_serving", heartbeat } : { state: "not_installed" };
    return { state: "unknown", reason: `heartbeat unreadable: ${code ?? String((err as Error).message)}` };
  }
  const intervalS = Number(raw.trim());
  if (!(intervalS > 0)) return { state: "unknown", reason: `heartbeat declares no interval: ${JSON.stringify(raw.slice(0, 40))}` };
  const ageMs = Math.max(0, nowMs - mtimeMs);
  return { state: ageMs < 2 * intervalS * 1000 ? "fresh" : "stale", heartbeat, ageMs, intervalS };
}

/**
 * One daemon tick's look at the heartbeat. A bad reading opens an episode and writes its row once; the same
 * reading on later ticks writes nothing; a fresh heartbeat (or a host with no broker at all) closes the
 * episode with a recovered row. Returns the reading; nothing here admits or refuses a read.
 */
export function watchReadBrokerHeartbeat(
  state: ReadBrokerWatchState,
  log: (step: string, extra?: Record<string, unknown>) => void,
  opts: { env?: NodeJS.ProcessEnv; nowMs?: number } = {},
): ReadBrokerHeartbeatReading {
  const nowMs = opts.nowMs ?? systemClock.now();
  const reading = readBrokerHeartbeat(opts.env ?? process.env, nowMs);
  const open = state.episode;
  if (reading.state === "fresh" || reading.state === "not_installed") {
    if (open !== undefined) {
      log(GH_BROKER_RECOVERED_STEP, { after: open.state, episode_ms: nowMs - open.sinceMs, now: reading.state });
      state.episode = undefined;
    }
    return reading;
  }
  if (open?.state === reading.state) return reading;
  state.episode = { state: reading.state, sinceMs: nowMs };
  if (reading.state === "stale") {
    log(GH_BROKER_STALE_STEP, {
      heartbeat: reading.heartbeat, age_ms: reading.ageMs, interval_s: reading.intervalS,
      threshold_ms: 2 * reading.intervalS * 1000, mode: "shadow",
    });
  } else if (reading.state === "no_broker_serving") {
    log(GH_BROKER_NOT_SERVING_STEP, { heartbeat: reading.heartbeat, mode: "shadow" });
  } else {
    log(GH_BROKER_UNKNOWN_STEP, { reason: reading.reason, fails: "open", mode: "shadow" });
  }
  return reading;
}
