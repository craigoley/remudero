/**
 * test-slot-queue — the FIFO a test-slot waiter joins, so a host-wide slot goes to the run that
 * ARRIVED first rather than to whichever waiter's poll lands first after a release (W1-T9950).
 *
 * MEASURED 2026-10-16 (origin/main d50367256), three processes on one private slot dir, slots 1:
 * a holder held 6 s, waiter A arrived at 1.6 s (poll 3 s), waiter B at 4.1 s (poll 200 ms); B took
 * the slot at 6.3 s and A only at 7.7 s. Waiters kept no shared ordering state, and each printed one
 * `test_slot.waiting` row and then nothing for up to 45 min.
 *
 * Layout, in the sibling `<slot dir>.queue/` (NOT inside the slot dir: every reader of the slot dir
 * treats each entry as a slot record, and a released dir is asserted EMPTY):
 *   `<arrival>-<seq>-<nonce>.json` — one ticket per waiter; names sort in arrival order;
 *   `hold-history.ndjson`          — one `{label, heldMs, concurrency, endedAt}` row per released hold.
 * A ticket carries NO authority over any slot record; it orders waiters and nothing else.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { isHolderStale, reclaimStaleLock } from "./fs-race-safe.js";
import { sameHost } from "./host-identity.js";

/** One waiter's place in line. Written whole (temp + link/rename), so a reader never sees half of one. */
export interface TestSlotTicket {
  pid: number;
  host: string;
  bootId?: string;
  pidNs?: string;
  processStart?: string;
  label: string;
  nonce: string;
  arrivedAt: string;
  heartbeatAt: string;
  /** The poll interval this waiter really beats at; a foreign ticket's staleness bound is derived from it. */
  heartbeatIntervalMs: number;
}

export interface QueuedTicket {
  name: string;
  ticket: TestSlotTicket;
}

/** What judging a ticket needs from the host — the same seams `testSlotHolderStale` reads. */
export interface TicketJudge {
  now(): number;
  hostname(): string;
  bootId(): string | undefined;
  pidNamespace(): string | undefined;
  isPidAlive(pid: number): boolean;
  /** Missed beats past which a foreign ticket is dead: the multiple W1-T9928 applies to a slot record's cadence. */
  silentBeats: number;
}

export interface HoldRecord {
  label: string;
  heldMs: number;
  concurrency: number;
  endedAt: string;
}

export interface QueueHolderView {
  slot: number;
  label?: string;
  pid?: number;
  elapsedMs?: number;
}

export interface QueueEta {
  etaMs?: number;
  basis: string;
}

const TICKET_NAME = /^[0-9]{16}-[0-9]{8}-[A-Za-z0-9-]+\.json$/;
export const TEST_SLOT_HOLD_HISTORY = "hold-history.ndjson";
let ticketSequence = 0;

/** The sibling directory a slot dir's queue and hold history live in. */
export function testSlotQueueDir(slotDir: string): string {
  return join(dirname(slotDir), `${basename(slotDir)}.queue`);
}

/** Zero-padded arrival ms, then a per-process sequence, then the nonce: lexical order IS arrival order. */
export function testSlotTicketName(arrivedAtMs: number, sequence: number, nonce: string): string {
  return `${String(Math.max(0, Math.trunc(arrivedAtMs))).padStart(16, "0")}-${String(sequence).padStart(8, "0")}-${nonce}.json`;
}

export function parseTestSlotTicket(raw: string): TestSlotTicket | null {
  try {
    const t = JSON.parse(raw);
    if (typeof t !== "object" || t === null) return null;
    if (!Number.isSafeInteger(t.pid) || typeof t.host !== "string" || typeof t.label !== "string" || typeof t.nonce !== "string" ||
        !Number.isFinite(Date.parse(t.arrivedAt)) || !Number.isFinite(Date.parse(t.heartbeatAt)) ||
        !Number.isSafeInteger(t.heartbeatIntervalMs) || t.heartbeatIntervalMs < 1) return null;
    return t as TestSlotTicket;
  } catch (error) {
    // A ticket is written whole, so unparseable bytes are garbage, not a write in progress: reapable.
    void error;
    return null;
  }
}

/**
 * Why `ticket` names no live waiter, or undefined while it does — the rules `testSlotHolderStale` applies to
 * a slot record. Same host and pid namespace: the pid and its start time. Foreign: a different boot id, then
 * a heartbeat older than `silentBeats` of the ticket's OWN recorded cadence. Never a signal.
 */
export function testSlotTicketDeadReason(ticket: TestSlotTicket, judge: TicketJudge): string | undefined {
  const mineNs = judge.pidNamespace();
  const foreignNs = ticket.pidNs !== undefined && mineNs !== undefined && ticket.pidNs !== mineNs;
  if (sameHost(ticket.host, judge.hostname()) && !foreignNs) {
    return isHolderStale({ pid: ticket.pid, host: ticket.host, startedAt: ticket.arrivedAt },
      { isPidAlive: judge.isPidAlive, hostname: judge.hostname }) ? "waiter pid is gone or was reused" : undefined;
  }
  const mine = judge.bootId();
  if (ticket.bootId !== undefined && mine !== undefined && ticket.bootId !== mine) return "waiter's kernel boot id is not this boot";
  const silentMs = judge.now() - Date.parse(ticket.heartbeatAt), boundMs = judge.silentBeats * ticket.heartbeatIntervalMs;
  return silentMs > boundMs ? `foreign heartbeat silent ${silentMs}ms > ${judge.silentBeats} × its ${ticket.heartbeatIntervalMs}ms cadence` : undefined;
}

