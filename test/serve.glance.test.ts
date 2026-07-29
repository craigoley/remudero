// test/serve.glance.test.ts — W1-T159 (GLANCE layer): the pinned summary strip, the anomaly
// emphasis, the browser-tab needs-me badge, and the daemon-health widget, each proven against a
// REAL browser client over a REAL server (learnings#probe-must-exercise-the-real-consuming-
// client, same discipline test/serve.live-state.test.ts already established for this shell).
// One test per acceptance criterion, per this task's own instruction.
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

const READ_TOKEN = "glance-read-token";
const WRITE_TOKEN = "glance-write-token";

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
  return mkdtempSync(join(tmpdir(), "rmd-glance-"));
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

interface FixtureOpts {
  github?: GitHub;
  pollMs?: number;
  phaseElapsedThresholdsMs?: Record<string, number>;
  boardNow?: () => number;
  daemonHealth?: ServeDeps["daemonHealth"];
}

function fixtureDeps(root: string, tasks: Task[], opts: FixtureOpts = {}): ServeDeps {
  const plan = planOf(tasks);
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, planYaml(plan));
  const github = opts.github ?? fakeGitHub();
  return {
    board: { plan, ledgerPath, github, now: opts.boardNow },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: opts.pollMs ?? 50,
    phaseElapsedThresholdsMs: opts.phaseElapsedThresholdsMs,
    daemonHealth: opts.daemonHealth,
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

async function openShell(base: string, token = READ_TOKEN): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/?token=${token}`);
  await page.waitForFunction(shellBootReady);
  return { context, page };
}

function ledgerLine(fields: Record<string, unknown>): string {
  return JSON.stringify(fields) + "\n";
}

async function glanceText(page: Page, id: string): Promise<string> {
  return await page.evaluate((elId) => document.getElementById(elId)?.textContent ?? "", id);
}

// ── criterion 1: every strip number traces to a named source ───────────────────────────────

test("GLANCE strip: every number (running/needs-me/blocked/queued/merged-today/spend-today) is traceable to a named ledger/API source — no hardcoded number", async () => {
  const root = tmpRoot();
  const closedPrUrl = "https://github.com/o/r/pull/2";
  const fixedNow = Date.parse("2026-07-29T18:00:00.000Z");
  const deps = fixtureDeps(
    root,
    [task({ id: "W1-T1" }), task({ id: "W1-T2" }), task({ id: "W1-T3" }), task({ id: "W1-T4" }), task({ id: "W1-T5" })],
    { github: fakeGitHub({ [closedPrUrl]: { number: 2, url: closedPrUrl, state: "CLOSED" } }), boardNow: () => fixedNow },
  );
  const ledgerPath = deps.board.ledgerPath;
  // W1-T1: running (an in-flight run.start, no verdict) -- within the 30-min liveness bound of fixedNow (18:00).
  appendFileSync(ledgerPath, ledgerLine({ ts: "2026-07-29T17:45:00.000Z", run_id: "r1", task_id: "W1-T1", step: "run.start" }));
  // W1-T2: blocked (a CLOSED, unmerged PR).
  appendFileSync(ledgerPath, ledgerLine({ ts: "2026-07-29T16:00:00.000Z", run_id: "r2", task_id: "W1-T2", step: "run.start" }));
  appendFileSync(ledgerPath, ledgerLine({ ts: "2026-07-29T16:05:00.000Z", run_id: "r2", task_id: "W1-T2", step: "pr.opened", pr_url: closedPrUrl }));
  // W1-T3: queued -- deliberately NO ledger line at all.
  // W1-T4: needs-human (an OPEN escalation with no later run.start).
  appendFileSync(ledgerPath, ledgerLine({ ts: "2026-07-29T15:00:00.000Z", run_id: "r4", task_id: "W1-T4", step: "run.start" }));
  appendFileSync(
    ledgerPath,
    ledgerLine({ ts: "2026-07-29T15:10:00.000Z", run_id: "r4", task_id: "W1-T4", step: "escalation.issue_opened", issue_url: "https://github.com/o/r/issues/4", class: "BLOCKED" }),
  );
  appendFileSync(ledgerPath, ledgerLine({ ts: "2026-07-29T15:11:00.000Z", run_id: "r4", task_id: "W1-T4", step: "verdict", verdict: "blocked_review" }));
  // W1-T5: merged TODAY, with a real cost_usd figure.
  appendFileSync(ledgerPath, ledgerLine({ ts: "2026-07-29T09:00:00.000Z", run_id: "r5", task_id: "W1-T5", step: "verdict", verdict: "merged", cost_usd: 1.5 }));

  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => (document.getElementById("glance-running")?.textContent ?? "…") !== "…", null, { timeout: 5000 });
      assert.equal(await glanceText(page, "glance-running"), "1", "W1-T1 alone has a live phase");
      assert.equal(await glanceText(page, "glance-blocked"), "1", "W1-T2 alone has a CLOSED, unmerged PR");
      // "queued" is status:"queued" (the SAME predicate summaryText/renderRest already use) --
      // W1-T3 (no ledger line), W1-T4 (needsHuman is an ORTHOGONAL flag; without a real PR its
      // own status still defaults to queued), and W1-T5 (a ledger-only verdict:merged with no PR
      // to confirm it -- the board taxonomy only credits a GitHub-confirmed merge) all land here.
      assert.equal(await glanceText(page, "glance-queued"), "3");
      assert.equal(await glanceText(page, "glance-needs-me"), "1", "W1-T4 alone carries an OPEN escalation");
      assert.equal(await glanceText(page, "glance-merged-today"), "1", "W1-T5's verdict:merged line, dated today per the fixed clock");
      assert.equal(await glanceText(page, "glance-spend-today"), "$1.500", "W1-T5's own cost_usd, ledger-traceable");
    } finally {
      await context.close();
    }
  });
});

// ── criterion 2: spend-this-week beside spend-today ─────────────────────────────────────────

test("GLANCE strip: spend-this-week renders beside spend-today, both traceable to ledger cost_usd lines", async () => {
  const root = tmpRoot();
  const fixedNow = Date.parse("2026-07-29T18:00:00.000Z"); // Wednesday; this UTC week starts Monday 2026-07-27
  const deps = fixtureDeps(root, [task({ id: "W1-T1" }), task({ id: "W1-T2" })], { boardNow: () => fixedNow });
  const ledgerPath = deps.board.ledgerPath;
  appendFileSync(ledgerPath, ledgerLine({ ts: "2026-07-29T09:00:00.000Z", run_id: "r1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 1.5 })); // today
  appendFileSync(ledgerPath, ledgerLine({ ts: "2026-07-27T09:00:00.000Z", run_id: "r2", task_id: "W1-T2", step: "verdict", verdict: "blocked_review", cost_usd: 2.0 })); // Monday, same week

  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => (document.getElementById("glance-spend-today")?.textContent ?? "…") !== "…", null, { timeout: 5000 });
      assert.equal(await glanceText(page, "glance-spend-today"), "$1.500", "ONLY today's own $1.500 -- the falsifier: a daily-only figure looks unremarkable in isolation");
      assert.equal(await glanceText(page, "glance-spend-week"), "$3.500", "the week baseline ($1.500 + $2.000) that makes today's figure legible");
    } finally {
      await context.close();
    }
  });
});

// ── criterion 3: anomaly emphasis, in the strip itself ──────────────────────────────────────

test("GLANCE strip: emphasizes anomaly — a NOW row past its phase threshold and a needs-me item older than 24h are surfaced in the strip itself, not just as ordinary counts", async () => {
  const root = tmpRoot();
  const issueUrl = "https://github.com/o/r/issues/9";
  const staleOpenedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago, real wall clock
  const deps = fixtureDeps(root, [task({ id: "W1-T1" }), task({ id: "W1-T4" })], {
    phaseElapsedThresholdsMs: { recon: 0, default: 0 }, // any positive elapsed is instantly anomalous
  });
  const ledgerPath = deps.board.ledgerPath;
  appendFileSync(ledgerPath, ledgerLine({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "run.start" }));
  appendFileSync(ledgerPath, ledgerLine({ ts: staleOpenedAt, run_id: "r4", task_id: "W1-T4", step: "run.start" }));
  appendFileSync(
    ledgerPath,
    ledgerLine({ ts: staleOpenedAt, run_id: "r4", task_id: "W1-T4", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" }),
  );
  appendFileSync(ledgerPath, ledgerLine({ ts: staleOpenedAt, run_id: "r4", task_id: "W1-T4", step: "verdict", verdict: "blocked_review" }));

  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => document.getElementById("glance-anomaly")?.hidden === false, null, { timeout: 6000 });
      const text = await glanceText(page, "glance-anomaly");
      assert.match(text, /phase threshold/, "the past-threshold NOW row must be named, not just an ordinary count");
      assert.match(text, /24h/, "the stale needs-me item must be named too");
    } finally {
      await context.close();
    }
  });
});

// ── criterion 4: the tab badge updates on an SSE needs-human event ──────────────────────────

test("browser tab badge: an SSE needs-human event updates the tab title needs-me count to match the NEEDS ME set", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]);
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => document.getElementById("glance-needs-me")?.textContent === "0", null, { timeout: 5000 });
      const baseTitle = await page.title();
      assert.equal(baseTitle.startsWith("("), false, "no needs-me items yet -- no badge prefix");

      // A real ledger append -- the daemon-side SSE stream (buildStatusStream, board.ts) picks
      // this up within one poll tick and pushes a "status" event carrying needsHuman: true.
      appendFileSync(
        deps.board.ledgerPath,
        ledgerLine({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "escalation.issue_opened", issue_url: "https://github.com/o/r/issues/1", class: "BLOCKED" }),
      );

      await page.waitForFunction(() => document.title.startsWith("(1)"), null, { timeout: 5000 });
      assert.equal(await glanceText(page, "glance-needs-me"), "1", "the strip's own needs-me count agrees with the badge");
    } finally {
      await context.close();
    }
  });
});

// ── criterion 5: the daemon-health widget, every figure from its own source ─────────────────

test("daemon-health widget: shows last poll, a live next-poll countdown, disk free, and rate-limit remaining, each from its named source", async () => {
  const root = tmpRoot();
  const pollLineTs = new Date(Date.now() - 5000).toISOString();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })], {
    daemonHealth: {
      diskPath: root,
      statfs: () => ({ bavail: 12345, bsize: 4096 }),
      exec: () => JSON.stringify({ resources: { core: { remaining: 4321 } } }),
      defaultPollIntervalMs: 60_000,
    },
  });
  // poll_interval_ms is deliberately long (2min) so nextPollAt (lastPollTs + poll_interval_ms)
  // lands well in the future -- long enough for the live countdown to visibly tick during the
  // test's own wait window, never landing on "due now" immediately.
  appendFileSync(deps.board.ledgerPath, ledgerLine({ ts: pollLineTs, step: "daemon.idle", tick: 1, poll_interval_ms: 120_000 }));

  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => (document.getElementById("dh-disk-free")?.textContent ?? "…") !== "…", null, { timeout: 5000 });
      const lastPoll = await glanceText(page, "dh-last-poll");
      const diskFree = await glanceText(page, "dh-disk-free");
      const rateLimit = await glanceText(page, "dh-rate-limit");
      assert.match(lastPoll, /ago/, "last poll: a real relative timestamp off the daemon.idle ledger line, never a placeholder");
      assert.equal(diskFree, "48.2 MB", "disk free: real bavail*bsize (12345*4096) from the injected statfs");
      assert.equal(rateLimit, "4321", "rate-limit remaining: real gh api rate_limit resources.core.remaining, via the injected exec");

      // LIVE countdown -- ticks off the same 1s clock as the NOW section's elapsed spans, never frozen.
      const first = await glanceText(page, "dh-next-poll");
      await page
        .waitForFunction((prev) => (document.getElementById("dh-next-poll")?.textContent ?? "") !== prev, first, { timeout: 4000 })
        .catch(() => null);
      const second = await glanceText(page, "dh-next-poll");
      assert.notEqual(first, second, `the next-poll countdown must tick live -- was "${first}" for the full 4s poll window`);
    } finally {
      await context.close();
    }
  });
});
