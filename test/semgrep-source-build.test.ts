import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../.github/semgrep/", import.meta.url);
const names = ["prepare-source-build.py", "test_prepare_source_build.py", "source-build-policy.json"];
const sourceHashes = () => Object.fromEntries(names.map(name => [name,
  createHash("sha256").update(readFileSync(new URL(name, root))).digest("hex")]));

test("Semgrep source assembly preserves original engine and source while requiring the security-fixed MCP", () => {
  const path = fileURLToPath(new URL("test_prepare_source_build.py", root));
  const source = readFileSync(path, "utf8");
  const expected = [...source.matchAll(/^    def (test_[a-z0-9_]+)\(self\):$/gm)]
    .map(match => `__main__.SourceAssemblyTests.${match[1]}`).sort();
  assert.equal(expected.length, 31, "update the explicit native case population when adding controls");
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "rmd-source-assembly-controls-")));
  const before = sourceHashes();
  try {
    const receipt = join(scratch, "controls.json");
    const run = spawnSync("python3", ["-I", "-B", "-S", path, "--receipt", receipt],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 2 << 20, env: { ...process.env, TMPDIR: scratch } });
    assert.equal(run.error, undefined); assert.equal(run.signal, null);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /Ran 31 tests in /); assert.match(run.stderr, /\nOK\n/);
    const result = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(result.schema, "rmd-semgrep-source-assembly-controls/v1");
    assert.equal(result.successful, true);
    for (const key of ["selected", "executed", "pass"]) assert.equal(result[key], expected.length);
    for (const key of ["fail", "error", "skipped", "unrun"]) assert.equal(result[key], 0);
    assert.deepEqual(result.literalInventory, expected);
    assert.deepEqual(result.sourceHashes, before); assert.deepEqual(sourceHashes(), before);
    assert.equal(result.sourceUnchanged, true);
    for (const key of ["runtimeQualified", "dependencyClosureQualified", "runnerQualified", "candidateExecution"])
      assert.equal(result[key], false, "unit fixtures cannot become runtime evidence");
    assert.equal(result.pilotDefaultOff, true);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("Semgrep source build CLI refuses site-enabled startup before opening any candidate input", () => {
  const path = fileURLToPath(new URL("prepare-source-build.py", root));
  const run = spawnSync("python3", ["-I", "-B", path, "--source-archive", "/definitely-not-an-input/source",
    "--engine-donor", "/definitely-not-an-input/donor", "--output-dir", "/definitely-not-an-output"],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 1 << 20 });
  assert.equal(run.error, undefined); assert.equal(run.signal, null);
  assert.notEqual(run.status, 0); assert.match(run.stderr, /ISOLATED_STARTUP_REQUIRED/);
  assert.doesNotMatch(run.stderr, /FileNotFoundError/);
});
