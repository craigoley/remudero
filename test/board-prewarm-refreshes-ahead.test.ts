// test/board-prewarm-refreshes-ahead.test.ts — `rmd serve` stalled its whole event loop for ~6 s
// every 2.5-3 minutes (2026-09-24). A CPU profile across one stall named GET /v1/status ->
// computeBoardSnapshot walking GitHub SYNCHRONOUSLY: the open, merged and issue halves through
// paceGhEntry's blocking sleep, then one combined-status `gh` call per open PR (reviewState).
//
// The prewarm worker (W1-T2440) exists to keep that walk off the serving thread, but serve warms on
// the SAME cadence as its TTL (150 s) and a warm only refreshed an ALREADY-expired channel. The
// worker stamps its result when it lands, so the next tick found the cache 150 s minus the walk's
// duration old — not due — and the next request found it expired and walked GitHub itself. Its
// serve ledger showed one worker refresh in five.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildBatchedGithub, postPrewarmWorkerResponse, type GitHub } from "../src/lib/status.js";

const OPEN_PR_URL = "https://github.com/o/r/pull/7";

/** A stand-in `gh` answering the board's REST reads from argv, one counter line per invocation. */
function writeBoardGh(dir: string, counterFile: string): string {
  const script = `#!/usr/bin/env bash
set -e
echo "$*" >> ${JSON.stringify(counterFile)}
args="$*"
if [[ "$args" == *"/issues?"* ]]; then
  echo '[]'
elif [[ "$args" == *"/commits/gone/status"* ]]; then
  exit 1
elif [[ "$args" == *"/commits/"*"/status"* ]]; then
  # The FIRST status read says success; every later one says failure, so a caller can tell a held value from a re-read.
  if [[ $(grep -c "/status" ${JSON.stringify(counterFile)}) -le 1 ]]; then state=success; else state=failure; fi
  printf '{"state":"%s","statuses":[{"context":"remudero-review","state":"%s"}]}\n' "$state" "$state"
elif [[ "$args" == *"state=open"* ]]; then
  cat <<'JSON'
[{"number":7,"html_url":"${OPEN_PR_URL}","state":"open","merged":false,"body":"","updated_at":"2026-09-24T00:00:00Z","head":{"ref":"run-unfiled-1","sha":"abc"},"auto_merge":null,"title":"an open pr"}]
JSON
else
  echo '[]'
fi
`;
  const path = join(dir, "board-gh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function calls(counterFile: string): string[] {
  try {
    return readFileSync(counterFile, "utf8").split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function settle(gh: GitHub): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (gh.readState?.() === "in_flight") {
    if (Date.now() >= deadline) throw new Error("the prewarm walk never landed");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function boardGateway(ttlMs: number): { gh: GitHub; counterFile: string; clock: { ms: number } } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-prewarm-ahead-"));
  const counterFile = join(dir, "calls.log");
  const clock = { ms: 0 };
  const gh = buildBatchedGithub("o", "r", { ghBin: writeBoardGh(dir, counterFile), ttlMs, prewarmLeadMs: ttlMs, now: () => clock.ms });
  return { gh, counterFile, clock };
}

test("a warm on the TTL cadence refreshes before expiry so a later read walks nothing on the serving thread", async () => {
  const { gh, counterFile, clock } = boardGateway(1_000);
  gh.warm?.();
  await settle(gh);
  // The next tick, one cadence later, lands a hair BEFORE the TTL: the walk stamped its result late.
  clock.ms = 999;
  gh.warm?.();
  await settle(gh);
  const afterWarms = calls(counterFile).length;
  // A request past the first walk's expiry, before the second's.
  clock.ms = 1_500;
  gh.listOpenHeadBranches?.();
  gh.readTruncated?.();
  gh.issueByUrl?.("https://github.com/o/r/issues/1");
  assert.deepEqual(calls(counterFile).slice(afterWarms), [], "a read inside the refreshed window must not shell gh on the serving thread");
});

test("the prewarm walk refreshes each open PR review state so a board recompute shells no status call", async () => {
  const { gh, counterFile, clock } = boardGateway(1_000);
  gh.warm?.();
  await settle(gh);
  clock.ms = 999;
  gh.warm?.();
  await settle(gh);
  assert.ok(calls(counterFile).some((c) => c.includes("/commits/run-unfiled-1/status")), "the worker read the open PR's combined status");
  const afterWarms = calls(counterFile).length;
  clock.ms = 1_500;
  assert.equal(gh.reviewState?.(OPEN_PR_URL), "success", "the worker's read, applied to the cache");
  assert.deepEqual(calls(counterFile).slice(afterWarms), [], "the review state must come from the warmed cache, not a synchronous gh call");
});

test("a review state being refreshed by the walk is served from its held value", async () => {
  const { gh, counterFile, clock } = boardGateway(1_000);
  gh.warm?.();
  await settle(gh);
  assert.equal(gh.reviewState?.(OPEN_PR_URL), "success", "first read ever: fetched on demand and cached");
  clock.ms = 5_000;
  gh.warm?.();
  assert.equal(gh.reviewState?.(OPEN_PR_URL), "success", "stale but in flight: the held value, never a second racing call");
  await settle(gh);
  assert.equal(gh.reviewState?.(OPEN_PR_URL), "failure", "once the walk lands, its fresh read replaces the held value");
});

test("the walk reads every review ref and leaves an unreadable one out rather than guessing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-prewarm-ahead-port-"));
  const posted: Array<{ reviews?: Array<[string, string]> }> = [];
  postPrewarmWorkerResponse({ postMessage: (v) => void posted.push(v as { reviews?: Array<[string, string]> }) }, {
    kind: "remudero-board-prewarm-walk",
    owner: "o",
    repo: "r",
    ghBin: writeBoardGh(dir, join(dir, "calls.log")),
    fetchOpen: false,
    fetchMerged: false,
    fetchIssues: false,
    reviewRefs: [
      { url: OPEN_PR_URL, headRef: "run-unfiled-1" },
      { url: "https://github.com/o/r/pull/8", headRef: "gone" },
    ],
  } as never);
  assert.deepEqual(posted[0]?.reviews, [[OPEN_PR_URL, "success"]]);
});

test("a walk that falls back to this thread still lands its review states in the cache", async () => {
  const { gh, counterFile, clock } = boardGateway(1_000);
  gh.warm?.();
  await settle(gh);
  clock.ms = 999;
  process.execArgv.push("--not-a-flag-the-worker-allows");
  try {
    gh.warm?.();
  } finally {
    process.execArgv.pop();
  }
  const afterWarms = calls(counterFile).length;
  clock.ms = 1_500;
  assert.equal(gh.reviewState?.(OPEN_PR_URL), "success");
  assert.deepEqual(calls(counterFile).slice(afterWarms), []);
});
