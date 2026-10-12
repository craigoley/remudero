import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { systemClock, type Clock } from "./clock.js";
import { acquireDrainLock, DrainLockError } from "./drain-lock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { invalidateDraft, loadProposalRegistry, parseDraftAttemptCache, parseDraftCache, parseProposalRegistryResult, writeDraftAttemptPair } from "./inbox.js";
import { inboxKind } from "./inbox-owner.js";
import { appendLedger } from "./ledger.js";
import { createIncrementalLedgerUnion } from "./ledger-union.js";

/**
 * lib/inbox-replay.ts (W1-T8714) — a one-shot replay of the proposals the band split lost.
 *
 * Until W1-T8714 the inbox draft lint never asked for `band_meaning`, and the approve floor refused a risk:high task
 * without one: 53 approve.error rows over 40 READY proposals (2026-09-25 to 2026-10-12), none of which ever filed.
 * This sends each of them back through the ORDINARY inbox path. It drops the cached draft, so the draft rung
 * re-drafts it under the now-shared lint, and the fleet lane's FILE step hands the new draft to `rmd approve`. It
 * never writes a shard, a plan file or a ratification row itself, and it calls no approve.
 *
 * THE POPULATION IS MEASURED, NOT LISTED: read from the ledger union, never the live file alone. A proposal is in it
 * when its LATEST approve outcome is the band refusal and no approve.shards_written row ever names it. The
 * population is the bound. An incomplete union read, or one with zero approve rows (the positive control), seeds
 * nothing and writes `inbox.replay_deferred`, so the next pass tries again.
 *
 * ITS MEMORY IS ITS OWN STORE, `state/inbox-replay-band-meaning.json`, never the live ledger, which rotates every few
 * minutes (fleet-lane.ts gives the same reason). A store that exists is never re-seeded, an outcome is stored before
 * its `inbox.replayed` row is written, and once every proposal has an outcome a pass reads only the store.
 */

export const BAND_MEANING_REPLAY_STORE = "inbox-replay-band-meaning.json";

/** The refusal text `sizingViolation` (task-linter.ts) gives a new risk:high task that declares no band. */
const BAND_REFUSAL = "risk:high with no band_meaning declared";
/** `draftedDuplicateRefusal`'s (inbox.ts) own wording, for a duplicate that surfaces as an approve.error. */
const DUPLICATE_REFUSAL = "a task record already on origin/main";
const SUPERSEDED_STATES: ReadonlySet<string> = new Set(["ratified", "declined", "retired"]);
const REPLAY_STEPS = ["approve.error", "approve.shards_written", "ratify.approve_refused", "inbox.drafted"] as const;

export type BandMeaningReplayOutcome = "refiled" | "skipped_superseded" | "refused" | "redraft_not_ready";

export interface BandMeaningReplayEntry {
  family: string;
  /** When the replay dropped its cached draft and attempt key. Absent until then. */
  invalidatedAt?: string;
  outcome?: { outcome: BandMeaningReplayOutcome; at: string; reason?: string; unresolved_violations?: string[] };
}

export interface BandMeaningReplayStore {
  seededAt: string;
  proposals: Record<string, BandMeaningReplayEntry>;
}

export interface BandMeaningReplayInput {
  stateDir: string;
  ledgerPath: string;
  /** Each proposal's classification state, as serve's slow lane last wrote it (fleet-lane.ts's
   *  `readClassificationSnapshot`); undefined when none is readable, and the state check is then skipped. */
  classificationStates: () => Record<string, string> | undefined;
  clock?: Clock;
}

export interface BandMeaningReplayPass {
  seeded: boolean;
  invalidated: string[];
  recorded: Array<{ proposalId: string; outcome: BandMeaningReplayOutcome }>;
  /** Why this pass did nothing; absent when it ran. */
  deferred?: string;
  complete: boolean;
}

const bandMeaningUnion = createIncrementalLedgerUnion({ holder: "inbox-replay-band-meaning", reducerVersion: "1" });
/** The last deferral reason written per state dir, so an unchanged reason is not re-written every pass. */
const lastDeferral = new Map<string, string>();

export function bandMeaningReplayStorePath(stateDir: string): string {
  return join(stateDir, BAND_MEANING_REPLAY_STORE);
}

/** The replay's store; undefined when none was ever seeded. An unreadable store THROWS: read as absent, it would be
 *  re-seeded and every proposal handled again. */
export function readBandMeaningReplayStore(stateDir: string): BandMeaningReplayStore | undefined {
  const path = bandMeaningReplayStorePath(stateDir);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BandMeaningReplayStore>;
  if (typeof parsed.seededAt !== "string" || !parsed.proposals || typeof parsed.proposals !== "object") {
    throw new Error(`inbox-replay: ${path} is not a replay store`);
  }
  return parsed as BandMeaningReplayStore;
}

