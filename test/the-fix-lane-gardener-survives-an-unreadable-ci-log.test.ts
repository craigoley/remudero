import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fixedClock } from "#src/lib/clock.js";
import { actionsJobIdOf, fixLaneGardenSpec, readFixLaneEvidence } from "#src/lib/fix-lane-gardener.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const NOW = Date.UTC(2026, 9, 10, 12);
const at = (hour: number) => fixedClock(NOW + hour * 3_600_000).iso();
const UUID = "79bcd36e-1735-5d23-aa94-a1a9e0d4fef4";
const coverage = "diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests\n  - src/lib/reader.ts:6";
const red = (check: string, signature: string) => ({ check, signature });
const rows = (): LedgerRecord[] => [
  { step: "fix.dispatch", pr_number: 10, ts: at(-6), round_id: "r1", head_sha: "old", ci_failures: [red("coverage-ratchet", "diff-coverage: BLOCKED")] },
  { step: "fix.dispatch", pr_number: 10, ts: at(-5), round_id: "r1b", head_sha: "old", ci_failures: [red("coverage-ratchet", "diff-coverage: BLOCKED")] },
  { step: "fix.done", pr_number: 10, ts: at(-4), round_id: "r1", fix_outcome: "FIXED", head_sha: "old", pushed_head_sha: "new" },
  { step: "fix.dispatch", pr_number: 10, ts: at(-3), round_id: "r2", head_sha: "new", ci_failures: [red("rule-checks", "test/the-affected-suite-reach-ratchet.test.ts")] },
];

