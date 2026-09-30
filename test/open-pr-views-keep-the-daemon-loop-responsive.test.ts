import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGhReadWarmer,
  fetchOpenPrsRest,
  hydrateWorkflowRuns,
  runsForHeadRestArgs,
  type GhApiFetcher,
} from "../src/lib/open-prs-rest.js";

// W1-T4773: a live profile of remudero-daemon on 2026-09-30 put the open-PR view build at about 55%
// of its busy loop time, all of it synchronous `gh` children. These tests drive the same two
// producers the daemon's sweep uses (the rollup enumeration and the workflow-run hydration) through
// the warmer, with a synchronous fake standing in for `ghJson` and an async fake for `ghJsonAsync`.

const OWNER = "o";
const REPO = "r";

function answer(args: string[]): unknown {
  const path = args[1] ?? "";
  if (path.includes("/pulls?state=open")) {
    return [
      { number: 1, html_url: "https://github.com/o/r/pull/1", updated_at: "t", head: { ref: "a", sha: "sha-1" } },
      { number: 2, html_url: "https://github.com/o/r/pull/2", updated_at: "t", head: { ref: "b", sha: "sha-2" } },
      { number: 3, html_url: "https://github.com/o/r/pull/3", updated_at: "t", head: { ref: "c", sha: "sha-3" } },
    ];
  }
  if (path.includes("/check-runs")) return { check_runs: [] };
  if (path.endsWith("/status")) return { statuses: [] };
  if (path.includes("/actions/runs?head_sha=")) return { workflow_runs: [{ conclusion: null }] };
  throw new Error(`unexpected read ${path}`);
}

function syncFake(): { fetch: GhApiFetcher; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    fetch: (args) => {
      reads.push(args[1] ?? "");
      return answer(args);
    },
  };
}

function asyncFake(): { read: (args: string[]) => Promise<unknown>; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    read: (args) =>
      new Promise((resolve) => {
        reads.push(args[1] ?? "");
        setTimeout(() => resolve(answer(args)), 1);
      }),
  };
}

function pass(fetch: GhApiFetcher, heads: { number: number; headRefOid: string }[]): void {
  fetchOpenPrsRest(OWNER, REPO, fetch);
  hydrateWorkflowRuns(OWNER, REPO, heads, fetch);
}

const HEADS = [
  { number: 1, headRefOid: "sha-1" },
  { number: 2, headRefOid: "sha-2" },
  { number: 3, headRefOid: "sha-3" },
];

test("W1-T4773: a timer keeps firing while open PR views hydrate", async () => {
  const net = asyncFake();
  const warmer = createGhReadWarmer(net.read);
  pass(warmer.fetcher(syncFake().fetch), HEADS);

  const live = syncFake();
  let ticks = 0;
  const ticker = setInterval(() => (ticks += 1), 0);
  try {
    const warmedCount = await warmer.warm();
    const ticksDuringWarm = ticks;
    pass(warmer.fetcher(live.fetch), HEADS);
    assert.equal(warmedCount, 9, "three heads × (check runs, status, workflow runs) were re-read off the loop");
    assert.ok(ticksDuringWarm > 0, `a timer fired ${ticksDuringWarm} times while the per-PR reads were in flight`);
  } finally {
    clearInterval(ticker);
  }
  assert.deepEqual(
    live.reads,
    ["repos/o/r/pulls?state=open&per_page=100"],
    "only the pacer-armed list read stays synchronous; every per-PR read was answered warm",
  );
});

test("W1-T4773: an unchanged head reuses its prior workflow run observation", async () => {
  const net = asyncFake();
  const warmer = createGhReadWarmer(net.read);
  hydrateWorkflowRuns(OWNER, REPO, [{ number: 1, headRefOid: "sha-1" }], warmer.fetcher(syncFake().fetch));
  await warmer.warm();

  const live = syncFake();
  const moved = hydrateWorkflowRuns(
    OWNER,
    REPO,
    [
      { number: 1, headRefOid: "sha-1" },
      { number: 2, headRefOid: "sha-2-moved" },
    ],
    warmer.fetcher(live.fetch),
  );
  assert.deepEqual(net.reads, [runsForHeadRestArgs(OWNER, REPO, "sha-1")[1]]);
  assert.deepEqual(live.reads, [runsForHeadRestArgs(OWNER, REPO, "sha-2-moved")[1]], "a moved head reads live");
  assert.deepEqual(moved.get(1), [{ conclusion: undefined }]);
  assert.deepEqual(moved.get(2), [{ conclusion: undefined }]);
});

test("W1-T4773: a warmed answer is taken once and a failed warm read falls back to the live read", async () => {
  const warmer = createGhReadWarmer(async (args) => {
    if ((args[1] ?? "").includes("sha-2")) throw new Error("gh exited 1");
    return answer(args);
  });
  hydrateWorkflowRuns(OWNER, REPO, HEADS.slice(0, 2), warmer.fetcher(syncFake().fetch));
  assert.equal(await warmer.warm(), 1);

  const live = syncFake();
  hydrateWorkflowRuns(OWNER, REPO, HEADS.slice(0, 2), warmer.fetcher(live.fetch));
  hydrateWorkflowRuns(OWNER, REPO, HEADS.slice(0, 1), warmer.fetcher(live.fetch));
  assert.deepEqual(live.reads, [
    runsForHeadRestArgs(OWNER, REPO, "sha-2")[1],
    runsForHeadRestArgs(OWNER, REPO, "sha-1")[1],
  ]);
});

test("W1-T4773: a read carrying a rate limit callback is never recorded or warmed", async () => {
  const net = asyncFake();
  const warmer = createGhReadWarmer(net.read, 0);
  fetchOpenPrsRest(OWNER, REPO, (args, onRateLimit) =>
    warmer.fetcher(syncFake().fetch)(args, onRateLimit ?? (() => undefined)),
  );
  assert.equal(await warmer.warm(), 0);
  assert.deepEqual(net.reads, []);
});
