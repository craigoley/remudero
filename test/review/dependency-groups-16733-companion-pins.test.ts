import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseDependabotBumpFacts } from "#src/lib/dep-review.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const json = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));

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
    assert.match(version, /^\d+\.\d+\.\d+$/, name + " stable version");
    const targetParts = target.split(".").map(Number);
    const comparison = version.split(".").map(Number)
      .map((part: number, index: number) => part - targetParts[index])
      .find((difference: number) => difference !== 0) ?? 0;
    assert.ok(comparison >= 0, name + " must not downgrade its requested target");
    assert.equal(declared, (name === "@swc/core" || name === "@anthropic-ai/claude-agent-sdk" ? "^" : "") + version, name);
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
