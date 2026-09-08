// test/needs-me-separates-asks-from-backlog.test.ts — W1-T3183
//
// THE GAP THIS PROVES CLOSED. `renderNeedsMe` (src/lib/serve.ts) used to build ONE `rows` array
// out of six sources (escalations, verify:human backlog, feedback grilling/proposed, inbox
// ready/drafting, blocked PRs) and feed that single blended array to ONE list, ONE header count
// and the browser tab title. MEASURED against the live console 2026-09-08: 53 of 66 rows were
// `verify: human` backlog (W1-T507) — never dispatched, never escalated, carrying no action
// affordance by W1-T507's OWN design — rendered indistinguishably from 5 real escalations, so
// the tab read "(66)" for a queue that was 80% "never needed a decision".
//
// This suite drives the REAL `renderNeedsMe` function, extracted (as text) from the ACTUAL
// rendered shell (`renderShellHtml()` — never a reimplementation) and executed with its row-html
// builders and DOM/section collaborators stubbed out, exactly the technique
// test/console-blocked-pr-queue.test.ts already uses for a single row template scaled up to the
// orchestrating function itself — because the four acceptance bars below are properties of what
// this function DOES with its rows (which list each lands in, what count each list reports),
// not of any one row's markup.
//
// Self-contained fixtures (test/human-verify-queue-surfaces.test.ts's own convention).

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderShellHtml } from "../src/lib/serve.js";
import { needsMeBacklogSummaryText, needsMeSummaryText } from "../src/lib/console-shell-script.js";

const ASK_IDS = ["W1-T4522", "W1-T4559", "W1-T4621", "W1-T4619", "W1-T-MAIN-HEALTH"];
const BACKLOG_IDS = Array.from({ length: 53 }, (_, i) => `W1-T${9000 + i}`);

/** The mixed fixture the falsifier itself demands: BOTH populations in ONE `tasks` array, off
 *  the SAME two mutually-exclusive fields status.ts's `projectPlan` actually sets
 *  (`needsHuman` / `verifyHumanPending` — human-verify-queue-surfaces.test.ts already proves a
 *  real projection never sets both on one task). A fixture with only one population would pass a
 *  "count is 0" assertion while proving nothing about separation. */
function mixedTasks(): Record<string, unknown>[] {
  return [
    ...ASK_IDS.map((id) => ({ taskId: id, needsHuman: true, escalationTitle: `[BLOCKED] ${id}: stuck` })),
    ...BACKLOG_IDS.map((id) => ({ taskId: id, verifyHumanPending: true })),
  ];
}

interface ReconcileCall {
  id: string | undefined;
  rows: Array<{ key: string; taskId?: string; group?: string }>;
}

interface Harness {
  reconcile: ReconcileCall[];
  setSectionSummary: Array<[string, string]>;
  finishSectionRender?: { isEmpty: boolean; text: string };
  shown: Set<string>;
}

