import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const script = join(REPO_ROOT, "deploy/field-trials-refresh.sh");
const casePath = "/home/node/Remudero/state/field-trials/case-files-latest.json";
const systemBashVersion = spawnSync("/bin/bash", ["--version"], { encoding: "utf8" }).stdout ?? "";
const hasBash32 = /\bversion 3\.2\b/.test(systemBashVersion);

function refresh(t: TestContext, bash: string, credentials: "available" | "unavailable",
  cases: "failed" | "previous" | "override") {
  const dir = mkdtempSync(join(tmpdir(), "rmd-refresh-array-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const homes = ["core", "site", "console"];
  for (const name of homes) {
    const state = join(dir, name, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "ledger.ndjson"), "");
  }
  const out = join(dir, "core", "state", "field-trials");
  mkdirSync(out);
  const override = join(dir, "explicit-cases.json");
  if (cases === "previous") writeFileSync(join(out, "case-files-latest.json"), "[]");
  if (cases === "override") writeFileSync(override, "[]");

  const registry = join(dir, "instances.yaml");
  writeFileSync(registry, homes.map(name => "  " + name + ":\n    state_dir: " + join(dir, name) + "\n").join(""));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(bin, "docker"), [
    "#!/bin/sh",
    'case "$*" in',
    '  inspect\\ *) echo test-image ;;',
    '  *printenv*)',
    '    if [ "$TEST_CREDENTIALS" = unavailable ]; then exit 1; fi',
    '    echo test-credential ;;',
    '  *private-routing-daily-review.mjs*) exit 0 ;;',
    '  *private-field-trials-case-files.mjs*) exit 8 ;;',
    '  *field-trials*) printf "%s\\n" "$@" > "$TEST_SNAPSHOT_ARGS" ;;',
    '  *) exit 97 ;;',
    "esac",
    "",
  ].join("\n"), { mode: 0o700 });

  const argsPath = join(dir, "snapshot.args");
  const result = spawnSync(bash, [script], { cwd: REPO_ROOT, encoding: "utf8", env: {
    PATH: bin + ":" + process.env.PATH,
    RMD_INSTANCE_REGISTRY: registry,
    RMD_FIELD_TRIALS_MAX_PAGES: "2",
    RMD_FIELD_TRIALS_CONSENT: "",
    RMD_FIELD_TRIALS_CASE_FILES: cases === "override" ? override : "",
    TEST_CREDENTIALS: credentials,
    TEST_SNAPSHOT_ARGS: argsPath,
  } });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stderr, /unbound variable/);
  assert.ok(existsSync(argsPath), "snapshot ran: " + result.stderr);
  const args = readFileSync(argsPath, "utf8").trimEnd().split("\n");
  return { status: result.status, stderr: result.stderr, args };
}

async function eachBash(t: TestContext, run: (scope: TestContext, bash: string) => void) {
  await t.test("host Bash", scope => run(scope, "bash"));
  await t.test("macOS Bash 3.2", { skip: hasBash32 ? false : "/bin/bash is not Bash 3.2" },
    scope => run(scope, "/bin/bash"));
}

test("W1-T13531 criterion 1 — credential failure reaches the offline snapshot without a case-file argument", async t => {
  await eachBash(t, (scope, bash) => {
    const result = refresh(scope, bash, "unavailable", "failed");
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.args.includes("--offline"));
    assert.ok(!result.args.includes("--case-files"));
  });
});

test("W1-T13531 criterion 2 — case-file failure reaches the GitHub snapshot without a case-file argument", async t => {
  await eachBash(t, (scope, bash) => {
    const result = refresh(scope, bash, "available", "failed");
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.args.includes("--source"));
    assert.ok(!result.args.includes("--case-files"));
  });
});

test("W1-T13531 criterion 3 — the snapshot receives a present case-file argument and success exits zero", async t => {
  await eachBash(t, (scope, bash) => {
    for (const credentials of ["available", "unavailable"] as const) {
      const previous = refresh(scope, bash, credentials, "previous");
      assert.equal(previous.status, 1, previous.stderr);
      const index = previous.args.indexOf("--case-files");
      assert.ok(index >= 0);
      assert.equal(previous.args[index + 1], casePath);
    }
    const supplied = refresh(scope, bash, "available", "override");
    assert.equal(supplied.status, 0, supplied.stderr);
    const index = supplied.args.indexOf("--case-files");
    assert.ok(index >= 0);
    assert.equal(supplied.args[index + 1], "/field-trials/cases.json");
  });
});
