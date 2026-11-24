import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runConflictGarden, type ConflictGardenPorts } from "#src/lib/conflict-gardener.js";
import { conflictGardenGovernorVerdict } from "#src/lib/conflict-gardener-governor.js";
import { runSweep, type OpenPrView } from "#src/lib/sweep.js";
import { conflictGardenPass } from "#src/lib/garden-registry.js";
import { renderFixPrompt } from "#src/lib/prompt-render.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 24);
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString();
const pr = (prNumber: number, headSha = `head-${prNumber}`, mergeableState = "dirty"): OpenPrView => ({
  prNumber, prUrl: `https://github.com/acme/remudero/pull/${prNumber}`, headSha, mergeableState,
  checksState: "none", reviewState: "none", unmetCriteria: [], priorStrikes: 0,
  autoMergeArmed: false, createdAt: at(-48), lastActivityAt: at(-12),
});
const dirty = (prNumber: number, hours: number, extra: Record<string, unknown> = {}) => ({
  step: "sweep.disposed", pr_number: prNumber, head_sha: pr(prNumber).headSha,
  merge_state: "dirty", blocker: "conflict", ts: at(hours), ...extra,
});
const act = (tier: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  step: "conflict_garden.act", tier, outcome: "shadow", ts: at(-1), ...extra,
});
function fixture(prs: OpenPrView[], rows: Record<string, unknown>[], overrides: Partial<ConflictGardenPorts<OpenPrView>> = {}) {
  const events: Record<string, unknown>[] = [];
  const ports: ConflictGardenPorts<OpenPrView> = {
    now: () => NOW, snapshot: () => ({ prs, mainSha: "main" }), readLedger: async () => [...rows, ...events],
    record: row => { events.push(row); }, dependents: () => 0, hold: async () => undefined,
    verify: async candidate => ({ outcome: "pending", head: candidate.headSha }),
    prepare: async () => ({ ready: true }), act: async () => ({ outcome: "no-op", reason: "no merge" }),
    escalate: async () => assert.fail("the gardener escalated without a judgment"),
    ...overrides,
  };
  return { ports, events };
}

test("test/gardeners/a-conflict-gardener-resolves-what-the-sweep-left-conflicted.test.ts", async () => {
  const rows = [
    dirty(10, -24), dirty(10, -22, { merge_state: "clean", blocker: "awaiting-review" }),
    dirty(11, -22), dirty(11, -18, { merge_state: "clean", blocker: "awaiting-review" }),
    dirty(1, -12), dirty(2, -12), dirty(3, -1), dirty(4, -12), dirty(5, -12), dirty(12, -12),
    dirty(6, -12, { acted: true }),
    { step: "sweep.merge_probe", pr_number: 7, head_sha: "head-7", main_sha: "old", verdict: "conflict", ts: at(-15) },
    { step: "sweep.merge_probe", pr_number: 8, head_sha: "head-8", main_sha: "main", verdict: "conflict", ts: at(-15) },
    dirty(9, -12), { step: "sweep.merge_probe", pr_number: 9, head_sha: "head-9", main_sha: "main", verdict: "clean", ts: at(-2) },
  ];
  const { ports, events } = fixture([
    ...[1, 2, 3, 4, 5, 6].map(n => pr(n)),
    { ...pr(7, "head-7", "unknown"), mergeState: "dirty", mergeConflictSource: "merge-probe" },
    pr(8, "head-8", "clean"), pr(9), pr(12),
  ], rows, {
    dependents: p => p.prNumber === 2 ? 3 : 0,
    hold: async p => new Map([[4, "live fix claim"], [5, "operator merge hold"], [12, "sweep action in flight"]]).get(p.prNumber),
  });
  await runConflictGarden(ports);
  const reports = events.filter(row => row.step === "conflict_garden.report");
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.p90_ms, 4 * HOUR);
  assert.deepEqual(reports[0]?.ranked, [8, 2, 1, 9]);
  assert.deepEqual(reports[0]?.skipped, [
    { pr_number: 3, reason: "conflict age is within the measured p90" },
    { pr_number: 4, reason: "live fix claim" },
    { pr_number: 5, reason: "operator merge hold" },
    { pr_number: 6, reason: "sweep acted at this head" },
    { pr_number: 12, reason: "sweep action in flight" },
  ]);
});

