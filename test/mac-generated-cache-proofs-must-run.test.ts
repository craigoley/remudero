import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("missing Python fails a real janitor safety proof instead of skipping its execution", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-python-proof-required-"));
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const proof = "artifact cache real CLI preserves the fixed six-hour mtime and ctime rule";
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, TMPDIR: root, PATH: root + ":" + (process.env.PATH ?? "/usr/bin:/bin") };
    delete env.NODE_TEST_CONTEXT;
    env.NODE_V8_COVERAGE = undefined;
    const run = () => spawnSync(process.execPath, [
      "--test", "--test-reporter=tap", "--import", "tsx",
      "--test-name-pattern", proof, join(repo, "test/mac-generated-cache-safety.test.ts"),
    ], {
      cwd: repo, encoding: "utf8", timeout: 30_000,
      env,
    });
    const literal = proof.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const skipped = new RegExp("^ok \\d+ - " + literal + ".*#\\s*SKIP", "m");
    const positive = run();
    assert.ifError(positive.error);
    assert.equal(positive.status, 0, positive.stdout + positive.stderr);
    assert.match(positive.stdout, new RegExp("^ok \\d+ - " + literal + "(?:$| #)", "m"));
    assert.doesNotMatch(positive.stdout, skipped);
    const python = join(root, "python3");
    writeFileSync(python, "#!/bin/sh\nprintf '%s\\n' synthetic-python-unavailable >&2\nexit 42\n", { mode: 0o755 });
    chmodSync(python, 0o755);
    const child = run();
    assert.ifError(child.error);
    const output = child.stdout + child.stderr;
    assert.notEqual(child.status, 0, output);
    assert.match(child.stdout, new RegExp("^not ok \\d+ - " + literal + "(?:$| #)", "m"), output);
    assert.match(output, /synthetic-python-unavailable/, "the intended interpreter refusal, not an unrelated crash");
    assert.doesNotMatch(child.stdout, skipped, output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
