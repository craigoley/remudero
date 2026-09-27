/**
 * W1-T4615: every worker call carries its assignment.
 *
 * MEASURED 2026-09-27: `review.reviewer` carried selection_assignment_id on 11% of core rows,
 * `worker.activity` carried only the mount alias as `requested_model` (3,622 Codex events read
 * 'sonnet'), and 1,317 of 1,337 archived transcripts carried `model: sonnet` in front matter,
 * including runs routed to gpt-6-sol. This file pins the four halves of the fix:
 *   1. the spawn caller census (W1-T4580) FAILS BY NAME on a spawnWorker entrypoint that no
 *      assignment receipt wraps, and the reviewer lane is inside the receipt path;
 *   2. a `worker.activity` row carries selection_assignment_id and the routed provider/model, or
 *      an explicit coverage gap when no assignment was observed;
 *   3. the reviewer's activity, `review.reviewer` row and evaluator provenance name the routed
 *      model and its assignment, not the mount alias;
 *   4. an archived transcript's front matter records routed and served model — served may be
 *      `unavailable`, never the alias.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";
import {
  spawnWorker,
  type SpawnWorkerArgs,
  type WorkerResult,
  type WorkerSelectionAssignment,
  type WorkerStreamEvent,
} from "../src/lib/worker.js";
import {
  archiveWorkerTranscript,
  attributeWorkerStreamEvent,
  buildWorkerStateSensor,
  runReview,
  WORKER_ACTIVITY_LEDGER_STEP,
  type WorkerStateSensor,
} from "../src/run-task.js";

// @source-text-subject: the census half inventories spawnWorker entrypoints in source text; its
// planted-site control proves the census names a newly unreceipted caller.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SETTINGS_FILE = join(REPO_ROOT, "settings", "worker.json");

// ─── 1. the census ─────────────────────────────────────────────────────────────────────────────

type SiteKind = "call" | "binding" | "value";
interface SpawnSite { file: string; line: number; kind: SiteKind; binding?: string; receipted: boolean }

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Blank comments, imports and string literals while preserving every newline, so a line number
 *  in the stripped text is the line number in the file. */
function codeOnly(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*import\b[\s\S]*?\bfrom\s*["'][^"'\n]+["'];?/gm, blank)
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (s) => `"${" ".repeat(s.length - 2)}"`)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (s) => `'${" ".repeat(s.length - 2)}'`)
    .replace(/\/\/[^\n]*/g, blank);
}

const RECEIPT_WRAPPER = String.raw`(?:benchmarkNonDispatchSpawn|ledgeredNonDispatchSpawn)\(\s*[^,()]+,\s*`;

/** A receipt reaches an identifier bound to spawnWorker when the SAME file hands it to a receipt
 *  wrapper, drives it through the dispatch attempt recorder, or is the wrapper installing the
 *  assignment sink itself. */
function bindingReceipted(code: string, name: string): boolean {
  return new RegExp(`${RECEIPT_WRAPPER}${name}\\s*\\)`).test(code)
    || new RegExp(String.raw`recordBenchmarkWorkerAttempt\(\s*\(\)\s*=>\s*${name}\(`).test(code)
    || new RegExp(String.raw`\b${name}\(\{\s*\.\.\.args,\s*onSelectionAssignment\b`).test(code);
}

