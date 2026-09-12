import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "diff-coverage.mjs");

function writeFixture(
  name: string,
  sourceLines: string[],
  uncoveredLine: number,
): { dir: string; lcov: string; diff: string } {
  const dir = mkdtempSync(join(tmpdir(), `rmd-${name}-`));
  const source = `${name}.fxt`;
  const lcov = join(dir, `${name}.lcov`);
  const diff = join(dir, `${name}.diff`);
  writeFileSync(join(dir, source), `${sourceLines.join("\n")}\n`);
  writeFileSync(lcov, `TN:\nSF:${source}\nDA:${uncoveredLine},0\nend_of_record\n`);
  writeFileSync(
    diff,
    [
      `diff --git a/${source} b/${source}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${source}`,
      `@@ -0,0 +1,${sourceLines.length} @@`,
      ...sourceLines.map((line) => `+${line}`),
      "",
    ].join("\n"),
  );
  return { dir, lcov, diff };
}

function runFixture(fixture: { dir: string; lcov: string; diff: string }) {
  return spawnSync(process.execPath, [SCRIPT, "--lcov", fixture.lcov, "--diff", fixture.diff], {
    cwd: fixture.dir,
  });
}

test("diff-coverage: a blocked external-tool spawn names why process-boundary cannot help and points to the injectable seam remedy", () => {
  const result = runFixture(writeFixture("external-spawn", ['execFileSync("npm", ["install"]);'], 1));

  assert.equal(result.status, 1, result.stdout.toString() + result.stderr.toString());
  assert.match(result.stderr.toString(), /external-spawn\.fxt:1 -- external-tool spawn/);
  assert.match(result.stderr.toString(), /process-boundary directive cannot exempt external binaries/);
  assert.match(result.stderr.toString(), /inject the spawn as a parameter defaulted to the real one, appended last/);
});

test("diff-coverage: a blocked ordinary logic line gets no spawn-seam advice", () => {
  const result = runFixture(writeFixture("ordinary-logic", ["const total = input + 1;"], 1));

  assert.equal(result.status, 1, result.stdout.toString() + result.stderr.toString());
  assert.match(result.stderr.toString(), /ordinary-logic\.fxt:1\b/);
  assert.doesNotMatch(result.stderr.toString(), /external-tool spawn/);
  assert.doesNotMatch(result.stderr.toString(), /inject the spawn as a parameter/);
});

test("diff-coverage: re-exec glue keeps its existing process-boundary exemption", () => {
  const result = runFixture(
    writeFixture(
      "reexec-glue",
      [
        "// diff-cov: process-boundary - re-exec glue",
        "function reexec() {",
        '  spawnSync(process.execPath, ["child"]);',
        "}",
      ],
      3,
    ),
  );

  assert.equal(result.status, 0, result.stdout.toString() + result.stderr.toString());
  assert.match(result.stdout.toString(), /exempt \(process-boundary\) reexec-glue\.fxt:3 -- re-exec glue/);
});
