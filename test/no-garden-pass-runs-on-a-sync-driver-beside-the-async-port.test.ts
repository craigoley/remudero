import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { runGardenAsync, type GardenCheckout, type GardenCheckoutAsync, type GardenerDeps, type GardenSpec } from "../src/lib/gardener.js";
import { knowledgeGardenSpec, runGardenPass, type GardenWorkspace } from "../src/lib/knowledge-gardener.js";
import { parseTasksFromYaml } from "../src/lib/plan.js";
import { gitBlobSha, repairDuplicateKeyShard } from "../src/lib/plan-shard-repair.js";
import { taskRulingPin } from "../src/lib/task-linter.js";
import { startTestGarden, type TestGardenAction, type TestGardenClass, type TestGardenInventory } from "../src/lib/test-gardener.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo } from "./helpers/git-repo.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { knowledgeGardenWorkspaceAsync, runShardRepairPass, shardRepairDir, shardRepairRequester, withShardRepairs } from "../src/run-task.js";

const proof = "test/no-garden-pass-runs-on-a-sync-driver-beside-the-async-port.test.ts";
const url = "https://github.com/o/r/pull/9";
const clock = fixedClock(Date.parse("2026-10-05T12:00:00.000Z"));
type Row = [string, Record<string, unknown> | undefined];
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function rootFor(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}async-garden-pass-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  return root;
}

test(`${proof}: the knowledge pass awaits its async port and preserves the async driver's rows`, async (t) => {
  const run = async (entry: boolean) => {
    const root = rootFor(t);
    mkdirSync(join(root, "learnings"));
    const rows: Row[] = [];
    const events: string[] = [];
    const deps: GardenerDeps<GardenWorkspace> = {
      stateDir: join(root, "state"), repoRoot: root, seed: 3, clock,
      log: (step, extra) => rows.push([step, extra]),
      openWorkspace: async () => {
        await turn();
        events.push("open");
        return {
          root, refreshAssertions: () => ["learnings/core.yaml"],
          land: async () => { await turn(); events.push("land"); return url; },
          dispose: async () => { await turn(); events.push("dispose"); },
        };
      },
    };
    const result = entry ? await runGardenPass(deps) : await runGardenAsync(knowledgeGardenSpec(deps), deps);
    assert.equal(result.prUrl, url);
    assert.deepEqual(events, ["open", "land", "dispose"]);
    return { result, rows, state: JSON.parse(readFileSync(join(root, "state", "knowledge-gardener.json"), "utf8")) };
  };
  assert.deepEqual(await run(true), await run(false));
});

