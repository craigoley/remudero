// test/away-mode-delivery.test.ts — W1-T251, P34 clause (e) — AWAY-MODE ESCALATION DELIVERY.
//
// Presence keys ONLY escalation DELIVERY (escalateCommand's real-time ping, run-task.ts), never
// dispatch — round iii killed the presence×risk dispatch matrix rounds 1-2 proposed (MASTER-PLAN
// line ~824, superseded by the round-3 ratification directly beneath it). AWAY batches a
// MANUAL/HARD_STOP escalation into the W1-T163 recap for an ASYNC verdict instead of paging in
// real time; ATTENDED (the default, unset) delivers exactly as before this task. STOP and PAUSE
// (fleet-control.ts, W1-T11) remain the only real-time-presence waits, untouched.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { awayCommand, escalateCommand } from "../src/run-task.js";
import { awayFilePath, deliversRealtime, presenceMode, setPresenceMode } from "../src/lib/escalate.js";
import { buildRecapEvents } from "../src/lib/recap.js";
import type { Plan } from "../src/lib/plan.js";

function setupRoot(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-away-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const home = mkdtempSync(join(tmpdir(), "rmd-away-home-"));
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/bin/true", root, consoleUrl: "http://100.64.1.2:4317" }),
  );
  return { root, home };
}

