import assert from "node:assert/strict";
import { test } from "node:test";
import { formatStamp, formatAge, resolveFreshness } from "../src/lib/console-freshness.js";

// ── fb-1784902052582-c124f9: the console header contradicted itself. Each observed incoherence
// is reproduced here as a fixture, then made impossible by construction. ─────────────────────

// FIXTURE (impossible arithmetic): the screenshot showed an absolute "12:03:09 PM" with a
// relative "5h ago" that could not both be true, because the two came from DIFFERENT clocks.
test("formatStamp: absolute time and relative age derive from ONE instant + ONE clock — they can never contradict", () => {
  const iso = "2026-07-24T14:00:00.000Z";
  const now = Date.parse("2026-07-24T19:00:00.000Z"); // exactly 5h later
  const s = formatStamp(iso, now);
  assert.equal(s.ago, "5h ago", "the age is exactly now − iso");
  // The absolute time is the SAME instant `iso` (not a second source): re-deriving the age from
  // the rendered stamp's own inputs reproduces it. The old bug was two independent sources; here
  // both are pure functions of (iso, now), so "5h ago" beside a non-5h-ago absolute is impossible.
  assert.equal(formatStamp(iso, now).ago, s.ago);
  assert.equal(formatStamp(iso, now).time, s.time);
});

test("formatStamp: the timezone is ALWAYS labeled (never a bare unlabeled wall-clock time)", () => {
  const s = formatStamp("2026-07-24T14:00:00.000Z", Date.parse("2026-07-24T14:00:11.000Z"));
  assert.notEqual(s.tz, "", "a labeled timezone accompanies the absolute time");
  assert.equal(s.ago, "11s ago");
});

test("formatStamp: an unparseable/absent timestamp degrades honestly, never NaN arithmetic", () => {
  const s = formatStamp("not-a-date", Date.now());
  assert.equal(s.time, "—");
  assert.equal(s.ago, "unknown");
});

test("formatAge: one coarse ladder — just now / s / m / h / d", () => {
  assert.equal(formatAge(500), "just now");
  assert.equal(formatAge(11_000), "11s ago");
  assert.equal(formatAge(5 * 60_000), "5m ago");
  assert.equal(formatAge(5 * 3_600_000), "5h ago");
  assert.equal(formatAge(2 * 86_400_000), "2d ago");
});

// FIXTURE (three disagreeing chips / STALE beside live): a cache-restored STALE badge co-displayed
// with a live SSE connection. resolveFreshness returns exactly ONE mode, so that can't recur.
const BASE = { staleAfterMs: 9_000, failuresBeforeStale: 3, asOf: "2026-07-24T14:00:00.000Z" };

test("resolveFreshness: a CONNECTED stream is never stale, even over hours-old cached data (the STALE-beside-live fixture)", () => {
  const now = Date.parse("2026-07-24T19:00:00.000Z");
  const f = resolveFreshness({
    ...BASE,
    nowMs: now,
    lastLiveMs: Date.parse("2026-07-24T14:00:00.000Z"), // 5h old cache
    connected: true, // …but the live stream is UP
    pollFailures: 0,
  });
  assert.equal(f.mode, "live", "connected ⇒ live, NEVER co-displayed with stale");
});

test("resolveFreshness: STALE only when the stream is DOWN, data is old, AND enough polls have failed (not a transient blip)", () => {
  const now = Date.parse("2026-07-24T19:00:00.000Z");
  const stale = resolveFreshness({ ...BASE, nowMs: now, lastLiveMs: now - 60_000, connected: false, pollFailures: 3 });
  assert.equal(stale.mode, "stale");
  // one or two failures ⇒ still just reconnecting, never prematurely STALE
  const reconnecting = resolveFreshness({ ...BASE, nowMs: now, lastLiveMs: now - 60_000, connected: false, pollFailures: 1 });
  assert.equal(reconnecting.mode, "reconnecting");
  // fresh data ⇒ live regardless of a momentary disconnect
  const fresh = resolveFreshness({ ...BASE, nowMs: now, lastLiveMs: now - 1_000, connected: false, pollFailures: 5 });
  assert.equal(fresh.mode, "live");
});

test("resolveFreshness: the three modes are MUTUALLY EXCLUSIVE — exactly one is ever returned", () => {
  const now = 1_000_000;
  for (const connected of [true, false]) {
    for (const pollFailures of [0, 1, 3, 9]) {
      for (const lastLiveMs of [null, now - 500, now - 60_000]) {
        const f = resolveFreshness({ ...BASE, nowMs: now, lastLiveMs, connected, pollFailures });
        assert.ok(["live", "reconnecting", "stale"].includes(f.mode));
        // stale ⊕ live: never both — a connected/fresh pane is live, only a down+old+failed pane is stale
        if (f.mode === "stale") assert.equal(connected, false);
        if (connected) assert.equal(f.mode, "live");
      }
    }
  }
});
