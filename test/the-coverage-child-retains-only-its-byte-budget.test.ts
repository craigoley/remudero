import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { spawnCoverageChild } from "../src/run-task.js";

const run = (body: string, cap = 1024, timeout = 10_000) =>
  spawnCoverageChild(process.execPath, ["-e", body], tmpdir(), process.env, timeout, cap);

test("the coverage child counts UTF-8 bytes rather than string characters", async () => {
  const result = await run('process.stdout.write("💠".repeat(300));');
  assert.equal(result.spawnError, "maxBuffer exceeded (ENOBUFS)");
  assert.equal(result.timedOut, false);
  assert.ok(Buffer.byteLength(result.output) <= 1025, "the only extra byte is the stream separator");
  assert.ok(!result.output.includes("�"), "a retained prefix must not manufacture a partial code point");
});

test("a coverage output cap stops retaining later writes from a terminated child", async () => {
  const result = await run(`
    process.on("SIGTERM", () => {
      process.stdout.write("LATE".repeat(2000));
      setTimeout(() => process.exit(0), 100);
    });
    process.stdout.write("a".repeat(4096));
    setInterval(() => {}, 1000);
  `, 128);
  assert.equal(result.spawnError, "maxBuffer exceeded (ENOBUFS)");
  assert.equal(result.timedOut, false);
  assert.equal(result.output, "a".repeat(128) + "\n");
});

test("coverage stdout and stderr share one byte budget", async () => {
  const result = await run('process.stdout.write("a".repeat(512)); process.stderr.write("b".repeat(513));');
  assert.equal(result.spawnError, "maxBuffer exceeded (ENOBUFS)");
  assert.equal(Buffer.byteLength(result.output), 1025);
});

test("a healthy coverage child preserves code points split across output chunks", async () => {
  const result = await run(`
    const bytes = Buffer.from("💠");
    process.stdout.write(bytes.subarray(0, 2));
    setTimeout(() => process.stdout.write(bytes.subarray(2)), 30);
  `);
  assert.equal(result.status, 0);
  assert.equal(result.spawnError, undefined);
  assert.equal(result.output, "💠\n");
});

test("a truncated coverage code point is omitted without exceeding the byte budget", async () => {
  const result = await run('process.stdout.write("💠");', 1);
  assert.equal(result.spawnError, "maxBuffer exceeded (ENOBUFS)");
  assert.equal(result.output, "\n");
});

test("coverage child spawn and timeout failures remain explicit", async () => {
  const missing = await spawnCoverageChild("/rmd-fixture-no-such-binary", [], tmpdir(), process.env, 1000, 1024);
  assert.equal(missing.status, null);
  assert.match(missing.spawnError ?? "", /ENOENT/);
  const slow = await run('setInterval(() => process.stdout.write("x"), 10);', 1024, 150);
  assert.equal(slow.timedOut, true);
  assert.equal(slow.spawnError, undefined);
});
