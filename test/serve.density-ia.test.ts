// test/serve.density-ia.test.ts — W1-T183 (CONSOLE DENSITY + IA v2), the acceptance bars that can
// only be proven against a REAL browser client (learnings#probe-must-exercise-the-real-
// consuming-client): a first screen dense enough to read the fleet, no raw ISO-millisecond
// timestamp anywhere, a one-click drill from a dense row to W1-T158's own card, and a per-phase
// elapsed ANOMALY flag driven by a data source a test can override (never a hard-coded constant).
//
// SCOPE NOTE: this is a NEW file, deliberately -- test/serve.live-state.test.ts (W1-T156) is this
// task's own falsifier for "not a regression dressed as a redesign" and MUST keep passing
// UNMODIFIED (verified separately, run as-is). Everything below is additive proof for W1-T183's
// own five acceptance bars, never a rewrite of an existing test.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildServeServer, DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS, type ServeDeps } from "../src/lib/serve.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

const READ_TOKEN = "density-ia-read-token";
const WRITE_TOKEN = "density-ia-write-token";

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

/** A GitHub gateway whose `readFailed()` answer is toggled live by the test -- backs the
 *  "GitHub unreachable" timestamp-format test without needing a real throttled `gh` call. */
function flakyGitHub(state: { failed: boolean }): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => state.failed,
    readFailureReason: () => "rate_limit",
  };
}

function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}

function fakeIssueCloser(): IssueCloser {
  return { close() {} };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-density-ia-"));
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "");
  return p;
}

function planYaml(plan: Plan): string {
  if (plan.tasks.length === 0) return "[]\n";
  // W1-T223: `status`/`verify`/`depends_on` are now serialized too -- GET /v1/drain/preview
  // (panel-graph.ts's buildDrainPreviewRoute) reads the plan FRESH from planPath on every
  // request, never the in-memory `Plan` a fixture builds, so a Task-level override of any of
  // these that this helper dropped was previously invisible to drain-preview specifically
  // (silently defaulting to status:queued/verify:auto/depends_on:[] on the YAML round-trip).
  return plan.tasks
    .map((t) => {
      const deps = t.depends_on.length ? `\n  depends_on: [${t.depends_on.join(", ")}]` : "";
      return `- id: ${t.id}\n  title: "${t.title}"\n  repo: ${t.repo}\n  type: ${t.type}\n  status: ${t.status}\n  verify: ${t.verify}${deps}\n`;
    })
    .join("");
}

function writePlan(root: string, yamlBody: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, yamlBody, { flag: "wx" });
  return planPath;
}

function fixtureDeps(
  root: string,
  tasks: Task[],
  over: Partial<Pick<ServeDeps, "phaseElapsedThresholdsMs">> & { github?: GitHub; pollMs?: number } = {},
): ServeDeps {
  const plan = planOf(tasks);
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, planYaml(plan));
  const github = over.github ?? fakeGitHub();
  return {
    board: { plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: over.pollMs ?? 50,
    phaseElapsedThresholdsMs: over.phaseElapsedThresholdsMs,
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

function runStart(taskId: string, runId = "r1"): string {
  return JSON.stringify({ ts: new Date().toISOString(), run_id: runId, task_id: taskId, step: "run.start" }) + "\n";
}

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});
after(async () => {
  await browser.close();
});

async function openShell(base: string, opts: { viewport?: { width: number; height: number } } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(opts.viewport ? { viewport: opts.viewport } : {});
  const page = await context.newPage();
  await page.goto(`${base}/?token=${READ_TOKEN}`);
  await page.waitForFunction(() => !document.getElementById("top-status")?.textContent?.includes("loading"));
  return { context, page };
}

// ── (1) DENSITY: a first screen at a 1440px viewport height shows at least ~15 tasks ───────────
// Mirrors the operator fixture this task falsifies: 6 in-flight tasks (NOW) + 10 terminal tasks
// (RECENT, capped at the route's own default of 10) -- a realistic multi-section spread, not one
// section artificially stuffed -- must together fit ABOVE THE FOLD as dense single-line rows.

