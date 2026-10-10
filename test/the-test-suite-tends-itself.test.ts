/**
 * W1-T4112: the test suite tends itself. A test gardener (a gardener.ts spec) adopts a material
 * duration proposal, retiers a repeat flaker to the slow tier, and shrinks a stale one-way
 * baseline downward — every value read from scripts/test-tier-manifest.mjs's own functions or the
 * fleet's own ledger. All three are `review` classes: each is judged by whether its PR merges.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GARDEN_LEDGER_BUCKET_MS, gardenStatePath, readGardenState, runGarden, type GardenCheckout } from "../src/lib/gardener.js";
import { clockFromMillisFn, fixedClock } from "../src/lib/clock.js";
import {
  DURATION_ADOPTION_CADENCE_MS,
  DURATION_WINDOW_RUNS,
  RETIER_THRESHOLD,
  TEST_GARDEN_BODY_ROWS,
  TEST_GARDEN_CLASSES,
  TEST_GARDEN_PROOF_ROWS,
  loadTestManifestProbe,
  refreshTestManifestProposalAsync,
  startTestGarden,
  testGardenCheapFingerprint,
  testGardenInventory,
  testGardenSpec,
  testManifestProposalHistoryPath,
  testManifestProposalPath,
} from "../src/lib/test-gardener.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { daemonCommand } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
// scripts/ is outside tsconfig's include; load the real .mjs module through a URL, as the
// existing test-with-retry suites do, while keeping this test's seam explicitly typed.
const { appendFlakeLedger } = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "test-with-retry.mjs")).href)) as {
  appendFlakeLedger: (
    entries: Array<{ file: string; test: string }>,
    headline: string,
    options: { path: string; mkdir: () => void; append: () => void },
  ) => void;
};
const probesPromise = loadTestManifestProbe(REPO_ROOT);

/** A fixture repo carrying a small, real test/ directory (so `listTestFiles` finds it on disk)
 *  and a committed test-tier-manifest.json — one file unmeasured, matching the real manifest's
 *  own `0`-placeholder shape. */
function seededSuite(): string {
  const repo = gitRepo({ kind: "w1t4112" });
  const root = repo.dir;
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("test/a.test.ts", "export {};\n");
  put("test/b.test.ts", "export {};\n");
  put("test/c.test.ts", "export {};\n");
  put("test/d.test.ts", "export {};\n");
  put(
    "scripts/test-tier-manifest.json",
    JSON.stringify(
      { thresholdMs: 5000, files: { "test/a.test.ts": 100, "test/b.test.ts": 0, "test/c.test.ts": 50, "test/d.test.ts": 50 } },
      null,
      2,
    ) + "\n",
  );
  mkdirSync(join(root, "state"), { recursive: true });
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "seed");
  return root;
}

/** Two well-separated, already-MEASURED files on their own shards — no unmeasured placeholder to
 *  drag the median weighting around, so a small downward nudge to the lighter file is provably a
 *  sub-shard-boundary change: `proposalIsMaterial` sees no shard reassignment, and SHRINK-BASELINE
 *  (never materiality-gated) is the only class left with a row to claim. */
function seededMeasuredPair(): string {
  const repo = gitRepo({ kind: "w1t4112-pair" });
  const root = repo.dir;
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("test/a.test.ts", "export {};\n");
  put("test/b.test.ts", "export {};\n");
  put("scripts/test-tier-manifest.json", JSON.stringify({ thresholdMs: 5000, files: { "test/a.test.ts": 1000, "test/b.test.ts": 10 } }, null, 2) + "\n");
  mkdirSync(join(root, "state"), { recursive: true });
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "seed");
  return root;
}

function writeProposal(root: string, files: Record<string, number>, thresholdMs = 5000): void {
  writeFileSync(testManifestProposalPath(join(root, "state")), JSON.stringify({ thresholdMs, files }, null, 2) + "\n");
}

