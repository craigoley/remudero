import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { defaultInboxGardenerPorts, runInboxGardener } from "../src/lib/inbox-gardener.js";
import { inboxGardenerMode, mechanicalAskPurpose, proofDebtPopulationPermit, readInboxGardenerStore } from "../src/lib/inbox-retirement.js";
import { parseProposalRegistry } from "../src/lib/inbox.js";
import { appendThreadMessage, inboxThreadIdentity } from "../src/lib/inbox-thread.js";
import { mintProofDebtProposals } from "../src/lib/measurement-cadence.js";
import { loadPlan } from "../src/lib/plan.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { world } from "./helpers/why-me-world.js";

const TASK = "W1-T1200", ID = `proof-debt:${TASK}`;
async function fixture(t: TestContext, count = 1400, summaryBytes = 850) {
  const w = await world(t);
  appendFileSync(w.planPath, `- id: ${TASK}\n  title: Repair mechanical proof\n  repo: core\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n`);
  mintProofDebtProposals([{ taskId: TASK, criterionIndex: 0, cause: "grep-path-absent", claim: "has proof", proof: "grep: missing in src/missing.ts" }], () => "plan/tasks.yaml", w.registry,
    { sourcePermit: proofDebtPopulationPermit(loadPlan(w.planPath).tasks.filter(task => task.id === TASK)) });
  const proposals = parseProposalRegistry(readFileSync(w.registry, "utf8"));
  proposals.push(...Array.from({ length: count - proposals.length }, (_, i) => ({ id: `ruling:human-${String(i).padStart(4, "0")}`, summary: "Human approval needed. " + "x".repeat(summaryBytes), evidenceAnchors: [] })));
  writeFileSync(w.registry, JSON.stringify({ proposals }));
  w.deps.statusGithub = fakeGitHub({ findMergedByTrailer: id => id === TASK ? { number: 1200, url: `https://github.com/${w.repository}/pull/1200`, state: "MERGED", headRefName: `run-${TASK}-123456` } : null,
    headRefName: () => `run-${TASK}-123456`, prBody: () => `Remudero-Task: ${TASK}`, changedFiles: () => ["src/fix.ts"] });
  const scope = { repository: w.repository, instance: w.instance, root: w.root };
  let githubCalls = 0;
  const ports = () => defaultInboxGardenerPorts({ stateDir: w.state, scope, planPath: w.planPath, codeSha: "c".repeat(40), clock: fixedClock(Date.now()), githubJson: async args => {
    githubCalls++;
    return args[1] === "view" ? { files: [{ path: "src/fix.ts" }] } : [{ number: 1200, url: `https://github.com/${w.repository}/pull/1200`, state: "MERGED", headRefName: `run-${TASK}-123456`, headRefOid: "a".repeat(40), mergeCommit: { oid: "b".repeat(40) }, body: `Remudero-Task: ${TASK}` }];
  } });
  return { ...w, scope, ports, githubCalls: () => githubCalls, index: join(w.state, "inbox-gardener-evidence") };
}

