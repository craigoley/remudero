// test/board-prewarm-does-not-block.test.ts — W1-T2440: the board pre-warm's real walk moves off
// the request-serving thread.
//
// THE DEFECT THIS PINS. `GitHub.warm?(): void` (lib/status.ts) is a fire-and-forget hook
// `lib/serve.ts`'s `prewarmBoardGithub` calls on a `setInterval`, and both real gateways shell
// `gh` through `execFileSync` — SYNCHRONOUS, and this module's own `GH_CALL_TIMEOUT_MS` doc
// already names it as parking the whole process for the call's duration. Before this task,
// `warm()` called `index()`/`issueIndex()` directly, so a scheduled warm's walk ran on the SAME
// thread that serves `GET /v1/status`, and a request arriving mid-walk queued behind it.
//
// THE FIX THIS PINS. `warm()`'s real (unconfigured) default now runs the walk on a separate
// `worker_threads.Worker` (`runPrewarmWorker`, lib/status.ts) instead of inline — same cadence,
// same `GH_CALL_TIMEOUT_MS` bound, same `fetchBoardPrsRest`/`fetchLabelledIssuesRest` walk
// (reused unchanged, never a second implementation), just off this thread. `openRows`/
// `mergedRows`/`issueIndex` serve the existing cache instead of racing the worker with a second
// synchronous fetch while one of these background walks is in flight.
//
// A REAL, FAKE `gh`. These tests exercise the actual worker path (never `opts.exec`/
// `opts.fetchAll`, which stay on today's synchronous path — see `warm()`'s own doc for why a
// Worker cannot receive an injected closure), pointed at a throwaway executable via the new
// `ghBin` option so no real `gh` binary or network is required, while still proving REAL
// OS-level concurrency: the fake binary sleeps, and the assertions below are wall-clock timings
// on the SAME process — exactly the falsifier the task names ("a same-process observation shows
// whether they queued").

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildBatchedGithub, GH_CALL_TIMEOUT_MS, type GitHub } from "../src/lib/status.js";
import { gatePrewarmOnClients, DEFAULT_BOARD_PREWARM_MS } from "../src/lib/serve.js";
import type { SseRoute, SseSend } from "../src/lib/service.js";

const GH_SLEEP_MS = 250;

/**
 * A real, tiny executable standing in for `gh` — sleeps (so the walk actually costs wall clock
 * time, the only way to prove non-blocking rather than assert it) and answers each REST call
 * from its own argv, exactly like the real `gh api …` calls `boardPrsRestArgs`/
 * `boardIssuesRestArgs` build. Every invocation appends one line to `counterFile`, so a test can
 * assert how many times it was actually called (claim: no second cache / no extra fetch).
 */
