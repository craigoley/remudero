import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";
import { OPENWEIGHT_ALLOWANCE_FILENAME, openWeightUsageUsd, openWeightReservationUsd, spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import { createCapabilityGrant, InMemoryCapabilityGrantStore } from "#src/lib/capability-grant.js";
import { spawnWorker, WorkerAbandonedError } from "#src/lib/worker.js";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const requestId = "3a2c1a77-453a-4cad-9165-a6bb1cb26400";
const secret = "test-only-private-key-do-not-record";

async function refusal(t: TestContext, response: Response, model = "gpt-6-luna") {
  const { dir } = ownedFixtureDir(t, "cash-http-evidence");
  let calls = 0;
  const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: "private prompt", tools: [],
    env: { RMD_OPENWEIGHT_API_KEY: secret, RMD_FOUNDRY_CLAUDE_API_KEY: secret,
      RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" },
    clock: fixedClock(Date.now()), fetchImpl: async () => { calls++; return response; },
  }, { root: dir, dailyCapUsd: 25, workerProviders: { cashEndpoint: "https://foundry.example.test/" } } as Config,
  { model, effort: "low" });
  const allowance = readFileSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8");
  return { result, calls, allowance };
}

test("cash HTTP refusals retain allowlisted rate evidence through every real adapter without retrying", async t => {
  for (const model of ["gpt-6-luna", "gpt-6.1-sol", "claude-haiku-5-5"]) {
    await t.test(model, async child => {
      const { result, calls, allowance } = await refusal(child, new Response("private response body", { status: 429, headers: {
        "retry-after-ms": "1500", "retry-after": "9", "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-remaining-tokens": "42", "apim-request-id": requestId,
        "authorization": secret, "api-key": secret, "set-cookie": secret,
      } }), model);
      assert.equal(result.isError, true);
      assert.equal(result.subtype, "openweight_error");
      assert.equal(result.budgetRefused, false);
      assert.equal(calls, 1, "observing a refusal adds no paid retry");
      for (const literal of ['"retry_after_ms":1500', '"remaining_requests":0', '"remaining_tokens":42', `"request_id":"${requestId}"`]) {
        assert.ok(result.stderr.includes(literal), result.stderr);
        if (!model.startsWith("claude-"))
          assert.ok(allowance.includes(literal.replaceAll('"', '\\"')), "existing settlement reason retains the same evidence");
      }
      const [reservation] = Object.values(JSON.parse(allowance).reservations) as Array<{ reservedUsd: number; settledUsd: number | null }>;
      assert.ok(reservation);
      if (model.startsWith("claude-")) {
        assert.equal(reservation.settledUsd, null, "Foundry Messages retains its conservative unsettled reservation");
        assert.equal(result.budgetSettledUsd, reservation.reservedUsd);
      } else assert.notEqual(reservation.settledUsd, null, "the existing Chat/Responses settlement path still runs");
      for (const hidden of [secret, "private response body", "private prompt", "authorization", "api-key", "set-cookie"])
        assert.equal(result.stderr.includes(hidden), false);
    });
  }
});

test("cash HTTP diagnostics preserve zero and fall back to valid seconds without inventing unreadable values", async t => {
  const { result } = await refusal(t, new Response("untrusted error body", { status: 503, headers: {
    "retry-after-ms": "not-a-number", "retry-after": "0", "x-ratelimit-remaining-requests": "-1",
    "x-ratelimit-remaining-tokens": "9007199254740992", "x-request-id": requestId,
  } }));
  assert.match(result.stderr, /HTTP 503/);
  assert.ok(result.stderr.includes('"retry_after_ms":0'));
  assert.ok(result.stderr.includes(`"request_id":"${requestId}"`));
  assert.equal(result.stderr.includes("remaining_"), false);
  assert.equal(result.stderr.includes("not-a-number"), false);
});

test("cash HTTP diagnostics omit arbitrary header text and never read the failure body", async t => {
  for (const value of ["1.5", "NaN", "Infinity", "9e3", "-5", "9007199254740992", secret]) {
    const response = new Response(secret, { status: 429, headers: {
      "retry-after-ms": value, "retry-after": value,
      "x-ratelimit-remaining-requests": value, "x-ratelimit-remaining-tokens": value,
      "apim-request-id": value, "x-request-id": value, "x-private-header": secret,
    } });
    Object.defineProperty(response, "json", { value: () => { throw Error("must not consume an error body"); } });
    const { result } = await refusal(t, response);
    assert.equal(result.stderr, "openweight request failed with HTTP 429");
  }
});

