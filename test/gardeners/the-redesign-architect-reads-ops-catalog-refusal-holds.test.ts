import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { landTaskFilesAsync, type TaskFilesLandingResult } from "#src/lib/feedback-landing.js";
import { gardenStatePath, readGardenState, runGardenAsync, type GardenerDeps, type GardenLandOpts } from "#src/lib/gardener.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { productionPlanGardenOps, type PlanGardenOps, type PlanOpsRead } from "#src/lib/plan-gardener.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { PR_OPEN_SATISFIED_BY_MAIN_STEP } from "#src/lib/pr-open.js";
import {
  buildRedesignSources, REDESIGN_JUDGED_STEP, REDESIGN_OPS_LANDING_LOST_MS, REDESIGN_OPS_LANDING_RESULT_STEP, REDESIGN_OPS_LANDING_STEP,
  redesignCandidates, redesignGardenSpec, redesignInventory, redesignOpsHeld, redesignOpsLandTaskFiles, redesignOpsRecordOutcome, type RedesignSources,
} from "#src/lib/redesign-gardener.js";
import { commentOnlyGrepProofRefusal, parseAcceptanceBlock, parseWhitelistedProof } from "#src/lib/review.js";
import { gitRepo, originWithClone } from "#test/helpers/git-repo.js";

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
    // run-task.ts's wiring: the redesign records each submitted record's own outcome around the sealed landing.
    landTaskFiles: redesignOpsLandTaskFiles(w.deps.log, async (root, inputs, opts) => {
      calls.push({ root, inputs, target: opts.targetRepository });
      return { prUrl: "https://example.test/remudero-ops/pull/7", landed: inputs.map((input) => input.relPath), waiting: [], refused: [], setAside: [], pushed: true };
    }),
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
  const opsDecision = w.rows.find((row) => row.step === "redesign.ops_landing_submitted");
  assert.deepEqual(opsDecision?.signatures, [signature]);
  assert.equal((opsDecision?.evidence_keys as string[]).length, 1);
  assert.ok(!pending.targets.some((target) => (opsDecision?.evidence_keys as string[]).includes(target.target)),
    "the public PR cannot settle the ops evidence keys");
  const outcome = w.rows.filter((row) => row.step === REDESIGN_OPS_LANDING_RESULT_STEP).at(-1)?.records as Array<Record<string, unknown>>;
  assert.deepEqual(outcome.map((r) => [r.path, r.outcome]), [[OPS_SHARD, "held"]], "the ops landing PR carries the record");
  assert.ok(!redesignCandidates(buildRedesignSources(w.deps, w.overrides, snapshot)).some((c) => c.id === OPS_ID),
    "a record its ops landing PR carries is not asked again");
});

test("W1-T14882 criterion 2: submitted ops signatures stop filling later passes ahead of public work", async (t) => {
  const w = fixture(t);
  const opsIds = ["W1-T10", "W1-T20"];
  const opsSources = new Map(opsIds.map((id, i) => [`plan/tasks.d/ops-${i}.yaml`, record(id)]));
  const snapshot: Extract<PlanOpsRead, { outcome: "ok" }> = {
    outcome: "ok", pin: PIN,
    tasks: [...opsSources].flatMap(([rel, text]) => parseTasksFromYaml(text, rel)),
    shards: new Map(opsIds.map((id, i) => [id, `plan/tasks.d/ops-${i}.yaml`])),
    sources: opsSources,
  };
  writeFileSync(join(w.root, PUBLIC_SHARD), record("W1-T300"));
  const sources = buildRedesignSources(w.deps, w.overrides, snapshot);
  const first = await redesignInventory(sources, w.deps);
  assert.deepEqual(first.actions.map((action) => action.target), opsIds);
  const opsActions = first.actions;
  assert.equal(opsActions.length, 2);
  // Submitted and not yet answered by a landing result: in flight.
  w.rows.push({ step: REDESIGN_OPS_LANDING_STEP, ts: clock.iso(), records: opsActions.map((action) => ({
    path: action.shard, content_sha: action.signature, signatures: [action.signature], evidence_keys: action.keys })) });

  const nextSources = buildRedesignSources(w.deps, w.overrides, snapshot);
  assert.deepEqual(redesignCandidates(nextSources).map((candidate) => candidate.id), ["W1-T300"]);
  const second = await redesignInventory(nextSources, w.deps);
  assert.deepEqual(second.actions.map((action) => action.target), ["W1-T300"]);
  const publicSpec = redesignGardenSpec(w.deps, w.overrides, { read: async () => snapshot, land: () => {} });
  const card = publicSpec.scorecard(second, { actions: second.actions, acting: ["amend"] });
  assert.equal((card.signatures as string[]).length, 1, "the public scorecard only carries its own signature");
});

