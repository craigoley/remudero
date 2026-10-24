import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { readAccountUsageFile, redactedAccountLabel } from "#src/lib/account-usage.js";
import { ProviderAuthSessionStore, type ProviderAuthSessionDeps } from "#src/lib/provider-auth-sessions.js";
import { CLAUDE_REFRESH_LOCK_NAME, replaceClaudeFleetCredential } from "#src/lib/worker-home.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const oldAccount = {
  accountUuid: "old-uuid", emailAddress: "alexsmith@example.com", userRateLimitTier: "old-tier",
  organizationUuid: "old-org", legacyTierOnly: "must-not-survive",
};
const newAccount = {
  accountUuid: "new-uuid", emailAddress: "alexsmithwork@example.com", userRateLimitTier: "new-tier",
  organizationUuid: "new-org", billingType: "new-billing",
};
const credential = JSON.stringify({
  claudeAiOauth: { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() + 3_600_000 },
});
const retainedConfig = {
  projects: { "/fixture/project": { history: ["one", "two"], trusted: true } },
  cachedUsageUtilization: { accountUuid: "old-uuid", fetchedAtMs: 123 },
  hasCompletedOnboarding: true, settings: { theme: "dark", count: 2 },
};

function fixture(t: TestContext) {
  const realHome = join(ownedFixtureDir(t, "w1-t10512").dir, "home");
  const store = join(realHome, ".claude", "fleet-auth", "claude");
  const stagingDir = join(realHome, ".claude", "fleet-auth", ".claude-login-fixture");
  mkdirSync(store, { recursive: true });
  mkdirSync(stagingDir);
  const config = join(store, ".claude.json");
  const originalConfig = JSON.stringify({ ...retainedConfig, oauthAccount: oldAccount }, null, 2) + "\n";
  writeFileSync(config, originalConfig);
  writeFileSync(join(store, ".credentials.json"), "old-credential");
  writeFileSync(join(stagingDir, ".credentials.json"), credential);
  writeFileSync(join(stagingDir, ".claude.json"), JSON.stringify({ oauthAccount: newAccount, projects: { staged: true } }));
  const hostConfig = join(realHome, ".claude.json");
  const hostCredential = join(realHome, ".claude", ".credentials.json");
  writeFileSync(hostConfig, "host-config-must-not-change");
  writeFileSync(hostCredential, "host-credential-must-not-change");
  return { realHome, store, stagingDir, config, originalConfig, hostConfig, hostCredential };
}

async function login(f: ReturnType<typeof fixture>, stagedConfig: string | undefined) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
  });
  let stagingDir = "";
  const store = new ProviderAuthSessionStore({
    profiles: [{ id: "fleet", provider: "claude", label: "Fleet" }],
    claudeRealHome: f.realHome,
    resolveClaudeBin: () => "fixture-claude",
    spawn: (_command, _args, options) => {
      stagingDir = options.env.CLAUDE_CONFIG_DIR!;
      child.stdin.once("data", () => {
        writeFileSync(join(stagingDir, ".credentials.json"), credential);
        if (stagedConfig !== undefined) writeFileSync(join(stagingDir, ".claude.json"), stagedConfig);
        queueMicrotask(() => child.emit("exit", 0));
      });
      return child as unknown as ReturnType<NonNullable<ProviderAuthSessionDeps["spawn"]>>;
    },
  });
  const started = await store.start({ provider: "claude", profileId: "fleet" });
  assert.equal(started.state, "awaiting_browser");
  child.stdout.write("https://claude.com/cai/oauth/authorize?state=fixture\n");
  const result = await store.submitCode(started.sessionId, "fixture-code#state");
  assert.equal(result.outcome, "accepted");
  assert.ok("projection" in result);
  assert.equal(result.projection.state, "complete", result.projection.reason);
  assert.equal(existsSync(stagingDir), false);
  return result.projection;
}

