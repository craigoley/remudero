// test/decision-summary.test.ts — W1-T313: "every decision surface renders raw
// triage-architect analysis" (operator directive, fb-1784770111145-cf7c24). A decision card
// must OPEN with a machine-written plain-language summary (headline / what happened / the
// decision, imperative / 2-3 labelled options with consequences), generated ONCE at
// escalation-and-proposal creation time and cached with the artifact, with the raw payload
// kept byte-identical behind an expandable Details.
//
// Covers all five acceptance criteria (plan/tasks.d/W1-T313-decision-summary-at-creation.yaml):
//   1. a triage proposal writes a structured, bounds-validated summary onto the feedback entry
//      at proposal time.
//   2. an escalation's issue body carries the summary ABOVE the raw detail, with the
//      escalation's OWN options passed through verbatim (never paraphrased).
//   3. the console decision card renders the summary first, raw payload byte-identical behind
//      an expandable Details -- proven over a REAL browser (learnings#probe-must-exercise-the-
//      real-consuming-client), the same discipline test/accept-status-consumed.test.ts uses.
//   4. a failed/unavailable/invalid summarizer degrades to today's raw rendering and never
//      blocks capture, triage, escalation, or a status transition.
//   5. the summary is written once at creation and read from the cache thereafter -- a console
//      render never invokes the summarizer.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  buildDecisionSummaryPrompt,
  buildDecisionSummarySpawnArgs,
  captureFeedback,
  listFeedback,
  proposeFeedbackWithSummary,
  readFeedbackEntry,
  realDecisionSummarizer,
  resolveDecisionSummaryMount,
  setFeedbackStatus,
  summarizeFeedbackProposal,
  validateDecisionSummary,
  type DecisionSummary,
  type SummarizeDeps,
} from "../src/lib/feedback.js";
import { escalate, renderIssueBody, summarizeEscalation, type Escalation, type IssueGateway } from "../src/lib/escalate.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { shellBootReady } from "./setup/open-shell.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import { validateMounts, type Mount } from "../src/lib/mounts.js";
import type { spawnWorker, WorkerResult } from "../src/lib/worker.js";

// ── Shared fixtures ───────────────────────────────────────────────────────────

function root(): string {
  return mkdtempSync(join(tmpdir(), "rmd-decision-summary-"));
}

/** A well-formed decision-summary PAYLOAD (the shape a raw summarizer response takes, before
 *  {@link validateDecisionSummary} ever sees it) -- every field overridable per-test. */
function validSummaryPayload(
  over: Partial<{
    headline: unknown;
    what_happened: unknown;
    decision: unknown;
    options: unknown;
  }> = {},
) {
  return {
    headline: "Decide whether to ship the simpler export design",
    what_happened: "An operator asked for CSV export; two designs are on the table.",
    decision: "Ship the simpler CSV-only design first.",
    options: [
      { label: "csv-only", consequence: "ships this week, no JSON support yet" },
      { label: "csv+json", consequence: "ships in three weeks, covers both formats" },
    ],
    ...over,
  };
}

function fakeSummarizeDeps(result: unknown): SummarizeDeps {
  return { summarize: async () => result };
}

function throwingSummarizeDeps(): SummarizeDeps {
  return {
    summarize: async () => {
      throw new Error("summarizer unavailable");
    },
  };
}

// ── validateDecisionSummary — the structural bounds (criterion 1) ───────────

test("validateDecisionSummary: a well-formed record round-trips with whitespace trimmed", () => {
  const out = validateDecisionSummary(validSummaryPayload({ headline: "  Decide now  " }));
  assert.ok(out);
  assert.equal(out.headline, "Decide now");
  assert.equal(out.options.length, 2);
  assert.deepEqual(out.options[0], { label: "csv-only", consequence: "ships this week, no JSON support yet" });
});

test("validateDecisionSummary: a headline over 15 words is rejected", () => {
  const longHeadline = new Array(16).fill("word").join(" ");
  assert.equal(validateDecisionSummary(validSummaryPayload({ headline: longHeadline })), null);
});

test("validateDecisionSummary: a headline of exactly 15 words is accepted (the boundary itself is not the violation)", () => {
  const headline = new Array(15).fill("word").join(" ");
  assert.ok(validateDecisionSummary(validSummaryPayload({ headline })));
});

test("validateDecisionSummary: a decision phrased as a question is rejected -- not imperative", () => {
  assert.equal(validateDecisionSummary(validSummaryPayload({ decision: "Should we ship this?" })), null);
});

