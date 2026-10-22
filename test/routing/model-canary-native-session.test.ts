import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { nativeCanarySession } from "#src/lib/model-canary-native-session.js";
import { nativeCanaryAdapter } from "#src/lib/model-canary-native-adapter.js";
import { executeCanary } from "#src/lib/model-canary-runner.js";
import type { CanaryRequest } from "#src/lib/model-canary-runner.js";
import { canaryTools, commonCanarySuite, type CanaryToolEvent } from "#src/lib/model-canary-suite.js";

/** Only newline-complete rows prove a child event; active writers may have an unfinished tail. */
function protocolRows(text: string, active = false) {
  if (text === "") return [];
  if (!text.endsWith("\n") && !active) throw new SyntaxError("fixture-terminal-record-truncated");
  const end = text.lastIndexOf("\n");
  if (end < 0) return [];
  return text.slice(0, end).split("\n").map(line => JSON.parse(line));
}

test("SDK fixture active log reads wait for complete records without inventing spawn evidence", () => {
  assert.deepEqual(protocolRows("", true), []);
  assert.deepEqual(protocolRows('{"phase":"spawn"', true), []);
  const completed = '{"phase":"version"}\n';
  assert.deepEqual(protocolRows(completed + '{"phase":"spawn"', true), [{ phase: "version" }]);
  assert.deepEqual(protocolRows(completed + '{"phase":"spawn","pid":123}\n', true), [{ phase: "version" }, { phase: "spawn", pid: 123 }]);
});

test("SDK fixture terminal tails and malformed complete records remain failures", () => {
  assert.throws(() => protocolRows('{"phase":"spawn"'), /terminal-record-truncated/);
  assert.throws(() => protocolRows('{"phase":"version"}\npartial'), /terminal-record-truncated/);
  for (const active of [false, true]) assert.throws(() => protocolRows('broken-json\n', active), SyntaxError);
});

function fixture(t: TestContext, mode = "good", maxUserTurns: 8 | 25 | 50 = 8) {
  const cwd = mkdtempSync(join(tmpdir(), "rmd-native-session-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const executable = join(cwd, "native.mjs"), log = join(cwd, "protocol.ndjson");
  writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL("test/fixtures/canary-native-cli.mjs", __workspaceRootUrl), "utf8"));
  chmodSync(executable, 0o700);
  const env: NodeJS.ProcessEnv = { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, "private-config"),
    PATH: dirname(process.execPath) + ":" + process.env.PATH,
    RMD_CANARY_RESOURCE_CONTRACTS: new URL("test/fixtures/canary-native-resource-contracts.json", __workspaceRootUrl).pathname,
    RMD_CANARY_FIXTURE_MODE: mode, RMD_CANARY_FIXTURE_LOG: log, RMD_CANARY_FIXTURE_STATE: join(cwd, "session.json") };
  for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_SESSION_ACCESS_TOKEN$|CLAUDE_CODE_EXTRA_BODY$|NODE_V8_COVERAGE$)/.test(name)) env[name] = undefined;
  const config = { cwd, executable, env, maxUserTurns };
  const rows = (active = false) => { try { return protocolRows(readFileSync(log, "utf8"), active); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } };
  return { config, rows, session: nativeCanarySession(config) };
}
const request = (over: Partial<CanaryRequest> = {}): CanaryRequest => ({ prompt: "synthetic user turn", history: [],
  pin: { model: "synthetic-model", route: "fixture-subscription", effort: "medium", billing: "subscription", suiteHash: "fixture" },
  signal: AbortSignal.timeout(5000), maxOutputBytes: 4096, ...over });

