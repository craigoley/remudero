// test/a-piped-command-output-is-never-truncated.test.ts — W1-T4063.
//
// MEASURED 2026-09-22: `rmd ledger-grep` printed 522 of 280,672 matching lines through a pipe and every
// line to a file. `main()` ended with `process.exit(...)`, and on POSIX a PIPE is written asynchronously,
// so the exit dropped whatever the pipe had not yet taken. These tests drive REAL child processes through
// a pipe the parent deliberately does not read for a while — the condition under which the loss happens.
// The control proves the harness can see the loss at all, so the first test cannot pass vacuously.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FLUSH_EXIT = join(ROOT, "src", "lib", "flush-exit.ts");
const ROWS = 5000;
/** How long the parent leaves the pipe unread — long enough for a child to fill it and exit. */
const HOLD_MS = 1500;

interface ChildResult {
  code: number | null;
  stdout: string;
}

/** Run `args` with stdout piped to a reader that waits HOLD_MS before reading anything. */
function runThroughSlowPipe(args: string[], env: NodeJS.ProcessEnv = {}, cwd = ROOT): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.pause();
    setTimeout(() => {
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stdout.resume();
    }, HOLD_MS);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") }));
  });
}

/** A child that prints ROWS lines and then exits the way `exitLine` says. */
function writerScript(dir: string, exitLine: string): string {
  const path = join(dir, "writer.mts");
  writeFileSync(
    path,
    `import { flushThenExit } from ${JSON.stringify(FLUSH_EXIT)};\n` +
      `void flushThenExit;\n` +
      `for (let i = 0; i < ${ROWS}; i++) console.log(JSON.stringify({ i, pad: "x".repeat(60) }));\n` +
      `${exitLine}\n`,
  );
  return path;
}

const count = (text: string, needle: string): number => text.split("\n").filter((line) => line.includes(needle)).length;

void test("W1-T4063: piped ledger-grep output is complete", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4063-home-`));
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    mkdirSync(join(home, "root", "state"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: process.execPath, root: join(home, "root") }) + "\n",
    );
    let archive = "";
    for (let i = 0; i < ROWS; i++) archive += JSON.stringify({ ts: "2026-09-01T00:00:00.000Z", step: "probe.row", i, pad: "x".repeat(60) }) + "\n";
    writeFileSync(join(home, "root", "state", "ledger.2026-09-01T00-00-00-000Z.ndjson"), archive);
    writeFileSync(join(home, "root", "state", "ledger.ndjson"), "");

    const result = await runThroughSlowPipe(
      ["--import", "tsx", join(ROOT, "src", "run-task.ts"), "ledger-grep", "probe\\.row"],
      { HOME: home, RMD_SELF_SYNC_DONE: "1" },
    );
    assert.equal(result.code, 0);
    assert.equal(count(result.stdout, '"probe.row"'), ROWS, "every matching line must reach the pipe's reader");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

void test("W1-T4063: control: a bare process.exit truncates the same write", async () => {
  // Without this control, a reader that happened to drain the pipe fast enough would make the first test
  // pass whether or not the fix is present.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4063-control-`));
  try {
    const result = await runThroughSlowPipe(["--import", "tsx", writerScript(dir, "process.exit(0);")]);
    assert.ok(count(result.stdout, '"pad"') < ROWS, `a bare process.exit must lose lines here (got ${count(result.stdout, '"pad"')} of ${ROWS})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("W1-T4063: the exit code survives the flush", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4063-code-`));
  try {
    const result = await runThroughSlowPipe(["--import", "tsx", writerScript(dir, "await flushThenExit(3);")]);
    assert.equal(result.code, 3);
    assert.equal(count(result.stdout, '"pad"'), ROWS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("W1-T4063: an early-closed reader does not hang the exit", async () => {
  // `rmd … | head` closes the pipe after a few lines; the writer must still exit, with its own code.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4063-head-`));
  try {
    const script = writerScript(dir, "await flushThenExit(0);");
    const outcome = await new Promise<{ code: number | null } | "hung">((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
      const guard = setTimeout(() => {
        child.kill("SIGKILL");
        resolve("hung");
      }, 30_000);
      child.stdout.once("data", () => child.stdout.destroy());
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(guard);
        resolve({ code });
      });
    });
    assert.notEqual(outcome, "hung", "the writer must exit when its reader goes away");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
