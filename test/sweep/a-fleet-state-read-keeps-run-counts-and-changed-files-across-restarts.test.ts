import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { loadFleetStateCommitStore } from "#src/lib/fleet-state-commit-store.js";
import { realLedgerFs } from "#src/lib/ledger-union.js";
import { reconcileFleetState } from "#src/lib/state-reconciler.js";
import { buildSweepEffects, createFullPreludeTimer, runSweep } from "#src/lib/sweep.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const proof = "test/sweep/a-fleet-state-read-keeps-run-counts-and-changed-files-across-restarts.test.ts";
const childFlag = "--w1-t12234-second-process=";
const childMark = "W1-T12234-CHILD ";
const LOOKBACK = 15;

/** What the fake GitHub answers. A key is a commit, or `commit:workflow`. */
interface Answers {
  commits: string[];
  workflows: string[];
  zero: string[];
  unreadable: string[];
}

interface Pass {
  reads: string[];
  parts: Record<string, number>;
  recorded: Record<string, unknown>[];
  observed: Array<{ target: string; observed: boolean | undefined }>;
  history: number;
}

const chain = (count: number, from = 0): string[] => Array.from({ length: count }, (_, i) => `c${from + count - 1 - i}`);
const storePath = (root: string): string => join(root, "state", "cache", "fleet-state-commits.json");
const storedCommits = (root: string): Record<string, { runs?: boolean; workflows?: string[]; files?: string[] }> =>
  JSON.parse(fs.readFileSync(storePath(root), "utf8")).commits;

function makeRoot(workflows: string[]): string {
  const root = fs.mkdtempSync(join(tmpdir(), "rmd-fleet-commit-store-"));
  fs.mkdirSync(join(root, "state"));
  fs.mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const name of workflows) {
    fs.writeFileSync(join(root, ".github", "workflows", name), "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n");
  }
  fs.writeFileSync(join(root, "state", "ledger.ndjson"), JSON.stringify({ step: "heartbeat.tick" }) + "\n");
  return root;
}

/** The production reader over a fake GitHub. Each call of `pass` is one full sweep's fleet-state read. */
function reader(root: string, answers: Answers) {
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const reads: string[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const dispatches: string[] = [];
  const count = (key: string): unknown =>
    answers.unreadable.includes(key) ? {} : { total_count: answers.zero.includes(key) ? 0 : 3 };
  const readJsonImpl = async (args: string[]): Promise<unknown> => {
    const endpoint = args[1]!;
    const sha = endpoint.match(/head_sha=([^&]+)/)?.[1];
    const workflow = endpoint.match(/actions\/workflows\/([^/]+)\/runs/)?.[1];
    if (endpoint.includes("commits?")) {
      reads.push("list");
      return answers.commits.map((commit, i) => ({ sha: commit, parents: answers.commits[i + 1] ? [{ sha: answers.commits[i + 1] }] : [] }));
    }
    if (endpoint.includes("/commits/")) {
      reads.push(`files:${endpoint.split("/commits/")[1]}`);
      return { files: [{ filename: "src/example.ts" }] };
    }
    if (workflow) {
      reads.push(`runs:${sha}:${workflow}`);
      return count(`${sha}:${workflow}`);
    }
    reads.push(`runs:${sha}`);
    return count(String(sha));
  };
  const effects = () => buildSweepEffects({
    owner: "o", repo: "r", repoRoot: root, config: { root } as never,
    ledgerPath, runId: "W1-T12234", plan: { tasks: [], byId: new Map() } as never,
    nowMsImpl: () => 0,
    log: (step, extra) => logs.push({ step, extra }),
    ghRunImpl: (_command, args) => { dispatches.push(args.find((arg) => arg.includes("/dispatches")) ?? ""); },
    readJsonImpl,
    fleetDeployStateImpl: {
      deploy: { newestBakedSha: () => undefined },
      failedAt: () => undefined, clearFailure: () => {},
      deployRequested: () => false, requestDeploy: () => { throw new Error("unexpected deploy repair"); },
    },
  });
  const pass = async (onBuilt?: () => void): Promise<Pass> => {
    const before = reads.length;
    const built = effects();
    onBuilt?.();
    const state = await built.readFleetState!([]);
    const recorded: Record<string, unknown>[] = [];
    const observed: Pass["observed"] = [];
    const rows = state.rows.map((row) => ({ ...row, observe: async () => {
      const seen = await row.observe();
      observed.push({ target: row.target, observed: seen });
      return seen;
    } }));
    // The sweep appends each reconcile row to the ledger, so the next pass reads it as history.
    await reconcileFleetState(rows, state.history, (event) => {
      recorded.push(event);
      fs.appendFileSync(ledgerPath, JSON.stringify(event) + "\n");
    });
    return { reads: reads.slice(before), parts: { ...state.parts }, recorded, observed, history: state.history.length };
  };
  return { pass, reads, logs, dispatches, effects, ledgerPath };
}

function fixture(t: { after(fn: () => void): void }, answers: Partial<Answers> = {}) {
  const full: Answers = { commits: chain(3), workflows: ["a.yml", "b.yml"], zero: [], unreadable: [], ...answers };
  const root = makeRoot(full.workflows);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, answers: full, ...reader(root, full) };
}

