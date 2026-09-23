/**
 * test/the-knowledge-base-tends-itself.test.ts — W1-T4095, the knowledge gardener.
 *
 * Nothing pruned, merged or retired knowledge unless a person did it, and nothing measured whether
 * the knowledge base was getting better. The gardener inventories every knowledge surface, takes
 * tiered, reversible actions through one reviewed PR per pass, writes a scorecard, and learns which
 * of its own action classes help.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { runDaemon } from "../src/lib/daemon.js";
import {
  appendGardenLog,
  applyLearningActions,
  cheapFingerprint,
  gardenPrState,
  duplicateLearningPairs,
  GARDEN_LOG,
  gardenerStatePath,
  gardenMarker,
  initialGardenerState,
  judgePending,
  planGardenPass,
  readGardenerState,
  retireCandidates,
  runGardenPass,
  startKnowledgeGardener,
  type GardenerState,
  type GardenWorkspace,
} from "../src/lib/knowledge-gardener.js";
import { buildKnowledgeInventory, danglingWhyPointers, inventoryTotals } from "../src/lib/knowledge-inventory.js";
import { learningUsagePath, seededRandom } from "../src/lib/knowledge-value.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { loadPlan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { knowledgeGardenWorkspace, type RunResult } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const DUP_A = "A worker that reads the ledger must read the union of every rotation, because compaction prunes the live file and a live-only read undercounts badly.";
const DUP_B = "A worker that reads the ledger must read the union of every rotation, because compaction prunes the live file and a live-only read undercounts.";

function learningsYaml(entries: Array<{ id: string; fact: string; lifecycle?: string }>): string {
  return entries
    .map((e) => [`- id: ${e.id}`, "  subsystem: t", `  lifecycle: ${e.lifecycle ?? "active"}`, "  files: [src/x.ts]", "  fact: >-", `    ${e.fact}`, "  src: t", ""].join("\n"))
    .join("\n");
}

/** A small repo holding every knowledge surface. */
function corpus(): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4095-`));
  mkdirSync(join(root, "learnings"), { recursive: true });
  writeFileSync(
    join(root, "learnings", "core.yaml"),
    learningsYaml([
      { id: "ledger-union", fact: DUP_A },
      { id: "ledger-union-again", fact: DUP_B },
      { id: "rarely-used", fact: "The widget cache warms itself on first read of the widget table." },
      { id: "often-used", fact: "A proof must match one physical line of its target file." },
      { id: "retired-already", fact: "An old fact.", lifecycle: "superseded" },
    ]),
  );
  mkdirSync(join(root, "doctrine", "coverage"), { recursive: true });
  writeFileSync(join(root, "doctrine", "coverage", "rule.md"), "- **A rule.** Its body.\n");
  writeFileSync(join(root, "DECISIONS.md"), "# Decisions\n\n## First decision\nWe chose A.\n\n## Second decision\nWe chose B.\n");
  writeFileSync(join(root, "MASTER-PLAN.md"), "# Plan\n\n## Wave 1\nShipped.\n");
  mkdirSync(join(root, "docs", "forensics"), { recursive: true });
  writeFileSync(join(root, "docs", "forensics", "review.md"), "# review\nlong history\n");
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "src", "lib", "a.ts"), "// Why: docs/forensics/review.md#x\n// Why: docs/forensics/gone.md#y\nexport const a = 1;\n");
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

const usageFor = (root: string, usage: Record<string, { offered: number; used: number }>) =>
  writeFileSync(learningUsagePath(join(root, "state")), JSON.stringify(usage));

/** A workspace that is just a copy location on disk: edits happen in `root`, landing records the call. */
function fakeWorkspace(root: string, landed: Array<{ paths: string[]; title: string; body: string }>): () => GardenWorkspace {
  return () => ({
    root,
    refreshAssertions: () => [],
    land: (opts) => {
      landed.push(opts);
      return "https://github.com/acme/remudero/pull/9";
    },
    dispose: () => {},
  });
}

test("W1-T4095: the inventory lists every knowledge surface with its size and readers", () => {
  const root = corpus();
  const memory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4095-mem-`));
  writeFileSync(join(memory, "fact.md"), "---\nname: f\ndescription: d\n---\nA memory.\n");
  writeFileSync(join(memory, "MEMORY.md"), "- [f](fact.md)\n");
  const items = buildKnowledgeInventory(root, { memoryDirs: [memory, join(memory, "missing")] });
  const kinds = new Set(items.map((i) => i.kind));
  assert.deepEqual([...kinds].sort(), ["decision", "doctrine", "forensics", "learning", "memory", "plan"]);
  assert.ok(items.some((i) => i.id === "DECISIONS.md#second-decision"), "decisions are split by section");
  assert.ok(items.every((i) => i.bytes > 0 && i.path.length > 0));
  const totals = inventoryTotals(items);
  assert.equal(totals.learning!.count, 5);
  assert.ok(totals.decision!.largest > 0);
  assert.deepEqual(danglingWhyPointers(root), [{ file: "src/lib/a.ts", line: 2, target: "docs/forensics/gone.md" }]);
  assert.deepEqual(buildKnowledgeInventory(join(root, "nowhere")), [], "an empty checkout inventories nothing");
});

