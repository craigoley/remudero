import { createHash } from "node:crypto";
import { existsSync, readFileSync, promises as fsPromises } from "node:fs";
import { join } from "node:path";

import { systemClock, type Clock } from "./clock.js";
import { acquireDrainLock, DrainLockError } from "./drain-lock.js";
import { writeAtomic } from "./fs-race-safe.js";
import {
  composeStampLine,
  createProposalShardReader,
  proposalShardDir,
  type ProposalShardReader,
  invalidateDraft,
  lintDraftedFragment,
  loadProposalRegistry,
  parseDraftAttemptCache,
  parseDraftCache,
  parseProposalRegistryResult,
  writeDraftAttemptPair,
  type DraftCache,
  type DraftLintViolation,
} from "./inbox.js";
import { inboxKind } from "./inbox-owner.js";
import { runStepsAsync, runStepsSync, step, type Steps } from "./git-push.js";
import { appendLedger } from "./ledger.js";
import { createIncrementalLedgerUnion } from "./ledger-union.js";
import { parseTasksFromYaml } from "./plan.js";
import { relintGuidanceLines } from "./relint.js";

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
 * its `inbox.replayed` row is written, and once every proposal has a FINAL outcome a pass reads only the store.
 *
 * W1-T9041 — ONLY WHAT LANDED IS FINAL. `refiled` needs the plan PR's `ratify.approved` receipt: an
 * `approve.shards_written` row precedes a push the preflight can still refuse (2026-10-13, DAEMON-1790206008025).
 * `refused` and `redraft_not_ready` stay open. Each pass re-lints an open entry's CACHED draft in-process, after the
 * stamp composition the classifier applies, and calls no model: clean now, it is re-offered; its violations or their
 * guidance changed, it is re-drafted once; a re-draft still dirty is escalated by name, once per violation set. No
 * timer: only a change in what the lint says, or in what the guidance tells the drafter, moves an open entry.
 */

export const BAND_MEANING_REPLAY_STORE = "inbox-replay-band-meaning.json";

/** The refusal text `sizingViolation` (task-linter.ts) gives a new risk:high task that declares no band. */
const BAND_REFUSAL = "risk:high with no band_meaning declared";
/** `draftedDuplicateRefusal`'s (inbox.ts) own wording, for a duplicate that surfaces as an approve.error. */
const DUPLICATE_REFUSAL = "a task record already on origin/main";
const SUPERSEDED_STATES: ReadonlySet<string> = new Set(["ratified", "declined", "retired"]);
/** W1-T9041: `ratify.approved` is the plan PR's receipt, the one row that says a proposal filed. */
const REFILED_RECEIPT = "ratify.approved";
const REPLAY_STEPS = ["approve.error", "approve.shards_written", "ratify.approve_refused", REFILED_RECEIPT, "inbox.drafted"] as const;
/** W1-T9041: the row naming a proposal no re-draft could clear; `escalateReplayStranded` (escalation-catalogue.ts)
 *  writes the same step when it delivers. */
export const REPLAY_ESCALATED_STEP = "inbox.replay_escalated";
const CLEARED = "cleared by a lint change";

export type BandMeaningReplayOutcome = "refiled" | "skipped_superseded" | "refused" | "redraft_not_ready";
/** The outcomes no later pass reopens. */
const FINAL_OUTCOMES: ReadonlySet<BandMeaningReplayOutcome> = new Set(["refiled", "skipped_superseded"]);

/** What an open outcome was judged on: the lint checks its cached draft failed, and a fingerprint of the guidance
 *  `relintGuidanceLines` gives for them. */
export interface ReplayJudgement {
  checks: string[];
  guidance: string;
}

export interface BandMeaningReplayEntry {
  family: string;
  /** When the replay dropped its cached draft and attempt key. Absent until then. */
  invalidatedAt?: string;
  /** W1-T9041: when the replay last re-offered it; no row before this answers for it. */
  reofferedAt?: string;
  /** W1-T9041: the judgement it was last re-drafted on, so a re-draft can say whether it moved. */
  offered?: ReplayJudgement;
  /** W1-T9041: the violation sets already escalated, each once. */
  escalated?: string[];
  /** W1-T9041: set while a `refiled` stored before the receipt rule waits for its re-judgement's row. */
  rejudgedFrom?: "refiled";
  outcome?: { outcome: BandMeaningReplayOutcome; at: string; reason?: string; unresolved_violations?: string[]; judged?: ReplayJudgement };
}

