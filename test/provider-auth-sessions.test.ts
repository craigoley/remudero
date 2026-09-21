import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { ProviderAuthSessionStore, readProviderAuthProfiles, type ProviderAuthSessionDeps } from "../src/lib/provider-auth-sessions.js";

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
