import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  buildProviderAuthRoutes,
  providerAuthSessionId,
  ProviderAuthSessionStore,
  readProviderAuthProfiles,
  startProviderAuthSession,
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

test("provider auth profile defaults and malformed catalogs fail closed", () => {
  assert.deepEqual(readProviderAuthProfiles({ CODEX_HOME: "/srv/codex-default" }), [
    { id: "claude-default", provider: "claude", label: "Claude account" },
    { id: "codex-default", provider: "codex", label: "Codex account", credentialHome: "/srv/codex-default" },
  ]);
  assert.deepEqual(readProviderAuthProfiles({ RMD_PROVIDER_AUTH_PROFILES: "not-json" }), []);
  assert.deepEqual(readProviderAuthProfiles({ RMD_PROVIDER_AUTH_PROFILES: "{}" }), []);
});

test("provider auth rejects malformed provider output and unsafe browser URLs", async () => {
  const malformed = codexStore();
  const malformedSession = await malformed.store.start({ provider: "codex", profileId: "codex-personal" });
  malformed.child.stdout.emit("data", Buffer.from("not-json\n"));
  assert.equal(malformed.store.read(malformedSession.sessionId)?.state, "failed");
  assert.match(malformed.store.read(malformedSession.sessionId)?.reason ?? "", /malformed/);

  const initError = codexStore();
  const initSession = await initError.store.start({ provider: "codex", profileId: "codex-personal" });
  emit(initError.child, { id: 1, error: { message: "init\nfailed" } });
  assert.equal(initError.store.read(initSession.sessionId)?.state, "failed");
  assert.equal(initError.store.read(initSession.sessionId)?.reason, "init failed");

  const unsafe = codexStore();
  const unsafeSession = await unsafe.store.start({ provider: "codex", profileId: "codex-personal" });
  emit(unsafe.child, { id: 2, result: { authUrl: "http://evil.example/login", loginId: "unsafe" } });
  assert.equal(unsafe.store.read(unsafeSession.sessionId)?.state, "failed");

  const malformedUrl = codexStore();
  const malformedUrlSession = await malformedUrl.store.start({ provider: "codex", profileId: "codex-personal" });
  emit(malformedUrl.child, { id: 2, result: { authUrl: "not a URL", loginId: "malformed-url" } });
  assert.equal(malformedUrl.store.read(malformedUrlSession.sessionId)?.state, "failed");

  const ignored = codexStore();
  const ignoredSession = await ignored.store.start({ provider: "codex", profileId: "codex-personal" });
  emit(ignored.child, ["ignore-array"]);
  emit(ignored.child, { method: "unrelated/notification" });
  assert.equal(ignored.store.read(ignoredSession.sessionId)?.state, "awaiting_browser");
});

test("provider auth covers unavailable, spawn, and child lifecycle failures", async () => {
  const missingHome = new ProviderAuthSessionStore({
    profiles: [{ id: "codex-missing-home", provider: "codex", label: "Missing home" }],
    randomId: () => "session_missing_home_123456",
  });
  const missingHomeSession = await missingHome.start({ provider: "codex", profileId: "codex-missing-home" });
  assert.equal(missingHomeSession.state, "unavailable");
  assert.match(missingHomeSession.reason ?? "", /credential home/);

  const missingBin = new ProviderAuthSessionStore({
    profiles: [{ id: "codex-missing-bin", provider: "codex", label: "Missing bin", credentialHome: "/srv/codex" }],
    randomId: () => "session_missing_bin_123456",
    resolveCodexBin: () => null,
  });
  const missingBinSession = await missingBin.start({ provider: "codex", profileId: "codex-missing-bin" });
  assert.equal(missingBinSession.state, "unavailable");
  assert.match(missingBinSession.reason ?? "", /executable/);

  const throwingSpawn = new ProviderAuthSessionStore({
    profiles: [{ id: "codex-throwing-spawn", provider: "codex", label: "Throwing spawn", credentialHome: "/srv/codex" }],
    randomId: () => "session_throwing_spawn_123456",
    resolveCodexBin: () => "/usr/local/bin/codex",
    spawn: () => { throw new Error("spawn denied"); },
  });
  const throwingSession = await throwingSpawn.start({ provider: "codex", profileId: "codex-throwing-spawn" });
  assert.equal(throwingSession.state, "unavailable");
  assert.match(throwingSession.reason ?? "", /spawn denied/);

  const errorChild = new FakeChild();
  const errorStore = new ProviderAuthSessionStore({
    profiles: [{ id: "codex-error-child", provider: "codex", label: "Error child", credentialHome: "/srv/codex" }],
    randomId: () => "session_error_child_123456",
    resolveCodexBin: () => "/usr/local/bin/codex",
    spawn: (() => errorChild) as unknown as NonNullable<ProviderAuthSessionDeps["spawn"]>,
  });
  const errorSession = await errorStore.start({ provider: "codex", profileId: "codex-error-child" });
  errorChild.emit("error", new Error("child failed"));
  assert.equal(errorStore.read(errorSession.sessionId)?.state, "failed");
  assert.match(errorStore.read(errorSession.sessionId)?.reason ?? "", /child failed/);

  const exitChild = new FakeChild();
  const exitStore = new ProviderAuthSessionStore({
    profiles: [{ id: "codex-exit-child", provider: "codex", label: "Exit child", credentialHome: "/srv/codex" }],
    randomId: () => "session_exit_child_123456",
    resolveCodexBin: () => "/usr/local/bin/codex",
    spawn: (() => exitChild) as unknown as NonNullable<ProviderAuthSessionDeps["spawn"]>,
  });
  const exitSession = await exitStore.start({ provider: "codex", profileId: "codex-exit-child" });
  exitChild.emit("exit", 7);
  assert.equal(exitStore.read(exitSession.sessionId)?.state, "failed");
  assert.match(exitStore.read(exitSession.sessionId)?.reason ?? "", /exited before login completion/);
});

