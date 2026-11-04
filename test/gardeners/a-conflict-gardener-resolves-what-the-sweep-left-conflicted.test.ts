import assert from "node:assert/strict";
import { test } from "node:test";
import { runConflictGarden, conflictGardenIntent, conflictGardenLedgerReader, CONFLICT_GARDEN_INTENT_CHARS, type ConflictGardenPorts } from "#src/lib/conflict-gardener.js";
import { conflictGardenGovernorVerdict, CONFLICT_GARDEN_TIERS } from "#src/lib/conflict-gardener-governor.js";
import { runConflictGardenTier, regenerateConflictViaGit, type OpenPrView } from "#src/lib/sweep.js";
import { renderFixPrompt } from "#src/lib/prompt-render.js";
import { stepConflictGardenGovernor } from "#src/lib/daemon.js";
import { conflictGardenPass, gardenSchedule, REGISTERED_GARDEN_NAMES } from "#src/lib/garden-registry.js";
import { withTempDir } from "#src/lib/tmp.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { conflictGardenRunTaskPorts, buildRegisteredGarden } from "#src/run-task.js";
import { RUN_CHILD_SCHEMA, childIdentity, writeStatus, type RunChildStatus } from "#src/lib/run-child-contract.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

const now = Date.now();
const hour = 3_600_000;
const at = (h: number) => new Date(now + h * hour).toISOString();
const pr = (n: number, fields: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: n, prUrl: `https://github.com/a/b/pull/${n}`, taskId: `W1-T${n}`,
  headSha: `head-${n}`, headRefName: `run-W1-T${n}-123`, mergeableState: "dirty",
  reviewState: "none", checksState: "none", autoMergeArmed: false, priorStrikes: 0,
  unmetCriteria: [], lastActivityAt: at(-1),
  ...fields,
});
const dirty = (n: number, h: number) => ({ ts: at(h), step: "sweep.disposed", pr_number: n,
  head_sha: `head-${n}`, disposition: "conflicted", acted: false });
const live = () => CONFLICT_GARDEN_TIERS.map(tier => ({ ts: at(-1), step: "conflict_garden.act",
  tier, mode: "shadow", outcome: "clean", pr_number: 99, head_sha: "old" }));
function fixture(rows: Record<string, unknown>[] = live(), prs = [pr(1)]) {
  const calls: string[] = [];
  const ports: ConflictGardenPorts = {
    now: () => now, runId: "garden", snapshot: async () => ({ prs, mainSha: "main" }),
    ledger: async () => [...rows], log: (step, extra) => rows.push({ ts: at(0), step, ...extra }),
    skip: async () => undefined, dependents: () => 0,
    act: async (_pr, tier) => { calls.push(tier); return { outcome: "unchanged" }; },
    verify: async p => ({ headSha: p.headSha, mergeableState: "dirty", checksState: "none" }),
    judge: async () => ({ verdict: "continue", reason: "next repair can clear it" }),
    escalate: async () => { calls.push("escalate"); return "issue/1"; },
  };
  return { rows, calls, ports };
}

test("test/gardeners/a-conflict-gardener-resolves-what-the-sweep-left-conflicted.test.ts", async () => {
  const f = fixture([...live(), dirty(90, -10), { ...dirty(90, -9), disposition: "mergeable" },
    dirty(91, -8), { ...dirty(91, -6), disposition: "mergeable" },
    dirty(1, -5), dirty(2, -4), dirty(3, -0.5), dirty(4, -7), dirty(5, -9), dirty(6, -10),
    { ts: at(-1), step: "sweep.disposed", pr_number: 6, head_sha: "head-6", acted: true, disposition: "conflicted" },
    { ts: at(-6), step: "sweep.merge_probe", pr_number: 7, head_sha: "head-7", main_sha: "main", verdict: "conflict" },
    { ts: at(-6), step: "sweep.merge_probe", pr_number: 8, head_sha: "head-8", main_sha: "stale-main", verdict: "conflict" },
  ], [pr(1), pr(2), pr(3), pr(4), pr(5), pr(6), pr(7, { mergeableState: "clean" }), pr(8, { mergeableState: "clean" })]);
  f.ports.skip = async p => p.prNumber === 4 ? "live fix claim" : p.prNumber === 5 ? "operator merge hold" : undefined;
  await runConflictGarden(f.ports);
  const report = f.rows.findLast(r => r.step === "conflict_garden.report")!;
  assert.equal(report.p90_ms, 2 * hour);
  assert.deepEqual((report.ranked as { pr_number: number }[]).map(r => r.pr_number), [7, 1, 2]);
  assert.deepEqual((report.skipped as { reason: string }[]).map(r => r.reason), ["live fix claim", "operator merge hold", "sweep acted at this head"]);
  assert.equal(f.rows.filter(r => r.step === "conflict_garden.report").length, 1);
});

