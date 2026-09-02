import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { collectWorkerResult, workerLedgerFields, type WorkerResult } from "../src/lib/worker.js";

// ── W1-T2572: THE LEDGER RECORDS THE MOUNT THAT WAS ASKED FOR, NEVER THE MODEL THAT
// ACTUALLY SERVED ───────────────────────────────────────────────────────────────────────
//
// `run.start` logs `mount.model` — an ALIAS resolved from `.remudero/mounts.yaml`
// (`sonnet`, `haiku`), not a model id — and until this task nothing logged what the
// provider actually ran. On the Claude path the alias and the served model USUALLY
// agree; on a routed/Codex path they need not, because model selection happens against
// whatever the authenticated account exposes. Two rows both reading `model: "sonnet"`
// could have been served by two different concrete models on two different days, and no
// existing field distinguished them.
//
// This file's falsifier is the DISAGREEMENT case, not the agreeing one: a test where
// request and served coincide would pass against an implementation that just copies
// `model` into `served_model`. The load-bearing assertion is that a call served by
// something OTHER than what was asked for keeps BOTH values, distinct, on the same row.

const workerSrc = readFileSync(fileURLToPath(new URL("../src/lib/worker.ts", import.meta.url)), "utf8");

/** A live Claude stream whose assistant message reports a CONCRETE served model —
 *  distinct from whatever alias the caller requested via `opts.model`. */
async function* disagreeingStream(): AsyncGenerator<unknown> {
  yield {
    type: "assistant",
    message: { model: "claude-opus-4-1-20260805", content: [{ type: "text", text: "working…" }] },
  };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PR_URL: https://github.com/x/y/pull/9",
    session_id: "sess-disagree",
    total_cost_usd: 0.4,
    num_turns: 2,
    permission_denials: [],
  };
}

/** Two DIFFERENT real models across two assistant messages — the last one served wins,
 *  matching the "final state" discipline `text`/`subtype` already keep in this loop. */
async function* midRunSwitchStream(): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { model: "claude-sonnet-4-5-20260514", content: [{ type: "text", text: "a" }] } };
  yield { type: "assistant", message: { model: "claude-opus-4-1-20260805", content: [{ type: "text", text: "b" }] } };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: "sess-switch",
    total_cost_usd: 0.2,
    num_turns: 2,
    permission_denials: [],
  };
}

/** A `<synthetic>` model marks an Anthropic-side API error placeholder (WS-0), never a
 *  model that actually served anything — the stream reports NOTHING usable. */
async function* syntheticOnlyStream(): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] } };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    session_id: "sess-synthetic",
    total_cost_usd: 0,
    num_turns: 1,
    permission_denials: [],
  };
}

/** No assistant message at all — an immediate result. The provider's own output simply
 *  never named what it served, and the call still succeeds cleanly. */
async function* noAssistantMessageStream(): AsyncGenerator<unknown> {
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PR_URL: https://github.com/x/y/pull/10",
    session_id: "sess-quiet",
    total_cost_usd: 0.05,
    num_turns: 1,
    permission_denials: [],
  };
}

// ── Acceptance: the concrete served model id is recorded verbatim, never normalised
// back into the mount alias — and the disagreeing case survives distinctly. ────────────

test("collectWorkerResult: servedModel is read verbatim off the live stream, distinct from the requested alias", async () => {
  const r = await collectWorkerResult(disagreeingStream(), { childEnvKeys: [], model: "sonnet" });
  assert.equal(r.model, "sonnet", "the REQUEST — the configured input — is untouched");
  assert.equal(r.servedModel, "claude-opus-4-1-20260805", "the SERVED id, read verbatim off the stream");
  assert.notEqual(r.servedModel, r.model, "the falsifier: request and served must NOT collapse to one value");
});

test("collectWorkerResult: the LAST real model observed wins, matching text/subtype's own overwrite discipline", async () => {
  const r = await collectWorkerResult(midRunSwitchStream(), { childEnvKeys: [], model: "sonnet" });
  assert.equal(r.servedModel, "claude-opus-4-1-20260805");
});