const OTHER_SHARD = "plan/tasks.d/other.yaml";
const landingResult = (r: Partial<TaskFilesLandingResult>): TaskFilesLandingResult => ({ landed: [], waiting: [], refused: [], setAside: [], pushed: false, ...r });

test("W1-T14882 criterion 2: each submitted ops record is held or released by its own landing entry, never by the queue's counts", async () => {
  const input = { relPath: OPS_SHARD, content: record(OPS_ID), claim: "the record is amended", proof: `grep: amendment in ${OPS_SHARD}` };
  const { content_sha } = redesignOpsRecordOutcome(landingResult({}), input);
  const pr = "https://example.test/remudero-ops/pull/7";
  const own = `the plan preflight refused it: [lint-plan] ${OPS_SHARD}: a field is malformed`;
  const cases: Array<[string, TaskFilesLandingResult, "held" | "released"]> = [
    ["carried by the open landing PR", landingResult({ prUrl: pr, landed: [OPS_SHARD] }), "held"],
    ["staged behind the landing", landingResult({ waiting: [OPS_SHARD], error: "origin/main is red, so the landing waits" }), "held"],
    ["refused on its own bytes", landingResult({ refused: [{ path: OPS_SHARD, reason: own, mainRed: false }] }), "held"],
    ["the same bytes were set aside before", landingResult({ refused: [{ path: OPS_SHARD, reason: `the same bytes were set aside before: ${own}` }] }), "held"],
    ["declined: its landing PR closed", landingResult({ setAside: [{ path: OPS_SHARD, reason: `its landing pull request ${pr} was closed without a merge` }] }), "held"],
    ["the preflight timed out, an unrelated file queued", landingResult({ waiting: [OTHER_SHARD],
      refused: [{ path: OPS_SHARD, reason: "the plan preflight ran out of its budget, so the file was not staged", timedOut: true }] }), "released"],
    ["main is red, an unrelated file carried", landingResult({ prUrl: pr, landed: [OTHER_SHARD], refused: [{ path: OPS_SHARD, reason: own, mainRed: true }] }), "released"],
    ["the main-red probe could not run", landingResult({ refused: [{ path: OPS_SHARD, reason: own, mainRed: false, mainRedProbeError: "spawn ENOENT" }] }), "released"],
    ["another edit holds the path", landingResult({ waiting: [OPS_SHARD], refused: [{ path: OPS_SHARD, reason: `another edit of ${OPS_SHARD} waits for its landing` }] }), "released"],
    ["main moved the record after staging", landingResult({ setAside: [{ path: OPS_SHARD,
      reason: `origin/main changed ${OPS_SHARD} after this edit was staged (base a, main b); the copy on main stands` }] }), "released"],
    ["only unrelated files are carried and queued", landingResult({ prUrl: pr, landed: [OTHER_SHARD], waiting: ["plan/tasks.d/third.yaml"] }), "released"],
  ];
  for (const [name, result, expected] of cases) {
    const rows: Array<Record<string, unknown>> = [
      { step: REDESIGN_OPS_LANDING_STEP, ts: clock.iso(), records: [{ path: OPS_SHARD, content_sha, signatures: ["sig"], evidence_keys: ["key"] }] },
    ];
    assert.deepEqual(redesignOpsHeld(rows, clock.now()), ["sig", "key"], `${name}: a submission no result answered is in flight`);
    const log = (step: string, extra: Record<string, unknown> = {}) => void rows.push({ ...extra, step, ts: clock.iso() });
    const land = redesignOpsLandTaskFiles(log, async () => result);
    assert.equal(await land("/ops", [input], { stateRoot: "/state" } as Parameters<typeof landTaskFilesAsync>[2]), result);
    const outcome = (rows.at(-1)!.records as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual([outcome.path, outcome.content_sha, outcome.outcome], [OPS_SHARD, content_sha, expected], name);
    assert.deepEqual(redesignOpsHeld(rows, clock.now()), expected === "held" ? ["sig", "key"] : [], name);
    // A later submission of the same bytes is in flight again, whatever answered the earlier one.
    rows.push({ ...rows[0]!, ts: clock.iso() });
    assert.deepEqual(redesignOpsHeld(rows, clock.now()), ["sig", "key"], `${name}: a resubmission is in flight`);
  }
  const lost = [{ step: REDESIGN_OPS_LANDING_STEP, ts: clock.iso(), records: [{ path: OPS_SHARD, content_sha, signatures: ["sig"] }] }];
  assert.deepEqual(redesignOpsHeld(lost, clock.now() + REDESIGN_OPS_LANDING_LOST_MS + 1), [],
    "a submission no landing ever answered (a restart, a skipped landing) is released once it is lost");

  const thrown: Array<Record<string, unknown>> = [];
  const failing = redesignOpsLandTaskFiles((step, extra = {}) => void thrown.push({ ...extra, step }), async () => { throw new Error("gh is down"); });
  await assert.rejects(failing("/ops", [input], { stateRoot: "/state" } as Parameters<typeof landTaskFilesAsync>[2]), /gh is down/);
  assert.deepEqual((thrown[0]!.records as Array<Record<string, unknown>>).map((r) => [r.outcome, r.reason]), [["released", "the landing threw: gh is down"]]);
});

const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const RED: PlanPrPreflightResult = { ok: false, failures: [{ check: "lint-plan", firstLine: "plan/tasks.d: a record is malformed" }], unreadable: [] };
const TIMED_OUT: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [], timedOut: [{ check: "lint-plan", firstLine: "killed at its budget" }] };

