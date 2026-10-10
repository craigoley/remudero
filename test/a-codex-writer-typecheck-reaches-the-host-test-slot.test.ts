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

import { codexTestSlotArgs, spawnCodexWorker } from "../src/lib/worker-provider.js";
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

/** Run `body` as the fleet daemon would: the slot dir named, and NOT inside a test process. */
async function asFleetDaemon<T>(body: () => Promise<T>): Promise<T> {
  const saved = { dir: process.env.RMD_TEST_SLOT_DIR, slots: process.env.RMD_TEST_SLOTS, ctx: process.env.NODE_TEST_CONTEXT };
  process.env.RMD_TEST_SLOT_DIR = SLOT_DIR;
  process.env.RMD_TEST_SLOTS = "2";
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return await body();
  } finally {
    for (const [key, value] of [["RMD_TEST_SLOT_DIR", saved.dir], ["RMD_TEST_SLOTS", saved.slots], ["NODE_TEST_CONTEXT", saved.ctx]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a Codex writer is granted and told the host test slot dir so its npm run typecheck serialises on the host", async () => {
  const repo = gitRepo({ kind: "codex-slot" });
  const args = await asFleetDaemon(() => codexArgv(repo.dir, ["Read", "Write", "Edit", "Bash"]));
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  const grant = args.indexOf("--add-dir");
  assert.ok(grant >= 0, "the writer's bwrap must be able to write a slot record");
  assert.equal(args[grant + 1], SLOT_DIR);
  assert.ok(args.includes(`shell_environment_policy.set.RMD_TEST_SLOT_DIR="${SLOT_DIR}"`), "the core-only shell must see the slot dir");
  assert.ok(args.includes('shell_environment_policy.set.RMD_TEST_SLOTS="2"'), "the shell must count the same slots as the host");
  assert.ok(args.indexOf("-C") > grant, "the grant precedes the cwd and prompt arguments");
});

test("a Codex reader and a disposable review get no host test slot grant", async () => {
  const repo = gitRepo({ kind: "codex-slot" });
  const reader = await asFleetDaemon(() => codexArgv(repo.dir, ["Read", "Bash"]));
  assert.equal(reader[reader.indexOf("--sandbox") + 1], "read-only");
  assert.equal(reader.includes("--add-dir"), false);
  assert.equal(reader.some((arg) => arg.includes("RMD_TEST_SLOT")), false);
  const review = await asFleetDaemon(() => codexArgv(repo.dir, ["Read", "Grep", "Glob", "Bash"], "disposable-review"));
  assert.equal(review.includes("--add-dir"), false);
  assert.equal(review.some((arg) => arg.includes("RMD_TEST_SLOT")), false);
});

test("codexTestSlotArgs grants nothing outside the fleet or inside a test process", () => {
  assert.deepEqual(codexTestSlotArgs({ RMD_TEST_SLOT_DIR: SLOT_DIR, RMD_TEST_SLOTS: "2" }), [
    "--add-dir", SLOT_DIR,
    "-c", `shell_environment_policy.set.RMD_TEST_SLOT_DIR="${SLOT_DIR}"`,
    "-c", 'shell_environment_policy.set.RMD_TEST_SLOTS="2"',
  ]);
  assert.deepEqual(codexTestSlotArgs({ RMD_TEST_SLOT_DIR: SLOT_DIR, RMD_TEST_SLOTS: "zero" }), [
    "--add-dir", SLOT_DIR, "-c", `shell_environment_policy.set.RMD_TEST_SLOT_DIR="${SLOT_DIR}"`,
  ]);
  assert.deepEqual(codexTestSlotArgs({}), []);
  assert.deepEqual(codexTestSlotArgs({ RMD_TEST_SLOT_DIR: SLOT_DIR, NODE_TEST_CONTEXT: "child-v8" }), []);
});
