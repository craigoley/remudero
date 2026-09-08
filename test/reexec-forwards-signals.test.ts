import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { reexecExitCode, superviseReexecChild } from "../src/lib/self-sync.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const SELF_SYNC_IMPORT = pathToFileURL(join(REPO_ROOT, "src", "lib", "self-sync.ts")).href;
type ReexecParentProcess = ChildProcessByStdio<null, Readable, Readable>;

class FakeReexecChild extends EventEmitter {
  readonly killedSignals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.killedSignals.push(signal);
    return true;
  }
}

class FakeSignalSource extends EventEmitter {
  override removeListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.removeListener(eventName, listener);
  }
}

// W1-T2903's shared fixture, not a hand-rolled `git init`. It already pins the identity env the
// runner needs (CLAUDE.md's #1971 class: `commit-tree` refuses `Author identity unknown` on a CI
// runner and passes on every dev machine), and `cloneFrom` is exactly the origin+checkout shape this
// test wants — so the duplication the fixture-copy census counts is avoided rather than recorded.
function gitFixture(): { originDir: string; localDir: string } {
  const origin = gitRepo({ kind: "reexec-signal-origin" });
  writeFileSync(join(origin.dir, "seed.txt"), "one\n");
  origin.git("add", ".");
  origin.git("commit", "--quiet", "-m", "init");
  const local = gitRepo({ cloneFrom: origin.dir, kind: "reexec-signal-local" });
  // Published AFTER the clone, so the local checkout is deliberately one commit behind.
  writeFileSync(join(origin.dir, "published.txt"), "published\n");
  origin.git("add", ".");
  origin.git("commit", "--quiet", "-m", "published");
  return { originDir: origin.dir, localDir: local.dir };
}

function writeHarnessScript(dir: string): string {
  const scriptPath = join(dir, "reexec-parent.ts");
  writeFileSync(
    scriptPath,
    `
import { writeFileSync } from "node:fs";
import { checkCliFreshness, SELF_SYNC_GUARD_ENV } from ${JSON.stringify(SELF_SYNC_IMPORT)};

const markerDir = process.env.RMD_REEXEC_MARKER_DIR;
const localDir = process.env.RMD_REEXEC_LOCAL_DIR;
if (!markerDir || !localDir) throw new Error("missing re-exec fixture env");

function mark(name, body = String(process.pid)) {
  writeFileSync(markerDir + "/" + name, body);
}

if (process.env[SELF_SYNC_GUARD_ENV] === "1") {
  mark("child-ready");
  process.on("SIGTERM", () => {
    mark("child-sigterm");
    process.exit(Number(process.env.RMD_REEXEC_SIGNAL_EXIT_CODE ?? "42"));
  });
  setTimeout(
    () => process.exit(Number(process.env.RMD_REEXEC_CHILD_EXIT_CODE ?? "23")),
    Number(process.env.RMD_REEXEC_CHILD_DELAY_MS ?? "50"),
  );
} else {
  const result = checkCliFreshness(localDir, process.env, {
    say: () => {},
    warn: (msg) => mark("parent-warning", msg),
    log: () => {},
  });
  mark("parent-returned", JSON.stringify(result));
}
`,
    "utf8",
  );
  return scriptPath;
}

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  delete env.RMD_SELF_SYNC_DONE;
  return env;
}

