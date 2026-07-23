// test/serve.first-paint.test.ts — W1-T154 (console first-paint: pre-warm + skeleton/last-
// snapshot cache + progressive load), the acceptance bars that can only be proven against a REAL
// browser client (learnings#probe-must-exercise-the-real-consuming-client). The gateway-level
// pre-warm mechanics (buildBatchedGithub.warm/prewarmBoardGithub) are unit-tested directly in
// test/status.test.ts and test/serve.test.ts; this file proves what a real page load actually
// SHOWS: a skeleton (never blank) on a true cold start, a last-snapshot cache painted instantly
// and stamped STALE before swapping to fresh data, first-screen content painting before slower
// secondary endpoints resolve, and the full <2s first-paint-to-data budget at 183-task scale —
// via Playwright (headless Chromium), same tooling test/serve.shell-ux.test.ts already uses.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

const READ_TOKEN = "first-paint-read-token";
const WRITE_TOKEN = "first-paint-write-token";

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

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-first-paint-"));
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "");
  return p;
}

function planYaml(plan: Plan): string {
  if (plan.tasks.length === 0) return "[]\n";
  return plan.tasks.map((t) => `- id: ${t.id}\n  title: "${t.title}"\n  repo: ${t.repo}\n  type: ${t.type}\n`).join("");
}

function writePlan(root: string, yamlBody: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, yamlBody, { flag: "wx" });
  return planPath;
}

function fixtureDeps(root: string, tasks: Task[]): ServeDeps {
  const plan = planOf(tasks);
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, planYaml(plan));
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});
after(async () => {
  await browser.close();
});

// ── (b) skeleton — a TRUE cold start (no cache at all) shows a skeleton, never a blank page ────

test("cold start (no cache), /v1/status delayed: the shell shows a SKELETON immediately, never a blank/empty block", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root, [task({ id: "W1-T1" })]), async (base) => {
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    // Delay /v1/status well past first paint -- proves the skeleton is what the FIRST frame
    // shows, not a race that happens to resolve fast enough to hide a blank interval.
    await page.route("**/v1/status", async (route) => {
      await sleep(1500);
      await route.continue();
    });
    await page.goto(`${base}/?token=${READ_TOKEN}`);
    // Give the page a moment to parse + run its synchronous first-paint script, but nowhere near
    // long enough for the (1500ms-delayed) live fetch to have resolved.
    await sleep(200);
    const state = await page.evaluate(() => ({
      skeletonCount: document.querySelectorAll("#now-list li.skeleton").length,
      nowListEmpty: document.getElementById("now-list")?.innerHTML.trim() === "",
      stale: document.getElementById("top-status")?.getAttribute("data-stale"),
    }));
    assert.ok(state.skeletonCount > 0, "a true cold start must render skeleton rows, not nothing");
    assert.equal(state.nowListEmpty, false, "the row list must never be a blank/empty block while loading");
    assert.notEqual(state.stale, "true", "no cache exists yet -- there is nothing to stamp stale");
    await context.close();
  });
});

// ── (b) last-snapshot cache: painted instantly, stamped STALE, swaps to fresh on arrival ───────

test("last-snapshot cache: a reload paints the CACHED snapshot instantly (stamped STALE), then swaps to fresh data when the delayed live fetch resolves", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]);
  // W1-T1 is IN FLIGHT at "recon" for the first load.
  appendFileSync(deps.board.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "run.start" }) + "\n");

  await withShell(deps, async (base) => {
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();

    // Load 1: real, undelayed -- populates the localStorage last-snapshot cache with phase=recon.
    await page.goto(`${base}/?token=${READ_TOKEN}`);
    await page.waitForFunction(() => document.getElementById("top-status")?.textContent?.includes("updated"));
    const firstPaintPhase = await page.evaluate(() => document.querySelector("#now-list .detail")?.textContent ?? "");
    assert.match(firstPaintPhase, /phase: recon/);

    // Advance the REAL state: W1-T1 moves from recon -> implement.
    appendFileSync(deps.board.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "recon.done" }) + "\n");

    // Load 2 (a reload, SAME browser context -- localStorage persists): delay /v1/status so the
    // cache-restore path is observable before the live (now-different) data arrives.
    await page.route("**/v1/status", async (route) => {
      await sleep(700);
      await route.continue();
    });
    await page.reload();
    await sleep(150); // well before the 700ms delayed response, well after the synchronous cache-paint
    const staleState = await page.evaluate(() => ({
      phase: document.querySelector("#now-list .detail")?.textContent ?? "",
      stale: document.getElementById("top-status")?.getAttribute("data-stale"),
      badgeHidden: (document.getElementById("stale-badge") as HTMLElement)?.hidden,
    }));
    assert.match(staleState.phase, /phase: recon/, "the cache must paint the PREVIOUS (stale) snapshot instantly");
    assert.equal(staleState.stale, "true", "the stale cache-paint must be stamped via data-stale");
    assert.equal(staleState.badgeHidden, false, "the STALE badge must be visible while showing cached data");

    // Now let the delayed live fetch land and confirm the swap to fresh data. Wait for the FULL
    // refresh to finish -- top-status's "updated ..." text is set only after EVERY section has
    // repainted, including clearStale() (see refreshAll() in serve.ts) -- rather than racing on
    // the phase text alone: renderNow() paints the phase synchronously off /v1/status BEFORE the
    // later Promise.all(...)-gated clearStale() runs (progressive load, W1-T154), so polling for
    // "implement" in the NOW row could observe a window where fresh data has painted but the stale
    // stamp has not yet been dropped -- a flake this fix removes by waiting on the later, ordered
    // signal instead.
    await page.waitForFunction(() => document.getElementById("top-status")?.textContent?.includes("updated"), null, { timeout: 5000 });
    const freshState = await page.evaluate(() => ({
      phase: document.querySelector("#now-list .detail")?.textContent ?? "",
      stale: document.getElementById("top-status")?.getAttribute("data-stale"),
      badgeHidden: (document.getElementById("stale-badge") as HTMLElement)?.hidden,
    }));
    assert.match(freshState.phase, /phase: implement/, "the NOW row must reflect the fresh (implement) phase by the time the refresh is done");
    assert.equal(freshState.stale, null, "the stale stamp must be DROPPED once fresh data lands");
    assert.equal(freshState.badgeHidden, true, "the STALE badge must hide again once fresh data lands");

    await context.close();
  });
});

