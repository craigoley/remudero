/**
 * The `feedback` view (arch Phase 4, design §1.1 priority 2 and P4-T07's read half): GET /v1/feedback's
 * entries, materialized by serve's slow lane and paged by status, so the console reads one small body
 * from memory instead of a 462 KB list recomputed per request.
 *
 * The view PROJECTS the reconcile GET /v1/feedback writes: an entry whose proposal PR merged reads
 * `accepted` here, exactly as the GET's body reads after its write, but this module writes nothing.
 * Moving that write (and its git land) to one owner is P4-T07's other half.
 */
import { computeFeedbackProjectionSync, taskOriginsOf, type FeedbackProjectionInput, type FeedbackProjectionOutcome } from "./console-projection-worker.js";
import { systemClock, type Clock } from "./clock.js";
import { FEEDBACK_STATUSES, type FeedbackEntry } from "./feedback.js";
import { decorateFeedbackDischargeByTasks, type PanelGraphDeps, type ReconciledFeedbackEntry } from "./panel-graph.js";
import type { Plan } from "./plan.js";
import type { GitHub } from "./status.js";
import { pagesWithin, viewKey, type ViewDefinition, type ViewSource } from "./views.js";

export const FEEDBACK_VIEW_NAME = "feedback";
export const FEEDBACK_VIEW_VERSION = 1;
/** Feedback is core's alone today; its source is named for that instance. */
const FEEDBACK_VIEW_INSTANCE = "core";

export type FeedbackViewStatus = (typeof FEEDBACK_STATUSES)[number] | "all";

export interface FeedbackViewData {
  status: FeedbackViewStatus;
  entries: ReconciledFeedbackEntry[];
  counts: { total: number; byStatus: Record<string, number> };
  page: { index: number; of: number; total: number; next?: string };
}

export interface FeedbackViewBody {
  key: string;
  data: FeedbackViewData;
  sources: ViewSource[];
}

/**
 * GET /v1/feedback's reconcile and discharge decoration, as a projection: a proposed entry whose PR
 * merged reads accepted (the fields `setFeedbackStatus` would write), an unreadable PR is `unverified`.
 */
export function projectFeedbackEntries(entries: readonly FeedbackEntry[], filedTasks: ReadonlyMap<string, string[]> | undefined, github: GitHub): ReconciledFeedbackEntry[] {
  const reconciled = entries.map((entry): ReconciledFeedbackEntry => {
    if (entry.status !== "proposed" || !entry.proposal_pr) return entry;
    const pr = github.prByRef(entry.proposal_pr);
    if (pr && pr.state === "MERGED") return { ...entry, status: "accepted", proposal_pr: entry.proposal_pr, summary: entry.summary ?? null, answered_by: entry.answered_by ?? null };
    if (!pr && github.readFailed?.()) return { ...entry, unverified: true };
    return entry;
  });
  return filedTasks ? decorateFeedbackDischargeByTasks(reconciled, filedTasks, github) : reconciled;
}

/**
 * Every key of the `feedback` view: all entries (the bare key) and each status (`status=<s>`), each in
 * pages of at most {@link pagesWithin}'s bytes, page n keyed `cursor=<offset>`. Every page carries the
 * counts by status, so one page draws the filter tabs.
 */
export function feedbackViewBodies(entries: readonly ReconciledFeedbackEntry[], source: ViewSource): FeedbackViewBody[] {
  const byStatus: Record<string, number> = {};
  for (const entry of entries) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
  const counts = { total: entries.length, byStatus };
  return (["all", ...FEEDBACK_STATUSES] as const).flatMap((status) => {
    const selected = status === "all" ? [...entries] : entries.filter((entry) => entry.status === status);
    const pages = pagesWithin(selected);
    let offset = 0;
    return pages.map((page, index) => {
      const at = offset;
      offset += page.length;
      const params = new URLSearchParams({ ...(status === "all" ? {} : { status }), ...(index === 0 ? {} : { cursor: String(at) }) });
      const next = index + 1 < pages.length ? { next: String(offset) } : {};
      return { key: viewKey(params), data: { status, entries: page, counts, page: { index, of: pages.length, total: selected.length, ...next } }, sources: [source] };
    });
  });
}

/** The entries projected and paged; the inline projection always answers (only its worker wrapper can refuse). */
function feedbackBodies(input: FeedbackProjectionInput, github: GitHub, clock: Clock): FeedbackViewBody[] {
  const { entries, filedTasks } = computeFeedbackProjectionSync(input) as Extract<FeedbackProjectionOutcome, { ok: true }>;
  return feedbackViewBodies(projectFeedbackEntries(entries, filedTasks ? new Map(filedTasks) : undefined, github), { name: `feedback-store:${FEEDBACK_VIEW_INSTANCE}`, asOf: clock.iso(), state: "fresh" });
}

/** One slow-lane pass: read every entry and the plan's filed tasks, project, and page. */
export function materializeFeedbackView(input: { root: string; planPath: string }, github: GitHub, clock: Clock = systemClock): FeedbackViewBody[] {
  return feedbackBodies(input, github, clock);
}

/**
 * The `feedback` view computed on serve's main thread: the shadow comparator's legacy side, and the
 * answer while the view is dark. It reads the entries inline (as GET /v1/feedback does with no
 * projection worker) over serve's in-memory plan, and writes nothing.
 */
export function feedbackLegacyView(deps: PanelGraphDeps, readPlanSnapshot?: () => Plan, clock: Clock = systemClock): ViewDefinition<FeedbackViewData> {
  return {
    name: FEEDBACK_VIEW_NAME,
    version: FEEDBACK_VIEW_VERSION,
    compute: (params) => {
      const status = params.get("status");
      if (status !== null && !(FEEDBACK_STATUSES as readonly string[]).includes(status)) return { error: `status must be one of ${FEEDBACK_STATUSES.join(", ")}` };
      const snapshot = readPlanSnapshot?.();
      const input = { root: deps.root, planPath: deps.planPath, ...(snapshot ? { taskOrigins: taskOriginsOf(snapshot) } : {}) };
      const body = feedbackBodies(input, deps.statusGithub, clock).find((b) => b.key === viewKey(params));
      return body ? { data: body.data, sources: body.sources } : { error: `no such page: ${viewKey(params)}` };
    },
  };
}
