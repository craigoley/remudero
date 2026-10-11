import assert from "node:assert/strict";
import test from "node:test";
import * as flow from "../src/lib/flow-gardener.js";
import * as remedy from "../src/lib/flow-remedy-gardener.js";
import { feedbackContentDigest, type AdmissionSettings } from "../src/lib/contributor-admission.js";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedClock } from "../src/lib/clock.js";
import type { GardenerDeps } from "../src/lib/gardener.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { ghShim } from "./helpers/gh-shim.js";
import { writeLedger } from "./helpers/ledger-fixture.js";
import { gitRepo } from "./helpers/git-repo.js";
import { flowGardenPass } from "../src/lib/garden-registry.js";
import { buildRegisteredGarden } from "../src/run-task.js";
import type { Config } from "../src/lib/config-schema.js";

const now = Date.parse("2026-10-11T12:00:00Z");
const settings: AdmissionSettings = { mode: "shadow", disposition: "shadow", repositoryId: 111,
  organizations: [], policy: { version: "test-v1", ownerIds: [7], organizationIds: [], services: [], maxEvidenceAgeMs: 5_000 } };
const input = { owner: "operator", repo: "core", settings };
const repository = { databaseId: 111, nameWithOwner: "operator/core", isPrivate: false };
const pull = (number: number, actor: number) => ({ number, fullDatabaseId: String(1000 + number), state: "OPEN",
  createdAt: new Date(now - 7_200_000).toISOString(),
  headRefOid: "a".repeat(40), author: { __typename: "User", databaseId: actor },
  repository, headRepository: { databaseId: 222, nameWithOwner: "actor/fork", isPrivate: false } });
const corpus = () => ({ data: { repository: { ...repository, pullRequests: { totalCount: 2,
  pageInfo: { hasNextPage: false }, nodes: [pull(1, 7), pull(2, 8)] } } } });
const report = (body: unknown = corpus(), ledger: flow.FlowLedgerRead = { ok: true, rows: [], unread: [] }) =>
  flow.admissionFlowReport(input, ledger, { ok: true, body, observedAtMs: now, policyDigest: feedbackContentDigest(settings) }, now);

test("W1-T7756: admission gardening distinguishes missing evidence from healthy flow", () => {
  const measured = report();
  assert.equal(measured.coverage, "unknown");
  assert.equal(measured.corpusCoverage, "measured");
  assert.equal(measured.trusted.length, 1);
  assert.equal(measured.affected.length, 1);
  assert.equal(measured.affected[0].evidence, "missing-disposition");
  assert.equal(measured.healthy, false);
  assert.equal(report(undefined, { ok: false, rows: [], unread: ["ledger"] }).coverage, "unknown");
  const truncated = corpus(); truncated.data.repository.pullRequests.pageInfo.hasNextPage = true;
  assert.equal(report(truncated).coverage, "unknown");
});

test("W1-T7756: admission recovery deduplicates persistent causes across PR heads", () => {
  const first = report();
  const changed = corpus(); changed.data.repository.pullRequests.nodes[1]!.headRefOid = "b".repeat(40);
  const second = report(changed);
  assert.equal(first.affected[0].causeKey, second.affected[0].causeKey);
  const one = remedy.admissionFlowInventory(first, [], [], now);
  assert.equal(one.candidates.length, 1);
  assert.equal(one.next!.admissionShadow, true);
});

