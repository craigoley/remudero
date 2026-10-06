// W1-T5925: the selector shadow re-read only its last SELECTOR_SHADOW_RUN_LIMIT = 60 runs, so the
// verdict that gates RMD_AFFECTED_SUITE_LIVE needed a ~50% failure rate and zero incomplete runs to
// ever read `ready`. Each complete observation is now appended once to the ledger and the report
// folds the whole store; a bounded, resumable replay adds historical failures as `source: replay`.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Namespace imports: the store and the replay are new, so this suite still loads (and fails) at the base sha.
import * as gardener from "../src/lib/selector-shadow-gardener.js";
import * as registry from "../src/lib/garden-registry.js";
import { appendLedger, DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { clockFromMillisFn, fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const STEP = "selector-shadow.observation";
const NOW = Date.parse("2026-10-06T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms: number) => clockFromMillisFn(() => ms).iso();

type Verdict = "selected" | "missed";
type Failure = { file: string; floor: Verdict; narrow?: Verdict };

/** A complete eight-shard live run whose shard 1 carries `failures` and concluded failure when any. */
function liveRun(id: number, failures: Failure[] = []): gardener.SelectorShadowRun {
  const log = Array.from({ length: 8 }, (_, shard) => [
    `coverage-shard (${shard + 1}/8)\tAFFECTED-SUITES-SHADOW: ${JSON.stringify({ fullRun: false, floorSize: 2000, narrowSize: 1000, failures: shard === 0 ? failures : [] })}`,
    `coverage-shard (${shard + 1}/8)\tSELECTOR-SHADOW-JOB: conclusion=${shard === 0 && failures.length > 0 ? "failure" : "success"}`,
  ].join("\n")).join("\n");
  return { id, headSha: `head-${id}`, prNumber: id, log };
}

const hit = (file: string): Failure => ({ file, floor: "selected", narrow: "selected" });

function harness(nowMs = NOW) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shadow-accumulates-`));
  const stateDir = join(root, "state");
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(stateDir);
  const path = join(stateDir, "ledger.ndjson");
  const log = (step: string, extra: Record<string, unknown> = {}) => appendLedger(path, { run_id: "GARDEN-test", task_id: "DAEMON", step, ...extra });
  const deps = {
    stateDir,
    repoRoot: root,
    clock: fixedClock(nowMs),
    openWorkspace: (): never => { throw new Error("no pass here opens a filing workspace"); },
    log,
  };
  const rows = (step: string): Array<Record<string, unknown>> => existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.step === step)
    : [];
  const pass = (runs: gardener.SelectorShadowRun[], options?: Parameters<typeof gardener.runSelectorShadowGardener>[7]) =>
    gardener.runSelectorShadowGardener(deps, () => runs, () => [], () => { throw new Error("nothing here files a task"); }, () => [], undefined, undefined, options);
  return { root, stateDir, deps, log, rows, pass };
}

/** One historical PR run as GitHub answers it: its listing row, its eight coverage jobs and their logs. */
interface PastRun {
  id: number;
  createdMs: number;
  conclusion?: string;
  /** Files failing in shard 1; its HISTORICAL narrow verdict is `missed`, so a replay must recompute. */
  failures?: string[];
  shard1?: "failure" | "success";
  shadow?: boolean;
  unreadable?: boolean;
  /** Returned even when older than nothing: a listing that ignored its own created filter. */
  leak?: boolean;
}

function pastReads(runs: PastRun[]) {
  const listings: string[] = [];
  const byId = new Map(runs.map((r) => [r.id, r]));
  const readJson = async (args: string[]): Promise<unknown> => {
    const url = args[1]!;
    if (url.includes("/actions/workflows/ci.yml/runs?")) {
      listings.push(url);
      const before = Date.parse(decodeURIComponent(/created=([^&]+)/.exec(url)![1]!).slice(1));
      return {
        workflow_runs: runs.filter((r) => r.leak === true || r.createdMs < before).sort((a, b) => b.createdMs - a.createdMs).map((r) => ({
          id: r.id, head_sha: `head-${r.id}`, status: "completed", conclusion: r.conclusion ?? "failure", created_at: iso(r.createdMs),
          pull_requests: [{ number: r.id, base: { sha: `base-${r.id}` } }],
        })),
      };
    }
    const jobs = /actions\/runs\/(\d+)\/jobs/.exec(url);
    if (jobs) {
      const r = byId.get(Number(jobs[1]))!;
      return {
        total_count: 8,
        jobs: Array.from({ length: 8 }, (_, i) => ({
          id: r.id * 10 + i + 1, name: `coverage-shard (${i + 1}/8)`, status: "completed",
          conclusion: i === 0 ? (r.shard1 ?? "failure") : "success",
        })),
      };
    }
    throw new Error(`unexpected read ${url}`);
  };
  const readText = async (args: string[]): Promise<string> => {
    const job = Number(/actions\/jobs\/(\d+)\/logs/.exec(args[1]!)![1]);
    const r = byId.get(Math.floor(job / 10))!;
    if (r.unreadable) throw new Error(`log ${job} is gone`);
    if (r.shadow === false) return "2026-10-01T00:00:00.0000000Z ok 1 - nothing recorded";
    const failures = job % 10 === 1 ? (r.failures ?? []).map((file) => ({ file, floor: "selected", narrow: "missed" })) : [];
    return `2026-10-01T00:00:00.0000000Z AFFECTED-SUITES-SHADOW: ${JSON.stringify({ fullRun: false, floorSize: 2000, narrowSize: 1500, failures })}`;
  };
  return { readJson, readText, listings };
}

/** The recomputed selection a fake `select` returns: narrow selects every failed file but `missed`. */
function selecting(missed: readonly string[] = []) {
  const asked: Array<[number, readonly string[]]> = [];
  const select = async (run: { id: number }, failed: readonly string[]) => {
    asked.push([run.id, failed]);
    return {
      record: { fullRun: false, floorSize: 900, narrowSize: 400, failures: failed.map((file) => ({ file, floor: "selected" as const, narrow: missed.includes(file) ? "missed" as const : "selected" as const })) },
      reasons: [],
    };
  };
  return { select, asked };
}

test("shadow observations accumulate across reports beyond the 60-run window, and the verdict folds all of them", async () => {
  const h = harness();
  const windowOf = (pass: number) => Array.from({ length: gardener.SELECTOR_SHADOW_RUN_LIMIT }, (_, i) => {
    const id = pass * 1000 + i + 1;
    return liveRun(id, i < 10 ? [hit(`test/f-${id}.test.ts`)] : []);
  });
  const seen: Array<[number, number, string, string]> = [];
  for (const pass of [1, 2, 3]) {
    const runs = windowOf(pass);
    assert.equal(gardener.selectorShadowReport(runs, 0).narrow.failures, 10, "one window alone holds ten failures");
    const report = await h.pass(runs);
    seen.push([report.runsComplete, report.narrow.failures, report.verdict, report.window.verdict]);
  }
  assert.deepEqual(seen, [
    [60, 10, "insufficient", "insufficient"],
    [120, 20, "insufficient", "insufficient"],
    [180, 30, "ready", "insufficient"],
  ], "the store reaches 30 failures across 180 complete runs, which no 60-run window can");
  assert.equal(h.rows(STEP).length, 180, "each complete run is appended once");
  const last = h.rows("selector-shadow.report").at(-1)!;
  assert.equal(last.verdict, "ready");
  assert.deepEqual(last.live, { runs: 180, floor: last.floor, narrow: last.narrow });
  assert.equal((last.observations as { live: number }).live, 180);
  assert.deepEqual(h.rows(STEP)[0], {
    ...h.rows(STEP)[0], ci_run_id: 1001, head_sha: "head-1001", pr: 1001, source: "live", full_run: false,
    floor_size: 2000, narrow_size: 1000, failures: [hit("test/f-1001.test.ts")], recovered: 0,
  });
  assert.equal(gardener.SELECTOR_SHADOW_MIN_FAILURES, 30, "the thresholds are unchanged");
  assert.equal(gardener.SELECTOR_SHADOW_MIN_RUNS, 40);
});

test("a re-seen run is never appended twice", async () => {
  const h = harness();
  const runs = [liveRun(1, [hit("test/a.test.ts")]), liveRun(2)];
  const first = await h.pass(runs);
  const again = await h.pass(runs);
  assert.deepEqual([first.observations.appended, again.observations.appended], [2, 0]);
  assert.equal(h.rows(STEP).length, 2);
  assert.deepEqual([again.runsComplete, again.narrow.failures], [2, 1]);
});

test("an incomplete run is excluded and counted without resetting the verdict, then observed once complete", async () => {
  const h = harness();
  const complete = Array.from({ length: 40 }, (_, i) => liveRun(i + 1, i < 30 ? [hit(`test/f-${i}.test.ts`)] : []));
  const first = await h.pass([...complete, { id: 99, headSha: "head-99", log: "" }]);
  assert.equal(first.verdict, "ready", first.reason);
  assert.deepEqual([first.runsComplete, first.runsIncomplete], [40, 1]);
  assert.equal(first.window.verdict, "insufficient", "the window alone still refuses an incomplete run");
  assert.ok(!h.rows(STEP).some((r) => r.ci_run_id === 99), "an incomplete run is never stored");
  const second = await h.pass([...complete, liveRun(99, [hit("test/late.test.ts")])]);
  assert.deepEqual([second.runsComplete, second.runsIncomplete, second.narrow.failures, second.observations.appended], [41, 0, 31, 1]);
});

test("a skipped run and a retry-recovered failure are counted the way the window counts them", async () => {
  const h = harness();
  const skipped = { id: 5, headSha: "head-5", log: Array.from({ length: 8 }, (_, s) => `coverage-shard (${s + 1}/8)\tW1-T2428 fast-lane: class=TEST_ONLY — skipping Test with coverage`).join("\n") };
  const recovered = liveRun(6, [hit("test/flaky.test.ts")]);
  recovered.log = recovered.log.replace("conclusion=failure", "conclusion=success");
  const fullRun = { id: 7, headSha: "head-7", log: Array.from({ length: 8 }, (_, s) => `coverage-shard (${s + 1}/8)\tAFFECTED-SUITES-SHADOW: ${JSON.stringify({ fullRun: true, floorSize: 0, failures: [] })}`).join("\n") };
  const report = await h.pass([skipped, recovered, fullRun]);
  assert.deepEqual([report.runsSkipped, report.runsComplete, report.recovered, report.narrow.failures], [1, 2, 1, 0]);
  const stored = h.rows(STEP);
  assert.deepEqual(stored.map((r) => [r.ci_run_id, r.recovered, r.failures, r.full_run, r.narrow_size]), [[6, 1, [], false, 1000], [7, 0, [], true, undefined]]);
  assert.equal(report.floor.medianSize, 1000, "a full run is the whole suite (0 files here) beside the 2000-file floor");
});

test("replayed historical failures are recorded with source replay, recomputed, and reported separately from live ones", async () => {
  const h = harness();
  const past = pastReads([
    { id: 7001, createdMs: NOW - 4 * DAY, failures: ["test/r1.test.ts"] },
    { id: 7002, createdMs: NOW - 4 * DAY - HOUR, failures: ["test/r2.test.ts"] },
  ]);
  const { select, asked } = selecting(["test/r2.test.ts"]);
  const report = await h.pass([liveRun(1, [hit("test/live.test.ts")])], { replay: { owner: "o", repo: "r", readJson: past.readJson, readText: past.readText, select } });
  assert.deepEqual(asked, [[7001, ["test/r1.test.ts"]], [7002, ["test/r2.test.ts"]]], "the replay recomputes each failing run's selection");
  assert.deepEqual(h.rows(STEP).map((r) => [r.ci_run_id, r.source, r.base_sha ?? null]), [[1, "live", null], [7001, "replay", "base-7001"], [7002, "replay", "base-7002"]]);
  assert.deepEqual(h.rows(STEP)[1]!.failures, [hit("test/r1.test.ts")], "the recomputed verdict, not the historical `missed`");
  assert.deepEqual([report.live.runs, report.live.narrow.failures, report.live.narrow.missed], [1, 1, 0]);
  assert.deepEqual([report.replay.runs, report.replay.narrow.failures, report.replay.narrow.selected, report.replay.narrow.missed], [2, 2, 1, 1]);
  assert.equal(report.replay.narrow.medianSize, 400);
  assert.deepEqual([report.narrow.failures, report.verdict], [3, "misses"], "a replayed miss is still a miss");
  assert.deepEqual(report.misses.map((m) => [m.runId, m.selection, m.file]), [[7002, "narrow", "test/r2.test.ts"]]);
  assert.deepEqual(report.replayPass, { attempted: 2, observed: 2, skipped: 0, before: iso(NOW - 4 * DAY - HOUR), exhausted: true, capped: false });
});

test("the replay is bounded per pass and resumes from its saved cursor until history is exhausted", async () => {
  const h = harness();
  const failing = [1, 2, 3, 4, 5].map((n) => ({ id: 7100 + n, createdMs: NOW - 4 * DAY - n * HOUR, failures: [`test/p${n}.test.ts`] }));
  const green = [{ id: 7150, createdMs: NOW - 4 * DAY - 90 * 60 * 1000, conclusion: "success" }, { id: 7160, createdMs: NOW - 4 * DAY - 270 * 60 * 1000, conclusion: "success" }];
  const past = pastReads([...failing, ...green]);
  const { select, asked } = selecting();
  const replay = { owner: "o", repo: "r", readJson: past.readJson, readText: past.readText, select };
  const perPass: number[] = [];
  for (let pass = 0; pass < 4; pass++) {
    const before = asked.length;
    const report = await h.pass([], { replay });
    perPass.push(asked.length - before);
    assert.ok(asked.length - before <= gardener.SELECTOR_SHADOW_REPLAY_RUNS_PER_PASS);
    if (pass === 3) assert.deepEqual(report.replayPass, { attempted: 0, observed: 0, skipped: 0, before: iso(NOW - 4 * DAY - 5 * HOUR), exhausted: true, capped: false });
  }
  assert.equal(gardener.SELECTOR_SHADOW_REPLAY_RUNS_PER_PASS, 2);
  assert.deepEqual(perPass, [2, 2, 1, 0]);
  assert.deepEqual(asked.map(([id]) => id), [7101, 7102, 7103, 7104, 7105], "each failing run replays once, newest first; green runs are passed over");
  assert.equal(past.listings.length, 3, "an exhausted history is never listed again");
  assert.match(past.listings[0]!, new RegExp(`created=${encodeURIComponent(`<${iso(NOW - gardener.SELECTOR_SHADOW_RECENT_WINDOW_MS)}`)}`));
  assert.match(past.listings[1]!, new RegExp(`created=${encodeURIComponent(`<${iso(NOW - 4 * DAY - 2 * HOUR)}`)}`), "the next pass resumes after the last replayed run");
  const state = JSON.parse(readFileSync(join(h.stateDir, gardener.SELECTOR_SHADOW_REPLAY_STATE_FILE), "utf8"));
  assert.deepEqual(state, { before: iso(NOW - 4 * DAY - 5 * HOUR), horizon: iso(NOW - gardener.SELECTOR_SHADOW_REPLAY_HORIZON_MS), exhausted: true });
  assert.equal(h.rows(STEP).filter((r) => r.source === "replay").length, 5);
});

test("the replay stops at its horizon and at its observation cap", async () => {
  const h = harness();
  const past = pastReads([{ id: 7201, createdMs: NOW - gardener.SELECTOR_SHADOW_REPLAY_HORIZON_MS - HOUR, failures: ["test/old.test.ts"] }]);
  const { select, asked } = selecting();
  const first = await h.pass([], { replay: { owner: "o", repo: "r", ...past, select } });
  assert.deepEqual([asked.length, first.replayPass?.exhausted], [0, true], "a run older than the horizon is never replayed");

  const capped = harness();
  for (let i = 0; i < gardener.SELECTOR_SHADOW_REPLAY_MAX_OBSERVATIONS; i++) {
    capped.log(STEP, { ci_run_id: 9000 + i, head_sha: `h${i}`, source: "replay", full_run: false, floor_size: 1, narrow_size: 1, failures: [hit("test/c.test.ts")], recovered: 0 });
  }
  const again = pastReads([{ id: 7202, createdMs: NOW - 4 * DAY, failures: ["test/c2.test.ts"] }]);
  const report = await capped.pass([], { replay: { owner: "o", repo: "r", ...again, select } });
  assert.equal(gardener.SELECTOR_SHADOW_REPLAY_MAX_OBSERVATIONS, 100);
  assert.deepEqual([again.listings.length, report.replayPass?.capped, report.replay.runs], [0, true, 100], "a full backfill lists nothing more");
});

test("every replay skip is named with its reason and the run is passed over once", async () => {
  const h = harness();
  h.log(STEP, { ci_run_id: 7307, head_sha: "head-7307", source: "live", full_run: false, floor_size: 1, narrow_size: 1, failures: [], recovered: 0 });
  const runs: PastRun[] = [
    { id: 7399, createdMs: NOW - HOUR, failures: ["test/new.test.ts"], leak: true },
    { id: 7301, createdMs: NOW - 4 * DAY - 1 * HOUR, unreadable: true },
    { id: 7302, createdMs: NOW - 4 * DAY - 2 * HOUR, shadow: false },
    { id: 7303, createdMs: NOW - 4 * DAY - 3 * HOUR, failures: ["test/flaky.test.ts"], shard1: "success" },
    { id: 7304, createdMs: NOW - 4 * DAY - 4 * HOUR, failures: [1, 2, 3, 4, 5, 6].map((n) => `test/m${n}.test.ts`) },
    { id: 7305, createdMs: NOW - 4 * DAY - 5 * HOUR, failures: ["test/boom.test.ts"] },
    { id: 7306, createdMs: NOW - 4 * DAY - 6 * HOUR, failures: ["test/full.test.ts"] },
    { id: 7307, createdMs: NOW - 4 * DAY - 7 * HOUR, failures: ["test/known.test.ts"] },
    { id: 7308, createdMs: NOW - 4 * DAY - 8 * HOUR, conclusion: "success" },
  ];
  const past = pastReads(runs);
  const select = async (run: { id: number }) => {
    if (run.id === 7305) throw new Error("checkout refused");
    return { record: { fullRun: true, floorSize: 0, failures: [] }, reasons: ["full run: the selector could not read its input — tsx missing"] };
  };
  for (let pass = 0; pass < 4; pass++) await h.pass([], { replay: { owner: "o", repo: "r", ...past, select } });
  const skips = h.rows("selector-shadow.replay_skipped").map((r) => [r.ci_run_id, r.reason, r.detail]);
  assert.deepEqual(skips.map(([id, reason]) => [id, reason]), [
    [7301, "unreadable"], [7302, "no_shadow_record"], [7303, "recovered"], [7304, "mass"], [7305, "unselectable"], [7306, "full_run"],
  ]);
  assert.match(String(skips[0]![2]), /log 73011 is gone/);
  assert.match(String(skips[3]![2]), /6 failing files/);
  assert.match(String(skips[4]![2]), /checkout refused/);
  assert.match(String(skips[5]![2]), /could not read its input — tsx missing/);
  assert.deepEqual(h.rows(STEP).map((r) => r.ci_run_id), [7307], "no skipped, known, green or too-new run is stored");
  const state = JSON.parse(readFileSync(join(h.stateDir, gardener.SELECTOR_SHADOW_REPLAY_STATE_FILE), "utf8"));
  assert.equal(state.exhausted, true);
});

test("a failed replay is ledgered with its error and the report is still written", async () => {
  const h = harness();
  const report = await h.pass([liveRun(1)], { replay: { owner: "o", repo: "r", readJson: async () => { throw new Error("listing down"); }, readText: async () => "" } });
  assert.deepEqual(h.rows("selector-shadow.replay_failed").map((r) => r.error), ["listing down"]);
  assert.deepEqual(report.replayPass, { error: "listing down" });
  assert.equal(h.rows("selector-shadow.report").length, 1);
  assert.equal(report.runsComplete, 1);
});

test("an unreadable replay state is ledgered and the replay starts again from the live window's edge", async () => {
  const h = harness();
  await writeFile(join(h.stateDir, gardener.SELECTOR_SHADOW_REPLAY_STATE_FILE), "{not json");
  const past = pastReads([{ id: 7401, createdMs: NOW - 4 * DAY, failures: ["test/s.test.ts"] }]);
  const report = await h.pass([], { replay: { owner: "o", repo: "r", ...past, ...selecting() } });
  assert.equal(h.rows("selector-shadow.replay_state_unreadable").length, 1);
  assert.match(String(h.rows("selector-shadow.replay_state_unreadable")[0]!.error), /JSON/);
  assert.equal(report.replay.runs, 1);
  await writeFile(join(h.stateDir, gardener.SELECTOR_SHADOW_REPLAY_STATE_FILE), JSON.stringify({ before: 5 }));
  await h.pass([], { replay: { owner: "o", repo: "r", ...past, ...selecting() } });
  assert.match(String(h.rows("selector-shadow.replay_state_unreadable")[1]!.error), /invalid replay state/);
});

test("a malformed stored observation is counted as unreadable, never folded", async () => {
  const h = harness();
  h.log(STEP, { ci_run_id: 1, head_sha: "h", source: "live", full_run: false, floor_size: 1, failures: [{ file: "test/a.test.ts", floor: "maybe" }], recovered: 0 });
  h.log(STEP, { ci_run_id: 2, head_sha: "h", source: "elsewhere", full_run: false, floor_size: 1, failures: [], recovered: 0 });
  h.log(STEP, { ci_run_id: 3, head_sha: "h", source: "live", full_run: false, floor_size: 1, narrow_size: -1, failures: [], recovered: 0 });
  h.log(STEP, { ci_run_id: 4, head_sha: "h", source: "live", full_run: false, floor_size: 1, failures: "none", recovered: 0 });
  h.log(STEP, { ci_run_id: 5, head_sha: "h", source: "live", full_run: false, floor_size: 1, failures: [null], recovered: 0 });
  const report = await h.pass([]);
  assert.deepEqual([report.observations.unreadable, report.runsComplete], [5, 0]);
});

test("an unreadable observation store fails the pass rather than folding an empty one", async () => {
  const h = harness();
  mkdirSync(join(h.stateDir, "ledger.ndjson"));
  await assert.rejects(h.pass([liveRun(1)]), /observation store is unreadable: .*ledger\.ndjson/);
});

test("the observation step survives ledger rotation", () => {
  assert.equal(gardener.SELECTOR_SHADOW_OBSERVATION_STEP, STEP);
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(STEP));
});

test("the production garden pass runs the replay through its own GitHub reads", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shadow-replay-wired-`));
  for (const dir of ["test", "state"]) mkdirSync(join(root, dir));
  const listings: string[] = [];
  const events: string[] = [];
  const readJson = async (args: string[]) => {
    listings.push(args[1]!);
    return { workflow_runs: [] };
  };
  const pass = registry.selectorShadowGardenPass(
    { stateDir: join(root, "state"), repoRoot: root, openWorkspace: (): never => { throw new Error("no workspace"); }, log: (step) => { events.push(step); } },
    "acme", "remudero", () => "W1-T9001", { readJson, readText: async () => "" },
  );
  await pass();
  assert.deepEqual(events.filter((e) => e.endsWith("failed")), []);
  assert.ok(listings.some((url) => url.includes("created=%3C")), "the replay listed history older than the live window");
  assert.equal(JSON.parse(readFileSync(join(root, "state", gardener.SELECTOR_SHADOW_REPLAY_STATE_FILE), "utf8")).exhausted, true);
});

