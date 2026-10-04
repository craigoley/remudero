import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import { gateGardenSpec, loadGateProbes, renderDefuseShard, type GateDefuseSources } from "../src/lib/gate-gardener.js";
import { runGarden, type GardenCheckout } from "../src/lib/gardener.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { lintPlanCommand } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOW = Date.parse("2026-10-04T00:00:00Z");
const DAY = 86_400_000;
const FILE = "test/fixture.test.ts";
const ORIGIN = `expiring-fixture:${FILE}`;
const probes = loadGateProbes(ROOT);

async function fixture(daysLeft = 14, extra = "") {
  const repo = gitRepo({ kind: "defuse-garden" });
  const put = (path: string, text: string) => {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  const stamp = new Date(NOW + (daysLeft - 30) * DAY).toISOString();
  put(FILE, `const row = {\n  lastActivityAt: "${stamp}",\n  postedAt: "${stamp}",\n};\n${extra}`);
  put("scripts/source-size-baseline.json", "{}\n");
  put("scripts/comment-load-baseline.json", "{}\n");
  put("scripts/learnings-budget-baseline.json", '{"measuredChars":0,"measuredActiveEntries":0}\n');
  put(".github/workflows/ci-gate.yml", 'jobs:\n  ci-gate:\n    env:\n      REQUIRED: >-\n        [\n        "ci"\n        ]\n      ADVISORY: >-\n        [\n        "dashboard"\n        ]\n');
  put("plan/tasks.yaml", "[]\n");
  put("test/expiring-fixture-census.test.ts", "export {};\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "seed census fixture");
  mkdirSync(join(repo.dir, "state"));
  for (const c of ["tighten", "refresh", "demote"]) put(`state/GATE_OFF-${c}`, "");
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let minted = 0;
  const deps = {
    repoRoot: repo.dir, stateDir: join(repo.dir, "state"), clock: fixedClock(NOW), seed: 1,
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }),
    openWorkspace: () => ({
      root: repo.dir, branch: "run-unfiled-1791072000000",
      land: (opts: { paths: string[]; title: string; body: string }) => {
        landed.push(opts);
        return "https://github.com/acme/remudero/pull/1";
      },
      dispose: () => {},
    }),
  };
  const sources = {
    thresholdDays: 30,
    mintTaskId: (branch: string) => {
      assert.equal(branch, "run-unfiled-1791072000000");
      return `W1-T${6000 + ++minted}`;
    },
    openOrigins: () => [] as string[],
  };
  return { repo, put, deps, sources, landed, rows, probes: await probes, minted: () => minted };
}

test("W1-T5539: a crossing inside the lead horizon files one defuse shard only when admission permits it", async () => {
  const f = await fixture();
  const spec = gateGardenSpec(f.deps, f.probes, f.sources);
  const inv = spec.inventory();
  const actions = inv.candidates.filter((a) => a.class === "defuse");
  assert.equal(actions.length, 1, "two stamps in one file produce only one finding");
  const pass = runGarden(spec, f.deps);
  assert.deepEqual(pass.plan?.acting, ["defuse"]);
  assert.equal(f.landed.length, 0);
  assert.equal(f.minted(), 0, "an inadmissible filing must not reserve an id");
  assert.match(String(f.rows.find((r) => r.step === "gate.garden_filing_failed")?.extra?.reason), /machine-filing-admission/);
  const path = "plan/tasks.d/W1-T6001-defuse-fixture.yaml";
  const { text, refused } = renderDefuseShard(actions[0]!, "W1-T6001");
  assert.equal(refused, undefined, "the shared renderer alone cannot see base-only admission");
  f.put(path, text);
  const task = loadPlanFromYaml(text, path).tasks[0]!;
  assert.equal(task.origin, ORIGIN);
  assert.equal(task.author_class, "machine");
  assert.deepEqual(task.files, [FILE]);
  assert.match(task.rationale!, /test\/fixture.test.ts:2/);
  assert.match(task.rationale!, /2026-10-18T00:00:00.000Z/);
  assert.match(task.rationale!, /sweep.staleDays/);
  assert.match(task.rationale!, /injected clock/);
  assert.match(task.rationale!, /relative/);
  assert.match(task.acceptance![0]!.claim!, /past.*2026-10-18/);
  assert.equal(f.rows.filter((r) => r.step === "gate_garden.defuse_filed").length, 0);
  const code = await lintPlanCommand(["--plan", join(f.repo.dir, "plan/tasks.yaml"), "--base", "HEAD"], {
    offline: true, repoRoot: f.repo.dir,
  });
  assert.equal(code, 1, "REFUSED criterion 1: base admission requires a plan.ts change outside the declared scope");
});

