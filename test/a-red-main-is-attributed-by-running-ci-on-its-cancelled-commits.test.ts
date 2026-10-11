/**
 * A RED MAIN IS ATTRIBUTED BY RUNNING CI ON ITS CANCELLED COMMITS, NEVER BY NAMING ONE.
 *
 * 2026-10-10: `main.repair.located` named cc903730b, 58eb31094 and cd5741b83 as culprits, three
 * commits whose CI was cancelled and never concluded. Of main's newest 100 CI runs, 63 were cancelled
 * while pending (ci.yml groups pushes to main under one concurrency key and keeps one pending run), so
 * most main commits never get a verdict. The lane now takes the completed red and the UNATTRIBUTED span
 * of cancelled commits between it and the last green, and runs CI on those commits, each under its own
 * ref, until the first red is bounded by a completed green.
 *
 * Fixtures replay that red against the real rung, with GitHub's REST answered by a fake world.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AsyncIssueGateway } from "../src/lib/escalate.js";
import {
  buildMainHealthRung,
  chooseProbeConcurrency,
  locatedWriterRefusal,
  medianCiRunMs,
  planMainBisection,
  type MainHealthRungDeps,
  type MainProbeVerdict,
  type MainRepairFixRequest,
  type MainRepairLane,
} from "../src/lib/main-health-rung.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  mainHealthFirstRedCommitFromRunHistory,
  type CiFailure,
  type MainHealthRunHistoryEntry,
} from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const OWNER = "craigoley";
const REPO = "remudero";
const REPO_PATH = `repos/${OWNER}/${REPO}`;
const sha = (prefix: string): string => prefix.padEnd(40, "0");
const GREEN = sha("9a11ee00");
const RED = sha("de219e4f"); // the first COMPLETED red
const HEAD = sha("4624f370");
const FIX_PR = `https://github.com/${OWNER}/${REPO}/pull/10790`;
const PROBE_BASE = 5000;
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const minute = 60_000;

interface World {
  /** Oldest first: the last green, the cancelled commits, the first completed red, main's head. */
  chain: string[];
  cancelled: string[];
  /** What a probe's CI concludes for a commit once it finishes. */
  verdicts: Map<string, "success" | "failure">;
  finished: Set<string>;
  probes: Map<string, { id: number; sha: string }>;
  refs: Set<string>;
  /** Every mutating request, as `METHOD path field=value ...`. */
  requests: string[];
  queued: number;
  idle: number;
  refuseDispatch?: boolean;
}

function world(cancelledCount: number): World {
  const cancelled = Array.from({ length: cancelledCount }, (_, i) => sha(`c${String(i + 1).padStart(2, "0")}`));
  return {
    chain: [GREEN, ...cancelled, RED, HEAD],
    cancelled,
    verdicts: new Map(),
    finished: new Set(),
    probes: new Map(),
    refs: new Set(),
    requests: [],
    queued: 0,
    idle: 0,
  };
}

const at = (minutes: number): string => new Date(Date.parse("2026-10-10T10:00:00Z") + minutes * minute).toISOString();