test("cash HTTP diagnostics retain the original status when the response headers are unreadable", async t => {
  const response = new Response(secret, { status: 429 });
  Object.defineProperty(response, "headers", { get() { throw Error(secret); } });
  const { result } = await refusal(t, response);
  assert.match(result.stderr, /HTTP 429/);
  assert.ok(result.stderr.includes('"diagnostics":"unreadable"'));
  assert.equal(result.stderr.includes(secret), false);
});

test("cash HTTP observation leaves missing deployments and conservative settlements distinct", async t => {
  for (const model of ["gpt-6-luna", "gpt-6.1-sol", "claude-haiku-5-5"]) {
    const { result, calls } = await refusal(t, new Response(secret, { status: 404, headers: { "retry-after-ms": "1500" } }), model);
    assert.equal(result.openWeightDeploymentAbsent, model);
    assert.equal(result.budgetSettledUsd, 0);
    assert.equal(calls, 1);
    assert.equal(result.stderr.includes("retry_after"), false);
  }
});

test("cash HTTP diagnostics do not replace successful replies with response headers", async t => {
  const { result, calls } = await refusal(t, new Response(JSON.stringify({ id: "fixture-success", model: "gpt-6-luna",
    usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ message: { content: "accepted fixture" }, finish_reason: "stop" }],
  }), { status: 200, headers: { "retry-after-ms": "123", "apim-request-id": requestId } }));
  assert.equal(result.isError, false);
  assert.equal(result.text, "accepted fixture");
  assert.equal(result.stderr, "");
  assert.equal(calls, 1);
});

