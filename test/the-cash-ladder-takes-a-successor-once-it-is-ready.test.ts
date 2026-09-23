import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { fixedClock } from "../src/lib/clock.js";
import { loadMounts, mountsPath, type CapabilityLadder } from "../src/lib/mounts.js";
import {
  clearOpenWeightAbsence,
  markOpenWeightDeploymentAbsent,
  OPENWEIGHT_ABSENT_TTL_MS,
  OPENWEIGHT_ALLOWANCE_FILENAME,
  openWeightDeploymentKnownAbsent,
  openWeightDeploymentReady,
  selectOpenWeightModel,
  spawnOpenWeightWorker,
  type OpenWeightAllowanceState,
} from "../src/lib/worker-provider.js";
import { runOpenWeightWalkingLadder, type WorkerResult } from "../src/lib/worker.js";

// W1-T4079 (operator ruling 2026-09-22): stay on gpt-5.6 for the Azure cash ladder, switch to GPT-6
// automatically once it is available, forwards- and backwards-compatible. MEASURED that day: Azure
// lists gpt-6-luna but a request to that deployment answers 404; the gpt-5.6-luna deployment exists.

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-09-23T01:00:00.000Z");

function ladder(): CapabilityLadder {
  const value = loadMounts(mountsPath(REPO_ROOT)).capabilities;
  assert.ok(value);
  return value;
}

test("W1-T4079: an undeployed successor is skipped, not selected", () => {
  clearOpenWeightAbsence();
  try {
    // Treat gpt-6-luna as fully configured so only its absence is under test.
    const ready = (d: string) => d === "gpt-6-luna" ? !openWeightDeploymentKnownAbsent(d, NOW) : openWeightDeploymentReady(d, NOW);
    assert.equal(selectOpenWeightModel(ladder(), "opus", "high", undefined, { ready }).model, "gpt-6-luna", "control: ready, it leads");
    markOpenWeightDeploymentAbsent("gpt-6-luna", NOW);
    const picked = selectOpenWeightModel(ladder(), "opus", "high", undefined, { ready });
    assert.equal(picked.model, "gpt-5.6-luna", "after a 404 the row resolves to the model behind it");
    assert.equal(openWeightDeploymentKnownAbsent("gpt-6-luna", NOW + OPENWEIGHT_ABSENT_TTL_MS + 1), false, "the absence is re-asked after its TTL");
  } finally {
    clearOpenWeightAbsence();
  }
});

test("W1-T4079: an unpriced successor is skipped", () => {
  clearOpenWeightAbsence();
  assert.equal(openWeightDeploymentReady("gpt-6-luna", NOW), false, "no price, temperature or context row yet");
  assert.equal(openWeightDeploymentReady("gpt-5.6-luna", NOW), true);
  // The committed table lists gpt-6-luna first, and every lane still resolves exactly as before.
  const rows = ladder().cash!;
  assert.equal(rows.frontier.high[0], "gpt-6-luna");
  assert.equal(selectOpenWeightModel(ladder(), "opus", "high").model, "gpt-5.6-luna");
  assert.equal(selectOpenWeightModel(ladder(), "opus", "high", undefined, { cashSqueezed: true }).model, "gpt-5.6-luna");
  assert.equal(selectOpenWeightModel(ladder(), "haiku", "low").model, "gpt-oss-120b");
});

test("W1-T4079: a ready successor is selected with no edit", () => {
  clearOpenWeightAbsence();
  const ready = (d: string) => d === "gpt-6-luna" || openWeightDeploymentReady(d, NOW);
  assert.equal(selectOpenWeightModel(ladder(), "opus", "high", undefined, { ready }).model, "gpt-6-luna");
  assert.equal(
    selectOpenWeightModel(ladder(), "sonnet", "high", undefined, { ready, cashSqueezed: true }).model,
    "gpt-6-luna",
    "a squeeze promotes every Luna generation, newest first",
  );
});

test("W1-T4079: an unknown probe keeps the previous reading", async () => {
  clearOpenWeightAbsence();
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-successor-"));
  try {
    const config = { claudeBin: "/unused", root, dailyCapUsd: 5, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } } as Config;
    const attempt = (status: number, body: string) =>
      spawnOpenWeightWorker(
        {
          cwd: root,
          workerHome: join(root, "worker-home"),
          prompt: "classify",
          env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
          clock: fixedClock(NOW),
          fetchImpl: async () => new Response(body, { status }),
        },
        config,
        { model: "gpt-5.6-luna", effort: "low" },
      );
    const notFound = await attempt(404, '{"error":{"code":"DeploymentNotFound"}}');
    assert.equal(notFound.openWeightDeploymentAbsent, "gpt-5.6-luna", "a 404 is reported as an absent deployment");
    const allowance = JSON.parse(readFileSync(join(root, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8")) as OpenWeightAllowanceState;
    assert.deepEqual(Object.values(allowance.reservations).map((r) => r.settledUsd), [0], "a 404 billed nothing, so it settles to zero");

    const timeout = await attempt(503, "unavailable");
    assert.equal(timeout.openWeightDeploymentAbsent, undefined, "any other failure is not evidence of absence");
    assert.equal(openWeightDeploymentKnownAbsent("gpt-5.6-luna", NOW), false, "the adapter alone never marks; only the ladder does");
  } finally {
    rmSync(root, { recursive: true, force: true });
    clearOpenWeightAbsence();
  }
});

test("the walking ladder passes an absent rung and remembers it", async () => {
  clearOpenWeightAbsence();
  try {
    const tried: string[] = [];
    const result = await runOpenWeightWalkingLadder(async (selection) => {
      tried.push(selection.model);
      return (selection.model === "gpt-6-luna"
        ? { isError: true, openWeightDeploymentAbsent: "gpt-6-luna" }
        : { isError: false }) as WorkerResult;
    }, { model: "gpt-6-luna", effort: "high", capability: "frontier", alternatives: ["gpt-5.6-luna"] });
    assert.deepEqual(tried, ["gpt-6-luna", "gpt-5.6-luna"]);
    assert.equal(result.isError, false);
    assert.equal(result.routedModel, "gpt-5.6-luna");
    assert.equal(openWeightDeploymentKnownAbsent("gpt-6-luna"), true, "the next selection passes over it");

    const lastRung = await runOpenWeightWalkingLadder(async () => ({ isError: true, openWeightDeploymentAbsent: "only" }) as WorkerResult,
      { model: "only", effort: "high", capability: "frontier", alternatives: [] });
    assert.equal(lastRung.isError, true, "with no rung left the absent result is returned, exactly as before");
  } finally {
    clearOpenWeightAbsence();
  }
});
