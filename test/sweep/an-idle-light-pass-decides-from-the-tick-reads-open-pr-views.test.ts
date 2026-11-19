import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { servedOpenPrViews } from "#src/cli/commands/daemon.js";
import { createGhCallPacer } from "#src/lib/github-transport.js";
import { createLightPassOpenPrList, headReadOrStandDown, LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS } from "#src/lib/light-pass-open-pr-list.js";
import { LIVE_WRITE_OVERRIDE_ENV } from "#src/lib/live-write-guard.js";
import { reviewInputDigest } from "#src/lib/review.js";
import type { BuildSweepEffectsDeps, LiveStateResult, SweepDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";
import { buildSweepLightHook } from "#test/helpers/run-task-test.js";
import { TICK_READ_MAX_AGE_MS, freshReadGeneration, type ReadGeneration } from "#src/lib/read-plane.js";
import type { LightPassScope } from "#src/lib/daemon.js";
import type { OpenPrView } from "#src/lib/sweep.js";
import type { TickReadFacts } from "#src/lib/tick-read-worker.js";

const IDLE: LightPassScope = { reviewOnly: true, scope: "idle" };
const DRAIN: LightPassScope = { reviewOnly: true, scope: "drain" };
const BOOT: LightPassScope = { reviewOnly: true, scope: "boot" };
const ORDINARY_IDLE: LightPassScope = { reviewOnly: false, scope: "idle" };
const STARTED_AT = 10_000;
let fixtures = 0;

function view(headSha: string): OpenPrView {
  return { prNumber: 7, prUrl: "https://github.com/o/r/pull/7", taskId: "W1-T7", headSha,
    headRefName: "run-W1-T7-1", lastActivityAt: "2026-11-18T00:00:00Z", reviewState: "none",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, mergeState: "clean",
    changedFiles: ["src/a.ts"], reviewInputDigest: "digest" };
}

function hookView(prNumber: number, headSha: string, ready = false): OpenPrView {
  return { ...view(headSha), prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`,
    headRefName: `run-W1-T${prNumber}-1`, lastActivityAt: new Date().toISOString(), reviewState: ready ? "success" : "none",
    changedFiles: ["src/subject.ts"], reviewInputDigest: reviewInputDigest(headSha, `Remudero-Task: W1-T${prNumber}`) };
}

function pullRow(prNumber: number, headSha: string, repo: string): Record<string, unknown> {
  return { number: prNumber, html_url: `https://github.com/o/${repo}/pull/${prNumber}`, state: "open", draft: false,
    title: `feat: ${prNumber}`, body: `Remudero-Task: W1-T${prNumber}`, updated_at: "2026-11-14T00:00:00Z",
    created_at: "2026-11-14T00:00:00Z", head: { ref: `run-W1-T${prNumber}-1`, sha: headSha } };
}

function hookFixture(ownPr: OpenPrView) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13709-`));
  const repo = `r${++fixtures}`;
  const rows: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  const posted: Array<{ prNumber: number; headSha: string }> = [];
  const live = new Map<number, LiveStateResult>();
  const effectsDeps: BuildSweepEffectsDeps[] = [];
  let served: Promise<OpenPrView[]> | undefined;
  const gh: GhShim = ghShim([
    { when: "state=open", stdout: JSON.stringify([pullRow(ownPr.prNumber, ownPr.headSha, repo)]) },
    { when: "state=closed", stdout: "[]" },
    { when: `/pulls/${ownPr.prNumber}/files`, stdout: JSON.stringify([{ filename: "src/subject.ts" }]) },
    { when: "check-runs", stdout: JSON.stringify({ check_runs: [{ id: 1, name: "ci-gate", status: "completed", conclusion: "success" }] }) },
    { when: "protection", stdout: JSON.stringify({ checks: [{ context: "ci-gate" }] }) },
    { when: "/status", stdout: "{\"statuses\":[]}" },
    { when: `/pulls/${ownPr.prNumber}`, stdout: JSON.stringify({ ...pullRow(ownPr.prNumber, ownPr.headSha, repo), mergeable_state: "clean" }) },
    { when: "", stdout: "[]" },
  ], { kind: "t13709" });
  const keys = ["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_TRANSPORT_FLOOR", "RMD_GH_SHARED_READ_GAP_MS", LIVE_WRITE_OVERRIDE_ENV] as const;
  const oldEnv = keys.map((key) => [key, process.env[key]] as const);
  process.env.PATH = `${gh.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(root, "gh-cache");
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  const effects: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "T13709", readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); }, readLedgerUnion: () => ({ complete: true, lines: rows }),
    readActiveWorkerCount: () => 0, arm: async (pr) => {
      const armImpl = effectsDeps.at(-1)?.armImpl;
      if (armImpl === undefined) return "armed";
      return armImpl(pr.prUrl, pr.taskId, {
        headSha: async () => pr.headSha, say: () => {}, disableAuto: async () => {},
        ledgerLines: () => rows, contributorAdmission: async () => {},
        armAuto: async () => { throw new Error("Pull request is in clean status"); },
        mergeDirect: async () => assert.fail("the merge at the list's head replaces the plain one"),
      });
    },
    postReview: (pr) => { posted.push({ prNumber: pr.prNumber, headSha: pr.headSha }); },
    close: () => assert.fail("unexpected close"), dispatchFix: () => assert.fail("unexpected fix"),
    escalate: () => assert.fail("unexpected escalation"),
    readLiveState: (pr) => live.get(pr.prNumber) ?? { ok: true, state: "OPEN", headSha: pr.headSha },
    rereadPrAtAct: async (pr) => pr, readMainTip: async () => "main-1",
  };
  const io = {
    effects: (deps: BuildSweepEffectsDeps) => { effectsDeps.push(deps); return effects; },
    readCompare: async () => ({ ahead_by: 0, files: [] }),
    openPrViews: (scope?: LightPassScope) => scope === undefined ? undefined : served,
    clock: { now: () => STARTED_AT + 30 },
    pacer: createGhCallPacer({ minGapMs: 0, rateLimitGapMs: 0, sleep: async () => {} }),
  };
  const hook = buildSweepLightHook("o", repo, { root } as never, effects.ledgerPath, "T13709", { tasks: [], byId: new Map() },
    (step, extra = {}) => { logs.push({ step, ...extra }); }, undefined, () => false, () => ({ tasks: [], byId: new Map() }),
    undefined, undefined, io);
  return { effects, effectsDeps, gh, hook, live, logs, posted, rows,
    serve(views: OpenPrView[], readStartedAtMs: number) {
      served = Object.assign(Promise.resolve(structuredClone(views)), { servedReadStartedAtMs: readStartedAtMs });
    },
    async cleanup() {
      for (let quiet = 0, rounds = 0; quiet < 40 && rounds < 600; rounds++) {
        const before = gh.events();
        await sleep(50);
        const after = gh.events();
        const open = after.filter((event) => event.phase === "start").length - after.filter((event) => event.phase === "end").length;
        quiet = open === 0 && after.length === before.length ? quiet + 1 : 0;
      }
      for (const [key, value] of oldEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(gh.dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    } };
}

function generation(publishedAtMs: number, views: OpenPrView[], openPrError?: string): ReadGeneration<TickReadFacts> {
  return { generation: 1, source: "inline", publishedAtMs,
    facts: { openPrViews: views, ...(openPrError === undefined ? {} : { openPrError }) } as unknown as TickReadFacts };
}

test("W1-T13709 criterion 1: idle and drain scoped passes serve a fresh error-free tick read", async () => {
  const published = generation(STARTED_AT + 10, [view("tick-head")]);
  const serve = servedOpenPrViews(() => published, () => STARTED_AT);
  for (const scope of [IDLE, DRAIN]) {
    const served = serve(scope, "pass");
    assert.ok(served);
    assert.equal(served.servedReadStartedAtMs, published.publishedAtMs);
    assert.deepEqual(await served, [view("tick-head")]);
  }
  assert.equal(serve(undefined, "refill"), undefined, "a refill read continues to read its own views");
});

test("W1-T13709 criterion 2: stale, errored, or pre-tick generations are not served", () => {
  for (const candidate of [undefined, generation(STARTED_AT - 1, [view("old")]), generation(STARTED_AT + 1, [view("error")], "open PR read failed")]) {
    const serve = servedOpenPrViews(() => candidate, () => STARTED_AT);
    assert.equal(serve(IDLE, "pass"), undefined);
  }
  const tooOld = generation(STARTED_AT + 1, [view("too-old")]);
  const fresh = freshReadGeneration(tooOld, { consumer: "sweep_light", clock: { now: () => STARTED_AT + TICK_READ_MAX_AGE_MS + 2,
    date: () => new Date(STARTED_AT + TICK_READ_MAX_AGE_MS + 2), iso: () => new Date(STARTED_AT + TICK_READ_MAX_AGE_MS + 2).toISOString() } });
  assert.equal(servedOpenPrViews(() => fresh, () => STARTED_AT)(IDLE, "pass"), undefined);
});

test("W1-T13709 criterion 2: a generation whose read started before the last good list is ignored", async () => {
  let now = STARTED_AT;
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const list = createLightPassOpenPrList<string>({ clock: { now: () => now }, log: (step, extra) => logs.push({ step, extra }),
    runId: "W1-T13709", deadlineMs: 1_000, maxAgeMs: LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS });
  const own = async () => ["own"];
  const first = Object.assign(Promise.resolve(["first-tick"]), { servedReadStartedAtMs: STARTED_AT + 5 });
  assert.equal((await list.read(first, own)).source, "tick_read");
  now = STARTED_AT + 20;
  const older = Object.assign(Promise.resolve(["older-tick"]), { servedReadStartedAtMs: STARTED_AT + 4 });
  const result = await list.read(older, own);
  assert.equal(result.source, "own_read");
  assert.deepEqual(result.views, ["own"]);
  // A read that started with the last good list's own read is not older than it, so it is served.
  const same = Object.assign(Promise.resolve(["same-start"]), { servedReadStartedAtMs: STARTED_AT + 20 });
  assert.equal((await list.read(same, own)).source, "tick_read");
  // The boot pass keeps the W1-T12236 rule: it takes the tick read whatever the last good list's start.
  const boot = await list.read(older, own, { boot: true });
  assert.equal(boot.source, "tick_read");
  assert.deepEqual(boot.views, ["older-tick"]);
});

test("W1-T13709 criterion 2: a stale served generation uses the hook's own read and keeps its source", async () => {
  const own = hookView(71, "own-head");
  const f = hookFixture(own);
  try {
    f.serve([hookView(71, "first-tick-head")], STARTED_AT + 5);
    f.effects.continueReviewAdmissions = () => false;
    await f.hook(IDLE);
    delete f.effects.continueReviewAdmissions;
    f.live.set(71, { ok: true, state: "OPEN", headSha: "unexpected-moved-head" });
    f.serve([hookView(71, "older-tick-head")], STARTED_AT + 4);
    await f.hook(IDLE);
    assert.equal(f.logs.filter((row) => row.step === "sweep_light.pre_review_timing").at(-1)?.views_source, "own_read");
    assert.deepEqual(f.posted, [{ prNumber: 71, headSha: "own-head" }]);
    assert.equal(f.rows.some((row) => row.step === "sweep.head_moved"), false,
      "the own read does not inherit last-good-list act-time guards");
  } finally { await f.cleanup(); }
});

test("W1-T13709 criterion 4: boot retains the tick-read rule and refill has no served scope", async () => {
  const published = generation(STARTED_AT + 1, [view("boot-head")]);
  const serve = servedOpenPrViews(() => published, () => STARTED_AT);
  assert.deepEqual(await serve(BOOT, "pass"), [view("boot-head")]);
  assert.equal(serve(BOOT, "refill"), undefined);
});

test("W1-T13709 criterion 3: the act-time guard returns the moved head and stands down when it cannot read it", async () => {
  const moved = headReadOrStandDown(async () => ({ ok: true, state: "OPEN", headSha: "head-moved" }));
  assert.equal((await moved(view("head-tick"))).headSha, "head-moved");
  const unreadable = headReadOrStandDown(async () => ({ ok: false }));
  await assert.rejects(async () => { await unreadable(view("head-tick")); }, /standing down/);
});

test("W1-T13709 criterion 3: a served idle list guards moved heads and a direct merge names its listed head", async () => {
  const moved = hookView(72, "head-listed-moved");
  const ready = hookView(73, "a".repeat(40), true);
  const f = hookFixture(moved);
  process.env[LIVE_WRITE_OVERRIDE_ENV] = "1";
  try {
    f.rows.push({ step: "review.posted", task_id: ready.taskId, pr_url: ready.prUrl, head_sha: ready.headSha,
      state: "success", capped: false, plan_only: false });
    appendLedger(f.effects.ledgerPath, { run_id: "T13709", task_id: "SWEEP", step: "fixture.ledger_exists" });
    f.live.set(moved.prNumber, { ok: true, state: "OPEN", headSha: "head-moved-live" });
    f.serve([moved, ready], STARTED_AT + 5);
    await f.hook(ORDINARY_IDLE);
    assert.ok(f.rows.some((row) => row.step === "sweep.head_moved" && row.pr_number === moved.prNumber &&
      row.live_head_sha === "head-moved-live"), JSON.stringify(f.logs));
    assert.equal(f.posted.some((post) => post.prNumber === moved.prNumber), false);
    const merge = f.gh.calls().find((call) => call.includes(`pulls/${ready.prNumber}/merge`));
    assert.ok(merge, JSON.stringify({ calls: f.gh.calls(), rows: f.rows }));
    assert.match(merge, new RegExp(`sha=${ready.headSha}`), "direct merge names the served list's head");
  } finally { await f.cleanup(); }
});

test("W1-T13709 criterion 5: a fresh served read avoids the list reader, while no snapshot uses it", async () => {
  let now = STARTED_AT + 10;
  let ownReads = 0;
  const list = createLightPassOpenPrList<string>({ clock: { now: () => now }, log: () => {}, runId: "W1-T13709",
    deadlineMs: 1_000, maxAgeMs: LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS });
  const served = Object.assign(Promise.resolve(["tick"]), { servedReadStartedAtMs: STARTED_AT + 5 });
  const fromTick = await list.read(served, async () => { ownReads++; return ["own"]; });
  assert.equal(fromTick.source, "tick_read");
  assert.deepEqual(fromTick.views, ["tick"]);
  assert.equal(ownReads, 0);
  now++;
  const fromOwnRead = await list.read(undefined, async () => { ownReads++; return ["own"]; });
  assert.equal(fromOwnRead.source, "own_read");
  assert.deepEqual(fromOwnRead.views, ["own"]);
  assert.equal(ownReads, 1);
});
