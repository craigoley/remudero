import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { defaultInboxGardenerPorts, runInboxGardener, warnInboxGardenerNearBound, INBOX_GARDENER_SOURCE_WARNING_STEP, INBOX_GARDENER_SOURCE_LIMITS } from "#src/lib/inbox-gardener.js";
import { proofDebtPopulationPermit } from "#src/lib/inbox-retirement.js";
import { parseProposalRegistry } from "#src/lib/inbox.js";
import { mintProofDebtProposals } from "#src/lib/measurement-cadence.js";
import { loadPlan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { world } from "#test/helpers/why-me-world.js";

// W1-T13202. OBSERVED 2026-11-16 on the Azure host: state/inbox-proposals.json was 2,448,321 bytes holding ~2,343
// proposals, past the 2 MiB / 2,048 bounds the gardener was sized with on 2026-10-17, so every pass failed in capture.
const TASK = "W1-T1200", ID = `proof-debt:${TASK}`;
const DAY = Date.parse("2026-11-16T15:30:00.000Z");

async function fixture(t: TestContext, count: number, summaryBytes: number, now = DAY) {
  const w = await world(t);
  appendFileSync(w.planPath, `- id: ${TASK}\n  title: Repair mechanical proof\n  repo: core\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n`);
  mintProofDebtProposals([{ taskId: TASK, criterionIndex: 0, cause: "grep-path-absent", claim: "has proof", proof: "grep: missing in src/missing.ts" }], () => "plan/tasks.yaml", w.registry,
    { sourcePermit: proofDebtPopulationPermit(loadPlan(w.planPath).tasks.filter(task => task.id === TASK)) });
  const proposals = parseProposalRegistry(readFileSync(w.registry, "utf8"));
  proposals.push(...Array.from({ length: count - proposals.length }, (_, i) => ({ id: `ruling:human-${String(i).padStart(5, "0")}`, summary: "Human approval needed. " + "x".repeat(summaryBytes), evidenceAnchors: [] })));
  writeFileSync(w.registry, JSON.stringify({ proposals }));
  w.deps.statusGithub = fakeGitHub({ findMergedByTrailer: id => id === TASK ? { number: 1200, url: `https://github.com/${w.repository}/pull/1200`, state: "MERGED", headRefName: `run-${TASK}-123456` } : null,
    headRefName: () => `run-${TASK}-123456`, prBody: () => `Remudero-Task: ${TASK}`, changedFiles: () => ["src/fix.ts"] });
  const scope = { repository: w.repository, instance: w.instance, root: w.root };
  const ports = (at = now) => defaultInboxGardenerPorts({ stateDir: w.state, scope, planPath: w.planPath, codeSha: "c".repeat(40), clock: fixedClock(at), githubJson: async args =>
    args[1] === "view" ? { files: [{ path: "src/fix.ts" }] } : [{ number: 1200, url: `https://github.com/${w.repository}/pull/1200`, state: "MERGED", headRefName: `run-${TASK}-123456`, headRefOid: "a".repeat(40), mergeCommit: { oid: "b".repeat(40) }, body: `Remudero-Task: ${TASK}` }] });
  return { ...w, scope, ports };
}
function warnings(ledger: string): Array<Record<string, unknown>> {
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.step === INBOX_GARDENER_SOURCE_WARNING_STEP);
}

test("W1-T13202 criterion 1: a registry the size of production on 2026-11-16 is captured and judged instead of refused", async t => {
  const f = await fixture(t, 2343, 960);
  const bytes = Buffer.byteLength(readFileSync(f.registry, "utf8"));
  assert.ok(bytes > 2 * 1024 * 1024, `positive control: the fixture (${bytes} bytes) is past the old 2 MiB bound`);
  assert.ok(bytes < INBOX_GARDENER_SOURCE_LIMITS.registryBytes);
  await f.refresh();
  const pack = await f.ports().capture();
  assert.equal(pack.candidates.length, 2343, "every proposal is a candidate, not the population error");
  assert.equal(pack.coverage.registry, "observed");
  const result = await runInboxGardener({ stateDir: f.state, scope: f.scope, ports: { ...f.ports(), judge: async () => assert.fail("no judge"), mirror: async () => assert.fail("shadow has no live effects") }, mode: "shadow" });
  assert.notEqual(result.state, "failed");
  assert.equal("evaluated" in result && result.evaluated, 2343, "W1-T14978: the pass sweeps every proposal");
});

test("W1-T13202 criterion 2: a source past three quarters of its bound warns once per UTC day and the pass still runs", async t => {
  const f = await fixture(t, Math.ceil(INBOX_GARDENER_SOURCE_LIMITS.proposals * 0.75) + 1, 0);
  const ledger = join(f.state, "ledger.ndjson");
  await f.refresh();
  assert.equal((await f.ports().capture()).candidates.length, Math.ceil(INBOX_GARDENER_SOURCE_LIMITS.proposals * 0.75) + 1);
  await f.ports(DAY + 60_000).capture();
  const first = warnings(ledger);
  assert.equal(first.length, 1, "one warning across two captures on the same day");
  assert.deepEqual({ source: first[0]!.source, bound: first[0]!.bound }, { source: "registry-proposals", bound: INBOX_GARDENER_SOURCE_LIMITS.proposals });
  assert.equal(first[0]!.size, Math.ceil(INBOX_GARDENER_SOURCE_LIMITS.proposals * 0.75) + 1);
  await f.ports(DAY + 24 * 3600_000).capture();
  assert.equal(warnings(ledger).length, 2, "the next UTC day warns again");
  // Below the share nothing is written: a direct call with a healthy size is silent.
  assert.deepEqual(warnInboxGardenerNearBound(f.state, fixedClock(DAY + 48 * 3600_000), [{ source: "thread-bytes", size: 10, bound: 100 }]), []);
  assert.equal(warnings(ledger).length, 2);
});

test("W1-T13202 criterion 2: a warning fault never fails the pass and is retried next pass", t => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t13202-`)); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = fixedClock(DAY), near = [{ source: "registry-bytes", size: 80, bound: 100 }];
  // An unwritable ledger: nothing is marked, so the warning is not lost.
  mkdirSync(join(dir, "ledger.ndjson"));
  assert.deepEqual(warnInboxGardenerNearBound(dir, clock, near), []);
  assert.equal(existsSync(join(dir, "inbox-gardener-near-bound.json")), false);
  rmSync(join(dir, "ledger.ndjson"), { recursive: true });
  // An unreadable and unwritable marker: the row is still written once, and the pass still returns.
  mkdirSync(join(dir, "inbox-gardener-near-bound.json"));
  assert.deepEqual(warnInboxGardenerNearBound(dir, clock, near), ["registry-bytes"]);
  assert.equal(warnings(join(dir, "ledger.ndjson")).length, 1);
});

test("W1-T13202 criterion 3: a source over its bound still refuses the pass and retires nothing", async t => {
  const f = await fixture(t, INBOX_GARDENER_SOURCE_LIMITS.proposals + 1, 0);
  await assert.rejects(f.ports().capture(), /population exceeds/);
  const result = await runInboxGardener({ stateDir: f.state, scope: f.scope, ports: { ...f.ports(), proof: async () => assert.fail("over-bound proof"), judge: async () => assert.fail("over-bound judge") }, mode: "act" });
  assert.equal(result.state, "failed");
  assert.equal("retired" in result ? result.retired : 0, 0);
});
