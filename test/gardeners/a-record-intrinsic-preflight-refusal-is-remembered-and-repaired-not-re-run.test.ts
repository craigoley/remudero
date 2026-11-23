import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { fixedClock } from "#src/lib/clock.js";
import {
  landTaskFilesAsync, recordIntrinsicRules, rememberedRecordRefusal, type LandTaskFilesOpts, type TaskFileInput,
} from "#src/lib/feedback-landing.js";
import type { GardenCheckout, GardenerDeps } from "#src/lib/gardener.js";
import { gardenLogActionLine, passClaims } from "#src/lib/knowledge-gardener.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { applyQueueJudgeActions, isQueueJudgeNoop, QUEUE_JUDGE_NOOP_STEP, queueJudgeGardenSpec, readShardPriority, type QueueJudgeAction } from "#src/lib/queue-judge-gardener.js";
import { commentOnlyGrepProofRefusal } from "#src/lib/review.js";
import { changedTestGardenActions, testGardenSpec, type TestGardenAction, type TestManifestProbe } from "#src/lib/test-gardener.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = { step: string } & Record<string, unknown>;
type Failure = PlanPrPreflightResult["failures"][number];

const TARGET = { owner: "acme", repo: "remudero" };
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const MEMORY = "state/task-files-landing-refused-blobs.json";
const ID = "W1-T90001";
const PATH = `plan/tasks.d/${ID}-fixture.yaml`;
const shard = (note: string) => `- id: ${ID}\n  repo: remudero\n  origin: fixture:${ID}\n  note: ${note}\n`;
const PROOF = `grep: note: drafted in ${PATH}`;
const input = (note = "drafted"): TaskFileInput => ({ relPath: PATH, content: shard(note), claim: `the task ${ID} is noted`, proof: PROOF });
const red = (...failures: Failure[]): PlanPrPreflightResult => ({ ok: false, failures, unreadable: [] });
const ownProof: Failure = { check: "proof-discrimination", firstLine: `PR-body proof ${JSON.stringify(PROOF)} passes at origin/main too` };
const ownLint: Failure = { check: "lint-plan", firstLine: `${PATH}: ${ID}: design-invariant-proof: the invariant names no proof` };

