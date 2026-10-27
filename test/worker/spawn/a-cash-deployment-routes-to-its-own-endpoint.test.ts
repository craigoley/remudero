/**
 * W1-T10837 — THE CASH LANE ROUTES EACH DEPLOYMENT TO ITS OWN ENDPOINT AND KEY.
 *
 * Config maps a deployment id to `{endpoint, keyEnv}` (`workerProviders.cashDeploymentEndpoints`,
 * src/lib/config-schema.ts). A deployment the map does not name keeps the existing default
 * (`cashEndpoint`, then the deprecated `openweightEndpoint`) and `RMD_OPENWEIGHT_API_KEY` exactly
 * as before -- byte-identical to a host with no map at all. Every cash endpoint reader -- the chat
 * and Responses transport, the key read, both web_search readers, the replay-harness pin and the
 * cash model catalog -- resolves a deployment's target through the ONE resolver
 * (`cashDeploymentTarget` / `cashDeploymentEndpoint`, src/lib/config-schema.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock } from "#src/lib/clock.js";
import {
  cashConfiguredAccounts,
  cashDeploymentEndpoint,
  cashDeploymentTarget,
  ConfigShapeError,
  isAllowedCashDeploymentKeyEnv,
  validateConfigShape,
} from "#src/lib/config-schema.js";
import { CASH_WEB_SEARCH_KEY_ENV } from "#src/lib/cash-web-bridge.js";
import { readCashModelCatalog, type CashCatalogAccountFailure } from "#src/lib/model-availability.js";
import { reviewerReplayStack } from "#src/lib/replay-harness.js";
import {
  CashDeploymentNotReadyError,
  OPENWEIGHT_ALLOWANCE_FILENAME,
  openWeightCheckEnv,
  spawnOpenWeightWorker,
} from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const AT_ISO = "2026-10-27T12:00:00.000Z";
// Both carry existing price/temperature/shape rows (see OPENWEIGHT_PRICES et al.) -- the real
// second-account deployment (gpt-6.1-terra, W1-T10838) is not yet priced, and the map is DATA, so
// any already-shaped deployment id stands in for "a deployment on a second account" here.
const MAPPED_MODEL = "gpt-6-luna";
const UNMAPPED_MODEL = "gpt-5-nano";
const DEFAULT_ENDPOINT = "https://default-account.openai.azure.com/";
const MAPPED_ENDPOINT = "https://synthwatch-foundry-eus.cognitiveservices.azure.com/";
const MAPPED_KEY_ENV = "RMD_CASH_EASTUS_API_KEY";
const DEFAULT_KEY = "default-account-fixture-not-a-credential";
const MAPPED_KEY = "eastus-account-fixture-not-a-credential";

function mappedConfig(root: string): Config {
  return {
    claudeBin: "/unused", root, dailyCapUsd: 25,
    workerProviders: {
      enabled: ["cash"],
      cashEndpoint: DEFAULT_ENDPOINT,
      cashDeploymentEndpoints: { [MAPPED_MODEL]: { endpoint: MAPPED_ENDPOINT, keyEnv: MAPPED_KEY_ENV } },
    },
  } as Config;
}

function chatCompletion(): Response {
  return new Response(JSON.stringify({
    id: "fixture", model: "served-fixture", usage: { prompt_tokens: 10, completion_tokens: 2 },
    choices: [{ finish_reason: "stop", message: { content: "DONE" } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function apiKeyHeader(init: RequestInit | undefined): string {
  return String((init?.headers as Record<string, string> | undefined)?.["api-key"]);
}

test("W1-T10837: a mapped deployment uses its own endpoint and key and an unmapped one keeps the default", async (t) => {
  const seen: Array<{ url: string; apiKey: string }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), apiKey: apiKeyHeader(init) });
    return chatCompletion();
  };

  const { dir: mappedHome } = ownedFixtureDir(t, "cash-deployment-routing-mapped");
  const mapped = await spawnOpenWeightWorker({
    cwd: mappedHome, workerHome: mappedHome, prompt: "p", tools: [], maxTurns: 1,
    env: { RMD_OPENWEIGHT_API_KEY: DEFAULT_KEY, [MAPPED_KEY_ENV]: MAPPED_KEY },
    clock: fixedClock(Date.parse(AT_ISO)), fetchImpl,
  } as never, mappedConfig(mappedHome), { model: MAPPED_MODEL, effort: "low" });
  assert.equal(mapped.isError, false, mapped.stderr);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.url.startsWith(MAPPED_ENDPOINT), `expected the mapped endpoint, got ${seen[0]!.url}`);
  assert.equal(seen[0]!.apiKey, MAPPED_KEY, "a mapped deployment sends its OWN key, never the default");

  const { dir: unmappedHome } = ownedFixtureDir(t, "cash-deployment-routing-unmapped");
  const unmapped = await spawnOpenWeightWorker({
    cwd: unmappedHome, workerHome: unmappedHome, prompt: "p", tools: [], maxTurns: 1,
    env: { RMD_OPENWEIGHT_API_KEY: DEFAULT_KEY, [MAPPED_KEY_ENV]: MAPPED_KEY },
    clock: fixedClock(Date.parse(AT_ISO)), fetchImpl,
  } as never, mappedConfig(unmappedHome), { model: UNMAPPED_MODEL, effort: "low" });
  assert.equal(unmapped.isError, false, unmapped.stderr);
  assert.equal(seen.length, 2);
  assert.ok(seen[1]!.url.startsWith(DEFAULT_ENDPOINT), `expected the default endpoint, got ${seen[1]!.url}`);
  assert.equal(seen[1]!.apiKey, DEFAULT_KEY, "an unmapped deployment keeps the default key");

  // Byte-identical to a host with no map at all: the same unmapped request against a config that
  // never carries `cashDeploymentEndpoints` sends the identical endpoint and key.
  const { dir: noMapHome } = ownedFixtureDir(t, "cash-deployment-routing-no-map");
  const noMapConfig = { claudeBin: "/unused", root: noMapHome, dailyCapUsd: 25,
    workerProviders: { enabled: ["cash"], cashEndpoint: DEFAULT_ENDPOINT } } as Config;
  const noMap = await spawnOpenWeightWorker({
    cwd: noMapHome, workerHome: noMapHome, prompt: "p", tools: [], maxTurns: 1,
    env: { RMD_OPENWEIGHT_API_KEY: DEFAULT_KEY }, clock: fixedClock(Date.parse(AT_ISO)), fetchImpl,
  } as never, noMapConfig, { model: UNMAPPED_MODEL, effort: "low" });
  assert.equal(noMap.isError, false, noMap.stderr);
  assert.equal(seen[2]!.url, seen[1]!.url, "a host with no map at all sends the byte-identical request");
  assert.equal(seen[2]!.apiKey, seen[1]!.apiKey);
});

test("W1-T10837: every cash endpoint reader resolves through the per-deployment resolver", async (t) => {
  const config = mappedConfig("/unused-root-pure-functions-never-touch-disk");

  await t.test("the chat/Responses transport (openWeightEndpoint) resolves the deployment's own endpoint", () => {
    assert.equal(cashDeploymentEndpoint(config, MAPPED_MODEL), MAPPED_ENDPOINT);
    assert.equal(cashDeploymentEndpoint(config, UNMAPPED_MODEL), DEFAULT_ENDPOINT);
  });

  await t.test("the key read (spawnOpenWeightWorker) resolves through cashDeploymentTarget", () => {
    const mapped = cashDeploymentTarget(config, MAPPED_MODEL, { [MAPPED_KEY_ENV]: MAPPED_KEY });
    assert.deepEqual(mapped, { ok: true, endpoint: MAPPED_ENDPOINT, key: MAPPED_KEY, keyEnv: MAPPED_KEY_ENV, mapped: true });
    const unmapped = cashDeploymentTarget(config, UNMAPPED_MODEL, { RMD_OPENWEIGHT_API_KEY: DEFAULT_KEY });
    assert.deepEqual(unmapped, { ok: true, endpoint: DEFAULT_ENDPOINT, key: DEFAULT_KEY, keyEnv: "RMD_OPENWEIGHT_API_KEY", mapped: false });
    const noEndpoint = cashDeploymentTarget({ workerProviders: {} }, MAPPED_MODEL, {});
    assert.deepEqual(noEndpoint, { ok: false, reason: "no-endpoint" });
  });

  await t.test("both web_search readers (the broker in worker-provider.ts and cash-web-bridge.ts's URL builder) resolve the deployment's own endpoint, keeping the shared search credential", async () => {
    const { dir } = ownedFixtureDir(t, "cash-deployment-routing-websearch");
    const seen: Array<{ url: string; apiKey: string }> = [];
    let chatTurn = 0;
    const result = await spawnOpenWeightWorker({
      cwd: dir, workerHome: dir, prompt: "what shipped today", tools: ["Read", "WebSearch"], maxTurns: 3,
      env: { RMD_OPENWEIGHT_API_KEY: DEFAULT_KEY, [MAPPED_KEY_ENV]: MAPPED_KEY, [CASH_WEB_SEARCH_KEY_ENV]: "search-fixture-not-a-credential" },
      clock: fixedClock(Date.parse(AT_ISO)),
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        seen.push({ url: href, apiKey: apiKeyHeader(init) });
        if (href.includes("/openai/responses")) {
          return Response.json({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: "found it", annotations: [{ type: "url_citation", url: "https://example.test/a" }] }] }] });
        }
        chatTurn += 1;
        if (chatTurn === 1) {
          return Response.json({ id: "chat-1", usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ message: { content: null, tool_calls: [{ id: "call-1", function: { name: "web_search", arguments: JSON.stringify({ query: "node lts" }) } }] } }] });
        }
        return chatCompletion();
      },
    } as never, { ...mappedConfig(dir), workerProviders: { ...mappedConfig(dir).workerProviders, cashWebSearch: true } } as Config,
      { model: MAPPED_MODEL, effort: "low" });
    assert.equal(result.isError, false, result.stderr);
    const search = seen.find((s) => s.url.includes("/openai/responses"));
    assert.ok(search, "the web_search leg must have run");
    assert.ok(search!.url.startsWith(MAPPED_ENDPOINT), `expected the mapped deployment's own endpoint, got ${search!.url}`);
    assert.equal(search!.apiKey, "search-fixture-not-a-credential", "the search credential stays the shared daemon key, never the deployment's own key");
    const chat = seen.filter((s) => !s.url.includes("/openai/responses"));
    assert.ok(chat.every((c) => c.url.startsWith(MAPPED_ENDPOINT)), "the chat legs of the SAME deployment use its own endpoint too");
    assert.ok(chat.every((c) => c.apiKey === MAPPED_KEY), "the chat legs use the deployment's own key");
  });

  await t.test("the replay-harness pin (reviewerReplayStack) resolves the reviewer deployment's own endpoint", () => {
    const defaultStack = reviewerReplayStack({ claudeBin: "/unused", root: "/unused", workerProviders: { cashEndpoint: DEFAULT_ENDPOINT } } as Config);
    const mappedStack = reviewerReplayStack({
      claudeBin: "/unused", root: "/unused",
      workerProviders: { cashEndpoint: DEFAULT_ENDPOINT, cashDeploymentEndpoints: { "gpt-6.1-sol": { endpoint: MAPPED_ENDPOINT, keyEnv: MAPPED_KEY_ENV } } },
    } as Config);
    assert.notEqual(mappedStack.environment, defaultStack.environment, "a mapped reviewer endpoint must change the environment pin");
    // No key anywhere in the daemon environment -- the pin must still be computable (unlike a live spawn).
    assert.doesNotThrow(() => reviewerReplayStack({ claudeBin: "/unused", root: "/unused", workerProviders: { cashEndpoint: DEFAULT_ENDPOINT } } as Config));
  });

  await t.test("the cash model catalog's accounts are the SAME resolver output", () => {
    assert.deepEqual(cashConfiguredAccounts(config), [
      { endpoint: DEFAULT_ENDPOINT, keyEnv: "RMD_OPENWEIGHT_API_KEY" },
      { endpoint: MAPPED_ENDPOINT, keyEnv: MAPPED_KEY_ENV },
    ]);
  });
});

test("W1-T10837: the cash model catalog reads every configured endpoint", async () => {
  const config = mappedConfig("/unused-root");
  const fetchByHost = async (url: string | URL | Request) => {
    const href = String(url);
    if (href.startsWith(DEFAULT_ENDPOINT)) return Response.json({ data: [{ id: "gpt-5-nano" }] });
    if (href.startsWith(MAPPED_ENDPOINT)) return Response.json({ data: [{ id: "gpt-6.1-terra" }] });
    throw new Error(`unexpected catalog url ${href}`);
  };

  const union = await readCashModelCatalog(config, fetchByHost, { RMD_OPENWEIGHT_API_KEY: DEFAULT_KEY, [MAPPED_KEY_ENV]: MAPPED_KEY });
  assert.deepEqual(union, ["gpt-5-nano", "gpt-6.1-terra"], "the union names a deployment on EITHER account");

  // One account unreadable: named, and the other account's listing survives.
  const failures: CashCatalogAccountFailure[] = [];
  const partial = await readCashModelCatalog(config, async (url: string | URL | Request) => {
    const href = String(url);
    if (href.startsWith(MAPPED_ENDPOINT)) return new Response("nope", { status: 503 });
    return fetchByHost(url);
  }, { RMD_OPENWEIGHT_API_KEY: DEFAULT_KEY, [MAPPED_KEY_ENV]: MAPPED_KEY }, (failure) => failures.push(failure));
  assert.deepEqual(partial, ["gpt-5-nano"], "the readable account's listing is not hidden by the other's failure");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.endpoint, MAPPED_ENDPOINT);
  assert.equal(failures[0]!.keyEnv, MAPPED_KEY_ENV);
  assert.match(failures[0]!.reason, /HTTP 503/);

  // Every account unreadable: refuses, naming both.
  await assert.rejects(
    () => readCashModelCatalog(config, async () => new Response("nope", { status: 500 }),
      { RMD_OPENWEIGHT_API_KEY: DEFAULT_KEY, [MAPPED_KEY_ENV]: MAPPED_KEY }),
    (error: Error) => {
      assert.match(error.message, /HTTP 500/);
      return true;
    },
  );

  // An unmapped host (no cashDeploymentEndpoints at all) is byte-identical to before.
  const unmappedConfig = { ...config, workerProviders: { enabled: ["cash"], cashEndpoint: DEFAULT_ENDPOINT } } as Config;
  await assert.rejects(
    () => readCashModelCatalog({ claudeBin: "/unused", root: "/unused" } as Config, async () => new Response()),
    /cash model catalog requires workerProviders\.cashEndpoint/,
  );
  await assert.rejects(
    () => readCashModelCatalog(unmappedConfig, async () => new Response(), {}),
    /cash model catalog requires RMD_OPENWEIGHT_API_KEY/,
  );
});

test("W1-T10837: a mapping that could send another secret or reach a non-Azure host is refused", async (t) => {
  await t.test("keyEnv outside the cash-key shape is refused by name", () => {
    assert.equal(isAllowedCashDeploymentKeyEnv("RMD_OPENWEIGHT_API_KEY"), true);
    assert.equal(isAllowedCashDeploymentKeyEnv(MAPPED_KEY_ENV), true);
    for (const unsafe of ["HOME", "PATH", "ANTHROPIC_API_KEY", "GH_TOKEN", "RMD_CASH_API_KEY"]) {
      assert.equal(isAllowedCashDeploymentKeyEnv(unsafe), false, unsafe);
    }
    assert.throws(
      () => validateConfigShape({
        claudeBin: "/unused", root: "/unused",
        workerProviders: { cashDeploymentEndpoints: { bad: { endpoint: MAPPED_ENDPOINT, keyEnv: "HOME" } } },
      }, "test"),
      (error: unknown) => {
        assert.ok(error instanceof ConfigShapeError);
        assert.match(error.message, /cashDeploymentEndpoints\.bad\.keyEnv/);
        return true;
      },
    );
  });

  await t.test("a non-https or non-Azure endpoint is refused by name", () => {
    for (const unsafeEndpoint of ["https://evil.example.com/", "http://synthwatch-foundry-eus.cognitiveservices.azure.com/", "not a url"]) {
      assert.throws(
        () => validateConfigShape({
          claudeBin: "/unused", root: "/unused",
          workerProviders: { cashDeploymentEndpoints: { bad: { endpoint: unsafeEndpoint, keyEnv: MAPPED_KEY_ENV } } },
        }, "test"),
        (error: unknown) => {
          assert.ok(error instanceof ConfigShapeError);
          assert.match(error.message, /cashDeploymentEndpoints\.bad\.endpoint/);
          return true;
        },
        unsafeEndpoint,
      );
    }
  });

  await t.test("a safe mapping (the default key OR the cash-key shape, an https Azure host) loads cleanly", () => {
    assert.doesNotThrow(() => validateConfigShape({
      claudeBin: "/unused", root: "/unused",
      workerProviders: { cashDeploymentEndpoints: { ok: { endpoint: MAPPED_ENDPOINT, keyEnv: MAPPED_KEY_ENV } } },
    }, "test"));
  });

  await t.test("a mapped deployment whose keyEnv is unset is NOT READY and never borrows the default key", async (t2) => {
    const { dir } = ownedFixtureDir(t2, "cash-deployment-not-ready");
    let calls = 0;
    const result = await spawnOpenWeightWorker({
      cwd: dir, workerHome: dir, prompt: "p", tools: [], maxTurns: 1,
      env: { RMD_OPENWEIGHT_API_KEY: DEFAULT_KEY }, // MAPPED_KEY_ENV deliberately absent
      clock: fixedClock(Date.parse(AT_ISO)),
      fetchImpl: async () => { calls += 1; return chatCompletion(); },
    } as never, mappedConfig(dir), { model: MAPPED_MODEL, effort: "low" });
    assert.equal(calls, 0, "a not-ready deployment must never reach the transport");
    assert.equal(result.isError, true);
    assert.match(result.stderr, new RegExp(MAPPED_KEY_ENV));
    assert.equal(result.stderr.includes(DEFAULT_KEY), false, "it must not borrow the default key's value either");
  });
});

test("W1-T10837: the per-deployment key never reaches a ledger row, log or worker environment", async (t) => {
  await t.test("a mapped deployment's spend row and result carry the keyEnv NAME, never the key VALUE", async (t2) => {
    const { dir } = ownedFixtureDir(t2, "cash-deployment-key-secrecy");
    const originalLog = console.log, originalError = console.error;
    const logged: string[] = [];
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    let result;
    try {
      result = await spawnOpenWeightWorker({
        cwd: dir, workerHome: dir, prompt: "p", tools: [], maxTurns: 1,
        env: { RMD_OPENWEIGHT_API_KEY: DEFAULT_KEY, [MAPPED_KEY_ENV]: MAPPED_KEY },
        clock: fixedClock(Date.parse(AT_ISO)),
        fetchImpl: async () => chatCompletion(),
      } as never, mappedConfig(dir), { model: MAPPED_MODEL, effort: "low" });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.equal(result.isError, false, result.stderr);
    assert.equal(JSON.stringify(result).includes(MAPPED_KEY), false, "the key value must never enter the reported result");
    assert.equal(logged.some((line) => line.includes(MAPPED_KEY)), false, "the key value must never reach a log line");
    const allowance = readFileSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8");
    assert.equal(allowance.includes(MAPPED_KEY), false, "the key value must never reach the spend ledger row");
  });

  await t.test("the mapped key shape (and the shared search key, the same shape) trips the worker-environment boundary", (t2) => {
    const { dir } = ownedFixtureDir(t2, "cash-deployment-key-boundary");
    for (const key of [MAPPED_KEY_ENV, CASH_WEB_SEARCH_KEY_ENV]) {
      assert.throws(() => openWeightCheckEnv(dir, {}, { [key]: "forbidden" }), /credential|billing-boundary/, key);
    }
  });

  await t.test("a not-ready deployment refuses by a NAMED error class, carrying only the keyEnv name", async (t2) => {
    const { dir } = ownedFixtureDir(t2, "cash-deployment-not-ready-error-shape");
    const result = await spawnOpenWeightWorker({
      cwd: dir, workerHome: dir, prompt: "p", tools: [], maxTurns: 1,
      env: { RMD_OPENWEIGHT_API_KEY: DEFAULT_KEY },
      clock: fixedClock(Date.parse(AT_ISO)),
      fetchImpl: async () => chatCompletion(),
    } as never, mappedConfig(dir), { model: MAPPED_MODEL, effort: "low" });
    assert.equal(result.isError, true);
    assert.match(result.stderr, /CashDeploymentNotReadyError|unset in the daemon environment/);
    const direct = new CashDeploymentNotReadyError(MAPPED_MODEL, MAPPED_KEY_ENV);
    assert.equal(direct.name, "CashDeploymentNotReadyError");
    assert.equal(direct.keyEnv, MAPPED_KEY_ENV);
    assert.equal(direct.message.includes(MAPPED_KEY), false, "the error carries the keyEnv name only, never a key value");
  });
});
