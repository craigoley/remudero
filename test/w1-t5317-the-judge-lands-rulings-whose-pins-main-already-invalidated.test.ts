import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { machineShardHeaderLines } from "../src/lib/machine-filing.js";
import { MACHINE_JUDGE_STATE_FILE, runMachineFilingJudge, type MachineJudgePorts } from "../src/lib/machine-filing-judge.js";
import { loadPlan, parseTasksFromYaml } from "../src/lib/plan.js";
import { machineAuthorVerifyViolation, taskRulingPin } from "../src/lib/task-linter.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const ID = "W1-T9001";
const PATH = "plan/tasks.d/W1-T9001-pin.yaml";
const URL = "https://github.com/example/fixture/pull/1";

function shard(id = ID): string {
  return [
    `- id: ${id}`, `  title: record the remedy for ${id}`, "  repo: remudero",
    "  depends_on: []", "  type: implement", ...machineShardHeaderLines(["docs/remedy.md"]),
    "  origin: ci-friction:fixture", "  files: [docs/remedy.md]", "  acceptance:",
    `    - claim: the remedy for ${id} is recorded`, `      proof: 'grep: ${id} in docs/remedy.md'`, "",
  ].join("\n");
}

function fixture() {
  const main = gitRepo({ kind: "judge-pins-main" });
  mkdirSync(join(main.dir, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(main.dir, "plan/tasks.yaml"), "[]\n");
  writeFileSync(join(main.dir, PATH), shard());
  main.git("add", ".");
  main.git("commit", "-qm", "seed plan");
  const local = gitRepo({ cloneFrom: main.dir, kind: "judge-pins-local" });
  const logs: { step: string; extra?: Record<string, unknown> }[] = [];
  const lands: { paths: string[]; body: string; contents: string[] }[] = [];
  const proposals: unknown[] = [];
  let asked = 0;
  let beforeLanding = () => {};
  const p: MachineJudgePorts = {
    stateDir: local.dir,
    plan: () => loadPlan(join(local.dir, "plan/tasks.yaml")),
    riskJudge: async () => (asked++, { verdict: "low", confidence: 0.99, reasons: ["a docs remedy"] }),
    openWorkspace: () => {
      const landing = gitRepo({ cloneFrom: main.dir, kind: "judge-pins-landing" });
      beforeLanding();
      return {
        root: landing.dir,
        land: ({ paths, body }) => {
          lands.push({ paths, body, contents: paths.map((path) => readFileSync(join(landing.dir, path), "utf8")) });
          return URL;
        },
        dispose: () => landing.cleanup(),
      };
    },
    prState: () => "open",
    stageProposal: (proposal) => void proposals.push(proposal),
    log: (step, extra) => void logs.push({ step, extra }),
    clock: fixedClock(1790980000000),
  };
  return {
    main, local, p, logs, lands, proposals, asked: () => asked,
    beforeLanding: (fn: () => void) => { beforeLanding = fn; },
    advance: (text: string | undefined) => {
      if (text === undefined) rmSync(join(main.dir, PATH));
      else writeFileSync(join(main.dir, PATH), text);
      main.git("add", "-A");
      main.git("commit", "-qm", "concurrent plan change");
    },
    sync: () => {
      local.git("fetch", "origin");
      cpSync(join(main.dir, "plan"), join(local.dir, "plan"), { recursive: true });
    },
    state: () => JSON.parse(readFileSync(join(local.dir, MACHINE_JUDGE_STATE_FILE), "utf8")),
    cleanup: () => { local.cleanup(); main.cleanup(); },
  };
}

test("W1-T5317: a pin a concurrent plan PR invalidated is dropped before the judge pushes", async () => {
  for (const change of [shard().replace("record the remedy", "rewrite the remedy"), shard() + "  retirement: retired\n", undefined]) {
    const f = fixture();
    try {
      f.beforeLanding(() => f.advance(change));
      const report = await runMachineFilingJudge(f.p);
      assert.equal(f.lands.length, 0);
      assert.equal(report.prUrl, undefined);
      assert.deepEqual(report.proceeded, []);
      assert.deepEqual(report.refused, []);
      assert.equal(f.state().pending, undefined);
      assert.equal(f.state().rulings?.[ID], undefined);
      assert.equal(f.state().declined?.[ID], undefined);
      const stale = f.logs.find((row) => row.step === "machine_judge.pin_stale")?.extra;
      assert.equal(stale?.task_id, ID);
      assert.equal(typeof stale?.pin, "string");
      const current = change === undefined ? undefined : loadPlan(join(f.main.dir, "plan/tasks.yaml")).byId.get(ID);
      assert.equal(stale?.main_pin, current ? taskRulingPin(current) : null);
    } finally { f.cleanup(); }
  }
});

test("W1-T5317: an open judge PR whose pin main has since invalidated is withdrawn and re-judged", async () => {
  const f = fixture();
  const shim = ghShim();
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  try {
    await runMachineFilingJudge(f.p);
    const pin = f.state().pending.records[0].pin;
    f.advance(shard().replace("record the remedy", "rewrite the remedy"));
    const mainPin = taskRulingPin(loadPlan(join(f.main.dir, "plan/tasks.yaml")).byId.get(ID)!);
    await runMachineFilingJudge(f.p);
    const closes = shim.calls().filter((call) => call.startsWith("pr close "));
    assert.equal(closes.length, 1);
    assert.ok(closes[0]!.includes(`pr close ${URL} --comment`));
    const recorded = shim.calls().join("\n");
    for (const evidence of [ID, pin, mainPin]) assert.ok(recorded.includes(evidence));
    assert.ok(f.logs.some((row) => row.step === "machine_judge.withdrawn"));
    assert.equal(f.state().pending, undefined);
    assert.equal(f.state().declined?.[ID], undefined);
    assert.equal(f.state().rulings?.[ID], undefined);
    f.sync();
    await runMachineFilingJudge(f.p);
    assert.equal(f.asked(), 2);
    assert.equal(f.lands.length, 2);
    assert.deepEqual(f.state().pending.ids, [ID]);
  } finally {
    process.env.PATH = originalPath;
    rmSync(shim.dir, { recursive: true, force: true });
    f.cleanup();
  }
});

test("W1-T5317: a judge PR whose pins all still hold on main is left to merge", async () => {
  const f = fixture();
  try {
    await runMachineFilingJudge(f.p);
    assert.equal(f.lands.length, 1);
    const landed = parseTasksFromYaml(f.lands[0]!.contents[0]!, PATH)[0]!;
    assert.equal(machineAuthorVerifyViolation(landed), undefined);
    assert.equal(landed.risk_ruling?.pin, taskRulingPin(landed));
    const rendered = loadPlan(join(f.local.dir, "plan/tasks.yaml")).byId.get(ID)!;
    assert.equal(rendered.verify, "human");
    const pending = f.state().pending;
    assert.notEqual(pending.records[0].pin, taskRulingPin(rendered), "release changes verify and inserts priority");
    f.advance(shard() + "  rationale: unrelated prose changed\n");
    await runMachineFilingJudge(f.p);
    assert.deepEqual(f.state().pending, pending);
    assert.equal(f.asked(), 1);
    assert.equal(f.lands.length, 1);
    assert.ok(f.logs.some((row) => row.step === "machine_judge.waiting"));
    assert.ok(!f.logs.some((row) => row.step === "machine_judge.withdrawn"));
  } finally { f.cleanup(); }
});

test("stale records leave a mixed landing while unchanged records still land", async () => {
  const f = fixture();
  const otherPath = "plan/tasks.d/W1-T9002-pin.yaml";
  try {
    writeFileSync(join(f.main.dir, otherPath), shard("W1-T9002"));
    f.main.git("add", ".");
    f.main.git("commit", "-qm", "another due record");
    f.sync();
    f.p.riskJudge = async () => ({ verdict: "high", confidence: 0.99, reasons: ["needs an operator"] });
    f.beforeLanding(() => f.advance(shard() + "  retirement: retired\n"));
    const report = await runMachineFilingJudge(f.p);
    assert.deepEqual(f.lands[0]!.paths, [otherPath]);
    assert.deepEqual(report.escalated, ["W1-T9002"]);
    assert.deepEqual(f.state().pending.ids, ["W1-T9002"]);
    assert.equal(f.proposals.length, 1, "a stale escalation does not reach the inbox");
    assert.ok(!f.lands[0]!.body.includes(ID));
    assert.equal(f.state().rulings?.[ID], undefined);
  } finally { f.cleanup(); }
});

test("a dropped landing is judged again once the current plan is read", async () => {
  const f = fixture();
  try {
    f.beforeLanding(() => f.advance(shard().replace("record the remedy", "rewrite the remedy")));
    await runMachineFilingJudge(f.p);
    f.beforeLanding(() => {});
    f.sync();
    await runMachineFilingJudge(f.p);
    assert.equal(f.asked(), 2);
    assert.equal(f.lands.length, 1);
    const task = parseTasksFromYaml(f.lands[0]!.contents[0]!, PATH)[0]!;
    assert.equal(task.title, `rewrite the remedy for ${ID}`);
    assert.equal(machineAuthorVerifyViolation(task), undefined);
  } finally { f.cleanup(); }
});

test("retired and removed pending records withdraw the whole PR without declining it", async () => {
  const shim = ghShim();
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  try {
    for (const change of [shard() + "  retirement: retired\n", undefined]) {
      const f = fixture();
      try {
        await runMachineFilingJudge(f.p);
        f.advance(change);
        await runMachineFilingJudge(f.p);
        assert.equal(f.state().pending, undefined);
        assert.equal(f.state().declined?.[ID], undefined);
        const withdrawal = f.logs.find((row) => row.step === "machine_judge.withdrawn");
        assert.equal((withdrawal?.extra?.stale as { id: string }[])[0]!.id, ID);
      } finally { f.cleanup(); }
    }
    assert.equal(shim.calls().filter((call) => call.startsWith("pr close ")).length, 2);
  } finally {
    process.env.PATH = originalPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("a failed withdrawal keeps the pending PR and cached rulings for retry", async () => {
  const f = fixture();
  const shim = ghShim([{ when: "pr close", stderr: "close unavailable", exit: 1 }]);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  try {
    await runMachineFilingJudge(f.p);
    const state = f.state();
    f.advance(shard().replace("record the remedy", "rewrite the remedy"));
    await assert.rejects(runMachineFilingJudge(f.p), /close unavailable/);
    assert.deepEqual(f.state(), state);
    assert.ok(!f.logs.some((row) => row.step === "machine_judge.withdrawn"));
  } finally {
    process.env.PATH = originalPath;
    rmSync(shim.dir, { recursive: true, force: true });
    f.cleanup();
  }
});

test("an unavailable merge target neither pushes nor clears a pending PR", async () => {
  const f = fixture();
  try {
    f.beforeLanding(() => rmSync(f.main.dir, { recursive: true, force: true }));
    await assert.rejects(runMachineFilingJudge(f.p), /git/);
    assert.equal(f.lands.length, 0);
    assert.equal(f.state().pending, undefined);
  } finally { f.cleanup(); }
  const waiting = fixture();
  try {
    await runMachineFilingJudge(waiting.p);
    const state = waiting.state();
    rmSync(waiting.main.dir, { recursive: true, force: true });
    await assert.rejects(runMachineFilingJudge(waiting.p), /git/);
    assert.deepEqual(waiting.state(), state);
    assert.equal(waiting.lands.length, 1);
  } finally { waiting.cleanup(); }
});

test("legacy pending state checks its cached source pin against freshly fetched main", async () => {
  const f = fixture();
  try {
    await runMachineFilingJudge(f.p);
    const state = f.state();
    delete state.pending.records;
    delete state.pending.repoRoot;
    writeFileSync(join(f.local.dir, MACHINE_JUDGE_STATE_FILE), JSON.stringify(state));
    await runMachineFilingJudge(f.p);
    assert.deepEqual(f.state(), state);
    assert.equal(f.lands.length, 1);
    assert.equal(f.asked(), 1);
  } finally { f.cleanup(); }
});
