/**
 * A RED MAIN IS ATTRIBUTED BY RUNNING ITS FAILING TESTS LOCALLY AT THE UNATTRIBUTED COMMITS.
 *
 * W1-T7760 attributes a red across cancelled commits with one full CI run per commit, about 30 minutes
 * each and run one at a time, so main stays red an hour or more before a fix goes out. The failing test
 * files are already known from the ci-shard log, and the sweep's base reproduction probe can run them at
 * any commit. The lane now runs them locally at the cancelled commits first, and hands a commit to a CI
 * probe only when the local verdict is inconclusive.
 *
 * Fixtures replay a red against the real rung. GitHub's REST is answered by a fake world, and
 * `reproduceAt` is a fake of the base reproduction probe.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import type { AsyncIssueGateway } from "../src/lib/escalate.js";
import {
  buildMainHealthRung,
  localTestVerdict,
  MAIN_LOCAL_PROBE_REF_PREFIX,
  type MainHealthRungDeps,
  type MainLocalTestOutcome,
  type MainRepairFixRequest,
  type MainRepairLane,
  type MainRepairRevertRequest,
} from "../src/lib/main-health-rung.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { CiFailure } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { mainRepairLaneFor } from "../src/run-task.js";

const OWNER = "craigoley";
const REPO = "remudero";
const REPO_PATH = `repos/${OWNER}/${REPO}`;
const sha = (prefix: string): string => prefix.padEnd(40, "0");
const GREEN = sha("9a11ee00");
const RED = sha("de219e4f"); // the first COMPLETED red
const HEAD = sha("4624f370");
const FIX_PR = `https://github.com/${OWNER}/${REPO}/pull/12390`;
const REVERT_PR = `https://github.com/${OWNER}/${REPO}/pull/12391`;
const FAILING_FILE = "test/a-retired-index-line-keeps-its-frozen-bullet.test.ts";
const PROBE_BASE = 5000;
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const minute = 60_000;

interface World {
  /** Oldest first: the last green, the cancelled commits, the first completed red, main's head. */
  chain: string[];
  cancelled: string[];
  /** What a CI probe concludes for a commit once it finishes. */
  verdicts: Map<string, "success" | "failure">;
  finished: Set<string>;
  probes: Map<string, { id: number; sha: string }>;
  /** Every mutating request, as `METHOD path field=value ...`. */
  requests: string[];
  /** The test file main's failing ci-shard log names. */
  failingFile: string;
}

function world(cancelledCount: number): World {
  const cancelled = Array.from({ length: cancelledCount }, (_, i) => sha(`c${String(i + 1).padStart(2, "0")}`));
  return { chain: [GREEN, ...cancelled, RED, HEAD], cancelled, verdicts: new Map(), finished: new Set(), probes: new Map(), requests: [], failingFile: FAILING_FILE };
}

const at = (minutes: number): string => new Date(Date.parse("2026-10-16T14:00:00Z") + minutes * minute).toISOString();

