import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildOpenPrViews, buildOpenPrViewsAsync, createTickReadProducer } from "../src/run-task.js";
import { createGhCallPacer, createPlanFilingFileCache, type GhCallPacer } from "../src/lib/open-prs-rest.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { CiFailure } from "../src/lib/sweep.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

// W1-T6591: the 2026-10-08 CPU profile caught buildOpenPrViews holding the daemon thread for 18.5 s
// on synchronous `gh` (open-prs-rest → ghJson) and git (fetchCiFailures → runStepsSync) children.

const O = "o";
const R = "r";
const NO_PLAN: Plan = { tasks: [], byId: new Map() };
const EVIDENCE: CiFailure[] = [{ name: "ci-gate", logTail: "not ok 1", conclusion: "FAILURE" }];

function row(number: number): Record<string, unknown> {
  return {
    number, html_url: `https://github.com/o/r/pull/${number}`, state: "open", draft: false,
    title: `fix: ${number}`, body: `Remudero-Task: W1-T${number}`, updated_at: "2026-10-08T00:00:00Z",
    created_at: "2026-10-08T00:00:00Z", head: { ref: `run-W1-T${number}-1`, sha: `sha${number}` },
  };
}

function answer(args: string[]): unknown {
  const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
  if (path.includes("/pulls?") && path.includes("state=open")) return [row(1), row(2), row(3)];
  if (path.includes("/check-runs")) {
    const red = path.includes("sha1");
    return { check_runs: [{ id: red ? 11 : 12, name: "ci-gate", status: "completed", conclusion: red ? "failure" : "success" }] };
  }
  if (path.endsWith("/status")) return { statuses: [] };
  if (path.includes("/pulls/2/files")) throw new Error("gh exited 1");
  if (path.endsWith("/files") || path.includes("/files?")) return [{ filename: "src/a.ts" }];
  const single = /\/pulls\/(\d+)$/.exec(path);
  if (single) return { ...row(Number(single[1])), mergeable_state: single[1] === "3" ? "dirty" : "clean" };
  return {};
}

const slow = (ms: number) => (args: string[]) =>
  delay(ms).then(() => answer(args));

function ledgerFile(): string {
  const path = join(makeTempDir("open-pr-views-off-loop"), "ledger.ndjson");
  writeFileSync(path, "");
  return path;
}

const base = { requiredContexts: () => ["ci-gate"], readCiGateRequired: () => [], readMainPlan: () => NO_PLAN };

test("W1-T6591: the loop turns while open-PR views fetch", async () => {
  const ledger = ledgerFile();
  const expected = buildOpenPrViews(O, R, ledger, { ...base, fetch: answer, fetchCiFailureEvidence: () => EVIDENCE });
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 10);
  let views: Awaited<ReturnType<typeof buildOpenPrViewsAsync>>;
  try {
    views = await buildOpenPrViewsAsync(O, R, ledger, {
      ...base, fetchAsync: slow(200), fetchCiFailureEvidenceAsync: () => delay(200).then(() => EVIDENCE),
    });
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks >= 20, `the timer fired ${ticks} times while 200 ms reads were in flight`);
  assert.equal(views.length, 3, "positive control: every open PR was built");
  assert.deepEqual(views.find((view) => view.prNumber === 1)?.ciFailures, EVIDENCE, "the red PR's evidence was read");
  assert.deepEqual(views, expected, "the views are exactly what the synchronous build produces");
});

test("W1-T6591: only the settled pass commits the plan-filing cache and its telemetry", async () => {
  const ledger = ledgerFile();
  const syncCache = createPlanFilingFileCache();
  const syncEvents: unknown[] = [];
  buildOpenPrViews(O, R, ledger, { ...base, fetch: answer, fetchCiFailureEvidence: () => EVIDENCE,
    planFilingFileCache: syncCache, onPlanFilingClassification: (event) => syncEvents.push(event) });
  const cache = createPlanFilingFileCache();
  const events: unknown[] = [];
  await buildOpenPrViewsAsync(O, R, ledger, { ...base, fetchAsync: slow(1), fetchCiFailureEvidence: () => EVIDENCE,
    planFilingFileCache: cache, onPlanFilingClassification: (event) => events.push(event) });
  assert.equal(events.length, 3, "one classification per PR, never one per replayed pass");
  assert.deepEqual(events, syncEvents);
  assert.ok(cache.entries.size > 0, "positive control: a complete file read was cached");
  assert.deepEqual([...cache.entries], [...syncCache.entries]);
  assert.deepEqual([...cache.missCursors], [...syncCache.missCursors]);
});

