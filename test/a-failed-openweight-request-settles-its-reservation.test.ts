import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { fixedClock } from "../src/lib/clock.js";
import {
  OPENWEIGHT_ALLOWANCE_FILENAME,
  OPENWEIGHT_MAX_COMPLETION_TOKENS,
  OPENWEIGHT_PRICES,
  openWeightCommittedUsd,
  openWeightReservationUsd,
  openWeightEstimatedTokens,
  spawnOpenWeightWorker,
  type OpenWeightAllowanceState,
} from "../src/lib/worker-provider.js";

// W1-T3666. MEASURED from state/openweight-allowance.json on 2026-09-15: 104 requests against the
// $10 cap, $5.2696 reserved but only $0.9270 settled -- 32 of 104 never settled, so the day was
// charged roughly TWICE its real spend. `reserveOpenWeightBudget` commits the conservative figure
// BEFORE the transport call; `settleOpenWeightBudget` was reached only on a 200 whose usage block
// parsed, so any OTHER failure -- a 429, a transport fault, an unparseable body -- stranded its
// full reservation forever. These tests drive that failure path and assert it now settles down.

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

test("a failed openweight request settles rather than stranding its reservation", async () => {
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
    assert.notEqual(row.settledUsd, null, "the ledger settles the reservation rather than stranding it");
    assert.ok(row.settledUsd! < row.reservedUsd, "settlement corrects the conservative figure DOWN");
    // THE LEDGER SAYS WHICH FAILURE SETTLED IT: a plain success settles with no reason recorded (see
    // the sibling assertion below), so `settledReason` carrying the failure's own message is itself
    // the ledger entry this criterion asks for.
    assert.match(row.settledReason ?? "", /HTTP 429/, "the ledger row names the failure that settled it");

    assert.ok(result.budgetSettledUsd > 0, "the returned totals reflect the correction, not a stranded zero");
    assert.ok(result.budgetSettledUsd < result.budgetReservedUsd, "settled total stays below the reserved total");
    assert.equal(
      openWeightCommittedUsd(readAllowance(root)),
      row.settledUsd,
      "committed spend now reads the settled figure, not the stranded reservation",
    );

    // DISCRIMINATION: an ordinary success settles too, but records no reason -- so `settledReason`
    // being present is specific to a failure having settled the row, not just any settlement.
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
      assert.equal(soleReservation(okRoot).settledReason, undefined, "an ordinary settle-from-receipt carries no failure reason");
    } finally {
      rmSync(okRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed request is not charged for completion tokens it never produced", async () => {
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
    const price = OPENWEIGHT_PRICES[DEPLOYMENT]!;
    // The reservation reserved for `OPENWEIGHT_MAX_COMPLETION_TOKENS` of output the request never
    // produced; the settlement must not carry that ceiling forward. What remains of the reservation
    // once the completion ceiling is stripped out is exactly the input-only portion of the SAME
    // byte-bound estimate -- never a figure invented from nothing.
    const completionCeilingUsd = (OPENWEIGHT_MAX_COMPLETION_TOKENS * price.outputUsdPerMillion) / 1_000_000;
    // Compared with a tiny float tolerance, not `assert.equal`: the production figure is computed
    // as `input * rate` directly, while the expectation here is `reserved - completionCeiling` --
    // an equivalent but differently-ORDERED float computation, which can differ by a ULP or two.
    assert.ok(
      Math.abs(row.settledUsd! - (row.reservedUsd - completionCeilingUsd)) < 1e-9,
      `settlement (${row.settledUsd}) must strip exactly the un-produced completion ceiling, charging only for input (expected ~${row.reservedUsd - completionCeilingUsd})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the openweight reservation still bounds input by byte length", () => {
  // W1-T3619 pinned this; W1-T3666 corrects only the FAILURE settlement path above and must not
  // touch this formula. Asserted as arithmetic against the published rate, matching the byte-bound
  // contract `openWeightReservationUsd`'s own doc defends: input is bounded by bytes, never divided
  // down by the router's cheaper token estimate.
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