export interface BandMeaningReplayStore {
  seededAt: string;
  /** W1-T9041: present once every stored `refiled` has been judged by its receipt. */
  refiledRule?: typeof REFILED_RECEIPT;
  proposals: Record<string, BandMeaningReplayEntry>;
}

/** W1-T9041: a proposal whose re-draft under today's lint and guidance is still dirty, its violations by check. */
export interface ReplayStranded {
  proposalId: string;
  family: string;
  violations: Record<string, string[]>;
  /** The sorted checks, joined: one escalation per proposal per key. */
  violationKey: string;
  /** Whether the re-draft failed the very checks it was re-offered on. */
  sameAsOffered: boolean;
}

export interface BandMeaningReplayInput {
  stateDir: string;
  ledgerPath: string;
  /** Each proposal's classification state, as serve's slow lane last wrote it (fleet-lane.ts's
   *  `readClassificationSnapshot`); undefined when none is readable, and the state check is then skipped. */
  classificationStates: () => Record<string, string> | undefined;
  clock?: Clock;
  /** The draft lint; `lintDraftedFragment`, the one `rmd approve` runs, when absent. */
  lint?: (fragmentYaml: string, proposalId: string, stampLine: string) => DraftLintViolation[];
  /** The redraft guidance for a violation set; `relintGuidanceLines` when absent. */
  guidance?: (violations: ReadonlyArray<DraftLintViolation>) => string[];
  /** Delivers a stranded proposal (`escalateReplayStranded`). Absent, the replay writes the row undelivered. */
  escalate?: (stranded: ReplayStranded) => void;
}

export interface BandMeaningReplayPass {
  seeded: boolean;
  invalidated: string[];
  recorded: Array<{ proposalId: string; outcome: BandMeaningReplayOutcome }>;
  /** W1-T9041: open entries this pass offered again, with the change that moved each. */
  reoffered?: Array<{ proposalId: string; reason: string }>;
  /** W1-T9041: proposals this pass escalated. */
  escalated?: string[];
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

const isFinal = (outcome: Outcome | undefined): boolean => outcome !== undefined && FINAL_OUTCOMES.has(outcome.outcome);

/** Whether a plan PR opened for `id` after the seed: its `ratify.approved` receipt. */
const receipted = (id: string, after: ReadonlyArray<Record<string, unknown>>): boolean =>
  after.some((row) => row.step === REFILED_RECEIPT && namedProposals(row).includes(id));

/** The rows that answer for `id` now: after the seed, and after its last re-offer. */
function freshRows(id: string, entry: BandMeaningReplayEntry, after: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  const since = entry.reofferedAt ?? "";
  return after.filter((row) => String(row.ts) > since && namedProposals(row).includes(id));
}

/** A FINAL outcome the ledger records for `id`: its plan PR's receipt, or a duplicate refusal. */
function finalLedgerOutcome(id: string, entry: BandMeaningReplayEntry, after: ReadonlyArray<Record<string, unknown>>, at: string): Outcome | undefined {
  if (receipted(id, after)) return { outcome: "refiled", at };
  const fresh = freshRows(id, entry, after);
  const dup = fresh.find((row) => row.step === "ratify.approve_refused" && typeof row.duplicate_of === "string");
  if (dup) return { outcome: "skipped_superseded", at, reason: `duplicate of ${String(dup.duplicate_of)}` };
  const text = fresh.filter((row) => row.step === "approve.error").map((row) => String(row.error ?? "")).find((t) => t.includes(DUPLICATE_REFUSAL));
  if (text !== undefined) {
    return { outcome: "skipped_superseded", at, reason: `duplicate of ${/against (\S+) —/.exec(text)?.[1] ?? "a filed task"}` };
  }
  return undefined;
}

/** What the ledger says happened to `id` after the seed, or undefined while nothing has. `approve.shards_written` is
 *  no outcome: the push after it can still be refused (W1-T9041). */
function ledgerOutcome(id: string, entry: BandMeaningReplayEntry, after: ReadonlyArray<Record<string, unknown>>, at: string): Outcome | undefined {
  const final = finalLedgerOutcome(id, entry, after, at);
  if (final) return final;
  const fresh = freshRows(id, entry, after);
  const error = fresh.find((row) => row.step === "approve.error");
  if (error) return { outcome: "refused", at, reason: String(error.error ?? "") };
  const drafted = fresh.find((row) => row.step === "inbox.drafted" && row.lint_clean === false &&
    entry.invalidatedAt !== undefined && String(row.ts) > entry.invalidatedAt);
  if (drafted) {
    const unresolved = Array.isArray(drafted.unresolved_violations) ? drafted.unresolved_violations.map(String) : [];
    return { outcome: "redraft_not_ready", at, unresolved_violations: unresolved };
  }
  return undefined;
}

/** One cached draft re-linted now, as `rmd approve` will lint it. */
interface Relinted {
  judged: ReplayJudgement;
  violations: Record<string, string[]>;
}

function byCheck(violations: ReadonlyArray<{ check: string; message: string }>): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const v of violations) (grouped[v.check] ??= []).push(v.message);
  return Object.fromEntries(Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)));
}

