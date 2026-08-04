/**
 * lib/account-usage.ts — the console's ACCOUNT strip: which Anthropic account the fleet is
 * spending, and how much of each usage window is gone.
 *
 * The operator's ask, verbatim in substance: "Can't we have something in the console that will
 * show which subscription it's using and how much is used?" The console showed neither. It shows
 * `spend today`/`spend this week` in DOLLARS (glance.ts, ledgered per-run cost) — a notional
 * API-equivalent figure on a subscription, which is explicitly NOT a window signal (headroom.ts's
 * own header says so). The thing that actually runs out is the WINDOW, and nothing rendered it.
 *
 * ─── WHY THE LEDGER IS NOT THE USAGE SOURCE ──────────────────────────────────────────────────
 * The obvious source is `daemon.headroom`, which carries `window`/`percent_used`/`limit_pct`/
 * `resets_at`. It is the wrong one for USAGE, for two measured reasons:
 *
 *  1. IT IS WRITTEN ONLY WHILE THE DAEMON IS AWAKE. A paused or stopped fleet writes nothing, so
 *     the number freezes at whatever the last tick saw and keeps rendering as if current.
 *  2. IT IS PER-BOOT-ACCOUNT AND CARRIES NO IDENTITY. Measured on this host 2026-07-31: the
 *     newest `daemon.headroom` line anywhere (live ledger ∪ 661 rotations, 1,243 lines) was
 *     `14:59:05.671Z … "percent_used": 77`. The operator switched this host's Anthropic account
 *     the same afternoon, and the account it switched TO reads 2% / 0%. A panel keyed on that
 *     line would have shown "77% of your week is gone" for an account that had spent nothing —
 *     confidently wrong, with no field on the line to detect it by.
 *
 * So usage comes from `~/.claude.json`'s `cachedUsageUtilization`, which carries the two things
 * the ledger cannot: its OWN `fetchedAtMs` (an honest as-of) and its OWN `accountUuid` (so a
 * block belonging to a DIFFERENT account is detectable and refused rather than rendered).
 *
 * WHAT REFRESHES IT, AND HOW STALE IT CAN GET. It is a CACHE written by Claude Code itself —
 * any Claude Code process on this host refreshes it, which includes the fleet's workers AND the
 * operator's own interactive sessions. Nothing in remudero writes it and nothing in remudero can
 * force it. So its worst case is unbounded: a host with no Claude Code activity at all never
 * refreshes it. That is exactly why {@link USAGE_CACHE_MAX_AGE_MS} exists and why the age is
 * rendered even when fresh — a number nobody refreshes, presented as current, is worse than no
 * number, because the operator will act on it.
 *
 * ─── WHAT THIS MEASURES, STATED PLAINLY ──────────────────────────────────────────────────────
 * COMBINED BURN, not fleet burn. The fleet's workers and the operator's own interactive Claude
 * Code sessions authenticate as the SAME account and draw down the SAME five-hour and weekly
 * windows. Neither `cachedUsageUtilization` nor `/usage` attributes consumption to a caller, so
 * this panel CANNOT say "the fleet spent this" versus "you spent this" — it says "this account
 * has spent this". The console's existing dollar figures (glance.ts) are the fleet-only half,
 * because those are ledgered per-run by remudero itself; the percentage here is everything.
 *
 * ─── IDENTITY IS READ FRESH, NEVER CAPTURED AT BOOT ──────────────────────────────────────────
 * {@link buildAccountUsageRoute}'s handler calls {@link readAccountUsageFile} on EVERY request —
 * there is no module-level cache, no boot-time capture, and no memoization. An account switch is
 * therefore visible on the next poll. This is deliberate: the daemon and the console are
 * long-lived processes (the console has been up for days at a time on this host), so anything
 * captured once would outlive the fact it describes.
 *
 * NOT FROM THE KEYCHAIN. `ensureWorkerKeychain` stamps its copied worker keychain with an `acct`
 * attribute scraped from the login keychain, and on this host that value is the macOS username
 * (`craigoleyagent`) — identical before and after an Anthropic account switch. It is not a
 * discriminator, so no keychain-derived value appears anywhere in this module. Nothing here reads
 * a credential: only `oauthAccount.emailAddress`/`accountUuid`/`organizationName` and the
 * `cachedUsageUtilization` block are projected out of that file, and the parsed object is
 * discarded in the same expression — see {@link readAccountUsageFile}.
 *
 * A NOTE ON `readUsageSnapshot` (run-task.ts), the fleet's OWN reading: it shells
 * `claude -p "/usage"` with a worker env but WITHOUT a `home:` option, so it reads the OPERATOR'S
 * login keychain while spawned workers read a copied worker keychain. With one Anthropic account
 * on the host both resolve to the same identity and the reading is the right one. That stops
 * being true the moment a second account exists on this host, at which point the governor would
 * be metering an account the workers are not spending. Flagged here because this panel is where
 * an operator would first see the disagreement.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Route } from "./service.js";
import { sendJson } from "./panel-actions.js";
import { readLedgerLines, type LedgerReader } from "./status.js";

/**
 * How old the usage cache may be before the panel refuses to render it as current.
 *
 * Sized against what actually refreshes it: every Claude Code invocation on this host, and the
 * daemon polls at `DEFAULT_POLL_INTERVAL_MS` (60s) with workers running far more often than that.
 * Half an hour is therefore many missed refresh opportunities — comfortably long enough not to
 * flap on an idle stretch, short enough that a genuinely dead host stops being reported as a live
 * reading. Past it the panel says UNKNOWN; it never shows the old number and it never shows 0%.
 */
