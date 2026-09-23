import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { operatorIdentityConfig } from "../src/lib/serve.js";
import { OPERATOR_IDENTITY_PATH_ENV, operatorIdentityFromFile, parseOperatorIdentity } from "../src/lib/operator-identity-file.js";

const FILE_IDENTITY = {
  issuer: "https://clerk.example.test",
  allowedOrigins: ["https://console.example.test"],
  operatorUserIds: ["user_file"],
};
const CONFIG_IDENTITY = {
  issuer: "https://config.example.test",
  allowedOrigins: ["https://config-console.example.test"],
  operatorUserIds: ["user_config"],
};

function withIdentityFile<T>(body: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "rmd-operator-identity-"));
  try {
    const path = join(dir, "operator-identity.json");
    writeFileSync(path, body);
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function recorder() {
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { lines, log: (step: string, extra?: Record<string, unknown>) => lines.push({ step, extra }) };
}

test("an operator identity file supplies the identity when config has none", () => {
  const full = { ...FILE_IDENTITY, jwksUrl: "https://clerk.example.test/keys", stepUpWindowMinutes: 5 };
  withIdentityFile(JSON.stringify(full), (path) => {
    const { lines, log } = recorder();
    assert.deepEqual(operatorIdentityConfig(() => ({}), { path, log }), full);
    assert.deepEqual(lines, [{ step: "serve.operator_identity_file_loaded", extra: { path, operators: 1 } }]);
    // An unreadable config.json also falls through to the file rather than turning identity off.
    const unreadable = () => {
      throw new Error("config unreadable");
    };
    assert.deepEqual(operatorIdentityConfig(unreadable, { path }), full);
    // The production default names the file through the env var the launcher sets.
    const before = process.env[OPERATOR_IDENTITY_PATH_ENV];
    process.env[OPERATOR_IDENTITY_PATH_ENV] = path;
    try {
      assert.deepEqual(operatorIdentityFromFile(), full);
    } finally {
      if (before === undefined) delete process.env[OPERATOR_IDENTITY_PATH_ENV];
      else process.env[OPERATOR_IDENTITY_PATH_ENV] = before;
    }
  });
  // No path configured at all: identity off and nothing logged.
  const { lines, log } = recorder();
  assert.equal(operatorIdentityFromFile({ path: "", log }), undefined);
  assert.deepEqual(lines, []);
});

test("config's own operator identity wins over the file", () => {
  withIdentityFile(JSON.stringify(FILE_IDENTITY), (path) => {
    const { lines, log } = recorder();
    assert.deepEqual(operatorIdentityConfig(() => ({ serve: { operatorIdentity: CONFIG_IDENTITY } }), { path, log }), CONFIG_IDENTITY);
    assert.deepEqual(lines, [], "the file is not even read when config carries the identity");
  });
});

test("an invalid operator identity file leaves identity off with the reason", () => {
  const cases: Array<[string, string]> = [
    ["{not json", "not_json"],
    ["[]", "not_an_object"],
    [JSON.stringify({ ...FILE_IDENTITY, issuer: "http://clerk.example.test" }), "issuer_not_https_url"],
    [JSON.stringify({ ...FILE_IDENTITY, issuer: "not a url" }), "issuer_not_https_url"],
    [JSON.stringify({ ...FILE_IDENTITY, issuer: 7 }), "issuer_not_https_url"],
    [JSON.stringify({ ...FILE_IDENTITY, allowedOrigins: [] }), "allowed_origins_empty_or_not_strings"],
    [JSON.stringify({ ...FILE_IDENTITY, allowedOrigins: ["ok", 3] }), "allowed_origins_empty_or_not_strings"],
    [JSON.stringify({ ...FILE_IDENTITY, operatorUserIds: [" "] }), "operator_user_ids_empty_or_not_strings"],
    [JSON.stringify({ ...FILE_IDENTITY, jwksUrl: "ftp://x" }), "jwks_url_not_https_url"],
    [JSON.stringify({ ...FILE_IDENTITY, stepUpWindowMinutes: 0 }), "step_up_window_not_positive_number"],
    [JSON.stringify({ ...FILE_IDENTITY, stepUpWindowMinutes: "5" }), "step_up_window_not_positive_number"],
  ];
  for (const [body, reason] of cases) {
    const { lines, log } = recorder();
    const got = operatorIdentityConfig(() => ({}), { path: "/fake/identity.json", readFile: () => body, log });
    assert.equal(got, undefined, `${reason}: no partial config`);
    assert.equal(lines.length, 1, reason);
    assert.equal(lines[0]!.step, "serve.operator_identity_file_invalid");
    assert.ok(String(lines[0]!.extra?.reason).startsWith(reason), `${String(lines[0]!.extra?.reason)} names ${reason}`);
  }
  assert.ok("reason" in parseOperatorIdentity("null"));
  // A named file that is missing is logged by reason too, through the real default reader.
  const { lines, log } = recorder();
  const missing = join(tmpdir(), "rmd-operator-identity-definitely-absent.json");
  assert.equal(operatorIdentityConfig(() => ({}), { path: missing, log }), undefined);
  assert.deepEqual(lines, [{ step: "serve.operator_identity_file_invalid", extra: { path: missing, reason: "unreadable: ENOENT" } }]);
  // A reader error with no errno code still carries its message.
  const bare = recorder();
  const thrower = () => {
    throw new Error("boom");
  };
  assert.equal(operatorIdentityFromFile({ path: "/x", readFile: thrower, log: bare.log }), undefined);
  assert.equal(bare.lines[0]!.extra?.reason, "unreadable: boom");
});
