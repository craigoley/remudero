import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

const root = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");
const buildPath = ".github/semgrep/build-requirements.txt";
const runtimePath = ".github/semgrep/requirements.txt";
type Pin = { version: string; sha256: string };

// Intentionally accepts only the committed lock dialect, not pip's includes, URLs,
// environment markers, ranges or flags. Native pip/hash/baseline controls complement
// these real-source policy tests; a syntactic lock is not dependency-closure proof.
function parseLock(raw: string): Map<string, Pin> {
  assert.ok(raw.endsWith("\n"), "lock must end with newline");
  const entries = new Map<string, Pin>();
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)==([0-9][a-z0-9.]*(?:\+[a-z0-9]+(?:[.-][a-z0-9]+)*)?) --hash=sha256:([a-f0-9]{64})$/.exec(line);
    assert.ok(match, `unpinned or unsupported lock entry: ${line}`);
    const [, name, version, sha256] = match;
    assert.ok(!version!.includes("+") || (name === "semgrep" && version === "1.181.0+remudero.1"), "only the reviewed distinct source recipe has a local version");
    assert.ok(!entries.has(name!), `duplicate package: ${name}`);
    entries.set(name!, { version: version!, sha256: sha256! });
  }
  assert.ok(entries.size > 0, "empty lock");
  assert.deepEqual([...entries.keys()], [...entries.keys()].sort(), "lock must be canonical and sorted");
  return entries;
}

type Step = { name?: string; uses?: string; run?: string; shell?: string; env?: Record<string, string>; with?: Record<string, unknown>; "continue-on-error"?: boolean; if?: string };
type Workflow = { on: Record<string, unknown>; permissions: unknown; concurrency: unknown; jobs: Record<string, { name: string; "runs-on": string; "timeout-minutes": number; permissions: unknown; container?: unknown; steps: Step[] }> };
const load = (): Workflow => parseYaml(read(".github/workflows/semgrep.yml")) as Workflow;
const step = (name: string): Step => {
  const found = load().jobs.semgrep!.steps.find(candidate => candidate.name === name);
  assert.ok(found, `missing native step: ${name}`);
  return found;
};

test("native Semgrep locks every build and runtime entry with an exact version and SHA256", () => {
  const build = parseLock(read(buildPath));
  const runtime = parseLock(read(runtimePath));
  assert.deepEqual([...build.keys()], ["packaging", "pip", "setuptools", "wheel"]);
  assert.equal(runtime.size, 66, "complete reviewed Linux closure, not only direct dependencies");
  assert.deepEqual(runtime.get("semgrep"), {
    version: "1.181.0+remudero.1",
    sha256: "95b93c166f3ebaad3b407bfd4bf573499e1560b46c6500980e8d9acfc96fae52",
  });
  assert.deepEqual(runtime.get("peewee"), {
    version: "3.18.3",
    sha256: "62c3d93315b1a909360c4b43c3a573b47557a1ec7a4583a71286df2a28d4b72e",
  });
  for (const [name, pin] of build) if (runtime.has(name)) assert.deepEqual(runtime.get(name), pin);
  assert.equal(runtime.get("mcp")!.version, "1.30.0");
  assert.equal(runtime.get("pyjwt")!.version, "2.15.1");
  for (const name of ["cryptography", "mcp", "pyjwt", "ruamel-yaml-clib", "opentelemetry-sdk"]) {
    assert.ok(runtime.has(name), `transitive/extra missing: ${name}`);
  }
});

test("native Semgrep lock dialect rejects missing hashes, includes, ranges and duplicate packages", () => {
  const good = "semgrep==1.167.0 --hash=sha256:" + "a".repeat(64) + "\n";
  assert.equal(parseLock(good).size, 1); // Positive control before negative census.
  assert.equal(parseLock(good.replace("1.167.0", "1.181.0+remudero.1")).size, 1);
  for (const bad of [
    "", good.trimEnd(), "semgrep==1.167.0\n", good.replace("==", ">="),
    good.replace("sha256:", "md5:"), good.replace(/a{64}/, "a".repeat(63)),
    "-r other.txt\n", "--extra-index-url https://example.invalid\n",
    "semgrep @ https://example.invalid/file.whl\n", good + good,
    good.replace("semgrep", "Semgrep"), good.replace("\n", " ; python_version > '3'\n"),
    good.replace("1.167.0", "1.181.0+"), good.replace("1.167.0", "1.181.0+unapproved.1"),
    good.replace("semgrep==1.167.0", "other==1.181.0+remudero.1"),
  ]) assert.throws(() => parseLock(bad));
});

