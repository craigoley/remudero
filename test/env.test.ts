import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkerEnv, isBillingClean, billingMode, assertCleanBoot } from "#src/lib/env.js";
import { LIVE_LEDGER_DENY_ROOT_ENV } from "#src/lib/live-write-guard.js";
import { GARDENER_ORIGIN_ENV, GARDENER_ORIGIN_MAX_BYTES, gardenerOriginEnv, readGardenerOrigin } from "#src/lib/worker-containment.js";

test("SDK gardener origin validation and parent precedence", () => {
  const passA = "a5142db1-3dab-4f50-8f8f-a25cfb8e8db1";
  const passB = "e6921695-5c56-45c2-89f4-1f1e4d67c826";
  const a = gardenerOriginEnv("plan", passA)!;
  const b = gardenerOriginEnv("gate", passB)!;
  const spacedA = JSON.stringify({ passId: passA, name: "plan", version: 1 }, null, 2);
  const exactBound = a + " ".repeat(GARDENER_ORIGIN_MAX_BYTES - Buffer.byteLength(a));
  assert.equal(Buffer.byteLength(exactBound), 256);
  const malformed = [
    "", "fixture-secret-not-json", "null", "[]", "1",
    JSON.stringify({ version: 2, name: "plan", passId: passA }),
    JSON.stringify({ version: 1, name: "plan", passId: passA, token: "fixture-secret-extra-key" }),
    JSON.stringify({ version: 1, name: "Plan", passId: passA }),
    JSON.stringify({ version: 1, name: "plan\nfixture-secret", passId: passA }),
    JSON.stringify({ version: 1, name: "plan", passId: "not-a-uuid" }),
    JSON.stringify({ version: 1, name: "plan", passId: passA.replace("4f50", "1f50") }),
    exactBound + " ", "é".repeat(129),
  ];
  const cases: Array<{ ambient?: string; extra?: string; expected?: string }> = [
    {}, { ambient: a, expected: a }, { ambient: spacedA, expected: a },
    { ambient: exactBound, expected: a }, { extra: a, expected: a },
    { extra: spacedA, expected: a }, { extra: b, expected: b },
    { ambient: a, extra: b, expected: a },
    ...malformed.flatMap(value => [
      { ambient: value, expected: "null" },
      { ambient: value, extra: b, expected: "null" },
      { extra: value, expected: "null" },
      { ambient: a, extra: value, expected: a },
    ]),
  ];
  for (const [index, row] of cases.entries()) {
    const parent = Object.freeze({ PATH: "/usr/bin", ...(row.ambient !== undefined ? { [GARDENER_ORIGIN_ENV]: row.ambient } : {}) });
    const extra = Object.freeze({ ...(row.extra !== undefined ? { [GARDENER_ORIGIN_ENV]: row.extra } : {}) });
    const before = JSON.stringify({ parent, extra });
    const child = buildWorkerEnv(extra, parent);
    assert.equal(child[GARDENER_ORIGIN_ENV], row.expected, `case ${index}: canonical bounded output`);
    assert.equal(Object.hasOwn(child, GARDENER_ORIGIN_ENV), row.expected !== undefined);
    assert.deepEqual(readGardenerOrigin(child), row.expected === undefined ? undefined : row.expected === "null"
      ? { state: "invalid", reason: "malformed" }
      : { state: "linked", version: 1, name: row.expected === b ? "gate" : "plan", passId: row.expected === b ? passB : passA });
    assert(Buffer.byteLength(child[GARDENER_ORIGIN_ENV] ?? "") <= GARDENER_ORIGIN_MAX_BYTES);
    assert.equal(JSON.stringify(child).includes("fixture-secret"), false);
    assert.equal(JSON.stringify({ parent, extra }), before, "inputs are not modified");
  }
});