function writeFakeGh(dir: string, counterFile: string): string {
  const script = `#!/usr/bin/env bash
set -e
echo x >> ${JSON.stringify(counterFile)}
sleep ${(GH_SLEEP_MS / 1000).toFixed(3)}
args="$*"
if [[ "$args" == *"/issues?"* ]]; then
  echo '[]'
elif [[ "$args" == *"state=closed"* ]]; then
  cat <<'JSON'
[{"number":4242,"html_url":"https://github.com/o/r/pull/4242","state":"closed","merged":true,"body":"Remudero-Task: W1-T9999\\n","updated_at":"2026-08-01T00:00:00Z","head":{"ref":"run-W1-T9999-1","sha":"deadbeef"},"auto_merge":null,"title":"fix: a fixture row (W1-T9999)"}]
JSON
else
  echo '[]'
fi
`;
  const path = join(dir, "fake-gh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/** A `gh` that always exits non-zero — proving a worker-side failure is classified, never swallowed. */
function writeFailingGh(dir: string): string {
  const script = `#!/usr/bin/env bash\nsleep ${(GH_SLEEP_MS / 1000).toFixed(3)}\necho "boom: bad credentials" >&2\nexit 1\n`;
  const path = join(dir, "fake-gh-fail");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/**
 * A `gh` whose "open" answer changes ACROSS INVOCATIONS — PR #100 open on the FIRST `state=open`
 * call, gone (merged/closed elsewhere) on every call after — so a SECOND `warm()` cycle can prove
 * `applyOpenOutcome`'s own cross-half invalidation branch (W1-T2323's "a PR leaving `open` IS the
 * merge, observed" reasoning, replayed for the async path) fires off-thread exactly like it
 * already does on the synchronous path. `closed`/`issues` answers stay fixed every call;
 * `closedCounterFile` counts `state=closed` invocations so a test can prove the invalidation
 * actually forced a REFETCH, never merely flip a flag nothing reads.
 */
function writeCrossInvalidationFakeGh(dir: string, openCounterFile: string, closedCounterFile: string): string {
  const script = `#!/usr/bin/env bash
set -e
args="$*"
if [[ "$args" == *"/issues?"* ]]; then
  echo '[]'
elif [[ "$args" == *"state=closed"* ]]; then
  echo x >> ${JSON.stringify(closedCounterFile)}
  cat <<'JSON'
[{"number":4242,"html_url":"https://github.com/o/r/pull/4242","state":"closed","merged":true,"body":"Remudero-Task: W1-T9999\\n","updated_at":"2026-08-01T00:00:00Z","head":{"ref":"run-W1-T9999-1","sha":"deadbeef"},"auto_merge":null,"title":"fix: a fixture row (W1-T9999)"}]
JSON
elif [[ "$args" == *"state=open"* ]]; then
  echo x >> ${JSON.stringify(openCounterFile)}
  n=$(wc -l < ${JSON.stringify(openCounterFile)})
  if [[ "$n" -eq 1 ]]; then
    cat <<'JSON'
[{"number":100,"html_url":"https://github.com/o/r/pull/100","state":"open","merged":false,"body":"","updated_at":"2026-08-01T00:00:00Z","head":{"ref":"feature-1","sha":"abc123"},"auto_merge":null,"title":"an open pr about to leave the open set"}]
JSON
  else
    echo '[]'
  fi
else
  echo '[]'
fi
`;
  const path = join(dir, "fake-gh-cross-invalidation");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function callCount(counterFile: string): number {
  try {
    return readFileSync(counterFile, "utf8").split("\n").filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000, stepMs = 15): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

test("W1-T2440: warm() returns immediately, and a request arriving during the walk is served without waiting for it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-prewarm-"));
  const counterFile = join(dir, "calls.log");
  const ghBin = writeFakeGh(dir, counterFile);
  const gh: GitHub = buildBatchedGithub("o", "r", { ghBin });

  const t0 = Date.now();
  gh.warm?.();
  const warmReturnedAfterMs = Date.now() - t0;
  assert.ok(
    warmReturnedAfterMs < GH_SLEEP_MS,
    `warm() must return before its walk's own gh calls do (fake gh sleeps ${GH_SLEEP_MS}ms; warm() took ${warmReturnedAfterMs}ms) — it held the thread`,
  );

  // A "request" arriving WHILE the walk is in flight — same claim, from the other side: it must
  // be served off the existing (here: empty, pre-fetch) cache, not park behind the walk.
  const t1 = Date.now();
  const openBranches = gh.listOpenHeadBranches?.();
  const queryAnsweredAfterMs = Date.now() - t1;
  assert.ok(
    queryAnsweredAfterMs < GH_SLEEP_MS,
    `a query arriving mid-warm must not block on the walk (took ${queryAnsweredAfterMs}ms against a ${GH_SLEEP_MS}ms fake gh call)`,
  );
  assert.deepEqual(openBranches, [], "before the walk lands, the cold-cache answer is an empty list, never a hang");
  assert.equal(gh.readState?.(), "in_flight", "the in-flight window must be OBSERVABLE, not merely fast");

  // The walk really does run, and really does finish — it moved thread, not disappeared.
  await waitUntil(() => gh.readState?.() !== "in_flight");
  assert.equal(gh.readState?.(), "ok", "the background walk must still land a real, successful read");
  assert.equal(gh.readFailed?.(), false);

  // claim: "the fields the board reads from a walked row are unchanged" — the SAME BatchedPr
  // shape (number/url/state/headRefName/body/title) a synchronous walk has always produced.
  const merged = gh.findMergedByTrailer("W1-T9999");
  assert.ok(merged, "the merged fixture row must be found through the async walk's result");
  assert.equal(merged?.number, 4242);
  assert.equal(merged?.url, "https://github.com/o/r/pull/4242");
  assert.equal(merged?.state, "MERGED");
  assert.equal(merged?.headRefName, "run-W1-T9999-1");
  assert.equal(merged?.title, "fix: a fixture row (W1-T9999)");

  // claim: "nothing added introduces a second cache" — the async walk populated the SAME cache
  // the synchronous on-demand path already reads: a repeat query costs zero additional gh calls.
  const callsAfterWarm = callCount(counterFile);
  assert.equal(callsAfterWarm, 3, "one call each for open/closed/issues — the SAME three the synchronous path always made");
  gh.findMergedByTrailer("W1-T9999");
  gh.prByRef("https://github.com/o/r/pull/4242");
  assert.equal(callCount(counterFile), callsAfterWarm, "a query after the warm lands must add ZERO fetches — no second cache, no re-walk");
});

test("W1-T2440: a worker-side gh failure is classified, never silently swallowed (the W1-T181 discipline, replayed off-thread)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-prewarm-fail-"));
  const ghBin = writeFailingGh(dir);
  const gh: GitHub = buildBatchedGithub("o", "r", { ghBin });

  gh.warm?.();
  await waitUntil(() => gh.readState?.() !== "in_flight" && gh.readState?.() !== "not_attempted");
  assert.equal(gh.readState?.(), "failed");
  assert.equal(gh.readFailed?.(), true);
  assert.equal(gh.readFailureReason?.(), "auth", "the worker's classification must reach the main thread, not just an opaque failure flag");
});

