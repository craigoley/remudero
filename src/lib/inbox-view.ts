/**
 * The inbox's materialized side (arch Phase 4, design D5 row 3 and P4-T06): what used to happen on
 * `GET /v1/inbox` and now happens in serve's slow lane, on a cadence, whether or not anyone reads.
 *
 * The GET wrote two things. It pruned ratified proposals from the registry, and it wrote
 * `state/inbox-classified.json`, the readiness the daemon's fleet lane files from (W1-T4089) and the
 * nav badge counts. With no viewer neither ran, and the fleet lane decided on readiness as old as the
 * last human read: 6 h in the Phase 0 measurement. A read now writes nothing.
 */
import { join } from "node:path";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { readClassificationSnapshot, writeClassificationSnapshot } from "./fleet-lane.js";
import { pruneRatifiedProposals, updateProposalRegistry } from "./inbox.js";
import { INBOX_STALE_AFTER_MS } from "./nav-badge-view.js";
import { classifyAllProposalsSliced, type PanelGraphDeps } from "./panel-graph.js";

/** How often the slow lane reclassifies. An unchanged input set is answered from the classifier's memo. */
export const INBOX_CLASSIFY_INTERVAL_MS = 60_000;
/** An unchanged classification is re-stamped this often, so its age keeps saying how recently it was checked. */
export const INBOX_CLASSIFICATION_RESTAMP_MS = INBOX_STALE_AFTER_MS / 2;

/** What the last pass wrote: its states, keyed for comparison, and when. Seeded from disk on the first pass. */
export interface InboxRefreshMemo {
  states?: string;
  writtenAtMs?: number;
}

export interface InboxRefresh {
  proposals: number;
  /** The states differ from the last written snapshot. */
  changed: boolean;
  /** The snapshot was written this pass: changed, or due a re-stamp. */
  written: boolean;
  pruned: number;
  /** When the snapshot now on disk was written. */
  generatedAt: string | null;
}

function statesKey(states: Record<string, string>): string {
  return JSON.stringify(Object.entries(states).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * One pass: classify every proposal, heal ratified rows out of the registry, and write the snapshot
 * when the classification changed or its stamp is due. The prune re-reads under the registry lock and
 * reapplies only the pruned ids (W1-T240), as the GET did.
 */
export async function refreshInboxClassification(deps: PanelGraphDeps, memo: InboxRefreshMemo, clock: Clock = systemClock): Promise<InboxRefresh> {
  const stateDir = join(deps.inboxRoot, "state");
  if (memo.states === undefined) {
    const onDisk = readClassificationSnapshot(stateDir);
    const writtenMs = onDisk?.generatedAt ? Date.parse(onDisk.generatedAt) : Number.NaN;
    Object.assign(memo, onDisk ? { states: statesKey(onDisk.states) } : {}, Number.isFinite(writtenMs) ? { writtenAtMs: writtenMs } : {});
  }
  const { registryPath, proposals, classifications } = await classifyAllProposalsSliced(deps);
  const { prunedIds } = pruneRatifiedProposals(proposals, classifications);
  if (prunedIds.length > 0) {
    const pruned = new Set(prunedIds);
    updateProposalRegistry(registryPath, (current) => {
      const fresh = current.filter((p) => !pruned.has(p.id));
      return fresh.length === current.length ? null : fresh;
    });
  }
  const states: Record<string, string> = {};
  for (const c of classifications) states[c.proposalId] = c.state;
  const key = statesKey(states);
  const now = clock.now();
  const changed = key !== memo.states;
  const written = changed || memo.writtenAtMs === undefined || now - memo.writtenAtMs >= INBOX_CLASSIFICATION_RESTAMP_MS;
  if (written) {
    writeClassificationSnapshot(stateDir, classifications, clock);
    memo.states = key;
    memo.writtenAtMs = now;
  }
  const writtenAt = memo.writtenAtMs;
  return { proposals: proposals.length, changed, written, pruned: prunedIds.length, generatedAt: writtenAt === undefined ? null : fixedClock(writtenAt).iso() };
}
