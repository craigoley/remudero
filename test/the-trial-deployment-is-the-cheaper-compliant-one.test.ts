/**
 * W1-T3598 — THE BOUNDED TRIAL SHOULD RIDE THE CHEAPER, MORE COMPLIANT DEPLOYMENT.
 *
 * gpt-5-nano is cheaper than gpt-oss-120b on both token axes and is Azure-OpenAI-family, so it
 * rides the route the adapter already builds. These fixtures pin PRICE and ROUTING only: whether
 * its OUTPUT is better is W1-T3570's measured trial to decide, not this suite's.
 *
 * The fallback assertions matter as much as the leading ones. gpt-oss-120b trails rather than being
 * deleted, so a deployment that stops answering degrades the lane instead of killing it — and a
 * test that only checked the leading entry would pass identically if the fallback had been dropped.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { fixedClock } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import {
  openWeightCandidatesForCapability,
  openWeightPriceFor,
  openWeightReservationUsd,
  openWeightUsageUsd,
  spawnOpenWeightWorker,
} from "../src/lib/worker-provider.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOUNTS = join(REPO_ROOT, ".remudero", "mounts.yaml");
const NANO = "gpt-5-nano";
const OSS = "gpt-oss-120b";

function ladder(): Record<string, Record<string, string[]>> {
  const parsed = parseYaml(readFileSync(MOUNTS, "utf8")) as {
    capabilities?: { openweight?: Record<string, Record<string, string[]>> };
  };
  const rows = parsed.capabilities?.openweight;
  assert.ok(rows, ".remudero/mounts.yaml must declare capabilities.openweight");
  return rows;
}

test("the openweight ladder leads with gpt-5-nano and keeps gpt-oss reachable", () => {
  const rows = ladder();

  for (const capability of ["economy", "balanced"] as const) {
    for (const effort of ["low", "medium", "high"] as const) {
      const row = rows[capability]?.[effort];
      assert.ok(Array.isArray(row), `${capability}.${effort} must be an ordered candidate list`);
      assert.equal(row[0], NANO, `${capability}.${effort} must LEAD with the cheaper deployment`);
      // THE FALLBACK ARM. Without this, deleting gpt-oss-120b from these rows would pass — and that
      // is the regression that turns a bad deployment day into a dead lane rather than a degraded one.
      assert.ok(row.includes(OSS), `${capability}.${effort} must keep ${OSS} reachable as a fallback`);
      assert.ok(row.indexOf(NANO) < row.indexOf(OSS), "the cheaper deployment must be preferred, not merely present");
    }
  }

  // FRONTIER IS DELIBERATELY UNCHANGED: a nano-class model is not a frontier substitute. Asserting
  // this is what stops the ladder collapsing back into one deployment for every tier.
  for (const effort of ["low", "medium", "high"] as const) {
    const row = rows.frontier?.[effort];
    assert.deepEqual(row, [OSS], `frontier.${effort} must stay on ${OSS}`);
  }

  // And the real resolver agrees with the file, so this is about what the fleet SELECTS rather than
  // about YAML that nothing reads.
  const capabilities = { openweight: rows } as never;
  assert.equal(openWeightCandidatesForCapability(capabilities, "economy", "low")[0], NANO);
  assert.equal(openWeightCandidatesForCapability(capabilities, "balanced", "high")[0], NANO);
  assert.deepEqual(openWeightCandidatesForCapability(capabilities, "frontier", "medium"), [OSS]);
});

test("gpt-5-nano reserves and settles strictly less than gpt-oss-120b", () => {
  const nano = openWeightPriceFor(NANO);
  const oss = openWeightPriceFor(OSS);

  // The rows must genuinely differ in the direction claimed, or everything below is a tautology.
  assert.ok(nano.inputUsdPerMillion < oss.inputUsdPerMillion, "nano must be cheaper on input");
  assert.ok(nano.outputUsdPerMillion < oss.outputUsdPerMillion, "nano must be cheaper on output");

  // SAME REQUEST, TWO DEPLOYMENTS: the figures differ because the ROWS differ, not because the
  // arithmetic differs. This is what would break if either consumer re-acquired a shared constant.
  const bytes = 4_096;
  assert.ok(
    openWeightReservationUsd(NANO, bytes) < openWeightReservationUsd(OSS, bytes),
    "an identical request must reserve strictly less on the cheaper deployment",
  );

  const promptTokens = 180_000;
  const completionTokens = 2_000;
  const nanoUsd = openWeightUsageUsd(NANO, promptTokens, completionTokens);
  const ossUsd = openWeightUsageUsd(OSS, promptTokens, completionTokens);
  assert.ok(nanoUsd < ossUsd, `settled cost must be lower on the cheaper deployment: ${nanoUsd} !< ${ossUsd}`);

  // THE FIGURE THE TRIAL ACTUALLY TURNS ON. At a full-context turn, the dearer deployment exhausts a
  // $5 day well before inbox_draft's 400-turn mount; the cheaper one covers it. This asserts the
  // ORDERING that argument depends on, not a predicted turn count — the real per-turn usage is what
  // W1-T3570 measures.
  assert.ok(5 / ossUsd < 400, "gpt-oss-120b exhausts a $5 day before a 400-turn run, which is why this task exists");
  assert.ok(5 / nanoUsd > 400, "gpt-5-nano must cover a 400-turn run within the same $5 day");
});

test("gpt-5-nano dispatches through the existing azure deployment route", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-nano-route-"));
  try {
    const urls: string[] = [];
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home"),
        prompt: "classify",
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        clock: fixedClock(Date.parse("2026-09-15T12:00:00.000Z")),
        fetchImpl: async (input) => {
          urls.push(String(input));
          return new Response(
            JSON.stringify({ id: "nano", usage: { prompt_tokens: 1_000, completion_tokens: 200 }, choices: [{ message: { content: "DRAFTED" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
      {
        claudeBin: "/unused/claude",
        root,
        dailyCapUsd: 5,
        workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
      } as Config,
      { model: NANO, effort: "low" },
    );

    assert.equal(result.isError, false);
    assert.equal(urls.length, 1);
    // THE SAME ROUTE SHAPE, not a second endpoint: deployment in the PATH, Azure OpenAI api-version.
    // If nano had needed the Azure AI Model Inference `/models` route this assertion would fail, which
    // is precisely the distinction that kept Phi-4-mini out of this task.
    assert.match(urls[0] ?? "", /\/openai\/deployments\/gpt-5-nano\/chat\/completions\?api-version=/);
    assert.doesNotMatch(urls[0] ?? "", /\/models\/chat\/completions/, "no second endpoint shape is introduced");

    // Priced by its OWN row on the way through, so the ledger figure is the nano rate.
    assert.equal(result.costUsd, openWeightUsageUsd(NANO, 1_000, 200));
    assert.ok(result.costUsd < openWeightUsageUsd(OSS, 1_000, 200), "the same usage bills less than it would on gpt-oss-120b");
    assert.doesNotMatch(JSON.stringify(result), /test-only-daemon-secret/, "no result field carries the Azure key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the code fallback and the mounts ladder name one leading deployment", () => {
  const rows = ladder();
  // `FALLBACK_OPENWEIGHT_MODELS` is not exported, so drive the real resolver with NO table — which
  // is exactly the checkout-without-mounts case the fallback exists for.
  for (const capability of ["economy", "balanced", "frontier"] as const) {
    for (const effort of ["low", "medium", "high"] as const) {
      const fromFallback = openWeightCandidatesForCapability(undefined, capability, effort);
      const fromLadder = rows[capability]?.[effort];
      assert.equal(
        fromFallback[0],
        fromLadder?.[0],
        `${capability}.${effort}: a checkout with no mounts table must lead with the same deployment as one with it`,
      );
    }
  }

  // The divergence this guards is DIRECTIONAL: if they disagreed, the tableless checkout would route
  // the DEARER deployment while the configured fleet routed the cheaper, and nothing would say so.
  assert.equal(openWeightCandidatesForCapability(undefined, "economy", "low")[0], NANO);
  assert.ok(openWeightCandidatesForCapability(undefined, "economy", "low").includes(OSS), "the fallback keeps gpt-oss reachable too");
  assert.deepEqual(openWeightCandidatesForCapability(undefined, "frontier", "high"), [OSS]);
});
