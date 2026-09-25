import { DISPATCH_STALL_RULE_ID, NO_MERGES_WITH_GREEN_QUEUE_RULE_ID } from "./incident-invariants.js";

/**
 * lib/sre-governor.ts (W1-T4390) — THE WATCHER THE OPERATOR ASKED FOR: an auto-fixing SRE can loop
 * or do harm, and W1-T4386's stop-after-two-failures cannot see either — it lives inside the lane it
 * polices, and it only counts failures. {@link sreGovernorVerdict} maps each runbook to
 * `live | slow | shadow | stopped`, with the reason, computed ONLY from the ledger (`sre.runbook`
 * receipts, incident events, fleet control state) and never from lane memory — so a second process
 * reading the same ledger reaches the same verdict.
 *
 * TWO ENFORCERS evaluate it: sre-runbooks.ts before every act, and the core daemon every tick
 * (daemon.ts `stepSreGovernor`), which pauses the SRE lane on a stopped verdict even when the lane
 * never asked. This module is a LEAF of that pair — it imports neither, so neither can form a cycle.
 *
 * TIERS, strongest first: `stopped` (flapping, harm seen twice, or a global hold) > `shadow` (a new
 * runbook, or a loop or harm not yet out-served) > `slow` (one fingerprint re-acted on inside its
 * backoff) > `live`. Self-healing, never a hard ceiling: shadow returns to live on a clean shadow
 * record, and every piece of evidence ages out after {@link SRE_GOVERNOR_MEMORY_MS}.
 *
 * FALSIFIER: test/sre-governor.test.ts.
 */

/** Every incident.event/incident.sampled row for one fingerprint, reduced to the evidence the
 *  design names: sample events, first/last seen, count, burn rate, deploy sha(s), instances. */
export interface IncidentEvidence {
  fingerprint: string;
  kind: string;
  name: string;
  /** Up to 3 distinct scrubbed sample messages, oldest first — "" when no row carried a message. */
  sampleMessages: string[];
  firstSeenMs: number;
  lastSeenMs: number;
  count: number;
  /** Events per hour over the observed span (a single event reads as 1 event/hour, not infinite). */
  burnPerHour: number;
  deployShas: string[];
  instances: string[];
}

// ── fast burn ────────────────────────────────────────────────────────────────────────────────

/** Still burning: the invariant timer and the incident ingest both re-ledger at least every few
 *  minutes while a failure persists, so a fingerprint silent this long is no longer a live burn. */
export const FAST_BURN_RECENT_MS = 15 * 60_000;
/** "console down or unusable": the board polls about once a minute per open tab, so a 5xx or a
 *  latency breach on half of one tab's polls for an hour is 30/hour — the console is unusable. */
export const FAST_BURN_PER_HOUR = 30;
const USER_VISIBLE_KINDS: ReadonlySet<string> = new Set(["http_5xx", "latency"]);
/** "fleet built nothing for hours": the two invariants whose windows ARE hours of no progress. */
const FLEET_STALL_RULES: ReadonlySet<string> = new Set([DISPATCH_STALL_RULE_ID, NO_MERGES_WITH_GREEN_QUEUE_RULE_ID]);

/** True only for a user-visible fast burn that is still burning at `nowMs`. Pure. */
export function isFastBurn(incident: Pick<IncidentEvidence, "kind" | "name" | "lastSeenMs" | "burnPerHour">, nowMs: number): boolean {
  if (nowMs - incident.lastSeenMs > FAST_BURN_RECENT_MS) return false;
  if (incident.kind === "invariant") return FLEET_STALL_RULES.has(incident.name);
  return USER_VISIBLE_KINDS.has(incident.kind) && incident.burnPerHour >= FAST_BURN_PER_HOUR;
}

// ── the verdict ──────────────────────────────────────────────────────────────────────────────

export const SRE_GOVERNOR_STEP = "sre.governor";

/** Only `live` acts; `shadow` records what it would do; `slow`/`stopped` hold. */
export type SreGovernorTier = "live" | "slow" | "shadow" | "stopped";
export interface SreGovernorVerdict {
  tier: SreGovernorTier;
  reason: string;
  /** The ledger facts behind the tier — each a short line a human can find again. */
  evidence?: string[];
  /** A stopped verdict that pages the operator (flapping, harm twice) — never a global hold. */
  escalate?: boolean;
  /** Stopped only because the emergency stop, a pause or quiet hours hold — lifts with the hold. */
  global?: boolean;
}

