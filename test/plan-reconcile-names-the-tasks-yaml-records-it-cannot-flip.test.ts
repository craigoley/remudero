// W1-T5035 — `rmd plan-reconcile` reads plan/tasks.d only and said nothing about plan/tasks.yaml (the monolith),
// so 193 queued records there were invisible to it. The verb now applies its OWN pure decision to each monolith
// record READ-ONLY and prints the queued count plus the ids it would have flipped. It never writes the monolith.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { reconcilePlan } from "../src/lib/plan-reconcile.js";
import { planReconcileCommand, readInlinePlanRecords, renderPlanReconcile } from "../src/run-task.js";

const record = (id: string, status = "queued", extra: string[] = []) => ({
  taskId: id,
  text: [`- id: ${id}`, "  title: t", `  status: ${status}`, ...extra, ""].join("\n"),
});
const shardText = "- id: S1\n  title: t\n  status: queued\n  attempts: 0\n";
const shards = () => [{ taskId: "S1", path: "/p/S1.yaml", text: shardText }];

async function run(args: string[], deps: Parameters<typeof planReconcileCommand>[1]) {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await planReconcileCommand(args, deps);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
}

test("W1-T5035: a dry run names the credited monolith records it cannot flip", async () => {
  const written: string[] = [];
  const rows: Array<Record<string, unknown> | undefined> = [];
  const r = await run([], {
    readShards: shards,
    readInlineRecords: () => [record("M1"), record("M2"), record("M3")],
    creditedMergedIds: () => new Set(["S1", "M1", "M3"]),
    writeShard: (p) => written.push(p),
    log: (_step, extra) => rows.push(extra),
  });
  assert.equal(r.code, 0);
  assert.deepEqual(written, [], "a dry run writes nothing");
  assert.match(r.out, /1 shard\(s\) would be reconciled/);
  assert.match(r.out, /plan\/tasks\.yaml is read-only to this verb \(it is never machine-rewritten\): 3 queued record\(s\) outside the reconcile; 2 credited merged: M1 M3/);
  assert.match(r.out, /flip these by hand in a plan-only PR/);
  assert.equal(rows[0]?.inline_queued, 3);
  assert.equal(rows[0]?.inline_creditable, 2);
});

test("W1-T5035: --write flips a shard, writes no monolith byte and still names the records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t5035-write-"));
  try {
    const shardDir = join(dir, "tasks.d");
    mkdirSync(shardDir, { recursive: true });
    writeFileSync(join(shardDir, "S1.yaml"), shardText, "utf8");
    const monolith = "# header\n" + record("M1").text + "\n" + record("M2").text;
    writeFileSync(join(dir, "tasks.yaml"), monolith, "utf8");
    const r = await run(["--plan", shardDir, "--write"], { creditedMergedIds: () => new Set(["S1", "M1"]) });
    assert.equal(r.code, 0);
    assert.match(readFileSync(join(shardDir, "S1.yaml"), "utf8"), /^ {2}status: merged$/m, "the shard flipped");
    assert.equal(readFileSync(join(dir, "tasks.yaml"), "utf8"), monolith, "not one monolith byte changed");
    assert.match(r.out, /2 queued record\(s\) outside the reconcile; 1 credited merged: M1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T5035: a retired or merged monolith record is never named as creditable", async () => {
  const r = await run([], {
    readShards: shards,
    readInlineRecords: () => [
      record("RET", "queued", ["  retirement: superseded"]),
      record("MRG", "merged"),
      { taskId: "NOS", text: "- id: NOS\n  title: t\n" },
      record("Q1"),
      record("Q2"),
    ],
    creditedMergedIds: () => new Set(["RET", "MRG", "NOS", "Q1"]),
  });
  assert.match(r.out, /: 2 queued record\(s\) outside the reconcile; 1 credited merged: Q1\n/);
  assert.doesNotMatch(r.out, /RET|MRG|NOS/);
});