function historyOf(w: World) {
  // Newest first. Completed runs took 30, 20 and 40 minutes: the median is 30.
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
  let clock = Date.parse("2026-10-10T18:38:00Z");
  const probeRun = (id: number) => [...w.probes.values()].find((probe) => probe.id === id);
  const fetch = ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    const field = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    if (args.includes("--method")) {
      const method = args[args.indexOf("--method") + 1]!;
      w.requests.push(`${method} ${path.slice(REPO_PATH.length + 1)} ${args.filter((arg) => /^\w+=/.test(arg)).join(" ")}`.trim());
      if (path === `${REPO_PATH}/git/refs` && method === "POST") {
        w.refs.add(field("ref")!);
      } else if (path.endsWith("/actions/workflows/ci.yml/dispatches")) {
        if (w.refuseDispatch) throw new Error("HTTP 422 Workflow does not have 'workflow_dispatch' trigger");
        const probeSha = field("ref")!.replace("rmd-attribution/", "");
        w.probes.set(probeSha, { id: PROBE_BASE + w.probes.size, sha: probeSha });
      } else if (method === "DELETE") {
        w.refs.delete(`refs/${path.slice(`${REPO_PATH}/git/refs/`.length)}`);
      }
      return {};
    }
    if (path === REPO_PATH) return { default_branch: "main" };
    if (path === `${REPO_PATH}/commits/main`) return { sha: HEAD };
    if (path === `${REPO_PATH}/commits/${HEAD}/check-runs?per_page=100`) {
      return { check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "failure" }] };
    }
    if (path === `${REPO_PATH}/commits/${HEAD}/status`) return { statuses: [] };
    if (path === `${REPO_PATH}/actions/runs?status=queued&per_page=1`) return { total_count: w.queued };
    if (path === `${REPO_PATH}/actions/runners?per_page=100`) {
      return { runners: Array.from({ length: w.idle }, () => ({ status: "online", busy: false })) };
    }
    if (path.startsWith(`${REPO_PATH}/actions/workflows/ci.yml/runs?`)) {
      const ref = decodeURIComponent(/branch=([^&]+)/.exec(path)![1]!);
      const probe = w.probes.get(ref.replace("rmd-attribution/", ""));
      if (!probe) return { workflow_runs: [] };
      return {
        workflow_runs: [
          {
            id: probe.id,
            head_sha: probe.sha,
            status: w.finished.has(probe.sha) ? "completed" : "in_progress",
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${probe.id}`,
          },
        ],
      };
    }
    if (path.startsWith(`${REPO_PATH}/actions/runs?`)) return { workflow_runs: historyOf(w) };
    const jobs = /actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path)?.[1];
    if (jobs) {
      const id = Number(jobs);
      if (id >= PROBE_BASE) {
        const probe = probeRun(id)!;
        const done = w.finished.has(probe.sha);
        const conclusion = w.verdicts.get(probe.sha);
        return { jobs: [{ id: id * 10, name: "ci", status: done ? "completed" : "in_progress", ...(done ? { conclusion } : {}) }] };
      }
      const run = historyOf(w).find((candidate) => candidate.id === id);
      return { jobs: [{ id: id * 10, name: "ci", status: "completed", conclusion: run?.conclusion ?? "failure" }] };
    }
    const commit = /^repos\/craigoley\/remudero\/commits\/([0-9a-f]{40})$/.exec(path)?.[1];
    if (commit) {
      const index = w.chain.indexOf(commit);
      return {
        parents: index > 0 ? [{ sha: w.chain[index - 1] }] : [],
        files: [{ filename: "src/lib/daemon.ts", additions: 9, deletions: 0 }],
      };
    }
    throw new Error(`unrouted gh api call: ${args.join(" ")}`);
  }) as GhApiFetcher;
  const issues: AsyncIssueGateway = {
    create: async () => `https://github.com/${OWNER}/${REPO}/issues/10801`,
    listOpen: async () => [],
    comment: async () => {},
    closeWithComment: async () => {},
  };
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath,
    runId: "DAEMON-BISECT",
    log: () => {},
    now: () => clock,
    readRequiredChecks: () => ["ci"],
    readCiFailures: (rollup) =>
      (rollup ?? []).map((entry): CiFailure => ({ name: entry.name ?? "", conclusion: "FAILURE", logTail: "not ok 3 - a ledger row names its run" })),
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

function fakeLane(): MainRepairLane & { fixes: MainRepairFixRequest[] } {
  const fixes: MainRepairFixRequest[] = [];
  return {
    fixes,
    openFixPr: async (request) => {
      fixes.push(request);
      return FIX_PR;
    },
    openRevertPr: async () => ({ refused: "not exercised" }),
  };
}

const rowsOf = (ledgerPath: string, step: string) => readLedgerLines(ledgerPath).filter((row) => row.step === step); // ledger-read-intent: live

function inScratchDir(body: (ledgerPath: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}bisect-`));
    try {
      await body(join(root, "ledger.ndjson"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const probedShas = (w: World): string[] =>
  w.requests.filter((request) => request.startsWith("POST git/refs")).map((request) => /rmd-attribution\/(\w{40})/.exec(request)![1]!);

test("W1-T7760: the first red never names a commit whose only run was cancelled", () => {
  const [c1, c2] = [sha("c1"), sha("c2")];
  const run = (headSha: string, conclusion: string): MainHealthRunHistoryEntry => ({ headSha, conclusion, status: "completed", workflowName: "CI", runId: 1 });
  // Newest first: R failure, C2 cancelled, C1 cancelled, G success. Counting a cancelled run as red named C1.
  const history = [run(RED, "failure"), run(c2, "cancelled"), run(c1, "cancelled"), run(GREEN, "success")];
  const boundary = mainHealthFirstRedCommitFromRunHistory(history, { firstParentOrder: [HEAD, RED, c2, c1, GREEN] });
  assert.ok(boundary && boundary !== "window-exhausted");
  assert.equal(boundary.headSha, RED, "the completed red, never a commit that only had a cancelled run");
  assert.equal(boundary.afterGreenSha, GREEN);
  assert.deepEqual(boundary.span, [c2, c1], "the cancelled commits between the last green and the red are the unattributed span");

  // Every commit between has a completed verdict: the span is empty and the red is the first red.
  const settled = [run(RED, "failure"), run(c1, "success"), run(GREEN, "success")];
  const empty = mainHealthFirstRedCommitFromRunHistory(settled, { firstParentOrder: [HEAD, RED, c1, GREEN] });
  assert.ok(empty && empty !== "window-exhausted");
  assert.deepEqual(empty.span, []);

  // Without main's first-parent chain the span is not claimed, empty or otherwise.
  const unread = mainHealthFirstRedCommitFromRunHistory(history);
  assert.ok(unread && unread !== "window-exhausted");
  assert.equal(unread.span, undefined);

  // Only a workflow that carries required checks can say a commit is green: CodeQL going green on C1 is not main green.
  const withCodeql = [
    run(RED, "failure"),
    { ...run(c2, "success"), workflowName: "CodeQL" },
    run(c1, "cancelled"),
    run(GREEN, "success"),
  ];
  const restricted = mainHealthFirstRedCommitFromRunHistory(withCodeql, {
    requiredWorkflows: new Set(["CI"]),
    firstParentOrder: [HEAD, RED, c2, c1, GREEN],
  });
  assert.ok(restricted && restricted !== "window-exhausted");
  assert.deepEqual(restricted.span, [c2, c1], "a green run of a workflow without required checks gives a commit no verdict");
});

test(
  "W1-T7760: a red main dispatches CI for the cancelled commits since the last green, newest first, each on its own ref",
  inScratchDir(async (ledgerPath) => {
    const w = world(2); // G, C1, C2 (both cancelled), R (first completed red), head
    const [c1, c2] = w.cancelled as [string, string];
    const lane = fakeLane();
    const daemon = rig(w, lane, ledgerPath);

    await daemon.observe();
    assert.deepEqual(probedShas(w), [c2], "the newest cancelled commit is probed first");
    assert.ok(w.refs.has(`refs/heads/rmd-attribution/${c2}`), "on a ref of its own");
    assert.equal(rowsOf(ledgerPath, "main.repair.located").length, 0, "nothing is named while the span is unproven");
    assert.equal(lane.fixes.length, 0, "no fix is dispatched for this red until the first red is proven");
    assert.equal(rowsOf(ledgerPath, "main.repair.unlocated").length, 0, "a bisection in flight is not an unlocated red");
    const [bisecting] = rowsOf(ledgerPath, "main.repair.bisecting");
    assert.deepEqual(bisecting?.span, [c2, c1]);
    assert.deepEqual(bisecting?.probe_shas, [c2]);

    // The same probe is not dispatched twice while it runs.
    await daemon.observe();
    assert.deepEqual(probedShas(w), [c2]);

    // C2's CI concludes red: C1 is next, on its own ref.
    w.verdicts.set(c2, "failure");
    w.finished.add(c2);
    await daemon.observe();
    assert.deepEqual(probedShas(w), [c2, c1], "newest first: C2, then C1");
    assert.ok(w.refs.has(`refs/heads/rmd-attribution/${c1}`));
    assert.ok(!w.refs.has(`refs/heads/rmd-attribution/${c2}`), "a concluded probe's ref is deleted");
    assert.equal(lane.fixes.length, 0);
  }),
);

test(
  "W1-T7760: a probe never re-runs a cancelled push run and never dispatches at main",
  inScratchDir(async (ledgerPath) => {
    const w = world(3);
    const lane = fakeLane();
    const daemon = rig(w, lane, ledgerPath);
    for (let pass = 0; pass < 6; pass += 1) {
      await daemon.observe();
      // Whatever is in flight finishes green: the walk then proves R, and the lane stops probing.
      for (const probe of w.probes.values()) {
        w.verdicts.set(probe.sha, "success");
        w.finished.add(probe.sha);
      }
    }
    assert.ok(w.requests.length > 0);
    assert.ok(!w.requests.some((request) => /\/rerun|rerun-failed-jobs/.test(request)), `no push run is re-run in place: ${w.requests.join(" | ")}`);
    const dispatches = w.requests.filter((request) => request.includes("/dispatches"));
    assert.ok(dispatches.length > 0);
    for (const request of dispatches) {
      assert.match(request, /ref=rmd-attribution\/[0-9a-f]{40}$/, "a dispatch names a probe ref");
      assert.ok(!/ref=(refs\/heads\/)?main\b/.test(request), `never main's concurrency group: ${request}`);
    }
    for (const request of w.requests.filter((r) => r.startsWith("POST git/refs"))) {
      assert.match(request, /ref=refs\/heads\/rmd-attribution\/[0-9a-f]{40} sha=[0-9a-f]{40}$/);
    }
  }),
);

