import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Config } from "#src/lib/config.js";
import { DEFAULT_CASH_KEY_ENV } from "#src/lib/config-schema.js";
import {
  FOUNDRY_CLAUDE_PRICES,
  OPENWEIGHT_ABSENT_TTL_MS,
  OPENWEIGHT_ALLOWANCE_FILENAME,
  OPENWEIGHT_MAX_COMPLETION_TOKENS,
  OPENWEIGHT_PRICES,
  clearOpenWeightAbsence,
  openWeightReservationUsd,
  openWeightUsageUsd,
  reserveOpenWeightBudget,
  sendCashRequest,
  type OpenWeightAllowanceState,
} from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
// @ts-expect-error -- plain .mjs script has no type declarations
import { parseCashProbeArgs } from "#scripts/cash-request-probe.mjs";

// Any priced cash deployment with one flat rate and no Foundry Claude adapter will do.
const DEPLOYMENT = Object.keys(OPENWEIGHT_PRICES).find((name) =>
  !Object.hasOwn(FOUNDRY_CLAUDE_PRICES, name) && OPENWEIGHT_PRICES[name]!.longContext === undefined)!;
const KEY = "fixture-cash-key-never-printed";
const env = { [DEFAULT_CASH_KEY_ENV]: KEY };
const BODY = JSON.stringify({ model: DEPLOYMENT, input: "one input", questions: [{ type: "predicate", instructions: "q" }] });

function fixture(t: TestContext, cap: Config["dailyCapUsd"] = 25): { dir: string; config: Config } {
  clearOpenWeightAbsence();
  t.after(() => clearOpenWeightAbsence());
  const { dir } = ownedFixtureDir(t, "cash-single-request");
  return { dir, config: { claudeBin: "/unused", root: dir, dailyCapUsd: cap,
    workerProviders: { cashEndpoint: "https://cash.example.test/" } } as Config };
}

function allowance(dir: string): OpenWeightAllowanceState {
  return JSON.parse(readFileSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8"));
}

const USAGE = { input_tokens: 40, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };

function reply(usage: Record<string, unknown> = USAGE, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ model: DEPLOYMENT, answers: [{ type: "predicate", probability: 0.9 }], usage }),
    { status, headers: { "content-type": "application/json", ...headers } });
}

test("W1-T12413 criterion 1: one request goes to the deployment's endpoint and path with its key, reserves first and settles from the reply's usage", async (t) => {
  const { dir, config } = fixture(t);
  config.workerProviders!.cashDeploymentEndpoints = {
    [DEPLOYMENT]: { endpoint: "https://deployment.example.test/tenant/api", keyEnv: "DEPLOYMENT_CASH_KEY" },
  };
  const seen: Array<{ url: string; key: string | null; reservedBefore: number }> = [];
  const outcome = await sendCashRequest(config, { deployment: DEPLOYMENT, path: "openai/v1/decisions", body: BODY,
    source: "fixture", outputTokenCeiling: 16, env: { ...env, DEPLOYMENT_CASH_KEY: "deployment-specific-key" }, fetchImpl: async (url, init) => {
      seen.push({ url: String(url), key: new Headers(init?.headers).get("api-key"),
        reservedBefore: Object.keys(allowance(dir).reservations).length });
      return reply();
    } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://deployment.example.test/tenant/api/openai/v1/decisions");
  assert.equal(seen[0]!.key, "deployment-specific-key");
  assert.equal(seen[0]!.reservedBefore, 1);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.servedModel, DEPLOYMENT);
  assert.ok(outcome.latencyMs >= 0);
  assert.equal(outcome.settledUsd, openWeightUsageUsd(DEPLOYMENT, 40, 0));
  assert.equal(outcome.heldUsd, 0);
  assert.equal(outcome.reservedUsd, openWeightReservationUsd(DEPLOYMENT, Buffer.byteLength(BODY, "utf8"), 0, 16));
  const [row] = Object.values(allowance(dir).reservations);
  assert.equal(row!.settledUsd, openWeightUsageUsd(DEPLOYMENT, 40, 0));
});

test("W1-T12413 criterion 1: absolute caller URLs and paths escaping the deployment endpoint are refused before reservation or transport", async (t) => {
  for (const path of [
    "http://outside.example.test/openai/v1/decisions",
    "https://outside.example.test/openai/v1/decisions",
    "https://cash.example.test/tenant/api/openai/v1/decisions",
    "//outside.example.test/openai/v1/decisions",
    "\\\\outside.example.test/openai/v1/decisions",
    "/openai/v1/decisions",
    " https://outside.example.test/openai/v1/decisions",
    "ht\ntps://outside.example.test/openai/v1/decisions",
    "../decisions",
    "%2e%2e/decisions",
    "../api-other/decisions",
  ]) {
    await t.test(JSON.stringify(path), async (t) => {
      const { dir, config } = fixture(t);
      config.workerProviders!.cashEndpoint = "https://cash.example.test/tenant/api";
      let calls = 0;
      const outcome = await sendCashRequest(config, { deployment: DEPLOYMENT, path, body: BODY,
        source: "fixture", outputTokenCeiling: 16, env,
        fetchImpl: async () => { calls++; return reply(); } });
      assert.equal(calls, 0);
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.reason, "not-ready");
      assert.equal(outcome.reservedUsd, 0);
      assert.equal(outcome.settledUsd, 0);
      assert.equal(outcome.heldUsd, 0);
      assert.equal(existsSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME)), false);
    });
  }
});