test("validateDecisionSummary: fewer than 2 options is rejected", () => {
  assert.equal(
    validateDecisionSummary(validSummaryPayload({ options: [{ label: "only", consequence: "one choice" }] })),
    null,
  );
});

test("validateDecisionSummary: more than 3 options is rejected", () => {
  const four = [0, 1, 2, 3].map((i) => ({ label: `opt${i}`, consequence: `consequence ${i}` }));
  assert.equal(validateDecisionSummary(validSummaryPayload({ options: four })), null);
});

test("validateDecisionSummary: an option consequence spanning multiple lines is rejected -- must be one line", () => {
  assert.equal(
    validateDecisionSummary(
      validSummaryPayload({ options: [{ label: "a", consequence: "line one\nline two" }, { label: "b", consequence: "ok" }] }),
    ),
    null,
  );
});

test("validateDecisionSummary: a bare string (free prose) is rejected -- never stored as free prose", () => {
  assert.equal(validateDecisionSummary("just a paragraph of prose describing the situation, not a structured record"), null);
});

test("validateDecisionSummary: missing what_happened is rejected", () => {
  assert.equal(validateDecisionSummary(validSummaryPayload({ what_happened: "" })), null);
});

// ── Criterion 1: a triage proposal writes a structured summary at proposal time ─────────────

test("W1-T313 criterion 1: a triage proposal writes a bounds-validated structured summary onto the feedback entry, persisted to disk", async () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "the console is really wordy and hard to understand", origin: "cli" });
  const deps = fakeSummarizeDeps(validSummaryPayload());

  const proposed = await proposeFeedbackWithSummary(r, entry.id, deps, { proposalPr: "https://github.com/o/r/pull/1" });

  assert.equal(proposed.status, "proposed");
  assert.ok(proposed.summary);
  assert.equal(proposed.summary.headline, "Decide whether to ship the simpler export design");
  assert.equal(proposed.summary.options.length, 2);

  // Persisted to DISK, not just in-memory — read it back fresh, the same way a later render does.
  const reread = readFeedbackEntry(r, entry.id);
  assert.deepEqual(reread.summary, proposed.summary);
});

test("W1-T313 criterion 1: a summary that fails validation is stored as null -- never as free prose", async () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "raw text", origin: "cli" });
  const deps = fakeSummarizeDeps("just some free-form prose, not a structured record");

  const proposed = await proposeFeedbackWithSummary(r, entry.id, deps);

  assert.equal(proposed.status, "proposed", "the transition still happens — a bad summary never blocks it");
  assert.equal(proposed.summary, null);
});

// ── Real production wiring: routed via mounts.yaml, never a hard-coded model id ─────────────
// Mirrors test/risk-judge.test.ts's own split exactly: buildDecisionSummaryPrompt and
// buildDecisionSummarySpawnArgs are pure and fully unit-tested; realDecisionSummarizer is
// exercised with an INJECTED fake spawn (never a real shell-out) covering its success,
// no-JSON-found, and malformed-JSON branches.

function goodMounts() {
  return validateMounts({
    tiers: { haiku: 1, sonnet: 2, opus: 3 },
    efforts: { low: 1, medium: 2, high: 3 },
    architect: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    judge: { model: "opus", effort: "high", max_turns: 60, context_budget: 150000 },
    synthesis: {
      retro: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
      triage: { model: "opus", effort: "low", max_turns: 60, context_budget: 180000 },
      inbox_draft: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    },
    routes: {
      implement: {
        low: { src: { model: "sonnet", effort: "medium", max_turns: 30, context_budget: 120000 } },
        high: { src: { model: "sonnet", effort: "high", max_turns: 50, context_budget: 180000 } },
      },
      recon: {
        low: { src: { model: "haiku", effort: "medium", max_turns: 20, context_budget: 60000 } },
      },
    },
  });
}

