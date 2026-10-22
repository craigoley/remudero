import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { PLAN_RECORD_ABSENT, taskRecordSha } from "#src/run-task.js";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: this task proves declaration ownership and import direction.
function entrySource(): string {
  return readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
}

function moduleSource(): string {
  return readFileSync(join(REPO_ROOT, "src/cli/commands/run-task-verb.ts"), "utf8");
}

function topLevelFunction(text: string, header: string): string {
  const start = text.indexOf(header);
  assert.notEqual(start, -1, `${header} is declared`);
  const closing = /\n\}(?:[ \t]*\/\/[^\n]*)?(?:\n|$)/.exec(text.slice(start));
  assert.ok(closing, `${header} closes`);
  return text.slice(start, start + closing.index + closing[0].length);
}

test("W1-T9332: runTask is defined in its module and src/run-task.ts only delegates to it", () => {
  const entry = entrySource();
  const module = moduleSource();
  assert.match(module, /^export interface RunTaskCommandHost \{/m);
  for (const [name, minimumLines] of [["runTask", 500], ["runTaskBody", 2000]] as const) {
    const implementation = topLevelFunction(module, `export async function ${name}(`);
    assert.ok(implementation.split("\n").length > minimumLines, `${name} has its implementation`);
    const header = name === "runTask" ? "async function runTask(" : "export async function runTaskBody(";
    const wrapper = topLevelFunction(entry, header);
    assert.ok(wrapper.split("\n").length < 12, `${name} keeps a thin wrapper`);
    assert.match(wrapper, new RegExp(`return ${name}FromModule\\(`));
    assert.match(wrapper, /runTaskCommandHost\(\)/);
    assert.match(entry, new RegExp(`${name} as ${name}FromModule`));
    assert.equal(entry.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "gm"))?.length, 1);
  }
});

test("W1-T9332: the run-task module imports nothing from src/run-task.ts", () => {
  const module = moduleSource();
  const imports = [...module.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(imports.length > 10, "the module imports its library collaborators directly");
  assert.deepEqual(imports.filter((path) => /(^|\/)run-task(?:\.[jt]s)?$/.test(path)), []);
});

// taskRecordSha resolves the task's record path (one read), then hashes the file (a second
// read). If the file vanishes between the two, the second read throws and the digest must read
// as the same ABSENT sentinel a never-resolved record gives. This drives that catch arm.

test("taskRecordSha reads a record that vanishes between path resolution and hashing as absent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-record-vanish-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shardDir = join(root, "plan", "tasks.d");
  mkdirSync(shardDir, { recursive: true });
  const shard = join(shardDir, "task-a.yaml");
  writeFileSync(
    shard,
    ["- id: TASK-A", "  title: task A", "  repo: remudero", "  type: implement", "  files: [src/a.ts]", ""].join("\n"),
  );
  const planPath = join(root, "plan", "tasks.yaml");

  const intact = taskRecordSha(planPath, "TASK-A");
  assert.notEqual(intact, PLAN_RECORD_ABSENT, "control: the intact record hashes to a real digest");

  const real = fs.readFileSync;
  let shardReads = 0;
  let thrown = 0;
  t.mock.method(fs, "readFileSync", ((p: unknown, ...rest: unknown[]) => {
    if (p === shard) {
      shardReads += 1;
      // The first read is taskRecordPath locating the record; the next is the hash read.
      if (shardReads >= 2) {
        thrown += 1;
        throw Object.assign(new Error("ENOENT: record vanished"), { code: "ENOENT" });
      }
    }
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  assert.equal(taskRecordSha(planPath, "TASK-A"), PLAN_RECORD_ABSENT);
  assert.equal(thrown, 1, "the hash read was the one that failed");
});
