import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { OpsCatalogApi } from "../src/lib/ops-catalog-source.js";
import { originWithClone } from "./helpers/git-repo.js";
import { ownedFixtureDir } from "./helpers/owned-fixture-dir.js";
import { buildPlanReconcileCadenceInput, planReconcileCadence, type MeasurementCadenceReportOpts } from "../src/lib/measurement-cadence.js";
import { VERDICT_OUTCOME_STEP } from "../src/lib/verdict-calibration.js";
import { buildPlanReconcileProductionInput, defaultCreditedMergedIds, buildCreditCandidates, buildCoverageNightlyDaemonHook, buildMeasurementCadenceDaemonHooks } from "../src/run-task.js";
import { fixedClock } from "../src/lib/clock.js";
import { LEDGER_FILENAME } from "../src/lib/ledger-path.js";
import { withTempDir } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

test("the daemon GitHub cadence invokes the intake before its sibling check can fail", async () => {
  await withTempDir("nightly-intake-test", async (root) => {
    const at = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const run = { id: 1234, head_sha: "abc123", head_branch: "main", status: "completed", conclusion: "failure" };
    const summary = {
      kind: "coverage_nightly.measured", sha: run.head_sha, ref: "refs/heads/main",
      run_id: String(run.id), measured_at: new Date(at).toISOString(),
      lines_pct: 93, branches_pct: 88, lf: 100, lh: 93, brf: 100, brh: 88,
      skipped_records: 0, tier: "improve", shard_test_exits: { "1": 1, "2": 0 },
    };
    const ledgerPath = join(root, "state", LEDGER_FILENAME);
    let reads = 0;
    const hook = buildCoverageNightlyDaemonHook({
      ledgerPath, owner: "owner", repo: "repo", clock: fixedClock(at),
      reader: {
        newestCompletedRun: async () => { reads++; return run; },
        summaryForRun: async () => summary,
      },
      next: () => { throw new Error("sibling check stopped"); },
    });
    await assert.rejects(hook(), /sibling check stopped/);
    assert.equal(reads, 1);
    const [row] = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(row.run_id, "1234");
    assert.equal(row.head_sha, run.head_sha);
    assert.equal(row.kind, summary.kind);
    await assert.rejects(hook(), /sibling check stopped/);
    assert.equal(reads, 1);
    assert.equal(readFileSync(ledgerPath, "utf8").trim().split("\n").length, 1);
  });
});

test("W1-T3970: production measurement cadence supplies plan reconciliation inputs", () => {
  const landed: Array<Array<{ relPath: string; content: string; edit?: (current: string) => string | undefined }>> = [];
  const opts = buildPlanReconcileCadenceInput({
    checkoutRoot: "/fixture",
    readShards: () => [
      { taskId: "W1-T1", path: "/fixture/plan/tasks.d/W1-T1.yaml", text: "- id: W1-T1\n  status: queued\n" },
      { taskId: "W1-T2", path: "/fixture/plan/tasks.d/W1-T2.yaml", text: "- id: W1-T2\n  status: queued\n" },
    ],
    creditedMergedIds: () => new Set(["W1-T1"]),
    threshold: 1,
    land: (inputs) => landed.push([...inputs]),
  });
  const report = planReconcileCadence(opts);
  assert.equal(report.status, "landed");
  assert.deepEqual(landed.map((batch) => batch.map(({ relPath, content }) => ({ relPath, content }))),
    [[{ relPath: "plan/tasks.d/W1-T1.yaml", content: "- id: W1-T1\n  status: merged\n" }]]);
  // W1-T13816: the landing applies the input's status edit to main's current text, not to this read.
  assert.equal(landed[0][0].edit?.("- id: W1-T1\n  status: queued\n  note: main\n"), "- id: W1-T1\n  status: merged\n  note: main\n");
  assert.deepEqual(report.taskIds, ["W1-T1"]);
});