export const USAGE_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

/** One window's reading, as the panel renders it. `percentUsed` absent ⇒ UNKNOWN, never 0. */
export interface UsageWindowReading {
  percentUsed?: number;
  resetsAt?: string;
}

/**
 * The narrow projection {@link deriveAccountUsage} consumes — deliberately NOT the parsed
 * `~/.claude.json`. Declared between executed functions rather than at the file head: the v8
 * coverage channel stamps `DA:<line>,0` across a module's leading and trailing source-line
 * records, so a type-only declaration parked at either end reads to diff-coverage as uncovered
 * code.
 */
export interface AccountUsageInput {
  /** `oauthAccount.emailAddress` — identity, not a credential. */
  email?: string;
  /** `oauthAccount.accountUuid` — identity, not a credential. */
  uuid?: string;
  /** `oauthAccount.organizationName`. */
  org?: string;
  /** `cachedUsageUtilization.accountUuid` — whose usage the cached block describes. */
  cacheUuid?: string;
  /** `cachedUsageUtilization.fetchedAtMs` — when Claude Code last wrote the block. */
  cacheFetchedAtMs?: number;
  fiveHour?: UsageWindowReading;
  sevenDay?: UsageWindowReading;
  /** True when the file itself could not be read or parsed at all. */
  unreadable?: boolean;
}

/** Why the usage half of the panel is UNKNOWN, when it is. Absent ⇒ the reading is good. */
export type UsageUnknownReason = "unreadable" | "no-cache" | "account-mismatch" | "too-old";

/** Whether the headroom governor is enforcing, per the fleet's own newest heartbeat. */
export type GovernorState = "armed" | "telemetry-only" | "unknown";

/**
 * Whether a DISPATCH-DEFERRING governor (the cost ceiling or the WIP/queue ceiling) is currently
 * holding back NEW dispatch, per the fleet's own newest heartbeat for that governor (W1-T329,
 * OPERATOR COMPLAINT 2026-08-04: the fleet deferred every dispatch for ~40 minutes at $152.28
 * against a $150 ceiling and the console said only "nothing in flight").
 *
 * ONLY TWO STATES, DELIBERATELY — there is no "clear"/"under-ceiling" third state to derive.
 * Unlike `daemon.headroom` (written on EVERY tick, deferring or not, so its `enforced` field is a
 * real tri-state), `daemon.cost_governor`/`daemon.queue_governor` (daemon.ts) are written ONLY
 * while that governor is actively deferring — no line ever states "not deferring". So the only
 * two honest answers are "the newest deferral we've seen" and "we've never seen one", and the
 * second one must NEVER be presented as healthy: `GovernorState`'s own doc already establishes
 * why absent must not collapse into a healthy-looking default ("would report an armed-and-
 * breaching governor as telemetry-only") — the identical hazard here would report a governor
 * that has idled the whole fleet for hours as indistinguishable from one comfortably under
 * ceiling.
 */