test("W1-T11172 criterion 2: deterministic merge precedes a round and wedge clearing", async () => {
  const clean = fixture();
  clean.ports.act = async (_p, tier) => { clean.calls.push(tier); return { outcome: "pushed", newHeadSha: "new" }; };
  await runConflictGarden(clean.ports);
  assert.deepEqual(clean.calls, ["deterministic"]);
  const stuck = fixture();
  await runConflictGarden(stuck.ports);
  assert.deepEqual(stuck.calls, ["deterministic", "round", "wedge"]);
  assert.deepEqual(stuck.rows.filter(r => r.step === "conflict_garden.act" && r.mode === "live").map(r => r.tier),
    ["deterministic", "round", "wedge"]);
});

test("W1-T11172 criterion 3: verification requires recomputed mergeability and green checks; only the judge escalates", async () => {
  for (const [mergeableState, checksState, outcome] of [
    ["clean", "green", "verified"], ["unknown", "green", "pending"], ["dirty", "green", "still-dirty"],
    ["clean", "red", "ci-red"], ["clean", "none", "pending"],
  ] as const) {
    const f = fixture();
    f.ports.act = async () => ({ outcome: "pushed", newHeadSha: "new" });
    f.ports.verify = async () => ({ headSha: "new", mergeableState, checksState });
    await runConflictGarden(f.ports);
    assert.equal(f.rows.findLast(r => r.step === "conflict_garden.verified")?.outcome, outcome);
  }
  const f = fixture();
  let judged = 0;
  f.ports.judge = async input => {
    assert.ok(input.remedyHistory!.length > 0);
    judged++;
    return { verdict: "escalate", loop: "semantic conflict", reason: "neither side can preserve the contract" };
  };
  await runConflictGarden(f.ports);
  await runConflictGarden(f.ports);
  assert.equal(f.calls.filter(c => c === "escalate").length, 1);
  assert.equal(judged, 1);
  const unavailable = fixture();
  unavailable.ports.judge = undefined;
  await runConflictGarden(unavailable.ports);
  assert.deepEqual(unavailable.calls, ["deterministic", "round"]);
  assert.equal(unavailable.rows.findLast(r => r.step === "conflict_garden.judged")?.verdict, "unavailable");
  for (let round = 0; round < 4; round++) await runConflictGarden(unavailable.ports);
  assert.equal(unavailable.calls.includes("escalate"), false);
  assert.equal(unavailable.rows.filter(r => r.step === "conflict_garden.act" && r.tier === "round" && r.mode === "live").length, 5);
});

test("W1-T11172 criterion 4: receipt governor shadows, slows, stops on repeated harm and ages evidence out", async () => {
  assert.equal(conflictGardenGovernorVerdict("round", [], {}, now).tier, "shadow");
  assert.equal(conflictGardenGovernorVerdict("round", live(), {}, now).tier, "live");
  const acts = [-3, -2].map(h => ({ ts: at(h), step: "conflict_garden.act", tier: "round", mode: "live",
    pr_number: 1, head_sha: "head-1", new_head_sha: `new${h}`, outcome: "pushed", parent_green: true }));
  assert.equal(conflictGardenGovernorVerdict("round", [...live().map(r => ({ ...r, ts: at(-4) })), ...acts], {}, now - 1.5 * hour).tier, "slow");
  const harm = acts.map(a => ({ ...a, step: "conflict_garden.verified", parent_green: true, outcome: "ci-red" }));
  assert.equal(conflictGardenGovernorVerdict("round", [...acts, ...harm], {}, now).tier, "stopped");
  assert.equal(conflictGardenGovernorVerdict("round", [...acts, ...harm], {}, now + 30 * 24 * hour).tier, "shadow");
  assert.equal(conflictGardenGovernorVerdict("round", live(), { pause: "operator" }, now).tier, "stopped");
  const f = fixture([]);
  await runConflictGarden(f.ports);
  assert.deepEqual(f.calls, []);
  assert.equal(f.rows.findLast(r => r.step === "conflict_garden.act")?.mode, "shadow");
  assert.equal(f.rows.findLast(r => r.step === "conflict_garden.act")?.outcome, "clean");
});

