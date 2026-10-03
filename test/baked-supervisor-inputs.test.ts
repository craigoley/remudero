import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";
import { parseSync } from "@swc/core";
import { BAKED_RUNTIME_SOURCE_PATHS } from "../src/lib/baked-runtime-inputs.js";
import { BAKED_PATHS, checkImageDrift } from "../src/lib/image-drift.js";
import { IMAGE_BAKED_PATHS } from "../src/lib/deploy-judge.js";
import { gitRepo } from "./helpers/git-repo.js";

const ROOT = join(import.meta.dirname, "..");

function runtimeImports(source: string): string[] {
  const specs: string[] = [];
  const tree = parseSync(source, { syntax: "typescript", target: "es2022" });
  for (const item of tree.body) {
    if (item.type === "ImportDeclaration" && !item.typeOnly &&
      (item.specifiers.length === 0 || item.specifiers.some(s => s.type !== "ImportSpecifier" || !s.isTypeOnly))) specs.push(item.source.value);
    if (item.type === "ExportNamedDeclaration" && !item.typeOnly && item.source) specs.push(item.source.value);
    if (item.type === "ExportAllDeclaration") specs.push(item.source.value);
  }
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, unknown>;
    const callee = node.callee as { type?: string; value?: string } | undefined;
    if (node.type === "CallExpression" && (callee?.type === "Import" || (callee?.type === "Identifier" && callee.value === "require"))) {
      const args = node.arguments as Array<{ expression: { type: string; value?: string } }>;
      assert.equal(args[0]?.expression.type, "StringLiteral", "nonliteral baked imports need an explicit input contract");
      specs.push(args[0]!.expression.value!);
    }
    Object.values(node).forEach(visit);
  }
  visit(tree);
  return specs;
}

test("the baked supervisor catalogs cover its actual runtime import closure", () => {
  assert.deepEqual(runtimeImports("import type { X } from './types.js'; import { type Y, value } from './value.js'; import './side.js'; import('./dynamic.js');"), ["./value.js", "./side.js", "./dynamic.js"]);
  const seen = new Set<string>();
  const queue = ["src/lib/serve-supervisor-main.ts"];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeImports(readFileSync(join(ROOT, file), "utf8"))) {
      if (spec.startsWith("node:")) continue;
      assert.ok(spec.startsWith("."), `catalog the baked external package ${spec} before it can be imported`);
      const resolved = normalize(join(dirname(file), spec)).replace(/\.js$/, ".ts");
      assert.ok(existsSync(join(ROOT, resolved)), `${file}'s runtime import ${spec} resolves`);
      queue.push(resolved);
    }
  }
  assert.deepEqual([...BAKED_RUNTIME_SOURCE_PATHS].sort(), [...seen].sort());
  for (const file of seen) {
    assert.ok(BAKED_PATHS.includes(file), `image drift sees ${file}`);
    assert.ok(IMAGE_BAKED_PATHS.includes(file), `deployment sees ${file}`);
  }
  assert.equal(BAKED_PATHS.includes("src/run-task.ts"), false, "serve generations run from their mounted slots");
});

test("a supervisor dependency changed after the image build reports real image drift", () => {
  const repo = gitRepo({ kind: "baked-supervisor-input" });
  const buildSha = repo.git("rev-parse", "HEAD");
  const file = "src/lib/serve-supervisor.ts";
  mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
  writeFileSync(join(repo.dir, file), "export const revision = 2;\n");
  repo.git("add", file);
  repo.git("commit", "-q", "-m", "supervisor change");
  const finding = checkImageDrift(repo.dir, { readStamp: () => buildSha });
  assert.equal(finding.status, "drift");
  assert.equal(finding.status === "drift" && finding.bakedSha, repo.git("rev-parse", "HEAD"));
});
