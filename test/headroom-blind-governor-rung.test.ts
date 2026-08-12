/**
 * `rmd status` MUST NOT REPORT A PERMANENT PARK AS AN IN-PROGRESS START-UP.
 *
 * THE DEFECT. `runDaemon` (src/lib/daemon.ts) parks when the usage probe stays unreadable:
 * `consecutiveUnreadable++`, and once it exceeds `unreadableDegradedLimit` it logs
 * `daemon.headroom.degraded`, sleeps, and `continue`s. `consecutiveUnreadable` is reset ONLY on a
 * successful read, and the branch has no ceiling, no escalation and no exit — so a probe that is
 * unreadable every tick parks the daemon permanently. With `UNREADABLE_DEGRADED_LIMIT = 3` and
 * `DEFAULT_POLL_INTERVAL_MS = 60_000` that is roughly four minutes after boot, and every liveness
 * indicator still reads healthy: the process is running, ticking, and on a fresh boot sha.
 *
 * A parked daemon never writes a `daemon.headroom` row, so `deriveHeadroom` reported `found:
 * false` — the same state as a daemon that has not ticked yet — and `HEADROOM_NEXT_ACTIONS`' first
 * rung rendered "no headroom telemetry yet — it appears after the daemon's first tick" for BOTH.
 * The one surface an operator consults reported a reassuring in-progress state about a fleet that
 * had stopped dispatching and would not restart itself.
 *
 * THE EVIDENCE WAS ALREADY THERE. `daemon.headroom.degraded` is in RENDER_RELEVANT_LEDGER_STEPS
 * (ledger.ts) with a 30-minute window, added precisely because a dotted CHILD does not inherit its
 * parent's rotation protection — and its own note records that it is "PROTECTED FOR A CONSUMER
 * THAT DOES NOT EXIST YET". This is that consumer. Nothing about the park's BEHAVIOUR changes here;
 * only what the operator is told about it.
 *
 * BOTH DIRECTIONS ARE PROVEN, because a rung that always fired would be as useless as one that
 * never did: a blind governor reports blind, and every healthy posture reports exactly what it
 * reported before.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusBoard } from "../src/lib/status-board.js";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** A real ledger file plus the root the board reads, so the rung runs over persisted rows. */
function boardOver(rows: Array<Record<string, unknown>>, enforced = true) {
  const root = mkdtempSync(join(tmpdir(), "headroom-blind-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // The SAME offline-safe seam bundle test/status-board.test.ts uses — no real launchd, no git
  // fetch, no wall clock. Only the headroom switch and the clock matter here.
  return buildStatusBoard(root, ledgerPath, {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    resolveHeadroomEnabled: () => enforced,
  } as never).headroom;
}

/** What the parked daemon writes every tick while blind (daemon.ts's own payload). */
const degraded = (agoMs: number, consecutive = 7) => ({
  ts: iso(agoMs),
  step: "daemon.headroom.degraded",
  tick: 11,
  consecutive_unreadable: consecutive,
  degraded_limit: 3,
  poll_interval_ms: 60_000,
  note: "usage unreadable beyond the bounded allowance — idling, not dispatching",
});

/** A healthy governor heartbeat. */
const healthy = (agoMs: number, percent = 18) => ({
  ts: iso(agoMs),
  step: "daemon.headroom",
  window: "5-hour",
  percent_used: percent,
  limit_pct: 95,
  resets_at: "2026-08-12T17:00:00Z",
});

// ── DIRECTION 1: a blind governor says so ─────────────────────────────────────────────────────

test("a parked daemon reports BLIND, not the reassuring first-tick message", () => {
  const h = boardOver([{ ts: iso(600_000), step: "daemon.boot" }, degraded(60_000)]);
  assert.equal(h.found, false, "a parked daemon never writes daemon.headroom — found stays false");
  assert.ok(h.degraded, "the degraded signal is picked up");
  assert.match(h.nextAction ?? "", /BLIND/);
  assert.doesNotMatch(h.nextAction ?? "", /appears after the daemon's first tick/);
});

test("the blind message states how long, from the line's own two fields", () => {
  // 7 x 60_000ms = 7 minutes. The duration is derived, never guessed.
  const h = boardOver([degraded(60_000, 7)]);
  assert.match(h.nextAction ?? "", /blind for about 7m \(7 consecutive unreadable probes\)/);
  assert.equal(h.degraded?.consecutiveUnreadable, 7);
  assert.equal(h.degraded?.pollIntervalMs, 60_000);
});

test("a degraded line missing its counters omits the duration rather than inventing one", () => {
  const partial = { ts: iso(60_000), step: "daemon.headroom.degraded", note: "no counters" };
  const h = boardOver([partial]);
  assert.match(h.nextAction ?? "", /BLIND/);
  assert.doesNotMatch(h.nextAction ?? "", /blind for about/);
});

test("blindness outranks a STALE healthy row — a park that begins after a good period still reports", () => {
  const h = boardOver([healthy(3_600_000), degraded(60_000)]);
  assert.equal(h.found, true, "the old healthy row is still found");
  assert.match(h.nextAction ?? "", /BLIND/, "but the newer blindness is what the operator is told");
});

test("the newest degraded line wins, by PARSED ts and not by ledger order", () => {
  const h = boardOver([degraded(30_000, 42), degraded(600_000, 4)]);
  assert.equal(h.degraded?.consecutiveUnreadable, 42);
});

// ── DIRECTION 2: every healthy posture is unchanged ───────────────────────────────────────────

test("THE OTHER DIRECTION: no daemon yet still reports the first-tick message, unchanged", () => {
  // FALSIFIER for a rung that fires unconditionally. If this ever reads BLIND, the change has
  // replaced one wrong message with another.
  const h = boardOver([{ ts: iso(600_000), step: "daemon.boot" }]);
  assert.equal(h.found, false);
  assert.equal(h.degraded, undefined);
  assert.equal(h.nextAction, "no headroom telemetry yet — it appears after the daemon's first tick");
});

test("THE OTHER DIRECTION: a healthy reading under the ceiling is untouched", () => {
  const h = boardOver([healthy(60_000, 18)]);
  assert.equal(h.found, true);
  assert.equal(h.degraded, undefined);
  assert.doesNotMatch(h.nextAction ?? "", /BLIND/);
});

test("THE OTHER DIRECTION: an at-ceiling reading still reports the throttle, not blindness", () => {
  const h = boardOver([healthy(60_000, 97)]);
  assert.match(h.nextAction ?? "", /at\/over its 95% ceiling/);
  assert.doesNotMatch(h.nextAction ?? "", /BLIND/);
});

test("THE OTHER DIRECTION: the governor-OFF message still wins when nothing is degraded", () => {
  const h = boardOver([healthy(60_000, 18)], false);
  assert.match(h.nextAction ?? "", /governor is OFF/);
});

test("a governor that RECOVERED — degraded, then a healthy row — is not reported as blind", () => {
  // The park ends the moment a probe succeeds (daemon.ts resets consecutiveUnreadable), and the
  // 30-minute render window means the old degraded line can still be present. Recovery must win.
  const h = boardOver([degraded(600_000), healthy(30_000, 21)]);
  assert.equal(h.found, true);
  assert.doesNotMatch(h.nextAction ?? "", /BLIND/, "a stale degraded line must not outlive the recovery");
});