/** An `sre.runbook` receipt as the governor reads it: `ts_ms` is the ledger row's own instant. */
export interface SreGovernorReceipt {
  id: string;
  fingerprint: string;
  mode: SreGovernorTier;
  outcome: string;
  seen_ms?: number;
  ts_ms?: number;
}

/** One incident.event/incident.sampled row, reduced to what the governor needs. */
export interface SreGovernorIncident {
  fingerprint: string;
  /** Epoch ms. */
  ts: number;
  kind: string;
  name: string;
}

/** Fleet control state, each a detail string while held and `undefined` while not. */
export interface SreGovernorControls {
  emergencyStop?: string;
  pause?: string;
  quietHours?: string;
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** LOOP: an incident that returns this soon after a "successful" act is the same failure, not a
 *  new one. Derivation: four {@link FAST_BURN_RECENT_MS} windows — the invariant timers re-ledger a
 *  persisting failure inside one window, so a fix that held for four of them held. */
export const SRE_GOVERNOR_LOOP_WINDOW_MS = 4 * FAST_BURN_RECENT_MS;
/** HARM: a NEW fast-burning fingerprint that starts this soon after an act is charged to the act.
 *  Derivation: two {@link FAST_BURN_RECENT_MS} windows — a burn the act caused shows inside one
 *  detector window; the second absorbs ingest lag. */
export const SRE_GOVERNOR_BLAST_WINDOW_MS = 2 * FAST_BURN_RECENT_MS;
/** SLOW: the first backoff after a repeat on one fingerprint; it doubles per repeat and halves per
 *  clean day, never below this. Derivation: two {@link FAST_BURN_RECENT_MS} windows — long enough
 *  for the verify to settle and the detector to either re-fire or fall silent before a re-touch. */
export const SRE_GOVERNOR_BASE_BACKOFF_MS = 2 * FAST_BURN_RECENT_MS;
/** SELF-HEALING: a shadowed runbook earns live once its shadow record is this old AND every
 *  incident it would have acted on cleared without it. Derivation: one day — the shortest span that
 *  crosses every daily cycle (quiet hours, the merge rhythm, nightly timers) under which the loop
 *  or harm could recur, so a clean day has seen the conditions that produced it. */
export const SRE_GOVERNOR_SHADOW_CLEAN_MS = DAY_MS;
/** A fingerprint silent this long has cleared (the same recency {@link isFastBurn} reads). */
export const SRE_GOVERNOR_INCIDENT_CLEAR_MS = FAST_BURN_RECENT_MS;
/** Evidence older than this no longer counts. Derivation: one week — every weekly cycle has passed
 *  since a flap or harm, so a stopped runbook returns without a hand-kept allowlist. */
export const SRE_GOVERNOR_MEMORY_MS = 7 * DAY_MS;

/** The verdict for a runbook the ledger has never seen: the design's "a NEW runbook starts in shadow". */
export const NEW_RUNBOOK_VERDICT: SreGovernorVerdict = { tier: "shadow", reason: "new runbook: starts in shadow and earns live on a clean shadow record" };

const isAct = (r: SreGovernorReceipt): boolean => r.mode === "live" && (r.outcome === "cleared" || r.outcome === "failed");
const isSuccess = (r: SreGovernorReceipt): boolean => r.mode === "live" && r.outcome === "cleared";
const short = (fp: string): string => fp.slice(0, 12);

interface Demerit {
  atMs: number;
  line: string;
}

/** Each runbook id's verdict — the catalog ids first (so a new one reads shadow), then every id a
 *  receipt names. Pure: the same ledger yields the same verdicts in any process. */
export function sreGovernorVerdict(
  receipts: readonly SreGovernorReceipt[],
  incidents: readonly SreGovernorIncident[],
  controls: SreGovernorControls,
  nowMs: number,
  runbookIds: readonly string[] = [],
): Record<string, SreGovernorVerdict> {
  const horizon = nowMs - SRE_GOVERNOR_MEMORY_MS;
  const timed = receipts
    .filter((r): r is SreGovernorReceipt & { ts_ms: number } => typeof r.ts_ms === "number" && r.ts_ms <= nowMs)
    .sort((a, b) => a.ts_ms - b.ts_ms);
  const ids = [...new Set([...runbookIds, ...timed.map((r) => r.id)])];
  const out: Record<string, SreGovernorVerdict> = {};

  const hold = globalHold(controls);
  if (hold) {
    for (const id of ids) out[id] = { tier: "stopped", reason: hold, global: true };
    return out;
  }

  const events = new Map<string, number[]>();
  for (const e of incidents) {
    if (e.ts > nowMs) continue;
    const list = events.get(e.fingerprint);
    if (list) list.push(e.ts);
    else events.set(e.fingerprint, [e.ts]);
  }
  for (const list of events.values()) list.sort((a, b) => a - b);
  const firedIn = (fp: string, fromMs: number, toMs: number): number | undefined => events.get(fp)?.find((t) => t > fromMs && t <= toMs);
  const burns = fastBurnStarts(incidents, nowMs);
  const recent = timed.filter((r) => r.ts_ms >= horizon);

  // Recent evidence STOPS; all evidence dates the shadow record — so a stop ages into shadow, never live.
  const flapsRecent = flappingPairs(recent, firedIn, timed);
  const flapsAll = flappingPairs(timed, firedIn, timed);
  for (const id of ids) {
    const own = timed.filter((r) => r.id === id);
    const flap = flapsRecent.get(id) ?? [];
    const harmsAll = harmsOf(own, burns);
    const harms = harmsAll.filter((h) => h.atMs >= horizon);
    if (flap.length > 0 || harms.length >= 2) {
      const why = flap.length > 0 ? `flapping: ${flap[0].line}` : `harm seen twice: ${harms.map((h) => h.line).join("; ")}`;
      out[id] = { tier: "stopped", reason: why, evidence: [...flap, ...harms].map((d) => d.line), escalate: true };
      continue;
    }
    const demerits = [...loopsOf(own, firedIn), ...harmsAll, ...(flapsAll.get(id) ?? [])].sort((a, b) => a.atMs - b.atMs);
    const latest = demerits[demerits.length - 1];
    const shadowStart = latest?.atMs ?? own[0]?.ts_ms;
    if (shadowStart === undefined) {
      out[id] = NEW_RUNBOOK_VERDICT;
      continue;
    }
    const record = shadowRecord(own, shadowStart, events, nowMs);
    if (!record.clean) {
      const why = latest ? `${latest.line}; ${record.why}` : `new runbook; ${record.why}`;
      out[id] = { tier: "shadow", reason: why, evidence: demerits.map((d) => d.line) };
      continue;
    }
    const slow = backoff(own.filter(isAct), nowMs);
    out[id] = slow ?? { tier: "live", reason: latest ? `earned live after ${latest.line}: ${record.why}` : `earned live: ${record.why}` };
  }
  return out;
}

/** A runbook's verdict out of a map — {@link NEW_RUNBOOK_VERDICT} when the ledger never named it. */
export function verdictFor(verdicts: Record<string, SreGovernorVerdict>, runbookId: string): SreGovernorVerdict {
  return verdicts[runbookId] ?? NEW_RUNBOOK_VERDICT;
}

function globalHold(controls: SreGovernorControls): string | undefined {
  if (controls.emergencyStop !== undefined) return `emergency stop holds: ${controls.emergencyStop}`;
  if (controls.pause !== undefined) return `pause holds: ${controls.pause}`;
  if (controls.quietHours !== undefined) return `quiet hours hold: ${controls.quietHours}`;
  return undefined;
}

/** Each fast-burning fingerprint's first-seen instant. "Fast-burning" is judged at the burn's own
 *  last event, so a burn that has since stopped still counts against the act that started it. */
function fastBurnStarts(incidents: readonly SreGovernorIncident[], nowMs: number): Map<string, number> {
  const by = new Map<string, SreGovernorIncident[]>();
  for (const e of incidents) {
    if (e.ts > nowMs) continue;
    const list = by.get(e.fingerprint);
    if (list) list.push(e);
    else by.set(e.fingerprint, [e]);
  }
  const out = new Map<string, number>();
  for (const [fp, rows] of by) {
    const ts = rows.map((r) => r.ts).sort((a, b) => a - b);
    const first = ts[0];
    const last = ts[ts.length - 1];
    const burnPerHour = rows.length / Math.max(1, (last - first) / HOUR_MS);
    const newest = rows.find((r) => r.ts === last) as SreGovernorIncident;
    if (isFastBurn({ kind: newest.kind, name: newest.name, lastSeenMs: last, burnPerHour }, last)) out.set(fp, first);
  }
  return out;
}

/** HARM: a NEW fast-burning fingerprint (not the one acted on) first seen inside an act's blast
 *  window. One demerit per burn fingerprint, charged to the first act that precedes it. */
function harmsOf(own: readonly (SreGovernorReceipt & { ts_ms: number })[], burns: Map<string, number>): Demerit[] {
  const out: Demerit[] = [];
  for (const [fp, startMs] of burns) {
    const act = own.find((r) => isAct(r) && r.fingerprint !== fp && startMs > r.ts_ms && startMs <= r.ts_ms + SRE_GOVERNOR_BLAST_WINDOW_MS);
    if (act) out.push({ atMs: startMs, line: `harm: fast burn ${short(fp)} started after ${act.id} acted on ${short(act.fingerprint)}` });
  }
  return out;
}

/** LOOP: the acted-on incident fired again inside the loop window after a "successful" act. */
function loopsOf(own: readonly (SreGovernorReceipt & { ts_ms: number })[], firedIn: (fp: string, from: number, to: number) => number | undefined): Demerit[] {
  const out: Demerit[] = [];
  for (const r of own.filter(isSuccess)) {
    const again = firedIn(r.fingerprint, r.ts_ms, r.ts_ms + SRE_GOVERNOR_LOOP_WINDOW_MS);
    if (again !== undefined) out.push({ atMs: again, line: `loop: ${short(r.fingerprint)} re-fired after ${r.id} cleared it` });
  }
  return out;
}

/** FLAPPING, per runbook: A's success precedes B's incident, B's success follows, and A's incident
 *  fires again after B's success — each step inside the loop window. Both A and B are charged. */
function flappingPairs(
  receipts: readonly (SreGovernorReceipt & { ts_ms: number })[],
  firedIn: (fp: string, from: number, to: number) => number | undefined,
  all: readonly (SreGovernorReceipt & { ts_ms: number })[],
): Map<string, Demerit[]> {
  const out = new Map<string, Demerit[]>();
  const charge = (id: string, d: Demerit) => out.set(id, [...(out.get(id) ?? []), d]);
  const successes = receipts.filter(isSuccess);
  for (const a of successes) {
    for (const b of successes) {
      if (b.id === a.id || b.ts_ms <= a.ts_ms || b.ts_ms > a.ts_ms + SRE_GOVERNOR_LOOP_WINDOW_MS) continue;
      const bFired = firedIn(b.fingerprint, a.ts_ms, b.ts_ms) ?? (b.seen_ms !== undefined && b.seen_ms > a.ts_ms ? b.seen_ms : undefined);
      if (bFired === undefined) continue;
      const aAgain = firedIn(a.fingerprint, b.ts_ms, b.ts_ms + SRE_GOVERNOR_LOOP_WINDOW_MS) ?? reSeen(all, a, b.ts_ms);
      if (aAgain === undefined) continue;
      const line = `${a.id} and ${b.id} re-fire each other (${short(a.fingerprint)} <-> ${short(b.fingerprint)})`;
      charge(a.id, { atMs: aAgain, line });
      charge(b.id, { atMs: aAgain, line });
    }
  }
  return out;
}

/** A later receipt of A's own runbook on A's fingerprint whose incident was seen after `afterMs`. */
function reSeen(all: readonly (SreGovernorReceipt & { ts_ms: number })[], a: SreGovernorReceipt, afterMs: number): number | undefined {
  const r = all.find((x) => x.id === a.id && x.fingerprint === a.fingerprint && x.seen_ms !== undefined && x.seen_ms > afterMs && x.seen_ms <= afterMs + SRE_GOVERNOR_LOOP_WINDOW_MS);
  return r?.seen_ms;
}

/** CLEAN: the shadow record is at least {@link SRE_GOVERNOR_SHADOW_CLEAN_MS} old, holds at least
 *  one `would_act`, and every fingerprint it would have acted on went quiet afterwards. */
function shadowRecord(
  own: readonly (SreGovernorReceipt & { ts_ms: number })[],
  startMs: number,
  events: Map<string, number[]>,
  nowMs: number,
): { clean: boolean; why: string } {
  if (nowMs - startMs < SRE_GOVERNOR_SHADOW_CLEAN_MS) return { clean: false, why: `shadow record is younger than ${SRE_GOVERNOR_SHADOW_CLEAN_MS / HOUR_MS}h` };
  const latest = new Map<string, number>();
  for (const r of own) if (r.ts_ms >= startMs && r.mode === "shadow" && r.outcome === "would_act") latest.set(r.fingerprint, r.ts_ms);
  if (latest.size === 0) return { clean: false, why: "no shadow receipt yet shows what it would have done" };
  for (const [fp, atMs] of latest) {
    if (!quietAfter(events.get(fp) ?? [], atMs, nowMs)) return { clean: false, why: `${short(fp)} has not cleared since its shadow receipt` };
  }
  return { clean: true, why: `${latest.size} incident(s) it would have acted on cleared without it` };
}

/** True when a fingerprint fell silent for {@link SRE_GOVERNOR_INCIDENT_CLEAR_MS} at some point after `fromMs`. */
function quietAfter(times: readonly number[], fromMs: number, nowMs: number): boolean {
  let prev = fromMs;
  for (const t of times) {
    if (t <= fromMs) continue;
    if (t - prev >= SRE_GOVERNOR_INCIDENT_CLEAR_MS) return true;
    prev = t;
  }
  return nowMs - prev >= SRE_GOVERNOR_INCIDENT_CLEAR_MS;
}

/** SLOW: a fingerprint re-acted on inside its backoff. The window doubles per repeat, halves per
 *  clean day between acts and since the last one, and never drops below the base. */
function backoff(acts: readonly (SreGovernorReceipt & { ts_ms: number })[], nowMs: number): SreGovernorVerdict | undefined {
  const byFp = new Map<string, number[]>();
  for (const a of acts) byFp.set(a.fingerprint, [...(byFp.get(a.fingerprint) ?? []), a.ts_ms]);
  for (const [fp, times] of byFp) {
    let window = SRE_GOVERNOR_BASE_BACKOFF_MS;
    let repeats = 0;
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      window = decay(window, gap);
      if (gap < window) window = SRE_GOVERNOR_BASE_BACKOFF_MS * 2 ** ++repeats;
    }
    const last = times[times.length - 1];
    const effective = decay(window, nowMs - last);
    if (repeats > 0 && nowMs - last < effective) {
      return { tier: "slow", reason: `${short(fp)} acted on again inside its backoff (${repeats} repeat(s)); next act after ${Math.ceil((last + effective - nowMs) / 60_000)}m`, evidence: [`${times.length} acts on ${short(fp)}`] };
    }
  }
  return undefined;
}

