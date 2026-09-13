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
import { bootConsoleShellClient } from "../src/lib/console-shell-client.js";
import { resolveFreshness } from "../src/lib/console-freshness.js";

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

// ── real-boot coverage (W1-T3396 round 2) ────────────────────────────────────────────────────
//
// The two suites above extract `renderChangeManagement`/`findRowByTaskId`'s SOURCE TEXT out of
// the served HTML and run it inside a `vm.Script` whose filename is pinned to the real
// `console-shell-client.ts` path, so a SINGLE-process coverage run attributes those hits back to
// the real file. That trick does not survive `coverage-ratchet`'s real shape: node's test runner
// forks one subprocess PER test FILE, and `console-shell-client.ts` is a normal ESM module every
// other `serve.*.test.ts` file also imports (`serve.ts` imports it at module scope) — so in every
// OTHER file's subprocess, the real module registers the SAME lines as never-hit, and merging
// raw V8 coverage across subprocesses keeps that zero rather than this file's `vm.Script` hit.
// The only attribution that survives the merge is a REAL call into the REAL exported function —
// `bootConsoleShellClient`, under the same DOM harness test/console-shell-client.test.ts already
// uses for the rest of the client (learnings#probe-must-exercise-the-real-consuming-client).

class StubClassList {
  private readonly names = new Set<string>();
  add(...names: string[]): void { for (const name of names) this.names.add(name); }
  remove(...names: string[]): void { for (const name of names) this.names.delete(name); }
  contains(name: string): boolean { return this.names.has(name); }
  toggle(name: string, force?: boolean): boolean {
    const next = force ?? !this.names.has(name);
    if (next) this.names.add(name);
    else this.names.delete(name);
    return next;
  }
}

class StubElement {
  readonly classList = new StubClassList();
  readonly dataset: Record<string, string> = {};
  private readonly attributes = new Map<string, string>();
  readonly children: StubElement[] = [];
  firstChild: StubElement | null = null;
  firstElementChild: StubElement | null = null;
  nextSibling: StubElement | null = null;
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  title = "";
  className = "";
  private inner = "";

  constructor(readonly id = "") {}

  get innerHTML(): string { return this.inner; }
  set innerHTML(value: string) { this.inner = value; }

  addEventListener(): void {}
  setAttribute(name: string, value: unknown): void { this.attributes.set(name, String(value)); }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }

  insertBefore(child: StubElement, anchor: StubElement | null): void {
    const existing = this.children.indexOf(child);
    if (existing !== -1) this.children.splice(existing, 1);
    const at = anchor ? this.children.indexOf(anchor) : -1;
    this.children.splice(at === -1 ? this.children.length : at, 0, child);
    this.firstChild = this.children[0] ?? null;
    this.firstElementChild = this.children[0] ?? null;
  }

  remove(): void {}
  after(): void {}
  contains(): boolean { return false; }
  querySelector(): StubElement | null { return null; }
  querySelectorAll(): StubElement[] { return []; }
  closest(): StubElement | null { return null; }
  click(): void {}
  focus(): void {}
  scrollIntoView(): void {}
}

/** A document stub minimal enough to boot the real client, plus ONE real behaviour the generic
 *  `test/console-shell-client.test.ts` harness never needed: `findRowByTaskId`'s own
 *  `#<listId> .row[data-task-id="…"]` selector, resolved against each list's REAL rendered
 *  children rather than a pre-registered lookup table (that selector shape is this task's own
 *  new surface, so no existing stub had a reason to understand it). */
