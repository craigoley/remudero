/**
 * W1-T13326 — THE MERGE-TIME RATCHET JUDGE COUNTS OFF THE DAEMON LOOP.
 *
 * The judge counted on the daemon loop: 174 stalls and 1,797 s of loop lag in six hours on 2026-11-17, most of it
 * the affected-reach graph. Each test drives the production reader, readMergedRatchetsAsync, over a real clone with
 * a `gh` shim for the pull read, and compares it with judgeMergedRatchets called in place on the same inputs.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { readMergedRatchetsAsync } from "#src/lib/arm-auto-merge.js";
import { systemClock } from "#src/lib/clock.js";
import type { loadConfig } from "#src/lib/config.js";
import { runStepsSync } from "#src/lib/git-push.js";
import {
  COUNTED_RATCHET_GATES,
  judgeMergedRatchets,
  ratchetVerdictHolds,
  readMergedRatchetInputsSteps,
  type MergedRatchetJudgement,
} from "#src/lib/merged-ratchet-verdict.js";
import { judgeMergedRatchetsInWorker } from "#src/lib/merged-ratchet-worker.js";
import { planSafetyGitSync } from "#src/lib/plan-pr-merge-safety.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { runArmedRatchetRejudge, type OpenPrView } from "#test/helpers/sweep-test.js";

type Files = Record<string, string>;

const OWNER = "o";
const REPO = "r";
const PR = 2;
const NO_BASE_PR = 9;
const url = (n: number) => `https://github.com/${OWNER}/${REPO}/pull/${n}`;
const REACH = "scripts/affected-reach-baseline.json";
const CLOCK = "scripts/clock-signature-baseline.json";
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
/** One import line, built from its specifier so this file carries no specifier of its own. */
const use = (spec: string) => `import ${JSON.stringify(spec)};\n`;
const RUN_TASK = ["src", "run-task"].join("/");
const usesRunTask = use(`../${RUN_TASK}.js`);
const reachBaseline = json({ importerCount: 2, largestScc: 999, medianReachPercent: 100, importers: [], resolution: "package-imports" });
/** A small code tree the reach census can measure. */
const TREE: Files = { [REACH]: reachBaseline, [`${RUN_TASK}.ts`]: "export const r = 1;\n", "src/a.ts": "export const a = 1;\n", "test/old.test.ts": usesRunTask };
const stamp = "Date.now();\n";

// The pull read answers from this shim: the production reader's own `gh` transport runs against it.
const gh = ghShim([{ when: `pulls/${NO_BASE_PR}`, stdout: "{}" }, { when: "pulls/", stdout: JSON.stringify({ base: { ref: "main" } }) }]);
process.env.PATH = `${gh.dir}:${process.env.PATH}`;

function commitFiles(repo: GitRepo, files: Files, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "--allow-empty", "-m", message);
  return repo.git("rev-parse", "HEAD");
}