test("density: at a 1440px viewport height, at least 15 task rows render fully above the fold", async () => {
  const root = tmpRoot();
  const running = Array.from({ length: 6 }, (_, i) => task({ id: `W1-T${i}` }));
  const recent = Array.from({ length: 10 }, (_, i) => task({ id: `W2-T${i}` }));
  // status is DERIVED FROM GITHUB, never trusted from yaml (module convention, see
  // serve.detail-journey.test.ts's own fixture note) -- so RECENT needs a real pr.opened +
  // verdict ledger pair per task, backed by a matching fakeGitHub PR state (MERGED/CLOSED).
  const byRef: Record<string, PrRef> = {};
  const github = fakeGitHub(byRef);
  const deps = fixtureDeps(root, [...running, ...recent], { github });
  for (const t of running) appendFileSync(deps.board.ledgerPath, runStart(t.id));
  recent.forEach((t, i) => {
    const prUrl = `https://github.com/o/r/pull/${i}`;
    const merged = i % 2 === 0;
    byRef[prUrl] = { number: i, url: prUrl, state: merged ? "MERGED" : "CLOSED" };
    appendFileSync(
      deps.board.ledgerPath,
      [
        JSON.stringify({ ts: new Date().toISOString(), run_id: `${t.id}-1`, task_id: t.id, step: "pr.opened", pr_url: prUrl }),
        JSON.stringify({ ts: new Date().toISOString(), run_id: `${t.id}-1`, task_id: t.id, step: "verdict", verdict: merged ? "merged" : "blocked_review" }),
      ].join("\n") + "\n",
    );
  });
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base, { viewport: { width: 1440, height: 1440 } });
    try {
      await page.waitForFunction(() => document.querySelectorAll("#now-list li[data-key]").length === 6);
      await page.waitForFunction(() => document.querySelectorAll("#recent-list li[data-key]").length === 10);

      const aboveFold = await page.evaluate(() => {
        const vh = window.innerHeight;
        const rows = [...document.querySelectorAll(".row-list .row:not(.skeleton)")];
        return rows.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= vh;
        }).length;
      });
      assert.ok(aboveFold >= 15, `expected >= 15 dense rows above the fold at 1440px height, got ${aboveFold}`);
    } finally {
      await context.close();
    }
  });
});

// ── (1b) the LITERAL falsifier fixture: a realistic, mostly-queued 214-task plan with NO special
// activity -- NOW/NEEDS ME are empty, RECENT is empty (nothing merged/blocked yet), UP NEXT caps
// at 5. Before this fix, "everything else" stayed hidden behind an "Expand" click, so a first
// screen here showed only a handful of rows even though the CSS itself was already dense -- the
// exact 2026-07-20 console v2 bug. This is the fixture that catches that regression; (1) above
// only proves the CSS is dense once rows are visible. ──────────────────────────────────────────

test("density: a realistic 214-task, mostly-queued plan (no NOW/NEEDS-ME/RECENT activity) still shows >= 15 rows on the FIRST screen, no interaction", async () => {
  const root = tmpRoot();
  const tasks = Array.from({ length: 214 }, (_, i) => task({ id: `W1-T${i}` }));
  const deps = fixtureDeps(root, tasks);
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base, { viewport: { width: 1440, height: 1440 } });
    try {
      await page.waitForFunction(() => document.querySelectorAll("#rest-list li[data-key]").length > 0);
      // no click, no scroll, no expand -- exactly what a fresh page load hands the operator.
      const aboveFold = await page.evaluate(() => {
        const vh = window.innerHeight;
        const rows = [...document.querySelectorAll(".row-list .row:not(.skeleton)")];
        return rows.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= vh;
        }).length;
      });
      assert.ok(aboveFold >= 15, `expected >= 15 dense rows above the fold with NO interaction, got ${aboveFold}`);
    } finally {
      await context.close();
    }
  });
});

