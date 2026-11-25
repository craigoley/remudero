/**
 * W1-T13237 — A LIGHT PASS NEVER REPLAYS A VIEW WHOSE ROLLUP IT COULD NOT READ.
 *
 * 2026-11-16: light passes escalated PRs with dozens of checks as "checks none, review none" because the
 * last-good open-PR list stored a partly read list whole and slow passes replayed it for up to 15 minutes.
 * The list now keeps only fully read views, and the fallback row names the list's age and its fully read count.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLightPassOpenPrList,
  LIGHT_PASS_VIEWS_DEADLINE_MS,
  LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS,
} from "#src/lib/light-pass-open-pr-list.js";

interface V { prNumber: number; headSha: string; rollupUnreadable?: true }
const read = (n: number, headSha = `h${n}`): V => ({ prNumber: n, headSha });
const unread = (n: number): V => ({ prNumber: n, headSha: `h${n}`, rollupUnreadable: true });

function harness(deadlineMs = 20) {
  const logs: Array<Record<string, unknown>> = [];
  let nowMs = 0;
  const list = createLightPassOpenPrList<V>({
    clock: { now: () => nowMs }, log: (step, extra) => logs.push({ step, ...extra }), runId: "T13237",
    deadlineMs, maxAgeMs: LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS,
    completeness: { key: (v) => v.prNumber, unread: (v) => v.rollupUnreadable === true },
  });
  const fail = () => Promise.reject(Object.assign(new Error("read failed"), { stderr: "boom" }));
  return { logs, list, setNow: (n: number) => { nowMs = n; }, fail };
}

test("W1-T13237 criterion 1: an unread view never enters the last-good list, which keeps that PR's previous fully read view or nothing", async () => {
  const h = harness();
  // A partly read first list: PR 2 is unread and has no previous view, so it is absent.
  assert.equal((await h.list.read(undefined, async () => [read(1), unread(2)])).views.length, 2, "the pass's own read is returned whole");
  const a = await h.list.read(undefined, h.fail);
  assert.equal(a.fallback, true);
  assert.deepEqual(a.views, [read(1)], "the unread view is absent");
  // A fully read list, then a read where PR 1 is unread: its previous fully read view stays.
  h.setNow(1_000);
  await h.list.read(undefined, async () => [read(1, "old"), read(2)]);
  h.setNow(2_000);
  await h.list.read(undefined, async () => [unread(1), read(2, "new")]);
  const b = await h.list.read(undefined, h.fail);
  assert.deepEqual(b.views, [read(1, "old"), read(2, "new")], "PR 1 keeps its previous fully read view");
  assert.ok(b.views.every((v) => v.rollupUnreadable !== true));
  // A carried view keeps its own read time: it ages out on its own bound even though a newer list exists.
  h.setNow(1_000 + LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS + 1);
  await h.list.read(undefined, async () => [unread(1), read(2, "newer")]);
  const c = await h.list.read(undefined, h.fail);
  assert.deepEqual(c.views, [read(2, "newer")], "a carried view older than the age bound is not replayed");
});

test("W1-T13237 criterion 2: a fallback row records the list's age and how many of its views were fully read", async () => {
  const h = harness();
  await h.list.read(undefined, async () => [read(1), unread(2), read(3)]);
  h.setNow(30_000);
  await h.list.read(undefined, h.fail);
  const row = h.logs.filter((l) => l.step === "sweep_light.views_fallback").at(-1)!;
  assert.equal(row.reason, "read_failed");
  assert.equal(row.list_age_ms, 30_000);
  assert.equal(row.snapshot_age_ms, 30_000);
  assert.equal(row.fully_read_count, 2);
  assert.equal(row.pr_count, 2);
});

test("W1-T13237 criterion 3: a fully read list is kept as today, the bounds are unchanged, and a pass with no list stands down", async () => {
  assert.equal(LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS, 15 * 60_000);
  assert.equal(LIGHT_PASS_VIEWS_DEADLINE_MS, 60_000);
  const h = harness();
  const views = [read(1), read(2)];
  await h.list.read(undefined, async () => views);
  h.setNow(5_000);
  const kept = await h.list.read(undefined, h.fail);
  assert.deepEqual(kept.views, views, "every fully read view is kept");
  h.setNow(LIGHT_PASS_VIEWS_FALLBACK_MAX_AGE_MS + 1);
  await assert.rejects(h.list.read(undefined, h.fail), /read failed/, "a list past the age bound is not used");
  assert.equal(h.logs.at(-1)!.reason, "snapshot_too_old");
  const empty = harness();
  await assert.rejects(empty.list.read(undefined, empty.fail), /read failed/);
  assert.equal(empty.logs.at(-1)!.reason, "no_snapshot");
});
