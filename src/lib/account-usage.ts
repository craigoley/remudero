/**
 * lib/account-usage.ts — the console's ACCOUNT strip: which Anthropic account the fleet is
 * spending, and how much of each usage window is gone.
 *
 * READS `~/.claude.json`'s `cachedUsageUtilization`, never `daemon.headroom`. The ledger field
 * freezes while the daemon is paused and carries no account identity; the cache carries its own
 * `fetchedAtMs` (an honest as-of) and `accountUuid`, so a reading that belongs to a different
 * account is refused rather than rendered — see {@link USAGE_CACHE_MAX_AGE_MS}.
 *
 * MEASURES COMBINED BURN, not the fleet's share. The fleet's workers and the operator's own
 * interactive sessions authenticate as the same account and draw down the same five-hour and
 * weekly windows; neither source attributes usage to a caller — see {@link USAGE_SCOPE_NOTE}.
 *
 * IDENTITY IS READ FRESH ON EVERY REQUEST. {@link buildAccountUsageRoute}'s handler calls
 * {@link readAccountUsageFile} with no cache or memoization, so an account switch is visible on
 * the next poll rather than the next restart.
 *
 * NEVER FROM THE KEYCHAIN: its `acct` attribute is unchanged by an account switch, so it is not a
 * discriminator. Only `oauthAccount.*` and `cachedUsageUtilization` are read, and the parsed file
 * is discarded in the same expression — see {@link readAccountUsageFile}.
 */
// Why: the operator's ask, the headroom incident, the keychain finding, the governor risk — docs/forensics/account-usage.md

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Route } from "./service.js";
import { sendJson } from "./panel-actions.js";
import { readLedgerLines, type LedgerReader } from "./status.js";
import { appendLedger, type LedgerLine } from "./ledger.js";
import {
  loadDefaultPolicy,
  resolveDailyCostCeiling,
  type DailyCostCeilingProvenance,
  type EffectiveDailyCostCeiling,
  type Policy,
} from "./policy.js";

/**
 * How old the usage cache may be before the panel refuses to render it as current.
 *
 * Sized against what refreshes it: every Claude Code invocation on this host, well below the
 * daemon's own 60s poll interval. Past this bound the panel says UNKNOWN — never the old number,
 * never 0%. FALSIFIER: test/account-identity-is-readable.test.ts pins this value at 30 minutes.
 */
export const USAGE_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

/** `percentUsed` absent ⇒ UNKNOWN, never 0. */
export interface UsageWindowReading {
  percentUsed?: number;
  resetsAt?: string;
}

/** The narrow projection {@link deriveAccountUsage} consumes, not the parsed `~/.claude.json`.
 *  Declared between executed functions, not at the file's head or tail — v8 stamps a module's
 *  leading and trailing source lines `DA:<line>,0`, which would read as uncovered code. */
export interface AccountUsageInput {
  /** `oauthAccount.emailAddress`/`accountUuid`/`organizationName` — identity, never a credential. */
  email?: string;
  uuid?: string;
  org?: string;
  /** `cachedUsageUtilization.accountUuid` — whose usage the cached block describes. */
  cacheUuid?: string;
  /** The raw value of whichever {@link CREDIT_STATE_FIELDS} name the block carried, projected as
   *  an opaque `unknown` and interpreted separately — an unrecognised value is reported as such,
   *  never read as "subscription". */
  creditStateRaw?: unknown;
  /** Which field name it came from, so a later reader can tell what was read. */
  creditStateField?: string;
  /** `cachedUsageUtilization.fetchedAtMs` — when Claude Code last wrote the block. */
  cacheFetchedAtMs?: number;
  fiveHour?: UsageWindowReading;
  sevenDay?: UsageWindowReading;
  /** True when the file itself could not be read or parsed at all. */
  unreadable?: boolean;
}

