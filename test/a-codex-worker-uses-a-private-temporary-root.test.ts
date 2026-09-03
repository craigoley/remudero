import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { spawnCodexWorker } from "../src/lib/worker-provider.js";
import type { ContainedSpawnOptions } from "../src/lib/worker-containment.js";

function deferredCodexProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const process = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  let exited = false;
  return {
    process,
    finish(exitCode = 0, error?: string) {
      if (exited) return;
      exited = true;
      stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: `codex-${Math.random()}` })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
      if (error) stdout.write(`${JSON.stringify({ type: "turn.failed", error: { message: error } })}\n`);
      else {
        stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })}\n`);
        stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
      }
      stdout.end();
      queueMicrotask(() => process.emit("exit", exitCode));
    },
    exitFromTeardown() {
      if (exited) return;
      exited = true;
      stdout.end();
      process.emit("exit", null);
    },
  };
}

function config(root: string, codexHome = join(root, "durable-codex-home")) {
  return {
    claudeBin: "/unused/claude",
    root,
    workerProviders: { enabled: ["codex" as const], codexBin: "/bin/sh", codexHome },
  };
}

test("W1-T2750: overlapping fresh and resumed Codex workers get distinct private TMPDIRs and contain startup metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-private-tmp-overlap-"));
  const sharedTmp = join(root, "caller-shared-tmp");
  const durableHome = join(root, "codex-home");
  mkdirSync(sharedTmp);
  mkdirSync(durableHome);
  const suppliedEnv = { TMPDIR: sharedTmp, SAFE_VALUE: "preserved" };
  const captures: Array<{
    options: ContainedSpawnOptions;
    privateTmp: string;
    process: ReturnType<typeof deferredCodexProcess>;
  }> = [];

  const launch = (pid: number, resumeSessionId?: string) => {
    const controlled = deferredCodexProcess();
    const promise = spawnCodexWorker(
      {
        cwd: process.cwd(),
        prompt: "exercise the private temp root",
        resumeSessionId,
        env: suppliedEnv,
        containment: {
          spawn: (options) => {
            const privateTmp = options.env.TMPDIR;
            assert.equal(typeof privateTmp, "string");
            assert.ok(existsSync(privateTmp!), "the private TMPDIR exists before Codex is spawned");
            mkdirSync(join(privateTmp!, ".git"), { recursive: true });
            captures.push({ options, privateTmp: privateTmp!, process: controlled });
            return { process: controlled.process as never, pid };
          },
          teardown: () => {
            const capture = captures.find((entry) => entry.process === controlled);
            assert.ok(capture && existsSync(capture.privateTmp), "TMPDIR survives through process-group teardown");
          },
        },
      },
      config(root, durableHome),
    );
    return { promise, controlled };
  };

  const first = launch(27_501);
  const second = launch(27_502, "resume-thread");
  try {
    assert.equal(captures.length, 2);
    assert.notEqual(captures[0]!.privateTmp, captures[1]!.privateTmp, "concurrent workers never share temp state");
    assert.notEqual(captures[0]!.privateTmp, sharedTmp, "caller TMPDIR cannot collapse isolation");
    assert.notEqual(captures[1]!.privateTmp, sharedTmp, "resume uses the same private-temp policy");
    assert.equal(existsSync(join(sharedTmp, ".git")), false, "startup metadata never reaches the shared root");
    assert.equal(captures[0]!.options.cwd, process.cwd());
    assert.equal(captures[1]!.options.cwd, process.cwd());
    assert.equal(captures[0]!.options.env.CODEX_HOME, durableHome, "durable provider state is not relocated");
    assert.equal(captures[1]!.options.env.CODEX_HOME, durableHome);
    assert.equal(captures[0]!.options.env.SAFE_VALUE, "preserved");
    assert.deepEqual(suppliedEnv, { TMPDIR: sharedTmp, SAFE_VALUE: "preserved" }, "caller env is not mutated");
    assert.ok(!captures[0]!.options.args.includes("resume"));
    assert.ok(captures[1]!.options.args.includes("resume"));
  } finally {
    first.controlled.finish();
    second.controlled.finish();
    await Promise.allSettled([first.promise, second.promise]);
  }

  assert.equal(existsSync(captures[0]!.privateTmp), false, "fresh worker temp state is reaped after teardown");
  assert.equal(existsSync(captures[1]!.privateTmp), false, "resumed worker temp state is reaped after teardown");
  assert.equal(process.env.TMPDIR === captures[0]!.privateTmp || process.env.TMPDIR === captures[1]!.privateTmp, false);
  rmSync(root, { recursive: true, force: true });
});

test("W1-T2750: provider-error and synchronous-spawn paths both reap only their private trees", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-private-tmp-errors-"));
  const sharedTmp = join(root, "shared");
  mkdirSync(sharedTmp);

  const providerProcess = deferredCodexProcess();
  let providerTmp = "";
  const providerPromise = spawnCodexWorker(
    {
      cwd: process.cwd(),
      prompt: "return a provider error",
      env: { TMPDIR: sharedTmp },
      containment: {
        spawn: (options) => {
          providerTmp = options.env.TMPDIR!;
          assert.ok(existsSync(providerTmp));
          return { process: providerProcess.process as never, pid: 27_503 };
        },
        teardown: () => assert.ok(existsSync(providerTmp), "provider error cleans up after group teardown"),
      },
    },
    config(root),
  );
  providerProcess.finish(1, "provider refused the turn");
  const providerResult = await providerPromise;
  assert.equal(providerResult.isError, true);
  assert.equal(existsSync(providerTmp), false);

  let spawnTmp = "";
  await assert.rejects(
    spawnCodexWorker(
      {
        cwd: process.cwd(),
        prompt: "fail synchronously",
        env: { TMPDIR: sharedTmp },
        containment: {
          spawn: (options) => {
            spawnTmp = options.env.TMPDIR!;
            assert.ok(existsSync(spawnTmp));
            throw new Error("synchronous spawn failure");
          },
        },
      },
      config(root),
    ),
    /synchronous spawn failure/,
  );
  assert.equal(existsSync(spawnTmp), false);
  assert.ok(existsSync(sharedTmp), "cleanup never removes a caller-owned path");
  rmSync(root, { recursive: true, force: true });
});

test("W1-T2750: a clock timeout keeps the private TMPDIR through teardown and removes it afterward", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-private-tmp-timeout-"));
  const controlled = deferredCodexProcess();
  let privateTmp = "";
  let teardownCalls = 0;
  await assert.rejects(
    spawnCodexWorker(
      {
        cwd: process.cwd(),
        prompt: "wait forever",
        env: { TMPDIR: join(root, "ignored-caller-tmp") },
        clockBound: { boundMs: 1 },
        containment: {
          spawn: (options) => {
            privateTmp = options.env.TMPDIR!;
            assert.ok(existsSync(privateTmp));
            return { process: controlled.process as never, pid: 27_504 };
          },
          teardown: () => {
            teardownCalls += 1;
            assert.ok(existsSync(privateTmp), "the timeout tears down the process before deleting its TMPDIR");
            controlled.exitFromTeardown();
          },
        },
      },
      config(root),
    ),
    /exceeded the 1ms clock bound/,
  );
  assert.ok(teardownCalls >= 1);
  assert.equal(existsSync(privateTmp), false);
  rmSync(root, { recursive: true, force: true });
});
