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
