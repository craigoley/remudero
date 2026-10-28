import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const nowIso = "2026-10-28T04:20:00.000Z";
const consent = JSON.stringify({ version: "field-trials-consent-v1",
  repos: [{ repo: "o/r", rights: "aggregate-opt-in", receipt: "owner-2026-10-27-test" }] });

type Placement = "owner-only" | "group-readable" | "symlink" | "absent" | "override";

function writeConsent(path: string, mode: number) {
  const previous = process.umask(0o022);
  try { writeFileSync(path, consent, { mode }); }
  finally { process.umask(previous); }
}

/** One full refresh pass through the real script with a fake docker that runs the real command. */
function pass(placement: Placement) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-consent-refresh-"));
  const stateDir = join(dir, "core", "state"), outDir = join(stateDir, "field-trials"), bin = join(dir, "bin");
  mkdirSync(outDir, { recursive: true }); mkdirSync(bin);
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  writeFileSync(join(outDir, "case-files-latest.json"), "[]");
  for (const name of ["site", "console"]) {
    mkdirSync(join(dir, name, "state"), { recursive: true });
    writeFileSync(join(dir, name, "state", "ledger.ndjson"), "");
  }
  const registry = join(dir, "instances.yaml");
  writeFileSync(registry, ["core", "site", "console"].map(name => `  ${name}:\n    state_dir: ${join(dir, name)}\n`).join(""));
  const target = join(outDir, "field-trials-consent-v1.json");
  const elsewhere = join(dir, "owner-grant.json");
  if (placement === "owner-only") writeConsent(target, 0o600);
  if (placement === "group-readable") writeConsent(target, 0o640);
  if (placement === "symlink") { writeConsent(elsewhere, 0o600); symlinkSync(elsewhere, target); }
  if (placement === "override") writeConsent(elsewhere, 0o600);
  const driver = join(dir, "driver.mjs");
  const flowUrl = pathToFileURL(join(REPO_ROOT, "src/lib/field-trials-flow.ts")).href;
  writeFileSync(driver, `import { fieldTrialsCommand, buildFieldTrialsFlowSnapshot } from ${JSON.stringify(flowUrl)};
const args = process.argv.slice(2);
const refresh = args.flatMap((arg, i) => arg.startsWith('--refresh-') ? [arg, ...(arg === '--refresh-record-only' ? [] : [args[i+1]])] : []);
const consent = args.includes('--consent') ? ['--consent', process.env.TEST_CONSENT_SRC] : [];
process.exitCode = await fieldTrialsCommand(['--offline', '--source', 'core=o/r', '--ledger', 'core='+process.env.TEST_STATE,
  '--out-dir', process.env.TEST_OUT, '--case-files', process.env.TEST_OUT+'/case-files-latest.json', ...consent, ...refresh],
  buildFieldTrialsFlowSnapshot, { nowIso: ${JSON.stringify(nowIso)}, resolveConfig: () => ({ root: process.env.TEST_ROOT }) });
`);
  writeFileSync(join(bin, "docker"), `#!/bin/bash
if [[ "$1" == inspect ]]; then echo test-image; exit 0; fi
if [[ "$1" == exec && "$*" == *printenv* ]]; then echo test-credential; exit 0; fi
printf '%s\\n' "$*" >> "$TEST_CALLS"
case "$*" in *private-routing-daily-review.mjs*|*private-field-trials-case-files.mjs*) exit 0;; esac
for arg in "$@"; do
  if [[ "$arg" == *dst=/field-trials/consent.json* ]]; then src="\${arg#*src=}"; export TEST_CONSENT_SRC="\${src%%,*}"; fi
done
while [[ $# -gt 0 && "$1" != field-trials ]]; do shift; done
shift
exec "$TEST_NODE" --import tsx "$TEST_DRIVER" "$@"
`); chmodSync(join(bin, "docker"), 0o700);
  const result = spawnSync("bash", [join(REPO_ROOT, "deploy/field-trials-refresh.sh")], { cwd: REPO_ROOT, encoding: "utf8",
    env: { ...process.env, NODE_V8_COVERAGE: "", PATH: `${bin}:${process.env.PATH}`, RMD_INSTANCE_REGISTRY: registry,
      RMD_FIELD_TRIALS_CASE_FILES: "", RMD_FIELD_TRIALS_CONSENT: placement === "override" ? elsewhere : "",
      TEST_NODE: process.execPath, TEST_DRIVER: driver, TEST_ROOT: dir, TEST_STATE: stateDir, TEST_OUT: outDir,
      TEST_CALLS: join(dir, "calls") } });
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  const rows = readFileSync(join(stateDir, "ledger.ndjson"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const mode = placement === "group-readable" ? statSync(target).mode & 0o777 : null;
  rmSync(dir, { recursive: true, force: true });
  return { result, calls, rows, mode, target, elsewhere };
}

test("W1-T10832: the refresh passes the private consent file only when it is owner-only", () => {
  for (const placement of ["owner-only", "override", "group-readable", "symlink", "absent"] as const) {
    const run = pass(placement);
    assert.equal(run.result.status, 0, `${placement}: ${run.result.stderr}`);
    const snapshot = run.calls.find(call => call.includes(" field-trials ") && call.includes("--max-pages"));
    assert.ok(snapshot, `${placement}: the snapshot step ran`);
    assert.ok(run.calls.some(call => call.includes("private-routing-daily-review.mjs")), `${placement}: routing review ran`);
    assert.ok(run.calls.some(call => call.includes("private-field-trials-case-files.mjs")), `${placement}: case files ran`);
    assert.equal(run.rows.filter(row => row.step === "field-trials.refresh").length, 1, `${placement}: one refresh row`);
    const siteImport = run.rows.filter(row => row.step === "field-trials.site-import");
    assert.equal(siteImport.length, 1, `${placement}: one site-import outcome`);
    const passed = placement === "owner-only" || placement === "override";
    assert.equal(snapshot.includes("--consent /field-trials/consent.json"), passed, `${placement}: --consent passed`);
    const src = placement === "override" ? run.elsewhere : run.target;
    assert.equal(snapshot.includes(`src=${src},dst=/field-trials/consent.json,readonly`), passed, `${placement}: consent mount`);
    // The command saw a valid grant only when passed; otherwise the release is withheld for want of one.
    assert.deepEqual({ state: siteImport[0].state, reason: siteImport[0].reason },
      { state: "withheld", reason: passed ? "offline-pass" : "no-consent-receipt" }, placement);
    if (!passed && placement !== "absent") assert.match(run.result.stderr, /consent file is not an owner-only regular file/);
    if (placement === "group-readable") assert.equal(run.mode, 0o640, "the hardening sweep never rewrites the owner's grant");
  }
});