test("W1-T14882 criterion 2: through the real sealed landing, a timed-out or main-red ops amendment is released and its own red held", async (t) => {
  const scenarios: Array<{ name: string; verdict: (sha: string, main: string) => PlanPrPreflightResult; expected: "held" | "released"; reason: RegExp }> = [
    { name: "the preflight times out", verdict: () => TIMED_OUT, expected: "released", reason: /ran out of its budget/ },
    { name: "main is red", verdict: () => RED, expected: "released", reason: /the plan preflight refused it/ },
    { name: "the record's own red", verdict: (sha, main) => (sha === main ? GREEN : RED), expected: "held", reason: /the plan preflight refused it/ },
  ];
  for (const s of scenarios) {
    await t.test(s.name, async (st) => {
      // Each scenario's amendment is its own bytes, so the landing's per-process verdict cache never answers for another.
      const w = fixture(st, answer({ verdict: "amend", amendment: `Exercise the runtime entry point (${s.name}).`, reason: "The task needs a clearer test boundary." }));
      const destination = { owner: "craigoley", repo: "remudero-ops" };
      writeFileSync(join(w.deps.stateDir, "plan-destination.json"), JSON.stringify({ repository: "craigoley/remudero-ops", kinds: ["task"] }));
      const { clone } = originWithClone(join(w.root, "repos", destination.repo), { scope: st, seed: {
        "plan/tasks.yaml": "[]\n", [OPS_SHARD]: record(OPS_ID), [OTHER_SHARD]: record("W1-T102"), "world.txt": `${w.root}\n`,
      } });
      const main = clone.git("rev-parse", "HEAD");
      let staging = true;
      // An open landing PR seals the branch, so the queue waits behind it and nothing is pushed.
      const sealed = "https://github.com/craigoley/remudero-ops/pull/9001";
      const gh = (args: string[]): string => (args[0] === "pr" && args[1] === "list" ? JSON.stringify([{ url: sealed }]) :
        args[0] === "pr" && args[1] === "view" ? JSON.stringify({ state: "OPEN" }) : "[]");
      const planPrPreflight = async (sha: string): Promise<PlanPrPreflightResult> => (staging ? GREEN : s.verdict(sha, main));
      // An unrelated edit already waits in the same repository's queue: its wait, and the open PR, must never hold this record.
      await withLiveWritesAllowed(() => landTaskFilesAsync(clone.dir, [{ relPath: OTHER_SHARD, content: `${record("W1-T102")}  # tended\n`,
        claim: "the other record is tended", proof: `grep: tended in ${OTHER_SHARD}` }], { stateRoot: w.root, targetRepository: destination, gh, planPrPreflight, stageOnly: true }));
      staging = false;
      const ops = productionPlanGardenOps({
        repoRoot: w.root, stateDir: w.deps.stateDir, stateRoot: w.root, log: w.deps.log,
        landTaskFiles: redesignOpsLandTaskFiles(w.deps.log, (root, inputs, opts) => landTaskFilesAsync(root, inputs, { ...opts, gh, planPrPreflight })),
      });
      const snapshot = opsRead();
      await withLiveWritesAllowed(async () => {
        await runGardenAsync(redesignGardenSpec(w.deps, w.overrides, { read: async () => snapshot, land: ops.land }), w.deps);
        await ops.settled();
      });
      // The queue's counts say "a PR, one waiting": they are the unrelated file's, never this record's.
      const landing = w.rows.find((row) => row.step === "plan.ops_landing");
      assert.deepEqual([landing?.pr_url, landing?.landed, landing?.waiting, landing?.refused], [sealed, 0, 1, 1], JSON.stringify(landing));
      const outcome = (w.rows.filter((row) => row.step === REDESIGN_OPS_LANDING_RESULT_STEP).at(-1)?.records as Array<Record<string, unknown>>)[0]!;
      assert.deepEqual([outcome.path, outcome.outcome], [OPS_SHARD, s.expected]);
      assert.match(String(outcome.reason), s.reason);
      const asked = redesignCandidates(buildRedesignSources(w.deps, w.overrides, snapshot)).some((c) => c.id === OPS_ID);
      assert.equal(asked, s.expected === "released", s.expected === "released"
        ? "a refusal that judged nothing leaves the record free for another attempt" : "a refusal of the record's own bytes holds it");
    });
  }
});

