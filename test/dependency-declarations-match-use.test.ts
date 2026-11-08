// @source-text-subject: this suite's subject is dependency/source declaration text.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { parse as parseJavaScript } from "acorn";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { INSTALLED_CLAUDE_AGENT_SDK_VERSION } from "../src/lib/settings.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");
const DEPCRUISE_CONFIG_PATH = join(REPO_ROOT, ".dependency-cruiser.cjs");
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

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

function readInstalledSdkVersion(): string {
  const entryUrl = import.meta.resolve(SDK_PACKAGE);
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(entryUrl)), "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
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
    specifier.startsWith("#") ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.length === 0 ||
    /\s/.test(specifier)
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

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, "node:" + name]));
const PRE_PUSH_HOOK_PATH = join(REPO_ROOT, "hooks", "pre-push");
const SCRIPT_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

type AstRecord = {
  type?: unknown;
  source?: unknown;
  callee?: unknown;
  arguments?: unknown;
  value?: unknown;
  name?: unknown;
  [key: string]: unknown;
};

function literalModuleSpecifiers(source: string, fileName: string): string[] {
  if (extname(fileName) === ".ts" || extname(fileName) === ".mts" || extname(fileName) === ".cts") {
    const lines = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""));
    const found: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const sideEffect = /^\s*import\s*["']([^"']+)["']/.exec(line);
      if (sideEffect) found.push(sideEffect[1]!);
      if (/^\s*(?:import|export)\s+(?!type\b)/.test(line)) {
        let statement = line;
        const firstFrom = /\bfrom\s*["']([^"']+)["']/.exec(statement);
        if (firstFrom) found.push(firstFrom[1]!);
        else {
          for (let j = i + 1; j < lines.length && j <= i + 12; j++) {
            const next = lines[j]!;
            if (/^\s*(?:import|export|const|let|var|function|class|interface|type|if|return)\b/.test(next)) break;
            statement += "\n" + next;
            const from = /\bfrom\s*["']([^"']+)["']/.exec(statement);
            if (from) {
              found.push(from[1]!);
              break;
            }
            if (/;\s*$/.test(next)) break;
          }
        }
      }
      for (const match of line.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]!);
    }
    return found;
  }

  const ast = parseJavaScript(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
  }) as unknown as AstRecord;
  const found: string[] = [];
  const addLiteral = (value: unknown): void => {
    if (typeof value === "object" && value !== null) {
      const literal = value as AstRecord;
      if (literal.type === "Literal" && typeof literal.value === "string") found.push(literal.value);
    }
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const node = value as AstRecord;
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ImportExpression")
    ) {
      addLiteral(node.source);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      visit(child);
    }
  };
  visit(ast);
  return found;
}

function resolveRelativeSource(fromFile: string, specifier: string): string | null {
  const target = resolve(dirname(fromFile), specifier);
  const extension = extname(target);
  const candidates = [target];
  if (!extension) {
    for (const suffix of SCRIPT_EXTENSIONS) candidates.push(target + suffix);
    for (const suffix of SCRIPT_EXTENSIONS) candidates.push(join(target, "index" + suffix));
  } else if (extension === ".js") {
    candidates.push(target.slice(0, -3) + ".ts", target.slice(0, -3) + ".mts");
  } else if (extension === ".mjs") {
    candidates.push(target.slice(0, -4) + ".mts");
  } else if (extension === ".cjs") {
    candidates.push(target.slice(0, -4) + ".cts");
  }
  return candidates.find((candidate) => {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    return SCRIPT_EXTENSIONS.includes(extname(candidate));
  }) ?? null;
}

function prePushRuntimePackages(): { files: Set<string>; packages: Set<string>; sources: Map<string, Set<string>> } {
  const hook = readFileSync(PRE_PUSH_HOOK_PATH, "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const entries = new Set<string>();
  for (const match of hook.matchAll(/\b(?:if|elif)\s+has\s+([A-Za-z0-9_./-]+\.mjs)\b/g)) {
    entries.add(resolve(REPO_ROOT, "scripts", match[1]!));
  }
  for (const match of hook.matchAll(/\bscripts\/([A-Za-z0-9_./-]+\.mjs)\b/g)) {
    entries.add(resolve(REPO_ROOT, "scripts", match[1]!));
  }
  assert.ok(entries.size > 0, "hooks/pre-push must name the script entry points it runs");
  for (const entry of entries) {
    assert.ok(existsSync(entry), "pre-push script entry exists: " + entry);
  }

  const files = new Set<string>();
  const packages = new Set<string>();
  const sources = new Map<string, Set<string>>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of literalModuleSpecifiers(source, file)) {
      if (NODE_BUILTINS.has(specifier)) continue;
      if (specifier.startsWith(".")) {
        const local = resolveRelativeSource(file, specifier);
        if (local) pending.push(local);
        continue;
      }
      const packageName = packageNameFromSpecifier(specifier);
      if (packageName) {
        packages.add(packageName);
        const owners = sources.get(packageName) ?? new Set<string>();
        owners.add(file.slice(REPO_ROOT.length + 1));
        sources.set(packageName, owners);
      }
    }
  }
  return { files, packages, sources };
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

test(
  "W1-T11232 criterion 2 in test/dependency-declarations-match-use.test.ts; W1-T11232 criterion 3: pre-push scripts declare every runtime package",
  () => {
    const inventory = prePushRuntimePackages();
    assert.ok(
      inventory.files.has(join(REPO_ROOT, "scripts", "census-precheck.mjs")),
      "positive control: pre-push reaches census-precheck.mjs",
    );
    assert.ok(
      inventory.packages.has("acorn"),
      "positive control: census-precheck.mjs contributes its bare acorn import",
    );
    const dependencies = new Set(Object.keys(readPackageJson().dependencies ?? {}));
    const missing = [...inventory.packages].filter((name) => !dependencies.has(name)).sort();
    assert.deepEqual(
      missing,
      [],
      "every bare package imported by pre-push scripts and their relative imports must be in dependencies: " +
        missing.map((name) => name + " from " + [...(inventory.sources.get(name) ?? [])].join(", ")).join("; "),
    );
  },
);

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

test("settings SDK citation matches installed package", () => {
  assert.equal(INSTALLED_CLAUDE_AGENT_SDK_VERSION, readInstalledSdkVersion());
});
