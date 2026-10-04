import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import { gateGardenSpec, loadGateProbes, renderDefuseShard } from "../src/lib/gate-gardener.js";
import { runGarden } from "../src/lib/gardener.js";
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
