import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectWorkerResult, workerLedgerFields } from "../src/lib/worker.js";

// ── W1-T303 — DIAGNOSIS, not a fix ──────────────────────────────────────────
//
// `maxTurns` (the Options field the SDK is invoked with) and `num_turns` (the
// field the `type:"result"` envelope reports back) do not count the same
// unit. MEASURED over every `recon.done` ledger row for 2026-08-03 under a
// single hardcoded `maxTurns: 8` (commit 1a5afa2): 11 `error_max_turns`
// failures, across both routed models, EVERY ONE landing at exactly
// `num_turns: 9` — and one SUCCESS at `num_turns: 17`, nearly double the cap.
//
// (1) WHAT EACH SIDE COUNTS, sourced from the SDK's own contract (sdk.d.ts)
//     and from lib/worker.ts's envelope-read site — never inferred from the
//     ledger, which is what produced the puzzle in the first place.
// (2) An account that FITS BOTH observations: the pinned-at-9 failures, and
//     the 17-turn success under the identical cap.
// (3) Because the units are not interchangeable, a cap-comparable value —
//     the `maxTurns` THIS call was actually CONFIGURED with — is now ledgered
//     BESIDE the existing `numTurns`/`num_turns` field, never replacing it.

const SDK_DTS_PATH = fileURLToPath(
  new URL("../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts", import.meta.url),
);

test("SDK contract: Options.maxTurns is documented, sourced from sdk.d.ts, as counting user+assistant CONVERSATION turns", () => {
  const dts = readFileSync(SDK_DTS_PATH, "utf8");
  // The Options.maxTurns docstring (the field lib/worker.ts's `options.maxTurns =
  // args.maxTurns` actually sets, sdk.d.ts SDK 0.3.209+ ground truth) — this is the
  // ONLY textual counting rule either field carries anywhere in the contract.
  assert.ok(
    dts.includes("Maximum number of conversation turns before the query stops."),
    "sdk.d.ts must document what Options.maxTurns bounds — if this text moves, the diagnosis below must be re-checked against the new wording",
  );
  assert.ok(
    dts.includes("A turn consists of a user message and assistant response."),
    "the documented unit of a maxTurns 'turn' — one user message plus one assistant response",
  );
});

test("SDK contract: num_turns on SDKResultSuccess/SDKResultError carries NO counting rule beyond the bare type `number` — treating it as the same unit maxTurns bounds is an ASSUMPTION, not a contract guarantee", () => {
  const dts = readFileSync(SDK_DTS_PATH, "utf8");
  // Both result shapes (success and error) declare the field identically and bare —
  // neither carries a docstring the way maxTurns does above. Two occurrences is the
  // SDK 0.3.209 ground truth (SDKResultSuccess + SDKResultError); a THIRD appearing
  // would mean a new result shape landed and this diagnosis needs re-reading against it.
  const bareOccurrences = dts.match(/num_turns: number;/g) ?? [];
  assert.equal(
    bareOccurrences.length,
    2,
    "num_turns must appear exactly twice in sdk.d.ts (SDKResultSuccess, SDKResultError), both undocumented",
  );
});

/** A clean success stream reporting an arbitrary `num_turns` off the envelope. */
function successStream(numTurns: number) {
  return (async function* (): AsyncGenerator<unknown> {
    yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "PR_URL: https://github.com/x/y/pull/9",
      session_id: "sess-ok",
      total_cost_usd: 0.5,
      num_turns: numTurns,
      permission_denials: [],
    };
  })();
}

/** The WS-1 error shape: the envelope yields first, then the iterator throws. */
function errorStream(numTurns: number) {
  return (async function* (): AsyncGenerator<unknown> {
    yield { type: "assistant", message: { content: [{ type: "text", text: "working…" }] } };
    yield {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      session_id: "sess-err",
      total_cost_usd: 0.2,
      num_turns: numTurns,
      permission_denials: [],
    };
    throw new Error("Claude Code returned an error result: error_max_turns");
  })();
}

