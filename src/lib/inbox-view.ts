import { inboxGardenerSource, mechanicalAskPurpose, readInboxGardenerStore, inboxOperatorIntent } from "./inbox-retirement.js";
import { readAllThreads, inboxThreadId } from "./inbox-thread.js";
/**
 * The inbox's materialized side (arch Phase 4, design D5 row 3 and P4-T06): what used to happen on
 * `GET /v1/inbox` and now happens in serve's slow lane, on a cadence, whether or not anyone reads.
 *
 * The GET wrote two things. It pruned ratified proposals from the registry, and it wrote
 * `state/inbox-classified.json`, the readiness the daemon's fleet lane files from (W1-T4089) and the
 * nav badge counts. With no viewer neither ran, and the fleet lane decided on readiness as old as the
 * last human read: 6 h in the Phase 0 measurement. A read now writes nothing.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { persistedInboxIdentity, readPersistedInbox, writeClassificationSnapshot, writePersistedInbox, type PersistedInboxContent } from "./fleet-lane.js";
import { deriveTaskReferent, parseProposalRegistryResult, pruneRatifiedProposals, updateProposalRegistry } from "./inbox.js";
import { buildInboxDismissalAudit, inboxDismissalReceipts } from "./inbox-dismissal-audit.js";
import { INBOX_STALE_AFTER_MS } from "./nav-badge-view.js";
import { classifyAllProposalsSliced, inboxClassificationEvidence, inboxLanes, lapseInboxKeeps, materializeInboxAttentionCensus, nextInboxSnoozeWake, peekClassifiedInbox, pruneInboxTriage, readInboxStores, recordInboxFirstSeen, readSlowLaneInbox, type ClassifiedInbox, type InboxStores, type PanelGraphDeps } from "./panel-graph.js";
import { projectWhyMeFeedback, type WhyMeFeedback } from "./inbox-why-me.js";
import { writeVerdictReceipts } from "./inbox-verdict-receipts.js";
import { readSnapshotCursor, snapshotCursor } from "./read-page.js";
import { pagesWithin, viewKey, type ViewDefinition, type ViewSource } from "./views.js";

/** How often the slow lane reclassifies. An unchanged input set is answered from the classifier's memo. */
export const INBOX_CLASSIFY_INTERVAL_MS = 60_000;
/** An unchanged classification is re-stamped this often, so its age keeps saying how recently it was checked. */
export const INBOX_CLASSIFICATION_RESTAMP_MS = INBOX_STALE_AFTER_MS / 2;
const validatedInstanceSources = new WeakMap<PanelGraphDeps, string>();
const dismissalWindows = new WeakMap<PanelGraphDeps, { key: string; window: { from: string; to: string } }>();

function dismissalAudit(classified: ClassifiedInbox, deps: PanelGraphDeps, now: number) {
  const heldTask = classified.plan.byId.get("W1-T216");
  const heldAsk = classified.classifications.find(row => row.proposalId === "verify-human:W1-T216");
  const terminal = classified.classifications.some(row => {
    const taskId = deriveTaskReferent(row.proposalId);
    return (row.state === "retired" || row.state === "ratified") && taskId !== undefined && classified.projection.get(taskId)?.merged === true;
  });
  const scope = deps.inboxAuditScope ?? deps.inboxSourceIdentity;
  const lifecycle = readInboxGardenerStore(join(deps.inboxRoot, "state"), scope && { ...scope, root: deps.inboxRoot });
  const input = { scope: scope && { instance: scope.instance, repository: scope.repository },
    coverage: { receipts: classified.attentionEvidence?.archiveLedger ?? "unavailable", outcomes: "partial", plan: "observed",
      registry: inboxClassificationEvidence(classified).complete ? "observed" : "partial" },
    controls: { heldSecurity: { taskId: "W1-T216", observed: Boolean(heldTask && heldAsk),
      passed: heldTask?.dispatch_hold === true && Boolean(heldAsk && heldAsk.state !== "retired" && heldAsk.state !== "ratified" && heldAsk.state !== "declined") },
      terminalMechanical: { observed: terminal, passed: terminal } },
    receipts: [...inboxDismissalReceipts(classified.ledgerLines), ...(scope && lifecycle.state === "observed" ? lifecycle.store.events.map(e => e.receipt) : [])] } as const;
  const stamps = [deps.planPath, deps.ledgerPath, join(deps.inboxRoot, "state", "inbox-proposals.json")].map(path => {
    const stat = statSync(path, { throwIfNoEntry: false });
    return [path, stat ? [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs] : "absent"];
  });
  const key = JSON.stringify([stamps, input]);
  let held = dismissalWindows.get(deps);
  if (!held || held.key !== key) {
    held = { key, window: { from: fixedClock(now - 86_400_000).iso(), to: fixedClock(now).iso() } };
    dismissalWindows.set(deps, held);
  }
  return buildInboxDismissalAudit({ ...input, window: held.window });
}

