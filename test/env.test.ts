import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkerEnv, isBillingClean } from "../src/lib/env.js";

test("strips ANTHROPIC_* from a polluted parent env (the billing boundary)", () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    TMPDIR: "/tmp",
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "KEY-SHOULD-NEVER-SURVIVE",
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_MODEL: "whatever",
  };
  const child = buildWorkerEnv({}, parent);

  const anthropicKeys = Object.keys(child).filter((k) => /^ANTHROPIC_/i.test(k));
  assert.deepEqual(anthropicKeys, [], "no ANTHROPIC_* key may survive");
  assert.ok(isBillingClean(child));
  // Allowlisted vars come through.
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.HOME, "/home/x");
  assert.equal(child.TMPDIR, "/tmp");
  assert.equal(child.LANG, "en_US.UTF-8");
});

test("does not inherit non-allowlisted parent vars wholesale", () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    SECRET_TOKEN: "leak-me",
    AWS_SECRET_ACCESS_KEY: "nope",
  };
  const child = buildWorkerEnv({}, parent);
  assert.equal(child.SECRET_TOKEN, undefined);
  assert.equal(child.AWS_SECRET_ACCESS_KEY, undefined);
});

test("throws if a caller tries to inject an ANTHROPIC_* var", () => {
  assert.throws(
    () => buildWorkerEnv({ ANTHROPIC_API_KEY: "sneaky" }, { PATH: "/usr/bin" }),
    /billing-boundary violation/,
  );
});

test("merges caller-supplied non-ANTHROPIC vars", () => {
  const child = buildWorkerEnv({ GH_TOKEN: "TOKEN-EXAMPLE" }, { PATH: "/usr/bin" });
  assert.equal(child.GH_TOKEN, "TOKEN-EXAMPLE");
});
