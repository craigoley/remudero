import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { inspect } from "node:util";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { mintInstallationToken, refreshInstallationToken, REFRESH_MARGIN_MS, TOKEN_REFRESHED_STEP } from "#src/lib/github-app.js";
import { GITHUB_CREDENTIAL_REFERENCES_FILENAME, githubAppReferenceKey, installGithubAppTokenHolder,
  parseGithubCredentialReferences, resolveGithubCredential, type GithubCredentialReference } from "#src/lib/github-credential.js";
import { defaultGhUpstreamExec, GhReadBroker, ghBrokerCommand, summariseGhBrokerLog,
  type GhBrokerCredentialOptions, type GhUpstreamExec } from "#src/lib/gh-read-broker.js";
import { ghBrokerDir, GH_BROKER_HEARTBEAT, GH_BROKER_SOCKET } from "#src/lib/gh-read-broker-client.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const TOKEN = "invented-installation-secret";
const FALLBACK = "invented-ambient-secret";
const repo = "acme/widgets";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-hand-app-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const env = { HOME: root, GH_CONFIG_DIR: join(root, "gh"), PATH: process.env.PATH, GH_TOKEN: FALLBACK };
  const reference: GithubCredentialReference = { scope: "*", kind: "app", name: "host-reader", reads_only: true,
    app_id: "123", installation_id: "456", private_key_path: join(root, "app.pem") };
  const write = (references: GithubCredentialReference[]) => writeFileSync(join(stateDir, GITHUB_CREDENTIAL_REFERENCES_FILENAME), JSON.stringify({ references }));
  write([reference]);
  let now = Date.now();
  const clock = clockFromMillisFn(() => now);
  const timers: Array<{ fn: () => void; ms: number; unref(): void }> = [];
  const cleared: unknown[] = [];
  const options: GhBrokerCredentialOptions = { env, stateDir, host: "fixture-host",
    mint: async () => ({ ok: true, token: TOKEN, expiresAtMs: now + 3_600_000 }),
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    clearTimer: (timer) => { cleared.push(timer); } };
  const calls: Array<{ args: string[]; token: string | undefined }> = [];
  const exec: GhUpstreamExec = async (args, opts) => {
    calls.push({ args, token: opts.credential?.childEnv(opts.env)?.GH_TOKEN ?? opts.env?.GH_TOKEN });
    return { exitCode: 0, stderr: "", stdout: args.includes("user") ? "operator" :
      "HTTP/2.0 200 OK\r\ncache-control: max-age=60\r\nx-ratelimit-remaining: 4900\r\nx-ratelimit-reset: 2000000000\r\n\r\n{}" };
  };
  const makeBroker = (extra: GhBrokerCredentialOptions = {}, executor = exec,
    sleep: (ms: number) => Promise<void> = async (ms) => { now += ms; }) => {
    const broker = new GhReadBroker(join(root, `broker-${Math.random().toString(16).slice(2)}`), executor, clock,
      sleep, () => 10_000_000, { sharedPaceRoot: null, ...options, ...extra });
    t.after(() => broker.stopCredentials());
    return broker;
  };
  const query = (broker: GhReadBroker, write = false) => resolveGithubCredential({ env, stateDir, repo, write, clock, appTokens: broker.appTokens });
  return { root, stateDir, reference, env, options, timers, cleared, calls, exec, write, makeBroker, query,
    now: () => now, advance: (ms: number) => { now += ms; } };
}

function read(broker: GhReadBroker, endpoint = `repos/${repo}/pulls`) {
  return broker.read({ op: "read", args: ["api", endpoint], class: "interactive", caller: "test" });
}

function allFiles(dir: string): string {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => entry.isDirectory()
    ? allFiles(join(dir, entry.name)) : readFileSync(join(dir, entry.name), "utf8")).join("\n");
}

test("W1-T12188 criterion 1: an App reference resolves to the held token and names its source", async (t) => {
  const f = fixture(t);
  assert.deepEqual(parseGithubCredentialReferences(JSON.stringify({ references: [f.reference] })), [f.reference]);
  for (const extra of [{ app_id: 123 }, { installation_id: "wrong" }, { private_key_path: "relative.pem" }, { reads_only: "yes" }]) {
    assert.throws(() => parseGithubCredentialReferences(JSON.stringify({ references: [{ ...f.reference, ...extra }] })), /references entry 1/);
  }
  const broker = f.makeBroker();
  await broker.startCredentials();
  const answer = f.query(broker);
  assert.equal(answer.source, "remudero-reference");
  assert.equal(answer.reference, "host-reader");
  assert.equal(answer.kind, "app");
  assert.equal(answer.childEnv({})?.GH_TOKEN, TOKEN);
  assert.ok(!inspect(answer, { showHidden: true }).includes(TOKEN));
  f.write([{ ...f.reference, scope: repo }]);
  assert.equal(f.query(broker).source, "ambient-env", "an edited reference cannot reuse a different scope's holder entry");
  assert.notEqual(githubAppReferenceKey(f.reference), githubAppReferenceKey({ ...f.reference, installation_id: "999" }));
});

