import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { ciFrictionLadder, readCiFrictionPlanTasks } from "#src/lib/ci-friction-gardener.js";
import { episodesOf, FLOW_LADDER, ladderOf, markEligibility, readLadderPlan } from "#src/lib/flow-remedy-gardener.js";
import { machineShardHeaderLines } from "#src/lib/machine-filing.js";
import {
  needsMachineJudgement, releasedQueuedMachineTask, renderRetiredShard, renderRuledShard, runMachineFilingJudge, type MachineJudgePorts, type MechanicalPort,
} from "#src/lib/machine-filing-judge.js";
import {
  corpusCoversWindow, mechanicalRetirementReason, mechanicalRuling, retirementReopensAt, taskActivity, type SymptomReading,
} from "#src/lib/mechanical-rulings.js";
import { loadPlan, parseTasksFromYaml, type Task } from "#src/lib/plan.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { productionMechanicalPort } from "#src/run-task.js";
import { taskRulingPin } from "#src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const NOW = Date.parse("2026-11-15T00:00:00Z");
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const iso = (ms: number): string => new Date(ms).toISOString();
const clock = { now: () => NOW, date: () => new Date(NOW), iso: () => iso(NOW) };
/** A corpus that holds the whole week, and one that starts three days into it. */
const COVERED = { from: iso(NOW - 30 * DAY), through: iso(NOW) };
const PARTIAL = { from: iso(NOW - 3 * DAY), through: iso(NOW) };
const zero = (corpus = COVERED): SymptomReading => ({ count: 0, windowMs: WEEK, corpus });

/** `released`: the judge ruled proceed and pinned it (the queued population); `unjudged`: `verify: auto` with no ruling (due). */
interface Spec { id: string; as?: "released" | "unjudged"; origin?: string }

/** A plan of machine-filed records released into the queue, as the judge releases them, and a fake port. */
function bed(t: TestContext, specs: Spec[]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}queued-rule-2-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "plan", "tasks.d");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const paths = new Map<string, string>();
  for (const spec of specs) {
    const files = ["test/triage/x.test.ts"];
    const path = join(dir, `${spec.id}-record.yaml`);
    paths.set(spec.id, path);
    const filed = [
      `- id: ${spec.id}`, '  title: "stop the recurring failure"', "  repo: remudero", "  depends_on: []", "  type: implement",
      ...machineShardHeaderLines(files), `  origin: ${spec.origin ?? `scout:${spec.id}.failed`}`, "  files:", ...files.map((f) => `    - ${f}`),
      "  acceptance:", "    - claim: the failure stops", `      proof: 'grep: stop in ${files[0]}'`, "",
    ].join("\n");
    if (spec.as === "unjudged") {
      writeFileSync(path, filed.replace("  verify: human", "  verify: auto"));
      continue;
    }
    const pin = taskRulingPin({ ...parseTasksFromYaml(filed, path)[0]!, verify: "auto" });
    const out = renderRuledShard(filed, path, pin, { verdict: "low", action: "proceed", confidence: 0.9, reasons: ["low"], judgedAt: iso(NOW - 20 * DAY) });
    assert.ok("contents" in out, JSON.stringify(out));
    writeFileSync(path, out.contents);
  }
  const symptoms = new Map<string, SymptomReading | "throws">();
  const busy = new Map<string, string>();
  const port = { activity: "fake" as "fake" | "absent" | "throws" };
  const logs: { step: string; extra?: Record<string, unknown> }[] = [];
  const mechanical: MechanicalPort = {
    read: () => ({
      symptom: (task) => {
        const s = symptoms.get(task.id);
        if (s === "throws") throw new Error("step rows unreadable");
        return s;
      },
      declined: () => false,
      ...(port.activity === "absent" ? {} : {
        activity: (task: Task) => {
          if (port.activity === "throws") throw new Error("claim rows unreadable");
          return busy.get(task.id);
        },
      }),
    }),
    release: () => assert.fail("a released queued record is never released again"),
  };
  const ports: MachineJudgePorts = {
    stateDir: root, writeRoot: root, plan: () => loadPlan(join(root, "plan", "tasks.yaml")),
    riskJudge: async () => assert.fail("no model is asked about a released queued record"),
    gardenRecord: () => ({ alpha: 3, beta: 1 }), isMerged: () => false,
    stageProposal: () => {}, log: (step, extra) => { logs.push({ step, extra }); }, clock, mechanical,
  };
  return {
    root, symptoms, busy, port, logs,
    run: () => { logs.length = 0; return runMachineFilingJudge(ports); },
    task: (id: string) => loadPlan(join(root, "plan", "tasks.yaml")).byId.get(id)!,
    text: (id: string) => readFileSync(paths.get(id)!, "utf8"),
    ruling: (id: string) => logs.find((l) => l.step === "machine_judge.mechanical_ruling" && l.extra?.task_id === id)?.extra,
    skipped: (id: string) => logs.find((l) => l.step === "machine_judge.mechanical_skipped" && l.extra?.task_id === id)?.extra,
  };
}