function readLedger(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const EMPTY_PLAN: Plan = { tasks: [], byId: new Map() };

// ── Claim 1: AWAY mode batches into the recap for an async verdict, no sync-answer page ──────

test("claim 1: AWAY mode fires NO real-time ping for a MANUAL escalation — the issue still opens unconditionally, and the routing is ledgered as batched", async () => {
  const { root, home } = setupRoot();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    setPresenceMode(root, "away");
    assert.equal(presenceMode(root), "away");
    assert.equal(deliversRealtime(root), false);

    const sent: string[] = [];
    const code = await escalateCommand(
      ["--class", "MANUAL", "--task", "W1-TX", "--summary", "needs a secret", "--option", "grant|grant access", "--recommendation", "grant"],
      {
        issues: { create: () => "https://github.com/craigoley/remudero/issues/42" } as never,
        notifyChannel: {
          send: (m: string) => {
            sent.push(m);
            return true;
          },
        } as never,
      },
    );
    assert.equal(code, 0);
    assert.equal(sent.length, 0, "AWAY mode must fire NO real-time page for MANUAL/HARD_STOP");

    const lines = readLedger(root);
    const opened = lines.find((l) => l.step === "escalation.issue_opened");
    assert.ok(opened, "the needs-human issue is still opened UNCONDITIONALLY, even AWAY");
    const batched = lines.find((l) => l.step === "escalation.batched_away");
    assert.ok(batched, "the AWAY routing decision itself is ledgered — auditable, not silent");
    assert.equal(batched?.class, "MANUAL");
    assert.equal(batched?.issue_url, "https://github.com/craigoley/remudero/issues/42");
  } finally {
    process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("claim 1b: the AWAY-batched escalation actually surfaces through the W1-T163 recap — the async-verdict surface, never a second/undiscoverable channel", async () => {
  const { root, home } = setupRoot();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    setPresenceMode(root, "away");
    await escalateCommand(
      ["--class", "HARD_STOP", "--task", "W1-TX", "--summary", "force-push seen", "--option", "abort|refuse", "--recommendation", "abort"],
      { issues: { create: () => "https://github.com/craigoley/remudero/issues/44" } as never },
    );
    const lines = readLedger(root);
    const events = buildRecapEvents(lines, "2020-01-01T00:00:00.000Z", EMPTY_PLAN);
    const escalated = events.find((e) => e.kind === "escalated" && e.taskId === "W1-TX");
    assert.ok(escalated, "the recap (async verdict surface) carries the AWAY-batched escalation");
    assert.equal(escalated?.detail, "HARD_STOP");
  } finally {
    process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Claim 2 (falsifier): ATTENDED changes NOTHING — delivers exactly as today ─────────────────

test("claim 2 (falsifier): ATTENDED (the default, no AWAY flag) delivers a HARD_STOP escalation exactly as before this task — real-time ping fires, no batched_away line", async () => {
  const { root, home } = setupRoot();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(presenceMode(root), "attended", "default presence, with no AWAY flag ever written, is attended");
    assert.equal(existsSync(awayFilePath(root)), false);

    const sent: string[] = [];
    const code = await escalateCommand(
      ["--class", "HARD_STOP", "--task", "W1-TY", "--summary", "force-push detected", "--option", "abort|refuse", "--recommendation", "abort"],
      {
        issues: { create: () => "https://github.com/craigoley/remudero/issues/43" } as never,
        notifyChannel: {
          send: (m: string) => {
            sent.push(m);
            return true;
          },
        } as never,
      },
    );
    assert.equal(code, 0);
    assert.equal(sent.length, 1, "ATTENDED still fires the real-time ping for HARD_STOP, unchanged");
    assert.match(sent[0], /#task=W1-TY/, "the ping still carries the console deep link, exactly as before");

    const lines = readLedger(root);
    assert.ok(lines.some((l) => l.step === "escalation.issue_opened"));
    assert.ok(!lines.some((l) => l.step === "escalation.batched_away"), "ATTENDED never ledgers a batched_away line");
  } finally {
    process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("claim 2b: switching presence back to attended clears the AWAY flag and restores real-time delivery", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-away-toggle-"));
  try {
    setPresenceMode(root, "away");
    assert.equal(deliversRealtime(root), false);
    setPresenceMode(root, "attended");
    assert.equal(deliversRealtime(root), true);
    assert.equal(existsSync(awayFilePath(root)), false, "attended clears the AWAY flag file rather than leaving it inert");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim 3: presence keys ONLY delivery — the dead presence×risk dispatch matrix stays absent ─

test("claim 3: no dispatch-path module reads the presence signal — the presence×risk dispatch matrix (rounds 1-2) is absent, dead", () => {
  const drainSrc = readFileSync(fileURLToPath(new URL("../src/lib/drain.ts", import.meta.url)), "utf8");
  const overlapSrc = readFileSync(fileURLToPath(new URL("../src/lib/dispatch-overlap.ts", import.meta.url)), "utf8");
  const riskSrc = readFileSync(fileURLToPath(new URL("../src/lib/risk-score.ts", import.meta.url)), "utf8");
  const sources: Array<[string, string]> = [
    ["drain.ts (nextRunnable/runnableCandidates — the dispatch selection surface)", drainSrc],
    ["dispatch-overlap.ts", overlapSrc],
    ["risk-score.ts (the dispatch-path risk gate)", riskSrc],
  ];
  for (const [name, src] of sources) {
    assert.ok(!src.includes("escalate.js"), `${name} must not import escalate.ts's presence signal at all`);
    assert.ok(!src.includes("presenceMode"), `${name} must never read presenceMode — dispatch is NOT presence-gated`);
    assert.ok(!src.includes("deliversRealtime"), `${name} must never read deliversRealtime — that is a delivery-only concern`);
    assert.ok(!src.includes("PresenceMode"), `${name} must carry no presence-mode type dependency at all`);
  }
});

test("claim 3b: STOP and PAUSE (fleet-control.ts) stay independent of the presence signal — the only real-time-presence waits, untouched by this task", () => {
  const fleetControlSrc = readFileSync(fileURLToPath(new URL("../src/lib/fleet-control.ts", import.meta.url)), "utf8");
  assert.ok(!fleetControlSrc.includes("escalate.js"), "fleet-control.ts must not depend on escalate.ts's presence signal");
  assert.ok(!fleetControlSrc.includes("presenceMode") && !fleetControlSrc.includes("PresenceMode"));
  assert.match(fleetControlSrc, /export function isStopped/, "STOP gate predicate is still present, unmodified in shape");
  assert.match(fleetControlSrc, /export function isPaused/, "PAUSE gate predicate is still present, unmodified in shape");
});

test("claim 3c: escalateCommand is the ONLY real-time-ping site gated on presence — every other escalate()/tryEscalate() call site in run-task.ts is presence-agnostic (relies on the recap/digest for async surfacing, exactly as before this task)", () => {
  const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
  const occurrences = runTaskSrc.match(/deliversRealtime\(/g) ?? [];
  assert.equal(occurrences.length, 1, "deliversRealtime must gate exactly one call site — escalateCommand's real-time ping");
});

// ── rmd away [on|off]: the CLI verb that sets the presence flag the delivery path reads ──────

test("rmd away on / off: sets the presence flag, ledgers fleet.presence, and prints the mode; toggling back clears it", async () => {
  const { root, home } = setupRoot();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // `on` → AWAY: presence flips, and the routing switch itself is ledgered.
    const onCode = await awayCommand(["on"]);
    assert.equal(onCode, 0);
    assert.equal(presenceMode(root), "away", "rmd away on sets presence to away");
    assert.equal(deliversRealtime(root), false, "away suppresses the real-time page");

    // `off` → ATTENDED: presence flips back, clearing the flag.
    const offCode = await awayCommand(["off"]);
    assert.equal(offCode, 0);
    assert.equal(presenceMode(root), "attended", "rmd away off returns to attended");
    assert.equal(deliversRealtime(root), true, "attended restores real-time delivery");

    const presenceLines = readLedger(root).filter((l) => l.step === "fleet.presence");
    assert.deepEqual(
      presenceLines.map((l) => l.mode),
      ["away", "attended"],
      "each toggle ledgers a fleet.presence line naming the new mode",
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("rmd away: no arg PRINTS the current mode (no flag write); a junk arg is a usage error (exit 2)", async () => {
  const { root, home } = setupRoot();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // Status read: no arg, default attended, and NO AWAY flag is created by a bare read.
    const statusCode = await awayCommand([]);
    assert.equal(statusCode, 0);
    assert.equal(presenceMode(root), "attended", "a bare `rmd away` never writes the flag");

    // Junk arg → usage error, non-zero, still no write.
    const badCode = await awayCommand(["sometimes"]);
    assert.equal(badCode, 2, "an unrecognized arg is a usage error");
    assert.equal(presenceMode(root), "attended");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
