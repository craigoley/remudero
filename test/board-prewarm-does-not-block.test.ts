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
//
// ROUND 2 — TWO MORE TESTABILITY SEAMS, NEITHER A REAL WORKER. Round 1's own diff-coverage
// failure showed a real spawned `Worker`'s V8 coverage profile is not reliably merged back into a
// CI run's lcov (every line inside the worker-only gate read "uncovered" there despite the two
// tests above exercising it end to end through an actual worker — the same assertions, run
// locally outside CI's own concurrency, passed with full coverage). Two changes fix that at the
// SOURCE rather than fighting the collector:
//   1. `runPrewarmWorkerBody` (lib/status.ts) — the worker's entire body, now a top-level exported
//      function callable directly, ON THIS THREAD, with a real (but fake) `gh` via `ghBin`. Its
//      own coverage no longer depends on a real thread's profile being collected at all.
//   2. `opts.workerFactory` (lib/status.ts) — how `runPrewarmWorker` obtains its worker HANDLE.
//      Defaults to a real `Worker`; a test below injects a synthetic one (`once`/`terminate`, the
//      only two members `runPrewarmWorker` calls) to reach the spawn-failure fallback and the
//      worker `"error"` handler deterministically, and to replay a crafted `"message"` sequence
//      for the cross-half invalidation — none of which need a real OS thread to prove.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildBatchedGithub,
  runPrewarmWorkerBody,
  BOARD_PREWARM_WORKER_KIND,
  GH_CALL_TIMEOUT_MS,
  type GitHub,
  type PrewarmWorkerHandle,
  type PrewarmWorkerRequest,
  type PrewarmWorkerResponse,
} from "../src/lib/status.js";
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
 * Same fake `gh` shape as `writeFakeGh`, but written to a file literally named `gh` (not
 * `fake-gh`) so a `PATH` override can shadow the real binary. Needed ONLY by the spawn-failure
 * fallback test below: that fallback runs TODAY's synchronous `index()`/`issueIndex()`, which is
 * hardcoded to shell literal `"gh"` (see lib/status.ts) rather than `opts.ghBin` — `ghBin` only
 * threads through the WORKER's own request, never the pre-existing synchronous path this task
 * deliberately leaves untouched as the fallback's own behaviour.
 */
function writeFakeGhAsLiteralGh(dir: string, counterFile: string): void {
  const script = `#!/usr/bin/env bash
set -e
echo x >> ${JSON.stringify(counterFile)}
sleep ${(GH_SLEEP_MS / 1000).toFixed(3)}
echo '[]'
`;
  const path = join(dir, "gh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

/** A minimal `BoardPrRest`-shaped fixture row — only the fields `applyOpenOutcome`'s cross-half
 *  invalidation test below reads (`number`, `state`); the rest are present because the field is
 *  required, never because this test inspects them. */
function fakePr(number: number, state: string): {
  number: number;
  url: string;
  state: string;
  headRefName: string;
  body: string;
  autoMergeRequest: unknown;
  title: string;
  updatedAt: string;
} {
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    state,
    headRefName: `run-x-${number}`,
    body: "",
    autoMergeRequest: null,
    title: `pr ${number}`,
    updatedAt: "2026-08-01T00:00:00Z",
  };
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

test("W1-T2440 round 2: runPrewarmWorkerBody (the worker's own body, extracted) is directly callable on the main thread — no real Worker required to prove its plumbing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-prewarm-body-"));
  const counterFile = join(dir, "calls.log");
  const ghBin = writeFakeGh(dir, counterFile);
  const req: PrewarmWorkerRequest = {
    kind: BOARD_PREWARM_WORKER_KIND,
    owner: "o",
    repo: "r",
    ghBin,
    fetchOpen: true,
    fetchMerged: true,
    fetchIssues: true,
  };

  const response = runPrewarmWorkerBody(req);

  assert.equal(response.open?.ok, true, "the open channel must succeed against the fake gh");
  assert.equal(response.merged?.ok, true, "the merged channel must succeed against the fake gh");
  assert.equal(response.issues?.ok, true, "the issues channel must succeed against the fake gh");
  if (response.merged?.ok) {
    assert.equal(response.merged.rows.length, 1, "the merged fixture row from the fake gh script");
    assert.equal(response.merged.rows[0]?.number, 4242);
  }
  assert.equal(callCount(counterFile), 3, "one real gh call per requested channel — the SAME plumbing a real worker uses, just invoked directly");
});

test("W1-T2440 round 2: runPrewarmWorkerBody classifies a failing channel instead of throwing, and skips a channel nobody asked for (called directly, no worker)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-prewarm-body-fail-"));
  const ghBin = writeFailingGh(dir);
  const req: PrewarmWorkerRequest = {
    kind: BOARD_PREWARM_WORKER_KIND,
    owner: "o",
    repo: "r",
    ghBin,
    fetchOpen: true,
    fetchMerged: false,
    fetchIssues: false,
  };

  const response = runPrewarmWorkerBody(req);

  assert.equal(response.open?.ok, false, "a failing gh must classify, never throw out of this function (the W1-T181 discipline)");
  assert.equal(response.merged, undefined, "a channel nobody asked for is never attempted");
  assert.equal(response.issues, undefined, "a channel nobody asked for is never attempted");
  if (response.open && !response.open.ok) {
    assert.equal(response.open.reason, "auth");
  }
});

