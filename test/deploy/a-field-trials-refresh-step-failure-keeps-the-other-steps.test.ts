import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { fieldTrialsCommand, buildFieldTrialsFlowSnapshot } from "#src/lib/field-trials-flow.js";
import { parseRefreshSteps, recordFieldTrialsRefresh } from "#src/lib/field-trials-refresh.js";
import type { IssueGateway } from "#src/lib/escalate.js";

const nowIso = "2026-10-28T04:20:00.000Z";
const blob = "a".repeat(40);
const steps = (routing = 0, cases = 0, snapshot = 0) => [
  { name: "routing-review", state: routing ? "failed" : "ok", exitCode: routing },
  { name: "case-files", state: cases ? "failed" : "ok", exitCode: cases },
  { name: "snapshot", state: snapshot ? "failed" : "ok", exitCode: snapshot },
] as const;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-refresh-test-"));
  const stateDir = join(dir, "core", "state"), outDir = join(stateDir, "field-trials");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  return { dir, stateDir, outDir, close: () => rmSync(dir, { recursive: true, force: true }) };
}
function outcomes(stateDir: string) {
  return readFileSync(join(stateDir, "ledger.ndjson"), "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line)).filter(row => row.step === "field-trials.refresh");
}

function shellPass(f: ReturnType<typeof fixture>, routing: number, cases: number, snapshot: number,
  options: { credentialFailure?: boolean; noPreviousCases?: boolean } = {}) {
  const bin = join(f.dir, "bin"); mkdirSync(bin);
  const registry = join(f.dir, "instances.yaml");
  for (const name of ["site", "console"]) {
    mkdirSync(join(f.dir, name, "state"), { recursive: true });
    writeFileSync(join(f.dir, name, "state", "ledger.ndjson"), "");
  }
  writeFileSync(registry, ["core", "site", "console"].map(name => `  ${name}:\n    state_dir: ${join(f.dir, name)}\n`).join(""));
  const driver = join(f.dir, "driver.mjs");
  const flowUrl = pathToFileURL(join(REPO_ROOT, "src/lib/field-trials-flow.ts")).href;
  writeFileSync(driver, `import { fieldTrialsCommand, buildFieldTrialsFlowSnapshot } from ${JSON.stringify(flowUrl)};
const args = process.argv.slice(2);
const refresh = args.flatMap((arg, i) => arg.startsWith('--refresh-') ? [arg, ...(arg === '--refresh-record-only' ? [] : [args[i+1]])] : []);
const cases = args.includes('--case-files') ? ['--case-files', process.env.TEST_OUT+'/case-files-latest.json'] : [];
process.exitCode = await fieldTrialsCommand(['--offline', '--source', 'core=o/r', '--ledger', 'core='+process.env.TEST_STATE,
  '--out-dir', process.env.TEST_OUT, ...cases, ...refresh], buildFieldTrialsFlowSnapshot,
  { nowIso: ${JSON.stringify(nowIso)}, resolveConfig: () => ({ root: process.env.TEST_ROOT }) });
`);
  if (!options.noPreviousCases) writeFileSync(join(f.outDir, "case-files-latest.json"), "[]");
  const docker = join(bin, "docker");
  writeFileSync(docker, `#!/bin/bash
if [[ "$1" == inspect ]]; then echo test-image; exit 0; fi
if [[ "$1" == exec && "$*" == *printenv* ]]; then
  if [[ ${options.credentialFailure ? 1 : 0} == 1 ]]; then exit 1; fi
  echo test-credential; exit 0
fi
printf '%s\\n' "$*" >> "$TEST_CALLS"
case "$*" in
  *private-routing-daily-review.mjs*) exit ${routing};;
  *private-field-trials-case-files.mjs*) exit ${cases};;
esac
while [[ $# -gt 0 && "$1" != field-trials ]]; do shift; done
shift
if [[ " $* " != *" --refresh-record-only "* && ${snapshot} != 0 ]]; then exit ${snapshot}; fi
exec "$TEST_NODE" --import tsx "$TEST_DRIVER" "$@"
`); chmodSync(docker, 0o700);
  return spawnSync("bash", [join(REPO_ROOT, "deploy/field-trials-refresh.sh")], { cwd: REPO_ROOT, encoding: "utf8",
    env: { ...process.env, NODE_V8_COVERAGE: "", PATH: `${bin}:${process.env.PATH}`, RMD_INSTANCE_REGISTRY: registry,
      RMD_FIELD_TRIALS_CASE_FILES: "", TEST_NODE: process.execPath, TEST_DRIVER: driver,
      TEST_ROOT: f.dir, TEST_STATE: f.stateDir, TEST_OUT: f.outDir, TEST_CALLS: join(f.dir, "calls") } });
}

test("W1-T10830: a failed routing review still produces a partial snapshot naming it", () => {
  const f = fixture();
  try {
    const result = shellPass(f, 7, 0, 0);
    assert.equal(result.status, 1, result.stderr);
    const snapshot = JSON.parse(readFileSync(join(f.outDir, "field-trials-flow-v1.json"), "utf8"));
    assert.equal(snapshot.state, "observed-partial");
    assert.deepEqual(snapshot.refresh.steps, steps(7));
    assert.equal(snapshot.refresh.state, "partial");
    assert.match(readFileSync(join(f.dir, "calls"), "utf8"), /private-field-trials-case-files.mjs/);
    assert.equal(outcomes(f.stateDir).length, 1);
    assert.match(outcomes(f.stateDir)[0].scriptBlob, /^[0-9a-f]{40}$/);
  } finally { f.close(); }
});

test("W1-T10830: every refresh pass ledgers its step states", () => {
  for (const allFailed of [false, true]) {
    const f = fixture();
    try {
      writeFileSync(join(f.outDir, "field-trials-refresh-v1.json"), JSON.stringify({
        lastGoodSnapshotAsOf: "2026-10-18T04:28:00.000Z", steps: [], alerts: {} }));
      const result = shellPass(f, 7, allFailed ? 8 : 0, allFailed ? 9 : 0);
      assert.equal(result.status, 1, result.stderr);
      const rows = outcomes(f.stateDir);
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].steps, steps(7, allFailed ? 8 : 0, allFailed ? 9 : 0));
      assert.equal(rows[0].lastGoodSnapshotAsOf, "2026-10-18T04:28:00.000Z");
      assert.equal(rows[0].snapshotAsOf, allFailed ? null : nowIso);
    } finally { f.close(); }
  }
});

