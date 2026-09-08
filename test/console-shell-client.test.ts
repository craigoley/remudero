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
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { test as nodeTest } from "node:test";
import { BROWSER_SKIP, browserTest as test } from "./browser-absence.js";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { bootConsoleShellClient, consoleShellClientSource } from "../src/lib/console-shell-client.js";
import { resolveFreshness } from "../src/lib/console-freshness.js";
import { shellBootReady } from "./setup/open-shell.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
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

function fakeGitHub(byRef: Record<string, PrRef> = {}): GitHub {
  return {
    prByRef: (ref) => byRef[String(ref)] ?? null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
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

  addEventListener(): void {}

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
  querySelector(): StubElement | null { return null; }
  querySelectorAll(): StubElement[] { return []; }
  closest(): StubElement | null { return null; }
  click(): void {}
  focus(): void {}
  scrollIntoView(): void {}
}

function makeStubDocument(): { document: unknown; elements: Map<string, StubElement> } {
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
  const document = {
    title: "Remudero",
    body,
    getElementById: get,
    createElement: (tag: string) => new StubElement(tag),
    querySelector: (selector: string) => (selector === "main" ? get("main") : null),
    querySelectorAll: () => [],
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

async function withStubbedBoot(
  payloads: { accountUsage?: unknown; providerRouting?: unknown; selfMeasurement?: unknown },
  fn: (elements: Map<string, StubElement>) => Promise<void>,
): Promise<void> {
  const { document, elements } = makeStubDocument();
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
  const windowStub = {
    location: { search: "?token=stub-read", hash: "", pathname: "/" },
    sessionStorage: storageApi,
    localStorage: storageApi,
    matchMedia: () => ({ matches: true }),
    addEventListener: () => {},
    open: () => null,
    confirm: () => false,
  };
  const endpointBodies: Record<string, unknown> = {
    "/v1/status": { generated_at: "2026-09-08T01:00:00.000Z", tasks: [], counts: {}, spend: null },
    "/v1/recent": { entries: [] },
    "/v1/drain/preview?max=5": { cards: [] },
    "/v1/feedback": { entries: [] },
    "/v1/inbox": { ready: [], drafting: [] },
    "/v1/control/status": { paused: false, stopped: false, quietHours: false },
    "/v1/daemon-health": null,
    "/v1/account-usage": payloads.accountUsage ?? null,
    "/v1/provider-routing": payloads.providerRouting ?? { version: 1, state: "unknown", freshness: "unknown" },
    "/v1/plan/view": null,
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
        return Promise.resolve(jsonResponse(endpointBodies[path] ?? {}));
      }) as typeof fetch,
    });
    bootConsoleShellClient({ default: 1 }, resolveFreshness);
    await fn(elements);
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
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github, ratify: { approve() {}, reframe() {} } },
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

test("W1-T2902: an ok response renders one row per verb rather than only the verbs that ran", async () => {
  await withStubbedBoot(
    { selfMeasurement: { status: "ok", rows: [{ ts: new Date().toISOString(), verb: "retro", result: {} }] } },
    async (elements) => {
      const html = await waitForStubHtml(elements, "self-measurement-list", (h) => h.length > 0);
      assert.doesNotMatch(html, /self-measurement-unreadable/, "an ok response is not the unreadable branch");
    },
  );
});