test("W1-T2440: a PR leaving the open set mid-warm invalidates the merged cache too (cross-half invalidation, replayed off-thread)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-prewarm-xinv-"));
  const openCounterFile = join(dir, "open-calls.log");
  const closedCounterFile = join(dir, "closed-calls.log");
  const ghBin = writeCrossInvalidationFakeGh(dir, openCounterFile, closedCounterFile);
  // The open half expires on every access (ttlMs: 0); the merged half is given a deliberately
  // huge TTL of its own so any merged refetch below can ONLY come from the cross-half
  // invalidation this test pins, never from the merged clock also happening to expire.
  const gh: GitHub = buildBatchedGithub("o", "r", { ghBin, ttlMs: 0, mergedTtlMs: 1_000_000_000 });

  gh.warm?.();
  await waitUntil(() => gh.readState?.() !== "in_flight");
  assert.equal(gh.readState?.(), "ok");
  assert.equal(callCount(openCounterFile), 1, "the first walk's own open fetch");
  assert.equal(callCount(closedCounterFile), 1, "the first walk's own merged fetch");

  // Second cycle: PR #100 has left the open set (the fake `gh` now answers empty for it). The
  // open half is due again (ttlMs: 0); the merged half is NOT (its own TTL is nowhere near
  // expiry) — `runPrewarmWorker` asks for open+issues only this time, so any merged refetch that
  // follows can only be this task's own invalidation, never the merged half's own clock.
  gh.warm?.();
  await waitUntil(() => gh.readState?.() !== "in_flight");
  assert.equal(callCount(openCounterFile), 2, "the second open call really ran");
  assert.equal(gh.readState?.(), "ok", "the walk that DID run still landed a real, successful read");

  // The invalidation is only OBSERVABLE through a later merged read forcing a refetch — querying
  // through the same union index every real caller (findMergedByTrailer) uses.
  const merged = gh.findMergedByTrailer("W1-T9999");
  assert.ok(merged, "the merged fixture row must still resolve after the invalidated refetch");
  assert.equal(
    callCount(closedCounterFile),
    2,
    "PR #100 leaving `open` must force a merged refetch even though the merged TTL alone would not have — the W1-T2323 invalidation, replayed off-thread",
  );
});