test("W1-T5539: a covered fixture is deferred, not refiled", async () => {
  const f = await fixture();
  runGarden(gateGardenSpec(f.deps, f.probes, { ...f.sources, openOrigins: () => [ORIGIN] }), f.deps);
  assert.equal(f.landed.length, 0);
  assert.equal(f.minted(), 0);
  assert.deepEqual(f.rows.filter((r) => r.step === "gate_garden.defuse_deferred").map((r) => r.extra), [{
    file: FILE, line: 2, crossingDate: "2026-10-18T00:00:00.000Z", leadDays: 21,
  }]);
});

test("W1-T5539: queued shards cover a file and urgent crossings have priority one", async () => {
  const queued = await fixture();
  queued.put("plan/tasks.d/defuse.yaml", `- id: W1-T5999\n  title: defuse fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: human\n  risk: low\n  status: queued\n  attempts: 0\n  origin: ${ORIGIN}\n`);
  runGarden(gateGardenSpec(queued.deps, queued.probes, queued.sources), queued.deps);
  assert.equal(queued.landed.length, 0);
  assert.equal(queued.minted(), 0);
  assert.equal(queued.rows.filter((r) => r.step === "gate_garden.defuse_deferred").length, 1);
  const urgent = await fixture(3);
  const action = gateGardenSpec(urgent.deps, urgent.probes, urgent.sources).inventory().candidates.find((a) => a.class === "defuse")!;
  assert.equal(loadPlanFromYaml(renderDefuseShard(action, "W1-T6002").text, "urgent").tasks[0]!.priority, 1);
});

test("W1-T5539: time advancing without a commit discovers the lead crossing", async () => {
  const f = await fixture(22);
  const before = runGarden(gateGardenSpec(f.deps, f.probes, f.sources), f.deps);
  assert.equal(before.prUrl, undefined);
  const later = { ...f.deps, clock: fixedClock(NOW + 2 * DAY) };
  const pass = runGarden(gateGardenSpec(later, f.probes, f.sources), later);
  assert.deepEqual(pass.plan?.acting, ["defuse"]);
  assert.equal(pass.plan?.actions.length, 1);
});

test("W1-T5539: the default open filing reader recognizes the per-file origin", async () => {
  const f = await fixture();
  let queries = 0;
  const { openOrigins: _openOrigins, ...sources } = f.sources;
  const spec = gateGardenSpec(f.deps, f.probes, {
    ...sources,
    execFile: (command, args, options) => {
      if (command !== "gh") return execFileSync(command, args, options);
      queries++;
      assert.deepEqual(args, ["pr", "list", "--state", "open", "--limit", "1000", "--json", "body"]);
      return JSON.stringify([{ body: `A different file: expiring-fixture:test/other.test.ts\nFiling: \`${ORIGIN}\`` }]);
    },
  });
  assert.equal(spec.inventory().candidates.filter((a) => a.class === "defuse").length, 0);
  assert.equal(queries, 1);
  assert.equal(f.rows.filter((r) => r.step === "gate_garden.defuse_deferred").length, 1);
});

test("W1-T5539: unreadable open filing evidence fails the pass rather than claiming absence", async () => {
  const f = await fixture();
  const spec = gateGardenSpec(f.deps, f.probes, { ...f.sources, openOrigins: () => { throw new Error("open PRs unavailable"); } });
  assert.throws(() => spec.inventory(), /open PRs unavailable/);
  assert.equal(f.minted(), 0);
  assert.equal(f.rows.length, 0);
});