function spawnParent(scriptPath: string, env: NodeJS.ProcessEnv): ReexecParentProcess {
  return spawn(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForExit(
  child: ReexecParentProcess,
  timeoutMs = 8_000,
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out waiting for re-exec parent; stdout=${stdout}; stderr=${stderr}`));
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.once("exit", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function killIfAlive(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already exited
  }
}

test("re-exec supervision forwards parent termination signals until the child exits", () => {
  const child = new FakeReexecChild();
  const signalSource = new FakeSignalSource();
  const exits: number[] = [];
  superviseReexecChild(child, {
    exit: (code) => {
      exits.push(code);
    },
    signalSource,
    signals: ["SIGTERM", "SIGHUP"],
  });

  signalSource.emit("SIGTERM");
  assert.deepEqual(child.killedSignals, ["SIGTERM"]);
  assert.deepEqual(exits, [], "parent exit waits for the re-exec child's own status");

  child.emit("exit", 42, null);
  assert.deepEqual(exits, [42]);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  assert.equal(signalSource.listenerCount("SIGHUP"), 0);

  child.emit("exit", 17, null);
  assert.deepEqual(exits, [42], "a second child event must not exit twice");
});

test("re-exec supervision reports spawn errors and removes signal handlers before exit", () => {
  const child = new FakeReexecChild();
  const signalSource = new FakeSignalSource();
  const exits: number[] = [];
  const reports: string[] = [];
  superviseReexecChild(child, {
    exit: (code) => {
      exits.push(code);
    },
    reportError: (message) => {
      reports.push(message);
    },
    signalSource,
    signals: ["SIGINT"],
  });

  child.emit("error", new Error("spawn failed"));
  assert.deepEqual(exits, [1]);
  assert.match(reports[0] ?? "", /re-exec failed: Error: spawn failed/);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);

  signalSource.emit("SIGINT");
  assert.deepEqual(child.killedSignals, [], "signal listeners are gone after the parent exits");
});

test("re-exec exit-code translation preserves status and maps signal-only exits", () => {
  assert.equal(reexecExitCode(0, "SIGTERM"), 0);
  assert.equal(reexecExitCode(23, null), 23);
  assert.equal(reexecExitCode(null, "SIGTERM"), 143);
  assert.equal(reexecExitCode(null, null), 1);
});

test("default re-exec passes through the fresh child's ordinary exit code", async () => {
  const { localDir } = gitFixture();
  const markerDir = mkdtempSync(join(tmpdir(), "rmd-reexec-markers-"));
  const scriptPath = writeHarnessScript(markerDir);
  const parent = spawnParent(
    scriptPath,
    cleanEnv({
      RMD_REEXEC_LOCAL_DIR: localDir,
      RMD_REEXEC_MARKER_DIR: markerDir,
      RMD_REEXEC_CHILD_EXIT_CODE: "23",
      RMD_REEXEC_CHILD_DELAY_MS: "25",
    }),
  );

  try {
    const result = await waitForExit(parent);
    assert.equal(result.status, 23, `stdout=${result.stdout}; stderr=${result.stderr}`);
    assert.equal(result.signal, null);
    assert.ok(existsSync(join(markerDir, "child-ready")), "the guarded child really ran");
    assert.ok(!existsSync(join(markerDir, "child-sigterm")), "the no-signal control must stay ordinary");
  } finally {
    killIfAlive(join(markerDir, "child-ready"));
  }
});

test("default re-exec forwards SIGTERM to the fresh child and exits with the child's status", async () => {
  const { localDir } = gitFixture();
  const markerDir = mkdtempSync(join(tmpdir(), "rmd-reexec-markers-"));
  const scriptPath = writeHarnessScript(markerDir);
  const parent = spawnParent(
    scriptPath,
    cleanEnv({
      RMD_REEXEC_LOCAL_DIR: localDir,
      RMD_REEXEC_MARKER_DIR: markerDir,
      RMD_REEXEC_CHILD_DELAY_MS: "5000",
      RMD_REEXEC_SIGNAL_EXIT_CODE: "42",
    }),
  );

  try {
    await waitForFile(join(markerDir, "child-ready"));
    parent.kill("SIGTERM");
    const result = await waitForExit(parent);
    assert.equal(result.status, 42, `stdout=${result.stdout}; stderr=${result.stderr}`);
    assert.equal(result.signal, null);
    assert.equal(
      await waitForFile(join(markerDir, "child-sigterm")),
      readFileSync(join(markerDir, "child-ready"), "utf8"),
      "the signal marker must be written by the re-exec child itself",
    );
  } finally {
    killIfAlive(join(markerDir, "child-ready"));
  }
});
