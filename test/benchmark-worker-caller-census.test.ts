import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
type Kind = "call" | "parameter-default" | "injected-default";
type Site = { file: string; line: number; kind: Kind };

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

function sites(file: string, text: string): Site[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
  const found: Site[] = [];
  for (const [index, line] of code.split("\n").entries()) {
    if (line.trimStart().startsWith("`")) continue; // diagnostic template prose, not a call site
    if (/\bspawnWorker\s*\(/.test(line) && !/\bfunction\s+spawnWorker\b/.test(line))
      found.push({ file, kind: "call", line: index + 1 });
    if (/\braw\s*:\s*typeof\s+spawnWorker\s*=\s*spawnWorker\b/.test(line))
      found.push({ file, kind: "parameter-default", line: index + 1 });
    if (/\?\?\s*spawnWorker\b/.test(line))
      found.push({ file, kind: "injected-default", line: index + 1 });
  }
  return found;
}

/** Direct entrypoints are bounded by the central worker, the dispatch wrapper and the auxiliary
 * wrapper. A new one is reported as local coverage debt, never a PR-stopping check. */
const classified: Record<string, Partial<Record<Kind, number>>> = {
  "src/lib/worker.ts": { call: 3 }, // provider fallback recursion inherits the caller's assignment sink
  "src/lib/benchmark-run.ts": { "parameter-default": 1 },
  "src/run-task.ts": { "parameter-default": 1, "injected-default": 1 },
};

function unclassified(all: Site[]): Site[] {
  const seen = new Map<string, number>();
  return all.filter((site) => {
    const key = `${site.file}:${site.kind}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count > (classified[site.file]?.[site.kind] ?? 0);
  });
}

test("benchmark worker caller census catches an unclassified spawn", () => {
  const planted = sites("src/lib/new-caller.ts", "export const call = () => spawnWorker({});");
  assert.deepEqual(unclassified(planted), [{ file: "src/lib/new-caller.ts", line: 1, kind: "call" }]);

  const actual = sources(join(root, "src")).flatMap((path) => sites(relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8")));
  assert.ok(actual.filter((site) => site.file === "src/lib/worker.ts" && site.kind === "call").length >= 3,
    "positive control: the census sees the three known recursive provider fallbacks");
  const orchestration = readFileSync(join(root, "src/run-task.ts"), "utf8");
  for (const lane of ["inbox-draft", "review", "triage", "risk-judge"]) {
    assert.ok(orchestration.includes(`ledgeredNonDispatchSpawn("${lane}")`)
      || orchestration.includes(`benchmarkNonDispatchSpawn("${lane}")`), `${lane} is in the worker population`);
  }
  for (const site of unclassified(actual)) {
    console.warn(JSON.stringify({ event: "benchmark.caller_coverage_debt", ...site,
      reason: "unclassified-spawn-site", followup: "file-worker-evidence-task" }));
  }
});