test("W1-T7756: admission gardening cannot widen trust or bypass required checks", () => {
  const measured = report();
  assert.equal(measured.permission, "not-granted");
  assert.equal(measured.mode, "shadow");
  assert.equal(measured.trusted[0].next, "required-current-head-checks");
  const missingActor = corpus(); missingActor.data.repository.pullRequests.nodes[1]!.author.databaseId = 0;
  assert.equal(report(missingActor).coverage, "unknown");
});

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-admission-garden-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logs: Array<{ step: string; fields?: Record<string, unknown> }> = [];
  const deps: GardenerDeps = { repoRoot: root, stateDir: root, clock: fixedClock(now),
    log: (step, fields) => logs.push({ step, fields }), openWorkspace: () => { throw Error("forbidden workspace"); } };
  return { root, logs, deps };
}
const disposition = (head = "a".repeat(40), status = "owner-action"): LedgerRecord => ({ ts: fixedClock(now - 1_000).iso(),
  step: "contributor_disposition.shadow", mode: "shadow", evidence_domain: "shadow", repository_id: 111, pr_number: 2,
  cause: feedbackContentDigest(["shadow", 111, "operator", "core", 2]), sequence: 0, head_sha: head,
  permission: "not-granted", status, original_reason: "original private diagnostic", reason: "later status" });

test("W1-T7756 corpus: outages, malformed and private/truncated identities are unknown", () => {
  const mutations: Array<(body: ReturnType<typeof corpus>) => void> = [
    b => { b.data.repository.databaseId = 222; }, b => { b.data.repository.nameWithOwner = "other/core"; },
    b => { b.data.repository.isPrivate = true; }, b => { b.data.repository.pullRequests.totalCount = 3; },
    b => { b.data.repository.pullRequests.nodes[1]!.fullDatabaseId = "9007199254740993"; },
    b => { b.data.repository.pullRequests.nodes[1]!.createdAt = "invalid"; },
    b => { b.data.repository.pullRequests.nodes[1]!.state = "CLOSED"; },
    b => { b.data.repository.pullRequests.nodes[1]!.headRefOid = "stale"; },
    b => { b.data.repository.pullRequests.nodes[1]!.headRepository.databaseId = 0; },
    b => { b.data.repository.pullRequests.nodes[1]!.repository.isPrivate = true; },
    b => { b.data.repository.pullRequests.nodes.push(b.data.repository.pullRequests.nodes[1]!); b.data.repository.pullRequests.totalCount++; },
    b => { b.data.repository.pullRequests.nodes[1]!.author.__typename = "Organization"; },
  ];
  for (const mutate of mutations) { const b = structuredClone(corpus()); mutate(b); assert.equal(report(b).coverage, "unknown"); }
  for (const body of [null, {}, { errors: [{ message: "private unavailable bytes" }] }]) assert.equal(report(body).coverage, "unknown");
  const connection = corpus(); connection.data.repository.pullRequests.nodes = []; connection.data.repository.pullRequests.totalCount = 0;
  assert.equal(report(connection).coverage, "unmeasured");
  const onlyOwners = corpus(); onlyOwners.data.repository.pullRequests.nodes[1]!.author.databaseId = 7;
  assert.equal(report(onlyOwners).coverage, "unmeasured");
});

test("W1-T7756 receipts: retained status never authorizes a current head or a private publication", () => {
  const ledger = { ok: true, rows: [disposition()], unread: [] };
  const current = report(corpus(), ledger);
  assert.equal(current.affected[0]!.originalReason, "original private diagnostic");
  assert.equal(current.healthy, false, "an open shadow would-close/owner-action receipt is not healthy terminal flow");
  const stale = report(corpus(), { ...ledger, rows: [disposition("b".repeat(40))] });
  assert.equal(stale.affected[0]!.evidence, "stale-disposition");
  assert.equal(stale.affected[0]!.causeKey, current.affected[0]!.causeKey);
  for (const patch of [{ sequence: -1 }, { status: "invented" }, { permission: "granted" }, { ts: "invalid" }, { head_sha: "bad" }]) {
    assert.equal(report(corpus(), { ...ledger, rows: [{ ...disposition(), ...patch }] }).coverage, "unknown");
  }
  assert.equal(current.permission, "not-granted"); assert.equal(current.runtimeFlow, "not-certified");
});

