import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveServeIdentity, TRUSTED_PROXY_TAILSCALE } from "../src/lib/serve.js";

// ── W1-T398's named opt-out: an operator who genuinely fronts the console with something other
// than Tailscale Serve must be able to SAY so, distinctly from never having declared anything —
// but this codebase cannot verify a different proxy strips client-supplied identity headers the
// way Serve does (that fact is not observable from inside this process, per the task's design
// note (iii)), so the opt-out is refused for now rather than silently trusted. The refusal must
// name what would have to be true for it to be safe, not just say "unsupported".

const CAPABILITY = "example.com/cap/console-write";

test("a declared non-tailscale proxy is refused, not silently accepted", () => {
  assert.throws(() => resolveServeIdentity(CAPABILITY, "nginx"), /trustedProxy/);
});

test("the refusal names the declared value and the stripping guarantee it would need", () => {
  assert.throws(() => resolveServeIdentity(CAPABILITY, "nginx"), (err: unknown) => {
    const message = (err as Error).message;
    assert.match(message, /"nginx"/);
    assert.match(message, /strip/i);
    assert.match(message, /Tailscale Serve/);
    return true;
  });
});

test("the refusal is distinct from the absent-field refusal (both throw, different messages)", () => {
  let absentMessage = "";
  let optOutMessage = "";
  try {
    resolveServeIdentity(CAPABILITY, undefined);
  } catch (e) {
    absentMessage = (e as Error).message;
  }
  try {
    resolveServeIdentity(CAPABILITY, "caddy");
  } catch (e) {
    optOutMessage = (e as Error).message;
  }
  assert.notEqual(absentMessage, "");
  assert.notEqual(optOutMessage, "");
  assert.notEqual(absentMessage, optOutMessage);
});

test("only the declared \"tailscale\" value is accepted -- confirms the opt-out set is everything else", () => {
  assert.doesNotThrow(() => resolveServeIdentity(CAPABILITY, TRUSTED_PROXY_TAILSCALE));
  assert.throws(() => resolveServeIdentity(CAPABILITY, "Tailscale"), /trustedProxy/, "case-sensitive: not a fuzzy match");
});
