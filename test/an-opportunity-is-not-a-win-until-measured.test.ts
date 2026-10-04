import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedClock } from "../src/lib/clock.js";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { loadProposalRegistry } from "../src/lib/inbox.js";
import { reconcileCodeqlQualityProposals } from "../src/lib/codeql-quality-intake.js";
import { reconcileOpportunityOutcomes, productionOpportunityOutcomePorts, type OpportunityOutcomePorts, type OpportunityEvidence, type OpportunitySource } from "../src/lib/opportunity-outcomes.js";
import type { RawAlert } from "../src/lib/ops.js";
import type { GardenerDeps } from "../src/lib/gardener.js";
import type { OpportunityIntakePorts, OpportunityWork } from "../src/lib/opportunity-intake.js";
import { runGardenerOverseer } from "../src/lib/gardener-overseer.js";
import { ghStubPath, pathWith } from "./helpers/gh-stub.js";

const repo = "acme/app";
const clock = fixedClock(Date.parse("2026-10-04T12:00:00Z"));
const source: OpportunitySource = {
  candidate: { source: "standing-debt", repo, key: "standing-debt:1", observedAt: "2026-10-01T00:00:00Z", anchor: "MASTER-PLAN.md#1", availability: "available", freshness: "fresh", population: { affected: 1, denominator: 2, unit: "entries" }, impact: { value: 8, unit: "minutes" }, remedy: "repair reader", authority: "machine", related: {} },
  proposalId: "acme/app/standing-debt:1", sourceIds: ["MASTER-PLAN.md#1"],
};
function evidence(after = 4): OpportunityEvidence {
  return {
    task: { id: "W1-T42", repo, key: source.candidate.key, filedAt: "2026-10-01T01:00:00Z" },
    pr: { taskId: "W1-T42", repo, url: `https://github.com/${repo}/pull/42`, headSha: "head", mergeSha: "merge", mergedAt: "2026-10-02T00:00:00Z" },
    deployment: { repo, revision: "merge", at: "2026-10-03T00:00:00Z", receipt: "deployment:7" },
    measurement: { repo, key: source.candidate.key, revision: "merge", targetedCost: {
      before: { value: 8, denominator: 2, populationUnit: "runs", unit: "minutes", start: "2026-10-02T00:00:00Z", end: "2026-10-03T00:00:00Z" },
      after: { value: after, denominator: 2, populationUnit: "runs", unit: "minutes", start: "2026-10-03T00:00:00Z", end: "2026-10-04T00:00:00Z" },
    } },
  };
}
function ports(reading = evidence()): OpportunityOutcomePorts {
  return { clock, readSources: () => [structuredClone(source)], readEvidence: () => reading, save: () => {} };
}

test("W1-T4950: merge without deployment is not a measured win", () => {
  const reading = evidence();
  delete reading.deployment;
  const outcome = reconcileOpportunityOutcomes(ports(reading))[0]!;
  assert.equal(outcome.state, "merged");
  assert.equal(outcome.measurement, undefined);
  assert.equal(outcome.pr?.headSha, "head");
  assert.match(outcome.reason, /deployment/);
});

test("W1-T4950: same-repo before and after evidence decides help or harm", () => {
  for (const [after, expected] of [[4, "measured-helped"], [12, "measured-hurt"], [8, "deployed"]] as const) {
    const reading = evidence(after);
    const result = reconcileOpportunityOutcomes(ports(reading))[0]!;
    assert.equal(result.state, expected);
    assert.equal(result.key, `${repo}/${source.candidate.key}`);
    assert.deepEqual(result.sourceIds, source.sourceIds);
    assert.equal(result.proposalId, source.proposalId);
    assert.equal(result.leadTimeMs, 2 * 86400000 - 3600000);
    assert.equal(result.failureRework, null);
    assert.deepEqual(reading, evidence(after), "reconciliation cannot rewrite evidence");
  }
  for (const mutate of [
    (r: OpportunityEvidence) => { r.measurement!.repo = "other/app"; },
    (r: OpportunityEvidence) => { r.deployment!.revision = "unrelated"; },
    (r: OpportunityEvidence) => { r.measurement!.targetedCost.after.unit = "seconds"; },
    (r: OpportunityEvidence) => { r.measurement!.targetedCost.after.populationUnit = "alerts"; },
    (r: OpportunityEvidence) => { r.measurement!.targetedCost.after.end = "2026-10-03T12:00:00Z"; },
    (r: OpportunityEvidence) => { r.measurement!.targetedCost.before.end = "2026-10-03T01:00:00Z"; },
    (r: OpportunityEvidence) => { r.measurement!.revision = "unrelated"; },
    (r: OpportunityEvidence) => { r.pr!.taskId = "W1-T43"; },
  ]) {
    const reading = evidence(); mutate(reading);
    assert.equal(reconcileOpportunityOutcomes(ports(reading))[0]!.state, "unavailable");
  }
});