type Landed = { paths: string[]; title: string; body: string };
function checkout(root: string, landed: Landed[]): () => GardenCheckout {
  return () => ({ root, land: (opts) => (landed.push(opts), "https://github.com/acme/remudero/pull/99"), dispose: () => {} });
}
const deps = (root: string, landed: Landed[], prState?: () => "open" | "merged" | "closed") => ({
  stateDir: join(root, "state"),
  repoRoot: root,
  openWorkspace: checkout(root, landed),
  log: () => {},
  seed: 1,
  // The fixture's manifest was committed moments ago; a clock two cadence windows later lets a
  // duration adoption through the once-a-day hold.
  clock: fixedClock(Date.now() + 2 * DURATION_ADOPTION_CADENCE_MS),
  ...(prState ? { prState } : {}),
});
const off = (root: string, ...classes: string[]) => classes.forEach((c) => writeFileSync(join(root, "state", `TEST_OFF-${c}`), ""));

test("W1-T4112: a material duration proposal is adopted and judged by shard skew", async () => {
  const probe = await probesPromise;
  const root = seededSuite();
  // A first real measurement for "test/b.test.ts" (was the `0` placeholder) is material on its
  // own, regardless of shard movement — test-tier-manifest.mjs's own `proposalIsMaterial` rule.
  writeProposal(root, { "test/a.test.ts": 100, "test/b.test.ts": 6000, "test/c.test.ts": 50, "test/d.test.ts": 50 });
  off(root, "retier-flaker", "shrink-baseline");
  const landed: Landed[] = [];
  const pass = runGarden(testGardenSpec(deps(root, landed), probe), deps(root, landed));
  assert.deepEqual(pass.plan?.acting, ["adopt-durations"]);
  assert.deepEqual(pass.plan!.actions.map((a) => a.target), ["scripts/test-tier-manifest.json#test/b.test.ts"]);
  assert.equal(pass.plan!.actions[0]!.edit.to, 6000);
  // Judged by SHARD SKEW: the reason names the slowest-shard skew before and after adopting.
  assert.match(pass.plan!.actions[0]!.reason, /narrows the slowest shard's skew from \d+ms to \d+ms/);
  assert.equal(JSON.parse(readFileSync(join(root, "scripts/test-tier-manifest.json"), "utf8")).files["test/b.test.ts"], 6000);
  assert.equal(landed.length, 1);
  assert.match(
    landed[0]!.body,
    /^\*\*Judged by its outcome\.\*\* The test gardener's `adopt-durations` changes are judged by whether this PR merges: adopting a fresh measurement over the committed one is judged by shard skew/,
  );
  assert.match(landed[0]!.body, /proof: grep: "test\/b\.test\.ts": 6000 in scripts\/test-tier-manifest\.json/);
});

test("W1-T4112: a non-material proposal shrinks a stale row downward instead", async () => {
  const probe = await probesPromise;
  const root = seededMeasuredPair();
  // A settled downward move of the lighter, already well-separated file: every one of a full
  // window of runs measures it below its committed 10ms, with no shard reassignment, so
  // ADOPT-DURATIONS (materiality-gated) sees nothing and SHRINK-BASELINE claims the row instead.
  const b = [5, 5, 4, 6, 5, 5, 5].slice(0, DURATION_WINDOW_RUNS);
  writeFileSync(testManifestProposalHistoryPath(join(root, "state")), JSON.stringify({
    runs: b.map((ms, i) => ({ runId: i + 1, files: { "test/a.test.ts": 1000, "test/b.test.ts": ms } })),
    absent: [],
  }));
  off(root, "retier-flaker", "adopt-durations");
  const landed: Landed[] = [];
  const pass = runGarden(testGardenSpec(deps(root, landed), probe), deps(root, landed));
  assert.deepEqual(pass.plan?.acting, ["shrink-baseline"]);
  assert.deepEqual(pass.plan!.actions.map((a) => a.target), ["scripts/test-tier-manifest.json#test/b.test.ts"]);
  assert.equal(pass.plan!.actions[0]!.edit.to, 5);
  assert.match(pass.plan!.actions[0]!.reason, /Recorded 10ms; the median of 7 CI run\(s\) measured 5ms — shrinking the manifest's total baseline size from \d+ms/);
  assert.equal(JSON.parse(readFileSync(join(root, "scripts/test-tier-manifest.json"), "utf8")).files["test/b.test.ts"], 5);
});

test("W1-T4112: a repeat flaker is retiered to the slow tier, judged by retry count", async () => {
  const probe = await probesPromise;
  const root = seededSuite();
  off(root, "adopt-durations", "shrink-baseline");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const row = (test: string) => JSON.stringify({ ts: "2026-09-24T00:00:00.000Z", step: "test.flake_retry", file: "test/c.test.ts", test, headline: "first attempt failed" });
  writeFileSync(ledgerPath, [row("one"), row("two"), row("three")].join("\n") + "\n");
  const inv = testGardenInventory(root, join(root, "state"), probe);
  assert.deepEqual(inv.candidates.map((a) => a.target), ["scripts/test-tier-manifest.json#test/c.test.ts"]);
  assert.equal(inv.candidates[0]!.edit.to, 5000, "retiered to the manifest's own slow threshold");
  assert.match(inv.candidates[0]!.reason, /Retried 3 time\(s\) so far/);
  const landed: Landed[] = [];
  runGarden(testGardenSpec(deps(root, landed), probe), deps(root, landed));
  assert.equal(JSON.parse(readFileSync(join(root, "scripts/test-tier-manifest.json"), "utf8")).files["test/c.test.ts"], 5000);
});

test("W1-T4112: fewer than the retry threshold, or already slow, retiers nothing", async () => {
  const probe = await probesPromise;
  const root = seededSuite();
  const stateDir = join(root, "state");
  const row = (file: string, test: string) => JSON.stringify({ step: "test.flake_retry", file, test });
  // Below RETIER_THRESHOLD.
  writeFileSync(join(stateDir, "ledger.ndjson"), Array.from({ length: RETIER_THRESHOLD - 1 }, (_, i) => row("test/c.test.ts", `t${i}`)).join("\n") + "\n");
  assert.deepEqual(testGardenInventory(root, stateDir, probe).candidates, []);
  // At the threshold, but the file is already committed at/above the slow threshold.
  writeFileSync(
    join(root, "scripts/test-tier-manifest.json"),
    JSON.stringify({ thresholdMs: 5000, files: { "test/a.test.ts": 100, "test/b.test.ts": 0, "test/c.test.ts": 9000, "test/d.test.ts": 50 } }, null, 2) + "\n",
  );
  writeFileSync(join(stateDir, "ledger.ndjson"), Array.from({ length: RETIER_THRESHOLD + 2 }, (_, i) => row("test/c.test.ts", `t${i}`)).join("\n") + "\n");
  assert.deepEqual(testGardenInventory(root, stateDir, probe).candidates, []);
});

test("W1-T4112: every class is a person's judgement call", async () => {
  const probe = await probesPromise;
  const root = seededSuite();
  const spec = testGardenSpec(deps(root, []), probe);
  assert.deepEqual(Object.keys(spec.review ?? {}).sort(), [...TEST_GARDEN_CLASSES].sort());
});

test("W1-T4112: a flake is ledgered, not only printed", () => {
  const SCRIPT = join(REPO_ROOT, "scripts", "test-with-retry.mjs");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4112-flake-ledger-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  const marker = join(dir, "seen");
  const file = join(dir, "flaky.test.mjs");
  writeFileSync(
    file,
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { existsSync, writeFileSync } from "node:fs";',
      `test("ledgered flaky test", () => {`,
      `  if (!existsSync(${JSON.stringify(marker)})) {`,
      `    writeFileSync(${JSON.stringify(marker)}, "1");`,
      `    assert.fail("first pass");`,
      `  }`,
      `});`,
      "",
    ].join("\n"),
  );
  const result = spawnSync(process.execPath, [SCRIPT, process.execPath, "--test", "flaky.test.mjs"], {
    cwd: dir,
    encoding: "utf8",
    // NODE_TEST_CONTEXT (set by the outer `node --test` harness this file itself runs under)
    // otherwise leaks into the nested `--test` invocation below and suppresses its TAP output —
    // same fix test-with-retry.test.ts's own nested-real-test case already applies.
    env: { ...process.env, RMD_TEST_FLAKE_LEDGER: ledgerPath, NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /FLAKE-RETRY: first attempt failed — .*ledgered flaky test/, "the console line still prints");
  assert.ok(existsSync(ledgerPath), "a ledger row must exist -- not only the console line");
  const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.step, "test.flake_retry");
  assert.equal(rows[0]!.file, "flaky.test.mjs");
  assert.equal(rows[0]!.test, "ledgered flaky test");
  assert.equal(rows[0]!.headline, "first attempt failed");
  assert.equal(typeof rows[0]!.ts, "string");
});

test("W1-T4112: a flake-ledger write failure warns without failing the suite", () => {
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    assert.doesNotThrow(() =>
      appendFlakeLedger([{ file: "flaky.test.mjs", test: "ledgered flaky test" }], "first attempt failed", {
        path: "state/ledger.ndjson",
        mkdir: () => {},
        append: () => {
          throw new Error("ledger unavailable");
        },
      }),
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /could not append the flake ledger \(ledger unavailable\)/);
});

test("W1-T4112: a self-hosting daemon wires the test gardener", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4112-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  // Every class off: the wired garden measures this repo's real manifest but never opens a worktree.
  for (const c of TEST_GARDEN_CLASSES) writeFileSync(join(root, "state", `TEST_OFF-${c}`), "");
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  const oldFloor = process.env.RMD_GH_TRANSPORT_FLOOR;
  process.env.HOME = home;
  // The wired garden reads CI's proposal first; this gh answers with no main runs, off the network.
  const shim = ghShim([{ when: "actions/workflows/ci.yml/runs", stdout: "[]" }], { kind: "test-garden-proposal" });
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  let captured: DaemonDeps | undefined;
  try {
    await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      gardenPassesInProcess: true,
      runDaemon: async (_plan, d): Promise<DaemonSummary> => {
        captured = d;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    const start = captured?.gardens?.[2];
    assert.ok(start, "a third garden is wired after the plan and gate gardens");
    const stateFile = gardenStatePath(join(root, "state"), "test");
    const garden = start!(60_000);
    for (let waited = 0; !existsSync(stateFile) && waited < 20_000; waited += 100) await new Promise((r) => setTimeout(r, 100));
    garden.stop();
    assert.ok(readGardenState(stateFile, TEST_GARDEN_CLASSES).lastPass, "the wired garden ran a pass over this repo's real manifest");
    assert.ok(shim.calls().some((call) => call.includes("event=push&branch=main")), "the wired garden asked CI for its proposal");
    // Stopped before its probe loads, it never starts.
    const early = start!(60_000);
    early.stop();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldFloor === undefined) delete process.env.RMD_GH_TRANSPORT_FLOOR;
    else process.env.RMD_GH_TRANSPORT_FLOOR = oldFloor;
  }
});

test("a live ledger append leaves the test gardener cheap fingerprint unchanged within the hour", async () => {
  const probe = await probesPromise;
  const root = seededSuite();
  const stateDir = join(root, "state");
  const livePath = join(stateDir, "ledger.ndjson");
  writeFileSync(livePath, '{"step":"daemon.alive"}\n');
  const hourMs = Date.UTC(2026, 8, 29, 11, 0, 0);
  const before = testGardenCheapFingerprint(root, stateDir, probe, fixedClock(hourMs));
  appendFileSync(livePath, '{"step":"daemon.alive","n":2}\n');
  const later = new Date(hourMs + 120_000);
  utimesSync(livePath, later, later);
  assert.equal(testGardenCheapFingerprint(root, stateDir, probe, fixedClock(hourMs + 120_000)), before, "a ledger that only grew must not force a full union read");
  assert.notEqual(testGardenCheapFingerprint(root, stateDir, probe, fixedClock(hourMs + GARDEN_LEDGER_BUCKET_MS)), before, "the next hour re-reads");
});

test("the newest successful main run's CI proposal is fed to the gardener and adopt-durations acts on it", async () => {
  const probe = await probesPromise;
  const root = seededSuite();
  const stateDir = join(root, "state");
  const proposal = JSON.stringify({ thresholdMs: 5000, files: { "test/a.test.ts": 100, "test/b.test.ts": 6000, "test/c.test.ts": 50, "test/d.test.ts": 50 } }, null, 2) + "\n";
  let runs: unknown = [
    { id: 9, status: "in_progress", conclusion: null },
    { id: 8, status: "completed", conclusion: "failure" },
    { id: 7, status: "completed", conclusion: "success" },
  ];
  const listCalls: string[][] = [];
  const downloads: string[][] = [];
  let artifact: "present" | "absent" | "broken" | "unreachable" = "present";
  const io = {
    readJson: async (args: string[]) => (listCalls.push(args), runs),
    download: async (args: string[]) => {
      downloads.push(args);
      if (artifact === "absent") throw Object.assign(new Error("Command failed: gh run download"), { stderr: "no artifact matches any of the names or patterns provided" });
      if (artifact === "unreachable") throw Object.assign(new Error("Command failed: gh run download"), { stderr: "HTTP 502" });
      const dir = args[args.indexOf("--dir") + 1]!;
      const name = args[args.indexOf("--name") + 1]!;
      assert.ok(["test-tier-manifest-proposal", "test-tier-coverage-manifest-proposal"].includes(name));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name.replace("-proposal", ".next.json")), artifact === "broken" ? '{"files":{}}' : proposal);
      return "";
    },
  };
  assert.deepEqual(await refreshTestManifestProposalAsync("acme", "remudero", stateDir, io), { status: "fresh", runId: 7, coverage: { status: "fresh", runId: 7 } });
  assert.match(listCalls[0]![1]!, /ci\.yml\/runs\?event=push&branch=main/);
  assert.deepEqual(downloads[0]!.slice(0, 6), ["run", "download", "7", "--repo", "acme/remudero", "--name"]);
  assert.equal(readFileSync(testManifestProposalPath(stateDir), "utf8"), proposal);
  assert.equal(readFileSync(testManifestProposalPath(stateDir, "test-tier-coverage-manifest-proposal"), "utf8"), proposal);
  assert.deepEqual(downloads.map((args) => args[args.indexOf("--name") + 1]), ["test-tier-manifest-proposal", "test-tier-coverage-manifest-proposal"]);
  assert.equal(existsSync(join(stateDir, "test-tier-manifest-proposal.download")), false, "the download directory is removed");
  assert.equal(existsSync(join(stateDir, "test-tier-coverage-manifest-proposal.download")), false, "the coverage download directory is removed");
  assert.deepEqual(await refreshTestManifestProposalAsync("acme", "remudero", stateDir, io), { status: "unchanged", runId: 7, coverage: { status: "unchanged", runId: 7 } });
  assert.equal(downloads.length, 2, "each ledger downloads an unchanged main run only once");

  const landed: Landed[] = [];
  off(root, "retier-flaker", "shrink-baseline");
  const pass = runGarden(testGardenSpec(deps(root, landed), probe), deps(root, landed));
  assert.deepEqual(pass.plan?.acting, ["adopt-durations"], "the fed proposal is what lets the class act");
  assert.equal(landed.length, 1);

  runs = [{ id: 10, status: "completed", conclusion: "success" }];
  artifact = "absent";
  assert.deepEqual(await refreshTestManifestProposalAsync("acme", "remudero", stateDir, io), { status: "absent", reason: "run 10 published no proposal", runId: 10, coverage: { status: "absent", reason: "run 10 published no proposal", runId: 10 } });
  assert.deepEqual(await refreshTestManifestProposalAsync("acme", "remudero", stateDir, io), { status: "unchanged", runId: 10, coverage: { status: "unchanged", runId: 10 } },
    "the proposal already held stays; the artifact-less run is not asked again");
  assert.equal(downloads.length, 4);
  rmSync(testManifestProposalPath(stateDir));
  assert.deepEqual(await refreshTestManifestProposalAsync("acme", "remudero", stateDir, io), { status: "absent", reason: "run 10 published no proposal", runId: 10, coverage: { status: "unchanged", runId: 10 } });

  runs = [{ id: 11, status: "completed", conclusion: "success" }];
  artifact = "unreachable";
  await assert.rejects(refreshTestManifestProposalAsync("acme", "remudero", stateDir, io), /Command failed/, "a transport failure is the caller's to log");
  artifact = "broken";
  await assert.rejects(refreshTestManifestProposalAsync("acme", "remudero", stateDir, io), /not a \{thresholdMs, files\} manifest/);
  runs = [{ id: 12, status: "completed", conclusion: "cancelled" }];
  assert.deepEqual(await refreshTestManifestProposalAsync("acme", "remudero", stateDir, io), { status: "absent", reason: "no successful main run among the newest ten", coverage: { status: "absent", reason: "no successful main run among the newest ten" } });
  runs = { message: "Bad credentials" };
  await assert.rejects(refreshTestManifestProposalAsync("acme", "remudero", stateDir, io), /no main-run list/);
});