test("refresh recurrence raises one alert per step and recovery resolves it", () => {
  const f = fixture();
  const created: string[] = [], closed: string[] = [];
  const issues: IssueGateway = { create: title => { created.push(title); return `https://example.org/${created.length}`; },
    listOpen: () => [], closeWithComment: url => { closed.push(url); } };
  try {
    const run = (codes: ReturnType<typeof steps>) => recordFieldTrialsRefresh({ outDir: f.outDir, ledgerPath: join(f.stateDir, "ledger.ndjson"),
      asOf: nowIso, scriptBlob: blob, steps: codes, snapshotAsOf: null, issues });
    run(steps(7)); assert.equal(created.length, 0);
    run(steps(7)); assert.equal(created.length, 1);
    run(steps(7)); assert.equal(created.length, 1);
    run(steps()); assert.deepEqual(closed, ["https://example.org/1"]);
    assert.equal(outcomes(f.stateDir).length, 4);
  } finally { f.close(); }
});

test("case-file failure keeps the previous file and labels the snapshot partial", () => {
  const f = fixture();
  try {
    const result = shellPass(f, 0, 8, 0);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(readFileSync(join(f.outDir, "case-files-latest.json"), "utf8"), "[]");
    const snapshot = JSON.parse(readFileSync(join(f.outDir, "field-trials-flow-v1.json"), "utf8"));
    assert.equal(snapshot.refresh.caseFilesFallback, "previous");
    assert.equal(snapshot.state, "observed-partial");
  } finally { f.close(); }
});

test("a credential outage attempts an offline snapshot and records the failed case step", () => {
  const f = fixture();
  try {
    const result = shellPass(f, 0, 0, 0, { credentialFailure: true });
    assert.equal(result.status, 1, result.stderr);
    const snapshot = JSON.parse(readFileSync(join(f.outDir, "field-trials-flow-v1.json"), "utf8"));
    assert.deepEqual(snapshot.refresh.steps, steps(0, 1));
    assert.match(readFileSync(join(f.dir, "calls"), "utf8"), /--offline/);
    assert.equal(outcomes(f.stateDir).length, 1);
  } finally { f.close(); }
});

test("a case-file failure without a previous snapshot names the missing fallback", () => {
  const f = fixture();
  try {
    const result = shellPass(f, 0, 8, 0, { noPreviousCases: true });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /no previous case-file snapshot/);
    assert.equal(outcomes(f.stateDir).length, 1);
    const snapshot = JSON.parse(readFileSync(join(f.outDir, "field-trials-flow-v1.json"), "utf8"));
    assert.equal(snapshot.refresh.caseFilesFallback, "none");
    assert.equal(snapshot.state, "observed-partial");
  } finally { f.close(); }
});