test("native Semgrep pins the runner and Python action and caches both hash locks", () => {
  const job = load().jobs.semgrep!;
  assert.equal(job.container, undefined, "never initialize a Docker Hub container");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  const setup = step("Set up pinned Python");
  assert.equal(setup.uses, "actions/setup-python@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0");
  assert.equal(setup.with?.["python-version"], "3.12.15");
  assert.equal(setup.with?.architecture, "x64");
  assert.equal(setup.with?.cache, "pip");
  assert.deepEqual(String(setup.with?.["cache-dependency-path"]).trim().split("\n"), [buildPath, runtimePath]);
});

test("native Semgrep installs into a fresh environment then verifies offline hashes and closure", () => {
  const install = step("Install hash-locked Community Edition");
  const run = install.run!;
  assert.equal(install.shell, "bash");
  assert.equal(install["continue-on-error"], undefined, "install errors must fail Scan, not disappear");
  assert.equal(install.env?.NO_SQLITE, "1");
  assert.match(run, /mktemp -d "\$\{RUNNER_TEMP\}\/semgrep-ce\.XXXXXX"/);
  assert.match(run, /python -I -S -B \.github\/semgrep\/source-runtime-qualification\.py/);
  assert.match(run, /--install-root "\$ROOT" --workspace "\$GITHUB_WORKSPACE" --head "\$\(git rev-parse HEAD\)"/);
  assert.match(run, /VENV="\$ROOT\/runtime-env"/);
  const auditor = read(".github/semgrep/runtime-compatibility-audit.py");
  const qualifier = read(".github/semgrep/source-runtime-qualification.py");
  assert.match(auditor, /"--no-index", "--only-binary=:all:", "--no-deps"/);
  assert.match(auditor, /"--require-hashes", "--find-links"/);
  assert.match(auditor, /"pip", "check"/);
  assert.match(qualifier, /result = audit\(root, workspace, head\)/);
  assert.match(qualifier, /probe = stage_probe\(root, workspace, head\)/);
  assert.match(qualifier, /proof == validate_mcp_observations\(proof.get\("observations"\)\)/);
  const checkIndex = run.indexOf("HASH_BOUND_INSTALL_AND_MCP_CONTROLS_COMPLETE");
  const publishIndex = run.indexOf('>> "$GITHUB_PATH"');
  assert.ok(checkIndex > run.indexOf("--install-root") && publishIndex > checkIndex);
  assert.ok(run.includes('= "1.181.0"'), "CLI/protocol version is distinct from the reviewed local distribution version");
  assert.doesNotMatch(run, /install-semgrep-pro|sudo|docker|uv tool|pipx|curl/);
});

