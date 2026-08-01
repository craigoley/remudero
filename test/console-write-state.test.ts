// test/console-write-state.test.ts — impl-DY.
//
// TWO defects the operator hit on one surface, proven separately because they have separate causes.
//
// DEFECT 1 — the console never SAID whether it could write. The write token lives in sessionStorage
// (W1-T202, XSS grounds), so it dies with every tab; the only statement of that fact lived in
// #write-token-status inside the Fleet-control section, the eleventh section on the page, far below
// NEEDS ME. An operator clicking "Mark handled" never saw it and read a disabled button as a broken
// one -- twice. The fix is a header badge, and THE TRAP is that a badge which reports capability from
// "a token string is present" would render green for a stale token and mislead in a new way. So the
// badge renders from `hasWriteScope`, which is the RESULT of GET /v1/auth/scope with the held token.
// The wrong-token test below is the lock on that: a presence check passes it incorrectly.
//
// DEFECT 2 — an escalation whose task id is not in the plan could never be retired by the machine.
// Proven pure, off the reconciler's candidate builder, with the safety lock (an OPEN referent is NOT
// retirable) asserted in the same file so neither can be relaxed without the other failing.
//
// Chromium is needed only for the badge: it is client-side state produced by executed JS, not a
// property of the HTML string (learnings#probe-must-exercise-the-real-consuming-client). Same
// harness shape as test/serve.shell-ux.test.ts, including its browserPromise teardown fix.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { prReferentFromIssueText } from "../src/lib/escalate.js";
import { buildEscalationReconcileCandidates } from "../src/run-task.js";
import { runEscalationReconcile } from "../src/lib/sweep.js";
import { shellBootReady } from "./setup/open-shell.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

const READ_TOKEN = "dy-read-token";
const WRITE_TOKEN = "dy-write-token";
/** A token that is PRESENT but not the server's — the whole point of the trap-1 lock below. */
const WRONG_WRITE_TOKEN = "dy-not-the-write-token";

// ── shared fixtures ──────────────────────────────────────────────────────────────────

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
  const root = mkdtempSync(join(tmpdir(), "rmd-dy-"));
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
// Await the PROMISE, never the resolved handle — see test/serve.shell-ux.test.ts's own note: a
// zero-match `--test-name-pattern` run fires `after` while `chromium.launch()` is still in flight,
// and closing an undefined handle leaks the browser that lands a moment later.
let browserPromise: Promise<Browser> | undefined;
before(async () => {
  browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  browser = await browserPromise;
});
after(async () => {
  const launched = await browserPromise;
  await launched?.close();
});

/** Open the shell, optionally seeding a write token into sessionStorage BEFORE the page's own
 *  script runs — which is exactly the state of a tab where the operator pasted one earlier. The
 *  token never rides the URL (W1-T202); only the read token does. */
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

/** The badge's rendered state — the text an operator actually reads, plus the discriminant. */
async function badge(page: Page): Promise<{ state: string; text: string }> {
  return await page.evaluate(() => {
    const el = document.getElementById("write-state-badge");
    return { state: el?.dataset.writeState ?? "ABSENT", text: el?.textContent ?? "" };
  });
}

// ── DEFECT 1 ─────────────────────────────────────────────────────────────────────────