test(
  "W1-T7760: main.repair.located names the bisected first red, proven by completed runs",
  inScratchDir(async (ledgerPath) => {
    const w = world(2);
    const [c1, c2] = w.cancelled as [string, string];
    const lane = fakeLane();
    const daemon = rig(w, lane, ledgerPath);
    // C2 is red and C1 green: the first red is C2 -- not the completed red R after it, and not a cancelled C1.
    w.verdicts.set(c2, "failure");
    w.verdicts.set(c1, "success");
    await daemon.observe();
    w.finished.add(c2);
    await daemon.observe();
    assert.equal(rowsOf(ledgerPath, "main.repair.located").length, 0, "C2 is red, but its parent C1 has no verdict yet");
    w.finished.add(c1);
    await daemon.observe();

    const [located] = rowsOf(ledgerPath, "main.repair.located");
    assert.ok(located, "the first red is proven, so it is located");
    assert.equal(located.offending_sha, c2);
    assert.equal(located.method, "bisected-first-red");
    assert.equal(located.bisection_of, RED);
    assert.equal(located.parent_sha, c1, "its first parent is a completed green");
    const evidence = located.probe_runs as Array<{ sha: string; verdict: string; run_url: string }>;
    assert.deepEqual(
      evidence.slice(0, 2).map((e) => [e.sha, e.verdict]),
      [
        [c2, "red"],
        [c1, "green"],
      ],
    );
    assert.match(evidence[0]!.run_url, /\/actions\/runs\/50\d\d$/, "the probe run's url is the evidence");
    assert.equal(lane.fixes.length, 1);
    assert.equal(lane.fixes[0]!.offendingSha, c2, "the fix goes at the bisected first red");
    const concluded = rowsOf(ledgerPath, "main.repair.probe_concluded");
    assert.deepEqual(concluded.map((row) => [row.probe_sha, row.verdict]), [[c2, "red"], [c1, "green"]]);
    assert.ok(concluded.every((row) => typeof row.run_url === "string"));
    assert.equal(rowsOf(ledgerPath, "main.repair.unlocated").length, 0);

    // A later pass does not probe again or fix again.
    const before = w.requests.length;
    await daemon.observe();
    assert.equal(lane.fixes.length, 1);
    assert.equal(w.requests.length, before);
  }),
);

