// @source-text-subject: this suite's subject is the source text declaring `*Deps` interfaces/types.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_ROOT = join(REPO_ROOT, "src");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "deps-interface-baseline.json");

const DEPS_DECLARATION = /^(?:export\s+)?(?:interface|type)\s+([A-Za-z0-9_]+Deps)\b/gm;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function toRepoRelative(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

export function depsInterfaceDeclarations(): string[] {
  const names = new Set<string>();
  for (const file of listTsFiles(SRC_ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(DEPS_DECLARATION)) names.add(match[1]!);
  }
  return [...names].sort();
}

function declarationFilesByName(): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const file of listTsFiles(SRC_ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(DEPS_DECLARATION)) {
      const name = match[1]!;
      byName.set(name, [...(byName.get(name) ?? []), toRepoRelative(file)]);
    }
  }
  return byName;
}

function readBaseline(): { depsInterfaceCount: number } {
  const raw = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { depsInterfaceCount?: unknown };
  assert.equal(
    typeof raw.depsInterfaceCount,
    "number",
    "scripts/deps-interface-baseline.json must record depsInterfaceCount as a number",
  );
  return { depsInterfaceCount: raw.depsInterfaceCount as number };
}

test("the count of Deps interface/type declarations is recorded in scripts/deps-interface-baseline.json", () => {
  const baseline = readBaseline();
  assert.ok(Number.isInteger(baseline.depsInterfaceCount));
  assert.ok(baseline.depsInterfaceCount > 100, "the baseline must be a real census, not an empty placeholder");
});

test("the count of Deps interface/type declarations under src cannot grow", () => {
  const baseline = readBaseline();
  const actual = depsInterfaceDeclarations();
  assert.ok(actual.length > 100, "the census must see the existing declaration population");
  assert.ok(
    actual.length <= baseline.depsInterfaceCount,
    `Deps declarations grew from ${baseline.depsInterfaceCount} to ${actual.length}. ` +
      "Move wiring behind the composition root or reuse an existing seam instead of adding another *Deps shape.",
  );
});

test("each counted Deps declaration name resolves to at least one source file", () => {
  const byName = declarationFilesByName();
  for (const name of depsInterfaceDeclarations()) {
    assert.ok((byName.get(name) ?? []).length > 0, `${name} must name the file(s) that declared it`);
  }
});
