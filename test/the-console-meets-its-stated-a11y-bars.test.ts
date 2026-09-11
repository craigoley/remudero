import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test as nodeTest } from "node:test";

import { AxeBuilder } from "@axe-core/playwright";
import { Window } from "happy-dom";
import { chromium, type Browser, type Page } from "playwright";

import { bootConsoleShellClient } from "../src/lib/console-shell-client.js";
import { resolveFreshness } from "../src/lib/console-freshness.js";
import { rowChevronHtml } from "../src/lib/console-shell-script.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import { BROWSER_SKIP, browserTest as test } from "./browser-absence.js";
import { shellBootReady } from "./setup/open-shell.js";

const READ_TOKEN = "console-a11y-read-token";
const WRITE_TOKEN = "console-a11y-write-token";
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
] as const;
const MIN_TARGET_PX = 24;
const MIN_TEXT_PX = 12;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

async function withClientDom(fn: (document: globalThis.Document) => Promise<void> | void): Promise<void> {
  const window = new Window({ url: `http://127.0.0.1/?token=${READ_TOKEN}` });
  const document = window.document as unknown as globalThis.Document;
  document.body.innerHTML = '<main><span id="connection-indicator"></span><ul id="now-list"></ul></main>';
  const realGetElementById = document.getElementById.bind(document);
  document.getElementById = ((id: string) => {
    let el = realGetElementById(id);
    if (el) return el;
    el = document.createElement(id.endsWith("-list") || id === "mailbox" ? "ul" : "div");
    el.id = id;
    document.querySelector("main")?.append(el);
    return el;
  }) as typeof document.getElementById;
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    history: globalThis.history,
    CSS: globalThis.CSS,
    Option: globalThis.Option,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
  };
  try {
    Object.assign(globalThis, {
      window,
      document,
      localStorage: window.localStorage,
      sessionStorage: window.sessionStorage,
      history: window.history,
      CSS: { escape: (value: unknown) => String(value).replace(/"/g, '\\"') },
      Option: function OptionStub(text = "", value = "") {
        const option = document.createElement("option") as HTMLOptionElement;
        option.textContent = String(text);
        option.value = String(value);
        return option;
      },
      setInterval: (() => 0) as unknown as typeof setInterval,
      fetch: ((input: unknown) => {
        const url = new URL(typeof input === "string" ? input : String(input), "http://127.0.0.1");
        if (url.pathname === "/v1/status/stream") return new Promise<Response>(() => {});
        if (url.pathname === "/v1/task") {
          return Promise.resolve(jsonResponse({ card: { id: "W1-T3184", title: "covered", status: "queued", journey: [] } }));
        }
        return Promise.resolve(jsonResponse({ generated_at: "2026-09-08T12:01:00.000Z", tasks: [], entries: [], cards: [], ready: [], drafting: [], rows: [] }));
      }) as typeof fetch,
    });
    bootConsoleShellClient({ default: 1 }, resolveFreshness);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fn(document);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    Object.assign(globalThis, original);
  }
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T3184",
    title: "live console accessibility fixture",
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

function statusStub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function traceStub(): TraceGithub {
  return { prView: () => null };
}

function fakeIssueCloser(): IssueCloser {
  return { close() {} };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-console-a11y-"));
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "");
  return p;
}

function writePlan(root: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n", { flag: "wx" });
  return planPath;
}

function fixtureDeps(root: string): ServeDeps {
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root);
  const github = statusStub();
  return {
    board: { plan: planOf([task()]), ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: traceStub(), statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    identity: { trustedLocalAddress: "127.0.0.1", capability: "remudero:console" },
    pollMs: 50,
  };
}

nodeTest("live console disclosure state stays on the chevron button, not the list item", async () => {
  await withClientDom(async (document) => {
    const list = document.getElementById("now-list");
    assert.ok(list);
    const row = document.createElement("li");
    row.className = "row";
    row.dataset.key = "task:W1-T3184";
    row.dataset.taskId = "W1-T3184";
    row.innerHTML = `<span class="task-id">W1-T3184</span>${rowChevronHtml()}`;
    list.append(row);

    const button = row.querySelector<HTMLButtonElement>(".row-chevron");
    assert.ok(button);
    button.click();
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(button.getAttribute("aria-controls"), "row-detail-task-W1-T3184");
    assert.equal(row.hasAttribute("aria-expanded"), false);
    assert.equal(row.hasAttribute("aria-controls"), false);

    button.click();
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(button.hasAttribute("aria-controls"), false);
    assert.equal(row.hasAttribute("aria-expanded"), false);
  });
});

function liveShapedTasks(): unknown[] {
  return Array.from({ length: 5 }, (_, i) => ({
    taskId: `W1-T3184-${i + 1}`,
    title: `live escalation row ${i + 1}`,
    repo: "remudero",
    status: "queued",
    risk: "high",
    needsHuman: true,
    escalationTitle: `[GRILL] W1-T3184-${i + 1}: answer the console a11y finding`,
    escalationIssueUrl: `https://github.com/craigoley/remudero/issues/${4000 + i}`,
    escalationOpenedAt: "2026-09-08T12:00:00.000Z",
  }));
}

async function withShell(fn: (base: string) => Promise<void>): Promise<void> {
  const root = tmpRoot();
  const server = buildServeServer(fixtureDeps(root));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

let browser: Browser;
let browserPromise: Promise<Browser> | undefined;
before(async () => {
  if (BROWSER_SKIP !== undefined) return;
  browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  browser = await browserPromise;
});
after(async () => {
  const launched = await browserPromise;
  await launched?.close();
});

async function openLiveShapedShell(base: string, viewport: (typeof VIEWPORTS)[number]): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: { "tailscale-app-capabilities": JSON.stringify({ "remudero:console": {} }) },
    viewport,
  });
  await context.route("**/v1/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generated_at: "2026-09-08T12:01:00.000Z",
        tasks: liveShapedTasks(),
        spend: { mergedToday: 0, spendTodayUsd: 0, spendWeekUsd: 0 },
        blockedPrs: [],
        mergeHeld: [],
        prQueue: { complete: true, rows: [] },
        recap: [],
      }),
    }),
  );
  await context.route("**/v1/recent", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }) }));
  await context.route("**/v1/drain/preview?max=5", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) }));
  await context.route("**/v1/feedback", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }) }));
  await context.route("**/v1/inbox/digests", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [], omitted: 0 }) }));
  await context.route("**/v1/inbox", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ready: [], drafting: [] }) }));
  await context.route("**/v1/control/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ paused: false, stopped: false, quietHours: false }) }));
  await context.route("**/v1/daemon-health", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }));
  await context.route("**/v1/account-usage", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }));
  await context.route("**/v1/provider-routing", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "not-probed" }) }));
  await context.route("**/v1/plan/view", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ progress: {}, sections: [], frontier: [] }) }));
  await context.route("**/v1/self-measurement", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", rows: [] }) }));

  const page = await context.newPage();
  await page.goto(`${base}/?token=${READ_TOKEN}`);
  await page.waitForFunction(shellBootReady);
  await page.waitForSelector("#mailbox .mailbox-thread", { state: "visible" });
  return page;
}

