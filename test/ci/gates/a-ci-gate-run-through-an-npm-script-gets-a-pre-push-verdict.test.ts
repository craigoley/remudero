/**
 * A CI GATE RUN THROUGH AN NPM SCRIPT GETS A PRE-PUSH VERDICT — W1-T14250.
 *
 * The author precheck asks every ci.yml script gate for a pre-push verdict, and a step counted as a gate only
 * when its step id or npm script name said ratchet, census, budget, monotonic, parity or signal. The write-only
 * ledger step ratchet (W1-T14149) runs as step `write-only-ledger-step` through `npm run --silent
 * write-only-ledger-step`; only the file that npm script runs says "ratchet", so a push was blind to it. The
 * population now follows each npm script to its scripts/*.mjs file, an unreadable package.json fails the census,
 * and the write-only gate is asked before the push by running its own CLI against the merge base.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-ignore the executable .mjs module has no declaration file.
import * as precheck from "#scripts/census-precheck.mjs";

type Verdict = { unasked: string[]; stale: string[]; grown: string[] };
type Child = { status: number | null; stdout: string };
const census = precheck as unknown as {
  ciScriptRatchetPopulation: (ci: string, pkg: string | null) => string[];
  npmScripts: (pkg: unknown) => Record<string, string>;
  scriptRatchetParityVerdict: (input: { population: string[]; baseline: Record<string, string> }) => Verdict;
  PRECHECK_SCRIPT_PARITY: Record<string, { modeled?: unknown; run?: unknown }>;
  writeOnlyLedgerStepViolations: (input: { changed: string[]; readHead: (p: string) => string | null; runRatchet?: () => Child }) => string[];
  runWriteOnlyLedgerStepChild: (input: { root: string; mergeBase: string; run?: (...args: unknown[]) => unknown }) => Child;
  evaluateCensusPrecheck: (input: unknown) => string[];
};
const CI = ".github/workflows/ci.yml";
const BASELINE = "scripts/write-only-ledger-step-baseline.json";
const GATE_WORDS = /ratchet|census|budget|monotonic|parity|signal/;

/** Steps whose ids and npm script names never say what they are: only the file each npm script runs can. */
const HIDDEN_CI = [
  "jobs:",
  "  gate:",
  "    steps:",
  "      - name: Unread steps",
  "        id: ledger-step-gate",
  "        run: npm run --silent unread-steps -- --base \"$GATE_BASE\"",
  "      - name: The same gate without --silent",
  "        id: ledger-step-gate-loud",
  "        run: npm run unread-steps-loud",
  "      - name: Build",
  "        id: build",
  "        run: npm run --silent build",
  "      - name: Format",
  "        id: fmt",
  "        run: npm run fmt",
].join("\n");
const HIDDEN_PACKAGE = JSON.stringify({
  scripts: {
    "unread-steps": "node scripts/unread-steps-ratchet.mjs",
    "unread-steps-loud": "node scripts/unread-steps-ratchet.mjs --verbose",
    build: "tsc -p .",
    fmt: "node scripts/format.mjs",
  },
});

test("W1-T14250 criterion 1: an npm script step joins the population by the gate file it runs, though neither its step id nor its npm script name says gate", () => {
  for (const named of ["ledger-step-gate unread-steps", "ledger-step-gate-loud unread-steps-loud"]) {
    assert.ok(!GATE_WORDS.test(named), `positive control: ${named} names no gate`);
  }
  assert.deepEqual(census.ciScriptRatchetPopulation(HIDDEN_CI, HIDDEN_PACKAGE), ["script:unread-steps", "script:unread-steps-loud"]);
  // Through the precheck itself: a push to ci.yml leaves the hidden gate with no verdict, and it is named.
  const named = census.evaluateCensusPrecheck({
    changed: [CI], measuredFiles: [], testFiles: [], srcFiles: [], readBase: () => null,
    readHead: (p: string) => (p === CI ? HIDDEN_CI : p === "package.json" ? HIDDEN_PACKAGE
      : p === "scripts/census-precheck-parity-baseline.json" ? JSON.stringify({ ciOnlyScripts: {} }) : null),
  }).filter((v) => v.startsWith("script-ratchet:"));
  assert.deepEqual(named.map((v) => /script:[\w-]+/.exec(v)?.[0]), ["script:unread-steps", "script:unread-steps-loud"]);
});

