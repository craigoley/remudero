import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import * as cli from "../src/run-task.js";
import { buildBatchedGithub, buildCommitTrailerIndex, type GitHub } from "../src/lib/status.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

type Projection = ReturnType<typeof cli.creditProjectionWithReadState> & { windowShort?: readonly string[] };
type Candidate = cli.ReconcileCreditCandidate;
const TASK = "W1-T5100";
const JUDGED = "W1-T5101";
const url = (n: number) => `https://github.com/craigoley/remudero/pull/${n}`;
const shard = (taskId: string, extra = "") => ({
  taskId, path: `/p/${taskId}.yaml`, text: `- id: ${taskId}\n  title: t\n  status: queued\n  attempts: 0\n${extra}`,
});
const candidate = (taskId: string, extra: Partial<Candidate> = {}): Candidate => ({
  taskId, prNumber: 5100, prUrl: url(5100), merged: true, ...extra,
});

function withRoot<T>(fn: (root: string) => T): T {
  const repo = gitRepo({ kind: "w1-t5100", seedCommit: false });
  try {
    mkdirSync(join(repo.dir, "state"));
    mkdirSync(join(repo.dir, "plan"));
    writeFileSync(join(repo.dir, "state", "ledger.ndjson"), "");
    writeFileSync(join(repo.dir, "plan", "tasks.yaml"),
      `- id: ${TASK}\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  budget_usd: 1\n  status: queued\n  acceptance:\n    - claim: c\n      proof: "unit test: x"\n`);
    return fn(repo.dir);
  } finally {
    repo.cleanup();
  }
}

function project(rows: Candidate[], gateway: Partial<GitHub> = {}): Projection {
  return withRoot((root) => cli.creditProjectionWithReadState(
    { root } as never, root, () => rows, gateway as GitHub,
  ));
}

async function run(args: string[], projection: Projection, extra: cli.PlanReconcileDeps = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Array<{ path: string; text: string }> = [];
  const logged: Array<{ step: string; extra: unknown }> = [];
  const savedLog = console.log;
  const savedError = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await cli.planReconcileCommand(args, {
      readShards: () => [shard(TASK), shard(JUDGED)], readInlineRecords: () => undefined,
      creditedProjection: () => projection,
      writeShard: (path, text) => written.push({ path, text }),
      log: (step, extra) => logged.push({ step, extra }), ...extra,
    });
    return { code, out: out.join("\n"), err: err.join("\n"), written, logged };
  } finally {
    console.log = savedLog;
    console.error = savedError;
  }
}