test("W1-T11172 criterion 2 tries deterministic before any round and only clears confirmed wedges", async () => {
  const live = ["deterministic", "round", "wedge"].map(tier => act(tier));
  const calls: string[] = [];
  const { ports, events } = fixture([pr(1)], [dirty(1, -12), ...live], {
    act: async (_pr, tier) => {
      calls.push(tier);
      return { outcome: "pushed", reason: "clean local merge", newHead: "merged", parentGreen: false };
    },
  });
  await runConflictGarden(ports);
  assert.deepEqual(calls, ["deterministic"]);
  assert.equal(events.find(row => row.step === "conflict_garden.act")?.new_head_sha, "merged");

  const fallback = fixture([pr(1)], [dirty(1, -12), ...live], {
    act: async (_pr, tier) => {
      calls.push(tier);
      return { outcome: "no-op", reason: "no deterministic resolution" };
    },
    prepare: async (_pr, tier) => tier === "round" ? { ready: false, reason: "stale seed" } : { ready: true },
  });
  calls.length = 0;
  await runConflictGarden(fallback.ports);
  assert.deepEqual(calls, ["deterministic", "wedge"]);
  assert.deepEqual(fallback.events.filter(row => row.step === "conflict_garden.act").map(row => row.tier), calls);

  const prompt = renderFixPrompt({
    task: { id: "W1-T1", title: "Resolve a sample conflict" }, branch: "run-W1-T1-1", round: 1,
    evidence: { mergeConflict: {
      files: [{ path: "src/work.ts", oursDeleted: 2, theirsDeleted: 1 }],
      oursLog: "ours log", theirsLog: "main log",
      intent: { prBody: "why this pull request exists", mainByPath: [{ path: "src/work.ts", log: "main subject\nmain body" }] },
    } },
  });
  for (const detail of ["src/work.ts", "ours log", "main log", "why this pull request exists", "main subject", "main body"])
    assert.ok(prompt.includes(detail), detail);
});

test("W1-T11172 criterion 3 judges each completed round and verifies only the exact green head", async () => {
  const rows = [dirty(1, -12), act("deterministic"), act("round"), act("wedge")];
  const calls: string[] = [];
  let head = pr(1);
  let verifyState: "pending" | "still-dirty" | "verified" = "pending";
  const { ports, events } = fixture([head], rows, {
    snapshot: () => ({ prs: [head], mainSha: "main" }),
    act: async (_pr, tier) => tier === "round" ? { outcome: "round", reason: "worker ran", newHead: "pushed" }
      : { outcome: "no-op", reason: "no clean merge" },
    verify: async () => ({ head: "pushed", outcome: verifyState }),
    judge: async input => {
      calls.push(String(input.remedyHistory?.at(-1)?.tier));
      return verifyState !== "pending" ? { verdict: "escalate", loop: "conflict", reason: "same hunk" } : undefined;
    },
    escalate: async p => { assert.equal(p.headSha, "pushed"); calls.push("escalate"); },
  });
  await runConflictGarden(ports);
  await runConflictGarden(ports);
  assert.deepEqual(calls, ["round", "round"]);
  assert.equal(events.filter(row => row.step === "conflict_garden.act" && row.tier === "round").length, 1);
  assert.equal(events.some(row => row.step === "conflict_garden.verified" && row.outcome === "verified"), false);
  head = pr(1, "pushed");
  verifyState = "still-dirty";
  await runConflictGarden(ports);
  verifyState = "verified";
  head = pr(1, "pushed", "clean");
  await runConflictGarden(ports);
  assert.deepEqual(calls, ["round", "round", "round", "escalate"]);
  assert.equal(events.filter(row => row.step === "conflict_garden.verified" && row.outcome === "verified").length, 1);
});