test("the real SDK child receives no prompt until same-process subscription authority is proven", async t => {
  const f = fixture(t), events: SDKMessage[] = [];
  const result = await f.session.turn(request(), message => events.push(message));
  assert.equal(result.state, "complete", JSON.stringify(result)); assert.equal(result.text, "native-turn-1"); assert.equal(result.promptSent, true);
  assert.equal(result.adapterQualified, false); assert.ok(events.some(m => m.type === "stream_event"));
  const rows = f.rows(); assert.deepEqual(rows.slice(0, 4).map(r => r.phase), ["version", "auth", "spawn", "control"]);
  assert.equal(rows[4].phase, "prompt"); assert.ok(rows.every(r => r.node === undefined || r.node === process.version), JSON.stringify(rows));
  const spawn = rows.find(r => r.phase === "spawn");
  assert.equal(spawn.tools, ""); assert.equal(spawn.sources, "--setting-sources="); assert.equal(spawn.strict, true);
  assert.equal(spawn.permissionMode, "dontAsk"); assert.equal(spawn.partial, true);
  assert.equal(JSON.stringify(result).includes("PRIVATE-DO-NOT-RETAIN"), false);
  assert.equal(JSON.stringify(result).includes("999999"), false, "cumulative usage is not copied into a new turn");
});

test("native account API, provider, unknown and changed subscription evidence refuse before any user prompt", async t => {
  for (const mode of ["account-api", "account-unknown", "foundry", "subscription-drift"]) {
    const f = fixture(t, mode); const result = await f.session.turn(request(), () => {});
    assert.equal(result.state, "unavailable", mode); assert.equal(result.reason, "native-effective-subscription-unproven");
    assert.equal(result.promptSent, false); assert.equal(f.rows().filter(r => r.phase === "prompt").length, 0);
    assert.equal((await f.session.turn(request(), () => {})).reason, "native-session-unavailable");
  }
});

test("actual native auth/version failures preserve their phase and never start SDK inference", async t => {
  for (const mode of ["wrong-version", "auth-error", "auth-json", "logged-out", "api-auth"]) {
    const f = fixture(t, mode), result = await f.session.turn(request(), () => {});
    assert.equal(result.state, "unavailable", mode); assert.equal(result.promptSent, false);
    assert.equal(f.rows().some(r => r.phase === "spawn"), false);
    if (mode === "auth-json") assert.equal(result.errorType, "SyntaxError");
    if (mode === "wrong-version" || mode === "auth-error") assert.equal(result.reason, "native-authority-unavailable");
  }
});

test("the native session resumes only its owned real transcript and refuses invented assistant replay", async t => {
  const f = fixture(t), first = request({ prompt: "first", conversation: [{ role: "system", content: "private instruction" }, { role: "user", content: "first" }] });
  const one = await f.session.turn(first, () => {}); assert.equal(one.state, "complete");
  const forged = [...first.conversation!, { role: "assistant" as const, content: "fabricated" }, { role: "user" as const, content: "second" }];
  assert.equal((await f.session.turn(request({ prompt: "second", conversation: forged }), () => {})).reason, "native-session-contract-mismatch");
  assert.equal(f.rows().filter(r => r.phase === "prompt").length, 1);
  const conversation = [...first.conversation!, { role: "assistant" as const, content: one.text }, { role: "user" as const, content: "second" }];
  const two = await f.session.turn(request({ prompt: "second", conversation }), () => {});
  assert.equal(two.state, "complete"); assert.equal(two.text, "native-turn-2"); assert.equal(two.sessionId, one.sessionId);
  const prompts = f.rows().filter(r => r.phase === "prompt"); assert.equal(prompts[1].priorTurns, 1);
  assert.equal(prompts[1].resumed, one.sessionId); assert.equal(prompts[1].content, "second");
  assert.equal(f.rows().filter(r => r.phase === "control")[1].systemPrompt[0], "private instruction");
});

test("real SDK protocol cuts, foreign scope, permission failures and output bounds are unavailable", async t => {
  for (const mode of ["missing-result", "foreign-session", "init-api", "permission", "result-error", "oversize"]) {
    const f = fixture(t, mode), result = await f.session.turn(request({ maxOutputBytes: mode === "oversize" ? 64 : 4096 }), () => {});
    assert.equal(result.state, "unavailable", mode); assert.equal(result.adapterQualified, false);
    assert.equal((await f.session.turn(request(), () => {})).reason, "native-session-unavailable");
  }
});

