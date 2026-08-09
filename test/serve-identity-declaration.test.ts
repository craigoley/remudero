import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveServeIdentity, TRUSTED_PROXY_TAILSCALE, DEFAULT_SERVE_HOST } from "../src/lib/serve.js";

// ── W1-T398: enabling `identityCapability` used to silently inherit the loopback-trust
// assumption `resolveServeIdentity` hardcoded — nothing recorded WHICH proxy the operator meant
// to be terminating on that address, so a foreign reverse proxy on the same loopback address
// turned gate 1 (service.ts's interface check) into a no-op while gate 2's header check lost the
// only thing that made it safe. This file proves the declare-or-refuse half of the fix: the
// capability is USELESS by itself now — it needs `serve.trustedProxy` declared alongside it, or
// startup refuses rather than quietly inheriting a default nobody wrote down.

const CAPABILITY = "example.com/cap/console-write";

test("identityCapability set, trustedProxy absent: refused, not silently defaulted", () => {
  assert.throws(() => resolveServeIdentity(CAPABILITY, undefined), /serve\.trustedProxy/);
});

test("the refusal names the missing field and the supported value, not a generic error", () => {
  assert.throws(() => resolveServeIdentity(CAPABILITY, undefined), (err: unknown) => {
    const message = (err as Error).message;
    assert.match(message, /identityCapability is set/);
    assert.match(message, /trustedProxy/);
    assert.match(message, new RegExp(TRUSTED_PROXY_TAILSCALE));
    return true;
  });
});

test("identityCapability set, trustedProxy declared as \"tailscale\": resolves, not refused", () => {
  const identity = resolveServeIdentity(CAPABILITY, TRUSTED_PROXY_TAILSCALE);
  assert.deepEqual(identity, { trustedLocalAddress: DEFAULT_SERVE_HOST, capability: CAPABILITY });
});

test("an empty-string trustedProxy is treated as absent, not as some other declared value", () => {
  assert.throws(() => resolveServeIdentity(CAPABILITY, ""), /serve\.trustedProxy/);
});
