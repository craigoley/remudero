/**
 * A killed local gate leaked gigabytes onto the host's root filesystem.
 *
 * `--experimental-test-coverage` makes the test runner allocate its coverage scratch as
 * `mkdtemp(join(tmpdir(), "node-coverage-"))` and remove it only on a NORMAL exit. Every killed
 * run therefore leaks one. MEASURED on this host: 6.0G in a single leaked directory, and enough of
 * them filled a 29G root to 100% — which then corrupted a later gate. That gate died on ENOSPC
 * with no `# tests` summary while reporting four failures (a held port, an off-main checkout, two
 * serve rungs) that were artefacts of the full disk rather than of any diff.
 *
 * ⚠ THE OBVIOUS FIX IS THE WRONG ONE, so it is pinned here. `NODE_V8_COVERAGE` does NOT relocate
 * the scratch: measured with it set to a repo path, the runner still wrote under `/tmp` and never
 * created the named directory, because it overrides that variable for the children it spawns.
 * `TMPDIR` is the lever, and the last test proves it end to end rather than asserting the env is
 * merely passed along.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CI_PARITY_TABLE, coverageScratchDir } from "../src/lib/ci-parity.js";
import { defaultPreflightSpawn, type PreflightSpawn } from "../src/lib/commit-message.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function recordingSpawn(calls: { args: string[]; env?: NodeJS.ProcessEnv }[]): PreflightSpawn {
  return (_file, args, opts) => {
    calls.push({ args, env: opts?.env });
    return { status: 0, stdout: "", stderr: "" };
  };
}

function coverageCall(): { args: string[]; env?: NodeJS.ProcessEnv } {
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const entry = CI_PARITY_TABLE.find((e) => e.job === "coverage-ratchet");
  assert.ok(entry?.run, "control: the coverage-ratchet entry exists and is mirrored locally");
  entry!.run!(REPO_ROOT, recordingSpawn(calls));
  const call = calls.find((c) => c.args.includes("--experimental-test-coverage"));
  assert.ok(call, "control: the leaf really did spawn the coverage command");
  return call!;
}

test("the coverage leaf points TMPDIR at a repo-local scratch, not the host's tmp", () => {
  assert.equal(coverageCall().env?.TMPDIR, coverageScratchDir(REPO_ROOT));
});

test("that scratch is inside the repo, under the already-gitignored coverage/ directory", () => {
  const dir = coverageScratchDir(REPO_ROOT);
  assert.ok(dir.startsWith(join(REPO_ROOT, "coverage")), `must live under coverage/; got ${dir}`);
  assert.ok(!dir.startsWith(tmpdir()), "the leak site is os.tmpdir(); the scratch must not be there");
});

test("an injected env is MERGED over process.env, never replacing it", () => {
  // A bare `env` would drop PATH and HOME and every toolchain pin these steps depend on; the
  // failure would surface as a spawn that cannot find node, reported as an ordinary red step.
  const res = defaultPreflightSpawn(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify({probe: process.env.RMD_PROBE, path: Boolean(process.env.PATH)}))"],
    { env: { RMD_PROBE: "set-by-the-caller" } },
  );
  assert.equal(res.status, 0, res.stderr);
  const seen = JSON.parse(res.stdout) as { probe?: string; path: boolean };
  assert.equal(seen.probe, "set-by-the-caller", "the injected key reaches the child");
  assert.equal(seen.path, true, "and PATH survived the merge");
});

test("omitting env leaves inheritance byte-identical to before the hook existed", () => {
  const res = defaultPreflightSpawn(process.execPath, ["-e", "process.stdout.write(String(Boolean(process.env.PATH)))"]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "true");
});

test("END TO END: a KILLED run leaks its scratch where TMPDIR points, not into the host's tmp", async () => {
  // Drives the REAL node binary with the REAL flag, and KILLS it — because a completed run cleans
  // up after itself, so the leak this exists to prevent is only observable on the abnormal exit.
  // Asserting merely that an env key is forwarded would have passed for `NODE_V8_COVERAGE` too,
  // which measurably does NOT relocate the scratch.
  const root = mkdtempSync(join(tmpdir(), "rmd-cov-scratch-"));
  const scratch = join(root, "scratch");
  const spec = join(root, "probe.test.mjs");
  mkdirSync(scratch, { recursive: true });
  // A .mjs probe so the child needs no loader: a .ts spec would die on parse before the runner
  // ever allocated the scratch this measures, and the count would read 0 for the wrong reason.
  writeFileSync(spec, 'import test from "node:test";\ntest("slow", async () => { await new Promise((r) => setTimeout(r, 30000)); });\n');
  const countIn = (dir: string): number => {
    try {
      return readdirSync(dir).filter((e) => e.startsWith("node-coverage-")).length;
    } catch {
      return 0; // absent directory ⇒ nothing was written there, which is the answer this asks
    }
  };
  const killedRun = async (env: NodeJS.ProcessEnv): Promise<void> => {
    // STRIP THE PARENT RUNNER'S OWN MARKERS. This file itself runs under `node --test`, which
    // exports `NODE_TEST_CONTEXT` (and, under a coverage run, `NODE_V8_COVERAGE`). Inherited, they
    // make the child behave as a nested subtest reporter rather than a fresh runner, and it then
    // allocates no scratch at all — the count reads 0 for a reason unrelated to what is measured.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    if (!("NODE_V8_COVERAGE" in env)) delete childEnv.NODE_V8_COVERAGE;
    const child = spawn(process.execPath, ["--experimental-test-coverage", "--test-coverage-exclude=test/**", "--test", spec], {
      cwd: root,
      env: childEnv,
      stdio: "ignore",
    });
    // The exit listener is attached BEFORE the kill: SIGKILL is immediate, and a listener added
    // afterwards can miss the event entirely and hang the test on a promise that never settles.
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise((r) => setTimeout(r, 2500));
    child.kill("SIGKILL");
    await exited;
  };
  try {
    await killedRun({ TMPDIR: scratch });
    assert.equal(countIn(scratch), 1, "the killed run's scratch is where TMPDIR pointed");

    // THE CONTROL, and the reason this test exists: the same kill with NODE_V8_COVERAGE naming a
    // directory does NOT put the scratch there — the runner overrides it for its children.
    const named = join(root, "named-by-node-v8-coverage");
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    await killedRun({ TMPDIR: scratch, NODE_V8_COVERAGE: named });
    assert.equal(countIn(named), 0, "NODE_V8_COVERAGE does not relocate the runner's own scratch");
    assert.equal(countIn(scratch), 1, "TMPDIR still decides where it lands");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
