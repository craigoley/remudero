import assert from "node:assert/strict";
import { test } from "node:test";
import { servedOpenPrViews } from "#src/cli/commands/daemon.js";
import { createLightPassOpenPrList, LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS } from "#src/lib/light-pass-open-pr-list.js";
import { TICK_READ_MAX_AGE_MS, freshReadGeneration, type ReadGeneration } from "#src/lib/read-plane.js";
import type { LightPassScope } from "#src/lib/daemon.js";
import type { OpenPrView } from "#src/lib/sweep.js";
import type { TickReadFacts } from "#src/lib/tick-read-worker.js";

const IDLE: LightPassScope = { reviewOnly: true, scope: "idle" };
const DRAIN: LightPassScope = { reviewOnly: true, scope: "drain" };
const BOOT: LightPassScope = { reviewOnly: true, scope: "boot" };
const STARTED_AT = 10_000;

function view(headSha: string): OpenPrView {
  return { prNumber: 7, prUrl: "https://github.com/o/r/pull/7", taskId: "W1-T7", headSha,
    headRefName: "run-W1-T7-1", lastActivityAt: "2026-11-18T00:00:00Z", reviewState: "none",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, mergeState: "clean",
    changedFiles: ["src/a.ts"], reviewInputDigest: "digest" };
}

function generation(publishedAtMs: number, views: OpenPrView[], openPrError?: string): ReadGeneration<TickReadFacts> {
  return { generation: 1, source: "inline", publishedAtMs,
    facts: { openPrViews: views, ...(openPrError === undefined ? {} : { openPrError }) } as unknown as TickReadFacts };
}

test("W1-T13709 criterion 1: idle and drain scoped passes serve a fresh error-free tick read", async () => {
  const published = generation(STARTED_AT + 10, [view("tick-head")]);
  const serve = servedOpenPrViews(() => published, () => STARTED_AT);
  for (const scope of [IDLE, DRAIN]) {
    const served = serve(scope);
    assert.ok(served);
    assert.equal(served.servedReadStartedAtMs, published.publishedAtMs);
    assert.deepEqual(await served, [view("tick-head")]);
  }
  assert.equal(serve(undefined), undefined, "a no-scope refill continues to read its own views");
});

test("W1-T13709 criterion 2: stale, errored, or pre-tick generations are not served", () => {
  for (const candidate of [undefined, generation(STARTED_AT - 1, [view("old")]), generation(STARTED_AT + 1, [view("error")], "open PR read failed")]) {
    const serve = servedOpenPrViews(() => candidate, () => STARTED_AT);
    assert.equal(serve(IDLE), undefined);
  }
  const tooOld = generation(STARTED_AT + 1, [view("too-old")]);
  const fresh = freshReadGeneration(tooOld, { consumer: "sweep_light", clock: { now: () => STARTED_AT + TICK_READ_MAX_AGE_MS + 2,
    date: () => new Date(STARTED_AT + TICK_READ_MAX_AGE_MS + 2), iso: () => new Date(STARTED_AT + TICK_READ_MAX_AGE_MS + 2).toISOString() } });
  assert.equal(servedOpenPrViews(() => fresh, () => STARTED_AT)(IDLE), undefined);
});

test("W1-T13709 criterion 2: a generation whose read started before the last good list is ignored", async () => {
  let now = STARTED_AT;
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const list = createLightPassOpenPrList<string>({ clock: { now: () => now }, log: (step, extra) => logs.push({ step, extra }),
    runId: "W1-T13709", deadlineMs: 1_000, maxAgeMs: LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS });
  const own = async () => ["own"];
  const first = Object.assign(Promise.resolve(["first-tick"]), { servedReadStartedAtMs: STARTED_AT + 5 });
  assert.equal((await list.read(first, own)).source, "tick_read");
  now = STARTED_AT + 20;
  const older = Object.assign(Promise.resolve(["older-tick"]), { servedReadStartedAtMs: STARTED_AT + 4 });
  const result = await list.read(older, own);
  assert.equal(result.source, "own_read");
  assert.deepEqual(result.views, ["own"]);
});

test("W1-T13709 criterion 4: boot retains the tick-read rule and refill has no served scope", async () => {
  const published = generation(STARTED_AT + 1, [view("boot-head")]);
  const serve = servedOpenPrViews(() => published, () => STARTED_AT);
  assert.deepEqual(await serve(BOOT), [view("boot-head")]);
  assert.equal(serve(undefined), undefined);
});

// W1-T13709 criterion 5: the real daemon-to-hook read-count proof lives beside the restart fixture in
// a-restart-reads-each-open-pull-request-once-before-the-first-review.test.ts.
// W1-T13709 criterion 3: a served list for idle or drain must use last-good act-time head guards.