test(`${proof}: the test garden holds its pass until async landing and disposal finish`, async (t) => {
  const root = rootFor(t);
  const rows: Row[] = [];
  let opens = 0;
  let refreshes = 0;
  let releaseLand!: () => void;
  let releaseDispose!: () => void;
  const landing = new Promise<void>((resolve) => { releaseLand = resolve; });
  const disposal = new Promise<void>((resolve) => { releaseDispose = resolve; });
  const events: string[] = [];
  const spec: GardenSpec<TestGardenClass, TestGardenInventory, TestGardenAction, GardenCheckout> = {
    name: "test", classes: ["adopt-durations"], review: { "adopt-durations": "measured duration" },
    cheapFingerprint: () => "same", inventory: () => ({ candidates: [] }), fingerprint: () => "same",
    candidates: () => [{ class: "adopt-durations", target: "test/a.test.ts", reason: "measured", file: "manifest.json", edit: { kind: "row", key: "test/a.test.ts", to: 100 } }],
    scorecard: () => ({}), apply: () => ({ paths: ["manifest.json"], title: "chore(test): adopt durations", body: "measured" }),
  };
  const deps: GardenerDeps = {
    repoRoot: root, stateDir: join(root, "state"), seed: 3, clock, log: (step, extra) => rows.push([step, extra]),
    openWorkspace: async () => {
      opens++;
      return { root, land: async () => { events.push("land"); await landing; return url; }, dispose: async () => { events.push("dispose"); await disposal; } };
    },
  };
  const garden = startTestGarden(spec, deps, async () => { refreshes++; return { status: "absent", reason: "none" }; }, 5);
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 100 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(ready(), "the awaited pass made progress");
  };
  try {
    await until(() => events.includes("land"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(opens, 1);
    assert.equal(refreshes, 1);
    assert.equal(rows.filter(([step]) => step === "test.pass").length, 0);
    releaseLand();
    await until(() => events.includes("dispose"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(opens, 1);
    assert.equal(refreshes, 1);
    assert.equal(rows.filter(([step]) => step === "test.pass").length, 0);
    releaseDispose();
    await until(() => rows.some(([step]) => step === "test.pass"));
    assert.deepEqual(rows.find(([step]) => step === "test.pass")?.[1], {
      ran: true, feed: { status: "absent", reason: "none" }, pr_url: url, proposal_present: false,
    });
    assert.equal(rows.some(([step]) => step === "test.filing_failed"), false);
  } finally {
    garden.stop();
    releaseLand();
    releaseDispose();
    await turn();
  }
});

function shardFixture(t: TestContext) {
  const root = rootFor(t);
  const rel = "plan/tasks.d/W1-T5788.yaml";
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const base = "- id: W1-T5788\n  title: repair a duplicate priority\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  priority: 2.5\n  risk: low\n  files: [src/lib/gardener.ts]\n";
  const pin = taskRulingPin(parseTasksFromYaml(base, "fixture")[0]!);
  const text = `${base}  priority: 4\n  risk_ruling:\n    verdict: low\n    action: proceed\n    confidence: 1\n    reasons: [reviewed]\n    judged_at: 2026-10-05T12:00:00.000Z\n    pin: ${pin}\n`;
  const repaired = repairDuplicateKeyShard(text);
  assert.ok("repaired" in repaired, JSON.stringify(repaired));
  const rows: Row[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => rows.push([step, extra]);
  const opts = { stateDir: join(root, "state"), repoDir: root, worktreesRoot: root, owner: "o", repo: "r", clock, log, readOriginBlob: () => text };
  shardRepairRequester(opts.stateDir, log)({ id: "W1-T5788", files: [`origin/main:${rel}`], reason: "shard_invalid" });
  return { root, rel, text, repaired, rows, opts };
}

test(`${proof}: shard repair awaits the async checkout, landing and disposal with the same rows`, async (t) => {
  const f = shardFixture(t);
  const events: string[] = [];
  const opts = {
    ...f.opts,
    openCheckout: async (input: { name: string; repoDir: string }): Promise<GardenCheckoutAsync> => {
      assert.equal(input.name, "plan");
      assert.equal(input.repoDir, f.root);
      await turn(); events.push("open");
      return {
        root: f.root,
        land: async (pr) => {
          assert.deepEqual(pr.paths, [f.rel]);
          assert.equal(readFileSync(join(f.root, f.rel), "utf8"), f.repaired.text);
          assert.match(pr.body, /## Acceptance/);
          await turn(); events.push("land"); return url;
        },
        dispose: async () => { await turn(); events.push("dispose"); },
      };
    },
  };
  await runShardRepairPass(opts);
  assert.deepEqual(events, ["open", "land", "dispose"]);
  assert.deepEqual(f.rows, [["plan.shard_repair_requested", { id: "W1-T5788", file: `origin/main:${f.rel}` }],
    ["plan.shard_repair_opened", { id: "W1-T5788", file: `origin/main:${f.rel}`, blob: gitBlobSha(f.text), pr_url: url, kept: { priority: "2.5" } }]]);
  const opened = JSON.parse(readFileSync(join(shardRepairDir(f.opts.stateDir), "opened.json"), "utf8"));
  assert.deepEqual(opened, { [gitBlobSha(f.text)]: url });
  assert.deepEqual(readdirSync(join(shardRepairDir(f.opts.stateDir), "requests")), []);
});

for (const stage of ["open", "land", "dispose", "not-landed"] as const) {
  test(`${proof}: shard repair retries an async ${stage} failure and awaits cleanup`, async (t) => {
    const f = shardFixture(t);
    let disposed = false;
    const opts = {
      ...f.opts,
      openCheckout: async (): Promise<GardenCheckoutAsync> => {
        if (stage === "open") throw new Error(stage);
        return {
          root: f.root,
          land: async () => { await turn(); if (stage === "land") throw new Error(stage); return stage === "not-landed" ? undefined : url; },
          dispose: async () => { await turn(); disposed = true; if (stage === "dispose") throw new Error(stage); },
        };
      },
    };
    await runShardRepairPass(opts);
    assert.equal(disposed, stage !== "open");
    assert.equal(existsSync(join(shardRepairDir(f.opts.stateDir), "opened.json")), false);
    assert.ok(f.rows.some(([step]) => step === (stage === "not-landed" ? "plan.shard_repair_not_landed" : "plan.shard_repair_failed")));
    assert.ok(f.rows.some(([step, extra]) => step === "plan.shard_repair_retry_scheduled" && extra?.attempt === 1));
  });
}

test(`${proof}: shard repair awaits async blob and PR-state reads before reopening`, async (t) => {
  const f = shardFixture(t);
  const openedPath = join(shardRepairDir(f.opts.stateDir), "opened.json");
  writeFileSync(openedPath, JSON.stringify({ [gitBlobSha(f.text)]: url }));
  const events: string[] = [];
  const fresh = "https://github.com/o/r/pull/10";
  await runShardRepairPass({
    ...f.opts,
    readOriginBlob: async () => { await turn(); events.push("read"); return f.text; },
    prState: async (prior) => { assert.equal(prior, url); await turn(); events.push("state"); return "closed" as const; },
    land: async (_rel, text) => { assert.equal(text, f.repaired.text); await turn(); events.push("land"); return fresh; },
  });
  assert.deepEqual(events, ["read", "state", "land"]);
  assert.deepEqual(JSON.parse(readFileSync(openedPath, "utf8")), { [gitBlobSha(f.text)]: { pr_url: fresh, reopened_from: url } });
  assert.equal(f.rows.at(-1)?.[1]?.reopened_from, url);
});

test(`${proof}: a rejected async blob read retains the request and records its read failure`, async (t) => {
  const f = shardFixture(t);
  await runShardRepairPass({
    ...f.opts,
    readOriginBlob: async () => { await turn(); throw new Error("blob unreadable"); },
    land: () => { assert.fail("an unreadable shard cannot be landed"); },
  });
  assert.deepEqual(f.rows.find(([step]) => step === "plan.shard_repair_failed")?.[1], {
    id: "W1-T5788", file: `origin/main:${f.rel}`, stage: "read", reason: "blob unreadable",
  });
  assert.ok(f.rows.some(([step, extra]) => step === "plan.shard_repair_retry_scheduled" && extra?.attempt === 1 && extra.blob === undefined));
});

test(`${proof}: the plan garden awaits repairs and continues after an async rejection`, async (t) => {
  const root = rootFor(t);
  const events: string[] = [];
  const rows: Row[] = [];
  const pass = withShardRepairs(root, async () => { await turn(); events.push("repair"); throw new Error("repair failed"); },
    async () => { await turn(); events.push("garden"); }, (step, extra) => rows.push([step, extra]));
  await pass();
  assert.deepEqual(events, ["repair", "garden"]);
  assert.deepEqual(rows, [["plan.shard_repair_failed", { stage: "pass", reason: "repair failed" }]]);
});

function learningsYaml(entries: Array<{ id: string; fact: string; lifecycle?: string }>): string {
  return entries
    .map((e) => [`- id: ${e.id}`, "  subsystem: t", `  lifecycle: ${e.lifecycle ?? "active"}`, "  files: [src/x.ts]", "  fact: >-", `    ${e.fact}`, "  src: t", ""].join("\n"))
    .join("\n");
}

test("W1-T4095: the real workspace commits, pushes and opens the PR", async () => {
  const origin = gitRepo({ bare: true, kind: "w1t4095-origin" });
  const seed = gitRepo({ kind: "w1t4095-seed" });
  mkdirSync(join(seed.dir, "learnings"));
  writeFileSync(join(seed.dir, "learnings", "core.yaml"), learningsYaml([{ id: "a", fact: "A fact." }]));
  mkdirSync(join(seed.dir, "scripts"));
  writeFileSync(join(seed.dir, "scripts", "learnings-assert-check.mjs"), "// no assertions to run in this fixture\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "HEAD:main");
  const checkout = gitRepo({ cloneFrom: origin.dir, kind: "w1t4095-checkout" });
  checkout.git("config", "user.email", "g@example.invalid");
  checkout.git("config", "user.name", "g");
  const worktrees = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4095-wt-`));
  const calls: string[][] = [];
  const ws = await knowledgeGardenWorkspaceAsync({
    repoDir: checkout.dir,
    worktreesRoot: worktrees,
    owner: "acme",
    repo: "remudero",
    log: () => {},
    clock: fixedClock(1790000000000),
    fetcher: (args) => {
      calls.push(args);
      return { html_url: "https://github.com/acme/remudero/pull/42", number: 42 };
    },
  });
  try {
    assert.ok(existsSync(join(ws.root, "learnings", "core.yaml")), "the workspace is a checkout of main");
    assert.deepEqual(await ws.refreshAssertions(), [], "nothing drifted");
    writeFileSync(join(ws.root, "learnings", "core.yaml"), learningsYaml([{ id: "a", fact: "A fact.", lifecycle: "superseded" }]));
    const url = await withLiveWritesAllowed(() => ws.land({ paths: ["learnings/core.yaml"], title: "chore(knowledge): test pass", body: "body" }));
    assert.equal(url, "https://github.com/acme/remudero/pull/42");
    assert.match(origin.git("log", "--oneline", "knowledge-garden-1790000000000"), /chore\(knowledge\): test pass/);
    assert.ok(calls[0]!.join(" ").includes("pulls"), "the PR is opened over REST");
  } finally {
    await ws.dispose();
    origin.cleanup();
    seed.cleanup();
    checkout.cleanup();
  }
});

