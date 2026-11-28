import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { gardenStatePath, readGardenState, runGardenAsync, type GardenerDeps, type GardenLandOpts } from "#src/lib/gardener.js";
import { productionPlanGardenOps, type PlanGardenOps, type PlanOpsRead } from "#src/lib/plan-gardener.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { PR_OPEN_SATISFIED_BY_MAIN_STEP } from "#src/lib/pr-open.js";
import { buildRedesignSources, REDESIGN_JUDGED_STEP, redesignCandidates, redesignGardenSpec, type RedesignSources } from "#src/lib/redesign-gardener.js";
import { commentOnlyGrepProofRefusal, parseAcceptanceBlock, parseWhitelistedProof } from "#src/lib/review.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const PUBLIC_ID = "W1-T100";
const OPS_ID = "W1-T101";
const PUBLIC_SHARD = "plan/tasks.d/public.yaml";
const OPS_SHARD = "plan/tasks.d/ops.yaml";
const PIN = "a".repeat(40);
const clock = fixedClock(Date.parse("2026-11-27T12:00:00Z"));
const answer = (value: object) => `REDESIGN: ${JSON.stringify(value)}`;
const amend = answer({ verdict: "amend", amendment: "Exercise the runtime entry point.", reason: "The task needs a clearer test boundary." });
const retire = answer({ verdict: "retire", retirement: "closed", reason: "The work is already complete." });

function record(id: string): string {
  return [
    `- id: ${id}`, "  title: cover the entry point", "  repo: remudero", "  type: implement",
    "  verify: auto", "  risk: low", "  depends_on: []", "  status: queued",
    `  # refusal-amendment (${id}, run run-example, 2026-11-27T08:00:00.000Z): the worker refused criterion 1`,
    `  #   worker evidence: ${id} needs a runtime test.`,
    "  files:", "    - src/example.ts", "  acceptance:", "    - claim: the entry point works",
    '      proof: "grep: entry in src/example.ts"', "",
  ].join("\n");
}

function opsRead(rel = OPS_SHARD, text = record(OPS_ID)): Extract<PlanOpsRead, { outcome: "ok" }> {
  return { outcome: "ok", pin: PIN, tasks: parseTasksFromYaml(text, rel),
    shards: new Map([[OPS_ID, rel]]), sources: new Map([[rel, text]]) };
}

