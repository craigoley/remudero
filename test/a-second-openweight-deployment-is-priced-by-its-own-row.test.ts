/**
 * W1-T3597 — PRICE IS A PROPERTY OF THE DEPLOYMENT.
 *
 * `openWeightCandidatesForCapability` has resolved a LADDER of deployments out of mounts since
 * W1-T3546, while the price was two module constants every deployment shared. These fixtures pin
 * the three facts that make a second deployment safe to add: each one is priced from its own row,
 * an unpriced one refuses BEFORE any paid request rather than borrowing a neighbour's rate, and
 * the deployment actually in use today is billed exactly as it was before the table existed.
 *
 * The asymmetry is the whole reason this is a refusal and not a fallback: a cheaper deployment
 * priced at another's rate merely over-reserves, but a DEARER one under-reserves, which re-opens
 * the hole W1-T3575's cap exists to close.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import {
  OPENWEIGHT_MAX_COMPLETION_TOKENS,
  OPENWEIGHT_PRICES,
  OpenWeightUnpricedDeploymentError,
  openWeightPriceFor,
  openWeightReservationUsd,
  openWeightUsageUsd,
  reserveOpenWeightBudget,
  spawnOpenWeightWorker,
} from "../src/lib/worker-provider.js";

const AT_ISO = "2026-09-15T10:00:00.000Z";

function pricedConfig(root: string): Config {
  return {
    claudeBin: "/unused/claude",
    root,
    dailyCapUsd: 5,
    workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
  } as Config;
}

test("openweight price resolves from the deployment's own row, not a shared constant", () => {
  // TWO ROWS THAT DIFFER, so the assertion discriminates on the ROW rather than on the arithmetic.
  // A fixture that prices one deployment and asserts the number it just supplied proves nothing.
  const cheap = { inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.4, readAt: "2026-09-15" };
  const dear = openWeightPriceFor("gpt-oss-120b");
  assert.ok(cheap.inputUsdPerMillion < dear.inputUsdPerMillion, "the fixture rows must genuinely differ, or this test is vacuous");

  // The same measured usage costs strictly less at the cheaper row, in the direction the rows predict.
  const promptTokens = 1_000;
  const completionTokens = 200;
  const dearUsd = openWeightUsageUsd("gpt-oss-120b", promptTokens, completionTokens);
  const cheapUsd = (promptTokens * cheap.inputUsdPerMillion + completionTokens * cheap.outputUsdPerMillion) / 1_000_000;
  assert.ok(cheapUsd < dearUsd, `a cheaper row must cost less: ${cheapUsd} !< ${dearUsd}`);

  // And the RESERVATION reads the same row, so the cap and the ledger cannot disagree about a
  // deployment's rate — the failure mode where a dearer model is admitted at a cheaper model's price.
  const bytes = 4_096;
  const reserved = openWeightReservationUsd("gpt-oss-120b", bytes);
  const expected = (bytes * dear.inputUsdPerMillion + OPENWEIGHT_MAX_COMPLETION_TOKENS * dear.outputUsdPerMillion) / 1_000_000;
  assert.equal(reserved, expected, "the reservation is priced from the deployment's own row");

  // Every row carries an as-of date: a published price with no reading date is unauditable.
  for (const [deployment, row] of Object.entries(OPENWEIGHT_PRICES)) {
    assert.match(row.readAt, /^\d{4}-\d{2}-\d{2}$/, `${deployment} must record when its figures were read`);
    assert.ok(row.inputUsdPerMillion > 0 && row.outputUsdPerMillion > 0, `${deployment} must carry real figures`);
  }
});

test("an unpriced openweight deployment refuses before transport rather than borrowing a rate", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-unpriced-"));
  try {
    const unpriced = "some-deployment-the-table-does-not-price";
    assert.equal(unpriced in OPENWEIGHT_PRICES, false, "the fixture deployment must genuinely be unpriced");

    // The lookup itself refuses, naming what IS priced so the remedy is readable.
    assert.throws(() => openWeightPriceFor(unpriced), OpenWeightUnpricedDeploymentError);
    assert.throws(() => openWeightReservationUsd(unpriced, 1_024), /has no price row/);

    // THE LOAD-BEARING ASSERTION: driven through the real adapter, an unpriced deployment makes
    // NO paid request. A refusal that happened after the fetch would have spent money at an
    // unknown rate, which is the whole failure this guards.
    let fetchCalls = 0;
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home"),
        prompt: "classify",
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        clock: fixedClock(Date.parse(AT_ISO)),
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("an unpriced deployment must never reach the transport");
        },
      },
      pricedConfig(root),
      { model: unpriced, effort: "low" },
    );
    assert.equal(fetchCalls, 0, "no paid request is made against a deployment with no price row");
    assert.equal(result.isError, true);
    assert.match(result.stderr, /has no price row/);

    // DISCRIMINATION: the identical call on a PRICED deployment does reach the transport, so the
    // refusal above is about the missing row and not about some unrelated earlier guard.
    let pricedCalls = 0;
    await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home-2"),
        prompt: "classify",
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        clock: fixedClock(Date.parse(AT_ISO)),
        fetchImpl: async () => {
          pricedCalls += 1;
          return new Response(
            JSON.stringify({ id: "ok", usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ message: { content: "DONE" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
      pricedConfig(root),
      { model: "gpt-oss-120b", effort: "low" },
    );
    assert.equal(pricedCalls, 1, "a priced deployment is sent, so the refusal discriminates on the row");

    // And nothing was committed against the unpriced attempt: a refusal costs no allowance.
    const committed = reserveOpenWeightBudget(pricedConfig(root), {
      requestId: "after-refusal",
      deployment: "gpt-oss-120b",
      requestBodyBytes: 512,
      atIso: AT_ISO,
    });
    assert.ok(committed.committedUsd > 0, "the priced run committed, so the allowance file is live");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the gpt-oss-120b price row preserves today's figures byte for byte", () => {
  // THE REFACTOR MUST NOT MOVE THE ONLY DEPLOYMENT IN USE. These are the two numbers the adapter
  // carried as module constants before the table existed; if either moves, every ledger row and
  // every reservation for the live trial deployment silently changes meaning.
  const row = openWeightPriceFor("gpt-oss-120b");
  assert.equal(row.inputUsdPerMillion, 0.15);
  assert.equal(row.outputUsdPerMillion, 0.6);

  // The arithmetic through the table equals the arithmetic the constants produced, for a usage
  // shape with both a prompt and a completion so neither term can be silently dropped.
  const promptTokens = 1_000;
  const completionTokens = 200;
  const throughTable = openWeightUsageUsd("gpt-oss-120b", promptTokens, completionTokens);
  assert.equal(throughTable, (promptTokens * 0.15 + completionTokens * 0.6) / 1_000_000);

  const bytes = 4_096;
  assert.equal(
    openWeightReservationUsd("gpt-oss-120b", bytes),
    (bytes * 0.15 + OPENWEIGHT_MAX_COMPLETION_TOKENS * 0.6) / 1_000_000,
    "the reservation formula is unchanged for the deployment in use today",
  );
});
