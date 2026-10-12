/**
 * #10612 routes `npm run typecheck` through src/lib/typecheck-run.ts, which takes a host test slot when the check runs
 * cold. Inside a Codex WRITER's sandbox that slot resolved nowhere shared: the shell inherits only "core" variables, so
 * RMD_TEST_SLOT_DIR was absent and test-slot.ts `resolveTestSlotDir` fell to a sandbox-local `/tmp/rmd-test-slots`.
 * These tests pin the writer's grant, and that readers and reviews get none.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { spawnCodexWorker } from "../src/lib/worker-provider.js";
import type { ContainedSpawnOptions } from "../src/lib/worker-containment.js";
import type { SpawnWorkerArgs } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const SLOT_DIR = "/home/node/rmd-scratch/test-slots";

async function codexArgv(cwd: string, tools: string[], sandboxIntent?: SpawnWorkerArgs["sandboxIntent"]): Promise<string[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  const workerHome = mkdtempSync(join(tmpdir(), "rmd-codex-slot-home-"));
  let captured: ContainedSpawnOptions | undefined;
  stdin.on("finish", () => {
    stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-slot" })}\n`);
    stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
    stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })}\n`);
    stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
    stdout.end();
    queueMicrotask(() => child.emit("exit", 0));
  });
  try {
    await spawnCodexWorker(
      {
        workerHome,
        cwd,
        prompt: "exercise the slot grant",
        settingsFile: join(process.cwd(), "settings", "worker.json"),
        tools,
        sandboxIntent,
        containment: {
          spawn: (options) => {
            captured = options;
            return { process: child as never, pid: 10_612 };
          },
          teardown: () => {},
        },
      },
      { claudeBin: "/unused", root: cwd, workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna" } },
    );
    assert.ok(captured, "the containment adapter must receive the Codex argv");
    return captured.args;
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
  }
}

/** Run `body` under `env` (an undefined value unsets), as the fleet daemon would by default: NOT inside a test process. */
async function withEnv<T>(env: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const all = { NODE_TEST_CONTEXT: undefined, ...env };
  const saved = Object.fromEntries(Object.keys(all).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(all);
  try {
    return await body();
  } finally {
    apply(saved);
  }
}

const WRITER = ["Read", "Write", "Edit", "Bash"];
const slotArgs = (args: string[]) => args.filter((arg, i) => arg.includes("RMD_TEST_SLOT") || arg === "--add-dir" || args[i - 1] === "--add-dir");

test("a Codex writer alone is granted and told the host test slot dir so its npm run typecheck serialises on the host", async () => {
  const repo = gitRepo({ kind: "codex-slot" });
  const fleet = { RMD_TEST_SLOT_DIR: SLOT_DIR, RMD_TEST_SLOTS: "2" };
  const args = await withEnv(fleet, () => codexArgv(repo.dir, WRITER));
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.deepEqual(slotArgs(args), [
    "--add-dir", SLOT_DIR,
    `shell_environment_policy.set.RMD_TEST_SLOT_DIR="${SLOT_DIR}"`,
    'shell_environment_policy.set.RMD_TEST_SLOTS="2"',
  ], "the writer's bwrap must write a slot record, and its core-only shell must name the dir and the host's slot count");
  assert.ok(args.indexOf("-C") > args.indexOf("--add-dir"), "the grant precedes the cwd and prompt arguments");

  const reader = await withEnv(fleet, () => codexArgv(repo.dir, ["Read", "Bash"]));
  assert.equal(reader[reader.indexOf("--sandbox") + 1], "read-only");
  assert.deepEqual(slotArgs(reader), [], "a read-only worker runs no typecheck that needs the host slot");
  const review = await withEnv(fleet, () => codexArgv(repo.dir, ["Read", "Grep", "Glob", "Bash"], "disposable-review"));
  assert.deepEqual(slotArgs(review), [], "a disposable review keeps its own permission profile, unwidened");
});

test("a Codex writer drops a malformed slot count and gets no slot grant outside the fleet or inside a test process", async () => {
  const repo = gitRepo({ kind: "codex-slot" });
  const malformed = await withEnv({ RMD_TEST_SLOT_DIR: SLOT_DIR, RMD_TEST_SLOTS: "zero" }, () => codexArgv(repo.dir, WRITER));
  assert.deepEqual(slotArgs(malformed), ["--add-dir", SLOT_DIR, `shell_environment_policy.set.RMD_TEST_SLOT_DIR="${SLOT_DIR}"`]);
  const offFleet = await withEnv({ RMD_TEST_SLOT_DIR: undefined, RMD_TEST_SLOTS: undefined }, () => codexArgv(repo.dir, WRITER));
  assert.deepEqual(slotArgs(offFleet), [], "no configured slot dir: nothing to grant");
  const inTest = await withEnv({ RMD_TEST_SLOT_DIR: SLOT_DIR, NODE_TEST_CONTEXT: "child-v8" }, () => codexArgv(repo.dir, WRITER));
  assert.deepEqual(slotArgs(inTest), [], "a suite run in a fleet container builds the same argv as on a Mac");
});
