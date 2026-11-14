import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { isDependencyDeclarationPath } from "#src/lib/dep-review.js";
import { repoRoot } from "#test/helpers/repo-root.js";

const root = repoRoot();
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");

test("W1-T12492 adopts only the reviewed setuptools wheel and refuses the incompatible OpenTelemetry move", () => {
  const build = read(".github/semgrep/build-requirements.txt");
  const runtime = read(".github/semgrep/requirements.txt");
  const auditor = read(".github/semgrep/runtime-compatibility-audit.py");
  const qualifier = read(".github/semgrep/source-runtime-qualification.py");
  const workflow = read(".github/workflows/semgrep-runtime-compatibility.yml");

  assert.match(build, /^setuptools==84\.1\.0 --hash=sha256:5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9$/m);
  assert.equal((build.match(/^setuptools==/gm) ?? []).length, 1);
  assert.match(auditor, /"setuptools": \("84\.1\.0", "5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9"\)/);
  assert.match(auditor, /\("setuptools", "84\.1\.0", "5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9"\): \{/);
  assert.match(runtime, /^opentelemetry-api==1\.37\.0 --hash=sha256:accf2024d3e89faec14302213bc39550ec0f4095d1cf5ca688e1bfb1c8612f47$/m);
  assert.match(runtime, /^opentelemetry-sdk==1\.37\.0 --hash=sha256:8f3c3c22063e52475c5dbced7209495c2c16723d016d39287dfc215d1771257c$/m);
  assert.doesNotMatch(runtime, /^opentelemetry-api==1\.45\.2\b/m);
  assert.equal(isDependencyDeclarationPath(".github/semgrep/build-requirements.txt", () => "{}"), false,
    "do not widen Dependabot's general dependency-file allowlist for this reviewed repair");

  const digest = sha256(".github/semgrep/runtime-compatibility-audit.py");
  assert.ok(qualifier.includes(`"runtime-compatibility-audit.py": "${digest}"`));
  assert.ok(workflow.includes(`AUDITOR_SHA256: ${digest}`));
  assert.match(workflow, /AUDIT_PHASE/);
  assert.match(workflow, /pip.*check|check.*pip/s);
});