// ── (3b) a task reachable ONLY via "everything else" (not in any priority section) is STILL
// one click from its card -- the exact gap a collapsed-by-default rest section left open (an
// expand click THEN a row click is two interactions, which the acceptance bar's own falsifier
// names explicitly). ──────────────────────────────────────────────────────────────────────────

test("one-click drill: a task reachable only via the 'everything else' corpus opens its card in ONE click, no prior expand", async () => {
  const root = tmpRoot();
  // `status: "blocked"` -- nextRunnable explicitly skips a blocked task (drain.ts), so it never
  // enters the drain preview's simulated-forward sequence (which otherwise pulls in ANY task
  // reachable via a merge chain, not just currently-runnable ones); no escalation/phase/ledger
  // event puts it in NOW/NEEDS ME/RECENT either, so it is reachable via NO priority section --
  // only "everything else"/FIND (W1-T223: REST's own header now defaults collapsed when its
  // complement is genuinely EMPTY, so this fixture must keep the "only in rest" premise real).
  const deps = fixtureDeps(root, [task({ id: "W1-T1", title: "only in the rest corpus", status: "blocked" })]);
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => document.querySelectorAll("#rest-list li[data-key]").length === 1);
      // the section must already be visible -- no expand click before the row is even clickable.
      assert.equal(await page.evaluate(() => (document.getElementById("rest-detail") as HTMLElement)?.hidden), false);
      assert.equal(await page.evaluate(() => document.querySelector(".row-detail") !== null), false);

      await page.click('#rest-list li[data-task-id="W1-T1"] .task-id');
      await page.waitForFunction(
        () => document.querySelector('#rest-list li[data-task-id="W1-T1"]')?.getAttribute("aria-expanded") === "true",
        null,
        { timeout: 5000 },
      );
      await page.waitForFunction(() => (document.querySelector(".row-detail")?.textContent ?? "").includes("only in the rest corpus"), null, { timeout: 5000 });
    } finally {
      await context.close();
    }
  });
});

// ── (2) TIMESTAMPS: local + relative together, NEVER a raw ISO-millisecond string ──────────────

const ISO_MS_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

test("timestamps: no raw ISO-millisecond string renders anywhere, and time cells carry both a local clock reading and a relative one", async () => {
  const root = tmpRoot();
  const ghState = { failed: true };
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })], { github: flakyGitHub(ghState) });
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      // GitHub-unreachable banner: real timestamp-rendering surface (previously a bare .toISOString()).
      await page.waitForFunction(() => document.getElementById("gh-unreachable-banner")?.hidden === false, null, { timeout: 5000 });
      const bannerText = await page.textContent("#gh-unreachable-banner");
      assert.doesNotMatch(bannerText ?? "", ISO_MS_PATTERN, `banner rendered a raw ISO-millisecond stamp: ${bannerText}`);
      // local clock (H:MM(:SS) with an am/pm or 24h colon form) AND a relative qualifier together.
      assert.match(bannerText ?? "", /\d{1,2}:\d{2}/, "banner is missing a local clock reading");
      assert.match(bannerText ?? "", /ago|just now/, "banner is missing a relative reading");

      // the top-status "updated …" stamp, once a live refresh completes.
      ghState.failed = false;
      await page.waitForFunction(() => document.getElementById("gh-unreachable-banner")?.hidden === true, null, { timeout: 5000 });
      await page.waitForFunction(() => (document.getElementById("top-status")?.textContent ?? "").startsWith("updated"), null, { timeout: 5000 });
      const topStatusText = await page.textContent("#top-status");
      assert.doesNotMatch(topStatusText ?? "", ISO_MS_PATTERN, `top-status rendered a raw ISO-millisecond stamp: ${topStatusText}`);
      assert.match(topStatusText ?? "", /\d{1,2}:\d{2}/);
      assert.match(topStatusText ?? "", /ago|just now/);

      // whole-page sweep: no text node anywhere matches the raw ISO-millisecond shape.
      const anyRawIso = await page.evaluate((pattern) => {
        const re = new RegExp(pattern);
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = walker.nextNode())) {
          if (re.test(n.textContent ?? "")) return n.textContent;
        }
        return null;
      }, ISO_MS_PATTERN.source);
      assert.equal(anyRawIso, null, `found a raw ISO-millisecond text node: ${anyRawIso}`);
    } finally {
      await context.close();
    }
  });
});

