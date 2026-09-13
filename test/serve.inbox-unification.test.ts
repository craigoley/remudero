// test/serve.inbox-unification.test.ts — W1-T3395 (ratifies W1-T3186 (ii)).
//
// THE CLAIM. INBOX is the SOLE front door for an ask: proposals, live escalations, and
// clarification questions render as ONE classified feed with ONE resolution vocabulary. NEEDS ME
// is DISSOLVED -- not renamed, not relabelled with the same section underneath. Every item this
// section renders is a classifyAskRecordItem() (ask-classification.ts, W1-T3394) verdict of ASK,
// dispatched on the item's own TYPE, never on which array/section it happened to arrive in.
//
// Drives the REAL renderShellHtml() output and the REAL askRow/renderNeedsMe functions extracted
// from it (same technique as test/needs-me-separates-asks-from-backlog.test.ts) -- never a
// reimplementation -- plus the REAL, imported classifyAskRecordItem (never stubbed, since a stub
// could not falsify criterion 3).

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderShellHtml } from "../src/lib/serve.js";
import { classifyAskRecordItem } from "../src/lib/ask-classification.js";

/** Extracts askRow + renderNeedsMe (in that order) from the REAL served shell, exactly as
 *  test/needs-me-separates-asks-from-backlog.test.ts does -- askRow calls classifyAskRecordItem
 *  by bare name, so the harness below supplies the REAL imported function as a collaborator
 *  rather than re-splicing its (separately emitted, minified) source text. */
