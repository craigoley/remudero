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
import { persistedInboxIdentity, readPersistedInbox, writeClassificationSnapshot, writePersistedInbox, type PersistedInboxContent } from "./fleet-lane.js";
import { pruneRatifiedProposals, updateProposalRegistry } from "./inbox.js";
import { INBOX_STALE_AFTER_MS } from "./nav-badge-view.js";
import { classifyAllProposalsSliced, inboxClassificationEvidence, inboxLanes, peekClassifiedInbox, readInboxStores, readSlowLaneInbox, type ClassifiedInbox, type InboxStores, type PanelGraphDeps } from "./panel-graph.js";
import { pagesWithin, viewKey, type ViewDefinition, type ViewSource } from "./views.js";

/** How often the slow lane reclassifies. An unchanged input set is answered from the classifier's memo. */
export const INBOX_CLASSIFY_INTERVAL_MS = 60_000;
/** An unchanged classification is re-stamped this often, so its age keeps saying how recently it was checked. */
export const INBOX_CLASSIFICATION_RESTAMP_MS = INBOX_STALE_AFTER_MS / 2;

/** What the last pass wrote: its content's identity, and when. Seeded from disk on the first pass. */
export interface InboxRefreshMemo {
  identity?: string;
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

/** What serve's inbox readers take from one pass (W1-T5897): enough to build every lane, the census and the threads. */
function persistedContent(classified: ClassifiedInbox, stores: InboxStores): PersistedInboxContent {
  const ledgerRows = classified.ledgerLines.filter((row) => row.step === "fleet_lane.decided" || (row.step === "ratify.approved" && row.released === "verify-human"));
  const projection = [...classified.projection];
  return {
    ...inboxClassificationEvidence(classified), proposals: classified.proposals, classifications: classified.classifications, ledgerRows,
    mergedTaskIds: projection.filter(([, p]) => p.merged).map(([id]) => id), projectionIndeterminate: projection.some(([, p]) => p.indeterminate === true),
    stores,
  };
}

/**
 * One pass: classify every proposal, heal ratified rows out of the registry, and persist the classification when
 * it changed or its stamp is due: the whole of it for serve's readers, and its states for the fleet lane and the
 * nav badge. The prune re-reads under the registry lock and reapplies only the pruned ids (W1-T240), as the GET did.
 */
export async function refreshInboxClassification(deps: PanelGraphDeps, memo: InboxRefreshMemo, clock: Clock = systemClock): Promise<InboxRefresh> {
  const stateDir = join(deps.inboxRoot, "state");
  if (memo.identity === undefined) {
    const onDisk = readPersistedInbox(stateDir);
    if (onDisk) Object.assign(memo, { identity: onDisk.identity, writtenAtMs: Date.parse(onDisk.generatedAt) });
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
  // The stores are read once, with the pass, and persisted with it: the bodies and every legacy read page the same.
  const stores = readInboxStores(deps.inboxRoot, proposals);
  const content = persistedContent(classified, stores);
  const identity = persistedInboxIdentity(content);
  const now = clock.now();
  const changed = identity !== memo.identity;
  const written = changed || memo.writtenAtMs === undefined || now - memo.writtenAtMs >= INBOX_CLASSIFICATION_RESTAMP_MS;
  if (written) {
    writePersistedInbox(stateDir, content, now);
    writeClassificationSnapshot(stateDir, classifications, fixedClock(now), inboxClassificationEvidence(classified));
    memo.identity = identity;
    memo.writtenAtMs = now;
  }
  const generatedAt = fixedClock(memo.writtenAtMs!).iso();
  return {
    bodies: inboxViewBodies(inboxLanes({ ...classified, stores }, deps.inboxRoot), inboxStoreSource(generatedAt)),
    proposals: proposals.length, changed, written, pruned: prunedIds.length, generatedAt,
  };
}

export const INBOX_VIEW_NAME = "inbox";
export const INBOX_VIEW_VERSION = 1;
/** The inbox is core's alone today; its source is named for the instance that classifies it. */
const INBOX_VIEW_INSTANCE = "core";
const INBOX_STORE_SOURCE = `inbox-store:${INBOX_VIEW_INSTANCE}`;

/** The one source of every inbox body: the persisted classification, as of its `generatedAt`, so both shadow sides name the snapshot they read. */
function inboxStoreSource(generatedAt: string, state: ViewSource["state"] = "fresh"): ViewSource {
  return { name: INBOX_STORE_SOURCE, asOf: generatedAt, state };
}
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
 * The `inbox` view computed on serve's main thread: the shadow comparator's legacy side, and the answer while the
 * view is dark. It never classifies. Under serve's slow lane (W1-T5897) it pages the persisted classification, as
 * of its `generatedAt`, and pairs every path with that read, so a body built over another snapshot differs as
 * `timing`; otherwise it pages the last classification GET /v1/inbox's memo holds.
 */
export function inboxLegacyView(deps: PanelGraphDeps, clock = systemClock): ViewDefinition<InboxViewData> {
  return {
    name: INBOX_VIEW_NAME,
    version: INBOX_VIEW_VERSION,
    ...(deps.inboxFromSlowLane ? { shadowSources: { items: INBOX_STORE_SOURCE, counts: INBOX_STORE_SOURCE, page: INBOX_STORE_SOURCE } } : {}),
    compute: (params) => {
      const section = params.get("section");
      if (!INBOX_VIEW_SECTIONS.includes(section as InboxViewSection)) return { error: `section must be one of ${INBOX_VIEW_SECTIONS.join(", ")}` };
      const read = deps.inboxFromSlowLane ? readSlowLaneInbox(deps) : undefined;
      const classified = read?.classified ?? (deps.inboxFromSlowLane ? undefined : peekClassifiedInbox(deps));
      if (!classified) return { error: "serve has not classified the inbox yet" };
      const source = read
        ? inboxStoreSource(read.generatedAt, clock.now() - Date.parse(read.generatedAt) > INBOX_STALE_AFTER_MS ? "stale" : "fresh")
        : inboxStoreSource(clock.iso());
      const body = inboxViewBodies(inboxLanes(classified, deps.inboxRoot), source).find((b) => b.key === viewKey(params));
      return body ? { data: body.data, sources: body.sources } : { error: `no such page: ${viewKey(params)}` };
    },
  };
}
