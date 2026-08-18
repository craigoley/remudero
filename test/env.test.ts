import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkerEnv, isBillingClean, billingMode, assertCleanBoot } from "../src/lib/env.js";

test("default (no key exported) ⇒ subscription-clean, exactly as before the valve", () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    TMPDIR: "/tmp",
    LANG: "en_US.UTF-8",
  };
  const child = buildWorkerEnv({}, parent);

  const anthropicKeys = Object.keys(child).filter((k) => /^ANTHROPIC_/i.test(k));
  assert.deepEqual(anthropicKeys, [], "no ANTHROPIC_* key when none was exported");
  assert.ok(isBillingClean(child));
  assert.equal(billingMode(Object.keys(child)), "subscription");
  // Allowlisted vars come through.
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.HOME, "/home/x");
  assert.equal(child.TMPDIR, "/tmp");
  assert.equal(child.LANG, "en_US.UTF-8");
});

test("the KEY ALONE (no config intent ⇒ allowApiKey false) is IGNORED — the fleet still bills subscription", () => {
  // The safety guard: an operator who happens to export ANTHROPIC_API_KEY for
  // some OTHER CLI must never silently flip the fleet onto API billing.
  const parent: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-ant-operator-key" };
  const child = buildWorkerEnv({}, parent); // allowApiKey defaults false
  assert.equal(child.ANTHROPIC_API_KEY, undefined, "the key is stripped without config intent");
  assert.equal(billingMode(Object.keys(child)), "subscription");
});

test("overflow valve (allowApiKey + exported key): ANTHROPIC_API_KEY passes through by value; every OTHER ANTHROPIC_* is never copied", () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    ANTHROPIC_API_KEY: "sk-ant-operator-key",
    ANTHROPIC_BASE_URL: "https://example.invalid", // not allowlisted, not the valve
    ANTHROPIC_MODEL: "whatever",                    // → never reaches the child
  };
  const child = buildWorkerEnv({}, parent, { allowApiKey: true });

  assert.equal(child.ANTHROPIC_API_KEY, "sk-ant-operator-key", "the valve carries the key through");
  assert.equal(child.ANTHROPIC_BASE_URL, undefined, "a non-sanctioned ANTHROPIC_* must not leak");
  assert.equal(child.ANTHROPIC_MODEL, undefined);
  assert.equal(billingMode(Object.keys(child)), "api", "billing_mode is DERIVED as api when the valve is engaged");
});

test("valve needs a NON-EMPTY key: allowApiKey with an empty ANTHROPIC_API_KEY stays subscription", () => {
  const child = buildWorkerEnv({}, { PATH: "/usr/bin", ANTHROPIC_API_KEY: "" }, { allowApiKey: true });
  assert.equal(child.ANTHROPIC_API_KEY, undefined, "empty ⇒ absent ⇒ subscription");
  assert.equal(billingMode(Object.keys(child)), "subscription");
});

test("throws if a caller injects a NON-sanctioned ANTHROPIC_* var (billing/behaviour redirect), valve engaged or not", () => {
  assert.throws(
    () => buildWorkerEnv({ ANTHROPIC_BASE_URL: "https://sneaky.invalid" }, { PATH: "/usr/bin" }, { allowApiKey: true }),
    /billing-boundary violation/,
  );
});

test("throws if ANTHROPIC_API_KEY is injected via extra WITHOUT allowApiKey — a leak absent config intent", () => {
  assert.throws(
    () => buildWorkerEnv({ ANTHROPIC_API_KEY: "sk-ant-sneaky" }, { PATH: "/usr/bin" }),
    /billing-boundary violation/,
  );
});

