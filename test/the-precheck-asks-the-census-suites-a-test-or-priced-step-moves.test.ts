import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-ignore the executable .mjs module has no declaration file.
import * as precheck from "../scripts/census-precheck.mjs";

const PRICED = "test/every-priced-ledger-step-is-in-the-config-garden-read.test.ts";
const HOST = "test/host-capability-fixtures.test.ts";
const SOURCE = "src/lib/example.ts";
const FIXTURE = "test/nested/example.test.ts";
const permissionSite = "chmodSync" + "(path, 0o555);";

function evaluate(path: string, head: string | null, base: string | null = "", failing: string[] = []) {
  const runs: string[][] = [];
  const result = precheck.evaluateAdmittedCensusSuites({
    changed: [path],
    readHead: () => head,
    readBase: () => base,
    loadMembers: () => [],
    runSuites: (files: string[]) => { runs.push(files); return failing; },
  });
  return { result, runs, started: runs.flat() };
}

test("test/the-precheck-asks-the-census-suites-a-test-or-priced-step-moves.test.ts: priced writes and host tokens start their censuses; neither starts no child", () => {
  const priced = evaluate(SOURCE, 'log(PRICED_STEP, { cost_usd: 3 });', "", [PRICED]);
  assert.deepEqual(priced.runs, [[PRICED]]);
  assert.deepEqual(priced.result, {
    violations: [`census-suite: ${PRICED} fails — run npm run census:every-priced-ledger-step; register CONFIG_GARDEN_LEDGER_STEPS in src/lib/config-gardener.ts or a reasoned exemption in ${PRICED}`],
    unmeasured: null,
  });
  const host = evaluate(FIXTURE, permissionSite, "", [HOST]);
  assert.deepEqual(host.runs, [[HOST]]);
  assert.deepEqual(host.result, {
    violations: [`census-suite: ${HOST} fails — run npm run census:host-capability-fixtures; own the fixture's host condition or declare its reason in ${HOST}`],
    unmeasured: null,
  });
  for (const path of [SOURCE, FIXTURE]) {
    const unrelated = evaluate(path, "const value = 2;", "const value = 1;");
    assert.deepEqual(unrelated.runs, []);
    assert.deepEqual(unrelated.result, { violations: [], unmeasured: null });
  }
});

test("the priced prefilter reads literal logs, constant logs and step objects, including multiline payload additions", () => {
  for (const text of [
    'deps.logWorker("fresh.step", { pr_url: url });',
    'log(PRICED_STEP, { cost_usd: 0 });',
    'appendLedger(p, { step: "fresh.step", cost_usd: 2 });',
    'return { step: PRICED_STEP, nested: { pr_url: url } };',
    'return { nested: { n: 1 }, step: PRICED_STEP, cost_usd: 2 };',
    'log(PRICED_STEP, {\n  nested: { n: f(1) },\n  cost_usd: 2,\n});',
  ]) {
    assert.ok(evaluate(SOURCE, text).started.includes(PRICED), text);
    assert.deepEqual(evaluate(SOURCE, text + "\nconst unrelated = 2;", text).runs, []);
    assert.ok(evaluate(SOURCE, text + "\n" + text, text).started.includes(PRICED));
    assert.deepEqual(evaluate(SOURCE, null, text).runs, []);
    assert.ok(!evaluate(FIXTURE, text).started.includes(PRICED));
  }
  const base = 'log(PRICED_STEP, {\n  reason: "x",\n});';
  assert.deepEqual(evaluate(SOURCE, base.replace('reason: "x",', 'reason: "x",\n  cost_usd: 2,'), base).runs, [[PRICED]]);
  const oldStep = 'return { step: OLD_STEP,\n  pr_url: url,\n};';
  assert.deepEqual(evaluate(SOURCE, oldStep.replace("OLD_STEP", "NEW_STEP"), oldStep).runs, [[PRICED]]);
  for (const text of ['log(PRICED_STEP, { total_cost_usd: 3 });', 'log(PRICED_STEP, {});', 'const row = { cost_usd: 2 };', 'step: PRICED_STEP; cost_usd']) {
    assert.ok(!evaluate(SOURCE, text).started.includes(PRICED), text);
  }
  assert.deepEqual(evaluate("src/lib/config-gardener.ts", "", "").runs, [[PRICED]]);
});

test("the host prefilter asks on each added token line and on duplicate sites, excluding unchanged and removed lines", () => {
  for (const text of [permissionSite, "process.platform", "process.getuid()", "hostname()", "/usr/bin/" + "date"]) {
    assert.deepEqual(evaluate(FIXTURE, text).runs, [[HOST]], text);
    assert.deepEqual(evaluate(FIXTURE, text + "\nconst value = 2;", text).runs, []);
    assert.deepEqual(evaluate(FIXTURE, text + "\n" + text, text).runs, [[HOST]]);
    assert.deepEqual(evaluate(FIXTURE, null, text).runs, []);
    assert.ok(!evaluate(SOURCE, text).started.includes(HOST));
  }
  assert.deepEqual(evaluate("docs/example.md", permissionSite).runs, []);
});

test("both censuses share the existing child, propagate failures, and keep unreadable measurements distinct", () => {
  const runs: string[][] = [];
  const input = {
    changed: [SOURCE, FIXTURE],
    readHead: (path: string) => path === SOURCE ? 'log(PRICED_STEP, { cost_usd: 3 });' : permissionSite,
    readBase: () => "",
    loadMembers: () => [{ testFile: PRICED, script: "census:every-priced-ledger-step", walks: ["src/"] }],
    runSuites: (files: string[]) => { runs.push(files); return [PRICED, HOST]; },
  };
  const found = precheck.evaluateAdmittedCensusSuites(input);
  assert.deepEqual(runs, [[PRICED, HOST]]);
  assert.equal(found.violations.length, 2);
  assert.equal(found.unmeasured, null);
  assert.deepEqual(precheck.evaluateAdmittedCensusSuites({ ...input, readHead: () => { throw new Error("cannot read head"); } }),
    { violations: [], unmeasured: "cannot read head" });
  assert.deepEqual(precheck.evaluateAdmittedCensusSuites({ ...input, runSuites: () => { throw new Error("child timed out"); } }),
    { violations: [], unmeasured: "child timed out" });
  assert.deepEqual(precheck.evaluateAdmittedCensusSuites({ changed: [FIXTURE], loadMembers: () => [], runSuites: () => { throw new Error("must not spawn"); } }),
    { violations: [], unmeasured: null });
});

test("the two triggered censuses have executable scripts, parity entries and CI population membership", () => {
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
  const ciOnly = JSON.parse(readFileSync(new URL("../scripts/census-precheck-parity-baseline.json", import.meta.url), "utf8")).ciOnly;
  for (const [testFile, script] of [[PRICED, "census:every-priced-ledger-step"], [HOST, "census:host-capability-fixtures"]]) {
    const member = precheck.PRECHECK_TRIGGERED_SUITES.find((m: { testFile: string }) => m.testFile === testFile);
    assert.ok(member, `${testFile} has a trigger row`);
    assert.equal(member.script, script);
    assert.deepEqual(precheck.PRECHECK_PARITY[testFile], { run: script });
    assert.equal(scripts[script], `node --test --import tsx --import ./test/setup/tmp-hygiene.ts ${testFile}`);
    assert.ok(precheck.ciCensusPopulation([]).includes(testFile));
    assert.ok(!ciOnly.includes(testFile));
  }
});