// ── (3) ONE-CLICK DRILL: a dense row is itself the click target for W1-T158's task card ────────

test("one-click drill: clicking a dense NOW row opens W1-T158's task card directly, no intermediate view", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1", title: "dense row target" })]);
  appendFileSync(deps.board.ledgerPath, runStart("W1-T1"));
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => (document.querySelector("#now-list .detail")?.textContent ?? "").includes("phase: recon"));
      assert.equal(await page.evaluate(() => document.querySelector(".row-detail") !== null), false);

      // ONE click, on the row itself (never the chevron/PR link/etc -- it's the whole row's own affordance).
      await page.click('#now-list li[data-task-id="W1-T1"] .task-id');
      await page.waitForFunction(
        () => document.querySelector('#now-list li[data-task-id="W1-T1"]')?.getAttribute("aria-expanded") === "true",
        null,
        { timeout: 5000 },
      );
      await page.waitForFunction(() => (document.querySelector(".row-detail")?.textContent ?? "").includes("dense row target"), null, { timeout: 5000 });
    } finally {
      await context.close();
    }
  });
});

// ── (3c) the claim's own wording is "a click on a row in ANY section" -- not just NOW (3 above)
// and rest-only (3b above). Cover NEEDS ME, UP NEXT, and RECENT too, in one pass, each opening
// W1-T158's card in exactly one click. ──────────────────────────────────────────────────────────

test("one-click drill: a click on a row in EVERY section (NOW/NEEDS ME/UP NEXT/RECENT/rest) opens its card directly", async () => {
  const root = tmpRoot();
  const now = task({ id: "W1-T1", title: "now section target" });
  const needsMe = task({ id: "W1-T2", title: "needs me section target" });
  const upNext = task({ id: "W1-T3", title: "up next section target" });
  const recent = task({ id: "W1-T4", title: "recent section target" });
  // W1-T223: REST's own header now defaults collapsed when its complement is genuinely EMPTY, so
  // this row must be reachable via NO priority section -- a plain queued task with no deps would
  // ALSO surface in UP NEXT's drain preview (which simulates a forward merge chain, so even an
  // UNMET dependency does not exclude it). `status: "blocked"` is what nextRunnable itself skips
  // outright (drain.ts), keeping this row in REST/FIND alone, matching this test's own "rest
  // section target" premise.
  const rest = task({ id: "W1-T5", title: "rest section target", status: "blocked" });
  const prUrl = "https://github.com/o/r/pull/4";
  const byRef = { [prUrl]: { number: 4, url: prUrl, state: "MERGED" } };
  const github = fakeGitHub(byRef);
  const deps = fixtureDeps(root, [now, needsMe, upNext, recent, rest], { github });
  appendFileSync(deps.board.ledgerPath, runStart("W1-T1"));
  appendFileSync(
    deps.board.ledgerPath,
    JSON.stringify({ ts: new Date().toISOString(), run_id: "W1-T2-1", task_id: "W1-T2", step: "escalation.issue_opened", issue_url: "https://github.com/o/r/issues/2" }) + "\n",
  );
  appendFileSync(
    deps.board.ledgerPath,
    [
      JSON.stringify({ ts: new Date().toISOString(), run_id: "W1-T4-1", task_id: "W1-T4", step: "pr.opened", pr_url: prUrl }),
      JSON.stringify({ ts: new Date().toISOString(), run_id: "W1-T4-1", task_id: "W1-T4", step: "verdict", verdict: "merged" }),
    ].join("\n") + "\n",
  );
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      const sections = [
        { list: "now-list", taskId: "W1-T1", title: "now section target" },
        { list: "needs-me-list", taskId: "W1-T2", title: "needs me section target" },
        { list: "up-next-list", taskId: "W1-T3", title: "up next section target" },
        { list: "recent-list", taskId: "W1-T4", title: "recent section target" },
        { list: "rest-list", taskId: "W1-T5", title: "rest section target" },
      ];
      for (const s of sections) {
        await page.waitForFunction((sel) => !!document.querySelector(sel), `#${s.list} li[data-task-id="${s.taskId}"]`, { timeout: 5000 });
        // ONE click, on the row's own task-id, scoped to THIS section (rows can legitimately also
        // appear in the "everything else" FIND corpus, which searches the whole board -- scoping
        // to the section under test keeps each check unambiguous about which row fired). No prior
        // collapse needed -- clicking a DIFFERENT row's own affordance closes whatever else was open.
        await page.click(`#${s.list} li[data-task-id="${s.taskId}"] .task-id`);
        await page.waitForFunction(
          (sel) => document.querySelector(sel)?.getAttribute("aria-expanded") === "true",
          `#${s.list} li[data-task-id="${s.taskId}"]`,
          { timeout: 5000 },
        );
        await page.waitForFunction(
          (t) => (document.querySelector(".row-detail")?.textContent ?? "").includes(t),
          s.title,
          { timeout: 5000 },
        );
      }
    } finally {
      await context.close();
    }
  });
});

