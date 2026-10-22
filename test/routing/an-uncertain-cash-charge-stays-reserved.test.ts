import { REPO_ROOT } from "#test/helpers/repo-root.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock } from "#src/lib/clock.js";
type CashAccountingModule = typeof import("#src/lib/cash-accounting.js");
let cashAccountingEvidence: CashAccountingModule["cashAccountingEvidence"];
let cashUsageTuple: CashAccountingModule["cashUsageTuple"];
let foundryUsageTuple: CashAccountingModule["foundryUsageTuple"];
let mergeCashAccounting: CashAccountingModule["mergeCashAccounting"];
let readCashAccounting: CashAccountingModule["readCashAccounting"];
let recordCashAccounting: CashAccountingModule["recordCashAccounting"];
let summarizeCashAccounting: CashAccountingModule["summarizeCashAccounting"];
const cashAccounting = existsSync(join(REPO_ROOT, "src/lib/cash-accounting.ts"))
  ? await import("#src/lib/cash-accounting.js") : undefined;
if (cashAccounting) ({ cashAccountingEvidence, cashUsageTuple, foundryUsageTuple, mergeCashAccounting, readCashAccounting, recordCashAccounting, summarizeCashAccounting } = cashAccounting);
import { openWeightAllowancePath, openWeightCommittedUsd, openWeightPriceFor, spawnOpenWeightWorker, type OpenWeightAllowanceState } from "#src/lib/worker-provider.js";
import { workerLedgerFields, type WorkerResult } from "#src/lib/worker.js";
import { terminalVerdictFields, workerErrorVerdict } from "#src/run-task.js";