test("W1-T4095: a near-duplicate cluster is merged into one entry, never deleted", () => {
  const root = corpus();
  const items = buildKnowledgeInventory(root);
  const pairs = duplicateLearningPairs(items).map(([n, o]) => [n.id, o.id]);
  assert.deepEqual(pairs, [["learnings#ledger-union-again", "learnings#ledger-union"]]);
  const plan = planGardenPass({ items, usage: {}, state: initialGardenerState(), rng: () => 0.99 });
  const merge = plan.actions.find((a) => a.class === "merge")!;
  const applied = applyLearningActions(join(root, "learnings"), [merge]);
  assert.deepEqual(applied.paths, ["learnings/core.yaml"]);
  const text = readFileSync(join(root, "learnings", "core.yaml"), "utf8");
  assert.match(text, /- id: ledger-union-again\n {2}subsystem: t\n {2}# knowledge gardener: merge ledger-union-again\n {2}lifecycle: superseded\n {2}superseded_by: ledger-union/);
  assert.ok(text.includes(DUP_B.slice(0, 40)), "the merged fact's text is kept");
  assert.match(text, /- id: ledger-union\n {2}subsystem: t\n {2}lifecycle: active/, "the older entry is untouched");
  // The loader still accepts the edited shard.
  assert.equal(buildKnowledgeInventory(root).find((i) => i.id === "learnings#ledger-union-again")?.lifecycle, "superseded");
  assert.deepEqual(applyLearningActions(join(root, "learnings"), [merge]).paths, [], "a second application changes nothing");
});

test("W1-T4095: a low-value entry is demoted and a failing assertion retires its fact", () => {
  const usage = { "rarely-used": { offered: 200, used: 1 }, "often-used": { offered: 50, used: 40 }, "ledger-union": { offered: 40, used: 20 } };
  const ids = ["rarely-used", "often-used", "ledger-union", "never-offered"];
  assert.deepEqual(retireCandidates(usage, ids, seededRandom(1)), ["rarely-used"], "only the clearly-worse-than-typical one");
  assert.deepEqual(retireCandidates({ a: { offered: 3, used: 0 } }, ["a"], seededRandom(1)), [], "one measured entry has no corpus to compare");
  assert.deepEqual(retireCandidates({ a: { offered: 2, used: 0 }, b: { offered: 2, used: 1 } }, ["a", "b"], seededRandom(1)), [], "thin evidence retires nothing");
  // The pass supersedes the retired learning and runs the assertion refresh in the workspace.
  const root = corpus();
  usageFor(root, usage);
  // Only retire may act this pass, so its effect is attributable; refresh is exercised on its own below.
  writeFileSync(join(root, "state", "KNOWLEDGE_OFF-merge"), "");
  writeFileSync(join(root, "state", "KNOWLEDGE_OFF-refresh"), "");
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  let refreshed = 0;
  const ws = fakeWorkspace(root, landed);
  const result = runGardenPass({
    stateDir: join(root, "state"),
    repoRoot: root,
    openWorkspace: () => ({ ...ws(), refreshAssertions: () => (refreshed++, ["learnings/core.yaml"]) }),
    log: () => {},
    seed: 3,
  });
  assert.ok(result.ran);
  assert.deepEqual(result.plan?.acting, ["retire"]);
  assert.match(readFileSync(join(root, "learnings", "core.yaml"), "utf8"), /# knowledge gardener: retire rarely-used\n {2}lifecycle: superseded/);
  // Refresh alone: the assertion re-check runs in the workspace.
  const other = corpus();
  writeFileSync(join(other, "state", "KNOWLEDGE_OFF-merge"), "");
  writeFileSync(join(other, "state", "KNOWLEDGE_OFF-retire"), "");
  const w2 = fakeWorkspace(other, []);
  runGardenPass({ stateDir: join(other, "state"), repoRoot: other, openWorkspace: () => ({ ...w2(), refreshAssertions: () => (refreshed++, []) }), log: () => {}, seed: 3 });
  assert.equal(refreshed, 1, "the refresh action re-ran assertions");
});

test("W1-T4095: each pass writes a scorecard and an action class that hurt is taken less", () => {
  const base = initialGardenerState();
  const pending = (p: Partial<NonNullable<GardenerState["pending"]>> = {}): GardenerState => ({
    ...base,
    pending: { prUrl: "u", actionClass: "retire", baseline: { offered: 100, used: 40 }, ...p },
  });
  // A closed, unmerged PR is a debit; an open one waits; nothing pending is nothing to judge.
  assert.deepEqual(judgePending(pending(), { offered: 100, used: 40 }, "closed").state.classes.retire, { alpha: 3, beta: 2 });
  assert.equal(judgePending(pending(), { offered: 100, used: 40 }, "open").verdict, "waiting");
  assert.equal(judgePending(base, { offered: 1, used: 1 }, "merged").verdict, "none");
  // Merged: the first look snapshots, and the verdict waits for evidence gathered after the merge.
  const snap = judgePending(pending(), { offered: 100, used: 40 }, "merged");
  assert.equal(snap.verdict, "waiting");
  assert.deepEqual(snap.state.pending?.atMerge, { offered: 100, used: 40 });
  assert.equal(judgePending(snap.state, { offered: 100, used: 40 }, "merged").verdict, "waiting", "no new offers yet");
  // A change inside the noise keeps waiting; a clear rise credits; a clear fall debits.
  assert.equal(judgePending(snap.state, { offered: 110, used: 44 }, "merged").verdict, "waiting");
  const rose = judgePending(snap.state, { offered: 200, used: 110 }, "merged");
  assert.equal(rose.verdict, "credit");
  assert.deepEqual(rose.state.classes.retire, { alpha: 4, beta: 1 });
  assert.equal(rose.state.pending, undefined);
  assert.equal(judgePending(snap.state, { offered: 200, used: 50 }, "merged").verdict, "debit");
  assert.equal(judgePending(pending({ baseline: { offered: 0, used: 0 }, atMerge: { offered: 0, used: 0 } }), { offered: 50, used: 45 }, "merged").verdict, "credit", "no baseline: judged against even odds");

  // A class with a poor record acts less often than one with a good record — and only one class acts a pass.
  const state: GardenerState = { ...base, classes: { ...base.classes, merge: { alpha: 1, beta: 12 } } };
  const root = corpus();
  const items = buildKnowledgeInventory(root);
  const rng = seededRandom(5);
  let mergeActs = 0;
  let refreshActs = 0;
  for (let k = 0; k < 300; k++) {
    const plan = planGardenPass({ items, usage: {}, state, rng });
    assert.ok(plan.acting.length <= 1, "one class per pass");
    if (plan.acting[0] === "merge") mergeActs++;
    if (plan.acting[0] === "refresh") refreshActs++;
  }
  assert.ok(mergeActs < refreshActs / 5, `merge acted ${mergeActs}, refresh ${refreshActs}`);
  // An off switch silences a class entirely.
  const off = planGardenPass({ items, usage: {}, state: base, rng: () => 0.99, switchedOff: (c) => c !== "refresh" });
  assert.deepEqual(off.acting, ["refresh"]);
  // A pass logs its scorecard.
  usageFor(root, { "often-used": { offered: 10, used: 5 } });
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  runGardenPass({ stateDir: join(root, "state"), repoRoot: root, openWorkspace: fakeWorkspace(root, []), log: (s, e) => rows.push([s, e]), seed: 1 });
  const card = rows.find(([s]) => s === "knowledge.scorecard")?.[1];
  assert.equal(card?.usedShare, 0.5);
  assert.equal(card?.danglingPointers, 1);
  assert.ok((card?.totals as Record<string, unknown>).learning);
  const heaviest = card?.heaviest as Array<{ id: string; shareOfKind: number }>;
  assert.ok(heaviest.length > 0 && heaviest.every((h, i) => i === 0 || heaviest[i - 1]!.shareOfKind >= h.shareOfKind), "ranked by share of kind");
});

test("W1-T4095: a pass lands its changes as one reviewed PR", () => {
  const root = corpus();
  writeFileSync(join(root, "state", "KNOWLEDGE_OFF-refresh"), "");
  writeFileSync(join(root, "state", "KNOWLEDGE_OFF-retire"), "");
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const first = runGardenPass({
    stateDir: join(root, "state"),
    repoRoot: root,
    openWorkspace: fakeWorkspace(root, landed),
    log: () => {},
    seed: 1,
    clock: fixedClock(Date.parse("2026-09-23T03:00:00.000Z")),
  });
  assert.equal(first.prUrl, "https://github.com/acme/remudero/pull/9");
  assert.equal(landed.length, 1, "one PR per pass");
  assert.deepEqual(landed[0]!.paths, [GARDEN_LOG, "learnings/core.yaml"]);
  assert.match(landed[0]!.title, /^chore\(knowledge\): /);
  assert.ok(landed[0]!.paths.every((p) => !p.startsWith("src/")), "the gardener never edits code");
  // The body's proofs name text only this pass wrote.
  assert.match(landed[0]!.body, /proof: grep: \^## Pass 2026-09-23T03:00:00\.000Z\$ in docs\/knowledge-garden-log\.md/);
  assert.match(landed[0]!.body, /proof: grep: knowledge gardener: merge ledger-union-again\$ in learnings\/core\.yaml/);
  assert.match(readFileSync(join(root, GARDEN_LOG), "utf8"), /## Pass 2026-09-23T03:00:00\.000Z\n\n- merge ledger-union-again into ledger-union/);
  // Nothing changed since: the next tick reads the modification times and stops there.
  const again = runGardenPass({ stateDir: join(root, "state"), repoRoot: root, openWorkspace: () => { throw new Error("must not open"); }, log: () => {} });
  assert.equal(again.ran, false);
  assert.equal(readGardenerState(gardenerStatePath(join(root, "state"))).lastCheap, cheapFingerprint(root, join(root, "state")));
  // The merge now awaits its PR's outcome: while the PR is open, a changed corpus opens no second PR.
  assert.equal(readGardenerState(gardenerStatePath(join(root, "state"))).pending?.actionClass, "merge");
  writeFileSync(join(root, "DECISIONS.md"), "# Decisions\n\n## Changed\nYes.\n");
  const waiting = runGardenPass({ stateDir: join(root, "state"), repoRoot: root, openWorkspace: () => { throw new Error("no second PR while one is pending"); }, prState: () => "open", log: () => {} });
  assert.ok(waiting.ran && waiting.plan?.actions.length === 0);
  // Closed without merging: the merge class is debited and the gardener may act again.
  writeFileSync(join(root, "DECISIONS.md"), "# Decisions\n\n## Changed again\nYes.\n");
  const judged: string[] = [];
  runGardenPass({ stateDir: join(root, "state"), repoRoot: root, openWorkspace: fakeWorkspace(root, []), prState: () => "closed", log: (s) => judged.push(s) });
  assert.ok(judged.includes("knowledge.gardener_judged"));
  assert.deepEqual(readGardenerState(gardenerStatePath(join(root, "state"))).classes.merge, { alpha: 3, beta: 2 });
});

test("W1-T4095: the daemon starts the gardener beside a busy main loop", async () => {
  const root = corpus();
  writeFileSync(join(root, "tasks.yaml"), "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  let busy = false;
  let passedWhileBusy = false;
  await runDaemon(
    loadPlan(join(root, "tasks.yaml")),
    {
      refreshMerged: () => () => false,
      runOne: async (id): Promise<RunResult> => {
        busy = true;
        // The corpus changes mid-run, so the gardener has something to do on a later tick.
        writeFileSync(join(root, "DECISIONS.md"), "# Decisions\n\n## Third\nWe chose C.\n");
        await new Promise((resolve) => setTimeout(resolve, 150));
        busy = false;
        return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
      },
      knowledgeGardener: {
        stateDir: join(root, "state"),
        repoRoot: root,
        openWorkspace: fakeWorkspace(root, []),
        log: (step) => {
          if (step === "knowledge.scorecard" && busy) passedWhileBusy = true;
        },
      },
      sleep: async () => {},
      log: () => {},
    },
    { headroomEnabled: false, max: 1, pollIntervalMs: 20 },
  );
  assert.equal(passedWhileBusy, true);
});

test("W1-T4095: the gardener's seeded timer survives a failing pass and its state survives a bad file", async () => {
  const root = corpus();
  const rows: string[] = [];
  let calls = 0;
  const pump = startKnowledgeGardener(
    {
      stateDir: join(root, "state"),
      repoRoot: root,
      openWorkspace: () => {
        calls++;
        throw new Error("no worktree");
      },
      log: (s) => rows.push(s),
      // Seeded: with a clock seed about 1 pass in 60 draws no acting class (0.125² that merge and refresh
      // both draw under even odds), opens no workspace, and the assertion below reads a false failure.
      seed: 1,
    },
    10,
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  pump.stop();
  assert.ok(calls >= 1, "the seeded pass acted, so it reached the throwing workspace");
  assert.ok(rows.includes("knowledge.gardener_failed"), "the throw was logged and the timer kept running");
  writeFileSync(gardenerStatePath(join(root, "state")), "{ torn");
  assert.deepEqual(readGardenerState(gardenerStatePath(join(root, "state"))).classes, initialGardenerState().classes);
  writeFileSync(gardenerStatePath(join(root, "state")), "null");
  assert.deepEqual(readGardenerState(gardenerStatePath(join(root, "state"))).classes, initialGardenerState().classes);
  // The log starts itself, and a marker names its action.
  const fresh = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4095-log-`));
  mkdirSync(join(fresh, "docs"));
  appendGardenLog(fresh, new Date("2026-09-23T00:00:00Z"), [{ class: "refresh", target: "", reason: "r" }], {
    usedShare: null,
    totals: {},
    danglingPointers: 0,
    duplicatePairs: 0,
    retireCandidates: 0,
    heaviest: [],
  });
  assert.match(readFileSync(join(fresh, GARDEN_LOG), "utf8"), /# Knowledge garden log[\s\S]*- refresh: r\n\nLearnings used when offered: not measured yet/);
  assert.equal(gardenMarker({ class: "retire", target: "x", reason: "" }), "knowledge gardener: retire x");
  // A log that exists but cannot be read is an error, never silently replaced by a fresh log.
  const blocked = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4095-log2-`));
  mkdirSync(join(blocked, GARDEN_LOG), { recursive: true });
  assert.throws(() => appendGardenLog(blocked, new Date(0), [], { usedShare: 0.5, totals: {}, danglingPointers: 0, duplicatePairs: 0, retireCandidates: 0, heaviest: [] }));
});

test("W1-T4095: the real workspace commits, pushes and opens the PR", () => {
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
  const ws = knowledgeGardenWorkspace({
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
    assert.deepEqual(ws.refreshAssertions(), [], "nothing drifted");
    writeFileSync(join(ws.root, "learnings", "core.yaml"), learningsYaml([{ id: "a", fact: "A fact.", lifecycle: "superseded" }]));
    const url = withLiveWritesAllowed(() => ws.land({ paths: ["learnings/core.yaml"], title: "chore(knowledge): test pass", body: "body" }));
    assert.equal(url, "https://github.com/acme/remudero/pull/42");
    assert.match(origin.git("log", "--oneline", "knowledge-garden-1790000000000"), /chore\(knowledge\): test pass/);
    assert.ok(calls[0]!.join(" ").includes("pulls"), "the PR is opened over REST");
  } finally {
    ws.dispose();
    origin.cleanup();
    seed.cleanup();
    checkout.cleanup();
  }
});

test("W1-T4095: a landed PR's state is read from GitHub, and an unreadable one waits", () => {
  const pr = (body: unknown) => () => body;
  assert.equal(gardenPrState("o", "r", "https://github.com/o/r/pull/7", pr({ merged: true, state: "closed" })), "merged");
  assert.equal(gardenPrState("o", "r", "https://github.com/o/r/pull/7", pr({ merged: false, state: "closed" })), "closed");
  assert.equal(gardenPrState("o", "r", "https://github.com/o/r/pull/7", pr({ merged: false, state: "open" })), "open");
  assert.equal(gardenPrState("o", "r", "not a pr url", pr({})), "unknown");
  assert.equal(gardenPrState("o", "r", "https://github.com/o/r/pull/7", () => { throw new Error("rate limited"); }), "unknown");
});

test("W1-T4095: a pass scores the operator's memory and appends to an existing garden log", () => {
  const root = corpus();
  const memory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4095-mem2-`));
  writeFileSync(join(memory, "MEMORY.md"), "- [gone](gone.md)\n");
  usageFor(root, { "often-used": { offered: 10, used: 4 } });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, GARDEN_LOG), "# Knowledge garden log\n\n## Pass earlier\n");
  writeFileSync(join(root, "state", "KNOWLEDGE_OFF-refresh"), "");
  writeFileSync(join(root, "state", "KNOWLEDGE_OFF-retire"), "");
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  runGardenPass({ stateDir: join(root, "state"), repoRoot: root, memoryDirs: [memory], openWorkspace: fakeWorkspace(root, []), log: (s, e) => rows.push([s, e]), seed: 1 });
  const card = rows.find(([s]) => s === "knowledge.scorecard")?.[1];
  assert.deepEqual(card?.memory, { danglingIndexLines: 1, indexLoad: "ok" });
  const log = readFileSync(join(root, GARDEN_LOG), "utf8");
  assert.match(log, /## Pass earlier\n\n## Pass /, "the new section is appended after the old one");
  assert.match(log, /Learnings used when offered: 40%/);
});

