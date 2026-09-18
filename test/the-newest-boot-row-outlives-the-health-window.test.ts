// @source-text-subject: lib/ledger.ts's PASS 2 retention of the newest `daemon.boot` row.

import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ledgerExceedsRotationCeiling, rotateLedger } from "../src/lib/ledger.js";
import { readLatestBootSha } from "../src/lib/deployer.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

// ── W1-T3755 — THE RUNNING HEAD MUST OUTLIVE THE HEALTH WINDOW ───────────────────────────────
//
// MEASURED 2026-09-18: a daemon booted at 00:49 and was still running at 06:00, but its
// `daemon.boot` row — the only record of the sha that process booted on — was gone. Present in
// the 00:52 and 01:52 rotation snapshots, absent from 04:28, zero in the live ledger. So
// `readLatestBootSha` returned `undefined`, the deployer could not rule out mount staleness, and
// the board reported STALE against a sha the running process had never booted on, prescribing
// `rmd deploy` — which skips on the same missing record.
//
// These assert through `readLatestBootSha` deliberately: that is the consumer that was broken, and
// a test of the row count alone would pass while the thing anyone cares about still failed.

const CEILING = 200_000;
const OLD_BOOT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_BOOT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AGED_DEPLOY_ROW = "aged out with the rest";

/** Drive a real rotation past the ceiling, the way test/breaker-guard-survives-rotation.test.ts
 *  does: pad with the `ci.polling` noise PASS 1 archives, so the file crosses on NOISE and the
 *  retained core is bounded by PASS 2 rather than by the convergence shed. */
function rotatePastCeiling(path: string): void {
  let n = 0;
  while (!ledgerExceedsRotationCeiling(path, CEILING)) {
    const noise = Array.from({ length: 200 }, () =>
      JSON.stringify({ ts: "2026-08-26T00:00:00.000Z", step: "ci.polling", run_id: `noise-${n++}`, detail: "x".repeat(96) }),
    ).join("\n");
    appendFileSync(path, noise + "\n");
  }
  rotateLedger(path, { ceilingBytes: CEILING });
}

/** Stages the scenario: health rows all FAR outside the retention window, then a real rotation.
 *  The ledger itself is built by the SHARED fixture (W1-T2903, written after an audit counted 26
 *  hand-rolled ledger helpers) — this only arranges the rows and drives the rotation. */
function bootRowsAgedPastTheWindow(): string {
  const { path } = writeLedger([
    { ts: "2026-08-26T00:00:00.000Z", step: "daemon.boot", head_sha: OLD_BOOT },
    { ts: "2026-08-26T01:00:00.000Z", step: "daemon.boot", head_sha: NEW_BOOT },
    { ts: "2026-08-26T01:05:00.000Z", step: "deploy.skip", reason: AGED_DEPLOY_ROW },
  ]);
  rotatePastCeiling(path);
  return path;
}

test("the newest boot row outlives the health window, so the running head is still readable", () => {
  // The consumer that was returning undefined on the live fleet.
  assert.equal(readLatestBootSha(bootRowsAgedPastTheWindow()), NEW_BOOT);
});

test("exactly one boot row is exempt — an older one still ages out, so a restart storm cannot bloat the core", () => {
  const live = readFileSync(bootRowsAgedPastTheWindow(), "utf8");
  const bootRows = live.split("\n").filter((l) => l.includes('"step":"daemon.boot"'));
  assert.equal(bootRows.length, 1, "a second aged boot row survived — PASS 2's anti-spam bound is gone");
  assert.ok(!live.includes(OLD_BOOT), "the older boot row must still age out");
});

test("the retention window is unchanged — a non-boot health row outside it still ages out", () => {
  const live = readFileSync(bootRowsAgedPastTheWindow(), "utf8");
  // `deploy.skip` is health-or-deploy too. If widening the window were the fix, this would survive.
  assert.ok(!live.includes(AGED_DEPLOY_ROW), "an aged deploy row survived — the window itself was widened");
});