const clock = fixedClock(Date.parse("2026-10-10T12:00:00Z"));
const models = ["gpt-oss-120b", "gpt-6-luna", "gpt-6.1-sol", "claude-haiku-5-5", "claude-opus-5-5"];
const env = { RMD_OPENWEIGHT_API_KEY: "synthetic-only", RMD_FOUNDRY_CLAUDE_API_KEY: "synthetic-only", RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://example.test/anthropic" };
function config(root: string, cap = 25): Config {
  return { root, dailyCapUsd: cap, workerProviders: { enabled: ["cash"], cashEndpoint: "https://example.test/" }, claudeBin: "/unused" } as Config;
}
function allowance(root: string): OpenWeightAllowanceState {
  return JSON.parse(readFileSync(openWeightAllowancePath(config(root)), "utf8"));
}
function payload(model: string, usage: unknown) {
  if (model.startsWith("claude-")) return { id: "synthetic", model, stop_reason: "end_turn", content: [{ type: "text", text: "DONE" }], usage };
  if (model === "gpt-6.1-sol") return { id: "synthetic", model, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "DONE" }] }], usage };
  return { id: "synthetic", model, choices: [{ message: { content: "DONE" }, finish_reason: "stop" }], usage };
}
function usage(model: string, input = 10, output = 5) {
  return model.startsWith("claude-") ? { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    : model === "gpt-6.1-sol" ? { input_tokens: input, output_tokens: output, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }
    : { prompt_tokens: input, completion_tokens: output, cached_tokens: 0 };
}
async function attempt(root: string, model: string, fetchImpl: typeof fetch, cap = 25) {
  return spawnOpenWeightWorker({ cwd: root, workerHome: join(root, "worker-home"), prompt: "classify", env, clock,
    requestTimeoutMs: 10, cashSqueezed: model === "claude-opus-5-5", fetchImpl }, config(root, cap), { model, effort: "low" });
}

for (const model of models) {
  for (const outcome of ["malformed", "transport", "http", "timeout"] as const) {
    test(`uncertain ${model} ${outcome} retains its exact original reservation`, async () => {
      const root = mkdtempSync(join(tmpdir(), "rmd-cash-held-"));
      try {
        const result = await attempt(root, model, async (_url, init) => {
          if (outcome === "transport") throw new Error("synthetic transport loss");
          if (outcome === "timeout") return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("synthetic timeout")), { once: true }));
          return new Response(outcome === "malformed" ? "not json" : "unavailable", { status: outcome === "http" ? 503 : 200 });
        });
        const state = allowance(root), rows = Object.values(state.reservations);
        assert.equal(rows.length, 1); assert.equal(rows[0]!.settledUsd, null);
        assert.equal(result.isError, true); assert.equal(result.budgetHeldUsd, rows[0]!.reservedUsd);
        assert.equal(result.budgetSettledUsd, 0); assert.equal(result.costUsd, 0);
        assert.equal(result.cashAccounting.state, "held"); assert.equal(result.cashAccounting.heldRequests, 1);
        assert.equal(result.cashAccounting.invoiceCashUsd, null);
        assert.equal(openWeightCommittedUsd(state), rows[0]!.reservedUsd);
        const r = { ...result, selectionAssignmentId: "actual-synthetic-assignment" } as WorkerResult;
        for (const fields of [workerLedgerFields(r), terminalVerdictFields(r), workerErrorVerdict(r, r.costUsd, "implement")!.ledger]) {
          assert.equal(fields.billing_mode, "api");
          assert.ok("cash_accounting" in fields);
          assert.ok("budget_held_usd" in fields);
          assert.ok("request_efforts" in fields);
          assert.deepEqual(fields.cash_accounting, result.cashAccounting);
          assert.equal(fields.budget_held_usd, rows[0]!.reservedUsd);
          const efforts = fields.request_efforts;
          assert.ok(Array.isArray(efforts)); assert.equal(efforts[0]?.requests, 1);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
  test(`a definite ${model} deployment 404 settles at zero`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rmd-cash-404-"));
    try {
      const result = await attempt(root, model, async () => new Response("absent", { status: 404 }));
      assert.equal(Object.values(allowance(root).reservations)[0]!.settledUsd, 0);
      assert.equal(result.cashAccounting.noChargeRequests, 1); assert.equal(result.budgetHeldUsd, 0);
      assert.equal(result.cashAccounting.invoiceCashUsd, null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const kind of ["absent", "partial", "negative", "fractional", "invalid-cache"] as const) {
    test(`${model} ${kind} usage holds billing without failing successful content`, async () => {
      const root = mkdtempSync(join(tmpdir(), "rmd-cash-usage-"));
      try {
        let value: unknown = usage(model);
        const partial = value as Record<string, unknown>;
        const inputKey = model.startsWith("claude-") || model === "gpt-6.1-sol" ? "input_tokens" : "prompt_tokens";
        const outputKey = model.startsWith("claude-") || model === "gpt-6.1-sol" ? "output_tokens" : "completion_tokens";
        if (kind === "absent") value = undefined;
        else if (kind === "partial") delete partial[outputKey];
        else if (kind === "negative") partial[inputKey] = -1;
        else if (kind === "fractional") partial[inputKey] = 0.5;
        else if (model.startsWith("claude-")) partial.cache_read_input_tokens = null;
        else if (model === "gpt-6.1-sol") partial.input_tokens_details = { cached_tokens: -1, cache_write_tokens: 0 };
        else partial.cached_tokens = -1;
        const result = await attempt(root, model, async () => new Response(JSON.stringify(payload(model, value)), { status: 200 }));
        const reservation = Object.values(allowance(root).reservations)[0]!;
        assert.equal(result.isError, false, result.stderr); assert.equal(result.text, "DONE");
        assert.equal(reservation.settledUsd, null); assert.equal(result.budgetHeldUsd, reservation.reservedUsd);
        assert.equal(result.cashAccounting.heldRequests, 1); assert.equal(result.budgetSettledUsd, 0);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
  for (const zero of [false, true]) {
    test(`${model} complete ${zero ? "zero" : "positive"} usage settles with invoice cash unavailable`, async () => {
      const root = mkdtempSync(join(tmpdir(), "rmd-cash-complete-"));
      try {
        const result = await attempt(root, model, async () => new Response(JSON.stringify(payload(model, usage(model, zero ? 0 : 10, zero ? 0 : 5))), { status: 200 }));
        const reservation = Object.values(allowance(root).reservations)[0]!;
        assert.equal(result.isError, false, result.stderr); assert.notEqual(reservation.settledUsd, null);
        assert.equal(result.cashAccounting.state, "complete"); assert.equal(result.cashAccounting.usagePricedRequests, 1);
        assert.equal(result.budgetHeldUsd, 0); assert.equal(result.costUsd, reservation.settledUsd);
        assert.equal(result.cashAccounting.invoiceCashUsd, null);
        if (zero) assert.equal(result.costUsd, 0); else assert.ok(result.costUsd > 0);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}

test("an uncertain reserve refuses further cash before transport at the existing ceiling", async () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-ceiling-"));
  try {
    const first = await attempt(root, "gpt-oss-120b", async () => { throw new Error("unknown"); });
    let called = false;
    const second = await attempt(root, "gpt-oss-120b", async () => { called = true; throw new Error("must not reach transport"); }, first.budgetReservedUsd * 1.5);
    assert.equal(called, false); assert.equal(second.budgetRefused, true);
    assert.equal(Object.keys(allowance(root).reservations).length, 1);
    assert.equal(openWeightCommittedUsd(allowance(root)), first.budgetHeldUsd);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a later tool failure cannot release a previously held turn", async () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-tool-held-"));
  try {
    writeFileSync(join(root, "exists.txt"), "actual private fixture");
    const result = await spawnOpenWeightWorker({ cwd: root, workerHome: join(root, "worker-home"), prompt: "read", tools: ["Read"], maxTurns: 1, env, clock,
      fetchImpl: async () => new Response(JSON.stringify({ model: "gpt-oss-120b", choices: [{ message: { tool_calls: [{ id: "call", function: { name: "read_file", arguments: '{"path":"exists.txt"}' } }] } }] }), { status: 200 }) },
      config(root), { model: "gpt-oss-120b", effort: "low" });
    assert.equal(result.isError, true); assert.match(result.stderr, /maxTurns/);
    assert.equal(result.cashAccounting.heldRequests, 1);
    assert.equal(result.cashAccounting.heldUsd, result.budgetReservedUsd);
    assert.equal(Object.values(allowance(root).reservations)[0]!.settledUsd, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cash tuple readers distinguish absent components, invalid cache counts, contradictions and complete zero", () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  for (const value of [undefined, null, {}, { prompt_tokens: 0 }, { prompt_tokens: 0, completion_tokens: -1 },
    { prompt_tokens: 0.5, completion_tokens: 0 }, { prompt_tokens: Infinity, completion_tokens: 0 },
    { prompt_tokens: 10, completion_tokens: 0, cached_tokens: 11 }, { prompt_tokens: 10, completion_tokens: 0, cached_tokens: null },
    { prompt_tokens: 10, completion_tokens: 0, cached_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } }])
    assert.equal(cashUsageTuple(value, true, true), undefined);
  assert.deepEqual(cashUsageTuple({ prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cache_creation_tokens: 0 }, true, true), { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  assert.equal(foundryUsageTuple({ input_tokens: 0, output_tokens: 0 }), undefined);
  assert.deepEqual(foundryUsageTuple(usage("claude-haiku-5-5", 0, 0)), { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
});

test("accounting readers keep invalid and conflicting evidence unavailable in both orders", () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  const first = cashAccountingEvidence(), second = cashAccountingEvidence();
  recordCashAccounting(first, "held", 0.01); recordCashAccounting(second, "usage-priced", 0.001);
  for (const values of [[first, second], [second, first]]) {
    const merged = values.reduce<ReturnType<typeof readCashAccounting> | undefined>((prior, value) => mergeCashAccounting(prior, value), undefined)!;
    assert.deepEqual(merged, { state: "unavailable", reason: "conflicting" });
  }
  for (const values of [[first, null], [null, first]]) {
    const merged = values.reduce<ReturnType<typeof readCashAccounting> | undefined>((prior, value) => mergeCashAccounting(prior, value), undefined)!;
    assert.deepEqual(merged, { state: "unavailable", reason: "invalid" });
  }
  assert.deepEqual(mergeCashAccounting(readCashAccounting(first), undefined), readCashAccounting(first));
  const summary = summarizeCashAccounting([readCashAccounting(first), undefined]);
  assert.equal(summary.state, "partial"); assert.equal(summary.heldUsd, 0.01); assert.equal(summary.invoiceCashUsd, null);
  for (const amount of [-1, Infinity, NaN]) assert.throws(() => recordCashAccounting(cashAccountingEvidence(), "held", amount), /invalid/);
  assert.throws(() => recordCashAccounting(cashAccountingEvidence(), "no-charge", 1), /invalid/);
  const max = { ...cashAccountingEvidence(), noChargeRequests: Number.MAX_SAFE_INTEGER };
  assert.throws(() => recordCashAccounting(max, "no-charge", 0), /overflow/);
  assert.equal(readCashAccounting({ ...max, usagePricedRequests: 1 }).state, "unavailable");
  assert.equal(readCashAccounting({ ...first, heldUsd: -1 }).state, "unavailable");
  assert.equal(readCashAccounting({ ...first, invoiceCashUsd: 1 }).state, "unavailable");
  assert.equal(summarizeCashAccounting([]).usagePricedUsd, null);
});

for (const outcome of ["missing-cache", "partial", "invalid-cache", "excess", "complete"] as const) {
  test(`the real web broker ${outcome} preserves a separate accounting decision`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rmd-web-held-"));
    try {
      const cfg = config(root); cfg.workerProviders!.cashWebSearch = true;
      let chatTurn = 0;
      const result = await spawnOpenWeightWorker({ cwd: root, workerHome: join(root, "worker-home"), prompt: "search", tools: ["WebSearch"],
        maxTurns: 3, clock, env: { ...env, RMD_CASH_WEB_SEARCH_API_KEY: "synthetic-only" },
        fetchImpl: async (url) => {
          if (String(url).includes("/openai/responses")) {
            const usage: Record<string, unknown> = { input_tokens: outcome === "excess" ? 1_000_000_000 : 10, output_tokens: 0,
              input_tokens_details: { cached_tokens: 0 } };
            if (outcome === "missing-cache") delete usage.input_tokens_details;
            if (outcome === "partial") delete usage.output_tokens;
            if (outcome === "invalid-cache") usage.input_tokens_details = { cached_tokens: null };
            return new Response(JSON.stringify({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: "actual fixture",
              annotations: [{ type: "url_citation", url: "https://example.test/" }] }] }], usage }), { status: 200 });
          }
          chatTurn++;
          return new Response(JSON.stringify(chatTurn === 1 ? { model: "gpt-6-luna", usage: usage("gpt-6-luna"), choices: [{ message: {
            tool_calls: [{ id: "web", function: { name: "web_search", arguments: '{"query":"fixture"}' } }] } }] }
            : payload("gpt-6-luna", usage("gpt-6-luna"))), { status: 200 });
        } }, cfg, { model: "gpt-6-luna", effort: "low" });
      const rows = Object.values(allowance(root).reservations);
      assert.equal(rows.length, 3); assert.equal(result.webSearchAttempted, 1);
      const web = Object.entries(allowance(root).reservations).find(([id]) => id.includes("search"))![1];
      if (outcome === "missing-cache") {
        assert.equal(openWeightPriceFor("gpt-6-luna").cachedInputUsdPerMillion, undefined,
          "omitting a cache category with no distinct price does not make this usage tuple unpriceable");
      }
      if (outcome === "complete" || outcome === "missing-cache") {
        assert.equal(result.cashAccounting.usagePricedRequests, 3); assert.equal(result.budgetHeldUsd, 0);
        assert.notEqual(web.settledUsd, null);
      } else {
        assert.equal(result.cashAccounting.heldRequests, 1); assert.equal(result.cashAccounting.usagePricedRequests, 2);
        assert.equal(web.settledUsd, null); assert.equal(result.budgetHeldUsd, web.reservedUsd);
        assert.equal(result.webSearchUsd, 0); assert.equal(result.tokenUsageState, "partial");
        if (outcome === "excess") { assert.equal(result.webSearchAccepted, 0); assert.equal(result.webSearchRefused, 1); }
      }
      assert.equal(result.cashAccounting.invoiceCashUsd, null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const { outcome, title } of [
  { outcome: "body-stream-error", title: "the real web broker body-stream-error reports its original held reservation once" },
  { outcome: "settlement-store-error", title: "the real web broker settlement-store-error reports its original held reservation once" },
] as const) {
  test(title, async () => {
    const root = mkdtempSync(join(tmpdir(), "rmd-web-post-reserve-"));
    try {
      const cfg = config(root); cfg.workerProviders!.cashWebSearch = true;
      let chatTurns = 0;
      let originalReservedUsd = 0;
      let webReservedUsd = 0;
      const result = await spawnOpenWeightWorker({ cwd: root, workerHome: join(root, "worker-home"), prompt: "search", tools: ["WebSearch"],
        maxTurns: 3, clock, env: { ...env, RMD_CASH_WEB_SEARCH_API_KEY: "synthetic-only" },
        fetchImpl: async url => {
          if (String(url).includes("/openai/responses")) {
            const state = allowance(root);
            originalReservedUsd = Object.values(state.reservations).reduce((sum, row) => sum + row.reservedUsd, 0);
            webReservedUsd = Object.entries(state.reservations).find(([id]) => id.includes("search"))![1].reservedUsd;
            if (outcome === "body-stream-error") return new Response(new ReadableStream({ start(controller) {
              controller.error(new Error("synthetic interrupted response body"));
            } }), { status: 200 });
            writeFileSync(openWeightAllowancePath(cfg), "synthetic unreadable allowance");
            return new Response(JSON.stringify({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: "fixture",
              annotations: [{ type: "url_citation", url: "https://example.test/" }] }] }],
              usage: { input_tokens: 10, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } } }), { status: 200 });
          }
          chatTurns++;
          return new Response(JSON.stringify(chatTurns === 1 ? { model: "gpt-6-luna", usage: usage("gpt-6-luna"), choices: [{ message: {
            tool_calls: [{ id: "web", function: { name: "web_search", arguments: '{"query":"fixture"}' } }] } }] }
            : payload("gpt-6-luna", usage("gpt-6-luna"))), { status: 200 });
        } }, cfg, { model: "gpt-6-luna", effort: "low" });
      assert.ok(webReservedUsd > 0);
      assert.equal(result.budgetHeldUsd, webReservedUsd);
      assert.equal(result.cashAccounting.heldRequests, 1);
      assert.equal(result.cashAccounting.heldUsd, webReservedUsd);
      assert.equal(result.cashAccounting.invoiceCashUsd, null);
      assert.equal(result.webSearchAttempted, 1); assert.equal(result.webSearchRefused, 1); assert.equal(result.webSearchAccepted, 0);
      assert.equal(result.webSearchUsd, 0); assert.equal(result.tokenUsageState, "partial");
      if (outcome === "body-stream-error") {
        assert.equal(result.isError, false, result.stderr); assert.equal(result.cashAccounting.usagePricedRequests, 2);
        assert.equal(Object.entries(allowance(root).reservations).find(([id]) => id.includes("search"))![1].settledUsd, null);
        assert.equal(result.budgetReservedUsd, Object.values(allowance(root).reservations).reduce((sum, row) => sum + row.reservedUsd, 0));
      } else {
        assert.equal(result.isError, true); assert.equal(result.cashAccounting.usagePricedRequests, 1);
        assert.equal(result.budgetReservedUsd, originalReservedUsd); assert.equal(chatTurns, 1);
        assert.equal(readFileSync(openWeightAllowancePath(cfg), "utf8"), "synthetic unreadable allowance");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

// Retry transport owns one deadline and turn cap; each actual attempt owns its accounting.
const retryCases = [
  {"model": "gpt-oss-120b", "finalOutcome": "complete", "name": "a retried gpt-oss-120b complete keeps earlier uncertain charges separate"},
  {"model": "gpt-oss-120b", "finalOutcome": "malformed", "name": "a retried gpt-oss-120b malformed keeps earlier uncertain charges separate"},
  {"model": "gpt-oss-120b", "finalOutcome": "absent", "name": "a retried gpt-oss-120b absent keeps earlier uncertain charges separate"},
  {"model": "gpt-6-luna", "finalOutcome": "complete", "name": "a retried gpt-6-luna complete keeps earlier uncertain charges separate"},
  {"model": "gpt-6-luna", "finalOutcome": "malformed", "name": "a retried gpt-6-luna malformed keeps earlier uncertain charges separate"},
  {"model": "gpt-6-luna", "finalOutcome": "absent", "name": "a retried gpt-6-luna absent keeps earlier uncertain charges separate"},
  {"model": "gpt-6.1-sol", "finalOutcome": "complete", "name": "a retried gpt-6.1-sol complete keeps earlier uncertain charges separate"},
  {"model": "gpt-6.1-sol", "finalOutcome": "malformed", "name": "a retried gpt-6.1-sol malformed keeps earlier uncertain charges separate"},
  {"model": "gpt-6.1-sol", "finalOutcome": "absent", "name": "a retried gpt-6.1-sol absent keeps earlier uncertain charges separate"},
  {"model": "claude-haiku-5-5", "finalOutcome": "complete", "name": "a retried claude-haiku-5-5 complete keeps earlier uncertain charges separate"},
  {"model": "claude-haiku-5-5", "finalOutcome": "malformed", "name": "a retried claude-haiku-5-5 malformed keeps earlier uncertain charges separate"},
  {"model": "claude-haiku-5-5", "finalOutcome": "absent", "name": "a retried claude-haiku-5-5 absent keeps earlier uncertain charges separate"},
  {"model": "claude-opus-5-5", "finalOutcome": "complete", "name": "a retried claude-opus-5-5 complete keeps earlier uncertain charges separate"},
  {"model": "claude-opus-5-5", "finalOutcome": "malformed", "name": "a retried claude-opus-5-5 malformed keeps earlier uncertain charges separate"},
  {"model": "claude-opus-5-5", "finalOutcome": "absent", "name": "a retried claude-opus-5-5 absent keeps earlier uncertain charges separate"},
] as const;
for (const { model, finalOutcome, name } of retryCases) {
    test(name, async () => {
      assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
      const root = mkdtempSync(join(tmpdir(), "rmd-cash-retry-held-"));
      let calls = 0;
      try {
        const result = await spawnOpenWeightWorker({
          cwd: root, workerHome: join(root, "worker-home"), prompt: "classify", env, clock,
          maxTurns: 2, requestTimeoutMs: 100, cashSqueezed: model === "claude-opus-5-5",
          fetchImpl: async () => {
            calls += 1;
            if (calls === 1) return new Response("busy", { status: 429, headers: { "retry-after-ms": "1" } });
            if (finalOutcome === "absent") return new Response("absent", { status: 404 });
            if (finalOutcome === "malformed") return new Response("not json", { status: 200 });
            return new Response(JSON.stringify(payload(model, usage(model))), { status: 200 });
          },
        }, config(root), { model, effort: "low" });
        const state = allowance(root), rows = Object.values(state.reservations);
        assert.equal(calls, 2, result.stderr);
        assert.equal(rows.length, 2);
        assert.equal(rows[0]!.settledUsd, null, "the first unmeasured attempt cannot release allowance");
        assert.equal(result.cashAccounting.heldRequests, finalOutcome === "malformed" ? 2 : 1);
        assert.equal(result.budgetHeldUsd, rows[0]!.reservedUsd + (finalOutcome === "malformed" ? rows[1]!.reservedUsd : 0));
        assert.equal(result.cashAccounting.usagePricedRequests, finalOutcome === "complete" ? 1 : 0);
        assert.equal(result.cashAccounting.noChargeRequests, finalOutcome === "absent" ? 1 : 0);
        assert.equal(result.isError, finalOutcome !== "complete", result.stderr);
        assert.equal(result.cashAccounting.invoiceCashUsd, null);
        assert.equal(result.requestEfforts.reduce((sum, entry) => sum + entry.requests, 0), 2);
        if (finalOutcome === "complete") {
          assert.ok(rows[1]!.settledUsd! > 0);
          assert.equal(result.costUsd, rows[1]!.settledUsd);
          assert.equal(result.budgetSettledUsd, rows[1]!.settledUsd);
        } else {
          assert.equal(rows[1]!.settledUsd, finalOutcome === "absent" ? 0 : null);
          assert.equal(result.costUsd, 0);
          assert.equal(result.budgetSettledUsd, 0);
        }
        assert.equal(openWeightCommittedUsd(state), result.budgetHeldUsd + result.budgetSettledUsd);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
}