const kinds = (reads: string[]) => ({
  list: reads.filter((read) => read === "list").length,
  files: reads.filter((read) => read.startsWith("files:")).length,
  commitRuns: reads.filter((read) => /^runs:[^:]+$/.test(read)).length,
  workflowRuns: reads.filter((read) => /^runs:[^:]+:/.test(read)).length,
});

// ── The second process ───────────────────────────────────────────────────────────────────────────
// A restarted daemon is a new process: it has no reader, no store and no changed files in memory.
// This file runs itself as that process, so the test goes through the production entry path.

async function secondProcess(root: string): Promise<void> {
  const answers = JSON.parse(fs.readFileSync(join(root, "answers.json"), "utf8")) as Answers;
  const archives = new Set<string>();
  const digests = new Set<string>();
  const note = (path: unknown): void => {
    const text = String(path);
    if (/^ledger\..+\.ndjson(\.gz)?$/.test(basename(text))) archives.add(basename(text));
    if (text.includes("rotation-digests")) digests.add(basename(text));
  };
  const stream = fs.createReadStream;
  const readFile = fsPromises.readFile;
  const readSync = fs.readFileSync;
  const ledgerSync = realLedgerFs.readFileSync;
  fs.createReadStream = ((...args: Parameters<typeof stream>) => { note(args[0]); return stream(...args); }) as typeof stream;
  fsPromises.readFile = ((...args: Parameters<typeof readFile>) => { note(args[0]); return readFile(...args); }) as typeof readFile;
  fs.readFileSync = ((...args: Parameters<typeof readSync>) => { note(args[0]); return readSync(...args); }) as typeof readSync;
  realLedgerFs.readFileSync = (path: string) => { note(path); return ledgerSync(path); };
  syncBuiltinESMExports();
  const r = reader(root, answers);
  // Building the effects reads the ledger for other stages. Only the reads of the fleet-state read count here.
  const result = await r.pass(() => { archives.clear(); digests.clear(); });
  process.stdout.write(childMark + JSON.stringify({ ...result, archives: [...archives].sort(), digests: [...digests].sort(),
    logs: r.logs.map((row) => row.step), dispatches: r.dispatches }) + "\n");
}

type ChildPass = Pass & { archives: string[]; digests: string[]; logs: string[]; dispatches: string[] };

