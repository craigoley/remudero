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
import { classifyAllProposalsSliced, inboxLanes, peekClassifiedInbox, type PanelGraphDeps } from "./panel-graph.js";
import { pagesWithin, viewKey, type ViewDefinition, type ViewSource } from "./views.js";

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
  /** The `inbox` view's bodies over this pass, one per section page (design D9). */
  bodies: InboxViewBody[];
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
  const classified = await classifyAllProposalsSliced(deps);
  const { registryPath, proposals, classifications } = classified;
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
  const source: ViewSource = { name: `inbox-store:${INBOX_VIEW_INSTANCE}`, asOf: fixedClock(now).iso(), state: "fresh" };
  return {
    bodies: inboxViewBodies(inboxLanes(classified, deps.inboxRoot), source),
    proposals: proposals.length, changed, written, pruned: prunedIds.length, generatedAt: writtenAt === undefined ? null : fixedClock(writtenAt).iso(),
  };
}

export const INBOX_VIEW_NAME = "inbox";
export const INBOX_VIEW_VERSION = 1;
/** The inbox is core's alone today; its source is named for the instance that classifies it. */
const INBOX_VIEW_INSTANCE = "core";
export const INBOX_VIEW_SECTIONS = ["needsYou", "ready", "drafting", "notReady", "declined", "fleet"] as const;
export type InboxViewSection = (typeof INBOX_VIEW_SECTIONS)[number];

type Lanes = ReturnType<typeof inboxLanes>;
type LaneItem = { proposalId: string; lane?: string };

/** One page of one section, with every lane's counts so a page alone can draw the section tabs. */
export interface InboxViewData {
  section: InboxViewSection;
  items: LaneItem[];
  counts: Lanes["counts"];
  page: { index: number; of: number; total: number; next?: string };
}

export interface InboxViewBody {
  key: string;
  data: InboxViewData;
  sources: ViewSource[];
}

function sectionItems(lanes: Lanes, section: InboxViewSection): LaneItem[] {
  if (section !== "needsYou") return lanes[section];
  const { ready, drafting, notReady, declined } = lanes.needsYou;
  return [
    ...ready.map((i) => ({ ...i, lane: "ready" })), ...drafting.map((i) => ({ ...i, lane: "drafting" })),
    ...notReady.map((i) => ({ ...i, lane: "notReady" })), ...declined.map((i) => ({ ...i, lane: "declined" })),
  ];
}

/**
 * Every key of the `inbox` view: per section, pages of at most {@link pagesWithin}'s bytes. The first
 * page is `section=<s>`; page n is `section=<s>&cursor=<offset>`, the offset of its first item. A
 * `needsYou` item names its `lane`. No clock is in `data`, so an unchanged inbox keeps its ETags.
 */
export function inboxViewBodies(lanes: Lanes, source: ViewSource): InboxViewBody[] {
  return INBOX_VIEW_SECTIONS.flatMap((section) => {
    const items = sectionItems(lanes, section);
    const pages = pagesWithin(items);
    let offset = 0;
    return pages.map((page, index) => {
      const at = offset;
      offset += page.length;
      const params = new URLSearchParams(index === 0 ? { section } : { section, cursor: String(at) });
      const next = index + 1 < pages.length ? { next: String(offset) } : {};
      return { key: viewKey(params), data: { section, items: page, counts: lanes.counts, page: { index, of: pages.length, total: items.length, ...next } }, sources: [source] };
    });
  });
}

/**
 * The `inbox` view computed on serve's main thread: the shadow comparator's legacy side, and the answer
 * while the view is dark. It never classifies: it pages the last classification GET /v1/inbox's memo
 * holds, so a cold serve answers that none has been made yet.
 */
export function inboxLegacyView(deps: PanelGraphDeps, clock = systemClock): ViewDefinition<InboxViewData> {
  return {
    name: INBOX_VIEW_NAME,
    version: INBOX_VIEW_VERSION,
    compute: (params) => {
      const section = params.get("section");
      if (!INBOX_VIEW_SECTIONS.includes(section as InboxViewSection)) return { error: `section must be one of ${INBOX_VIEW_SECTIONS.join(", ")}` };
      const classified = peekClassifiedInbox(deps);
      if (!classified) return { error: "serve has not classified the inbox yet" };
      const source: ViewSource = { name: `inbox-store:${INBOX_VIEW_INSTANCE}`, asOf: clock.iso(), state: "fresh" };
      const body = inboxViewBodies(inboxLanes(classified, deps.inboxRoot), source).find((b) => b.key === viewKey(params));
      return body ? { data: body.data, sources: body.sources } : { error: `no such page: ${viewKey(params)}` };
    },
  };
}