test("W1-T14882 criterion 2: a thrown ops landing is recorded as failed and can be retried", async (t) => {
  const w = fixture(t);
  const snapshot = opsRead();
  await runGardenAsync(redesignGardenSpec(w.deps, w.overrides, {
    read: () => snapshot,
    land: () => { throw new Error("ops-status-source-moved"); },
  }), w.deps);
  assert.ok(w.rows.some((row) => row.step === REDESIGN_OPS_LANDING_RESULT_STEP && row.failure === true &&
    row.error === "ops-status-source-moved"), "the caught landing error is durable");
  const candidates = redesignCandidates(buildRedesignSources(w.deps, w.overrides, snapshot));
  assert.ok(candidates.some((candidate) => candidate.id === OPS_ID), `failed ops work is eligible for retry: ${JSON.stringify({ rows: w.rows, candidates: candidates.map((candidate) => candidate.id) })}`);
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

test("W1-T14882 criterion 2: at ops main == pin, the main-red probe runs through the guarded landing and an own red is held", async (t) => {
  const w = fixture(t, answer({ verdict: "amend", amendment: "Exercise the runtime entry point (main is the pin).", reason: "The task needs a clearer test boundary." }));
  const destination = { owner: "craigoley", repo: "remudero-ops" };
  writeFileSync(join(w.deps.stateDir, "plan-destination.json"), JSON.stringify({ repository: "craigoley/remudero-ops", kinds: ["task"] }));
  const { clone } = originWithClone(join(w.root, "repos", destination.repo), { scope: t, seed: {
    "plan/tasks.yaml": "[]\n", [OPS_SHARD]: record(OPS_ID), [OTHER_SHARD]: record("W1-T102"), "world.txt": `${w.root}\n`,
  } });
  const main = clone.git("rev-parse", "HEAD");
  const sealed = "https://github.com/craigoley/remudero-ops/pull/9002";
  const gh = (args: string[]): string => (args[0] === "pr" && args[1] === "list" ? JSON.stringify([{ url: sealed }]) :
    args[0] === "pr" && args[1] === "view" ? JSON.stringify({ state: "OPEN" }) : "[]");
  // An unrelated edit already waits, so the open PR seals the branch and nothing is pushed.
  await withLiveWritesAllowed(() => landTaskFilesAsync(clone.dir, [{ relPath: OTHER_SHARD, content: `${record("W1-T102")}  # tended\n`,
    claim: "the other record is tended", proof: `grep: tended in ${OTHER_SHARD}` }], { stateRoot: w.root, targetRepository: destination, gh,
    planPrPreflight: async () => GREEN, stageOnly: true }));
  // The plan preflight behind the unmoved-records guard: main itself is green, the amended record is red.
  const asked: string[] = [];
  const inner = async (_dir: string, sha: string): Promise<PlanPrPreflightResult> => { asked.push(sha); return sha === main ? GREEN : RED; };
  const ops = productionPlanGardenOps({
    repoRoot: w.root, stateDir: w.deps.stateDir, stateRoot: w.root, log: w.deps.log, planPrPreflight: inner,
    landTaskFiles: redesignOpsLandTaskFiles(w.deps.log, (root, inputs, opts) => landTaskFilesAsync(root, inputs, { ...opts, gh }), { codeRoot: w.root, inner }),
  });
  const snapshot = { ...opsRead(), pin: main };
  await withLiveWritesAllowed(async () => {
    await runGardenAsync(redesignGardenSpec(w.deps, w.overrides, { read: async () => snapshot, land: ops.land }), w.deps);
    await ops.settled();
  });
  assert.ok(asked.includes(main), `the probe reached the plan preflight on ops main itself: ${JSON.stringify(asked)}`);
  const refused = w.rows.find((row) => row.step === "task_files_landing.set_aside" || row.step === "task_files_landing.refused");
  assert.equal(JSON.stringify(w.rows).includes("ops-status-source-moved"), false, "the guard never threw on the probe");
  const outcome = (w.rows.filter((row) => row.step === REDESIGN_OPS_LANDING_RESULT_STEP).at(-1)?.records as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual([outcome.path, outcome.outcome], [OPS_SHARD, "held"], JSON.stringify({ outcome, refused }));
  assert.equal(redesignCandidates(buildRedesignSources(w.deps, w.overrides, snapshot)).some((c) => c.id === OPS_ID), false,
    "a record refused on its own bytes is not asked again on the next pass");
});

test("W1-T14882 criterion 2: a record an earlier landing held is released when a later landing sets its path aside", async () => {
  const input = { relPath: OPS_SHARD, content: record(OPS_ID), claim: "the record is amended", proof: `grep: amendment in ${OPS_SHARD}` };
  const { content_sha } = redesignOpsRecordOutcome(landingResult({}), input);
  const rows: Array<Record<string, unknown>> = [
    { step: REDESIGN_OPS_LANDING_STEP, ts: clock.iso(), records: [{ path: OPS_SHARD, content_sha, signatures: ["sig"] }] },
  ];
  const log = (step: string, extra: Record<string, unknown> = {}) => void rows.push({ ...extra, step, ts: clock.iso() });
  await redesignOpsLandTaskFiles(log, async () => landingResult({ waiting: [OPS_SHARD] }))("/ops", [input], { stateRoot: "/state" } as Parameters<typeof landTaskFilesAsync>[2]);
  assert.deepEqual(redesignOpsHeld(rows, clock.now()), ["sig"], "staged behind the landing: held");
  // A later call lands another record; origin/main changed the waiting one, so the landing sets it aside.
  const other = { relPath: OTHER_SHARD, content: record("W1-T102"), claim: "the other record is amended", proof: `grep: amendment in ${OTHER_SHARD}` };
  await redesignOpsLandTaskFiles(log, async () => landingResult({ landed: [OTHER_SHARD], setAside: [{ path: OPS_SHARD,
    reason: `origin/main changed ${OPS_SHARD} after this edit was staged (base a, main b); the copy on main stands` }] }))(
    "/ops", [other], { stateRoot: "/state" } as Parameters<typeof landTaskFilesAsync>[2]);
  const later = (rows.at(-1)!.records as Array<Record<string, unknown>>).find((r) => r.path === OPS_SHARD);
  assert.deepEqual([later?.outcome, later?.content_sha], ["released", undefined], "the later set-aside names only the path");
  assert.deepEqual(redesignOpsHeld(rows, clock.now()), [], "the set-aside record is free for another attempt");
});