test("W1-T11172 criterion 2: stale seeds re-enter the shared conflicted dispatch and retain settlement evidence", async () => {
  const rows: Record<string, unknown>[] = [{ ...dirty(1, -8), acted: true, run_id: "dead-owner" }];
  const calls: string[] = [];
  const deps: Parameters<typeof runConflictGardenTier>[3] = {
    runId: "new-owner", ledgerPath: "unused", readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); },
    dispatchFix: async (_pr, evidence) => {
      calls.push("dispatch");
      assert.equal(evidence.progressApproach, "preserve the deletion");
      assert.equal(evidence.baseSha, "main");
      assert.equal(evidence.mergeConflict?.intent, "both intents");
    },
  };
  const p = pr(1, { body: "keep the main deletion", mergeConflict: { files: [{ path: "a.ts", oursDeleted: 0, theirsDeleted: 1 }],
    oursLog: "ours", theirsLog: "theirs" } });
  assert.equal((await runConflictGardenTier(p, "round", "main", deps)).outcome, "unchanged");
  assert.deepEqual(calls, []);
  assert.equal((await runConflictGardenTier(p, "wedge", "main", deps, "preserve the deletion", "both intents")).outcome, "dispatched");
  assert.deepEqual(calls, ["dispatch"]);
  assert.equal(rows.find(r => r.step === "sweep.fix.seed_orphaned")?.seed_run_id, "dead-owner");
  deps.workerAdmissionHold = () => "operator pause";
  assert.equal((await runConflictGardenTier(p, "wedge", "main", deps)).reason, "operator pause");
  deps.workerAdmissionHold = undefined;
  deps.readLiveState = async () => ({ ok: true, state: "OPEN", headSha: "moved" });
  assert.equal((await runConflictGardenTier(p, "round", "main", deps)).outcome, "held");
  deps.readLiveState = async () => ({ ok: true, state: "OPEN", headSha: p.headSha });
  assert.equal((await runConflictGardenTier({ ...p, mergeConflict: undefined }, "wedge", "main", deps)).reason,
    "merge-conflict file evidence unavailable");
  deps.claimFixAdmission = () => ({ admitted: false, reason: "memory floor" });
  assert.equal((await runConflictGardenTier(p, "wedge", "main", deps)).reason, "memory floor");
  deps.claimFixAdmission = undefined;
  assert.equal((await runConflictGardenTier(p, "wedge", "main", deps, "preserve the deletion", "both intents")).outcome, "dispatched");
});

test("W1-T11172 criterion 2: merge prompt includes fenced PR intent and main subjects and bodies for each conflicted file", async () => {
  const p = pr(1, { body: "retain the public api", mergeConflict: { files: [
    { path: "a.ts", oursDeleted: 1, theirsDeleted: 0 }, { path: "b.ts", oursDeleted: 0, theirsDeleted: 2 },
  ], oursLog: "branch change", theirsLog: "main change" } });
  const calls: string[][] = [];
  const git = async (args: readonly string[]) => {
    calls.push([...args]);
    return args[0] === "merge-base" ? "base\n" : `main subject for ${args.at(-1)}\nmain body preserves deletion`;
  };
  const intent = await conflictGardenIntent(p, "main", git);
  assert.deepEqual(calls, [["merge-base", "head-1", "main"],
    ["log", "--format=%s%n%b", "base..main", "--", "a.ts"], ["log", "--format=%s%n%b", "base..main", "--", "b.ts"]]);
  const prompt = renderFixPrompt({ task: { id: "W1-T1", title: "retain api" }, branch: p.headRefName!, round: 1,
    evidence: { mergeConflict: { ...p.mergeConflict!, intent } } });
  for (const expected of ["retain the public api", "main subject for a.ts", "main subject for b.ts", "main body preserves deletion", "branch change", "main change"])
    assert.ok(prompt.includes(expected), expected);
  const bounded = await conflictGardenIntent({ ...p, body: "x".repeat(CONFLICT_GARDEN_INTENT_CHARS * 2) }, "main", git);
  assert.ok(bounded.length <= CONFLICT_GARDEN_INTENT_CHARS);
  assert.ok(bounded.includes("main subject for b.ts"), "long PR bodies cannot erase main's intent");
});

