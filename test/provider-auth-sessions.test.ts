import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  defaultCodexBin,
  processCodexLine,
  providerAuthSessionId,
  ProviderAuthSessionStore,
  readProviderAuthProfiles,
  startProviderAuthSession,
  type ProviderAuthProjection,
  type ProviderAuthSessionDeps,
} from "../src/lib/provider-auth-sessions.js";

class FakeChild extends EventEmitter {
  readonly writes: string[] = [];
  readonly stdin = { write: (value: string) => { this.writes.push(value); return true; } };
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function codexStore(over: Partial<ConstructorParameters<typeof ProviderAuthSessionStore>[0]> = {}) {
  const child = new FakeChild();
  const store = new ProviderAuthSessionStore({
    profiles: [{ id: "codex-personal", provider: "codex", label: "Codex personal", credentialHome: "/srv/credentials/codex-personal" }],
    randomId: () => "session_opaque_123456789",
    resolveCodexBin: () => "/usr/local/bin/codex",
    spawn: (() => child) as unknown as NonNullable<ProviderAuthSessionDeps["spawn"]>,
    ...over,
  });
  return { store, child };
}

function emit(child: FakeChild, value: unknown): void {
  child.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
}

function emitRaw(child: FakeChild, line: string): void {
  child.stdout.emit("data", Buffer.from(`${line}\n`));
}

test("provider auth projection redacts tokens paths transcripts and raw provider payloads", async () => {
  let validated = 0;
  const { store, child } = codexStore({ validateEffectiveProfile: () => { validated += 1; return true; } });
  const started = await store.start({ provider: "codex", profileId: "codex-personal" });
  assert.equal(started.state, "awaiting_browser");
  assert.equal(started.authUrl, null);
  assert.equal(child.writes.length, 1);
  assert.match(child.writes[0]!, /"method":"initialize"/);

  emit(child, { id: 1, result: {} });
  assert.match(child.writes[2]!, /account\/login\/start/);
  emit(child, { id: 2, result: { authUrl: "https://auth.openai.com/oauth/authorize?state=opaque", loginId: "login-1" } });
  assert.equal(store.read(started.sessionId)?.authUrl, "https://auth.openai.com/oauth/authorize?state=opaque");
  emit(child, { method: "account/login/completed", params: { loginId: "wrong" } });
  assert.equal(store.read(started.sessionId)?.state, "awaiting_browser");
  emit(child, { method: "account/login/completed", params: { loginId: "login-1" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.read(started.sessionId)?.state, "complete");
  assert.equal(validated, 1);
  assert.equal(child.killed, true);
  assert.doesNotMatch(JSON.stringify(store.read(started.sessionId)), /credentialHome|\/srv\/credentials|authUrl.*token/);
});

test("Codex auth completion requires the matching app-server login notification", async () => {
  const { store, child } = codexStore();
  const started = await store.start({ provider: "codex", profileId: "codex-personal" });
  emit(child, { id: 1, result: {} });
  emit(child, { id: 2, result: { authUrl: "https://auth.openai.com/oauth/authorize?state=opaque", loginId: "login-matching" } });
  emit(child, { method: "account/login/completed", params: { loginId: "not-the-login" } });
  assert.equal(store.read(started.sessionId)?.state, "awaiting_browser");
  emit(child, { method: "account/login/completed", params: { loginId: "login-matching" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.read(started.sessionId)?.state, "complete");
});

test("unsupported provider auth cannot become complete from browser-open state", async () => {
  const store = new ProviderAuthSessionStore({ profiles: [{ id: "claude-personal", provider: "claude", label: "Claude personal" }] });
  const started = await store.start({ provider: "claude", profileId: "claude-personal" });
  assert.equal(started.state, "unsupported");
  assert.equal(started.authUrl, null);
  assert.match(started.reason ?? "", /stable machine-facing contract/);
});

test("provider auth refusal leaves effective account and queued admission unchanged", async () => {
  const { store, child } = codexStore({ validateEffectiveProfile: () => false });
  const started = await store.start({ provider: "codex", profileId: "codex-personal" });
  emit(child, { id: 1, result: {} });
  emit(child, { id: 2, result: { authUrl: "https://auth.openai.com/oauth/authorize?state=opaque", loginId: "login-refused" } });
  emit(child, { method: "account/login/completed", params: { loginId: "login-refused" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.read(started.sessionId)?.state, "failed");
  assert.match(store.read(started.sessionId)?.reason ?? "", /changed before completion/);
  assert.equal(child.killed, true);
});

test("expired and cancelled sessions cannot remain operative", async () => {
  let now = 1_000;
  const { store, child } = codexStore({ now: () => now, ttlMs: 1_000 });
  const expired = await store.start({ provider: "codex", profileId: "codex-personal" });
  now = 2_000;
  assert.equal(store.read(expired.sessionId)?.state, "expired");
  assert.equal(child.killed, true);

  const next = codexStore({ now: () => now, ttlMs: 10_000 });
  const cancelled = await next.store.start({ provider: "codex", profileId: "codex-personal" });
  assert.equal(next.store.cancel(cancelled.sessionId)?.state, "cancelled");
  assert.equal(next.child.killed, true);
});

test("profile configuration is server-owned and malformed entries are refused", () => {
  const profiles = readProviderAuthProfiles({
    RMD_PROVIDER_AUTH_PROFILES: JSON.stringify([
      { id: "codex-personal", provider: "codex", label: "Personal", credentialHome: "/srv/codex" },
      { id: "bad", provider: "openai", label: "Unsupported" },
      { id: "missing-home", provider: "codex", label: "Missing home" },
    ]),
  });
  assert.deepEqual(profiles, [{ id: "codex-personal", provider: "codex", label: "Personal", credentialHome: "/srv/codex" }]);
});

test("an unset profile catalog falls back to the built-in claude/codex defaults", () => {
  const profiles = readProviderAuthProfiles({});
  assert.deepEqual(
    profiles.map((profile) => [profile.id, profile.provider]),
    [
      ["claude-default", "claude"],
      ["codex-default", "codex"],
    ],
  );
  assert.equal(typeof profiles[1]!.credentialHome, "string");
});

test("a malformed profile catalog (invalid JSON) yields no usable profiles rather than throwing", () => {
  assert.deepEqual(readProviderAuthProfiles({ RMD_PROVIDER_AUTH_PROFILES: "{not json" }), []);
});

test("defaultCodexBin resolves a pinned codexBin without consulting `which`", () => {
  let whichCalls = 0;
  const bin = defaultCodexBin({ id: "codex-personal", provider: "codex", label: "Personal", codexBin: process.execPath }, () => {
    whichCalls += 1;
    return "unused";
  });
  assert.equal(bin, process.execPath);
  assert.equal(whichCalls, 0);
});

test("defaultCodexBin records the injected `which` call and resolves its answer", () => {
  const calls: string[] = [];
  const bin = defaultCodexBin({ id: "codex-personal", provider: "codex", label: "Personal" }, (command) => {
    calls.push(command);
    return `${process.execPath}\n`;
  });
  assert.deepEqual(calls, ["codex"]);
  assert.equal(bin, process.execPath);
});

test("defaultCodexBin returns null when the injected `which` throws", () => {
  const bin = defaultCodexBin({ id: "codex-personal", provider: "codex", label: "Personal" }, () => {
    throw new Error("codex is not on PATH");
  });
  assert.equal(bin, null);
});

test("defaultCodexBin returns null when the resolved path is not executable", () => {
  const bin = defaultCodexBin({ id: "codex-personal", provider: "codex", label: "Personal", codexBin: "/nonexistent/not-a-real-codex-binary" });
  assert.equal(bin, null);
});

test("a Codex profile without a configured credential home cannot start a browser handoff", async () => {
  const store = new ProviderAuthSessionStore({
    profiles: [{ id: "codex-no-home", provider: "codex", label: "No home" }],
    randomId: () => "session_no_home_0000000000",
  });
  const started = await store.start({ provider: "codex", profileId: "codex-no-home" });
  assert.equal(started.state, "unavailable");
  assert.match(started.reason ?? "", /credential home is not configured/);
});

test("a Codex profile whose executable cannot be resolved cannot start a browser handoff", async () => {
  const { store } = codexStore({ resolveCodexBin: () => null });
  const started = await store.start({ provider: "codex", profileId: "codex-personal" });
  assert.equal(started.state, "unavailable");
  assert.match(started.reason ?? "", /executable is not available/);
});

test("a spawn failure that throws synchronously leaves the session unavailable, not hung", async () => {
  const { store } = codexStore({
    spawn: () => {
      throw new Error("EACCES");
    },
  });
  const started = await store.start({ provider: "codex", profileId: "codex-personal" });
  assert.equal(started.state, "unavailable");
  assert.match(started.reason ?? "", /could not start: EACCES/);
});

test("the app-server exiting before login completion fails the session instead of leaving it hung", async () => {
  const { store, child } = codexStore();
  const started = await store.start({ provider: "codex", profileId: "codex-personal" });
  assert.equal(started.state, "awaiting_browser");
  child.emit("exit", 1);
  assert.equal(store.read(started.sessionId)?.state, "failed");
  assert.match(store.read(started.sessionId)?.reason ?? "", /exited before login completion \(1\)/);
});

test("an app-server exit after completion is a no-op (the session stays complete)", async () => {
  const { store, child } = codexStore({ validateEffectiveProfile: () => true });
  const started = await store.start({ provider: "codex", profileId: "codex-personal" });
  emit(child, { id: 1, result: {} });
  emit(child, { id: 2, result: { authUrl: "https://auth.openai.com/oauth/authorize?state=opaque", loginId: "login-done" } });
  emit(child, { method: "account/login/completed", params: { loginId: "login-done" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.read(started.sessionId)?.state, "complete");
  child.emit("exit", 0);
  assert.equal(store.read(started.sessionId)?.state, "complete");
});

test("a malformed (non-JSON) app-server stdout line fails the session instead of throwing", async () => {
  const { store, child } = codexStore();
  const started = await store.start({ provider: "codex", profileId: "codex-personal" });
  emitRaw(child, "{not valid json");
  assert.equal(store.read(started.sessionId)?.state, "failed");
  assert.match(store.read(started.sessionId)?.reason ?? "", /malformed app-server output/);
});

test("an app-server initialization error fails the session with the reported message", async () => {
  const { store, child } = codexStore();
  const started = await store.start({ provider: "codex", profileId: "codex-personal" });
  emit(child, { id: 1, error: { message: "app-server refused to boot" } });
  assert.equal(store.read(started.sessionId)?.state, "failed");
  assert.match(store.read(started.sessionId)?.reason ?? "", /app-server refused to boot/);
});

test("an authorization URL outside the allowed Codex hosts fails the session (URL constructor throw path included)", async () => {
  const { store, child } = codexStore();
  const started = await store.start({ provider: "codex", profileId: "codex-personal" });
  emit(child, { id: 1, result: {} });
  emit(child, { id: 2, result: { authUrl: "not a url at all", loginId: "login-1" } });
  assert.equal(store.read(started.sessionId)?.state, "failed");
  assert.match(store.read(started.sessionId)?.reason ?? "", /did not return an allowed browser authorization URL/);
});

test("processCodexLine's defensive profile-missing branch fails a synthetic record without throwing", () => {
  const store = new ProviderAuthSessionStore({ profiles: [], validateEffectiveProfile: () => true });
  const projection: ProviderAuthProjection = {
    version: "provider-auth-v1",
    sessionId: "session_synthetic",
    provider: "codex",
    profileId: null,
    label: null,
    state: "awaiting_browser",
    authUrl: "https://auth.openai.com/oauth/authorize?state=opaque",
    expiresAt: new Date().toISOString(),
  };
  const record = { projection, profile: null, expiresAtMs: Date.now() + 60_000, loginId: "login-orphan", buffer: "" };
  processCodexLine(store, record, JSON.stringify({ method: "account/login/completed", params: { loginId: "login-orphan" } }));
  assert.equal(record.projection.state, "failed");
  assert.match(record.projection.reason ?? "", /profile is unavailable/);
});

test("startProviderAuthSession is the same public seam the console route wires up", async () => {
  const { store } = codexStore();
  const started = await startProviderAuthSession(store, { provider: "codex", profileId: "codex-personal" });
  assert.equal(started.state, "awaiting_browser");
});

test("providerAuthSessionId accepts only the opaque id shape the store issues", () => {
  assert.equal(providerAuthSessionId("session_opaque_123456789"), "session_opaque_123456789");
  assert.equal(providerAuthSessionId("short"), null);
  assert.equal(providerAuthSessionId("has spaces not allowed"), null);
  assert.equal(providerAuthSessionId(42), null);
});
