// W1-T6156: the push coverage precheck runs the WORKER's own scripts/diff-coverage-local.mjs over the worker's own
// suites. These tests drive the REAL default runner (no injected `run`) with a recording stand-in for bwrap and pin
// that the worker's code starts only inside the proof sandbox's argv, with no credential and a throwaway HOME — and
// that a sandbox which cannot start is a named `unavailable` that never runs the worker's code.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { AffectedSelection } from "../src/lib/affected-suites.js";
import { probeProofSandbox, proofSandboxArgv, setProofSandboxForTests } from "../src/lib/review.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { coveragePrecheck, type CoveragePrecheck, type CoveragePrecheckPorts } from "../src/run-task.js";

const SUITE = "test/feature.test.ts";
const CREDENTIALS = { GH_TOKEN: "fixture-token", GH_APP_ID: "123", GITHUB_TOKEN: "fixture-actions-token" };
const credentialKeys = (env: Record<string, unknown>) => Object.keys(env).filter((k) => /^(GH_|GITHUB_)|TOKEN|PRIVATE_KEY/.test(k));

type Recorded = { argv: string[]; env: Record<string, string> };

const ports: CoveragePrecheckPorts = {
  changedFiles: () => ["src/feature.ts"],
  select: (): AffectedSelection => ({ suites: [SUITE], fullRun: false, reasons: [], recentOnly: { floor: [] } }),
  manifest: () => ({ thresholdMs: 30_000, files: { [SUITE]: 1 } }),
};

function readLines(path: string): Recorded[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Recorded) : [];
}

/** A worktree whose diff-coverage-local.mjs records its argv and env, a planted daemon secret outside it, and a
 *  recording stand-in for bwrap that either refuses or runs whatever follows its `--`. */
function fixture(sandbox: "runs" | "refuses" = "runs") {
  const root = makeTempDir("t6156");
  const wt = join(root, "work");
  const shared = join(root, "shared-install");
  const secret = join(root, "daemon-secrets", "app-key.pem");
  const marker = join(root, "worker-ran.jsonl");
  const log = join(root, "sandbox-runner.jsonl");
  const runner = join(root, "fake-bwrap.mjs");
  mkdirSync(join(wt, "scripts"), { recursive: true });
  mkdirSync(shared, { recursive: true });
  mkdirSync(join(root, "daemon-secrets"), { recursive: true });
  writeFileSync(secret, "fixture daemon key\n");
  symlinkSync(shared, join(wt, "node_modules"), "dir");
  writeFileSync(join(wt, "scripts", "diff-coverage-local.mjs"), `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + "\\n");
mkdirSync("coverage", { recursive: true });
writeFileSync("coverage/precheck-lcov.info", "TN:\\n");
process.stdout.write("diff-coverage: OK\\n");
`);
  writeFileSync(runner, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, env: process.env }) + "\\n");
