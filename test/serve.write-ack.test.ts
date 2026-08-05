// test/serve.write-ack.test.ts — impl-EA.
//
// THE DEFECT, measured by impl-DY: the operator clicked Mark handled on two NEEDS ME rows. Both
// POSTs SUCCEEDED — five `panel.escalation_marked_handled` ledger lines exist and GitHub shows
// issue #708 closed at 17:47:47Z and #776 at 17:47:48Z. Then the row did not change, because
// `refreshAll()` re-reads a gateway with a 15-second TTL and the row re-renders byte-identically.
// So he clicked again. Twice. A whole session went into diagnosing a mechanism that worked.
//
// PR #1003 made a FAILED write visible. PR #1084 made "may I write?" visible. Neither made a
// SUCCEEDED write visible. That is the only gap this file covers.
//
// THE TRAP this file locks shut: an acknowledgement that fires on `res.ok` alone says "done" when
// all that happened is that the SERVICE accepted the request. /v1/drain/kick and /v1/drain/run drop
// a marker file; the daemon acts at its next poll and can refuse outright (`console.kick_refused`
// is in this repo's own ledger). Those two must read as REQUESTED, never as done — a confident lie
// is strictly worse than the silence being fixed. Both wordings are asserted here, and the
// falsifier for this file is that collapsing them fails the pending test specifically.
//
// Chromium because the banner is state produced by executed JS on a res.ok path, not a property of
// the HTML string (learnings#probe-must-exercise-the-real-consuming-client). Harness shape and the
// browserPromise teardown are lifted from test/serve.shell-ux.test.ts deliberately.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { reachSection, shellBootReady } from "./setup/open-shell.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

const READ_TOKEN = "ea-read-token";
const WRITE_TOKEN = "ea-write-token";

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

function fixtureDeps(): ServeDeps {
  const root = mkdtempSync(join(tmpdir(), "rmd-ea-"));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, '- id: W1-T3\n  title: "q"\n  repo: remudero\n  type: implement\n');
  const plan = planOf([task({ id: "W1-T3", status: "queued" })]);
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
// `after` while chromium.launch() is still in flight, and closing an undefined handle leaks the
// browser that lands a moment later (test/serve.shell-ux.test.ts's own note).
let browserPromise: Promise<Browser> | undefined;
before(async () => {
  browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  browser = await browserPromise;
});
after(async () => {
  const launched = await browserPromise;
  await launched?.close();
});

/** Open the shell with an ACCEPTED write token seeded into sessionStorage, so the write controls
 *  are live (W1-T202: the write token never rides the URL; only the read token does). */
async function openShellWithWrite(base: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((t) => {
    window.sessionStorage.setItem("rmd-console-write-token", t);
  }, WRITE_TOKEN);
  await page.goto(`${base}/?token=${READ_TOKEN}`);
  await page.waitForFunction(shellBootReady);
  return page;
}

/** The acknowledgement banner as an operator sees it. */
async function ack(page: Page): Promise<{ hidden: boolean; kind: string; text: string }> {
  return await page.evaluate(() => {
    const el = document.getElementById("write-ack-banner") as HTMLElement | null;
    return { hidden: el?.hidden !== false, kind: el?.dataset.ackKind ?? "ABSENT", text: el?.textContent ?? "" };
  });
}

async function errBanner(page: Page): Promise<{ hidden: boolean; text: string }> {
  return await page.evaluate(() => {
    const el = document.getElementById("write-error-banner") as HTMLElement | null;
    return { hidden: el?.hidden !== false, text: el?.textContent ?? "" };
  });
}

// ── 5. a successful write is visibly acknowledged ────────────────────────────────────

test("a successful write renders a visible acknowledgement naming what happened", async () => {
  const deps = fixtureDeps();
  await withShell(deps, async (base) => {
    const page = await openShellWithWrite(base);

    // Before the click there is nothing to see — otherwise the assertion below proves nothing.
    assert.equal((await ack(page)).hidden, true, "the banner starts hidden");

    await reachSection(page, "controls"); // #pause-btn lives in the "controls" section
    await page.click("#pause-btn"); // -> POST /v1/control/pause, a route the service completes itself
    await page.waitForFunction(() => document.getElementById("write-ack-banner")?.hidden === false);

    const a = await ack(page);
    assert.equal(a.hidden, false, "the acknowledgement is visible");
    assert.equal(a.kind, "done", "pause is completed by the service before it replies");
    // The rendered TEXT, not merely that a handler ran — this is what the operator reads.
    assert.match(a.text, /Fleet PAUSED/);
    assert.match(a.text, /no new task will be dispatched until you resume/);

    // A success must not be dressed as a failure: the error banner stays down.
    assert.equal((await errBanner(page)).hidden, true, "no error banner on a successful write");
    await page.close();
  });
});

// ── 6. the PR #1003 regression lock — a FAILED write still surfaces ──────────────────