/** A public origin whose main holds the record, a clone the landing runs in, and a preflight that counts its runs. */
function world(t: TestContext) {
  const stateRoot = mkdtempSync(join(tmpdir(), "rmd-w1-t13987-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const origin = gitRepo({ scope: t, bare: true, kind: "w1-t13987-origin" });
  const author = gitRepo({ scope: t, cloneFrom: origin.dir, kind: "w1-t13987-author" });
  const commit = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(author.dir, path, ".."), { recursive: true });
      writeFileSync(join(author.dir, path), content);
    }
    author.git("add", "-A");
    author.git("commit", "--quiet", "-m", "chore: move main");
    author.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  };
  commit({ "plan/tasks.yaml": "[]\n", [PATH]: shard("on main"), "world.txt": stateRoot });
  const repo = gitRepo({ scope: t, cloneFrom: origin.dir, kind: "w1-t13987-repo" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  const rows: Row[] = [];
  const runs = { record: 0, base: 0 };
  const verdicts: { record: PlanPrPreflightResult; base: PlanPrPreflightResult | (() => never) } = { record: GREEN, base: GREEN };
  const options: LandTaskFilesOpts = {
    stateRoot, targetRepository: TARGET, stageOnly: true, clock: fixedClock(Date.parse("2026-11-23T10:00:00.000Z")),
    log: (step, fields = {}) => void rows.push({ step, ...fields }),
    gh: () => "[]",
    planPrPreflight: async (_sha, pr) => {
      if (pr.body.includes(PROOF)) {
        runs.record++;
        return verdicts.record;
      }
      runs.base++;
      return typeof verdicts.base === "function" ? verdicts.base() : verdicts.base;
    },
  };
  let moves = 0;
  return {
    stateRoot, rows, runs, verdicts, options,
    moveMain: () => commit({ [`notes/move-${moves++}.txt`]: "main moved\n" }),
    land: (inputs: TaskFileInput[], land = landTaskFilesAsync) => withLiveWritesAllowed(() => land(repo.dir, inputs, options)),
    remembered: () => rows.filter((r) => r.step === "task_files_landing.refusal_remembered"),
    memory: () => JSON.parse(readFileSync(join(stateRoot, MEMORY), "utf8")) as Record<string, { path: string; rules: string[] }>,
  };
}

/** A fresh instance of the landing module: a daemon restart, with the in-process tree memory empty. */
async function restartedLanding(n: number): Promise<typeof landTaskFilesAsync> {
  const href = `${pathToFileURL(join(REPO_ROOT, "src/lib/feedback-landing.ts")).href}?restart=w1-t13987-${n}`;
  return ((await import(href)) as { landTaskFilesAsync: typeof landTaskFilesAsync }).landTaskFilesAsync;
}

/** grep exactly as check-proof's executor runs it: `grep -arn -- <pattern> <path>`; true when a line matches. */
function grepHits(pattern: string, file: string): boolean {
  try {
    execFileSync("grep", ["-arn", "--", pattern, file], { stdio: "pipe" });
    return true;
  } catch {
    // deliberate: grep exits 1 for no match, which is the answer this helper gives as false.
    return false;
  }
}
const proofParts = (proof: string): { pattern: string; path: string } => {
  const m = /^grep: (.*) in (\S+)$/.exec(proof);
  assert.ok(m, `a grep proof: ${proof}`);
  return { pattern: m[1]!, path: m[2]! };
};
/** Where a drafted grep proof lands: true at head, false at base, and never a comment-only match. */
function assertMissesAtBase(proof: string, base: Record<string, string>, head: Record<string, string>, t: TestContext): void {
  const { pattern, path } = proofParts(proof);
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t13987-proof-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const at = (tree: Record<string, string>, side: string) => {
    const file = join(dir, side, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, tree[path] ?? "");
    return file;
  };
  assert.equal(grepHits(pattern, at(head, "head")), true, `${proof} passes at head`);
  assert.equal(grepHits(pattern, at(base, "base")), false, `${proof} misses at base`);
  assert.equal(commentOnlyGrepProofRefusal(proof, (rel) => head[rel]), undefined, `${proof} matches a data line, not only a comment`);
}

// ── the task-files landing remembers a refusal of the record's own bytes ──

test("W1-T13987 criterion 1: a record-intrinsic refusal is remembered by blob and answered from memory across a move of main and a restart", async (t) => {
  const w = world(t);
  w.verdicts.record = red(ownProof);
  const first = await w.land([input()]);
  assert.equal(w.runs.record, 1);
  assert.deepEqual(first.refused.map((r) => [r.path, r.rules, r.remembered_at]), [[PATH, ["proof-discrimination"], undefined]]);
  assert.deepEqual(w.remembered().map((r) => [r.path, r.rule]), [[PATH, "proof-discrimination"]], "one row per blob and rule");
  const [blob] = Object.keys(w.memory());
  assert.match(blob!, /^[0-9a-f]{40}$/, "the memory is keyed by the record's blob sha, not a tree sha");
  assert.deepEqual(rememberedRecordRefusal(w.stateRoot, PATH, blob!)?.rules, ["proof-discrimination"]);
  assert.equal(rememberedRecordRefusal(w.stateRoot, "plan/tasks.d/other.yaml", blob!), undefined, "the memory is the path's as well as the blob's");

  w.moveMain();
  const afterMove = await w.land([input()]);
  assert.equal(w.runs.record, 1, "a move of main does not run the same refusal again");
  assert.deepEqual(afterMove.refused.map((r) => [r.reason, r.failures, r.rules, r.remembered_at, r.mainRed]), [[first.refused[0]!.reason, [ownProof], ["proof-discrimination"], "2026-11-23T10:00:00.000Z", false]]);

  const restarted = await restartedLanding(1);
  w.moveMain();
  const afterRestart = await w.land([input()], restarted);
  assert.equal(w.runs.record, 1, "a restart does not run it again either");
  assert.deepEqual(afterRestart.refused.map((r) => r.rules), [["proof-discrimination"]]);
  assert.equal(w.remembered().length, 1, "a remembered refusal writes no second row");

  // Other bytes at the same path are new bytes: their preflight runs.
  w.verdicts.record = GREEN;
  const edited = await w.land([input("redrafted")]);
  assert.equal(w.runs.record, 2);
  assert.deepEqual(edited.refused, []);
});

test("W1-T13987 criterion 1: a lint-plan failure naming the record's id is remembered, and the memory keeps its newest blobs", async (t) => {
  const w = world(t);
  mkdirSync(join(w.stateRoot, "state"), { recursive: true });
  const seeded = Object.fromEntries(Array.from({ length: 2048 }, (_, i) => [`seed-${i}`, { path: "x", blob: `seed-${i}`, rules: ["lint-plan"], failures: [], first_refused_at: "2026-11-01T00:00:00.000Z" }]));
  writeFileSync(join(w.stateRoot, MEMORY), JSON.stringify(seeded));
  w.verdicts.record = red(ownLint, ownProof);
  const result = await w.land([input()]);
  assert.deepEqual(result.refused[0]!.rules, ["lint-plan", "proof-discrimination"]);
  assert.deepEqual(w.remembered().map((r) => r.rule), ["lint-plan", "proof-discrimination"]);
  const memory = w.memory();
  assert.equal(Object.keys(memory).length, 2048, "the memory is bounded");
  assert.equal(memory["seed-0"], undefined, "the oldest blob goes first");
  w.moveMain();
  await w.land([input()]);
  assert.equal(w.runs.record, 1);
});

// ── a refusal main may have caused is never remembered ──

test("W1-T13987 criterion 2: a main-caused, timed-out, unreadable or unnamed refusal is retried when main moves", async (t) => {
  const cases: Array<[string, PlanPrPreflightResult, PlanPrPreflightResult | (() => never)]> = [
    ["main alone has the same lint-plan red", red(ownLint), red({ check: "lint-plan", firstLine: "W1-T5: sizing" })],
    ["the preflight timed out", { ...red(ownLint), timedOut: [{ check: "shard-census", firstLine: "timed out after 1 ms" }] }, GREEN],
    ["a check could not be read", { ...red(ownProof), unreadable: [{ check: "task-id-existence", firstLine: "could not read declared plan ids at base" }] }, GREEN],
    ["the failure names no line of the record", red({ check: "lint-plan", firstLine: "W1-T5: needs-input" }), GREEN],
    ["the check is not the record's", red({ check: "shard-census", firstLine: `baseline growth in ${ID}` }), GREEN],
    ["the probe of main cannot run", red(ownLint), () => { throw new Error("main cannot be preflighted"); }],
    ["main's probe timed out", red(ownLint), { ...GREEN, timedOut: [{ check: "lint-plan", firstLine: "timed out" }] }],
  ];
  for (const [why, record, base] of cases) {
    const w = world(t);
    w.verdicts.record = record;
    w.verdicts.base = base;
    const first = await w.land([input()]);
    assert.equal(first.refused.length, 1, why);
    assert.equal(first.refused[0]!.rules, undefined, why);
    assert.deepEqual(w.remembered(), [], why);
    assert.equal(existsSync(join(w.stateRoot, MEMORY)), false, why);
    w.moveMain();
    await w.land([input()]);
    assert.equal(w.runs.record, 2, `${why}: the refusal runs again once main moves`);
  }
});

test("W1-T13987 criterion 2: an unreadable memory is no memory, and the record-intrinsic test reads failure lines, never a check name alone", async (t) => {
  for (const text of ["{ not json", "[]", JSON.stringify({ [`${"0".repeat(40)}`]: { path: PATH, rules: [], failures: [] } })]) {
    const w = world(t);
    mkdirSync(join(w.stateRoot, "state"), { recursive: true });
    writeFileSync(join(w.stateRoot, MEMORY), text);
    assert.equal(rememberedRecordRefusal(w.stateRoot, PATH, "0".repeat(40)), undefined, text);
    await w.land([input()]);
    assert.equal(w.runs.record, 1, `${text}: the preflight runs`);
  }
  const record = { content: shard("drafted"), proof: PROOF };
  assert.deepEqual(recordIntrinsicRules([ownLint], record, []), ["lint-plan"]);
  assert.equal(recordIntrinsicRules([], record, []), undefined, "no failure is nothing to remember");
  assert.equal(recordIntrinsicRules([ownLint, ownProof], record, [{ check: "lint-plan", firstLine: `${ID}: already red on main` }]), undefined, "a violation main already carries is not the record's");
  assert.deepEqual(recordIntrinsicRules([ownLint], record, [{ check: "lint-plan", firstLine: "W1-T5: another record" }]), ["lint-plan"], "main's red on another record leaves this one the record's");
  assert.equal(recordIntrinsicRules([ownLint], { content: "- note: no id\n", proof: PROOF }, []), undefined, "a record with no id names no line");
  assert.deepEqual(recordIntrinsicRules([{ check: "lint-plan", firstLine: "lint failed", lines: ["lint failed", `${ID}: sizing`] }], record, []), ["lint-plan"], "the detail lines count");
  assert.deepEqual(recordIntrinsicRules([{ check: "lint-plan", firstLine: "lint failed", task_ids: [ID] }], record, []), ["lint-plan"], "the task ids count");
  const withShardProof = { ...record, content: `${record.content}  acceptance:\n    - claim: c\n      proof: "grep: origin: fixture in x"\n` };
  assert.deepEqual(recordIntrinsicRules([{ check: "proof-discrimination", firstLine: `shard proof ${JSON.stringify("grep: origin: fixture in x")} passes at origin/main too` }], withShardProof, []), ["proof-discrimination"], "a shard proof in the record's own text");
  assert.equal(recordIntrinsicRules([{ check: "proof-discrimination", firstLine: `PR-body proof ${JSON.stringify("grep: other in y")} fails on this tree` }], record, []), undefined, "another record's proof");
  assert.equal(recordIntrinsicRules([{ check: "proof-discrimination", firstLine: "the changed task shards could not be read" }], record, []), undefined, "a line that names no proof");
  assert.equal(recordIntrinsicRules([{ check: "proof-discrimination", firstLine: 'PR-body proof "\\x" fails' }], record, []), undefined, "a quoted span that is not JSON names no proof");
  assert.equal(recordIntrinsicRules([{ check: "proof-discrimination", firstLine: 'PR-body proof "unterminated' }], record, []), undefined, "an unterminated quote names no proof");
  assert.deepEqual(recordIntrinsicRules([{ check: "proof-discrimination", firstLine: `PR-body proof ${JSON.stringify("grep: a \"quoted\" note: drafted in x")} fails` }], { ...record, proof: 'grep: a "quoted" note: drafted in x' }, []), ["proof-discrimination"], "an escaped quote inside the proof");
});

// ── each garden drafts a proof that misses at base ──

const learnings = (entries: string) => `- id: keeper\n  lifecycle: active\n${entries}`;
const SUPERSEDED_ELSEWHERE = "- id: old-lesson\n  lifecycle: superseded\n- id: stale\n  lifecycle: active\n";
const RETIRE = { class: "retire" as const, target: "stale", reason: "rarely used" };
const HEADING = "## Pass 2026-11-23T10:00:00.000Z";
const LOG = "docs/knowledge-garden-log.md";

test("W1-T13987 criterion 3: the knowledge gardener proves its own action when base already ends a line with lifecycle: superseded", (t) => {
  const baseShard = learnings(SUPERSEDED_ELSEWHERE);
  const headShard = baseShard.replace("- id: stale\n  lifecycle: active", "- id: stale\n  # knowledge gardener: retire stale\n  lifecycle: superseded");
  const baseLog = "# Knowledge garden log\n\n## Pass 2026-11-01T00:00:00.000Z\n\n- retire old-lesson: rarely used\n";
  const headLog = `${baseLog}\n${HEADING}\n\n${gardenLogActionLine(RETIRE)} rarely used\n`;
  const claims = passClaims([RETIRE], { stale: "learnings/ci.yaml" }, HEADING, { shards: new Map([["learnings/ci.yaml", baseShard]]), log: baseLog });
  assert.deepEqual(claims.map((c) => c.proof), [`grep: ^${HEADING}$ in ${LOG}`, `grep: ^- retire stale: in ${LOG}`]);
  const base = { "learnings/ci.yaml": baseShard, [LOG]: baseLog }, head = { "learnings/ci.yaml": headShard, [LOG]: headLog };
  for (const c of claims) assertMissesAtBase(c.proof, base, head, t);
  // The old proof passes at this base, and the marker-only proof is a comment, which review grades stale.
  assert.equal(grepHits("lifecycle: superseded$", (() => { const f = join(mkdtempSync(join(tmpdir(), "rmd-w1-t13987-old-")), "ci.yaml"); t.after(() => rmSync(join(f, ".."), { recursive: true, force: true })); writeFileSync(f, baseShard); return f; })()), true);
  assert.notEqual(commentOnlyGrepProofRefusal("grep: knowledge gardener: retire stale$ in learnings/ci.yaml", () => headShard), undefined);
  // A merge whose superseded_by line base already holds is proved the same way, by its own log line.
  const merge = { class: "merge" as const, target: "stale", into: "keeper", reason: "near-duplicate" };
  const mergeBase = `${baseShard}- id: other\n  lifecycle: superseded\n  superseded_by: keeper\n`;
  assert.deepEqual(passClaims([merge], { stale: "learnings/ci.yaml" }, HEADING, { shards: new Map([["learnings/ci.yaml", mergeBase]]), log: undefined }).map((c) => c.proof)[1], `grep: ^- merge stale into keeper: in ${LOG}`);
  // When base's log already holds that line as well, no per-entry proof can miss at base: the heading alone proves the pass.
  const relogged = passClaims([RETIRE], { stale: "learnings/ci.yaml" }, HEADING, { shards: new Map([["learnings/ci.yaml", baseShard]]), log: `${baseLog}- retire stale: earlier\n` });
  assert.deepEqual(relogged.map((c) => c.proof), [`grep: ^${HEADING}$ in ${LOG}`]);
});

const BOUND = { reviewMinutesPerShard: null, reviewCostSource: "unmeasured", reviewPrs: 0, windowMinutes: null, fit: null, startsPerHour: null, openToMergeMinutes: null, churnThreshold: 1 };
const SIG = "0123456789abcdef";
const judgeShard = (id: string, priority: string, marker?: string) =>
  [`- id: ${id}`, `  title: "task ${id}"`, "  repo: remudero", "  type: implement", `  priority: ${priority}`, "  status: queued", ...(marker ? [`  ${marker}`] : []), "  attempts: 0", ""].join("\n");
const move = (target: string, from: number | null, to: number, signature = SIG): QueueJudgeAction => ({
  class: from === null || to < from ? "raise" : "lower", target, reason: "measured", from, to, evidence: ["age"], signature,
  expectedCostOfDelay: 1, pinned: false, heldBy: undefined, expectedOutcome: { unblocks_tasks: [], ends_incidents: [], unsticks_prs: [], starts_within: 1 },
} as QueueJudgeAction);

function judgeWorld(t: TestContext, shards: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t13987-judge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  for (const [id, text] of Object.entries(shards)) writeFileSync(join(root, "plan", "tasks.d", `${id}.yaml`), text);
  const rows: Row[] = [];
  const deps: GardenerDeps = { stateDir: join(root, "state"), repoRoot: root, log: (step, extra = {}) => void rows.push({ step, ...extra }), openWorkspace: () => { throw new Error("not opened"); } };
  const spec = queueJudgeGardenSpec(deps, { clock: fixedClock(Date.parse("2026-11-23T10:00:00.000Z")) });
  const ws: GardenCheckout = { root, land: () => undefined, dispose: () => {} };
  return { root, rows, apply: (actions: QueueJudgeAction[]) => spec.apply(ws, { actions, acting: ["raise"] }, { bound: BOUND } as never) };
}

test("W1-T13987 criterion 3: the queue judge drops an action whose base shard already carries its exact marker as a no-op with one row", (t) => {
  const marker = `# queue judge: priority=1 evidence=${SIG}`;
  const w = judgeWorld(t, {
    "W1-T1": judgeShard("W1-T1", "1  # queue-judge-2026-11-20: measured", marker),
    "W1-T2": judgeShard("W1-T2", "3"),
  });
  const before = readFileSync(join(w.root, "plan/tasks.d/W1-T1.yaml"), "utf8");
  const landing = w.apply([move("W1-T1", 1, 1), move("W1-T2", 3, 1)]);
  assert.deepEqual(landing?.paths, ["plan/tasks.d/W1-T2.yaml"], "the action that changes base still files");
  assert.equal(readFileSync(join(w.root, "plan/tasks.d/W1-T1.yaml"), "utf8"), before, "the no-op shard is not rewritten with a new day");
  assert.deepEqual(w.rows.filter((r) => r.step === QUEUE_JUDGE_NOOP_STEP).map((r) => [r.task_id, r.priority, r.evidence_signature]), [["W1-T1", 1, SIG]]);
  assert.doesNotMatch(landing!.body, /W1-T1 carries/);
  assert.match(landing!.body, /W1-T2 carries the judged priority/);
  // The only action a no-op: nothing is drafted.
  const only = judgeWorld(t, { "W1-T1": judgeShard("W1-T1", "1  # queue-judge-2026-11-20: measured", marker) });
  assert.equal(only.apply([move("W1-T1", 1, 1)]), undefined);
  assert.equal(only.rows.filter((r) => r.step === QUEUE_JUDGE_NOOP_STEP).length, 1);
});

const fakeProbe = {
  loadManifest: (path: string) => JSON.parse(readFileSync(path, "utf8")),
  writeManifest: (path: string, manifest: unknown) => writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`),
} as unknown as TestManifestProbe;
const MANIFEST = "scripts/test-tier-manifest.json";
const row = (key: string, to: number): TestGardenAction => ({ class: "adopt-durations", target: key, file: MANIFEST, edit: { kind: "row", key, to }, reason: "measured" });

function testGardenWorld(t: TestContext, files: Record<string, number>) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t13987-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  const base = `${JSON.stringify({ thresholdMs: 5000, files }, null, 2)}\n`;
  writeFileSync(join(root, MANIFEST), base);
  const deps = { stateDir: join(root, "state"), repoRoot: root, log: () => {}, openWorkspace: () => { throw new Error("not opened"); } } as GardenerDeps;
  const ws: GardenCheckout = { root, land: () => undefined, dispose: () => {} };
  return { root, base, apply: (actions: TestGardenAction[]) => testGardenSpec(deps, fakeProbe).apply(ws, { actions, acting: ["adopt-durations"] }, {}) };
}

test("W1-T13987 criterion 3: the test gardener proves only rows whose committed value differs and drafts nothing when none differs", (t) => {
  const w = testGardenWorld(t, { "test/a.test.ts": 700, "test/b.test.ts": 1234, "test/c.test.ts": 9000 });
  const actions = [row("test/a.test.ts", 700), row("test/b.test.ts", 123), row("test/c.test.ts", 8000), row("test/d.test.ts", 50)];
  assert.deepEqual(changedTestGardenActions(w.root, fakeProbe, actions).map((a) => a.target), ["test/b.test.ts", "test/c.test.ts", "test/d.test.ts"]);
  const landing = w.apply(actions);
  assert.ok(landing);
  const proofs = landing.body.split("\n").filter((l) => l.startsWith("  proof: ")).map((l) => l.slice("  proof: ".length));
  assert.deepEqual(proofs, [`grep: "test/c.test.ts": 8000 in ${MANIFEST}`, `grep: "test/d.test.ts": 50 in ${MANIFEST}`], "an unchanged row is not proved, nor one whose base value its proof would match");
  assert.match(landing.body, /test\/b\.test\.ts/, "a changed row is still listed and filed");
  assert.match(landing.title, /3 manifest row/);
  const head = readFileSync(join(w.root, MANIFEST), "utf8");
  for (const p of proofs) assertMissesAtBase(p, { [MANIFEST]: w.base }, { [MANIFEST]: head }, t);
  const none = testGardenWorld(t, { "test/a.test.ts": 700 });
  assert.equal(none.apply([row("test/a.test.ts", 700)]), undefined, "a pass whose every row main already holds drafts nothing");
  assert.equal(readFileSync(join(none.root, MANIFEST), "utf8"), none.base);
});

// ── capability kept ──

test("W1-T13987 criterion 4: a passing record stages exactly as before, and every garden still files what changes base", async (t) => {
  const w = world(t);
  const staged = await w.land([input()]);
  assert.deepEqual(staged.refused, []);
  assert.equal(readFileSync(join(w.stateRoot, "state/task-files-landing-pending", PATH), "utf8"), shard("drafted"));
  assert.equal(existsSync(join(w.stateRoot, MEMORY)), false, "a pass leaves no memory");
  assert.deepEqual(w.remembered(), []);
  assert.equal(w.runs.base, 0, "a green record never probes main");
  // A knowledge base with no superseded line keeps the data-line proof exactly as on origin/main.
  const baseShard = learnings("- id: stale\n  lifecycle: active\n");
  assert.deepEqual(passClaims([RETIRE], { stale: "learnings/ci.yaml" }, HEADING, { shards: new Map([["learnings/ci.yaml", baseShard]]), log: undefined }).map((c) => c.proof),
    [`grep: ^${HEADING}$ in ${LOG}`, "grep: lifecycle: superseded$ in learnings/ci.yaml"]);
  assert.deepEqual(passClaims([RETIRE], { stale: "learnings/ci.yaml" }, HEADING).map((c) => c.proof)[1], "grep: lifecycle: superseded$ in learnings/ci.yaml");
  // The queue judge still files a new priority or new evidence under an old marker.
  const marker = `# queue judge: priority=1 evidence=${SIG}`;
  const text = judgeShard("W1-T1", "1  # queue-judge-2026-11-20: measured", marker);
  assert.equal(isQueueJudgeNoop(readShardPriority(text), { to: 1, signature: SIG }), true);
  assert.equal(isQueueJudgeNoop(readShardPriority(text), { to: 1, signature: "fedcba9876543210" }), false, "new evidence files");
  assert.equal(isQueueJudgeNoop(readShardPriority(judgeShard("W1-T1", "2", marker)), { to: 1, signature: SIG }), false, "a priority edited since the marker files");
  assert.equal(isQueueJudgeNoop(readShardPriority(judgeShard("W1-T1", "1")), { to: 1, signature: SIG }), false, "no marker files");
  const j = judgeWorld(t, { "W1-T1": text });
  const read = (p: string) => readFileSync(p, "utf8");
  const write = (p: string, s: string) => writeFileSync(p, s);
  assert.deepEqual(applyQueueJudgeActions(j.root, new Map([["W1-T1", "plan/tasks.d/W1-T1.yaml"]]), [move("W1-T1", 1, 1, "fedcba9876543210")], new Date(Date.parse("2026-11-23T10:00:00.000Z")), read, write), ["plan/tasks.d/W1-T1.yaml"]);
  assert.deepEqual(applyQueueJudgeActions(j.root, new Map([["W1-T1", "plan/tasks.d/W1-T1.yaml"]]), [move("W1-T1", 1, 1, "fedcba9876543210")], new Date(Date.parse("2026-11-23T10:00:00.000Z")), read, write), [], "with no no-op callback a no-op is still skipped");
  // The test gardener still files every changed row.
  const tg = testGardenWorld(t, { "test/a.test.ts": 700 });
  assert.deepEqual(tg.apply([row("test/a.test.ts", 900)])?.paths, [MANIFEST]);
});
