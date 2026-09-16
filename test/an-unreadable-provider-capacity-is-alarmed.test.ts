// test/an-unreadable-provider-capacity-is-alarmed.test.ts — W1-T3665.
//
// MEASURED. codex's `auth.json` id_token expired roughly an hour after a 2026-09-11T13:27:57Z
// refresh; every capacity read then returned `"provider":"codex","readable":false` until an
// operator re-authenticated on 2026-09-16T10:35:39Z. `codex login status` kept printing "Logged
// in" throughout (its ACCESS token stays valid ten days; the read needs the ID token, valid one
// hour), so every cheap check an operator would reach for said healthy while the routing auction
// gave codex zero headroom and routed 100% of balanced work to Claude for five straight days.
//
// `rmd doctor` had NO provider-capacity arm at all — the condition was visible only in a daemon
// log line nobody greps. These three tests pin the arm this task adds: it raises when a provider
// is unreadable beyond a stated bound, it stays quiet for a readable provider, and it never prints
// a bare percentage — the same "95%" an operator read as 95% REMAINING during the incident.

import assert from "node:assert/strict";
import { test } from "node:test";

import { judgeProviderCapacityReadable, type ProviderCapacityReading } from "../src/lib/doctor.js";

const MIN = 60_000;

function unreadable(over: Partial<ProviderCapacityReading> = {}): ProviderCapacityReading {
  return { provider: "codex", readable: false, windows: [], ...over };
}

function readable(over: Partial<ProviderCapacityReading> = {}): ProviderCapacityReading {
  return { provider: "codex", readable: true, windows: [{ name: "5h", usedPercent: 40 }], ...over };
}

test("a provider unreadable beyond the bound raises the capacity arm", () => {
  const check = judgeProviderCapacityReadable([unreadable({ unreadableForMs: 3 * 60 * MIN })], 60 * MIN);
  assert.equal(check.name, "provider-capacity");
  assert.equal(check.verdict, "FAIL");
  assert.match(check.detail ?? "", /codex/);
  assert.match(check.detail ?? "", /unreadable beyond/);
});

// W1-T3665's actual production wiring (report-commands.ts) has no cross-run history to measure a
// duration from, so an OMITTED `unreadableForMs` must read as "beyond the bound" too — never as
// healthy-by-default, which would silently recreate the five days of "nothing said so".
test("a provider unreadable with no measured duration also raises the capacity arm", () => {
  const check = judgeProviderCapacityReadable([unreadable()]);
  assert.equal(check.verdict, "FAIL");
});

// The mirror of the first test: the SAME duration that breaches a tight bound must NOT breach a
// looser one — proving this arm discriminates on the bound, not merely on "readable: false".
test("a provider unreadable for LESS than the bound does not raise the capacity arm", () => {
  const check = judgeProviderCapacityReadable([unreadable({ unreadableForMs: 5 * MIN })], 60 * MIN);
  assert.equal(check.verdict, "OK");
});

test("a readable provider capacity does not raise the arm", () => {
  const check = judgeProviderCapacityReadable([readable()]);
  assert.equal(check.verdict, "OK");
});

test("a mix of one readable and one long-unreadable provider still raises, discriminating per provider", () => {
  const check = judgeProviderCapacityReadable(
    [readable({ provider: "claude" }), unreadable({ provider: "codex", unreadableForMs: 5 * 24 * 60 * MIN })],
    60 * MIN,
  );
  assert.equal(check.verdict, "FAIL");
  assert.match(check.detail ?? "", /codex/);
  assert.doesNotMatch(check.detail ?? "", /claude/);
});

test("the capacity arm names consumed, remaining and the reset — never a bare percentage", () => {
  const check = judgeProviderCapacityReadable([
    readable({ windows: [{ name: "weekly", usedPercent: 95, resetsAt: "2026-09-19T00:00:00.000Z" }] }),
  ]);
  assert.equal(check.verdict, "OK");
  assert.match(check.measured, /95% consumed/);
  assert.match(check.measured, /5% remaining/);
  assert.match(check.measured, /resets 2026-09-19T00:00:00\.000Z/);
  // The raw reading alone, with no direction attached, must never appear — that bare shape is
  // exactly what an operator read backwards during the 2026-09-16 incident.
  assert.doesNotMatch(check.measured, /weekly: 95%(?! consumed)/);
});

test("no provider capacity read observed is OK, not a finding — an unconfigured or single-provider fleet is healthy", () => {
  const check = judgeProviderCapacityReadable([]);
  assert.equal(check.verdict, "OK");
  assert.match(check.measured, /no provider capacity read observed/);
});
