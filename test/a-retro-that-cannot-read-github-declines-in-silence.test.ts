import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { retroTriggerCheck } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import { saveMarker, type ShippedGithub } from "../src/lib/retro.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1_000;

function gateway(unavailable: string | undefined): ShippedGithub {
  return {
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    unavailable: () => unavailable,
  };
}

function fixture(): { root: string; config: Config; markerPath: string; ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-decline-"));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  return {
    root,
    config: { claudeBin: "/bin/true", root },
    markerPath: join(state, "last-retro.json"),
    ledgerPath: join(state, "ledger.ndjson"),
  };
}

function rows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("an unavailable GitHub read declines once with its reason and marker age, while healthy decisions stay unchanged", () => {
  const fx = fixture();
  try {
    saveMarker(fx.markerPath, {
      ts: "2026-09-05T12:00:00.000Z",
      learnings_count: 0,
      runs_seen: 0,
    });
    const unavailable = gateway("gh: Bad credentials (HTTP 401)");

    const first = retroTriggerCheck(NOW, { config: fx.config, github: unavailable });
    const repeated = retroTriggerCheck(NOW, { config: fx.config, github: unavailable });
    assert.equal(first, undefined, "the diagnostic must not manufacture a retro decision");
    assert.equal(repeated, undefined, "a repeated outage must still decline");

    const declined = rows(fx.ledgerPath).filter((row) => row.step === "daemon.retro_trigger.declined");
    assert.equal(declined.length, 1, "one incident is reported once, not once per daemon tick");
    assert.equal(declined[0]!.outcome, "declined");
    assert.equal(declined[0]!.reason, "gh: Bad credentials (HTTP 401)");
    assert.equal(declined[0]!.marker_ts, "2026-09-05T12:00:00.000Z");
    assert.equal(declined[0]!.marker_age_ms, FIVE_DAYS_MS);

    const skipped = retroTriggerCheck(NOW, { config: fx.config, github: gateway(undefined) });
    assert.equal(skipped?.fire, false, "a healthy five-day marker remains below the seven-day threshold");
    assert.equal(rows(fx.ledgerPath).length, 1, "the healthy path writes no new row");

    const fired = retroTriggerCheck(new Date("2026-09-14T12:00:00.000Z"), {
      config: fx.config,
      github: gateway(undefined),
    });
    assert.equal(fired?.fire, true, "the ordinary readable days-threshold path still fires");
    assert.equal(fired?.reason, "days");
    assert.equal(rows(fx.ledgerPath).length, 1, "a readable decision remains byte-identical in ledger effects");

    const nextIncident = retroTriggerCheck(NOW, { config: fx.config, github: unavailable });
    assert.equal(nextIncident, undefined);
    assert.equal(
      rows(fx.ledgerPath).filter((row) => row.step === "daemon.retro_trigger.declined").length,
      2,
      "a healthy observation rearms reporting for a later outage without persisting a retry or latch",
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