function spawnSites(file: string, text: string): SpawnSite[] {
  const code = codeOnly(text);
  const lines = code.split("\n");
  const found: SpawnSite[] = [];
  for (const [index, line] of lines.entries()) {
    if (!/\bspawnWorker\b/.test(line) || /\bfunction\s+spawnWorker\b/.test(line)) continue;
    const at = { file, line: index + 1 };
    const bound = /\b(\w+)\s*:\s*typeof\s+spawnWorker\s*=\s*spawnWorker\b/.exec(line)
      ?? /\b(?:const|let)\s+(\w+)\b[^;]*\?\?\s*spawnWorker\b/.exec(line);
    if (bound) {
      found.push({ ...at, kind: "binding", binding: bound[1], receipted: bindingReceipted(code, bound[1]) });
      continue;
    }
    if (/\bspawnWorker\s*\(/.test(line)) {
      // Provider-fallback recursion inside spawnWorker itself: it spreads the caller's own args, so
      // the caller's assignment sink rides along. Any other direct call has no receipt.
      const spreadsArgs = file === "src/lib/worker.ts" && /^\s*\.\.\.args,/.test(lines[index + 1] ?? "");
      found.push({ ...at, kind: "call", receipted: spreadsArgs });
      continue;
    }
    const stripped = line.replace(/\btypeof\s+spawnWorker\b/g, "");
    if (/\bspawnWorker\b/.test(stripped)) {
      found.push({ ...at, kind: "value", receipted: new RegExp(`${RECEIPT_WRAPPER}spawnWorker\\s*\\)`).test(stripped) });
    }
  }
  return found;
}

function unreceipted(sites: readonly SpawnSite[]): string[] {
  return sites.filter((site) => !site.receipted)
    .map((site) => `${site.file}:${site.line} (${site.kind}${site.binding ? ` ${site.binding}` : ""})`);
}

test("a spawnWorker call site with no assignment receipt fails the census by name", () => {
  // Planted control: each shape the census knows is caught and NAMED when nothing wraps it.
  const planted = spawnSites("src/lib/new-caller.ts", [
    "export const call = () => spawnWorker({ prompt: 'x' });",
    "export function lane(raw: typeof spawnWorker = spawnWorker) { return raw({}); }",
    "export const passed = { spawn: spawnWorker };",
  ].join("\n"));
  assert.deepEqual(unreceipted(planted), [
    "src/lib/new-caller.ts:1 (call)",
    "src/lib/new-caller.ts:2 (binding raw)",
    "src/lib/new-caller.ts:3 (value)",
  ]);
  // ...and the same shapes behind a receipt pass: the census tells a wrapped site from a bare one.
  const wrapped = spawnSites("src/lib/new-caller.ts", [
    "export function lane(raw: typeof spawnWorker = spawnWorker) { return benchmarkNonDispatchSpawn(\"lane\", raw)({}); }",
    "export const measured = benchmarkNonDispatchSpawn(\"spike\", spawnWorker);",
  ].join("\n"));
  assert.deepEqual(unreceipted(wrapped), []);
  // Strings, comments and imports are not call sites.
  assert.deepEqual(spawnSites("src/lib/prose.ts", [
    "import { spawnWorker } from \"./worker.js\";",
    "// spawnWorker({}) in a comment",
    "const note = \"spawnWorker({}) in a string\";",
  ].join("\n")), []);

  const actual = sources(join(REPO_ROOT, "src"))
    .flatMap((path) => spawnSites(relative(REPO_ROOT, path).replaceAll("\\", "/"), readFileSync(path, "utf8")));
  // Positive control: the census sees the known population, so an empty failure list is a result.
  assert.ok(actual.filter((s) => s.file === "src/lib/worker.ts" && s.kind === "call").length >= 3,
    "the census sees spawnWorker's own provider-fallback recursion");
  assert.ok(actual.some((s) => s.file === "src/run-task.ts" && s.kind === "binding"),
    "the census sees run-task.ts's injected spawn defaults");
  assert.deepEqual(unreceipted(actual), [], "every spawnWorker entrypoint must reach an assignment receipt");
});

test("the reviewer lane is inside the assignment receipt path", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const start = source.indexOf("async function runReview(");
  assert.ok(start >= 0, "runReview is where the reviewer spawns");
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:export |async function |function )/);
  const body = end < 0 ? rest : rest.slice(0, end);
  assert.match(body, /args\.reviewerSpawnWorker \?\? ledgeredNonDispatchSpawn\("review"\)/,
    "the reviewer's default spawn is the receipt wrapper");
  assert.match(body, /onSelectionAssignment:\s*\(assignment\)\s*=>/,
    "the reviewer spawn observes its own assignment, whichever receipt wrapper serves it");
});

