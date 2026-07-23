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

// ── W1-T222: DOM-STABILITY REACHES INTO EXPANSIONS -- a background poll/SSE update must not
// collapse an OPEN inline card, steal focus from inside it, or destroy a selection inside it,
// even when the update lands on the SAME list the open card's row lives in. W1-T156's doctrine
// (the test directly above) extended, per this task's own design note: "the mechanism should be
// extended, not reinvented beside it." ──────────────────────────────────────────────────────────

test("W1-T222: a background update to a DIFFERENT row in the same list does not collapse an open card, steal focus from inside it, or destroy a selection inside it", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" }), task({ id: "W1-T2" })]);
  appendFileSync(deps.board.ledgerPath, runStart("W1-T1"));
  appendFileSync(deps.board.ledgerPath, runStart("W1-T2"));
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => document.querySelectorAll("#now-list li[data-key]").length === 2);

      // Open W1-T1's card, focus a control INSIDE it, and select text inside its title.
      await page.click('#now-list li[data-key="W1-T1"] .task-id');
      await page.waitForFunction(
        () => document.querySelector('#now-list li[data-key="W1-T1"]')?.getAttribute("aria-expanded") === "true",
      );
      await page.waitForFunction(() => (document.querySelector(".row-detail-title")?.textContent ?? "").length > 0);
      await page.evaluate(() => {
        document.querySelector(".row-detail")!.setAttribute("data-test-mark", "open-card");
        (document.querySelector(".card-journey-toggle") as HTMLElement)!.focus();
        const target = document.querySelector(".row-detail-title")!;
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
      });
      const focusedBefore = await page.evaluate(() => document.activeElement?.className);
      assert.equal(focusedBefore, "card-journey-toggle");

      // Background update: flip W1-T2's phase -- a DIFFERENT row in the SAME #now-list, so
      // renderNow/reconcileRows runs its full pass over the list W1-T1's open card lives in.
      appendFileSync(deps.board.ledgerPath, reconDone("W1-T2"));
      await page.waitForFunction(
        () => (document.querySelector('#now-list li[data-key="W1-T2"] .detail')?.textContent ?? "").includes("phase: implement"),
        null,
        { timeout: 5000 },
      );

      const after = await page.evaluate(() => ({
        expanded: document.querySelector('#now-list li[data-key="W1-T1"]')?.getAttribute("aria-expanded"),
        cardMark: document.querySelector(".row-detail")?.getAttribute("data-test-mark"),
        cardCount: document.querySelectorAll(".row-detail").length,
        focused: document.activeElement?.className,
        selection: window.getSelection()?.toString(),
        selectionConnected: window.getSelection()?.anchorNode?.isConnected ?? false,
      }));
      assert.equal(after.expanded, "true", "a background update elsewhere must never collapse an open card");
      assert.equal(after.cardMark, "open-card", "the open card must be the SAME DOM node, not recreated");
      assert.equal(after.cardCount, 1);
      assert.equal(after.focused, "card-journey-toggle", "focus inside the open card must survive the update");
      assert.match(after.selection ?? "", /^W1-T1/, "a selection inside the open card must survive the update");
      assert.equal(after.selectionConnected, true);
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

// ── W1-T189 FOLLOW-UP (rule 21): T156's own criterion 4 was certified pre-#414 by keyword
// coverage and never actually executed against a real browser client -- these are the bars an
// operator screenshot proved it missed. Deliberately seeded (route.abort()/a hung route), never a
// real slow server, so the fix is verifiable with W1-T187's latency defect still present. ────────

