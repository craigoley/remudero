#!/usr/bin/env node
// Content-only migration; dry-run by default. Unsupported expressions are reported, never guessed.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { isMainModule } from "./lib/argv.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const require = createRequire(import.meta.url);

export const SHAPES = ["join/resolve(dirname(fileURLToPath(import.meta.url)), parents)",
  "join/resolve(__dirname, parents)", "join/resolve(import.meta.dirname, parents)",
  "fileURLToPath(new URL(parents, import.meta.url))"];

export function testFiles(root) {
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [relative(root, path).split("\\").join("/")] : [];
  });
  return walk(join(root, "test")).filter((p) => !/^test\/(helpers|setup|lib|fixtures)\//.test(p)).sort();
}

function children(node) {
  return Object.values(node).flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => value && typeof value === "object" && value !== node.span);
}

/** Parse executable expressions so comments and fixture strings cannot become edits. */
export function analyzeSource(source, file) {
  const { parseSync } = require("@swc/core");
  const tree = parseSync(source, { syntax: "typescript", target: "es2022" });
  const bytes = Buffer.from(source);
  const text = (node) => bytes.subarray(node.span.start - 1, node.span.end - 1).toString();
  const compact = (node) => node && text(node).replace(/\s+/g, "");
  const imports = new Map();
  const namespaces = new Map();
  for (const item of tree.body) {
    if (item.type !== "ImportDeclaration") continue;
    for (const specifier of item.specifiers) {
      if (specifier.type === "ImportSpecifier") {
        imports.set(specifier.local.value, [item.source.value, specifier.imported?.value ?? specifier.local.value]);
      } else namespaces.set(specifier.local.value, item.source.value);
    }
  }
  const bindings = new Map();
  const bind = (pattern) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") bindings.set(pattern.value, (bindings.get(pattern.value) ?? 0) + 1);
    else for (const child of children(pattern)) bind(child);
  };
  const declarations = [];
  const collect = (node) => {
    if (node.type === "VariableDeclarator") { bind(node.id); declarations.push(node); }
    if (node.type === "Parameter") bind(node.pat);
    if (node.type === "ArrowFunctionExpression") node.params.forEach(bind);
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") bind(node.identifier);
    for (const child of children(node)) collect(child);
  };
  collect(tree);
  const called = (node, module, names) => {
    if (node?.type !== "CallExpression") return false;
    const callee = node.callee;
    if (callee.type === "Identifier") {
      const entry = imports.get(callee.value);
      return !bindings.has(callee.value) && entry && [module, `node:${module}`].includes(entry[0]) && names.includes(entry[1]);
    }
    return callee.type === "MemberExpression" && callee.object.type === "Identifier"
      && !bindings.has(callee.object.value) && [module, `node:${module}`].includes(namespaces.get(callee.object.value))
      && names.includes(callee.property.value);
  };
  const args = (node) => node.arguments.map((arg) => arg.expression);
  const meta = (node, property) => node?.type === "MemberExpression" && compact(node) === `import.meta.${property}`;
  const dirnameExpression = (node) => called(node, "path", ["dirname"]) && args(node).length === 1
    && called(args(node)[0], "url", ["fileURLToPath"]) && args(args(node)[0]).length === 1
    && meta(args(args(node)[0])[0], "url");
  const dirnameBinding = declarations.find((node) => node.id.value === "__dirname" && dirnameExpression(node.init));
  const directoryShape = (node) => {
    if (dirnameExpression(node)) return SHAPES[0];
    if (node?.type === "Identifier" && node.value === "__dirname" && dirnameBinding && bindings.get("__dirname") === 1) return SHAPES[1];
    if (meta(node, "dirname")) return SHAPES[2];
    return undefined;
  };
  const contains = (node, predicate) => {
    if (!node || /Function|Class/.test(node.type ?? "")) return false;
    return predicate(node) || children(node).some((child) => contains(child, predicate));
  };
  const computations = [];
  const unsupported = [];
  const edits = [];
  const record = (node, shape, replacement) => {
    const entry = { shape, line: bytes.subarray(0, node.span.start - 1).toString().split("\n").length, expression: text(node) };
    computations.push(entry);
    if (replacement === undefined || /\b__testRepoRoot\b/.test(source)) unsupported.push(entry);
    else edits.push({ start: node.span.start - 1, end: node.span.end - 1, replacement });
  };
  const visit = (node) => {
    if (called(node, "path", ["join", "resolve"])) {
      const [directory, ...segments] = args(node);
      const shape = directoryShape(directory);
      if (shape && segments.length && segments.every((part) => part.type === "StringLiteral")) {
        const values = segments.map((part) => part.value);
        for (let n = 1; n <= values.length; n++) {
          if (!values.slice(0, n).every((value) => /^(?:\.\.(?:\/|$))+$/.test(value))) break;
          if (posix.resolve("/repo", posix.dirname(file), ...values.slice(0, n)) === "/repo") {
            const suffix = values.slice(n);
            record(node, shape, suffix.length
              ? `${text(node.callee)}(__testRepoRoot, ${suffix.map((value) => JSON.stringify(value)).join(", ")})`
              : "__testRepoRoot");
            return;
          }
        }
      }
    }
    if (called(node, "url", ["fileURLToPath"]) && args(node).length === 1) {
      const url = args(node)[0];
      if (url.type === "NewExpression" && url.callee.value === "URL" && !bindings.has("URL") && !imports.has("URL")) {
        const parts = args(url);
        const value = parts[0]?.value;
        if (parts.length === 2 && typeof value === "string" && /^(?:\.\.(?:\/|$))+$/.test(value)
          && meta(parts[1], "url") && posix.resolve("/repo", posix.dirname(file), value) === "/repo") {
          record(node, SHAPES[3], '(__testRepoRoot + "/")');
          return;
        }
      }
    }
    const before = computations.length;
    for (const child of children(node)) visit(child);
    if (computations.length !== before) return;
    if (node.type === "CallExpression" && contains(node, (part) => meta(part, "url") || meta(part, "dirname")
      || (part.type === "Identifier" && part.value === "__dirname"))
      && contains(node, (part) => part.type === "StringLiteral" && /(^|\/)\.\.(\/|$)/.test(part.value))) {
      record(node, "unsupported own-location expression");
      return;
    }
  };
  visit(tree);
  return { computations, unsupported, edits };
}

