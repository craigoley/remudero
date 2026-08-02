// test/serve.computed-visibility.test.ts — W1-T287.
//
// EVERY shipped console visibility proof (test/console-freshness-wired.test.ts:165-170,
// test/serve.live-state.test.ts:401/409/420/469) asserted the `hidden` DOM ATTRIBUTE, never what
// the browser actually PAINTED. `#stale-badge` (serve.ts ~479) declared an unconditional
// `display: inline-block` in the author stylesheet, which beats the UA sheet's own
// `[hidden] { display: none }` regardless of specificity -- so markStale/clearStale (serve.ts
// ~1344-1350) flipped the attribute faithfully while the badge stayed painted on screen
// regardless. The whole suite was green while the STALE banner sat beside "live · updated 2s
// ago" (the operator-observed bug this task exists to make un-shippable again).
//
// This file asserts what the browser ACTUALLY RESOLVED -- Playwright's `isVisible()` /
// `getComputedStyle` / `boundingBox()` -- never the attribute, which is only an INPUT to
// rendering. Retrofitting the pre-existing `.hidden` reads in test/serve.live-state.test.ts to
// the same computed-visibility standard is the OTHER half of this task (see that file's
// `isVisible(` calls).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { shellBootReady } from "./setup/open-shell.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";

const READ_TOKEN = "computed-visibility-read-token";
const WRITE_TOKEN = "computed-visibility-write-token";

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

function fakeGitHub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function fakeTraceGithub() {
  return { prView: () => null };
}

function fakeIssueCloser() {
  return { close() {} };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-computed-visibility-"));
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
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
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
// Same launch/teardown shape as test/serve.live-state.test.ts (`browserPromise`, not `browser`,
// is what `after` closes) -- see that file's comment for why closing the resolved handle instead
// leaks a chrome-headless-shell process when `--test-name-pattern` matches zero tests here.
let browserPromise: Promise<Browser> | undefined;
before(async () => {
  browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  browser = await browserPromise;
});
after(async () => {
  const launched = await browserPromise;
  await launched?.close();
});

test("boot state: the connected badge and the STALE badge are never both computed-visible at once, asserted as one predicate over two surfaces", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root, [task({ id: "W1-T1" })]), async (base) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${base}/?token=${READ_TOKEN}`);
      await page.waitForFunction(shellBootReady);
      // a genuinely healthy boot: the REST poll succeeds immediately, so the SSE connection
      // indicator settles on "connected" and the board is never marked stale.
      await page.waitForFunction(() => document.getElementById("connection-indicator")?.dataset.state === "connected", null, { timeout: 5000 });

      const connectedVisible = await page.locator('.conn-badge[data-state="connected"]').isVisible();
      const staleVisible = await page.locator("#stale-badge").isVisible();
      assert.equal(connectedVisible, true, "sanity: the connected badge must actually be painted once SSE is up");
      // pre-fix this failed unconditionally: #stale-badge's unguarded `display: inline-block`
      // painted it regardless of `hidden`, so it read visible even on a genuinely fresh, connected
      // board -- the exact "live · updated 2s ago" beside "STALE" the operator screenshotted.
      assert.equal(staleVisible, false, "the STALE badge must be unpainted once the board is truly connected and fresh");
      assert.ok(
        !(connectedVisible && staleVisible),
        "one-truth predicate: '.conn-badge[data-state=connected]' visible AND '#stale-badge' visible must never both hold",
      );
    } finally {
      await context.close();
    }
  });
});

test("a hidden #stale-badge resolves to display:none in getComputedStyle and has no box at all -- the CSS override is gone, not merely the attribute set", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root, [task({ id: "W1-T1" })]), async (base) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${base}/?token=${READ_TOKEN}`);
      await page.waitForFunction(shellBootReady);
      const badge = page.locator("#stale-badge");
      assert.equal(await badge.getAttribute("hidden"), "", "sanity: the badge must actually carry the hidden attribute at boot");
      const display = await badge.evaluate((el) => getComputedStyle(el).display);
      assert.equal(display, "none", "a hidden #stale-badge must resolve to display:none, not an author override that beats [hidden]");
      const box = await badge.boundingBox();
      assert.equal(box, null, "a hidden #stale-badge must have no box at all -- not merely a zero-sized one");
    } finally {
      await context.close();
    }
  });
});

test("every element the shell toggles via the hidden attribute is unpainted when hidden, checked from computed style rather than the attribute", async () => {
  const root = tmpRoot();
  await withShell(fixtureDeps(root, [task({ id: "W1-T1" })]), async (base) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${base}/?token=${READ_TOKEN}`);
      await page.waitForFunction(shellBootReady);

      // Every selector the shell toggles via `el.hidden = ...` (grepped from serve.ts) that ships
      // hidden in the STATIC template, so this is a real input state, not a synthetic one.
      // `.cmdk-overlay[hidden] { display: none; }` (serve.ts ~587) was the one existing precedent
      // for the guard `#stale-badge` was missing -- swept here alongside it so a future `display`
      // added to any of these without the guard fails THIS test, not a live screenshot.
      const staticHiddenSelectors = [
        "#glance-anomaly",
        "#stale-badge",
        "#gh-unreachable-banner",
        "#write-error-banner",
        "#write-ack-banner",
        "#recap",
        "#write-token-clear-btn",
        "#panel",
        "#cmdk-overlay",
      ];
      for (const sel of staticHiddenSelectors) {
        const el = page.locator(sel);
        assert.equal(await el.getAttribute("hidden"), "", `sanity: ${sel} must carry the hidden attribute at boot`);
        const visible = await el.isVisible();
        assert.equal(visible, false, `${sel} is toggled via the hidden attribute but Playwright still resolves it visible`);
        const display = await el.evaluate((node) => getComputedStyle(node).display);
        assert.equal(display, "none", `${sel} resolves to a non-none display while hidden`);
      }

      // Two more hidden-toggled elements the shell only ever creates DYNAMICALLY (row-detail
      // markup, never present in the static template): `.anomaly-flag` (serve.ts ~1820) and
      // `.card-journey-body` (serve.ts ~2908). Probed by injecting the SAME class the shell emits,
      // hidden, into the live document -- this proves the STYLESHEET RULE itself unpaints them,
      // independent of whether this fixture's data happens to walk the real render path that
      // creates one.
      const dynamicChecks = await page.evaluate(() => {
        const out: Array<{ cls: string; display: string; hasBox: boolean }> = [];
        for (const cls of ["anomaly-flag", "card-journey-body"]) {
          const el = document.createElement("span");
          el.className = cls;
          el.hidden = true;
          document.body.appendChild(el);
          const display = getComputedStyle(el).display;
          const box = el.getBoundingClientRect();
          out.push({ cls, display, hasBox: box.width > 0 || box.height > 0 });
          el.remove();
        }
        return out;
      });
      for (const r of dynamicChecks) {
        assert.equal(r.display, "none", `.${r.cls} resolves to a non-none display while hidden`);
        assert.equal(r.hasBox, false, `.${r.cls} still occupies a box while hidden`);
      }
    } finally {
      await context.close();
    }
  });
});
