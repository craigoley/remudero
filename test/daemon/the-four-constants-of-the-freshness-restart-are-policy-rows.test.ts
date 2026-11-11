// W1-T12228: the freshness restart's four constants (src/lib/deploy-judge.ts) are bounded rows of plan/policy.yaml.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";

import { freshnessRestartLadder, freshnessRestartOpts } from "#src/cli/commands/daemon.js";
import { fixedClock } from "#src/lib/clock.js";
import { runDaemon, type DaemonFreshness, type DaemonOpts } from "#src/lib/daemon.js";
import * as judge from "#src/lib/deploy-judge.js";
import { runLiveEditLadder } from "#src/lib/live-edit-ladder.js";
import { loadPlan } from "#src/lib/plan.js";
import { DEFAULT_FRESHNESS_RESTART, loadPolicy, policyPath, PolicyError, validatePolicy } from "#src/lib/policy.js";
import { trackInFlightReview } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const POLICY_PATH = policyPath(REPO_ROOT);
const POLICY_TEXT = readFileSync(POLICY_PATH, "utf8");
const committed = () => loadPolicy(POLICY_PATH);
const rawPolicy = () => parseYaml(POLICY_TEXT) as Record<string, unknown>;

/** The committed policy with one freshnessRestart row's `value` replaced. */
function withRow(key: string, value: number): unknown {
  const raw = rawPolicy();
  const block = raw.freshnessRestart as Record<string, Record<string, unknown>>;
  block[key] = { ...block[key]!, value };
  return raw;
}

const sourceCommits = (tag: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ sha: `${tag}-${index}`.padStart(40, "c"), subject: "feat: x", files: ["src/lib/daemon.ts"] }));

test("W1-T12228 criterion 1: the policy file has the block freshnessRestart with four one-line bounded rows", () => {
  const rows: Array<[string, number, string, number, number]> = [
    ["scoreLimit", 18, "DEPLOY_RESTART_SCORE_THRESHOLD", 6, 54],
    ["stalenessHorizonMs", 3600000, "DEPLOY_RESTART_RATE_CEILING_MS", 900000, 14400000],
    ["quietWindowMs", 600000, "FRESHNESS_COALESCE_WINDOW_MS", 0, 1800000],
    ["minLifetimeMs", 5400000, "FRESHNESS_MIN_LIFETIME_MS", 0, 21600000],
  ];
  assert.match(POLICY_TEXT, /^freshnessRestart:$/m);
  const policy = committed();
  for (const [key, value, constant, min, max] of rows) {
    const line = new RegExp(`^  ${key}: \\{ value: ${value}, origin: "lifted:src/lib/deploy-judge\\.ts \\(${constant}\\)", min: ${min}, max: ${max} \\}$`, "m");
    assert.match(POLICY_TEXT, line, `${key} is one flow-style line naming ${constant}`);
    assert.ok(constant in judge, `${constant} is still exported by deploy-judge.ts`);
    assert.equal(policy.values.freshnessRestart[key as keyof typeof DEFAULT_FRESHNESS_RESTART], value);
    assert.deepEqual(policy.bounds[`freshnessRestart.${key}`], { min, max });
    assert.equal(policy.origin[`freshnessRestart.${key}`]!.kind, "lifted");
  }
});

test("W1-T12228 criterion 2: the loader refuses a value outside its row's bounds and an absent block loads today's values", () => {
  const refused: Array<[string, number]> = [
    ["scoreLimit", 100], ["scoreLimit", 5], ["stalenessHorizonMs", 899999], ["stalenessHorizonMs", 14400001],
    ["quietWindowMs", 1800001], ["quietWindowMs", -1], ["minLifetimeMs", 21600001], ["minLifetimeMs", -1],
  ];
  for (const [key, value] of refused) {
    assert.throws(() => validatePolicy(withRow(key, value)), (e: unknown) => e instanceof PolicyError && e.message.includes(`freshnessRestart.${key}`), `${key}=${value}`);
  }
  assert.equal(validatePolicy(withRow("scoreLimit", 54)).values.freshnessRestart.scoreLimit, 54, "the bound itself is accepted");
  const absent = rawPolicy();
  delete absent.freshnessRestart;
  const loaded = validatePolicy(absent).values.freshnessRestart;
  assert.deepEqual(loaded, { scoreLimit: 18, stalenessHorizonMs: 3_600_000, quietWindowMs: 600_000, minLifetimeMs: 5_400_000 });
  assert.equal(loaded.scoreLimit, judge.DEPLOY_RESTART_SCORE_THRESHOLD.value);
  assert.equal(loaded.stalenessHorizonMs, judge.DEPLOY_RESTART_RATE_CEILING_MS);
  assert.equal(loaded.quietWindowMs, judge.FRESHNESS_COALESCE_WINDOW_MS.value);
  assert.equal(loaded.minLifetimeMs, judge.FRESHNESS_MIN_LIFETIME_MS);
});

type Row = { step: string; extra: Record<string, unknown> };

