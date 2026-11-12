/**
 * W1-T12236 — A RESTART READS EACH OPEN PULL REQUEST ONCE BEFORE THE FIRST REVIEW.
 *
 * In the week to 2026-11-11, the first light sweep of a daemon lifetime read its open pull request views
 * again (a median of 223 s) seconds after the first tick read had read them. The boot light sweep now takes
 * the views of that tick read. The complete file lists of plan filings, kept for an exact head, now survive
 * a restart in `state/cache/plan-filing-files.json`.
 *
 * Each test drives the real `buildSweepLightHook` with the `servedOpenPrViews` port that `daemonCommand`
 * builds. The own read goes through the real `buildOpenPrViewsAsync` and the async `gh` transport, answered
 * by a PATH-shim `gh`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { servedOpenPrViews } from "#src/cli/commands/daemon.js";
import type { LightPassScope } from "#src/lib/daemon.js";
import { loadPlanFilingFileCache } from "#src/lib/open-prs-rest.js";
import type { ReadGeneration } from "#src/lib/read-plane.js";
import { decideReviewStatusPost } from "#src/lib/review.js";
import type { OpenPrView, SweepDeps } from "#src/lib/sweep.js";
import { createTickReadProducer, type TickReadFacts } from "#src/lib/tick-read-worker.js";
import { loadPlan, type Plan } from "#src/lib/plan.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";
import { buildSweepLightHook } from "#test/helpers/run-task-test.js";

const BOOT: LightPassScope = { reviewOnly: true, scope: "boot" };
const IDLE: LightPassScope = { reviewOnly: true, scope: "idle" };
const NO_PLAN: Plan = { tasks: [], byId: new Map() };
const PR = 1223601;
const TICK_STARTED_AT_MS = 1_000_000;

function view(headSha: string): OpenPrView {
  return {
    prNumber: PR, prUrl: `https://github.com/o/r/pull/${PR}`, taskId: `W1-T${PR}`, headSha,
    headRefName: `run-W1-T${PR}-1`, lastActivityAt: new Date().toISOString(), reviewState: "none",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, mergeState: "clean",
    changedFiles: ["src/subject.ts"], reviewInputDigest: `digest-${headSha}`,
  };
}

function generation(publishedAtMs: number, views: OpenPrView[], openPrError?: string): ReadGeneration<TickReadFacts> {
  return { generation: 1, source: "inline", publishedAtMs,
    facts: { openPrViews: views, ...(openPrError ? { openPrError } : {}) } as unknown as TickReadFacts };
}

function pullRow(headSha: string, repo = "r"): Record<string, unknown> {
  return {
    number: PR, html_url: `https://github.com/o/${repo}/pull/${PR}`, state: "open", draft: false,
    title: `feat: ${PR}`, body: `Remudero-Task: W1-T${PR}`, updated_at: "2026-11-11T00:00:00Z",
    created_at: "2026-11-11T00:00:00Z", head: { ref: `run-W1-T${PR}-1`, sha: headSha },
  };
}

/** GitHub as one open pull request at `headSha`, with one green required check. */
function shimFor(headSha: string, repo: string): GhShim {
  return ghShim([
    { when: "state=open", stdout: JSON.stringify([pullRow(headSha, repo)]) },
    { when: "state=closed", stdout: "[]" },
    { when: `/pulls/${PR}/files`, stdout: JSON.stringify([{ filename: "src/subject.ts" }]) },
    { when: "check-runs", stdout: JSON.stringify({ check_runs: [{ id: 1, name: "ci-gate", status: "completed", conclusion: "success" }] }) },
    { when: "protection", stdout: JSON.stringify({ checks: [{ context: "ci-gate" }] }) },
    { when: "/status", stdout: "{\"statuses\":[]}" },
    { when: `/pulls/${PR}`, stdout: JSON.stringify({ ...pullRow(headSha, repo), mergeable_state: "clean" }) },
    { when: "", stdout: "[]" },
  ], { kind: "t12236" });
}

// A light pass can leave a read running after it returns, so each count names its own repository.
const fileReads = (gh: GhShim, repo: string) =>
  gh.calls().filter((call) => call.includes(`repos/o/${repo}/pulls/${PR}/files`)).length;
const listReads = (gh: GhShim, repo: string) =>
  gh.calls().filter((call) => call.includes(`repos/o/${repo}/pulls?state=open`)).length;