function fragmentTaskIds(fragmentYaml: string, proposalId: string): string[] {
  try {
    return parseTasksFromYaml(fragmentYaml, `inbox draft ${proposalId}`).map((task) => task.id);
  } catch {
    // deliberate: no ids is not "clean" — the lint below parses the same text and reports draft-parse itself.
    return [];
  }
}

/** Re-lint `id`'s cached draft with no model call, after the stamp composition `classifyProposal` applies (W1-T8828),
 *  so a draft that failed only on its prose stamp reads as the classifier now reads it. Undefined with no draft. */
function relintCached(deps: BandMeaningReplayInput, drafts: DraftCache, id: string, clock: Clock): Relinted | undefined {
  const draft = drafts[id];
  if (!draft || typeof draft.fragmentYaml !== "string") return undefined;
  const stampLine = composeStampLine(id, String(draft.stampLine ?? ""), fragmentTaskIds(draft.fragmentYaml, id), clock);
  const found = (deps.lint ?? lintDraftedFragment)(draft.fragmentYaml, id, stampLine);
  const violations = byCheck(found);
  const guidance = createHash("sha256").update((deps.guidance ?? relintGuidanceLines)(found).join("\n")).digest("hex").slice(0, 16);
  return { judged: { checks: Object.keys(violations), guidance }, violations };
}

/** Why an open entry is offered again, or undefined when nothing it was judged on changed. */
function reofferReason(outcome: Outcome, now: Relinted): string | undefined {
  const prior = outcome.judged;
  if (now.judged.checks.length === 0) {
    const wasDirty = prior ? prior.checks.length > 0 : (outcome.unresolved_violations ?? []).length > 0;
    return wasDirty ? CLEARED : undefined;
  }
  if (!prior || prior.checks.join(",") !== now.judged.checks.join(",")) return "violations changed";
  return prior.guidance === now.judged.guidance ? undefined : "guidance changed";
}