// ─── 2. worker.activity ───────────────────────────────────────────────────────────────────────

function assignment(overrides: Partial<WorkerSelectionAssignment["selected"]> = {}): WorkerSelectionAssignment {
  return {
    version: 1,
    id: "assignment-4615",
    phase: "pre-execution",
    requested: { model: "sonnet", effort: "high", maxTurns: 10 },
    selected: { provider: "codex", model: "gpt-6-sol", effort: "high", ...overrides },
    routing: { mode: "multi-provider", selectionPath: "auction", policy: { preference: "automatic", reservePercent: 10, provenance: "default" } },
    candidates: [],
  };
}

function readLedger(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("a worker.activity row carries its assignment and routed model, or names the gap", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4615-activity-`));
  try {
    const ledgerPath = join(root, "ledger.ndjson");
    const sensor = buildWorkerStateSensor({ ledgerPath, runId: "RUN-4615", taskId: "W1-T4615", root });
    const event: WorkerStreamEvent = { kind: "working", tsMs: 1_000, text: "thinking", provider: "claude", requestedModel: "sonnet" };
    sensor.observer(attributeWorkerStreamEvent(event, assignment()));
    sensor.observer(attributeWorkerStreamEvent({ kind: "message", tsMs: 2_000 }, undefined));
    const rows = readLedger(ledgerPath).filter((row) => row.step === WORKER_ACTIVITY_LEDGER_STEP);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].selection_assignment_id, "assignment-4615");
    assert.equal(rows[0].routed_provider, "codex");
    assert.equal(rows[0].routed_model, "gpt-6-sol", "the routed model rides the row, not only the alias");
    assert.equal(rows[0].requested_model, "sonnet", "the request stays the request");
    assert.equal(rows[0].served_model, undefined, "a routing choice is never promoted to a served-model receipt");
    assert.equal(rows[0].assignment_unavailable_reason, undefined);
    assert.equal(rows[1].selection_assignment_id, undefined);
    assert.equal(rows[1].routed_model, undefined);
    assert.equal(rows[1].assignment_unavailable_reason, "assignment-not-observed",
      "a row with no assignment says so rather than looking attributed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 3. the reviewer ──────────────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

interface ReviewerRun {
  observed: WorkerStreamEvent[];
  logs: Array<{ step: string; extra: Record<string, unknown> }>;
  verdict: Awaited<ReturnType<typeof runReview>>;
}

/** Drive the real runReview with a stand-in reviewer spawn. `assign` stands in for the receipt
 *  wrapper + router, which emits the assignment BEFORE the stream; `resultCarries` controls whether
 *  the worker result itself carries the assignment and routed model. */
async function reviewWith(opts: { assign: boolean; resultCarries: boolean }): Promise<ReviewerRun> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4615-reviewer-`));
  const repo = gitRepo({ kind: "w1-t4615-reviewer-source", seedCommit: false });
  const sourceDir = repo.dir;
  const oldPath = process.env.PATH;
  try {
    mkdirSync(join(sourceDir, "src"), { recursive: true });
    writeFileSync(join(sourceDir, "src", "example.ts"), "export const fixed = true;\n", "utf8");
    repo.git("add", "src/example.ts");
    repo.git("commit", "-q", "-m", "fixture");
    const headSha = repo.git("rev-parse", "HEAD");
    writeFileSync(join(root, "settings.json"), "{}\n", "utf8");
    const shim = ghShim([
      { when: "pulls/", stdout: JSON.stringify({ number: 4615, html_url: "https://github.com/acme/remudero/pull/4615", updated_at: "t", body: "fixed", state: "open", head: { ref: "b", sha: headSha } }) },
      { when: "pr diff", stdout: "diff --git a/src/example.ts b/src/example.ts\n+export const fixed = true;" },
      { when: "api ", stdout: "{}" },
    ], { kind: "w1-t4615-reviewer-gh" });
    process.env.PATH = `${shim.dir}:${oldPath}`;

    const observed: WorkerStreamEvent[] = [];
    const workerTelemetry: WorkerStateSensor = {
      observer: (event) => observed.push(event),
      startPolling: () => () => {},
      setRunawayBound: () => {},
    };
    const logs: ReviewerRun["logs"] = [];
    const reviewerSpawnWorker = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
      if (opts.assign) args.onSelectionAssignment?.(assignment());
      args.streamObserver?.({ kind: "working", tsMs: Date.now(), text: "reviewing" });
      return {
        sessionId: "codex-reviewer-4615", costUsd: 0, numTurns: 1, text: "REVIEW_VERDICT 1: PASS", blocks: [], stderr: "",
        subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
        model: "sonnet", provider: "codex", servedModel: null, effort: "high",
        ...(opts.resultCarries ? { routedModel: "gpt-6-sol", selectionAssignmentId: "assignment-4615" } : {}),
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        modelUsage: {}, compactionEvents: [], qualitySuspect: false,
      };
    };
    const verdict = await runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/4615",
      task: { id: "W1-T4615", files: ["src/example.ts"], acceptance: [{ claim: "the fixed source is present", proof: "grep: fixed in src/example.ts" }] },
      report: "the fixed source is present",
      settingsFile: join(root, "settings.json"),
      config: { claudeBin: "/unused", root } as never,
      log: (step: string, extra: Record<string, unknown> = {}) => logs.push({ step, extra }),
      say: () => {},
      account: (worker: WorkerResult) => worker,
      spawnReviewer: true,
      reviewerSpawnWorker: reviewerSpawnWorker as typeof spawnWorker,
      reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120_000 },
      workerTelemetry,
      headCheckoutDir: sourceDir,
      ledgerPath: join(root, "ledger.ndjson"),
      runId: "RUN-W1-T4615-reviewer",
      disarm: () => "not-armed" as const,
      arm: () => ({ armed: false, reason: "test" }),
    } as never);

    assert.equal(verdict.reviewerOutcome, "success", JSON.stringify(logs.find((l) => l.step === "review.reviewer.error")?.extra));
    return { observed, logs, verdict };
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    repo.cleanup();
  }
}

