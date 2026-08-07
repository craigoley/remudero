// test/serve.liveness-honesty.test.ts — recon-blackout rec-2, the RENDERED half.
//
// WHY A BROWSER SUITE AND NOT ANOTHER HANDLER TEST. A handler test cannot see a wrong value in a
// rendered panel: the route can return a perfectly correct `daemonLiveReason` while the client
// keeps printing the one sentence it always printed, and every existing serve.* assertion — which
// checks the shell's STRUCTURE through the shared W1-T335 harness — would stay green. The defect
// this task fixes IS a rendering defect, so the falsifiable claim has to be about the text an
// operator actually reads. These tests drive real Chromium against a real server and assert the
// text content of #controls-status.
//
// PRODUCTION DEFAULTS, NOT A SEAM. `fixtureDeps` deliberately supplies no `controlStatus` dep, so
// `buildServeRoutes` resolves the real `readLedgerLines`, the real `Date.now` and the real
// DEFAULT_LIVENESS_BOUND_MS. The ledger fixtures are real files (or a real absence) on disk. The
// `present` flag the fix reads is attached by the shipping reader; a test injecting its own reader
// would prove nothing about it.
//
// The unreadable fixture is a DIRECTORY at the ledger path rather than a chmod: `chmod 000` does
// not stop uid 0, so a permissions fixture silently becomes the readable case under root, while a
// directory throws EISDIR on read for every uid on both macOS and Linux.

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { DEFAULT_LIVENESS_BOUND_MS, type GitHub } from "../src/lib/status.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { Plan } from "../src/lib/plan.js";
import type { TraceGithub } from "../src/lib/trace.js";
import { shellBootReady } from "./setup/open-shell.js";

const READ_TOKEN = "liveness-honesty-read-token";
const WRITE_TOKEN = "liveness-honesty-write-token";

