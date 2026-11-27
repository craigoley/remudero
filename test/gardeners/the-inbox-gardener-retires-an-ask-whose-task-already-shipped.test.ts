import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { readPersistedInbox } from "#src/lib/fleet-lane.js";
import { defaultInboxGardenerPorts, runInboxGardener, INBOX_GARDENER_LIMITS, type InboxGardenerPorts } from "#src/lib/inbox-gardener.js";
import { readInboxGardenerStore, restoreInboxRetirement, retirementAsk, validInboxTerminalProof, type InboxGardenerScope, type InboxTerminalProof } from "#src/lib/inbox-retirement.js";
import { appendThreadMessage, inboxThreadIdentity } from "#src/lib/inbox-thread.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { world } from "#test/helpers/why-me-world.js";

// W1-T13197. OBSERVED 2026-11-16: 329 operator-owned verify-human and machine-judge asks in the craigoley/remudero Inbox
// were about tasks that had already merged or been plan-retired, and the gardener admitted only proof-debt asks.
// Operator ruling 2026-11-16 13:47Z: "Yes, retire them reversibly".
const MERGED = "W1-T1300", OPEN = "W1-T1301", RETIRED = "W1-T1302", HELD = "W1-T1303", REPLIED = "W1-T1304";
const ASKS = { merged: `verify-human:${MERGED}`, open: `machine-judge:${OPEN}`, retired: `verify-human-automate:${RETIRED}`, held: `verify-human:${HELD}`, replied: `machine-judge:${REPLIED}` };
const task = (id: string, extra = "") => `- id: ${id}\n  title: Human check for ${id}\n  repo: core\n  depends_on: []\n  type: implement\n  verify: human\n  status: queued\n${extra}`;
const pr = (id: string) => ({ number: Number(id.split("T")[1]), url: "", state: "MERGED" as const, headRefName: `run-${id}-123456` });

async function fixture(t: Parameters<typeof world>[0]) {
  const w = await world(t);
  appendFileSync(w.planPath, [task(MERGED), task(OPEN), task(RETIRED), task(HELD, "  dispatch_hold: true\n"), task(REPLIED)].join(""));
  const registry = JSON.parse(readFileSync(w.registry, "utf8")) as { proposals: Array<Record<string, unknown>> };
  for (const id of Object.values(ASKS)) registry.proposals.push({ id, summary: `A high-risk release still needs human verification (${id})`, evidenceAnchors: [] });
  writeFileSync(w.registry, JSON.stringify(registry));
  const merged = new Set([MERGED, HELD, REPLIED]);
  w.deps.statusGithub = fakeGitHub({ findMergedByTrailer: id => merged.has(id) ? { ...pr(id), url: `https://github.com/${w.repository}/pull/${id.split("T")[1]}` } : null,
    headRefName: ref => `run-W1-T${ref.split("/").at(-1)}-123456`, prBody: ref => `Remudero-Task: W1-T${ref.split("/").at(-1)}`, changedFiles: () => ["src/fix.ts"] });
  appendThreadMessage(inboxThreadIdentity(ASKS.replied), "reply", "Wait, I still need to look at this", { threadStorePath: join(w.state, "inbox-threads.jsonl") });
  await w.refresh();
  // Read the clock AFTER the refresh: world() stamps the snapshot at refresh time less 100 ms, so a clock read before slow
  // fixture writes can precede the snapshot, and the gardener then refuses an unqualified pass (flake-screen, #18888).
  const now = Date.now();
  const scope: InboxGardenerScope = { repository: w.repository, instance: w.instance, root: w.root };
  const searches: string[] = [];
  const githubJson = async (args: string[]) => {
    if (args[1] === "view") return { files: [{ path: "src/fix.ts" }] };
    const search = args[args.indexOf("--search") + 1]!; searches.push(search);
    const id = /W1-T\d+/.exec(search)?.[0];
    return id && merged.has(id) && search.includes("Remudero-Task") ? [{ number: Number(id.split("T")[1]), url: `https://github.com/${w.repository}/pull/${id.split("T")[1]}`, state: "MERGED",
      headRefName: `claude/hand-fix-${id}`, headRefOid: "a".repeat(40), mergeCommit: { oid: "b".repeat(40) }, body: `Fix it\n\nRemudero-Task: ${id}` }] : [];
  };
  const ports = () => defaultInboxGardenerPorts({ stateDir: w.state, scope, planPath: w.planPath, codeSha: "c".repeat(40), clock: fixedClock(now), githubJson });
  const run = (mode: "shadow" | "act", custom: Partial<InboxGardenerPorts> = {}) =>
    runInboxGardener({ stateDir: w.state, scope, ports: { ...ports(), judge: async () => assert.fail("a finished-task ask never reaches the judge"), ...custom }, mode, clock: fixedClock(now) });
  const classification = (id: string) => readPersistedInbox(w.state)!.classifications.find(c => c.proposalId === id);
  const entries = () => { const s = readInboxGardenerStore(w.state, scope); return s.state === "observed" ? s.store : assert.fail("store observed"); };
  return { ...w, scope, ports, run, classification, entries, searches, now };
}

test("W1-T13197 criterion 1: an act pass retires a verify-human ask whose task merged with its anchored trailer", async t => {
  const f = await fixture(t);
  assert.equal(f.classification(ASKS.merged)?.state, "not_ready", "positive control: the shipped task's ask starts as a needs-triage row");
  assert.match(f.classification(ASKS.merged)?.reasons[0]?.detail ?? "", /terminal task facts/);
  const result = await f.run("act");
  assert.equal("retired" in result && result.retired, 1, "the one shipped, unprotected ask");
  const retire = f.entries().events.find(e => e.receipt.kind === "retire")!;
  assert.equal(retire.receipt.scope.proposalId, ASKS.merged);
  assert.equal(retire.receipt.scope.taskId, MERGED);
  assert.equal(retire.proof.kind, "merged-task");
  assert.match(retire.reason, /already shipped/);
  await f.refresh();
  assert.equal(f.classification(ASKS.merged)?.state, "retired");
});