/**
 * The live tickets in arrival order. Every dead ticket met on the way is unlinked through
 * {@link reclaimStaleLock} (identity- and bytes-checked) and logged `test_slot.ticket_reaped`. `own`, the
 * caller's ticket, is live by definition and never judged.
 */
export function readTestSlotQueue(slotDir: string, judge: TicketJudge, log: (row: Record<string, unknown>) => void,
  own?: string): QueuedTicket[] {
  const queueDir = testSlotQueueDir(slotDir);
  let names: string[];
  try { names = readdirSync(queueDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const live: QueuedTicket[] = [];
  for (const name of names.filter(n => TICKET_NAME.test(n)).sort()) {
    const path = join(queueDir, name);
    let reason: string | undefined;
    const result = reclaimStaleLock(path, {
      parseHolder: parseTestSlotTicket,
      isStale: ticket => name !== own && (reason = testSlotTicketDeadReason(ticket, judge)) !== undefined,
      onReclaim: ({ raw }) => {
        const ticket = parseTestSlotTicket(raw);
        log({ step: "test_slot.ticket_reaped", ticket: name, pid: ticket?.pid, host: ticket?.host, label: ticket?.label,
          reason: reason ?? "unreadable ticket" });
      },
      onLostReclaim: () => {},
    });
    if (result.outcome === "live") live.push({ name, ticket: result.holder });
  }
  return live;
}

/** This waiter's ticket: `beat` rewrites heartbeatAt (recreating it if a peer reaped it), `drop` removes it. */
export interface OwnTicket {
  name: string;
  path: string;
  beat(heartbeatAt: string): void;
  drop(): void;
}

function writeWhole(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o644 });
  chmodSync(path, 0o644); // The legacy slot record's mode: every peer, of any uid, reads it.
}

/**
 * Run `write` inside the queue dir, created world-writable like the slot dir. The last waiter to leave removes
 * the dir while it is EMPTY, so a peer's rmdir can land between our mkdir and our write: that one ENOENT is
 * retried once, and after `write` our own entry keeps the dir non-empty.
 */
function inQueueDir(queueDir: string, write: () => void): void {
  for (let attempt = 0; ; attempt += 1) {
    mkdirSync(queueDir, { recursive: true, mode: 0o777 });
    if ((statSync(queueDir).mode & 0o777) !== 0o777 && statSync(queueDir).uid === process.getuid?.()) chmodSync(queueDir, 0o777);
    try { write(); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt > 0) throw error;
    }
  }
}

/**
 * Join the queue. The ticket is written to a dot-temp name and LINKED into place, so it appears whole
 * or not at all. A process `exit` handler removes it if the waiter ends without leaving the queue; a
 * waiter killed by a signal leaves a ticket whose pid is dead, which the next waiter reaps.
 * WHY NO SIGNAL HANDLER: the synchronous waiter blocks its event loop in `Atomics.wait`, so a SIGINT or
 * SIGTERM listener would only defer the signal — a waiter that cannot be interrupted for 45 min.
 */
export function takeTestSlotTicket(slotDir: string, fields: Omit<TestSlotTicket, "nonce">,
  onExit: (handler: () => void) => () => void = handler => {
    process.on("exit", handler);
    return () => void process.removeListener("exit", handler);
  }): OwnTicket {
  const queueDir = testSlotQueueDir(slotDir);
  const nonce = randomUUID();
  ticketSequence += 1;
  const name = testSlotTicketName(Date.parse(fields.arrivedAt), ticketSequence, nonce), path = join(queueDir, name);
  const temp = join(queueDir, `.${nonce}.tmp`);
  let current: TestSlotTicket = { ...fields, nonce };
  inQueueDir(queueDir, () => {
    writeWhole(temp, JSON.stringify(current));
    try { linkSync(temp, path); } finally { unlinkSync(temp); }
  });
  let dropped = false;
  const unlinkOwn = (): void => {
    try { unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { rmdirSync(queueDir); }
    catch (error) {
      // rmdir removes only an EMPTY dir: waiting peers, a hold history, another uid's dir or one already gone all
      // keep it, for whoever empties it last. Nothing is lost by keeping it.
      void error;
    }
  };
  const detach = onExit(unlinkOwn);
  return {
    name, path,
    beat(heartbeatAt: string): void {
      if (dropped) return;
      current = { ...current, heartbeatAt };
      inQueueDir(queueDir, () => {
        writeWhole(temp, JSON.stringify(current));
        renameSync(temp, path);
      });
    },
    drop(): void {
      if (dropped) return;
      dropped = true;
      detach();
      unlinkOwn();
    },
  };
}

/** Released holds, oldest first; a malformed row is skipped, never guessed at. */
export function readHoldHistory(slotDir: string): HoldRecord[] {
  let raw: string;
  try { raw = readFileSync(join(testSlotQueueDir(slotDir), TEST_SLOT_HOLD_HISTORY), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: HoldRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r?.label === "string" && Number.isFinite(r.heldMs) && r.heldMs >= 0 && typeof r.endedAt === "string") rows.push(r as HoldRecord);
    } catch (error) {
      // A torn or foreign line is not a measurement; the rest of the history still is.
      void error;
    }
  }
  return rows;
}