function fixtureDeps(root: string, ledgerPath: string, pollMs = 50): ServeDeps {
  const plan: Plan = { tasks: [], byId: new Map() };
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n");
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
  const trace: TraceGithub = { prView: () => null };
  const issues: IssueCloser = { close() {} };
  return {
    board: { plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: trace, statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs,
    // No `controlStatus` — see this file's header. The omission IS the arrangement.
  };
}

function newRoot(): { dir: string; ledgerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-liveness-render-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  return { dir, ledgerPath: join(dir, "state", "ledger.ndjson") };
}

function heartbeat(agoMs: number, step = "daemon.idle"): string {
  return `${JSON.stringify({ ts: new Date(Date.now() - agoMs).toISOString(), step })}\n`;
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
// Await the launch PROMISE in teardown, never the resolved handle — the same leak `after` would
// otherwise cause when `--test-name-pattern` matches zero tests here, documented at length in
// test/serve.live-state.test.ts. `browserPromise` is assigned synchronously before the first await.
let browserPromise: Promise<Browser> | undefined;
before(async () => {
  browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  browser = await browserPromise;
});
after(async () => {
  const launched = await browserPromise;
  await launched?.close();
});

async function openShell(base: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/?token=${READ_TOKEN}`);
  await page.waitForFunction(shellBootReady);
  return page;
}

/** The rendered sentence, once the panel has stopped saying nothing. */
async function renderedLiveness(page: Page): Promise<string> {
  await page.waitForFunction(() => (document.getElementById("controls-status")?.textContent ?? "").length > 0);
  return (await page.textContent("#controls-status")) ?? "";
}

async function livenessFor(fixture: (ledgerPath: string) => void): Promise<string> {
  const { dir, ledgerPath } = newRoot();
  fixture(ledgerPath);
  return withShell(fixtureDeps(dir, ledgerPath), async (base) => {
    const page = await openShell(base);
    try {
      return await renderedLiveness(page);
    } finally {
      await page.context().close();
    }
  });
}

// ── the three states, as an operator reads them ───────────────────────────────────────────────

test("a fresh heartbeat renders as running", async () => {
  const text = await livenessFor((p) => appendFileSync(p, heartbeat(30_000)));
  assert.match(text, /fleet is running/);
});

test("a stale heartbeat renders as DOWN — the panel can now say the daemon is dead", async () => {
  const text = await livenessFor((p) => appendFileSync(p, heartbeat(DEFAULT_LIVENESS_BOUND_MS + 120_000)));
  assert.match(text, /DOWN/);
  assert.match(text, /heartbeat/);
  assert.doesNotMatch(text, /unknown/i, "a stale heartbeat is evidence, and must not read as an absence of evidence");
});

test("an absent ledger renders as unknown AND names the ledger as the cause", async () => {
  const text = await livenessFor(() => {}); // no file written at all
  assert.match(text, /unknown/i);
  assert.match(text, /ledger/i, "every unknown carries its reason — a bare shrug is the defect");
  assert.doesNotMatch(text, /DOWN/, "an absent ledger says nothing about the daemon");
});

// THE UNREADABLE-LEDGER CASE IS PROVEN AT ROUTE LEVEL ONLY, DELIBERATELY, and the reason is worth
// recording rather than leaving as an unexplained gap: loading the SHELL also opens the board's
// SSE stream, whose reader is `readLedgerTail` (status.ts) — a DIFFERENT function from the one
// this task touches, and one with the same untreated condition in a worse form. It guards
// `existsSync` but wraps no try/catch around its own `readRange`, so a path that exists and
// cannot be read throws inside `buildStatusStream`'s subscribe callback and takes the stream down
// as an unhandled rejection. That is out of this task's one concern (see the PR body's
// report-not-fix section); driving it through the browser would be testing that defect, not this
// fix. test/daemon-liveness-taxonomy.test.ts covers the same state over real HTTP, where only
// GET /v1/control/status is involved.

test("the three formerly-identical states render three DIFFERENT sentences", async () => {
  const fresh = await livenessFor((p) => appendFileSync(p, heartbeat(30_000)));
  const dead = await livenessFor((p) => appendFileSync(p, heartbeat(DEFAULT_LIVENESS_BOUND_MS + 120_000)));
  const absent = await livenessFor(() => {});
  assert.equal(new Set([fresh, dead, absent]).size, 3, `states collapsed again: ${JSON.stringify([fresh, dead, absent])}`);
});

// ── W1-T156: in-place patching must survive ───────────────────────────────────────────────────

test("a liveness flip patches the SAME node in place — no re-created element, no lost selection", async () => {
  const { dir, ledgerPath } = newRoot();
  appendFileSync(ledgerPath, heartbeat(DEFAULT_LIVENESS_BOUND_MS + 120_000)); // starts DOWN
  await withShell(fixtureDeps(dir, ledgerPath), async (base) => {
    const page = await openShell(base);
    try {
      await page.waitForFunction(() => (document.getElementById("controls-status")?.textContent ?? "").includes("DOWN"));
      // Stamp the live node, and put a real text selection inside it. W1-T156's invariant is that
      // an update patches rather than replaces; a replaced node loses both.
      await page.evaluate(() => {
        const el = document.getElementById("controls-status") as HTMLElement;
        el.dataset.stableProbe = "1";
        const range = document.createRange();
        range.selectNodeContents(el);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      });

      appendFileSync(ledgerPath, heartbeat(0)); // the daemon comes back
      await page.waitForFunction(() => (document.getElementById("controls-status")?.textContent ?? "").includes("running"));

      const survived = await page.evaluate(() => {
        const el = document.getElementById("controls-status") as HTMLElement;
        return {
          stamp: el.dataset.stableProbe,
          selectionInside: el.contains(window.getSelection()?.anchorNode ?? null),
        };
      });
      assert.equal(survived.stamp, "1", "the element was re-created rather than patched in place");
      assert.equal(survived.selectionInside, true, "a re-created node drops the operator's text selection");
    } finally {
      await page.context().close();
    }
  });
});