test("W1-T12413 criterion 1: an unpriced deployment returns not-ready without sending or reserving", async (t) => {
  const { dir, config } = fixture(t);
  const deployment = "w1-t12413-unpriced-fixture";
  assert.equal(Object.hasOwn(OPENWEIGHT_PRICES, deployment), false);
  let calls = 0;
  const outcome = await sendCashRequest(config, { deployment, path: "openai/v1/decisions", body: BODY,
    source: "fixture", outputTokenCeiling: 16, env,
    fetchImpl: async () => { calls++; return reply(); } });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "not-ready");
  assert.equal(outcome.reservedUsd, 0);
  assert.equal(outcome.settledUsd, 0);
  assert.equal(outcome.heldUsd, 0);
  assert.equal(calls, 0);
  assert.equal(existsSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME)), false);
});

test("W1-T12413 criterion 2: the reservation counts the declared output ceiling, and a worker reservation costs the same as before", (t) => {
  const { config } = fixture(t);
  const bytes = 500;
  assert.equal(openWeightReservationUsd(DEPLOYMENT, bytes), openWeightReservationUsd(DEPLOYMENT, bytes, 0, OPENWEIGHT_MAX_COMPLETION_TOKENS));
  assert.ok(openWeightReservationUsd(DEPLOYMENT, bytes, 0, 16) < openWeightReservationUsd(DEPLOYMENT, bytes));
  const atIso = new Date().toISOString();
  const worker = reserveOpenWeightBudget(config, { requestId: "worker", deployment: DEPLOYMENT, requestBodyBytes: bytes, atIso });
  const single = reserveOpenWeightBudget(config, { requestId: "single", deployment: DEPLOYMENT, requestBodyBytes: bytes, atIso, outputTokenCeiling: 16 });
  assert.equal(worker.reservedUsd, openWeightReservationUsd(DEPLOYMENT, bytes));
  assert.equal(single.reservedUsd, openWeightReservationUsd(DEPLOYMENT, bytes, 0, 16));
});

for (const normal of [0, 1e-9]) {
  test(`W1-T12413 criterion 3: a normal-cap refusal (${normal}) sends nothing, and the squeezed figure is never read`, async (t) => {
    let squeezedReads = 0;
    const squeezed = 1000;
    const { dir, config } = fixture(t, { normal, get squeezed() { squeezedReads++; return squeezed; } });
    const reservationUsd = openWeightReservationUsd(DEPLOYMENT, Buffer.byteLength(BODY, "utf8"), 0, 16);
    assert.ok(reservationUsd > normal);
    assert.ok(reservationUsd < squeezed);
    let calls = 0;
    const outcome = await sendCashRequest(config, { deployment: DEPLOYMENT, path: "openai/v1/decisions", body: BODY,
      source: "fixture", outputTokenCeiling: 16, env, fetchImpl: async () => { calls++; return reply(); } });
    assert.equal(squeezedReads, 0);
    assert.equal(calls, 0);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, "budget-refused");
    assert.equal(outcome.reservedUsd, 0);
    assert.equal(outcome.settledUsd, 0);
    assert.equal(outcome.heldUsd, 0);
    assert.match(outcome.detail, /normal|fleet|cap/i);
    let reservations: OpenWeightAllowanceState["reservations"] = {};
    try { reservations = allowance(dir).reservations; } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    }
    assert.equal(Object.keys(reservations).length, 0);
  });
}