test("W1-T7756 policy: membership ambiguity, changed policy and scoped services preserve owner flow", () => {
  const org = { ...settings, policy: { ...settings.policy, organizationIds: [99] } };
  const unknown = flow.admissionFlowReport({ ...input, settings: org }, { ok: true, rows: [], unread: [] },
    { ok: true, body: corpus(), observedAtMs: now, policyDigest: feedbackContentDigest(org) }, now);
  assert.equal(unknown.coverage, "unknown"); assert.equal(unknown.trusted[0]!.outcome, "trusted");
  const configured = { ...settings, policy: { ...settings.policy, services: [{ id: 8, actions: ["disposition" as const] }] } };
  const bots = corpus(); bots.data.repository.pullRequests.nodes[1]!.author.__typename = "Bot";
  const service = flow.admissionFlowReport({ ...input, settings: configured }, { ok: true, rows: [], unread: [] },
    { ok: true, body: bots, observedAtMs: now, policyDigest: feedbackContentDigest(configured) }, now);
  assert.equal(service.trusted.length, 2); assert.equal(service.coverage, "unmeasured");
  for (const stamp of [now - 5_001, now + 1, -1]) {
    assert.equal(flow.admissionFlowReport(input, { ok: true, rows: [], unread: [] },
      { ok: true, body: corpus(), observedAtMs: stamp, policyDigest: feedbackContentDigest(settings) }, now).coverage, "unknown");
  }
  assert.equal(flow.admissionFlowReport(input, { ok: true, rows: [], unread: [] },
    { ok: true, body: corpus(), observedAtMs: now, policyDigest: "changed" }, now).coverage, "unknown");
});

