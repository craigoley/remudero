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
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { isStopped } from "../src/lib/fleet-control.js";
import { reachSection, shellBootReady } from "./setup/open-shell.js";
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
    // W1-T500: enforcement is ON in buildServeServer and the bearer token is pinned
    // `writeTier: "low"`, so MIDDLE/HIGH controls need the tailnet grant the operator
    // actually arrives with (Serve injects the capability header; grantor tier "high").
    identity: { trustedLocalAddress: "127.0.0.1", capability: "remudero:console" },
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
// Teardown closes the launch PROMISE, never the resolved handle. When `--test-name-pattern`
// matches ZERO tests in this file the runner still runs both hooks, but fires `after` ~0.2ms
// in -- while `chromium.launch()` is still in flight and `browser` is therefore still
// undefined. Closing `browser` there throws (or, if guarded, does nothing), and the browser
// that finishes launching a moment later is left with no reference to close it: its
// `--remote-debugging-pipe` holds the worker's event loop open, so the run HANGS until the
// harness kills it, leaking a chrome-headless-shell process and a
// playwright_chromiumdev_profile-* directory every single time. Awaiting the promise closes
// the browser that actually launched. `browserPromise` is assigned synchronously, before
// `before`'s first await, so `after` can always see it.
let browserPromise: Promise<Browser> | undefined;
before(async () => {
  browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  browser = await browserPromise;
});
after(async () => {
  const launched = await browserPromise;
  await launched?.close();
});

