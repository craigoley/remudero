import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: the worker's registration source is the input to the parity parser.
test("W1-T10798: a new CI census is refused until the worker registers it", async () => {
  const workerPath = join(REPO_ROOT, "scripts/census-precheck.mjs");
  const worker = await import(pathToFileURL(workerPath).href);
  const source = readFileSync(workerPath, "utf8");
  const added = "test/ci/gates/new-worker-census.test.ts";
  const changed = ["scripts/census-precheck.mjs"];
  const evaluate = (text: string): string[] => worker.censusParityViolations({
    changed,
    population: [added],
    readHead: (path: string) => path === "scripts/census-precheck.mjs" ? text : '{"ciOnly":[]}',
  });

  const refused = evaluate(source);
  assert.equal(refused.length, 1);
  assert.match(refused[0]!, /new-worker-census\.test\.ts.*model it in PRECHECK_PARITY/);

  const registered = source.replace("export const PRECHECK_PARITY = {",
    `export const PRECHECK_PARITY = {\n  "${added}": { modeled: () => [] },`);
  assert.notEqual(registered, source, "the fixture must modify the worker registration");
  assert.deepEqual(evaluate(registered), []);
});
