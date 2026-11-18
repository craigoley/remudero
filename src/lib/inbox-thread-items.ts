/**
 * W1-T13456: the operator's inbox thread items, off one classification, in a module both readers share.
 *
 * `GET /v1/inbox/threads` (panel-graph.ts) and the `inbox-threads` read-model view (inbox-threads-view.ts) list the
 * same rows. The view is built in the read-model view thread, which must not import panel-graph, so the projection
 * from a classification to {@link InboxThreadItem}s lives here, and both call it: never a copy.
 */
import type { InboxClassification, Proposal } from "./inbox.js";
import { classifiedInboxOwner, inboxOwner, isAgeOnlyInboxInformation } from "./inbox-owner.js";
import { plainInboxMessage, type PlainStore } from "./inbox-plain.js";
import type { InboxThreadItem } from "./inbox-responder.js";

/** The classification a thread list is projected from: the proposals and their classifications. */
export interface ThreadListInbox {
  proposals: readonly Proposal[];
  classifications: ReadonlyArray<Pick<InboxClassification, "proposalId" | "state" | "retirement" | "displayOwner"> & { requiresReview?: true }>;
}

/** W1-T9252: this table is the thread routes' membership, so it must name every classification `inboxLanes` puts in
 *  `needsYou`. `deferred_with_trigger` was missing: its item is listed under `notReady` (a deferred item waits
 *  on a trigger, which is the fleet's next step) but its id was refused on every thread route as not found. */
export const CLASSIFICATION_TO_THREAD_STATE: Partial<Record<string, InboxThreadItem["state"]>> = {
  ready: "ready",
  drafting: "drafting",
  not_ready: "notReady",
  deferred_with_trigger: "notReady",
  declined: "declined",
  retired: "retired",
};

/** Every operator-owned item with its plain message and state, in classification order. `causalScope`, when given,
 *  is stamped on each item (the instance and repository its correspondence is read against). */
export function operatorThreadItemsOf(classified: ThreadListInbox, plainStore: PlainStore, causalScope?: InboxThreadItem["causalScope"]): InboxThreadItem[] {
  const byId = new Map<string, Proposal>();
  // The first proposal with an id wins, as a linear find over the registry does.
  for (const proposal of classified.proposals) if (!byId.has(proposal.id)) byId.set(proposal.id, proposal);
  const items: InboxThreadItem[] = [];
  for (const c of classified.classifications) {
    const state = CLASSIFICATION_TO_THREAD_STATE[c.state];
    const proposal = byId.get(c.proposalId);
    if (!state || !proposal || inboxOwner(proposal) !== "operator" && !isAgeOnlyInboxInformation(proposal) && !c.retirement) continue;
    items.push({ proposalId: proposal.id, summary: proposal.summary, plain: plainInboxMessage(proposal, plainStore), state,
      ...(isAgeOnlyInboxInformation(proposal) && classifiedInboxOwner(proposal, c) === "fleet" ? { informational: true } : {}),
      ...(causalScope ? { causalScope } : {}),
      ...(proposal.reframeHistory ? { reframeHistory: proposal.reframeHistory } : {}),
      ...(c.requiresReview || c.retirement?.state === "restored_for_review" ? { requiresReview: true } : {}) });
  }
  return items;
}
