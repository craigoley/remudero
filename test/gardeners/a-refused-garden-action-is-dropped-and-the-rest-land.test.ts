// W1-T14640. OBSERVED 2026-11-24 on the fleet host: state/plan-gardener.json and state/backlog-gardener.json each held
// filingFailures.count 19, reason "the drafted change is byte-identical to the one refused at ...". gardener.ts lands
// one landing for all of a pass's actions; once the plan-PR preflight refused one (lint needs-input on a retired task
// that still carried a needs_input block, shard-census, proof-discrimination), every redraft of the same bytes was
// skipped as a repeat, so one poisonous action stopped the whole class for weeks. These suites drive the real plan
// gardener spec over a temporary plan repository, with the checkout's landing standing in for the plan-PR preflight.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "#src/lib/clock.js";
import { gardenStatePath, runGarden, type GardenCheckout, type GardenerDeps, type GardenLandOpts } from "#src/lib/gardener.js";
import { applyPlanActions, planGardenSpec, planShards, type PlanGardenAction } from "#src/lib/plan-gardener.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { lintTask } from "#src/lib/task-linter.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const HOUR = 3_600_000;
const shardOf = (id: string) => `plan/tasks.d/${id}-x.yaml`;
const NEEDS_INPUT = [
  "  needs_input:",
  "    question: |",
  "      Which bound should the sweep use?",
  "",
  "      Three passes or five?",
  '    source_pr: "#18449"',
  '    asked_at: "2026-11-14T20:00:00Z"',
].join("\n");

interface ShardSpec { title?: string; depends?: string[]; status?: string; retirement?: string; extra?: string }

function shard(id: string, s: ShardSpec = {}): string {
  return [
    `- id: ${id}`,
    `  title: "${s.title ?? `the task ${id}`}"`,
    "  repo: remudero",
    `  depends_on: [${(s.depends ?? ["W1-T1"]).join(", ")}]`,
    "  type: implement",
    `  status: ${s.status ?? "queued"}`,
    ...(s.retirement ? [`  retirement: ${s.retirement}`] : []),
    ...(s.extra ? [s.extra] : []),
    "  files: [src/lib/x.ts]",
    "  acceptance:",
    '    - claim: "c"',
    `      proof: 'grep: never-written-${id} in src/lib/x.ts'`,
    "",
  ].join("\n");
}

interface Landing { paths: string[]; texts: Record<string, string>; pr?: string }

/** A plan repository whose W1-T1 was retired, so every queued task depending on it is a `retire` candidate, and a
 *  plan gardener over it. Each checkout is a fresh copy of the plan; `refuse` is the plan-PR preflight's verdict. */
function world(tasks: Record<string, ShardSpec>, opts: { guard?: (paths: readonly string[]) => string | undefined } = {}) {
  const repo = gitRepo({ kind: "w1-t14640-plan" });
  const root = repo.dir;
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(root, shardOf("W1-T1")), shard("W1-T1", { depends: [], status: "blocked", retirement: "retired" }));
  for (const [id, s] of Object.entries(tasks)) writeFileSync(join(root, shardOf(id)), shard(id, s));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "file the tasks");
  writeFileSync(join(root, "state", "PLAN_OFF-merge"), "");
  writeFileSync(gardenStatePath(join(root, "state"), "plan"), JSON.stringify({ classes: { merge: { alpha: 3, beta: 1 }, retire: { alpha: 1000, beta: 1 } } }));
  let nowMs = Date.parse("2026-11-24T00:00:00Z");
  const clock: Clock = { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() };
  const lands: Landing[] = [];
  const guarded: string[][] = [];
  const merged = new Set<string>();
  const steps: string[] = [];
  let opens = 0;
  const w = {
    root, lands, guarded, steps,
    opens: () => opens,
    refuse: (_l: Landing): boolean => false,
    write: (id: string, s: ShardSpec = {}) => writeFileSync(join(root, shardOf(id)), shard(id, s)),
    /** The PR merges: main now holds its shards, and the pending PR reads merged. */
    merge: (l: Landing) => {
      for (const [p, text] of Object.entries(l.texts)) writeFileSync(join(root, p), text);
      merged.add(l.pr!);
    },
    pass: () => {
      nowMs += 25 * HOUR;
      return runGarden(spec, deps);
    },
  };
  const openWorkspace = (): GardenCheckout => {
    opens++;
    const ws = join(makeTempDir("w1-t14640-checkout"), "tree");
    cpSync(join(root, "plan"), join(ws, "plan"), { recursive: true });
    return {
      root: ws,
      land: (o: GardenLandOpts) => {
        const l: Landing = { paths: [...o.paths].sort(), texts: Object.fromEntries(o.paths.map((p) => [p, readFileSync(join(ws, p), "utf8")])) };
        lands.push(l);
        if (w.refuse(l)) return undefined;
        l.pr = `https://github.com/acme/remudero/pull/${100 + lands.length}`;
        return l.pr;
      },
      dispose: () => {},
    };
  };
  const deps: GardenerDeps = {
    stateDir: join(root, "state"), repoRoot: root, clock, seed: 1,
    log: (step) => void steps.push(step),
    mergedPlanLint: () => undefined,
    prState: (url) => (merged.has(url) ? "merged" : "open"),
    openWorkspace,
  };
  let tick = 0;
  const spec = {
    ...planGardenSpec(deps),
    cheapFingerprint: () => String(++tick),
    ...(opts.guard ? { landingRefusal: (_root: string, paths: readonly string[]) => (guarded.push([...paths].sort()), opts.guard!(paths)) } : {}),
  };
  return w;
}