test("a failed write still surfaces its failure and shows no acknowledgement", async () => {
  const deps = fixtureDeps();
  await withShell(deps, async (base) => {
    const page = await openShellWithWrite(base);
    // The server would accept this; the point is what the CLIENT does with a non-ok response, which
    // is what PR #1003 fixed across twelve call sites and what this locks against regression.
    await page.route("**/v1/control/pause", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }),
    );

    await reachSection(page, "controls"); // #pause-btn lives in the "controls" section
    await page.click("#pause-btn");
    await page.waitForFunction(() => document.getElementById("write-error-banner")?.hidden === false);

    const e = await errBanner(page);
    assert.equal(e.hidden, false, "the failure is surfaced");
    assert.match(e.text, /Write failed/);
    assert.match(e.text, /500/);
    assert.match(e.text, /boom/, "the server's own message is surfaced, not just the status");

    // AND — the half this task adds — a failure must never render as an acknowledgement.
    const a = await ack(page);
    assert.equal(a.hidden, true, "no acknowledgement on a failed write");
    assert.equal(a.text, "");
    await page.close();
  });
});

// ── 7. THE TRAP-1 LOCK: acceptance is not completion ─────────────────────────────────

test("a write the service only RECORDS is worded as pending, never as done", async () => {
  const deps = fixtureDeps();
  await withShell(deps, async (base) => {
    const page = await openShellWithWrite(base);

    await reachSection(page, "up-next"); // #drain-now-btn lives in the "up-next" section
    // Drain now is arm-then-confirm: the first click arms, the second acts.
    await page.click("#drain-now-btn");
    await page.waitForFunction(() => document.getElementById("drain-now-btn")?.dataset.confirming === "true");
    await page.click("#drain-now-btn"); // -> POST /v1/drain/run, which only drops a marker file
    await page.waitForFunction(() => document.getElementById("write-ack-banner")?.hidden === false);

    const a = await ack(page);
    assert.equal(a.kind, "requested", "the daemon has not acted yet — this is an intent, not an outcome");
    assert.match(a.text, /REQUESTED/);
    assert.match(a.text, /not started yet/);
    assert.match(a.text, /next poll/, "it names WHEN the fleet will look, so 'pending' is actionable");

    // The wording must not claim the action happened. These are the words that would be a lie.
    assert.doesNotMatch(a.text, /\bdone\b/i);
    assert.doesNotMatch(a.text, /\bcompleted\b/i);
    assert.doesNotMatch(a.text, /\bstarted\b(?! yet)/i);

    // ...and it is rendered DIFFERENTLY from a completed action, so the two are not one message
    // with two texts that a later edit could quietly merge.
    assert.notEqual(a.kind, "done");
    await page.close();
  });
});

// ── 8. POLICY: a control with no observable board change says so, rather than promising a refresh

test("POLICY acknowledge-and-name-where-to-look: a control whose effect never shows on the board points at RECENT instead of promising a refresh", async () => {
  // Trap 2. Most controls DO change the board on the next refresh — and since PR #1085 gave
  // `status: accepted` a real consumer (an ACCEPTED section), even Accept now does. The two that
  // still do not are /v1/drain/kick and /v1/drain/run: they write a marker file, and nothing in the
  // board projection represents a pending kick. Telling the operator "refresh and it will change"
  // would be false for exactly these two. The policy is therefore: acknowledge the request, state
  // that it has not started, and name the surface where the outcome WILL appear — never imply a
  // refresh will show it.
  const deps = fixtureDeps();
  await withShell(deps, async (base) => {
    const page = await openShellWithWrite(base);
    await reachSection(page, "up-next"); // #drain-now-btn lives in the "up-next" section
    await page.click("#drain-now-btn");
    await page.waitForFunction(() => document.getElementById("drain-now-btn")?.dataset.confirming === "true");
    await page.click("#drain-now-btn");
    await page.waitForFunction(() => document.getElementById("write-ack-banner")?.hidden === false);

    const a = await ack(page);
    assert.match(a.text, /Watch RECENT for the outcome/, "it names where the outcome will actually appear");
    assert.doesNotMatch(a.text, /next refresh/, "it must not promise a refresh that changes nothing");

    // The contrast case: a control that DOES change the board is allowed to say so.
    const markHandled = readFileSync(new URL("../src/lib/serve.ts", import.meta.url), "utf8");
    assert.match(markHandled, /Marked handled — the escalation issue is closed\. The row clears on the next refresh\./);
    await page.close();
  });
});

// ── the shared-helper contract: one place covers all twelve ──────────────────────────

test("the acknowledgement lives in the shared postJson helper so every write control inherits it", () => {
  const src = readFileSync(new URL("../src/lib/serve.ts", import.meta.url), "utf8");
  // PR #1003 put `.ok` checking in postJson precisely so twelve call sites did not need twelve
  // patches; the acknowledgement rides the same contract. If a future edit moves it out to the
  // call sites, this fails and says why.
  const helper = /function postJson\(path, body\)[\s\S]*?\n  \}\n/.exec(src);
  assert.ok(helper, "postJson is still a single shared helper");
  assert.match(helper![0], /showWriteAck\(path\)/, "the acknowledgement fires inside the helper");

  const sites = [...src.matchAll(/postJson\("(\/v1\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(sites.length >= 12, `expected at least 12 postJson call sites, found ${sites.length}`);
  // Every route a call site posts to must have an entry in the table, so nothing falls through to
  // the neutral wording by accident.
  const table = /const WRITE_ACK = \{([\s\S]*?)\n  \};/.exec(src);
  assert.ok(table, "the route table is present");
  for (const path of new Set(sites)) {
    assert.ok(table![1].includes(`"${path}"`), `${path} has no acknowledgement entry`);
  }
});