// W1-T202: the write token NEVER rides the URL bootstrap anymore — the bookmark carries only the
// read token (see serve.ts's shell bootstrap). Passing WRITE_TOKEN here simulates an operator who
// already pasted it into THIS tab earlier in the session: it is seeded into sessionStorage BEFORE
// the page's own script runs (page.addInitScript), never appended to the navigated URL.
async function openShell(base: string, token: string = READ_TOKEN): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { "tailscale-app-capabilities": JSON.stringify({ "remudero:console": {} }) } });
  const page = await context.newPage();
  if (token !== READ_TOKEN) {
    await page.addInitScript((writeToken) => {
      window.sessionStorage.setItem("rmd-console-write-token", writeToken);
    }, token);
  }
  await page.goto(`${base}/?token=${READ_TOKEN}`);
  // wait for the first poll's real data to land (not the static "loading…" placeholder) —
  // the same "exercise the real consuming client" discipline as the fetch, not a fixed sleep.
  await page.waitForFunction(shellBootReady);
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
      // W1-T202: this test proves MODE read-back (running/paused/stopped), not write-scope
      // gating — it needs a write-capable session so pause/resume/stop are ever enableable at
      // all, exactly as the pre-W1-T202 URL-bootstrap model always granted them here.
      const page = await openShell(base, WRITE_TOKEN);
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
      await reachSection(page, "controls"); // #stop-btn lives in the "controls" section
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
      await reachSection(page, "now"); // the row this test focuses/toggles lives in "now"
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
    // W1-T500: enforcement is ON in buildServeServer and the bearer token is pinned
    // `writeTier: "low"`, so MIDDLE/HIGH controls need the tailnet grant the operator
    // actually arrives with (Serve injects the capability header; grantor tier "high").
    identity: { trustedLocalAddress: "127.0.0.1", capability: "remudero:console" },
    pollMs: 50,
  };
  await withShell(deps, async (base) => {
    async function markHandledPresence(token: string): Promise<boolean> {
      const page = await openShell(base, token);
      try {
        await page.waitForFunction(() => (document.getElementById("needs-me-list")?.textContent ?? "").includes("needs a decision"));
        // W1-T222 flake fix: the write-affordance is gated on the boot `/v1/auth/scope` probe,
        // which resolves asynchronously. A card expanded BEFORE it resolves renders against
        // hasWriteScope=false, so the write token's button was intermittently missing -- flaking
        // this test (worse under --experimental-test-coverage's slower render) and blocking
        // unrelated PRs. Wait for the probe-resolved marker so the expand always renders against
        // the settled scope; the button state is then deterministic, no fixed timeout needed.
        await page.waitForFunction(() => document.body.dataset.writeScopeResolved === "1");
        await reachSection(page, "needs-me"); // the row about to be clicked lives in "needs-me"
        await page.click('#needs-me-list li[data-task-id="W1-T9"] .task-id');
        await page.waitForFunction(
          () => document.querySelector('#needs-me-list li[data-task-id="W1-T9"]')?.getAttribute("aria-expanded") === "true",
        );
        await page.waitForFunction(() => (document.querySelector(".row-detail")?.textContent ?? "").length > 0);
        // TEARDOWN RACE FIX: `return await`, not a bare `return page.evaluate(...)`. Without the
        // await, this try block returns the pending evaluate PROMISE, so the `finally` closes the
        // context BEFORE the evaluate settles -> "Target page ... has been closed", intermittently
        // (worse under CI/coverage load) failing this test and false-reddening unrelated PRs (#632,
        // #645). The await makes the finally wait for the evaluate to resolve first.
        return await page.evaluate(
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

// ── W1-T223: a collapsed console section must still inform -- every section collapses, and its
// header carries an always-visible one-line summary from the SAME projection as its rows ────────

test("W1-T223: an empty section defaults collapsed with an honest summary; a collapsed section's header still shows it, never a bare zero", async () => {
  const root = tmpRoot();
  // W1-T1 merged, W1-T2 blocked (no escalation -- NOW/NEEDS ME are genuinely empty), W1-T3 queued.
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);
    try {
      await page.waitForFunction(() => (document.getElementById("now-summary")?.textContent ?? "") !== "…");
      const state = await page.evaluate(() => ({
        nowExpanded: document.getElementById("now-toggle")?.getAttribute("aria-expanded"),
        nowBodyHidden: (document.getElementById("now-body") as HTMLElement)?.hidden,
        nowSummary: document.getElementById("now-summary")?.textContent,
        needsMeExpanded: document.getElementById("needs-me-toggle")?.getAttribute("aria-expanded"),
        needsMeSummary: document.getElementById("needs-me-summary")?.textContent,
      }));
      assert.equal(state.nowExpanded, "false", "an empty section defaults COLLAPSED");
      assert.equal(state.nowBodyHidden, true, "collapsed means its rows are actually hidden");
      assert.match(state.nowSummary ?? "", /nothing in flight/, "the collapsed header still carries an honest summary, never a blank or a bare 0");
      assert.equal(state.needsMeExpanded, "false");
      assert.match(state.needsMeSummary ?? "", /nothing needs you/, "the SAME honest empty vocabulary already used for the row list's own empty state");
    } finally {
      await page.context().close();
    }
  });
});

test("W1-T223: NEEDS ME auto-expands by default when non-empty (the same collapsed-iff-empty rule, not a special case)", async () => {
  const root = tmpRoot();
  const issueUrl = "https://github.com/o/r/issues/771";
  const github = stubEscalationGithubForCard(issueUrl, "needs a decision on W1-T9");
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
    // W1-T500: enforcement is ON in buildServeServer and the bearer token is pinned
    // `writeTier: "low"`, so MIDDLE/HIGH controls need the tailnet grant the operator
    // actually arrives with (Serve injects the capability header; grantor tier "high").
    identity: { trustedLocalAddress: "127.0.0.1", capability: "remudero:console" },
    pollMs: 50,
  };
  await withShell(deps, async (base) => {
    const page = await openShell(base);
    try {
      await page.waitForFunction(() => (document.getElementById("needs-me-summary")?.textContent ?? "") !== "…");
      const state = await page.evaluate(() => ({
        expanded: document.getElementById("needs-me-toggle")?.getAttribute("aria-expanded"),
        bodyHidden: (document.getElementById("needs-me-body") as HTMLElement)?.hidden,
        summary: document.getElementById("needs-me-summary")?.textContent,
      }));
      assert.equal(state.expanded, "true", "NEEDS ME auto-expands when non-empty");
      assert.equal(state.bodyHidden, false);
      assert.match(state.summary ?? "", /1 open/);
    } finally {
      await page.context().close();
    }
  });
});

test("W1-T223: collapse state persists across a reload, and the persisted state carries no credential", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);
  // a real "merged" verdict line -- makes RECENT genuinely non-empty, so it defaults EXPANDED
  // (the same collapsed-iff-empty rule NOW/NEEDS ME defaulted collapsed under, above).
  appendFileSync(deps.board.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r9", task_id: "W1-T1", step: "verdict", verdict: "merged" }) + "\n");
  await withShell(deps, async (base) => {
    const page = await openShell(base);
    try {
      await reachSection(page, "recent"); // #recent-toggle lives in the "recent" section
      await page.waitForFunction(() => document.getElementById("recent-toggle")?.getAttribute("aria-expanded") === "true");
      await page.click("#recent-toggle");
      await page.waitForFunction(() => document.getElementById("recent-toggle")?.getAttribute("aria-expanded") === "false");

      const stored = await page.evaluate(() => localStorage.getItem("rmd-console-sections-v1"));
      assert.ok(stored, "collapse state must be persisted client-side");
      assert.doesNotMatch(stored ?? "", new RegExp(READ_TOKEN), "persisted UI state must carry no credential (standing rule 24)");
      assert.doesNotMatch(stored ?? "", /token/i);

      await page.reload();
      await page.waitForFunction(shellBootReady);
      await page.waitForFunction(() => document.getElementById("recent-toggle")?.getAttribute("aria-expanded") !== null);
      assert.equal(await page.getAttribute("#recent-toggle", "aria-expanded"), "false", "the explicit collapse must survive a reload");
    } finally {
      await page.context().close();
    }
  });
});

