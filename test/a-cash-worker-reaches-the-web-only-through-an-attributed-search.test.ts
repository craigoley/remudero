/**
 * W1-T3558 — THE DAEMON SEARCHES; THE WORKER NEVER REACHES THE NETWORK.
 *
 * Every lane whose tool set names `WebSearch` is unroutable to cash, because the adapter refuses a
 * declared tool it does not implement. These fixtures pin the four properties that make brokering
 * one safe, each one a thing a prompt cannot enforce:
 *
 *   consent      — without an explicit operator switch the refusal is exactly what it was before,
 *                  and the search credential is a SECOND grant the worker key does not confer.
 *   attribution  — a reply is handed back only when the provider really searched AND cited a
 *                  source. Un-attributed prose from a search tool is the model answering from its
 *                  weights, which is the one thing a search exists to rule out.
 *   containment  — a hung or enormous response is bounded, and neither destroys the worker run.
 *   the bill     — a refused search still costs, and its reservation covers content the request
 *                  body never carried. The ordinary byte-bound reservation CANNOT bound a search.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import {
  CASH_WEB_SEARCH_KEY_ENV,
  CASH_WEB_SEARCH_MAX_RETRIEVED_TOKENS,
  cashWebSearchEnabled,
  cashWebSearchEndpoint,
  cashWebSearchGrounding,
  performCashWebSearch,
} from "../src/lib/cash-web-bridge.js";
import { openWeightReservationUsd, spawnOpenWeightWorker } from "../src/lib/worker-provider.js";

const AT_ISO = "2026-09-16T10:00:00.000Z";
const MODEL = "gpt-oss-120b";
const WORKER_KEY = "test-only-worker-secret";
const SEARCH_KEY = "test-only-search-secret";

function config(root: string, consent: boolean): Config {
  return {
    claudeBin: "/unused/claude",
    root,
    dailyCapUsd: 5,
    workerProviders: { enabled: ["cash"], cashEndpoint: "https://example.test/", cashWebSearch: consent },
  } as Config;
}

/** A Responses-API payload in the shape the live 2026-09-16 probe returned. */
function searchPayload(options: { searched: boolean; citations: string[]; text: string }) {
  const output: unknown[] = [{ type: "reasoning" }];
  if (options.searched) output.push({ type: "web_search_call" });
  output.push({
    type: "message",
    content: [
      {
        type: "output_text",
        text: options.text,
        annotations: options.citations.map((url) => ({ type: "url_citation", url })),
      },
    ],
  });
  return { output, usage: { input_tokens: 7_369, output_tokens: 357 } };
}

/**
 * Drive one full worker run in which the model asks for a search on its first turn and then
 * answers. `serveSearch` produces the Responses-API reply.
 */
