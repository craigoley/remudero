/**
 * W1-T13831 — A LIGHT PASS THAT NAMES NO SCOPE DECIDES FROM THE FRESH OPEN PULL REQUEST VIEWS OF THE TICK READ.
 *
 * The in-flight ticker's pass and the interphase ordinary pass call the light pass with no scope. Before this
 * task `servedOpenPrViews` served nothing to them, because "no scope" stood for the refill read. The port now
 * names the read: the pass's own first read may be served; the refill read never is.
 *
 * Each hook test drives the real `buildSweepLightHook` with the `servedOpenPrViews` port that `daemonCommand`
 * passes, the real `createLightPassOpenPrList` inside it, and a PATH-shim `gh` that counts calls.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { servedOpenPrViews } from "#src/cli/commands/daemon.js";
import type { LightPassScope } from "#src/lib/daemon.js";
import { createGhCallPacer } from "#src/lib/github-transport.js";
import { appendLedger } from "#src/lib/ledger.js";
import { LIVE_WRITE_OVERRIDE_ENV } from "#src/lib/live-write-guard.js";
import { TICK_READ_MAX_AGE_MS, freshReadGeneration, type ReadGeneration } from "#src/lib/read-plane.js";
import { reviewInputDigest } from "#src/lib/review.js";
import type { BuildSweepEffectsDeps, LiveStateResult, OpenPrView, SweepDeps } from "#src/lib/sweep.js";
import type { TickReadFacts } from "#src/lib/tick-read-worker.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";
import { buildSweepLightHook } from "#test/helpers/run-task-test.js";

const BOOT: LightPassScope = { reviewOnly: true, scope: "boot" };
const IDLE: LightPassScope = { reviewOnly: true, scope: "idle" };
/** The interphase ordinary pass with a repair hand-off: a scope object that names no scope. */
const HANDOFF: LightPassScope = { reviewOnly: false };
const TICK_STARTED_AT = 50_000;
let fixtures = 0;

function view(prNumber: number, headSha: string, ready = false): OpenPrView {
  return { prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`, headSha,
    headRefName: `run-W1-T${prNumber}-1`, lastActivityAt: new Date().toISOString(),
    reviewState: ready ? "success" : "none", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    autoMergeArmed: false, mergeState: "clean", changedFiles: ["src/subject.ts"],
    reviewInputDigest: reviewInputDigest(headSha, `Remudero-Task: W1-T${prNumber}`) };
}

/** The PR's dates are derived from the clock the pass reads (W1-T14786). */
function pullRow(prNumber: number, headSha: string, repo: string): Record<string, unknown> {
  const touched = new Date(Date.now() - 86_400_000).toISOString();
  return { number: prNumber, html_url: `https://github.com/o/${repo}/pull/${prNumber}`, state: "open", draft: false,
    title: `feat: ${prNumber}`, body: `Remudero-Task: W1-T${prNumber}`, updated_at: touched,
    created_at: touched, head: { ref: `run-W1-T${prNumber}-1`, sha: headSha } };
}

function generation(publishedAtMs: number, views: OpenPrView[], openPrError?: string): ReadGeneration<TickReadFacts> {
  return { generation: 1, source: "inline", publishedAtMs,
    facts: { openPrViews: views, ...(openPrError === undefined ? {} : { openPrError }) } as unknown as TickReadFacts };
}

