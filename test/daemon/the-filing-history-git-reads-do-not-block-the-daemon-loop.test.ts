/**
 * W1-T12952 — the filing-history git reads of the lifetime-pressure route do not block the daemon loop.
 *
 * The route dates each candidate task from its first commit in the plan history. The reader called the synchronous
 * worktree git leaf, so the loop stopped for every git call: 1,368 calls in 24 h on 2026-11-15, all under
 * routeAdaptiveLifetimePressure. The reader now awaits the async leaf. These tests check that the async reader gives
 * the same answers under the same limits and environment. Criterion 1 (the route keeps the loop free while a slow git
 * runs) lives in test/a-filing-age-that-cannot-be-read-is-unknown-never-zero-days.test.ts, which already imports the
 * route's module.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createTaskFilingHistoryInvocation, FILING_HISTORY_LIMITS, resolveTaskFilingHistory,
  type FilingHistoryOptions, type TaskFilingHistory } from "#src/lib/task-filing-history.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { hostWorktreeGit } from "#src/lib/worktree-git.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const DAY_MS = 86_400_000;
const NOW_MS = Date.parse("2026-10-16T12:00:00Z");
const ID = "W1-T9701";
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const record = (id: string, title = "a task whose build kept failing"): string =>
  `- id: ${id}\n  title: "${title}"\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`;

/** Commit everything in `dir` at `when`, with the fixture's own identity. */
function commitAt(dir: string, when: string, message: string): void {
  const { name, email } = GIT_REPO_FIXTURE_IDENTITY;
  const env = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  for (const args of [["add", "-A"], ["commit", "--quiet", "--allow-empty", "-m", message]])
    execFileSync(REAL_GIT, ["-C", dir, ...args], { env, stdio: "pipe" });
}

/** A plan repository: one embedded record and one sharded record, filed 30 days before NOW_MS. */
function planRepo(): GitRepo {
  const repo = gitRepo({ kind: "filing-history-loop", seedCommit: false });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), record(ID));
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T9702-sharded.yaml"), record("W1-T9702", "café: a non-ASCII title"));
  commitAt(repo.dir, new Date(NOW_MS - 30 * DAY_MS).toISOString(), "file the records");
  return repo;
}