/** A check-runs answer: the coverage check's id/external_id/details_url name no Actions job, and its log read answers 404. */
const unreadableShim = (t: TestContext) => {
  const shim = ghShim([
    { when: "commits/old/check-runs", stdout: JSON.stringify([{ check_runs: [
      { id: 9, name: "coverage-ratchet", conclusion: "failure", external_id: UUID, details_url: "https://example.test/checks/9" },
    ] }]) },
    { when: `actions/jobs/${UUID}/logs`, stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: "actions/jobs/9/logs", stderr: "gh: Not Found (HTTP 404)", exit: 1 },
  ]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const saved = new Map(["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_SHARED_READ_GAP_MS"].map(key => [key, process.env[key]]));
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(shim.dir, "cache");
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return shim;
};

test("W1-T8229: a job id is never taken from external_id", async t => {
  assert.equal(actionsJobIdOf({ id: 9, details_url: "https://example.test/checks/9" }), undefined);
  assert.equal(actionsJobIdOf({ id: 9, details_url: "https://example.test/checks/9", external_id: UUID } as never), undefined);
  assert.equal(actionsJobIdOf({ id: 9, external_id: "46" } as never), undefined);
  const shim = unreadableShim(t);
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  await readFixLaneEvidence({ owner: "acme", repo: "remudero" }, rows(), (step, extra) => logged.push([step, extra]));
  assert.deepEqual(shim.calls().filter(c => c.includes("/logs")), []);
  assert.deepEqual(logged, []);
});

test("W1-T8229: a numeric job id is read from either details_url spelling", async t => {
  assert.equal(actionsJobIdOf({ id: 1, details_url: "https://github.com/acme/remudero/actions/runs/5/job/123" }), "123");
  assert.equal(actionsJobIdOf({ id: 1, details_url: "https://github.com/acme/remudero/actions/runs/5/jobs/124?pr=1" }), "124");
  assert.equal(actionsJobIdOf({ id: 77, app: { slug: "github-actions" } }), "77");
  assert.equal(actionsJobIdOf({ id: 77, app: { slug: "some-other-app" } }), undefined);
  const shim = ghShim([
    { when: "commits/old/check-runs", stdout: JSON.stringify([{ check_runs: [
      { id: 1, name: "coverage-ratchet", conclusion: "failure", external_id: UUID, details_url: "https://github.com/acme/remudero/actions/runs/5/job/123" },
      { id: 2, name: "diff-coverage", conclusion: "failure", external_id: UUID, details_url: "https://github.com/acme/remudero/actions/runs/5/jobs/124" },
    ] }]) },
    { when: "actions/jobs/", stdout: "diff-coverage: OK" },
  ]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const saved = new Map(["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_SHARED_READ_GAP_MS"].map(key => [key, process.env[key]]));
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(shim.dir, "cache");
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  await readFixLaneEvidence({ owner: "acme", repo: "remudero" }, rows().slice(0, 1));
  assert.deepEqual(shim.calls().filter(c => c.includes("/logs")).map(c => c.replace(/^api /, "")), [
    "repos/acme/remudero/actions/jobs/123/logs", "repos/acme/remudero/actions/jobs/124/logs",
  ]);
});

const garden = (logged: Array<[string, Record<string, unknown> | undefined]>) => fixLaneGardenSpec({ repoRoot: ".", stateDir: ".", clock: fixedClock(NOW),
  log: (step, extra) => { logged.push([step, extra]); }, openWorkspace: () => { throw new Error("unexpected workspace"); } }, {
  owner: "acme", repo: "remudero", mintTaskId: () => "W1-T9001", ledgerRecords: rows,
  planState: () => ({ tasks: [] }), prOutcomes: () => new Map(), interventions: () => ({ ok: true, interventions: [] }),
});

test("W1-T8229: an unreadable coverage log leaves the pass completing", async t => {
  // A details_url naming an Actions job whose log answers 404: the read must degrade, not throw.
  const shim = ghShim([
    { when: "commits/old/check-runs", stdout: JSON.stringify([{ check_runs: [
      { id: 9, name: "coverage-ratchet", conclusion: "failure", external_id: UUID, details_url: "https://github.com/acme/remudero/actions/runs/5/job/321" },
    ] }]) },
    { when: "actions/jobs/321/logs", stderr: `gh: Not Found (HTTP 404)`, exit: 1 },
  ]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const saved = new Map(["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_SHARED_READ_GAP_MS"].map(key => [key, process.env[key]]));
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(shim.dir, "cache");
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  const inventory = await garden(logged).inventoryAsync!();
  assert.ok(shim.calls().some(c => c.includes("actions/jobs/321/logs")), "the log was attempted");
  // The head with no readable coverage log prices no coverage class; the pass still prices what it can read.
  assert.deepEqual(inventory.priced.map(p => p.key), ["same-red-set"]);
  assert.equal(logged.some(([step]) => step.endsWith("gardener_failed")), false);
});

test("W1-T8229: the unreadable head is recorded once as missing evidence", async t => {
  const shim = ghShim([
    { when: "commits/old/check-runs", stdout: JSON.stringify([{ check_runs: [
      { id: 9, name: "coverage-ratchet", conclusion: "failure", external_id: UUID, details_url: "https://github.com/acme/remudero/actions/runs/5/job/321" },
    ] }]) },
    { when: "actions/jobs/321/logs", stderr: `gh: Not Found (HTTP 404)`, exit: 1 },
  ]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const saved = new Map(["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_SHARED_READ_GAP_MS"].map(key => [key, process.env[key]]));
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(shim.dir, "cache");
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  const evidence = await readFixLaneEvidence({ owner: "acme", repo: "remudero" }, rows(), (step, extra) => logged.push([step, extra]));
  const unreadable = logged.filter(([step]) => step === "fix-lane.evidence_unreadable");
  assert.equal(unreadable.length, 1, "two dispatches at one head still ledger one row");
  assert.equal(unreadable[0]![1]!.head_sha, "old");
  assert.equal(unreadable[0]![1]!.check, "coverage-ratchet");
  assert.match(String(unreadable[0]![1]!.reason), /404/);
  assert.equal(logged.some(([step]) => step.endsWith("gardener_failed")), false);
  assert.equal(evidence.readCoverageLog!("old"), undefined);
  assert.equal(shim.calls().filter(c => c.includes("actions/jobs/321/logs")).length, 1);
});
