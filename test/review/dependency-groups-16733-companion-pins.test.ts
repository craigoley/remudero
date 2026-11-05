import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseDependabotBumpFacts } from "#src/lib/dep-review.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const json = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));

function compareStableVersions(actual: string, minimum: string): number {
  assert.match(actual, /^\d+\.\d+\.\d+$/);
  assert.match(minimum, /^\d+\.\d+\.\d+$/);
  const target = minimum.split(".").map(Number);
  return actual.split(".").map(Number)
    .map((part, index) => part - target[index])
    .find(difference => difference !== 0) ?? 0;
}

test("dependency groups 16733 and 16734 preserve their requested versions and every platform pin", () => {
  const root = json("package.json");
  const lock = json("package-lock.json");
  const image = json("deploy/package.json");
  const imageLock = json("deploy/package-lock.json");
  const requested = parseDependabotBumpFacts("", [
    "Updates `@anthropic-ai/claude-agent-sdk` from 0.3.310 to 0.3.316",
    "Updates `@swc/core` from 1.16.20 to 1.16.21",
    "Updates `@anthropic-ai/claude-code` from 2.1.310 to 2.1.316",
    "Updates `@openai/codex` from 0.163.0 to 0.166.0",
  ].join("\n"));
  assert.equal(requested.length, 4, "all four original dependency requests resolve");
  for (const [name, declared, packages] of [
    ["@anthropic-ai/claude-agent-sdk", root.dependencies["@anthropic-ai/claude-agent-sdk"], lock.packages],
    ["@swc/core", root.devDependencies["@swc/core"], lock.packages],
    ["@anthropic-ai/claude-code", image.dependencies["@anthropic-ai/claude-code"], imageLock.packages],
    ["@openai/codex", image.dependencies["@openai/codex"], imageLock.packages],
  ] as const) {
    const version = packages["node_modules/" + name].version;
    const target = requested.find(bump => bump.dependency === name)?.toVersion;
    assert.ok(target, name + " requested version");
    const caret = name === "@swc/core" || name === "@anthropic-ai/claude-agent-sdk";
    assert.equal(declared.startsWith("^"), caret, name + " range convention");
    const minimum = caret ? declared.slice(1) : declared;
    assert.ok(compareStableVersions(minimum, target) >= 0, name + " manifest must retain the requested upgrade");
    assert.ok(compareStableVersions(version, minimum) >= 0, name + " lock must satisfy the manifest minimum");
    if (caret) {
      const [major, minor, patch] = minimum.split(".").map(Number);
      const actual = version.split(".").map(Number);
      assert.equal(actual[0], major, name + " caret major");
      if (major === 0) {
        assert.equal(actual[1], minor, name + " caret minor");
        if (minor === 0) assert.equal(actual[2], patch, name + " caret patch");
      }
    } else {
      assert.equal(version, declared, name + " exact image pin");
    }
    const entry = packages["node_modules/" + name];
    assert.equal(packages[""].dependencies?.[name] ?? packages[""].devDependencies[name], declared, name + " root lock");
    assert.ok(Object.keys(entry.optionalDependencies).length > 0, name + " platform population");
    for (const [platform, required] of Object.entries(entry.optionalDependencies)) {
      const child = packages["node_modules/" + platform];
      assert.ok(child, platform + " is locked");
      assert.equal(child.version, String(required).replace(/^npm:@openai\/codex@/, ""), platform);
    }
  }
});
