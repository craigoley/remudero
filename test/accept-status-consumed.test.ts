// test/accept-status-consumed.test.ts — W1-T285: the console's Accept button writes feedback
// status `accepted` (panel-graph.ts's POST /v1/feedback/decision) and a proposal PR merging
// writes the SAME status (panel-graph.ts's reconcileFeedbackEntries) -- but until now NOTHING
// read it: serve.ts's NEEDS ME only special-cased `status === "grilling"`/`"proposed"`, so an
// accepted entry just stopped matching and vanished with no downstream trace. A button that
// changes a field nobody reads is worse than no button (this task's own filing, MEASURED at
// 63f63ed).
//
// This suite drives the REAL, ACTUAL consuming client (learnings#probe-must-exercise-the-real-
// consuming-client) -- a real headless browser loading the real served shell, the same
// discipline test/serve.live-state.test.ts/serve.density-ia.test.ts already use for UI bars that
// can't be proven any other way -- rather than a convenient stand-in that only LOOKS like the
// console.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { shellBootReady } from "./setup/open-shell.js";
import { captureFeedback, setFeedbackStatus } from "../src/lib/feedback.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

const READ_TOKEN = "accept-consumed-read-token";
const WRITE_TOKEN = "accept-consumed-write-token";

function emptyPlan(): Plan {
  return { tasks: [], byId: new Map() };
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
  return mkdtempSync(join(tmpdir(), "rmd-accept-consumed-"));
}

/** An empty plan, written to disk too -- panel-graph.ts's own routes (e.g. GET /v1/drain/preview,
 *  fetched during boot alongside GET /v1/feedback) reload the plan FRESH from `planPath` on every
 *  request rather than trusting the in-memory `Plan`, so a fixture that only set `board.plan`
 *  in-memory (no file) would 500 that route on every real request this suite's shell makes. */
function fixtureDeps(root: string): ServeDeps {
  const ledgerPath = join(root, "ledger.ndjson");
  const github = fakeGitHub();
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n");
  return {
    board: { plan: emptyPlan(), ledgerPath, github },
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
let browserPromise: Promise<Browser> | undefined;
before(async () => {
  browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  browser = await browserPromise;
});
after(async () => {
  const launched = await browserPromise;
  await launched?.close();
});

/** The write token is seeded into sessionStorage BEFORE the page's own script runs (never
 *  appended to the navigated URL, W1-T202) -- exactly how a real operator who already pasted it
 *  into this tab is represented in every other serve.*.test.ts suite. */
async function openShell(base: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((writeToken) => {
    window.sessionStorage.setItem("rmd-console-write-token", writeToken);
  }, WRITE_TOKEN);
  await page.goto(`${base}/?token=${READ_TOKEN}`);
  await page.waitForFunction(shellBootReady);
  return { context, page };
}

async function acceptedListText(page: Page): Promise<string> {
  return page.locator("#accepted-list").innerText();
}
async function needsMeListText(page: Page): Promise<string> {
  return page.locator("#needs-me-list").innerText();
}

test("W1-T285: an accepted entry is treated differently from a new one by a real consumer, reached from the console's own data path", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);

  // A brand-new entry -- captureFeedback's own default status, never touched by triage/decision.
  const untouched = captureFeedback(root, { raw: "an idea nobody has looked at yet", origin: "cli" });
  // An entry a proposal PR's merge already resolved (panel-graph.ts:175's write path, simulated
  // directly here -- the SAME setFeedbackStatus call that route makes, never a helper this suite
  // invents) -- the "accepted by merge" half of acceptance criterion 4, below.
  const mergedAccept = captureFeedback(root, { raw: "fix landed via a merged proposal PR", origin: "cli" });
  setFeedbackStatus(root, mergedAccept.id, "accepted", { proposalPr: "https://github.com/o/r/pull/9001" });

  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      // The real consumer: GET /v1/feedback -> latestFeedbackEntries -> renderAccepted (serve.ts),
      // the SAME data path NEEDS ME's own grilling/proposed rows already flow through -- never a
      // second, parallel fetch.
      await page.waitForFunction(() => (document.getElementById("accepted-list")?.textContent ?? "").includes("fix landed via a merged proposal PR"));

      const accepted = await acceptedListText(page);
      assert.match(accepted, /fix landed via a merged proposal PR/, "an entry already accepted (by PR merge) renders in the Accepted section");
      assert.doesNotMatch(accepted, /an idea nobody has looked at yet/, "a `new` entry is NOT treated as accepted -- the consumer discriminates by status, not by existing");

      const needsMe = await needsMeListText(page);
      assert.doesNotMatch(needsMe, /fix landed via a merged proposal PR/, "an accepted entry no longer occupies NEEDS ME's actionable queue");
      assert.doesNotMatch(needsMe, /an idea nobody has looked at yet/, "a `new` entry (never triaged to grilling/proposed) has no NEEDS ME row either");
    } finally {
      await context.close();
    }
  });
});