/**
 * The credit state, read from the surface or refused — never inferred. A subscription drawing on
 * usage credits drops the prompt-cache lifetime from an hour to five minutes.
 *
 * An absent field reads `not-exposed`, an unreadable one `unrecognised-value`. Policy itself is
 * out of scope: this reads and records, it never changes a mount, holds a dispatch, or rules.
 * FALSIFIER: test/the-fleet-cannot-tell-it-has-crossed-into-credits.test.ts.
 */
export const CREDIT_STATE_FIELDS = ["creditState", "credit_state", "billingMode", "billing_mode", "usingCredits", "using_credits"] as const;

export type CreditState = "subscription" | "credits";

/** Why the credit state is not known — never absent when {@link CreditReading.state} is. */
export type CreditUnknownReason = "not-exposed" | "unrecognised-value";

export interface CreditReading {
  state?: CreditState;
  unknownReason?: CreditUnknownReason;
  /** The field the value came from, present only when one was found. */
  field?: string;
}

/** Interpret a raw credit-state value: `true`/`"credits"`/`"credit"`/`"usage_credits"` read as
 *  credits, `false`/`"subscription"`/`"plan"` as subscription, anything else unrecognised. */
export function interpretCreditState(raw: unknown): CreditState | undefined {
  if (raw === true) return "credits";
  if (raw === false) return "subscription";
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "credits" || v === "credit" || v === "usage_credits" || v === "usage-credits") return "credits";
  if (v === "subscription" || v === "plan" || v === "subscription_plan") return "subscription";
  return undefined;
}

/** The credit half of a reading — absent ⇒ `not-exposed`, unreadable ⇒ `unrecognised-value`. */
export function readCreditState(input: AccountUsageInput): CreditReading {
  if (input.creditStateField === undefined) return { unknownReason: "not-exposed" };
  const state = interpretCreditState(input.creditStateRaw);
  if (state === undefined) return { unknownReason: "unrecognised-value", field: input.creditStateField };
  return { state, field: input.creditStateField };
}

/** The ledger step one transition writes. */
export const CREDIT_STATE_STEP = "account.credit_state";
export const CREDIT_STATE_RUN_ID = "ACCOUNT-USAGE";
export const CREDIT_STATE_TASK_ID = "ACCOUNT";

/** The newest credit state this ledger already recorded, or `undefined` when it has never
 *  recorded one. Reads the SAME `lines` every other derivation in this module consumes. */
export function lastRecordedCreditState(lines: ReadonlyArray<Record<string, unknown>>): CreditState | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = lines[i]!;
    if (row.step !== CREDIT_STATE_STEP) continue;
    const s = row.state;
    if (s === "credits" || s === "subscription") return s;
  }
  return undefined;
}

/** The edge, not the level — a row only when the state changed (including becoming known for the
 *  first time); `undefined` when unchanged or unknown, since an unknown is not a transition. */
export function creditTransitionRow(
  lines: ReadonlyArray<Record<string, unknown>>,
  reading: CreditReading,
  nowIso: string,
): { step: string; state: CreditState; previous?: CreditState; field?: string; ts: string } | undefined {
  if (reading.state === undefined) return undefined;
  const previous = lastRecordedCreditState(lines);
  if (previous === reading.state) return undefined;
  const row: { step: string; state: CreditState; previous?: CreditState; field?: string; ts: string } = {
    step: CREDIT_STATE_STEP,
    state: reading.state,
    ts: nowIso,
  };
  if (previous !== undefined) row.previous = previous;
  if (reading.field !== undefined) row.field = reading.field;
  return row;
}

/** The appendable ledger line for the same edge {@link creditTransitionRow} describes. */
export function creditTransitionLedgerLine(
  lines: ReadonlyArray<Record<string, unknown>>,
  reading: CreditReading,
): LedgerLine | undefined {
  if (reading.state === undefined) return undefined;
  const previous = lastRecordedCreditState(lines);
  if (previous === reading.state) return undefined;
  const line: LedgerLine = {
    run_id: CREDIT_STATE_RUN_ID,
    task_id: CREDIT_STATE_TASK_ID,
    step: CREDIT_STATE_STEP,
    state: reading.state,
  };
  if (previous !== undefined) line.previous = previous;
  if (reading.field !== undefined) line.field = reading.field;
  return line;
}

