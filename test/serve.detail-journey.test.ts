// test/serve.detail-journey.test.ts — W1-T222 (INLINE DETAIL layer, a RULE-21 successor to
// W1-T158 that retires its bottom-panel placement, not an amendment to it) plus the still-live
// W1-T158 acceptance bars this suite always covered. Proven over a REAL Chromium page against a
// real assembled `rmd serve` (learnings#probe-must-exercise-the-real-consuming-client). Covers:
//   (1) a row-click task CARD opens INLINE, as a sibling `<li class="row-detail">` directly
//       beneath the row that triggered it -- never a scroll-away section -- and renders
//       title/rationale/acceptance/dependency-chain/run-history (cost + verdict)/PR links (the
//       zero-extra-GitHub-calls half of this same acceptance bar is proven at the HTTP/gateway
//       level in test/task-card.test.ts, over a real buildBatchedGithub counting gateway -- this
//       suite proves the DOM half).
//   (2) a blocked fixture's JOURNEY (rmd trace, W1-T43) LAZY-LOADS inside that same open card on
//       an explicit "Show journey" click -- never fetched merely because the card opened, and
//       never its own bottom panel -- and surfaces the FAILING step.
//   (3) the card's dependency chain is LINKED and navigable (click a dep -> that dep's OWN row
//       expands in place, wherever it lives on the board).
//   (4) every task row is itself the one-click expand affordance (a chevron, never a per-row
//       "Journey" button) + carries a PR deep-link; the v0 id-textbox "Plan→task→PR graph" panel
//       AND W1-T158's own #task-detail/#journey-view bottom-panel pair are both RETIRED.
//   (5) expanding/collapsing never scrolls the page out from under the row that triggered it.
//   (6) `?task=<id>` deep-links straight to that row, expanded and scrolled into view; re-click collapses.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

const READ_TOKEN = "detail-journey-read-token";
const WRITE_TOKEN = "detail-journey-write-token";

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
  return mkdtempSync(join(tmpdir(), "rmd-detail-journey-"));
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "");
  return p;
}

/** Unlike other suites' bare planYaml, this one also emits depends_on/origin — GET /v1/trace
 *  (panel-graph.ts) reloads plan/tasks.yaml FRESH from disk, so the journey test's "origin"
 *  rendering and the reverse-trace task lookup both need them on the WRITTEN file too, not just
 *  the in-memory Plan GET /v1/task reads directly. */
function planYaml(plan: Plan): string {
  if (plan.tasks.length === 0) return "[]\n";
  return plan.tasks
    .map((t) => {
      const deps = t.depends_on.length ? `\n  depends_on: [${t.depends_on.join(", ")}]` : "";
      const origin = t.origin ? `\n  origin: ${t.origin}` : "";
      return `- id: ${t.id}\n  title: "${t.title}"\n  repo: ${t.repo}\n  type: ${t.type}${deps}${origin}\n`;
    })
    .join("");
}

function writePlan(root: string, yamlBody: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, yamlBody, { flag: "wx" });
  return planPath;
}

/** W1-T1 (a bare dependency) <- W1-T2 (merged, PR-linked, rationale+acceptance) shows in RECENT.
 *  W1-T3 (blocked, one blocked_review run) also shows in RECENT — the journey's failing-step fixture. */