test("assertCleanBoot: billing_mode is DERIVED, gated on BOTH the config intent and the key", () => {
  // Key present but no config intent ⇒ subscription (matches what workers bill). The
  // runtime/declaredNodeVersion params are omitted here, so this only pins the billing
  // fields it was written to prove — the node_path/node_version/node_drift readings this
  // same call also returns are checked precisely by test/node-runtime-provenance.test.ts.
  const clean = assertCleanBoot({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-daemon" });
  assert.equal(clean.env_clean, false);
  assert.equal(clean.billing_mode, "subscription");
  assert.equal(clean.node_path, process.execPath);
  assert.equal(clean.node_version, process.version);
  // Both factors ⇒ api. env_clean is the honest canary (key intentionally present).
  const engaged = assertCleanBoot({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-daemon" }, true);
  assert.equal(engaged.billing_mode, "api", "a daemon booted with the valve records api");
  assert.equal(engaged.env_clean, false);
  // Config intent but no key ⇒ subscription (nothing to bill on).
  assert.equal(assertCleanBoot({ PATH: "/usr/bin" }, true).billing_mode, "subscription");
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

test("merges caller-supplied non-ANTHROPIC vars", () => {
  const child = buildWorkerEnv({ GH_TOKEN: "TOKEN-EXAMPLE" }, { PATH: "/usr/bin" });
  assert.equal(child.GH_TOKEN, "TOKEN-EXAMPLE");
});

test("grants ZDOTDIR from the config-resolved path (shell-isolation boundary)", () => {
  const child = buildWorkerEnv({}, { PATH: "/usr/bin", HOME: "/home/x" }, { zdotdir: "/opt/rmd/zdotdir" });
  assert.equal(child.ZDOTDIR, "/opt/rmd/zdotdir", "the config path must win");
});

test("defaults ZDOTDIR from HOME when the caller passes no path", () => {
  // <HOME>/.config/remudero/zdotdir === <root>/../.config/remudero/zdotdir.
  const child = buildWorkerEnv({}, { PATH: "/usr/bin", HOME: "/home/x" });
  assert.equal(child.ZDOTDIR, "/home/x/.config/remudero/zdotdir");
});

test("NEVER copies the operator's ZDOTDIR from the parent — only the granted path", () => {
  const child = buildWorkerEnv(
    {},
    { PATH: "/usr/bin", HOME: "/home/x", ZDOTDIR: "/home/x/.config/OPERATOR" },
    { zdotdir: "/opt/rmd/zdotdir" },
  );
  assert.equal(child.ZDOTDIR, "/opt/rmd/zdotdir", "an operator ZDOTDIR must not leak in");
});

test("an explicit ZDOTDIR in extra overrides the default (test/override escape hatch)", () => {
  const child = buildWorkerEnv({ ZDOTDIR: "/tmp/override" }, { PATH: "/usr/bin", HOME: "/home/x" });
  assert.equal(child.ZDOTDIR, "/tmp/override");
});

test("grants CLAUDE_CODE_SHELL (the var that isolates the Bash-tool snapshot from ~/.zshrc)", () => {
  const withOpt = buildWorkerEnv({}, { PATH: "/usr/bin", HOME: "/home/x" }, { shell: "/bin/bash" });
  assert.equal(withOpt.CLAUDE_CODE_SHELL, "/bin/bash", "the config shell must be granted");
  const dflt = buildWorkerEnv({}, { PATH: "/usr/bin", HOME: "/home/x" });
  assert.equal(dflt.CLAUDE_CODE_SHELL, "/bin/bash", "defaults to /bin/bash");
});

test("NEVER copies the operator's CLAUDE_CODE_SHELL from the parent — only the granted value", () => {
  const child = buildWorkerEnv(
    {},
    { PATH: "/usr/bin", HOME: "/home/x", CLAUDE_CODE_SHELL: "/opt/operator/zsh" },
    { shell: "/bin/bash" },
  );
  assert.equal(child.CLAUDE_CODE_SHELL, "/bin/bash", "an operator shell must not leak in");
});

// ── W1-T18: HOME redirection (isolation independent of the operator's real ~/.bashrc) ──

test("grants an INJECTED HOME override, replacing whatever the allowlist copied from the parent's real HOME", () => {
  const child = buildWorkerEnv(
    {},
    { PATH: "/usr/bin", HOME: "/Users/operator" },
    { home: "/opt/rmd/worker-home" },
  );
  assert.equal(child.HOME, "/opt/rmd/worker-home", "the redirected scratch HOME must win over the operator's real HOME");
});

test("with no opts.home, HOME still falls back to the parent's (back-compat default)", () => {
  const child = buildWorkerEnv({}, { PATH: "/usr/bin", HOME: "/Users/operator" });
  assert.equal(child.HOME, "/Users/operator");
});

test("an explicit HOME in extra overrides opts.home (test/override escape hatch)", () => {
  const child = buildWorkerEnv(
    { HOME: "/tmp/explicit-override" },
    { PATH: "/usr/bin", HOME: "/Users/operator" },
    { home: "/opt/rmd/worker-home" },
  );
  assert.equal(child.HOME, "/tmp/explicit-override");
});

test("ZDOTDIR defaults nest under the REDIRECTED HOME, not the operator's real one, when opts.home is set", () => {
  const child = buildWorkerEnv(
    {},
    { PATH: "/usr/bin", HOME: "/Users/operator" },
    { home: "/opt/rmd/worker-home" },
  );
  assert.equal(child.ZDOTDIR, "/opt/rmd/worker-home/.config/remudero/zdotdir");
});

// ── W1-T236: DISABLE_AUTOUPDATER grant (autoupdater-race hazard) ──

test("grants DISABLE_AUTOUPDATER=1 to every worker child, added through the allowlist rather than dropped by it", () => {
  // ALLOWLIST is exactly PATH/HOME/TMPDIR/LANG/USER — DISABLE_AUTOUPDATER is
  // not a parent var at all here, so its presence proves it is an explicit
  // grant (like CLAUDE_CODE_SHELL/ZDOTDIR above), not a copy the allowlist let through.
  const child = buildWorkerEnv({}, { PATH: "/usr/bin", HOME: "/home/x" });
  assert.equal(child.DISABLE_AUTOUPDATER, "1", "every worker child must carry the autoupdater kill switch");
});

test("NEVER copies the operator's DISABLE_AUTOUPDATER from the parent — only the granted value", () => {
  const child = buildWorkerEnv(
    {},
    { PATH: "/usr/bin", HOME: "/home/x", DISABLE_AUTOUPDATER: "0" },
  );
  assert.equal(child.DISABLE_AUTOUPDATER, "1", "an operator value must not leak in — the grant always wins");
});

test("an explicit DISABLE_AUTOUPDATER in extra overrides the default (test/override escape hatch)", () => {
  const child = buildWorkerEnv({ DISABLE_AUTOUPDATER: "0" }, { PATH: "/usr/bin", HOME: "/home/x" });
  assert.equal(child.DISABLE_AUTOUPDATER, "0");
});
