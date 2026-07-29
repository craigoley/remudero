// test/serve.glance-strip.test.ts — W1-T159 GLANCE layer, proven against a REAL browser client
// (learnings#probe-must-exercise-the-real-consuming-client): the pinned strip, the anomaly
// emphasis, the daemon-health widget, and the browser TAB TITLE badge are all things ONLY a real
// `document`/page can prove — a fetch-only test would never catch a strip that renders but never
// reads GET /v1/glance, or a tab title that never actually changes `document.title`.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { shellBootReady } from "./setup/open-shell.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

const READ_TOKEN = "glance-strip-read-token";
const WRITE_TOKEN = "glance-strip-write-token";

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
    issueByUrl: () => ({ state: "OPEN", title: "needs a decision" }),
  };
}

function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}

function fakeIssueCloser(): IssueCloser {
  return { close() {} };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-glance-strip-"));
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

function fixtureDeps(root: string, tasks: Task[], github: GitHub = fakeGitHub(), pollMs = 50): ServeDeps {
  const plan = planOf(tasks);
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, planYaml(plan));
  return {
    board: { plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs,
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

async function openShell(base: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/?token=${READ_TOKEN}`);
  await page.waitForFunction(shellBootReady);
  return { context, page };
}

async function glanceValue(page: Page, id: string): Promise<string> {
  return await page.evaluate((elId) => document.getElementById(elId)?.textContent ?? "", id);
}

// ── criterion 1 + 2: the strip's counts + spend-today/spend-this-week actually render real,
// non-placeholder numbers fetched from GET /v1/glance — never left as the "…" skeleton. ────────

test("GLANCE strip: running/needs-me/blocked/queued/merged-today/spend-today/spend-this-week all resolve off GET /v1/glance, replacing the initial skeleton", async () => {
  const root = tmpRoot();
  // W1-T2's status is genuinely "blocked" -- NOT set decoratively on the plan Task (deriveStatus
  // never trusts that field), but derived the real way: a CLOSED (not merged) PR, per
  // status.ts's `fromPrState`.
  const closedPrUrl = "https://github.com/o/r/pull/2";
  const github = fakeGitHub({ [closedPrUrl]: { number: 2, url: closedPrUrl, state: "CLOSED" } });
  const deps = fixtureDeps(root, [task({ id: "W1-T1" }), task({ id: "W1-T2" }), task({ id: "W1-T3" })], github);
  appendFileSync(
    deps.board.ledgerPath,
    JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 2.54 }) + "\n" +
      JSON.stringify({ ts: new Date().toISOString(), run_id: "r2", task_id: "W1-T2", step: "pr.opened", pr_url: closedPrUrl }) + "\n",
  );
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => (document.getElementById("glance-queued")?.textContent ?? "…") !== "…", null, { timeout: 5000 });

      assert.equal(await glanceValue(page, "glance-blocked"), "1");
      assert.equal(await glanceValue(page, "glance-merged-today"), "1");
      assert.equal(await glanceValue(page, "glance-spend-today"), "$2.54");
      assert.equal(await glanceValue(page, "glance-spend-week"), "$2.54", "today's spend is inside this UTC week's total too");
      // disk-free is a REAL statfs read on a real tmp filesystem — always resolves to a real value.
      const diskFree = await glanceValue(page, "glance-disk-free");
      assert.notEqual(diskFree, "…");
      assert.notEqual(diskFree, "unknown", "a real tmp filesystem's statfs read must succeed");
    } finally {
      await context.close();
    }
  });
});

// ── criterion 3: ANOMALY EMPHASIS — a phase-threshold breach surfaces on the STRIP itself ──────

test("GLANCE strip: a NOW row past its own phase's elapsed threshold surfaces an explicit anomaly banner on the strip, not merely an ordinary count", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  appendFileSync(
    deps.board.ledgerPath,
    JSON.stringify({ ts: twoHoursAgo, run_id: "r1", task_id: "W1-T1", step: "run.start" }) + "\n" +
      // a SECOND, RECENT line keeps `lastActivityTs` inside the liveness bound while `startedAt`
      // (from run.start) stays 2h old — a genuinely in-flight row, well past the 90m "implement"
      // phase threshold (DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS).
      JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "recon.done" }) + "\n",
  );
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => document.getElementById("glance-strip")?.getAttribute("data-anomaly") === "true", null, { timeout: 5000 });
      const banner = await page.evaluate(() => document.getElementById("glance-anomaly")?.textContent ?? "");
      assert.match(banner, /W1-T1/, "the anomaly banner must NAME the offending task, not just flip a colour");
      const hidden = await page.evaluate(() => document.getElementById("glance-anomaly")?.hidden);
      assert.equal(hidden, false);
    } finally {
      await context.close();
    }
  });
});

// ── criterion 4: the browser TAB TITLE badge updates on the SSE `needs-human` event ────────────

test("browser tab title: an SSE `needs-human` event updates document.title's needs-me count to match the NEEDS ME set — proven against the REAL consuming client (the tab title), not a fetch stand-in", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]);
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      const initialTitle = await page.title();
      assert.doesNotMatch(initialTitle, /^\(\d+\)/, "no needs-me items yet -- the title carries no count prefix");

      appendFileSync(
        deps.board.ledgerPath,
        JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "escalation.issue_opened", class: "BLOCKED", issue_url: "https://github.com/o/r/issues/1" }) +
          "\n",
      );
      await page.waitForFunction(() => document.title.startsWith("(1)"), null, { timeout: 5000 });
      const titled = await page.title();
      assert.match(titled, /^\(1\) Remudero/, "the tab title carries the CURRENT needs-me count, driven by the SSE needs-human event");

      // the SAME count the strip itself renders -- one source, not two disagreeing derivations.
      await page.waitForFunction(() => document.getElementById("glance-needs-me")?.textContent === "1", null, { timeout: 5000 });
    } finally {
      await context.close();
    }
  });
});

// ── criterion 5: daemon-health widget — last poll / next-poll countdown / disk-free / rate-limit ──

test("GLANCE daemon-health widget: last-poll + a LIVE ticking next-poll countdown render off a real daemon heartbeat ledger line, and disk-free/rate-limit each resolve to a real value or an honest 'unknown' (never a placeholder ellipsis)", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]);
  appendFileSync(
    deps.board.ledgerPath,
    JSON.stringify({ ts: new Date().toISOString(), run_id: "DAEMON", task_id: "DAEMON", step: "daemon.idle", tick: 1, poll_interval_ms: 60000 }) + "\n",
  );
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => (document.getElementById("glance-last-poll")?.textContent ?? "…") !== "…", null, { timeout: 5000 });
      const lastPoll = await glanceValue(page, "glance-last-poll");
      assert.match(lastPoll, /ago|just now/, "last poll renders a real relative-time stamp off the daemon's own heartbeat line");

      const firstCountdown = await glanceValue(page, "glance-next-poll");
      assert.match(firstCountdown, /^in |any moment/, "a LIVE countdown toward the daemon's next poll, computed from lastPollAt+pollIntervalMs");
      // it must actually TICK -- a decorative one-shot value would never change.
      await page
        .waitForFunction((prev) => (document.getElementById("glance-next-poll")?.textContent ?? "") !== prev, firstCountdown, { timeout: 3000 })
        .catch(() => null);
      const secondCountdown = await glanceValue(page, "glance-next-poll");
      assert.notEqual(firstCountdown, secondCountdown, "the countdown must tick live, not sit frozen");

      const diskFree = await glanceValue(page, "glance-disk-free");
      assert.notEqual(diskFree, "…");
      const rateLimit = await glanceValue(page, "glance-rate-limit");
      assert.notEqual(rateLimit, "…", "rate-limit must resolve to either a real remaining count or an honest 'unknown' -- never left as the loading skeleton");
    } finally {
      await context.close();
    }
  });
});