// ── Observation #1: failures pinned at exactly cap+1 ────────────────────────

test("observation #1 — an error_max_turns termination under maxTurns:8 lands at num_turns:9 (cap+1), matching all 11 haiku/sonnet recon failures on 2026-08-03", async () => {
  const r = await collectWorkerResult(errorStream(9), { childEnvKeys: [], maxTurns: 8 });
  assert.equal(r.numTurns, 9);
  assert.equal(r.maxTurns, 8);
  assert.equal(r.numTurns, r.maxTurns + 1, "every observed max-turns failure landed exactly one past its cap");
  assert.equal(r.subtype, "error_max_turns");
});

// ── Observation #2: a SUCCESS can sail past the same cap ────────────────────

test("observation #2 — a SUCCESS under the identical maxTurns:8 can report num_turns:17, nearly double the cap, with no error and no clamp", async () => {
  const r = await collectWorkerResult(successStream(17), { childEnvKeys: [], maxTurns: 8 });
  assert.equal(r.numTurns, 17);
  assert.equal(r.maxTurns, 8);
  assert.ok(
    r.numTurns > r.maxTurns,
    "num_turns is NOT bounded by maxTurns on a success — the two are independent fields, neither derived from nor clamped against the other",
  );
  assert.equal(r.isError, false);
});

// ── Both observations together: one account, not two ────────────────────────

test("both observations survive under the SAME collectWorkerResult code path — numTurns is read straight off the envelope and maxTurns is passed straight through from the caller, with NO reconciliation between them either way", async () => {
  const failed = await collectWorkerResult(errorStream(9), { childEnvKeys: [], maxTurns: 8 });
  const succeeded = await collectWorkerResult(successStream(17), { childEnvKeys: [], maxTurns: 8 });
  // Same configured cap, wildly different num_turns, one an error one a clean success —
  // exactly the shape measured over the 2026-08-03 recon ledger. Nothing in
  // collectWorkerResult asserts a relationship between the two fields, which is itself
  // the finding: it would be WRONG for it to, since the SDK contract does not promise one.
  assert.equal(failed.maxTurns, succeeded.maxTurns);
  assert.notEqual(failed.numTurns, succeeded.numTurns);
});

// ── (3) The cap-comparable value: ledgered beside num_turns, never replacing it ──

test("workerLedgerFields: max_turns is the CONFIGURED cap this call ran under, ledgered BESIDE num_turns (still logged separately by every call site) — never replacing it", async () => {
  const r = await collectWorkerResult(errorStream(9), { childEnvKeys: [], maxTurns: 8 });
  const fields = workerLedgerFields(r);
  assert.equal(fields.max_turns, 8);
  // num_turns itself is untouched — still read straight off WorkerResult.numTurns by
  // every call site (run-task.ts's `num_turns: recon.numTurns`, ...workerLedgerFields(recon)),
  // exactly as before this diagnosis; max_turns is additive, not a replacement.
  assert.equal(r.numTurns, 9);
});

test("workerLedgerFields: max_turns is undefined (never guessed) when the caller configured no cap", async () => {
  const r = await collectWorkerResult(successStream(5), { childEnvKeys: [] });
  const fields = workerLedgerFields(r);
  assert.equal(fields.max_turns, undefined);
});

test("a ledger row's own configured cap no longer depends on mounts.yaml history that has since moved — RECON_MAX_TURNS itself moved 8 -> 20 the same day this mismatch was measured", async () => {
  // Simulates re-reading an OLD ledger row logged back when RECON_MAX_TURNS was 8: the
  // row itself now carries the cap it ran under, so it stays checkable even after
  // mounts.yaml/RECON_MAX_TURNS moves on (as it already did, to 20, in commit 1a5afa2).
  const oldRow = await collectWorkerResult(errorStream(9), { childEnvKeys: [], maxTurns: 8 });
  const fields = workerLedgerFields(oldRow);
  assert.equal(fields.max_turns, 8, "the row's own cap survives independent of RECON_MAX_TURNS's current value");
});
