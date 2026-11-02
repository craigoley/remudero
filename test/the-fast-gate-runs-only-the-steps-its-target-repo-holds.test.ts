import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FAST_GATE_STEPS, runPreflightFast } from "#src/lib/ci-parity.js";
import type { PreflightSpawn } from "#src/lib/commit-message.js";
import { defaultRunGate, preopenGateCommand, runPreopenGate } from "#src/lib/preopen-gate.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

function scratch(kind: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t8920-${kind}-`));
}

function fixture(pkg: object): string {
  const dir = scratch("repo");
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

const neverSpawn: PreflightSpawn = () => ({ status: 0, stdout: "", stderr: "" });

test("W1-T8920: a consumer repo skips core-only fast-gate steps and names why", () => {
  // remudero-console's shape: its own scripts only, no scripts/list-rule-suites.mjs, no census-precheck.mjs.
  const dir = fixture({ name: "remudero-console", scripts: { jscpd: "echo ok" } });
  try {
    const spawned: string[] = [];
    const spawn: PreflightSpawn = (file, args) => {
      spawned.push([file, ...args].join(" "));
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = runPreflightFast(dir, { spawn });
    assert.equal(result.steps.length, FAST_GATE_STEPS.length);
    assert.equal(result.ok, true, `no step may fail in a consumer tree: ${result.steps.filter((s) => !s.ok).map((s) => s.detail).join("; ")}`);
    for (const step of result.steps) {
      assert.doesNotMatch(step.detail, /SCRIPT MISSING/, `${step.name} must not read as a missing script`);
    }
    const rules = result.steps.find((s) => s.name === "rule-checks")!;
    assert.match(rules.detail, /SKIPPED — rule-checks: "scripts\/list-rule-suites\.mjs" is core's runner and this repo does not hold it/);
    const claims = result.steps.find((s) => s.name === "claims")!;
    assert.match(claims.detail, /SKIPPED — claims: "claims" is core's step and this repo does not define it/);
    const precheck = result.steps.find((s) => s.name === "census-precheck")!;
    assert.match(precheck.detail, /SKIPPED — census-precheck: "scripts\/census-precheck\.mjs"/);
    // A step whose script the consumer DOES define runs as today.
    const jscpd = result.steps.find((s) => s.name === "jscpd")!;
    assert.doesNotMatch(jscpd.detail, /SKIPPED/);
    assert.deepEqual(spawned, ["npm run --silent jscpd"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T8920: the harness repo still fails a missing fast-gate script", () => {
  const dir = fixture({ name: "remudero", scripts: { jscpd: "echo ok" } });
  try {
    const result = runPreflightFast(dir, { spawn: neverSpawn });
    const claims = result.steps.find((s) => s.name === "claims")!;
    assert.equal(claims.ok, false);
    assert.match(claims.detail, /SCRIPT MISSING/);
    assert.equal(result.ok, false);
    assert.ok(!result.steps.some((s) => /is core's (step|runner)/.test(s.detail)), "the harness's own repo skips nothing as core's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T8920: a consumer worktree without bin/rmd is gated through the harness rmd with a portable UTC clock", async () => {
  const work = scratch("gate");
  const harness = scratch("harness");
  try {
    // A real child: the fake harness rmd records its argv and writes the summary the gate reads back, at the
    // `--summary-file` path the harness names (W1-T9619: outside the worktree).
    const fakeRmd = join(harness, "rmd");
    const argvFile = join(harness, "argv.txt");
    const summaryCopy = join(harness, "summary-copy.json");
    // BSD date does not implement GNU %N; use the pinned native Node clock.
    writeFileSync(
      fakeRmd,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvFile}"\nsummary="\${@: -1}"\n` +
        `printf '{"ok":false,"finishedAt":"%s","steps":[{"name":"jscpd","ok":false}]}' "$(${JSON.stringify(process.execPath)} -e 'process.stdout.write(new Date().toISOString())')" > "$summary"\ncp "$summary" "${summaryCopy}"\nexit 1\n`,
    );
    chmodSync(fakeRmd, 0o755);
    // W1-T9619: the sandbox is a stand-in that runs the command after `--`, so this host needs no bubblewrap.
    const fakeSandbox = join(harness, "sandbox");
    writeFileSync(fakeSandbox, `#!/usr/bin/env bash\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
    chmodSync(fakeSandbox, 0o755);
    const contain = async () => ({ mode: "sandboxed" as const, file: fakeSandbox, argv: ["--"] });

    assert.deepEqual(preopenGateCommand(work, fakeRmd), { file: fakeRmd, args: ["preflight", "--fast", "--repo-root", work] });

    const result = await runPreopenGate(work, { runGate: (cwd) => defaultRunGate(cwd, fakeRmd, undefined, {}, { contain }) });
    assert.equal(result.kind, "fail", `a consumer build must be measured, got ${JSON.stringify(result)}`);
    assert.deepEqual(result.kind === "fail" ? result.failedSteps : [], ["jscpd"]);
    const summary = JSON.parse(readFileSync(summaryCopy, "utf8")) as { finishedAt: string };
    assert.match(summary.finishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "the real child writes a millisecond UTC clock, not a date-tool extension");
    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    assert.deepEqual(argv.slice(0, 5), ["preflight", "--fast", "--repo-root", work, "--summary-file"]);

    // W1-T9619: a worktree holding its own bin/rmd is gated through the harness rmd too, never its own.
    mkdirSync(join(work, "bin"));
    writeFileSync(join(work, "bin", "rmd"), "#!/usr/bin/env bash\n");
    assert.deepEqual(preopenGateCommand(work, fakeRmd), { file: fakeRmd, args: ["preflight", "--fast", "--repo-root", work] });
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(harness, { recursive: true, force: true });
  }
});