/** Append one credit-state transition row, and none for unknown or unchanged readings. */
export function appendCreditStateTransition(
  ledgerPath: string,
  lines: ReadonlyArray<Record<string, unknown>>,
  reading: CreditReading,
  writeLedger: typeof appendLedger = appendLedger,
): void {
  const line = creditTransitionLedgerLine(lines, reading);
  if (line) writeLedger(ledgerPath, line);
}

/** Why the usage half of the panel is UNKNOWN, when it is. Absent ⇒ the reading is good. */
export type UsageUnknownReason = "unreadable" | "no-cache" | "account-mismatch" | "too-old";

/** Whether the headroom governor is enforcing, per the fleet's own newest heartbeat. */
export type GovernorState = "armed" | "telemetry-only" | "unknown";

/**
 * Whether a dispatch-deferring governor (the cost ceiling or the WIP/queue ceiling) is holding
 * back new dispatch, per its own newest heartbeat (W1-T329). Only two states: `daemon.cost_
 * governor`/`daemon.queue_governor` are written only while actively deferring, so absent must
 * never read as healthy — it is not the same as "under ceiling".
 * Why: the $152.28-over-$150 incident that named this gap — docs/forensics/account-usage.md
 */
export type DispatchGovernorState = "deferred" | "unknown";

/** Off the newest `daemon.cost_governor` line, present iff "deferred" — see {@link DispatchGovernorState}. */
export interface CostGovernorDeferral {
  state: DispatchGovernorState;
  asOf?: string;
  observedDayCostUsd?: number; // `observed_day_cost_usd`
  ceilingUsd?: number; // `daily_cost_ceiling_usd`
}

/** The queue (WIP) governor's reading — same shape as {@link CostGovernorDeferral}. */
export interface QueueGovernorDeferral {
  state: DispatchGovernorState;
  asOf?: string;
  observedOpenCount?: number; // `observed_open_count`
  wipLimit?: number; // `wip_limit`
}

/** `GET /v1/account-usage`'s body. Every value field is absent (never a zero) when unreadable. */
export interface AccountUsageSnapshot {
  accountEmail?: string;
  accountUuid?: string;
  accountOrg?: string;
  fiveHour?: UsageWindowReading;
  sevenDay?: UsageWindowReading;
  /** ISO-8601 `cachedUsageUtilization.fetchedAtMs` — the reading's own as-of, rendered even when
   *  fresh. Absent iff `usageUnknownReason` is present — the windows are then absent too. */
  usageAsOf?: string;
  usageAgeMs?: number;
  usageUnknownReason?: UsageUnknownReason;
  /** Subscription vs usage credits — a separate axis from `usageUnknownReason`. Exactly one of
   *  `creditState`/`creditUnknownReason` is ever present, never both, never neither. */
  creditState?: CreditState;
  creditUnknownReason?: CreditUnknownReason;
  /** Which field the state was read from, when one was found. */
  creditStateField?: string;
  governor: GovernorState;
  /** `ts` of the `daemon.headroom` line the posture came from. */
  governorAsOf?: string;
  governorAgeMs?: number;
  /** The cost and queue governors' posture — see {@link DispatchGovernorState}. Each `*AsOf`/
   *  `*AgeMs` is absent iff "unknown"; the observed/ceiling figures are present only while
   *  "deferred" — render the number, not just the flag. */
  costGovernor: DispatchGovernorState;
  costGovernorAsOf?: string;
  costGovernorAgeMs?: number;
  costGovernorObservedUsd?: number;
  costGovernorCeilingUsd?: number;
  queueGovernor: DispatchGovernorState;
  queueGovernorAsOf?: string;
  queueGovernorAgeMs?: number;
  queueGovernorObservedOpenCount?: number;
  queueGovernorWipLimit?: number;
  /** The daily cost ceiling's effective value and provenance — see `policy.ts`'s
   *  `resolveDailyCostCeiling`. `*DefaultUsd` is the committed value it was overridden FROM;
   *  `*FallbackReason` is present only when a stored override was refused and it fell back. */
  dailyCostCeilingUsd?: number;
  dailyCostCeilingProvenance?: DailyCostCeilingProvenance;
  dailyCostCeilingDefaultUsd?: number;
  dailyCostCeilingFallbackReason?: string;
  /** The newest console write's audit trail, from `console.ceiling_override_written` (see
   *  {@link deriveCeilingOverrideAudit}). Absent iff never ledgered — distinct from "at default
   *  because a real override vanished", which the store alone cannot tell apart. */
  dailyCostCeilingAuditAsOf?: string;
  dailyCostCeilingAuditWho?: string;
  dailyCostCeilingAuditFromUsd?: number;
  dailyCostCeilingAuditToUsd?: number;
  dailyCostCeilingAuditEffectiveUsd?: number;
  /** Carried in the payload so the render can never drop the scope note. */
  measures: string;
}

