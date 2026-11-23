/**
 * W1-T12232 — the config gardener's retune-restart class proposes a one-step change of the freshness restart's
 * `scoreLimit` or `stalenessHorizonMs` row from the waiting and restart costs of the last 20 complete
 * `daemon.restart_cycle` rows since either row last changed, through the same canary as every other class.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import {
  applyConfigEdits, CONFIG_GARDEN_READ_STEPS, configCandidates, configGardenSpec, restartPolicyChangedAt, restartPolicyRows, restartTuneCandidate,
  restartTuneEvidence, RESTART_CYCLE_STEP, RESTART_TUNE_FACTOR, RESTART_TUNE_ROWS, RESTART_TUNE_STEP, serveConfigMeasurement,
  type ConfigCanary, type ConfigInventory, type RestartTuneInput,
} from "#src/lib/config-gardener.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import { loadPolicy, policyPath } from "#src/lib/policy.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir, type FixtureScope } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ISO = fixedClock(Date.parse("2026-11-23T12:00:00.000Z")).iso();
const CHANGED_MS = Date.parse("2026-11-01T00:00:00.000Z");
const HOUR = 3600_000;
const rng = () => 0;
const SCORE_LINE = `  scoreLimit: { value: 18, origin: "lifted:src/lib/deploy-judge.ts (DEPLOY_RESTART_SCORE_THRESHOLD)", min: 6, max: 54 }`;
const HORIZON_LINE = `  stalenessHorizonMs: { value: 3000000, origin: "lifted:src/lib/deploy-judge.ts (DEPLOY_RESTART_RATE_CEILING_MS)", min: 900000, max: 14400000 }`;
const policyText = (score = SCORE_LINE, horizon = HORIZON_LINE): string => ["# rows", "freshnessRestart:", score, horizon,
  `  quietWindowMs: { value: 600000, origin: "lifted:src/lib/deploy-judge.ts (FRESHNESS_COALESCE_WINDOW_MS)", min: 0, max: 1800000 }`, "", "other: 1", ""].join("\n");

const NOT_STALE = "busy, but pressure 20 (change 20 + staleness 0) >= 18: drain and restart";
const STALE = "busy, but pressure 18 (change 4 + staleness 14) >= 18: drain and restart";

/** The `i`-th cycle after `afterMs`, an hour apart. */
function cycle(i: number, waiting: number | null | undefined, restart: number | null | undefined, trigger: unknown = NOT_STALE, afterMs = CHANGED_MS): Record<string, unknown> {
  const exit = afterMs + (i + 1) * HOUR;
  const iso = (ms: number) => fixedClock(ms).iso();
  return {
    step: RESTART_CYCLE_STEP, ts: iso(exit + 20 * 60_000), exit_at: iso(exit), started_at: iso(exit + 60_000), first_verdict_at: iso(exit + 10 * 60_000),
    trigger, ...(waiting === undefined ? {} : { waiting_cost_ms: waiting }), ...(restart === undefined ? {} : { restart_cost_ms: restart }),
  };
}
const cycles = (n: number, waiting: number, restart: number, trigger: unknown = NOT_STALE, from = 0): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => cycle(from + i, waiting, restart, trigger));

