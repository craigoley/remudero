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
  echo 'No managed identity found' >&2; exit 1
fi
if [ "$AZURE_CONFIG_DIR" = "$STORED_CONFIG" ]; then
  [ "$STORED" = ok ] && exit 0
  echo 'AADSTS700082: stored session expired' >&2; exit 2
fi
[ "$MANAGED" = ok ] && exit 0
echo 'DENIED: requested access to the resource is denied' >&2; exit 3
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

test("W1-T12177 criterion 5: both failure reasons survive without tokens", (t) => {
  const f = fixture(t, "absent", "ok", "expired");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(f.record().reason, /managed identity.*unavailable/i);
  assert.match(f.record().reason, /stored login.*expired/i);
  assert.doesNotMatch(f.record().reason, /AcrPull/);
  assert.equal(f.deploy(), undefined);
  assert.equal(f.rows[0]!.outcome, "failed");
  assert.equal(f.rows[0]!.reason, f.record().reason);
  assert.ok(!JSON.stringify([f.record(), f.rows, result.stdout, result.stderr]).includes(secret));
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