test("W1-T14250 criterion 1: a package.json edit alone asks the script census again", () => {
  const changedOnly = (changed: string[]) => census.evaluateCensusPrecheck({
    changed, measuredFiles: [], testFiles: [], srcFiles: [], readBase: () => null,
    readHead: (p: string) => (p === CI ? HIDDEN_CI : p === "package.json" ? HIDDEN_PACKAGE
      : p === "scripts/census-precheck-parity-baseline.json" ? JSON.stringify({ ciOnlyScripts: {} }) : null),
  }).filter((v) => v.startsWith("script-ratchet:"));
  assert.equal(changedOnly(["package.json"]).length, 2, "a renamed script file moves the population, so package.json triggers it");
  assert.deepEqual(changedOnly(["src/unrelated.ts"]), []);
});

test("W1-T14250 criterion 2: the real ci.yml and package.json put the write-only ledger step gate in the population, asked before the push", () => {
  const ci = readFileSync(join(REPO_ROOT, CI), "utf8");
  const pkg = readFileSync(join(REPO_ROOT, "package.json"), "utf8");
  assert.ok(ci.includes("id: write-only-ledger-step") && ci.includes("npm run --silent write-only-ledger-step"), "positive control: ci.yml runs the gate");
  assert.ok(!GATE_WORDS.test("write-only-ledger-step"), "positive control: its step id and npm name say no gate word");
  const population = census.ciScriptRatchetPopulation(ci, pkg);
  assert.ok(population.includes("script:write-only-ledger-step"), `the population includes the gate: ${population.join(", ")}`);
  assert.equal(census.PRECHECK_SCRIPT_PARITY["script:write-only-ledger-step"]?.modeled, census.writeOnlyLedgerStepViolations,
    "its verdict is the modeled check, which runs the gate's own CLI");
  const rows = (JSON.parse(readFileSync(join(REPO_ROOT, "scripts/census-precheck-parity-baseline.json"), "utf8")) as { ciOnlyScripts: Record<string, string> }).ciOnlyScripts;
  assert.ok(!("script:write-only-ledger-step" in rows), "asked, so never a ciOnlyScripts row");
  assert.deepEqual(census.scriptRatchetParityVerdict({ population, baseline: rows }).unasked, []);
});

test("W1-T14250 criterion 3: an npm script that runs no gate file stays out, and a package.json that cannot be read fails the census", () => {
  const population = census.ciScriptRatchetPopulation(HIDDEN_CI, HIDDEN_PACKAGE);
  assert.ok(!population.includes("script:build") && !population.includes("script:fmt"), population.join(", "));
  for (const [label, text, message] of [
    ["missing", null, /cannot be read/],
    ["not JSON", "{ scripts:", /is not JSON/],
    ["no scripts object", JSON.stringify({ name: "x" }), /no "scripts" object/],
    ["scripts is an array", JSON.stringify({ scripts: [] }), /no "scripts" object/],
  ] as const) {
    assert.throws(() => census.ciScriptRatchetPopulation(HIDDEN_CI, text), message, `${label} package.json fails, never names only`);
  }
  // The precheck refuses rather than read names only: its caller reports it as not measured.
  assert.throws(() => census.evaluateCensusPrecheck({
    changed: [CI], measuredFiles: [], testFiles: [], srcFiles: [], readBase: () => null,
    readHead: (p: string) => (p === CI ? HIDDEN_CI : p === "scripts/census-precheck-parity-baseline.json" ? JSON.stringify({ ciOnlyScripts: {} }) : null),
  }), /package\.json cannot be read/);
});