test("with no write token the console renders a clear read-only state in its header", async () => {
  const deps = fixtureDeps();
  await withShell(deps, async (base) => {
    const page = await openShell(base); // no token seeded — a fresh tab, the common case
    const b = await badge(page);

    assert.equal(b.state, "read-only", `data-write-state; saw ${JSON.stringify(b)}`);
    // The exact words matter: this is the thing the operator was never shown.
    assert.match(b.text, /READ-ONLY/);
    assert.match(b.text, /no write token in this tab/);
    assert.match(b.text, /every write control is disabled/);
    // ...and it names the remedy, so the operator does not have to know the verb by heart.
    assert.match(b.text, /rmd console-url --write/);

    // It is in the HEADER, above NEEDS ME — the placement IS the fix. The old statement lived in
    // the Fleet-control section, eleventh on the page, which is why it was never seen.
    const placement = await page.evaluate(() => {
      const el = document.getElementById("write-state-badge");
      const needsMe = document.getElementById("needs-me");
      return {
        inHeader: el?.closest("header") !== null && el?.closest("header") !== undefined,
        aboveNeedsMe: !!(el && needsMe) && !!(el!.compareDocumentPosition(needsMe!) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    assert.equal(placement.inHeader, true, "the badge is inside <header>");
    assert.equal(placement.aboveNeedsMe, true, "the badge precedes the NEEDS ME section in document order");
    await page.close();
  });
});

test("with a WRONG write token the console reports rejected, not enabled", async () => {
  const deps = fixtureDeps();
  await withShell(deps, async (base) => {
    // A token IS present in sessionStorage. Any indicator that answers "can I write?" by testing
    // for the PRESENCE of a token string renders this green and misleads the operator in a new
    // way — the trap this test exists to lock shut. The badge instead reflects the RESULT of
    // GET /v1/auth/scope, which rejects this token with a 401.
    const page = await openShell(base, WRONG_WRITE_TOKEN);

    const held = await page.evaluate(() => window.sessionStorage.getItem("rmd-console-write-token"));
    assert.equal(held, WRONG_WRITE_TOKEN, "a token really is held — otherwise this proves nothing");

    const b = await badge(page);
    assert.equal(b.state, "rejected", `data-write-state; saw ${JSON.stringify(b)}`);
    assert.match(b.text, /REJECTED/);
    assert.doesNotMatch(b.text, /enabled/i, "a rejected token must never read as enabled");

    // And the capability is genuinely off, not merely described as off.
    const disabled = await page.evaluate(() => document.getElementById("pause-btn")?.hasAttribute("disabled"));
    assert.equal(disabled, true, "write controls stay disabled under a rejected token");
    await page.close();
  });
});

test("with a valid write token the console reports write access and the write controls are live", async () => {
  const deps = fixtureDeps();
  await withShell(deps, async (base) => {
    const page = await openShell(base, WRITE_TOKEN);
    const b = await badge(page);

    assert.equal(b.state, "write", `data-write-state; saw ${JSON.stringify(b)}`);
    assert.match(b.text, /Write access enabled/);
    // It names what became possible, so "enabled" is checkable against the controls themselves.
    assert.match(b.text, /Mark handled/);

    const disabled = await page.evaluate(() => document.getElementById("pause-btn")?.hasAttribute("disabled"));
    assert.equal(disabled, false, "write controls are live under an accepted token");
    await page.close();
  });
});

// ── DEFECT 2 ─────────────────────────────────────────────────────────────────────────

const ISSUE_BODY = (taskId: string, pr: number): string =>
  [
    "**Class:** BLOCKED",
    `**Task:** ${taskId}`,
    "**Run:** DAEMON-1784894408516",
    "",
    `Task ${taskId}, PR #${pr} (https://github.com/craigoley/remudero/pull/${pr}): not positively mergeable — escalating.`,
  ].join("\n");

/** The reconciler's candidate builder, driven entirely through its injected seams. */
function candidatesFor(plan: Plan, issue: { number: number; url: string; title?: string; body?: string }, byRef: Record<string, PrRef>) {
  const root = mkdtempSync(join(tmpdir(), "rmd-dy-rec-"));
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  return buildEscalationReconcileCandidates("o", "r", plan, ledgerPath, undefined, {
    issues: { listOpen: () => [issue] } as never,
    github: fakeGitHub(byRef),
  });
}

test("an escalation whose referenced PR is merged is retirable even when its task id is not in the plan", async () => {
  // The live shape: a triage id minted outside the plan, so `plan.byId.get()` is undefined, and NOT
  // in the `PR-<n>` form PR #1041's escape covers. Before impl-DY this issue was dropped on the
  // floor and could never be retired by the machine, however long ago its PR landed — which is how
  // TRIAGE-fb-1784732687221-3be743 (PR #707) survived a hand-cleanup of 55 siblings.
  const taskId = "TRIAGE-fb-1784732687221-3be743";
  const plan = planOf([task({ id: "W1-T3" })]);
  assert.equal(plan.byId.has(taskId), false, "the premise: the plan does not own this id");

  const cands = candidatesFor(
    plan,
    { number: 708, url: "https://github.com/craigoley/remudero/issues/708", body: ISSUE_BODY(taskId, 707) },
    { "707": { number: 707, url: "https://github.com/craigoley/remudero/pull/707", state: "MERGED" } },
  );

  assert.equal(cands.length, 1, "a candidate is produced at all");
  assert.equal(cands[0].taskId, taskId);
  assert.equal(cands[0].derived.merged, true, "resolved from the PR named in the issue body");
  assert.equal(cands[0].derived.indeterminate, undefined);
  assert.equal(cands[0].derived.source, "pr-referent-from-issue-text");

  // ...and the reconciler actually closes it, which is the property the operator asked for.
  const closed: string[] = [];
  const summary = await runEscalationReconcile(cands, {
    closeIssue: (url) => void closed.push(url),
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-dy-l-")), "l.ndjson"),
    runId: "DY",
    appendLine: () => {},
  });
  assert.equal(summary.closed, 1);
  assert.deepEqual(closed, ["https://github.com/craigoley/remudero/issues/708"]);
});

test("an escalation whose referenced PR is still open is NOT retirable", async () => {
  // THE SAFETY LOCK. Reading a referent out of the issue text widens what the reconciler can act
  // on, so it must not widen what it acts on WRONGLY: closing a live escalation is worse than the
  // silence being fixed. An OPEN referent is a live decision and stays open.
  const taskId = "TRIAGE-fb-9999999999999-abcdef";
  const plan = planOf([task({ id: "W1-T3" })]);

  const cands = candidatesFor(
    plan,
    { number: 900, url: "https://github.com/craigoley/remudero/issues/900", body: ISSUE_BODY(taskId, 899) },
    { "899": { number: 899, url: "https://github.com/craigoley/remudero/pull/899", state: "OPEN" } },
  );

  assert.equal(cands.length, 1);
  assert.equal(cands[0].derived.merged, false);
  assert.equal(cands[0].derived.closed, false);

  const closed: string[] = [];
  const summary = await runEscalationReconcile(cands, {
    closeIssue: (url) => void closed.push(url),
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-dy-l2-")), "l.ndjson"),
    runId: "DY",
    appendLine: () => {},
  });
  assert.equal(summary.closed, 0, "nothing was closed");
  assert.deepEqual(closed, [], "the live escalation was left alone");
  assert.equal(summary.results[0].outcome, "left-live");
});

test("an unreadable referent is indeterminate, so a read failure never closes an escalation", () => {
  // Same fail-closed polarity deriveStatus itself uses: a gateway that cannot answer yields
  // indeterminate, never a confident "not merged" and never a confident "merged".
  const plan = planOf([task({ id: "W1-T3" })]);
  const cands = candidatesFor(
    plan,
    { number: 901, url: "https://github.com/craigoley/remudero/issues/901", body: ISSUE_BODY("TRIAGE-fb-1-x", 898) },
    {}, // prByRef returns null for everything
  );
  assert.equal(cands.length, 1);
  assert.equal(cands[0].derived.indeterminate, true);
  assert.equal(cands[0].derived.merged, false);
});

test("an escalation naming no pull request at all is left to a human", () => {
  const plan = planOf([task({ id: "W1-T3" })]);
  const cands = candidatesFor(
    plan,
    { number: 902, url: "https://github.com/craigoley/remudero/issues/902", body: "**Class:** MANUAL\n**Task:** MOUNT-PROBE-1\n\nNo pull request is involved here." },
    {},
  );
  assert.deepEqual(cands, [], "no referent, no candidate — genuinely human territory");
});

test("prReferentFromIssueText reads a pull-request url and refuses a bare hash reference", () => {
  assert.equal(prReferentFromIssueText("see https://github.com/craigoley/remudero/pull/707 for context"), 707);
  assert.equal(prReferentFromIssueText(ISSUE_BODY("T", 775)), 775);
  // A bare "#707" is ambiguous between an issue and a pull request on GitHub, and escalation
  // bodies routinely cite sibling ISSUE numbers — resolving one as a PR could retire a live
  // escalation against an unrelated referent.
  assert.equal(prReferentFromIssueText("blocked by #707 and issue 707"), undefined);
  assert.equal(prReferentFromIssueText("https://github.com/o/r/issues/707"), undefined);
  assert.equal(prReferentFromIssueText(undefined), undefined);
  assert.equal(prReferentFromIssueText(""), undefined);
});
