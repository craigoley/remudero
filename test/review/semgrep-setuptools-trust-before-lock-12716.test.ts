import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { repoRoot } from "#test/helpers/repo-root.js";

const root = repoRoot();
const auditorPath = join(root, ".github/semgrep/runtime-compatibility-audit.py");
const OLD = ["84.0.0", "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670"] as const;
const NEW = ["84.1.0", "5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9"] as const;

// Each case is [function, args]; the committed auditor answers every case in one isolated python run.
type Case = ["tool" | "pth", string[]];
function ask(cases: Case[]): boolean[] {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("audit", sys.argv[1])
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
out = []
for kind, args in json.loads(sys.stdin.readline()):
    out.append(bool(p.approved_tool_artifact(*args) if kind == "tool" else p.approved_setuptools_pth(*args)))
print(json.dumps(out))
`;
  const run = spawnSync("python3", ["-I", "-B", "-S", "-c", script, auditorPath],
    { input: JSON.stringify(cases) + "\n", encoding: "utf8", timeout: 10000, maxBuffer: 1 << 20 });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as boolean[];
}

test("W1-T12716 criterion 1 the auditor admits exactly the two reviewed setuptools wheels", () => {
  const pth = "distutils-precedence.pth";
  const answers = ask([
    ["tool", ["setuptools", ...OLD]],
    ["tool", ["setuptools", ...NEW]],
    ["tool", ["setuptools", "84.1.0", OLD[1]]],
    ["tool", ["setuptools", "84.0.0", NEW[1]]],
    ["tool", ["setuptools", "84.2.0", NEW[1]]],
    ["tool", ["setuptools", "84.1.0", "0".repeat(64)]],
    ["pth", ["setuptools", ...OLD, pth]],
    ["pth", ["setuptools", ...NEW, pth]],
    ["pth", ["attack", ...NEW, pth]],
    ["pth", ["setuptools", "83.0.0", NEW[1], pth]],
    ["pth", ["setuptools", "84.1.0", "0".repeat(64), pth]],
    ["pth", ["setuptools", ...NEW, "setuptools-84.1.0.data/purelib/distutils-precedence.pth"]],
  ]);
  assert.deepEqual(answers, [true, true, false, false, false, false, true, true, false, false, false, false]);
});

test("W1-T12716 criterion 2 the workflow and the qualifier bind the committed auditor digest", () => {
  const digest = createHash("sha256").update(readFileSync(auditorPath)).digest("hex");
  const workflow = readFileSync(join(root, ".github/workflows/semgrep-runtime-compatibility.yml"), "utf8");
  const qualifier = readFileSync(join(root, ".github/semgrep/source-runtime-qualification.py"), "utf8");
  assert.deepEqual([...workflow.matchAll(/^\s*AUDITOR_SHA256: ([a-f0-9]{64})$/gm)].map((m) => m[1]), [digest]);
  assert.deepEqual([...qualifier.matchAll(/"runtime-compatibility-audit\.py": "([a-f0-9]{64})"/g)].map((m) => m[1]), [digest]);
});

test("W1-T12716 criterion 3 the committed build lock's setuptools pin is admitted by the auditor", () => {
  const lock = readFileSync(join(root, ".github/semgrep/build-requirements.txt"), "utf8");
  const pins = [...lock.matchAll(/^setuptools==(\S+)((?: --hash=sha256:[a-f0-9]{64})+)$/gm)];
  assert.equal(pins.length, 1, "one setuptools line");
  const hashes = [...pins[0]![2]!.matchAll(/sha256:([a-f0-9]{64})/g)].map((m) => m[1]!);
  assert.equal(hashes.length, 1, "one exact artifact per lock line");
  assert.deepEqual(ask([["tool", ["setuptools", pins[0]![1]!, hashes[0]!]]]), [true]);
});
