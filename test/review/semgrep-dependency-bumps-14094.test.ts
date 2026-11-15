import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isDependencyDeclarationPath } from "#src/lib/dep-review.js";
import { repoRoot } from "#test/helpers/repo-root.js";

const root = repoRoot();
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");

test("W1-T12492 admits only reviewed setuptools wheels and refuses the incompatible OpenTelemetry move", () => {
  const build = read(".github/semgrep/build-requirements.txt");
  const runtime = read(".github/semgrep/requirements.txt");
  const auditor = read(".github/semgrep/runtime-compatibility-audit.py");
  const qualifier = read(".github/semgrep/source-runtime-qualification.py");
  const workflow = read(".github/workflows/semgrep-runtime-compatibility.yml");

  const buildPins = [...build.matchAll(/^setuptools==([^\s]+) --hash=sha256:([a-f0-9]+)$/gm)];
  assert.deepEqual(buildPins.map(([, version, digest]) => [version, digest]),
    [["84.0.0", "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670"]],
    "the trust-only change keeps main's lock on its current reviewed wheel");
  assert.match(auditor, /"setuptools": frozenset\(\{\s*\("84\.0\.0", "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670"\),\s*\("84\.1\.0", "5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9"\),/);
  assert.match(auditor, /APPROVED_SPECIAL_MEMBER_ALIASES = \{[\s\S]*"84\.1\.0", "5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9"\)[\s\S]*"84\.0\.0", "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670"\)/);
  assert.match(runtime, /^opentelemetry-api==1\.37\.0 --hash=sha256:accf2024d3e89faec14302213bc39550ec0f4095d1cf5ca688e1bfb1c8612f47$/m);
  assert.match(runtime, /^opentelemetry-sdk==1\.37\.0 --hash=sha256:8f3c3c22063e52475c5dbced7209495c2c16723d016d39287dfc215d1771257c$/m);
  assert.doesNotMatch(runtime, /^opentelemetry-api==1\.45\.2\b/m);
  const refusal = {
    outcome: "REFUSED",
    class: "premise-rotted",
    target: "opentelemetry-api 1.45.2",
    consumers: [
      {
        name: "Semgrep 1.181.0 source",
        artifact: "semgrep-1.181.0.tar.gz",
        sha256: "4c0905288ccf9ee5330e766f1c677a31642a4cc0aac5a95097e7563f3f3a92fa",
        metadata: "semgrep-1.181.0/pyproject.toml",
        constraint: "opentelemetry-api~=1.37.0",
      },
      {
        name: "opentelemetry-sdk 1.37.0",
        artifact: "opentelemetry_sdk-1.37.0-py3-none-any.whl",
        sha256: "8f3c3c22063e52475c5dbced7209495c2c16723d016d39287dfc215d1771257c",
        metadata: "opentelemetry_sdk-1.37.0.dist-info/METADATA",
        constraint: "Requires-Dist: opentelemetry-api==1.37.0",
      },
    ],
  } as const;
  const sourcePolicy = JSON.parse(read(".github/semgrep/source-build-policy.json"));
  assert.equal(sourcePolicy.source.sha256, refusal.consumers[0].sha256);
  assert.equal(runtime.match(/^opentelemetry-sdk==1\.37\.0 --hash=sha256:([a-f0-9]{64})$/m)?.[1], refusal.consumers[1].sha256);
  assert.equal(refusal.outcome, "REFUSED");
  assert.equal(refusal.class, "premise-rotted");
  assert.equal(refusal.target, "opentelemetry-api 1.45.2");
  assert.deepEqual(refusal.consumers.map(({ name, metadata, constraint }) => [name, metadata, constraint]), [
    ["Semgrep 1.181.0 source", "semgrep-1.181.0/pyproject.toml", "opentelemetry-api~=1.37.0"],
    ["opentelemetry-sdk 1.37.0", "opentelemetry_sdk-1.37.0.dist-info/METADATA", "Requires-Dist: opentelemetry-api==1.37.0"],
  ]);
  assert.equal(isDependencyDeclarationPath(".github/semgrep/build-requirements.txt", () => "{}"), false,
    "do not widen Dependabot's general dependency-file allowlist for this reviewed repair");

  const digest = sha256(".github/semgrep/runtime-compatibility-audit.py");
  assert.ok(qualifier.includes(`"runtime-compatibility-audit.py": "${digest}"`));
  assert.ok(workflow.includes(`AUDITOR_SHA256: ${digest}`));
  assert.match(workflow, /AUDIT_PHASE/);
  assert.match(workflow, /pip.*check|check.*pip/s);
});

test("W1-T12492 lock validator admits the reviewed 84.1.0 wheel and rejects other identities", () => {
  const source = join(root, ".github/semgrep/runtime-compatibility-audit.py");
  const runtime = join(root, ".github/semgrep/requirements.txt");
  const scratch = mkdtempSync(join(tmpdir(), "rmd-semgrep-lock-validator-"));
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
    "-I", "-S", "-B", "-c", script, source, scratch, runtime, version, digest,
  ], { encoding: "utf8" });

  try {
    const old = run("84.0.0", "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670");
    assert.equal(old.status, 0, old.stderr);
    const reviewed = run("84.1.0", "5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9");
    assert.equal(reviewed.status, 0, reviewed.stderr);
    assert.equal(reviewed.stdout.trim(),
      "('84.1.0', '5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9')");
    assert.notEqual(run("84.1.0", "0".repeat(64)).status, 0);
    assert.notEqual(run("84.2.0", "0".repeat(64)).status, 0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