test("a reviewer run carries its assignment and routed model on activity, review.reviewer and provenance", async () => {
  const { observed, logs, verdict } = await reviewWith({ assign: true, resultCarries: true });
  const activity = observed.find((event) => event.kind === "working");
  assert.ok(activity, "the reviewer's stream reached the activity sensor");
  assert.equal(activity.workerRole, "reviewer");
  assert.equal(activity.selectionAssignmentId, "assignment-4615");
  assert.equal(activity.routedProvider, "codex");
  assert.equal(activity.routedModel, "gpt-6-sol", "the reviewer's activity names the routed model, not the mount alias");
  const reviewerRow = logs.find((l) => l.step === "review.reviewer");
  assert.equal(reviewerRow?.extra.selection_assignment_id, "assignment-4615");
  assert.equal(reviewerRow?.extra.routed_model, "gpt-6-sol");
  assert.equal(verdict.evaluatorProvenance?.selectionAssignmentId, "assignment-4615");
  assert.equal(verdict.evaluatorProvenance?.routedModel, "gpt-6-sol",
    "the evaluator of record is the routed model, not the alias it was requested under");
});

test("a reviewer result without its assignment joins the one it observed, and names the gap when there was none", async () => {
  const observedOnly = await reviewWith({ assign: true, resultCarries: false });
  const joined = observedOnly.logs.find((l) => l.step === "review.reviewer");
  assert.equal(joined?.extra.selection_assignment_id, "assignment-4615");
  assert.equal(joined?.extra.routed_model, "gpt-6-sol");
  assert.equal(joined?.extra.assignment_unavailable_reason, undefined);
  assert.equal(observedOnly.verdict.evaluatorProvenance?.routedModel, "gpt-6-sol");
  assert.equal(observedOnly.verdict.evaluatorProvenance?.selectionAssignmentId, "assignment-4615");

  const none = await reviewWith({ assign: false, resultCarries: false });
  const gap = none.logs.find((l) => l.step === "review.reviewer");
  assert.equal(gap?.extra.selection_assignment_id, undefined);
  assert.equal(gap?.extra.routed_model, undefined);
  assert.equal(gap?.extra.assignment_unavailable_reason, "assignment-not-observed");
  assert.equal(none.verdict.evaluatorProvenance?.routedModel, null);
  assert.equal(none.verdict.evaluatorProvenance?.selectionAssignmentId, null);
  assert.equal(none.observed.find((e) => e.kind === "working")?.routedModel, undefined);
});