test("W1-T223: the section header is the whole click/keyboard toggle target -- the SAME gesture as a row's own expand (click, Enter, Space; chevron flips with aria-expanded)", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);
  // a real "merged" verdict line -- makes RECENT genuinely non-empty, so it defaults EXPANDED.
  appendFileSync(deps.board.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r9", task_id: "W1-T1", step: "verdict", verdict: "merged" }) + "\n");
  await withShell(deps, async (base) => {
    const page = await openShell(base);
    try {
      await reachSection(page, "recent"); // #recent-toggle lives in the "recent" section
      await page.waitForFunction(() => document.getElementById("recent-toggle")?.getAttribute("aria-expanded") === "true");

      await page.click("#recent-toggle");
      await page.waitForFunction(() => document.getElementById("recent-toggle")?.getAttribute("aria-expanded") === "false");
      assert.equal(await page.evaluate(() => (document.getElementById("recent-body") as HTMLElement)?.hidden), true);

      await page.locator("#recent-toggle").focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.getElementById("recent-toggle")?.getAttribute("aria-expanded") === "true");
      assert.equal(await page.evaluate(() => (document.getElementById("recent-body") as HTMLElement)?.hidden), false);

      await page.keyboard.press(" ");
      await page.waitForFunction(() => document.getElementById("recent-toggle")?.getAttribute("aria-expanded") === "false");
    } finally {
      await page.context().close();
    }
  });
});

// ── W1-T202: the console bookmark is READ-ONLY after the token-hygiene fix -- the shell must
// accept the write token once and hold it client-side, or every NEEDS-ME write action 401s ──────

test("a console loaded with the READ token alone renders the board fully and shows every write affordance as explicitly unavailable with a stated reason, rather than rendering it armed", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base); // READ_TOKEN only -- no write token seeded anywhere
    try {
      // the board itself still renders FULLY off the read token alone (this is a view, not a
      // failure) -- the summary line is real data, never the "…"/skeleton placeholder.
      await page.waitForFunction(() => (document.getElementById("summary")?.textContent ?? "") !== "" && !(document.getElementById("summary")?.textContent ?? "").includes("…"));

      const state = await page.evaluate(() => ({
        pauseDisabled: (document.getElementById("pause-btn") as HTMLButtonElement)?.disabled,
        pauseTitle: (document.getElementById("pause-btn") as HTMLButtonElement)?.title ?? "",
        resumeDisabled: (document.getElementById("resume-btn") as HTMLButtonElement)?.disabled,
        stopDisabled: (document.getElementById("stop-btn") as HTMLButtonElement)?.disabled,
        stopTitle: (document.getElementById("stop-btn") as HTMLButtonElement)?.title ?? "",
        quietHoursDisabled: (document.getElementById("quiet-hours") as HTMLInputElement)?.disabled,
        drainDisabled: (document.getElementById("drain-now-btn") as HTMLButtonElement)?.disabled,
        writeTokenStatus: document.getElementById("write-token-status")?.textContent ?? "",
        writeTokenFormHidden: (document.getElementById("write-token-form") as HTMLElement)?.hidden,
        clearBtnHidden: (document.getElementById("write-token-clear-btn") as HTMLElement)?.hidden,
      }));
      assert.equal(state.pauseDisabled, true, "Pause must render disabled, never armed, with only a read token");
      assert.match(state.pauseTitle, /read-only/i, "the disabled control must state WHY, not just that it is disabled");
      assert.equal(state.resumeDisabled, true);
      assert.equal(state.stopDisabled, true);
      assert.match(state.stopTitle, /read-only/i);
      assert.equal(state.quietHoursDisabled, true);
      assert.equal(state.drainDisabled, true);
      assert.match(state.writeTokenStatus, /read-only/i);
      assert.equal(state.writeTokenFormHidden, false, "the read-only state offers the write-token entry form");
      assert.equal(state.clearBtnHidden, true, "there is nothing to clear -- no write token is held");
    } finally {
      await page.context().close();
    }
  });
});

