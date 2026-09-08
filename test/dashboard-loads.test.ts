// test/dashboard-loads.test.ts — W1-T2902.
//
// apps/dashboard could not load as shipped: index.html's <script src="./main.js"> pointed at a
// file the repo root's tsconfig.json never produces there (it emits to dist/apps/dashboard/src/
// main.js), and main.ts's one import, the bare specifier "@remudero/api-client/client", has no
// import map to resolve it — a browser cannot read a package.json `exports` map the way tsx/Node
// does. This is the RULING this task's own rationale asks for: FIX the loading (apps/dashboard/
// tsconfig.json's own build, emitting beside index.html, plus index.html's own import map) rather
// than delete the app — it is not superseded by the console shell (a different product entirely:
// a portable, Tauri-wrappable static page vs. `rmd serve`'s inline HTML), and it carries real,
// already-tested CSRF/allow-list logic (main.ts's isAllowedDaemonUrl, CodeQL alerts #32/#33/#52/
// #54) a deletion would silently orphan.
//
// Chromium because "does this page actually load" is a property of a rendered page + executed
// module resolution, not of the HTML/JS text (learnings#probe-must-exercise-the-real-consuming-
// client) — a real browser NAVIGATION against the REAL built output, served over HTTP (never
// `file://`: a module script's import map is subject to the same CORS rules as any other module
// fetch, so a `file://` load would prove nothing about the served case this exists for).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { after, before } from "node:test";
import { BROWSER_SKIP, browserTest as test } from "./browser-absence.js";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";

const DASHBOARD_ROOT = join(process.cwd(), "apps", "dashboard");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/**
 * Serves apps/dashboard/ (index.html plus its own build/ output) AND the narrowest fake daemon
 * `boot()`/`subscribeStatus` need, off the SAME origin/port — deliberately, not an oversight.
 *
 * `rmd serve`'s real daemon (src/lib/service.ts) sends no `Access-Control-Allow-Origin` header
 * at all, so a `?daemon=` on a DIFFERENT origin than wherever this page is hosted from 403s on
 * its CORS preflight today — a real, pre-existing gap in the cross-origin deployment story
 * main.ts's own header names as deferred ("Wiring the daemon to actually SERVE this directory
 * ... is explicit follow-on work"), and a materially different concern from THIS task's:
 * whether the page's own module graph resolves and boots at all. Serving both off one origin
 * exercises the FIRST of `isAllowedDaemonUrl`'s three sanctioned cases (the page's own origin —
 * literally the end state that comment names) and isolates what W1-T2902 actually fixed
 * (main.js/client.js landing where index.html's script tag and import map now expect them) from
 * that separate, pre-existing CORS gap, which is out of this task's one concern (see this file's
 * header) — never `file://` either way, since a module script's import map is CORS-governed
 * the same as any other module fetch.
 */
function dashboardAndDaemonServer(root: string): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://internal");
    if (url.pathname === "/v1/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ generated_at: new Date().toISOString(), tasks: [{ taskId: "W1-T9", status: "queued", merged: false }] }));
      return;
    }
    if (url.pathname === "/v1/status/stream") {
      // subscribeStatus's read loop sees `done: true` on its first read and returns — no event
      // is required for this test, which only proves the module graph resolves and boots.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end();
      return;
    }
    if (url.pathname === "/v1/feedback") {
      // wireFeedbackPanel (W3-T6) also calls listFeedback() at boot — an empty inbox is enough
      // to prove the module resolves and boots cleanly, which is this test's whole concern.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ entries: [] }));
      return;
    }
    const relPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = join(root, relPath);
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    readFile(filePath)
      .then((body) => {
        res.writeHead(200, { "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream" });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404).end();
      });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

let browser: Browser;
// Await the PROMISE, never the resolved handle — see test/serve.shell-ux.test.ts's own note: a
// zero-match `--test-name-pattern` run fires `after` while `chromium.launch()` is still in
// flight, and closing an undefined handle leaks the browser that lands a moment later.
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

test("apps/dashboard: npm run build emits main.js and its api-client dependency BESIDE index.html, and the page loads and renders the live board through them", async () => {
  await rm(join(DASHBOARD_ROOT, "build"), { recursive: true, force: true });
  const buildResult = spawnSync(process.execPath, [join(process.cwd(), "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
    cwd: DASHBOARD_ROOT,
    encoding: "utf8",
  });
  assert.equal(buildResult.status, 0, `apps/dashboard's own build failed:\n${buildResult.stdout}\n${buildResult.stderr}`);
  assert.ok(existsSync(join(DASHBOARD_ROOT, "build", "apps", "dashboard", "src", "main.js")), "build must emit main.js under build/, beside index.html");
  assert.ok(
    existsSync(join(DASHBOARD_ROOT, "build", "packages", "api-client", "src", "client.js")),
    "build must also emit the api-client dependency the import map resolves to",
  );

  const server = dashboardAndDaemonServer(DASHBOARD_ROOT);
  const port = await listen(server);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") pageErrors.push(msg.text());
    });

    // `?daemon=` names the page's OWN origin — isAllowedDaemonUrl's first sanctioned case (see
    // dashboardAndDaemonServer's own doc for why this test does not exercise a cross-origin one).
    await page.goto(`http://127.0.0.1:${port}/index.html?daemon=http://127.0.0.1:${port}&token=t`);
    await page.waitForFunction(() => document.getElementById("board")?.textContent !== "Loading…");

    assert.deepEqual(pageErrors, [], "the page must load with no console/module-resolution errors");
    const boardHtml = await page.evaluate(() => document.getElementById("board")?.innerHTML ?? "");
    assert.match(boardHtml, /W1-T9/, "the fake daemon's one task must actually render");
    await context.close();
  } finally {
    server.close();
  }
});
