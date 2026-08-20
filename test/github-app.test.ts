// test/github-app.test.ts — W1-T1024: THE FLEET AUTHENTICATES AS THE INSTALLED GITHUB APP.
//
// Covers the five unit-test acceptance criteria in plan/tasks.d/W1-T1024-…yaml verbatim:
//   1. a refreshed token reaches a spawned child through the environment without any call site
//      change (buildWorkerEnv — env.ts's own ALLOWLIST — reads whatever this module wrote)
//   2. the jwt is signed in process (crypto.sign) without shelling out to openssl
//   3. a failed exchange leaves the existing static token in place and ledgers a named reason
//   4. no ledger row or log line carries the private key or the token value
//   5. the refresh margin is strictly inside the one hour token life
import assert from "node:assert/strict";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildWorkerEnv } from "../src/lib/env.js";
import {
  INSTALLATION_TOKEN_LIFETIME_MS,
  nextRefreshDelayMs,
  REFRESH_MARGIN_MS,
  refreshInstallationToken,
  signAppJwt,
} from "../src/lib/github-app.js";

function keyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

// ── (2) THE JWT IS SIGNED IN PROCESS, NEVER SHELLED OUT TO openssl ─────────────────────────────

test("W1-T1024: the app jwt is signed in process without an openssl shell out", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/github-app.ts", import.meta.url)), "utf8");
  // No child_process import at all, and no shell-out call of any kind — the ONLY signing
  // mechanism in this file is node:crypto's own one-shot `sign` (imported below). (The doc
  // comment above names "openssl" in prose, explaining why it's NOT used — this checks for an
  // actual shell-out call, not the word.)
  assert.ok(!/child_process/.test(src), "github-app.ts must not import node:child_process");
  assert.ok(!/execFileSync|execSync|spawnSync|\bexecFile\(|\bspawn\(/.test(src), "github-app.ts must not shell out");
  assert.ok(/from "node:crypto"/.test(src), "github-app.ts must sign via node:crypto");

  const { publicKey, privateKey } = keyPair();
  const fixedNow = () => Date.parse("2026-08-20T12:00:00.000Z");
  const jwt = signAppJwt("app-123", privateKey, fixedNow);

  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeSegment(headerB64);
  const payload = decodeSegment(payloadB64);
  assert.equal(header.alg, "RS256");
  assert.equal(payload.iss, "app-123");
  assert.equal(payload.iat, Math.floor(fixedNow() / 1000) - 60);
  assert.equal(payload.exp, Math.floor(fixedNow() / 1000) + 9 * 60);

  // The signature verifies against the MATCHING public key — proof this is a real RSA-SHA256
  // signature `crypto.sign` produced in this process, not a placeholder string.
  const signedInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const signature = Buffer.from(signatureB64, "base64url");
  assert.ok(cryptoVerify("RSA-SHA256", signedInput, publicKey, signature));

  // A signature over a DIFFERENT input must NOT verify — the control that the check above is
  // actually exercising the signature, not vacuously true.
  const tamperedInput = Buffer.from(`${headerB64}.${payloadB64}x`, "utf8");
  assert.ok(!cryptoVerify("RSA-SHA256", tamperedInput, publicKey, signature));
});

// ── (1) A REFRESHED TOKEN REACHES A SPAWNED CHILD THROUGH THE ENVIRONMENT ──────────────────────

test("W1-T1024: a refreshed token reaches a spawned child through the environment", async () => {
  const { privateKey } = keyPair();
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/node", GH_TOKEN: "OLD-STATIC-TOKEN" };
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];

  const result = await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env,
    readKey: () => privateKey,
    fetchImpl: (async () =>
      fakeResponse(201, { token: "ghs_FRESH_APP_TOKEN", expires_at: "2026-08-20T13:00:00Z" })) as typeof fetch,
    log: (step, extra = {}) => logs.push({ step, extra }),
  });

  assert.equal(result.ok, true);
  assert.equal(env.GH_TOKEN, "ghs_FRESH_APP_TOKEN");

  // No call-site change: env.ts's ALLOWLIST (buildWorkerEnv) reads process.env — here, this SAME
  // `env` object — at spawn time, and picks up whatever the refresher just wrote.
  const childEnv = buildWorkerEnv({}, env);
  assert.equal(childEnv.GH_TOKEN, "ghs_FRESH_APP_TOKEN");
});

// ── (3) A FAILED EXCHANGE FALLS BACK TO THE STATIC TOKEN WITH A REASON ──────────────────────────

