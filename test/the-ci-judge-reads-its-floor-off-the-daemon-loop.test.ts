import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { affectedSelectionOrFull, readAffectedSuitesInput } from "#src/lib/affected-suites.js";
import { CI_JUDGE_HEADS_FILE, judgeCiEscalation, productionCiJudgePorts, type CiJudgePorts } from "#src/lib/ci-escalation-judge.js";
import { WorktreePointerRefusedError } from "#src/lib/worktree-git.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const SUITE = "test/example.test.ts";
const FLOOR = { suites: [SUITE], fullRun: false };
const REPLY = JSON.stringify({ add: [], escalateFull: false, reason: "floor is sufficient" });

function fixture(t: { after: (fn: () => void) => void }) {
  const repo = gitRepo({ kind: "ci-judge-async" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "src"));
  mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, "src/example.ts"), "export const value = 1;\n");
  writeFileSync(join(repo.dir, SUITE), 'import { value } from "../src/example.js";\nexport { value };\n');
  repo.git("add", "src", "test");
  repo.git("commit", "-q", "-m", "feat: fixture");
  return repo;
}

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function pass(stateDir: string, overrides: Partial<CiJudgePorts> = {}) {
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let judges = 0;
  let posts = 0;
  const ports: CiJudgePorts = {
    stateDir, openPrs: async () => [{ number: 7, headSha: "head-7" }],
    changedFiles: async () => ["src/example.ts"], diff: async () => "diff",
    floor: () => FLOOR, suiteIds: () => [SUITE],
    judge: async () => { judges++; return REPLY; }, post: async () => { posts++; },
    log: (step, extra) => { events.push({ step, extra }); }, ...overrides,
  };
  return { ports, events, counts: () => ({ judges, posts }) };
}

async function withoutSyncChildren<T>(run: () => Promise<T>): Promise<T> {
  const names = ["execFileSync", "execSync", "spawnSync"] as const;
  const originals = names.map((name) => childProcess[name]);
  try {
    for (const name of names) Object.assign(childProcess, { [name]: () => { throw new Error(`synchronous child forbidden: ${name}`); } });
    syncBuiltinESMExports();
    return await run();
  } finally {
    names.forEach((name, index) => Object.assign(childProcess, { [name]: originals[index] }));
    syncBuiltinESMExports();
  }
}

test("CI judge: the default floor and suite list use real async children while sync spawns are trapped", async (t) => {
  const repo = fixture(t);
  const expected = affectedSelectionOrFull(["src/example.ts"], () => readAffectedSuitesInput(repo.dir, ["src/example.ts"]));
  assert.equal(expected.fullRun, false, "the real fixture is a measured narrow selection");
  assert.ok(expected.suites.includes(SUITE));
  const forbidden = async (): Promise<never> => { throw new Error("network or provider use forbidden"); };
  const ports = productionCiJudgePorts({ owner: "fixture", repo: "fixture", repoRoot: repo.dir, stateDir: repo.dir,
    log: () => {}, ghJson: forbidden, ghText: forbidden, spawn: forbidden });
  await withoutSyncChildren(async () => {
    let beats = 0;
    const timer = setInterval(() => { beats++; }, 1);
    try {
      assert.deepEqual(await ports.floor(["src/example.ts"]), expected);
      assert.ok(beats > 0, "heartbeat callbacks run while the real listing child is pending");
      assert.deepEqual(await ports.suiteIds(), [SUITE]);
    } finally { clearInterval(timer); }
  });
});

test("CI judge: a pending floor leaves the event loop free and is awaited before judging", async (t) => {
  const repo = fixture(t);
  const floor = pending<typeof FLOOR>();
  const run = pass(repo.dir, { floor: () => floor.promise });
  let finished = false;
  const job = judgeCiEscalation(run.ports).finally(() => { finished = true; });
  try {
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(finished, false);
    assert.deepEqual(run.counts(), { judges: 0, posts: 0 });
  } finally { floor.resolve(FLOOR); }
  assert.deepEqual(await job, { off: false, judged: [7], failed: [] });
  assert.deepEqual(run.counts(), { judges: 1, posts: 1 });
});

test("CI judge: a pending suite census is awaited before parsing the reply", async (t) => {
  const repo = fixture(t);
  const suites = pending<string[]>();
  const run = pass(repo.dir, { suiteIds: () => suites.promise });
  let finished = false;
  const job = judgeCiEscalation(run.ports).finally(() => { finished = true; });
  try {
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(finished, false);
    assert.deepEqual(run.counts(), { judges: 1, posts: 0 });
  } finally { suites.resolve([SUITE]); }
  assert.deepEqual(await job, { off: false, judged: [7], failed: [] });
  assert.deepEqual(run.counts(), { judges: 1, posts: 1 });
});

test("CI judge: rejected floor and suite reads fail one head without posting or repeating spend", async (t) => {
  for (const field of ["floor", "suiteIds"] as const) {
    const repo = fixture(t);
    const rejected = Promise.reject(new Error(`${field} read failed`));
    void rejected.catch(() => {});
    const run = pass(repo.dir, { [field]: () => rejected });
    assert.deepEqual(await judgeCiEscalation(run.ports), { off: false, judged: [], failed: [7] });
    assert.equal(run.counts().posts, 0);
    assert.equal(run.counts().judges, field === "floor" ? 0 : 1);
    assert.ok(run.events.some((r) => r.step === "ci_judge.failed" && r.extra?.error === `${field} read failed`));
    assert.equal(JSON.parse(readFileSync(join(repo.dir, CI_JUDGE_HEADS_FILE), "utf8"))["7"], "head-7");
    const counts = run.counts();
    assert.deepEqual(await judgeCiEscalation(run.ports), { off: false, judged: [], failed: [] });
    assert.deepEqual(run.counts(), counts);
  }
});

test("CI judge: a substituted git pointer still refuses the suite list and names a full floor", async (t) => {
  const foreign = fixture(t);
  const root = join(foreign.dir, "substituted");
  mkdirSync(root);
  writeFileSync(join(root, ".git"), `gitdir: ${join(foreign.dir, ".git")}\n`);
  const ports = productionCiJudgePorts({ owner: "fixture", repo: "fixture", repoRoot: root, stateDir: root, log: () => {} });
  await assert.rejects(async () => ports.suiteIds(), WorktreePointerRefusedError);
  const floor = await ports.floor(["src/example.ts"]);
  assert.equal(floor.fullRun, true);
  assert.deepEqual(floor.suites, []);
  assert.ok("reasons" in floor);
  assert.ok(Array.isArray(floor.reasons));
  assert.match(floor.reasons.join(" "), /selector could not read its input/);
});