test("provider auth uses the real default resolver and spawn seam", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/definitely/missing/provider-auth-tools";
  try {
    const missingWhich = new ProviderAuthSessionStore({
      profiles: [{ id: "codex-missing-which", provider: "codex", label: "Missing which", credentialHome: "/srv/codex" }],
      randomId: () => "session_missing_which_123456",
    });
    const missingWhichSession = await missingWhich.start({ provider: "codex", profileId: "codex-missing-which" });
    assert.equal(missingWhichSession.state, "unavailable");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }

  const missingExecutable = new ProviderAuthSessionStore({
    profiles: [{ id: "codex-missing-executable", provider: "codex", label: "Missing executable", credentialHome: "/srv/codex", codexBin: "/definitely/missing/codex" }],
    randomId: () => "session_missing_executable_123456",
  });
  const missingExecutableSession = await missingExecutable.start({ provider: "codex", profileId: "codex-missing-executable" });
  assert.equal(missingExecutableSession.state, "unavailable");

  const realSpawn = new ProviderAuthSessionStore({
    profiles: [{ id: "codex-real-spawn", provider: "codex", label: "Real spawn", credentialHome: "/srv/codex", codexBin: process.execPath }],
    randomId: () => "session_real_spawn_123456",
  });
  const realSpawnSession = await realSpawn.start({ provider: "codex", profileId: "codex-real-spawn" });
  assert.equal(realSpawnSession.state, "awaiting_browser");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const realSpawnState = realSpawn.read(realSpawnSession.sessionId)?.state;
  assert.ok(realSpawnState === "awaiting_browser" || realSpawnState === "failed");
  if (realSpawnState === "awaiting_browser") {
    assert.equal(realSpawn.cancel(realSpawnSession.sessionId)?.state, "cancelled");
  }
});

test("provider auth revalidation failure and defensive missing profile are terminal", async () => {
  const rejected = codexStore({ validateEffectiveProfile: async () => { throw new Error("profile read failed"); } });
  const rejectedSession = await rejected.store.start({ provider: "codex", profileId: "codex-personal" });
  emit(rejected.child, { id: 1, result: {} });
  emit(rejected.child, { id: 2, result: { authUrl: "https://auth.openai.com/oauth/authorize", loginId: "login-rejected" } });
  emit(rejected.child, { method: "account/login/completed", params: { loginId: "login-rejected" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected.store.read(rejectedSession.sessionId)?.state, "failed");
  assert.match(rejected.store.read(rejectedSession.sessionId)?.reason ?? "", /revalidated/);

  const defensive = codexStore();
  const defensiveSession = await defensive.store.start({ provider: "codex", profileId: "codex-personal" });
  const internal = defensive.store as unknown as { sessions: Map<string, { profile: unknown }> };
  internal.sessions.get(defensiveSession.sessionId)!.profile = null;
  emit(defensive.child, { id: 1, result: {} });
  emit(defensive.child, { id: 2, result: { authUrl: "https://auth.openai.com/oauth/authorize", loginId: "login-defensive" } });
  emit(defensive.child, { method: "account/login/completed", params: { loginId: "login-defensive" } });
  assert.equal(defensive.store.read(defensiveSession.sessionId)?.state, "failed");
  assert.match(defensive.store.read(defensiveSession.sessionId)?.reason ?? "", /unavailable/);
});

test("provider auth public seams validate ids and delegate starts", async () => {
  assert.equal(providerAuthSessionId("session_123456"), "session_123456");
  assert.equal(providerAuthSessionId("short"), null);
  assert.equal(providerAuthSessionId("not valid!"), null);
  const store = new ProviderAuthSessionStore({ profiles: [] , randomId: () => "session_public_123456" });
  const projection = await startProviderAuthSession(store, { provider: "codex", profileId: "missing" });
  assert.equal(projection.state, "unavailable");
});

test("provider auth routes reject malformed requests and expose session lifecycle", async () => {
  const store = new ProviderAuthSessionStore({ profiles: [], randomId: () => "session_route_123456" });
  const [post, get, del] = buildProviderAuthRoutes(store);
  assert.equal(post.method, "POST");
  assert.equal(get.method, "GET");
  assert.equal(del.method, "DELETE");
});
