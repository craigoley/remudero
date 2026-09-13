// test/serve.change-management.test.ts -- W1-T3396 (ratifies W1-T3186 (iii)).
//
// THE CLAIM. CHANGE MANAGEMENT is the RECORD-side lifecycle area: drain-rundown outcomes and
// resolved escalations render here, while ASK-classified items remain out. These tests extract the
// REAL shell functions from renderShellHtml(), then run them with the REAL classifier.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { renderShellHtml } from "../src/lib/serve.js";
import { classifyAskRecordItem } from "../src/lib/ask-classification.js";

interface ReconcileCall {
  id: string | undefined;
  rows: Array<{ key: string; html: string; taskId?: string; group?: string }>;
}

function clientSlice(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  assert.ok(from >= 0, `missing client source start ${start}`);
  const to = html.indexOf(end, from);
  assert.ok(to > from, `missing client source end ${end}`);
  return html.slice(from, to);
}

function changeManagementSource(html: string): string {
  return clientSlice(html, "const RECENT_VERB_LABEL", "// \u2500\u2500 W1-T163");
}

function needsMeSource(html: string): string {
  const askRowSrc = html.match(/function askRow\(classifierItem, key, html, extra\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(askRowSrc, "askRow must exist in the shell's inline script");
  const renderNeedsMeSrc = html.match(
    /function renderNeedsMe\(tasks, feedbackEntries, inboxReady, inboxDrafting\) \{[\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(renderNeedsMeSrc, "renderNeedsMe must exist in the shell's inline script");
  return `${askRowSrc}\n${renderNeedsMeSrc}`;
}

function runChangeManagement(src: string, fixture: { tasks?: unknown[]; recent?: unknown[] }): ReconcileCall[] {
  const calls: ReconcileCall[] = [];
  const reconcileRows = (el: { __id: string } | undefined, rows: ReconcileCall["rows"]) => calls.push({ id: el?.__id, rows });
  const clientPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "console-shell-client.ts");
  const clientText = readFileSync(clientPath, "utf8");
  const line = clientText.slice(0, clientText.indexOf("const RECENT_VERB_LABEL")).split("\n").length - 1;
  const context = {
    fixtureTasks: fixture.tasks ?? [], fixtureRecent: fixture.recent ?? [], classifyAskRecordItem,
    escapeHtml: (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    statusBadge: (key: string) => `<span class="status-label status-${key}">${key}</span>`, rowChevronHtml: () => '<button type="button" class="row-chevron"></button>', recentSpendHtml: () => "",
    recentPrLinkHtml: (e: { prUrl?: string }) => (e.prUrl ? ` <a class="recent-pr-link" href="${e.prUrl}">PR</a>` : ""), formatAgo: () => "5m ago", writeGateAttrs: () => "",
    reconcileRows, document: { getElementById: (id: string) => ({ __id: id }) }, finishSectionRender: () => {}, changeManagementSummaryText: (rows: unknown[]) => `${rows.length} lifecycle outcomes`, result: undefined as Set<string> | undefined,
  };
  new Script(`${"\n".repeat(line)}${src}\nresult = renderChangeManagement(fixtureTasks, fixtureRecent);`, { filename: clientPath }).runInNewContext(context);
  return calls;
}

function findRowFromClient(taskId: string, selectorHits: Record<string, unknown>): unknown {
  const clientPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "console-shell-client.ts");
  const clientText = readFileSync(clientPath, "utf8");
  const start = clientText.indexOf("function findRowByTaskId");
  const end = clientText.indexOf("  /**\n   * A dependency link", start);
  assert.ok(start >= 0 && end > start, "findRowByTaskId must remain a bounded client helper");
  const line = clientText.slice(0, start).split("\n").length - 1;
  const context = { taskId, CSS: { escape: (value: string) => value }, document: { querySelector: (selector: string) => selectorHits[selector] ?? null }, result: undefined as unknown };
  new Script(`${"\n".repeat(line)}${clientText.slice(start, end)}\nresult = findRowByTaskId(taskId);`, { filename: clientPath }).runInNewContext(context);
  return context.result;
}

function runNeedsMe(src: string, fixture: { tasks?: unknown[]; feedback?: unknown[]; inboxReady?: unknown[]; inboxDrafting?: unknown[] }): ReconcileCall[] {
  const calls: ReconcileCall[] = [];
  const reconcileRows = (el: { __id: string } | undefined, rows: ReconcileCall["rows"]) => calls.push({ id: el?.__id, rows });
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
    { getElementById: (id: string) => ({ __id: id }) },
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

function rowsFor(calls: ReconcileCall[], id: string): ReconcileCall["rows"] {
  return calls.find((c) => c.id === id)?.rows ?? [];
}

test("W1-T3396 (criterion 1): drain-rundown merged/blocked/escalated outcomes render in CHANGE MANAGEMENT with feedback intact", () => {
  const html = renderShellHtml();
  assert.match(html, /<section id="change-management" class="panel-section" aria-label="Change management"/);
  assert.match(html, /<span>Change management<\/span>/);

  const rows = rowsFor(
    runChangeManagement(changeManagementSource(html), {
      recent: [
        { taskId: "W1-T-MERGED", title: "merged task", verb: "merged", ts: "2026-01-01T00:00:00.000Z" },
        { taskId: "W1-T-BLOCKED", title: "blocked task", verb: "verdict", detail: "blocked", ts: "2026-01-01T00:01:00.000Z" },
        { taskId: "W1-T-ESC", title: "escalated task", verb: "escalated", detail: "BLOCKED-AMBIGUOUS", ts: "2026-01-01T00:02:00.000Z" },
        { taskId: "W1-T-FIX", title: "mid-rung fix", verb: "fix", ts: "2026-01-01T00:03:00.000Z" },
      ],
    }),
    "change-management-list",
  );

  assert.deepEqual(Array.from(rows, (r) => r.taskId).sort(), ["W1-T-BLOCKED", "W1-T-ESC", "W1-T-MERGED"].sort());
  const markup = rows.map((r) => r.html).join("\n");
  assert.match(markup, /data-verdict="good"/, "the W1-T141/W1-T435 good verdict button must survive");
  assert.match(markup, /data-verdict="wrong"/, "the W1-T141/W1-T435 wrong verdict button must survive");
  assert.match(markup, /data-verdict="needs-follow-up"/, "the W1-T141/W1-T435 needs-follow-up verdict button must survive");
  assert.doesNotMatch(markup, /W1-T-FIX/, "mid-rung RECENT activity is not a drain-rundown outcome line");
});

test("W1-T3396 (criterion 2): a RECORD-classified resolved escalation renders in CHANGE MANAGEMENT, not INBOX", () => {
  const html = renderShellHtml();
  const resolvedEscalation = { taskId: "W1-T-RESOLVED", needsHuman: false, escalationTitle: "[BLOCKED] answered", escalationIssueUrl: "https://example.test/issue/1" };

  const changeRows = rowsFor(runChangeManagement(changeManagementSource(html), { tasks: [resolvedEscalation] }), "change-management-list");
  assert.deepEqual(Array.from(changeRows, (r) => r.key), ["cm-escalation:W1-T-RESOLVED"]);
  assert.match(changeRows[0]!.html, /resolved escalation:/);

  const inboxRows = rowsFor(runNeedsMe(needsMeSource(html), { tasks: [resolvedEscalation] }), "inbox-list");
  assert.equal(inboxRows.length, 0, "the same resolved escalation must not be rendered as an INBOX ask");
});

test("W1-T3396 (criterion 3): CHANGE MANAGEMENT renders NO ASK-classified item", () => {
  const html = renderShellHtml();
  const rows = rowsFor(
    runChangeManagement(changeManagementSource(html), {
      tasks: [{ taskId: "W1-T-LIVE", needsHuman: true, escalationTitle: "[BLOCKED] still needs a decision" }],
      recent: [{ taskId: "W1-T-FIX", title: "mid-rung fix", verb: "fix", ts: "2026-01-01T00:03:00.000Z" }],
    }),
    "change-management-list",
  );
  assert.equal(rows.length, 0, "live unresolved escalations and non-rundown recent rows must stay out of CHANGE MANAGEMENT");

  const src = changeManagementSource(html);
  const direct = new Function(
    "classifyAskRecordItem",
    `${src}\nreturn [
      recordRow({ kind: "proposal", state: "ready" }, "p", "proposal"),
      recordRow({ kind: "escalation", resolved: false }, "e", "escalation"),
      recordRow({ kind: "question", answered: false }, "q", "question"),
    ];`,
  ) as (classify: typeof classifyAskRecordItem) => unknown[];
  assert.deepEqual(direct(classifyAskRecordItem), [null, null, null], "every ASK verdict must render as null in CHANGE MANAGEMENT");
});

test("W1-T3396: a lifecycle record never steals a deep link from the actionable or recent task row", () => {
  const taskId = "W1-T-DUPLICATE";
  const selector = `.row[data-task-id="${taskId}"]`;
  const hits = {
    [`#now-list ${selector}`]: { surface: "now" },
    [`#change-management-list ${selector}`]: { surface: "change-management" },
  };
  assert.equal((findRowFromClient(taskId, hits) as { surface: string }).surface, "now");
});