/** Every proposal id a row names: its task_id (unless BATCH), proposal_id, proposal_ids, and for an error the ids
 *  its "refusing to file <id> —" text names. */
function namedProposals(row: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  if (typeof row.task_id === "string" && row.task_id !== "BATCH") ids.add(row.task_id);
  if (typeof row.proposal_id === "string") ids.add(row.proposal_id);
  if (Array.isArray(row.proposal_ids)) for (const id of row.proposal_ids) if (typeof id === "string") ids.add(id);
  if (row.task_id === "BATCH" && typeof row.error === "string") {
    for (const m of row.error.matchAll(/refusing to file (\S+) —/g)) ids.add(m[1]);
  }
  return [...ids];
}

const isApproveOutcome = (row: Record<string, unknown>): boolean =>
  (row.step === "approve.error" || row.step === "approve.shards_written") && typeof row.ts === "string";

/** The lost population: latest approve outcome is the band refusal, and no approve.shards_written ever names it. */
export function bandMeaningPopulation(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  const latest = new Map<string, Record<string, unknown>>();
  const filed = new Set<string>();
  for (const row of rows) {
    if (!isApproveOutcome(row)) continue;
    for (const id of namedProposals(row)) {
      if (row.step === "approve.shards_written") filed.add(id);
      const prior = latest.get(id);
      if (!prior || String(row.ts) >= String(prior.ts)) latest.set(id, row);
    }
  }
  return [...latest.entries()]
    .filter(([id, row]) => !filed.has(id) && row.step === "approve.error" && String(row.error ?? "").includes(BAND_REFUSAL))
    .map(([id]) => id)
    .sort();
}

type Outcome = NonNullable<BandMeaningReplayEntry["outcome"]>;

/** What the ledger says happened to `id` after the seed, or undefined while nothing has. */
function ledgerOutcome(id: string, entry: BandMeaningReplayEntry, after: ReadonlyArray<Record<string, unknown>>, at: string): Outcome | undefined {
  const named = after.filter((row) => namedProposals(row).includes(id));
  if (named.some((row) => row.step === "approve.shards_written")) return { outcome: "refiled", at };
  const dup = named.find((row) => row.step === "ratify.approve_refused" && typeof row.duplicate_of === "string");
  if (dup) return { outcome: "skipped_superseded", at, reason: `duplicate of ${String(dup.duplicate_of)}` };
  const error = named.find((row) => row.step === "approve.error");
  if (error) {
    const text = String(error.error ?? "");
    if (text.includes(DUPLICATE_REFUSAL)) {
      return { outcome: "skipped_superseded", at, reason: `duplicate of ${/against (\S+) —/.exec(text)?.[1] ?? "a filed task"}` };
    }
    return { outcome: "refused", at, reason: text };
  }
  const drafted = named.find((row) => row.step === "inbox.drafted" && row.lint_clean === false &&
    entry.invalidatedAt !== undefined && String(row.ts) > entry.invalidatedAt);
  if (drafted) {
    const unresolved = Array.isArray(drafted.unresolved_violations) ? drafted.unresolved_violations.map(String) : [];
    return { outcome: "redraft_not_ready", at, unresolved_violations: unresolved };
  }
  return undefined;
}

/** The registry's ids, or undefined when it cannot be judged: an absent or faulted blob would read every proposal
 *  as gone. Blob plus `inbox-proposals.d/` shards, as `loadProposalRegistry` reads them (W1-T2490). */
function registryIds(stateDir: string): ReadonlySet<string> | undefined {
  const registryPath = join(stateDir, "inbox-proposals.json");
  const blob = parseProposalRegistryResult(existsSync(registryPath) ? readFileSync(registryPath, "utf8") : undefined);
  if (blob.kind !== "ok") return undefined;
  try {
    return new Set(loadProposalRegistry(registryPath).map((p) => p.id));
  } catch {
    // deliberate: a colliding shard set cannot say what is absent, so this pass judges no absence.
    return undefined;
  }
}

/** Drop each proposal's cached draft and attempt key, applied to the caches as they are on disk NOW and under the
 *  draft rung's own lock, so a batch in flight cannot write the dropped draft back. False when the lock is held. */
function invalidateDrafts(stateDir: string, ids: readonly string[]): boolean {
  let lock;
  try {
    lock = acquireDrainLock(join(stateDir, "inbox-draft.lock"));
  } catch (e) {
    if (e instanceof DrainLockError) return false;
    throw e;
  }
  try {
    const draftsPath = join(stateDir, "inbox-drafts.json");
    const attemptsPath = join(stateDir, "inbox-draft-attempts.json");
    let drafts = parseDraftCache(existsSync(draftsPath) ? readFileSync(draftsPath, "utf8") : undefined);
    const attempts = parseDraftAttemptCache(existsSync(attemptsPath) ? readFileSync(attemptsPath, "utf8") : undefined);
    if (!ids.some((id) => id in drafts || id in attempts)) return true;
    for (const id of ids) {
      drafts = invalidateDraft(drafts, id);
      delete attempts[id];
    }
    writeDraftAttemptPair(draftsPath, attemptsPath, drafts, attempts);
    return true;
  } finally {
    lock.release();
  }
}

