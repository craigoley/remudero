import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { fixedClock } from "../src/lib/clock.js";
import { loadPlanFromYaml, type Task } from "../src/lib/plan.js";
import { runDaemon } from "../src/lib/daemon.js";
import { collectOpportunityCandidates, productionOpportunityIntakePorts, runOpportunityIntake, type OpportunityIntakePorts } from "../src/lib/opportunity-intake.js";
import { readStandingRetroDebt } from "../src/lib/retro.js";
import { loadProposalRegistry } from "../src/lib/inbox.js";
import type { FeedbackEntry } from "../src/lib/feedback.js";
import { gateFireRatesPath } from "../src/lib/gate-fire-rate.js";

const clock = fixedClock(Date.parse("2026-10-02T12:00:00Z"));
const debt = `**(j) THE STANDING DEBT LINE — EACH ENTRY WITH ITS AGE IN CYCLES (R51-5's arm).**
**(1)** repair the mapping reader — **AGE: 3 cycles**.
**(2)** struck by R69 (retired).
**(3)** repair the credit reader (P70) — **AGE: 2 cycles**.
**Two entries are open, with a combined dwell of 5 cycles** (**P71**).
`;

function fixture() {
  const filed: string[] = [];
  const inbox: string[] = [];
  const judged: string[] = [];
  const ports: OpportunityIntakePorts = {
    repo: "acme/app", clock,
    standingDebtAnchor: "MASTER-PLAN.md",
    readStandingDebt: () => debt,
    readCodeql: () => ({ ok: true, alerts: [] }),
    readFriction: () => ({ records: [] }),
    readWork: () => ({ proposals: [], tasks: [], mergedKeys: [], prs: [], feedback: [] }),
    riskPolicy: { confidenceThreshold: 0.8, verifyHumanReleaseEnabled: true },
    riskJudge: async (input) => {
      judged.push(input.change.description);
      return { verdict: "low", confidence: 1, reasons: ["bounded reader repair"] };
    },
    fileCandidate: async (candidate) => {
      filed.push(candidate.key);
      return "https://github.com/acme/app/pull/42";
    },
    stageProposal: (candidate) => { inbox.push(candidate.key); },
  };
  return { ports, filed, inbox, judged };
}

test("W1-T4949: a standing debt entry reaches one sourced candidate", async () => {
  const { ports, filed, inbox } = fixture();
  assert.equal(readStandingRetroDebt(debt).dwellCycles, 5);
  const result = await runOpportunityIntake(ports);
  assert.equal(result.status, "promoted");
  assert.deepEqual(filed, ["standing-debt:1"]);
  assert.deepEqual(inbox, []);
  assert.equal(result.candidate?.source, "standing-debt");
  assert.equal(result.candidate?.repo, "acme/app");
  assert.equal(result.candidate?.freshness, "fresh");
  assert.equal(result.candidate?.observedAt, clock.iso());
  assert.equal(result.candidate?.anchor, "MASTER-PLAN.md#standing-debt-1");
  assert.deepEqual(result.candidate?.population, { affected: 1, denominator: 2, unit: "open debt entries" });
  assert.deepEqual(result.candidate?.impact, { value: 3, unit: "cycles of dwell" });
});

test("W1-T4949: existing work and reworded debt dedupe by source key", async () => {
  for (const kind of ["proposal", "task", "pr", "merged", "feedback"] as const) {
    const { ports, filed } = fixture();
    ports.readStandingDebt = () => debt.replace("repair the mapping reader", "mapping evidence reworded in R100");
    const work = ports.readWork();
    if (kind === "proposal") work.proposals.push({ id: "standing-debt:1", summary: "old wording", evidenceAnchors: [] });
    if (kind === "task") work.tasks.push({ id: "W1-T42", repo: "app", origin: "standing-debt:1" } as Task);
    if (kind === "pr") work.prs.push({ body: "Opportunity-Key: acme/app/standing-debt:1" });
    if (kind === "merged") work.mergedKeys.push("acme/app/standing-debt:1");
    if (kind === "feedback") work.feedback.push({ submission_key: "acme/app/standing-debt:1" } as never);
    ports.readWork = () => work;
    const result = await runOpportunityIntake(ports);
    assert.deepEqual(filed, ["standing-debt:3"], kind);
    assert.ok(result.deduped.includes("standing-debt:1"), kind);
  }
});

