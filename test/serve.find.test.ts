// test/serve.find.test.ts — W1-T157 (the FIND layer), the acceptance bars that can ONLY be proven
// against a REAL browser client (learnings#probe-must-exercise-the-real-consuming-client): the DOM
// state after a facet click, the URL after a page.reload(), a real keyboard cmd/ctrl+K event, and
// the LIVE facet counts as executed JS produces them are all real-browser-only facts a regex over
// the HTML string cannot prove. Structural markup checks live in test/serve.test.ts; behavior lives
// here. Scaffolding is copied from test/serve.shell-ux.test.ts (its established Playwright pattern).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { isPaused } from "../src/lib/fleet-control.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

const READ_TOKEN = "find-read-token";
const WRITE_TOKEN = "find-write-token";

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
  return mkdtempSync(join(tmpdir(), "rmd-find-"));
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

const MERGED_PR = "https://github.com/o/r/pull/1";
const CLOSED_PR = "https://github.com/o/r/pull/2";

/**
 * A deliberately VARIED fixture so every facet has a genuine proper subset (design note point 8):
 *   W1-T1  merged      risk high    workstream W1  hasPR   (RECENT)
 *   W1-T2  blocked     risk medium  workstream W1  hasPR   (RECENT)
 *   W2-T3  queued      risk low     workstream W2  no PR   (only in FIND)
 *   W2-T4  needs-human risk medium  workstream W2  no PR   needsHuman (NEEDS ME)
 *   W1-T5  running     risk low     workstream W1  no PR   (NOW)
 * → 5 distinct statusColorKey values, 2 workstreams, 3 risk bands, some PRs, some needsHuman. The
 *   FIND corpus is the WHOLE board, so tasks routed to a priority section are still searchable.
 */
function fixtureDeps(root: string): ServeDeps {
  const plan = planOf([
    task({ id: "W1-T1", title: "shell information architecture", risk: "high" }),
    task({ id: "W1-T2", title: "drain preview curation", risk: "medium" }),
    task({ id: "W2-T3", title: "quiet hours toggle", risk: "low" }),
    task({ id: "W2-T4", title: "manual approve gate", risk: "medium" }),
    task({ id: "W1-T5", title: "live board sse wiring", risk: "low" }),
  ]);
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, planYaml(plan));
  const now = new Date().toISOString();
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T09:00:00.000Z", run_id: "r1", task_id: "W1-T1", step: "pr.opened", pr_url: MERGED_PR }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T09:30:00.000Z", run_id: "r2", task_id: "W1-T2", step: "pr.opened", pr_url: CLOSED_PR }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T10:00:00.000Z", run_id: "r3", task_id: "W2-T4", step: "escalation.issue_opened" }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: now, run_id: "r4", task_id: "W1-T5", step: "run.start" }) + "\n");
  const github = fakeGitHub({
    [MERGED_PR]: { number: 1, url: MERGED_PR, state: "MERGED" },
    [CLOSED_PR]: { number: 2, url: CLOSED_PR, state: "CLOSED" },
  });
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
  // W1-T178 (round 2): `after` runs even when `--test-name-pattern` (the
  // review floor's own `unit test: <name>` dialect, review.ts's
  // parseTestTarget) matched none of THIS file's tests -- `before` above is
  // then skipped, so `browser` was never assigned, and an unconditional
  // `browser.close()` throws (hookFailed), turning the WHOLE glob's process
  // exit code nonzero and (pre-fix, review.ts's nameFilteredOutcome) risking
  // every OTHER criterion's name-filtered proof in the same review being
  // misread as failed by collateral noise from a file it never touched.
  if (browser) await browser.close();
});

