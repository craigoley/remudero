import assert from "node:assert/strict";
import fs, { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadPlan } from "../src/lib/plan.js";
import { planFilesIdentity } from "../src/lib/thread-plan.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { buildOpenPrViews } from "../src/run-task.js";

const entry = (retired = false) => `- id: W1-T1
  title: fixture task
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: ${retired ? "blocked" : "queued"}
${retired ? "  retirement: retired\n" : ""}`;

function fixture(t: TestContext) {
  const root = makeTempDir("open-pr-plan-cache");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "plan", "tasks.yaml");
  const shard = join(dirname(path), "tasks.d", "W1-T1.yaml");
  mkdirSync(dirname(shard), { recursive: true });
  writeFileSync(path, "[]\n");
  writeFileSync(shard, entry());
  const ledger = join(root, "ledger.ndjson");
  writeFileSync(ledger, "");
  let parses = 0;
  const readMainPlan = () => { parses++; return loadPlan(path); };
  const deps = {
    mainPlanPath: path,
    readMainPlan,
    requiredContexts: () => ["ci-gate"],
    readCiGateRequired: () => [],
    fetch: (args: string[]): unknown => {
      const endpoint = args[1] ?? "";
      if (endpoint.includes("state=open")) return [{
        number: 1, html_url: "https://github.com/o/r/pull/1",
        head: { ref: "run-W1-T1-1", sha: "a".repeat(40) },
        body: "Remudero-Task: W1-T1", state: "open",
      }];
      if (endpoint.includes("/files?")) return [{ filename: "src/example.ts" }];
      if (endpoint.endsWith("/pulls/1")) return { mergeable: true, mergeable_state: "clean" };
      if (endpoint.includes("/check-runs")) return { check_runs: [
        { name: "ci-gate", status: "completed", conclusion: "success" },
      ] };
      if (endpoint.endsWith("/status")) return { statuses: [] };
      throw new Error(`unexpected GitHub read: ${endpoint}`);
    },
  };
  return { path, shard, deps, ledger, build: () => buildOpenPrViews("o", "r", ledger, deps)[0], parses: () => parses };
}

test("W1-T6247: an unchanged plan is parsed once across open-PR view builds", (t) => {
  const f = fixture(t);
  assert.equal(f.build().taskId, "W1-T1");
  assert.equal(f.build().taskId, "W1-T1");
  assert.equal(f.parses(), 1);
});

test("W1-T6247: a changed plan shard is re-read on the next build", (t) => {
  const f = fixture(t);
  const directoryTime = fs.statSync(dirname(f.shard)).mtime;
  assert.equal(f.build().taskRetirement, undefined);
  writeFileSync(f.shard, entry(true));
  utimesSync(dirname(f.shard), directoryTime, directoryTime);
  assert.equal(f.build().taskRetirement, "retired");
  assert.equal(f.build().taskRetirement, "retired");
  assert.equal(f.parses(), 2);
});

test("W1-T6247: monolith edits and added or removed shards invalidate the plan", (t) => {
  const f = fixture(t);
  f.build();
  writeFileSync(f.path, entry(true));
  rmSync(f.shard);
  assert.equal(f.build().taskRetirement, "retired");
  writeFileSync(f.path, "[]\n");
  assert.equal(f.build().taskRetirement, undefined);
  writeFileSync(f.shard, entry(true));
  assert.equal(f.build().taskRetirement, "retired");
  rmSync(f.shard);
  assert.equal(f.build().taskRetirement, undefined);
  f.build();
  assert.equal(f.parses(), 5);
});

test("W1-T6247: an unreadable file identity never reuses a held plan", (t) => {
  const f = fixture(t);
  f.build();
  symlinkSync(join(dirname(f.shard), "missing"), join(dirname(f.shard), "broken.yaml"));
  assert.match(planFilesIdentity(f.path), /broken.yaml=-/);
  f.build();
  f.build();
  assert.equal(f.parses(), 3);
});

test("W1-T6247: an unreadable shard listing reloads while an unsharded plan can be reused", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, entry(true));
  rmSync(dirname(f.shard), { recursive: true });
  assert.equal(f.build().taskRetirement, "retired");
  f.build();
  assert.equal(f.parses(), 1, "an absent shard directory is a readable unsharded plan");
  writeFileSync(dirname(f.shard), "not a directory");
  assert.equal(f.build().taskRetirement, "retired");
  f.build();
  assert.equal(f.parses(), 3, "ENOTDIR is not an unchanged empty shard directory");
});

test("W1-T6247: a failed reload clears the held plan and retries next build", (t) => {
  const f = fixture(t);
  writeFileSync(f.shard, entry(true));
  assert.equal(f.build().taskRetirement, "retired");
  writeFileSync(f.shard, "invalid: plan\n");
  assert.equal(f.build().taskRetirement, undefined);
  assert.equal(f.build().taskRetirement, undefined);
  writeFileSync(f.shard, entry());
  assert.equal(f.build().taskRetirement, undefined);
  f.build();
  assert.equal(f.parses(), 4);
});

test("W1-T6247: reader seams and plan paths cannot share a cached parse", (t) => {
  const a = fixture(t);
  const b = fixture(t);
  writeFileSync(b.shard, entry(true));
  assert.equal(a.build().taskRetirement, undefined);
  assert.equal(b.build().taskRetirement, "retired");
  assert.equal(a.build().taskRetirement, undefined);
  assert.equal(a.parses(), 1);
  assert.equal(b.parses(), 1);
  const otherReader = () => loadPlan(b.path);
  assert.equal(buildOpenPrViews("o", "r", a.ledger, { ...a.deps, readMainPlan: otherReader })[0].taskRetirement, "retired");
});

test("W1-T6247: the default loader reads unchanged plan content once", (t) => {
  const f = fixture(t);
  const real = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((...args: Parameters<typeof real>) => {
    if (args[0] === f.path || args[0] === f.shard) reads++;
    return Reflect.apply(real, fs, args);
  }) as typeof real;
  syncBuiltinESMExports();
  t.after(() => { fs.readFileSync = real; syncBuiltinESMExports(); });
  const deps = { ...f.deps, readMainPlan: undefined };
  buildOpenPrViews("o", "r", f.ledger, deps);
  const firstReads = reads;
  assert.ok(firstReads >= 2, "positive control: the default loader read both plan files");
  buildOpenPrViews("o", "r", f.ledger, deps);
  assert.equal(reads, firstReads);
  writeFileSync(f.shard, entry(true));
  assert.equal(buildOpenPrViews("o", "r", f.ledger, deps)[0].taskRetirement, "retired");
  assert.ok(reads > firstReads);
});