async function filingFixture(sources: GateDefuseSources = {}) {
  const f = await fixture();
  const spec = gateGardenSpec(f.deps, f.probes, {
    ...f.sources,
    admissionViolations: (task, context) => {
      assert.equal(task.origin, ORIGIN);
      assert.equal(task.verify, "human");
      assert.equal(context.plan.tasks[0], task);
      assert.equal(context.releasedIds.size, 0);
      assert.equal(context.pathExists!(FILE), true);
      assert.equal(context.pathExists!("test/missing.test.ts"), false);
      return [];
    },
    ...sources,
  });
  const action = spec.inventory().candidates.find((a) => a.class === "defuse")!;
  const workspace: GardenCheckout = f.deps.openWorkspace();
  const apply = () => spec.apply(workspace, { acting: ["defuse"], actions: [action] }, {});
  return { ...f, workspace, action, apply };
}

test("W1-T5539: an admitted filing writes its reserved shard and logs only a landed remedy", async () => {
  const f = await filingFixture();
  const result = f.apply()!;
  assert.equal(f.minted(), 1);
  assert.deepEqual(result.paths, ["plan/tasks.d/W1-T6001-defuse-fixture.yaml"]);
  const task = loadPlanFromYaml(readFileSync(join(f.repo.dir, result.paths[0]!), "utf8"), "filed").tasks[0]!;
  assert.equal(task.id, "W1-T6001");
  assert.equal(task.origin, ORIGIN);
  assert.deepEqual(task.files, [FILE]);
  assert.equal(task.author_class, "machine");
  assert.match(result.title, /file 1 expiring fixture remedy task/);
  assert.match(result.body, /proof: grep: expiring-fixture:test\/fixture.test.ts in plan\/tasks.d\/W1-T6001-defuse-fixture.yaml/);
  assert.equal(f.rows.some((r) => r.step === "gate_garden.defuse_filed"), false);
  assert.equal(f.workspace.land(result), "https://github.com/acme/remudero/pull/1");
  assert.deepEqual(f.landed, [result]);
  assert.deepEqual(f.rows.filter((r) => r.step === "gate_garden.defuse_filed").map((r) => r.extra), [{
    file: FILE, line: 2, crossingDate: "2026-10-18T00:00:00.000Z", leadDays: 21,
  }]);
});

test("W1-T5539: an unlanded or failed filing never logs a filed remedy", async () => {
  for (const throws of [false, true]) {
    const f = await filingFixture();
    f.workspace.land = () => {
      if (throws) throw new Error("landing failed");
      return undefined;
    };
    const result = f.apply()!;
    if (throws) assert.throws(() => f.workspace.land(result), /landing failed/);
    else assert.equal(f.workspace.land(result), undefined);
    assert.equal(f.rows.some((r) => r.step === "gate_garden.defuse_filed"), false);
  }
});

test("W1-T5539: reservation output must contain a held id before writing a shard", async () => {
  for (const output of ["RESERVED W1-T6010 on origin\n", "unreserved W1-T6010\n"]) {
    let reservations = 0;
    const f = await filingFixture({
      mintTaskId: undefined,
      execFile: (command, args, options) => {
        if (command !== process.execPath) return execFileSync(command, args, options);
        reservations++;
        assert.deepEqual(args, ["--import", "tsx", join(options.cwd, "src/run-task.ts"), "next-task-id", "--reserve", "--branch", "run-unfiled-1791072000000"]);
        return output;
      },
    });
    if (output.startsWith("RESERVED")) {
      assert.deepEqual(f.apply()!.paths, ["plan/tasks.d/W1-T6010-defuse-fixture.yaml"]);
    } else {
      assert.throws(f.apply, /task-id reservation returned no held id/);
      assert.equal(existsSync(join(f.repo.dir, "plan/tasks.d")), false);
    }
    assert.equal(reservations, 1);
    assert.equal(f.rows.some((r) => r.step === "gate_garden.defuse_filed"), false);
  }
});

