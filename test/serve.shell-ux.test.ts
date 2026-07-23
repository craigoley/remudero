// test/serve.shell-ux.test.ts — W1-T153 (console shell UX overhaul), the acceptance bars that
// can only be proven against a REAL browser client (learnings#probe-must-exercise-the-real-
// consuming-client: "a proof must exercise the ACTUAL consuming client"). "no horizontal
// scroll," "computed color contrast," and "a click fires no POST until confirmed" are all
// properties of a rendered page + executed JS, not of the HTML string — test/serve.test.ts's
// regex-based structural checks cover everything else (section order, color-token distinctness,
// dark-theme-default markup, route wiring).
//
// Uses Playwright (headless Chromium) + @axe-core/playwright — the task's own acceptance text
// permits "Lighthouse (or equivalent headless a11y)"; axe-core is that equivalent (same engine
// Lighthouse's own accessibility category runs under the hood), and needs no Chrome-DevTools-
// Protocol audit plumbing beyond a Playwright page, which this suite already needs for the
// responsive/interaction bars.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { isStopped } from "../src/lib/fleet-control.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

const READ_TOKEN = "shell-ux-read-token";
const WRITE_TOKEN = "shell-ux-write-token";

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
  return mkdtempSync(join(tmpdir(), "rmd-shell-ux-"));
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

/** A representative mixed-state plan: one merged (RECENT), one blocked (RECENT), one plain
 *  queued (UP NEXT + rest). NOW/NEEDS ME are legitimately empty here — their empty states are
 *  real rendered DOM (`<li class="empty">…</li>`), still exercised by the a11y/responsive scan. */
function fixtureDeps(root: string): ServeDeps {
  const plan = planOf([
    task({ id: "W1-T1", status: "merged" }),
    task({ id: "W1-T2", status: "blocked" }),
    task({ id: "W1-T3", status: "queued" }),
  ]);
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, planYaml(plan));
  writeFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "pr.opened", pr_url: "https://github.com/o/r/pull/1" }) + "\n");
  const github = fakeGitHub({ "https://github.com/o/r/pull/1": { number: 1, url: "https://github.com/o/r/pull/1", state: "MERGED" } });
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
before(async () => {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});
after(async () => {
  await browser.close();
});

async function openShell(base: string, token: string = READ_TOKEN): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/?token=${token}`);
  // wait for the first poll's real data to land (not the static "loading…" placeholder) —
  // the same "exercise the real consuming client" discipline as the fetch, not a fixed sleep.
  await page.waitForFunction(() => !document.getElementById("top-status")?.textContent?.includes("loading"));
  return page;
}

// ── responsive: 390px (iPhone) and 1440px (desktop), no horizontal scroll, dark by default ──

test("shell at 390px and 1440px: no horizontal overflow at either width; dark theme is active", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    for (const width of [390, 1440]) {
      const page = await openShell(base);
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `horizontal overflow of ${overflow}px at ${width}px width`);
      const colorScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
      assert.match(colorScheme, /dark/);
      await page.context().close();
    }
  });
});

// ── a11y: axe-core (the task's own "Lighthouse or equivalent headless a11y") ────────────────

test("shell passes an axe accessibility scan with zero critical/serious violations (Lighthouse-equivalent a11y bar >= 90)", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);
    try {
      const results = await new AxeBuilder({ page }).analyze();
      const bad = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
      if (bad.length > 0) {
        const detail = bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`).join("\n");
        assert.fail(`critical/serious a11y violations:\n${detail}`);
      }
      // an approximate Lighthouse-style score: pass-weighted over every rule axe actually ran.
      const total = results.passes.length + results.violations.length;
      const score = total === 0 ? 100 : Math.round((results.passes.length / total) * 100);
      assert.ok(score >= 90, `approximate a11y score ${score} < 90 (passes=${results.passes.length}, violations=${results.violations.length})`);
    } finally {
      await page.context().close();
    }
  });
});

// ── fleet-control read-back: the panel renders the ACTIVE mode, never identical button states ─

test("fleet-control read-back: RUNNING vs PAUSED vs STOPPED render visibly distinct button states, never identical", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);
  await withShell(deps, async (base) => {
    async function modeState() {
      const page = await openShell(base);
      const state = await page.evaluate(() => ({
        pausePressed: document.getElementById("pause-btn")!.getAttribute("aria-pressed"),
        pauseDisabled: (document.getElementById("pause-btn") as HTMLButtonElement).disabled,
        stopPressed: document.getElementById("stop-btn")!.getAttribute("aria-pressed"),
        resumeDisabled: (document.getElementById("resume-btn") as HTMLButtonElement).disabled,
      }));
      await page.context().close();
      return state;
    }

    const running = await modeState();
    assert.equal(running.pausePressed, "false");
    assert.equal(running.pauseDisabled, false);
    assert.equal(running.resumeDisabled, true); // nothing to resume while running

    const fs = await import("node:fs");
    fs.mkdirSync(join(root, "state"), { recursive: true });
    fs.writeFileSync(join(root, "state", "PAUSE"), JSON.stringify({ requestedAt: new Date().toISOString(), pid: 1, host: "h" }));
    const paused = await modeState();
    assert.equal(paused.pausePressed, "true");
    assert.equal(paused.pauseDisabled, true); // already paused — re-triggering is disabled
    assert.equal(paused.resumeDisabled, false); // now there IS something to resume
    // PAUSED must render VISIBLY DIFFERENT from RUNNING (the falsifier: identical states) —
    fs.unlinkSync(join(root, "state", "PAUSE"));

    fs.writeFileSync(join(root, "state", "STOP"), JSON.stringify({ requestedAt: new Date().toISOString(), pid: 1, host: "h" }));
    const stopped = await modeState();
    assert.equal(stopped.stopPressed, "true");
    assert.equal(stopped.pauseDisabled, true); // pausing an already-stopped fleet is meaningless
    assert.equal(stopped.resumeDisabled, false);
    fs.unlinkSync(join(root, "state", "STOP"));

    assert.notDeepEqual(running, paused);
    assert.notDeepEqual(running, stopped);
    assert.notDeepEqual(paused, stopped);
  });
});