const ids = (paths: readonly string[]) => paths.map((p) => /tasks\.d\/(W1-T\d+)-/.exec(p)![1]!);

test("W1-T14640 criterion 1: a landing of several the preflight refuses for one action lands the others, and that action is not drafted again while its shard is unchanged", () => {
  const w = world({ "W1-T2": {}, "W1-T3": {}, "W1-T4": {} });
  w.refuse = (l) => l.paths.includes(shardOf("W1-T4"));
  w.pass();
  assert.deepEqual(w.lands.map((l) => ids(l.paths)), [["W1-T2", "W1-T3", "W1-T4"]], "the pass drafts every retirement as one landing");
  assert.equal(w.lands[0]!.pr, undefined, "the preflight refused it, naming nothing the gardener reads");
  // The live wedge: the next pass drafts the same bytes. origin/main skips that redraft on every pass and lands nothing.
  w.pass();
  w.pass();
  const opened = w.lands.filter((l) => l.pr !== undefined);
  assert.deepEqual(opened.map((l) => ids(l.paths)), [["W1-T2", "W1-T3"]], "a landing of the other actions opens a PR");
  assert.equal(w.lands.length, 2, "the byte-identical redraft ran no second preflight; the bisected half did");
  w.merge(opened[0]!);
  w.pass();
  assert.deepEqual(ids(w.lands.at(-1)!.paths), ["W1-T4"], "the action left over is drafted alone");
  assert.equal(w.lands.at(-1)!.pr, undefined, "and refused alone");
  const refusedAt = w.lands.length;
  w.write("W1-T5");
  w.pass();
  w.merge(w.lands.at(-1)!);
  for (let i = 0; i < 3; i++) w.pass();
  const later = w.lands.slice(refusedAt);
  assert.ok(later.every((l) => !l.paths.includes(shardOf("W1-T4"))), "the refused action is never drafted again while its shard is unchanged");
  assert.deepEqual(later.map((l) => [ids(l.paths), l.pr !== undefined]), [[["W1-T5"], true]], "new work beside it lands");
});

test("W1-T14640 criterion 1: a refusal that names one action's shard lands the others on the very next pass", () => {
  const w = world({ "W1-T2": {}, "W1-T3": {}, "W1-T4": {} }, {
    guard: (paths) => (paths.includes(shardOf("W1-T4")) ? `[shard-census] ${shardOf("W1-T4")} does not lint` : undefined),
  });
  w.pass();
  assert.deepEqual(w.guarded.map(ids), [["W1-T2", "W1-T3", "W1-T4"]]);
  assert.equal(w.lands.length, 0, "the guard refused the draft before any landing");
  w.pass();
  assert.deepEqual(w.lands.map((l) => [ids(l.paths), l.pr !== undefined]), [[["W1-T2", "W1-T3"], true]], "the next pass lands the other actions");
  w.merge(w.lands[0]!);
  for (let i = 0; i < 3; i++) w.pass();
  assert.ok(w.guarded.slice(1).every((p) => !p.includes(shardOf("W1-T4"))), "the named action is not drafted again while its shard is unchanged");
});

