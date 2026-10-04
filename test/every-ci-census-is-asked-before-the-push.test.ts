/**
 * EVERY CI CENSUS IS ASKED BEFORE THE PUSH, OR NAMED AS CI-ONLY — W1-T5616.
 *
 * ci.yml's rule-checks step runs every suite `listRuleSuites` selects (102 on 2026-10-04), and the
 * ci/coverage shards run the census suites no census name advertises. scripts/census-precheck.mjs
 * asked four of them, and nothing recorded which of the rest a push is blind to: fleet PRs went
 * red in CI on negative-reachability (#9066 #9077 #9079), DECISION_RELEVANT_LEDGER_STEPS /
 * SPEND_STEP_ROLES (#8988 #9041), ENV_REGISTRY (#8972), bound-kind-declared (#8961),
 * host-capability-fixtures (#8994) and catch-erasure (#8970) after census-precheck said OK.
 *
 * This census gives each one a verdict: on `PRECHECK_PARITY` (precheck asks it) or in
 * scripts/census-precheck-parity-baseline.json (CI-only today, a list that may only shrink). A new
 * CI census in neither is named here at birth.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MIN_RULE_SUITE_COUNT, listRuleSuites } from "../src/lib/ci-parity.js";
import { gitRepo } from "./helpers/git-repo.js";
import {
  PRECHECK_EXTRA_CI_CENSUSES,
  PRECHECK_PARITY,
  PRECHECK_PARITY_BASELINE,
  ciCensusPopulation,
  precheckParityVerdict,
  // @ts-ignore the executable .mjs module has no declaration file.
} from "../scripts/census-precheck.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Verdict = { unasked: string[]; stale: string[]; grown: string[] };
type ParityEntry = { modeled?: unknown; run?: unknown };

function readBaseline(text: string): string[] {
  const doc = JSON.parse(text) as { ciOnly?: unknown };
  assert.ok(Array.isArray(doc.ciOnly), `${PRECHECK_PARITY_BASELINE} must carry a "ciOnly" array`);
  return doc.ciOnly as string[];
}

const baseline = readBaseline(readFileSync(join(ROOT, PRECHECK_PARITY_BASELINE), "utf8"));
const population: string[] = ciCensusPopulation(listRuleSuites(ROOT));

test("W1-T5616: every census suite CI runs is asked by census-precheck or listed in the shrink-only baseline", () => {
  // THE CORPUS CONTROL: a population that stopped seeing the tree would read as a clean sheet.
  assert.ok(population.length >= MIN_RULE_SUITE_COUNT + 4, `the population must be read, saw ${population.length}`);
  for (const known of ["test/clock-signature-census.test.ts", "test/negative-reachability-ratchet.test.ts"]) {
    assert.ok(population.includes(known), `the population must include ${known}`);
  }
  const verdict = precheckParityVerdict({ population, baseline }) as Verdict;
  assert.deepEqual(
    verdict.unasked,
    [],
    "a CI census census-precheck does not ask: model it in PRECHECK_PARITY (scripts/census-precheck.mjs) — " +
      `${PRECHECK_PARITY_BASELINE} may only shrink`,
  );
  assert.deepEqual(
    verdict.stale,
    [],
    `a baselined suite precheck now asks, or CI no longer runs, must leave ${PRECHECK_PARITY_BASELINE}`,
  );
  const doc = JSON.parse(readFileSync(join(ROOT, PRECHECK_PARITY_BASELINE), "utf8")) as { _comment: string };
  assert.match(doc._comment, /may only shrink/);
});

test("W1-T5616: the population is what CI runs — a workflow runs list-rule-suites, and each extra is a tracked suite", () => {
  const dir = join(ROOT, ".github", "workflows");
  const runners = readdirSync(dir)
    .filter((name) => name.endsWith(".yml"))
    .filter((name) => /scripts\/list-rule-suites\.mjs --run/.test(readFileSync(join(dir, name), "utf8")));
  assert.deepEqual(runners, ["ci.yml"], "CI's rule-check step must be the one that runs listRuleSuites' population");
  const tracked = spawnSync("git", ["ls-files", "--", "test"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n");
  const ruleSuites = new Set(listRuleSuites(ROOT));
  for (const [path, incident] of Object.entries(PRECHECK_EXTRA_CI_CENSUSES as Record<string, string>)) {
    assert.ok(tracked.includes(path), `${path} must be a tracked suite (CI's shards run every test/*.test.ts)`);
    assert.ok(!ruleSuites.has(path), `${path} is already in listRuleSuites — drop it from PRECHECK_EXTRA_CI_CENSUSES`);
    assert.match(incident, /#\d+/, `${path} must name the incident that put it here`);
  }
});

test("W1-T5616: every PRECHECK_PARITY entry names a real suite and how census-precheck asks it", () => {
  const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> })
    .scripts;
  const entries = Object.entries(PRECHECK_PARITY as Record<string, ParityEntry>);
  assert.ok(entries.length >= 6, `PRECHECK_PARITY must be read, saw ${entries.length}`);
  for (const [path, entry] of entries) {
    assert.ok(existsSync(join(ROOT, path)), `${path} is on PRECHECK_PARITY but does not exist`);
    const modeled = typeof entry.modeled === "function";
    const run = typeof entry.run === "string" && entry.run in scripts;
    assert.ok(modeled !== run, `${path} must carry exactly one of {modeled: <check fn>} or {run: <npm script>}`);
  }
});

test("W1-T5616: the baseline may only shrink — no row is absent from the merge base's baseline", (t) => {
  const mergeBase = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: ROOT, encoding: "utf8" });
  if (mergeBase.status !== 0) {
    t.skip(`origin/main is not resolvable here (${mergeBase.stderr.trim()}); CI checks out with fetch-depth 0`);
    return;
  }
  const shown = spawnSync("git", ["show", `${mergeBase.stdout.trim()}:${PRECHECK_PARITY_BASELINE}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const baseBaseline = shown.status === 0 ? readBaseline(shown.stdout) : null;
  const verdict = precheckParityVerdict({ population, baseline, baseBaseline }) as Verdict;
  assert.deepEqual(verdict.grown, [], "a new CI census is modeled in PRECHECK_PARITY, never added to the baseline");
});

test("W1-T5616 falsifier: deleting one baseline row names that suite", () => {
  const victim = "test/negative-reachability-ratchet.test.ts";
  assert.ok(baseline.includes(victim), "the falsifier needs a baselined suite");
  const verdict = precheckParityVerdict({ population, baseline: baseline.filter((p) => p !== victim) }) as Verdict;
  assert.deepEqual(verdict.unasked, [victim]);
});

test("W1-T5616 falsifier: deleting one PRECHECK_PARITY entry names that suite", () => {
  const victim = "test/clock-signature-census.test.ts";
  const parity = { ...(PRECHECK_PARITY as Record<string, ParityEntry>) };
  assert.ok(victim in parity, "the falsifier needs an asked suite");
  delete parity[victim];
  const verdict = precheckParityVerdict({ population, baseline, parity }) as Verdict;
  assert.deepEqual(verdict.unasked, [victim]);
});

test("W1-T5616 falsifier: a new suite named x-census.test.ts is enumerated from the tree and named", () => {
  const repo = gitRepo({ seedCommit: false, kind: "ci-census-parity" });
  try {
    mkdirSync(join(repo.dir, "test"));
    const filler = Array.from({ length: MIN_RULE_SUITE_COUNT }, (_, i) => `test/filler-${i}-ratchet.test.ts`);
    for (const path of [...filler, "test/x-census.test.ts", "test/not-a-rule.test.ts"]) {
      writeFileSync(join(repo.dir, path), "");
    }
    repo.git("add", "--", "test");
    const fixturePopulation = ciCensusPopulation(listRuleSuites(repo.dir), {});
    const verdict = precheckParityVerdict({ population: fixturePopulation, baseline: filler, parity: {} }) as Verdict;
    assert.deepEqual(verdict.unasked, ["test/x-census.test.ts"]);
  } finally {
    repo.cleanup();
  }
});

test("W1-T5616: a row precheck now asks, or CI no longer runs, is stale; a row the merge base lacked is grown", () => {
  const parity = { "test/asked-census.test.ts": { modeled: () => [] } };
  const verdict = precheckParityVerdict({
    population: ["test/asked-census.test.ts", "test/old-census.test.ts", "test/new-census.test.ts"],
    baseline: ["test/asked-census.test.ts", "test/gone-census.test.ts", "test/old-census.test.ts", "test/new-census.test.ts"],
    baseBaseline: ["test/asked-census.test.ts", "test/gone-census.test.ts", "test/old-census.test.ts"],
    parity,
  }) as Verdict;
  assert.deepEqual(verdict.unasked, []);
  assert.deepEqual(verdict.stale, ["test/asked-census.test.ts", "test/gone-census.test.ts"]);
  assert.deepEqual(verdict.grown, ["test/new-census.test.ts"]);
  const fresh = precheckParityVerdict({ population: [], baseline: ["test/new-census.test.ts"], parity }) as Verdict;
  assert.deepEqual(fresh.grown, [], "a baseline the merge base did not carry has nothing to have grown from");
});

test("W1-T5616: the extras join the rule-check population once each, sorted", () => {
  const joined = ciCensusPopulation(["test/b-census.test.ts", "test/a-census.test.ts"], {
    "test/c.test.ts": "#1",
    "test/a-census.test.ts": "#2",
  });
  assert.deepEqual(joined, ["test/a-census.test.ts", "test/b-census.test.ts", "test/c.test.ts"]);
  assert.deepEqual(ciCensusPopulation([]), Object.keys(PRECHECK_EXTRA_CI_CENSUSES).sort());
});
