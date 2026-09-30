// test/board-github-off-loop.test.ts (W1-T4771) — serve's board read must never shell gh on serve's event
// loop. Before this, a board read past the TTL, a first read, or a review-state read for a row the walk had not
// yet covered ran execFileSync and paceGhEntry's blocking sleep on the thread every console route shares.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeBoardSnapshot } from "../src/lib/board.js";
import { createGhCallPacer, createNonBlockingGhCallPacer, GhPaceWouldBlockError, paceGhEntry } from "../src/lib/github-transport.js";
import type { Plan } from "../src/lib/plan.js";
import { buildBatchedGithub, type GitHub } from "../src/lib/status.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

const OPEN_PR_URL = "https://github.com/o/r/pull/7";

function writeBoardGh(dir: string): string {
  const script = `#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"/issues?"* ]]; then
  echo '[]'
elif [[ "$args" == *"/commits/"*"/status"* ]]; then
  echo '{"state":"success","statuses":[{"context":"remudero-review","state":"success"}]}'
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

async function settle(gh: GitHub): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (gh.readState?.() === "in_flight") {
    if (Date.now() >= deadline) throw new Error("the prewarm walk never landed");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function offLoopGateway(ttlMs: number): { gh: GitHub; syncCalls: string[]; clock: { ms: number } } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-off-loop-"));
  const syncCalls: string[] = [];
  const clock = { ms: 0 };
  const gh = buildBatchedGithub("o", "r", {
    ghBin: writeBoardGh(dir),
    exec: (args) => {
      syncCalls.push(args.join(" "));
      throw new Error("a synchronous gh child ran on the serving thread");
    },
    ttlMs,
    now: () => clock.ms,
    offLoop: true,
  });
  return { gh, syncCalls, clock };
}

test("a due board github read on serve spawns no synchronous gh child", async () => {
  const { gh, syncCalls, clock } = offLoopGateway(1_000);

  assert.equal(gh.listOpenHeadBranches?.(), null, "a never-collected open index reads as unavailable, not as zero PRs");
  assert.equal(gh.readFailed?.(), true, "and as a failed read, so the board does not claim 0 merged");
  assert.equal(gh.readFailureReason?.(), "not_yet_collected");
  assert.equal(gh.issueReadFailed?.(), true);
  assert.equal(gh.readState?.(), "in_flight", "the due read was handed to the background walk");
  await settle(gh);

  assert.equal(gh.listOpenHeadBranches?.()?.length, 1, "the walk's rows landed in memory");
  clock.ms = 60_000;
  assert.equal(gh.listOpenHeadBranches?.()?.length, 1, "a read past the TTL is served from what is held");
  assert.equal(gh.reviewState?.(OPEN_PR_URL), undefined, "a review state the walk never read is undetermined, not fetched");
  gh.issueByUrl?.("https://github.com/o/r/issues/1");
  gh.changedFiles?.(OPEN_PR_URL);
  await settle(gh);
  assert.equal(gh.reviewState?.(OPEN_PR_URL), "success", "the walk refreshed it off the loop");
  assert.deepEqual(syncCalls, [], "no read spawned a synchronous gh child");
});

test("serve gh pacing waits without a blocking sleep", () => {
  const pacer = createNonBlockingGhCallPacer({ minGapMs: 5_000 });
  const startedAt = Date.now();
  pacer.wait();
  assert.throws(() => pacer.wait(), (err: unknown) => err instanceof GhPaceWouldBlockError && err.waitMs > 0 && err.waitMs <= 5_000);
  assert.throws(
    () => paceGhEntry(createNonBlockingGhCallPacer(), () => true, () => { throw new Error("secondary rate limit"); }),
    GhPaceWouldBlockError,
    "a rate-limit backoff refuses instead of sleeping the thread",
  );
  assertWallClockBound(Date.now() - startedAt, 1_000, "neither refusal slept");

  const blocking = createGhCallPacer({ minGapMs: 5_000, sleepSync: () => { throw new Error("slept"); } });
  blocking.wait();
  assert.throws(() => blocking.wait(), /slept/, "the CLI's pacer still sleeps synchronously");
});

test("a stale board github fact is served stale with its age", async () => {
  const { gh, syncCalls, clock } = offLoopGateway(1_000);
  assert.equal(gh.factsAgeMs?.(), undefined, "no fact held yet, so no age");
  gh.warm?.();
  await settle(gh);
  assert.equal(gh.factsStale?.(), false, "facts inside their TTL are not stale");
  clock.ms = 10_000;
  assert.equal(gh.factsAgeMs?.(), 10_000);
  assert.equal(gh.factsStale?.(), true, "facts past their TTL are stale");
  const github: GitHub = { ...gh, factsAgeMs: () => gh.factsAgeMs?.() };
  const plan = { tasks: [], byId: new Map() } as unknown as Plan;
  const dir = mkdtempSync(join(tmpdir(), "rmd-off-loop-board-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const snapshot = computeBoardSnapshot({ plan, ledgerPath, github });
  assert.equal(snapshot.github_facts_age_ms, 10_000);
  assert.equal(snapshot.github_facts_status, "stale");
  assert.equal(snapshot.prQueue.rows.length, 1, "the stale open PR is still served");
  assert.deepEqual(syncCalls, []);
});

test("a gateway without an age accessor leaves the snapshot field absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-off-loop-noage-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const plan = { tasks: [], byId: new Map() } as unknown as Plan;
  const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  assert.equal("github_facts_age_ms" in computeBoardSnapshot({ plan, ledgerPath, github }), false);
  const throwing: GitHub = { ...github, factsAgeMs: () => { throw new Error("no clock"); } };
  assert.equal(computeBoardSnapshot({ plan, ledgerPath, github: throwing }).github_facts_age_ms, undefined);
  const ageOnly: GitHub = { ...github, factsAgeMs: () => 5 };
  assert.equal(computeBoardSnapshot({ plan, ledgerPath, github: ageOnly }).github_facts_status, "fresh", "an age with no stale verdict reads fresh");
  const unknownVerdict: GitHub = { ...ageOnly, factsStale: () => { throw new Error("no clock"); } };
  assert.equal(computeBoardSnapshot({ plan, ledgerPath, github: unknownVerdict }).github_facts_status, "stale", "an unreadable verdict is never fresh");
});

test("an off-loop gateway leaves a walk that keeps failing to one retry per gap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-off-loop-retry-"));
  const clock = { ms: 0 };
  const gh = buildBatchedGithub("o", "r", { ghBin: join(dir, "no-such-gh"), ttlMs: 1_000, now: () => clock.ms, offLoop: true });
  gh.listOpenHeadBranches?.();
  await settle(gh);
  assert.equal(gh.readFailed?.(), true);
  clock.ms = 10;
  gh.listOpenHeadBranches?.();
  assert.equal(gh.readState?.(), "failed", "inside the retry gap a read does not respawn the walk");
});

test("serveOffLoop switches a built gateway to off-loop reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-off-loop-switch-"));
  let sync = 0;
  const gh = buildBatchedGithub("o", "r", { ghBin: writeBoardGh(dir), exec: () => { sync += 1; return "[]"; }, ttlMs: 1_000 });
  gh.serveOffLoop?.();
  assert.equal(gh.listOpenHeadBranches?.(), null);
  assert.equal(sync, 0);
});