const cashModels = ["gpt-6-luna", "gpt-6.1-sol", "claude-haiku-5-5"];
function cashReply(model: string, tool = false): Response {
  const usage = { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
  if (model.startsWith("claude-")) return Response.json({ id: "foundry-turn", model, usage,
    stop_reason: tool ? "tool_use" : "end_turn", content: tool
      ? [{ type: "tool_use", id: "once", name: "read_file", input: { path: "fixture.txt" } }]
      : [{ type: "text", text: "qualified" }] });
  if (model === "gpt-6.1-sol") return Response.json({ id: "response-turn", model, status: "completed", usage,
    output: tool ? [{ type: "reasoning", encrypted_content: "kept" },
      { type: "function_call", call_id: "once", name: "read_file", arguments: '{"path":"fixture.txt"}' }]
      : [{ type: "message", content: [{ type: "output_text", text: "qualified" }] }] });
  return Response.json({ id: "chat-turn", model, usage: { prompt_tokens: 10, completion_tokens: 2 },
    choices: [{ finish_reason: tool ? "tool_calls" : "stop", message: tool ? { content: null,
      tool_calls: [{ id: "once", function: { name: "read_file", arguments: '{"path":"fixture.txt"}' } }] } : { content: "qualified" } }] });
}
function cashFixture(t: TestContext) {
  const { dir } = ownedFixtureDir(t, "cash429");
  writeFileSync(join(dir, "fixture.txt"), "unique fixture data");
  const config = { root: dir, dailyCapUsd: 25, workerProviders: { enabled: ["cash"], cashEndpoint: "https://foundry.example.test/" } } as Config;
  const args = { cwd: dir, workerHome: dir, prompt: "bounded fixture", tools: ["Read"], maxTurns: 4,
    env: { RMD_OPENWEIGHT_API_KEY: secret, RMD_FOUNDRY_CLAUDE_API_KEY: secret,
      RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" } };
  const reservations = () => Object.values(JSON.parse(readFileSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8")).reservations) as Array<{
    reservedUsd: number; settledUsd: number | null; settledReason?: string;
  }>;
  return { dir, config, args, reservations };
}

test("cash positive429 continues each real protocol with identical payload and fresh charged reservations", async t => {
  for (const model of cashModels) await t.test(model, async child => {
    const f = cashFixture(child), bodies: string[] = [], activity: string[] = [];
    let captured: ReturnType<typeof f.reservations> = [];
    const result = await spawnOpenWeightWorker({ ...f.args, streamObserver: event => activity.push(event.kind),
      fetchImpl: async (_url, init) => {
        bodies.push(String(init?.body));
        if (bodies.length === 1) return cashReply(model, true);
        if (bodies.length === 2) return new Response("private error", { status: 429, headers: { "retry-after-ms": "5" } });
        captured = f.reservations();
        return cashReply(model);
      } }, f.config, { model, effort: "low" });
    assert.equal(result.isError, false, result.stderr);
    assert.equal(result.text, "qualified");
    assert.equal(bodies.length, 3);
    assert.equal(bodies[1], bodies[2], "no replayed tool or changed Responses state on429");
    assert.ok(bodies[1]!.includes("unique fixture data"), "actual Read tool completed once before retry");
    assert.equal(f.reservations().length, 3, "every POST has its own reservation identity");
    assert.equal(captured.length, 3, "third reservation commits before transport");
    const failed = f.reservations()[1]!;
    const failedBytes = Buffer.byteLength(bodies[1]!, "utf8");
    if (model.startsWith("claude-")) assert.equal(failed.settledUsd, null);
    else assert.equal(failed.settledUsd, model === "gpt-6.1-sol"
      ? openWeightReservationUsd(model, failedBytes) : openWeightUsageUsd(model, failedBytes, 0));
    const allRows = f.reservations();
    assert.equal(result.budgetReservedUsd, allRows.reduce((sum, row) => sum + row.reservedUsd, 0));
    assert.equal(result.budgetSettledUsd, allRows.reduce((sum, row) => sum + (row.settledUsd ?? row.reservedUsd), 0),
      "prior success, failed429 and final success are each accounted exactly once");
    assert.ok(activity.length >= 2, "real successful response activity remains observable");
    assert.equal(result.numTurns, 3);
  });
});

test("cash429 cannot exceed existing turns or infer a cooldown from missing invalid zero or over-window headers", async t => {
  for (const model of cashModels) await t.test(model, async child => {
    for (const headers of ([{}, { "retry-after-ms": "0" }, { "retry-after-ms": "-1" },
      { "retry-after-ms": "9999999999999999" }, { "retry-after-ms": "bad", "retry-after": "1" }, { "retry-after-ms": "1000" }] as Array<Record<string, string>>)) {
      const f = cashFixture(child); let calls = 0;
      // A frozen clock keeps the 100 ms window from being consumed by reservation I/O on a loaded
      // runner (which timed out before the POST: calls 0). Every header here is over-window against it.
      const result = await spawnOpenWeightWorker({ ...f.args, requestTimeoutMs: 100, clock: fixedClock(Date.now()),
        fetchImpl: async () => { calls++; return new Response(null, { status: 429, headers }); } }, f.config, { model, effort: "low" });
      assert.equal(calls, 1); assert.equal(result.isError, true);
    }
    const f = cashFixture(child); let calls = 0;
    const result = await spawnOpenWeightWorker({ ...f.args, maxTurns: 2,
      fetchImpl: async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after-ms": "2" } }); } }, f.config, { model, effort: "low" });
    assert.equal(calls, 2); assert.equal(f.reservations().length, 2); assert.equal(result.isError, true);
  });
});

test("cash caller abort cancels native429 wait and response body without a later paid POST", async t => {
  for (const model of cashModels) for (const phase of ["wait", "body", "fetch"]) await t.test(`${model} ${phase}`, async child => {
    const f = cashFixture(child), controller = new AbortController(); let calls = 0;
    const timer = setTimeout(() => controller.abort(Error("fixture cancellation")), 30);
    try {
      const result = await spawnOpenWeightWorker({ ...f.args, signal: controller.signal,
        fetchImpl: async () => {
          calls++;
          if (phase === "fetch") return new Promise<Response>(() => {});
          if (phase === "wait") return new Response(null, { status: 429, headers: { "retry-after-ms": "200" } });
          const response = cashReply(model);
          Object.defineProperty(response, "json", { value: () => new Promise(() => {}) });
          return response;
        } }, f.config, { model, effort: "low" });
      assert.equal(result.isError, true); assert.equal(calls, 1);
      await new Promise(resolve => setTimeout(resolve, 230));
      assert.equal(calls, 1, "cancelled native timer cannot wake up to spend");
      assert.equal(f.reservations().length, 1);
    } finally { clearTimeout(timer); }
  });
});

test("cash native request deadline includes body consumption and a shared429 cooldown window", async t => {
  for (const model of cashModels) await t.test(model, async child => {
    const f = cashFixture(child); let calls = 0, elapsed = 0;
    const clock = clockFromMillisFn(() => elapsed);
    // The clock crosses the request deadline while consuming the body; healthy reservation I/O is not its subject.
    const result = await spawnOpenWeightWorker({ ...f.args, clock, requestTimeoutMs: 1000,
      fetchImpl: async () => { calls++; const response = cashReply(model);
        Object.defineProperty(response, "json", { value: async () => { elapsed = 1000; return cashReply(model).json(); } }); return response; } }, f.config, { model, effort: "low" });
    assert.equal(result.isError, true); assert.match(result.stderr, /timed out|timeout/i); assert.equal(calls, 1);
    const g = cashFixture(child); calls = 0; elapsed = 0;
    // Both retries share one clock window. Resetting it on retry admits a third POST and fails the original assertion.
    const second = await spawnOpenWeightWorker({ ...g.args, clock, requestTimeoutMs: 1000,
      fetchImpl: async () => { calls++; elapsed = calls === 1 ? 600 : 980;
        return new Response(null, { status: 429, headers: { "retry-after-ms": "35" } }); } }, g.config, { model, effort: "low" });
    assert.equal(second.isError, true); assert.equal(calls, 2, "second delay cannot restart the original request deadline");
  });
});

test("cash worker default watchdog and caller abort stop real adapter wait and body reads", async t => {
  for (const authority of ["watchdog", "caller"]) for (const phase of ["wait", "body"]) await t.test(`${authority} ${phase}`, async child => {
    const f = cashFixture(child), controller = new AbortController(); let calls = 0;
    const settingsFile = join(REPO_ROOT, "settings", "worker.json");
    const timer = authority === "caller" ? setTimeout(() => controller.abort(Error("caller ended")), 30) : undefined;
    try {
      await assert.rejects(spawnWorker({ cwd: f.dir, settingsFile, permissionMode: "bypassPermissions", prompt: "bounded worker",
        model: "sonnet", effort: "low", maxTurns: 4, mountProvider: "cash", cashSqueezed: true,
        config: f.config, ...(authority === "watchdog" ? { clockBound: { boundMs: 25, pollMs: 5 } } : { signal: controller.signal }),
        providerRouting: { spawnOpenWeight: (args, config, selection) => spawnOpenWeightWorker({ ...args, env: f.args.env,
          fetchImpl: async () => {
            calls++;
            if (phase === "wait") return new Response(null, { status: 429, headers: { "retry-after-ms": "200" } });
            const response = cashReply(selection.model);
            Object.defineProperty(response, "json", { value: () => new Promise(() => {}) }); return response;
          } }, config, selection) },
      }), authority === "watchdog" ? WorkerAbandonedError : /caller ended/);
      await new Promise(resolve => setTimeout(resolve, 230));
      assert.equal(calls, 1);
    } finally { clearTimeout(timer); }
  });
});

test("cash429 revalidates revoked grants and fresh allowance without consuming or refunding prior authority", async t => {
  for (const model of cashModels) for (const refusal of ["grant", "allowance"]) await t.test(`${model} ${refusal}`, async child => {
    const f = cashFixture(child), store = new InMemoryCapabilityGrantStore();
    const grant = createCapabilityGrant({ targetIdentity: "fixture:cash", operations: ["review.read"], audience: "provider:cash",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), useLimit: 1,
      approval: { approvedBy: "operator:fixture", approvedAt: new Date(Date.now() - 1000).toISOString() }, revocationLink: "https://fixture.invalid/revoke" });
    store.issue(grant); let calls = 0;
    const request = { grantId: grant.id, operation: "review.read", target: grant.targetIdentity, audience: grant.audience, nonce: "fixture-once" };
    const result = await spawnOpenWeightWorker({ ...f.args, capabilityGrant: { store, request }, fetchImpl: async () => {
      calls++;
      if (refusal === "grant") store.revoke(grant.id);
      else f.config.dailyCapUsd = Number.MIN_VALUE;
      return new Response(null, { status: 429, headers: { "retry-after-ms": "5" } });
    } }, f.config, { model, effort: "low" });
    assert.equal(result.isError, true); assert.equal(calls, 1);
    assert.equal(store.useCount(grant.id), 0, "verification never manufactures another grant use");
    assert.equal(store.hasSeenNonce(grant.id, request.nonce), false);
    assert.equal(f.reservations().length, 1);
    const [charged] = f.reservations();
    if (model.startsWith("claude-")) assert.equal(charged!.settledUsd, null);
    else assert.ok(charged!.settledUsd! > 0);
    if (refusal === "grant") assert.match(result.stderr, /revoked/);
    else assert.equal(result.budgetRefused, true);
  });
});

test("cash429 eligibility leaves auth unknown errors and404 on their existing single-attempt paths", async t => {
  for (const model of cashModels) for (const status of [401, 403, 404, 500, 503]) await t.test(`${model} ${status}`, async child => {
    const f = cashFixture(child); let calls = 0;
    const result = await spawnOpenWeightWorker({ ...f.args, fetchImpl: async () => { calls++;
      return new Response(null, { status, headers: { "retry-after-ms": "2" } }); } }, f.config, { model, effort: "low" });
    assert.equal(result.isError, true); assert.equal(calls, 1);
    assert.equal(result.openWeightDeploymentAbsent, status === 404 ? model : undefined);
  });
});

test("cash abort removes listeners even when a provider body ignores cancellation forever", async t => {
  const f = cashFixture(t), caller = new AbortController(); let adds = 0; const pendingListeners = new Set<unknown>();
  const resultPromise = spawnOpenWeightWorker({ ...f.args, signal: caller.signal, fetchImpl: async (_url, init) => {
    const signal = init!.signal!;
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...params: Parameters<typeof signal.addEventListener>) => { adds++; pendingListeners.add(params[1]); add(...params); };
    signal.removeEventListener = (...params: Parameters<typeof signal.removeEventListener>) => { pendingListeners.delete(params[1]); remove(...params); };
    const response = cashReply("gpt-6-luna");
    Object.defineProperty(response, "json", { value: () => { setTimeout(() => caller.abort(), 5); return new Promise(() => {}); } });
    return response;
  } }, f.config, { model: "gpt-6-luna", effort: "low" });
  const result = await resultPromise;
  assert.equal(result.isError, true);
  assert.ok(adds > 0); assert.equal(pendingListeners.size, 0, "pending ignored-signal body must not retain its abort listener");
});

test("cash synchronous reservation crossing request deadline stays charged and never reaches transport", async t => {
  for (const model of cashModels) await t.test(model, async child => {
    const f = cashFixture(child); let now = 0, calls = 0;
    const result = await spawnOpenWeightWorker({ ...f.args, requestTimeoutMs: 50,
      clock: { now: () => now, iso: () => { now = 51; return new Date().toISOString(); } },
      fetchImpl: async () => { calls++; return cashReply(model); },
    }, f.config, { model, effort: "low" });
    assert.equal(result.isError, true); assert.equal(calls, 0);
    assert.match(result.stderr, /timed out|timeout/i);
    assert.equal(f.reservations().length, 1, "committed reservation is never silently refunded");
    const [row] = f.reservations();
    if (model.startsWith("claude-")) assert.equal(row!.settledUsd, null);
    else assert.ok(row!.settledUsd! > 0);
  });
});

test("cash default native fetch and timer qualify local TLS429 continuation and body deadline", async t => {
  const f = cashFixture(t), key = join(f.dir, "key.pem"), cert = join(f.dir, "cert.pem"), conf = join(f.dir, "tls.cnf");
  writeFileSync(conf, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-config", conf, "-days", "1"], { stdio: "ignore" });
  let calls = 0, mode: "retry" | "body" = "retry";
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    req.resume(); calls++;
    if (mode === "body") { res.writeHead(200, { "content-type": "application/json" }); res.write('{"unfinished":'); return; }
    if (calls === 1) { res.writeHead(429, { "retry-after-ms": "5" }); res.end(); }
    else { res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "native", model: "gpt-6-luna", usage: { prompt_tokens: 10, completion_tokens: 2 },
        choices: [{ message: { content: "native-qualified" }, finish_reason: "stop" }] })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const sockets = new Set<Socket>();
  const bodyGates: { receivedAt: number; releasedAt?: number }[] = [];
  // Hold the first TLS bytes BEFORE handshake; pausing secureConnection is too late.
  const proxy = createTcpServer(client => {
    const upstream = connect(address.port, "127.0.0.1");
    sockets.add(client); sockets.add(upstream);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    upstream.pipe(client);
    let release: ReturnType<typeof setTimeout> | undefined;
    client.once("close", () => {
      clearTimeout(release); upstream.destroy(); sockets.delete(client);
    });
    upstream.once("close", () => { client.destroy(); sockets.delete(upstream); });
    if (mode !== "body") { client.pipe(upstream); return; }
    client.once("data", firstTlsBytes => {
      client.pause();
      const gate = { receivedAt: performance.now() } as { receivedAt: number; releasedAt?: number };
      bodyGates.push(gate);
      release = setTimeout(() => {
        if (client.destroyed || upstream.destroyed) return;
        gate.releasedAt = performance.now();
        upstream.write(firstTlsBytes);
        client.pipe(upstream);
      }, 80);
    });
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress !== "string");
  const source = pathToFileURL(join(REPO_ROOT, "src", "lib", "worker-provider.ts")).href;
  const script = `const {spawnOpenWeightWorker}=await import(${JSON.stringify(source)});
    const result=await spawnOpenWeightWorker({cwd:process.argv[1],workerHome:process.argv[1],prompt:'native fixture',tools:[],maxTurns:2,
      requestTimeoutMs:Number(process.argv[3]),env:{RMD_OPENWEIGHT_API_KEY:'local-fixture'}},
      {root:process.argv[1],dailyCapUsd:25,workerProviders:{cashEndpoint:process.argv[2]}},{model:'gpt-6-luna',effort:'low'});
    console.log(JSON.stringify({isError:result.isError,text:result.text,stderr:result.stderr}));`;
  try {
    const invoke = async (timeout: number) => {
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script,
        f.dir, `https://127.0.0.1:${proxyAddress.port}/`, String(timeout)], {
        cwd: REPO_ROOT,
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 15_000,
      });
      return JSON.parse(stdout.trim().split("\n").at(-1)!);
    };
    const success = await invoke(1000);
    assert.equal(success.isError, false, success.stderr); assert.equal(success.text, "native-qualified"); assert.equal(calls, 2);
    mode = "body";
    const refused = await invoke(1000);
    assert.equal(refused.isError, true); assert.match(refused.stderr, /timed out|timeout/i);
    t.diagnostic(JSON.stringify({ nativeRequestCount: calls, tlsSetupHeldMs: bodyGates.map(gate => gate.releasedAt === undefined ? null : gate.releasedAt - gate.receivedAt) }));
    assert.equal(calls, 3, "stalled native response body produces no extra POST");
    assert.ok(bodyGates.some(gate => gate.releasedAt !== undefined && gate.releasedAt - gate.receivedAt > 40),
      "healthy verified TLS setup exceeds the old40ms window before the stalled response body");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("cash worker passes caller cancellation into the actual adapter before the next paid attempt", async t => {
  const f = cashFixture(t), controller = new AbortController(); let calls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(spawnWorker({ cwd: f.dir, permissionMode: "bypassPermissions",
      settingsFile: join(REPO_ROOT, "settings", "worker.json"),
      prompt: "round fixture", model: "sonnet", effort: "low", maxTurns: 4, mountProvider: "cash", cashSqueezed: true,
      config: f.config, signal: controller.signal,
      providerRouting: { spawnOpenWeight: (args, config, selection) => spawnOpenWeightWorker({ ...args, env: f.args.env,
        clock: fixedClock(0), requestTimeoutMs: 1000, fetchImpl: async () => { calls++;
          // Observe the first POST before cancelling its actual retry wait; outer setup cannot consume the fixture's timer.
          if (calls === 1) timer = setTimeout(() => controller.abort(Error("round cancelled")), 25);
          return new Response(null, { status: 429, headers: { "retry-after-ms": "90" } }); } }, config, selection) },
    }), /round cancelled/);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(calls, 1, "outer cancellation reaches provider wait before any new POST");
  } finally { clearTimeout(timer); }
});

test("cash error body cancellation failure retains the original refusal and only safe diagnostics", async t => {
  const response = new Response("private failure body", { status: 429 });
  Object.defineProperty(response.body!, "cancel", { value: () => Promise.reject(Error(secret)) });
  const original = console.error, diagnostics: string[] = [];
  console.error = (...args: unknown[]) => { diagnostics.push(args.map(String).join(" ")); };
  try {
    const { result } = await refusal(t, response);
    assert.equal(result.isError, true); assert.equal(result.stderr, "openweight request failed with HTTP 429");
    assert.ok(diagnostics.includes('{"event":"cash.error_body_cancel_failed","status":429}'));
    assert.equal(diagnostics.join(" ").includes(secret), false);
  } finally { console.error = original; }
});
