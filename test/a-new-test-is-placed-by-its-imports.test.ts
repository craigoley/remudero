import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { testPlaceCommand } from "#src/run-task.js";
import {
  allFolderNames,
  extractTestFeatures,
  loadPlacementData,
  measureAgreement,
  parseTestFoldersTsv,
  placeFeatures,
  placeTest,
  populationFor,
  stripComments,
} from "#src/lib/test-placement.js";
import { RULE_SUITE_NAME_RE } from "#src/lib/rule-suites.js";

// W1-T9874: a test's folder is computed from its imports. The data under scripts/test-placement/
// is the only thing read; plan/seeds stays provenance.

const REPO_ROOT = join(import.meta.dirname, "..");
const data = loadPlacementData(REPO_ROOT);
const map = data.map;

function captured(run: () => number): { code: number; out: string; err: string } {
  const log = console.log;
  const error = console.error;
  let out = "";
  let err = "";
  console.log = (...a: unknown[]) => void (out += `${a.join(" ")}\n`);
  console.error = (...a: unknown[]) => void (err += `${a.join(" ")}\n`);
  try {
    return { code: run(), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("W1-T9874: a test importing only sweep is placed in sweep", () => {
  const text = 'import { sweep } from "#src/lib/sweep.js";\nimport { mergeState } from "../src/lib/merge-state.js";\n';
  const features = extractTestFeatures("test/a-pass-reaps-merged-branches.test.ts", text);
  assert.deepEqual(features.imports.map((i) => i.module).sort(), ["merge-state", "sweep"]);
  const placed = placeFeatures(features, map);
  assert.equal(placed.folder, "sweep");
  assert.equal(placed.primary, "sweep");
  assert.match(placed.reasons.join("\n"), /sweep scores/);
  // a src module the map has never seen is placed by subsystem_seed_rules, first regex wins
  const unseen = placeTest({ imports: [{ module: "serve-brand-new-thing", reach: "direct" }], name: "x" }, map);
  assert.equal(unseen.primary, "console-read-model", "a module absent from module_subsystem is placed by the first matching subsystem_seed_rules regex");
});

test("W1-T9874: the run-task hub defers to the imported symbol names", () => {
  const bare = placeTest({ imports: [{ module: "run-task", reach: "direct", symbols: ["x"] }], name: "a-thing" }, map);
  assert.equal(bare.folder, "worker/run-task", "with no vote the hub stays where it lives");
  const voted = placeTest({ imports: [{ module: "run-task", reach: "direct", symbols: ["lintPlanCommand"] }], name: "a-thing" }, map);
  assert.equal(voted.folder, "plan");
  assert.match(voted.reasons.join("\n"), /run-task hub defers/);
  assert.equal(voted.runnerUp, "worker-run");
});

test("W1-T9874: a suite that walks the repo as text is placed in rules", () => {
  const walk = ["execFileSync('git', ['ls-", "files', 'src/**/*.ts'], { cwd: REPO_ROOT });"].join("");
  const text = `import { x } from "#src/lib/sweep.js";\nconst REPO_ROOT = join(import.meta.dirname, "..");\n${walk}\n`;
  const features = extractTestFeatures("test/every-src-file-is-tracked.test.ts", text);
  assert.equal(features.kind, "rule");
  const placed = placeFeatures(features, map);
  assert.equal(placed.folder, "rules");
  assert.equal(placed.confidence, "high");
  // a behavioural test that merely reads one repo file stays with its subject
  const wiring = 'import { sweep } from "#src/lib/sweep.js";\nimport { readFileSync } from "node:fs";\nconst t = readFileSync(join(REPO_ROOT, "x"), "utf8");\n';
  assert.equal(placeFeatures(extractTestFeatures("test/y.test.ts", `const REPO_ROOT = join(import.meta.dirname, "..");\n${wiring}`), map).folder, "sweep");
});

test("W1-T9874: agreement with the reviewed map never falls below the recorded value", () => {
  assert.ok(data.recordedHighAgreement !== undefined, "test-folders.tsv's header must record the high-band agreement");
  assert.equal(data.folders.length, 3640);
  const { population, features } = populationFor(REPO_ROOT, data, "agreement-test");
  const bands = measureAgreement(data, (p) => features.get(p), population);
  const report = Object.entries(bands).map(([band, v]) => `${band} ${v.agree}/${v.total}=${(v.agree / v.total).toFixed(3)}`);
  console.log(`# W1-T9874 agreement by reviewed confidence band: ${report.join(", ")}`);
  const high = bands["high"];
  assert.ok(high !== undefined && high.total > 0, "the high band must be populated");
  assert.ok(
    high.agree / high.total >= (data.recordedHighAgreement as number),
    `high-band agreement ${(high.agree / high.total).toFixed(4)} fell below the recorded ${data.recordedHighAgreement}`,
  );
});

test("W1-T9874: no folder name reads as a rule suite", () => {
  const names = allFolderNames(map);
  assert.ok(names.length >= 25, "the 21 folders plus the second levels");
  for (const name of names) assert.doesNotMatch(name, RULE_SUITE_NAME_RE, `${name} would enrol every file under it as a rule suite`);
  for (const row of data.folders) assert.doesNotMatch(row.folder, RULE_SUITE_NAME_RE, row.testPath);
  assert.equal(map.folders.length, 21);
  assert.ok(map.folders.includes("rules"));
});

test("W1-T9874: the comment-aware scanner keeps code a regex stripper would eat", () => {
  const src = '// every src/**/*.ts file\nimport { a } from "#src/lib/clock.js";\nconst re = /\\/\\*/;\nconst s = `x ${"//"} y`; /* gone */ import { b } from "../src/lib/sweep.js";\n';
  const stripped = stripComments(src);
  assert.doesNotMatch(stripped, /every src/);
  assert.doesNotMatch(stripped, /gone/);
  assert.match(stripped, /clock\.js/);
  assert.match(stripped, /sweep\.js/);
});

test("W1-T9874: helpers are followed, type-only imports are weighed less and artifacts are strings", () => {
  const files: Record<string, string> = {
    "test/helpers/ledger-fixture.ts": 'import { appendLedger } from "../../src/lib/ledger.js";\n',
    "test/helpers/git-repo.ts": 'import { sweep } from "../../src/lib/sweep.js";\n',
  };
  const text = [
    'import type { Row } from "#src/lib/review.js";',
    'import { type Other } from "#src/lib/plan.js";',
    'import { gitRepo } from "./helpers/git-repo.js";',
    'import { ledgerFixture } from "./helpers/ledger-fixture.js";',
    'const w = ".github/workflows/ci.yml"; const s = "scripts/gate.mjs";',
  ].join("\n");
  const f = extractTestFeatures("test/z.test.ts", text, (p) => files[p], map);
  const by = Object.fromEntries(f.imports.map((i) => [i.module, i.reach]));
  assert.equal(by["review"], "type");
  assert.equal(by["plan"], "type");
  assert.equal(by["helper:git-repo"], "harness", "a generic helper counts as plumbing and is not followed");
  assert.equal(by["sweep"], undefined);
  assert.equal(by["helper:ledger-fixture"], "helper");
  assert.equal(by["ledger"], "helper", "a domain fixture's own src imports count toward its domain");
  assert.equal(by["artifact:ci-parity"], "artifact");
  assert.equal(by["gate"], "string");
});

test("W1-T9874: a test with no signal goes to infra with confidence none", () => {
  const placed = placeTest({ imports: [], name: "zzz" }, map);
  assert.deepEqual([placed.folder, placed.confidence], ["infra", "none"]);
});

test("W1-T9874: the TSV header's recorded agreement parses", () => {
  const parsed = parseTestFoldersTsv("# header. high-band agreement at commit: 0.5\ntest_path\tfolder\tkind\tconfidence\ntest/a.test.ts\tplan\tunit\thigh\n");
  assert.equal(parsed.recordedHighAgreement, 0.5);
  assert.deepEqual(parsed.rows, [{ testPath: "test/a.test.ts", folder: "plan", kind: "unit", confidence: "high" }]);
});

test("W1-T9874: rmd test-place prints the folder, confidence and reasons, and refuses bad input", () => {
  const ok = captured(() => testPlaceCommand(["test/coverage-ratchet.test.ts", "test/a-balanced-squeeze-diverts-to-foundry-sonnet.test.ts"], REPO_ROOT));
  assert.equal(ok.code, 0);
  assert.match(ok.out, /test\/coverage-ratchet\.test\.ts -> test\/rules\/ {2}\[high\]/);
  assert.match(ok.out, /-> test\/worker\/spawn\/ {2}\[high/);
  const json = captured(() => testPlaceCommand(["--json", "test/coverage-ratchet.test.ts"], REPO_ROOT));
  assert.equal((JSON.parse(json.out) as { placement: { folder: string } }[])[0]?.placement.folder, "rules");
  assert.equal(captured(() => testPlaceCommand([], REPO_ROOT)).code, 2);
  assert.equal(captured(() => testPlaceCommand(["--bogus", "x"], REPO_ROOT)).code, 2);
  const missing = captured(() => testPlaceCommand(["test/no-such-file.test.ts"], REPO_ROOT));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /does not exist/);
});