export type DispatchGovernorState = "deferred" | "unknown";

/** The cost governor's dispatch-deferral reading — see {@link DispatchGovernorState}. */
export interface CostGovernorDeferral {
  state: DispatchGovernorState;
  /** `ts` of the newest `daemon.cost_governor` line, present iff `state` is "deferred". */
  asOf?: string;
  /** `observed_day_cost_usd` off that same line. */
  observedDayCostUsd?: number;
  /** `daily_cost_ceiling_usd` off that same line. */
  ceilingUsd?: number;
}

/** The queue (WIP) governor's dispatch-deferral reading — see {@link DispatchGovernorState}. */
export interface QueueGovernorDeferral {
  state: DispatchGovernorState;
  /** `ts` of the newest `daemon.queue_governor` line, present iff `state` is "deferred". */
  asOf?: string;
  /** `observed_open_count` off that same line. */
  observedOpenCount?: number;
  /** `wip_limit` off that same line. */
  wipLimit?: number;
}

/**
 * `GET /v1/account-usage`'s body. EVERY value field is optional and absent — never a placeholder
 * and never a zero — when its own source could not be read, exactly the discipline
 * `DaemonHealthSnapshot` already holds itself to.
 */
export interface AccountUsageSnapshot {
  accountEmail?: string;
  accountUuid?: string;
  accountOrg?: string;
  fiveHour?: UsageWindowReading;
  sevenDay?: UsageWindowReading;
  /** ISO-8601 of `cachedUsageUtilization.fetchedAtMs` — the reading's own as-of. */
  usageAsOf?: string;
  /** Age of that reading at render time. Rendered even when fresh. */
  usageAgeMs?: number;
  /** Present iff the usage half is UNKNOWN; the windows are then absent. */
  usageUnknownReason?: UsageUnknownReason;
  governor: GovernorState;
  /** `ts` of the `daemon.headroom` line the posture came from. */
  governorAsOf?: string;
  governorAgeMs?: number;
  /** W1-T329: the cost ceiling's dispatch-deferral posture — see {@link DispatchGovernorState}. */
  costGovernor: DispatchGovernorState;
  /** `ts` of the `daemon.cost_governor` line the posture came from; absent iff "unknown". */
  costGovernorAsOf?: string;
  costGovernorAgeMs?: number;
  /** The day's ledgered cost that produced the deferral, present only while `costGovernor` is
   *  "deferred" — RENDER THE NUMBER, NOT JUST THE FLAG ("$152.28 of $150" is actionable). */
  costGovernorObservedUsd?: number;
  /** The ceiling consulted, present only while `costGovernor` is "deferred". */
  costGovernorCeilingUsd?: number;
  /** W1-T329: the WIP/queue ceiling's dispatch-deferral posture — see {@link DispatchGovernorState}. */
  queueGovernor: DispatchGovernorState;
  /** `ts` of the `daemon.queue_governor` line the posture came from; absent iff "unknown". */
  queueGovernorAsOf?: string;
  queueGovernorAgeMs?: number;
  /** The observed open-PR count that produced the deferral, present only while `queueGovernor`
   *  is "deferred". */
  queueGovernorObservedOpenCount?: number;
  /** The WIP limit consulted, present only while `queueGovernor` is "deferred". */
  queueGovernorWipLimit?: number;
  /** The scope note, carried in the payload so the render can never drop it. */
  measures: string;
}

/** Carried in the payload rather than hardcoded client-side, so the honesty travels with the data. */
export const USAGE_SCOPE_NOTE = "whole account — fleet workers and interactive sessions share one window";