test("the test garden writes one pass row an hour saying why it did nothing", async () => {
  const probe = await probesPromise;
  const root = seededSuite();
  let nowMs = Date.UTC(2026, 8, 29, 11, 0, 0);
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const gardenDeps = { ...deps(root, []), clock: clockFromMillisFn(() => nowMs), log: (step: string, extra?: Record<string, unknown>) => { events.push({ step, extra }); } };
  let refreshes = 0;
  let failRefresh = false;
  const garden = startTestGarden(testGardenSpec(gardenDeps, probe), gardenDeps, async () => {
    refreshes++;
    if (failRefresh) throw new Error("gh unavailable");
    return { status: "absent", reason: "no successful main run among the newest ten" };
  }, 5);
  const passes = () => events.filter((e) => e.step === "test.pass");
  const until = async (ok: () => boolean) => { for (let waited = 0; !ok() && waited < 5_000; waited += 5) await new Promise((r) => setTimeout(r, 5)); };
  try {
    await until(() => passes().length === 1);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(passes().length, 1, "one row per hour, not per tick");
    assert.equal(refreshes, 1, "the CI proposal is read once per hour");
    assert.deepEqual(passes()[0]!.extra, { ran: true, feed: { status: "absent", reason: "no successful main run among the newest ten" }, pr_url: null, proposal_present: false });
    failRefresh = true;
    nowMs += GARDEN_LEDGER_BUCKET_MS;
    await until(() => passes().length === 2);
    assert.deepEqual(passes()[1]!.extra, { ran: false, feed: { status: "failed", error: "gh unavailable" }, pr_url: null, proposal_present: false },
      "an unchanged garden still says it looked, and why nothing moved");
    assert.ok(events.some((e) => e.step === "test.evidence_failed"));
  } finally {
    garden.stop();
  }
  const broken = { ...gardenDeps, stateDir: join(root, "missing", "\u0000") };
  const failing = startTestGarden(testGardenSpec(broken, probe), broken, async () => ({ status: "absent", reason: "none" }), 60_000);
  try {
    await until(() => events.some((e) => e.step === "test.gardener_failed"));
  } finally {
    failing.stop();
  }
  assert.ok(events.some((e) => e.step === "test.gardener_failed"), "a failed pass is logged by name");
});