test("W1-T4949: unreadable standing debt is unavailable not empty", async () => {
  for (const text of ["", debt.replace("Two entries", "Three entries"), debt.replace("5 cycles**", "6 cycles**"), debt.replace("AGE: 3 cycles", "old for a while"), debt.replace("**(3)**", "**(4)**")]) {
    const { ports, filed } = fixture();
    ports.readStandingDebt = () => text;
    const result = await runOpportunityIntake(ports);
    assert.equal(result.status, "unavailable");
    assert.match(result.unavailable.join(" "), /standing-debt/);
    assert.deepEqual(filed, []);
  }
  const { ports } = fixture();
  ports.readStandingDebt = () => { throw new Error("permission denied"); };
  assert.match((await runOpportunityIntake(ports)).unavailable.join(" "), /permission denied/);
});

test("W1-T4949: CodeQL and CI friction reuse their existing source readers", () => {
  const { ports } = fixture();
  ports.readCodeql = () => ({ ok: true, alerts: [{ source: "code-scanning", id: "7", state: "open", severity: "medium", createdAt: clock.iso(), summary: "unused", url: "https://github.com/acme/app/security/code-scanning/7", ruleId: "js/unused-local-variable", toolName: "CodeQL", ruleTags: ["quality", "maintainability"] }] });
  ports.readFriction = () => ({ records: [
    { step: "pr.opened", run_id: "r", ts: "2026-10-02T11:00:00Z", pr_url: "https://github.com/acme/app/pull/8" },
    { step: "fix.dispatch", run_id: "r", ts: "2026-10-02T11:10:00Z", mode: "merge-conflict" },
    { step: "report.followups", run_id: "r", task_id: "W1-T42", ts: clock.iso(), entries: [{ type: "task", text: "repair a separate reader" }] },
  ] });
  const { candidates } = collectOpportunityCandidates(ports);
  const quality = candidates.find((c) => c.source === "codeql-quality");
  const friction = candidates.find((c) => c.source === "ci-friction");
  assert.equal(quality?.key, "codeql-quality:js/unused-local-variable");
  assert.deepEqual(quality?.population, { affected: 1, denominator: 1, unit: "scanned alerts" });
  assert.equal(friction?.impact.unit, "PR minutes lost");
  assert.ok((friction?.impact.value ?? 0) > 9);
  assert.equal(candidates.find((c) => c.source === "followup")?.related.task, "W1-T42");
});

test("W1-T4949: a pass promotes at most one candidate through the existing risk judge", async () => {
  const { ports, filed, inbox, judged } = fixture();
  await runOpportunityIntake(ports);
  assert.equal(judged.length, 1);
  assert.equal(filed.length, 1);
  assert.equal(inbox.length, 0);
  const privileged = fixture();
  privileged.ports.readStandingDebt = () => debt.replace("repair the mapping reader", "change deploy policy");
  const escalation = await runOpportunityIntake(privileged.ports);
  assert.equal(escalation.destination, "inbox");
  assert.deepEqual(privileged.inbox, ["standing-debt:1"]);
  assert.deepEqual(privileged.filed, []);
  const unavailable = fixture();
  unavailable.ports.riskJudge = async () => { throw new Error("judge offline"); };
  assert.equal((await runOpportunityIntake(unavailable.ports)).status, "unavailable");
  assert.deepEqual(unavailable.inbox, []);
  const uncertain = fixture();
  uncertain.ports.riskJudge = async () => ({ verdict: "low", confidence: 0.1, reasons: ["uncertain"] });
  assert.equal((await runOpportunityIntake(uncertain.ports)).status, "held");
  assert.deepEqual(uncertain.inbox, []);
});

test("daemon invokes shared intake on the existing admitted cadence", async () => {
  const { ports, filed } = fixture();
  let ticks = 0;
  let legacyCalls = 0;
  await runDaemon(loadPlanFromYaml("[]", "fixture.yaml"), {
    refreshMerged: () => () => false,
    runOne: async () => { throw new Error("no task to dispatch"); },
    sleep: async () => {},
    checkStop: () => ++ticks > 1 ? "fixture complete" : undefined,
    checkIntakeRungs: () => [{ rung: "codeqlQuality", fire: true, reason: "due" }],
    runIntakeRung: async () => { legacyCalls++; return { rung: "codeqlQuality", status: "ok" }; },
    opportunityIntake: ports,
  });
  assert.deepEqual(filed, ["standing-debt:1"]);
  assert.equal(legacyCalls, 0);
});