test("W1-T2440 round 2: a worker spawn failure falls back to TODAY's synchronous warm — deterministically, no real worker_threads involved", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-prewarm-spawnfail-"));
  const counterFile = join(dir, "calls.log");
  writeFakeGhAsLiteralGh(dir, counterFile);
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath ?? ""}`;
  try {
    const gh: GitHub = buildBatchedGithub("o", "r", {
      workerFactory: () => {
        throw new Error("worker_threads unavailable (synthetic)");
      },
    });

    gh.warm?.();
    // The fallback runs `index()`/`issueIndex()` SYNCHRONOUSLY, inline, inside `warm()` itself —
    // by the time `warm()` returns the read has already landed, unlike the real-worker path above.
    assert.equal(gh.readState?.(), "ok", "the fallback must still complete a real read through today's synchronous path, not silently drop it");
    assert.equal(gh.readFailed?.(), false);
    assert.ok(callCount(counterFile) > 0, "the fallback actually shelled the (PATH-shadowed) gh — it is not a no-op degradation");
  } finally {
    process.env.PATH = savedPath;
  }
});

test("W1-T2440 round 2: the worker's own 'error' event marks every requested channel failed — deterministically, no real worker crash needed", () => {
  let errorListener: ((err: Error) => void) | undefined;
  const handle: PrewarmWorkerHandle = {
    once: (event, listener) => {
      if (event === "error") errorListener = listener as (err: Error) => void;
      return undefined;
    },
    terminate: () => undefined,
  };
  const gh: GitHub = buildBatchedGithub("o", "r", {
    workerFactory: () => handle,
  });

  gh.warm?.();
  assert.equal(gh.readState?.(), "in_flight", "the worker handle was handed out -- the call is genuinely in flight until it answers");
  assert.ok(errorListener, "runPrewarmWorker must register an 'error' listener on whatever handle opts.workerFactory returns");
  errorListener?.(new Error("worker crashed (synthetic)"));

  assert.equal(gh.readState?.(), "failed", "a worker 'error' must mark the read failed, never leave it hanging forever");
  assert.equal(gh.readFailed?.(), true);
  assert.equal(
    gh.readFailureReason?.(),
    "unknown",
    "an 'error' event carries no gh-classified reason -- 'unknown', not a per-channel classification it never received (the W1-T181 'loud, classified, never silent' discipline)",
  );
});

test("W1-T2440 round 2: a PR leaving the open set invalidates the merged half off the request-serving thread too (W1-T2323's cross-half invalidation, replayed through the worker path)", () => {
  let t = 0;
  const now = (): number => t;
  const reqs: PrewarmWorkerRequest[] = [];
  let messageListener: ((msg: PrewarmWorkerResponse) => void) | undefined;
  const gh: GitHub = buildBatchedGithub("o", "r", {
    now,
    ttlMs: 100,
    workerFactory: (req) => {
      reqs.push(req);
      return {
        once: (event, listener) => {
          if (event === "message") messageListener = listener as (msg: PrewarmWorkerResponse) => void;
          return undefined;
        },
        terminate: () => undefined,
      };
    },
  });

  // Call 1 — cold start, everything due. PR #10 comes back OPEN.
  gh.warm?.();
  assert.equal(reqs.length, 1);
  assert.deepEqual([reqs[0]?.fetchOpen, reqs[0]?.fetchMerged, reqs[0]?.fetchIssues], [true, true, true]);
  messageListener?.({
    open: { ok: true, rows: [fakePr(10, "OPEN")], truncated: false, bytes: 0, calls: 1, mode: "full" },
    merged: { ok: true, rows: [], truncated: false, bytes: 0, calls: 1, mode: "full" },
    issues: { ok: true, rows: [], truncated: false, bytes: 0, calls: 1, mode: "full" },
  });

  // Call 2 — past the TTL, open is due again. PR #10 is GONE from the new open set (merged or
  // closed) — the response answers `open` ONLY, proving the invalidation lives inside
  // `applyOpenOutcome` itself, never depending on a `merged` outcome arriving in the same message.
  t += 1000;
  gh.warm?.();
  assert.equal(reqs.length, 2);
  messageListener?.({ open: { ok: true, rows: [], truncated: false, bytes: 0, calls: 1, mode: "delta" } });

  // Call 3 — immediately after, same clock tick: open was JUST refreshed (not due on TTL grounds),
  // but merged must be due anyway, because the invalidation cleared it. This is the observable
  // proof: the request THIS call sends asks for merged again, off-TTL.
  gh.warm?.();
  assert.equal(reqs.length, 3);
  assert.equal(reqs[2]?.fetchOpen, false, "open was just refreshed this same tick — not due on TTL grounds");
  assert.equal(
    reqs[2]?.fetchMerged,
    true,
    "merged must be re-requested — PR #10 leaving the open set invalidated the merged half, exactly like the synchronous path (W1-T2323)",
  );
});