// ── (4) ANOMALY FLAG: a per-phase elapsed threshold, exceeded => the row is VISUALLY marked --
// thresholds are DATA (ServeDeps.phaseElapsedThresholdsMs), never a hard-coded constant. ────────

test("anomaly flag: a row past its per-phase elapsed threshold is visually marked (icon + text, not colour alone); a row under it is not", async () => {
  const root = tmpRoot();

  // Fixture A: the threshold data source is overridden to 0ms -- ANY positive elapsed is anomalous.
  const anomalousRoot = tmpRoot();
  const anomalousDeps = fixtureDeps(anomalousRoot, [task({ id: "W1-T1" })], { phaseElapsedThresholdsMs: { recon: 0, default: 0 } });
  appendFileSync(anomalousDeps.board.ledgerPath, runStart("W1-T1"));
  await withShell(anomalousDeps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => (document.querySelector("#now-list .detail")?.textContent ?? "").includes("phase: recon"));
      // a moment for elapsedMs to tick past the (zero) threshold and for tickElapsed's own 1s
      // interval to re-evaluate it -- poll rather than a fixed sleep (flake precedent: W1-T136).
      await page.waitForFunction(() => document.querySelector('#now-list li[data-task-id="W1-T1"]')?.classList.contains("anomaly"), null, { timeout: 4000 });
      const marked = await page.evaluate(() => {
        const row = document.querySelector('#now-list li[data-task-id="W1-T1"]');
        const flag = row?.querySelector(".anomaly-flag") as HTMLElement | null;
        return {
          rowHasClass: row?.classList.contains("anomaly") ?? false,
          flagVisible: flag ? !flag.hidden : false,
          flagText: flag?.textContent ?? "",
        };
      });
      assert.equal(marked.rowHasClass, true, "the row itself must carry a non-colour-only '.anomaly' marker class");
      assert.equal(marked.flagVisible, true, "the anomaly text/icon marker must be visible, not merely a colour change");
      assert.match(marked.flagText, /\S/, "the anomaly marker must carry real text/glyph content, not rely on colour alone");
    } finally {
      await context.close();
    }
  });

  // Fixture B: SAME shape, DEFAULT (large) thresholds -- a freshly-started run must NOT be flagged.
  const healthyDeps = fixtureDeps(root, [task({ id: "W1-T2" })]); // no override -> DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS
  assert.ok(DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS.recon > 60_000, "sanity: the default recon threshold is well above a fresh run's elapsed");
  appendFileSync(healthyDeps.board.ledgerPath, runStart("W1-T2"));
  await withShell(healthyDeps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => (document.querySelector("#now-list .detail")?.textContent ?? "").includes("phase: recon"));
      // let a tick pass so the same code path that flags fixture A has had a chance to run here.
      await page.waitForTimeout(1200);
      const unmarked = await page.evaluate(() => {
        const row = document.querySelector('#now-list li[data-task-id="W1-T2"]');
        const flag = row?.querySelector(".anomaly-flag") as HTMLElement | null;
        return { rowHasClass: row?.classList.contains("anomaly") ?? false, flagVisible: flag ? !flag.hidden : false };
      });
      assert.equal(unmarked.rowHasClass, false, "a fresh run under its (default, DATA-sourced) threshold must not be flagged");
      assert.equal(unmarked.flagVisible, false);
    } finally {
      await context.close();
    }
  });
});

