// test/console-shell-client.test.ts — W1-T2902.
//
// lib/console-shell-client.ts moved ~3,755 lines of the console shell's DOM-driving client code
// (event wiring, fetch("/v1/…") calls, DOM rendering) out of a raw string inside
// `renderShellHtml`'s template literal and into a real, exported, directly-callable function --
// `bootConsoleShellClient` -- spliced back into the served page through ONE named seam,
// `consoleShellClientSource`. This file has two jobs:
//
//   (1) prove the SEAM itself is well-formed: it embeds the real `bootConsoleShellClient` body,
//       the caller-supplied thresholds, and the real `resolveFreshness` — and what it produces
//       is valid, parseable JavaScript. No browser needed for this half.
//
//   (2) prove `bootConsoleShellClient` is exercised DIRECTLY under the same DOM harness every
//       other shell suite uses (Playwright/headless Chromium — learnings#probe-must-exercise-
//       the-real-consuming-client: a browser NAVIGATION, not a regex-extracted/eval'd stand-in).
//       Because `consoleShellClientSource` slices its text verbatim from THIS module's own real
//       function (see that file's header), a page served by `renderShellHtml` runs the EXACT
//       function this file imports — never a second, drifting copy.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { test as nodeTest } from "node:test";
import { BROWSER_SKIP, browserTest as test } from "./browser-absence.js";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { bootConsoleShellClient, consoleShellClientSource } from "../src/lib/console-shell-client.js";
import { resolveFreshness } from "../src/lib/console-freshness.js";
import { shellBootReady } from "./setup/open-shell.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

// ── (1) the seam itself, no browser required ────────────────────────────────────────────────

nodeTest("consoleShellClientSource is a real, exported function bootConsoleShellClient wraps its output around", () => {
  assert.equal(typeof bootConsoleShellClient, "function", "bootConsoleShellClient must be a real, callable export");
  assert.equal(typeof consoleShellClientSource, "function");
});

nodeTest("consoleShellClientSource embeds the CALLER-SUPPLIED thresholds, never a baked-in constant", () => {
  const src = consoleShellClientSource({ default: 123456, recon: 654321 });
  assert.match(src, /123456/);
  assert.match(src, /654321/);
});

nodeTest("consoleShellClientSource embeds the REAL resolveFreshness (lib/console-freshness.ts), not a hand copy", () => {
  const src = consoleShellClientSource({ default: 1 });
  // `.toString()` off the real, imported function -- same technique W1-T281 has always used.
  // Asserting on its OWN source rather than a description of it: a drifted copy would fail this.
  assert.equal(src.includes(resolveFreshness.toString()), true);
});

nodeTest("consoleShellClientSource's output is valid, parseable JavaScript", () => {
  const src = consoleShellClientSource({ default: 1 });
  // Constructing (never calling) a Function parses the body without running browser-only code
  // (document/window/fetch) in this Node process.
  assert.doesNotThrow(() => new Function(src));
});

nodeTest("bootConsoleShellClient's own body carries no TypeScript syntax — it must ship to the browser unstripped", () => {
  // See lib/console-shell-client.ts's header: consoleShellClientSource slices this function's
  // body straight off the module's own source text rather than stripping types from it, so a
  // type annotation inside the function would ship as a browser syntax error. This is the
  // regression that check locks shut, at the one seam a future edit could reintroduce it.
  const src = consoleShellClientSource({ default: 1 });
  assert.doesNotThrow(() => new Function(src), "a type annotation leaking into the body would make this a SyntaxError");
});

// ── (2) bootConsoleShellClient exercised directly, under the real DOM harness ───────────────

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

const READ_TOKEN = "cs-client-read-token";
const WRITE_TOKEN = "cs-client-write-token";