test("W1-T14640 criterion 2: a plan gardener merge or retire on a shard carrying a needs_input block writes it without the block", () => {
  const root = makeTempDir("w1-t14640-needs-input");
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  for (const id of ["W1-T2", "W1-T3", "W1-T4"]) writeFileSync(join(root, shardOf(id)), shard(id, { extra: NEEDS_INPUT }));
  const actions: PlanGardenAction[] = [
    { class: "retire", target: "W1-T2", retirement: "retired", reason: "It depends on W1-T1, which will never be built." },
    { class: "merge", target: "W1-T3", into: "W1-T9", retirement: "withdrawn", reason: "Its title and files repeat an older queued task." },
    { class: "retire", target: "W1-T4", retirement: "closed", landingCommit: "abc1234", reason: "Every acceptance proof now holds on main." },
  ];
  assert.deepEqual(applyPlanActions(root, planShards(root), actions), ["W1-T2", "W1-T3", "W1-T4"].map(shardOf));
  for (const id of ["W1-T2", "W1-T3", "W1-T4"]) {
    const text = readFileSync(join(root, shardOf(id)), "utf8");
    assert.doesNotMatch(text, /needs_input|Three passes|source_pr|asked_at/, `${id}: the block and every line under it are gone`);
    assert.match(text, /^ {2}files: \[src\/lib\/x\.ts\]$/m, `${id}: the fields after the block stay`);
    const task = parseTasksFromYaml(text, shardOf(id)).find((t) => t.id === id)!;
    assert.notEqual(task.status, "queued");
    assert.deepEqual(lintTask(task).violations.filter((v) => v.check === "needs-input"), [], `${id}: lint-plan's needs-input check passes`);
  }
});

test("W1-T14640 criterion 2: a retirement of a task that waited for an answer is no longer refused for needs-input", () => {
  const w = world({ "W1-T2": { extra: NEEDS_INPUT }, "W1-T3": {} });
  // The plan-PR preflight's lint-plan, read for its needs-input check on each landed shard.
  w.refuse = (l) => Object.entries(l.texts).some(([p, text]) => parseTasksFromYaml(text, p).some((t) => lintTask(t).violations.some((v) => v.check === "needs-input")));
  w.pass();
  assert.deepEqual(w.lands.map((l) => [ids(l.paths), l.pr !== undefined]), [[["W1-T2", "W1-T3"], true]], "the landing is not refused with needs-input");
});

test("W1-T14640 criterion 3: invariant:a-refused-action-is-never-landed — an action refused alone is never in a landing until its shard changes, and no remaining action opens no PR", () => {
  const w = world({ "W1-T4": {} });
  const poison = new Set([shardOf("W1-T4"), shardOf("W1-T6")]);
  w.refuse = (l) => l.paths.some((p) => poison.has(p));
  w.pass();
  assert.deepEqual(w.lands.map((l) => [ids(l.paths), l.pr]), [[["W1-T4"], undefined]], "the lone action is refused alone");
  w.write("W1-T5");
  w.write("W1-T6");
  w.pass();
  w.pass();
  w.pass();
  assert.ok(w.lands.slice(1).every((l) => !l.paths.includes(shardOf("W1-T4"))), "the action refused alone is in no later landing");
  const opened = w.lands.filter((l) => l.pr !== undefined);
  assert.deepEqual(opened.map((l) => ids(l.paths)), [["W1-T5"]], "the bisection lands the action that passes");
  w.merge(opened[0]!);
  w.pass();
  assert.deepEqual([ids(w.lands.at(-1)!.paths), w.lands.at(-1)!.pr], [["W1-T6"], undefined], "the other suspect is refused alone");
  const landsBefore = w.lands.length;
  const opensBefore = w.opens();
  w.pass();
  w.pass();
  assert.equal(w.lands.length, landsBefore, "a pass whose every action was refused alone lands nothing");
  assert.equal(w.opens(), opensBefore, "and opens no checkout and no pull request");
  assert.ok(w.steps.includes("plan.garden_refused_actions_dropped"), "the dropped actions are ledgered");
  w.write("W1-T4", { title: "the task W1-T4, refiled with a narrower scope" });
  w.pass();
  assert.deepEqual(ids(w.lands.at(-1)!.paths), ["W1-T4"], "a changed shard is drafted again");
  const state = JSON.parse(readFileSync(gardenStatePath(join(w.root, "state"), "plan"), "utf8")) as { refusedActions?: Record<string, { path?: string }> };
  assert.deepEqual(Object.keys(state.refusedActions ?? {}).sort(), ["retire:W1-T4", "retire:W1-T6"]);
  assert.equal(state.refusedActions!["retire:W1-T6"]!.path, shardOf("W1-T6"));
});
