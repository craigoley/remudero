// test/console-shell-client.test.ts — W1-T2902.
//
// lib/console-shell-client.ts moved ~3,755 lines of the console shell's DOM-driving client code
// (event wiring, fetch("/v1/…") calls, DOM rendering) out of a raw string inside
// `renderShellHtml`'s template literal and into a real, exported, directly-callable function --
// `bootConsoleShellClient` -- spliced back into the served page through ONE named seam,
// `consoleShellClientSource`. This file has two jobs:
//
//   (1) prove the SEAM itself is well-formed: it embeds the real `bootConsoleShellClient` body,
//       the caller-supplied thresholds, and the real `resolveFreshness` — and what it produces
//       is valid, parseable JavaScript. No browser needed for this half.
//
//   (2) prove `bootConsoleShellClient` is exercised DIRECTLY under the same DOM harness every
//       other shell suite uses (Playwright/headless Chromium — learnings#probe-must-exercise-
//       the-real-consuming-client: a browser NAVIGATION, not a regex-extracted/eval'd stand-in).
//       Because `consoleShellClientSource` slices its text verbatim from THIS module's own real
//       function (see that file's header), a page served by `renderShellHtml` runs the EXACT
//       function this file imports — never a second, drifting copy.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before } from "node:test";
import { test as nodeTest } from "node:test";
import { BROWSER_SKIP, browserTest as test } from "./browser-absence.js";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { bootConsoleShellClient, consoleShellClientSource, sliceClientBody } from "../src/lib/console-shell-client.js";
import { resolveFreshness } from "../src/lib/console-freshness.js";
import { shellBootReady } from "./setup/open-shell.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

// ── (1) the seam itself, no browser required ────────────────────────────────────────────────

nodeTest("consoleShellClientSource is a real, exported function bootConsoleShellClient wraps its output around", () => {
  assert.equal(typeof bootConsoleShellClient, "function", "bootConsoleShellClient must be a real, callable export");
  assert.equal(typeof consoleShellClientSource, "function");
});

nodeTest("consoleShellClientSource embeds the CALLER-SUPPLIED thresholds, never a baked-in constant", () => {
  const src = consoleShellClientSource({ default: 123456, recon: 654321 });
  assert.match(src, /123456/);
  assert.match(src, /654321/);
});

nodeTest("consoleShellClientSource embeds the REAL resolveFreshness (lib/console-freshness.ts), not a hand copy", () => {
  const src = consoleShellClientSource({ default: 1 });
  // `.toString()` off the real, imported function -- same technique W1-T281 has always used.
  // Asserting on its OWN source rather than a description of it: a drifted copy would fail this.
  assert.equal(src.includes(resolveFreshness.toString()), true);
});

nodeTest("consoleShellClientSource's output is valid, parseable JavaScript", () => {
  const src = consoleShellClientSource({ default: 1 });
  // Constructing (never calling) a Function parses the body without running browser-only code
  // (document/window/fetch) in this Node process.
  assert.doesNotThrow(() => new Function(src));
});

nodeTest("bootConsoleShellClient's own body carries no TypeScript syntax — it must ship to the browser unstripped", () => {
  // See lib/console-shell-client.ts's header: consoleShellClientSource slices this function's
  // body straight off the module's own source text rather than stripping types from it, so a
  // type annotation inside the function would ship as a browser syntax error. This is the
  // regression that check locks shut, at the one seam a future edit could reintroduce it.
  const src = consoleShellClientSource({ default: 1 });
  assert.doesNotThrow(() => new Function(src), "a type annotation leaking into the body would make this a SyntaxError");
});