function fakeWorkerResult(text: string): WorkerResult {
  return {
    sessionId: "s-decision-summary",
    costUsd: 0.001,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "haiku",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

test("buildDecisionSummaryPrompt embeds the given context and instructs a JSON-only, structured response", () => {
  const prompt = buildDecisionSummaryPrompt({ context: "the console is really wordy and hard to understand" });
  assert.match(prompt, /the console is really wordy and hard to understand/);
  assert.match(prompt, /ONLY a JSON object/);
  assert.match(prompt, /headline/);
  assert.match(prompt, /IMPERATIVE instruction, never a question/);
  assert.match(prompt, /2-3 entries/);
});

test("buildDecisionSummarySpawnArgs carries an EMPTY tool list and the resolved mount's model/effort/maxTurns — the judge cannot write/edit, by construction", () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const input = { context: "some raw text" };
  const args = buildDecisionSummarySpawnArgs({ input, mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json" });

  assert.deepEqual(args.tools, []);
  assert.equal(args.model, "haiku");
  assert.equal(args.effort, "medium");
  assert.equal(args.maxTurns, 20);
  assert.equal(args.cwd, "/tmp/x");
  assert.equal(args.settingsFile, "/tmp/settings.json");
  assert.equal(args.permissionMode, "bypassPermissions");
  assert.equal(args.prompt, buildDecisionSummaryPrompt(input));
});

test("realDecisionSummarizer parses a JSON object out of the worker's response text and returns it", async () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const calls: unknown[] = [];
  const responseObject = { headline: "Decide now", what_happened: "context", decision: "act", options: [] };
  const spawn = (async (args: unknown) => {
    calls.push(args);
    return fakeWorkerResult(`Here is the JSON:\n${JSON.stringify(responseObject)}\nthanks`);
  }) as typeof spawnWorker;

  const summarize = realDecisionSummarizer({ mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  const out = await summarize({ context: "raw text" });

  assert.equal(calls.length, 1, "calls the injected spawn exactly once");
  assert.deepEqual(
    calls[0],
    buildDecisionSummarySpawnArgs({ input: { context: "raw text" }, mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json" }),
  );
  assert.deepEqual(out, responseObject);
});

test("realDecisionSummarizer returns null when the worker's response contains no JSON object at all", async () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const spawn = (async () => fakeWorkerResult("sorry, I could not summarize this")) as typeof spawnWorker;
  const summarize = realDecisionSummarizer({ mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  assert.equal(await summarize({ context: "raw text" }), null);
});

test("realDecisionSummarizer returns null when the extracted braces are not valid JSON", async () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const spawn = (async () => fakeWorkerResult("{not: valid, json}")) as typeof spawnWorker;
  const summarize = realDecisionSummarizer({ mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  assert.equal(await summarize({ context: "raw text" }), null);
});

test("resolveDecisionSummaryMount resolves the CHEAPEST configured tier — reused from risk-judge.ts, never a hard-coded model id", () => {
  const mount = resolveDecisionSummaryMount(goodMounts());
  assert.equal(mount.model, "haiku");
  assert.deepEqual(mount, { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 });
});

// ── Criterion 2: escalation issue body carries the summary above raw detail,  ───────────────
// options passed through verbatim, never paraphrased.

function escalationFixture(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-TX",
    summary: "two strikes exhausted",
    detail: "the diagnose-armed retry still failed CI after a fresh worker retried it twice.",
    options: [
      { label: "retry", detail: "resume the run with a fresh worker" },
      { label: "abandon", detail: "drop the task and re-plan" },
    ],
    recommendation: "retry",
    ...over,
  };
}

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-decision-summary-escalate-")), "ledger.ndjson");
}

function fakeIssues(url = "https://github.com/o/r/issues/1"): IssueGateway & {
  calls: Array<{ title: string; body: string; labels: string[] }>;
} {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return url;
    },
  };
}

test("W1-T313 criterion 2: the escalation's decision summary carries the escalation's OWN options verbatim, discarding whatever the summarizer proposed", async () => {
  const e = escalationFixture();
  // A deliberately BOGUS, paraphrased options list the fake summarizer proposes — must never
  // survive into the final summary.
  const deps: SummarizeDeps = {
    summarize: async () => ({
      headline: "Decide how to proceed after CI keeps failing",
      what_happened: "The diagnose-armed retry still failed CI twice in a row.",
      decision: "Retry once more with a fresh worker.",
      options: [
        { label: "paraphrased-retry", consequence: "a made-up label the model invented" },
        { label: "paraphrased-abandon", consequence: "another made-up label" },
      ],
    }),
  };

  const summary = await summarizeEscalation(e, deps);

  assert.ok(summary);
  assert.deepEqual(
    summary.options,
    [
      { label: "retry", consequence: "resume the run with a fresh worker" },
      { label: "abandon", consequence: "drop the task and re-plan" },
    ],
    "options are e.options mapped verbatim — never the summarizer's own paraphrase",
  );
});

test("W1-T313 criterion 2: renderIssueBody puts the decision summary ABOVE the raw detail, which stays byte-identical", async () => {
  const e = escalationFixture();
  const deps: SummarizeDeps = {
    summarize: async () => ({
      headline: "Decide how to proceed after CI keeps failing",
      what_happened: "The diagnose-armed retry still failed CI twice in a row.",
      decision: "Retry once more with a fresh worker.",
      options: [],
    }),
  };
  const summary = await summarizeEscalation(e, deps);
  assert.ok(summary);

  const withSummary = renderIssueBody({ ...e, decisionSummary: summary });
  const withoutSummary = renderIssueBody(e);

  // The raw detail text is present, unchanged, in BOTH renderings.
  assert.ok(withSummary.includes(e.detail));
  assert.ok(withoutSummary.includes(e.detail));

  // The summary headline appears strictly BEFORE the raw detail in the summary rendering.
  const headlineIdx = withSummary.indexOf(summary.headline);
  const detailIdx = withSummary.indexOf(e.detail);
  assert.ok(headlineIdx >= 0 && headlineIdx < detailIdx, "the summary sits above the raw detail");

  // Without a decisionSummary, the body is EXACTLY what it was before this task (no drift),
  // aside from the `**Host:**` line W1-T972 now writes unconditionally on every issue.
  assert.equal(
    withoutSummary,
    [
      `**Class:** ${e.class}`,
      `**Task:** ${e.taskId}`,
      `**Host:** ${hostname()}`,
      "",
      e.detail,
      "",
      "## Options",
      "- **retry** — resume the run with a fresh worker",
      "- **abandon** — drop the task and re-plan",
      "",
      "## Recommendation",
      e.recommendation,
      "",
      "_Opened automatically by Remudero (MASTER-PLAN §4 escalation taxonomy). Closing this issue does_",
      "_not resolve the underlying block by itself — act on it, then resume via `rmd drain`._",
    ].join("\n"),
  );
});

test("W1-T313 criterion 2: renderIssueBody's summary block never duplicates the options section -- those already render e.options verbatim", async () => {
  const e = escalationFixture();
  const summary = await summarizeEscalation(e, fakeSummarizeDeps(validSummaryPayload()));
  assert.ok(summary);
  const body = renderIssueBody({ ...e, decisionSummary: summary });
  // "## Options" appears exactly once — the summary block does not repeat it.
  assert.equal(body.split("## Options").length - 1, 1);
});

// ── Criterion 4: fail-open — a failed/unavailable/invalid summarizer never blocks anything ──

test("W1-T313 criterion 4: a summarizer that throws degrades to null and never blocks the proposed transition", async () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "raw text", origin: "cli" });
  const proposed = await proposeFeedbackWithSummary(r, entry.id, throwingSummarizeDeps());
  assert.equal(proposed.status, "proposed");
  assert.equal(proposed.summary, null);
});

test("W1-T313 criterion 4: summarizeFeedbackProposal itself never throws, whatever deps.summarize does (throw, reject, or garbage)", async () => {
  const rejecting: SummarizeDeps = { summarize: () => Promise.reject(new Error("timeout")) };
  await assert.doesNotReject(async () => {
    const result = await summarizeFeedbackProposal({ raw: "x" }, rejecting);
    assert.equal(result, null);
  });

  const garbage: SummarizeDeps = { summarize: async () => 42 };
  assert.equal(await summarizeFeedbackProposal({ raw: "x" }, garbage), null);
});

test("W1-T313 criterion 4: setFeedbackStatus never blocks a status transition when no summarize dep is given at all", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "raw text", origin: "cli" });
  const updated = setFeedbackStatus(r, entry.id, "proposed", { proposalPr: "https://github.com/o/r/pull/2" });
  assert.equal(updated.status, "proposed");
  assert.equal(updated.summary, null, "captureFeedback's own null default is preserved, unchanged");
});