/** Carried in the payload rather than hardcoded client-side, so the honesty travels with the data. */
export const USAGE_SCOPE_NOTE = "whole account — fleet workers and interactive sessions share one window";

/**
 * The panel's projection. Pure: no clock, no filesystem, no ledger read of its own, so the whole
 * staleness/mismatch policy is testable against a captured reading.
 *
 * The four ways usage goes UNKNOWN, checked in order: `unreadable`, `no-cache` (no `fetchedAtMs`
 * to age), `account-mismatch` (the cached `accountUuid` isn't the one logged in now — the
 * account-switch guard), `too-old` (past {@link USAGE_CACHE_MAX_AGE_MS}). Identity still returns
 * in every case, so the panel always answers "which account" even without "how much". `ceiling`
 * is optional — a caller that only cares about usage or the governor omits it.
 */
export function deriveAccountUsage(
  input: AccountUsageInput,
  lines: ReadonlyArray<Record<string, unknown>>,
  nowMs: number,
  ceiling?: EffectiveDailyCostCeiling,
): AccountUsageSnapshot {
  const governor = deriveGovernorPosture(lines);
  const costGovernor = deriveCostGovernorDeferral(lines);
  const queueGovernor = deriveQueueGovernorDeferral(lines);
  const ceilingAudit = deriveCeilingOverrideAudit(lines);
  // Computed from the input alone, never from the windows: an inferred state moves policy on a
  // guess.
  const credit = readCreditState(input);
  const base: AccountUsageSnapshot = {
    governor: governor.state,
    costGovernor: costGovernor.state,
    queueGovernor: queueGovernor.state,
    measures: USAGE_SCOPE_NOTE,
  };
  // Exactly one of the two, always — never both, never neither.
  if (credit.state !== undefined) base.creditState = credit.state;
  else base.creditUnknownReason = credit.unknownReason;
  if (credit.field !== undefined) base.creditStateField = credit.field;
  if (ceiling) {
    base.dailyCostCeilingUsd = ceiling.usd;
    base.dailyCostCeilingProvenance = ceiling.provenance;
    base.dailyCostCeilingDefaultUsd = ceiling.committedDefaultUsd;
    if (ceiling.fallback) base.dailyCostCeilingFallbackReason = ceiling.fallback.reason;
  }
  if (ceilingAudit.asOf !== undefined) {
    base.dailyCostCeilingAuditAsOf = ceilingAudit.asOf;
    if (ceilingAudit.who !== undefined) base.dailyCostCeilingAuditWho = ceilingAudit.who;
    if (ceilingAudit.fromUsd !== undefined) base.dailyCostCeilingAuditFromUsd = ceilingAudit.fromUsd;
    if (ceilingAudit.toUsd !== undefined) base.dailyCostCeilingAuditToUsd = ceilingAudit.toUsd;
    if (ceilingAudit.effectiveUsd !== undefined) base.dailyCostCeilingAuditEffectiveUsd = ceilingAudit.effectiveUsd;
  }
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

// The four `derive*` readers below share one shape: scan for the step's newest line by PARSED
// `ts` (never ledger order, same reason as daemon-health.ts's `deriveLastPoll`), and carry that
// line's own `ts` as the reading's `asOf`. One shape, so the four readings cannot drift apart.

/**
 * The governor's posture from the newest `daemon.headroom` line. `enforced` is a tri-state, not
 * a boolean: `true` ⇒ armed, `false` ⇒ telemetry-only, absent ⇒ unknown — real history, not a
 * hypothetical, so mapping absent to `false` would report an armed-and-breaching governor as
 * telemetry-only. Why: the measured absent-vs-false split — docs/forensics/account-usage.md
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

/** From the newest `daemon.cost_governor` line. No line ⇒ `{ state: "unknown" }` — see {@link DispatchGovernorState}. */
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

/** The queue (WIP) governor's dispatch-deferral reading from the newest `daemon.queue_governor`
 *  line (daemon.ts). Same shape as {@link deriveCostGovernorDeferral} immediately above. */
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

/** {@link deriveCeilingOverrideAudit}'s result — see that function's doc. */
export interface CeilingOverrideAudit {
  asOf?: string;
  who?: string;
  fromUsd?: number;
  toUsd?: number;
  effectiveUsd?: number;
}

/** The daily-cost-ceiling override's audit trail — who/when/from/to and the resulting effective
 *  value, from the newest `console.ceiling_override_written` line (`ledger.ts`'s
 *  `appendDailyCostCeilingOverrideAudit`). No line ever seen ⇒ every field absent, rendered as
 *  "never overridden through the console" — never a fabricated blank. */
function deriveCeilingOverrideAudit(lines: ReadonlyArray<Record<string, unknown>>): CeilingOverrideAudit {
  let bestTs: string | undefined;
  let bestParsed = -Infinity;
  let bestWho: unknown;
  let bestFromUsd: unknown;
  let bestToUsd: unknown;
  let bestEffectiveUsd: unknown;
  for (const line of lines) {
    if (line.step !== "console.ceiling_override_written") continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    bestTs = ts;
    bestWho = line.who;
    bestFromUsd = line.from_usd;
    bestToUsd = line.to_usd;
    bestEffectiveUsd = line.effective_usd;
  }
  if (bestTs === undefined) return {};
  const out: CeilingOverrideAudit = { asOf: bestTs };
  if (typeof bestWho === "string" && bestWho.length > 0) out.who = bestWho;
  if (typeof bestFromUsd === "number" && Number.isFinite(bestFromUsd)) out.fromUsd = bestFromUsd;
  if (typeof bestToUsd === "number" && Number.isFinite(bestToUsd)) out.toUsd = bestToUsd;
  if (typeof bestEffectiveUsd === "number" && Number.isFinite(bestEffectiveUsd)) out.effectiveUsd = bestEffectiveUsd;
  return out;
}

/**
 * The defect this closes: a worker's HOME is redirected to a scratch dir that `reapWorkerHome`
 * deletes right after the spawn ends, so on a headless fleet host `homedir()/.claude.json` is
 * never refreshed at all. The remedy: worker.ts's `captureWorkerUsageProjection` persists a
 * narrow projection (never `email`/`org`) here before the reap, and
 * {@link mergeAccountUsageProjection} folds it into the primary reading so it survives.
 *
 * Identity stays out of scope: `email`/`uuid`/`org` always come from `primary` untouched, so a
 * projection captured at teardown can never stand in for a live identity read. `cacheUuid` IS
 * carried, so the account-mismatch guard still refuses a since-switched-away-from capture.
 * Why: the redirected-HOME measurement — docs/forensics/account-usage.md
 */
export interface AccountUsageProjection {
  /** `cachedUsageUtilization.accountUuid`/`fetchedAtMs` off the capturing worker's OWN
   *  `.claude.json`. */
  cacheUuid?: string;
  cacheFetchedAtMs: number;
  fiveHour?: UsageWindowReading;
  sevenDay?: UsageWindowReading;
}

/**
 * `<root>/state/account-usage-projection.json` — the same `state/`-under-root convention every
 * other console write surface resolves against. Spelled out as a literal here AND in worker.ts's
 * `captureWorkerUsageProjection`: sharing one via an import would close a cycle.
 * FALSIFIER: test/the-headroom-gate-reads-a-file-the-fleet-never-refreshes.test.ts.
 */
export const USAGE_PROJECTION_REL = join("state", "account-usage-projection.json");

/** `<root>/state/account-usage-projection.json` — see {@link USAGE_PROJECTION_REL}. */
export function accountUsageProjectionPath(root: string): string {
  return join(root, USAGE_PROJECTION_REL);
}

/**
 * Read the persisted projection, failing soft to `undefined` on a missing file, a parse error, or
 * a payload with no usable `cacheFetchedAtMs` — same discipline as {@link readAccountUsageFile},
 * so a host that has never spawned a worker never crashes on this read.
 */
export function readAccountUsageProjection(path: string): AccountUsageProjection | undefined {
  let parsed: Partial<AccountUsageProjection>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AccountUsageProjection>;
  } catch {
    return undefined; // missing/unparseable -- fail soft to absent, never a crash
  }
  if (typeof parsed.cacheFetchedAtMs !== "number" || !Number.isFinite(parsed.cacheFetchedAtMs)) return undefined;
  const out: AccountUsageProjection = { cacheFetchedAtMs: parsed.cacheFetchedAtMs };
  if (typeof parsed.cacheUuid === "string" && parsed.cacheUuid !== "") out.cacheUuid = parsed.cacheUuid;
  if (parsed.fiveHour) out.fiveHour = parsed.fiveHour;
  if (parsed.sevenDay) out.sevenDay = parsed.sevenDay;
  return out;
}