test("aborting real SDK initialization or streaming closes the owned child and seals its session", async t => {
  for (const mode of ["hang-init", "hang-stream"]) {
    const f = fixture(t, mode), abort = new AbortController();
    const running = f.session.turn(request({ signal: abort.signal }), () => {});
    for (let i = 0; i < 200 && !f.rows(true).some(r => r.phase === "spawn"); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const spawned = f.rows(true).find(r => r.phase === "spawn"); assert.ok(spawned && Number.isSafeInteger(spawned.pid));
    abort.abort();
    const result = await running; assert.equal(result.state, "unavailable"); assert.equal(result.reason, "native-aborted");
    let alive = true;
    for (let i = 0; i < 100; i++) {
      try { process.kill(spawned.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { alive = false; break; } throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(alive, false, "the positively observed owned protocol child must actually exit");
    assert.equal((await f.session.turn(request(), () => {})).reason, "native-session-unavailable");
  }
});

test("a simultaneous turn, a cash environment and a changed pin cannot steal native session ownership", async t => {
  const f = fixture(t, "hang-init"), abort = new AbortController();
  const running = f.session.turn(request({ signal: abort.signal }), () => {});
  assert.equal((await f.session.turn(request(), () => {})).reason, "native-session-busy");
  abort.abort(); await running;
  const cash = fixture(t); cash.config.env.ANTHROPIC_API_KEY = "synthetic-never-send";
  const blocked = nativeCanarySession(cash.config); assert.equal((await blocked.turn(request(), () => {})).reason, "native-subscription-env-unproven");
  assert.equal(cash.rows().length, 0);
  const clean = fixture(t); const one = await clean.session.turn(request(), () => {}); assert.equal(one.state, "complete");
  const changed = request(); changed.pin.model = "other-model";
  assert.equal((await clean.session.turn(changed, () => {})).reason, "native-session-contract-mismatch");
});

test("capture and SDK cleanup failures remain explicit unavailable results", async t => {
  const f = fixture(t); const captured = await f.session.turn(request(), () => { throw new TypeError("private capture failure"); });
  assert.equal(captured.reason, "native-capture-unavailable"); assert.equal(captured.errorType, "TypeError");
  const cleanup = fixture(t);
  const session = nativeCanarySession(cleanup.config, { authority: async () => ({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }),
    query: input => { const actual = query(input); return new Proxy(actual, { get(target, key) {
      if (key === "close") return () => { target.close(); throw "synthetic close failure"; };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } }); }, monotonicMs: () => performance.now() });
  const result = await session.turn(request(), () => {}); assert.equal(result.reason, "native-cleanup-unavailable");
  assert.equal(result.cleanupFailure, "non-error"); assert.equal(result.state, "unavailable");
});

test("an abort after actual SDK account initialization stays cancellation and never releases a user prompt", async t => {
  const f = fixture(t), abort = new AbortController();
  const session = nativeCanarySession(f.config, {
    authority: async () => ({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }),
    query: input => {
      const actual = query(input);
      return new Proxy(actual, { get(target, key) {
        if (key === "accountInfo") return async () => { const account = await target.accountInfo(); abort.abort(); return account; };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
    }, monotonicMs: () => performance.now(),
  });
  const result = await session.turn(request({ signal: abort.signal }), () => {});
  assert.equal(result.state, "unavailable"); assert.equal(result.reason, "native-aborted");
  assert.equal(result.promptSent, false); assert.equal(f.rows().filter(r => r.phase === "prompt").length, 0);
  assert.equal((await session.turn(request(), () => {})).reason, "native-session-unavailable");
});

test("invalid native tool authority and non-Error probe failures seal ownership with distinct unavailable evidence", async t => {
  const f = fixture(t);
  const bad = request({ toolPolicy: "inventory" });
  const result = await f.session.turn(bad, () => {});
  assert.equal(result.reason, "native-tool-contract-unavailable"); assert.equal(f.rows().length, 0);
  assert.equal((await f.session.turn(request(), () => {})).reason, "native-session-unavailable");
  const probe = fixture(t);
  const session = nativeCanarySession(probe.config, { authority: async () => { throw "synthetic probe failure"; }, query,
    monotonicMs: () => performance.now() });
  const unavailable = await session.turn(request(), () => {});
  assert.equal(unavailable.reason, "native-authority-unavailable"); assert.equal(unavailable.errorType, "non-error");
});

test("native user-turn budgets hold at 8, 25 and 50 actual synthetic process resumes", async t => {
  for (const bound of [8, 25, 50] as const) {
    const f = fixture(t, "good", bound);
    const conversation: { role: "system" | "user" | "assistant"; content: string }[] = [{ role: "system", content: "retained instruction" }];
    for (let i = 1; i <= bound; i++) {
      const prompt = `synthetic turn ${i}`; conversation.push({ role: "user", content: prompt });
      const result = await f.session.turn(request({ prompt, conversation }), () => {});
      assert.equal(result.state, "complete", `${bound}/${i}: ${result.reason}`); assert.equal(result.turn, i);
      assert.equal(result.text, `native-turn-${i}`); conversation.push({ role: "assistant", content: result.text });
    }
    const before = f.rows().length;
    const prompt = "valid but beyond the owned budget"; conversation.push({ role: "user", content: prompt });
    assert.equal((await f.session.turn(request({ prompt, conversation }), () => {})).reason, "native-session-unavailable");
    assert.equal(f.rows().length, before, "no extra child or provider request beyond the whole-session budget");
    assert.equal(f.rows().filter(r => r.phase === "prompt").length, bound);
  }
});

test("first-turn invented assistant history and invalid native paths refuse before authority or transport", async t => {
  const f = fixture(t);
  assert.throws(() => nativeCanarySession({ ...f.config, cwd: "relative" }), /session-config-invalid/);
  assert.throws(() => nativeCanarySession({ ...f.config, executable: "relative" }), /session-config-invalid/);
  const replay = request({ conversation: [{ role: "system", content: "rule" }, { role: "assistant", content: "invented" },
    { role: "user", content: "synthetic user turn" }] });
  const result = await f.session.turn(replay, () => {}); assert.equal(result.reason, "native-session-replay-refused");
  assert.equal(result.promptSent, false); assert.equal(f.rows().length, 0);
});

test("the default SDK child routes registered hooks and strict native MCP inventory to the real harness once", async t => {
  const f = fixture(t, "tool-inventory"), item = commonCanarySuite().find(c => c.id === "tools-A")!;
  const trace: CanaryToolEvent[] = [], invoke = canaryTools(item);
  const result = await f.session.turn(request({ toolPolicy: "inventory", invokeTool: (name, args) => {
    const event = invoke(name, args); trace.push(event); return event;
  } }), () => {});
  assert.equal(result.state, "complete", JSON.stringify(result)); assert.equal(result.adapterQualified, false);
  assert.equal(trace.length, 2); assert.deepEqual(trace.map(e => e.result), [{ quantity: 4 }, { quantity: 6 }]);
  const rows = f.rows(), contract = rows.find(r => r.phase === "native-contract");
  assert.equal(contract.hookRegistered, true); assert.deepEqual(contract.servers, ["canary"]);
  assert.deepEqual(contract.skills, []);
  const listed = rows.find(r => r.phase === "native-list").tools;
  assert.equal(listed.length, 1); assert.equal(listed[0].name, "inventory");
  assert.equal(listed[0].inputSchema.additionalProperties, false);
  assert.deepEqual(rows.filter(r => r.phase === "native-hook").map(r => r.decision), ["continue", "continue"]);
  assert.deepEqual(rows.filter(r => r.phase === "native-tool-result").map(r => r.result.isError), [false, false]);
  assert.ok(rows.findIndex(r => r.phase === "prompt") < rows.findIndex(r => r.phase === "native-hook"));
});

test("the default SDK child denies foreign tools and strict extra fields without routing an MCP execution", async t => {
  const f = fixture(t, "tool-denied"), invoke = canaryTools(commonCanarySuite().find(c => c.id === "tools-A")!);
  const trace: CanaryToolEvent[] = [];
  const result = await f.session.turn(request({ toolPolicy: "inventory", invokeTool: (name, args) => {
    const event = invoke(name, args); trace.push(event); return event;
  } }), () => {});
  assert.equal(result.state, "complete", "SDK loop completion is distinct from the independent task grade");
  assert.equal(trace.length, 2); assert.ok(trace.every(e => e.denied));
  assert.deepEqual(f.rows().filter(r => r.phase === "native-hook").map(r => r.decision), ["deny", "deny"]);
  assert.equal(f.rows().filter(r => r.phase === "native-tool-result").length, 0);
});

test("the default SDK child exercises both approval denial callbacks and the independent native MCP schema", async t => {
  for (const mode of ["tool-permission", "tool-unexpected-hook", "tool-schema"]) {
    const f = fixture(t, mode), trace: CanaryToolEvent[] = [], invoke = canaryTools(commonCanarySuite().find(c => c.id === "tools-A")!);
    const result = await f.session.turn(request({ toolPolicy: "inventory", invokeTool: (name, args) => {
      const event = invoke(name, args); trace.push(event); return event;
    } }), () => {});
    assert.equal(result.state, "complete", JSON.stringify(result)); assert.equal(trace.length, 0, mode);
    if (mode === "tool-permission") assert.equal(f.rows().find(r => r.phase === "native-permission").behavior, "deny");
    if (mode === "tool-unexpected-hook") assert.equal(f.rows().find(r => r.phase === "native-hook").decision, "deny");
    if (mode === "tool-schema") assert.equal(f.rows().find(r => r.phase === "native-tool-result").result.isError, true);
  }
});

test("the default SDK MCP path preserves failed retry and approval results instead of fabricating success", async t => {
  for (const id of ["recovery-retry", "recovery-approval"]) {
    const f = fixture(t, "tool-recovery"), item = commonCanarySuite().find(c => c.id === id)!;
    const trace: CanaryToolEvent[] = [], invoke = canaryTools(item);
    const result = await f.session.turn(request({ toolPolicy: item.tools, invokeTool: (name, args) => {
      const event = invoke(name, args); trace.push(event); return event;
    } }), () => {});
    assert.equal(result.state, "complete", JSON.stringify(result)); assert.equal(trace.length, 2);
    assert.deepEqual(f.rows().filter(r => r.phase === "native-tool-result").map(r => r.result.isError),
      [true, id === "recovery-approval"]);
    if (id === "recovery-retry") assert.deepEqual(trace[1]!.result, { value: 23 });
    else assert.ok(trace.every(e => e.denied || (e.result as { error?: string }).error));
  }
});

test("the default SDK MCP harness failure seals the turn with safe unavailable evidence", async t => {
  const f = fixture(t, "tool-recovery");
  const result = await f.session.turn(request({ toolPolicy: "retry", invokeTool: () => { throw new Error("private-native-tool-secret"); } }), () => {});
  assert.equal(result.state, "unavailable"); assert.equal(result.reason, "synthetic-tool-harness-unavailable");
  assert.doesNotMatch(JSON.stringify(result), /private-native-tool-secret/);
  assert.ok(f.rows().filter(r => r.phase === "native-tool-result").every(r => r.result.isError === true));
  assert.equal((await f.session.turn(request(), () => {})).reason, "native-session-unavailable");
});

test("abort after a real native MCP callback closes the positively identified default SDK child", async t => {
  const f = fixture(t, "tool-hang"), abort = new AbortController(), invoke = canaryTools(commonCanarySuite().find(c => c.id === "tools-A")!);
  const running = f.session.turn(request({ signal: abort.signal, toolPolicy: "inventory", invokeTool: invoke }), () => {});
  for (let i = 0; i < 250 && !f.rows(true).some(r => r.phase === "native-tool-result"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const child = f.rows(true).find(r => r.phase === "spawn"); assert.ok(child && Number.isSafeInteger(child.pid));
  assert.ok(f.rows(true).some(r => r.phase === "native-tool-result"), "a native tool callback really ran before cancellation");
  abort.abort(); const result = await running; assert.equal(result.state, "unavailable"); assert.equal(result.reason, "native-aborted");
  let alive = true;
  for (let i = 0; i < 100; i++) {
    try { process.kill(child.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { alive = false; break; } throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(alive, false); assert.equal((await f.session.turn(request(), () => {})).reason, "native-session-unavailable");
});

test("default SDK resource fixtures preserve missing cache conflict and session totals as distinct raw evidence", async t => {
  const pack = JSON.parse(readFileSync(new URL("test/fixtures/canary-native-resource-contracts.json", __workspaceRootUrl), "utf8"));
  assert.equal(pack.version, "native-resource-fixture-contract-v1"); assert.equal(pack.scenarios.length, 8);
  for (const scenario of pack.scenarios) {
    const f = fixture(t, scenario.mode), frames: SDKMessage[] = [];
    const result = await f.session.turn(request(), message => frames.push(message));
    assert.equal(result.state, "complete", `${scenario.mode}: ${JSON.stringify(result)}`);
    const starts = frames.filter(m => m.type === "stream_event" && m.event.type === "message_start");
    assert.ok(starts.length > 0);
    const first = starts[0] as unknown as { event: { message: { usage?: unknown } } };
    assert.deepEqual(first.event.message.usage, scenario.startUsage ?? undefined);
    const terminal = frames.find(m => m.type === "result") as unknown as { usage?: unknown; total_cost_usd: number; modelUsage: unknown };
    assert.deepEqual(terminal.usage, scenario.finalUsage ?? undefined); assert.equal(terminal.total_cost_usd, 999);
    assert.deepEqual(terminal.modelUsage, { cumulative: { inputTokens: 999999 } });
    assert.equal(JSON.stringify(result).includes("999999"), false, "session totals are not per-turn resources");
    assert.equal(result.adapterQualified, false);
    if (scenario.omitMessageStop) assert.equal(frames.some(m => m.type === "stream_event" && m.event.type === "message_stop"), false);
    if (scenario.secondaryModel) assert.equal(starts.length, 2);
    if (scenario.reset) assert.ok(frames.some(m => m.type === "system" && m.subtype === "compact_boundary"));
    if (scenario.parentToolUseId) assert.ok(frames.some(m => m.type === "stream_event" && m.parent_tool_use_id === scenario.parentToolUseId));
  }
});

test("default SDK resource fixtures resume actual sessions while keeping each new raw usage receipt separate", async t => {
  const f = fixture(t, "usage-cache"), frames: SDKMessage[] = [], conversation = [{ role: "system" as const, content: "synthetic retained instruction" }];
  const transcript: { role: "system" | "user" | "assistant"; content: string }[] = [...conversation];
  for (const prompt of ["first cache turn", "second cache turn"]) {
    transcript.push({ role: "user", content: prompt });
    const result = await f.session.turn(request({ prompt, conversation: transcript }), message => frames.push(message));
    assert.equal(result.state, "complete"); transcript.push({ role: "assistant", content: result.text });
  }
  const terminals = frames.filter(m => m.type === "result") as unknown as { usage: { input_tokens: number; cache_read_input_tokens: number } }[];
  assert.equal(terminals.length, 2); assert.deepEqual(terminals.map(m => m.usage.input_tokens), [2, 2]);
  assert.deepEqual(terminals.map(m => m.usage.cache_read_input_tokens), [3, 3]);
  assert.equal(f.rows().filter(r => r.phase === "prompt")[1].priorTurns, 1);
});

test("canonical SDK adapter consumes all eight actual wire resource contracts without session spend", async t => {
  const pack = JSON.parse(readFileSync(new URL("test/fixtures/canary-native-resource-contracts.json", __workspaceRootUrl), "utf8"));
  for (const scenario of pack.scenarios) {
    const f = fixture(t, scenario.mode), adapter = nativeCanaryAdapter(f.config);
    const response = await adapter.request(request());
    for (const [key, expected] of Object.entries(scenario.expected)) {
      const actual = key === "failure" || key === "invalidCounters" ? response.observation[key as "failure" | "invalidCounters"]
        : response.resources[key as keyof typeof response.resources];
      assert.deepEqual(actual, expected, `${scenario.mode}:${key}`);
    }
    assert.equal(response.resources.usageRatedUsd, null); assert.equal(response.resources.billing, "subscription");
    assert.equal(response.observation.sessionCostConsumed, false); assert.equal(response.native.adapterQualified, false);
    assert.doesNotMatch(JSON.stringify(response), /"(?:modelUsage|costUSD|total_cost_usd|sessionId|email|apiKey)":/);
    assert.notEqual(response.resources.inputTokens, 999999);
    assert.notEqual(response.resources.outputTokens, 999999);
    if (response.resources.terminal === "error") {
      const next = await adapter.request(request({ prompt: "second", conversation: [
        { role: "user", content: "synthetic user turn" }, { role: "assistant", content: response.text },
        { role: "user", content: "second" }] })); assert.equal(next.native.promptSent, false);
      assert.equal(next.native.framesObserved, 0, "resource uncertainty seals resume authority");
    }
  }
});

test("canonical SDK adapter resumes real transcript and rates each user turn independently", async t => {
  const f = fixture(t, "usage-cache"), adapter = nativeCanaryAdapter(f.config);
  const one = await adapter.request(request({ prompt: "first", conversation: [{ role: "system", content: "private instruction" }, { role: "user", content: "first" }] }));
  const two = await adapter.request(request({ prompt: "second", conversation: [{ role: "system", content: "private instruction" },
    { role: "user", content: "first" }, { role: "assistant", content: one.text }, { role: "user", content: "second" }] }));
  assert.deepEqual([one.resources.inputTokens, two.resources.inputTokens], [2, 2]);
  assert.deepEqual([one.resources.outputTokens, two.resources.outputTokens], [3, 3]);
  assert.equal(two.resources.cacheReadTokens, 3); assert.equal(two.resources.terminal, "complete");
  assert.ok(f.rows().find(row => row.phase === "spawn" && row.resumed));
});

test("canonical SDK adapter successful transport is independently graded and native tools share the real trace", async t => {
  const item = commonCanarySuite().find(c => c.id === "tools-A")!, f = fixture(t, "tool-grade");
  const adapter = nativeCanaryAdapter(f.config), saved: unknown[] = [];
  const result = await executeCanary(item, request().pin, { admit: async () => ({ state: "admitted" }), request: adapter.request,
    save: async (run, grade) => { saved.push({ run, grade }); }, monotonicMs: () => performance.now() },
    { maxCalls: 1, wallMs: 5000, maxOutputBytes: 4096 });
  assert.equal(result.run.attempts.length, 1); assert.ok(result.trace.length > 0);
  assert.equal(result.run.verified, true, JSON.stringify(result)); assert.equal(saved.length, 1);
  const wrong = fixture(t, "good"), response = nativeCanaryAdapter(wrong.config);
  const failed = await executeCanary(item, request().pin, { admit: async () => ({ state: "admitted" }), request: response.request,
    save: async () => {}, monotonicMs: () => performance.now() }, { maxCalls: 1, wallMs: 5000, maxOutputBytes: 4096 });
  assert.equal(failed.run.attempts[0]!.terminal, "complete"); assert.equal(failed.run.verified, false);
});

test("canonical SDK adapter refuses authority and cancellation without inventing usage or cost", async t => {
  const bad = fixture(t, "account-api"), adapter = nativeCanaryAdapter(bad.config);
  const refused = await adapter.request(request()); assert.equal(refused.native.promptSent, false);
  assert.equal(refused.resources.terminal, "error"); assert.equal(refused.resources.inputTokens, null);
  assert.equal(refused.resources.outputTokens, null); assert.equal(refused.resources.servedModel, null);
  const hanging = fixture(t, "hang-stream"), abort = new AbortController(), timeout = nativeCanaryAdapter(hanging.config);
  setTimeout(() => abort.abort(), 50);
  const canceled = await timeout.request(request({ signal: abort.signal }));
  assert.equal(canceled.resources.terminal, "timeout"); assert.equal(canceled.resources.usageRatedUsd, null);
});


test("the pinned native release refuses old and future CLI versions before auth and SDK construction", async t => {
  for (const mode of ["old-version", "future-version"]) {
    const f = fixture(t, mode), result = await f.session.turn(request(), () => {});
    assert.equal(result.state, "unavailable", mode);
    assert.equal(result.reason, "native-authority-unavailable", mode);
    assert.equal(result.promptSent, false, mode);
    assert.equal(result.framesObserved, 0, mode);
    assert.deepEqual(f.rows().map(row => row.phase), ["version"], mode);
    const before = f.rows();
    assert.equal((await f.session.turn(request(), () => {})).reason, "native-session-unavailable", mode);
    assert.deepEqual(f.rows(), before, "a refused release does not probe, authenticate or retry again");
  }
});