test("the write token is never written into the URL, a ledger line, or a log line at any point in the flow — asserted against the rendered shell and the emitted ledger steps", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);
  await withShell(deps, async (base) => {
    const page = await openShell(base); // boots on the READ token alone, exactly like a real bookmark
    try {
      assert.doesNotMatch(page.url(), new RegExp(WRITE_TOKEN), "the write token must never appear in the navigated URL");

      await reachSection(page, "controls"); // the write-token form and #pause-btn both live in "controls"
      // paste the write token into the shell's own entry form -- the ONLY sanctioned channel.
      await page.fill("#write-token-input", WRITE_TOKEN);
      await page.click("#write-token-form button[type=submit]");
      await page.waitForFunction(() => (document.getElementById("write-token-clear-btn") as HTMLElement)?.hidden === false);

      // the URL must STILL carry only the read token -- entering a write token never round-trips
      // it back into history/location (the bookmark never gains write power).
      assert.doesNotMatch(page.url(), new RegExp(WRITE_TOKEN));
      assert.match(page.url(), new RegExp(`token=${READ_TOKEN}`));

      // fire a real write action so a ledger line actually gets emitted, then inspect it.
      await page.click("#pause-btn");
      await page.waitForFunction(() => document.getElementById("pause-btn")?.getAttribute("aria-pressed") === "true");

      const ledgerContents = readFileSync(deps.ledgerPath, "utf8");
      assert.doesNotMatch(ledgerContents, new RegExp(WRITE_TOKEN), "the write token must never reach a ledger line");

      // the console's own localStorage snapshot cache is the other persisted-client-state surface
      // this shell writes (W1-T154) -- it must not carry the credential either.
      const cachedSnapshot = await page.evaluate(() => window.localStorage.getItem("rmd-console-snapshot-v1"));
      if (cachedSnapshot) assert.doesNotMatch(cachedSnapshot, new RegExp(WRITE_TOKEN));
    } finally {
      await page.context().close();
    }
  });
});

test("clearing the stored write token returns the console to the read-only rendering without a reload", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base, WRITE_TOKEN); // simulates a tab that already holds it
    try {
      await page.waitForFunction(() => (document.getElementById("pause-btn") as HTMLButtonElement)?.disabled === false);

      // a marker that ONLY survives in-page -- a real reload/navigation would wipe it, proving
      // the revert below happens live, client-side, with no round trip to GET /.
      await page.evaluate(() => { (window as unknown as { __t202Marker: string }).__t202Marker = "still-here"; });

      await reachSection(page, "controls"); // #write-token-clear-btn lives in "controls"
      await page.click("#write-token-clear-btn");
      await page.waitForFunction(() => (document.getElementById("pause-btn") as HTMLButtonElement)?.disabled === true);

      const state = await page.evaluate(() => ({
        marker: (window as unknown as { __t202Marker?: string }).__t202Marker,
        stopDisabled: (document.getElementById("stop-btn") as HTMLButtonElement).disabled,
        quietHoursDisabled: (document.getElementById("quiet-hours") as HTMLButtonElement).disabled,
        storedToken: window.sessionStorage.getItem("rmd-console-write-token"),
        clearBtnHidden: (document.getElementById("write-token-clear-btn") as HTMLElement).hidden,
        formHidden: (document.getElementById("write-token-form") as HTMLElement).hidden,
      }));
      assert.equal(state.marker, "still-here", "clearing the token must never reload/navigate the page");
      assert.equal(state.stopDisabled, true);
      assert.equal(state.quietHoursDisabled, true);
      assert.equal(state.storedToken, null, "the token must actually be removed from sessionStorage, not just hidden");
      assert.equal(state.clearBtnHidden, true);
      assert.equal(state.formHidden, false);
    } finally {
      await page.context().close();
    }
  });
});