test("poll failures alongside a healthy SSE connection: staleness is gated on genuine data freshness, not a blind failure tally -- freshness and the stale escalation must never contradict", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]);
  await withShell(deps, async (base) => {
    const context = await browser.newContext();
    // /v1/status (the REST poll) is broken for the WHOLE test -- but /v1/status/stream (SSE) is
    // left alone, so a genuine ledger change still reaches the client via the OTHER transport.
    await context.route("**/v1/status", (route) => route.abort());
    const page = await context.newPage();
    try {
      await page.goto(`${base}/?token=${READ_TOKEN}`);
      await page.waitForFunction(() => document.getElementById("top-status")?.getAttribute("data-poll-state") === "reconnecting", null, {
        timeout: 5000,
      });

      // a real SSE delta lands almost immediately -- the board's DATA is genuinely fresh even
      // though the /v1/status poll keeps failing outright.
      appendFileSync(deps.board.ledgerPath, runStart("W1-T1"));
      await page.waitForFunction(() => (document.querySelector("#now-list .detail")?.textContent ?? "").includes("phase: recon"), null, {
        timeout: 5000,
      });

      // Past the ORIGINAL 3-consecutive-failure threshold (~9s at the 3s poll cadence) -- pre-fix,
      // a blind failure tally alone flips pollState to "stale" here regardless of the SSE delta
      // that just landed. With genuinely fresh data on screen, it must NOT -- the freshness stamp
      // and the stale escalation must read the SAME clock (the operator-observed contradiction:
      // "live · updated 8s ago" directly above "STALE — showing last known data").
      await new Promise((resolve) => setTimeout(resolve, 8500));
      const midway = await page.evaluate(() => ({
        pollState: document.getElementById("top-status")?.getAttribute("data-poll-state"),
        staleHidden: (document.getElementById("stale-badge") as HTMLElement)?.hidden,
      }));
      assert.notEqual(midway.pollState, "stale", "an SSE delta just landed -- a raw consecutive-failure count must not override that with a contradicting STALE claim");
      assert.equal(midway.staleHidden, true);

      // ... and once THAT data genuinely goes stale too (no further SSE, the poll still failing),
      // the escalation must still eventually fire -- this proves a freshness GATE, not a disabled
      // (always-false) staleness check.
      await page.waitForFunction(() => document.getElementById("top-status")?.getAttribute("data-poll-state") === "stale", null, { timeout: 8000 });
    } finally {
      await context.close();
    }
  });
});

test("a /v1/status fetch that hangs (never resolves -- W1-T187's real 35-58s stall, seeded here) lands in the SAME reconnecting lifecycle as an HTTP error, and never leaks a raw exception string", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root, [task({ id: "W1-T1" })]), async (base) => {
    const context = await browser.newContext();
    // deliberately never call route.continue()/fulfill()/abort() -- the request is reachable but
    // never settles, distinct from a network error (abort) or an HTTP error response.
    await context.route("**/v1/status", () => {});
    const page = await context.newPage();
    try {
      await page.goto(`${base}/?token=${READ_TOKEN}`);
      // must land in the SAME "reconnecting" lifecycle within a bounded time -- never hang
      // indefinitely waiting on a request that (per W1-T187) would not return for 35-58 REAL
      // seconds, and never leave the header on its initial "loading…" text with no verdict at all.
      await page.waitForFunction(() => document.getElementById("top-status")?.getAttribute("data-poll-state") === "reconnecting", null, {
        timeout: 12000,
      });
      const text = await page.textContent("#top-status");
      assert.doesNotMatch(text ?? "", /TypeError|Failed to fetch|\[object/i, "no raw exception vocabulary reaches the operator");
      assert.match(text ?? "", /reconnecting/);
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

// ── (7) W1-T182: NEEDS ME renders the affordance an ESCALATION actually supports -- a direct
// link + "mark handled", never an Approve button/URL-soliciting input -- and a CLOSED escalation
// (live state, not ledger history) drops out of the section entirely ─────────────────────────

/** A GitHub gateway whose issue state is mutable via `close()` -- lets a test prove a live
 *  "mark handled" click (which calls the SAME `IssueCloser.close`) actually clears the row on
 *  the NEXT poll, rather than merely asserting the button posts somewhere. */
function stubEscalationGithub(issueUrl: string, initialState: string, title: string): { github: GitHub; issues: IssueCloser } {
  const state = { value: initialState };
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    issueByUrl: (url) => (url === issueUrl ? { state: state.value, title } : null),
  };
  const issues: IssueCloser = {
    close(url) {
      if (url === issueUrl) state.value = "CLOSED";
    },
  };
  return { github, issues };
}

test("W1-T182: an escalation row renders the issue's real ask + a direct link + 'Mark handled' -- NO Approve control, NO URL input", async () => {
  const root = tmpRoot();
  const issueUrl = "https://github.com/o/r/issues/393";
  const { github, issues } = stubEscalationGithub(issueUrl, "OPEN", "[BLOCKED] W1-T1: needs a decision");
  const deps = { ...fixtureDeps(root, [task({ id: "W1-T1" })], github), issues };
  const ledgerPath = deps.board.ledgerPath;
  appendFileSync(
    ledgerPath,
    JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "run.start" }) + "\n",
  );
  appendFileSync(
    ledgerPath,
    JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" }) + "\n",
  );
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => (document.getElementById("needs-me-list")?.textContent ?? "").includes("needs a decision"));
      const row = await page.evaluate(() => {
        const li = document.querySelector("#needs-me-list li");
        return {
          text: li?.textContent ?? "",
          hasApproveButton: Array.from(li?.querySelectorAll("button") ?? []).some((b) => b.textContent?.trim() === "Approve"),
          hasUrlInput: (li?.querySelectorAll('input[type="url"]').length ?? 0) > 0,
          viewIssueHref: li?.querySelector("a")?.getAttribute("href"),
          hasMarkHandled: Array.from(li?.querySelectorAll("button") ?? []).some((b) => b.textContent?.trim() === "Mark handled"),
        };
      });
      assert.match(row.text, /needs a decision/, "the row shows the issue's ACTUAL one-line ask, not a generic label");
      assert.equal(row.hasApproveButton, false, "Approve has no defined verb for an escalation -- it must never render here");
      assert.equal(row.hasUrlInput, false, "the ledger already holds the issue_url -- never solicit it from the operator");
      assert.equal(row.viewIssueHref, issueUrl, "a DIRECT link to the issue");
      assert.equal(row.hasMarkHandled, true);
    } finally {
      await context.close();
    }
  });
});

