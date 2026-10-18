import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
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

/**
 * The base proof runs with the BASE TREE as its cwd. Under the reviewer's bubblewrap sandbox only that cwd (and the
 * runtime roots) are mounted, so a stub in `<root>/bin` is invisible there and the real grep runs instead. The base
 * tree is therefore a directory this fixture owns, carrying its own `bin/grep`, so the stub resolves in either mode.
 */
function baseTreeWithTool(root: string): { makeDir: () => string; bin: string } {
  const dir = join(realpathSync(root), "base-tree");
  return { makeDir: () => { mkdirSync(join(dir, "bin"), { recursive: true }); return dir; }, bin: join(dir, "bin") };
}

function failingTool(t: TestContext, root: string, status = 2, extraBins: string[] = []) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Real default spawner, real child and filesystem; only the external tool's controlled failure is a fixture.
  const script = `#!/bin/sh
for last do :; done
if /usr/bin/grep -q BASE_REFUSAL "$last"; then
  n=1
  while [ "$n" -le 55 ]; do printf 'fixture stderr line %s\\n' "$n" >&2; n=$((n + 1)); done
  printf '%s\\n' 'api_key=fixture-credential-never-real' 'fixture runner refused to collect' >&2
  exit ${status}
fi
exec /usr/bin/grep "$@"
`;
  writeFileSync(join(bin, "grep"), script, { mode: 0o700 });
  for (const extra of extraBins) {
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, "grep"), script, { mode: 0o700 });
  }
  const prior = process.env.PATH;
  process.env.PATH = [bin, ...extraBins, prior ?? ""].join(":");
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
  const base = baseTreeWithTool(f.root);
  failingTool(t, f.root, 2, [base.bin]);
  const code = checkProofCommand(["grep: needle in src/marker.txt", "--base", "fixture-base"], {
    pathStatus: () => "", baseBlobDeps: { showBlob: () => "BASE_REFUSAL\n", makeDir: base.makeDir },
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

test("check-proof ordinary head failure retains its verdict and redacted failure tail", t => {
  const f = fixture(t, "BASE_REFUSAL\n");
  failingTool(t, f.root, 1);
  assert.equal(checkProofCommand(["grep: needle in src/marker.txt"], { pathStatus: () => "" }), CHECK_PROOF_EXIT.fail);
  assert.match(f.output(), /head output:/);
  assert.match(f.output(), /fixture runner refused to collect/);
  assert.match(f.output(), /verdict:\s+fail/);
  assert.doesNotMatch(f.output(), /fixture-credential-never-real/);
});

test("check-proof ordinary base failure still discriminates and shows its redacted tail", t => {
  const f = fixture(t);
  const base = baseTreeWithTool(f.root);
  failingTool(t, f.root, 1, [base.bin]);
  const code = checkProofCommand(["grep: needle in src/marker.txt", "--base", "fixture-base"], {
    pathStatus: () => "", baseBlobDeps: { showBlob: () => "BASE_REFUSAL\n", makeDir: base.makeDir },
  });
  assert.equal(code, CHECK_PROOF_EXIT.pass);
  assert.match(f.output(), /base output:/);
  assert.match(f.output(), /fixture runner refused to collect/);
  assert.match(f.output(), /discrimination: discriminates/);
  assert.doesNotMatch(f.output(), /fixture-credential-never-real/);
});