/**
 * The panel's projection. PURE: no clock of its own, no filesystem, no ledger read — every input
 * is passed in, so the whole staleness/mismatch policy is testable against a captured reading.
 *
 * THE THREE WAYS USAGE GOES UNKNOWN, in the order they are checked:
 *   1. `unreadable` — the file was missing or unparseable. Nothing is known.
 *   2. `no-cache` — the file parsed but carries no `fetchedAtMs`, so the reading has no as-of and
 *      cannot be aged. An un-ageable reading is exactly the "value nobody refreshes" hazard.
 *   3. `account-mismatch` — the cached block's `accountUuid` is not the account currently logged
 *      in. THIS IS THE ACCOUNT-SWITCH GUARD: after a switch the cache still holds the previous
 *      account's percentages until some Claude Code process rewrites it, and rendering those
 *      against the new account's name is the precise failure this panel exists to avoid.
 *   4. `too-old` — older than {@link USAGE_CACHE_MAX_AGE_MS}.
 *
 * Identity is returned in every case (it comes from a different part of the file and is fresh),
 * so the panel can always answer "which account" even when it cannot answer "how much".
 */
export function deriveAccountUsage(
  input: AccountUsageInput,
  lines: ReadonlyArray<Record<string, unknown>>,
  nowMs: number,
): AccountUsageSnapshot {
  const governor = deriveGovernorPosture(lines);
  const costGovernor = deriveCostGovernorDeferral(lines);
  const queueGovernor = deriveQueueGovernorDeferral(lines);
  const base: AccountUsageSnapshot = {
    governor: governor.state,
    costGovernor: costGovernor.state,
    queueGovernor: queueGovernor.state,
    measures: USAGE_SCOPE_NOTE,
  };
  if (governor.asOf !== undefined) {
    base.governorAsOf = governor.asOf;
    base.governorAgeMs = Math.max(0, nowMs - Date.parse(governor.asOf));
  }
  if (costGovernor.asOf !== undefined) {
    base.costGovernorAsOf = costGovernor.asOf;
    base.costGovernorAgeMs = Math.max(0, nowMs - Date.parse(costGovernor.asOf));
    base.costGovernorObservedUsd = costGovernor.observedDayCostUsd;
    base.costGovernorCeilingUsd = costGovernor.ceilingUsd;
  }
  if (queueGovernor.asOf !== undefined) {
    base.queueGovernorAsOf = queueGovernor.asOf;
    base.queueGovernorAgeMs = Math.max(0, nowMs - Date.parse(queueGovernor.asOf));
    base.queueGovernorObservedOpenCount = queueGovernor.observedOpenCount;
    base.queueGovernorWipLimit = queueGovernor.wipLimit;
  }
  if (input.email !== undefined) base.accountEmail = input.email;
  if (input.uuid !== undefined) base.accountUuid = input.uuid;
  if (input.org !== undefined) base.accountOrg = input.org;

  const reason = usageUnknownReason(input, nowMs);
  if (reason) return { ...base, usageUnknownReason: reason };

  // Only here — a cache that is present, ageable, in-date, and for THIS account — do any
  // percentages reach the payload.
  const out: AccountUsageSnapshot = {
    ...base,
    usageAsOf: new Date(input.cacheFetchedAtMs!).toISOString(),
    usageAgeMs: Math.max(0, nowMs - input.cacheFetchedAtMs!),
  };
  if (input.fiveHour) out.fiveHour = input.fiveHour;
  if (input.sevenDay) out.sevenDay = input.sevenDay;
  return out;
}

/** The four disqualifiers, in order — see {@link deriveAccountUsage}'s doc. */
function usageUnknownReason(input: AccountUsageInput, nowMs: number): UsageUnknownReason | undefined {
  if (input.unreadable) return "unreadable";
  if (typeof input.cacheFetchedAtMs !== "number" || !Number.isFinite(input.cacheFetchedAtMs)) return "no-cache";
  if (input.uuid !== undefined && input.cacheUuid !== undefined && input.cacheUuid !== input.uuid) {
    return "account-mismatch";
  }
  if (nowMs - input.cacheFetchedAtMs > USAGE_CACHE_MAX_AGE_MS) return "too-old";
  return undefined;
}

/**
 * The governor's posture from the NEWEST `daemon.headroom` ledger line.
 *
 * `enforced` is read as a TRI-STATE, not a boolean: `true` ⇒ armed, `false` ⇒ telemetry-only,
 * and ABSENT ⇒ unknown. The absent case is real history, not a hypothetical — of 1,243
 * `daemon.headroom` lines on this host, 922 carry `enforced: false` and 321 carry no `enforced`
 * key at all (they were written by the pre-symmetry over-ceiling branch, which never set it).
 * Mapping absent to `false` would report an armed-and-breaching governor as telemetry-only.
 *
 * Ordering is by PARSED `ts`, never by ledger order, for the same reason `deriveLastPoll`
 * (daemon-health.ts) does it that way.
 */