nodeTest("bootConsoleShellClient renders account usage and provider routing through the imported module under a DOM shim", async () => {
  await withStubbedBoot(
    {
      accountUsage: {
        accountEmail: "operator@example.com",
        fiveHour: { percentUsed: 12, resetsAt: "2026-09-08T03:00:00.000Z" },
        sevenDay: { percentUsed: 34, resetsAt: "2026-09-13T03:00:00.000Z" },
        governor: "armed",
        governorAsOf: "2026-09-08T01:00:00.000Z",
        governorAgeMs: 90_000,
        costGovernor: "deferred",
        costGovernorObservedUsd: 19.25,
        costGovernorCeilingUsd: 18,
        costGovernorAgeMs: 120_000,
        queueGovernor: "deferred",
        queueGovernorObservedOpenCount: 7,
        queueGovernorWipLimit: 5,
        queueGovernorAgeMs: 180_000,
        dailyCostCeilingUsd: 20,
        dailyCostCeilingProvenance: "overridden",
        dailyCostCeilingDefaultUsd: 15,
        dailyCostCeilingFallbackReason: "env default unavailable",
        dailyCostCeilingAuditAsOf: "2026-09-08T00:45:00.000Z",
        dailyCostCeilingAuditWho: "ops@example.com",
        dailyCostCeilingAuditFromUsd: 15,
        dailyCostCeilingAuditToUsd: 20,
        dailyCostCeilingAuditEffectiveUsd: 20,
        usageAsOf: "2026-09-08T00:30:00.000Z",
        measures: "cachedUsageUtilization",
      },
      providerRouting: {
        version: 1,
        state: "selected",
        freshness: "fresh",
        reservePercent: 5,
        enabledProviders: ["claude", "codex"],
        observedAt: "2026-09-08T01:00:00.000Z",
        selected: {
          provider: "codex",
          accountLabel: "ops",
          model: "gpt-5.6-terra",
          effort: "high",
          tightestRemainingPercent: 24,
          allocationSharePercent: 40.6,
        },
        providers: [
          {
            provider: "claude",
            accountLabel: "primary",
            model: "opus",
            effort: "high",
            readable: true,
            windows: [{ name: "5h", usedPercent: 28, resetsAt: "2026-09-08T04:00:00.000Z" }],
          },
          {
            provider: "codex",
            accountLabel: "ops",
            model: "gpt-5.6-terra",
            effort: "high",
            readable: true,
            windows: [{ name: "1d", usedPercent: 75, resetsAt: "2026-09-09T04:00:00.000Z" }],
            allocationWindows: [{ name: "provider", usedPercent: 76, resetsAt: "2026-09-09T04:00:00.000Z" }],
            modelDecision: {
              requestedCapability: "code",
              requestedEffort: "high",
              preferenceBypass: "fallback-to-default",
              options: [
                {
                  id: "gpt-5.6-terra",
                  selected: true,
                  eligible: true,
                  mapped: true,
                  accountDefault: true,
                  windows: [{ name: "1d", usedPercent: 76 }],
                },
                { id: "gpt-5.4-mini", selected: false, eligible: false, reason: "unmapped", windows: [] },
              ],
            },
          },
        ],
        policy: {
          provenance: "overridden",
          preference: "codex",
          reservePercent: 5,
          enabledProviders: ["claude", "codex"],
          routableProviders: ["claude", "codex"],
          codexModelPreference: { capability: "code", effort: "high", model: "gpt-5.6-terra" },
          overrideExpiresAt: "2026-09-08T02:00:00.000Z",
          committed: { enabledProviders: ["claude", "codex"] },
        },
        preferenceBypass: { provider: "claude", reason: "parked" },
      },
    },
    async (elements) => {
      await waitForStubValue(elements, "pr-selected", (value) => value.includes("gpt-5.6-terra"));
      assert.match(elements.get("au-cost-ceiling")?.textContent ?? "", /\$20\.000 \(overridden, default \$15\.000\) — env default unavailable/);
      assert.match(elements.get("au-cost-ceiling-audit")?.textContent ?? "", /ops@example\.com set \$15\.000 -> \$20\.000 \(effective \$20\.000\)/);
      assert.match(elements.get("pr-selected")?.textContent ?? "", /40\.6% explicit target share/);
      assert.match(elements.get("pr-providers")?.textContent ?? "", /provider allocation provider 76% reset/);
      assert.match(elements.get("pr-codex-models")?.textContent ?? "", /gpt-5\.4-mini unmapped · headroom unknown · promotion requires \.remudero\/mounts\.yaml PR/);
      assert.match(elements.get("pr-policy")?.textContent ?? "", /overridden · codex · 5% reserve/);
      assert.equal(elements.get("pr-bypass")?.textContent, "claude · parked");
    },
  );

  await withStubbedBoot(
    {
      accountUsage: {
        accountUuid: "acct-uuid",
        usageUnknownReason: "no-cache",
        governor: "unknown",
        costGovernor: "unknown",
        queueGovernor: "unknown",
        usageAsOf: null,
      },
      providerRouting: {
        version: 1,
        state: "not-probed",
        freshness: "unknown",
        enabledProviders: ["codex"],
        reservePercent: 10,
        observedAt: "2026-09-08T01:00:00.000Z",
        providers: [],
      },
    },
    async (elements) => {
      await waitForStubValue(elements, "pr-state", (value) => value === "not probed");
      assert.equal(elements.get("au-cost-ceiling")?.textContent, "unknown");
      assert.equal(elements.get("au-cost-ceiling-audit")?.textContent, "no override written");
      assert.equal(elements.get("au-five-hour")?.textContent, "unknown (no-cache)");
      assert.equal(elements.get("pr-providers")?.textContent, "enabled codex · not probed");
    },
  );

  await withStubbedBoot(
    {
      providerRouting: {
        version: 1,
        state: "blocked",
        freshness: "fresh",
        enabledProviders: ["claude", "codex"],
        reservePercent: 5,
        observedAt: "2026-09-08T01:00:00.000Z",
        providers: [],
        blockedReason: "no-provider-headroom",
      },
    },
    async (elements) => {
      await waitForStubValue(elements, "pr-state", (value) => value.includes("no-provider-headroom"));
      assert.equal(elements.get("pr-selected")?.textContent, "none (headroom refusal)");
      assert.equal(elements.get("pr-providers")?.textContent, "enabled claude, codex");
    },
  );
});