/** A busy daemon (an in-flight review) on a fake clock, stale on `changes`, run with the given options. */
async function busyDaemon(changes: ReturnType<typeof sourceCommits>, opts: DaemonOpts): Promise<Row[]> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}freshness-rows-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  let release!: () => void;
  void trackInFlightReview(new Promise<void>((resolve) => { release = resolve; }), { taskId: "A", prNumber: 1 });
  let nowMs = Date.parse("2026-11-11T00:00:00Z");
  const rows: Row[] = [];
  const freshness: DaemonFreshness = { stale: true, oldSha: "boot", newSha: changes[0]!.sha, changes };
  try {
    const summary = await Promise.race([
      runDaemon(loadPlan(path), {
        refreshMerged: () => () => true,
        runOne: async (taskId) => ({ taskId, runId: "unused", merged: true, costUsd: 0, verdict: "merged" }),
        now: () => new Date(nowMs),
        sleep: async () => { nowMs += MINUTE; if (rows.filter((r) => r.step === "daemon.freshness_decision").length >= 3) release(); },
        sweep: async () => ({}),
        checkFreshness: () => freshness,
        readLedgerLines: () => [],
        log: (step, extra = {}) => {
          rows.push({ step, extra });
          if (step === "daemon.freshness_decision" && extra.action === "restart") setTimeout(release, 5);
        },
      }, opts),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 5_000)),
    ]);
    assert.notEqual(summary, "timed-out");
  } finally {
    release();
    rmSync(dir, { recursive: true, force: true });
  }
  return rows;
}
const decisions = (rows: Row[]) => rows.filter((r) => r.step === "daemon.freshness_decision").map((r) => r.extra);

test("W1-T12228 criterion 3: a policy with scoreLimit 9 restarts a busy daemon at pressure 9", async (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}freshness-policy-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "policy.yaml");
  writeFileSync(file, POLICY_TEXT.replace(/^(  scoreLimit: \{ value: )18,/m, "$19,").replace(/^(  quietWindowMs: \{ value: )600000,/m, "$10,"));
  const policy = loadPolicy(file);
  assert.equal(policy.values.freshnessRestart.scoreLimit, 9);
  // The options the daemon command builds from the loaded policy, beside the bound it already threads.
  const opts: DaemonOpts = { sweepWallClockBoundMs: 24 * HOUR, ...freshnessRestartOpts(policy.values.freshnessRestart), freshnessMinLifetimeMs: 0 };
  const changes = sourceCommits("nine", 9);
  const decided = decisions(await busyDaemon(changes, opts));
  assert.equal(decided[0]!.busy, true);
  assert.equal(decided[0]!.pressure, 9);
  assert.equal(decided[0]!.action, "restart", "9 >= scoreLimit 9");
  // Control: the committed 18 defers the same advance at the same pressure.
  const control = decisions(await busyDaemon(changes, { ...opts, ...freshnessRestartOpts(committed().values.freshnessRestart), freshnessMinLifetimeMs: 0 }));
  assert.equal(control[0]!.pressure, 9);
  assert.equal(control[0]!.action, "defer", "9 < 18");
});

test("W1-T12228 criterion 4: with the default rows the freshness judge decides and gives its reason as before", () => {
  const rows = committed().values.freshnessRestart;
  const limit = judge.DEPLOY_RESTART_SCORE_THRESHOLD;
  const explicit = {
    threshold: { value: rows.scoreLimit, reason: "policy" }, ageHorizonMs: rows.stalenessHorizonMs,
  };
  const fresh = { total: 0, scoredShas: [] as string[] };
  const T0 = 1_000_000_000;
  const decide = (changes: ReturnType<typeof sourceCommits>, busy: boolean, nowMs: number, extra: object) =>
    judge.decideFreshnessRestart({ changes, busy, staleSinceMs: T0, nowMs, state: fresh, ...extra });
  const coalesce = (changes: ReturnType<typeof sourceCommits>, nowMs: number, lifetimeStartedAtMs: number, lastAdvanceAtMs: number, extra: object) =>
    judge.coalesceFreshnessRestart({
      decision: decide(changes, true, nowMs, {}), newSha: "sha", lastAdvanceAtMs, staleSinceMs: T0, nowMs,
      window: judge.FRESHNESS_COALESCE_WINDOW_MS, lifetimeStartedAtMs, ...extra,
    });
  const explicitCoalesce = {
    ...explicit, window: { value: rows.quietWindowMs, reason: "policy" }, minLifetimeMs: rows.minLifetimeMs,
  };
  const enough = sourceCommits("enough", limit.value);

  for (const extra of [{}, explicit]) {
    const extraCoalesce = extra === explicit ? explicitCoalesce : {};
    // defer: one low-weight commit while busy.
    const deferred = decide(sourceCommits("low", 1), true, T0, extra);
    assert.equal(deferred.action, "defer");
    assert.equal(deferred.reason, "busy, and pressure 1 (change 1 + staleness 0) < 18: wait for an idle moment");
    // hold for the minimum lifetime: a restart decision in a lifetime younger than 90 minutes.
    const young = coalesce(enough, T0 + MINUTE, T0, T0 + MINUTE, extraCoalesce);
    assert.equal(young.action, "hold");
    assert.equal(young.reason, judge.MIN_LIFETIME_HOLD);
    // hold for the quiet window: old enough, advance 1 minute ago, stale for 1 minute.
    const quiet = coalesce(enough, T0 + MINUTE, T0 - 2 * HOUR, T0 + MINUTE, extraCoalesce);
    assert.equal(quiet.action, "hold");
    assert.equal(quiet.reason, "coalescing sha: waiting for a quiet advance window");
    assert.equal(quiet.windowEndsAtMs, T0 + MINUTE + 10 * MINUTE);
    // restart: the quiet window has passed.
    const restart = coalesce(enough, T0 + 11 * MINUTE, T0 - 2 * HOUR, T0 + MINUTE, extraCoalesce);
    assert.equal(restart.action, "restart");
    assert.equal(restart.reason, "window_quiet");
  }
});

