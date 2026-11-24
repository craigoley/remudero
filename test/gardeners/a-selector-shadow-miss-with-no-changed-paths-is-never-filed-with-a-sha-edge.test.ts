import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SELECTOR_SHADOW_MISS_TEST_PATH,
  SELECTOR_SHADOW_SHARDS,
  readSelectorShadowChangedPaths,
  resolveSelectorShadowPullFromHead,
  runSelectorShadowGardener,
  selectorShadowMissTask,
  selectorShadowStructuralTask,
  type SelectorShadowRun,
} from "#src/lib/selector-shadow-gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const TEST_FILE = "test/cold-status-reads-return-within-the-client-budget.test.ts";
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const BASE = "b".repeat(40);

/** A complete eight-shard run whose first shard failed TEST_FILE and whose narrow selector missed it. */
function missedRun(id: number, extra: Partial<SelectorShadowRun> = {}): SelectorShadowRun {
  const record = { fullRun: false, floorSize: 1, narrowSize: 0, failures: [{ file: TEST_FILE, floor: "selected", narrow: "missed" }] };
  const log = Array.from({ length: SELECTOR_SHADOW_SHARDS }, (_, shard) =>
    `coverage-shard (${shard + 1}/8)\tAFFECTED-SUITES-SHADOW: ${JSON.stringify(shard === 0 ? record : { ...record, failures: [] })}\n` +
    `coverage-shard (${shard + 1}/8)\tSELECTOR-SHADOW-JOB: conclusion=${shard === 0 ? "failure" : "success"}`,
  ).join("\n");
  return { id, headSha: sha(id), log, ...extra };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-unreplayable-`));
  for (const owner of ["src/lib/affected-suites.ts", SELECTOR_SHADOW_MISS_TEST_PATH]) {
    mkdirSync(join(root, owner, ".."), { recursive: true });
    writeFileSync(join(root, owner), "// fixture\n");
  }
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps = {
    stateDir: join(root, "state"),
    repoRoot: root,
    openWorkspace: () => ({
      root,
      branch: "selector-shadow-garden-test",
      land: (opts: { paths: string[]; title: string; body: string }) => (landed.push(opts), `https://github.com/acme/remudero/pull/${100 + landed.length}`),
      dispose: () => {},
    }),
    log: (step: string, extra?: Record<string, unknown>) => { events.push({ step, extra }); },
  };
  let minted = 0;
  const mint = () => `W1-T90${String(++minted).padStart(2, "0")}`;
  const rows = (step: string) => events.filter((e) => e.step === step).map((e) => e.extra);
  const state = () => JSON.parse(readFileSync(join(root, "state", "selector-shadow-gardener.json"), "utf8")) as
    { edges: Record<string, string[]>; filedKeys: string[] };
  const filed = (n: number) => readFileSync(join(root, landed[n]!.paths[0]!), "utf8");
  return { root, landed, events, deps, mint, rows, state, filed };
}

/** A GitHub reader that answers commits/<head>/pulls from `pulls` and compare/<base>...<head> from `files`. */
function github(pulls: Record<string, unknown[]>, files: string[] | Error) {
  const calls: string[][] = [];
  const readJson = (args: string[]): unknown => {
    calls.push(args);
    const route = args[1]!;
    const pullsFor = /\/commits\/([0-9a-f]+)\/pulls$/.exec(route)?.[1];
    if (pullsFor !== undefined) return pulls[pullsFor] ?? [];
    if (/\/compare\//.test(route)) {
      if (files instanceof Error) throw files;
      return { files: files.map((filename) => ({ filename })) };
    }
    throw new Error(`unexpected read ${route}`);
  };
  return { calls, readJson };
}

const reader = (gh: ReturnType<typeof github>) => (miss: Parameters<typeof readSelectorShadowChangedPaths>[2]) =>
  readSelectorShadowChangedPaths("acme", "remudero", miss, gh.readJson);

const openPull = (number: number, base = BASE) => ({ number, state: "open", merged_at: null, base: { sha: base } });

test("W1-T13526 criterion 1: a run with no base resolves its pull request and base from the head commit and files path edges", async () => {
  const baseless = harness();
  const gh = github({ [sha(1)]: [openPull(7)] }, ["src/lib/status.ts", "src/lib/board.ts"]);
  await runSelectorShadowGardener(baseless.deps, () => [missedRun(1)], reader(gh), baseless.mint, () => []);
  assert.deepEqual(gh.calls.map((c) => c[1]), [
    `repos/acme/remudero/commits/${sha(1)}/pulls`,
    `repos/acme/remudero/compare/${BASE}...${sha(1)}`,
  ], "the head commit is looked up once, then compared through the base it names");
  assert.equal(baseless.landed.length, 1, "a resolved miss files");
  const resolved = baseless.filed(0);
  assert.match(resolved, new RegExp(`src/lib/status\\.ts, src/lib/board\\.ts -> ${TEST_FILE.replaceAll(".", "\\.")}`));
  assert.deepEqual(baseless.state().edges[TEST_FILE], [`src/lib/status.ts, src/lib/board.ts -> ${TEST_FILE}`]);

  // The same run carrying its base from the listing files the same edges.
  const based = harness();
  const direct = github({}, ["src/lib/status.ts", "src/lib/board.ts"]);
  await runSelectorShadowGardener(based.deps, () => [missedRun(1, { baseSha: BASE, prNumber: 7 })], reader(direct), based.mint, () => []);
  assert.deepEqual(direct.calls.map((c) => c[1]), [`repos/acme/remudero/compare/${BASE}...${sha(1)}`], "a run with a base needs no lookup");
  assert.deepEqual(based.state().edges, baseless.state().edges);
});