// ─── 4. the transcript archive ────────────────────────────────────────────────────────────────

test("an archived transcript records the routed and served model, never the alias as served", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4615-transcript-`));
  try {
    const log = () => {};
    const routed = archiveWorkerTranscript({
      root, taskId: "W1-T4615", runId: "RUN-A", rung: "implement", text: "worker turn",
      model: "sonnet", verdict: "success",
      worker: { provider: "codex", routedModel: "gpt-6-sol", servedModel: null, selectionAssignmentId: "assignment-4615" },
    }, log);
    const front = readFileSync(routed!.path, "utf8").split("\n---\n")[0];
    assert.match(front, /^routed_provider: codex$/m);
    assert.match(front, /^routed_model: gpt-6-sol$/m);
    assert.match(front, /^served_model: unavailable$/m, "no provider receipt reads `unavailable`, never the alias");
    assert.match(front, /^selection_assignment_id: assignment-4615$/m);
    assert.match(front, /^requested_model: sonnet$/m, "the alias survives only as what was requested");
    assert.doesNotMatch(front, /^model: sonnet$/m, "no bare `model:` line carries the alias");

    const served = archiveWorkerTranscript({
      root, taskId: "W1-T4615", runId: "RUN-B", rung: "implement", text: "worker turn", model: "sonnet",
      worker: { provider: "claude", routedModel: "sonnet", servedModel: "claude-sonnet-5", selectionAssignmentId: "assignment-b" },
    }, log);
    assert.match(readFileSync(served!.path, "utf8"), /^served_model: claude-sonnet-5$/m);

    const unknown = archiveWorkerTranscript({ root, taskId: "W1-T4615", runId: "RUN-C", rung: "diagnose", text: "x", model: "sonnet" }, log);
    const unknownFront = readFileSync(unknown!.path, "utf8");
    assert.match(unknownFront, /^routed_model: unavailable$/m, "with no worker result the routed model is a named gap");
    assert.match(unknownFront, /^served_model: unavailable$/m);
    assert.doesNotMatch(unknownFront, /^(?:routed|served)_model: sonnet$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 5. the codex mount-affinity route names the model it runs ────────────────────────────────

test("a codex mount-affinity spawn records the model codex runs, not the mount alias", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4615-affinity-`));
  try {
    const assignments: WorkerSelectionAssignment[] = [];
    const result = await spawnWorker({
      cwd: REPO_ROOT,
      permissionMode: "bypassPermissions",
      settingsFile: SETTINGS_FILE,
      prompt: "classification only",
      model: "sonnet",
      effort: "low",
      maxTurns: 5,
      mountProvider: "codex",
      config: { claudeBin: "/unused/claude", root, workerProviders: { enabled: ["codex"], codexModel: "gpt-6-sol" } } as never,
      providerRouting: {
        readCodex: async () => { throw new Error("the affinity path reads no capacity"); },
        spawnCodex: async () => ({
          sessionId: "codex-affinity", costUsd: 0, numTurns: 1, text: "ok", blocks: [], stderr: "", subtype: "success",
          isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "gpt-6-sol", effort: "low",
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
          qualitySuspect: false, provider: "codex",
        }) as WorkerResult,
      },
      onSelectionAssignment: (a) => assignments.push(a),
    });
    assert.equal(assignments[0]?.selected.model, "gpt-6-sol", "the assignment names the model codex is given");
    assert.equal(assignments[0]?.requested.model, "sonnet");
    assert.equal(result.routedModel, "gpt-6-sol");
    assert.equal(result.model, "sonnet", "the requested label is unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