test("W1-T12838 criterion 1: rule 2 retires a released queued machine task whose symptom read 0 across a covered window", async (t) => {
  const f = bed(t, [{ id: "W1-T9401" }]);
  assert.equal(releasedQueuedMachineTask(f.task("W1-T9401")), true, "the record is a released queued machine record");
  assert.equal(needsMachineJudgement(f.task("W1-T9401")), false, "its ruling is pinned, so no judge pass would read it before");
  f.symptoms.set("W1-T9401", zero());
  const report = await f.run();
  assert.deepEqual(report.retired, ["W1-T9401"]);
  const task = f.task("W1-T9401");
  assert.equal(task.status, "blocked");
  assert.equal(task.retirement, "retired");
  // The same note rule 2 writes for a parked record today.
  assert.match(f.text("W1-T9401"), /retirement: retired {2}# retired by rule 2 \(cause stopped\) of the operator's mechanical rulings.*0 occurrence\(s\) across 7 day\(s\), never seen\. Retired by the machine-filing judge, 2026-11-15T00:00:00\.000Z/);
  assert.equal(f.ruling("W1-T9401")?.rule, 2);
  assert.equal(f.ruling("W1-T9401")?.verdict, "retire");
});

test("W1-T12838 criterion 1: the production port's ci-friction reading names a corpus span from the oldest rotation", (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}queued-rule-2-port-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, "ledger.2026-10-02T00-00-00-000Z.ndjson.gz"), "");
  writeFileSync(join(stateDir, "ledger.2026-10-01T00-00-00-000Z.ndjson.gz"), "");
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  const port = productionMechanicalPort({ repoRoot: stateDir, stateDir, clock, ciFrictionRecords: () => [] });
  const task = { id: "W1-T9402", origin: "ci-friction:check:ci-log:some-cause", title: "t", depends_on: [], files: ["src/lib/x.ts"], risk: "low" } as unknown as Task;
  const reading = port.read([task]).symptom(task)!;
  assert.deepEqual(reading.corpus, { from: "2026-10-01T00:00:00.000Z", through: "2026-11-15T00:00:00.000Z" });
  assert.equal(reading.count, 0);
  assert.equal(corpusCoversWindow(reading), true);
  const ruling = mechanicalRuling(task, { operatorReleased: false, shipped: false, declined: false, symptom: reading, familyCounts: [] });
  assert.equal(ruling !== undefined && "rule" in ruling ? ruling.rule : undefined, 2);
});