test("W1-T7756 default: bounded real async child is read-only and the event loop remains responsive", async (t) => {
  const shim = ghShim([{ when: "api graphql", stdout: JSON.stringify(corpus()), delaySeconds: 0.2 }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const prior = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${prior}`;
    const pending = flow.readAdmissionFlowCorpus(input, [2], fixedClock(now));
    const deadline = Date.now() + 5_000;
    while (!shim.events().some(e => e.phase === "start") && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
    await new Promise<void>(r => setImmediate(r));
    const events = shim.events();
    assert.ok(events.some(e => e.phase === "start")); assert.equal(events.some(e => e.phase === "end"), false);
    const read = await pending; assert.equal(read.ok, true);
    assert.equal(flow.admissionFlowReport(input, { ok: true, rows: [], unread: [] }, read, now).corpusCoverage, "measured");
    assert.equal(shim.calls().length, 1); assert.match(shim.calls()[0]!, /first:100/); assert.match(shim.calls()[0]!, /p2:pullRequest/);
    assert.ok(shim.calls().every(call => !/mutation|--method|-X|pr close|issue comment/.test(call)));
    shim.addRoute({ when: "api graphql", stdout: "malformed" });
    assert.equal((await flow.readAdmissionFlowCorpus(input, [], fixedClock(now))).ok, false);
    shim.addRoute({ when: "api graphql", stderr: "unavailable", exit: 1 });
    assert.equal((await flow.readAdmissionFlowCorpus(input, [], fixedClock(now))).ok, false);
  } finally { process.env.PATH = prior; }
});

test("W1-T7756 read: missing config, concurrent requests and policy mutation cannot reset evidence", async (t) => {
  const f = fixture(t); let calls = 0, resolve!: (body: unknown) => void;
  const read: flow.AdmissionFlowRead = () => { calls++; return new Promise(r => { resolve = r; }); };
  const selected = { ...input, readCorpus: read };
  const pending = flow.readAdmissionFlowCorpus(selected, [], fixedClock(now));
  await new Promise<void>(r => setImmediate(r));
  assert.equal((await flow.readAdmissionFlowCorpus(selected, [], fixedClock(now))).reason, "read-still-in-flight");
  assert.equal(calls, 1); resolve(corpus()); assert.equal((await pending).ok, true);
  for (const bad of [{ ...input, settings: undefined }, { ...input, owner: "bad/owner" }]) {
    assert.equal((await flow.readAdmissionFlowCorpus({ ...bad, readCorpus: read }, [], fixedClock(now))).ok, false);
  }
  assert.equal((await flow.readAdmissionFlowCorpus(selected, Array.from({ length: 9 }, (_, i) => i + 1), fixedClock(now))).reason, "invalid-corpus-request");
  const absent = await flow.observeAdmissionFlow(f.deps, { ...input, settings: undefined, readCorpus: read,
    readLedger: () => { throw Error("forbidden legacy ledger"); } });
  assert.equal(absent.coverage, "not-enabled"); assert.equal(f.logs.length, 0);
  const badLedger = await flow.observeAdmissionFlow(f.deps, { ...input, readCorpus: async () => corpus(), readLedger: () => { throw Error("unreadable"); } });
  assert.equal(badLedger.coverage, "unknown"); assert.equal(f.logs[0]!.step, flow.ADMISSION_FLOW_STEP);
});

test("W1-T7756 terminal: actual terminal aliases and all archive forms are observed, never guessed", async (t) => {
  const f = fixture(t), row = disposition();
  const b = corpus(); b.data.repository.pullRequests.nodes = [pull(1, 7)]; b.data.repository.pullRequests.totalCount = 1;
  const terminal = { ...pull(2, 8), state: "CLOSED" };
  const complete = { data: { repository: { ...b.data.repository, p2: terminal } } };
  writeLedger([row], { dir: f.root, rotations: [
    { at: fixedClock(now - 2_000).iso(), rows: [{ ...row, reason: "plain archive" }] },
    { at: fixedClock(now - 3_000).iso(), rows: [{ ...row, reason: "gz archive" }], gz: true },
  ] });
  let query = "";
  const seen = await flow.observeAdmissionFlow(f.deps, { ...input, readCorpus: async q => { query = q; return complete; } });
  assert.match(query, /p2:pullRequest/); assert.deepEqual(seen.terminal, [2]);
  assert.equal(seen.coverage, "measured"); assert.equal(seen.healthy, true); assert.equal(seen.runtimeFlow, "not-certified");
  assert.equal(report(b, { ok: true, rows: [row], unread: [] }).coverage, "unknown");
});

test("W1-T7756 durable: lost acknowledgement and corrupt intents cannot mint or escalate twice", (t) => {
  const f = fixture(t), inv = remedy.admissionFlowInventory(report(corpus(), { ok: true, rows: [disposition()], unread: [] }), [], [], now);
  const action = inv.next!;
  const failing = { ...f.deps, log: () => { throw Error("lost acknowledgement"); } };
  assert.throws(() => remedy.recordAdmissionFlowProposal(failing, action), /lost acknowledgement/);
  remedy.recordAdmissionFlowProposal(f.deps, action);
  const dir = join(f.root, "admission-flow-shadow-intents"), files = readdirSync(dir);
  assert.equal(files.length, 1); const bytes = readFileSync(join(dir, files[0]!), "utf8");
  assert.match(bytes, /original private diagnostic/); assert.match(bytes, /not-granted/);
  writeFileSync(join(dir, files[0]!), "corrupt"); remedy.recordAdmissionFlowProposal(f.deps, action);
  assert.equal(readFileSync(join(dir, files[0]!), "utf8"), "corrupt");
  const judgment = { ...action, rung: 2, escalation: "bounded owner judgment" };
  remedy.recordAdmissionFlowProposal(f.deps, judgment); remedy.recordAdmissionFlowProposal(f.deps, judgment);
  assert.equal(readdirSync(dir).length, 2);
  const published = f.logs.filter(r => r.step === "admission_flow.proposal_shadow");
  assert.equal(published.length, 1); assert.equal(published[0]!.fields!.effect, "owner-judgment");
  assert.equal(JSON.stringify(published).includes("original private diagnostic"), false, "public proposal contains only typed causes, not private diagnostics");
});

test("W1-T7756 recurrence: replay and head churn are not new episodes; controls and windows must match", () => {
  const merge = now - 3_600_000, population = [1, 2], populationDigest = feedbackContentDigest(population);
  const sample: remedy.AdmissionRecurrenceSample = { atMs: merge - 1_000, repositoryId: 111, policyDigest: feedbackContentDigest(settings),
    populationDigest, coverage: "measured", domain: "shadow", population, episodes: ["episode-a"] };
  const after = { ...sample, atMs: merge + 1_000, episodes: [] };
  assert.equal(remedy.admissionRecurrence([sample, sample, after], merge, now).verdict, "credit");
  const replay = remedy.admissionRecurrence([sample, sample, { ...after, episodes: ["episode-a", "episode-a"] }], merge, now);
  assert.equal(replay.after.k, 0); assert.equal(replay.verdict, "debit", "the old stuck cause is retained despite zero new recurrence");
  assert.equal(remedy.admissionRecurrence([sample, { ...after, episodes: ["episode-b"] }], merge, now).verdict, "debit");
  for (const changed of [{ ...after, policyDigest: "changed" }, { ...after, populationDigest: "different" },
    { ...after, coverage: "unknown" }, { ...after, repositoryId: 222 }]) {
    assert.equal(remedy.admissionRecurrence([sample, changed], merge, now).verdict, "unmeasurable");
  }
  assert.equal(remedy.admissionRecurrence([], merge, now).verdict, "unmeasurable");
  assert.equal(remedy.admissionRecurrence([sample, after], now + 1, now).verdict, "unmeasurable");
});

test("W1-T7756 integration: ordinary remedies survive missing admission evidence and shadow proposals do not land", async (t) => {
  const f = fixture(t);
  const ordinary: LedgerRecord[] = [-2, -1].map(hours => ({ step: "sweep.disposed", pr_number: 9,
    ts: fixedClock(now + hours * 3_600_000).iso(), blocker: "escalated", reason: "ordinary cause", blocker_owner: "NONE" }));
  const sources: remedy.FlowGardenSources = { owner: input.owner, repo: input.repo, mintTaskId: () => { throw Error("forbidden mint"); },
    ledgerRecords: () => ordinary, planState: () => ({ tasks: [] }), prOutcomes: () => new Map(),
    admission: { ...input, readCorpus: async () => corpus(), readLedger: () => ({ ok: false, rows: [], unread: ["lost"] }) } };
  const spec = remedy.flowGardenSpec(f.deps, sources), inv = await spec.inventoryAsync!();
  assert.equal(inv.next!.admissionShadow, undefined); assert.match(inv.next!.price.key, /ordinary cause/);
  const shadowSpec = remedy.flowGardenSpec(f.deps, { ...sources, ledgerRecords: () => [],
    admission: { ...input, readCorpus: async () => corpus(), readLedger: () => ({ ok: true, rows: [], unread: [] }) } });
  const shadow = await shadowSpec.inventoryAsync!(), action = shadow.next!;
  const plan = { actions: [action], acting: ["draft" as const] };
  const ws = { root: f.root, branch: "shadow", land: () => { throw Error("forbidden landing"); }, dispose: () => {} };
  assert.equal(shadowSpec.apply(ws, plan, shadowSpec.scorecard(shadow, plan)), undefined);
  assert.equal((await shadowSpec.inventoryAsync!()).next, undefined, "intent acknowledgement loss does not strand the garden as in-progress");
  const failedPlan = remedy.flowGardenSpec(f.deps, { ...sources, planState: () => ({ tasks: [], degraded: "lost plan" }) });
  assert.match((await failedPlan.inventoryAsync!()).next!.price.key, /ordinary cause/);
  assert.equal(remedy.flowGardenSpec(f.deps, { ...sources, admission: undefined }).inventoryAsync, undefined);
});

test("W1-T7756 callers: existing daily pass and daemon builder forward opt-in settings only", async (t) => {
  const f = fixture(t); let reads = 0;
  const pass = flowGardenPass(f.deps, input.owner, input.repo, () => { throw Error("forbidden mint"); },
    { admission: { ...input, readCorpus: async () => { reads++; return corpus(); }, readLedger: () => ({ ok: true, rows: [], unread: [] }) } });
  writeLedger([], { dir: f.root }); await pass(); await pass();
  assert.equal(reads, 1); assert.equal(pass.due(), false);
  const source = readFileSync(join(process.cwd(), "src/run-task.ts"), "utf8");
  assert.match(source.slice(source.indexOf('case "flow-remedy":'), source.indexOf('case "fix-lane":')),
    /admission: \{ owner, repo, settings: config\.contributorAdmission \}/);
  assert.match(source.slice(source.indexOf('case "flow":'), source.indexOf('case "evidence-coverage":')),
    /settings: config\.contributorAdmission/);
  const legacy = await buildRegisteredGarden("flow", { repoRoot: f.root, owner: input.owner, repo: input.repo,
    config: { root: f.root } as Config, log: f.deps.log, raiseDuplicate: () => { throw Error("forbidden escalation"); } });
  assert.equal(typeof legacy, "function");
});

test("W1-T7756 production: both registered gardens use the bounded corpus without activating a scheduler", async (t) => {
  const repo = gitRepo({ kind: "admission-garden-defaults" }); t.after(() => repo.cleanup());
  repo.addRemote("origin", repo.dir); repo.git("fetch", "origin");
  const state = join(repo.dir, "state");
  writeLedger([], { dir: state, rotations: [{ at: fixedClock(now - 2_000).iso(), rows: [] }, { at: fixedClock(now - 3_000).iso(), rows: [], gz: true }] });
  const ownerOnly = corpus(); ownerOnly.data.repository.pullRequests.nodes[1]!.author.databaseId = 7;
  const shim = ghShim([{ when: "api graphql", stdout: JSON.stringify(ownerOnly) }]); t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const prior = process.env.PATH, logs: string[] = [];
  try {
    process.env.PATH = `${shim.dir}:${prior}`;
    for (const name of ["flow", "flow-remedy"] as const) {
      const pass = await buildRegisteredGarden(name, { repoRoot: repo.dir, owner: input.owner, repo: input.repo,
        config: { root: repo.dir, contributorAdmission: settings } as Config,
        log: step => logs.push(step), raiseDuplicate: () => { throw Error("forbidden external escalation"); } });
      await pass();
    }
    assert.equal(logs.filter(step => step === flow.ADMISSION_FLOW_STEP).length, 2);
    assert.equal(shim.calls().length, 2); assert.ok(shim.calls().every(call => call.startsWith("api graphql") && !/mutation|--method|-X/.test(call)));
    assert.equal(logs.some(step => step === "admission_flow.proposal_shadow"), false);
  } finally { process.env.PATH = prior; }
});

test("W1-T7756 bounds: stalled reads stay single-flight after timeout and policy changes invalidate the response", async () => {
  let finish!: (body: unknown) => void, calls = 0;
  const short: AdmissionSettings = { ...settings, policy: { ...settings.policy, maxEvidenceAgeMs: 20 } };
  const read: flow.AdmissionFlowRead = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const selected = { ...input, settings: short, readCorpus: read };
  assert.equal((await flow.readAdmissionFlowCorpus(selected, [], fixedClock(now))).ok, false);
  assert.equal((await flow.readAdmissionFlowCorpus(selected, [], fixedClock(now))).reason, "read-still-in-flight");
  assert.equal(calls, 1); finish(corpus()); await new Promise<void>(resolve => setImmediate(resolve));
  const mutable = structuredClone(settings);
  const changed = await flow.readAdmissionFlowCorpus({ ...input, settings: mutable, readCorpus: async () => { mutable.policy.version = "new-version"; return corpus(); } }, [], fixedClock(now));
  assert.equal(flow.admissionFlowReport({ ...input, settings: mutable }, { ok: true, rows: [], unread: [] }, changed, now).coverage, "unknown");
});

test("W1-T7756 proposals: invalid or unwritable intents are unknown without publishing a task or question", (t) => {
  const f = fixture(t), action = remedy.admissionFlowInventory(report(), [], [], now).next!;
  remedy.recordAdmissionFlowProposal(f.deps, { ...action, rung: 3 });
  assert.equal(f.logs[0]!.fields!.reason, "invalid-proposal");
  const path = join(f.root, "file-not-directory"); writeFileSync(path, "held");
  remedy.recordAdmissionFlowProposal({ ...f.deps, stateDir: path }, action);
  assert.equal(f.logs[1]!.fields!.reason, "intent-unreadable"); assert.equal(readFileSync(path, "utf8"), "held");
});

test("W1-T7756 recurrence ladder: actual merged remedy and controlled snapshots bound the second rung", () => {
  const measured = report(corpus(), { ok: true, rows: [disposition()], unread: [] });
  const action = remedy.admissionFlowInventory(measured, [], [], now).next!, merge = now - 3_600_000;
  const before = { ...measured, observedAtMs: merge - 1_000 }, after = { ...measured, observedAtMs: merge + 1_000 };
  const rows = [before, after].map(r => ({ step: flow.ADMISSION_FLOW_STEP, ...r }));
  const task = { id: "W1-T9999", origin: action.origin, status: "queued", retired: false, files: ["src/lib/flow-gardener.ts"], mergedAt: fixedClock(merge).iso() };
  const inv = remedy.admissionFlowInventory(measured, rows, [task], now);
  assert.equal(inv.next!.rung, 2); assert.equal(inv.next!.admissionShadow, true); assert.ok(inv.next!.escalation);
  assert.equal(inv.ladder[0]!.effect!.verdict, "debit");
  assert.equal(remedy.admissionFlowInventory(measured, [], [task], now).next, undefined, "unmeasured evidence does not create a second remedy");
  const corrupt = [{ step: flow.ADMISSION_FLOW_STEP, mode: "shadow", coverage: "measured", trusted: null }];
  assert.equal(remedy.admissionFlowInventory(measured, corrupt, [task], now).next, undefined);
});

test("W1-T7756 credit: actual anchored trailers OR run branches supply merge credit, not plan status", () => {
  const current = corpus();
  const merged = { pageInfo: { hasNextPage: true }, nodes: [
    { body: "Remudero-Task: W1-T9999", headRefName: "ordinary", mergedAt: fixedClock(now - 1_000).iso() },
    { body: "no trailer", headRefName: "run-W1-T9998-12345", mergedAt: fixedClock(now - 2_000).iso() },
    { body: "quoted Remudero-Task: W1-T8888", headRefName: "other", mergedAt: fixedClock(now - 3_000).iso() },
  ] };
  const measured = report({ data: { repository: { ...current.data.repository, merged } } });
  assert.equal(measured.mergeCreditCoverage, "observed-window");
  assert.deepEqual(Object.keys(measured.mergeCredits).sort(), ["W1-T9998", "W1-T9999"]);
  assert.equal(report().mergeCreditCoverage, "unknown");
});

test("W1-T7756 progress: current rollup is an observation, never a required-check waiver", () => {
  const current = corpus();
  const nodes = current.data.repository.pullRequests.nodes.map(p => ({ ...p, commits: { nodes: [{ commit: { oid: p.headRefOid, statusCheckRollup: { state: "PENDING" } } }] } }));
  const measured = report({ data: { repository: { ...current.data.repository, pullRequests: { ...current.data.repository.pullRequests, nodes } } } });
  assert.equal(measured.trusted[0]!.observedRollup, "PENDING");
  assert.equal(measured.trusted[0]!.next, "required-current-head-checks");
  assert.equal(measured.runtimeFlow, "not-certified"); assert.equal(measured.healthy, false);
});