test("W1-T5539: the default reservation process runs in the operator checkout", async () => {
  const f = await filingFixture({ mintTaskId: undefined });
  symlinkSync(join(ROOT, "node_modules"), join(f.repo.dir, "node_modules"), "dir");
  f.put("src/run-task.ts", `import assert from "node:assert/strict";
assert.equal(process.cwd(), ${JSON.stringify(f.repo.dir)});
assert.deepEqual(process.argv.slice(2), ["next-task-id", "--reserve", "--branch", "run-unfiled-1791072000000"]);
process.stdout.write("RESERVED W1-T6011 on origin\\n");
`);
  assert.deepEqual(f.apply()!.paths, ["plan/tasks.d/W1-T6011-defuse-fixture.yaml"]);
  const failing = await filingFixture({ mintTaskId: undefined });
  symlinkSync(join(ROOT, "node_modules"), join(failing.repo.dir, "node_modules"), "dir");
  failing.put("src/run-task.ts", 'throw new Error("reservation unavailable");\n');
  assert.throws(failing.apply, /reservation unavailable/);
  assert.equal(existsSync(join(failing.repo.dir, "plan/tasks.d")), false);
  assert.equal(failing.rows.some((r) => r.step === "gate_garden.defuse_filed"), false);
});

test("W1-T5539: malformed filings and missing branches fail before reservation", async () => {
  const branchless = await filingFixture();
  Reflect.deleteProperty(branchless.workspace, "branch");
  assert.throws(branchless.apply, /filing workspace has no branch/);
  assert.equal(branchless.minted(), 0);
  const mixed = await filingFixture();
  mixed.action.edit = { kind: "row", key: "fixture", to: 1 };
  assert.throws(mixed.apply, /mixed defuse plan/);
  assert.equal(mixed.minted(), 0);
  const invalid = await filingFixture();
  assert.equal(invalid.action.edit.kind, "defuse");
  if (invalid.action.edit.kind === "defuse") invalid.action.edit.finding.file = "test/fixture.test.ts\n    - [";
  assert.throws(invalid.apply, /defuse shard refused/);
  assert.equal(invalid.minted(), 0);
  assert.equal(existsSync(join(invalid.repo.dir, "plan/tasks.d")), false);
});

test("W1-T5539: an invalid reserved id fails rendering without writing or claiming a filing", async () => {
  const f = await filingFixture({ mintTaskId: () => "W1-T6012\n  title: [" });
  assert.throws(f.apply, /defuse shard refused/);
  assert.equal(existsSync(join(f.repo.dir, "plan/tasks.d")), false);
  assert.equal(f.rows.some((r) => r.step === "gate_garden.defuse_filed"), false);
});

test("W1-T5539: the defuse proof matches its own title under the executor's grep when the path holds a backslash", async () => {
  const f = await fixture();
  const action = gateGardenSpec(f.deps, f.probes, f.sources).inventory().candidates.find((a) => a.class === "defuse")!;
  assert.equal(action.edit.kind, "defuse");
  if (action.edit.kind === "defuse") action.edit.finding.file = "test/a\\d[1]*.test.ts";
  const task = loadPlanFromYaml(renderDefuseShard(action, "W1-T6013").text, "backslash").tasks[0]!;
  const pattern = /^grep: (.*) in test\/a\\d\[1\]\*\.test\.ts$/.exec(task.acceptance![0]!.proof!)?.[1];
  assert.ok(pattern, task.acceptance![0]!.proof);
  const target = join(f.repo.dir, "proof-target.txt");
  writeFileSync(target, `test("W1-T6013: test/a\\d[1]*.test.ts stays defused across 2026-10-18T00:00:00.000Z", () => {});\n`);
  assert.match(execFileSync("grep", ["-arn", "--", pattern, target], { encoding: "utf8" }), /^1:/);
  writeFileSync(target, `test("W1-T6013: test/ad[1]*.test.ts stays defused across 2026-10-18T00:00:00.000Z", () => {});\n`);
  assert.throws(() => execFileSync("grep", ["-arn", "--", pattern, target], { encoding: "utf8", stdio: "pipe" }));
});
