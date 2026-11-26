import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createBoardSnapshotCache } from "#src/lib/board-snapshot-cache.js";
import { fixedClock } from "#src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { createNowView, snapshotGithub, type NowViewContext, type NowViewOptions } from "#src/lib/now-view.js";
import type { BoardPrRest } from "#src/lib/open-prs-rest.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { acquireLease } from "#src/lib/read-model-db.js";
import type { BoardCatalogClient, BoardCatalogContext } from "#src/lib/serve-plan-reload.js";
import { buildBatchedGithub, buildCommitTrailerIndex, projectPlan, type BatchedPr } from "#src/lib/status.js";
import { publishThreadPlan } from "#src/lib/thread-plan.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const CLOCK = fixedClock(Date.parse("2026-11-26T00:00:00Z"));
const OPS_IDS = ["W1-T600", "W1-T601", "W1-T602"] as const;
const task = (id: string): Task => ({ id, title: id, repo: "r", depends_on: [], type: "implement", risk: "medium",
  verify: "auto", status: "queued", attempts: 0 });
const planOf = (tasks: Task[]): Plan => ({ tasks, byId: new Map(tasks.map((row) => [row.id, row])) });
const url = (number: number): string => `https://github.com/o/r/pull/${number}`;
const merged = (number: number, body: string): BoardPrRest => ({
  number, url: url(number), state: "MERGED", body, title: `merged #${number}`, updatedAt: CLOCK.iso(),
  headRefName: "implementation", headRefOid: "a".repeat(40), autoMergeRequest: null,
});

function fixture(t: TestContext) {
  const { dir: root, onClose } = readModelFixtureDir(t, "now-ops-memo");
  const ledgerDir = join(root, "state");
  mkdirSync(ledgerDir);
  const ledgerPath = join(ledgerDir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const db = openProjectorReadModel(root, "core", CLOCK);
  onClose(() => db.close());
  const acquired = acquireLease(db, { clock: CLOCK, ttlMs: 1e9 });
  assert.ok(acquired.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: acquired.lease, clock: CLOCK });
  const append = (row: Record<string, unknown>) => {
    appendFileSync(ledgerPath, `${JSON.stringify({ ts: CLOCK.iso(), host: "fixture", ...row })}\n`);
    projector.tick();
  };
  const context = (resumed?: true): NowViewContext => ({
    now: CLOCK.now(), resumed, switches: { views: { now: "shadow" } },
    instances: [{ db, state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, newestTs: null } }],
  });
  const publicPlan = planOf([task("W1-T1")]);
  const ops = OPS_IDS.map(task);
  const planPath = join(root, "plan", "tasks.yaml");
  const catalogs: BoardCatalogClient = {
    revision: () => "catalog-1",
    accept: () => {},
    current(plan) {
      return { outcome: "ok", observedAt: CLOCK.iso(), taskCount: ops.length, publicPlan: plan,
        opsIds: new Set(OPS_IDS), plan: planOf([...plan.tasks, ...ops]) } satisfies BoardCatalogContext;
    },
  };
  const opts: NowViewOptions = {
    instances: [{ name: "core", ledgerDir, planPath, repo: "o/r" }], clock: CLOCK, catalogs,
    hostProbe: { readLive: () => [], diskFree: () => 10_000, rateLimit: () => 5_000 },
    planBehind: () => ({ commits: 0 }), dependencyGates: () => [],
  };
  const cache = createBoardSnapshotCache(root, "o", "r");
  assert.equal(cache.commitOpen!([], CLOCK.now()), true);
  return { opts, root, planPath, append, context, cache, publicPlan };
}

function checkout(t: TestContext): GitRepo {
  const repo = gitRepo({ scope: t, kind: "now-commit-trailers" });
  repo.addRemote("origin", "https://github.com/o/r.git");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}

function land(repo: GitRepo, number: number, id: string): void {
  repo.git("commit", "--quiet", "--allow-empty", "-m", `fix(now): finish work (#${number})`, "-m", `Remudero-Task: ${id}`);
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
}

test("W1-T14441 criterion 1: a second snapshot derives no ops task with unchanged inputs", (t) => {
  const f = fixture(t);
  assert.equal(f.cache.commitClosed([]), true);
  f.append({ step: "daemon.tick" });
  const gateway = snapshotGithub(f.root, "o", "r", CLOCK);
  let opsDerives = 0;
  const view = createNowView({
    ...f.opts, readPlan: () => f.publicPlan,
    github: () => ({ ...gateway, github: { ...gateway.github, mergedTrailerLookup: () => (id) => {
      if (OPS_IDS.some((taskId) => taskId === id)) opsDerives++;
      return null;
    } } }),
  });
  assert.equal(view.materialize(f.context()).length, 1);
  assert.equal(opsDerives, OPS_IDS.length);
  assert.equal(view.materialize(f.context(true)).length, 1);
  assert.equal(opsDerives, OPS_IDS.length, "a second materialized body performs zero further ops derives");
  f.append({ step: "pr.opened", task_id: OPS_IDS[0], pr_url: url(13) });
  assert.equal(view.materialize(f.context()).length, 1);
  assert.equal(opsDerives, OPS_IDS.length + 1, "only the ops task named by the new fact derives again");
});