function extractRenderNeedsMe(html: string): string {
  const src = html.match(
    /function renderNeedsMe\(tasks, feedbackEntries, inboxReady, inboxDrafting\) \{[\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(src, "renderNeedsMe must exist in the shell's inline script");
  return src!;
}

/** Runs the REAL, just-extracted `renderNeedsMe` with every collaborator it reaches into
 *  (row-html builders, DOM, the other section-render helpers) stubbed to a no-op or a recorder —
 *  this harness cares about which LIST each row lands in and which COUNT each list reports, never
 *  about a row's own markup (that is every other NEEDS ME test file's job, untouched by this one). */
function run(src: string, tasks: Record<string, unknown>[]): Harness {
  const calls: Harness = { reconcile: [], setSectionSummary: [], shown: new Set() };
  const stubDoc = { getElementById: (id: string) => ({ __id: id }) };
  const reconcileRows = (el: { __id: string } | undefined, rows: ReconcileCall["rows"]) => {
    calls.reconcile.push({ id: el?.__id, rows });
  };
  const setSectionSummary = (id: string, text: string) => {
    calls.setSectionSummary.push([id, text]);
  };
  const finishSectionRender = (_id: string, isEmpty: boolean, textFn: () => string) => {
    calls.finishSectionRender = { isEmpty, text: textFn() };
  };
  const fn = new Function(
    "fixtureTasks",
    "fixtureFeedback",
    "fixtureInboxReady",
    "fixtureInboxDrafting",
    "needsMeTaskRowHtml",
    "needsMeVerifyRowHtml",
    "needsMeGrillHtml",
    "needsMeProposedHtml",
    "needsMeInboxHtml",
    "needsMeDraftingHtml",
    "needsMeBlockedPrRowHtml",
    "needsMeBlockedPrUnverifiedHtml",
    "mergeHoldActionHtml",
    "latestBlockedPrs",
    "latestBlockedPrsUnverifiedReason",
    "reconcileRows",
    "document",
    "tickElapsed",
    "updateNeedsMeArrivalEmphasis",
    "finishSectionRender",
    "needsMeSummaryText",
    "sectionDefaultsReady",
    "setSectionSummary",
    "needsMeBacklogSummaryText",
    "latestNeedsMeRows",
    "renderGlanceStrip",
    "updateTabTitle",
    "updateGlanceAnomaly",
    `${src}\nreturn renderNeedsMe(fixtureTasks, fixtureFeedback, fixtureInboxReady, fixtureInboxDrafting);`,
  ) as (...args: unknown[]) => Set<string>;
  const shown = fn(
    tasks,
    [],
    [],
    [],
    (t: { taskId: string }) => `ask-html:${t.taskId}`,
    (t: { taskId: string }) => `backlog-html:${t.taskId}`,
    () => "grill-html",
    () => "proposed-html",
    () => "inbox-html",
    () => "drafting-html",
    () => "blocked-pr-html",
    () => "blocked-pr-unverified-html",
    () => "merge-hold-html",
    [],
    undefined,
    reconcileRows,
    stubDoc,
    () => {},
    () => {},
    finishSectionRender,
    needsMeSummaryText,
    true,
    setSectionSummary,
    needsMeBacklogSummaryText,
    [],
    () => {},
    () => {},
    () => {},
  );
  calls.shown = shown;
  return calls;
}

test("W1-T3183: asks and the verify:human backlog render into SEPARATE lists, each carrying only its own kind", () => {
  const html = renderShellHtml();
  const src = extractRenderNeedsMe(html);
  const result = run(src, mixedTasks());

  assert.equal(result.reconcile.length, 2, "exactly two reconcileRows calls -- one per group, never one blended call");
  const askCall = result.reconcile.find((c) => c.id === "needs-me-list");
  const backlogCall = result.reconcile.find((c) => c.id === "needs-me-backlog-list");
  assert.ok(askCall, "the ask group must render into needs-me-list");
  assert.ok(backlogCall, "the backlog group must render into its OWN list, needs-me-backlog-list");

  assert.equal(askCall!.rows.length, 5, "5 asks, not 58 -- the escalations only");
  assert.deepEqual(
    askCall!.rows.map((r) => r.taskId).sort(),
    [...ASK_IDS].sort(),
    "the ask list carries exactly the 5 escalation task ids and nothing from the backlog",
  );
  assert.ok(
    askCall!.rows.every((r) => r.group !== "backlog"),
    "no backlog row leaks into the ask list",
  );

  assert.equal(backlogCall!.rows.length, 53, "every one of the 53 backlog rows is still rendered -- W1-T507's visible-queue purpose survives");
  assert.deepEqual(
    backlogCall!.rows.map((r) => r.taskId).sort(),
    [...BACKLOG_IDS].sort(),
    "the backlog list carries exactly the 53 verify:human task ids and nothing from the asks",
  );
  assert.ok(
    backlogCall!.rows.every((r) => r.group === "backlog"),
    "no ask row leaks into the backlog list",
  );

  // Reachability: BOTH populations are in the returned `shown` set (renderRest's own exclusion
  // set) -- a backlog row that rendered but was never marked "shown" would double-render in REST.
  assert.equal(result.shown.size, 58);
  for (const id of [...ASK_IDS, ...BACKLOG_IDS]) assert.ok(result.shown.has(id), `${id} must be reachable via the returned shown set`);
});

test("W1-T3183: the operator-facing count is the ASK count alone -- a 53-backlog/5-ask fixture reads 5, never 58", () => {
  const html = renderShellHtml();
  const src = extractRenderNeedsMe(html);
  const result = run(src, mixedTasks());

  assert.ok(result.finishSectionRender, "finishSectionRender must be called for the needs-me section header");
  assert.equal(result.finishSectionRender!.isEmpty, false, "58 total rows exist -- the section is not empty");
  // The REAL needsMeSummaryText (console-shell-script.ts), called with the ask rows ALONE.
  assert.equal(result.finishSectionRender!.text, "5 open", "the header/tab-title count reads 5, the ask count -- never 58, the blended total");
  // Independent sanity check against the REAL exported function, off the ask-only subset --
  // never the full 58-row mixed fixture, which would read "58 open" and prove nothing.
  assert.equal(needsMeSummaryText(ASK_IDS.map(() => ({}))), "5 open");

  // The backlog gets its OWN, separately labelled count -- never silently absent, never folded
  // into the number above.
  const backlogSummary = result.setSectionSummary.find(([id]) => id === "needs-me-backlog");
  assert.ok(backlogSummary, "the backlog list's own count must be set");
  assert.equal(backlogSummary![1], "53 queued, never dispatched");

  // The tab title / glance strip read `latestNeedsMeRows`, assigned inside renderNeedsMe to the
  // ask rows alone (structural: proven directly on the extracted source, since the outer `let
  // latestNeedsMeRows` this assigns lives in serve.ts's own IIFE closure, outside this harness).
  assert.match(src, /latestNeedsMeRows = askRows;/, "latestNeedsMeRows -- read by updateTabTitle and the glance strip -- is assigned the ask rows, never the blended `rows`");
});

test("W1-T3183: a row's group is read off the SAME field that already selected its loop -- no second, independently-derived classifier", () => {
  const html = renderShellHtml();
  const src = extractRenderNeedsMe(html);

  // The backlog tag is set exactly once, in the SAME loop already gated on `verifyHumanPending`
  // (status.ts's own sparse field, human-verify-queue-surfaces.test.ts's subject) -- never a
  // fresh predicate re-parsing the row's rendered html or re-deriving "actionable" some other way.
  // Anchored to the actual object-literal PUSH (ends the row object and the call), so a doc
  // comment that merely mentions the tag in prose is never miscounted as a second site.
  const groupOccurrences = src.match(/group: "backlog" \}\);/g) ?? [];
  assert.equal(groupOccurrences.length, 1, "the backlog tag is set in exactly one place -- the verifyHumanPending loop -- never duplicated");
  assert.match(
    src,
    /if \(!t\.verifyHumanPending\) continue;[\s\S]*?group: "backlog"/,
    "the ONLY backlog tag sits inside the block already gated on t.verifyHumanPending",
  );
  // And the split itself reads that SAME field back, verbatim -- not a new isActionable(row)-style
  // helper that could disagree with the two loops above it.
  assert.match(src, /const askRows = rows\.filter\(\(r\) => r\.group !== "backlog"\);/);
  assert.match(src, /const backlogRows = rows\.filter\(\(r\) => r\.group === "backlog"\);/);
  // No second classifier anywhere in the shipped shell script either.
  assert.doesNotMatch(html, /function isActionable/);

  // Sanity: the escalation loop above never sets `group` at all -- a row with no actionable
  // referent is the ONLY one that opts itself out of "ask" by construction.
  const escalationPush = src.match(/rows\.push\(\{ key: `task:\$\{t\.taskId\}`[\s\S]*?\}\);/)?.[0];
  assert.ok(escalationPush);
  assert.doesNotMatch(escalationPush!, /group:/, "an escalation row never carries a group field -- it is an ask by omission, not by a second computed flag");
});

test("W1-T3183: the backlog list is a real, separate, always-rendered DOM element -- never a collapse, filter or pagination", () => {
  const html = renderShellHtml();
  assert.match(html, /<ul id="needs-me-list" class="row-list">/, "the ask list keeps its own existing id");
  assert.match(html, /<ul id="needs-me-backlog-list" class="row-list"[^>]*><\/ul>/, "the backlog gets its OWN list element, distinct from needs-me-list");
  assert.match(html, /<h3>Awaiting verification <span id="needs-me-backlog-summary" class="section-summary">…<\/span><\/h3>/, "the backlog heading carries its own labelled, separate count span");
  // The backlog heading/list carry no toggle/collapse control of their own (contrast: needs-me's
  // OWN top-level section keeps its existing needs-me-toggle, untouched, above both lists) --
  // W1-T507's "queue stays visible" purpose is preserved by never gating this list behind a click.
  assert.doesNotMatch(html, /id="needs-me-backlog-toggle"/);
});