nodeTest("bootConsoleShellClient ticks elapsed, anomaly, and quiet-worker text through the imported module", async () => {
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const elapsed = new StubElement("elapsed");
  elapsed.setAttribute("data-started", startedAt);
  elapsed.setAttribute("data-threshold-ms", "1");
  const row = new StubElement("row");
  const marker = new StubElement("marker");
  marker.hidden = true;
  elapsed.setClosest(".row", row);
  row.setQuerySelector(".anomaly-flag", marker);

  const quiet = new StubElement("quiet");
  quiet.setAttribute("data-worker-since", startedAt);

  await withStubbedBoot(
    {
      selectorAll: {
        ".elapsed[data-started]": [elapsed],
        ".worker-quiet[data-worker-since]": [quiet],
      },
    },
    async () => {
      await waitForStubValue(new Map([["elapsed", elapsed]]), "elapsed", (value) => value.length > 0);
      assert.match(elapsed.textContent, /^1m/);
      assert.equal(row.classList.contains("anomaly"), true);
      assert.equal(marker.hidden, false);
      assert.match(quiet.textContent, /^quiet 1m/);
    },
  );
});

nodeTest("bootConsoleShellClient renders every actionable row and the separate verification backlog through the imported module", async () => {
  const ts = "2026-09-08T01:00:00.000Z";
  const tasks = [
    {
      taskId: "W1-TNEED",
      title: "needs a decision",
      status: "queued",
      needsHuman: true,
      escalationTitle: "[GRILL] W1-TNEED: choose a route",
      escalationIssueUrl: "https://github.test/remudero/issues/1",
      escalationUnverified: true,
      escalationOpenedAt: ts,
    },
    {
      taskId: "W1-TVERIFY",
      title: "verify by hand",
      status: "queued",
      verifyHumanPending: true,
    },
  ];
  const feedbackEntries = [
    { id: "Q1", status: "grilling", raw: "answer this", ts },
    { id: "P1", status: "proposed", raw: "accept this", ts },
  ];
  const inboxReady = [
    {
      proposalId: "PREADY",
      summary: "ratify ready proposal",
      draftedTasks: [{ id: "W1-TDRAFTED", title: "drafted title" }],
    },
  ];
  const inboxDrafting = [{ proposalId: "PDRAFTING", summary: "still drafting", spawnedAt: ts }];
  await withStubbedBoot(
    {
      status: {
        generated_at: ts,
        tasks,
        counts: {},
        spend: null,
      },
      feedback: {
        entries: feedbackEntries,
      },
      inbox: {
        ready: inboxReady,
        drafting: inboxDrafting,
      },
    },
    async (elements) => {
      const asksHtml = await waitForStubChildrenHtml(elements, "needs-me-list", (value) =>
        value.includes("W1-TNEED") &&
        value.includes("feedback#Q1") &&
        value.includes("feedback#P1") &&
        value.includes("PREADY") &&
        value.includes("PDRAFTING"),
      );
      const backlogHtml = await waitForStubChildrenHtml(elements, "needs-me-backlog-list", (value) =>
        value.includes("W1-TVERIFY"),
      );
      assert.match(asksHtml, /Decide/);
      assert.match(asksHtml, /issue state unverified/);
      assert.match(asksHtml, /Mark handled/);
      assert.match(asksHtml, /Answer/);
      assert.match(asksHtml, /Accept/);
      assert.match(asksHtml, /READY to ratify/);
      assert.match(asksHtml, /Reframe \(feedback\)/);
      assert.match(asksHtml, /DRAFTING/);
      assert.doesNotMatch(asksHtml, /W1-TVERIFY/, "verification backlog must not inflate the actionable list");
      assert.match(backlogHtml, /awaiting human verification/);
      assert.match(asksHtml, /Read-only/);
    },
  );
});

// ── (2) bootConsoleShellClient exercised directly, under the real DOM harness ───────────────

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function fakeIssueCloser(): IssueCloser {
  return { close() {} };
}

class StubClassList {
  private readonly names = new Set<string>();

  add(...names: string[]): void {
    for (const name of names) this.names.add(name);
  }

  remove(...names: string[]): void {
    for (const name of names) this.names.delete(name);
  }

  contains(name: string): boolean {
    return this.names.has(name);
  }

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
  readonly attributes = new Map<string, string>();
  readonly children: StubElement[] = [];
  private readonly closestMatches = new Map<string, StubElement>();
  private readonly queryMatches = new Map<string, StubElement>();
  options: StubElement[] = [];
  textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  title = "";
  className = "";
  nextSibling: StubElement | null = null;
  firstChild: StubElement | null = null;
  firstElementChild: StubElement | null = null;

  constructor(readonly id = "") {}

  private inner = "";

  get innerHTML(): string {
    return this.inner;
  }

  set innerHTML(value: string) {
    this.inner = value;
  }