test(
  "W1-T7760: main.repair.located names the completed red itself when every cancelled commit probes green",
  inScratchDir(async (ledgerPath) => {
    const w = world(1);
    const [c1] = w.cancelled as [string];
    w.verdicts.set(c1, "success");
    const lane = fakeLane();
    const daemon = rig(w, lane, ledgerPath);
    await daemon.observe();
    w.finished.add(c1);
    await daemon.observe();
    const [located] = rowsOf(ledgerPath, "main.repair.located");
    assert.equal(located?.offending_sha, RED);
    assert.equal(located?.method, "bisected-first-red");
    assert.equal(located?.parent_sha, c1);
    assert.equal(lane.fixes.length, 1);
  }),
);

test(
  "W1-T7760: probes in flight follow observed runner availability and run cost, not a constant",
  inScratchDir(async (ledgerPath) => {
    // The same span of 7 cancelled commits under two readings of the runners.
    const busy = world(7);
    busy.queued = 3; // jobs are waiting for a runner
    busy.idle = 5;
    const idle = world(7);
    idle.queued = 0;
    idle.idle = 4;
    await rig(busy, fakeLane(), `${ledgerPath}.busy`).observe();
    await rig(idle, fakeLane(), `${ledgerPath}.idle`).observe();
    assert.equal(probedShas(busy).length, 1, "one at a time while any CI job waits for a runner");
    assert.equal(probedShas(idle).length, 4, "as many as the idle capacity read when none waits");
    assert.deepEqual(probedShas(idle), [...idle.cancelled].reverse().slice(0, 4), "newest first");
    const [busyRow] = rowsOf(`${ledgerPath}.busy`, "main.repair.bisecting");
    const [idleRow] = rowsOf(`${ledgerPath}.idle`, "main.repair.bisecting");
    assert.equal(busyRow?.concurrency, 1);
    assert.deepEqual(busyRow?.concurrency_reading, { queued_jobs: 3, idle_runners: 5 });
    assert.equal(idleRow?.concurrency, 4);
    assert.deepEqual(idleRow?.concurrency_reading, { queued_jobs: 0, idle_runners: 4 });

    // Each probe is priced at the median duration of main's completed CI runs in the history read (30 min).
    assert.equal(idleRow?.median_run_ms, 30 * minute);
    assert.equal(idleRow?.estimated_runner_minutes, Number(idleRow?.estimated_probes) * 30);
    assert.ok(Number(idleRow?.estimated_probes) > 0);

    // A long span is probed at split points, not walked: the cost of the walk is read against the bisection's.
    const long = world(31);
    long.idle = 1;
    await rig(long, fakeLane(), `${ledgerPath}.long`).observe();
    assert.deepEqual(probedShas(long), [long.cancelled[15]], "the middle of the span, not its newest commit");
    const [longRow] = rowsOf(`${ledgerPath}.long`, "main.repair.bisecting");
    assert.equal(longRow?.strategy, "split-points");
    assert.ok(Number(longRow?.estimated_probes) < Number(longRow?.alternative_probes));
  }),
);