function historyOf(w: World) {
  const completed = (id: number, head: string, conclusion: string, minutes: number) => ({
    id,
    name: "CI",
    head_sha: head,
    status: "completed",
    conclusion,
    pull_requests: [{ number: id }],
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${id}`,
    run_started_at: at(0),
    updated_at: at(minutes),
  });
  return [
    completed(900, HEAD, "failure", 40),
    completed(700, RED, "failure", 20),
    ...[...w.cancelled].reverse().map((head, i) => completed(800 + i, head, "cancelled", 5)),
    completed(600, GREEN, "success", 30),
  ];
}

function rig(w: World, lane: MainRepairLane, ledgerPath: string, overrides: Partial<MainHealthRungDeps> = {}) {
  let clock = Date.parse("2026-10-16T15:13:00Z");
  const probeRun = (id: number) => [...w.probes.values()].find((probe) => probe.id === id);
  const fetch = ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    const field = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    if (args.includes("--method")) {
      const method = args[args.indexOf("--method") + 1]!;
      w.requests.push(`${method} ${path.slice(REPO_PATH.length + 1)} ${args.filter((arg) => /^\w+=/.test(arg)).join(" ")}`.trim());
      if (path.endsWith("/actions/workflows/ci.yml/dispatches")) {
        const probeSha = field("ref")!.replace("rmd-attribution/", "");
        w.probes.set(probeSha, { id: PROBE_BASE + w.probes.size, sha: probeSha });
      }
      return {};
    }
    if (path === REPO_PATH) return { default_branch: "main" };
    if (path === `${REPO_PATH}/commits/main`) return { sha: HEAD };
    if (path === `${REPO_PATH}/commits/${HEAD}/check-runs?per_page=100`) {
      return { check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "failure" }] };
    }
    if (path === `${REPO_PATH}/commits/${HEAD}/status`) return { statuses: [] };
    if (path === `${REPO_PATH}/actions/runs?status=queued&per_page=1`) return { total_count: 0 };
    if (path === `${REPO_PATH}/actions/runners?per_page=100`) return { runners: [{ status: "online", busy: false }] };
    if (path.startsWith(`${REPO_PATH}/actions/workflows/ci.yml/runs?`)) {
      const ref = decodeURIComponent(/branch=([^&]+)/.exec(path)![1]!);
      const probe = w.probes.get(ref.replace("rmd-attribution/", ""));
      if (!probe) return { workflow_runs: [] };
      const status = w.finished.has(probe.sha) ? "completed" : "in_progress";
      return { workflow_runs: [{ id: probe.id, head_sha: probe.sha, status, html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${probe.id}` }] };
    }
    if (path.startsWith(`${REPO_PATH}/actions/runs?`)) return { workflow_runs: historyOf(w) };
    const jobs = /actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path)?.[1];
    if (jobs) {
      const id = Number(jobs);
      if (id >= PROBE_BASE) {
        const probe = probeRun(id)!;
        const done = w.finished.has(probe.sha);
        return { jobs: [{ id: id * 10, name: "ci", status: done ? "completed" : "in_progress", ...(done ? { conclusion: w.verdicts.get(probe.sha) } : {}) }] };
      }
      const run = historyOf(w).find((candidate) => candidate.id === id);
      return { jobs: [{ id: id * 10, name: "ci", status: "completed", conclusion: run?.conclusion ?? "failure" }] };
    }
    const commit = /^repos\/craigoley\/remudero\/commits\/([0-9a-f]{40})$/.exec(path)?.[1];
    if (commit) {
      const index = w.chain.indexOf(commit);
      return { parents: index > 0 ? [{ sha: w.chain[index - 1] }] : [], files: [{ filename: "src/lib/plan-index.ts", additions: 9, deletions: 0 }] };
    }
    throw new Error(`unrouted gh api call: ${args.join(" ")}`);
  }) as GhApiFetcher;
  const issues: AsyncIssueGateway = {
    create: async () => `https://github.com/${OWNER}/${REPO}/issues/12392`,
    listOpen: async () => [],
    comment: async () => {},
    closeWithComment: async () => {},
  };
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath,
    runId: "DAEMON-LOCAL-BISECT",
    log: () => {},
    now: () => clock,
    readRequiredChecks: () => ["ci"],
    // The ci-shard log names the failing file; its `not ok` title is the red's signature.
    readCiFailures: (rollup) =>
      (rollup ?? []).map((entry): CiFailure => ({
        name: entry.name ?? "",
        conclusion: "FAILURE",
        logTail: `# Subtest: ${w.failingFile}\nnot ok 3 - a retired index line keeps its frozen bullet`,
      })),
    mergeReader: { prMerge: () => undefined, mergeBase: () => GREEN, prsMergedBetween: () => [] },
    repair: lane,
    ...overrides,
  });
  return {
    observe: async () => {
      clock += minute;
      await rung();
      await flush();
    },
  };
}

type LocalLane = MainRepairLane & { fixes: MainRepairFixRequest[]; reverts: MainRepairRevertRequest[]; local: Array<[string, string[]]> };

