// @source-text-subject - this suite's subject is the source text that declares harness env names.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ENV_REGISTRY } from "../src/lib/config-schema.js";
import { isRegisteredHarnessEnvName, registeredHarnessEnvVars } from "../src/lib/env.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENV_LITERAL = /(["'`])(RMD_[A-Z0-9_]+|REMUDERO_[A-Z0-9_]+)\1/g;
const ENV_DOT_ACCESS = /(?<![\w$])(?:[$A-Z_a-z][$\w]*)?[eE][nN][vV]\s*(?:\?\.|\.)\s*(RMD_[A-Z0-9_]+|REMUDERO_[A-Z0-9_]+)(?![\w$])/g;

export function srcFiles(): string[] {
  return execFileSync("git", ["ls-files", "src/*.ts", "src/**/*.ts"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

export function harnessEnvNamesInSource(text: string): string[] {
  return [
    ...[...text.matchAll(ENV_LITERAL)].map((match) => match[2]!),
    ...[...text.matchAll(ENV_DOT_ACCESS)].map((match) => match[1]!),
  ];
}

export function declaredHarnessEnvNames(): string[] {
  const names = new Set<string>();
  for (const file of srcFiles()) {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const name of harnessEnvNamesInSource(text)) names.add(name);
  }
  return [...names].sort();
}

test("every RMD_ or REMUDERO_ env-name literal or dot read in src is registered once", () => {
  const declared = declaredHarnessEnvNames();
  const registered = ENV_REGISTRY.map((entry) => entry.name).sort();

  assert.ok(declared.length > 10, "control: the source sweep must see the harness env population");
  assert.deepEqual(registered, [...new Set(registered)].sort(), "registry names must be unique");
  assert.deepEqual(registered, declared);
});

test("each registered env var names its purpose and readers", () => {
  for (const entry of ENV_REGISTRY) {
    assert.match(entry.name, /^(RMD|REMUDERO)_[A-Z0-9_]+$/);
    assert.ok(entry.purpose.trim().length > 0, `${entry.name} must describe its purpose`);
    assert.ok(entry.readBy.length > 0, `${entry.name} must name at least one reader`);
  }
});

test("env.ts exposes the same registry for runtime readers", () => {
  assert.deepEqual(registeredHarnessEnvVars(), ENV_REGISTRY);
  assert.equal(isRegisteredHarnessEnvName("RMD_SELF_SYNC_DONE"), true);
  assert.equal(isRegisteredHarnessEnvName("RMD_UNKNOWN_TEST_VAR"), false);
});