function runSecondProcess(root: string, answers: Answers): ChildPass {
  fs.writeFileSync(join(root, "answers.json"), JSON.stringify(answers));
  const child = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, proof), `${childFlag}${root}`],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 240_000,
      // The test runner marks its own children with this variable. The second process is not a test file.
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT")) });
  const line = child.stdout.split("\n").find((text) => text.startsWith(childMark));
  assert.ok(line, `the second process printed no result: status ${child.status}\n${child.stderr.slice(-2000)}`);
  return JSON.parse(line.slice(childMark.length)) as ChildPass;
}

const childRoot = process.argv.find((arg) => arg.startsWith(childFlag))?.slice(childFlag.length);
if (childRoot !== undefined) {
  await secondProcess(childRoot);
} else {
  test(`${proof}: W1-T12234 criterion 1: a commit that has a run is not asked for its run count again`, async (t) => {
    const f = fixture(t);
    const first = await f.pass();
    assert.deepEqual(kinds(first.reads), { list: 1, files: 2, commitRuns: 3, workflowRuns: 4 }, "positive control: an empty store reads all");
    assert.equal(first.parts.commit_reads, 10);
    assert.equal(first.parts.commit_reads_kept, 0);
    assert.deepEqual(Object.keys(storedCommits(f.root)).sort(), ["c0", "c1", "c2"]);
    assert.ok(Object.values(storedCommits(f.root)).every((commit) => commit.runs === true));

    const second = await f.pass();
    assert.equal(kinds(second.reads).commitRuns, 0, "no run-count read for a commit whose answer is kept");
    assert.equal(second.parts.commits_walked, 3, "the walk still visits each commit of the look-back");
    assert.deepEqual(second.observed, first.observed, "the rows observe the same state");
    assert.deepEqual(second.recorded, first.recorded);
    assert.equal(f.dispatches.length, 0);
  });

  test(`${proof}: W1-T12234 criterion 2: a kept workflow answer serves only its own commit and workflow`, async (t) => {
    // c0 has no run of a.yml. Each other pair has a run.
    const f = fixture(t, { zero: ["c0:a.yml"] });
    const first = await f.pass();
    assert.equal(kinds(first.reads).workflowRuns, 4);
    assert.deepEqual(first.observed, [
      { target: "c1:a.yml", observed: true }, { target: "c1:b.yml", observed: true },
      { target: "c0:a.yml", observed: false }, { target: "c0:b.yml", observed: true },
    ]);
    assert.deepEqual(first.recorded.map((row) => [row.step, row.target]), [["reconcile.repaired", "c0:a.yml"]]);
    assert.deepEqual(storedCommits(f.root).c1?.workflows, ["a.yml", "b.yml"]);
    assert.deepEqual(storedCommits(f.root).c0?.workflows, ["b.yml"], "the pair with no run is not in the store");

    const second = await f.pass();
    // The kept answers for c1:a.yml and c0:b.yml do not answer for c0:a.yml. The repaired pair also reads its repair head.
    assert.deepEqual(second.reads, ["list", "runs:c0:a.yml", "runs:c2:a.yml"]);
    assert.deepEqual(second.observed, [
      { target: "c1:a.yml", observed: true }, { target: "c1:b.yml", observed: true },
      { target: "c0:a.yml", observed: true }, { target: "c0:b.yml", observed: true },
    ]);
    assert.equal(second.parts.commit_reads, 3);
    assert.equal(second.parts.commit_reads_kept, 3 + 2 + 3, "three run counts, two file lists and three workflow pairs");
    assert.equal(f.dispatches.length, 1, "the one dispatch of the first pass, and no second one");

    const third = await f.pass();
    assert.deepEqual(third.reads, ["list", "runs:c0:a.yml"], "the repair head's answer is kept now");
  });

  test(`${proof}: W1-T12234 criterion 3: a count of 0 and an unreadable count are read again`, async (t) => {
    // The head has no run yet, c1 has an unreadable workflow count, and c0 has no run of b.yml.
    const f = fixture(t, { commits: chain(4), zero: ["c3", "c3:b.yml", "c0:b.yml"], unreadable: ["c1:a.yml"] });
    const first = await f.pass();
    assert.deepEqual(first.observed, [
      { target: "c1:a.yml", observed: undefined }, { target: "c1:b.yml", observed: true },
      { target: "c0:a.yml", observed: true }, { target: "c0:b.yml", observed: false },
    ]);
    const stored = storedCommits(f.root);
    assert.equal(stored.c3, undefined, "a commit with a count of 0 has no entry");
    assert.deepEqual(stored.c1?.workflows, ["b.yml"]);
    assert.deepEqual(stored.c0?.workflows, ["a.yml"]);

    // The second pass reads each of them again. c0:b.yml was repaired, so its row also reads the repair head.
    const second = await f.pass();
    assert.deepEqual(second.reads, ["list", "runs:c3", "runs:c1:a.yml", "runs:c0:b.yml", "runs:c3:b.yml"]);
    assert.deepEqual(second.observed.map((row) => row.observed), [undefined, true, true, false]);
    assert.equal(storedCommits(f.root).c3, undefined);

    // The runs appear. The next pass reads them once. The head has a run now, so c2 gets its rows.
    f.answers.zero.length = 0;
    f.answers.unreadable.length = 0;
    const third = await f.pass();
    assert.deepEqual(third.reads, ["list", "runs:c3", "files:c2", "runs:c2:a.yml", "runs:c2:b.yml", "runs:c1:a.yml", "runs:c0:b.yml"]);
    assert.deepEqual(third.observed.map((row) => row.observed), [true, true, true, true, true, true]);
    assert.deepEqual((await f.pass()).reads, ["list"], "each answer is positive now, and each is kept");
  });

  test(`${proof}: W1-T12234 criterion 4: a second process on the same state directory reads no kept answer again`, async (t) => {
    const f = fixture(t, { zero: ["c0:a.yml"] });
    const cold = runSecondProcess(f.root, f.answers);
    assert.deepEqual(kinds(cold.reads), { list: 1, files: 2, commitRuns: 3, workflowRuns: 4 }, "positive control: the first process reads all");
    assert.equal(cold.dispatches.length, 1);

    const restarted = runSecondProcess(f.root, f.answers);
    assert.deepEqual(restarted.reads, ["list", "runs:c0:a.yml", "runs:c2:a.yml"]);
    assert.equal(kinds(restarted.reads).files, 0, "the changed files of a kept commit are not read again");
    assert.equal(restarted.parts.commit_reads_kept, 8);
    assert.equal(restarted.dispatches.length, 0, "the restart dispatches nothing again");
    assert.deepEqual(restarted.logs.filter((step) => step.startsWith("reconcile.commit_store")), []);
  });

  test(`${proof}: W1-T12234 criterion 5: an unreadable store changes no read and no row, and one row names the reason`, async (t) => {
    const answers = { zero: ["c0:a.yml"], unreadable: ["c1:b.yml"] };
    const clean = fixture(t, answers);
    const expected = [await clean.pass(), await clean.pass()];
    assert.equal(clean.logs.filter((row) => row.step.startsWith("reconcile.commit_store")).length, 0, "a missing file is not a failure");

    const poison = { schema: 1, commits: { c0: { runs: true, workflows: ["a.yml"] }, c1: { runs: true, workflows: ["b.yml"] } } };
    const damages: Array<[string, (path: string) => void, RegExp]> = [
      ["not JSON", (path) => fs.writeFileSync(path, "{\"schema\":1,\"commits\":{\"c0\":{\"runs\":tr"), /JSON/],
      ["another schema", (path) => fs.writeFileSync(path, JSON.stringify({ ...poison, schema: 2 })), /schema 2 is not schema 1/],
      ["no schema", (path) => fs.writeFileSync(path, JSON.stringify({ commits: poison.commits })), /schema undefined is not schema 1/],
      ["a wrong shape", (path) => fs.writeFileSync(path, JSON.stringify({ schema: 1, commits: { c0: { runs: 1 } } })), /commit c0 has a run answer that is not true/],
      ["a wrong list", (path) => fs.writeFileSync(path, JSON.stringify({ schema: 1, commits: { c0: { runs: true, workflows: "a.yml" } } })), /commit c0 has workflows/],
      ["not a file", (path) => fs.mkdirSync(path), /EISDIR/],
    ];
    for (const [name, damage, reason] of damages) {
      const f = fixture(t, answers);
      fs.mkdirSync(join(f.root, "state", "cache"), { recursive: true });
      damage(storePath(f.root));
      const actual = [await f.pass(), await f.pass()];
      const rows = f.logs.filter((row) => row.step === "reconcile.commit_store_unreadable");
      assert.equal(rows.length, 1, `${name}: one row for the two passes`);
      assert.match(String(rows[0]!.extra?.reason), reason, name);
      // Every answer in the damaged file is dropped, so the first pass reads what an empty store reads.
      assert.deepEqual(actual[0], expected[0], `${name}: the first pass makes today's reads and gives today's rows`);
      assert.deepEqual(actual[0]!.observed, [
        { target: "c1:a.yml", observed: true }, { target: "c1:b.yml", observed: undefined },
        { target: "c0:a.yml", observed: false }, { target: "c0:b.yml", observed: true },
      ]);
      assert.deepEqual(f.dispatches, clean.dispatches, `${name}: the same dispatch`);
      assert.deepEqual(actual[1], expected[1], `${name}: the answers of the first pass stay in memory`);
      if (name === "not a file") {
        assert.ok(f.logs.some((row) => row.step === "reconcile.commit_store_unwritable"), "a failed write is reported");
      } else {
        assert.deepEqual(Object.keys(storedCommits(f.root)).sort(), ["c0", "c1", "c2"], `${name}: the next write replaces the file`);
      }
    }
  });

  test(`${proof}: W1-T12234 criterion 6: a commit that left the look-back is removed at the next write`, async (t) => {
    const f = fixture(t, { commits: chain(LOOKBACK + 2), workflows: ["a.yml", "b.yml", "c.yml", "d.yml"] });
    const first = await f.pass();
    // The listing, 15 run counts, 14 file lists and 14 commits times 4 workflows.
    assert.deepEqual(kinds(first.reads), { list: 1, files: 14, commitRuns: 15, workflowRuns: 56 });
    assert.equal(first.parts.commit_reads, 86);
    assert.deepEqual(Object.keys(storedCommits(f.root)).sort(), chain(LOOKBACK, 2).sort());

    const second = await f.pass();
    assert.deepEqual(second.reads, ["list"], "a full pass with no new commit makes one read");
    assert.equal(second.parts.commit_reads_kept, 85);

    // An empty listing is not a look-back: it removes nothing from the store.
    const commits = f.answers.commits.splice(0);
    assert.deepEqual((await f.pass()).reads, ["list"]);
    f.answers.commits.push(...commits);
    assert.deepEqual((await f.pass()).reads, ["list"]);

    // Two commits land on main. The two oldest commits of the look-back leave it.
    f.answers.commits.unshift("c18", "c17");
    const third = await f.pass();
    assert.deepEqual(kinds(third.reads), { list: 1, files: 2, commitRuns: 2, workflowRuns: 8 });
    const kept = Object.keys(storedCommits(f.root)).sort();
    assert.deepEqual(kept, chain(LOOKBACK, 4).sort());
    assert.equal(kept.includes("c2") || kept.includes("c3"), false);
    assert.equal(kept.length, LOOKBACK);
  });

  test(`${proof}: W1-T12234 criterion 7: a second process takes the history from the snapshot and reads no rotated ledger file`, async (t) => {
    const f = fixture(t);
    const plain = "ledger.2026-10-14T00-00-00-000Z.ndjson";
    const gzip = "ledger.2026-10-15T00-00-00-000Z.ndjson.gz";
    fs.writeFileSync(join(f.root, "state", plain), JSON.stringify({ step: "deploy.ok", ts: "2026-10-14T00:00:00Z" }) + "\n");
    fs.writeFileSync(join(f.root, "state", gzip), gzipSync(JSON.stringify({ step: "reconcile.escalated", target: "gzip" }) + "\n"));
    const cold = runSecondProcess(f.root, f.answers);
    assert.deepEqual(cold.archives, [plain, gzip], "positive control: the first process reads both rotated files");
    assert.ok(fs.existsSync(join(f.root, "state", "cache", "rotation-slices", "sweep%2Efleet-state-history.json")));

    const restarted = runSecondProcess(f.root, f.answers);
    assert.deepEqual(restarted.archives, [], "no rotated ledger file is read or decompressed");
    assert.deepEqual(restarted.digests, [], "and no digest of one rotated file is read: the snapshot answers");
    assert.equal(restarted.history, cold.history, "the history has the same rows");
  });

  test(`${proof}: the sweep.full_prelude row reports the reads that the store answered`, async (t) => {
    const f = fixture(t);
    const sweep = async (): Promise<Record<string, unknown>> => {
      const rows: Record<string, unknown>[] = [];
      const timer = createFullPreludeTimer((row) => rows.push(row), () => 0);
      await runSweep([], {
        ledgerPath: f.ledgerPath, runId: "W1-T12234", readLedger: () => [],
        readLedgerUnion: () => ({ complete: true, lines: [] }),
        readFleetState: f.effects().readFleetState, markPrelude: timer.mark,
        arm: () => "armed", close: () => {}, dispatchFix: () => {}, escalate: () => {}, postReview: () => {},
        appendLine: () => { throw new Error("unexpected reconciliation write"); },
      });
      timer.write(false);
      assert.equal(rows.length, 1);
      return rows[0]!.fleet_state_parts as Record<string, unknown>;
    };
    const first = await sweep();
    assert.equal(first.commit_reads, 10);
    assert.equal(first.commit_reads_kept, 0);
    const second = await sweep();
    assert.equal(second.commit_reads, 1);
    assert.equal(second.commit_reads_kept, 9);
  });

  test(`${proof}: two writers at once leave a whole file and no temporary file`, async (t) => {
    const root = makeRoot([]);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDir = join(root, "state");
    const daemon = loadFleetStateCommitStore(stateDir);
    const verb = loadFleetStateCommitStore(stateDir);
    for (let round = 0; round < 20; round++) {
      daemon.setHasRuns(`d${round}`);
      verb.setHasWorkflowRuns(`v${round}`, "a.yml");
      assert.deepEqual(daemon.save(), { ok: true, written: true });
      assert.deepEqual(verb.save(), { ok: true, written: true });
      const next = loadFleetStateCommitStore(stateDir);
      assert.equal(next.unreadable, undefined, "each write leaves a file that a reader accepts");
      assert.equal(next.hasWorkflowRuns(`v${round}`, "a.yml"), true, "the last writer's answers are in the file");
      assert.equal(next.hasWorkflowRuns(`v${round}`, "b.yml"), false);
      assert.equal(next.hasRuns(`v${round}`), false);
    }
    assert.deepEqual(daemon.save(), { ok: true, written: false }, "a store with no new answer writes nothing");
    assert.deepEqual(fs.readdirSync(join(stateDir, "cache")), ["fleet-state-commits.json"]);
    // The hard limit holds for a caller that never calls retain.
    for (let n = 0; n < 200; n++) daemon.setChangedFiles(`n${n}`, ["src/example.ts"]);
    daemon.save();
    assert.equal(Object.keys(storedCommits(root)).length, 64);
    daemon.retain(["n199"]);
    daemon.save();
    assert.deepEqual(storedCommits(root), { n199: { files: ["src/example.ts"] } });
  });
}