test("W1-T1024: a failed exchange falls back to the static token with a reason", async () => {
  const { privateKey } = keyPair();
  const env: NodeJS.ProcessEnv = { GH_TOKEN: "OLD-STATIC-TOKEN" };
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];

  const result = await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env,
    readKey: () => privateKey,
    fetchImpl: (async () => fakeResponse(403, { message: "forbidden" })) as typeof fetch,
    log: (step, extra = {}) => logs.push({ step, extra }),
  });

  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason!.length > 0);
  // The static token this fleet was already using is left EXACTLY as it was.
  assert.equal(env.GH_TOKEN, "OLD-STATIC-TOKEN");

  const failureLine = logs.find((l) => l.step === "github_app.token_refresh_failed");
  assert.ok(failureLine, "a failed exchange must ledger a named reason");
  assert.equal(typeof failureLine!.extra.reason, "string");
  assert.ok((failureLine!.extra.reason as string).length > 0);

  // A network-level throw (not just a non-2xx) falls back identically.
  const envAfterNetworkFailure: NodeJS.ProcessEnv = { GH_TOKEN: "OLD-STATIC-TOKEN" };
  const networkResult = await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env: envAfterNetworkFailure,
    readKey: () => privateKey,
    fetchImpl: (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch,
    log: (step, extra = {}) => logs.push({ step, extra }),
  });
  assert.equal(networkResult.ok, false);
  assert.equal(envAfterNetworkFailure.GH_TOKEN, "OLD-STATIC-TOKEN");
});

// ── (4) NO LEDGER ROW OR LOG LINE CARRIES THE KEY OR TOKEN VALUE ────────────────────────────────

test("W1-T1024: no ledger row or log line carries the key or token value", async () => {
  const { privateKey } = keyPair();
  const SECRET_TOKEN = "ghs_SUPER_SECRET_DO_NOT_LOG_ME";
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => logs.push({ step, extra });

  // Success path.
  const okEnv: NodeJS.ProcessEnv = {};
  await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env: okEnv,
    readKey: () => privateKey,
    fetchImpl: (async () =>
      fakeResponse(201, { token: SECRET_TOKEN, expires_at: "2026-08-20T13:00:00Z" })) as typeof fetch,
    log,
  });

  // Failure paths: unreadable key, signing failure (malformed key), rejected exchange.
  await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env: {},
    readKey: () => {
      throw new Error("ENOENT: /fake/key.pem");
    },
    fetchImpl: (async () => fakeResponse(201, { token: SECRET_TOKEN, expires_at: "x" })) as typeof fetch,
    log,
  });
  await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env: {},
    readKey: () => "not a real private key " + privateKey,
    fetchImpl: (async () => fakeResponse(201, { token: SECRET_TOKEN, expires_at: "x" })) as typeof fetch,
    log,
  });
  await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env: {},
    readKey: () => privateKey,
    fetchImpl: (async () => fakeResponse(401, { token: SECRET_TOKEN })) as typeof fetch,
    log,
  });

  assert.ok(logs.length > 0, "the scenarios above must have produced at least one log line");
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes(SECRET_TOKEN), "no log line may carry the minted token value");
  assert.ok(!serialized.includes(privateKey), "no log line may carry the private key");
  assert.ok(!serialized.includes("BEGIN RSA PRIVATE KEY"), "no log line may carry key material");
});

// ── (5) THE REFRESH MARGIN IS STRICTLY INSIDE THE ONE HOUR TOKEN LIFE ───────────────────────────

test("W1-T1024: the refresh margin is strictly inside the token life", () => {
  assert.equal(INSTALLATION_TOKEN_LIFETIME_MS, 60 * 60 * 1000);
  assert.ok(REFRESH_MARGIN_MS > 0, "a zero margin would refresh exactly at expiry, not before it");
  assert.ok(
    REFRESH_MARGIN_MS < INSTALLATION_TOKEN_LIFETIME_MS,
    "the margin must be strictly inside the token's one hour life",
  );

  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const expiresAtMs = now + INSTALLATION_TOKEN_LIFETIME_MS;
  const delay = nextRefreshDelayMs(expiresAtMs, now);

  assert.equal(delay, INSTALLATION_TOKEN_LIFETIME_MS - REFRESH_MARGIN_MS);
  assert.ok(delay > 0);
  assert.ok(delay < INSTALLATION_TOKEN_LIFETIME_MS, "the next refresh must fire before the token expires");

  // A clock jump past expiry never yields a negative delay — an immediate retry, not a crash.
  assert.equal(nextRefreshDelayMs(now - 1000, now), 0);
});

// ── absent config is a no-op, not a failure (mirrors GH_TOKEN's own optional shape today) ───────

test("W1-T1024: absent App configuration leaves GH_TOKEN untouched and logs nothing", async () => {
  const env: NodeJS.ProcessEnv = { GH_TOKEN: "OLD-STATIC-TOKEN" };
  const logs: Array<{ step: string }> = [];
  const result = await refreshInstallationToken({ env, log: (step) => logs.push({ step }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "app not configured");
  assert.equal(env.GH_TOKEN, "OLD-STATIC-TOKEN");
  assert.equal(logs.length, 0);
});