test("live-shaped console fixture passes axe-core with no WCAG violations", async () => {
  await withShell(async (base) => {
    const page = await openLiveShapedShell(base, VIEWPORTS[0]);
    try {
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      assert.ok(results.passes.length > 0, "positive control: axe must actually run rules");
      assert.deepEqual(
        results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
        [],
      );
    } finally {
      await page.context().close();
    }
  });
});

test("live-shaped console fixture renders five named reply controls", async () => {
  await withShell(async (base) => {
    const page = await openLiveShapedShell(base, VIEWPORTS[0]);
    try {
      const namedReplyBoxes = await page.getByLabel(/^Reply to W1-T3184-/).count();
      assert.equal(namedReplyBoxes, 5);
      const unnamed = await page.locator("input:not([type=hidden]), textarea, select").evaluateAll((controls) =>
        controls
          .filter((control) => {
            const el = control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
            const labelledBy = el.getAttribute("aria-labelledby");
            const labelledByText = labelledBy
              ? labelledBy.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim())
              : false;
            return !el.getAttribute("aria-label")?.trim() && !labelledByText && (el.labels?.length ?? 0) === 0;
          })
          .map((control) => `${control.tagName.toLowerCase()}#${control.id || "(no id)"}`),
      );
      assert.deepEqual(unnamed, []);
    } finally {
      await page.context().close();
    }
  });
});

test("live-shaped console fixture has no interactive target under 24x24 at measured viewports", async () => {
  await withShell(async (base) => {
    for (const viewport of VIEWPORTS) {
      const page = await openLiveShapedShell(base, viewport);
      try {
        const smallTargets = await page.locator('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])').evaluateAll((els, min) =>
          els
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
            })
            .map((el) => {
              const rect = el.getBoundingClientRect();
              return { label: (el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.id || el.tagName).trim(), width: rect.width, height: rect.height };
            })
            .filter((target) => target.width < (min as number) || target.height < (min as number)),
        MIN_TARGET_PX);
        assert.deepEqual(smallTargets, [], `${viewport.width}x${viewport.height}`);
      } finally {
        await page.context().close();
      }
    }
  });
});

test("live-shaped console fixture renders no text below the stated 12px floor", async () => {
  await withShell(async (base) => {
    const page = await openLiveShapedShell(base, VIEWPORTS[0]);
    try {
      const tinyText = await page.locator("body *").evaluateAll((els, min) =>
        els
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && (el.textContent || "").trim() !== "";
          })
          .filter((el) => Array.from(el.children).every((child) => (child.textContent || "").trim() === ""))
          .map((el) => ({ text: (el.textContent || "").trim().slice(0, 80), px: Number.parseFloat(window.getComputedStyle(el).fontSize) }))
          .filter((item) => item.px < (min as number)),
      MIN_TEXT_PX);
      assert.deepEqual(tinyText, []);
    } finally {
      await page.context().close();
    }
  });
});

test("live-shaped console fixture keeps heading levels contiguous in rendered order", async () => {
  await withShell(async (base) => {
    const page = await openLiveShapedShell(base, VIEWPORTS[0]);
    try {
      const skips = await page.locator("h1, h2, h3, h4, h5, h6").evaluateAll((headings) => {
        let previous = 0;
        const failures: string[] = [];
        for (const heading of headings) {
          const rect = heading.getBoundingClientRect();
          const style = window.getComputedStyle(heading);
          if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
          const level = Number(heading.tagName.slice(1));
          if (previous > 0 && level > previous + 1) failures.push(`${heading.tagName.toLowerCase()} after h${previous}: ${(heading.textContent || "").trim()}`);
          previous = level;
        }
        return failures;
      });
      assert.deepEqual(skips, []);
    } finally {
      await page.context().close();
    }
  });
});