test("W1-T285: accepting a proposal through the console's own Accept button changes what the operator subsequently sees, identically to a merge-accepted entry", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);

  const mergedAccept = captureFeedback(root, { raw: "merge-path accepted proposal", origin: "cli" });
  setFeedbackStatus(root, mergedAccept.id, "accepted", { proposalPr: "https://github.com/o/r/pull/9002" });

  const byButton = captureFeedback(root, { raw: "button-path accepted proposal", origin: "cli" });
  setFeedbackStatus(root, byButton.id, "proposed", { proposalPr: "https://github.com/o/r/pull/9003" });

  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      // Before: the button-path entry sits in NEEDS ME's actionable Accept/Reject queue, and does
      // NOT yet appear as accepted -- clicking Accept is the only thing that can change that.
      await page.waitForFunction(() => (document.getElementById("needs-me-list")?.textContent ?? "").includes("button-path accepted proposal"));
      assert.doesNotMatch(await acceptedListText(page), /button-path accepted proposal/, "not accepted yet -- the button hasn't been clicked");

      // The console's OWN Accept affordance (needsMeProposedHtml's `.needs-me-decide[data-decision=accept]`,
      // POST /v1/feedback/decision) -- never a synthetic call to the API bypassing the UI.
      await page.click(`#needs-me-list li:has-text("button-path accepted proposal") .needs-me-decide[data-decision="accept"]`);

      // After: disappears from NEEDS ME, appears in Accepted -- accepting through the console
      // changed what the operator subsequently sees (acceptance criterion 3).
      await page.waitForFunction(() => !(document.getElementById("needs-me-list")?.textContent ?? "").includes("button-path accepted proposal"));
      await page.waitForFunction(() => (document.getElementById("accepted-list")?.textContent ?? "").includes("button-path accepted proposal"));

      const acceptedText = await acceptedListText(page);
      assert.match(acceptedText, /button-path accepted proposal/);
      // Acceptance criterion 4: an entry accepted by PR merge behaves IDENTICALLY to one accepted
      // by the button -- both are plain rows in the SAME section, off the SAME render path
      // (renderAccepted), never a distinct "how it got here" rendering.
      assert.match(acceptedText, /merge-path accepted proposal/, "the merge-accepted entry is still there, rendered the same way");

      const mergedRowHtml = await page.locator(`#accepted-list li:has-text("merge-path accepted proposal")`).innerHTML();
      const buttonRowHtml = await page.locator(`#accepted-list li:has-text("button-path accepted proposal")`).innerHTML();
      const shapeOf = (html: string) => html.replace(/merge-path accepted proposal|button-path accepted proposal|fb[a-z0-9-]+|\/pull\/\d+/gi, "X");
      assert.equal(shapeOf(mergedRowHtml), shapeOf(buttonRowHtml), "merge-accepted and button-accepted rows share the exact same markup shape -- one render path, not two");

      // Neither accepted row still carries an Accept/Reject affordance -- accepted is terminal.
      assert.doesNotMatch(acceptedText, /Accept|Reject/);
    } finally {
      await context.close();
    }
  });
});