test("W1-T7760: probe concurrency, price and strategy are readings, never constants", () => {
  assert.equal(chooseProbeConcurrency({ queuedJobs: 1, idleRunners: 9 }), 1);
  assert.equal(chooseProbeConcurrency({ queuedJobs: 0, idleRunners: 9 }), 9);
  assert.equal(chooseProbeConcurrency({ queuedJobs: 0, idleRunners: 0 }), 1);
  const run = (startedAt: string, completedAt: string, conclusion = "success"): MainHealthRunHistoryEntry => ({
    headSha: sha("a"),
    conclusion,
    status: "completed",
    startedAt,
    completedAt,
  });
  assert.equal(
    medianCiRunMs([run(at(0), at(10)), run(at(0), at(50)), run(at(0), at(30)), run(at(0), at(500), "cancelled")]),
    30 * minute,
    "a cancelled run's duration prices nothing",
  );
  assert.equal(medianCiRunMs([]), undefined);

  const span = Array.from({ length: 12 }, (_, i) => sha(`d${i}`)); // newest first
  const none = new Map<string, MainProbeVerdict>();
  const small = planMainBisection({ green: GREEN, red: RED, span: span.slice(0, 2), verdicts: none, inFlight: new Set(), concurrency: 1 });
  assert.ok(small.state === "probe" && small.strategy === "linear-newest-first" && small.shas[0] === span[0]);
  const wide = planMainBisection({ green: GREEN, red: RED, span, verdicts: none, inFlight: new Set(), concurrency: 1 });
  assert.ok(wide.state === "probe" && wide.strategy === "split-points" && wide.shas.length === 1);
  const waiting = planMainBisection({ green: GREEN, red: RED, span, verdicts: none, inFlight: new Set([span[5]!]), concurrency: 1 });
  assert.ok(waiting.state === "probe" && waiting.strategy === "wait" && waiting.shas.length === 0, "no free slot: nothing new starts");
  const proven = planMainBisection({
    green: GREEN,
    red: RED,
    span: span.slice(0, 3),
    verdicts: new Map<string, MainProbeVerdict>([
      [span[2]!, "green"],
      [span[1]!, "red"],
    ]),
    inFlight: new Set(),
    concurrency: 1,
  });
  assert.deepEqual(proven, { state: "proven", offendingSha: span[1]!, parentSha: span[2]! });
});