/** A lane whose `reproduceAt` answers each commit's files with `outcomes[sha]`, and records each call. */
function localLane(outcomes: Record<string, MainLocalTestOutcome["outcome"]>): LocalLane {
  const lane: LocalLane = {
    fixes: [],
    reverts: [],
    local: [],
    openFixPr: async (request) => {
      lane.fixes.push(request);
      return FIX_PR;
    },
    openRevertPr: async (request) => {
      lane.reverts.push(request);
      return { prUrl: REVERT_PR };
    },
    reproduceAt: async (probeSha, testFiles) => {
      lane.local.push([probeSha, [...testFiles]]);
      return testFiles.map((file) => ({ file, outcome: outcomes[probeSha] ?? "unrunnable" }));
    },
  };
  return lane;
}

const rowsOf = (ledgerPath: string, step: string) => readLedgerLines(ledgerPath).filter((row) => row.step === step); // ledger-read-intent: live

function inScratchDir(body: (ledgerPath: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}local-bisect-`));
    try {
      await body(join(root, "ledger.ndjson"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const ciDispatches = (w: World): string[] => w.requests.filter((request) => request.includes("/dispatches") || request.startsWith("POST git/refs"));

test("a red main is attributed by running its failing tests locally at the cancelled commits",
  inScratchDir(async (ledgerPath) => {
    const w = world(2);
    const [c1, c2] = w.cancelled as [string, string];
    // C2 fails the red's test file; C1 does not have it yet, so this red could not be red there.
    const lane = localLane({ [c2]: "fails", [c1]: "absent" });
    const daemon = rig(w, lane, ledgerPath);
    await daemon.observe();
    await daemon.observe();
    await daemon.observe();

    const [located] = rowsOf(ledgerPath, "main.repair.located");
    assert.ok(located, "the first red is located from local verdicts alone");
    assert.equal(located.offending_sha, c2, "the first commit where the failing tests fail");
    assert.equal(located.method, "bisected-first-red");
    assert.equal(located.parent_sha, c1);
    const evidence = located.probe_runs as Array<{ sha: string; verdict: string; method?: string; test_files?: string[] }>;
    assert.deepEqual(evidence.slice(0, 2).map((e) => [e.sha, e.verdict, e.method]), [[c2, "red", "local-test"], [c1, "green", "local-test"]]);
    assert.deepEqual(evidence[0]!.test_files, [FAILING_FILE], "the local evidence names its files");
    assert.deepEqual(ciDispatches(w), [], "no CI probe was dispatched");
    assert.deepEqual(lane.local, [[c2, [FAILING_FILE]], [c1, [FAILING_FILE]]], "newest first, with the ci-shard log's file");

    const bisecting = rowsOf(ledgerPath, "main.repair.bisecting");
    assert.deepEqual(bisecting.map((row) => [row.method, (row.probes as Array<{ ref: string }>)[0]!.ref]), [
      ["local-test", `${MAIN_LOCAL_PROBE_REF_PREFIX}${c2}`],
      ["local-test", `${MAIN_LOCAL_PROBE_REF_PREFIX}${c1}`],
    ]);
    const concluded = rowsOf(ledgerPath, "main.repair.probe_concluded");
    assert.deepEqual(concluded.map((row) => [row.probe_sha, row.method, row.verdict]), [[c2, "local-test", "red"], [c1, "local-test", "green"]]);
    assert.deepEqual(concluded[0]!.outcomes, [{ file: FAILING_FILE, outcome: "fails" }]);
    assert.equal(lane.fixes.length, 1);
    assert.equal(lane.fixes[0]!.offendingSha, c2, "the fix goes at the locally bisected first red");

    // The verdict a local probe reads: any file failing is red; passing or absent everywhere is green.
    const v = (...outcomes: MainLocalTestOutcome["outcome"][]) => localTestVerdict(outcomes.map((outcome, i) => ({ file: `test/${i}.test.ts`, outcome })));
    assert.equal(v("fails", "unrunnable"), "red");
    assert.equal(v("passes", "absent"), "green");
    assert.equal(v("passes", "unrunnable"), "inconclusive");
    assert.equal(v(), "inconclusive", "no outcome read is no verdict");
  }),
);

test("a local probe runs off the rung and one lost to a restart is planned again",
  inScratchDir(async (ledgerPath) => {
    const w = world(2);
    const [, c2] = w.cancelled as [string, string];
    let settle!: (outcomes: MainLocalTestOutcome[]) => void;
    const running = new Promise<MainLocalTestOutcome[]>((resolve) => (settle = resolve));
    const lane = localLane({});
    lane.reproduceAt = (probeSha, testFiles) => {
      lane.local.push([probeSha, [...testFiles]]);
      return running;
    };
    const daemon = rig(w, lane, ledgerPath);
    let timer: NodeJS.Timeout | undefined;
    const blocked = new Promise((resolve) => (timer = setTimeout(() => resolve("blocked"), 5_000)));
    const pass = await Promise.race([daemon.observe().then(() => "returned"), blocked]);
    clearTimeout(timer);
    assert.equal(pass, "returned", "the rung returns while its local probe runs");
    const [bisecting] = rowsOf(ledgerPath, "main.repair.bisecting");
    assert.equal(bisecting?.method, "local-test");
    assert.deepEqual(bisecting?.probe_shas, [c2]);
    assert.equal(rowsOf(ledgerPath, "main.repair.probe_concluded").length, 0);

    // The next pass of the same process waits on its own probe: it starts no second one, local or CI.
    await daemon.observe();
    assert.equal(lane.local.length, 1);
    assert.equal(rowsOf(ledgerPath, "main.repair.bisecting").length, 1);
    assert.deepEqual(ciDispatches(w), []);

    // A restart: the ledger shows C2 in flight, and no process runs it, so it is planned again.
    const lost: Record<string, unknown>[] = [];
    const restartedLane = localLane({ [c2]: "fails" });
    const restarted = rig(w, restartedLane, ledgerPath, { log: (step, fields) => step === "main.repair.local_probe_lost" && lost.push(fields ?? {}) });
    await restarted.observe();
    assert.deepEqual(restartedLane.local.map(([probed]) => probed), [c2], "the lost probe is planned again");
    assert.equal(lost[0]?.probe_sha, c2, "the lost probe is named");
    assert.deepEqual(rowsOf(ledgerPath, "main.repair.bisecting").map((row) => row.probe_shas), [[c2], [c2]]);
    assert.deepEqual(rowsOf(ledgerPath, "main.repair.probe_concluded").map((row) => [row.probe_sha, row.verdict]), [[c2, "red"]]);
    assert.deepEqual(ciDispatches(w), []);
    settle([]);
    await flush();
  }),
);

test("an inconclusive local probe falls to CI and a local proof names its files",
  inScratchDir(async (ledgerPath) => {
    for (const changed of [false, true]) {
      const path = `${ledgerPath}.${changed ? "changed" : "same"}`;
      const w = world(2);
      const [c1, c2] = w.cancelled as [string, string];
      w.verdicts.set(c2, "failure");
      // C2's tests cannot run locally; C1 passes them.
      const lane = localLane({ [c2]: "unrunnable", [c1]: "passes" });
      lane.openFixPr = async (request) => {
        lane.fixes.push(request);
        return undefined;
      };
      const daemon = rig(w, lane, path);
      await daemon.observe();
      const [inconclusive] = rowsOf(path, "main.repair.probe_concluded");
      assert.deepEqual([inconclusive?.probe_sha, inconclusive?.method, inconclusive?.verdict], [c2, "local-test", "inconclusive"]);
      await daemon.observe();
      assert.deepEqual(ciDispatches(w), [`POST git/refs ref=refs/heads/rmd-attribution/${c2} sha=${c2}`, "POST actions/workflows/ci.yml/dispatches ref=rmd-attribution/" + c2],
        "the inconclusive commit is handed to a CI probe");
      assert.deepEqual(lane.local.map(([probed]) => probed), [c2], "and is never run locally again");
      w.finished.add(c2);
      await daemon.observe();
      assert.deepEqual(lane.local.map(([probed]) => probed), [c2, c1], "its parent is still probed locally");
      // The red now names another file: the parent's local run proves nothing about it.
      if (changed) w.failingFile = "test/a-different-suite-now-fails.test.ts";
      await daemon.observe();
      const [located] = rowsOf(path, "main.repair.located");
      assert.equal(located?.offending_sha, c2);
      assert.equal(located?.parent_sha, c1);
      const evidence = located?.probe_runs as Array<{ sha: string; verdict: string; method?: string; run_url?: string; test_files?: string[] }>;
      assert.match(String(evidence[0]!.run_url), /\/actions\/runs\/50\d\d$/, "the culprit's evidence is its CI probe");
      assert.deepEqual([evidence[1]!.sha, evidence[1]!.verdict, evidence[1]!.method, evidence[1]!.test_files], [c1, "green", "local-test", [FAILING_FILE]]);

      // The fix attempt ends with no PR, so the revert is weighed against the local proof.
      await daemon.observe();
      await flush();
      if (!changed) {
        assert.equal(lane.reverts.length, 1, "the parent passes the same files this red names, so the culprit is proven");
        assert.match(lane.reverts[0]!.whyFixInsufficient, new RegExp(`${c1}\` passes ${FAILING_FILE.replaceAll(".", "\\.")}`));
        assert.equal(rowsOf(path, "main.repair.revert_opened").length, 1);
      } else {
        assert.equal(lane.reverts.length, 0, "a parent that passed other files proves nothing about this red");
        const [withheld] = rowsOf(path, "main.repair.revert_withheld");
        assert.match(String(withheld?.reason), /test\/a-different-suite-now-fails\.test\.ts/);
      }
    }
  }),
);

