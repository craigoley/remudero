// test/serve.detail-journey.test.ts — W1-T158 (DETAIL + JOURNEY layer), the acceptance bars that
// can only be proven against a REAL browser client (learnings#probe-must-exercise-the-real-
// consuming-client). Covers, over a real Chromium page against a real assembled `rmd serve`:
//   (1) a row-click task CARD renders title/rationale/acceptance/dependency-chain/run-history
//       (cost + verdict)/PR links (the zero-extra-GitHub-calls half of this same acceptance bar
//       is proven at the HTTP/gateway level in test/task-card.test.ts, over a real
//       buildBatchedGithub counting gateway — this suite proves the DOM half).
//   (2) a blocked fixture's JOURNEY (rmd trace, W1-T43) surfaces the FAILING step.
//   (3) the card's dependency chain is LINKED and navigable (click a dep -> that dep's own card).
//   (4) every task row carries an explicit one-click Journey affordance + a PR deep-link, and the
//       v0 id-textbox "Plan→task→PR graph" panel is RETIRED.
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
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github },
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
  await page.waitForFunction(() => !document.getElementById("top-status")?.textContent?.includes("loading"));
  return page;
}

// ── (1) + (3): row-click card renders every field; the dep chain is LINKED and navigable ───────

test("clicking a task row expands its own card: title, rationale, acceptance, run history (cost+verdict), PR link — and its dep chain link navigates to that dep's own card", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);
    try {
      await page.waitForFunction(() => (document.querySelector("#recent-list")?.textContent ?? "").includes("W1-T2"));
      // click the task-id text of W1-T2's RECENT row -- never its .row-journey-btn/PR <a>.
      await page.click('#recent-list li[data-task-id="W1-T2"] .task-id');
      // wait for the LOADED card, not the "Task W1-T2" placeholder openCard paints immediately.
      await page.waitForFunction(() => (document.getElementById("task-detail-title")?.textContent ?? "").includes("frobnicator"));

      const card = await page.evaluate(() => ({
        title: document.getElementById("task-detail-title")?.textContent ?? "",
        body: document.getElementById("task-detail-body")?.textContent ?? "",
        prHref: document.querySelector('#task-detail-body a[href*="pull/2"]')?.getAttribute("href") ?? null,
        depBtn: document.querySelector('#task-detail-body .card-dep-link[data-dep-id="W1-T1"]')?.textContent ?? null,
      }));
      assert.match(card.title, /W1-T2/);
      assert.match(card.title, /the frobnicator/);
      assert.match(card.body, /operators need the frobnicator widgeted/); // rationale
      assert.match(card.body, /it frobnicates/); // acceptance claim
      assert.match(card.body, /a test frobnicates/); // acceptance proof
      assert.match(card.body, /merged/); // run history verdict
      assert.match(card.body, /3\.500/); // run history cost
      assert.equal(card.prHref, "https://github.com/o/r/pull/2"); // PR link
      assert.equal(card.depBtn, "W1-T1"); // the dep chain is LINKED (a real button naming the dep)

      // (3) navigate the dep chain: clicking W1-T1's dep link opens W1-T1's OWN card.
      await page.click('#task-detail-body .card-dep-link[data-dep-id="W1-T1"]');
      await page.waitForFunction(() => (document.getElementById("task-detail-title")?.textContent ?? "").includes("root dependency"));
      const depTitle = await page.textContent("#task-detail-title");
      assert.match(depTitle ?? "", /W1-T1/);
      assert.match(depTitle ?? "", /root dependency/);
    } finally {
      await page.context().close();
    }
  });
});

// ── (2): a blocked fixture's journey surfaces the FAILING step ─────────────────────────────────

test("a blocked task's Journey (opened via its own per-row action) renders the provenance chain and surfaces the FAILING step", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);
    try {
      await page.waitForFunction(() => (document.querySelector("#recent-list")?.textContent ?? "").includes("W1-T3"));
      await page.click('#recent-list li[data-task-id="W1-T3"] .row-journey-btn');
      await page.waitForFunction(() => (document.getElementById("journey-body")?.textContent ?? "").includes("blocked_review"));

      const journey = await page.evaluate(() => ({
        title: document.getElementById("journey-title")?.textContent ?? "",
        body: document.getElementById("journey-body")?.textContent ?? "",
        failingSteps: document.querySelectorAll("#journey-body .journey-fail").length,
        failingText: document.querySelector("#journey-body .journey-fail")?.textContent ?? "",
      }));
      assert.match(journey.title, /W1-T3/); // keyed on the row's OWN id, never typed
      assert.match(journey.body, /task/); // renders the task node
      assert.match(journey.body, /W1-T3-1/); // renders the run node (the provenance chain)
      assert.equal(journey.failingSteps, 1, "the journey must mark exactly the blocked run as the FAILING step");
      assert.match(journey.failingText, /BLOCKING/);
      assert.match(journey.body, /blocked_review/); // the block's own cause, named
    } finally {
      await page.context().close();
    }
  });
});

// ── (4): every task row carries an explicit Journey affordance + PR deep-link; v0 retired ──────

test("every task row exposes an explicit one-click Journey action + a PR deep-link; the v0 id-textbox trace panel is gone", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root), async (base) => {
    const page = await openShell(base);
    try {
      await page.waitForFunction(() => (document.querySelector("#recent-list")?.textContent ?? "").includes("W1-T2"));

      const state = await page.evaluate(() => ({
        graphBtn: document.getElementById("graph-btn"),
        traceId: document.getElementById("trace-id"),
        journeyButtons: document.querySelectorAll(".row-journey-btn").length,
        w1t2JourneyKey: document.querySelector('#recent-list li[data-task-id="W1-T2"] .row-journey-btn')?.getAttribute("data-task-id"),
        prAnchor: document.querySelector('#recent-list li[data-task-id="W1-T2"] a[href*="pull/2"]')?.getAttribute("href"),
      }));
      assert.equal(state.graphBtn, null, "the v0 'Plan→task→PR graph' id-textbox button must be gone");
      assert.equal(state.traceId, null, "the v0 free-text trace-id input must be gone");
      assert.ok(state.journeyButtons > 0, "every task row must carry a Journey button");
      assert.equal(state.w1t2JourneyKey, "W1-T2", "the Journey button is keyed on ITS OWN row's task id, never a typed one");
      assert.equal(state.prAnchor, "https://github.com/o/r/pull/2", "the PR cell must deep-link to the PR");

      // Clicking the Journey button opens THAT row's journey directly -- no id ever typed.
      await page.click('#recent-list li[data-task-id="W1-T2"] .row-journey-btn');
      await page.waitForFunction(() => (document.getElementById("journey-title")?.textContent ?? "").includes("W1-T2"));
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
// still be a W1-T158 drill target (clicking it opens the task card).

test("W1-T184: a RECENT row carries the verb, task id AND title, a PR link with the PR's TITLE, a relative timestamp, and spend — and is still a drill target into the task card", async () => {
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

      // still a W1-T158 drill target: clicking the row (its task-id text) opens the task card.
      await page.click('#recent-list li[data-task-id="W1-T2"] .task-id');
      await page.waitForFunction(() => (document.getElementById("task-detail-title")?.textContent ?? "").includes("frobnicator"));
    } finally {
      await page.context().close();
    }
  });
});