test("the default replay reads GitHub through gh and recomputes the narrow selection in a real checkout of the run", async () => {
  const origin = gitRepo({ kind: "shadow-replay-origin" });
  await mkdir(join(origin.dir, "src"));
  await mkdir(join(origin.dir, "test"));
  await mkdir(join(origin.dir, "scripts"));
  await writeFile(join(origin.dir, "src", "a.ts"), "export function alpha(): number {\n  return 1;\n}\n");
  await writeFile(join(origin.dir, "test", "a.test.ts"), "import { alpha } from \"../src/a.js\";\nalpha();\n");
  await writeFile(join(origin.dir, "scripts", "diff-class.mjs"), "process.exit(0);\n");
  origin.git("add", "-A");
  origin.git("commit", "-q", "-m", "base");
  const baseSha = origin.git("rev-parse", "HEAD");
  origin.git("checkout", "-q", "-b", "pr");
  await writeFile(join(origin.dir, "src", "a.ts"), "export function alpha(): number {\n  return 2;\n}\n");
  origin.git("commit", "-q", "-am", "head");
  const headSha = origin.git("rev-parse", "HEAD");
  origin.git("checkout", "-q", "main");
  const workspace = gitRepo({ cloneFrom: origin.dir, kind: "shadow-replay-ws" });

  const shadowLine = (failures: Failure[]) => `2026-10-01T00:00:00.0000000Z AFFECTED-SUITES-SHADOW: ${JSON.stringify({ fullRun: false, floorSize: 3, narrowSize: 2, failures })}`;
  const shim = ghShim([
    { when: "actions/workflows/ci.yml/runs", stdout: JSON.stringify({ workflow_runs: [{ id: 7501, head_sha: headSha, status: "completed", conclusion: "failure", created_at: iso(NOW - 4 * DAY), pull_requests: [{ number: 75, base: { sha: baseSha } }] }] }) },
    { when: "actions/runs/7501/jobs", stdout: JSON.stringify({ total_count: 8, jobs: Array.from({ length: 8 }, (_, i) => ({ id: 75010 + i + 1, name: `coverage-shard (${i + 1}/8)`, status: "completed", conclusion: i === 0 ? "failure" : "success" })) }) },
    { when: "actions/jobs/75011/logs", stdout: shadowLine([{ file: "test/a.test.ts", floor: "selected", narrow: "missed" }]) },
    { when: "/logs", stdout: shadowLine([]) },
  ], { kind: "shadow-replay-gh" });
  const h = harness();
  let disposed = 0;
  const deps = { ...h.deps, repoRoot: process.cwd(), openWorkspace: () => ({ root: workspace.dir, branch: "selector-shadow-garden-test", land: () => undefined, dispose: () => { disposed++; } }) };
  const previous = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previous}`;
  try {
    const report = await gardener.runSelectorShadowGardener(deps, () => [], () => [], () => "W1-T1", () => [], undefined, undefined, { replay: { owner: "o", repo: "r" } });
    assert.deepEqual(h.rows("selector-shadow.replay_skipped"), []);
    assert.deepEqual(h.rows(STEP).map((r) => [r.ci_run_id, r.source, r.head_sha, r.base_sha, r.pr, r.full_run, r.floor_size, r.narrow_size, r.failures]), [
      [7501, "replay", headSha, baseSha, 75, false, 1, 1, [{ file: "test/a.test.ts", floor: "selected", narrow: "selected" }]],
    ], "the head's changed symbol reaches its suite, which the recomputed narrow selection runs");
    assert.deepEqual([report.replay.narrow.failures, report.replay.narrow.selected], [1, 1]);
    assert.equal(disposed, 1, "the replay checkout is disposed after its pass");
    assert.ok(shim.calls().some((c) => c.includes("actions/jobs/75011/logs")), "the job logs were read through gh");
    assert.equal(workspace.git("rev-parse", "HEAD"), headSha, "the checkout was moved to the run's head");
  } finally {
    process.env.PATH = previous;
  }
});

test("the default replay selection names a checkout it cannot fetch", async () => {
  const workspace = gitRepo({ kind: "shadow-replay-nofetch" });
  await assert.rejects(gardener.selectorShadowReplaySelection(workspace.dir, { id: 1, headSha: "0".repeat(40) }, ["test/a.test.ts"]), /git fetch .* exited/);
});