/** A `git` on PATH that logs its arguments and history environment, then runs the real git. */
function shimGit(): { dir: string; log: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}git-shim-`));
  const log = join(dir, "calls.log");
  const vars = ["GIT_NO_REPLACE_OBJECTS", "GIT_NO_LAZY_FETCH", "GIT_OPTIONAL_LOCKS", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE"];
  writeFileSync(join(dir, "git"), "#!/bin/sh\n" +
    `printf '%s|%s\\n' "$*" "${vars.map((v) => `${v}=\${${v}-unset}`).join(" ")}" >> '${log}'\n` +
    `exec '${REAL_GIT}' "$@"\n`);
  chmodSync(join(dir, "git"), 0o755);
  writeFileSync(log, "");
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  return { dir, log, restore: () => { process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); } };
}

/** The seven reads of one history batch, as git on PATH sees their arguments. */
const HISTORY_READS = [" config --null --name-only --list", " rev-parse --verify", " rev-parse --is-shallow-repository",
  " --pretty=raw ", " diff-tree --stdin", " cat-file --batch-check", " cat-file --batch|"];

/** One case: a repository, a candidate list and limits. The answer and the work spent are what must match. */
type Case = { name: string; root: () => string; ids: string[]; ask?: string; limits?: FilingHistoryOptions["limits"]; expect: Partial<TaskFilingHistory> & { reason?: string } };

test("W1-T12952 criterion 2: the async reader returns the same dates and reasons as the synchronous leaf", async (t) => {
  const base = planRepo();
  t.after(() => base.cleanup());
  const variant = (name: string, change: (dir: string) => void): (() => string) => () => {
    const repo = planRepo();
    t.after(() => repo.cleanup());
    change(repo.dir);
    return repo.dir;
  };
  const noGit = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}filing-no-git-`));
  t.after(() => rmSync(noGit, { recursive: true, force: true }));
  const filed = (NOW_MS - 30 * DAY_MS) / 1000;
  const exhausted = (resource: string) => `filing-history ${resource} budget exhausted`;
  const cases: Case[] = [
    { name: "embedded record", root: () => base.dir, ids: [ID, "W1-T9702"], expect: { state: "qualified", source: "embedded", committerSeconds: filed } },
    { name: "sharded record with a non-ASCII title", root: () => base.dir, ids: [ID, "W1-T9702"], ask: "W1-T9702", expect: { state: "qualified", source: "shard", committerSeconds: filed } },
    { name: "record absent at the pinned revision", root: () => base.dir, ids: ["W1-T9799"], expect: { state: "unknown", reason: "exact task record absent at the pinned revision" } },
    { name: "task outside the invocation", root: () => base.dir, ids: [ID], ask: "W1-T9702", expect: { state: "unknown", reason: "task absent from this history invocation" } },
    { name: "duplicate identity", root: variant("duplicate", (dir) => {
      writeFileSync(join(dir, "plan", "tasks.d", `${ID}-copy.yaml`), record(ID));
      commitAt(dir, new Date(NOW_MS - 20 * DAY_MS).toISOString(), "copy");
    }), ids: [ID], expect: { state: "unknown", reason: "duplicate task identity in filing history" } },
    { name: "deletion then reintroduction", root: variant("reintroduced", (dir) => {
      writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
      commitAt(dir, new Date(NOW_MS - 20 * DAY_MS).toISOString(), "delete");
      writeFileSync(join(dir, "plan", "tasks.yaml"), record(ID));
      commitAt(dir, new Date(NOW_MS - 10 * DAY_MS).toISOString(), "reintroduce");
    }), ids: [ID], expect: { state: "unknown", reason: "ambiguous task deletion/reintroduction in filing history" } },
    { name: "a root git cannot read", root: () => noGit, ids: [ID], expect: { state: "unknown", reason: "git log failed: repository or complete history objects could not be read" } },
    ...(["commitVisits", "blobReads", "stateEntries"] as const).map((resource): Case => ({
      name: `${resource} budget`, root: () => base.dir, ids: [ID, "W1-T9702"], limits: { [resource]: resource === "blobReads" ? 1 : 0 },
      expect: { state: "unknown", reason: exhausted(resource) } })),
    ...(["decodedBytes", "metadataBytes"] as const).map((resource): Case => ({
      name: `${resource} budget at zero`, root: () => base.dir, ids: [ID], limits: { [resource]: 0 },
      expect: { state: "unknown", reason: "filing-history decodedBytes/metadataBytes budget exhausted" } })),
    // A git answer longer than the remaining allowance overflows the child's buffer: the synchronous leaf reports
    // ENOBUFS, the async leaf ERR_CHILD_PROCESS_STDIO_MAXBUFFER. Both are the same exhausted budget.
    { name: "metadata answer larger than the allowance", root: () => base.dir, ids: [ID], limits: { metadataBytes: 4 },
      expect: { state: "unknown", reason: "filing-history decodedBytes/metadataBytes budget exhausted" } },
  ];
  const syncLeaf: FilingHistoryOptions["readGit"] = async (root, args, opts) => hostWorktreeGit(root, args, opts);
  for (const c of cases) {
    await t.test(c.name, async () => {
      const root = c.root();
      const ask = c.ask ?? c.ids[0]!;
      const viaAsync = createTaskFilingHistoryInvocation(root, c.ids, { limits: c.limits });
      const viaSync = createTaskFilingHistoryInvocation(root, c.ids, { limits: c.limits, readGit: syncLeaf });
      const answer = await resolveTaskFilingHistory(ask, viaAsync);
      assert.deepEqual(answer, await resolveTaskFilingHistory(ask, viaSync), "the same answer through either leaf");
      assert.deepEqual(viaAsync.usage, viaSync.usage, "the same work debited through either leaf");
      for (const [key, value] of Object.entries(c.expect)) assert.equal((answer as Record<string, unknown>)[key], value, `${c.name}: ${key}`);
      // Every candidate reads the one batch: the same answers, and asking again does no more work.
      for (const id of c.ids) assert.deepEqual(await resolveTaskFilingHistory(id, viaAsync), await resolveTaskFilingHistory(id, viaSync), id);
      const usage = { ...viaAsync.usage };
      for (const id of c.ids) await resolveTaskFilingHistory(id, viaAsync);
      assert.deepEqual(viaAsync.usage, usage);
      assert.deepEqual(viaAsync.usage, viaSync.usage);
    });
  }
  await t.test("candidates that ask at the same time share one batch", async () => {
    const calls: string[][] = [];
    const ctx = createTaskFilingHistoryInvocation(base.dir, [ID, "W1-T9702"], {
      readGit: async (root, args, opts) => { calls.push([...args]); return syncLeaf(root, args, opts); },
    });
    const [a, b] = await Promise.all([resolveTaskFilingHistory(ID, ctx), resolveTaskFilingHistory("W1-T9702", ctx)]);
    assert.equal(a.state, "qualified"); assert.equal(b.state, "qualified");
    assert.equal(calls.filter((args) => args[0] === "log").length, 1, "one history read for the whole invocation");
  });
});

test("W1-T12952 criterion 3: the async reader keeps the history limits, latin1 decoding and hardened git environment", async (t) => {
  assert.deepEqual({ ...FILING_HISTORY_LIMITS }, { commitVisits: 16_384, blobReads: 16_384, decodedBytes: 256 * 1024 ** 2,
    metadataBytes: 32 * 1024 ** 2, stateEntries: 1_048_576 }, "the production limits are unchanged");
  const repo = planRepo();
  t.after(() => repo.cleanup());
  // A caller's environment that would redirect the history: each must be unset for the history reads.
  const planted = { GIT_GRAFT_FILE: join(repo.dir, "grafts"), GIT_SHALLOW_FILE: join(repo.dir, "shallow"), GIT_REPLACE_REF_BASE: "refs/elsewhere/" };
  const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
  Object.assign(process.env, planted);
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const shim = shimGit();
  t.after(shim.restore);

  const ctx = createTaskFilingHistoryInvocation(repo.dir, [ID, "W1-T9702"]);
  const sharded = await resolveTaskFilingHistory("W1-T9702", ctx);
  assert.equal(sharded.state, "qualified", "a non-ASCII record reads byte for byte: the blob offsets hold only under latin1");

  const calls = readFileSync(shim.log, "utf8").split("\n").filter(Boolean);
  const history = calls.filter((c) => HISTORY_READS.some((read) => `${c.split("|")[0]!}|`.includes(read)));
  assert.equal(history.length, HISTORY_READS.length, `every history read went through git on PATH: ${history.join("\n")}`);
  for (const call of history) {
    const env = call.split("|")[1]!;
    assert.equal(env, "GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_OPTIONAL_LOCKS=0 GIT_GRAFT_FILE=unset GIT_SHALLOW_FILE=unset GIT_REPLACE_REF_BASE=unset",
      `the hardened history environment: ${call}`);
  }
  assert.ok(history.some((c) => c.includes(`--max-count=${FILING_HISTORY_LIMITS.commitVisits + 1}`)), "the commit walk stops at the commit allowance");
});