// ── W1-T223: a collapsed console section must still inform -- its header summary must NEVER
// disagree with its own rows (the count comes from the SAME projection, never a second
// derivation), and a NEEDS ME arrival while collapsed must carry emphasis, never a silent miss ──

test("W1-T223: a section's header summary NEVER disagrees with its own rows across a live SSE update -- the claimed count always matches the rendered row count", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" }), task({ id: "W1-T2" })]);
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => (document.getElementById("now-summary")?.textContent ?? "") !== "…");
      async function agrees() {
        return page.evaluate(() => {
          const summary = document.getElementById("now-summary")?.textContent ?? "";
          const rowCount = document.querySelectorAll("#now-list li[data-key]").length;
          const m = /^(\d+) running/.exec(summary);
          const claimed = m ? Number(m[1]) : summary.includes("nothing in flight") ? 0 : NaN;
          return { claimed, rowCount, summary };
        });
      }

      let a = await agrees();
      assert.equal(a.claimed, a.rowCount, `header claims ${a.claimed} but rows show ${a.rowCount} ("${a.summary}")`);
      assert.equal(a.rowCount, 0);

      appendFileSync(deps.board.ledgerPath, runStart("W1-T1"));
      await page.waitForFunction(() => (document.querySelector("#now-list .detail")?.textContent ?? "").includes("phase:"));
      a = await agrees();
      assert.equal(a.claimed, a.rowCount, `header claims ${a.claimed} but rows show ${a.rowCount} ("${a.summary}")`);
      assert.equal(a.rowCount, 1);

      appendFileSync(deps.board.ledgerPath, runStart("W1-T2", "r2"));
      await page.waitForFunction(() => document.querySelectorAll("#now-list li[data-key]").length === 2);
      a = await agrees();
      assert.equal(a.claimed, a.rowCount, `header claims ${a.claimed} but rows show ${a.rowCount} ("${a.summary}")`);
      assert.equal(a.rowCount, 2);
    } finally {
      await context.close();
    }
  });
});