test("W1-T12188 criterion 2: startup mints, renewal precedes expiry, and secrets remain in memory", async (t) => {
  const f = fixture(t);
  let minted = 0;
  const broker = f.makeBroker({ mint: async (config) => {
    assert.deepEqual(config, { appId: "123", installationId: "456", privateKeyPath: f.reference.private_key_path });
    return { ok: true, token: `${TOKEN}-${++minted}`, expiresAtMs: f.now() + 3_600_000 };
  } });
  await broker.startCredentials();
  assert.equal(minted, 1);
  assert.equal(f.timers[0].ms, 3_600_000 - REFRESH_MARGIN_MS);
  await read(broker);
  assert.equal(f.calls[0].token, `${TOKEN}-1`);
  assert.ok(!f.calls.some((c) => c.args.includes("user")), "installation reads never probe the user-only endpoint");
  f.advance(f.timers[0].ms);
  f.timers[0].fn();
  for (let i = 0; i < 10 && f.timers.length < 2; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(minted, 2);
  assert.equal(f.query(broker).childEnv({})?.GH_TOKEN, `${TOKEN}-2`);
  assert.equal(f.env.GH_TOKEN, FALLBACK);
  const evidence = `${allFiles(broker.dir)} ${inspect(broker, { depth: null })} ${JSON.stringify(f.calls.map((c) => c.args))}`;
  assert.ok(!evidence.includes(TOKEN));
  broker.stopCredentials();
  assert.equal(f.cleared.length, 1);
  assert.equal(f.query(broker).source, "ambient-env");
});

test("W1-T12188 criterion 2: the App module mints with explicit config and never changes GH_TOKEN", async (t) => {
  const f = fixture(t);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  writeFileSync(f.reference.private_key_path!, privateKey, { mode: 0o600 });
  const original = process.env.GH_TOKEN;
  const logs: unknown[] = [];
  let calls = 0;
  const result = await mintInstallationToken({ appId: "123", installationId: "456", privateKeyPath: f.reference.private_key_path! }, {
    fetchImpl: async (url, opts) => {
      calls++;
      assert.equal(String(url), "https://api.github.com/app/installations/456/access_tokens");
      assert.equal(opts?.method, "POST");
      assert.match((opts?.headers as Record<string, string>).Authorization, /^Bearer /);
      return new Response(JSON.stringify({ token: TOKEN, expires_at: new Date(f.now() + 3_600_000).toISOString() }));
    }, log: (step, extra) => { logs.push({ step, extra }); },
  });
  assert.equal(calls, 1);
  assert.equal(result.token, TOKEN);
  assert.equal(process.env.GH_TOKEN, original);
  assert.ok(!JSON.stringify(logs).includes(TOKEN));
  assert.ok(!JSON.stringify(logs).includes(privateKey));
  const env = { GH_TOKEN: FALLBACK };
  await assert.rejects(refreshInstallationToken({ appId: "123", installationId: "456",
    privateKeyPath: f.reference.private_key_path, env,
    fetchImpl: async () => new Response(JSON.stringify({ token: TOKEN, expires_at: new Date(f.now() + 3_600_000).toISOString() })),
    log: (step) => {
      if (step === TOKEN_REFRESHED_STEP) {
        assert.equal(env.GH_TOKEN, TOKEN, "the daemon publishes before notifying its logger");
        throw new Error("logger failed");
      }
    },
  }), /logger failed/);
  assert.equal(env.GH_TOKEN, TOKEN, "a logger failure preserves the daemon's refreshed token");
});

test("W1-T12188 criterion 3: unreadable keys and failed mints name the cause and allow fallback reads", async (t) => {
  const f = fixture(t);
  for (const mint of [undefined, async () => ({ ok: false, reason: "exchange rejected: 403" }), async () => { throw new Error(TOKEN); }]) {
    const broker = f.makeBroker({ mint });
    await broker.startCredentials();
    const answer = f.query(broker);
    assert.equal(answer.source, "ambient-env");
    assert.match(answer.tried[1].reason, /host-reader.*(private key unreadable|exchange rejected: 403|App mint threw)/);
    assert.ok(!JSON.stringify(answer).includes(TOKEN));
    assert.equal((await read(broker)).exitCode, 0);
    assert.equal(f.calls.at(-1)?.token, FALLBACK);
  }
});

test("W1-T12188 criterion 3: a failed renewal falls back and a successful retry recovers", async (t) => {
  const f = fixture(t);
  let attempt = 0;
  const broker = f.makeBroker({ mint: async () => ++attempt === 2
    ? { ok: false, reason: "exchange rejected: 503" }
    : { ok: true, token: TOKEN, expiresAtMs: f.now() + 3_600_000 } });
  await broker.startCredentials();
  for (const expected of ["ambient-env", "remudero-reference"]) {
    const timer = f.timers.at(-1)!;
    f.advance(timer.ms);
    timer.fn();
    for (let i = 0; i < 10 && f.timers.at(-1) === timer; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.query(broker).source, expected);
    assert.equal((await read(broker)).exitCode, 0);
  }
  f.advance(3_600_001);
  assert.match(f.query(broker).tried[1].reason, /expired/);
});

test("W1-T12188 criterion 3: a credential change while queued reroutes without deadlocking or double counting", { timeout: 10_000 }, async (t) => {
  const f = fixture(t);
  const env = { ...f.env, SECOND_TOKEN: "other-fallback" };
  f.write([f.reference, { scope: "*", kind: "env", name: "SECOND_TOKEN" }]);
  let changed = false;
  const broker = f.makeBroker({ env, mint: async () => ({ ok: false, reason: "private key unreadable" }) }, f.exec, async (ms) => {
    f.advance(ms);
    f.write([f.reference]);
    changed = true;
  });
  await read(broker);
  await read(broker, `repos/${repo}/issues`);
  assert.equal(changed, true, "the second read really waited with the old credential selected");
  assert.deepEqual(f.calls.filter((c) => !c.args.includes("user")).map((c) => c.token), ["other-fallback", FALLBACK]);
  assert.equal(summariseGhBrokerLog(broker.dir, 0).reads, 2);
});

test("W1-T12188 criterion 2: stopping during a mint cannot repopulate the holder", async (t) => {
  const f = fixture(t);
  let complete!: (value: { ok: boolean; token: string; expiresAtMs: number }) => void;
  const broker = f.makeBroker({ mint: () => new Promise((resolve) => { complete = resolve; }) });
  const ready = broker.startCredentials();
  await new Promise<void>((resolve) => setImmediate(resolve));
  broker.stopCredentials();
  complete({ ok: true, token: TOKEN, expiresAtMs: f.now() + 3_600_000 });
  await ready;
  assert.equal(f.query(broker).source, "ambient-env");
  assert.equal(f.timers.length, 0);
});

test("W1-T12188 criterion 4: a write skips a reads_only App even with a held token", async (t) => {
  const f = fixture(t);
  const broker = f.makeBroker();
  await broker.startCredentials();
  installGithubAppTokenHolder(broker.appTokens);
  t.after(() => installGithubAppTokenHolder(undefined));
  const write = resolveGithubCredential({ env: f.env, stateDir: f.stateDir, write: true });
  assert.equal(write.source, "ambient-env");
  assert.equal(write.childEnv(f.env)?.GH_TOKEN, FALLBACK);
  assert.match(write.tried[1].reason, /reads only/);
  assert.equal(resolveGithubCredential({ env: f.env, stateDir: f.stateDir }).source, "ambient-env", "unclassified calls cannot borrow a read token");
  assert.equal((await broker.read({ op: "read", args: ["pr", "merge", "1"], caller: "test", class: "interactive" })).exitCode, 2);
  assert.equal(f.calls.length, 0);
});

test("W1-T12188 criterion 5: every request row attributes the source, reference and host without values", async (t) => {
  const f = fixture(t);
  const broker = f.makeBroker();
  await read(broker);
  await read(broker);
  const text = allFiles(join(broker.dir, "log"));
  const rows = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.filter((r) => r.outcome).length, 2);
  for (const row of rows) {
    assert.equal(row.credential_source, "remudero-reference");
    assert.equal(row.credential_reference, "host-reader");
    assert.equal(row.host, "fixture-host");
  }
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes(FALLBACK));
});

