// @source-text-subject: retirement checks executable references and the generator's baseline row.
// @census-reads: .github/ package.json src/ plan/claims.yaml scripts/comment-load-baseline.json
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT as ROOT } from "#test/helpers/repo-root.js";

const LIVE_PATHS = [".github", "package.json", "src", "plan/claims.yaml"];

test("test/screenshot-artefact-retired.test.ts: the generator is absent with no live invocation", () => {
  const generator = "scripts/shell-screenshot.mjs";
  assert.equal(existsSync(join(ROOT, generator)), false, `${generator} must be retired`);
  const baseline = JSON.parse(readFileSync(join(ROOT, "scripts/comment-load-baseline.json"), "utf8"));
  assert.equal(Object.hasOwn(baseline, generator), false, `${generator} has a stale comment-load row`);
  const control = spawnSync("git", ["grep", "-l", "-I", "-F", "--", "diff-coverage", ...LIVE_PATHS], {
    cwd: ROOT, encoding: "utf8",
  });
  assert.ifError(control.error);
  assert.equal(control.status, 0, control.stderr);
  assert.ok(control.stdout.trim(), "the reference query must see known live script references");
  const references = spawnSync("git", ["grep", "-l", "-I", "-F", "--", "shell-screenshot", ...LIVE_PATHS], {
    cwd: ROOT, encoding: "utf8",
  });
  assert.ifError(references.error);
  assert.equal(references.status, 1, references.stderr || references.stdout);
  assert.equal(references.stdout, "");
});

test("test/screenshot-artefact-retired.test.ts: neither design-review image remains tracked", () => {
  const images = [
    "docs/design-review/w1-t153/shell-1440.png",
    "docs/design-review/w1-t153/shell-390.png",
  ];
  for (const image of images) assert.equal(existsSync(join(ROOT, image)), false, image);
  assert.equal(execFileSync("git", ["ls-tree", "--name-only", "HEAD", "--", ...images], {
    cwd: ROOT, encoding: "utf8",
  }), "", "the committed tree must no longer track either retired screenshot");
});

function runGateProperty(title: string): void {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_V8_COVERAGE = "";
  const result = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap", "--import", "tsx",
    "--import", "./test/setup/tmp-hygiene.ts",
    "--test-name-pattern", `^${title}$`, "test/no-raw-nul.test.ts",
  ], { cwd: ROOT, encoding: "utf8", env });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.ok(output.includes(`# Subtest: ${title}\n`), output);
  assert.match(output, /^# tests 1$/m, output);
  assert.match(output, /^# pass 1$/m, output);
  assert.match(output, /^# fail 0$/m, output);
}

test("test/screenshot-artefact-retired.test.ts: the nul gate still admits the tracked attachment", () => {
  runGateProperty("PROPERTY the tracked attachment PNG still contains a NUL and still passes the gate unbanned");
});

test("test/screenshot-artefact-retired.test.ts: the nul gate still catches a planted covered-file nul", () => {
  runGateProperty("PROPERTY a planted raw NUL in a covered file fails the check and names the exact path");
});