/** What the last pass wrote: its content's identity, and when. Seeded from disk on the first pass. */
export interface InboxRefreshMemo {
  whyMeFeedback?: WhyMeFeedback;
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
  /** W1-T8831: the earliest snooze still ahead of this pass, when the next recompute is due for it; null when none is snoozed. */
  nextSnoozeWakeAt: string | null;
  /** When the snapshot now on disk was written. */
  generatedAt: string | null;
}

/** What serve's inbox readers take from one pass (W1-T5897): enough to build every lane, the census and the threads. */
function persistedContent(classified: ClassifiedInbox, stores: InboxStores): PersistedInboxContent {
  const ledgerRows = classified.ledgerLines.filter((row) => row.step === "fleet_lane.decided" || (row.step === "ratify.approved" && row.released === "verify-human"));
  const projection = [...classified.projection];
  const taskIds = new Set(classified.proposals.flatMap((proposal) => /^verify-human:(W\d+-T[A-Za-z0-9]+)$/.exec(proposal.id)?.slice(1) ?? []));
  const attentionEvidence = classified.attentionEvidence && {
    ...classified.attentionEvidence,
    releases: classified.attentionEvidence.releases.filter(([id]) => taskIds.has(id)),
    judges: classified.attentionEvidence.judges.filter(([id]) => taskIds.has(id)),
  };
  return {
    ...inboxClassificationEvidence(classified), proposals: classified.proposals, classifications: classified.classifications, ledgerRows,
    mergedTaskIds: projection.filter(([, p]) => p.merged).map(([id]) => id), projectionIndeterminate: projection.some(([, p]) => p.indeterminate === true),
    ...(attentionEvidence ? { attentionEvidence } : {}),
    gardenerDependencyEvidence: [...new Set(classified.proposals.flatMap(p => {
      const id = mechanicalAskPurpose(p)?.taskId;
      return id ? classified.plan.byId.get(id)?.depends_on ?? [] : [];
    }))].sort().map(id => ({ id, merged: !classified.plan.byId.has(id) || !classified.projection.has(id) || classified.projection.get(id)?.indeterminate ? null : classified.projection.get(id)!.merged })),
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
  if (deps.inboxSourceIdentity) {
    const registryPath = join(stateDir, "inbox-proposals.json");
    const stamp = JSON.stringify([registryPath, deps.ledgerPath, deps.planPath].map(path => {
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error("instance inbox input is not a regular file");
      return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
    }));
    if (validatedInstanceSources.get(deps) !== stamp) {
      const registry = parseProposalRegistryResult(readFileSync(registryPath, "utf8"));
      if (registry.kind !== "ok" || !registry.proposals.every(p => p && typeof p.id === "string" && typeof p.summary === "string"))
        throw new Error("instance inbox registry is unavailable");
      const ledger = readFileSync(deps.ledgerPath, "utf8");
      for (const line of ledger.split("\n").filter(line => line.trim())) {
        const row: unknown = JSON.parse(line);
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("instance inbox ledger is unavailable");
      }
      validatedInstanceSources.set(deps, stamp);
    }
  }
  if (memo.identity === undefined) {
    const onDisk = readPersistedInbox(stateDir);
    if (onDisk) Object.assign(memo, { identity: onDisk.identity, writtenAtMs: Date.parse(onDisk.generatedAt), whyMeFeedback: onDisk.whyMeFeedback });
  }
  const classified = await classifyAllProposalsSliced(deps);
  if (deps.inboxMayPersist && !deps.inboxMayPersist()) throw new Error("instance inbox lease is not held");
  const { registryPath, proposals, classifications } = classified;
  const prunedIds = deps.inboxSourceIdentity ? [] : pruneRatifiedProposals(proposals, classifications).prunedIds;
  if (prunedIds.length > 0) {
    const pruned = new Set(prunedIds);
    updateProposalRegistry(registryPath, (current) => {
      const fresh = current.filter((p) => !pruned.has(p.id));
      return fresh.length === current.length ? null : fresh;
    });
  }
  // The stores are read once, with the pass, and persisted with it: the bodies and every legacy read page the same.
  const now = clock.now();
  // W1-T8825: the slow lane alone records when the inbox first saw each id; a read only reads that record.
  recordInboxFirstSeen(stateDir, proposals.map((p) => p.id), fixedClock(now).iso());
  // W1-T8831: a proposal that left the registry drops its archive/snooze mark. An empty registry read prunes nothing: it may be a torn read.
  if (!deps.inboxSourceIdentity && proposals.length > 0) pruneInboxTriage(stateDir, proposals.map((p) => p.id));
  lapseInboxKeeps(stateDir, classified);
  // A decline outlives the live ledger's per-step carry cap: the receipts of every proposal still registered are kept.
  if (classified.verdictReceipts && proposals.length > 0) writeVerdictReceipts(stateDir, classified.verdictReceipts, proposals.map((p) => p.id));
  // The pass's own instant judges every snooze, so the persisted stores say which are still ahead and the view reads no clock.
  const stores = readInboxStores(deps.inboxRoot, proposals, { plan: classified.plan, ledgerLines: classified.ledgerLines, nowMs: now });
  const sourceThreads = readAllThreads({ threadStorePath: join(stateDir, "inbox-threads.jsonl") });
  if (sourceThreads.status !== "ok") throw new Error("Inbox gardener operator intent source unavailable");
  const operatorIntents = new Map(proposals.map(p => [p.id, inboxOperatorIntent(sourceThreads.threads.get(inboxThreadId(p.id)) ?? [])]));
  const gardenerScope = deps.inboxSourceIdentity ?? deps.inboxAuditScope;
  const lifecycleRead = readInboxGardenerStore(stateDir, gardenerScope && { ...gardenerScope, root: deps.inboxRoot });
  const inputs = { ...persistedContent(classified, stores), dismissalAudit: dismissalAudit(classified, deps, now),
    retirementSource: lifecycleRead.state === "observed" && !gardenerScope ? "unavailable" as const : lifecycleRead.state,
    ...(gardenerScope ? { gardenerSource: inboxGardenerSource(proposals, classified.plan.byId, { ...gardenerScope, root: deps.inboxRoot }, operatorIntents) } : {}),
    snapshotScope: deps.inboxSourceIdentity ?? deps.inboxAuditScope ?? { root: deps.inboxRoot },
    ...(deps.inboxSourceIdentity ? { sourceIdentity: deps.inboxSourceIdentity } : {}) };
  const attentionCensus = materializeInboxAttentionCensus(deps, classified, stores, inputs, sourceThreads);
  const scope = deps.inboxSourceIdentity ?? deps.inboxAuditScope;
  // Separate advisory history: classification facts/pages retain W1-T9288's immutable key.
  let whyMeFeedback = scope ? projectWhyMeFeedback(stateDir, scope, attentionCensus, fixedClock(now).iso()) : undefined;
  if (whyMeFeedback && whyMeFeedback.identity === memo.whyMeFeedback?.identity) whyMeFeedback = memo.whyMeFeedback;
  const content = { ...inputs, snapshotKey: attentionCensus.snapshotKey, attentionCensus, ...(whyMeFeedback ? { whyMeFeedback } : {}) };
  const identity = persistedInboxIdentity(content);
  const changed = identity !== memo.identity;
  const written = changed || memo.writtenAtMs === undefined || now - memo.writtenAtMs >= INBOX_CLASSIFICATION_RESTAMP_MS;
  const generatedAt = fixedClock(written ? now : memo.writtenAtMs!).iso();
  const bodies = inboxViewBodies(inboxLanes({ ...classified, stores }, deps.inboxRoot, { content, scope }), inboxStoreSource(generatedAt), content.snapshotKey);
  if (written) {
    writePersistedInbox(stateDir, content, now);
    writeClassificationSnapshot(stateDir, classifications, fixedClock(now), inboxClassificationEvidence(classified));
    memo.identity = identity;
    memo.writtenAtMs = now;
    memo.whyMeFeedback = whyMeFeedback;
  }
  return {
    bodies,
    proposals: proposals.length, changed, written, pruned: prunedIds.length, nextSnoozeWakeAt: nextInboxSnoozeWake(stateDir, now), generatedAt,
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
export const INBOX_VIEW_SECTIONS = ["needsYou", "ready", "drafting", "notReady", "declined", "fleet", "archived", "snoozed", "kept"] as const;
export type InboxViewSection = (typeof INBOX_VIEW_SECTIONS)[number];

type Lanes = ReturnType<typeof inboxLanes>;
type LaneItem = { proposalId: string; lane?: string };

/** One page of one section, with every lane's counts so a page alone can draw the section tabs. */
export interface InboxViewData {
  snapshotKey?: string;
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
 * page is `section=<s>`; continuation cursors bind the classification, section and item offset. A
 * `needsYou` item names its `lane`. No clock is in `data`, so an unchanged inbox keeps its ETags.
 */
export function inboxViewBodies(lanes: Lanes, source: ViewSource, snapshotKey?: string): InboxViewBody[] {
  return INBOX_VIEW_SECTIONS.flatMap((section) => {
    const items = sectionItems(lanes, section);
    const pages = pagesWithin(items);
    let offset = 0;
    return pages.map((page, index) => {
      const at = offset;
      offset += page.length;
      const params = new URLSearchParams(index === 0 ? { section } : { section, cursor: snapshotKey ? snapshotCursor({ snapshotKey, section, offset: at }) : String(at) });
      const next = index + 1 < pages.length ? { next: snapshotKey ? snapshotCursor({ snapshotKey, section, offset }) : String(offset) } : {};
      const data = { ...(snapshotKey ? { snapshotKey } : {}), section, items: page, counts: lanes.counts, page: { index, of: pages.length, total: items.length, ...next } };
      // PRIMARY CONTROL: leave 4 KiB of the 64 KiB wire budget for the view envelope and sources.
      if (Buffer.byteLength(JSON.stringify(data)) > 60 * 1024) throw new Error("Inbox page exceeds its maintained payload budget");
      return { key: viewKey(params), data, sources: [source] };
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
  let paged: { lanes: Lanes; asOf: string | null; snapshotKey?: string; bodies: Map<string, InboxViewBody> } | undefined;
  return {
    name: INBOX_VIEW_NAME,
    version: INBOX_VIEW_VERSION,
    ...(deps.inboxFromSlowLane ? { shadowSources: { snapshotKey: INBOX_STORE_SOURCE, items: INBOX_STORE_SOURCE, counts: INBOX_STORE_SOURCE, page: INBOX_STORE_SOURCE } } : {}),
    validateRequest: (params, source) => {
      if (!source) return undefined;
      const section = params.get("section") ?? "";
      if (!INBOX_VIEW_SECTIONS.includes(section as InboxViewSection)) return undefined;
      const head = source.body(INBOX_VIEW_NAME, viewKey(new URLSearchParams({ section })));
      if (!head && !params.has("cursor")) return undefined;
      const key = (head?.body.data as Partial<InboxViewData> | undefined)?.snapshotKey;
      const cursor = readSnapshotCursor(params.get("cursor") ?? undefined, key, section);
      if ("error" in cursor) return cursor;
      const selected = source.body(INBOX_VIEW_NAME, viewKey(params));
      for (const entry of [head, selected]) {
        if (!entry) continue;
        const data = entry.body.data as Partial<InboxViewData> | undefined;
        const judged = source.judge(entry.body.sources, clock.now(), entry);
        const own = judged.find(item => item.name === INBOX_STORE_SOURCE);
        const age = clock.now() - Date.parse(own?.asOf ?? "");
        if (data?.snapshotKey !== key || !Number.isFinite(age) || age < 0 || judged.some(item => item.state !== "fresh") || age > INBOX_STALE_AFTER_MS) {
          return { status: 503, error: "inbox_snapshot_stale", detail: "The maintained classification source is missing, invalid or stale." };
        }
      }
      return undefined;
    },
    compute: (params) => {
      const section = params.get("section");
      if (!INBOX_VIEW_SECTIONS.includes(section as InboxViewSection)) return { error: `section must be one of ${INBOX_VIEW_SECTIONS.join(", ")}` };
      const read = readSlowLaneInbox(deps);
      if (deps.inboxFromSlowLane) {
        if (!read) return { status: 503, error: "inbox_snapshot_pending", detail: "A completed maintained classification is not available yet." };
        const planSource = deps.readPlanSource?.();
        if (planSource?.state === "unavailable") return { status: 503, error: "plan_source_unavailable", detail: "Current plan evidence is unavailable." };
        const age = clock.now() - Date.parse(read.generatedAt);
        if (planSource?.state === "stale" || !Number.isFinite(age) || age < 0 || age > INBOX_STALE_AFTER_MS) {
          return { status: 503, error: "inbox_snapshot_stale", detail: "The maintained classification or its current plan source is missing, invalid or stale." };
        }
      }
      const classified = read?.classified ?? (deps.inboxFromSlowLane ? undefined : peekClassifiedInbox(deps));
      if (!classified) return { error: "serve has not classified the inbox yet" };
      const cursor = read || deps.inboxFromSlowLane ? readSnapshotCursor(params.get("cursor") ?? undefined, read?.snapshotKey, section!) : undefined;
      if (cursor && "error" in cursor) return cursor;
      const source = read
        ? inboxStoreSource(read.generatedAt, clock.now() - Date.parse(read.generatedAt) > INBOX_STALE_AFTER_MS ? "stale" : "fresh")
        : inboxStoreSource(clock.iso());
      const lanes = read?.lanes() ?? inboxLanes(classified, deps.inboxRoot);
      if (!paged || paged.lanes !== lanes || paged.asOf !== source.asOf || paged.snapshotKey !== cursor?.snapshotKey) {
        paged = { lanes, asOf: source.asOf, snapshotKey: cursor?.snapshotKey,
          bodies: new Map(inboxViewBodies(lanes, source, cursor?.snapshotKey).map(body => [body.key, body])) };
      }
      const body = paged.bodies.get(viewKey(params));
      return body ? { data: body.data, sources: body.sources } : { error: `no such page: ${viewKey(params)}` };
    },
  };
}
