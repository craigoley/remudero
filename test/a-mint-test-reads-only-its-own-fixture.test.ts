import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSync } from "@swc/core";

import { gitRepo } from "./helpers/git-repo.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function unscopedMintCalls(source: string, file: string): string[] {
  const parsed = parseSync(source, { syntax: "typescript", target: "es2022" });
  const importedNames = new Set<string>();
  for (const item of parsed.body) {
    if (item.type !== "ImportDeclaration" || !item.source.value.endsWith("/run-task.js")) continue;
    for (const specifier of item.specifiers) {
      if (specifier.type !== "ImportSpecifier") continue;
      if ((specifier.imported ?? specifier.local).value === "nextTaskIdCommand") importedNames.add(specifier.local.value);
    }
  }
  if (importedNames.size === 0) importedNames.add("nextTaskIdCommand");
  const failures: string[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, unknown>;
    const callee = node.callee as { type?: string; value?: string } | undefined;
    if (node.type === "CallExpression" && callee?.type === "Identifier" && importedNames.has(callee.value ?? "")) {
      const argumentsList = node.arguments as Array<{ expression?: unknown }>;
      const args = JSON.stringify(argumentsList[0]?.expression ?? "");
      const deps = JSON.stringify(argumentsList[2]?.expression ?? "");
      // A prefixed mint reads its target clone. These two argument refusals return before minting.
      const doesNotMint = args.includes('"--prefix"') || args.includes('"--bogus"') ||
        (args.includes('"--reserve"') && args.includes('"--offline"'));
      if (!doesNotMint && !args.includes('"--plan"') && !deps.includes("repoRoot")) {
        const span = node.span as { start: number };
        const line = Buffer.from(source).subarray(0, span.start - 1).toString().split("\n").length;
        failures.push(`${file}:${line}`);
      }
    }
    Object.values(node).forEach(visit);
  }
  visit(parsed);
  return failures;
}

test("W1-T4473: no mint suite calls the command without its own plan", () => {
  assert.deepEqual(unscopedMintCalls("nextTaskIdCommand([], {}, {})", "control.test.ts"), ["control.test.ts:1"]);
  const failures = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .flatMap((name) => unscopedMintCalls(readFileSync(join(TEST_DIR, name), "utf8"), name));
  assert.deepEqual(failures, [], `mint calls reading the checkout plan: ${failures.join(", ")}`);
});

test("W1-T4473: a default-family mint passes from a checkout behind origin", () => {
  const origin = gitRepo({ bare: true, kind: "mint-behind-origin" });
  const work = gitRepo({ kind: "mint-origin-work" });
  mkdirSync(join(work.dir, "plan"), { recursive: true });
  writeFileSync(join(work.dir, "plan", "tasks.yaml"), "- id: W1-T5\n  title: seed\n");
  work.git("add", "plan/tasks.yaml");
  work.git("commit", "--quiet", "-m", "seed plan");
  work.addRemote("origin", origin.dir);
  work.git("push", "--quiet", "origin", "main");
  const behind = gitRepo({ cloneFrom: origin.dir, kind: "mint-behind-checkout" });
  writeFileSync(join(work.dir, "plan", "tasks.yaml"), "- id: W1-T9\n  title: newer\n");
  work.git("add", "plan/tasks.yaml");
  work.git("commit", "--quiet", "-m", "advance plan");
  work.git("push", "--quiet", "origin", "main");
  behind.git("fetch", "--quiet", "origin", "main");

  const fixture = gitRepo({ kind: "mint-own-plan" });
  mkdirSync(join(fixture.dir, "plan"), { recursive: true });
  writeFileSync(join(fixture.dir, "plan", "tasks.yaml"), "- id: W1-T5\n  title: own seed\n");
  fixture.git("add", "plan/tasks.yaml");
  fixture.git("commit", "--quiet", "-m", "own plan");

  const moduleUrl = new URL("../src/run-task.ts", import.meta.url).href;
  const run = (injected: boolean) => spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e",
    `import { nextTaskIdCommand } from ${JSON.stringify(moduleUrl)}; process.exitCode = await nextTaskIdCommand(["--no-reserve"], {}, { ${injected ? `repoRoot: ${JSON.stringify(fixture.dir)}, ` : ""}openPrTexts: () => [] });`,
  ], { cwd: behind.dir, encoding: "utf8" });
  const control = run(false);
  assert.equal(control.status, 1, control.stderr);
  assert.match(control.stdout, /DEGRADED: local-plan/, control.stderr);
  const isolated = run(true);
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.match(isolated.stdout, /^W1-T6 /m);
  assert.doesNotMatch(isolated.stdout, /DEGRADED/);
});
