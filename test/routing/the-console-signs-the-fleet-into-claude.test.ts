// W1-T10380: THE CONSOLE SIGNS THE FLEET INTO CLAUDE. provider-auth-v1 answered every Claude start
// with `unsupported`, so changing the fleet's account needed a shell on the host. The daemon now
// drives the CLI's own `claude auth login` in a private staging dir, the console shows the URL it
// printed, the operator pastes the code back (PATCH /v1/provider-auth), and only a staged credential
// that classifies usable replaces the fleet store. The host's own login is never read or written.
//
// THE FAKE CLI IS A REAL PROCESS. Every test spawns an executable script through the store's
// DEFAULT spawn and its DEFAULT binary resolution (the profile's server-only `claudeBin`), so the
// pipe contract, the environment and the exit handling are the shipped ones. Its output replays
// what the pinned CLI (2.1.303) printed when run as
// `CLAUDE_CONFIG_DIR=<0700 dir> claude auth login --claudeai` with a pipe for stdin (2026-10-22):
// an "Opening browser" line, a `https://claude.com/cai/oauth/authorize?...` line, then the
// "Paste code here if prompted > " prompt with no newline, reading the code from stdin.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  buildProviderAuthCodeRoutes,
  buildProviderAuthRoutes,
  ProviderAuthSessionStore,
  type ProviderAuthProjection,
} from "#src/lib/provider-auth-sessions.js";
import { CLAUDE_REFRESH_LOCK_NAME, replaceClaudeFleetCredential } from "#src/lib/worker-home.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

/** The authorize URL line exactly as the pinned CLI printed it (PKCE values replaced). */
const CLI_URL_LINE =
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference" +
  "&code_challenge=fixture-challenge&code_challenge_method=S256&state=fixture-state";
const PASTED_CODE = "pasted-code-W1T10380#fixture-state";
const NEW_ACCESS = "sk-ant-oat01-NEW-ACCESS-W1T10380";
const NEW_REFRESH = "sk-ant-ort01-NEW-REFRESH-W1T10380";
const OLD_ACCESS = "sk-ant-oat01-OLD-ACCESS-STORE";
const HOST_ACCESS = "sk-ant-oat01-HOST-LOGIN-NEVER-TOUCHED";
const ACCOUNT_EMAIL = "operator@example.com";

type Mode = "usable" | "malformed" | "fail";

type Fixture = {
  realHome: string;
  storeFile: string;
  hostFile: string;
  oldStore: Buffer;
  hostLogin: Buffer;
  record: string;
  bin: (mode: Mode) => string;
};

function credential(accessToken: string, refreshToken: string): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"], subscriptionType: "max" },
  });
}