test("W1-T5100: a queued shard merged outside both scan windows prints WINDOW-SHORT and exits 2", async () => {
  const projection = project([candidate(TASK), candidate(JUDGED, { creditIsImplementation: true })]);
  assert.deepEqual(projection.windowShort, [TASK]);
  const result = await run([], projection);
  const control = await run([], { ids: projection.ids });
  assert.equal(result.code, 2);
  assert.equal(result.out, control.out);
  assert.match(result.err, /WINDOW-SHORT.*1 queued shard\(s\)/);
  assert.ok(result.err.includes(`subjects: last ${cli.MERGE_SUBJECT_SCAN_LIMIT} commits, paths: last ${cli.MERGED_PATHS_SCAN_LIMIT}`));
  assert.ok(result.err.includes(`NOT flipped: ${TASK}`));
  assert.match(result.err, /or carry no \(#N\).*flip them by hand in a plan-only PR/);
  assert.deepEqual(result.written, []);
  assert.deepEqual(result.logged.at(-1), { step: "plan.reconcile.window_short", extra: { count: 1 } });
});

test("W1-T5100: --write still flips the judged shards and never the window-short one, then exits 2", async () => {
  const projection = project([candidate(TASK), candidate(JUDGED, { creditHasBuildDiff: true })]);
  const result = await run(["--write"], projection);
  assert.equal(result.code, 2);
  assert.match(result.err, /WINDOW-SHORT.*W1-T5100/);
  assert.deepEqual(result.written, [{ path: shard(JUDGED).path, text: shard(JUDGED).text.replace("status: queued", "status: merged") }]);
  assert.equal(result.out, (await run(["--write"], { ids: projection.ids })).out);
});

test("W1-T5100: a window that covers every queued shard prints byte-identical output and exits 0", async () => {
  const projection = project([candidate(TASK, { creditIsImplementation: true }), candidate(JUDGED, { creditHasBuildDiff: true })]);
  assert.equal(Object.hasOwn(projection, "windowShort"), false);
  for (const args of [[], ["--write"]]) {
    const result = await run(args, projection);
    assert.deepEqual(result, await run(args, { ids: projection.ids }));
    assert.equal(result.code, 0);
    assert.equal(result.err, "");
  }
});

test("W1-T5100: a filing-shaped merge, a retired shard and an unmerged shard are never window-short", async () => {
  const rows = [candidate(TASK, { creditIsImplementation: false }), candidate("retired"), candidate("merged"), candidate("statusless"),
    candidate("other-build", { creditHasOtherBuildMerge: true }), candidate("not-merged", { merged: false }),
    candidate("paths-known", { creditHasBuildDiff: false })];
  const projection = project(rows);
  assert.deepEqual(projection.windowShort, ["merged", "retired", "statusless"]);
  const shards = [shard(TASK), shard("retired", "  retirement: superseded\n"), shard("unmerged"),
    { ...shard("merged"), text: shard("merged").text.replace("status: queued", "status: merged") },
    { ...shard("statusless"), text: "- id: statusless\n" }, shard("other-build"), shard("paths-known")];
  assert.deepEqual(cli.windowShortShards(shards, projection.ids, projection.windowShort), []);
  const result = await run([], projection, { readShards: () => shards });
  assert.equal(result.code, 0);
  assert.equal(result.err, "");
  assert.deepEqual(result.written, []);
});

test("W1-T5100: an UNKNOWN read keeps its own line and exit code and names the window-short shards too", async () => {
  for (const gateway of [
    { readState: () => "failed" as const, readFailureReason: () => "auth" as const },
    { readState: () => "ok" as const, readTruncated: () => true },
  ]) {
    const projection = project([candidate(TASK), candidate(JUDGED, { creditIsImplementation: true })], gateway);
    assert.deepEqual(projection.windowShort, [TASK]);
    for (const args of [[], ["--write"]]) {
      const result = await run(args, projection);
      const control = await run(args, { ids: projection.ids, unknownReason: projection.unknownReason });
      assert.equal(result.code, 2);
      assert.equal(result.out, "");
      assert.equal(result.err.split("\n")[0], control.err);
      assert.match(result.err.split("\n")[1]!, /WINDOW-SHORT.*W1-T5100/);
      assert.deepEqual(result.written, []);
      assert.deepEqual(result.logged.map((l) => l.step), ["plan.reconcile.unknown", "plan.reconcile.window_short"]);
    }
  }
});

test("W1-T5100: the projection omits windowShort when no candidate is short and an injected set is unchanged", async () => {
  for (const rows of [[], [candidate(TASK, { creditIsImplementation: false })], [candidate(TASK, { creditIsImplementation: true })]]) {
    const projection = project(rows);
    assert.deepEqual(projection, { ids: new Set(rows.filter(cli.creditIsReconcilable).map((r) => r.taskId)) });
    const result = await run(["--write"], projection);
    const injected = await run(["--write"], projection, { creditedProjection: undefined, creditedMergedIds: () => projection.ids });
    assert.deepEqual(result, injected);
    assert.equal(result.code, 0);
  }
});

function realHistory(root: string, outside: boolean): Projection {
  assert.equal(typeof cli.MERGE_SUBJECT_SCAN_LIMIT, "number");
  const fillerCount = Math.max(cli.MERGE_SUBJECT_SCAN_LIMIT, cli.MERGED_PATHS_SCAN_LIMIT) + 50;
  const commit = (message: string, build: boolean) =>
    `commit refs/heads/main\ncommitter ${GIT_REPO_FIXTURE_IDENTITY.name} <${GIT_REPO_FIXTURE_IDENTITY.email}> 1700000000 +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${build ? "M 100644 inline src/example.ts\ndata 6\nbuild\n\n" : ""}\n`;
  const build = commit(`feat(x): build (#5100)\n\nRemudero-Task: ${TASK}\n`, true);
  const fillers = Array.from({ length: fillerCount }, (_, i) => commit(`chore: filler ${i}`, false)).join("");
  execFileSync("git", ["-C", root, "fast-import", "--quiet"], { input: outside ? build + fillers : fillers + build });
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/craigoley/remudero.git"]);
  writeFileSync(join(root, "state", "ledger.ndjson"), JSON.stringify({ ts: "2026-09-01T00:00:00Z", step: "pr.opened", task_id: TASK, pr_url: url(5100) }) + "\n");
  const github = buildBatchedGithub("craigoley", "remudero", {
    exec: (args) => JSON.stringify(args.some((arg) => arg.includes("state=closed")) ? [{
      number: 5100, html_url: url(5100), state: "closed", merged_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      head: { ref: `run-${TASK}-1` }, body: `Remudero-Task: ${TASK}\n`,
    }] : []),
    commitTrailerIndex: buildCommitTrailerIndex({ slug: "craigoley/remudero", cwd: root }),
  });
  assert.equal(github.prByRef(url(5100))?.state, "MERGED");
  return cli.creditProjectionWithReadState({ root } as never, root,
    (o, r, p, l, log, gateway) => cli.buildCreditCandidates(o, r, p, l, log, gateway, () => root), github);
}

test("W1-T5100: the real credit builder over a real git history longer than the subject window reports the task window-short", async () => {
  const projection = withRoot((root) => realHistory(root, true));
  assert.deepEqual(projection, { ids: new Set(), windowShort: [TASK] });
  const result = await run(["--write"], projection);
  assert.equal(result.code, 2);
  assert.match(result.err, /WINDOW-SHORT.*W1-T5100/);
  assert.deepEqual(result.written, []);
});

test("W1-T5100: the same history inside the window is judged and flipped, the positive control for the real seam", async () => {
  const projection = withRoot((root) => realHistory(root, false));
  assert.deepEqual(projection, { ids: new Set([TASK]) });
  const result = await run(["--write"], projection);
  assert.equal(result.code, 0);
  assert.equal(result.err, "");
  assert.deepEqual(result.written, [{ path: shard(TASK).path, text: shard(TASK).text.replace("status: queued", "status: merged") }]);
});

test("W1-T5100: the report sorts and caps ids while preserving the board-floor caveat", async () => {
  const ids = Array.from({ length: 23 }, (_, i) => `W1-T${6000 + i}`).reverse();
  const projection = project(ids.map((id) => candidate(id)), {
    readState: () => "ok", readTruncated: () => true,
    readBoardCoverage: () => ({ openTruncated: false, closedFloor: "2026-08-01T00:00:00Z" }),
  });
  assert.deepEqual(projection.windowShort, [...ids].sort());
  const result = await run([], projection, { readShards: () => ids.map((id) => shard(id)) });
  assert.equal(result.code, 2);
  assert.match(result.err, /CAVEAT/);
  assert.match(result.err, /WINDOW-SHORT.*23 queued shard\(s\).*W1-T6019 \(\+3 more\)/);
  assert.doesNotMatch(result.err, /W1-T6020/);
});