function deferred(deps: BandMeaningReplayInput, reason: string, seeded: boolean): BandMeaningReplayPass {
  if (lastDeferral.get(deps.stateDir) !== reason) {
    lastDeferral.set(deps.stateDir, reason);
    const clock = deps.clock ?? systemClock;
    appendLedger(deps.ledgerPath, { ts: clock.iso(), run_id: `REPLAY-${clock.now()}`, task_id: "inbox-replay", step: "inbox.replay_deferred", reason });
  }
  return { seeded, invalidated: [], recorded: [], deferred: reason, complete: false };
}

/** One replay pass. Never throws: a failure is a deferral with its reason, and the next pass tries again. */
export function replayBandMeaningRefusals(deps: BandMeaningReplayInput): BandMeaningReplayPass {
  try {
    return replayPass(deps);
  } catch (e) {
    return deferred(deps, `error: ${String((e as Error)?.message ?? e)}`, false);
  }
}

function replayPass(deps: BandMeaningReplayInput): BandMeaningReplayPass {
  const clock = deps.clock ?? systemClock;
  const storePath = bandMeaningReplayStorePath(deps.stateDir);
  const writeStore = (s: BandMeaningReplayStore) => writeAtomic(storePath, JSON.stringify(s, null, 2) + "\n");
  let store = readBandMeaningReplayStore(deps.stateDir);
  if (store && Object.values(store.proposals).every((e) => e.outcome)) return { seeded: false, invalidated: [], recorded: [], complete: true };

  const read = bandMeaningUnion(deps.stateDir, { step: [...REPLAY_STEPS], refuseIncomplete: true });
  if (!read.ok) return deferred(deps, `incomplete ledger union: ${read.unread.length} file(s) unread`, false);
  let seeded = false;
  if (!store) {
    if (!read.rows.some(isApproveOutcome)) return deferred(deps, "no approve rows in the ledger union — the control failed", false);
    store = {
      seededAt: clock.iso(),
      proposals: Object.fromEntries(bandMeaningPopulation(read.rows).map((id) => [id, { family: inboxKind(id) }])),
    };
    writeStore(store);
    seeded = true;
  }
  lastDeferral.delete(deps.stateDir);

  const now = clock.iso();
  const seededAt = store.seededAt;
  const after = read.rows.filter((row) => typeof row.ts === "string" && row.ts > seededAt);
  const states = deps.classificationStates();
  const registry = registryIds(deps.stateDir);
  const recorded: BandMeaningReplayPass["recorded"] = [];
  const toInvalidate: string[] = [];
  for (const [id, entry] of Object.entries(store.proposals)) {
    if (entry.outcome) continue;
    const state = states?.[id];
    // SUPERSEDED IS CHECKED FIRST for a proposal not yet re-drafted; once re-drafted, its own approve answers first.
    const superseded: Outcome | undefined = state !== undefined && SUPERSEDED_STATES.has(state)
      ? { outcome: "skipped_superseded", at: now, reason: `classified ${state}` }
      : registry && !registry.has(id) ? { outcome: "skipped_superseded", at: now, reason: "no longer in the registry" } : undefined;
    const outcome = ledgerOutcome(id, entry, after, now) ?? superseded;
    if (!outcome) {
      if (entry.invalidatedAt === undefined) toInvalidate.push(id);
      continue;
    }
    // Stored BEFORE its row, so a restart between the two cannot write a second row.
    entry.outcome = outcome;
    writeStore(store);
    const name = outcome.outcome;
    appendLedger(deps.ledgerPath, {
      ts: now, run_id: `REPLAY-${clock.now()}`, task_id: id, step: "inbox.replayed", proposal_id: id, family: entry.family, outcome: name,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.unresolved_violations === undefined ? {} : { unresolved_violations: outcome.unresolved_violations }),
    });
    recorded.push({ proposalId: id, outcome: name });
  }

  const invalidated = toInvalidate.length > 0 && invalidateDrafts(deps.stateDir, toInvalidate) ? toInvalidate : [];
  if (invalidated.length > 0) {
    for (const id of invalidated) store.proposals[id].invalidatedAt = now;
    writeStore(store);
  }
  return { seeded, invalidated, recorded, complete: Object.values(store.proposals).every((e) => e.outcome) };
}