function deriveGovernorPosture(
  lines: ReadonlyArray<Record<string, unknown>>,
): { state: GovernorState; asOf?: string } {
  let bestTs: string | undefined;
  let bestParsed = -Infinity;
  let bestEnforced: unknown;
  for (const line of lines) {
    if (line.step !== "daemon.headroom") continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    bestTs = ts;
    bestEnforced = line.enforced;
  }
  if (bestTs === undefined) return { state: "unknown" };
  if (bestEnforced === true) return { state: "armed", asOf: bestTs };
  if (bestEnforced === false) return { state: "telemetry-only", asOf: bestTs };
  return { state: "unknown", asOf: bestTs };
}

/**
 * W1-T329: the cost governor's dispatch-deferral reading from the NEWEST `daemon.cost_governor`
 * ledger line (daemon.ts, written on every tick that governor defers new dispatch). Mirrors
 * {@link deriveGovernorPosture}'s own shape deliberately — "read the newest line, carry its own
 * as-of, age it inline" — rather than inventing a second way to answer "is the fleet allowed to
 * work". No line at all ⇒ `{ state: "unknown" }`; see {@link DispatchGovernorState}'s doc for why
 * that must never be presented as "under ceiling".
 */
function deriveCostGovernorDeferral(lines: ReadonlyArray<Record<string, unknown>>): CostGovernorDeferral {
  let bestTs: string | undefined;
  let bestParsed = -Infinity;
  let bestObservedUsd: unknown;
  let bestCeilingUsd: unknown;
  for (const line of lines) {
    if (line.step !== "daemon.cost_governor") continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    bestTs = ts;
    bestObservedUsd = line.observed_day_cost_usd;
    bestCeilingUsd = line.daily_cost_ceiling_usd;
  }
  if (bestTs === undefined) return { state: "unknown" };
  const out: CostGovernorDeferral = { state: "deferred", asOf: bestTs };
  if (typeof bestObservedUsd === "number" && Number.isFinite(bestObservedUsd)) out.observedDayCostUsd = bestObservedUsd;
  if (typeof bestCeilingUsd === "number" && Number.isFinite(bestCeilingUsd)) out.ceilingUsd = bestCeilingUsd;
  return out;
}

/**
 * W1-T329: the queue (WIP) governor's dispatch-deferral reading from the NEWEST
 * `daemon.queue_governor` ledger line (daemon.ts). Same shape as
 * {@link deriveCostGovernorDeferral} immediately above, deliberately — two governors, one
 * derivation shape, so they cannot drift apart.
 */
function deriveQueueGovernorDeferral(lines: ReadonlyArray<Record<string, unknown>>): QueueGovernorDeferral {
  let bestTs: string | undefined;
  let bestParsed = -Infinity;
  let bestObservedOpenCount: unknown;
  let bestWipLimit: unknown;
  for (const line of lines) {
    if (line.step !== "daemon.queue_governor") continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    bestTs = ts;
    bestObservedOpenCount = line.observed_open_count;
    bestWipLimit = line.wip_limit;
  }
  if (bestTs === undefined) return { state: "unknown" };
  const out: QueueGovernorDeferral = { state: "deferred", asOf: bestTs };
  if (typeof bestObservedOpenCount === "number" && Number.isFinite(bestObservedOpenCount)) {
    out.observedOpenCount = bestObservedOpenCount;
  }
  if (typeof bestWipLimit === "number" && Number.isFinite(bestWipLimit)) out.wipLimit = bestWipLimit;
  return out;
}

/** The shape {@link readAccountUsageFile} narrows `~/.claude.json` down to. Nothing else in that
 *  file is touched, and no other key is ever named in this module. */
