// @source-text-subject - this suite's subject is the source text that declares harness env names.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ENV_REGISTRY } from "../src/lib/config-schema.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENV_LITERAL = /(["'`])(RMD_[A-Z0-9_]+|REMUDERO_[A-Z0-9_]+)\1/g;

function srcFiles(): string[] {
  return execFileSync("git", ["ls-files", "src/**/*.ts"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function declaredHarnessEnvNames(): string[] {
  const names = new Set<string>();
  for (const file of srcFiles()) {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const match of text.matchAll(ENV_LITERAL)) {
      const name = match[2];
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

test("every RMD_ or REMUDERO_ env-name literal in src is registered once", () => {
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
