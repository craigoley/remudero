import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { registerHooks } from "node:module";
import type { CanaryRequest } from "#src/lib/model-canary-runner.js";
import type { NativeCanarySessionPorts } from "#src/lib/model-canary-native-session.js";

async function fixture(t: TestContext, authority: NativeCanarySessionPorts["authority"] = async () => ({
  loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "fixture" })) {
  let optionalImports = 0, authorityCalls = 0, queryCalls = 0;
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === "@anthropic-ai/claude-agent-sdk" || specifier === "zod" || specifier === "./model-canary-native-tools.js") {
      optionalImports++; throw new Error("synthetic optional import refusal");
    }
    return nextResolve(specifier, context);
  } });
  t.after(() => hooks.deregister());
  // An eager import fails inside this real test even when the SDK is installed.
  const { nativeCanarySession } = await import("#src/lib/model-canary-native-session.js");
  const ports: NativeCanarySessionPorts = { authority: async (...args) => { authorityCalls++; return authority(...args); },
    query: () => { queryCalls++; throw new Error("must-not-query"); }, monotonicMs: () => 0 };
  const config = { cwd: process.cwd(), executable: process.execPath, env: {}, maxUserTurns: 8 as const };
  const request = (): CanaryRequest => ({ pin: { model: "synthetic", route: "private-subscription", effort: "medium",
    suiteHash: "a".repeat(64), billing: "subscription" }, prompt: "synthetic", history: [],
    maxOutputBytes: 1024, signal: new AbortController().signal });
  return { session: () => nativeCanarySession(config, ports), nativeCanarySession, config, ports, request,
    counts: () => ({ optionalImports, authorityCalls, queryCalls }) };
}

test("native cold refused and sealed turns allocate no SDK or tool server", async t => {
  const f = await fixture(t), sealed = f.session(); sealed.seal();
  assert.equal((await sealed.turn(f.request(), () => {})).state, "unavailable");
  const abort = new AbortController(); abort.abort();
  assert.equal((await f.session().turn({ ...f.request(), signal: abort.signal }, () => {})).state, "unavailable");
  const cash = f.nativeCanarySession({ ...f.config, env: { ANTHROPIC_API_KEY: "synthetic-only" } }, f.ports);
  assert.equal((await cash.turn(f.request(), () => {})).reason, "native-subscription-env-unproven");
  assert.deepEqual(f.counts(), { optionalImports: 0, authorityCalls: 0, queryCalls: 0 });
});

test("native pure tool validation refuses missing capabilities before authority and SDK loading", async t => {
  const f = await fixture(t);
  for (const policy of ["inventory", "retry", "approval", "invalid"])
    assert.equal((await f.session().turn({ ...f.request(), toolPolicy: policy as CanaryRequest["toolPolicy"] }, () => {})).reason,
      "native-tool-contract-unavailable");
  assert.deepEqual(f.counts(), { optionalImports: 0, authorityCalls: 0, queryCalls: 0 });
});

test("native rejected authority leaves SDK unloaded and preserves the original unavailable phase", async t => {
  const f = await fixture(t, async () => { throw new RangeError("private probe detail"); });
  const result = await f.session().turn(f.request(), () => {});
  assert.equal(result.reason, "native-authority-unavailable"); assert.equal(result.errorType, "RangeError");
  assert.ok(!JSON.stringify(result).includes("private probe detail"));
  assert.deepEqual(f.counts(), { optionalImports: 0, authorityCalls: 1, queryCalls: 0 });
});

test("native cancellation during authority loads no deferred SDK resources", async t => {
  const abort = new AbortController();
  const f = await fixture(t, async () => { abort.abort(); return {
    loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "fixture" }; });
  const result = await f.session().turn({ ...f.request(), signal: abort.signal }, () => {});
  assert.equal(result.reason, "native-aborted"); assert.equal(result.promptSent, false);
  assert.deepEqual(f.counts(), { optionalImports: 0, authorityCalls: 1, queryCalls: 0 });
});

test("native deferred tool import failures remain unavailable and seal the owned session", async t => {
  const f = await fixture(t), session = f.session();
  const result = await session.turn(f.request(), () => {});
  assert.equal(result.state, "unavailable"); assert.equal(result.reason, "native-tool-contract-unavailable");
  assert.equal(result.promptSent, false); assert.equal(f.counts().authorityCalls, 1);
  assert.ok(f.counts().optionalImports > 0); assert.equal(f.counts().queryCalls, 0);
  assert.equal((await session.turn(f.request(), () => {})).reason, "native-session-unavailable");
  assert.equal(f.counts().authorityCalls, 1);
});