test("SDK gardener origin billing and identity boundaries", () => {
  const carrier = gardenerOriginEnv("plan", "a5142db1-3dab-4f50-8f8f-a25cfb8e8db1")!;
  const parent = Object.freeze({
    PATH: "/usr/bin", HOME: "/private/fixture-parent", TMPDIR: "/private/fixture-tmp", LANG: "C",
    USER: "fixture-user", CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth", GH_TOKEN: "fixture-gh",
    ANTHROPIC_API_KEY: "fixture-api", ANTHROPIC_BASE_URL: "fixture-denied-parent",
    SECRET_TOKEN: "fixture-denied-secret", AWS_SECRET_ACCESS_KEY: "fixture-denied-aws",
    [LIVE_LEDGER_DENY_ROOT_ENV]: "/private/fixture-live-root",
    REMUDERO_RUN_ID: "parent-cannot-authorize-run", REMUDERO_TASK_ID: "parent-cannot-authorize-task",
  });
  const extras: Array<Record<string, string>> = [{}, {
    HOME: "/private/fixture-extra-home", GH_TOKEN: "fixture-explicit-gh", CLAUDE_CODE_SHELL: "/bin/sh",
    ZDOTDIR: "/private/fixture-extra-zdot", REMUDERO_RUN_ID: "explicit-run", REMUDERO_TASK_ID: "W1-T1",
    REMUDERO_WORKER_SCOPE: "explicit-scope", [LIVE_LEDGER_DENY_ROOT_ENV]: "/private/fixture-spoofed-root",
  }];
  for (const extra of extras) {
    for (const allowApiKey of [false, true]) {
      const opts = Object.freeze({ allowApiKey, home: "/private/fixture-worker-home", shell: "/bin/bash",
        zdotdir: "/private/fixture-worker-zdot", xdgCacheHome: "/private/fixture-worker-cache" });
      const baseline = buildWorkerEnv(extra, parent, opts);
      for (const value of [carrier, "fixture-secret-invalid-origin"]) {
        const child = buildWorkerEnv(extra, { ...parent, [GARDENER_ORIGIN_ENV]: value }, opts);
        const { [GARDENER_ORIGIN_ENV]: metadata, ...otherKeys } = child;
        assert.deepEqual(otherKeys, baseline, "only bounded correlation metadata changes");
        assert.equal(metadata, value === carrier ? carrier : "null");
        assert.equal(child[LIVE_LEDGER_DENY_ROOT_ENV], parent[LIVE_LEDGER_DENY_ROOT_ENV]);
        assert.equal(child.SECRET_TOKEN, undefined);
        assert.equal(child.AWS_SECRET_ACCESS_KEY, undefined);
        assert.equal(child.ANTHROPIC_BASE_URL, undefined);
        assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, parent.CLAUDE_CODE_OAUTH_TOKEN);
        assert.equal(child.XDG_CACHE_HOME, opts.xdgCacheHome);
        assert.equal(child.HOME, extra.HOME ?? opts.home);
        assert.equal(billingMode(Object.keys(child)), allowApiKey ? "api" : "subscription");
        assert.equal(isBillingClean(child), !allowApiKey);
      }
    }
  }
  for (const key of [undefined, ""]) {
    const child = buildWorkerEnv({}, { ...parent, ANTHROPIC_API_KEY: key, [GARDENER_ORIGIN_ENV]: carrier }, { allowApiKey: true });
    assert.equal(billingMode(Object.keys(child)), "subscription", "correlation never engages an empty valve");
  }
  for (const allowApiKey of [false, true]) {
    assert.throws(() => buildWorkerEnv({ ANTHROPIC_BASE_URL: "fixture-secret-value", [GARDENER_ORIGIN_ENV]: carrier }, parent, { allowApiKey }), error => {
      assert(error instanceof Error && error.message.includes("billing-boundary violation"));
      assert.equal(error.message.includes("fixture-secret-value"), false);
      return true;
    });
  }
  assert.throws(() => buildWorkerEnv({ ANTHROPIC_API_KEY: "fixture-injected", [GARDENER_ORIGIN_ENV]: carrier }, parent), /billing-boundary violation/);
});

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

test("shared XDG cache is independent from the per-spawn HOME boundary", () => {
  const child = buildWorkerEnv(
    {},
    { PATH: "/usr/bin", HOME: "/Users/operator", XDG_CACHE_HOME: "/Users/operator/.cache" },
    { home: "/opt/rmd/worker-home-1", xdgCacheHome: "/opt/rmd/state/cache" },
  );
  assert.equal(child.HOME, "/opt/rmd/worker-home-1");
  assert.equal(child.XDG_CACHE_HOME, "/opt/rmd/state/cache");
  assert.notEqual(child.HOME, child.XDG_CACHE_HOME, "shared transport state must not collapse worker HOME isolation");
});

test("the instance XDG cache wins over an accidental per-worker extra", () => {
  const child = buildWorkerEnv(
    { XDG_CACHE_HOME: "/tmp/test-cache" },
    { PATH: "/usr/bin", HOME: "/Users/operator" },
    { home: "/opt/rmd/worker-home-1", xdgCacheHome: "/opt/rmd/state/cache" },
  );
  assert.equal(child.XDG_CACHE_HOME, "/opt/rmd/state/cache");
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

// ── CLAUDE_CODE_DISABLE_AUTO_MEMORY grant (auto memory ignores settingSources) ──

test("grants CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 to every worker child, so no worker loads the repo's shared auto memory", () => {
  const child = buildWorkerEnv({}, { PATH: "/usr/bin", HOME: "/home/x" });
  assert.equal(child.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1", "settingSources: [] alone leaves auto memory on");
});

test("NEVER copies the operator's CLAUDE_CODE_DISABLE_AUTO_MEMORY from the parent — only the granted value", () => {
  const child = buildWorkerEnv({}, { PATH: "/usr/bin", HOME: "/home/x", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" });
  assert.equal(child.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1", "an operator value must not leak in — the grant always wins");
});

test("an explicit CLAUDE_CODE_DISABLE_AUTO_MEMORY in extra overrides the default (test/override escape hatch)", () => {
  const child = buildWorkerEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" }, { PATH: "/usr/bin", HOME: "/home/x" });
  assert.equal(child.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "0");
});
