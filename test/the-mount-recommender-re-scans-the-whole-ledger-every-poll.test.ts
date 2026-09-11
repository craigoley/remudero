import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  MOUNT_RECOMMENDER_CADENCE_POLICY,
  runMountRecommenderRung,
} from "../src/run-task.js";
import { fixedClock } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import type { MountHeadroomCell } from "../src/lib/mount-recommender.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
}

function readMarker(root: string): { lastFireIso: string } {
  return JSON.parse(readFileSync(join(root, "state", "last-mount-recommender.json"), "utf8")) as { lastFireIso: string };
}

test("runMountRecommenderRung: the daily marker gates in-interval polls and is written before the sweep", async () => {
  const root = tmp("rmd-mount-cadence-");
  try {
    const config = { claudeBin: "/bin/true", root, overflow: "none" } as Config;
    const events: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const log = (step: string, extra: Record<string, unknown> = {}) => events.push({ step, extra });
    const first = new Date("2026-09-08T00:00:00.000Z");
    let calls = 0;

    const buildMountHeadroomSweep = (stateDir: string): { cells: MountHeadroomCell[] } => {
      calls++;
      assert.equal(stateDir, join(root, "state"));
      assert.equal(readMarker(root).lastFireIso, calls === 1 ? first.toISOString() : "2026-09-09T00:00:00.000Z");
      return { cells: [] };
    };

    assert.deepEqual(
      await runMountRecommenderRung(config, "run-1", log, {
        root: REPO_ROOT,
        clock: fixedClock(first.getTime()),
        buildMountHeadroomSweep,
      }),
      { filed: 0, refused: 0 },
    );
    assert.equal(calls, 1, "the first poll with no marker sweeps");
    assert.equal(readMarker(root).lastFireIso, first.toISOString(), "the marker is written before the sweep builder runs");

    const insideInterval = new Date(first.getTime() + 60 * 60 * 1000);
    assert.deepEqual(
      await runMountRecommenderRung(config, "run-2", log, {
        root: REPO_ROOT,
        clock: fixedClock(insideInterval.getTime()),
        buildMountHeadroomSweep,
      }),
      { filed: 0, refused: 0 },
    );
    assert.equal(calls, 1, "an in-interval poll is a no-op");

    const skipped = events.find((event) => event.step === "mount_recommendation.skipped");
    assert.ok(skipped, "a throttled poll is observable rather than silent");
    assert.deepEqual(skipped.extra, {
      run_id: "run-2",
      cadence_kind: MOUNT_RECOMMENDER_CADENCE_POLICY.kind,
      interval_ms: MOUNT_RECOMMENDER_CADENCE_POLICY.intervalMs,
      last_fire_iso: first.toISOString(),
      next_fire_iso: "2026-09-09T00:00:00.000Z",
    });

    await runMountRecommenderRung(config, "run-3", log, {
      root: REPO_ROOT,
      clock: fixedClock(Date.parse("2026-09-09T00:00:00.000Z")),
      buildMountHeadroomSweep,
    });
    assert.equal(calls, 2, "the first poll due after the interval sweeps again");
    assert.equal(readMarker(root).lastFireIso, "2026-09-09T00:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMountRecommenderRung: its interval is a declared policy constant with a kind tag", () => {
  assert.deepEqual(MOUNT_RECOMMENDER_CADENCE_POLICY, {
    kind: "daily-ledger-evidence-accrual",
    intervalMs: 24 * 60 * 60 * 1000,
  });
});

test("runMountRecommenderRung: a crash after the pre-work marker costs one skipped window", async () => {
  const root = tmp("rmd-mount-cadence-crash-");
  try {
    const config = { claudeBin: "/bin/true", root, overflow: "none" } as Config;
    const events: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const log = (step: string, extra: Record<string, unknown> = {}) => events.push({ step, extra });
    const now = new Date("2026-09-08T00:00:00.000Z");

    const crashed = await runMountRecommenderRung(config, "run-1", log, {
      root: REPO_ROOT,
      clock: fixedClock(now.getTime()),
      buildMountHeadroomSweep: () => {
        throw new Error("boom after marker");
      },
    });
    assert.deepEqual(crashed, { filed: 0, refused: 0 });
    assert.equal(readMarker(root).lastFireIso, now.toISOString(), "the marker survives a crash inside the rung");
    assert.ok(events.some((event) => event.step === "mount_recommendation.error"));

    let callsAfterCrash = 0;
    await runMountRecommenderRung(config, "run-2", log, {
      root: REPO_ROOT,
      clock: fixedClock(now.getTime() + 60 * 60 * 1000),
      buildMountHeadroomSweep: () => {
        callsAfterCrash++;
        return { cells: [] };
      },
    });
    assert.equal(callsAfterCrash, 0, "the next in-window poll skips instead of re-sweeping after the crash");
    assert.ok(existsSync(join(root, "state", "last-mount-recommender.json")));
    assert.ok(events.some((event) => event.step === "mount_recommendation.skipped"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
