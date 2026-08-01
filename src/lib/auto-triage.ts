import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * lib/auto-triage.ts — the daemon's SECOND work-generating rung (recon-DC #2).
 *
 * THE GAP THIS CLOSES. The daemon has exactly one rung that CREATES work — the retro, wired by
 * W1-T160 at daemon.ts's poll loop. Everything else consumes a queue something else filled. So
 * ~68 feedback entries sit at `status: new` while the daemon idles: `triageCommand`'s only caller
 * is the CLI (run-task.ts), and nothing turns a feedback entry into a task unattended.
 *
 * WHAT IT DOES, AND EMPHATICALLY WHAT IT DOES NOT. At most ONE entry per idle period. recon-DC
 * rejected draining the backlog in as many words — "the whole backlog is ~$64 unsupervised and 68
 * approvals — worse than idle" — and a triage run now measures ~$2.00, which makes restraint more
 * important, not less. Three independent bounds apply, and ALL must pass:
 *   1. `enabled` — policy data, DEFAULT FALSE. A rung that ships on is a surprise, not a rung.
 *   2. `minIntervalMinutes` — the floor between two fires. This is what makes "one per idle
 *      PERIOD" enforceable rather than aspirational: the daemon polls every 60s and idled ~390
 *      times in ten hours, so a per-POLL rung would have spent ~$780 in one night.
 *   3. `maxPerDay` — a hard ceiling on a rolling 24h window, so a pathological idle/dispatch
 *      flap cannot outrun bound 2.
 *
 * FAIL-SOFT AND FAIL-CLOSED, matching the retro: an unreadable marker REFUSES to fire (never
 * replays a torn state), and every error is the caller's to log — this module throws only on
 * programmer error, never on I/O.
 *
 * ★ THE LOCK IS NOT OPTIONAL, AND IT IS WHY THIS RUNG COULD NOT BE BUILT BEFORE. The task id is
 * minted from a SNAPSHOT before the worker runs (lib/triage.ts). Two triage runs that start before
 * either pushes mint the SAME id, and since PR #1060 each writes its own
 * `plan/tasks.d/<id>-<slug>.yaml` — DIFFERENT filenames, so both merge CLEANLY and `loadPlan`
 * throws duplicate-task-id ON MAIN. Before #1060 that collision was a loud EOF conflict; now it is
 * a poisoned plan. The daemon loop being single-threaded protects daemon-vs-daemon only; NOTHING
 * stopped a hand-run racing it, and this rung makes that far likelier because the operator cannot
 * see that the daemon is about to fire. {@link triageLockPath} is therefore acquired by BOTH the
 * rung and the CLI path, through the same `drain-lock.ts` primitive (atomic `O_EXCL` create, dead
 * pid reclaimed), so `rmd triage` typed by hand during a fire REFUSES loudly.
 */

/** The lock BOTH the daemon rung and the `rmd triage` CLI path acquire. One writer, ever. */
export function triageLockPath(root: string): string {
  return join(root, "state", "triage.lock");
}

/** Marker recording the last fire, so the interval and daily cap survive a daemon restart. */
export function autoTriageMarkerPath(root: string): string {
  return join(root, "state", "last-auto-triage.json");
}

export interface AutoTriageMarker {
  /** ISO timestamps of recent fires, newest last. Trimmed to the rolling window by the writer. */
  fires: string[];
}

export type MarkerResolution =
  | { kind: "ok"; marker: AutoTriageMarker }
  | { kind: "absent" }
  | { kind: "corrupt" };

/**
 * Read the marker. A malformed file resolves `corrupt`, NOT `absent` — the caller must FAIL CLOSED
 * on it, exactly as `resolveMarkerForGather` does for the retro. Treating corruption as "never
 * fired" would let a truncated write re-authorise an unbounded run of spends.
 */
export function readAutoTriageMarker(path: string): MarkerResolution {
  if (!existsSync(path)) return { kind: "absent" };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return { kind: "corrupt" };
    const fires = (raw as AutoTriageMarker).fires;
    if (!Array.isArray(fires) || fires.some((f) => typeof f !== "string")) return { kind: "corrupt" };
    return { kind: "ok", marker: { fires } };
  } catch {
    return { kind: "corrupt" };
  }
}

