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
//
// The final test below covers the OTHER half of this task: `judgeProviderCapacityReadable` alone
// proves the arm's judgement is right, but `report-commands.ts`'s `doctorCommand` is what actually
// feeds it a live `readProviderRoutingStatus` read (via `DoctorDeps.readProviderRoutingStatus`) and
// maps each `ProviderRoutingProviderStatus` into the `ProviderCapacityReading` shape above — a
// real, separately-executed line range no other suite exercises (every other `doctorCommand` test
// in this repo leaves that dep at its default, which reads an absent file and returns an empty
// provider list, so the mapping callback itself never runs).

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

// ── the doctorCommand wiring (report-commands.ts) ──────────────────────────────────────────────

test("doctorCommand feeds the live provider-routing read into the provider-capacity arm, unreadable and reasoned", async () => {
  const { doctorCommand } = await import("../src/run-task.js");
  const lines: string[] = [];
  const code = await doctorCommand([], {
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    loadConfig: () => ({ root: "/nonexistent-doctor-root" }) as never,
    nowMs: Date.parse("2026-09-16T12:00:00Z"),
    readLedgerLines: () => [],
    readMemInfo: () => ({ availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3 }),
    readDiskFreeBytes: () => 40 * 1024 ** 3,
    readPauseAgeMs: () => undefined,
    readGitLocks: () => [],
    readCheckoutDepth: () => ({ shallow: false, commitCount: 980 }),
    readNvmrcVersion: () => process.versions.node,
    // The live projection doctorCommand actually reads from (provider-routing-status.ts), stood
    // up here as a fixture rather than a real file — the exact read this arm feeds through
    // unchanged, mapped into ProviderCapacityReading by the wiring under test.
    readProviderRoutingStatus: () =>
      ({
        version: 1,
        state: "blocked",
        freshness: "fresh",
        providers: [
          { provider: "codex", readable: false, windows: [], reason: "capacity-unreadable" },
          { provider: "claude", readable: true, windows: [{ name: "5h", usedPercent: 10 }] },
        ],
      }) as never,
  });
  const rendered = lines.join("\n");
  assert.equal(code, 2, "an unreadable provider with no measured duration breaches the bound and fails the report");
  assert.match(rendered, /provider-capacity/);
  const detailLine = rendered.split("\n").find((l) => l.includes("unreadable beyond"));
  assert.ok(detailLine, "the provider-capacity FAIL detail line is present, proving the wiring reached the arm");
  assert.match(detailLine!, /codex/);
  assert.doesNotMatch(detailLine!, /claude/, "the readable provider must not be named as a breach");
});