/** GitHub holds one open pull request, `prNumber` at `liveHead`, with one green required check. */
function fixture(prNumber: number, liveHead: string, nowMs = TICK_STARTED_AT + 30) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13831-`));
  const repo = `r${++fixtures}`;
  const rows: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  const posted: Array<{ prNumber: number; headSha: string }> = [];
  const live = new Map<number, LiveStateResult>();
  const builds: BuildSweepEffectsDeps[] = [];
  const atPost: string[][] = [];
  let published: ReadGeneration<TickReadFacts> | undefined;
  const gh: GhShim = ghShim([
    { when: "state=open", stdout: JSON.stringify([pullRow(prNumber, liveHead, repo)]) },
    { when: "state=closed", stdout: "[]" },
    { when: `/pulls/${prNumber}/files`, stdout: JSON.stringify([{ filename: "src/subject.ts" }]) },
    { when: "check-runs", stdout: JSON.stringify({ check_runs: [{ id: 1, name: "ci-gate", status: "completed", conclusion: "success" }] }) },
    { when: "protection", stdout: JSON.stringify({ checks: [{ context: "ci-gate" }] }) },
    { when: "/status", stdout: "{\"statuses\":[]}" },
    { when: `/pulls/${prNumber}`, stdout: JSON.stringify({ ...pullRow(prNumber, liveHead, repo), mergeable_state: "clean" }) },
    { when: "", stdout: "[]" },
  ], { kind: "t13831" });
  const keys = ["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_TRANSPORT_FLOOR", "RMD_GH_SHARED_READ_GAP_MS", LIVE_WRITE_OVERRIDE_ENV] as const;
  const oldEnv = keys.map((key) => [key, process.env[key]] as const);
  process.env.PATH = `${gh.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(root, "gh-cache");
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  const effects: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "T13831", readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); }, readLedgerUnion: () => ({ complete: true, lines: rows }),
    readActiveWorkerCount: () => 0,
    arm: async (pr) => {
      const armImpl = builds.at(-1)?.armImpl;
      if (armImpl === undefined) return "armed";
      return armImpl(pr.prUrl, pr.taskId, {
        headSha: async () => pr.headSha, say: () => {}, disableAuto: async () => {},
        ledgerLines: () => rows, contributorAdmission: async () => {},
        armAuto: async () => { throw new Error("Pull request is in clean status"); },
        mergeDirect: async () => assert.fail("the merge at the list's head replaces the plain one"),
      });
    },
    postReview: (pr) => { atPost.push(gh.calls()); posted.push({ prNumber: pr.prNumber, headSha: pr.headSha }); },
    close: () => assert.fail("unexpected close"), dispatchFix: () => assert.fail("unexpected fix"),
    escalate: () => assert.fail("unexpected escalation"),
    readLiveState: (pr) => live.get(pr.prNumber) ?? { ok: true, state: "OPEN", headSha: pr.headSha },
    rereadPrAtAct: async (pr) => pr, readMainTip: async () => "main-1",
  };
  // The port daemonCommand passes, over a generation each test publishes.
  const port = servedOpenPrViews(() => published, () => TICK_STARTED_AT);
  const io = {
    effects: (deps: BuildSweepEffectsDeps) => { builds.push(deps); return effects; },
    readCompare: async () => ({ ahead_by: 0, files: [] }),
    openPrViews: port,
    clock: { now: () => nowMs },
    pacer: createGhCallPacer({ minGapMs: 0, rateLimitGapMs: 0, sleep: async () => {} }),
  };
  const hook = buildSweepLightHook("o", repo, { root } as never, effects.ledgerPath, "T13831", { tasks: [], byId: new Map() },
    (step, extra = {}) => { logs.push({ step, ...extra }); }, undefined, () => false, () => ({ tasks: [], byId: new Map() }),
    undefined, undefined, io);
  const count = (calls: string[], part: string) => calls.filter((call) => call.includes(part)).length;
  const settle = async () => {
    for (let quiet = 0, rounds = 0; quiet < 40 && rounds < 600; rounds++) {
      const before = gh.events();
      await sleep(50);
      const after = gh.events();
      const open = after.filter((event) => event.phase === "start").length - after.filter((event) => event.phase === "end").length;
      quiet = open === 0 && after.length === before.length ? quiet + 1 : 0;
    }
  };
  return { atPost, builds, effects, gh, hook, live, logs, port, posted, repo, rows, settle,
    publish(next: ReadGeneration<TickReadFacts> | undefined) { published = next; },
    timing: () => logs.filter((row) => row.step === "sweep_light.pre_review_timing"),
    listReads: (calls: string[] = gh.calls()) => count(calls, `repos/o/${repo}/pulls?state=open`),
    checkReads: (calls: string[] = gh.calls()) => count(calls, "check-runs"),
    statusReads: (calls: string[] = gh.calls()) => count(calls, "/status"),
    async cleanup() {
      await settle();
      for (const [key, value] of oldEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(gh.dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    } };
}

test("W1-T13831 criterion 1: a pass with no scope decides from a fresh tick read and reads no open list", async () => {
  for (const scope of [undefined, HANDOFF]) {
    const f = fixture(81, "head-live");
    try {
      f.publish(generation(TICK_STARTED_AT + 5, [view(81, "head-tick")]));
      await f.hook(scope);
      assert.equal(f.logs.filter((row) => row.step === "sweep_light.error").length, 0, JSON.stringify(f.logs));
      assert.equal(f.timing()[0]?.views_source, "tick_read");
      assert.deepEqual(f.posted.map((post) => post.headSha), ["head-tick"], "the pass decided from the tick read's views");
      assert.equal(f.listReads(f.atPost[0]), 0, "no open pull request list read before the pass acted");
    } finally { await f.cleanup(); }
  }
});

test("W1-T13831 criterion 2: the refill read is never served the tick read, whatever the pass's scope", async () => {
  const fresh = generation(TICK_STARTED_AT + 5, [view(82, "head-tick")]);
  const port = servedOpenPrViews(() => fresh, () => TICK_STARTED_AT);
  for (const scope of [undefined, HANDOFF, IDLE, BOOT]) {
    assert.ok(port(scope, "pass"), `${scope?.scope ?? "no scope"}: the pass's read is served`);
    assert.equal(port(scope, "refill"), undefined, `${scope?.scope ?? "no scope"}: the refill read reads its own`);
    assert.equal(port(scope) !== undefined, scope?.scope === "boot", "only a boot caller may omit the read kind");
  }
  const f = fixture(82, "head-live");
  try {
    f.publish(fresh);
    await f.hook(undefined);
    await f.settle();
    assert.equal(f.listReads(f.atPost[0]), 0, "the pass's own read was served");
    assert.ok(f.listReads() >= 1, `the refill read the open list itself: ${JSON.stringify(f.gh.calls())}`);
  } finally { await f.cleanup(); }
});

test("W1-T13831 criterion 3: with no fresh, clean, newer generation a pass with no scope reads its own views", async () => {
  const clockAt = (ms: number) => ({ now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() });
  const tooOld = freshReadGeneration(generation(TICK_STARTED_AT + 1, [view(83, "head-old")]),
    { consumer: "sweep_light", clock: clockAt(TICK_STARTED_AT + TICK_READ_MAX_AGE_MS + 2) });
  assert.equal(tooOld, undefined, "freshReadGeneration refuses a generation older than TICK_READ_MAX_AGE_MS");
  for (const published of [undefined, tooOld, generation(TICK_STARTED_AT - 1, [view(83, "head-old")]),
    generation(TICK_STARTED_AT + 5, [view(83, "head-old")], "open list unavailable")]) {
    const f = fixture(83, "head-live");
    try {
      f.publish(published);
      await f.hook(undefined);
      assert.equal(f.timing()[0]?.views_source, "own_read");
      assert.ok(f.listReads(f.atPost[0]) >= 1, "the pass read the open list itself");
      assert.deepEqual(f.posted.map((post) => post.headSha), ["head-live"]);
      assert.equal(f.builds[0]?.armImpl, undefined, "an own read is not acted on as a last good list");
    } finally { await f.cleanup(); }
  }
  // A generation whose read started before the last good list's read is not served to a pass with no scope;
  // the boot pass keeps the W1-T12236 rule and takes it.
  const f = fixture(83, "head-live", TICK_STARTED_AT + 30);
  try {
    await f.hook(undefined);
    await f.settle();
    f.publish(generation(TICK_STARTED_AT + 5, [view(83, "head-older")]));
    await f.hook(undefined);
    await f.settle();
    await f.hook(BOOT);
    assert.deepEqual(f.timing().map((row) => row.views_source), ["own_read", "own_read", "tick_read"]);
    assert.equal(f.posted.filter((post) => post.headSha === "head-older").length, 1, "only the boot pass decided from it");
  } finally { await f.cleanup(); }
});

test("W1-T13831 criterion 4: a pass with no scope on a served list guards each acting head at act time", async () => {
  const moved = view(84, "head-listed-moved");
  const ready = view(85, "b".repeat(40), true);
  const f = fixture(84, "head-listed-moved");
  process.env[LIVE_WRITE_OVERRIDE_ENV] = "1";
  try {
    f.rows.push({ step: "review.posted", task_id: ready.taskId, pr_url: ready.prUrl, head_sha: ready.headSha,
      state: "success", capped: false, plan_only: false });
    appendLedger(f.effects.ledgerPath, { run_id: "T13831", task_id: "SWEEP", step: "fixture.ledger_exists" });
    f.live.set(moved.prNumber, { ok: true, state: "OPEN", headSha: "head-moved-live" });
    f.publish(generation(TICK_STARTED_AT + 5, [moved, ready]));
    await f.hook(undefined);
    assert.equal(f.timing()[0]?.views_source, "tick_read");
    assert.equal(typeof f.builds[0]?.armImpl, "function", "a direct merge is tied to the list's head");
    assert.ok(f.rows.some((row) => row.step === "sweep.head_moved" && row.pr_number === moved.prNumber &&
      row.snapshot_head_sha === moved.headSha && row.live_head_sha === "head-moved-live"), JSON.stringify(f.rows));
    assert.equal(f.posted.some((post) => post.prNumber === moved.prNumber), false, "no review on the moved head");
    const merge = f.gh.calls().find((call) => call.includes(`pulls/${ready.prNumber}/merge`));
    assert.ok(merge, JSON.stringify({ calls: f.gh.calls(), rows: f.rows }));
    assert.match(merge, new RegExp(`sha=${ready.headSha}`), "the direct merge names the served list's head");
  } finally { await f.cleanup(); }
});

test("W1-T13831 criterion 5: sweep_light.pre_review_timing writes pass_scope", async () => {
  const f = fixture(86, "head-live");
  try {
    for (const scope of [undefined, HANDOFF, IDLE, BOOT]) {
      await f.hook(scope);
      await f.settle();
    }
    assert.deepEqual(f.timing().map((row) => row.pass_scope), ["ordinary", "ordinary", "idle", "boot"]);
  } finally { await f.cleanup(); }
});

test("W1-T13831 criterion 6: through servedOpenPrViews, a pass with no scope sends no list, check or status read; its refill does", async () => {
  const f = fixture(87, "head-live");
  try {
    f.publish(generation(TICK_STARTED_AT + 5, [view(87, "head-tick")]));
    await f.hook(undefined);
    await f.settle();
    const beforeRefill = f.atPost[0];
    assert.ok(beforeRefill, "the pass posted a review, which frees a lane for the refill");
    assert.equal(f.listReads(beforeRefill), 0, "no pulls list read");
    assert.equal(f.checkReads(beforeRefill), 0, "no check-runs read");
    assert.equal(f.statusReads(beforeRefill), 0, "no status read");
    assert.ok(f.listReads() >= 1, "the refill read sent the pulls list read");
    assert.ok(f.checkReads() >= 1, "the refill read sent the check-runs read");
    assert.ok(f.statusReads() >= 1, `the refill read sent the status read: ${JSON.stringify(f.gh.calls())}`);
  } finally { await f.cleanup(); }
});