test("a first adoption of every measured row fits one PR body", async () => {
  const probe = await probesPromise;
  const repo = gitRepo({ kind: "w1t4112-wide" });
  const root = repo.dir;
  const files: Record<string, number> = {};
  const measured: Record<string, number> = {};
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  for (let i = 0; i < 60; i++) {
    const file = `test/w${String(i).padStart(2, "0")}.test.ts`;
    writeFileSync(join(root, file), "export {};\n");
    files[file] = 0;
    measured[file] = 100 + i * 10;
  }
  writeFileSync(join(root, "scripts", "test-tier-manifest.json"), JSON.stringify({ thresholdMs: 5000, files }, null, 2) + "\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "seed");
  writeProposal(root, measured);
  off(root, "retier-flaker", "shrink-baseline");
  const landed: Landed[] = [];
  runGarden(testGardenSpec(deps(root, landed), probe), deps(root, landed));
  assert.equal(landed.length, 1);
  const body = landed[0]!.body;
  assert.equal((body.match(/^- \*\*adopt-durations\*\*/gm) ?? []).length, TEST_GARDEN_BODY_ROWS);
  assert.match(body, new RegExp(`…and ${60 - TEST_GARDEN_BODY_ROWS} more row\\(s\\)`));
  assert.equal((body.match(/^  proof: grep: /gm) ?? []).length, TEST_GARDEN_PROOF_ROWS);
  assert.match(body, /proof: grep: "test\/w59\.test\.ts": 690 in scripts\/test-tier-manifest\.json/, "the largest measured row is proved first");
  assert.equal(JSON.parse(readFileSync(join(root, "scripts", "test-tier-manifest.json"), "utf8")).files["test/w00.test.ts"], 100, "every row still lands");
});