test("W1-T223: a NEEDS ME item arriving while the section is collapsed adds header emphasis -- never a forced reopen, never a silent miss", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]); // no escalation yet -- NEEDS ME starts empty, defaults collapsed
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => document.getElementById("needs-me-toggle")?.getAttribute("aria-expanded") === "false");
      assert.equal(
        await page.evaluate(() => document.getElementById("needs-me-toggle")?.classList.contains("section-emphasis")),
        false,
        "no emphasis before anything has arrived",
      );

      appendFileSync(
        deps.board.ledgerPath,
        JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "escalation.issue_opened", issue_url: "https://github.com/o/r/issues/1", class: "BLOCKED" }) + "\n",
      );
      await page.waitForFunction(() => document.getElementById("needs-me-toggle")?.classList.contains("section-emphasis") === true, null, {
        timeout: 5000,
      });
      // the falsifier this proves: collapsing must never become a way to silently miss the item --
      // but the fix is EMPHASIS, never a forced reopen the operator didn't ask for.
      assert.equal(await page.evaluate(() => document.getElementById("needs-me-toggle")?.getAttribute("aria-expanded")), "false");
      assert.equal(await page.evaluate(() => (document.getElementById("needs-me-body") as HTMLElement)?.hidden), true);

      await page.click("#needs-me-toggle");
      await page.waitForFunction(() => document.getElementById("needs-me-toggle")?.getAttribute("aria-expanded") === "true");
      assert.equal(
        await page.evaluate(() => document.getElementById("needs-me-toggle")?.classList.contains("section-emphasis")),
        false,
        "expanding the section clears the emphasis -- the operator has now seen it",
      );
    } finally {
      await context.close();
    }
  });
});

test("W1-T182: clicking 'Mark handled' closes the issue via the real route, and the row drops off the NEXT poll once the issue reads CLOSED", async () => {
  const root = tmpRoot();
  const issueUrl = "https://github.com/o/r/issues/401";
  const { github, issues } = stubEscalationGithub(issueUrl, "OPEN", "[HARD_STOP] W1-T1: force-push attempted");
  const deps = { ...fixtureDeps(root, [task({ id: "W1-T1" })], github), issues };
  appendFileSync(
    deps.board.ledgerPath,
    JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "escalation.issue_opened", issue_url: issueUrl, class: "HARD_STOP" }) + "\n",
  );
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base, { token: WRITE_TOKEN });
    try {
      await page.waitForFunction(() => (document.getElementById("needs-me-list")?.textContent ?? "").includes("force-push"));
      await page.click("#needs-me-list button:has-text('Mark handled')");
      await page.waitForFunction(() => (document.getElementById("needs-me-list")?.textContent ?? "").includes("nothing needs you"), null, {
        timeout: 5000,
      });
    } finally {
      await context.close();
    }
  });
});

// ── W1-T200 SKELETON LIFECYCLE (rule-21 follow-up to the merged W1-T154, retested here rather
// than as an amendment per standing rule 21): a section is in exactly one of PRE-FIRST-DATA
// (skeleton), HAS-DATA (exactly the rows), or HAS-DATA-EMPTY (an honest empty message) — never
// skeleton markup coexisting with either. FALSIFIER, operator screenshots 2026-07-21 04:52: NOW,
// NEEDS ME and RECENT each rendered real rows sitting ABOVE perpetually-animating skeleton
// placeholders left over from the very first paint. NOTE: GET /v1/status/stream primes its own
// "last known" baseline silently on connect (board.ts's buildStatusStream) and sends nothing
// until a LATER ledger append — so the very first data a client ever paints comes from the GET
// /v1/status poll alone, making that poll's response the one seam to hold open below.
const SKELETON_SECTIONS = [
  { list: "now-list", emptyText: "nothing in flight" },
  { list: "needs-me-list", emptyText: "nothing needs you right now" },
  { list: "recent-list", emptyText: "no recent activity yet" },
];