function decay(window: number, elapsedMs: number): number {
  return Math.max(SRE_GOVERNOR_BASE_BACKOFF_MS, window / 2 ** Math.floor(elapsedMs / DAY_MS));
}

// ── ledger rows ──────────────────────────────────────────────────────────────────────────────

/** An incident.event/incident.sampled ledger row reduced to a {@link SreGovernorIncident} —
 *  `undefined` for any other step or a torn row. */
export function governorIncidentFromLedgerRow(row: Record<string, unknown>): SreGovernorIncident | undefined {
  if (row.step !== "incident.event" && row.step !== "incident.sampled") return undefined;
  const { fingerprint, kind, name, ts } = row;
  if (typeof fingerprint !== "string" || typeof kind !== "string" || typeof name !== "string" || typeof ts !== "string") return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? { fingerprint, kind, name, ts: ms } : undefined;
}

/** The tier each runbook's newest `sre.governor` row moved it to, when, and whether that stop was a
 *  global hold — the "from" of the next change, read from the ledger so two enforcers agree on it. */
export interface GovernorLedgerTier {
  tier: SreGovernorTier;
  atMs: number;
  global: boolean;
}

export function governorTiersFromLedger(rows: readonly Record<string, unknown>[]): Map<string, GovernorLedgerTier> {
  const out = new Map<string, GovernorLedgerTier>();
  for (const row of rows) {
    if (row.step !== SRE_GOVERNOR_STEP || typeof row.runbook !== "string" || typeof row.to !== "string") continue;
    if (!["live", "slow", "shadow", "stopped"].includes(row.to)) continue;
    const atMs = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    out.set(row.runbook, { tier: row.to as SreGovernorTier, atMs: Number.isFinite(atMs) ? atMs : 0, global: row.global === true });
  }
  return out;
}
