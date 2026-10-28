import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "#test/helpers/repo-root.js";
// @ts-ignore the executable .mjs module has no declaration file.
import { censusParityViolations, ciCensusPopulation } from "#scripts/census-precheck.mjs";
import { listRuleSuites } from "#src/lib/ci-parity.js";

const BASELINE = "scripts/census-precheck-parity-baseline.json";
const REAL = (JSON.parse(readFileSync(join(repoRoot(), BASELINE), "utf8")) as { ciOnly: string[] }).ciOnly;
const baselineText = (rows: string[]) => JSON.stringify({ ciOnly: rows });

test("W1-T10798: check:test:test/every-ci-census-is-asked-before-the-push.test.ts is prevented, not retried", () => {
  const population = ciCensusPopulation(listRuleSuites(repoRoot()));
  assert.ok(population.length > 50, "positive control: the population saw the tree");
  const readHead = (text: string) => (p: string) => (p === BASELINE ? text : null);
  // An unasked CI census, with a test in the diff, is refused before the push.
  const unasked = censusParityViolations({
    changed: ["test/x.test.ts"],
    readHead: readHead(baselineText(REAL)),
    population: [...population, "test/brand-new-census.test.ts"],
  });
  assert.equal(unasked.length, 1);
  assert.match(unasked[0], /test\/brand-new-census\.test\.ts.*PRECHECK_PARITY/);
  // A baseline row for a suite CI no longer runs is stale and named.
  const stale = censusParityViolations({
    changed: [BASELINE],
    readHead: readHead(baselineText([...REAL, "test/gone.test.ts"])),
    population,
  });
  assert.equal(stale.length, 1);
  assert.match(stale[0], /test\/gone\.test\.ts.*delete the row/);
  // Unrelated diffs and unmeasured populations stay silent.
  assert.deepEqual(censusParityViolations({ changed: ["src/a.ts"], readHead: readHead(baselineText(REAL)), population: [...population, "test/z.test.ts"] }), []);
  assert.deepEqual(censusParityViolations({ changed: [BASELINE], readHead: readHead(baselineText([])) }), []);
  assert.deepEqual(censusParityViolations({ changed: [BASELINE], readHead: () => null, population }), []);
  assert.deepEqual(censusParityViolations({ changed: [BASELINE], readHead: readHead("{bad"), population }), []);
});