/** A dirty re-draft's violations: its cached draft re-linted, or else its ledger row's messages by their `[check]`. */
function strandedViolations(relinted: Relinted | undefined, unresolved: readonly string[]): Record<string, string[]> {
  if (relinted) return relinted.violations;
  return byCheck(unresolved.map((message) => ({ check: /^\[([\w-]+)\]/.exec(message)?.[1] ?? "unclassified", message })));
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

/** A refused current read is unknown, never an empty registry or a last-good absence proof. */
export interface BandMeaningReplayRegistryReader {
  readIds(): Promise<ReadonlySet<string> | undefined>;
}

/** W1-T9699: hold the incremental shard reader for the owner's life; the legacy blob is awaited too. */
export function createBandMeaningReplayRegistryReader(
  stateDir: string,
  io: {
    shards?: ProposalShardReader;
    readBlob?: (path: string) => Promise<string>;
    log?: (step: string, extra?: Record<string, unknown>) => void;
    clock?: Clock;
  } = {},
): BandMeaningReplayRegistryReader {
  const path = join(stateDir, "inbox-proposals.json");
  const shards = io.shards ?? createProposalShardReader(proposalShardDir(path), { log: io.log, clock: io.clock });
  const readBlob = io.readBlob ?? ((path: string) => fsPromises.readFile(path, "utf8"));
  return {
    async readIds() {
      try {
        const blob = parseProposalRegistryResult(await readBlob(path));
        if (blob.kind !== "ok") return undefined;
        const population = await shards.refresh();
        return new Set([...blob.proposals.map((p) => p.id), ...[...population.values()].map(({ proposal }) => proposal.id)]);
      } catch {
        // Missing/unreadable blob, refused refresh and shard collisions all defer absence judgments.
        // The shard reader may keep its memo, but only a successful CURRENT refresh can authorize absence.
        return undefined;
      }
    },
  };
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
    appendLedger(deps.ledgerPath, { ts: clock.iso(), run_id: `REPLAY-${clock.now()}`, task_id: "DAEMON", step: "inbox.replay_deferred", reason });
  }
  return { seeded, invalidated: [], recorded: [], deferred: reason, complete: false };
}

/** One replay pass. Never throws: a failure is a deferral with its reason, and the next pass tries again. */
export function replayBandMeaningRefusals(deps: BandMeaningReplayInput): BandMeaningReplayPass {
  try {
    return runStepsSync(replayPass(deps, () => registryIds(deps.stateDir)));
  } catch (e) {
    return deferred(deps, `error: ${String((e as Error)?.message ?? e)}`, false);
  }
}

/** The daemon's awaited driver over the same replay decisions, stores, locks and delivery. */
export async function replayBandMeaningRefusalsAsync(
  deps: BandMeaningReplayInput,
  reader: BandMeaningReplayRegistryReader = createBandMeaningReplayRegistryReader(deps.stateDir),
): Promise<BandMeaningReplayPass> {
  try {
    return await runStepsAsync(replayPass(deps, () => reader.readIds()));
  } catch (e) {
    return deferred(deps, `error: ${String((e as Error)?.message ?? e)}`, false);
  }
}

const completePass = (): BandMeaningReplayPass => ({ seeded: false, invalidated: [], recorded: [], reoffered: [], escalated: [], complete: true });