function fixture(t: TestContext, response = amend) {
  const { dir: root } = gitRepo({ scope: t, kind: "redesign-ops" });
  const stateDir = join(root, "state");
  for (const dir of ["plan/tasks.d", "src", "state"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "plan/tasks.yaml"), "[]\n");
  writeFileSync(join(root, PUBLIC_SHARD), record(PUBLIC_ID));
  writeFileSync(join(root, "src/example.ts"), "export {};\n");
  const landed: GardenLandOpts[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const deps: GardenerDeps = {
    repoRoot: root, stateDir, clock, seed: 1,
    log: (step, data) => { rows.push({ ...data, step, ts: clock.iso() }); },
    mergedPlanLint: () => undefined,
    openWorkspace: () => ({
      root, land: (opts) => { landed.push(opts); return "https://example.test/pull/100"; }, dispose: () => {},
    }),
  };
  const overrides: Partial<RedesignSources> = {
    judgeText: async () => response,
    ledger: (steps, since) => rows.filter((r) => steps.includes(String(r.step)) && String(r.ts) >= since),
  };
  return { root, deps, landed, overrides, rows, readPublic: () => readFileSync(join(root, PUBLIC_SHARD), "utf8") };
}

test("W1-T14882 criterion 1: the Architect reads pointers from their own catalog even when shard paths coincide", (t) => {
  const w = fixture(t);
  const before = redesignCandidates(buildRedesignSources(w.deps, w.overrides));
  assert.deepEqual(before.map((c) => c.id), [PUBLIC_ID]);
  const candidates = redesignCandidates(buildRedesignSources(w.deps, w.overrides, opsRead(PUBLIC_SHARD)));
  assert.deepEqual(candidates.map((c) => c.id), [PUBLIC_ID, OPS_ID]);
  assert.deepEqual(candidates[0], before[0]);
  assert.equal(candidates[1]!.text, record(OPS_ID));
  assert.match(candidates[1]!.evidence.join("\n"), /worker evidence: W1-T101 needs a runtime test/);
});

test("W1-T14882 criterion 2: an ops amendment goes through the sealed ops landing beside a public amendment", async (t) => {
  const w = fixture(t);
  const destination = { owner: "craigoley", repo: "remudero-ops" };
  const checkout = join(w.root, "repos", destination.repo);
  mkdirSync(join(checkout, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(w.deps.stateDir, "plan-destination.json"), JSON.stringify({ repository: "craigoley/remudero-ops", kinds: ["task"] }));
  const ops = productionPlanGardenOps({
    repoRoot: w.root, stateDir: w.deps.stateDir, stateRoot: w.root, log: w.deps.log,
    landTaskFiles: async (root, inputs, opts) => {
      calls.push({ root, inputs, target: opts.targetRepository });
      return { landed: inputs.map((input) => input.relPath), waiting: [], refused: [], setAside: [], pushed: true };
    },
  });
  const calls: Array<{ root: string; inputs: readonly { relPath: string; content: string; claim: string; proof: string }[]; target: unknown }> = [];
  const snapshot = opsRead();
  const pins: string[] = [];
  await runGardenAsync(redesignGardenSpec(w.deps, w.overrides, {
    read: async () => snapshot,
    land: (inputs, pin) => { pins.push(pin); ops.land(inputs, pin); },
  }), w.deps);
  await ops.settled();
  assert.deepEqual(w.landed.map((p) => p.paths), [[PUBLIC_SHARD]]);
  assert.match(w.readPublic(), /amendment: \|/);
  assert.deepEqual(pins, [PIN]);
  assert.equal(calls.length, 1);
  const { root, inputs, target } = calls[0]!;
  assert.equal(root, checkout);
  assert.deepEqual(target, destination);
  assert.deepEqual(inputs.map((input) => input.relPath), [OPS_SHARD]);
  const input = inputs[0]!;
  const [edited] = parseTasksFromYaml(input.content, OPS_SHARD);
  assert.equal(edited!.id, OPS_ID);
  assert.match(edited!.amendment!, /Exercise the runtime entry point/);
  const [criterion] = parseAcceptanceBlock(`## Acceptance\n- ${input.claim} | ${input.proof}`);
  assert.equal(criterion?.proof, input.proof);
  const proof = parseWhitelistedProof(input.proof);
  assert.ok(proof?.kind === "grep");
  const prove = () => spawnSync(proof.command, proof.args, { cwd: checkout }).status;
  const shardPath = join(checkout, OPS_SHARD);
  writeFileSync(shardPath, snapshot.sources.get(OPS_SHARD)!);
  assert.equal(prove(), 1, "the pinned record lacks the amendment");
  writeFileSync(shardPath, input.content);
  assert.equal(prove(), 0, "the sealed landing carries a proof of the edit");
  assert.equal(commentOnlyGrepProofRefusal(input.proof, () => input.content), undefined);
  const signature = /^  # redesign: signature=([a-f0-9]{16})$/m.exec(input.content)?.[1];
  assert.ok(signature);
  const pending = readGardenState(gardenStatePath(w.deps.stateDir, "redesign"), ["amend", "retire"]).pending;
  assert.ok(pending?.targets?.length);
  assert.ok(!pending.targets.some((target) => target.target === signature), "the public PR cannot settle the ops signature");
});

test("W1-T14882 criterion 2: an ops-only retirement uses its pinned record even when the public path coincides", async (t) => {
  const w = fixture(t, retire);
  w.deps.log(PR_OPEN_SATISFIED_BY_MAIN_STEP, { task_id: OPS_ID, branch: `run-${OPS_ID}-100`, head_sha: PIN, changed_files: ["src/example.ts"] });
  const landed: string[] = [];
  await runGardenAsync(redesignGardenSpec(w.deps, w.overrides, {
    read: () => opsRead(PUBLIC_SHARD),
    land: (inputs) => {
      assert.match(inputs[0]!.proof, /^grep: \^  retirement: closed/);
      landed.push(...inputs.map((input) => input.content));
    },
  }), w.deps);
  assert.equal(landed.length, 1);
  const [retired] = parseTasksFromYaml(landed[0]!, PUBLIC_SHARD);
  assert.deepEqual([retired!.id, retired!.status, retired!.retirement], [OPS_ID, "blocked", "closed"]);
  assert.deepEqual(w.landed, []);
  assert.equal(w.readPublic(), record(PUBLIC_ID));
});

test("an ops amendment needs a data line that its pinned shard does not already hold", async (t) => {
  const amendment = "Exercise the runtime entry point.";
  const reason = "The task needs a clearer test boundary.";
  const w = fixture(t, answer({ verdict: "amend", amendment, reason, files_add: ["src/example.ts"] }));
  const text = record(OPS_ID) + [
    "  amendment: |", `    2026-11-27, by the redesign Architect (machine, rule 16): ${reason}`, `    ${amendment}`, "",
  ].join("\n");
  await runGardenAsync(redesignGardenSpec(w.deps, w.overrides, {
    read: () => opsRead(OPS_SHARD, text),
    land: () => assert.fail("the ops landing needs a discriminating data line"),
  }), w.deps);
  assert.ok(w.rows.some((row) => row.step === REDESIGN_JUDGED_STEP && row.task_id === OPS_ID &&
    row.outcome === "refused" && row.reason === "the ops edit adds no data line for its landing proof"));
});

test("W1-T14882 criterion 3: an off or unreadable ops source preserves the public candidates, actions and landing", async (t) => {
  const run = async (read?: PlanOpsRead) => {
    const w = fixture(t);
    let reads = 0;
    const ops: PlanGardenOps | undefined = read && {
      read: async () => { reads++; return read; },
      land: () => assert.fail("public-only pass started an ops landing"),
    };
    const pass = await runGardenAsync(redesignGardenSpec(w.deps, w.overrides, ops), w.deps);
    assert.equal(reads, read === undefined ? 0 : 1);
    return { plan: pass.plan, card: pass.scorecard, landed: w.landed, text: w.readPublic() };
  };
  const publicOnly = await run();
  assert.deepEqual(publicOnly.plan?.actions.map((a) => a.target), [PUBLIC_ID]);
  assert.equal(publicOnly.card?.candidates, 1);
  assert.deepEqual(publicOnly.landed.map((p) => p.paths), [[PUBLIC_SHARD]]);
  assert.deepEqual(await run({ outcome: "off" }), publicOnly);
  assert.deepEqual(await run({ outcome: "unavailable", reason: "ops-checkout-unreadable" }), publicOnly);
});