test("W1-T12228 criterion 5: the row daemon.freshness_decision carries the four values in force", async () => {
  const opts: DaemonOpts = {
    sweepWallClockBoundMs: 24 * HOUR,
    ...freshnessRestartOpts({ scoreLimit: 9, stalenessHorizonMs: 2 * HOUR, quietWindowMs: 0, minLifetimeMs: 0 }),
  };
  const decided = decisions(await busyDaemon(sourceCommits("row", 9), opts));
  assert.ok(decided.length >= 1);
  for (const row of decided) {
    assert.equal(row.score_limit, 9);
    assert.equal(row.staleness_horizon_ms, 2 * HOUR);
    assert.equal(row.quiet_window_ms, 0);
    assert.equal(row.min_lifetime_ms, 0);
  }
  const defaults = decisions(await busyDaemon(sourceCommits("row", 1), { sweepWallClockBoundMs: 24 * HOUR, freshnessMinLifetimeMs: 0 }));
  assert.equal(defaults[0]!.score_limit, 18);
  assert.equal(defaults[0]!.staleness_horizon_ms, HOUR);
  assert.equal(defaults[0]!.quiet_window_ms, 10 * MINUTE);
});

test("W1-T12228 criterion 6: the live-edit ladder computes pressure with the daemon's score limit and horizon", async (t: TestContext) => {
  const origin = gitRepo({ bare: true, kind: "rows-origin" });
  const author = gitRepo({ kind: "rows-author" });
  writeFileSync(join(author.dir, "app.txt"), "v1\n");
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "seed");
  author.addRemote("origin", origin.dir);
  author.git("push", "--quiet", "origin", "main");
  const live = gitRepo({ cloneFrom: origin.dir, kind: "rows-live" });
  mkdirSync(join(author.dir, "src"));
  writeFileSync(join(author.dir, "src", "feature.ts"), "export const x = 1;\n");
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "feat: main moves on");
  author.git("push", "--quiet", "origin", "main");
  live.git("fetch", "--quiet", "origin", "main");
  writeFileSync(join(live.dir, "app.txt"), "hand edit\n");
  const T0 = Date.parse("2026-11-11T00:17:00Z");
  const rung = async (nowMs: number, rows: { scoreLimit: number; stalenessHorizonMs: number } | undefined) => {
    const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rows-state-`));
    t.after(() => rmSync(state, { recursive: true, force: true }));
    const common = { tree: "daemon-checkout" as const, repoDir: live.dir, stateDir: state, host: "fleet-host", escalate: async () => "https://github.com/example/fleet/issues/1" };
    await runLiveEditLadder({ ...common, clock: fixedClock(T0), ...rows });
    return runLiveEditLadder({ ...common, clock: fixedClock(nowMs), ...rows });
  };
  const daemonRows = { scoreLimit: 9, stalenessHorizonMs: HOUR, quietWindowMs: 600000, minLifetimeMs: 5400000 };
  // The same advance, scored by the daemon's judge with the same two values.
  const daemonPressure = judge.decideFreshnessRestart({
    changes: [{ sha: "x", files: ["src/feature.ts"] }], busy: true, staleSinceMs: T0, nowMs: T0 + HOUR, state: { total: 0, scoredShas: [] },
    threshold: { value: 9, reason: "policy" }, ageHorizonMs: HOUR,
  }).pressure;
  const nine = await rung(T0 + HOUR, freshnessRestartLadder(daemonRows));
  assert.equal(nine.pressure, daemonPressure);
  assert.equal(nine.pressure, 10);
  assert.equal(nine.tier, 2, "pressure 10 >= scoreLimit 9");
  assert.match(nine.reason, /pressure 10 >= 9/);
  // A four-hour horizon: the same hour of staleness is 1 + floor(18 * 1h / 4h) = 5, under the limit of 18.
  const slow = await rung(T0 + HOUR, freshnessRestartLadder({ ...daemonRows, scoreLimit: 18, stalenessHorizonMs: 4 * HOUR }));
  assert.equal(slow.pressure, 5);
  assert.equal(slow.tier, 1);
  // Control: with neither value the ladder keeps today's constants (18 over one hour).
  const base = await rung(T0 + HOUR, undefined);
  assert.equal(base.pressure, 19);
  assert.equal(base.tier, 2);
});