test("W1-T2440: if the Worker itself cannot even be constructed, warm() falls back to a synchronous walk that still honours ghBin (never a differently-configured gh)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-prewarm-spawnfail-"));
  const counterFile = join(dir, "calls.log");
  const ghBin = writeFakeGh(dir, counterFile);
  const gh: GitHub = buildBatchedGithub("o", "r", { ghBin });

  // A REAL, deterministic way to make `new Worker(...)` throw SYNCHRONOUSLY, never a mocked
  // constructor: Node's worker_threads validates `execArgv` against an allow-list and throws
  // `ERR_WORKER_INVALID_EXEC_ARGV` for a flag outside it — `runPrewarmWorker` passes
  // `process.execArgv` straight through unmodified, so mutating the REAL, live global array
  // (never anything internal to status.ts) reproduces the exact failure this fallback exists
  // for. Pushed and popped around the ONE synchronous call that can observe it.
  process.execArgv.push("--this-flag-does-not-exist-w1-t2440");
  try {
    gh.warm?.();
  } finally {
    process.execArgv.pop();
  }

  // The fallback runs FULLY SYNCHRONOUSLY (a blocking execFileSync, exactly like the pre-worker
  // path) — no waitUntil needed; readState is already settled the instant warm() returns.
  assert.equal(gh.readState?.(), "ok", "the fallback still lands a real, successful read");
  assert.equal(
    callCount(counterFile),
    3,
    "the fallback walked all three channels through the SAME fake ghBin this gateway was built with, never a real gh",
  );
});

test("W1-T2440: if a spawned worker crashes, every channel it was asked for is classified failed — a genuine crash, never a mocked EventEmitter standing in for one", async () => {
  // `workerUrl` is the TEST-ONLY seam this task adds beside `ghBin` (see its own doc in
  // status.ts) — pointed at a `data:` script that does nothing but throw, so `new Worker(...)`
  // constructs SUCCESSFULLY and the crash happens for real, inside an ACTUAL separate thread,
  // milliseconds later. `ghBin` is omitted: this crashing script never reads `workerData` at
  // all, so nothing ever shells a `gh` binary, real or fake, in this test.
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent("throw new Error('W1-T2440 fixture: a genuinely crashed worker');")}`);
  const gh: GitHub = buildBatchedGithub("o", "r", { workerUrl });

  gh.warm?.();
  await waitUntil(() => gh.readState?.() !== "in_flight" && gh.readState?.() !== "not_attempted");
  assert.equal(gh.readState?.(), "failed", "a crashed worker must classify as a failed read, never silently stay ok/not_attempted");
  assert.equal(gh.readFailed?.(), true);
  assert.equal(
    gh.readFailureReason?.(),
    "unknown",
    "an uncaught worker crash carries no per-channel gh classification to report — 'unknown' is the honest reading, never a guess",
  );
});

test("W1-T2440: the refresh cadence and the call bound are both unchanged", () => {
  assert.equal(DEFAULT_BOARD_PREWARM_MS, 15_000, "the pre-warm's own cadence — this task changes WHERE the walk runs, never how often");
  assert.equal(GH_CALL_TIMEOUT_MS, 60_000, "the per-call bound — already sized so it cannot fire on a healthy call; untouched by this task");
});

test("W1-T2440: the zero-viewer gate still stops the timer when the last client leaves", async () => {
  const INTERVAL = 20;
  const SEND: SseSend = () => {};
  let warms = 0;
  const github = { warm: () => { warms += 1; }, prByRef: () => null, findMergedByTrailer: () => null } as unknown as GitHub;
  const route: SseRoute = {
    path: "/v1/status/stream",
    scope: "read",
    subscribe: () => () => {},
  };
  const gated = gatePrewarmOnClients(route, github, INTERVAL);
  assert.equal(warms, 0, "no client connected yet -- warm() must never fire (gatePrewarmOnClients's own contract, unchanged by this task)");
  const release = gated.route.subscribe(SEND);
  assert.equal(warms, 1, "first connect warms once immediately");
  release();
  const afterDisconnect = warms;
  await new Promise((resolve) => setTimeout(resolve, INTERVAL * 3 + INTERVAL / 2));
  assert.equal(warms, afterDisconnect, "the timer must stop once the last viewer disconnects -- no warm()s after that point");
  gated.stop();
});