/** `changedAtMs` null: the last change is unknown. */
function input(rows: Record<string, unknown>[], text = policyText(), changedAtMs: number | null = CHANGED_MS): RestartTuneInput {
  return { rows: restartPolicyRows(text), ...(changedAtMs === null ? { unknownChange: "fixture" } : { changedAtMs }), cycles: rows };
}
function inventory(restart: RestartTuneInput, extra: Partial<ConfigInventory> = {}): ConfigInventory {
  return { nowIso: ISO, runs: [], queued: [], recommendations: [], active: [], cooling: [], restart, ...extra };
}
/** What the pass row records for the restart rule. */
function passRow(inv: ConfigInventory): Record<string, unknown> {
  const spec = configGardenSpec({ repoRoot: REPO_ROOT, stateDir: REPO_ROOT } as unknown as GardenerDeps);
  return spec.scorecard(inv, { actions: [] } as never).restart_tune as Record<string, unknown>;
}
function root(t: FixtureScope, policy = policyText()): string {
  const dir = ownedFixtureDir(t, "restart-tune").dir;
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(dir, "plan", "policy.yaml"), policy);
  return dir;
}
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
function commit(dir: string, iso: string): void {
  const env = { ...GIT_ENV, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
  execFileSync("git", ["-C", dir, "add", "-A"], { env });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", `fixture ${iso}`], { env });
}

test("W1-T12232 criterion 1: the gardener reads the last 20 complete restart_cycle rows later than the last change of the two policy rows; with 19 it proposes nothing and its pass row says it has 19", () => {
  // 30 rows before the change would make a full sample; they are not counted, and neither is a row with no first verdict.
  const before = Array.from({ length: 30 }, (_, i) => cycle(i, 9 * HOUR, HOUR, NOT_STALE, CHANGED_MS - 40 * HOUR));
  const unfinished = { ...cycle(40, 9 * HOUR, HOUR), first_verdict_at: null };
  const nineteen = [...before, ...cycles(19, 9 * HOUR, HOUR), unfinished];
  const short = inventory(input(nineteen));
  assert.equal(restartTuneCandidate(short), undefined);
  assert.deepEqual(configCandidates(short, REPO_ROOT, rng).filter((a) => a.class === "retune-restart"), []);
  const row = passRow(short);
  assert.equal(row.rows, 19);
  assert.match(String(row.reason), /^19 complete restart cycle\(s\) since the policy rows last changed; 20 are needed$/);

  // The twentieth row is enough. Only the LAST 20 count: five older rows that would be balanced do not move the medians.
  const twenty = inventory(input([...cycles(5, HOUR, HOUR), ...cycles(20, 9 * HOUR, HOUR, NOT_STALE, 5)]));
  assert.equal(RESTART_TUNE_ROWS, 20);
  assert.equal(restartTuneEvidence(twenty).rows, 20);
  assert.equal(restartTuneCandidate(twenty)?.class, "retune-restart");
  assert.equal(passRow(twenty).rows, 20);
  // The last 20 balanced, after 5 that are not: nothing.
  assert.equal(restartTuneCandidate(inventory(input([...cycles(5, 9 * HOUR, HOUR), ...cycles(20, HOUR, HOUR, NOT_STALE, 5)]))), undefined);

  // Unknown last change: nothing, and the pass row says why.
  const unknown = inventory(input(cycles(20, 9 * HOUR, HOUR), policyText(), null));
  assert.equal(restartTuneCandidate(unknown), undefined);
  assert.match(String(passRow(unknown).reason), /^the last change of the policy rows is unknown: fixture$/);
});

test("W1-T12232 criterion 1: the last change of the two rows is the newest committer time git blame gives their lines, and a checkout git cannot blame gives a reason, not a time", (t) => {
  const dir = root(t);
  execFileSync("git", ["-C", dir, "init", "-q"], { env: GIT_ENV });
  commit(dir, "2026-11-01T00:00:00Z");
  writeFileSync(join(dir, "plan", "policy.yaml"), policyText().replace("other: 1", "other: 2"));
  commit(dir, "2026-11-03T00:00:00Z");
  const lines = restartPolicyRows(readFileSync(join(dir, "plan", "policy.yaml"), "utf8")).map((r) => r.lineNumber);
  assert.deepEqual(lines, [3, 4]);
  assert.deepEqual(restartPolicyChangedAt(dir, lines), { ms: Date.parse("2026-11-01T00:00:00Z") }, "a change of another line is not a change of the rows");
  writeFileSync(join(dir, "plan", "policy.yaml"), policyText(SCORE_LINE.replace("value: 18", "value: 14")).replace("other: 1", "other: 2"));
  commit(dir, "2026-11-05T00:00:00Z");
  assert.deepEqual(restartPolicyChangedAt(dir, lines), { ms: Date.parse("2026-11-05T00:00:00Z") });

  // The measurement worker's own ledger read takes the restart_cycle rows, beside the priced steps, and the inventory
  // carries them with the last change.
  const stateDir = join(dir, "state");
  writeLedger([{ step: "run.start", run_id: "r" }, ...cycles(2, HOUR, HOUR, NOT_STALE, Date.parse("2026-11-05T00:00:00Z") - CHANGED_MS)], { dir: stateDir });
  assert.ok(CONFIG_GARDEN_READ_STEPS.includes(RESTART_CYCLE_STEP));
  let reply: unknown;
  return serveConfigMeasurement({ kind: "inventory", stateDir, repoRoot: dir, nowMs: Date.parse(ISO), weights: {}, recommendations: [] },
    { postMessage: (r) => { reply = r; } }).then(() => {
    assert.equal((reply as { ok: boolean }).ok, true, JSON.stringify(reply));
    const inv = (reply as { ok: true; value: ConfigInventory }).value;
    assert.equal(inv.restart?.changedAtMs, Date.parse("2026-11-05T00:00:00Z"));
    assert.equal(inv.restart?.cycles.length, 2);
    assert.equal(restartTuneEvidence(inv).rows, 2);

    const bare = root(t);
    const failed = restartPolicyChangedAt(bare, [3]);
    assert.ok("error" in failed && /^git blame of plan\/policy\.yaml failed: /.test(failed.error), JSON.stringify(failed));
    assert.deepEqual(restartPolicyChangedAt(bare, [], () => { throw new Error("never run"); }), { error: "plan/policy.yaml holds no one-line freshnessRestart row" });
    assert.deepEqual(restartPolicyChangedAt(bare, [3], () => "abc\n"), { error: "git blame of plan/policy.yaml named no committer time" });
  });
});

test("W1-T12232 criterion 2: median waiting at 1.5 times median restart or more proposes 25% lower, median restart at 1.5 times waiting or more proposes 25% higher, and between the two nothing", () => {
  assert.deepEqual([RESTART_TUNE_FACTOR, RESTART_TUNE_STEP], [1.5, 0.25]);
  // Median, not mean: one row waits 0, so the mean waiting is 28.5 (under 1.5 x 20), the median 30 (exactly 1.5 x 20).
  const lowerRows = [cycle(0, 0, 20), ...Array.from({ length: 19 }, (_, i) => cycle(i + 1, 30, 20))];
  const lower = restartTuneCandidate(inventory(input(lowerRows)));
  assert.equal(lower?.target, "freshnessRestart.scoreLimit");
  assert.equal(lower?.edits[0]!.to, SCORE_LINE.replace("value: 18", "value: 14"), "18 x 0.75 = 13.5, a whole 14");

  const higherRows = [cycle(0, 20, 0), ...Array.from({ length: 19 }, (_, i) => cycle(i + 1, 20, 30))];
  const higher = restartTuneCandidate(inventory(input(higherRows)));
  assert.equal(higher?.edits[0]!.to, SCORE_LINE.replace("value: 18", "value: 23"), "18 x 1.25 = 22.5, a whole 23");

  // Inside the band, either side, and the equal case where both are 0.
  for (const [w, r] of [[29, 20], [20, 29], [20, 20], [0, 0]] as const) {
    const inv = inventory(input(cycles(20, w, r)));
    assert.equal(restartTuneCandidate(inv), undefined, `${w}/${r}`);
    assert.match(String(passRow(inv).reason), /neither is 1\.5 times the other$/);
  }
});

test("W1-T12232 criterion 3: staleness releasing more than half the 20 restarts changes stalenessHorizonMs, otherwise scoreLimit", () => {
  const rows = (stale: number) => [...cycles(stale, 9 * HOUR, HOUR, stale % 2 ? "upper_age" : STALE), ...cycles(20 - stale, 9 * HOUR, HOUR, NOT_STALE, stale)];
  const eleven = restartTuneCandidate(inventory(input(rows(11))));
  assert.equal(eleven?.target, "freshnessRestart.stalenessHorizonMs");
  // 3000000 ms is 50 minutes; 25% lower is 37.5 minutes, kept in whole minutes: 38.
  assert.equal(eleven?.edits[0]!.to, HORIZON_LINE.replace("value: 3000000", "value: 2280000"));
  assert.equal(restartTuneEvidence(inventory(input(rows(11)))).stalenessReleased, 11);
  const ten = restartTuneCandidate(inventory(input(rows(10))));
  assert.equal(ten?.target, "freshnessRestart.scoreLimit");
  // Neither a withheld review, a change over the limit, nor an unreadable trigger is a staleness release.
  const others = ["window_quiet", "withheld_reviews", NOT_STALE, "busy, but 1 review(s) withheld for stale reviewer code: pressure 36 (change 4 + staleness 14 + withheld 18) >= 18: drain and restart", null, 7];
  const mixed = [...cycles(10, 9 * HOUR, HOUR, "upper_age"), ...others.flatMap((trigger, i) => [cycle(10 + i, 9 * HOUR, HOUR, trigger)]), ...cycles(4, 9 * HOUR, HOUR, NOT_STALE, 16)];
  assert.equal(restartTuneEvidence(inventory(input(mixed))).stalenessReleased, 10);
  assert.equal(restartTuneCandidate(inventory(input(mixed)))?.target, "freshnessRestart.scoreLimit");
});

test("W1-T12232 criterion 4: the proposed value stays inside its row's min and max, and a row at its bound gets no proposal and the pass row says so", () => {
  const lowerScore = (line: string) => restartTuneEvidence(inventory(input(cycles(20, 9 * HOUR, HOUR), policyText(line))));
  // 7 x 0.75 = 5.25 rounds to 5, under min 6: the proposal is 6.
  const near = lowerScore(SCORE_LINE.replace("value: 18", "value: 7"));
  assert.equal(near.to, 6);
  const atMin = lowerScore(SCORE_LINE.replace("value: 18", "value: 6"));
  assert.equal(atMin.to, undefined);
  assert.match(atMin.reason, /scoreLimit would move lower, but it is at its min 6$/);
  const raise = (line: string) => inventory(input(cycles(20, HOUR, 9 * HOUR), policyText(line)));
  assert.equal(restartTuneEvidence(raise(SCORE_LINE.replace("value: 18", "value: 50"))).to, 54, "50 x 1.25 = 62.5 is over max 54");
  const atMax = raise(SCORE_LINE.replace("value: 18", "value: 54"));
  assert.equal(restartTuneCandidate(atMax), undefined);
  assert.match(String(passRow(atMax).reason), /scoreLimit would move higher, but it is at its max 54$/);
  // The live horizon sits at its max of 4 hours: staleness-released cycles that would raise it get nothing.
  const horizonAtMax = inventory(input(cycles(20, HOUR, 9 * HOUR, "upper_age"), policyText(SCORE_LINE, HORIZON_LINE.replace("value: 3000000", "value: 14400000"))));
  assert.equal(restartTuneCandidate(horizonAtMax), undefined);
  assert.match(restartTuneEvidence(horizonAtMax).reason, /stalenessHorizonMs would move higher, but it is at its max 14400000$/);
  for (const e of [near, restartTuneEvidence(raise(SCORE_LINE.replace("value: 18", "value: 50")))]) {
    assert.ok(e.to! >= e.row!.min && e.to! <= e.row!.max, JSON.stringify(e));
  }
});

test("W1-T12232 criterion 5: a row with a null cost part is not counted, the pass row gives the count of such rows, and a null is never read as 0", () => {
  // 20 complete balanced rows, then 11 later rows whose restart cost is null (or absent). Read as 0, the last 20 would
  // have a median restart cost of 0 against a waiting cost of 1 hour, and the row would be lowered.
  const nulls = Array.from({ length: 11 }, (_, i) => cycle(20 + i, HOUR, i % 2 ? null : undefined));
  const inv = inventory(input([...cycles(20, HOUR, HOUR), ...nulls]));
  assert.equal(restartTuneCandidate(inv), undefined);
  const row = passRow(inv);
  assert.deepEqual([row.rows, row.null_part_rows], [20, 11]);
  assert.match(String(row.reason), /neither is 1\.5 times the other$/);
  // A null waiting part is not counted either: 19 complete rows and one null are short of 20.
  const short = inventory(input([...cycles(19, 9 * HOUR, HOUR), cycle(19, null, HOUR)]));
  assert.equal(restartTuneCandidate(short), undefined);
  assert.deepEqual([passRow(short).rows, passRow(short).null_part_rows], [19, 1]);
});

test("W1-T12232 criterion 6: configCandidates returns the proposal as one edit of one line of plan/policy.yaml, it passes the config gardener's canary, and a cooling or held scope is not proposed again", (t) => {
  const realText = readFileSync(policyPath(REPO_ROOT), "utf8");
  const real = restartPolicyRows(realText).find((r) => r.name === "scoreLimit")!;
  assert.ok(real && real.value > real.min, "the real scoreLimit row can be lowered");
  const inv = inventory(input(cycles(20, 9 * HOUR, HOUR), realText));
  const actions = configCandidates(inv, REPO_ROOT, rng);
  assert.equal(actions.length, 1);
  const action = actions[0]!;
  assert.deepEqual([action.class, action.scope, action.cohort], ["retune-restart", "policy:freshnessRestart.scoreLimit", { kind: "all" }]);
  assert.equal(action.edits.length, 1);
  assert.equal(action.edits[0]!.path, "plan/policy.yaml");
  assert.equal(action.edits[0]!.from, real.line);
  assert.deepEqual(action.shadowObservations.map((o) => [o.metricName, o.value, o.denominator]),
    [["restart_cycles", 20, 20], ["median_waiting_cost_ms", 9 * HOUR, 20], ["median_restart_cost_ms", HOUR, 20]]);

  // Applied through the spec, it changes one line, and the policy still loads with the new value.
  const dir = root(t, realText);
  const spec = configGardenSpec({ repoRoot: dir, stateDir: dir } as unknown as GardenerDeps);
  const landed = spec.apply({ root: dir } as never, { actions: [action] } as never, {});
  assert.deepEqual(landed?.paths, ["plan/policy.yaml"]);
  assert.match(String(landed?.title), /^chore\(policy\): /);
  const after = readFileSync(join(dir, "plan", "policy.yaml"), "utf8").split("\n");
  const changed = realText.split("\n").filter((line, i) => line !== after[i]);
  assert.deepEqual(changed, [real.line]);
  const expected = Math.max(real.min, Math.round(real.value * (1 - RESTART_TUNE_STEP)));
  assert.equal(loadPolicy(policyPath(dir)).values.freshnessRestart.scoreLimit, expected);
  assert.deepEqual(applyConfigEdits(dir, action.edits), [], "the edit applies once: its line is gone");

  // Cooling: a rolled-back scope is not proposed again. Held: an active canary on the scope blocks it.
  assert.deepEqual(configCandidates({ ...inv, cooling: [action.scope] }, REPO_ROOT, rng), []);
  const held = { promotion: { promotionId: "config-held", scope: { repo: "remudero", policyScope: action.scope }, state: "canary" } } as unknown as ConfigCanary;
  assert.deepEqual(configCandidates({ ...inv, active: [held] }, REPO_ROOT, rng), []);
  assert.equal(configCandidates({ ...inv, cooling: ["policy:freshnessRestart.stalenessHorizonMs"] }, REPO_ROOT, rng).length, 1, "another scope's cooling does not block it");
});