test("an intake pass that throws is ledgered as failed and the daemon keeps running", async () => {
  const { ports, filed } = fixture();
  Object.defineProperty(ports, "riskJudge", { get() { throw new Error("judge port unwired"); } });
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let ticks = 0;
  await runDaemon(loadPlanFromYaml("[]", "fixture.yaml"), {
    refreshMerged: () => () => false,
    runOne: async () => { throw new Error("no task to dispatch"); },
    sleep: async () => {},
    checkStop: () => ++ticks > 1 ? "fixture complete" : undefined,
    checkIntakeRungs: () => [{ rung: "codeqlQuality", fire: true, reason: "due" }],
    runIntakeRung: async () => ({ rung: "codeqlQuality", status: "ok" }),
    opportunityIntake: ports,
    log: (step: string, extra?: Record<string, unknown>) => { logged.push({ step, extra }); },
  });
  const failed = logged.find((row) => row.step === "opportunity_intake.failed");
  assert.match(String(failed?.extra?.reason), /judge port unwired/);
  assert.deepEqual(filed, []);
});

test("source failures, complete dedupe and landing failures stay distinguishable", async () => {
  const { ports } = fixture();
  ports.readCodeql = () => ({ ok: false, error: "CodeQL denied" });
  ports.readFriction = () => { throw new Error("ledger denied"); };
  const collected = collectOpportunityCandidates(ports);
  assert.equal(collected.candidates.length, 2);
  assert.match(collected.unavailable.join(" "), /CodeQL denied/);
  assert.match(collected.unavailable.join(" "), /ledger denied/);
  const work = ports.readWork();
  work.mergedKeys = ["acme/app/standing-debt:1", "acme/app/standing-debt:3"];
  ports.readWork = () => work;
  assert.equal((await runOpportunityIntake(ports)).status, "unavailable");
  const healthy = fixture();
  healthy.ports.readWork = () => work;
  assert.equal((await runOpportunityIntake(healthy.ports)).status, "empty");
  const brokenDedupe = fixture();
  brokenDedupe.ports.readWork = () => { throw new Error("work census offline"); };
  assert.match((await runOpportunityIntake(brokenDedupe.ports)).unavailable.join(" "), /work census offline/);
  const failedLanding = fixture();
  failedLanding.ports.fileCandidate = async () => undefined;
  assert.equal((await runOpportunityIntake(failedLanding.ports)).status, "held");
  const raced = fixture();
  const before = raced.ports.readWork();
  raced.ports.readWork = () => before;
  raced.ports.riskJudge = async () => {
    before.mergedKeys.push("acme/app/standing-debt:1");
    return { verdict: "low", confidence: 1, reasons: [] };
  };
  assert.equal((await runOpportunityIntake(raced.ports)).status, "empty");
  assert.deepEqual(raced.filed, []);
  const unanchored = fixture();
  unanchored.ports.readFriction = () => ({ records: [{ step: "report.followups", entries: [{ type: "task", text: "repair an unanchored reader" }] }] });
  const unanchoredResult = collectOpportunityCandidates(unanchored.ports);
  assert.equal(unanchoredResult.candidates.some((entry) => entry.source === "followup"), false);
  assert.match(unanchoredResult.unavailable.join(" "), /incomplete provenance/);
  const recheck = fixture();
  let reads = 0;
  const initialWork = recheck.ports.readWork();
  recheck.ports.readWork = () => {
    if (++reads > 1) throw new Error("dedupe recheck offline");
    return initialWork;
  };
  assert.match((await runOpportunityIntake(recheck.ports)).unavailable.join(" "), /dedupe recheck offline/);
});