test("W1-T11172 criterion 2: clean local merge and byte-proven take-main use the fenced sweep resolver", async t => {
  for (const redundant of [false, true]) {
    const origin = gitRepo({ scope: t, kind: "conflict-origin", bare: true });
    const local = gitRepo({ scope: t, kind: "conflict-local" });
    local.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
    local.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
    local.addRemote("origin", origin.dir);
    writeFileSync(join(local.dir, "a.ts"), "base\n");
    local.git("add", ".");
    local.git("commit", "-qm", "chore(test): base");
    local.git("checkout", "-qb", "run-W1-T1-123");
    writeFileSync(join(local.dir, redundant ? "a.ts" : "branch.txt"), "branch intent\n");
    local.git("add", ".");
    local.git("commit", "-qm", "chore(test): branch intent");
    const head = local.git("rev-parse", "HEAD");
    local.git("push", "-q", "origin", "run-W1-T1-123");
    local.git("checkout", "-q", "main");
    writeFileSync(join(local.dir, redundant ? "a.ts" : "main.txt"), "main intent\n");
    local.git("add", ".");
    local.git("commit", "-qm", "chore(test): main intent");
    local.git("push", "-q", "origin", "main");
    const main = local.git("rev-parse", "HEAD");
    const p = pr(1, { headSha: head, mergeConflict: redundant ? { files: [{ path: "a.ts", oursDeleted: 1, theirsDeleted: 1 }],
      oursLog: "branch", theirsLog: "main", redundantRefix: { compared: "bytes", verdict: "main-byte-identical", comparedPaths: ["a.ts"] } } : undefined });
    const result = await withLiveWritesAllowed(() => regenerateConflictViaGit(local.dir, join(local.dir, "resolution"), p, main));
    assert.equal(result.outcome, "pushed", result.reason);
    assert.equal(origin.git("rev-parse", "run-W1-T1-123"), result.newHeadSha);
    assert.equal(origin.git("rev-parse", `${result.newHeadSha}^1`), head);
    assert.equal(origin.git("rev-parse", `${result.newHeadSha}^2`), main);
    assert.equal(origin.git("show", `${result.newHeadSha}:${redundant ? "a.ts" : "main.txt"}`), "main intent");
    if (!redundant) assert.equal(origin.git("show", `${result.newHeadSha}:branch.txt`), "branch intent");
  }
});

test("W1-T11172 criterion 3: pending verification is re-read next pass and failed acts remain visible", async () => {
  const f = fixture();
  f.ports.act = async () => ({ outcome: "pushed", newHeadSha: "new" });
  f.ports.verify = async () => ({ headSha: "new", mergeableState: "unknown", checksState: "pending" });
  await runConflictGarden(f.ports);
  f.ports.verify = async () => ({ headSha: "new", mergeableState: "clean", checksState: "green" });
  f.ports.snapshot = async () => ({ prs: [], mainSha: "main" });
  await runConflictGarden(f.ports);
  assert.equal(f.rows.findLast(r => r.step === "conflict_garden.verified")?.outcome, "verified");
  const failed = fixture();
  failed.ports.act = async () => { throw new Error("lease read failed"); };
  await runConflictGarden(failed.ports);
  assert.equal(failed.rows.findLast(r => r.step === "conflict_garden.act")?.outcome, "error");
  assert.match(String(failed.rows.findLast(r => r.step === "conflict_garden.act")?.reason), /lease read failed/);
  failed.ports.snapshot = async () => { throw new Error("snapshot unavailable"); };
  await runConflictGarden(failed.ports);
  assert.match(String(failed.rows.findLast(r => r.step === "conflict_garden.report")?.error), /snapshot unavailable/);
});

