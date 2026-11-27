/**
 * W1-T12755 — A LIGHT PASS DECIDES FROM ITS LAST GOOD OPEN-PR LIST WHEN THE READ FAILS.
 *
 * On the Azure host core ledger, 2026-11-12T22:35Z to 2026-11-14T22:35Z, 295 rate-limited
 * `pulls?state=open` reads ended 299 of 389 light passes in the hours that had errors: each pass made
 * no review or merge decision. A light pass now decides from the last list that read without error,
 * while that list is younger than its age limit. On that list it reads every head again at act time,
 * stands a moved or unreadable head down, and names the list's head on a direct merge.
 *
 * Each hook test drives the real `buildSweepLightHook`. The criterion 6 test reads the list through the
 * real `buildOpenPrViewsAsync` and the async `gh` transport, answered by a PATH-shim `gh`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

import { createGhCallPacer, DEFAULT_GH_CALL_TIMEOUT_MS, DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS } from "#src/lib/github-transport.js";
import { appendLedger } from "#src/lib/ledger.js";
import {
  createLightPassOpenPrList,
  LIGHT_PASS_VIEWS_DEADLINE_MS,
  LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS,
} from "#src/lib/light-pass-open-pr-list.js";
import { LIVE_WRITE_OVERRIDE_ENV } from "#src/lib/live-write-guard.js";
import type { LightPassScope } from "#src/lib/daemon.js";
import type { Plan } from "#src/lib/plan.js";
import { reviewInputDigest } from "#src/lib/review.js";
import type { BuildSweepEffectsDeps, LiveStateResult, OpenPrView, SweepDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";
import { buildSweepLightHook } from "#test/helpers/run-task-test.js";

const NO_PLAN: Plan = { tasks: [], byId: new Map() };
const IDLE: LightPassScope = { reviewOnly: false, scope: "idle" };
const RATE_LIMITED = "gh: API rate limit exceeded for installation ID 1 (HTTP 403)";
const rateLimitError = () => Object.assign(
  new Error("gh api repos/o/r/pulls?state=open&per_page=100 -i: HTTP 403 API rate limit exceeded"), { stderr: RATE_LIMITED });

function view(prNumber: number, headSha: string, ready = false): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`, headSha,
    headRefName: `run-W1-T${prNumber}-1`, lastActivityAt: new Date().toISOString(), reviewState: ready ? "success" : "none",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, mergeState: "clean",
    changedFiles: ["src/subject.ts"], reviewInputDigest: reviewInputDigest(headSha, `Remudero-Task: W1-T${prNumber}`),
  };
}

function pullRow(prNumber: number, headSha: string, repo: string): Record<string, unknown> {
  return {
    number: prNumber, html_url: `https://github.com/o/${repo}/pull/${prNumber}`, state: "open", draft: false,
    title: `feat: ${prNumber}`, body: `Remudero-Task: W1-T${prNumber}`, updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(), head: { ref: `run-W1-T${prNumber}-1`, sha: headSha },
  };
}

/** GitHub as one open pull request at `headSha` with a green required check; anything else answers `[]`. */
function shimFor(prNumber: number, headSha: string, repo: string): GhShim {
  return ghShim([
    { when: "state=open", stdout: JSON.stringify([pullRow(prNumber, headSha, repo)]) },
    { when: "state=closed", stdout: "[]" },
    { when: `/pulls/${prNumber}/files`, stdout: JSON.stringify([{ filename: "src/subject.ts" }]) },
    { when: "check-runs", stdout: JSON.stringify({ check_runs: [{ id: 1, name: "ci-gate", status: "completed", conclusion: "success" }] }) },
    { when: "protection", stdout: JSON.stringify({ checks: [{ context: "ci-gate" }] }) },
    { when: "/status", stdout: "{\"statuses\":[]}" },
    { when: `/pulls/${prNumber}`, stdout: JSON.stringify({ ...pullRow(prNumber, headSha, repo), mergeable_state: "clean" }) },
    { when: "", stdout: "[]" },
  ], { kind: "t12755" });
}