test("W1-T12838 criterion 2: a queued machine task with no reader, an unreadable reading or a zero over an uncovered window keeps its status", async (t) => {
  const f = bed(t, [
    { id: "W1-T9411", origin: "architect:no-reader" },
    { id: "W1-T9412" }, { id: "W1-T9413" }, { id: "W1-T9414" }, { id: "W1-T9415" }, { id: "W1-T9418", as: "unjudged" },
  ]);
  f.symptoms.set("W1-T9412", "throws");
  f.symptoms.set("W1-T9413", zero(PARTIAL));
  f.symptoms.set("W1-T9414", { count: 0, windowMs: WEEK });
  f.symptoms.set("W1-T9415", { count: 3, windowMs: WEEK, corpus: COVERED });
  // An unjudged `verify: auto` record meets the full rules, and its zero needs the same covered window.
  f.symptoms.set("W1-T9418", { count: 0, windowMs: WEEK });
  const ids = ["W1-T9411", "W1-T9412", "W1-T9413", "W1-T9414", "W1-T9415"];
  const before = new Map(ids.map((id) => [id, f.text(id)]));
  const unjudged = f.text("W1-T9418");
  const report = await f.run();
  assert.equal(report.retired, undefined, "no record is retired");
  for (const [id, text] of before) {
    assert.equal(f.text(id), text, `${id} is left exactly as it was`);
    assert.equal(f.task(id).status, "queued");
    assert.equal(f.ruling(id), undefined, `${id} has no ruling`);
  }
  assert.equal(f.task("W1-T9418").status, "queued");
  assert.equal(f.task("W1-T9418").retirement, undefined);
  assert.equal(f.text("W1-T9418").includes("retirement:"), false, unjudged);
  assert.equal(f.skipped("W1-T9418")?.reason, "its symptom reading does not cover the rule's whole window");
  assert.match(String(f.logs.find((l) => l.step === "machine_judge.mechanical_unavailable" && l.extra?.task_id === "W1-T9412")?.extra?.reason), /step rows unreadable/);
  // The same untrusted zero no longer retires a PARKED record either: it falls back to the judge path.
  const parked = { id: "W1-T9416", origin: "scout:x", title: "t", files: ["docs/x.md"], risk: "low" as const };
  assert.equal(mechanicalRuling(parked, { operatorReleased: false, shipped: false, declined: false, familyCounts: [], symptom: zero(PARTIAL) }), undefined);
  assert.equal(corpusCoversWindow(zero(PARTIAL)), false);
  assert.equal(corpusCoversWindow({ windowMs: WEEK }), false, "no corpus span is no coverage");
});

test("W1-T12838 criterion 2: the production port refuses an incomplete union and names no span without a rotation", (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}queued-rule-2-port-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  const task = { id: "W1-T9417", origin: "scout:x.failed", title: "t", depends_on: [] } as unknown as Task;
  const live = productionMechanicalPort({ repoRoot: stateDir, stateDir, clock, reader: (() => ({ ok: true, rows: [], unread: [] })) as never });
  const reading = live.read([task]).symptom(task)!;
  assert.equal(reading.count, 0);
  assert.equal(reading.corpus, undefined, "a live file alone proves no span");
  const incomplete = productionMechanicalPort({ repoRoot: stateDir, stateDir, clock, reader: (() => ({ ok: false, rows: [], unread: ["ledger.x.ndjson.gz"] })) as never });
  assert.throws(() => incomplete.read([task]).symptom(task), /incomplete ledger union: ledger\.x\.ndjson\.gz/);
  assert.throws(() => incomplete.read([task]).activity!(task), /incomplete ledger union: ledger\.x\.ndjson\.gz/);
  const gone = productionMechanicalPort({ repoRoot: stateDir, stateDir: join(stateDir, "absent"), clock, reader: (() => ({ ok: true, rows: [], unread: [] })) as never });
  assert.throws(() => gone.read([task]).symptom(task), /ENOENT/, "an unlistable state directory is an unreadable symptom");
});