test("W1-T12413 criterion 4: a missed deadline or a caller abort keeps the reservation held, and a late reply still settles", async (t) => {
  const { dir, config } = fixture(t);
  // The clock holds still, so a slow reservation write cannot use up the deadline before the send;
  // only the deadline timer ends the wait, and the reply comes after that abort.
  const held = Date.now();
  const stillClock = { now: () => held, iso: () => new Date(held).toISOString() };
  const late = await sendCashRequest(config, { deployment: DEPLOYMENT, path: "openai/v1/decisions", body: BODY,
    source: "fixture", outputTokenCeiling: 16, env, requestTimeoutMs: 40, clock: stillClock,
    fetchImpl: (_url, init) => new Promise<Response>((resolve) => {
      init?.signal?.addEventListener("abort", () => resolve(reply()), { once: true });
    }) });
  assert.equal(late.ok, false);
  if (late.ok) return;
  assert.equal(late.reason, "timeout");
  assert.equal(late.heldUsd, late.reservedUsd);
  assert.ok(late.reservedUsd > 0);
  const deadline = Date.now() + 5_000;
  let row = Object.values(allowance(dir).reservations)[0]!;
  while (row.settledUsd === null && Date.now() < deadline) {
    await delay(20);
    row = Object.values(allowance(dir).reservations)[0]!;
  }
  assert.equal(row.settledUsd, openWeightUsageUsd(DEPLOYMENT, 40, 0));

  const controller = new AbortController();
  const aborted = sendCashRequest(config, { deployment: DEPLOYMENT, path: "openai/v1/decisions", body: BODY,
    source: "fixture", outputTokenCeiling: 16, env, signal: controller.signal,
    fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }) });
  await delay(10);
  controller.abort(new Error("caller stopped"));
  const stopped = await aborted;
  assert.equal(stopped.ok, false);
  if (stopped.ok) return;
  assert.equal(stopped.reason, "aborted");
  assert.equal(stopped.heldUsd, stopped.reservedUsd);
});

test("W1-T12413 criterion 4: a deadline that passes before the request is sent releases the reservation at zero, and nothing is sent", async (t) => {
  const { dir, config } = fixture(t);
  // The reservation is stamped with clock.iso(); moving the clock past the deadline there is a
  // reservation write that took longer than the whole deadline.
  let now = Date.now();
  const clock = { now: () => now, iso: () => { const iso = new Date(now).toISOString(); now += 41; return iso; } };
  let calls = 0;
  const outcome = await sendCashRequest(config, { deployment: DEPLOYMENT, path: "openai/v1/decisions", body: BODY,
    source: "fixture", outputTokenCeiling: 16, env, requestTimeoutMs: 40, clock,
    fetchImpl: async () => { calls++; return reply(); } });
  assert.equal(calls, 0);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "timeout");
  assert.ok(outcome.reservedUsd > 0);
  assert.equal(outcome.heldUsd, 0);
  assert.equal(outcome.settledUsd, 0);
  const [row] = Object.values(allowance(dir).reservations);
  assert.equal(row!.settledUsd, 0);
  assert.equal(row!.accountingState, "known-unbilled");
  assert.match(row!.settledReason ?? "", /^not sent: /);
});

test("W1-T12413 criterion 5: a 429 inside the deadline is sent once more with a new reservation, and the refused attempt stays charged", async (t) => {
  const { dir, config } = fixture(t);
  let calls = 0;
  const outcome = await sendCashRequest(config, { deployment: DEPLOYMENT, path: "openai/v1/decisions", body: BODY,
    source: "fixture", outputTokenCeiling: 16, env, requestTimeoutMs: 5_000, fetchImpl: async () => {
      calls++;
      return calls === 1 ? new Response("{}", { status: 429, headers: { "retry-after-ms": "10" } }) : reply();
    } });
  assert.equal(calls, 2);
  assert.equal(outcome.ok, true);
  const rows = Object.values(allowance(dir).reservations);
  assert.equal(rows.length, 2);
  const refused = rows.find((row) => row.settledUsd === null)!;
  assert.match(refused.heldReason ?? "", /429/);
  assert.equal(rows.filter((row) => row.settledUsd === openWeightUsageUsd(DEPLOYMENT, 40, 0)).length, 1);
  if (!outcome.ok) return;
  assert.equal(outcome.reservedUsd, rows.reduce((sum, row) => sum + row.reservedUsd, 0));
});

