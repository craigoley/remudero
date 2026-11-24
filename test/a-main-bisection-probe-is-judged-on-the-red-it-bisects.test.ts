import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { buildMainHealthRung, type MainProbeReading, type MainRepairLane } from "#src/lib/main-health-rung.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { readLedgerLines } from "#src/lib/status.js";
import type { CiFailure, RollupCheckEntry } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// The 2026-11-18 red: first-parent order green 58be942f8, then 12f14d934, 22cb974e3, 73fef8b1b (#19469), red d23fd07de.
const GREEN = "58be942f8".padEnd(40, "0");
const A = "12f14d934".padEnd(40, "0");
const B = "22cb974e3".padEnd(40, "0");
const C = "73fef8b1b".padEnd(40, "0");
const RED = "d23fd07de".padEnd(40, "0");
const HEAD = "e".repeat(40);
const REQUIRED = ["ci", "ci-shard (1/8)", "ci-shard (2/8)", "coverage-ratchet"];
const RED_TEST = "not ok 4 - gate-probe-native-evidence names the probe label";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type Jobs = Record<string, string>;
const jobsOf = (states: Jobs, sha?: string): RollupCheckEntry[] => Object.entries(states).map(([name, state]) => ({
  name, status: state === "in_progress" ? "in_progress" : "completed",
  ...(state === "in_progress" ? {} : { conclusion: state }),
  ...(sha ? { detailsUrl: `https://github.com/o/r/actions/runs/1/job/${sha}` } : {}),
}));
const MAIN_RED: Jobs = { ci: "failure", "ci-shard (1/8)": "failure", "ci-shard (2/8)": "success", "coverage-ratchet": "success" };
/** The 2026-11-18 probe of 22cb974e3 and 12f14d934: every ci-shard job green, coverage-ratchet refused the class. */
const RATCHET_ONLY: Jobs = { ci: "success", "ci-shard (1/8)": "success", "ci-shard (2/8)": "success", "coverage-ratchet": "failure" };
const OWN_RED: Jobs = { ci: "failure", "ci-shard (1/8)": "failure", "ci-shard (2/8)": "success", "coverage-ratchet": "failure" };