test("W1-T6591: a failed open-PR list read rejects exactly as the synchronous build throws", async () => {
  const ledger = ledgerFile();
  const failing = (args: string[]): unknown => {
    if (args.some((arg) => arg.includes("state=open"))) throw new Error("open list unavailable");
    return answer(args);
  };
  assert.throws(() => buildOpenPrViews(O, R, ledger, { ...base, fetch: failing }), /open list unavailable/);
  await assert.rejects(buildOpenPrViewsAsync(O, R, ledger, { ...base, fetchAsync: async (args) => failing(args) }),
    /open list unavailable/);
});

test("W1-T6591: by default the views read through the async gh transport and CI failure fetch", async () => {
  const listed = JSON.stringify([row(1)]);
  const runs = JSON.stringify({ check_runs: [{ id: 11, name: "ci-gate", status: "completed", conclusion: "failure" }] });
  const gh = ghShim([{ when: "state=open", stdout: listed }, { when: "check-runs", stdout: runs },
    { when: "/status", stdout: "{\"statuses\":[]}" }, { when: "", stdout: "{}" }], { kind: "open-pr-views-off-loop" });
  const previous = process.env.PATH;
  process.env.PATH = `${gh.dir}:${previous}`;
  try {
    const views = await buildOpenPrViewsAsync(O, R, ledgerFile(), base);
    assert.deepEqual(views.map((view) => view.prNumber), [1]);
    assert.deepEqual(views[0].ciFailures?.map((failure) => failure.name), ["ci-gate"]);
    assert.ok(gh.calls().some((call) => call.includes("state=open")), "the list was read through the shimmed gh");
  } finally {
    process.env.PATH = previous;
  }
});

function pendingAnswer(args: string[]): unknown {
  const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
  if (path.includes("/pulls?") && path.includes("state=closed")) return [];
  if (path.includes("/issues?")) return [];
  if (path.includes("/check-runs")) return { check_runs: [] };
  if (path.endsWith("/status")) return { statuses: [{ context: "ci-gate", state: "pending" }] };
  if (path.includes("/compare/")) return { ahead_by: 0 };
  return answer(args);
}

test("W1-T6591: the read plane awaits its open-PR and post-fix CI reads", async () => {
  const root = makeTempDir("open-pr-views-off-loop");
  writeFileSync(join(root, "tasks.yaml"), "- id: A\n  title: a\n  repo: r\n  type: implement\n  files: [src/a.ts]\n  depends_on: []\n  status: queued\n");
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const syncReads: string[] = [];
  const asyncReads: string[] = [];
  const produce = createTickReadProducer({ owner: O, repo: R, config: { root, claudeBin: process.execPath }, ledgerPath, checkoutRoot: root }, {
    fetch: (args) => { syncReads.push(args.join(" ")); return pendingAnswer(args); },
    fetchAsync: (args) => { asyncReads.push(args.join(" ")); return delay(50).then(() => pendingAnswer(args)); },
    changedFilesFetch: async () => ["src/a.ts"], commitTrailerIndex: () => new Map(), evidenceRootFor: () => undefined,
    issues: { create: () => { throw new Error("write in read plane"); }, listOpen: () => [] },
    viewsDeps: { requiredContexts: () => ["ci-gate"], readCiGateRequired: () => [],
      fetchCiFailureEvidenceAsync: () => delay(50).then(() => EVIDENCE) },
  });
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 5);
  let facts: Awaited<ReturnType<typeof produce>>;
  try {
    facts = await produce({ plan: loadPlan(join(root, "tasks.yaml")) });
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks >= 5, `the timer fired ${ticks} times`);
  assert.deepEqual(facts.openPrViews.map((view) => view.prNumber), [1, 2, 3]);
  assert.ok(asyncReads.some((read) => read.includes("state=open")), "the open list went through the async transport");
  assert.equal(syncReads.some((read) => read.includes("state=open") && read.includes("/pulls?")), false);
  for (const view of facts.openPrViews) assert.deepEqual(facts.postFixCiFailuresByPr.get(view.prNumber), EVIDENCE);
});