let fixtures = 0;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-t12236-"));
  // A repository name of its own: the async transport keeps recent answers in this process.
  const repo = `r${++fixtures}`;
  const keys = ["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_TRANSPORT_FLOOR", "RMD_GH_SHARED_READ_GAP_MS"] as const;
  const oldEnv = keys.map((key) => [key, process.env[key]] as const);
  const basePath = process.env.PATH;
  const shims: GhShim[] = [];
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  let gens = 0;
  /** Each hook gets its own `gh` and its own `gh` cache, so only the kept store can save a read. */
  const useShim = (headSha: string): GhShim => {
    const gh = shimFor(headSha, repo);
    shims.push(gh);
    process.env.PATH = `${gh.dir}:${basePath}`;
    process.env.RMD_GH_CACHE_HOME = join(root, `gh-cache-${++gens}`);
    return gh;
  };
  const logs: Array<Record<string, unknown>> = [];
  const posted: Array<{ prNumber: number; headSha: string }> = [];
  const rows: Array<Record<string, unknown>> = [];
  /** The live head at post time. The guard is the review module's own `decideReviewStatusPost`. */
  let liveDigest: string | undefined;
  const effects: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "T12236", readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); }, readLedgerUnion: () => ({ complete: true, lines: rows }),
    readActiveWorkerCount: () => 0, arm: () => assert.fail("unexpected arm"),
    postReview: (pr) => {
      const decision = decideReviewStatusPost({ headSha: pr.headSha, state: "success", evidence: "executed",
        ...(pr.reviewInputDigest ? { reviewInputDigest: pr.reviewInputDigest } : {}) }, undefined,
        { merged: false, closed: false, reviewInputDigest: liveDigest ?? pr.reviewInputDigest });
      if (decision.post) posted.push({ prNumber: pr.prNumber, headSha: pr.headSha });
      else rows.push({ step: "review.post_refused", head_sha: pr.headSha, reason: decision.reason });
    },
    close: () => assert.fail("unexpected close"), dispatchFix: () => assert.fail("unexpected fix"),
    escalate: () => assert.fail("unexpected escalation"),
    readLiveState: (p) => ({ ok: true, state: "OPEN", headSha: p.headSha }), rereadPrAtAct: async (p) => p,
  };
  const hook = (openPrViews?: ReturnType<typeof servedOpenPrViews>) =>
    buildSweepLightHook("o", repo, { root } as never, effects.ledgerPath, "T12236", NO_PLAN,
      (step, extra) => { logs.push({ step, ...extra }); }, undefined, () => false, () => NO_PLAN, undefined, undefined,
      { effects: () => effects, readCompare: async () => ({ ahead_by: 0, files: [] }), ...(openPrViews ? { openPrViews } : {}) });
  const timing = () => logs.filter((row) => row.step === "sweep_light.pre_review_timing");
  const storePath = join(root, "state", "cache", "plan-filing-files.json");
  return { root, repo, logs, posted, rows, hook, timing, storePath, useShim,
    moveLiveHead: (headSha: string) => { liveDigest = `digest-${headSha}`; },
    cleanup: () => {
      for (const [key, value] of oldEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      for (const gh of shims) rmSync(gh.dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    } };
}

test("W1-T12236 criterion 1: the boot light sweep uses the views of the current tick read and reads none itself", async () => {
  const f = fixture();
  try {
    const gh = f.useShim("head-live");
    const served = servedOpenPrViews(() => generation(TICK_STARTED_AT_MS + 5, [view("head-tick")]), () => TICK_STARTED_AT_MS);
    await f.hook(served)(BOOT);
    assert.equal(f.logs.filter((row) => row.step === "sweep_light.error").length, 0, JSON.stringify(f.logs));
    assert.equal(listReads(gh, f.repo), 0, "no open pull request list read");
    assert.equal(fileReads(gh, f.repo), 0, "no file read");
    assert.deepEqual(f.posted, [{ prNumber: PR, headSha: "head-tick" }]);
  } finally { f.cleanup(); }
});

test("W1-T12236 criterion 2: with no tick read, or one older than the tick, the light sweep reads its own views", async () => {
  for (const published of [undefined, generation(TICK_STARTED_AT_MS - 1, [view("head-old")]),
    generation(TICK_STARTED_AT_MS + 5, [view("head-old")], "open list unavailable")]) {
    const f = fixture();
    try {
      const gh = f.useShim("head-live");
      await f.hook(servedOpenPrViews(() => published, () => TICK_STARTED_AT_MS))(BOOT);
      assert.ok(listReads(gh, f.repo) >= 1, "the hook read the open pull requests itself");
      assert.ok(f.posted.every((post) => post.headSha === "head-live"), JSON.stringify(f.posted));
      assert.equal(f.timing()[0]?.views_source, "own_read");
    } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    const gh = f.useShim("head-live");
    const served = servedOpenPrViews(() => generation(TICK_STARTED_AT_MS + 5, [view("head-tick")]), () => undefined);
    await f.hook(served)(BOOT);
    assert.ok(listReads(gh, f.repo) >= 1, "no known tick start: the hook read its own views");
  } finally { f.cleanup(); }
});

test("W1-T12236 criterion 3: a light sweep with any other scope reads its own views", async () => {
  for (const scope of [IDLE, { reviewOnly: true, scope: "drain" } as LightPassScope, undefined]) {
    const f = fixture();
    try {
      const gh = f.useShim("head-live");
      const served = servedOpenPrViews(() => generation(TICK_STARTED_AT_MS + 5, [view("head-tick")]), () => TICK_STARTED_AT_MS);
      await f.hook(served)(scope);
      assert.ok(listReads(gh, f.repo) >= 1, `scope ${scope?.scope ?? "ordinary"} read its own views`);
      assert.equal(f.posted.some((post) => post.headSha === "head-tick"), false);
      assert.equal(f.timing()[0]?.views_source, "own_read");
    } finally { f.cleanup(); }
  }
});

test("W1-T12236 criterion 4: a boot review from the tick read is for its head, and a moved head does not post", async () => {
  const f = fixture();
  try {
    f.useShim("head-live");
    const tickViews = [view("head-tick")];
    const served = servedOpenPrViews(() => generation(TICK_STARTED_AT_MS + 5, tickViews), () => TICK_STARTED_AT_MS);
    await f.hook(served)(BOOT);
    assert.deepEqual(f.posted, [{ prNumber: PR, headSha: "head-tick" }], "the review is for the head in the views");
    assert.equal(tickViews[0]!.headSha, "head-tick", "the hook got a copy, never the published views");
    f.posted.length = 0;
    f.rows.length = 0;
    f.moveLiveHead("head-pushed");
    await f.hook(served)(BOOT);
    assert.equal(f.posted.length, 0, "the review for the old head did not post");
    const refused = f.rows.filter((row) => row.step === "review.post_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.head_sha, "head-tick");
  } finally { f.cleanup(); }
});

test("W1-T12236 criterion 5: a second hook on the same state directory makes no file read for a head read completely", async () => {
  const f = fixture();
  try {
    const first = f.useShim("head-a");
    await f.hook()(IDLE);
    assert.equal(fileReads(first, f.repo), 1, "positive control: the first hook read the file list");
    const kept = JSON.parse(readFileSync(f.storePath, "utf8")) as { schema: number; pulls: Record<string, unknown> };
    assert.deepEqual(kept, { schema: 1, pulls: { [`o/${f.repo}#${PR}`]: { head: "head-a", files: ["src/subject.ts"] } } });
    const second = f.useShim("head-a");
    await f.hook()(IDLE);
    assert.ok(listReads(second, f.repo) >= 1, "the second hook read its own views");
    assert.equal(fileReads(second, f.repo), 0, "the kept file list answered");
    assert.deepEqual(f.posted.map((post) => post.headSha), ["head-a", "head-a"]);
  } finally { f.cleanup(); }
});

test("W1-T12236 criterion 6: a kept file list for another head, or an unreadable store, gives a GitHub read", async () => {
  const f = fixture();
  try {
    f.useShim("head-a");
    await f.hook()(IDLE);
    f.posted.length = 0;
    const moved = f.useShim("head-b");
    await f.hook()(IDLE);
    assert.equal(fileReads(moved, f.repo), 1, "the head differs, so the hook read the file list again");
    assert.deepEqual(f.posted, [{ prNumber: PR, headSha: "head-b" }], "no review for the old head");
    const kept = JSON.parse(readFileSync(f.storePath, "utf8")) as { pulls: Record<string, { head: string }> };
    assert.equal(kept.pulls[`o/${f.repo}#${PR}`]!.head, "head-b", "the store replaced the old head");
    f.posted.length = 0;
    writeFileSync(f.storePath, "{ not json");
    const unreadable = f.useShim("head-b");
    await f.hook()(IDLE);
    assert.equal(fileReads(unreadable, f.repo), 1, "an unreadable store gives today's read");
    assert.equal(f.logs.filter((row) => row.step === "plan_filing_files.store_unreadable").length, 1);
    assert.deepEqual(f.posted, [{ prNumber: PR, headSha: "head-b" }]);
    assert.equal((JSON.parse(readFileSync(f.storePath, "utf8")) as { schema: number }).schema, 1, "the save replaced the bad file");
  } finally { f.cleanup(); }
});

test("W1-T12236 criterion 7: sweep_light.pre_review_timing names the source of its views", async () => {
  const f = fixture();
  try {
    f.useShim("head-live");
    const served = servedOpenPrViews(() => generation(TICK_STARTED_AT_MS + 5, [view("head-tick")]), () => TICK_STARTED_AT_MS);
    const hook = f.hook(served);
    await hook(BOOT);
    await hook(IDLE);
    assert.deepEqual(f.timing().map((row) => row.views_source), ["tick_read", "own_read"]);
  } finally { f.cleanup(); }
});

test("W1-T12236: a kept entry is used only for its own pull request number and head", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t12236-store-"));
  try {
    mkdirSync(join(dir, "cache"), { recursive: true });
    writeFileSync(join(dir, "cache", "plan-filing-files.json"), JSON.stringify({ schema: 1,
      pulls: { "o/r#7": { head: "h7", files: ["a.ts"] }, "o/other#8": { head: "h8", files: ["b.ts"] } } }));
    const store = loadPlanFilingFileCache(dir);
    assert.equal(store.unreadable, undefined);
    assert.deepEqual([...store.entries.keys()].sort(), ["o/other#8@h8", "o/r#7@h7"]);
    store.retain("o", "r", [9]);
    assert.deepEqual([...store.entries.keys()], ["o/other#8@h8"], "only the closed pull request of this repository left");
    for (const bad of [{ schema: 2, pulls: {} }, { schema: 1, pulls: { "o/r#7": { head: "h7", files: [] } } }]) {
      writeFileSync(join(dir, "cache", "plan-filing-files.json"), JSON.stringify(bad));
      const refused = loadPlanFilingFileCache(dir);
      assert.equal(refused.entries.size, 0);
      assert.ok(refused.unreadable, "the reason is named");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T12236: the tick read worker keeps the file lists across a restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t12236-worker-"));
  try {
    writeFileSync(join(root, "tasks.yaml"), "- id: A\n  title: a\n  repo: r\n  type: implement\n  files: [src/a.ts]\n  depends_on: []\n  status: queued\n");
    const ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const answer = (args: string[]): unknown => {
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (path.includes("/pulls?") && path.includes("state=open")) return [pullRow("head-w")];
      if (path.includes("/pulls?") || path.includes("/issues?")) return [];
      if (path.includes("/files")) return [{ filename: "src/subject.ts" }];
      if (path.includes("/check-runs")) return { check_runs: [] };
      if (path.endsWith("/status")) return { statuses: [] };
      if (path.includes("/compare/")) return { ahead_by: 0 };
      return {};
    };
    const produce = async () => {
      const reads: string[] = [];
      const read = createTickReadProducer({ owner: "o", repo: "r", config: { root, claudeBin: process.execPath }, ledgerPath, checkoutRoot: root }, {
        fetch: (args) => { reads.push(args.join(" ")); return answer(args); },
        fetchAsync: async (args) => { reads.push(args.join(" ")); return answer(args); },
        changedFilesFetch: async () => ["src/a.ts"], commitTrailerIndex: () => new Map(), evidenceRootFor: () => undefined,
        issues: { create: () => { throw new Error("write in read plane"); }, listOpen: () => [] },
        viewsDeps: { requiredContexts: () => ["ci-gate"], readCiGateRequired: () => [] },
      });
      const facts = await read({ plan: loadPlan(join(root, "tasks.yaml")) });
      assert.deepEqual(facts.openPrViews.map((pr) => pr.prNumber), [PR]);
      return reads.filter((call) => call.includes(`/pulls/${PR}/files`)).length;
    };
    assert.equal(await produce(), 1, "positive control: the first worker read the file list");
    assert.equal(await produce(), 0, "a new worker on the same state directory used the kept list");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
