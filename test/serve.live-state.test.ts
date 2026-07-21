// test/serve.live-state.test.ts — W1-T156 (live-state UI + TRUST), the acceptance bars that can
// only be proven against a REAL browser client (learnings#probe-must-exercise-the-real-
// consuming-client). This is the UI+TRUST half of the live-state layer (W1-T153's shell + the
// StatusProjection fields already flowing today: phase/startedAt/elapsedMs/needsHuman/
// armedAwaitingMerge/indeterminate — verified from src/lib/status.ts before writing this suite).
//
// SCOPE NOTE (recorded in this task's own PR body): W1-T155 ("live-state DATA... MONOTONIC under
// darkness... github_unobservable") is listed as this task's dependency but is NOT actually
// implemented in src/lib/status.ts as of this PR — derivePrPrecedence's failed-read fallback
// still regresses a task to `status: "queued"` on a GitHub read failure rather than retaining a
// last-good status. This suite (and the shell) deliberately do NOT touch status.ts/board.ts
// (outside this task's own file scope, src/lib/serve.ts) — the "GitHub unreachable" stamp below
// is keyed off the EXISTING per-task `indeterminate`/`source:"throttled"` signal (W1-T119), which
// is real data already flowing, and the suite proves exactly that: the banner appears/clears
// correctly off today's data, not a claim that the upstream regression-to-queued bug is fixed.
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

const READ_TOKEN = "live-state-read-token";
const WRITE_TOKEN = "live-state-write-token";

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

/** A GitHub gateway whose `readFailed()` answer is toggled live by the test (via `state`) — backs
 *  the "GitHub unreachable" banner test without needing a real throttled `gh` call. */
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
  return mkdtempSync(join(tmpdir(), "rmd-live-state-"));
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
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github },
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

function runStart(taskId: string, runId = "r1"): string {
  return JSON.stringify({ ts: new Date().toISOString(), run_id: runId, task_id: taskId, step: "run.start" }) + "\n";
}
function reconDone(taskId: string, runId = "r1"): string {
  return JSON.stringify({ ts: new Date().toISOString(), run_id: runId, task_id: taskId, step: "recon.done" }) + "\n";
}

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});
after(async () => {
  await browser.close();
});