test(
  "W1-T7760: a probe that cannot be dispatched leaves the red unlocated, never named",
  inScratchDir(async (ledgerPath) => {
    const w = world(2);
    w.refuseDispatch = true;
    const lane = fakeLane();
    await rig(w, lane, ledgerPath).observe();
    assert.equal(lane.fixes.length, 0);
    assert.equal(rowsOf(ledgerPath, "main.repair.located").length, 0);
    const [unlocated] = rowsOf(ledgerPath, "main.repair.unlocated");
    assert.match(String(unlocated?.reason), /no probe could be dispatched/);
  }),
);

test("W1-T7760: the located writer refuses a sha with no completed red run", () => {
  const cancelled = sha("c1");
  const history: MainHealthRunHistoryEntry[] = [
    { headSha: cancelled, conclusion: "cancelled", status: "completed", runId: 1 },
    { headSha: RED, conclusion: "failure", status: "completed", runId: 2 },
    { headSha: GREEN, conclusion: "success", status: "completed", runId: 3 },
  ];
  assert.match(locatedWriterRefusal(cancelled, history) ?? "", /no completed run whose required checks concluded red/);
  assert.match(locatedWriterRefusal(sha("ff"), history) ?? "", /no run in main's push run history/);
  assert.match(locatedWriterRefusal(GREEN, history) ?? "", /no completed run whose required checks concluded red/);
  assert.equal(locatedWriterRefusal(RED, history), undefined, "a completed red may be named");
  assert.equal(locatedWriterRefusal(cancelled, history, new Map<string, MainProbeVerdict>([[cancelled, "red"]])), undefined, "a concluded red probe may be named");
  assert.match(locatedWriterRefusal(cancelled, history, new Map<string, MainProbeVerdict>([[cancelled, "green"]])) ?? "", /no completed run/);
});