/**
 * Holds kept PER LABEL: `2 × slots + 1`. Odd, so a full window's median is one real measured hold; and two
 * full rounds of every slot plus one, so once a suite gets slower its new holds are the window's majority —
 * and move the median — after `slots + 1` of them.
 */
export function holdRetention(slots: number): number {
  return 2 * Math.max(1, Math.trunc(slots)) + 1;
}

/**
 * Append one released hold, keeping the newest {@link holdRetention} holds of each label. Rewritten through a
 * temp file and an atomic rename; two releases racing can lose one sample — the history is an estimate's
 * input, never a lock. Recorded only once the queue dir EXISTS (a slot dir's first contention made it): an
 * uncontended dir has nobody to give an ETA to, and a fixture's slot dir inside a work tree stays clean.
 * Returns whether the hold was recorded.
 */
export function recordTestSlotHold(slotDir: string, hold: HoldRecord, slots: number): boolean {
  const queueDir = testSlotQueueDir(slotDir);
  try { if (!statSync(queueDir).isDirectory()) return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const keep = holdRetention(slots), all = [...readHoldHistory(slotDir), hold], kept: HoldRecord[] = [];
  const seen = new Map<string, number>();
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const n = (seen.get(all[i]!.label) ?? 0) + 1;
    seen.set(all[i]!.label, n);
    if (n <= keep) kept.unshift(all[i]!);
  }
  const temp = join(queueDir, `.hold-${randomUUID()}.tmp`);
  writeFileSync(temp, kept.map(r => JSON.stringify(r)).join("\n") + "\n", { mode: 0o666 });
  chmodSync(temp, 0o666);
  renameSync(temp, join(queueDir, TEST_SLOT_HOLD_HISTORY));
  return true;
}

/** The median of `label`'s measured holds — the lower middle, so it is always one real hold — or undefined. */
export function medianHold(history: readonly HoldRecord[], label: string): { ms: number; count: number } | undefined {
  const held = history.filter(r => r.label === label).map(r => r.heldMs).sort((a, b) => a - b);
  if (held.length === 0) return undefined;
  return { ms: held[Math.floor((held.length - 1) / 2)]!, count: held.length };
}

/**
 * When this waiter can expect a slot: each live holder needs max(0, estimate − elapsed), each ticket ahead
 * needs its label's estimate, and slots are served FIFO. A label with no measured hold makes the ETA
 * unknown, and says which — it never invents a number.
 */
export function estimateQueueEta(input: { slots: number; holders: readonly QueueHolderView[];
  ahead: readonly { label: string }[]; history: readonly HoldRecord[] }): QueueEta {
  const used = new Map<string, number>();
  const estimate = (label: string | undefined): number | string => {
    if (label === undefined) return "ETA unknown: a holder's record names no label";
    const m = medianHold(input.history, label);
    if (!m) return `ETA unknown: no measured holds of ${label}`;
    used.set(label, m.count);
    return m.ms;
  };
  const free: number[] = [];
  for (const h of input.holders) {
    const e = estimate(h.label);
    if (typeof e === "string") return { basis: e };
    free.push(Math.max(0, e - (h.elapsedMs ?? 0)));
  }
  while (free.length < Math.max(1, input.slots)) free.push(0);
  for (const t of input.ahead) {
    const e = estimate(t.label);
    if (typeof e === "string") return { basis: e };
    const i = free.indexOf(Math.min(...free));
    free[i] = free[i]! + e;
  }
  const basis = [...used].map(([label, count]) => `${count} measured ${label} hold${count === 1 ? "" : "s"}`).join(", ");
  return { etaMs: Math.min(...free), basis: basis ? `median of ${basis}` : "a slot is open now" };
}

function ordinal(n: number): string {
  const tens = n % 100, ones = n % 10;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ones === 1 ? "st" : ones === 2 ? "nd" : ones === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** The one human line a waiter prints whenever where it stands changes. */
export function describeQueuePosition(position: number, ahead: readonly { label: string; pid: number }[],
  holders: readonly QueueHolderView[], eta: QueueEta): string {
  const behind = ahead.length > 0 ? ahead.map(t => `${t.label} (pid ${t.pid})`).join(", ")
    : holders.map(h => `${h.label ?? `slot ${h.slot}`}${h.pid === undefined ? "" : ` (pid ${h.pid})`}`).join(", ") || "the slot holders";
  const when = eta.etaMs === undefined ? eta.basis : `~${Math.max(1, Math.round(eta.etaMs / 60_000))} min (${eta.basis})`;
  return `test slot: ${ordinal(position)} in queue behind ${behind}; ${when}`;
}
