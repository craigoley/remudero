import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "test-with-retry.mjs");

test("unit test: a coverage shard that cannot report names the truncated raw file", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}cov-trunc-`));
  const raw = join(dir, "raw");
  mkdirSync(raw);
  writeFileSync(join(raw, "coverage-4242-1760000000000-0.json"), '{"result":[{"x":"' + "a".repeat(65536 - 17));
  writeFileSync(join(raw, "coverage-4243-1760000000000-1.json"), '{"result":[]}');
  const fake = join(dir, "fake.mjs");
  writeFileSync(
    fake,
    'console.log("# tests 2983\\n# pass 2983\\n# fail 0");' +
      'console.error("Warning: Could not report code coverage. SyntaxError: Unterminated string in JSON at position 65536");' +
      "process.exit(1);",
  );
  const r = spawnSync(process.execPath, [SCRIPT, "--coverage-first-pass", raw, process.execPath, fake], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary.md") },
  });
  const out = r.stdout + r.stderr;
  assert.notEqual(r.status, 0, out);
  assert.match(r.stdout, /COVERAGE-REPORT-FAILED: coverage-4242-1760000000000-0\.json bytes=65536 pid=4242/);
  assert.doesNotMatch(r.stdout, /COVERAGE-REPORT-FAILED: coverage-4243/);
});