for (const azure of [true, false]) {
  test(`W1-T12413 criterion 5: consecutive 429s settle both attempts according to endpoint policy (azure=${azure})`, async (t) => {
    const { dir, config } = fixture(t);
    const deployment = "gpt-5-nano";
    config.workerProviders!.cashEndpoint = azure ? "https://fixture.openai.azure.com/" : "https://cash.example.test/";
    let calls = 0;
    const outcome = await sendCashRequest(config, { deployment, path: "openai/v1/decisions", body: BODY,
      source: "fixture", outputTokenCeiling: 16, env, requestTimeoutMs: 5_000,
      fetchImpl: async () => {
        calls++;
        assert.equal(Object.keys(allowance(dir).reservations).length, calls);
        return new Response("{}", { status: 429, headers: { "retry-after-ms": "10" } });
      } });
    assert.equal(calls, 2);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, "http");
    assert.equal(outcome.status, 429);
    const rows = Object.values(allowance(dir).reservations);
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map(row => row.identity!.requestId)).size, 2);
    const reserved = openWeightReservationUsd(deployment, Buffer.byteLength(BODY, "utf8"), 0, 16);
    assert.equal(outcome.reservedUsd, reserved * 2);
    assert.equal(outcome.settledUsd, azure ? 0 : reserved * 2);
    assert.equal(outcome.heldUsd, azure ? 0 : reserved * 2);
    for (const row of rows) {
      assert.equal(row.reservedUsd, reserved);
      assert.equal(row.settledUsd, azure ? 0 : null);
      assert.equal(row.heldUsd, azure ? 0 : reserved);
      assert.equal(row.accountingState, azure ? "known-unbilled" : "held-unknown");
      assert.match((azure ? row.settledReason : row.heldReason) ?? "", /429/);
    }
  });
}

test("W1-T12413 criterion 6: a 404 settles at zero and marks the deployment absent, so a second call sends nothing", async (t) => {
  const { dir, config } = fixture(t);
  let calls = 0;
  const notFound = async () => { calls++; return new Response("{}", { status: 404 }); };
  const first = await sendCashRequest(config, { deployment: DEPLOYMENT, path: "openai/v1/decisions", body: BODY,
    source: "fixture", outputTokenCeiling: 16, env, fetchImpl: notFound });
  assert.equal(first.ok, false);
  if (first.ok) return;
  assert.equal(first.reason, "deployment-absent");
  assert.equal(first.status, 404);
  assert.equal(first.settledUsd, 0);
  assert.equal(Object.values(allowance(dir).reservations)[0]!.settledUsd, 0);
  let now = Date.now();
  const clock = { now: () => now, iso: () => new Date(now).toISOString() };
  const second = await sendCashRequest(config, { deployment: DEPLOYMENT, path: "openai/v1/decisions", body: BODY,
    source: "fixture", outputTokenCeiling: 16, env, clock, fetchImpl: notFound });
  assert.equal(calls, 1);
  assert.equal(second.ok === false && second.reason, "deployment-absent");
  now += OPENWEIGHT_ABSENT_TTL_MS + 1;
  await sendCashRequest(config, { deployment: DEPLOYMENT, path: "openai/v1/decisions", body: BODY,
    source: "fixture", outputTokenCeiling: 16, env, clock, fetchImpl: notFound });
  assert.equal(calls, 2);
});

test("W1-T12413 criterion 7: with no fetch injected the global fetch sends it, and a refused connection is a named transport failure that stays held", async (t) => {
  const { config } = fixture(t);
  config.workerProviders = { cashEndpoint: "https://127.0.0.1:1/" };
  const outcome = await sendCashRequest(config, { deployment: DEPLOYMENT, path: "openai/v1/decisions", body: BODY,
    source: "fixture", outputTokenCeiling: 16, env, requestTimeoutMs: 10_000 });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "transport");
  assert.ok(outcome.reservedUsd > 0);
  assert.equal(outcome.heldUsd, outcome.reservedUsd);
});

async function probe(home: string, args: string[], preload?: string): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx",
      ...(preload ? ["--import", preload] : []), join(REPO_ROOT, "scripts", "cash-request-probe.mjs"), ...args],
      { cwd: REPO_ROOT, env: { ...process.env, HOME: home, ...env }, timeout: 60_000 });
    return { code: 0, stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "" };
  }
}

