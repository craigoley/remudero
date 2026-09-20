import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  promoteIntroducedPlanOnlyDiagnostics,
  type LintViolation,
} from "../src/lib/task-linter.js";
import { lintPlanCommand } from "../src/run-task.js";
import { isolatedCheckout } from "./helpers/isolated-checkout.js";

const FIXTURE = isolatedCheckout(process.cwd());

test.after(() => FIXTURE.cleanup());

const diagnostic = (check: LintViolation["check"], message = `${check} finding`): LintViolation => ({
  check,
  severity: "warn",
  message,
});

test("W1-T3814: each named diagnostic blocks when introduced on a new shard", () => {
  for (const check of ["shared-proof", "call-site", "proof-scope"] as const) {
    const [result] = promoteIntroducedPlanOnlyDiagnostics([diagnostic(check)], undefined, true);
    assert.equal(result.severity, "block", check);
    assert.match(result.message, /introduced by this plan-only shard/);
  }
});

test("W1-T3814: an inherited diagnostic remains a visible warning", () => {
  const head = diagnostic("shared-proof", "same historical warning");
  const [result] = promoteIntroducedPlanOnlyDiagnostics([head], [head], false);
  assert.deepEqual(result, head);
});

test("W1-T3814: a changed shard with a new diagnostic fails closed, while unrelated checks stay unchanged", () => {
  const inherited = diagnostic("proof-scope", "old warning");
  const newWarning = diagnostic("proof-scope", "new warning");
  const unrelated = diagnostic("duplicate-title");
  const result = promoteIntroducedPlanOnlyDiagnostics(
    [inherited, newWarning, unrelated],
    [inherited],
    false,
  );
  assert.equal(result[0].severity, "warn");
  assert.equal(result[1].severity, "block");
  assert.equal(result[2].severity, "warn");
});

test("W1-T3814: a clean new shard stays clean", () => {
  assert.deepEqual(promoteIntroducedPlanOnlyDiagnostics([], undefined, true), []);
});

test("W1-T3814: the real --base plan-only path blocks an introduced shared-proof diagnostic", async () => {
  const shardDir = join(FIXTURE.root, "plan", "tasks.d");
  mkdirSync(shardDir, { recursive: true });
  const shardPath = join(shardDir, "W1-T3814-fixture.yaml");
  const proof = "unit test: test/plan-only-new-task-diagnostics.test.ts";
  writeFileSync(
    shardPath,
    [
      "- id: W1-T3814-FIXTURE",
      '  title: "plan-only diagnostic fixture"',
      "  repo: remudero",
      "  depends_on: []",
      "  type: implement",
      "  verify: auto",
      "  risk: low",
      "  status: queued",
      "  attempts: 0",
      "  origin: architect",
      "  files: [src/lib/task-linter.ts]",
      "  acceptance:",
      '    - claim: "first criterion"',
      `      proof: "${proof}"`,
      '    - claim: "second criterion"',
      `      proof: "${proof}"`,
      "",
    ].join("\n"),
  );
  const base = execFileSync("git", ["-C", FIXTURE.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", FIXTURE.root, "add", "plan/tasks.d/W1-T3814-fixture.yaml"]);
  execFileSync("git", ["-C", FIXTURE.root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture(plan): add diagnostic shard"]);

  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (message?: unknown) => void lines.push(String(message));
  console.warn = (message?: unknown) => void lines.push(String(message));
  console.error = (message?: unknown) => void lines.push(String(message));
  try {
    const exitCode = await lintPlanCommand(["--plan", join(FIXTURE.root, "plan", "tasks.yaml"), "--base", base], {
      repoRoot: FIXTURE.root,
      offline: true,
    });
    assert.equal(exitCode, 1, lines.join("\n"));
    const output = lines.join("\n");
    assert.match(output, /W1-T3814-FIXTURE/);
    assert.match(output, /\[shared-proof\]/);
    assert.match(output, /introduced by this plan-only shard/);
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
});