test("W1-T12956 criterion 3 in test/semgrep-native-install.test.ts: W1-T12492 criterion 2 native install preserves qualification controls and fails closed on incompatible or unknown closure evidence", () => {
  const build = parseLock(read(buildPath));
  const runtime = parseLock(read(runtimePath));
  assert.deepEqual([...build], [
    ["packaging", { version: "26.3", sha256: "d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c" }],
    ["pip", { version: "26.2.1", sha256: "71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e" }],
    ["setuptools", { version: "84.1.0", sha256: "5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9" }],
    ["wheel", { version: "0.48.0", sha256: "3217dcc807155e45db462d7ef2431f5ddda0d7273b700d05a67b271ceb1287ab" }],
  ]);
  const reviewedRuntime = [
    ["opentelemetry-api", "1.37.0", "accf2024d3e89faec14302213bc39550ec0f4095d1cf5ca688e1bfb1c8612f47"],
    ["opentelemetry-exporter-otlp-proto-common", "1.37.0", "53038428449c559b0c564b8d718df3314da387109c4d36bd1b94c9a641b0292e"],
    ["opentelemetry-exporter-otlp-proto-http", "1.37.0", "54c42b39945a6cc9d9a2a33decb876eabb9547e0dcb49df090122773447f1aef"],
    ["opentelemetry-instrumentation", "0.58b0", "50f97ac03100676c9f7fc28197f8240c7290ca1baa12da8bfbb9a1de4f34cc45"],
    ["opentelemetry-instrumentation-requests", "0.58b0", "672a0be0bb5b52bea0c11820b35e27edcf4cd22d34abe4afc59a92a80519f8a8"],
    ["opentelemetry-instrumentation-threading", "0.58b0", "eacc072881006aceb5b9b6831bcdce718c67ef6f31ac0b32bd6a23a94d979b4a"],
    ["opentelemetry-proto", "1.37.0", "8ed8c066ae8828bbf0c39229979bdf583a126981142378a9cbe9d6fd5701c6e2"],
    ["opentelemetry-sdk", "1.37.0", "8f3c3c22063e52475c5dbced7209495c2c16723d016d39287dfc215d1771257c"],
    ["opentelemetry-semantic-conventions", "0.58b0", "5564905ab1458b96684db1340232729fce3b5375a06e140e8904c78e4f815b28"],
    ["opentelemetry-util-http", "0.58b0", "6c6b86762ed43025fbd593dc5f700ba0aa3e09711aedc36fd48a13b23d8cb1e7"],
  ] as const;
  for (const [name, version, sha256] of reviewedRuntime) assert.deepEqual(runtime.get(name), { version, sha256 });

  const auditor = fileURLToPath(new URL(".github/semgrep/runtime-compatibility-audit.py", root));
  const validateClosure = (buildText: string, runtimeText: string) => {
    const scratch = mkdtempSync(join(tmpdir(), "rmd-semgrep-native-closure-"));
    try {
      writeFileSync(join(scratch, "build-requirements.txt"), buildText);
      writeFileSync(join(scratch, "requirements.txt"), runtimeText);
      const code = [
        "import importlib.util, pathlib, sys",
        "source, root = sys.argv[1:]",
        "spec = importlib.util.spec_from_file_location('auditor', source)",
        "auditor = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(auditor)",
        "auditor._locked_inputs(pathlib.Path(root))",
        "print('exact hash-locked closure accepted')",
      ].join("\n");
      return spawnSync("python3", ["-I", "-S", "-B", "-c", code, auditor, scratch], { encoding: "utf8" });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  const buildText = read(buildPath);
  const runtimeText = read(runtimePath);
  const current = validateClosure(buildText, runtimeText);
  assert.equal(current.status, 0, `current exact hash locks pass the real closure audit: ${current.stderr}`);
  const previousSetuptools = buildText.replace(
    "setuptools==84.1.0 --hash=sha256:5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9",
    "setuptools==84.0.0 --hash=sha256:51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670",
  );
  assert.notEqual(previousSetuptools, buildText, "the lock pins the reviewed 84.1.0 wheel");
  assert.equal(validateClosure(previousSetuptools, runtimeText).status, 0, "the previous individually reviewed setuptools wheel remains accepted");
  const unknownDigest = buildText.replace("5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9", "0".repeat(64));
  assert.notEqual(unknownDigest, buildText);
  assert.notEqual(validateClosure(unknownDigest, runtimeText).status, 0,
    "an unknown build-tool hash fails closed");
  assert.notEqual(validateClosure(buildText, runtimeText.replace("peewee==3.18.3", "peewee==3.18.4")).status, 0,
    "an incompatible runtime closure fails closed");

  const install = step("Install hash-locked Community Edition");
  const auditorSource = read(".github/semgrep/runtime-compatibility-audit.py");
  assert.equal(install["continue-on-error"], undefined);
  assert.match(auditorSource, /"--no-index".*"--only-binary=:all:"[\s\S]*"--require-hashes"/);
  assert.match(auditorSource, /"pip", "check"/);
  const qualification = step("Qualify native engine, baseline and invalid-rule refusal");
  assert.equal(qualification["continue-on-error"], undefined);
  assert.match(install.run!, /source-runtime-qualification\.py/);
  assert.match(auditorSource, /approved_build_tool_pins/);
});

test("native Semgrep preserves Scan permissions, events, bounded execution and advisory findings", () => {
  const doc = load();
  const job = doc.jobs.semgrep!;
  assert.equal(job.name, "Scan");
  assert.equal(job["timeout-minutes"], 20);
  assert.deepEqual(doc.permissions, { contents: "read" });
  assert.deepEqual(job.permissions, { "security-events": "write", contents: "read", actions: "read" });
  assert.deepEqual(Object.keys(doc.on).sort(), ["pull_request", "schedule", "workflow_dispatch"]);
  assert.deepEqual(doc.concurrency, { group: "semgrep-${{ github.ref }}", "cancel-in-progress": true });
  assert.equal(step("Run Semgrep")["continue-on-error"], true);
  assert.doesNotMatch(read(".github/workflows/semgrep.yml"), /secrets\.|packages:|pull_request_target|docker\.io|ghcr\.io/);
});

// W1-T14822: the SARIF upload is pinned to the same full SHA as codeql.yml's codeql-action, so a
// Dependabot bump that moves the whole codeql-action family keeps this contract without a test edit.
function codeqlActionPin(): string {
  const pins = [...read(".github/workflows/codeql.yml").matchAll(/github\/codeql-action\/[\w-]+@([0-9a-f]{40})\b/g)].map((m) => m[1]);
  assert.ok(pins.length > 0, "codeql.yml pins no codeql-action step to a full SHA");
  assert.equal(new Set(pins).size, 1, `codeql.yml pins codeql-action to more than one SHA: ${[...new Set(pins)].join(", ")}`);
  return pins[0]!;
}

test("W1-T14822 the SARIF upload pin is read from codeql.yml's single codeql-action pin", () => {
  assert.match(codeqlActionPin(), /^[0-9a-f]{40}$/);
});

test("native Semgrep retains all four rule packs, PR-only baseline and SARIF upload contract", () => {
  const steps = load().jobs.semgrep!.steps;
  assert.equal(steps[0]!.with?.["fetch-depth"], 0);
  const scan = step("Run Semgrep");
  const packs = [...scan.run!.matchAll(/--config (p\/[^\s]+)/g)].map(match => match[1]);
  assert.deepEqual(packs, ["p/typescript", "p/javascript", "p/security-audit", "p/secrets"]);
  assert.equal(scan.env?.BASELINE_REF, "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || '' }}");
  assert.match(scan.run!, /--baseline-commit \$\{BASELINE_REF\}/);
  assert.match(scan.run!, /--sarif --output semgrep\.sarif/);
  const upload = step("Upload SARIF to code scanning");
  assert.equal(upload.uses, `github/codeql-action/upload-sarif@${codeqlActionPin()}`);
  assert.equal(upload.if, "always()");
  assert.deepEqual(upload.with, { sarif_file: "semgrep.sarif", category: "semgrep" });
  assert.ok(fileURLToPath(root).endsWith("/"));
});

test("native Semgrep qualification runs in the existing Scan job before the advisory repository scan", () => {
  const steps = load().jobs.semgrep!.steps;
  const qualify = step("Qualify native engine, baseline and invalid-rule refusal");
  assert.match(qualify.run!, /node scripts\/semgrep-native-contract-ratchet\.mjs --receipt "\$RUNNER_TEMP\/semgrep-qualification\.json"/);
  assert.equal(qualify["continue-on-error"], undefined, "broken control behavior must not be reported as qualified");
  // step() reparses the document; compare names in this physical source ordering.
  assert.ok(steps.findIndex(candidate => candidate.name === qualify.name) <
    steps.findIndex(candidate => candidate.name === "Run Semgrep"));
  assert.ok(steps.findIndex(candidate => candidate.name === qualify.name) >
    steps.findIndex(candidate => candidate.name === "Install hash-locked Community Edition"));
  const scan = step("Run Semgrep");
  assert.match(scan.run!, /--json-output "\$RUNNER_TEMP\/semgrep-scan\.json"/);
  assert.match(scan.run!, /exit "\$SCAN_EXIT"/);
  const inventory = step("Record scan inventory without findings or rule redistribution");
  assert.equal(inventory["continue-on-error"], true);
  assert.match(inventory.run!, /--exit "\$SCAN_EXIT"/);
  assert.doesNotMatch(inventory.run!, /upload|curl|--config/);
});