function fixture(t: { after: (fn: () => void) => void }, probeJobs: (sha: string) => Jobs, probeDetail: (sha: string) => string = () => RED_TEST) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}probe-on-its-red-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const chain = [GREEN, A, B, C, RED, HEAD];
  const histories = [HEAD, RED, C, B, A, GREEN].map((sha, i) => ({
    id: 100 + i, name: "CI", head_sha: sha, status: "completed",
    conclusion: sha === GREEN ? "success" : sha === HEAD || sha === RED ? "failure" : "cancelled",
  }));
  const runJobs = (conclusion: string | undefined): Jobs => conclusion === "failure" ? MAIN_RED
    : Object.fromEntries(REQUIRED.map((name) => [name, conclusion ?? "cancelled"]));
  const fetch = ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/"))?.replace("repos/o/r", "") ?? "";
    if (args.includes("--method")) return {};
    if (path === "") return { default_branch: "main" };
    if (path === "/commits/main") return { sha: HEAD };
    if (path.endsWith("/check-runs?per_page=100")) {
      return { check_runs: Object.entries(MAIN_RED).map(([name, conclusion], i) => ({ id: i + 1, name, status: "completed", conclusion })) };
    }
    if (path.endsWith("/status")) return { statuses: [] };
    if (path.startsWith("/actions/runs?")) return { workflow_runs: histories };
    const id = Number(/\/actions\/runs\/(\d+)\/jobs/.exec(path)?.[1]);
    if (id) {
      return { jobs: Object.entries(runJobs(histories.find((run) => run.id === id)?.conclusion))
        .map(([name, conclusion], i) => ({ id: id * 10 + i, name, status: "completed", conclusion })) };
    }
    const sha = /^\/commits\/([a-f0-9]{40})$/.exec(path)?.[1];
    if (sha) return { parents: [{ sha: chain[chain.indexOf(sha) - 1] }], files: [{ filename: "test/gate-probe-native-evidence.test.ts", additions: 1 }] };
    throw new Error(`unexpected API read ${path}`);
  }) as GhApiFetcher;
  const dispatched: string[] = [];
  const lane: MainRepairLane = {
    openFixPr: async () => "https://github.com/o/r/pull/1",
    readPr: async () => ({ state: "open" }),
    openRevertPr: async () => ({ prUrl: "https://github.com/o/r/pull/2" }),
    probes: {
      dispatch: async (sha) => { dispatched.push(sha); return { sha, ref: `rmd-attribution/${sha}` }; },
      read: async (probe): Promise<MainProbeReading> => ({ status: "completed", runId: 7, jobs: jobsOf(probeJobs(probe.sha), probe.sha) }),
      release: async () => {},
      readRunnerLoad: async () => ({ queuedJobs: 1, idleRunners: 0 }),
    },
  };
  // A failing job's log: the probe's own detail for a probe job, the red's for main's run.
  const readCiFailures = (rollup: readonly RollupCheckEntry[] | undefined): CiFailure[] => (rollup ?? []).map((entry) => {
    const probed = /\/job\/([0-9a-f]{40})$/.exec(entry.detailsUrl ?? "")?.[1];
    return { name: entry.name ?? "", conclusion: "FAILURE", logTail: probed ? probeDetail(probed) : RED_TEST } as CiFailure;
  });
  let clock = Date.now();
  const rung = buildMainHealthRung("o", "r", {
    fetch, ledgerPath, runId: "PROBE-ON-ITS-RED", log: () => {}, now: () => clock,
    issues: { create: async () => "https://github.com/o/r/issues/1", listOpen: async () => [], comment: async () => {}, closeWithComment: async () => {} },
    readRequiredChecks: () => REQUIRED,
    readCiFailures,
    mergeReader: { prMerge: () => undefined, mergeBase: () => GREEN, prsMergedBetween: () => [] },
    repair: lane,
  });
  const settle = async (passes = 10) => { for (let i = 0; i < passes; i++) { clock += 60_000; await rung(); await flush(); } };
  const rows = (step: string) => readLedgerLines(ledgerPath).filter((row) => row.step === step); // ledger-read-intent: live
  return { settle, rows, dispatched, probed: (sha: string) => rows("main.repair.probe_concluded").filter((row) => row.probe_sha === sha) };
}

test("W1-T13792 criterion 1: a probe red only on coverage-ratchet is green for a ci and ci-shard red, so #19469 is located", async (t) => {
  const f = fixture(t, (sha) => sha === C ? OWN_RED : RATCHET_ONLY);
  await f.settle();
  const located = f.rows("main.repair.located")[0];
  assert.equal(located?.method, "bisected-first-red", JSON.stringify(f.rows("main.repair.probe_concluded")));
  assert.equal(located?.offending_sha, C, "the lane names 73fef8b1b, not 12f14d934");
  assert.equal(located?.parent_sha, B);
  const ofB = f.probed(B)[0];
  assert.equal(ofB?.verdict, "green");
  assert.deepEqual(ofB?.failing_checks, ["coverage-ratchet"], "the row still names every failing check");
  assert.deepEqual(ofB?.counted_checks, []);
});

test("W1-T13792 criterion 2: a probe red on the red's own checks with the same detail is recorded red", async (t) => {
  const f = fixture(t, (sha) => sha === C ? OWN_RED : RATCHET_ONLY);
  await f.settle();
  const ofC = f.probed(C)[0];
  assert.equal(ofC?.verdict, "red");
  assert.deepEqual(ofC?.counted_checks, ["ci", "ci-shard (1/8)"]);
  assert.deepEqual(ofC?.failing_checks, ["ci", "ci-shard (1/8)", "coverage-ratchet"]);
  assert.deepEqual(f.rows("main.repair.located")[0]?.probe_failing_checks, ["ci", "ci-shard (1/8)"],
    "the culprit proof reads the counted checks, not coverage-ratchet");
});

