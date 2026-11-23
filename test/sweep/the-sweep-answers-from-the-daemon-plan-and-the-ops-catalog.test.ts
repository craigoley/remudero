import assert from "node:assert/strict";
import fs, { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { taskContractRevision, taskSemanticRevision } from "#src/lib/escalate.js";
import type { OpsCatalogShadowInput } from "#src/lib/ops-catalog-source.js";
import { actOnParkedPr, parkedPrFacts, parkedPrRemedy } from "#src/lib/parked-pr-remedy.js";
import { mergePlanBlobs, type Plan } from "#src/lib/plan.js";
import { buildSweepEffects, withSweepTaskReaders } from "#src/lib/sweep.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const FIRST = "W1-T900001", SECOND = "W1-T900002", OPS = "W1-T900003", LATE = "W1-T900004";
const OPS_REPOSITORY = "fixture/ops";
const CLAIM = "the fixture reads its contract";
const PROOF = "grep: fixture in src/fixture.ts";

function taskText(id: string, file = "src/fixture.ts"): string {
  return `- id: ${id}
  title: Sweep fixture
  repo: fixture
  type: implement
  status: queued
  attempts: 0
  depends_on: []
  files: [${file}]
  design: Read the fixture contract.
  acceptance:
    - claim: ${CLAIM}
      proof: "${PROOF}"
`;
}

function planOf(...texts: string[]): Plan {
  return mergePlanBlobs(texts.map((text, index) => ({ label: `fixture-${index}.yaml`, text })));
}

function fixture(t: TestContext, passPlan = planOf(taskText(FIRST), taskText(SECOND))) {
  const { dir: root } = ownedFixtureDir(t, "sweep-catalog");
  const publicDir = join(root, "public");
  const monolith = join(publicDir, "plan", "tasks.yaml");
  const shardDir = join(publicDir, "plan", "tasks.d");
  const stateDir = join(root, "state");
  mkdirSync(shardDir, { recursive: true });
  mkdirSync(stateDir);
  const destination = join(stateDir, "plan-destination.json");
  const nameDestination = (repository: string) => writeFileSync(destination, JSON.stringify({ repository, kinds: [] }));
  nameDestination(OPS_REPOSITORY);
  writeFileSync(monolith, "[]\n");
  const writeShard = (id: string, text: string) => writeFileSync(join(shardDir, `${id}-fixture.yaml`), text);
  writeShard(FIRST, taskText(FIRST));
  writeShard(SECOND, taskText(SECOND));
  let publicPlanReads = 0;
  const realRead = fs.readFileSync;
  const read = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof realRead>) => {
    if (args[0] === monolith) publicPlanReads++;
    return realRead(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    read.mock.restore();
    syncBuiltinESMExports();
  });

  let current = passPlan;
  const opsPlan = planOf(taskText(OPS, "src/ops-fixture.ts"));
  let opsSnapshot: OpsCatalogShadowInput = { outcome: "ok", plan: opsPlan };
  return {
    destination, nameDestination, opsPlan, writeShard, publicPlanReads: () => publicPlanReads,
    setOpsSnapshot: (snapshot: OpsCatalogShadowInput) => { opsSnapshot = snapshot; },
    reload: (plan: Plan) => { current = plan; },
    run: <Result>(use: (effects: ReturnType<typeof buildSweepEffects>) => Result) => withSweepTaskReaders({
      reloadPlanForFixImpl: () => current,
      opsCatalogForContract: { repository: OPS_REPOSITORY, current: () => opsSnapshot },
    }, async () => {
      await Promise.resolve();
      return use(buildSweepEffects({
        owner: "fixture", repo: "fixture", repoRoot: publicDir, config: { root } as never,
        ledgerPath: join(stateDir, "ledger.ndjson"), runId: "fixture-sweep", plan: passPlan, log: () => {},
        ciGateRequired: [],
        readJsonImpl: async (args) => assert.fail(`unexpected GitHub call: ${args.join(" ")}`),
      }));
    })(),
  };
}

test("W1-T13529 criterion 1: two parked-PR remedies and an ops contract use zero default public plan reads in one pass", async t => {
  const f = fixture(t);
  await f.run(async effects => {
    assert.ok(effects.parkedPr);
    const host = effects.parkedPr;
    for (const [index, taskId] of [FIRST, SECOND].entries()) {
      const pr = { taskId, prNumber: index + 1, prUrl: `https://github.com/fixture/fixture/pull/${index + 1}`,
        headSha: "fixture-head", unmetCriteria: [{ claim: CLAIM, proof: PROOF }] };
      const facts = await parkedPrFacts(pr, { redChecks: [], designQuestion: "Which design?", fixModelOrder: [] }, [], host);
      assert.equal(facts.taskCriteria, 1);
      const answer = await actOnParkedPr(pr, parkedPrRemedy(facts), facts, [], host, {
        cause: "needs-design", text: "Which design?", runId: "fixture-sweep", ledgerTaskId: taskId,
        nowIso: new Date().toISOString(), append: () => {},
      });
      assert.equal(answer.remedy, "fix-on-pr");
    }
    effects.readTaskContractRevision!(OPS);
    assert.equal(f.publicPlanReads(), 0, "count synchronous public monolith reads in the real default reloader");
    assert.equal(effects.readTaskContractRevision!(OPS), taskContractRevision(f.opsPlan.byId.get(OPS)!));
  });
});

test("W1-T13529 criterion 2: a running pass sees the reloaded public contract and the retained ops contract", async t => {
  const f = fixture(t);
  await f.run(async effects => {
    assert.equal(effects.readTaskContractRevision!(LATE), undefined);
    const latest = planOf(taskText(FIRST, "src/amended.ts"), taskText(LATE));
    f.writeShard(LATE, taskText(LATE));
    f.reload(latest);
    assert.equal(effects.readTaskContractRevision!(FIRST), taskContractRevision(latest.byId.get(FIRST)!));
    assert.equal(effects.readTaskContractRevision!(LATE), taskContractRevision(latest.byId.get(LATE)!));
    assert.equal((await effects.parkedPr!.readTaskShard(LATE)).outcome, "read");
    const opsTask = f.opsPlan.byId.get(OPS)!;
    assert.equal(effects.readTaskContractRevision!(OPS), taskContractRevision(opsTask));
    assert.equal(effects.readTaskSemanticRevision!(OPS), taskSemanticRevision(opsTask));
    assert.equal(f.publicPlanReads(), 0);
  });
});

test("W1-T13529 criterion 3: an unreadable ops destination refuses a missing task without reading the public plan", async t => {
  const f = fixture(t);
  writeFileSync(f.destination, "{");
  f.writeShard(LATE, taskText(LATE));
  await f.run(async effects => {
    assert.deepEqual(await effects.parkedPr!.readTaskShard(LATE), { outcome: "refused", reason: "destination-unreadable" });
    assert.equal(effects.readTaskContractRevision!(LATE), undefined);
    assert.equal(f.publicPlanReads(), 0);
  });
});

test("W1-T13529 criterion 3: stale ops snapshots and snapshots for a different destination supply no contract", async t => {
  const f = fixture(t);
  await f.run(effects => {
    const revision = effects.readTaskContractRevision!;
    assert.equal(revision(OPS), taskContractRevision(f.opsPlan.byId.get(OPS)!));
    f.nameDestination("fixture/new-ops");
    assert.equal(revision(OPS), undefined);
    f.nameDestination(OPS_REPOSITORY);
    f.setOpsSnapshot({ outcome: "stale" });
    assert.equal(revision(OPS), undefined);
    assert.equal(f.publicPlanReads(), 0);
  });
});