function fixtureDeps(root: string): ServeDeps {
  const plan = planOf([
    task({ id: "W1-T1", title: "root dependency" }),
    task({
      id: "W1-T2",
      title: "the frobnicator",
      rationale: "operators need the frobnicator widgeted",
      depends_on: ["W1-T1"],
      acceptance: [{ claim: "it frobnicates", proof: "a test frobnicates" }],
      status: "merged",
    }),
    task({ id: "W1-T3", title: "the blocked task", status: "blocked", origin: "architect" }),
  ]);
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, planYaml(plan));
  writeFileSync(
    ledgerPath,
    [
      JSON.stringify({ ts: "2026-01-01T00:00:00Z", run_id: "W1-T2-1", task_id: "W1-T2", step: "pr.opened", pr_url: "https://github.com/o/r/pull/2" }),
      JSON.stringify({ ts: "2026-01-01T00:00:01Z", run_id: "W1-T2-1", task_id: "W1-T2", step: "verdict", verdict: "merged", cost_usd: 3.5 }),
      JSON.stringify({ ts: "2026-01-01T00:00:00Z", run_id: "W1-T3-1", task_id: "W1-T3", step: "run.start" }),
      JSON.stringify({ ts: "2026-01-01T00:00:01Z", run_id: "W1-T3-1", task_id: "W1-T3", step: "pr.opened", pr_url: "https://github.com/o/r/pull/3" }),
      JSON.stringify({ ts: "2026-01-01T00:00:02Z", run_id: "W1-T3-1", task_id: "W1-T3", step: "verdict", verdict: "blocked_review", cost_usd: 1.1 }),
    ].join("\n") + "\n",
  );
  // W1-T2's PR merged; W1-T3's PR CLOSED -> derives status "blocked" (fromPrState, status.ts) --
  // the decorative yaml `status: blocked` above is NEVER what actually derives this (module
  // convention: status is DERIVED FROM GITHUB, never trusted from yaml).
  const github = fakeGitHub({
    "https://github.com/o/r/pull/2": { number: 2, url: "https://github.com/o/r/pull/2", state: "MERGED", title: "frobnicate the widget" },
    "https://github.com/o/r/pull/3": { number: 3, url: "https://github.com/o/r/pull/3", state: "CLOSED" },
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
  await browser.close();
});

