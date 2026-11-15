import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { repoRoot } from "#test/helpers/repo-root.js";

const root = repoRoot();
const semgrep = join(root, ".github/semgrep");
const auditorPath = join(semgrep, "runtime-compatibility-audit.py");
const mainBuildLock = readFileSync(join(semgrep, "build-requirements.txt"), "utf8");
const runtimeLock = readFileSync(join(semgrep, "requirements.txt"), "utf8");
const OLD_LINE = "setuptools==84.0.0 --hash=sha256:51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670";
const NEW_LINE = "setuptools==84.1.0 --hash=sha256:5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9";

function withLine(lock: string, from: RegExp, to: string): string {
  assert.match(lock, from);
  return lock.replace(from, to);
}
const lock184 = withLine(mainBuildLock, /^setuptools==.*$/m, NEW_LINE);

// The committed auditor answers each build lock through both lock-policy checks, with no network:
// the download phase's _locked_inputs on a temp root, and audit_locked_artifacts with a pinned-API stand-in
// and no artifacts, so a lock that passes the tool policy stops at the artifact inventory instead.
function verdicts(locks: string[]): [string, string][] {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}semgrep-lock-policy-`));
  try {
    const roots = locks.map((lock, i) => {
      const caseRoot = join(dir, String(i));
      mkdirSync(caseRoot);
      writeFileSync(join(caseRoot, "build-requirements.txt"), lock);
      writeFileSync(join(caseRoot, "requirements.txt"), runtimeLock);
      return caseRoot;
    });
    const script = `
import importlib.util, json, pathlib, re, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("audit", sys.argv[1])
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
api = SimpleNamespace(pip=SimpleNamespace(__version__="26.2.1"), provenance={"state": "PINNED_API_BYTES_VERIFIED"},
                      canonicalize_name=lambda n: re.sub(r"[-_.]+", "-", n.lower()), Version=str)
def code(call):
    try:
        call(); return "ADMITTED"
    except p.AuditBlocked as e:
        return e.code
out = []
for r in map(pathlib.Path, json.loads(sys.stdin.readline())):
    b, rt = (r / "build-requirements.txt").read_bytes(), (r / "requirements.txt").read_bytes()
    out.append([code(lambda: p._locked_inputs(r)), code(lambda: p.audit_locked_artifacts(b, rt, [], api))])
print(json.dumps(out))
`;
    const run = spawnSync("python3", ["-I", "-B", "-S", "-c", script, auditorPath],
      { input: JSON.stringify(roots) + "\n", encoding: "utf8", timeout: 20000, maxBuffer: 1 << 20 });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout) as [string, string][];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ADMITTED: [string, string] = ["ADMITTED", "ARTIFACT_INVENTORY"];
const REFUSED: [string, string] = ["RECIPE_POLICY", "BUILD_TOOL_POLICY"];

test("W1-T12823 criterion 1 the lock policy admits only the two exact setuptools pins and the fixed tool set", () => {
  const sha = (c: string) => `--hash=sha256:${c.repeat(64)}`;
  const refused = [
    withLine(mainBuildLock, /^setuptools==.*$/m, `setuptools==84.1.0 ${sha("0")}`),
    withLine(mainBuildLock, /^setuptools==.*$/m, "setuptools==84.1.0 --hash=sha256:51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670"),
    withLine(mainBuildLock, /^setuptools==.*$/m, "setuptools==84.2.0 --hash=sha256:5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9"),
    withLine(mainBuildLock, /^setuptools==.*\n/m, ""),
    `${lock184}attack==1.0 ${sha("a")}\n`,
    withLine(lock184, /^pip==26\.2\.1 /m, "pip==26.2.2 "),
    withLine(lock184, /^packaging==.*$/m, `packaging==26.3 ${sha("b")}`),
    withLine(lock184, /^wheel==0\.48\.0 /m, "wheel==0.49.0 "),
  ];
  assert.deepEqual(verdicts(refused), refused.map(() => REFUSED));
});

test("W1-T12823 criterion 2 main's 84.0.0 build lock and the 84.1.0 lock from PR 18405 both pass the lock policy", () => {
  // Built from the committed lock, so the test holds both before and after PR 18405 moves the pin.
  const lock840 = withLine(mainBuildLock, /^setuptools==.*$/m, OLD_LINE);
  assert.deepEqual(verdicts([mainBuildLock, lock840, lock184]), [ADMITTED, ADMITTED, ADMITTED]);
});

test("W1-T12823 criterion 3 the workflow and the qualifier bind the committed auditor digest", () => {
  const digest = createHash("sha256").update(readFileSync(auditorPath)).digest("hex");
  const workflow = readFileSync(join(root, ".github/workflows/semgrep-runtime-compatibility.yml"), "utf8");
  const qualifier = readFileSync(join(semgrep, "source-runtime-qualification.py"), "utf8");
  assert.deepEqual([...workflow.matchAll(/^\s*AUDITOR_SHA256: ([a-f0-9]{64})$/gm)].map((m) => m[1]), [digest]);
  assert.deepEqual([...qualifier.matchAll(/"runtime-compatibility-audit\.py": "([a-f0-9]{64})"/g)].map((m) => m[1]), [digest]);
});