/** Append a fire and trim to the rolling window. Best-effort: a write failure is the caller's. */
export function recordAutoTriageFire(path: string, at: Date, windowMs: number): AutoTriageMarker {
  const prior = readAutoTriageMarker(path);
  const kept =
    prior.kind === "ok"
      ? prior.marker.fires.filter((f) => at.getTime() - Date.parse(f) < windowMs && !Number.isNaN(Date.parse(f)))
      : [];
  const marker: AutoTriageMarker = { fires: [...kept, at.toISOString()] };
  writeFileSync(path, JSON.stringify(marker, null, 2));
  return marker;
}

export interface AutoTriagePolicy {
  enabled: boolean;
  minIntervalMinutes: number;
  maxPerDay: number;
}

export interface AutoTriageInputs {
  policy: AutoTriagePolicy;
  /** The daemon reached its idle branch this tick: nothing dispatchable, nothing in flight. */
  idle: boolean;
  /** True when the shared triage lock is already held by a LIVE process (rung or hand-run). */
  lockHeld: boolean;
  marker: MarkerResolution;
  now: Date;
  /** Feedback ids at `status: new`, oldest first. Empty ⇒ nothing to do. */
  candidates: string[];
}

export type AutoTriageDecision =
  | { fire: true; feedbackId: string; reason: string }
  | { fire: false; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decide whether to fire, and on WHAT. Pure — no I/O, no clock, no filesystem — so every bound
 * below is unit-testable without spending anything.
 *
 * ORDER IS DELIBERATE: the cheapest and most consequential refusals come first, so a disabled or
 * locked fleet never even reads a candidate list. `enabled` is checked before everything because
 * an operator who has not opted in must see NO behaviour change whatsoever.
 */
export function decideAutoTriage(i: AutoTriageInputs): AutoTriageDecision {
  if (!i.policy.enabled) return { fire: false, reason: "auto-triage disabled (policy.autoTriage.enabled=false)" };
  if (!i.idle) return { fire: false, reason: "daemon is not idle" };
  if (i.lockHeld) return { fire: false, reason: "triage lock held — a run is already in flight" };
  if (i.marker.kind === "corrupt") return { fire: false, reason: "auto-triage marker unreadable — failing closed" };

  const fires = i.marker.kind === "ok" ? i.marker.marker.fires : [];
  const parsed = fires.map((f) => Date.parse(f)).filter((n) => !Number.isNaN(n));

  const lastFire = parsed.length ? Math.max(...parsed) : undefined;
  if (lastFire !== undefined) {
    const sinceMin = (i.now.getTime() - lastFire) / 60_000;
    if (sinceMin < i.policy.minIntervalMinutes) {
      return {
        fire: false,
        reason: `only ${sinceMin.toFixed(1)}m since the last fire (minInterval ${i.policy.minIntervalMinutes}m)`,
      };
    }
  }

  const inWindow = parsed.filter((t) => i.now.getTime() - t < DAY_MS).length;
  if (inWindow >= i.policy.maxPerDay) {
    return { fire: false, reason: `daily cap reached (${inWindow}/${i.policy.maxPerDay} in the last 24h)` };
  }

  if (i.candidates.length === 0) return { fire: false, reason: "no feedback at status: new" };

  // OLDEST FIRST. Two reasons, and the second is the load-bearing one. (a) An entry that has waited
  // longest has, by construction, been declined by every prior fire — newest-first would starve the
  // tail forever, which is exactly the state the backlog is in now. (b) It is STABLE: the same
  // input yields the same pick, so a fire that fails and retries next period does not skip ahead.
  return { fire: true, feedbackId: i.candidates[0], reason: "idle, under both bounds, oldest entry at status: new" };
}

/**
 * Feedback ids at `status: new`, OLDEST FIRST, read from `<root>/plan/feedback/*.yaml`.
 *
 * Deliberately reads only the entry's OWN state. recon-CQ/recon-CS classified a large subset
 * (17 ANSWERED, 14 CLEARLY LIVE, 38 UNCERTAIN) but those verdicts live in report files, not in the
 * entries — consuming them would couple this rung to a markdown artifact nobody maintains.
 */
export function newFeedbackIdsOldestFirst(root: string): string[] {
  const dir = join(root, "plan", "feedback");
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; ts: string }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".yaml")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue; // an unreadable entry is skipped, never a reason to refuse the whole sweep
    }
    if (!/^status:\s*new\s*$/m.test(text)) continue;
    const ts = text.match(/^ts:\s*(\S+)\s*$/m)?.[1] ?? "";
    out.push({ id: name.replace(/\.yaml$/, ""), ts });
  }
  // `ts` sorts lexicographically because it is ISO-8601; the id is the tiebreak so the order is
  // total and stable rather than dependent on readdir order.
  out.sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  return out.map((e) => e.id);
}
