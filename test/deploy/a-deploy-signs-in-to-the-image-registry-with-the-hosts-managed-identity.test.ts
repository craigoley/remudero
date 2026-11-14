import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { daemonInstanceRegistryPath, realDeployDeps } from "#src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const secret = "secret-access-token-never-publish";
const registry = "fixture-registry";
const helper = join(REPO_ROOT, "deploy/acr-login.sh");

function fixture(t: TestContext, identity = "ok", managed = "ok", stored = "ok") {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}identity-login-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), config = join(root, "stored"), calls = join(root, "calls");
  mkdirSync(bin); mkdirSync(config);
  writeFileSync(join(config, "account"), "person");
  writeFileSync(calls, "");
  writeFileSync(join(bin, "az"), `#!/bin/bash
printf '%s|%s\\n' "$AZURE_CONFIG_DIR" "$*" >> "$CALLS"
printf 'accessToken=%s\\n' "$SECRET"
printf 'Authorization: Bearer %s\\n' "$SECRET" >&2
if [ "$1" = login ]; then
  printf identity > "$AZURE_CONFIG_DIR/account"
  [ "$IDENTITY" = ok ] && exit 0
  if [ "$IDENTITY" = absent ]; then echo 'No managed identity found' >&2
  else printf '%s\\n' "$IDENTITY" >&2; fi
  exit 1
fi
if [ "$AZURE_CONFIG_DIR" = "$STORED_CONFIG" ]; then
  [ "$STORED" = ok ] && exit 0
  if [ "$STORED" = expired ]; then echo 'AADSTS700082: stored session expired' >&2
  else printf '%s\\n' "$STORED" >&2; fi
  exit 2
fi
[ "$MANAGED" = ok ] && exit 0
if [ "$MANAGED" = denied ]; then echo 'DENIED: requested access to the resource is denied' >&2
else printf '%s\\n' "$MANAGED" >&2; fi
exit 3
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, TMPDIR: root,
    AZURE_CONFIG_DIR: config, STORED_CONFIG: config, CALLS: calls, SECRET: secret,
    IDENTITY: identity, MANAGED: managed, STORED: stored, REGISTRY: registry, RMD_ROOT: root };
  const run = () => spawnSync("bash", [helper, "--refresh"], { env, encoding: "utf8", timeout: 10_000 });
  const record = () => JSON.parse(readFileSync(join(root, "state/acr-login.json"), "utf8"));
  const commands = () => readFileSync(calls, "utf8").trim().split("\n").map(line => {
    const [configDir, ...args] = line.split("|"); return { config: configDir!, args: args.join("|") };
  });
  const rows: Array<Record<string, unknown>> = [];
  const transport: { reply?: string | Error; manifestError?: string } = {};
  const registryPath = daemonInstanceRegistryPath(root);
  mkdirSync(join(registryPath, ".."), { recursive: true });
  writeFileSync(registryPath, `instances:\n  fixture:\n    state_dir: ${root}\n    image: ${registry}.azurecr.io/remudero:latest\n`);
  let probes = 0;
  const deps = realDeployDeps({ installPath: root, stateRoot: root, ledgerPath: join(root, "ledger.ndjson"), daemonLabel: "d",
    serveLabel: "s", servePort: 4317, uid: 1,
    execFile: (cmd, args) => {
      if (cmd === "docker") {
        if (++probes === 1) throw new Error("unauthorized");
        if (transport.manifestError) throw new Error(transport.manifestError);
        return "{}";
      }
      assert.equal(cmd, "bash");
      if (transport.reply instanceof Error) throw transport.reply;
      if (transport.reply !== undefined) return transport.reply;
      assert.equal(args[0], join(root, "deploy/acr-login.sh"));
      return execFileSync(cmd, [helper, ...args.slice(1)], { env, encoding: "utf8", timeout: 10_000 });
    }, log: (step, data) => { if (step === "deploy.image_auth_refresh") rows.push(data!); },
  });
  const deploy = () => deps.imagePublished!("a".repeat(40));
  return { root, config, bin, env, run, record, commands, rows, deploy, transport };
}

test("W1-T12177 criterion 1: managed identity runs first in an isolated config", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const calls = f.commands();
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.args, /^login --identity/);
  assert.match(calls[1]!.args, /^acr login -n fixture-registry/);
  assert.equal(calls[0]!.config, calls[1]!.config);
  assert.notEqual(calls[0]!.config, f.config);
  assert.equal(existsSync(calls[0]!.config), false, "temporary credentials are removed");
  assert.equal(readFileSync(join(f.config, "account"), "utf8"), "person");
  assert.equal(f.record().method, "managed-identity");
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
});

test("W1-T12177 criterion 2: no identity falls back to the existing login", (t) => {
  const f = fixture(t, "absent");
  assert.equal(f.run().status, 0);
  assert.match(f.commands()[0]!.args, /^login --identity/);
  assert.equal(f.commands().at(-1)!.config, f.config);
  assert.equal(f.record().method, "stored-login");
  assert.equal(readFileSync(join(f.config, "account"), "utf8"), "person");
});

test("W1-T12177 criterion 3: receipt and deploy row name the successful method", (t) => {
  for (const identity of ["ok", "absent"]) {
    const f = fixture(t, identity);
    assert.equal(f.run().status, 0);
    const expected = identity === "ok" ? "managed-identity" : "stored-login";
    assert.equal(f.record().method, expected);
    assert.equal(f.deploy(), true);
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0]!.method, expected);
    assert.equal(f.rows[0]!.outcome, "recovered");
  }
});

test("W1-T12177 criterion 4: refused registry identity names AcrPull and registry", (t) => {
  const f = fixture(t, "ok", "denied", "expired");
  assert.equal(f.run().status, 1);
  assert.match(f.record().reason, /AcrPull.*fixture-registry/);
  assert.equal(f.commands().length, 3);
  assert.equal(f.deploy(), undefined);
  assert.match(String(f.rows[0]!.reason), /AcrPull.*fixture-registry/);
});

test("W1-T12177 criterion 4: local credential failures do not claim a missing registry role", (t) => {
  for (const failure of ["open /home/person/.docker/config.json: permission denied",
    "error saving credentials: access denied", "permission denied"]) {
    const f = fixture(t, "ok", failure, "expired");
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(f.record().reason, /managed identity registry login failed.*(?:credential store access failed|permission denied)/);
    assert.doesNotMatch(f.record().reason, /AcrPull|registry refused login/);
    assert.equal(f.deploy(), undefined);
    assert.equal(f.rows[0]!.reason, f.record().reason);
    assert.ok(!JSON.stringify([f.record(), f.rows, result.stdout, result.stderr]).includes(secret));
  }
});

test("W1-T12177 criterion 5: both failure reasons survive without tokens", async (t) => {
  const failures: Array<[string, RegExp]> = [
    ["expired", /session expired/],
    ["Failed to resolve registry.azurecr.io: Name or service not known", /DNS name resolution failed/],
    ["NameResolutionError: Temporary failure in name resolution", /DNS name resolution failed/],
    ["getaddrinfo failed", /DNS name resolution failed/],
    ["Could not resolve host: registry.azurecr.io", /DNS name resolution failed/],
    ["ConnectionError: connection reset by peer", /network connection failed/],
    ["ConnectTimeout: connection timed out", /request timed out/],
    ["SSLError: CERTIFICATE_VERIFY_FAILED", /TLS certificate verification failed/],
    ["UNAUTHORIZED: authentication required", /registry refused login/],
    ["Please run 'az login' to setup account", /no Azure session/],
    ["unexpected private diagnostic", /unclassified Azure CLI failure/],
  ];
  for (const [failure, expected] of failures) await t.test(failure, (t) => {
    const f = fixture(t, "absent", "ok", failure);
    const result = f.run();
    assert.equal(result.status, 1, result.stderr);
    assert.equal(f.record().result, "failed");
    assert.equal(f.record().method, "none");
    const reason = f.record().reason;
    assert.match(reason, /managed identity unavailable: no managed identity found/);
    assert.match(reason, new RegExp(`stored login failed.*${expected.source}`));
    assert.doesNotMatch(reason, /AcrPull/);
    assert.ok(result.stderr.includes(reason));
    assert.equal(f.deploy(), undefined);
    assert.equal(f.rows[0]!.outcome, "failed");
    assert.equal(f.rows[0]!.reason, reason);
    assert.equal(f.rows[0]!.method, "none");
    assert.ok(!JSON.stringify([f.record(), f.rows, result.stdout, result.stderr]).includes(secret));
    assert.ok(!reason.includes("unexpected private diagnostic"));
  });
});

test("identity network failures retain their cause without claiming a missing role", (t) => {
  for (const identity of ["ok", "NameResolutionError"]) {
    const f = fixture(t, identity, "ConnectionError: connection refused", "expired");
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(f.record().reason, identity === "ok" ? /managed identity.*network connection failed/ : /managed identity unavailable: DNS name resolution failed/);
    assert.match(f.record().reason, /stored login failed.*session expired/);
    assert.doesNotMatch(f.record().reason, /AcrPull/);
    assert.equal(f.deploy(), undefined);
    assert.equal(f.rows[0]!.reason, f.record().reason);
    assert.ok(!JSON.stringify([f.record(), f.rows, result.stdout, result.stderr]).includes(secret));
  }
});

test("identity timeout falls back without touching stored credentials", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.bin, "timeout"), `#!/bin/bash
printf '%s\\n' "$*" > "$TMPDIR/deadline"
exit 124
`, { mode: 0o755 });
  assert.equal(f.run().status, 0);
  assert.match(readFileSync(join(f.root, "deadline"), "utf8"), /15s az login --identity/);
  assert.equal(f.record().method, "stored-login");
});

test("a refused managed registry can still use the stored login", (t) => {
  const f = fixture(t, "ok", "denied");
  assert.equal(f.run().status, 0);
  assert.equal(f.record().method, "stored-login");
  assert.equal(f.commands().length, 3);
  assert.equal(f.commands().at(-1)!.config, f.config);
});

test("helper transport and malformed results fail closed without leaking their errors", (t) => {
  for (const reply of [new Error(secret), secret, JSON.stringify({ method: secret })]) {
    const f = fixture(t);
    f.transport.reply = reply;
    assert.equal(f.deploy(), undefined);
    assert.equal(f.rows[0]!.outcome, "failed");
    assert.match(String(f.rows[0]!.reason), /helper failed|result was malformed/);
    assert.ok(!JSON.stringify(f.rows).includes(secret));
  }
});

test("the method survives a missing or still unreadable manifest after refresh", (t) => {
  for (const error of ["manifest unknown", "unauthorized"]) {
    const f = fixture(t);
    f.transport.manifestError = error;
    assert.equal(f.deploy(), error === "manifest unknown" ? false : undefined);
    assert.equal(f.rows[0]!.method, "managed-identity");
    assert.equal(f.rows[0]!.outcome, error === "manifest unknown" ? "absent" : "unknown");
  }
});