test("W1-T6591: one build pass per call reads each remote input once", async () => {
  const ledger = ledgerFile();
  const syncReads: string[] = [];
  let syncPasses = 0;
  const expected = buildOpenPrViews(O, R, ledger, { ...base, readCiGateRequired: () => { syncPasses += 1; return []; },
    fetch: (args) => { syncReads.push(args.join(" ")); return answer(args); }, fetchCiFailureEvidence: () => EVIDENCE });
  const reads: string[] = [];
  let passes = 0;
  let ciReads = 0;
  const views = await buildOpenPrViewsAsync(O, R, ledger, {
    ...base, readCiGateRequired: () => { passes += 1; return []; },
    fetchAsync: (args) => { reads.push(args.join(" ")); return slow(1)(args); },
    fetchCiFailureEvidenceAsync: async () => { ciReads += 1; return EVIDENCE; },
  });
  assert.equal(syncPasses, 1, "positive control: the synchronous build makes one pass");
  assert.ok(reads.length >= 9, `positive control: the build read its inputs (${reads.length} reads)`);
  assert.equal(passes, 1, `the async build ran ${passes} classification passes`);
  assert.equal(ciReads, 1, "the one red PR's CI evidence was read once");
  assert.deepEqual(reads, syncReads, "the same reads, in the same order, each exactly once");
  assert.deepEqual(views, expected);
});

function rateLimited(): Error {
  return Object.assign(new Error("gh: API rate limit exceeded"), { status: 1, stderr: "API rate limit exceeded\nRetry-After: 2" });
}

test("W1-T6591: the async list read awaits the pacer and backs off a rate limit", async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const pacer = createGhCallPacer({
    minGapMs: 1_000, rateLimitGapMs: 5_000, now: () => clock,
    sleepSync: () => { throw new Error("a blocking sleep on the event loop"); },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  pacer.wait();
  let listReads = 0;
  const views = await buildOpenPrViewsAsync(O, R, ledgerFile(), {
    ...base, pacer, fetchCiFailureEvidence: () => EVIDENCE,
    fetchAsync: async (args) => {
      if (args.some((arg) => arg.includes("state=open")) && ++listReads === 1) throw rateLimited();
      return answer(args);
    },
  });
  assert.equal(views.length, 3, "positive control: the retried list was built");
  assert.equal(listReads, 2, "the rate-limited list read was retried once");
  assert.equal(sleeps.length, 3, `the gap, the backoff and the widened gap were awaited: ${sleeps.join(", ")}`);
  assert.equal(sleeps[0], 1_000, "the first read waited out the pacer's gap");
  assert.ok(sleeps[1] >= 2_000 && sleeps[1] <= 2_500, `the backoff honoured Retry-After: ${sleeps[1]}`);
  assert.ok(sleeps[2] > 1_000, `the retry waited the widened rate-limit gap: ${sleeps[2]}`);
});

test("W1-T6591: the async list read's budget reading arms the pacer's floor", async () => {
  const pacer = createGhCallPacer({ sleepSync: () => { throw new Error("a blocking sleep on the event loop"); }, sleep: async () => {} });
  const fetchAsync = async (args: string[], onRateLimit?: (reading: { remaining?: number; limit?: number; resource?: string }) => void) => {
    if (args.some((arg) => arg.includes("state=open"))) onRateLimit?.({ remaining: 10, limit: 5_000, resource: "core" });
    return answer(args);
  };
  const views = await buildOpenPrViewsAsync(O, R, ledgerFile(), { ...base, pacer, fetchAsync, fetchCiFailureEvidence: () => EVIDENCE });
  assert.equal(views.length, 3, "positive control: the first pass read the list");
  await assert.rejects(buildOpenPrViewsAsync(O, R, ledgerFile(), { ...base, pacer, fetchAsync }), /stood down/);
});

test("W1-T6591: the read plane paces its open-PR list on its pacer", async () => {
  const root = makeTempDir("open-pr-views-off-loop");
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  let waits = 0;
  const pacer: GhCallPacer = { wait: () => {}, waitAsync: async () => { waits += 1; }, recordResult: () => {} };
  const produce = createTickReadProducer({ owner: O, repo: R, config: { root, claudeBin: process.execPath }, ledgerPath, checkoutRoot: root }, {
    pacer, fetch: pendingAnswer, fetchAsync: async (args) => pendingAnswer(args),
    changedFilesFetch: async () => [], commitTrailerIndex: () => new Map(), evidenceRootFor: () => undefined,
    issues: { create: () => { throw new Error("write in read plane"); }, listOpen: () => [] },
    viewsDeps: { requiredContexts: () => ["ci-gate"], readCiGateRequired: () => [], fetchCiFailureEvidence: () => EVIDENCE },
  });
  const facts = await produce({ plan: NO_PLAN });
  assert.equal(facts.openPrError, undefined);
  assert.deepEqual(facts.openPrViews.map((view) => view.prNumber), [1, 2, 3], "positive control: the list was read");
  assert.ok(waits >= 1, "the list read awaited the read plane's pacer");
});