test("skeleton lifecycle: NOW/NEEDS ME/RECENT show ONLY their first-paint skeleton before the first poll resolves, and the skeleton is fully gone (zero nodes) once real data lands -- never both at once, in either the has-data or has-data-empty outcome", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]);
  appendFileSync(deps.board.ledgerPath, runStart("W1-T1")); // NOW gets real data; NEEDS ME/RECENT stay empty
  await withShell(deps, async (base) => {
    const context = await browser.newContext();
    let releaseFirstPoll = () => {};
    const firstPollHeld = new Promise<void>((resolve) => (releaseFirstPoll = resolve));
    let firstRequestSeen = false;
    await context.route("**/v1/status", async (route) => {
      if (!firstRequestSeen) {
        firstRequestSeen = true;
        await firstPollHeld; // hold the FIRST poll response open so the pre-data DOM is inspectable
      }
      await route.continue();
    });
    const page = await context.newPage();
    try {
      await page.goto(`${base}/?token=${READ_TOKEN}`);

      // PRE-FIRST-DATA: the static skeleton the shell ships in its initial HTML, and ONLY that --
      // no data-key rows, no empty-state message, in any of the three sections yet.
      const preData = await page.evaluate(
        (sections) =>
          sections.map(({ list }) => {
            const el = document.getElementById(list)!;
            return {
              list,
              skeletons: el.querySelectorAll(".skeleton, .skeleton-bar").length,
              dataRows: el.querySelectorAll("li[data-key]").length,
              emptyMarkers: el.querySelectorAll("li.empty").length,
            };
          }),
        SKELETON_SECTIONS,
      );
      for (const s of preData) {
        assert.ok(s.skeletons > 0, `${s.list} must show its skeleton before the first poll resolves`);
        assert.equal(s.dataRows, 0, `${s.list} must not show data rows before the first poll resolves`);
        assert.equal(s.emptyMarkers, 0, `${s.list} must not show the empty-state message before the first poll resolves`);
      }

      releaseFirstPoll();
      await page.waitForFunction(() => (document.querySelector("#now-list .detail")?.textContent ?? "").includes("phase: recon"));
      await page.waitForFunction(() => (document.getElementById("needs-me-list")?.textContent ?? "").includes("nothing needs you"));
      await page.waitForFunction(() => (document.getElementById("recent-list")?.textContent ?? "").includes("no recent activity"));

      // POST-FIRST-DATA: zero skeleton nodes remain, in EITHER the has-data (NOW) or the
      // has-data-empty (NEEDS ME, RECENT) outcome -- and the section is EXACTLY one or the other,
      // never both a real/empty marker AND a leftover skeleton.
      const postData = await page.evaluate(
        (sections) =>
          sections.map(({ list, emptyText }) => {
            const el = document.getElementById(list)!;
            return {
              list,
              skeletons: el.querySelectorAll(".skeleton, .skeleton-bar").length,
              children: el.children.length,
              isHonestEmpty: el.children.length === 1 && el.firstElementChild?.classList.contains("empty") && el.firstElementChild?.textContent === emptyText,
              hasDataRow: el.querySelectorAll("li[data-key]").length,
            };
          }),
        SKELETON_SECTIONS,
      );
      const [now, needsMe, recent] = postData;
      for (const s of postData) {
        assert.equal(s.skeletons, 0, `${s.list} must have ZERO skeleton nodes once its first successful render lands`);
      }
      assert.equal(now.hasDataRow, 1, "NOW received real data -- exactly one data row, no skeleton, no empty marker");
      assert.equal(now.children, 1, "NOW's list must contain ONLY the one real row -- no residual skeleton siblings");
      assert.ok(needsMe.isHonestEmpty, "NEEDS ME's empty successful result must render the honest empty message, not a skeleton");
      assert.ok(recent.isHonestEmpty, "RECENT's empty successful result must render the honest empty message, not a skeleton");
    } finally {
      await context.close();
    }
  });
});

test("skeleton lifecycle: an EMPTY successful poll (no in-flight tasks, no escalations, no recent activity) renders the honest empty message in every section, never a leftover skeleton", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]); // queued, never started -- no ledger activity at all
  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      const state = await page.evaluate(
        (sections) =>
          sections.map(({ list, emptyText }) => {
            const el = document.getElementById(list)!;
            return {
              list,
              skeletons: el.querySelectorAll(".skeleton, .skeleton-bar").length,
              isHonestEmpty: el.children.length === 1 && el.firstElementChild?.classList.contains("empty") && el.firstElementChild?.textContent === emptyText,
            };
          }),
        SKELETON_SECTIONS,
      );
      for (const s of state) {
        assert.equal(s.skeletons, 0, `${s.list} must have zero skeleton nodes once its (empty) first successful render lands`);
        assert.ok(s.isHonestEmpty, `${s.list} must render its honest empty message, not fall back to skeletons`);
      }
    } finally {
      await context.close();
    }
  });
});