interface ClaudeJsonShape {
  oauthAccount?: { emailAddress?: unknown; accountUuid?: unknown; organizationName?: unknown };
  cachedUsageUtilization?: {
    accountUuid?: unknown;
    fetchedAtMs?: unknown;
    utilization?: {
      five_hour?: { utilization?: unknown; resets_at?: unknown } | null;
      seven_day?: { utilization?: unknown; resets_at?: unknown } | null;
    };
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function windowOf(w: { utilization?: unknown; resets_at?: unknown } | null | undefined): UsageWindowReading | undefined {
  if (!w) return undefined;
  const out: UsageWindowReading = {};
  if (typeof w.utilization === "number" && Number.isFinite(w.utilization)) out.percentUsed = w.utilization;
  const resets = str(w.resets_at);
  if (resets) out.resetsAt = resets;
  // An entry with neither half is nothing — return absent rather than an empty object, so the
  // render's "is this window known" test stays a simple presence check.
  return out.percentUsed === undefined && out.resetsAt === undefined ? undefined : out;
}

/**
 * Read `~/.claude.json` and PROJECT it, in one expression, down to {@link AccountUsageInput}.
 *
 * THE PARSED OBJECT NEVER ESCAPES THIS FUNCTION. That is the whole reason the projection is a
 * separate function from the route: `~/.claude.json` also holds OAuth material, and a route that
 * handed the parsed object to a serializer would publish it over HTTP. Only the six identity/
 * usage fields named in {@link ClaudeJsonShape} are copied out; every other key — including every
 * credential — is dropped by construction rather than by a denylist that could go stale.
 *
 * Fails soft to `{ unreadable: true }` on a missing file, a parse error, or an unexpected shape,
 * which {@link deriveAccountUsage} renders as UNKNOWN. `path` is injectable so a test drives a
 * captured fixture without touching the operator's real home directory.
 */
export function readAccountUsageFile(path: string = join(homedir(), ".claude.json")): AccountUsageInput {
  let parsed: ClaudeJsonShape;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ClaudeJsonShape;
  } catch {
    return { unreadable: true };
  }
  const out: AccountUsageInput = {};
  const email = str(parsed.oauthAccount?.emailAddress);
  if (email) out.email = email;
  const uuid = str(parsed.oauthAccount?.accountUuid);
  if (uuid) out.uuid = uuid;
  const org = str(parsed.oauthAccount?.organizationName);
  if (org) out.org = org;
  const cache = parsed.cachedUsageUtilization;
  const cacheUuid = str(cache?.accountUuid);
  if (cacheUuid) out.cacheUuid = cacheUuid;
  if (typeof cache?.fetchedAtMs === "number" && Number.isFinite(cache.fetchedAtMs)) {
    out.cacheFetchedAtMs = cache.fetchedAtMs;
  }
  const fiveHour = windowOf(cache?.utilization?.five_hour);
  if (fiveHour) out.fiveHour = fiveHour;
  const sevenDay = windowOf(cache?.utilization?.seven_day);
  if (sevenDay) out.sevenDay = sevenDay;
  return out;
}

/** {@link buildAccountUsageRoute}'s dependencies — every edge injectable, same shape as
 *  {@link import("./daemon-health.js").DaemonHealthDeps}. */
export interface AccountUsageDeps {
  /** `<root>/state/ledger.ndjson` — the SAME ledger every other console reader tails. */
  ledgerPath: string;
  readLedger?: LedgerReader;
  /** `~/.claude.json`, or a captured fixture in a test. */
  accountFilePath?: string;
  /** Injectable projection — a test supplies a captured reading without any filesystem at all. */
  readAccount?: () => AccountUsageInput;
  now?: () => number;
}

/**
 * `GET /v1/account-usage` — read-scoped, computed FRESH PER REQUEST. No cache, no memoization,
 * no boot capture: that is what makes an account switch visible on the next poll rather than on
 * the next daemon restart (see this module's header).
 */
export function buildAccountUsageRoute(deps: AccountUsageDeps): Route {
  return {
    method: "GET",
    path: "/v1/account-usage",
    scope: "read",
    handler: (_req, res) => {
      const now = deps.now ?? Date.now;
      const readLedger = deps.readLedger ?? readLedgerLines;
      const readAccount = deps.readAccount ?? (() => readAccountUsageFile(deps.accountFilePath));
      sendJson(res, 200, deriveAccountUsage(readAccount(), readLedger(deps.ledgerPath), now()));
    },
  };
}