test("W1-T13526 criterion 1: only one open or merged pull request resolves a head commit", async () => {
  const merged = { number: 9, state: "closed", merged_at: "2026-11-17T00:00:00Z", base: { sha: BASE } };
  const closed = { number: 8, state: "closed", merged_at: null, base: { sha: "c".repeat(40) } };
  assert.deepEqual(await resolveSelectorShadowPullFromHead("o", "r", sha(1), () => [merged]), { baseSha: BASE, prNumber: 9 });
  assert.deepEqual(await resolveSelectorShadowPullFromHead("o", "r", sha(1), () => [closed, openPull(7)]), { baseSha: BASE, prNumber: 7 },
    "a closed unmerged pull request never counts");
  for (const [label, pulls] of [["none", []], ["closed only", [closed]], ["two", [openPull(7), merged]], ["no base", [{ number: 7, state: "open" }]]] as const) {
    const answer = await resolveSelectorShadowPullFromHead("o", "r", sha(1), () => pulls);
    assert.ok("reason" in answer, `${label} leaves the head unresolved`);
  }
  await assert.rejects(resolveSelectorShadowPullFromHead("o", "r", sha(1), () => ({ message: "Not Found" })), /no pull request list/);
});

test("W1-T13526 criterion 2: a baseless miss that stays unresolved files nothing, stores no edge and is ledgered unreplayable", async () => {
  const h = harness();
  const gh = github({}, ["never read"]);
  await runSelectorShadowGardener(h.deps, () => [missedRun(1)], reader(gh), h.mint, () => []);
  assert.equal(h.landed.length, 0, "no task is filed on a head sha");
  const [row] = h.rows("selector-shadow.edge_unreplayable");
  assert.equal(row?.ci_run_id, 1);
  assert.equal(row?.head_sha, sha(1));
  assert.equal(row?.file, TEST_FILE);
  assert.match(String(row?.reason), /no open or merged pull request carries/);
  assert.equal(h.rows("selector-shadow.edge_unreplayable").length, 1);
  assert.deepEqual(h.state().edges, {}, "no edge is stored");
  // The row is per run and suite: the next pass does not ledger it again.
  await runSelectorShadowGardener(h.deps, () => [missedRun(1)], reader(gh), h.mint, () => []);
  assert.equal(h.rows("selector-shadow.edge_unreplayable").length, 1);
  assert.equal(h.landed.length, 0);
});

test("W1-T13526 criterion 2: an unreadable compare is unreplayable and the next replayable miss still files", async () => {
  const h = harness();
  const gh = github({ [sha(1)]: [openPull(7)], [sha(2)]: [openPull(8)] }, new Error("compare unavailable"));
  await runSelectorShadowGardener(h.deps, () => [missedRun(1)], reader(gh), h.mint, () => []);
  assert.equal(h.landed.length, 0);
  assert.match(String(h.rows("selector-shadow.edge_unreplayable")[0]?.reason), /compare unavailable/);
  const ok = github({ [sha(2)]: [openPull(8)] }, ["src/lib/status.ts"]);
  await runSelectorShadowGardener(h.deps, () => [missedRun(1), missedRun(2)], reader(ok), h.mint, () => []);
  assert.equal(h.landed.length, 1, "a miss left unfiled by an unreadable one does not hold the pass");
  assert.match(h.filed(0), /src\/lib\/status\.ts -> /);
});

test("W1-T13526 criterion 2: a miss past the per-pass read bound is ledgered unreplayable and read again next pass", async () => {
  const h = harness();
  const plan = [{ id: "W1-T4715", origin: `selector-shadow-miss:${TEST_FILE}`, status: "queued" }];
  const runs = Array.from({ length: 10 }, (_, i) => missedRun(i + 1));
  let reads = 0;
  const read = () => ["src/lib/status.ts"].map((p) => (reads++, p));
  await runSelectorShadowGardener(h.deps, () => runs, read, h.mint, () => plan);
  assert.equal(reads, 8, "the pass reads at most eight changed-path lists");
  const spent = h.rows("selector-shadow.edge_unreplayable");
  assert.deepEqual(spent.map((r) => r?.ci_run_id), [9, 10]);
  assert.match(String(spent[0]?.reason), /read bound/);
  await runSelectorShadowGardener(h.deps, () => runs, read, h.mint, () => plan);
  assert.equal(reads, 10, "the two unread misses are read on the next pass");
  assert.equal(h.rows("selector-shadow.miss_evidence").length, 10);
});

