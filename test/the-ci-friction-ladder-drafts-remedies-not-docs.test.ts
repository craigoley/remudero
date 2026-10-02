/**
 * The ci-friction ladder end to end: the gardener walks the costliest causes, leaves merge conflicts to
 * the hot-file gardener, drafts the first open cause against the code that owns it, sends a cause with
 * no locatable owner (or a spent ladder) to a person instead of a docs record, and replays the past
 * week from the ledger union and main's plan history read-only.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  ciFrictionEscalation,
  ciFrictionGardenSpec,
  ciFrictionLadder,
  escalatedCiFrictionOrigins,
  gitCiFrictionOwnerSearch,
  pathTimesFromLog,
  readCiFrictionPlanTasks,
  readCiFrictionPlanTimeline,
  remedyRoundsOf,
  renderCiFrictionReplay,
  replayCiFriction,
  type CiFrictionGardenAction,
  type CiFrictionGardenSources,
  type CiFrictionRound,
} from "../src/lib/ci-friction-gardener.js";
import type { CiFrictionRemedyTask, OwnerSearch } from "../src/lib/ci-friction-remedy.js";
import { renderMachineShard } from "../src/lib/machine-filing.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import type { Escalation } from "../src/lib/escalate.js";
import { runGarden, type GardenerDeps } from "../src/lib/gardener.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { gardenReplayCommand } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const HOUR = 3_600_000;
const OWNED: OwnerSearch = { filesContaining: (term) => (term === "nobody names this" ? [] : [{ file: "src/run-task.ts", hits: 2 }]), fileExists: () => true };

function priced(key: string, minutes: number) {
  const [kind, ...rest] = key.split(":");
  return { cause: { kind: kind as "check", name: rest.join(":") }, minutes, rounds: 3, prs: 2 };
}

function round(key: string, at: number, detail: string): CiFrictionRound {
  const [kind, ...rest] = key.split(":");
  return { pr: 1, cause: { kind: kind as "check", name: rest.join(":") }, minutes: 5, at: new Date(at).toISOString(), detail };
}

test("the ladder skips conflicts and held causes and drafts the first open cause against its owner", () => {
  const tasks: CiFrictionRemedyTask[] = [{ id: "W1-T1", origin: "ci-friction:check:held", status: "queued", retired: false, files: ["src/a.ts"] }];
  const { next, ladder } = ciFrictionLadder({
    priced: [priced("conflict:merge-conflict", 900), priced("check:held", 800), priced("fix_refusal:the-worker-changed-nothing", 700), priced("check:later", 1)],
    rounds: [round("fix_refusal:the-worker-changed-nothing", NOW - HOUR, "the worker changed nothing")],
    tasks,
    receipts: new Set(),
    escalated: new Set(),
    ownerSearch: OWNED,
    nowMs: NOW,
  });
  assert.deepEqual(ladder.map((l) => [l.cause, l.state, l.task]), [
    ["conflict:merge-conflict", "delegated", undefined],
    ["check:held", "in_progress", "W1-T1"],
    ["fix_refusal:the-worker-changed-nothing", "draft", undefined],
    ["check:later", "draft", undefined],
  ]);
  assert.equal(next?.origin, "ci-friction:fix_refusal:the-worker-changed-nothing");
  assert.equal(next?.decision.kind, "draft");
  assert.deepEqual(next?.decision.kind === "draft" && next.decision.owner.files, ["src/run-task.ts"]);
});

test("a cause no code names goes to a person, and an escalated rung is held", () => {
  const nobody: OwnerSearch = { filesContaining: () => [], fileExists: () => false };
  const { next, ladder } = ciFrictionLadder({
    priced: [priced("check:ci-log:mystery", 50), priced("check:escalated-already", 40)],
    rounds: [],
    tasks: [],
    receipts: new Set(),
    escalated: new Set(["ci-friction:check:escalated-already"]),
    ownerSearch: nobody,
    nowMs: NOW,
  });
  assert.equal(next?.decision.kind, "escalate");
  assert.match(next?.decision.kind === "escalate" ? next.decision.why : "", /no code in src\/ or scripts\/ names check:ci-log:mystery/);
  assert.deepEqual(ladder.map((l) => l.state), ["escalate", "escalated"]);
});

test("a spent ladder escalates with the last rung's measured outcome", () => {
  const merged = NOW - 4 * 24 * HOUR;
  const flat = Array.from({ length: 200 }, (_, i) => round(i % 4 === 0 ? "check:stubborn" : "check:other", merged - 4 * 24 * HOUR + i * 0.96 * HOUR, "r"));
  const after = Array.from({ length: 200 }, (_, i) => round(i % 4 === 0 ? "check:stubborn" : "check:other", merged + i * 0.48 * HOUR, "r"));
  const tasks: CiFrictionRemedyTask[] = [
    { id: "W1-T2", origin: "ci-friction:check:stubborn#r2", status: "merged", retired: false, files: ["src/a.ts"], mergedAt: new Date(merged).toISOString() },
  ];
  const { next, ladder } = ciFrictionLadder({ priced: [priced("check:stubborn", 100)], rounds: [...flat, ...after], tasks, receipts: new Set(), escalated: new Set(), ownerSearch: OWNED, nowMs: NOW });
  assert.equal(next?.decision.kind, "escalate");
  assert.equal(next?.rung, 3);
  assert.match(ladder[0]!.effect ?? "", /^did not fall:/);
  const escalation = ciFrictionEscalation({ class: "draft", target: next!.origin, reason: "r", origin: next!.origin, price: next!.price, rung: next!.rung, decision: next!.decision } as CiFrictionGardenAction);
  assert.equal(escalation.class, "BLOCKED");
  assert.equal(escalation.taskId, "ci-friction-check-stubborn");
  assert.match(escalation.detail, /The last rung was W1-T2: did not fall:/);
  assert.equal(escalation.recommendation, "design-remedy");
  assert.deepEqual(escalatedCiFrictionOrigins([{ step: "ci-friction.remedy_escalated", origin: "ci-friction:check:x#r3" }, { step: "other", origin: "x" }, { step: "ci-friction.remedy_escalated" }]), ["ci-friction:check:x#r3"]);
});

test("an escalating pass opens an issue, writes its receipt and lands no PR; a degraded census is ledgered", () => {
  const root = gitRepo({ kind: "ci-friction-escalate-pass" }).dir;
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const raised: Escalation[] = [];
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps: GardenerDeps = {
    stateDir,
    repoRoot: root,
    openWorkspace: () => ({ root, branch: "b", land: () => { throw new Error("an escalation lands nothing"); }, dispose: () => {} }),
    log: (step, extra) => { events.push({ step, extra }); },
    escalate: (e) => (raised.push(e), "https://github.com/acme/remudero/issues/5"),
    seed: 1,
    clock: clockFromMillisFn(() => NOW),
  };
  const sources: CiFrictionGardenSources = {
    ledgerRecords: () => [
      { step: "pr.opened", run_id: "run-1", pr_url: "https://github.com/acme/remudero/pull/2", ts: new Date(NOW - 2 * HOUR).toISOString() },
      { step: "fix.dispatch", run_id: "run-1", mode: "nobody names this", round: 1, ts: new Date(NOW - HOUR).toISOString() },
    ],
    planState: () => ({ tasks: [], degraded: "fetch failed (timeout); read the last fetched origin/main", unreadable: ["plan/tasks.d/x.yaml: bad yaml"] }),
    ownerSearch: OWNED,
    mintTaskId: () => { throw new Error("an escalation mints no task"); },
  };
  const pass = runGarden(ciFrictionGardenSpec(deps, sources), deps);
  assert.equal(pass.prUrl, undefined);
  assert.equal(raised.length, 1);
  assert.equal(events.find((e) => e.step === "ci-friction.remedy_escalated")?.extra?.issue_url, "https://github.com/acme/remudero/issues/5");
  assert.equal(events.filter((e) => e.step === "ci-friction.origins_degraded").length >= 1, true);
  assert.deepEqual(events.find((e) => e.step === "ci-friction.plan_shard_unreadable")?.extra?.shards, ["plan/tasks.d/x.yaml: bad yaml"]);
  const card = events.find((e) => e.step === "ci-friction.scorecard")?.extra;
  assert.equal(card?.degraded, "fetch failed (timeout); read the last fetched origin/main");
  assert.deepEqual(card?.next, { origin: "ci-friction:check:nobody names this", rung: 1, decision: "escalate" });

  // Without an escalation path the receipt still holds the cause, with no issue URL.
  delete deps.escalate;
  events.length = 0;
  writeFileSync(join(stateDir, "ci-friction-gardener.json"), JSON.stringify({ classes: { draft: { alpha: 3, beta: 1 } } }));
  runGarden(ciFrictionGardenSpec(deps, sources), deps);
  assert.equal(events.find((e) => e.step === "ci-friction.remedy_escalated")?.extra?.issue_url, null);
});

test("a machine shard renders its rationale as a block the plan loader reads back", () => {
  const { text, refused } = renderMachineShard({
    taskId: "W1-T9300", title: "t", origin: "ci-friction:check:x", files: ["src/run-task.ts"],
    acceptance: [{ claim: "c", proof: "unit test: W1-T9300: x" }], rationale: ["first line", "", "third: line"],
  });
  assert.equal(refused, undefined);
  assert.match(text, /^ {2}rationale: \|\n {4}first line\n\n {4}third: line$/m);
});

test("the git owner search counts literal hits in src and scripts and never in tests", () => {
  const repo = gitRepo({ kind: "ci-friction-owner-search" });
  mkdirSync(join(repo.dir, "src", "lib"), { recursive: true });
  mkdirSync(join(repo.dir, "scripts"), { recursive: true });
  mkdirSync(join(repo.dir, "test"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "lib", "a.ts"), 'const r = "the worker changed nothing";\nconst s = "the worker changed nothing";\n');
  writeFileSync(join(repo.dir, "scripts", "b.mjs"), "// the worker changed nothing\n");
  writeFileSync(join(repo.dir, "src", "lib", "a.test.ts"), "the worker changed nothing\n");
  writeFileSync(join(repo.dir, "test", "c.test.ts"), "the worker changed nothing\n");
  repo.git("add", ".");
  repo.git("commit", "-q", "-m", "seed");
  const search = gitCiFrictionOwnerSearch((args) => repo.git(...args) + "\n", "HEAD");
  assert.deepEqual(search.filesContaining("the worker changed nothing").sort((a, b) => a.file.localeCompare(b.file)), [
    { file: "scripts/b.mjs", hits: 1 },
    { file: "src/lib/a.ts", hits: 2 },
  ]);
  assert.deepEqual(search.filesContaining("no file says this"), []);
  assert.equal(search.fileExists("src/lib/a.ts"), true);
  assert.equal(search.fileExists("src/lib/gone.ts"), false);
  const broken = gitCiFrictionOwnerSearch(() => { throw Object.assign(new Error("fatal: not a git repository"), { status: 128 }); });
  assert.throws(() => broken.filesContaining("x"), /not a git repository/, "a real git failure is not an empty owner set");
});

test("plan-history reads batch into one walk each and time a filing, a retirement and a merge", () => {
  assert.deepEqual([...pathTimesFromLog("\u00012026-10-02T00:00:00Z\na.yaml\n\n\u00012026-10-01T00:00:00Z\na.yaml\nb.yaml\nstray-before-header", "oldest")], [
    ["a.yaml", "2026-10-01T00:00:00Z"], ["b.yaml", "2026-10-01T00:00:00Z"], ["stray-before-header", "2026-10-01T00:00:00Z"],
  ]);
  assert.deepEqual([...pathTimesFromLog("orphan\n\u00012026-10-02T00:00:00Z\na.yaml\n\u00012026-10-01T00:00:00Z\na.yaml", "newest")], [["a.yaml", "2026-10-02T00:00:00Z"]]);

  const repo = gitRepo({ kind: "ci-friction-plan-timeline" });
  const dir = join(repo.dir, "plan", "tasks.d");
  mkdirSync(dir, { recursive: true });
  const shard = (id: string, origin: string, status: string, extra = "") =>
    `- id: ${id}\n  title: "t"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: low\n  status: ${status}\n  attempts: 0\n  origin: "${origin}"\n  files:\n    - src/a.ts\n  acceptance:\n    - claim: "c"\n      proof: "unit test: t"\n${extra}`;
  writeFileSync(join(dir, "W1-T1.yaml"), shard("W1-T1", "ci-friction:check:a", "queued"));
  writeFileSync(join(dir, "W1-T2.yaml"), shard("W1-T2", "ci-friction:check:b", "queued"));
  writeFileSync(join(dir, "broken.yaml"), 'origin: "ci-friction:check:c"\n- [');
  writeFileSync(join(dir, "other.yaml"), shard("W1-T3", "feedback#x", "queued"));
  repo.git("add", ".");
  repo.git("commit", "-q", "-m", "file");
  writeFileSync(join(dir, "W1-T1.yaml"), shard("W1-T1", "ci-friction:check:a", "merged"));
  repo.git("commit", "-q", "-am", "reconcile statuses");
  writeFileSync(join(dir, "W1-T2.yaml"), shard("W1-T2", "ci-friction:check:b", "blocked", "  retirement: retired\n"));
  repo.git("commit", "-q", "-am", "retire");

  const git = (args: string[]) => repo.git(...args) + "\n";
  const skipped: string[] = [];
  const tasks = readCiFrictionPlanTasks(git, "plan/tasks.d", "HEAD", (path) => skipped.push(path));
  assert.deepEqual(skipped, ["plan/tasks.d/broken.yaml"], "the unparseable shard is reported by name");
  assert.deepEqual(tasks.map((t) => [t.id, t.status, t.retired, typeof t.mergedAt]), [
    ["W1-T1", "merged", false, "string"],
    ["W1-T2", "blocked", true, "undefined"],
  ], "the unparseable shard is skipped and the non-ci-friction one ignored");
  const timeline = readCiFrictionPlanTimeline(git, "plan/tasks.d", "HEAD");
  assert.equal(typeof timeline[0]!.filedAt, "string");
  assert.equal(typeof timeline[1]!.retiredAt, "string");
  const noMatch = (args: string[]): string => {
    if (args[0] === "grep") throw Object.assign(new Error("no match"), { status: 1 });
    return "";
  };
  assert.equal(readCiFrictionPlanTasks(noMatch, "plan/tasks.d").length, 0, "no ci-friction origin is an empty plan");
  assert.throws(() => readCiFrictionPlanTasks(() => { throw Object.assign(new Error("bad ref"), { status: 128 }); }, "plan/tasks.d"), /bad ref/);
  const none = readCiFrictionPlanTimeline((args) => (args[0] === "grep" ? "" : git(args)), "plan/tasks.d", "HEAD");
  assert.deepEqual(none, []);
});

test("the replay walks the past window and names where each draft would point", () => {
  const records: LedgerRecord[] = [
    { step: "pr.opened", run_id: "run-1", pr_url: "https://github.com/acme/remudero/pull/2", ts: new Date(NOW - 50 * HOUR).toISOString() },
    { step: "fix.dispatch", run_id: "run-1", mode: "reviewer-unmet", round: 1, ts: new Date(NOW - 40 * HOUR).toISOString() },
    { step: "fix.dispatch", run_id: "run-1", mode: "merge-conflict", round: 2, ts: new Date(NOW - 39 * HOUR).toISOString() },
  ];
  const lines = replayCiFriction({ records, tasks: [], fromMs: NOW - 48 * HOUR, toMs: NOW, stepMs: 24 * HOUR, ownerSearch: OWNED });
  assert.equal(lines.length, 3);
  assert.equal(lines[0]!.next, undefined, "nothing had happened yet at the first step");
  assert.deepEqual(lines[1]!.next, { key: "check:reviewer-unmet", state: "draft", rung: 1 });
  assert.deepEqual(lines[1]!.owner, ["src/run-task.ts"]);
  assert.equal(lines[1]!.causes.some((c) => c.key === "conflict:merge-conflict"), false, "conflicts are the hot-file gardener's");
  const text = renderCiFrictionReplay(lines);
  assert.match(text, /nothing to draft/);
  assert.match(text, /draft check:reviewer-unmet \(rung 1\) → src\/run-task\.ts/);
  assert.match(text, /Distinct actions the ladder would have taken: 1/);
  const unowned = renderCiFrictionReplay([{ ...lines[1]!, owner: [] }, { ...lines[1]!, owner: undefined, causes: [{ key: "k", minutes: 1, state: "draft", rung: 2, verdict: "debit" }] }]);
  assert.match(unowned, /→ no owner: a person/);
  assert.match(unowned, /draft {7}k r2 \[debit\]/);
  assert.equal(replayCiFriction({ records, tasks: [], fromMs: NOW, toMs: NOW, stepMs: HOUR })[0]!.owner, undefined, "no search, no owner line");
  assert.deepEqual(remedyRoundsOf([{ pr: 1, cause: { kind: "check", name: "x" }, minutes: 1 }]), [{ pr: 1, causeKey: "check:x" }]);
});

test("rmd garden replay ci-friction prints the ladder and refuses a bad argument", () => {
  const repo = gitRepo({ kind: "ci-friction-replay-cli" });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.d", "seed.yaml"), "- id: W1-T1\n  origin: baseline\n");
  repo.git("add", ".");
  repo.git("commit", "-q", "-m", "seed");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const stateDir = join(repo.dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.2026-01-01T00-00-00-000Z.ndjson"), "");
  writeFileSync(join(stateDir, "ledger.ndjson"), [
    JSON.stringify({ step: "pr.opened", run_id: "run-1", pr_url: "https://github.com/acme/remudero/pull/2", ts: new Date(NOW - 30 * HOUR).toISOString() }),
    JSON.stringify({ step: "fix.dispatch", run_id: "run-1", mode: "reviewer-unmet", round: 1, ts: new Date(NOW - 20 * HOUR).toISOString() }),
  ].join("\n") + "\n");
  const said: string[] = [];
  const rc = gardenReplayCommand(["ci-friction", "--days", "2", "--step-hours", "24"], { say: (l) => said.push(l), clock: clockFromMillisFn(() => NOW), stateDir, repoRoot: repo.dir });
  assert.equal(rc, 0);
  assert.match(said.join("\n"), /draft check:reviewer-unmet \(rung 1\)/);
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal(gardenReplayCommand(["plan"], { stateDir, repoRoot: repo.dir }), 2);
    assert.equal(gardenReplayCommand(["ci-friction", "--days", "zero"], { stateDir, repoRoot: repo.dir }), 2);
    assert.equal(gardenReplayCommand(["ci-friction", "--bogus"], { stateDir, repoRoot: repo.dir }), 2);
  } finally {
    console.error = err;
  }
  assert.equal(readFileSync(join(stateDir, "ledger.ndjson"), "utf8").split("\n").filter(Boolean).length, 2, "the replay writes nothing");
});