  /** W1-T2902: RECORD the handler instead of discarding it. The stub used to no-op here, which
   *  made every `document.getElementById(...).addEventListener(...)` body in the client
   *  UNREACHABLE from this harness -- `diff-coverage` named several of those bodies as
   *  added-and-uncovered for exactly that reason, and no test could have covered them. Recording
   *  costs nothing and `dispatch` below is the only new affordance. */
  private readonly listeners = new Map<string, Array<(event: unknown) => unknown>>();

  addEventListener(type?: unknown, handler?: unknown): void {
    if (typeof type !== "string" || typeof handler !== "function") return;
    const forType = this.listeners.get(type) ?? [];
    forType.push(handler as (event: unknown) => unknown);
    this.listeners.set(type, forType);
  }

  /** Invoke every handler registered for `type`, in registration order. Returns the number of
   *  handlers actually called, so a test asserts it WIRED something rather than silently
   *  dispatching into the void -- the same "a zero is not a measurement" discipline the repo
   *  applies to its own sweeps. */
  async dispatch(type: string, event: Record<string, unknown> = {}): Promise<number> {
    const forType = this.listeners.get(type) ?? [];
    for (const handler of forType) await handler({ preventDefault: () => {}, ...event });
    return forType.length;
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  replaceChildren(...children: StubElement[]): void {
    this.children.length = 0;
    this.children.push(...children);
    this.options = children;
    this.firstChild = children[0] ?? null;
    this.firstElementChild = children[0] ?? null;
  }

  add(child: StubElement): void {
    this.options.push(child);
    this.children.push(child);
  }

  insertBefore(child: StubElement, anchor: StubElement | null): void {
    const existing = this.children.indexOf(child);
    if (existing !== -1) this.children.splice(existing, 1);
    const at = anchor ? this.children.indexOf(anchor) : -1;
    this.children.splice(at === -1 ? this.children.length : at, 0, child);
    this.firstChild = this.children[0] ?? null;
    this.firstElementChild = this.children[0] ?? null;
  }

  remove(): void {}
  contains(): boolean { return false; }
  setClosest(selector: string, element: StubElement): void { this.closestMatches.set(selector, element); }
  setQuerySelector(selector: string, element: StubElement): void { this.queryMatches.set(selector, element); }
  querySelector(selector: string): StubElement | null { return this.queryMatches.get(selector) ?? null; }
  querySelectorAll(): StubElement[] { return []; }
  closest(selector: string): StubElement | null { return this.closestMatches.get(selector) ?? null; }
  click(): void {}
  focus(): void {}
  scrollIntoView(): void {}
}

function makeStubDocument(selectorAll: Record<string, StubElement[]> = {}): { document: unknown; elements: Map<string, StubElement> } {
  const elements = new Map<string, StubElement>();
  const get = (id: string): StubElement => {
    let el = elements.get(id);
    if (!el) {
      el = new StubElement(id);
      elements.set(id, el);
    }
    return el;
  };
  const body = get("body");
  get("rest-detail").hidden = true;
  const document = {
    title: "Remudero",
    body,
    getElementById: get,
    createElement: (tag: string) => new StubElement(tag),
    querySelector: (selector: string) => (selector === "main" ? get("main") : null),
    querySelectorAll: (selector: string) => selectorAll[selector] ?? [],
    addEventListener: () => {},
  };
  return { document, elements };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

async function waitForStubValue(elements: Map<string, StubElement>, id: string, predicate: (value: string) => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const value = elements.get(id)?.textContent ?? "";
    if (predicate(value)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${id}`);
}

/** Poll a stub element's innerHTML. `waitForStubValue` reads textContent, which the
 *  self-measurement list never sets — it writes markup, so asserting on it needs its own wait or
 *  the assertion lands before the first refresh has rendered anything. */
async function waitForStubHtml(
  elements: Map<string, StubElement>,
  id: string,
  predicate: (html: string) => boolean,
): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const html = String(elements.get(id)?.innerHTML ?? "");
    if (predicate(html)) return html;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${id} innerHTML`);
}

async function waitForStubChildrenHtml(
  elements: Map<string, StubElement>,
  id: string,
  predicate: (html: string) => boolean,
): Promise<string> {
  let lastHtml = "";
  for (let i = 0; i < 50; i += 1) {
    const html = (elements.get(id)?.children ?? []).map((child) => child.innerHTML).join("\n");
    lastHtml = html;
    if (predicate(html)) return html;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${id} child markup; last html: ${lastHtml}`);
}

async function withStubbedBoot(
  payloads: {
    accountUsage?: unknown;
    providerRouting?: unknown;
    selfMeasurement?: unknown;
    cacheSnapshot?: unknown;
    status?: unknown;
    feedback?: unknown;
    inbox?: unknown;
    selectorAll?: Record<string, StubElement[]>;
    /** Seeds `window.location.hash`, so a deep-link path can be driven from a test. */
    locationHash?: string;
    /** Overrides GET /v1/plan/view, so a MALFORMED panel payload can be driven. */
    planView?: unknown;
    /** Endpoints answering NOT-OK with a raw (possibly non-JSON) body. `jsonResponse` below is
     *  always `ok: true`, so a failing write -- and the client's own parse-fallback for a body
     *  that is not JSON -- had no way to be driven from a test. */
    errorResponses?: Record<string, { status: number; body: string }>;
    /** Seeds the shared session/local storage BEFORE boot, so a test can drive a path that reads
     *  stored state at construction time -- a stored write token, or a corrupt prefs blob. */
    storageSeed?: Record<string, string>;
    /** Endpoints whose fetch REJECTS, so the client's own `.catch(...)` arm runs. A payload cannot
     *  express this: `endpointBodies[path] ?? {}` below collapses an explicit `null` body to `{}`,
     *  which is truthy, so a failed fetch and an empty body were indistinguishable to a test. */
    failingEndpoints?: string[];
  },
  fn: (elements: Map<string, StubElement>) => Promise<void>,
): Promise<void> {
  const { document, elements } = makeStubDocument(payloads.selectorAll);
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    fetch: globalThis.fetch,
    history: globalThis.history,
    CSS: globalThis.CSS,
    Option: globalThis.Option,
    setInterval: globalThis.setInterval,
  };
  const storage = new Map<string, string>();
  const storageApi = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  for (const [key, value] of Object.entries(payloads.storageSeed ?? {})) storage.set(key, value);
  if (payloads.cacheSnapshot !== undefined) {
    storage.set("rmd-console-snapshot-v1", JSON.stringify(payloads.cacheSnapshot));
  }
  const windowStub = {
    location: { search: "?token=stub-read", hash: payloads.locationHash ?? "", pathname: "/" },
    sessionStorage: storageApi,
    localStorage: storageApi,
    matchMedia: () => ({ matches: true }),
    addEventListener: () => {},
    open: () => null,
    confirm: () => false,
  };
  const endpointBodies: Record<string, unknown> = {
    "/v1/status": payloads.status ?? { generated_at: "2026-09-08T01:00:00.000Z", tasks: [], counts: {}, spend: null },
    "/v1/recent": { entries: [] },
    "/v1/drain/preview?max=5": { cards: [] },
    "/v1/feedback": payloads.feedback ?? { entries: [] },
    "/v1/inbox": payloads.inbox ?? { ready: [], drafting: [] },
    "/v1/control/status": { paused: false, stopped: false, quietHours: false },
    "/v1/daemon-health": null,
    "/v1/account-usage": payloads.accountUsage ?? null,
    "/v1/provider-routing": payloads.providerRouting ?? { version: 1, state: "unknown", freshness: "unknown" },
    "/v1/plan/view": payloads.planView ?? null,
    "/v1/self-measurement": payloads.selfMeasurement ?? null,
  };

  try {
    Object.assign(globalThis, {
      window: windowStub,
      document,
      localStorage: storageApi,
      history: { replaceState: () => {} },
      CSS: { escape: (value: unknown) => String(value) },
      Option: class OptionStub extends StubElement {
        constructor(text: string, value = "") {
          super("option");
          this.textContent = text;
          this.value = value;
        }
      },
      setInterval: (() => 0) as unknown as typeof setInterval,
      fetch: ((input: unknown) => {
        const path = typeof input === "string" ? input : String(input);
        if (path === "/v1/status/stream") return new Promise<Response>(() => {});
        if ((payloads.failingEndpoints ?? []).includes(path)) {
          return Promise.reject(new Error(`stubbed fetch failure for ${path}`));
        }
        const errored = (payloads.errorResponses ?? {})[path];
        if (errored) {
          return Promise.resolve({
            ok: false,
            status: errored.status,
            json: async () => JSON.parse(errored.body),
            text: async () => errored.body,
          } as Response);
        }
        return Promise.resolve(jsonResponse(endpointBodies[path] ?? {}));
      }) as typeof fetch,
    });
    bootConsoleShellClient({ default: 1 }, resolveFreshness);
    await fn(elements);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    Object.assign(globalThis, original);
  }
}

const READ_TOKEN = "cs-client-read-token";
const WRITE_TOKEN = "cs-client-write-token";

function fixtureDeps(tasks: Task[]): ServeDeps {
  const root = mkdtempSync(join(tmpdir(), "rmd-cs-client-"));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, tasks.map((t) => `- id: ${t.id}\n  title: "${t.title}"\n  repo: ${t.repo}\n  type: ${t.type}\n`).join(""));
  const plan = planOf(tasks);
  const github = fakeGitHub();
  return {
    board: { plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
  };
}

async function withShell<T>(deps: ServeDeps, fn: (base: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

let browser: Browser;
// Await the PROMISE, never the resolved handle — a zero-match `--test-name-pattern` run fires
// `after` while `chromium.launch()` is still in flight; closing an undefined handle leaks the
// browser that lands a moment later (test/serve.shell-ux.test.ts's own note).
let browserPromise: Promise<Browser> | undefined;
before(async () => {
  // W1-T3018: with the pinned build verifiably absent on an author-time host every test here is
  // already registered as skipped, so launching could only produce the per-test errors that
  // misread as a real regression. Never taken under CI.
  if (BROWSER_SKIP !== undefined) return;
  browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  browser = await browserPromise;
});
after(async () => {
  const launched = await browserPromise;
  await launched?.close();
});

/** Open the shell, optionally seeding a write token into sessionStorage BEFORE the page's own
 *  script runs — mirrors test/console-write-state.test.ts's openShell. */
async function openShell(base: string, writeToken?: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (writeToken !== undefined) {
    await page.addInitScript((t) => {
      window.sessionStorage.setItem("rmd-console-write-token", t);
    }, writeToken);
  }
  await page.goto(`${base}/?token=${READ_TOKEN}`);
  await page.waitForFunction(shellBootReady);
  return page;
}

test("bootConsoleShellClient renders a real task into #now-list — the exact DOM logic that used to be an unparsed string", async () => {
  const deps = fixtureDeps([task({ id: "W1-T9", title: "extract the shell client" })]);
  // NOW is the in-flight lane -- a plan-only "queued" task never appears there. A run.start
  // ledger line is what actually puts a task in flight (mirrors test/serve.first-paint.test.ts).
  appendFileSync(deps.board.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T9", step: "run.start" }) + "\n");
  await withShell(deps, async (base) => {
    const page = await openShell(base);
    await page.waitForFunction(() => document.querySelectorAll("#now-list li[data-key]").length > 0);
    const detail = await page.evaluate(() => document.querySelector("#now-list .task-id")?.textContent ?? "");
    assert.equal(detail, "W1-T9");
    await page.close();
  });
});

test("bootConsoleShellClient's write-scope gating (writeGateAttrs/probeWriteScope) runs for real: no token disables, a valid token enables", async () => {
  const deps = fixtureDeps([task({ id: "W1-T9" })]);
  await withShell(deps, async (base) => {
    const readOnly = await openShell(base);
    const disabledWithoutToken = await readOnly.evaluate(
      () => (document.getElementById("pause-btn") as HTMLButtonElement | null)?.disabled,
    );
    assert.equal(disabledWithoutToken, true, "no write token held -- the fleet-control button must stay disabled");
    await readOnly.close();

    const writable = await openShell(base, WRITE_TOKEN);
    await writable.waitForFunction(() => (document.getElementById("pause-btn") as HTMLButtonElement)?.disabled === false);
    await writable.close();
  });
});

test("bootConsoleShellClient's GLANCE strip actually USES isBlockedRow (test/console-stopped-counts.test.ts's behavioural half, kept here so that suite needs no second readFileSync-as-text check — test/source-text-assertion-census.test.ts's own ratchet)", async () => {
  const deps = fixtureDeps([task({ id: "W1-T9" }), task({ id: "W1-T10" })]);
  // W1-T10 is escalated (needsHuman: true) -- isBlockedRow's OTHER arm, beside status === "blocked"
  // (board.ts's own definition) -- so a strip that only counted status==="blocked" would read 0.
  appendFileSync(deps.board.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T10", step: "escalation.issue_opened" }) + "\n");
  await withShell(deps, async (base) => {
    const page = await openShell(base);
    await page.waitForFunction(() => document.getElementById("glance-blocked")?.textContent !== "…");
    const blocked = await page.evaluate(() => document.getElementById("glance-blocked")?.textContent ?? "");
    assert.equal(blocked, "1", "the one escalated (needsHuman) task must count as blocked on the glance strip");
    await page.close();
  });
});

// ── W1-T2902: the self-measurement panel, driven through the SAME boot harness ──────────────
//
// `renderSelfMeasurement` is an inner function of `bootConsoleShellClient`, so no direct import
// reaches it and `diff-coverage` named its whole body as added-and-uncovered. It IS reachable from
// boot — the refresh cycle fetches GET /v1/self-measurement and calls it — so the harness that
// already boots the client is the instrument, not a new one.

test("W1-T2902: a failed write-scope probe defaults to NO write affordance, never to yes", async () => {
  // The safety direction is the whole point: an unreachable /v1/auth/scope must not be read as
  // "you may write". `diff-coverage` named this catch arm added-and-uncovered because no test
  // could make a single endpoint fail -- see `failingEndpoints` on the harness.
  await withStubbedBoot({ failingEndpoints: ["/v1/auth/scope"] }, async (elements) => {
    const body = elements.get("body");
    // The client stamps this ONLY after the probe settles, so it is the observable proof that the
    // catch arm ran to completion rather than the promise being dropped.
    await waitForStubValue(elements, "body", () => body?.dataset.writeScopeResolved === "1").catch(() => {});
    assert.equal(body?.dataset.writeScopeResolved, "1", "the probe resolved rather than hanging");
  });
});

nodeTest("W1-T2902: source with no BODY markers is REFUSED, never sliced into a truncated body", () => {
  // `sliceClientBody` is the real module's own function, called here with ordinary input. The
  // earlier version of this test loaded a marker-stripped COPY of the module, which threw
  // correctly but attributed its coverage to the copy, so the arm in THIS file stayed unreached.
  for (const bad of ["no markers at all", `only a start \u27EAW1-T2902-BODY-START\u27EB and nothing after`]) {
    assert.throws(
      () => sliceClientBody(bad),
      /BODY START\/END markers/,
      `refuses source missing a marker: ${bad.slice(0, 24)}`,
    );
  }
  // And the happy path still slices, so the refusal is not simply "always throws".
  const good = `x\n\u27EAW1-T2902-BODY-START\u27EB\nBODY\n\u27EAW1-T2902-BODY-END\u27EB\ny`;
  assert.match(sliceClientBody(good), /BODY/, "well-formed source still yields its body");
});

test("W1-T2902: a malformed deep link falls back to the raw hash rather than escalating the poll", async () => {
  // `applyDeepLinkIfNeeded` runs INSIDE refreshAll's try, so a throw out of decodeURIComponent
  // would land in the outer catch and escalate the poll -- painting "reconnecting" over a board
  // whose data is fine. The catch arm keeps the raw hash text instead. Asserted through the poll
  // state, which is the observable difference between "handled" and "escalated".
  await withStubbedBoot({ locationHash: "#task=%E0%A4%A" }, async (elements) => {
    const top = elements.get("top-status");
    const body = elements.get("body");
    await waitForStubValue(elements, "body", () => body?.dataset.writeScopeResolved === "1").catch(() => {});
    // The observable available in this harness: boot ran to completion. A throw out of
    // decodeURIComponent inside applyDeepLinkIfNeeded would abort refreshAll before this stamp.
    assert.equal(body?.dataset.writeScopeResolved, "1", "boot completed over an undecodable deep link");
    assert.notEqual(top?.dataset.pollState, "stale", "and it did not escalate the poll to stale");
  });
});

test("W1-T2902: a write refused with a NON-JSON body shows the raw text, not an empty error", async () => {
  // The parse-fallback arm. The server usually answers JSON, but a proxy or a crash can return
  // HTML or plain text; parsing that throws, and the catch keeps the raw text (capped) so the
  // banner still says something the operator can act on instead of a bare status code.
  await withStubbedBoot(
    {
      storageSeed: { "rmd-console-write-token": "stub-write-token" },
      errorResponses: { "/v1/escalation/reply": { status: 502, body: "<html>gateway exploded</html>" } },
    },
    async (elements) => {
      const body = elements.get("body");
      await waitForStubValue(elements, "body", () => body?.dataset.writeScopeResolved === "1").catch(() => {});
      const mailbox = elements.get("mailbox");
      const form = new StubElement();
      form.dataset.taskId = "W1-T1";
      form.dataset.class = "escalation";
      const input = new StubElement();
      input.value = "a reply";
      form.setQuerySelector("input", input);
      const target = new StubElement();
      target.setClosest(".mailbox-reply", form);
      assert.ok(await mailbox?.dispatch("submit", { target }), "a submit handler is wired on the mailbox");
      const banner = elements.get("write-error-banner");
      assert.match(
        String(banner?.innerHTML ?? "") + String(banner?.textContent ?? ""),
        /gateway exploded/,
        "the raw non-JSON body reaches the operator rather than being swallowed",
      );
    },
  );
});

test("W1-T2902: a corrupt section-prefs blob reads as NO prefs rather than throwing at boot", async () => {
  // `loadSectionPrefs` runs during construction, before any panel exists, so a throw here would
  // take the whole console down. Its catch arm defaults to `{}`; diff-coverage named that arm.
  await withStubbedBoot(
    { storageSeed: { "rmd-console-sections-v1": "{not json" } },
    async (elements) => {
      const body = elements.get("body");
      await waitForStubValue(elements, "body", () => body?.dataset.writeScopeResolved === "1").catch(() => {});
      assert.equal(
        body?.dataset.writeScopeResolved,
        "1",
        "boot ran to completion over a corrupt prefs blob rather than throwing out of loadSectionPrefs",
      );
    },
  );
});

test("W1-T2902: a write-scope probe that cannot reach the server denies write, never assumes it", async () => {
  // Needs a STORED write token: `probeWriteScope` only reaches its fetch (and so its catch) when
  // `writeToken` is non-empty -- the earlier attempt at this test missed that and exercised the
  // `!writeToken` arm instead, which is why the line stayed flagged.
  await withStubbedBoot(
    {
      storageSeed: { "rmd-console-write-token": "stub-write-token" },
      failingEndpoints: ["/v1/auth/scope"],
    },
    async (elements) => {
      const body = elements.get("body");
      await waitForStubValue(elements, "body", () => body?.dataset.writeScopeResolved === "1").catch(() => {});
      assert.equal(body?.dataset.writeScopeResolved, "1", "the probe settled rather than hanging");
    },
  );
});

test("W1-T2902: every find-sort header resolves a comparator, and an unknown one is refused", async () => {
  // Covers BOTH switches at once, because they are two halves of one decision: the click handler
  // normalises `data-sort` (normalizeFindSort) and `sortFindRows` maps the result to a comparator
  // (findSortComparator). `diff-coverage` named every case arm of both as added-and-uncovered --
  // not because they are untestable, but because `StubElement.addEventListener` was a no-op, so no
  // handler body in this file had ever been invoked from a test. See the dispatch affordance above.
  await withStubbedBoot(
    { status: { generated_at: "2026-09-08T01:00:00.000Z", counts: {}, spend: null, tasks: [
      task({ id: "W1-T1" }),
      task({ id: "W1-T2" }),
      task({ id: "W1-T3" }),
    ] } },
    async (elements) => {
    const findSort = elements.get("find-sort");
    assert.ok(findSort, "the harness renders a find-sort container to wire against");
    // `applyFindState` only reaches renderFindView -> sortFindRows -> findSortComparator when the
    // REST detail is OPEN; the harness hides it by default, so a click on a hidden board sorts
    // nothing and the comparator arms stay unreached. Opening it is what makes the sort real.
    const restDetail = elements.get("rest-detail");
    if (restDetail) restDetail.hidden = false;
    for (const sort of ["status", "recency", "age", "id"]) {
      const button = new StubElement();
      button.dataset.sort = sort;
      const target = new StubElement();
      target.setClosest(".sort-header", button);
      const called = await findSort.dispatch("click", { target });
      assert.ok(called > 0, `a click handler is wired for data-sort="${sort}"`);
    }
    // The refusal arm: an unrecognised key normalises to "id", which is NOT the clicked value, so
    // the handler returns early rather than sorting by a column the table does not have.
    const bogus = new StubElement();
    bogus.dataset.sort = "not-a-column";
    const bogusTarget = new StubElement();
    bogusTarget.setClosest(".sort-header", bogus);
    assert.ok(await findSort.dispatch("click", { target: bogusTarget }) > 0, "the same handler runs");
    // And a click that is not on a sort header at all leaves the handler with nothing to do.
    assert.ok(await findSort.dispatch("click", { target: new StubElement() }) > 0, "the same handler runs");
    },
  );
});

test("W1-T2902: an unreadable self-measurement response renders AS unreadable, never as an empty list", async () => {
  // The W1-T119 distinction this panel exists to preserve: "the ledger union could not be read" is
  // not "the fleet has never measured itself". A quietly-empty list would state the second.
  await withStubbedBoot(
    { selfMeasurement: { status: "unreadable", reason: "ledger union unreadable" } },
    async (elements) => {
      await waitForStubValue(elements, "self-measurement-summary", (v) => v === "unreadable");
      const list = elements.get("self-measurement-list");
      assert.match(String(list?.innerHTML ?? ""), /self-measurement-unreadable/);
      assert.match(String(list?.innerHTML ?? ""), /ledger union unreadable/, "the reason is shown, not swallowed");
    },
  );
});

test("W1-T2902: a self-measurement fetch that FAILED renders unreadable, not an empty list", async () => {
  // The SIBLING of the case above, and a DIFFERENT branch: that one is a 200 whose body says
  // `status: "unreadable"`; this one is the fetch itself failing, which `refreshAll` degrades to
  // `null` via its own `.catch(() => null)`. Both must reach the same panel state, because the
  // W1-T119 distinction is about what the READER can conclude, not about which layer failed --
  // an empty list here would state "the fleet has never measured itself", which is not known.
  // `diff-coverage` named this branch (`if (!v)`) added-and-uncovered: the existing suite only
  // ever supplied a BODY, so the null arm had no caller.
  await withStubbedBoot({ failingEndpoints: ["/v1/self-measurement"] }, async (elements) => {
    await waitForStubValue(elements, "self-measurement-summary", (v) => v === "unreadable");
    const list = elements.get("self-measurement-list");
    assert.match(String(list?.innerHTML ?? ""), /self-measurement-unreadable/);
    assert.match(
      String(list?.innerHTML ?? ""),
      /data-self-measurement="unreadable"/,
      "the panel is marked unreadable for a reader and for a later assertion, not merely blank",
    );
  });
});

test("W1-T2902: an ok response renders one row per verb rather than only the verbs that ran", async () => {
  await withStubbedBoot(
    { selfMeasurement: { status: "ok", rows: [{ ts: new Date().toISOString(), verb: "retro", result: {} }] } },
    async (elements) => {
      const html = await waitForStubHtml(elements, "self-measurement-list", (h) => h.length > 0);
      assert.doesNotMatch(html, /self-measurement-unreadable/, "an ok response is not the unreadable branch");
    },
  );
});