/** Main at `start`, PR A and PR B (#2) cut from it, A merged first, and a managed clone under a config root. */
function world(start: Files, a: Files, b: Files) {
  const origin = gitRepo({ kind: "judge-off-loop" });
  const m0 = commitFiles(origin, start, "m0");
  origin.git("checkout", "-q", "-b", "a", m0);
  commitFiles(origin, a, "a");
  origin.git("checkout", "-q", "-b", "b", m0);
  const headSha = commitFiles(origin, b, "b");
  origin.git("checkout", "-q", "main");
  origin.git("merge", "-q", "--no-ff", "-m", "merge a", "a");
  const mainSha = origin.git("rev-parse", "HEAD");
  origin.git("update-ref", `refs/pull/${PR}/head`, headSha);
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "judge-off-loop-clone" });
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-off-loop-root-`));
  mkdirSync(join(root, "repos"));
  symlinkSync(clone.dir, join(root, "repos", REPO));
  const config = (() => ({ root })) as unknown as typeof loadConfig;
  /** The judgement made in place, on this thread, over the same clone through the same read. */
  const direct = (prNumber = PR, pull: unknown = { base: { ref: "main" } }): MergedRatchetJudgement =>
    judgeMergedRatchets(runStepsSync(readMergedRatchetInputsSteps({ owner: OWNER, repo: REPO, prNumber }, () => pull, planSafetyGitSync(clone.dir))));
  return { config, direct, mainSha, headSha, cleanup: () => { rmSync(root, { recursive: true, force: true }); origin.cleanup(); clone.cleanup(); } };
}

const cleanWorld = () => world(TREE, { "src/b.ts": "export const b = 1;\n" }, { "test/a.test.ts": use("../src/a.js"), "src/dir.ts": "export const d = 1;\n" });
/** A and B each add a run-task importer: three on the merged tree, over a ceiling of two. */
const crossingWorld = () => world(TREE, { "test/a.test.ts": usesRunTask }, { "test/b.test.ts": usesRunTask });
/** A adds a clock call inside main's row of 3; B, on the old base, lowers the row to its own count of 1. */
const staleWorld = () => world(
  { ...TREE, [CLOCK]: json({ "src/c.ts": { dateNow: 3, legacy: 0, newDate: 0 } }), "src/c.ts": `${stamp}export const c = 1;\n` },
  { "src/c.ts": `${stamp}export const c = 1;\n${stamp}` },
  { [CLOCK]: json({ "src/c.ts": { dateNow: 1, legacy: 0, newDate: 0 } }) },
);
/** B lands a budget baseline that does not parse: that gate's counter throws. */
const unreadGateWorld = () => world(TREE, { "src/b.ts": "export const b = 1;\n" }, { "CLAUDE.md": "rules\n", "scripts/claude-md-budget-baseline.json": "{not json" });
/** Several hundred modules in one import chain, and a merge that adds a suite: the landing changes the graph. */
function largeWorld() {
  const modules = 400;
  const tree: Files = { ...TREE };
  for (let i = 0; i < modules; i++) tree[`src/m${i}.ts`] = `${i + 1 < modules ? use(`./m${i + 1}.js`) : ""}export const v${i} = ${i};\n`;
  for (let i = 0; i < 40; i++) tree[`test/t${i}.test.ts`] = use(`../src/m${i * 10}.js`);
  return world(tree, { "src/extra.ts": "export const e = 1;\n" }, { "test/new.test.ts": use("../src/m0.js") });
}

/** The production reader's judgement without its elapsed time, which no two runs share. */
async function produced(fx: ReturnType<typeof world>, prNumber = PR, worker?: Parameters<typeof readMergedRatchetsAsync>[2]): Promise<MergedRatchetJudgement> {
  const { elapsedMs, ...judgement } = await readMergedRatchetsAsync(url(prNumber), fx.config, worker);
  if (prNumber === PR) assert.equal(typeof elapsedMs, "number");
  return judgement;
}

test("W1-T13326 criterion 1: the reader's verdict, rows, counted gates and reason are the direct judgement's", { timeout: 240_000 }, async () => {
  const cases: Array<[string, () => ReturnType<typeof world>, MergedRatchetJudgement["verdict"]]> =
    [["a clean merge", cleanWorld, "clean"], ["an affected-reach crossing", crossingWorld, "crossing"], ["a stale lowering", staleWorld, "stale-lowering"],
      ["a gate whose counter throws", unreadGateWorld, "unread"]];
  for (const [label, build, verdict] of cases) {
    const fx = build();
    try {
      const direct = fx.direct();
      assert.equal(direct.verdict, verdict, `${label}: ${direct.reason ?? JSON.stringify(direct.rows)}`);
      assert.deepEqual(await produced(fx), direct, label);
      if (verdict === "clean") assert.deepEqual(direct.counted, [...COUNTED_RATCHET_GATES]);
      if (verdict === "crossing") assert.deepEqual(direct.rows.map((r) => [r.gate, r.field, r.merged, r.prCeiling]), [["affected-reach", "importerCount", 3, 2]]);
      if (verdict === "stale-lowering") assert.deepEqual(direct.rows.map((r) => [r.gate, r.path, r.merged, r.prCeiling, r.mainCeiling]), [["clock-signature", "src/c.ts", 2, 1, 3]]);
      if (verdict === "unread") assert.match(direct.reason ?? "", /claude-md-budget: a ratchet counter threw/);
    } finally {
      fx.cleanup();
    }
  }
  // An unread input counts nothing: the pull read that names no base ref.
  const fx = cleanWorld();
  try {
    const direct = fx.direct(NO_BASE_PR, {});
    assert.equal(direct.verdict, "unread");
    assert.match(direct.reason ?? "", /no base ref/);
    assert.deepEqual(await produced(fx, NO_BASE_PR), direct);
  } finally {
    fx.cleanup();
  }
});

test("W1-T13326 criterion 2: the calling thread's setImmediate turns keep advancing while a large graph is counted", { timeout: 240_000 }, async () => {
  const fx = largeWorld();
  let turns = 0;
  let spinning = true;
  const spin = (): void => { turns += 1; if (spinning) setImmediate(spin); };
  let atCountStart: number | undefined;
  // Node publishes each new thread inside its constructor: the count starts there.
  const onThread = (): void => { atCountStart ??= turns; };
  subscribe("worker_threads", onThread);
  try {
    setImmediate(spin);
    const judgement = await produced(fx);
    const atVerdict = turns;
    assert.equal(judgement.verdict, "clean", judgement.reason);
    assert.ok(judgement.counted.includes("affected-reach"), "the reach graph was counted");
    assert.ok(atCountStart !== undefined, "the count ran in a worker thread");
    assert.ok(atVerdict - atCountStart > 0, `the loop turned ${atVerdict - atCountStart} times during the count`);
  } finally {
    spinning = false;
    unsubscribe("worker_threads", onThread);
    fx.cleanup();
  }
});

test("W1-T13326 criterion 3: a worker that throws, exits or passes its bound is unread with its cause, and a counted hold is returned unchanged", { timeout: 240_000 }, async () => {
  const fx = crossingWorld();
  try {
    const failures: Array<[URL, number | undefined, RegExp]> = [
      [new URL('data:text/javascript,throw new Error("forced ratchet worker crash")'), undefined, /^the ratchet worker exited with code 1 before it answered: forced ratchet worker crash$/],
      [new URL("data:text/javascript,process.exit(3)"), undefined, /^the ratchet worker exited with code 3 before it answered$/],
      [new URL("data:text/javascript,setInterval(() => {}, 1000)"), 50, /^the ratchet worker passed its 50 ms bound$/],
      [new URL("nope:not-a-worker"), undefined, /^the ratchet worker could not start: /],
    ];
    for (const [workerUrl, boundMs, cause] of failures) {
      const judgement = await produced(fx, PR, { workerUrl, boundMs });
      assert.equal(judgement.verdict, "unread", `${workerUrl.href} is never clean`);
      assert.match(judgement.reason ?? "", cause);
      assert.deepEqual([judgement.mainSha, judgement.headSha, judgement.rows, judgement.counted], [fx.mainSha, fx.headSha, [], []]);
      assert.equal(ratchetVerdictHolds(judgement), false);
    }
    // The crossing the worker counted still holds the arm.
    const crossing = await produced(fx);
    assert.deepEqual(crossing, fx.direct());
    assert.equal(crossing.verdict, "crossing");
    assert.equal(ratchetVerdictHolds(crossing), true);
  } finally {
    fx.cleanup();
  }
  const stale = staleWorld();
  try {
    const lowering = await produced(stale);
    assert.equal(lowering.verdict, "stale-lowering");
    assert.equal(ratchetVerdictHolds(lowering), true);
  } finally {
    stale.cleanup();
  }
  // Inputs that carry readers but no plain data cannot be sent: unread, never counted in place.
  const noData = await judgeMergedRatchetsInWorker({ mainSha: "m", headSha: "h", changed: [], measuredFiles: [], readMerged: () => null, readMain: () => null });
  assert.equal(noData.verdict, "unread");
  assert.match(noData.reason ?? "", /carry no plain data/);
});

const SYNC_PRIMITIVES = ["execFileSync", "spawnSync", "execSync"] as const;
const CENSUS_ASSERTION = "the census needs source modules and suites";

test("W1-T13326 criterion 4: the production reader runs no gate counter and no synchronous spawn on the calling thread", { timeout: 240_000 }, async (t) => {
  const fx = largeWorld();
  // measureReach asserts its tree once per call, through the assert object this thread shares with it.
  const ok = t.mock.method(assert, "ok");
  const reachCounts = (): number => ok.mock.calls.filter((call) => call.arguments[1] === CENSUS_ASSERTION).length;
  try {
    const direct = fx.direct();
    assert.equal(reachCounts(), 1, "the spy sees a count made in place");
    const cp = childProcess as unknown as Record<string, unknown>;
    const originals = SYNC_PRIMITIVES.map((name) => [name, cp[name]] as const);
    const spawned: string[] = [];
    for (const name of SYNC_PRIMITIVES) cp[name] = () => { spawned.push(name); throw new Error(`synchronous ${name} on the calling thread`); };
    syncBuiltinESMExports();
    let judgement: MergedRatchetJudgement;
    try {
      judgement = await produced(fx);
    } finally {
      for (const [name, original] of originals) cp[name] = original;
      syncBuiltinESMExports();
    }
    assert.deepEqual(spawned, [], "the git and gh reads stay on the async transport");
    assert.equal(reachCounts(), 1, "measureReach was not called on the calling thread");
    // Every gate was counted all the same, so each counter ran in the worker.
    assert.deepEqual(judgement, direct);
    assert.deepEqual(judgement.counted, [...COUNTED_RATCHET_GATES]);
  } finally {
    fx.cleanup();
  }
});

test("W1-T13326 criterion 5: the sweep.ratchet_judge.decided row carries the direct judgement's values and the whole elapsed time", { timeout: 240_000 }, async (t) => {
  const fx = crossingWorld();
  // One tick per pull read: a judgement timed around the read and the count spans exactly one.
  let directReads = 0;
  t.mock.method(systemClock, "now", () => (gh.calls().length + directReads) * 1000);
  const pr: OpenPrView = {
    prNumber: PR, prUrl: url(PR), taskId: "unfiled", headSha: fx.headSha, lastActivityAt: "2026-11-17T04:00:00.000Z",
    reviewState: "success", checksState: "pending", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: true, mergeState: "behind", changedFiles: [],
  };
  const decided = async (readMergedRatchets: (pr: OpenPrView) => Promise<MergedRatchetJudgement>): Promise<Record<string, unknown>> => {
    const ledger: Array<Record<string, unknown>> = [];
    await runArmedRatchetRejudge([pr], {
      ledgerPath: "/dev/null/ledger.ndjson", runId: "run-test", readLedger: () => ledger,
      appendLine: (_path: string, row: Record<string, unknown>) => { ledger.push(row); },
      readMainTip: () => fx.mainSha, readMergedRatchets, now: () => Date.parse("2026-11-17T04:00:00.000Z"),
    });
    const rows = ledger.filter((row) => row.step === "sweep.ratchet_judge.decided");
    assert.equal(rows.length, 1);
    return rows[0]!;
  };
  try {
    // As the sweep wires it: sweepDeps' readMergedRatchets.
    const row = await decided((view) => readMergedRatchetsAsync(view.prUrl, fx.config));
    const direct = await decided(async () => {
      const started = systemClock.now();
      directReads += 1;
      return { ...fx.direct(), elapsedMs: systemClock.now() - started };
    });
    assert.deepEqual(row, direct);
    assert.equal(row.elapsed_ms, 1000);
    assert.deepEqual([row.verdict, row.main_sha, row.head_sha, row.rows_count], ["crossing", fx.mainSha, fx.headSha, 1]);
    assert.deepEqual(row.counted_gates, [...COUNTED_RATCHET_GATES]);
    assert.ok((row.uncounted_gates as string[]).includes("coverage:run-derived"));
    assert.equal((row.rows as Array<{ gate: string }>)[0]!.gate, "affected-reach");
  } finally {
    fx.cleanup();
  }
});