function fixture(t: TestContext): Fixture {
  const root = ownedFixtureDir(t, "w1-t10380").dir;
  const realHome = join(root, "home");
  const store = join(realHome, ".claude", "fleet-auth", "claude");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const storeFile = join(store, ".credentials.json");
  const hostFile = join(realHome, ".claude", ".credentials.json");
  writeFileSync(storeFile, credential(OLD_ACCESS, "sk-ant-ort01-OLD-REFRESH-STORE"), { mode: 0o600 });
  writeFileSync(hostFile, credential(HOST_ACCESS, "sk-ant-ort01-HOST-REFRESH"), { mode: 0o600 });
  const record = join(root, "cli-record.json");
  const script = join(root, "fake-claude.mjs");
  writeFileSync(script, `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const [mode, record, ...args] = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR;
process.stdout.write("Opening browser to sign in\\u2026\\n");
process.stdout.write(${JSON.stringify(`${CLI_URL_LINE}\n`)});
process.stdout.write("Paste code here if prompted > ");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (!input.includes("\\n")) return;
  const code = input.split("\\n")[0];
  writeFileSync(record, JSON.stringify({ args, code, configDir: dir, home: process.env.HOME, keys: Object.keys(process.env) }));
  if (mode === "fail") { process.stderr.write("Login failed: getaddrinfo EAI_AGAIN platform.claude.com\\n"); process.exit(1); }
  if (mode === "malformed") writeFileSync(join(dir, ".credentials.json"), "{\\"claudeAiOauth\\": ");
  if (mode === "usable") {
    writeFileSync(join(dir, ".credentials.json"), ${JSON.stringify(credential(NEW_ACCESS, NEW_REFRESH))});
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: ${JSON.stringify(ACCOUNT_EMAIL)}, accountUuid: "uuid-1" } }));
  }
  process.stdout.write("Login successful.\\n");
  process.exit(0);
});
`);
  const bin = (mode: Mode): string => {
    const wrapper = join(root, `claude-${mode}`);
    writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${mode} ${JSON.stringify(record)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    return wrapper;
  };
  return { realHome, storeFile, hostFile, oldStore: readFileSync(storeFile), hostLogin: readFileSync(hostFile), record, bin };
}

function storeFor(f: Fixture, mode: Mode, extra: Partial<ConstructorParameters<typeof ProviderAuthSessionStore>[0]> = {}): ProviderAuthSessionStore {
  let n = 0;
  return new ProviderAuthSessionStore({
    profiles: [{ id: "claude-fleet", provider: "claude", label: "Fleet Claude", claudeBin: f.bin(mode) }],
    claudeRealHome: f.realHome,
    randomId: () => `claude-session-${String(++n).padStart(4, "0")}`,
    ...extra,
  });
}

async function untilAuthUrl(store: ProviderAuthSessionStore, sessionId: string): Promise<ProviderAuthProjection> {
  for (let i = 0; i < 400; i++) {
    const read = store.read(sessionId);
    if (read?.authUrl || read?.state !== "awaiting_browser") return read!;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("the fake CLI never printed its authorize URL");
}

async function untilSettled(store: ProviderAuthSessionStore, sessionId: string): Promise<ProviderAuthProjection> {
  for (let i = 0; i < 400; i++) {
    const read = store.read(sessionId)!;
    if (read.state !== "awaiting_browser") return read;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("the session never settled");
}

function stagingDirs(f: Fixture): string[] {
  return readdirSync(join(f.realHome, ".claude", "fleet-auth")).filter((name) => name.startsWith(".claude-login-"));
}

test("W1-T10380: a pasted Claude code replaces the fleet store and leaves the host login untouched", async (t) => {
  const f = fixture(t);
  const store = storeFor(f, "usable");
  const started = await store.start({ provider: "claude", profileId: "claude-fleet" });
  assert.equal(started.state, "awaiting_browser", "a Claude start is no longer `unsupported`");
  assert.equal(stagingDirs(f).length, 1, "the login runs in ONE staging dir beside the store");
  const shown = await untilAuthUrl(store, started.sessionId);
  assert.equal(new URL(shown.authUrl!).hostname, "claude.com");
  assert.match(shown.authUrl!, /\/cai\/oauth\/authorize\?/);

  const submitted = await store.submitCode(started.sessionId, PASTED_CODE);
  assert.equal(submitted.outcome, "accepted");
  const done = submitted.outcome === "accepted" ? submitted.projection : null;
  assert.equal(done?.state, "complete", done?.reason);
  assert.equal(done?.accountLabel, "o***@example.com");

  const replaced = JSON.parse(readFileSync(f.storeFile, "utf8")) as { claudeAiOauth: { accessToken: string; refreshToken: string } };
  assert.equal(replaced.claudeAiOauth.accessToken, NEW_ACCESS, "the store now holds the credential the CLI staged");
  assert.equal(replaced.claudeAiOauth.refreshToken, NEW_REFRESH);
  assert.deepEqual(readFileSync(f.hostFile), f.hostLogin, "the host login is byte-identical");
  assert.deepEqual(stagingDirs(f), [], "the staging dir is removed once the store is replaced");
  const fleetStore = join(f.realHome, ".claude", "fleet-auth", "claude");
  assert.deepEqual(readdirSync(fleetStore).sort(), [".credentials.json"], "no lock or temp file is left in the store");
  assert.equal(existsSync(`${fleetStore}.lock`), false, "the legacy refresh lock is released");

  const cli = JSON.parse(readFileSync(f.record, "utf8")) as { args: string[]; code: string; configDir: string; home: string; keys: string[] };
  assert.deepEqual(cli.args, ["auth", "login", "--claudeai"]);
  assert.equal(cli.code, PASTED_CODE, "the pasted code reached the CLI's stdin");
  assert.match(cli.configDir, /\/\.claude\/fleet-auth\/\.claude-login-[^/]+$/, "CLAUDE_CONFIG_DIR is the staging dir, never the store or ~/.claude");
  assert.equal(cli.home, cli.configDir, "HOME is the staging dir too, so the host ~/.claude is unreachable");
  assert.ok(!cli.keys.includes("CLAUDE_CODE_OAUTH_TOKEN") && !cli.keys.includes("ANTHROPIC_API_KEY"));

  const again = await store.submitCode(started.sessionId, PASTED_CODE);
  assert.equal(again.outcome, "conflict", "the code is single-use");
});

test("W1-T10380: a Claude login that does not finish usable never touches the fleet store", async (t) => {
  const f = fixture(t);
  const unchanged = (label: string): void => {
    assert.deepEqual(readFileSync(f.storeFile), f.oldStore, `${label}: the fleet store is byte-identical`);
    assert.deepEqual(readFileSync(f.hostFile), f.hostLogin, `${label}: the host login is byte-identical`);
    assert.deepEqual(stagingDirs(f), [], `${label}: the staging dir is removed`);
  };

  // A malformed staged file: the CLI exits 0, but its credential does not classify usable.
  let store = storeFor(f, "malformed");
  let started = await store.start({ provider: "claude", profileId: "claude-fleet" });
  await untilAuthUrl(store, started.sessionId);
  await store.submitCode(started.sessionId, PASTED_CODE);
  let settled = await untilSettled(store, started.sessionId);
  assert.equal(settled.state, "failed");
  assert.match(settled.reason ?? "", /credential-file-malformed/);
  unchanged("malformed");

  // A CLI that exits non-zero after taking the code.
  store = storeFor(f, "fail");
  started = await store.start({ provider: "claude", profileId: "claude-fleet" });
  await untilAuthUrl(store, started.sessionId);
  await store.submitCode(started.sessionId, PASTED_CODE);
  settled = await untilSettled(store, started.sessionId);
  assert.equal(settled.state, "failed");
  assert.match(settled.reason ?? "", /exit 1/);
  unchanged("cli exit");

  // An expired session: the URL was shown, the clock passed the TTL, the code arrives too late.
  let nowMs = Date.parse("2026-10-22T12:00:00.000Z");
  store = storeFor(f, "usable", { now: () => nowMs, ttlMs: 60_000 });
  started = await store.start({ provider: "claude", profileId: "claude-fleet" });
  await untilAuthUrl(store, started.sessionId);
  nowMs += 60_001;
  assert.equal(store.read(started.sessionId)?.state, "expired");
  const late = await store.submitCode(started.sessionId, PASTED_CODE);
  assert.equal(late.outcome, "conflict");
  unchanged("expired");

  // A usable staged file while a live worker refresh holds the CLI's own lock: refused, not interleaved.
  const lock = join(f.realHome, ".claude", "fleet-auth", "claude", CLAUDE_REFRESH_LOCK_NAME);
  mkdirSync(lock);
  store = storeFor(f, "usable", {
    replaceClaudeStore: (opts) => replaceClaudeFleetCredential({ ...opts, lockAttempts: 2, sleep: async () => undefined }),
  });
  started = await store.start({ provider: "claude", profileId: "claude-fleet" });
  await untilAuthUrl(store, started.sessionId);
  await store.submitCode(started.sessionId, PASTED_CODE);
  settled = await untilSettled(store, started.sessionId);
  assert.equal(settled.state, "failed");
  assert.match(settled.reason ?? "", /fleet-store-refresh-lock-busy/);
  assert.ok(existsSync(lock), "the live holder's lock is left alone");
  unchanged("refresh lock held");

  // The same lock left STALE by a dead refresher is reclaimed exactly as the CLI would, then released.
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  started = await store.start({ provider: "claude", profileId: "claude-fleet" });
  await untilAuthUrl(store, started.sessionId);
  await store.submitCode(started.sessionId, PASTED_CODE);
  settled = await untilSettled(store, started.sessionId);
  assert.equal(settled.state, "complete", settled.reason);
  assert.equal(existsSync(lock), false);
});

type Capture = { status: number; body: string };

async function invoke(route: { handler: (...args: any[]) => unknown }, url: string, body?: string): Promise<Capture> {
  const request = new EventEmitter() as any;
  request.url = url;
  request.headers = {};
  const capture: Capture = { status: 0, body: "" };
  const response = {
    writeHead(status: number) { capture.status = status; },
    end(text?: string) { capture.body = text ?? ""; },
  };
  const handled = route.handler(request, response, { params: {} });
  queueMicrotask(() => {
    if (body) request.emit("data", Buffer.from(body));
    request.emit("end");
  });
  await handled;
  return capture;
}

test("W1-T10380: the Claude session projection carries no code, token or path", async (t) => {
  const f = fixture(t);
  const store = storeFor(f, "usable");
  const [post, get] = buildProviderAuthRoutes(store);
  const [patch] = buildProviderAuthCodeRoutes(store);
  assert.equal(patch!.method, "PATCH");
  assert.equal(patch!.path, "/v1/provider-auth");
  const bodies: string[] = [];

  const started = await invoke(post!, "/v1/provider-auth", JSON.stringify({ provider: "claude", profileId: "claude-fleet" }));
  assert.equal(started.status, 200);
  bodies.push(started.body);
  const sessionId = (JSON.parse(started.body) as ProviderAuthProjection).sessionId;
  await untilAuthUrl(store, sessionId);
  const read = await invoke(get!, `/v1/provider-auth?sessionId=${sessionId}`);
  bodies.push(read.body);

  const tooLong = "x".repeat(1_025);
  for (const code of [tooLong, "has whitespace#state", 42]) {
    const refused = await invoke(patch!, "/v1/provider-auth", JSON.stringify({ sessionId, code }));
    assert.equal(refused.status, 400);
    assert.ok(!refused.body.includes("whitespace") && !refused.body.includes(tooLong), "a refused code is never echoed");
    bodies.push(refused.body);
  }
  assert.equal((await invoke(patch!, "/v1/provider-auth", "{")).status, 400);
  const [tiny] = buildProviderAuthCodeRoutes(store, 8);
  const tooLarge = await invoke(tiny!, "/v1/provider-auth", JSON.stringify({ sessionId, code: PASTED_CODE }));
  assert.equal(tooLarge.status, 413);
  assert.ok(!tooLarge.body.includes(PASTED_CODE));
  assert.equal((await invoke(patch!, "/v1/provider-auth", JSON.stringify({ code: PASTED_CODE }))).status, 400);
  assert.equal((await invoke(patch!, "/v1/provider-auth", JSON.stringify({ sessionId: "claude-session-missing", code: PASTED_CODE }))).status, 404);

  const accepted = await invoke(patch!, "/v1/provider-auth", JSON.stringify({ sessionId, code: PASTED_CODE }));
  assert.equal(accepted.status, 200);
  bodies.push(accepted.body);
  const final = JSON.parse(accepted.body) as ProviderAuthProjection;
  assert.equal(final.state, "complete", final.reason);
  const replay = await invoke(patch!, "/v1/provider-auth", JSON.stringify({ sessionId, code: PASTED_CODE }));
  assert.equal(replay.status, 409);
  bodies.push(replay.body);
  bodies.push((await invoke(get!, `/v1/provider-auth?sessionId=${sessionId}`)).body);

  assert.deepEqual(Object.keys(final).sort(), ["accountLabel", "authUrl", "expiresAt", "label", "profileId", "provider", "sessionId", "state", "version"]);
  const everything = bodies.join("\n");
  for (const secret of [PASTED_CODE, "pasted-code", NEW_ACCESS, NEW_REFRESH, OLD_ACCESS, HOST_ACCESS, ACCOUNT_EMAIL, f.realHome, "fleet-auth", ".credentials", ".claude-login-", "Login successful"]) {
    assert.ok(!everything.includes(secret), `a projection carried ${secret}`);
  }
  assert.match(readFileSync(f.storeFile, "utf8"), new RegExp(NEW_ACCESS), "the flow really completed");
});

test("W1-T10380: every Claude start that cannot run the CLI ends without a path and without a staging dir", async (t) => {
  const f = fixture(t);
  const refused = new ProviderAuthSessionStore({
    profiles: [{ id: "claude-fleet", provider: "claude", label: "Fleet Claude" }],
    claudeRealHome: f.realHome,
    resolveClaudeBin: () => { throw new Error(`claude executable not found — searched: ${f.realHome}/bin/claude`); },
  });
  const unresolved = await refused.start({ provider: "claude", profileId: "claude-fleet" });
  assert.equal(unresolved.state, "unavailable");
  assert.ok(!JSON.stringify(unresolved).includes(f.realHome), "the resolver's searched paths never reach the projection");

  const spawnThrows = storeFor(f, "usable", { spawn: () => { throw new Error(`spawn ${f.realHome}/claude ENOENT`); } });
  const unspawned = await spawnThrows.start({ provider: "claude", profileId: "claude-fleet" });
  assert.equal(unspawned.state, "unavailable");
  assert.ok(!JSON.stringify(unspawned).includes(f.realHome));
  assert.deepEqual(stagingDirs(f), [], "a failed spawn removes its staging dir");

  // The real binary emits `error` (here: an unexecutable path) instead of exiting.
  const missing = new ProviderAuthSessionStore({
    profiles: [{ id: "claude-fleet", provider: "claude", label: "Fleet Claude" }],
    claudeRealHome: f.realHome,
    resolveClaudeBin: () => join(f.realHome, "no-such-claude"),
  });
  const errored = await missing.start({ provider: "claude", profileId: "claude-fleet" });
  const settled = await untilSettled(missing, errored.sessionId);
  assert.equal(settled.state, "failed");
  assert.deepEqual(stagingDirs(f), []);
  assert.deepEqual(readFileSync(f.storeFile), f.oldStore);
});

test("W1-T10380: a cancelled Claude login, or a store write that throws, ends the session and keeps the store", async (t) => {
  const f = fixture(t);
  const store = storeFor(f, "usable");
  const started = await store.start({ provider: "claude", profileId: "claude-fleet" });
  await untilAuthUrl(store, started.sessionId);
  assert.equal((await store.submitCode(started.sessionId, "")).outcome, "invalid");
  const cancelled = store.cancel(started.sessionId);
  assert.equal(cancelled?.state, "cancelled");
  assert.equal((await store.submitCode(started.sessionId, PASTED_CODE)).outcome, "conflict");

  const throwing = storeFor(f, "usable", { replaceClaudeStore: async () => { throw new Error("EIO"); } });
  const second = await throwing.start({ provider: "claude", profileId: "claude-fleet" });
  await untilAuthUrl(throwing, second.sessionId);
  await throwing.submitCode(second.sessionId, PASTED_CODE);
  const failed = await untilSettled(throwing, second.sessionId);
  assert.equal(failed.state, "failed");
  assert.match(failed.reason ?? "", /fleet-store-write-failed/);
  assert.deepEqual(readFileSync(f.storeFile), f.oldStore);
  assert.deepEqual(stagingDirs(f), []);

  // A replacement whose session ended under the lock writes nothing.
  const stagedDir = join(f.realHome, ".claude", "fleet-auth", ".claude-login-manual");
  mkdirSync(stagedDir, { mode: 0o700 });
  writeFileSync(join(stagedDir, ".credentials.json"), credential(NEW_ACCESS, NEW_REFRESH));
  const ended = await replaceClaudeFleetCredential({ realHome: f.realHome, stagingDir: stagedDir, proceed: () => false });
  assert.deepEqual(ended, { kind: "refused", reasonClass: "login-session-ended" });
  assert.deepEqual(readFileSync(f.storeFile), f.oldStore);
  assert.deepEqual(readdirSync(join(f.realHome, ".claude", "fleet-auth", "claude")), [".credentials.json"]);
});