function alert(id: string): RawAlert {
  return { source: "code-scanning", id, severity: "low", state: "open", createdAt: clock.iso(), summary: "unused", url: `https://github.com/${repo}/security/code-scanning/${id}`, ruleId: "js/unused-local-variable", toolName: "CodeQL", ruleTags: ["quality", "maintainability"] };
}
test("W1-T4950: post-ratification CodeQL alerts become a delta candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-opportunity-"));
  const path = join(root, "proposals.json");
  try {
    reconcileCodeqlQualityProposals(path, [alert("17")], [], { scannerSha: "scan-at-filing" });
    const filed = loadProposalRegistry(path)[0]!;
    const snapshot = { proposalId: filed.id, ruleId: "js/unused-local-variable", alertNumbers: ["17"], scannerSha: "scan-at-filing" };
    const result = reconcileCodeqlQualityProposals(path, [alert("17"), alert("23")], [], { ratified: [snapshot], scannerSha: "new-scan" });
    assert.deepEqual(loadProposalRegistry(path).find((p) => p.id === filed.id), filed);
    assert.deepEqual(result.deltas[0]?.alertNumbers, ["23"]);
    assert.equal(result.deltas[0]?.sourceProposalId, filed.id);
    assert.equal(result.deltas[0]?.scannerSha, "new-scan");
    assert.deepEqual(result.updatedProposalIds, []);
    const id = result.deltas[0]!.proposalId;
    reconcileCodeqlQualityProposals(path, [alert("23"), alert("17")], [], { ratified: [snapshot], scannerSha: "new-scan" });
    assert.equal(loadProposalRegistry(path).filter((p) => p.id === id).length, 1);
    reconcileCodeqlQualityProposals(path, [], [], { ratified: [snapshot] });
    assert.deepEqual(loadProposalRegistry(path).find((p) => p.id === filed.id), filed);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T4950: missing outcome evidence is unavailable not zero", () => {
  for (const mutate of [
    (s: OpportunitySource, r: OpportunityEvidence) => { s.sourceIds = []; },
    (s: OpportunitySource, r: OpportunityEvidence) => { s.candidate.population.denominator = 0; },
    (s: OpportunitySource, r: OpportunityEvidence) => { r.measurement!.targetedCost.after.denominator = 0; },
    (s: OpportunitySource, r: OpportunityEvidence) => { delete r.measurement; },
    (s: OpportunitySource, r: OpportunityEvidence) => { r.measurement!.targetedCost.after.value = NaN; },
  ]) {
    const s = structuredClone(source), r = evidence(); mutate(s, r);
    const p = ports(r); p.readSources = () => [s];
    const result = reconcileOpportunityOutcomes(p)[0]!;
    assert.equal(result.state, "unavailable");
    assert.equal(result.measurement, undefined);
    assert.ok(result.reason.length > 0);
  }
});

