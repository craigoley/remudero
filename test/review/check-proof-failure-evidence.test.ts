import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { checkProofCommand, CHECK_PROOF_EXIT } from "#src/lib/check-proof.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

function fixture(t: TestContext, text = "needle\n") {
  const root = ownedFixtureDir(t, "proof-failure-evidence").dir;
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "marker.txt"), text);
  t.mock.method(process, "cwd", () => root);
  const lines: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => lines.push(args.join(" ")));
  return { root, output: () => lines.join("\n") };
}

function failingTool(t: TestContext, root: string) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Real default spawner, real child and filesystem; only the external tool's controlled failure is a fixture.
  writeFileSync(join(bin, "grep"), `#!/bin/sh
for last do :; done
if /usr/bin/grep -q BASE_REFUSAL "$last"; then
  n=1
  while [ "$n" -le 55 ]; do printf 'fixture stderr line %s\\n' "$n" >&2; n=$((n + 1)); done
  printf '%s\\n' 'api_key=fixture-credential-never-real' 'fixture runner refused to collect' >&2
  exit 2
fi
exec /usr/bin/grep "$@"
`, { mode: 0o700 });
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:${prior ?? ""}`;
  t.after(() => { if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior; });
}

test("check-proof shows the real head spawner stderr without changing exec-error", t => {
  const f = fixture(t);
  const code = checkProofCommand(["grep: needle in src/does-not-exist.txt"], { pathStatus: () => "" });
  assert.equal(code, CHECK_PROOF_EXIT.execError);
  assert.match(f.output(), /head output:/);
  assert.match(f.output(), /No such file|no such file|cannot open/i);
  assert.match(f.output(), /verdict:\s+exec_error/);
});

test("check-proof shows bounded redacted base stderr while discrimination remains unknown", t => {
  const f = fixture(t);
  failingTool(t, f.root);
  const code = checkProofCommand(["grep: needle in src/marker.txt", "--base", "fixture-base"], {
    pathStatus: () => "", baseBlobDeps: { showBlob: () => "BASE_REFUSAL\n" },
  });
  assert.equal(code, CHECK_PROOF_EXIT.pass, "an unknown base does not change the head's verdict");
  assert.match(f.output(), /base output:/);
  assert.match(f.output(), /fixture runner refused to collect/);
  assert.match(f.output(), /earlier lines omitted/);
  assert.match(f.output(), /api_key=<redacted>/);
  assert.doesNotMatch(f.output(), /fixture-credential-never-real/);
  assert.match(f.output(), /discrimination: unknown/);
});

test("check-proof head failure diagnostics use the maintained redactor and bounded tail", t => {
  const f = fixture(t, "BASE_REFUSAL\n");
  failingTool(t, f.root);
  assert.equal(checkProofCommand(["grep: needle in src/marker.txt"], { pathStatus: () => "" }), CHECK_PROOF_EXIT.execError);
  assert.match(f.output(), /head output:/);
  assert.match(f.output(), /fixture runner refused to collect/);
  assert.match(f.output(), /earlier lines omitted/);
  assert.doesNotMatch(f.output(), /fixture-credential-never-real/);
});

test("check-proof passing head and base retain executed-stale with no failure output", t => {
  const f = fixture(t);
  const code = checkProofCommand(["grep: needle in src/marker.txt", "--base", "fixture-base"], {
    pathStatus: () => "", baseBlobDeps: { showBlob: () => "needle\n" },
  });
  assert.equal(code, CHECK_PROOF_EXIT.executedStale);
  assert.match(f.output(), /discrimination: executed_stale/);
  assert.doesNotMatch(f.output(), /(?:head|base) output:/);
});