test("source keys match whole identities and stay scoped to their repository", async () => {
  const { ports, filed } = fixture();
  const work = ports.readWork();
  work.proposals.push({ id: "other", summary: "Opportunity-Key: acme/app/standing-debt:10", evidenceAnchors: [] });
  work.feedback.push({ raw: "Opportunity-Key: acme/app/standing-debt:10" } as FeedbackEntry);
  work.tasks.push({ id: "W1-T42", repo: "other", origin: "standing-debt:1" } as Task);
  ports.readWork = () => work;
  await runOpportunityIntake(ports);
  assert.deepEqual(filed, ["standing-debt:1"]);
});

test("the parser reads the shipped standing corpus and refuses duplicated headers", () => {
  const actual = readStandingRetroDebt(readFileSync(new URL("../MASTER-PLAN.md", import.meta.url), "utf8"));
  assert.ok(actual.openCount > 0);
  assert.equal(actual.openCount, actual.entries.length);
  assert.equal(actual.dwellCycles, actual.entries.reduce((sum, entry) => sum + entry.ageCycles, 0));
  assert.throws(() => readStandingRetroDebt(debt + debt), /ambiguous/);
  assert.throws(() => readStandingRetroDebt(debt.replace("**(1)**", "")), /identity/);
  assert.throws(() => readStandingRetroDebt(debt.replace("**(1)**", "(1)").replace("**(2)**", "(2)").replace("**(3)**", "(3)")), /corpus missing/);
});

function productionFixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-opportunity-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  mkdirSync(join(root, "plan"));
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "config"), '[remote "origin"]\nurl = https://github.com/acme/app.git\n');
  writeFileSync(join(root, "MASTER-PLAN.md"), debt);
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(root, "plan", "policy.yaml"), "{}\n");
  let disposed = 0;
  const landings: { paths: string[]; title: string; body: string }[] = [];
  const garden = {
    repoRoot: root, stateDir, clock, log: () => {},
    openWorkspace: () => ({ root, dispose: () => { disposed++; }, land: (opts: typeof landings[number]) => { landings.push(opts); return "https://github.com/acme/app/pull/42"; } }),
  };
  const deps = {
    readPulls: () => [[]],
    readCodeql: fixture().ports.readCodeql,
    readFriction: fixture().ports.readFriction,
    riskJudge: fixture().ports.riskJudge,
  };
  return { root, stateDir, garden, deps, landings, disposed: () => disposed, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("production routing shells out for identity and lands durable feedback through the existing plan PR port", async () => {
  const f = productionFixture();
  try {
    const result = await runOpportunityIntake(productionOpportunityIntakePorts(f.garden, f.deps));
    assert.equal(result.status, "promoted");
    assert.equal(f.disposed(), 1);
    assert.equal(f.landings.length, 1);
    assert.match(f.landings[0]!.body, /Opportunity-Key: acme\/app\/standing-debt:1/);
    const entry = parse(readFileSync(join(f.root, f.landings[0]!.paths[0]!), "utf8"));
    assert.equal(entry.submission_key, "acme/app/standing-debt:1");
    assert.equal(entry.status, "new");
    assert.match(entry.raw, /Preserve origin: standing-debt:1/);
    assert.deepEqual(parse(readFileSync(join(f.stateDir, "last-intake-cadence-codeqlQuality.json"), "utf8")).fires, [clock.iso()]);
    await runOpportunityIntake(productionOpportunityIntakePorts(f.garden, f.deps));
    assert.equal(f.landings.length, 2);
    const second = parse(readFileSync(join(f.root, f.landings[1]!.paths[0]!), "utf8"));
    assert.equal(second.submission_key, "acme/app/standing-debt:3");
  } finally { f.cleanup(); }
});

test("an open plan proposal naming a debt source dedupes that candidate in production", async () => {
  const f = productionFixture();
  try {
    mkdirSync(join(f.root, "plan", "proposals.d"));
    writeFileSync(join(f.root, "plan", "proposals.d", "P1.yaml"), "id: P1\ntitle: repair the mapping reader\nstatus: open\nfalsifier: \"unit test: the mapping reader repairs\"\nsource: standing-debt:1\n");
    const result = await runOpportunityIntake(productionOpportunityIntakePorts(f.garden, f.deps));
    assert.ok(result.deduped.includes("standing-debt:1"), JSON.stringify(result.deduped));
    assert.equal(result.candidate?.key, "standing-debt:3");
  } finally { f.cleanup(); }
});

test("a debt family's merged history lowers the bar its next candidate must clear", async () => {
  const history = (merged: number) => {
    const { ports, filed } = fixture();
    ports.riskJudge = async () => ({ verdict: "low", confidence: 0.7, reasons: ["bounded reader repair"] });
    const work = ports.readWork();
    for (let i = 0; i < 4; i++) {
      work.tasks.push({ id: `W1-T90${i}`, repo: "app", author_class: "machine", origin: `standing-debt:9${i}` } as Task);
      if (i < merged) work.mergedKeys.push(`acme/app/standing-debt:9${i}`);
    }
    ports.readWork = () => work;
    return { ports, filed };
  };
  const unproven = history(0);
  assert.equal((await runOpportunityIntake(unproven.ports)).status, "held", "an unproven family needs more than 0.7");
  const proven = history(4);
  assert.equal((await runOpportunityIntake(proven.ports)).status, "promoted", "four merged siblings earn the lower bar");
  assert.deepEqual(proven.filed, ["standing-debt:1"]);
});

test("standing debt promotion anchors the source selected by the repository layout", async () => {
  const f = productionFixture();
  try {
    mkdirSync(join(f.root, ".remudero"));
    mkdirSync(join(f.root, "docs"));
    writeFileSync(join(f.root, ".remudero", "layout.json"), JSON.stringify({ masterPlan: "docs/roadmap.md" }));
    writeFileSync(join(f.root, "docs", "roadmap.md"), debt);
    rmSync(join(f.root, "MASTER-PLAN.md"));
    const result = await runOpportunityIntake(productionOpportunityIntakePorts(f.garden, f.deps));
    assert.equal(result.status, "promoted");
    assert.equal(result.candidate?.anchor, "docs/roadmap.md#standing-debt-1");
    assert.equal(f.landings.length, 1);
    const entry = parse(readFileSync(join(f.root, f.landings[0]!.paths[0]!), "utf8"));
    assert.match(entry.raw, /docs\/roadmap\.md#standing-debt-1/);
    assert.equal(f.disposed(), 1);
  } finally { f.cleanup(); }
});

test("production source and constructor failures refuse and release the checkout", async () => {
  const f = productionFixture();
  try {
    writeFileSync(join(f.root, "MASTER-PLAN.md"), debt.replace("repair the mapping reader", "change deploy policy"));
    const result = await runOpportunityIntake(productionOpportunityIntakePorts(f.garden, f.deps));
    assert.equal(result.destination, "inbox");
    assert.equal(f.landings.length, 0);
    assert.equal(loadProposalRegistry(join(f.stateDir, "inbox-proposals.json"))[0]?.id, "acme/app/standing-debt:1");
    const invalidPrs = productionOpportunityIntakePorts(f.garden, { ...f.deps, readPulls: () => ({}) });
    assert.equal((await runOpportunityIntake(invalidPrs)).status, "unavailable");
    writeFileSync(gateFireRatesPath(f.stateDir), "invalid json");
    const { readFriction: _fake, ...defaultFriction } = f.deps;
    const brokenReport = productionOpportunityIntakePorts(f.garden, defaultFriction);
    assert.match(collectOpportunityCandidates(brokenReport).unavailable.join(" "), /gate fire-rate report unreadable/);
    brokenReport.dispose?.();
    rmSync(gateFireRatesPath(f.stateDir));
    const brokenLedger = productionOpportunityIntakePorts(f.garden, defaultFriction);
    assert.match(collectOpportunityCandidates(brokenLedger).unavailable.join(" "), /ci-friction ledger union unreadable/);
    brokenLedger.dispose?.();
    writeFileSync(join(f.root, "MASTER-PLAN.md"), debt);
    const { riskJudge: _judge, ...defaultJudge } = f.deps;
    const missingMount = await runOpportunityIntake(productionOpportunityIntakePorts(f.garden, defaultJudge));
    assert.equal(missingMount.status, "unavailable");
    assert.match(missingMount.unavailable.join(" "), /risk judge threw/);
    writeFileSync(join(f.root, ".git", "config"), '[remote "origin"]\nurl = https://example.com/acme/app\n');
    const before = f.disposed();
    assert.throws(() => productionOpportunityIntakePorts(f.garden, f.deps), /GitHub repository identity/);
    assert.equal(f.disposed(), before + 1);
  } finally { f.cleanup(); }
});
