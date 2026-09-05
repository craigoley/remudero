// test/reset-instant-dst.test.ts — a time-only `/usage` reset ("3pm") that has already passed
// today must roll to TOMORROW'S SAME WALL-CLOCK TIME, not to "now + 24h in milliseconds".
//
// DEFECT (recon-2026-09-05, R-7). `parseResetInstant`'s time-only branch (src/lib/daemon.ts,
// around the `timeOnly` regex) used to roll a past time-only candidate forward by literally
// adding `24 * 3_600_000` ms. That is correct only when the 24 hours spanning `now` and the
// rolled candidate carry the same UTC offset. Across a DST transition they don't: adding a fixed
// number of milliseconds lands on the WRONG local hour, by exactly the size of the transition (1h
// in every US zone). `America/New_York` observed: `now` = Sat 2026-03-07 23:00 EST, "3pm" (already
// past today) used to resolve to Sun 2026-03-08 **16:00** EDT instead of 15:00 — the day AFTER
// spring-forward reads an hour late. The mirror case at fall-back reads an hour EARLY.
//
// V8 CACHES THE HOST TIMEZONE AT FIRST `Date` USE, so flipping `process.env.TZ` mid-process (this
// process has already constructed `Date`s via `tmp-hygiene.ts` and other fixtures) is not
// reliable. Every case below runs `parseResetInstant` in a FRESH child process with `TZ` set in
// its environment before Node starts, so the zone is live for the child's very first `Date` call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const DAEMON_MODULE = fileURLToPath(new URL("../src/lib/daemon.ts", import.meta.url));

/**
 * Resolves `parseResetInstant("3pm", now)` in a fresh `node --import tsx` child running under
 * `tz`, and returns the resolved instant's LOCAL hour/minute/date as read inside that same child
 * (so the assertion never re-interprets the instant through this process's own zone).
 */
function resolveThreePmInChild(tz: string, nowIso: string): { hour: number; minute: number; date: number; month: number } {
  const script = [
    `const { parseResetInstant } = await import(${JSON.stringify(DAEMON_MODULE)});`,
    `const now = new Date(${JSON.stringify(nowIso)});`,
    `const resolved = parseResetInstant("3pm", now);`,
    `if (resolved === null) throw new Error("parseResetInstant returned null for a recognized time-only shape");`,
    `process.stdout.write(JSON.stringify({ hour: resolved.getHours(), minute: resolved.getMinutes(), date: resolved.getDate(), month: resolved.getMonth() }));`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `child process failed under TZ=${tz}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("parseResetInstant: a past time-only reset resolves to 15:00 local the day after spring-forward (America/New_York)", () => {
  // Sat 2026-03-07 23:00 EST — the night before the US spring-forward transition (2026-03-08,
  // 2am local). "3pm" has already passed today, so it must roll to Sun 2026-03-08 15:00 EDT.
  const resolved = resolveThreePmInChild("America/New_York", "2026-03-07T23:00:00-05:00");
  assert.equal(resolved.hour, 15, `expected 15:00 local, got ${resolved.hour}:${String(resolved.minute).padStart(2, "0")}`);
  assert.equal(resolved.minute, 0);
  assert.equal(resolved.month, 2); // March
  assert.equal(resolved.date, 8);
});

test("parseResetInstant: a past time-only reset resolves to 15:00 local the day after fall-back (America/New_York)", () => {
  // Sat 2026-10-31 23:00 EDT — the night before the US fall-back transition (2026-11-01, 2am
  // local). "3pm" has already passed today, so it must roll to Sun 2026-11-01 15:00 EST.
  const resolved = resolveThreePmInChild("America/New_York", "2026-10-31T23:00:00-04:00");
  assert.equal(resolved.hour, 15, `expected 15:00 local, got ${resolved.hour}:${String(resolved.minute).padStart(2, "0")}`);
  assert.equal(resolved.minute, 0);
  assert.equal(resolved.month, 10); // November
  assert.equal(resolved.date, 1);
});

test("parseResetInstant: control — a non-DST zone (UTC) rolls a past time-only reset unchanged", () => {
  // No DST transition exists in UTC, so this case must resolve to 15:00 local under both the
  // buggy ms-roll and the fixed calendar-roll — it separates "the fix changed DST behaviour" from
  // "the fix changed everything".
  const resolved = resolveThreePmInChild("UTC", "2026-03-07T23:00:00Z");
  assert.equal(resolved.hour, 15);
  assert.equal(resolved.minute, 0);
  assert.equal(resolved.month, 2);
  assert.equal(resolved.date, 8);
});