async function openShell(base: string, token: string = READ_TOKEN): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/?token=${token}`);
  await page.waitForFunction(() => !document.getElementById("top-status")?.textContent?.includes("loading"));
  return page;
}

/** The ids currently rendered in the FIND view (#rest-list), in DOM order. */
async function restListIds(page: Page): Promise<string[]> {
  return page.$$eval("#rest-list > li", (lis) => lis.map((li) => (li as HTMLElement).dataset.key).filter((k): k is string => !!k));
}

/** Ensure the #rest/FIND section is expanded -- idempotent regardless of its CURRENT state.
 *  W1-T183 made "everything else" expanded BY DEFAULT (a collapsed-by-default corpus was
 *  exactly what failed that task's density/one-click bars against a realistic, mostly-queued
 *  fleet), so this no longer assumes a fixed starting state -- it only acts when collapsed. */
async function expandFind(page: Page): Promise<void> {
  const hidden = await page.getAttribute("#rest-detail", "hidden");
  if (hidden !== null) await page.click("#rest-toggle");
  await page.waitForSelector('#find-facets button[data-group="status"]');
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ── acceptance criterion 1: each facet provably NARROWS the set, with a live count ──────────────

test("W1-T157 (1): each facet narrows the FIND set to EXACTLY the matching subset, with a matching live count", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    // the unfiltered set (search empty, no facet) is the whole board — every facet must be a proper subset of it.
    const full = await (async () => {
      const page = await openShell(base);
      await expandFind(page);
      const ids = await restListIds(page);
      await page.context().close();
      return ids;
    })();
    assert.deepEqual([...full].sort(), ["W1-T1", "W1-T2", "W1-T5", "W2-T3", "W2-T4"]);

    async function facetResult(group: string, value: string): Promise<{ ids: string[]; count: number; pressed: string | null }> {
      const page = await openShell(base);
      await expandFind(page);
      const sel = `#find-facets button[data-group="${group}"][data-value="${value}"]`;
      await page.click(sel);
      const ids = (await restListIds(page)).sort();
      const countText = (await page.textContent(`${sel} .facet-count`)) ?? "";
      const pressed = await page.getAttribute(sel, "aria-pressed");
      await page.context().close();
      return { ids, count: Number(countText.replace(/\D/g, "")), pressed };
    }

    const cases: Array<[string, string, string[]]> = [
      ["status", "queued", ["W2-T3"]],
      ["status", "merged", ["W1-T1"]],
      ["status", "blocked", ["W1-T2"]],
      ["status", "needs-human", ["W2-T4"]],
      ["status", "running", ["W1-T5"]],
      ["workstream", "W1", ["W1-T1", "W1-T2", "W1-T5"]],
      ["workstream", "W2", ["W2-T3", "W2-T4"]],
      ["risk", "high", ["W1-T1"]],
      ["risk", "medium", ["W1-T2", "W2-T4"]],
      ["risk", "low", ["W1-T5", "W2-T3"]],
      ["hasPr", "", ["W1-T1", "W1-T2"]],
      ["needsMe", "", ["W2-T4"]],
    ];
    for (const [group, value, expected] of cases) {
      const { ids, count, pressed } = await facetResult(group, value);
      assert.deepEqual(ids, [...expected].sort(), `facet ${group}=${value || "(on)"} rendered ${ids} not ${expected}`);
      assert.equal(count, expected.length, `facet ${group}=${value || "(on)"} live count ${count} != rendered ${expected.length}`);
      assert.equal(pressed, "true", `facet ${group}=${value || "(on)"} must show as active`);
      // the falsifier: a facet that leaves the full set unchanged FAILS — every facet is a proper subset.
      assert.ok(ids.length < full.length, `facet ${group}=${value || "(on)"} did NOT narrow the set (${ids.length} == full ${full.length})`);
    }
  });
});

// ── acceptance criterion 2: the URL round-trips filter/sort/search state across a reload ─────────