test("W1-T3970: daemon checkout remains clean", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-reconcile-wiring-"));
  try {
    let landed = false;
    const opts = buildPlanReconcileCadenceInput({
      checkoutRoot: root,
      readShards: () => [{ taskId: "W1-T3", path: join(root, "plan/tasks.d/W1-T3.yaml"), text: "  status: queued\n" }],
      creditedMergedIds: () => new Set(["W1-T3"]),
      threshold: 1,
      land: () => {
        landed = true;
      },
    });
    assert.equal(planReconcileCadence(opts).status, "landed");
    assert.equal(landed, true);
    assert.equal(existsSync(join(root, "plan")), false, "landing must not write the daemon checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3970: production adapter lands threshold drift and refuses an unlanded result", () => {
  const ids = Array.from({ length: 10 }, (_, i) => `W1-T${i + 1}`);
  const records = ids.map((taskId) => ({ taskId, path: `/fixture/plan/tasks.d/${taskId}.yaml`, text: `- id: ${taskId}\n  status: queued\n` }));
  let landed = 0;
  const input = buildPlanReconcileProductionInput({
    checkoutRoot: "/fixture",
    readShards: () => records,
    creditedMergedIds: () => new Set(ids),
    land: (_root, writes) => {
      landed = writes.length;
      return { landed: true, files: writes.map((write) => write.relPath) };
    },
  });
  assert.ok(input);
  assert.deepEqual(planReconcileCadence(input!), { drift: 10, taskIds: ids, status: "landed", threshold: 1 });
  assert.equal(landed, 10);

  const refused = buildPlanReconcileProductionInput({
    checkoutRoot: "/fixture",
    readShards: () => records,
    creditedMergedIds: () => new Set(ids),
    land: () => ({ landed: false, files: [], error: "simulated landing refusal" }),
  });
  assert.ok(refused);
  assert.throws(() => planReconcileCadence(refused!), /simulated landing refusal/);
});

// W1-T14827: the production reconcile over two real catalogs while one id's move is in flight (in both of them).
const MOVED_ID = "W1-T900001", PUBLIC_ID = "W1-T900002", OPS_ID = "W1-T900003";
type FixtureStatus = "queued" | "merged";
const shardPath = (id: string) => `plan/tasks.d/${id}.yaml`;
const catalogShard = (id: string, status: FixtureStatus, moved = false) =>
  `- id: ${id}\n${moved ? `  moved_from: remudero@${"f".repeat(40)}\n` : ""}  title: Reconcile the fixture status\n` +
  "  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: medium\n" +
  `  status: ${status}\n  origin: test#reconcile\n  files: [src/fixture.ts]\n  acceptance:\n` +
  "    - claim: the fixture has its exported value\n      proof: \"grep: publicValue in src/fixture.ts\"\n";

function movingCatalogs(t: TestContext, moved: { public: FixtureStatus; ops: FixtureStatus }, opsOnly: readonly string[] = [OPS_ID]) {
  const root = ownedFixtureDir(t, "w1-t14827-catalogs").dir;
  const stateDir = join(root, "state"), publicRoot = join(root, "repos", "remudero"), opsRoot = join(root, "repos", "ops");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: "fixture-private/ops", kinds: [] }));
  mkdirSync(join(publicRoot, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(publicRoot, "src"));
  writeFileSync(join(publicRoot, "src", "fixture.ts"), "export const publicValue = true;\n");
  writeFileSync(join(publicRoot, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(publicRoot, shardPath(MOVED_ID)), catalogShard(MOVED_ID, moved.public));
  writeFileSync(join(publicRoot, shardPath(PUBLIC_ID)), catalogShard(PUBLIC_ID, "queued"));
  const { clone } = originWithClone(opsRoot, { scope: t, seed: {
    "plan/tasks.yaml": "[]\n",
    [shardPath(MOVED_ID)]: catalogShard(MOVED_ID, moved.ops, true),
    ...Object.fromEntries(opsOnly.map((id) => [shardPath(id), catalogShard(id, "queued")])),
  } });
  const opsApi: OpsCatalogApi = async (path) => {
    const prefix = "repos/fixture-private/ops";
    assert.ok(path === prefix || path.startsWith(`${prefix}/`), `GET only the named repository: ${path}`);
    const tail = path.slice(prefix.length), head = clone.git("rev-parse", "HEAD");
    if (tail === "") return { id: 42, full_name: "fixture-private/ops", default_branch: "main" };
    if (tail === "/git/ref/heads/main") return { object: { type: "commit", sha: head } };
    if (tail === `/git/commits/${head}`) return { sha: head, tree: { sha: clone.git("rev-parse", `${head}^{tree}`) } };
    if (tail.startsWith("/git/trees/")) {
      const sha = tail.slice("/git/trees/".length);
      const rows = execFileSync("git", ["-C", opsRoot, "ls-tree", "-z", sha], { encoding: "utf8" }).split("\0").filter(Boolean);
      return { sha, truncated: false, tree: rows.map((row) => {
        const match = /^(\d+) (blob|tree) ([a-f0-9]+)\t(.+)$/.exec(row);
        assert.ok(match, row);
        return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
      }) };
    }
    if (tail.startsWith("/git/blobs/")) {
      const sha = tail.slice("/git/blobs/".length), content = execFileSync("git", ["-C", opsRoot, "cat-file", "blob", sha]);
      return { sha, encoding: "base64", size: content.length, content: content.toString("base64") };
    }
    return assert.fail(`unexpected ops source path ${path}`);
  };
  /** One cadence fire through the production composition; every landing it makes is then merged into its catalog. */
  const fire = async (credited: ReadonlySet<string>) => {
    const calls: Array<{ root: string; inputs: Array<{ relPath: string; content: string }> }> = [];
    const input = await buildPlanReconcileProductionInput({
      checkoutRoot: publicRoot,
      stateDir,
      opsApi,
      readShards: () => readdirSync(join(publicRoot, "plan", "tasks.d")).sort().map((file) => {
        const path = join(publicRoot, "plan", "tasks.d", file);
        return { taskId: file.replace(/\.yaml$/, ""), path, text: readFileSync(path, "utf8") };
      }),
      creditedMergedIds: () => credited,
      lint: () => new Map(),
      land: (root, inputs) => {
        calls.push({ root, inputs: inputs.map(({ relPath, content }) => ({ relPath, content })) });
        return { landed: true, files: inputs.map((each) => each.relPath) };
      },
    });
    assert.ok(input);
    assert.equal(input.catalogOutcome, "ok");
    const report = planReconcileCadence(input);
    await input.settled();
    for (const call of calls) {
      for (const each of call.inputs) writeFileSync(join(call.root, each.relPath), each.content);
      if (call.root === opsRoot) {
        clone.git("add", "-A");
        clone.git("commit", "--quiet", "-m", "chore: merge the status landing");
      }
    }
    const landedIn = (root: string) => calls.filter((call) => call.root === root).flatMap((call) => call.inputs.map((each) => each.relPath));
    return { report, public: landedIn(publicRoot), ops: landedIn(opsRoot) };
  };
  return { fire };
}

for (const moved of [
  { public: "queued", ops: "queued" },
  { public: "queued", ops: "merged" },
  { public: "merged", ops: "queued" },
  { public: "merged", ops: "merged" },
] as const) {
  test(`W1-T14827 criterion 1: a moved id (public ${moved.public}, ops ${moved.ops}) never joins the ops landing`, async (t) => {
    const catalogs = movingCatalogs(t, moved);
    const credited = new Set([MOVED_ID, PUBLIC_ID, OPS_ID]);
    const publicDrift = moved.public === "queued" ? [MOVED_ID, PUBLIC_ID] : [PUBLIC_ID];

    const first = await catalogs.fire(credited);
    assert.deepEqual([...first.report.taskIds].sort(), [...publicDrift, OPS_ID], "each drifted id is counted once");
    assert.deepEqual(first.public, publicDrift.map(shardPath), "the moved id's public record flips with the public group");
    assert.deepEqual(first.ops, [shardPath(OPS_ID)], "the other ops record lands; the in-flight ops copy is not written");

    const second = await catalogs.fire(credited);
    assert.equal(second.report.status, "clear", JSON.stringify(second.report));
    assert.deepEqual([second.public, second.ops], [[], []]);
  });
}

test("W1-T14827 criterion 1: a moved id's lost-credit re-queue stays with the public group", async (t) => {
  const catalogs = movingCatalogs(t, { public: "merged", ops: "merged" });
  const credited = Object.assign(new Set([PUBLIC_ID, OPS_ID]), {
    requeue: [{ taskId: MOVED_ID, merged: false, creditOverride: { reason: "fixture revert", pr: 1 } }],
  });
  const first = await catalogs.fire(credited);
  assert.deepEqual(first.report.requeued, [MOVED_ID]);
  assert.deepEqual(first.ops, [shardPath(OPS_ID)]);
  // The public group decides the re-queue: it lands there, or the public lint names it as held (the ops lint is empty).
  assert.ok(first.public.includes(shardPath(MOVED_ID)) || first.report.held?.some((held) => held.taskId === MOVED_ID),
    JSON.stringify({ report: first.report, public: first.public }));
});

test("W1-T14827 criterion 3: ten drifted ops records land beside an in-flight id the ops copy already reads merged", async (t) => {
  const opsOnly = Array.from({ length: 10 }, (_, i) => `W1-T${900100 + i}`);
  const catalogs = movingCatalogs(t, { public: "queued", ops: "merged" }, opsOnly);
  const first = await catalogs.fire(new Set([MOVED_ID, ...opsOnly]));
  assert.equal(first.report.drift, 11);
  assert.deepEqual(first.public, [shardPath(MOVED_ID)]);
  assert.deepEqual(first.ops, opsOnly.map(shardPath));
});

test("W1-T14827 criterion 3: an ops catalog holding only in-flight copies leaves one drifted public record landing", async (t) => {
  const catalogs = movingCatalogs(t, { public: "queued", ops: "queued" }, []);
  const first = await catalogs.fire(new Set([MOVED_ID]));
  assert.equal(first.report.status, "landed");
  assert.deepEqual([first.public, first.ops], [[shardPath(MOVED_ID)], []]);
});

test("W1-T3970: production adapter's omitted land seam invokes the real local landing bridge", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-reconcile-default-"));
  const origin = mkdtempSync(join(tmpdir(), "rmd-plan-reconcile-default-origin-"));
  const ghBin = mkdtempSync(join(tmpdir(), "rmd-plan-reconcile-default-gh-"));
  const oldPath = process.env.PATH;
  try {
    execFileSync("git", ["init", "--quiet", "--bare", origin]);
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"]);
    execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "fixture"]);
    writeFileSync(join(root, "README.md"), "fixture\n");
    execFileSync("git", ["-C", root, "add", "README.md"]);
    execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "chore: seed fixture"]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", origin]);
    execFileSync("git", ["-C", root, "push", "--quiet", "origin", "main"]);

    writeFileSync(
      join(ghBin, "gh"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = pr ] && [ \"$2\" = list ]; then printf '%s\\n' '[]'; " +
        "elif [ \"$1\" = pr ] && [ \"$2\" = create ]; then printf '%s\\n' 'https://github.com/o/r/pull/3970'; " +
        "else :; fi\n",
      { mode: 0o755 },
    );
    process.env.PATH = `${ghBin}:${oldPath}`;

    const ids = Array.from({ length: 10 }, (_, i) => `W1-T${i + 1}`);
    // W1-T13816: the landing edits main's copy, so main holds the shards; a second clone pushes them and
    // the daemon checkout stays without plan/.
    const writer = mkdtempSync(join(tmpdir(), "rmd-plan-reconcile-default-writer-"));
    execFileSync("git", ["clone", "--quiet", "--branch", "main", origin, writer]);
    execFileSync("git", ["-C", writer, "config", "user.email", "fixture@example.invalid"]);
    execFileSync("git", ["-C", writer, "config", "user.name", "fixture"]);
    mkdirSync(join(writer, "plan", "tasks.d"), { recursive: true });
    for (const taskId of ids) writeFileSync(join(writer, "plan", "tasks.d", `${taskId}.yaml`), `- id: ${taskId}\n  status: queued\n`);
    execFileSync("git", ["-C", writer, "add", "plan"]);
    execFileSync("git", ["-C", writer, "commit", "--quiet", "-m", "chore: shards on main"]);
    execFileSync("git", ["-C", writer, "push", "--quiet", "origin", "HEAD:main"]);
    rmSync(writer, { recursive: true, force: true });
    const input = buildPlanReconcileProductionInput({
      checkoutRoot: root,
      readShards: () =>
        ids.map((taskId) => ({
          taskId,
          path: join(root, "plan", "tasks.d", `${taskId}.yaml`),
          text: `- id: ${taskId}\n  status: queued\n`,
        })),
      creditedMergedIds: () => new Set(ids),
    });
    assert.ok(input);

    // W1-T9695: the cadence starts the awaited landing; `settled` resolves once it has landed.
    const report = await withLiveWritesAllowed(async () => {
      const cadence = planReconcileCadence(input);
      await input.settled();
      return cadence;
    });
    assert.equal(report.status, "landed");
    assert.deepEqual(report.taskIds, ids);
    assert.equal(existsSync(join(root, "plan")), false, "the landing bridge must not write the daemon checkout");
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test("W1-T3970: production adapter omits the optional rung when credit projection construction fails", () => {
  const input = buildPlanReconcileProductionInput({
    checkoutRoot: "/fixture",
    readShards: () => [],
    creditedMergedIds: () => {
      throw new Error("simulated credit projection refusal");
    },
    land: () => ({ landed: true, files: [] }),
  });
  assert.equal(input, undefined);
});

test("W1-T3970: the default credit projection reads the supplied checkout plan before deriving candidates", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-credit-projection-"));
  try {
    mkdirSync(join(root, "plan"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      join(root, "plan", "tasks.yaml"),
      "- id: W1-T1\n  title: fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n",
    );
    writeFileSync(join(root, "state", "ledger.ndjson"), "{}\n");
    const candidates: ReturnType<typeof buildCreditCandidates> = [
      { taskId: "W1-T1", prNumber: 1, prUrl: "https://github.com/o/r/pull/1", merged: true, creditIsImplementation: true },
    ];
    const credited = defaultCreditedMergedIds(
      { root } as Config,
      root,
      (() => candidates) as typeof buildCreditCandidates,
    );
    assert.deepEqual([...credited], ["W1-T1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T12425 criterion 3: the daemon's cadence call gives the outcome writer, and it appends the row to the daemon's ledger", async () => {
  await withTempDir("verdict-outcome-writer", async (root) => {
    let supplied: MeasurementCadenceReportOpts | undefined;
    const hooks = buildMeasurementCadenceDaemonHooks({
      config: { root } as Config,
      verifyHumanCadenceResult: async () => ({}) as never,
      successorWatch: async () => ({}) as never,
      creditedMergedIds: () => new Set(),
      proofDebtInput: () => undefined,
      measurementReport: async (input: MeasurementCadenceReportOpts) => {
        supplied = input;
        input.outcomes?.writeLedgerLine({ step: VERDICT_OUTCOME_STEP, task_id: "W1-T9001", head_sha: "a".repeat(40), merge_sha: "b".repeat(40),
          outcome: "reverted", window_days: 14 });
        return {} as Awaited<ReturnType<typeof import("../src/lib/measurement-cadence.js").runMeasurementCadenceReportAsync>>;
      },
    } as Parameters<typeof buildMeasurementCadenceDaemonHooks>[0]);
    await hooks.runMeasurementCadence();
    assert.equal(typeof supplied?.outcomes?.writeLedgerLine, "function", "the daemon's cadence call gives an outcome writer");
    const rows = readFileSync(join(root, "state", LEDGER_FILENAME), "utf8").trim().split("\n").map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((row) => row.step === VERDICT_OUTCOME_STEP);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.task_id, rows[0]!.head_sha, rows[0]!.outcome, rows[0]!.window_days, rows[0]!.lane], ["W1-T9001", "a".repeat(40), "reverted", 14, "measurement-cadence"]);
    assert.match(String(rows[0]!.run_id), /^VERDICT-OUTCOME-/);
  });
});
