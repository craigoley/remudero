import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { repoRoot } from "#test/helpers/repo-root.js";

test("the trusted lock policy admits only the exact reviewed setuptools 84.1.0 wheel", () => {
  const root = repoRoot();
  const source = join(root, ".github/semgrep/runtime-compatibility-audit.py");
  const runtime = join(root, ".github/semgrep/requirements.txt");
  const build = readFileSync(join(root, ".github/semgrep/build-requirements.txt"), "utf8");
  const scratch = mkdtempSync(join(tmpdir(), "rmd-semgrep-setuptools-lock-"));
  const script = [
    "import importlib.util, pathlib, sys",
    "source, root, runtime, version, digest = sys.argv[1:]",
    "spec = importlib.util.spec_from_file_location('auditor', source)",
    "auditor = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(auditor)",
    "root = pathlib.Path(root)",
    "(root / 'build-requirements.txt').write_text(pathlib.Path(source).with_name('build-requirements.txt').read_text().replace('setuptools==84.0.0 --hash=sha256:51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670', f'setuptools=={version} --hash=sha256:{digest}'))",
    "(root / 'requirements.txt').write_bytes(pathlib.Path(runtime).read_bytes())",
    "pins = dict(auditor.APPROVED_TOOLS)",
    "pins['setuptools'] = (version, digest)",
    "assert auditor.approved_build_tool_pins(pins)",
    "print(auditor._locked_inputs(root)[2]['setuptools'])",
  ].join("\n");
  const run = (version: string, digest: string) => spawnSync("python3", [
    "-I", "-S", "-c", script, source, scratch, runtime, version, digest,
  ], { encoding: "utf8" });

  try {
    assert.match(build, /^setuptools==84\.0\.0 --hash=sha256:51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670$/m);
    assert.equal(run("84.0.0", "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670").status, 0);
    const admitted = run("84.1.0", "5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9");
    assert.equal(admitted.status, 0, admitted.stderr);
    assert.equal(admitted.stdout.trim(),
      "('84.1.0', '5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9')");
    assert.notEqual(run("84.1.0", "0".repeat(64)).status, 0);
    assert.notEqual(run("84.2.0", "0".repeat(64)).status, 0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