test("CodeQL outcomes require filing scanner and alerts while retaining only a matching task", () => {
  const snapshot = { proposalId: source.proposalId, ruleId: "js/unused-local-variable", scannerSha: "filing-scan", alertNumbers: ["17"] };
  const complete = ports(); complete.readSources = () => [{ ...structuredClone(source), codeql: snapshot }];
  assert.equal(reconcileOpportunityOutcomes(complete)[0]!.state, "measured-helped");
  for (const codeql of [{ ...snapshot, scannerSha: undefined }, { ...snapshot, alertNumbers: [] }]) {
    for (const task of [evidence().task, undefined,
      { ...evidence().task!, repo: "other/app" }, { ...evidence().task!, key: "unrelated" }]) {
      const p = ports({ ...evidence(), task });
      p.readSources = () => [{ ...structuredClone(source), codeql }];
      const result = reconcileOpportunityOutcomes(p)[0]!;
      assert.equal(result.state, "unavailable");
      assert.equal(result.reason, "CodeQL filing scanner SHA or alert numbers unavailable");
      assert.deepEqual(result.task, task?.repo === repo && task.key === source.candidate.key ? task : undefined);
      assert.equal(result.pr, undefined);
      assert.equal(result.deployment, undefined);
      assert.equal(result.measurement, undefined);
      assert.equal(result.leadTimeMs, null);
      assert.equal(result.failureRework, null);
    }
  }
});

test("outcome reconciliation distinguishes pending filed deployed and expired", () => {
  assert.equal(reconcileOpportunityOutcomes(ports({}))[0]!.state, "pending");
  assert.equal(reconcileOpportunityOutcomes(ports({ task: evidence().task }))[0]!.state, "filed");
  const p = ports({});
  p.readSources = () => [{ ...source, expiresAt: "2026-10-02T00:00:00Z" }];
  assert.equal(reconcileOpportunityOutcomes(p)[0]!.state, "expired");
  const r = evidence(); r.measurement!.verdict = "debit";
  assert.equal(reconcileOpportunityOutcomes(ports(r))[0]!.state, "measured-hurt");
});

test("deployment receipts do not expire as the injected clock advances", () => {
  const p = ports();
  p.clock = fixedClock(clock.now() + 365 * 86400000);
  assert.equal(reconcileOpportunityOutcomes(p)[0]!.state, "measured-helped");
  p.clock = fixedClock(Date.parse(evidence().deployment!.at) - 1);
  const future = reconcileOpportunityOutcomes(p)[0]!;
  assert.equal(future.state, "unavailable");
  assert.match(future.reason, /deployment/);
});

