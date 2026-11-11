// @census-reads: .github/workflows/ scripts/ src/lib/
// @source-text-subject: the workflows' step text and each script's static import closure ARE this census's subject.
/**
 * W1-T11255 — A SCRIPT CI RUNS BEFORE `npm ci` IMPORTS ONLY BUILT-INS.
 *
 * #16275 added a module-scope `import { parseSync } from '@swc/core'` to scripts/mutation-ratchet.mjs.
 * The job's fast lane skips the install on a plan-only diff and then runs that script, so every
 * plan-only PR's mutation-ratchet died with ERR_MODULE_NOT_FOUND for 2.5 h. A script that runs with no
 * node_modules may load only Node built-ins and repo files while its module graph is linked; a package
 * loaded lazily inside a function is fine, because it is only fetched on the path that installed it.
 *
 * Pre-install steps of a job are: every step before its first install step; every step of a job with no
 * install step at all; and every step after an install step the fast lane can skip (an `if:` on it, or a
 * shell `exit 0` ahead of the install command in its body).
 *
 * FALSIFIER: the fixture copy of mutation-ratchet.mjs with the #16275 top-level import must fail the census.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules, stripTypeScriptTypes } from "node:module";
import { posix } from "node:path";
import { test } from "node:test";
import { parse as parseAcorn } from "acorn";
import { parse as parseYaml } from "yaml";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Step = { name?: string; if?: unknown; run?: string };
type Run = { workflow: string; job: string; step: string; script: string };
type Reader = (repoPath: string) => string | null;

const INSTALL_RE = /\bnpm ci\b/;
const BUILTINS = new Set(builtinModules);
const PACKAGE_IMPORTS: Record<string, string> = { "#src/": "src/", "#scripts/": "scripts/", "#test/": "test/" };

/** The pre-install `node scripts/<x>.mjs` invocations of one workflow file's jobs. */
function preInstallScriptRuns(workflow: string, text: string): Run[] {
  const runs: Run[] = [];
  const jobs = (parseYaml(text) as { jobs?: Record<string, { steps?: Step[] }> } | null)?.jobs ?? {};
  for (const [job, body] of Object.entries(jobs)) {
    const steps = body.steps ?? [];
    const install = steps.findIndex((s) => INSTALL_RE.test(s.run ?? ""));
    const canSkip = install >= 0 && (steps[install].if !== undefined
      || /\bexit 0\b[\s\S]*\bnpm ci\b/.test(steps[install].run ?? ""));
    steps.forEach((step, i) => {
      if (!(install < 0 || i < install || (canSkip && i > install))) return;
      for (const m of (step.run ?? "").matchAll(/(?<![\w.-])node((?:\s+-\S+)*)\s+scripts\/([\w.-]+\.mjs)\b/g)) {
        if (/--(?:import|loader|experimental-loader)\b/.test(m[1])) continue; // a loader needs node_modules itself
        runs.push({ workflow, job, step: step.name ?? `step ${i + 1}`, script: `scripts/${m[2]}` });
      }
    });
  }
  return runs;
}

function isBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0]);
}

function resolveSpecifier(spec: string, from: string): string | null {
  if (spec.startsWith(".")) return posix.normalize(posix.join(posix.dirname(from), spec));
  const alias = Object.keys(PACKAGE_IMPORTS).find((prefix) => spec.startsWith(prefix));
  return alias === undefined ? null : PACKAGE_IMPORTS[alias] + spec.slice(alias.length);
}