test("W1-T313 criterion 4: a failed/unavailable escalation summarizer never blocks escalation delivery -- the issue still opens, with the raw-only body", async () => {
  const e = escalationFixture();
  const failedSummary = await summarizeEscalation(e, throwingSummarizeDeps());
  assert.equal(failedSummary, null);

  const issues = fakeIssues();
  const url = escalate({ ...e, decisionSummary: failedSummary }, { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });

  assert.equal(url, "https://github.com/o/r/issues/1");
  assert.equal(issues.calls.length, 1);
  assert.doesNotMatch(issues.calls[0].body, /## Decision Summary/, "no summary block when the summarizer failed — exactly today's raw rendering");
  assert.ok(issues.calls[0].body.includes(e.detail), "the raw detail still renders, untouched");
});

test("W1-T313 criterion 4: a summarizer whose response fails the DecisionSummary bounds degrades to null on an escalation too", async () => {
  const e = escalationFixture();
  const tooManyWords: SummarizeDeps = {
    summarize: async () => ({
      headline: new Array(20).fill("word").join(" "),
      what_happened: "context",
      decision: "act now",
      options: [],
    }),
  };
  assert.equal(await summarizeEscalation(e, tooManyWords), null);
});

// ── Criterion 5: written once at creation, read from cache thereafter ───────────────────────

test("W1-T313 criterion 5: the summary is written once at creation -- re-reading the entry never re-invokes the summarizer", async () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "raw text", origin: "cli" });
  let calls = 0;
  const deps: SummarizeDeps = {
    summarize: async () => {
      calls++;
      return validSummaryPayload();
    },
  };

  await proposeFeedbackWithSummary(r, entry.id, deps);
  assert.equal(calls, 1);

  // Three separate "renders" — readFeedbackEntry/listFeedback, the SAME reads a console poll
  // makes — see the SAME cached summary and never call the summarizer again.
  readFeedbackEntry(r, entry.id);
  listFeedback(r, {});
  readFeedbackEntry(r, entry.id);
  assert.equal(calls, 1, "no re-invocation on subsequent reads");
});