// ── W1-T334/T336/T2718: the console tab bar -- scaffolded flat, now AUTHORITATIVE ────────────

test("console tab bar: exactly five tabs (Decisions, Queue, Now, Plan, Feed), pinned under the glance strip, and every section renders under exactly one tab, visible only while that tab is active", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);
    try {
      const tabLabels = await page.$$eval("#console-tabs .tab-btn", (els) => els.map((el) => el.textContent?.trim()));
      assert.deepEqual(tabLabels, ["Decisions", "Queue", "Now", "Plan", "Feed"]);

      // the glance strip (#glance) sits OUTSIDE the tab bar and BEFORE it in document order --
      // "pinned above," never a descendant of one and never reparented into one -- UNCHANGED by
      // W1-T336 (design note "what does not move").
      const order = await page.evaluate(() => {
        const glance = document.getElementById("glance")!;
        const tabs = document.getElementById("console-tabs")!;
        return {
          eitherContainsTheOther: glance.contains(tabs) || tabs.contains(glance),
          glancePrecedesTabs: !!(glance.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING),
        };
      });
      assert.equal(order.eitherContainsTheOther, false);
      assert.equal(order.glancePrecedesTabs, true);

      // Plan: W1-T315 fills the W1-T336 placeholder with the real progress + frontier view --
      // present in the DOM but hidden until selected, same as before.
      assert.equal(await page.$eval("#tab-plan-panel", (el) => (el as HTMLElement).hidden), true);
      await page.click("#tab-plan");
      const plan = await page.$eval("#tab-plan-panel", (el) => ({ hidden: (el as HTMLElement).hidden, text: el.textContent ?? "" }));
      assert.equal(plan.hidden, false);
      assert.doesNotMatch(plan.text, /not built yet/i);
      assert.match(plan.text, /Frontier/i);

      // ADD, REMOVE NOTHING, BUT NOW GATED: every operational section is still in the
      // document (never deleted -- W1-T314's "a missing tab reads as a missing capability," and
      // this task's own "the falsifier is any firehose row reachable today that cannot be
      // reached after the change"), but each is visible on EXACTLY the one tab that owns it.
      const isVisible = (id: string) => page.$eval(id, (el) => (el as HTMLElement).offsetParent !== null);
      const inDocument = (id: string) => page.$eval(id, (el) => document.body.contains(el));
      const ALL_SECTIONS = ["#needs-me", "#pr-queue", "#now", "#up-next", "#controls", "#accepted", "#recent", "#rest", "#more"];
      for (const sel of ALL_SECTIONS) assert.equal(await inDocument(sel), true, `${sel} missing from the document`);

      // Decisions is the default active tab -- only its own section (needs-me) is visible.
      await page.click("#tab-decisions");
      assert.equal(await isVisible("#needs-me"), true);
      for (const sel of ["#pr-queue", "#now", "#up-next", "#controls", "#accepted", "#recent", "#rest", "#more"]) {
        assert.equal(await isVisible(sel), false, `${sel} must be hidden while Decisions is active`);
      }

      // Queue owns the whole live open-PR cockpit and no task/firehose section.
      await page.click("#tab-queue");
      assert.equal(await isVisible("#pr-queue"), true);
      for (const sel of ["#needs-me", "#now", "#up-next", "#controls", "#accepted", "#recent", "#rest", "#more"]) {
        assert.equal(await isVisible(sel), false, `${sel} must be hidden while Queue is active`);
      }

      // Now owns now/up-next/controls.
      await page.click("#tab-now");
      for (const sel of ["#now", "#up-next", "#controls"]) assert.equal(await isVisible(sel), true, `${sel} must be visible on the Now tab`);
      for (const sel of ["#needs-me", "#pr-queue", "#accepted", "#recent", "#rest", "#more"]) {
        assert.equal(await isVisible(sel), false, `${sel} must be hidden while Now is active`);
      }

      // Feed owns accepted/recent/rest/more (recap is content-gated separately, not asserted here).
      await page.click("#tab-feed");
      for (const sel of ["#accepted", "#recent", "#rest", "#more"]) assert.equal(await isVisible(sel), true, `${sel} must be visible on the Feed tab`);
      for (const sel of ["#needs-me", "#pr-queue", "#now", "#up-next", "#controls"]) {
        assert.equal(await isVisible(sel), false, `${sel} must be hidden while Feed is active`);
      }
    } finally {
      await page.context().close();
    }
  });
});