test("W1-T12188 criterion 6: status counts each credential in the window and reuses limit headers", async (t) => {
  const f = fixture(t);
  f.write([{ ...f.reference, scope: repo }, { ...f.reference, scope: "other/widgets", name: "other-reader", installation_id: "789" }]);
  const broker = f.makeBroker();
  await read(broker);
  await read(broker);
  await read(broker, "repos/other/widgets/pulls");
  await broker.read({ op: "read", args: ["api", "graphql", "-f", "query={rateLimit{remaining}}"],
    repo, caller: "test", class: "interactive" });
  assert.equal(broker.pacers.size, 3);
  assert.ok([...broker.pacers.keys()].every((key) => key.startsWith("app:")));
  const before = f.calls.length;
  const summary = summariseGhBrokerLog(broker.dir, f.now() - 60_000);
  const credentials = summary.credentials as Array<{ credential_reference: string; requests: number; limits: unknown }>;
  assert.equal(credentials.length, 2);
  assert.deepEqual(credentials.map((c) => [c.credential_reference, c.requests]), [["host-reader", 3], ["other-reader", 1]]);
  assert.deepEqual(credentials[0].limits, { core: { remaining: 4900, reset_ms: 2_000_000_000_000 },
    graphql: { remaining: 4900, reset_ms: 2_000_000_000_000 } });
  assert.deepEqual(broker.status().credentials, credentials);
  assert.equal(f.calls.length, before);
  assert.deepEqual(summariseGhBrokerLog(broker.dir, f.now() + 1).credentials, []);
  assert.equal(summary.reads, 4, "limit snapshots are not counted as requests");
  const dir = ghBrokerDir(f.env)!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, GH_BROKER_HEARTBEAT), "10\n");
  const shown: string[] = [];
  assert.equal(await ghBrokerCommand(["status", "--since", "1h"], async () => { assert.fail("status cannot start a broker"); },
    f.env, (text) => { shown.push(text); }, undefined, async (socket, message) => {
      assert.equal(socket, join(dir, GH_BROKER_SOCKET));
      assert.equal(message.op, "status");
      return broker.status("sinceMs" in message ? message.sinceMs : undefined);
    }), 0);
  assert.deepEqual(JSON.parse(shown[0]).credentials, credentials);
  assert.equal(f.calls.length, before, "the status command itself makes no upstream call");
});