test("W1-T11172 criterion 4 starts in shadow, slows repeats, and ages harm out", async () => {
  const verdict = (rows: Record<string, unknown>[], nowMs = NOW) =>
    conflictGardenGovernorVerdict("round", rows, { nowMs, prNumber: 1 });
  assert.equal(verdict([]).tier, "shadow");
  assert.equal(verdict([act("round")]).tier, "live");
  const writes = [-2, -1].map((hours, i) => act("round", {
    outcome: "round", pr_number: 1, act_id: `act-${i}`, ts: at(hours), new_head_sha: `sha-${i}`,
  }));
  assert.equal(verdict(writes, NOW - HOUR / 2).tier, "slow");
  const harms = writes.map(row => ({ step: "conflict_garden.verified", tier: "round", act_id: row.act_id,
    ts: at(-0.5), harmful: true }));
  assert.equal(verdict([...writes, ...harms]).tier, "stopped");
  assert.equal(verdict([...writes, ...harms], NOW + 8 * 24 * HOUR).tier, "shadow");

  const { ports, events } = fixture([pr(1)], [dirty(1, -12)], {
    act: async () => assert.fail("a shadow pass attempted a write"),
  });
  await runConflictGarden(ports);
  assert.equal(events.find(row => row.step === "conflict_garden.act")?.outcome, "shadow");

  const stopped = fixture([pr(1)], [dirty(1, -12), act("deterministic"), ...writes, ...harms], {
    act: async (_p, tier) => {
      assert.equal(tier, "deterministic");
      return { outcome: "no-op", reason: "manual hunk" };
    },
  });
  await runConflictGarden(stopped.ports);
  assert.deepEqual(stopped.events.filter(row => row.step === "conflict_garden.act").map(row => row.tier), ["deterministic"]);
});

test("the full sweep reaches the paced conflict pass and verifies its exact pushed head", async t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-conflict-garden-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const rows: Record<string, unknown>[] = [dirty(1, -12), act("deterministic")];
  writeFileSync(ledgerPath, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const original = { ...pr(1), taskId: "W1-T1", headRefName: "run-W1-T1-1" };
  let current: OpenPrView = original;
  let writes = 0;
  await runSweep([original], {
    runId: "conflict-garden-fixture", ledgerPath, repairAdmissionSurface: "full", actionable: () => false,
    now: () => NOW, readMainTip: () => "main", readLedger: () => rows,
    appendLine: (_path, row) => {
      rows.push(row);
      appendFileSync(ledgerPath, JSON.stringify(row) + "\n");
    },
    continueReviewAdmissions: Object.assign(() => false, { conflictGarden: conflictGardenPass }),
    conflictGardenRepository: {
      prPrefix: "https://github.com/acme/remudero/pull/",
      ownerAtHead: async () => ({ headRepoFork: false }), hasFixClaim: () => false, reverted: async () => false,
    },
    rereadPrAtAct: async () => current,
    regenerateConflict: async (candidate, main, mode) => {
      assert.equal(candidate.headSha, original.headSha);
      assert.equal(main, "main");
      assert.equal(mode, "clean-merge");
      writes++;
      current = { ...original, headSha: "merged", mergeableState: "clean", checksState: "green" };
      return { outcome: "pushed", newHeadSha: current.headSha, paths: [] };
    },
    arm: () => assert.fail("a conflict repair must not arm the PR"),
    close: () => assert.fail("a conflict repair must not close the PR"),
    dispatchFix: () => assert.fail("a clean deterministic merge must not dispatch a worker"),
    escalate: () => assert.fail("a clean deterministic merge must not escalate"),
  });
  assert.equal(writes, 1);
  assert.equal(rows.find(row => row.step === "conflict_garden.verified")?.head_sha, "merged");
  assert.equal(rows.find(row => row.step === "conflict_garden.verified")?.outcome, "verified");
  assert.equal(rows.filter(row => row.step === "conflict_garden.report").length, 1);
});
