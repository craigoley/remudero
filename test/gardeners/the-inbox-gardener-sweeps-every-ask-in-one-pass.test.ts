// W1-T14978. OBSERVED 2026-11-26 on the host: each Inbox gardener pass evaluated 8 of about 2,400 proposals, retired 0
// and judged 0 (complete=false). INBOX_GARDENER_LIMITS admitted 8 candidates, 4 proof reads, 1 judge and 1 retirement a
// pass, so the asks for tasks that had already shipped waited in the operator's Inbox for weeks.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { defaultInboxGardenerPorts, runInboxGardener, INBOX_GARDENER_LIMITS, type InboxGardenerCandidate, type InboxGardenerPack, type InboxGardenerPorts } from "#src/lib/inbox-gardener.js";
import { readInboxGardenerStore, type InboxGardenerScope } from "#src/lib/inbox-retirement.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { world } from "#test/helpers/why-me-world.js";

// More than every old per-pass count: 8 candidates, 4 proof reads and 1 retirement.
const SHIPPED = Array.from({ length: 12 }, (_, i) => `W1-T${1400 + i}`);
const task = (id: string) => `- id: ${id}\n  title: Human check for ${id}\n  repo: core\n  depends_on: []\n  type: implement\n  verify: human\n  status: queued\n`;

async function fixture(t: Parameters<typeof world>[0]) {
  const w = await world(t);
  appendFileSync(w.planPath, SHIPPED.map(id => task(id)).join(""));
  const registry = JSON.parse(readFileSync(w.registry, "utf8")) as { proposals: Array<Record<string, unknown>> };
  for (const id of SHIPPED) registry.proposals.push({ id: `verify-human:${id}`, summary: `A high-risk release still needs human verification (${id})`, evidenceAnchors: [] });
  writeFileSync(w.registry, JSON.stringify(registry));
  const shipped = new Set(SHIPPED);
  w.deps.statusGithub = fakeGitHub({ findMergedByTrailer: id => shipped.has(id) ? { number: Number(id.split("T")[1]), url: `https://github.com/${w.repository}/pull/${id.split("T")[1]}`, state: "MERGED" as const, headRefName: `run-${id}-123456` } : null,
    headRefName: ref => `run-W1-T${ref.split("/").at(-1)}-123456`, prBody: ref => `Remudero-Task: W1-T${ref.split("/").at(-1)}`, changedFiles: () => ["src/fix.ts"] });
  await w.refresh();
  const now = Date.now(); // after the refresh, as the shipped-task fixture explains
  const scope: InboxGardenerScope = { repository: w.repository, instance: w.instance, root: w.root };
  let proofReads = 0;
  const githubJson = async (args: string[]) => {
    if (args[1] === "view") return { files: [{ path: "src/fix.ts" }] };
    const search = args[args.indexOf("--search") + 1]!;
    const id = /W1-T\d+/.exec(search)?.[0];
    return id && shipped.has(id) && search.includes("Remudero-Task") ? [{ number: Number(id.split("T")[1]), url: `https://github.com/${w.repository}/pull/${id.split("T")[1]}`, state: "MERGED",
      headRefName: `claude/hand-fix-${id}`, headRefOid: "a".repeat(40), mergeCommit: { oid: "b".repeat(40) }, body: `Fix it\n\nRemudero-Task: ${id}` }] : [];
  };
  const ports = (): InboxGardenerPorts => {
    const base = defaultInboxGardenerPorts({ stateDir: w.state, scope, planPath: w.planPath, codeSha: "c".repeat(40), clock: fixedClock(now), githubJson });
    return { ...base, proof: async c => { proofReads++; return base.proof(c); }, judge: async () => assert.fail("a finished-task ask never reaches the judge") };
  };
  const run = (mode: "shadow" | "act") => runInboxGardener({ stateDir: w.state, scope, ports: ports(), mode, clock: fixedClock(now) });
  const store = () => { const s = readInboxGardenerStore(w.state, scope); return s.state === "observed" ? s.store : assert.fail("store observed"); };
  return { run, store, proofReads: () => proofReads };
}

test("W1-T14978 criterion 1: one act pass retires every proven ask and completes the sweep", async t => {
  const f = await fixture(t);
  const result = await f.run("act");
  assert.equal(result.state, "complete", JSON.stringify(result));
  assert.equal("retired" in result && result.retired, SHIPPED.length);
  const retired = f.store().events.filter(e => e.receipt.kind === "retire").map(e => e.receipt.scope.proposalId).sort();
  assert.deepEqual(retired, SHIPPED.map(id => `verify-human:${id}`).sort());
});

test("W1-T14978 criterion 2: one shadow pass reads every ask's proof and records each, retiring nothing", async t => {
  const f = await fixture(t);
  const result = await f.run("shadow");
  assert.equal(result.state, "complete", JSON.stringify(result));
  assert.equal("retired" in result && result.retired, 0);
  assert.ok(f.proofReads() >= SHIPPED.length, `read ${f.proofReads()} proofs`);
  for (const id of SHIPPED) assert.equal(f.store().entries[`verify-human:${id}`]?.decision, "retire_proven_shadow", id);
  assert.equal(f.store().events.length, 0, "shadow writes no lifecycle event");
});

test("W1-T14978 criterion 3: invariant:no-default-count — the gardener's limits hold only its ledger budget, and a caller's per-pass count still splits a sweep", async t => {
  assert.deepEqual(Object.keys(INBOX_GARDENER_LIMITS).sort(), ["ledgerCatchUpMs", "ledgerChunkBytes"]);
  const now = Date.parse("2026-11-26T12:00:00.000Z"), clock = fixedClock(now);
  const scope: InboxGardenerScope = { repository: "craigoley/remudero", instance: "core", root: "/r" };
  const candidates = Array.from({ length: 5 }, (_, i) => ({ proposal: { id: `adoption:split-${i}`, summary: "unowned ask", evidenceAnchors: [] },
    operatorIntent: "", unansweredReply: false, resolvedByOperator: false }) as InboxGardenerCandidate);
  const pack: InboxGardenerPack = { scope, snapshotKey: "b".repeat(64), generatedAt: new Date(now - 60_000).toISOString(), checkedAt: new Date(now).toISOString(),
    codeSha: "a".repeat(40), coverage: { plan: "observed", registry: "observed", github: "observed", ledger: "observed", threads: "observed" }, candidates, ledgerEventIds: new Set() };
  const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "rmd-gardener-split-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ports: InboxGardenerPorts = { capture: async () => pack, proof: async () => assert.fail("no proof needed"), mirror: async () => assert.fail("shadow mirrors nothing") };
  const split = await runInboxGardener({ stateDir: dir, scope, ports, mode: "shadow", clock, limits: { candidates: 2 } });
  assert.equal(split.state, "pending");
  assert.equal("evaluated" in split && split.evaluated, 2);
  await assert.rejects(runInboxGardener({ stateDir: dir, scope, ports, mode: "shadow", clock, limits: { candidates: 0 } }), /invalid Inbox gardener bound/);
});
