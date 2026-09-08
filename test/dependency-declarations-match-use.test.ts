// @source-text-subject: this suite's subject is dependency/source declaration text.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");
const DEPCRUISE_CONFIG_PATH = join(REPO_ROOT, ".dependency-cruiser.cjs");

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  _dependencyRationale?: Record<string, string>;
  _overridesRationale?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as PackageJson;
}

function trackedSrcFiles(): string[] {
  return execFileSync("git", ["ls-files", "src/*.ts", "src/**/*.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

function packageNameFromSpecifier(specifier: string): string | null {
  if (
    specifier.startsWith("node:") ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.length === 0
  ) {
    return null;
  }
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0]!;
}

function collectRuntimePackagesFromSource(source: string, fileName: string): Set<string> {
  const found = new Set<string>();
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");

  function addSpecifier(specifier: string): void {
    const pkg = packageNameFromSpecifier(specifier);
    if (pkg) found.add(pkg);
  }

  for (const line of withoutBlockComments.split("\n")) {
    const code = line.replace(/\/\/.*$/, "");
    const fromMatch = /^\s*(?:import|export)\s+(?!type\b).*?\s+from\s+["']([^"']+)["']/.exec(code);
    if (fromMatch) addSpecifier(fromMatch[1]!);
    const sideEffectMatch = /^\s*import\s+["']([^"']+)["']/.exec(code);
    if (sideEffectMatch) addSpecifier(sideEffectMatch[1]!);
  }

  for (const match of withoutBlockComments.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    addSpecifier(match[1]!);
  }
  for (const match of withoutBlockComments.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    addSpecifier(match[1]!);
  }

  assert.ok(fileName.endsWith(".ts"), `only TypeScript source files are scanned: ${fileName}`);
  return found;
}

function runtimePackagesUsedBySrc(): string[] {
  const found = new Set<string>();
  for (const file of trackedSrcFiles()) {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const pkg of collectRuntimePackagesFromSource(source, file)) found.add(pkg);
  }
  return [...found].sort();
}

test("src runtime package uses are dependencies", () => {
  const pkg = readPackageJson();
  const deps = new Set(Object.keys(pkg.dependencies ?? {}));
  const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));
  const missing = runtimePackagesUsedBySrc().filter((name) => !deps.has(name));
  assert.deepEqual(missing, [], `runtime package uses must be dependencies: ${missing.join(", ")}`);
  assert.equal(
    deps.has("playwright"),
    true,
    "rmd review resolves and runs node_modules/playwright/cli.js at runtime",
  );
  assert.equal(devDeps.has("playwright"), false, "playwright must not be dev-only");
});

test("package overrides all carry rationale", () => {
  const pkg = readPackageJson();
  const rationale = pkg._overridesRationale ?? {};
  const missing = Object.keys(pkg.overrides ?? {}).filter((name) => {
    const reason = rationale[name];
    return typeof reason !== "string" || reason.trim().length === 0;
  });
  assert.deepEqual(missing, [], `override entries missing rationale: ${missing.join(", ")}`);
});

test("tool-only dependencies carry rationale", () => {
  const pkg = readPackageJson();
  assert.match(
    readFileSync(DEPCRUISE_CONFIG_PATH, "utf8"),
    /@swc\/core/,
    "the depcruise config must name the npm package required by parser: swc",
  );
  for (const name of ["@swc/core", "playwright"]) {
    const reason = pkg._dependencyRationale?.[name];
    assert.equal(typeof reason, "string", `${name} must have dependency rationale`);
    assert.ok(reason!.trim().length > 0, `${name} rationale must not be blank`);
  }
});
