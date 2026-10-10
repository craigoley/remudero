import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { configPath } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { retroCommand, resolveRepoRoot } from "../src/run-task.js";
import { withHealthyRetroProbeGh } from "./helpers/w4226-g1-retro-probe-gh.js";
import { offlineGithub } from "./setup/offline-github.js";

const installRoot = resolveRepoRoot(process.argv.slice(2), process.cwd());
const sentinel = "cobalt marmalade telescope synchronizes otter postcards";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-plan-once-"));
  const checkout = join(root, "checkout");
  const home = join(root, "home");
  mkdirSync(join(checkout, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(checkout, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(checkout, "plan", "tasks.d", "sentinel.yaml"), JSON.stringify([{
    id: "FIXTURE-T1", title: sentinel, repo: "remudero", type: "implement",
    depends_on: [], files: ["src/sentinel.ts"],
  }]) + "\n");
  mkdirSync(join(checkout, ".remudero"));
  writeFileSync(join(checkout, ".remudero", "mounts.yaml"), readFileSync(join(installRoot, ".remudero", "mounts.yaml")));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "ledger.fixture.ndjson"), JSON.stringify({
    ts: new Date().toISOString(), run_id: "fixture-followup", task_id: "FIXTURE-T1",
    step: "report.followups", entries: [{ type: "task", text: sentinel }],
  }) + "\n");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  writeFileSync(configPath(), JSON.stringify({ root, installRoot, claudeBin: "/bin/true" }));
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const logs = t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  const github = offlineGithub();
  return {
    checkout, github, errors,
    report: () => logs.mock.calls.map((call) => String(call.arguments[0])).join("\n"),
    run: () => withHealthyRetroProbeGh(() => withLiveWritesAllowed(() =>
      retroCommand(["--dry-run"], { repoRoot: checkout, github }))),
  };
}

test("W1-T7615: one retro gather parses the plan once", async (t) => {
  const fx = fixture(t);
  const stat = fs.statSync.bind(fs);
  const read = fs.readFileSync.bind(fs);
  const planStats: string[] = [];
  const planReads: string[] = [];
  const statSpy = t.mock.method(fs, "statSync", (target: unknown, ...args: unknown[]) => {
    if (String(target).endsWith(join("plan", "tasks.yaml"))) planStats.push(String(target));
    return stat(target as string, ...(args as []));
  });
  const readSpy = t.mock.method(fs, "readFileSync", (target: unknown, ...args: unknown[]) => {
    if (String(target).endsWith(join("plan", "tasks.yaml"))) planReads.push(String(target));
    return read(target as string, ...(args as []));
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await fx.run(), 0);
    // Each parse uses stat/read/stat; the separate coherence census reads raw text once.
    assert.equal(planStats.length / 2, 1);
    assert.deepEqual(planStats, Array(2).fill(join(fx.checkout, "plan", "tasks.yaml")));
    assert.deepEqual(planReads, Array(2).fill(join(fx.checkout, "plan", "tasks.yaml")));
    assert.ok(fx.github.calls.includes("findMergedByTrailer(FIXTURE-T1)"));
  } finally {
    statSpy.mock.restore();
    readSpy.mock.restore();
    syncBuiltinESMExports();
  }
});

test("a shared retro plan failure retains each consumer's named degradation", async (t) => {
  const fx = fixture(t);
  const read = fs.readFileSync.bind(fs);
  const forcedError = new Error("fixture plan unreadable");
  const readSpy = t.mock.method(fs, "readFileSync", (target: unknown, ...args: unknown[]) => {
    if (target === join(fx.checkout, "plan", "tasks.yaml")) throw forcedError;
    return read(target as string, ...(args as []));
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await fx.run(), 0);
    const errors = fx.errors.mock.calls.map((call) => String(call.arguments[0]));
    for (const label of ["followups.open_titles.tasks", "followups.open_titles.classes", "plan_health_sweep.projection", "plan_health_sweep —"]) {
      assert.ok(errors.some((error) => error.includes(label) && error.includes(forcedError.message)), label);
    }
    assert.ok(fx.report().includes(`- [task] ${sentinel}`), "an unavailable dedup source keeps the follow-up candidate");
  } finally {
    readSpy.mock.restore();
    syncBuiltinESMExports();
  }
});

test("a retro without a plan omits plan health and preserves follow-up candidates", async (t) => {
  const fx = fixture(t);
  unlinkSync(join(fx.checkout, "plan", "tasks.yaml"));
  assert.equal(await fx.run(), 0);
  assert.ok(fx.report().includes(`- [task] ${sentinel}`));
  assert.ok(!fx.report().includes("## Plan-health sweep"));
  assert.equal(fx.errors.mock.calls.length, 0);
});

test("W1-T7615: a fixture retro gathers from its own plan root", async (t) => {
  const fx = fixture(t);
  const read = fs.readFileSync.bind(fs);
  const list = fs.readdirSync.bind(fs);
  const reads: string[] = [];
  const listings: string[] = [];
  const readSpy = t.mock.method(fs, "readFileSync", (target: unknown, ...args: unknown[]) => {
    reads.push(String(target));
    return read(target as string, ...(args as []));
  });
  const listSpy = t.mock.method(fs, "readdirSync", (target: unknown, ...args: unknown[]) => {
    listings.push(String(target));
    return list(target as string, ...(args as []));
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await fx.run(), 0);
    assert.ok(fx.report().includes(`1 entry matched an existing open title and was not re-minted: "${sentinel}"`));
    assert.ok(reads.includes(join(fx.checkout, "plan", "tasks.d", "sentinel.yaml")));
    assert.ok(listings.includes(join(fx.checkout, "plan", "tasks.d")));
    assert.deepEqual(reads.filter((path) => path.startsWith(join(installRoot, "plan"))), []);
    assert.deepEqual(listings.filter((path) => path === join(installRoot, "plan", "tasks.d")), []);
    assert.ok(reads.includes(join(fx.checkout, ".remudero", "mounts.yaml")));
  } finally {
    readSpy.mock.restore();
    listSpy.mock.restore();
    syncBuiltinESMExports();
  }
});