function makeChangeManagementDocument(): { document: unknown; elements: Map<string, StubElement> } {
  const elements = new Map<string, StubElement>();
  const get = (id: string): StubElement => {
    let el = elements.get(id);
    if (!el) {
      el = new StubElement(id);
      elements.set(id, el);
    }
    return el;
  };
  get("rest-detail").hidden = true;
  const rowSelector = /^#([\w-]+) \.row\[data-task-id="(.*)"\]$/;
  const document = {
    title: "Remudero",
    body: get("body"),
    getElementById: get,
    createElement: (tag: string) => new StubElement(tag),
    querySelector: (selector: string): StubElement | null => {
      if (selector === "main") return get("main");
      const m = rowSelector.exec(selector);
      if (!m) return null;
      const [, listId, taskId] = m;
      return elements.get(listId)?.children.find((child) => child.dataset.taskId === taskId) ?? null;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  return { document, elements };
}

async function waitForBoot(elements: Map<string, StubElement>): Promise<void> {
  // `writeScopeResolved` (probeWriteScope) settles almost immediately -- it is not evidence
  // `refreshAll`'s own Promise.all (recent/feedback/inbox/…) has landed. `top-status`'s
  // `pollState` IS: it is the LAST write of a successful `refreshAll`, set only after
  // `paintFromTasksById()`/`applyDeepLinkIfNeeded()` have both already run (see refreshAll's own
  // body) -- so waiting on it is what actually proves CHANGE MANAGEMENT/the deep link resolved.
  for (let i = 0; i < 100; i += 1) {
    if (elements.get("top-status")?.dataset.pollState === "ok") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for bootConsoleShellClient to finish its first refresh");
}

/** Boots the REAL `bootConsoleShellClient` under a minimal DOM/fetch/storage stub, so the lines
 *  under test run as this module's OWN exported function -- not a text-sliced stand-in -- and so
 *  their coverage is attributed to a script V8 recognizes as `console-shell-client.ts` itself. */
async function withChangeManagementBoot(
  payload: { tasks?: Record<string, unknown>[]; recentEntries?: Record<string, unknown>[]; locationHash?: string },
  fn: (elements: Map<string, StubElement>) => Promise<void> | void,
): Promise<void> {
  const { document, elements } = makeChangeManagementDocument();
  const original = {
    window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage,
    fetch: globalThis.fetch, history: globalThis.history, CSS: globalThis.CSS, setInterval: globalThis.setInterval,
  };
  const storage = new Map<string, string>();
  const storageApi = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  const windowStub = {
    location: { search: "?token=stub-read", hash: payload.locationHash ?? "", pathname: "/" },
    sessionStorage: storageApi, localStorage: storageApi,
    matchMedia: () => ({ matches: true }), addEventListener: () => {}, open: () => null, confirm: () => false,
  };
  const bodies: Record<string, unknown> = {
    "/v1/status": { generated_at: "2026-09-13T00:00:00.000Z", tasks: payload.tasks ?? [], counts: {}, spend: null },
    "/v1/recent": { entries: payload.recentEntries ?? [] },
    "/v1/drain/preview?max=5": { cards: [] },
    "/v1/feedback": { entries: [] },
    "/v1/inbox": { ready: [], drafting: [] },
    "/v1/control/status": { paused: false, stopped: false, quietHours: false },
  };
  try {
    Object.assign(globalThis, {
      window: windowStub,
      document,
      localStorage: storageApi,
      history: { replaceState: () => {} },
      CSS: { escape: (value: unknown) => String(value) },
      setInterval: (() => 0) as unknown as typeof setInterval,
      fetch: ((input: unknown) => {
        const path = typeof input === "string" ? input : String(input);
        if (path === "/v1/status/stream") return new Promise<Response>(() => {});
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => bodies[path] ?? {},
          text: async () => JSON.stringify(bodies[path] ?? {}),
        } as Response);
      }) as typeof fetch,
    });
    bootConsoleShellClient({ default: 1 }, resolveFreshness);
    await waitForBoot(elements);
    await fn(elements);
  } finally {
    Object.assign(globalThis, original);
  }
}

test("W1-T3396: bootConsoleShellClient renders CHANGE MANAGEMENT rows for real, off the real /v1/recent + /v1/status responses", async () => {
  await withChangeManagementBoot(
    {
      tasks: [
        {
          taskId: "W1-T-RESOLVED",
          title: "resolved escalation",
          risk: "medium",
          status: "queued",
          merged: false,
          needsHuman: false,
          escalationTitle: "[BLOCKED] answered",
          escalationIssueUrl: "https://example.test/issue/1",
          escalationOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      recentEntries: [
        { taskId: "W1-T-MERGED", title: "merged task", verb: "merged", ts: "2026-01-01T00:00:00.000Z" },
        { taskId: "W1-T-BLOCKED", title: "blocked task", verb: "verdict", detail: "blocked", ts: "2026-01-01T00:01:00.000Z" },
        { taskId: "W1-T-ESC", title: "escalated task", verb: "escalated", detail: "BLOCKED-AMBIGUOUS", ts: "2026-01-01T00:02:00.000Z" },
        { taskId: "W1-T-FIX", title: "mid-rung fix", verb: "fix", ts: "2026-01-01T00:03:00.000Z" },
      ],
    },
    (elements) => {
      const rows = elements.get("change-management-list")?.children ?? [];
      assert.deepEqual(
        new Set(rows.map((row) => row.dataset.taskId)),
        new Set(["W1-T-MERGED", "W1-T-BLOCKED", "W1-T-ESC", "W1-T-RESOLVED"]),
        "merged/blocked/escalated outcomes and the resolved escalation all render; the non-outcome recent row does not",
      );
      const markup = rows.map((row) => row.innerHTML).join("\n");
      assert.match(markup, /resolved escalation:/, "the real changeManagementEscalationHtml body renders");
    },
  );
});

test("W1-T3396: a #task= deep link into a task that ALSO renders in CHANGE MANAGEMENT resolves through the real findRowByTaskId's priority loop, never crashing over the duplicate", async () => {
  await withChangeManagementBoot(
    {
      tasks: [{ taskId: "W1-T-DUP", title: "live", risk: "medium", status: "running", merged: false, phase: "implement" }],
      recentEntries: [{ taskId: "W1-T-DUP", title: "merged earlier", verb: "merged", ts: "2026-01-01T00:00:00.000Z" }],
      locationHash: "#task=W1-T-DUP",
    },
    (elements) => {
      const nowRow = elements.get("now-list")?.children.find((row) => row.dataset.taskId === "W1-T-DUP");
      const changeManagementRow = elements.get("change-management-list")?.children.find((row) => row.dataset.taskId === "W1-T-DUP");
      assert.ok(nowRow, "the live task must still render in NOW");
      assert.ok(changeManagementRow, "the same id must ALSO render as a rundown outcome, to prove this is a real duplicate");
      // The exact PRIORITY choice (NOW over the CHANGE MANAGEMENT duplicate) is already proven,
      // function-by-function, by the extracted-source test above; what a real boot proves that
      // extraction cannot is that `findRowByTaskId`'s own priority loop runs to completion, live,
      // over a genuinely duplicated id, without ever throwing back into `refreshAll`'s poll-failure
      // path -- the poll state below is the observable difference between "handled" and "escalated".
      assert.notEqual(elements.get("top-status")?.dataset.pollState, "stale", "the deep link must not escalate the poll to stale");
    },
  );
});

test("W1-T3396: a #task= deep link into a task NOT yet in any priority list still resolves, through findRowByTaskId's own fallback arm", async () => {
  // `focusAndExpandTask` calls `findRowByTaskId` BEFORE anything has forced "everything else"
  // open -- a plain, unremarkable task matches none of the 7 named lists yet, so this first call
  // falls through every loop iteration to the bare, unscoped `document.querySelector(rowSelector)`
  // (the diff's own new fallback line). Only the SECOND call, after `expandRest`/`applyFindState`
  // render it into `rest-list`, finds a row -- exercising the SAME loop's match arm too.
  await withChangeManagementBoot(
    {
      tasks: [{ taskId: "W1-T-PLAIN", title: "plain", risk: "medium", status: "queued", merged: false }],
      locationHash: "#task=W1-T-PLAIN",
    },
    (elements) => {
      const restRow = elements.get("rest-list")?.children.find((row) => row.dataset.taskId === "W1-T-PLAIN");
      assert.ok(restRow, "the deep link must force 'everything else' open and surface the plain task there");
      assert.notEqual(elements.get("top-status")?.dataset.pollState, "stale", "the deep link must not escalate the poll to stale");
    },
  );
});
