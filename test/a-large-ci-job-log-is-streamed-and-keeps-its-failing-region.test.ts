/**
 * W1-T5836 — A LARGE CI JOB LOG IS STREAMED AND KEEPS ITS FAILING REGION.
 *
 * MEASURED 2026-10-04..05: 199 `sweep.disposed` rows read "log NOT read ... FAILED (ENOBUFS:
 * spawnSync gh ENOBUFS)" — a coverage shard's Actions job log outgrew the 4 MiB buffer the fix
 * lane's one `gh api .../actions/jobs/<id>/logs` call held it in, so the fix rung got no failing
 * test and the PR stranded red (#9267).
 *
 * Every read here goes through a PATH-shimmed `gh` (test/helpers/gh-shim.ts), never live GitHub.
 * The shim serves a file through `echo "$(cat ...)"`, so the fixtures carry no backslash (a dash
 * `echo` would expand one) and gain exactly one trailing newline.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { ghLinesAsync } from "../src/lib/github-transport.js";
import type { Plan } from "../src/lib/plan.js";
import { DEFAULT_SWEEP_POLICY, proofDiscriminationEvidenceFromCheckLog, type CiFailure } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  buildSweepEffects,
  ciFailureRegionReducer,
  defaultCiJobLogRegionAsync,
  extractCiFailureRegion,
  fetchCiFailures,
  fetchCiFailuresAsync,
  fixRungCiFailures,
  gateVerdictRetention,
  RETAINED_REMEDY_HEADER,
} from "../src/run-task.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";

const JOB = "7001";
const ROLLUP = [{ name: "coverage-shard (8/8)", conclusion: "FAILURE", detailsUrl: `https://github.com/o/r/actions/runs/1/job/${JOB}` }];
const NEEDLE = [
  "2026-10-05T08:16:53.0000000Z not ok 17 - a large ci job log keeps the needle",
  "2026-10-05T08:16:53.0000000Z   ---",
  "2026-10-05T08:16:53.0000000Z   error: 'expected 3, got 4'",
  "2026-10-05T08:16:53.0000000Z   ...",
];
const TAIL = "2026-10-05T08:20:00.0000000Z ##[error]Process completed with exit code 1.";

/** A `gh` on PATH for the duration of `body`, answering `routes`; the job log is served from `logFile`. */
async function withGh<T>(kind: string, routes: GhShimRoute[], body: (shim: ReturnType<typeof ghShim>) => Promise<T>): Promise<T> {
  const shim = ghShim(routes, { kind: `t5836-${kind}-gh` });
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  try {
    return await body(shim);
  } finally {
    process.env.PATH = savedPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

function scratch(kind: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5836-${kind}-`));
}

/** Routes that serve `logFile` as job `JOB`'s log and an empty annotation list, so the log is read. */
function logRoutes(logFile: string): GhShimRoute[] {
  return [
    { when: `check-runs/${JOB}/annotations`, stdout: "[]" },
    { when: `actions/jobs/${JOB}/logs`, stdout: readFileSync(logFile, "utf8").replace(/\n+$/, "") },
  ];
}

/** What the route serves for a file: its text, trailing newlines folded to exactly one (the route
 *  strips them, and the shim adds the single newline `echo` always printed). */
function served(text: string): string {
  return `${text.replace(/\n+$/, "")}\n`;
}

/** The whole-text cut the fix lane made before streaming: extractCiFailureRegion plus the retained remedies. */
async function wholeTextCut(log: string, tailLines: number): Promise<string> {
  const [failure] = await fetchCiFailuresAsync("o", "r", ROLLUP, tailLines, {
    fetchAnnotations: () => [],
    fetchJobLog: () => log,
  });
  return failure!.logTail;
}

function streamedCut(log: string, tailLines: number): string {
  const reducer = ciFailureRegionReducer(tailLines);
  for (const line of log.split("\n")) reducer.push(line);
  return reducer.finish();
}

function bigLog(): string {
  const filler: string[] = [];
  let bytes = 0;
  for (let n = 1; bytes < 6 * 1024 * 1024; n += 1) {
    const line = `2026-10-05T08:17:00.0000000Z ok ${n} - coverage shard filler test ${n} passes`;
    filler.push(line);
    bytes += line.length + 1;
  }
  return [...NEEDLE, ...filler, TAIL].join("\n");
}

test("W1-T5836: a 6 MiB job log through a real gh shim keeps its not ok block and its tail line", async () => {
  const dir = scratch("big");
  const logFile = join(dir, "job.log");
  const log = bigLog();
  writeFileSync(logFile, log);
  assert.ok(Buffer.byteLength(log) > 6 * 1024 * 1024, "the fixture is past the 4 MiB buffer the defect held it in");
  const sha = "c".repeat(40);
  const prUrl = "https://github.com/o/r/pull/9267";
  const checkRun = { id: Number(JOB), name: ROLLUP[0]!.name, status: "completed", conclusion: "failure", details_url: ROLLUP[0]!.detailsUrl };
  try {
    await withGh("big", [
      ...logRoutes(logFile),
      { when: `commits/${sha}/check-runs`, stdout: JSON.stringify({ total_count: 1, check_runs: [checkRun] }) },
      { when: `commits/${sha}/status`, stdout: JSON.stringify({ state: "failure", statuses: [] }) },
      { when: `pr view ${prUrl} --json statusCheckRollup`, stdout: JSON.stringify({ statusCheckRollup: ROLLUP }) },
    ], async (shim) => {
      // runFixRung's wired producer, on both of its arms: the gate's sha, and the `pr view` fallback.
      const read = fixRungCiFailures("o", "r");
      for (const failures of [await read(prUrl, sha), await read(prUrl)]) {
        const [failure] = failures;
        assert.equal(failures.length, 1);
        assert.equal(failure?.logUnavailable, undefined, `the log was read: ${JSON.stringify(failure?.logUnavailable)}`);
        assert.equal(failure?.tailSource, "log");
        for (const line of NEEDLE) assert.ok(failure!.logTail.includes(line.slice(29)), `kept: ${line.slice(29)}`);
        assert.ok(failure!.logTail.endsWith("##[error]Process completed with exit code 1."), "the stream reached the log's last line");
        assert.ok(failure!.logTail.split("\n").length <= 60, "the region is held to tailLines");
      }
      // The sweep's wired producer reads the same way.
      assert.deepEqual(await fetchCiFailuresAsync("o", "r", ROLLUP), await read(prUrl));
      assert.ok(shim.calls().includes(`api repos/o/r/actions/jobs/${JOB}/logs`));

      // POSITIVE CONTROL: the buffered sync read of the SAME shimmed log is the defect, ENOBUFS.
      const [buffered] = fetchCiFailures("o", "r", ROLLUP);
      assert.equal(buffered?.logUnavailable?.kind, "fetch-failed");
      assert.match(String((buffered?.logUnavailable as { detail?: string } | undefined)?.detail), /ENOBUFS/);
      assert.equal(buffered?.logTail, "");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T5836: the sweep's wired fix-lane producer reads a 6 MiB job log through the stream", async () => {
  const root = scratch("sweep");
  const logFile = join(root, "job.log");
  writeFileSync(logFile, bigLog());
  const prUrl = "https://github.com/craigoley/remudero/pull/9267";
  for (const dir of [join(root, "state", "inflight"), join(root, "repos", "remudero-fixture"), join(root, "tmp")]) mkdirSync(dir, { recursive: true });
  const task = { id: "W1-T5836", title: "stream the job log", risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" };
  let read: CiFailure[] | undefined;
  const steps: string[] = [];
  try {
    await withGh("sweep", [
      ...logRoutes(logFile),
      { when: `pr view ${prUrl} --json headRefName,headRefOid,body`, stdout: JSON.stringify({ headRefName: "run-W1-T5836-1791196437555", headRefOid: "head5836", body: "" }) },
      { when: `pr view ${prUrl} --json statusCheckRollup`, stdout: JSON.stringify({ statusCheckRollup: ROLLUP }) },
    ], async () => {
      // The ENTRYPOINT builder, with every seam but `fetchCiFailuresImpl` faked: that one is the
      // production default this test is about, reached the way dispatchFix's fix rung reaches it.
      const effects = buildSweepEffects({
        owner: "craigoley",
        repo: "remudero-fixture",
        repoRoot: process.cwd(),
        localRepoName: "remudero",
        config: { root, claudeBin: "/bin/true" } as Config,
        ledgerPath: join(root, "state", "ledger.ndjson"),
        runId: "SWEEP-W1-T5836",
        plan: { tasks: [task], byId: new Map([[task.id, task]]) } as unknown as Plan,
        log: (step: string, extra?: Record<string, unknown>) => void steps.push(`${step} ${JSON.stringify(extra ?? {})}`),
        policy: DEFAULT_SWEEP_POLICY,
        reviewRunner: async () => 0,
        issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/5836" },
        stallNotice: () => {},
        armImpl: () => "armed",
        armSessionPrsOverride: false,
        updateBranchImpl: async () => "updated",
        captureRepairFeedbackImpl: () => {},
        ghRunImpl: () => {},
        spawnWallClockBoundMsOverride: 1,
        reclaimWorkerImpl: () => {},
        disarmImpl: () => undefined,
        readJsonImpl: async () => ({}),
        updatePrBodyImpl: async () => {},
        registeredWorktreeOwnerImpl: () => undefined,
        registeredOwnerRecovery: { capture: () => undefined, remove: () => undefined },
        dispatchFixPreflightStandDownImpl: async () => undefined,
        // The round's contract stays the boot plan's task: no head checkout exists to resolve it from.
        resolveTaskContractAtHeadImpl: undefined,
        fixBranchClaimKeyImpl: () => "claim-key",
        createFixRungWorktreeImpl: () => undefined,
        captureWorktreeSnapshotImpl: () => ({ headSha: "birth5836" }),
        buildFixRungDispatchArgsImpl: () => ({}),
        openTaskIdsFromPlanImpl: () => new Set(["W1-T5836"]),
        waitForCiGreenImpl: async () => false,
        restRollupForImpl: async () => [],
        runReviewImpl: async () => ({ verdict: "PASS" }),
        fetchPrBodyImpl: async () => "body",
        readHeadShaImpl: async () => "head5836",
        ghLiveStateImpl: async () => ({ state: "OPEN" }),
        ghLiveHeadImpl: async () => ({ headRefName: "run-W1-T5836-1791196437555" }),
        fetchPrDiffFilesImpl: async () => ["src/run-task.ts"],
        fixRebaseMergeFactsImpl: async () => ({ merged: false }),
        redBaseRefreshFactsImpl: async () => ({ state: "red" }),
        readFixRoundCommitsImpl: () => [],
        readPackageScriptsImpl: () => ({ test: "node --test" }),
        pushFixRoundImpl: () => {},
        runFixRungImpl: async (args: { deps: { fetchCiFailures: (url: string) => Promise<CiFailure[]> } }) => {
          read = await args.deps.fetchCiFailures(prUrl);
        },
        spawnImpl: async () => ({ sessionId: "s5836" }) as never,
      } as never);
      await effects.dispatchFix!(
        { prNumber: 9267, prUrl, headSha: "head5836", taskId: "W1-T5836", priorStrikes: 0, mergeState: "clean", checksState: "failure" } as never,
        { unmetCriteria: [], ciFailures: [{ name: ROLLUP[0]!.name, logTail: "" }] } as never,
      );
    });
    assert.ok(read, `dispatchFix reached the fix rung's ci-failure refresh: ${steps.join("\n")}`);
    const [failure] = read;
    assert.equal(failure?.logUnavailable, undefined, `the log was read: ${JSON.stringify(failure?.logUnavailable)}`);
    for (const line of NEEDLE) assert.ok(failure!.logTail.includes(line.slice(29)), `kept: ${line.slice(29)}`);
    assert.ok(failure!.logTail.endsWith("##[error]Process completed with exit code 1."), "the stream reached the log's last line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A deterministic PRNG, so a failing fixture is the same fixture on every run. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const VOCABULARY = [
  "ok 3 - passes",
  "not ok 4 - fails here",
  "not ok 5 - fails again",
  "  ---",
  "  error: boom",
  "  ...",
  "FLAKE-RETRY: test/x.test.ts failed once, retrying",
  "FLAKE-RETRY-RECOVERED: test/x.test.ts",
  "FLAKE-RETRY: test/y.test.ts failed once, retrying",
  "##[group]Run npm test",
  "##[endgroup]",
  "##[error]Process completed with exit code 1.",
  "✖ failing tests:",
  "x failing tests:",
  "ℹ tests 12",
  "# fail 1",
  "test/a.test.ts",
  "Run 'npm run agents-md' and commit the result.",
  "  Run 'npm run gen:routes' and commit the result.",
  "Run 'npm run a1' and commit the result.",
  "Run 'npm run a2' and commit the result.",
  "Run 'npm run a3' and commit the result.",
  "Run 'npm run a4' and commit the result.",
  "Run 'npm run a5' and commit the result.",
  "Run 'npm run a6' and commit the result.",
  "plain output line",
  "",
];

function randomLog(rand: () => number, kinds: readonly string[]): string {
  const length = Math.floor(rand() * 220);
  const lines: string[] = [];
  for (let i = 0; i < length; i += 1) {
    const line = kinds[Math.floor(rand() * kinds.length)]!;
    lines.push(rand() < 0.5 ? `2026-10-05T08:16:${String(i % 60).padStart(2, "0")}.1234567Z ${line}` : line);
  }
  return lines.join("\n");
}

test("W1-T5836: on logs under 4 MiB the streamed region equals extractCiFailureRegion plus the retained remedies", async () => {
  const fixtures: string[] = [
    "",
    "one line",
    [...NEEDLE, "ok 2 - fine", TAIL].join("\n"),
    ["##[group]Run a", "a1", "a2", "##[endgroup]", "##[group]Run b", ...Array.from({ length: 12 }, (_, i) => `b${i}`), "##[error]b failed"].join("\n"),
    ["noise", "✖ failing tests:", "test/a.test.ts", "test/b.test.ts", "ℹ tests 9", "after"].join("\n"),
    ["Run 'npm run agents-md' and commit the result.", ...Array.from({ length: 80 }, (_, i) => `line ${i}`)].join("\n"),
    Array.from({ length: 40 }, () => "FLAKE-RETRY: test/x.test.ts failed once, retrying").join("\n"),
  ];
  // Each draw from a narrowed vocabulary steers the cut toward one of its four precedence arms.
  const arms = [VOCABULARY, VOCABULARY.filter((l) => !/not ok|FLAKE/.test(l)), VOCABULARY.filter((l) => !/not ok|FLAKE|failing/.test(l)), VOCABULARY.filter((l) => !/not ok|FLAKE|failing|error/.test(l))];
  const rand = prng(5836);
  for (let i = 0; i < 400; i += 1) fixtures.push(randomLog(rand, arms[i % arms.length]!));
  let compared = 0;
  for (const log of fixtures) {
    for (const tailLines of [1, 3, 8, 9, 60]) {
      assert.equal(streamedCut(log, tailLines), await wholeTextCut(log, tailLines), `tailLines=${tailLines}\n${log}`);
      compared += 1;
    }
  }
  assert.equal(compared, fixtures.length * 5);
  assert.ok(fixtures.some((log) => streamedCut(log, 60).startsWith(RETAINED_REMEDY_HEADER)), "some fixture retains a remedy");

  // The same equality end to end: the default streamed read of a shimmed log against the whole-text cut of what it served.
  const dir = scratch("equal");
  const logFile = join(dir, "job.log");
  const log = fixtures[3]!;
  writeFileSync(logFile, log);
  try {
    await withGh("equal", logRoutes(logFile), async () => {
      const [failure] = await fetchCiFailuresAsync("o", "r", ROLLUP, 9);
      assert.equal(failure?.logTail, await wholeTextCut(served(log), 9));
      assert.equal(await defaultCiJobLogRegionAsync("o", "r", JOB, 60), await wholeTextCut(served(log), 60));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T5836: a failed streamed read names its cause, and each transport failure rejects", async () => {
  await withGh("fail", [
    { when: `check-runs/${JOB}/annotations`, stdout: "[]" },
    { when: `actions/jobs/${JOB}/logs`, stderr: "HTTP 404: Not Found", exit: 1 },
    { when: "actions/jobs/slow/logs", stdout: "late", delaySeconds: 1 },
  ], async () => {
    // A non-zero exit reaches ciFailuresSteps' catch arm as a named fetch failure.
    const [failure] = await fetchCiFailuresAsync("o", "r", ROLLUP);
    assert.equal(failure?.logUnavailable?.kind, "fetch-failed");
    assert.match(String((failure?.logUnavailable as { detail?: string } | undefined)?.detail), /exit code 1[\s\S]*HTTP 404/);
    assert.equal(failure?.logTail, "");

    // A line callback that throws stops the read and rejects with that error.
    await assert.rejects(ghLinesAsync(["api", "repos/o/r/actions/jobs/9/logs"], () => {
      throw new Error("reducer refused");
    }), /reducer refused/);

    // A read past its timeout is killed and rejects naming the signal.
    await assert.rejects(ghLinesAsync(["api", "repos/o/r/actions/jobs/slow/logs"], () => {}, { timeout: 50 }), /SIGTERM/);

  });

  // A child that never starts: the shared shim with its interpreter line pointed at nothing. The
  // spawn reports ENOENT as an `error` event, and the read rejects rather than hanging on it. PATH
  // is the shim alone, so the exec search cannot fall through to the setup's refusing stub.
  await withGh("unrunnable", [], async (shim) => {
    writeFileSync(`${shim.dir}/gh`, "#!/rmd-no-such-interpreter\n");
    const prependedPath = process.env.PATH;
    process.env.PATH = shim.dir;
    try {
      await assert.rejects(ghLinesAsync(["api", "repos/o/r/actions/jobs/1/logs"], () => {}), /ENOENT/);
    } finally {
      process.env.PATH = prependedPath;
    }
  });
});

// LIVE 2026-10-09: #10234's proof-discrimination gate named one stale `unit test:` proof, then printed
// check-proof's ~19-line output before exiting 1. The region kept only the lines before `##[error]`, so
// neither the FAIL header nor the proof survived, W1-T5544's proof-repair route found no evidence, and the
// sweep escalated and parked the PR. The gate's verdict lines now ride along like generator remedies.
const STALE_PROOF = "unit test: test/an-unfiled-prs-review-contract-has-a-sweep-side-producer.test.ts";

function staleProofGateJobLog(): string[] {
  const stamp = "2026-10-09T08:57:00.0000000Z ";
  const output = Array.from({ length: 19 }, (_, i) => `    ok ${i + 1} - check-proof output line ${i + 1}`);
  return [
    "##[group]Run node --import tsx scripts/proof-discrimination-gate.mjs",
    "##[endgroup]",
    "proof-discrimination: FAIL — 1 proof(s) pass at both PR head and merge base (16651b3fc); they cannot establish this PR's work:",
    `  proof: ${STALE_PROOF}`,
    "  head hits: 22; base hits: 22",
    ...output,
    "Allowance for W1-T5714: 0 (scripts/proof-discrimination-baseline.json); this PR carries 1, 1 over.",
    "Remedy: replace each stale proof with one that names behavior this PR changes, then rerun this check.",
    "##[error]Process completed with exit code 1.",
  ].map((line) => stamp + line);
}

function staleProofEvidence(logTail: string) {
  return proofDiscriminationEvidenceFromCheckLog([{ name: "proof-discrimination", logTail }]);
}

test("the streamed log region keeps the stale proof the gate names", () => {
  const reducer = ciFailureRegionReducer(60);
  for (const line of staleProofGateJobLog()) reducer.push(line);
  assert.deepEqual(staleProofEvidence(reducer.finish())?.proofs.map((p) => p.proof), [STALE_PROOF]);
});

test("the whole-log region keeps the stale proof the gate names", () => {
  const log = staleProofGateJobLog().join("\n");
  const verdict = gateVerdictRetention();
  for (const line of log.split("\n")) verdict.push(line.replace(/^\S+Z /, ""));
  assert.deepEqual(staleProofEvidence(verdict.wrap(extractCiFailureRegion(log, 60)))?.proofs.map((p) => p.proof), [STALE_PROOF]);
});

test("a log with no proof-discrimination verdict is returned unchanged", () => {
  const reducer = ciFailureRegionReducer(60);
  const plain = ["##[group]Run npm test", "  proof: not a gate line", "##[error]Process completed with exit code 1."];
  for (const line of plain) reducer.push(line);
  assert.equal(reducer.finish().includes("retained from earlier"), false);
});