/**
 * Fold a persisted {@link AccountUsageProjection} into the primary (`homedir()`) reading,
 * preferring whichever cache is fresher — a genuinely fresher interactive session's cache is
 * never clobbered by an older worker capture. Returns `primary` unchanged (by reference) when
 * there is nothing to gain, so a caller that never supplies a projection is unaffected.
 * `primary.unreadable` short-circuits as-is: this closes a stale cache, not a missing file.
 */
export function mergeAccountUsageProjection(
  primary: AccountUsageInput,
  projection: AccountUsageProjection | undefined,
): AccountUsageInput {
  if (!projection || primary.unreadable) return primary;
  if (
    typeof primary.cacheFetchedAtMs === "number" &&
    Number.isFinite(primary.cacheFetchedAtMs) &&
    primary.cacheFetchedAtMs >= projection.cacheFetchedAtMs
  ) {
    return primary; // primary is at least as fresh — nothing to gain from the projection
  }
  const merged: AccountUsageInput = { ...primary, cacheFetchedAtMs: projection.cacheFetchedAtMs };
  if (projection.cacheUuid !== undefined) merged.cacheUuid = projection.cacheUuid;
  else delete merged.cacheUuid;
  if (projection.fiveHour !== undefined) merged.fiveHour = projection.fiveHour;
  else delete merged.fiveHour;
  if (projection.sevenDay !== undefined) merged.sevenDay = projection.sevenDay;
  else delete merged.sevenDay;
  return merged;
}