test("workerLedgerFields: model and served_model ride the SAME row, distinct, when request and served disagree", async () => {
  const r = await collectWorkerResult(disagreeingStream(), { childEnvKeys: [], model: "sonnet" });
  const fields = workerLedgerFields(r);
  assert.equal(fields.model, "sonnet");
  assert.equal(fields.served_model, "claude-opus-4-1-20260805");
  assert.notEqual(fields.served_model, fields.model);
  assert.equal(fields.served_model_reason, undefined, "a known served model carries no unknown-reason field");
});

// ── Acceptance: a provider that cannot report what it served records an explicit
// unknown and a reason, never a guess — and the run never fails over it. ───────────────

test("collectWorkerResult: a <synthetic> placeholder is never recorded as a served model", async () => {
  const r = await collectWorkerResult(syntheticOnlyStream(), { childEnvKeys: [], model: "sonnet" });
  assert.equal(r.servedModel, null);
  assert.equal(typeof r.servedModelReason, "string");
  assert.ok(r.servedModelReason && r.servedModelReason.length > 0);
});

test("collectWorkerResult: no assistant message at all records servedModel=null with a reason, and the call still succeeds", async () => {
  const r = await collectWorkerResult(noAssistantMessageStream(), { childEnvKeys: [], model: "haiku" });
  assert.equal(r.servedModel, null);
  assert.equal(typeof r.servedModelReason, "string");
  // FAIL SOFT: an unreportable served model must never fail the run.
  assert.equal(r.isError, false);
  assert.equal(r.subtype, "success");
});

test("workerLedgerFields: served_model is ALWAYS present as an explicit null (never an omitted key) when unreportable", async () => {
  const r = await collectWorkerResult(noAssistantMessageStream(), { childEnvKeys: [], model: "haiku" });
  const fields = workerLedgerFields(r);
  assert.ok("served_model" in fields, "the key itself must survive JSON.stringify, not read as forgotten");
  assert.equal(fields.served_model, null);
  assert.equal(typeof fields.served_model_reason, "string");
  assert.ok(fields.served_model_reason && fields.served_model_reason.length > 0);
  // Never a dispatch outage: the verdict is still a clean success.
  assert.equal(fields.verdict, "success");
});

// ── Acceptance: the provider that served a run is recorded at the worker seam (already
// true of `provider` pre-this-task — see test/worker-provider.test.ts:523/561) — this
// pins that `served_model` now rides the SAME row, for a provider (Codex-shaped) whose
// own output never names a served model at all. `spawnCodexWorker` (worker-provider.ts)
// sets neither `servedModel` nor `servedModelReason` on its result — verified live against
// codex-cli 0.152.0's `--json` event stream (`thread.started`/`turn.started`/
// `turn.completed`/`item.completed`/`error`), none of which carry a served-model field —
// so this fixture mirrors that shape exactly rather than inventing one. ─────────────────

function codexShapedResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    provider: "codex",
    sessionId: "codex-sess",
    costUsd: 0,
    numTurns: 3,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    // The concrete Codex model `selectCodexModel` chose for the `--model` flag — this is
    // what was ASKED for, never confused with what was actually SERVED.
    model: "gpt-5.6-terra",
    effort: "medium",
    tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

test("workerLedgerFields: a provider that cannot report what it served (Codex-shaped) records served_model:null and a reason, never an echo of the requested model", () => {
  const r = codexShapedResult();
  const fields = workerLedgerFields(r);
  assert.equal(fields.provider, "codex", "acceptance: the provider that served the run rides this row");
  assert.equal(fields.served_model, null, "never guessed — never the requested `model` echoed back as served");
  assert.notEqual(fields.served_model, fields.model);
  assert.equal(typeof fields.served_model_reason, "string");
  assert.ok(fields.served_model_reason && fields.served_model_reason.length > 0);
  assert.equal(fields.verdict, "success", "an unreportable served model never fails the run");
});

// ── Structural pin: `served_model` must be an UNCONDITIONAL key on the ledger row (never
// spread in behind a truthy guard the way `stderr_excerpt`/`lost_grants` are), so a caller
// can never read its absence as "forgotten to check" rather than "checked, unreportable". ─

test("src/lib/worker.ts: workerLedgerFields emits served_model unconditionally, defaulted off WorkerResult.servedModel", () => {
  assert.ok(
    workerSrc.includes("served_model: r.servedModel ?? null,"),
    "served_model must be an always-present key on the ledger row, not a conditionally-spread one",
  );
});
