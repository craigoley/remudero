import assert from `node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from `node:os";
import { join } from `node:path";
import { test } from `node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

import { FAST_GATE_STEPS, runPreflightFast, type PreflightSpawn } from `../src/lib/ci-parity.js";
import { defaultRunGate, preopenGateCommand, runPreopenGate } from `../src/lib/preopen-gate.js";

function fixture(pkg: object): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t8920-`));
  writeFileSync(join(dir, `package.json"), JSON.stringify(pkg));
  return dir;
}

const neverSpawn: PreflightSpawn = () => ({ status: 0, stdout: `", stderr: "" });

test(`W1-T8920: a consumer repo skips core-only fast-gate steps and names why", () => {
  // remudero-console's shape: its own scripts only, no scripts/list-rule-suites.mjs, no census-precheck.mjs.
  const dir = fixture({ name: `remudero-console", scripts: { jscpd: "echo ok" } });
  try {
    const spawned: string[] = [];
    const spawn: PreflightSpawn = (file, args) => {
      spawned.push([file, ...args].join(` "));
      return { status: 0, stdout: `", stderr: "" };
    };
    const result = runPreflightFast(dir, { spawn });
    assert.equal(result.steps.length, FAST_GATE_STEPS.length);
    assert.equal(result.ok, true, `no step may fail in a consumer tree: ${result.steps.filter((s) => !s.ok).map((s) => s.detail).join(`; ")}`);
    for (const step of result.steps) {
      assert.doesNotMatch(step.detail, /SCRIPT MISSING/, `${step.name} must not read as a missing script`);
    }
    const rules = result.steps.find((s) => s.name === `rule-checks")!;
    assert.match(rules.detail, /SKIPPED — rule-checks: `scripts\/list-rule-suites\.mjs" is core's runner and this repo does not hold it/);
    const claims = result.steps.find((s) => s.name === `claims")!;
    assert.match(claims.detail, /SKIPPED — claims: `claims" is core's step and this repo does not define it/);
    const precheck = result.steps.find((s) => s.name === `census-precheck")!;
    assert.match(precheck.detail, /SKIPPED — census-precheck: `scripts\/census-precheck\.mjs"/);
    // A step whose script the consumer DOES define runs as today.
    const jscpd = result.steps.find((s) => s.name === `jscpd")!;
    assert.doesNotMatch(jscpd.detail, /SKIPPED/);
    assert.deepEqual(spawned, [`npm run --silent jscpd"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`W1-T8920: the harness repo still fails a missing fast-gate script", () => {
  const dir = fixture({ name: `remudero", scripts: { jscpd: "echo ok" } });
  try {
    const result = runPreflightFast(dir, { spawn: neverSpawn });
    const claims = result.steps.find((s) => s.name === `claims")!;
    assert.equal(claims.ok, false);
    assert.match(claims.detail, /SCRIPT MISSING/);
    assert.equal(result.ok, false);
    assert.ok(!result.steps.some((s) => /SKIPPED — (?!no plan)/.test(s.detail) && /core's/.test(s.detail)), `the harness skips nothing as core's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`W1-T8920: a consumer worktree without bin/rmd is gated through the harness rmd", async () => {
  const work = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t8920-gate-`));
  const harness = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t8920-harness-`));
  try {
    // A real child: the fake harness rmd records its argv and writes the summary the gate reads back.
    const fakeRmd = join(harness, `rmd");
    const argvFile = join(harness, `argv.txt");
    writeFileSync(
      fakeRmd,
      `#!/usr/bin/env bash\nprintf '%s\\n' `$@" > "${argvFile}"\nmkdir -p "$PWD/coverage"\n` +
        `printf '{`ok":false,"finishedAt":"%s","steps":[{"name":"jscpd","ok":false}]}' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" > "$PWD/coverage/preflight-summary.json"\nexit 1\n`,
    );
    chmodSync(fakeRmd, 0o755);

    assert.deepEqual(preopenGateCommand(work, fakeRmd), { file: fakeRmd, args: [`preflight", "--fast", "--repo-root", work] });

    const result = await runPreopenGate(work, { runGate: (cwd) => defaultRunGate(cwd, fakeRmd) });
    assert.equal(result.kind, `fail", `a consumer build must be measured, got ${JSON.stringify(result)}`);
    assert.deepEqual(result.kind === `fail" ? result.failedSteps : [], ["jscpd"]);
    assert.deepEqual(readFileSync(argvFile, `utf8").trim().split("\n"), ["preflight", "--fast", "--repo-root", work]);

    // A worktree holding its own bin/rmd still spawns that one, unchanged.
    mkdirSync(join(work, `bin"));
    writeFileSync(join(work, `bin", "rmd"), "#!/usr/bin/env bash\n");
    assert.deepEqual(preopenGateCommand(work, fakeRmd), { file: join(work, `bin", "rmd"), args: ["preflight", "--fast"] });
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(harness, { recursive: true, force: true });
  }
});