// ── STOP requires an explicit confirm click — a single click must never actually stop the fleet ─

test("STOP: a single click does NOT stop the fleet; a second ('Confirm STOP') click does", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base, WRITE_TOKEN);
    try {
      await page.click("#stop-btn");
      const textAfterFirstClick = await page.textContent("#stop-btn");
      assert.match(textAfterFirstClick ?? "", /Confirm STOP/);
      // give any (wrongly-fired) POST a moment to land, then assert it did NOT.
      await page.waitForTimeout(150);
      assert.equal(isStopped(root), false, "a single click must never actually stop the fleet");

      await page.click("#stop-btn");
      await page.waitForFunction(() => document.getElementById("controls-status")?.textContent?.toLowerCase().includes("stop"), null, { timeout: 5000 });
      assert.equal(isStopped(root), true, "the confirmed second click must stop the fleet");
    } finally {
      await page.context().close();
    }
  });
});

// ── W1-T222: keyboard + focus parity for the inline row expansion ───────────────────────────

test("W1-T222: Enter and Space toggle a row's inline card, aria-expanded reflects state, and focus is retained across the toggle", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);
  // an in-flight run puts W1-T3 in #now-list deterministically (never dependent on RECENT's own
  // merge/verdict derivation, which this shared fixture's ledger doesn't otherwise produce).
  appendFileSync(deps.board.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r9", task_id: "W1-T3", step: "run.start" }) + "\n");
  await withShell(deps, async (base) => {
    const page = await openShell(base);
    try {
      await page.waitForFunction(() => (document.querySelector("#now-list .detail")?.textContent ?? "").includes("phase:"));
      const rowSel = '#now-list li[data-task-id="W1-T3"]';
      await page.locator(rowSel).focus();
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-task-id")), "W1-T3");

      // Enter opens it.
      await page.keyboard.press("Enter");
      await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-expanded") === "true", rowSel);
      assert.equal(
        await page.evaluate((sel) => document.querySelector(sel)!.nextElementSibling?.classList.contains("row-detail"), rowSel),
        true,
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-task-id")),
        "W1-T3",
        "focus must stay on the row, not drop into the freshly-inserted card or the document",
      );

      // Space collapses it back.
      await page.keyboard.press(" ");
      await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-expanded") === "false", rowSel);
      assert.equal(await page.evaluate(() => document.querySelectorAll(".row-detail").length), 0);
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-task-id")),
        "W1-T3",
        "focus must still be on the row after collapsing via the keyboard",
      );
    } finally {
      await page.context().close();
    }
  });
});

// ── W1-T222: "actions RENDER PER AUTH SCOPE" — a read-only bookmark renders NO write affordance
// inside the inline card at all, rather than rendering one and failing on click (standing rule 22) ─

function stubEscalationGithubForCard(issueUrl: string, title: string): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    issueByUrl: (url) => (url === issueUrl ? { state: "OPEN", title } : null),
  };
}

test("W1-T222: a read-only bookmark's inline card renders NO write affordance (Mark handled); the write token's own card renders it", async () => {
  const root = tmpRoot();
  const issueUrl = "https://github.com/o/r/issues/501";
  const github = stubEscalationGithubForCard(issueUrl, "[BLOCKED] W1-T9: needs a decision");
  const plan = planOf([task({ id: "W1-T9", status: "blocked" })]);
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, planYaml(plan));
  appendFileSync(
    ledgerPath,
    JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T9", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" }) + "\n",
  );
  const deps: ServeDeps = {
    board: { plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
  };
  await withShell(deps, async (base) => {
    async function markHandledPresence(token: string): Promise<boolean> {
      const page = await openShell(base, token);
      try {
        await page.waitForFunction(() => (document.getElementById("needs-me-list")?.textContent ?? "").includes("needs a decision"));
        await page.click('#needs-me-list li[data-task-id="W1-T9"] .task-id');
        await page.waitForFunction(
          () => document.querySelector('#needs-me-list li[data-task-id="W1-T9"]')?.getAttribute("aria-expanded") === "true",
        );
        await page.waitForFunction(() => (document.querySelector(".row-detail")?.textContent ?? "").length > 0);
        // let any (wrongly-rendered) action button settle before checking for it.
        await page.waitForTimeout(100);
        return page.evaluate(
          () => Array.from(document.querySelectorAll(".row-detail button")).some((b) => b.textContent?.trim() === "Mark handled"),
        );
      } finally {
        await page.context().close();
      }
    }

    assert.equal(await markHandledPresence(READ_TOKEN), false, "a read-only token's card must render NO write affordance at all");
    assert.equal(await markHandledPresence(WRITE_TOKEN), true, "a write-scoped token's card DOES render the write affordance");
  });
});
