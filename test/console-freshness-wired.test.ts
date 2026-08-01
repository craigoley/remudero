// test/console-freshness-wired.test.ts — W1-T281: lib/console-freshness.ts's `resolveFreshness`
// (111 lines, 83 lines of tests, shipped by W1-T262/#777) had ZERO callers anywhere outside its
// own test — serve.ts's only reference to it was a COMMENT reading "mirrors resolveFreshness",
// never an actual import/call. The tested fix landed in a module nothing reached, so the
// operator kept seeing "STALE" beside "live · updated 2s ago" for eight days after #777 merged.
//
// This suite proves the WIRING, not the freshness rules themselves (those are already proven by
// test/console-freshness.test.ts's 7 cases): (1) serve.ts imports the real module and its client
// script calls the real function rather than a hand-copied re-derivation, (2) the specific
// hand-mirrored arithmetic this task's own rationale named is gone, and (3) — driven through the
// REAL served page in a REAL browser (learnings#probe-must-exercise-the-real-consuming-client;
// AskUserQuestion/curl stand-ins prove nothing about what a browser actually renders) — a pane
// that keeps receiving live data never renders the STALE badge.
import assert from "node:assert/strict";
import { readFileSync, appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { shellBootReady } from "./setup/open-shell.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

const READ_TOKEN = "freshness-wired-read-token";

const SERVE_TS_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "serve.ts"), "utf8");

// ── (1) serve.ts imports and CALLS the real resolveFreshness — not a comment claiming to. ──────

test("serve.ts imports resolveFreshness from lib/console-freshness.ts", () => {
  assert.match(
    SERVE_TS_SOURCE,
    /import\s*\{\s*resolveFreshness\s*\}\s*from\s*"\.\/console-freshness\.js"/,
    "serve.ts must import the real, unit-tested resolveFreshness — not re-derive its rule by hand",
  );
});

test("serve.ts's shell script CALLS resolveFreshness( — a comment mentioning the name is not enough (the #339/W1-T281 class of bug: a proof that only greps a COMMENT passes on entirely unbuilt wiring)", () => {
  const calls = SERVE_TS_SOURCE.match(/resolveFreshness\(/g) ?? [];
  // one call to embed the REAL function's own source (\`resolveFreshness.toString()\` is NOT a
  // match for this pattern — toString() is a property access, never "resolveFreshness(") plus at
  // least two genuine invocations (markStale's guard, handlePollFailure's escalation decision).
  assert.ok(calls.length >= 2, `expected >= 2 literal "resolveFreshness(" call sites in serve.ts, found ${calls.length}`);
});

// ── (2) the hand-written mirror this task's own rationale named is gone. ────────────────────────

test("the hand-written mirror (a second, parallel dataIsStale/pollFailures re-derivation of resolveFreshness's own rule) is gone from serve.ts", () => {
  // the OLD shape: `const dataIsStale = !lastLiveAt || Date.now() - lastLiveAt >= STALE_DATA_AGE_MS;`
  // followed by its own hand-rolled `pollFailures < STALE_ESCALATE_AFTER || !dataIsStale` branch —
  // a second copy of exactly the rule resolveFreshness already encodes and unit-tests.
  assert.doesNotMatch(SERVE_TS_SOURCE, /const dataIsStale\s*=/, "the parallel dataIsStale variable must be deleted, not left beside the real call");
  assert.doesNotMatch(
    SERVE_TS_SOURCE,
    /pollFailures\s*<\s*STALE_ESCALATE_AFTER\s*\|\|\s*!dataIsStale/,
    "the hand-inlined escalation condition must be gone — the decision now comes from resolveFreshness's own returned mode",
  );
  // the OLD markStale guard: `if (lastLiveAt && Date.now() - lastLiveAt < STALE_DATA_AGE_MS) return;`
  assert.doesNotMatch(
    SERVE_TS_SOURCE,
    /if \(lastLiveAt && Date\.now\(\) - lastLiveAt < STALE_DATA_AGE_MS\) return;/,
    "markStale's own hand-inlined fresh-refuses-the-banner guard must be gone — it now asks resolveFreshness",
  );
});

// ── (3) a fresh pane never renders STALE — driven through the REAL served page in a REAL
// browser, the ONLY client class that renders this badge (learnings#probe-must-exercise-the-
// real-consuming-client). This is the exact falsifier the task names: "STALE still renders
// beside 'live · updated 2s ago'". ───────────────────────────────────────────────────────────

function task(over: Partial<Task> = {}): Task {
  return { id: "W1-TX", title: "t", repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0, ...over };
}
function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}
function fakeGitHub(): GitHub {
  return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
}
function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}
function fakeIssueCloser(): IssueCloser {
  return { close() {} };
}
function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-freshness-wired-"));
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
function fixtureDeps(root: string, tasks: Task[]): ServeDeps {
  const plan = planOf(tasks);
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, planYaml(plan));
  const github = fakeGitHub();
  return {
    board: { plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: "freshness-wired-write-token" },
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
let browserPromise: Promise<Browser> | undefined;
before(async () => {
  browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  browser = await browserPromise;
});
after(async () => {
  const launched = await browserPromise;
  await launched?.close();
});

test("a pane that keeps receiving live data (poll AND SSE both healthy) never renders the STALE badge — the exact falsifier this task names ('STALE still renders beside live · updated 2s ago')", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]);
  await withShell(deps, async (base) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${base}/?token=${READ_TOKEN}`);
      await page.waitForFunction(shellBootReady);

      // several poll ticks (pollMs: 50) all succeed -- long enough to have crossed the OLD
      // hand-mirror's own escalation window several times over, were it still driving this page.
      await new Promise((resolve) => setTimeout(resolve, 500));
      appendFileSync(deps.board.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "run.start" }) + "\n");
      await page.waitForFunction(() => document.getElementById("top-status")?.getAttribute("data-poll-state") === "ok", null, { timeout: 5000 });

      const state = await page.evaluate(() => ({
        staleHidden: (document.getElementById("stale-badge") as HTMLElement)?.hidden,
        dataStale: document.getElementById("top-status")?.getAttribute("data-stale"),
        pollState: document.getElementById("top-status")?.getAttribute("data-poll-state"),
        topStatusText: document.getElementById("top-status")?.textContent ?? "",
      }));
      assert.equal(state.staleHidden, true, "the STALE badge must stay hidden while data keeps arriving");
      assert.equal(state.dataStale, null, "top-status must never carry data-stale while live");
      assert.equal(state.pollState, "ok");
      assert.match(state.topStatusText, /updated/);
    } finally {
      await context.close();
    }
  });
});