// ── W1-T336: the needs-me browser-tab badge fires regardless of which tab is active ─────────
// The alert this badge exists for must not depend on already looking at Decisions -- an escalation
// landing while the operator sits on Now (or any other tab) must still flip the badge.

test("the needs-me browser-tab badge still fires while Decisions is NOT the active tab", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);
  await withShell(deps, async (base) => {
    const page = await openShell(base);
    try {
      const baseTitle = await page.title();
      assert.equal(baseTitle.startsWith("("), false, "no needs-me items yet -- no badge prefix");

      await page.click("#tab-now");
      assert.equal(await page.$eval("#tab-now", (el) => el.getAttribute("aria-selected")), "true");
      assert.equal(await page.$eval("#tab-decisions", (el) => el.getAttribute("aria-selected")), "false");

      // A real ledger append -- the daemon-side SSE stream (buildStatusStream, board.ts) picks
      // this up within one poll tick and pushes a "status" event carrying needsHuman: true,
      // exactly the mechanism test/serve.glance.test.ts's own badge criterion already proves.
      appendFileSync(
        deps.board.ledgerPath,
        JSON.stringify({
          ts: new Date().toISOString(),
          run_id: "r3",
          task_id: "W1-T3",
          step: "escalation.issue_opened",
          issue_url: "https://github.com/o/r/issues/3",
          class: "BLOCKED",
        }) + "\n",
      );

      await page.waitForFunction(() => document.title.startsWith("(1)"), null, { timeout: 5000 });
      // still on Now -- the badge must not require Decisions to be active, and switching tabs
      // must never have been required to make it fire.
      assert.equal(await page.$eval("#tab-now", (el) => el.getAttribute("aria-selected")), "true");
    } finally {
      await page.context().close();
    }
  });
});

test("console tab bar: the active tab is URL-persisted, deep-linkable, and survives a reload, on the SAME URLSearchParams+history.replaceState round-trip FIND already uses", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);
    try {
      // selecting a tab updates the URL in place -- no navigation, and the read token round-trips
      // through the exact same URLSearchParams mechanism serve.ts's FIND layer already uses.
      await page.click("#tab-plan");
      await page.waitForFunction(() => new URLSearchParams(window.location.search).get("tab") === "plan");
      const afterClick = new URL(page.url());
      assert.equal(afterClick.searchParams.get("tab"), "plan");
      assert.equal(afterClick.searchParams.get("token"), READ_TOKEN, "the existing round-trip preserves token — this must too");

      // deep link: navigating straight to ?tab=plan renders Plan active/visible with no interaction.
      await page.goto(`${base}/?token=${READ_TOKEN}&tab=plan`);
      await page.waitForFunction(shellBootReady);
      assert.equal(await page.$eval("#tab-plan", (el) => el.getAttribute("aria-selected")), "true");
      assert.equal(await page.$eval("#tab-plan-panel", (el) => !(el as HTMLElement).hidden), true);

      // reload: the SAME deep-linked tab survives a reload, not just an in-memory click.
      await page.reload();
      await page.waitForFunction(shellBootReady);
      assert.equal(await page.$eval("#tab-plan", (el) => el.getAttribute("aria-selected")), "true");
    } finally {
      await page.context().close();
    }
  });
});

// ── W1-T335/T336: the shared "reach a section" helper now drives the REAL tabbed shell ─────