// ── (c) progressive load: first-screen content paints off /v1/status ALONE, never gated on the
// other (slower) endpoints — the falsifier is a single blocking fetch-everything-then-render ──

test("progressive load: the summary/NOW section paints from /v1/status BEFORE a slow secondary endpoint (/v1/recent) resolves", async () => {
  const root = tmpRoot();
  const tasks = Array.from({ length: 5 }, (_, i) => task({ id: `W1-T${i}` }));
  await withShell(fixtureDeps(root, tasks), async (base) => {
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    let recentResolved = false;
    await page.route("**/v1/recent", async (route) => {
      await sleep(1200);
      recentResolved = true;
      await route.continue();
    });
    await page.goto(`${base}/?token=${READ_TOKEN}`);
    // The summary line is derived from /v1/status ALONE (never awaits /v1/recent) -- it must be
    // populated well within /v1/recent's 1200ms artificial delay.
    await page.waitForFunction(() => (document.getElementById("summary")?.textContent ?? "").includes("tasks"), null, { timeout: 800 });
    const summary = await page.evaluate(() => document.getElementById("summary")?.textContent ?? "");
    assert.match(summary, /5 tasks/);
    assert.equal(recentResolved, false, "the summary/first-screen paint must land BEFORE the slow secondary endpoint resolves — never gated behind it");
    await context.close();
  });
});

// ── (d) BUDGET: <2s first-paint-to-data at 183-task scale, from the REAL browser client ────────
// Extends the existing raw-fetch board-hang regression (test/serve.test.ts) with the ACTUAL
// consuming client this task's acceptance text names explicitly: "the shell's real fetch client"
// driven by a real navigated page, not a bare header-carried `fetch()` from test code.

test("183-task plan, REAL browser client: first-paint-to-data (navigation -> the shell shows live data) is under the 2000ms budget", async () => {
  const root = tmpRoot();
  const N = 183;
  const tasks = Array.from({ length: N }, (_, i) => task({ id: `W9-T${i}` }));
  await withShell(fixtureDeps(root, tasks), async (base) => {
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    const t0 = performance.now();
    await page.goto(`${base}/?token=${READ_TOKEN}`);
    await page.waitForFunction(() => document.getElementById("top-status")?.textContent?.includes("updated"));
    const ms = performance.now() - t0;
    const summary = await page.evaluate(() => document.getElementById("summary")?.textContent ?? "");
    assert.match(summary, new RegExp(`${N} tasks`));
    assert.ok(ms < 2000, `first-paint-to-data ${ms.toFixed(0)}ms exceeded the 2000ms budget (real browser client, ${N}-task plan)`);
    await context.close();
  });
});

// ── (e, W1-T222) the inline card's OWN skeleton: pre-data only, cleared on render, never left
// standing -- W1-T200's own bar, extended to the row-expansion layer. ──────────────────────────

test("W1-T222: expanding a row shows a skeleton ONLY before its card's data arrives, cleared the instant it renders", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1", title: "skeleton target" })]);
  // an in-flight run puts W1-T1 in #now-list deterministically (never dependent on drain-preview
  // curation or RECENT/rest placement, which this fixture doesn't otherwise control).
  appendFileSync(deps.board.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "run.start" }) + "\n");
  await withShell(deps, async (base) => {
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    await page.route("**/v1/task*", async (route) => {
      await sleep(800);
      await route.continue();
    });
    await page.goto(`${base}/?token=${READ_TOKEN}`);
    await page.waitForFunction(() => (document.querySelector("#now-list .detail")?.textContent ?? "").includes("phase:"));
    await page.click('#now-list li[data-task-id="W1-T1"] .task-id');

    // Well within the 800ms delay: the card must show a skeleton, never blank, never real content yet.
    await sleep(200);
    const during = await page.evaluate(() => ({
      skeletonCount: document.querySelectorAll(".row-detail .skeleton-bar").length,
      hasTitle: document.querySelector(".row-detail-title") !== null,
      detailEmpty: (document.querySelector(".row-detail") as HTMLElement)?.innerHTML.trim() === "",
    }));
    assert.ok(during.skeletonCount > 0, "the open card must show a skeleton before its data arrives, not a blank block");
    assert.equal(during.hasTitle, false, "real content must not render before the fetch resolves");
    assert.equal(during.detailEmpty, false);

    // Once the delayed fetch resolves, the skeleton must be GONE -- never left standing beside data.
    await page.waitForFunction(() => document.querySelector(".row-detail-title") !== null, null, { timeout: 5000 });
    const after = await page.evaluate(() => ({
      skeletonCount: document.querySelectorAll(".row-detail .skeleton-bar").length,
      title: document.querySelector(".row-detail-title")?.textContent ?? "",
    }));
    assert.equal(after.skeletonCount, 0, "the skeleton must be cleared the instant real content renders");
    assert.match(after.title, /skeleton target/);
    await context.close();
  });
});