test("W1-T157 (2): a search + facet + sort round-trips through the URL — a reload restores the IDENTICAL view", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);
    await expandFind(page);
    await page.fill("#find-search", "t");
    await page.click('#find-facets button[data-group="risk"][data-value="medium"]');
    await page.click('#find-sort button[data-sort="id"]'); // id is the default-active sort → one click flips dir to desc
    const before = await restListIds(page);
    assert.deepEqual(before, ["W2-T4", "W1-T2"]); // risk=medium, id descending

    const url = page.url();
    assert.match(url, /[?&]q=t(&|$)/);
    assert.match(url, /[?&]risk=medium(&|$)/);
    assert.match(url, /[?&]dir=desc(&|$)/);
    assert.match(url, /[?&]token=/); // the existing token param is PRESERVED, never clobbered

    // reload from that exact URL — the view must restore with NO interaction.
    await page.reload();
    await page.waitForFunction(() => !document.getElementById("top-status")?.textContent?.includes("loading"));
    await page.waitForFunction(() => document.querySelectorAll("#rest-list > li[data-key]").length === 2);

    const after = await restListIds(page);
    assert.deepEqual(after, before, "reload lost the rendered rows/order");
    assert.equal(await page.inputValue("#find-search"), "t", "reload lost the search text");
    assert.equal(await page.getAttribute('#find-facets button[data-group="risk"][data-value="medium"]', "aria-pressed"), "true", "reload lost the active facet");
    assert.equal(await page.getAttribute('#find-sort button[data-sort="id"]', "aria-pressed"), "true", "reload lost the active sort");
    await page.context().close();
  });
});

// ── acceptance criterion 3: cmd+K is reachable from every view and jumps / triggers ─────────────

test("W1-T157 (3): cmd+K opens from multiple states and jumps to a task (expand + filter + highlight)", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);

    // reachable from the DEFAULT view (W1-T183: #rest/FIND is expanded by default — a collapsed-
    // by-default corpus is exactly what failed that task's density/one-click bars)
    await page.keyboard.press("Control+k");
    await page.waitForSelector("#cmdk-overlay:not([hidden])");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#cmdk-overlay", { state: "hidden" });

    // reachable from a DIFFERENT view too: explicitly COLLAPSED, scrolled to the bottom
    await page.click("#rest-toggle"); // collapse (starts expanded — see above)
    // NOTE: a plain `page.waitForSelector("#rest-detail[hidden]")` defaults to state "visible",
    // which a `hidden`-attributed element can never satisfy (the UA stylesheet makes it
    // display:none) — wait on the property directly instead.
    await page.waitForFunction(() => (document.getElementById("rest-detail") as HTMLElement)?.hidden === true);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.keyboard.press("Control+k");
    await page.waitForSelector("#cmdk-overlay:not([hidden])");

    // jump to W2-T3 (a queued task, only reachable via FIND/cmd+K — not in a priority section)
    await page.fill("#cmdk-input", "W2-T3");
    await page.waitForSelector("#cmdk-results .cmdk-item");
    await page.keyboard.press("Enter");

    await page.waitForSelector("#cmdk-overlay", { state: "hidden" }); // palette closes after a jump
    assert.equal(await page.getAttribute("#rest-detail", "hidden"), null, "jump must expand the #rest section");
    assert.equal(await page.inputValue("#find-search"), "W2-T3", "jump must set the FIND search to the task id");
    assert.ok((await restListIds(page)).includes("W2-T3"), "the jumped-to row must be present");
    await page.waitForFunction(() => {
      const li = document.querySelector('#rest-list > li[data-key="W2-T3"]');
      return !!li && (li.classList.contains("flash") || li.classList.contains("flash-static"));
    });
    await page.context().close();
  });
});

test("W1-T157 (3): a panel/fleet action fires through the palette via the REAL route (Pause fleet)", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    assert.equal(isPaused(root), false);
    const page = await openShell(base, WRITE_TOKEN); // pause is write-scoped
    await page.keyboard.press("Control+k");
    await page.waitForSelector("#cmdk-overlay:not([hidden])");
    await page.fill("#cmdk-input", "Pause fleet");
    await page.click('#cmdk-results .cmdk-item:has-text("Pause fleet")');
    // the action clicked the REAL #pause-btn, which POSTed /v1/control/pause and wrote the flag file.
    await waitFor(() => isPaused(root));
    assert.equal(isPaused(root), true, "the palette's Pause action must fire through the real pause route");
    await page.context().close();
  });
});