test("W1-T336: reachSection activates the real owning tab for a real section, and is a true no-op when the section is already on the active tab", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);
    try {
      // "needs-me" lives under Decisions, the default active tab -- a genuine no-op, no click.
      await reachSection(page, "needs-me");
      assert.equal(await page.$eval("#tab-decisions", (el) => el.getAttribute("aria-selected")), "true");
      for (const tab of ["tab-queue", "tab-now", "tab-plan", "tab-feed"]) {
        assert.equal(await page.$eval(`#${tab}`, (el) => el.getAttribute("aria-selected")), "false");
      }

      // "now" lives under Now -- reachSection must actually click that tab to reveal it.
      await reachSection(page, "now");
      assert.equal(await page.$eval("#tab-now", (el) => el.getAttribute("aria-selected")), "true");
      assert.equal(await page.$eval("#now", (el) => (el as HTMLElement).offsetParent !== null), true);

      // "rest" lives under Feed -- a further switch, proving this is a real per-call activation
      // across every tab the real shell now has, not a one-shot fluke.
      await reachSection(page, "rest");
      assert.equal(await page.$eval("#tab-feed", (el) => el.getAttribute("aria-selected")), "true");
      assert.equal(await page.$eval("#rest", (el) => (el as HTMLElement).offsetParent !== null), true);
      assert.equal(await page.$eval("#now", (el) => (el as HTMLElement).offsetParent !== null), false, "switching to Feed must hide Now's own sections");
    } finally {
      await page.context().close();
    }
  });
});

test("W1-T335 reachSection: activates the owning tab when a section genuinely IS tab-owned, proven independently against a fixture that presents the tabbed shape", async () => {
  const context = await browser.newContext({ extraHTTPHeaders: { "tailscale-app-capabilities": JSON.stringify({ "remudero:console": {} }) } });
  const page = await context.newPage();
  try {
    // A minimal, independent stand-in for a tabbed shape: a tablist plus two panels, each hidden
    // unless its own tab is selected. Proving reachSection against a synthetic fixture too --
    // never only against the real shell above -- is what makes this helper's own criterion
    // falsifiable: a helper that silently no-ops under ANY tabbed shape would still pass by
    // accident if the only fixture it were ever run against were today's real, known-good shell.
    await page.setContent(`
      <div id="console-tabs" role="tablist" aria-label="Console view">
        <button type="button" class="tab-btn" id="tab-a" role="tab" data-tab="a" aria-selected="true">A</button>
        <button type="button" class="tab-btn" id="tab-b" role="tab" data-tab="b" aria-selected="false">B</button>
      </div>
      <section id="panel-a"><ul id="owned-by-a"><li>a-row</li></ul></section>
      <section id="panel-b" hidden><ul id="owned-by-b"><li>b-row</li></ul></section>
      <script>
        document.getElementById("console-tabs").addEventListener("click", (e) => {
          const btn = e.target.closest(".tab-btn");
          if (!btn) return;
          for (const b of document.querySelectorAll(".tab-btn")) b.setAttribute("aria-selected", b === btn ? "true" : "false");
          document.getElementById("panel-a").hidden = btn.dataset.tab !== "a";
          document.getElementById("panel-b").hidden = btn.dataset.tab !== "b";
        });
      </script>
    `);
    assert.equal(await page.$eval("#owned-by-b", (el) => (el as HTMLElement).offsetParent !== null), false, "fixture precondition: panel B starts hidden");

    await reachSection(page, "owned-by-b");

    assert.equal(await page.$eval("#owned-by-b", (el) => (el as HTMLElement).offsetParent !== null), true, "reachSection must activate tab B to reveal the section it owns");
    assert.equal(await page.$eval("#tab-b", (el) => el.getAttribute("aria-selected")), "true");
    assert.equal(await page.$eval("#tab-a", (el) => el.getAttribute("aria-selected")), "false");

    // and calling it again for the OTHER panel's section switches back -- proving this is a real
    // per-call activation, not a one-shot fluke.
    await reachSection(page, "owned-by-a");
    assert.equal(await page.$eval("#owned-by-a", (el) => (el as HTMLElement).offsetParent !== null), true);
    assert.equal(await page.$eval("#tab-a", (el) => el.getAttribute("aria-selected")), "true");
  } finally {
    await context.close();
  }
});