test("W1-T5035: with no queued monolith record the output is byte-identical to before", async () => {
  const baseline = renderPlanReconcile(reconcilePlan(shards(), (id) => id === "S1").summary, false);
  for (const inline of [undefined, [record("MRG", "merged")], [] as ReturnType<typeof record>[]]) {
    const r = await run([], { readShards: shards, readInlineRecords: () => inline, creditedMergedIds: () => new Set(["S1"]) });
    assert.equal(r.out, baseline);
  }
  // No tasks.yaml beside the shard directory at all: the real default reader answers undefined.
  const dir = mkdtempSync(join(tmpdir(), "rmd-t5035-none-"));
  try {
    const shardDir = join(dir, "tasks.d");
    mkdirSync(shardDir);
    writeFileSync(join(shardDir, "S1.yaml"), shardText, "utf8");
    const r = await run(["--plan", shardDir], { creditedMergedIds: () => new Set(["S1"]) });
    assert.equal(r.out, baseline);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A queued but uncredited record is counted, with no id list and no hand-flip instruction.
  const some = await run([], { readShards: shards, readInlineRecords: () => [record("Q1")], creditedMergedIds: () => new Set(["S1"]) });
  assert.match(some.out, /: 1 queued record\(s\) outside the reconcile; 0 credited merged$/);
  assert.doesNotMatch(some.out, /flip these by hand/);
});

test("W1-T5035: a monolith record is decided by its own id so identical status lines never collide", async () => {
  const r = await run([], {
    readShards: () => [],
    readInlineRecords: () => [record("A"), record("B"), record("C")],
    creditedMergedIds: () => new Set(["B"]),
  });
  assert.match(r.out, /: 3 queued record\(s\) outside the reconcile; 1 credited merged: B\n/);
  assert.doesNotMatch(r.out, /credited merged: [AC]|B [AC]|[AC] B/);
});

test("W1-T5035: an unreadable monolith is reported and never read as no records", async () => {
  const injected = await run([], {
    readShards: shards,
    readInlineRecords: () => {
      throw new Error("EACCES: boom");
    },
    creditedMergedIds: () => new Set(["S1"]),
  });
  assert.equal(injected.code, 0, "an additional report never turns a working reconcile into a failure");
  assert.match(injected.out, /1 shard\(s\) would be reconciled/);
  assert.match(injected.out, /plan\/tasks\.yaml: unreadable \(EACCES: boom\), its queued records were not counted/);
  assert.doesNotMatch(injected.out, /queued record\(s\) outside/);

  // The real default reader on a monolith that exists but cannot be read (a directory).
  const dir = mkdtempSync(join(tmpdir(), "rmd-t5035-unreadable-"));
  try {
    const shardDir = join(dir, "tasks.d");
    mkdirSync(shardDir);
    mkdirSync(join(dir, "tasks.yaml"));
    const real = await run(["--plan", shardDir], { readShards: shards, creditedMergedIds: () => new Set(["S1"]) });
    assert.equal(real.code, 0);
    assert.match(real.out, /plan\/tasks\.yaml: unreadable \(.*EISDIR.*\), its queued records were not counted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T5035: the default reader splits the real monolith into its records", () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "plan", "tasks.yaml");
  const text = readFileSync(path, "utf8");
  const expected = [...text.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]);
  const records = readInlinePlanRecords(path)!;
  assert.ok(expected.length > 100, "positive control: the real monolith has many records");
  assert.deepEqual(records.map((x) => x.taskId), expected, "none lost, none merged, in file order");
  assert.equal(new Set(expected).size, expected.length, "no id duplicated");
  assert.ok(records.every((x) => x.text.startsWith(`- id: ${x.taskId}`)));
  assert.equal(records.map((x) => x.text).join(""), text.slice(text.search(/^- id: /m)), "the records tile the file with no byte dropped");
  assert.equal(readInlinePlanRecords(join(dirname(path), "no-such-tasks.yaml")), undefined);
  assert.equal(existsSync(path), true);
});