test("W1-T313 criterion 5 (structural): the client's decision-summary renderer is synchronous and makes no network calls by construction", () => {
  const src = readFileSync(new URL("../src/lib/serve.ts", import.meta.url), "utf8");
  const match = /function decisionSummaryHtml\(e, rawHtml\) \{[\s\S]*?\n  \}/.exec(src);
  assert.ok(match, "decisionSummaryHtml is defined in serve.ts's client script");
  assert.doesNotMatch(match[0], /await |fetch\(|async /, "purely synchronous string building — reads the cache, never invokes a summarizer");
});

// ── Criterion 3 + console-side criterion 4/5: proven over a REAL browser ────────────────────
// (learnings#probe-must-exercise-the-real-consuming-client — the same discipline
// test/accept-status-consumed.test.ts already uses for NEEDS ME rows).

const READ_TOKEN = "decision-summary-read-token";
const WRITE_TOKEN = "decision-summary-write-token";

function emptyPlan(): Plan {
  return { tasks: [], byId: new Map() };
}
function fakeGitHub(): GitHub {
  return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined } as GitHub;
}
function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}
function fakeIssueCloser(): IssueCloser {
  return { close() {} };
}
function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-decision-summary-console-"));
}
function fixtureDeps(rootDir: string): ServeDeps {
  const ledgerPathFile = join(rootDir, "ledger.ndjson");
  const github = fakeGitHub();
  const planPath = join(rootDir, "plan", "tasks.yaml");
  mkdirSync(join(rootDir, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n");
  return {
    board: { plan: emptyPlan(), ledgerPath: ledgerPathFile, github },
    panelGraph: { root: rootDir, planPath, ledgerPath: ledgerPathFile, github: fakeTraceGithub(), statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath: ledgerPathFile,
    issues: fakeIssueCloser(),
    fleetControlRoot: rootDir,
    questionsRoot: rootDir,
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
  await page.addInitScript((writeToken) => {
    window.sessionStorage.setItem("rmd-console-write-token", writeToken);
  }, WRITE_TOKEN);
  await page.goto(`${base}/?token=${READ_TOKEN}`);
  await page.waitForFunction(shellBootReady);
  return { context, page };
}

function decisionSummaryFixture(): DecisionSummary {
  const s = validateDecisionSummary(validSummaryPayload({ headline: "Simplify the console's wording" }));
  if (!s) throw new Error("fixture itself must validate");
  return s;
}

test("W1-T313 criterion 3: a proposed entry WITH a cached summary renders the summary first, raw payload byte-identical but collapsed behind Details", async () => {
  const r = tmpRoot();
  const deps = fixtureDeps(r);
  const entry = captureFeedback(r, { raw: "console is really wordy and hard to understand, RAW-PAYLOAD-MARKER", origin: "cli" });
  setFeedbackStatus(r, entry.id, "proposed", { proposalPr: "https://github.com/o/r/pull/1", summary: decisionSummaryFixture() });

  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => (document.getElementById("needs-me-list")?.textContent ?? "").includes("Simplify the console's wording"));

      const visibleText = await page.locator("#needs-me-list").innerText();
      // The falsifier: a card whose FIRST text is the raw payload. The raw marker text is not
      // part of the VISIBLE text while the <details> stays collapsed.
      assert.doesNotMatch(visibleText, /RAW-PAYLOAD-MARKER/, "the raw payload is not visible text while <details> is collapsed");
      assert.match(visibleText, /Simplify the console's wording/, "the summary headline is visible");

      // But the raw payload is still THERE, byte-identical, one click away.
      const html = await page.locator("#needs-me-list").innerHTML();
      assert.match(html, /RAW-PAYLOAD-MARKER/, "the raw payload is present in the DOM, just collapsed");
      assert.match(html, /<details class="decision-raw">/, "behind an expandable Details");

      await page.click(`#needs-me-list details.decision-raw summary`);
      const afterExpand = await page.locator("#needs-me-list").innerText();
      assert.match(afterExpand, /RAW-PAYLOAD-MARKER/, "expanding Details reveals the byte-identical raw payload");
    } finally {
      await context.close();
    }
  });
});

test("W1-T313 criterion 4 (console): a proposed entry with NO cached summary renders exactly as before -- raw payload directly, no summary wrapper", async () => {
  const r = tmpRoot();
  const deps = fixtureDeps(r);
  const entry = captureFeedback(r, { raw: "an entry with no summary yet", origin: "cli" });
  setFeedbackStatus(r, entry.id, "proposed", { proposalPr: "https://github.com/o/r/pull/2" });

  await withShell(deps, async (base) => {
    const { context, page } = await openShell(base);
    try {
      await page.waitForFunction(() => (document.getElementById("needs-me-list")?.textContent ?? "").includes("an entry with no summary yet"));
      const visibleText = await page.locator("#needs-me-list").innerText();
      assert.match(visibleText, /proposes: an entry with no summary yet/, "degrades to exactly today's raw rendering");
      const html = await page.locator("#needs-me-list").innerHTML();
      assert.doesNotMatch(html, /decision-summary/, "no summary wrapper when there is no cached summary");
    } finally {
      await context.close();
    }
  });
});

test("W1-T313 criterion 5 (console): rendering a cached summary triggers NO extra network requests -- the console render never invokes the summarizer", async () => {
  const rootWith = tmpRoot();
  const depsWith = fixtureDeps(rootWith);
  const withSummaryEntry = captureFeedback(rootWith, { raw: "entry with summary", origin: "cli" });
  setFeedbackStatus(rootWith, withSummaryEntry.id, "proposed", { proposalPr: "https://github.com/o/r/pull/3", summary: decisionSummaryFixture() });

  const rootWithout = tmpRoot();
  const depsWithout = fixtureDeps(rootWithout);
  const withoutSummaryEntry = captureFeedback(rootWithout, { raw: "entry without summary", origin: "cli" });
  setFeedbackStatus(rootWithout, withoutSummaryEntry.id, "proposed", { proposalPr: "https://github.com/o/r/pull/4" });

  const pathsFor = (deps: ServeDeps, waitText: string): Promise<string[]> =>
    withShell(deps, async (base) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const paths: string[] = [];
      page.on("request", (req) => {
        const url = new URL(req.url());
        if (url.hostname === "127.0.0.1") paths.push(url.pathname);
      });
      await page.addInitScript((writeToken) => {
        window.sessionStorage.setItem("rmd-console-write-token", writeToken);
      }, WRITE_TOKEN);
      await page.goto(`${base}/?token=${READ_TOKEN}`);
      await page.waitForFunction(shellBootReady);
      await page.waitForFunction((t) => (document.getElementById("needs-me-list")?.textContent ?? "").includes(t), waitText);
      await context.close();
      return Array.from(new Set(paths)).sort();
    });

  const withSummaryPaths = await pathsFor(depsWith, "entry with summary");
  const withoutSummaryPaths = await pathsFor(depsWithout, "entry without summary");

  assert.deepEqual(
    withSummaryPaths,
    withoutSummaryPaths,
    "the SAME set of routes fires whether or not the entry carries a cached summary — no extra work at render time",
  );
});