export function rewriteSource(source, file) {
  const result = analyzeSource(source, file);
  let bytes = Buffer.from(source);
  for (const edit of result.edits.toSorted((a, b) => b.start - a.start)) {
    bytes = Buffer.concat([bytes.subarray(0, edit.start), Buffer.from(edit.replacement), bytes.subarray(edit.end)]);
  }
  if (result.edits.length) {
    const prefix = 'import { REPO_ROOT as __testRepoRoot } from "#test/helpers/repo-root.js";\n';
    const rewritten = bytes.toString();
    const insertion = rewritten.startsWith("#!") ? rewritten.indexOf("\n") + 1 : 0;
    source = rewritten.slice(0, insertion) + prefix + rewritten.slice(insertion);
  }
  return { ...result, source };
}

if (isMainModule(import.meta.url)) {
  const write = process.argv.includes("--write");
  if (process.argv.slice(2).some((arg) => arg !== "--write")) throw new Error("usage: node scripts/test-repo-root-codemod.mjs [--write]");
  const counts = Object.fromEntries(SHAPES.map((shape) => [shape, 0]));
  const unsupported = [];
  let changed = 0;
  const files = testFiles(REPO_ROOT);
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    const result = rewriteSource(source, file);
    for (const entry of result.computations) if (entry.shape in counts) counts[entry.shape]++;
    unsupported.push(...result.unsupported.map((entry) => ({ file, ...entry })));
    if (result.source !== source) {
      changed++;
      if (write) writeFileSync(join(REPO_ROOT, file), result.source);
    }
  }
  console.log(JSON.stringify({ mode: write ? "write" : "dry-run", inspected: files.length, changed, counts, unsupported }, null, 2));
}