test("W1-T13792 criterion 3: other detail, or a red check pending, cancelled or unread, is inconclusive and the row says why", async (t) => {
  const variants: Array<{ name: string; jobs: Jobs; detail?: string; failing: string[]; why: RegExp }> = [
    { name: "other detail", jobs: OWN_RED, detail: "not ok 9 - an unrelated test", failing: ["ci", "ci-shard (1/8)", "coverage-ratchet"], why: /not on this red's/ },
    { name: "a red check pending", jobs: { ...RATCHET_ONLY, "ci-shard (1/8)": "in_progress" }, failing: ["coverage-ratchet"], why: /did not all pass/ },
    { name: "a red check cancelled", jobs: { ...OWN_RED, "ci-shard (1/8)": "cancelled" }, failing: ["ci", "coverage-ratchet"], why: /not on this red's/ },
    { name: "a red check unread", jobs: { ci: "success", "coverage-ratchet": "failure" }, failing: ["coverage-ratchet"], why: /ran none of this red's ci-shard/ },
  ];
  for (const variant of variants) {
    const f = fixture(t, () => variant.jobs, () => variant.detail ?? RED_TEST);
    await f.settle(4);
    const concluded = f.rows("main.repair.probe_concluded");
    assert.ok(concluded.length > 0, variant.name);
    for (const row of concluded) {
      assert.equal(row.verdict, "inconclusive", `${variant.name}: never red or green`);
      assert.deepEqual(row.failing_checks, variant.failing, variant.name);
      assert.match(String(row.reason), variant.why, variant.name);
    }
    assert.equal(f.rows("main.repair.located").filter((row) => row.method === "bisected-first-red").length, 0, variant.name);
  }
});

type Step = { name?: string; run?: string };
const CI = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, { steps?: Step[] }> };

function runClassCheck(t: { after: (fn: () => void) => void }, classes: (shard: number) => string) {
  const run = CI.jobs["coverage-ratchet-required"]?.steps?.find((step) => step.name === "Require downloaded coverage shard artifacts")?.run;
  assert.ok(run, "coverage-ratchet must carry its shard-class step");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}coverage-class-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let shard = 1; shard <= 16; shard++) {
    mkdirSync(join(root, `coverage-shards/coverage-shard-${shard}`), { recursive: true });
    writeFileSync(join(root, `coverage-shards/coverage-shard-${shard}/class`), classes(shard));
  }
  const output = join(root, "github-output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run!], {
    cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output },
  });
  return { status: result.status, said: `${result.stdout}${result.stderr}`, output: readFileSync(output, "utf8") };
}

test("W1-T13792 criterion 4: shards classed workflow_dispatch:SOURCE pass the class check and output class SOURCE", (t) => {
  const result = runClassCheck(t, () => "workflow_dispatch:SOURCE");
  assert.equal(result.status, 0, result.said);
  assert.match(result.output, /^class=SOURCE$/m);
  assert.match(result.output, /^event=workflow_dispatch$/m);
});

test("W1-T13792 criterion 5: an unlisted class and shards that disagree are still refused", (t) => {
  const unknown = runClassCheck(t, () => "schedule:SOURCE");
  assert.equal(unknown.status, 1, unknown.said);
  assert.match(unknown.said, /unrecognised class metadata 'schedule:SOURCE'/);
  const disagree = runClassCheck(t, (shard) => shard === 5 ? "workflow_dispatch:TEST_ONLY" : "workflow_dispatch:SOURCE");
  assert.equal(disagree.status, 1, disagree.said);
  assert.match(disagree.said, /coverage shards disagree on fast-lane class \(workflow_dispatch:SOURCE vs workflow_dispatch:TEST_ONLY\)/);
});