test("W1-T14441 criterion 2: two projections scan merged PR prose once per snapshot", () => {
  let scans = 0;
  class CountedTitle extends String {
    override matchAll(pattern: RegExp) {
      scans++;
      return super.matchAll(pattern);
    }
  }
  const id = OPS_IDS[0]!;
  const row: BatchedPr = { ...merged(15, ""), title: new CountedTitle(id) as unknown as string };
  const gateway = buildBatchedGithub("o", "r", { fetchAll: () => [row], commitTrailerIndex: () => new Map() });
  const github = { ...gateway, changedFiles: () => ["src/now.ts"] };
  const deps = { github, ledgerPath: "", readLedger: () => [], readCreditStore: () => ({}), writeCreditStore: () => {} };
  const plan = planOf([task(id)]);
  for (let pass = 0; pass < 2; pass++) {
    assert.deepEqual(projectPlan(plan, deps).get(id)?.uncreditedBuild, { prNumber: 15, prUrl: url(15), namedIn: "title" });
  }
  assert.equal(scans, 1);
});

test("W1-T14441 criterion 3: new gateways read commit history once per origin/main sha", (t) => {
  const repo = checkout(t);
  const [first, second] = OPS_IDS;
  land(repo, 16, first);
  let historyReads = 0;
  const exec = childProcess.execFileSync;
  const countingExec = t.mock.method(childProcess, "execFileSync", ((file: string, args: string[], options: childProcess.ExecFileSyncOptionsWithStringEncoding) => {
    if (file === "git" && args[0] === "log" && options.cwd === repo.dir) historyReads++;
    return exec(file, args, options);
  }) as typeof exec);
  syncBuiltinESMExports();
  try {
    const gateway = () => buildBatchedGithub("o", "r", {
      fetchAll: () => [merged(16, ""), merged(17, "")],
      commitTrailerIndex: buildCommitTrailerIndex({ slug: "o/r", cwd: repo.dir }),
    });
    assert.equal(gateway().findMergedByTrailer(first)?.number, 16);
    assert.equal(historyReads, 1);
    assert.equal(gateway().findMergedByTrailer(first)?.number, 16);
    assert.equal(historyReads, 1);
    land(repo, 17, second);
    assert.equal(gateway().findMergedByTrailer(second)?.number, 17);
    assert.equal(historyReads, 2);
  } finally {
    countingExec.mock.restore();
    syncBuiltinESMExports();
  }
});

test("W1-T14441 criterion 4: the memoized now body equals a fresh derivation after each input change", (t) => {
  const f = fixture(t);
  const repo = checkout(t);
  const previousCwd = process.cwd();
  process.chdir(repo.dir);
  try {
    const [ledgerTask, resavedTask, trailerTask] = OPS_IDS;
    let closed = [merged(18, "no body trailer")];
    assert.equal(f.cache.commitClosed(closed), true);
    const pin = (plan: Plan, ref: string) => publishThreadPlan({ path: f.planPath, repoDir: repo.dir, ref }, { plan, quarantined: [] });
    pin(f.publicPlan, repo.git("rev-parse", "HEAD"));
    const view = createNowView(f.opts);
    const equalFresh = (label: string) => {
      const [body] = view.materialize(f.context());
      assert.ok(body, `the ${label} makes the held view rebuild`);
      const fresh = createNowView({ ...f.opts, github: () => {
        // A fresh exec identity reads the current history. The raw gateway's prose accessor is omitted.
        const github = buildBatchedGithub("o", "r", {
          fetchAll: () => closed, commitTrailerIndex: buildCommitTrailerIndex({ slug: "o/r", exec: (args) => repo.git(...args) }),
        });
        return { github: { ...github, mergedProseIndex: undefined, changedFiles: () => undefined }, generation: "reference",
          source: snapshotGithub(f.root, "o", "r", CLOCK).source };
      } });
      const [expected] = fresh.materialize(f.context());
      assert.ok(expected);
      assert.deepEqual(body, expected, label);
      return body.data;
    };
    const status = (data: ReturnType<typeof equalFresh>, id: string) => data.board.tasks.find((row) => row.taskId === id)?.status;
    assert.equal(status(equalFresh("cold build"), trailerTask), "queued");
    f.append({ step: "manual.completed", task_id: ledgerTask, actor: "fixture" });
    assert.equal(status(equalFresh("new row"), ledgerTask), "merged");
    closed = [...closed, merged(19, `Remudero-Task: ${resavedTask}`)];
    assert.equal(f.cache.commitClosed(closed), true);
    assert.equal(status(equalFresh("GitHub re-save"), resavedTask), "merged");
    f.append({ step: "pr.opened", task_id: "W1-T9", pr_url: url(19), plan_only: true });
    assert.equal(status(equalFresh("cross-task filing evidence"), resavedTask), "queued");
    repo.git("commit", "--quiet", "--allow-empty", "-m", "plan pin fixture");
    pin(planOf([{ ...task("W1-T1"), title: "pinned title" }]), repo.git("rev-parse", "HEAD"));
    assert.equal(equalFresh("new plan pin").board.tasks.find((row) => row.taskId === "W1-T1")?.title, "pinned title");
    land(repo, 18, trailerTask);
    assert.equal(status(equalFresh("new origin/main"), trailerTask), "merged");
  } finally {
    process.chdir(previousCwd);
  }
});