test("W1-T9927: the production lane runs a commit's failing tests through the sweep's base reproduction probe",
  inScratchDir(async (ledgerPath) => {
    const config = { root: join(ledgerPath, "..") } as Config;
    const built: Array<[string, string]> = [];
    const probed: Array<[number, string, string[], string]> = [];
    const unused = async () => {
      throw new Error("not exercised");
    };
    const lane = mainRepairLaneFor(OWNER, "fixture-repo", config, ledgerPath, "R", unused, unused, (cfg, repoDir, path, log) => {
      assert.equal(cfg, config);
      built.push([repoDir, path]);
      log("sweep.base_reproduction.cleanup_failed", { reason: "fixture" });
      return async (pr, files, mainSha) => {
        probed.push([pr.prNumber, pr.headSha, [...files], mainSha]);
        return files.map((file, i) => ({ file, outcome: i === 0 ? ("fails" as const) : ("unrunnable" as const), duration_ms: 1, cached: false, ...(i === 0 ? {} : { reason: "no tsx" }) }));
      };
    });
    const c2 = sha("c02");
    assert.deepEqual(await lane.reproduceAt!(c2, [FAILING_FILE, "test/b.test.ts"]), [
      { file: FAILING_FILE, outcome: "fails" },
      { file: "test/b.test.ts", outcome: "unrunnable", reason: "no tsx" },
    ]);
    await lane.reproduceAt!(sha("c01"), [FAILING_FILE]);
    assert.deepEqual(built, [[join(config.root, "repos", "fixture-repo"), ledgerPath]], "one probe, over the target's managed checkout");
    assert.deepEqual(probed.map(([, head, files, at]) => [head, files, at]), [[c2, [FAILING_FILE, "test/b.test.ts"], c2], [sha("c01"), [FAILING_FILE], sha("c01")]]);
    const [logged] = rowsOf(ledgerPath, "sweep.base_reproduction.cleanup_failed");
    assert.deepEqual([logged?.run_id, logged?.task_id, logged?.lane], ["R", "MAIN-HEALTH", "main-repair"]);
  }),
);
