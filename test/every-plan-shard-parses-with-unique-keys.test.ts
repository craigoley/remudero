// W1-T5472 — on 2026-10-03 #8872 and #8871 each added a `priority:` line to one shard from the
// same base. Git merged both cleanly, main carried the key twice, and the yaml parser's unique-keys
// check refused the WHOLE plan, so the daemon crash-looped until #8877. This suite holds main to
// the parse that refused it. The fixture case keeps the proof honest while main is clean.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as armModule from "../src/lib/arm-auto-merge.js";

type Scan = (planDir: string) => Array<{ path: string; error: string }>;
// Read off the namespace so this file still LOADS on a tree without the export, and fails per test.
const scan = (armModule as Record<string, unknown>).unloadablePlanShards as Scan;

const PLAN_DIR = fileURLToPath(new URL("../plan/", import.meta.url));

test("every plan shard parses with unique keys", () => {
  const bad = scan(PLAN_DIR);
  assert.deepEqual(
    bad.map((b) => `${b.path}: ${b.error}`),
    [],
    "a shard with a duplicate key makes the whole plan unloadable",
  );
});

test("the unique-keys scan reports a shard with a duplicate key by path", () => {
  const planDir = mkdtempSync(join(tmpdir(), "rmd-w1t5472-plan-"));
  mkdirSync(join(planDir, "tasks.d"));
  const clean = join(planDir, "tasks.d", "w1-t1-clean.yaml");
  const dup = join(planDir, "tasks.d", "w1-t5431-selector-shadow-miss.yaml");
  writeFileSync(join(planDir, "tasks.yaml"), "- id: W1-T0\n  title: root\n  priority: 1\n");
  writeFileSync(clean, "- id: W1-T1\n  title: clean\n  priority: 4\n");
  // The 2026-10-03 shape: two branches each added a `priority:` line to one entry.
  writeFileSync(dup, "- id: W1-T5431\n  title: shadow miss\n  priority: 4\n  status: queued\n  priority: 2.5\n");
  writeFileSync(join(planDir, "tasks.d", "README.md"), "priority: 1\npriority: 2\n");

  const bad = scan(planDir);

  assert.deepEqual(bad.map((b) => b.path), [dup], "only the duplicate-key shard is reported, by its path");
  assert.match(bad[0].error, /unique/i, "the parser's own unique-keys message is carried");
  assert.ok(!bad[0].error.includes("\n"), "one line per failure");
});

test("the unique-keys scan collects every failing file, tasks.yaml included, not just the first", () => {
  const planDir = mkdtempSync(join(tmpdir(), "rmd-w1t5472-plan-"));
  mkdirSync(join(planDir, "tasks.d"));
  const root = join(planDir, "tasks.yaml");
  const a = join(planDir, "tasks.d", "a.yaml");
  const b = join(planDir, "tasks.d", "b.yaml");
  writeFileSync(root, "- id: W1-T0\n  risk: low\n  risk: high\n");
  writeFileSync(a, "- id: W1-T1\n  files: [x]\n  files: [y]\n");
  writeFileSync(b, "- id: W1-T2\n  title: ok\n");

  assert.deepEqual(scan(planDir).map((r) => r.path), [root, a]);
  assert.deepEqual(scan(join(planDir, "absent")), [], "a directory with no plan files reports nothing");
});