function fixtureDeps(tasks: Task[]): ServeDeps {
  const root = mkdtempSync(join(tmpdir(), "rmd-cs-client-"));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, tasks.map((t) => `- id: ${t.id}\n  title: "${t.title}"\n  repo: ${t.repo}\n  type: ${t.type}\n`).join(""));
  const plan = planOf(tasks);
  const github = fakeGitHub();
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
// Await the PROMISE, never the resolved handle — a zero-match `--test-name-pattern` run fires
// `after` while `chromium.launch()` is still in flight; closing an undefined handle leaks the
// browser that lands a moment later (test/serve.shell-ux.test.ts's own note).
let browserPromise: Promise<Browser> | undefined;
before(async () => {
  // W1-T3018: with the pinned build verifiably absent on an author-time host every test here is
  // already registered as skipped, so launching could only produce the per-test errors that
  // misread as a real regression. Never taken under CI.
  if (BROWSER_SKIP !== undefined) return;
  browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  browser = await browserPromise;
});
after(async () => {
  const launched = await browserPromise;
  await launched?.close();
});

/** Open the shell, optionally seeding a write token into sessionStorage BEFORE the page's own
 *  script runs — mirrors test/console-write-state.test.ts's openShell. */
async function openShell(base: string, writeToken?: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (writeToken !== undefined) {
    await page.addInitScript((t) => {
      window.sessionStorage.setItem("rmd-console-write-token", t);
    }, writeToken);
  }
  await page.goto(`${base}/?token=${READ_TOKEN}`);
  await page.waitForFunction(shellBootReady);
  return page;
}

test("bootConsoleShellClient renders a real task into #now-list — the exact DOM logic that used to be an unparsed string", async () => {
  const deps = fixtureDeps([task({ id: "W1-T9", title: "extract the shell client" })]);
  // NOW is the in-flight lane -- a plan-only "queued" task never appears there. A run.start
  // ledger line is what actually puts a task in flight (mirrors test/serve.first-paint.test.ts).
  appendFileSync(deps.board.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T9", step: "run.start" }) + "\n");
  await withShell(deps, async (base) => {
    const page = await openShell(base);
    await page.waitForFunction(() => document.querySelectorAll("#now-list li[data-key]").length > 0);
    const detail = await page.evaluate(() => document.querySelector("#now-list .task-id")?.textContent ?? "");
    assert.equal(detail, "W1-T9");
    await page.close();
  });
});

test("bootConsoleShellClient's write-scope gating (writeGateAttrs/probeWriteScope) runs for real: no token disables, a valid token enables", async () => {
  const deps = fixtureDeps([task({ id: "W1-T9" })]);
  await withShell(deps, async (base) => {
    const readOnly = await openShell(base);
    const disabledWithoutToken = await readOnly.evaluate(
      () => (document.getElementById("pause-btn") as HTMLButtonElement | null)?.disabled,
    );
    assert.equal(disabledWithoutToken, true, "no write token held -- the fleet-control button must stay disabled");
    await readOnly.close();

    const writable = await openShell(base, WRITE_TOKEN);
    await writable.waitForFunction(() => (document.getElementById("pause-btn") as HTMLButtonElement)?.disabled === false);
    await writable.close();
  });
});

test("bootConsoleShellClient's GLANCE strip actually USES isBlockedRow (test/console-stopped-counts.test.ts's behavioural half, kept here so that suite needs no second readFileSync-as-text check — test/source-text-assertion-census.test.ts's own ratchet)", async () => {
  const deps = fixtureDeps([task({ id: "W1-T9" }), task({ id: "W1-T10" })]);
  // W1-T10 is escalated (needsHuman: true) -- isBlockedRow's OTHER arm, beside status === "blocked"
  // (board.ts's own definition) -- so a strip that only counted status==="blocked" would read 0.
  appendFileSync(deps.board.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T10", step: "escalation.issue_opened" }) + "\n");
  await withShell(deps, async (base) => {
    const page = await openShell(base);
    await page.waitForFunction(() => document.getElementById("glance-blocked")?.textContent !== "…");
    const blocked = await page.evaluate(() => document.getElementById("glance-blocked")?.textContent ?? "");
    assert.equal(blocked, "1", "the one escalated (needsHuman) task must count as blocked on the glance strip");
    await page.close();
  });
});