let fixtures = 0;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12755-`));
  // A repository name of its own: the async transport keeps recent answers in this process.
  const repo = `r${++fixtures}`;
  const keys = ["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_TRANSPORT_FLOOR", "RMD_GH_SHARED_READ_GAP_MS", LIVE_WRITE_OVERRIDE_ENV] as const;
  const oldEnv = keys.map((key) => [key, process.env[key]] as const);
  const basePath = process.env.PATH;
  const shims: GhShim[] = [];
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  process.env.RMD_GH_CACHE_HOME = join(root, "gh-cache");
  const useShim = (prNumber: number, headSha: string): GhShim => {
    const gh = shimFor(prNumber, headSha, repo);
    shims.push(gh);
    process.env.PATH = `${gh.dir}:${basePath}`;
    return gh;
  };
  useShim(0, "unused");
  const logs: Array<Record<string, unknown>> = [];
  const posted: Array<{ prNumber: number; headSha: string }> = [];
  const rows: Array<Record<string, unknown>> = [];
  const live = new Map<number, LiveStateResult>();
  const effectsDeps: Array<Parameters<NonNullable<NonNullable<Parameters<typeof buildSweepLightHook>[12]>["effects"]>>[0]> = [];
  let nowMs = 1_000_000;
  const effects: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "T12755", readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); }, readLedgerUnion: () => ({ complete: true, lines: rows }),
    readActiveWorkerCount: () => 0, arm: () => assert.fail("unexpected arm"),
    postReview: (pr) => { posted.push({ prNumber: pr.prNumber, headSha: pr.headSha }); },
    close: () => assert.fail("unexpected close"), dispatchFix: () => assert.fail("unexpected fix"),
    escalate: () => assert.fail("unexpected escalation"),
    readLiveState: (p) => live.get(p.prNumber) ?? { ok: true, state: "OPEN", headSha: p.headSha }, rereadPrAtAct: async (p) => p,
    readMainTip: async () => "main-1",
  };
  let serve: (() => Promise<OpenPrView[]>) | undefined;
  // The pacer's rate-limit backoff is production's (a 60 s floor between retries); only its timer is the test's,
  // so a 403 on the list read resolves at once and the sleeps it asked for are kept to assert on.
  const backoffSleeps: number[] = [];
  const pacer = createGhCallPacer({ minGapMs: 0, rateLimitGapMs: 0, sleep: async (ms) => { backoffSleeps.push(ms); } });
  // A variable, not a literal: the hook reads `pacer` from its ports, and run-task's port type does not name it.
  const ports = {
    effects: (deps: (typeof effectsDeps)[number]) => { effectsDeps.push(deps); return effects; },
    readCompare: async () => ({ ahead_by: 0, files: [] }),
    openPrViews: (scope?: LightPassScope) => scope === undefined ? undefined : serve?.(),
    clock: { now: () => nowMs },
    pacer,
  };
  const hook = () => buildSweepLightHook("o", repo, { root } as never, effects.ledgerPath, "T12755", NO_PLAN,
    (step, extra) => { logs.push({ step, ...extra }); }, undefined, () => false, () => NO_PLAN, undefined, undefined, ports);
  const steps = (step: string) => logs.filter((row) => row.step === step);
  return { root, repo, logs, posted, rows, live, effects, effectsDeps, hook, steps, useShim, backoffSleeps,
    serveViews: (views: OpenPrView[]) => { serve = async () => structuredClone(views); },
    serveError: (error: Error) => { serve = async () => { throw error; }; },
    ownRead: () => { serve = undefined; },
    advance: (ms: number) => { nowMs += ms; },
    cleanup: async () => {
      // A posted review frees a lane, and the refill reads the open pull requests after the hook returns.
      // A no-scope refill now owns its view read. Let the production pacer's 1.5 s slot and
      // the resulting shim process finish before removing the PATH shim.
      for (let quiet = 0, rounds = 0; quiet < 40 && rounds < 600; rounds++) {
        const before = shims.flatMap((gh) => gh.events());
        await sleep(50);
        const after = shims.flatMap((gh) => gh.events());
        const open = after.filter((e) => e.phase === "start").length - after.filter((e) => e.phase === "end").length;
        quiet = open === 0 && after.length === before.length ? quiet + 1 : 0;
      }
      for (const [key, value] of oldEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      for (const gh of shims) rmSync(gh.dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    } };
}

/** Pass 1 reads the list but admits no review, so the eligible PR is still due on pass 2. */
async function firstPassWithoutReview(f: ReturnType<typeof fixture>): Promise<void> {
  f.effects.continueReviewAdmissions = () => false;
  await f.hook()(IDLE);
  delete f.effects.continueReviewAdmissions;
  assert.equal(f.posted.length, 0, "control: pass 1 admitted no review");
  assert.equal(f.steps("sweep_light.views_fallback").length, 0, "control: pass 1 read a fresh list");
}

test("W1-T12755 criterion 1: a rate-limited read after a good one still admits the review from the last good list", async () => {
  const f = fixture();
  try {
    const hook = f.hook();
    f.serveViews([view(1275501, "head-a")]);
    f.effects.continueReviewAdmissions = () => false;
    await hook(IDLE);
    delete f.effects.continueReviewAdmissions;
    assert.equal(f.posted.length, 0, "control: pass 1 admitted no review");
    f.serveError(rateLimitError());
    f.advance(30_000);
    await hook(IDLE);
    assert.deepEqual(f.posted, [{ prNumber: 1275501, headSha: "head-a" }], JSON.stringify(f.logs));
    // The refill read after the posted review frees a lane falls back too.
    const fallback = f.steps("sweep_light.views_fallback");
    assert.ok(fallback.length >= 1);
    assert.ok(fallback.every((row) => row.reason === "rate_limited"), JSON.stringify(fallback));
    assert.equal(fallback[0]!.snapshot_age_ms, 30_000);
    assert.equal(fallback[0]!.pr_count, 1);
    assert.match(String(fallback[0]!.error), /rate limit/);
    assert.equal(f.steps("sweep_light.error").length, 0);
    assert.ok(f.rows.some((row) => row.step === "sweep.review_admitted" && row.pr_number === 1275501));
  } finally { await f.cleanup(); }
});

test("W1-T12755 criterion 2: a slow read goes on from the last good list, keeps running, and no second read starts", async () => {
  const logs: Array<Record<string, unknown>> = [];
  let nowMs = 0;
  const list = createLightPassOpenPrList<string>({ clock: { now: () => nowMs }, log: (step, extra) => logs.push({ step, ...extra }),
    runId: "T12755", deadlineMs: 20, maxAgeMs: LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS });
  assert.equal(LIGHT_PASS_VIEWS_DEADLINE_MS, DEFAULT_GH_CALL_TIMEOUT_MS, "the deadline is the existing gh call budget");
  let reads = 0;
  let settle!: (views: string[]) => void;
  const slowRead = () => { reads++; return new Promise<string[]>((resolve) => { settle = resolve; }); };
  assert.deepEqual(await list.read(undefined, async () => { reads++; return ["A"]; }), { fallback: false, source: "own_read", views: ["A"], readStartedAtMs: 0 });
  nowMs = 1_000;
  const second = await list.read(undefined, slowRead);
  assert.equal(second.fallback, true);
  assert.deepEqual(second.views, ["A"]);
  assert.equal(logs.at(-1)!.reason, "slow_read");
  assert.equal(reads, 2, "the slow read started once");
  const third = await list.read(undefined, slowRead);
  assert.equal(reads, 2, "no second list read starts while one is in flight");
  assert.equal(third.fallback, true);
  settle(["B"]);
  await sleep(0);
  const fourth = await list.read(undefined, async () => { reads++; throw new Error("read failed"); });
  assert.deepEqual(fourth.views, ["B"], "the read that kept running is the next pass's list");
  assert.equal(logs.at(-1)!.reason, "read_failed");
  assert.equal(reads, 3, "a new read starts only after the one in flight settled");
});

test("W1-T12755 criterion 3: on a last good list a moved or unreadable head stands down and a merge names the list's head", async () => {
  const f = fixture();
  const gh = f.useShim(0, "unused");
  const moved = view(1275531, "head-moved-old");
  const unreadable = view(1275532, "head-unreadable");
  const ready = view(1275533, "a".repeat(40), true);
  const reviewed = { step: "review.posted", task_id: ready.taskId, pr_url: ready.prUrl, head_sha: ready.headSha,
    state: "success", capped: false, plan_only: false };
  f.rows.push(reviewed);
  appendLedger(f.effects.ledgerPath, { run_id: "T12755", task_id: "SWEEP", step: "fixture.ledger_exists" });
  const armImpls: Array<BuildSweepEffectsDeps["armImpl"]> = [];
  const merged: string[] = [];
  // The effect calls the armImpl the hook built its effects with, over fakes that reach the direct merge.
  f.effects.arm = async (pr) => {
    const armImpl = (f.effectsDeps.at(-1) as BuildSweepEffectsDeps).armImpl;
    armImpls.push(armImpl);
    if (armImpl === undefined) return "armed";
    const result = await armImpl(pr.prUrl, pr.taskId, {
      headSha: async () => pr.headSha, say: () => {}, disableAuto: async () => {},
      ledgerLines: () => [{ task_id: pr.taskId, step: "review.posted", state: "success", head_sha: pr.headSha, pr_url: pr.prUrl }],
      contributorAdmission: async () => {}, armAuto: async () => { throw new Error("Pull request is in clean status"); },
      mergeDirect: async () => assert.fail("the merge at the list's head replaces the plain one"),
    });
    merged.push(pr.prUrl);
    return result;
  };
  process.env[LIVE_WRITE_OVERRIDE_ENV] = "1";
  try {
    const hook = f.hook();
    f.serveViews([moved, unreadable, ready]);
    f.effects.continueReviewAdmissions = () => false;
    await hook(IDLE);
    delete f.effects.continueReviewAdmissions;
    assert.equal(armImpls.length, 1, "control: the fresh served list arms once");
    assert.equal(typeof armImpls[0], "function", "control: a fresh served list guards the act-time head");
    // A new pass's ledger: the fresh pass's rows would dedup the arm.
    f.rows.splice(0, f.rows.length, reviewed);
    f.live.set(moved.prNumber, { ok: true, state: "OPEN", headSha: "head-moved-new" });
    f.live.set(unreadable.prNumber, { ok: false });
    f.serveError(rateLimitError());
    await hook(IDLE);
    assert.equal(f.steps("sweep_light.views_fallback")[0]?.reason, "rate_limited");
    assert.equal(f.posted.some((post) => post.prNumber === moved.prNumber), false, "no review for a moved head");
    assert.ok(f.rows.some((row) => row.step === "sweep.head_moved" && row.pr_number === moved.prNumber &&
      row.live_head_sha === "head-moved-new"), JSON.stringify(f.rows));
    assert.equal(f.posted.some((post) => post.prNumber === unreadable.prNumber), false, "no review for an unreadable head");
    assert.ok(f.rows.some((row) => row.step === "sweep.action_failed" && row.pr_number === unreadable.prNumber &&
      /unreadable on the last good open-PR list/.test(String(row.error))), JSON.stringify(f.rows));
    assert.deepEqual(merged, [ready.prUrl, ready.prUrl], "fresh and last-good passes both arm the list's eligible PR");
    const merges = gh.calls().filter((call) => call.includes(`pulls/${ready.prNumber}/merge`));
    assert.equal(merges.length, 2, JSON.stringify(gh.calls()));
    for (const merge of merges) {
      assert.match(merge, new RegExp(`sha=${ready.headSha}`), "the merge names the list's head as expectedHead");
    }
  } finally { await f.cleanup(); }
});

test("W1-T12755 criterion 4: a last good list older than the age limit is not used", async () => {
  const f = fixture();
  try {
    const hook = f.hook();
    f.serveViews([view(1275541, "head-a")]);
    f.effects.continueReviewAdmissions = () => false;
    await hook(IDLE);
    delete f.effects.continueReviewAdmissions;
    f.serveError(rateLimitError());
    f.advance(LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS + 1);
    const before = f.rows.length;
    await hook(IDLE);
    assert.equal(f.posted.length, 0, "no review decision");
    const fallback = f.steps("sweep_light.views_fallback");
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0]!.reason, "snapshot_too_old");
    assert.equal(fallback[0]!.snapshot_age_ms, LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS + 1);
    assert.equal(f.steps("sweep_light.error").length, 1, "the pass stands down as before");
    assert.equal(f.rows.slice(before).some((row) => row.step === "sweep.disposed"), false, "no disposition on the old list");
  } finally { await f.cleanup(); }
});

test("W1-T12755 criterion 5: with no good list a failed read stands down, and every pass writes its timing row", async () => {
  const f = fixture();
  try {
    const hook = f.hook();
    f.serveError(rateLimitError());
    await hook(IDLE);
    assert.equal(f.posted.length, 0);
    assert.equal(f.steps("sweep_light.views_fallback")[0]?.reason, "no_snapshot");
    assert.equal(f.steps("sweep_light.views_fallback")[0]?.snapshot_age_ms, null);
    assert.equal(f.steps("sweep_light.error").length, 1, "the pass stands down as today");
    f.serveViews([view(1275551, "head-a")]);
    f.effects.continueReviewAdmissions = () => false;
    await hook(IDLE);
    delete f.effects.continueReviewAdmissions;
    f.serveError(rateLimitError());
    await hook(IDLE);
    assert.deepEqual(f.steps("sweep_light.pre_review_timing").map((row) => row.views_source), ["tick_read", "tick_read", "fallback"]);
    assert.deepEqual(f.posted, [{ prNumber: 1275551, headSha: "head-a" }]);
  } finally { await f.cleanup(); }
});

test("W1-T12755 criterion 6: through the real list read, a 403 rate limit on the second pass still admits the review", async () => {
  const f = fixture();
  try {
    const gh = f.useShim(1275561, "head-live");
    f.ownRead();
    const hook = f.hook();
    f.effects.continueReviewAdmissions = () => false;
    await hook(IDLE);
    delete f.effects.continueReviewAdmissions;
    assert.equal(f.posted.length, 0, "control: pass 1 admitted no review");
    assert.ok(gh.calls().some((call) => call.includes(`repos/o/${f.repo}/pulls?state=open`)), "pass 1 read the list itself");
    gh.addRoute({ when: "state=open", stderr: RATE_LIMITED, exit: 1 });
    await hook(IDLE);
    assert.equal(f.steps("sweep_light.error").length, 0, JSON.stringify(f.logs));
    assert.equal(f.steps("sweep_light.views_fallback")[0]?.reason, "rate_limited", JSON.stringify(f.logs));
    assert.ok(f.backoffSleeps.length > 0 && f.backoffSleeps.every((ms) => ms >= DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS),
      `the pacer's own refusal backoff ran, on the test's timer: ${JSON.stringify(f.backoffSleeps)}`);
    assert.deepEqual(f.posted, [{ prNumber: 1275561, headSha: "head-live" }]);
    assert.deepEqual(f.steps("sweep_light.pre_review_timing").map((row) => row.views_source), ["own_read", "fallback"]);
  } finally { await f.cleanup(); }
});
