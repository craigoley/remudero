import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { execWhitelistedProof, parseWhitelistedProof, pinnedVitestCli } from "#src/lib/review.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const TARGET = { owner: "craigoley", repo: "wreckterra" };
const TITLE = "fixture invariant";

function runnerFixture(t: TestContext, fail = false) {
  const { dir } = ownedFixtureDir(t, "wreckterra-proof-runner");
  mkdirSync(join(dir, "tests/unit"), { recursive: true });
  mkdirSync(join(dir, "node_modules/vitest"), { recursive: true });
  writeFileSync(join(dir, "tests/unit/sample.test.mjs"),
    `import assert from "node:assert/strict";\nexport const title = "${TITLE}";\nexport default () => assert.equal(${fail ? "2" : "1"}, 1);\n`);
  // A controlled runner fixture exercises the real process boundary and TAP classifier.
  // Actual Vitest engine qualification belongs to the live Wreckterra checkout receipt.
  writeFileSync(join(dir, "node_modules/vitest/vitest.mjs"), `
import {writeFileSync} from "node:fs";
import check, {title} from "../../tests/unit/sample.test.mjs";
writeFileSync("argv.json", JSON.stringify(process.argv.slice(2)));
const filter = process.argv.indexOf("-t");
const selected = filter < 0 || process.argv[filter + 1] === title;
let failed = false;
if (selected) { try { check(); } catch { failed = true; } }
process.stdout.write("TAP version 13\\n1..1\\nok 1 - tests/unit/sample.test.mjs # time=1ms {\\n    1..1\\n    " +
  (failed ? "not ok" : "ok") + " 1 - " + title + (selected ? " # time=1ms" : " # SKIP") + "\\n}\\n");
process.exitCode = failed ? 1 : 0;
`);
  return dir;
}

function execute(dir: string, title: string) {
  const proof = parseWhitelistedProof(`unit test: ${title}`, TARGET);
  assert.ok(proof, "the exact owned target must resolve");
  return execWhitelistedProof(proof, dir, 10_000, undefined, { preflightBrowsers: () => {} });
}

test("W1-T10614: Wreckterra proofs execute only the registered pinned web runner", (t) => {
  for (const path of ["tests/unit/sample.test.ts", "tests/browser/driving.spec.ts"]) {
    const proof = parseWhitelistedProof(`unit test: ${path}`, TARGET);
    assert.ok(proof);
    assert.equal(proof.runner, "vitest");
    assert.deepEqual(proof.args, [pinnedVitestCli(process.cwd()), "run", path]);
  }
  const dir = runnerFixture(t);
  assert.equal(execute(dir, TITLE), "pass");
  const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"));
  assert.deepEqual(argv, ["run", "--reporter=tap", "-t", TITLE, "tests/unit/sample.test.mjs"]);
});

test("W1-T10614: unknown owners and zero matching web tests refuse acceptance", (t) => {
  for (const target of [{ owner: "another-owner", repo: "wreckterra" }, { owner: "craigoley", repo: "unregistered" }]) {
    assert.equal(parseWhitelistedProof(`unit test: ${TITLE}`, target), null);
    assert.equal(parseWhitelistedProof("unit test: tests/unit/sample.test.ts", target), null);
  }
  assert.equal(parseWhitelistedProof("unit test: tests/../../escape.test.ts", TARGET), null);
  assert.equal(parseWhitelistedProof("unit test: test/core.test.ts", TARGET), null);
  assert.equal(execute(runnerFixture(t), "absent title"), "no-match");
});

test("W1-T10614: a failing Wreckterra test cannot produce a passing proof", (t) => {
  assert.equal(execute(runnerFixture(t, true), TITLE), "fail");
});

test("managed discovery includes only the exact owned Wreckterra addition", () => {
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, ".remudero/managed-repos.json"), "utf8"));
  assert.deepEqual(registry.repos, ["craigoley/remudero-site", "craigoley/remudero-console", "craigoley/wreckterra"]);
});

test("existing registered proof runners retain their roots and target ownership", () => {
  const core = parseWhitelistedProof("unit test: test/example.test.ts", { owner: "craigoley", repo: "remudero" });
  assert.equal(core?.runner, undefined);
  assert.deepEqual(core?.args, ["--test", "--test-reporter=tap", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "test/example.test.ts"]);
  for (const repo of ["remudero-site", "remudero-console"]) {
    const proof = parseWhitelistedProof("unit test: tests/unit/example.test.ts", { owner: "craigoley", repo });
    assert.equal(proof?.runner, "vitest");
    assert.deepEqual(proof?.args, [pinnedVitestCli(process.cwd()), "run", "tests/unit/example.test.ts"]);
    assert.equal(parseWhitelistedProof(`unit test: ${TITLE}`, { owner: "another-owner", repo }), null);
  }
});
