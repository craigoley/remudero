import assert from "node:assert/strict";
import { test } from "node:test";
import { servedOpenPrViews } from "#src/cli/commands/daemon.js";
import { createLightPassOpenPrList, headReadOrStandDown, LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS } from "#src/lib/light-pass-open-pr-list.js";
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
  // A read that started with the last good list's own read is not older than it, so it is served.
  const same = Object.assign(Promise.resolve(["same-start"]), { servedReadStartedAtMs: STARTED_AT + 20 });
  assert.equal((await list.read(same, own)).source, "tick_read");
  // The boot pass keeps the W1-T12236 rule: it takes the tick read whatever the last good list's start.
  const boot = await list.read(older, own, { boot: true });
  assert.equal(boot.source, "tick_read");
  assert.deepEqual(boot.views, ["older-tick"]);
});

test("W1-T13709 criterion 4: boot retains the tick-read rule and refill has no served scope", async () => {
  const published = generation(STARTED_AT + 1, [view("boot-head")]);
  const serve = servedOpenPrViews(() => published, () => STARTED_AT);
  assert.deepEqual(await serve(BOOT), [view("boot-head")]);
  assert.equal(serve(undefined), undefined);
});

test("W1-T13709 criterion 3: the act-time guard returns the moved head and stands down when it cannot read it", async () => {
  const moved = headReadOrStandDown(async () => ({ ok: true, state: "OPEN", headSha: "head-moved" }));
  assert.equal((await moved(view("head-tick"))).headSha, "head-moved");
  const unreadable = headReadOrStandDown(async () => ({ ok: false }));
  await assert.rejects(async () => { await unreadable(view("head-tick")); }, /standing down/);
});

test("W1-T13709 criterion 5: a fresh served read avoids the list reader, while no snapshot uses it", async () => {
  let now = STARTED_AT + 10;
  let ownReads = 0;
  const list = createLightPassOpenPrList<string>({ clock: { now: () => now }, log: () => {}, runId: "W1-T13709",
    deadlineMs: 1_000, maxAgeMs: LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS });
  const served = Object.assign(Promise.resolve(["tick"]), { servedReadStartedAtMs: STARTED_AT + 5 });
  const fromTick = await list.read(served, async () => { ownReads++; return ["own"]; });
  assert.equal(fromTick.source, "tick_read");
  assert.deepEqual(fromTick.views, ["tick"]);
  assert.equal(ownReads, 0);
  now++;
  const fromOwnRead = await list.read(undefined, async () => { ownReads++; return ["own"]; });
  assert.equal(fromOwnRead.source, "own_read");
  assert.deepEqual(fromOwnRead.views, ["own"]);
  assert.equal(ownReads, 1);
});