test("W1-T12838 criterion 3: a cause whose remedy was retired by rule 2 or withdrawn reads open again to both ladders once new cost lands after the retirement", (t) => {
  const retiredAt = "2026-11-01T00:00:00.000Z";
  const shard = (kind: "retired" | "withdrawn", note: string) =>
    ["- id: W1-T9421", "  title: t", "  status: blocked", `  retirement: ${kind}  # ${note}`, ""].join("\n");
  const rule2 = mechanicalRetirementReason({ rule: 2, verdict: "retire", evidence: "the symptom had 0 occurrence(s)" }, retiredAt);
  assert.equal(retirementReopensAt(shard("retired", rule2)), retiredAt);
  assert.equal(retirementReopensAt(shard("withdrawn", `withdrawn unanswered: held 30 days. Withdrawn by the machine-filing judge (W1-T9043), ${retiredAt}`)), retiredAt);
  assert.equal(retirementReopensAt(shard("retired", `operator ruling: not worth building, ${retiredAt}`)), undefined, "an operator's retirement stays a decision");
  assert.equal(retirementReopensAt(shard("withdrawn", "withdrawn with no date")), undefined);
  // The judge's own rendering of the retirement is what the readers parse.
  const rendered = renderRetiredShard([
    "- id: W1-T9421", "  title: t", "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  risk: low",
    "  status: queued", "  attempts: 0", "  author_class: machine", "  origin: ci-friction:check:ci-log:x", "  files:", "    - src/lib/x.ts",
    "  acceptance:", "    - claim: c", "      proof: 'grep: c in src/lib/x.ts'", "",
  ].join("\n"), "plan/tasks.d/W1-T9421-x.yaml", rule2);
  assert.ok("contents" in rendered, JSON.stringify(rendered));
  assert.equal(retirementReopensAt(rendered.contents), retiredAt);

  // ci-friction: the plan reader dates the retirement from the shard text.
  const git = (args: string[]): string => args[0] === "grep" ? "origin/main:plan/tasks.d/W1-T9421-x.yaml\n"
    : args[0] === "show" ? rendered.contents : "";
  const tasks = readCiFrictionPlanTasks(git, "plan/tasks.d");
  assert.equal(tasks[0]?.reopensAt, retiredAt);
  const price = { cause: { kind: "check" as const, name: "ci-log:x" }, minutes: 30, rounds: 3, prs: 3 };
  const round = (at: string) => ({ pr: 1, cause: price.cause, minutes: 10, at });
  const ownerSearch = { filesContaining: () => [], fileExists: () => false };
  const ci = (rounds: ReturnType<typeof round>[], ts = tasks) =>
    ciFrictionLadder({ priced: [price], rounds, tasks: ts, receipts: new Set(), escalated: new Set(), ownerSearch, nowMs: NOW });
  assert.equal(ci([round("2026-10-30T00:00:00.000Z")]).ladder[0]?.state, "retired", "no cost since the retirement: still retired");
  const reopened = ci([round("2026-11-10T00:00:00.000Z")]);
  assert.notEqual(reopened.ladder[0]?.state, "retired");
  assert.equal(reopened.ladder[0]?.rung, 2, "the fresh remedy takes the next rung");
  assert.equal(reopened.next?.origin, "ci-friction:check:ci-log:x#r2");
  const operator = tasks.map(({ reopensAt: _drop, ...task }) => task);
  assert.equal(ci([round("2026-11-10T00:00:00.000Z")], operator).ladder[0]?.state, "retired", "an undated retirement stays retired");

  // flow-remedy: the same reading over its charges.
  const key = "base-red:required checks red";
  const records = (startMs: number): LedgerRecord[] => [0, 1, 2, 3].map((h) => ({
    step: "sweep.disposed", pr_number: 9533, ts: iso(startMs + h * 3_600_000), blocker: "base-red", reason: "required checks red", blocker_owner: "main-health",
  }));
  const flow = (startMs: number, reopensAt?: string) => {
    const rs = records(startMs);
    const episodes = episodesOf(rs, new Map([[9533, { state: "closed" as const, at: iso(startMs + 4 * 3_600_000) }]]), NOW);
    const top = { id: "W1-T9422", origin: `flow-blocker:${key}`, status: "blocked", retired: true, files: [], ...(reopensAt ? { reopensAt } : {}) };
    return ladderOf(FLOW_LADDER, episodes, rs, [top], NOW, markEligibility(episodes, NOW));
  };
  assert.equal(flow(Date.parse("2026-10-30T00:00:00Z"), retiredAt).ladder[0]?.state, "retired");
  const fresh = flow(Date.parse("2026-11-10T00:00:00Z"), retiredAt);
  assert.equal(fresh.ladder[0]?.state, "draft");
  assert.equal(fresh.next?.origin, `flow-blocker:${key}#r2`);
  assert.equal(flow(Date.parse("2026-11-10T00:00:00Z")).ladder[0]?.state, "retired", "an undated retirement stays retired");

  // flow-remedy's plan reader, on a real checkout, dates the same retirement.
  const repo = gitRepo({ kind: "queued-rule-2-flow-plan" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T9422-flow.yaml"), rendered.contents.replace("W1-T9421", "W1-T9422").replace("ci-friction:check:ci-log:x", `flow-blocker:${key}`));
  repo.git("add", ".");
  repo.git("commit", "-qm", "fixture");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const plan = readLadderPlan(repo.dir, FLOW_LADDER);
  assert.deepEqual(plan.tasks.map((task) => [task.id, task.reopensAt]), [["W1-T9422", retiredAt]]);
});

test("W1-T12838 criterion 4: a claimed, in-flight or open-PR queued task is never retired", async (t) => {
  const f = bed(t, [{ id: "W1-T9431" }, { id: "W1-T9432" }, { id: "W1-T9433" }, { id: "W1-T9434", as: "unjudged" }]);
  const ids = ["W1-T9431", "W1-T9432", "W1-T9433", "W1-T9434"];
  for (const id of ids) f.symptoms.set(id, zero());
  f.busy.set("W1-T9431", "a run holds its dispatch claim (run-W1-T9431-1)");
  f.busy.set("W1-T9432", "a run is in flight (run-W1-T9432-1)");
  f.busy.set("W1-T9433", "a run opened a pull request for it (https://github.com/o/r/pull/9), which may still be open");
  f.busy.set("W1-T9434", "a run is in flight (run-W1-T9434-1)");
  const before = new Map(ids.map((id) => [id, f.text(id)]));
  let report = await f.run();
  assert.equal(report.retired, undefined);
  for (const [id, text] of before) {
    assert.equal(f.text(id), text, `${id} is untouched`);
    assert.equal(f.skipped(id)?.reason, f.busy.get(id));
  }
  // A port with no activity reader, or one that throws, retires nothing either.
  f.busy.clear();
  f.port.activity = "absent";
  report = await f.run();
  assert.equal(report.retired, undefined);
  assert.match(String(f.skipped("W1-T9431")?.reason), /no reader says whether it is claimed/);
  f.port.activity = "throws";
  report = await f.run();
  assert.equal(report.retired, undefined);
  assert.match(String(f.skipped("W1-T9431")?.reason), /unreadable: claim rows unreadable/);
  for (const [id, text] of before) assert.equal(f.text(id), text);
  // Idle again, the stopped cause is retired.
  f.port.activity = "fake";
  report = await f.run();
  assert.deepEqual([...(report.retired ?? [])].sort(), ids);
});

test("W1-T12838 criterion 4: a task's activity is read from its claim, run and pull-request rows", () => {
  const row = (step: string, run: string, extra: Record<string, unknown> = {}) => ({ step, run_id: run, task_id: "W1-T9441", ...extra });
  assert.equal(taskActivity([], "W1-T9441"), undefined);
  assert.equal(taskActivity([row("dispatch.claim", "r1", { outcome: "created" })], "W1-T9441"), "a run holds its dispatch claim (r1)");
  assert.equal(taskActivity([row("dispatch.claim", "r1", { outcome: "taken" })], "W1-T9441"), undefined, "a refused claim holds nothing");
  assert.equal(taskActivity([row("dispatch.claim", "r1", { outcome: "created" }), row("run.start", "r1")], "W1-T9441"), "a run is in flight (r1)");
  assert.equal(taskActivity([row("run.start", "r1"), row("verdict", "r1", { verdict: "handed_off" })], "W1-T9441"), "a run is in flight (r1)", "a handoff is resumed");
  assert.equal(taskActivity([row("run.start", "r1"), row("verdict", "r1", { verdict: "failed" })], "W1-T9441"), undefined);
  assert.match(String(taskActivity([row("run.start", "r1"), row("pr.opened", "r1", { pr_url: "https://github.com/o/r/pull/7" }), row("verdict", "r1", { verdict: "pr_opened" })], "W1-T9441")),
    /opened a pull request for it \(https:\/\/github\.com\/o\/r\/pull\/7\)/);
  assert.equal(taskActivity([{ step: "run.start", run_id: "r9", task_id: "W1-T9999" }], "W1-T9441"), undefined, "another task's rows say nothing");

  // The production port reads those rows once, through the union, for the tasks it was given.
  const asked: unknown[] = [];
  const port = productionMechanicalPort({
    repoRoot: tmpdir(), stateDir: tmpdir(), clock,
    reader: ((_dir: string, options: { step?: unknown; where?: (r: Record<string, unknown>) => boolean }) => {
      asked.push(options.step);
      const rows = [row("run.start", "r1"), { step: "run.start", run_id: "r2", task_id: "W1-T9442" }];
      return { ok: true, rows: rows.filter((r) => options.where?.(r) ?? true), unread: [] };
    }) as never,
  });
  const task = (id: string) => ({ id, title: id, depends_on: [] }) as unknown as Task;
  const read = port.read([task("W1-T9441")]);
  assert.equal(read.activity!(task("W1-T9441")), "a run is in flight (r1)");
  assert.equal(read.activity!(task("W1-T9442")), undefined, "a task outside the pass is not read");
  assert.deepEqual(asked, [["dispatch.claim", "run.start", "verdict", "pr.opened"]], "one union read per pass");
});