test("W1-T12413 criterion 8: the probe script sends one request and prints the status, latency and dollars, never the key", async (t) => {
  const { dir } = ownedFixtureDir(t, "cash-request-probe");
  mkdirSync(join(dir, ".config", "remudero"), { recursive: true });
  writeFileSync(join(dir, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: process.execPath, root: dir,
    dailyCapUsd: 25, workerProviders: { cashEndpoint: "https://127.0.0.1:1/" } }));
  const bodyFile = join(dir, "body.json");
  writeFileSync(bodyFile, BODY);
  const sent = await probe(dir, ["--deployment", DEPLOYMENT, "--path", "openai/v1/decisions", "--body-file", bodyFile, "--output-tokens", "16"]);
  assert.equal(sent.code, 1, sent.stdout);
  const lines = sent.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes(KEY));
  assert.ok(!lines[0]!.includes("one input"));
  const printed = JSON.parse(lines[0]!);
  assert.equal(printed.ok, false);
  assert.equal(printed.reason, "transport");
  assert.deepEqual(Object.keys(printed).sort(), ["heldUsd", "latencyMs", "ok", "reason", "reservedUsd", "settledUsd"].sort());
  assert.equal(typeof printed.latencyMs, "number");
  assert.equal(printed.reservedUsd, openWeightReservationUsd(DEPLOYMENT, Buffer.byteLength(BODY, "utf8"), 0, 16));
  assert.equal(printed.heldUsd, printed.reservedUsd);
  assert.equal(Object.keys(allowance(dir).reservations).length, 1);

  const unpriced = await probe(dir, ["--deployment", "w1-t12413-unpriced-fixture", "--path", "openai/v1/decisions",
    "--body-file", bodyFile, "--output-tokens", "16"]);
  assert.equal(unpriced.code, 1, unpriced.stdout);
  assert.equal(unpriced.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(unpriced.stdout).reason, "not-ready");
  assert.equal(JSON.parse(unpriced.stdout).reservedUsd, 0);

  const usage = await probe(dir, ["--deployment", DEPLOYMENT]);
  assert.equal(usage.code, 2);
  assert.equal(JSON.parse(usage.stdout).reason, "usage");
});

test("W1-T12413 criterion 8: a successful probe omits echoed credentials and request body", async (t) => {
  const { dir } = ownedFixtureDir(t, "cash-request-probe-success");
  const preload = join(dir, "echo-reply.mjs");
  writeFileSync(preload, `globalThis.fetch = async (_url, init) => new Response(JSON.stringify({
    model: ${JSON.stringify(DEPLOYMENT)}, usage: ${JSON.stringify(USAGE)},
    echo: { key: new Headers(init.headers).get("api-key"), body: init.body }
  }), { status: 200, headers: { "content-type": "application/json" } });\n`);
  mkdirSync(join(dir, ".config", "remudero"), { recursive: true });
  writeFileSync(join(dir, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: process.execPath, root: dir,
    dailyCapUsd: 25, workerProviders: { cashEndpoint: "https://cash.example.test/" } }));
  const bodyFile = join(dir, "body.json");
  writeFileSync(bodyFile, BODY);
  const sent = await probe(dir, ["--deployment", DEPLOYMENT, "--path", "openai/v1/decisions",
    "--body-file", bodyFile, "--output-tokens", "16"], preload);
  assert.equal(sent.code, 0, sent.stdout);
  assert.equal(sent.stdout.trim().split("\n").length, 1);
  assert.ok(!sent.stdout.includes(KEY));
  assert.ok(!sent.stdout.includes(BODY));
  assert.ok(!sent.stdout.includes("one input"));
  const printed = JSON.parse(sent.stdout);
  assert.deepEqual(Object.keys(printed).sort(), ["heldUsd", "latencyMs", "ok", "reservedUsd", "servedModel", "settledUsd"].sort());
  assert.equal(printed.ok, true);
  assert.equal(printed.servedModel, DEPLOYMENT);
  assert.equal(Object.keys(allowance(dir).reservations).length, 1);
  assert.equal(printed.reservedUsd, openWeightReservationUsd(DEPLOYMENT, Buffer.byteLength(BODY, "utf8"), 0, 16));
  assert.equal(printed.settledUsd, openWeightUsageUsd(DEPLOYMENT, 40, 0));
  assert.equal(printed.heldUsd, 0);
});

test("W1-T12413 criterion 8: the probe parser rejects an unknown flag and a flag without a value", () => {
  const unknown = parseCashProbeArgs(["--bogus", "x"]);
  assert.match(unknown.error, /bad argument "--bogus"/);
  const missingValue = parseCashProbeArgs(["--deployment"]);
  assert.match(missingValue.error, /bad argument "--deployment"/);
});
