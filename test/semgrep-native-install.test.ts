import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.equal(setup.uses, "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97");
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
  assert.equal(upload.uses, "github/codeql-action/upload-sarif@6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee");
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