test("W1-T11172 criterion 4: daemon and registry independently stop the same harmful tier", async () => {
  const f = fixture();
  for (const n of [1, 2]) {
    const receipt = { ts: at(-0.5), tier: "round", act_id: `act-${n}`, new_head_sha: `bad-${n}`, pr_number: n };
    f.rows.push({ ...receipt, step: "conflict_garden.act", mode: "live", outcome: "pushed" },
      { ...receipt, step: "conflict_garden.verified", reverted: true });
  }
  const verdicts = stepConflictGardenGovernor(f.rows, {}, (step, fields = {}) => f.ports.log(step, fields), now);
  assert.equal(verdicts.round.tier, "stopped");
  assert.equal(f.rows.findLast(r => r.step === "conflict_garden.governor" && r.tier === "round")?.paused, true);
  assert.equal(await conflictGardenPass("unused", f.ports).due(), false);
  assert.ok(REGISTERED_GARDEN_NAMES.includes("conflict"));
  assert.equal(gardenSchedule("conflict").intervalFor(60_000), 60_000);
  assert.equal(gardenSchedule("conflict").minIntervalMs, 0);
});

test("W1-T11172 criterion 3: production reads exact-head required checks and a later revert through its GitHub port", async () => {
  await withTempDir("conflict-garden-verify", async dir => {
    const ctx: Parameters<typeof conflictGardenRunTaskPorts>[0] = {
      config: { root: dir, claudeBin: "unused" }, repoRoot: dir, owner: "a", repo: "b", log: () => {}, raiseDuplicate: () => "issue/1",
    };
    let conclusion = "success", reviewConclusion = "success", missing = false, mergeable: boolean | null = true, head = "new";
    const reads: string[] = [];
    const ports = conflictGardenRunTaskPorts(ctx, {}, {
      readRequired: async () => ({ kind: "contexts", contexts: ["unit", "remudero-review"] }),
      readJson: async args => {
        const url = args[1]!;
        reads.push(url);
        if (url.endsWith("/pulls/1")) return { head: { sha: head }, mergeable, mergeable_state: "clean" };
        if (url.includes("check-runs")) return { check_runs: missing ? [] : [
          { name: "unit", status: "completed", conclusion },
          { name: "remudero-review", status: "completed", conclusion: reviewConclusion },
        ] };
        if (url.includes("/compare/")) return { commits: [{ commit: { message: "This reverts commit new." } }] };
        return { statuses: [] };
      },
    });
    assert.equal((await ports.verify(pr(1))).checksState, "green");
    assert.ok(reads.some(url => url.includes("/commits/new/check-runs")));
    missing = true;
    assert.equal((await ports.verify(pr(1))).checksState, "pending");
    missing = false;
    conclusion = "failure";
    assert.equal((await ports.verify(pr(1))).checksState, "red");
    conclusion = "success";
    reviewConclusion = "failure";
    assert.equal((await ports.verify(pr(1))).checksState, "red", "required semantic review is part of verification");
    mergeable = null;
    assert.equal((await ports.verify(pr(1))).mergeableState, "unknown");
    mergeable = true;
    head = "revert";
    assert.equal((await ports.verify(pr(1), { new_head_sha: "new" })).reverted, true);
    const pass = await buildRegisteredGarden("conflict", ctx);
    assert.equal(typeof pass, "function");
    assert.equal(typeof pass.due, "function");
  });
});

test("W1-T11172 criterion 4: the real ledger reader includes compressed, plain and live receipts and refreshes its tail", async () => {
  await withTempDir("conflict-garden-ledger", async dir => {
    const act = { step: "conflict_garden.act", ts: at(-1), tier: "round", mode: "shadow", outcome: "clean" };
    writeFileSync(join(dir, "ledger.2026-11-01T00-00-00-000Z.ndjson.gz"), gzipSync(`${JSON.stringify(act)}\n`));
    writeFileSync(join(dir, "ledger.2026-11-02T00-00-00-000Z.ndjson"), `${JSON.stringify(dirty(1, -3))}\n`);
    writeFileSync(join(dir, "ledger.ndjson"), `${JSON.stringify({ step: "noise" })}\n`);
    const read = conflictGardenLedgerReader(dir);
    const governorRead = conflictGardenLedgerReader(dir, true);
    assert.equal((await read()).length, 2);
    assert.deepEqual(await governorRead(), [act]);
    const verified = { step: "conflict_garden.verified", ts: at(0), tier: "round", outcome: "ci-red" };
    writeFileSync(join(dir, "ledger.ndjson"), `${JSON.stringify(verified)}\n`);
    assert.deepEqual((await governorRead()).map(r => r.step).sort(), ["conflict_garden.act", "conflict_garden.verified"]);
  });
});