test("W1-T13526 criterion 2: neither task builder writes a sha in an edge's place", () => {
  const miss = { runId: 5, headSha: sha(5), selection: "narrow" as const, file: TEST_FILE };
  const narrow = selectorShadowMissTask(miss, "W1-T9101");
  assert.ok(!narrow.includes(`${miss.headSha} -> `), "the narrow task names no sha edge");
  assert.match(narrow, new RegExp(`no changed path recorded -> ${TEST_FILE.replaceAll(".", "\\.")}`));
  const withPath = selectorShadowMissTask(miss, "W1-T9102", ["src/lib/status.ts"]);
  assert.match(withPath, /src\/lib\/status\.ts -> /);
  const structural = selectorShadowStructuralTask(TEST_FILE, "W1-T9103", [`src/lib/status.ts -> ${TEST_FILE}`], "W1-T9101");
  assert.ok(!structural.includes(miss.headSha));
});

test("W1-T13526 criterion 2: a sha edge already in the state is dropped when the state is read, and a suite with no path edge gets no structural task", async () => {
  const h = harness();
  writeFileSync(join(h.root, "state", "selector-shadow-gardener.json"), JSON.stringify({
    filedKeys: [], causes: { [TEST_FILE]: "W1-T9001" }, structural: {},
    edges: { [TEST_FILE]: [`${sha(77)} -> ${TEST_FILE}`], "test/other.test.ts": [`${sha(78)} -> test/other.test.ts`, "src/a.ts -> test/other.test.ts"] },
  }));
  await runSelectorShadowGardener(h.deps, () => [], () => [], h.mint, () => []);
  assert.deepEqual(h.state().edges, { "test/other.test.ts": ["src/a.ts -> test/other.test.ts"] }, "only the path edge survives");
  // The narrow repair merged, the suite is missed again, and its changed paths cannot be read: no structural task.
  const merged = [{ id: "W1-T9001", origin: `selector-shadow-miss:${TEST_FILE}`, status: "done" }];
  const gh = github({}, []);
  await runSelectorShadowGardener(h.deps, () => [missedRun(2)], reader(gh), h.mint, () => merged);
  assert.equal(h.landed.length, 0, "no structural task is filed from a sha");
  assert.equal(h.rows("selector-shadow.structural_filed").length, 0);
  assert.equal(h.rows("selector-shadow.edge_unreplayable").length, 1);
  // Once a path edge is read, the structural task files naming path edges only.
  const ok = github({ [sha(3)]: [openPull(3)] }, ["src/lib/board.ts"]);
  await runSelectorShadowGardener(h.deps, () => [missedRun(3)], reader(ok), h.mint, () => merged);
  assert.equal(h.landed.length, 1);
  const contents = h.filed(0);
  assert.match(contents, /selector-shadow-structural:/);
  assert.match(contents, /src\/lib\/board\.ts -> /);
  assert.ok(!contents.includes(sha(77)) && !contents.includes(sha(3) + " ->"));
});

test("W1-T13526 criterion 3: a replayable miss files as it does today and a later miss of the filed suite is ledgered as evidence", async () => {
  const h = harness();
  const paths: Record<string, string[]> = { [sha(1)]: ["src/lib/status.ts"], [sha(2)]: ["src/lib/board.ts"] };
  const read = (miss: { headSha: string }) => paths[miss.headSha]!;
  await runSelectorShadowGardener(h.deps, () => [missedRun(1, { baseSha: BASE, prNumber: 7 })], read, h.mint, () => []);
  assert.equal(h.landed.length, 1);
  const contents = h.filed(0);
  assert.match(contents, /origin: "selector-shadow-miss:test\/cold-status-reads/);
  assert.match(contents, new RegExp(`src/lib/status\\.ts -> ${TEST_FILE.replaceAll(".", "\\.")}`));
  assert.match(contents, new RegExp(`base ${BASE}, PR #7`));
  assert.match(contents, /proof: "unit test: W1-T9001: the selector covers the recorded suite for every recorded edge"/);
  assert.match(contents, /proof: "unit test: W1-T9001: the shadow record reads the recorded suite as selected for every recorded edge"/);
  assert.deepEqual(h.rows("selector-shadow.miss_filed").map((r) => r?.edge), [`src/lib/status.ts -> ${TEST_FILE}`]);
  await runSelectorShadowGardener(h.deps, () => [missedRun(1, { baseSha: BASE, prNumber: 7 }), missedRun(2, { baseSha: BASE, prNumber: 8 })], read, h.mint, () => []);
  assert.equal(h.landed.length, 1, "a later miss files nothing");
  assert.deepEqual(h.rows("selector-shadow.miss_evidence").map((r) => [r?.task_id, r?.file, r?.pr]), [["W1-T9001", TEST_FILE, 8]]);
  assert.deepEqual(h.state().edges[TEST_FILE], [`src/lib/status.ts -> ${TEST_FILE}`, `src/lib/board.ts -> ${TEST_FILE}`]);
  assert.equal(h.rows("selector-shadow.edge_unreplayable").length, 0);
});