/** The shape {@link readAccountUsageFile} narrows `~/.claude.json` down to. Nothing else in that
 *  file is touched, and no other key is ever named in this module. */
interface ClaudeJsonShape {
  oauthAccount?: { emailAddress?: unknown; accountUuid?: unknown; organizationName?: unknown };
  cachedUsageUtilization?: {
    accountUuid?: unknown;
    fetchedAtMs?: unknown;
    /** Whichever of {@link CREDIT_STATE_FIELDS} the surface may carry, indexed not named. */
    [k: string]: unknown;
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
  // Neither half present is nothing — absent, not an empty object.
  return out.percentUsed === undefined && out.resetsAt === undefined ? undefined : out;
}

/**
 * Read `~/.claude.json` and project it, in one expression, down to {@link AccountUsageInput}.
 * The parsed object never escapes this function — it also holds OAuth material, so only the
 * fields named in {@link ClaudeJsonShape} are copied out, by construction, never a denylist.
 * Fails soft to `{ unreadable: true }`, which {@link deriveAccountUsage} renders as UNKNOWN.
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
  for (const field of CREDIT_STATE_FIELDS) {
    if (cache !== undefined && Object.prototype.hasOwnProperty.call(cache, field)) {
      out.creditStateField = field;
      out.creditStateRaw = (cache as Record<string, unknown>)[field];
      break;
    }
  }
  const fiveHour = windowOf(cache?.utilization?.five_hour);
  if (fiveHour) out.fiveHour = fiveHour;
  const sevenDay = windowOf(cache?.utilization?.seven_day);
  if (sevenDay) out.sevenDay = sevenDay;
  return out;
}

/**
 * {@link buildAccountUsageRoute}'s dependencies — every edge injectable, same shape as
 * {@link import("./daemon-health.js").DaemonHealthDeps}. `root` is the repo/workspace root for
 * `resolveDailyCostCeiling`'s `state/` override lookup; `policy` is the same `deps.policy ??`
 * seam run-task.ts's config readers use, locked by test/config-reader-seams.test.ts.
 * `readUsageProjection` omitted ⇒ the real reader when `root` is set, none when it is unset — a
 * caller that never supplies `root` renders byte-identical to before this seam existed.
 */
export interface AccountUsageDeps {
  /** `<root>/state/ledger.ndjson` — the same ledger every other console reader tails. */
  ledgerPath: string;
  readLedger?: LedgerReader;
  /** `~/.claude.json`, or a captured fixture in a test. */
  accountFilePath?: string;
  readAccount?: () => AccountUsageInput;
  now?: () => number;
  root?: string;
  policy?: Policy;
  resolveCeiling?: () => EffectiveDailyCostCeiling;
  readUsageProjection?: () => AccountUsageProjection | undefined;
  /** Ledger appender for the observed credit-state edge; tests inject a spy. */
  writeLedger?: typeof appendLedger;
}

/** `GET /v1/account-usage` — read-scoped, computed fresh per request, no cache or memoization
 *  (see this module's header for why). */
export function buildAccountUsageRoute(deps: AccountUsageDeps): Route {
  return {
    method: "GET",
    path: "/v1/account-usage",
    scope: "read",
    handler: (_req, res) => {
      const now = deps.now ?? Date.now;
      const readLedger = deps.readLedger ?? readLedgerLines;
      const readAccount = deps.readAccount ?? (() => readAccountUsageFile(deps.accountFilePath));
      // See AccountUsageProjection's doc. `deps.root` unset ⇒ no projection is looked for.
      const readProjection =
        deps.readUsageProjection ??
        (() => (deps.root ? readAccountUsageProjection(accountUsageProjectionPath(deps.root)) : undefined));
      const policy = deps.policy ?? loadDefaultPolicy();
      const resolveCeiling = deps.resolveCeiling ?? (() => resolveDailyCostCeiling(deps.root ?? process.cwd(), policy));
      const account = mergeAccountUsageProjection(readAccount(), readProjection());
      const lines = readLedger(deps.ledgerPath);
      appendCreditStateTransition(deps.ledgerPath, lines, readCreditState(account), deps.writeLedger ?? appendLedger);
      sendJson(res, 200, deriveAccountUsage(account, lines, now(), resolveCeiling()));
    },
  };
}
