/**
 * W1-T3598 — THE BOUNDED TRIAL SHOULD RIDE THE CHEAPER, MORE COMPLIANT DEPLOYMENT.
 * W1-T3614 — AND "CHEAPER" IS PER TASK, NOT PER TOKEN, SO THE TWO ROWS DIVERGE.
 *
 * gpt-5-nano is cheaper than gpt-oss-120b on both token axes, which is why W1-T3598 led every row
 * with it. Measured per TASK on 2026-09-15 that holds only where the prompt is large, because nano
 * spends ~5x the completion tokens on reasoning:
 *
 *     lane                input    gpt-oss out   nano out   cheaper
 *     inbox_draft       259,181        452         2,207     nano,    2.83x
 *     escalation judge      446        177           993     gpt-oss, 2.40x
 *
 * So `balanced` (large-context lanes) still leads with nano and `economy` (short-prompt, high-volume
 * lanes such as the zero-tool judges) now leads with gpt-oss. Whether either model's OUTPUT is
 * better remains W1-T3570's measured trial to decide, not this suite's.
 *
 * The fallback assertions matter as much as the leading ones: each row keeps BOTH deployments, so a
 * deployment that stops answering degrades the lane instead of killing it — and a test that only
 * checked the leading entry would pass identically if the fallback had been dropped.
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
const LUNA = "gpt-5.6-luna";
const TERRA = "gpt-5.6-terra";

function ladder(): Record<string, Record<string, string[]>> {
  const parsed = parseYaml(readFileSync(MOUNTS, "utf8")) as {
    capabilities?: {
      cash?: Record<string, Record<string, string[]>>;
      openweight?: Record<string, Record<string, string[]>>;
    };
  };
  // W1-T3607 renamed this table's key to `cash`. Resolved in the same order production does
  // (`openWeightCandidatesForCapability`, worker-provider.ts): canonical first, the deprecated
  // spelling as a fallback, so a table that has not been renamed yet still reads here.
  const rows = parsed.capabilities?.cash ?? parsed.capabilities?.openweight;
  assert.ok(rows, ".remudero/mounts.yaml must declare capabilities.cash (or the deprecated capabilities.openweight)");
  // ... and this repo's OWN table must be the canonical spelling, not merely a readable one. The
  // fallback above exists for a foreign or not-yet-migrated table; letting it quietly cover this
  // checkout would leave the rename half-done with nothing reporting it.
  assert.ok(parsed.capabilities?.cash, "this repo's mounts table must use the canonical `cash` key, not the deprecated alias");
  return rows;
}

test("the openweight ladder leads each row with the deployment measured cheaper for its prompt shape", () => {
  const rows = ladder();

  // W1-T3614: the LEAD differs by capability because the winner differs by input:output ratio.
  // economy = short-prompt, high-volume (the zero-tool judges); balanced = large-context lanes.
  const leadFor = { economy: OSS, balanced: NANO } as const;

  for (const capability of ["economy", "balanced"] as const) {
    for (const effort of ["low", "medium", "high"] as const) {
      const row = rows[capability]?.[effort];
      const lead = leadFor[capability];
      const trail = lead === NANO ? OSS : NANO;
      assert.ok(Array.isArray(row), `${capability}.${effort} must be an ordered candidate list`);
      assert.equal(row[0], lead, `${capability}.${effort} must LEAD with the deployment measured cheaper for its prompt shape`);
      // THE FALLBACK ARMS. Without these, deleting a trailing deployment would pass — and that is
      // the regression that turns a bad deployment day into a dead lane rather than a degraded one.
      assert.ok(row.includes(trail), `${capability}.${effort} must keep ${trail} reachable as a fallback`);
      assert.ok(row.indexOf(lead) < row.indexOf(trail), "the measured-cheaper deployment must be preferred, not merely present");
      assert.equal(row.at(-1), LUNA, `${capability}.${effort} must keep Luna available to the cash squeeze selector`);
    }
  }

  // AND THE TWO ROWS MUST GENUINELY DIVERGE, or this test would pass on a table that had collapsed
  // back to one lead everywhere — the exact regression the measurement above argues against.
  assert.notEqual(rows.economy?.low?.[0], rows.balanced?.low?.[0], "economy and balanced must not share a lead");

  // FRONTIER (measured 2026-09-16) LEADS WITH gpt-5.6-luna: it is on this row for capability alone
  // (5x nano on both cost axes), and gpt-oss-120b trails as the fallback rather than being dropped
  // -- a single-candidate row is what this ladder is deliberately no longer allowed to have.
  for (const effort of ["low", "medium", "high"] as const) {
    const row = rows.frontier?.[effort];
    assert.deepEqual(row, [LUNA, TERRA], `frontier.${effort} must lead with ${LUNA} and keep ${TERRA} as the escalation`);
  }

  // And the real resolver agrees with the file, so this is about what the fleet SELECTS rather than
  // about YAML that nothing reads.
  const capabilities = { openweight: rows } as never;
  assert.equal(openWeightCandidatesForCapability(capabilities, "economy", "low")[0], OSS);
  assert.equal(openWeightCandidatesForCapability(capabilities, "balanced", "high")[0], NANO);
  assert.deepEqual(openWeightCandidatesForCapability(capabilities, "frontier", "medium"), [LUNA, TERRA]);
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
  // W1-T3614: economy's lead is gpt-oss (short prompts), balanced's is nano (large context). Both
  // are pinned here so a tableless checkout cannot quietly adopt a single lead for every capability.
  // frontier's lead is gpt-5.6-luna, which replaced gpt-5-mini outright (cheaper on both
  // axes, 0 reasoning tokens where mini spent 64 of 76). gpt-5.6-terra is the ESCALATION behind it,
  // at 10x luna, reached only when luna is unavailable.
  assert.equal(openWeightCandidatesForCapability(undefined, "economy", "low")[0], OSS);
  assert.ok(openWeightCandidatesForCapability(undefined, "economy", "low").includes(NANO), "the fallback keeps gpt-5-nano reachable too");
  assert.ok(openWeightCandidatesForCapability(undefined, "economy", "low").includes(LUNA), "the fallback keeps Luna reachable for a cash squeeze too");
  assert.equal(openWeightCandidatesForCapability(undefined, "balanced", "high")[0], NANO);
  assert.deepEqual(openWeightCandidatesForCapability(undefined, "frontier", "high"), [LUNA, TERRA]);
});