test("W1-T10512: a console Claude swap carries the new account into the fleet store and keeps the rest of its config", async (t) => {
  const f = fixture(t);
  const beforeIdentity = String.raw`{
  "projects": {"/fixture/project": {"history": ["one", "two"], "trusted": true}},
  "cachedUsageUtilization": {"accountUuid": "old-uuid", "fetchedAtMs": 123},
  "hasCompletedOnboarding": true, "settings": {"theme": "dark", "count": 2},
  "escaped": "\u0061 \"oauthAccount\": { } [ ] , : \\ \"quoted\"",
  "large": 9007199254740993, "exponent": 1.2300e+42, "negativeZero": -0,
  "nested": [{"oauthAccount": {"keep": true}}, ["}", "[", "\\"]],
  "oauth\u0041ccount" : `;
  const afterIdentity = '\r\n, "tail": "\\u007a"\r\n}\n';
  f.originalConfig = beforeIdentity + JSON.stringify(oldAccount, null, 4) + afterIdentity;
  writeFileSync(f.config, f.originalConfig);
  const locks = [join(f.store, CLAUDE_REFRESH_LOCK_NAME), `${f.store}.lock`];
  const rename = fs.renameSync;
  let identityWrites = 0;
  const writes = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (to === f.config) {
      identityWrites++;
      assert.ok(locks.every((lock) => existsSync(lock)), "the identity rename holds both locks too");
      assert.equal(statSync(from).mode & 0o777, 0o600);
      assert.equal(readFileSync(join(f.store, ".credentials.json"), "utf8"), credential);
    }
    rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { writes.mock.restore(); syncBuiltinESMExports(); });
  const result = await replaceClaudeFleetCredential({
    ...f,
    proceed: () => {
      assert.ok(locks.every((lock) => existsSync(lock)), "both refresh locks surround the swap");
      assert.equal(readFileSync(f.config, "utf8"), f.originalConfig);
      return true;
    },
  });
  assert.equal(readFileSync(f.config, "utf8"), beforeIdentity + JSON.stringify(newAccount) + afterIdentity,
    "only the top-level identity value may change; retain number literals, escapes and whitespace");
  const carried = JSON.parse(readFileSync(f.config, "utf8"));
  assert.deepEqual(carried, { ...JSON.parse(f.originalConfig), oauthAccount: newAccount });
  assert.equal(readAccountUsageFile(f.config).uuid, newAccount.accountUuid);
  assert.ok(result.kind === "replaced");
  assert.equal(result.identity, "carried");
  assert.equal(statSync(f.config).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(f.store, ".credentials.json"), "utf8"), credential);
  assert.deepEqual(readdirSync(f.store).sort(), [".claude.json", ".credentials.json"]);
  assert.ok(locks.every((lock) => !existsSync(lock)));
  assert.equal(readFileSync(f.hostConfig, "utf8"), "host-config-must-not-change");
  assert.equal(readFileSync(f.hostCredential, "utf8"), "host-credential-must-not-change");

  rmSync(f.config);
  const created = await replaceClaudeFleetCredential(f);
  assert.ok(created.kind === "replaced");
  assert.equal(created.identity, "carried");
  assert.deepEqual(JSON.parse(readFileSync(f.config, "utf8")), { oauthAccount: newAccount });
  assert.equal(identityWrites, 2);
});

test("W1-T10512: identity splicing preserves surrounding bytes for every old value shape", async (t) => {
  const replacement = JSON.stringify(newAccount);
  const cases = [
    ...['{"old": {"nested": [1, {"key": "value"}]}}', '["}", {"oauthAccount": "nested"}]',
      '"old \\"quoted\\" value"', "false", "null", "9007199254740993"]
      .map((value) => ({
        before: ` \r\n{ "oauthAccount" : ${value} , "keep": "\\u0061 🐈", "large": 9007199254740993 }\n`,
        after: ` \r\n{ "oauthAccount" : ${replacement} , "keep": "\\u0061 🐈", "large": 9007199254740993 }\n`,
      })),
    { before: '{ "oauthAccount": null, "oauth\\u0041ccount": [] }\n',
      after: `{ "oauthAccount": ${replacement}, "oauth\\u0041ccount": ${replacement} }\n` },
    { before: " \r\n{ \t }\n", after: ` \r\n{ \t "oauthAccount":${replacement}}\n` },
    { before: '{ "nested": {"oauthAccount": 1}, "large": 9007199254740993 \n}\n',
      after: `{ "nested": {"oauthAccount": 1}, "large": 9007199254740993 \n,"oauthAccount":${replacement}}\n` },
  ];
  for (const [index, c] of cases.entries()) {
    await t.test(`W1-T10512: raw config variant ${index}`, async (t) => {
      const f = fixture(t);
      writeFileSync(f.config, c.before);
      const result = await replaceClaudeFleetCredential(f);
      assert.equal(result.kind, "replaced");
      assert.equal(Reflect.get(result, "identity"), "carried");
      assert.deepEqual(readFileSync(f.config), Buffer.from(c.after));
      assert.deepEqual(JSON.parse(readFileSync(f.config, "utf8")).oauthAccount, newAccount);
    });
  }
});