async function runWithSearch(
  root: string,
  consent: boolean,
  serveSearch: () => Promise<Response>,
  env: Record<string, string> = { RMD_OPENWEIGHT_API_KEY: WORKER_KEY, [CASH_WEB_SEARCH_KEY_ENV]: SEARCH_KEY },
) {
  let chatTurn = 0;
  const toolResults: string[] = [];
  const result = await spawnOpenWeightWorker(
    {
      cwd: root,
      workerHome: join(root, "worker-home"),
      prompt: "what shipped today",
      tools: ["Read", "WebSearch"],
      maxTurns: 4,
      env,
      clock: fixedClock(Date.parse(AT_ISO)),
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        if (href.includes("/openai/responses")) return await serveSearch();
        chatTurn += 1;
        if (chatTurn === 1) {
          return new Response(
            JSON.stringify({
              id: "chat-1",
              usage: { prompt_tokens: 20, completion_tokens: 8 },
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      { id: "call-1", function: { name: "web_search", arguments: JSON.stringify({ query: "node lts" }) } },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // The SECOND chat request carries the tool result, which is what the model actually reads.
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role?: string; content?: string }> };
        for (const message of body.messages ?? []) {
          if (message.role === "tool" && typeof message.content === "string") toolResults.push(message.content);
        }
        return new Response(
          JSON.stringify({ id: "chat-2", usage: { prompt_tokens: 30, completion_tokens: 12 }, choices: [{ message: { content: "ANSWERED" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as never,
    config(root, consent),
    { model: MODEL, effort: "low" },
  );
  return { result, toolResults, chatTurn };
}

test("openweight WebSearch bridge refuses every unproven authority — consent", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-bridge-consent-"));
  try {
    assert.equal(cashWebSearchEnabled(config(root, false)), false, "consent is off by default");
    assert.equal(cashWebSearchEnabled(config(root, true)), true, "and the switch genuinely turns it on");

    // The pre-existing refusal is UNCHANGED by this task: a lane declaring WebSearch against a
    // non-consenting host still refuses before any request, rather than silently losing the tool.
    let calls = 0;
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "wh"),
        prompt: "triage",
        tools: ["Read", "WebSearch"],
        env: { RMD_OPENWEIGHT_API_KEY: WORKER_KEY, [CASH_WEB_SEARCH_KEY_ENV]: SEARCH_KEY },
        clock: fixedClock(Date.parse(AT_ISO)),
        fetchImpl: async () => {
          calls += 1;
          throw new Error("an unimplemented tool must never reach the transport");
        },
      } as never,
      config(root, false),
      { model: MODEL, effort: "low" },
    );
    assert.equal(calls, 0, "no paid request is made for a tool set the adapter cannot serve");
    assert.equal(result.isError, true);
    assert.match(result.stderr, /does not implement declared tool\(s\): WebSearch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openweight WebSearch bridge refuses every unproven authority — credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-bridge-key-"));
  try {
    // Consent ON, worker key present, SEARCH key absent. The run proceeds (the tool is declared),
    // but the search itself refuses loudly rather than returning an empty result the model would
    // read as "the web knows nothing about this".
    const { result, toolResults } = await runWithSearch(
      root,
      true,
      async () => {
        throw new Error("no search may be attempted without the search credential");
      },
      { RMD_OPENWEIGHT_API_KEY: WORKER_KEY },
    );
    assert.equal(result.isError, false, "a missing search key refuses the TOOL, not the whole run");
    assert.equal(toolResults.length, 1);
    assert.match(toolResults[0]!, new RegExp(CASH_WEB_SEARCH_KEY_ENV));
    assert.equal(result.webSearchAttempted, 0, "an unattempted search is not metered as one");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openweight WebSearch bridge returns provider-issued citations, and nothing less", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-bridge-grounding-"));
  try {
    const PROSE = "Node 24 is the current release.";

    // (a) The provider answered WITHOUT searching. Fluent, plausible, and refused.
    const unsearched = await runWithSearch(root, true, async () =>
      new Response(JSON.stringify(searchPayload({ searched: false, citations: ["https://nodejs.org/"], text: PROSE })), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    assert.equal(unsearched.toolResults.length, 1);
    assert.doesNotMatch(unsearched.toolResults[0]!, /Node 24 is the current release/, "un-retrieved prose must not reach the model");
    assert.match(unsearched.toolResults[0]!, /ungrounded/);
    assert.equal(unsearched.result.webSearchRefused, 1);
    assert.equal(unsearched.result.webSearchAccepted, 0);

    // (b) It DID search, but cited nothing. Also refused — a search with no source is not evidence.
    const uncited = await runWithSearch(root, true, async () =>
      new Response(JSON.stringify(searchPayload({ searched: true, citations: [], text: PROSE })), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    assert.doesNotMatch(uncited.toolResults[0]!, /Node 24 is the current release/);
    assert.match(uncited.toolResults[0]!, /no url_citation/);

    // (c) DISCRIMINATION: searched AND cited. The same prose now reaches the model, with sources,
    // so (a) and (b) refuse on attribution and not on some unrelated guard.
    const accepted = await runWithSearch(root, true, async () =>
      new Response(
        JSON.stringify(searchPayload({ searched: true, citations: ["https://nodejs.org/en/download/current"], text: PROSE })),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    assert.match(accepted.toolResults[0]!, /Node 24 is the current release/);
    assert.match(accepted.toolResults[0]!, /nodejs\.org\/en\/download\/current/);
    assert.equal(accepted.result.webSearchAccepted, 1);
    assert.equal(accepted.result.webSearchRefused, 0);
    assert.equal(accepted.result.isError, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openweight WebSearch bridge ledger fields report bounded spend on a refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-bridge-bill-"));
  try {
    const refused = await runWithSearch(root, true, async () =>
      new Response(JSON.stringify(searchPayload({ searched: false, citations: [], text: "from my weights" })), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    // THE POINT: the provider billed 7,369 + 357 tokens whether or not we liked the answer.
    // Refusing to hand it over is not a refund.
    assert.equal(refused.result.webSearchRefused, 1);
    assert.ok(refused.result.webSearchUsd > 0, `a refused search must still be charged, got ${refused.result.webSearchUsd}`);
    assert.ok(
      refused.result.costUsd > refused.result.webSearchUsd,
      "the run's cost carries BOTH the conversation and the search",
    );
    // And the run completed: the model got a refusal message and answered anyway.
    assert.equal(refused.result.isError, false);
    assert.equal(refused.result.text, "ANSWERED");
    assert.equal(refused.chatTurn, 2, "the conversation continued past the failed search");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openweight WebSearch bridge ledger fields report bounded spend above body bytes", () => {
  // THE HOLE THIS CLOSES. `openWeightReservationUsd` is safe because no tokenizer emits more tokens
  // than the UTF-8 bytes it consumed — true only while the body is the whole input. A server-side
  // search makes the provider fetch pages we never sent and bill them as input: the live probe sent
  // a few hundred bytes and was billed 7,369 input tokens.
  const bodyBytes = 300;
  const bodyOnly = openWeightReservationUsd(MODEL, bodyBytes);
  const withRetrieval = openWeightReservationUsd(MODEL, bodyBytes, CASH_WEB_SEARCH_MAX_RETRIEVED_TOKENS);
  assert.ok(withRetrieval > bodyOnly, "a search must reserve strictly more than its body alone");

  // And by enough to cover the measured call, which the body-only figure does NOT.
  const measuredInputTokens = 7_369;
  const measuredFloor = openWeightReservationUsd(MODEL, measuredInputTokens);
  assert.ok(
    bodyOnly < measuredFloor,
    "the body-only reservation genuinely under-reserves the measured search — otherwise this test is vacuous",
  );
  assert.ok(withRetrieval >= measuredFloor, "the retrieval allowance covers the measured search");
});

test("openweight WebSearch bridge refuses every unproven authority — time and size", async () => {
  // Timeout: the request never settles, and the deadline turns it into a refusal that still warns
  // the caller the charge may stand (`usageRead: false`).
  const timedOut = await performCashWebSearch({
    query: "anything",
    endpoint: "https://example.test/openai/responses",
    apiKey: SEARCH_KEY,
    model: MODEL,
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted")));
      }) as Promise<Response>,
  });
  assert.equal(timedOut.outcome, "refused");
  assert.equal(timedOut.outcome === "refused" && timedOut.reason, "timeout");
  assert.equal(timedOut.usageRead, false, "an unread receipt must leave the conservative reservation standing");

  // Oversize: the cap is applied to bytes as they arrive, so a body far past the limit is refused
  // rather than decoded. The payload below would parse perfectly well if it were ever buffered.
  const huge = JSON.stringify(searchPayload({ searched: true, citations: ["https://example.test/"], text: "x".repeat(5_000) }));
  const oversize = await performCashWebSearch({
    query: "anything",
    endpoint: "https://example.test/openai/responses",
    apiKey: SEARCH_KEY,
    model: MODEL,
    maxResponseBytes: 128,
    fetchImpl: async () => new Response(huge, { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(oversize.outcome, "refused");
  assert.equal(oversize.outcome === "refused" && oversize.reason, "oversize");

  // DISCRIMINATION: the identical payload under a cap that admits it is accepted, so the refusal
  // above is about the size bound and not about the payload being unreadable.
  const admitted = await performCashWebSearch({
    query: "anything",
    endpoint: "https://example.test/openai/responses",
    apiKey: SEARCH_KEY,
    model: MODEL,
    maxResponseBytes: 1_000_000,
    fetchImpl: async () => new Response(huge, { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(admitted.outcome, "accepted");
});

test("grounding reads the two facts off the payload and neither substitutes for the other", () => {
  const both = cashWebSearchGrounding(searchPayload({ searched: true, citations: ["https://a.test/"], text: "hi" }));
  assert.deepEqual(both, { searched: true, citations: ["https://a.test/"], text: "hi" });

  assert.equal(cashWebSearchGrounding(searchPayload({ searched: false, citations: ["https://a.test/"], text: "hi" })).searched, false);
  assert.deepEqual(cashWebSearchGrounding(searchPayload({ searched: true, citations: [], text: "hi" })).citations, []);

  // A payload in no recognised shape reports nothing rather than throwing into the tool loop.
  assert.deepEqual(cashWebSearchGrounding({ nothing: true }), { searched: false, citations: [], text: "" });
  assert.deepEqual(cashWebSearchGrounding(null), { searched: false, citations: [], text: "" });
});

test("openweight WebSearch bridge refuses every unproven authority — allowance", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-bridge-allowance-"));
  try {
    // A cap that COMFORTABLY ADMITS A CHAT TURN AND CANNOT COVER A SEARCH. Sized from the two
    // reservation functions rather than a literal, so it cannot go stale when a price row moves —
    // and so the test fails for the right reason. A cap low enough to refuse the first chat turn
    // would abort the run before any tool call and prove nothing about searches.
    const chatCeiling = openWeightReservationUsd(MODEL, 4_096);
    const searchFloor = openWeightReservationUsd(MODEL, 4_096, CASH_WEB_SEARCH_MAX_RETRIEVED_TOKENS);
    assert.ok(chatCeiling < searchFloor, "the fixture cap must sit between a chat turn and a search, or it proves nothing");
    const exhausted = { ...config(root, true), dailyCapUsd: chatCeiling } as Config;
    let searchCalls = 0;
    let chatTurn = 0;
    const toolResults: string[] = [];
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "wh"),
        prompt: "what shipped today",
        tools: ["WebSearch"],
        maxTurns: 4,
        env: { RMD_OPENWEIGHT_API_KEY: WORKER_KEY, [CASH_WEB_SEARCH_KEY_ENV]: SEARCH_KEY },
        clock: fixedClock(Date.parse(AT_ISO)),
        fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
          const href = String(url);
          if (href.includes("/openai/responses")) {
            searchCalls += 1;
            throw new Error("an exhausted allowance must never reach the search transport");
          }
          chatTurn += 1;
          if (chatTurn === 1) {
            return new Response(
              JSON.stringify({
                id: "chat-1",
                usage: { prompt_tokens: 5, completion_tokens: 2 },
                choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "web_search", arguments: JSON.stringify({ query: "node lts" }) } }] } }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role?: string; content?: string }> };
          for (const message of body.messages ?? []) {
            if (message.role === "tool" && typeof message.content === "string") toolResults.push(message.content);
          }
          return new Response(
            JSON.stringify({ id: "chat-2", usage: { prompt_tokens: 6, completion_tokens: 3 }, choices: [{ message: { content: "ANSWERED" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      } as never,
      exhausted,
      { model: MODEL, effort: "low" },
    );
    assert.equal(searchCalls, 0, "no paid search is made once the allowance cannot cover one");
    assert.equal(toolResults.length, 1);
    assert.match(toolResults[0]!, /allowance/);
    // Metered as a refusal AT ZERO COST: "we ran out of money" must be legible in the ledger and
    // must not be hidden among searches that were attempted and failed.
    assert.equal(result.webSearchRefused, 1);
    assert.equal(result.webSearchAccepted, 0);
    assert.equal(result.webSearchUsd, 0, "a search that was never sent costs nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every refusal arm is reachable, and each names its own cause rather than a generic failure", async () => {
  // THE ARMS A HAPPY-PATH FIXTURE NEVER REACHES. Each one is the difference between an operator
  // reading "the endpoint is misconfigured" and reading "something went wrong" — and an untested
  // refusal is how a refusal quietly stops refusing.
  const call = (over: Partial<Parameters<typeof performCashWebSearch>[0]>) =>
    performCashWebSearch({
      query: "anything",
      endpoint: "https://example.test/openai/responses",
      apiKey: SEARCH_KEY,
      model: MODEL,
      ...over,
    } as Parameters<typeof performCashWebSearch>[0]);

  // (a) CONFIGURATION, raised before any request: these are programming/config errors, not search
  //     outcomes, so they THROW rather than returning a refusal the model would see as "no result".
  assert.throws(() => cashWebSearchEndpoint("", MODEL), /requires workerProviders\.cashEndpoint/);
  assert.throws(() => cashWebSearchEndpoint("http://example.test/", MODEL), /must use https/);
  await assert.rejects(() => call({ query: "   " }), /non-empty query/);
  await assert.rejects(() => call({ apiKey: "" }), new RegExp(CASH_WEB_SEARCH_KEY_ENV));

  // (b) A TRANSPORT FAILURE THAT IS NOT THE DEADLINE keeps its own message, so a DNS or TLS fault
  //     is never reported as a timeout. `usageRead: false` keeps the conservative reservation.
  const broken = await call({ fetchImpl: (async () => { throw new Error("ECONNREFUSED example.test"); }) as never });
  assert.equal(broken.outcome, "refused");
  assert.equal(broken.outcome === "refused" && broken.reason, "unreadable");
  assert.match(broken.outcome === "refused" ? broken.detail : "", /ECONNREFUSED/);
  assert.equal(broken.usageRead, false);

  // (c) A NON-2xx STATUS is its own reason, carrying the code.
  const http = await call({ fetchImpl: (async () => new Response("nope", { status: 503 })) as never });
  assert.equal(http.outcome === "refused" && http.reason, "http");
  assert.match(http.outcome === "refused" ? http.detail : "", /503/);

  // (d) A 2xx THAT IS NOT JSON — an upstream returning an HTML error page must not crash the tool
  //     loop, and must be distinguishable from a search that legitimately found nothing.
  const garbage = await call({
    fetchImpl: (async () => new Response("<html>gateway</html>", { status: 200 })) as never,
  });
  assert.equal(garbage.outcome === "refused" && garbage.reason, "unreadable");
  assert.match(garbage.outcome === "refused" ? garbage.detail : "", /not JSON/);
});
