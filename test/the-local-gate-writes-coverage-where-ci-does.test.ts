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
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { CI_PARITY_TABLE, coverageScratchDir } from "../src/lib/ci-parity.js";
import { defaultPreflightSpawn, type PreflightSpawn } from "../src/lib/commit-message.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

// BACKSTOP only: readiness is a positive child acknowledgment, never elapsed sleep.
const PROBE_READY_BACKSTOP_MS = 20_000;
const PROBE_CLOSE_BACKSTOP_MS = 5_000;
type ProbeOwner = { root: string; groups: Set<number> };

function countCoverageScratch(dir: string): number {
  try {
    return readdirSync(dir).filter((entry) => entry.startsWith("node-coverage-")).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error; // unreadable/not-a-directory is UNKNOWN, never an empty measurement
  }
}

function probeGroupGone(pid: number): boolean {
  try { process.kill(-pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}

function disposeProbe(owner: ProbeOwner): void {
  assert.equal(owner.groups.size, 0, `keep fixture evidence until its owned groups close: ${owner.root}`);
  rmSync(owner.root, { recursive: true, force: true });
}

async function killReadyCoverageProbe(owner: ProbeOwner, env: NodeJS.ProcessEnv, options: {
  waitForRelease?: boolean;
  earlyExit?: boolean;
  afterStarted?: (release: () => void) => void;
} = {}): Promise<void> {
  const nonce = randomUUID(), spec = join(owner.root, `probe-${nonce}.test.mjs`);
  const startedPath = join(owner.root, `started-${nonce}.json`), readyPath = join(owner.root, `ready-${nonce}.json`);
  const releasePath = join(owner.root, `release-${nonce}`);
  writeFileSync(spec, options.earlyExit
    ? 'process.stderr.write("intentional-before-ready\\n"); process.exitCode = 7;\n'
    : `import test from "node:test";
import { existsSync, renameSync, writeFileSync } from "node:fs";
const witness = { nonce: process.env.RMD_PROBE_NONCE, pid: process.pid };
const publish = path => {
  writeFileSync(path + ".next", JSON.stringify(witness), { flag: "wx" });
  renameSync(path + ".next", path);
};
publish(process.env.RMD_PROBE_STARTED);
test("slow", async () => {
  const expiry = setTimeout(() => process.exit(9), 30000);
  if (process.env.RMD_PROBE_WAIT_RELEASE === "1") {
    while (!existsSync(process.env.RMD_PROBE_RELEASE)) await new Promise(resolve => setTimeout(resolve, 10));
  }
  publish(process.env.RMD_PROBE_READY);
  await new Promise(resolve => setTimeout(resolve, 30000));
  clearTimeout(expiry);
});\n`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env,
    RMD_PROBE_NONCE: nonce, RMD_PROBE_STARTED: startedPath, RMD_PROBE_READY: readyPath,
    RMD_PROBE_RELEASE: releasePath, RMD_PROBE_WAIT_RELEASE: options.waitForRelease ? "1" : "0" };
  delete childEnv.NODE_TEST_CONTEXT;
  // Node's copyProcessEnvToEnv checks OWN-PROPERTY presence, so undefined suppresses
  // reinjection without replacing a caller's explicit named-coverage control.
  if (!("NODE_V8_COVERAGE" in env)) childEnv.NODE_V8_COVERAGE = undefined;
  const child = spawn(process.execPath, ["--experimental-test-coverage", "--test-coverage-exclude=test/**", "--test", "--test-reporter=tap", spec], {
    cwd: owner.root, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let closed = false, output = "", fault: Error | undefined;
  child.once("close", () => { closed = true; });
  child.once("error", error => { fault = error; });
  const collect = (chunk: Buffer) => {
    if (output.length + chunk.length > 8192) fault = new Error("coverage probe output exceeded its bound");
    output = (output + chunk.toString()).slice(0, 8192);
  };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  if (child.pid !== undefined) owner.groups.add(child.pid);
  const wait = async (predicate: () => boolean, bound: number, reason: string): Promise<void> => {
    const end = performance.now() + bound;
    while (!predicate() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), `${reason}; code=${child.exitCode} signal=${child.signalCode}\n${output}`);
  };
  try {
    assert.ok(child.pid, "control: the real coverage runner spawned");
    let acknowledgedStart = false;
    // BEGIN positive readiness barrier — the controlled-release regression removes this block.
    await wait(() => {
      if (fault) throw fault;
      if (closed) throw new Error(`coverage probe exited before readiness; code=${child.exitCode}\n${output}`);
      if (!acknowledgedStart && existsSync(startedPath)) {
        const started = JSON.parse(readFileSync(startedPath, "utf8"));
        assert.equal(started.nonce, nonce); assert.ok(Number.isSafeInteger(started.pid) && started.pid > 0);
        acknowledgedStart = true;
        options.afterStarted?.(() => writeFileSync(releasePath, nonce, { flag: "wx" }));
      }
      if (!existsSync(readyPath)) return false;
      const ready = JSON.parse(readFileSync(readyPath, "utf8"));
      assert.equal(ready.nonce, nonce); assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0);
      return true;
    }, PROBE_READY_BACKSTOP_MS, "coverage probe did not acknowledge readiness");
    // END positive readiness barrier
    assert.equal(closed, false, "the acknowledged runner is still live before deliberate cancellation");
  } finally {
    if (child.pid !== undefined) {
      // This group was exclusively created above. Kill the whole group, not merely
      // the test-runner leader; its worker can otherwise survive for thirty seconds.
      if (!probeGroupGone(child.pid)) process.kill(-child.pid, "SIGKILL");
      await wait(() => closed && probeGroupGone(child.pid!), PROBE_CLOSE_BACKSTOP_MS,
        "owned coverage probe group/stdio did not close");
      owner.groups.delete(child.pid);
    }
  }
}

function recordingSpawn(calls: { args: string[]; env?: NodeJS.ProcessEnv }[]): PreflightSpawn {
  return (file, args, opts) => {
    calls.push({ args, env: opts?.env });
    if (file === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${PINNED_BASE_SHA}\n`, stderr: "" };
    if (args.some((arg) => arg.endsWith("scripts/test-tier-manifest.mjs")) && args.includes("--select-all")) {
      return { status: 0, stdout: "test/the-local-gate-writes-coverage-where-ci-does.test.ts\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

function coverageCall(repoRoot = REPO_ROOT): { args: string[]; env?: NodeJS.ProcessEnv } {
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const entry = CI_PARITY_TABLE.find((e) => e.job === "coverage-ratchet");
  assert.ok(entry?.run, "control: the coverage-ratchet entry exists and is mirrored locally");
  entry!.run!(repoRoot, recordingSpawn(calls), () => Number.MAX_SAFE_INTEGER, randomUUID());
  const call = calls.find((c) => c.args.includes("--experimental-test-coverage"));
  assert.ok(call, "control: the leaf really did spawn the coverage command");
  return call!;
}

test("coverage shards use canonical TMPDIR paths when the sibling scratch parent is symlinked", () => {
  // This is a top-level sibling-volume fixture, not a child of the outer coverage TMPDIR.
  const tempRoot = mkdtempSync(join("/tmp", `${RMD_TMP_PREFIX}g-`));
  const repoRoot = join(tempRoot, "repo");
  const physicalScratchParent = join(tempRoot, "p");
  const scratchParentAlias = join(tempRoot, "a");
  mkdirSync(repoRoot);
  mkdirSync(physicalScratchParent);
  symlinkSync(physicalScratchParent, scratchParentAlias, "dir");
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratchParentAlias;
  const scratch = coverageScratchDir(repoRoot);
  try {
    assert.equal(dirname(scratch), realpathSync(physicalScratchParent));
    assert.equal(coverageCall(repoRoot).env?.TMPDIR, scratch);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(scratch, { recursive: true, force: true });
    rmSync(scratchParentAlias, { force: true });
    rmSync(physicalScratchParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("that scratch is a stable sibling namespace, never a child of the Git worktree", () => {
  const dir = coverageScratchDir(REPO_ROOT);
  assert.match(basename(dir), /^rmd-c-[a-f0-9]{12}$/);
  assert.ok(!dir.startsWith(`${REPO_ROOT}/`), `must be outside the checkout; got ${dir}`);
  const previousTmp = process.env.TMPDIR;
  try {
    process.env.TMPDIR = join(dir, "node-coverage-fixture");
    assert.equal(coverageScratchDir(REPO_ROOT), dir, "an inherited nested TMPDIR must not compound the scratch path");
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  }
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
  const owner: ProbeOwner = { root, groups: new Set() };
  mkdirSync(scratch, { recursive: true });
  try {
    await killReadyCoverageProbe(owner, { TMPDIR: scratch });
    assert.equal(countCoverageScratch(scratch), 1, "the killed run's scratch is where TMPDIR pointed");

    // THE CONTROL, and the reason this test exists: the same kill with NODE_V8_COVERAGE naming a
    // directory does NOT put the scratch there — the runner overrides it for its children.
    const named = join(root, "named-by-node-v8-coverage");
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    await killReadyCoverageProbe(owner, { TMPDIR: scratch, NODE_V8_COVERAGE: named });
    assert.equal(countCoverageScratch(named), 0, "NODE_V8_COVERAGE does not relocate the runner's own scratch");
    assert.equal(countCoverageScratch(scratch), 1, "TMPDIR still decides where it lands");
  } finally {
    disposeProbe(owner);
  }
});

test("coverage scratch probe waits for controlled readiness before killing its owned group", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-cov-ready-")), scratch = join(root, "scratch");
  const owner: ProbeOwner = { root, groups: new Set() }; mkdirSync(scratch);
  let released = false;
  try {
    await killReadyCoverageProbe(owner, { TMPDIR: scratch }, { waitForRelease: true,
      afterStarted: release => { assert.equal(released, false); released = true; release(); } });
    assert.equal(released, true, "the real child must reach the controlled startup barrier");
    assert.equal(owner.groups.size, 0, "all owned group members and stdio are closed");
    assert.equal(countCoverageScratch(scratch), 1, "a positive acknowledged run leaves its abnormal-exit scratch");
  } finally { disposeProbe(owner); }
});

test("coverage scratch probe reports a real early exit instead of an empty location measurement", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-cov-early-")), scratch = join(root, "scratch");
  const owner: ProbeOwner = { root, groups: new Set() }; mkdirSync(scratch);
  try {
    await assert.rejects(killReadyCoverageProbe(owner, { TMPDIR: scratch }, { earlyExit: true }),
      /exited before readiness[\s\S]*intentional-before-ready/);
    assert.equal(owner.groups.size, 0, "the failed startup also closes every owned process");
  } finally { disposeProbe(owner); }
});

test("coverage scratch discovery preserves read errors instead of reporting zero", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-cov-read-")), file = join(root, "not-a-directory");
  try {
    assert.equal(countCoverageScratch(join(root, "absent")), 0);
    writeFileSync(file, "positive unreadable-directory control");
    assert.throws(() => countCoverageScratch(file), { code: "ENOTDIR" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
