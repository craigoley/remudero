/**
 * EVERY CI SCRIPT RATCHET HAS A PRE-PUSH VERDICT — W1-T5737.
 *
 * W1-T5616 gave each census SUITE CI runs a verdict (asked by census-precheck, or on the shrink-only
 * `ciOnly` baseline). The script gates ci.yml runs as steps of their own — learnings-budget,
 * claude-md-budget, cycle, comment-load-signal, expiring-fixture-census, baseline-monotonic, the
 * coverage and mutation ratchets — were in no population, so a new one could join CI with nothing
 * naming that a push is blind to it. This census reads them out of ci.yml, keys each `script:<name>`,
 * and gives each a verdict: asked (PRECHECK_SCRIPT_PARITY) or a `ciOnlyScripts` row with its reason.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A NAMESPACE import, so a tree without these exports fails each test below rather than the load.
// @ts-ignore the executable .mjs module has no declaration file.
import * as precheck from "../scripts/census-precheck.mjs";

const { PRECHECK_SCRIPT_PARITY, ciScriptRatchetPopulation, scriptRatchetParityVerdict } = precheck;
const BASELINE = "scripts/census-precheck-parity-baseline.json";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Verdict = { unasked: string[]; stale: string[]; grown: string[] };

function readRows(text: string): Record<string, string> {
  const doc = JSON.parse(text) as { ciOnlyScripts?: unknown };
  assert.ok(
    typeof doc.ciOnlyScripts === "object" && doc.ciOnlyScripts !== null && !Array.isArray(doc.ciOnlyScripts),
    `${BASELINE} must carry a "ciOnlyScripts" object of script:<name> -> reason`,
  );
  return doc.ciOnlyScripts as Record<string, string>;
}

function live(): { baseline: Record<string, string>; population: string[] } {
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  return { baseline: readRows(readFileSync(join(ROOT, BASELINE), "utf8")), population: ciScriptRatchetPopulation(ci) };
}

const FIXTURE_CI = [
  "jobs:",
  "  gate:",
  "    steps:",
  "      - name: A brand-new ratchet",
  "        id: shiny-ratchet",
  "        run: npm run --silent shiny-ratchet",
  "      - name: A census run by node",
  "        run: node scripts/fixture-census.mjs --base HEAD",
  "      - name: unrelated",
  "        run: npm run --silent lint",
  "      - name: again",
  "        id: shiny-ratchet",
  "        run: npm run --silent shiny-ratchet",
].join("\n");

test("W1-T5737: the population reads npm-run and node-script ratchet steps out of ci.yml, once each", () => {
  assert.deepEqual(ciScriptRatchetPopulation(FIXTURE_CI), ["script:fixture-census", "script:shiny-ratchet"]);
  const { population } = live();
  for (const known of [
    "script:learnings-budget-ratchet",
    "script:claude-md-budget-ratchet",
    "script:cycle-ratchet",
    "script:comment-load-signal",
    "script:expiring-fixture-census",
    "script:baseline-monotonic-check",
    "script:coverage-merge-ratchet",
    "script:mutation-ratchet",
  ]) {
    assert.ok(population.includes(known), `the population must include ${known}, saw ${population.join(", ")}`);
  }
});

test("W1-T5737: a fixture script step with no verdict fails by name, and passes once baselined or asked", () => {
  const population = ciScriptRatchetPopulation(FIXTURE_CI);
  const none = scriptRatchetParityVerdict({ population, baseline: {}, parity: {} }) as Verdict;
  assert.deepEqual(none.unasked, ["script:fixture-census", "script:shiny-ratchet"]);

  const baselined = scriptRatchetParityVerdict({
    population,
    baseline: { "script:fixture-census": "CI-only: a fixture", "script:shiny-ratchet": "CI-only: a fixture" },
    parity: {},
  }) as Verdict;
  assert.deepEqual(baselined.unasked, []);

  const asked = scriptRatchetParityVerdict({
    population,
    baseline: {},
    parity: { "script:fixture-census": { run: "x" }, "script:shiny-ratchet": { run: "y" } },
  }) as Verdict;
  assert.deepEqual(asked.unasked, []);

  const stale = scriptRatchetParityVerdict({
    population,
    baseline: { "script:shiny-ratchet": "r", "script:gone": "r" },
    parity: { "script:fixture-census": { run: "x" } },
  }) as Verdict;
  assert.deepEqual(stale.stale, ["script:gone"]);
  const grown = scriptRatchetParityVerdict({
    population,
    baseline: { "script:shiny-ratchet": "r", "script:fixture-census": "r" },
    baseBaseline: { "script:shiny-ratchet": "r" },
    parity: {},
  }) as Verdict;
  assert.deepEqual(grown.grown, ["script:fixture-census"]);
});

test("W1-T5737: every script ratchet ci.yml runs is asked before the push or has a reasoned ciOnlyScripts row", () => {
  const { baseline, population } = live();
  assert.ok(population.length >= 8, `the population must be read, saw ${population.length}`);
  const verdict = scriptRatchetParityVerdict({ population, baseline }) as Verdict;
  assert.deepEqual(
    verdict.unasked,
    [],
    `a ci.yml script gate nothing asks before the push: model it in PRECHECK_SCRIPT_PARITY (scripts/census-precheck.mjs), ` +
      `or record a reason under ciOnlyScripts in ${BASELINE} — that section may only shrink`,
  );
  assert.deepEqual(verdict.stale, [], `a baselined script now asked, or no longer in ci.yml, must leave ${BASELINE}`);
  for (const [key, reason] of Object.entries(baseline)) {
    assert.ok(typeof reason === "string" && reason.length >= 20, `${key} needs a reason that says why it is not asked`);
  }
});

test("W1-T5737: every PRECHECK_SCRIPT_PARITY entry names how the push asks it", () => {
  const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> })
    .scripts;
  const entries = Object.entries(PRECHECK_SCRIPT_PARITY as Record<string, { modeled?: unknown; run?: unknown }>);
  assert.ok(entries.length >= 2, "PRECHECK_SCRIPT_PARITY must be read");
  for (const [key, entry] of entries) {
    assert.match(key, /^script:/);
    const modeled = typeof entry.modeled === "function";
    const run = typeof entry.run === "string" && entry.run in scripts;
    assert.ok(modeled !== run, `${key} must carry exactly one of {modeled: <check fn>} or {run: <npm script>}`);
  }
});

test("W1-T5737: the ciOnlyScripts section may only shrink — no row is absent from the merge base", (t) => {
  const { baseline, population } = live();
  const mergeBase = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: ROOT, encoding: "utf8" });
  if (mergeBase.status !== 0) {
    t.skip(`origin/main is not resolvable here (${mergeBase.stderr.trim()}); CI checks out with fetch-depth 0`);
    return;
  }
  const shown = spawnSync("git", ["show", `${mergeBase.stdout.trim()}:${BASELINE}`], { cwd: ROOT, encoding: "utf8" });
  let baseBaseline: Record<string, string> | null = null;
  if (shown.status === 0) {
    const doc = JSON.parse(shown.stdout) as { ciOnlyScripts?: Record<string, string> };
    // The merge base before this census landed has no section: nothing it carried can be "grown" against.
    baseBaseline = doc.ciOnlyScripts ?? null;
  }
  const verdict = scriptRatchetParityVerdict({ population, baseline, baseBaseline }) as Verdict;
  assert.deepEqual(verdict.grown, [], "a new ci.yml script gate is modeled in PRECHECK_SCRIPT_PARITY, never added to ciOnlyScripts");
});