test("W1-T10512: a swap that cannot carry the identity leaves the store config byte-identical and says so", async (t) => {
  const cases = [
    { name: "absent staged file", staged: undefined, store: undefined, identity: "staged-identity-missing" },
    ...["{", "null", "[]", "{}", '{"oauthAccount":null}', '{"oauthAccount":[]}', '{"oauthAccount":"wrong"}']
      .map((staged) => ({ name: `staged ${staged}`, staged, store: undefined, identity: "staged-identity-missing" })),
    ...["{broken\n", "null", "[]", '"scalar"']
      .map((store) => ({ name: `store ${store.trim()}`, staged: JSON.stringify({ oauthAccount: newAccount }), store, identity: "store-config-unreadable" })),
  ];
  for (const c of cases) {
    await t.test(`W1-T10512: ${c.name}`, async (t) => {
      const f = fixture(t);
      if (c.store !== undefined) writeFileSync(f.config, c.store);
      const before = readFileSync(f.config);
      if (c.staged === undefined) rmSync(join(f.stagingDir, ".claude.json"));
      else writeFileSync(join(f.stagingDir, ".claude.json"), c.staged);
      const result = await replaceClaudeFleetCredential(f);
      assert.equal(result.kind, "replaced");
      assert.equal(Reflect.get(result, "identity"), c.identity);
      assert.deepEqual(readFileSync(f.config), before);
      assert.equal(readFileSync(join(f.store, ".credentials.json"), "utf8"), credential);

      const log = t.mock.method(console, "error", () => undefined);
      const completed = await login(f, c.staged);
      assert.deepEqual(readFileSync(f.config), before);
      assert.ok(log.mock.calls.some((call) => call.arguments.some((arg) => String(arg).includes(c.identity))));
      assert.equal(completed.accountLabel, c.store === undefined ? "al***th@example.com" : undefined);
    });
  }
  await t.test("W1-T10512: an identity write failure retains the swapped credential and reports the partial outcome", async (t) => {
    const f = fixture(t);
    const rename = fs.renameSync;
    const writes = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (to === f.config) throw Object.assign(new Error("fixture identity rename failed"), { code: "EIO" });
      rename(from, to);
    });
    syncBuiltinESMExports();
    t.after(() => { writes.mock.restore(); syncBuiltinESMExports(); });
    const result = await replaceClaudeFleetCredential(f);
    assert.equal(result.kind, "replaced");
    assert.equal(Reflect.get(result, "identity"), "store-config-write-failed");
    assert.equal(readFileSync(f.config, "utf8"), f.originalConfig);
    assert.equal(readFileSync(join(f.store, ".credentials.json"), "utf8"), credential);
    assert.deepEqual(readdirSync(f.store).sort(), [".claude.json", ".credentials.json"]);
    assert.equal(existsSync(`${f.store}.lock`), false);
    const log = t.mock.method(console, "error", () => undefined);
    const completed = await login(f, JSON.stringify({ oauthAccount: newAccount }));
    assert.equal(completed.accountLabel, "al***th@example.com");
    assert.ok(log.mock.calls.some((call) => call.arguments.some((arg) => String(arg).includes("store-config-write-failed"))));
  });
});

test("W1-T10512: a completed Claude login labels two accounts with one initial and one domain apart", async (t) => {
  const labels: string[] = [];
  const log = t.mock.method(console, "error", () => undefined);
  for (const account of [oldAccount, newAccount]) {
    const f = fixture(t);
    f.originalConfig = JSON.stringify({ ...retainedConfig, cachedUsageUtilization: null, oauthAccount: oldAccount }) + "\n";
    writeFileSync(f.config, f.originalConfig);
    const done = await login(f, JSON.stringify({ oauthAccount: account }));
    assert.equal(readFileSync(f.config, "utf8"), f.originalConfig.replace(JSON.stringify(oldAccount), JSON.stringify(account)));
    assert.equal(readFileSync(join(f.store, ".credentials.json"), "utf8"), credential);
    assert.deepEqual(readdirSync(f.store).sort(), [".claude.json", ".credentials.json"]);
    assert.equal(existsSync(`${f.store}.lock`), false);
    labels.push(done.accountLabel!);
    assert.equal(done.accountLabel, redactedAccountLabel(readAccountUsageFile(f.config)));
    assert.ok(!JSON.stringify(done).includes(account.emailAddress));
    assert.ok(!JSON.stringify(done).includes(f.realHome));
    assert.ok(!JSON.stringify(done).includes("fixture-access"));
  }
  assert.deepEqual(labels, ["al***th@example.com", "al***rk@example.com"]);
  assert.ok(log.mock.calls.some((call) => call.arguments.some((arg) => String(arg).includes("carried"))));
});