test("a successful refresh advances the last good snapshot and records no fallback", () => {
  const f = fixture();
  try {
    const result = shellPass(f, 0, 0, 0);
    assert.equal(result.status, 0, result.stderr);
    const [outcome] = outcomes(f.stateDir);
    assert.equal(outcome.snapshotAsOf, nowIso);
    assert.equal(outcome.lastGoodSnapshotAsOf, nowIso);
    assert.equal(outcome.caseFilesFallback, "none");
    assert.deepEqual(outcome.steps, steps());
  } finally { f.close(); }
});

test("record-only validates metadata and does not rebuild a snapshot", async () => {
  const f = fixture();
  try {
    const args = ["--refresh-record-only", "--offline", "--out-dir", f.outDir, "--ledger", `core=${f.stateDir}`,
      "--refresh-script-blob", blob, "--refresh-step", "routing-review=7", "--refresh-step", "case-files=8",
      "--refresh-step", "snapshot=9"];
    const input = { nowIso, print: () => {}, resolveConfig: () => ({ root: f.dir }) };
    assert.equal(await fieldTrialsCommand(args, () => { throw new Error("must not build"); }, input), 0);
    assert.equal(existsSync(join(f.outDir, "field-trials-flow-v1.json")), false);
    assert.equal(outcomes(f.stateDir).length, 1);
    assert.equal(await fieldTrialsCommand([...args, "--refresh-step", "snapshot=0"], buildFieldTrialsFlowSnapshot, input), 2);
  } finally { f.close(); }
});

test("refresh history and alert transport failures remain explicit while the pass is ledgered", () => {
  const f = fixture();
  const historyPath = join(f.outDir, "field-trials-refresh-v1.json");
  let closeFails = true;
  const issues: IssueGateway = { create: () => { throw new Error("offline"); }, listOpen: () => [],
    closeWithComment: () => { if (closeFails) throw new Error("close offline"); } };
  try {
    const run = (codes: ReturnType<typeof steps>) => recordFieldTrialsRefresh({ outDir: f.outDir,
      ledgerPath: join(f.stateDir, "ledger.ndjson"), asOf: nowIso, scriptBlob: blob, steps: codes,
      snapshotAsOf: null, priorSnapshotAsOf: "2026-10-18T04:28:00.000Z", issues });
    writeFileSync(historyPath, "{invalid");
    assert.match(run(steps(7)).alertErrors[0]!, /history unreadable/);
    const undelivered = run(steps(7));
    assert.deepEqual(undelivered.alerts, {});
    assert.deepEqual(undelivered.alertErrors, ["routing-review: escalation not delivered"]);
    writeFileSync(historyPath, JSON.stringify({ ...undelivered, alerts: { "routing-review": "https://example.org/1" } }));
    const unresolved = run(steps());
    assert.match(unresolved.alertErrors[0]!, /close offline/);
    assert.equal(unresolved.alerts["routing-review"], "https://example.org/1");
    closeFails = false;
    assert.deepEqual(run(steps()).alerts, {});
    assert.equal(outcomes(f.stateDir).length, 4);
    writeFileSync(historyPath, "null");
    assert.match(run(steps()).alertErrors[0]!, /invalid refresh history/);
  } finally { f.close(); }
});

test("refresh metadata rejects missing, duplicated, inconsistent and invalid step exit codes", () => {
  for (const values of [["unknown=0"], ["routing-review=0"], ["routing-review=0=0"],
    ["routing-review=-1"], ["routing-review=256"], ["routing-review=bad"],
    ["routing-review=0", "case-files=0", "snapshot=7"]]) {
    assert.throws(() => parseRefreshSteps(values, false));
  }
  assert.deepEqual(parseRefreshSteps(["routing-review=0", "case-files=skipped"], false), [
    steps()[0], { name: "case-files", state: "skipped", exitCode: null }, steps()[2],
  ]);
  assert.throws(() => parseRefreshSteps(["routing-review=0", "case-files=0", "snapshot=0"], true));
});

test("a partial snapshot never becomes the last good snapshot on a later failed pass", () => {
  const f = fixture();
  try {
    const input = { outDir: f.outDir, ledgerPath: join(f.stateDir, "ledger.ndjson"), asOf: nowIso, scriptBlob: blob,
      steps: steps(7), snapshotAsOf: nowIso, issues: { create: () => "https://example.org/1", listOpen: () => [] } };
    assert.equal(recordFieldTrialsRefresh(input).lastGoodSnapshotAsOf, null);
    assert.equal(recordFieldTrialsRefresh({ ...input, priorSnapshotAsOf: nowIso }).lastGoodSnapshotAsOf, null);
    assert.equal(outcomes(f.stateDir).length, 2);
  } finally { f.close(); }
});
