import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock } from "#src/lib/clock.js";
import {
  OPENWEIGHT_ALLOWANCE_FILENAME,
  OPENWEIGHT_MAX_COMPLETION_TOKENS,
  OPENWEIGHT_PRICES,
  openWeightCommittedUsd,
  openWeightReservationUsd,
  openWeightEstimatedTokens,
  spawnOpenWeightWorker,
  type OpenWeightAllowanceState,
} from "#src/lib/worker-provider.js";

// W1-T10954 supersedes the input-only guess: missing usage leaves cash held, not settled.

const DEPLOYMENT = "gpt-oss-120b";

function allowanceConfig(root: string, dailyCapUsd: number): Config {
  return {
    claudeBin: "/unused/claude",
    root,
    dailyCapUsd,
    workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
  } as Config;
}

function readAllowance(root: string): OpenWeightAllowanceState {
  return JSON.parse(readFileSync(join(root, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8")) as OpenWeightAllowanceState;
}

function soleReservation(root: string) {
  const rows = Object.values(readAllowance(root).reservations);
  assert.equal(rows.length, 1, "exactly one reservation was committed");
  return rows[0]!;
}

test("a failed openweight request without usage retains its reservation as held unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-settle-fail-"));
  try {
    const config = allowanceConfig(root, 5);
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home"),
        prompt: "classify",
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        clock: fixedClock(Date.parse("2026-09-15T08:00:00.000Z")),
        // A 429 is exactly the rationale's own example: HTTP received, no usage block ever parsed.
        fetchImpl: async () => new Response("rate limited", { status: 429 }),
      },
      config,
      { model: DEPLOYMENT, effort: "low" },
    );
    assert.equal(result.isError, true, "the run itself still reports the failure");
    assert.equal(result.budgetRefused, false, "a 429 spent a reservation; it did not refuse to spend one");

    const row = soleReservation(root);
    assert.equal(row.settledUsd, null, "no usage means no settlement");
    assert.equal(row.accountingState, "held-unknown");
    assert.equal(row.heldUsd, row.reservedUsd);
    assert.equal(row.usageEstimateUsd, null);
    assert.equal(row.billedUsd, null);
    assert.match(row.heldReason ?? "", /HTTP 429/, "the held row preserves its failure evidence");
    assert.equal(row.settledReason, undefined);
    assert.equal(result.budgetHeldUsd, row.reservedUsd);
    assert.equal(result.usageEstimateUsd, null);
    assert.equal(result.billedUsd, null);
    assert.equal(openWeightCommittedUsd(readAllowance(root)), row.reservedUsd);

    // A receipt releases the ceiling and reports a usage estimate separately from invoice cash.
    const okRoot = mkdtempSync(join(tmpdir(), "rmd-openweight-settle-ok-"));
    try {
      await spawnOpenWeightWorker(
        {
          cwd: okRoot,
          workerHome: join(okRoot, "worker-home"),
          prompt: "classify",
          env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
          clock: fixedClock(Date.parse("2026-09-15T08:00:00.000Z")),
          fetchImpl: async () =>
            new Response(
              JSON.stringify({ id: "ok", usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ message: { content: "DONE" } }] }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        },
        allowanceConfig(okRoot, 5),
        { model: DEPLOYMENT, effort: "low" },
      );
      const settled = soleReservation(okRoot);
      assert.ok(settled.settledUsd! > 0 && settled.settledUsd! < settled.reservedUsd);
      assert.equal(settled.accountingState, "usage-rated");
      assert.equal(settled.usageEstimateUsd, settled.settledUsd);
      assert.equal(settled.heldUsd, 0);
      assert.equal(settled.billedUsd, null);
      assert.equal(settled.settledReason, undefined, "an ordinary settle-from-receipt carries no failure reason");
    } finally {
      rmSync(okRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable reply cannot prove completion tokens were unproduced", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-settle-nocompletion-"));
  try {
    const config = allowanceConfig(root, 5);
    // An unparseable body: the HTTP status is fine (200) but no usage block can ever be read off it
    // -- the other half of the rationale's list, alongside a 429 or a transport fault.
    await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home"),
        prompt: "classify",
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        clock: fixedClock(Date.parse("2026-09-15T08:00:00.000Z")),
        fetchImpl: async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
      },
      config,
      { model: DEPLOYMENT, effort: "low" },
    );

    const row = soleReservation(root);
    assert.equal(row.settledUsd, null, "an unreadable body cannot justify an input-only charge");
    assert.equal(row.heldUsd, row.reservedUsd);
    assert.equal(row.accountingState, "held-unknown");
    assert.equal(row.usageEstimateUsd, null);
    assert.equal(row.billedUsd, null);
    assert.equal(openWeightCommittedUsd(readAllowance(root)), row.reservedUsd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the openweight reservation still bounds input by byte length", () => {
  // Unknown usage must still count the byte-bound input and full output ceiling against the cap.
  const bytes = 250_000;
  const price = OPENWEIGHT_PRICES[DEPLOYMENT]!;
  const expected = (bytes * price.inputUsdPerMillion + OPENWEIGHT_MAX_COMPLETION_TOKENS * price.outputUsdPerMillion) / 1_000_000;
  assert.equal(openWeightReservationUsd(DEPLOYMENT, bytes), expected, "the reservation must price input by BYTES, unchanged by this task");

  const estimated = openWeightEstimatedTokens(bytes);
  assert.ok(estimated < bytes / 2, `the token estimate (${estimated}) must be far below the byte count (${bytes})`);
  const ifEstimateLeaked =
    (estimated * price.inputUsdPerMillion + OPENWEIGHT_MAX_COMPLETION_TOKENS * price.outputUsdPerMillion) / 1_000_000;
  assert.notEqual(openWeightReservationUsd(DEPLOYMENT, bytes), ifEstimateLeaked, "the reservation must not price by the router's estimate");
});