test("W1-T12188 criterion 7: without an App reference the broker preserves reads and the resolver order", async (t) => {
  const f = fixture(t);
  f.write([{ scope: "*", kind: "env", name: "HAND_TOKEN" }]);
  const env = { ...f.env, HAND_TOKEN: "reference-token" };
  const broker = f.makeBroker({ env, mint: async () => { assert.fail("no App to mint"); } });
  const answer = resolveGithubCredential({ env, stateDir: f.stateDir });
  assert.equal(answer.source, "remudero-reference");
  assert.equal(answer.childEnv({})?.GH_TOKEN, "reference-token");
  assert.equal((await read(broker)).outcome, "upstream-200");
  assert.equal((await read(broker)).outcome, "hit-fresh");
  assert.equal(f.calls.filter((c) => c.args.includes("user")).length, 1);
  assert.equal(f.timers.length, 0);
});

test("W1-T12188 criterion 2: the default broker mint and shutdown use the in-memory holder", async (t) => {
  const f = fixture(t);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  writeFileSync(f.reference.private_key_path!, privateKey, { mode: 0o600 });
  let mints = 0;
  t.mock.method(globalThis, "fetch", async () => {
    mints++;
    return new Response(JSON.stringify({ token: TOKEN, expires_at: new Date(f.now() + 3_600_000).toISOString() }));
  });
  const broker = f.makeBroker({ mint: undefined });
  await broker.startCredentials();
  assert.equal(mints, 1);
  assert.equal(f.query(broker).childEnv({})?.GH_TOKEN, TOKEN);
  assert.equal(broker.status().type, "status");
  assert.equal(mints, 1, "status must not mint");
  broker.stopCredentials();
  assert.equal(f.query(broker).source, "ambient-env");
  assert.equal(f.cleared.length, 1);
});

test("W1-T12188 criterion 1: the default upstream really spawns gh with the selected credential only in its environment", async (t) => {
  const f = fixture(t);
  const shim = ghShim([{ when: "api", stdoutEnv: "GH_TOKEN" }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const broker = f.makeBroker();
  await broker.startCredentials();
  const result = await defaultGhUpstreamExec(["api", `repos/${repo}`], {
    env: { ...f.env, PATH: `${shim.dir}:${f.env.PATH}` }, credential: f.query(broker),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), TOKEN);
  assert.ok(!shim.calls().join("\n").includes(TOKEN));
});