/** The module-scope import and export-from specifiers of one file; function bodies are never entered. */
function moduleScopeSpecifiers(path: string, text: string): string[] {
  const source = path.endsWith(".ts") ? stripTypeScriptTypes(text) : text;
  const program = parseAcorn(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const specs: string[] = [];
  for (const node of program.body) {
    if ((node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration"
      || node.type === "ExportNamedDeclaration") && node.source) specs.push(String(node.source.value));
  }
  return specs;
}

/** Every bare package a script's static closure reaches, each with the chain of files that leads to it. */
function packageImportChains(entry: string, read: Reader): string[][] {
  const found: string[][] = [];
  const seen = new Set<string>([entry]);
  const walk = (path: string, chain: string[]): void => {
    const text = read(path);
    if (text === null) { found.push([...chain, `<unreadable ${path}>`]); return; }
    if (!/\.(?:mjs|js|cjs|ts)$/.test(path)) return;
    for (const spec of moduleScopeSpecifiers(path, text)) {
      if (isBuiltin(spec)) continue;
      const target = resolveSpecifier(spec, path);
      if (target === null) { found.push([...chain, spec]); continue; }
      if (seen.has(target)) continue;
      seen.add(target);
      walk(target, [...chain, target]);
    }
  };
  walk(entry, [entry]);
  return found;
}

function violations(workflows: Record<string, string>, read: Reader): string[] {
  const out: string[] = [];
  for (const [workflow, text] of Object.entries(workflows)) {
    for (const run of preInstallScriptRuns(workflow, text)) {
      for (const chain of packageImportChains(run.script, read)) {
        out.push(`${run.workflow} job ${run.job} step "${run.step}" runs ${run.script} before an install can be relied on, `
          + `but its module scope reaches ${chain[chain.length - 1]}: ${chain.join(" -> ")}`);
      }
    }
  }
  return out;
}

const readTracked: Reader = (path) => (existsSync(`${REPO_ROOT}/${path}`) ? readFileSync(`${REPO_ROOT}/${path}`, "utf8") : null);
const WORKFLOW_DIR = ".github/workflows";
const realWorkflows = (): Record<string, string> => Object.fromEntries(readdirSync(`${REPO_ROOT}/${WORKFLOW_DIR}`)
  .filter((f) => f.endsWith(".yml")).map((f) => [f, readTracked(`${WORKFLOW_DIR}/${f}`) as string]));

const memory = (files: Record<string, string>): Reader => (path) => files[path] ?? null;
/** One import line whose specifier is a variable, so this file's own text carries no location-relative specifier. */
const imp = (spec: string): string => `import { x } from ${JSON.stringify(spec)};`;
const yamlJob = (steps: string) => `jobs:\n  j:\n    steps:\n${steps}`;

test("every pre-install node script in the workflows loads only built-ins and repo files at module scope", () => {
  const workflows = realWorkflows();
  const runs = Object.entries(workflows).flatMap(([name, text]) => preInstallScriptRuns(name, text));
  // Positive control: the census saw the population the task measured (13 distinct scripts), not an empty walk.
  assert.ok(new Set(runs.map((r) => r.script)).size >= 13, `the census saw ${runs.length} pre-install runs`);
  assert.ok(runs.some((r) => r.script === "scripts/mutation-ratchet.mjs"), "the #16275 script is in the population");
  assert.deepEqual(violations(workflows, readTracked), []);
});

test("which steps are pre-install: before the install, in a job with none, and after a skippable one", () => {
  const step = (name: string, run: string, cond = "") => `      - name: ${name}\n${cond}        run: ${run}\n`;
  const before = yamlJob(step("a", "node scripts/x.mjs") + step("install", "npm ci") + step("b", "node scripts/y.mjs"));
  assert.deepEqual(preInstallScriptRuns("w.yml", before).map((r) => r.script), ["scripts/x.mjs"]);
  const none = yamlJob(step("a", "node scripts/x.mjs") + step("b", "node scripts/y.mjs"));
  assert.deepEqual(preInstallScriptRuns("w.yml", none).map((r) => r.script), ["scripts/x.mjs", "scripts/y.mjs"]);
  const guarded = yamlJob(step("install", "npm ci", "        if: github.event_name == 'push'\n") + step("b", "node scripts/y.mjs"));
  assert.deepEqual(preInstallScriptRuns("w.yml", guarded).map((r) => r.script), ["scripts/y.mjs"]);
  const shellSkip = yamlJob(step("install", "|\n          [ \"$C\" = X ] && exit 0\n          npm ci") + step("b", "node scripts/y.mjs"));
  assert.deepEqual(preInstallScriptRuns("w.yml", shellSkip).map((r) => r.script), ["scripts/y.mjs"]);
  const loader = yamlJob(step("a", "node --import tsx scripts/x.mjs") + step("b", "node --expose-internals scripts/z.mjs"));
  assert.deepEqual(preInstallScriptRuns("w.yml", loader).map((r) => r.script), ["scripts/z.mjs"]);
});

test("a package reached through relative, aliased and re-export imports is reported with its chain", () => {
  const read = memory({
    "scripts/a.mjs": `${imp("./lib/b.mjs")}\nimport fs from 'node:fs';\nimport p from 'path/posix';\n`,
    "scripts/lib/b.mjs": "export * from '#scripts/lib/c.mjs';\n",
    "scripts/lib/c.mjs": "export { y } from 'left-pad';\n",
  });
  assert.deepEqual(packageImportChains("scripts/a.mjs", read),
    [["scripts/a.mjs", "scripts/lib/b.mjs", "scripts/lib/c.mjs", "left-pad"]]);
  const workflow = yamlJob("      - name: gate\n        run: node scripts/a.mjs\n");
  assert.deepEqual(violations({ "w.yml": workflow }, read), [
    `w.yml job j step "gate" runs scripts/a.mjs before an install can be relied on, but its module scope reaches left-pad: `
    + "scripts/a.mjs -> scripts/lib/b.mjs -> scripts/lib/c.mjs -> left-pad",
  ]);
});

test("a typescript leaf is read with its types stripped and a type-only package import is not a violation", () => {
  const read = memory({
    "scripts/a.mjs": `${imp("../src/lib/leaf.ts")}\n`,
    "src/lib/leaf.ts": "import type { Foo } from 'zod';\nexport const leaf: number = 1;\n",
  });
  assert.deepEqual(packageImportChains("scripts/a.mjs", read), []);
});

test("W1-T11255 criterion 2: a package loaded lazily in a function passes, and the #16275 top-level import fails", () => {
  const lazy = memory({
    "scripts/a.mjs": [
      "import { createRequire } from 'node:module';",
      "export function f() { return createRequire(import.meta.url)('@swc/core'); }",
      "export async function g() { return await import('@swc/core'); }",
      "",
    ].join("\n"),
  });
  assert.deepEqual(packageImportChains("scripts/a.mjs", lazy), []);

  const main = readTracked("scripts/mutation-ratchet.mjs");
  assert.ok(main !== null, "scripts/mutation-ratchet.mjs exists");
  const lazyLoad = "const { parseSync } = createRequire(import.meta.url)('@swc/core');";
  assert.ok(main.includes(lazyLoad), "main loads @swc/core lazily, inside the function");
  // Appended: imports hoist, and the script's own shebang line must stay first.
  const at16275 = `${main.replace(lazyLoad, "")}\nimport { parseSync } from '@swc/core';\n`;
  const workflow = yamlJob("      - name: trigger\n        run: node scripts/mutation-ratchet.mjs --changed-files c.txt\n");
  const read: Reader = (path) => (path === "scripts/mutation-ratchet.mjs" ? at16275 : readTracked(path));
  const found = violations({ "ci.yml": workflow }, read);
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], /job j step "trigger" runs scripts\/mutation-ratchet\.mjs .*scripts\/mutation-ratchet\.mjs -> @swc\/core$/);
  assert.deepEqual(violations({ "ci.yml": workflow }, readTracked), [], "main's copy passes");
});