test("W1-T14250: the write-only check asks only a push that can move the gate, and reads the child's three outcomes", () => {
  let calls = 0;
  const child = (result: Child) => () => { calls++; return result; };
  const withBaseline = (p: string) => (p === BASELINE ? "{}" : null);
  const blocked = ["write-only-ledger-step: 9 step(s) emitted", "write-only-ledger-step: BLOCKED — 1 unrecorded, 0 stale", "", "WRITE-ONLY — …:", "  fixture.unread", "Give each a reader"].join("\n");
  assert.deepEqual(census.writeOnlyLedgerStepViolations({ changed: ["src/a.ts"], readHead: withBaseline }), [], "no child: not asked here");
  assert.deepEqual(census.writeOnlyLedgerStepViolations({ changed: ["src/a.ts"], readHead: () => null, runRatchet: child({ status: 1, stdout: blocked }) }), [],
    "a tree without the gate's baseline does not run the gate");
  assert.deepEqual(census.writeOnlyLedgerStepViolations({ changed: ["docs/x.md", "test/a.test.ts"], readHead: withBaseline, runRatchet: child({ status: 1, stdout: blocked }) }), []);
  assert.equal(calls, 0, "neither skip spawns the child");
  for (const changed of [["src/lib/a.ts"], [BASELINE], ["scripts/write-only-ledger-step-ratchet.mjs"]]) {
    assert.deepEqual(census.writeOnlyLedgerStepViolations({ changed, readHead: withBaseline, runRatchet: child({ status: 0, stdout: "OK" }) }), []);
  }
  const [violation, ...rest] = census.writeOnlyLedgerStepViolations({ changed: ["src/lib/a.ts"], readHead: withBaseline, runRatchet: child({ status: 1, stdout: blocked }) });
  assert.deepEqual(rest, []);
  assert.match(violation!, /BLOCKED — 1 unrecorded/);
  assert.match(violation!, /steps: fixture\.unread$/);
  assert.throws(() => census.writeOnlyLedgerStepViolations({ changed: ["src/lib/a.ts"], readHead: withBaseline, runRatchet: child({ status: 2, stdout: "write-only-ledger-step: MEASUREMENT FAILED — x" }) }),
    /could not measure \(exit 2\): write-only-ledger-step: MEASUREMENT FAILED — x/);
  assert.throws(() => census.writeOnlyLedgerStepViolations({ changed: ["src/lib/a.ts"], readHead: withBaseline, runRatchet: child({ status: null, stdout: "\nspawnSync node ETIMEDOUT" }) }),
    /could not measure \(exit null\): spawnSync node ETIMEDOUT/, "a child stopped on the backstop is not measured, never OK");
  assert.equal(calls, 6);
});

test("W1-T14250: the real child runs the gate's own CLI against the merge base, and a spawn error reaches its output", (t) => {
  const repo = gitRepo({ kind: "write-only-precheck" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "src", "lib"), { recursive: true });
  mkdirSync(join(repo.dir, "scripts"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "lib", "a.ts"), 'export function f(log: (s: string, o: object) => void) { log("fixture.unread", {}); }\n');
  const baseline = (writeOnly: string[]) => `${JSON.stringify({ _comment: "fixture", writeOnly, recordOnly: {} }, null, 2)}\n`;
  writeFileSync(join(repo.dir, BASELINE), baseline(["fixture.unread"]));
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "a debt entry for the one write-only step");
  const head = repo.git("rev-parse", "HEAD");
  const ok = census.runWriteOnlyLedgerStepChild({ root: repo.dir, mergeBase: head });
  assert.equal(ok.status, 0, ok.stdout);
  // The same step with no debt entry: the CLI refuses it, and the check names it.
  writeFileSync(join(repo.dir, BASELINE), baseline([]));
  const refused = census.runWriteOnlyLedgerStepChild({ root: repo.dir, mergeBase: head });
  assert.equal(refused.status, 1, refused.stdout);
  const [violation] = census.writeOnlyLedgerStepViolations({ changed: [BASELINE], readHead: (p) => (p === BASELINE ? "{}" : null), runRatchet: () => refused });
  assert.match(violation!, /steps: fixture\.unread/);
  const failed = census.runWriteOnlyLedgerStepChild({ root: repo.dir, mergeBase: head,
    run: () => ({ status: null, stdout: null, error: new Error("spawn node ENOENT") }) });
  assert.deepEqual(failed, { status: null, stdout: "\nspawn node ENOENT" });
});