test("W1-T13197 criterion 2: a finished-task ask whose task is plan-retired is proven by its committed plan blob", async t => {
  const f = await fixture(t), git = gitRepo({ kind: "inbox-finished-plan-proof" }); t.after(() => git.cleanup());
  mkdirSync(join(git.dir, "plan"));
  const path = join(git.dir, "plan", "tasks.yaml");
  writeFileSync(path, readFileSync(f.planPath, "utf8").replace(task(RETIRED), task(RETIRED).replace("  status: queued\n", "  status: blocked\n  retirement: retired\n")));
  git.git("add", "plan/tasks.yaml"); git.git("commit", "-m", "fixture plan retirement");
  const scope = { ...f.scope, root: git.dir }, ports = defaultInboxGardenerPorts({ stateDir: f.state, scope, planPath: path, codeSha: "c".repeat(40), githubJson: async () => [] });
  const candidate = (await ports.capture()).candidates.find(c => c.proposal.id === ASKS.retired)!;
  assert.equal(candidate.task?.retirement, "retired");
  const proof = await ports.proof(candidate);
  assert.equal(proof?.kind, "plan-retirement");
  assert.equal(validInboxTerminalProof(proof, scope, candidate.proposal), true);
  // A finished-task ask accepts only its own task's merge or retirement, never a handoff or successor shape.
  const handoff: InboxTerminalProof = { kind: "handoff", taskId: RETIRED, repository: scope.repository, instance: scope.instance, receiptId: "d".repeat(64), runId: "run", authority: "operator", released: "verify-human", proposalId: ASKS.retired };
  assert.equal(validInboxTerminalProof(handoff, scope, candidate.proposal), false);
  assert.equal(validInboxTerminalProof({ ...proof!, taskId: MERGED }, scope, candidate.proposal), false, "another task's proof never answers this ask");
});

test("W1-T13197 criterion 3: unshipped, held, replied and decided asks stay, and shadow retires nothing", async t => {
  const f = await fixture(t);
  const shadow = await f.run("shadow");
  assert.equal("retired" in shadow && shadow.retired, 0);
  assert.equal(f.entries().events.length, 0);
  assert.equal(f.entries().entries[ASKS.merged]?.decision, "retire_proven_shadow");
  assert.equal(f.entries().entries[ASKS.open]?.decision, "keep_unfinished", "an unmerged task keeps its ask open without a judge");
  assert.equal(f.entries().entries[ASKS.held]?.decision, "keep_protected");
  assert.equal(f.entries().entries[ASKS.replied]?.decision, "keep_protected");
  assert.equal(f.entries().entries["verify-human:W1-T216"]?.decision, "keep_protected");
  assert.ok(f.searches.some(s => s.includes(MERGED)), "positive control: the merged task's credit was searched");
  assert.ok(!f.searches.some(s => s.includes(HELD) || s.includes(REPLIED)), "protected asks never reach a proof read");
  // A commit-subject mention is not the anchored trailer.
  const subjectOnly = await f.run("act", { proof: async c => c.proposal.id === ASKS.merged ? { kind: "merged-task", taskId: MERGED, repository: f.scope.repository, instance: f.scope.instance,
    number: 1300, url: `https://github.com/${f.scope.repository}/pull/1300`, state: "MERGED", headRefName: "claude/hand", headSha: "a".repeat(40), mergeSha: "b".repeat(40),
    body: `fix: W1-T1300 shipped`, credit: "trailer", implementationCredit: true, paths: ["src/fix.ts"] } : undefined });
  assert.equal("retired" in subjectOnly && subjectOnly.retired, 0);
  assert.equal(retirementAsk({ id: "verify-human:W1-T1300", summary: "", evidenceAnchors: [], automaticRetirement: { producer: "other" } as any }), undefined, "a broken producer stamp is never re-read from the id");
});

test("W1-T13197 criterion 4: a retired finished-task ask is restored by the existing restore, and the proof-debt purpose is untouched", async t => {
  const f = await fixture(t);
  await f.run("act");
  const retire = f.entries().events.find(e => e.receipt.kind === "retire")!;
  const restored = await restoreInboxRetirement(f.state, f.scope, { proposalId: ASKS.merged, retirementId: retire.receipt.id, snapshotKey: retire.receipt.snapshotKey,
    taskId: MERGED, reason: "Look at this one again" }, "operator:alice", "restore-finished-001", new Date(f.now + 1000).toISOString());
  assert.equal("status" in restored && restored.status, 200);
  await f.refresh();
  assert.equal(f.classification(ASKS.merged)?.retirement?.state, "restored_for_review");
  await f.run("act");
  assert.equal(f.entries().events.filter(e => e.receipt.kind === "retire" && e.receipt.scope.proposalId === ASKS.merged).length, 1, "a restore is never undone by the gardener");
  assert.equal(retirementAsk({ id: "proof-debt:W1-T1300", summary: "", evidenceAnchors: [] }), undefined, "an unstamped proof-debt id gains no purpose");
  assert.deepEqual(INBOX_GARDENER_LIMITS, { ledgerCatchUpMs: 300_000, ledgerChunkBytes: 64 * 1024 }, "W1-T14978: no per-pass count bound");
});