test("production rejects malformed persisted source identities", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-opportunity-malformed-"));
  const work: OpportunityWork = { proposals: [], tasks: [], prs: [], mergedKeys: [], feedback: [] };
  const intake = { repo, readWork: () => work } as OpportunityIntakePorts;
  try {
    for (const row of [null, {}, { candidate: null }, { candidate: {} },
      { candidate: { repo, key: "" }, sourceIds: [] },
      { candidate: { repo: "", key: source.candidate.key }, sourceIds: [] },
      { candidate: { repo: 1, key: source.candidate.key }, sourceIds: [] },
      { candidate: { repo, key: 1 }, sourceIds: [] },
      { candidate: source.candidate, sourceIds: null }]) {
      writeFileSync(join(root, "opportunity-outcomes.json"), JSON.stringify([row]));
      assert.throws(() => reconcileOpportunityOutcomes(productionOpportunityOutcomePorts(
        { stateDir: root, clock } as GardenerDeps, { intake, readRows: () => [] },
      )), /malformed outcomes/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production distinguishes absent and invalidated merge credit from a valid alternate source", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-opportunity-credit-"));
  const work: OpportunityWork = { proposals: [{ id: source.proposalId, summary: JSON.stringify(source.candidate), evidenceAnchors: [] }],
    tasks: [{ id: "W1-T42", repo: "app", origin: source.candidate.key } as never], prs: [], mergedKeys: [], feedback: [] };
  const intake = { repo, readWork: () => work } as OpportunityIntakePorts;
  const reading = evidence();
  const trailer = { source: "trailer", prUrl: reading.pr!.url, prNumber: 42, prState: "MERGED" };
  const invalidated = { trailer: { prUrl: trailer.prUrl, prNumber: 42, reason: "durable-credit-plan-only" } };
  let fetched = 0;
  const fetch = (args: string[]): unknown => {
    fetched++;
    if (args[1]!.includes("/deployments?")) return [[]];
    assert.match(args[1]!, /\/pulls\/43$/);
    return { merged: true, html_url: `https://github.com/${repo}/pull/43`, merged_at: reading.pr!.mergedAt,
      merge_commit_sha: "merge", head: { sha: "head" }, base: { repo: { full_name: repo } } };
  };
  const reconcile = () => reconcileOpportunityOutcomes(productionOpportunityOutcomePorts(
    { stateDir: root, clock } as GardenerDeps, { intake, fetch, readRows: () => [] },
  ))[0]!;
  try {
    assert.equal(reconcile().state, "filed");
    for (const credit of [{}, { trailer: { ...trailer, prState: "OPEN" } }, { trailer, invalidated }]) {
      writeFileSync(join(root, "merge-credit.json"), JSON.stringify({ "W1-T42": credit }));
      const result = reconcile();
      assert.equal(result.state, "filed");
      assert.equal(result.pr, undefined);
    }
    assert.equal(fetched, 0, "missing or quarantined credit cannot trigger a PR fetch");
    writeFileSync(join(root, "merge-credit.json"), JSON.stringify({ "W1-T42": { trailer, invalidated,
      "head-branch": { source: "head-branch", prUrl: `https://github.com/${repo}/pull/43`, prNumber: 43, prState: "MERGED" },
    } }));
    const result = reconcile();
    assert.equal(result.state, "merged");
    assert.equal(result.pr?.url, `https://github.com/${repo}/pull/43`);
    assert.equal(fetched, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the daemon reconciles settled outcomes on its existing intake cadence", async () => {
  let ticks = 0, saved = 0;
  const p = ports(); p.save = (outcomes) => { saved++; assert.equal(outcomes[0]!.state, "measured-helped"); };
  await runDaemon(loadPlanFromYaml("[]", "fixture.yaml"), {
    refreshMerged: () => () => false, runOne: async () => { throw new Error("no tasks"); }, sleep: async () => {},
    checkStop: () => ++ticks > 1 ? "done" : undefined,
    checkIntakeRungs: () => [{ rung: "codeqlQuality", fire: true, reason: "due" }],
    opportunityOutcomes: p,
  });
  assert.equal(saved, 1);
});

test("production reconciles persisted source task credit deployment and overseer evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-opportunity-production-"));
  const work: OpportunityWork = { proposals: [{ id: source.proposalId, summary: JSON.stringify(source.candidate), evidenceAnchors: [] }], tasks: [{ id: "W1-T42", repo: "app", origin: source.candidate.key } as never], prs: [], mergedKeys: [], feedback: [] };
  let disposed = 0;
  const intake = { repo, readWork: () => work, dispose: () => { disposed++; } } as OpportunityIntakePorts;
  const garden = { stateDir: root, clock } as GardenerDeps;
  const reading = evidence();
  const fetch = (args: string[]): unknown => {
    if (args[1]!.includes("/statuses")) return [{ state: "success", created_at: reading.deployment!.at }];
    if (args[1]!.includes("/deployments?")) return [[{ id: 7, sha: "merge" }]];
    return { merged: true, html_url: reading.pr!.url, merged_at: reading.pr!.mergedAt, merge_commit_sha: "merge", head: { sha: "head" }, base: { repo: { full_name: repo } } };
  };
  const rows = [{ step: "ratify.approved", task_id: source.proposalId, ts: reading.task!.filedAt }, { step: "gardener_overseer.effect_verdict", pr_url: reading.pr!.url, verdict: "credit", opportunity_measurement: reading.measurement }];
  try {
    writeFileSync(join(root, "merge-credit.json"), JSON.stringify({ "W1-T42": { trailer: { source: "trailer", prUrl: reading.pr!.url, prNumber: 42, prState: "MERGED" } } }));
    const result = reconcileOpportunityOutcomes(productionOpportunityOutcomePorts(garden, { intake, fetch, readRows: () => rows }));
    assert.equal(result[0]!.state, "measured-helped");
    assert.equal(result[0]!.deployment?.receipt, `https://github.com/${repo}/deployments/7`);
    assert.equal(disposed, 1);
    const persisted = JSON.parse(readFileSync(join(root, "opportunity-outcomes.json"), "utf8"));
    assert.deepEqual(persisted, result);
    work.proposals = [];
    assert.equal(reconcileOpportunityOutcomes(productionOpportunityOutcomePorts(garden, { intake, fetch, readRows: () => rows }))[0]!.state, "measured-helped", "a retired registry entry cannot lose the source join");
    const failed = reconcileOpportunityOutcomes(productionOpportunityOutcomePorts(garden, { intake, fetch: () => { throw new Error("GitHub unavailable"); }, readRows: () => rows }));
    assert.equal(failed[0]!.state, "unavailable");
    assert.match(failed[0]!.reason, /GitHub unavailable/);
    writeFileSync(join(root, "opportunity-outcomes.json"), "corrupt");
    assert.throws(() => reconcileOpportunityOutcomes(productionOpportunityOutcomePorts(garden, { intake, fetch, readRows: () => rows })), /JSON/);
    assert.equal(disposed, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("overseer carries scoped measurement alongside its original verdict", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-opportunity-overseer-"));
  const url = evidence().pr!.url;
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  try {
    runGardenerOverseer({ stateDir: root, clock, readRows: () => [{ step: "test.scorecard", ts: "2026-10-01T00:00:00Z", pr_url: url, acting: ["repair"] }],
      prInfo: () => ({ state: "merged", title: "repair", paths: ["src/reader.ts"], mergedAt: evidence().pr!.mergedAt }),
      effectReading: () => ({ before: 8, after: 4, se: 0, verdict: "credit", opportunityMeasurement: evidence().measurement }),
      log: (step, extra) => logged.push({ step, extra }),
    });
    const verdict = logged.find((r) => r.step === "gardener_overseer.effect_verdict");
    assert.equal(verdict?.extra?.verdict, "credit");
    assert.deepEqual(verdict?.extra?.opportunity_measurement, evidence().measurement);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("daemon records an unavailable outcome read and continues", async () => {
  let ticks = 0;
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const p = ports(); p.readSources = () => { throw new Error("source unreadable"); };
  await runDaemon(loadPlanFromYaml("[]", "fixture.yaml"), {
    refreshMerged: () => () => false, runOne: async () => { throw new Error("no tasks"); }, sleep: async () => {},
    checkStop: () => ++ticks > 1 ? "done" : undefined,
    checkIntakeRungs: () => [{ rung: "codeqlQuality", fire: true, reason: "due" }], opportunityOutcomes: p,
    log: (step, extra) => logged.push({ step, extra }),
  });
  assert.match(String(logged.find((r) => r.step === "opportunity_outcomes.failed")?.extra?.reason), /source unreadable/);
});

test("production pins the scanner before filing and ordinary intake respects the receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-opportunity-codeql-"));
  const registry = join(root, "inbox-proposals.json");
  const garden = { stateDir: root, clock } as GardenerDeps;
  let alerts = [alert("17")], sha = "filing-scan";
  const work: OpportunityWork = { proposals: [], tasks: [], prs: [], mergedKeys: [], feedback: [] };
  const intake = { repo, readWork: () => { work.proposals = loadProposalRegistry(registry); return work; }, readCodeql: () => ({ ok: true, alerts }) } as OpportunityIntakePorts;
  const fetch = () => [{ tool: { name: "CodeQL" }, ref: "refs/heads/main", commit_sha: sha }];
  try {
    reconcileCodeqlQualityProposals(registry, alerts, []);
    const first = reconcileOpportunityOutcomes(productionOpportunityOutcomePorts(garden, { intake, fetch, readRows: () => [] }));
    assert.equal(first[0]!.codeql?.scannerSha, "filing-scan");
    assert.equal(first[0]!.state, "pending");
    const accepted = loadProposalRegistry(registry)[0]!;
    work.tasks.push({ id: "W1-T42", repo: "app", origin: accepted.id } as never);
    alerts = [alert("17"), alert("23")]; sha = "next-scan";
    const result = reconcileOpportunityOutcomes(productionOpportunityOutcomePorts(garden, { intake, fetch, readRows: () => [] }));
    assert.equal(result[0]!.state, "filed");
    assert.equal(result[0]!.codeql?.scannerSha, "filing-scan");
    assert.deepEqual(result[0]!.codeql?.alertNumbers, ["17"]);
    assert.equal(result[1]!.state, "pending");
    assert.equal(result[1]!.codeql?.scannerSha, "next-scan");
    reconcileCodeqlQualityProposals(registry, [alert("17"), alert("23"), alert("31")], []);
    assert.deepEqual(loadProposalRegistry(registry).find((p) => p.id === accepted.id), accepted, "the normal three-argument caller cannot rewrite ratified evidence");
    assert.equal(loadProposalRegistry(registry).length, 3);
    work.tasks.push({ id: "W1-T43", repo: "app", origin: result[1]!.candidate.key } as never);
    alerts = [alert("17"), alert("23"), alert("31"), alert("47")];
    reconcileOpportunityOutcomes(productionOpportunityOutcomePorts(garden, { intake, fetch, readRows: () => [] }));
    assert.equal(loadProposalRegistry(registry).length, 4, "ratifying a delta cannot repackage its parent's alerts or duplicate the next delta");
    writeFileSync(join(root, "opportunity-outcomes.json"), "{}");
    assert.throws(() => reconcileCodeqlQualityProposals(registry, [], []), /malformed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the default outcome adapter reads a real checkout and ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-opportunity-default-"));
  const stateDir = join(root, "state");
  const oldPath = process.env.PATH;
  let disposed = 0;
  try {
    mkdirSync(stateDir);
    mkdirSync(join(root, "plan"));
    mkdirSync(join(root, ".git", "objects"), { recursive: true });
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "config"), '[remote "origin"]\nurl = https://github.com/acme/app.git\n');
    writeFileSync(join(root, "plan", "tasks.yaml"), "- id: W1-T42\n  title: repair reader\n  repo: app\n  origin: standing-debt:1\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n");
    writeFileSync(join(root, "plan", "policy.yaml"), "{}\n");
    writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ version: 1, proposals: [{ id: source.proposalId, summary: JSON.stringify(source.candidate), evidenceAnchors: [] }] }));
    const reading = evidence();
    writeFileSync(join(stateDir, "merge-credit.json"), JSON.stringify({ "W1-T42": { trailer: { source: "trailer", prUrl: reading.pr!.url, prNumber: 42, prState: "MERGED" } } }));
    writeFileSync(join(stateDir, "ledger.ndjson"), [
      { step: "ratify.approved", task_id: source.proposalId, ts: reading.task!.filedAt },
      { step: "gardener_overseer.effect_verdict", ts: clock.iso(), pr_url: reading.pr!.url, verdict: "credit", opportunity_measurement: reading.measurement },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    process.env.PATH = pathWith(ghStubPath([
      "#!/bin/sh", 'case "$2" in',
      "*/pulls\\?*) printf '%s\\n' '[[]]' ;;",
      `*/pulls/42) printf '%s\\n' '${JSON.stringify({ merged: true, html_url: reading.pr!.url, merged_at: reading.pr!.mergedAt, merge_commit_sha: "merge", head: { sha: "head" }, base: { repo: { full_name: repo } } })}' ;;`,
      "*/deployments\\?*) printf '%s\\n' '[[{\"id\":7,\"sha\":\"merge\"}]]' ;;",
      `*/statuses*) printf '%s\\n' '${JSON.stringify([{ state: "success", created_at: reading.deployment!.at }])}' ;;`,
      "*) exit 1 ;;", "esac",
    ].join("\n")));
    const garden = { repoRoot: root, stateDir, clock, log: () => {}, openWorkspace: () => ({ root, dispose: () => { disposed++; }, land: () => { throw new Error("reconciliation cannot file work"); } }) };
    const result = reconcileOpportunityOutcomes(productionOpportunityOutcomePorts(garden));
    assert.equal(result[0]!.state, "measured-helped");
    assert.deepEqual(result[0]!.sourceIds, source.sourceIds);
    assert.equal(disposed, 1);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