test("W1-T10038 criterion 1: the gardener admits a representative registry without changing purpose", async t => {
  const f = await fixture(t), original = readFileSync(f.registry, "utf8");
  assert.ok(Buffer.byteLength(original) > 1024 * 1024 && Buffer.byteLength(original) < 2 * 1024 * 1024);
  await f.refresh();
  assert.equal(existsSync(f.index), false, "classification did not prime the gardener's own index");
  const ports = f.ports(), pack = await ports.capture();
  assert.equal(pack.candidates.length, 1400);
  assert.deepEqual(pack.coverage, { plan: "observed", registry: "observed", github: "observed", ledger: "observed", threads: "observed" });
  assert.equal(mechanicalAskPurpose(pack.candidates.find(c => c.proposal.id === ID)!.proposal)?.producer, "proof-queue-audit-v1");
  assert.equal(pack.candidates.filter(c => mechanicalAskPurpose(c.proposal)).length, 1, "byte admission grants no legacy purpose");
  const result = await runInboxGardener({ stateDir: f.state, scope: f.scope, ports: { ...ports, judge: async () => assert.fail("no judge for protected human asks or proven control"), mirror: async () => assert.fail("shadow has no live effects") }, mode: "shadow" });
  assert.equal(result.state, "pending");
  assert.equal("retired" in result && result.retired, 0);
  assert.equal("evaluated" in result && result.evaluated, 8, "candidate limit remains bounded");
  const store = readInboxGardenerStore(f.state, f.scope); assert.equal(store.state, "observed");
  if (store.state !== "observed") return;
  assert.equal(store.store.entries[ID]?.decision, "retire_proven_shadow");
  assert.equal(store.store.events.length, 0);
  assert.equal(store.store.entries["ruling:human-0000"]?.decision, "keep_protected");
  assert.equal(f.githubCalls(), 2, "actual proof path has a positive external-evidence control");
  assert.equal(readFileSync(f.registry, "utf8"), original);
  assert.equal(inboxGardenerMode({}), "off");
  // The held security ask and an unanswered genuine mechanical ask remain protected,
  // even when each is the only candidate in its own refreshed, fully qualified source.
  const proposals = parseProposalRegistry(original);
  for (const proposal of [proposals.find(p => p.id === "verify-human:W1-T216")!, proposals.find(p => p.id === ID)!]) {
    writeFileSync(f.registry, JSON.stringify({ proposals: [proposal] }));
    if (proposal.id === ID) appendThreadMessage(inboxThreadIdentity(ID), "reply", "I still need an answer", { threadStorePath: join(f.state, "inbox-threads.jsonl") });
    await f.refresh();
    const result = await runInboxGardener({ stateDir: f.state, scope: f.scope, ports: { ...f.ports(), proof: async () => assert.fail("protected ask must not reach proof"), judge: async () => assert.fail("protected ask must not reach judge") }, mode: "shadow" });
    assert.equal(result.state, "complete");
    const protectedStore = readInboxGardenerStore(f.state, f.scope);
    assert.equal(protectedStore.state === "observed" && protectedStore.store.entries[proposal.id]?.decision, "keep_protected");
  }
});

test("W1-T10038 criterion 2: an oversized registry is refused before projection or judgment", async t => {
  const f = await fixture(t, 1400, 1600);
  assert.ok(Buffer.byteLength(readFileSync(f.registry, "utf8")) > 2 * 1024 * 1024);
  assert.equal(parseProposalRegistry(readFileSync(f.registry, "utf8")).length, 1400, "valid JSON with an otherwise admissible item count");
  await assert.rejects(f.ports().capture(), /bound|large|size/i);
  const result = await runInboxGardener({ stateDir: f.state, scope: f.scope, ports: { ...f.ports(), proof: async () => assert.fail("oversize proof"), judge: async () => assert.fail("oversize judge") }, mode: "shadow" });
  assert.equal(result.state, "failed"); assert.equal(existsSync(f.index), false); assert.equal(f.githubCalls(), 0);
  assert.equal(readInboxGardenerStore(f.state, f.scope).state, "absent");
});

test("W1-T10038 criterion 3: count and identity protections survive larger byte admission", async t => {
  const f = await fixture(t, 2049, 0);
  assert.ok(Buffer.byteLength(readFileSync(f.registry, "utf8")) < 512 * 1024);
  await assert.rejects(f.ports().capture(), /population exceeds/);
  assert.equal(existsSync(f.index), false);
  const proposals = parseProposalRegistry(readFileSync(f.registry, "utf8")).slice(0, 1400);
  for (const p of proposals) if (!mechanicalAskPurpose(p)) p.summary += "x".repeat(850);
  writeFileSync(f.registry, JSON.stringify({ proposals })); await f.refresh();
  assert.equal((await f.ports().capture()).coverage.registry, "observed", "same larger source is initially qualified");
  proposals.at(-1)!.summary += " changed after snapshot";
  writeFileSync(f.registry, JSON.stringify({ proposals }));
  const pack = await f.ports().capture(); assert.equal(pack.coverage.registry, "unavailable"); assert.equal(pack.coverage.plan, "unavailable");
  const result = await runInboxGardener({ stateDir: f.state, scope: f.scope, ports: { ...f.ports(), proof: async () => assert.fail("identity proof"), judge: async () => assert.fail("identity judge") }, mode: "shadow" });
  assert.equal(result.state, "source_partial"); assert.equal(f.githubCalls(), 0);
  assert.equal(readInboxGardenerStore(f.state, f.scope).state, "absent");
});