async function openShell(base: string, token: string = READ_TOKEN, qs = ""): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/?token=${token}${qs}`);
  await page.waitForFunction(() => !document.getElementById("top-status")?.textContent?.includes("loading"));
  return page;
}

// ── (1) + (3) + (5): row-click card opens INLINE beneath the row, no viewport jump, every field
// renders, and the dep chain is LINKED and navigable to the dep's OWN row ──────────────────────

test("clicking a task row expands its own card INLINE, directly beneath that row, with no viewport jump: title, rationale, acceptance, run history (cost+verdict), PR link — and its dep chain link expands the dep's OWN row in place", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);
    try {
      await page.waitForFunction(() => (document.querySelector("#recent-list")?.textContent ?? "").includes("W1-T2"));

      const rowTopBefore = await page.evaluate(
        () => document.querySelector('#recent-list li[data-task-id="W1-T2"]')!.getBoundingClientRect().top,
      );
      const scrollYBefore = await page.evaluate(() => window.scrollY);

      // click the task-id text of W1-T2's RECENT row -- never its chevron/PR <a>.
      await page.click('#recent-list li[data-task-id="W1-T2"] .task-id');
      // wait for the LOADED card, not the pre-data skeleton the expand paints immediately.
      await page.waitForFunction(() => (document.querySelector(".row-detail")?.textContent ?? "").includes("frobnicator"));

      const rowTopAfter = await page.evaluate(
        () => document.querySelector('#recent-list li[data-task-id="W1-T2"]')!.getBoundingClientRect().top,
      );
      const scrollYAfter = await page.evaluate(() => window.scrollY);
      assert.equal(rowTopAfter, rowTopBefore, "the triggering row must stay exactly where it was -- no viewport jump");
      assert.equal(scrollYAfter, scrollYBefore, "expanding a card must never scroll the page on its own");

      const card = await page.evaluate(() => {
        const row = document.querySelector('#recent-list li[data-task-id="W1-T2"]')!;
        const detail = row.nextElementSibling as HTMLElement;
        return {
          isImmediateSibling: detail?.classList.contains("row-detail") ?? false,
          ariaExpanded: row.getAttribute("aria-expanded"),
          body: detail?.textContent ?? "",
          prHref: detail?.querySelector('a[href*="pull/2"]')?.getAttribute("href") ?? null,
          depBtn: detail?.querySelector('.card-dep-link[data-dep-id="W1-T1"]')?.textContent ?? null,
        };
      });
      assert.ok(card.isImmediateSibling, "the card must be the row's OWN next sibling <li>, not a section elsewhere in the page");
      assert.equal(card.ariaExpanded, "true");
      assert.match(card.body, /W1-T2/);
      assert.match(card.body, /the frobnicator/);
      assert.match(card.body, /operators need the frobnicator widgeted/); // rationale
      assert.match(card.body, /it frobnicates/); // acceptance claim
      assert.match(card.body, /a test frobnicates/); // acceptance proof
      assert.match(card.body, /merged/); // run history verdict
      assert.match(card.body, /3\.500/); // run history cost
      assert.equal(card.prHref, "https://github.com/o/r/pull/2"); // PR link
      assert.equal(card.depBtn, "W1-T1"); // the dep chain is LINKED (a real button naming the dep)

      // (3) navigate the dep chain: clicking W1-T1's dep link expands W1-T1's OWN row's card --
      // W1-T2's card must close (only one card open at a time, board-wide).
      // .row-detail is the row's own SIBLING <li>, never a descendant of it.
      await page.click('#recent-list .row-detail .card-dep-link[data-dep-id="W1-T1"]');
      await page.waitForFunction(() => (document.querySelector(".row-detail")?.textContent ?? "").includes("root dependency"));
      const after = await page.evaluate(() => ({
        w1t2Expanded: document.querySelector('#recent-list li[data-task-id="W1-T2"]')?.getAttribute("aria-expanded"),
        openCards: document.querySelectorAll(".row-detail").length,
      }));
      assert.equal(after.w1t2Expanded, "false", "expanding a dependency's own card must collapse the previous one");
      assert.equal(after.openCards, 1, "only ONE card may be open at a time, board-wide");
    } finally {
      await page.context().close();
    }
  });
});

// ── (2): journey LAZY-LOADS inside the open card, never eagerly, and surfaces the FAILING step ─

test("a blocked task's Journey lazy-loads INSIDE its already-open card (never fetched merely because the card opened) and surfaces the FAILING step", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);
    const traceRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/v1/trace")) traceRequests.push(req.url());
    });
    try {
      await page.waitForFunction(() => (document.querySelector("#recent-list")?.textContent ?? "").includes("W1-T3"));
      await page.click('#recent-list li[data-task-id="W1-T3"] .task-id');
      await page.waitForFunction(() => (document.querySelector(".row-detail")?.textContent ?? "").includes("the blocked task"));

      assert.equal(traceRequests.length, 0, "opening the card alone must not fetch the journey");
      const toggleBefore = await page.evaluate(() => document.querySelector(".card-journey-toggle")?.getAttribute("aria-expanded"));
      assert.equal(toggleBefore, "false");

      await page.click(".card-journey-toggle");
      await page.waitForFunction(() => (document.querySelector(".card-journey-body")?.textContent ?? "").includes("blocked_review"));
      assert.equal(traceRequests.length, 1, "the explicit 'Show journey' click fetches the journey exactly once");

      const journey = await page.evaluate(() => ({
        toggleExpanded: document.querySelector(".card-journey-toggle")?.getAttribute("aria-expanded"),
        body: document.querySelector(".card-journey-body")?.textContent ?? "",
        failingSteps: document.querySelectorAll(".card-journey-body .journey-fail").length,
        failingText: document.querySelector(".card-journey-body .journey-fail")?.textContent ?? "",
      }));
      assert.equal(journey.toggleExpanded, "true");
      assert.match(journey.body, /task/); // renders the task node
      assert.match(journey.body, /W1-T3-1/); // renders the run node (the provenance chain)
      assert.equal(journey.failingSteps, 1, "the journey must mark exactly the blocked run as the FAILING step");
      assert.match(journey.failingText, /BLOCKING/);
      assert.match(journey.body, /blocked_review/); // the block's own cause, named

      // re-toggle hides it WITHOUT a second fetch (cached once per card open).
      await page.click(".card-journey-toggle");
      await page.waitForFunction(() => (document.querySelector(".card-journey-body") as HTMLElement)?.hidden === true);
      await page.click(".card-journey-toggle");
      await page.waitForFunction(() => (document.querySelector(".card-journey-body") as HTMLElement)?.hidden === false);
      assert.equal(traceRequests.length, 1, "re-toggling the SAME open card must reuse the cached journey, never re-fetch");
    } finally {
      await page.context().close();
    }
  });
});

// ── (4): every task row is itself the expand affordance + a PR deep-link; the v0 id-textbox
// panel AND W1-T158's own bottom #task-detail/#journey-view panel pair are both retired ────────

test("every task row is itself a one-click expand affordance (a chevron, never a per-row Journey button) + a PR deep-link; the v0 id-textbox trace panel AND the bottom-panel #task-detail/#journey-view pair are both gone", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);
    try {
      await page.waitForFunction(() => (document.querySelector("#recent-list")?.textContent ?? "").includes("W1-T2"));

      const state = await page.evaluate(() => ({
        graphBtn: document.getElementById("graph-btn"),
        traceId: document.getElementById("trace-id"),
        taskDetailPanel: document.getElementById("task-detail"),
        journeyViewPanel: document.getElementById("journey-view"),
        rowJourneyButtons: document.querySelectorAll(".row-journey-btn").length,
        chevrons: document.querySelectorAll("#recent-list .row-chevron").length,
        prAnchor: document.querySelector('#recent-list li[data-task-id="W1-T2"] a[href*="pull/2"]')?.getAttribute("href"),
      }));
      assert.equal(state.graphBtn, null, "the v0 'Plan→task→PR graph' id-textbox button must be gone");
      assert.equal(state.traceId, null, "the v0 free-text trace-id input must be gone");
      assert.equal(state.taskDetailPanel, null, "W1-T158's own bottom #task-detail panel must be retired");
      assert.equal(state.journeyViewPanel, null, "W1-T158's own bottom #journey-view panel must be retired");
      assert.equal(state.rowJourneyButtons, 0, "the per-row Journey BUTTON is retired -- the whole row is the affordance now");
      assert.ok(state.chevrons > 0, "every task row must carry the chevron expand affordance");
      assert.equal(state.prAnchor, "https://github.com/o/r/pull/2", "the PR cell must deep-link to the PR");

      // clicking anywhere on the row (never on the PR link itself) opens THAT row's own card inline.
      await page.click('#recent-list li[data-task-id="W1-T2"] .task-id');
      await page.waitForFunction(
        () => document.querySelector('#recent-list li[data-task-id="W1-T2"]')?.getAttribute("aria-expanded") === "true",
      );
      const detail = await page.evaluate(
        () => document.querySelector('#recent-list li[data-task-id="W1-T2"]')!.nextElementSibling?.className,
      );
      assert.equal(detail, "row-detail");

      // clicking the SAME row again collapses it.
      await page.click('#recent-list li[data-task-id="W1-T2"] .task-id');
      await page.waitForFunction(
        () => document.querySelector('#recent-list li[data-task-id="W1-T2"]')?.getAttribute("aria-expanded") === "false",
      );
      const openCards = await page.evaluate(() => document.querySelectorAll(".row-detail").length);
      assert.equal(openCards, 0, "re-clicking an open row must collapse its card");
    } finally {
      await page.context().close();
    }
  });
});

// ── (6): ?task=<id> deep-links straight to that row, expanded + scrolled into view; re-click collapses ─

test("?task=<id> opens the shell with that row already expanded and scrolled into view; a subsequent click on it collapses", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base, READ_TOKEN, "&task=W1-T2");
    try {
      await page.waitForFunction(
        () => document.querySelector('#recent-list li[data-task-id="W1-T2"]')?.getAttribute("aria-expanded") === "true",
        null,
        { timeout: 5000 },
      );
      await page.waitForFunction(() => (document.querySelector(".row-detail")?.textContent ?? "").includes("frobnicator"));
      const inView = await page.evaluate(() => {
        const r = document.querySelector('#recent-list li[data-task-id="W1-T2"]')!.getBoundingClientRect();
        return r.top >= 0 && r.top <= window.innerHeight;
      });
      assert.ok(inView, "the deep-linked row must be scrolled into view");

      await page.click('#recent-list li[data-task-id="W1-T2"] .task-id');
      await page.waitForFunction(
        () => document.querySelector('#recent-list li[data-task-id="W1-T2"]')?.getAttribute("aria-expanded") === "false",
      );
      const openCards = await page.evaluate(() => document.querySelectorAll(".row-detail").length);
      assert.equal(openCards, 0);
    } finally {
      await page.context().close();
    }
  });
});

// ── (5, W1-T184): a RECENT row is a readable ACTIVITY FEED entry, not a bare id+PR-number ───────
//
// FALSIFIER (operator screenshot, 2026-07-20): "a RECENT row rendering only a task id and a PR
// number is unreadable as an activity feed — it names WHAT changed but not what it WAS." Every
// row must carry: the event VERB, the task id AND its title, a PR link carrying the PR's TITLE
// (not a bare number), a relative timestamp, a spend figure wherever the ledger has one, and
// still be a W1-T158/W1-T222 drill target (clicking it opens the task card inline).

test("W1-T184: a RECENT row carries the verb, task id AND title, a PR link with the PR's TITLE, a relative timestamp, and spend — and is still a drill target into the inline task card", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);
    try {
      await page.waitForFunction(() => (document.querySelector("#recent-list")?.textContent ?? "").includes("W1-T2"));

      const row = await page.evaluate(() => {
        const li = document.querySelector('#recent-list li[data-task-id="W1-T2"]')!;
        return {
          verb: li.querySelector(".recent-verb")?.textContent ?? null,
          dataVerb: li.querySelector(".task-id")?.getAttribute("data-verb") ?? null,
          taskId: li.querySelector(".task-id")?.textContent ?? null,
          title: li.querySelector(".recent-title")?.textContent ?? null,
          prLinkText: li.querySelector(".recent-pr-link")?.textContent ?? null,
          prHref: li.querySelector(".recent-pr-link")?.getAttribute("href") ?? null,
          spend: li.querySelector(".recent-spend")?.textContent ?? null,
          timestamp: li.querySelector(".recent-ts")?.textContent ?? null,
          timestampDatetime: li.querySelector(".recent-ts")?.getAttribute("datetime") ?? null,
        };
      });

      assert.match(row.verb ?? "", /merged/i);
      assert.equal(row.dataVerb, "merged");
      assert.match(row.taskId ?? "", /W1-T2/);
      assert.match(row.title ?? "", /the frobnicator/); // the task's OWN title, not just its id
      // the PR link's label carries the PR's TITLE, not a bare "#2":
      assert.match(row.prLinkText ?? "", /frobnicate the widget/);
      assert.equal(row.prHref, "https://github.com/o/r/pull/2");
      assert.match(row.spend ?? "", /3\.500/); // the ledger's own cost_usd for this verdict line
      assert.ok(row.timestamp && row.timestamp.length > 0, "a relative timestamp must render");
      assert.ok(row.timestampDatetime, "the timestamp carries a machine-readable datetime too");

      // still a drill target: clicking the row (its task-id text) opens the card INLINE beneath it.
      await page.click('#recent-list li[data-task-id="W1-T2"] .task-id');
      await page.waitForFunction(() => (document.querySelector(".row-detail")?.textContent ?? "").includes("frobnicator"));
      const isImmediateSibling = await page.evaluate(
        () => document.querySelector('#recent-list li[data-task-id="W1-T2"]')!.nextElementSibling?.classList.contains("row-detail") ?? false,
      );
      assert.ok(isImmediateSibling);
    } finally {
      await page.context().close();
    }
  });
});