async function openShell(base: string, opts: { reducedMotion?: boolean; token?: string } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  if (opts.reducedMotion) await context.grantPermissions([]);
  const page = await context.newPage();
  if (opts.reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${base}/?token=${opts.token ?? READ_TOKEN}`);
  await page.waitForFunction(() => !document.getElementById("top-status")?.textContent?.includes("loading"));
  return { context, page };
}

// ── (1) in-flight-with-phase within one SSE tick, live-ticking elapsed, in-place highlight ────

test("dispatched run: in-flight-with-phase renders, elapsed ticks live, and an SSE flip transitions the SAME row in place with a highlight", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]);
  appendFileSync(deps.board.ledgerPath, runStart("W1-T1"));
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => (document.querySelector("#now-list .detail")?.textContent ?? "").includes("phase: recon"));

      // elapsed ticks live -- a live-updating text node, not a one-shot value frozen at render.
      // tickElapsed() fires off a 1s setInterval that starts at page load, not at this read, so a
      // FIXED sleep can straddle zero interval firings depending on phase alignment (flaky under
      // CI/runner jitter -- W1-T136 round-1 fixture). Poll until the text actually changes instead
      // of asserting after one arbitrary wall-clock window.
      const elapsedAt = async () => page.evaluate(() => document.querySelector("#now-list .elapsed")?.textContent ?? "");
      const first = await elapsedAt();
      await page
        .waitForFunction((prev) => (document.querySelector("#now-list .elapsed")?.textContent ?? "") !== prev, first, { timeout: 4000 })
        .catch(() => null);
      const second = await elapsedAt();
      assert.notEqual(first, second, `elapsed must tick live -- was "${first}" for the full 4s poll window`);

      // stamp the row so we can prove the SSE flip below updates it IN PLACE, not by replacement.
      await page.evaluate(() => document.querySelector("#now-list li")?.setAttribute("data-test-mark", "same-node"));

      // an SSE flip (a real ledger append -- the daemon-side SSE stream picks it up within one poll tick)
      appendFileSync(deps.board.ledgerPath, reconDone("W1-T1"));
      await page.waitForFunction(() => (document.querySelector("#now-list .detail")?.textContent ?? "").includes("phase: implement"), null, {
        timeout: 5000,
      });

      const mark = await page.evaluate(() => document.querySelector("#now-list li")?.getAttribute("data-test-mark"));
      assert.equal(mark, "same-node", "the flipped row must be the SAME <li> node, patched in place -- not a re-created one");

      const flashed = await page.waitForFunction(() => document.querySelector("#now-list li.flash") !== null, null, { timeout: 2000 }).catch(() => null);
      assert.ok(flashed, "a genuine flip must apply a brief in-place highlight ('.flash')");
    } finally {
      await context.close();
    }
  });
});

// ── (5) DOM-stability + selection: an unrelated unchanged row keeps its node AND an active
// selection inside it survives a background update to a DIFFERENT row ─────────────────────────

test("update cycle: an unchanged row keeps DOM identity, and an active text selection inside it survives a background update elsewhere", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" }), task({ id: "W1-T2" })]);
  appendFileSync(deps.board.ledgerPath, runStart("W1-T1"));
  appendFileSync(deps.board.ledgerPath, runStart("W1-T2"));
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => document.querySelectorAll("#now-list li[data-key]").length === 2);

      // Mark BOTH rows, then select text inside W1-T2's row (the one that will stay UNCHANGED).
      await page.evaluate(() => {
        document.querySelectorAll("#now-list li[data-key]").forEach((el) => el.setAttribute("data-test-mark", el.getAttribute("data-key") ?? ""));
        const target = document.querySelector('#now-list li[data-key="W1-T2"] .task-id');
        const range = document.createRange();
        range.selectNodeContents(target!);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
      });
      const selectedBefore = await page.evaluate(() => window.getSelection()?.toString());
      assert.equal(selectedBefore, "W1-T2");

      // Background update: flip ONLY W1-T1's phase.
      appendFileSync(deps.board.ledgerPath, reconDone("W1-T1"));
      await page.waitForFunction(() => (document.querySelector('#now-list li[data-key="W1-T1"] .detail')?.textContent ?? "").includes("phase: implement"), null, {
        timeout: 5000,
      });

      const state = await page.evaluate(() => ({
        t2Mark: document.querySelector('#now-list li[data-key="W1-T2"]')?.getAttribute("data-test-mark"),
        selection: window.getSelection()?.toString(),
        selectionConnected: window.getSelection()?.anchorNode?.isConnected ?? false,
      }));
      assert.equal(state.t2Mark, "W1-T2", "the UNCHANGED row's node must survive the update cycle (same node, not recreated)");
      assert.equal(state.selection, "W1-T2", "an active selection inside unchanged content must survive a background update");
      assert.equal(state.selectionConnected, true);
    } finally {
      await context.close();
    }
  });
});

// ── (3) prefers-reduced-motion: a static badge, no animation; status changes are announced ────

test("prefers-reduced-motion: the animated live indicator is replaced by a static badge, and a status flip is announced via aria-live", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]);
  appendFileSync(deps.board.ledgerPath, runStart("W1-T1"));
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base, { reducedMotion: true });
    try {
      await page.waitForFunction(() => (document.querySelector("#now-list .detail")?.textContent ?? "").includes("phase: recon"));
      const indicator = await page.evaluate(() => ({
        static: document.querySelectorAll("#now-list .live-badge-static").length,
        animated: document.querySelectorAll("#now-list .live-indicator").length,
      }));
      assert.equal(indicator.animated, 0, "no animated live-indicator under prefers-reduced-motion");
      assert.equal(indicator.static, 1, "a static badge must replace it under prefers-reduced-motion");

      appendFileSync(deps.board.ledgerPath, reconDone("W1-T1"));
      await page.waitForFunction(() => (document.getElementById("aria-announcer")?.textContent ?? "").includes("W1-T1"), null, { timeout: 5000 });
    } finally {
      await context.close();
    }
  });
});

// ── (2) SSE severed: the connection indicator flips VISIBLY, never keeps claiming "live" ───────

test("SSE stream severed: the connection indicator flips to disconnected -- never keeps claiming live", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root, [task({ id: "W1-T1" })]), async (base) => {
    const context = await browser.newContext();
    await context.route("**/v1/status/stream", (route) => route.abort());
    const page = await context.newPage();
    try {
      await page.goto(`${base}/?token=${READ_TOKEN}`);
      await page.waitForFunction(() => document.getElementById("connection-indicator")?.getAttribute("data-state") === "disconnected", null, {
        timeout: 5000,
      });
      const text = await page.textContent("#connection-indicator");
      assert.match(text ?? "", /disconnected/);
      assert.doesNotMatch(text ?? "", /^\s*live\s*$/);
    } finally {
      await context.close();
    }
  });
});

// ── (4) poll error-state lifecycle: transient "reconnecting" -> N-failure escalation to stale
// -> cleared unconditionally by the next success (never a latched banner beside fresh data) ────

test("poll failures: a transient 'reconnecting' indicator, escalating to a visibly-stamped-stale board after consecutive failures, cleared by the next success", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root, [task({ id: "W1-T1" })]), async (base) => {
    const context = await browser.newContext();
    let shouldFail = true;
    await context.route("**/v1/status", (route) => (shouldFail ? route.abort() : route.continue()));
    const page = await context.newPage();
    try {
      await page.goto(`${base}/?token=${READ_TOKEN}`);

      // Attempt 1 fails immediately (< the 3-failure escalation threshold): TRANSIENT only --
      // never a persistent error banner, and the board is NOT (yet) stamped stale.
      await page.waitForFunction(() => document.getElementById("top-status")?.getAttribute("data-poll-state") === "reconnecting", null, {
        timeout: 5000,
      });
      const midway = await page.evaluate(() => ({
        text: document.getElementById("top-status")?.textContent ?? "",
        staleHidden: (document.getElementById("stale-badge") as HTMLElement)?.hidden,
      }));
      assert.match(midway.text, /reconnecting/);
      assert.equal(midway.staleHidden, true, "under the escalation threshold the board must not (yet) be stamped stale");

      // Let it keep failing until escalation (3 consecutive failures -> visibly stale).
      await page.waitForFunction(() => document.getElementById("top-status")?.getAttribute("data-poll-state") === "stale", null, { timeout: 12000 });
      const escalated = await page.evaluate(() => ({
        staleHidden: (document.getElementById("stale-badge") as HTMLElement)?.hidden,
        dataStale: document.getElementById("top-status")?.getAttribute("data-stale"),
      }));
      assert.equal(escalated.staleHidden, false, "N consecutive failures must visibly stamp the board stale");
      assert.equal(escalated.dataStale, "true");

      // The NEXT successful poll must clear it unconditionally -- never a stale banner surviving
      // beside fresh data (the operator-observed bug this lifecycle fixes).
      shouldFail = false;
      await page.waitForFunction(() => document.getElementById("top-status")?.getAttribute("data-poll-state") === "ok", null, { timeout: 8000 });
      const recovered = await page.evaluate(() => ({
        staleHidden: (document.getElementById("stale-badge") as HTMLElement)?.hidden,
        dataStale: document.getElementById("top-status")?.getAttribute("data-stale"),
        text: document.getElementById("top-status")?.textContent ?? "",
      }));
      assert.equal(recovered.staleHidden, true);
      assert.equal(recovered.dataStale, null);
      assert.match(recovered.text, /updated/);
      assert.doesNotMatch(recovered.text, /reconnecting|failed/);
    } finally {
      await context.close();
    }
  });
});

// ── (7) W1-T189: ONE liveness truth -- the freshness stamp must never say "fresh" while the
// stale banner is showing, even when the SSE stream keeps delivering real row deltas while the
// /v1/status poll itself is the thing failing (the exact operator-observed contradiction: "live ·
// updated 8s ago" directly above "STALE — showing last known data") ───────────────────────────

test("one liveness truth: an SSE row delta during a failing /v1/status poll does not reset the freshness stamp while the board is stale", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]);
  appendFileSync(deps.board.ledgerPath, runStart("W1-T1"));
  await withShell(deps, async (base) => {
    const context = await browser.newContext();
    await context.route("**/v1/status", (route) => route.abort());
    const page = await context.newPage();
    try {
      await page.goto(`${base}/?token=${READ_TOKEN}`);

      // Let /v1/status fail past the escalation threshold -- the board is now visibly stale.
      await page.waitForFunction(() => document.getElementById("top-status")?.getAttribute("data-poll-state") === "stale", null, {
        timeout: 12000,
      });

      // The SSE stream is NOT blocked -- it is still delivering real row deltas. Prove that first.
      appendFileSync(deps.board.ledgerPath, reconDone("W1-T1"));
      await page.waitForFunction(() => (document.querySelector("#now-list .detail")?.textContent ?? "").includes("phase: implement"), null, {
        timeout: 5000,
      });
      // tickFreshness() repaints #freshness on its own 1s setInterval, independent of the SSE
      // delta just applied -- wait past one tick so the DOM has actually caught up to whatever
      // the delta touched, rather than reading a stale pre-tick #freshness textContent that would
      // pass even on the buggy code by sheer timing luck.
      await page.waitForTimeout(1300);

      // The board is STILL stale (the /v1/status poll is still failing) -- the SSE delta above
      // must not have reset the freshness stamp to "just now". Both indicators must agree the
      // data is old, never one saying fresh while the other says stale.
      const after = await page.evaluate(() => ({
        pollState: document.getElementById("top-status")?.getAttribute("data-poll-state"),
        staleHidden: (document.getElementById("stale-badge") as HTMLElement)?.hidden,
        freshness: document.getElementById("freshness")?.textContent ?? "",
      }));
      assert.equal(after.pollState, "stale", "the poll is still failing -- the board must still read stale");
      assert.equal(after.staleHidden, false);
      assert.doesNotMatch(
        after.freshness,
        /just now|updated [01]s ago/,
        `an SSE delta must not make the freshness stamp claim fresh data while the board reads stale -- got "${after.freshness}"`,
      );
    } finally {
      await context.close();
    }
  });
});

// ── (8) W1-T189: a HANGING /v1/status (never resolves, never rejects on its own) must still
// land in the reconnecting lifecycle -- a timeout is a failure like any other, and this must be
// provable with a SEEDED slow fetch, never a real slow server (W1-T187 stays untouched) ─────────

test("a hanging /v1/status (never resolves) still lands in the reconnecting lifecycle -- a timeout is a failure", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root, [task({ id: "W1-T1" })]), async (base) => {
    const context = await browser.newContext();
    // Never call route.fulfill/continue/abort -- the request just hangs forever, exactly like
    // W1-T187's 35-58s /v1/status latency, but seeded rather than a real slow server.
    await context.route("**/v1/status", () => {});
    const page = await context.newPage();
    try {
      await page.goto(`${base}/?token=${READ_TOKEN}`);
      // Real wall-clock wait, generously past getJson's own FETCH_TIMEOUT_MS (10s) -- CI runs
      // many Playwright-driven test files concurrently in this suite, so this budget is wide
      // rather than tight against the production timeout.
      await page.waitForFunction(() => document.getElementById("top-status")?.getAttribute("data-poll-state") === "reconnecting", null, {
        timeout: 60000,
      });
      const state = await page.evaluate(() => document.getElementById("top-status")?.textContent ?? "");
      assert.match(state, /reconnecting/);
      assert.doesNotMatch(state, /TypeError|Failed to fetch|\[object/i, "a timeout must render the lifecycle's own vocabulary, never a raw exception");
    } finally {
      await context.close();
    }
  });
});

// ── (6) GitHub-gateway outage: a VISIBLE "GitHub unreachable since <t>" stamp, keyed off the
// existing per-task indeterminate/throttled signal (W1-T119) -- see this file's header for why
// this does NOT depend on W1-T155's not-yet-implemented monotonic/last-good mechanism ──────────

test("GitHub-gateway outage: the board is VISIBLY stamped 'GitHub unreachable since <t>', clearing on the next successful read", async () => {
  const root = tmpRoot();
  const ghState = { failed: true };
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })], flakyGitHub(ghState));
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => document.getElementById("gh-unreachable-banner")?.hidden === false, null, { timeout: 5000 });
      const shown = await page.textContent("#gh-unreachable-banner");
      assert.match(shown ?? "", /GitHub unreachable since/);

      ghState.failed = false;
      await page.waitForFunction(() => document.getElementById("gh-unreachable-banner")?.hidden === true, null, { timeout: 5000 });
    } finally {
      await context.close();
    }
  });
});