test("conflict detection reads installed merge_state episodes, prices ties by dependents and retries after old sweep acts", async () => {
  const f = fixture([...live(),
    { ...dirty(90, -10), disposition: "wait", merge_state: "dirty" },
    { ...dirty(90, -9), disposition: "blocked-fixable", merge_state: "clean" },
    dirty(91, -8), { ...dirty(91, -6), disposition: "wait", merge_state: "behind" },
    dirty(1, -5), dirty(2, -5), { ...dirty(1, -4), acted: true },
  ], [pr(1, { mergeState: "dirty", mergeableState: undefined }), pr(2)]);
  f.ports.dependents = p => p.prNumber === 2 ? 3 : 1;
  await runConflictGarden(f.ports);
  const report = f.rows.findLast(r => r.step === "conflict_garden.report")!;
  assert.equal(report.p90_ms, 2 * hour);
  assert.deepEqual((report.ranked as { pr_number: number }[]).map(r => r.pr_number), [2, 1]);
});

test("change-approach carries the judge's constraint into the next tier and pass", async () => {
  const f = fixture();
  const approaches: (string | undefined)[] = [];
  f.ports.act = async (_pr, _tier, _main, approach) => { approaches.push(approach); return { outcome: "unchanged" }; };
  f.ports.judge = async () => ({ verdict: "change-approach", approach: "retain the deleted export", reason: "a union resurrected it" });
  await runConflictGarden(f.ports);
  assert.deepEqual(approaches, [undefined, undefined, "retain the deleted export"]);
  approaches.length = 0;
  await runConflictGarden(f.ports);
  assert.equal(approaches[1], "retain the deleted export");
});

test("production detection names a live sweep child and distinguishes terminal and unreadable child records", async () => {
  await withTempDir("conflict-garden-child", async dir => {
    const ctx: Parameters<typeof conflictGardenRunTaskPorts>[0] = {
      config: { root: dir, claudeBin: "unused" }, repoRoot: dir, owner: "a", repo: "b", log: () => {}, raiseDuplicate: () => "issue/1",
    };
    const ports = conflictGardenRunTaskPorts(ctx, { controls: () => ({}) });
    const childDir = join(dir, "state", "runs", "live-review");
    mkdirSync(childDir, { recursive: true });
    const identity = childIdentity(process.pid);
    assert.ok(identity);
    const status: RunChildStatus = { schema: RUN_CHILD_SCHEMA, runId: "live-review", identity, engineSha: "engine",
      entryKind: "tsx", phase: "review", heartbeatAt: Date.now(), state: "running" };
    writeStatus(childDir, status);
    const spec = { work: { kind: "review", prNumber: 1, headSha: "head-1" } };
    writeFileSync(join(childDir, "spec.json"), JSON.stringify(spec));
    const rows = [{ step: "run_child.spawned", task_id: "W1-T1", run_id: "live-review" }];
    assert.equal(await ports.skip(pr(1), rows), "in-flight sweep action");
    writeStatus(childDir, { ...status, state: "done" });
    assert.equal(await ports.skip(pr(1), rows), undefined);
    writeStatus(childDir, status);
    writeFileSync(join(childDir, "spec.json"), "invalid");
    assert.equal(await ports.skip(pr(1), rows), "sweep action identity unreadable");
    writeFileSync(join(childDir, "spec.json"), JSON.stringify(spec));
    writeFileSync(join(childDir, "status.json"), "invalid");
    assert.equal(await ports.skip(pr(1), rows), "sweep action liveness unreadable");
  });
});
