import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveServeIdentity } from "../src/lib/serve.js";

// ── W1-T398's regression lock (design (vi)): the overwhelming majority of installs never set
// `serve.identityCapability` at all, and this guard must not touch that path in any way — no new
// required field, no new refusal, `undefined` in, `undefined` out, byte-for-byte the pre-W1-T371
// behavior. A guard that reached the off-by-default path would break nearly every install to
// close a hazard that only exists for the opt-in minority.

test("no identityCapability, no trustedProxy: undefined, no throw — today's out-of-the-box config", () => {
  assert.equal(resolveServeIdentity(undefined, undefined), undefined);
});

test("no identityCapability but trustedProxy declared anyway: still undefined, still no throw", () => {
  // trustedProxy is meaningless without identityCapability -- resolveServeIdentity must not
  // start requiring or validating it just because the field happens to be present.
  assert.equal(resolveServeIdentity(undefined, "tailscale"), undefined);
  assert.equal(resolveServeIdentity(undefined, "nginx"), undefined);
});

test("empty-string identityCapability is treated as unset, exactly like undefined", () => {
  assert.equal(resolveServeIdentity("", undefined), undefined);
});
