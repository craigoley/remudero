import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RESET_UNKNOWN, UsageParseError, headroomExhausted, parseUsage } from "../src/lib/headroom.js";
import { buildDefaultHeadroomPolicy, parseResetInstant, resolveHeadroomLimitPct } from "../src/lib/daemon.js";

/**
 * A `/usage` WEEKLY WINDOW WITH NO RESET CLAUSE — the shape that blinded the fleet.
 *
 * On 2026-07-31 the account in use began emitting a SECOND weekly line (`Current week (Fable)`,
 * the third usage window after the session and all-models ones) carrying no `· resets …` clause.
 * `WINDOW_TAIL` made that clause mandatory, `parseTail` threw
 * `unparseable weekly (Fable) window: 0% used`, and because `parseUsage` has no per-window
 * tolerance, ONE such line discarded the session window and the all-models window too — both of
 * which parsed perfectly. `readUsageSnapshot`'s bare `catch` then turned a complete, exit-0,
 * correctly-authenticated reading into `undefined` on every 60-second tick. The last
 * `daemon.headroom` line of any kind was 14:59:05.671Z.
 *
 * THE FIXTURE IS A REAL CAPTURE, NOT A HAND-WRITTEN ONE.
 * `test/fixtures/usage/usage-resetless-weekly.txt` is the verbatim stdout of
 * `claude -p "/usage" < /dev/null` on this host, 2026-07-31T18:19Z, 1015 bytes,
 * sha256 `019eaeb0eb096f39ca81cb14fba7d18240589b85defe8340197d8cd4e642cb2f` — byte-identical to
 * the live capture (`cmp` reported zero differing bytes). Nothing was stripped, reordered or
 * normalised, so every incidental property a parser can trip on is the real one: the `·`
 * separator is a real U+00B7, the reset text is `Aug 2 at 1am` with no leading zero and no
 * comma, the timezone rides in parentheses on two lines and is absent from the third, and the
 * trailing "What's contributing…" prose is present exactly as the CLI emits it. A fixture
 * written from memory is how a predicate ships broken while every test agrees with it.
 *
 * This file is separate from test/headroom.test.ts on purpose: that suite already covers a
 * `Fable` LABEL and a 0% weekly WITH a reset, and passes either way — so it cannot lock this
 * regression, and a coverage-load-bearing test does not belong in a file whose green is
 * unrelated to it.
 */
const FIXTURE = fileURLToPath(new URL("./fixtures/usage/usage-resetless-weekly.txt", import.meta.url));
const REAL_CAPTURE = readFileSync(FIXTURE, "utf8");

test("the real resetless capture parses, yielding the session and all-models windows with their true percentages", () => {
  const snap = parseUsage(REAL_CAPTURE);

  // ASSERT THE VALUES, not merely that it did not throw. Before the fix this call threw and the
  // governor saw nothing at all; a test that only asserted "no throw" would still pass against a
  // parser that invented zeroes, which is the failure mode this parser exists to prevent.
  assert.equal(snap.billingMode, "subscription");
  assert.equal(snap.session.percentUsed, 13);
  assert.equal(snap.session.resetsAt, "Jul 31 at 4:50pm");
  assert.equal(snap.session.tz, "America/New_York");

  assert.equal(snap.weekly.length, 2, "both weekly lines survive — the resetless one does not discard its sibling");
  assert.equal(snap.weekly[0].label, "all models");
  assert.equal(snap.weekly[0].percentUsed, 2);
  assert.equal(snap.weekly[0].resetsAt, "Aug 2 at 1am");
  assert.equal(snap.weekly[0].tz, "America/New_York");
});

test("a window with no reset clause is KEPT with its reset recorded as absent, never invented and never dropped", () => {
  const snap = parseUsage(REAL_CAPTURE);
  const fable = snap.weekly.find((w) => w.label === "Fable");

  // KEPT, not skipped. Skipping an unparseable window was the rejected alternative: if the
  // dropped one were the BINDING window, the snapshot would read rosier than the truth at
  // exactly the boundary that must never fail open.
  assert.ok(fable, "the resetless window is still in the snapshot");
  assert.equal(fable.percentUsed, 0, "its percentage — the only thing enforcement reads — survives intact");

  // THE REPRESENTATION, PINNED. `resetsAt` is ABSENT (the key is not present at all), never an
  // empty string and never the string "undefined", so a consumer's presence test is a real one.
  assert.equal(fable.resetsAt, undefined);
  assert.equal(Object.hasOwn(fable, "resetsAt"), false, "the key is omitted entirely, not set to a falsy placeholder");
  assert.equal(Object.hasOwn(fable, "tz"), false, "and no timezone is invented for a clause that was not there");

  // At the one render/record boundary it becomes a NAMED sentinel, so a ledger line or a console
  // cell reads "unknown" rather than "undefined" or an empty gap.
  assert.equal(RESET_UNKNOWN, "unknown");
});