function extractAskRowAndRenderNeedsMe(html: string): string {
  const askRowSrc = html.match(/function askRow\(classifierItem, key, html, extra\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(askRowSrc, "askRow must exist in the shell's inline script");
  const renderNeedsMeSrc = html.match(
    /function renderNeedsMe\(tasks, feedbackEntries, inboxReady, inboxDrafting\) \{[\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(renderNeedsMeSrc, "renderNeedsMe must exist in the shell's inline script");
  return `${askRowSrc}\n${renderNeedsMeSrc}`;
}

interface ReconcileCall {
  id: string | undefined;
  rows: Array<{ key: string; taskId?: string; group?: string }>;
}

/** Runs the REAL, extracted renderNeedsMe with its row-html builders stubbed to a tag naming
 *  which builder ran (never about a row's own markup -- every other NEEDS ME/INBOX row-template
 *  test already covers that), and its DOM/section collaborators recorded rather than touching a
 *  real document. */
function run(src: string, fixture: { tasks?: unknown[]; feedback?: unknown[]; inboxReady?: unknown[]; inboxDrafting?: unknown[] }): ReconcileCall[] {
  const calls: ReconcileCall[] = [];
  const stubDoc = { getElementById: (id: string) => ({ __id: id }) };
  const reconcileRows = (el: { __id: string } | undefined, rows: ReconcileCall["rows"]) => {
    calls.push({ id: el?.__id, rows });
  };
  const fn = new Function(
    "fixtureTasks",
    "fixtureFeedback",
    "fixtureInboxReady",
    "fixtureInboxDrafting",
    "classifyAskRecordItem",
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
  fn(
    fixture.tasks ?? [],
    fixture.feedback ?? [],
    fixture.inboxReady ?? [],
    fixture.inboxDrafting ?? [],
    classifyAskRecordItem,
    (t: { taskId: string }) => `escalation-row:${t.taskId}`,
    (t: { taskId: string }) => `verify-row:${t.taskId}`,
    (e: { id: string }) => `grill-row:${e.id}`,
    (e: { id: string }) => `proposed-row:${e.id}`,
    (p: { proposalId: string }) => `proposal-row:${p.proposalId}`,
    (p: { proposalId: string }) => `drafting-row:${p.proposalId}`,
    () => "blocked-pr-html",
    () => "blocked-pr-unverified-html",
    () => "merge-hold-html",
    [],
    undefined,
    reconcileRows,
    stubDoc,
    () => {},
    () => {},
    () => {},
    () => "n open",
    true,
    () => {},
    () => "n queued",
    [],
    () => {},
    () => {},
    () => {},
  );
  return calls;
}

function askListRows(calls: ReconcileCall[]): Array<{ key: string; taskId?: string; group?: string }> {
  return calls.find((c) => c.id === "inbox-list")?.rows ?? [];
}

// ── criterion 1: NO section named NEEDS ME — dissolved, not renamed ────────────────────────────

test("W1-T3395 (criterion 1): the rendered shell carries an INBOX section, and NO section named NEEDS ME anywhere", () => {
  const html = renderShellHtml();

  assert.match(html, /<section id="inbox" class="panel-section" aria-label="Inbox"/, "the front door must be named INBOX");
  assert.match(html, /<span>Inbox<\/span>/, "the visible heading must read Inbox");
  assert.doesNotMatch(html, /<section id="needs-me"/, "NEEDS ME must not survive as a section id, renamed or otherwise");
  assert.doesNotMatch(html, /aria-label="Needs me"/, "NEEDS ME must not survive as an aria-label");
  assert.doesNotMatch(html, /<span>Needs me<\/span>/, "NEEDS ME must not survive as visible heading text");
  // Dissolved means every DOM id this section family renders under changed too -- a reviewer
  // grepping the shipped page for the old name finds nothing left to rename back.
  for (const oldId of ["needs-me", "needs-me-toggle", "needs-me-body", "needs-me-summary", "needs-me-list", "needs-me-backlog-list", "needs-me-backlog-summary"]) {
    assert.doesNotMatch(html, new RegExp(`id="${oldId}"`), `id="${oldId}" must not survive`);
  }
});

// ── criterion 2: every ASK-classified item renders in INBOX, regardless of source ──────────────

test("W1-T3395 (criterion 2): a proposal, an escalation, and a question -- three different sources -- all land in inbox-list when ASK", () => {
  const html = renderShellHtml();
  const src = extractAskRowAndRenderNeedsMe(html);

  const calls = run(src, {
    tasks: [{ taskId: "W1-T-ESC", needsHuman: true, escalationTitle: "[BLOCKED] W1-T-ESC: stuck" }],
    feedback: [{ id: "Q1", status: "grilling", raw: "which route?", ts: "2026-01-01T00:00:00.000Z" }],
    inboxReady: [{ proposalId: "P-READY", summary: "ratify this", state: "ready" }],
  });

  const rows = askListRows(calls);
  const keys = rows.map((r) => r.key).sort();
  assert.deepEqual(keys, ["fbg:Q1", "inbox:P-READY", "task:W1-T-ESC"].sort(), "all three ASK sources reach the SAME inbox-list, none dropped");
});

test("W1-T3395 (criterion 2): a not_ready and a deferred_with_trigger proposal are ASK too, per classifyAskRecordItem's own proposal arm", () => {
  const html = renderShellHtml();
  const src = extractAskRowAndRenderNeedsMe(html);

  const calls = run(src, {
    inboxReady: [
      { proposalId: "P-NR", summary: "not ready yet", state: "not_ready" },
      { proposalId: "P-DT", summary: "deferred with trigger", state: "deferred_with_trigger" },
    ],
  });
  const keys = askListRows(calls).map((r) => r.key).sort();
  assert.deepEqual(keys, ["inbox:P-DT", "inbox:P-NR"], "not_ready and deferred_with_trigger are ASK, not silently dropped");
});

// ── criterion 3: INBOX renders NO RECORD-classified item — the cross-section falsifier ─────────

test("W1-T3395 (criterion 3): a RECORD verdict never reaches inbox-list -- a drafting proposal, an answered question, a resolved escalation", () => {
  const html = renderShellHtml();
  const src = extractAskRowAndRenderNeedsMe(html);

  // The drafting proposal: already decided (rmd approve ran), classifyAskRecordItem's proposal
  // arm says RECORD for state "drafting" -- it must be absent even though it is still pushed
  // through renderNeedsMe's own inboxDrafting loop (never dropped upstream, dropped HERE).
  const calls = run(src, {
    tasks: [
      // A RESOLVED escalation (needsHuman: false) never even reaches renderNeedsMe's own
      // needsHuman-gated loop -- that pre-filter IS how a resolved escalation is excluded, so
      // this fixture proves the row simply never appears, not merely that it lacks a key.
      { taskId: "W1-T-RESOLVED", needsHuman: false, escalationTitle: "[BLOCKED] W1-T-RESOLVED: fixed" },
    ],
    feedback: [
      // "accepted"/"rejected"/"answered" statuses never reach renderNeedsMe's feedback loop at
      // all (the `else if` chain only matches grilling/proposed) -- same shape as above.
      { id: "Q-DONE", status: "answered", raw: "already answered", ts: "2026-01-01T00:00:00.000Z" },
    ],
    inboxDrafting: [{ proposalId: "P-DRAFTING", summary: "mid-draft", state: "drafting", spawnedAt: "2026-01-01T00:00:00.000Z" }],
  });

  const keys = askListRows(calls).map((r) => r.key);
  assert.equal(keys.length, 0, "a resolved escalation, an answered question, and a drafting proposal must ALL be absent from inbox-list");

  // Direct falsifier on askRow itself: classifyAskRecordItem's own RECORD verdicts, fed straight
  // in, must all come back null -- never rendered, regardless of which of the three kinds it is.
  const directFn = new Function(
    "classifyAskRecordItem",
    `${src}\nreturn [
      askRow({ kind: "proposal", state: "drafting" }, "k1", "h1"),
      askRow({ kind: "proposal", state: "ratified" }, "k2", "h2"),
      askRow({ kind: "escalation", resolved: true }, "k3", "h3"),
      askRow({ kind: "question", answered: true }, "k4", "h4"),
    ];`,
  ) as (classify: typeof classifyAskRecordItem) => unknown[];
  const results = directFn(classifyAskRecordItem);
  assert.deepEqual(results, [null, null, null, null], "every RECORD verdict, across all three ask-capable kinds, must render as null");
});

// ── criterion 4: all three ask types share ONE action vocabulary — dispatch on TYPE, not section ──

test("W1-T3395 (criterion 4): escalation, proposal and question rows are ALL built through the ONE shared askRow() gate", () => {
  const html = renderShellHtml();
  const renderNeedsMeSrc = html.match(
    /function renderNeedsMe\(tasks, feedbackEntries, inboxReady, inboxDrafting\) \{[\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(renderNeedsMeSrc, "renderNeedsMe must exist in the shell's inline script");

  // Structural: exactly ONE function named askRow exists in the shipped page (never a second,
  // independently-written gate for a different source that could drift from this one).
  const askRowDefCount = (html.match(/function askRow\(/g) ?? []).length;
  assert.equal(askRowDefCount, 1, "askRow must be defined exactly once");

  // Every one of the three ask-capable kinds' row-building calls dispatches through askRow --
  // never a bare, ungated rows.push(...) reintroducing a second, per-source rule.
  assert.match(renderNeedsMeSrc!, /askRow\(\{ kind: "escalation", resolved: false \}/, "escalation rows route through askRow");
  assert.match(renderNeedsMeSrc!, /askRow\(\{ kind: "proposal", state: p\.state \?\? "ready" \}/, "proposal rows route through askRow");
  assert.match(renderNeedsMeSrc!, /askRow\(\{ kind: "question", answered: false \}, `fbg:/, "a grilling question routes through askRow");
  assert.match(renderNeedsMeSrc!, /askRow\(\{ kind: "question", answered: false \}, `fbp:/, "a proposed question routes through askRow, the SAME gate a grilling one uses");

  // askRow's OWN body dispatches purely on the classifier's verdict for the item it was handed --
  // it names no section, no list id, no "needs-me"/"inbox" string of its own, so which list a
  // caller happens to reconcile the result into can never change whether/how it renders.
  const askRowSrc = html.match(/function askRow\(classifierItem, key, html, extra\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(askRowSrc, "askRow must exist in the shell's inline script");
  assert.doesNotMatch(askRowSrc!, /inbox|needs-me|section/i, "askRow must not know which section/list its caller will reconcile into");
  assert.match(askRowSrc!, /classifyAskRecordItem\(classifierItem\)/, "askRow's only dispatch key is the classifier's verdict on the item itself");
});