// ── (4b) the LITERAL falsifier fixture, updated for a CORRECT liveness verdict: "W1-T1 rendering
// in NOW at 27h21m" -- but backed by a genuinely still-OPEN PR (so W1-T179's liveness bound does
// not exclude it from "running" at all; that bound is a SEPARATE concern this task's own design
// note is explicit about: "the liveness bound is W1-T179's job... the visual FLAG is this task's").
// Under DEFAULT thresholds (no override), this must render visibly distinct from a run started a
// minute ago -- the exact pair the falsifier says looked "identical". ──────────────────────────

test("anomaly flag: a genuinely still-running task at 27h21m elapsed (open PR, DEFAULT thresholds) renders visibly distinct from a run started a minute ago", async () => {
  const root = tmpRoot();
  const byRef: Record<string, PrRef> = { "https://github.com/o/r/pull/1": { number: 1, url: "https://github.com/o/r/pull/1", state: "OPEN" } };
  const deps = fixtureDeps(root, [task({ id: "W1-T1" }), task({ id: "W1-T2" })], { github: fakeGitHub(byRef) });
  const twentySevenH21mAgo = new Date(Date.now() - (27 * 60 + 21) * 60 * 1000).toISOString();
  appendFileSync(
    deps.board.ledgerPath,
    [
      JSON.stringify({ ts: twentySevenH21mAgo, run_id: "W1-T1-1", task_id: "W1-T1", step: "run.start" }),
      JSON.stringify({ ts: twentySevenH21mAgo, run_id: "W1-T1-1", task_id: "W1-T1", step: "pr.opened", pr_url: "https://github.com/o/r/pull/1" }),
    ].join("\n") + "\n",
  );
  appendFileSync(deps.board.ledgerPath, runStart("W1-T2")); // a run that "started a minute ago" (fresh)
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => document.querySelectorAll("#now-list li[data-key]").length === 2);
      await page.waitForFunction(() => document.querySelector('#now-list li[data-task-id="W1-T1"]')?.classList.contains("anomaly"), null, { timeout: 4000 });
      // NOTE: no nested helper function with a TS type annotation inside this evaluate callback --
      // tsx/esbuild's `__name` naming helper can leak into that inner function's serialized
      // source (Playwright ships `fn.toString()` alone to the browser), which then throws
      // "__name is not defined" in the isolated page context. Two flat, separate reads instead.
      const stale = await page.evaluate(() => {
        const row = document.querySelector('#now-list li[data-task-id="W1-T1"]');
        const flag = row ? row.querySelector(".anomaly-flag") : null;
        return { anomaly: row ? row.classList.contains("anomaly") : false, flagVisible: flag ? !(flag as HTMLElement).hidden : false };
      });
      const fresh = await page.evaluate(() => {
        const row = document.querySelector('#now-list li[data-task-id="W1-T2"]');
        const flag = row ? row.querySelector(".anomaly-flag") : null;
        return { anomaly: row ? row.classList.contains("anomaly") : false, flagVisible: flag ? !(flag as HTMLElement).hidden : false };
      });
      assert.equal(stale.anomaly, true, "a genuinely-running task at 27h21m elapsed must be flagged anomalous");
      assert.equal(stale.flagVisible, true);
      assert.equal(fresh.anomaly, false, "a run started a minute ago must NOT be flagged -- the two must render visibly distinct");
      assert.equal(fresh.flagVisible, false);
    } finally {
      await context.close();
    }
  });
});