test("the parser still fails CLOSED and LOUDLY on a genuinely malformed window, naming what it could not parse", () => {
  // THE MOST IMPORTANT TEST HERE. Widening the tail must not be mistaken for making the parser
  // permissive: the `NN% used` HEAD is still mandatory, because the percentage is the only thing
  // the governor compares against its ceiling and inventing one would be the exact fail-open
  // this parser exists to prevent.
  const noPercent = REAL_CAPTURE.replace("Current week (Fable): 0% used", "Current week (Fable): quota exhausted");
  assert.notEqual(noPercent, REAL_CAPTURE, "the substitution actually applied");
  assert.throws(
    () => parseUsage(noPercent),
    (e: unknown) => {
      assert.ok(e instanceof UsageParseError, "fails with the typed parse error, not a generic one");
      // The message must NAME the offending window and quote the text it choked on — that is the
      // whole difference between a two-minute diagnosis and the hours this cost.
      assert.match(e.message, /unparseable weekly \(Fable\) window: quota exhausted/);
      return true;
    },
  );

  // A garbled SESSION line still fails closed too — the widening was scoped to the tail, and the
  // session window is not optional.
  const noSession = REAL_CAPTURE.replace(/^Current session:.*$/m, "Current session: unavailable");
  assert.throws(() => parseUsage(noSession), /unparseable session window: unavailable/);

  // And a capture with no weekly line at all is still a hard error rather than an empty list.
  assert.throws(() => parseUsage("You are currently using your subscription\nCurrent session: 5% used · resets 3pm\n"), /no 'Current week/);
});

test("an absent reset resolves to the STRICT reserve ceiling, never the relaxed final-day one", () => {
  // THE CONSEQUENCE OF KEEPING THE WINDOW, made explicit rather than accidental. A window whose
  // reset is unknown flows into resolveHeadroomWindows, whose time-aware curve needs a reset date
  // to decide whether to relax toward 100% on a window's final day. With no date there is no
  // hoursToReset, and `resolveHeadroomLimitPct(null, …)` returns the LAST (WIDEST) rung — the
  // 95% reserve — never the 100% final-day rung. Uncertainty is held to the STRICTER ceiling,
  // which is the fail-closed direction at the spending boundary.
  const policy = buildDefaultHeadroomPolicy();
  assert.equal(resolveHeadroomLimitPct(null, policy), 95, "absent reset ⇒ the strict reserve");

  // The curve itself still works, so "absent" is genuinely distinct from "close to reset":
  assert.equal(resolveHeadroomLimitPct(12, policy), 100, "a CONFIRMED close reset still relaxes to 100");
  assert.equal(resolveHeadroomLimitPct(48, policy), 95, "a confirmed distant reset holds the reserve");

  // And the real capture's own all-models reset parses to a real instant well outside the final
  // day, so on today's reading nothing is relaxed at all.
  const now = new Date("2026-07-31T18:20:00Z");
  const instant = parseResetInstant("Aug 2 at 1am", now);
  assert.ok(instant, "the all-models reset text is parseable");
  const hours = (instant.getTime() - now.getTime()) / 3_600_000;
  assert.equal(resolveHeadroomLimitPct(hours, policy), 95);

  // headroomExhausted (rmd drain's gate) reads the same snapshot without tripping on the absent
  // reset, and correctly reports headroom on a 13/2/0 reading.
  assert.equal(headroomExhausted(parseUsage(REAL_CAPTURE)), null);

  // …and when a RESETLESS window is the breaching one, it is reported rather than skipped, with
  // the sentinel standing in for its reset. This is the case the rejected "skip it" design would
  // have silently under-reported.
  const breaching = REAL_CAPTURE.replace("Current week (Fable): 0% used", "Current week (Fable): 99% used");
  const over = headroomExhausted(parseUsage(breaching));
  assert.equal(over?.window, "weekly (Fable)");
  assert.equal(over?.percentUsed, 99);
  assert.equal(over?.resetsAt, RESET_UNKNOWN, "the sentinel, so drain's stop summary never interpolates 'undefined'");
});
