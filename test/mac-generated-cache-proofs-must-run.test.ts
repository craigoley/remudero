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
    const python = join(root, "python3");
    writeFileSync(python, "#!/bin/sh\nprintf '%s\\n' synthetic-python-unavailable >&2\nexit 42\n", { mode: 0o755 });
    chmodSync(python, 0o755);
    // Execute the unchanged real proof with an unavailable interpreter. This
    // negative control must itself fail if an availability skip replaces it.
    const child = spawnSync(process.execPath, [
      "--test", "--test-reporter=tap", "--import", "tsx",
      "--test-name-pattern", proof, join(repo, "test/mac-generated-cache-safety.test.ts"),
    ], {
      cwd: repo, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HOME: root, TMPDIR: root, PATH: root + ":" + (process.env.PATH ?? "/usr/bin:/bin") },
    });
    assert.ifError(child.error);
    const output = child.stdout + child.stderr;
    assert.notEqual(child.status, 0, output);
    const literal = proof.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
    assert.match(child.stdout, new RegExp("^not ok \\d+ - " + literal + "(?:$| #)", "m"), output);
    assert.match(output, /synthetic-python-unavailable/, "the intended interpreter refusal, not an unrelated crash");
    assert.doesNotMatch(child.stdout, new RegExp("^ok \\d+ - " + literal + ".*#\\s*SKIP", "m"), output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
