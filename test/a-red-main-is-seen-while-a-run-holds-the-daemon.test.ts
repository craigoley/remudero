import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as mainHealth from "../src/lib/main-health-rung.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";

// 2026-10-09: main went red at 13:52Z (#10349 x #10353) while fleet runs held the daemon. Only the
// full sweep observed main, and it ran at 14:01Z and next at 14:49Z, so rmd never saw the red and a
// person fixed it. The light pass, which keeps running beside a run, now observes main too.

const OWNER = "craigoley";
const REPO = "remudero";
const RED_SHA = "4e8cbb29f4dbf29ab61bc9293ea371e03011c72e";

function redMainFetch(): GhApiFetcher {
  return (async (args: string[]) => {
    const path = args[1] ?? "";
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "main" };
    if (path === `repos/${OWNER}/${REPO}/commits/main`) return { sha: RED_SHA };
    if (path === `repos/${OWNER}/${REPO}/commits/${RED_SHA}/check-runs?per_page=100`) {
      return { check_runs: [{ name: "typecheck", status: "completed", conclusion: "failure" }] };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/${RED_SHA}/status`) return { statuses: [] };
    if (path.startsWith(`repos/${OWNER}/${REPO}/actions/runs?branch=main`)) {
      return { workflow_runs: [{ head_sha: RED_SHA, conclusion: "failure" }] };
    }
    return {};
  }) as unknown as GhApiFetcher;
}

test("a light pass observes a red main through the real rung", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}light-main-`));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const rung = mainHealth.buildMainHealthRung(OWNER, REPO, {
      fetch: redMainFetch(),
      issues: { create: () => "https://github.com/craigoley/remudero/issues/1", listOpen: () => [] },
      ledgerPath,
      runId: "DAEMON-1",
      log: (step, extra) => {
        rows.push({ step, extra });
      },
      readRequiredChecks: () => ["typecheck"],
    });
    let lightPasses = 0;
    const light = mainHealth.withMainHealthOnLightPass(async () => {
      lightPasses += 1;
    }, rung);
    await light();
    assert.equal(lightPasses, 1);
    const observed = rows.find((r) => r.step === "main.health.observed");
    assert.ok(observed, `the light pass never observed main: ${JSON.stringify(rows.map((r) => r.step))}`);
    assert.equal(observed.extra?.state, "red");
    assert.equal(observed.extra?.sha, RED_SHA);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the light pass observes main at most once per interval, and again after it", async () => {
  let clock = 1_000_000;
  let observations = 0;
  let lightPasses = 0;
  const light = mainHealth.withMainHealthOnLightPass(
    async () => {
      lightPasses += 1;
    },
    async () => {
      observations += 1;
    },
    { clock: { now: () => clock, date: () => new Date(clock), iso: () => new Date(clock).toISOString() } },
  );
  await light();
  clock += 10_000;
  await light();
  clock += 10_000;
  await light();
  assert.equal(lightPasses, 3);
  assert.equal(observations, 1);
  clock += mainHealth.MAIN_HEALTH_LIGHT_PASS_INTERVAL_MS;
  await light();
  assert.equal(observations, 2);
});

test("a failing rung is logged and never stops the light pass", async () => {
  const logged: string[] = [];
  let lightPasses = 0;
  const light = mainHealth.withMainHealthOnLightPass(
    async () => {
      lightPasses += 1;
    },
    async () => {
      throw new Error("GitHub unavailable");
    },
    { log: (step) => logged.push(step) },
  );
  await light();
  assert.equal(lightPasses, 1);
  assert.deepEqual(logged, ["main.health.error"]);
});