if (${JSON.stringify(sandbox)} === "refuses") { process.stderr.write("bwrap: setting up uid map: Permission denied\\n"); process.exit(1); }
const at = argv.indexOf("--");
const r = spawnSync(argv[at + 1], argv.slice(at + 2), { cwd: process.cwd(), env: process.env, stdio: "inherit" });
process.exit(r.status ?? 2);
`);
  chmodSync(runner, 0o755);
  return { root, wt, shared, secret, runner, worker: () => readLines(marker), sandboxRuns: () => readLines(log) };
}

async function precheckWithCredentials(wt: string, secret: string): Promise<CoveragePrecheck> {
  const vars: Record<string, string> = { ...CREDENTIALS, GH_APP_PRIVATE_KEY_PATH: secret };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await coveragePrecheck(wt, ports);
  } finally {
    for (const [k, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  }
}

const reasonOf = (r: CoveragePrecheck) => (r.outcome === "unavailable" ? r.reason : `not unavailable: ${JSON.stringify(r)}`);

afterEach(() => setProofSandboxForTests());

describe("test/the-coverage-precheck-runs-the-worker-s-suites-in-the-proof-sandbox.test.ts", () => {
  test("the real runner starts the worker's diff-coverage-local.mjs only inside proofSandboxArgv, credential-free with a throwaway HOME", async () => {
    const f = fixture();
    try {
      setProofSandboxForTests({ mode: "bwrap", binary: f.runner });
      const result = await precheckWithCredentials(f.wt, f.secret);
      assert.equal(result.outcome, "covered", JSON.stringify(result));
      const runs = f.sandboxRuns();
      assert.equal(runs.length, 2, "a start probe, then the precheck itself");
      const [probe, child] = runs as [Recorded, Recorded];
      assert.deepEqual(probe.argv.slice(probe.argv.indexOf("--") + 1), [process.execPath, "-e", ""]);
      const at = child.argv.indexOf("--");
      assert.deepEqual(child.argv.slice(at + 1), [
        process.execPath, join(f.wt, "scripts", "diff-coverage-local.mjs"), "--base", "origin/main", "--lcov", "coverage/precheck-lcov.info", SUITE,
      ]);
      const home = child.env.HOME!;
      assert.notEqual(home, process.env.HOME);
      assert.equal(existsSync(home), false, "the throwaway HOME is removed once the run settles");
      mkdirSync(home, { recursive: true });
      try {
        assert.deepEqual(child.argv.slice(0, at + 1), proofSandboxArgv({ cwd: f.wt, home, env: { ...process.env, GH_APP_PRIVATE_KEY_PATH: f.secret } }),
          "the sandbox argv is W1-T6124's, for this worktree and this HOME");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
      assert.deepEqual(probe.argv.slice(0, probe.argv.indexOf("--") + 1), child.argv.slice(0, at + 1), "the probe started the same sandbox");
      assert.ok(child.argv.includes("--unshare-net"));
      const real = realpathSync(f.wt);
      assert.ok(child.argv.some((a, i) => a === "--bind" && child.argv[i + 1] === real), "the worktree stays writable for the lcov");
      assert.ok(child.argv.some((a, i) => a === "--ro-bind" && child.argv[i + 1] === realpathSync(f.shared)), "the node_modules link target is read-only");
      const secretDir = realpathSync(join(f.root, "daemon-secrets"));
      assert.equal(child.argv.filter((a) => a.startsWith(secretDir)).length, 0, "no bind exposes the planted daemon secret");
      for (const { env } of [probe, child, ...f.worker()]) {
        assert.deepEqual(credentialKeys(env), []);
        assert.equal(env.HOME, home);
        assert.equal(env.TMPDIR, "/tmp");
      }
      assert.equal(child.env.NODE_V8_COVERAGE, "", "the parent's coverage session is blanked");
      const worker = f.worker();
      assert.equal(worker.length, 1);
      assert.deepEqual(worker[0]!.argv, ["--base", "origin/main", "--lcov", "coverage/precheck-lcov.info", SUITE]);
      assert.equal(existsSync(join(f.wt, "coverage", "precheck-lcov.info")), true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("an unavailable sandbox is a named unavailable that never spawns the sandbox or the worker's script", async () => {
    const f = fixture();
    try {
      setProofSandboxForTests({ mode: "unsandboxed", reason: "fixture: user namespaces unavailable" });
      const result = await precheckWithCredentials(f.wt, f.secret);
      assert.equal(result.outcome, "unavailable");
      assert.match(reasonOf(result), /^spawn failed: proof sandbox could not start: fixture: user namespaces unavailable$/);
      assert.deepEqual(f.sandboxRuns(), []);
      assert.deepEqual(f.worker(), []);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("a refusing bwrap fails the start probe by name and runs no worker code", async () => {
    const f = fixture("refuses");
    try {
      setProofSandboxForTests({ mode: "bwrap", binary: f.runner });
      const result = await precheckWithCredentials(f.wt, f.secret);
      assert.equal(result.outcome, "unavailable");
      assert.match(reasonOf(result), /proof sandbox could not start: bwrap: setting up uid map: Permission denied/);
      assert.equal(f.sandboxRuns().length, 1, "only the start probe ran");
      assert.deepEqual(f.worker(), []);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("an absent sandbox binary and an absent worktree are each a named unavailable", async () => {
    const f = fixture();
    try {
      setProofSandboxForTests({ mode: "bwrap", binary: join(f.root, "no-such-bwrap") });
      const absentBinary = await precheckWithCredentials(f.wt, f.secret);
      assert.match(reasonOf(absentBinary), /proof sandbox could not start: .*ENOENT/);
      setProofSandboxForTests({ mode: "bwrap", binary: f.runner });
      const absentTree = await precheckWithCredentials(join(f.root, "absent-work"), f.secret);
      assert.match(reasonOf(absentTree), /proof sandbox could not start: ENOENT/);
      assert.deepEqual(f.sandboxRuns(), []);
      assert.deepEqual(f.worker(), []);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("on macOS the precheck degrades to a named skip, never an unsandboxed run", async () => {
    const f = fixture();
    try {
      setProofSandboxForTests(probeProofSandbox("darwin"));
      const result = await precheckWithCredentials(f.wt, f.secret);
      assert.equal(result.outcome, "unavailable");
      assert.match(reasonOf(result), /proof sandbox could not start: bwrap is Linux-only/);
      assert.deepEqual(f.worker(), []);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("real bwrap: the worker's run writes its lcov in the worktree and cannot see the daemon secret", async (t) => {
    const status = probeProofSandbox();
    if (status.mode !== "bwrap") {
      t.skip(`real-bwrap arm unavailable: ${status.reason}`);
      return;
    }
    const f = fixture();
    try {
      writeFileSync(join(f.wt, "scripts", "diff-coverage-local.mjs"), `import { existsSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync("coverage", { recursive: true });
writeFileSync("coverage/precheck-lcov.info", JSON.stringify({ secret: existsSync(${JSON.stringify(f.secret)}) }));
process.stdout.write("diff-coverage: OK\\n");
`);
      setProofSandboxForTests(status);
      const result = await precheckWithCredentials(f.wt, f.secret);
      assert.equal(result.outcome, "covered", JSON.stringify(result));
      assert.deepEqual(JSON.parse(readFileSync(join(f.wt, "coverage", "precheck-lcov.info"), "utf8")), { secret: false });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
