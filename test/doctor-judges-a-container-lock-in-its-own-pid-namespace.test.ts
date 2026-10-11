/**
 * test/doctor-judges-a-container-lock-in-its-own-pid-namespace.test.ts — W1-T6261.
 *
 * `rmd doctor` on the host used to test every inflight lock's pid against the HOST process table, so
 * a live run inside remudero-daemon (lock host = the container's hostname) read as a dead lock and
 * lock-vs-process WARNed permanently. Fixtures here are real lock files; docker is injected.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { defaultListContainers, defaultPidAliveInContainer, judgeInflightLocks } from "../src/lib/report-commands.js";

type ExecFileSync = typeof import("node:child_process").execFileSync;

function dockerExecutor(reply: (args: readonly string[]) => string): {
  calls: Array<{ file: string; args: string[]; options: unknown }>;
  run: ExecFileSync;
} {
  const calls: Array<{ file: string; args: string[]; options: unknown }> = [];
  const run = ((file: string, args: readonly string[], options: unknown) => {
    calls.push({ file, args: [...args], options });
    return reply(args);
  }) as unknown as ExecFileSync;
  return { calls, run };
}

function fixture(locks: Array<{ task: string; pid: number; host: string }>): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t6261-`));
  const dir = join(root, "state", "inflight");
  mkdirSync(dir, { recursive: true });
  for (const l of locks) {
    writeFileSync(
      join(dir, `${l.task}.lock`),
      JSON.stringify({ pid: l.pid, run_id: `${l.task}-run`, host: l.host, startedAt: "2026-10-07T00:00:00Z" }),
    );
  }
  return root;
}

const CTR = { id: "c0ffee", hostname: "ctr1" };
const HOST_DEPS = {
  hostname: () => "azure-host",
  // The host process table knows NOTHING of pid 114 / 115 — they exist only inside ctr1.
  isPidAlive: (pid: number) => pid === 7,
  listContainers: () => [CTR],
  pidAliveInContainer: (id: string, pid: number) => (id === CTR.id ? pid === 114 : undefined),
};

test("W1-T6261: default Docker container listing injects and records the process boundary", () => {
  const docker = dockerExecutor((args) => args[0] === "ps"
    ? "c1\nc2\n"
    : "c1 ctr1\nmalformed\nc2 ctr2\nextra words here\n");
  assert.deepEqual(defaultListContainers(docker.run), [
    { id: "c1", hostname: "ctr1" },
    { id: "c2", hostname: "ctr2" },
  ]);
  assert.deepEqual(docker.calls.map(({ file, args }) => ({ file, args })), [
    { file: "docker", args: ["ps", "-q"] },
    { file: "docker", args: ["inspect", "-f", "{{.Id}} {{.Config.Hostname}}", "c1", "c2"] },
  ]);
  assert.deepEqual(docker.calls[0].options, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
});

test("W1-T6261: an empty or unreadable Docker listing is distinguished", () => {
  const empty = dockerExecutor(() => "\n");
  assert.deepEqual(defaultListContainers(empty.run), []);
  assert.deepEqual(empty.calls.map(({ args }) => args), [["ps", "-q"]]);

  const failed = dockerExecutor(() => { throw new Error("docker unavailable"); });
  assert.equal(defaultListContainers(failed.run), undefined);
});

test("W1-T6261: container pid probes preserve alive, dead, and unanswered outcomes", () => {
  const alive = dockerExecutor(() => "");
  assert.equal(defaultPidAliveInContainer("c1", 114.9, alive.run), true);
  assert.deepEqual(alive.calls.map(({ file, args }) => ({ file, args })), [
    { file: "docker", args: ["exec", "c1", "sh", "-c", "[ -e /proc/114 ]"] },
  ]);

  const dead = dockerExecutor(() => { throw Object.assign(new Error("pid absent"), { status: 1 }); });
  assert.equal(defaultPidAliveInContainer("c1", 115, dead.run), false);

  const unanswered = dockerExecutor(() => { throw Object.assign(new Error("docker failed"), { status: 125 }); });
  assert.equal(defaultPidAliveInContainer("c1", 116, unanswered.run), undefined);
});

test("W1-T6261: a container lock is judged in its own pid namespace", async () => {
  const root = fixture([
    { task: "T-live-in-ctr", pid: 114, host: "ctr1" },
    { task: "T-dead-in-ctr", pid: 115, host: "ctr1" },
    { task: "T-local", pid: 7, host: "azure-host" },
    { task: "T-elsewhere", pid: 114, host: "other-box" },
  ]);
  const judged = judgeInflightLocks(join(root, "state", "inflight"), HOST_DEPS);
  const liveIds = judged.live.map((r) => r.taskId).sort();
  assert.deepEqual(liveIds, ["T-live-in-ctr", "T-local"], "pid 114 alive only inside ctr1 is live; pid 115 is not");
  assert.ok(!liveIds.includes("T-dead-in-ctr"), "a dead pid in that container is counted dead");
  assert.deepEqual(judged.unverifiable, [{ taskId: "T-elsewhere", host: "other-box" }]);

  // The same fixture through `rmd doctor`: one lock dead (in-container), one unverifiable, none else.
  const { doctorCommand } = await import("../src/run-task.js");
  const lines: string[] = [];
  await doctorCommand([], {
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    loadConfig: () => ({ root }) as never,
    nowMs: Date.parse("2026-10-07T12:00:00Z"),
    readLedgerLines: () => [],
    readMemInfo: () => ({ availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3 }),
    readDiskFreeBytes: () => 40 * 1024 ** 3,
    readPauseAgeMs: () => undefined,
    readGitLocks: () => [],
    readCheckoutDepth: () => ({ shallow: false, commitCount: 980 }),
    readNvmrcVersion: () => process.versions.node,
    readWorktreeBase: () => null,
    readWorktreeHead: () => undefined,
    judgeInflightLocks: (d) => judgeInflightLocks(d, HOST_DEPS),
  });
  const rendered = lines.join("\n");
  assert.match(rendered, /4 lock\(s\), 1 with no live pid/);
  assert.match(rendered, /stale: T-dead-in-ctr(?!,)/);
  assert.match(rendered, /T-elsewhere: unverifiable here \(host other-box\)/);
  assert.doesNotMatch(rendered, /stale:[^\n]*T-live-in-ctr/);
  assert.doesNotMatch(rendered, /stale:[^\n]*T-elsewhere/);
});

test("W1-T6261: an unreadable container table makes a foreign-host lock unverifiable, never dead", () => {
  const root = fixture([{ task: "T-ctr", pid: 114, host: "ctr1" }]);
  const judged = judgeInflightLocks(join(root, "state", "inflight"), { ...HOST_DEPS, listContainers: () => undefined });
  assert.deepEqual(judged.live, []);
  assert.deepEqual(judged.unverifiable, [{ taskId: "T-ctr", host: "ctr1" }]);
  const unanswered = judgeInflightLocks(join(root, "state", "inflight"), { ...HOST_DEPS, pidAliveInContainer: () => undefined });
  assert.deepEqual(unanswered.unverifiable, [{ taskId: "T-ctr", host: "ctr1" }]);
});