function* replayPass(deps: BandMeaningReplayInput, readRegistry: () => ReadonlySet<string> | undefined | Promise<ReadonlySet<string> | undefined>): Steps<BandMeaningReplayPass> {
  const clock = deps.clock ?? systemClock;
  const storePath = bandMeaningReplayStorePath(deps.stateDir);
  const writeStore = (s: BandMeaningReplayStore) => writeAtomic(storePath, JSON.stringify(s, null, 2) + "\n");
  let store = readBandMeaningReplayStore(deps.stateDir);
  if (store && store.refiledRule === REFILED_RECEIPT && Object.values(store.proposals).every((e) => isFinal(e.outcome))) return completePass();

  const read = bandMeaningUnion(deps.stateDir, { step: [...REPLAY_STEPS], refuseIncomplete: true });
  if (!read.ok) return deferred(deps, `incomplete ledger union: ${read.unread.length} file(s) unread`, false);
  let seeded = false;
  if (!store) {
    if (!read.rows.some(isApproveOutcome)) return deferred(deps, "no approve rows in the ledger union — the control failed", false);
    store = {
      seededAt: clock.iso(),
      refiledRule: REFILED_RECEIPT,
      proposals: Object.fromEntries(bandMeaningPopulation(read.rows).map((id) => [id, { family: inboxKind(id) }])),
    };
    writeStore(store);
    seeded = true;
  }
  lastDeferral.delete(deps.stateDir);

  const now = clock.iso();
  const runId = `REPLAY-${clock.now()}`;
  const seededAt = store.seededAt;
  const after = read.rows.filter((row) => typeof row.ts === "string" && row.ts > seededAt);
  // W1-T9041 MIGRATION: a `refiled` stored on approve.shards_written alone is re-judged once, by the receipt rule.
  if (store.refiledRule !== REFILED_RECEIPT) {
    for (const [id, entry] of Object.entries(store.proposals)) {
      if (entry.outcome?.outcome !== "refiled" || receipted(id, after)) continue;
      delete entry.outcome;
      entry.rejudgedFrom = "refiled";
    }
    store.refiledRule = REFILED_RECEIPT;
    writeStore(store);
  }
  const states = deps.classificationStates();
  const registry = yield* step(readRegistry);
  const draftsPath = join(deps.stateDir, "inbox-drafts.json");
  const drafts = parseDraftCache(existsSync(draftsPath) ? readFileSync(draftsPath, "utf8") : undefined);
  const recorded: BandMeaningReplayPass["recorded"] = [];
  const reoffered: NonNullable<BandMeaningReplayPass["reoffered"]> = [];
  const escalated: string[] = [];
  const toInvalidate: string[] = [];
  const toRedraft: Array<{ id: string; reason: string; judged: ReplayJudgement }> = [];
  const replayedRow = (id: string, entry: BandMeaningReplayEntry, outcome: string, extra: Record<string, unknown>) =>
    appendLedger(deps.ledgerPath, { ts: now, run_id: runId, task_id: id, step: "inbox.replayed", proposal_id: id, family: entry.family, outcome, ...extra });
  const record = (id: string, entry: BandMeaningReplayEntry, outcome: Outcome) => {
    const rejudgedFrom = entry.rejudgedFrom;
    delete entry.rejudgedFrom;
    // Stored BEFORE its row, so a restart between the two cannot write a second row.
    entry.outcome = outcome;
    writeStore(store);
    replayedRow(id, entry, outcome.outcome, {
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.unresolved_violations === undefined ? {} : { unresolved_violations: outcome.unresolved_violations }),
      ...(rejudgedFrom === undefined ? {} : { rejudged_from: rejudgedFrom }),
    });
    recorded.push({ proposalId: id, outcome: outcome.outcome });
  };
  const escalate = (id: string, entry: BandMeaningReplayEntry, violations: Record<string, string[]>) => {
    const violationKey = Object.keys(violations).join(",");
    if ((entry.escalated ?? []).includes(violationKey)) return;
    // The store is the dedup key first: written before delivery, so a crash mid-delivery is never a second issue.
    entry.escalated = [...(entry.escalated ?? []), violationKey];
    writeStore(store);
    escalated.push(id);
    const stranded: ReplayStranded = {
      proposalId: id, family: entry.family, violations, violationKey, sameAsOffered: entry.offered?.checks.join(",") === violationKey,
    };
    let error: string | undefined;
    if (deps.escalate) {
      try {
        deps.escalate(stranded);
        return;
      } catch (e) {
        // A delivery that threw still owes its row: written below, undelivered, with this error.
        error = String((e as Error)?.message ?? e);
      }
    }
    appendLedger(deps.ledgerPath, {
      ts: now, run_id: runId, task_id: id, step: REPLAY_ESCALATED_STEP, proposal_id: id, family: entry.family, violations,
      violation_key: violationKey, same_as_offered: stranded.sameAsOffered, delivered: false, issue_url: null,
      ...(error === undefined ? { reason: "no escalation route" } : { error }),
    });
  };

  // W1-T9324: an entry the replay dropped a draft for, with no outcome, is judged on the re-draft it now holds.
  const judgeRedraft = (id: string, entry: BandMeaningReplayEntry) => {
    const relinted = relintCached(deps, drafts, id, clock);
    // No cached draft: the re-draft is still due. Clean: the fleet lane files it once the classification reads it ready.
    if (!relinted || relinted.judged.checks.length === 0) return;
    const offered = entry.offered;
    if (!offered || offered.checks.join(",") !== relinted.judged.checks.join(",")) {
      toRedraft.push({ id, reason: "violations changed", judged: relinted.judged });
    } else if (offered.guidance !== relinted.judged.guidance) {
      toRedraft.push({ id, reason: "guidance changed", judged: relinted.judged });
    } else {
      // Dirty on the very judgement it was re-drafted on: nothing changes for it until the lint or guidance does.
      const unresolved = Object.values(relinted.violations).flat();
      record(id, entry, { outcome: "redraft_not_ready", at: now, unresolved_violations: unresolved, judged: relinted.judged });
      escalate(id, entry, relinted.violations);
    }
  };

  for (const [id, entry] of Object.entries(store.proposals)) {
    if (isFinal(entry.outcome)) continue;
    const state = states?.[id];
    // SUPERSEDED IS CHECKED FIRST for a proposal not yet re-drafted; once re-drafted, its own approve answers first.
    const superseded: Outcome | undefined = state !== undefined && SUPERSEDED_STATES.has(state)
      ? { outcome: "skipped_superseded", at: now, reason: `classified ${state}` }
      : registry && !registry.has(id) ? { outcome: "skipped_superseded", at: now, reason: "no longer in the registry" } : undefined;
    if (entry.outcome) {
      // AN OPEN OUTCOME: closed only by a final one, or moved by a change in what the lint says of its cached draft.
      const final = finalLedgerOutcome(id, entry, after, now) ?? superseded;
      if (final) {
        record(id, entry, final);
        continue;
      }
      const relinted = relintCached(deps, drafts, id, clock);
      if (!relinted) continue;
      const reason = reofferReason(entry.outcome, relinted);
      if (reason === undefined) {
        if (entry.outcome.judged === undefined) {
          entry.outcome.judged = relinted.judged;
          writeStore(store);
        }
      } else if (reason === CLEARED) {
        // Clean now: the fleet lane files it once the classification reads it ready.
        delete entry.outcome;
        entry.reofferedAt = now;
        writeStore(store);
        replayedRow(id, entry, "reoffered", { reason });
        reoffered.push({ proposalId: id, reason });
      } else {
        toRedraft.push({ id, reason, judged: relinted.judged });
      }
      continue;
    }
    const outcome = ledgerOutcome(id, entry, after, now) ?? superseded;
    if (!outcome) {
      if (entry.invalidatedAt === undefined) toInvalidate.push(id);
      else judgeRedraft(id, entry);
      continue;
    }
    const relinted = isFinal(outcome) ? undefined : relintCached(deps, drafts, id, clock);
    // A not-ready draft that re-lints clean keeps no judgement, so the next pass re-offers it as cleared.
    if (relinted && (outcome.outcome === "refused" || relinted.judged.checks.length > 0)) outcome.judged = relinted.judged;
    record(id, entry, outcome);
    if (outcome.outcome !== "redraft_not_ready" || (relinted && relinted.judged.checks.length === 0)) continue;
    // A RE-DRAFT UNDER TODAY'S LINT AND GUIDANCE CAME BACK DIRTY: nothing changes for it until they do, so say so.
    const violations = strandedViolations(relinted, outcome.unresolved_violations ?? []);
    if (Object.keys(violations).length > 0) escalate(id, entry, violations);
  }

  const invalidated: string[] = [];
  if (toInvalidate.length > 0 && invalidateDrafts(deps.stateDir, toInvalidate)) {
    for (const id of toInvalidate) store.proposals[id].invalidatedAt = now;
    writeStore(store);
    invalidated.push(...toInvalidate);
  }
  // RE-DRAFTED ONCE PER CHANGE: the draft rung re-drafts what this drops; an unchanged judgement drops nothing.
  if (toRedraft.length > 0 && invalidateDrafts(deps.stateDir, toRedraft.map((r) => r.id))) {
    for (const { id, judged } of toRedraft) {
      const entry = store.proposals[id];
      delete entry.outcome;
      Object.assign(entry, { invalidatedAt: now, reofferedAt: now, offered: judged });
    }
    writeStore(store);
    for (const { id, reason } of toRedraft) {
      replayedRow(id, store.proposals[id], "reoffered", { reason });
      reoffered.push({ proposalId: id, reason });
      invalidated.push(id);
    }
  }
  return { seeded, invalidated, recorded, reoffered, escalated, complete: Object.values(store.proposals).every((e) => isFinal(e.outcome)) };
}
