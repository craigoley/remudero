// test/serve-self-measurement.test.ts — W1-T2660: "the fleet measures itself four times a day
// and no surface shows it". `measurement_cadence.ran` rows have carried rule-efficacy,
// verdict-calibration, autonomy-rate, adoption, proof-debt and the verb census since
// 2026-09-02, and nothing in serve.ts/board.ts/status-board.ts/digest.ts ever read one back.
// This suite proves the ONE panel that now does, against a REAL browser over a REAL server
// (learnings#probe-must-exercise-the-real-consuming-client), the same discipline every other
// serve.*.test.ts suite in this repo uses for its own widget.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { shellBootReady } from "./setup/open-shell.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

const READ_TOKEN = "self-measurement-read-token";
const WRITE_TOKEN = "self-measurement-write-token";

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

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-self-measurement-"));
}

function stateDirFor(root: string): string {
  const dir = join(root, "state");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function ledgerPathFor(root: string): string {
  const dir = stateDirFor(root);
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

/** A `measurement_cadence.ran` archive rotation, PLAIN form (ledgerRotationEntries accepts a
 *  bare `.ndjson` rotation exactly as it accepts a gzipped one — see that function's own doc:
 *  "BOTH FORMS ARE LEGITIMATE"). Named with a real dated stamp so it reads as a genuine
 *  rotation, matching `rotationStampIso`'s own shape, though the union does not require the
 *  window feature this test never exercises. */
function writeMeasurementCadenceArchive(stateDir: string, stampSuffix: string, lines: Record<string, unknown>[]): void {
  const name = `ledger.2026-09-0${stampSuffix}T06-00-00-000Z.ndjson`;
  writeFileSync(join(stateDir, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
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

async function openShell(base: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/?token=${READ_TOKEN}`);
  await page.waitForFunction(shellBootReady);
  return { context, page };
}

async function rowText(page: Page, verbKey: string): Promise<string | null> {
  return await page.evaluate((key) => {
    const el = document.querySelector(`[data-verb="${key}"] .detail`);
    return el ? el.textContent : null;
  }, verbKey);
}

async function rowState(page: Page, verbKey: string): Promise<string | null> {
  return await page.evaluate((key) => {
    const el = document.querySelector(`[data-verb="${key}"]`);
    return el ? el.getAttribute("data-self-measurement-state") : null;
  }, verbKey);
}

// ── criterion 1 + criterion 2: latest figure w/ as-of + previous, off the union; refusals as
//    refusals; never-measured as never-measured, never a zero ──────────────────────────────

test("self-measurement panel: renders the latest per-verb figure with its as-of and previous value, a refusal as a refusal, and an unmeasured verb as never measured", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]);
  const stateDir = stateDirFor(root);

  // Fire 1 (older): rule-efficacy measured, autonomy-rate measured -- both become "previous" once
  // fire 2 lands. verdict-calibration never appears in EITHER fire: it must render "never measured".
  writeMeasurementCadenceArchive(stateDir, "2", [
    {
      ts: "2026-09-02T06:00:00.000Z",
      host: "fleet-1",
      run_id: "DAEMON-1",
      task_id: "DAEMON",
      step: "measurement_cadence.ran",
      lane: "daemon",
      rule_efficacy: { status: "measured", measurableCount: 10, repeatingCount: 1, repeatIncidentRate: 0.1, escalated: false, escalatedProposalIds: [] },
      autonomy_rate: { status: "measured", totalMerges: 5, zeroTouchRate: 0.4 },
    },
  ]);
  // Fire 2 (newer, the LATEST): rule-efficacy measured with a NEW figure; autonomy-rate REFUSED
  // this time (git history read failed) -- its own reason must render, never a zero, and its
  // PREVIOUS (fire 1's measured) figure must still show.
  writeMeasurementCadenceArchive(stateDir, "3", [
    {
      ts: "2026-09-03T06:00:00.000Z",
      host: "fleet-1",
      run_id: "DAEMON-2",
      task_id: "DAEMON",
      step: "measurement_cadence.ran",
      lane: "daemon",
      rule_efficacy: { status: "measured", measurableCount: 14, repeatingCount: 2, repeatIncidentRate: 0.143, escalated: false, escalatedProposalIds: [] },
      autonomy_rate: { status: "refused", refusedReason: "shallow clone — truncated history" },
    },
  ]);

  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => document.querySelectorAll("#self-measurement-list .self-measurement-row").length > 0, null, {
        timeout: 5000,
      });

      // rule-efficacy: latest figure (measurableCount 14), an as-of, and the PREVIOUS figure
      // (measurableCount 10) from fire 1 -- all three off the SAME union read.
      const ruleEfficacy = await rowText(page, "ruleEfficacy");
      assert.match(ruleEfficacy ?? "", /measurableCount: 14/, "the LATEST fire's own figure");
      assert.match(ruleEfficacy ?? "", /as of/, "every figure carries its as-of time");
      assert.match(ruleEfficacy ?? "", /previously:.*measurableCount: 10/, "the PREVIOUS fire's own figure, named as such");
      assert.equal(await rowState(page, "ruleEfficacy"), "measured");

      // autonomy-rate: the LATEST fire is a refusal -- its reason renders verbatim, never a bare
      // zero or blank -- and the previous (measured) fire's figure still shows beside it.
      const autonomyRate = await rowText(page, "autonomyRate");
      assert.match(autonomyRate ?? "", /^refused: shallow clone — truncated history/, "the refusal's own reason, rendered as a refusal, never a bare zero standing in for it");
      assert.match(autonomyRate ?? "", /previously:.*totalMerges: 5/, "the prior MEASURED fire's own figure still shows");
      assert.equal(await rowState(page, "autonomyRate"), "refused");

      // verdict-calibration never appears in either fire -- "never measured", never a 0%.
      const verdictCalibration = await rowText(page, "verdictCalibration");
      assert.equal(verdictCalibration, "never measured");
      assert.equal(await rowState(page, "verdictCalibration"), "never-measured");
    } finally {
      await context.close();
    }
  });
});

// ── criterion 3: an unreadable ledger union renders the panel as unreadable, never empty ────

test("self-measurement panel: an unreadable ledger union (zero archives) renders the whole panel as unreadable, never a quietly-empty list", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root, [task({ id: "W1-T1" })]);
  // Deliberately NO archive rotation is written -- only the empty live ledger.ndjson the fixture
  // helper already created. resolveLedgerUnion refuses (archiveCount === 0) on exactly this
  // shape (this is the W1-T119 "cannot be trusted" case, never read as "the fleet never
  // measured itself").

  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(
        () => document.querySelector('#self-measurement-list [data-self-measurement="unreadable"]') !== null,
        null,
        { timeout: 5000 },
      );
      const text = await page.evaluate(() => document.getElementById("self-measurement-list")?.textContent ?? "");
      assert.match(text, /UNREADABLE/, "the panel states unreadable, not a silent empty list");
      assert.match(text, /ledger archives/i, "names WHY -- the same union failure lib/ledger-grep.ts's own doc describes");
      // Never rendered as "never measured" (which would misreport a READ failure as a FLEET fact).
      assert.doesNotMatch(text, /never measured/);
    } finally {
      await context.close();
    }
  });
});
